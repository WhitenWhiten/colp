import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, test } from 'vitest';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import {
  createPostgresCommunityRankingRefreshUnitOfWork,
} from '../../../src/infrastructure/community/index.js';
import {
  COMMUNITY_RANK_SNAPSHOT_RETENTION_MS,
  refreshCommunityRanking,
} from '../../../src/modules/community/application/community-ranking-refresh.js';
import { computeCommunityHotScore } from '../../../src/modules/community/community-hot-score.js';
import { COMMUNITY_STATIC_GENERATION } from '../../../src/modules/community/index.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';

/*
 * CS-02/CS-07 clock discipline for the durable ranking refresh: the real
 * `createPostgresCommunityRankingRefreshUnitOfWork` runs
 * `refreshCommunityRanking` inside one PostgreSQL transaction while the
 * clock port — the designed injection seam — returns a single fixed
 * instant. The test proves that the snapshot `created_at`, the hot-score
 * input instant, and the pruning cutoff all derive from that SAME instant,
 * and that the persisted timestamptz is the UTC-equivalent instant
 * independent of session time zone.
 */

const FIXED = new Date('2026-03-04T05:06:07.890Z');
const FIRST_VOTE_AT = new Date('2026-02-20T00:00:00.000Z');

describeWithPostgres('CS-02 rank refresh fixed-clock consistency', () => {
  let isolated: IsolatedPostgresRuntime;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('community_clock_consistency', { maxConnections: 8 });
    await runMigrations(isolated.runtime.db, 'latest');
  }, 120_000);
  afterAll(async () => isolated?.close());

  async function seedFixture(collectionId: string, ownerSubjectId: string): Promise<void> {
    const rootId = `root-${collectionId}`;
    const client = await isolated.runtime.pool.connect();
    try {
      await client.query('begin');
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
      [collectionId, ownerSubjectId, 'Clock target', `clk-${collectionId}`, rootId]);
      await client.query(`insert into nodes(
        id,collection_id,parent_id,kind,is_root,title,url,position_token,
        resource_revision,children_revision,created_at,updated_at)
        values($1,$2,null,'folder',true,'Root',null,null,'r1','ch1',
          current_timestamp,current_timestamp)`, [rootId, collectionId]);
      // One accepted upvote with a known first-vote instant — the score the
      // refresh computes must be reproducible from (counts, firstVoteAt, now).
      // community_votes.account_id references accounts.id, so seed the voter.
      // The eligibility predicate inner-joins accounts on the collection
      // owner, so the owner subject needs an active account row too.
      await client.query(`insert into accounts(
        id,subject_id,status,email,security_epoch,created_at,deleted_at)
        values($1,$2,'active',null,0,current_timestamp,null),
          ($3,$4,'active',null,0,current_timestamp,null)`,
      [`acct-${collectionId}`, `subj-${collectionId}`, `acct-owner-${collectionId}`, ownerSubjectId]);
      await client.query(`insert into community_votes(
        target_kind,target_id,target_collection_id,target_series_id,
        target_generation,account_id,value)
        values('collection',$1,null,null,$2,$3,1)`,
      [collectionId, COMMUNITY_STATIC_GENERATION, `acct-${collectionId}`]);
      await client.query(`insert into community_vote_targets(
        target_kind,target_id,target_collection_id,target_series_id,
        target_generation,first_vote_at)
        values('collection',$1,null,null,$2,$3)`,
      [collectionId, COMMUNITY_STATIC_GENERATION, FIRST_VOTE_AT]);
      // Two stale snapshots straddling the retention horizon measured from
      // FIXED: one strictly older (must be pruned), one newer (must survive).
      await client.query(
        `insert into community_rank_snapshots(score_version,item_count,created_at)
         values('hot-v1',0,$1),('hot-v1',0,$2)`, [
        new Date(FIXED.getTime() - COMMUNITY_RANK_SNAPSHOT_RETENTION_MS - 60_000),
        new Date(FIXED.getTime() - COMMUNITY_RANK_SNAPSHOT_RETENTION_MS + 60_000),
      ]);
      await client.query('commit');
    } catch (error) {
      await client.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  test('created_at, score instant, and prune cutoff all share the injected instant', async () => {
    const collectionId = `clk-${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    await seedFixture(collectionId, 'clock-owner');
    const staleCount = await isolated.runtime.pool.query<{ count: string }>(
      `select count(*)::text count from community_rank_snapshots`, []);
    assert.equal(staleCount.rows[0]?.count, '2');

    const refresh = createPostgresCommunityRankingRefreshUnitOfWork(isolated.runtime.db);
    const result = await refresh.execute((ports) =>
      refreshCommunityRanking({ ...ports, clock: { now: async () => FIXED } }));
    assert.equal(result.itemCount, 1);
    assert.equal(result.prunedSnapshots, 1,
      'exactly the snapshot older than FIXED - retention is pruned');

    // created_at IS the injected instant — the same value the score and the
    // prune cutoff consumed (one transaction, one instant).
    const snapshot = await isolated.runtime.pool.query<{
      epoch_ms: string; utc_text: string; score_version: string }>(
      `select round(extract(epoch from created_at) * 1000)::bigint::text epoch_ms,
              to_char(created_at at time zone 'UTC',
                      'YYYY-MM-DD HH24:MI:SS.MS') utc_text,
              score_version
       from community_rank_snapshots where snapshot_id=$1`,
      [result.snapshotId]);
    assert.equal(snapshot.rows[0]?.epoch_ms, String(FIXED.getTime()),
      'snapshot created_at is the injected instant to the millisecond');
    assert.equal(snapshot.rows[0]?.utc_text, '2026-03-04 05:06:07.890',
      'the stored instant renders as the same UTC wall clock');

    // The score input instant is FIXED: recomputing hot-v1 with now=FIXED
    // reproduces the persisted score bit-for-bit.
    const entry = await isolated.runtime.pool.query<{
      hot: number; up: number; down: number; first_vote_at: Date }>(
      `select hot, up, down, first_vote_at from community_rank_entries
       where snapshot_id=$1 and target_id=$2`, [result.snapshotId, collectionId]);
    assert.equal(entry.rows[0]?.up, 1);
    assert.equal(entry.rows[0]?.down, 0);
    assert.equal(entry.rows[0]?.first_vote_at.getTime(), FIRST_VOTE_AT.getTime(),
      'the first-vote instant round-trips through timestamptz');
    const expected = computeCommunityHotScore({
      up: 1, down: 0, firstVoteAt: FIRST_VOTE_AT, now: FIXED });
    assert.ok(Math.abs(entry.rows[0]!.hot - expected) < 1e-12,
      `persisted hot ${entry.rows[0]?.hot} must equal hot-v1 recomputed at FIXED (${expected})`);

    // The surviving stale snapshot is the one newer than FIXED - retention —
    // the cutoff the same transaction derived from the same instant.
    const survivors = await isolated.runtime.pool.query<{ epoch_ms: string }>(
      `select round(extract(epoch from created_at) * 1000)::bigint::text epoch_ms
       from community_rank_snapshots where snapshot_id <> $1`, [result.snapshotId]);
    assert.equal(survivors.rows.length, 1);
    assert.equal(survivors.rows[0]?.epoch_ms,
      String(FIXED.getTime() - COMMUNITY_RANK_SNAPSHOT_RETENTION_MS + 60_000));
  }, 60_000);
});
