import assert from 'node:assert/strict';
import type { PoolClient } from 'pg';
import { afterAll, beforeAll, test } from 'vitest';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import {
  createPostgresSocialFeedProjectionRepository,
} from '../../../src/infrastructure/social/index.js';
import type { SocialFeedItemInput } from '../../../src/modules/social/index.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';
import { seedProfileAndCollection } from '../../support/social-feed-fixture.js';

describeWithPostgres('P5-10 PostgreSQL Feed projection repository', () => {
  let isolated: IsolatedPostgresRuntime;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('phase5_feed_projection', { maxConnections: 8 });
    await runMigrations(isolated.runtime.db, 'latest');
    await seedProfileAndCollection(isolated, 'recipient', 'actor', 'collection');
  }, 120_000);
  afterAll(async () => isolated?.close());

  function item(overrides: Partial<SocialFeedItemInput> = {}): SocialFeedItemInput {
    return {
      feedItemId: '018f0e3d-dddd-7ddd-8ddd-dddddddddddd',
      sourceEventId: 'event-1', recipientProfileId: 'recipient', actorProfileId: 'actor',
      collectionId: 'collection', kind: 'collection_change' as const,
      sourceEventVersion: 2, sourceCommitOrdinal: '1',
      publicationRevision: 'c1.p1',
      discoverabilityRecheckKey: 'publication.collection:collection',
      publishedAt: new Date('2026-01-01T00:00:00Z'),
      ...overrides,
    };
  }

  test('two real connections produce one event/recipient winner', async () => {
    const first = await isolated.runtime.pool.connect();
    const second = await isolated.runtime.pool.connect();
    try {
      const [a, b] = await Promise.all([
        insertFeedItem(first, item()),
        insertFeedItem(second, item({
          feedItemId: '018f0e3d-eeee-7eee-8eee-eeeeeeeeeeee',
        })),
      ]);
      assert.equal([a, b].filter(Boolean).length, 1);
      const winners = await isolated.runtime.pool.query<{ feed_item_id: string }>(
        `select feed_item_id from social_feed_items
          where source_event_id='event-1' and recipient_profile_id='recipient'`,
      );
      assert.equal(winners.rowCount, 1);
      assert.ok([
        '018f0e3d-dddd-7ddd-8ddd-dddddddddddd',
        '018f0e3d-eeee-7eee-8eee-eeeeeeeeeeee',
      ].includes(winners.rows[0]!.feed_item_id));
    } finally {
      first.release();
      second.release();
    }
  });

  test('item state permits withdrawal but rejects resurrection and identity mutation', async () => {
    const repository = createPostgresSocialFeedProjectionRepository(isolated.runtime.pool);
    const saved = item({
      sourceEventId: 'event-transition',
      feedItemId: '018f0e3d-aaaa-7aaa-8aaa-aaaaaaaaaaaa',
    });
    await insertFeedItem(isolated.runtime.pool, saved);
    assert.equal(await repository.withdrawItem({
      feedItemId: saved.feedItemId, reason: 'discoverability_revoked',
    }), true);
    assert.equal(await repository.withdrawItem({
      feedItemId: saved.feedItemId, reason: 'source_removed',
    }), false);
    await rejectsConstraint(isolated.runtime.pool.query(
      `update social_feed_items set state='visible',withdrawn_at=null,withdrawal_reason=null
        where feed_item_id=$1`, [saved.feedItemId],
    ), 'social_feed_items_transition_guard');
    await rejectsConstraint(isolated.runtime.pool.query(
      `update social_feed_items set source_event_id='other' where feed_item_id=$1`, [saved.feedItemId],
    ), 'social_feed_items_transition_guard');
  });

  test('database rejects illegal initial item and watermark states', async () => {
    await rejectsConstraint(isolated.runtime.pool.query(`insert into social_feed_items(
      feed_item_id,source_event_id,kind,recipient_profile_id,actor_profile_id,collection_id,
      source_event_version,source_commit_ordinal,publication_revision,
      discoverability_recheck_key,published_at,retain_until,state,withdrawn_at,withdrawal_reason)
      values('illegal-item','illegal-event','collection_change','recipient','actor','collection',
        2,2,'c2.p2','publication.collection:collection',current_timestamp,
        current_timestamp + interval '90 days','withdrawn',current_timestamp,'source_removed')`),
    'social_feed_items_transition_guard');
    await rejectsConstraint(isolated.runtime.pool.query(`insert into social_feed_watermarks(
      aggregate_scope,last_commit_ordinal,last_source_event_id,state_revision)
      values('illegal-scope',5,'illegal-event',1)`),
    'social_feed_watermarks_transition_guard');
    await rejectsConstraint(isolated.runtime.pool.query(`insert into social_feed_items(
      feed_item_id,source_event_id,kind,recipient_profile_id,actor_profile_id,collection_id,
      source_event_version,source_commit_ordinal,publication_revision,
      discoverability_recheck_key,published_at,retain_until)
      values('bad-recheck-item','bad-recheck-event','collection_change','recipient','actor',
        'collection',2,3,'c3.p3','publication.collection:other',current_timestamp,
        current_timestamp + interval '90 days')`),
    'social_feed_items_recheck_binding');
  });

  test('watermark is monotonic and concurrent CAS has exactly one winner', async () => {
    const first = createPostgresSocialFeedProjectionRepository(isolated.runtime.pool);
    const second = createPostgresSocialFeedProjectionRepository(isolated.runtime.pool);
    const initial = await first.loadWatermark('collection');
    assert.ok(initial);
    assert.equal(initial.lastCommitOrdinal, '0');
    const outcomes = await Promise.all([
      first.advanceWatermark({ aggregateScope: 'collection', expectedStateRevision: 0n,
        nextCommitOrdinal: '10', sourceEventId: 'event-10' }),
      second.advanceWatermark({ aggregateScope: 'collection', expectedStateRevision: 0n,
        nextCommitOrdinal: '11', sourceEventId: 'event-11' }),
    ]);
    assert.equal(outcomes.filter((outcome) => outcome !== null).length, 1);
    const winner = await first.loadWatermark('collection');
    assert.ok(winner);
    assert.ok(['10', '11'].includes(winner.lastCommitOrdinal));
    assert.equal(await first.advanceWatermark({ aggregateScope: 'collection',
      expectedStateRevision: winner.stateRevision, nextCommitOrdinal: winner.lastCommitOrdinal,
      sourceEventId: 'event-stale' }), null);
  });

  test('watermark CAS loser rolls back its entire projection batch', async () => {
    const first = createPostgresSocialFeedProjectionRepository(isolated.runtime.pool);
    const second = createPostgresSocialFeedProjectionRepository(isolated.runtime.pool);
    const initial = await first.loadWatermark('collection');
    const results = await Promise.all([
      first.applyBatch({
        items: [item({ sourceEventId: 'event-batch-a', sourceCommitOrdinal: '30', feedItemId: '018f0e3d-1111-7111-8111-111111111111' })],
        watermark: { aggregateScope: 'collection', expectedStateRevision: initial.stateRevision,
          nextCommitOrdinal: '30', sourceEventId: 'event-batch-a' },
      }),
      second.applyBatch({
        items: [item({ sourceEventId: 'event-batch-b', sourceCommitOrdinal: '31', feedItemId: '018f0e3d-2222-7222-8222-222222222222' })],
        watermark: { aggregateScope: 'collection', expectedStateRevision: initial.stateRevision,
          nextCommitOrdinal: '31', sourceEventId: 'event-batch-b' },
      }),
    ]);
    assert.equal(results.filter(Boolean).length, 1);
    const rows = await isolated.runtime.pool.query<{ count: number }>(`
      select count(*)::int count from social_feed_items
       where source_event_id in ('event-batch-a','event-batch-b')`);
    assert.equal(rows.rows[0]?.count, 1);
  });

  test('item failure rolls back the watermark and projection batch atomically', async () => {
    const repository = createPostgresSocialFeedProjectionRepository(isolated.runtime.pool);
    await insertFeedItem(isolated.runtime.pool, item({
      sourceEventId: 'event-binding-conflict',
      feedItemId: '018f0e3d-3333-7333-8333-333333333333',
      sourceCommitOrdinal: '40',
    }));
    const before = await repository.loadWatermark('collection');
    await assert.rejects(repository.applyBatch({
      items: [item({
        sourceEventId: 'event-binding-conflict',
        feedItemId: '018f0e3d-4444-7444-8444-444444444444',
        sourceCommitOrdinal: '40',
        actorProfileId: 'recipient',
      })],
      watermark: {
        aggregateScope: 'collection',
        expectedStateRevision: before.stateRevision,
        nextCommitOrdinal: '40',
        sourceEventId: 'event-binding-conflict',
      },
    }), /binding conflicts with immutable facts/i);
    const after = await repository.loadWatermark('collection');
    assert.equal(after.stateRevision, before.stateRevision);
    assert.equal(after.lastCommitOrdinal, before.lastCommitOrdinal);
    assert.equal((await isolated.runtime.pool.query<{ count: number }>(`
      select count(*)::int count from social_feed_items
       where source_event_id='event-binding-conflict'`)).rows[0]?.count, 1);
  });

  test('rejects empty and oversized projection batches before database work', async () => {
    const repository = createPostgresSocialFeedProjectionRepository(isolated.runtime.pool);
    const watermark = {
      aggregateScope: 'collection', expectedStateRevision: 0n,
      nextCommitOrdinal: '50', sourceEventId: 'event-batch-bound',
    };
    await assert.rejects(repository.applyBatch({ items: [], watermark }), /between 1 and 1000/i);
    await assert.rejects(repository.applyBatch({
      items: Array.from({ length: 1_001 }, () => item()), watermark,
    }), /between 1 and 1000/i);
  });

  test('rebuild lifecycle captures a high watermark and only completes after reaching it', async () => {
    const repository = createPostgresSocialFeedProjectionRepository(isolated.runtime.pool);
    const current = await repository.loadWatermark('rebuild-scope');
    assert.ok(current);
    const rebuilding = await repository.beginRebuild({ aggregateScope: 'rebuild-scope',
      expectedStateRevision: current.stateRevision, capturedHighCommitOrdinal: '20',
      capturedHighSourceEventId: 'event-20' });
    assert.ok(rebuilding);
    assert.equal(rebuilding.projectionState, 'rebuilding');
    assert.equal(await repository.completeRebuild({ aggregateScope: 'rebuild-scope',
      expectedStateRevision: rebuilding.stateRevision }), null);
    const advanced = await repository.advanceWatermark({ aggregateScope: 'rebuild-scope',
      expectedStateRevision: rebuilding.stateRevision, nextCommitOrdinal: '21', sourceEventId: 'event-21' });
    assert.ok(advanced);
    assert.equal(await repository.completeRebuild({ aggregateScope: 'rebuild-scope',
      expectedStateRevision: advanced.stateRevision }), null);
    const replayed = await repository.advanceRebuild({ aggregateScope: 'rebuild-scope',
      expectedStateRevision: advanced.stateRevision, replayedCommitOrdinal: '20' });
    assert.ok(replayed);
    const live = await repository.completeRebuild({ aggregateScope: 'rebuild-scope',
      expectedStateRevision: replayed.stateRevision });
    assert.equal(live?.projectionState, 'live');
    await rejectsConstraint(isolated.runtime.pool.query(
      `update social_feed_watermarks set last_commit_ordinal=19 where aggregate_scope='rebuild-scope'`,
    ), 'social_feed_watermarks_transition_guard');
  });

  test('retention boundary is inclusive, bounded and leaves newer items', async () => {
    const repository = createPostgresSocialFeedProjectionRepository(isolated.runtime.pool);
    await insertFeedItem(isolated.runtime.pool, item({ sourceEventId: 'event-expired', feedItemId: '018f0e3d-bbbb-7bbb-8bbb-bbbbbbbbbbbb', publishedAt: new Date('2025-01-01T00:00:00Z') }));
    await insertFeedItem(isolated.runtime.pool, item({ sourceEventId: 'event-boundary', feedItemId: '018f0e3d-cccc-7ccc-8ccc-cccccccccccc', publishedAt: new Date('2025-01-02T00:00:00Z') }));
    await insertFeedItem(isolated.runtime.pool, item({ sourceEventId: 'event-newer', feedItemId: '018f0e3d-ffff-7fff-8fff-ffffffffffff', publishedAt: new Date('2025-01-02T00:00:01Z') }));
    const result = await repository.purgeExpiredItems({
      cutoff: new Date('2025-04-02T00:00:00Z'), limit: 2,
    });
    assert.equal(result.deletedCount, 2);
    assert.deepEqual(new Set(result.feedItemIds), new Set([
      '018f0e3d-bbbb-7bbb-8bbb-bbbbbbbbbbbb', '018f0e3d-cccc-7ccc-8ccc-cccccccccccc',
    ]));
    assert.equal((await isolated.runtime.pool.query<{ count: number }>(
      `select count(*)::int count from social_feed_items where source_event_id='event-newer'`,
    )).rows[0]?.count, 1);

    await insertFeedItem(isolated.runtime.pool, item({
      sourceEventId: 'event-database-clock',
      feedItemId: '018f0e3d-9999-7999-8999-999999999999',
      publishedAt: new Date(),
    }));
    const futureCutoff = new Date(Date.now() + 100 * 24 * 60 * 60 * 1_000);
    const guarded = await repository.purgeExpiredItems({ cutoff: futureCutoff, limit: 10_000 });
    assert.equal(guarded.feedItemIds.includes('018f0e3d-9999-7999-8999-999999999999'), false);
  });
});

async function insertFeedItem(
  client: Pick<PoolClient, 'query'>,
  input: SocialFeedItemInput,
): Promise<boolean> {
  const result = await client.query(`insert into social_feed_items(
    feed_item_id,source_event_id,kind,recipient_profile_id,actor_profile_id,collection_id,
    source_event_version,source_commit_ordinal,publication_revision,
    discoverability_recheck_key,published_at,retain_until)
    values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11::timestamptz + interval '90 days')
    on conflict (source_event_id,recipient_profile_id) do nothing
    returning feed_item_id`, [
    input.feedItemId, input.sourceEventId, input.kind, input.recipientProfileId,
    input.actorProfileId, input.collectionId, input.sourceEventVersion,
    input.sourceCommitOrdinal, input.publicationRevision,
    input.discoverabilityRecheckKey, input.publishedAt,
  ]);
  return result.rowCount === 1;
}

async function rejectsConstraint(promise: Promise<unknown>, constraint: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.equal((error as { constraint?: unknown }).constraint, constraint);
    return true;
  });
}
