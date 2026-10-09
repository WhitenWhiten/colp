/**
 * Shared fixtures for the T07 Directory first-page cache decorator unit suite
 * (plan 12-redis-hot-data-cache-plan.md §6.4 T07 / §3.1 / §4.2 / §4.3).
 *
 * Everything here is a test harness, not src: a scripted CacheStore (shared
 * FakeCacheStore), a counting Publication read port with the same
 * public/protected/unlisted/private filtering the real Postgres port applies,
 * and key/envelope builders that call the production codec (no copied
 * key/hash/TTL algorithm, plan §7.2 rule 9).
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
  createPublicationDirectoryCache,
  type PublicationDirectoryCacheReader,
} from '../../src/infrastructure/publication/index.js';
import { InMemoryMetrics } from '../../src/infrastructure/telemetry/index.js';
import {
  createPublicationCursorKeyring,
  PublicationDirectoryAnchorNotFoundError,
  type PublicationDirectoryQueryPorts,
  type PublicationDirectoryReadPort,
  type PublicationDirectoryRecord,
} from '../../src/modules/publication/index.js';
import { FakeCacheStore } from './cache-test-fixtures.js';

export const ORIGIN = 'https://known.example';
export const ENVIRONMENT = 'production';
export const KEY_PREFIX = 'known';
export const SOFT_TTL_MS = 5_000;
export const HARD_TTL_MS = 15_000;

export const POLICY: CacheReadPolicy = {
  domain: 'publication-directory',
  softTtlMs: SOFT_TTL_MS,
  hardTtlMs: HARD_TTL_MS,
  jitterMs: 0,
  serveStale: false,
  maxEntryBytes: 512 * 1024,
  lockTtlMs: 1_500,
  lockWaitCount: 3,
};

export function record(
  id: string,
  updatedAt: string,
  visibility: PublicationDirectoryRecord['visibility'],
  discoverable: boolean,
  overrides: Partial<PublicationDirectoryRecord> = {},
): PublicationDirectoryRecord & { discoverable: boolean } {
  return {
    id,
    ownerSubjectId: 'owner',
    title: id,
    summary: `summary ${id}`,
    kind: 'bookmarks',
    visibility,
    publicationSlug: id,
    tags: ['tag'],
    language: 'en',
    nodeCount: 2,
    updatedAt,
    orderingUpdatedAtMicros: String(BigInt(Date.parse(updatedAt)) * 1000n),
    protectedAuthorized: false,
    ...overrides,
    discoverable,
  };
}

/**
 * 60 public+discoverable rows (so the default first page has a non-null
 * nextCursor) plus protected/unlisted/private rows that must never reach the
 * anonymous value. Two rows share the same ordering micros to exercise the
 * `id ASC` secondary sort ('a-tie' before 'z-tie').
 */
export function makeRows(): readonly (PublicationDirectoryRecord & { discoverable: boolean })[] {
  const rows: (PublicationDirectoryRecord & { discoverable: boolean })[] = [];
  for (let i = 0; i < 60; i += 1) {
    const minute = 59 - i;
    rows.push(record(
      `public-${String(i).padStart(2, '0')}`,
      `2026-07-24T00:${String(minute).padStart(2, '0')}:00.000Z`,
      'public',
      true,
    ));
  }
  rows[0] = record('z-tie', '2026-07-24T00:59:00.000Z', 'public', true);
  rows[1] = record('a-tie', '2026-07-24T00:59:00.000Z', 'public', true);
  rows.push(record('protected-member', '2026-07-24T01:00:00.000Z', 'protected', true, { protectedAuthorized: true }));
  rows.push(record('protected-not-member', '2026-07-24T01:01:00.000Z', 'protected', true, { protectedAuthorized: false }));
  rows.push(record('unlisted', '2026-07-24T01:02:00.000Z', 'public', false));
  rows.push(record('private', '2026-07-24T01:03:00.000Z', 'protected', false));
  return Object.freeze(rows);
}

export const ROWS = makeRows();

export function sortRows(rows: readonly (PublicationDirectoryRecord & { discoverable: boolean })[]): typeof ROWS {
  return [...rows].sort((a, b) => {
    const micros = BigInt(b.orderingUpdatedAtMicros) - BigInt(a.orderingUpdatedAtMicros);
    if (micros !== 0n) return micros > 0n ? 1 : -1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

export interface PortsHandle {
  readonly ports: PublicationDirectoryQueryPorts;
  loadCount(): number;
  setFail(flag: boolean): void;
  setFresh(flag: boolean): void;
}

export function makePorts(options: { readonly maxPageSize?: number } = {}): PortsHandle {
  let loads = 0;
  let fail = false;
  let fresh = true;
  const reads: PublicationDirectoryReadPort = {
    async loadPage(request) {
      loads += 1;
      if (fail) throw new Error('postgres unavailable');
      let selected = ROWS.filter((row) => row.discoverable && (
        row.visibility === 'public'
        || (request.principal !== 'anonymous' && row.protectedAuthorized)
      ));
      if (request.filter.q) selected = selected.filter((row) => row.title.toLowerCase().includes(request.filter.q!.toLowerCase()));
      if (request.filter.tag) selected = selected.filter((row) => row.tags.includes(request.filter.tag!));
      if (request.filter.creator) selected = selected.filter((row) => row.ownerSubjectId === request.filter.creator);
      if (request.filter.kind) selected = selected.filter((row) => row.kind === request.filter.kind);
      if (request.filter.updatedSince) selected = selected.filter((row) => row.updatedAt >= request.filter.updatedSince!);
      selected = sortRows(selected);
      if (request.after) {
        const index = selected.findIndex((row) => row.orderingUpdatedAtMicros === request.after!.orderingUpdatedAtMicros);
        if (index < 0) throw new PublicationDirectoryAnchorNotFoundError();
        selected = selected.slice(index + 1);
      }
      return selected.slice(0, request.limit + 1);
    },
    async arePublicCacheCollectionsCurrent() { return fresh; },
  };
  const ports: PublicationDirectoryQueryPorts = {
    reads,
    origin: ORIGIN,
    cursors: createPublicationCursorKeyring({
      active: { id: 'directory-v1', secret: Buffer.alloc(32, 23).toString('base64') },
      retained: [],
    }),
    ...(options.maxPageSize !== undefined ? { maxPageSize: options.maxPageSize } : {}),
  };
  return {
    ports,
    loadCount: () => loads,
    setFail: (flag) => { fail = flag; },
    setFresh: (flag) => { fresh = flag; },
  };
}

export interface Fixture {
  readonly store: FakeCacheStore;
  readonly reader: PublicationDirectoryCacheReader;
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
  const reader = createPublicationDirectoryCache({
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

export function directoryDomain(): { readonly kind: 'publication-directory' } {
  return { kind: 'publication-directory' };
}

export function directoryDataKey(epoch: number, limit: number): string {
  return buildCacheDataKey({
    environment: ENVIRONMENT,
    keyPrefix: KEY_PREFIX,
    domain: directoryDomain(),
    projection: CACHE_PROJECTION.PUBLICATION_DIRECTORY_PAGE,
    epoch,
    query: { limit },
  });
}

export const ANONYMOUS = { kind: 'anonymous' as const };
export const MEMBER = { kind: 'account' as const, principalId: 'account-1', subjectId: 'member' };
