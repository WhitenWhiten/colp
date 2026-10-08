/**
 * FO-01 favicon policy/source Product HTTP (real PostgreSQL + real bootstrap
 * composition). Covers all four FO-01 operations end-to-end:
 *
 *   getMyFaviconPolicy        GET  /api/v1/me/favicon-policy
 *   updateMyFaviconPolicy     PATCH /api/v1/me/favicon-policy
 *   getBookmarkFaviconSource  GET  /api/v1/collections/{cid}/nodes/{nid}/favicon-source
 *   setBookmarkFaviconSource  PUT  /api/v1/collections/{cid}/nodes/{nid}/favicon-source
 *
 * Success bodies are validated against the FO-01 contract schema with
 * hand-written validators in this file (never shared with the implementation),
 * and the DB side effects are asserted through real SQL.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { afterAll, beforeAll, test } from 'vitest';
import { loadConfig } from '../../support/test-config.js';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import { createPostgresIdentityUnitOfWork } from '../../../src/infrastructure/identity/index.js';
import { createPostgresCollectionsUnitOfWork, createPostgresCanonicalMutationUnitOfWork } from '../../../src/infrastructure/collections/index.js';
import { buildApiApp } from '../../../src/transport/app.js';
import { issueTestSession, createPostgresBetterAuthTestFactory } from '../../support/better-auth-test-factory.js';
import { createIsolatedPostgresRuntime, describeWithPostgres,
  type IsolatedPostgresRuntime } from '../../support/postgres-test-runtime.js';

const ORIGIN = 'https://app.example.test';
const ISSUER = 'https://issuer.example.test/realms/known';
const DEFAULT_TEMPLATE = 'https://favicone.com/{hostname}';
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const REVISION_PATTERN = /^[1-9][0-9]{0,18}$/u;
const ETAG_PATTERN = /^"[^"\r\n]+"$/u;
const OBJECT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000182e403790000000049454e44ae426082',
  'hex',
);

interface ApiResponse {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly json: unknown;
}

interface IconPolicyBody {
  readonly revision: string;
  readonly newDefault: 'capture' | 'online' | 'none';
  readonly providerTemplate: string;
  readonly fillMissing: boolean;
  readonly forceAllOnline: boolean;
  readonly updatedAt: string;
}

interface PolicyResultBody {
  readonly policy: IconPolicyBody;
  readonly jobId: string | null;
}

interface IconSourceBody {
  readonly collectionId: string;
  readonly nodeId: string;
  readonly revision: string;
  readonly policyRevision: string;
  readonly sourceMode: string;
  readonly effectiveMode: string;
  readonly iconUrl: string | null;
  readonly iconVersion: string | null;
  readonly directUrl: string | null;
  readonly status: string;
  readonly restorable: boolean;
  readonly updatedAt: string;
}

describeWithPostgres('FO-01 favicon policy and icon source Product HTTP', () => {
  let isolated: IsolatedPostgresRuntime;
  let factory: ReturnType<typeof createPostgresBetterAuthTestFactory>;
  let owner: { cookie: string; csrfToken: string; accountId: string; subjectId: string };
  let other: { cookie: string; csrfToken: string; accountId: string; subjectId: string };
  let stranger: { cookie: string; csrfToken: string; accountId: string; subjectId: string };
  let config: ReturnType<typeof loadConfig>;
  const collectionId = 'favicon-fo01-collection-0001';
  const rootId = 'favicon-fo01-root-node-0000001';
  const bookmarkId = 'favicon-fo01-bookmark-node-0001';

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('fo01_favicon_policy', { maxConnections: 8 });
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
      subject: `fo01-owner-${randomUUID()}`, handle: `fo1o${randomUUID().replaceAll('-', '').slice(0, 12)}` });
    other = await issueTestSession({ factory,
      subject: `fo01-other-${randomUUID()}`, handle: `fo1r${randomUUID().replaceAll('-', '').slice(0, 12)}` });
    stranger = await issueTestSession({ factory,
      subject: `fo01-stranger-${randomUUID()}`, handle: `fo1s${randomUUID().replaceAll('-', '').slice(0, 12)}` });
    await seedOwnedCollection(isolated, {
      collectionId,
      rootId,
      bookmarkId,
      ownerSubjectId: owner.subjectId,
      bookmarkUrl: 'https://example.test/fo01-bookmark',
    });
    // `other` is a shared editor (may update nodes) but not the owner; `stranger`
    // has no membership at all. Both must be denied the owner-only source API.
    await isolated.runtime.pool.query(
      `insert into collection_members(collection_id, subject_id, role, granted_at)
       values ($1, $2, 'editor', now())`,
      [collectionId, other.subjectId],
    );
  }, 180_000);
  afterAll(async () => isolated?.close());

  function buildApp(overrides: Partial<ReturnType<typeof loadConfig>> = {}) {
    return buildApiApp({
      config: { ...config, ...overrides },
      identityUnitOfWork: createPostgresIdentityUnitOfWork(isolated.runtime.db),
      collectionsUnitOfWork: createPostgresCollectionsUnitOfWork(isolated.runtime.db),
      productCollectionMutationUnitOfWork: createPostgresCanonicalMutationUnitOfWork(
        isolated.runtime.db, { productOrigin: ORIGIN }),
      browserSessionAuthority: factory.authority,
      faviconStore: createMemoryFaviconObjectStore(),
    });
  }

  test('getMyFaviconPolicy: virtual default revision 1 before any write', async () => {
    const app = buildApp();
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    try {
      const response = await api('GET', `${address}/api/v1/me/favicon-policy`, { cookie: owner.cookie });
      assert.equal(response.status, 200);
      assert.equal(response.headers['cache-control'], 'private, no-store');
      assert.equal(response.headers.etag, '"favicon-policy:1"');
      const policy = assertIconPolicy(response.json);
      assert.equal(policy.revision, '1');
      assert.equal(policy.newDefault, 'capture');
      assert.equal(policy.providerTemplate, DEFAULT_TEMPLATE);
      assert.equal(policy.fillMissing, false);
      assert.equal(policy.forceAllOnline, false);
      const accountCreated = (await isolated.runtime.pool.query(
        `select created_at from accounts where id = $1`, [owner.accountId])).rows[0] as { created_at: Date };
      assert.equal(policy.updatedAt, accountCreated.created_at.toISOString());
      // Repeat read stays stable (GET never creates a row).
      const again = await api('GET', `${address}/api/v1/me/favicon-policy`, { cookie: owner.cookie });
      assert.equal(again.status, 200);
      assert.equal(again.headers.etag, '"favicon-policy:1"');
      assert.deepEqual(assertIconPolicy(again.json), policy);
      const rows = await isolated.runtime.pool.query(
        `select count(*)::int n from account_favicon_policies where account_id = $1`, [owner.accountId]);
      assert.equal(rows.rows[0]?.n, 0);
    } finally { await app.close(); }
  });

  test('updateMyFaviconPolicy: happy path persists, ETag/CAS advances, GET reflects after refresh', async () => {
    const app = buildApp();
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    try {
      const updated = await api('PATCH', `${address}/api/v1/me/favicon-policy`, {
        cookie: owner.cookie, csrf: owner.csrfToken, commandId: randomUUID(), ifMatch: '"favicon-policy:1"',
        body: { newDefault: 'none' },
      });
      assert.equal(updated.status, 200);
      assert.equal(updated.headers.etag, '"favicon-policy:2"');
      const body = assertPolicyResult(updated.json);
      assert.equal(body.jobId, null);
      assert.equal(body.policy.revision, '2');
      assert.equal(body.policy.newDefault, 'none');
      assert.equal(body.policy.providerTemplate, DEFAULT_TEMPLATE);
      assert.equal(body.policy.fillMissing, false);
      assert.equal(body.policy.forceAllOnline, false);

      const row = (await isolated.runtime.pool.query(
        `select new_default, revision, provider_template from account_favicon_policies
         where account_id = $1`, [owner.accountId])).rows[0] as
        { new_default: string; revision: string; provider_template: string };
      assert.deepEqual(row, { new_default: 'none', revision: '2', provider_template: DEFAULT_TEMPLATE });

      const refreshed = await api('GET', `${address}/api/v1/me/favicon-policy`, { cookie: owner.cookie });
      assert.equal(refreshed.status, 200);
      assert.equal(refreshed.headers.etag, '"favicon-policy:2"');
      assert.equal(assertIconPolicy(refreshed.json).revision, '2');
    } finally { await app.close(); }
  });

  test('updateMyFaviconPolicy: no-op patch keeps the same revision', async () => {
    const app = buildApp();
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    try {
      const noop = await api('PATCH', `${address}/api/v1/me/favicon-policy`, {
        cookie: owner.cookie, csrf: owner.csrfToken, commandId: randomUUID(),
        ifMatch: '"favicon-policy:2"', body: { newDefault: 'none' },
      });
      assert.equal(noop.status, 200);
      assert.equal(noop.headers.etag, '"favicon-policy:2"');
      assert.equal(assertPolicyResult(noop.json).policy.revision, '2');
    } finally { await app.close(); }
  });

  test('F-B3: virtual policy updatedAt is the stable account creation time across GET and a no-op PATCH', async () => {
    const app = buildApp();
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    try {
      // `other` has never written a policy row: GET exposes the virtual
      // revision-1 singleton whose updatedAt is the account creation time.
      const get = await api('GET', `${address}/api/v1/me/favicon-policy`, { cookie: other.cookie });
      assert.equal(get.status, 200);
      const accountCreated = (await isolated.runtime.pool.query(
        `select created_at from accounts where id = $1`, [other.accountId])).rows[0] as { created_at: Date };
      const policy = assertIconPolicy(get.json);
      assert.equal(policy.revision, '1');
      assert.equal(policy.updatedAt, accountCreated.created_at.toISOString(),
        'GET virtual updatedAt must be the account creation time');

      // A no-op PATCH (newDefault: 'capture' is already the virtual default)
      // returns the SAME virtual revision-1 representation: updatedAt must
      // also be the account creation time, matching the GET exactly — both
      // representations of virtual revision 1 must agree.
      const noop = await api('PATCH', `${address}/api/v1/me/favicon-policy`, {
        cookie: other.cookie, csrf: other.csrfToken, commandId: randomUUID(),
        ifMatch: '"favicon-policy:1"', body: { newDefault: 'capture' },
      });
      assert.equal(noop.status, 200, JSON.stringify(noop.json));
      assert.equal(noop.headers.etag, '"favicon-policy:1"');
      const patched = assertPolicyResult(noop.json);
      assert.equal(patched.policy.revision, '1');
      assert.equal(patched.policy.updatedAt, accountCreated.created_at.toISOString(),
        'PATCH virtual updatedAt must be the account creation time, never request time');
      assert.equal(patched.policy.updatedAt, policy.updatedAt,
        'GET and PATCH representations of virtual revision 1 must agree on updatedAt');
      // The no-op patch path never materializes a row.
      const rows = await isolated.runtime.pool.query(
        `select count(*)::int n from account_favicon_policies where account_id = $1`, [other.accountId]);
      assert.equal(rows.rows[0]?.n, 0);
    } finally { await app.close(); }
  });

  test('updateMyFaviconPolicy: stale If-Match is 412 with the current ETag', async () => {
    const app = buildApp();
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    try {
      const stale = await api('PATCH', `${address}/api/v1/me/favicon-policy`, {
        cookie: owner.cookie, csrf: owner.csrfToken, commandId: randomUUID(),
        ifMatch: '"favicon-policy:1"', body: { newDefault: 'capture' },
      });
      assert.equal(stale.status, 412);
      const error = assertProductError(stale.json, ['precondition_failed']);
      assert.equal(error.precondition, 'resource');
      assert.equal(error.currentEtag, '"favicon-policy:2"');
    } finally { await app.close(); }
  });

  test('updateMyFaviconPolicy: exact replay wins over the now-old If-Match (receipt order)', async () => {
    const app = buildApp();
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const commandId = randomUUID();
    try {
      const original = await api('PATCH', `${address}/api/v1/me/favicon-policy`, {
        cookie: owner.cookie, csrf: owner.csrfToken, commandId,
        ifMatch: '"favicon-policy:2"', body: { newDefault: 'capture' },
      });
      assert.equal(original.status, 200);
      const originalBody = assertPolicyResult(original.json);
      assert.equal(originalBody.policy.revision, '3');

      // Replay the exact same command with the ORIGINAL (now stale) If-Match:
      // the receipt is compared BEFORE fresh If-Match, so it replays 200.
      const replay = await api('PATCH', `${address}/api/v1/me/favicon-policy`, {
        cookie: owner.cookie, csrf: owner.csrfToken, commandId,
        ifMatch: '"favicon-policy:2"', body: { newDefault: 'capture' },
      });
      assert.equal(replay.status, 200);
      assert.deepEqual(assertPolicyResult(replay.json), originalBody);
      assert.equal(replay.headers.etag, '"favicon-policy:3"');

      // Same command id with a different fingerprinted body is 409 command_id_reused.
      const reused = await api('PATCH', `${address}/api/v1/me/favicon-policy`, {
        cookie: owner.cookie, csrf: owner.csrfToken, commandId,
        ifMatch: '"favicon-policy:3"', body: { newDefault: 'none' },
      });
      assert.equal(reused.status, 409);
      assertProductError(reused.json, ['command_id_reused']);
    } finally { await app.close(); }
  });

  test('updateMyFaviconPolicy negative: missing/malformed If-Match, bad bodies, bad command id', async () => {
    const app = buildApp();
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    try {
      const missing = await api('PATCH', `${address}/api/v1/me/favicon-policy`, {
        cookie: owner.cookie, csrf: owner.csrfToken, commandId: randomUUID(), body: { newDefault: 'capture' },
      });
      assert.equal(missing.status, 428);
      assertProductError(missing.json, ['precondition_required']);

      for (const bad of ['W/"favicon-policy:1"', '*', '"a", "b"', 'plain']) {
        const malformed = await api('PATCH', `${address}/api/v1/me/favicon-policy`, {
          cookie: owner.cookie, csrf: owner.csrfToken, commandId: randomUUID(),
          ifMatch: bad, body: { newDefault: 'capture' },
        });
        assert.equal(malformed.status, 400, `If-Match ${bad} must be rejected`);
        assertProductError(malformed.json, ['invalid_request']);
      }

      const noCommand = await api('PATCH', `${address}/api/v1/me/favicon-policy`, {
        cookie: owner.cookie, csrf: owner.csrfToken, ifMatch: '"favicon-policy:3"',
        body: { newDefault: 'capture' },
      });
      assert.equal(noCommand.status, 400);

      const badCommand = await api('PATCH', `${address}/api/v1/me/favicon-policy`, {
        cookie: owner.cookie, csrf: owner.csrfToken, commandId: 'not-a-uuid',
        ifMatch: '"favicon-policy:3"', body: { newDefault: 'capture' },
      });
      assert.equal(badCommand.status, 400);

      for (const body of [
        {},
        { newDefault: null },
        { fillMissing: 'true' },
        { forceAllOnline: 1 },
        { providerTemplate: 'http://favicone.com/{hostname}' },
        { providerTemplate: 'https://favicone.com/no-hostname-marker' },
        { newDefault: 'capture', unknown: 1 },
        { unknown: 1 },
        null,
        'capture',
        [1],
      ]) {
        const rejected = await api('PATCH', `${address}/api/v1/me/favicon-policy`, {
          cookie: owner.cookie, csrf: owner.csrfToken, commandId: randomUUID(),
          ifMatch: '"favicon-policy:3"', body,
        });
        assert.equal(rejected.status, 400, `body ${JSON.stringify(body)} must be rejected`);
        assertProductError(rejected.json, ['invalid_request']);
      }

      const badJson = await apiRaw('PATCH', `${address}/api/v1/me/favicon-policy`, {
        cookie: owner.cookie, csrf: owner.csrfToken, commandId: randomUUID(),
        ifMatch: '"favicon-policy:3"', rawBody: '{not json', contentType: 'application/json',
      });
      assert.equal(badJson.status, 400);
      assertProductError(badJson.json, ['invalid_json']);

      const noCsrf = await api('PATCH', `${address}/api/v1/me/favicon-policy`, {
        cookie: owner.cookie, commandId: randomUUID(), ifMatch: '"favicon-policy:3"',
        body: { newDefault: 'capture' },
      });
      assert.equal(noCsrf.status, 403);
      assertProductError(noCsrf.json, ['csrf_failed', 'insufficient_permission']);
    } finally { await app.close(); }
  });

  test('getMyFaviconPolicy negative: query/body rejected, unauthenticated 401', async () => {
    const app = buildApp();
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    try {
      const withQuery = await api('GET', `${address}/api/v1/me/favicon-policy?x=1`, { cookie: owner.cookie });
      assert.equal(withQuery.status, 400);
      assertProductError(withQuery.json, ['invalid_query']);

      const withBody = await api('GET', `${address}/api/v1/me/favicon-policy`, {
        cookie: owner.cookie, body: { newDefault: 'capture' }, contentType: 'application/json',
      });
      assert.equal(withBody.status, 400);

      const anonymous = await api('GET', `${address}/api/v1/me/favicon-policy`, {});
      assert.equal(anonymous.status, 401);
      assertProductError(anonymous.json, ['authentication_required']);
    } finally { await app.close(); }
  });

  test('getBookmarkFaviconSource: virtual inherit default on a fresh bookmark', async () => {
    const app = buildApp();
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    try {
      const currentPolicy = await api('GET', `${address}/api/v1/me/favicon-policy`, { cookie: owner.cookie });
      assert.equal(currentPolicy.status, 200);
      const policy = assertIconPolicy(currentPolicy.json);

      const response = await api('GET', `${address}/api/v1/collections/${collectionId}/nodes/${bookmarkId}/favicon-source`,
        { cookie: owner.cookie });
      assert.equal(response.status, 200);
      assert.match(response.headers.etag ?? '', ETAG_PATTERN);
      assert.match(response.headers.etag ?? '', /^"favicon-source:[A-Za-z0-9._~-]{1,128}:1"$/u);
      const source = assertIconSource(response.json);
      assert.equal(source.collectionId, collectionId);
      assert.equal(source.nodeId, bookmarkId);
      assert.equal(source.revision, '1');
      assert.equal(source.policyRevision, policy.revision);
      assert.equal(source.sourceMode, 'inherit');
      assert.equal(source.effectiveMode, policy.newDefault);
      assert.equal(source.iconUrl, null);
      assert.equal(source.iconVersion, null);
      assert.equal(source.directUrl, null);
      assert.equal(source.status, 'missing');
      assert.equal(source.restorable, false);
      const node = (await isolated.runtime.pool.query(
        `select updated_at from nodes where id = $1`, [bookmarkId])).rows[0] as { updated_at: Date };
      assert.equal(source.updatedAt, node.updated_at.toISOString());
    } finally { await app.close(); }
  });

  test('bookmark upload enters sourceMode=uploaded and Product delete enters none', async () => {
    const app = buildApp();
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    try {
      const upload = await apiBuffer('POST', `${address}/api/v1/collections/${collectionId}/nodes/${bookmarkId}/favicon`, {
        cookie: owner.cookie, csrf: owner.csrfToken, commandId: randomUUID(),
        rawBody: PNG, contentType: 'image/png',
      });
      assert.equal(upload.status, 200);

      const source = await api('GET', `${address}/api/v1/collections/${collectionId}/nodes/${bookmarkId}/favicon-source`,
        { cookie: owner.cookie });
      assert.equal(source.status, 200);
      const view = assertIconSource(source.json);
      assert.equal(view.sourceMode, 'uploaded');
      assert.equal(view.effectiveMode, 'uploaded');
      assert.equal(view.status, 'ready');
      assert.equal(view.revision, '2');
      assert.match(view.iconUrl ?? '', /^https:\/\/app\.example\.test\/api\/v1\/favicon\/[0-9a-f-]{36}$/u);
      assert.match(view.iconVersion ?? '', OBJECT_ID_PATTERN);
      const binding = (await isolated.runtime.pool.query(
        `select object_id from bookmark_icons where node_id = $1`, [bookmarkId])).rows[0] as { object_id: string };
      assert.equal(view.iconVersion, binding.object_id);
      const sourceRow = (await isolated.runtime.pool.query(
        `select source_mode, revision from bookmark_icon_sources where node_id = $1`, [bookmarkId])).rows[0] as
        { source_mode: string; revision: string };
      assert.deepEqual(sourceRow, { source_mode: 'uploaded', revision: '2' });

      // uploaded can never be forged through the source PUT.
      const forge = await api('PUT', `${address}/api/v1/collections/${collectionId}/nodes/${bookmarkId}/favicon-source`, {
        cookie: owner.cookie, csrf: owner.csrfToken, commandId: randomUUID(),
        ifMatch: `${source.headers.etag ?? ''}`, body: { sourceMode: 'uploaded' },
      });
      assert.equal(forge.status, 400);

      // Explicit Product delete enters none.
      const del = await api('DELETE', `${address}/api/v1/collections/${collectionId}/nodes/${bookmarkId}/favicon`, {
        cookie: owner.cookie, csrf: owner.csrfToken, commandId: randomUUID(),
      });
      assert.equal(del.status, 200);
      const after = await api('GET', `${address}/api/v1/collections/${collectionId}/nodes/${bookmarkId}/favicon-source`,
        { cookie: owner.cookie });
      assert.equal(after.status, 200);
      const afterView = assertIconSource(after.json);
      assert.equal(afterView.sourceMode, 'none');
      assert.equal(afterView.effectiveMode, 'none');
      assert.equal(afterView.status, 'missing');
      assert.equal(afterView.iconUrl, null);
      assert.equal(afterView.revision, '3');
      const noneRow = (await isolated.runtime.pool.query(
        `select source_mode from bookmark_icon_sources where node_id = $1`, [bookmarkId])).rows[0] as
        { source_mode: string };
      assert.equal(noneRow.source_mode, 'none');
      // The deleted upload is retired with its retention window, never
      // deleted out from under the immutable cache promise.
      const retired = (await isolated.runtime.pool.query(
        `select object_id, deletable_at > retired_at as has_window
         from favicon_pending_deletions where object_id = $1`, [view.iconVersion])).rows[0] as
        { object_id: string; has_window: boolean } | undefined;
      assert.ok(retired, 'Product delete must enter the durable GC retirement ledger');
      assert.equal(retired.has_window, true);
      const stillServed = await api('GET', `${address}/api/v1/favicon/${view.iconVersion}`, {});
      assert.equal(stillServed.status, 200, 'retired object stays fetchable during the retention window');
    } finally { await app.close(); }
  });

  test('F-A8: favicon-source restorable is true with a pending force-restore row and false once consumed', async () => {
    const app = buildApp();
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const node = 'favicon-fo01-restore-node-0001';
    const uploadedObject = randomUUID();
    const digest = createHash('sha256').update(PNG).digest();
    try {
      // Fresh bookmark + an uploaded binding, mirroring the FO-03 bulk
      // fixture: forceAllOnline later displaced this binding and durably
      // recorded the pre-force state in favicon_source_restores.
      await isolated.runtime.pool.query(
        `insert into resource_id_ledger(resource_id, resource_type) values ($1, 'node') on conflict do nothing`,
        [node],
      );
      await isolated.runtime.pool.query(
        `insert into nodes (
           id, collection_id, parent_id, kind, is_root, title, url, position_token,
           resource_revision, children_revision, created_at, updated_at
         ) values ($1, $2, $3, 'bookmark', false, 'FO-01 restore node',
                   'https://restore.example.test/a', 'R1', 'restore-res-1', 'restore-ch-1', now(), now())`,
        [node, collectionId, rootId],
      );
      await isolated.runtime.pool.query(
        `insert into bookmark_icons (
           node_id, collection_id, object_id, content_type, byte_size, digest_sha256, created_at, updated_at
         ) values ($1, $2, $3, 'image/png', $4, $5, now(), now())`,
        [node, collectionId, uploadedObject, PNG.byteLength, digest],
      );
      await isolated.runtime.pool.query(
        `insert into bookmark_icon_sources(node_id, collection_id, source_mode, revision, updated_at)
         values ($1, $2, 'uploaded', 2, now())`,
        [node, collectionId],
      );

      const url = `${address}/api/v1/collections/${collectionId}/nodes/${node}/favicon-source`;
      // No pending restore row yet: restorable is false (fail-closed).
      const before = await api('GET', url, { cookie: owner.cookie });
      assert.equal(before.status, 200);
      assert.equal(assertIconSource(before.json).restorable, false);

      // A pending force-restore row (the durable record apply_force_online
      // writes before displacing the uploaded binding) makes the source
      // restorable on GET: the restore row must be projected through the
      // wired `restores` read port.
      await isolated.runtime.pool.query(
        `insert into favicon_source_restores (
           node_id, collection_id, account_id, original_source_mode, original_object_id,
           original_content_type, original_byte_size, original_digest_sha256,
           source_revision, created_at, updated_at
         ) values ($1, $2, $3, 'uploaded', $4, 'image/png', $5, $6, '2', now(), now())`,
        [node, collectionId, owner.accountId, uploadedObject, PNG.byteLength, digest],
      );
      const pending = await api('GET', url, { cookie: owner.cookie });
      assert.equal(pending.status, 200);
      assert.equal(assertIconSource(pending.json).restorable, true);

      // Force-off consumes the row (apply_restore deletes it): restorable
      // drops back to false.
      await isolated.runtime.pool.query(
        `delete from favicon_source_restores where node_id = $1`, [node],
      );
      const consumed = await api('GET', url, { cookie: owner.cookie });
      assert.equal(consumed.status, 200);
      assert.equal(assertIconSource(consumed.json).restorable, false);
    } finally { await app.close(); }
  });

  test('setBookmarkFaviconSource: inherit/none with CAS, node-revision fence, replay, uploaded cleanup', async () => {
    const app = buildApp();
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const freshNode = 'favicon-fo01-bookmark-node-0002';
    await isolated.runtime.pool.query(
      `insert into resource_id_ledger(resource_id, resource_type) values ($1, 'node') on conflict do nothing`,
      [freshNode],
    );
    await isolated.runtime.pool.query(
      `insert into nodes (
         id, collection_id, parent_id, kind, is_root, title, url, position_token,
         resource_revision, children_revision, created_at, updated_at
       ) values ($1, $2, $3, 'bookmark', false, 'Fresh', 'https://example.test/fresh', 'F2',
                'fresh-res-1', 'fresh-ch-1', now(), now())`,
      [freshNode, collectionId, rootId],
    );
    const path = `${address}/api/v1/collections/${collectionId}/nodes/${freshNode}/favicon-source`;
    try {
      // A fresh PUT inherit is a no-op at virtual revision 1.
      const inherit = await api('PUT', path, {
        cookie: owner.cookie, csrf: owner.csrfToken, commandId: randomUUID(),
        ifMatch: '"favicon-source:fresh-res-1:1"', body: { sourceMode: 'inherit' },
      });
      assert.equal(inherit.status, 200);
      assert.equal(assertIconSource(inherit.json).sourceMode, 'inherit');
      assert.equal(assertIconSource(inherit.json).revision, '1');

      // PUT none advances to revision 2 and persists.
      const none = await api('PUT', path, {
        cookie: owner.cookie, csrf: owner.csrfToken, commandId: randomUUID(),
        ifMatch: `${inherit.headers.etag ?? ''}`, body: { sourceMode: 'none' },
      });
      assert.equal(none.status, 200);
      assert.equal(none.headers.etag, '"favicon-source:fresh-res-1:2"');
      const noneBody = assertIconSource(none.json);
      assert.equal(noneBody.sourceMode, 'none');
      assert.equal(noneBody.effectiveMode, 'none');
      assert.equal(noneBody.revision, '2');

      // Stale ETag is 412 with the current composite ETag.
      const stale = await api('PUT', path, {
        cookie: owner.cookie, csrf: owner.csrfToken, commandId: randomUUID(),
        ifMatch: '"favicon-source:fresh-res-1:1"', body: { sourceMode: 'none' },
      });
      assert.equal(stale.status, 412);
      const staleError = assertProductError(stale.json, ['precondition_failed']);
      assert.equal(staleError.currentEtag, '"favicon-source:fresh-res-1:2"');

      // The composite ETag also fences the node resource revision: bumping the
      // node revision in the authority makes the old ETag stale.
      await isolated.runtime.pool.query(
        `update nodes set resource_revision = 'fresh-res-changed' where id = $1`, [freshNode]);
      const nodeChanged = await api('PUT', path, {
        cookie: owner.cookie, csrf: owner.csrfToken, commandId: randomUUID(),
        ifMatch: '"favicon-source:fresh-res-1:2"', body: { sourceMode: 'inherit' },
      });
      assert.equal(nodeChanged.status, 412);
      assert.equal(assertProductError(nodeChanged.json, ['precondition_failed']).currentEtag,
        '"favicon-source:fresh-res-changed:2"');
    } finally { await app.close(); }
  });

  test('setBookmarkFaviconSource: replay order and uploaded-binding cleanup on the shared bookmark', async () => {
    const app = buildApp();
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const path = `${address}/api/v1/collections/${collectionId}/nodes/${bookmarkId}/favicon-source`;
    try {
      const current = await api('GET', path, { cookie: owner.cookie });
      assert.equal(current.status, 200);
      // bookmarkId is currently none/rev3 from the earlier upload/delete test.
      const replayCommandId = randomUUID();
      const first = await api('PUT', path, {
        cookie: owner.cookie, csrf: owner.csrfToken, commandId: replayCommandId,
        ifMatch: `${current.headers.etag ?? ''}`, body: { sourceMode: 'inherit' },
      });
      assert.equal(first.status, 200);
      const firstBody = assertIconSource(first.json);

      // Exact replay with the same (now stale) If-Match returns the saved body.
      const replay = await api('PUT', path, {
        cookie: owner.cookie, csrf: owner.csrfToken, commandId: replayCommandId,
        ifMatch: `${current.headers.etag ?? ''}`, body: { sourceMode: 'inherit' },
      });
      assert.equal(replay.status, 200);
      assert.deepEqual(assertIconSource(replay.json), firstBody);
      assert.equal(replay.headers.etag, first.headers.etag);

      // Same id, different body => 409 command_id_reused.
      const reused = await api('PUT', path, {
        cookie: owner.cookie, csrf: owner.csrfToken, commandId: replayCommandId,
        ifMatch: `${first.headers.etag ?? ''}`, body: { sourceMode: 'none' },
      });
      assert.equal(reused.status, 409);
      assertProductError(reused.json, ['command_id_reused']);

      // Switching away from an uploaded binding drops the icon row; the
      // retired object enters the durable GC retention window (never an
      // immediate delete: the object stays fetchable during retention).
      const upload = await apiBuffer('POST', `${address}/api/v1/collections/${collectionId}/nodes/${bookmarkId}/favicon`, {
        cookie: owner.cookie, csrf: owner.csrfToken, commandId: randomUUID(),
        rawBody: PNG, contentType: 'image/png',
      });
      assert.equal(upload.status, 200);
      const uploadedIconUrl = (upload.json as { iconUrl: string }).iconUrl;
      const uploadedObjectId = uploadedIconUrl.split('/').at(-1) ?? '';
      const uploadedSource = await api('GET', path, { cookie: owner.cookie });
      assert.equal(assertIconSource(uploadedSource.json).sourceMode, 'uploaded');
      const switchAway = await api('PUT', path, {
        cookie: owner.cookie, csrf: owner.csrfToken, commandId: randomUUID(),
        ifMatch: `${uploadedSource.headers.etag ?? ''}`, body: { sourceMode: 'inherit' },
      });
      assert.equal(switchAway.status, 200);
      assert.equal(assertIconSource(switchAway.json).sourceMode, 'inherit');
      const bindingAfter = await isolated.runtime.pool.query(
        `select count(*)::int n from bookmark_icons where node_id = $1`, [bookmarkId]);
      assert.equal(bindingAfter.rows[0]?.n, 0);
      const modeAfter = (await isolated.runtime.pool.query(
        `select source_mode from bookmark_icon_sources where node_id = $1`, [bookmarkId])).rows[0] as
        { source_mode: string };
      assert.equal(modeAfter.source_mode, 'inherit');
      const retiredAfter = (await isolated.runtime.pool.query(
        `select count(*)::int n from favicon_pending_deletions where object_id = $1`, [uploadedObjectId])).rows[0]?.n;
      assert.equal(retiredAfter, 1, 'switch away must retire the old object with retention');
      const stillServed = await api('GET', `${address}/api/v1/favicon/${uploadedObjectId}`, {});
      assert.equal(stillServed.status, 200, 'retired object stays fetchable during the retention window');
    } finally { await app.close(); }
  });

  test('uploaded → online keeps the valid binding renderable; only explicit none drops and retires it', async () => {
    const app = buildApp();
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const path = `${address}/api/v1/collections/${collectionId}/nodes/${bookmarkId}/favicon-source`;
    try {
      const upload = await apiBuffer('POST', `${address}/api/v1/collections/${collectionId}/nodes/${bookmarkId}/favicon`, {
        cookie: owner.cookie, csrf: owner.csrfToken, commandId: randomUUID(),
        rawBody: PNG, contentType: 'image/png',
      });
      assert.equal(upload.status, 200);
      const objectId = (upload.json as { iconUrl: string }).iconUrl.split('/').at(-1) ?? '';

      // The online switch is a replacement *request*: the current version
      // stays bound and renderable until the refresh CAS succeeds ("替换失
      // 败：有旧版本就保留，失败不能先清空有效绑定").
      const uploadedSource = await api('GET', path, { cookie: owner.cookie });
      const switched = await api('PUT', path, {
        cookie: owner.cookie, csrf: owner.csrfToken, commandId: randomUUID(),
        ifMatch: `${uploadedSource.headers.etag ?? ''}`, body: { sourceMode: 'online' },
      });
      assert.equal(switched.status, 200, `switch failed: ${JSON.stringify(switched.json)}`);
      const onlineView = assertIconSource(switched.json);
      assert.equal(onlineView.sourceMode, 'online');
      assert.equal(onlineView.effectiveMode, 'online');
      assert.equal(onlineView.status, 'ready');
      assert.equal(onlineView.iconUrl, `${ORIGIN}/api/v1/favicon/${objectId}`);
      assert.equal(onlineView.iconVersion, objectId);
      assert.equal((await isolated.runtime.pool.query(
        `select count(*)::int n from bookmark_icons where node_id = $1`, [bookmarkId])).rows[0]?.n, 1,
        'the valid binding must survive the switch to online');
      assert.equal((await isolated.runtime.pool.query(
        `select count(*)::int n from favicon_pending_deletions where object_id = $1`, [objectId])).rows[0]?.n, 0,
        'nothing is retired while the binding is still live');
      const served = await api('GET', `${address}/api/v1/favicon/${objectId}`, {});
      assert.equal(served.status, 200);

      // Explicit none drops the binding and retires the object with retention.
      const afterOnline = await api('GET', path, { cookie: owner.cookie });
      const none = await api('PUT', path, {
        cookie: owner.cookie, csrf: owner.csrfToken, commandId: randomUUID(),
        ifMatch: `${afterOnline.headers.etag ?? ''}`, body: { sourceMode: 'none' },
      });
      assert.equal(none.status, 200);
      const noneView = assertIconSource(none.json);
      assert.equal(noneView.sourceMode, 'none');
      assert.equal(noneView.iconUrl, null);
      assert.equal((await isolated.runtime.pool.query(
        `select count(*)::int n from bookmark_icons where node_id = $1`, [bookmarkId])).rows[0]?.n, 0);
      assert.equal((await isolated.runtime.pool.query(
        `select count(*)::int n from favicon_pending_deletions where object_id = $1`, [objectId])).rows[0]?.n, 1,
        'explicit none retires the old object with retention');
      const stillServed = await api('GET', `${address}/api/v1/favicon/${objectId}`, {});
      assert.equal(stillServed.status, 200, 'retired object stays fetchable during the retention window');
    } finally { await app.close(); }
  });

  test('setBookmarkFaviconSource negative: uploaded/unknown/missing rejected; precondition errors; online accepted (FO-02)', async () => {
    const app = buildApp();
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const path = `${address}/api/v1/collections/${collectionId}/nodes/${bookmarkId}/favicon-source`;
    try {
      const current = await api('GET', path, { cookie: owner.cookie });
      assert.equal(current.status, 200);
      const currentEtag = current.headers.etag ?? '';
      // FO-02 opens sourceMode=online (contract transition) — it must succeed.
      const online = await api('PUT', path, {
        cookie: owner.cookie, csrf: owner.csrfToken, commandId: randomUUID(),
        ifMatch: currentEtag, body: { sourceMode: 'online' },
      });
      assert.equal(online.status, 200, `body: ${JSON.stringify(online.json)}`);
      const onlineView = assertIconSource(online.json);
      assert.equal(onlineView.sourceMode, 'online');
      assert.equal(onlineView.effectiveMode, 'online');

      for (const body of [
        { sourceMode: 'uploaded' },
        { sourceMode: null },
        {},
        { sourceMode: 'inherit', extra: 1 },
        { other: 1 },
        'inherit',
        null,
      ]) {
        const rejected = await api('PUT', path, {
          cookie: owner.cookie, csrf: owner.csrfToken, commandId: randomUUID(),
          ifMatch: `${online.headers.etag ?? ''}`, body,
        });
        assert.equal(rejected.status, 400, `PUT body ${JSON.stringify(body)} must be rejected`);
        assertProductError(rejected.json, ['invalid_request']);
      }

      // The online change advanced the source revision; the fresh ETag fences it.
      const freshEtag = online.headers.etag ?? '';
      const missing = await api('PUT', path, {
        cookie: owner.cookie, csrf: owner.csrfToken, commandId: randomUUID(),
        body: { sourceMode: 'inherit' },
      });
      assert.equal(missing.status, 428);
      assertProductError(missing.json, ['precondition_required']);

      const badCommand = await api('PUT', path, {
        cookie: owner.cookie, csrf: owner.csrfToken, commandId: 'nope',
        ifMatch: freshEtag, body: { sourceMode: 'inherit' },
      });
      assert.equal(badCommand.status, 400);

      const noCsrf = await api('PUT', path, {
        cookie: owner.cookie, commandId: randomUUID(),
        ifMatch: freshEtag, body: { sourceMode: 'inherit' },
      });
      assert.equal(noCsrf.status, 403);
      assertProductError(noCsrf.json, ['csrf_failed', 'insufficient_permission']);

      // Restore the pre-test inherit state so later tests see the original mode.
      const restore = await api('PUT', path, {
        cookie: owner.cookie, csrf: owner.csrfToken, commandId: randomUUID(),
        ifMatch: freshEtag, body: { sourceMode: 'inherit' },
      });
      assert.equal(restore.status, 200);
    } finally { await app.close(); }
  });

  test('getBookmarkFaviconSource negative: foreign/absent/folder targets and authorization', async () => {
    const app = buildApp();
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const base = `${address}/api/v1/collections`;
    try {
      // A shared editor may update nodes but never read/change the owner
      // source: 403 insufficient_permission.
      const editorGet = await api('GET', `${base}/${collectionId}/nodes/${bookmarkId}/favicon-source`,
        { cookie: other.cookie });
      assert.equal(editorGet.status, 403);
      assertProductError(editorGet.json, ['insufficient_permission']);
      const editorPut = await api('PUT', `${base}/${collectionId}/nodes/${bookmarkId}/favicon-source`, {
        cookie: other.cookie, csrf: other.csrfToken, commandId: randomUUID(),
        ifMatch: '"favicon-source:bm-res-1:1"', body: { sourceMode: 'inherit' },
      });
      assert.equal(editorPut.status, 403);
      assertProductError(editorPut.json, ['insufficient_permission']);

      // A non-member of the private collection gets the conceal 404.
      const strangerGet = await api('GET', `${base}/${collectionId}/nodes/${bookmarkId}/favicon-source`,
        { cookie: stranger.cookie });
      assert.equal(strangerGet.status, 404);
      assertProductError(strangerGet.json, ['resource_not_found']);

      // Folder node is a 400 (favicon sources only on bookmarks).
      const folder = await api('GET', `${base}/${collectionId}/nodes/${rootId}/favicon-source`, { cookie: owner.cookie });
      assert.equal(folder.status, 400);
      assertProductError(folder.json, ['invalid_request']);

      // Nonexistent collection/node are concealed as 404.
      const missingCollection = await api('GET',
        `${base}/favicon-fo01-no-such-collection/nodes/${bookmarkId}/favicon-source`, { cookie: owner.cookie });
      assert.equal(missingCollection.status, 404);
      const missingNode = await api('GET',
        `${base}/${collectionId}/nodes/favicon-fo01-no-such-node/favicon-source`, { cookie: owner.cookie });
      assert.equal(missingNode.status, 404);

      // Queries/bodies rejected on GET.
      const withQuery = await api('GET', `${base}/${collectionId}/nodes/${bookmarkId}/favicon-source?x=1`,
        { cookie: owner.cookie });
      assert.equal(withQuery.status, 400);
      assertProductError(withQuery.json, ['invalid_query']);
      const withBody = await api('GET', `${base}/${collectionId}/nodes/${bookmarkId}/favicon-source`, {
        cookie: owner.cookie, body: {}, contentType: 'application/json',
      });
      assert.equal(withBody.status, 400);

      const anonymous = await api('GET', `${base}/${collectionId}/nodes/${bookmarkId}/favicon-source`, {});
      assert.equal(anonymous.status, 401);
    } finally { await app.close(); }
  });

  test('inherited effective mode follows the account policy after refresh', async () => {
    const app = buildApp();
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    try {
      const before = await api('GET', `${address}/api/v1/me/favicon-policy`, { cookie: owner.cookie });
      assert.equal(before.status, 200);
      const beforePolicy = assertIconPolicy(before.json);
      assert.equal(beforePolicy.newDefault, 'capture');
      const source = await api('GET', `${address}/api/v1/collections/${collectionId}/nodes/${bookmarkId}/favicon-source`,
        { cookie: owner.cookie });
      const sourceView = assertIconSource(source.json);
      assert.equal(sourceView.sourceMode, 'inherit');
      assert.equal(sourceView.effectiveMode, 'capture');
      assert.equal(sourceView.policyRevision, beforePolicy.revision);

      // Set the policy to none; inherit now projects to effective none after refresh.
      const patched = await api('PATCH', `${address}/api/v1/me/favicon-policy`, {
        cookie: owner.cookie, csrf: owner.csrfToken, commandId: randomUUID(),
        ifMatch: `${before.headers.etag ?? ''}`, body: { newDefault: 'none' },
      });
      assert.equal(patched.status, 200);
      const patchedPolicy = assertPolicyResult(patched.json);
      assert.equal(patchedPolicy.policy.newDefault, 'none');
      const after = await api('GET', `${address}/api/v1/collections/${collectionId}/nodes/${bookmarkId}/favicon-source`,
        { cookie: owner.cookie });
      const afterView = assertIconSource(after.json);
      assert.equal(afterView.effectiveMode, 'none');
      assert.equal(afterView.policyRevision, patchedPolicy.policy.revision);
    } finally { await app.close(); }
  });

  test('feature flag off: every FO-01 operation is 404', async () => {
    const app = buildApp({ faviconPolicy: { ...config.faviconPolicy, enabled: false } });
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    try {
      const getPolicy = await api('GET', `${address}/api/v1/me/favicon-policy`, { cookie: owner.cookie });
      assert.equal(getPolicy.status, 404);
      const patchPolicy = await api('PATCH', `${address}/api/v1/me/favicon-policy`, {
        cookie: owner.cookie, csrf: owner.csrfToken, commandId: randomUUID(),
        ifMatch: '"favicon-policy:1"', body: { newDefault: 'capture' },
      });
      assert.equal(patchPolicy.status, 404);
      const getSource = await api('GET',
        `${address}/api/v1/collections/${collectionId}/nodes/${bookmarkId}/favicon-source`, { cookie: owner.cookie });
      assert.equal(getSource.status, 404);
      const putSource = await api('PUT',
        `${address}/api/v1/collections/${collectionId}/nodes/${bookmarkId}/favicon-source`, {
          cookie: owner.cookie, csrf: owner.csrfToken, commandId: randomUUID(),
          ifMatch: '"favicon-source:r:1"', body: { sourceMode: 'inherit' },
        });
      assert.equal(putSource.status, 404);
      // FO-03 job surface is gated by the same flag: all three operations 404.
      const createJob = await api('POST', `${address}/api/v1/me/favicon-jobs`, {
        cookie: owner.cookie, csrf: owner.csrfToken, commandId: randomUUID(),
        body: { operation: 'fill_missing', policyRevision: '1' },
      });
      assert.equal(createJob.status, 404);
      const getJob = await api('GET', `${address}/api/v1/me/favicon-jobs/not-a-job`, { cookie: owner.cookie });
      assert.equal(getJob.status, 404);
      const retryJob = await api('POST', `${address}/api/v1/me/favicon-jobs/not-a-job/retry`, {
        cookie: owner.cookie, csrf: owner.csrfToken, commandId: randomUUID(),
      });
      assert.equal(retryJob.status, 404);
    } finally { await app.close(); }
  });
});

// ---------------------------------------------------------------------------
// Independent contract validators (hand-written in this test; never shared
// with the implementation).
// ---------------------------------------------------------------------------

function assertClosedObject(value: unknown, keys: readonly string[],
  name: string): asserts value is Record<string, unknown> {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value), `${name} must be an object`);
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), `${name} must be a closed object`);
}

function assertIconPolicy(value: unknown): IconPolicyBody {
  assertClosedObject(value, ['revision', 'newDefault', 'providerTemplate', 'fillMissing',
    'forceAllOnline', 'updatedAt'], 'IconPolicy');
  const body = value;
  const revision = body.revision;
  const newDefault = body.newDefault;
  const providerTemplate = body.providerTemplate;
  const fillMissing = body.fillMissing;
  const forceAllOnline = body.forceAllOnline;
  const updatedAt = body.updatedAt;
  assert.ok(typeof revision === 'string' && REVISION_PATTERN.test(revision), 'IconPolicy.revision');
  assert.ok(typeof newDefault === 'string' && ['capture', 'online', 'none'].includes(newDefault),
    'IconPolicy.newDefault');
  assert.ok(typeof providerTemplate === 'string' && providerTemplate.length >= 1
    && providerTemplate.length <= 2048 && providerTemplate.includes('{hostname}'),
    'IconPolicy.providerTemplate');
  assert.equal(typeof fillMissing, 'boolean');
  assert.equal(typeof forceAllOnline, 'boolean');
  assert.ok(typeof updatedAt === 'string' && TIMESTAMP_PATTERN.test(updatedAt), 'IconPolicy.updatedAt');
  return { revision, newDefault: newDefault as 'capture' | 'online' | 'none',
    providerTemplate, fillMissing, forceAllOnline, updatedAt };
}

function assertPolicyResult(value: unknown): PolicyResultBody {
  assertClosedObject(value, ['policy', 'jobId'], 'PolicyResult');
  const body = value;
  const policy = assertIconPolicy(body.policy);
  const jobId = body.jobId;
  assert.ok(jobId === null || (typeof jobId === 'string' && jobId.length <= 128), 'PolicyResult.jobId');
  return { policy, jobId: jobId as string | null };
}

function assertIconSource(value: unknown): IconSourceBody {
  assertClosedObject(value, ['collectionId', 'nodeId', 'revision', 'policyRevision', 'sourceMode',
    'effectiveMode', 'iconUrl', 'iconVersion', 'directUrl', 'status', 'restorable', 'updatedAt'], 'IconSource');
  const body = value;
  const collectionId = body.collectionId;
  const nodeId = body.nodeId;
  const revision = body.revision;
  const policyRevision = body.policyRevision;
  const sourceMode = body.sourceMode;
  const effectiveMode = body.effectiveMode;
  const iconUrl = body.iconUrl;
  const iconVersion = body.iconVersion;
  const directUrl = body.directUrl;
  const status = body.status;
  const restorable = body.restorable;
  const updatedAt = body.updatedAt;
  for (const id of [collectionId, nodeId]) {
    assert.ok(typeof id === 'string' && id.length >= 1 && id.length <= 128, 'IconSource id');
  }
  assert.ok(typeof revision === 'string' && REVISION_PATTERN.test(revision), 'IconSource.revision');
  assert.ok(typeof policyRevision === 'string' && REVISION_PATTERN.test(policyRevision),
    'IconSource.policyRevision');
  assert.ok(typeof sourceMode === 'string' && ['inherit', 'online', 'uploaded', 'none'].includes(sourceMode),
    'IconSource.sourceMode');
  assert.ok(typeof effectiveMode === 'string'
    && ['capture', 'online', 'uploaded', 'none'].includes(effectiveMode), 'IconSource.effectiveMode');
  assert.ok(iconUrl === null || (typeof iconUrl === 'string' && iconUrl.length >= 1 && iconUrl.length <= 8192),
    'IconSource.iconUrl');
  assert.ok(iconVersion === null
    || (typeof iconVersion === 'string' && iconVersion.length >= 1 && iconVersion.length <= 128),
  'IconSource.iconVersion');
  assert.ok(directUrl === null
    || (typeof directUrl === 'string' && directUrl.length >= 1 && directUrl.length <= 8192),
  'IconSource.directUrl');
  assert.ok(typeof status === 'string' && ['ready', 'missing', 'pending', 'failed'].includes(status),
    'IconSource.status');
  assert.equal(typeof restorable, 'boolean');
  assert.ok(typeof updatedAt === 'string' && TIMESTAMP_PATTERN.test(updatedAt), 'IconSource.updatedAt');
  return { collectionId, nodeId, revision, policyRevision, sourceMode, effectiveMode,
    iconUrl: iconUrl as string | null, iconVersion: iconVersion as string | null,
    directUrl: directUrl as string | null, status, restorable, updatedAt };
}

function assertProductError(value: unknown, codes: readonly string[]): {
  code: string; message: string; requestId: string; recovery: string;
  sameRequestRetrySafe: boolean; precondition: string | null; currentEtag: string | null;
  retryAfterSeconds: number | null; fieldErrors: readonly unknown[];
} {
  assertClosedObject(value, ['error'], 'ProductErrorEnvelope');
  const body = value.error;
  assert.ok(body !== null && typeof body === 'object' && !Array.isArray(body));
  assert.deepEqual(Object.keys(body).sort(),
    ['code', 'message', 'requestId', 'recovery', 'sameRequestRetrySafe', 'precondition',
      'currentEtag', 'retryAfterSeconds', 'fieldErrors'].sort(), 'error envelope fields');
  const code = body.code;
  const message = body.message;
  const requestId = body.requestId;
  const recovery = body.recovery;
  const sameRequestRetrySafe = body.sameRequestRetrySafe;
  const precondition = body.precondition;
  const currentEtag = body.currentEtag;
  const retryAfterSeconds = body.retryAfterSeconds;
  const fieldErrors = body.fieldErrors;
  assert.ok(typeof code === 'string' && codes.includes(code), `error.code in [${codes.join(', ')}]`);
  assert.ok(typeof message === 'string' && message.length > 0);
  assert.ok(typeof requestId === 'string');
  assert.ok(typeof recovery === 'string');
  assert.equal(typeof sameRequestRetrySafe, 'boolean');
  assert.ok(precondition === null || precondition === 'resource' || precondition === 'content');
  assert.ok(currentEtag === null || typeof currentEtag === 'string');
  assert.ok(retryAfterSeconds === null || typeof retryAfterSeconds === 'number');
  assert.ok(Array.isArray(fieldErrors));
  return { code, message, requestId, recovery, sameRequestRetrySafe,
    precondition: precondition as string | null, currentEtag: currentEtag as string | null,
    retryAfterSeconds: retryAfterSeconds as number | null, fieldErrors };
}

// ---------------------------------------------------------------------------
// HTTP plumbing + fixtures
// ---------------------------------------------------------------------------

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

function apiBuffer(method: string, url: string, options: ApiOptions & { rawBody: Buffer | string }): Promise<ApiResponse> {
  return apiRaw(method, url, options);
}

function apiRaw(method: string, url: string, options: ApiOptions): Promise<ApiResponse> {
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
        const text = Buffer.concat(chunks).toString('utf8');
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

function createMemoryFaviconObjectStore(): {
  put(objectId: string, body: Buffer, contentType: string): Promise<void>;
  get(objectId: string): Promise<{ contentType: string; body: Buffer } | null>;
  delete(objectId: string): Promise<void>;
} {
  const objects = new Map<string, { contentType: string; body: Buffer }>();
  return {
    async put(objectId, body, contentType) {
      objects.set(objectId, { contentType, body: Buffer.from(body) });
    },
    async get(objectId) {
      const row = objects.get(objectId);
      return row ? { contentType: row.contentType, body: Buffer.from(row.body) } : null;
    },
    async delete(objectId) {
      objects.delete(objectId);
    },
  };
}

async function seedOwnedCollection(
  runtime: IsolatedPostgresRuntime,
  input: {
    collectionId: string; rootId: string; bookmarkId: string;
    ownerSubjectId: string; bookmarkUrl: string;
  },
): Promise<void> {
  const client = await runtime.runtime.pool.connect();
  try {
    await client.query('begin');
    // collections.root_node_id and nodes.collection_id reference each other;
    // the constraints are deferrable, mirroring the canonical bootstrap seed.
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
       ) values ($1, $2, 'FO-01 fixture', 'bookmarks', 'private', $3, 'coll-res-1', 'coll-content-1',
                 'coll-policy-1', 1, now(), now())`,
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
       ) values ($1, $2, $3, 'bookmark', false, 'FO-01 bookmark', $4, 'B1',
                 'bm-res-1', 'bm-ch-1', now(), now())`,
      [input.bookmarkId, input.collectionId, input.rootId, input.bookmarkUrl],
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