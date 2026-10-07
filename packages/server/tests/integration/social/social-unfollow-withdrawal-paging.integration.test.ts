import assert from 'node:assert/strict';
import { afterAll, beforeAll, test } from 'vitest';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import {
  createPostgresSocialFeedWithdrawalWorkerRepository,
  SOCIAL_FEED_WITHDRAWAL_HANDLER,
  unfollowWithdrawalUpdateSql,
} from '../../../src/infrastructure/social/index.js';
import type { ProjectSocialFeedWithdrawalInput } from '../../../src/modules/social/index.js';
import { seedProfileAndCollection } from '../../support/social-feed-fixture.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  executeWithoutPermanenceGuards,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';

const PAGE_SIZE = 2;
const UNFOLLOWER = 'unfollow-actor';
const UNFOLLOWED = 'unfollow-target';
const OTHER = 'unfollow-other';
const COLLECTION = 'unfollow-wd-collection';
const OCCURRED_AT = new Date('2026-07-29T12:00:00.000Z');
const MATCHING_AT = new Date('2026-07-29T10:00:00.000Z');
const FUTURE_AT = new Date('2026-07-29T13:00:00.000Z');

describeWithPostgres('P-03 unfollow Feed withdrawal paging', () => {
  let isolated: IsolatedPostgresRuntime;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('phase5_unfollow_wd_page', {
      maxConnections: 8,
    });
    await runMigrations(isolated.runtime.db, 'latest');
    await seedProfileAndCollection(isolated, UNFOLLOWER, UNFOLLOWED, COLLECTION);
    await isolated.runtime.pool.query(
      `insert into accounts(id,subject_id,status) values($1,$2,'active')`,
      [OTHER, `subject-${OTHER}`],
    );
    await isolated.runtime.pool.query(
      `insert into profiles(account_id,display_name) values($1,$2)`,
      [OTHER, OTHER],
    );
  }, 120_000);

  afterAll(async () => {
    await isolated?.close();
  });

  async function resetProjection(): Promise<void> {
    await isolated.runtime.pool.query('delete from social_feed_items');
    await executeWithoutPermanenceGuards(isolated.runtime.pool,
      `delete from outbox_events where handler_name=$1`,
      [SOCIAL_FEED_WITHDRAWAL_HANDLER],
    );
  }

  async function leaseAttempt(outboxId: string, eventId: string): Promise<void> {
    await isolated.runtime.pool.query(`
      insert into resource_id_ledger(resource_id, resource_type)
      values ($1,'social-domain-event'),($2,'social-outbox')
      on conflict do nothing`, [eventId, outboxId]);
    await isolated.runtime.pool.query(`
      insert into outbox_events(
        outbox_id, domain_event_id, event_type, event_version, handler_name, handler_mode,
        aggregate_type, aggregate_id, aggregate_scope, occurred_at, payload_json, state,
        attempt_count, available_at, lease_generation, locked_until)
      values ($1,$2,'social.follow-removed',1,'social_feed_withdrawal','delivery_each_event',
        'profile-follow',$3,$4,$5,$6,'leased',1,current_timestamp,1,
        current_timestamp + interval '5 minutes')`,
    [outboxId, eventId, UNFOLLOWER, UNFOLLOWED, OCCURRED_AT,
      { actorProfileId: UNFOLLOWER, targetProfileId: UNFOLLOWED }]);
  }

  function projectInput(
    outboxId: string,
    eventId: string,
    maxRecipients = PAGE_SIZE,
  ): ProjectSocialFeedWithdrawalInput {
    return {
      event: {
        eventId,
        eventVersion: 1,
        actorProfileId: UNFOLLOWER,
        targetProfileId: UNFOLLOWED,
        occurredAt: OCCURRED_AT,
      },
      attempt: { outboxId, leaseGeneration: '1' },
      maxRecipients,
      signal: new AbortController().signal,
    };
  }

  async function insertCollectionChange(options: {
    readonly id: string;
    readonly recipient: string;
    readonly actor: string;
    readonly publishedAt: Date;
    readonly ordinal: number;
  }): Promise<void> {
    await isolated.runtime.pool.query(`
      insert into social_feed_items(
        feed_item_id, source_event_id, kind, recipient_profile_id, actor_profile_id,
        collection_id, source_event_version, source_commit_ordinal, publication_revision,
        discoverability_recheck_key, published_at, retain_until, state)
      values (
        $1, $2, 'collection_change', $3, $4, $5,
        2, $6, $7, $8, $9, $9::timestamptz + interval '90 days', 'visible')`,
    [
      options.id, `src-${options.id}`, options.recipient, options.actor, COLLECTION,
      options.ordinal, `c${options.ordinal}.p${options.ordinal}`,
      `publication.collection:${COLLECTION}`, options.publishedAt,
    ]);
  }

  async function insertFollowActivity(options: {
    readonly id: string;
    readonly recipient: string;
    readonly actor: string;
    readonly publishedAt: Date;
  }): Promise<void> {
    await isolated.runtime.pool.query(`
      insert into social_feed_items(
        feed_item_id, source_event_id, kind, recipient_profile_id, actor_profile_id,
        collection_id, source_event_version, source_commit_ordinal, publication_revision,
        discoverability_recheck_key, published_at, retain_until, state)
      values (
        $1, $2, 'follow_activity', $3, $4, null,
        1, 0, null, $5, $6, $6::timestamptz + interval '90 days', 'visible')`,
    [
      options.id, `src-${options.id}`, options.recipient, options.actor,
      `follow:${options.actor}:${options.recipient}`, options.publishedAt,
    ]);
  }

  async function itemStates(): Promise<ReadonlyMap<string, {
    readonly state: string;
    readonly withdrawal_reason: string | null;
  }>> {
    const rows = await isolated.runtime.pool.query<{
      feed_item_id: string;
      state: string;
      withdrawal_reason: string | null;
    }>(`
      select feed_item_id, state, withdrawal_reason
        from social_feed_items
       order by feed_item_id`);
    return new Map(rows.rows.map((row) => [row.feed_item_id, row]));
  }

  test('expand-only unfollow withdrawal indexes are present', async () => {
    const catalog = await isolated.runtime.pool.query<{ indexname: string }>(`
      select indexname from pg_indexes
       where schemaname=current_schema()
         and indexname in (
           'social_feed_items_unfollow_withdrawal_idx',
           'social_feed_items_unfollow_withdrawal_reverse_idx'
         )`);
    assert.deepEqual(
      catalog.rows.map((row) => row.indexname).sort(),
      [
        'social_feed_items_unfollow_withdrawal_idx',
        'social_feed_items_unfollow_withdrawal_reverse_idx',
      ],
    );
  });

  test('EXPLAIN compiled unfollow UPDATE LIMIT is lock-safe paging SQL', async () => {
    const sql = unfollowWithdrawalUpdateSql();
    assert.match(sql, /for update skip locked/u);
    assert.match(sql, /limit \$4/u);
    assert.match(sql, /order by published_at asc, feed_item_id asc/u);
    const explained = await isolated.runtime.pool.query<{ 'QUERY PLAN': string }>(
      `explain ${sql}`,
      [UNFOLLOWER, UNFOLLOWED, MATCHING_AT, PAGE_SIZE],
    );
    const plan = explained.rows.map((row) => row['QUERY PLAN']).join('\n');
    assert.match(plan, /Update|Limit/u);
  });

  test('first full page continues; remainder including follow_activity applies; non-matches stay visible', async () => {
    await resetProjection();
    await insertCollectionChange({
      id: 'wd-cc-1', recipient: UNFOLLOWER, actor: UNFOLLOWED,
      publishedAt: new Date(MATCHING_AT.getTime() + 1_000), ordinal: 1,
    });
    await insertCollectionChange({
      id: 'wd-cc-2', recipient: UNFOLLOWER, actor: UNFOLLOWED,
      publishedAt: new Date(MATCHING_AT.getTime() + 2_000), ordinal: 2,
    });
    await insertCollectionChange({
      id: 'wd-cc-3', recipient: UNFOLLOWER, actor: UNFOLLOWED,
      publishedAt: new Date(MATCHING_AT.getTime() + 3_000), ordinal: 3,
    });
    await insertFollowActivity({
      id: 'wd-fa-match', recipient: UNFOLLOWED, actor: UNFOLLOWER,
      publishedAt: new Date(MATCHING_AT.getTime() + 10_000),
    });
    // 3 collection_change + 1 follow_activity = 4 matching rows. N=2 →
    // page 1 continued, page 2 continued (includes follow_activity), empty tick duplicate.
    // Keep collection_change count > N as required.

    await insertCollectionChange({
      id: 'wd-cc-other', recipient: OTHER, actor: UNFOLLOWED,
      publishedAt: MATCHING_AT, ordinal: 10,
    });
    await insertCollectionChange({
      id: 'wd-cc-future', recipient: UNFOLLOWER, actor: UNFOLLOWED,
      publishedAt: FUTURE_AT, ordinal: 11,
    });
    await insertFollowActivity({
      id: 'wd-fa-reverse', recipient: UNFOLLOWER, actor: UNFOLLOWED,
      publishedAt: MATCHING_AT,
    });
    await insertCollectionChange({
      id: 'wd-cc-already', recipient: UNFOLLOWER, actor: UNFOLLOWED,
      publishedAt: MATCHING_AT, ordinal: 12,
    });
    await isolated.runtime.pool.query(`
      update social_feed_items
         set state='withdrawn',
             withdrawn_at=current_timestamp,
             withdrawal_reason='discoverability_revoked'
       where feed_item_id='wd-cc-already'`);

    await leaseAttempt('wd-page-outbox', 'wd-page-event');
    const repository = createPostgresSocialFeedWithdrawalWorkerRepository(
      isolated.runtime.pool,
      { maxRecipients: PAGE_SIZE },
    );

    const first = await repository.project(projectInput('wd-page-outbox', 'wd-page-event'));
    assert.deepEqual(first, { disposition: 'continued', withdrawnCount: PAGE_SIZE });
    const afterFirst = await itemStates();
    assert.equal(afterFirst.get('wd-cc-1')?.state, 'withdrawn');
    assert.equal(afterFirst.get('wd-cc-1')?.withdrawal_reason, 'unfollowed');
    assert.equal(afterFirst.get('wd-cc-2')?.state, 'withdrawn');
    assert.equal(afterFirst.get('wd-cc-3')?.state, 'visible');
    assert.equal(afterFirst.get('wd-fa-match')?.state, 'visible');

    const second = await repository.project(projectInput('wd-page-outbox', 'wd-page-event'));
    assert.deepEqual(second, { disposition: 'continued', withdrawnCount: PAGE_SIZE });
    const afterSecond = await itemStates();
    assert.equal(afterSecond.get('wd-cc-3')?.state, 'withdrawn');
    assert.equal(afterSecond.get('wd-cc-3')?.withdrawal_reason, 'unfollowed');
    assert.equal(afterSecond.get('wd-fa-match')?.state, 'withdrawn');
    assert.equal(afterSecond.get('wd-fa-match')?.withdrawal_reason, 'unfollowed');
    assert.equal(afterSecond.get('wd-cc-other')?.state, 'visible');
    assert.equal(afterSecond.get('wd-cc-future')?.state, 'visible');
    assert.equal(afterSecond.get('wd-fa-reverse')?.state, 'visible');
    assert.equal(afterSecond.get('wd-cc-already')?.state, 'withdrawn');
    assert.equal(afterSecond.get('wd-cc-already')?.withdrawal_reason, 'discoverability_revoked');

    const third = await repository.project(projectInput('wd-page-outbox', 'wd-page-event'));
    assert.deepEqual(third, { disposition: 'duplicate', withdrawnCount: 0 });

    await insertCollectionChange({
      id: 'wd-cc-partial', recipient: UNFOLLOWER, actor: UNFOLLOWED,
      publishedAt: MATCHING_AT, ordinal: 30,
    });
    const partial = await repository.project(projectInput('wd-page-outbox', 'wd-page-event'));
    assert.deepEqual(partial, { disposition: 'applied', withdrawnCount: 1 });
    assert.equal((await itemStates()).get('wd-cc-partial')?.state, 'withdrawn');
  });

  test('lease_lost after a page UPDATE rolls that page back', async () => {
    await resetProjection();
    await insertCollectionChange({
      id: 'wd-lease-1', recipient: UNFOLLOWER, actor: UNFOLLOWED,
      publishedAt: MATCHING_AT, ordinal: 21,
    });
    await insertCollectionChange({
      id: 'wd-lease-2', recipient: UNFOLLOWER, actor: UNFOLLOWED,
      publishedAt: new Date(MATCHING_AT.getTime() + 1_000), ordinal: 22,
    });
    await leaseAttempt('wd-lease-outbox', 'wd-lease-event');

    const repository = createPostgresSocialFeedWithdrawalWorkerRepository(
      isolated.runtime.pool,
      {
        maxRecipients: PAGE_SIZE,
        faultInjector: {
          async afterWithdrawBeforeFence() {
            await isolated.runtime.pool.query(`
              update outbox_events
                 set locked_until=current_timestamp - interval '1 second'
               where outbox_id='wd-lease-outbox'`);
          },
        },
      },
    );

    const result = await repository.project(projectInput('wd-lease-outbox', 'wd-lease-event'));
    assert.deepEqual(result, { disposition: 'lease_lost', withdrawnCount: 0 });
    const states = await itemStates();
    assert.equal(states.get('wd-lease-1')?.state, 'visible');
    assert.equal(states.get('wd-lease-2')?.state, 'visible');
  });
});
