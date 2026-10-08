/**
 * T04 bounded fallback bulkhead (plan §6.4 T04): a simple fail-fast semaphore
 * that caps concurrent origin loads.
 *
 * When the capacity is exhausted the next `run` rejects immediately with
 * `CacheBulkheadError` — a controlled, typed failure — so a saturated origin
 * can never grow an unbounded connection pool or leave callers waiting
 * forever. No loader is invoked when the slot cannot be reserved.
 *
 * NOTE (T05): this is intentionally the minimal T04 semantics. T05 replaces
 * the failure policy around it (circuit breaker, `healthy/degraded/disabled`
 * readiness and metrics); a queued/waiting variant may be introduced there if
 * the evidence requires it.
 */
import { throwIfCacheAborted } from './cache-abort.js';

export class CacheBulkheadError extends Error {
  readonly reason: 'capacity_exceeded' = 'capacity_exceeded';

  constructor(capacity: number) {
    super(`cache fallback bulkhead is full (capacity ${capacity})`);
    this.name = 'CacheBulkheadError';
  }
}

export class CacheBulkhead {
  private active = 0;

  constructor(private readonly limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new Error('CacheBulkhead capacity must be a positive safe integer');
    }
  }

  get capacity(): number {
    return this.limit;
  }

  get activeCount(): number {
    return this.active;
  }

  async run<T>(signal: AbortSignal, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
    throwIfCacheAborted(signal);
    if (this.active >= this.limit) throw new CacheBulkheadError(this.limit);
    this.active += 1;
    try {
      return await fn(signal);
    } finally {
      this.active -= 1;
    }
  }
}
