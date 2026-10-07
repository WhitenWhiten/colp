/**
 * FO-07 review: `newDefault: online` must actually fetch for a bookmark created
 * in the Web app, not only project as online. Real PostgreSQL + real bootstrap
 * app + real worker; the create goes through the canonical Product UOW with the
 * transaction-scoped favicon ports, so the durable job is persisted with the
 * node and the worker then binds the fetched icon.
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
  createPostgresFaviconGcRepository,
  createPostgresFaviconJobWorkerRepository,
  createPostgresFaviconJobWorkerUnitOfWork,
  createFaviconWorkerRuntime,
  fetchFaviconImage,
} from '../../../src/infrastructure/collections/index.js';
import {
  materializeCollectionPayload,
  materializeNodePayload,
} from '../../../src/modules/collections/index.js';
import { InMemoryMetrics } from '../../../src/infrastructure/telemetry/index.js';
import { faviconCrc32 } from '../../../src/modules/collections/application/favicon-image-decode.js';
import { buildApiApp } from '../../../src/transport/app.js';
import { issueTestSession, createPostgresBetterAuthTestFactory } from '../../support/better-auth-test-factory.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';

const ORIGIN = 'https://app.example.test';
const ISSUER = 'https://issuer.example.test/realms/known';
const PUBLIC_PIN = '93.184.216.34';
const OBJECT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

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

const PNG = buildPng(2, 2);

interface ApiResponse {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly json: unknown;
}

interface Provider {
  readonly hits: string[];
  resolve(hostname: string): Promise<readonly string[]>;
  connect(target: { url: URL; ip: string; family: 4 | 6 }, init: RequestInit): Promise<Response>;
}

function createProvider(): Provider {
  const provider: Provider = {
    hits: [],
    async resolve() { return [PUBLIC_PIN]; },
    async connect(target) {
      provider.hits.push(target.url.href);
      return new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } });
    },
  };
  return provider;
}

function createStore() {
  const objects = new Map<string, { contentType: string; body: Buffer }>();
  return {
    objects,
    async put(objectId: string, body: Buffer, contentType: string) {
      objects.set(objectId, { contentType, body: Buffer.from(body) });
    },
    async get(objectId: string) { return objects.get(objectId) ?? null; },
    async delete(objectId: string) { objects.delete(objectId); },
  };
}

describeWithPostgres('FO-07 newDefault=online enqueues for Web-created bookmarks', () => {
  let isolated: IsolatedPostgresRuntime;
  let factory: ReturnType<typeof createPostgresBetterAuthTestFactory>;
  let owner: { cookie: string; csrfToken: string; accountId: string; subjectId: string };
  let config: ReturnType<typeof loadConfig>;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('fo7_create_enqueue', { maxConnections: 10 });
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
    factory = createPostgresBetterAuthTestFactory({ db: isolated.runtime.db });
    owner = await issueTestSession({ factory,
      subject: `fo7c-owner-${randomUUID()}`, handle: `fo7c${randomUUID().replaceAll('-', '').slice(0, 12)}` });
  }, 180_000);

  afterAll(async () => isolated?.close());

  function buildApp(store: ReturnType<typeof createStore>) {
    return buildApiApp({
      config,
      identityUnitOfWork: createPostgresIdentityUnitOfWork(isolated.runtime.db),
      collectionsUnitOfWork: createPostgresCollectionsUnitOfWork(isolated.runtime.db),
      productCollectionMutationUnitOfWork: createPostgresCanonicalMutationUnitOfWork(
        isolated.runtime.db, { productOrigin: ORIGIN }),
      browserSessionAuthority: factory.authority,
      faviconStore: store,
    });
  }

  function makeWorker(store: ReturnType<typeof createStore>, provider: Provider, workerId: string) {
    return createFaviconWorkerRuntime({
      repository: createPostgresFaviconJobWorkerRepository(isolated.runtime.pool),
      gc: createPostgresFaviconGcRepository(isolated.runtime.pool),
      verify: createPostgresFaviconJobWorkerUnitOfWork(isolated.runtime.db),
      fetcher: (input) => fetchFaviconImage({
        url: input.url, timeoutMs: input.timeoutMs, maxBytes: input.maxBytes,
        maxDecompressedBytes: input.maxDecompressedBytes, maxRedirects: input.maxRedirects,
        resolve: provider.resolve, connect: provider.connect,
      }),
      store,
      logger: { info() {}, warn() {}, error() {} },
      metrics: new InMemoryMetrics(),
      workerId,
      concurrency: 2,
      pollIntervalMs: 1_000,
      leaseDurationMs: 60_000,
      gcPollIntervalMs: 60_000,
      gcLeaseDurationMs: 120_000,
      now: () => new Date(),
      batchSize: 100,
      options: {
        maxAttempts: 5,
        backoffSeconds: [1, 2, 4, 8, 16] as readonly number[],
        retentionSeconds: 31_536_000,
        maxBytes: 65_536,
        maxDecompressedBytes: 65_536 * 64,
        fetchTimeoutMs: 10_000,
        maxRedirects: 3,
      },
    });
  }

  /** Canonical opaque collection + root with complete payload authority. */
  async function seedCollection(fill: number): Promise<{ collectionId: string; rootId: string }> {
    const collectionId = Buffer.alloc(16, fill).toString('base64url');
    const rootId = Buffer.alloc(16, fill + 1).toString('base64url');
    const client = await isolated.runtime.pool.connect();
    try {
      await client.query('begin');
      await client.query('set constraints all deferred');
      await client.query(
        `insert into resource_id_ledger(resource_id, resource_type) values ($1, 'collection'), ($2, 'node')`,
        [collectionId, rootId]);
      await client.query(
        `insert into collections
           (id, owner_subject_id, title, kind, visibility, root_node_id,
            resource_revision, content_revision, policy_revision, commit_ordinal)
         values ($1, $2, 'FO-07 create', 'bookmarks', 'private', $3, 'r1', 'c1', 'p1', 1)`,
        [collectionId, owner.subjectId, rootId]);
      await client.query(
        `insert into nodes (id, collection_id, kind, is_root, title, resource_revision, children_revision)
         values ($1, $2, 'folder', true, 'Root', 'r1', 'ch1')`, [rootId, collectionId]);
      await client.query(
        `insert into collection_members(collection_id, subject_id, role, granted_at)
         values ($1, $2, 'owner', now())`, [collectionId, owner.subjectId]);
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }

    const collectionRow = (await isolated.runtime.pool.query(
      'select * from collections where id = $1', [collectionId])).rows[0]!;
    const materializedCollection = materializeCollectionPayload({
      id: collectionRow.id,
      ownerSubjectId: collectionRow.owner_subject_id,
      title: collectionRow.title,
      summary: collectionRow.summary,
      kind: collectionRow.kind,
      visibility: collectionRow.visibility,
      rootNodeId: collectionRow.root_node_id,
      resourceRevision: collectionRow.resource_revision,
      contentRevision: collectionRow.content_revision,
      policyRevision: collectionRow.policy_revision,
      commitOrdinal: collectionRow.commit_ordinal,
      createdAt: collectionRow.created_at,
      updatedAt: collectionRow.updated_at,
      deletedAt: collectionRow.deleted_at,
    });
    if (!materializedCollection.ok) throw new Error(materializedCollection.reason);
    await isolated.runtime.pool.query(
      `update collections set payload_json = $2::jsonb, payload_schema_version = 1,
         payload_authority_status = 'backfilled' where id = $1`,
      [collectionId, JSON.stringify(materializedCollection.payload)]);

    const rootRow = (await isolated.runtime.pool.query(
      'select * from nodes where id = $1', [rootId])).rows[0]!;
    const materializedNode = materializeNodePayload({
      id: rootRow.id,
      collectionId: rootRow.collection_id,
      parentId: rootRow.parent_id,
      kind: rootRow.kind,
      isRoot: rootRow.is_root,
      title: rootRow.title,
      url: rootRow.url,
      description: rootRow.description,
      tags: rootRow.tags,
      visibility: rootRow.visibility,
      positionToken: rootRow.position_token,
      resourceRevision: rootRow.resource_revision,
      childrenRevision: rootRow.children_revision,
      createdAt: rootRow.created_at,
      updatedAt: rootRow.updated_at,
      deletedAt: rootRow.deleted_at,
      deletedCommitOrdinal: rootRow.deleted_commit_ordinal,
    });
    if (!materializedNode.ok) throw new Error(materializedNode.reason);
    await isolated.runtime.pool.query(
      `update nodes set payload_json = $2::jsonb, payload_schema_version = 1,
         payload_authority_status = 'backfilled' where id = $1`,
      [rootId, JSON.stringify(materializedNode.payload)]);
    return { collectionId, rootId };
  }

  async function patchPolicy(newDefault: 'capture' | 'online' | 'none', address: string): Promise<string> {
    const current = await api('GET', `${address}/api/v1/me/favicon-policy`, { cookie: owner.cookie });
    assert.equal(current.status, 200);
    const patched = await api('PATCH', `${address}/api/v1/me/favicon-policy`, {
      cookie: owner.cookie, csrf: owner.csrfToken, commandId: randomUUID(),
      ifMatch: `${current.headers.etag ?? ''}`, body: { newDefault },
    });
    assert.equal(patched.status, 200, JSON.stringify(patched.json));
    return (patched.json as { policy: { revision: string } }).policy.revision;
  }

  async function createBookmark(
    address: string, collectionId: string, rootId: string, title: string, url: string,
  ): Promise<{ status: number; nodeId: string | null; json: unknown }> {
    const created = await api('POST', `${address}/api/v1/collections/${collectionId}/nodes`, {
      cookie: owner.cookie, csrf: owner.csrfToken, commandId: randomUUID(),
      body: {
        parentId: rootId, afterId: null, beforeId: null,
        node: { kind: 'bookmark', title, url, description: null, tags: [], visibility: 'inherit' },
      },
    });
    return {
      status: created.status,
      nodeId: created.status === 201 ? (created.json as { node: { id: string } }).node.id : null,
      json: created.json,
    };
  }

  test('online default: create persists a refresh_one job and the worker binds the icon', async () => {
    const store = createStore();
    const provider = createProvider();
    const app = buildApp(store);
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    try {
      const policyRevision = await patchPolicy('online', address);
      const { collectionId, rootId } = await seedCollection(81);
      const created = await createBookmark(
        address, collectionId, rootId, 'Web-created', 'https://webcreated.example.org/one');
      assert.equal(created.status, 201, JSON.stringify(created.json));
      const nodeId = created.nodeId!;

      const jobs = (await isolated.runtime.pool.query(
        `select id, operation, policy_revision, source_url, node_resource_revision
           from favicon_jobs where node_id = $1`, [nodeId])).rows as Array<Record<string, unknown>>;
      assert.equal(jobs.length, 1, JSON.stringify(jobs));
      assert.match(String(jobs[0]!.id), OBJECT_ID_PATTERN);
      assert.equal(jobs[0]!.operation, 'refresh_one');
      assert.equal(jobs[0]!.policy_revision, policyRevision);
      assert.equal(jobs[0]!.source_url, 'https://favicone.com/webcreated.example.org');

      await makeWorker(store, provider, 'fo7-create-w1').jobs.runOnce();
      const job = (await isolated.runtime.pool.query(
        `select status, error_reason from favicon_jobs where node_id = $1`, [nodeId])).rows[0] as
        { status: string; error_reason: string | null };
      assert.equal(job.status, 'succeeded', JSON.stringify(job));
      const binding = (await isolated.runtime.pool.query(
        `select object_id from bookmark_icons where node_id = $1`, [nodeId])).rows[0] as
        { object_id: string } | undefined;
      assert.ok(binding, 'the new bookmark got its online icon');
      assert.equal(store.objects.has(binding!.object_id), true);
      assert.equal(provider.hits.length, 1);
    } finally { await app.close(); }
  });

  test('capture and none defaults create no favicon job', async () => {
    const store = createStore();
    const provider = createProvider();
    const app = buildApp(store);
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    try {
      const { collectionId, rootId } = await seedCollection(85);
      for (const newDefault of ['capture', 'none'] as const) {
        await patchPolicy(newDefault, address);
        const created = await createBookmark(
          address, collectionId, rootId, `Under-${newDefault}`, `https://webcreated.example.org/${newDefault}`);
        assert.equal(created.status, 201, JSON.stringify(created.json));
        const rows = (await isolated.runtime.pool.query(
          `select operation from favicon_jobs where node_id = $1`, [created.nodeId])).rows;
        assert.equal(rows.length, 0, `${newDefault} must not auto-enqueue`);
      }
    } finally { await app.close(); }
  });
});

function api(method: string, url: string, options: {
  cookie?: string; csrf?: string; commandId?: string; ifMatch?: string; body?: unknown;
} = {}): Promise<ApiResponse> {
  const headers: Record<string, string> = {};
  if (options.cookie !== undefined) headers.Cookie = options.cookie;
  if (options.csrf !== undefined) {
    headers.Origin = ORIGIN;
    headers['X-CSRF-Token'] = options.csrf;
  }
  if (options.commandId !== undefined) headers['Known-Command-Id'] = options.commandId;
  if (options.ifMatch !== undefined) headers['If-Match'] = options.ifMatch;
  let body: string | undefined;
  if (options.body !== undefined) {
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
        resolve({ status: res.statusCode ?? 0, headers: res.headers as Record<string, string>, json });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}