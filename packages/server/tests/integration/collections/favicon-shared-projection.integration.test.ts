import { KNOWN_FAVICON_DOMAINS } from '../../../src/modules/collections/index.js';
import { isFaviconPubliclyAccessible } from '../../../src/infrastructure/database/publication-object-controls.js';
/**
 * Shared-cache projection and deferred provider admission for the online
 * favicon chain. Split from favicon-online-lifecycle so that suite stays
 * inside its granularity ceiling.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { deflateSync } from 'node:zlib';
import { afterAll, beforeAll, test } from 'vitest';
import { loadConfig } from '../../support/test-config.js';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import { createPostgresIdentityUnitOfWork } from '../../../src/infrastructure/identity/index.js';
import {
  createPostgresCollectionsUnitOfWork,
  createPostgresCanonicalMutationUnitOfWork,
  createPostgresFaviconJobWorkerRepository,
  createPostgresFaviconJobWorkerUnitOfWork,
} from '../../../src/infrastructure/collections/index.js';
import { findBookmarkIconObjectIdsByNodeIds } from '../../../src/infrastructure/collections/bookmark-icon-postgres.js';
import { SharedFaviconCache } from '../../../src/infrastructure/collections/favicon-shared-cache.js';
import { FaviconFetchDeferred } from '../../../src/modules/collections/application/favicon-fetch-deferred.js';
import { faviconCrc32 } from '../../../src/modules/collections/application/favicon-image-decode.js';
import {
  processFaviconRefreshClaim,
  type FaviconRefreshExecutionPorts,
} from '../../../src/modules/collections/index.js';
import { buildApiApp } from '../../../src/transport/app.js';
import { issueTestSession, createPostgresBetterAuthTestFactory } from '../../support/better-auth-test-factory.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';

const ORIGIN = 'https://app.example.test';
const ISSUER = 'https://issuer.example.test/realms/known';
const DEFAULT_TEMPLATE = 'https://favicone.com/{hostname}';
const REVISION_PATTERN = /^[1-9][0-9]{0,18}$/u;
const OBJECT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const COLLECTION = 'fosp-private-collection-0001';
const ROOT = 'fosp-private-root-00000001';
const BOOKMARK = 'fosp-private-bookmark-0001';

function buildPng(width: number, height: number): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8;
  ihdrData[9] = 2;
  const scanlines = Buffer.alloc(height * (1 + width * 3));
  const idat = deflateSync(scanlines);
  const chunk = (type: string, data: Buffer): Buffer => {
    const out = Buffer.alloc(8 + data.byteLength + 4);
    out.writeUInt32BE(data.byteLength, 0);
    out.write(type, 4, 'ascii');
    data.copy(out, 8);
    out.writeUInt32BE(faviconCrc32(Buffer.concat([out.subarray(4, 8), data])), 8 + data.byteLength);
    return out;
  };
  return Buffer.concat([signature, chunk('IHDR', ihdrData), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

const PNG_V1 = buildPng(2, 2);
const PNG_V2 = buildPng(1, 1);

interface Store {
  readonly objects: Map<string, { contentType: string; body: Buffer }>;
  put(objectId: string, body: Buffer, contentType: string): Promise<void>;
  get(objectId: string): Promise<{ contentType: string; body: Buffer } | null>;
  delete(objectId: string): Promise<void>;
}

function createTestFaviconStore(): Store {
  const objects = new Map<string, { contentType: string; body: Buffer }>();
  return {
    objects,
    async put(objectId, body, contentType) {
      objects.set(objectId, { contentType, body: Buffer.from(body) });
    },
    async get(objectId) {
      const row = objects.get(objectId);
      return row === undefined ? null : { contentType: row.contentType, body: Buffer.from(row.body) };
    },
    async delete(objectId) {
      objects.delete(objectId);
    },
  };
}

interface ApiResponse {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly json: unknown;
  readonly rawBody: Buffer;
}

function api(method: string, url: string, options: {
  readonly cookie?: string;
  readonly csrf?: string;
  readonly commandId?: string;
  readonly ifMatch?: string;
  readonly body?: unknown;
  readonly contentType?: string;
  readonly rawBody?: Buffer;
}): Promise<ApiResponse> {
  const headers: Record<string, string> = {};
  if (options.cookie !== undefined) headers.Cookie = options.cookie;
  if (options.csrf !== undefined) {
    headers.Origin = ORIGIN;
    headers['X-CSRF-Token'] = options.csrf;
  }
  if (options.commandId !== undefined) headers['Known-Command-Id'] = options.commandId;
  if (options.ifMatch !== undefined) headers['If-Match'] = options.ifMatch;
  let body: Buffer | string | undefined;
  if (options.rawBody !== undefined) {
    body = options.rawBody;
    headers['Content-Type'] = options.contentType ?? 'application/json';
  } else if (options.body !== undefined) {
    body = JSON.stringify(options.body);
    headers['Content-Type'] = 'application/json';
  }
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { method, headers, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        const rawBody = Buffer.concat(chunks);
        const text = rawBody.toString('utf8');
        let json: unknown = null;
        if (text.length > 0) {
          try { json = JSON.parse(text) as unknown; } catch { json = text; }
        }
        resolve({ status: res.statusCode ?? 0, headers: res.headers as Record<string, string>, json, rawBody });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

function assertIconSource(value: unknown): { iconVersion: string | null; status: string; directUrl: string | null } {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value));
  const body = value as Record<string, unknown>;
  assert.deepEqual(Object.keys(body).sort(), [
    'collectionId', 'directUrl', 'effectiveMode', 'iconUrl', 'iconVersion', 'nodeId',
    'policyRevision', 'restorable', 'revision', 'sourceMode', 'status', 'updatedAt',
  ]);
  assert.match(body.revision as string, REVISION_PATTERN);
  assert.match(body.policyRevision as string, REVISION_PATTERN);
  assert.match(body.updatedAt as string, TIMESTAMP_PATTERN);
  return {
    iconVersion: body.iconVersion as string | null,
    status: body.status as string,
    directUrl: body.directUrl as string | null,
  };
}

function assertIconJobAccepted(value: unknown): { jobId: string } {
  assert.ok(value !== null && typeof value === 'object');
  const jobId = (value as { jobId?: unknown }).jobId;
  assert.equal(typeof jobId, 'string');
  assert.match(jobId as string, OBJECT_ID_PATTERN);
  return { jobId: jobId as string };
}

describeWithPostgres('shared favicon projection on the online lifecycle', () => {
  let isolated: IsolatedPostgresRuntime;
  let owner: { cookie: string; csrfToken: string; subjectId: string };
  let config: ReturnType<typeof loadConfig>;
  let sessionAuthority: ReturnType<typeof createPostgresBetterAuthTestFactory>['authority'];

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('fosp_favicon_projection', { maxConnections: 8 });
    await runMigrations(isolated.runtime.db, 'latest');
    config = loadConfig({
      DATABASE_URL: isolated.databaseUrl,
      PRODUCT_ORIGIN: ORIGIN,
      ALLOWED_ORIGINS: ORIGIN,
      OIDC_ISSUER: ISSUER,
      OIDC_CLIENT_ID: 'known-web',
      OIDC_REDIRECT_URI: `${ORIGIN}/api/v1/auth/oidc/callback`,
      OIDC_AUTHORIZATION_ENDPOINT: `${ISSUER}/auth`,
      OIDC_TOKEN_ENDPOINT: `${ISSUER}/token`,
      OIDC_ALLOW_TEST_PROVIDER: 'true',
      OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default',
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      KNOWN_FEATURE_FAVICON_POLICY: 'true',
      FAVICON_CURSOR_HMAC_KEY: Buffer.alloc(32, 42).toString('base64url'),
    });
    const factory = createPostgresBetterAuthTestFactory({ db: isolated.runtime.db });
    sessionAuthority = factory.authority;
    owner = await issueTestSession({
      factory,
      subject: `fosp-owner-${randomUUID()}`,
      handle: `fosp${randomUUID().replaceAll('-', '').slice(0, 12)}`,
    });
    const client = await isolated.runtime.pool.connect();
    try {
      await client.query('begin');
      await client.query('set constraints all deferred');
      await client.query(
        `insert into resource_id_ledger(resource_id, resource_type)
         values ($1, 'collection'), ($2, 'node'), ($3, 'node')`,
        [COLLECTION, ROOT, BOOKMARK],
      );
      await client.query(
        `insert into collections (
           id, owner_subject_id, title, kind, visibility, root_node_id, resource_revision,
           content_revision, policy_revision, commit_ordinal, created_at, updated_at
         ) values ($1, $2, 'FOSP fixture', 'bookmarks', 'private', $3, 'coll-res-1',
                   'coll-content-1', 'coll-policy-1', 1, now(), now())`,
        [COLLECTION, owner.subjectId, ROOT],
      );
      await client.query(
        `insert into nodes (
           id, collection_id, parent_id, kind, is_root, title, url, position_token,
           resource_revision, children_revision, created_at, updated_at
         ) values ($1, $2, null, 'folder', true, 'Root', null, null,
                   'root-res-1', 'root-ch-1', now(), now())`,
        [ROOT, COLLECTION],
      );
      await client.query(
        `insert into nodes (
           id, collection_id, parent_id, kind, is_root, title, url, position_token,
           resource_revision, children_revision, created_at, updated_at
         ) values ($1, $2, $3, 'bookmark', false, 'FOSP bookmark', 'https://bookmarks.example.org/fosp', 'B1',
                   'fosp-res-1', 'bm-ch-1', now(), now())`,
        [BOOKMARK, COLLECTION, ROOT],
      );
      await client.query(
        `insert into collection_members(collection_id, subject_id, role, granted_at)
         values ($1, $2, 'owner', now())`,
        [COLLECTION, owner.subjectId],
      );
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }, 180_000);

  afterAll(async () => isolated?.close());

  function buildApp(store?: Store) {
    return buildApiApp({
      config,
      identityUnitOfWork: createPostgresIdentityUnitOfWork(isolated.runtime.db),
      collectionsUnitOfWork: createPostgresCollectionsUnitOfWork(isolated.runtime.db),
      productCollectionMutationUnitOfWork: createPostgresCanonicalMutationUnitOfWork(
        isolated.runtime.db, { productOrigin: ORIGIN }),
      browserSessionAuthority: sessionAuthority,
      faviconPublicAccess: { isPubliclyAccessible: objectId => isFaviconPubliclyAccessible(isolated.runtime.db, objectId, KNOWN_FAVICON_DOMAINS) },
      faviconStore: store ?? createTestFaviconStore(),
    });
  }

  async function reseed(nodeId: string, url: string): Promise<void> {
    await isolated.runtime.pool.query(
      `insert into resource_id_ledger(resource_id, resource_type) values ($1, 'node') on conflict do nothing`,
      [nodeId],
    );
    await isolated.runtime.pool.query(
      `insert into nodes (
         id, collection_id, parent_id, kind, is_root, title, url, position_token,
         resource_revision, children_revision, created_at, updated_at
       ) values ($1, $2, $3, 'bookmark', false, 'FOSP node', $4, $1,
                $1, 'bm-ch-1', now(), now())`,
      [nodeId, COLLECTION, ROOT, url],
    );
  }

  async function setOnline(address: string, nodeId: string) {
    const current = await api('GET', `${address}/api/v1/collections/${COLLECTION}/nodes/${nodeId}/favicon-source`,
      { cookie: owner.cookie });
    assert.equal(current.status, 200);
    return api('PUT', `${address}/api/v1/collections/${COLLECTION}/nodes/${nodeId}/favicon-source`, {
      cookie: owner.cookie, csrf: owner.csrfToken, commandId: randomUUID(),
      ifMatch: `${current.headers.etag ?? ''}`,
      body: { sourceMode: 'online' },
    });
  }

  function executionPorts(store: Store): FaviconRefreshExecutionPorts {
    return {
      verify: createPostgresFaviconJobWorkerUnitOfWork(isolated.runtime.db),
      worker: createPostgresFaviconJobWorkerRepository(isolated.runtime.pool).worker,
      fetcher: async () => { throw new Error('test fetcher must be overridden'); },
      store,
      clock: { now: async () => new Date() },
      now: () => new Date(),
      options: {
        maxAttempts: 5,
        backoffSeconds: [1, 2, 4, 8, 16],
        retentionSeconds: 31_536_000,
        maxBytes: 65_536,
        maxDecompressedBytes: 65_536 * 64,
        fetchTimeoutMs: 10_000,
        maxRedirects: 3,
      },
    };
  }

  test('shared Google icon projects immediately, respects uploads/none and never uses the user provider', async () => {
    const store = createTestFaviconStore();
    const app = buildApp(store);
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const first = 'fo-shared-google-1';
    const second = 'fo-shared-google-2';
    const objectId = randomUUID();
    try {
      await store.put(objectId, PNG_V1, 'image/png');
      await isolated.runtime.pool.query(`INSERT INTO favicon_shared_domains(hostname, object_id)
        VALUES ('google.com', $1) ON CONFLICT(hostname) DO UPDATE SET object_id=$1`, [objectId]);
      for (const node of [first, second]) {
        await reseed(node, 'https://www.google.com/search?q=private');
        const selected = await setOnline(address, node);
        assert.equal(selected.status, 200);
        const view = assertIconSource(selected.json);
        assert.equal(view.iconVersion, objectId);
        assert.equal(view.status, 'ready');
        assert.equal(view.directUrl, null);
      }
      const projected = await findBookmarkIconObjectIdsByNodeIds(isolated.runtime.db, [first, second]);
      assert.equal(projected.get(first), objectId);
      assert.equal(projected.get(second), objectId);
      // Shared allowlisted site logos remain public independently of private bookmark URLs.
      assert.equal(await isFaviconPubliclyAccessible(isolated.runtime.db, objectId), false);
      const deniedObjectId = randomUUID();
      await store.put(deniedObjectId, PNG_V1, 'image/png');
      await isolated.runtime.pool.query(`INSERT INTO favicon_shared_domains(hostname, object_id)
        VALUES ('private.internal', $1)`, [deniedObjectId]);
      const deniedBytes = await api('GET', `${address}/api/v1/favicon/${deniedObjectId}`, {});
      assert.equal(deniedBytes.status, 404);
      const bytes = await api('GET', `${address}/api/v1/favicon/${objectId}`, {});
      assert.equal(bytes.status, 200);
      assert.deepEqual(bytes.rawBody, PNG_V1);

      const source = await api('GET', `${address}/api/v1/collections/${COLLECTION}/nodes/${first}/favicon-source`,
        { cookie: owner.cookie });
      const accepted = assertIconJobAccepted((await api('POST', `${address}/api/v1/collections/${COLLECTION}/nodes/${first}/favicon-refresh`, {
        cookie: owner.cookie, csrf: owner.csrfToken, commandId: randomUUID(),
        ifMatch: `${source.headers.etag ?? ''}`,
      })).json);
      const repo = createPostgresFaviconJobWorkerRepository(isolated.runtime.pool);
      const claims = await repo.claimDue({ limit: 100, leaseOwner: 'shared-refresh', leaseDurationMs: 60000 });
      const claim = claims.find(item => item.jobId === accepted.jobId);
      assert.ok(claim);
      const shared = new SharedFaviconCache(isolated.runtime.pool, store, async () => { throw new Error('must not fetch provider'); }, {
        providerTemplate: DEFAULT_TEMPLATE, refreshIntervalMs: 2592000000, retentionSeconds: 31536000,
        fetch: { timeoutMs: 1000, maxBytes: 65536, maxDecompressedBytes: 4194304, maxRedirects: 3 },
      });
      const refreshed = await processFaviconRefreshClaim({ ...executionPorts(store), fetcher: shared.fetch }, claim);
      assert.equal(refreshed.outcome, 'succeeded');
      assert.equal((await findBookmarkIconObjectIdsByNodeIds(isolated.runtime.db, [first])).get(first), objectId);

      const uploaded = await api('POST', `${address}/api/v1/collections/${COLLECTION}/nodes/${second}/favicon`, {
        cookie: owner.cookie, csrf: owner.csrfToken, commandId: randomUUID(), rawBody: PNG_V2, contentType: 'image/png',
      });
      assert.equal(uploaded.status, 200);
      const uploadedId = (uploaded.json as { iconUrl: string }).iconUrl.split('/').at(-1);
      assert.equal((await findBookmarkIconObjectIdsByNodeIds(isolated.runtime.db, [second])).get(second), uploadedId);
      const current = await api('GET', `${address}/api/v1/collections/${COLLECTION}/nodes/${first}/favicon-source`, { cookie: owner.cookie });
      const none = await api('PUT', `${address}/api/v1/collections/${COLLECTION}/nodes/${first}/favicon-source`, {
        cookie: owner.cookie, csrf: owner.csrfToken, commandId: randomUUID(),
        ifMatch: current.headers.etag, body: { sourceMode: 'none' },
      });
      assert.equal(none.status, 200);
      assert.equal((await findBookmarkIconObjectIdsByNodeIds(isolated.runtime.db, [first])).has(first), false);
      assert.ok(store.objects.has(objectId), 'per-bookmark changes cannot delete the shared object');
    } finally { await app.close(); }
  });

  test('provider admission defers durable refresh without consuming failure attempts', async () => {
    const app = buildApp();
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const node = 'fo-deferred-source-node';
    try {
      await reseed(node, 'https://queue.example.org/page');
      await setOnline(address, node);
      const source = await api('GET', `${address}/api/v1/collections/${COLLECTION}/nodes/${node}/favicon-source`,
        { cookie: owner.cookie });
      const accepted = assertIconJobAccepted((await api('POST', `${address}/api/v1/collections/${COLLECTION}/nodes/${node}/favicon-refresh`, {
        cookie: owner.cookie, csrf: owner.csrfToken, commandId: randomUUID(),
        ifMatch: `${source.headers.etag ?? ''}`,
      })).json);
      const repo = createPostgresFaviconJobWorkerRepository(isolated.runtime.pool);
      const claims = await repo.claimDue({ limit: 100, leaseOwner: 'deferred-refresh', leaseDurationMs: 60000 });
      const claim = claims.find(item => item.jobId === accepted.jobId);
      assert.ok(claim);
      const retryAt = new Date(Date.now() + 900000);
      const store = createTestFaviconStore();
      const result = await processFaviconRefreshClaim({
        ...executionPorts(store),
        fetcher: async () => { throw new FaviconFetchDeferred(retryAt); },
      }, claim);
      assert.equal(result.outcome, 'retry_scheduled');
      const row = (await isolated.runtime.pool.query(
        'SELECT status, attempts, next_attempt_at FROM favicon_jobs WHERE id=$1', [claim.jobId])).rows[0];
      assert.equal(row.status, 'pending');
      assert.equal(row.attempts, 0);
      assert.equal(row.next_attempt_at.getTime(), retryAt.getTime());
    } finally { await app.close(); }
  });
});
