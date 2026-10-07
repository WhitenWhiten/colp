import assert from 'node:assert/strict';
import { afterAll, beforeAll, test } from 'vitest';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import { PostgresOutboxRepository } from '../../../src/infrastructure/outbox/index.js';
import {
  buildFeedPageStatement,
  createPostgresSocialFeedWorkerRepository,
} from '../../../src/infrastructure/social/index.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';
import { seedProfileAndCollection } from '../../support/social-feed-fixture.js';

const OWNER = 'IiIiIiIiIiIiIiIiIiIiIg';
const COLLECTION = 'Dw8PDw8PDw8PDw8PDw8PDw';
const OWNER_FOLLOWER = 'cf-owner-follower';
const COLLECTION_FOLLOWER = 'cf-collection-follower';
const DUAL_FOLLOWER = 'cf-dual-follower';
const EVENT_AT = '2026-07-29T10:00:00.000Z';
const FOLLOW_AT = '2026-07-29T09:00:00Z';

describeWithPostgres('collection-follow Feed fan-out recipients', () => {
  let isolated: IsolatedPostgresRuntime;
  let outbox: PostgresOutboxRepository;
  let ordinal = 200;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('collection_follow_cf_feed', {
      maxConnections: 8,
    });
    await runMigrations(isolated.runtime.db, 'latest');
    await seedProfileAndCollection(isolated, OWNER_FOLLOWER, OWNER, COLLECTION);
    for (const id of [COLLECTION_FOLLOWER, DUAL_FOLLOWER]) {
      await isolated.runtime.pool.query(
        `insert into accounts(id,subject_id,status) values($1,$2,'active')`,
        [id, `subject-${id}`],
      );
      await isolated.runtime.pool.query(
        'insert into profiles(account_id,display_name) values($1,$1)', [id],
      );
    }
    await isolated.runtime.pool.query(
      `insert into profile_handles(handle,account_id) values('cf-feed-owner',$1)`,
      [OWNER],
    );
    outbox = new PostgresOutboxRepository(isolated.runtime.pool);
  }, 120_000);
  afterAll(async () => isolated?.close());

  function repository(includeCollectionFollowers: boolean) {
    return createPostgresSocialFeedWorkerRepository(isolated.runtime.pool, {
      emitNotificationIntents: false,
      includeCollectionFollowers,
    });
  }

  async function followOwner(id: string, at = FOLLOW_AT) {
    await isolated.runtime.pool.query(
      `insert into follows(actor_profile_id,target_profile_id,followed_at)
       values($1,$2,$3) on conflict do nothing`, [id, OWNER, at],
    );
  }

  async function followCollection(id: string, at = FOLLOW_AT) {
    await isolated.runtime.pool.query(
      `insert into collection_follows(collection_id,follower_profile_id,followed_at)
       values($1,$2,$3) on conflict do nothing`, [COLLECTION, id, at],
    );
  }

  async function unfollowCollection(id: string) {
    await isolated.runtime.pool.query(
      `delete from collection_follows where collection_id=$1 and follower_profile_id=$2`,
      [COLLECTION, id],
    );
  }

  async function enqueue(eventId: string): Promise<number> {
    ordinal += 1;
    const payload = {
      collectionId: COLLECTION, ownerProfileId: OWNER,
      publicationRevision: `c${ordinal}.p${ordinal}`,
      discoverabilityRecheckKey: `publication.collection:${COLLECTION}`,
      producerDiscoverability: 'public_candidate',
    };
    await isolated.runtime.pool.query(
      `insert into resource_id_ledger(resource_id,resource_type,committed_at)
       values($1,'outbox',current_timestamp)`, [eventId],
    );
    await isolated.runtime.pool.query(
      `insert into outbox_events(
        outbox_id,domain_event_id,event_type,event_version,handler_name,handler_mode,
        aggregate_type,aggregate_id,aggregate_scope,aggregate_revision,commit_ordinal,
        occurred_at,payload_json,state,attempt_count,available_at,lease_generation)
       values($1,$1,'social.collection-change',2,'social.publish-collection-change',
         'projection_latest_only','collection',$2,$2,$3,$4,$5,$6,
         'pending',0,current_timestamp,0)`,
      [eventId, COLLECTION, `c${ordinal}.p${ordinal}`, ordinal, EVENT_AT, payload],
    );
    return ordinal;
  }

  async function project(eventId: string, includeCollectionFollowers: boolean) {
    const claim = await outbox.claim(30_000);
    assert.equal(claim?.outboxId, eventId);
    const result = await repository(includeCollectionFollowers).projectCollectionChange({
      event: {
        eventId: claim!.eventId,
        eventVersion: claim!.eventVersion as 1 | 2,
        collectionId: claim!.aggregateScope,
        ownerProfileId: OWNER,
        publicationRevision: claim!.aggregateRevision,
        discoverabilityRecheckKey: `publication.collection:${COLLECTION}`,
        producerDiscoverability: 'public_candidate',
        commitOrdinal: claim!.commitOrdinal,
        occurredAt: claim!.occurredAt,
      },
      attempt: { outboxId: claim!.outboxId, leaseGeneration: claim!.leaseGeneration },
      maxRecipients: 100,
      signal: new AbortController().signal,
    });
    await isolated.runtime.pool.query(
      `update outbox_events set state='completed', locked_until=null where outbox_id=$1`,
      [eventId],
    );
    return result;
  }

  async function recipients(eventId: string): Promise<string[]> {
    const rows = await isolated.runtime.pool.query<{ recipient_profile_id: string }>(`
      select recipient_profile_id from social_feed_items
       where source_event_id=$1 order by recipient_profile_id`, [eventId]);
    return rows.rows.map((row) => row.recipient_profile_id);
  }

  async function visibleCount(eventId: string, recipient: string): Promise<number> {
    return Number((await isolated.runtime.pool.query<{ count: string }>(`
      select count(*)::text count from social_feed_items
       where source_event_id=$1 and recipient_profile_id=$2 and state='visible'`,
    [eventId, recipient])).rows[0]?.count ?? 0);
  }

  async function authorizedFeedEventIds(
    principalId: string,
    includeCollectionFollowers?: boolean,
  ): Promise<string[]> {
    // undefined means the production default: the flag is on, so read with
    // collection followers included. The statement itself fails closed when
    // options are omitted, which 'flag off' cases assert with explicit false.
    const statement = buildFeedPageStatement(
      { principalId, kind: 'collection_change', limit: 20 },
      { includeCollectionFollowers: includeCollectionFollowers ?? true },
    );
    const rows = await isolated.runtime.pool.query<{ source_event_id: string }>(
      statement.text, [...statement.values],
    );
    return rows.rows.map((row) => row.source_event_id);
  }

  test('flag off keeps owner-follow recipients and ignores collection_follows', async () => {
    await followOwner(OWNER_FOLLOWER);
    await followCollection(COLLECTION_FOLLOWER);
    await enqueue('cf-feed-flag-off');
    const result = await project('cf-feed-flag-off', false);
    assert.equal(result.disposition, 'applied');
    assert.deepEqual(await recipients('cf-feed-flag-off'), [OWNER_FOLLOWER]);
  });

  test('collection-only follower receives one item when the flag is on', async () => {
    await enqueue('cf-feed-collection-only');
    const result = await project('cf-feed-collection-only', true);
    assert.equal(result.disposition, 'applied');
    assert.deepEqual(await recipients('cf-feed-collection-only'), [
      COLLECTION_FOLLOWER, OWNER_FOLLOWER,
    ]);
    assert.equal(await visibleCount('cf-feed-collection-only', COLLECTION_FOLLOWER), 1);
  });

  test('current-authority feed shows collection-only items; owner-follow still works; private stays hidden', async () => {
    const ownerFollows = Number((await isolated.runtime.pool.query<{ count: string }>(`
      select count(*)::text count from follows
       where actor_profile_id=$1 and target_profile_id=$2`,
    [COLLECTION_FOLLOWER, OWNER])).rows[0]?.count ?? 0);
    assert.equal(ownerFollows, 0, 'collection-only recipient must not follow the owner');

    const collectionOnly = await authorizedFeedEventIds(COLLECTION_FOLLOWER);
    assert.equal(collectionOnly.includes('cf-feed-collection-only'), true);
    assert.equal(
      collectionOnly.filter((id) => id === 'cf-feed-collection-only').length, 1,
    );

    const ownerOnly = await authorizedFeedEventIds(OWNER_FOLLOWER);
    assert.equal(ownerOnly.includes('cf-feed-collection-only'), true);
    assert.equal(ownerOnly.includes('cf-feed-flag-off'), true);

    await isolated.runtime.pool.query(
      `update collections set visibility='private' where id=$1`, [COLLECTION],
    );
    assert.deepEqual(await authorizedFeedEventIds(COLLECTION_FOLLOWER), []);
    assert.deepEqual(await authorizedFeedEventIds(OWNER_FOLLOWER), []);
    await isolated.runtime.pool.query(
      `update collections set visibility='public' where id=$1`, [COLLECTION],
    );
    assert.equal(
      (await authorizedFeedEventIds(COLLECTION_FOLLOWER)).includes('cf-feed-collection-only'),
      true,
    );
    assert.equal(
      (await authorizedFeedEventIds(OWNER_FOLLOWER)).includes('cf-feed-collection-only'),
      true,
    );
    assert.equal(
      (await authorizedFeedEventIds(COLLECTION_FOLLOWER, false)).includes('cf-feed-collection-only'),
      false,
    );
    assert.equal(
      (await authorizedFeedEventIds(OWNER_FOLLOWER, false)).includes('cf-feed-collection-only'),
      true,
    );
  });

  test('dual owner and collection follow yields one recipient row', async () => {
    await followOwner(DUAL_FOLLOWER);
    await followCollection(DUAL_FOLLOWER);
    await enqueue('cf-feed-dual');
    const result = await project('cf-feed-dual', true);
    assert.equal(result.disposition, 'applied');
    const rows = await recipients('cf-feed-dual');
    assert.deepEqual(rows, [COLLECTION_FOLLOWER, DUAL_FOLLOWER, OWNER_FOLLOWER]);
    assert.equal(rows.filter((id) => id === DUAL_FOLLOWER).length, 1);
    assert.equal(await visibleCount('cf-feed-dual', DUAL_FOLLOWER), 1);
  });

  test('unfollow collection stops future fan-out and does not withdraw prior items', async () => {
    await unfollowCollection(COLLECTION_FOLLOWER);
    await enqueue('cf-feed-after-unfollow');
    const result = await project('cf-feed-after-unfollow', true);
    assert.equal(result.disposition, 'applied');
    assert.deepEqual(await recipients('cf-feed-after-unfollow'), [
      DUAL_FOLLOWER, OWNER_FOLLOWER,
    ]);
    assert.equal(await visibleCount('cf-feed-collection-only', COLLECTION_FOLLOWER), 1);
    // Reused current-authority predicate, not retrospective withdrawn.
    assert.equal(
      (await authorizedFeedEventIds(COLLECTION_FOLLOWER)).includes('cf-feed-collection-only'),
      false,
    );
    assert.equal(await visibleCount('cf-feed-after-unfollow', COLLECTION_FOLLOWER), 0);
  });
});
