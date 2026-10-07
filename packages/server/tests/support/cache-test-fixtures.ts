/**
 * Shared scripted CacheStore fixture for the Redis cache unit suites
 * (T04 read-through, T06 metadata, T07 directory, T08 snapshot).
 *
 * The fake records every get/set/setIfAbsent/releaseIfOwner call (with args)
 * and simulates real Redis semantics for the distributed lock (SET NX with
 * expiry and token-guarded release). `failGet`/`failSet`/`failSetIfAbsent`
 * inject cache_unavailable failures; `onGet`/`onSetIfAbsent` hooks let a test
 * install a barrier for a real interleaving. Tests always assert by command
 * and loader counts, never by value equality alone.
 */
import {
  CACHE_ERROR_CATEGORY,
  CacheStoreError,
  type CacheStore,
} from '../../src/infrastructure/cache/index.js';

export interface RecordedCall {
  readonly method: string;
  readonly args: readonly unknown[];
}

export class FakeCacheStore implements CacheStore {
  readonly data = new Map<string, string>();
  readonly locks = new Map<string, { readonly token: string; readonly expiresAtMs: number }>();
  readonly calls: RecordedCall[] = [];
  clock: () => number = () => Date.now();
  failGet = false;
  failSet = false;
  failSetIfAbsent = false;
  onGet?: (key: string) => Promise<void> | void;
  onSetIfAbsent?: (key: string, token: string, lockTtlMs: number) => Promise<void> | void;

  async get(key: string, _signal: AbortSignal): Promise<string | null> {
    this.record('get', [key]);
    if (this.failGet) throw new CacheStoreError(CACHE_ERROR_CATEGORY.UNAVAILABLE, 'redis down (get)');
    if (this.onGet) await this.onGet(key);
    return this.data.get(key) ?? null;
  }

  async set(key: string, encodedValue: string, hardTtlMs: number, _signal: AbortSignal): Promise<void> {
    this.record('set', [key, encodedValue, hardTtlMs]);
    if (this.failSet) throw new CacheStoreError(CACHE_ERROR_CATEGORY.UNAVAILABLE, 'redis down (set)');
    this.data.set(key, encodedValue);
  }

  async setIfAbsent(key: string, token: string, lockTtlMs: number, _signal: AbortSignal): Promise<boolean> {
    this.record('setIfAbsent', [key, token, lockTtlMs]);
    if (this.failSetIfAbsent) throw new CacheStoreError(CACHE_ERROR_CATEGORY.UNAVAILABLE, 'redis down (setIfAbsent)');
    if (this.onSetIfAbsent) await this.onSetIfAbsent(key, token, lockTtlMs);
    const existing = this.locks.get(key);
    if (existing !== undefined && this.clock() < existing.expiresAtMs) return false;
    this.locks.set(key, { token, expiresAtMs: this.clock() + lockTtlMs });
    return true;
  }

  async releaseIfOwner(key: string, token: string, _signal: AbortSignal): Promise<boolean> {
    this.record('releaseIfOwner', [key, token]);
    const existing = this.locks.get(key);
    if (existing !== undefined && existing.token === token) {
      this.locks.delete(key);
      return true;
    }
    return false;
  }

  async rotateEpoch(_key: string, _epochTtlMs: number, _signal: AbortSignal): Promise<number> {
    this.record('rotateEpoch', [_key]);
    return 1;
  }

  async health(): Promise<'healthy' | 'degraded'> {
    return 'healthy';
  }

  async close(): Promise<void> {}

  callsOf(method: string): RecordedCall[] {
    return this.calls.filter((call) => call.method === method);
  }

  private record(method: string, args: readonly unknown[]): void {
    this.calls.push({ method, args });
  }
}
