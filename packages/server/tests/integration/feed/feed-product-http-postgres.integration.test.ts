import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { connect } from 'node:net';
import { afterAll, beforeAll, test } from 'vitest';
import { sql } from 'kysely';
import { createProductFeedClient } from '../../../generated/openapi/product-v1.client.js';
import { loadConfig } from '../../support/test-config.js';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import { createPostgresIdentityUnitOfWork } from '../../../src/infrastructure/identity/index.js';
import { createPostgresFeedQueryUnitOfWork } from '../../../src/infrastructure/social/index.js';
import { createFeedCursorKeyring } from '../../../src/modules/social/index.js';
import { buildApiApp } from '../../../src/transport/app.js';
import { createFixedWindowRateLimiter } from '../../../src/transport/http-security.js';
import { issueTestSession, type AuthenticatedTestClient } from '../../support/product-http-harness.js';
import { createPostgresBetterAuthTestFactory } from '../../support/better-auth-test-factory.js';
import { createIsolatedPostgresRuntime, describeWithPostgres,
  type IsolatedPostgresRuntime } from '../../support/postgres-test-runtime.js';

describeWithPostgres('P5-13 Product Feed HTTP', () => {
  const ORIGIN = 'https://app.example.test';
  const ISSUER = 'https://issuer.example.test/realms/known';
  const SECRET = 'feed-http-private-secret-marker';
  const PUBLIC_TITLE = 'Feed HTTP Public Collection';
  const PUBLIC_SLUG = 'feed-http';
  let isolated: IsolatedPostgresRuntime;
  let factory: ReturnType<typeof createPostgresBetterAuthTestFactory>;
  let recipient: AuthenticatedTestClient;
  let actor: AuthenticatedTestClient;
  let collectionId: string;
  let config: ReturnType<typeof loadConfig>;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('phase5_feed_http', { maxConnections: 8 });
    await runMigrations(isolated.runtime.db, 'latest');
    config = loadConfig({ DATABASE_URL: isolated.databaseUrl, PRODUCT_ORIGIN: ORIGIN,
      ALLOWED_ORIGINS: ORIGIN, OIDC_ISSUER: ISSUER, OIDC_CLIENT_ID: 'known-web',
      OIDC_REDIRECT_URI: `${ORIGIN}/api/v1/auth/oidc/callback`, OIDC_AUTHORIZATION_ENDPOINT: `${ISSUER}/auth`,
      OIDC_TOKEN_ENDPOINT: `${ISSUER}/token`, OIDC_ALLOW_TEST_PROVIDER: 'true', OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default', NODE_ENV: 'test',
      LOG_LEVEL: 'silent', KNOWN_FEATURE_FEED: 'true', FEED_CURSOR_ACTIVE_KEY_ID: 'feed-http',
      FEED_CURSOR_ACTIVE_SECRET: Buffer.alloc(32, 31).toString('base64') });
    const identity = createPostgresIdentityUnitOfWork(isolated.runtime.db);
    factory = createPostgresBetterAuthTestFactory({ db: isolated.runtime.db });
    recipient = await issueTestSession({ factory,
      subject: `feed-recipient-${randomUUID()}`, handle: `r${randomUUID().replaceAll('-', '').slice(0, 12)}` });
    actor = await issueTestSession({ factory,
      subject: `feed-actor-${randomUUID()}`, handle: `a${randomUUID().replaceAll('-', '').slice(0, 12)}` });
    collectionId = `feed-collection-${randomUUID()}`;
    const rootId = `root-${collectionId}`;
    await isolated.runtime.pool.query(`insert into resource_id_ledger(resource_id,resource_type,committed_at)
      values($1,'collection',current_timestamp),($2,'node',current_timestamp)`, [collectionId, rootId]);
    const fixture = await isolated.runtime.pool.connect();
    try {
      await fixture.query('begin'); await fixture.query('set constraints all deferred');
      await fixture.query(`insert into collections(
        id,owner_subject_id,title,summary,kind,visibility,publication_slug,published_at,root_node_id,root_node_is_root,
        resource_revision,content_revision,policy_revision,commit_ordinal,created_at,updated_at)
        values($1,$2,$3,$4,'bookmarks','public','feed-http',current_timestamp,$5,true,
          'r1','c1','p1',1,current_timestamp,current_timestamp)`,
      [collectionId, actor.subjectId, PUBLIC_TITLE, SECRET, rootId]);
      await fixture.query(`insert into nodes(id,collection_id,parent_id,kind,is_root,title,url,
        position_token,resource_revision,children_revision,created_at,updated_at)
        values($1,$2,null,'folder',true,'Root',null,null,'r1','ch1',current_timestamp,current_timestamp)`,
      [rootId, collectionId]);
      await fixture.query('commit');
    } catch (error: unknown) {
      await fixture.query('rollback').catch(() => undefined); throw error;
    } finally { fixture.release(); }
    await isolated.runtime.pool.query(`insert into follows(actor_profile_id,target_profile_id,followed_at)
      values($1,$2,current_timestamp - interval '1 hour')`, [recipient.accountId, actor.accountId]);
    for (let index = 0; index < 3; index += 1) {
      await isolated.runtime.pool.query(`insert into social_feed_items(feed_item_id,source_event_id,kind,
        recipient_profile_id,actor_profile_id,collection_id,source_event_version,source_commit_ordinal,
        publication_revision,discoverability_recheck_key,published_at,retain_until)
        values($1,$2,'collection_change',$3,$4,$5,1,$6,'c1.p1',$7,
          current_timestamp - ($8 * interval '1 minute'),
          current_timestamp - ($8 * interval '1 minute') + interval '90 days')`,
      [`feed-http-item-${index}`, `feed-http-event-${index}`, recipient.accountId, actor.accountId,
        collectionId, index + 1, `publication.collection:${collectionId}`, index]);
    }
  }, 120_000);
  afterAll(async () => isolated?.close());

  function composition(options: { enabled?: boolean; rate?: number; timeoutMs?: number } = {}) {
    const identity = createPostgresIdentityUnitOfWork(isolated.runtime.db);
    const cursors = createFeedCursorKeyring(config.feed!.cursorKeys);
    const app = buildApiApp({ config: options.timeoutMs === undefined && options.enabled === undefined ? config : {
      ...config, feed: { ...config.feed!, ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        ...(options.enabled === undefined ? {} : { enabled: options.enabled }) } },
    identityUnitOfWork: identity,
    browserSessionAuthority: factory.authority,
    feedQueryUnitOfWork: createPostgresFeedQueryUnitOfWork(isolated.runtime, cursors),
    feedRateLimiter: createFixedWindowRateLimiter({ maxRequests: options.rate ?? 100, windowMs: 60_000 }) });
    app.addHook('onClose', async () => cursors.destroy());
    return app;
  }

  test('generated client traverses the full current-authorized Feed through production composition', async () => {
    const app = composition();
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    try {
      const client = createProductFeedClient({ origin: address, sessionCookie: recipient.cookie });
      const seen: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await client.feed(cursor ? { cursor } : { limit: 1 });
        assertFeedPageSchema(page);
        seen.push(...page.items.map((item) => item.feedItemId));
        assert.equal(page.items[0]!.collectionTitle, PUBLIC_TITLE);
        assert.equal(page.items[0]!.publicationSlug, PUBLIC_SLUG);
        assert.equal(page.items[0]!.summary, 'public_collection_updated');
        assert.equal(JSON.stringify(page).includes(SECRET), false);
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      assert.deepEqual(seen, ['feed-http-item-0', 'feed-http-item-1', 'feed-http-item-2']);
      await assert.rejects(() => client.feed({ cursor: 'tampered-private-cursor' }),
        (error: unknown) => clientError(error, 400, 'invalid_cursor'));
      const head = await app.inject({ method: 'HEAD', url: '/api/v1/feed?limit=1',
        headers: { cookie: recipient.cookie } });
      assert.equal(head.statusCode, 200); assert.equal(head.body, '');
      assert.equal(head.headers['cache-control'], 'private, no-store');
    } finally { await app.close(); }
  });

  test('frozen Phase 5 /api/v1/me/feed alias serves the same current-authorized Feed', async () => {
    const app = composition();
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    try {
      const client = createProductFeedClient({ origin: address, sessionCookie: recipient.cookie });
      const page = await client.myFeed({ limit: 1 });
      assertFeedPageSchema(page);
      assert.deepEqual(page.items.map((item) => item.feedItemId), ['feed-http-item-0']);
      assert.equal(page.items[0]!.collectionTitle, PUBLIC_TITLE);
      assert.equal(page.items[0]!.publicationSlug, PUBLIC_SLUG);
      assert.equal(page.items[0]!.summary, 'public_collection_updated');
      const successor = await app.inject({ method: 'GET', url: '/api/v1/feed?limit=1',
        headers: { cookie: recipient.cookie } });
      const alias = await app.inject({ method: 'GET', url: '/api/v1/me/feed?limit=1',
        headers: { cookie: recipient.cookie } });
      assert.equal(successor.statusCode, 200, successor.body);
      assert.equal(alias.statusCode, 200, alias.body);
      assert.deepEqual(successor.json().items, alias.json().items);
      assert.equal(JSON.stringify(page).includes(SECRET), false);
      await assert.rejects(() => client.myFeed({ cursor: 'tampered-private-cursor' }),
        (error: unknown) => clientError(error, 400, 'invalid_cursor'));
      const head = await app.inject({ method: 'HEAD', url: '/api/v1/me/feed?limit=1',
        headers: { cookie: recipient.cookie } });
      assert.equal(head.statusCode, 200); assert.equal(head.body, '');
      assert.equal(head.headers['cache-control'], 'private, no-store');
      const concealed = composition({ enabled: false });
      try {
        const response = await concealed.inject({ method: 'GET', url: '/api/v1/me/feed',
          headers: { cookie: recipient.cookie } });
        assert.equal(response.statusCode, 404);
        assert.equal(response.json().error.code, 'resource_not_found');
      } finally { await concealed.close(); }
    } finally { await app.close(); }
  });

  test('Feed rejects duplicate query/header cardinality and applies a shared GET/HEAD rate budget', async () => {
    const app = composition();
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    try {
      for (const path of ['/api/v1/feed?limit=1&limit=2', '/api/v1/feed?kind=collection_change&kind=follow_activity',
        '/api/v1/feed?cursor=a&limit=1', '/api/v1/feed?private-marker=x']) {
        const response = await rawHttp(address, [`GET ${path} HTTP/1.1`, `Host: ${new URL(address).host}`,
          `Cookie: ${recipient.cookie}`, 'Connection: close', '', ''].join('\r\n'));
        assert.match(response, /^HTTP\/1\.1 400 /u, path);
      }
      const duplicateCookie = await rawHttp(address, ['GET /api/v1/feed HTTP/1.1',
        `Host: ${new URL(address).host}`, `Cookie: ${recipient.cookie}`, `Cookie: ${recipient.cookie}`,
        'Connection: close', '', ''].join('\r\n'));
      assert.match(duplicateCookie, /^HTTP\/1\.1 400 /u);
    } finally { await app.close(); }
    const rateApp = composition({ rate: 1 });
    try {
      const ok = await rateApp.inject({ method: 'GET', url: '/api/v1/feed', headers: { cookie: recipient.cookie } });
      assert.equal(ok.statusCode, 200);
      assert.equal(ok.headers['cache-control'], 'private, no-store');
      assert.equal(ok.headers['content-length'], String(Buffer.byteLength(ok.body)));
      const limited = await rateApp.inject({ method: 'HEAD', url: '/api/v1/feed', headers: { cookie: recipient.cookie } });
      assert.equal(limited.statusCode, 429); assert.equal(limited.body, '');
      assert.equal(limited.headers['retry-after'], '60');
    } finally { await rateApp.close(); }
  });

  test('Feed is Session-only, concealed while disabled, and keeps every error private with empty HEAD bodies', async () => {
    const app = composition();
    try {
      for (const headers of [{}, { authorization: 'Bearer not-a-session' }]) {
        const response = await app.inject({ method: 'GET', url: '/api/v1/feed', headers });
        assert.equal(response.statusCode, 401); assert.equal(response.headers['cache-control'], 'private, no-store');
      }
      const invalid = await app.inject({ method: 'HEAD', url: '/api/v1/feed?limit=0',
        headers: { cookie: recipient.cookie } });
      assert.equal(invalid.statusCode, 400); assert.equal(invalid.body, '');
      assert.equal(invalid.headers['cache-control'], 'private, no-store');
    } finally { await app.close(); }

    const concealed = composition({ enabled: false });
    try {
      const response = await concealed.inject({ method: 'GET', url: '/api/v1/feed',
        headers: { cookie: recipient.cookie } });
      assert.equal(response.statusCode, 404); assert.equal(response.json().error.code, 'resource_not_found');
      assert.equal(response.headers['cache-control'], 'private, no-store');
    } finally { await concealed.close(); }
  });

  test('real PostgreSQL Feed SELECT is cancelled on timeout and client abort', async () => {
    const blocker = await isolated.runtime.pool.connect();
    await blocker.query('begin'); await blocker.query('lock table social_feed_items in access exclusive mode');
    try {
      const timed = composition({ timeoutMs: 50 });
      try {
        const response = await timed.inject({ method: 'GET', url: '/api/v1/feed',
          headers: { cookie: recipient.cookie } });
        assert.equal(response.statusCode, 503);
        assert.equal(response.json().error.code, 'feature_temporarily_unavailable');
        assert.doesNotMatch(response.body, new RegExp(SECRET, 'u'));
        await waitForNoFeedSelect();
      } finally { await timed.close(); }

      const aborting = composition({ timeoutMs: 5_000 });
      const address = await aborting.listen({ host: '127.0.0.1', port: 0 });
      try {
        const url = new URL(address);
        const request = httpRequest({ host: url.hostname, port: Number(url.port), method: 'GET', path: '/api/v1/feed',
          headers: { Cookie: recipient.cookie } });
        request.on('error', () => undefined); request.end();
        await waitUntil(async () => Number((await isolated.runtime.pool.query<{ count: string }>(`
          select count(*)::text count from pg_stat_activity where pid <> pg_backend_pid()
            and query like '%from social_feed_items item%' and wait_event_type='Lock'`)).rows[0]?.count ?? 0) > 0);
        request.destroy();
        await waitForNoFeedSelect();
      } finally { await aborting.close(); }
    } finally {
      await blocker.query('rollback').catch(() => undefined); blocker.release();
    }
  });

  test('independent cancellation stops all queries when the business pool is saturated', async () => {
    const saturated = await createIsolatedPostgresRuntime('phase5_feed_cancel', {
      maxConnections: 2,
      statementTimeoutMs: 30_000,
    });
    const cursors = createFeedCursorKeyring(config.feed!.cursorKeys);
    let entered = 0;
    let releaseStarted!: () => void;
    const bothStarted = new Promise<void>((resolve) => { releaseStarted = resolve; });
    const unit = createPostgresFeedQueryUnitOfWork(saturated.runtime, cursors, {
      faultInjector: {
        async beforeCallback(transaction) {
          entered += 1;
          if (entered === 2) releaseStarted();
          await sql`select pg_sleep(10)`.execute(transaction);
        },
      },
    });
    const controllers = [new AbortController(), new AbortController()];
    try {
      await runMigrations(saturated.runtime.db, 'latest');
      const pending = controllers.map((controller) => unit.execute(
        async () => 'unreachable', { signal: controller.signal },
      ));
      await Promise.race([
        bothStarted,
        new Promise<never>((_, reject) => setTimeout(
          () => reject(new Error('business pool did not saturate')), 2_000,
        )),
      ]);
      const reasons = controllers.map((_, index) => new Error(`cancel-${index}`));
      controllers.forEach((controller, index) => controller.abort(reasons[index]));
      const settled = await Promise.allSettled(pending);
      assert.deepEqual(settled.map((result) => result.status), ['rejected', 'rejected']);
      for (const [index, result] of settled.entries()) {
        assert.equal(result.status === 'rejected' ? result.reason : undefined, reasons[index]);
      }

      const reused = await Promise.all([
        saturated.runtime.pool.query('select pg_sleep(0.1), 1 as value'),
        saturated.runtime.pool.query('select pg_sleep(0.1), 2 as value'),
      ]);
      assert.deepEqual(reused.map((result) => result.rows[0]?.value), [1, 2]);
      assert.equal(saturated.runtime.pool.waitingCount, 0);
      assert.equal(saturated.runtime.pool.totalCount, 2);
      assert.equal(saturated.runtime.pool.idleCount, 2);
    } finally {
      cursors.destroy();
      await saturated.close();
    }
  }, 120_000);

  test('joins public collection locators, nulls follow_activity locators, and hides title after eligibility loss', async () => {
    const app = composition();
    try {
      await isolated.runtime.pool.query(`insert into follows(actor_profile_id,target_profile_id,followed_at)
        values($1,$2,current_timestamp - interval '1 hour')`, [actor.accountId, recipient.accountId]);
      const followItemId = `feed-http-follow-${randomUUID()}`;
      await isolated.runtime.pool.query(`insert into social_feed_items(feed_item_id,source_event_id,kind,
        recipient_profile_id,actor_profile_id,collection_id,source_event_version,source_commit_ordinal,
        publication_revision,discoverability_recheck_key,published_at,retain_until)
        values($1,$2,'follow_activity',$3,$4,null,1,0,null,$5,
          current_timestamp - interval '2 minutes',
          current_timestamp - interval '2 minutes' + interval '90 days')`,
      [followItemId, `feed-http-follow-event-${randomUUID()}`, recipient.accountId, actor.accountId,
        `follow:${actor.accountId}:${recipient.accountId}`]);

      const successor = await app.inject({ method: 'GET', url: '/api/v1/feed?limit=10',
        headers: { cookie: recipient.cookie } });
      const alias = await app.inject({ method: 'GET', url: '/api/v1/me/feed?limit=10',
        headers: { cookie: recipient.cookie } });
      assert.equal(successor.statusCode, 200, successor.body);
      assert.equal(alias.statusCode, 200, alias.body);
      const successorPage = successor.json() as { items: Array<Record<string, unknown>> };
      const aliasPage = alias.json() as { items: Array<Record<string, unknown>> };
      assertFeedPageSchema(successorPage);
      assertFeedPageSchema(aliasPage);
      assert.deepEqual(successorPage.items, aliasPage.items);
      assert.equal(JSON.stringify(successorPage).includes(SECRET), false);
      const change = successorPage.items.find((item) => item.kind === 'collection_change');
      const follow = successorPage.items.find((item) => item.kind === 'follow_activity');
      assert.equal(change?.collectionTitle, PUBLIC_TITLE);
      assert.equal(change?.publicationSlug, PUBLIC_SLUG);
      assert.equal(change?.summary, 'public_collection_updated');
      assert.equal(follow?.collectionId, null);
      assert.equal(follow?.collectionTitle, null);
      assert.equal(follow?.publicationSlug, null);
      assert.equal(follow?.summary, 'new_follower');

      for (const visibility of ['private', 'unlisted'] as const) {
        await isolated.runtime.pool.query('update collections set visibility=$2 where id=$1',
          [collectionId, visibility]);
        try {
          const hidden = await app.inject({ method: 'GET', url: '/api/v1/feed',
            headers: { cookie: recipient.cookie } });
          const hiddenAlias = await app.inject({ method: 'GET', url: '/api/v1/me/feed',
            headers: { cookie: recipient.cookie } });
          assert.equal(hidden.statusCode, 200, hidden.body);
          assert.equal(hiddenAlias.statusCode, 200, hiddenAlias.body);
          const hiddenPage = hidden.json() as { items: Array<{ kind: string }> };
          assert.deepEqual(hidden.json().items, hiddenAlias.json().items);
          assert.equal(hiddenPage.items.some((item) => item.kind === 'collection_change'), false);
          assert.equal(JSON.stringify(hiddenPage).includes(PUBLIC_TITLE), false);
          assert.equal(JSON.stringify(hiddenPage).includes(SECRET), false);
        } finally {
          await isolated.runtime.pool.query("update collections set visibility='public' where id=$1",
            [collectionId]);
        }
      }

      await isolated.runtime.pool.query(`with deleted_nodes as (
          update nodes set deleted_at=current_timestamp,deleted_commit_ordinal=1
           where collection_id=$1 returning id
        )
        update collections set deleted_at=current_timestamp
         where id=$1 and exists(select 1 from deleted_nodes)`, [collectionId]);
      try {
        const deleted = await app.inject({ method: 'GET', url: '/api/v1/feed',
          headers: { cookie: recipient.cookie } });
        const deletedAlias = await app.inject({ method: 'GET', url: '/api/v1/me/feed',
          headers: { cookie: recipient.cookie } });
        assert.equal(deleted.statusCode, 200, deleted.body);
        assert.equal(deletedAlias.statusCode, 200, deletedAlias.body);
        const deletedPage = deleted.json() as { items: Array<{ kind: string }> };
        assert.deepEqual(deleted.json().items, deletedAlias.json().items);
        assert.equal(deletedPage.items.some((item) => item.kind === 'collection_change'), false);
        assert.equal(JSON.stringify(deletedPage).includes(PUBLIC_TITLE), false);
        assert.equal(JSON.stringify(deletedPage).includes(SECRET), false);
      } finally {
        await isolated.runtime.pool.query(`with restored_nodes as (
            update nodes set deleted_at=null,deleted_commit_ordinal=null
             where collection_id=$1 returning id
          )
          update collections set deleted_at=null
           where id=$1 and exists(select 1 from restored_nodes)`, [collectionId]);
      }
    } finally { await app.close(); }
  });

  async function waitForNoFeedSelect() {
    await waitUntil(async () => Number((await isolated.runtime.pool.query<{ count: string }>(`
      select count(*)::text count from pg_stat_activity where pid <> pg_backend_pid()
        and query like '%from social_feed_items item%' and state='active'`)).rows[0]?.count ?? 1) === 0);
  }
});

async function waitUntil(predicate: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error('Feed PostgreSQL cancellation did not complete within budget');
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

function clientError(error: unknown, status: number, code: string): boolean {
  if (!error || typeof error !== 'object') return false;
  const value = error as { status?: unknown; problem?: { error?: { code?: unknown } } };
  return value.status === status && value.problem?.error?.code === code;
}

function assertFeedPageSchema(page: unknown): void {
  assert.ok(page && typeof page === 'object' && !Array.isArray(page));
  const value = page as Record<string, unknown>;
  assert.deepEqual(Object.keys(value).sort(), ['items', 'nextCursor']);
  assert.ok(Array.isArray(value.items)); assert.ok(value.items.length <= 100);
  assert.equal(value.nextCursor === null || typeof value.nextCursor === 'string', true);
  for (const raw of value.items) {
    assert.ok(raw && typeof raw === 'object' && !Array.isArray(raw));
    const item = raw as Record<string, unknown>;
    assert.deepEqual(Object.keys(item).sort(), ['actor', 'collectionId', 'collectionTitle',
      'feedItemId', 'kind', 'publicationSlug', 'publishedAt', 'summary']);
    assert.equal(typeof item.feedItemId, 'string');
    assert.ok(item.kind === 'collection_change' || item.kind === 'follow_activity');
    assert.equal(item.collectionId === null || typeof item.collectionId === 'string', true);
    assert.equal(item.collectionTitle === null || typeof item.collectionTitle === 'string', true);
    assert.equal(item.publicationSlug === null || typeof item.publicationSlug === 'string', true);
    assert.equal(item.summary === null || typeof item.summary === 'string', true);
    assert.equal(typeof item.publishedAt, 'string');
    assert.ok(item.actor && typeof item.actor === 'object' && !Array.isArray(item.actor));
    assert.deepEqual(Object.keys(item.actor as Record<string, unknown>).sort(),
      ['avatarUrl', 'displayName', 'handle', 'profileId']);
  }
}
