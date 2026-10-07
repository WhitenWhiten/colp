import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, test } from 'vitest';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import { createPostgresAnnotationMutationUnitOfWork, type AnnotationMutationFaultContext } from '../../../src/infrastructure/collections/index.js';
import {
  AnnotationCreateError,
  createAnnotation,
  toProductAnnotationView,
  materializeCollectionPayload,
  materializeNodePayload,
  type CreateAnnotationInput,
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

const COLLECTION_ID = Buffer.alloc(16, 1).toString('base64url');
const ROOT_ID = 'annotation-pg-root';
const NODE_ID = 'annotation-pg-node';
const OTHER_COLLECTION_ID = Buffer.alloc(16, 2).toString('base64url');
const OTHER_ROOT_ID = 'annotation-pg-other-root';

describeWithPostgres('P2B-04 PostgreSQL Annotation canonical create', () => {
  let isolated: IsolatedPostgresRuntime;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('phase2b_annotation_create', { maxConnections: 12 });
    await runMigrations(isolated.runtime.db, 'latest');
  }, 120_000);
  afterAll(async () => isolated?.close());
  beforeEach(async () => resetFixture());

  function command(options: {
    principalId?: string; subjectId?: string; annotationId?: string; operationId?: string;
    commandId?: string; fingerprint?: string; subject?: { type: 'collection' | 'node'; id: string };
    visibility?: 'public' | 'unlisted' | 'protected' | 'private'; value?: unknown;
    type?: 'note' | 'summary' | 'tldr' | 'highlight' | 'rating' | 'custom' | 'reading_state';
  } = {}): CreateAnnotationInput {
    const principalId = options.principalId ?? 'principal-owner';
    return {
      actor: { principalId, subjectId: options.subjectId ?? 'subject-owner', principalType: 'account',
        creator: { id: `https://known.test/profiles/${principalId}`, name: principalId } },
      command: { commandId: options.commandId ?? randomUUID(), fingerprint: options.fingerprint ?? randomUUID() },
      collectionId: COLLECTION_ID,
      annotation: { subject: options.subject ?? { type: 'node', id: NODE_ID },
        type: options.type ?? 'note', format: 'plain', value: options.value ?? 'PostgreSQL note',
        visibility: options.visibility ?? 'protected', extensions: {} },
      annotationId: options.annotationId ?? `annotation-${randomUUID()}`,
      operationId: options.operationId ?? `operation-${randomUUID()}`,
    };
  }

  async function execute(input: CreateAnnotationInput, fault?: (context: AnnotationMutationFaultContext) => void | Promise<void>) {
    return createPostgresAnnotationMutationUnitOfWork(isolated.runtime.db, {
      ...(fault ? { faultInjector: { afterPhase: fault } } : {}),
    }).execute((ports) => createAnnotation(ports, input));
  }

  test('concurrent Extension replicas create exactly one private note and replay the winner without duplication', async () => {
    const first = { ...command({ visibility: 'private' }), privateNoteSingleton: true };
    const second = { ...command({ visibility: 'private' }), privateNoteSingleton: true };
    const results = await Promise.allSettled([execute(first), execute(second)]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    const rejected = results.find(result => result.status === 'rejected') as PromiseRejectedResult;
    assert.ok(rejected.reason instanceof AnnotationCreateError);
    assert.equal(rejected.reason.code, 'annotation_note_already_exists');
    const winner = results[0]?.status === 'fulfilled' ? first : second;
    assert.equal((await execute(winner)).kind, 'replay');
    const rows = await isolated.runtime.db.selectFrom('annotations').select('id')
      .where('collection_id', '=', COLLECTION_ID).where('subject_id', '=', NODE_ID)
      .where('visibility', '=', 'private').where('deleted_at', 'is', null).execute();
    assert.equal(rows.length, 1);
  });

  test('commits complete canonical payload, ledger, revisions, Operation, Audit, Outbox and receipt atomically', async () => {
    const input = command({ annotationId: 'annotation-atomic', operationId: 'operation-atomic' });
    const result = await execute(input);
    assert.equal(result.kind, 'created');
    const state = await sideEffectState(input.annotationId!, input.operationId!, input.command.commandId);
    assert.deepEqual(state.counts, {
      annotation: 1, ledger: 5, resourceRevision: 1, contentRevision: 1,
      operation: 1, audit: 1, outbox: 2, receipt: 1,
    });
    assert.equal(state.row.creator_principal_id, input.actor.principalId);
    assert.equal(state.row.collection_id, COLLECTION_ID);
    assert.equal(state.row.subject_type, 'node');
    assert.equal(state.row.subject_id, NODE_ID);
    assert.equal(state.row.payload_json.id, input.annotationId);
    assert.equal(state.row.payload_json.collectionId, COLLECTION_ID);
    assert.equal(state.row.payload_json.creator.id, input.actor.creator.id);
    assert.equal(state.row.payload_json.revision, state.row.resource_revision);
    assert.equal(state.row.payload_json.visibility, state.row.visibility);

    const event = (await isolated.runtime.pool.query(`select event.* from outbox_events event
      join operations operation on operation.collection_id=event.aggregate_scope
        and operation.commit_ordinal=event.commit_ordinal
      where operation.operation_id=$1 and event.event_type='annotation.created'`,
    [input.operationId])).rows[0];
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
    const projection = await isolated.runtime.pool.query(`select resource_type,resource_id
      from collection_mutation_projection_resources where collection_id=$1 and resource_id=$2`,
    [COLLECTION_ID, input.annotationId]);
    assert.deepEqual(projection.rows, [{ resource_type: 'annotation', resource_id: input.annotationId }]);
  });

  test('supports Collection and Node subjects and rejects cross-Collection/deleted subjects', async () => {
    assert.equal((await execute(command({ subject: { type: 'collection', id: COLLECTION_ID } }))).kind, 'created');
    assert.equal((await execute(command())).kind, 'created');
    await assert.rejects(() => execute(command({ subject: { type: 'node', id: OTHER_ROOT_ID } })),
      (error: unknown) => error instanceof AnnotationCreateError && error.code === 'invalid_annotation_subject');
    await isolated.runtime.pool.query(`update nodes set deleted_at = current_timestamp where id = $1`, [NODE_ID]);
    await assert.rejects(() => execute(command()),
      (error: unknown) => error instanceof AnnotationCreateError && error.code === 'invalid_annotation_subject');
  });

  test('uses independent owner/editor/member creator/outsider fixtures', async () => {
    assert.equal((await execute(command())).kind, 'created');
    assert.equal((await execute(command({ principalId: 'principal-editor', subjectId: 'subject-editor' }))).kind, 'created');
    const privateMember = command({ principalId: 'principal-member', subjectId: 'subject-member',
      visibility: 'private', annotationId: 'annotation-member-private' });
    assert.equal((await execute(privateMember)).kind, 'created');
    const privateOwner = await isolated.runtime.pool.query(`select creator_principal_id,payload_json->'creator' creator
      from annotations where id='annotation-member-private'`);
    assert.deepEqual(privateOwner.rows[0], {
      creator_principal_id: 'principal-member', creator: privateMember.actor.creator,
    });
    const editorSpoof = command({ principalId: 'principal-editor', subjectId: 'subject-editor', visibility: 'private' });
    await assert.rejects(() => execute({ ...editorSpoof, annotation: {
      ...editorSpoof.annotation, creator: privateMember.actor.creator,
    } as never }), (error: unknown) => error instanceof AnnotationCreateError
      && error.code === 'untrusted_annotation_creator');
    await assert.rejects(() => execute(command({ principalId: 'principal-member', subjectId: 'subject-member' })),
      (error: unknown) => error instanceof AnnotationCreateError && error.code === 'insufficient_annotation_permission');
    await assert.rejects(() => execute(command({ principalId: 'principal-outsider', subjectId: 'subject-outsider' })),
      (error: unknown) => error instanceof AnnotationCreateError && error.code === 'annotation_not_found');
  });

  test('keeps exact replay stable and every side effect single; fingerprint reuse never mutates', async () => {
    const commandId = randomUUID();
    const first = command({ annotationId: 'annotation-replay', operationId: 'operation-replay', commandId, fingerprint: 'same' });
    const created = await execute(first);
    const replay = await execute(first);
    assert.equal(created.kind, 'created');
    assert.equal(replay.kind, 'replay');
    if (created.kind === 'created' && replay.kind === 'replay') {
      assert.equal(replay.status, 201);
      assert.deepEqual(JSON.parse(Buffer.from(replay.body).toString('utf8')),
        toProductAnnotationView(created.annotation));
      assert.deepEqual(replay.stableHeaders, {
        'cache-control': 'private, no-store',
        'content-type': 'application/json',
        etag: `"${created.annotation.revision}"`,
        location: `/api/v1/collections/${COLLECTION_ID}/annotations/${created.annotation.id}`,
      });
      assert.equal(replay.targetIdentity, created.annotation.id);
    }
    const beforeReuse = await sideEffectState(first.annotationId!, first.operationId!, commandId);
    const reused = await execute(command({ annotationId: 'annotation-second', operationId: 'operation-second', commandId, fingerprint: 'different' }));
    assert.deepEqual(reused, { kind: 'reused' });
    const afterReuse = await sideEffectState(first.annotationId!, first.operationId!, commandId);
    assert.deepEqual(afterReuse.counts, beforeReuse.counts);
    assert.equal((await isolated.runtime.pool.query(`select count(*)::int count from annotations where id = 'annotation-second'`)).rows[0]?.count, 0);
  });

  test('serializes simultaneous creates through the real Collection row lock', async () => {
    let signalFirstLocked!: () => void;
    let releaseFirst!: () => void;
    const firstLocked = new Promise<void>((resolve) => { signalFirstLocked = resolve; });
    const firstMayCommit = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const first = execute(command({ annotationId: 'annotation-concurrent-a', operationId: 'operation-concurrent-a' }), async (context) => {
      if (context.phase === 'ledger') {
        signalFirstLocked();
        await firstMayCommit;
      }
    });
    await firstLocked;
    const second = execute(command({ annotationId: 'annotation-concurrent-b', operationId: 'operation-concurrent-b' }));
    let observedBlockedWriter = false;
    for (let attempt = 0; attempt < 50 && !observedBlockedWriter; attempt += 1) {
      const locks = await isolated.runtime.pool.query<{ blocked: number }>(`select count(*)::int blocked
        from pg_stat_activity where datname=current_database()
          and wait_event_type='Lock' and cardinality(pg_blocking_pids(pid)) > 0`);
      observedBlockedWriter = (locks.rows[0]?.blocked ?? 0) > 0;
      if (!observedBlockedWriter) await new Promise<void>((resolve) => setImmediate(resolve));
    }
    assert.equal(observedBlockedWriter, true, 'second writer must visibly wait on the Collection row lock');
    releaseFirst();
    const [a, b] = await Promise.all([first, second]);
    assert.equal(a.kind, 'created'); assert.equal(b.kind, 'created');
    const rows = await isolated.runtime.pool.query<{ commit_ordinal: string }>(`
      select commit_ordinal::text from operations
       where operation_id in ('operation-concurrent-a','operation-concurrent-b') order by commit_ordinal
    `);
    assert.deepEqual(rows.rows.map((row) => row.commit_ordinal), ['2', '3']);
    assert.equal((await isolated.runtime.pool.query(`select count(*)::int count from annotations where id like 'annotation-concurrent-%'`)).rows[0]?.count, 2);
  });

  test('concurrent commands for the same Annotation ID have one winner and one complete side-effect set', async () => {
    let signalFirstLocked!: () => void;
    let releaseFirst!: () => void;
    const firstLocked = new Promise<void>((resolve) => { signalFirstLocked = resolve; });
    const firstMayCommit = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const firstInput = command({ annotationId: 'annotation-concurrent-same', operationId: 'operation-concurrent-winner' });
    const secondInput = command({ annotationId: 'annotation-concurrent-same', operationId: 'operation-concurrent-loser' });
    const first = execute(firstInput, async (context) => {
      if (context.phase === 'ledger') {
        signalFirstLocked();
        await firstMayCommit;
      }
    });
    await firstLocked;
    const second = execute(secondInput);
    await waitForCondition(async () => {
      const blocked = await isolated.runtime.pool.query<{ waiting: boolean }>(`
        select exists(select 1 from pg_stat_activity
          where application_name='known-test-phase2b_annotation_create'
            and cardinality(pg_blocking_pids(pid)) > 0) waiting
      `);
      return blocked.rows[0]?.waiting === true;
    }, {
      timeoutMs: 2_000,
      pollIntervalMs: 5,
      description: 'the competing annotation command to wait on the ledger transaction',
    });
    releaseFirst();
    const settled = await Promise.allSettled([first, second]);
    assert.equal(settled.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(settled.filter((result) => result.status === 'rejected').length, 1);
    const counts = await isolated.runtime.pool.query(`select
      (select count(*)::int from annotations where id='annotation-concurrent-same') annotation,
      (select count(*)::int from resource_revisions where resource_id='annotation-concurrent-same') resource_revision,
      (select count(*)::int from operations where operation_id in ('operation-concurrent-winner','operation-concurrent-loser')) operation,
      (select count(*)::int from audit_events where operation_id in ('operation-concurrent-winner','operation-concurrent-loser')) audit,
      (select count(*)::int from outbox_events event join operations operation
        on operation.collection_id=event.aggregate_scope and operation.commit_ordinal=event.commit_ordinal
        where operation.operation_id in ('operation-concurrent-winner','operation-concurrent-loser')) outbox,
      (select count(*)::int from product_command_receipts where command_id in ($1,$2) and completed_at is not null) receipt`,
    [firstInput.command.commandId, secondInput.command.commandId]);
    assert.deepEqual(counts.rows[0], {
      annotation: 1, resource_revision: 1, operation: 1, audit: 1, outbox: 2, receipt: 1,
    });
  });

  test('rolls back receipt/ledger/resource/revision/operation/audit/outbox fault points completely', { timeout: 30_000 }, async () => {
    for (const phase of ['receipt', 'ledger', 'resource', 'revision', 'operation', 'audit', 'outbox'] as const) {
      await resetFixture();
      const value = command({ annotationId: `annotation-fault-${phase}`, operationId: `operation-fault-${phase}` });
      const before = await authoritySnapshot();
      await assert.rejects(() => execute(value, (context) => {
        if (context.phase === phase) throw new Error(`fault-${phase}`);
      }), new RegExp(`fault-${phase}`));
      const state = await sideEffectState(value.annotationId!, value.operationId!, value.command.commandId);
      assert.deepEqual(state.counts, {
        annotation: 0, ledger: 0, resourceRevision: 0, contentRevision: 0,
        operation: 0, audit: 0, outbox: 0, receipt: 0,
      });
      assert.equal((await isolated.runtime.pool.query(`select commit_ordinal::text ordinal from collections where id=$1`, [COLLECTION_ID])).rows[0]?.ordinal, '1');
      assert.deepEqual(await authoritySnapshot(), before);
    }
  });

  test('private create emits no public cache purge while shared representation changes do', async () => {
    const privateInput = command({ annotationId: 'annotation-private', operationId: 'operation-private', visibility: 'private' });
    await execute(privateInput);
    const privatePurge = await isolated.runtime.pool.query<{ count: number }>(`
      select count(*)::int count from outbox_events event join operations operation
        on operation.collection_id=event.aggregate_scope and operation.commit_ordinal=event.commit_ordinal
        where operation.operation_id=$1 and event.event_type=$2`,
    [privateInput.operationId, PUBLICATION_CACHE_PURGE_EVENT_TYPE]);
    assert.equal(privatePurge.rows[0]?.count, 0);

    const shared = command({ annotationId: 'annotation-shared', operationId: 'operation-shared', visibility: 'public' });
    await execute(shared);
    const sharedPurge = await isolated.runtime.pool.query<{ count: number }>(`
      select count(*)::int count from outbox_events event join operations operation
        on operation.collection_id=event.aggregate_scope and operation.commit_ordinal=event.commit_ordinal
        where operation.operation_id=$1 and event.event_type=$2`,
    [shared.operationId, PUBLICATION_CACHE_PURGE_EVENT_TYPE]);
    assert.equal(sharedPurge.rows[0]?.count, 1);
  });

  test('ledger permanently rejects cross-resource type reuse and duplicate Annotation IDs', async () => {
    await isolated.runtime.pool.query(`insert into resource_id_ledger(resource_id,resource_type) values ('reused-id','node')`);
    await assert.rejects(() => execute(command({ annotationId: 'reused-id' })));
    await execute(command({ annotationId: 'same-annotation-id' }));
    await assert.rejects(() => execute(command({ annotationId: 'same-annotation-id' })));
    const ledger = await isolated.runtime.pool.query(`select resource_type from resource_id_ledger where resource_id in ('reused-id','same-annotation-id') order by resource_id`);
    assert.deepEqual(ledger.rows, [{ resource_type: 'node' }, { resource_type: 'annotation' }]);
  });

  async function sideEffectState(annotationId: string, operationId: string, commandId: string) {
    const resource = await isolated.runtime.pool.query(`select * from annotations where id=$1`, [annotationId]);
    const result = await isolated.runtime.pool.query(`select
      (select count(*)::int from annotations where id=$1) annotation,
      (select count(*)::int from resource_id_ledger
        where resource_id in ($1,$2) or resource_type in ('outbox','domain-event')) ledger,
      (select count(*)::int from resource_revisions where resource_id=$1) resource_revision,
      (select count(*)::int from content_revisions where ordinal > 1) content_revision,
      (select count(*)::int from operations where operation_id=$2) operation,
      (select count(*)::int from audit_events where operation_id=$2) audit,
      (select count(*)::int from outbox_events event join operations operation
        on operation.collection_id=event.aggregate_scope and operation.commit_ordinal=event.commit_ordinal
        where operation.operation_id=$2) outbox,
      (select count(*)::int from product_command_receipts where command_id=$3 and completed_at is not null) receipt
    `, [annotationId, operationId, commandId]);
    const row = result.rows[0];
    return { row: resource.rows[0] ?? {}, counts: { annotation: row.annotation, ledger: row.ledger,
      resourceRevision: row.resource_revision, contentRevision: row.content_revision,
      operation: row.operation, audit: row.audit, outbox: row.outbox, receipt: row.receipt } };
  }

  async function authoritySnapshot() {
    const snapshot = await isolated.runtime.pool.query(`select
      (select count(*)::int from annotations) annotations,
      (select count(*)::int from resource_id_ledger) ledger,
      (select count(*)::int from resource_revisions) resource_revisions,
      (select count(*)::int from content_revisions) content_revisions,
      (select count(*)::int from policy_revisions) policy_revisions,
      (select count(*)::int from children_revisions) children_revisions,
      (select count(*)::int from operations) operations,
      (select count(*)::int from audit_events) audits,
      (select count(*)::int from outbox_events) outbox,
      (select count(*)::int from product_command_receipts) receipts,
      (select resource_revision from collections where id=$1) collection_resource_revision,
      (select content_revision from collections where id=$1) collection_content_revision,
      (select policy_revision from collections where id=$1) collection_policy_revision,
      (select commit_ordinal::text from collections where id=$1) collection_ordinal,
      (select updated_at::text from collections where id=$1) collection_updated_at,
      (select payload_json::text from collections where id=$1) collection_payload`, [COLLECTION_ID]);
    return snapshot.rows[0];
  }

  async function resetFixture() {
    const pool = isolated.runtime.pool;
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query('set constraints all deferred');
    await truncateGuardedTablesInTransaction(client, `truncate table product_command_receipts,outbox_events,audit_events,operations,
      policy_revisions,content_revisions,children_revisions,resource_revisions,annotations,
      collection_policies,collection_members,nodes,collections,resource_id_ledger cascade`);
    await client.query(`insert into resource_id_ledger(resource_id,resource_type) values
      ($1,'collection'),($2,'node'),($3,'node'),($4,'collection'),($5,'node')`,
    [COLLECTION_ID, ROOT_ID, NODE_ID, OTHER_COLLECTION_ID, OTHER_ROOT_ID]);
    await client.query(`insert into collections(id,owner_subject_id,title,kind,visibility,publication_slug,published_at,root_node_id,
      resource_revision,content_revision,policy_revision,commit_ordinal) values
      ($1,'subject-owner','Annotations','bookmarks','public','annotations',current_timestamp,$2,'cr1','cc1','cp1',1),
      ($3,'subject-other','Other','bookmarks','private',null,null,$4,'ocr1','occ1','ocp1',1)`,
    [COLLECTION_ID, ROOT_ID, OTHER_COLLECTION_ID, OTHER_ROOT_ID]);
    await client.query(`insert into nodes(id,collection_id,parent_id,kind,is_root,title,url,description,tags,
      visibility,position_token,resource_revision,children_revision) values
      ($1,$3,null,'folder',true,'Root',null,null,'[]','inherit',null,'rr1','rch1'),
      ($2,$3,$1,'bookmark',false,'Subject','https://example.test',null,'[]','inherit','U','nr1','nch1'),
      ($4,$5,null,'folder',true,'Other root',null,null,'[]','inherit',null,'orr1','orch1')`,
    [ROOT_ID, NODE_ID, COLLECTION_ID, OTHER_ROOT_ID, OTHER_COLLECTION_ID]);
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
      assert.equal(payload.ok, true); if (!payload.ok) throw new Error(payload.reason);
      await client.query(`update collections set payload_json=$2,payload_schema_version=1,payload_authority_status='backfilled' where id=$1`, [id, payload.payload]);
    }
    for (const id of [ROOT_ID, NODE_ID, OTHER_ROOT_ID]) {
      const row = (await client.query(`select * from nodes where id=$1`, [id])).rows[0];
      const payload = materializeNodePayload({ id: row.id, collectionId: row.collection_id,
        parentId: row.parent_id, kind: row.kind, isRoot: row.is_root, title: row.title,
        url: row.url, description: row.description, tags: row.tags, visibility: row.visibility,
        positionToken: row.position_token, resourceRevision: row.resource_revision,
        childrenRevision: row.children_revision, createdAt: row.created_at, updatedAt: row.updated_at,
        deletedAt: row.deleted_at, deletedCommitOrdinal: row.deleted_commit_ordinal });
      assert.equal(payload.ok, true); if (!payload.ok) throw new Error(payload.reason);
      await client.query(`update nodes set payload_json=$2,payload_schema_version=1,payload_authority_status='backfilled' where id=$1`, [id, payload.payload]);
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
