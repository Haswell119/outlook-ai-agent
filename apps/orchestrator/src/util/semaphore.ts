/**
 * Bounded concurrency with a bounded wait and two priority lanes.
 *
 * Used in front of the decision engine: a `laya-serve` pod runs one forward
 * pass at a time, so extra concurrent calls would only queue *there* — with no
 * timeout and no notion of priority. Queuing here instead keeps the wait
 * bounded (the caller falls back when it expires) and lets an interactive
 * request (a user waiting in Outlook) overtake background precomputation.
 *
 * FIFO inside a lane. The LLM queue (`adapters/llm/queue.ts`) has richer,
 * per-user fairness; decisions are ~100 ms calls, so plain lanes suffice.
 */
export class SemaphoreTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SemaphoreTimeoutError";
  }
}

export class SemaphoreAbortedError extends Error {
  constructor() {
    super("aborted while waiting for a concurrency slot");
    this.name = "SemaphoreAbortedError";
  }
}

interface Waiter {
  lane: 0 | 1;
  seq: number;
  settled: boolean;
  resolve: (release: () => void) => void;
  reject: (e: Error) => void;
  timer?: NodeJS.Timeout;
  signal?: AbortSignal;
  onAbort?: () => void;
}

export interface AcquireOptions {
  priority?: "interactive" | "background";
  /** Max wait for a slot. */
  timeoutMs: number;
  signal?: AbortSignal;
}

export class PrioritySemaphore {
  private active = 0;
  private seq = 0;
  private readonly waiters: Waiter[] = [];

  constructor(readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) throw new RangeError(`semaphore limit must be a positive integer (got ${limit})`);
  }

  get inFlight(): number {
    return this.active;
  }

  get pending(): number {
    return this.waiters.length;
  }

  /** Resolves with a release function (idempotent). Rejects on timeout or abort. */
  acquire(opts: AcquireOptions): Promise<() => void> {
    if (opts.signal?.aborted) return Promise.reject(new SemaphoreAbortedError());
    if (this.active < this.limit && this.waiters.length === 0) {
      this.active++;
      return Promise.resolve(this.releaser());
    }
    return new Promise<() => void>((resolve, reject) => {
      const waiter: Waiter = { lane: opts.priority === "background" ? 1 : 0, seq: this.seq++, settled: false, resolve, reject, signal: opts.signal };
      waiter.timer = setTimeout(() => this.drop(waiter, new SemaphoreTimeoutError(`no concurrency slot within ${opts.timeoutMs} ms (${this.active} running, ${this.waiters.length} waiting)`)), opts.timeoutMs);
      waiter.timer.unref?.();
      if (opts.signal) {
        waiter.onAbort = () => this.drop(waiter, new SemaphoreAbortedError());
        opts.signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      this.waiters.push(waiter);
    });
  }

  private drop(waiter: Waiter, error: Error): void {
    if (waiter.settled) return;
    this.settle(waiter);
    waiter.reject(error);
  }

  /** Remove a waiter from the queue and detach its timer / abort listener. */
  private settle(waiter: Waiter): void {
    waiter.settled = true;
    const idx = this.waiters.indexOf(waiter);
    if (idx >= 0) this.waiters.splice(idx, 1);
    if (waiter.timer) clearTimeout(waiter.timer);
    if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
  }

  private releaser(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active = Math.max(0, this.active - 1);
      this.drain();
    };
  }

  private drain(): void {
    while (this.active < this.limit && this.waiters.length > 0) {
      // Lane first, then arrival order.
      let next = this.waiters[0]!;
      for (const w of this.waiters) if (w.lane < next.lane || (w.lane === next.lane && w.seq < next.seq)) next = w;
      this.settle(next);
      this.active++;
      next.resolve(this.releaser());
    }
  }
}
