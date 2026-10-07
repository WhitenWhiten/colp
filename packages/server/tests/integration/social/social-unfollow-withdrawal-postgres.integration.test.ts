import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, test } from 'vitest';
import { buildWorker } from '../../../src/bootstrap/worker.js';
import { loadConfig } from '../../support/test-config.js';
import { DatabaseOperationError, runMigrations } from '../../../src/infrastructure/database/index.js';
import { createPostgresCanonicalMutationUnitOfWork, createPostgresCollectionsUnitOfWork } from '../../../src/infrastructure/collections/index.js';
import { createPostgresIdentityUnitOfWork } from '../../../src/infrastructure/identity/index.js';
import {
  EventEnvelopeRegistry,
  OutboxRouter,
  PostgresOutboxRepository,
  VersionedOutboxWorker,
} from '../../../src/infrastructure/outbox/index.js';
import {
  createPostgresFeedPageReadPort,
  createPostgresFollowCommandUnitOfWork,
  createPostgresFollowQueryUnitOfWork,
  createPostgresSocialFeedWithdrawalWorkerRepository,
  createSocialFeedWithdrawalWorkerRoutes,
  SOCIAL_FEED_WITHDRAWAL_HANDLER,
  type FollowCommandWritePhase,
  type SocialFeedWithdrawalWorkerFaultInjector,
} from '../../../src/infrastructure/social/index.js';
import {
  createPostgresNotificationOperationsRepository,
  socialNotificationEnvelopeRegistrations,
} from '../../../src/infrastructure/notifications/index.js';
import { InMemoryMetrics } from '../../../src/infrastructure/telemetry/index.js';
import {
  createFeedCursorKeyring,
  createFollowCursorKeyring,
  queryCurrentFeed,
  unfollowProfile,
} from '../../../src/modules/social/index.js';
import { buildApiApp } from '../../../src/transport/app.js';
import {
  authenticatedMutationHeaders,
  issueTestSession,
  type AuthenticatedTestClient,
} from '../../support/product-http-harness.js';
import { createPostgresBetterAuthTestFactory } from '../../support/better-auth-test-factory.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  executeWithoutPermanenceGuards,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';

describeWithPostgres('R5-06 unfollow Feed withdrawal', () => {
  const ORIGIN = 'https://app.example.test';
  const ISSUER = 'https://issuer.example.test/realms/known';
  let isolated: IsolatedPostgresRuntime;
  let factory: ReturnType<typeof createPostgresBetterAuthTestFactory>;
  let recipient: AuthenticatedTestClient;
  let actor: AuthenticatedTestClient;
  let otherFollower: AuthenticatedTestClient;
  let collection: { id: string; etag: string };
  let application: ReturnType<typeof buildApiApp>;
  let outbox: PostgresOutboxRepository;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('phase5_unfollow_withdrawal', {
      maxConnections: 10,
    });
    await runMigrations(isolated.runtime.db, 'latest');
    const config = loadConfig({
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
      KNOWN_FEATURE_FOLLOW: 'true',
      FOLLOW_CURSOR_ACTIVE_KEY_ID: 'follow-query',
      FOLLOW_CURSOR_ACTIVE_SECRET: Buffer.alloc(32, 8).toString('base64'),
    });
    const identity = createPostgresIdentityUnitOfWork(isolated.runtime.db);
    factory = createPostgresBetterAuthTestFactory({ db: isolated.runtime.db });
    recipient = await issueTestSession({
      factory,
      subject: 'unfollow-recipient', handle: 'unfollow-recipient',
    });
    actor = await issueTestSession({
      factory,
      subject: 'unfollow-actor', handle: 'unfollow-actor',
    });
    otherFollower = await issueTestSession({
      factory,
      subject: 'unfollow-other', handle: 'unfollow-other',
    });
    const followCursors = createFollowCursorKeyring(config.follow!.cursorKeys);
    application = buildApiApp({
      config,
      identityUnitOfWork: identity,
      browserSessionAuthority: factory.authority,
      collectionsUnitOfWork: createPostgresCollectionsUnitOfWork(isolated.runtime.db),
      productCollectionMutationUnitOfWork:
        createPostgresCanonicalMutationUnitOfWork(isolated.runtime.db),
      followCommandUnitOfWork: createPostgresFollowCommandUnitOfWork(isolated.runtime.db),
      followQueryUnitOfWork: createPostgresFollowQueryUnitOfWork(
        isolated.runtime.db, followCursors,
      ),
    });
    outbox = new PostgresOutboxRepository(isolated.runtime.pool);

    const created = await application.inject({
      method: 'POST', url: '/api/v1/collections',
      headers: mutationHeaders(actor, randomUUID(), 'application/json'),
      payload: { kind: 'bookmarks', title: 'Withdrawal source', summary: 'public feed source' },
    });
    assert.equal(created.statusCode, 201, created.body);
    const createdBody = created.json() as { collection: { id: string; etag: string } };
    const published = await patchCollection(createdBody.collection, {
      visibility: 'public', publicationSlug: 'unfollow-withdrawal-public',
    });
    assert.equal(published.statusCode, 200, published.body);
    collection = (published.json() as { collection: { id: string; etag: string } }).collection;
  }, 120_000);

  afterAll(async () => {
    await application?.close();
    await isolated?.close();
  });

  function mutationHeaders(
    client: AuthenticatedTestClient,
    commandId: string,
    contentType?: string,
  ) {
    return contentType
      ? authenticatedMutationHeaders({
        client, origin: ORIGIN, contentType,
        extra: { 'known-command-id': commandId },
      })
      : {
        cookie: client.cookie,
        origin: ORIGIN,
        'x-csrf-token': client.csrfToken,
        'known-command-id': commandId,
      };
  }

  function patchCollection(
    current: { id: string; etag: string },
    payload: Record<string, unknown>,
  ) {
    return application.inject({
      method: 'PATCH',
      url: `/api/v1/collections/${current.id}`,
      headers: {
        ...mutationHeaders(actor, randomUUID(), 'application/merge-patch+json'),
        'if-match': current.etag,
      },
      payload,
    });
  }

  function productionWorker() {
    const runtime = buildWorker(loadConfig({
      DATABASE_URL: isolated.databaseUrl,
      LOG_LEVEL: 'silent',
      OIDC_JWKS_URI: 'https://issuer.example/realms/known/certs',
      WORKER_CONCURRENCY: '1',
      WORKER_BATCH_SIZE: '1',
    }), isolated.runtime);
    assert.ok(runtime.outbox);
    return runtime.outbox;
  }

  function withdrawalWorker(options: {
    readonly faultInjector?: SocialFeedWithdrawalWorkerFaultInjector;
  } = {}) {
    const routes = createSocialFeedWithdrawalWorkerRoutes({
      repository: createPostgresSocialFeedWithdrawalWorkerRepository(
        isolated.runtime.pool,
        options.faultInjector ? { faultInjector: options.faultInjector } : {},
      ),
    });
    return new VersionedOutboxWorker({
      repository: outbox,
      router: new OutboxRouter(routes),
      envelopes: new EventEnvelopeRegistry(socialNotificationEnvelopeRegistrations),
      logger: { info() {}, warn() {}, error() {} },
      metrics: new InMemoryMetrics(),
      leaseDurationMs: 5_000,
      heartbeatIntervalMs: 1_000,
      handlerTimeoutMs: 4_000,
      retryPolicy: { maxAttempts: 4, retryDelayMs: () => 1 },
    });
  }

  /**
   * Drain ready work. Only accelerates retryable rows — intentional future
   * available_at on pending rows (handler isolation) must stay deferred.
   */
  async function drain(worker = productionWorker(), limit = 80): Promise<void> {
    for (let index = 0, idle = 0; index < limit; index += 1) {
      await isolated.runtime.pool.query(`
        update outbox_events set available_at=current_timestamp
         where state = 'retryable'`);
      idle = await worker.runOnce() ? 0 : idle + 1;
      if (idle >= 2) return;
    }
    throw new Error('R5-06 worker drain exceeded its bounded test budget');
  }

  /** Park non-withdrawal work so a withdrawal-only worker cannot claim foreign handlers. */
  async function parkNonWithdrawalOutbox(): Promise<void> {
    await isolated.runtime.pool.query(`
      update outbox_events
         set available_at = current_timestamp + interval '7 days'
       where state in ('pending', 'retryable')
         and handler_name <> $1`, [SOCIAL_FEED_WITHDRAWAL_HANDLER]);
  }

  async function drainWithdrawals(limit = 40): Promise<void> {
    await parkNonWithdrawalOutbox();
    await drain(withdrawalWorker(), limit);
  }

  async function follow(client: AuthenticatedTestClient, targetAccountId: string) {
    const response = await application.inject({
      method: 'PUT',
      url: `/api/v1/profiles/${targetAccountId}/follow`,
      headers: mutationHeaders(client, randomUUID()),
    });
    assert.equal(response.statusCode, 200, response.body);
  }

  async function unfollow(client: AuthenticatedTestClient, targetAccountId: string) {
    const response = await application.inject({
      method: 'DELETE',
      url: `/api/v1/profiles/${targetAccountId}/follow`,
      headers: mutationHeaders(client, randomUUID()),
    });
    assert.equal(response.statusCode, 200, response.body);
    return response;
  }

  async function mutateCollectionTitle(title: string) {
    const patched = await patchCollection(collection, { title });
    assert.equal(patched.statusCode, 200, patched.body);
    collection = (patched.json() as { collection: { id: string; etag: string } }).collection;
  }

  function queryFeed(principalId: string) {
    return queryCurrentFeed({
      reads: createPostgresFeedPageReadPort(isolated.runtime.db),
      cursors: createFeedCursorKeyring({
        active: { id: 'query', secret: Buffer.alloc(32, 9).toString('base64') },
        retained: [],
      }),
      clock: { now: async () => new Date('2026-07-29T12:00:00Z') },
    }, { principalId, limit: 20 });
  }

  async function visibleFeedStates(recipientId: string) {
    return (await isolated.runtime.pool.query<{
      feed_item_id: string;
      state: string;
      withdrawal_reason: string | null;
      actor_profile_id: string;
    }>(`
      select feed_item_id, state, withdrawal_reason, actor_profile_id
        from social_feed_items
       where recipient_profile_id=$1
       order by feed_item_id`, [recipientId])).rows;
  }

  async function partialIndexVisibleCount(recipientId: string, actorId: string) {
    return (await isolated.runtime.pool.query<{ count: number }>(`
      select count(*)::int count
        from social_feed_items
       where recipient_profile_id=$1
         and actor_profile_id=$2
         and state='visible'`, [recipientId, actorId])).rows[0]!.count;
  }

  async function unfollowOutboxRows() {
    return (await isolated.runtime.pool.query<{
      outbox_id: string;
      domain_event_id: string;
      handler_name: string;
      event_type: string;
      state: string;
      occurred_at: Date;
    }>(`
      select outbox_id, domain_event_id, handler_name, event_type, state, occurred_at
        from outbox_events
       where event_type='social.follow-removed'
       order by occurred_at asc, handler_name asc, outbox_id asc`)).rows;
  }

  function latestUnfollowPair(
    rows: Awaited<ReturnType<typeof unfollowOutboxRows>>,
  ) {
    assert.ok(rows.length >= 2);
    const latestDomain = rows.reduce((latest, row) => (
      row.occurred_at >= latest.occurred_at ? row : latest
    )).domain_event_id;
    const pair = rows
      .filter((row) => row.domain_event_id === latestDomain)
      .sort((left, right) => left.handler_name.localeCompare(right.handler_name));
    assert.deepEqual(pair.map((row) => row.handler_name), [
      'social_feed_withdrawal', 'social_follow_activity',
    ]);
    assert.equal(new Set(pair.map((row) => row.outbox_id)).size, 2);
    return pair;
  }

  test('real Follow -> Product mutation -> Feed -> Unfollow withdraws matching visible rows', async () => {
    await follow(recipient, actor.accountId);
    await follow(otherFollower, actor.accountId);
    await mutateCollectionTitle('Fanout before unfollow');
    await drain();

    const beforeRecipient = await visibleFeedStates(recipient.accountId);
    const beforeOther = await visibleFeedStates(otherFollower.accountId);
    assert.ok(beforeRecipient.some((row) => row.state === 'visible'));
    assert.ok(beforeOther.some((row) => row.state === 'visible'));
    assert.equal(await partialIndexVisibleCount(recipient.accountId, actor.accountId) > 0, true);

    const queryBefore = await queryFeed(recipient.accountId);
    assert.ok(queryBefore.items.length >= 1);

    await unfollow(recipient, actor.accountId);
    assert.deepEqual((await queryFeed(recipient.accountId)).items, [],
      'query-time recheck must hide immediately after Unfollow');
    assert.ok(
      (await visibleFeedStates(recipient.accountId)).some((row) => row.state === 'visible'),
      'projection rows remain visible until withdrawal worker runs',
    );

    const pair = latestUnfollowPair(await unfollowOutboxRows());
    assert.equal(pair.length, 2);

    await drain();
    const afterRecipient = await visibleFeedStates(recipient.accountId);
    assert.equal(afterRecipient.every((row) => row.state === 'withdrawn'
      && row.withdrawal_reason === 'unfollowed'), true);
    assert.equal(await partialIndexVisibleCount(recipient.accountId, actor.accountId), 0);
    assert.deepEqual((await queryFeed(recipient.accountId)).items, []);

    const afterOther = await visibleFeedStates(otherFollower.accountId);
    assert.ok(afterOther.some((row) => row.state === 'visible'),
      'other authorized followers must keep their Feed items');
    assert.ok((await queryFeed(otherFollower.accountId)).items.length >= 1);
  });

  test('no-op Unfollow emits no event; refollow does not restore withdrawn items', async () => {
    // Isolate from prior cases: no-op Unfollow must not invent events when already unfollowed.
    await isolated.runtime.pool.query(`
      delete from follows
       where actor_profile_id=$1 and target_profile_id=$2`,
    [recipient.accountId, actor.accountId]);
    await executeWithoutPermanenceGuards(isolated.runtime.pool,
      `delete from outbox_events where event_type like 'social.follow-%'`);
    const noop = await unfollow(recipient, actor.accountId);
    assert.equal(noop.statusCode, 200, noop.body);
    assert.equal((await unfollowOutboxRows()).length, 0);

    await follow(recipient, actor.accountId);
    assert.deepEqual((await queryFeed(recipient.accountId)).items, [],
      'refollow must not resurrect pre-unfollow Feed history');
    const stillWithdrawn = await visibleFeedStates(recipient.accountId);
    assert.ok(stillWithdrawn.every((row) => row.state === 'withdrawn'
      || row.actor_profile_id !== actor.accountId));

    await mutateCollectionTitle('Visible only after refollow');
    await drain();
    assert.equal((await queryFeed(recipient.accountId)).items.length >= 1, true);
  });

  test('withdrawal delivery is idempotent under repeat, rollback and lease takeover', async () => {
    await isolated.runtime.pool.query('delete from follows');
    await isolated.runtime.pool.query('delete from social_feed_items');
    await executeWithoutPermanenceGuards(isolated.runtime.pool, `
      delete from outbox_events
       where handler_name in ('social_feed_withdrawal','social_follow_activity')`);

    await follow(recipient, actor.accountId);
    await mutateCollectionTitle('Idempotent withdrawal source');
    await drain();
    assert.equal(await partialIndexVisibleCount(recipient.accountId, actor.accountId) > 0, true);
    await unfollow(recipient, actor.accountId);

    const withdrawal = (await unfollowOutboxRows())
      .find((row) => row.handler_name === SOCIAL_FEED_WITHDRAWAL_HANDLER);
    assert.ok(withdrawal);

    await drainWithdrawals();
    assert.equal(await partialIndexVisibleCount(recipient.accountId, actor.accountId), 0);
    const firstWithdrawnAt = (await isolated.runtime.pool.query<{ withdrawn_at: Date }>(`
      select withdrawn_at from social_feed_items
       where recipient_profile_id=$1 and actor_profile_id=$2`,
    [recipient.accountId, actor.accountId])).rows[0]!.withdrawn_at;

    await isolated.runtime.pool.query(`
      update outbox_events
         set state='retryable', available_at=current_timestamp,
             locked_until=null, completed_at=null, last_error=null
       where outbox_id=$1`, [withdrawal.outbox_id]);
    await drainWithdrawals();
    const secondWithdrawnAt = (await isolated.runtime.pool.query<{ withdrawn_at: Date }>(`
      select withdrawn_at from social_feed_items
       where recipient_profile_id=$1 and actor_profile_id=$2`,
    [recipient.accountId, actor.accountId])).rows[0]!.withdrawn_at;
    assert.equal(secondWithdrawnAt.toISOString(), firstWithdrawnAt.toISOString());

    await isolated.runtime.pool.query(`
      update social_feed_items
         set state='visible', withdrawn_at=null, withdrawal_reason=null
       where recipient_profile_id=$1 and actor_profile_id=$2`,
    [recipient.accountId, actor.accountId]).catch(() => undefined);
    // Transition guard forbids resurrection; seed a fresh visible item for fault paths.
    await isolated.runtime.pool.query(`
      insert into social_feed_items(
        feed_item_id, source_event_id, kind, recipient_profile_id, actor_profile_id,
        collection_id, source_event_version, source_commit_ordinal, publication_revision,
        discoverability_recheck_key, published_at, retain_until, state)
      values(
        'r506-fault-item', 'r506-fault-source', 'collection_change', $1, $2, $3,
        2, 9001, 'c9001.p9001', $4,
        current_timestamp - interval '1 minute',
        current_timestamp - interval '1 minute' + interval '90 days',
        'visible')
      on conflict do nothing`,
    [recipient.accountId, actor.accountId, collection.id,
      `publication.collection:${collection.id}`]);

    const rollbackOutboxId = 'r506-rollback-outbox';
    const rollbackEventId = 'r506-rollback-event';
    await isolated.runtime.pool.query(`
      insert into resource_id_ledger(resource_id, resource_type)
      values ($1,'social-domain-event'),($2,'social-outbox')
      on conflict do nothing`, [rollbackEventId, rollbackOutboxId]);
    await isolated.runtime.pool.query(`
      insert into outbox_events(
        outbox_id, domain_event_id, event_type, event_version, handler_name, handler_mode,
        aggregate_type, aggregate_id, aggregate_scope, occurred_at, payload_json, state,
        attempt_count, available_at, lease_generation)
      values ($1,$2,'social.follow-removed',1,'social_feed_withdrawal','delivery_each_event',
        'profile-follow',$3,$4,current_timestamp,$5,'pending',0,current_timestamp,0)`,
    [rollbackOutboxId, rollbackEventId, recipient.accountId, actor.accountId,
      { actorProfileId: recipient.accountId, targetProfileId: actor.accountId }]);

    // Worker runOnce swallows handler errors into fail()/retryable; assert residue instead.
    await parkNonWithdrawalOutbox();
    assert.equal(await withdrawalWorker({
      faultInjector: {
        afterWithdrawBeforeFence() {
          throw new Error('injected withdrawal rollback');
        },
      },
    }).runOnce(), true);
    assert.equal((await isolated.runtime.pool.query<{ state: string }>(`
      select state from social_feed_items where feed_item_id='r506-fault-item'`))
      .rows[0]?.state, 'visible');
    assert.equal((await isolated.runtime.pool.query<{ state: string }>(`
      select state from outbox_events where outbox_id=$1`, [rollbackOutboxId]))
      .rows[0]?.state, 'retryable');

    await drainWithdrawals();
    assert.deepEqual((await isolated.runtime.pool.query<{ state: string; withdrawal_reason: string }>(`
      select state, withdrawal_reason from social_feed_items where feed_item_id='r506-fault-item'`))
      .rows[0], { state: 'withdrawn', withdrawal_reason: 'unfollowed' });

    const takeoverOutboxId = 'r506-takeover-outbox';
    const takeoverEventId = 'r506-takeover-event';
    await isolated.runtime.pool.query(`
      insert into social_feed_items(
        feed_item_id, source_event_id, kind, recipient_profile_id, actor_profile_id,
        collection_id, source_event_version, source_commit_ordinal, publication_revision,
        discoverability_recheck_key, published_at, retain_until, state)
      values(
        'r506-takeover-item', 'r506-takeover-source', 'collection_change', $1, $2, $3,
        2, 9002, 'c9002.p9002', $4,
        current_timestamp - interval '1 minute',
        current_timestamp - interval '1 minute' + interval '90 days',
        'visible')`,
    [recipient.accountId, actor.accountId, collection.id,
      `publication.collection:${collection.id}`]);
    await isolated.runtime.pool.query(`
      insert into resource_id_ledger(resource_id, resource_type)
      values ($1,'social-domain-event'),($2,'social-outbox')`,
    [takeoverEventId, takeoverOutboxId]);
    await isolated.runtime.pool.query(`
      insert into outbox_events(
        outbox_id, domain_event_id, event_type, event_version, handler_name, handler_mode,
        aggregate_type, aggregate_id, aggregate_scope, occurred_at, payload_json, state,
        attempt_count, available_at, lease_generation)
      values ($1,$2,'social.follow-removed',1,'social_feed_withdrawal','delivery_each_event',
        'profile-follow',$3,$4,current_timestamp,$5,'pending',0,current_timestamp,0)`,
    [takeoverOutboxId, takeoverEventId, recipient.accountId, actor.accountId,
      { actorProfileId: recipient.accountId, targetProfileId: actor.accountId }]);
    await parkNonWithdrawalOutbox();

    await isolated.runtime.pool.query(`
      create or replace function phase5_r506_takeover_block()
      returns trigger language plpgsql as $$ begin
        if new.feed_item_id='r506-takeover-item'
           and exists (
             select 1 from outbox_events
              where outbox_id='r506-takeover-outbox' and lease_generation=1
           ) then
          perform pg_sleep(0.35);
        end if;
        return new;
      end $$`);
    await isolated.runtime.pool.query(`
      drop trigger if exists phase5_r506_takeover_block on social_feed_items`);
    await isolated.runtime.pool.query(`
      create trigger phase5_r506_takeover_block
        before update on social_feed_items for each row
        execute function phase5_r506_takeover_block()`);

    const stale = withdrawalWorker().runOnce();
    // Wait until the stale worker has leased generation 1 before forcing expiry.
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const leased = await isolated.runtime.pool.query<{ lease_generation: string; state: string }>(`
        select lease_generation::text, state from outbox_events where outbox_id=$1`,
      [takeoverOutboxId]);
      if (leased.rows[0]?.state === 'leased' && leased.rows[0].lease_generation === '1') break;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    await isolated.runtime.pool.query(`
      update outbox_events
         set locked_until=current_timestamp - interval '1 second',
             available_at=current_timestamp
       where outbox_id=$1`, [takeoverOutboxId]);
    const takeover = withdrawalWorker().runOnce();
    await Promise.allSettled([stale, takeover]);
    await drainWithdrawals();
    assert.equal((await isolated.runtime.pool.query<{ state: string }>(`
      select state from social_feed_items where feed_item_id='r506-takeover-item'`))
      .rows[0]?.state, 'withdrawn');
    assert.ok(Number((await isolated.runtime.pool.query<{ lease_generation: string }>(`
      select lease_generation::text from outbox_events where outbox_id=$1`,
    [takeoverOutboxId])).rows[0]!.lease_generation) >= 2);
    await isolated.runtime.pool.query(
      'drop trigger if exists phase5_r506_takeover_block on social_feed_items',
    );
    await isolated.runtime.pool.query('drop function if exists phase5_r506_takeover_block()');
  });

  test('unknown Unfollow commit recovers; Notification and withdrawal handlers recover independently', async () => {
    await isolated.runtime.pool.query('delete from follows');
    await follow(recipient, actor.accountId);
    await mutateCollectionTitle('Independent handler recovery');
    await drain();

    const commandId = randomUUID();
    let injected = false;
    await assert.rejects(() => createPostgresFollowCommandUnitOfWork(isolated.runtime.db, {
      transactionFaultInjector: {
        afterCommitAcknowledged() {
          if (!injected) {
            injected = true;
            throw Object.assign(new Error('lost unfollow ack'), { code: 'ECONNRESET' });
          }
        },
      },
    }).execute((ports) => unfollowProfile(ports, {
      actor: { principalId: recipient.accountId, profileId: recipient.accountId },
      targetProfileId: actor.accountId,
      commandId,
    })), (error: unknown) => error instanceof DatabaseOperationError
      && error.kind === 'commit_outcome_unknown');

    const recovered = await createPostgresFollowCommandUnitOfWork(isolated.runtime.db)
      .execute((ports) => unfollowProfile(ports, {
        actor: { principalId: recipient.accountId, profileId: recipient.accountId },
        targetProfileId: actor.accountId,
        commandId,
      }));
    assert.equal(recovered.kind, 'replay');

    const handlers = latestUnfollowPair(await unfollowOutboxRows());
    const notification = handlers.find((row) => row.handler_name === 'social_follow_activity')!;
    const withdrawal = handlers.find((row) => row.handler_name === 'social_feed_withdrawal')!;

    await isolated.runtime.pool.query(`
      update outbox_events set available_at=current_timestamp + interval '1 hour'
       where outbox_id=$1`, [withdrawal.outbox_id]);
    await drain();
    assert.equal((await isolated.runtime.pool.query<{ state: string }>(`
      select state from outbox_events where outbox_id=$1`, [notification.outbox_id]))
      .rows[0]?.state, 'completed');
    assert.notEqual((await isolated.runtime.pool.query<{ state: string }>(`
      select state from outbox_events where outbox_id=$1`, [withdrawal.outbox_id]))
      .rows[0]?.state, 'completed');
    assert.equal(await partialIndexVisibleCount(recipient.accountId, actor.accountId) > 0, true);

    await isolated.runtime.pool.query(`
      update outbox_events set available_at=current_timestamp where outbox_id=$1`,
    [withdrawal.outbox_id]);
    await isolated.runtime.pool.query(`
      update outbox_events set available_at=current_timestamp + interval '1 hour'
       where outbox_id=$1`, [notification.outbox_id]);
    // Notification already completed; force a fresh paired failure path with a new unfollow.
    await follow(recipient, actor.accountId);
    await mutateCollectionTitle('Second independent pair');
    await drain();
    await unfollow(recipient, actor.accountId);
    const secondPair = latestUnfollowPair(await unfollowOutboxRows());
    const secondNotification = secondPair.find((row) => row.handler_name === 'social_follow_activity')!;
    const secondWithdrawal = secondPair.find((row) => row.handler_name === 'social_feed_withdrawal')!;
    await isolated.runtime.pool.query(`
      update outbox_events set available_at=current_timestamp + interval '1 hour'
       where outbox_id=$1`, [secondNotification.outbox_id]);
    await drainWithdrawals();
    assert.equal((await isolated.runtime.pool.query<{ state: string }>(`
      select state from outbox_events where outbox_id=$1`, [secondWithdrawal.outbox_id]))
      .rows[0]?.state, 'completed');
    assert.notEqual((await isolated.runtime.pool.query<{ state: string }>(`
      select state from outbox_events where outbox_id=$1`, [secondNotification.outbox_id]))
      .rows[0]?.state, 'completed');
    assert.equal(await partialIndexVisibleCount(recipient.accountId, actor.accountId), 0);

    await isolated.runtime.pool.query(`
      update outbox_events set available_at=current_timestamp where outbox_id=$1`,
    [secondNotification.outbox_id]);
    await drain();
    assert.equal((await isolated.runtime.pool.query<{ state: string }>(`
      select state from outbox_events where outbox_id=$1`, [secondNotification.outbox_id]))
      .rows[0]?.state, 'completed');
  });

  test('FIX-L-063 Unfollow withdrawal dead letter replays by the affected recipient account', async () => {
    await isolated.runtime.pool.query('delete from follows');
    await isolated.runtime.pool.query('delete from social_feed_items');
    await executeWithoutPermanenceGuards(isolated.runtime.pool, `
      delete from outbox_events
       where handler_name in ('social_feed_withdrawal','social_follow_activity')`);

    await follow(recipient, actor.accountId);
    await mutateCollectionTitle('Ops replay source');
    await drain();
    await unfollow(recipient, actor.accountId);
    const pair = latestUnfollowPair(await unfollowOutboxRows());
    const withdrawal = pair.find((row) => row.handler_name === 'social_feed_withdrawal')!;
    const notification = pair.find((row) => row.handler_name === 'social_follow_activity')!;

    // Dead-letter both follow-removed rows: the Notification row belongs to the
    // target account (aggregate_scope=target), while the withdrawal row affects
    // the actor's Feed. Ops replay by the actor account must recover the
    // withdrawal and must not pull the target's Notification dead letter.
    await isolated.runtime.pool.query(`
      update outbox_events
         set state='dead_letter', dead_lettered_at=current_timestamp, last_error='ops drill'
       where outbox_id in ($1,$2)`, [withdrawal.outbox_id, notification.outbox_id]);

    const operations = createPostgresNotificationOperationsRepository(isolated.runtime.pool);
    const replayed = await operations.replayDeadLetters({
      recipientAccountId: recipient.accountId, limit: 10 });
    assert.deepEqual(replayed.outboxIds, [withdrawal.outbox_id],
      'replay by the affected recipient must recover the withdrawal dead letter only');
    assert.equal((await isolated.runtime.pool.query<{ state: string }>(`
      select state from outbox_events where outbox_id=$1`, [withdrawal.outbox_id]))
      .rows[0]?.state, 'retryable');
    assert.equal((await isolated.runtime.pool.query<{ state: string }>(`
      select state from outbox_events where outbox_id=$1`, [notification.outbox_id]))
      .rows[0]?.state, 'dead_letter',
      'the target-account Notification dead letter must not be pulled into the actor replay');
    // A repeated replay is a re-entrant no-op, and the replayed withdrawal
    // converges the affected Feed through the production worker.
    assert.deepEqual((await operations.replayDeadLetters({
      recipientAccountId: recipient.accountId, limit: 10 })).outboxIds, []);
    await drainWithdrawals();
    assert.equal(await partialIndexVisibleCount(recipient.accountId, actor.accountId), 0);
  });

  test('visibility race leaves already-withdrawn discoverability rows untouched', async () => {
    await isolated.runtime.pool.query('delete from follows');
    await isolated.runtime.pool.query('delete from social_feed_items');
    await follow(recipient, actor.accountId);
    await mutateCollectionTitle('Visibility race source');
    await drain();

    await isolated.runtime.pool.query(`
      update social_feed_items
         set state='withdrawn',
             withdrawn_at=current_timestamp,
             withdrawal_reason='discoverability_revoked'
       where recipient_profile_id=$1 and actor_profile_id=$2 and state='visible'`,
    [recipient.accountId, actor.accountId]);
    await isolated.runtime.pool.query(`
      insert into social_feed_items(
        feed_item_id, source_event_id, kind, recipient_profile_id, actor_profile_id,
        collection_id, source_event_version, source_commit_ordinal, publication_revision,
        discoverability_recheck_key, published_at, retain_until, state)
      values(
        'r506-visibility-item', 'r506-visibility-source', 'collection_change', $1, $2, $3,
        2, 9100, 'c9100.p9100', $4,
        current_timestamp - interval '30 seconds',
        current_timestamp - interval '30 seconds' + interval '90 days',
        'visible')`,
    [recipient.accountId, actor.accountId, collection.id,
      `publication.collection:${collection.id}`]);

    await unfollow(recipient, actor.accountId);
    await drainWithdrawals();

    const rows = await isolated.runtime.pool.query<{
      feed_item_id: string;
      withdrawal_reason: string;
    }>(`
      select feed_item_id, withdrawal_reason from social_feed_items
       where recipient_profile_id=$1 and actor_profile_id=$2
       order by feed_item_id`, [recipient.accountId, actor.accountId]);
    const discoverability = rows.rows.filter(
      (row) => row.withdrawal_reason === 'discoverability_revoked',
    );
    assert.ok(discoverability.length >= 1);
    assert.equal(
      rows.rows.find((row) => row.feed_item_id === 'r506-visibility-item')?.withdrawal_reason,
      'unfollowed',
    );
  });

  test('Follow command Unfollow rollback leaves zero dual-outbox residue', async () => {
    // resource_id_ledger is immutable (FOR EACH ROW); never DELETE/UPDATE it.
    await executeWithoutPermanenceGuards(isolated.runtime.pool,
      `delete from outbox_events where event_type like 'social.follow-%'`);
    await isolated.runtime.pool.query(`
      insert into follows(actor_profile_id, target_profile_id)
      values ($1,$2) on conflict do nothing`, [recipient.accountId, actor.accountId]);

    for (const phase of [
      'authority', 'audit', 'outbox', 'complete', 'before_commit',
    ] as const) {
      const ledgerBefore = (await isolated.runtime.pool.query<{ count: number }>(`
        select count(*)::int count from resource_id_ledger
         where resource_type in ('social-domain-event','social-outbox')`)).rows[0]!.count;
      const options = phase === 'before_commit'
        ? {
          transactionFaultInjector: {
            afterCallbackBeforeCommit() { throw new Error(`fault-unfollow-${phase}`); },
          },
        }
        : {
          faultInjector: {
            afterPhase(value: FollowCommandWritePhase) {
              if (value === phase) throw new Error(`fault-unfollow-${phase}`);
            },
          },
        };
      await assert.rejects(() => createPostgresFollowCommandUnitOfWork(
        isolated.runtime.db, options,
      ).execute((ports) => unfollowProfile(ports, {
        actor: { principalId: recipient.accountId, profileId: recipient.accountId },
        targetProfileId: actor.accountId,
        commandId: randomUUID(),
      })), new RegExp(`fault-unfollow-${phase}`, 'u'));
      assert.equal((await isolated.runtime.pool.query<{ count: number }>(`
        select count(*)::int count from outbox_events
         where event_type='social.follow-removed'`)).rows[0]!.count, 0);
      assert.equal((await isolated.runtime.pool.query<{ count: number }>(`
        select count(*)::int count from resource_id_ledger
         where resource_type in ('social-domain-event','social-outbox')`)).rows[0]!.count,
      ledgerBefore);
      assert.equal((await isolated.runtime.pool.query<{ count: number }>(`
        select count(*)::int count from follows
         where actor_profile_id=$1 and target_profile_id=$2`,
      [recipient.accountId, actor.accountId])).rows[0]!.count, 1);
    }
  });
});
