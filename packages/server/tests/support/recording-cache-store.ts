/**
 * T10 composition test support: an observable CacheStore fake.
 *
 * The fake explicitly implements and records every CacheStore command
 * (get/set/setIfAbsent/releaseIfOwner/rotateEpoch/health/close). It never
 * returns a fixed value for every key: `get` resolves only what was previously
 * `set` into `data`, so a composition test can never mistake a cache miss for
 * a hit. Command failures and health are controllable per test so the
 * degraded/required readiness branches are observable without a real Redis.
 */
import {
  CACHE_ERROR_CATEGORY,
  CacheStoreError,
  type CacheHealthState,
  type CacheStore,
} from '../../src/infrastructure/cache/index.js';

export interface RecordedCacheCall {
  readonly method: string;
  readonly args: readonly unknown[];
}

export interface RecordingCacheStoreOptions {
  readonly health?: CacheHealthState;
  /** Every command rejects with cache_unavailable (Redis outage simulation). */
  readonly failCommands?: boolean;
}

export class RecordingCacheStore implements CacheStore {
  readonly data = new Map<string, string>();
  readonly locks = new Map<string, { readonly token: string; readonly expiresAtMs: number }>();
  readonly calls: RecordedCacheCall[] = [];
  healthState: CacheHealthState;
  failCommands: boolean;
  closeCalls = 0;
  clock: () => number = () => Date.now();

  constructor(options: RecordingCacheStoreOptions = {}) {
    this.healthState = options.health ?? 'healthy';
    this.failCommands = options.failCommands ?? false;
  }

  callsOf(method: string): readonly RecordedCacheCall[] {
    return this.calls.filter((call) => call.method === method);
  }

  private record(method: string, args: readonly unknown[]): void {
    this.calls.push({ method, args });
  }

  private failIfConfigured(): void {
    if (this.failCommands) {
      throw new CacheStoreError(CACHE_ERROR_CATEGORY.UNAVAILABLE, 'redis unavailable (recording fake)');
    }
  }

  async get(key: string, signal: AbortSignal): Promise<string | null> {
    this.record('get', [key]);
    this.failIfConfigured();
    return this.data.get(key) ?? null;
  }

  async set(key: string, encodedValue: string, hardTtlMs: number, signal: AbortSignal): Promise<void> {
    this.record('set', [key, encodedValue, hardTtlMs]);
    this.failIfConfigured();
    this.data.set(key, encodedValue);
  }

  async setIfAbsent(key: string, token: string, lockTtlMs: number, signal: AbortSignal): Promise<boolean> {
    this.record('setIfAbsent', [key, token, lockTtlMs]);
    this.failIfConfigured();
    const existing = this.locks.get(key);
    if (existing !== undefined && this.clock() < existing.expiresAtMs) return false;
    this.locks.set(key, { token, expiresAtMs: this.clock() + lockTtlMs });
    return true;
  }

  async releaseIfOwner(key: string, token: string, signal: AbortSignal): Promise<boolean> {
    this.record('releaseIfOwner', [key, token]);
    this.failIfConfigured();
    const existing = this.locks.get(key);
    if (existing !== undefined && existing.token === token) {
      this.locks.delete(key);
      return true;
    }
    return false;
  }

  async rotateEpoch(key: string, epochTtlMs: number, signal: AbortSignal): Promise<number> {
    this.record('rotateEpoch', [key, epochTtlMs]);
    this.failIfConfigured();
    return 1;
  }

  async health(signal?: AbortSignal): Promise<CacheHealthState> {
    this.record('health', []);
    return this.healthState;
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
  }
}
