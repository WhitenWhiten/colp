/**
 * P6 end-to-end harness (library collection bookmark-count plan §5.2 / §7 P6 /
 * §8.1 E2E). Dedicated composition so publication Redis e2e flags stay
 * untouched: serve/shadow set CACHE_COLLECTION_BOOKMARK_COUNT_ENABLED and
 * wire `composeCollectionBookmarkCountLookup` like production api.ts.
 *
 * Isolation: random REDIS_KEY_PREFIX per scope, exclusive Testcontainers Redis
 * (never process.env.REDIS_URL), no FLUSHALL/FLUSHDB.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import {
  composeCollectionBookmarkCountLookup,
  createApiCacheComposition,
  type ApiCacheComposition,
} from '../../src/bootstrap/cache-composition.js';
import { loadConfig, type AppConfig } from './test-config.js';
import {
  buildCollectionBookmarkCountCacheDataKey,
  createRedisCacheStore,
  type RedisCacheConnectionConfig,
} from '../../src/infrastructure/cache/index.js';
import {
  createPostgresCanonicalMutationUnitOfWork,
  createPostgresCollectionBookmarkCountReadPort,
  createPostgresCollectionsUnitOfWork,
  createPostgresOwnedCollectionsReadPort,
} from '../../src/infrastructure/collections/index.js';
import { createPostgresIdentityUnitOfWork } from '../../src/infrastructure/identity/index.js';
import { InMemoryMetrics, type Metrics } from '../../src/infrastructure/telemetry/index.js';
import {
  createProductOwnedCollectionsCursorSigner,
  materializeCollectionPayload,
  RESOURCE_PAYLOAD_SCHEMA_VERSION,
  type CollectionBookmarkCountReadPort,
} from '../../src/modules/collections/index.js';
import type { DatabaseRuntime } from '../../src/infrastructure/database/index.js';
import { buildApiApp } from '../../src/transport/app.js';
import {
  createPostgresBetterAuthTestFactory,
  type PostgresBetterAuthTestFactory,
} from './better-auth-test-factory.js';
import {
  canonicalOpaqueId,
  CountingCacheStore,
  E2E_ORIGIN,
  newE2ETestScope,
  waitUntil,
  type CacheOperationCounts,
  type E2ECacheMode,
  type E2ETestScope,
} from './redis-cache-e2e.js';

/** Matches `createApiCacheComposition({ environment })` in this harness. */
export const BOOKMARK_COUNT_CACHE_ENVIRONMENT = 'test';

export function newBookmarkCountE2EScope(): E2ETestScope {
  const scope = newE2ETestScope();
  const suffix = scope.suffix;
  return {
    suffix,
    keyPrefix: `p6-${suffix.slice(0, 24)}`,
    ownerSubject: `p6-owner-${suffix.slice(0, 12)}`,
    memberSubject: `p6-member-${suffix.slice(0, 12)}`,
  };
}

export class RecordingCacheStore extends CountingCacheStore {
  readonly getKeys: string[] = [];

  override get(key: string, signal: AbortSignal): Promise<string | null> {
    this.getKeys.push(key);
    return super.get(key, signal);
  }

  override reset(): void {
    super.reset();
    this.getKeys.length = 0;
  }
}

export class CountingBookmarkCountOrigin implements CollectionBookmarkCountReadPort {
  calls = 0;
  ids: string[][] = [];

  constructor(readonly inner: CollectionBookmarkCountReadPort) {}

  async countBookmarks(collectionIds: readonly string[]): Promise<ReadonlyMap<string, number>> {
    this.calls += 1;
    this.ids.push([...collectionIds]);
    return this.inner.countBookmarks(collectionIds);
  }

  reset(): void {
    this.calls = 0;
    this.ids = [];
  }
}

export function buildBookmarkCountE2EConfig(
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
    PRODUCT_EDITOR_CURSOR_HMAC_KEY: 'p6-editor-cursor-key',
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    KNOWN_CACHE_MODE: mode,
    REDIS_URL: redisUrl ?? '',
    REDIS_KEY_PREFIX: scope.keyPrefix,
    REDIS_COMMAND_TIMEOUT_MS: '200',
    REDIS_CONNECT_TIMEOUT_MS: '2000',
    REDIS_MAX_RETRIES_PER_REQUEST: '1',
    CACHE_COLLECTION_BOOKMARK_COUNT_ENABLED: 'true',
  });
}

export interface BookmarkCountComposedApi {
  readonly mode: E2ECacheMode;
  readonly app: FastifyInstance;
  readonly factory: PostgresBetterAuthTestFactory;
  readonly cacheComposition: ApiCacheComposition;
  readonly store: RecordingCacheStore | undefined;
  readonly origin: CountingBookmarkCountOrigin;
  readonly metrics: Metrics;
  readonly scope: E2ETestScope;
  resetMeasured(): void;
  close(): Promise<void>;
}

export interface BookmarkCountApiContext {
  readonly databaseUrl: string;
  readonly runtime: DatabaseRuntime;
  readonly redisUrl: string | null;
}

export function composeBookmarkCountApi(
  scope: E2ETestScope,
  mode: E2ECacheMode,
  ctx: BookmarkCountApiContext,
): BookmarkCountComposedApi {
  const config = buildBookmarkCountE2EConfig(scope, mode, ctx.databaseUrl, ctx.redisUrl);
  const runtime = ctx.runtime;
  const metrics = new InMemoryMetrics();
  const origin = new CountingBookmarkCountOrigin(
    createPostgresCollectionBookmarkCountReadPort(runtime.db),
  );

  let store: RecordingCacheStore | undefined;
  const cacheComposition = createApiCacheComposition({
    config: config.cache,
    metrics,
    environment: BOOKMARK_COUNT_CACHE_ENVIRONMENT,
    createStore: (cfg: RedisCacheConnectionConfig) => {
      store = new RecordingCacheStore(createRedisCacheStore(cfg));
      return store;
    },
  });
  const bookmarkCounts = composeCollectionBookmarkCountLookup(cacheComposition, origin, metrics);

  const ownedCollectionCursors = createProductOwnedCollectionsCursorSigner({
    current: {
      id: `owned-p6-${scope.suffix.slice(0, 12)}`,
      key: 'owned-p6-cursor-secret-material-32-bytes',
    },
  });
  const factory = createPostgresBetterAuthTestFactory({ db: runtime.db });
  const app = buildApiApp({
    config,
    readiness: runtime,
    browserSessionAuthority: factory.authority,
    identityUnitOfWork: createPostgresIdentityUnitOfWork(runtime.db, {
      oidcTransactionSecrets: config.oidcTransactionSecrets,
    }),
    collectionsUnitOfWork: createPostgresCollectionsUnitOfWork(runtime.db),
    productCollectionMutationUnitOfWork: createPostgresCanonicalMutationUnitOfWork(runtime.db),
    ownedCollectionsQuery: {
      reads: createPostgresOwnedCollectionsReadPort(runtime.db),
      cursors: ownedCollectionCursors,
      clock: { now: async () => new Date() },
    },
    bookmarkCounts,
    metrics,
    cacheReadiness: () => cacheComposition.readiness(),
    cacheCapabilityReadiness: () => cacheComposition.capabilityReadiness(),
  });

  return {
    mode,
    app,
    factory,
    cacheComposition,
    store,
    origin,
    metrics,
    scope,
    resetMeasured() {
      origin.reset();
      store?.reset();
    },
    async close() {
      await app.close();
      await cacheComposition.close();
      ownedCollectionCursors.destroy();
    },
  };
}

export async function waitForBookmarkCountCacheHealth(
  composed: BookmarkCountComposedApi,
  timeoutMs = 15_000,
): Promise<void> {
  assert.ok(composed.store, 'serve/shadow composition must own a Redis store');
  await waitUntil(
    async () => (await composed.store?.health()) === 'healthy',
    timeoutMs,
    'bookmark-count cache store healthy',
    50,
  );
}

export interface BrowserClient {
  readonly cookie: string;
  readonly csrfToken: string;
  readonly subjectId: string;
}

export async function loginBookmarkCountBrowser(
  composed: BookmarkCountComposedApi,
  subject: string,
): Promise<BrowserClient> {
  const client = await composed.factory.issueTestSession({
    subject,
    displayName: `P6 ${subject}`,
    handle: `p6_${randomUUID().replaceAll('-', '').slice(0, 12)}`,
    email: `${subject}@example.test`,
  });
  return { cookie: client.cookie, csrfToken: client.csrfToken, subjectId: client.subjectId };
}

export interface OwnedListItem {
  readonly collection: {
    readonly id: string;
    readonly contentRevision: string;
    readonly title: string;
  };
  readonly bookmarkCount: number;
}

export interface OwnedListDocument {
  readonly items: readonly OwnedListItem[];
  readonly page: {
    readonly returnedCount: number;
    readonly hasMore: boolean;
    readonly nextCursor: string | null;
  };
}

export interface ListResponse {
  readonly statusCode: number;
  readonly cacheControl: string | undefined;
  readonly body: unknown;
}

export async function listOwnedCollections(
  composed: BookmarkCountComposedApi,
  cookie?: string,
): Promise<ListResponse> {
  const response = await composed.app.inject({
    method: 'GET',
    url: '/api/v1/collections',
    headers: cookie === undefined
      ? { accept: 'application/json' }
      : { cookie, accept: 'application/json' },
  });
  const cacheControl = response.headers['cache-control'];
  return {
    statusCode: response.statusCode,
    cacheControl: typeof cacheControl === 'string' ? cacheControl : undefined,
    body: response.json(),
  };
}

export function asOwnedList(body: unknown): OwnedListDocument {
  assert.ok(body !== null && typeof body === 'object', 'list body must be an object');
  const document = body as OwnedListDocument;
  assert.ok(Array.isArray(document.items), 'list body must include items');
  return document;
}

export function mutationHeaders(
  client: BrowserClient,
  commandId: string,
): Record<string, string> {
  return {
    cookie: client.cookie,
    origin: E2E_ORIGIN,
    'x-csrf-token': client.csrfToken,
    'known-command-id': commandId,
    'content-type': 'application/json',
  };
}

export async function createOwnedCollectionHttp(
  composed: BookmarkCountComposedApi,
  client: BrowserClient,
  title: string,
): Promise<{ readonly id: string; readonly rootId: string; readonly contentRevision: string }> {
  const created = await composed.app.inject({
    method: 'POST',
    url: '/api/v1/collections',
    headers: mutationHeaders(client, randomUUID()),
    payload: { kind: 'bookmarks', title, summary: null },
  });
  assert.equal(created.statusCode, 201, created.payload);
  const body = created.json() as {
    collection: { id: string; contentRevision: string };
    root: { id: string };
  };
  return {
    id: body.collection.id,
    rootId: body.root.id,
    contentRevision: body.collection.contentRevision,
  };
}

export async function createBookmarkHttp(
  composed: BookmarkCountComposedApi,
  client: BrowserClient,
  collectionId: string,
  parentId: string,
  title: string,
  url: string,
): Promise<void> {
  const created = await composed.app.inject({
    method: 'POST',
    url: `/api/v1/collections/${collectionId}/nodes`,
    headers: mutationHeaders(client, randomUUID()),
    payload: {
      parentId,
      afterId: null,
      beforeId: null,
      node: {
        kind: 'bookmark',
        title,
        url,
        description: null,
        tags: [],
        visibility: 'inherit',
      },
    },
  });
  assert.equal(created.statusCode, 201, created.payload);
}

export async function currentContentRevision(
  pool: Pool,
  collectionId: string,
): Promise<string> {
  const result = await pool.query<{ content_revision: string }>(
    `select content_revision from collections where id = $1`,
    [collectionId],
  );
  assert.equal(result.rowCount, 1);
  return result.rows[0]!.content_revision;
}

export function bookmarkCountCacheDataKey(
  scope: E2ETestScope,
  collectionId: string,
  contentRevision: string,
): string {
  return buildCollectionBookmarkCountCacheDataKey({
    collectionId,
    query: { contentRevision },
    environment: BOOKMARK_COUNT_CACHE_ENVIRONMENT,
    keyPrefix: scope.keyPrefix,
  });
}

export function bookmarkCountsById(body: OwnedListDocument): Map<string, number> {
  return new Map(body.items.map((item) => [item.collection.id, item.bookmarkCount]));
}

export function itemFor(body: OwnedListDocument, collectionId: string): OwnedListItem {
  const item = body.items.find((row) => row.collection.id === collectionId);
  assert.ok(item, `list must include collection ${collectionId}`);
  return item;
}

export function redisCommandTotal(counts: CacheOperationCounts): number {
  return counts.get + counts.set + counts.setIfAbsent + counts.releaseIfOwner
    + counts.rotateEpoch + counts.health;
}

export interface NestedOwnedFixture {
  readonly collectionId: string;
  readonly rootNodeId: string;
  readonly folderNodeId: string;
  readonly contentRevision: string;
  readonly bookmarkCount: 5;
}

export interface EmptyOwnedFixture {
  readonly collectionId: string;
  readonly rootNodeId: string;
  readonly contentRevision: string;
}

/**
 * 2 root bookmarks + folder with 3 nested bookmarks (plan §8.2 / §8.4).
 * Collection payload is materialized so a later Product node-create mutation
 * can bump contentRevision on the same row.
 */
export async function insertOwnedNestedBookmarkCollection(
  pool: Pool,
  ownerSubjectId: string,
  title = 'P6 nested bookmarks',
): Promise<NestedOwnedFixture> {
  const collectionId = canonicalOpaqueId();
  const rootNodeId = canonicalOpaqueId();
  const folderNodeId = canonicalOpaqueId();
  const contentRevision = canonicalOpaqueId();
  const resourceRevision = canonicalOpaqueId();
  const policyRevision = canonicalOpaqueId();
  const createdAt = new Date('2026-08-19T00:00:00Z');
  const updatedAt = new Date('2026-08-19T00:00:05Z');

  const materialized = materializeCollectionPayload({
    id: collectionId,
    ownerSubjectId,
    title,
    summary: null,
    kind: 'bookmarks',
    visibility: 'private',
    allowSearchIndexing: false,
    rootNodeId,
    resourceRevision,
    contentRevision,
    policyRevision,
    commitOrdinal: 1n,
    createdAt,
    updatedAt,
    deletedAt: null,
  });
  if (!materialized.ok) {
    throw new Error(`P6 nested collection payload is invalid: ${materialized.reason}`);
  }
  const collectionPayload = { ...materialized.payload, extensions: {} };

  const rootBookmarks = [
    { id: canonicalOpaqueId(), title: 'Root one', url: 'https://example.test/p6/n1', token: 'A' },
    { id: canonicalOpaqueId(), title: 'Root two', url: 'https://example.test/p6/n2', token: 'B' },
  ];
  const nestedBookmarks = [
    { id: canonicalOpaqueId(), title: 'Nested one', url: 'https://example.test/p6/n3', token: 'A' },
    { id: canonicalOpaqueId(), title: 'Nested two', url: 'https://example.test/p6/n4', token: 'B' },
    { id: canonicalOpaqueId(), title: 'Nested three', url: 'https://example.test/p6/n5', token: 'C' },
  ];
  const nodeIds = [
    rootNodeId,
    folderNodeId,
    ...rootBookmarks.map((row) => row.id),
    ...nestedBookmarks.map((row) => row.id),
  ];

  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('set constraints all deferred');
    const ledgerIds = [collectionId, ...nodeIds];
    await client.query(
      `insert into resource_id_ledger (resource_id, resource_type) values `
        + ledgerIds.map((_, index) => `($${index + 1}, '${index === 0 ? 'collection' : 'node'}')`).join(', '),
      ledgerIds,
    );
    await client.query(
      `insert into collections
         (id, owner_subject_id, title, summary, kind, visibility, root_node_id,
          resource_revision, content_revision, policy_revision, commit_ordinal,
          created_at, updated_at, allow_search_indexing,
          payload_json, payload_schema_version, payload_authority_status)
       values
         ($1, $2, $3, null, 'bookmarks', 'private', $4,
          $5, $6, $7, 1, $8, $9, false, $10::jsonb, $11, 'backfilled')`,
      [
        collectionId, ownerSubjectId, title, rootNodeId,
        resourceRevision, contentRevision, policyRevision,
        createdAt.toISOString(), updatedAt.toISOString(),
        JSON.stringify(collectionPayload), RESOURCE_PAYLOAD_SCHEMA_VERSION,
      ],
    );
    await client.query(
      `insert into nodes
         (id, collection_id, parent_id, kind, is_root, title, url, visibility,
          position_token, resource_revision, children_revision, created_at, updated_at)
       values
         ($1, $2, null, 'folder', true, $3, null, 'inherit', null, $4, $5, $6, $7)`,
      [
        rootNodeId, collectionId, title, resourceRevision, contentRevision,
        createdAt.toISOString(), updatedAt.toISOString(),
      ],
    );
    await insertChildNode(client, {
      id: folderNodeId, collectionId, parentId: rootNodeId, kind: 'folder',
      title: 'Child folder', url: null, positionToken: 'C', resourceRevision,
    });
    for (const bookmark of rootBookmarks) {
      await insertChildNode(client, {
        id: bookmark.id, collectionId, parentId: rootNodeId, kind: 'bookmark',
        title: bookmark.title, url: bookmark.url, positionToken: bookmark.token, resourceRevision,
      });
    }
    for (const bookmark of nestedBookmarks) {
      await insertChildNode(client, {
        id: bookmark.id, collectionId, parentId: folderNodeId, kind: 'bookmark',
        title: bookmark.title, url: bookmark.url, positionToken: bookmark.token, resourceRevision,
      });
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
    folderNodeId,
    contentRevision,
    bookmarkCount: 5,
  };
}

export async function insertOwnedEmptyCollection(
  pool: Pool,
  ownerSubjectId: string,
  title = 'P6 empty collection',
): Promise<EmptyOwnedFixture> {
  const collectionId = canonicalOpaqueId();
  const rootNodeId = canonicalOpaqueId();
  const contentRevision = canonicalOpaqueId();
  const resourceRevision = canonicalOpaqueId();
  const policyRevision = canonicalOpaqueId();
  const createdAt = new Date('2026-08-19T00:00:00Z');
  const updatedAt = new Date('2026-08-19T00:00:01Z');

  const materialized = materializeCollectionPayload({
    id: collectionId,
    ownerSubjectId,
    title,
    summary: null,
    kind: 'bookmarks',
    visibility: 'private',
    allowSearchIndexing: false,
    rootNodeId,
    resourceRevision,
    contentRevision,
    policyRevision,
    commitOrdinal: 1n,
    createdAt,
    updatedAt,
    deletedAt: null,
  });
  if (!materialized.ok) {
    throw new Error(`P6 empty collection payload is invalid: ${materialized.reason}`);
  }

  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('set constraints all deferred');
    await client.query(
      `insert into resource_id_ledger (resource_id, resource_type) values ($1, 'collection'), ($2, 'node')`,
      [collectionId, rootNodeId],
    );
    await client.query(
      `insert into collections
         (id, owner_subject_id, title, summary, kind, visibility, root_node_id,
          resource_revision, content_revision, policy_revision, commit_ordinal,
          created_at, updated_at, allow_search_indexing,
          payload_json, payload_schema_version, payload_authority_status)
       values
         ($1, $2, $3, null, 'bookmarks', 'private', $4,
          $5, $6, $7, 1, $8, $9, false, $10::jsonb, $11, 'backfilled')`,
      [
        collectionId, ownerSubjectId, title, rootNodeId,
        resourceRevision, contentRevision, policyRevision,
        createdAt.toISOString(), updatedAt.toISOString(),
        JSON.stringify({ ...materialized.payload, extensions: {} }),
        RESOURCE_PAYLOAD_SCHEMA_VERSION,
      ],
    );
    await client.query(
      `insert into nodes
         (id, collection_id, parent_id, kind, is_root, title, url, visibility,
          position_token, resource_revision, children_revision, created_at, updated_at)
       values
         ($1, $2, null, 'folder', true, $3, null, 'inherit', null, $4, $5, $6, $7)`,
      [
        rootNodeId, collectionId, title, resourceRevision, contentRevision,
        createdAt.toISOString(), updatedAt.toISOString(),
      ],
    );
    await client.query('commit');
  } catch (error: unknown) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }

  return { collectionId, rootNodeId, contentRevision };
}

export async function insertCollectionMember(
  pool: Pool,
  collectionId: string,
  subjectId: string,
  role: 'editor' | 'viewer' = 'viewer',
): Promise<void> {
  await pool.query(
    `insert into collection_members (collection_id, subject_id, role, granted_at)
     values ($1, $2, $3, now())`,
    [collectionId, subjectId, role],
  );
}

async function insertChildNode(
  client: { query: (sqlText: string, values?: readonly unknown[]) => Promise<unknown> },
  input: {
    readonly id: string;
    readonly collectionId: string;
    readonly parentId: string;
    readonly kind: 'folder' | 'bookmark';
    readonly title: string;
    readonly url: string | null;
    readonly positionToken: string;
    readonly resourceRevision: string;
  },
): Promise<void> {
  await client.query(
    `insert into nodes
      (id, collection_id, parent_id, kind, is_root, title, url, visibility, position_token,
       resource_revision, children_revision, created_at, updated_at)
     values ($1, $2, $3, $4, false, $5, $6, 'inherit', $7, $8, $8,
       '2026-08-19T00:00:00Z', '2026-08-19T00:00:00Z')`,
    [
      input.id, input.collectionId, input.parentId, input.kind, input.title,
      input.url, input.positionToken, input.resourceRevision,
    ],
  );
}
