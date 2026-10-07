import assert from 'node:assert/strict';
import { afterAll, beforeAll, test } from 'vitest';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';
import { seedProfileAndCollection } from '../../support/social-feed-fixture.js';
import { buildFeedPageStatement } from '../../../src/infrastructure/social/index.js';

describeWithPostgres('P5-12 current-authorized Feed query plan', () => {
  let isolated: IsolatedPostgresRuntime;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('phase5_feed_plan', {
      maxConnections: 4, statementTimeoutMs: 120_000,
    });
    await runMigrations(isolated.runtime.db, 'latest');
    await seedProfileAndCollection(isolated, 'recipient', 'actor', 'collection');
    await isolated.runtime.pool.query(`insert into profile_handles(handle,account_id)
      values('recipient','recipient'),('actor','actor')`);
    await isolated.runtime.pool.query(`insert into follows(actor_profile_id,target_profile_id,followed_at)
      values('recipient','actor','2025-01-01T00:00:00Z')`);
    await isolated.runtime.pool.query(`insert into follows(actor_profile_id,target_profile_id,followed_at)
      values('actor','recipient','2025-01-01T00:00:00Z')`);
    await isolated.runtime.pool.query(`insert into social_feed_items(
      feed_item_id,source_event_id,kind,recipient_profile_id,actor_profile_id,collection_id,
      source_event_version,source_commit_ordinal,publication_revision,
      discoverability_recheck_key,published_at,retain_until)
      select lpad(i::text,36,'0'), 'event-'||lpad(i::text,10,'0'),
             case when i % 10 = 0 then 'collection_change' else 'follow_activity' end,
             'recipient','actor',
             case when i % 10 = 0 then 'collection' else null end,
             2,
             case when i % 10 = 0 then i else 0 end,
             case when i % 10 = 0 then 'revision-'||i else null end,
             case when i % 10 = 0 then 'publication.collection:collection'
                  else 'follow:actor:recipient' end,
             '2026-01-01T00:00:00Z'::timestamptz + (i||' seconds')::interval,
             '2026-04-01T00:00:00Z'::timestamptz + (i||' seconds')::interval
        from generate_series(1,10000) i`);
    await isolated.runtime.pool.query('analyze social_feed_items');
  }, 180_000);
  afterAll(async () => isolated?.close());

  test('uses recipient tuple index without Sort or Feed Seq Scan on first/middle/final pages', async () => {
    for (const offset of [null, 5_000, 9_900] as const) {
      const boundary = offset === null ? null : (await isolated.runtime.pool.query<{
        published_at: Date; source_event_id: string; feed_item_id: string;
      }>(`select published_at,source_event_id,feed_item_id from social_feed_items
          where recipient_profile_id='recipient' and state='visible'
          order by published_at desc,source_event_id desc,feed_item_id desc offset $1 limit 1`,
      [offset])).rows[0]!;
      const statement = buildFeedPageStatement({ principalId: 'recipient', limit: 99,
        ...(boundary ? { after: { publishedAt: boundary.published_at,
          sourceEventId: boundary.source_event_id, feedItemId: boundary.feed_item_id } } : {}) },
      { includeCollectionFollowers: true });
      const plan = await isolated.runtime.pool.query<{ 'QUERY PLAN': unknown }>(
        `explain (analyze,buffers,format json) ${statement.text}`, [...statement.values]);
      const text = JSON.stringify(plan.rows);
      assert.match(text, /social_feed_items_recipient_page_idx/u);
      assert.doesNotMatch(text, /"Node Type":"Sort"/u);
      assert.doesNotMatch(text, /"Node Type":"Seq Scan"[^}]*"Relation Name":"social_feed_items"/u);
    }
  }, 120_000);

  test('bounds filtered first/middle/final pages with an ordered recipient index', async () => {
    for (const offset of [null, 500, 900] as const) {
      const boundary = offset === null ? null : (await isolated.runtime.pool.query<{
        published_at: Date; source_event_id: string; feed_item_id: string;
      }>(`select published_at,source_event_id,feed_item_id from social_feed_items
          where recipient_profile_id='recipient' and kind='collection_change' and state='visible'
          order by published_at desc,source_event_id desc,feed_item_id desc offset $1 limit 1`,
      [offset])).rows[0]!;
      const statement = buildFeedPageStatement({ principalId: 'recipient', kind: 'collection_change',
        limit: 99, ...(boundary ? { after: { publishedAt: boundary.published_at,
          sourceEventId: boundary.source_event_id, feedItemId: boundary.feed_item_id } } : {}) },
      { includeCollectionFollowers: true });
      const plan = await isolated.runtime.pool.query<{ 'QUERY PLAN': unknown }>(
        `explain (analyze,buffers,format json) ${statement.text}`, [...statement.values]);
      const text = JSON.stringify(plan.rows);
      // With clustered heap data PostgreSQL can prefer the smaller recipient
      // index. Pin the scan budget, not a cost-based choice between two indexes.
      assert.match(text, /social_feed_items_recipient_(?:kind_)?page_idx/u);
      const feedScan = findFeedScan(plan.rows[0]?.['QUERY PLAN']);
      assert.ok(feedScan, 'the plan must expose its Feed index scan');
      assert.ok(feedScan['Actual Rows'] + (feedScan['Rows Removed by Filter'] ?? 0) <= 1_000,
        'at 10% kind selectivity a 100-row page must inspect at most 1,000 Feed rows');
      assert.doesNotMatch(text, /"Node Type":"Sort"/u);
      assert.doesNotMatch(text, /"Node Type":"Seq Scan"[^}]*"Relation Name":"social_feed_items"/u);
    }
  }, 120_000);

  test('uses the retention tuple index for a bounded purge candidate scan', async () => {
    const plan = await isolated.runtime.pool.query<{ 'QUERY PLAN': unknown }>(`
      explain (analyze,buffers,format json)
      select feed_item_id from social_feed_items
       where retain_until <= current_timestamp
       order by retain_until,feed_item_id
       for update skip locked limit 100`);
    const text = JSON.stringify(plan.rows);
    assert.match(text, /social_feed_items_retention_idx/u);
    assert.doesNotMatch(text, /"Node Type":"Sort"/u);
    assert.doesNotMatch(
      text,
      /"Node Type":"Seq Scan"[^}]*"Relation Name":"social_feed_items"/u,
    );
  });
});

interface FeedScan {
  readonly 'Actual Rows': number;
  readonly 'Rows Removed by Filter'?: number;
}

function findFeedScan(value: unknown): FeedScan | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const node = value as Record<string, unknown>;
  if (node['Relation Name'] === 'social_feed_items' && node['Node Type'] === 'Index Scan') {
    assert.equal(typeof node['Actual Rows'], 'number');
    return node as unknown as FeedScan;
  }
  for (const child of Object.values(node)) {
    const scan = findFeedScan(child);
    if (scan) return scan;
  }
  return undefined;
}
