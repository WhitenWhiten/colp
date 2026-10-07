export interface SerializedHostGate {
  /**
   * `signal` aborts only this waiter. It does not release a lock another
   * claim already holds, and it does not let a later waiter skip the
   * start-to-start gap of a start that actually happened.
   */
  run(host: string, work: () => Promise<void>, signal?: AbortSignal): Promise<void>;
  pendingHostCount(): number;
  trackedHostCount(): number;
}

export interface SerializedHostGateOptions {
  readonly gapMs: number;
  readonly invalidGapMessage: string;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

/**
 * Serializes work per normalized host and forgets idle host state once its
 * start-to-start gap expires. Queue tails never adopt work failures, so one
 * failed probe cannot poison later work for the same host.
 */
export function createSerializedHostGate(options: SerializedHostGateOptions): SerializedHostGate {
  if (!Number.isInteger(options.gapMs) || options.gapMs < 0) {
    throw new RangeError(options.invalidGapMessage);
  }
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? delay;
  const lastStartedAt = new Map<string, number>();
  const tails = new Map<string, Promise<void>>();
  const expirationTimers = new Map<string, NodeJS.Timeout>();

  const clearExpiration = (key: string): void => {
    const timer = expirationTimers.get(key);
    if (timer !== undefined) clearTimeout(timer);
    expirationTimers.delete(key);
  };
  const expireIdleHost = (key: string, startedAt: number): void => {
    if (tails.has(key) || lastStartedAt.get(key) !== startedAt) return;
    const remainingMs = startedAt + options.gapMs - now();
    if (remainingMs <= 0) {
      lastStartedAt.delete(key);
      clearExpiration(key);
      return;
    }
    clearExpiration(key);
    const timer = setTimeout(() => {
      expirationTimers.delete(key);
      if (!tails.has(key) && lastStartedAt.get(key) === startedAt) {
        lastStartedAt.delete(key);
      }
    }, remainingMs);
    timer.unref();
    expirationTimers.set(key, timer);
  };

  return Object.freeze({
    async run(host: string, work: () => Promise<void>, signal?: AbortSignal): Promise<void> {
      const key = host.length > 0 ? host : '_';
      clearExpiration(key);
      const linked = tails.has(key);
      const previous = tails.get(key) ?? Promise.resolve();
      let release!: () => void;
      const current = new Promise<void>((resolve) => { release = resolve; });
      // The tail still waits for `previous`, so resolving `current` early
      // (this waiter aborted) cannot start the next claim before the holder
      // finishes, and cannot clear that holder's lock.
      const tail = previous.then(() => current);
      tails.set(key, tail);
      let started = false;
      const dropRestoredTail = (): void => {
        if (tails.get(key) !== previous) return;
        tails.delete(key);
        const restoredStart = lastStartedAt.get(key);
        if (restoredStart !== undefined) expireIdleHost(key, restoredStart);
      };
      try {
        throwIfAborted(signal);
        await waitForSettle(previous, signal);
        const waitMs = (lastStartedAt.get(key) ?? 0) + options.gapMs - now();
        if (waitMs > 0) await pause(waitMs, sleep, signal);
        throwIfAborted(signal);
        const startedAt = now();
        lastStartedAt.set(key, startedAt);
        started = true;
        await work();
      } finally {
        release();
        if (tails.get(key) === tail) {
          if (started || !linked) {
            tails.delete(key);
          } else {
            // This waiter never started and is still the tail. Put the map
            // back on the holder's chain so a later arrival waits for it.
            tails.set(key, previous);
            previous.then(dropRestoredTail, dropRestoredTail);
          }
        }
        const startedAt = lastStartedAt.get(key);
        if (startedAt !== undefined) expireIdleHost(key, startedAt);
      }
    },
    pendingHostCount: () => tails.size,
    trackedHostCount: () => lastStartedAt.size,
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The host gate wait was aborted.', 'AbortError');
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortReason(signal);
}

/** Queue progress never adopts the previous claim's work failure. */
function waitForSettle(previous: Promise<void>, signal: AbortSignal | undefined): Promise<void> {
  if (signal === undefined) return previous.then(() => undefined, () => undefined);
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      cleanup();
      reject(abortReason(signal));
    };
    const onSettle = (): void => {
      cleanup();
      resolve();
    };
    const cleanup = (): void => signal.removeEventListener('abort', onAbort);
    signal.addEventListener('abort', onAbort, { once: true });
    previous.then(onSettle, onSettle);
  });
}

function pause(
  ms: number,
  sleep: (ms: number) => Promise<void>,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (!signal) return sleep(ms);
  throwIfAborted(signal);
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<void>((_resolve, reject) => {
    onAbort = () => reject(abortReason(signal));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  return Promise.race([sleep(ms), aborted]).finally(() => {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  });
}
