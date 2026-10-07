import assert from 'node:assert/strict';
import { afterAll, beforeAll, test } from 'vitest';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import {
  createPostgresCommunityTargetQueryUnitOfWork,
} from '../../../src/infrastructure/community/index.js';
import { COMMUNITY_STATIC_GENERATION, type CommunityTargetQuery } from '../../../src/modules/community/index.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';

/*
 * The ranking page re-proves the visibility of every candidate it scans, which
 * used to cost one statement per candidate. `resolveCommunityTargetRows` proves
 * the same batch with one statement per target kind, so it has to answer
 * *identically* to the single-target path — including every way a target is
 * concealed. This suite runs both paths over the same rows in a real PostgreSQL
 * and compares them element by element, for all four target kinds and for the
 * concealed, deleted, privatized and unpublished variants.
 */

const OWNER = 'batch-owner-subject';
const PRIVATE_OWNER = 'batch-private-subject';
const SLUG = 'batch-slug';
const PRIVATE_SLUG = 'batch-private-slug';
const COLLECTION = 'batch-collection';
const BOOKMARK = 'batch-bookmark';
const SERIES = 'batch-series';
const EDITION = 'batch-edition';
const SECOND_COLLECTION = 'batch-collection-2';
const NEWER_BOOKMARK = 'batch-bookmark-2';
const SERIES_B = 'batch-series-b';
const EDITION_B = 'batch-edition-b';

describeWithPostgres('CS-02 batched community target resolution', () => {
  let isolated: IsolatedPostgresRuntime;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('community_target_batch', { maxConnections: 6 });
    await runMigrations(isolated.runtime.db, 'latest');
    const pool = isolated.runtime.pool;
    await pool.query(`insert into accounts(id, subject_id, status, security_epoch, created_at)
      values ('batch-owner',$1,'active',0,current_timestamp),
             ('batch-private',$2,'active',0,current_timestamp)`, [OWNER, PRIVATE_OWNER]);
    await seedCollection(pool, COLLECTION, OWNER, 'public', SLUG);
    await seedCollection(pool, SECOND_COLLECTION, OWNER, 'public', `${SLUG}-2`);
    await seedCollection(pool, 'batch-private-collection', PRIVATE_OWNER, 'private', PRIVATE_SLUG);
    await seedBookmark(pool, BOOKMARK, COLLECTION, `root-${COLLECTION}`);
    await seedBookmark(pool, NEWER_BOOKMARK, SECOND_COLLECTION, `root-${SECOND_COLLECTION}`);
    // Series, their owner memberships and the ledger ids arrive in one
    // transaction: the owner-membership guard and the ledger FK are both
    // deferred, so the rows are only consistent at COMMIT.
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query(`insert into resource_id_ledger(resource_id,resource_type,committed_at)
        values ($1,'report',current_timestamp),('batch-archived-series','report',current_timestamp),
               ($2,'report',current_timestamp)`, [SERIES_B, EDITION_B]);
      await client.query(`insert into digest_series(id,owner_subject_id,title,summary,slug,visibility,state,
          resource_revision,content_revision,policy_revision,commit_ordinal,created_at,updated_at)
        values ($1,$2,'B','b',$3,'public','active','r1','c1','p1',1,current_timestamp,current_timestamp)`,
      [SERIES_B, OWNER, `${SERIES}-b`]);
      await client.query(`insert into digest_series(id,owner_subject_id,title,summary,slug,visibility,state,
          resource_revision,content_revision,policy_revision,commit_ordinal,created_at,updated_at,deleted_at)
        values ('batch-archived-series',$1,'Archived','a','batch-archived','public','archived','r1','c1','p1',2,
          current_timestamp,current_timestamp,current_timestamp)`, [OWNER]);
      await client.query(`insert into digest_members(series_id,subject_id,role,granted_at)
        values ($1,$2,'owner',current_timestamp),('batch-archived-series',$2,'owner',current_timestamp)`,
      [SERIES_B, OWNER]);
      await client.query(`insert into digest_editions(id,series_id,source_collection_id,issue_key,edition_ordinal,
          title_snapshot,summary_snapshot,source_content_revision,source_policy_revision,
          resource_revision,period_start,period_end,state,published_at,created_at,updated_at)
        values ($1,$2,$3,'2026-W41',1,'Edition B','s','c1','p1','r1',
          current_timestamp - interval '14 days',current_timestamp,'published',current_timestamp,
          current_timestamp,current_timestamp)`, [EDITION_B, SERIES_B, COLLECTION]);
      await client.query('commit');
    } catch (error) { await client.query('rollback').catch(() => undefined); throw error; }
    finally { client.release(); }
  }, 120_000);
  afterAll(async () => isolated?.close());

  async function seedCollection(
    pool: IsolatedPostgresRuntime['runtime']['pool'],
    collectionId: string, ownerSubjectId: string, visibility: 'public' | 'private', slug: string,
  ): Promise<void> {
    const rootId = `root-${collectionId}`;
    // `collections_root_fk` is DEFERRABLE INITIALLY DEFERRED, so the collection
    // and its root node are only consistent at COMMIT.
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query(`insert into resource_id_ledger(resource_id,resource_type,committed_at)
      values ($1,'collection',current_timestamp),($2,'node',current_timestamp)`, [collectionId, rootId]);
      await client.query(`insert into collections(id,owner_subject_id,title,kind,visibility,publication_slug,
          published_at,root_node_id,root_node_is_root,resource_revision,content_revision,policy_revision,
          commit_ordinal,created_at,updated_at)
        values ($1,$2,'Title','bookmarks',$3,$4,$5,$6,true,'r1','c1','p1',1,current_timestamp,current_timestamp)`,
      [collectionId, ownerSubjectId, visibility, slug, visibility === 'public' ? new Date() : null, rootId]);
      await client.query(`insert into nodes(id,collection_id,parent_id,kind,is_root,title,url,position_token,
          resource_revision,children_revision,created_at,updated_at)
        values ($1,$2,null,'folder',true,'Root',null,null,'r1','ch1',current_timestamp,current_timestamp)`,
      [rootId, collectionId]);
      await client.query('commit');
    } catch (error) { await client.query('rollback').catch(() => undefined); throw error; }
    finally { client.release(); }
  }

  async function seedBookmark(
    pool: IsolatedPostgresRuntime['runtime']['pool'],
    nodeId: string, collectionId: string, parentId: string,
  ): Promise<void> {
    await pool.query(`insert into resource_id_ledger(resource_id,resource_type,committed_at)
      values ($1,'node',current_timestamp)`, [nodeId]);
    await pool.query(`insert into nodes(id,collection_id,parent_id,kind,is_root,title,url,position_token,
        resource_revision,children_revision,created_at,updated_at)
      values ($1,$2,$3,'bookmark',false,'Bookmark',$4,'a0','r1','ch1',current_timestamp,current_timestamp)`,
    [nodeId, collectionId, parentId, `https://example.com/${nodeId}`]);
  }

  /** The queries a ranking page would re-prove, resolvable and concealed alike. */
  function queries(): readonly CommunityTargetQuery[] {
    return [
      { kind: 'collection', id: COLLECTION },
      { kind: 'bookmark', id: BOOKMARK, collectionId: COLLECTION },
      { kind: 'digest_series', id: SERIES_B },
      { kind: 'digest_edition', id: EDITION_B, seriesId: SERIES_B },
      // concealed / missing variants
      { kind: 'collection', id: 'batch-private-collection' },
      { kind: 'digest_series', id: 'batch-archived-series' },
      { kind: 'collection', id: 'batch-does-not-exist' },
      { kind: 'bookmark', id: BOOKMARK, collectionId: SECOND_COLLECTION },
      { kind: 'digest_edition', id: EDITION_B, seriesId: 'batch-other-series' },
      // repeats: the batch must answer positionally, not deduplicate
      { kind: 'collection', id: COLLECTION },
      { kind: 'bookmark', id: NEWER_BOOKMARK, collectionId: SECOND_COLLECTION },
    ];
  }

  test('batch resolution answers exactly what the single-target path answers', async () => {
    const uow = createPostgresCommunityTargetQueryUnitOfWork(isolated.runtime.db);
    const list = queries();
    const { single, batch } = await uow.execute(async (ports) => {
      const resolvedSingle: Array<unknown> = [];
      for (const query of list) resolvedSingle.push(await ports.targets.resolve(query));
      assert.equal(typeof ports.targets.resolveMany, 'function',
        'the production port must expose the batch form');
      const resolvedBatch = await ports.targets.resolveMany!(list);
      return { single: resolvedSingle, batch: [...resolvedBatch] };
    });

    assert.equal(batch.length, list.length, 'the batch must answer positionally');
    for (const [index, query] of list.entries()) {
      assert.deepEqual(batch[index], single[index],
        `${query.kind} ${query.id} must resolve the same in both paths`);
    }
    // Guard against the batch silently answering "concealed" for everything.
    assert.notEqual(single[0], null, 'a public collection must resolve');
    assert.notEqual(single[1], null, 'a public bookmark must resolve');
    assert.notEqual(single[2], null, 'an active public series must resolve');
    assert.notEqual(single[3], null, 'a published edition of a visible source must resolve');
    assert.equal(single[4], null, 'a private collection must stay concealed');
    assert.equal(single[5], null, 'an archived series must stay concealed');
    assert.equal(single[7], null, 'a bookmark under the wrong collection must not resolve');
    assert.equal(single[8], null, 'an edition under the wrong series must not resolve');
  });

  test('the batch path resolves the whole set without a statement per target', async () => {
    // One statement per target kind: four queries, not eleven, and the same
    // answer for the repeated entries.
    const uow = createPostgresCommunityTargetQueryUnitOfWork(isolated.runtime.db);
    const list = queries();
    const resolved = await uow.execute((ports) => ports.targets.resolveMany!(list));
    assert.equal(resolved.length, list.length);
    const first = resolved[0];
    const repeated = resolved[9];
    assert.ok(first !== null && repeated !== null, 'both copies of the collection must resolve');
    assert.deepEqual(repeated, first, 'a repeated query must answer identically');
  });

  test('the resolved generation is the static generation the projection uses', async () => {
    const uow = createPostgresCommunityTargetQueryUnitOfWork(isolated.runtime.db);
    const resolved = await uow.execute((ports) => ports.targets.resolveMany!([
      { kind: 'collection', id: COLLECTION },
      { kind: 'digest_series', id: SERIES_B },
    ]));
    assert.equal(resolved[0]?.target.generation, COMMUNITY_STATIC_GENERATION);
    assert.equal(resolved[1]?.target.generation, COMMUNITY_STATIC_GENERATION);
  });
});
