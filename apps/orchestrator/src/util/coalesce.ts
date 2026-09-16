/**
 * Request coalescing — the fourth line of AI-load minimisation.
 *
 * Two users opening the same distribution email at the same second, or an
 * add-in retrying because the pane was re-rendered, must not produce two model
 * calls. Concurrent callers with the same key share one in-flight promise; the
 * entry is dropped as soon as it settles, so this is a de-duplicator, not a
 * cache (the content-hash cache handles "same input, later").
 */
export interface CoalescerStats {
  /** Keys currently in flight. */
  inFlight: number;
  /** Calls that reused an in-flight promise instead of starting work. */
  joined: number;
  /** Calls that started the work. */
  started: number;
}

export class Coalescer {
  private readonly pending = new Map<string, Promise<unknown>>();
  private joined = 0;
  private started = 0;

  /** Run `fn` unless an identical key is already running, in which case join it. */
  async run<T>(key: string, fn: () => Promise<T>): Promise<{ value: T; joined: boolean }> {
    const existing = this.pending.get(key);
    if (existing) {
      this.joined++;
      return { value: (await existing) as T, joined: true };
    }
    this.started++;
    // Wrap so that `finally` runs before any caller's `.then`, keeping the map tight.
    const promise = (async () => fn())();
    this.pending.set(key, promise);
    try {
      return { value: await promise, joined: false };
    } finally {
      this.pending.delete(key);
    }
  }

  get stats(): CoalescerStats {
    return { inFlight: this.pending.size, joined: this.joined, started: this.started };
  }

  /** Test / shutdown helper. */
  clear(): void {
    this.pending.clear();
  }
}
