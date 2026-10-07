import assert from 'node:assert/strict';
import { afterAll, beforeAll, test } from 'vitest';
import { createPostgresCommunityRankingRefreshUnitOfWork } from '../../../src/infrastructure/community/index.js';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import { refreshCommunityRanking } from '../../../src/modules/community/index.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';

/**
 * CS-02 scale guard: PostgreSQL caps a single statement at 65_535 bind
 * parameters, and each snapshot entry binds 15 columns — an unchunked
 * `community_rank_entries` insert fails once the eligible set passes
 * ~4.3k targets, leaving every later refresh aborted and the served
 * snapshot permanently stale. Seeding past that boundary proves the
 * batched writer persists the whole snapshot in one transaction.
 */
const BOOKMARK_COUNT = 4_400;

describeWithPostgres('CS-02 rank refresh snapshot scale', () => {
  let isolated: IsolatedPostgresRuntime;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('community_rank_scale', { maxConnections: 10 });
    await runMigrations(isolated.runtime.db, 'latest');
  }, 120_000);
  afterAll(async () => isolated?.close());

  test('refresh persists a snapshot larger than the PostgreSQL bind-parameter cap', async () => {
    const ownerId = 'scale-owner';
    const collectionId = 'scale-collection';
    const rootId = 'scale-root';
    const client = await isolated.runtime.pool.connect();
    try {
      await client.query('begin');
      await client.query(
        `insert into accounts(id, subject_id, status, security_epoch)
         values ($1, $1, 'active', 0)`, [ownerId]);
      await client.query(
        `insert into profiles(account_id, display_name, avatar_url)
         values ($1, 'Scale owner', null)`, [ownerId]);
      await client.query(
        `insert into resource_id_ledger(resource_id,resource_type,committed_at)
         values($1,'collection',current_timestamp),($2,'node',current_timestamp)`,
        [collectionId, rootId]);
      await client.query(`insert into collections(
        id,owner_subject_id,title,kind,visibility,publication_slug,published_at,
        root_node_id,root_node_is_root,resource_revision,content_revision,policy_revision,
        commit_ordinal,created_at,updated_at)
        values($1,$2,$3,'bookmarks','public',$4,current_timestamp,$5,true,
          'r1','c1','p1',1,current_timestamp,current_timestamp)`,
      [collectionId, ownerId, 'Scale target', 'scale-collection', rootId]);
      await client.query(`insert into nodes(
        id,collection_id,parent_id,kind,is_root,title,url,position_token,
        resource_revision,children_revision,created_at,updated_at)
        values($1,$2,null,'folder',true,'Root',null,null,'r1','ch1',
          current_timestamp,current_timestamp)`, [rootId, collectionId]);
      // Bulk-seed past the ~4.3k unchunked limit; the AFTER INSERT trigger
      // mints each bookmark's generation row in the same statement.
      await client.query(
        `insert into resource_id_ledger(resource_id,resource_type,committed_at)
         select 'scale-bm-' || g, 'node', current_timestamp
         from generate_series(1, $1) g`, [BOOKMARK_COUNT]);
      await client.query(`insert into nodes(
        id,collection_id,parent_id,kind,is_root,title,url,position_token,
        resource_revision,children_revision,created_at,updated_at)
        select 'scale-bm-' || g, $1, $2, 'bookmark', false, 'Bookmark ' || g,
          'https://example.com/' || g, 'b' || lpad(g::text, 7, '0'), 'r1', 'ch1',
          current_timestamp, current_timestamp
        from generate_series(1, $3) g`, [collectionId, rootId, BOOKMARK_COUNT]);
      await client.query('commit');
    } catch (error) {
      await client.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }

    const refresh = await createPostgresCommunityRankingRefreshUnitOfWork(isolated.runtime.db)
      .execute((ports) => refreshCommunityRanking({ ...ports,
        sources: { listCandidates: async () => { throw new Error('unbounded candidate materialization'); } },
        snapshots: { ...ports.snapshots,
          writeSnapshot: async () => { throw new Error('unbounded snapshot materialization'); } },
      }));

    // 1 collection + every seeded bookmark — the snapshot stores all of them.
    assert.equal(refresh.itemCount, BOOKMARK_COUNT + 1);
    const rows = await isolated.runtime.pool.query<{ entries: string; positions: string }>(
      `select count(*)::text as entries,
              count(distinct position)::text as positions
       from community_rank_entries
       where snapshot_id = $1`, [refresh.snapshotId]);
    assert.equal(rows.rows[0]?.entries, String(BOOKMARK_COUNT + 1));
    assert.equal(rows.rows[0]?.positions, String(BOOKMARK_COUNT + 1),
      'positions stay contiguous across batched inserts');
  }, 60_000);
});
