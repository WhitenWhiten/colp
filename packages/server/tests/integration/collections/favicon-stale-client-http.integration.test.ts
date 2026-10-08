/**
 * FO-04 extension favicon helper HTTP (real PostgreSQL + real bootstrap
 * composition). Covers all four helper operations end-to-end:
 *
 *   getExtensionFaviconPolicy   GET  /colp/v0.1/sync/favicon-policy
 *   getExtensionFaviconSource   GET  /colp/v0.1/sync/collections/{cid}/nodes/{nid}/favicon-source
 *   captureExtensionFavicon     POST /colp/v0.1/sync/collections/{cid}/nodes/{nid}/favicon
 *   clearExtensionCapturedFavicon DELETE /colp/v0.1/sync/collections/{cid}/nodes/{nid}/favicon
 *
 * The extension authenticates with the original COLP credential authority: a
 * real RS256 JWT verified through the production jose verifier against the
 * fixture JWKS, resolved to an active account through real identity storage.
 * Success bodies are validated against the FO-01/FO-04 contract schema with
 * hand-written validators in this file (never shared with the implementation),
 * and the DB side effects are asserted through real SQL.
 *
 * Stale-client boundary: a legacy helper queue that POSTs captured bytes
 * without If-Match / Known-Favicon-Policy-Revision is 428 precondition_required
 * and a blind command-id swap is rejected the same way; a new extension must
 * re-read policy/source before uploading. Protected source state (uploaded,
 * none, force-online) never accepts automatic capture/clear (403), stale
 * validators are 412, receipts replay before fresh If-Match, and the feature
 * flag off hides every helper operation with 404.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { afterAll, beforeAll, test } from 'vitest';
import { loadConfig } from '../../support/test-config.js';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import { createPostgresIdentityUnitOfWork } from '../../../src/infrastructure/identity/index.js';
import { createPostgresCollectionsUnitOfWork, createPostgresCanonicalMutationUnitOfWork } from '../../../src/infrastructure/collections/index.js';
import { createPostgresExtensionOwnerSubjectPort } from '../../../src/infrastructure/identity/index.js';
import { createProductOwnedCollectionsCursorSigner } from '../../../src/modules/collections/index.js';
import { buildApiApp } from '../../../src/transport/app.js';
import { canonicalCommandFingerprint } from '../../../src/modules/commands/index.js';
import {
  createExtensionCredentialEvidenceVerifier,
  type ExtensionAuthConfig,
  type ExtensionCredentialEvidencePort,
} from '../../../src/modules/identity/index.js';
import { issueTestSession, createPostgresBetterAuthTestFactory } from '../../support/better-auth-test-factory.js';
import { createIsolatedPostgresRuntime, describeWithPostgres,
  type IsolatedPostgresRuntime } from '../../support/postgres-test-runtime.js';

const ORIGIN = 'https://app.example.test';
const ISSUER = 'https://issuer.example.test/realms/known';
const EXTENSION_ID = 'abcdefghijklmnopabcdefghijklmnop';
const EXTENSION_ORIGIN = `chrome-extension://${EXTENSION_ID}`;
const DEFAULT_TEMPLATE = 'https://favicone.com/{hostname}';
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
// BookmarkNodeView uses the Product UtcDateTime which drops milliseconds.
const NODE_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;
const REVISION_PATTERN = /^[1-9][0-9]{0,18}$/u;
const ETAG_PATTERN = /^"[^"\r\n]+"$/u;
const OBJECT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000182e403790000000049454e44ae426082',
  'hex',
);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>');

const POLICY_PATH = '/colp/v0.1/sync/favicon-policy';

interface ApiResponse {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly json: unknown;
}

interface ExtensionClient {
  readonly authorization: string;
  readonly accountId: string;
  readonly subjectId: string;
}

interface IconPolicyBody {
  readonly revision: string; readonly newDefault: 'capture' | 'online' | 'none';
  readonly providerTemplate: string; readonly fillMissing: boolean; readonly forceAllOnline: boolean;
  readonly updatedAt: string;
}

interface IconSourceBody {
  readonly collectionId: string; readonly nodeId: string; readonly revision: string;
  readonly policyRevision: string; readonly sourceMode: string; readonly effectiveMode: string;
  readonly iconUrl: string | null; readonly iconVersion: string | null; readonly directUrl: string | null;
  readonly status: string; readonly restorable: boolean; readonly updatedAt: string;
}

interface BookmarkNodeViewBody {
  readonly id: string; readonly collectionId: string; readonly kind: string;
  readonly parentId: string; readonly position: string; readonly title: string; readonly url: string;
  readonly description: string | null; readonly tags: readonly unknown[]; readonly visibility: string;
  readonly revision: string; readonly etag: string; readonly readOnly: boolean;
  readonly readOnlyReason: string | null; readonly createdAt: string; readonly updatedAt: string;
  readonly iconUrl: string | null;
}

describeWithPostgres('FO-04 extension favicon helper HTTP (stale-client boundary)', () => {
  let isolated: IsolatedPostgresRuntime;
  let factory: ReturnType<typeof createPostgresBetterAuthTestFactory>;
  let auth: Awaited<ReturnType<typeof createExtensionAuthFixture>>;
  let ownerClient: ExtensionClient;
  let owner: { cookie: string; csrfToken: string; accountId: string; subjectId: string };
  let other: { cookie: string; csrfToken: string; accountId: string; subjectId: string };
  let stranger: { cookie: string; csrfToken: string; accountId: string; subjectId: string };
  let editorExtension: ExtensionClient;
  let strangerExtension: ExtensionClient;
  let config: ReturnType<typeof loadConfig>;
  const collectionId = 'favicon-fo04-collection-0001';
  const rootId = 'favicon-fo04-root-node-0000001';
  const bookmarkId = 'favicon-fo04-bookmark-node-0001';
  const bookmarkA = 'favicon-fo04-bookmark-node-0002';

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('fo04_favicon_helper', { maxConnections: 8 });
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
      SYNC_EXTENSION_IDS: EXTENSION_ID,
    });
    factory = createPostgresBetterAuthTestFactory({ db: isolated.runtime.db });
    owner = await issueTestSession({ factory,
      subject: `fo04-owner-${randomUUID()}`, handle: `fo4o${randomUUID().replaceAll('-', '').slice(0, 12)}` });
    other = await issueTestSession({ factory,
      subject: `fo04-other-${randomUUID()}`, handle: `fo4r${randomUUID().replaceAll('-', '').slice(0, 12)}` });
    stranger = await issueTestSession({ factory,
      subject: `fo04-stranger-${randomUUID()}`, handle: `fo4s${randomUUID().replaceAll('-', '').slice(0, 12)}` });
    // The helper resolves the extension JWT through account_identities, not
    // accounts.subject_id. issueTestSession does not write that row.
    for (const [id, session] of [
      ['fo04-owner-identity', owner],
      ['fo04-editor-identity', other],
      ['fo04-stranger-identity', stranger],
    ] as const) {
      await isolated.runtime.pool.query(
        `insert into account_identities(id, account_id, issuer, subject) values ($1, $2, $3, $4)`,
        [id, session.accountId, ISSUER, session.subjectId],
      );
    }
    auth = await createExtensionAuthFixture();
    ownerClient = await extensionClientFor(auth, owner);
    editorExtension = await extensionClientFor(auth, other);
    strangerExtension = await extensionClientFor(auth, stranger);
    await seedOwnedCollection(isolated, {
      collectionId, rootId, bookmarkId,
      ownerSubjectId: owner.subjectId, bookmarkUrl: 'https://example.test/fo04-bookmark',
    });
    await isolated.runtime.pool.query(
      `insert into resource_id_ledger(resource_id, resource_type) values ($1, 'node') on conflict do nothing`,
      [bookmarkA],
    );
    await isolated.runtime.pool.query(
      `insert into nodes (
         id, collection_id, parent_id, kind, is_root, title, url, position_token,
         resource_revision, children_revision, created_at, updated_at
       ) values ($1, $2, $3, 'bookmark', false, 'FO-04 bookmark A', 'https://example.test/a', 'B2',
                 'bm-a-res-1', 'bm-a-ch-1', now(), now())`,
      [bookmarkA, collectionId, rootId],
    );
    await isolated.runtime.pool.query(
      `insert into collection_members(collection_id, subject_id, role, granted_at)
       values ($1, $2, 'editor', now())`,
      [collectionId, other.subjectId],
    );
  }, 240_000);
  afterAll(async () => isolated?.close());

  async function extensionClientFor(
    auth: Awaited<ReturnType<typeof createExtensionAuthFixture>>,
    session: { readonly accountId: string; readonly subjectId: string },
  ): Promise<ExtensionClient> {
    return {
      authorization: `Bearer ${await auth.token(session.subjectId)}`,
      accountId: session.accountId,
      subjectId: session.subjectId,
    };
  }

  function buildApp(overrides: Partial<ReturnType<typeof loadConfig>> = {}) {
    return buildApiApp({
      config: { ...config, ...overrides },
      identityUnitOfWork: createPostgresIdentityUnitOfWork(isolated.runtime.db),
      collectionsUnitOfWork: createPostgresCollectionsUnitOfWork(isolated.runtime.db),
      productCollectionMutationUnitOfWork: createPostgresCanonicalMutationUnitOfWork(
        isolated.runtime.db, { productOrigin: ORIGIN }),
      browserSessionAuthority: factory.authority,
      faviconStore: createMemoryFaviconObjectStore(),
      extensionCollectionRoutes: {
        credentialVerifier: auth.verifier,
        allowedOrigins: [EXTENSION_ORIGIN],
        ownedCollectionsQuery: {
          reads: { async listOwnedCollections() { return []; } },
          cursors: createProductOwnedCollectionsCursorSigner({
            current: { id: 'fo04-helper-v1', key: 'fo04-helper-cursor-hmac-key-material' },
          }),
          clock: { now: async () => new Date() },
        },
        ownerSubject: createPostgresExtensionOwnerSubjectPort(isolated.runtime.db),
      },
    });
  }

  function sourcePath(id = bookmarkId): string {
    return `/colp/v0.1/sync/collections/${collectionId}/nodes/${id}/favicon-source`;
  }

  function capturePath(id = bookmarkId): string {
    return `/colp/v0.1/sync/collections/${collectionId}/nodes/${id}/favicon`;
  }

  test('getExtensionFaviconPolicy: virtual default revision 1 with strong policy ETag', async () => {
    const app = buildApp();
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    try {
      const response = await api('GET', `${address}${POLICY_PATH}`, { authorization: ownerClient.authorization });
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
        `select created_at from accounts where id = $1`, [ownerClient.accountId])).rows[0] as { created_at: Date };
      assert.equal(policy.updatedAt, accountCreated.created_at.toISOString());
      // The helper GET never creates a policy row.
      const rows = await isolated.runtime.pool.query(
        `select count(*)::int n from account_favicon_policies where account_id = $1`, [ownerClient.accountId]);
      assert.equal(rows.rows[0]?.n, 0);
    } finally { await app.close(); }
  });

  test('getExtensionFaviconSource: virtual inherit view on a fresh bookmark with composite ETag', async () => {
    const app = buildApp();
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    try {
      const response = await api('GET', `${address}${sourcePath(bookmarkA)}`, { authorization: ownerClient.authorization });
      assert.equal(response.status, 200);
      assert.match(response.headers.etag ?? '', /^"favicon-source:[A-Za-z0-9._~-]{1,128}:1"$/u);
      const source = assertIconSource(response.json);
      assert.equal(source.collectionId, collectionId);
      assert.equal(source.nodeId, bookmarkA);
      assert.equal(source.revision, '1');
      assert.equal(source.policyRevision, '1');
      assert.equal(source.sourceMode, 'inherit');
      assert.equal(source.effectiveMode, 'capture');
      assert.equal(source.iconUrl, null);
      assert.equal(source.iconVersion, null);
      assert.equal(source.directUrl, null);
      assert.equal(source.status, 'missing');
      assert.equal(source.restorable, false);
    } finally { await app.close(); }
  });

  test('captureExtensionFavicon happy path: validators + bytes land a binding and the source view reflects it', async () => {
    const app = buildApp();
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    try {
      const source = await api('GET', `${address}${sourcePath(bookmarkA)}`, { authorization: ownerClient.authorization });
      const etag = source.headers.etag ?? '';
      const response = await apiBuffer('POST', `${address}${capturePath(bookmarkA)}`, {
        authorization: ownerClient.authorization, commandId: randomUUID(),
        ifMatch: etag, policyRevision: '1', rawBody: PNG, contentType: 'image/png',
      });
      assert.equal(response.status, 200, JSON.stringify(response.json));
      assert.equal(response.headers['cache-control'], 'private, no-store');
      const view = assertBookmarkNodeView(response.json);
      assert.equal(view.kind, 'bookmark');
      assert.equal(view.id, bookmarkA);
      assert.match(view.iconUrl ?? '', /^https:\/\/app\.example\.test\/api\/v1\/favicon\/[0-9a-f-]{36}$/u);
      const binding = (await isolated.runtime.pool.query(
        `select object_id, content_type from bookmark_icons where node_id = $1`, [bookmarkA])).rows[0] as
        { object_id: string; content_type: string };
      assert.match(binding.object_id, OBJECT_ID_PATTERN);
      assert.equal(binding.content_type, 'image/png');
      const sourceRow = (await isolated.runtime.pool.query(
        `select source_mode, revision from bookmark_icon_sources where node_id = $1`, [bookmarkA])).rows[0] as
        { source_mode: string; revision: string };
      assert.deepEqual(sourceRow, { source_mode: 'inherit', revision: '2' });

      const after = await api('GET', `${address}${sourcePath(bookmarkA)}`, { authorization: ownerClient.authorization });
      assert.equal(after.status, 200);
      const afterView = assertIconSource(after.json);
      assert.equal(afterView.revision, '2');
      assert.equal(afterView.sourceMode, 'inherit');
      assert.equal(afterView.iconVersion, binding.object_id);
      assert.equal(afterView.status, 'ready');
      assert.match(after.headers.etag ?? '', /^"favicon-source:[A-Za-z0-9._~-]{1,128}:2"$/u);
      // F-B1: the capture 200 must carry the composite source ETag exactly like
      // the subsequent getExtensionFaviconSource response.
      assert.ok(typeof response.headers.etag === 'string' && response.headers.etag.length > 0,
        'capture 200 must carry an ETag');
      assert.equal(response.headers.etag, after.headers.etag,
        'capture ETag must match the composite source ETag returned by getExtensionFaviconSource');
    } finally { await app.close(); }
  });

  test('clearExtensionCapturedFavicon: removes the binding and re-fences the source revision', async () => {
    const app = buildApp();
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    try {
      const source = await api('GET', `${address}${sourcePath(bookmarkA)}`, { authorization: ownerClient.authorization });
      assert.equal(source.status, 200);
      const etag = source.headers.etag ?? '';
      const clear = await api('DELETE', `${address}${capturePath(bookmarkA)}`, {
        authorization: ownerClient.authorization, commandId: randomUUID(),
        ifMatch: etag, policyRevision: '1',
      });
      assert.equal(clear.status, 200, JSON.stringify(clear.json));
      const view = assertBookmarkNodeView(clear.json);
      assert.equal(view.iconUrl, null);
      const binding = await isolated.runtime.pool.query(
        `select count(*)::int n from bookmark_icons where node_id = $1`, [bookmarkA]);
      assert.equal(binding.rows[0]?.n, 0);
      const sourceRow = (await isolated.runtime.pool.query(
        `select source_mode, revision from bookmark_icon_sources where node_id = $1`, [bookmarkA])).rows[0] as
        { source_mode: string; revision: string };
      assert.deepEqual(sourceRow, { source_mode: 'inherit', revision: '3' });
      const after = await api('GET', `${address}${sourcePath(bookmarkA)}`, { authorization: ownerClient.authorization });
      assert.equal(assertIconSource(after.json).iconUrl, null);
      assert.equal(assertIconSource(after.json).revision, '3');
      // F-B1: the clear 200 must carry the composite source ETag exactly like
      // the subsequent getExtensionFaviconSource response.
      assert.ok(typeof clear.headers.etag === 'string' && clear.headers.etag.length > 0,
        'clear 200 must carry an ETag');
      assert.equal(clear.headers.etag, after.headers.etag,
        'clear ETag must match the composite source ETag returned by getExtensionFaviconSource');
    } finally { await app.close(); }
  });

  test('stale client boundary: missing validators and blind command-id swaps are 428; stale pair is 412', async () => {
    const app = buildApp();
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const freshNode = 'favicon-fo04-bookmark-node-0003';
    await isolated.runtime.pool.query(
      `insert into resource_id_ledger(resource_id, resource_type) values ($1, 'node') on conflict do nothing`,
      [freshNode],
    );
    await isolated.runtime.pool.query(
      `insert into nodes (
         id, collection_id, parent_id, kind, is_root, title, url, position_token,
         resource_revision, children_revision, created_at, updated_at
       ) values ($1, $2, $3, 'bookmark', false, 'FO-04 stale node', 'https://example.test/stale', 'B3',
                 'bm-stale-res-1', 'bm-stale-ch-1', now(), now())`,
      [freshNode, collectionId, rootId],
    );
    const path = `${address}${capturePath(freshNode)}`;
    try {
      // Legacy queue: POST captured bytes with no validators at all.
      const noValidators = await apiBuffer('POST', path, {
        authorization: ownerClient.authorization, commandId: randomUUID(), rawBody: PNG, contentType: 'image/png',
      });
      assert.equal(noValidators.status, 428);
      assertProductError(noValidators.json, ['precondition_required']);

      // The same old bytes replayed under a FRESH command id, still without
      // the new validators, is still 428 — never accepted.
      const blindSwap = await apiBuffer('POST', path, {
        authorization: ownerClient.authorization, commandId: randomUUID(), rawBody: PNG, contentType: 'image/png',
      });
      assert.equal(blindSwap.status, 428);
      assertProductError(blindSwap.json, ['precondition_required']);

      // Only If-Match present => 428 with precondition_required.
      const onlyEtag = await apiBuffer('POST', path, {
        authorization: ownerClient.authorization, commandId: randomUUID(),
        ifMatch: '"favicon-source:bm-stale-res-1:1"', rawBody: PNG, contentType: 'image/png',
      });
      assert.equal(onlyEtag.status, 428);

      // Only the policy revision present => 428.
      const onlyPolicy = await apiBuffer('POST', path, {
        authorization: ownerClient.authorization, commandId: randomUUID(),
        policyRevision: '1', rawBody: PNG, contentType: 'image/png',
      });
      assert.equal(onlyPolicy.status, 428);

      // An obsolete validator pair (stale policy revision) is 412.
      const stale = await apiBuffer('POST', path, {
        authorization: ownerClient.authorization, commandId: randomUUID(),
        ifMatch: '"favicon-source:bm-stale-res-1:1"', policyRevision: '9', rawBody: PNG, contentType: 'image/png',
      });
      assert.equal(stale.status, 412, JSON.stringify(stale.json));
      assertProductError(stale.json, ['precondition_failed']);
      const kept = await isolated.runtime.pool.query(
        `select count(*)::int n from bookmark_icons where node_id = $1`, [freshNode]);
      assert.equal(kept.rows[0]?.n, 0);
    } finally { await app.close(); }
  });

  test('protected source state: uploaded and none captures/clears are 403 and never displace user intent', async () => {
    const app = buildApp();
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const uploadedNode = 'favicon-fo04-bookmark-node-0004';
    const noneNode = 'favicon-fo04-bookmark-node-0005';
    const protectedPositions = new Map<string, string>([
      [uploadedNode, 'B4'],
      [noneNode, 'B5'],
    ]);
    for (const [id, url] of [
      [uploadedNode, 'https://example.test/uploaded'],
      [noneNode, 'https://example.test/none'],
    ] as const) {
      await isolated.runtime.pool.query(
        `insert into resource_id_ledger(resource_id, resource_type) values ($1, 'node') on conflict do nothing`,
        [id],
      );
      await isolated.runtime.pool.query(
        `insert into nodes (
           id, collection_id, parent_id, kind, is_root, title, url, position_token,
           resource_revision, children_revision, created_at, updated_at
         ) values ($1, $2, $3, 'bookmark', false, 'FO-04 protected', $4, $5,
                   'bm-protected-res-1', 'bm-protected-ch-1', now(), now())`,
        [id, collectionId, rootId, url, protectedPositions.get(id)],
      );
    }
    // uploaded: the real manual upload state (binding + source mode uploaded).
    await isolated.runtime.pool.query(
      `insert into bookmark_icon_sources(node_id, collection_id, source_mode, revision, updated_at)
       values ($1, $2, 'uploaded', 2, now())`,
      [uploadedNode, collectionId],
    );
    // none: the explicit Product delete state.
    await isolated.runtime.pool.query(
      `insert into bookmark_icon_sources(node_id, collection_id, source_mode, revision, updated_at)
       values ($1, $2, 'none', 2, now())`,
      [noneNode, collectionId],
    );
    try {
      for (const id of [uploadedNode, noneNode]) {
        const source = await api('GET', `${address}${sourcePath(id)}`, { authorization: ownerClient.authorization });
        assert.equal(source.status, 200, `${id} source read`);
        const refused = await apiBuffer('POST', `${address}${capturePath(id)}`, {
          authorization: ownerClient.authorization, commandId: randomUUID(),
          ifMatch: source.headers.etag ?? '', policyRevision: '1', rawBody: PNG, contentType: 'image/png',
        });
        assert.equal(refused.status, 403, `${id} must be refused: ${JSON.stringify(refused.json)}`);
        assertProductError(refused.json, ['insufficient_permission']);
        const cleared = await api('DELETE', `${address}${capturePath(id)}`, {
          authorization: ownerClient.authorization, commandId: randomUUID(),
          ifMatch: source.headers.etag ?? '', policyRevision: '1',
        });
        assert.equal(cleared.status, 403, `${id} clear must also be refused`);
      }
      // The protected source modes never gained a binding.
      const kept = await isolated.runtime.pool.query(
        `select count(*)::int n from bookmark_icons where node_id = any($1::text[])`,
        [[uploadedNode, noneNode]],
      );
      assert.equal(kept.rows[0]?.n, 0);
    } finally { await app.close(); }
  });

  test('receipt order: exact replay with the now-stale ETag returns the saved outcome; changed body is 409', async () => {
    const app = buildApp();
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const node = bookmarkA;
    try {
      const source = await api('GET', `${address}${sourcePath(node)}`, { authorization: ownerClient.authorization });
      const etag = source.headers.etag ?? '';
      const commandId = randomUUID();
      const first = await apiBuffer('POST', `${address}${capturePath(node)}`, {
        authorization: ownerClient.authorization, commandId,
        ifMatch: etag, policyRevision: '1', rawBody: PNG, contentType: 'image/png',
      });
      assert.equal(first.status, 200, JSON.stringify(first.json));
      const firstView = assertBookmarkNodeView(first.json);

      // Exact replay: same command id + same bytes + the ORIGINAL (now stale)
      // ETag replays the saved 200 before fresh If-Match is checked.
      const replay = await apiBuffer('POST', `${address}${capturePath(node)}`, {
        authorization: ownerClient.authorization, commandId,
        ifMatch: etag, policyRevision: '1', rawBody: PNG, contentType: 'image/png',
      });
      assert.equal(replay.status, 200, JSON.stringify(replay.json));
      assert.deepEqual(assertBookmarkNodeView(replay.json), firstView);

      // F-B4: a receipt REPLAY 200 also carries the composite source ETag —
      // the write-time snapshot stored in the receipt, equal to the created
      // response tag and (while nothing else mutated) the current
      // getExtensionFaviconSource projection.
      const currentSource = await api('GET', `${address}${sourcePath(node)}`,
        { authorization: ownerClient.authorization });
      assert.equal(currentSource.status, 200);
      assert.ok(typeof replay.headers.etag === 'string' && replay.headers.etag.length > 0,
        'replay 200 must carry an ETag');
      assert.equal(replay.headers.etag, first.headers.etag,
        'replay ETag must be the write-time snapshot, equal to the created response tag');
      assert.equal(replay.headers.etag, currentSource.headers.etag,
        'replay ETag must match the composite source ETag returned by getExtensionFaviconSource');
      const receiptRow = (await isolated.runtime.pool.query(
        `select result_headers ->> 'etag' as etag from product_command_receipts
         where principal_id = $1 and command_scope = $2 and command_id = $3`,
        [ownerClient.accountId, `collection:${collectionId}:node:${node}:favicon:helper-capture`, commandId],
      )).rows[0] as { etag: string | null } | undefined;
      assert.equal(receiptRow?.etag, first.headers.etag,
        'the receipt stores the response ETag in stableHeaders at write time');

      // Changed fingerprint with the same command id is 409 command_id_reused.
      const reused = await apiBuffer('POST', `${address}${capturePath(node)}`, {
        authorization: ownerClient.authorization, commandId,
        ifMatch: etag, policyRevision: '1', rawBody: PNG, contentType: 'image/jpeg',
      });
      assert.equal(reused.status, 409, JSON.stringify(reused.json));
      assertProductError(reused.json, ['command_id_reused']);
    } finally { await app.close(); }
  });

  test('in-progress receipt is 429 rate_limited with Retry-After, never 409 command_in_progress', async () => {
    const app = buildApp();
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const node = bookmarkA;
    const commandId = randomUUID();
    try {
      const scope = `collection:${collectionId}:node:${node}:favicon:helper-capture`;
      const fingerprint = helperCaptureFingerprint(PNG, 'image/png', collectionId, node);
      await isolated.runtime.pool.query(
        `insert into product_command_receipts(
           principal_id, command_scope, command_id, request_fingerprint, claimed_at,
           compact_claim, contract_version, completed_at
         ) values ($1, $2, $3, $4, current_timestamp, false, '1.0.0', null)`,
        [ownerClient.accountId, scope, commandId, fingerprint],
      );
      const response = await apiBuffer('POST', `${address}${capturePath(node)}`, {
        authorization: ownerClient.authorization, commandId,
        ifMatch: '"favicon-source:bm-a-res-1:4"', policyRevision: '1', rawBody: PNG, contentType: 'image/png',
      });
      assert.equal(response.status, 429, JSON.stringify(response.json));
      assert.equal((response.json as { error: { code: string } }).error.code, 'rate_limited');
      assert.match(response.headers['retry-after'] ?? '', /^[0-9]+$/u);
    } finally { await app.close(); }
  });

  test('authorization: shared editors are 403, strangers and missing targets are concealed 404', async () => {
    const app = buildApp();
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    try {
      // A shared editor may update nodes but never capture/clear the owner source.
      const editorGet = await api('GET', `${address}${sourcePath(bookmarkA)}`,
        { authorization: editorExtension.authorization });
      assert.equal(editorGet.status, 403);
      assertProductError(editorGet.json, ['insufficient_permission']);
      const editorPost = await apiBuffer('POST', `${address}${capturePath(bookmarkA)}`, {
        authorization: editorExtension.authorization, commandId: randomUUID(),
        ifMatch: '"favicon-source:bm-a-res-1:4"', policyRevision: '1', rawBody: PNG, contentType: 'image/png',
      });
      assert.equal(editorPost.status, 403);
      assertProductError(editorPost.json, ['insufficient_permission']);

      // A non-member of the private collection gets the conceal 404.
      const strangerGet = await api('GET', `${address}${sourcePath(bookmarkA)}`,
        { authorization: strangerExtension.authorization });
      assert.equal(strangerGet.status, 404);
      assertProductError(strangerGet.json, ['resource_not_found']);
      const strangerPost = await apiBuffer('POST', `${address}${capturePath(bookmarkA)}`, {
        authorization: strangerExtension.authorization, commandId: randomUUID(),
        ifMatch: '"favicon-source:bm-a-res-1:4"', policyRevision: '1', rawBody: PNG, contentType: 'image/png',
      });
      assert.equal(strangerPost.status, 404);

      const missingCollection = await api('GET',
        `${address}/colp/v0.1/sync/collections/favicon-fo04-nope/nodes/${bookmarkA}/favicon-source`,
        { authorization: ownerClient.authorization });
      assert.equal(missingCollection.status, 404);
      const missingNode = await api('GET', `${address}${sourcePath('favicon-fo04-nope')}`,
        { authorization: ownerClient.authorization });
      assert.equal(missingNode.status, 404);

      // Account isolation: another active account reads its own virtual policy.
      const otherPolicy = await api('GET', `${address}${POLICY_PATH}`,
        { authorization: editorExtension.authorization });
      assert.equal(otherPolicy.status, 200);
      assert.equal(assertIconPolicy(otherPolicy.json).revision, '1');
      const kept = await isolated.runtime.pool.query(
        `select count(*)::int n from bookmark_icons where node_id = $1`, [bookmarkA]);
      // bookmarkA currently has a binding from the receipt-replay capture.
      assert.equal(kept.rows[0]?.n, 1);
    } finally { await app.close(); }
  });

  test('helper negative input: missing/malformed validators, bad binary, boundaries and 415', async () => {
    const app = buildApp();
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const pathBase = `${address}${capturePath(bookmarkA)}`;
    try {
      for (const bad of ['W/"favicon-source:r:1"', '*', '"a", "b"', 'plain']) {
        const malformed = await apiBuffer('POST', pathBase, {
          authorization: ownerClient.authorization, commandId: randomUUID(),
          ifMatch: bad, policyRevision: '1', rawBody: PNG, contentType: 'image/png',
        });
        assert.equal(malformed.status, 400, `If-Match ${bad} must be rejected`);
        assertProductError(malformed.json, ['invalid_request']);
      }
      for (const bad of ['0', 'abc', '1.5', '-1']) {
        const malformed = await apiBuffer('POST', pathBase, {
          authorization: ownerClient.authorization, commandId: randomUUID(),
          ifMatch: '"favicon-source:bm-a-res-1:4"', policyRevision: bad, rawBody: PNG, contentType: 'image/png',
        });
        assert.equal(malformed.status, 400, `policy revision ${JSON.stringify(bad)} must be rejected`);
        assertProductError(malformed.json, ['invalid_request']);
      }
      // An empty policy-revision header is treated as missing: 428.
      const emptyPolicy = await apiBuffer('POST', pathBase, {
        authorization: ownerClient.authorization, commandId: randomUUID(),
        ifMatch: '"favicon-source:bm-a-res-1:4"', policyRevision: '', rawBody: PNG, contentType: 'image/png',
      });
      assert.equal(emptyPolicy.status, 428);
      assertProductError(emptyPolicy.json, ['precondition_required']);
      const badCommand = await apiBuffer('POST', pathBase, {
        authorization: ownerClient.authorization, commandId: 'not-a-uuid',
        ifMatch: '"favicon-source:bm-a-res-1:4"', policyRevision: '1', rawBody: PNG, contentType: 'image/png',
      });
      assert.equal(badCommand.status, 400);
      assertProductError(badCommand.json, ['invalid_request']);

      const missingOrigin = await apiBuffer('POST', pathBase, {
        commandId: randomUUID(), ifMatch: '"favicon-source:bm-a-res-1:4"', policyRevision: '1',
        rawBody: PNG, contentType: 'image/png',
      });
      assert.equal(missingOrigin.status, 401);
      assertProductError(missingOrigin.json, ['authentication_required']);

      const svgBytes = await apiBuffer('POST', pathBase, {
        authorization: ownerClient.authorization, commandId: randomUUID(),
        ifMatch: '"favicon-source:bm-a-res-1:4"', policyRevision: '1', rawBody: SVG, contentType: 'image/svg+xml',
      });
      assert.equal(svgBytes.status, 415, 'declared SVG media type is rejected by admission');

      const oversized = Buffer.concat([PNG, Buffer.alloc(65_536)]);
      const tooLarge = await apiBuffer('POST', pathBase, {
        authorization: ownerClient.authorization, commandId: randomUUID(),
        ifMatch: '"favicon-source:bm-a-res-1:4"', policyRevision: '1',
        rawBody: oversized, contentType: 'image/png',
      });
      assert.equal(tooLarge.status, 413, JSON.stringify(tooLarge.json));

      const folder = await apiBuffer('POST', `${address}${capturePath(rootId)}`, {
        authorization: ownerClient.authorization, commandId: randomUUID(),
        ifMatch: '"favicon-source:root-fo04-res-1:1"', policyRevision: '1', rawBody: PNG, contentType: 'image/png',
      });
      assert.equal(folder.status, 400, 'folder nodes are not capturable');
      assertProductError(folder.json, ['invalid_request']);
    } finally { await app.close(); }
  });

  test('policy revision expiry and force-online protection: 412 on stale policy, 403 on force-online', async () => {
    const app = buildApp();
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    try {
      const source = await api('GET', `${address}${sourcePath(bookmarkId)}`, { authorization: ownerClient.authorization });
      assert.equal(source.status, 200);
      const freshEtag = source.headers.etag ?? '';

      // Advance the account policy through the Product surface to revision 2
      // with forceAllOnline=true (owner explicitly opts into the override).
      const patched = await api('PATCH', `${address}/api/v1/me/favicon-policy`, {
        cookie: owner.cookie, csrf: owner.csrfToken, commandId: randomUUID(),
        ifMatch: '"favicon-policy:1"', body: { forceAllOnline: true },
      });
      assert.equal(patched.status, 200, JSON.stringify(patched.json));
      const patchedPolicy = assertPolicyResult(patched.json);
      assert.equal(patchedPolicy.policy.revision, '2');
      assert.equal(patchedPolicy.policy.forceAllOnline, true);

      // The extension read policy revision 1 before the owner changed it.
      const stalePolicy = await apiBuffer('POST', `${address}${capturePath(bookmarkId)}`, {
        authorization: ownerClient.authorization, commandId: randomUUID(),
        ifMatch: freshEtag, policyRevision: '1', rawBody: PNG, contentType: 'image/png',
      });
      assert.equal(stalePolicy.status, 412, JSON.stringify(stalePolicy.json));
      const error = assertProductError(stalePolicy.json, ['precondition_failed']);
      assert.equal(error.currentEtag, '"favicon-policy:2"');

      // Refresh-and-retry with the current revision still refuses: the
      // force-online override is protected (403).
      const refused = await apiBuffer('POST', `${address}${capturePath(bookmarkId)}`, {
        authorization: ownerClient.authorization, commandId: randomUUID(),
        ifMatch: freshEtag, policyRevision: '2', rawBody: PNG, contentType: 'image/png',
      });
      assert.equal(refused.status, 403, JSON.stringify(refused.json));
      assertProductError(refused.json, ['insufficient_permission']);
      const kept = await isolated.runtime.pool.query(
        `select count(*)::int n from bookmark_icons where node_id = $1`, [bookmarkId]);
      assert.equal(kept.rows[0]?.n, 0);
    } finally { await app.close(); }
  });

  test('stale source ETag is 412 after a source advance and after a URL (node revision) change', async () => {
    const app = buildApp();
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const node = bookmarkA;
    try {
      // bookmarkA is inherit rev 4 with a binding from the receipt-replay test.
      const before = await api('GET', `${address}${sourcePath(node)}`, { authorization: ownerClient.authorization });
      const oldEtag = before.headers.etag ?? '';
      assert.match(oldEtag, /^"favicon-source:[A-Za-z0-9._~-]{1,128}:4"$/u);

      // Advance the source revision (a concurrent explicit mode change).
      await isolated.runtime.pool.query(
        `update bookmark_icon_sources set revision = revision + 5 where node_id = $1`, [node]);
      const sourceStale = await apiBuffer('POST', `${address}${capturePath(node)}`, {
        authorization: ownerClient.authorization, commandId: randomUUID(),
        ifMatch: oldEtag, policyRevision: '1', rawBody: PNG, contentType: 'image/png',
      });
      assert.equal(sourceStale.status, 412, JSON.stringify(sourceStale.json));
      const sourceError = assertProductError(sourceStale.json, ['precondition_failed']);
      assert.match(sourceError.currentEtag ?? '', /^"favicon-source:[A-Za-z0-9._~-]{1,128}:9"$/u);

      // The composite ETag also fences the node URL: changing the node
      // resource revision makes the old capture fail (never infer the current
      // URL from old bytes).
      const current = await api('GET', `${address}${sourcePath(node)}`, { authorization: ownerClient.authorization });
      const etagBeforeUrlChange = current.headers.etag ?? '';
      await isolated.runtime.pool.query(
        `update nodes set url = 'https://example.test/renamed', resource_revision = 'bm-a-res-2' where id = $1`,
        [node],
      );
      const urlStale = await apiBuffer('POST', `${address}${capturePath(node)}`, {
        authorization: ownerClient.authorization, commandId: randomUUID(),
        ifMatch: etagBeforeUrlChange, policyRevision: '1', rawBody: PNG, contentType: 'image/png',
      });
      assert.equal(urlStale.status, 412, JSON.stringify(urlStale.json));
      const urlError = assertProductError(urlStale.json, ['precondition_failed']);
      assert.match(urlError.currentEtag ?? '', /^"favicon-source:bm-a-res-2:/u);
    } finally { await app.close(); }
  });

  test('feature flag off: every FO-04 helper operation is 404 resource_not_found', async () => {
    const app = buildApp({ faviconPolicy: { ...config.faviconPolicy, enabled: false } });
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    try {
      const getPolicy = await api('GET', `${address}${POLICY_PATH}`, { authorization: ownerClient.authorization });
      assert.equal(getPolicy.status, 404);
      const getSource = await api('GET', `${address}${sourcePath(bookmarkA)}`,
        { authorization: ownerClient.authorization });
      assert.equal(getSource.status, 404);
      const post = await apiBuffer('POST', `${address}${capturePath(bookmarkA)}`, {
        authorization: ownerClient.authorization, commandId: randomUUID(),
        ifMatch: '"favicon-source:bm-a-res-1:4"', policyRevision: '2', rawBody: PNG, contentType: 'image/png',
      });
      assert.equal(post.status, 404);
      const del = await api('DELETE', `${address}${capturePath(bookmarkA)}`, {
        authorization: ownerClient.authorization, commandId: randomUUID(),
        ifMatch: '"favicon-source:bm-a-res-1:4"', policyRevision: '2',
      });
      assert.equal(del.status, 404);
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

function assertPolicyResult(value: unknown): { policy: IconPolicyBody; jobId: string | null } {
  assertClosedObject(value, ['policy', 'jobId'], 'PolicyResult');
  const policy = assertIconPolicy(value.policy);
  const jobId = value.jobId;
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

function assertBookmarkNodeView(value: unknown): BookmarkNodeViewBody {
  assertClosedObject(value, ['id', 'collectionId', 'kind', 'parentId', 'position', 'title', 'url',
    'description', 'tags', 'visibility', 'revision', 'etag', 'readOnly', 'readOnlyReason',
    'createdAt', 'updatedAt', 'iconUrl'], 'BookmarkNodeView');
  const body = value;
  assert.ok(typeof body.id === 'string' && body.id.length >= 1);
  assert.ok(typeof body.collectionId === 'string' && body.collectionId.length >= 1);
  assert.equal(body.kind, 'bookmark');
  assert.ok(typeof body.parentId === 'string' && typeof body.position === 'string');
  assert.ok(typeof body.title === 'string' && typeof body.url === 'string');
  assert.ok(body.description === null || typeof body.description === 'string');
  assert.ok(Array.isArray(body.tags));
  assert.ok(typeof body.visibility === 'string');
  assert.ok(typeof body.revision === 'string' && body.revision.length >= 1);
  assert.ok(typeof body.etag === 'string' && ETAG_PATTERN.test(body.etag));
  assert.equal(typeof body.readOnly, 'boolean');
  assert.ok(body.readOnlyReason === null || typeof body.readOnlyReason === 'string');
  assert.ok(typeof body.createdAt === 'string' && NODE_TIMESTAMP_PATTERN.test(body.createdAt));
  assert.ok(typeof body.updatedAt === 'string' && NODE_TIMESTAMP_PATTERN.test(body.updatedAt));
  assert.ok(body.iconUrl === null || (typeof body.iconUrl === 'string' && body.iconUrl.length >= 1));
  return body as unknown as BookmarkNodeViewBody;
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
  assert.ok(typeof code === 'string' && codes.includes(code), `error.code in [${codes.join(', ')}]`);
  assert.ok(typeof body.message === 'string' && (body.message as string).length > 0);
  assert.ok(typeof body.requestId === 'string');
  assert.ok(typeof body.recovery === 'string');
  assert.equal(typeof body.sameRequestRetrySafe, 'boolean');
  assert.ok(body.precondition === null || body.precondition === 'resource' || body.precondition === 'content');
  assert.ok(body.currentEtag === null || typeof body.currentEtag === 'string');
  assert.ok(body.retryAfterSeconds === null || typeof body.retryAfterSeconds === 'number');
  assert.ok(Array.isArray(body.fieldErrors));
  return { code, message: body.message as string, requestId: body.requestId as string,
    recovery: body.recovery as string, sameRequestRetrySafe: body.sameRequestRetrySafe as boolean,
    precondition: body.precondition as string | null, currentEtag: body.currentEtag as string | null,
    retryAfterSeconds: body.retryAfterSeconds as number | null, fieldErrors: body.fieldErrors as readonly unknown[] };
}

// ---------------------------------------------------------------------------
// HTTP plumbing + fixtures
// ---------------------------------------------------------------------------

interface ApiOptions {
  readonly authorization?: string;
  readonly cookie?: string;
  readonly csrf?: string;
  readonly commandId?: string;
  readonly ifMatch?: string;
  readonly policyRevision?: string;
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
  if (options.authorization !== undefined) headers.Authorization = options.authorization;
  if (options.cookie !== undefined) headers.Cookie = options.cookie;
  if (options.csrf !== undefined) {
    headers.Origin = ORIGIN;
    headers['X-CSRF-Token'] = options.csrf;
  }
  if (options.commandId !== undefined) headers['Known-Command-Id'] = options.commandId;
  if (options.ifMatch !== undefined) headers['If-Match'] = options.ifMatch;
  if (options.policyRevision !== undefined) headers['Known-Favicon-Policy-Revision'] = options.policyRevision;
  if (options.authorization !== undefined && options.csrf === undefined) headers.Origin = EXTENSION_ORIGIN;
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

function helperCaptureFingerprint(body: Buffer, mediaType: string, collectionId: string, nodeId: string): string {
  return canonicalCommandFingerprint({
    method: 'POST',
    route: `/colp/v0.1/sync/collections/${collectionId}/nodes/${nodeId}/favicon`,
    mediaType,
    body: createHash('sha256').update(body).digest('hex'),
  });
}

/**
 * FO-04 formal COLP credential authority: one fixture RS256 key pair, a real
 * production jose verifier and per-subject JWTs. Every request in this suite
 * is authenticated through this verifier — never a pre-resolved actor.
 */
async function createExtensionAuthFixture(): Promise<{
  readonly verifier: ExtensionCredentialEvidencePort;
  readonly token: (subject: string) => Promise<string>;
}> {
  const now = new Date('2026-09-14T00:00:00.000Z');
  const pair = await generateKeyPair('RS256', { extractable: true });
  const jwk = await exportJWK(pair.publicKey);
  Object.assign(jwk, { kid: 'fo04-fixture-jwk', alg: 'RS256', use: 'sig' });
  const config: ExtensionAuthConfig = {
    flow: 'authorization_code_pkce', issuer: ISSUER, audience: 'known-sync-api',
    clientId: 'known-chromium-extension', authorizationEndpoint: `${ISSUER}/authorize`,
    tokenEndpoint: `${ISSUER}/token`, jwksUri: `${ISSUER}/jwks`,
    redirectUri: 'https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/oauth2',
    allowedExtensionIds: [EXTENSION_ID],
    allowedRedirectOrigins: ['https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org'],
    scopes: ['known.sync'], allowedAlgorithms: ['RS256'], clockSkewSeconds: 0,
    evidenceTtlSeconds: 60,
  };
  const verifier = createExtensionCredentialEvidenceVerifier({
    config,
    jwks: { async getKeySet() { return { keys: [jwk] }; } },
    requiredScopes: ['known.sync'],
    isRevoked: async () => false,
    now: () => now,
  });
  const seconds = Math.floor(now.getTime() / 1_000);
  return {
    verifier,
    async token(subject: string) {
      const jwt = await new SignJWT({ scope: 'known.sync', client_id: 'known-chromium-extension' })
        .setProtectedHeader({ alg: 'RS256', kid: 'fo04-fixture-jwk' })
        .setIssuer(ISSUER).setSubject(subject).setAudience('known-sync-api')
        .setIssuedAt(seconds - 1).setExpirationTime(seconds + 3_600)
        .setJti(`fo04-token-${subject}`).sign(pair.privateKey);
      return jwt;
    },
  };
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
       ) values ($1, $2, 'FO-04 fixture', 'bookmarks', 'private', $3, 'coll-fo04-res-1',
                 'coll-fo04-content-1', 'coll-fo04-policy-1', 1, now(), now())`,
      [input.collectionId, input.ownerSubjectId, input.rootId],
    );
    await client.query(
      `insert into nodes (
         id, collection_id, parent_id, kind, is_root, title, url, position_token,
         resource_revision, children_revision, created_at, updated_at
       ) values ($1, $2, null, 'folder', true, 'Root', null, null,
                 'root-fo04-res-1', 'root-fo04-ch-1', now(), now())`,
      [input.rootId, input.collectionId],
    );
    await client.query(
      `insert into nodes (
         id, collection_id, parent_id, kind, is_root, title, url, position_token,
         resource_revision, children_revision, created_at, updated_at
       ) values ($1, $2, $3, 'bookmark', false, 'FO-04 bookmark', $4, 'B1',
                 'bm-fo04-res-1', 'bm-fo04-ch-1', now(), now())`,
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