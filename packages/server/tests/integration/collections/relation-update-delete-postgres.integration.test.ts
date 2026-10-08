import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, test } from 'vitest';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import { createPostgresCanonicalMutationUnitOfWork, createPostgresRelationMutationUnitOfWork, type PostgresCanonicalMutationFaultContext, type RelationMutationFaultContext } from '../../../src/infrastructure/collections/index.js';
import {
  RelationDeleteError,
  RelationUpdateError,
  createRelation,
  deleteCollectionNode,
  deleteRelation,
  materializeCollectionPayload,
  materializeNodePayload,
  updateRelation,
  type CreateRelationInput,
  type DeleteRelationInput,
  type UpdateRelationInput,
} from '../../../src/modules/collections/index.js';
import { PUBLICATION_CACHE_PURGE_EVENT_TYPE } from '../../../src/infrastructure/outbox/index.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
  truncateGuardedTablesInTransaction,
} from '../../support/postgres-test-runtime.js';

const COLLECTION_ID = Buffer.alloc(16, 7).toString('base64url');
const OWNER_PROFILE_ID = Buffer.alloc(16, 9).toString('base64url');
const ROOT_ID = 'relation-mutation-pg-root';
const FROM_ID = 'relation-mutation-pg-from';
const TO_ID = 'relation-mutation-pg-to';
const THIRD_ID = 'relation-mutation-pg-third';
const RELATION_CASCADE_FAULT_PHASES = ['resource', 'revision', 'operation', 'audit', 'outbox'] as const;
const RELATION_MUTATION_FAULT_PHASES = ['receipt', 'resource', 'revision', 'operation', 'audit', 'outbox'] as const;
const RELATION_MUTATION_FAULT_CASES = (['update', 'delete'] as const).flatMap((action) =>
  RELATION_MUTATION_FAULT_PHASES.map((phase) => ({ action, phase })),
);

describeWithPostgres('P2B-11 PostgreSQL Relation update/delete and Node cascade', () => {
  let isolated: IsolatedPostgresRuntime;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('phase2b_relation_mutation', { maxConnections: 16 });
    await runMigrations(isolated.runtime.db, 'latest');
  }, 120_000);
  afterAll(async () => isolated?.close());
  beforeEach(async () => resetFixture());

  function relationUow(fault?: (context: RelationMutationFaultContext) => void | Promise<void>) {
    return createPostgresRelationMutationUnitOfWork(isolated.runtime.db, {
      ...(fault ? { faultInjector: { afterPhase: fault } } : {}),
    });
  }

  function createInput(relationId: string, options: {
    fromNodeId?: string; toNodeId?: string; type?: CreateRelationInput['relation']['type'];
    visibility?: CreateRelationInput['relation']['visibility']; operationId?: string;
  } = {}): CreateRelationInput {
    return {
      actor: { principalId: 'principal-editor', subjectId: 'subject-editor', principalType: 'account' },
      command: { commandId: randomUUID(), fingerprint: randomUUID() }, collectionId: COLLECTION_ID,
      relation: { type: options.type ?? 'related', fromNodeId: options.fromNodeId ?? FROM_ID,
        toNodeId: options.toNodeId ?? TO_ID, label: 'original',
        visibility: options.visibility ?? 'protected', extensions: {} },
      relationId, operationId: options.operationId ?? `operation-create-${relationId}`,
    };
  }

  function updateInput(relationId: string, revision: string, options: {
    commandId?: string; fingerprint?: string; operationId?: string; patch?: UpdateRelationInput['patch'];
  } = {}): UpdateRelationInput {
    return {
      actor: { principalId: 'principal-editor', subjectId: 'subject-editor', principalType: 'account' },
      command: { commandId: options.commandId ?? randomUUID(), fingerprint: options.fingerprint ?? randomUUID() },
      collectionId: COLLECTION_ID, relationId,
      precondition: { kind: 'single-strong-if-match', entityTag: `"${revision}"`, expectedRevision: revision },
      patch: options.patch ?? { type: 'supports', label: null, visibility: 'public' },
      operationId: options.operationId ?? `operation-update-${relationId}`,
    };
  }

  function deleteInput(relationId: string, revision: string, options: {
    commandId?: string; fingerprint?: string; operationId?: string;
  } = {}): DeleteRelationInput {
    return {
      actor: { principalId: 'principal-editor', subjectId: 'subject-editor', principalType: 'account' },
      command: { commandId: options.commandId ?? randomUUID(), fingerprint: options.fingerprint ?? randomUUID() },
      collectionId: COLLECTION_ID, relationId,
      precondition: { kind: 'single-strong-if-match', entityTag: `"${revision}"`, expectedRevision: revision },
      operationId: options.operationId ?? `operation-delete-${relationId}`,
    };
  }

  async function seed(relationId: string, options: Parameters<typeof createInput>[1] = {}) {
    const result = await relationUow().execute((ports) => createRelation(ports, createInput(relationId, options)));
    assert.equal(result.kind, 'created');
    if (result.kind !== 'created') throw new Error('Relation seed did not create');
    return result.relation;
  }

  test('update atomically rewrites complete authority and emits one revision/operation/audit/event/receipt/purge', async () => {
    const relation = await seed('relation-update-atomic');
    const beforeTree = await treeSnapshot();
    const command = updateInput(relation.id, relation.revision, { operationId: 'operation-update-atomic' });
    const result = await relationUow().execute((ports) => updateRelation(ports, command));
    assert.equal(result.kind, 'updated');
    if (result.kind !== 'updated') return;
    const row = (await isolated.runtime.pool.query(`select * from relations where id=$1`, [relation.id])).rows[0];
    assert.equal(row.type, 'supports'); assert.equal(row.label, null); assert.equal(row.visibility, 'public');
    assert.equal(row.from_node_id, FROM_ID); assert.equal(row.to_node_id, TO_ID);
    assert.equal(row.payload_json.type, row.type); assert.equal(Object.hasOwn(row.payload_json, 'label'), false);
    assert.equal(row.payload_json.revision, row.resource_revision);
    assert.deepEqual(await treeSnapshot(), beforeTree);
    const counts = (await isolated.runtime.pool.query(`select
      (select count(*)::int from resource_revisions where resource_id=$1) revisions,
      (select count(*)::int from operations where operation_id=$2) operation,
      (select count(*)::int from audit_events where operation_id=$2) audit,
      (select count(*)::int from outbox_events event join operations operation
        on operation.collection_id=event.aggregate_scope and operation.commit_ordinal=event.commit_ordinal
        where operation.operation_id=$2 and event.event_type='relation.updated') event,
      (select count(*)::int from outbox_events event join operations operation
        on operation.collection_id=event.aggregate_scope and operation.commit_ordinal=event.commit_ordinal
        where operation.operation_id=$2 and event.event_type=$3) purge,
      (select count(*)::int from product_command_receipts where command_id=$4 and completed_at is not null) receipt`,
    [relation.id, command.operationId, PUBLICATION_CACHE_PURGE_EVENT_TYPE, command.command.commandId])).rows[0];
    assert.deepEqual(counts, { revisions: 2, operation: 1, audit: 1, event: 1, purge: 1, receipt: 1 });
  });

  test('update/delete exact replay is side-effect free and command reuse never mutates authority', async () => {
    const relation = await seed('relation-replay');
    const updateCommandId = randomUUID();
    const update = updateInput(relation.id, relation.revision, {
      commandId: updateCommandId, fingerprint: 'same-update', operationId: 'operation-update-replay',
    });
    const first = await relationUow().execute((ports) => updateRelation(ports, update));
    const replay = await relationUow().execute((ports) => updateRelation(ports, update));
    assert.equal(first.kind, 'updated'); assert.equal(replay.kind, 'replay');
    assert.deepEqual(await relationUow().execute((ports) => updateRelation(ports, {
      ...update, command: { ...update.command, fingerprint: 'reused-update' }, patch: { label: 'forbidden' },
    })), { kind: 'reused' });
    if (first.kind !== 'updated') return;
    const deleteCommandId = randomUUID();
    const remove = deleteInput(relation.id, first.relation.revision, {
      commandId: deleteCommandId, fingerprint: 'same-delete', operationId: 'operation-delete-replay',
    });
    const deleted = await relationUow().execute((ports) => deleteRelation(ports, remove));
    const deleteReplay = await relationUow().execute((ports) => deleteRelation(ports, remove));
    assert.equal(deleted.kind, 'deleted'); assert.equal(deleteReplay.kind, 'replay');
    assert.deepEqual((await isolated.runtime.pool.query(`select
      (select count(*)::int from relations where id=$1) relation,
      (select count(*)::int from resource_id_ledger where resource_id=$1) ledger,
      (select count(*)::int from operations where operation_id in ($2,$3)) operations,
      (select count(*)::int from product_command_receipts where command_id in ($4,$5)) receipts`,
    [relation.id, update.operationId, remove.operationId, updateCommandId, deleteCommandId])).rows[0],
    { relation: 1, ledger: 1, operations: 2, receipts: 2 });
  });

  test('delete persists a public tombstone and receipt while private-only mutations do not purge', async () => {
    const publicRelation = await seed('relation-delete-public', { visibility: 'public' });
    const publicDeleteInput = deleteInput(publicRelation.id, publicRelation.revision,
      { operationId: 'operation-delete-public' });
    const publicDelete = await relationUow().execute((ports) => deleteRelation(ports,
      publicDeleteInput));
    assert.equal(publicDelete.kind, 'deleted');
    if (publicDelete.kind !== 'deleted') return;
    const publicRow = (await isolated.runtime.pool.query(`select * from relations where id=$1`,
      [publicRelation.id])).rows[0];
    assert.ok(publicRow.deleted_at instanceof Date);
    assert.equal(publicRow.payload_json.deletedAt, publicRow.deleted_at.toISOString().replace(/\.\d{3}Z$/u, 'Z'));
    assert.equal(publicRow.payload_json.deletedCommitOrdinal, publicDelete.commitOrdinal.toString());
    assert.equal(publicRow.payload_json.deletionOperationId, publicDelete.operationId);
    assert.equal(publicDelete.receipt.deleteRevision, publicRow.resource_revision);
    const publicEvidence = (await isolated.runtime.pool.query(`select
      (select count(*)::int from outbox_events event join operations operation
        on operation.collection_id=event.aggregate_scope and operation.commit_ordinal=event.commit_ordinal
        where operation.operation_id=$1 and event.event_type='relation.deleted') deleted_event,
      (select count(*)::int from outbox_events event join operations operation
        on operation.collection_id=event.aggregate_scope and operation.commit_ordinal=event.commit_ordinal
        where operation.operation_id=$1 and event.event_type=$2) purge,
      (select count(*)::int from product_command_receipts where command_id=$3
        and completed_at is not null) receipt`,
    [publicDelete.operationId, PUBLICATION_CACHE_PURGE_EVENT_TYPE,
      publicDeleteInput.command.commandId])).rows[0];
    assert.deepEqual(publicEvidence, { deleted_event: 1, purge: 1, receipt: 1 });

    const privateRelation = await seed('relation-private-no-purge', { visibility: 'private' });
    const privateUpdate = await relationUow().execute((ports) => updateRelation(ports,
      updateInput(privateRelation.id, privateRelation.revision, {
        operationId: 'operation-update-private', patch: { label: 'still private' },
      })));
    assert.equal(privateUpdate.kind, 'updated');
    if (privateUpdate.kind !== 'updated') return;
    const privateDelete = await relationUow().execute((ports) => deleteRelation(ports,
      deleteInput(privateRelation.id, privateUpdate.relation.revision,
        { operationId: 'operation-delete-private' })));
    assert.equal(privateDelete.kind, 'deleted');
    const privatePurgeCount = (await isolated.runtime.pool.query(`select count(*)::int count
      from outbox_events event join operations operation
        on operation.collection_id=event.aggregate_scope and operation.commit_ordinal=event.commit_ordinal
      where operation.operation_id in ($1,$2) and event.event_type=$3`,
    ['operation-update-private', 'operation-delete-private', PUBLICATION_CACHE_PURGE_EVENT_TYPE])).rows[0].count;
    assert.equal(privatePurgeCount, 0);
  });

  test('stale and invalid endpoint-shaped patches do not advance content authority or persist receipts', async () => {
    const relation = await seed('relation-failed-patch');
    const before = await databaseSnapshot();
    const stale = updateInput(relation.id, 'stale-revision', { operationId: 'operation-stale-patch' });
    await assert.rejects(() => relationUow().execute((ports) => updateRelation(ports, stale)),
      (error: unknown) => error instanceof RelationUpdateError
        && error.code === 'relation_precondition_failed');
    const endpointPatch = updateInput(relation.id, relation.revision, {
      operationId: 'operation-endpoint-patch', patch: { fromNodeId: THIRD_ID } as never,
    });
    await assert.rejects(() => relationUow().execute((ports) => updateRelation(ports, endpointPatch)),
      (error: unknown) => error instanceof RelationUpdateError && error.code === 'invalid_relation_patch');
    assert.deepEqual(await databaseSnapshot(), before);
  });

  test('concurrent update/delete serialize on Collection and exactly one expected revision wins', async () => {
    const relation = await seed('relation-update-delete-race');
    let reached!: () => void; let release!: () => void;
    const blockedAtResource = new Promise<void>((resolve) => { reached = resolve; });
    const proceed = new Promise<void>((resolve) => { release = resolve; });
    const update = relationUow(async (context) => {
      if (context.phase === 'resource') { reached(); await proceed; }
    }).execute((ports) => updateRelation(ports, updateInput(relation.id, relation.revision, {
      operationId: 'operation-update-race', patch: { label: 'winner' },
    })));
    await blockedAtResource;
    const remove = relationUow().execute((ports) => deleteRelation(ports,
      deleteInput(relation.id, relation.revision, { operationId: 'operation-delete-race' })));
    await assertBlocked(); release();
    assert.equal((await update).kind, 'updated');
    await assert.rejects(() => remove, (error: unknown) =>
      error instanceof RelationDeleteError && error.code === 'relation_precondition_failed');
    assert.equal((await isolated.runtime.pool.query(`select count(*)::int count from operations
      where operation_id in ('operation-update-race','operation-delete-race')`)).rows[0].count, 1);
  });

  test('Node delete canonically tombstones all incident Relations once with aggregate evidence and retained ledger', async () => {
    const a = await seed('relation-cascade-a');
    const b = await seed('relation-cascade-b', { fromNodeId: THIRD_ID, toNodeId: TO_ID, type: 'supports' });
    const node = (await isolated.runtime.pool.query(`select resource_revision from nodes where id=$1`, [TO_ID])).rows[0];
    const nodeCommandId = randomUUID();
    const result = await createPostgresCanonicalMutationUnitOfWork(isolated.runtime.db).execute((ports) =>
      deleteCollectionNode(ports, {
        actor: { principalId: 'principal-editor', subjectId: 'subject-editor', principalType: 'account' },
        command: { commandId: nodeCommandId, fingerprint: randomUUID() }, collectionId: COLLECTION_ID,
        nodeId: TO_ID, ifMatch: `"${node.resource_revision}"`, recursive: false,
        operationId: 'operation-node-relation-cascade',
      }));
    assert.equal(result.kind, 'deleted');
    const rows = (await isolated.runtime.pool.query(`select id,deleted_at,deleted_commit_ordinal
      from relations where id=any($1::text[]) order by id`, [[a.id, b.id]])).rows;
    assert.equal(rows.length, 2); assert.ok(rows.every((row) => row.deleted_at instanceof Date));
    assert.equal((await isolated.runtime.pool.query(`select count(*)::int count from relations r
      join nodes n on n.id in (r.from_node_id,r.to_node_id)
      where r.deleted_at is null and n.deleted_at is not null`)).rows[0].count, 0);
    const evidence = (await isolated.runtime.pool.query(`select
      (select payload_json->'affectedRelationIds' from operation_payloads where operation_id=$1) operation_ids,
      (select details_json->'affectedRelationIds' from audit_event_payloads where event_id=(select id from audit_events where operation_id=$1)) audit_ids,
      (select count(*)::int from outbox_events where payload_json->>'operationId'=$1
        and event_type='relation.deleted') events,
      (select count(*)::int from resource_id_ledger where resource_id=any($2::text[])) ledger,
      (select count(*)::int from resource_revisions where resource_id=any($2::text[])
        and ordinal=$3) revisions,
      (select count(*)::int from product_command_receipts where command_id=$4
        and completed_at is not null) receipt,
      (select count(*)::int from outbox_events event join operations operation
        on operation.collection_id=event.aggregate_scope and operation.commit_ordinal=event.commit_ordinal
        where operation.operation_id=$1 and event.event_type=$5) purge`,
    [result.operationId, [a.id, b.id], result.commitOrdinal.toString(), nodeCommandId,
      PUBLICATION_CACHE_PURGE_EVENT_TYPE])).rows[0];
    assert.deepEqual([...evidence.operation_ids].sort(), [a.id, b.id].sort());
    assert.deepEqual([...evidence.audit_ids].sort(), [a.id, b.id].sort());
    assert.equal(evidence.events, 2); assert.equal(evidence.ledger, 2);
    assert.equal(evidence.revisions, 2); assert.equal(evidence.receipt, 1); assert.equal(evidence.purge, 1);
  });

  test('Node delete/Relation update use one real PostgreSQL lock order and cannot resurrect an endpoint edge', async () => {
    const relation = await seed('relation-node-update-race');
    const node = (await isolated.runtime.pool.query(`select resource_revision from nodes where id=$1`, [TO_ID])).rows[0];
    let reached!: () => void; let release!: () => void;
    const deletedResource = new Promise<void>((resolve) => { reached = resolve; });
    const proceed = new Promise<void>((resolve) => { release = resolve; });
    const removeNode = createPostgresCanonicalMutationUnitOfWork(isolated.runtime.db, {
      canonicalFaultInjector: { async afterPhase(context: PostgresCanonicalMutationFaultContext) {
        if (context.phase === 'resource') { reached(); await proceed; }
      } },
    }).execute((ports) => deleteCollectionNode(ports, {
      actor: { principalId: 'principal-editor', subjectId: 'subject-editor', principalType: 'account' },
      command: { commandId: randomUUID(), fingerprint: randomUUID() }, collectionId: COLLECTION_ID,
      nodeId: TO_ID, ifMatch: `"${node.resource_revision}"`, recursive: false,
      operationId: 'operation-node-delete-race',
    }));
    await deletedResource;
    const relationUpdate = relationUow().execute((ports) => updateRelation(ports,
      updateInput(relation.id, relation.revision, { operationId: 'operation-relation-update-race' })));
    await assertBlocked(); release();
    assert.equal((await removeNode).kind, 'deleted');
    await assert.rejects(() => relationUpdate, (error: unknown) =>
      error instanceof RelationUpdateError && error.code === 'relation_not_found');
  });

  test.each(RELATION_CASCADE_FAULT_PHASES)(
    'Node Relation cascade %s fault rolls back endpoint, tombstone, revisions, evidence and receipt',
    async (phase) => {
      const relation = await seed(`relation-cascade-fault-${phase}`);
      const node = (await isolated.runtime.pool.query(`select resource_revision from nodes where id=$1`,
        [TO_ID])).rows[0];
      const beforeDatabase = await databaseSnapshot();
      const beforeTree = await treeSnapshot();
      await assert.rejects(() => createPostgresCanonicalMutationUnitOfWork(isolated.runtime.db, {
        canonicalFaultInjector: { async afterPhase(context: PostgresCanonicalMutationFaultContext) {
          if (context.phase === phase
            && (phase !== 'resource' || context.resourceId === relation.id)) {
            throw new Error(`relation-cascade-fault-${phase}`);
          }
        } },
      }).execute((ports) => deleteCollectionNode(ports, {
        actor: { principalId: 'principal-editor', subjectId: 'subject-editor', principalType: 'account' },
        command: { commandId: randomUUID(), fingerprint: randomUUID() }, collectionId: COLLECTION_ID,
        nodeId: TO_ID, ifMatch: `"${node.resource_revision}"`, recursive: false,
        operationId: `operation-relation-cascade-fault-${phase}`,
      })));
      assert.deepEqual(await databaseSnapshot(), beforeDatabase);
      assert.deepEqual(await treeSnapshot(), beforeTree);
    },
  );

  test.each(RELATION_MUTATION_FAULT_CASES)(
    '$action fault after the $phase write restores authority, evidence and receipt',
    async ({ action, phase }) => {
      const relation = await seed(`relation-fault-${action}-${phase}`);
      const before = await databaseSnapshot();
      await assert.rejects(() => relationUow((context) => {
        if (context.phase === phase) throw new Error(`${action}-fault-${phase}`);
      }).execute((ports) => action === 'update'
        ? updateRelation(ports, updateInput(relation.id, relation.revision))
        : deleteRelation(ports, deleteInput(relation.id, relation.revision))),
      new RegExp(`${action}-fault-${phase}`));
      assert.deepEqual(await databaseSnapshot(), before);
    },
  );

  async function assertBlocked() {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const state = await isolated.runtime.pool.query<{ blocked: number }>(`select count(*)::int blocked
        from pg_stat_activity where datname=current_database() and wait_event_type='Lock'
          and cardinality(pg_blocking_pids(pid)) > 0`);
      if ((state.rows[0]?.blocked ?? 0) > 0) return;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    assert.fail('competing transaction did not block on canonical Collection lock');
  }

  async function treeSnapshot() {
    return (await isolated.runtime.pool.query(`select id,parent_id,position_token,children_revision
      from nodes where collection_id=$1 order by id`, [COLLECTION_ID])).rows;
  }

  async function databaseSnapshot() {
    return (await isolated.runtime.pool.query(`select
      (select jsonb_agg(to_jsonb(r) order by id) from relations r) relations,
      (select count(*)::int from resource_id_ledger) ledger,
      (select count(*)::int from resource_revisions) resource_revisions,
      (select count(*)::int from content_revisions) content_revisions,
      (select count(*)::int from operations) operations,
      (select count(*)::int from audit_events) audits,
      (select count(*)::int from outbox_events) outbox,
      (select count(*)::int from product_command_receipts) receipts,
      (select content_revision from collections where id=$1) content_revision,
      (select commit_ordinal::text from collections where id=$1) ordinal`, [COLLECTION_ID])).rows[0];
  }

  async function resetFixture() {
    const client = await isolated.runtime.pool.connect();
    try {
      await client.query('begin'); await client.query('set constraints all deferred');
      await truncateGuardedTablesInTransaction(client, `truncate table product_command_receipts,outbox_events,audit_events,operations,
        collection_mutation_projection_resources,collection_mutation_projection_applied,
        collection_mutation_projection_watermarks,policy_revisions,content_revisions,children_revisions,
        resource_revisions,relations,annotations,collection_policies,collection_members,nodes,collections,
        resource_id_ledger cascade`);
      await client.query(`insert into accounts(id,subject_id,status) values($1,'subject-owner','active')
        on conflict (id) do nothing`, [OWNER_PROFILE_ID]);
      await client.query(`insert into profiles(account_id,display_name) values($1,'Relation owner')
        on conflict (account_id) do nothing`, [OWNER_PROFILE_ID]);
      await client.query(`insert into resource_id_ledger(resource_id,resource_type) values
        ($1,'collection'),($2,'node'),($3,'node'),($4,'node'),($5,'node')`,
      [COLLECTION_ID, ROOT_ID, FROM_ID, TO_ID, THIRD_ID]);
      await client.query(`insert into collections(id,owner_subject_id,title,kind,visibility,publication_slug,
        published_at,root_node_id,resource_revision,content_revision,policy_revision,commit_ordinal) values
        ($1,'subject-owner','Relations','bookmarks','public','relations',current_timestamp,$2,'cr1','cc1','cp1',1)`,
      [COLLECTION_ID, ROOT_ID]);
      await client.query(`insert into nodes(id,collection_id,parent_id,kind,is_root,title,url,description,tags,
        visibility,position_token,resource_revision,children_revision) values
        ($1,$5,null,'folder',true,'Root',null,null,'[]','inherit',null,'rr1','rch1'),
        ($2,$5,$1,'bookmark',false,'From','https://from.test',null,'[]','inherit','A','fr1','fch1'),
        ($3,$5,$1,'bookmark',false,'To','https://to.test',null,'[]','inherit','B','tr1','tch1'),
        ($4,$5,$1,'bookmark',false,'Third','https://third.test',null,'[]','inherit','C','xr1','xch1')`,
      [ROOT_ID, FROM_ID, TO_ID, THIRD_ID, COLLECTION_ID]);
      await client.query(`insert into collection_members(collection_id,subject_id,role) values
        ($1,'subject-owner','owner'),($1,'subject-editor','editor')`, [COLLECTION_ID]);
      const collection = (await client.query(`select * from collections where id=$1`, [COLLECTION_ID])).rows[0];
      const collectionPayload = materializeCollectionPayload({ id: collection.id,
        ownerSubjectId: collection.owner_subject_id, title: collection.title, summary: collection.summary,
        kind: collection.kind, visibility: collection.visibility, rootNodeId: collection.root_node_id,
        resourceRevision: collection.resource_revision, contentRevision: collection.content_revision,
        policyRevision: collection.policy_revision, commitOrdinal: collection.commit_ordinal,
        createdAt: collection.created_at, updatedAt: collection.updated_at, deletedAt: collection.deleted_at });
      if (!collectionPayload.ok) throw new Error(collectionPayload.reason);
      await client.query(`update collections set payload_json=$2,payload_schema_version=1,
        payload_authority_status='backfilled' where id=$1`, [COLLECTION_ID, collectionPayload.payload]);
      for (const id of [ROOT_ID, FROM_ID, TO_ID, THIRD_ID]) {
        const node = (await client.query(`select * from nodes where id=$1`, [id])).rows[0];
        const payload = materializeNodePayload({ id: node.id, collectionId: node.collection_id,
          parentId: node.parent_id, kind: node.kind, isRoot: node.is_root, title: node.title,
          url: node.url, description: node.description, tags: node.tags, visibility: node.visibility,
          positionToken: node.position_token, resourceRevision: node.resource_revision,
          childrenRevision: node.children_revision, createdAt: node.created_at, updatedAt: node.updated_at,
          deletedAt: node.deleted_at, deletedCommitOrdinal: node.deleted_commit_ordinal });
        if (!payload.ok) throw new Error(payload.reason);
        await client.query(`update nodes set payload_json=$2,payload_schema_version=1,
          payload_authority_status='backfilled' where id=$1`, [id, payload.payload]);
      }
      await client.query('commit');
    } catch (error) { await client.query('rollback'); throw error; }
    finally { client.release(); }
  }
});
