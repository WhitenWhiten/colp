import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { connect as connectSocket } from 'node:net';
import { afterAll, beforeAll, test } from 'vitest';
import type { operations } from '../../../generated/openapi/product-v1.js';
import { loadConfig, type AppConfig } from '../../support/test-config.js';
import { createPostgresSharedExposureFactsPort, createDatabaseRuntime, runMigrations, type DatabaseRuntime } from '../../../src/infrastructure/database/index.js';
import { createPostgresIdentityUnitOfWork } from '../../../src/infrastructure/identity/index.js';
import { createPostgresSearchAuthorityPort, createPostgresSearchCandidatePort } from '../../../src/infrastructure/search/index.js';
import { createSearchCursorSigner, createSearchFirstPageCache, executeSearchQuery } from '../../../src/modules/search/index.js';
import { buildApiApp } from '../../../src/transport/app.js';
import { createMemorySearchRateLimiter } from '../../../src/transport/http-security.js';
import { createPostgresBetterAuthTestFactory, issueTestSession } from '../../support/better-auth-test-factory.js';
import { createIsolatedPostgresRuntime, describeWithPostgres, type IsolatedPostgresRuntime } from '../../support/postgres-test-runtime.js';

describeWithPostgres('P2B-24 real Search Product HTTP + PostgreSQL', () => {
  let isolated: IsolatedPostgresRuntime;
  let runtime: DatabaseRuntime;
  let config: AppConfig;
  let factory: ReturnType<typeof createPostgresBetterAuthTestFactory>;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('phase2b_search_http', {
      maxConnections: 4, applicationName: 'known-search-product-http',
    });
    runtime = isolated.runtime;
    await runMigrations(runtime.db, 'latest');
    factory = createPostgresBetterAuthTestFactory({ db: runtime.db });
    config = loadConfig({ DATABASE_URL: isolated.databaseUrl, PRODUCT_ORIGIN: 'https://app.example.test',
      ALLOWED_ORIGINS: 'https://app.example.test', OIDC_ISSUER: 'https://issuer.example.test',
      OIDC_CLIENT_ID: 'known-web', OIDC_REDIRECT_URI: 'https://app.example.test/api/v1/auth/oidc/callback',
      OIDC_AUTHORIZATION_ENDPOINT: 'https://issuer.example.test/authorize',
      OIDC_TOKEN_ENDPOINT: 'https://issuer.example.test/token', OIDC_ALLOW_TEST_PROVIDER: 'true',
      OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default',
      NODE_ENV: 'test', LOG_LEVEL: 'silent' });
    await seedSearchCorpus(runtime);
  }, 120_000);

  afterAll(async () => isolated?.close());

  function productionQuery() {
    const ports = { candidates: createPostgresSearchCandidatePort(runtime.db),
      authority: createPostgresSearchAuthorityPort(runtime.db),
      cursors: createSearchCursorSigner({ current: { id: 'search-http-v1', key: 'search-http-cursor-secret-material' } }),
      clock: { now: () => new Date() },
      sharedExposure: createPostgresSharedExposureFactsPort(runtime),
      firstPageCache: createSearchFirstPageCache() };
    return { execute: (input: Parameters<typeof executeSearchQuery>[1]) => executeSearchQuery(ports, input) };
  }

  const generousSearchLimiter = () => createMemorySearchRateLimiter({
    anonymousMaxRequests: 10_000, accountMaxRequests: 10_000, windowMs: 60_000,
  });

  async function login(subject: string) {
    const client = await issueTestSession({
      factory,
      subject: subject,
      displayName: subject,
      handle: `sea_${randomUUID().replaceAll('-', '').slice(0, 16)}`,
    });
    return { cookie: client.cookie, id: client.accountId, subject_id: client.subjectId };
  }

  test('anonymous route returns all four authorized union branches, filters types and traverses signed cursors', async () => {
    const api = buildApiApp({ config, searchQuery: productionQuery(), searchRateLimiter: generousSearchLimiter() });
    try {
      const all = await api.inject({ method: 'GET', url: '/api/v1/search?q=phasehttpneedle&limit=100' });
      assert.equal(all.statusCode, 200);
      assert.deepEqual(new Set(all.json<SearchHttpPage>().items.map((item) => item.resourceType)),
        new Set(['collection', 'node', 'profile', 'annotation']));
      assert.equal(all.headers['cache-control'], 'public, max-age=30, must-revalidate');
      assert.doesNotMatch(all.body, /owner_subject_id|creatorPrincipalId|policyRevision|snippetSource/u);

      const head = await api.inject({ method: 'HEAD', url: '/api/v1/search?q=phasehttpneedle&limit=100',
        headers: { origin: 'https://app.example.test' } });
      assert.equal(head.statusCode, 200);
      assert.equal(head.body, '');
      assert.equal(head.headers.etag, all.headers.etag);
      assert.equal(head.headers['content-length'], String(Buffer.byteLength(all.body)));
      assert.match(String(head.headers.vary), /Accept/u);
      assert.match(String(head.headers.vary), /Cookie/u);
      assert.match(String(head.headers.vary), /Authorization/u);
      assert.match(String(head.headers.vary), /Origin/u);

      const filtered = await api.inject({ method: 'GET', url: '/api/v1/search?q=phasehttpneedle&type=node&type=annotation' });
      assert.equal(filtered.statusCode, 200);
      assert.ok(filtered.json<SearchHttpPage>().items.every((item) => ['node', 'annotation'].includes(item.resourceType)));

      const ids: string[] = [];
      let cursor: string | null = null;
      do {
        const url = cursor === null ? '/api/v1/search?q=phasehttpneedle&limit=1'
          : `/api/v1/search?q=phasehttpneedle&cursor=${encodeURIComponent(cursor)}`;
        const page = await api.inject({ method: 'GET', url });
        assert.equal(page.statusCode, 200);
        const body = page.json<SearchHttpPage>();
        ids.push(...body.items.map((item) => `${item.resourceType}:${item.resourceId}`));
        cursor = body.page.nextCursor;
      } while (cursor !== null);
      assert.equal(new Set(ids).size, ids.length);
      assert.equal(ids.length, all.json<SearchHttpPage>().items.length);

      // FIX-L-025: within the hard TTL, an unchanged first page reuses its
      // signed cursor, so the identical If-None-Match revalidates with 304.
      const firstPage = await api.inject({ method: 'GET', url: '/api/v1/search?q=phasehttpneedle&limit=1' });
      assert.equal(firstPage.statusCode, 200);
      assert.ok(firstPage.json<SearchHttpPage>().page.nextCursor);
      const firstPageEtag = String(firstPage.headers.etag);
      const revalidated = await api.inject({ method: 'GET', url: '/api/v1/search?q=phasehttpneedle&limit=1',
        headers: { 'if-none-match': firstPageEtag } });
      assert.equal(revalidated.statusCode, 304);
      assert.equal(revalidated.body, '');

      const scopedFirst = await api.inject({ method: 'GET',
        url: '/api/v1/search?q=phasehttpneedle&type=collection&type=node&limit=1' });
      const scopedCursor = scopedFirst.json<SearchHttpPage>().page.nextCursor;
      assert.ok(scopedCursor);
      for (const replayUrl of [
        `/api/v1/search?q=differentquery&type=collection&type=node&cursor=${encodeURIComponent(scopedCursor!)}`,
        `/api/v1/search?q=phasehttpneedle&type=collection&cursor=${encodeURIComponent(scopedCursor!)}`,
      ]) {
        const rejected = await api.inject({ method: 'GET', url: replayUrl });
        assert.equal(rejected.statusCode, 400);
        assert.equal(rejected.json().error.code, 'invalid_cursor');
      }

      const first = await api.inject({ method: 'GET', url: '/api/v1/search?q=phasehttpneedle' });
      await runtime.pool.query(`update collections set visibility='private',policy_revision='search-http-private'
        where id='search-http-public'`);
      const hidden = await api.inject({ method: 'GET', url: '/api/v1/search?q=phasehttpneedle',
        headers: { 'if-none-match': String(first.headers.etag) } });
      assert.equal(hidden.statusCode, 200, 'visibility mutation cannot reuse a stale validator');
      assert.equal(hidden.json<SearchHttpPage>().items.some(isSearchHttpPublicResource), false);
      await runtime.pool.query(`update collections set visibility='public',policy_revision='search-http-public-again'
        where id='search-http-public'`);
      const visibleAgain = await api.inject({ method: 'GET', url: '/api/v1/search?q=phasehttpneedle' });
      await runtime.pool.query(`update collections set allow_search_indexing=false,policy_revision='search-http-revoked'
        where id='search-http-public'`);
      const staleValidator = await api.inject({ method: 'GET', url: '/api/v1/search?q=phasehttpneedle',
        headers: { 'if-none-match': String(visibleAgain.headers.etag) } });
      assert.equal(staleValidator.statusCode, 200, 'old ETag cannot skip fresh authority after opt-out');
      assert.equal(staleValidator.json<SearchHttpPage>().items.some(isSearchHttpPublicResource), false);
      assert.doesNotMatch(staleValidator.body, /phasehttpneedle annotation body/u);
      await runtime.pool.query(`update collections set allow_search_indexing=true,policy_revision='search-http-before-delete'
        where id='search-http-public'`);
      const beforeDelete = await api.inject({ method: 'GET', url: '/api/v1/search?q=phasehttpneedle' });
      const deleteClient = await runtime.pool.connect();
      try {
        await deleteClient.query('begin');
        await deleteClient.query('set constraints all deferred');
        await deleteClient.query(`update collections set deleted_at=current_timestamp,
          policy_revision='search-http-deleted' where id='search-http-public'`);
        await deleteClient.query(`update nodes set deleted_at=current_timestamp
          where collection_id='search-http-public'`);
        await deleteClient.query('commit');
      } catch (error) { await deleteClient.query('rollback'); throw error; } finally { deleteClient.release(); }
      const deleted = await api.inject({ method: 'GET', url: '/api/v1/search?q=phasehttpneedle',
        headers: { 'if-none-match': String(beforeDelete.headers.etag) } });
      assert.equal(deleted.statusCode, 200, 'soft deletion cannot reuse a stale validator');
      assert.equal(deleted.json<SearchHttpPage>().items.some(isSearchHttpPublicResource), false);
    } finally {
      const restoreClient = await runtime.pool.connect();
      try {
        await restoreClient.query('begin');
        await restoreClient.query('set constraints all deferred');
        await restoreClient.query(`update collections set visibility='public',allow_search_indexing=true,deleted_at=null,
          policy_revision='search-http-restored' where id='search-http-public'`);
        await restoreClient.query(`update nodes set deleted_at=null where collection_id='search-http-public'`);
        await restoreClient.query('commit');
      } catch (error) { await restoreClient.query('rollback'); throw error; } finally { restoreClient.release(); }
      await api.close();
    }
  });

  test('owner/member/outsider Sessions use current authority, private cache and principal-bound cursors', async () => {
    const identityUnitOfWork = createPostgresIdentityUnitOfWork(runtime.db,
      { oidcTransactionSecrets: config.oidcTransactionSecrets });
    const api = buildApiApp({ config, identityUnitOfWork, browserSessionAuthority: factory.authority,
      searchQuery: productionQuery(), searchRateLimiter: generousSearchLimiter() });
    try {
      const suffix = randomUUID().slice(0, 8);
      const owner = await login(`search-owner-${suffix}`);
      const member = await login(`search-member-${suffix}`);
      const outsider = await login(`search-outsider-${suffix}`);
      await seedSessionCorpus(runtime, owner.subject_id, owner.id, member.subject_id, suffix);
      const url = `/api/v1/search?q=sessionsearchneedle${suffix}&limit=100`;
      const anonymous = await api.inject({ method: 'GET', url });
      const ownerResponse = await api.inject({ method: 'GET', url, headers: { cookie: owner.cookie } });
      const memberResponse = await api.inject({ method: 'GET', url, headers: { cookie: member.cookie } });
      const outsiderResponse = await api.inject({ method: 'GET', url, headers: { cookie: outsider.cookie } });
      for (const response of [ownerResponse, memberResponse, outsiderResponse]) {
        assert.equal(response.statusCode, 200);
        assert.equal(response.headers['cache-control'], 'private, no-store');
        assert.equal(response.headers.etag, undefined, 'authenticated Search omits ETag');
      }
      assert.equal(anonymous.headers['cache-control'], 'public, max-age=30, must-revalidate');
      assert.match(String(anonymous.headers.etag), /^"sha256-/u);
      const ids = (response: typeof anonymous) => response.json<SearchHttpPage>().items.map((item) => item.resourceId);
      assert.ok(ids(ownerResponse).some((id) => id.includes('private-note')));
      assert.ok(ids(memberResponse).some((id) => id.includes('protected')));
      assert.ok(ids(memberResponse).some((id) => id.includes('private-collection')));
      assert.equal(ids(memberResponse).some((id) => id.includes('private-note')), false);
      assert.deepEqual(ids(outsiderResponse), ids(anonymous));

      const ownerConditional = await api.inject({ method: 'GET', url,
        headers: { cookie: owner.cookie, 'if-none-match': '*' } });
      assert.equal(ownerConditional.statusCode, 200, 'authenticated Search never 304s, including If-None-Match: *');
      assert.equal(ownerConditional.headers.etag, undefined);
      assert.equal(ownerConditional.headers['cache-control'], 'private, no-store');

      const first = await api.inject({ method: 'GET', url: `${url.replace('&limit=100', '')}&limit=1`,
        headers: { cookie: owner.cookie } });
      const cursor = first.json<SearchHttpPage>().page.nextCursor;
      assert.ok(cursor);
      const replay = await api.inject({ method: 'GET',
        url: `${url.replace('&limit=100', '')}&cursor=${encodeURIComponent(cursor!)}`,
        headers: { cookie: member.cookie } });
      assert.equal(replay.statusCode, 400);
      assert.equal(replay.json().error.code, 'invalid_cursor');

      for (const [headers, status, code] of [
        [{ authorization: 'Bearer forged-search-credential' }, 401, 'authentication_required'],
        [{ cookie: '__Host-known_session=not-a-session' }, 401, 'authentication_required'],
        [{ cookie: `${owner.cookie}; ${owner.cookie}` }, 400, 'invalid_request'],
      ] as const) {
        const rejected = await api.inject({ method: 'GET', url, headers });
        assert.equal(rejected.statusCode, status);
        assert.equal(rejected.json().error.code, code);
      }

      await runtime.pool.query(`delete from collection_members where collection_id=$1 and subject_id=$2`,
        [`search-${suffix}-private-collection`, member.subject_id]);
      const revoked = await api.inject({ method: 'GET', url,
        headers: { cookie: member.cookie, 'if-none-match': String(anonymous.headers.etag) } });
      assert.equal(revoked.statusCode, 200, 'authenticated Search never 304s a stale validator after membership revoke');
      assert.equal(revoked.headers.etag, undefined);
      assert.equal(ids(revoked).some((id) => id.includes('private-collection')), false);

      // E1 migration contract: session revocation now targets the Better Auth
      // session (the legacy `sessions` table is no longer the authority). The
      // metadata row cascades away with the auth_sessions row.
      await runtime.pool.query(`delete from auth_sessions where "userId" in
        (select auth_user_id from auth_user_account_map where account_id=$1)`, [member.id]);
      const staleSession = await api.inject({ method: 'GET', url, headers: { cookie: member.cookie } });
      assert.equal(staleSession.statusCode, 401);
      assert.equal(staleSession.json().error.code, 'authentication_required');

      await runtime.pool.query(`update accounts set security_epoch=security_epoch+1 where id=$1`, [owner.id]);
      const staleEpoch = await api.inject({ method: 'GET', url, headers: { cookie: owner.cookie } });
      assert.equal(staleEpoch.statusCode, 401);
      assert.equal(staleEpoch.json().error.code, 'authentication_required');
    } finally { await api.close(); }
  });

  test('real TCP admission rejects malformed encoding and control payloads before PostgreSQL execution', async () => {
    const api = buildApiApp({ config, searchQuery: productionQuery(), searchRateLimiter: generousSearchLimiter() });
    const address = await api.listen({ host: '127.0.0.1', port: 0 });
    try {
      const port = Number(new URL(address).port);
      const invalidTargets = [
        '/api/v1/search?q=%',
        '/api/v1/search?q=%C0%AF',
        '/api/v1/search?q=%E4%B8',
        '/api/v1/search?q=%00hidden-network-marker',
        '/api/v1/search?q=%C2%85hidden-network-marker',
        '/api/v1/search?q=%E2%80%AEhidden-network-marker',
        `/api/v1/search?q=${'%E4%B8%AD'.repeat(228)}`,
        `/api/v1/search?q=ok&padding=${'x'.repeat(8_193)}`,
      ];
      for (const target of invalidTargets) {
        const response = await rawHttp(port, target);
        assert.equal(response.statusCode, 400, target.slice(0, 120));
        assert.equal(JSON.parse(response.body).error.code, 'invalid_query');
        assert.doesNotMatch(response.body, /hidden-network-marker|URIError|stack|syntax|postgres/iu);
      }

      for (const target of [
        '/api/v1/search?q=phasehttpneedle+',
        '/api/v1/search?q=%2525',
        `/api/v1/search?q=${'%E4%B8%AD'.repeat(227)}`,
        '/api/v1/search?q=%22quoted%22%3Atitle%25_%5C',
      ]) {
        const response = await rawHttp(port, target, { Accept: 'application/json; q=1.0, */*;q=0.1' });
        assert.equal(response.statusCode, 200, target.slice(0, 120));
        assert.doesNotMatch(response.body, /queryDigest|snippetSource|ownerSubjectId/u);
      }
    } finally { await api.close(); }
  });

  test('real PostgreSQL Search path rate-limits and maps an unavailable database without leakage', async () => {
    const limited = buildApiApp({ config, searchQuery: productionQuery(),
      searchRateLimiter: createMemorySearchRateLimiter({ anonymousMaxRequests: 1, accountMaxRequests: 1, windowMs: 60_000 }) });
    try {
      assert.equal((await limited.inject({ method: 'GET', url: '/api/v1/search?q=phasehttpneedle' })).statusCode, 200);
      const rejected = await limited.inject({ method: 'GET', url: '/api/v1/search?q=rate-secret-marker' });
      assert.equal(rejected.statusCode, 429);
      assert.equal(rejected.headers['retry-after'], '60');
      assert.equal(rejected.headers['ratelimit-policy'], 'search:anonymous:1:60000');
      assert.equal(rejected.json().error.code, 'rate_limited');
      assert.doesNotMatch(rejected.body, /rate-secret-marker/u);
    } finally { await limited.close(); }

    const unavailableRuntime = createDatabaseRuntime(
      'postgresql://known:known@127.0.0.1:1/search_unavailable_secret',
      { maxConnections: 1, connectionTimeoutMs: 100, applicationName: 'known-search-unavailable' },
    );
    const ports = { candidates: createPostgresSearchCandidatePort(unavailableRuntime.db),
      authority: createPostgresSearchAuthorityPort(unavailableRuntime.db),
      cursors: createSearchCursorSigner({ current: { id: 'unavailable-v1', key: 'unavailable-cursor-secret-material' } }),
      clock: { now: () => new Date() },
      sharedExposure: createPostgresSharedExposureFactsPort(unavailableRuntime) };
    const unavailable = buildApiApp({ config,
      searchQuery: { execute: (input) => executeSearchQuery(ports, input) },
      searchRateLimiter: generousSearchLimiter() });
    try {
      const response = await unavailable.inject({ method: 'GET', url: '/api/v1/search?q=database-secret-marker' });
      assert.equal(response.statusCode, 503);
      assert.equal(response.headers['retry-after'], '1');
      assert.equal(response.json().error.code, 'feature_temporarily_unavailable');
      assert.doesNotMatch(response.body, /database-secret-marker|search_unavailable_secret|127\.0\.0\.1/iu);
    } finally {
      await unavailable.close();
      await unavailableRuntime.close();
    }
  });

  test('route timeout cancels a real PostgreSQL statement and leaves the pool reusable', async () => {
    const blocker = await runtime.pool.connect();
    await blocker.query('begin');
    await blocker.query('lock table collections in access exclusive mode');
    const api = buildApiApp({ config, searchQuery: productionQuery(), searchTimeoutMs: 50, searchRateLimiter: generousSearchLimiter() });
    try {
      const response = await api.inject({ method: 'GET', url: '/api/v1/search?q=timeoutprobe' });
      assert.equal(response.statusCode, 503);
      assert.equal(response.json().error.code, 'feature_temporarily_unavailable');
      assert.equal(response.headers['retry-after'], '1');
      await waitUntil(async () => Number((await runtime.pool.query<{ count: string }>(`select count(*)::text count
        from pg_stat_activity where pid <> pg_backend_pid()
          and application_name='known-search-product-http' and query like '%profile_hits%'
          and state='active'`)).rows[0]?.count ?? 1) === 0);
    } finally {
      await blocker.query('rollback');
      blocker.release();
      assert.equal((await runtime.pool.query<{ value: number }>('select 1 value')).rows[0]?.value, 1);
      await api.close();
    }
  });

  test('FIX-M-006 authenticated Search rate limit keys by ACCOUNT, anonymous by trusted client IP', async () => {
    const identityUnitOfWork = createPostgresIdentityUnitOfWork(runtime.db,
      { oidcTransactionSecrets: config.oidcTransactionSecrets });
    const api = buildApiApp({
      config,
      identityUnitOfWork,
      browserSessionAuthority: factory.authority,
      searchQuery: productionQuery(),
      searchRateLimiter: createMemorySearchRateLimiter({ anonymousMaxRequests: 2, accountMaxRequests: 1, windowMs: 60_000 }),
    });
    try {
      const suffix = randomUUID().slice(0, 8);
      const owner = await login(`search-rate-owner-${suffix}`);
      const outsider = await login(`search-rate-outsider-${suffix}`);
      await seedSessionCorpus(runtime, owner.subject_id, owner.id, outsider.subject_id, suffix);
      const url = `/api/v1/search?q=sessionsearchneedle${suffix}&limit=100`;

      // Anonymous (same peer 127.0.0.1) consumes its own independent budget.
      assert.equal((await api.inject({ method: 'GET', url })).statusCode, 200);
      assert.equal((await api.inject({ method: 'GET', url })).statusCode, 200);
      const anonymousExhausted = await api.inject({ method: 'GET', url });
      assert.equal(anonymousExhausted.statusCode, 429);
      assert.equal(anonymousExhausted.headers['ratelimit-policy'], 'search:anonymous:2:60000');

      // The OWNER account has its own budget (1): first request allowed...
      const ownerFirst = await api.inject({ method: 'GET', url, headers: { cookie: owner.cookie } });
      assert.equal(ownerFirst.statusCode, 200);
      // ...second denied against the ACCOUNT bucket, not the IP bucket.
      const ownerSecond = await api.inject({ method: 'GET', url, headers: { cookie: owner.cookie } });
      assert.equal(ownerSecond.statusCode, 429);
      assert.equal(ownerSecond.headers['ratelimit-policy'], 'search:account:1:60000');

      // A DIFFERENT account is fully isolated (account-keyed identity).
      const outsiderFirst = await api.inject({ method: 'GET', url, headers: { cookie: outsider.cookie } });
      assert.equal(outsiderFirst.statusCode, 200, 'a different account keeps its own Search budget');

      // The anonymous peer bucket stays exhausted regardless.
      const anonymousAgain = await api.inject({ method: 'GET', url });
      assert.equal(anonymousAgain.statusCode, 429, 'the anonymous IP budget stays exhausted');
    } finally { await api.close(); }
  });

  test('client disconnect aborts a real PostgreSQL statement and the connection remains reusable', async () => {
    const blocker = await runtime.pool.connect();
    await blocker.query('begin');
    await blocker.query('lock table collections in access exclusive mode');
    const api = buildApiApp({ config, searchQuery: productionQuery(), searchTimeoutMs: 5_000, searchRateLimiter: generousSearchLimiter() });
    const address = await api.listen({ host: '127.0.0.1', port: 0 });
    try {
      const port = Number(new URL(address).port);
      const request = httpRequest({ host: '127.0.0.1', port, method: 'GET', path: '/api/v1/search?q=abortprobe' });
      request.on('error', () => undefined);
      request.end();
      await waitUntil(async () => Number((await runtime.pool.query<{ count: string }>(`select count(*)::text count
        from pg_stat_activity where pid <> pg_backend_pid()
          and application_name='known-search-product-http' and query like '%profile_hits%'
          and wait_event_type='Lock'`)).rows[0]?.count ?? 0) > 0);
      request.destroy();
      await waitUntil(async () => Number((await runtime.pool.query<{ count: string }>(`select count(*)::text count
        from pg_stat_activity where application_name='known-search-product-http' and query like '%profile_hits%'
        and pid <> pg_backend_pid() and state='active'`)).rows[0]?.count ?? 1) === 0);
    } finally {
      await blocker.query('rollback');
      blocker.release();
      assert.equal((await runtime.pool.query<{ value: number }>('select 1 value')).rows[0]?.value, 1);
      await api.close();
    }
  });
});

type SearchHttpPage = operations['searchResources']['responses'][200]['content']['application/json'];

function isSearchHttpPublicResource(item: SearchHttpPage['items'][number]): boolean {
  return item.resourceId === 'search-http-public'
    || ('collectionId' in item && item.collectionId === 'search-http-public');
}

async function rawHttp(port: number, target: string,
  headers: Readonly<Record<string, string>> = {}): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const socket = connectSocket({ host: '127.0.0.1', port });
    const chunks: Buffer[] = [];
    const timeout = setTimeout(() => socket.destroy(new Error('raw Search HTTP request timed out')), 3_000);
    socket.on('connect', () => {
      const headerLines = Object.entries(headers).map(([name, value]) => `${name}: ${value}`);
      socket.write([`GET ${target} HTTP/1.1`, `Host: 127.0.0.1:${port}`, 'Connection: close',
        ...headerLines, '', ''].join('\r\n'), 'latin1');
    });
    socket.on('data', (chunk: Buffer) => chunks.push(chunk));
    socket.on('error', reject);
    socket.on('close', () => {
      clearTimeout(timeout);
      const response = Buffer.concat(chunks).toString('utf8');
      const boundary = response.indexOf('\r\n\r\n');
      const status = /^HTTP\/1\.1 (\d{3})/u.exec(response)?.[1];
      if (!status || boundary < 0) { reject(new Error(`invalid raw HTTP response: ${response.slice(0, 120)}`)); return; }
      resolve({ statusCode: Number(status), body: response.slice(boundary + 4) });
    });
  });
}

async function waitUntil(predicate: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error('cancelled PostgreSQL statement remained active');
}

async function seedSearchCorpus(runtime: DatabaseRuntime): Promise<void> {
  await runtime.pool.query(`insert into accounts(id,subject_id,status,security_epoch)
    values('search-http-owner','search-http-owner-subject','active',1)`);
  await runtime.pool.query(`insert into profiles(account_id,display_name,avatar_url)
    values('search-http-owner','phasehttpneedle profile','https://example.test/profile.png')`);
  await runtime.pool.query(`insert into profile_handles(handle,account_id)
    values('phasehttpneedle','search-http-owner')`);
  const client = await runtime.pool.connect();
  try {
    await client.query('begin');
    await client.query('set constraints all deferred');
    await client.query(`insert into resource_id_ledger(resource_id,resource_type) values
      ('search-http-public','collection'),('search-http-root','node'),('search-http-node','node'),('search-http-annotation','annotation')`);
    await client.query(`insert into collections(id,owner_subject_id,title,summary,kind,visibility,
      allow_search_indexing,publication_slug,published_at,root_node_id,resource_revision,content_revision,policy_revision)
      values('search-http-public','search-http-owner-subject','phasehttpneedle collection','phasehttpneedle summary',
        'bookmarks','public',true,'search-http-public',current_timestamp,'search-http-root','r1','c1','p1')`);
    await client.query(`insert into nodes(id,collection_id,parent_id,kind,is_root,title,url,description,visibility,
      position_token,resource_revision,children_revision) values
      ('search-http-root','search-http-public',null,'folder',true,'Root',null,null,'inherit',null,'r1','c1'),
      ('search-http-node','search-http-public','search-http-root','bookmark',false,'phasehttpneedle node',
        'https://docs.example.test/http','phasehttpneedle node body','inherit','a','r1','c1')`);
    const timestamp = '2026-07-25T00:00:00.000Z';
    const payload = { id: 'search-http-annotation', collectionId: 'search-http-public',
      subject: { type: 'collection', id: 'search-http-public' },
      creator: { id: 'https://known.test/profiles/phasehttpneedle', name: 'HTTP Owner' }, type: 'note',
      format: 'plain', value: 'phasehttpneedle annotation body', visibility: 'public', revision: 'r1',
      createdAt: timestamp, updatedAt: timestamp };
    await client.query(`insert into annotations(id,collection_id,subject_type,subject_id,creator_principal_id,
      type,format,value_json,visibility,resource_revision,created_at,updated_at,payload_json)
      values('search-http-annotation','search-http-public','collection','search-http-public','search-http-owner',
        'note','plain',to_jsonb('phasehttpneedle annotation body'::text),'public','r1',$1,$1,$2::jsonb)`,
    [timestamp, JSON.stringify(payload)]);
    await client.query('commit');
  } catch (error) { await client.query('rollback'); throw error; } finally { client.release(); }
}

async function seedSessionCorpus(runtime: DatabaseRuntime, ownerSubject: string, ownerPrincipal: string,
  memberSubject: string, suffix: string): Promise<void> {
  const token = `sessionsearchneedle${suffix}`;
  for (const [name, visibility] of [['public', 'public'], ['protected', 'protected'],
    ['private-collection', 'private']] as const) {
    const id = `search-${suffix}-${name}`;
    const root = `${id}-root`;
    const client = await runtime.pool.connect();
    try {
      await client.query('begin');
      await client.query('set constraints all deferred');
      await client.query(`insert into resource_id_ledger(resource_id,resource_type) values($1,'collection'),($2,'node')`,
        [id, root]);
      await client.query(`insert into collections(id,owner_subject_id,title,summary,kind,visibility,
        allow_search_indexing,publication_slug,published_at,root_node_id,resource_revision,content_revision,policy_revision)
        values($1,$2,$3,$3,'bookmarks',$4,true,case when $4='public' then $1 end,
          case when $4='public' then current_timestamp end,$5,'r1','c1','p1')`,
      [id, ownerSubject, token, visibility, root]);
      await client.query(`insert into nodes(id,collection_id,kind,is_root,title,resource_revision,children_revision)
        values($1,$2,'folder',true,'Root','r1','c1')`, [root, id]);
      await client.query('commit');
    } catch (error) { await client.query('rollback'); throw error; } finally { client.release(); }
  }
  await runtime.pool.query(`insert into collection_members(collection_id,subject_id,role) values
    ($1,$3,'viewer'),($2,$3,'viewer')`, [`search-${suffix}-protected`, `search-${suffix}-private-collection`, memberSubject]);
  const collectionId = `search-${suffix}-private-collection`;
  const annotationId = `search-${suffix}-private-note`;
  const timestamp = '2026-07-25T00:00:00.000Z';
  const payload = { id: annotationId, collectionId, subject: { type: 'collection', id: collectionId },
    creator: { id: 'https://known.test/profiles/session-owner', name: 'Session Owner' }, type: 'note',
    format: 'plain', value: token, visibility: 'private', revision: 'r1', createdAt: timestamp, updatedAt: timestamp };
  await runtime.pool.query(`insert into resource_id_ledger(resource_id,resource_type) values($1,'annotation')`, [annotationId]);
  await runtime.pool.query(`insert into annotations(id,collection_id,subject_type,subject_id,creator_principal_id,
    type,format,value_json,visibility,resource_revision,created_at,updated_at,payload_json)
    values($1,$2,'collection',$2,$3,'note','plain',to_jsonb($4::text),'private','r1',$5,$5,$6::jsonb)`,
  [annotationId, collectionId, ownerPrincipal, token, timestamp, JSON.stringify(payload)]);
}
