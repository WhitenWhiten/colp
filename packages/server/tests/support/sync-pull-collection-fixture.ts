import assert from 'node:assert/strict';
import type { DatabaseRuntime } from '../../src/infrastructure/database/index.js';
import { RESOURCE_PAYLOAD_SCHEMA_VERSION, materializeCollectionPayload, materializeNodePayload } from '../../src/modules/collections/index.js';

export async function seedPullCollection(runtime: Pick<DatabaseRuntime, 'pool'>, ownerSubjectId: string, collectionId: string, rootId: string): Promise<void> {
  const now = new Date('2026-07-26T06:00:00Z');
  const collection = materializeCollectionPayload({
    id: collectionId, ownerSubjectId: ownerSubjectId, title: collectionId, summary: null,
    kind: 'bookmarks', visibility: 'private', rootNodeId: rootId,
    resourceRevision: 'collection-r1', contentRevision: 'content-r1', policyRevision: 'policy-r1',
    commitOrdinal: 0n, createdAt: now, updatedAt: now, deletedAt: null,
  });
  const root = materializeNodePayload({
    id: rootId, collectionId, parentId: null, kind: 'folder', isRoot: true, title: 'Root',
    url: null, description: null, tags: [], visibility: 'inherit', positionToken: null,
    resourceRevision: 'root-r1', childrenRevision: 'children-r1', createdAt: now, updatedAt: now,
    deletedAt: null, deletedCommitOrdinal: null,
  });
  const targetId = `${rootId}-target`;
  const target = materializeNodePayload({
    id: targetId, collectionId, parentId: rootId, kind: 'bookmark', isRoot: false, title: 'Target',
    url: 'https://example.test/', description: null, tags: [], visibility: 'inherit', positionToken: 'A',
    resourceRevision: 'target-r1', childrenRevision: 'target-children-r1', createdAt: now, updatedAt: now,
    deletedAt: null, deletedCommitOrdinal: null,
  });
  assert.equal(collection.ok, true); assert.equal(root.ok, true); assert.equal(target.ok, true);
  const client = await runtime.pool.connect();
  try {
    await client.query('begin');
    await client.query("insert into resource_id_ledger(resource_id,resource_type) values ($1,'collection'),($2,'node'),($3,'node')", [collectionId, rootId, targetId]);
    await client.query(`insert into collections
      (id,owner_subject_id,title,kind,visibility,root_node_id,resource_revision,content_revision,
       policy_revision,commit_ordinal,created_at,updated_at,payload_json,payload_schema_version,payload_authority_status)
      values ($1,$2,$1,'bookmarks','private',$3,'collection-r1','content-r1','policy-r1',0,$4,$4,$5,$6,'backfilled')`,
    [collectionId, ownerSubjectId, rootId, now, collection.ok ? collection.payload : {}, RESOURCE_PAYLOAD_SCHEMA_VERSION]);
    await client.query(`insert into nodes
      (id,collection_id,parent_id,kind,is_root,title,url,visibility,position_token,resource_revision,
       children_revision,created_at,updated_at,payload_json,payload_schema_version,payload_authority_status)
      values ($1,$2,null,'folder',true,'Root',null,'inherit',null,'root-r1','children-r1',$3,$3,$4,$5,'backfilled')`,
    [rootId, collectionId, now, root.ok ? root.payload : {}, RESOURCE_PAYLOAD_SCHEMA_VERSION]);
    await client.query(`insert into nodes
      (id,collection_id,parent_id,kind,is_root,title,url,visibility,position_token,resource_revision,
       children_revision,created_at,updated_at,payload_json,payload_schema_version,payload_authority_status)
      values ($1,$2,$3,'bookmark',false,'Target','https://example.test/','inherit','A','target-r1','target-children-r1',$4,$4,$5,$6,'backfilled')`,
    [targetId, collectionId, rootId, now, target.ok ? target.payload : {}, RESOURCE_PAYLOAD_SCHEMA_VERSION]);
    await client.query(`insert into sync_node_revision_history
      (collection_id,resource_id,revision,kind,payload_json,commit_ordinal,operation_id)
      values ($1,$2,'target-r1','bookmark',$3,0,null)`,
    [collectionId, targetId, target.ok ? target.payload : {}]);
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally { client.release(); }
}

