import assert from 'node:assert/strict';
import { afterAll, beforeAll, test } from 'vitest';
import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import { createPostgresCommunityRankingQueryUnitOfWork } from '../../../src/infrastructure/community/index.js';
import {
  createCommunityRankingCursorCodec,
  listCommunityRanking,
  parseCommunityRankingQuery,
} from '../../../src/modules/community/index.js';
import type { DatabaseSchema } from '../../../src/infrastructure/database/runtime.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';

/**
 * The ranking scan re-proves every candidate on the page. It must do that in
 * batches: `resolveMany` is optional on the port, so an infrastructure adapter
 * that omits it silently falls back to one `resolve` statement per candidate —
 * the application stays correct, the cost does not, and no behavioural test can
 * see the difference. `targets: { resolve }` alone looked fixed while the 512
 * serial resolves were fully intact.
 *
 * This pins the wiring by counting statements, using the batch `any(` form the
 * single-row path can never produce.
 */
describeWithPostgres('CS-02 ranking target resolution is batched', () => {
  let isolated: IsolatedPostgresRuntime;
  const statements: string[] = [];

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('community_ranking_batch');
    await runMigrations(isolated.runtime.db, 'latest');
  }, 120_000);
  afterAll(async () => isolated?.close());

  const OWNER = 'batch-owner-subject';
  const ENTRIES = 24;

  async function seedPublicCollection(index: number): Promise<string> {
    const collectionId = `batch-col-${String(index).padStart(3, '0')}`;
    const rootId = `root-${collectionId}`;
    const client = await isolated.runtime.pool.connect();
    try {
      await client.query('begin');
      await client.query(
        `insert into accounts(id,subject_id,status) values ($1,$2,'active')
         on conflict (id) do nothing`,
        [OWNER, OWNER],
      );
      await client.query(
        `insert into resource_id_ledger(resource_id,resource_type,committed_at)
         values($1,'collection',current_timestamp),($2,'node',current_timestamp)`,
        [collectionId, rootId],
      );
      await client.query(
        `insert into collections(
           id,owner_subject_id,title,kind,visibility,publication_slug,published_at,
           root_node_id,root_node_is_root,resource_revision,content_revision,policy_revision,
           commit_ordinal,created_at,updated_at)
         values($1,$2,$3,'bookmarks','public',$4,current_timestamp,$5,true,
           'r1','c1','p1',1,current_timestamp,current_timestamp)`,
        [collectionId, OWNER, `Batch collection ${index}`, `batch-slug-${index}`, rootId],
      );
      await client.query(
        `insert into nodes(
           id,collection_id,parent_id,kind,is_root,title,url,position_token,
           resource_revision,children_revision,created_at,updated_at)
         values($1,$2,null,'folder',true,'Root',null,null,'r1','ch1',current_timestamp,current_timestamp)`,
        [rootId, collectionId],
      );
      await client.query('commit');
    } catch (error) {
      await client.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    return collectionId;
  }

  test('one batch statement resolves a whole page, not one per candidate', async () => {
    const collections: string[] = [];
    for (let index = 0; index < ENTRIES; index += 1) collections.push(await seedPublicCollection(index));

    const snapshot = await isolated.runtime.pool.query<{ snapshot_id: string }>(
      `insert into community_rank_snapshots(score_version,item_count,created_at)
       values('hot-v1',$1,current_timestamp) returning snapshot_id`,
      [ENTRIES],
    );
    const snapshotId = snapshot.rows[0]!.snapshot_id;
    for (const [index, collectionId] of collections.entries()) {
      await isolated.runtime.pool.query(
        `insert into community_rank_entries(
           snapshot_id,position,target_kind,target_id,target_collection_id,target_series_id,
           target_generation,title,href,tags,language,up,down,first_vote_at,hot)
         values($1,$2,'collection',$3,null,null,'1',$4,$5,'[]'::jsonb,'en',1,0,null,$6)`,
        [snapshotId, index + 1, collectionId,
          `Entry ${index}`, `https://example.com/${index}`, 100 - index],
      );
    }

    statements.length = 0;
    const countingDb = new Kysely<DatabaseSchema>({
      dialect: new PostgresDialect({ pool: new Pool({ connectionString: isolated.databaseUrl }) }),
      log: (event) => { statements.push(event.query.sql); },
    });
    try {
      const uow = createPostgresCommunityRankingQueryUnitOfWork(countingDb);
      const page = await uow.execute((ports) => listCommunityRanking(ports, {
        viewer: { accountId: null, subjectId: null },
        query: parseCommunityRankingQuery({ limit: '10' }),
        cursorCodec: createCommunityRankingCursorCodec(Buffer.alloc(32, 11)),
      }));
      // A non-empty page proves the targets really resolved; without that the
      // statement assertions below would pass vacuously.
      assert.ok(page.items.length > 1, `expected a multi-entry page, got ${page.items.length}`);
      const batchStatements = statements.filter((sqlText) => sqlText.includes('any('));
      assert.equal(batchStatements.length, 1,
        `expected exactly one batched resolution statement, saw ${batchStatements.length}`);
      // The single-row path emits no `any(` at all, so its presence is the
      // wiring; its absence alongside a resolved page is the defect.
      const resolvedPerCandidate = statements.filter((sqlText) =>
        sqlText.includes('from collections') && !sqlText.includes('any('));
      assert.equal(resolvedPerCandidate.length, 0,
        'the per-candidate resolve path must not run once resolveMany is wired');
    } finally {
      await countingDb.destroy();
    }
  }, 120_000);
});
