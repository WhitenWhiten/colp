import { SharedFlight } from '../async/shared-flight.js';
import { CacheAbortError } from './cache-abort.js';

export interface CacheSingleflightLike {
  run<T>(key: string, signal: AbortSignal, fn: (signal: AbortSignal) => Promise<T>): Promise<T>;
}

/** Preserve the cache error classification over the shared runtime primitive. */
export class CacheSingleflight extends SharedFlight implements CacheSingleflightLike {
  constructor() { super(() => new CacheAbortError('singleflight wait aborted')); }
}
