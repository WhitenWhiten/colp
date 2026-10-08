/**
 * T04 cache failure classification: typed abort error shared by the
 * singleflight, bulkhead and read-through modules.
 *
 * Aborts are client cancellations, not cache failures (unavailable/decode/
 * loader). They are thrown (never returned as a `ReadThroughResult`) because
 * only the cancelled caller should observe them, and the singleflight /
 * bulkhead use them to stop waiting promptly without reclassifying the
 * cancellation as an HTTP 500.
 */
export class CacheAbortError extends Error {
  constructor(message = 'cache operation aborted') {
    super(message);
    this.name = 'CacheAbortError';
  }
}

export function isCacheAbortError(error: unknown): boolean {
  return error instanceof CacheAbortError;
}

export function throwIfCacheAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new CacheAbortError('cache operation aborted');
}

/**
 * Runs an origin load under the cache-abort contract (FIX-L-015).
 *
 * Origin providers (PostgreSQL adapters) reject with their own abort reason
 * (`signal.reason`), never with a CacheAbortError. readThrough only treats
 * CacheAbortError as a cancellation (thrown; the failure policy never counts
 * it as a loader failure or breaker success) — anything else would be
 * classified as a `loader_error`. This guard converts any outcome observed
 * while the signal is aborted into CacheAbortError and additionally rejects a
 * late origin completion after the abort so a cancelled load can never be
 * written back. A genuine origin failure with a live signal keeps its own
 * error identity.
 */
export async function runOriginWithCacheAbort<Value>(
  signal: AbortSignal,
  origin: (signal: AbortSignal) => Promise<Value>,
): Promise<Value> {
  if (signal.aborted) throw new CacheAbortError('origin load aborted');
  try {
    const value = await origin(signal);
    if (signal.aborted) throw new CacheAbortError('origin load aborted');
    return value;
  } catch (error) {
    if (signal.aborted) throw new CacheAbortError('origin load aborted');
    throw error;
  }
}
