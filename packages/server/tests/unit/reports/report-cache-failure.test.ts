import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  CACHE_ERROR_CATEGORY,
  CacheBulkhead,
  CacheCircuitBreaker,
  CacheStoreError,
  createCacheFailurePolicy,
} from '../../../src/infrastructure/cache/index.js';
import { createReportCache } from '../../../src/infrastructure/reports/report-cache.js';
import type { ReportUnitOfWork } from '../../../src/modules/reports/index.js';

test('report cache epoch outage falls back to the authoritative query and opens the shared breaker', async () => {
  let epochReads = 0;
  let originReads = 0;
  const store = {
    async get() { epochReads += 1; throw new CacheStoreError(CACHE_ERROR_CATEGORY.UNAVAILABLE, 'redis unavailable'); },
    async set() {},
    async setIfAbsent() { return false; },
    async releaseIfOwner() { return false; },
    async rotateEpoch() { return 1; },
    async health() { return 'degraded' as const; },
    async close() {},
  };
  const breaker = new CacheCircuitBreaker({ failureThreshold: 3, cooldownMs: 60_000 });
  const failurePolicy = createCacheFailurePolicy(breaker, new CacheBulkhead(2));
  const series = {
    id: 'series-1', ownerSubjectId: 'owner-1', title: 'Report', summary: null,
    slug: 'report-one', visibility: 'public' as const, allowSearchIndexing: false,
    state: 'active' as const, resourceRevision: 'r1', contentRevision: 'c1',
    policyRevision: 'p1', updatedAt: '2026-09-04T00:00:00.000Z',
  };
  const unit = {
    async execute(callback: (ports: never) => Promise<unknown>) {
      originReads += 1;
      return callback({
        series: { list: async () => [series] },
        editions: { listBySeries: async () => [] },
        source: { getMany: async () => [] },
      } as never);
    },
  } as unknown as ReportUnitOfWork;
  const reader = createReportCache({
    store,
    key: { environment: 'test', keyPrefix: 'known' },
    failurePolicy,
    metadataEnabled: true,
  });
  for (let index = 0; index < 3; index += 1) {
    const result = await reader.series(unit, 'report-one');
    assert.equal(result?.slug, 'report-one');
  }
  assert.equal(epochReads, 3);
  assert.equal(originReads, 3);
  assert.equal(breaker.currentState, 'open');
  const before = epochReads;
  assert.equal((await reader.series(unit, 'report-one'))?.slug, 'report-one');
  assert.equal(epochReads, before, 'open breaker bypasses Redis epoch reads');
  assert.equal(originReads, 4);
});

test('report cache rejects a forged public envelope containing private ownership fields', async () => {
  let dataReads = 0;
  const malicious = JSON.stringify({
    schemaVersion: 1,
    writtenAtMs: 0,
    softExpiresAtMs: Number.MAX_SAFE_INTEGER,
    hardExpiresAtMs: Number.MAX_SAFE_INTEGER,
    value: {
      id: 'series-1', title: 'forged', summary: null, slug: 'report-one', visibility: 'public',
      indexable: true, updatedAt: '2026-01-01T00:00:00.000Z', issues: [], ownerSubjectId: 'secret-owner',
    },
  });
  const store = {
    async get(key: string) { dataReads += 1; return key.includes(':epoch') ? '0' : malicious; },
    async set() {}, async setIfAbsent() { return true; }, async releaseIfOwner() { return true; },
    async rotateEpoch() { return 1; }, async health() { return 'healthy' as const; }, async close() {},
  };
  const failurePolicy = createCacheFailurePolicy(new CacheCircuitBreaker({ failureThreshold: 3, cooldownMs: 60_000 }), new CacheBulkhead(2));
  const origin = {
    id: 'series-1', title: 'authoritative', summary: null, slug: 'report-one', visibility: 'public' as const,
    allowSearchIndexing: true, state: 'active' as const, resourceRevision: 'r1', contentRevision: 'c1', policyRevision: 'p1',
    updatedAt: '2026-01-01T00:00:00.000Z', issues: [], indexable: true,
  };
  const unit = { execute: async (callback: (ports: never) => Promise<unknown>) => callback({
    series: { list: async () => [origin] }, editions: { listBySeries: async () => [] }, source: { getMany: async () => [] },
  } as never) } as unknown as ReportUnitOfWork;
  const reader = createReportCache({
    store, key: { environment: 'test', keyPrefix: 'known' }, failurePolicy, metadataEnabled: true,
  });
  const value = await reader.series(unit, 'report-one');
  assert.equal(value?.title, 'authoritative');
  assert.ok(dataReads >= 2, 'the forged data key should have been inspected and rejected');
});

test('report cache rejects cross-report links and oversized public fields', async () => {
  const malicious = JSON.stringify({
    schemaVersion: 1,
    writtenAtMs: 0,
    softExpiresAtMs: Number.MAX_SAFE_INTEGER,
    hardExpiresAtMs: Number.MAX_SAFE_INTEGER,
    value: {
      id: 'series-1', title: 'forged', summary: 'x'.repeat(2_001), slug: 'report-one',
      visibility: 'public', indexable: true, updatedAt: '2026-01-01T00:00:00.000Z',
      issues: [{
        id: 'edition-1', title: 'Issue', summary: null,
        publishedAt: '2026-01-01T00:00:00.000Z',
        url: 'https://know-n.com/reports/other-report/issues/edition-1',
      }],
    },
  });
  let reads = 0;
  const store = {
    async get(key: string) { reads += 1; return key.includes(':epoch') ? '0' : malicious; },
    async set() {}, async setIfAbsent() { return true; }, async releaseIfOwner() { return true; },
    async rotateEpoch() { return 1; }, async health() { return 'healthy' as const; }, async close() {},
  };
  const failurePolicy = createCacheFailurePolicy(
    new CacheCircuitBreaker({ failureThreshold: 3, cooldownMs: 60_000 }),
    new CacheBulkhead(2),
  );
  const origin = {
    id: 'series-1', title: 'authoritative', summary: null, slug: 'report-one',
    visibility: 'public' as const, allowSearchIndexing: true, state: 'active' as const,
    resourceRevision: 'r1', contentRevision: 'c1', policyRevision: 'p1',
    updatedAt: '2026-01-01T00:00:00.000Z', issues: [], indexable: true,
  };
  const unit = {
    execute: async (callback: (ports: never) => Promise<unknown>) => callback({
      series: { list: async () => [origin] },
      editions: { listBySeries: async () => [] },
      source: { getMany: async () => [] },
    } as never),
  } as unknown as ReportUnitOfWork;
  const reader = createReportCache({
    store, key: { environment: 'test', keyPrefix: 'known' }, failurePolicy, metadataEnabled: true,
  });
  assert.equal((await reader.series(unit, 'report-one'))?.title, 'authoritative');
  assert.ok(reads >= 2, 'the invalid envelope should be read and rejected');
});

test('report issue cache binds the envelope to the requested edition id', async () => {
  const malicious = JSON.stringify({
    schemaVersion: 1,
    writtenAtMs: 0,
    softExpiresAtMs: Number.MAX_SAFE_INTEGER,
    hardExpiresAtMs: Number.MAX_SAFE_INTEGER,
    value: {
      series: {
        id: 'series-1', title: 'Report', summary: null, slug: 'report-one', visibility: 'public',
        indexable: true, updatedAt: '2026-01-01T00:00:00.000Z', issues: [],
      },
      issue: {
        id: 'edition-other', title: 'Other', summary: null,
        publishedAt: '2026-01-01T00:00:00.000Z',
        url: 'https://know-n.com/reports/report-one/issues/edition-other',
      },
    },
  });
  const store = {
    async get(key: string) { return key.includes(':epoch') ? '0' : malicious; },
    async set() {}, async setIfAbsent() { return true; }, async releaseIfOwner() { return true; },
    async rotateEpoch() { return 1; }, async health() { return 'healthy' as const; }, async close() {},
  };
  const failurePolicy = createCacheFailurePolicy(
    new CacheCircuitBreaker({ failureThreshold: 3, cooldownMs: 60_000 }),
    new CacheBulkhead(2),
  );
  const series = {
    id: 'series-1', ownerSubjectId: 'owner', title: 'Report', summary: null,
    slug: 'report-one', visibility: 'public' as const, allowSearchIndexing: true,
    state: 'active' as const, resourceRevision: 'r1', contentRevision: 'c1',
    policyRevision: 'p1', updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const edition = {
    id: 'edition-1', seriesId: 'series-1', sourceCollectionId: 'collection-1', issueKey: 'one',
    editionOrdinal: 1, titleSnapshot: 'Authoritative', summarySnapshot: null,
    sourceContentRevision: 'c1', sourcePolicyRevision: 'p1', resourceRevision: 'e1',
    periodStart: null, periodEnd: null, state: 'published' as const,
    publishedAt: '2026-01-01T00:00:00.000Z',
  };
  const source = {
    collectionId: 'collection-1', visibility: 'public' as const,
    publishedAt: '2026-01-01T00:00:00.000Z', publicationSlug: 'source-one',
    hasRoot: true, allowSearchIndexing: true, ownerAccountActive: true,
    deleted: false, seedExcluded: false, contentRevision: 'c1', policyRevision: 'p1',
  };
  const unit = {
    execute: async (callback: (ports: never) => Promise<unknown>) => callback({
      series: { list: async () => [series] },
      editions: { listBySeries: async () => [edition] },
      source: { getMany: async () => [source] },
    } as never),
  } as unknown as ReportUnitOfWork;
  const reader = createReportCache({
    store, key: { environment: 'test', keyPrefix: 'known' }, failurePolicy, issuesEnabled: true,
  });
  const value = await reader.issue(unit, 'report-one', 'edition-1');
  assert.equal(value?.issue.id, 'edition-1');
  assert.equal(value?.issue.title, 'Authoritative');
});
