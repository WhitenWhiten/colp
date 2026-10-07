import assert from 'node:assert/strict';
import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import { afterAll, beforeAll, test } from 'vitest';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import { PostgresOutboxRepository } from '../../../src/infrastructure/outbox/index.js';
import {
  createPostgresSocialFeedWorkerRepository,
  stableFeedItemId,
  stableIntentId,
} from '../../../src/infrastructure/social/index.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  executeWithoutPermanenceGuards,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';
import { seedProfileAndCollection } from '../../support/social-feed-fixture.js';

const ACTOR = 'IiIiIiIiIiIiIiIiIiIiIg';
const COLLECTION = 'Dw8PDw8PDw8PDw8PDw8PDw';
const PAGE_SIZE = 500;

type QueryText = string | { text?: string };

function queryText(input: QueryText): string {
  return typeof input === 'string' ? input : input.text ?? '';
}

function classifyWrite(sql: string): string | null {
  const normalized = sql.replace(/\s+/gu, ' ').trim().toLowerCase();
  if (!/^(insert|update|delete)\b/u.test(normalized)) return null;
  if (normalized.startsWith('insert') && normalized.includes('into social_feed_items')) {
    return 'feed_items';
  }
  if (normalized.includes('into resource_id_ledger')) return 'resource_ledger';
  if (normalized.startsWith('insert') && normalized.includes('into outbox_events')) {
    return 'notification_outbox';
  }
  if (normalized.includes('social_feed_watermarks')) return 'watermark';
  return 'other_write';
}

function wrapPoolConnect(
  pool: Pool,
  onClient: (client: PoolClient) => void,
): () => void {
  const originalConnect = pool.connect.bind(pool);
  pool.connect = (async (...args: never[]) => {
    const client = await originalConnect(...args);
    onClient(client);
    return client;
  }) as Pool['connect'];
  return () => {
    pool.connect = originalConnect;
  };
}

function spyQueryAfter(
  client: PoolClient,
  match: (text: string, params: unknown) => boolean,
  after: () => void,
): void {
  const originalQuery = client.query.bind(client);
  client.query = ((...args: unknown[]) => {
    const text = queryText(args[0] as QueryText);
    const params = args[1];
    const result = originalQuery(...args as Parameters<PoolClient['query']>) as
      Promise<QueryResult<QueryResultRow>> | QueryResult<QueryResultRow>;
    const finalize = (resolved: QueryResult<QueryResultRow>) => {
      if (match(text, params)) after();
      return resolved;
    };
    if (result && typeof (result as Promise<QueryResult<QueryResultRow>>).then === 'function') {
      return (result as Promise<QueryResult<QueryResultRow>>).then(finalize);
    }
    return finalize(result as QueryResult<QueryResultRow>);
  }) as PoolClient['query'];
}

describeWithPostgres('R5-05 batch live Feed fan-out writes', () => {
  let isolated: IsolatedPostgresRuntime;
  let outbox: PostgresOutboxRepository;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('phase5_fanout_batch', {
      maxConnections: 8,
      statementTimeoutMs: 120_000,
    });
    await runMigrations(isolated.runtime.db, 'latest');
    await seedProfileAndCollection(isolated, 'seed-recipient', ACTOR, COLLECTION);
    await isolated.runtime.pool.query(
      `delete from profiles where account_id='seed-recipient'`,
    );
    await isolated.runtime.pool.query(
      `delete from accounts where id='seed-recipient'`,
    );
    outbox = new PostgresOutboxRepository(isolated.runtime.pool);
  }, 120_000);

  afterAll(async () => {
    await isolated?.close();
  });

  function repository(emitNotificationIntents = true) {
    return createPostgresSocialFeedWorkerRepository(isolated.runtime.pool, {
      emitNotificationIntents,
    });
  }

  async function resetProjectionState(): Promise<void> {
    await executeWithoutPermanenceGuards(isolated.runtime.pool, `
      delete from outbox_events
       where handler_name in ('social.publish-collection-change','social_feed_item_notification')`);
    await isolated.runtime.pool.query('delete from social_feed_items');
    await isolated.runtime.pool.query('delete from social_feed_watermarks');
    await isolated.runtime.pool.query('delete from outbox_projection_watermarks');
    await isolated.runtime.pool.query('delete from follows');
    await isolated.runtime.pool.query(`
      delete from profiles where account_id <> $1`, [ACTOR]);
    await isolated.runtime.pool.query(`
      delete from accounts where id <> $1`, [ACTOR]);
    await isolated.runtime.pool.query(`
      update collections
         set visibility='public', deleted_at=null, publication_slug='feed-collection',
             published_at=coalesce(published_at, current_timestamp),
             policy_revision='p-live', commit_ordinal=1
       where id=$1`, [COLLECTION]);
    await isolated.runtime.pool.query(`
      update accounts set status='active', deleted_at=null where id=$1`, [ACTOR]);
  }

  async function seedFollowers(count: number, at = '2026-07-29T09:00:00Z'): Promise<string[]> {
    if (count === 0) return [];
    const client = await isolated.runtime.pool.connect();
    try {
      await client.query('begin');
      await client.query('set local statement_timeout = 0');
      await client.query('set local idle_in_transaction_session_timeout = 0');
      await client.query(`
        insert into accounts(id, subject_id, status)
        select 'r' || lpad(value::text, 5, '0'),
               'subject-r' || lpad(value::text, 5, '0'),
               'active'
          from generate_series(1, $1) value`, [count]);
      await client.query(`
        insert into profiles(account_id, display_name)
        select id, id from accounts where id like 'r%'`);
      await client.query(`
        insert into follows(actor_profile_id, target_profile_id, followed_at)
        select id, $1, $2::timestamptz from accounts where id like 'r%'`, [ACTOR, at]);
      await client.query('commit');
    } catch (error: unknown) {
      await client.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    const rows = await isolated.runtime.pool.query<{ actor_profile_id: string }>(`
      select actor_profile_id from follows
       where target_profile_id=$1
       order by actor_profile_id`, [ACTOR]);
    return rows.rows.map((row) => row.actor_profile_id);
  }

  async function enqueue(eventId: string, ordinal: number): Promise<void> {
    const occurredAt = '2026-07-29T10:00:00.000Z';
    const payload: Record<string, unknown> = {
      collectionId: COLLECTION,
      ownerProfileId: ACTOR,
      publicationRevision: `c${ordinal}.p${ordinal}`,
      discoverabilityRecheckKey: `publication.collection:${COLLECTION}`,
      producerDiscoverability: 'public_candidate',
    };
    await isolated.runtime.pool.query(`
      insert into resource_id_ledger(resource_id, resource_type, committed_at)
      values ($1, 'outbox', current_timestamp)
      on conflict (resource_id) do nothing`, [eventId]);
    await isolated.runtime.pool.query(`
      insert into outbox_events(
        outbox_id, domain_event_id, event_type, event_version, handler_name, handler_mode,
        aggregate_type, aggregate_id, aggregate_scope, aggregate_revision, commit_ordinal,
        occurred_at, payload_json, state, attempt_count, available_at, lease_generation)
      values ($1, $1, 'social.collection-change', 2, 'social.publish-collection-change',
        'projection_latest_only', 'collection', $2, $2, $3, $4, $5, $6,
        'pending', 0, current_timestamp, 0)`,
    [eventId, COLLECTION, `c${ordinal}.p${ordinal}`, ordinal, occurredAt, payload]);
  }

  async function projectDirect(eventId: string, options: {
    readonly maxRecipients?: number;
    readonly emitNotificationIntents?: boolean;
    readonly signal?: AbortSignal;
    readonly collectWrites?: boolean;
  } = {}): Promise<{
    readonly disposition: string;
    readonly itemCount: number;
    readonly writes: string[];
    readonly statements: string[];
  }> {
    const claim = await outbox.claim(30_000);
    assert.equal(claim?.outboxId, eventId);
    const writes: string[] = [];
    const statements: string[] = [];
    const restore = options.collectWrites === false
      ? () => undefined
      : wrapPoolConnect(isolated.runtime.pool, (client) => {
        const originalQuery = client.query.bind(client);
        client.query = ((...args: unknown[]) => {
          const text = queryText(args[0] as QueryText);
          statements.push(text);
          const kind = classifyWrite(text);
          if (kind) writes.push(kind);
          return originalQuery(...args as Parameters<PoolClient['query']>);
        }) as PoolClient['query'];
      });
    try {
      const result = await repository(options.emitNotificationIntents ?? true)
        .projectCollectionChange({
          event: {
            eventId: claim!.eventId,
            eventVersion: claim!.eventVersion as 1 | 2,
            collectionId: claim!.aggregateScope,
            ownerProfileId: ACTOR,
            publicationRevision: claim!.aggregateRevision,
            discoverabilityRecheckKey: `publication.collection:${COLLECTION}`,
            producerDiscoverability: 'public_candidate',
            commitOrdinal: claim!.commitOrdinal,
            occurredAt: claim!.occurredAt,
          },
          attempt: {
            outboxId: claim!.outboxId,
            leaseGeneration: claim!.leaseGeneration,
          },
          maxRecipients: options.maxRecipients ?? PAGE_SIZE,
          signal: options.signal ?? new AbortController().signal,
        });
      return { ...result, writes, statements };
    } finally {
      restore();
    }
  }

  async function itemRows(eventId: string): Promise<Array<{
    feed_item_id: string;
    recipient_profile_id: string;
  }>> {
    const rows = await isolated.runtime.pool.query<{
      feed_item_id: string;
      recipient_profile_id: string;
    }>(`
      select feed_item_id, recipient_profile_id
        from social_feed_items
       where source_event_id=$1
       order by recipient_profile_id`, [eventId]);
    return rows.rows;
  }

  async function intentCount(eventId: string): Promise<number> {
    const rows = await isolated.runtime.pool.query<{ count: number }>(`
      select count(*)::int as count from outbox_events
       where event_type='social.feed-item-published'
         and payload_json->>'sourceEventId'=$1`, [eventId]);
    return rows.rows[0]!.count;
  }

  async function ledgerIntentCount(feedItemIds: readonly string[]): Promise<number> {
    if (feedItemIds.length === 0) return 0;
    const eventIds = feedItemIds.map((id) => stableIntentId('event', id));
    const outboxIds = feedItemIds.map((id) => stableIntentId('outbox', id));
    const rows = await isolated.runtime.pool.query<{ count: number }>(`
      select count(*)::int as count from resource_id_ledger
       where resource_id = any($1::text[])`, [[...eventIds, ...outboxIds]]);
    return rows.rows[0]!.count;
  }

  async function watermark(): Promise<{
    last_commit_ordinal: string;
    fanout_source_event_id: string | null;
    fanout_after_recipient_profile_id: string | null;
  }> {
    const rows = await isolated.runtime.pool.query<{
      last_commit_ordinal: string;
      fanout_source_event_id: string | null;
      fanout_after_recipient_profile_id: string | null;
    }>(`
      select last_commit_ordinal::text,
             fanout_source_event_id,
             fanout_after_recipient_profile_id
        from social_feed_watermarks
       where aggregate_scope=$1`, [COLLECTION]);
    return rows.rows[0] ?? {
      last_commit_ordinal: '0',
      fanout_source_event_id: null,
      fanout_after_recipient_profile_id: null,
    };
  }

  function countSetWrites(writes: readonly string[], kind: string): number {
    return writes.filter((entry) => entry === kind).length;
  }

  async function preInsertFeedItem(
    eventId: string,
    ordinal: number,
    recipient: string,
    feedItemId: string,
  ): Promise<void> {
    await isolated.runtime.pool.query(`
      insert into social_feed_items(
        feed_item_id, source_event_id, kind, recipient_profile_id, actor_profile_id,
        collection_id, source_event_version, source_commit_ordinal, publication_revision,
        discoverability_recheck_key, published_at, retain_until)
      values ($1, $2, 'collection_change', $3, $4, $5, 2, $6,
        $7, $8, '2026-07-29T10:00:00Z',
        '2026-07-29T10:00:00Z'::timestamptz + interval '90 days')`,
    [
      feedItemId, eventId, recipient, ACTOR, COLLECTION, ordinal,
      `c${ordinal}.p${ordinal}`, `publication.collection:${COLLECTION}`,
    ]);
  }

  test('0/1/500 recipient slices use stable ids, exact-once rows, and fixed write SQL', async () => {
    for (const count of [0, 1, 500] as const) {
      await resetProjectionState();
      const expected = await seedFollowers(count);
      const eventId = `batch-size-${count}`;
      await enqueue(eventId, 300 + count);

      const projected = await projectDirect(eventId, {
        emitNotificationIntents: true,
        collectWrites: true,
      });
      assert.equal(projected.disposition, 'applied', `count=${count}`);
      assert.equal(projected.itemCount, count, `itemCount count=${count}`);

      const items = await itemRows(eventId);
      assert.deepEqual(
        items.map((row) => row.recipient_profile_id),
        expected,
        `recipients count=${count}`,
      );
      for (const row of items) {
        assert.equal(row.feed_item_id, stableFeedItemId(eventId, row.recipient_profile_id));
      }
      assert.equal(await intentCount(eventId), count, `intents count=${count}`);
      assert.equal(
        await ledgerIntentCount(items.map((row) => row.feed_item_id)),
        count * 2,
        `ledger count=${count}`,
      );

      const feedWrites = countSetWrites(projected.writes, 'feed_items');
      const ledgerWrites = countSetWrites(projected.writes, 'resource_ledger');
      const outboxWrites = countSetWrites(projected.writes, 'notification_outbox');
      if (count === 0) {
        assert.equal(feedWrites, 0, 'empty page skips Feed INSERT');
        assert.equal(ledgerWrites, 0);
        assert.equal(outboxWrites, 0);
      } else {
        assert.equal(feedWrites, 1, `Feed INSERT must be one UNNEST write count=${count}`);
        assert.equal(ledgerWrites, 1, `ledger batch write count=${count}`);
        assert.equal(outboxWrites, 1, `outbox batch write count=${count}`);
        assert.ok(
          projected.statements.some((sql) => /unnest/iu.test(sql) && /social_feed_items/iu.test(sql)),
          `Feed INSERT must use UNNEST count=${count}`,
        );
      }
      assert.ok(
        projected.writes.length < 40,
        `write query count must stay bounded count=${count}: ${projected.writes.length}`,
      );
      assert.equal((await watermark()).last_commit_ordinal, String(300 + count));
    }
  }, 180_000);

  test('write query count does not grow linearly from 1 to 500 recipients', async () => {
    const samples: Array<{ count: number; writes: number; setWrites: number }> = [];
    for (const count of [1, 500] as const) {
      await resetProjectionState();
      await seedFollowers(count);
      const eventId = `batch-spy-${count}`;
      await enqueue(eventId, 400 + count);
      const projected = await projectDirect(eventId, {
        emitNotificationIntents: true,
        collectWrites: true,
      });
      const setWrites = countSetWrites(projected.writes, 'feed_items')
        + countSetWrites(projected.writes, 'resource_ledger')
        + countSetWrites(projected.writes, 'notification_outbox');
      samples.push({
        count,
        writes: projected.writes.length,
        setWrites,
      });
      assert.equal(setWrites, 3, `fixed set writes for count=${count}`);
    }
    assert.equal(samples[0]!.setWrites, samples[1]!.setWrites);
    assert.ok(
      Math.abs(samples[0]!.writes - samples[1]!.writes) <= 2,
      `total writes must stay flat: ${JSON.stringify(samples)}`,
    );
    assert.ok(
      samples[1]!.writes < 50,
      '500-recipient slice must use a fixed SQL budget, not O(n) writes',
    );
  }, 180_000);

  test('partial and all-conflict pages keep candidate cursor and exact-once intents', async () => {
    await resetProjectionState();
    const expected = await seedFollowers(4);
    const eventId = 'batch-partial-conflict';
    await enqueue(eventId, 410);
    await preInsertFeedItem(eventId, 410, expected[0]!, `pre-${expected[0]!}`);
    await preInsertFeedItem(eventId, 410, expected[3]!, `pre-${expected[3]!}`);

    const projected = await projectDirect(eventId, {
      maxRecipients: 4,
      emitNotificationIntents: true,
      collectWrites: true,
    });
    assert.equal(projected.disposition, 'applied');
    assert.equal(projected.itemCount, 2);
    const items = await itemRows(eventId);
    assert.deepEqual(items.map((row) => row.recipient_profile_id), expected);
    assert.equal(await intentCount(eventId), 2);
    const newFeedIds = items
      .filter((row) => row.recipient_profile_id === expected[1]
        || row.recipient_profile_id === expected[2])
      .map((row) => row.feed_item_id);
    assert.equal(newFeedIds.length, 2);
    for (const row of items) {
      if (row.recipient_profile_id === expected[1] || row.recipient_profile_id === expected[2]) {
        assert.equal(row.feed_item_id, stableFeedItemId(eventId, row.recipient_profile_id));
      }
    }
    assert.equal(await ledgerIntentCount(newFeedIds), 4);
    assert.equal(countSetWrites(projected.writes, 'feed_items'), 1);
    assert.equal(countSetWrites(projected.writes, 'resource_ledger'), 1);
    assert.equal(countSetWrites(projected.writes, 'notification_outbox'), 1);
    assert.equal((await watermark()).last_commit_ordinal, '410');

    await resetProjectionState();
    const all = await seedFollowers(3);
    const allEvent = 'batch-all-conflict';
    await enqueue(allEvent, 411);
    for (const recipient of all) {
      await preInsertFeedItem(allEvent, 411, recipient, `pre-all-${recipient}`);
    }
    const allProjected = await projectDirect(allEvent, {
      maxRecipients: 2,
      emitNotificationIntents: true,
      collectWrites: true,
    });
    assert.equal(allProjected.disposition, 'continued');
    assert.equal(allProjected.itemCount, 0);
    assert.equal(await intentCount(allEvent), 0);
    assert.equal(countSetWrites(allProjected.writes, 'feed_items'), 1);
    assert.equal(countSetWrites(allProjected.writes, 'resource_ledger'), 0);
    assert.equal(countSetWrites(allProjected.writes, 'notification_outbox'), 0);
    const mark = await watermark();
    assert.equal(mark.fanout_source_event_id, allEvent);
    assert.equal(mark.fanout_after_recipient_profile_id, all[1]);
    assert.equal(mark.last_commit_ordinal, '0');
  }, 120_000);

  test('corner: last-item conflict still advances candidate cursor; duplicate slice is exact-once', async () => {
    await resetProjectionState();
    const expected = await seedFollowers(3);
    const eventId = 'batch-last-conflict';
    await enqueue(eventId, 420);
    await preInsertFeedItem(eventId, 420, expected[1]!, `pre-last-${expected[1]!}`);

    const first = await projectDirect(eventId, {
      maxRecipients: 2,
      emitNotificationIntents: true,
    });
    assert.equal(first.disposition, 'continued');
    assert.equal(first.itemCount, 1);
    assert.equal((await watermark()).fanout_after_recipient_profile_id, expected[1]);
    assert.equal(await intentCount(eventId), 1);

    // Park Notification intents so reclaim targets the fan-out row, not delivery_each_event.
    await isolated.runtime.pool.query(`
      update outbox_events
         set state='completed', locked_until=null
       where event_type='social.feed-item-published'
         and payload_json->>'sourceEventId'=$1`, [eventId]);
    await isolated.runtime.pool.query(`
      update outbox_events
         set state='pending', locked_until=null, available_at=current_timestamp
       where outbox_id=$1`, [eventId]);
    await isolated.runtime.pool.query(`
      update social_feed_watermarks
         set fanout_after_recipient_profile_id=null,
             fanout_candidate_count=0,
             state_revision=state_revision+1
       where aggregate_scope=$1`, [COLLECTION]);
    const replay = await projectDirect(eventId, {
      maxRecipients: 2,
      emitNotificationIntents: true,
    });
    assert.equal(replay.disposition, 'continued');
    assert.equal(replay.itemCount, 0);
    assert.equal(await intentCount(eventId), 1);
    assert.deepEqual(
      (await itemRows(eventId)).map((row) => row.recipient_profile_id).slice(0, 2),
      expected.slice(0, 2),
    );
  }, 60_000);

  test('corner: Feed insert success with intent failure rolls back; ledger id conflict rolls back', async () => {
    await resetProjectionState();
    const followers = await seedFollowers(2);
    const eventId = 'batch-intent-fail';
    await enqueue(eventId, 430);
    await isolated.runtime.pool.query(`
      create function r505_fail_intent_outbox() returns trigger language plpgsql as $$
      begin
        raise exception 'injected notification outbox failure';
      end $$`);
    await isolated.runtime.pool.query(`
      create trigger r505_fail_intent_outbox
        before insert on outbox_events
        for each row
        when (new.event_type = 'social.feed-item-published')
        execute function r505_fail_intent_outbox()`);

    await assert.rejects(
      projectDirect(eventId, { emitNotificationIntents: true }),
      /injected notification outbox failure/u,
    );
    assert.equal((await itemRows(eventId)).length, 0);
    assert.equal(await intentCount(eventId), 0);
    assert.equal((await watermark()).fanout_source_event_id, null);
    assert.equal((await watermark()).last_commit_ordinal, '0');

    await isolated.runtime.pool.query('drop trigger r505_fail_intent_outbox on outbox_events');
    await isolated.runtime.pool.query('drop function r505_fail_intent_outbox()');
    await isolated.runtime.pool.query(`
      update outbox_events set state='pending', locked_until=null, available_at=current_timestamp
       where outbox_id=$1`, [eventId]);

    const recipient = followers[0]!;
    const feedItemId = stableFeedItemId(eventId, recipient);
    const conflictLedgerId = stableIntentId('event', feedItemId);
    await isolated.runtime.pool.query(`
      insert into resource_id_ledger(resource_id, resource_type, committed_at)
      values ($1, 'notification-domain-event', current_timestamp)
      on conflict do nothing`, [conflictLedgerId]);

    await assert.rejects(
      projectDirect(eventId, { emitNotificationIntents: true }),
      /duplicate key|unique|resource_id/iu,
    );
    assert.equal((await itemRows(eventId)).length, 0);
    assert.equal(await intentCount(eventId), 0);
    assert.equal((await watermark()).last_commit_ordinal, '0');
  }, 60_000);

  test('corner: RETURNING order independence and abort at each set-write boundary rolls back', async () => {
    await resetProjectionState();
    const expected = await seedFollowers(3);
    const eventId = 'batch-returning-order';
    await enqueue(eventId, 440);
    const projected = await projectDirect(eventId, {
      emitNotificationIntents: true,
      collectWrites: true,
    });
    assert.equal(projected.disposition, 'applied');
    assert.equal(projected.itemCount, 3);
    const items = await itemRows(eventId);
    assert.deepEqual(items.map((row) => row.recipient_profile_id), expected);
    const intents = await isolated.runtime.pool.query<{
      aggregate_id: string;
      aggregate_scope: string;
      payload_json: Record<string, unknown>;
    }>(`
      select aggregate_id, aggregate_scope, payload_json
        from outbox_events
       where event_type='social.feed-item-published'
         and payload_json->>'sourceEventId'=$1
       order by aggregate_scope`, [eventId]);
    assert.equal(intents.rows.length, 3);
    for (const row of intents.rows) {
      const payload = row.payload_json;
      assert.equal(payload.feedItemId, row.aggregate_id);
      assert.equal(payload.recipientProfileId, row.aggregate_scope);
      assert.equal(
        payload.feedItemId,
        stableFeedItemId(eventId, String(payload.recipientProfileId)),
      );
      assert.ok(Buffer.byteLength(JSON.stringify(payload), 'utf8') <= 2_048);
    }

    await resetProjectionState();
    await seedFollowers(2);
    await enqueue('batch-abort-before', 441);
    const abortBefore = new AbortController();
    abortBefore.abort();
    await assert.rejects(
      projectDirect('batch-abort-before', { signal: abortBefore.signal, collectWrites: false }),
      /abort/iu,
    );
    assert.equal((await itemRows('batch-abort-before')).length, 0);

    await resetProjectionState();
    await seedFollowers(2);
    await enqueue('batch-abort-after-feed', 442);
    const abortAfterFeed = new AbortController();
    let sawFeedInsert = false;
    const restoreFeed = wrapPoolConnect(isolated.runtime.pool, (client) => {
      spyQueryAfter(
        client,
        (text) => /insert into social_feed_items/iu.test(text),
        () => {
          sawFeedInsert = true;
          abortAfterFeed.abort();
        },
      );
    });
    try {
      await assert.rejects(
        projectDirect('batch-abort-after-feed', {
          signal: abortAfterFeed.signal,
          collectWrites: false,
        }),
        /abort/iu,
      );
    } finally {
      restoreFeed();
    }
    assert.equal(sawFeedInsert, true);
    assert.equal((await itemRows('batch-abort-after-feed')).length, 0);
    assert.equal(await intentCount('batch-abort-after-feed'), 0);
    assert.equal((await watermark()).last_commit_ordinal, '0');

    await resetProjectionState();
    await seedFollowers(2);
    await enqueue('batch-abort-after-ledger', 443);
    const abortAfterLedger = new AbortController();
    let sawLedger = false;
    const restoreLedger = wrapPoolConnect(isolated.runtime.pool, (client) => {
      spyQueryAfter(
        client,
        (text, params) => {
          if (!/insert into resource_id_ledger/iu.test(text)) return false;
          const encoded = typeof params === 'undefined' ? text : `${text}:${JSON.stringify(params)}`;
          return /notification-domain-event|notification-outbox/iu.test(encoded);
        },
        () => {
          sawLedger = true;
          abortAfterLedger.abort();
        },
      );
    });
    try {
      await assert.rejects(
        projectDirect('batch-abort-after-ledger', {
          signal: abortAfterLedger.signal,
          collectWrites: false,
        }),
        /abort/iu,
      );
    } finally {
      restoreLedger();
    }
    assert.equal(sawLedger, true);
    assert.equal((await itemRows('batch-abort-after-ledger')).length, 0);
    assert.equal(await intentCount('batch-abort-after-ledger'), 0);

    await resetProjectionState();
    await seedFollowers(2);
    await enqueue('batch-abort-after-outbox', 444);
    const abortAfterOutbox = new AbortController();
    let sawOutbox = false;
    const restoreOutbox = wrapPoolConnect(isolated.runtime.pool, (client) => {
      spyQueryAfter(
        client,
        (text) => /insert into outbox_events/iu.test(text)
          && /social\.feed-item-published/iu.test(text),
        () => {
          sawOutbox = true;
          abortAfterOutbox.abort();
        },
      );
    });
    try {
      await assert.rejects(
        projectDirect('batch-abort-after-outbox', {
          signal: abortAfterOutbox.signal,
          collectWrites: false,
        }),
        /abort/iu,
      );
    } finally {
      restoreOutbox();
    }
    assert.equal(sawOutbox, true);
    assert.equal((await itemRows('batch-abort-after-outbox')).length, 0);
    assert.equal(await intentCount('batch-abort-after-outbox'), 0);
    assert.equal((await watermark()).last_commit_ordinal, '0');
  }, 120_000);

  test('array order of UNNEST inputs matches recipient page order for stable ids', async () => {
    await resetProjectionState();
    const expected = await seedFollowers(5);
    const eventId = 'batch-array-order';
    await enqueue(eventId, 450);
    let capturedRecipients: string[] | null = null;
    let capturedFeedIds: string[] | null = null;
    const restore = wrapPoolConnect(isolated.runtime.pool, (client) => {
      const originalQuery = client.query.bind(client);
      client.query = ((...args: unknown[]) => {
        const text = queryText(args[0] as QueryText);
        const params = args[1] as unknown[] | undefined;
        if (/insert into social_feed_items/iu.test(text) && /unnest/iu.test(text) && params) {
          const stringArrays = params.filter((value): value is string[] => (
            Array.isArray(value) && value.every((entry) => typeof entry === 'string')
          ));
          const recipients = stringArrays.find((value) => (
            value.length === expected.length && value[0] === expected[0]
          ));
          const feedIds = stringArrays.find((value) => (
            value.length === expected.length
            && value[0] === stableFeedItemId(eventId, expected[0]!)
          ));
          if (recipients && feedIds) {
            capturedRecipients = recipients;
            capturedFeedIds = feedIds;
          }
        }
        return originalQuery(...args as Parameters<PoolClient['query']>);
      }) as PoolClient['query'];
    });
    try {
      const result = await projectDirect(eventId, {
        emitNotificationIntents: true,
        collectWrites: false,
      });
      assert.equal(result.itemCount, 5);
    } finally {
      restore();
    }
    assert.deepEqual(capturedRecipients, expected);
    assert.deepEqual(
      capturedFeedIds,
      expected.map((recipient) => stableFeedItemId(eventId, recipient)),
    );
  }, 60_000);
});
