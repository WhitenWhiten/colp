import { insertTestParentCredential } from '../../support/account-credential-db-fixture.js';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, test } from 'vitest';
import { loadConfig } from '../../support/test-config.js';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import { createPostgresIdentityUnitOfWork } from '../../../src/infrastructure/identity/index.js';
import { createPostgresAccountCredentialUnitOfWork } from '../../../src/infrastructure/auth/account-credentials-postgres.js';
import { createAccountCredentialCursorCodec } from '../../../src/modules/auth/index.js';
import { buildApiApp } from '../../../src/transport/app.js';
import { issueTestSession } from '../../support/product-http-harness.js';
import { createPostgresBetterAuthTestFactory } from '../../support/better-auth-test-factory.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';

const SECRET = /^kn_[pc]_[A-Za-z0-9_-]{22}_[A-Za-z0-9_-]{43}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const OPAQUE = /^[A-Za-z0-9._~-]{1,128}$/;
const REVISION = /^[1-9][0-9]{0,18}$/;
const CURSOR = /^[A-Za-z0-9_-]+$/;
const HMAC_KEY = Buffer.alloc(32, 13).toString('base64url');
const FUTURE = '2026-12-01T00:00:00.000Z';

function es256Jwk(): string {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = privateKey.export({ format: 'jwk' }) as Record<string, string>;
  return JSON.stringify({ ...jwk, kid: 'ac01-test', kty: 'EC', crv: 'P-256' });
}

function assertCredential(value: unknown): asserts value is {
  id: string; kind: 'parent' | 'child'; parentId: string | null; accountId: string; subjectId: string;
  label: string; prefix: string; state: 'active' | 'revoked' | 'expired'; revision: string;
  expiresAt: string; createdAt: string; lastUsedAt: string | null;
} {
  assert.equal(value && typeof value === 'object' && !Array.isArray(value), true);
  const record = value as Record<string, unknown>;
  assert.deepEqual(Object.keys(record).sort(), [
    'accountId', 'createdAt', 'expiresAt', 'id', 'kind', 'label', 'lastUsedAt',
    'parentId', 'prefix', 'revision', 'state', 'subjectId',
  ]);
  assert.match(String(record.id), OPAQUE);
  assert.ok(record.kind === 'parent' || record.kind === 'child');
  assert.ok(record.parentId === null || (typeof record.parentId === 'string' && OPAQUE.test(record.parentId)));
  assert.match(String(record.accountId), OPAQUE);
  assert.match(String(record.subjectId), OPAQUE);
  assert.equal(typeof record.label, 'string');
  assert.ok(String(record.label).length >= 1 && String(record.label).length <= 80);
  assert.equal(typeof record.prefix, 'string');
  assert.ok(String(record.prefix).length >= 1 && String(record.prefix).length <= 32);
  assert.ok(record.state === 'active' || record.state === 'revoked' || record.state === 'expired');
  assert.match(String(record.revision), REVISION);
  assert.match(String(record.expiresAt), TIMESTAMP);
  assert.match(String(record.createdAt), TIMESTAMP);
  assert.ok(record.lastUsedAt === null || (typeof record.lastUsedAt === 'string' && TIMESTAMP.test(record.lastUsedAt)));
}

function assertIssued(value: unknown, expectSecret: boolean): asserts value is {
  credential: unknown; secret: string | null; secretAvailable: boolean;
} {
  assert.equal(value && typeof value === 'object' && !Array.isArray(value), true);
  const record = value as Record<string, unknown>;
  assert.deepEqual(Object.keys(record).sort(), ['credential', 'secret', 'secretAvailable']);
  assertCredential(record.credential);
  assert.equal(typeof record.secretAvailable, 'boolean');
  if (expectSecret) {
    assert.equal(record.secretAvailable, true);
    assert.equal(typeof record.secret, 'string');
    assert.equal(String(record.secret).length, 71);
    assert.match(String(record.secret), SECRET);
  } else {
    assert.equal(record.secretAvailable, false);
    assert.equal(record.secret, null);
  }
}

describeWithPostgres('account-credential lifecycle', () => {
  let isolated: IsolatedPostgresRuntime;
  let config: ReturnType<typeof loadConfig>;
  let identity: ReturnType<typeof createPostgresIdentityUnitOfWork>;
  let factory: ReturnType<typeof createPostgresBetterAuthTestFactory>;
  let cursors: ReturnType<typeof createAccountCredentialCursorCodec>;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('ac01_account_credentials', {
      maxConnections: 10,
      applicationName: 'known-ac01-credentials-test',
    });
    await runMigrations(isolated.runtime.db, 'latest');
    config = loadConfig({
      ...process.env,
      DATABASE_URL: isolated.databaseUrl,
      NODE_ENV: 'test',
      OIDC_ALLOW_TEST_PROVIDER: 'true',
      OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default',
      PRODUCT_ORIGIN: 'http://127.0.0.1:3000',
      LOG_LEVEL: 'silent',
      KNOWN_FEATURE_ACCOUNT_CREDENTIALS: 'true',
      AUTOMATION_CURSOR_HMAC_KEY: HMAC_KEY,
      AUTOMATION_ES256_PRIVATE_JWK: es256Jwk(),
    });
    identity = createPostgresIdentityUnitOfWork(isolated.runtime.db, {
      oidcTransactionSecrets: config.oidcTransactionSecrets,
    });
    factory = createPostgresBetterAuthTestFactory({ db: isolated.runtime.db });
    cursors = createAccountCredentialCursorCodec(HMAC_KEY);
  }, 120_000);

  afterAll(async () => {
    cursors?.destroy();
    await isolated?.close();
  });

  function app() {
    return buildApiApp({
      config,
      identityUnitOfWork: identity,
      browserSessionAuthority: factory.authority,
      accountCredentialUnitOfWork: createPostgresAccountCredentialUnitOfWork(isolated.runtime.db, undefined, undefined,
        { secretHmacKey: HMAC_KEY }),
      accountCredentialCursors: cursors,
    });
  }

  async function session() {
    return issueTestSession({
      factory,
      subject: `ac01-${randomUUID()}`,
      handle: `h${randomUUID().replaceAll('-', '').slice(0, 12)}`,
    });
  }

  function headers(actor: Awaited<ReturnType<typeof session>>, extra: Record<string, string> = {}) {
    return {
      cookie: actor.cookie,
      origin: config.productOrigin,
      'x-csrf-token': actor.csrfToken,
      'content-type': 'application/json',
      ...extra,
    };
  }

  test('browser management is removed and bot routes conceal invalid credentials before parsing', async () => {
    const actor = await session();
    const server = app();
    const parent = await insertTestParentCredential(isolated.runtime.db, actor, HMAC_KEY, FUTURE);
    try {
      for (const path of ['/api/v1/me/credential-parents', '/api/v1/me/credentials',
        `/api/v1/me/credentials/${parent.id}`, `/api/v1/me/credentials/${parent.id}/rotate`,
        `/api/v1/me/credentials/${parent.id}/revoke`, `/api/v1/me/credential-parents/${parent.id}/children`]) {
        for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const) {
          for (const auth of [{}, { cookie: actor.cookie }, { authorization: `Bearer ${parent.secret}` }]) {
            const result = await server.inject({ method, url: `${path}?limit=x&limit=y`, headers: auth });
            assert.equal(result.statusCode, 404, `${method} ${path}: ${result.body}`);
          }
        }
      }
      for (const path of ['/api/v1/auth/credential-children', '/api/v1/auth/credential-children/missing/rotate',
        '/api/v1/auth/credential-children/missing/revoke', '/api/v1/me/credential-grants',
        '/api/v1/me/credential-grants/missing/authorize-plan']) {
        for (const auth of [{}, { cookie: actor.cookie }, { authorization: 'Bearer wrong' }]) {
          const result = await server.inject({ method: 'POST', url: `${path}?bad=x&bad=y`,
            headers: { ...auth, 'content-type': 'application/json' }, payload: '{' });
          assert.equal(result.statusCode, 404, `${path}: ${result.body}`);
        }
      }
      for (const url of ['/api/v1/auth/credential-children', '/api/v1/me/credential-grants', '/api/v1/auth/key-token']) {
        const probe = await server.inject({ method: 'OPTIONS', url: `${url}?bad=1&bad=2` });
        assert.equal(probe.statusCode, 404, probe.body);
      }
      await isolated.runtime.db.updateTable('account_credentials').set({ state: 'revoked', revoked_at: new Date(), revoke_reason: 'test' }).where('id', '=', parent.id).execute();
      let result = await server.inject({ method: 'GET', url: '/api/v1/auth/credential-children', headers: { authorization: `Bearer ${parent.secret}` } });
      assert.equal(result.statusCode, 404);
      await isolated.runtime.db.updateTable('account_credentials').set({ state: 'active', revoked_at: null, revoke_reason: null, expires_at: new Date(0) }).where('id', '=', parent.id).execute();
      result = await server.inject({ method: 'GET', url: '/api/v1/auth/credential-children', headers: { authorization: `Bearer ${parent.secret}` } });
      assert.equal(result.statusCode, 404);
      await isolated.runtime.db.deleteFrom('account_credentials').where('id', '=', parent.id).execute();
      result = await server.inject({ method: 'GET', url: '/api/v1/auth/credential-children', headers: { authorization: `Bearer ${parent.secret}` } });
      assert.equal(result.statusCode, 404);
    } finally { await server.close(); }
  });

  test('parent-key child lifecycle authenticates the raw parent secret and rejects cookies', async () => {
    const actor = await session();
    const server = app();
    try {
      const parent = await insertTestParentCredential(isolated.runtime.db, actor, HMAC_KEY, FUTURE);
      const commandId = randomUUID();
      const issued = await server.inject({
        method: 'POST', url: '/api/v1/auth/credential-children',
        headers: { authorization: `Bearer ${parent.secret}`, 'content-type': 'application/json', 'known-command-id': commandId },
        payload: { label: 'worker', expiresAt: FUTURE, account: { mode: 'existing', accountId: actor.accountId } },
      });
      assert.equal(issued.statusCode, 201);
      assertIssued(issued.json(), true);
      assert.equal(issued.json().credential.accountId, actor.accountId);
      const issueReplay = await server.inject({
        method: 'POST', url: '/api/v1/auth/credential-children',
        headers: { authorization: `Bearer ${parent.secret}`, 'content-type': 'application/json', 'known-command-id': commandId },
        payload: { label: 'worker', expiresAt: FUTURE, account: { mode: 'existing', accountId: actor.accountId } },
      });
      assert.equal(issueReplay.statusCode, 201);
      assertIssued(issueReplay.json(), false);
      const issueReused = await server.inject({
        method: 'POST', url: '/api/v1/auth/credential-children',
        headers: { authorization: `Bearer ${parent.secret}`, 'content-type': 'application/json', 'known-command-id': commandId },
        payload: { label: 'other', expiresAt: FUTURE, account: { mode: 'existing', accountId: actor.accountId } },
      });
      assert.equal(issueReused.statusCode, 409);
      const cookieRejected = await server.inject({
        method: 'POST', url: '/api/v1/auth/credential-children',
        headers: headers(actor, { authorization: `Bearer ${parent.secret}`, 'known-command-id': randomUUID() }),
        payload: { label: 'worker', expiresAt: FUTURE, account: { mode: 'new' } },
      });
      assert.equal(cookieRejected.statusCode, 404);
      const listed = await server.inject({
        method: 'GET', url: '/api/v1/auth/credential-children',
        headers: { authorization: `Bearer ${parent.secret}` },
      });
      assert.equal(listed.statusCode, 200);
      assert.deepEqual(Object.keys(listed.json()).sort(), ['items', 'nextCursor']);
      assert.ok(listed.json().nextCursor === null || CURSOR.test(listed.json().nextCursor));
      assertCredential(listed.json().items[0]);
      const cookieList = await server.inject({
        method: 'GET', url: '/api/v1/auth/credential-children',
        headers: { cookie: actor.cookie, authorization: `Bearer ${parent.secret}` },
      });
      assert.equal(cookieList.statusCode, 404);
      const illegalState = await server.inject({
        method: 'GET', url: '/api/v1/auth/credential-children?state=pending',
        headers: { authorization: `Bearer ${parent.secret}` },
      });
      assert.equal(illegalState.statusCode, 400);
      const got = await server.inject({
        method: 'GET', url: `/api/v1/auth/credential-children/${issued.json().credential.id}`,
        headers: { authorization: `Bearer ${parent.secret}` },
      });
      assert.equal(got.statusCode, 200);
      assertCredential(got.json());
      const foreignChild = await server.inject({
        method: 'GET', url: `/api/v1/auth/credential-children/${parent.id}`,
        headers: { authorization: `Bearer ${parent.secret}` },
      });
      assert.equal(foreignChild.statusCode, 404);
      const missingChildMatch = await server.inject({
        method: 'POST', url: `/api/v1/auth/credential-children/${issued.json().credential.id}/rotate`,
        headers: {
          authorization: `Bearer ${parent.secret}`,
          'content-type': 'application/json',
          'known-command-id': randomUUID(),
        },
        payload: { expiresAt: FUTURE },
      });
      assert.equal(missingChildMatch.statusCode, 428);
      const rotateId = randomUUID();
      const rotate = await server.inject({
        method: 'POST', url: `/api/v1/auth/credential-children/${issued.json().credential.id}/rotate`,
        headers: {
          authorization: `Bearer ${parent.secret}`,
          'content-type': 'application/json',
          'known-command-id': rotateId,
          'if-match': String(got.headers.etag),
        },
        payload: { expiresAt: FUTURE },
      });
      assert.equal(rotate.statusCode, 200);
      assertIssued(rotate.json(), true);
      const rotateReplay = await server.inject({
        method: 'POST', url: `/api/v1/auth/credential-children/${issued.json().credential.id}/rotate`,
        headers: {
          authorization: `Bearer ${parent.secret}`,
          'content-type': 'application/json',
          'known-command-id': rotateId,
          'if-match': String(got.headers.etag),
        },
        payload: { expiresAt: FUTURE },
      });
      assert.equal(rotateReplay.statusCode, 200);
      assertIssued(rotateReplay.json(), false);
      const current = await server.inject({
        method: 'GET', url: `/api/v1/auth/credential-children/${issued.json().credential.id}`,
        headers: { authorization: `Bearer ${parent.secret}` },
      });
      const revokeId = randomUUID();
      const revoked = await server.inject({
        method: 'POST', url: `/api/v1/auth/credential-children/${issued.json().credential.id}/revoke`,
        headers: {
          authorization: `Bearer ${parent.secret}`,
          'content-type': 'application/json',
          'known-command-id': revokeId,
          'if-match': String(current.headers.etag),
        },
        payload: { reason: 'done' },
      });
      assert.equal(revoked.statusCode, 200);
      assert.equal(revoked.json().state, 'revoked');
      const revokeReplay = await server.inject({
        method: 'POST', url: `/api/v1/auth/credential-children/${issued.json().credential.id}/revoke`,
        headers: {
          authorization: `Bearer ${parent.secret}`,
          'content-type': 'application/json',
          'known-command-id': revokeId,
          'if-match': String(current.headers.etag),
        },
        payload: { reason: 'done' },
      });
      assert.equal(revokeReplay.statusCode, 200);
      assert.equal(revokeReplay.json().state, 'revoked');
      const missing = await server.inject({
        method: 'GET', url: '/api/v1/auth/credential-children',
      });
      assert.equal(missing.statusCode, 404);
    } finally { await server.close(); }
  });

  test('parent-key routes 404 after the manager account is deleted', async () => {
    const actor = await session();
    const server = app();
    try {
      const parent = await insertTestParentCredential(isolated.runtime.db, actor, HMAC_KEY, FUTURE);
      const listed = await server.inject({
        method: 'GET', url: '/api/v1/auth/credential-children',
        headers: { authorization: `Bearer ${parent.secret}` },
      });
      assert.equal(listed.statusCode, 200);
      await identity.execute((ports) => ports.accounts.markDeleted(actor.accountId, new Date()));
      const afterDelete = await server.inject({
        method: 'GET', url: '/api/v1/auth/credential-children',
        headers: { authorization: `Bearer ${parent.secret}` },
      });
      assert.equal(afterDelete.statusCode, 404);
      const issueAfterDelete = await server.inject({
        method: 'POST', url: '/api/v1/auth/credential-children',
        headers: {
          authorization: `Bearer ${parent.secret}`,
          'content-type': 'application/json',
          'known-command-id': randomUUID(),
        },
        payload: { label: 'worker', expiresAt: FUTURE, account: { mode: 'new' } },
      });
      assert.equal(issueAfterDelete.statusCode, 404);
    } finally { await server.close(); }
  });

  test('feature-off credential routes 404 and create no rows', async () => {
    const offConfig = loadConfig({
      ...process.env,
      DATABASE_URL: isolated.databaseUrl,
      NODE_ENV: 'test',
      OIDC_ALLOW_TEST_PROVIDER: 'true',
      OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default',
      PRODUCT_ORIGIN: 'http://127.0.0.1:3000',
      LOG_LEVEL: 'silent',
      KNOWN_FEATURE_ACCOUNT_CREDENTIALS: 'false',
    });
    const actor = await session();
    const server = buildApiApp({
      config: offConfig,
      identityUnitOfWork: identity,
      browserSessionAuthority: factory.authority,
      accountCredentialUnitOfWork: createPostgresAccountCredentialUnitOfWork(isolated.runtime.db, undefined, undefined,
        { secretHmacKey: HMAC_KEY }),
      accountCredentialCursors: null,
    });
    try {
      const before = await isolated.runtime.pool.query<{ count: string }>('select count(*)::text count from account_credentials');
      const created = await server.inject({
        method: 'POST', url: '/api/v1/me/credential-parents',
        headers: headers(actor, { 'known-command-id': randomUUID() }),
        payload: { label: 'off', expiresAt: FUTURE },
      });
      assert.equal(created.statusCode, 404);
      const listed = await server.inject({
        method: 'GET', url: '/api/v1/me/credentials',
        headers: { cookie: actor.cookie },
      });
      assert.equal(listed.statusCode, 404);
      const parentKey = await server.inject({
        method: 'GET', url: '/api/v1/auth/credential-children',
        headers: { authorization: 'Bearer kn_p_aaaaaaaaaaaaaaaaaaaaaa_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' },
      });
      assert.equal(parentKey.statusCode, 404);
      const after = await isolated.runtime.pool.query<{ count: string }>('select count(*)::text count from account_credentials');
      assert.equal(after.rows[0]?.count, before.rows[0]?.count);
    } finally { await server.close(); }
  });
});
