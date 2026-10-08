import { insertTestParentCredential } from '../../support/account-credential-db-fixture.js';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, test } from 'vitest';
import { loadConfig } from '../../support/test-config.js';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import {
  createPersistentAvatarStore,
  createPostgresIdentityUnitOfWork,
} from '../../../src/infrastructure/identity/index.js';
import { createPostgresAccountCredentialUnitOfWork } from '../../../src/infrastructure/auth/account-credentials-postgres.js';
import { createAccountCredentialCursorCodec, createCredentialGrantCursorCodec } from '../../../src/modules/auth/index.js';
import {
  createPostgresCanonicalMutationUnitOfWork,
  createPostgresCollectionBookmarkCountReadPort,
  createPostgresCollectionsEditorReadUnitOfWork,
  createPostgresCollectionsUnitOfWork,
  createPostgresOwnedCollectionsReadPort,
} from '../../../src/infrastructure/collections/index.js';
import {
  createProductEditorCursorSigner,
  createProductOwnedCollectionsCursorSigner,
} from '../../../src/modules/collections/index.js';
import { buildApiApp } from '../../../src/transport/app.js';
import { createMemorySearchRateLimiter } from '../../../src/transport/http-security.js';
import { issueTestSession } from '../../support/product-http-harness.js';
import { createPostgresBetterAuthTestFactory } from '../../support/better-auth-test-factory.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';
import { redactSensitiveText, serializeRequestForLog } from '../../../src/infrastructure/telemetry/index.js';
import {
  AUTOMATION_IDENTITY_FIELD_NAMES,
  assertCapabilityMatrixCoversManifests,
  buildAccountBearerCapabilityMatrix,
} from './account-bearer-capability-matrix.js';

const HMAC_KEY = Buffer.alloc(32, 13).toString('base64url');
const FUTURE = '2026-12-01T00:00:00.000Z';
const ORIGIN = 'https://app.example.test';
const GRANT = 'urn:known:params:oauth:grant-type:account-key';
const ACCOUNT_CREDENTIAL_HTTP_OPERATIONS = Object.freeze([
  { method: 'POST', path: '/api/v1/auth/credential-children', operationId: 'issueChildWithParentKey' },
  { method: 'GET', path: '/api/v1/auth/credential-children', operationId: 'listChildrenWithParentKey' },
  { method: 'POST', path: '/api/v1/auth/key-token', operationId: 'exchangeAccountKey' },
  { method: 'GET', path: '/api/v1/me/credential-identity', operationId: 'getCredentialIdentity' },
  { method: 'GET', path: '/api/v1/auth/credential-children/:credentialId', operationId: 'getChildWithParentKey' },
  { method: 'POST', path: '/api/v1/auth/credential-children/:credentialId/rotate', operationId: 'rotateChildWithParentKey' },
  { method: 'POST', path: '/api/v1/auth/credential-children/:credentialId/revoke', operationId: 'revokeChildWithParentKey' },
] as const);
const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000182e403790000000049454e44ae426082',
  'hex',
);

function es256Jwk(kid: string) {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = privateKey.export({ format: 'jwk' }) as Record<string, string>;
  return { json: JSON.stringify({ ...jwk, kid, kty: 'EC', crv: 'P-256' }) };
}

function assertNoAutomationIdentity(value: unknown, path = '$'): void {
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoAutomationIdentity(item, `${path}[${index}]`));
    return;
  }
  for (const key of Object.keys(value)) {
    assert.equal(
      AUTOMATION_IDENTITY_FIELD_NAMES.includes(key),
      false,
      `${path}.${key} must be omitted when EXPOSE_AUTOMATION_IDENTITY=false`,
    );
    assertNoAutomationIdentity((value as Record<string, unknown>)[key], `${path}.${key}`);
  }
}

describeWithPostgres('account bearer product HTTP', () => {
  let isolated: IsolatedPostgresRuntime;
  let config: ReturnType<typeof loadConfig>;
  let identity: ReturnType<typeof createPostgresIdentityUnitOfWork>;
  let factory: ReturnType<typeof createPostgresBetterAuthTestFactory>;
  let cursors: ReturnType<typeof createAccountCredentialCursorCodec>;
  let grantCursors: ReturnType<typeof createCredentialGrantCursorCodec>;
  let ownedCursors: ReturnType<typeof createProductOwnedCollectionsCursorSigner>;
  const signing = es256Jwk('ac03-es256');
  const avatarStore = {
    objects: new Map<string, { contentType: string; body: Buffer }>(),
    async put(avatarId: string, body: Buffer, contentType: string) {
      this.objects.set(avatarId, { contentType, body: Buffer.from(body) });
    },
    async get(avatarId: string) { return this.objects.get(avatarId) ?? null; },
    async delete(avatarId: string) { this.objects.delete(avatarId); },
  };

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('ac03_account_bearer', {
      maxConnections: 12,
      applicationName: 'known-ac03-account-bearer',
    });
    await runMigrations(isolated.runtime.db, 'latest');
    config = loadConfig({
      ...process.env,
      DATABASE_URL: isolated.databaseUrl,
      NODE_ENV: 'test',
      OIDC_ALLOW_TEST_PROVIDER: 'true',
      OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default',
      PRODUCT_ORIGIN: ORIGIN,
      ALLOWED_ORIGINS: ORIGIN,
      PUBLICATION_ORIGIN: ORIGIN,
      PUBLICATION_SERVER_UUID: '019b3c67-a03c-7f02-9c7e-1ee8d50a77de',
      PRODUCT_EDITOR_CURSOR_HMAC_KEY: 'ac03-editor-cursor-key',
      LOG_LEVEL: 'silent',
      KNOWN_FEATURE_ACCOUNT_CREDENTIALS: 'true',
      AUTOMATION_CURSOR_HMAC_KEY: HMAC_KEY,
      AUTOMATION_ES256_PRIVATE_JWK: signing.json,
      EXPOSE_AUTOMATION_IDENTITY: 'false',
    });
    identity = createPostgresIdentityUnitOfWork(isolated.runtime.db, {
      oidcTransactionSecrets: config.oidcTransactionSecrets,
    });
    factory = createPostgresBetterAuthTestFactory({ db: isolated.runtime.db, baseURL: ORIGIN });
    cursors = createAccountCredentialCursorCodec(HMAC_KEY);
    grantCursors = createCredentialGrantCursorCodec(HMAC_KEY);
    ownedCursors = createProductOwnedCollectionsCursorSigner({
      current: { id: 'ac03-owned-v1', key: 'ac03-owned-collections-cursor-secret-32b' },
    });
  }, 120_000);

  afterAll(async () => {
    cursors?.destroy();
    grantCursors?.destroy();
    ownedCursors?.destroy();
    await isolated?.close();
  });

  function compose(featureOn = true, surfaces: { readonly accountCredentials?: boolean } = {}) {
    const includeCredentials = surfaces.accountCredentials !== false;
    const cfg = featureOn ? config : loadConfig({
      ...process.env,
      DATABASE_URL: isolated.databaseUrl,
      NODE_ENV: 'test',
      OIDC_ALLOW_TEST_PROVIDER: 'true',
      OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default',
      PRODUCT_ORIGIN: ORIGIN,
      ALLOWED_ORIGINS: ORIGIN,
      PRODUCT_EDITOR_CURSOR_HMAC_KEY: 'ac03-editor-cursor-key',
      LOG_LEVEL: 'silent',
      KNOWN_FEATURE_ACCOUNT_CREDENTIALS: 'false',
    });
    const editorCursors = createProductEditorCursorSigner({
      current: cfg.productEditorCursor.current,
      previous: cfg.productEditorCursor.previous,
    });
    return buildApiApp({
      config: cfg,
      identityUnitOfWork: identity,
      browserSessionAuthority: factory.authority,
      ...(includeCredentials
        ? {
          accountCredentialUnitOfWork: createPostgresAccountCredentialUnitOfWork(isolated.runtime.db, undefined, undefined,
            { secretHmacKey: HMAC_KEY }),
          accountCredentialCursors: featureOn ? cursors : null,
          accountCredentialGrantCursors: featureOn ? grantCursors : null,
        }
        : {}),
      collectionsUnitOfWork: createPostgresCollectionsUnitOfWork(isolated.runtime.db),
      productCollectionMutationUnitOfWork: createPostgresCanonicalMutationUnitOfWork(isolated.runtime.db),
      collectionsEditorReadUnitOfWork: createPostgresCollectionsEditorReadUnitOfWork(isolated.runtime.db, {
        cursorSigner: editorCursors,
        cursorTtlMs: cfg.productEditorCursor.ttlMs,
      }),
      ownedCollectionsQuery: {
        reads: createPostgresOwnedCollectionsReadPort(isolated.runtime.db),
        cursors: ownedCursors,
        clock: { now: async () => new Date() },
      },
      bookmarkCounts: createPostgresCollectionBookmarkCountReadPort(isolated.runtime.db),
      // Mirror src/bootstrap/api.ts:332 so the avatar_objects attribution row
      // satisfies the profile_avatar_upload_authority trigger.
      avatarStore: createPersistentAvatarStore(isolated.runtime.db, avatarStore),
      searchQuery: {
        async execute(input) {
          return {
            normalizedQuery: input.query,
            types: input.types ?? ['collection', 'node', 'profile', 'annotation'],
            items: [],
            page: { returnedCount: 0, hasMore: false, nextCursor: null },
            cache: input.principal.kind === 'anonymous'
              ? { class: 'shared-public', partition: 'anonymous-representation-partition' }
              : { class: 'private-no-store', partition: null },
            consistency: { authority: 'recheck-each-page', ranking: 'restart-on-mutation' },
          };
        },
      },
      searchRateLimiter: createMemorySearchRateLimiter({
        anonymousMaxRequests: 10_000, accountMaxRequests: 10_000, windowMs: 60_000,
      }),
    });
  }

  async function session(prefix = 'ac03') {
    return issueTestSession({
      factory,
      subject: `${prefix}-${randomUUID()}`,
      handle: `h${randomUUID().replaceAll('-', '').slice(0, 12)}`,
    });
  }

  async function issueSameAccountChild(app: ReturnType<typeof buildApiApp>) {
    const actor = await session();
    const parent = await insertTestParentCredential(isolated.runtime.db, actor, HMAC_KEY, FUTURE);
    const child = await app.inject({
      method: 'POST', url: '/api/v1/auth/credential-children',
      headers: {
        authorization: `Bearer ${parent.secret}`,
        'content-type': 'application/json', 'known-command-id': randomUUID(),
      },
      payload: { label: 'child', expiresAt: FUTURE, account: { mode: 'existing', accountId: actor.accountId } },
    });
    assert.equal(child.statusCode, 201, child.body);
    assert.equal(child.json().credential.accountId, actor.accountId);
    return {
      actor,
      secret: child.json().secret as string,
      parentSecret: parent.secret,
      credential: child.json().credential as { id: string; accountId: string; subjectId: string },
    };
  }

  async function productToken(app: ReturnType<typeof buildApiApp>, secret: string, scope = 'product:read product:write') {
    const response = await app.inject({
      method: 'POST', url: '/api/v1/auth/key-token',
      headers: { 'content-type': 'application/json' },
      payload: { grant_type: GRANT, credential: secret, audience: 'product', scope },
    });
    assert.equal(response.statusCode, 200, response.body);
    return response.json().access_token as string;
  }

  test('capability matrix covers registered Product, auth, MCP, and COLP entries', () => {
    const matrix = buildAccountBearerCapabilityMatrix();
    assertCapabilityMatrixCoversManifests(matrix, assert);
    assert.ok(matrix.length > 100, `expected a full inventory, got ${matrix.length}`);
  });

  test('Cookie and bearer share one account on profile GET and collection write', async () => {
    const app = compose();
    try {
      const issued = await issueSameAccountChild(app);
      const token = await productToken(app, issued.secret);
      const cookieMe = await app.inject({ method: 'GET', url: '/api/v1/me', headers: { cookie: issued.actor.cookie } });
      const bearerMe = await app.inject({
        method: 'GET', url: '/api/v1/me', headers: { authorization: `Bearer ${token}` },
      });
      assert.equal(cookieMe.statusCode, 200, cookieMe.body);
      assert.equal(bearerMe.statusCode, 200, bearerMe.body);
      assert.equal(cookieMe.json().account.id, issued.actor.accountId);
      assert.equal(bearerMe.json().account.id, issued.actor.accountId);
      assertNoAutomationIdentity(cookieMe.json());
      assertNoAutomationIdentity(bearerMe.json());

      const cookieWrite = await app.inject({
        method: 'POST', url: '/api/v1/collections',
        headers: {
          cookie: issued.actor.cookie, origin: ORIGIN, 'x-csrf-token': issued.actor.csrfToken,
          'content-type': 'application/json', 'known-command-id': randomUUID(),
        },
        payload: { kind: 'bookmarks', title: 'cookie collection', summary: null },
      });
      const bearerWrite = await app.inject({
        method: 'POST', url: '/api/v1/collections',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json', 'known-command-id': randomUUID(),
        },
        payload: { kind: 'bookmarks', title: 'bearer collection', summary: null },
      });
      assert.equal(cookieWrite.statusCode, 201, cookieWrite.body);
      assert.equal(bearerWrite.statusCode, 201, bearerWrite.body);
      assert.equal(typeof cookieWrite.json().collection.id, 'string');
      assert.equal(typeof bearerWrite.json().collection.id, 'string');
      assertNoAutomationIdentity(cookieWrite.json());
      assertNoAutomationIdentity(bearerWrite.json());
    } finally {
      await app.close();
    }
  });

  test('mixed Cookie+Authorization is rejected; CSRF is not regressed', async () => {
    const app = compose();
    try {
      const issued = await issueSameAccountChild(app);
      const token = await productToken(app, issued.secret);
      const mixedGet = await app.inject({
        method: 'GET', url: '/api/v1/me',
        headers: { cookie: issued.actor.cookie, authorization: `Bearer ${token}` },
      });
      assert.equal(mixedGet.statusCode, 400, mixedGet.body);
      assert.equal(mixedGet.json().error.code, 'invalid_request');
      const mixedWrite = await app.inject({
        method: 'POST', url: '/api/v1/collections',
        headers: {
          cookie: issued.actor.cookie, authorization: `Bearer ${token}`,
          origin: ORIGIN, 'x-csrf-token': issued.actor.csrfToken,
          'content-type': 'application/json', 'known-command-id': randomUUID(),
        },
        payload: { kind: 'bookmarks', title: 'mixed', summary: null },
      });
      assert.equal(mixedWrite.statusCode, 400, mixedWrite.body);
      const bearerNoCsrf = await app.inject({
        method: 'POST', url: '/api/v1/collections',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json', 'known-command-id': randomUUID(),
        },
        payload: { kind: 'bookmarks', title: 'bearer no csrf', summary: null },
      });
      assert.equal(bearerNoCsrf.statusCode, 201, bearerNoCsrf.body);
      const cookieNoCsrf = await app.inject({
        method: 'POST', url: '/api/v1/collections',
        headers: {
          cookie: issued.actor.cookie, origin: ORIGIN,
          'content-type': 'application/json', 'known-command-id': randomUUID(),
        },
        payload: { kind: 'bookmarks', title: 'cookie no csrf', summary: null },
      });
      assert.equal(cookieNoCsrf.statusCode, 403, cookieNoCsrf.body);
    } finally {
      await app.close();
    }
  });

  test('foreign private collection is denied for both carriers; parent key cannot enter business APIs', async () => {
    const app = compose();
    try {
      const owner = await issueSameAccountChild(app);
      const ownerToken = await productToken(app, owner.secret);
      const created = await app.inject({
        method: 'POST', url: '/api/v1/collections',
        headers: {
          authorization: `Bearer ${ownerToken}`,
          'content-type': 'application/json', 'known-command-id': randomUUID(),
        },
        payload: { kind: 'bookmarks', title: 'private owner collection', summary: null },
      });
      assert.equal(created.statusCode, 201, created.body);
      const collectionId = created.json().collection.id as string;
      const stranger = await issueSameAccountChild(app);
      const strangerToken = await productToken(app, stranger.secret);
      for (const headers of [
        { cookie: stranger.actor.cookie },
        { authorization: `Bearer ${strangerToken}` },
      ]) {
        const editor = await app.inject({
          method: 'GET', url: `/api/v1/collections/${collectionId}/editor`, headers,
        });
        // The collection was created private, and the access policy conceals
        // existence for a non-member of a private/protected/unlisted collection
        // (`access-policy/domain/evaluate.ts`). `403 || 404` accepted either
        // verdict, so a leak of existence through 403 could not fail this test.
        assert.equal(editor.statusCode, 404, editor.body);
      }
      const parentOnMe = await app.inject({
        method: 'GET', url: '/api/v1/me',
        headers: { authorization: `Bearer ${owner.parentSecret}` },
      });
      assert.equal(parentOnMe.statusCode, 401, parentOnMe.body);
      const parentWrite = await app.inject({
        method: 'POST', url: '/api/v1/collections',
        headers: {
          authorization: `Bearer ${owner.parentSecret}`,
          'content-type': 'application/json', 'known-command-id': randomUUID(),
        },
        payload: { kind: 'bookmarks', title: 'parent key', summary: null },
      });
      assert.equal(parentWrite.statusCode, 401, parentWrite.body);
    } finally {
      await app.close();
    }
  });

  test('sensitive email/password/MFA routes still deny bearer without proof', async () => {
    const app = compose();
    try {
      const issued = await issueSameAccountChild(app);
      const token = await productToken(app, issued.secret);
      const attempts = [
        { method: 'POST' as const, url: '/api/v1/auth/change-password', payload: { newPassword: 'N0tProof!' } },
        { method: 'POST' as const, url: '/api/v1/auth/email-otp/change-email', payload: { newEmail: 'x@example.test' } },
        { method: 'POST' as const, url: '/api/v1/auth/two-factor/enable', payload: { password: 'x' } },
        { method: 'POST' as const, url: '/api/v1/auth/account/delete', payload: { confirmation: 'DELETE' } },
      ];
      for (const attempt of attempts) {
        const response = await app.inject({
          method: attempt.method, url: attempt.url,
          headers: {
            authorization: `Bearer ${token}`, origin: ORIGIN, 'content-type': 'application/json',
          },
          payload: attempt.payload,
        });
        assert.ok(
          response.statusCode === 401 || response.statusCode === 403 || response.statusCode === 404,
          `${attempt.url} ${response.statusCode} ${response.body}`,
        );
        assert.notEqual(response.statusCode, 200);
      }
    } finally {
      await app.close();
    }
  });

  test('avatar upload uses real HTTP with bearer; privacy holds on search DTO and logs', async () => {
    const app = compose();
    try {
      const issued = await issueSameAccountChild(app);
      const token = await productToken(app, issued.secret);
      const upload = await app.inject({
        method: 'POST', url: '/api/v1/me/avatar',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'image/png',
          'known-command-id': randomUUID(),
        },
        payload: PNG,
      });
      assert.equal(upload.statusCode, 200, upload.body);
      assert.match(upload.json().profile.avatarUrl, /^https:\/\/app\.example\.test\/api\/v1\/avatar\//u);
      assertNoAutomationIdentity(upload.json());

      const search = await app.inject({
        method: 'GET', url: '/api/v1/search?q=known',
        headers: { accept: 'application/json', authorization: `Bearer ${token}` },
      });
      assert.equal(search.statusCode, 200, search.body);
      assert.equal(search.headers['cache-control'], 'private, no-store');
      assertNoAutomationIdentity(search.json());

      const dump = serializeRequestForLog({
        method: 'GET', url: `/api/v1/me?secret=${issued.secret}`,
        headers: { host: 'app.example.test', authorization: `Bearer ${token}` },
      });
      assert.equal(JSON.stringify(dump).includes(issued.secret), false);
      assert.equal(JSON.stringify(dump).includes('kn_c_'), false);
      const redacted = redactSensitiveText(`Authorization: Bearer ${issued.secret} parent=${issued.parentSecret}`);
      assert.equal(redacted.includes(issued.secret), false);
      assert.equal(redacted.includes(issued.parentSecret), false);
      assert.equal(redacted.includes('kn_c_'), false);
      assert.equal(redacted.includes('kn_p_'), false);
    } finally {
      await app.close();
    }
  });

  test('feature-off keeps cookie profile and collection flows', async () => {
    const app = compose(false);
    try {
      const actor = await session('ac03off');
      const me = await app.inject({ method: 'GET', url: '/api/v1/me', headers: { cookie: actor.cookie } });
      assert.equal(me.statusCode, 200, me.body);
      const created = await app.inject({
        method: 'POST', url: '/api/v1/collections',
        headers: {
          cookie: actor.cookie, origin: ORIGIN, 'x-csrf-token': actor.csrfToken,
          'content-type': 'application/json', 'known-command-id': randomUUID(),
        },
        payload: { kind: 'bookmarks', title: 'feature off cookie', summary: null },
      });
      assert.equal(created.statusCode, 201, created.body);
      const bearerDenied = await app.inject({
        method: 'POST', url: '/api/v1/collections',
        headers: {
          authorization: 'Bearer eyJhbGciOiJFUzI1NiIsInR5cCI6IkpXVCJ9.e30.e30',
          'content-type': 'application/json', 'known-command-id': randomUUID(),
        },
        payload: { kind: 'bookmarks', title: 'feature off bearer', summary: null },
      });
      assert.equal(bearerDenied.statusCode, 401, bearerDenied.body);
    } finally {
      await app.close();
    }
  });

  test('bot operations remain registered and hidden from browser sessions', async () => {
    const app = compose();
    try {
      for (const operation of ACCOUNT_CREDENTIAL_HTTP_OPERATIONS) {
        assert.equal(
          app.hasRoute({ method: operation.method, url: operation.path }),
          true,
          `${operation.operationId} ${operation.method} ${operation.path} is not registered`,
        );
      }
      const actor = await session('ac07reg');
      for (const operation of ACCOUNT_CREDENTIAL_HTTP_OPERATIONS) {
        const url = operation.path
          .replace(':credentialId', 'missing-credential')
          .replace(':parentId', 'missing-parent')
          .replace(':grantId', 'missing-grant')
          .replace(':planKind', 'collection')
          .replace(':planId', 'missing-plan');
        const response = await app.inject({
          method: operation.method,
          url,
          headers: {
            cookie: actor.cookie,
            origin: ORIGIN,
            'x-csrf-token': actor.csrfToken,
            'content-type': 'application/json',
            'known-command-id': randomUUID(),
          },
          ...(operation.method === 'GET' ? {} : { payload: {} }),
        });
        assert.equal(
          response.statusCode,
          404,
          `${operation.operationId} returned placeholder 503: ${response.body}`,
        );
      }
    } finally {
      await app.close();
    }
  });

  test('omitting account-credential composition makes bearer collection create 401', async () => {
    const wired = compose(true);
    const unwired = compose(true, { accountCredentials: false });
    try {
      const issued = await issueSameAccountChild(wired);
      const token = await productToken(wired, issued.secret);
      const allowed = await wired.inject({
        method: 'POST', url: '/api/v1/collections',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json', 'known-command-id': randomUUID(),
        },
        payload: { kind: 'bookmarks', title: 'wired bearer', summary: null },
      });
      assert.equal(allowed.statusCode, 201, allowed.body);
      const denied = await unwired.inject({
        method: 'POST', url: '/api/v1/collections',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json', 'known-command-id': randomUUID(),
        },
        payload: { kind: 'bookmarks', title: 'unwired bearer', summary: null },
      });
      assert.equal(denied.statusCode, 401, denied.body);
      const cookieStillWorks = await unwired.inject({
        method: 'POST', url: '/api/v1/collections',
        headers: {
          cookie: issued.actor.cookie, origin: ORIGIN, 'x-csrf-token': issued.actor.csrfToken,
          'content-type': 'application/json', 'known-command-id': randomUUID(),
        },
        payload: { kind: 'bookmarks', title: 'unwired cookie', summary: null },
      });
      assert.equal(cookieStillWorks.statusCode, 201, cookieStillWorks.body);
      const missingIssuer = await unwired.inject({
        method: 'POST', url: '/api/v1/auth/key-token',
        headers: { 'content-type': 'application/json' },
        payload: {
          grant_type: GRANT, credential: issued.secret, audience: 'product', scope: 'product:read product:write',
        },
      });
      assert.equal(missingIssuer.statusCode, 404, missingIssuer.body);
    } finally {
      await wired.close();
      await unwired.close();
    }
  });
});
