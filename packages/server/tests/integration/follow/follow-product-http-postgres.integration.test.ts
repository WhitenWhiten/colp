import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { connect } from 'node:net';
import { afterAll, beforeAll, test } from 'vitest';
import { createProductFollowClient } from '../../../generated/openapi/product-v1.client.js';
import { createDatabaseRuntime, runMigrations, type DatabaseRuntime } from '../../../src/infrastructure/database/index.js';
import { createPostgresIdentityUnitOfWork } from '../../../src/infrastructure/identity/index.js';
import { createPostgresFollowCommandUnitOfWork, createPostgresFollowQueryUnitOfWork } from '../../../src/infrastructure/social/index.js';
import { createFollowCursorKeyring } from '../../../src/modules/social/index.js';
import { buildApiApp } from '../../../src/transport/app.js';
import { createFixedWindowRateLimiter } from '../../../src/transport/http-security.js';
import { loadConfig } from '../../support/test-config.js';
import { issueTestSession } from '../../support/product-http-harness.js';
import { createPostgresBetterAuthTestFactory } from '../../support/better-auth-test-factory.js';

let runtime: DatabaseRuntime;
const databaseUrl = process.env.DATABASE_URL!;
const config = loadConfig({ ...process.env, DATABASE_URL: databaseUrl, NODE_ENV: 'test',
  OIDC_ALLOW_TEST_PROVIDER: 'true', OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default',
  PRODUCT_ORIGIN: 'http://127.0.0.1:3000', KNOWN_FEATURE_FOLLOW: 'true',
  FOLLOW_CURSOR_ACTIVE_KEY_ID: 'test-v1', FOLLOW_CURSOR_ACTIVE_SECRET: Buffer.alloc(32, 9).toString('base64') });

beforeAll(async () => { runtime = createDatabaseRuntime(databaseUrl); await runMigrations(runtime.db, 'latest'); });
afterAll(async () => runtime?.close());

test('generated Follow client crosses production Fastify composition and real PostgreSQL exactly once', async () => {
  const identity = createPostgresIdentityUnitOfWork(runtime.db, { oidcTransactionSecrets: config.oidcTransactionSecrets });
  const factory = createPostgresBetterAuthTestFactory({ db: runtime.db });
  const actor = await issueTestSession({ factory,
    subject: `follow-http-actor-${randomUUID()}`, handle: `a${randomUUID().replaceAll('-', '').slice(0, 12)}` });
  const target = await issueTestSession({ factory,
    subject: `follow-http-target-${randomUUID()}`, handle: `t${randomUUID().replaceAll('-', '').slice(0, 12)}` });
  const other = await issueTestSession({ factory,
    subject: `follow-http-other-${randomUUID()}`, handle: `o${randomUUID().replaceAll('-', '').slice(0, 12)}` });
  for (const profileId of [actor.accountId, target.accountId, other.accountId]) {
    assert.match(profileId, /^[A-Za-z0-9_-]{21}[AQgw]$/u);
  }
  const cursors = createFollowCursorKeyring(config.follow!.cursorKeys);
  const app = buildApiApp({ config, identityUnitOfWork: identity, browserSessionAuthority: factory.authority,
    followCommandUnitOfWork: createPostgresFollowCommandUnitOfWork(runtime.db),
    followQueryUnitOfWork: createPostgresFollowQueryUnitOfWork(runtime.db, cursors) });
  const origin = await app.listen({ host: '127.0.0.1', port: 0 });
  try {
    for (const duplicateName of ['Cookie', 'Origin', 'X-CSRF-Token', 'Content-Type', 'Known-Command-Id']) {
      const headers = [`Cookie: ${actor.cookie}`, `Origin: ${config.productOrigin}`,
        `X-CSRF-Token: ${actor.csrfToken}`, 'Content-Type: application/json',
        `Known-Command-Id: ${randomUUID()}`];
      const original = headers.find((header) => header.startsWith(`${duplicateName}:`))!;
      const raw = await rawHttp(origin, [`PUT /api/v1/profiles/${target.accountId}/follow HTTP/1.1`,
        `Host: ${new URL(origin).host}`, 'Connection: close', ...headers, original, '', ''].join('\r\n'));
      assert.match(raw, /^HTTP\/1\.1 400 /u, duplicateName);
      assert.match(raw, /"code":"invalid_request"/u, duplicateName);
    }
    const client = createProductFollowClient({ origin, sessionCookie: actor.cookie,
      originHeader: config.productOrigin, csrfToken: actor.csrfToken });
    const commandId = randomUUID();
    const first = await client.follow(target.accountId, commandId);
    const replay = await client.follow(target.accountId, commandId);
    assert.deepEqual(replay, first);
    await assert.rejects(() => client.follow(other.accountId, commandId), (error: unknown) =>
      isProductClientError(error, 409, 'command_id_reused'));
    const exact = await runtime.pool.query<{ follows: string; receipts: string; audits: string; outbox: string }>(`
      select
        (select count(*)::text from follows where actor_profile_id=$1 and target_profile_id=$2) follows,
        (select count(*)::text from product_command_receipts where principal_id=$1 and command_id=$3) receipts,
        (select count(*)::text from audit_events where principal_id=$1 and event_type='social.follow_created') audits,
        (select count(*)::text from outbox_events where aggregate_id=$1 and aggregate_scope=$2
          and event_type='social.follow-created') outbox`, [actor.accountId, target.accountId, commandId]);
    assert.deepEqual(exact.rows[0], { follows: '1', receipts: '1', audits: '1', outbox: '2' });
    assert.deepEqual((await client.following(actor.accountId)).items.map((item) => item.profileId), [target.accountId]);
    assert.deepEqual((await client.followers(target.accountId)).items.map((item) => item.profileId), [actor.accountId]);
    await assert.rejects(() => client.followers(target.accountId, { cursor: 'tampered-private-cursor' }),
      (error: unknown) => isProductClientError(error, 400, 'invalid_cursor'));
    await client.unfollow(target.accountId, randomUUID());
    assert.deepEqual((await client.following(actor.accountId)).items, []);
    const rows = await runtime.pool.query<{ count: string }>(`select count(*)::text count from follows
      where actor_profile_id=$1 and target_profile_id=$2`, [actor.accountId, target.accountId]);
    assert.equal(rows.rows[0]?.count, '0');
  } finally { await app.close(); cursors.destroy(); }
});

test('real PostgreSQL Follow HTTP applies 429, timeout cancellation and client-abort cancellation', async () => {
  const identity = createPostgresIdentityUnitOfWork(runtime.db, { oidcTransactionSecrets: config.oidcTransactionSecrets });
  const factory = createPostgresBetterAuthTestFactory({ db: runtime.db });
  const actor = await issueTestSession({ factory,
    subject: `follow-http-budget-${randomUUID()}`, handle: `b${randomUUID().replaceAll('-', '').slice(0, 12)}`,
    accountId: 'RkZGRkZGRkZGRkZGRkZGRg' });
  const target = await issueTestSession({ factory,
    subject: `follow-http-budget-target-${randomUUID()}`, handle: `c${randomUUID().replaceAll('-', '').slice(0, 12)}`,
    accountId: 'VVVVVVVVVVVVVVVVVVVVVQ' });
  const cursors = createFollowCursorKeyring(config.follow!.cursorKeys);
  const queryUnitOfWork = createPostgresFollowQueryUnitOfWork(runtime.db, cursors);
  const commandUnitOfWork = createPostgresFollowCommandUnitOfWork(runtime.db);
  const limited = buildApiApp({ config, identityUnitOfWork: identity, browserSessionAuthority: factory.authority,
    followCommandUnitOfWork: commandUnitOfWork, followQueryUnitOfWork: queryUnitOfWork,
    followRateLimiter: createFixedWindowRateLimiter({ maxRequests: 1, windowMs: 60_000 }) });
  try {
    assert.equal((await limited.inject({ method: 'GET', url: `/api/v1/profiles/${actor.accountId}/followers`,
      headers: { cookie: actor.cookie } })).statusCode, 200);
    const rate = await limited.inject({ method: 'GET', url: `/api/v1/profiles/${actor.accountId}/followers`,
      headers: { cookie: actor.cookie } });
    assert.equal(rate.statusCode, 429); assert.equal(rate.json().error.code, 'rate_limited');
  } finally { await limited.close(); }

  const blocker = await runtime.pool.connect(); await blocker.query('begin');
  await blocker.query('lock table follows in access exclusive mode');
  const timeoutConfig = { ...config, follow: { ...config.follow!, enabled: true, timeoutMs: 50 } };
  const timed = buildApiApp({ config: timeoutConfig, identityUnitOfWork: identity, browserSessionAuthority: factory.authority,
    followCommandUnitOfWork: commandUnitOfWork, followQueryUnitOfWork: queryUnitOfWork });
  try {
    const commandId = randomUUID(); const startedAt = Date.now();
    const response = await timed.inject({ method: 'PUT', url: `/api/v1/profiles/${target.accountId}/follow`,
      headers: { cookie: actor.cookie, origin: config.productOrigin, 'x-csrf-token': actor.csrfToken,
        'known-command-id': commandId } });
    assert.equal(response.statusCode, 503); assert.equal(response.json().error.code, 'feature_temporarily_unavailable');
    assert.ok(Date.now() - startedAt < 1_000);
    await waitUntil(async () => Number((await runtime.pool.query<{ count: string }>(`select count(*)::text count
      from pg_stat_activity where pid <> pg_backend_pid()
        and query like '%insert into "follows"%' and state='active'`)).rows[0]?.count ?? 1) === 0);
    await blocker.query('rollback');
    await assertNoMutationEffects(actor.accountId, target.accountId, commandId);
  } finally { await timed.close(); }

  await blocker.query('begin'); await blocker.query('lock table follows in access exclusive mode');
  const abortConfig = { ...config, follow: { ...config.follow!, enabled: true, timeoutMs: 5_000 } };
  const aborting = buildApiApp({ config: abortConfig, identityUnitOfWork: identity, browserSessionAuthority: factory.authority,
    followCommandUnitOfWork: commandUnitOfWork, followQueryUnitOfWork: queryUnitOfWork });
  const address = await aborting.listen({ host: '127.0.0.1', port: 0 });
  try {
    const commandId = randomUUID();
    const url = new URL(address); const request = httpRequest({ host: url.hostname, port: Number(url.port),
      method: 'PUT', path: `/api/v1/profiles/${target.accountId}/follow`, headers: { Cookie: actor.cookie,
        Origin: config.productOrigin, 'X-CSRF-Token': actor.csrfToken, 'Known-Command-Id': commandId } });
    request.on('error', () => undefined); request.end();
    await waitUntil(async () => Number((await runtime.pool.query<{ count: string }>(`select count(*)::text count
      from pg_stat_activity where pid <> pg_backend_pid()
        and query like '%insert into "follows"%' and wait_event_type='Lock'`)).rows[0]?.count ?? 0) > 0);
    request.destroy();
    await waitUntil(async () => Number((await runtime.pool.query<{ count: string }>(`select count(*)::text count
      from pg_stat_activity where pid <> pg_backend_pid()
        and query like '%insert into "follows"%' and state='active'`)).rows[0]?.count ?? 1) === 0);
    await blocker.query('rollback');
    await assertNoMutationEffects(actor.accountId, target.accountId, commandId);
  } finally {
    blocker.release(); await aborting.close(); cursors.destroy();
  }
});

async function assertNoMutationEffects(actorId: string, targetId: string, commandId: string): Promise<void> {
  const result = await runtime.pool.query<{ follows: string; receipts: string; audits: string; outbox: string }>(`
    select
      (select count(*)::text from follows where actor_profile_id=$1 and target_profile_id=$2) follows,
      (select count(*)::text from product_command_receipts where principal_id=$1 and command_id=$3) receipts,
      (select count(*)::text from audit_events where principal_id=$1 and event_type='social.follow_created') audits,
      (select count(*)::text from outbox_events where aggregate_id=$1 and aggregate_scope=$2
        and event_type='social.follow-created') outbox`, [actorId, targetId, commandId]);
  assert.deepEqual(result.rows[0], { follows: '0', receipts: '0', audits: '0', outbox: '0' });
}

async function waitUntil(predicate: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) { if (await predicate()) return; await new Promise<void>((resolve) => setImmediate(resolve)); }
  throw new Error('Follow PostgreSQL cancellation did not complete within budget');
}

async function rawHttp(origin: string, request: string): Promise<string> {
  const url = new URL(origin);
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const socket = connect({ host: url.hostname, port: Number(url.port) });
    socket.once('connect', () => socket.write(request));
    socket.on('data', (chunk: Buffer) => chunks.push(chunk));
    socket.once('error', reject);
    socket.once('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

function isProductClientError(error: unknown, status: number, code: string): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const value = error as { status?: unknown; problem?: { error?: { code?: unknown } } };
  return value.status === status && value.problem?.error?.code === code;
}
