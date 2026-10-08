import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, test } from 'vitest';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import { createPostgresAnnotationMutationUnitOfWork, createPostgresCanonicalMutationUnitOfWork, type AnnotationMutationFaultContext, type PostgresCanonicalMutationFaultContext } from '../../../src/infrastructure/collections/index.js';
import {
  AnnotationCreateError,
  AnnotationDeleteError,
  AnnotationUpdateError,
  createAnnotation,
  deleteAnnotation,
  deleteCollectionNode,
  materializeCollectionPayload,
  materializeNodePayload,
  updateAnnotation,
  type CreateAnnotationInput,
  type DeleteAnnotationInput,
  type UpdateAnnotationInput,
} from '../../../src/modules/collections/index.js';
import { PUBLICATION_CACHE_PURGE_EVENT_TYPE } from '../../../src/infrastructure/outbox/index.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
  truncateGuardedTablesInTransaction,
} from '../../support/postgres-test-runtime.js';

const COLLECTION_ID = Buffer.alloc(16, 4).toString('base64url');
const OWNER_PROFILE_ID = Buffer.alloc(16, 8).toString('base64url');
const ROOT_ID = 'annotation-delete-pg-root';
const FOLDER_ID = 'annotation-delete-pg-folder';
const NODE_ID = 'annotation-delete-pg-node';

describeWithPostgres('P2B-06 PostgreSQL canonical Annotation deletion and subject cascade', () => {
  let isolated: IsolatedPostgresRuntime;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('phase2b_annotation_delete', { maxConnections: 16 });
    await runMigrations(isolated.runtime.db, 'latest');
  }, 120_000);
  afterAll(async () => isolated?.close());
  beforeEach(async () => resetFixture());

  function annotationUow(fault?: (context: AnnotationMutationFaultContext) => void | Promise<void>) {
    return createPostgresAnnotationMutationUnitOfWork(isolated.runtime.db, {
      ...(fault ? { faultInjector: { afterPhase: fault } } : {}),
    });
  }

  function createInput(annotationId: string, options: {
    subjectId?: string;
    subjectType?: 'collection' | 'node';
    visibility?: 'public' | 'unlisted' | 'protected' | 'private';
    principalId?: string;
    subjectIdActor?: string;
    operationId?: string;
  } = {}): CreateAnnotationInput {
    const principalId = options.principalId ?? 'principal-creator';
    return {
      actor: { principalId, subjectId: options.subjectIdActor ?? 'subject-creator', principalType: 'account',
        creator: { id: `https://known.test/profiles/${principalId}`, name: principalId } },
      command: { commandId: randomUUID(), fingerprint: randomUUID() },
      collectionId: COLLECTION_ID,
      annotation: { subject: { type: options.subjectType ?? 'node',
        id: options.subjectId ?? (options.subjectType === 'collection' ? COLLECTION_ID : NODE_ID) }, type: 'note',
        format: 'plain', value: `body-${annotationId}`, visibility: options.visibility ?? 'protected', extensions: {} },
      annotationId,
      operationId: options.operationId ?? `operation-create-${annotationId}`,
    };
  }

  function deleteInput(annotationId: string, revision: string, options: {
    principalId?: string; subjectId?: string; commandId?: string; fingerprint?: string; operationId?: string;
  } = {}): DeleteAnnotationInput {
    return {
      actor: { principalId: options.principalId ?? 'principal-creator',
        subjectId: options.subjectId ?? 'subject-creator', principalType: 'account' },
      command: { commandId: options.commandId ?? randomUUID(), fingerprint: options.fingerprint ?? randomUUID() },
      collectionId: COLLECTION_ID,
      annotationId,
      precondition: { kind: 'single-strong-if-match', entityTag: `"${revision}"`, expectedRevision: revision },
      operationId: options.operationId ?? `operation-delete-${annotationId}`,
    };
  }

  async function seed(annotationId: string, options: Parameters<typeof createInput>[1] = {}) {
    const result = await annotationUow().execute((ports) => createAnnotation(ports, createInput(annotationId, options)));
    assert.equal(result.kind, 'created');
    if (result.kind !== 'created') throw new Error('seed Annotation was not created');
    return result.annotation;
  }

  async function executeDelete(command: DeleteAnnotationInput,
    fault?: (context: AnnotationMutationFaultContext) => void | Promise<void>) {
    return annotationUow(fault).execute((ports) => deleteAnnotation(ports, command));
  }

  test('soft-deletes one authoritative row with permanent ledger, revisions, receipt, audit and closed event', async () => {
    const seeded = await seed('annotation-delete-atomic', { visibility: 'public' });
    const command = deleteInput(seeded.id, seeded.revision, { operationId: 'operation-delete-atomic' });
    const before = await collectionFence();
    const result = await executeDelete(command);
    assert.equal(result.kind, 'deleted');
    if (result.kind !== 'deleted') return;

    const row = (await isolated.runtime.pool.query(`select * from annotations where id=$1`, [seeded.id])).rows[0];
    assert.ok(row.deleted_at instanceof Date);
    assert.equal(BigInt(row.deleted_commit_ordinal), result.commitOrdinal);
    assert.equal(row.resource_revision, result.receipt.deleteRevision);
    assert.equal(row.payload_json.revision, row.resource_revision);
    assert.equal(row.payload_json.deletedAt, result.receipt.deletedAt);
    assert.equal(row.payload_json.deletedCommitOrdinal, result.commitOrdinal.toString());
    assert.equal(row.payload_json.deletionOperationId, result.operationId);
    assert.equal(result.receipt.affectedCount, 1);
    assert.equal(Date.parse(result.receipt.purgeAfter) - Date.parse(result.receipt.deletedAt), 30 * 24 * 60 * 60 * 1000);

    const after = await collectionFence();
    assert.equal(BigInt(after.commit_ordinal), BigInt(before.commit_ordinal) + 1n);
    assert.notEqual(after.content_revision, before.content_revision);
    assert.equal(after.policy_revision, before.policy_revision);
    assert.equal((await isolated.runtime.pool.query(`select count(*)::int count from resource_id_ledger
      where resource_id=$1 and resource_type='annotation'`, [seeded.id])).rows[0].count, 1);
    assert.deepEqual(await effectCounts(result.operationId, command.command.commandId), {
      revision: 1, contentRevision: 1, operation: 1, audit: 1, deletedOutbox: 1, purgeOutbox: 1, receipt: 1,
    });
    const receiptRetention = (await isolated.runtime.pool.query(`select
      extract(epoch from (result_expires_at-completed_at))::bigint seconds,
      compact_claim from product_command_receipts where command_id=$1`,
    [command.command.commandId])).rows[0];
    assert.ok(BigInt(receiptRetention.seconds) >= 30n * 24n * 60n * 60n);
    assert.equal(receiptRetention.compact_claim, false);
    const event = (await isolated.runtime.pool.query(`select event.* from outbox_events event
      join operations operation on operation.collection_id=event.aggregate_scope
        and operation.commit_ordinal=event.commit_ordinal
      where operation.operation_id=$1 and event.event_type='annotation.deleted'`,
    [result.operationId])).rows[0];
    assert.equal(event.event_version, 1);
    assert.equal(event.aggregate_revision, result.receipt.deleteRevision);
    assert.deepEqual(Object.keys(event.payload_json).sort(), [
      'affectedCount', 'annotationId', 'collectionId', 'contentRevision', 'deletedAt',
      'deleteRevision', 'operationId', 'subjectId', 'subjectType', 'visibility',
    ].sort());
    assert.equal(JSON.stringify(event.payload_json).includes('body-'), false);
    assert.equal(JSON.stringify(event.payload_json).includes('principal-creator'), false);
  });

  test('single canonical delete supports a Collection-subject Annotation without widening its scope', async () => {
    const seeded = await seed('annotation-delete-collection-subject', {
      subjectType: 'collection', subjectId: COLLECTION_ID, visibility: 'protected',
    });
    const result = await executeDelete(deleteInput(seeded.id, seeded.revision, {
      operationId: 'operation-delete-collection-subject',
    }));
    assert.equal(result.kind, 'deleted');
    if (result.kind === 'deleted') {
      assert.equal(result.receipt.affectedCount, 1);
      assert.equal(result.receipt.scope, 'single');
    }
    const row = (await isolated.runtime.pool.query(`select subject_type,subject_id,deleted_at
      from annotations where id=$1`, [seeded.id])).rows[0];
    assert.equal(row.subject_type, 'collection');
    assert.equal(row.subject_id, COLLECTION_ID);
    assert.ok(row.deleted_at instanceof Date);
  });

  test('exact replay is byte/header stable; reuse and a new command against tombstone have zero mutations', async () => {
    const seeded = await seed('annotation-delete-replay');
    const commandId = randomUUID();
    const command = deleteInput(seeded.id, seeded.revision, {
      commandId, fingerprint: 'same', operationId: 'operation-delete-replay',
    });
    const first = await executeDelete(command);
    const replay = await executeDelete(command);
    assert.equal(first.kind, 'deleted');
    assert.equal(replay.kind, 'replay');
    if (first.kind === 'deleted' && replay.kind === 'replay') {
      assert.equal(replay.status, 200);
      assert.deepEqual(JSON.parse(Buffer.from(replay.body).toString()), {
        receipt: first.receipt,
        fence: first.fence,
      });
      assert.deepEqual(replay.stableHeaders, {
        'cache-control': 'private, no-store', 'content-type': 'application/json',
        location: `/api/v1/collections/${COLLECTION_ID}/annotations/${seeded.id}`,
        etag: `"${first.receipt.deleteRevision}"`,
      });
      assert.equal(replay.targetIdentity, seeded.id);
      assert.deepEqual(await effectCounts(first.operationId, commandId), {
        revision: 1, contentRevision: 1, operation: 1, audit: 1,
        deletedOutbox: 1, purgeOutbox: 1, receipt: 1,
      });
      assert.equal((await isolated.runtime.pool.query(`select count(*)::int count from annotations
        where id=$1`, [seeded.id])).rows[0].count, 1);
      assert.equal((await isolated.runtime.pool.query(`select count(*)::int count from resource_id_ledger
        where resource_id=$1`, [seeded.id])).rows[0].count, 1);
    }
    const before = await databaseSnapshot();
    assert.deepEqual(await executeDelete(deleteInput(seeded.id, seeded.revision, {
      commandId, fingerprint: 'different', operationId: 'operation-delete-reused',
    })), { kind: 'reused' });
    assert.deepEqual(await databaseSnapshot(), before);
    await assert.rejects(() => executeDelete(deleteInput(seeded.id, seeded.revision, {
      operationId: 'operation-delete-tombstone-new-command',
    })), (error: unknown) => error instanceof AnnotationDeleteError && error.code === 'annotation_not_found');
    assert.deepEqual(await databaseSnapshot(), before);
  });

  test('conceals private authority and shared viewer/outsider while creator/owner/editor matrix is exact', async () => {
    const privateAnnotation = await seed('annotation-delete-private', { visibility: 'private' });
    for (const actor of [
      { principalId: 'principal-owner', subjectId: 'subject-owner' },
      { principalId: 'principal-editor', subjectId: 'subject-editor' },
      { principalId: 'principal-outsider', subjectId: 'subject-outsider' },
    ]) {
      const before = await databaseSnapshot();
      await assert.rejects(() => executeDelete(deleteInput(privateAnnotation.id, privateAnnotation.revision, actor)),
        (error: unknown) => error instanceof AnnotationDeleteError && error.code === 'annotation_not_found');
      assert.deepEqual(await databaseSnapshot(), before);
    }
    assert.equal((await executeDelete(deleteInput(privateAnnotation.id, privateAnnotation.revision))).kind, 'deleted');
    assert.equal((await isolated.runtime.pool.query(`select count(*)::int count from outbox_events event
      join operations operation on operation.collection_id=event.aggregate_scope
        and operation.commit_ordinal=event.commit_ordinal
      where operation.operation_id='operation-delete-annotation-delete-private' and event.event_type=$1`,
    [PUBLICATION_CACHE_PURGE_EVENT_TYPE])).rows[0].count, 0);

    for (const actor of [
      { principalId: 'principal-owner', subjectId: 'subject-owner' },
      { principalId: 'principal-editor', subjectId: 'subject-editor' },
    ]) {
      const shared = await seed(`annotation-delete-${actor.principalId}`);
      assert.equal((await executeDelete(deleteInput(shared.id, shared.revision, actor))).kind, 'deleted');
    }
    for (const actor of [
      { principalId: 'principal-viewer', subjectId: 'subject-viewer' },
      { principalId: 'principal-outsider', subjectId: 'subject-outsider' },
    ]) {
      const shared = await seed(`annotation-delete-denied-${actor.principalId}`);
      await assert.rejects(() => executeDelete(deleteInput(shared.id, shared.revision, actor)),
        (error: unknown) => error instanceof AnnotationDeleteError && error.code === 'annotation_not_found');
    }
  });

  test('stale and update/delete lock races have one winner with no partial loser effects', async () => {
    const staleSeed = await seed('annotation-delete-stale');
    const before = await databaseSnapshot();
    await assert.rejects(() => executeDelete(deleteInput(staleSeed.id, 'stale-revision')),
      (error: unknown) => error instanceof AnnotationDeleteError && error.code === 'annotation_precondition_failed');
    assert.deepEqual(await databaseSnapshot(), before);

    const race = await seed('annotation-delete-race');
    let releaseDelete!: () => void;
    let signalDeleted!: () => void;
    const deleted = new Promise<void>((resolve) => { signalDeleted = resolve; });
    const mayCommit = new Promise<void>((resolve) => { releaseDelete = resolve; });
    const winner = executeDelete(deleteInput(race.id, race.revision, { operationId: 'operation-delete-race' }),
      async (context) => { if (context.phase === 'resource') { signalDeleted(); await mayCommit; } });
    await deleted;
    const update: UpdateAnnotationInput = {
      actor: { principalId: 'principal-creator', subjectId: 'subject-creator', principalType: 'account' },
      command: { commandId: randomUUID(), fingerprint: randomUUID() }, collectionId: COLLECTION_ID,
      annotationId: race.id,
      precondition: { kind: 'single-strong-if-match', entityTag: `"${race.revision}"`, expectedRevision: race.revision },
      patch: { value: 'loser' }, operationId: 'operation-update-after-delete',
    };
    const loser = annotationUow().execute((ports) => updateAnnotation(ports, update));
    await assertBlocked();
    releaseDelete();
    assert.equal((await winner).kind, 'deleted');
    await assert.rejects(() => loser, (error: unknown) =>
      error instanceof AnnotationUpdateError && error.code === 'annotation_not_found');
    assert.equal((await isolated.runtime.pool.query(`select count(*)::int count from operations
      where operation_id='operation-update-after-delete'`)).rows[0].count, 0);
  });

  test('an update that wins the Collection lock makes the competing delete stably stale', async () => {
    const race = await seed('annotation-update-wins-delete-race');
    let releaseUpdate!: () => void;
    let signalUpdated!: () => void;
    const updated = new Promise<void>((resolve) => { signalUpdated = resolve; });
    const mayCommit = new Promise<void>((resolve) => { releaseUpdate = resolve; });
    const update: UpdateAnnotationInput = {
      actor: { principalId: 'principal-creator', subjectId: 'subject-creator', principalType: 'account' },
      command: { commandId: randomUUID(), fingerprint: randomUUID() }, collectionId: COLLECTION_ID,
      annotationId: race.id,
      precondition: { kind: 'single-strong-if-match', entityTag: `"${race.revision}"`, expectedRevision: race.revision },
      patch: { value: 'update winner' }, operationId: 'operation-update-wins-delete-race',
    };
    const winner = annotationUow(async (context) => {
      if (context.phase === 'resource') { signalUpdated(); await mayCommit; }
    }).execute((ports) => updateAnnotation(ports, update));
    await updated;
    const loserCommand = deleteInput(race.id, race.revision, {
      operationId: 'operation-delete-after-update',
    });
    const loser = executeDelete(loserCommand);
    await assertBlocked();
    releaseUpdate();
    assert.equal((await winner).kind, 'updated');
    await assert.rejects(() => loser, (error: unknown) =>
      error instanceof AnnotationDeleteError && error.code === 'annotation_precondition_failed');
    assert.deepEqual(await effectCounts('operation-delete-after-update', loserCommand.command.commandId), {
      revision: 0, contentRevision: 0, operation: 0, audit: 0,
      deletedOutbox: 0, purgeOutbox: 0, receipt: 0,
    });
  });

  test('faults after each delete write class restore readable authority and every revision/fence', { timeout: 60_000 }, async () => {
    for (const phase of ['receipt', 'resource', 'revision', 'operation', 'audit', 'outbox'] as const) {
      await resetFixture();
      const seeded = await seed(`annotation-delete-fault-${phase}`);
      const before = await databaseSnapshot();
      await assert.rejects(() => executeDelete(deleteInput(seeded.id, seeded.revision, {
        operationId: `operation-delete-fault-${phase}`,
      }), (context) => { if (context.phase === phase) throw new Error(`fault-${phase}`); }),
      new RegExp(`fault-${phase}`));
      assert.deepEqual(await databaseSnapshot(), before);
      const recovered = (await isolated.runtime.pool.query(`select resource_revision,deleted_at,payload_json
        from annotations where collection_id=$1 and id=$2 and deleted_at is null`,
      [COLLECTION_ID, seeded.id])).rows[0];
      assert.equal(recovered.resource_revision, seeded.revision);
      assert.equal(recovered.deleted_at, null);
      assert.equal(recovered.payload_json.revision, seeded.revision);
    }
  });

  test('single Node and recursive subtree deletes canonically tombstone every live Annotation sidecar', { timeout: 60_000 }, async () => {
    const direct = await seed('annotation-cascade-direct');
    const directNode = await nodeRow(NODE_ID);
    const directResult = await executeNodeDelete(NODE_ID, directNode.resource_revision, false,
      undefined, 'operation-node-delete-direct');
    assert.equal(directResult.kind, 'deleted');
    const directRow = (await isolated.runtime.pool.query(`select * from annotations where id=$1`, [direct.id])).rows[0];
    assert.ok(directRow.deleted_at instanceof Date);
    assert.equal(BigInt(directRow.deleted_commit_ordinal), directResult.commitOrdinal);
    assert.equal((await isolated.runtime.pool.query(`select count(*)::int count from outbox_events
      where payload_json->>'operationId'=$1 and event_type='annotation.deleted'`,
    [directResult.operationId])).rows[0].count, 1);

    await resetFixture();
    const folderSidecar = await seed('annotation-cascade-folder', { subjectId: FOLDER_ID });
    const descendantSidecar = await seed('annotation-cascade-descendant', { subjectId: NODE_ID });
    const folder = await nodeRow(FOLDER_ID);
    const fence = await collectionFence();
    const subtree = await executeNodeDelete(FOLDER_ID, folder.resource_revision, true,
      fence.content_revision, 'operation-node-delete-subtree');
    assert.equal(subtree.kind, 'deleted');
    const rows = (await isolated.runtime.pool.query(`select id,deleted_at,deleted_commit_ordinal
      from annotations where id=any($1::text[]) order by id`, [[folderSidecar.id, descendantSidecar.id]])).rows;
    assert.equal(rows.length, 2);
    assert.ok(rows.every((row) => row.deleted_at instanceof Date
      && BigInt(row.deleted_commit_ordinal) === subtree.commitOrdinal));
    assert.equal((await isolated.runtime.pool.query(`select count(*)::int count from annotations a
      left join nodes n on n.id=a.subject_id and n.collection_id=a.collection_id
      where a.deleted_at is null and a.subject_type='node' and (n.id is null or n.deleted_at is not null)`)).rows[0].count, 0);
    assert.equal((await isolated.runtime.pool.query(`select count(*)::int count from outbox_events
      where payload_json->>'operationId'=$1 and event_type='annotation.deleted'`,
    [subtree.operationId])).rows[0].count, 2);
    const aggregateEvidence = (await isolated.runtime.pool.query(`select
      (select payload_json->'affectedAnnotationIds' from operation_payloads where operation_id=$1) operation_ids,
      (select details_json->'affectedAnnotationIds' from audit_event_payloads where event_id=(select id from audit_events where operation_id=$1)) audit_ids,
      (select count(*)::int from resource_revisions where collection_id=$2
        and ordinal=$3 and resource_id=any($4::text[])) sidecar_revisions`,
    [subtree.operationId, COLLECTION_ID, subtree.commitOrdinal.toString(),
      [folderSidecar.id, descendantSidecar.id]])).rows[0];
    assert.deepEqual([...aggregateEvidence.operation_ids].sort(), [folderSidecar.id, descendantSidecar.id].sort());
    assert.deepEqual([...aggregateEvidence.audit_ids].sort(), [folderSidecar.id, descendantSidecar.id].sort());
    assert.equal(aggregateEvidence.sidecar_revisions, 2);
    const cascadeEvents = (await isolated.runtime.pool.query(`select payload_json from outbox_events
      where payload_json->>'operationId'=$1 and event_type='annotation.deleted' order by aggregate_id`,
    [subtree.operationId])).rows;
    for (const event of cascadeEvents) {
      assert.deepEqual(Object.keys(event.payload_json).sort(), [
        'affectedCount', 'annotationId', 'collectionId', 'contentRevision', 'deletedAt',
        'deleteRevision', 'operationId', 'subjectId', 'subjectType', 'visibility',
      ].sort());
      assert.equal(JSON.stringify(event.payload_json).includes('body-'), false);
      assert.equal(JSON.stringify(event.payload_json).includes('principal-creator'), false);
    }
  });

  test('subject delete snapshot serializes a competing create and cannot leave a live orphan', { timeout: 60_000 }, async () => {
    const node = await nodeRow(NODE_ID);
    let releaseDelete!: () => void;
    let signalResource!: () => void;
    const resourceWritten = new Promise<void>((resolve) => { signalResource = resolve; });
    const mayCommit = new Promise<void>((resolve) => { releaseDelete = resolve; });
    const winner = createPostgresCanonicalMutationUnitOfWork(isolated.runtime.db, {
      canonicalFaultInjector: { async afterPhase(context: PostgresCanonicalMutationFaultContext) {
        if (context.phase === 'resource') { signalResource(); await mayCommit; }
      } },
    }).execute((ports) => deleteCollectionNode(ports, {
      actor: { principalId: 'principal-owner', subjectId: 'subject-owner', principalType: 'account' },
      command: { commandId: randomUUID(), fingerprint: randomUUID() }, collectionId: COLLECTION_ID,
      nodeId: NODE_ID, ifMatch: `"${node.resource_revision}"`, recursive: false,
      operationId: 'operation-node-delete-create-race',
    }));
    await resourceWritten;
    const loser = annotationUow().execute((ports) => createAnnotation(ports,
      createInput('annotation-create-after-delete-snapshot')));
    await assertBlocked();
    releaseDelete();
    assert.equal((await winner).kind, 'deleted');
    await assert.rejects(() => loser, (error: unknown) =>
      error instanceof AnnotationCreateError && error.code === 'invalid_annotation_subject');
    assert.equal((await isolated.runtime.pool.query(`select count(*)::int count from annotations
      where id='annotation-create-after-delete-snapshot'`)).rows[0].count, 0);
  });

  test('subject cascade rolls back sidecar tombstones and every evidence class at each write boundary', { timeout: 60_000 }, async () => {
    for (const phase of ['resource', 'revision', 'operation', 'audit', 'outbox', 'receipt'] as const) {
      await resetFixture();
      const sidecar = await seed(`annotation-cascade-fault-${phase}`);
      const node = await nodeRow(NODE_ID);
      const before = await databaseSnapshot();
      const uow = createPostgresCanonicalMutationUnitOfWork(isolated.runtime.db, {
        ...(phase === 'receipt' ? { faultInjector: {
          afterCallbackBeforeCommit() { throw new Error(`cascade-fault-${phase}`); },
        } } : { canonicalFaultInjector: {
          afterPhase(context: PostgresCanonicalMutationFaultContext) {
            if (context.phase === phase
              && (phase !== 'resource' || context.resourceId === sidecar.id)) {
              throw new Error(`cascade-fault-${phase}`);
            }
          },
        } }),
      });
      await assert.rejects(() => uow.execute((ports) => deleteCollectionNode(ports, {
        actor: { principalId: 'principal-owner', subjectId: 'subject-owner', principalType: 'account' },
        command: { commandId: randomUUID(), fingerprint: randomUUID() }, collectionId: COLLECTION_ID,
        nodeId: NODE_ID, ifMatch: `"${node.resource_revision}"`, recursive: false,
        operationId: `operation-cascade-fault-${phase}`,
      })), new RegExp(`cascade-fault-${phase}`));
      assert.deepEqual(await databaseSnapshot(), before);
      const recovered = (await isolated.runtime.pool.query(`select resource_revision,deleted_at
        from annotations where id=$1`, [sidecar.id])).rows[0];
      assert.equal(recovered.resource_revision, sidecar.revision);
      assert.equal(recovered.deleted_at, null);
    }
  });

  async function executeNodeDelete(nodeId: string, revision: string, recursive: boolean,
    contentRevision: string | undefined, operationId: string) {
    return createPostgresCanonicalMutationUnitOfWork(isolated.runtime.db).execute((ports) =>
      deleteCollectionNode(ports, {
        actor: { principalId: 'principal-owner', subjectId: 'subject-owner', principalType: 'account' },
        command: { commandId: randomUUID(), fingerprint: randomUUID() }, collectionId: COLLECTION_ID,
        nodeId, ifMatch: `"${revision}"`, recursive,
        ...(contentRevision ? { ifContentMatch: `"${contentRevision}"` } : {}), operationId,
      }));
  }

  async function assertBlocked() {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const state = await isolated.runtime.pool.query<{ blocked: number }>(`select count(*)::int blocked
        from pg_stat_activity where datname=current_database() and wait_event_type='Lock'
          and cardinality(pg_blocking_pids(pid)) > 0`);
      if ((state.rows[0]?.blocked ?? 0) > 0) return;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    assert.fail('competing transaction did not block on the Collection serialization lock');
  }

  async function nodeRow(nodeId: string) {
    return (await isolated.runtime.pool.query(`select * from nodes where id=$1`, [nodeId])).rows[0];
  }

  async function collectionFence() {
    return (await isolated.runtime.pool.query(`select resource_revision,content_revision,policy_revision,
      commit_ordinal::text from collections where id=$1`, [COLLECTION_ID])).rows[0];
  }

  async function effectCounts(operationId: string, commandId: string) {
    const row = (await isolated.runtime.pool.query(`select
      (select count(*)::int from resource_revisions where ordinal=(select commit_ordinal from operations where operation_id=$1)
        and resource_id like 'annotation-%') revision,
      (select count(*)::int from content_revisions where ordinal=(select commit_ordinal from operations where operation_id=$1)) content_revision,
      (select count(*)::int from operations where operation_id=$1) operation,
      (select count(*)::int from audit_events where operation_id=$1) audit,
      (select count(*)::int from outbox_events event join operations operation
        on operation.collection_id=event.aggregate_scope and operation.commit_ordinal=event.commit_ordinal
        where operation.operation_id=$1 and event.event_type='annotation.deleted') deleted_outbox,
      (select count(*)::int from outbox_events event join operations operation
        on operation.collection_id=event.aggregate_scope and operation.commit_ordinal=event.commit_ordinal
        where operation.operation_id=$1 and event.event_type=$3) purge_outbox,
      (select count(*)::int from product_command_receipts where command_id=$2 and completed_at is not null) receipt`,
    [operationId, commandId, PUBLICATION_CACHE_PURGE_EVENT_TYPE])).rows[0];
    return { revision: row.revision, contentRevision: row.content_revision, operation: row.operation,
      audit: row.audit, deletedOutbox: row.deleted_outbox, purgeOutbox: row.purge_outbox, receipt: row.receipt };
  }

  async function databaseSnapshot() {
    const tables = [
      ['annotations', 'id'], ['nodes', 'id'], ['resource_id_ledger', 'resource_id'],
      ['resource_revisions', 'collection_id,ordinal,resource_id'], ['content_revisions', 'collection_id,ordinal'],
      ['children_revisions', 'collection_id,ordinal,parent_id'], ['policy_revisions', 'collection_id,ordinal'],
      ['operations', 'operation_id'], ['audit_events', 'operation_id'], ['outbox_events', 'outbox_id'],
      ['product_command_receipts', 'principal_id,command_scope,command_id'],
    ] as const;
    const result: Record<string, unknown> = {};
    for (const [table, order] of tables) {
      result[table] = (await isolated.runtime.pool.query(`select * from ${table} order by ${order}`)).rows;
    }
    result.collection = (await isolated.runtime.pool.query(`select * from collections where id=$1`, [COLLECTION_ID])).rows[0];
    return result;
  }

  async function resetFixture() {
    const client = await isolated.runtime.pool.connect();
    try {
      await client.query('begin');
      await client.query('set constraints all deferred');
      await truncateGuardedTablesInTransaction(client, `truncate table product_command_receipts,outbox_events,audit_events,operations,
        policy_revisions,content_revisions,children_revisions,resource_revisions,annotations,
        collection_policies,collection_members,nodes,collections,resource_id_ledger cascade`);
      await client.query(`insert into accounts(id,subject_id,status) values($1,'subject-owner','active')
        on conflict (id) do nothing`, [OWNER_PROFILE_ID]);
      await client.query(`insert into profiles(account_id,display_name) values($1,'Annotation owner')
        on conflict (account_id) do nothing`, [OWNER_PROFILE_ID]);
      await client.query(`insert into resource_id_ledger(resource_id,resource_type) values
        ($1,'collection'),($2,'node'),($3,'node'),($4,'node')`, [COLLECTION_ID, ROOT_ID, FOLDER_ID, NODE_ID]);
      await client.query(`insert into collections(id,owner_subject_id,title,kind,visibility,
        publication_slug,published_at,root_node_id,resource_revision,content_revision,
        policy_revision,commit_ordinal) values
        ($1,'subject-owner','Annotation deletion','bookmarks','public','annotation-deletion',
        current_timestamp,$2,'cr1','cc1','cp1',1)`, [COLLECTION_ID, ROOT_ID]);
      await client.query(`insert into nodes(id,collection_id,parent_id,kind,is_root,title,url,
        description,tags,visibility,position_token,resource_revision,children_revision) values
        ($1,$4,null,'folder',true,'Root',null,null,'[]','inherit',null,'rr1','rch1'),
        ($2,$4,$1,'folder',false,'Folder',null,null,'[]','inherit','U','fr1','fch1'),
        ($3,$4,$2,'bookmark',false,'Subject','https://example.test',null,'[]','inherit','U','nr1','nch1')`,
      [ROOT_ID, FOLDER_ID, NODE_ID, COLLECTION_ID]);
      await client.query(`insert into collection_members(collection_id,subject_id,role) values
        ($1,'subject-owner','owner'),($1,'subject-editor','editor'),
        ($1,'subject-creator','editor'),($1,'subject-viewer','viewer')`, [COLLECTION_ID]);

      const collectionRow = (await client.query(`select * from collections where id=$1`, [COLLECTION_ID])).rows[0];
      const collectionPayload = materializeCollectionPayload({ id: collectionRow.id,
        ownerSubjectId: collectionRow.owner_subject_id, title: collectionRow.title,
        summary: collectionRow.summary, kind: collectionRow.kind, visibility: collectionRow.visibility,
        rootNodeId: collectionRow.root_node_id, resourceRevision: collectionRow.resource_revision,
        contentRevision: collectionRow.content_revision, policyRevision: collectionRow.policy_revision,
        commitOrdinal: collectionRow.commit_ordinal, createdAt: collectionRow.created_at,
        updatedAt: collectionRow.updated_at, deletedAt: collectionRow.deleted_at });
      assert.equal(collectionPayload.ok, true);
      if (!collectionPayload.ok) throw new Error(collectionPayload.reason);
      await client.query(`update collections set payload_json=$2,payload_schema_version=1,
        payload_authority_status='backfilled' where id=$1`, [COLLECTION_ID, collectionPayload.payload]);
      for (const id of [ROOT_ID, FOLDER_ID, NODE_ID]) {
        const row = (await client.query(`select * from nodes where id=$1`, [id])).rows[0];
        const payload = materializeNodePayload({ id: row.id, collectionId: row.collection_id,
          parentId: row.parent_id, kind: row.kind, isRoot: row.is_root, title: row.title,
          url: row.url, description: row.description, tags: row.tags, visibility: row.visibility,
          positionToken: row.position_token, resourceRevision: row.resource_revision,
          childrenRevision: row.children_revision, createdAt: row.created_at, updatedAt: row.updated_at,
          deletedAt: row.deleted_at, deletedCommitOrdinal: row.deleted_commit_ordinal });
        assert.equal(payload.ok, true);
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
