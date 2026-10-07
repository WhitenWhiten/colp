import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { afterAll, afterEach, beforeAll, test } from 'vitest';
import { sql } from 'kysely';
import { createProductNotificationClient } from '../../../generated/openapi/product-v1.client.js';
import { loadConfig } from '../../support/test-config.js';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import { createPostgresIdentityUnitOfWork } from '../../../src/infrastructure/identity/index.js';
import { createPostgresNotificationInboxQueryUnitOfWork,
  createPostgresNotificationPreferenceCommandUnitOfWork,
  createPostgresNotificationReadCommandUnitOfWork,
  getPostgresNotificationPreferences } from '../../../src/infrastructure/notifications/index.js';
import { createNotificationInboxCursorKeyring } from '../../../src/modules/notifications/index.js';
import { buildApiApp } from '../../../src/transport/app.js';
import { issueTestSession, type AuthenticatedTestClient } from '../../support/product-http-harness.js';
import { createPostgresBetterAuthTestFactory } from '../../support/better-auth-test-factory.js';
import { createIsolatedPostgresRuntime, describeWithPostgres,
  type IsolatedPostgresRuntime } from '../../support/postgres-test-runtime.js';

describeWithPostgres('P5-21 Notification Product HTTP', () => {
  const ORIGIN = 'https://app.example.test';
  const ISSUER = 'https://issuer.example.test/realms/known';
  let isolated: IsolatedPostgresRuntime;
  let factory: ReturnType<typeof createPostgresBetterAuthTestFactory>;
  let owner: AuthenticatedTestClient;
  let other: AuthenticatedTestClient;
  let config: ReturnType<typeof loadConfig>;
  const keys = { active: { id: 'notification-http', secret: Buffer.alloc(32, 41).toString('base64') }, retained: [] };

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('phase5_notification_http', { maxConnections: 8 });
    await runMigrations(isolated.runtime.db, 'latest');
    config = loadConfig({ DATABASE_URL: isolated.databaseUrl, PRODUCT_ORIGIN: ORIGIN,
      ALLOWED_ORIGINS: ORIGIN, OIDC_ISSUER: ISSUER, OIDC_CLIENT_ID: 'known-web',
      OIDC_REDIRECT_URI: `${ORIGIN}/api/v1/auth/oidc/callback`, OIDC_AUTHORIZATION_ENDPOINT: `${ISSUER}/auth`,
      OIDC_TOKEN_ENDPOINT: `${ISSUER}/token`, OIDC_ALLOW_TEST_PROVIDER: 'true', OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default', NODE_ENV: 'test',
      LOG_LEVEL: 'silent', KNOWN_FEATURE_NOTIFICATIONS: 'true' });
    const identity = createPostgresIdentityUnitOfWork(isolated.runtime.db);
    factory = createPostgresBetterAuthTestFactory({ db: isolated.runtime.db });
    owner = await issueTestSession({ factory,
      subject: `notification-owner-${randomUUID()}`, handle: `n${randomUUID().replaceAll('-', '').slice(0, 12)}` });
    other = await issueTestSession({ factory,
      subject: `notification-other-${randomUUID()}`, handle: `o${randomUUID().replaceAll('-', '').slice(0, 12)}` });
    for (const [id, account, subject] of [['owner-n1', owner.accountId, 'subject-owner'],
      ['owner-n2', owner.accountId, 'subject-owner-2'], ['other-secret', other.accountId, 'private-other-marker']] as const) {
      await isolated.runtime.pool.query(`insert into notifications(notification_id,recipient_account_id,
        notification_type,actor_profile_id,subject_type,subject_id,state,source_event_id,
        occurred_at,retain_until)
        values($1,$2,'collection_change',null,'collection',$3,'unread',$4,
          current_timestamp,current_timestamp+interval '365 days')`,
      [id, account, subject, `event-${id}`]);
    }
  }, 120_000);
  afterAll(async () => isolated?.close());
  // Restore the known preference baseline after every test (also on failure):
  // in_app enabled, email disabled, no suppression facts. Each test then starts
  // from the same state regardless of filtering, reversal, or shuffle order.
  afterEach(async () => {
    if (!isolated) return;
    await isolated.runtime.pool.query(`delete from notification_email_suppressions
      where recipient_account_id=$1`, [owner.accountId]);
    await isolated.runtime.pool.query(`insert into notification_preferences(
      recipient_account_id,channel,enabled) values($1,'in_app',true),($1,'email',false)
      on conflict(recipient_account_id,channel) do update set enabled=excluded.enabled,
        state_revision=notification_preferences.state_revision+1,updated_at=current_timestamp`,
    [owner.accountId]);
  });

  function composition(readOptions: Parameters<typeof createPostgresNotificationReadCommandUnitOfWork>[1] = {},
    timeoutMs?: number, emailRuntime?: { readonly verifiedSender: string | null; readonly emailAvailable: boolean }) {
    const cursors = createNotificationInboxCursorKeyring(keys);
    const appConfig = timeoutMs === undefined ? config : { ...config,
      notifications: { ...config.notifications!, timeoutMs } };
    const app = buildApiApp({ config: appConfig, identityUnitOfWork: createPostgresIdentityUnitOfWork(isolated.runtime.db), browserSessionAuthority: factory.authority,
      notificationQueryUnitOfWork: createPostgresNotificationInboxQueryUnitOfWork(isolated.runtime.db, cursors),
      notificationReadCommandUnitOfWork: createPostgresNotificationReadCommandUnitOfWork(isolated.runtime.db, readOptions),
      notificationPreferenceRead: getPostgresNotificationPreferences(isolated.runtime.db),
      notificationPreferenceCommandUnitOfWork: createPostgresNotificationPreferenceCommandUnitOfWork(isolated.runtime.db),
      ...(emailRuntime === undefined ? {} : { notificationEmailRuntime: emailRuntime }) });
    app.addHook('onClose', async () => cursors.destroy());
    return app;
  }

  test('generated client traverses private inbox and executes read and preference commands', async () => {
    const app = composition(); const address = await app.listen({ host: '127.0.0.1', port: 0 });
    try {
      const client = createProductNotificationClient({ origin: address, sessionCookie: owner.cookie,
        csrfToken: owner.csrfToken, originHeader: ORIGIN });
      const first = await client.notifications({ limit: 1 });
      assert.equal(first.unreadCount, 2); assert.equal(first.items.length, 1);
      assert.equal(JSON.stringify(first).includes('private-other-marker'), false);
      const second = await client.notifications({ cursor: first.nextCursor! });
      assert.equal(second.items.length, 1);
      const markCommandId = randomUUID();
      const marked = await client.markOne(first.items[0]!.notificationId,
        first.items[0]!.stateRevision, markCommandId);
      assert.ok('state' in marked); assert.equal(marked.state, 'read');
      assert.deepEqual(await client.markOne(first.items[0]!.notificationId,
        first.items[0]!.stateRevision, markCommandId), marked);
      await assert.rejects(() => client.markOne(second.items[0]!.notificationId,
        second.items[0]!.stateRevision, markCommandId),
      (error: unknown) => (error as { status?: number }).status === 409);
      const preferences = await client.preferences();
      assert.equal(preferences.channel, 'in_app');
      const preferenceCommandId = randomUUID();
      const updated = await client.updatePreference('in_app', { mode: 'set', enabled: false },
        preferences.revision, preferenceCommandId);
      assert.equal(updated.enabled, false);
      assert.deepEqual(await client.updatePreference('in_app', { mode: 'set', enabled: false },
        preferences.revision, preferenceCommandId), updated);
    } finally { await app.close(); }
  });

  test('email preference PUT persists to the authority and GET reflects both channels additively', async () => {
    const app = composition(undefined, undefined,
      { verifiedSender: 'no-reply@example.test', emailAvailable: true });
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    try {
      const client = createProductNotificationClient({ origin: address, sessionCookie: owner.cookie,
        csrfToken: owner.csrfToken, originHeader: ORIGIN });
      // The shared afterEach baseline restores in_app=true and email=false
      // before every test, so this test starts from a known state and the email
      // toggle below is provably the only channel it touches.
      const before = await client.preferences();
      assert.equal(before.channel, 'in_app');
      assert.equal(before.enabled, true);
      // Additive email status rides on the same GET; old fields remain readable.
      assert.equal(before.email?.verifiedSender, 'no-reply@example.test');
      assert.equal(before.email?.emailAvailable, true);
      assert.equal(before.email?.emailSuppressed, false);
      assert.equal(before.email?.enabled, false);

      const emailCommandId = randomUUID();
      const enabled = await client.updatePreference('email', { mode: 'set', enabled: true },
        before.email!.revision, emailCommandId);
      assert.equal(enabled.channel, 'email');
      assert.equal(enabled.enabled, true);
      assert.notEqual(enabled.revision, before.email!.revision);
      const authority = (await isolated.runtime.pool.query(
        `select enabled, state_revision::text revision from notification_preferences
         where recipient_account_id=$1 and channel='email'`, [owner.accountId])).rows[0];
      assert.deepEqual(authority, { enabled: true, revision: enabled.revision });

      // Refresh keeps the email channel state; in-app authority is untouched by the email toggle.
      const after = await client.preferences();
      assert.equal(after.email?.enabled, true);
      assert.equal(after.email?.revision, enabled.revision);
      assert.equal(after.enabled, true);
      assert.equal(after.revision, before.revision);

      const resetCommandId = randomUUID();
      const reset = await client.updatePreference('email', { mode: 'reset' },
        after.email!.revision, resetCommandId);
      assert.equal(reset.enabled, false);
      const resetAuthority = (await isolated.runtime.pool.query(
        `select enabled, state_revision::text revision from notification_preferences
         where recipient_account_id=$1 and channel='email'`, [owner.accountId])).rows[0];
      assert.deepEqual(resetAuthority, { enabled: false, revision: reset.revision });
    } finally { await app.close(); }
  });

  test('diverged channel revisions: GET to PUT email succeeds on the published email validator only', async () => {
    const app = composition(undefined, undefined,
      { verifiedSender: 'no-reply@example.test', emailAvailable: true });
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    try {
      const client = createProductNotificationClient({ origin: address, sessionCookie: owner.cookie,
        csrfToken: owner.csrfToken, originHeader: ORIGIN });
      const before = await client.preferences();
      // Force the in-app revision ahead of email so the two channels diverge:
      // the flip advances the in-app revision and leaves the email revision untouched.
      await client.updatePreference('in_app', { mode: 'set', enabled: !before.enabled },
        before.revision, randomUUID());
      const diverged = await client.preferences();
      assert.notEqual(diverged.revision, before.revision);
      assert.equal(diverged.email!.revision, before.email!.revision);
      // Standard GET -> PUT email using only the server-published email
      // validator (email.revision from the GET body) succeeds once diverged.
      const emailCommandId = randomUUID();
      const updated = await client.updatePreference('email', { mode: 'set',
        enabled: !diverged.email!.enabled }, diverged.email!.revision, emailCommandId);
      assert.equal(updated.channel, 'email');
      assert.equal(updated.enabled, !diverged.email!.enabled);
      assert.equal(updated.revision, String(BigInt(diverged.email!.revision) + 1n));
      // Exact replay of the same email command stays exact.
      assert.deepEqual(await client.updatePreference('email', { mode: 'set',
        enabled: !diverged.email!.enabled }, diverged.email!.revision, emailCommandId), updated);

      // The aggregate GET ETag is a whole-representation cache validator only.
      const aggregateEtag = `"notification-preferences:all:${diverged.revision}"`;
      const rawGet = await fetch(`${address}/api/v1/notification-preferences`,
        { headers: { Cookie: owner.cookie } });
      assert.equal(rawGet.status, 200);
      assert.equal(rawGet.headers.get('etag'), aggregateEtag);
      const putEmail = (ifMatch: string) => fetch(`${address}/api/v1/notification-preferences/email`, {
        method: 'PUT',
        headers: { Cookie: owner.cookie, Origin: ORIGIN, 'X-CSRF-Token': owner.csrfToken,
          'Known-Command-Id': randomUUID(), 'If-Match': ifMatch,
          'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'set', enabled: true }) });
      // Neither the in_app validator, the legacy aggregate validator, nor the
      // aggregate GET ETag may be replayed onto the email channel.
      assert.equal((await putEmail(`"notification-preference:in_app:${diverged.revision}"`)).status, 400);
      assert.equal((await putEmail(`"notification-preference:${diverged.email!.revision}"`)).status, 400);
      assert.equal((await putEmail(aggregateEtag)).status, 400);
      const authority = (await isolated.runtime.pool.query(
        `select enabled from notification_preferences
         where recipient_account_id=$1 and channel='email'`, [owner.accountId])).rows[0];
      assert.equal(authority.enabled, updated.enabled);

      // The legacy aggregate validator remains accepted for in_app during the
      // compatibility window (it was derived from the in_app revision).
      const legacyInApp = await fetch(`${address}/api/v1/notification-preferences/in_app`, {
        method: 'PUT',
        headers: { Cookie: owner.cookie, Origin: ORIGIN, 'X-CSRF-Token': owner.csrfToken,
          'Known-Command-Id': randomUUID(), 'If-Match': `"notification-preference:${diverged.revision}"`,
          'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'reset' }) });
      assert.equal(legacyInApp.status, 200, await legacyInApp.text());
      // Reset via the server-published email validator: returns to the disabled
      // baseline with an exact revision bump. The shared afterEach restores the
      // baseline even when this test fails mid-flight.
      const restored = await client.updatePreference('email', { mode: 'reset' },
        updated.revision, randomUUID());
      assert.equal(restored.enabled, false);
      assert.equal(restored.revision, String(BigInt(updated.revision) + 1n));
    } finally { await app.close(); }
  });

  test('stale email revision fails closed and other principals never see email suppression facts', async () => {
    const app = composition(undefined, undefined,
      { verifiedSender: 'no-reply@example.test', emailAvailable: true });
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    try {
      const client = createProductNotificationClient({ origin: address, sessionCookie: owner.cookie,
        csrfToken: owner.csrfToken, originHeader: ORIGIN });
      const currentEmailRevision = (await client.preferences()).email!.revision;
      await client.updatePreference('email', { mode: 'set', enabled: true },
        currentEmailRevision, randomUUID());
      await assert.rejects(() => client.updatePreference('email', { mode: 'set', enabled: true },
        currentEmailRevision, randomUUID()), (error: unknown) => (error as { status?: number }).status === 412);

      await isolated.runtime.pool.query(`insert into notification_email_suppressions(
        recipient_account_id,source,occurred_at) values($1,'unsubscribe',current_timestamp)`,
      [owner.accountId]);
      const ownerView = await client.preferences();
      assert.equal(ownerView.email?.emailSuppressed, true);
      const otherClient = createProductNotificationClient({ origin: address, sessionCookie: other.cookie,
        csrfToken: other.csrfToken, originHeader: ORIGIN });
      const otherView = await otherClient.preferences();
      assert.equal(otherView.email?.emailSuppressed, false);
    } finally { await app.close(); }
  });

  test('email channel reports unavailable when the provider runtime is absent (never fake-usable)', async () => {
    const app = composition(); const address = await app.listen({ host: '127.0.0.1', port: 0 });
    try {
      const client = createProductNotificationClient({ origin: address, sessionCookie: owner.cookie,
        csrfToken: owner.csrfToken, originHeader: ORIGIN });
      const preferences = await client.preferences();
      assert.equal(preferences.email?.emailAvailable, false);
      assert.equal(preferences.email?.verifiedSender, null);
      // The in-app channel remains fully usable while email is unavailable.
      const updated = await client.updatePreference('in_app', { mode: 'set', enabled: false },
        preferences.revision, randomUUID());
      assert.equal(updated.enabled, false);
      const after = await client.preferences();
      assert.equal(after.email?.emailAvailable, false);
      assert.equal(after.enabled, false);
    } finally { await app.close(); }
  });

  test('two generated clients cannot observe or mutate the other account inbox', async () => {
    const app = composition(); const address = await app.listen({ host: '127.0.0.1', port: 0 });
    try {
      const ownerClient = createProductNotificationClient({ origin: address, sessionCookie: owner.cookie,
        csrfToken: owner.csrfToken, originHeader: ORIGIN });
      const otherClient = createProductNotificationClient({ origin: address, sessionCookie: other.cookie,
        csrfToken: other.csrfToken, originHeader: ORIGIN });
      assert.equal((await otherClient.notifications()).items[0]!.notificationId, 'other-secret');
      const concealed = await ownerClient.markOne('other-secret', '0', randomUUID());
      assert.equal(concealed.changed, false);
      assert.equal((await otherClient.notifications()).unreadCount, 1);
    } finally { await app.close(); }
  });

  test('a real client disconnect before commit rolls back Notification, receipt, and Audit writes', async () => {
    const notificationId = `abort-${randomUUID()}`;
    await isolated.runtime.pool.query(`insert into notifications(notification_id,recipient_account_id,
      notification_type,subject_type,subject_id,source_event_id,occurred_at,retain_until)
      values($1,$2,'collection_change','collection','abort-subject',$3,current_timestamp,
        current_timestamp+interval '365 days')`, [notificationId, owner.accountId, `event-${notificationId}`]);
    const auditBaseline = Number((await isolated.runtime.pool.query(`select count(*)::int count from audit_events
      where principal_id=$1 and event_type='notification.read_state_command'`, [owner.accountId])).rows[0].count);
    let reached!: () => void; const beforeCommit = new Promise<void>((resolve) => { reached = resolve; });
    let release!: () => void; const held = new Promise<void>((resolve) => { release = resolve; });
    const app = composition({ transactionFaultInjector: { async afterCallbackBeforeCommit() {
      reached(); await held;
    } } });
    let observed!: () => void;
    const serverObservedDisconnect = new Promise<void>((resolve) => { observed = resolve; });
    app.addHook('onRequest', async (request) => {
      if (request.url === `/api/v1/notifications/${notificationId}/read`) {
        request.raw.socket.once('close', observed);
      }
    });
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const url = new URL(`/api/v1/notifications/${notificationId}/read`, address);
    const commandId = randomUUID();
    const requestClosed = new Promise<void>((resolve) => {
      const outgoing = httpRequest(url, { method: 'PUT', headers: { Cookie: owner.cookie,
        Origin: ORIGIN, 'X-CSRF-Token': owner.csrfToken, 'Known-Command-Id': commandId,
        'If-Match': '"notification:0"' } });
      outgoing.once('error', () => resolve());
      outgoing.end();
      void beforeCommit.then(() => outgoing.destroy());
    });
    try {
      await beforeCommit; await requestClosed; await serverObservedDisconnect; release();
      for (let attempt = 0; attempt < 50; attempt += 1) {
        const row = (await isolated.runtime.pool.query(`select
          (select state from notifications where notification_id=$1) state,
          (select count(*)::int from product_command_receipts where principal_id=$2 and command_id=$3) receipts,
          (select count(*)::int from audit_events where principal_id=$2
            and event_type='notification.read_state_command') audits`,
        [notificationId, owner.accountId, commandId])).rows[0];
        if (row.state === 'unread' && row.receipts === 0 && row.audits === auditBaseline) return;
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      assert.fail('aborted Notification command did not roll back before the verification deadline');
    } finally { release(); await app.close(); }
  });

  test('HTTP timeout cancels an in-flight PostgreSQL command and leaves no durable writes', async () => {
    const notificationId = `timeout-${randomUUID()}`;
    await isolated.runtime.pool.query(`insert into notifications(notification_id,recipient_account_id,
      notification_type,subject_type,subject_id,source_event_id,occurred_at,retain_until)
      values($1,$2,'collection_change','collection','timeout-subject',$3,current_timestamp,
        current_timestamp+interval '365 days')`, [notificationId, owner.accountId, `event-${notificationId}`]);
    const app = composition({ transactionFaultInjector: { async beforeCallback(transaction) {
      await sql`select pg_sleep(10)`.execute(transaction);
    } } }, 50);
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const commandId = randomUUID(); const started = Date.now();
    try {
      const client = createProductNotificationClient({ origin: address, sessionCookie: owner.cookie,
        csrfToken: owner.csrfToken, originHeader: ORIGIN });
      await assert.rejects(() => client.markOne(notificationId, '0', commandId),
        (error: unknown) => (error as { status?: number }).status === 503);
      assert.ok(Date.now() - started < 2_000, 'PostgreSQL cancellation exceeded the HTTP timeout budget');
      const row = (await isolated.runtime.pool.query(`select
        (select state from notifications where notification_id=$1) state,
        (select count(*)::int from product_command_receipts where principal_id=$2 and command_id=$3) receipts`,
      [notificationId, owner.accountId, commandId])).rows[0];
      assert.deepEqual(row, { state: 'unread', receipts: 0 });
    } finally { await app.close(); }
  });

  test('frozen Phase 5 /me aliases share the successor Notification handlers and shapes', async () => {
    const app = composition(); const address = await app.listen({ host: '127.0.0.1', port: 0 });
    try {
      const client = createProductNotificationClient({ origin: address, sessionCookie: owner.cookie,
        csrfToken: owner.csrfToken, originHeader: ORIGIN });
      const unread = await client.myNotifications({ read: false, limit: 1 });
      assert.equal(unread.items.length, 1);
      assert.ok(Number.isInteger(unread.unreadCount));
      assert.deepEqual(Object.keys(unread).sort(), ['items', 'nextCursor', 'unreadCount']);
      const item = unread.items[0]!;
      assert.deepEqual(Object.keys(item).sort(),
        ['actor', 'collectionId', 'createdAt', 'kind', 'notificationId', 'readAt']);
      assert.equal(item.kind, 'followed_collection_changed');
      assert.equal(item.actor, null);
      assert.equal(item.readAt, null);
      assert.equal(typeof item.createdAt, 'string');
      const read = await client.myNotifications({ read: true, limit: 1 });
      assert.equal(read.items.length, 1);
      assert.equal(typeof read.items[0]!.readAt, 'string');

      const commandId = randomUUID();
      const marked = await client.markMyNotificationsRead([item.notificationId], commandId);
      assert.deepEqual(marked.notificationIds, [item.notificationId]);
      assert.ok(Number.isFinite(Date.parse(marked.readAt)));
      // Exact replay of the same command keeps the frozen shape and IDs; the
      // readAt projection is re-derived from the authoritative clock at replay.
      const replayed = await client.markMyNotificationsRead([item.notificationId], commandId);
      assert.deepEqual(replayed.notificationIds, [item.notificationId]);
      assert.ok(Number.isFinite(Date.parse(replayed.readAt)));

      const initial = await client.myNotificationPreferences();
      assert.deepEqual(Object.keys(initial).sort(),
        ['inAppFollowedCollectionChanged', 'inAppNewFollower', 'revision']);
      assert.equal(initial.inAppNewFollower, initial.inAppFollowedCollectionChanged);
      const updated = await client.updateMyNotificationPreferences({
        revision: initial.revision, inAppNewFollower: !initial.inAppNewFollower,
        inAppFollowedCollectionChanged: !initial.inAppFollowedCollectionChanged }, randomUUID());
      assert.equal(updated.inAppNewFollower, !initial.inAppNewFollower);
      assert.equal(updated.inAppFollowedCollectionChanged, updated.inAppNewFollower);
      assert.equal(updated.revision !== initial.revision, true);
      const after = await client.myNotificationPreferences();
      assert.equal(after.inAppNewFollower, updated.inAppNewFollower);
    } finally { await app.close(); }
  });

  test('successor inbox JSON carries locators while frozen /me keeps the old item key set', async () => {
    const actorHandle = `a${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const actor = await issueTestSession({ factory,
      subject: `notification-locator-actor-${randomUUID()}`,
      handle: actorHandle,
      displayName: 'Inbox Actor' });
    const collectionId = `http-locator-${randomUUID()}`;
    const slug = `loc-${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const notificationId = `http-loc-${randomUUID()}`;
    const rootId = `root-${collectionId}`;
    const client = await isolated.runtime.pool.connect();
    try {
      await client.query('begin');
      await client.query(`insert into resource_id_ledger(resource_id,resource_type,committed_at)
        values($1,'collection',current_timestamp),($2,'node',current_timestamp)`, [collectionId, rootId]);
      await client.query(`insert into collections(
        id,owner_subject_id,title,kind,visibility,publication_slug,published_at,
        root_node_id,root_node_is_root,resource_revision,content_revision,policy_revision,
        commit_ordinal,created_at,updated_at)
        values($1,$2,'HTTP Locator Title','bookmarks','public',$3,current_timestamp,$4,true,
          'r1','c1','p1',1,current_timestamp,current_timestamp)`,
      [collectionId, actor.subjectId, slug, rootId]);
      await client.query(`insert into nodes(
        id,collection_id,parent_id,kind,is_root,title,url,position_token,
        resource_revision,children_revision,created_at,updated_at)
        values($1,$2,null,'folder',true,'Root',null,null,'r1','ch1',
          current_timestamp,current_timestamp)`, [rootId, collectionId]);
      await client.query('commit');
    } catch (error: unknown) {
      await client.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    await isolated.runtime.pool.query(`insert into notifications(notification_id,recipient_account_id,
      notification_type,actor_profile_id,subject_type,subject_id,state,source_event_id,
      occurred_at,retain_until)
      values($1,$2,'collection_change',$3,'collection',$4,'unread',$5,
        current_timestamp,current_timestamp+interval '365 days')`,
    [notificationId, owner.accountId, actor.accountId, collectionId, `event-${notificationId}`]);
    const app = composition(); const address = await app.listen({ host: '127.0.0.1', port: 0 });
    try {
      const successorRes = await fetch(`${address}/api/v1/notifications?limit=100`,
        { headers: { Cookie: owner.cookie } });
      assert.equal(successorRes.status, 200);
      const successor = await successorRes.json() as { items: Array<Record<string, unknown>> };
      const item = successor.items.find((row) => row.notificationId === notificationId);
      assert.ok(item);
      assert.equal((item.subject as { id: string }).id, collectionId);
      assert.equal(item.collectionTitle, 'HTTP Locator Title');
      assert.equal(item.publicationSlug, slug);
      assert.equal(item.actorHandle, actorHandle);
      assert.equal(item.actorDisplayName, 'Inbox Actor');
      assert.equal(item.summary, 'public_collection_updated');
      for (const name of ['actorHandle', 'actorDisplayName', 'collectionTitle', 'publicationSlug', 'summary']) {
        assert.equal(Object.hasOwn(item, name), true, name);
      }
      const frozenRes = await fetch(`${address}/api/v1/me/notifications?limit=100`,
        { headers: { Cookie: owner.cookie } });
      assert.equal(frozenRes.status, 200);
      const frozen = await frozenRes.json() as { items: Array<Record<string, unknown>> };
      const frozenItem = frozen.items.find((row) => row.notificationId === notificationId);
      assert.ok(frozenItem);
      assert.deepEqual(Object.keys(frozenItem).sort(),
        ['actor', 'collectionId', 'createdAt', 'kind', 'notificationId', 'readAt']);
      assert.equal(frozenItem.collectionId, collectionId);
      for (const name of ['actorHandle', 'publicationSlug', 'collectionTitle', 'summary']) {
        assert.equal(Object.hasOwn(frozenItem, name), false, name);
      }
      assert.equal(JSON.stringify(frozen).includes('HTTP Locator Title'), false);
      assert.equal(JSON.stringify(frozen).includes(slug), false);

      await isolated.runtime.pool.query(`update collections set visibility='private' where id=$1`,
        [collectionId]);
      const afterRes = await fetch(`${address}/api/v1/notifications?limit=100`,
        { headers: { Cookie: owner.cookie } });
      const after = (await afterRes.json() as { items: Array<Record<string, unknown>> })
        .items.find((row) => row.notificationId === notificationId);
      assert.ok(after);
      assert.equal((after.subject as { id: string }).id, collectionId);
      assert.equal(after.collectionTitle, null);
      assert.equal(after.publicationSlug, null);
      assert.equal(after.summary, null);
      const count = Number((await isolated.runtime.pool.query(
        `select count(*)::int count from notifications where notification_id=$1`,
        [notificationId])).rows[0].count);
      assert.equal(count, 1);
    } finally { await app.close(); }
  });
});
