import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, test } from 'vitest';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import { createPostgresRelationMutationUnitOfWork, type RelationMutationFaultContext } from '../../../src/infrastructure/collections/index.js';
import {
  RelationCreateError,
  createRelation,
  materializeCollectionPayload,
  materializeNodePayload,
  toProductRelationView,
  type CreateRelationInput,
} from '../../../src/modules/collections/index.js';
import {
  PUBLICATION_CACHE_PURGE_EVENT_TYPE,
  PostgresCollectionMutationProjectionSink,
  createCollectionMutationEnvelopeRegistry,
  createProductionCollectionMutationOutboxRouter,
} from '../../../src/infrastructure/outbox/index.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
  truncateGuardedTablesInTransaction,
} from '../../support/postgres-test-runtime.js';
import { waitForCondition } from '../../support/async-test-helpers.js';

const COLLECTION_ID = Buffer.alloc(16, 5).toString('base64url');
const ROOT_ID = 'relation-pg-root';
const FROM_ID = 'relation-pg-from';
const TO_ID = 'relation-pg-to';
const THIRD_ID = 'relation-pg-third';
const OTHER_COLLECTION_ID = Buffer.alloc(16, 6).toString('base64url');
const OTHER_ROOT_ID = 'relation-pg-other-root';

describeWithPostgres('P2B-10 PostgreSQL Relation canonical create', () => {
  let isolated: IsolatedPostgresRuntime;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('phase2b_relation_create', { maxConnections: 12 });
    await runMigrations(isolated.runtime.db, 'latest');
  }, 120_000);
  afterAll(async () => isolated?.close());
  beforeEach(async () => resetFixture());

  function command(options: {
    principalId?: string; subjectId?: string; relationId?: string; operationId?: string;
    commandId?: string; fingerprint?: string; fromNodeId?: string; toNodeId?: string;
    type?: CreateRelationInput['relation']['type']; label?: string;
    visibility?: CreateRelationInput['relation']['visibility'];
  } = {}): CreateRelationInput {
    return {
      actor: { principalId: options.principalId ?? 'principal-owner',
        subjectId: options.subjectId ?? 'subject-owner', principalType: 'account' },
      command: { commandId: options.commandId ?? randomUUID(),
        fingerprint: options.fingerprint ?? randomUUID() },
      collectionId: COLLECTION_ID,
      relation: { type: options.type ?? 'related', fromNodeId: options.fromNodeId ?? FROM_ID,
        toNodeId: options.toNodeId ?? TO_ID, ...(options.label === undefined ? {} : { label: options.label }),
        visibility: options.visibility ?? 'protected', extensions: {} },
      relationId: options.relationId ?? `relation-${randomUUID()}`,
      operationId: options.operationId ?? `operation-${randomUUID()}`,
    };
  }

  async function execute(value: CreateRelationInput,
    fault?: (context: RelationMutationFaultContext) => void | Promise<void>) {
    return createPostgresRelationMutationUnitOfWork(isolated.runtime.db, {
      ...(fault ? { faultInjector: { afterPhase: fault } } : {}),
    }).execute((ports) => createRelation(ports, value));
  }

  test('atomically commits row/ledger/revisions/fence/Operation/Audit/closed Outbox/receipt without tree revisions', async () => {
    const value = command({ relationId: 'relation-atomic', operationId: 'operation-atomic',
      type: 'custom', label: 'prerequisite', visibility: 'public' });
    const before = await treeRevisionSnapshot();
    const result = await execute(value);
    assert.equal(result.kind, 'created');
    const row = (await isolated.runtime.pool.query(`select * from relations where id=$1`, [value.relationId])).rows[0];
    assert.equal(row.collection_id, COLLECTION_ID);
    assert.equal(row.from_node_id, FROM_ID);
    assert.equal(row.to_node_id, TO_ID);
    assert.equal(row.payload_json.id, value.relationId);
    assert.equal(row.payload_json.collectionId, COLLECTION_ID);
    assert.equal(row.payload_json.fromNodeId, row.from_node_id);
    assert.equal(row.payload_json.toNodeId, row.to_node_id);
    assert.equal(row.payload_json.revision, row.resource_revision);
    const counts = (await isolated.runtime.pool.query(`select
      (select count(*)::int from resource_id_ledger
        where resource_id in ($1,$2) or resource_type in ('outbox','domain-event')) ledger,
      (select count(*)::int from resource_revisions where resource_id=$1) resource_revision,
      (select count(*)::int from content_revisions where ordinal=2) content_revision,
      (select count(*)::int from operations where operation_id=$2) operation,
      (select count(*)::int from audit_events where operation_id=$2) audit,
      (select count(*)::int from outbox_events event join operations operation
        on operation.collection_id=event.aggregate_scope and operation.commit_ordinal=event.commit_ordinal
        where operation.operation_id=$2) outbox,
      (select count(*)::int from product_command_receipts where command_id=$3 and completed_at is not null) receipt`,
    [value.relationId, value.operationId, value.command.commandId])).rows[0];
    assert.deepEqual(counts, { ledger: 5, resource_revision: 1, content_revision: 1,
      operation: 1, audit: 1, outbox: 2, receipt: 1 });
    assert.deepEqual(await treeRevisionSnapshot(), before);
    const event = (await isolated.runtime.pool.query(`select event.* from outbox_events event
      join operations operation on operation.collection_id=event.aggregate_scope
        and operation.commit_ordinal=event.commit_ordinal
      where operation.operation_id=$1 and event.event_type='relation.created'`,
    [value.operationId])).rows[0];
    assert.deepEqual(event.payload_json, {
      collectionId: COLLECTION_ID, relationId: value.relationId, fromNodeId: FROM_ID,
      toNodeId: TO_ID, type: 'custom', visibility: 'public', resourceRevision: row.resource_revision,
      contentRevision: result.kind === 'created' ? result.fence.contentRevision : '',
    });
    assert.equal(event.aggregate_type, 'relation');
    assert.equal(event.event_version, 1);
    assert.equal(Object.hasOwn(event.payload_json, 'principalId'), false);
    const envelope = createCollectionMutationEnvelopeRegistry().validate({
      event_id: event.domain_event_id, event_type: event.event_type,
      event_version: event.event_version, aggregate_identity: {
        aggregate_type: event.aggregate_type, aggregate_id: event.aggregate_id,
        aggregate_scope: event.aggregate_scope,
      }, aggregate_revision: event.aggregate_revision,
      commit_ordinal: String(event.commit_ordinal), occurred_at: event.occurred_at.toISOString(),
      payload: event.payload_json,
    });
    const router = createProductionCollectionMutationOutboxRouter({
      sink: new PostgresCollectionMutationProjectionSink(isolated.runtime.pool),
    });
    await router.resolve({ handlerName: event.handler_name, handlerMode: event.handler_mode,
      eventType: event.event_type, eventVersion: event.event_version }).handle({
      envelope, idempotencyKey: envelope.event_id, signal: new AbortController().signal,
    });
    assert.deepEqual((await isolated.runtime.pool.query(`select resource_type,resource_id
      from collection_mutation_projection_resources where collection_id=$1 and resource_id=$2`,
    [COLLECTION_ID, value.relationId])).rows, [{ resource_type: 'relation', resource_id: value.relationId }]);
  });

  test('supports every Relation type/custom label and permission matrix', async () => {
    const types = ['related', 'precedes', 'follows', 'supports', 'contradicts',
      'duplicate_of', 'derived_from', 'mentions', 'custom'] as const;
    for (const [index, type] of types.entries()) {
      await execute(command({ relationId: `relation-type-${type}`, fromNodeId: index % 2 ? TO_ID : FROM_ID,
        toNodeId: THIRD_ID, type, ...(type === 'custom' ? { label: 'custom edge' } : {}) }));
      await isolated.runtime.pool.query(`update relations set deleted_at=current_timestamp,
        deleted_commit_ordinal=99 where id=$1`, [`relation-type-${type}`]);
    }
    assert.equal((await execute(command({ principalId: 'principal-editor', subjectId: 'subject-editor',
      relationId: 'relation-editor' }))).kind, 'created');
    await assert.rejects(() => execute(command({ principalId: 'principal-member', subjectId: 'subject-member' })),
      (error: unknown) => error instanceof RelationCreateError && error.code === 'insufficient_relation_permission');
    await assert.rejects(() => execute(command({ principalId: 'principal-outsider', subjectId: 'subject-outsider' })),
      (error: unknown) => error instanceof RelationCreateError && error.code === 'relation_not_found');
  });

  test('rejects missing/deleted/cross-Collection/self endpoints and visibility widening', async () => {
    await assert.rejects(() => execute(command({ fromNodeId: 'missing' })),
      (error: unknown) => error instanceof RelationCreateError && error.code === 'invalid_relation_endpoint');
    await assert.rejects(() => execute(command({ toNodeId: OTHER_ROOT_ID })),
      (error: unknown) => error instanceof RelationCreateError && error.code === 'invalid_relation_endpoint');
    await assert.rejects(() => execute(command({ toNodeId: FROM_ID })),
      (error: unknown) => error instanceof RelationCreateError && error.code === 'relation_self_forbidden');
    await isolated.runtime.pool.query(`update nodes set deleted_at=current_timestamp where id=$1`, [TO_ID]);
    await assert.rejects(() => execute(command()),
      (error: unknown) => error instanceof RelationCreateError && error.code === 'invalid_relation_endpoint');
    await isolated.runtime.pool.query(`update nodes set deleted_at=null, visibility='private' where id=$1`, [TO_ID]);
    await assert.rejects(() => execute(command({ visibility: 'protected' })),
      (error: unknown) => error instanceof RelationCreateError && error.code === 'relation_visibility_too_broad');
  });

  test('enforces directional type-specific live semantic identity and permits rebuild after soft delete', async () => {
    await execute(command({ relationId: 'relation-first', type: 'related' }));
    await assert.rejects(() => execute(command({ relationId: 'relation-duplicate',
      type: 'related', label: 'label does not create a second edge' })),
    (error: unknown) => error instanceof RelationCreateError && error.code === 'relation_already_exists');
    assert.equal((await execute(command({ relationId: 'relation-reverse', fromNodeId: TO_ID,
      toNodeId: FROM_ID, type: 'related' }))).kind, 'created');
    assert.equal((await execute(command({ relationId: 'relation-other-type', type: 'supports' }))).kind, 'created');
    await execute(command({ relationId: 'relation-custom-first', fromNodeId: FROM_ID,
      toNodeId: THIRD_ID, type: 'custom', label: 'depends on' }));
    await assert.rejects(() => execute(command({ relationId: 'relation-custom-duplicate',
      fromNodeId: FROM_ID, toNodeId: THIRD_ID, type: 'custom', label: 'different label' })),
    (error: unknown) => error instanceof RelationCreateError && error.code === 'relation_already_exists');
    await isolated.runtime.pool.query(`update relations set deleted_at=current_timestamp,
      deleted_commit_ordinal=4 where id='relation-first'`);
    assert.equal((await execute(command({ relationId: 'relation-rebuilt', type: 'related' }))).kind, 'created');
  });

  test('exact replay is stable and command reuse, ID reuse and concurrent semantic duplicates have one winner', async () => {
    const commandId = randomUUID();
    const value = command({ commandId, fingerprint: 'same', relationId: 'relation-replay', operationId: 'operation-replay' });
    const first = await execute(value);
    const replay = await execute(value);
    assert.equal(first.kind, 'created'); assert.equal(replay.kind, 'replay');
    if (first.kind === 'created' && replay.kind === 'replay') {
      assert.equal(replay.targetIdentity, first.relation.id);
      assert.equal(replay.stableHeaders.etag, `"${first.relation.revision}"`);
      assert.deepEqual(JSON.parse(Buffer.from(replay.body).toString()), toProductRelationView(first.relation));
    }
    assert.deepEqual((await isolated.runtime.pool.query(`select
      (select count(*)::int from relations where id=$1) relation,
      (select count(*)::int from resource_id_ledger where resource_id=$1) relation_ledger,
      (select count(*)::int from operations where operation_id=$2) operation,
      (select count(*)::int from outbox_events event join operations operation
        on operation.collection_id=event.aggregate_scope and operation.commit_ordinal=event.commit_ordinal
        where operation.operation_id=$2) outbox,
      (select count(*)::int from product_command_receipts where command_id=$3 and completed_at is not null) receipt`,
    [value.relationId, value.operationId, commandId])).rows[0], {
      relation: 1, relation_ledger: 1, operation: 1, outbox: 2, receipt: 1,
    });
    assert.deepEqual(await execute(command({ commandId, fingerprint: 'different',
      relationId: 'relation-reuse-command' })), { kind: 'reused' });
    assert.equal((await isolated.runtime.pool.query(`select count(*)::int count from relations
      where id='relation-reuse-command'`)).rows[0]?.count, 0);
    await isolated.runtime.pool.query(`insert into resource_id_ledger(resource_id,resource_type) values ('relation-cross-type-id','node')`);
    await assert.rejects(() => execute(command({ relationId: 'relation-cross-type-id',
      fromNodeId: FROM_ID, toNodeId: THIRD_ID })));

    await resetFixture();
    let locked!: () => void; let release!: () => void;
    const reached = new Promise<void>((resolve) => { locked = resolve; });
    const proceed = new Promise<void>((resolve) => { release = resolve; });
    const a = execute(command({ relationId: 'relation-race-a', operationId: 'operation-race-a' }), async (context) => {
      if (context.phase === 'ledger') { locked(); await proceed; }
    });
    await reached;
    const b = execute(command({ relationId: 'relation-race-b', operationId: 'operation-race-b' }));
    release();
    const settled = await Promise.allSettled([a, b]);
    assert.equal(settled.filter((item) => item.status === 'fulfilled').length, 1);
    const duplicateLoser = settled.find((item) => item.status === 'rejected');
    assert.ok(duplicateLoser?.status === 'rejected');
    assert.ok(duplicateLoser.reason instanceof RelationCreateError);
    assert.equal(duplicateLoser.reason.code, 'relation_already_exists');
    assert.equal((await isolated.runtime.pool.query(`select count(*)::int count from relations where deleted_at is null`)).rows[0]?.count, 1);
    assert.equal((await isolated.runtime.pool.query(`select count(*)::int count from operations where operation_id like 'operation-race-%'`)).rows[0]?.count, 1);

    await resetFixture();
    let idLocked!: () => void; let idRelease!: () => void;
    const idReached = new Promise<void>((resolve) => { idLocked = resolve; });
    const idProceed = new Promise<void>((resolve) => { idRelease = resolve; });
    const sameIdA = execute(command({ relationId: 'relation-same-id', operationId: 'operation-same-id-a',
      fromNodeId: FROM_ID, toNodeId: TO_ID }), async (context) => {
      if (context.phase === 'ledger') { idLocked(); await idProceed; }
    });
    await idReached;
    const sameIdB = execute(command({ relationId: 'relation-same-id', operationId: 'operation-same-id-b',
      fromNodeId: FROM_ID, toNodeId: THIRD_ID }));
    idRelease();
    const sameIdSettled = await Promise.allSettled([sameIdA, sameIdB]);
    assert.equal(sameIdSettled.filter((item) => item.status === 'fulfilled').length, 1);
    assert.equal((await isolated.runtime.pool.query(`select count(*)::int count from relations where id='relation-same-id'`)).rows[0]?.count, 1);
    assert.equal((await isolated.runtime.pool.query(`select count(*)::int count from operations where operation_id like 'operation-same-id-%'`)).rows[0]?.count, 1);
  });

  test('Collection lock keeps endpoint check and Relation insert atomic against a canonical delete-shaped writer', async () => {
    let checked!: () => void; let release!: () => void;
    const endpointChecked = new Promise<void>((resolve) => { checked = resolve; });
    const mayCommit = new Promise<void>((resolve) => { release = resolve; });
    const create = execute(command({ relationId: 'relation-node-race', operationId: 'operation-node-race' }), async (context) => {
      if (context.phase === 'endpoints') { checked(); await mayCommit; }
    });
    await endpointChecked;
    const deleteClient = await isolated.runtime.pool.connect();
    await deleteClient.query('begin');
    const deleteAttempt = deleteClient.query(`select id from collections where id=$1 for update`, [COLLECTION_ID]);
    let settled = false;
    void deleteAttempt.then(() => { settled = true; });
    await waitForCondition(async () => {
      const blocked = await isolated.runtime.pool.query<{ waiting: boolean }>(`
        select exists(select 1 from pg_stat_activity
          where application_name='known-test-phase2b_relation_create'
            and cardinality(pg_blocking_pids(pid)) > 0) waiting
      `);
      return blocked.rows[0]?.waiting === true;
    }, {
      timeoutMs: 2_000,
      pollIntervalMs: 5,
      description: 'the canonical node deletion to wait on the collection lock',
    });
    assert.equal(settled, false, 'canonical Node deletion must wait on the same Collection lock');
    release();
    assert.equal((await create).kind, 'created');
    await deleteAttempt;
    await deleteClient.query('rollback');
    deleteClient.release();
    const relation = (await isolated.runtime.pool.query(`select deleted_at from relations where id='relation-node-race'`)).rows[0];
    assert.equal(relation.deleted_at, null);
    assert.equal((await isolated.runtime.pool.query(`select deleted_at from nodes where id=$1`, [TO_ID])).rows[0]?.deleted_at, null,
      'P2B-11 exercises endpoint deletion through the canonical Relation cascade writer');

    await resetFixture();
    const firstDelete = await isolated.runtime.pool.connect();
    await firstDelete.query('begin');
    await firstDelete.query(`select id from collections where id=$1 for update`, [COLLECTION_ID]);
    await firstDelete.query(`update nodes set deleted_at=current_timestamp where id=$1`, [TO_ID]);
    const losingCreate = execute(command({ relationId: 'relation-delete-first-race',
      operationId: 'operation-delete-first-race' }));
    let createSettled = false;
    void losingCreate.finally(() => { createSettled = true; }).catch(() => undefined);
    await waitForCondition(async () => {
      const blocked = await isolated.runtime.pool.query<{ waiting: boolean }>(`
        select exists(select 1 from pg_stat_activity
          where application_name='known-test-phase2b_relation_create'
            and cardinality(pg_blocking_pids(pid)) > 0) waiting
      `);
      return blocked.rows[0]?.waiting === true;
    }, {
      timeoutMs: 2_000,
      pollIntervalMs: 5,
      description: 'relation admission to wait on the deleting collection writer',
    });
    assert.equal(createSettled, false, 'Relation admission must wait for the deleting Collection writer');
    await firstDelete.query('commit');
    firstDelete.release();
    await assert.rejects(() => losingCreate,
      (error: unknown) => error instanceof RelationCreateError && error.code === 'invalid_relation_endpoint');
    assert.equal((await isolated.runtime.pool.query(`select count(*)::int count from relations
      where id='relation-delete-first-race'`)).rows[0]?.count, 0);
  });

  test.each(['receipt', 'ledger', 'resource', 'revision', 'operation', 'audit', 'outbox'] as const)(
    'rolls back the %s write phase and preserves all prior authority',
    async (phase) => {
      const value = command({ relationId: `relation-fault-${phase}`, operationId: `operation-fault-${phase}` });
      const before = await authoritySnapshot();
      await assert.rejects(() => execute(value, (context) => {
        if (context.phase === phase) throw new Error(`fault-${phase}`);
      }), new RegExp(`fault-${phase}`));
      assert.deepEqual(await authoritySnapshot(), before);
    },
  );

  test('private Relation creates no public purge while shared representation does', async () => {
    const privateValue = command({ relationId: 'relation-private', operationId: 'operation-private', visibility: 'private' });
    await execute(privateValue);
    assert.equal((await isolated.runtime.pool.query(`select count(*)::int count from outbox_events event
      join operations operation on operation.collection_id=event.aggregate_scope
        and operation.commit_ordinal=event.commit_ordinal
      where operation.operation_id=$1 and event.event_type=$2`,
    [privateValue.operationId, PUBLICATION_CACHE_PURGE_EVENT_TYPE])).rows[0]?.count, 0);
    const shared = command({ relationId: 'relation-shared', operationId: 'operation-shared', visibility: 'public',
      fromNodeId: FROM_ID, toNodeId: THIRD_ID });
    await execute(shared);
    assert.equal((await isolated.runtime.pool.query(`select count(*)::int count from outbox_events event
      join operations operation on operation.collection_id=event.aggregate_scope
        and operation.commit_ordinal=event.commit_ordinal
      where operation.operation_id=$1 and event.event_type=$2`,
    [shared.operationId, PUBLICATION_CACHE_PURGE_EVENT_TYPE])).rows[0]?.count, 1);
  });

  async function treeRevisionSnapshot() {
    return (await isolated.runtime.pool.query(`select id,parent_id,position_token,children_revision
      from nodes where collection_id=$1 order by id`, [COLLECTION_ID])).rows;
  }

  async function authoritySnapshot() {
    return (await isolated.runtime.pool.query(`select
      (select count(*)::int from relations) relations,
      (select count(*)::int from resource_id_ledger) ledger,
      (select count(*)::int from resource_revisions) resource_revisions,
      (select count(*)::int from content_revisions) content_revisions,
      (select count(*)::int from children_revisions) children_revisions,
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
        collection_mutation_projection_watermarks,
        policy_revisions,content_revisions,children_revisions,resource_revisions,relations,annotations,
        collection_policies,collection_members,nodes,collections,resource_id_ledger cascade`);
      await client.query(`insert into resource_id_ledger(resource_id,resource_type) values
        ($1,'collection'),($2,'node'),($3,'node'),($4,'node'),($5,'node'),($6,'collection'),($7,'node')`,
      [COLLECTION_ID, ROOT_ID, FROM_ID, TO_ID, THIRD_ID, OTHER_COLLECTION_ID, OTHER_ROOT_ID]);
      await client.query(`insert into collections(id,owner_subject_id,title,kind,visibility,publication_slug,published_at,
        root_node_id,resource_revision,content_revision,policy_revision,commit_ordinal) values
        ($1,'subject-owner','Relations','bookmarks','public','relations',current_timestamp,$2,'cr1','cc1','cp1',1),
        ($3,'subject-other','Other','bookmarks','private',null,null,$4,'ocr1','occ1','ocp1',1)`,
      [COLLECTION_ID, ROOT_ID, OTHER_COLLECTION_ID, OTHER_ROOT_ID]);
      await client.query(`insert into nodes(id,collection_id,parent_id,kind,is_root,title,url,description,tags,
        visibility,position_token,resource_revision,children_revision) values
        ($1,$5,null,'folder',true,'Root',null,null,'[]','inherit',null,'rr1','rch1'),
        ($2,$5,$1,'bookmark',false,'From','https://from.test',null,'[]','inherit','A','fr1','fch1'),
        ($3,$5,$1,'bookmark',false,'To','https://to.test',null,'[]','inherit','B','tr1','tch1'),
        ($4,$5,$1,'bookmark',false,'Third','https://third.test',null,'[]','inherit','C','xr1','xch1'),
        ($6,$7,null,'folder',true,'Other',null,null,'[]','inherit',null,'or1','och1')`,
      [ROOT_ID, FROM_ID, TO_ID, THIRD_ID, COLLECTION_ID, OTHER_ROOT_ID, OTHER_COLLECTION_ID]);
      await client.query(`insert into collection_members(collection_id,subject_id,role) values
        ($1,'subject-owner','owner'),($1,'subject-editor','editor'),($1,'subject-member','viewer')`, [COLLECTION_ID]);
      for (const id of [COLLECTION_ID, OTHER_COLLECTION_ID]) {
        const row = (await client.query(`select * from collections where id=$1`, [id])).rows[0];
        const payload = materializeCollectionPayload({ id: row.id, ownerSubjectId: row.owner_subject_id,
          title: row.title, summary: row.summary, kind: row.kind, visibility: row.visibility,
          rootNodeId: row.root_node_id, resourceRevision: row.resource_revision,
          contentRevision: row.content_revision, policyRevision: row.policy_revision,
          commitOrdinal: row.commit_ordinal, createdAt: row.created_at, updatedAt: row.updated_at,
          deletedAt: row.deleted_at });
        if (!payload.ok) throw new Error(payload.reason);
        await client.query(`update collections set payload_json=$2,payload_schema_version=1,
          payload_authority_status='backfilled' where id=$1`, [id, payload.payload]);
      }
      for (const id of [ROOT_ID, FROM_ID, TO_ID, THIRD_ID, OTHER_ROOT_ID]) {
        const row = (await client.query(`select * from nodes where id=$1`, [id])).rows[0];
        const payload = materializeNodePayload({ id: row.id, collectionId: row.collection_id,
          parentId: row.parent_id, kind: row.kind, isRoot: row.is_root, title: row.title,
          url: row.url, description: row.description, tags: row.tags, visibility: row.visibility,
          positionToken: row.position_token, resourceRevision: row.resource_revision,
          childrenRevision: row.children_revision, createdAt: row.created_at, updatedAt: row.updated_at,
          deletedAt: row.deleted_at, deletedCommitOrdinal: row.deleted_commit_ordinal });
        if (!payload.ok) throw new Error(payload.reason);
        await client.query(`update nodes set payload_json=$2,payload_schema_version=1,
          payload_authority_status='backfilled' where id=$1`, [id, payload.payload]);
      }
      await client.query('commit');
    } catch (error) { await client.query('rollback'); throw error; }
    finally { client.release(); }
  }
});
