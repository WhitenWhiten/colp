/**
 * Shared fixtures for the T08 Snapshot default-first-page cache decorator unit
 * suite (plan 12-redis-hot-data-cache-plan.md §6.4 T08 / §3.1 / §4.2 / §4.3).
 *
 * Everything here is a test harness, not src: a scripted CacheStore (shared
 * FakeCacheStore), counting annotation/relation/read ports over a 220-row
 * fixture, and key/envelope builders that call the production codec (no copied
 * key/hash/TTL algorithm, plan §7.2 rule 9).
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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
  createPublicationSnapshotCache,
  type PublicationSnapshotCacheReader,
} from '../../src/infrastructure/publication/index.js';
import { InMemoryMetrics } from '../../src/infrastructure/telemetry/index.js';
import {
  createPublicationCursorKeyring,
  PUBLICATION_ANNOTATION_COMPARATOR_VERSION,
  PUBLICATION_RELATION_COMPARATOR_VERSION,
  PUBLICATION_SNAPSHOT_DEFAULT_LIMIT,
  type PublicationAnnotationReadPort,
  type PublicationCollectionRecord,
  type PublicationNodeRecord,
  type PublicationRelationReadPort,
  type PublicationSnapshotQueryPorts,
  type PublicationSnapshotReadPort,
} from '../../src/modules/publication/index.js';
import { FakeCacheStore } from './cache-test-fixtures.js';

export const ORIGIN = 'https://known.example';
export const ENVIRONMENT = 'production';
export const KEY_PREFIX = 'known';
export const COLLECTION_ID = 'collection-1';
export const SOFT_TTL_MS = 10_000;
export const HARD_TTL_MS = 30_000;
export const NOW_DATE = new Date('2026-07-24T00:00:00Z');

export const POLICY: CacheReadPolicy = {
  domain: 'publication-snapshot',
  softTtlMs: SOFT_TTL_MS,
  hardTtlMs: HARD_TTL_MS,
  jitterMs: 0,
  serveStale: false,
  maxEntryBytes: 512 * 1024,
  lockTtlMs: 1_500,
  lockWaitCount: 3,
};

export function collection(overrides: Partial<PublicationCollectionRecord> = {}): PublicationCollectionRecord {
  return {
    id: COLLECTION_ID, ownerSubjectId: 'owner', kind: 'bookmarks', title: 'Collection', summary: null,
    visibility: 'public', publicationSlug: 'pub', rootNodeId: 'r', contentRevision: 'c1',
    policyRevision: 'p1', createdAt: '2026-07-01T00:00:00.000Z', updatedAt: '2026-07-23T00:00:00.000Z',
    deletedAt: null, ...overrides,
  };
}

export function node(id: string, overrides: Partial<PublicationNodeRecord> = {}): PublicationNodeRecord {
  return {
    id, collectionId: COLLECTION_ID, parentId: 'r', kind: 'bookmark', isRoot: false, title: id,
    url: `https://example.test/${id}`, description: null, tags: [], visibility: 'inherit',
    ancestorRestricted: false, moderationHidden: false, position: id.toUpperCase(), resourceRevision: `rev-${id}`,
    createdAt: '2026-07-24T00:00:00.000Z', updatedAt: '2026-07-24T00:00:00.000Z', ...overrides,
  };
}

export const ROOT = node('r', {
  parentId: null, kind: 'folder', isRoot: true, title: 'Root', url: null, position: null,
});

/** 220 public rows so the default first page (limit 200, capacity 199) has a nextCursor. */
export const RECORDS: readonly PublicationNodeRecord[] = Object.freeze(
  Array.from({ length: 220 }, (_, index) => node(`n-${String(index).padStart(3, '0')}`)),
);
export function locator(id: string): string {
  return createHash('sha256').update(id, 'utf8').digest('hex').slice(0, 32);
}

export function snapshotReadPort(
  records: readonly PublicationNodeRecord[],
  current: () => PublicationCollectionRecord,
): PublicationSnapshotReadPort {
  return {
    async loadPage(request) {
      const start = request.afterLocator
        ? Math.max(0, records.findIndex((item) => locator(item.id) === request.afterLocator) + 1)
        : request.after
          ? Math.max(0, records.findIndex((item) => item.id === request.after?.nodeId) + 1)
          : 0;
      return {
        isolation: 'repeatable read',
        comparatorVersion: 'parent-position-id-v1',
        collection: current(),
        root: { ...ROOT, collectionId: current().id },
        candidates: records.slice(start, start + request.limit + 1),
      };
    },
  };
}

export function annotationPort(current: () => PublicationCollectionRecord): PublicationAnnotationReadPort {
  return {
    async loadPage() {
      return {
        isolation: 'repeatable read',
        comparatorVersion: PUBLICATION_ANNOTATION_COMPARATOR_VERSION,
        contentRevision: current().contentRevision,
        policyRevision: current().policyRevision,
        candidates: [],
      };
    },
  };
}

export function relationPort(current: () => PublicationCollectionRecord): PublicationRelationReadPort {
  return {
    async loadPage() {
      return {
        isolation: 'repeatable read',
        comparatorVersion: PUBLICATION_RELATION_COMPARATOR_VERSION,
        contentRevision: current().contentRevision,
        policyRevision: current().policyRevision,
        candidates: [],
      };
    },
  };
}

export interface PortsOptions {
  readonly member?: boolean;
  readonly now?: () => Date;
  readonly current?: () => PublicationCollectionRecord;
  readonly fail?: () => Error;
}

export interface PortsHandle {
  readonly ports: PublicationSnapshotQueryPorts;
  loadCount(): number;
  readonly loadRequests: readonly Parameters<PublicationSnapshotReadPort['loadPage']>[0][];
  setFail(flag: boolean | (() => Error) | null): void;
}

export function makePorts(
  records: readonly PublicationNodeRecord[] = RECORDS,
  options: PortsOptions = {},
): PortsHandle {
  let loads = 0;
  const loadRequests: Parameters<PublicationSnapshotReadPort['loadPage']>[0][] = [];
  let failure: (() => Error) | null = options.fail ?? null;
  const current = options.current ?? (() => collection());
  const baseReads = snapshotReadPort(records, current);
  const reads: PublicationSnapshotReadPort = {
    async loadPage(request) {
      loads += 1;
      loadRequests.push(request);
      if (failure !== null) throw failure();
      return baseReads.loadPage(request);
    },
  };
  const ports: PublicationSnapshotQueryPorts = {
    reads,
    annotations: annotationPort(current),
    relations: relationPort(current),
    cursors: createPublicationCursorKeyring({
      active: { id: 'v1', secret: Buffer.alloc(32, 13).toString('base64') },
      retained: [],
    }),
    accessPolicy: {
      async loadCollectionFacts() {
        const row = current();
        return {
          collectionId: row.id,
          ownerSubjectId: row.ownerSubjectId,
          visibility: row.visibility,
          policyRevision: row.policyRevision,
          membershipRole: options.member ? 'viewer' : null,
          deleted: false,
        };
      },
    },
    origin: ORIGIN,
    now: options.now ?? (() => NOW_DATE),
    sharedExposure: Object.freeze({ async listBlobFacts() { return []; } }),
  };
  return {
    ports,
    loadCount: () => loads,
    loadRequests,
    setFail(flag) {
      if (flag === true) failure = () => new Error('postgres unavailable');
      else if (flag === false || flag === null) failure = null;
      else failure = flag;
    },
  };
}

export interface Fixture {
  readonly store: FakeCacheStore;
  readonly reader: PublicationSnapshotCacheReader;
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
  const reader = createPublicationSnapshotCache({
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

/** The canonical cache query for the anonymous default first page. */
export const DEFAULT_QUERY: Record<string, unknown> = Object.freeze({
  root: null,
  depth: null,
  include: [],
  limit: PUBLICATION_SNAPSHOT_DEFAULT_LIMIT,
  pageCursor: null,
});

export function snapshotDomain(): { readonly kind: 'publication'; readonly locator: 'pubid'; readonly collectionId: string } {
  return { kind: 'publication' as const, locator: 'pubid' as const, collectionId: COLLECTION_ID };
}

export function snapshotDataKey(epoch: number, query: Record<string, unknown> = DEFAULT_QUERY): string {
  return buildCacheDataKey({
    environment: ENVIRONMENT,
    keyPrefix: KEY_PREFIX,
    domain: snapshotDomain(),
    projection: CACHE_PROJECTION.PUBLICATION_SNAPSHOT,
    epoch,
    query,
  });
}

export const ANONYMOUS = { collectionId: COLLECTION_ID, principal: { kind: 'anonymous' as const } };
export const MEMBER = {
  collectionId: COLLECTION_ID,
  principal: { kind: 'account' as const, principalId: 'account-1', subjectId: 'member' },
};

/** A structurally valid (but minimal) public snapshot used to forge cached values. */
export function minimalSnapshot(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    protocolVersion: '0.1',
    snapshotId: 'snapshot-min',
    mode: 'publication',
    complete: true,
    collection: {
      schemaVersion: '0.1',
      id: COLLECTION_ID,
      canonicalUrl: `${ORIGIN}/c/pub`,
      slug: 'pub',
      kind: 'bookmarks',
      title: 'Collection',
      rootNodeId: 'r',
      visibility: 'public',
      createdAt: '2026-07-01T00:00:00.000Z',
      updatedAt: '2026-07-23T00:00:00.000Z',
      revision: 'c1.p1',
    },
    nodes: [],
    annotations: [],
    attachments: [],
    relations: [],
    tombstones: [],
    warnings: [],
    revision: 'c1.p1',
    generatedAt: '2026-07-23T00:00:00.000Z',
    page: { nextCursor: null, hasMore: false, sequence: 1 },
    ...overrides,
  };
}
