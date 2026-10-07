/** Share one operation per key; cancellation belongs to each participant until the last leaves. */
class SharedFlightEntry<T> {
  private readonly controller = new AbortController();
  private readonly promise: Promise<T>;
  /** Live callers (leader + joined waiters) that still want this flight's result. */
  private participants = 0;

  constructor(
    leaderSignal: AbortSignal,
    fn: (signal: AbortSignal) => Promise<T>,
    onSettled: () => void,
    private readonly abortReason: (signal: AbortSignal) => unknown,
  ) {
    // Defensive: `run` already rejects a pre-aborted leader before creating the
    // entry, so a pre-aborted leader counts as zero participants and the
    // flight is torn down immediately.
    if (leaderSignal.aborted) this.controller.abort();

    this.promise = (async () => {
      try {
        return await fn(this.controller.signal);
      } finally {
        onSettled();
      }
    })();
  }

  /** True when every caller has left and the shared origin was aborted. */
  isAbandoned(): boolean {
    return this.controller.signal.aborted;
  }

  /** A caller left (aborted) without wanting this flight's result anymore. */
  private leave(): void {
    this.participants -= 1;
    if (this.participants <= 0) this.controller.abort();
  }

  async join(signal: AbortSignal): Promise<T> {
    if (signal.aborted) throw this.abortReason(signal);
    this.participants += 1;
    return new Promise<T>((resolve, reject) => {
      const onAbort = (): void => {
        this.leave();
        reject(this.abortReason(signal));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      const cleanup = (): void => {
        signal.removeEventListener('abort', onAbort);
      };
      this.promise.then(
        (value) => { cleanup(); resolve(value); },
        (error) => { cleanup(); reject(error); },
      );
    });
  }
}

export class SharedFlight {
  constructor(private readonly abortReason: (signal: AbortSignal) => unknown = signal => signal.reason) {}
  private readonly entries = new Map<string, SharedFlightEntry<unknown>>();

  async run<T>(key: string, signal: AbortSignal, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (signal.aborted) throw this.abortReason(signal);
    const existing = this.entries.get(key);
    if (existing !== undefined && !existing.isAbandoned()) return existing.join(signal) as Promise<T>;
    const entry = new SharedFlightEntry<T>(signal, fn, () => {
      // Identity guard: when this flight was abandoned and a fresh entry took
      // its map slot, the old entry must never delete the new one.
      queueMicrotask(() => { if (this.entries.get(key) === entry) this.entries.delete(key); });
    }, this.abortReason);
    this.entries.set(key, entry);
    return entry.join(signal);
  }

  /** Number of in-flight entries; exposed for lifecycle/cleanup tests. */
  get pendingCount(): number {
    return this.entries.size;
  }
}
