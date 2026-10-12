import { KNOWN_FAVICON_DOMAINS } from '../../../src/modules/collections/index.js';
import { isFaviconPubliclyAccessible } from '../../../src/infrastructure/database/publication-object-controls.js';
/**
 * FO-02 favicon online lifecycle (real PostgreSQL + real bootstrap routes +
 * real worker loops with an injected controlled provider).
 *
 * Covers the full single-item online chain:
 *
 *  - PUT favicon-source sourceMode=online opens; directUrl is only exposed for
 *    unshared private collections; the providerTemplate existing alone never
 *    enables online and newDefault stays capture;
 *  - refreshBookmarkFavicon (POST favicon-refresh): 202 {jobId} with receipt
 *    replay, durable job identity (account/node/URL/source/policy revision),
 *    and every negative (428/400/412/403/404/400/400);
 *  - real HTTP enqueue → real worker consume → HTTP read-back (byte hash +
 *    binding assertions), replacement version switch, failure retention;
 *  - retry/backoff, max attempts, worker-restart continuation, PUT-before /
 *    PUT-after-CAS-before / CAS-after recovery, no duplicate PUT on retry;
 *  - SSRF (DNS-denied, redirect escape, userinfo/non-HTTPS template) and
 *    streaming limits (bytes, decompressed, timeout, type, decode);
 *  - GC: durable pending records with the retention window, reference
 *    protection, delete-failure retry, duplicate-consumption safety;
 *  - public↔private keeps the effective icon; flag-off 404; visitors never
 *    receive a private directUrl.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { deflateSync, gzipSync } from 'node:zlib';
import { afterAll, beforeAll, test } from 'vitest';
import { loadConfig } from '../../support/test-config.js';
import { buildWorker } from '../../../src/bootstrap/worker.js';
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
import { InMemoryMetrics } from '../../../src/infrastructure/telemetry/index.js';
import { buildApiApp } from '../../../src/transport/app.js';
import { issueTestSession, createPostgresBetterAuthTestFactory } from '../../support/better-auth-test-factory.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';
import {
  processFaviconRefreshClaim,
  verifyFaviconRefreshIdentity,
  type FaviconRefreshExecutionPorts,
} from '../../../src/modules/collections/index.js';
import { faviconCrc32 } from '../../../src/modules/collections/application/favicon-image-decode.js';

const ORIGIN = 'https://app.example.test';
const ISSUER = 'https://issuer.example.test/realms/known';
const PUBLIC_PIN = '93.184.216.34';
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const REVISION_PATTERN = /^[1-9][0-9]{0,18}$/u;
const OBJECT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const DEFAULT_TEMPLATE = 'https://favicone.com/{hostname}';

/** Fully valid (CRC-correct, inflatable) truecolor PNG. */
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
const PNG_V3 = buildPng(3, 2);

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
  gets: number;
  failPut: boolean;
  failDelete: boolean;
  put(objectId: string, body: Buffer, contentType: string): Promise<void>;
  get(objectId: string): Promise<{ contentType: string; body: Buffer } | null>;
  delete(objectId: string): Promise<void>;
}

function createTestFaviconStore(): Store {
  const objects = new Map<string, { contentType: string; body: Buffer }>();
  return {
    objects,
    puts: [],
    deletes: [],
    gets: 0,
    failPut: false,
    failDelete: false,
    async put(objectId, body, contentType) {
      if (this.failPut) throw new Error('test store put failed');
      this.puts.push(objectId);
      objects.set(objectId, { contentType, body: Buffer.from(body) });
    },
    async get(objectId) {
      this.gets += 1;
      const row = objects.get(objectId);
      return row === undefined ? null : { contentType: row.contentType, body: Buffer.from(row.body) };
    },
    async delete(objectId) {
      if (this.failDelete) throw new Error('test store delete failed');
      this.deletes.push(objectId);
      objects.delete(objectId);
    },
  };
}

interface ProviderBehavior {
  status?: number;
  body?: Buffer;
  headers?: Record<string, string>;
  redirectTo?: string;
  hang?: boolean;
}

interface Provider {
  behavior: ProviderBehavior;
  hits: string[];
  resolve(hostname: string): Promise<readonly string[]>;
  connect(target: { url: URL; ip: string; family: 4 | 6 }, init: RequestInit): Promise<Response>;
}

function createProvider(): Provider {
  const provider: Provider = {
    behavior: { status: 200, body: PNG_V1 },
    hits: [],
    async resolve(hostname) {
      // Reject private DNS for the SSRF tests; production resolves ALL records
      // and fails closed on any denied one.
      if (hostname === 'private.example') return ['10.0.0.1'];
      return [PUBLIC_PIN];
    },
    async connect(target, init) {
      provider.hits.push(target.url.href);
      const headers = new Headers(init.headers);
      assert.equal(headers.get('cookie'), null, 'favicon fetch must never send Cookie');
      assert.equal(headers.get('authorization'), null, 'favicon fetch must never send Authorization');
      assert.equal(headers.get('user-agent'), 'Known-Favicon/1');
      const behavior = provider.behavior;
      if (behavior.hang === true) {
        return new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            reject(new DOMException('The operation was aborted.', 'AbortError'));
          }, { once: true });
        });
      }
      if (behavior.redirectTo !== undefined) {
        return new Response(null, { status: 302, headers: { location: behavior.redirectTo } });
      }
      const body = behavior.body ?? PNG_V1;
      return new Response(body, {
        status: behavior.status ?? 200,
        headers: behavior.headers,
      });
    },
  };
  return provider;
}

describeWithPostgres('FO-02 favicon online lifecycle (HTTP → durable job → worker → pinned object)', () => {
  let isolated: IsolatedPostgresRuntime;
  let factory: ReturnType<typeof createPostgresBetterAuthTestFactory>;
  let owner: { cookie: string; csrfToken: string; accountId: string; subjectId: string };
  let other: { cookie: string; csrfToken: string; accountId: string; subjectId: string };
  let stranger: { cookie: string; csrfToken: string; accountId: string; subjectId: string };
  let config: ReturnType<typeof loadConfig>;

  const PRIVATE_COLLECTION = 'fo02-private-collection-0001';
  const PRIVATE_ROOT = 'fo02-private-root-0000001';
  const PRIVATE_BOOKMARK = 'fo02-private-bookmark-0001';
  const SHARED_COLLECTION = 'fo02-shared-collection-0001';
  const SHARED_ROOT = 'fo02-shared-root-0000001';
  const SHARED_BOOKMARK = 'fo02-shared-bookmark-0001';

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('fo02_favicon_online', { maxConnections: 10 });
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
      subject: `fo02-owner-${randomUUID()}`, handle: `fo2o${randomUUID().replaceAll('-', '').slice(0, 12)}` });
    other = await issueTestSession({ factory,
      subject: `fo02-other-${randomUUID()}`, handle: `fo2r${randomUUID().replaceAll('-', '').slice(0, 12)}` });
    stranger = await issueTestSession({ factory,
      subject: `fo02-stranger-${randomUUID()}`, handle: `fo2s${randomUUID().replaceAll('-', '').slice(0, 12)}` });
    // Unshared private collection (owner member only).
    await seedOwnedCollection(isolated, {
      collectionId: PRIVATE_COLLECTION,
      rootId: PRIVATE_ROOT,
      bookmarkId: PRIVATE_BOOKMARK,
      ownerSubjectId: owner.subjectId,
      bookmarkUrl: 'https://bookmarks.example.org/fo02-private',
      resourceRevision: 'fo02-priv-res-1',
    });
    // Shared collection with a non-owner editor member.
    await seedOwnedCollection(isolated, {
      collectionId: SHARED_COLLECTION,
      rootId: SHARED_ROOT,
      bookmarkId: SHARED_BOOKMARK,
      ownerSubjectId: owner.subjectId,
      bookmarkUrl: 'https://bookmarks.example.org/fo02-shared',
      resourceRevision: 'fo02-shared-res-1',
    });
    await isolated.runtime.pool.query(
      `insert into collection_members(collection_id, subject_id, role, granted_at)
       values ($1, $2, 'editor', now())`,
      [SHARED_COLLECTION, other.subjectId],
    );
  }, 180_000);

  afterAll(async () => isolated?.close());

  function buildApp(overrides: Partial<ReturnType<typeof loadConfig>> = {}, store?: Store) {
    return buildApiApp({
      config: { ...config, ...overrides },
      identityUnitOfWork: createPostgresIdentityUnitOfWork(isolated.runtime.db),
      collectionsUnitOfWork: createPostgresCollectionsUnitOfWork(isolated.runtime.db),
      productCollectionMutationUnitOfWork: createPostgresCanonicalMutationUnitOfWork(
        isolated.runtime.db, { productOrigin: ORIGIN }),
      browserSessionAuthority: factory.authority,
      faviconPublicAccess: { isPubliclyAccessible: objectId => isFaviconPubliclyAccessible(isolated.runtime.db, objectId, KNOWN_FAVICON_DOMAINS) },
      faviconStore: store ?? createTestFaviconStore(),
    });
  }

  function makeWorker(store: Store, provider: Provider, workerId = 'fo02-worker',
    overrides: Partial<Parameters<typeof createFaviconWorkerRuntime>[0]['options'] & { fetchTimeoutMs?: number }> = {},
    now?: () => Date) {
    const options = {
      maxAttempts: 5,
      backoffSeconds: [1, 2, 4, 8, 16] as readonly number[],
      retentionSeconds: 31_536_000,
      maxBytes: 65_536,
      maxDecompressedBytes: 65_536 * 64,
      fetchTimeoutMs: 10_000,
      maxRedirects: 3,
      ...overrides,
    };
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
      now: now ?? (() => new Date()),
      options,
    });
  }

  function makeFormalWorker(store: Store, provider: Provider) {
    return buildWorker(config, isolated.runtime, new InMemoryMetrics(), {
      favicon: { store, resolve: provider.resolve, connect: provider.connect },
    });
  }

  /** Direct refresh-one execution ports for driving one claim step-by-step. */
  function makeRefreshExecutionPorts(store: Store, provider: Provider): FaviconRefreshExecutionPorts {
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
      },
    };
  }

  async function setOnline(collectionId: string, nodeId: string, appAddress: string, cookie: string, csrf: string): Promise<ApiResponse> {
    const current = await api('GET', `${appAddress}/api/v1/collections/${collectionId}/nodes/${nodeId}/favicon-source`,
      { cookie });
    assert.equal(current.status, 200);
    return api('PUT', `${appAddress}/api/v1/collections/${collectionId}/nodes/${nodeId}/favicon-source`, {
      cookie, csrf, commandId: randomUUID(),
      ifMatch: `${current.headers.etag ?? ''}`,
      body: { sourceMode: 'online' },
    });
  }

  async function enqueueRefresh(collectionId: string, nodeId: string, appAddress: string,
    cookie: string, csrf: string, options: { ifMatch?: string; commandId?: string } = {}): Promise<ApiResponse> {
    const source = await api('GET', `${appAddress}/api/v1/collections/${collectionId}/nodes/${nodeId}/favicon-source`,
      { cookie });
    assert.equal(source.status, 200);
    return api('POST', `${appAddress}/api/v1/collections/${collectionId}/nodes/${nodeId}/favicon-refresh`, {
      cookie, csrf,
      commandId: options.commandId ?? randomUUID(),
      ifMatch: options.ifMatch ?? `${source.headers.etag ?? ''}`,
    });
  }

  async function runWorkerOnce(worker: { jobs: { runOnce(): Promise<boolean> } }, times = 1) {
    for (let i = 0; i < times; i += 1) {
      // Force any scheduled retry window open so the loop can consume it.
      await isolated.runtime.pool.query(
        `update favicon_jobs set next_attempt_at = current_timestamp
         where status = 'pending' and next_attempt_at > current_timestamp`);
      await worker.jobs.runOnce();
    }
  }

  test('online source: PUT opens it, directUrl only for unshared private, template alone never enables online', async () => {
    const app = buildApp();
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    try {
      // The default providerTemplate exists, but inherit still projects the
      // account newDefault (capture) — the template alone never enables online.
      const inherit = await api('GET', `${address}/api/v1/collections/${PRIVATE_COLLECTION}/nodes/${PRIVATE_BOOKMARK}/favicon-source`,
        { cookie: owner.cookie });
      assert.equal(inherit.status, 200);
      const inheritView = assertIconSource(inherit.json);
      assert.equal(inheritView.sourceMode, 'inherit');
      assert.equal(inheritView.effectiveMode, 'capture');
      assert.equal(inheritView.directUrl, null);

      const online = await setOnline(PRIVATE_COLLECTION, PRIVATE_BOOKMARK, address, owner.cookie, owner.csrfToken);
      assert.equal(online.status, 200, `body: ${JSON.stringify(online.json)}`);
      const view = assertIconSource(online.json);
      assert.equal(view.sourceMode, 'online');
      assert.equal(view.effectiveMode, 'online');
      assert.equal(view.status, 'missing');
      assert.equal(view.iconUrl, null);
      assert.equal(view.directUrl, 'https://favicone.com/bookmarks.example.org');

      // newDefault stays capture: selecting online never changes the policy.
      const policy = await api('GET', `${address}/api/v1/me/favicon-policy`, { cookie: owner.cookie });
      assert.equal(assertIconPolicy(policy.json).newDefault, 'capture');

      // Shared-readable (member present) online: directUrl is never exposed.
      await setOnline(SHARED_COLLECTION, SHARED_BOOKMARK, address, owner.cookie, owner.csrfToken);
      const shared = await api('GET', `${address}/api/v1/collections/${SHARED_COLLECTION}/nodes/${SHARED_BOOKMARK}/favicon-source`,
        { cookie: owner.cookie });
      assert.equal(shared.status, 200);
      const sharedView = assertIconSource(shared.json);
      assert.equal(sharedView.sourceMode, 'online');
      assert.equal(sharedView.directUrl, null);

      // No-op PUT keeps the same revision.
      const noop = await api('PUT', `${address}/api/v1/collections/${PRIVATE_COLLECTION}/nodes/${PRIVATE_BOOKMARK}/favicon-source`, {
        cookie: owner.cookie, csrf: owner.csrfToken, commandId: randomUUID(),
        ifMatch: `${online.headers.etag ?? ''}`,
        body: { sourceMode: 'online' },
      });
      assert.equal(noop.status, 200);
      assert.equal(assertIconSource(noop.json).revision, view.revision);
    } finally { await app.close(); }
  });

  test('refreshBookmarkFavicon: 202 jobId, receipt replay, durable identity, negatives', async () => {
    const app = buildApp();
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const path = `${address}/api/v1/collections/${PRIVATE_COLLECTION}/nodes/${PRIVATE_BOOKMARK}/favicon-refresh`;
    const commandId = randomUUID();
    try {
      const source = await api('GET', `${address}/api/v1/collections/${PRIVATE_COLLECTION}/nodes/${PRIVATE_BOOKMARK}/favicon-source`,
        { cookie: owner.cookie });
      const etag = `${source.headers.etag ?? ''}`;
      // While the job is pending the source status projects 'pending'.
      const accepted = await api('POST', path, {
        cookie: owner.cookie, csrf: owner.csrfToken, commandId, ifMatch: etag,
      });
      assert.equal(accepted.status, 202);
      assert.equal(accepted.headers['cache-control'], 'private, no-store');
      assert.equal(accepted.headers.etag, etag);
      const body = assertIconJobAccepted(accepted.json);
      assert.match(body.jobId, OBJECT_ID_PATTERN);

      const pending = await api('GET', `${address}/api/v1/collections/${PRIVATE_COLLECTION}/nodes/${PRIVATE_BOOKMARK}/favicon-source`,
        { cookie: owner.cookie });
      assert.equal(assertIconSource(pending.json).status, 'pending');

      // Durable job identity: account, node, URL, source revision, policy revision.
      const row = (await isolated.runtime.pool.query(
        `select operation, account_id, owner_subject_id, node_id, collection_id, source_url,
                source_revision, policy_revision, status, total
         from favicon_jobs where id = $1`, [body.jobId])).rows[0] as Record<string, unknown>;
      assert.deepEqual(row, {
        operation: 'refresh_one', account_id: owner.accountId, owner_subject_id: owner.subjectId,
        node_id: PRIVATE_BOOKMARK, collection_id: PRIVATE_COLLECTION,
        source_url: 'https://favicone.com/bookmarks.example.org',
        source_revision: '2', policy_revision: '1', status: 'pending', total: 1,
      });

      // Exact replay (same command id + request, now-old If-Match) replays the saved 202.
      const replay = await api('POST', path, {
        cookie: owner.cookie, csrf: owner.csrfToken, commandId, ifMatch: etag,
      });
      assert.equal(replay.status, 202);
      assert.equal(assertIconJobAccepted(replay.json).jobId, body.jobId);
      assert.equal(replay.headers.etag, etag);

      // A different node is a different command scope (per-node receipt), so a
      // command id reuse there is a legitimate new command, not a fingerprint
      // clash: empty-body commands cannot vary within their scope.
    } finally { await app.close(); }
  });

  test('refreshBookmarkFavicon negatives: precondition, stale, body/query, authz, non-online', async () => {
    const app = buildApp();
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const path = `${address}/api/v1/collections/${PRIVATE_COLLECTION}/nodes/${PRIVATE_BOOKMARK}/favicon-refresh`;
    const sourcePath = `${address}/api/v1/collections/${PRIVATE_COLLECTION}/nodes/${PRIVATE_BOOKMARK}/favicon-source`;
    try {
      // Missing If-Match → 428; malformed → 400.
      const missing = await api('POST', path, { cookie: owner.cookie, csrf: owner.csrfToken, commandId: randomUUID() });
      assert.equal(missing.status, 428);
      assertProductError(missing.json, ['precondition_required']);
      for (const bad of ['W/"x"', '*', '"a","b"', 'plain']) {
        const malformed = await api('POST', path, {
          cookie: owner.cookie, csrf: owner.csrfToken, commandId: randomUUID(), ifMatch: bad,
        });
        assert.equal(malformed.status, 400, `If-Match ${bad}`);
        assertProductError(malformed.json, ['invalid_request']);
      }
      // Stale If-Match → 412 with the current ETag.
      const current = await api('GET', sourcePath, { cookie: owner.cookie });
      const currentEtag = current.headers.etag ?? '';
      const stale = await api('POST', path, {
        cookie: owner.cookie, csrf: owner.csrfToken, commandId: randomUUID(),
        ifMatch: '"favicon-source:fo02-priv-res-1:1"',
      });
      assert.equal(stale.status, 412);
      const staleError = assertProductError(stale.json, ['precondition_failed']);
      assert.equal(staleError.currentEtag, currentEtag);

      // Body and query rejected.
      const withBody = await api('POST', path, {
        cookie: owner.cookie, csrf: owner.csrfToken, commandId: randomUUID(),
        ifMatch: currentEtag, body: { force: true }, contentType: 'application/json',
      });
      assert.equal(withBody.status, 400);
      const withQuery = await api('POST', `${path}?x=1`, {
        cookie: owner.cookie, csrf: owner.csrfToken, commandId: randomUUID(), ifMatch: currentEtag,
      });
      assert.equal(withQuery.status, 400);
      assertProductError(withQuery.json, ['invalid_query']);

      // Authorization: editor 403 (member of the SHARED collection), stranger
      // 404 on the private one, folder 400.
      const editor = await api('POST',
        `${address}/api/v1/collections/${SHARED_COLLECTION}/nodes/${SHARED_BOOKMARK}/favicon-refresh`, {
          cookie: other.cookie, csrf: other.csrfToken, commandId: randomUUID(), ifMatch: currentEtag,
        });
      assert.equal(editor.status, 403);
      assertProductError(editor.json, ['insufficient_permission']);
      const strangerCall = await api('POST', path, {
        cookie: stranger.cookie, csrf: stranger.csrfToken, commandId: randomUUID(), ifMatch: currentEtag,
      });
      assert.equal(strangerCall.status, 404);
      const folder = await api('POST',
        `${address}/api/v1/collections/${PRIVATE_COLLECTION}/nodes/${PRIVATE_ROOT}/favicon-refresh`, {
          cookie: owner.cookie, csrf: owner.csrfToken, commandId: randomUUID(),
          ifMatch: '"favicon-source:fo02-priv-root:1"',
        });
      assert.equal(folder.status, 400);

      // Non-online effective source is a 400.
      await api('PUT', sourcePath, {
        cookie: owner.cookie, csrf: owner.csrfToken, commandId: randomUUID(),
        ifMatch: currentEtag, body: { sourceMode: 'none' },
      });
      // The mode change advanced the source revision; refresh against the
      // fresh ETag then rejects the non-online effective source with 400.
      const afterNone = await api('GET', sourcePath, { cookie: owner.cookie });
      const notOnline = await api('POST', path, {
        cookie: owner.cookie, csrf: owner.csrfToken, commandId: randomUUID(),
        ifMatch: `${afterNone.headers.etag ?? ''}`,
      });
      assert.equal(notOnline.status, 400);
      assertProductError(notOnline.json, ['invalid_request']);
    } finally { await app.close(); }
  });

  test('real HTTP enqueue → formal worker consumes → HTTP read-back with byte hash', async () => {
    const store = createTestFaviconStore();
    const app = buildApp({}, store);
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const provider = createProvider();
    try {
      const node = 'fo02-chain-bookmark-0001';
      await reseedBookmark(isolated, PRIVATE_COLLECTION, PRIVATE_ROOT, node, 'https://chain.example.org/one', 'fo02-chain-res-1');
      await setOnline(PRIVATE_COLLECTION, node, address, owner.cookie, owner.csrfToken);
      const accepted = await enqueueRefresh(PRIVATE_COLLECTION, node, address, owner.cookie, owner.csrfToken);
      assert.equal(accepted.status, 202);
      const { jobId } = assertIconJobAccepted(accepted.json);

      const worker = makeFormalWorker(store, provider);
      assert.ok(worker.faviconJobs);
      assert.equal(await worker.faviconJobs!.jobs.runOnce(), true);

      const job = (await isolated.runtime.pool.query(
        `select status, succeeded, failed, error_node_id, error_reason, object_id
         from favicon_jobs where id = $1`, [jobId])).rows[0] as Record<string, unknown>;
      assert.deepEqual({ ...job, status: job.status, succeeded: Number(job.succeeded), failed: Number(job.failed) },
        { status: 'succeeded', succeeded: 1, failed: 0, error_node_id: null, error_reason: null, object_id: job.object_id });
      const objectId = job.object_id as string;
      assert.match(objectId, OBJECT_ID_PATTERN);

      // Binding switched; the source read-back resolves the pinned object.
      const binding = (await isolated.runtime.pool.query(
        `select object_id, content_type, byte_size from bookmark_icons where node_id = $1`, [node])).rows[0] as
        { object_id: string; content_type: string; byte_size: number };
      assert.equal(binding.object_id, objectId);
      assert.equal(binding.content_type, 'image/png');

      const source = await api('GET', `${address}/api/v1/collections/${PRIVATE_COLLECTION}/nodes/${node}/favicon-source`,
        { cookie: owner.cookie });
      assert.equal(source.status, 200);
      const view = assertIconSource(source.json);
      assert.equal(view.status, 'ready');
      assert.equal(view.effectiveMode, 'online');
      assert.equal(view.iconVersion, objectId);
      assert.equal(view.iconUrl, `${ORIGIN}/api/v1/favicon/${objectId}`);

      // HTTP byte read-back: the pinned object serves exactly the provider bytes.
      await isolated.runtime.pool.query("update collections set visibility='public',publication_slug='ci-favicon-'||md5(id),published_at=now() where id=$1", [PRIVATE_COLLECTION]);
      const get = await apiRaw('GET', `${address}/api/v1/favicon/${objectId}`, {});
      await isolated.runtime.pool.query("update collections set visibility='private',publication_slug=null,published_at=null where id=$1", [PRIVATE_COLLECTION]);
      assert.equal(get.status, 200);
      assert.equal(get.headers['content-type'], 'image/png');
      assert.equal(get.headers['cache-control'], 'public, max-age=30, must-revalidate');
      const raw = get.rawBody as string;
      const fetched: Buffer = Buffer.from(raw, 'latin1');
      assert.equal(createHash('sha256').update(fetched).digest('hex'),
        createHash('sha256').update(PNG_V1).digest('hex'));
    } finally { await app.close(); }
  });

  test('replacement switches the version and retires the old object into the retention record', async () => {
    const app = buildApp();
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const store = createTestFaviconStore();
    const provider = createProvider();
    try {
      const node = 'fo02-version-bookmark-0001';
      await reseedBookmark(isolated, PRIVATE_COLLECTION, PRIVATE_ROOT, node, 'https://version.example.org/swap', 'fo02-ver-res-1');
      await setOnline(PRIVATE_COLLECTION, node, address, owner.cookie, owner.csrfToken);

      provider.behavior = { status: 200, body: PNG_V1 };
      assertIconJobAccepted((await enqueueRefresh(PRIVATE_COLLECTION, node, address, owner.cookie, owner.csrfToken)).json);
      await runWorkerOnce(makeWorker(store, provider, 'fo02-ver-worker-1'));
      const firstBinding = (await isolated.runtime.pool.query(
        `select object_id from bookmark_icons where node_id = $1`, [node])).rows[0] as { object_id: string };

      provider.behavior = { status: 200, body: PNG_V2 };
      assertIconJobAccepted((await enqueueRefresh(PRIVATE_COLLECTION, node, address, owner.cookie, owner.csrfToken)).json);
      await runWorkerOnce(makeWorker(store, provider, 'fo02-ver-worker-2'));
      const secondBinding = (await isolated.runtime.pool.query(
        `select object_id from bookmark_icons where node_id = $1`, [node])).rows[0] as { object_id: string };
      assert.notEqual(secondBinding.object_id, firstBinding.object_id);

      // The old object is durably recorded for GC with the full retention
      // window, and is still serving (never deleted while within retention).
      const pending = (await isolated.runtime.pool.query(
        `select object_id, retired_at, deletable_at from favicon_pending_deletions
         where object_id = $1`, [firstBinding.object_id])).rows[0] as
        { object_id: string; retired_at: Date; deletable_at: Date };
      assert.equal(pending.object_id, firstBinding.object_id);
      assert.equal(pending.deletable_at.getTime() - pending.retired_at.getTime(), 31_536_000 * 1_000);
      assert.equal(store.objects.has(firstBinding.object_id), true);
      assert.equal(store.deletes.includes(firstBinding.object_id), false);

      // The read-back serves the NEW bytes after the switch.
      const source = await api('GET', `${address}/api/v1/collections/${PRIVATE_COLLECTION}/nodes/${node}/favicon-source`,
        { cookie: owner.cookie });
      assert.equal(assertIconSource(source.json).iconVersion, secondBinding.object_id);
    } finally { await app.close(); }
  });

  test('replacement failure keeps the old binding renderable (never clears the valid binding)', async () => {
    const app = buildApp();
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const store = createTestFaviconStore();
    const provider = createProvider();
    try {
      const node = 'fo02-failkeep-bookmark-0001';
      await reseedBookmark(isolated, PRIVATE_COLLECTION, PRIVATE_ROOT, node, 'https://keep.example.org/old', 'fo02-keep-res-1');
      await setOnline(PRIVATE_COLLECTION, node, address, owner.cookie, owner.csrfToken);

      provider.behavior = { status: 200, body: PNG_V1 };
      await enqueueRefresh(PRIVATE_COLLECTION, node, address, owner.cookie, owner.csrfToken);
      await runWorkerOnce(makeWorker(store, provider, 'fo02-keep-w1'));
      const good = (await isolated.runtime.pool.query(
        `select object_id from bookmark_icons where node_id = $1`, [node])).rows[0] as { object_id: string };

      provider.behavior = { status: 500, body: Buffer.from('boom'), headers: { 'content-type': 'text/plain' } };
      await enqueueRefresh(PRIVATE_COLLECTION, node, address, owner.cookie, owner.csrfToken);
      // The retry envelope runs to exhaustion; the old binding stays put.
      const failingWorker = makeWorker(store, provider, 'fo02-keep-w2');
      for (let i = 0; i < 5; i += 1) {
        await runWorkerOnce(failingWorker);
      }

      const source = await api('GET', `${address}/api/v1/collections/${PRIVATE_COLLECTION}/nodes/${node}/favicon-source`,
        { cookie: owner.cookie });
      const view = assertIconSource(source.json);
      assert.equal(view.status, 'failed');
      assert.equal(view.iconUrl, `${ORIGIN}/api/v1/favicon/${good.object_id}`);
      const binding = (await isolated.runtime.pool.query(
        `select object_id from bookmark_icons where node_id = $1`, [node])).rows[0] as { object_id: string };
      assert.equal(binding.object_id, good.object_id, 'failed replacement must not clear the valid binding');
      assert.equal(store.objects.has(good.object_id), true, 'old object must survive the failed replacement');
    } finally { await app.close(); }
  });

  test('retry with backoff then success; no duplicate PUT across the retry', async () => {
    const app = buildApp();
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const store = createTestFaviconStore();
    const provider = createProvider();
    try {
      const node = 'fo02-retry-bookmark-0001';
      await reseedBookmark(isolated, PRIVATE_COLLECTION, PRIVATE_ROOT, node, 'https://retry.example.org/r', 'fo02-retry-res-1');
      await setOnline(PRIVATE_COLLECTION, node, address, owner.cookie, owner.csrfToken);
      const accepted = await enqueueRefresh(PRIVATE_COLLECTION, node, address, owner.cookie, owner.csrfToken);
      const { jobId } = assertIconJobAccepted(accepted.json);

      provider.behavior = { status: 503, body: Buffer.from('down') };
      await runWorkerOnce(makeWorker(store, provider, 'fo02-retry-w1'));
      let job = (await isolated.runtime.pool.query(
        `select status, attempts, error_reason, next_attempt_at from favicon_jobs where id = $1`, [jobId])).rows[0] as
        { status: string; attempts: string; error_reason: string | null; next_attempt_at: Date | null };
      assert.equal(job.status, 'pending');
      assert.equal(Number(job.attempts), 1);
      assert.equal(job.error_reason, 'fetch_failed');
      assert.ok(job.next_attempt_at !== null && job.next_attempt_at.getTime() > Date.now());

      // A backoff retry must locate the same durable job and never PUT twice.
      provider.behavior = { status: 200, body: PNG_V3 };
      await runWorkerOnce(makeWorker(store, provider, 'fo02-retry-w2'));
      job = (await isolated.runtime.pool.query(
        `select status, attempts, succeeded, error_reason from favicon_jobs where id = $1`, [jobId])).rows[0] as
        { status: string; attempts: string; succeeded: string; error_reason: string | null };
      assert.equal(job.status, 'succeeded');
      assert.equal(Number(job.succeeded), 1);
      assert.equal(Number(job.attempts), 1, 'attempts counts failures; the second run succeeded');
      assert.equal(job.error_reason, null);
      assert.equal(store.puts.length, 1, 'retry must not PUT a second object');
      const binding = (await isolated.runtime.pool.query(
        `select object_id from bookmark_icons where node_id = $1`, [node])).rows[0] as { object_id: string };
      assert.equal(binding.object_id, store.puts[0]);
    } finally { await app.close(); }
  });

  test('max attempts exhausts to failed with the last reason and no binding', async () => {
    const app = buildApp();
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const store = createTestFaviconStore();
    const provider = createProvider();
    try {
      const node = 'fo02-exhaust-bookmark-0001';
      await reseedBookmark(isolated, PRIVATE_COLLECTION, PRIVATE_ROOT, node, 'https://exhaust.example.org/x', 'fo02-ex-res-1');
      await setOnline(PRIVATE_COLLECTION, node, address, owner.cookie, owner.csrfToken);
      const { jobId } = assertIconJobAccepted(
        (await enqueueRefresh(PRIVATE_COLLECTION, node, address, owner.cookie, owner.csrfToken)).json);

      provider.behavior = { status: 500, body: Buffer.from('x') };
      const worker = makeWorker(store, provider, 'fo02-ex-w1');
      for (let i = 0; i < 5; i += 1) {
        await runWorkerOnce(worker);
      }
      const job = (await isolated.runtime.pool.query(
        `select status, attempts, error_reason from favicon_jobs where id = $1`, [jobId])).rows[0] as
        { status: string; attempts: string; error_reason: string | null };
      assert.equal(job.status, 'failed');
      assert.equal(Number(job.attempts), 5);
      assert.equal(job.error_reason, 'fetch_failed');
      const binding = await isolated.runtime.pool.query(
        `select count(*)::int n from bookmark_icons where node_id = $1`, [node]);
      assert.equal(binding.rows[0]?.n, 0);
      assert.equal(store.puts.length, 0);
    } finally { await app.close(); }
  });

  test('SSRF: DNS denial, redirect escape, and unsafe provider templates are refused', async () => {
    const app = buildApp();
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const store = createTestFaviconStore();
    const provider = createProvider();
    try {
      const node = 'fo02-ssrf-bookmark-0001';
      await reseedBookmark(isolated, PRIVATE_COLLECTION, PRIVATE_ROOT, node, 'https://ssrf.example.org/s', 'fo02-ssrf-res-1');
      await setOnline(PRIVATE_COLLECTION, node, address, owner.cookie, owner.csrfToken);
      const source = await api('GET', `${address}/api/v1/collections/${PRIVATE_COLLECTION}/nodes/${node}/favicon-source`,
        { cookie: owner.cookie });

      // DNS rebinding: the provider host resolves to a private address.
      provider.behavior = { status: 200, body: PNG_V1 };
      provider.resolve = async () => ['10.0.0.1'];
      const denied = await api('POST', `${address}/api/v1/collections/${PRIVATE_COLLECTION}/nodes/${node}/favicon-refresh`, {
        cookie: owner.cookie, csrf: owner.csrfToken, commandId: randomUUID(),
        ifMatch: `${source.headers.etag ?? ''}`,
      });
      assert.equal(denied.status, 202);
      const { jobId } = assertIconJobAccepted(denied.json);
      await runWorkerOnce(makeWorker(store, provider, 'fo02-ssrf-w1'));
      const deniedJob = (await isolated.runtime.pool.query(
        `select status, error_reason, attempts from favicon_jobs where id = $1`, [jobId])).rows[0] as
        { status: string; error_reason: string | null; attempts: string };
      assert.equal(deniedJob.status, 'failed');
      assert.equal(deniedJob.error_reason, 'unsafe_source');
      assert.equal(Number(deniedJob.attempts), 1, 'unsafe_source must be terminal (no retry)');

      // Redirect escape: the provider redirects to a metadata address.
      provider.resolve = providerResolvePublic;
      provider.behavior = { status: 200, body: PNG_V1, redirectTo: 'http://169.254.169.254/latest/meta-data' };
      const escaped = await api('POST', `${address}/api/v1/collections/${PRIVATE_COLLECTION}/nodes/${node}/favicon-refresh`, {
        cookie: owner.cookie, csrf: owner.csrfToken, commandId: randomUUID(),
        ifMatch: `${source.headers.etag ?? ''}`,
      });
      const { jobId: escapedId } = assertIconJobAccepted(escaped.json);
      await runWorkerOnce(makeWorker(store, provider, 'fo02-ssrf-w2'));
      const escapedJob = (await isolated.runtime.pool.query(
        `select status, error_reason from favicon_jobs where id = $1`, [escapedId])).rows[0] as
        { status: string; error_reason: string | null };
      assert.equal(escapedJob.status, 'failed');
      assert.equal(escapedJob.error_reason, 'unsafe_source');

      // Unsafe provider template (userinfo / non-HTTPS / loopback) is refused
      // at enqueue time with 400 — the job is never created.
      provider.behavior = { status: 200, body: PNG_V1 };
      await isolated.runtime.pool.query(
        `insert into account_favicon_policies (
           account_id, new_default, provider_template, fill_missing, force_all_online, revision, updated_at
         ) values ($1, 'capture', $2, false, false, 1, now())
         on conflict (account_id) do nothing`,
        [owner.accountId, DEFAULT_TEMPLATE],
      );
      const jobsBefore = (await isolated.runtime.pool.query(
        `select count(*)::int n from favicon_jobs where node_id = $1`, [node])).rows[0]?.n as number;
      for (const template of [
        'https://user:pass@favicone.com/{hostname}',
        'http://favicone.com/{hostname}',
        'https://127.0.0.1/{hostname}',
      ]) {
        await isolated.runtime.pool.query(
          `update account_favicon_policies set provider_template = $1
           where account_id = $2`, [template, owner.accountId]);
        const bad = await api('POST', `${address}/api/v1/collections/${PRIVATE_COLLECTION}/nodes/${node}/favicon-refresh`, {
          cookie: owner.cookie, csrf: owner.csrfToken, commandId: randomUUID(),
          ifMatch: `${source.headers.etag ?? ''}`,
        });
        assert.equal(bad.status, 400, `template ${template}`);
        assertProductError(bad.json, ['invalid_request']);
        const created = await isolated.runtime.pool.query(
          `select count(*)::int n from favicon_jobs where node_id = $1`, [node]);
        assert.equal(created.rows[0]?.n, jobsBefore, 'job must not be created for an unsafe template');
      }
      await isolated.runtime.pool.query(
        `update account_favicon_policies set provider_template = $1
         where account_id = $2`, [DEFAULT_TEMPLATE, owner.accountId]);
    } finally { await app.close(); }
  });

  test('streaming limits: bytes, decompressed, timeout, type and decode all fail invalid_image/fetch', async () => {
    const app = buildApp();
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const store = createTestFaviconStore();
    const provider = createProvider();
    const node = 'fo02-limits-bookmark-0001';
    await reseedBookmark(isolated, PRIVATE_COLLECTION, PRIVATE_ROOT, node, 'https://limits.example.org/l', 'fo02-lim-res-1');
    await setOnline(PRIVATE_COLLECTION, node, address, owner.cookie, owner.csrfToken);
    const source = await api('GET', `${address}/api/v1/collections/${PRIVATE_COLLECTION}/nodes/${node}/favicon-source`,
      { cookie: owner.cookie });
    const etag = `${source.headers.etag ?? ''}`;

    async function expectFailure(behavior: ProviderBehavior, reason: string, timeoutMs = 10_000): Promise<void> {
      provider.behavior = behavior;
      provider.resolve = providerResolvePublic;
      const accepted = await api('POST', `${address}/api/v1/collections/${PRIVATE_COLLECTION}/nodes/${node}/favicon-refresh`, {
        cookie: owner.cookie, csrf: owner.csrfToken, commandId: randomUUID(), ifMatch: etag,
      });
      assert.equal(accepted.status, 202);
      const { jobId } = assertIconJobAccepted(accepted.json);
      await runWorkerOnce(makeWorker(store, provider, 'fo02-lim-w1', { maxAttempts: 1, fetchTimeoutMs: timeoutMs }));
      const job = await isolated.runtime.pool.query(
        `select status, error_reason from favicon_jobs where id = $1`, [jobId]);
      const row = job.rows[0] as { status: string; error_reason: string | null };
      assert.equal(row.status, 'failed');
      assert.equal(row.error_reason, reason);
    }

    try {
      // Byte cap: a body over FAVICON_FETCH_MAX_BYTES is stream-capped.
      await expectFailure({ status: 200, body: Buffer.concat([PNG_V1, Buffer.alloc(70_000, 0)]) }, 'invalid_image');
      // Decompressed cap: gzip of 16MB of zeros inflates past the budget.
      await expectFailure({
        status: 200,
        body: gzipSync(Buffer.alloc(16 * 1024 * 1024, 0)),
        headers: { 'content-encoding': 'gzip' },
      }, 'invalid_image');
      // Type: HTML is not a raster.
      await expectFailure({ status: 200, body: Buffer.from('<html></html>') }, 'invalid_image');
      // Decode: corrupt PNG magic.
      await expectFailure({ status: 200, body: Buffer.concat([PNG_V1.subarray(0, 12), Buffer.alloc(100)]) }, 'invalid_image');
      // Timeout: hanging transport is aborted and retried as fetch_failed.
      await expectFailure({ status: 200, body: PNG_V1, hang: true }, 'fetch_failed', 200);
    } finally {
      await isolated.runtime.pool.query(
        `delete from favicon_jobs where node_id = $1`, [node]);
      await app.close();
    }
  });

  test('recovery: PUT-before failure retries; PUT-then-crash and CAS-then-crash both finish without duplicate PUT', async () => {
    const app = buildApp();
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const store = createTestFaviconStore();
    const provider = createProvider();
    const node = 'fo02-recovery-bookmark-0001';
    await reseedBookmark(isolated, PRIVATE_COLLECTION, PRIVATE_ROOT, node, 'https://recovery.example.org/r', 'fo02-rec-res-1');
    await setOnline(PRIVATE_COLLECTION, node, address, owner.cookie, owner.csrfToken);
    try {
      // PUT-before fault: the store refuses the first put, the fetch already
      // happened; retry re-fetches and succeeds without leaving an orphan.
      store.failPut = true;
      provider.behavior = { status: 200, body: PNG_V1 };
      const a1 = await enqueueRefresh(PRIVATE_COLLECTION, node, address, owner.cookie, owner.csrfToken);
      const { jobId: j1 } = assertIconJobAccepted(a1.json);
      await runWorkerOnce(makeWorker(store, provider, 'fo02-rec-w1'));
      let job = (await isolated.runtime.pool.query(
        `select status, attempts, error_reason from favicon_jobs where id = $1`, [j1])).rows[0] as
        { status: string; attempts: string; error_reason: string | null };
      assert.equal(job.status, 'pending');
      assert.equal(job.error_reason, 'fetch_failed');
      store.failPut = false;
      await runWorkerOnce(makeWorker(store, provider, 'fo02-rec-w2'));
      job = (await isolated.runtime.pool.query(
        `select status from favicon_jobs where id = $1`, [j1])).rows[0] as { status: string };
      assert.equal(job.status, 'succeeded');

      // PUT-then-CAS-before crash: the object is durable but the CAS never ran.
      const a2 = await enqueueRefresh(PRIVATE_COLLECTION, node, address, owner.cookie, owner.csrfToken);
      const { jobId: j2 } = assertIconJobAccepted(a2.json);
      const ghostObject = randomUUID();
      // What the crashed worker wrote (the record never counts as a worker PUT
      // in this test's bookkeeping, so the snapshot is taken after it).
      await store.put(ghostObject, PNG_V2, 'image/png');
      const beforePuts = store.puts.length;
      await isolated.runtime.pool.query(
        `update favicon_jobs set object_id = $2, status = 'running', lease_owner = 'ghost',
                lease_until = current_timestamp - interval '1 second'
         where id = $1`, [j2, ghostObject]);
      await runWorkerOnce(makeWorker(store, provider, 'fo02-rec-w3'));
      assert.equal(store.puts.length, beforePuts, 'retry must find the already-written object and not PUT again');
      const j2row = (await isolated.runtime.pool.query(
        `select status from favicon_jobs where id = $1`, [j2])).rows[0] as { status: string };
      assert.equal(j2row.status, 'succeeded');
      const binding2 = (await isolated.runtime.pool.query(
        `select object_id from bookmark_icons where node_id = $1`, [node])).rows[0] as { object_id: string };
      assert.equal(binding2.object_id, ghostObject);

      // CAS-then-crash: the binding is already switched to the job's object and
      // the bytes are durable; the worker only reconciles metadata and marks
      // the job succeeded — never a second PUT or fetch.
      const a3 = await enqueueRefresh(PRIVATE_COLLECTION, node, address, owner.cookie, owner.csrfToken);
      const { jobId: j3 } = assertIconJobAccepted(a3.json);
      const casObject = randomUUID();
      await store.put(casObject, PNG_V2, 'image/png');
      const prePuts = store.puts.length;
      const digest = createHash('sha256').update(PNG_V2).digest();
      await isolated.runtime.pool.query(
        `update favicon_jobs set object_id = $2, status = 'running', lease_owner = 'ghost2',
                lease_until = current_timestamp - interval '1 second'
         where id = $1`, [j3, casObject]);
      await isolated.runtime.pool.query(
        `insert into bookmark_icons (
           node_id, collection_id, object_id, content_type, byte_size, digest_sha256, created_at, updated_at
         ) values ($1, $2, $3, 'image/png', $4, $5, now(), now())
         on conflict (node_id) do update set
           object_id = excluded.object_id, content_type = excluded.content_type,
           byte_size = excluded.byte_size, digest_sha256 = excluded.digest_sha256, updated_at = now()`,
        [node, PRIVATE_COLLECTION, casObject, PNG_V2.byteLength, digest]);
      await runWorkerOnce(makeWorker(store, provider, 'fo02-rec-w4'));
      assert.equal(store.puts.length, prePuts, 'an already-CASed retry must not re-PUT');
      const j3row = (await isolated.runtime.pool.query(
        `select status from favicon_jobs where id = $1`, [j3])).rows[0] as { status: string };
      assert.equal(j3row.status, 'succeeded');
      const binding3 = (await isolated.runtime.pool.query(
        `select object_id from bookmark_icons where node_id = $1`, [node])).rows[0] as { object_id: string };
      assert.equal(binding3.object_id, casObject, 'an already-applied CAS must not switch the binding');
    } finally { await app.close(); }
  });

  test('F-A1: a terminal CAS after a successful PUT records the unbound object for GC', async () => {
    const app = buildApp();
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const store = createTestFaviconStore();
    const provider = createProvider();
    const node = 'fo02-orphan-bookmark-0001';
    await reseedBookmark(isolated, PRIVATE_COLLECTION, PRIVATE_ROOT, node, 'https://orphan.example.org/o', 'fo02-orphan-res-1');
    await setOnline(PRIVATE_COLLECTION, node, address, owner.cookie, owner.csrfToken);
    try {
      provider.behavior = { status: 200, body: PNG_V1 };
      // The URL must change BETWEEN the pre-fetch re-verify (passes) and the
      // CAS re-verify (fails source_changed) so the worker fetches and PUTs
      // first: the provider side effect fires during the fetch.
      const baseConnect = provider.connect;
      provider.connect = async (target, init) => {
        await isolated.runtime.pool.query(
          `update nodes set url = 'https://moved-away.example.org/x', resource_revision = 'fo02-orphan-moved-res'
           where id = $1`, [node]);
        return baseConnect(target, init);
      };
      const { jobId } = assertIconJobAccepted(
        (await enqueueRefresh(PRIVATE_COLLECTION, node, address, owner.cookie, owner.csrfToken)).json);
      await runWorkerOnce(makeWorker(store, provider, 'fo02-orphan-w1'));
      const job = (await isolated.runtime.pool.query(
        `select status, error_reason, object_id from favicon_jobs where id = $1`, [jobId])).rows[0] as
        { status: string; error_reason: string | null; object_id: string | null };
      assert.equal(job.status, 'failed');
      assert.equal(job.error_reason, 'source_changed');
      assert.ok(job.object_id !== null);
      const orphanObject = job.object_id;
      assert.equal(store.objects.has(orphanObject), true, 'the fetched bytes were written before the CAS failed');

      // F-A1 regression: without the fix no favicon_pending_deletions record is
      // written and the object is a permanent orphan (GC only collects records).
      const pending = (await isolated.runtime.pool.query(
        `select deletable_at from favicon_pending_deletions where object_id = $1`, [orphanObject])).rows[0] as
        { deletable_at: Date } | undefined;
      assert.ok(pending !== undefined, 'the unbound object must have a pending-deletion record');
      assert.ok(pending.deletable_at.getTime() <= Date.now(), 'never served ⇒ immediately deletable');

      // GC collects the orphan right away (never served ⇒ no retention window).
      const gc = makeWorker(store, provider, 'fo02-orphan-gc').gc;
      assert.equal(await gc.runOnce(), true);
      assert.equal(store.objects.has(orphanObject), false, 'GC must delete the orphan');
      assert.equal(store.deletes.includes(orphanObject), true);
    } finally { await app.close(); }
  });

  test('F-A6: CAS timestamps use the injected clock, not the wall clock', async () => {
    const app = buildApp();
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const store = createTestFaviconStore();
    const provider = createProvider();
    const node = 'fo02-clock-bookmark-0001';
    // Far FUTURE: the wall clock can never produce this instant, so if the CAS
    // fell back to `new Date()` the assertion below fails deterministically.
    // (A past clock would be clamped by the source adapter's monotonic
    // updated_at guard — greatest(excluded, existing + 1μs) — so the future
    // instant is what reaches every CAS write untouched.)
    const FIXED = new Date('2099-01-02T03:04:05.000Z');
    await reseedBookmark(isolated, PRIVATE_COLLECTION, PRIVATE_ROOT, node, 'https://clock.example.org/c', 'fo02-clock-res-1');
    await setOnline(PRIVATE_COLLECTION, node, address, owner.cookie, owner.csrfToken);
    try {
      const { jobId } = assertIconJobAccepted(
        (await enqueueRefresh(PRIVATE_COLLECTION, node, address, owner.cookie, owner.csrfToken)).json);
      const worker = makeWorker(store, provider, 'fo02-clock-w1', {}, () => FIXED);
      await runWorkerOnce(worker);
      const job = (await isolated.runtime.pool.query(
        `select status, updated_at from favicon_jobs where id = $1`, [jobId])).rows[0] as
        { status: string; updated_at: Date };
      assert.equal(job.status, 'succeeded');
      assert.equal(job.updated_at.toISOString(), FIXED.toISOString(), 'claim end timestamp uses the injected clock');
      const binding = (await isolated.runtime.pool.query(
        `select updated_at from bookmark_icons where node_id = $1`, [node])).rows[0] as { updated_at: Date };
      assert.equal(binding.updated_at.toISOString(), FIXED.toISOString(),
        'the CAS binding must be stamped with the injected clock, not new Date()');
      const source = (await isolated.runtime.pool.query(
        `select updated_at from bookmark_icon_sources where node_id = $1`, [node])).rows[0] as { updated_at: Date };
      assert.equal(source.updated_at.toISOString(), FIXED.toISOString(),
        'setMode must be stamped with the injected clock');
    } finally { await app.close(); }
  });

  test('worker restart: an expired lease is reclaimed and the job continues', async () => {
    const app = buildApp();
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const store = createTestFaviconStore();
    const provider = createProvider();
    const node = 'fo02-restart-bookmark-0001';
    await reseedBookmark(isolated, PRIVATE_COLLECTION, PRIVATE_ROOT, node, 'https://restart.example.org/r', 'fo02-restart-res-1');
    await setOnline(PRIVATE_COLLECTION, node, address, owner.cookie, owner.csrfToken);
    try {
      const { jobId } = assertIconJobAccepted(
        (await enqueueRefresh(PRIVATE_COLLECTION, node, address, owner.cookie, owner.csrfToken)).json);
      // Worker A claims the job and "crashes" (lease held, work never done).
      const repository = createPostgresFaviconJobWorkerRepository(isolated.runtime.pool);
      const claimed = await repository.claimDue({ limit: 1, leaseOwner: 'fo02-restart-worker-A', leaseDurationMs: 60_000 });
      assert.equal(claimed.length, 1);
      const leased = (await isolated.runtime.pool.query(
        `select status, lease_owner, lease_until from favicon_jobs where id = $1`, [jobId])).rows[0] as
        { status: string; lease_owner: string | null; lease_until: Date };
      assert.equal(leased.status, 'running');
      assert.equal(leased.lease_owner, 'fo02-restart-worker-A');
      // Time passes: the lease expires.
      await isolated.runtime.pool.query(
        `update favicon_jobs set lease_until = current_timestamp - interval '1 second' where id = $1`, [jobId]);
      // Worker B (fresh process identity) reclaims and completes.
      const workerB = makeWorker(store, provider, 'fo02-restart-worker-B');
      await runWorkerOnce(workerB);
      const finished = (await isolated.runtime.pool.query(
        `select status, succeeded from favicon_jobs where id = $1`, [jobId])).rows[0] as
        { status: string; succeeded: string };
      assert.equal(finished.status, 'succeeded');
      assert.equal(Number(finished.succeeded), 1);
      const binding = (await isolated.runtime.pool.query(
        `select object_id from bookmark_icons where node_id = $1`, [node])).rows[0] as { object_id: string };
      assert.match(binding.object_id, OBJECT_ID_PATTERN);
    } finally { await app.close(); }
  });

  test('FO-08 a refresh_one claim whose lease was re-claimed cannot fetch or bind its stale object', async () => {
    const app = buildApp();
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const store = createTestFaviconStore();
    const provider = createProvider();
    const node = 'fo02-fence-refresh-00001';
    await reseedBookmark(isolated, PRIVATE_COLLECTION, PRIVATE_ROOT, node, 'https://fence.example.org/r', 'fo02-fence-res-1');
    await setOnline(PRIVATE_COLLECTION, node, address, owner.cookie, owner.csrfToken);
    try {
      const { jobId } = assertIconJobAccepted(
        (await enqueueRefresh(PRIVATE_COLLECTION, node, address, owner.cookie, owner.csrfToken)).json);
      const repository = createPostgresFaviconJobWorkerRepository(isolated.runtime.pool);
      const portsA = makeRefreshExecutionPorts(store, provider);
      const portsB = makeRefreshExecutionPorts(store, provider);

      // Worker A claims the refresh job, then stalls past its 60s lease.
      const claimA = (await repository.claimDue({
        limit: 10, leaseOwner: 'fo02-fence-refresh-A', leaseDurationMs: 60_000,
      })).find((claim) => claim.jobId === jobId);
      assert.ok(claimA !== undefined, 'worker A claims the refresh_one job');
      await isolated.runtime.pool.query(
        `update favicon_jobs set lease_until = current_timestamp - interval '1 second' where id = $1`, [jobId]);
      // Worker B reclaims the expired job and owns it (work NOT done yet).
      const claimB = (await repository.expireOverdue({
        limit: 10, leaseOwner: 'fo02-fence-refresh-B', leaseDurationMs: 60_000,
      })).find((claim) => claim.jobId === jobId);
      assert.ok(claimB !== undefined, 'worker B reclaims the expired refresh job');

      // The durable fence: A's stale claim fails identity verification outright
      // (regression: the refresh verifier never checked the job lease, so A's
      // late CAS used to pass identity and silently displace B's fresher bind).
      const verifyTx = createPostgresFaviconJobWorkerUnitOfWork(isolated.runtime.db);
      const verdict = await verifyTx.run((tx) => verifyFaviconRefreshIdentity(tx, claimA));
      assert.equal(verdict.kind, 'missing', 'a re-claimed lease must fence the stale refresh claim out');
      const outcomeA = await processFaviconRefreshClaim(portsA, claimA);
      assert.equal(outcomeA.outcome, 'lease_lost', JSON.stringify(outcomeA));
      assert.equal(store.puts.length, 0, 'the stale worker must never PUT');
      const boundA = (await isolated.runtime.pool.query(
        `select count(*)::int n from bookmark_icons where node_id = $1`, [node])).rows[0]?.n;
      assert.equal(boundA, 0, 'the stale worker must never bind');

      // B then completes under its own lease and binds its fresher object.
      const outcomeB = await processFaviconRefreshClaim(portsB, claimB);
      assert.equal(outcomeB.outcome, 'succeeded', JSON.stringify(outcomeB));
      assert.equal(store.puts.length, 1, 'only worker B writes the object');
      const binding = (await isolated.runtime.pool.query(
        `select object_id from bookmark_icons where node_id = $1`, [node])).rows[0] as { object_id: string };
      assert.match(binding.object_id, OBJECT_ID_PATTERN);
    } finally { await app.close(); }
  });

  test('GC: retention window, eligibility, reference protection, delete failure and retry', async () => {
    const app = buildApp();
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const store = createTestFaviconStore();
    const provider = createProvider();
    const node = 'fo02-gc-bookmark-0001';
    await reseedBookmark(isolated, PRIVATE_COLLECTION, PRIVATE_ROOT, node, 'https://gc.example.org/g', 'fo02-gc-res-1');
    await setOnline(PRIVATE_COLLECTION, node, address, owner.cookie, owner.csrfToken);
    try {
      provider.behavior = { status: 200, body: PNG_V1 };
      const { jobId: first } = assertIconJobAccepted(
        (await enqueueRefresh(PRIVATE_COLLECTION, node, address, owner.cookie, owner.csrfToken)).json);
      await runWorkerOnce(makeWorker(store, provider, 'fo02-gc-w1'));
      const oldObject = (await isolated.runtime.pool.query(
        `select object_id from bookmark_icons where node_id = $1`, [node])).rows[0] as { object_id: string };

      provider.behavior = { status: 200, body: PNG_V2 };
      await enqueueRefresh(PRIVATE_COLLECTION, node, address, owner.cookie, owner.csrfToken);
      await runWorkerOnce(makeWorker(store, provider, 'fo02-gc-w2'));

      // The old object is a pending deletion with the full retention window.
      const pending = (await isolated.runtime.pool.query(
        `select * from favicon_pending_deletions where object_id = $1`, [oldObject.object_id])).rows[0] as
        { deletable_at: Date; attempts: string; last_error: string | null; next_attempt_at: Date };
      assert.ok(pending.deletable_at.getTime() > Date.now(), 'retention window must protect the old object');
      assert.equal(Number(pending.attempts), 0);
      assert.equal(pending.last_error, null);

      // GC claims nothing while the window is open.
      const gc = makeWorker(store, provider, 'fo02-gc-worker').gc;
      assert.equal(await gc.runOnce(), false);
      assert.equal(store.deletes.includes(oldObject.object_id), false);

      // Expire the window manually (shift the exit + due instants into the past so
// the DB window invariant deletable_at >= retired_at still holds), then a
// delete failure keeps the record with a backoff retry.
      await isolated.runtime.pool.query(
        `update favicon_pending_deletions
         set retired_at = current_timestamp - interval '2 seconds',
             deletable_at = current_timestamp - interval '1 second',
             next_attempt_at = current_timestamp - interval '1 second'
         where object_id = $1`, [oldObject.object_id]);
      store.failDelete = true;
      assert.equal(await gc.runOnce(), true);
      const retried = (await isolated.runtime.pool.query(
        `select attempts, last_error, next_attempt_at from favicon_pending_deletions where object_id = $1`,
        [oldObject.object_id])).rows[0] as { attempts: string; last_error: string | null; next_attempt_at: Date };
      assert.equal(Number(retried.attempts), 1);
      assert.equal(retried.last_error, 'storage_delete_failed');
      assert.equal(store.objects.has(oldObject.object_id), true);

      // Clear the failure; the record is claimed again and the object goes.
      store.failDelete = false;
      await isolated.runtime.pool.query(
        `update favicon_pending_deletions set next_attempt_at = current_timestamp - interval '1 second'
         where object_id = $1`, [oldObject.object_id]);
      assert.equal(await gc.runOnce(), true);
      assert.equal(store.objects.has(oldObject.object_id), false);
      assert.equal(store.deletes.includes(oldObject.object_id), true);
      const gone = await isolated.runtime.pool.query(
        `select count(*)::int n from favicon_pending_deletions where object_id = $1`, [oldObject.object_id]);
      assert.equal(gone.rows[0]?.n, 0);

      // Reference protection: a record for the CURRENT binding is never deleted.
      const current = (await isolated.runtime.pool.query(
        `select object_id from bookmark_icons where node_id = $1`, [node])).rows[0] as { object_id: string };
      await isolated.runtime.pool.query(
        `insert into favicon_pending_deletions (
           object_id, node_id, collection_id, retired_at, deletable_at, attempts, next_attempt_at
         ) values ($1, $2, $3, now() - interval '1 hour', now() - interval '1 second', 0,
                   now() - interval '1 second')`,
        [current.object_id, node, PRIVATE_COLLECTION]);
      assert.equal(await gc.runOnce(), true);
      assert.equal(store.objects.has(current.object_id), true, 'referenced object must never be collected');
      const held = (await isolated.runtime.pool.query(
        `select count(*)::int n from favicon_pending_deletions where object_id = $1`, [current.object_id])).rows[0]?.n;
      assert.equal(held, 1, 'the pending record must persist for later recheck');
    } finally { await app.close(); }
  });

  test('duplicate consumption: concurrent workers process one job exactly once', async () => {
    const app = buildApp();
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const store = createTestFaviconStore();
    const provider = createProvider();
    const node = 'fo02-dup-bookmark-0001';
    await reseedBookmark(isolated, PRIVATE_COLLECTION, PRIVATE_ROOT, node, 'https://dup.example.org/d', 'fo02-dup-res-1');
    await setOnline(PRIVATE_COLLECTION, node, address, owner.cookie, owner.csrfToken);
    try {
      const { jobId } = assertIconJobAccepted(
        (await enqueueRefresh(PRIVATE_COLLECTION, node, address, owner.cookie, owner.csrfToken)).json);
      const workerA = makeWorker(store, provider, 'fo02-dup-worker-A');
      const workerB = makeWorker(store, provider, 'fo02-dup-worker-B');
      await Promise.all([workerA.jobs.runOnce(), workerB.jobs.runOnce()]);
      const job = (await isolated.runtime.pool.query(
        `select status, succeeded from favicon_jobs where id = $1`, [jobId])).rows[0] as
        { status: string; succeeded: string };
      assert.equal(job.status, 'succeeded');
      assert.equal(Number(job.succeeded), 1);
      // The lease-fenced claim means a single worker applied the CAS once.
      const bindings = (await isolated.runtime.pool.query(
        `select count(*)::int n from bookmark_icons where node_id = $1`, [node])).rows[0]?.n;
      assert.equal(bindings, 1);
      assert.deepEqual([...new Set(store.puts)].length, store.puts.length, 'one object id must be written once');
      assert.equal(store.puts.length, 1);
    } finally { await app.close(); }
  });

  test('public↔private transitions keep the effective icon; directUrl follows sharing only', async () => {
    const store = createTestFaviconStore();
    const app = buildApp({}, store);
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const provider = createProvider();
    const node = 'fo02-visibility-bookmark-0001';
    await reseedBookmark(isolated, PRIVATE_COLLECTION, PRIVATE_ROOT, node, 'https://vis.example.org/v', 'fo02-vis-res-1');
    await setOnline(PRIVATE_COLLECTION, node, address, owner.cookie, owner.csrfToken);
    try {
      const source = await api('GET', `${address}/api/v1/collections/${PRIVATE_COLLECTION}/nodes/${node}/favicon-source`,
        { cookie: owner.cookie });
      assert.equal(assertIconSource(source.json).directUrl, 'https://favicone.com/vis.example.org');

      await enqueueRefresh(PRIVATE_COLLECTION, node, address, owner.cookie, owner.csrfToken);
      await runWorkerOnce(makeWorker(store, provider, 'fo02-vis-w1'));
      const binding = (await isolated.runtime.pool.query(
        `select object_id from bookmark_icons where node_id = $1`, [node])).rows[0] as { object_id: string };

      // Public: still the pinned object, no directUrl.
      await isolated.runtime.pool.query(
        `update collections
         set visibility = 'public', publication_slug = 'fo02-public-test', published_at = now()
         where id = $1`, [PRIVATE_COLLECTION]);
      const publicView = await api('GET', `${address}/api/v1/collections/${PRIVATE_COLLECTION}/nodes/${node}/favicon-source`,
        { cookie: owner.cookie });
      const publicBody = assertIconSource(publicView.json);
      assert.equal(publicBody.iconUrl, `${ORIGIN}/api/v1/favicon/${binding.object_id}`);
      assert.equal(publicBody.directUrl, null);

      // Back to private (unshared): the icon is kept; directUrl returns.
      await isolated.runtime.pool.query(
        `update collections set visibility = 'private' where id = $1`, [PRIVATE_COLLECTION]);
      const privateView = await api('GET', `${address}/api/v1/collections/${PRIVATE_COLLECTION}/nodes/${node}/favicon-source`,
        { cookie: owner.cookie });
      const privateBody = assertIconSource(privateView.json);
      assert.equal(privateBody.iconUrl, `${ORIGIN}/api/v1/favicon/${binding.object_id}`);
      assert.equal(privateBody.directUrl, 'https://favicone.com/vis.example.org');
      const get = await api('GET', `${address}/api/v1/favicon/${binding.object_id}`, {});
      assert.equal(get.status, 404);
    } finally { await app.close(); }
  });

  test('FO-07 byte consistency: owner Library, logged-in visitor and anonymous download identical bytes (incl. after version switch and failed replacement)', async () => {
    const store = createTestFaviconStore();
    const app = buildApp({}, store);
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const provider = createProvider();
    try {
      const node = 'fo02-bytes-bookmark-0001';
      await reseedBookmark(isolated, PRIVATE_COLLECTION, PRIVATE_ROOT, node,
        'https://bytes.example.org/b', 'fo02-bytes-res-1');
      await setOnline(PRIVATE_COLLECTION, node, address, owner.cookie, owner.csrfToken);
      // Share the collection publicly: the icon becomes a fixed public object
      // that owner (Library), a logged-in visitor and anonymous all resolve.
      await isolated.runtime.pool.query(
        `update collections
         set visibility = 'public', publication_slug = 'fo02-bytes-public', published_at = now()
         where id = $1`, [PRIVATE_COLLECTION]);

      const expectConsistent = async (expected: Buffer, objectId: string, label: string) => {
        const expectedHash = createHash('sha256').update(expected).digest('hex');
        const ownerGet = await apiRaw('GET', `${address}/api/v1/favicon/${objectId}`, { cookie: owner.cookie });
        const visitorGet = await apiRaw('GET', `${address}/api/v1/favicon/${objectId}`, { cookie: stranger.cookie });
        const anonymousGet = await apiRaw('GET', `${address}/api/v1/favicon/${objectId}`, {});
        for (const [role, response] of [
          ['owner', ownerGet], ['visitor', visitorGet], ['anonymous', anonymousGet],
        ] as const) {
          assert.equal(response.status, 200, `${label}: ${role} download status`);
          assert.equal(response.headers['content-type'], 'image/png', `${label}: ${role} content-type`);
          assert.equal(
            createHash('sha256').update(response.rawBody).digest('hex'), expectedHash,
            `${label}: ${role} bytes must match the shared pinned object`,
          );
        }
      };

      // V1 after a formal-worker refresh: all three roles see the same bytes.
      provider.behavior = { status: 200, body: PNG_V1 };
      assertIconJobAccepted((await enqueueRefresh(PRIVATE_COLLECTION, node, address, owner.cookie, owner.csrfToken)).json);
      await runWorkerOnce(makeWorker(store, provider, 'fo02-bytes-w1'));
      const v1Binding = (await isolated.runtime.pool.query(
        `select object_id from bookmark_icons where node_id = $1`, [node])).rows[0] as { object_id: string };
      await expectConsistent(PNG_V1, v1Binding.object_id, 'v1 initial');

      // Version switch to V2: the new effective object serves identical bytes
      // for all three roles; the old object's public binding is revoked even
      // while its durable GC retention row remains.
      provider.behavior = { status: 200, body: PNG_V2 };
      assertIconJobAccepted((await enqueueRefresh(PRIVATE_COLLECTION, node, address, owner.cookie, owner.csrfToken)).json);
      await runWorkerOnce(makeWorker(store, provider, 'fo02-bytes-w2'));
      const v2Binding = (await isolated.runtime.pool.query(
        `select object_id from bookmark_icons where node_id = $1`, [node])).rows[0] as { object_id: string };
      assert.notEqual(v2Binding.object_id, v1Binding.object_id, 'version switch changes the binding');
      await expectConsistent(PNG_V2, v2Binding.object_id, 'v2 after switch');

      // Failed replacement keeps the intact old binding renderable: all three
      // roles still download exactly the last valid bytes.
      provider.behavior = { status: 500, body: Buffer.from('boom'), headers: { 'content-type': 'text/plain' } };
      assertIconJobAccepted((await enqueueRefresh(PRIVATE_COLLECTION, node, address, owner.cookie, owner.csrfToken)).json);
      const failingWorker = makeWorker(store, provider, 'fo02-bytes-w3');
      for (let i = 0; i < 5; i += 1) await runWorkerOnce(failingWorker);
      const kept = (await isolated.runtime.pool.query(
        `select object_id from bookmark_icons where node_id = $1`, [node])).rows[0] as { object_id: string };
      assert.equal(kept.object_id, v2Binding.object_id, 'failed replacement must keep the last valid binding');
      await expectConsistent(PNG_V2, kept.object_id, 'after failed replacement');
    } finally {
      // Restore the fixture to private: the byte-consistency leg shares the
      // collection publicly, but the next test relies on the fixture's private
      // visibility to assert stranger concealment (404 on favicon-source).
      await isolated.runtime.pool.query(
        `update collections set visibility = 'private', publication_slug = null, published_at = null
         where id = $1`, [PRIVATE_COLLECTION]);
      await app.close();
    }
  });

  test('uploaded → online switch keeps the upload renderable through a failed replacement; success swaps and retires it', async () => {
    const store = createTestFaviconStore();
    const app = buildApp({}, store);
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const provider = createProvider();
    const node = 'fo02-switch-bookmark-0001';
    try {
      await reseedBookmark(isolated, PRIVATE_COLLECTION, PRIVATE_ROOT, node,
        'https://switch.example.org/s', 'fo02-switch-res-1');

      // 1. A real upload becomes the binding; the online switch must NOT
      //    pre-clear it ("替换失败：有旧版本就保留，失败不能先清空有效绑定"):
      //    the replacement outcome decides retention, never the switch.
      const upload = await api('POST', `${address}/api/v1/collections/${PRIVATE_COLLECTION}/nodes/${node}/favicon`, {
        cookie: owner.cookie, csrf: owner.csrfToken, commandId: randomUUID(),
        rawBody: PNG_V1, contentType: 'image/png',
      });
      assert.equal(upload.status, 200);
      const uploadedObjectId = (upload.json as { iconUrl: string }).iconUrl.split('/').at(-1) ?? '';
      const online = await setOnline(PRIVATE_COLLECTION, node, address, owner.cookie, owner.csrfToken);
      assert.equal(online.status, 200);
      const afterSwitch = await api('GET', `${address}/api/v1/collections/${PRIVATE_COLLECTION}/nodes/${node}/favicon-source`,
        { cookie: owner.cookie });
      const switchView = assertIconSource(afterSwitch.json);
      assert.equal(switchView.sourceMode, 'online');
      assert.equal(switchView.effectiveMode, 'online');
      assert.equal(switchView.status, 'ready');
      assert.equal(switchView.iconVersion, uploadedObjectId, 'the upload stays bound after switching to online');
      assert.equal((await isolated.runtime.pool.query(
        `select count(*)::int n from favicon_pending_deletions where object_id = $1`, [uploadedObjectId])).rows[0]?.n, 0);

      // 2. The online replacement FAILS: the old upload must stay renderable
      //    for owner and visitors alike.
      provider.behavior = { status: 500, body: Buffer.from('boom'), headers: { 'content-type': 'text/plain' } };
      assertIconJobAccepted((await enqueueRefresh(PRIVATE_COLLECTION, node, address, owner.cookie, owner.csrfToken)).json);
      const failingWorker = makeWorker(store, provider, 'fo02-switch-w1', { maxAttempts: 1 });
      await runWorkerOnce(failingWorker, 2);
      const kept = (await isolated.runtime.pool.query(
        `select object_id from bookmark_icons where node_id = $1`, [node])).rows[0] as { object_id: string };
      assert.equal(kept.object_id, uploadedObjectId, 'failed replacement must keep the uploaded version');
      const afterFail = await api('GET', `${address}/api/v1/collections/${PRIVATE_COLLECTION}/nodes/${node}/favicon-source`,
        { cookie: owner.cookie });
      const failView = assertIconSource(afterFail.json);
      assert.equal(failView.status, 'failed');
      assert.equal(failView.iconVersion, uploadedObjectId);
      assert.equal(failView.iconUrl, `${ORIGIN}/api/v1/favicon/${uploadedObjectId}`);
      const originalVisibility = (await isolated.runtime.pool.query('select visibility,publication_slug,published_at from collections where id=$1', [PRIVATE_COLLECTION])).rows[0];
      await isolated.runtime.pool.query("update collections set visibility='public',publication_slug='ci-favicon-'||md5(id),published_at=now() where id=$1", [PRIVATE_COLLECTION]);
      const oldServed = await apiRaw('GET', `${address}/api/v1/favicon/${uploadedObjectId}`, {});
      await isolated.runtime.pool.query('update collections set visibility=$2,publication_slug=$3,published_at=$4 where id=$1', [PRIVATE_COLLECTION, originalVisibility.visibility, originalVisibility.publication_slug, originalVisibility.published_at]);
      assert.equal(oldServed.status, 200);
      assert.equal(oldServed.headers['content-type'], 'image/png');

      // 3. The next replacement succeeds: the CAS swaps the binding and
      //    retires the displaced upload with its retention window.
      provider.behavior = { status: 200, body: PNG_V2 };
      assertIconJobAccepted((await enqueueRefresh(PRIVATE_COLLECTION, node, address, owner.cookie, owner.csrfToken)).json);
      await runWorkerOnce(makeWorker(store, provider, 'fo02-switch-w2'));
      const swapped = (await isolated.runtime.pool.query(
        `select object_id from bookmark_icons where node_id = $1`, [node])).rows[0] as { object_id: string };
      assert.notEqual(swapped.object_id, uploadedObjectId, 'successful replacement swaps the binding');
      assert.equal((await isolated.runtime.pool.query(
        `select count(*)::int n from favicon_pending_deletions where object_id = $1`, [uploadedObjectId])).rows[0]?.n, 1,
        'the displaced upload is retired with retention');
      const retired = await apiRaw('GET', `${address}/api/v1/favicon/${uploadedObjectId}`, {});
      assert.equal(retired.status, 404, 'retired object is no longer publicly readable after the binding swap');
    } finally { await app.close(); }
  });

  test('visitors never obtain a private directUrl; flag-off surfaces 404', async () => {
    const app = buildApp();
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    try {
      // The favicon-source surface is owner-only: a shared editor reads 403 on
      // a collection they belong to and never sees any directUrl; a stranger
      // on the private collection is concealed as 404.
      const editor = await api('GET', `${address}/api/v1/collections/${SHARED_COLLECTION}/nodes/${SHARED_BOOKMARK}/favicon-source`,
        { cookie: other.cookie });
      assert.equal(editor.status, 403);
      const strangerGet = await api('GET', `${address}/api/v1/collections/${PRIVATE_COLLECTION}/nodes/${PRIVATE_BOOKMARK}/favicon-source`,
        { cookie: stranger.cookie });
      assert.equal(strangerGet.status, 404);
    } finally { await app.close(); }

    // Feature flag off: refresh and online PUT are 404 with no feature surface.
    const off = buildApp({ faviconPolicy: { ...config.faviconPolicy, enabled: false } });
    const offAddress = await off.listen({ host: '127.0.0.1', port: 0 });
    try {
      const refresh = await api('POST', `${offAddress}/api/v1/collections/${PRIVATE_COLLECTION}/nodes/${PRIVATE_BOOKMARK}/favicon-refresh`, {
        cookie: owner.cookie, csrf: owner.csrfToken, commandId: randomUUID(),
        ifMatch: '"favicon-source:fo02-priv-res-1:1"',
      });
      assert.equal(refresh.status, 404);
      const putOnline = await api('PUT', `${offAddress}/api/v1/collections/${PRIVATE_COLLECTION}/nodes/${PRIVATE_BOOKMARK}/favicon-source`, {
        cookie: owner.cookie, csrf: owner.csrfToken, commandId: randomUUID(),
        ifMatch: '"favicon-source:fo02-priv-res-1:1"', body: { sourceMode: 'online' },
      });
      assert.equal(putOnline.status, 404);
    } finally { await off.close(); }
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

function assertIconPolicy(value: unknown): { newDefault: string } {
  assertClosedObject(value, ['revision', 'newDefault', 'providerTemplate', 'fillMissing',
    'forceAllOnline', 'updatedAt'], 'IconPolicy');
  const body = value as Record<string, unknown>;
  assert.equal(typeof body.newDefault, 'string');
  return { newDefault: body.newDefault as string };
}

function assertIconSource(value: unknown): {
  sourceMode: string; effectiveMode: string; iconUrl: string | null; iconVersion: string | null;
  directUrl: string | null; status: string; revision: string; policyRevision: string; restorable: boolean;
} {
  assertClosedObject(value, ['collectionId', 'nodeId', 'revision', 'policyRevision', 'sourceMode',
    'effectiveMode', 'iconUrl', 'iconVersion', 'directUrl', 'status', 'restorable', 'updatedAt'], 'IconSource');
  const body = value as Record<string, unknown>;
  for (const key of ['sourceMode', 'effectiveMode', 'status', 'revision', 'policyRevision']) {
    assert.equal(typeof body[key], 'string', `IconSource.${key}`);
  }
  for (const key of ['iconUrl', 'iconVersion', 'directUrl']) {
    assert.ok(body[key] === null || typeof body[key] === 'string', `IconSource.${key}`);
  }
  for (const mode of ['sourceMode', 'effectiveMode']) {
    const enumValue = body[mode] as string;
    assert.ok(['inherit', 'online', 'uploaded', 'none', 'capture'].includes(enumValue), `${mode} enum`);
  }
  assert.ok(['ready', 'missing', 'pending', 'failed'].includes(body.status as string), 'IconSource.status');
  assert.ok(REVISION_PATTERN.test(body.revision as string), 'IconSource.revision');
  assert.ok(REVISION_PATTERN.test(body.policyRevision as string), 'IconSource.policyRevision');
  if (body.iconUrl !== null) {
    assert.match(body.iconUrl as string, new RegExp(`^${ORIGIN.replaceAll('.', '\\.')}/api/v1/favicon/[0-9a-f-]{36}$`));
  }
  if (body.updatedAt !== null) {
    assert.match(body.updatedAt as string, TIMESTAMP_PATTERN);
  }
  return {
    sourceMode: body.sourceMode as string,
    effectiveMode: body.effectiveMode as string,
    iconUrl: body.iconUrl as string | null,
    iconVersion: body.iconVersion as string | null,
    directUrl: body.directUrl as string | null,
    status: body.status as string,
    revision: body.revision as string,
    policyRevision: body.policyRevision as string,
    restorable: body.restorable as boolean,
  };
}

function assertProductError(value: unknown, codes: readonly string[]): { currentEtag: string | null } {
  assertClosedObject(value, ['error'], 'ProductErrorEnvelope');
  const body = value as { error: Record<string, unknown> };
  assert.deepEqual(Object.keys(body.error).sort(),
    ['code', 'message', 'requestId', 'recovery', 'sameRequestRetrySafe', 'precondition',
      'currentEtag', 'retryAfterSeconds', 'fieldErrors'].sort(), 'error envelope fields');
  const code = body.error.code as string;
  assert.ok(typeof code === 'string' && codes.includes(code), `error.code in [${codes.join(', ')}]`);
  return { currentEtag: body.error.currentEtag === null ? null : (body.error.currentEtag as string) };
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

function api(method: string, url: string, options: ApiOptions): Promise<ApiResponse> {
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

const providerResolvePublic: Provider['resolve'] = async () => [PUBLIC_PIN];

async function seedOwnedCollection(
  runtime: IsolatedPostgresRuntime,
  input: {
    collectionId: string; rootId: string; bookmarkId: string;
    ownerSubjectId: string; bookmarkUrl: string; resourceRevision: string;
  },
): Promise<void> {
  const client = await runtime.runtime.pool.connect();
  try {
    await client.query('begin');
    await client.query('set constraints all deferred');
    await client.query(
      `insert into resource_id_ledger(resource_id, resource_type)
       values ($1, 'collection'), ($2, 'node'), ($3, 'node')`,
      [input.collectionId, input.rootId, input.bookmarkId],
    );
    await client.query(
      `insert into collections (
         id, owner_subject_id, title, kind, visibility, root_node_id, resource_revision,
         content_revision, policy_revision, commit_ordinal, created_at, updated_at
       ) values ($1, $2, 'FO-02 fixture', 'bookmarks', 'private', $3, 'coll-res-1',
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
      `insert into nodes (
         id, collection_id, parent_id, kind, is_root, title, url, position_token,
         resource_revision, children_revision, created_at, updated_at
       ) values ($1, $2, $3, 'bookmark', false, 'FO-02 bookmark', $4, 'B1',
                 $5, 'bm-ch-1', now(), now())`,
      [input.bookmarkId, input.collectionId, input.rootId, input.bookmarkUrl, input.resourceRevision],
    );
    await client.query(
      `insert into collection_members(collection_id, subject_id, role, granted_at)
       values ($1, $2, 'owner', now())`,
      [input.collectionId, input.ownerSubjectId],
    );
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

async function reseedBookmark(
  runtime: IsolatedPostgresRuntime,
  collectionId: string,
  rootId: string,
  nodeId: string,
  url: string,
  resourceRevision: string,
): Promise<void> {
  await runtime.runtime.pool.query(
    `insert into resource_id_ledger(resource_id, resource_type) values ($1, 'node') on conflict do nothing`,
    [nodeId],
  );
  await runtime.runtime.pool.query(
    `insert into nodes (
       id, collection_id, parent_id, kind, is_root, title, url, position_token,
       resource_revision, children_revision, created_at, updated_at
     ) values ($1, $2, $3, 'bookmark', false, 'FO-02 node', $4, $1,
              $5, 'bm-ch-1', now(), now())`,
    [nodeId, collectionId, rootId, url, resourceRevision],
  );
}
