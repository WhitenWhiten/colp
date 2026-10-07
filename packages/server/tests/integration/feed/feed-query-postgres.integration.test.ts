import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, test } from 'vitest';
import { buildWorker } from '../../../src/bootstrap/worker.js';
import { loadConfig } from '../../support/test-config.js';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import { createPostgresCanonicalMutationUnitOfWork, createPostgresCollectionsUnitOfWork } from '../../../src/infrastructure/collections/index.js';
import { createPostgresIdentityUnitOfWork } from '../../../src/infrastructure/identity/index.js';
import { createPostgresFeedPageReadPort, createPostgresFollowCommandUnitOfWork,
  createPostgresFollowQueryUnitOfWork } from '../../../src/infrastructure/social/index.js';
import { createFeedCursorKeyring, createFollowCursorKeyring, queryCurrentFeed } from '../../../src/modules/social/index.js';
import { buildApiApp } from '../../../src/transport/app.js';
import { authenticatedMutationHeaders, issueTestSession,
  type AuthenticatedTestClient } from '../../support/product-http-harness.js';
import { createPostgresBetterAuthTestFactory } from '../../support/better-auth-test-factory.js';
import { createIsolatedPostgresRuntime, describeWithPostgres,
  type IsolatedPostgresRuntime } from '../../support/postgres-test-runtime.js';

describeWithPostgres('P5-12 current-authorized Feed query', () => {
  const ORIGIN = 'https://app.example.test';
  const ISSUER = 'https://issuer.example.test/realms/known';
  const PRIVATE_MARKER = 'feed-query-private-secret-marker';
  const PUBLIC_TITLE = 'Feed Query Public Collection';
  const PUBLIC_SLUG = 'feed-query-public';
  const FEED_ITEM_KEYS = ['actor', 'collectionId', 'collectionTitle', 'feedItemId', 'kind',
    'publicationSlug', 'publishedAt', 'summary'];
  let isolated: IsolatedPostgresRuntime;
  let identity: ReturnType<typeof createPostgresIdentityUnitOfWork>;
  let factory: ReturnType<typeof createPostgresBetterAuthTestFactory>;
  let recipient: AuthenticatedTestClient;
  let actor: AuthenticatedTestClient;
  let collection: { id: string; etag: string };
  let application: ReturnType<typeof buildApiApp>;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('phase5_feed_query', { maxConnections: 6 });
    await runMigrations(isolated.runtime.db, 'latest');
    const config = loadConfig({ DATABASE_URL: isolated.databaseUrl, PRODUCT_ORIGIN: ORIGIN,
      ALLOWED_ORIGINS: ORIGIN, OIDC_ISSUER: ISSUER, OIDC_CLIENT_ID: 'known-web',
      OIDC_REDIRECT_URI: `${ORIGIN}/api/v1/auth/oidc/callback`, OIDC_AUTHORIZATION_ENDPOINT: `${ISSUER}/auth`,
      OIDC_TOKEN_ENDPOINT: `${ISSUER}/token`, OIDC_ALLOW_TEST_PROVIDER: 'true', OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default', NODE_ENV: 'test',
      LOG_LEVEL: 'silent', KNOWN_FEATURE_FOLLOW: 'true', FOLLOW_CURSOR_ACTIVE_KEY_ID: 'follow-query',
      FOLLOW_CURSOR_ACTIVE_SECRET: Buffer.alloc(32, 8).toString('base64') });
    identity = createPostgresIdentityUnitOfWork(isolated.runtime.db);
    factory = createPostgresBetterAuthTestFactory({ db: isolated.runtime.db });
    recipient = await issueTestSession({ factory,
      subject: 'feed-query-recipient', handle: 'feed-query-recipient' });
    actor = await issueTestSession({ factory,
      subject: 'feed-query-actor', handle: 'feed-query-actor' });
    const followCursors = createFollowCursorKeyring(config.follow!.cursorKeys);
    application = buildApiApp({ config, identityUnitOfWork: identity, browserSessionAuthority: factory.authority,
      collectionsUnitOfWork: createPostgresCollectionsUnitOfWork(isolated.runtime.db),
      productCollectionMutationUnitOfWork: createPostgresCanonicalMutationUnitOfWork(isolated.runtime.db),
      followCommandUnitOfWork: createPostgresFollowCommandUnitOfWork(isolated.runtime.db),
      followQueryUnitOfWork: createPostgresFollowQueryUnitOfWork(isolated.runtime.db, followCursors) });
    const created = await application.inject({ method: 'POST', url: '/api/v1/collections',
      headers: mutationHeaders(actor, randomUUID(), 'application/json'),
      payload: { kind: 'bookmarks', title: PUBLIC_TITLE, summary: PRIVATE_MARKER } });
    assert.equal(created.statusCode, 201, created.body);
    const createdBody = created.json() as { collection: { id: string; etag: string } };
    const followed = await application.inject({ method: 'PUT',
      url: `/api/v1/profiles/${actor.accountId}/follow`,
      headers: mutationHeaders(recipient, randomUUID()) });
    assert.equal(followed.statusCode, 200, followed.body);
    const published = await patchCollection({ ...createdBody.collection }, { visibility: 'public',
      publicationSlug: PUBLIC_SLUG });
    assert.equal(published.statusCode, 200, published.body);
    collection = (published.json() as { collection: { id: string; etag: string } }).collection;
  }, 120_000);
  afterAll(async () => { await application?.close(); await isolated?.close(); });

  function mutationHeaders(client: AuthenticatedTestClient, commandId: string,
    contentType?: string) {
    return contentType ? authenticatedMutationHeaders({ client, origin: ORIGIN, contentType,
      extra: { 'known-command-id': commandId } }) : { cookie: client.cookie, origin: ORIGIN,
      'x-csrf-token': client.csrfToken, 'known-command-id': commandId };
  }

  function patchCollection(current: { id: string; etag: string }, payload: Record<string, unknown>) {
    return application.inject({ method: 'PATCH', url: `/api/v1/collections/${current.id}`,
      headers: { ...mutationHeaders(actor, randomUUID(), 'application/merge-patch+json'),
        'if-match': current.etag }, payload });
  }

  async function projectCommittedProductOutbox() {
    const before = await isolated.runtime.pool.query<{ count: string }>(`select count(*)::text count
      from social_feed_items where collection_id=$1 and recipient_profile_id=$2`,
    [collection.id, recipient.accountId]);
    const expectedMinimum = Number(before.rows[0]?.count ?? 0) + 1;
    await drainUntil(async () => {
      const row = await isolated.runtime.pool.query<{ count: string }>(`select count(*)::text count from social_feed_items
        where collection_id=$1 and recipient_profile_id=$2`, [collection.id, recipient.accountId]);
      return Number(row.rows[0]?.count ?? 0) >= expectedMinimum;
    }, 80);
  }

  function query(cursor?: string) {
    return queryFeed(recipient.accountId, undefined, cursor);
  }

  function queryFeed(principalId: string, kind?: 'collection_change' | 'follow_activity',
    cursor?: string) {
    return queryCurrentFeed({ reads: createPostgresFeedPageReadPort(isolated.runtime.db),
      cursors: createFeedCursorKeyring({ active: { id: 'query', secret: Buffer.alloc(32, 9).toString('base64') }, retained: [] }),
      clock: { now: async () => new Date('2026-07-29T12:00:00Z') } },
    { principalId, limit: 10, ...(kind ? { kind } : {}), ...(cursor ? { cursor } : {}) });
  }

  async function drainUntil(predicate: () => Promise<boolean>, budget = 40): Promise<void> {
    const runtime = buildWorker(loadConfig({ DATABASE_URL: isolated.databaseUrl, LOG_LEVEL: 'silent',
      OIDC_JWKS_URI: 'https://issuer.example/realms/known/certs', WORKER_CONCURRENCY: '1', WORKER_BATCH_SIZE: '1' }), isolated.runtime);
    assert.ok(runtime.outbox);
    for (let attempt = 0; attempt < budget; attempt += 1) {
      // The predicate may already hold (idempotency checks) or the worker may be
      // out of work, so it is checked before claiming and after a no-work break.
      if (await predicate()) return;
      if (!await runtime.outbox.runOnce()) break;
    }
    if (await predicate()) return;
    throw new Error('production Worker did not converge within the bounded drain budget');
  }

  test('production Worker projection is rechecked against current Follow, Profile and publication authority', async () => {
    assert.deepEqual(await query(), { items: [], nextCursor: null });
    await projectCommittedProductOutbox();
    const visible = await query();
    assert.equal(visible.items.length, 1);
    assert.deepEqual(Object.keys(visible.items[0]!).sort(), FEED_ITEM_KEYS);
    assert.equal(visible.items[0]!.collectionTitle, PUBLIC_TITLE);
    assert.equal(visible.items[0]!.publicationSlug, PUBLIC_SLUG);
    assert.equal(visible.items[0]!.summary, 'public_collection_updated');
    assert.equal(JSON.stringify(visible).includes(PRIVATE_MARKER), false);
    assert.doesNotMatch(JSON.stringify(visible.items), /"details"|nodeIds/u);
    const unfollowed = await application.inject({ method: 'DELETE',
      url: `/api/v1/profiles/${actor.accountId}/follow`, headers: mutationHeaders(recipient, randomUUID()) });
    assert.equal(unfollowed.statusCode, 200, unfollowed.body);
    assert.deepEqual((await query()).items, []);
    const followed = await application.inject({ method: 'PUT',
      url: `/api/v1/profiles/${actor.accountId}/follow`, headers: mutationHeaders(recipient, randomUUID()) });
    assert.equal(followed.statusCode, 200, followed.body);
    assert.deepEqual((await query()).items, [], 'refollow must not resurrect pre-follow history');
    const afterRefollow = await patchCollection(collection, { title: 'Visible after refollow' });
    assert.equal(afterRefollow.statusCode, 200, afterRefollow.body);
    collection = (afterRefollow.json() as { collection: { id: string; etag: string } }).collection;
    await projectCommittedProductOutbox();
    const afterRefollowPage = await query();
    assert.equal(afterRefollowPage.items.length, 1);
    assert.equal(afterRefollowPage.items[0]!.collectionTitle, 'Visible after refollow');
    assert.equal(afterRefollowPage.items[0]!.publicationSlug, PUBLIC_SLUG);
    const tightened = await patchCollection(collection, { visibility: 'private' });
    assert.equal(tightened.statusCode, 200, tightened.body);
    collection = (tightened.json() as { collection: { id: string; etag: string } }).collection;
    const privatePage = await query();
    assert.deepEqual(privatePage.items, []);
    assert.equal(JSON.stringify(privatePage).includes('Visible after refollow'), false);
    const restored = await patchCollection(collection, { visibility: 'public' });
    assert.equal(restored.statusCode, 200, restored.body);
    collection = (restored.json() as { collection: { id: string; etag: string } }).collection;
    assert.equal((await query()).items.length, 1);
    const unlisted = await patchCollection(collection, { visibility: 'unlisted' });
    assert.equal(unlisted.statusCode, 200, unlisted.body);
    collection = (unlisted.json() as { collection: { id: string; etag: string } }).collection;
    const unlistedPage = await query();
    assert.deepEqual(unlistedPage.items, []);
    assert.equal(JSON.stringify(unlistedPage).includes('Visible after refollow'), false);
    const relisted = await patchCollection(collection, { visibility: 'public' });
    assert.equal(relisted.statusCode, 200, relisted.body);
    collection = (relisted.json() as { collection: { id: string; etag: string } }).collection;
    assert.equal((await query()).items.length, 1);
    // No Product Profile-hide command or Profile visibility field exists before P5-12.
    await isolated.runtime.pool.query("update accounts set status='disabled' where id=$1", [actor.accountId]);
    assert.deepEqual((await query()).items, []);
    await isolated.runtime.pool.query("update accounts set status='active' where id=$1", [actor.accountId]);
    const followedAfterLifecycle = await application.inject({ method: 'PUT',
      url: `/api/v1/profiles/${actor.accountId}/follow`,
      headers: mutationHeaders(recipient, randomUUID()) });
    assert.equal(followedAfterLifecycle.statusCode, 200, followedAfterLifecycle.body);
    const afterLifecycle = await patchCollection(collection, { title: 'Visible after Profile lifecycle' });
    assert.equal(afterLifecycle.statusCode, 200, afterLifecycle.body);
    collection = (afterLifecycle.json() as { collection: { id: string; etag: string } }).collection;
    await projectCommittedProductOutbox();
    const afterLifecyclePage = await query();
    assert.equal(afterLifecyclePage.items.length, 1);
    assert.equal(afterLifecyclePage.items[0]!.collectionTitle, 'Visible after Profile lifecycle');
    // No Product owner-transfer command exists before P5-12; exercise the current authority directly.
    await isolated.runtime.pool.query('update collections set owner_subject_id=$2 where id=$1',
      [collection.id, recipient.subjectId]);
    assert.deepEqual((await query()).items, []);
    await isolated.runtime.pool.query('update collections set owner_subject_id=$2 where id=$1',
      [collection.id, actor.subjectId]);
    assert.equal((await query()).items.length, 1);
    // No Product Collection-delete command exists before P5-12; this is a low-level lifecycle fixture only.
    await isolated.runtime.pool.query(`with deleted_nodes as (
        update nodes set deleted_at=current_timestamp,deleted_commit_ordinal=1
         where collection_id=$1 returning id
      )
      update collections set deleted_at=current_timestamp
       where id=$1 and exists(select 1 from deleted_nodes)`, [collection.id]);
    const deletedPage = await query();
    assert.deepEqual(deletedPage.items, []);
    assert.equal(JSON.stringify(deletedPage).includes('Visible after Profile lifecycle'), false);
  });

  test('real Follow HTTP plus the production Outbox worker produces and rechecks follow_activity Feed items', async () => {
    const follower = await issueTestSession({ factory,
      subject: 'feed-query-follow-follower', handle: 'feed-query-follow-follower' });
    const followed = await issueTestSession({ factory,
      subject: 'feed-query-follow-followed', handle: 'feed-query-follow-followed' });
    assert.deepEqual((await queryFeed(followed.accountId, 'follow_activity')).items, []);

    const created = await application.inject({ method: 'PUT',
      url: `/api/v1/profiles/${followed.accountId}/follow`,
      headers: mutationHeaders(follower, randomUUID()) });
    assert.equal(created.statusCode, 200, created.body);
    await drainUntil(async () => (await isolated.runtime.pool.query<{ count: number }>(`
      select count(*)::int count from social_feed_items
       where recipient_profile_id=$1 and actor_profile_id=$2 and kind='follow_activity'
         and state='visible'`, [followed.accountId, follower.accountId])).rows[0]!.count === 1);

    const visible = await queryFeed(followed.accountId, 'follow_activity');
    assert.equal(visible.items.length, 1);
    assert.deepEqual(Object.keys(visible.items[0]!).sort(), FEED_ITEM_KEYS);
    assert.equal(visible.items[0]!.kind, 'follow_activity');
    assert.equal(visible.items[0]!.collectionId, null);
    assert.equal(visible.items[0]!.collectionTitle, null);
    assert.equal(visible.items[0]!.publicationSlug, null);
    assert.equal(visible.items[0]!.summary, 'new_follower');
    assert.equal(visible.items[0]!.actor.profileId, follower.accountId);
    assert.equal(visible.items[0]!.actor.handle, 'feed-query-follow-follower');
    assert.equal(JSON.stringify(visible).includes('secret'), false);
    // The follower's own Feed never receives the relationship; no cross-principal leak.
    assert.deepEqual((await queryFeed(follower.accountId)).items, []);
    assert.deepEqual((await queryFeed(followed.accountId, 'collection_change')).items, []);

    // Worker redelivery stays idempotent: the stable event/recipient winner stays one item.
    await drainUntil(async () => (await isolated.runtime.pool.query<{ count: number }>(`
      select count(*)::int count from social_feed_items
       where recipient_profile_id=$1 and actor_profile_id=$2 and kind='follow_activity'
         and state='visible'`, [followed.accountId, follower.accountId])).rows[0]!.count === 1);
    assert.equal((await queryFeed(followed.accountId, 'follow_activity')).items.length, 1);

    // Profile lifecycle recheck: disabling the follower's Account hides the item immediately
    // and the removal of the Follow edge keeps it hidden after reactivation.
    await isolated.runtime.pool.query("update accounts set status='disabled' where id=$1", [follower.accountId]);
    assert.deepEqual((await queryFeed(followed.accountId, 'follow_activity')).items, []);
    await isolated.runtime.pool.query("update accounts set status='active' where id=$1", [follower.accountId]);
    assert.deepEqual((await queryFeed(followed.accountId, 'follow_activity')).items, [],
      'reactivation must not resurrect the removed Follow edge');

    // A fresh real Follow creates a fresh item; the old one stays hidden by followed_at recheck.
    const refollowed = await application.inject({ method: 'PUT',
      url: `/api/v1/profiles/${followed.accountId}/follow`,
      headers: mutationHeaders(follower, randomUUID()) });
    assert.equal(refollowed.statusCode, 200, refollowed.body);
    await drainUntil(async () => (await isolated.runtime.pool.query<{ count: number }>(`
      select count(*)::int count from social_feed_items
       where recipient_profile_id=$1 and actor_profile_id=$2 and kind='follow_activity'
         and state='visible'`, [followed.accountId, follower.accountId])).rows[0]!.count >= 2);
    assert.equal((await queryFeed(followed.accountId, 'follow_activity')).items.length, 1,
      'refollow must not resurrect pre-refollow follow_activity history');

    // Unfollow withdraws every follow_activity projection row for the pair.
    const removed = await application.inject({ method: 'DELETE',
      url: `/api/v1/profiles/${followed.accountId}/follow`,
      headers: mutationHeaders(follower, randomUUID()) });
    assert.equal(removed.statusCode, 200, removed.body);
    assert.deepEqual((await queryFeed(followed.accountId, 'follow_activity')).items, [],
      'query-time recheck must hide immediately after Unfollow');
    await drainUntil(async () => (await isolated.runtime.pool.query<{ state: string }>(`
      select state from social_feed_items
       where recipient_profile_id=$1 and actor_profile_id=$2 and kind='follow_activity'
         and state='visible' limit 1`, [followed.accountId, follower.accountId])).rows[0] === undefined);
    const states = (await isolated.runtime.pool.query<{ state: string; withdrawal_reason: string | null }>(`
      select state,withdrawal_reason from social_feed_items
       where recipient_profile_id=$1 and actor_profile_id=$2 and kind='follow_activity'`,
    [followed.accountId, follower.accountId])).rows;
    assert.ok(states.length >= 2);
    assert.equal(states.every((row) => row.state === 'withdrawn' && row.withdrawal_reason === 'unfollowed'), true);
    assert.deepEqual((await queryFeed(followed.accountId, 'follow_activity')).items, []);
  });
});
