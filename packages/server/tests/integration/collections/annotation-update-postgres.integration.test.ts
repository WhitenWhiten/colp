import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, test } from 'vitest';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import { createPostgresAnnotationMutationUnitOfWork, type AnnotationMutationFaultContext } from '../../../src/infrastructure/collections/index.js';
import {
  AnnotationUpdateError,
  createAnnotation,
  materializeCollectionPayload,
  materializeNodePayload,
  updateAnnotation,
  toProductAnnotationView,
  type CreateAnnotationInput,
  type UpdateAnnotationInput,
} from '../../../src/modules/collections/index.js';
import { PUBLICATION_CACHE_PURGE_EVENT_TYPE } from '../../../src/infrastructure/outbox/index.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
  truncateGuardedTablesInTransaction,
} from '../../support/postgres-test-runtime.js';

const COLLECTION_ID = Buffer.alloc(16, 3).toString('base64url');
const ROOT_ID = 'annotation-update-pg-root';
const NODE_ID = 'annotation-update-pg-node';

describeWithPostgres('P2B-05 PostgreSQL Annotation canonical update', () => {
  let isolated: IsolatedPostgresRuntime;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('phase2b_annotation_update', { maxConnections: 12 });
    await runMigrations(isolated.runtime.db, 'latest');
  }, 120_000);
  afterAll(async () => isolated?.close());
  beforeEach(async () => resetFixture());

  function createInput(options: {
    annotationId?: string;
    operationId?: string;
    visibility?: 'public' | 'unlisted' | 'protected' | 'private';
    principalId?: string;
    subjectId?: string;
  } = {}): CreateAnnotationInput {
    const principalId = options.principalId ?? 'principal-creator';
    return {
      actor: { principalId, subjectId: options.subjectId ?? 'subject-creator', principalType: 'account',
        creator: { id: `https://known.test/profiles/${principalId}`, name: principalId } },
      command: { commandId: randomUUID(), fingerprint: randomUUID() },
      collectionId: COLLECTION_ID,
      annotation: { subject: { type: 'node', id: NODE_ID }, type: 'note', format: 'plain',
        value: 'Original PostgreSQL annotation', visibility: options.visibility ?? 'protected', extensions: {} },
      annotationId: options.annotationId ?? `annotation-${randomUUID()}`,
      operationId: options.operationId ?? `operation-create-${randomUUID()}`,
    };
  }

  function updateInput(annotationId: string, revision: string, options: {
    principalId?: string;
    subjectId?: string;
    commandId?: string;
    fingerprint?: string;
    operationId?: string;
    patch?: UpdateAnnotationInput['patch'];
  } = {}): UpdateAnnotationInput {
    return {
      actor: { principalId: options.principalId ?? 'principal-creator',
        subjectId: options.subjectId ?? 'subject-creator', principalType: 'account' },
      command: { commandId: options.commandId ?? randomUUID(), fingerprint: options.fingerprint ?? randomUUID() },
      collectionId: COLLECTION_ID,
      annotationId,
      precondition: { kind: 'single-strong-if-match', entityTag: `"${revision}"`, expectedRevision: revision },
      patch: options.patch ?? { value: 'Updated PostgreSQL annotation' },
      operationId: options.operationId ?? `operation-update-${randomUUID()}`,
    };
  }

  function uow(fault?: (context: AnnotationMutationFaultContext) => void | Promise<void>) {
    return createPostgresAnnotationMutationUnitOfWork(isolated.runtime.db, {
      ...(fault ? { faultInjector: { afterPhase: fault } } : {}),
    });
  }

  async function seed(options: Parameters<typeof createInput>[0] = {}) {
    const input = createInput(options);
    const result = await uow().execute((ports) => createAnnotation(ports, input));
    assert.equal(result.kind, 'created');
    if (result.kind !== 'created') throw new Error('seed Annotation was not created');
    return { input, annotation: result.annotation };
  }

  async function execute(input: UpdateAnnotationInput,
    fault?: (context: AnnotationMutationFaultContext) => void | Promise<void>) {
    return uow(fault).execute((ports) => updateAnnotation(ports, input));
  }

  test('atomically dual-writes the complete resource and advances only resource/content authority', async () => {
    const seeded = await seed({ annotationId: 'annotation-update-atomic' });
    const command = updateInput(seeded.annotation.id, seeded.annotation.revision, {
      operationId: 'operation-update-atomic', patch: {
        format: 'markdown', value: '**Updated**', visibility: 'unlisted',
        extensions: { 'https://known.test/source': 'editor' },
      },
    });
    const before = await collectionFence();
    const result = await execute(command);
    assert.equal(result.kind, 'updated');
    if (result.kind !== 'updated') return;

    const row = (await isolated.runtime.pool.query(`select * from annotations where id=$1`,
      [seeded.annotation.id])).rows[0];
    assert.equal(row.format, 'markdown');
    assert.equal(row.value_json, '**Updated**');
    assert.equal(row.visibility, 'unlisted');
    assert.equal(row.resource_revision, result.annotation.revision);
    assert.equal(row.payload_json.revision, row.resource_revision);
    assert.equal(row.payload_json.format, row.format);
    assert.equal(row.payload_json.value, row.value_json);
    assert.equal(row.payload_json.visibility, row.visibility);
    assert.deepEqual(row.payload_json.subject, seeded.annotation.subject);
    assert.deepEqual(row.payload_json.creator, seeded.annotation.creator);
    assert.equal(row.payload_json.createdAt, seeded.annotation.createdAt);
    assert.deepEqual(row.payload_json.extensions, { 'https://known.test/source': 'editor' });

    const after = await collectionFence();
    assert.notEqual(after.content_revision, before.content_revision);
    assert.equal(after.policy_revision, before.policy_revision);
    assert.equal(after.resource_revision, before.resource_revision);
    assert.equal(BigInt(after.commit_ordinal), BigInt(before.commit_ordinal) + 1n);

    const counts = await operationCounts(command.operationId!, command.command.commandId);
    assert.deepEqual(counts, { resourceRevision: 1, contentRevision: 1, operation: 1,
      audit: 1, annotationOutbox: 1, purgeOutbox: 1, receipt: 1 });
    const event = (await isolated.runtime.pool.query(`select event.event_type,event.event_version,event.payload_json
      from outbox_events event join operations operation
        on operation.collection_id=event.aggregate_scope and operation.commit_ordinal=event.commit_ordinal
      where operation.operation_id=$1 and event.event_type='annotation.updated'`,
    [command.operationId])).rows[0];
    assert.equal(event.event_version, 1);
    assert.deepEqual(Object.keys(event.payload_json).sort(), [
      'annotationId', 'collectionId', 'contentRevision', 'previousVisibility',
      'publicRepresentationChanged', 'resourceRevision', 'subjectId', 'subjectType', 'visibility',
    ]);
    assert.equal(event.payload_json.publicRepresentationChanged, true);
  });

  test('conceals private content from owner/editor/outsider and permits only its creator', async () => {
    const seeded = await seed({ annotationId: 'annotation-update-private', visibility: 'private' });
    const before = await databaseSnapshot();
    for (const actor of [
      { principalId: 'principal-owner', subjectId: 'subject-owner' },
      { principalId: 'principal-editor', subjectId: 'subject-editor' },
      { principalId: 'principal-outsider', subjectId: 'subject-outsider' },
    ]) {
      await assert.rejects(() => execute(updateInput(seeded.annotation.id, seeded.annotation.revision, actor)),
        (error: unknown) => error instanceof AnnotationUpdateError && error.code === 'annotation_not_found');
    }
    assert.deepEqual(await databaseSnapshot(), before);
    assert.equal((await execute(updateInput(seeded.annotation.id, seeded.annotation.revision))).kind, 'updated');
  });

  test('stale preconditions and invalid complete candidates leave every authority table unchanged', async () => {
    const seeded = await seed({ annotationId: 'annotation-update-stale' });
    for (const command of [
      updateInput(seeded.annotation.id, 'stale-revision'),
      updateInput(seeded.annotation.id, seeded.annotation.revision, {
        patch: { format: 'json', value: 'schema-valid-fragment-but-invalid-complete-value' },
      }),
      updateInput(seeded.annotation.id, seeded.annotation.revision, { patch: { value: null } }),
    ]) {
      const before = await databaseSnapshot();
      await assert.rejects(() => execute(command), AnnotationUpdateError);
      assert.deepEqual(await databaseSnapshot(), before);
    }
  });

  test('preserves stored AI identity and monotonically marks a human content edit', async () => {
    const seeded = await seed({ annotationId: 'annotation-update-ai' });
    const provenance = { kind: 'ai', provider: 'known-ai', model: 'model-1',
      generatedAt: '2026-07-24T12:00:00.000Z', sourceNodeIds: [NODE_ID] };
    await isolated.runtime.pool.query(`update annotations
      set payload_json = payload_json || jsonb_build_object('provenance', $2::jsonb)
      where id=$1`, [seeded.annotation.id, JSON.stringify(provenance)]);

    const visibility = await execute(updateInput(seeded.annotation.id, seeded.annotation.revision, {
      patch: { visibility: 'private' },
    }));
    assert.equal(visibility.kind, 'updated');
    if (visibility.kind !== 'updated') return;
    assert.deepEqual(visibility.annotation.provenance, provenance);

    const edited = await execute(updateInput(seeded.annotation.id, visibility.annotation.revision, {
      patch: { value: 'Human-revised AI output' },
    }));
    assert.equal(edited.kind, 'updated');
    if (edited.kind === 'updated') assert.deepEqual(edited.annotation.provenance, {
      ...provenance, editedByHuman: true,
    });

    const forged = updateInput(seeded.annotation.id,
      edited.kind === 'updated' ? edited.annotation.revision : visibility.annotation.revision,
      { patch: { provenance: { ...provenance, provider: 'attacker' } } as never });
    const before = await databaseSnapshot();
    await assert.rejects(() => execute(forged), (error: unknown) =>
      error instanceof AnnotationUpdateError && error.code === 'untrusted_ai_provenance');
    assert.deepEqual(await databaseSnapshot(), before);
  });

  test('exact replay returns the first body/headers and fingerprint reuse cannot mutate twice', async () => {
    const seeded = await seed({ annotationId: 'annotation-update-replay' });
    const commandId = randomUUID();
    const command = updateInput(seeded.annotation.id, seeded.annotation.revision, {
      commandId, fingerprint: 'same', operationId: 'operation-update-replay',
    });
    const first = await execute(command);
    const replay = await execute(command);
    assert.equal(first.kind, 'updated');
    assert.equal(replay.kind, 'replay');
    if (first.kind === 'updated' && replay.kind === 'replay') {
      assert.equal(replay.status, 200);
      assert.deepEqual(JSON.parse(Buffer.from(replay.body).toString('utf8')),
        toProductAnnotationView(first.annotation));
      assert.deepEqual(replay.stableHeaders, {
        'cache-control': 'private, no-store',
        'content-type': 'application/json',
        etag: `"${first.annotation.revision}"`,
        location: `/api/v1/collections/${COLLECTION_ID}/annotations/${first.annotation.id}`,
      });
      assert.equal(replay.targetIdentity, seeded.annotation.id);
    }
    const before = await databaseSnapshot();
    const reused = await execute(updateInput(seeded.annotation.id,
      first.kind === 'updated' ? first.annotation.revision : seeded.annotation.revision,
      { commandId, fingerprint: 'different', operationId: 'operation-update-reused' }));
    assert.deepEqual(reused, { kind: 'reused' });
    assert.deepEqual(await databaseSnapshot(), before);
  });

  test('two real PostgreSQL patches with one old revision have one winner and one stable stale loser', async () => {
    const seeded = await seed({ annotationId: 'annotation-update-concurrent' });
    let signalFirstWritten!: () => void;
    let releaseFirst!: () => void;
    const firstWritten = new Promise<void>((resolve) => { signalFirstWritten = resolve; });
    const firstMayCommit = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const firstInput = updateInput(seeded.annotation.id, seeded.annotation.revision, {
      operationId: 'operation-update-winner', patch: { value: 'winner' },
    });
    const secondInput = updateInput(seeded.annotation.id, seeded.annotation.revision, {
      operationId: 'operation-update-loser', patch: { value: 'loser' },
    });
    const first = execute(firstInput, async (context) => {
      if (context.phase === 'resource') {
        signalFirstWritten();
        await firstMayCommit;
      }
    });
    await firstWritten;
    const second = execute(secondInput);
    let blocked = false;
    for (let attempt = 0; attempt < 50 && !blocked; attempt += 1) {
      const state = await isolated.runtime.pool.query<{ blocked: number }>(`select count(*)::int blocked
        from pg_stat_activity where datname=current_database()
          and wait_event_type='Lock' and cardinality(pg_blocking_pids(pid)) > 0`);
      blocked = (state.rows[0]?.blocked ?? 0) > 0;
      if (!blocked) await new Promise<void>((resolve) => setImmediate(resolve));
    }
    assert.equal(blocked, true, 'loser must wait on the authoritative Collection row lock');
    releaseFirst();
    assert.equal((await first).kind, 'updated');
    await assert.rejects(() => second, (error: unknown) =>
      error instanceof AnnotationUpdateError && error.code === 'annotation_precondition_failed');
    const row = (await isolated.runtime.pool.query(`select value_json from annotations where id=$1`,
      [seeded.annotation.id])).rows[0];
    assert.equal(row.value_json, 'winner');
    assert.deepEqual(await operationCounts('operation-update-loser', secondInput.command.commandId), {
      resourceRevision: 0, contentRevision: 0, operation: 0, audit: 0,
      annotationOutbox: 0, purgeOutbox: 0, receipt: 0,
    });
  });

  test.each(['receipt', 'resource', 'revision', 'operation', 'audit', 'outbox'] as const)(
    'rolls back full-table state at the %s write point',
    async (phase) => {
      const seeded = await seed({ annotationId: `annotation-update-fault-${phase}` });
      const command = updateInput(seeded.annotation.id, seeded.annotation.revision, {
        operationId: `operation-update-fault-${phase}`, patch: { value: `fault-${phase}` },
      });
      const before = await databaseSnapshot();
      await assert.rejects(() => execute(command, (context) => {
        if (context.phase === phase) throw new Error(`fault-${phase}`);
      }), new RegExp(`fault-${phase}`));
      assert.deepEqual(await databaseSnapshot(), before);
    },
  );

  test('purges only when an update can change a non-private representation', async () => {
    const privateSeed = await seed({ annotationId: 'annotation-update-private-purge', visibility: 'private' });
    const privateCommand = updateInput(privateSeed.annotation.id, privateSeed.annotation.revision, {
      operationId: 'operation-update-private-purge', patch: { value: 'still private' },
    });
    await execute(privateCommand);
    assert.equal(await purgeCount(privateCommand.operationId!), 0);

    const sharedSeed = await seed({ annotationId: 'annotation-update-shared-purge', visibility: 'public' });
    const sharedCommand = updateInput(sharedSeed.annotation.id, sharedSeed.annotation.revision, {
      operationId: 'operation-update-shared-purge', patch: { value: 'changed public representation' },
    });
    await execute(sharedCommand);
    assert.equal(await purgeCount(sharedCommand.operationId!), 1);

    const transitionSeed = await seed({ annotationId: 'annotation-update-transition-purge', visibility: 'private' });
    const transitionCommand = updateInput(transitionSeed.annotation.id, transitionSeed.annotation.revision, {
      operationId: 'operation-update-transition-purge', patch: { visibility: 'protected' },
    });
    await execute(transitionCommand);
    assert.equal(await purgeCount(transitionCommand.operationId!), 1);
  });

  test('fails closed on relational/payload authority drift before precondition or mutation', async () => {
    const seeded = await seed({ annotationId: 'annotation-update-drift' });
    await isolated.runtime.pool.query(`update annotations set payload_json =
      payload_json || '{"unexpectedAuthorityField":true}'::jsonb where id=$1`, [seeded.annotation.id]);
    const before = await databaseSnapshot();
    await assert.rejects(() => execute(updateInput(seeded.annotation.id, seeded.annotation.revision)),
      /authority/i);
    assert.deepEqual(await databaseSnapshot(), before);
  });

  async function purgeCount(operationId: string): Promise<number> {
    const result = await isolated.runtime.pool.query<{ count: number }>(`select count(*)::int count
      from outbox_events event join operations operation
        on operation.collection_id=event.aggregate_scope and operation.commit_ordinal=event.commit_ordinal
      where operation.operation_id=$1 and event.event_type=$2`,
    [operationId, PUBLICATION_CACHE_PURGE_EVENT_TYPE]);
    return result.rows[0]?.count ?? 0;
  }

  async function operationCounts(operationId: string, commandId: string) {
    const result = await isolated.runtime.pool.query(`select
      (select count(*)::int from resource_revisions where ordinal =
        (select commit_ordinal from operations where operation_id=$1)) resource_revision,
      (select count(*)::int from content_revisions where ordinal =
        (select commit_ordinal from operations where operation_id=$1)) content_revision,
      (select count(*)::int from operations where operation_id=$1) operation,
      (select count(*)::int from audit_events where operation_id=$1) audit,
      (select count(*)::int from outbox_events event join operations operation
        on operation.collection_id=event.aggregate_scope and operation.commit_ordinal=event.commit_ordinal
        where operation.operation_id=$1 and event.event_type='annotation.updated') annotation_outbox,
      (select count(*)::int from outbox_events event join operations operation
        on operation.collection_id=event.aggregate_scope and operation.commit_ordinal=event.commit_ordinal
        where operation.operation_id=$1 and event.event_type=$3) purge_outbox,
      (select count(*)::int from product_command_receipts where command_id=$2 and completed_at is not null) receipt`,
    [operationId, commandId, PUBLICATION_CACHE_PURGE_EVENT_TYPE]);
    const row = result.rows[0];
    return { resourceRevision: row.resource_revision, contentRevision: row.content_revision,
      operation: row.operation, audit: row.audit, annotationOutbox: row.annotation_outbox,
      purgeOutbox: row.purge_outbox, receipt: row.receipt };
  }

  async function collectionFence() {
    return (await isolated.runtime.pool.query(`select resource_revision,content_revision,
      policy_revision,commit_ordinal::text from collections where id=$1`, [COLLECTION_ID])).rows[0];
  }

  async function databaseSnapshot() {
    const tables = [
      ['annotations', 'id'], ['resource_id_ledger', 'resource_id'],
      ['resource_revisions', 'collection_id,ordinal,resource_id'],
      ['content_revisions', 'collection_id,ordinal'], ['policy_revisions', 'collection_id,ordinal'],
      ['children_revisions', 'collection_id,ordinal,parent_id'], ['operations', 'operation_id'],
      ['audit_events', 'operation_id'], ['outbox_events', 'outbox_id'],
      ['product_command_receipts', 'principal_id,command_scope,command_id'],
    ] as const;
    const result: Record<string, unknown> = {};
    for (const [table, order] of tables) {
      result[table] = (await isolated.runtime.pool.query(`select * from ${table} order by ${order}`)).rows;
    }
    result.collection = (await isolated.runtime.pool.query(`select * from collections where id=$1`,
      [COLLECTION_ID])).rows[0];
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
      await client.query(`insert into resource_id_ledger(resource_id,resource_type) values
        ($1,'collection'),($2,'node'),($3,'node')`, [COLLECTION_ID, ROOT_ID, NODE_ID]);
      await client.query(`insert into collections(id,owner_subject_id,title,kind,visibility,
        publication_slug,published_at,root_node_id,resource_revision,content_revision,
        policy_revision,commit_ordinal) values
        ($1,'subject-owner','Annotation updates','bookmarks','public','annotation-updates',
        current_timestamp,$2,'cr1','cc1','cp1',1)`, [COLLECTION_ID, ROOT_ID]);
      await client.query(`insert into nodes(id,collection_id,parent_id,kind,is_root,title,url,
        description,tags,visibility,position_token,resource_revision,children_revision) values
        ($1,$3,null,'folder',true,'Root',null,null,'[]','inherit',null,'rr1','rch1'),
        ($2,$3,$1,'bookmark',false,'Subject','https://example.test',null,'[]','inherit','U','nr1','nch1')`,
      [ROOT_ID, NODE_ID, COLLECTION_ID]);
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

      for (const id of [ROOT_ID, NODE_ID]) {
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
