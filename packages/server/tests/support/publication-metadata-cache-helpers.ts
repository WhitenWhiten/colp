/**
 * Shared fixtures for the T06 Metadata cache decorator unit suite
 * (plan 12-redis-hot-data-cache-plan.md §6.4 T06 / §7.1 / §7.2).
 *
 * Everything here is a test harness, not src: a scripted CacheStore (shared
 * FakeCacheStore), a counting Metadata read port, and key/envelope builders
 * that call the production codec (no copied key/hash/TTL algorithm).
 */
import assert from 'node:assert/strict';
import {
  CACHE_PROJECTION,
  CacheBulkhead,
  CacheCircuitBreaker,
  CacheSingleflight,
  buildCacheDataKey,
  encodeCacheEnvelope,
  createCacheFailurePolicy,
  type CacheReadPolicy,
} from '../../src/infrastructure/cache/index.js';
import {
  createPublicationMetadataCache,
  type PublicationMetadataCacheReader,
} from '../../src/infrastructure/publication/index.js';
import { InMemoryMetrics } from '../../src/infrastructure/telemetry/index.js';
import {
  type PublicationMetadataQueryPorts,
  type PublicationMetadataRecord,
} from '../../src/modules/publication/index.js';
import { FakeCacheStore } from './cache-test-fixtures.js';

export const ORIGIN = 'https://known.example';
export const ENVIRONMENT = 'production';
export const KEY_PREFIX = 'known';
export const COLLECTION_ID = 'collection-1';
export const SLUG = 'known-collection';
export const SOFT_TTL_MS = 10_000;
export const HARD_TTL_MS = 30_000;
export const NEGATIVE_TTL_MS = 5_000;
export const NOW_DATE = new Date('2026-07-24T00:00:00Z');

export const POLICY: CacheReadPolicy = {
  domain: 'publication-metadata',
  softTtlMs: SOFT_TTL_MS,
  hardTtlMs: HARD_TTL_MS,
  jitterMs: 0,
  serveStale: false,
  maxEntryBytes: 512 * 1024,
  lockTtlMs: 1_500,
  lockWaitCount: 3,
};

export function record(overrides: Partial<PublicationMetadataRecord> = {}): PublicationMetadataRecord {
  return {
    id: COLLECTION_ID, ownerSubjectId: 'owner', kind: 'bookmarks', title: 'Collection', summary: null,
    visibility: 'public', publicationSlug: SLUG, rootNodeId: 'root-1', rootAvailable: true, contentRevision: 'c1',
    policyRevision: 'p1', tags: [], language: null, membershipRole: null,
    createdAt: '2026-07-01T00:00:00.000Z', updatedAt: '2026-07-23T00:00:00.000Z',
    deletedAt: null, ...overrides,
  };
}

export function collectionDomain(identity: string, locator: 'pubid' | 'pubslug' = 'pubid') {
  return { kind: 'publication' as const, locator, collectionId: identity };
}

export function metadataDataKey(
  identity: string,
  epoch: number,
  query: Record<string, string>,
  locator: 'pubid' | 'pubslug' = 'pubid',
): string {
  return buildCacheDataKey({
    environment: ENVIRONMENT,
    keyPrefix: KEY_PREFIX,
    domain: collectionDomain(identity, locator),
    projection: CACHE_PROJECTION.PUBLICATION_METADATA,
    epoch,
    query,
  });
}

export interface PortsHandle {
  readonly ports: PublicationMetadataQueryPorts;
  loadCount(): number;
  setFail(flag: boolean): void;
}

export function makePorts(current: () => PublicationMetadataRecord | null): PortsHandle {
  let loads = 0;
  let fail = false;
  const ports: PublicationMetadataQueryPorts = {
    reads: {
      async load() {
        loads += 1;
        if (fail) throw new Error('postgres unavailable');
        return current();
      },
    },
    origin: ORIGIN,
    now: () => NOW_DATE,
  };
  return {
    ports,
    loadCount: () => loads,
    setFail: (flag) => { fail = flag; },
  };
}

export interface Fixture {
  readonly store: FakeCacheStore;
  readonly reader: PublicationMetadataCacheReader;
  /** In-memory metrics sink so tests can assert low-cardinality cache counters. */
  readonly metrics: InMemoryMetrics;
  setNow(ms: number): void;
  advance(ms: number): void;
}

export function makeFixture(policy: CacheReadPolicy = POLICY): Fixture {
  const store = new FakeCacheStore();
  const metrics = new InMemoryMetrics();
  const singleflight = new CacheSingleflight();
  const bulkhead = new CacheBulkhead(4);
  const failurePolicy = createCacheFailurePolicy(
    new CacheCircuitBreaker({ failureThreshold: 3, cooldownMs: 1_000 }),
    bulkhead,
  );
  let nowMs = 0;
  const reader = createPublicationMetadataCache({
    policy,
    deps: {
      store,
      singleflight,
      bulkhead,
      failurePolicy,
      metrics,
      clock: () => nowMs,
      random: () => 0,
      tokenFactory: () => 'token-1',
    },
    key: { environment: ENVIRONMENT, keyPrefix: KEY_PREFIX },
  });
  return {
    store,
    reader,
    metrics,
    setNow: (ms) => { nowMs = ms; },
    advance: (ms) => { nowMs += ms; },
  };
}

export function encodeFresh(value: unknown, nowMs: number): string {
  const encoded = encodeCacheEnvelope(
    value,
    { writtenAtMs: nowMs, softExpiresAtMs: nowMs + SOFT_TTL_MS, hardExpiresAtMs: nowMs + HARD_TTL_MS },
    { maxEntryBytes: POLICY.maxEntryBytes },
  );
  if (encoded.kind !== 'ok') throw new Error('test envelope encoding failed');
  return encoded.encoded;
}

export const anonymousIdInput = { collectionId: COLLECTION_ID, principal: { kind: 'anonymous' as const } };
export const anonymousSlugInput = { publicationSlug: SLUG, principal: { kind: 'anonymous' as const } };
