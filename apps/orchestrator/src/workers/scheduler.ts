import type pg from "pg";
import { ADVISORY_LOCKS, tryAdvisoryLock, type PgPool } from "../adapters/db/pool.js";
import type { Logger } from "../services/context.js";

/**
 * In-process scheduler with **leader election**.
 *
 * The same image runs as `ROLE=api`, `ROLE=worker` or `ROLE=all`. When more
 * than one replica runs the workers, exactly one must own the scheduled jobs —
 * otherwise 3 replicas would sync every mailbox 3 times and write 3 daily
 * briefs. Leadership is a Postgres **session-level advisory lock**: the leader
 * holds it on a dedicated connection, and if that pod dies the lock is released
 * by the server the moment the connection drops, so another replica takes over
 * within one `leaderPollMs`.
 *
 * With `DATABASE_URL=memory` (demo / tests) there is nothing to elect: the
 * single process is always the leader.
 */
export interface ScheduledJob {
  name: string;
  /** Run every N ms. */
  everyMs?: number;
  /** Or: run once a day at this local hour (uses `timezone`). */
  dailyAtHour?: number;
  /** Run once immediately after becoming leader. */
  runOnStart?: boolean;
  run: () => Promise<void>;
}

export interface SchedulerOptions {
  pool?: PgPool;
  logger: Logger;
  /** How often leadership is (re)checked. */
  leaderPollMs?: number;
  /** Scheduler resolution. */
  tickMs?: number;
  timezone?: string;
  /** Test hook. */
  now?: () => number;
}

interface JobState {
  job: ScheduledJob;
  nextRunAt: number;
  running: boolean;
  runs: number;
  failures: number;
  lastError?: string;
  lastRunAt?: number;
}

export class Scheduler {
  private readonly jobs: JobState[] = [];
  private timer: NodeJS.Timeout | undefined;
  private leaderTimer: NodeJS.Timeout | undefined;
  private leaderClient: pg.PoolClient | undefined;
  private leader = false;
  private stopped = false;
  private readonly now: () => number;

  constructor(private readonly opts: SchedulerOptions) {
    this.now = opts.now ?? (() => Date.now());
  }

  get isLeader(): boolean {
    return this.leader;
  }

  add(job: ScheduledJob): this {
    this.jobs.push({ job, nextRunAt: job.runOnStart ? 0 : this.computeNext(job, this.now()), running: false, runs: 0, failures: 0 });
    return this;
  }

  /** Next run instant of a job, in epoch ms. */
  private computeNext(job: ScheduledJob, from: number): number {
    if (job.everyMs) return from + job.everyMs;
    if (job.dailyAtHour !== undefined) return nextDailyInstant(new Date(from), job.dailyAtHour, this.opts.timezone ?? "UTC").getTime();
    return Number.POSITIVE_INFINITY;
  }

  async start(): Promise<void> {
    this.stopped = false;
    await this.electLeader();
    this.leaderTimer = setInterval(() => void this.electLeader(), this.opts.leaderPollMs ?? 30_000);
    this.leaderTimer.unref?.();
    this.timer = setInterval(() => void this.tick(), this.opts.tickMs ?? 5_000);
    this.timer.unref?.();
    // Fire the first tick without awaiting it: a `runOnStart` job (the initial
    // mailbox sync) must not hold up the HTTP listener coming up.
    void this.tick();
  }

  /** Try to take (or confirm) the advisory lock. Memory mode = always leader. */
  private async electLeader(): Promise<void> {
    if (this.stopped) return;
    if (!this.opts.pool) {
      if (!this.leader) this.opts.logger.info({}, "scheduler leader (single process, no database lock)");
      this.leader = true;
      return;
    }
    if (this.leader && this.leaderClient) {
      // Cheap liveness check on the lock-holding connection.
      try {
        await this.leaderClient.query("SELECT 1");
        return;
      } catch {
        this.releaseLeader();
      }
    }
    try {
      const client = await this.opts.pool.connect();
      const got = await tryAdvisoryLock(client, ADVISORY_LOCKS.scheduler);
      if (!got) {
        client.release();
        return;
      }
      this.leaderClient = client;
      this.leader = true;
      this.opts.logger.info({}, "scheduler leadership acquired (pg advisory lock)");
    } catch (e) {
      this.opts.logger.warn({ err: (e as Error).message }, "leader election failed, retrying");
    }
  }

  private releaseLeader(): void {
    this.leader = false;
    const client = this.leaderClient;
    this.leaderClient = undefined;
    if (!client) return;
    void client
      .query("SELECT pg_advisory_unlock($1)", [ADVISORY_LOCKS.scheduler])
      .catch(() => undefined)
      .finally(() => client.release());
  }

  /** Run every job whose time has come. Jobs never overlap with themselves. */
  async tick(): Promise<void> {
    if (this.stopped || !this.leader) return;
    const now = this.now();
    for (const state of this.jobs) {
      if (state.running || now < state.nextRunAt) continue;
      state.running = true;
      state.lastRunAt = now;
      try {
        await state.job.run();
        state.runs++;
        state.lastError = undefined;
      } catch (e) {
        state.failures++;
        state.lastError = (e as Error).message;
        // A failing job must not kill the scheduler; it simply runs again next time.
        this.opts.logger.error({ err: state.lastError, job: state.job.name }, "scheduled job failed");
      } finally {
        state.running = false;
        state.nextRunAt = this.computeNext(state.job, this.now());
      }
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.leaderTimer) clearInterval(this.leaderTimer);
    this.timer = undefined;
    this.leaderTimer = undefined;
    this.releaseLeader();
  }

  get status(): Array<{ name: string; runs: number; failures: number; lastError?: string; nextRunAt?: string }> {
    return this.jobs.map((s) => ({
      name: s.job.name,
      runs: s.runs,
      failures: s.failures,
      lastError: s.lastError,
      nextRunAt: Number.isFinite(s.nextRunAt) ? new Date(s.nextRunAt).toISOString() : undefined,
    }));
  }
}

/** Offset of `tz` at `instant`, in ms (duplicated from DailyBriefService to keep this file dependency-free). */
function tzOffsetMs(instant: Date, tz: string): number {
  try {
    const dtf = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
    const p = Object.fromEntries(dtf.formatToParts(instant).map((x) => [x.type, x.value])) as Record<string, string>;
    return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour) % 24, Number(p.minute), Number(p.second)) - instant.getTime();
  } catch {
    return 0;
  }
}

/** Next occurrence of `hour:00` local time in `tz`, strictly after `from`. */
export function nextDailyInstant(from: Date, hour: number, tz: string): Date {
  const local = new Date(from.getTime() + tzOffsetMs(from, tz));
  for (let day = 0; day <= 2; day++) {
    const y = local.getUTCFullYear();
    const m = local.getUTCMonth();
    const d = local.getUTCDate() + day;
    const wall = Date.UTC(y, m, d, hour);
    let guess = wall;
    for (let i = 0; i < 2; i++) guess = wall - tzOffsetMs(new Date(guess), tz);
    if (guess > from.getTime()) return new Date(guess);
  }
  return new Date(from.getTime() + 86_400_000);
}
