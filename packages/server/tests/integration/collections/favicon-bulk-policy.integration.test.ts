import { KNOWN_FAVICON_DOMAINS } from '../../../src/modules/collections/index.js';
import { isFaviconPubliclyAccessible } from '../../../src/infrastructure/database/publication-object-controls.js';
/**
 * FO-03 favicon bulk policy (real PostgreSQL + real bootstrap routes + real
 * worker loops with an injected controlled provider).
 *
 * Covers the complete batch strategy and recoverable-overwrite chain:
 *
 *  - updateMyFaviconPolicy opens fillMissing / forceAllOnline / online default
 *    and atomically creates the durable reconcile job (job + items + receipt
 *    in one transaction; PolicyResult.jobId);
 *  - createMyFaviconJob / getMyFaviconJob / retryMyFaviconJob over real HTTP
 *    with full schema, negatives (400/404/409), idempotent enqueue (the same
 *    jobId is never enqueued twice) and receipt replay;
 *  - the three independent settings: newDefault (acts on new nodes),
 *    fillMissing (only missing, non-none nodes), forceAllOnline (temporarily
 *    overwrites ALL icons incl. uploaded/none; restore_sources returns the
 *    exact original binding, never a placeholder);
 *  - bounded batch paging/checkpointing (FAVICON_JOB_BATCH_SIZE), counters
 *    across cycles, mid-flight URL / owner / policy drift re-verified before
 *    any write, uploaded never overwritten by an old batch job, force-off
 *    racing GC (restore references are never collected), retry re-runs ONLY
 *    failed items (never succeeded ones), real API enqueue → formal worker
 *    consume → HTTP read-back, and flag-off 404s.
 *
 * Each test starts from a wiped favicon state (jobs/items/restores/bindings/
 * policy rows) so the account-level assertions stay hermetic.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { deflateSync } from 'node:zlib';
import { afterAll, afterEach, beforeAll, test } from 'vitest';
import { loadConfig } from '../../support/test-config.js';
import { buildWorker } from '../../../src/bootstrap/worker.js';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import { createPostgresIdentityUnitOfWork } from '../../../src/infrastructure/identity/index.js';
import {
  createPostgresCollectionsUnitOfWork,
  createPostgresCanonicalMutationUnitOfWork,
  createPostgresFaviconJobWorkerRepository,
  createPostgresFaviconGcRepository,
  createPostgresFaviconJobWorkerUnitOfWork,
  createFaviconWorkerRuntime,
  fetchFaviconImage,
} from '../../../src/infrastructure/collections/index.js';
import { InMemoryMetrics } from '../../../src/infrastructure/telemetry/index.js';
import { buildApiApp } from '../../../src/transport/app.js';
import { issueTestSession, createPostgresBetterAuthTestFactory } from '../../support/better-auth-test-factory.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';
import { faviconCrc32 } from '../../../src/modules/collections/application/favicon-image-decode.js';
import { projectIconSource } from '../../../src/modules/collections/application/favicon-icon-source.js';
import {
  processFaviconBatchClaim,
  verifyFaviconBatchItemIdentity,
  type FaviconBatchExecutionPorts,
} from '../../../src/modules/collections/index.js';

const ORIGIN = 'https://app.example.test';
const ISSUER = 'https://issuer.example.test/realms/known';
const PUBLIC_PIN = '93.184.216.34';
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const REVISION_PATTERN = /^[1-9][0-9]{0,18}$/u;
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

const PNG_V1 = buildPng(2, 2);
const PNG_V2 = buildPng(1, 1);
const silentLogger = { info() {}, warn() {}, error() {} };

interface ApiResponse {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly json: unknown;
}

interface Store {
  readonly objects: Map<string, { contentType: string; body: Buffer }>;
  readonly puts: string[];
  readonly deletes: string[];
  put(objectId: string, body: Buffer, contentType: string): Promise<void>;
  get(objectId: string): Promise<{ contentType: string; body: Buffer } | null>;
  delete(objectId: string): Promise<void>;
}

function createTestStore(): Store {
  const objects = new Map<string, { contentType: string; body: Buffer }>();
  return {
    objects,
    puts: [],
    deletes: [],
    async put(objectId, body, contentType) {
      this.puts.push(objectId);
      objects.set(objectId, { contentType, body: Buffer.from(body) });
    },
    async get(objectId) {
      const row = objects.get(objectId);
      return row === undefined ? null : { contentType: row.contentType, body: Buffer.from(row.body) };
    },
    async delete(objectId) {
      this.deletes.push(objectId);
      objects.delete(objectId);
    },
  };
}

interface Provider {
  behavior: { body?: Buffer; failPaths?: Set<string> };
  hits: string[];
  resolve(hostname: string): Promise<readonly string[]>;
  connect(target: { url: URL; ip: string; family: 4 | 6 }, init: RequestInit): Promise<Response>;
}

function createProvider(): Provider {
  const provider: Provider = {
    behavior: { body: PNG_V1, failPaths: new Set() },
    hits: [],
    async resolve() { return [PUBLIC_PIN]; },
    async connect(target, init) {
      provider.hits.push(target.url.href);
      // The provider URL embeds the bookmark hostname in the path, so a
      // per-node failure is keyed by path segment (the fetch host is always
      // the provider host, e.g. favicone.com).
      const segments = target.url.pathname.split('/');
      if (provider.behavior.failPaths !== undefined
          && segments.some((segment) => provider.behavior.failPaths.has(segment))) {
        return new Response('boom', { status: 500 });
      }
      return new Response(provider.behavior.body ?? PNG_V1, { status: 200 });
    },
  };
  return provider;
}

describeWithPostgres('FO-03 favicon bulk policy (batch strategies + recoverable overwrite)', () => {
  let isolated: IsolatedPostgresRuntime;
  let factory: ReturnType<typeof createPostgresBetterAuthTestFactory>;
  let owner: { cookie: string; csrfToken: string; accountId: string; subjectId: string };
  let other: { cookie: string; csrfToken: string; accountId: string; subjectId: string };
  let stranger: { cookie: string; csrfToken: string; accountId: string; subjectId: string };
  let config: ReturnType<typeof loadConfig>;

  const COLLECTION = 'fo03-bulk-collection-0001';
  const ROOT = 'fo03-bulk-root-node-0000001';
  const BOOKMARK_A = 'fo03-bulk-bookmark-a-0001';
  const BOOKMARK_B = 'fo03-bulk-bookmark-b-0001';
  const BOOKMARK_C = 'fo03-bulk-bookmark-c-0001';

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('fo03_favicon_bulk', { maxConnections: 12 });
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
      // FO-05: the children cursor HMAC key is required when the flag is on.
      FAVICON_CURSOR_HMAC_KEY: Buffer.alloc(32, 42).toString('base64url'),
    });
    factory = createPostgresBetterAuthTestFactory({ db: isolated.runtime.db });
    owner = await issueTestSession({ factory,
      subject: `fo03-owner-${randomUUID()}`, handle: `fo3o${randomUUID().replaceAll('-', '').slice(0, 12)}` });
    other = await issueTestSession({ factory,
      subject: `fo03-other-${randomUUID()}`, handle: `fo3r${randomUUID().replaceAll('-', '').slice(0, 12)}` });
    stranger = await issueTestSession({ factory,
      subject: `fo03-stranger-${randomUUID()}`, handle: `fo3s${randomUUID().replaceAll('-', '').slice(0, 12)}` });
    await seedOwnedCollection(isolated, {
      collectionId: COLLECTION,
      rootId: ROOT,
      ownerSubjectId: owner.subjectId,
      bookmarks: [
        { id: BOOKMARK_A, url: 'https://alpha.example.org/a', resourceRevision: 'fo03-a-res-1' },
        { id: BOOKMARK_B, url: 'https://beta.example.org/b', resourceRevision: 'fo03-b-res-1' },
        { id: BOOKMARK_C, url: 'https://gamma.example.org/c', resourceRevision: 'fo03-c-res-1' },
      ],
    });
    await seedOwnedCollection(isolated, {
      collectionId: COLLECTION,
      rootId: ROOT,
      ownerSubjectId: owner.subjectId,
      bookmarks: Array.from({ length: 250 }, (_, i) => ({
        id: `fo03-bulk-node-${String(i).padStart(4, '0')}`,
        url: `https://bulk${String(i).padStart(4, '0')}.example.org/x`,
        resourceRevision: `fo03-bulk-res-${i}`,
      })),
      skipExisting: true,
    });
  }, 240_000);

  afterAll(async () => isolated?.close());

  /** Wipe the account-scoped favicon state so every test starts hermetic. */
  afterEach(async () => {
    await isolated.runtime.pool.query(
      `delete from favicon_job_items;
       delete from favicon_source_restores;
       delete from favicon_pending_deletions;
       delete from favicon_jobs;
       delete from bookmark_icons;
       delete from bookmark_icon_sources;
       delete from account_favicon_policies;
       delete from favicon_provider_admission;
       delete from favicon_shared_objects;
       delete from favicon_shared_domains;
       `);
  });

  function buildApp(overrides: Partial<ReturnType<typeof loadConfig>> = {}, store: Store = createTestStore()) {
    return buildApiApp({
      config: { ...config, ...overrides },
      identityUnitOfWork: createPostgresIdentityUnitOfWork(isolated.runtime.db),
      collectionsUnitOfWork: createPostgresCollectionsUnitOfWork(isolated.runtime.db),
      productCollectionMutationUnitOfWork: createPostgresCanonicalMutationUnitOfWork(
        isolated.runtime.db, { productOrigin: ORIGIN }),
      browserSessionAuthority: factory.authority,
      faviconPublicAccess: { isPubliclyAccessible: objectId => isFaviconPubliclyAccessible(isolated.runtime.db, objectId, KNOWN_FAVICON_DOMAINS) },
      faviconStore: store,
    });
  }

  function makeWorker(store: Store, provider: Provider, workerId = 'fo03-worker',
    batchSize = 100, maxAttempts = 5) {
    return createFaviconWorkerRuntime({
      repository: createPostgresFaviconJobWorkerRepository(isolated.runtime.pool),
      gc: createPostgresFaviconGcRepository(isolated.runtime.pool),
      verify: createPostgresFaviconJobWorkerUnitOfWork(isolated.runtime.db),
      fetcher: (input) => fetchFaviconImage({
        url: input.url,
        timeoutMs: input.timeoutMs,
        maxBytes: input.maxBytes,
        maxDecompressedBytes: input.maxDecompressedBytes,
        maxRedirects: input.maxRedirects,
        resolve: provider.resolve,
        connect: provider.connect,
      }),
      store,
      logger: silentLogger,
      metrics: new InMemoryMetrics(),
      workerId,
      concurrency: 2,
      pollIntervalMs: 1_000,
      leaseDurationMs: 60_000,
      gcPollIntervalMs: 60_000,
      gcLeaseDurationMs: 120_000,
      now: () => new Date(),
      batchSize,
      options: {
        maxAttempts,
        backoffSeconds: [1, 2, 4, 8, 16] as readonly number[],
        retentionSeconds: 31_536_000,
        maxBytes: 65_536,
        maxDecompressedBytes: 65_536 * 64,
        fetchTimeoutMs: 10_000,
        maxRedirects: 3,
      },
    });
  }

  function makeFormalWorker(store: Store, provider: Provider) {
    return buildWorker(config, isolated.runtime, new InMemoryMetrics(), {
      favicon: { store, resolve: provider.resolve, connect: provider.connect },
    });
  }

  /** Direct batch-execution ports for driving one claim step-by-step. */
  function makeBatchExecutionPorts(store: Store, provider: Provider): FaviconBatchExecutionPorts {
    return {
      verify: createPostgresFaviconJobWorkerUnitOfWork(isolated.runtime.db),
      worker: createPostgresFaviconJobWorkerRepository(isolated.runtime.pool).worker,
      fetcher: (input) => fetchFaviconImage({
        url: input.url,
        timeoutMs: input.timeoutMs,
        maxBytes: input.maxBytes,
        maxDecompressedBytes: input.maxDecompressedBytes,
        maxRedirects: input.maxRedirects,
        resolve: provider.resolve,
        connect: provider.connect,
      }),
      store,
      clock: { now: async () => new Date() },
      now: () => new Date(),
      options: {
        maxAttempts: 5,
        backoffSeconds: [1, 2, 4, 8, 16] as readonly number[],
        retentionSeconds: 31_536_000,
        maxBytes: 65_536,
        maxDecompressedBytes: 65_536 * 64,
        fetchTimeoutMs: 10_000,
        maxRedirects: 3,
        batchSize: 100,
        leaseDurationMs: 60_000,
      },
    };
  }

  /** PATCH the policy with a fresh ETag; returns the response. */
  async function patchPolicy(body: unknown, appAddress: string, cookie = owner.cookie): Promise<ApiResponse> {
    const current = await api('GET', `${appAddress}/api/v1/me/favicon-policy`, { cookie });
    assert.equal(current.status, 200);
    return api('PATCH', `${appAddress}/api/v1/me/favicon-policy`, {
      cookie, csrf: owner.csrfToken, commandId: randomUUID(),
      ifMatch: `${current.headers.etag ?? ''}`, body,
    });
  }

  async function createJob(operation: 'fill_missing' | 'refresh_online', policyRevision: string,
    appAddress: string, options: { commandId?: string; cookie?: string; body?: unknown } = {}): Promise<ApiResponse> {
    return api('POST', `${appAddress}/api/v1/me/favicon-jobs`, {
      cookie: options.cookie ?? owner.cookie,
      csrf: owner.csrfToken,
      commandId: options.commandId ?? randomUUID(),
      body: options.body ?? { operation, policyRevision },
    });
  }

  async function getJob(jobId: string, appAddress: string, cookie = owner.cookie): Promise<ApiResponse> {
    return api('GET', `${appAddress}/api/v1/me/favicon-jobs/${jobId}`, { cookie });
  }

  async function retryJob(jobId: string, appAddress: string, commandId = randomUUID()): Promise<ApiResponse> {
    return api('POST', `${appAddress}/api/v1/me/favicon-jobs/${jobId}/retry`, {
      cookie: owner.cookie, csrf: owner.csrfToken, commandId,
    });
  }

  async function runWorkerOnce(worker: { jobs: { runOnce(): Promise<boolean> } }, times = 1): Promise<void> {
    for (let i = 0; i < times; i += 1) {
      await isolated.runtime.pool.query(
        `update favicon_jobs set next_attempt_at = current_timestamp
         where status = 'pending' and next_attempt_at > current_timestamp`);
      await isolated.runtime.pool.query(
        `update favicon_job_items set next_attempt_at = current_timestamp
         where status = 'pending' and next_attempt_at > current_timestamp`);
      await worker.jobs.runOnce();
    }
  }

  async function jobRow(jobId: string): Promise<Record<string, unknown>> {
    const row = (await isolated.runtime.pool.query(
      `select operation, policy_revision, status, total, succeeded, failed, skipped
       from favicon_jobs where id = $1`, [jobId])).rows[0] as Record<string, unknown>;
    return {
      operation: row.operation, policy_revision: row.policy_revision,
      status: row.status, total: row.total, succeeded: Number(row.succeeded),
      failed: Number(row.failed), skipped: Number(row.skipped),
    };
  }

  async function bindingOf(nodeId: string): Promise<string | null> {
    const row = (await isolated.runtime.pool.query(
      `select object_id from bookmark_icons where node_id = $1`, [nodeId])).rows[0] as { object_id: string } | undefined;
    return row?.object_id ?? null;
  }

  // -------------------------------------------------------------------------
  // 1. newDefault acts on new nodes
  // -------------------------------------------------------------------------

  test('newDefault: online default projects inherit bookmarks as online; capture/none defaults hold', async () => {
    const app = buildApp();
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    try {
      const before = await api('GET', `${address}/api/v1/collections/${COLLECTION}/nodes/${BOOKMARK_A}/favicon-source`,
        { cookie: owner.cookie });
      assert.equal(assertIconSource(before.json).effectiveMode, 'capture');

      const online = await patchPolicy({ newDefault: 'online' }, address);
      assert.equal(online.status, 200);
      const onlineBody = assertPolicyResult(online.json);
      assert.equal(onlineBody.policy.newDefault, 'online');
      assert.equal(onlineBody.policy.revision, '2');
      assert.ok(onlineBody.jobId !== null && OBJECT_ID_PATTERN.test(onlineBody.jobId));

      const after = await api('GET', `${address}/api/v1/collections/${COLLECTION}/nodes/${BOOKMARK_A}/favicon-source`,
        { cookie: owner.cookie });
      const view = assertIconSource(after.json);
      assert.equal(view.sourceMode, 'inherit');
      assert.equal(view.effectiveMode, 'online');
      assert.equal(view.policyRevision, '2');

      // No-op online patch keeps the same revision with jobId null.
      const noop = await api('PATCH', `${address}/api/v1/me/favicon-policy`, {
        cookie: owner.cookie, csrf: owner.csrfToken, commandId: randomUUID(),
        ifMatch: `${online.headers.etag ?? ''}`, body: { newDefault: 'online' },
      });
      const noopBody = assertPolicyResult(noop.json);
      assert.equal(noopBody.policy.revision, '2');
      assert.equal(noopBody.jobId, null);
    } finally { await app.close(); }
  });

  // -------------------------------------------------------------------------
  // 1b. FO-07: inherit nodes are refreshable under an online default
  // -------------------------------------------------------------------------

  test('refresh_online under an online default includes explicit inherit rows and binds them', async () => {
    const app = buildApp();
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const store = createTestStore();
    const provider = createProvider();
    try {
      // A is untouched (no source row); C carries an EXPLICIT inherit row.
      await isolated.runtime.pool.query(
        `insert into bookmark_icon_sources(node_id, collection_id, source_mode, revision, updated_at)
         values ($1, $2, 'inherit', 2, now())`,
        [BOOKMARK_C, COLLECTION]);

      // Switching the default to online itself triggers the refresh_online job.
      const online = await patchPolicy({ newDefault: 'online' }, address);
      assert.equal(online.status, 200);
      const { jobId } = assertPolicyResult(online.json);
      assert.ok(jobId !== null);
      const created = await jobRow(jobId);
      assert.equal(created.operation, 'refresh_online');
      // A/B (virtual inherit), the 250 bulk nodes and C (explicit inherit) all
      // act online now. Before FO-07 the explicit inherit row was excluded.
      assert.equal(created.total, 253, 'explicit inherit is a refresh candidate under the online default');

      await runWorkerOnce(makeWorker(store, provider, 'fo03-inherit-w1', 100), 30);
      const done = await jobRow(jobId);
      assert.equal(done.status, 'succeeded', JSON.stringify(done));
      assert.equal(done.succeeded, 253);
      assert.ok(await bindingOf(BOOKMARK_C) !== null, 'the explicit inherit node got its online icon');
      assert.ok(await bindingOf(BOOKMARK_A) !== null, 'the virtual inherit node got its online icon');
    } finally { await app.close(); }
  });

  test('single-node refresh on an inherit node under an online default succeeds and binds', async () => {
    const app = buildApp();
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const store = createTestStore();
    const provider = createProvider();
    try {
      await isolated.runtime.pool.query(
        `insert into bookmark_icon_sources(node_id, collection_id, source_mode, revision, updated_at)
         values ($1, $2, 'inherit', 2, now())`,
        [BOOKMARK_B, COLLECTION]);
      const online = await patchPolicy({ newDefault: 'online' }, address);
      assert.equal(online.status, 200);

      // The UI refresh button posts this exact sequence.
      const source = await api('GET',
        `${address}/api/v1/collections/${COLLECTION}/nodes/${BOOKMARK_B}/favicon-source`, { cookie: owner.cookie });
      assert.equal(assertIconSource(source.json).effectiveMode, 'online');
      const accepted = await api('POST',
        `${address}/api/v1/collections/${COLLECTION}/nodes/${BOOKMARK_B}/favicon-refresh`, {
          cookie: owner.cookie, csrf: owner.csrfToken, commandId: randomUUID(),
          ifMatch: `${source.headers.etag ?? ''}`,
        });
      assert.equal(accepted.status, 202);
      const { jobId } = assertIconJobAccepted(accepted.json);
      assert.equal((await jobRow(jobId)).operation, 'refresh_one');

      await runWorkerOnce(makeWorker(store, provider, 'fo03-inherit-w2', 100), 30);
      const done = await jobRow(jobId);
      assert.equal(done.status, 'succeeded', JSON.stringify(done));
      assert.ok(await bindingOf(BOOKMARK_B) !== null, 'the refresh bound an icon');
      assert.equal(provider.hits.length > 0, true);
    } finally { await app.close(); }
  });

  test('FO-08 single-node refresh preserves inherit: the node keeps following the account default', async () => {
    const app = buildApp();
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const store = createTestStore();
    const provider = createProvider();
    try {
      const online = await patchPolicy({ newDefault: 'online' }, address);
      assert.equal(online.status, 200);

      // B: virtual inherit (no row). C: EXPLICIT inherit row.
      await isolated.runtime.pool.query(
        `insert into bookmark_icon_sources(node_id, collection_id, source_mode, revision, updated_at)
         values ($1, $2, 'inherit', 2, now())`,
        [BOOKMARK_C, COLLECTION]);

      // Refresh B (virtual inherit) under the online default.
      const bSource = await api('GET',
        `${address}/api/v1/collections/${COLLECTION}/nodes/${BOOKMARK_B}/favicon-source`, { cookie: owner.cookie });
      assert.equal(assertIconSource(bSource.json).sourceMode, 'inherit');
      assert.equal(assertIconSource(bSource.json).effectiveMode, 'online');
      const bAccepted = await api('POST',
        `${address}/api/v1/collections/${COLLECTION}/nodes/${BOOKMARK_B}/favicon-refresh`, {
          cookie: owner.cookie, csrf: owner.csrfToken, commandId: randomUUID(),
          ifMatch: `${bSource.headers.etag ?? ''}`,
        });
      assert.equal(bAccepted.status, 202);
      const bJobId = assertIconJobAccepted(bAccepted.json).jobId;

      // Refresh C (explicit inherit).
      const cSource = await api('GET',
        `${address}/api/v1/collections/${COLLECTION}/nodes/${BOOKMARK_C}/favicon-source`, { cookie: owner.cookie });
      assert.equal(assertIconSource(cSource.json).sourceMode, 'inherit');
      const cAccepted = await api('POST',
        `${address}/api/v1/collections/${COLLECTION}/nodes/${BOOKMARK_C}/favicon-refresh`, {
          cookie: owner.cookie, csrf: owner.csrfToken, commandId: randomUUID(),
          ifMatch: `${cSource.headers.etag ?? ''}`,
        });
      assert.equal(cAccepted.status, 202);
      const cJobId = assertIconJobAccepted(cAccepted.json).jobId;

      await runWorkerOnce(makeWorker(store, provider, 'fo03-preserve-w1', 100), 30);
      assert.equal((await jobRow(bJobId)).status, 'succeeded');
      assert.equal((await jobRow(cJobId)).status, 'succeeded');
      assert.ok(await bindingOf(BOOKMARK_B) !== null);
      assert.ok(await bindingOf(BOOKMARK_C) !== null);

      // Regression: the refresh CAS used to write an explicit online row
      // (inherit → online), silently detaching the node from the account
      // default forever. Now neither node materializes a mode.
      const bRows = (await isolated.runtime.pool.query(
        `select source_mode from bookmark_icon_sources where node_id = $1`, [BOOKMARK_B])).rows as { source_mode: string }[];
      assert.equal(bRows.length, 0, 'virtual inherit must not gain a source row from refresh');
      const cRows = (await isolated.runtime.pool.query(
        `select source_mode from bookmark_icon_sources where node_id = $1`, [BOOKMARK_C])).rows as { source_mode: string }[];
      assert.equal(cRows.length, 1);
      assert.equal(cRows[0]?.source_mode, 'inherit', 'the explicit inherit row must survive refresh');

      // Changing the account default to capture must now affect both nodes —
      // before the fix an explicit online row kept them pinned online.
      const policyNow = await api('GET', `${address}/api/v1/me/favicon-policy`, { cookie: owner.cookie });
      const capture = await api('PATCH', `${address}/api/v1/me/favicon-policy`, {
        cookie: owner.cookie, csrf: owner.csrfToken, commandId: randomUUID(),
        ifMatch: `${policyNow.headers.etag ?? ''}`, body: { newDefault: 'capture' },
      });
      assert.equal(capture.status, 200);
      for (const nodeId of [BOOKMARK_B, BOOKMARK_C]) {
        const after = await api('GET',
          `${address}/api/v1/collections/${COLLECTION}/nodes/${nodeId}/favicon-source`, { cookie: owner.cookie });
        assert.equal(assertIconSource(after.json).sourceMode, 'inherit',
          `${nodeId} must still read inherit after the refresh`);
        assert.notEqual(assertIconSource(after.json).effectiveMode, 'online',
          `${nodeId} must follow the capture default — refresh must not pin it online`);
      }
    } finally { await app.close(); }
  });


  // -------------------------------------------------------------------------
  // 2. fillMissing: only missing, non-none nodes
  // -------------------------------------------------------------------------

  test('fillMissing: PATCH creates the fill_missing job; none + uploaded nodes untouched; counters exact', async () => {
    const store = createTestStore();
    const app = buildApp({}, store);
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const provider = createProvider();
    try {
      // B: explicit none (Product delete) — never filled.
      const del = await api('DELETE', `${address}/api/v1/collections/${COLLECTION}/nodes/${BOOKMARK_B}/favicon`, {
        cookie: owner.cookie, csrf: owner.csrfToken, commandId: randomUUID(),
      });
      assert.equal(del.status, 200);
      // C: upload an image — never filled.
      const upload = await apiRaw('POST', `${address}/api/v1/collections/${COLLECTION}/nodes/${BOOKMARK_C}/favicon`, {
        cookie: owner.cookie, csrf: owner.csrfToken, commandId: randomUUID(),
        rawBody: PNG_V2, contentType: 'image/png',
      });
      assert.equal(upload.status, 200);

      const filled = await patchPolicy({ fillMissing: true }, address);
      assert.equal(filled.status, 200);
      const body = assertPolicyResult(filled.json);
      assert.equal(body.policy.fillMissing, true);
      const jobId = body.jobId;
      assert.ok(jobId !== null && OBJECT_ID_PATTERN.test(jobId), 'fill must create a durable job');
      const created = await jobRow(jobId);
      assert.equal(created.operation, 'fill_missing');
      assert.equal(created.policy_revision, '2');
      assert.equal(created.total, 251, 'A + 250 bulk; B(none)/C(uploaded) excluded');

      await runWorkerOnce(makeWorker(store, provider, 'fo03-fill-w1', 100), 20);
      const done = await jobRow(jobId);
      assert.equal(done.status, 'succeeded');
      assert.equal(Number(done.succeeded), 251);
      assert.equal(Number(done.failed), 0);
      assert.equal(Number(done.skipped), 0);

      assert.match(await bindingOf(BOOKMARK_A) ?? '', OBJECT_ID_PATTERN);
      assert.equal(await bindingOf(BOOKMARK_B), null);
      const cUploaded = (await isolated.runtime.pool.query(
        `select object_id from bookmark_icons where node_id = $1`, [BOOKMARK_C])).rows[0] as { object_id: string };
      assert.equal(store.objects.has(cUploaded.object_id), true);
      const bView = await api('GET', `${address}/api/v1/collections/${COLLECTION}/nodes/${BOOKMARK_B}/favicon-source`,
        { cookie: owner.cookie });
      assert.equal(assertIconSource(bView.json).sourceMode, 'none');
      assert.equal(assertIconSource(bView.json).effectiveMode, 'none');
      assert.equal(store.puts.length, 252, '251 fills + the explicit upload');
    } finally { await app.close(); }
  });

  // -------------------------------------------------------------------------
  // 3. createMyFaviconJob: HTTP + negatives + idempotent enqueue
  // -------------------------------------------------------------------------

  test('createMyFaviconJob/getMyFaviconJob: real HTTP, closed schema, negatives, no duplicate jobId', async () => {
    const app = buildApp();
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    try {
      await patchPolicy({ fillMissing: true }, address);
      const created = await createJob('fill_missing', '2', address);
      assert.equal(created.status, 202);
      assert.equal(created.headers['cache-control'], 'private, no-store');
      const { jobId } = assertIconJobAccepted(created.json);

      // Same operation + same revision returns the SAME jobId — never twice.
      const again = await createJob('fill_missing', '2', address);
      assert.equal(again.status, 202);
      assert.equal(assertIconJobAccepted(again.json).jobId, jobId);
      const jobsCount = (await isolated.runtime.pool.query(
        `select count(*)::int n from favicon_jobs where id = $1`, [jobId])).rows[0]?.n;
      assert.equal(jobsCount, 1);

      // Exact receipt replay (same command id, same body) replays the same job.
      const replayCommand = randomUUID();
      assertIconJobAccepted((await createJob('fill_missing', '2', address, { commandId: replayCommand })).json);
      const replay = await createJob('fill_missing', '2', address, { commandId: replayCommand });
      assert.equal(assertIconJobAccepted(replay.json).jobId, jobId);

      // getMyFaviconJob: pending job with a closed IconJob schema.
      const pending = await getJob(jobId, address);
      assert.equal(pending.status, 200);
      assert.equal(pending.headers['cache-control'], 'private, no-store');
      assertIconJob(pending.json, 'fill_missing', ['pending']);

      // Negatives: bad body / enum / revision / unknown field → 400.
      for (const body of [
        {},
        { operation: 'apply_force_online', policyRevision: '2' },
        { operation: 'fill_missing', policyRevision: '0' },
        { operation: 'fill_missing', policyRevision: 'x' },
        { operation: 'fill_missing', policyRevision: '2', extra: 1 },
        { operation: 'fill_missing' },
        null,
        'fill_missing',
      ]) {
        const rejected = await api('POST', `${address}/api/v1/me/favicon-jobs`, {
          cookie: owner.cookie, csrf: owner.csrfToken, commandId: randomUUID(), body,
        });
        assert.equal(rejected.status, 400, `body ${JSON.stringify(body)}`);
        assertProductError(rejected.json, ['invalid_request']);
      }
      // Stale policyRevision → 409 revision_conflict.
      const stale = await createJob('refresh_online', '1', address);
      assert.equal(stale.status, 409, `body: ${JSON.stringify(stale.json)}`);
      assertProductError(stale.json, ['revision_conflict']);
      // Missing command id → 400.
      const noCommand = await api('POST', `${address}/api/v1/me/favicon-jobs`, {
        cookie: owner.cookie, csrf: owner.csrfToken,
        body: { operation: 'fill_missing', policyRevision: '2' },
      });
      assert.equal(noCommand.status, 400);
      // GET rejects queries.
      const withQuery = await api('GET', `${address}/api/v1/me/favicon-jobs/${jobId}?x=1`, { cookie: owner.cookie });
      assert.equal(withQuery.status, 400);
      assertProductError(withQuery.json, ['invalid_query']);
      // GET/retry conceal missing/foreign jobs as 404.
      assert.equal((await getJob('00000000-0000-4000-8000-000000000000', address)).status, 404);
      assert.equal((await getJob('not-a-job-id', address)).status, 404);
      assert.equal((await getJob(jobId, address, stranger.cookie)).status, 404);
      const foreignRetry = await api('POST', `${address}/api/v1/me/favicon-jobs/${jobId}/retry`, {
        cookie: stranger.cookie, csrf: stranger.csrfToken, commandId: randomUUID(),
      });
      assert.equal(foreignRetry.status, 404);
    } finally { await app.close(); }
  });

  // -------------------------------------------------------------------------
  // 4. bounded batch paging / checkpoint resume
  // -------------------------------------------------------------------------

  test('batch paging: FAVICON_JOB_BATCH_SIZE caps a cycle; the job resumes across cycles to succeeded', async () => {
    const app = buildApp();
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const store = createTestStore();
    const provider = createProvider();
    try {
      // 250 dedicated node ids for this test; seed them before the fill patch.
      const pageNodes = Array.from({ length: 250 }, (_, i) => ({
        id: `fo03-page-node-${String(i).padStart(4, '0')}`,
        url: `https://page${String(i).padStart(4, '0')}.example.org/p`,
        resourceRevision: `fo03-page-res-${i}`,
      }));
      await seedOwnedCollection(isolated, {
        collectionId: COLLECTION, rootId: ROOT, ownerSubjectId: owner.subjectId,
        bookmarks: pageNodes, skipExisting: true,
      });

      const filled = await patchPolicy({ fillMissing: true }, address);
      const jobId = assertPolicyResult(filled.json).jobId;
      assert.ok(jobId !== null);

      const worker = makeWorker(store, provider, 'fo03-page-w1', 50);
      await runWorkerOnce(worker, 1);
      const afterOne = await jobRow(jobId);
      assert.equal(afterOne.status, 'pending', 'items remain after the first capped cycle');
      assert.equal(afterOne.succeeded, 50, 'one cycle consumes exactly the batch cap');
      assert.equal(afterOne.failed, 0);

      await runWorkerOnce(worker, 30);
      const done = await jobRow(jobId);
      assert.equal(done.status, 'succeeded');
      assert.equal(done.succeeded, done.total);
      for (const node of pageNodes) {
        assert.match(await bindingOf(node.id) ?? '', OBJECT_ID_PATTERN, `page node ${node.id} must be bound`);
      }
      assert.equal(new Set(store.puts).size, store.puts.length, 'no duplicate object PUTs across cycles');
    } finally { await app.close(); }
  });

  test('formal worker consumes config FAVICON_JOB_BATCH_SIZE as its per-cycle cap', async () => {
    const app = buildApp();
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const store = createTestStore();
    const provider = createProvider();
    try {
      const pageNodes = Array.from({ length: 120 }, (_, i) => ({
        id: `fo03-config-batch-${String(i).padStart(4, '0')}`,
        url: `https://cfgpage${String(i).padStart(4, '0')}.example.org/p`,
        resourceRevision: `fo03-config-batch-res-${i}`,
      }));
      await seedOwnedCollection(isolated, {
        collectionId: COLLECTION, rootId: ROOT, ownerSubjectId: owner.subjectId,
        bookmarks: pageNodes, skipExisting: true,
      });
      const filled = await patchPolicy({ fillMissing: true }, address);
      const jobId = assertPolicyResult(filled.json).jobId;
      assert.ok(jobId !== null);
      // The FORMAL worker is composed through buildWorker with a config whose
      // jobBatchSize is derived from FAVICON_JOB_BATCH_SIZE (FO-07 accepts
      // that the parsed config value reaches the real worker consumer; the
      // contract freezes it at 100, so a non-default value is only possible by
      // rebuilding the config object in this test).
      const cappedConfig = {
        ...config,
        faviconPolicy: { ...config.faviconPolicy, jobBatchSize: 25 },
      };
      const worker = buildWorker(cappedConfig, isolated.runtime, new InMemoryMetrics(), {
        favicon: { store, resolve: provider.resolve, connect: provider.connect },
      });
      assert.ok(worker.faviconJobs);
      await worker.faviconJobs!.jobs.runOnce();
      const afterOne = await jobRow(jobId);
      assert.equal(afterOne.status, 'pending', 'items remain after the first capped cycle');
      assert.equal(afterOne.succeeded, 1, 'provider admission permits one fetch per window');
      const attempted = (await isolated.runtime.pool.query(`SELECT count(*)::int n FROM favicon_job_items
        WHERE job_id=$1 AND object_id IS NOT NULL`, [jobId])).rows[0];
      assert.equal(attempted.n, 25, 'the cycle still processes exactly the configured item cap');
      const deferred = (await isolated.runtime.pool.query(`SELECT count(*)::int n FROM favicon_job_items
        WHERE job_id=$1 AND object_id IS NOT NULL AND status='pending' AND attempts=0
          AND next_attempt_at > current_timestamp`, [jobId])).rows[0];
      assert.equal(deferred.n, 24, 'provider waits preserve the failure attempt budget');
      assert.equal(afterOne.failed, 0);
    } finally { await app.close(); }
  });

  // -------------------------------------------------------------------------
  // 5. mid-flight drift: URL / owner / policy re-verified; uploaded never clobbered
  // -------------------------------------------------------------------------

  test('mid-flight drift: old batch job never overwrites a newer upload, URL or policy', async () => {
    const app = buildApp();
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const store = createTestStore();
    const provider = createProvider();
    try {
      // An editor-owned collection whose node must never be touched by the job.
      const otherCollection = 'fo03-other-collection-0001';
      const otherRoot = 'fo03-other-root-0000001';
      const otherNode = 'fo03-other-node-0000001';
      await seedOwnedCollection(isolated, {
        collectionId: otherCollection, rootId: otherRoot, ownerSubjectId: other.subjectId,
        bookmarks: [{ id: otherNode, url: 'https://other.example.org/o', resourceRevision: 'fo03-other-res-1' }],
      });

      const filled = await patchPolicy({ fillMissing: true }, address);
      const jobId = assertPolicyResult(filled.json).jobId;
      assert.ok(jobId !== null);
      const total = (await jobRow(jobId)).total as number;

      // Drift 1: an upload lands on node B (was missing) AFTER the job was
      // created → the item must be skipped and the upload must survive.
      const uploadedObject = randomUUID();
      await isolated.runtime.pool.query(
        `insert into bookmark_icons (
           node_id, collection_id, object_id, content_type, byte_size, digest_sha256, created_at, updated_at
         ) values ($1, $2, $3, 'image/png', $4, $5, now(), now())
         on conflict (node_id) do update set
           object_id = excluded.object_id, content_type = excluded.content_type,
           byte_size = excluded.byte_size, digest_sha256 = excluded.digest_sha256, updated_at = now()`,
        [BOOKMARK_B, COLLECTION, uploadedObject, PNG_V2.byteLength, createHash('sha256').update(PNG_V2).digest()]);
      await isolated.runtime.pool.query(
        `insert into bookmark_icon_sources(node_id, collection_id, source_mode, revision, updated_at)
         values ($1, $2, 'uploaded', 2, now())
         on conflict (node_id) do update set source_mode = 'uploaded', revision = bookmark_icon_sources.revision + 1`,
        [BOOKMARK_B, COLLECTION]);

      // Drift 2: node A's URL changes host → the item must fail source_changed
      // (and never fetch the new URL under the old job).
      await isolated.runtime.pool.query(
        `update nodes set url = 'https://moved.example.org/away', resource_revision = 'fo03-moved-res-1'
         where id = $1`, [BOOKMARK_A]);

      const beforeOther = await bindingOf(otherNode);
      await runWorkerOnce(makeWorker(store, provider, 'fo03-drift-w1', 100), 30);
      const done = await jobRow(jobId);
      assert.equal(done.status, 'partial', JSON.stringify(done));
      assert.equal(done.total, total);
      assert.equal(done.skipped, 1, 'the concurrent upload skips its item');
      assert.equal(done.failed, 1, 'the URL drift fails its item with source_changed');
      assert.equal(await bindingOf(BOOKMARK_B), uploadedObject, 'the newer upload survives');
      assert.equal(await bindingOf(otherNode), beforeOther, 'an editor-owned node is never fetched');
      const aQuery = await isolated.runtime.pool.query(
        `select error_reason from favicon_job_items where job_id = $1 and node_id = $2`, [jobId, BOOKMARK_A]);
      const aReasons = aQuery.rows as Array<{ error_reason: string | null }>;
      assert.equal(aReasons[0]?.error_reason, 'source_changed');

      // Drift 3 (policy): a job created on revision R fails stale_policy after
      // the policy advances; every item fails and none writes.
      const forced = await patchPolicy({ forceAllOnline: true }, address);
      const forceJobId = assertPolicyResult(forced.json).jobId;
      assert.ok(forceJobId !== null);
      await api('PATCH', `${address}/api/v1/me/favicon-policy`, {
        cookie: owner.cookie, csrf: owner.csrfToken, commandId: randomUUID(),
        ifMatch: `${forced.headers.etag ?? ''}`, body: { fillMissing: false },
      });
      await runWorkerOnce(makeWorker(store, provider, 'fo03-drift-w2', 100), 30);
      const stale = await jobRow(forceJobId);
      assert.equal(stale.status, 'failed');
      assert.equal(stale.failed, stale.total, 'stale policy fails every item');
      const staleErrors = (await isolated.runtime.pool.query(
        `select count(*)::int n from favicon_job_items
         where job_id = $1 and error_reason = 'stale_policy'`, [forceJobId])).rows[0]?.n;
      assert.equal(staleErrors, stale.total);
    } finally { await app.close(); }
  });

  // -------------------------------------------------------------------------
  // 6. forceAllOnline: covers uploaded/none, restore_sources returns originals
  // -------------------------------------------------------------------------

  test('forceAllOnline: covers every icon incl. uploaded; disabling restores the exact original binding', async () => {
    const app = buildApp();
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const store = createTestStore();
    const provider = createProvider();
    try {
      // C: an uploaded image that force must cover and restore.
      const uploadedObject = randomUUID();
      await store.put(uploadedObject, PNG_V2, 'image/png');
      await isolated.runtime.pool.query(
        `insert into bookmark_icons (
           node_id, collection_id, object_id, content_type, byte_size, digest_sha256, created_at, updated_at
         ) values ($1, $2, $3, 'image/png', $4, $5, now(), now())`,
        [BOOKMARK_C, COLLECTION, uploadedObject, PNG_V2.byteLength, createHash('sha256').update(PNG_V2).digest()]);
      await isolated.runtime.pool.query(
        `insert into bookmark_icon_sources(node_id, collection_id, source_mode, revision, updated_at)
         values ($1, $2, 'uploaded', 2, now())
         on conflict (node_id) do update set source_mode = 'uploaded', revision = bookmark_icon_sources.revision + 1`,
        [BOOKMARK_C, COLLECTION]);

      const forced = await patchPolicy({ forceAllOnline: true }, address);
      assert.equal(forced.status, 200);
      const forcedBody = assertPolicyResult(forced.json);
      assert.equal(forcedBody.policy.forceAllOnline, true);
      const applyJobId = forcedBody.jobId;
      assert.ok(applyJobId !== null && OBJECT_ID_PATTERN.test(applyJobId));
      assert.equal((await jobRow(applyJobId)).operation, 'apply_force_online');

      await runWorkerOnce(makeWorker(store, provider, 'fo03-force-w1', 100), 30);
      assert.equal((await jobRow(applyJobId)).status, 'succeeded');

      // C reads effective online while its sourceMode stays uploaded; the
      // binding was replaced by the force capture.
      const cView = await api('GET', `${address}/api/v1/collections/${COLLECTION}/nodes/${BOOKMARK_C}/favicon-source`,
        { cookie: owner.cookie });
      const cBody = assertIconSource(cView.json);
      assert.equal(cBody.sourceMode, 'uploaded');
      assert.equal(cBody.effectiveMode, 'online');
      const forceBinding = await bindingOf(BOOKMARK_C);
      assert.ok(forceBinding !== null && forceBinding !== uploadedObject, 'force replaced the uploaded binding');

      // The original object is protected as a restore reference.
      const restore = (await isolated.runtime.pool.query(
        `select original_object_id, original_source_mode from favicon_source_restores where node_id = $1`,
        [BOOKMARK_C])).rows[0] as { original_object_id: string; original_source_mode: string };
      assert.equal(restore.original_object_id, uploadedObject);
      assert.equal(restore.original_source_mode, 'uploaded');
      assert.equal(store.objects.has(uploadedObject), true);

      // Disable force → restore_sources restores the EXACT original binding.
      const off = await api('PATCH', `${address}/api/v1/me/favicon-policy`, {
        cookie: owner.cookie, csrf: owner.csrfToken, commandId: randomUUID(),
        ifMatch: `${forced.headers.etag ?? ''}`, body: { forceAllOnline: false },
      });
      const restoreJobId = assertPolicyResult(off.json).jobId;
      assert.ok(restoreJobId !== null);
      assert.equal((await jobRow(restoreJobId)).operation, 'restore_sources');
      await runWorkerOnce(makeWorker(store, provider, 'fo03-force-w2', 100), 30);
      assert.equal((await jobRow(restoreJobId)).status, 'succeeded');

      const cAfter = await api('GET', `${address}/api/v1/collections/${COLLECTION}/nodes/${BOOKMARK_C}/favicon-source`,
        { cookie: owner.cookie });
      assert.equal(assertIconSource(cAfter.json).effectiveMode, 'uploaded');
      assert.equal(await bindingOf(BOOKMARK_C), uploadedObject, 'the exact original binding is back');
      assert.equal(store.objects.has(forceBinding), true, 'the displaced force object still exists');
      assert.equal((await isolated.runtime.pool.query(
        `select count(*)::int n from favicon_source_restores where node_id = $1`, [BOOKMARK_C])).rows[0]?.n, 0);
      const retired = (await isolated.runtime.pool.query(
        `select count(*)::int n from favicon_pending_deletions where node_id = $1`, [BOOKMARK_C])).rows[0]?.n;
      assert.equal(retired, 1, 'the force-captured object is retired with retention');
    } finally { await app.close(); }
  });

  test('force re-enable before the restore ran keeps the user\'s original as the durable restore', async () => {
    const app = buildApp();
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const store = createTestStore();
    const provider = createProvider();
    try {
      // The user's own uploaded icon A on node C.
      const uploadedObject = randomUUID();
      await store.put(uploadedObject, PNG_V2, 'image/png');
      await isolated.runtime.pool.query(
        `insert into bookmark_icons (
           node_id, collection_id, object_id, content_type, byte_size, digest_sha256, created_at, updated_at
         ) values ($1, $2, $3, 'image/png', $4, $5, now(), now())`,
        [BOOKMARK_C, COLLECTION, uploadedObject, PNG_V2.byteLength,
          createHash('sha256').update(PNG_V2).digest()]);
      await isolated.runtime.pool.query(
        `insert into bookmark_icon_sources(node_id, collection_id, source_mode, revision, updated_at)
         values ($1, $2, 'uploaded', 2, now())`,
        [BOOKMARK_C, COLLECTION]);

      // 1) force ON and let the apply job finish: restore row = A, binding = B.
      const on1 = await patchPolicy({ forceAllOnline: true }, address);
      assert.equal(on1.status, 200);
      const applyJob1 = assertPolicyResult(on1.json).jobId;
      assert.ok(applyJob1 !== null);
      await runWorkerOnce(makeWorker(store, provider, 'fo03-rapid-w1', 100), 30);
      assert.equal((await jobRow(applyJob1)).status, 'succeeded');
      const forceBinding = await bindingOf(BOOKMARK_C);
      assert.ok(forceBinding !== null && forceBinding !== uploadedObject);
      const firstRestore = (await isolated.runtime.pool.query(
        `select original_object_id from favicon_source_restores where node_id = $1`,
        [BOOKMARK_C])).rows[0] as { original_object_id: string } | undefined;
      assert.equal(firstRestore?.original_object_id, uploadedObject);

      // 2) force OFF (restore job created but deliberately NOT run) …
      const off = await api('PATCH', `${address}/api/v1/me/favicon-policy`, {
        cookie: owner.cookie, csrf: owner.csrfToken, commandId: randomUUID(),
        ifMatch: `${on1.headers.etag ?? ''}`, body: { forceAllOnline: false },
      });
      assert.equal(off.status, 200);
      const restoreJob = assertPolicyResult(off.json).jobId;
      assert.ok(restoreJob !== null);

      // 3) … and force ON again before the restore has run.
      const on2 = await api('PATCH', `${address}/api/v1/me/favicon-policy`, {
        cookie: owner.cookie, csrf: owner.csrfToken, commandId: randomUUID(),
        ifMatch: `${off.headers.etag ?? ''}`, body: { forceAllOnline: true },
      });
      assert.equal(on2.status, 200);
      const applyJob2 = assertPolicyResult(on2.json).jobId;
      assert.ok(applyJob2 !== null);
      // The restore job was superseded; it can never run.
      assert.equal((await jobRow(restoreJob)).status, 'superseded');

      // 4) The second force applies: the durable restore row must survive
      //    untouched, still pointing at A, never rebased onto B.
      await runWorkerOnce(makeWorker(store, provider, 'fo03-rapid-w2', 100), 30);
      assert.equal((await jobRow(applyJob2)).status, 'succeeded');
      const secondRestore = (await isolated.runtime.pool.query(
        `select original_object_id from favicon_source_restores where node_id = $1`,
        [BOOKMARK_C])).rows[0] as { original_object_id: string } | undefined;
      assert.equal(secondRestore?.original_object_id, uploadedObject,
        'the first force window owns the restore row; the second must not overwrite it');
      const bindingAfterSecond = await bindingOf(BOOKMARK_C);
      assert.ok(bindingAfterSecond !== null && bindingAfterSecond !== forceBinding);

      // 5) force OFF for real: the ORIGINAL icon A comes back, not the force icon.
      const policyNow = await api('GET', `${address}/api/v1/me/favicon-policy`, { cookie: owner.cookie });
      const off2 = await api('PATCH', `${address}/api/v1/me/favicon-policy`, {
        cookie: owner.cookie, csrf: owner.csrfToken, commandId: randomUUID(),
        ifMatch: `${policyNow.headers.etag ?? ''}`, body: { forceAllOnline: false },
      });
      assert.equal(off2.status, 200);
      const restoreJob2 = assertPolicyResult(off2.json).jobId;
      assert.ok(restoreJob2 !== null);
      await runWorkerOnce(makeWorker(store, provider, 'fo03-rapid-w3', 100), 30);
      assert.equal(await bindingOf(BOOKMARK_C), uploadedObject,
        'closing force restores the user original, never the force capture');
    } finally { await app.close(); }
  });

  // -------------------------------------------------------------------------
  // 6c. FO-08 restore survives unrelated policy changes
  // -------------------------------------------------------------------------

  test('restore is not gated on the policy revision: an unrelated policy change after force-off still restores the original', async () => {
    const app = buildApp();
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const store = createTestStore();
    const provider = createProvider();
    try {
      // The user's uploaded original on C, displaced by a completed force job.
      const uploadedObject = randomUUID();
      await store.put(uploadedObject, PNG_V2, 'image/png');
      await isolated.runtime.pool.query(
        `insert into bookmark_icons (
           node_id, collection_id, object_id, content_type, byte_size, digest_sha256, created_at, updated_at
         ) values ($1, $2, $3, 'image/png', $4, $5, now(), now())`,
        [BOOKMARK_C, COLLECTION, uploadedObject, PNG_V2.byteLength,
          createHash('sha256').update(PNG_V2).digest()]);
      await isolated.runtime.pool.query(
        `insert into bookmark_icon_sources(node_id, collection_id, source_mode, revision, updated_at)
         values ($1, $2, 'uploaded', 2, now())`,
        [BOOKMARK_C, COLLECTION]);

      const forced = await patchPolicy({ forceAllOnline: true }, address);
      const applyJobId = assertPolicyResult(forced.json).jobId;
      assert.ok(applyJobId !== null);
      await runWorkerOnce(makeWorker(store, provider, 'fo03-pol-w1', 100), 30);
      assert.equal((await jobRow(applyJobId)).status, 'succeeded');
      const forceBinding = await bindingOf(BOOKMARK_C);
      assert.ok(forceBinding !== null && forceBinding !== uploadedObject);

      // force OFF → the restore job is pinned to the CURRENT policy revision.
      const off = await api('PATCH', `${address}/api/v1/me/favicon-policy`, {
        cookie: owner.cookie, csrf: owner.csrfToken, commandId: randomUUID(),
        ifMatch: `${forced.headers.etag ?? ''}`, body: { forceAllOnline: false },
      });
      assert.equal(off.status, 200);
      const restoreJobId = assertPolicyResult(off.json).jobId;
      assert.ok(restoreJobId !== null);

      // An UNRELATED policy change (provider template; capture default → no
      // job trigger) bumps the policy revision while the restore is pending.
      const policyNow = await api('GET', `${address}/api/v1/me/favicon-policy`, { cookie: owner.cookie });
      const providerPatch = await api('PATCH', `${address}/api/v1/me/favicon-policy`, {
        cookie: owner.cookie, csrf: owner.csrfToken, commandId: randomUUID(),
        ifMatch: `${policyNow.headers.etag ?? ''}`, body: { providerTemplate: 'https://icons.example.test/{hostname}' },
      });
      assert.equal(providerPatch.status, 200);
      const bumped = assertPolicyResult(providerPatch.json).policy.revision;
      assert.equal(Number(bumped) > Number(assertIconPolicy(policyNow.json).revision), true);
      assert.equal((await jobRow(restoreJobId)).status, 'pending', 'the restore job stays active');

      // The durable exemption: a restore item verifies READY although the
      // claim's policy revision is stale. Regression: it used to be a terminal
      // stale_policy failure and the terminal branch deleted the restore
      // snapshot, making the original unrecoverable.
      const repository = createPostgresFaviconJobWorkerRepository(isolated.runtime.pool);
      const claim = (await repository.claimDue({
        limit: 1, leaseOwner: 'fo03-pol-worker-a', leaseDurationMs: 60_000,
      }))[0];
      assert.ok(claim !== undefined && claim.jobId === restoreJobId);
      const verifyTx = createPostgresFaviconJobWorkerUnitOfWork(isolated.runtime.db);
      const items = await verifyTx.run((tx) => tx.items.listAllItems(restoreJobId));
      assert.ok(items.length > 0);
      const verdict = await verifyTx.run(
        (tx) => verifyFaviconBatchItemIdentity(tx, claim, items[0]!));
      assert.equal(verdict.kind, 'ready',
        'a restore item must ignore the policy revision drift (got stale_policy before the fix)');

      // Release the probe claim so the real worker can claim the job again.
      await isolated.runtime.pool.query(
        `update favicon_jobs set status = 'pending', lease_owner = null, lease_until = null
         where id = $1`, [restoreJobId]);

      // The whole restore completes: every item succeeds, the exact original
      // binding returns and the durable snapshot is consumed.
      await runWorkerOnce(makeWorker(store, provider, 'fo03-pol-w2', 100), 30);
      const done = await jobRow(restoreJobId);
      assert.equal(done.status, 'succeeded', JSON.stringify(done));
      assert.equal(done.failed, 0, 'no restore item may fail on the policy drift');
      assert.equal(await bindingOf(BOOKMARK_C), uploadedObject, 'the original binding is back');
      assert.equal((await isolated.runtime.pool.query(
        `select count(*)::int n from favicon_source_restores where node_id = $1`,
        [BOOKMARK_C])).rows[0]?.n, 0, 'the restore snapshot is consumed, not stranded');
    } finally { await app.close(); }
  });

  test('a provider change under an online default does not supersede the pending restore job', async () => {
    const app = buildApp();
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const store = createTestStore();
    const provider = createProvider();
    try {
      // The user's uploaded original on C.
      const uploadedObject = randomUUID();
      await store.put(uploadedObject, PNG_V2, 'image/png');
      await isolated.runtime.pool.query(
        `insert into bookmark_icons (
           node_id, collection_id, object_id, content_type, byte_size, digest_sha256, created_at, updated_at
         ) values ($1, $2, $3, 'image/png', $4, $5, now(), now())`,
        [BOOKMARK_C, COLLECTION, uploadedObject, PNG_V2.byteLength,
          createHash('sha256').update(PNG_V2).digest()]);
      await isolated.runtime.pool.query(
        `insert into bookmark_icon_sources(node_id, collection_id, source_mode, revision, updated_at)
         values ($1, $2, 'uploaded', 2, now())`,
        [BOOKMARK_C, COLLECTION]);

      // Online default active, then force ON → OFF (restore job stays pending).
      const online = await patchPolicy({ newDefault: 'online' }, address);
      assert.equal(online.status, 200);
      const forced = await patchPolicy({ forceAllOnline: true }, address);
      const applyJobId = assertPolicyResult(forced.json).jobId;
      assert.ok(applyJobId !== null);
      await runWorkerOnce(makeWorker(store, provider, 'fo03-polb-w1', 100), 30);
      assert.equal((await jobRow(applyJobId)).status, 'succeeded');
      const off = await api('PATCH', `${address}/api/v1/me/favicon-policy`, {
        cookie: owner.cookie, csrf: owner.csrfToken, commandId: randomUUID(),
        ifMatch: `${forced.headers.etag ?? ''}`, body: { forceAllOnline: false },
      });
      assert.equal(off.status, 200);
      const restoreJobId = assertPolicyResult(off.json).jobId;
      assert.ok(restoreJobId !== null);
      assert.equal((await jobRow(restoreJobId)).status, 'pending');

      // Provider change under the online default triggers refresh_online.
      // Regression: the new job superseded EVERY active batch job, so the
      // pending restore was retired mid-force-off and never ran again.
      const policyNow = await api('GET', `${address}/api/v1/me/favicon-policy`, { cookie: owner.cookie });
      const providerPatch = await api('PATCH', `${address}/api/v1/me/favicon-policy`, {
        cookie: owner.cookie, csrf: owner.csrfToken, commandId: randomUUID(),
        ifMatch: `${policyNow.headers.etag ?? ''}`, body: { providerTemplate: 'https://icons.example.test/{hostname}' },
      });
      assert.equal(providerPatch.status, 200);
      const refreshJobId = assertPolicyResult(providerPatch.json).jobId;
      assert.ok(refreshJobId !== null && refreshJobId !== restoreJobId);
      assert.equal(
        (await jobRow(restoreJobId)).status, 'pending',
        'an unrelated refresh_online trigger must not retire the pending restore job');

      // The worker then drains both: the restore (older) first — C returns to
      // the user's original — and the refresh covers the remaining nodes.
      await runWorkerOnce(makeWorker(store, provider, 'fo03-polb-w2', 100), 30);
      const restoreDone = await jobRow(restoreJobId);
      assert.equal(restoreDone.status, 'succeeded', JSON.stringify(restoreDone));
      assert.equal(await bindingOf(BOOKMARK_C), uploadedObject,
        'the originally uploaded binding is restored after the unrelated refresh');
      assert.equal((await isolated.runtime.pool.query(
        `select count(*)::int n from favicon_source_restores where node_id = $1`,
        [BOOKMARK_C])).rows[0]?.n, 0, 'the restore snapshot is consumed');
    } finally { await app.close(); }
  });

  test('restore job whose durable row vanished terminates as skipped instead of cycling forever', async () => {
    const app = buildApp();
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const store = createTestStore();
    const provider = createProvider();
    try {
      // The user's uploaded icon A on node C, displaced by a completed force job.
      const uploadedObject = randomUUID();
      await store.put(uploadedObject, PNG_V2, 'image/png');
      await isolated.runtime.pool.query(
        `insert into bookmark_icons (
           node_id, collection_id, object_id, content_type, byte_size, digest_sha256, created_at, updated_at
         ) values ($1, $2, $3, 'image/png', $4, $5, now(), now())`,
        [BOOKMARK_C, COLLECTION, uploadedObject, PNG_V2.byteLength,
          createHash('sha256').update(PNG_V2).digest()]);
      await isolated.runtime.pool.query(
        `insert into bookmark_icon_sources(node_id, collection_id, source_mode, revision, updated_at)
         values ($1, $2, 'uploaded', 2, now())
         on conflict (node_id) do update set source_mode = 'uploaded', revision = bookmark_icon_sources.revision + 1`,
        [BOOKMARK_C, COLLECTION]);

      const on = await patchPolicy({ forceAllOnline: true }, address);
      assert.equal(on.status, 200);
      const applyJobId = assertPolicyResult(on.json).jobId;
      assert.ok(applyJobId !== null);
      await runWorkerOnce(makeWorker(store, provider, 'fo03-vanish-w1', 100), 30);
      assert.equal((await jobRow(applyJobId)).status, 'succeeded');
      const restoreCount = (await isolated.runtime.pool.query(
        `select count(*)::int n from favicon_source_restores where node_id = $1`,
        [BOOKMARK_C])).rows[0]?.n;
      assert.equal(restoreCount, 1, 'the force apply must persist the durable restore row');

      // Disable force: the restore job snapshots the row, then the row
      // vanishes before the worker consumes it (concurrent supersede or DB
      // cleanup). Regression: the item used to stay pending forever and the
      // job cycled without ever reaching a terminal status.
      const off = await api('PATCH', `${address}/api/v1/me/favicon-policy`, {
        cookie: owner.cookie, csrf: owner.csrfToken, commandId: randomUUID(),
        ifMatch: `${on.headers.etag ?? ''}`, body: { forceAllOnline: false },
      });
      assert.equal(off.status, 200);
      const restoreJobId = assertPolicyResult(off.json).jobId;
      assert.ok(restoreJobId !== null);
      await isolated.runtime.pool.query(
        `delete from favicon_source_restores where node_id = $1`, [BOOKMARK_C]);

      const worker = makeWorker(store, provider, 'fo03-vanish-w2', 100);
      // The restore job covers every displaced node (force applies to all
      // nodes, so the restore job can carry hundreds of items). Poll until the
      // job reaches a terminal status: the regression made it cycle forever
      // because the vanished restore row's item was never marked terminal.
      let terminalStatus = 'pending';
      for (let cycle = 0; cycle < 30 && terminalStatus === 'pending'; cycle += 1) {
        await runWorkerOnce(worker, 1);
        terminalStatus = (await jobRow(restoreJobId)).status as string;
      }
      assert.ok(
        terminalStatus === 'succeeded' || terminalStatus === 'partial' || terminalStatus === 'failed',
        `the restore job must terminate once its item is terminal (got ${terminalStatus})`,
      );
      const item = await isolated.runtime.pool.query(
        `select status from favicon_job_items where job_id = $1 and node_id = $2`,
        [restoreJobId, BOOKMARK_C]);
      assert.equal(item.rows[0]?.status, 'skipped');
      assert.equal(await worker.jobs.runOnce(), false,
        'a terminal restore job must not be claimable again');
    } finally { await app.close(); }
  });

  test('supersede ordering: force-on over an unprocessed fill job still covers every node', async () => {
    const app = buildApp();
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const store = createTestStore();
    const provider = createProvider();
    try {
      // 1. A fill job is enqueued and deliberately NOT worked: its items stay
      //    pending and (by the candidate selector) hold every selected node.
      const policy = await api('GET', `${address}/api/v1/me/favicon-policy`, { cookie: owner.cookie });
      const fill = await createJob('fill_missing', assertIconPolicy(policy.json).revision, address);
      assert.equal(fill.status, 202);
      const fillJobId = assertIconJobAccepted(fill.json).jobId;
      const fillRow = await jobRow(fillJobId);
      const expectedTotal = Number(fillRow.total);
      assert.ok(expectedTotal >= 253, `fill must select every icon-less node (got ${expectedTotal})`);
      assert.equal(fillRow.status, 'pending');

      // 2. A new strategy (force-on) is enqueued while that job is unprocessed.
      const forced = await patchPolicy({ forceAllOnline: true }, address);
      assert.equal(forced.status, 200);
      const forceJobId = assertPolicyResult(forced.json).jobId;
      assert.ok(forceJobId !== null && OBJECT_ID_PATTERN.test(forceJobId));

      // 3. The fill job is superseded and the replacement covers the SAME
      //    nodes — the whole point of supersede. Regression: the candidate
      //    query used to run first and returned total=0.
      assert.equal((await jobRow(fillJobId)).status, 'superseded');
      const forceRow = await jobRow(forceJobId);
      assert.equal(forceRow.operation, 'apply_force_online');
      assert.equal(Number(forceRow.total), expectedTotal,
        'the newest strategy must cover every node the superseded job dropped');
      assert.equal(store.objects.size, 0, 'the superseded fill job must not have run');

      // 4. The worker actually binds an icon on every selected node.
      await runWorkerOnce(makeWorker(store, provider, 'fo03-supersede-w1', 100), 30);
      assert.equal((await jobRow(forceJobId)).status, 'succeeded');
      assert.equal((await isolated.runtime.pool.query(
        `select count(*)::int n from bookmark_icons`)).rows[0]?.n, expectedTotal,
        'forceAllOnline must bind an icon on every node');

      // 5. force-off then has a real restore ledger to consume.
      const off = await api('PATCH', `${address}/api/v1/me/favicon-policy`, {
        cookie: owner.cookie, csrf: owner.csrfToken, commandId: randomUUID(),
        ifMatch: `${forced.headers.etag ?? ''}`, body: { forceAllOnline: false },
      });
      const restoreJobId = assertPolicyResult(off.json).jobId;
      assert.ok(restoreJobId !== null);
      await runWorkerOnce(makeWorker(store, provider, 'fo03-supersede-w2', 100), 30);
      assert.equal((await jobRow(restoreJobId)).status, 'succeeded');
      assert.equal((await isolated.runtime.pool.query(
        `select count(*)::int n from bookmark_icons`)).rows[0]?.n, 0,
        'restore_sources removes the temporary force bindings');
    } finally { await app.close(); }
  });

  // -------------------------------------------------------------------------
  // 6b. FO-08 batch lease fencing: a lapsed claim never interleaves item writes
  // -------------------------------------------------------------------------

  test('lease fencing: a claim whose lease lapsed and was re-claimed aborts before any item write', async () => {
    const app = buildApp();
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const store = createTestStore();
    const provider = createProvider();
    try {
      const policy = await api('GET', `${address}/api/v1/me/favicon-policy`, { cookie: owner.cookie });
      const fill = await createJob('fill_missing', assertIconPolicy(policy.json).revision, address);
      assert.equal(fill.status, 202);
      const jobId = assertIconJobAccepted(fill.json).jobId;
      assert.equal((await jobRow(jobId)).status, 'pending');

      const repository = createPostgresFaviconJobWorkerRepository(isolated.runtime.pool);
      const portsA = makeBatchExecutionPorts(store, provider);
      const portsB = makeBatchExecutionPorts(store, provider);

      // Worker A claims the job and holds a valid lease.
      const claimA = (await repository.claimDue({
        limit: 1, leaseOwner: 'fo03-fence-worker-a', leaseDurationMs: 60_000,
      }))[0];
      assert.ok(claimA !== undefined && claimA.jobId === jobId, 'worker A claims the batch job');

      // Simulated stall: A's 60s lease lapses inside a long cycle while
      // worker B's poll runs expireOverdue and reclaims the running job.
      await isolated.runtime.pool.query(
        `update favicon_jobs set lease_until = current_timestamp - interval '1 second' where id = $1`,
        [jobId]);
      const claimB = (await repository.expireOverdue({
        limit: 1, leaseOwner: 'fo03-fence-worker-b', leaseDurationMs: 60_000,
      }))[0];
      assert.ok(claimB !== undefined && claimB.jobId === jobId, 'worker B reclaims the expired job');

      // The durable fence: A's stale claim can no longer verify ANY item
      // (the job lease owner changed) while B's fresh claim verifies ready.
      const verifyTx = createPostgresFaviconJobWorkerUnitOfWork(isolated.runtime.db);
      const allItems = await verifyTx.run((tx) => tx.items.listAllItems(jobId));
      assert.ok(allItems.length > 0);
      const verdictOnA = await verifyTx.run(
        (tx) => verifyFaviconBatchItemIdentity(tx, claimA, allItems[0]!));
      assert.equal(verdictOnA.kind, 'job_gone', 'a re-claimed lease must fence the stale claim out');
      const verdictOnB = await verifyTx.run(
        (tx) => verifyFaviconBatchItemIdentity(tx, claimB, allItems[0]!));
      assert.equal(verdictOnB.kind, 'ready', 'the current lease holder still passes verification');

      // A keeps trying to work the job: the cycle aborts BEFORE the next item
      // write — no PUT, no binding, no item status mutation, no store write.
      const stale = await processFaviconBatchClaim(portsA, claimA);
      assert.equal(stale.outcome, 'lease_lost', JSON.stringify(stale));
      assert.equal(store.puts.length, 0, 'the stale worker must never PUT');
      const untouched = (await isolated.runtime.pool.query(
        `select status from favicon_job_items where job_id = $1`, [jobId])).rows as { status: string }[];
      assert.equal(untouched.length > 0, true);
      for (const row of untouched) assert.equal(row.status, 'pending');

      // B then completes the job under its own lease; A cannot have displaced
      // any of B's later bindings because it never got past renewal.
      const fresh = await processFaviconBatchClaim(portsB, claimB);
      assert.equal(fresh.outcome, 'batch_released', JSON.stringify(fresh));
      assert.ok((await bindingOf(BOOKMARK_A)) !== null, 'worker B binds the first-cycle nodes');
      assert.ok((await bindingOf(BOOKMARK_B)) !== null);
    } finally { await app.close(); }
  });

  test('FO-08 a lapsed-but-still-owned lease renews: the batch cycle continues instead of aborting', async () => {
    const app = buildApp();
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const store = createTestStore();
    const provider = createProvider();
    try {
      const policy = await api('GET', `${address}/api/v1/me/favicon-policy`, { cookie: owner.cookie });
      const fill = await createJob('fill_missing', assertIconPolicy(policy.json).revision, address);
      assert.equal(fill.status, 202);
      const jobId = assertIconJobAccepted(fill.json).jobId;

      const repository = createPostgresFaviconJobWorkerRepository(isolated.runtime.pool);
      const portsA = makeBatchExecutionPorts(store, provider);

      // Worker A claims the job; its lease LAPSES but NO other worker takes it
      // over (one slow item). renewLease must re-arm the lapsed-but-owned
      // lease and the cycle must keep working — regression: aborting on mere
      // expiry threw away the rest of the cycle for no reason.
      const claimA = (await repository.claimDue({
        limit: 1, leaseOwner: 'fo03-renew-worker-a', leaseDurationMs: 60_000,
      }))[0];
      assert.ok(claimA !== undefined && claimA.jobId === jobId, 'worker A claims the batch job');
      await isolated.runtime.pool.query(
        `update favicon_jobs set lease_until = current_timestamp - interval '1 second' where id = $1`,
        [jobId]);

      // The lapsed-but-OWNED lease renews (no other worker took it over).
      // Regression: renewal used to fail on mere expiry, aborting the cycle.
      assert.equal(await repository.worker.renewLease({
        jobId, leaseOwner: 'fo03-renew-worker-a', leaseDurationMs: 60_000,
      }), true, 'a lapsed-but-still-owned lease must re-arm');
      const outcome = await processFaviconBatchClaim(portsA, claimA);
      assert.equal(outcome.outcome, 'batch_released', JSON.stringify(outcome));
      assert.equal(store.puts.length > 0, true, 'the still-owned cycle must keep working items');
      assert.ok((await bindingOf(BOOKMARK_A)) !== null, 'the first-cycle nodes are bound');
    } finally { await app.close(); }
  });

  // -------------------------------------------------------------------------
  // 7. force-off racing GC: restore references are never collected
  // -------------------------------------------------------------------------

  test('GC concurrency: an object referenced by a restore row is never deleted before or during restore', async () => {
    const app = buildApp();
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const store = createTestStore();
    const provider = createProvider();
    try {
      // C: an uploaded original so the force window creates a real reference.
      const uploadedObject = randomUUID();
      await store.put(uploadedObject, PNG_V2, 'image/png');
      await isolated.runtime.pool.query(
        `insert into bookmark_icons (
           node_id, collection_id, object_id, content_type, byte_size, digest_sha256, created_at, updated_at
         ) values ($1, $2, $3, 'image/png', $4, $5, now(), now())`,
        [BOOKMARK_C, COLLECTION, uploadedObject, PNG_V2.byteLength, createHash('sha256').update(PNG_V2).digest()]);
      await isolated.runtime.pool.query(
        `insert into bookmark_icon_sources(node_id, collection_id, source_mode, revision, updated_at)
         values ($1, $2, 'uploaded', 2, now())
         on conflict (node_id) do update set source_mode = 'uploaded', revision = bookmark_icon_sources.revision + 1`,
        [BOOKMARK_C, COLLECTION]);

      const forced = await patchPolicy({ forceAllOnline: true }, address);
      const applyJobId = assertPolicyResult(forced.json).jobId;
      assert.ok(applyJobId !== null);
      await runWorkerOnce(makeWorker(store, provider, 'fo03-gc-w1', 100), 30);
      assert.equal((await jobRow(applyJobId)).status, 'succeeded');

      // Fabricate a pending-deletion record aimed at the RESTORE-referenced
      // original and race GC before force-off: it must be held.
      await isolated.runtime.pool.query(
        `insert into favicon_pending_deletions (
           object_id, node_id, collection_id, retired_at, deletable_at, attempts, next_attempt_at
         ) values ($1, $2, $3, now() - interval '1 hour', now() - interval '1 second', 0,
                   now() - interval '1 second')
         on conflict (object_id) do nothing`,
        [uploadedObject, BOOKMARK_C, COLLECTION]);
      const gc = makeWorker(store, provider, 'fo03-gc-w2').gc;
      assert.equal(await gc.runOnce(), true, 'GC claims the stale record');
      assert.equal(store.objects.has(uploadedObject), true, 'restore-referenced original is never deleted');
      assert.equal(store.deletes.includes(uploadedObject), false);

      // Disable force → restore job; the original comes back as the binding
      // and the fabricated record still never collects it.
      const off = await api('PATCH', `${address}/api/v1/me/favicon-policy`, {
        cookie: owner.cookie, csrf: owner.csrfToken, commandId: randomUUID(),
        ifMatch: `${forced.headers.etag ?? ''}`, body: { forceAllOnline: false },
      });
      const restoreJobId = assertPolicyResult(off.json).jobId;
      assert.ok(restoreJobId !== null);
      const worker = makeWorker(store, provider, 'fo03-gc-w3', 100);
      await runWorkerOnce(worker, 30);
      assert.equal((await jobRow(restoreJobId)).status, 'succeeded');
      assert.equal(store.objects.has(uploadedObject), true, 'a restored object is a live binding');
      assert.equal(await bindingOf(BOOKMARK_C), uploadedObject);
      assert.equal(store.deletes.includes(uploadedObject), false, 'a re-bound object is never collected');
    } finally { await app.close(); }
  });

  test('FO-08 fill/refresh candidates exclude restore-row nodes: no capture can race a pending restore', async () => {
    const app = buildApp();
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const store = createTestStore();
    const provider = createProvider();
    try {
      // The user's uploaded original on C.
      const uploadedObject = randomUUID();
      await store.put(uploadedObject, PNG_V2, 'image/png');
      await isolated.runtime.pool.query(
        `insert into bookmark_icons (
           node_id, collection_id, object_id, content_type, byte_size, digest_sha256, created_at, updated_at
         ) values ($1, $2, $3, 'image/png', $4, $5, now(), now())`,
        [BOOKMARK_C, COLLECTION, uploadedObject, PNG_V2.byteLength,
          createHash('sha256').update(PNG_V2).digest()]);
      await isolated.runtime.pool.query(
        `insert into bookmark_icon_sources(node_id, collection_id, source_mode, revision, updated_at)
         values ($1, $2, 'uploaded', 2, now())`,
        [BOOKMARK_C, COLLECTION]);

      // Online default active; force ON (covers every node incl. C) and OFF,
      // leaving a pending restore job and C's durable restore row.
      await patchPolicy({ newDefault: 'online' }, address);
      const forced = await patchPolicy({ forceAllOnline: true }, address);
      const applyJobId = assertPolicyResult(forced.json).jobId;
      assert.ok(applyJobId !== null);
      await runWorkerOnce(makeWorker(store, provider, 'fo03-race-w1', 100), 30);
      assert.equal((await jobRow(applyJobId)).status, 'succeeded');
      const off = await api('PATCH', `${address}/api/v1/me/favicon-policy`, {
        cookie: owner.cookie, csrf: owner.csrfToken, commandId: randomUUID(),
        ifMatch: `${forced.headers.etag ?? ''}`, body: { forceAllOnline: false },
      });
      assert.equal(off.status, 200);
      const restoreJobId = assertPolicyResult(off.json).jobId;
      assert.ok(restoreJobId !== null);
      assert.equal((await isolated.runtime.pool.query(
        `select count(*)::int n from favicon_source_restores where node_id = $1`,
        [BOOKMARK_C])).rows[0]?.n, 1, 'the force window left a durable restore row for C');

      // Simulate the F-A2 narrow window: C's restore row arrives AFTER the
      // force-off snapshot — drop C's snapshot item so NO active job item
      // covers C while its restore row is pending.
      await isolated.runtime.pool.query(
        `delete from favicon_job_items where job_id = $1 and node_id = $2`,
        [restoreJobId, BOOKMARK_C]);

      // Provider change under the online default triggers refresh_online.
      // Regression: the candidate SQL only excluded nodes held by active job
      // items, so C (restore row, no item) was a refresh candidate and both
      // jobs worked the same binding — last writer wins, and a refresh that
      // lands after the restore retires the restored original.
      const policyNow = await api('GET', `${address}/api/v1/me/favicon-policy`, { cookie: owner.cookie });
      const providerPatch = await api('PATCH', `${address}/api/v1/me/favicon-policy`, {
        cookie: owner.cookie, csrf: owner.csrfToken, commandId: randomUUID(),
        ifMatch: `${policyNow.headers.etag ?? ''}`, body: { providerTemplate: 'https://icons.example.test/{hostname}' },
      });
      assert.equal(providerPatch.status, 200);
      const refreshJobId = assertPolicyResult(providerPatch.json).jobId;
      assert.ok(refreshJobId !== null && refreshJobId !== restoreJobId);
      const refreshCoversC = (await isolated.runtime.pool.query(
        `select count(*)::int n from favicon_job_items where job_id = $1 and node_id = $2`,
        [refreshJobId, BOOKMARK_C])).rows[0]?.n;
      assert.equal(refreshCoversC, 0,
        'fill/refresh candidates must exclude a node whose restore is still pending');

      // The restore still completes and C returns to the exact original.
      await runWorkerOnce(makeWorker(store, provider, 'fo03-race-w2', 100), 30);
      const restoreDone = await jobRow(restoreJobId);
      assert.equal(restoreDone.status, 'succeeded', JSON.stringify(restoreDone));
      assert.equal(await bindingOf(BOOKMARK_C), uploadedObject,
        'the original binding is restored, never raced by a refresh capture');
    } finally { await app.close(); }
  });

  // -------------------------------------------------------------------------
  // 8. retryMyFaviconJob: only failed items, never succeeded ones
  // -------------------------------------------------------------------------

  test('retry: partial job retries only failed items under the current policy', async () => {
    const app = buildApp();
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const store = createTestStore();
    const provider = createProvider();
    try {
      const failNode = 'fo03-retry-fail-0001';
      await isolated.runtime.pool.query(
        `insert into resource_id_ledger(resource_id, resource_type) values ($1, 'node') on conflict do nothing`,
        [failNode]);
      await isolated.runtime.pool.query(
        `insert into nodes (
           id, collection_id, parent_id, kind, is_root, title, url, position_token,
           resource_revision, children_revision, created_at, updated_at
         ) values ($1, $2, $3, 'bookmark', false, 'retry', 'https://failhost.example.org/f', 'B1',
                  'fo03-retry-res-1', 'ch', now(), now())`,
        [failNode, COLLECTION, ROOT]);

      provider.behavior.failPaths = new Set(['failhost.example.org']);
      const filled = await patchPolicy({ fillMissing: true }, address);
      const jobId = assertPolicyResult(filled.json).jobId;
      assert.ok(jobId !== null);
      await runWorkerOnce(makeWorker(store, provider, 'fo03-retry-w1', 100, 2), 30);
      const partial = await jobRow(jobId);
      assert.equal(partial.status, 'partial', JSON.stringify(partial));
      assert.equal(Number(partial.failed), 1, 'exactly the failhost node fails');
      assert.ok(Number(partial.succeeded) >= 1);

      const reported = await getJob(jobId, address);
      const jobView = assertIconJob(reported.json, 'fill_missing', ['partial']);
      assert.ok(jobView.failed >= 1);
      assert.deepEqual(jobView.errors.map((e) => e.nodeId).sort(),
        (await isolated.runtime.pool.query(
          `select node_id from favicon_job_items where job_id = $1 and status = 'failed' order by node_id`,
          [jobId])).rows.map((r) => r.node_id as string).sort());

      // Retry: provider now succeeds everywhere; ONLY failed items re-run.
      const succeededNodes = new Set((await isolated.runtime.pool.query(
        `select node_id from favicon_job_items where job_id = $1 and status = 'succeeded'`, [jobId]))
        .rows.map((r) => r.node_id as string));
      assert.ok(succeededNodes.size >= 1);
      provider.behavior.failPaths = new Set();
      const retried = await retryJob(jobId, address);
      assert.equal(retried.status, 202, `body: ${JSON.stringify(retried.json)}`);
      const retryJobId = assertIconJobAccepted(retried.json).jobId;
      assert.notEqual(retryJobId, jobId);
      const retryRow = await jobRow(retryJobId);
      assert.equal(retryRow.operation, 'fill_missing');
      assert.equal(retryRow.total, 1, 'retry carries exactly the failed items');
      const retryNodes = new Set((await isolated.runtime.pool.query(
        `select node_id from favicon_job_items where job_id = $1`, [retryJobId])).rows.map((r) => r.node_id as string));
      assert.deepEqual([...retryNodes], [failNode], 'only the failed node is retried');
      for (const node of succeededNodes) assert.equal(retryNodes.has(node), false, 'succeeded items never re-run');

      // Meanwhile the retry job is still pending: a duplicate retry of the
      // original job must return the SAME pending job (never a third row).
      const pileUp = await retryJob(jobId, address);
      assert.equal(pileUp.status, 202, `pileup body: ${JSON.stringify(pileUp.json)}`);
      assert.equal(assertIconJobAccepted(pileUp.json).jobId, retryJobId);
      const rows = (await isolated.runtime.pool.query(
        `select count(*)::int n from favicon_jobs where account_id = $1 and operation = 'fill_missing'`,
        [owner.accountId])).rows[0]?.n;
      assert.ok(rows !== undefined && rows <= 3, 'no retry pile-up rows');

      await runWorkerOnce(makeWorker(store, provider, 'fo03-retry-w2', 100), 30);
      assert.equal((await jobRow(retryJobId)).status, 'succeeded');
      assert.match(await bindingOf(failNode) ?? '', OBJECT_ID_PATTERN);

      // Negatives: non-terminal retry → 400; missing → 404.
      const nonTerminal = await retryJob(retryJobId, address);
      assert.equal(nonTerminal.status, 400);
      assert.equal((await retryJob('00000000-0000-4000-8000-000000000000', address)).status, 404);
    } finally { await app.close(); }
  });

  // -------------------------------------------------------------------------
  // 9. real API enqueue → formal worker consume → HTTP read-back
  // -------------------------------------------------------------------------

  test('real chain: HTTP createMyFaviconJob → formal worker → getMyFaviconJob + icon byte read-back', async () => {
    const store = createTestStore();
    const app = buildApp({}, store);
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const provider = createProvider();
    try {
      // Keep this HTTP/worker read-back test small; the paging tests cover 250 items.
      await isolated.runtime.pool.query(`INSERT INTO bookmark_icon_sources(node_id,collection_id,source_mode,revision,updated_at)
        SELECT id,collection_id,'none',1,current_timestamp FROM nodes
        WHERE kind='bookmark' AND deleted_at IS NULL AND id NOT IN ($1,$2,$3)`,
      [BOOKMARK_A, BOOKMARK_B, BOOKMARK_C]);
      await patchPolicy({ newDefault: 'online' }, address);
      const accepted = await createJob('refresh_online', '2', address);
      assert.equal(accepted.status, 202);
      const { jobId } = assertIconJobAccepted(accepted.json);

      const worker = makeFormalWorker(store, provider);
      assert.ok(worker.faviconJobs);
      for (let i = 0; i < 80; i += 1) {
        // Advance only our isolated test's durable clocks, not real time or the real provider.
        await isolated.runtime.pool.query(`UPDATE favicon_provider_admission SET next_request_at=current_timestamp;
          UPDATE favicon_jobs SET next_attempt_at=current_timestamp WHERE status='pending';
          UPDATE favicon_job_items SET next_attempt_at=current_timestamp WHERE status='pending'`);
        await worker.faviconJobs!.jobs.runOnce();
        const row = await jobRow(jobId);
        if (row.status !== 'pending' && row.status !== 'running') break;
      }
      const final = await jobRow(jobId);
      assert.equal(final.status, 'succeeded');
      assert.equal(Number(final.succeeded), final.total);

      const jobView = await getJob(jobId, address);
      assert.equal(jobView.status, 200);
      const body = assertIconJob(jobView.json, 'refresh_online', ['succeeded']);
      assert.equal(body.succeeded, body.total);
      assert.equal(body.errors.length, 0);

      const node = (await isolated.runtime.pool.query(
        `select node_id from favicon_job_items where job_id = $1 order by node_id limit 1`, [jobId])).rows[0] as
        { node_id: string };
      const binding = (await isolated.runtime.pool.query(
        `select object_id from bookmark_icons where node_id = $1`, [node.node_id])).rows[0] as { object_id: string };
      const originalVisibility = (await isolated.runtime.pool.query('select visibility,publication_slug,published_at from collections where id=$1', [COLLECTION])).rows[0];
      await isolated.runtime.pool.query("update collections set visibility='public',publication_slug='ci-favicon-'||md5(id),published_at=now() where id=$1", [COLLECTION]);
      const fetched = await apiRaw('GET', `${address}/api/v1/favicon/${binding.object_id}`, {});
      await isolated.runtime.pool.query('update collections set visibility=$2,publication_slug=$3,published_at=$4 where id=$1', [COLLECTION, originalVisibility.visibility, originalVisibility.publication_slug, originalVisibility.published_at]);
      assert.equal(fetched.status, 200);
      assert.equal(createHash('sha256').update(fetched.rawBody).digest('hex'),
        createHash('sha256').update(PNG_V1).digest('hex'));
    } finally { await app.close(); }
  });

  test('F-A1: batch item whose CAS fails source_changed after the PUT records the orphan for GC', async () => {
    const app = buildApp();
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const store = createTestStore();
    const provider = createProvider();
    const node = 'fo03-orphan-bookmark-0001';
    await isolated.runtime.pool.query(
      `insert into resource_id_ledger(resource_id, resource_type) values ($1, 'node') on conflict do nothing`,
      [node]);
    await isolated.runtime.pool.query(
      `insert into nodes (
         id, collection_id, parent_id, kind, is_root, title, url, position_token,
         resource_revision, children_revision, created_at, updated_at
       ) values ($1, $2, $3, 'bookmark', false, 'orphan', 'https://orphan.example.org/o', $1,
                 'fo03-orphan-res-1', 'ch', now(), now())`,
      [node, COLLECTION, ROOT]);
    try {
      // The URL changes DURING this node's fetch, so its CAS re-verify fails
      // source_changed AFTER the provider PUT (mid-flight URL edit, F-A1).
      const baseConnect = provider.connect;
      provider.connect = async (target, init) => {
        if (target.url.pathname.includes('orphan.example.org')) {
          await isolated.runtime.pool.query(
            `update nodes set url = 'https://moved-away.example.org/x', resource_revision = 'fo03-orphan-moved-res'
             where id = $1`, [node]);
        }
        return baseConnect(target, init);
      };
      const filled = await patchPolicy({ fillMissing: true }, address);
      const jobId = assertPolicyResult(filled.json).jobId;
      assert.ok(jobId !== null);
      await runWorkerOnce(makeWorker(store, provider, 'fo03-orphan-w1', 100), 30);
      const done = await jobRow(jobId);
      assert.ok(done.status === 'partial' || done.status === 'succeeded', JSON.stringify(done));
      assert.equal(await bindingOf(node), null, 'the moved node is never bound');
      const lost = (await isolated.runtime.pool.query(
        `select object_id from favicon_job_items where job_id = $1 and node_id = $2 and status = 'failed'`,
        [jobId, node])).rows[0] as { object_id: string } | undefined;
      assert.ok(lost !== undefined && lost.object_id !== null, 'the failed item persisted its object id');
      assert.equal(store.objects.has(lost.object_id), true, 'the bytes were PUT before the CAS failed');

      // F-A1 regression: without the fix no favicon_pending_deletions record is
      // written and the object is a permanent orphan (GC only collects records).
      const pending = (await isolated.runtime.pool.query(
        `select deletable_at from favicon_pending_deletions where object_id = $1`, [lost.object_id])).rows[0] as
        { deletable_at: Date } | undefined;
      assert.ok(pending !== undefined, 'the unbound batch object must have a pending-deletion record');
      assert.ok(pending.deletable_at.getTime() <= Date.now(), 'never served ⇒ immediately deletable');

      const gc = makeWorker(store, provider, 'fo03-orphan-gc', 100).gc;
      assert.equal(await gc.runOnce(), true);
      assert.equal(store.objects.has(lost.object_id), false, 'GC must delete the batch orphan');
    } finally { await app.close(); }
  });

  test('F-A2: a restore row created after the force-off snapshot is still restored', async () => {
    const app = buildApp();
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const store = createTestStore();
    const provider = createProvider();
    try {
      // 1. force-on completes: every covered node holds a restore row.
      const forced = await patchPolicy({ forceAllOnline: true }, address);
      const applyJobId = assertPolicyResult(forced.json).jobId;
      assert.ok(applyJobId !== null);
      await runWorkerOnce(makeWorker(store, provider, 'fo03-gap-w1', 100), 30);
      assert.equal((await jobRow(applyJobId)).status, 'succeeded');

      // 2. force-off enqueues restore_sources with a SNAPSHOT of current rows.
      const off = await api('PATCH', `${address}/api/v1/me/favicon-policy`, {
        cookie: owner.cookie, csrf: owner.csrfToken, commandId: randomUUID(),
        ifMatch: `${forced.headers.etag ?? ''}`, body: { forceAllOnline: false },
      });
      const restoreJobId = assertPolicyResult(off.json).jobId;
      assert.ok(restoreJobId !== null);

      // 3. BEFORE the worker runs: C's snapshot row vanishes…
      await isolated.runtime.pool.query(
        `delete from favicon_source_restores where node_id = $1`, [BOOKMARK_C]);

      // …and a late force-CAS commits for node D (created after the apply job;
      // force displaced a binding that had no original). D has NO item in the
      // snapshot — the F-A2 race.
      const lateNode = 'fo03-gap-late-node-0001';
      await isolated.runtime.pool.query(
        `insert into resource_id_ledger(resource_id, resource_type) values ($1, 'node') on conflict do nothing`,
        [lateNode]);
      await isolated.runtime.pool.query(
        `insert into nodes (
           id, collection_id, parent_id, kind, is_root, title, url, position_token,
           resource_revision, children_revision, created_at, updated_at
         ) values ($1, $2, $3, 'bookmark', false, 'late', 'https://late.example.org/l', $1,
                   'fo03-gap-res-1', 'ch', now(), now())`,
        [lateNode, COLLECTION, ROOT]);
      const lateBinding = randomUUID();
      await store.put(lateBinding, PNG_V1, 'image/png');
      await isolated.runtime.pool.query(
        `insert into bookmark_icons (
           node_id, collection_id, object_id, content_type, byte_size, digest_sha256, created_at, updated_at
         ) values ($1, $2, $3, 'image/png', $4, $5, now(), now())`,
        [lateNode, COLLECTION, lateBinding, PNG_V1.byteLength,
          createHash('sha256').update(PNG_V1).digest()]);
      await isolated.runtime.pool.query(
        `insert into bookmark_icon_sources(node_id, collection_id, source_mode, revision, updated_at)
         values ($1, $2, 'inherit', 1, now())`,
        [lateNode, COLLECTION]);
      await isolated.runtime.pool.query(
        `insert into favicon_source_restores (
           node_id, collection_id, account_id, original_source_mode, original_object_id,
           original_content_type, original_byte_size, original_digest_sha256, source_revision,
           created_at, updated_at
         ) values ($1, $2, $3, 'inherit', null, null, null, null, 1, now(), now())`,
        [lateNode, COLLECTION, owner.accountId]);

      // 4. Run the restore job: C's vanished row skips; D's late row must be
      //    consumed. F-A2 regression: without the gap scan the row survives
      //    and the job terminates with node D never restored (its original
      //    object GC-protected forever).
      const worker = makeWorker(store, provider, 'fo03-gap-w2', 100);
      let status = 'pending';
      for (let cycle = 0; cycle < 30 && status === 'pending'; cycle += 1) {
        await runWorkerOnce(worker, 1);
        status = (await jobRow(restoreJobId)).status as string;
      }
      assert.ok(['succeeded', 'partial'].includes(status), `restore job must terminate (got ${status})`);
      assert.equal((await isolated.runtime.pool.query(
        `select count(*)::int n from favicon_source_restores where node_id = $1`, [lateNode])).rows[0]?.n, 0,
        'the late restore row must be consumed');
      assert.equal(await bindingOf(lateNode), null, 'the late force binding is removed by the restore');
    } finally { await app.close(); }
  });

  test('F-A3: a newer succeeded batch item wins over an older failed refresh_one in the source projection', async () => {
    const app = buildApp();
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    try {
      const node = BOOKMARK_A;
      // An online source with a live binding ⇒ status 'ready' when no pending
      // or failed job is the latest.
      await isolated.runtime.pool.query(
        `insert into bookmark_icon_sources(node_id, collection_id, source_mode, revision, updated_at)
         values ($1, $2, 'online', 1, now())`, [node, COLLECTION]);
      const object = randomUUID();
      await isolated.runtime.pool.query(
        `insert into bookmark_icons (
           node_id, collection_id, object_id, content_type, byte_size, digest_sha256, created_at, updated_at
         ) values ($1, $2, $3, 'image/png', $4, $5, now(), now())`,
        [node, COLLECTION, object, PNG_V1.byteLength, createHash('sha256').update(PNG_V1).digest()]);
      // OLD failed refresh_one row for the same node…
      await isolated.runtime.pool.query(
        `insert into favicon_jobs (
           id, account_id, owner_subject_id, operation, policy_revision, status, total,
           succeeded, failed, skipped, collection_id, node_id, source_url, source_revision,
           node_resource_revision, attempts, next_attempt_at, created_at, updated_at
         ) values ($1, $2, $3, 'refresh_one', '1', 'failed', 1, 0, 1, 0, $4, $5,
                   'https://favicone.com/old-host', '1', 'fo03-old-res', 1, null,
                   now() - interval '1 hour', now() - interval '1 hour')`,
        [randomUUID(), owner.accountId, owner.subjectId, COLLECTION, node]);
      // …and a NEWER succeeded batch item (fill_missing) for the same node.
      const batchJobId = randomUUID();
      await isolated.runtime.pool.query(
        `insert into favicon_jobs (
           id, account_id, owner_subject_id, operation, policy_revision, status, total,
           succeeded, failed, skipped, collection_id, node_id, source_url, source_revision,
           node_resource_revision, attempts, next_attempt_at, created_at, updated_at
         ) values ($1, $2, $3, 'fill_missing', '1', 'succeeded', 1, 1, 0, 0, $4, null,
                   null, null, null, 0, null, now(), now())`,
        [batchJobId, owner.accountId, owner.subjectId, COLLECTION]);
      await isolated.runtime.pool.query(
        `insert into favicon_job_items (
           job_id, node_id, collection_id, source_url, source_revision, node_resource_revision,
           status, error_reason, attempts, next_attempt_at, object_id, created_at, updated_at
         ) values ($1, $2, $3, 'https://favicone.com/alpha.example.org', '1', 'fo03-new-res',
                   'succeeded', null, 1, null, $4, now(), now())`,
        [batchJobId, node, COLLECTION, object]);

      const view = await api('GET', `${address}/api/v1/collections/${COLLECTION}/nodes/${node}/favicon-source`,
        { cookie: owner.cookie });
      const body = assertIconSource(view.json);
      // F-A3 regression: without succeeded items in the latestForNode union the
      // newest row is the OLD failed refresh_one and the node projects 'failed'
      // forever despite its newer succeeded work.
      assert.equal(body.status, 'ready', JSON.stringify(view.json));
    } finally { await app.close(); }
  });

  test('F-A4: a CAS-terminal stale_policy failure records the true reason, not the hardcoded source_changed', async () => {
    const app = buildApp();
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const store = createTestStore();
    const provider = createProvider();
    try {
      // Bump the policy revision DURING the first fetch so the pre-fetch
      // re-verify passes but the CAS re-verify fails stale_policy AFTER the PUT.
      const baseConnect = provider.connect;
      provider.connect = async (target, init) => {
        await isolated.runtime.pool.query(
          `update account_favicon_policies set revision = revision + 1 where account_id = $1`,
          [owner.accountId]);
        return baseConnect(target, init);
      };
      const filled = await patchPolicy({ fillMissing: true }, address);
      const jobId = assertPolicyResult(filled.json).jobId;
      assert.ok(jobId !== null);
      await runWorkerOnce(makeWorker(store, provider, 'fo03-reason-w1', 100), 30);
      const done = await jobRow(jobId);
      assert.equal(done.status, 'failed', JSON.stringify(done));
      const reasons = (await isolated.runtime.pool.query(
        `select error_reason, count(*)::int n from favicon_job_items
         where job_id = $1 group by error_reason`, [jobId])).rows as Array<{ error_reason: string; n: number }>;
      const byReason = Object.fromEntries(reasons.map((r) => [r.error_reason, r.n]));
      // F-A4 regression: without the fix the item that fetched then hit the
      // CAS-terminal path is marked with the hardcoded 'source_changed'.
      assert.equal(byReason.source_changed ?? 0, 0, `reasons: ${JSON.stringify(reasons)}`);
      assert.equal(byReason.stale_policy, done.total);
      // The CAS-terminal PUT object is also retired as immediately deletable
      // (F-A1 applies to every terminal CAS, not only source_changed).
      const orphanCheck = (await isolated.runtime.pool.query(
        `select count(*)::int n from favicon_pending_deletions d
         join favicon_job_items it on it.object_id = d.object_id and it.job_id = $1
         where d.deletable_at <= now()`, [jobId])).rows[0]?.n;
      assert.equal(orphanCheck, 1, 'the CAS-terminal PUT object is retired as immediately deletable');
    } finally { await app.close(); }
  });

  test('F-A5: item source_revision beyond 2^53 round-trips exactly', async () => {
    const app = buildApp();
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    try {
      const node = BOOKMARK_B;
      // 2^53 + 1: Number() would silently round it to …922 when stored.
      const BIG = '9007199254740993';
      await isolated.runtime.pool.query(
        `insert into bookmark_icon_sources(node_id, collection_id, source_mode, revision, updated_at)
         values ($1, $2, 'inherit', ${BIG}, now())`, [node, COLLECTION]);
      const filled = await patchPolicy({ fillMissing: true }, address);
      const jobId = assertPolicyResult(filled.json).jobId;
      assert.ok(jobId !== null);
      const stored = (await isolated.runtime.pool.query(
        `select source_revision from favicon_job_items where job_id = $1 and node_id = $2`,
        [jobId, node])).rows[0] as { source_revision: string } | undefined;
      assert.ok(stored !== undefined, 'the node must be a fill candidate');
      // F-A5 regression: the old Number(item.sourceRevision) stored the rounded
      // bigint, losing the exact identity that the CAS re-verification needs.
      assert.equal(stored.source_revision, BIG);
    } finally { await app.close(); }
  });

  test('F-A8: projectIconSource reflects a pending force-restore row as restorable', async () => {
    const node = {
      id: BOOKMARK_A, collectionId: COLLECTION, parentId: ROOT, kind: 'bookmark', isRoot: false,
      title: 'A', url: 'https://alpha.example.org/a', description: null, tags: [],
      visibility: 'private', positionToken: 'P1', resourceRevision: 'fo03-a-res-1',
      childrenRevision: 'ch', createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-01T00:00:00Z'), deletedAt: null,
    };
    const basePorts = {
      sources: { findByNodeId: async () => null },
      policies: { findByAccountId: async () => null },
      bookmarkIcons: { findByNodeId: async () => null },
      jobs: undefined,
      collectionMembers: undefined,
      restores: undefined,
    };
    const without = await projectIconSource(
      basePorts, node, owner.accountId, owner.subjectId, ORIGIN, 'private');
    assert.equal(without.restorable, false, 'no pending restore row ⇒ not restorable');
    const withRow = {
      ...basePorts,
      restores: {
        findByNodeId: async () => ({
          nodeId: BOOKMARK_A, collectionId: COLLECTION, accountId: owner.accountId,
          originalSourceMode: 'inherit', originalObjectId: null, originalContentType: null,
          originalByteSize: null, originalDigestSha256: null, sourceRevision: 1n,
          createdAt: new Date('2026-01-01T00:00:00Z'), updatedAt: new Date('2026-01-01T00:00:00Z'),
        }),
      },
    };
    const withRestore = await projectIconSource(
      withRow, node, owner.accountId, owner.subjectId, ORIGIN, 'private');
    // F-A8 regression: without the fix restorable is hardcoded false.
    assert.equal(withRestore.restorable, true, 'a pending force-restore row makes the source restorable');
  });
});

// ---------------------------------------------------------------------------
// Contract validators + HTTP plumbing (independent of the implementation).
// ---------------------------------------------------------------------------

function assertClosedObject(value: unknown, keys: readonly string[], name: string): asserts value is Record<string, unknown> {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value), `${name} must be an object`);
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), `${name} must be a closed object`);
}

function assertIconJobAccepted(value: unknown): { jobId: string } {
  assertClosedObject(value, ['jobId'], 'IconJobAccepted');
  const jobId = (value as Record<string, unknown>).jobId;
  assert.equal(typeof jobId, 'string');
  assert.match(jobId, OBJECT_ID_PATTERN);
  return { jobId: jobId as string };
}

function assertIconPolicy(value: unknown): {
  revision: string; newDefault: string; providerTemplate: string; fillMissing: boolean; forceAllOnline: boolean;
} {
  assertClosedObject(value, ['revision', 'newDefault', 'providerTemplate', 'fillMissing',
    'forceAllOnline', 'updatedAt'], 'IconPolicy');
  const body = value as Record<string, unknown>;
  assert.match(body.revision as string, REVISION_PATTERN);
  assert.ok(['capture', 'online', 'none'].includes(body.newDefault as string), 'newDefault enum');
  assert.equal(typeof body.providerTemplate, 'string');
  assert.equal(typeof body.fillMissing, 'boolean');
  assert.equal(typeof body.forceAllOnline, 'boolean');
  return {
    revision: body.revision as string, newDefault: body.newDefault as string,
    providerTemplate: body.providerTemplate as string, fillMissing: body.fillMissing as boolean,
    forceAllOnline: body.forceAllOnline as boolean,
  };
}

function assertPolicyResult(value: unknown): {
  policy: ReturnType<typeof assertIconPolicy>; jobId: string | null;
} {
  assertClosedObject(value, ['policy', 'jobId'], 'PolicyResult');
  const body = value as { policy: unknown; jobId: unknown };
  assert.ok(body.jobId === null || typeof body.jobId === 'string');
  if (typeof body.jobId === 'string') assert.match(body.jobId, OBJECT_ID_PATTERN);
  return { policy: assertIconPolicy(body.policy), jobId: body.jobId as string | null };
}

function assertIconSource(value: unknown): {
  sourceMode: string; effectiveMode: string; status: string; policyRevision: string;
} {
  assertClosedObject(value, ['collectionId', 'nodeId', 'revision', 'policyRevision', 'sourceMode',
    'effectiveMode', 'iconUrl', 'iconVersion', 'directUrl', 'status', 'restorable', 'updatedAt'], 'IconSource');
  const body = value as Record<string, unknown>;
  assert.ok(['inherit', 'online', 'uploaded', 'none'].includes(body.sourceMode as string), 'sourceMode enum');
  assert.ok(['capture', 'online', 'uploaded', 'none'].includes(body.effectiveMode as string), 'effectiveMode enum');
  assert.match(body.policyRevision as string, REVISION_PATTERN);
  return {
    sourceMode: body.sourceMode as string,
    effectiveMode: body.effectiveMode as string,
    status: body.status as string,
    policyRevision: body.policyRevision as string,
  };
}

function assertIconJob(value: unknown, operation: string, statuses: readonly string[]): {
  id: string; operation: string; status: string; total: number; succeeded: number;
  failed: number; skipped: number; errors: Array<{ nodeId: string; reason: string }>;
} {
  assertClosedObject(value, ['id', 'operation', 'policyRevision', 'status', 'total', 'succeeded',
    'failed', 'skipped', 'errors', 'createdAt', 'updatedAt'], 'IconJob');
  const body = value as Record<string, unknown>;
  assert.match(body.id as string, OBJECT_ID_PATTERN);
  assert.equal(body.operation, operation);
  assert.match(body.policyRevision as string, REVISION_PATTERN);
  assert.ok(statuses.includes(body.status as string), `status ${body.status} in [${statuses.join(', ')}]`);
  for (const key of ['total', 'succeeded', 'failed', 'skipped']) {
    assert.ok(Number.isInteger(body[key]), `IconJob.${key}`);
  }
  assert.ok(Array.isArray(body.errors), 'IconJob.errors');
  assert.ok(body.errors.length <= 100, 'errors are capped at 100');
  assert.match(body.createdAt as string, TIMESTAMP_PATTERN);
  assert.match(body.updatedAt as string, TIMESTAMP_PATTERN);
  const errors = (body.errors as Array<Record<string, unknown>>).map((entry) => {
    assert.deepEqual(Object.keys(entry).sort(), ['nodeId', 'reason'].sort(), 'error entry closed');
    return { nodeId: entry.nodeId as string, reason: entry.reason as string };
  });
  return {
    id: body.id as string, operation: body.operation as string, status: body.status as string,
    total: body.total as number, succeeded: body.succeeded as number, failed: body.failed as number,
    skipped: body.skipped as number, errors,
  };
}

function assertProductError(value: unknown, codes: readonly string[]): void {
  assertClosedObject(value, ['error'], 'ProductErrorEnvelope');
  const body = value as { error: Record<string, unknown> };
  assert.deepEqual(Object.keys(body.error).sort(),
    ['code', 'message', 'requestId', 'recovery', 'sameRequestRetrySafe', 'precondition',
      'currentEtag', 'retryAfterSeconds', 'fieldErrors'].sort(), 'error envelope fields');
  const code = body.error.code as string;
  assert.ok(codes.includes(code), `error.code in [${codes.join(', ')}]`);
}

interface ApiOptions {
  readonly cookie?: string;
  readonly csrf?: string;
  readonly commandId?: string;
  readonly ifMatch?: string;
  readonly body?: unknown;
  readonly contentType?: string;
  readonly rawBody?: Buffer | string;
}

function api(method: string, url: string, options: ApiOptions = {}): Promise<ApiResponse> {
  return apiRaw(method, url, options);
}

function apiRaw(method: string, url: string, options: ApiOptions): Promise<ApiResponse & { rawBody: Buffer }> {
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
    headers['Content-Type'] = options.contentType ?? 'application/json';
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

async function seedOwnedCollection(
  runtime: IsolatedPostgresRuntime,
  input: {
    collectionId: string; rootId: string; ownerSubjectId: string;
    bookmarks: Array<{ id: string; url: string; resourceRevision: string }>;
    skipExisting?: boolean;
  },
): Promise<void> {
  const client = await runtime.runtime.pool.connect();
  try {
    await client.query('begin');
    await client.query('set constraints all deferred');
    if (!input.skipExisting) {
      await client.query(
        `insert into resource_id_ledger(resource_id, resource_type)
         values ($1, 'collection'), ($2, 'node')`,
        [input.collectionId, input.rootId],
      );
      await client.query(
        `insert into collections (
           id, owner_subject_id, title, kind, visibility, root_node_id, resource_revision,
           content_revision, policy_revision, commit_ordinal, created_at, updated_at
         ) values ($1, $2, 'FO-03 fixture', 'bookmarks', 'private', $3, 'coll-res-1',
                   'coll-content-1', 'coll-policy-1', 1, now(), now())`,
        [input.collectionId, input.ownerSubjectId, input.rootId],
      );
      await client.query(
        `insert into nodes (
           id, collection_id, parent_id, kind, is_root, title, url, position_token,
           resource_revision, children_revision, created_at, updated_at
         ) values ($1, $2, null, 'folder', true, 'Root', null, null,
                   'root-res-1', 'root-ch-1', now(), now())`,
        [input.rootId, input.collectionId],
      );
      await client.query(
        `insert into collection_members(collection_id, subject_id, role, granted_at)
         values ($1, $2, 'owner', now())`,
        [input.collectionId, input.ownerSubjectId],
      );
    }
    for (const bookmark of input.bookmarks) {
      await client.query(
        `insert into resource_id_ledger(resource_id, resource_type) values ($1, 'node') on conflict do nothing`,
        [bookmark.id],
      );
      await client.query(
        `insert into nodes (
           id, collection_id, parent_id, kind, is_root, title, url, position_token,
           resource_revision, children_revision, created_at, updated_at
         ) values ($1, $2, $3, 'bookmark', false, $4, $5, $6,
                   $7, 'ch', now(), now())
         on conflict (id) do update set url = excluded.url`,
        [bookmark.id, input.collectionId, input.rootId, bookmark.id, bookmark.url,
          bookmark.id, bookmark.resourceRevision],
      );
    }
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}