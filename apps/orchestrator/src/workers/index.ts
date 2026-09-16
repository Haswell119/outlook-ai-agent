import type { PgPool } from "../adapters/db/pool.js";
import type { Container } from "../container.js";
import { runRetention } from "./retention.js";
import { Scheduler } from "./scheduler.js";

/**
 * Wires the scheduled jobs onto a `Scheduler`.
 *
 *  - `mailbox-sync`   — every `SYNC_INTERVAL_MINUTES`: Graph delta → index →
 *                       triage → background analysis (precomputation).
 *  - `daily-brief`    — once a day at `DAILY_BRIEF_HOUR` (TZ): one short model
 *                       call per synced user, from already-computed analyses.
 *  - `retention`      — nightly purge (audit, index, caches, idempotency).
 *
 * All three run only on the elected leader (see `Scheduler`).
 */
export function createScheduler(c: Container, pool?: PgPool): Scheduler {
  const cfg = c.cfg;
  const scheduler = new Scheduler({ pool, logger: c.deps.logger, timezone: cfg.TZ });

  if (cfg.PRECOMPUTE_ENABLED && cfg.GRAPH_ENABLED) {
    scheduler.add({
      name: "mailbox-sync",
      everyMs: Math.max(1, cfg.SYNC_INTERVAL_MINUTES) * 60_000,
      runOnStart: true,
      run: async () => {
        const results = await c.services.mailboxSync.syncDue();
        if (results.length) c.deps.logger.info({ mailboxes: results.length, analysed: results.reduce((n, r) => n + r.analysed, 0), skipped: results.reduce((n, r) => n + r.skippedByTriage, 0) }, "mailbox sync tick");
      },
    });
  }

  if (cfg.DAILY_BRIEF_ENABLED) {
    scheduler.add({
      name: "daily-brief",
      dailyAtHour: cfg.DAILY_BRIEF_HOUR,
      run: async () => {
        const users = await c.services.mailboxSync.syncedUsers();
        let generated = 0;
        for (const u of users) {
          try {
            await c.services.dailyBrief.generate(
              { user: { id: u.userId, email: u.userEmail, displayName: u.userEmail, roles: ["user"], via: "aad-jwt" }, language: cfg.DEFAULT_LANGUAGE, correlationId: `brief-${u.userId}` },
              { refresh: true, priority: "background" },
            );
            generated++;
          } catch (e) {
            c.deps.logger.warn({ err: (e as Error).message, user: u.userEmail }, "daily brief generation failed");
          }
        }
        c.deps.logger.info({ generated, users: users.length }, "daily briefs generated");
      },
    });
  }

  scheduler.add({
    name: "retention",
    everyMs: 24 * 3_600_000,
    run: async () => {
      await runRetention(c.deps.repos, cfg, c.deps.logger);
    },
  });

  return scheduler;
}

export { Scheduler } from "./scheduler.js";
export { runRetention } from "./retention.js";
export { MailboxSyncService } from "./mailboxSync.js";
