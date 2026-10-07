import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { afterAll, beforeAll, test } from 'vitest';
import { loadConfig, type AppConfig } from '../../support/test-config.js';
import { runMigrations, type DatabaseRuntime } from '../../../src/infrastructure/database/index.js';
import { createPostgresIdentityUnitOfWork } from '../../../src/infrastructure/identity/index.js';
import { createPostgresReadingProgressReadUnitOfWork, createPostgresReadingProgressUnitOfWork } from '../../../src/infrastructure/reading-progress/index.js';
import { createReadingProgressCursorSigner } from '../../../src/modules/reading-progress/index.js';
import { buildApiApp } from '../../../src/transport/app.js';
import { createIsolatedPostgresRuntime, describeWithPostgres, type IsolatedPostgresRuntime } from '../../support/postgres-test-runtime.js';
import { createPostgresBetterAuthTestFactory, issueTestSession } from '../../support/better-auth-test-factory.js';

const ORIGIN = 'https://app.example.test';
async function rawRequest(port: number, path: string, headers: string[], payload: string) {
  return new Promise<{ statusCode: number; body: string }>((resolve, reject) => {
    const request = httpRequest({ host: '127.0.0.1', port, path, method: 'PUT', headers }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => resolve({ statusCode: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
    });
    request.on('error', reject); request.end(payload);
  });
}
describeWithPostgres('P2B-19 real Reading Progress HTTP + PostgreSQL', () => {
  let isolated: IsolatedPostgresRuntime; let runtime: DatabaseRuntime; let config: AppConfig;
  let factory: ReturnType<typeof createPostgresBetterAuthTestFactory>;
  beforeAll(async () => { isolated = await createIsolatedPostgresRuntime('phase2b_progress_http'); runtime = isolated.runtime;
    await runMigrations(runtime.db, 'latest'); factory = createPostgresBetterAuthTestFactory({ db: runtime.db }); config = loadConfig({ DATABASE_URL: isolated.databaseUrl,
      PRODUCT_ORIGIN: ORIGIN, ALLOWED_ORIGINS: ORIGIN, OIDC_ISSUER: 'https://issuer.example/realms/known',
      OIDC_CLIENT_ID: 'known-web', OIDC_REDIRECT_URI: `${ORIGIN}/api/v1/auth/oidc/callback`,
      OIDC_AUTHORIZATION_ENDPOINT: 'https://issuer.example/realms/known/auth', OIDC_TOKEN_ENDPOINT: 'https://issuer.example/realms/known/token',
      OIDC_ALLOW_TEST_PROVIDER: 'true', OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default', NODE_ENV: 'test', LOG_LEVEL: 'silent' }); }, 120_000);
  afterAll(async () => isolated?.close());
  function app() { const identityUnitOfWork = createPostgresIdentityUnitOfWork(runtime.db, { oidcTransactionSecrets: config.oidcTransactionSecrets });
    return buildApiApp({ config, identityUnitOfWork, browserSessionAuthority: factory.authority,
      readingProgressUnitOfWork: createPostgresReadingProgressUnitOfWork(runtime.db),
      readingProgressReadUnitOfWork: createPostgresReadingProgressReadUnitOfWork(runtime.db, { cursorSigner:
        createReadingProgressCursorSigner({ current: { id: 'rp-http-v1', key: 'reading-progress-http-secret' } }) }) }); }
  async function login(subject: string) {
    const client = await issueTestSession({
      factory,
      subject,
      displayName: subject,
      handle: `rp_${randomUUID().replaceAll('-', '').slice(0, 16)}`,
    });
    return { cookie: client.cookie, csrf: client.csrfToken, id: client.accountId, subject_id: client.subjectId };
  }
  async function target(owner: string) { const id = `rp-${randomUUID().slice(0,8)}`; const root = `${id}-root`;
    const connection = await runtime.pool.connect(); try { await connection.query('begin');
      await connection.query(`insert into resource_id_ledger(resource_id,resource_type) values ($1,'collection'),($2,'node')`, [id, root]);
      await connection.query(`insert into collections(id,owner_subject_id,title,kind,visibility,root_node_id,resource_revision,content_revision,policy_revision,commit_ordinal)
        values ($1,$2,'Reading','bookmarks','private',$3,'r1','c1','p1',1)`, [id, owner, root]);
      await connection.query(`insert into nodes(id,collection_id,parent_id,kind,is_root,title,url,tags,visibility,position_token,resource_revision,children_revision)
        values ($1,$2,null,'folder',true,'Root',null,'[]','inherit',null,'r2','c2')`, [root, id]);
      await connection.query('commit');
    } catch (error) { await connection.query('rollback'); throw error; } finally { connection.release(); } return id; }

  test('create/read/update/stale/reset/replay remain account-isolated across Session rotation', async () => { const api = app(); try {
    const subjectA = `rp-a-${randomUUID()}`; const a = await login(subjectA); const b = await login(`rp-b-${randomUUID()}`); const collectionId = await target(a.subject_id);
    await runtime.pool.query(`insert into collection_members(collection_id,subject_id,role) values ($1,$2,'viewer')`, [collectionId, b.subject_id]);
    const base = { origin: ORIGIN, 'content-type': 'application/json' };
    const unauthenticated = await api.inject({ method: 'GET', url: `/api/v1/reading-progress/collection/${collectionId}` });
    assert.equal(unauthenticated.statusCode, 401);
    for (const headers of [
      { cookie: a.cookie, 'content-type': 'application/json', 'x-csrf-token': a.csrf },
      { cookie: a.cookie, origin: ORIGIN, 'content-type': 'application/json' },
      { cookie: a.cookie, origin: 'https://evil.example', 'content-type': 'application/json', 'x-csrf-token': a.csrf },
    ]) {
      const denied = await api.inject({ method: 'PUT', url: `/api/v1/reading-progress/collection/${collectionId}`,
        headers: { ...headers, 'known-command-id': randomUUID() }, payload: { status: 'in_progress', progress: .25 } });
      // Missing/mismatched Origin or CSRF token must be rejected with the stable
      // csrf_failed contract, never accepted for the private mutation.
      assert.equal(denied.statusCode, 403);
      assert.equal(denied.json().error.code, 'csrf_failed');
    }
    const wrongMedia = await api.inject({ method: 'PUT', url: `/api/v1/reading-progress/collection/${collectionId}`,
      headers: { cookie: a.cookie, origin: ORIGIN, 'content-type': 'text/plain', 'x-csrf-token': a.csrf,
        'known-command-id': randomUUID() }, payload: '{}' });
    assert.equal(wrongMedia.statusCode, 415);
    const oversized = await api.inject({ method: 'PUT', url: `/api/v1/reading-progress/collection/${collectionId}`,
      headers: { ...base, cookie: a.cookie, 'x-csrf-token': a.csrf, 'known-command-id': randomUUID() },
      payload: { status: 'in_progress', progress: .25, padding: 'x'.repeat(300) } });
    assert.equal(oversized.statusCode, 413);
    assert.equal(oversized.json().error.code, 'payload_too_large');
    const commandId = randomUUID(); const created = await api.inject({ method: 'PUT', url: `/api/v1/reading-progress/collection/${collectionId}`,
      headers: { ...base, cookie: a.cookie, 'x-csrf-token': a.csrf, 'known-command-id': commandId }, payload: { status: 'in_progress', progress: .25 } });
    assert.equal(created.statusCode, 201); assert.match(String(created.headers.etag), /^"reading-progress:/); assert.equal(created.headers['cache-control'], 'private, no-store');
    const countsBeforeReplay = await runtime.pool.query<{ progress: string; receipts: string; audits: string }>(`select
      (select count(*) from reading_progress where account_id=$1)::text progress,
      (select count(*) from product_command_receipts where principal_id=$1)::text receipts,
      (select count(*) from audit_events where principal_id=$1 and event_type='reading_progress.upserted')::text audits`, [a.id]);
    const replay = await api.inject({ method: 'PUT', url: `/api/v1/reading-progress/collection/${collectionId}`,
      headers: { ...base, cookie: a.cookie, 'x-csrf-token': a.csrf, 'known-command-id': commandId }, payload: { status: 'in_progress', progress: .25 } });
    assert.equal(replay.statusCode, created.statusCode); assert.equal(replay.body, created.body); assert.equal(replay.headers.etag, created.headers.etag);
    assert.equal(replay.headers['cache-control'], created.headers['cache-control']);
    const countsAfterReplay = await runtime.pool.query<{ progress: string; receipts: string; audits: string }>(`select
      (select count(*) from reading_progress where account_id=$1)::text progress,
      (select count(*) from product_command_receipts where principal_id=$1)::text receipts,
      (select count(*) from audit_events where principal_id=$1 and event_type='reading_progress.upserted')::text audits`, [a.id]);
    assert.deepEqual(countsAfterReplay.rows[0], countsBeforeReplay.rows[0]);
    const reused = await api.inject({ method: 'PUT', url: `/api/v1/reading-progress/collection/${collectionId}`,
      headers: { ...base, cookie: a.cookie, 'x-csrf-token': a.csrf, 'known-command-id': commandId }, payload: { status: 'in_progress', progress: .5 } });
    assert.equal(reused.statusCode, 409); assert.equal(reused.json().error.code, 'command_id_reused');
    const createOnlyConflict = await api.inject({ method: 'PUT', url: `/api/v1/reading-progress/collection/${collectionId}`,
      headers: { ...base, cookie: a.cookie, 'x-csrf-token': a.csrf, 'known-command-id': randomUUID() }, payload: { status: 'in_progress', progress: .5 } });
    assert.equal(createOnlyConflict.statusCode, 412); assert.equal(createOnlyConflict.json().error.currentEtag, created.headers.etag);
    for (const invalid of [`W/${created.headers.etag}`, '*', `${created.headers.etag}, ${created.headers.etag}`]) {
      const rejected = await api.inject({ method: 'PUT', url: `/api/v1/reading-progress/collection/${collectionId}`,
        headers: { ...base, cookie: a.cookie, 'x-csrf-token': a.csrf, 'known-command-id': randomUUID(), 'if-match': invalid },
        payload: { status: 'in_progress', progress: .5 } });
      assert.equal(rejected.statusCode, 400);
    }
    const address = await api.listen({ host: '127.0.0.1', port: 0 }); const port = Number(new URL(address).port);
    const rawBody = JSON.stringify({ status: 'in_progress', progress: .5 });
    const duplicate = await rawRequest(port, `/api/v1/reading-progress/collection/${collectionId}`, [
      'Cookie', a.cookie, 'Origin', ORIGIN, 'Content-Type', 'application/json', 'Content-Length', String(Buffer.byteLength(rawBody)),
      'X-CSRF-Token', a.csrf, 'Known-Command-Id', randomUUID(),
      'If-Match', String(created.headers.etag), 'If-Match', String(created.headers.etag),
    ], rawBody);
    assert.equal(duplicate.statusCode, 400);
    const rowCountBeforeGet = await runtime.pool.query<{ count: string }>('select count(*)::text count from reading_progress where account_id=$1', [a.id]);
    const itemA = await api.inject({ method: 'GET', url: `/api/v1/reading-progress/collection/${collectionId}`, headers: { cookie: a.cookie } });
    assert.equal(itemA.statusCode, 200); assert.equal(itemA.headers.etag, created.headers.etag);
    const rowCountAfterGet = await runtime.pool.query<{ count: string }>('select count(*)::text count from reading_progress where account_id=$1', [a.id]);
    assert.deepEqual(rowCountAfterGet.rows[0], rowCountBeforeGet.rows[0]);
    const other = await api.inject({ method: 'PUT', url: `/api/v1/reading-progress/collection/${collectionId}`,
      headers: { ...base, cookie: b.cookie, 'x-csrf-token': b.csrf, 'known-command-id': randomUUID() }, payload: { status: 'completed', progress: 1 } });
    assert.equal(other.statusCode, 201); assert.notEqual(other.headers.etag, created.headers.etag);
    await runtime.pool.query('delete from collection_members where collection_id=$1 and subject_id=$2', [collectionId, b.subject_id]);
    const revokedRead = await api.inject({ method: 'GET', url: `/api/v1/reading-progress/collection/${collectionId}`,
      headers: { cookie: b.cookie } });
    assert.equal(revokedRead.statusCode, 200); assert.deepEqual(revokedRead.json().target,
      { availability: 'unavailable', collectionId: null, title: null, url: null });
    await runtime.pool.query(`insert into collection_members(collection_id,subject_id,role) values ($1,$2,'viewer')`, [collectionId, b.subject_id]);
    const secondCollectionId = await target(a.subject_id);
    await runtime.pool.query(`insert into collection_members(collection_id,subject_id,role) values ($1,$2,'viewer')`, [secondCollectionId, b.subject_id]);
    const secondState = await api.inject({ method: 'PUT', url: `/api/v1/reading-progress/collection/${secondCollectionId}`,
      headers: { ...base, cookie: b.cookie, 'x-csrf-token': b.csrf, 'known-command-id': randomUUID() }, payload: { status: 'in_progress', progress: .5 } });
    assert.equal(secondState.statusCode, 201);
    const firstPage = await api.inject({ method: 'GET', url: '/api/v1/reading-progress?limit=1', headers: { cookie: b.cookie } });
    assert.equal(firstPage.statusCode, 200); assert.equal(firstPage.headers['cache-control'], 'private, no-store');
    assert.equal(firstPage.json().items[0].resourceId, secondCollectionId); assert.ok(firstPage.json().page.nextCursor);
    const crossAccountCursor = await api.inject({ method: 'GET', url: `/api/v1/reading-progress?cursor=${encodeURIComponent(firstPage.json().page.nextCursor)}`,
      headers: { cookie: a.cookie } });
    assert.equal(crossAccountCursor.statusCode, 400); assert.equal(crossAccountCursor.json().error.code, 'invalid_cursor');
    await runtime.pool.query('delete from collection_members where collection_id=$1 and subject_id=$2', [collectionId, b.subject_id]);
    const secondPage = await api.inject({ method: 'GET', url: `/api/v1/reading-progress?cursor=${encodeURIComponent(firstPage.json().page.nextCursor)}`,
      headers: { cookie: b.cookie } });
    assert.equal(secondPage.statusCode, 200); assert.equal(secondPage.headers['cache-control'], 'private, no-store');
    assert.equal(secondPage.json().items[0].resourceId, collectionId); assert.deepEqual(secondPage.json().items[0].target,
      { availability: 'unavailable', collectionId: null, title: null, url: null });
    await runtime.pool.query(`insert into collection_members(collection_id,subject_id,role) values ($1,$2,'viewer')`, [collectionId, b.subject_id]);
    const updated = await api.inject({ method: 'PUT', url: `/api/v1/reading-progress/collection/${collectionId}`,
      headers: { ...base, cookie: a.cookie, 'x-csrf-token': a.csrf, 'known-command-id': randomUUID(), 'if-match': String(created.headers.etag) }, payload: { status: 'completed', progress: 1 } });
    assert.equal(updated.statusCode, 200); const stale = await api.inject({ method: 'DELETE', url: `/api/v1/reading-progress/collection/${collectionId}`,
      headers: { cookie: a.cookie, origin: ORIGIN, 'x-csrf-token': a.csrf, 'known-command-id': randomUUID(), 'if-match': String(created.headers.etag) } });
    assert.equal(stale.statusCode, 412); assert.equal(stale.json().error.currentEtag, updated.headers.etag);
    const reset = await api.inject({ method: 'DELETE', url: `/api/v1/reading-progress/collection/${collectionId}`,
      headers: { cookie: a.cookie, origin: ORIGIN, 'x-csrf-token': a.csrf, 'known-command-id': randomUUID(), 'if-match': String(updated.headers.etag) } });
    assert.equal(reset.statusCode, 204); const absent = await api.inject({ method: 'GET', url: `/api/v1/reading-progress/collection/${collectionId}`, headers: { cookie: a.cookie } });
    assert.equal(absent.statusCode, 404); const bItem = await api.inject({ method: 'GET', url: `/api/v1/reading-progress/collection/${collectionId}`, headers: { cookie: b.cookie } });
    assert.equal(bItem.statusCode, 200); assert.equal(bItem.json().status, 'completed');
    const rotated = await login(subjectA); const rotatedList = await api.inject({ method: 'GET', url: '/api/v1/reading-progress?status=completed', headers: { cookie: rotated.cookie } });
    assert.equal(rotatedList.statusCode, 200); assert.deepEqual(rotatedList.json().items, []);
  } finally { await api.close(); } });

  test('list and item reject the full invalid query/path matrix with stable 400 contracts', async () => {
    const api = app(); try {
      const client = await login(`rp-reject-${randomUUID()}`);
      const rowsBefore = await runtime.pool.query<{ count: string }>('select count(*)::text count from reading_progress where account_id=$1', [client.id]);
      for (const [query, code] of [
        ['status=bogus', 'invalid_query'],
        ['status=', 'invalid_query'],
        ['limit=0', 'invalid_query'],
        ['limit=01', 'invalid_query'],
        ['limit=101', 'invalid_query'],
        ['limit=1.5', 'invalid_query'],
        ['limit=', 'invalid_query'],
        ['cursor=', 'invalid_query'],
        [`cursor=${'x'.repeat(2049)}`, 'invalid_query'],
        ['cursor=%20', 'invalid_cursor'],
        ['cursor=x&limit=1', 'invalid_query'],
        ['status=completed&status=in_progress', 'invalid_query'],
        ['status=completed&status=completed', 'invalid_query'],
        ['bogus=1', 'invalid_query'],
        ['status=completed&bogus=1', 'invalid_query'],
      ] as const) {
        const response = await api.inject({ method: 'GET', url: `/api/v1/reading-progress?${query}`, headers: { cookie: client.cookie } });
        assert.equal(response.statusCode, 400, query); assert.equal(response.json().error.code, code, query);
        assert.equal(response.headers['cache-control'], 'private, no-store', query);
      }
      for (const path of ['/api/v1/reading-progress/book/b1', '/api/v1/reading-progress/collection/%20%20',
        '/api/v1/reading-progress/node/%20x%20', '/api/v1/reading-progress/collection/x%20']) {
        const response = await api.inject({ method: 'GET', url: path, headers: { cookie: client.cookie } });
        assert.equal(response.statusCode, 400, path); assert.equal(response.json().error.code, 'invalid_query', path);
        assert.equal(response.headers['cache-control'], 'private, no-store', path);
      }
      const rowsAfter = await runtime.pool.query<{ count: string }>('select count(*)::text count from reading_progress where account_id=$1', [client.id]);
      assert.deepEqual(rowsAfter.rows[0], rowsBefore.rows[0]);
    } finally { await api.close(); } });
});
