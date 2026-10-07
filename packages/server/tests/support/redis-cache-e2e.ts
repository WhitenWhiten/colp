/**
 * T13 shared end-to-end helpers (plan 12-redis-hot-data-cache-plan.md §6.4 T13,
 * §7.1 HTTP/PostgreSQL integration layer, §7.2/§7.3 anti-false-positive/negative
 * rules).
 *
 * Everything here is a *test harness*, not src. It composes the real
 * production surfaces used by T13:
 *
 * - real Testcontainers Redis (keep-alive shell so the failure suite can stop
 *   and restart the redis-server *process* without losing the port mapping),
 * - `createApiCacheComposition` (T10) + `buildApiApp` (real HTTP),
 * - real PostgreSQL read ports wrapped in request-scoped counters,
 * - `createRedisCacheStore` (T03) wrapped in a counting CacheStore so Redis
 *   GET/SET/lock/epoch evidence is observable,
 * - `buildWorker` (T11) with its own worker-owned Redis store for the
 *   mutation -> outbox -> epoch invalidation chain,
 * - published-collection SQL fixtures (canonical ids required by the social
 *   collection-change mapper), OIDC browser login, outbox drain and polling.
 *
 * Isolation (plan §7.1 / §7.3 rule 7): every test uses a random key prefix and
 * its own fixture ids; the Redis container is exclusive to the calling suite;
 * no FLUSHALL/FLUSHDB is ever issued.
 */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import { createApiCacheComposition, type ApiCacheComposition } from '../../src/bootstrap/cache-composition.js';
import { loadConfig, type AppConfig } from './test-config.js';
import { buildWorker, type WorkerRuntime } from '../../src/bootstrap/worker.js';
import {
  createRedisCacheStore,
  type CacheHealthState,
  type CacheStore,
  type RedisCacheConnectionConfig,
} from '../../src/infrastructure/cache/index.js';
import {
  createPostgresCanonicalMutationUnitOfWork,
  createPostgresCollectionsEditorReadUnitOfWork,
  createPostgresCollectionsUnitOfWork,
  createPostgresOwnedCollectionsReadPort,
  createPostgresCollectionBookmarkCountReadPort,
} from '../../src/infrastructure/collections/index.js';
import {
  materializeCollectionPayload,
  RESOURCE_PAYLOAD_SCHEMA_VERSION,
} from '../../src/modules/collections/index.js';
import { createDatabaseRuntime, type DatabaseRuntime } from '../../src/infrastructure/database/index.js';
import { createPostgresIdentityUnitOfWork } from '../../src/infrastructure/identity/index.js';
import {
  createPostgresPublicationAnnotationReadPort,
  createPostgresPublicationDirectoryReadPort,
  createPostgresPublicationMetadataReadPort,
  createPostgresPublicationRelationReadPort,
  createPostgresPublicationSnapshotReadPort,
} from '../../src/infrastructure/publication/index.js';
import { createPostgresAccessPolicyFactsPort } from '../../src/infrastructure/access-policy/index.js';
import { createPostgresSharedExposureFactsPort } from '../../src/infrastructure/database/index.js';
import { InMemoryMetrics, type Metrics } from '../../src/infrastructure/telemetry/index.js';
import type {
  PublicationDirectoryReadPort,
  PublicationDirectoryReadRequest,
  PublicationDirectoryRecord,
  PublicationMetadataReadPort,
  PublicationMetadataRecord,
  PublicationSnapshotReadPage,
  PublicationSnapshotReadPort,
  PublicationSnapshotReadRequest,
} from '../../src/modules/publication/index.js';
import {
  createProductEditorCursorSigner,
  createProductOwnedCollectionsCursorSigner,
  createPublicationCursorKeyring,
} from '../../src/modules/index.js';
import { buildApiApp } from '../../src/transport/app.js';
import { memoryExploreDirectoryLimiter } from './memory-product-rate-limiters.js';
import { waitForCondition } from './async-test-helpers.js';
import {
  createPostgresBetterAuthTestFactory,
  type PostgresBetterAuthTestFactory,
} from './better-auth-test-factory.js';

/** Test-exclusive Redis image; CI may pin via KNOWN_REDIS_IMAGE (mirrors T12). */
export const REDIS_IMAGE = process.env.KNOWN_REDIS_IMAGE?.trim() || 'redis:7-alpine';

export const E2E_ORIGIN = 'https://app.example.test';

export type E2ECacheMode = 'off' | 'shadow' | 'serve';

/**
 * Poll a predicate until it holds or the deadline passes. Polling is the
 * synchronization primitive everywhere in T13 (plan §7.3 rule 2/8); a fixed
 * sleep is never the only oracle.
 */
export async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs: number,
  description: string,
  intervalMs = 25,
): Promise<void> {
  await waitForCondition(predicate, {
    timeoutMs,
    pollIntervalMs: intervalMs,
    description,
  });
}

/** Per-test isolation scope: random Redis key prefix + fixture subjects. */
export interface E2ETestScope {
  readonly suffix: string;
  readonly keyPrefix: string;
  readonly ownerSubject: string;
  readonly memberSubject: string;
}

export function newE2ETestScope(): E2ETestScope {
  const suffix = randomUUID().replaceAll('-', '');
  return {
    suffix,
    keyPrefix: `t13-${suffix.slice(0, 24)}`,
    ownerSubject: `t13-owner-${suffix.slice(0, 12)}`,
    memberSubject: `t13-member-${suffix.slice(0, 12)}`,
  };
}

/** Test-exclusive Redis container with a keep-alive shell (T12 pattern). */
export interface RedisE2EContainer {
  readonly url: string;
  readonly container: StartedTestContainer;
  stop(): Promise<void>;
}

export async function startRedisE2EContainer(): Promise<RedisE2EContainer> {
  let started: StartedTestContainer;
  try {
    started = await new GenericContainer(REDIS_IMAGE)
      .withExposedPorts(6379)
      .withCommand(['sh', '-c', 'redis-server --daemonize yes; while true; do sleep 3600; done'])
      .withStartupTimeout(120_000)
      .start();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `T13 fail-closed: could not start a dedicated Redis container (image ${REDIS_IMAGE}). ` +
        `The real Redis end-to-end suite requires Docker/Testcontainers and never reuses a ` +
        `developer's REDIS_URL: ${detail}`,
    );
  }
  const port = started.getMappedPort(6379);
  return {
    url: `redis://127.0.0.1:${port}`,
    container: started,
    async stop() {
      await started.stop();
    },
  };
}

export interface CacheOperationCounts {
  get: number;
  set: number;
  setIfAbsent: number;
  releaseIfOwner: number;
  rotateEpoch: number;
  health: number;
  close: number;
}

/** Wraps a real CacheStore and counts every operation (Redis GET/write/lock/epoch evidence). */
export class CountingCacheStore implements CacheStore {
  readonly counts: CacheOperationCounts = {
    get: 0,
    set: 0,
    setIfAbsent: 0,
    releaseIfOwner: 0,
    rotateEpoch: 0,
    health: 0,
    close: 0,
  };

  constructor(readonly inner: CacheStore) {}

  get(key: string, signal: AbortSignal): Promise<string | null> {
    this.counts.get += 1;
    return this.inner.get(key, signal);
  }

  set(key: string, encodedValue: string, hardTtlMs: number, signal: AbortSignal): Promise<void> {
    this.counts.set += 1;
    return this.inner.set(key, encodedValue, hardTtlMs, signal);
  }

  setIfAbsent(key: string, token: string, lockTtlMs: number, signal: AbortSignal): Promise<boolean> {
    this.counts.setIfAbsent += 1;
    return this.inner.setIfAbsent(key, token, lockTtlMs, signal);
  }

  releaseIfOwner(key: string, token: string, signal: AbortSignal): Promise<boolean> {
    this.counts.releaseIfOwner += 1;
    return this.inner.releaseIfOwner(key, token, signal);
  }

  rotateEpoch(key: string, epochTtlMs: number, signal: AbortSignal): Promise<number> {
    this.counts.rotateEpoch += 1;
    return this.inner.rotateEpoch(key, epochTtlMs, signal);
  }

  health(signal?: AbortSignal): Promise<CacheHealthState> {
    this.counts.health += 1;
    return this.inner.health(signal);
  }

  close(): Promise<void> {
    this.counts.close += 1;
    return this.inner.close();
  }

  reset(): void {
    (Object.keys(this.counts) as Array<keyof CacheOperationCounts>).forEach((key) => {
      this.counts[key] = 0;
    });
  }
}

export class CountingMetadataReadPort implements PublicationMetadataReadPort {
  readonly calls = { load: 0 };

  constructor(
    readonly inner: PublicationMetadataReadPort,
    private readonly beforeLoad?: () => Promise<void>,
  ) {}

  async load(
    input: Parameters<PublicationMetadataReadPort['load']>[0],
  ): ReturnType<PublicationMetadataReadPort['load']> {
    this.calls.load += 1;
    await this.beforeLoad?.();
    return this.inner.load(input);
  }
}

export class CountingDirectoryReadPort implements PublicationDirectoryReadPort {
  readonly calls = { loadPage: 0 };

  constructor(readonly inner: PublicationDirectoryReadPort) {}

  loadPage(request: PublicationDirectoryReadRequest): Promise<readonly PublicationDirectoryRecord[]> {
    this.calls.loadPage += 1;
    return this.inner.loadPage(request);
  }
}

export class CountingSnapshotReadPort implements PublicationSnapshotReadPort {
  readonly calls = { loadPage: 0 };

  constructor(readonly inner: PublicationSnapshotReadPort) {}

  loadPage(request: PublicationSnapshotReadRequest): Promise<PublicationSnapshotReadPage> {
    this.calls.loadPage += 1;
    return this.inner.loadPage(request);
  }
}

/** Builds an AppConfig for a mode; serve/shadow require the container URL. */
export function buildE2EConfig(
  scope: E2ETestScope,
  mode: E2ECacheMode,
  databaseUrl: string,
  redisUrl: string | null,
): AppConfig {
  return loadConfig({
    DATABASE_URL: databaseUrl,
    PRODUCT_ORIGIN: E2E_ORIGIN,
    ALLOWED_ORIGINS: E2E_ORIGIN,
    OIDC_ISSUER: 'https://issuer.example/realms/known',
    OIDC_CLIENT_ID: 'known-web',
    OIDC_REDIRECT_URI: `${E2E_ORIGIN}/api/v1/auth/oidc/callback`,
    OIDC_AUTHORIZATION_ENDPOINT: 'https://issuer.example/realms/known/auth',
    OIDC_TOKEN_ENDPOINT: 'https://issuer.example/realms/known/token',
    OIDC_ALLOW_TEST_PROVIDER: 'true',
    OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default',
    PRODUCT_EDITOR_CURSOR_HMAC_KEY: 't13-editor-cursor-key',
    WORKER_POLL_INTERVAL_MS: '5',
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    KNOWN_CACHE_MODE: mode,
    REDIS_URL: redisUrl ?? '',
    REDIS_KEY_PREFIX: scope.keyPrefix,
    REDIS_COMMAND_TIMEOUT_MS: '200',
    REDIS_CONNECT_TIMEOUT_MS: '2000',
    REDIS_MAX_RETRIES_PER_REQUEST: '1',
    CACHE_PUBLICATION_METADATA_ENABLED: 'true',
    CACHE_PUBLICATION_DIRECTORY_ENABLED: 'true',
    CACHE_PUBLICATION_SNAPSHOT_ENABLED: 'true',
  });
}

export interface ComposedPublicationCounters {
  readonly metadata: CountingMetadataReadPort;
  readonly directory: CountingDirectoryReadPort;
  readonly snapshot: CountingSnapshotReadPort;
  reset(): void;
}

export interface ComposedApi {
  readonly mode: E2ECacheMode;
  readonly app: FastifyInstance;
  /** E1: Better Auth test factory backing the composed app's session authority. */
  readonly factory: PostgresBetterAuthTestFactory;
  readonly cacheComposition: ApiCacheComposition;
  /** Present only for shadow/serve; undefined for off (no Redis client is created). */
  readonly store: CountingCacheStore | undefined;
  readonly counters: ComposedPublicationCounters;
  readonly metrics: Metrics;
  close(): Promise<void>;
}

export interface ApiCompositionContext {
  readonly databaseUrl: string;
  readonly runtime: DatabaseRuntime;
  readonly redisUrl: string | null;
  readonly cursorKeys: ReturnType<typeof createPublicationCursorKeyring>;
}

/**
 * Real HTTP/Application composition: `buildApiApp` + T10 `createApiCacheComposition`
 * (T06-T08 readers + real Redis store + real config) + real PostgreSQL read
 * ports wrapped in request-scoped counters. mode=off creates no Redis client.
 */
export function composeApi(
  scope: E2ETestScope,
  mode: E2ECacheMode,
  ctx: ApiCompositionContext,
  cacheOptions: {
    readonly breakerFailureThreshold?: number;
    readonly breakerCooldownMs?: number;
    readonly bulkheadCapacity?: number;
    readonly metadataLoadGate?: () => Promise<void>;
  } = {},
): ComposedApi {
  const config = buildE2EConfig(scope, mode, ctx.databaseUrl, ctx.redisUrl);
  const runtime = ctx.runtime;
  const metadataPort = new CountingMetadataReadPort(
    createPostgresPublicationMetadataReadPort(runtime),
    cacheOptions.metadataLoadGate,
  );
  const directoryPort = new CountingDirectoryReadPort(createPostgresPublicationDirectoryReadPort(runtime));
  const snapshotPort = new CountingSnapshotReadPort(createPostgresPublicationSnapshotReadPort(runtime));
  const accessPolicy = createPostgresAccessPolicyFactsPort(runtime.db);
  const metrics = new InMemoryMetrics();
  const compositionOptions = {
    ...(cacheOptions.breakerFailureThreshold === undefined
      ? {} : { breakerFailureThreshold: cacheOptions.breakerFailureThreshold }),
    ...(cacheOptions.breakerCooldownMs === undefined
      ? {} : { breakerCooldownMs: cacheOptions.breakerCooldownMs }),
    ...(cacheOptions.bulkheadCapacity === undefined
      ? {} : { bulkheadCapacity: cacheOptions.bulkheadCapacity }),
  };

  let store: CountingCacheStore | undefined;
  const cacheComposition = createApiCacheComposition({
    config: config.cache,
    metrics,
    environment: 'test',
    ...compositionOptions,
    createStore: (cfg: RedisCacheConnectionConfig) => {
      store = new CountingCacheStore(createRedisCacheStore(cfg));
      return store;
    },
  });

  const ownedCollectionCursors = createProductOwnedCollectionsCursorSigner({
    current: {
      id: `owned-t13-${scope.suffix.slice(0, 12)}`,
      key: 'owned-t13-cursor-secret-material-32-bytes',
    },
  });
  const factory = createPostgresBetterAuthTestFactory({ db: runtime.db });
  const app = buildApiApp({
    config,
    readiness: runtime,
    exploreDirectoryRateLimiter: memoryExploreDirectoryLimiter(),
    browserSessionAuthority: factory.authority,
    identityUnitOfWork: createPostgresIdentityUnitOfWork(runtime.db, {
      oidcTransactionSecrets: config.oidcTransactionSecrets,
    }),
    collectionsUnitOfWork: createPostgresCollectionsUnitOfWork(runtime.db),
    productCollectionMutationUnitOfWork: createPostgresCanonicalMutationUnitOfWork(runtime.db),
    collectionsEditorReadUnitOfWork: createPostgresCollectionsEditorReadUnitOfWork(runtime.db, {
      cursorSigner: createProductEditorCursorSigner({
        current: config.productEditorCursor.current,
        previous: config.productEditorCursor.previous,
      }),
      cursorTtlMs: config.productEditorCursor.ttlMs,
    }),
    ownedCollectionsQuery: {
      reads: createPostgresOwnedCollectionsReadPort(runtime.db),
      cursors: ownedCollectionCursors,
      clock: { now: async () => new Date() },
    },
    bookmarkCounts: createPostgresCollectionBookmarkCountReadPort(runtime.db),
    metrics,
    publicationSnapshotQuery: {
      reads: snapshotPort,
      annotations: createPostgresPublicationAnnotationReadPort(runtime, { origin: config.productOrigin }),
      relations: createPostgresPublicationRelationReadPort(runtime),
      accessPolicy,
      cursors: ctx.cursorKeys,
      origin: config.publication.origin,
      // P4A-R06: exposure-eligibility gate over logical blob facts (deny-by-default).
      sharedExposure: createPostgresSharedExposureFactsPort(runtime),
    },
    publicationDirectoryQuery: {
      reads: directoryPort,
      cursors: ctx.cursorKeys,
      origin: config.publication.origin,
      maxPageSize: config.publication.maxPageSize,
    },
    publicationMetadataQuery: {
      reads: metadataPort,
      origin: config.publication.origin,
    },
    ...(cacheComposition.snapshotReader === undefined
      ? {}
      : { publicationSnapshotCacheReader: cacheComposition.snapshotReader }),
    ...(cacheComposition.directoryReader === undefined
      ? {}
      : { publicationDirectoryCacheReader: cacheComposition.directoryReader }),
    ...(cacheComposition.metadataReader === undefined
      ? {}
      : { publicationMetadataCacheReader: cacheComposition.metadataReader }),
    cacheReadiness: () => cacheComposition.readiness(),
    cacheCapabilityReadiness: () => cacheComposition.capabilityReadiness(),
  });

  const counters: ComposedPublicationCounters = {
    metadata: metadataPort,
    directory: directoryPort,
    snapshot: snapshotPort,
    reset() {
      metadataPort.calls.load = 0;
      directoryPort.calls.loadPage = 0;
      snapshotPort.calls.loadPage = 0;
    },
  };

  return {
    mode,
    app,
    factory,
    cacheComposition,
    store,
    counters,
    metrics,
    async close() {
      await app.close();
      await cacheComposition.close();
      ownedCollectionCursors.destroy();
    },
  };
}

/** Waits until the composed API's Redis store reports healthy. */
export async function waitForCacheHealth(
  composed: ComposedApi,
  timeoutMs = 15_000,
): Promise<void> {
  assert.ok(composed.store, 'serve/shadow composition must own a Redis store');
  await waitUntil(
    async () => (await composed.store?.health()) === 'healthy',
    timeoutMs,
    'api cache store healthy',
    50,
  );
}

/**
 * Composes the T11 production worker (projection sink + social routes + the
 * composite purge provider wired to a worker-owned Redis store). The worker
 * owns a separate CacheStore from the API, exactly like production (plan §5).
 */
export function composeWorker(
  scope: E2ETestScope,
  databaseUrl: string,
  redisUrl: string | null,
): { readonly worker: WorkerRuntime; readonly store: CountingCacheStore } {
  const config = buildE2EConfig(scope, 'serve', databaseUrl, redisUrl);
  const projectionDatabase = createDatabaseRuntime(databaseUrl, {
    maxConnections: 4,
    applicationName: `known-t13-worker-${scope.suffix.slice(0, 16)}`,
    connectionTimeoutMs: 5_000,
    idleTimeoutMs: 1_000,
  });
  let store: CountingCacheStore | undefined;
  const worker = buildWorker(config, projectionDatabase, new InMemoryMetrics(), {
    createCacheStore: (cfg: RedisCacheConnectionConfig) => {
      store = new CountingCacheStore(createRedisCacheStore(cfg));
      return store;
    },
  });
  assert.ok(store, 'worker cache composition must create a store in serve mode');
  return { worker, store: store! };
}

/** Bounded outbox drain: runOnce() until no claim is available. */
export async function drainOutbox(worker: WorkerRuntime, maxIterations = 200): Promise<void> {
  assert.ok(worker.outbox, 'worker must expose an outbox');
  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    const processed = await worker.outbox.runOnce();
    if (!processed) return;
  }
  throw new Error('outbox drain exceeded iteration budget; an event is stuck retrying');
}

/** Polls until no pending/retryable/leased outbox rows remain for a collection. */
export async function waitForOutboxSettled(
  pool: Pool,
  collectionId: string,
  timeoutMs = 30_000,
): Promise<void> {
  await waitUntil(
    async () => {
      const result = await pool.query<{ remaining: string }>(
        `select count(*)::text as remaining
           from outbox_events
          where aggregate_scope = $1 and state in ('pending', 'retryable', 'leased')`,
        [collectionId],
      );
      return Number(result.rows[0]?.remaining ?? '0') === 0;
    },
    timeoutMs,
    `outbox settled for collection ${collectionId}`,
    100,
  );
}

export interface PublicationFixture {
  readonly collectionId: string;
  readonly rootNodeId: string;
  readonly bookmarkNodeId: string;
  readonly slug: string;
  readonly ownerSubjectId: string;
  readonly title: string;
  readonly contentRevision: string;
  readonly resourceRevision: string;
  readonly policyRevision: string;
  readonly updatedAt: string;
}

export interface PublicationFixtureOptions {
  readonly pool: Pool;
  readonly ownerSubjectId: string;
  readonly memberSubjectId?: string;
  readonly title?: string;
  readonly summary?: string | null;
  readonly contentRevision?: string;
  readonly resourceRevision?: string;
  readonly policyRevision?: string;
  readonly updatedAt?: string;
  readonly suffix?: string;
  /** Number of public bookmark children under the root (default 1). */
  readonly childCount?: number;
}

/** Canonical 16-byte base64url id required by the social collection-change mapper. */
export function canonicalOpaqueId(): string {
  return randomBytes(16).toString('base64url');
}

/**
 * Inserts a published public collection (canonical ids) + root folder + one
 * public bookmark child. All facts the Publication read paths and the canonical
 * mutation/social mapper need are provided (plan §7.2 rule 6: the fixture is a
 * real authoritative row, never a fake loader).
 */
export async function insertPublishedCollection(
  options: PublicationFixtureOptions,
): Promise<PublicationFixture> {
  const pool = options.pool;
  const collectionId = canonicalOpaqueId();
  const rootNodeId = `t13-root-${randomUUID()}`;
  let bookmarkNodeId = `t13-bookmark-${randomUUID()}`;
  const slug = `t13-${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const title = options.title ?? `T13 collection ${collectionId.slice(0, 8)}`;
  const contentRevision = options.contentRevision ?? `t13-content-${options.suffix ?? collectionId.slice(0, 8)}`;
  const resourceRevision = options.resourceRevision ?? `t13-resource-${options.suffix ?? collectionId.slice(0, 8)}`;
  const policyRevision = options.policyRevision ?? 't13-policy-1';
  const updatedAt = options.updatedAt ?? '2026-07-24T00:00:00Z';
  const childCount = options.childCount ?? 1;

  // The canonical mutation adapter (T10 composition) requires the collection to
  // carry an authority-valid payload_json + backfill metadata; build it with the
  // production materializer so the fixture is never a fake copy of the schema.
  const materialized = materializeCollectionPayload({
    id: collectionId,
    ownerSubjectId: options.ownerSubjectId,
    title,
    summary: options.summary ?? null,
    kind: 'bookmarks',
    visibility: 'public',
    allowSearchIndexing: false,
    rootNodeId,
    resourceRevision,
    contentRevision,
    policyRevision,
    commitOrdinal: 1n,
    createdAt: new Date('2026-07-20T00:00:00Z'),
    updatedAt: new Date(updatedAt),
    deletedAt: null,
  });
  if (!materialized.ok) {
    throw new Error(`T13 fixture collection payload is invalid: ${materialized.reason}`);
  }
  const collectionPayload = { ...materialized.payload, extensions: {} };

  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('set constraints all deferred');
    const childNodeIds: string[] = [];
    for (let childIndex = 0; childIndex < childCount; childIndex += 1) {
      childNodeIds.push(`t13-bookmark-${randomUUID()}`);
    }
    const ledgerIds = [collectionId, rootNodeId, ...childNodeIds];
    await client.query(
      `insert into resource_id_ledger (resource_id, resource_type) values `
        + ledgerIds.map((_, index) => `($${index + 1}, '${index === 0 ? 'collection' : 'node'}')`).join(', '),
      ledgerIds,
    );
    await client.query(
      `insert into collections
         (id, owner_subject_id, title, summary, kind, visibility, root_node_id,
          resource_revision, content_revision, policy_revision, commit_ordinal,
          publication_slug, published_at, created_at, updated_at,
          allow_search_indexing, payload_json, payload_schema_version, payload_authority_status)
       values
         ($1, $2, $3, $4, 'bookmarks', 'public', $5,
          $6, $7, $8, 1, $9, '2026-07-20T00:00:00Z', '2026-07-20T00:00:00Z', $10,
          false, $11::jsonb, $12, 'backfilled')`,
      [
        collectionId,
        options.ownerSubjectId,
        title,
        options.summary ?? null,
        rootNodeId,
        resourceRevision,
        contentRevision,
        policyRevision,
        slug,
        updatedAt,
        JSON.stringify(collectionPayload),
        RESOURCE_PAYLOAD_SCHEMA_VERSION,
      ],
    );
    await client.query(
      `insert into nodes
         (id, collection_id, parent_id, kind, is_root, title, url, visibility,
          position_token, resource_revision, children_revision, created_at, updated_at)
       values
         ($1, $2, null, 'folder', true, $3, null, 'inherit', null, $4, $5,
          '2026-07-20T00:00:00Z', '2026-07-20T00:00:00Z')`,
      [rootNodeId, collectionId, title, resourceRevision, 't13-children-1'],
    );
    for (let childIndex = 0; childIndex < childNodeIds.length; childIndex += 1) {
      const childNodeId = childNodeIds[childIndex]!;
      await client.query(
        `insert into nodes
           (id, collection_id, parent_id, kind, is_root, title, url, visibility,
            position_token, resource_revision, children_revision, created_at, updated_at)
         values
           ($1, $2, $3, 'bookmark', false, $4, $5, 'inherit', $6, $7, $8,
            '2026-07-20T00:00:00Z', '2026-07-20T00:00:00Z')`,
        [
          childNodeId,
          collectionId,
          rootNodeId,
          `${title} bookmark`,
          'https://example.test/t13-bookmark',
          String.fromCharCode(65 + childIndex),
          resourceRevision,
          't13-children-1',
        ],
      );
      bookmarkNodeId = childNodeId;
    }
    if (options.memberSubjectId !== undefined) {
      await client.query(
        `insert into collection_members (collection_id, subject_id, role) values ($1, $2, 'viewer')`,
        [collectionId, options.memberSubjectId],
      );
    }
    await client.query('commit');
  } catch (error: unknown) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }

  return {
    collectionId,
    rootNodeId,
    bookmarkNodeId,
    slug,
    ownerSubjectId: options.ownerSubjectId,
    title,
    contentRevision,
    resourceRevision,
    policyRevision,
    updatedAt,
  };
}

export interface BrowserClient {
  readonly cookie: string;
  readonly csrfToken: string;
  /** The real accounts.subject_id minted by the Better Auth factory (opaque local id). */
  readonly subjectId: string;
}

/**
 * E1: real authenticated browser client through the Better Auth test factory
 * (plan §11 E1; T13 §6.4 keeps real auth — never fake the middleware). The
 * session mints REAL BA rows + a signed `__Host-known_session` cookie and is
 * validated by the REAL authority on the composed app; the first login also
 * creates the account + profile rows the canonical mutation's social
 * collection-change mapper requires.
 */
export async function loginBrowser(
  composed: ComposedApi,
  subject: string,
): Promise<BrowserClient> {
  // E1: the session is minted by the Better Auth test factory (real BA rows +
  // signed cookie) and validated by the REAL authority on the composed app.
  const client = await composed.factory.issueTestSession({
    subject,
    displayName: `T13 ${subject}`,
    handle: `e2e_${randomUUID().replaceAll('-', '').slice(0, 12)}`,
  });
  return { cookie: client.cookie, csrfToken: client.csrfToken, subjectId: client.subjectId };
}

/** Strong collection ETag the PATCH route accepts: quoted resource revision. */
export function strongEtag(revision: string): string {
  return `"${revision}"`;
}

/** Reads the current resource_revision of a collection from PostgreSQL. */
export async function currentResourceRevision(
  pool: Pool,
  collectionId: string,
): Promise<string> {
  const result = await pool.query<{ resource_revision: string }>(
    `select resource_revision from collections where id = $1`,
    [collectionId],
  );
  assert.equal(result.rowCount, 1);
  return result.rows[0]!.resource_revision;
}

export function mutationHeaders(
  client: BrowserClient,
  commandId: string,
  mediaType = 'application/json',
): Record<string, string> {
  return {
    cookie: client.cookie,
    origin: E2E_ORIGIN,
    'x-csrf-token': client.csrfToken,
    'known-command-id': commandId,
    'content-type': mediaType,
  };
}

export function signal(): AbortSignal {
  return new AbortController().signal;
}

/** Restores the redis-server process inside the keep-alive container. */
export async function restoreRedisServer(container: StartedTestContainer): Promise<void> {
  const restore = await container.exec(['redis-server', '--daemonize', 'yes']);
  if (restore.exitCode !== 0) {
    throw new Error(`redis-server restart failed (exit ${restore.exitCode}): ${restore.output}`);
  }
}



