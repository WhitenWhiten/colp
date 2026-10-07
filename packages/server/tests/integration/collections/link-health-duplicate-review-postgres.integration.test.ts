import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, test } from 'vitest';
import {
  createPostgresLinkHealthReadPort,
  createPostgresRelationMutationUnitOfWork,
} from '../../../src/infrastructure/collections/index.js';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import {
  RelationDeleteError,
  createProductLinkHealthCursorSigner,
  RelationCreateError,
  createRelation,
  deleteRelation,
  getMyLinkHealthPage,
  materializeCollectionPayload,
  materializeNodePayload,
  type CreateRelationInput,
  type DeleteRelationInput,
} from '../../../src/modules/collections/index.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
  truncateGuardedTablesInTransaction,
} from '../../support/postgres-test-runtime.js';

const NOW = new Date('2026-08-22T08:00:00.000Z');
const COLLECTION_ID = Buffer.alloc(16, 9).toString('base64url');
const OTHER_COLLECTION_ID = Buffer.alloc(16, 10).toString('base64url');
const ROOT_ID = 'lh-dup-root';
const FOLDER_ID = 'lh-dup-folder';
const ORIGINAL_ID = 'lh-dup-original';
const LATER_ID = 'lh-dup-later';
const OTHER_PARENT_ID = 'lh-dup-other-parent';
const OTHER_ROOT_ID = 'lh-dup-other-root';
const FOREIGN_ID = 'lh-dup-foreign';
const OWNER = 'subject-lh-dup-owner';
const URL = 'https://example.com/shared';

describeWithPostgres('P2-03 PostgreSQL duplicate review stays a private Relation', () => {
  let isolated: IsolatedPostgresRuntime;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('lh_dup_review', { maxConnections: 4 });
    await runMigrations(isolated.runtime.db, 'latest');
  }, 180_000);
  afterAll(async () => isolated?.close());
  beforeEach(async () => resetFixture());

  test('same URL different parent/title stay distinct; review and undo use duplicate_of ETag', async () => {
    const signer = createProductLinkHealthCursorSigner({
      current: { id: 'lh-dup-v1', key: 'link-health-dup-review-cursor-secret' },
    });
    try {
      const before = await getMyLinkHealthPage({
        reads: createPostgresLinkHealthReadPort(isolated.runtime.db),
        cursors: signer,
        clock: { now: async () => NOW },
      }, { actor: { subjectId: OWNER } });
      const ids = before.items.map((item) => item.nodeId).sort();
      assert.deepEqual(ids, [LATER_ID, ORIGINAL_ID, OTHER_PARENT_ID].sort());
      assert.equal(before.items.find((item) => item.nodeId === ORIGINAL_ID)?.duplicateOfNodeId, null);
      assert.equal(before.items.find((item) => item.nodeId === LATER_ID)?.duplicateOfNodeId, ORIGINAL_ID);
      assert.equal(before.items.find((item) => item.nodeId === OTHER_PARENT_ID)?.duplicateOfNodeId, ORIGINAL_ID);
      assert.equal(before.items.find((item) => item.nodeId === LATER_ID)?.duplicateRelationId, undefined);
      assert.equal(before.items.some((item) => item.nodeId === FOREIGN_ID), false);

      const nodesBefore = await nodeSnapshot();
      const created = await uow().execute((ports) => createRelation(ports, reviewCommand()));
      assert.equal(created.kind, 'created');
      if (created.kind !== 'created') return;
      const nodesAfterReview = await nodeSnapshot();
      assert.deepEqual(nodesAfterReview, nodesBefore);
      assert.equal(nodesAfterReview[LATER_ID]?.parent_id, ROOT_ID);
      assert.equal(nodesAfterReview[OTHER_PARENT_ID]?.parent_id, FOLDER_ID);
      assert.equal(nodesAfterReview[LATER_ID]?.title, 'Later title');
      assert.equal(nodesAfterReview[OTHER_PARENT_ID]?.title, 'Other folder title');

      const reviewed = await getMyLinkHealthPage({
        reads: createPostgresLinkHealthReadPort(isolated.runtime.db),
        cursors: signer,
        clock: { now: async () => NOW },
      }, { actor: { subjectId: OWNER } });
      const later = reviewed.items.find((item) => item.nodeId === LATER_ID);
      const other = reviewed.items.find((item) => item.nodeId === OTHER_PARENT_ID);
      assert.ok(later && other);
      assert.equal(later.duplicateRelationId, created.relation.id);
      assert.equal(later.duplicateRelationEtag, `"${created.relation.revision}"`);
      assert.equal(other.duplicateRelationId, undefined);
      assert.equal(later.duplicateOfNodeId, ORIGINAL_ID);

      await assert.rejects(
        () => uow().execute((ports) => createRelation(ports, reviewCommand())),
        (error: unknown) => error instanceof RelationCreateError && error.code === 'relation_already_exists',
      );
      const afterRepeat = await getMyLinkHealthPage({
        reads: createPostgresLinkHealthReadPort(isolated.runtime.db),
        cursors: signer,
        clock: { now: async () => NOW },
      }, { actor: { subjectId: OWNER } });
      assert.equal(afterRepeat.items.find((item) => item.nodeId === LATER_ID)?.duplicateRelationId, created.relation.id);
      assert.deepEqual(await nodeSnapshot(), nodesAfterReview);

      await assert.rejects(
        () => uow().execute((ports) => deleteRelation(ports, undoCommand(created.relation.id, 'stale-revision-1'))),
        (error: unknown) => error instanceof RelationDeleteError && error.code === 'relation_precondition_failed',
      );
      const undone = await uow().execute((ports) => deleteRelation(ports, undoCommand(
        created.relation.id, created.relation.revision,
      )));
      assert.equal(undone.kind, 'deleted');
      const afterUndo = await getMyLinkHealthPage({
        reads: createPostgresLinkHealthReadPort(isolated.runtime.db),
        cursors: signer,
        clock: { now: async () => NOW },
      }, { actor: { subjectId: OWNER } });
      assert.equal(afterUndo.items.find((item) => item.nodeId === LATER_ID)?.duplicateRelationId, undefined);
      assert.equal(afterUndo.items.find((item) => item.nodeId === LATER_ID)?.duplicateOfNodeId, ORIGINAL_ID);
      assert.deepEqual(await nodeSnapshot(), nodesAfterReview);
    } finally {
      signer.destroy();
    }
  });

  function reviewCommand(): CreateRelationInput {
    return {
      actor: { principalId: 'principal-lh-dup', subjectId: OWNER, principalType: 'account' },
      command: { commandId: randomUUID(), fingerprint: randomUUID() },
      collectionId: COLLECTION_ID,
      relation: {
        type: 'duplicate_of', fromNodeId: LATER_ID, toNodeId: ORIGINAL_ID,
        visibility: 'private', extensions: {},
      },
      relationId: `relation-${randomUUID()}`,
      operationId: `operation-${randomUUID()}`,
    };
  }

  function undoCommand(relationId: string, revision: string): DeleteRelationInput {
    return {
      actor: { principalId: 'principal-lh-dup', subjectId: OWNER, principalType: 'account' },
      command: { commandId: randomUUID(), fingerprint: randomUUID() },
      collectionId: COLLECTION_ID,
      relationId,
      precondition: {
        kind: 'single-strong-if-match',
        entityTag: `"${revision}"`,
        expectedRevision: revision,
      },
      operationId: `operation-${randomUUID()}`,
    };
  }

  function uow() {
    return createPostgresRelationMutationUnitOfWork(isolated.runtime.db);
  }

  async function nodeSnapshot() {
    const rows = await isolated.runtime.pool.query<{
      id: string; parent_id: string | null; title: string; url: string | null;
    }>(
      `select id, parent_id, title, url from nodes where id = any($1::text[]) order by id`,
      [[ORIGINAL_ID, LATER_ID, OTHER_PARENT_ID]],
    );
    return Object.fromEntries(rows.rows.map((row) => [row.id, row]));
  }

  async function resetFixture(): Promise<void> {
    const client = await isolated.runtime.pool.connect();
    try {
      await client.query('begin');
      await client.query('set constraints all deferred');
      await truncateGuardedTablesInTransaction(client, `truncate table product_command_receipts,outbox_events,audit_events,operations,
        collection_mutation_projection_resources,collection_mutation_projection_applied,
        collection_mutation_projection_watermarks,collection_link_health,
        policy_revisions,content_revisions,children_revisions,resource_revisions,relations,annotations,
        collection_policies,collection_members,nodes,collections,resource_id_ledger cascade`);
      await client.query(`insert into resource_id_ledger(resource_id,resource_type) values
        ($1,'collection'),($2,'node'),($3,'node'),($4,'node'),($5,'node'),($6,'node'),
        ($7,'collection'),($8,'node'),($9,'node')`,
      [COLLECTION_ID, ROOT_ID, FOLDER_ID, ORIGINAL_ID, LATER_ID, OTHER_PARENT_ID,
        OTHER_COLLECTION_ID, OTHER_ROOT_ID, FOREIGN_ID]);
      await client.query(`insert into collections(id,owner_subject_id,title,kind,visibility,publication_slug,published_at,
        root_node_id,resource_revision,content_revision,policy_revision,commit_ordinal) values
        ($1,$5,'Duplicates','bookmarks','private',null,null,$2,'cr1','cc1','cp1',1),
        ($3,'subject-other','Foreign','bookmarks','private',null,null,$4,'ocr1','occ1','ocp1',1)`,
      [COLLECTION_ID, ROOT_ID, OTHER_COLLECTION_ID, OTHER_ROOT_ID, OWNER]);
      await client.query(`insert into nodes(id,collection_id,parent_id,kind,is_root,title,url,description,tags,
        visibility,position_token,resource_revision,children_revision,created_at) values
        ($1,$8,null,'folder',true,'Root',null,null,'[]','inherit',null,'rr1','rch1',$11),
        ($2,$8,$1,'folder',false,'Folder',null,null,'[]','inherit','A','fr1','fch1',$11),
        ($3,$8,$1,'bookmark',false,'Original title',$10,null,'[]','inherit','B','or1','och1','2026-08-22T07:00:00.000Z'),
        ($4,$8,$1,'bookmark',false,'Later title',$10,null,'[]','inherit','C','lr1','lch1','2026-08-22T07:01:00.000Z'),
        ($5,$8,$2,'bookmark',false,'Other folder title',$10,null,'[]','inherit','D','pr1','pch1','2026-08-22T07:02:00.000Z'),
        ($6,$9,null,'folder',true,'Other',null,null,'[]','inherit',null,'xr1','xch1',$11),
        ($7,$9,$6,'bookmark',false,'Foreign title',$10,null,'[]','inherit','A','nr1','nch1',$11)`,
      [ROOT_ID, FOLDER_ID, ORIGINAL_ID, LATER_ID, OTHER_PARENT_ID, OTHER_ROOT_ID, FOREIGN_ID,
        COLLECTION_ID, OTHER_COLLECTION_ID, URL, NOW]);
      await client.query(`insert into collection_link_health(node_id,collection_id,status) values
        ($1,$4,'pending'),($2,$4,'pending'),($3,$4,'pending'),($5,$6,'pending')`,
      [ORIGINAL_ID, LATER_ID, OTHER_PARENT_ID, COLLECTION_ID, FOREIGN_ID, OTHER_COLLECTION_ID]);
      for (const id of [COLLECTION_ID, OTHER_COLLECTION_ID]) {
        const row = (await client.query(`select * from collections where id=$1`, [id])).rows[0];
        const payload = materializeCollectionPayload({
          id: row.id, ownerSubjectId: row.owner_subject_id, title: row.title, summary: row.summary,
          kind: row.kind, visibility: row.visibility, rootNodeId: row.root_node_id,
          resourceRevision: row.resource_revision, contentRevision: row.content_revision,
          policyRevision: row.policy_revision, commitOrdinal: row.commit_ordinal,
          createdAt: row.created_at, updatedAt: row.updated_at, deletedAt: row.deleted_at,
        });
        if (!payload.ok) throw new Error(payload.reason);
        await client.query(`update collections set payload_json=$2,payload_schema_version=1,
          payload_authority_status='backfilled' where id=$1`, [id, payload.payload]);
      }
      for (const id of [ROOT_ID, FOLDER_ID, ORIGINAL_ID, LATER_ID, OTHER_PARENT_ID, OTHER_ROOT_ID, FOREIGN_ID]) {
        const row = (await client.query(`select * from nodes where id=$1`, [id])).rows[0];
        const payload = materializeNodePayload({
          id: row.id, collectionId: row.collection_id, parentId: row.parent_id, kind: row.kind,
          isRoot: row.is_root, title: row.title, url: row.url, description: row.description,
          tags: row.tags, visibility: row.visibility, positionToken: row.position_token,
          resourceRevision: row.resource_revision, childrenRevision: row.children_revision,
          createdAt: row.created_at, updatedAt: row.updated_at, deletedAt: row.deleted_at,
          deletedCommitOrdinal: row.deleted_commit_ordinal,
        });
        if (!payload.ok) throw new Error(payload.reason);
        await client.query(`update nodes set payload_json=$2,payload_schema_version=1,
          payload_authority_status='backfilled' where id=$1`, [id, payload.payload]);
      }
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }
});
