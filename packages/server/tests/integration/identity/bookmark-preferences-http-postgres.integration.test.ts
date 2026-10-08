import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { afterAll, beforeAll, beforeEach, test } from 'vitest';
import { createMigrator, runMigrations, type DatabaseRuntime } from '../../../src/infrastructure/database/index.js';
import {
  createPostgresBookmarkPreferencesQuery,
  createPostgresBookmarkPreferencesUnitOfWork,
  createPostgresIdentityUnitOfWork,
} from '../../../src/infrastructure/identity/index.js';
import {
  createSession,
  ensureAccountFromOidcIdentity,
  type IdentityUnitOfWork,
} from '../../../src/modules/identity/index.js';
import { installProductAdmission, parseStrictQuery } from '../../../src/transport/product-admission.js';
import { ProductHttpError, sendProductError } from '../../../src/transport/product-error.js';
import { installProductRouteManifestChecks } from '../../../src/transport/product-route-manifest.js';
import { registerBookmarkPreferencesRoutes } from '../../../src/transport/product/bookmark-preferences-routes.js';
import { SESSION_COOKIE_NAME } from '../../../src/transport/session-cookie.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  truncateFixtureTables,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';

const ORIGIN = 'https://app.example.test';

interface Client {
  readonly cookie: string;
  readonly csrfToken: string;
  readonly sessionId: string;
}

describeWithPostgres('bookmark preference Product HTTP with PostgreSQL', () => {
  let isolated: IsolatedPostgresRuntime;
  let runtime: DatabaseRuntime;
  let identity: IdentityUnitOfWork;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('bookmark_preferences');
    runtime = isolated.runtime;
    await runMigrations(runtime.db, 'latest');
    identity = createPostgresIdentityUnitOfWork(runtime.db);
  }, 120_000);

  beforeEach(async () => {
    await truncateFixtureTables(runtime.pool, `truncate table bookmark_preferences, product_command_receipts,
      sessions, oidc_login_transactions, account_identities, profile_handles, profiles, accounts cascade`);
  });

  afterAll(async () => isolated?.close());

  test('upgrades the existing main migration head before enabling preference writes', async () => {
    const upgrade = await createIsolatedPostgresRuntime('bookmark_preferences_main_upgrade');
    try {
      const migrator = createMigrator(upgrade.runtime.db, 'migrations', upgrade.schema);
      const previous = await migrator.migrateTo('202610101300_credit_integrity_aggregates');
      if (previous.error) throw previous.error;
      const before = await upgrade.runtime.pool.query<{ present: boolean }>(
        "select to_regclass('bookmark_preferences') is not null as present");
      assert.equal(before.rows[0]?.present, false);
      const upgraded = await migrator.migrateTo('202610101500_automatic_capture_preferences');
      if (upgraded.error) throw upgraded.error;
      assert.deepEqual(upgraded.results?.map(row => [row.migrationName, row.status]),
        [['202610101400_bookmark_preferences', 'Success'], ['202610101500_automatic_capture_preferences', 'Success']]);
      const after = await upgrade.runtime.pool.query<{ count: string }>('select count(*)::text as count from bookmark_preferences');
      assert.equal(after.rows[0]?.count, '0');
      const current = await migrator.migrateToLatest();
      if (current.error) throw current.error;
      const repeated = await migrator.migrateToLatest();
      if (repeated.error) throw repeated.error;
      assert.deepEqual(repeated.results, []);
    } finally { await upgrade.close(); }
  });

  function app() {
    const server = Fastify({
      exposeHeadRoutes: false,
      routerOptions: { querystringParser: parseStrictQuery },
    });
    installProductRouteManifestChecks(server, { requireComplete: false });
    installProductAdmission(server);
    server.setErrorHandler((error, request, reply) => sendProductError(
      request,
      reply,
      error instanceof ProductHttpError
        ? error
        : new ProductHttpError({ statusCode: 500, code: 'internal_error', message: 'test failure' }),
    ));
    registerBookmarkPreferencesRoutes(server, {
      identityUnitOfWork: identity,
      allowedOrigins: [ORIGIN],
      queryStore: createPostgresBookmarkPreferencesQuery(runtime.db),
      commandUnitOfWork: createPostgresBookmarkPreferencesUnitOfWork(runtime.db),
    });
    return server;
  }

  async function issue(suffix: string): Promise<Client> {
    const value = await identity.execute(async (ports) => {
      const ensured = await ensureAccountFromOidcIdentity(ports, {
        issuer: 'https://issuer.example.test',
        subject: `bookmark-pref-${suffix}`,
        email: `bookmark-pref-${suffix}@example.test`,
        displayName: `Bookmark ${suffix}`,
        handle: `bookmark-${suffix}`,
      });
      const session = await createSession(ports, { accountId: ensured.account.id });
      return session;
    });
    return {
      cookie: `${SESSION_COOKIE_NAME}=${encodeURIComponent(value.rawSessionToken)}`,
      csrfToken: value.rawCsrfToken,
      sessionId: value.session.id,
    };
  }

  function mutation(client: Client, commandId: string, ifMatch = '"0"') {
    return {
      cookie: client.cookie,
      origin: ORIGIN,
      'x-csrf-token': client.csrfToken,
      'known-command-id': commandId,
      'if-match': ifMatch,
      'content-type': 'application/json',
    };
  }

  test('isolates account defaults and persisted values', async () => {
    const server = app();
    const [left, right] = await Promise.all([issue('left'), issue('right')]);
    const leftWrite = await server.inject({
      method: 'PATCH', url: '/api/v1/me/bookmark-preferences',
      headers: mutation(left, crypto.randomUUID()),
      payload: { bookmarkInsertPosition: 'top', foldersFirst: false },
    });
    assert.equal(leftWrite.statusCode, 200, leftWrite.body);
    const [leftRead, rightRead] = await Promise.all([
      server.inject({ method: 'GET', url: '/api/v1/me/bookmark-preferences', headers: { cookie: left.cookie } }),
      server.inject({ method: 'GET', url: '/api/v1/me/bookmark-preferences', headers: { cookie: right.cookie } }),
    ]);
    assert.equal(leftRead.headers['known-bookmark-session'], left.sessionId);
    assert.equal(rightRead.headers['known-bookmark-session'], right.sessionId);
    assert.notEqual(left.sessionId, right.sessionId);
    assert.deepEqual(leftRead.json(), {
      bookmarkInsertPosition: 'top', foldersFirst: false, revision: '1', captureMode: 'manual', resultPanelAutoDismissMs: 3000, learnFromCorrections: true, resumeClassificationWhenOnline: true, aiTagMode: 'suggest',
      subscriptionOnUnfollow: 'keep', subscriptionOnUnsubscribe: 'keep', subscriptionDefaultCheckIntervalMinutes: 15, subscriptionDefaultDigestMode: 'latest', subscriptionDefaultEditionLimit: 10,
      updatedAt: leftRead.json<{ updatedAt: string }>().updatedAt,
    });
    assert.deepEqual(rightRead.json(), {
      bookmarkInsertPosition: 'bottom', foldersFirst: false, revision: '0', captureMode: 'manual', resultPanelAutoDismissMs: 3000, learnFromCorrections: true, resumeClassificationWhenOnline: true, aiTagMode: 'suggest',
      subscriptionOnUnfollow: 'keep', subscriptionOnUnsubscribe: 'keep', subscriptionDefaultCheckIntervalMinutes: 15, subscriptionDefaultDigestMode: 'latest', subscriptionDefaultEditionLimit: 10,
      updatedAt: rightRead.json<{ updatedAt: string }>().updatedAt,
    });
    await server.close();
  });

  test('fences concurrent first writes and replays only the exact command', async () => {
    const server = app();
    const client = await issue('race');
    const firstCommand = crypto.randomUUID();
    const secondCommand = crypto.randomUUID();
    const firstDocument = { bookmarkInsertPosition: 'top' as const, foldersFirst: false };
    const secondDocument = { bookmarkInsertPosition: 'bottom' as const, foldersFirst: false };
    const [first, second] = await Promise.all([
      server.inject({ method: 'PATCH', url: '/api/v1/me/bookmark-preferences',
        headers: mutation(client, firstCommand), payload: firstDocument }),
      server.inject({ method: 'PATCH', url: '/api/v1/me/bookmark-preferences',
        headers: mutation(client, secondCommand), payload: secondDocument }),
    ]);
    assert.deepEqual([first.statusCode, second.statusCode].sort(), [200, 412]);
    const winner = first.statusCode === 200
      ? { response: first, commandId: firstCommand, document: firstDocument }
      : { response: second, commandId: secondCommand, document: secondDocument };
    const replay = await server.inject({
      method: 'PATCH', url: '/api/v1/me/bookmark-preferences',
      headers: mutation(client, winner.commandId), payload: winner.document,
    });
    assert.equal(replay.statusCode, 200, replay.body);
    assert.equal(replay.body, winner.response.body);
    assert.equal(replay.headers.etag, winner.response.headers.etag);
    assert.equal(replay.headers['known-bookmark-session'], client.sessionId);
    const reused = await server.inject({
      method: 'PATCH', url: '/api/v1/me/bookmark-preferences',
      headers: mutation(client, winner.commandId, '"1"'), payload: { foldersFirst: true },
    });
    assert.equal(reused.statusCode, 409, reused.body);
    assert.equal(reused.json<{ error: { code: string } }>().error.code, 'command_id_reused');
    const count = await runtime.pool.query<{ count: string }>('select count(*)::text as count from bookmark_preferences');
    assert.equal(count.rows[0]?.count, '1');
    await server.close();
  });
  test('stores subscription policy fields while legacy updates retain manual-only polling', async () => {
    const server = app();
    try {
      const client = await issue('subscription');
      const first = await server.inject({ method: 'PATCH', url: '/api/v1/me/bookmark-preferences',
        headers: mutation(client, crypto.randomUUID()), payload: { subscriptionOnUnfollow: 'remove',
          subscriptionOnUnsubscribe: 'remove', subscriptionDefaultCheckIntervalMinutes: null,
          subscriptionDefaultDigestMode: 'recent', subscriptionDefaultEditionLimit: 20 } });
      assert.equal(first.statusCode, 200, first.body);
      const legacy = await server.inject({ method: 'PATCH', url: '/api/v1/me/bookmark-preferences',
        headers: mutation(client, crypto.randomUUID(), '"1"'), payload: { foldersFirst: false } });
      assert.equal(legacy.statusCode, 200, legacy.body);
      assert.equal(legacy.json().subscriptionDefaultCheckIntervalMinutes, null);
      const row = await runtime.pool.query('select subscription_on_unfollow, subscription_on_unsubscribe, subscription_default_check_interval_minutes, subscription_default_digest_mode, subscription_default_edition_limit from bookmark_preferences');
      assert.deepEqual(row.rows[0], { subscription_on_unfollow: 'remove', subscription_on_unsubscribe: 'remove',
        subscription_default_check_interval_minutes: null, subscription_default_digest_mode: 'recent', subscription_default_edition_limit: 20 });
    } finally { await server.close(); }
  });

});
