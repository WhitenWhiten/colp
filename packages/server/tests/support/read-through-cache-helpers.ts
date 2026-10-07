/**
 * Shared fixtures for the T04 domain-neutral readThrough cache-aside policy
 * unit suite (plan 12-redis-hot-data-cache-plan.md §6.4 T04 / §7.2 / §7.3).
 *
 * Everything here is a test harness, not src: the scripted CacheStore (shared
 * FakeCacheStore), a deterministic deps factory, and envelope encoders with
 * explicit written/soft/hard expiry times for TTL scenarios.
 */
import assert from 'node:assert/strict';
import {
  CacheBulkhead,
  CacheSingleflight,
  buildCacheLockKey,
  encodeCacheEnvelope,
  type CacheReadDependencies,
  type CacheReadPolicy,
} from '../../src/infrastructure/cache/index.js';
import { FakeCacheStore } from './cache-test-fixtures.js';

export const KEY = 'known:production:cache:v1:{pub:collection-1}:metadata:0:abc';
export const LOCK_KEY = buildCacheLockKey(KEY);

export const POLICY: CacheReadPolicy = {
  domain: 'publication-metadata',
  softTtlMs: 10_000,
  hardTtlMs: 30_000,
  jitterMs: 0,
  serveStale: false,
  maxEntryBytes: 512 * 1024,
  lockTtlMs: 1_500,
  lockWaitCount: 3,
  lockWaitTimeoutMs: 10_000,
};

export type TestContext = CacheReadDependencies & { readonly store: FakeCacheStore };

export function makeDeps(overrides: Partial<CacheReadDependencies> & { readonly store?: FakeCacheStore } = {}): TestContext {
  const store = overrides.store ?? new FakeCacheStore();
  const singleflight = overrides.singleflight ?? new CacheSingleflight();
  const bulkhead = overrides.bulkhead ?? new CacheBulkhead(4);
  const deps: TestContext = {
    store,
    singleflight,
    bulkhead,
    loader: overrides.loader ?? (async () => ({ id: 'origin' })),
    clock: overrides.clock ?? (() => Date.now()),
    random: overrides.random ?? (() => 0),
    tokenFactory: overrides.tokenFactory ?? (() => 'token-1'),
  };
  if (overrides.sleep !== undefined) deps.sleep = overrides.sleep;
  return deps;
}

export function signal(): AbortSignal {
  return new AbortController().signal;
}

export async function flush(times = 10): Promise<void> {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}

export function encodeEnvelope(value: unknown, now: number, policy: CacheReadPolicy): string {
  const result = encodeCacheEnvelope(value, {
    writtenAtMs: now - 1_000,
    softExpiresAtMs: now + policy.softTtlMs,
    hardExpiresAtMs: now + policy.hardTtlMs,
  }, { maxEntryBytes: policy.maxEntryBytes });
  assert.equal(result.kind, 'ok', 'fixture envelope must encode');
  if (result.kind !== 'ok') throw new Error('fixture envelope must encode');
  return result.encoded;
}

export function encodeSoftExpired(value: unknown, now: number, policy: CacheReadPolicy): string {
  const result = encodeCacheEnvelope(value, {
    writtenAtMs: now - 20_000,
    softExpiresAtMs: now - 5_000,
    hardExpiresAtMs: now + policy.hardTtlMs,
  }, { maxEntryBytes: policy.maxEntryBytes });
  assert.equal(result.kind, 'ok', 'fixture envelope must encode');
  if (result.kind !== 'ok') throw new Error('fixture envelope must encode');
  return result.encoded;
}

export function encodeHardExpired(value: unknown, now: number, policy: CacheReadPolicy): string {
  const result = encodeCacheEnvelope(value, {
    writtenAtMs: now - 40_000,
    softExpiresAtMs: now - 35_000,
    hardExpiresAtMs: now - 1_000,
  }, { maxEntryBytes: policy.maxEntryBytes });
  assert.equal(result.kind, 'ok', 'fixture envelope must encode');
  if (result.kind !== 'ok') throw new Error('fixture envelope must encode');
  return result.encoded;
}
