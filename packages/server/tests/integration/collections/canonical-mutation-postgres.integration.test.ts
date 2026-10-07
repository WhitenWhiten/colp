import assert from 'node:assert/strict';
import { afterAll, beforeAll, test } from 'vitest';
import { runMigrations, type DatabaseRuntime } from '../../../src/infrastructure/database/index.js';
import { createPostgresCanonicalMutationUnitOfWork, type PostgresCanonicalMutationFaultContext } from '../../../src/infrastructure/collections/index.js';
import { NODE_DELETE_AFFECTED_FACT_PAGE_SIZE } from '../../../src/infrastructure/collections/canonical-node-delete-affected-facts.js';
import {
  PUBLICATION_CACHE_PURGE_EVENT_TYPE,
  PUBLICATION_CACHE_PURGE_HANDLER_NAME,
  SOCIAL_COLLECTION_CHANGE_EVENT_TYPE,
  SOCIAL_COLLECTION_CHANGE_HANDLER_MODE,
  SOCIAL_COLLECTION_CHANGE_HANDLER_NAME,
  SOCIAL_PUBLIC_ACTIVITY_HANDLER_MODE,
  SOCIAL_PUBLIC_ACTIVITY_HANDLER_NAME,
  RecordingDurableProjectionSink,
  createCollectionMutationEnvelopeRegistry,
  createProductionCollectionMutationOutboxRouter,
} from '../../../src/infrastructure/outbox/index.js';
import {
  CanonicalMutationInvariantError,
  COLLECTION_UPDATED_EVENT_TYPE,
  COLLECTION_UPDATED_HANDLER_NAME,
  PositionRebalanceEscalationError,
  materializeCollectionPayload,
  materializeNodePayload,
  type CanonicalMutationInput,
} from '../../../src/modules/collections/index.js';
import { InMemoryMetrics } from '../../../src/infrastructure/telemetry/index.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
  truncateGuardedTablesInTransaction,
} from '../../support/postgres-test-runtime.js';
import { waitForCondition } from '../../support/async-test-helpers.js';

const COLLECTION_ID = 'AQEBAQEBAQEBAQEBAQEBAQ';
const ROOT_ID = 'canonical-adapter-root';
const NODE_ID = 'canonical-adapter-node';
const FOLDER_ID = 'canonical-adapter-folder';
const CHILD_FOLDER_ID = 'canonical-adapter-child-folder';
const PRINCIPAL_ID = 'BgYGBgYGBgYGBgYGBgYGBg';

describeWithPostgres('PostgreSQL canonical mutation adapters', () => {
  let isolated: IsolatedPostgresRuntime;
  let runtime: DatabaseRuntime;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('canonical_adapter', {
      maxConnections: 6,
      applicationName: 'known-canonical-adapter-test',
    });
    runtime = isolated.runtime;
    await runMigrations(runtime.db, 'latest');
  });

  afterAll(async () => {
    await isolated?.close();
  });

  async function resetFixture(): Promise<void> {
    const client = await runtime.pool.connect();
    try {
      await client.query('begin');
      await truncateGuardedTablesInTransaction(client, `
        truncate table product_command_receipts, outbox_events, audit_events, operations,
          policy_revisions, content_revisions, children_revisions, resource_revisions,
          collection_policies, collection_members, nodes, collections, resource_id_ledger,
          profiles, accounts cascade
      `);
      await client.query(
        `insert into accounts(id, subject_id, status, security_epoch)
         values ($1, $1, 'active', 0)`,
        [PRINCIPAL_ID],
      );
      await client.query(
        `insert into profiles(account_id, display_name, avatar_url)
         values ($1, 'Canonical adapter owner', null)`,
        [PRINCIPAL_ID],
      );
      await client.query(
        `insert into resource_id_ledger (resource_id, resource_type) values
         ($1, 'collection'), ($2, 'node'), ($3, 'node')`,
        [COLLECTION_ID, ROOT_ID, NODE_ID],
      );
      await client.query(
        `insert into collections (
           id, owner_subject_id, title, summary, kind, visibility, root_node_id,
           resource_revision, content_revision, policy_revision, commit_ordinal
         ) values ($1, $2, 'Canonical', null, 'bookmarks', 'private', $3, 'collection-r1', 'content-r1', 'policy-r1', 1)`,
        [COLLECTION_ID, PRINCIPAL_ID, ROOT_ID],
      );
      await client.query(
        `insert into nodes (
           id, collection_id, parent_id, kind, is_root, title, url, description, tags,
           visibility, position_token, resource_revision, children_revision
         ) values
         ($1, $3, null, 'folder', true, 'Canonical', null, null, '[]'::jsonb,
          'inherit', null, 'root-r1', 'root-children-r1'),
         ($2, $3, $1, 'bookmark', false, 'Before', 'https://example.test/before', null, '[]'::jsonb,
          'inherit', 'U', 'node-r1', 'node-children-r1')`,
        [ROOT_ID, NODE_ID, COLLECTION_ID],
      );
      const fixtureCollection = (await client.query(
        'select * from collections where id = $1',
        [COLLECTION_ID],
      )).rows[0];
      const materializedCollection = materializeCollectionPayload({
        id: fixtureCollection.id,
        ownerSubjectId: fixtureCollection.owner_subject_id,
        title: fixtureCollection.title,
        summary: fixtureCollection.summary,
        kind: fixtureCollection.kind,
        visibility: fixtureCollection.visibility,
        rootNodeId: fixtureCollection.root_node_id,
        resourceRevision: fixtureCollection.resource_revision,
        contentRevision: fixtureCollection.content_revision,
        policyRevision: fixtureCollection.policy_revision,
        commitOrdinal: fixtureCollection.commit_ordinal,
        createdAt: fixtureCollection.created_at,
        updatedAt: fixtureCollection.updated_at,
        deletedAt: fixtureCollection.deleted_at,
      });
      assert.equal(materializedCollection.ok, true);
      if (!materializedCollection.ok) throw new Error(materializedCollection.reason);
      await client.query(
        `update collections
          set payload_json = $2::jsonb, payload_schema_version = 1,
              payload_authority_status = 'backfilled'
          where id = $1`,
        [COLLECTION_ID, JSON.stringify(materializedCollection.payload)],
      );
      const fixtureNodes = await client.query('select * from nodes where id = any($1::text[])', [[ROOT_ID, NODE_ID]]);
      for (const row of fixtureNodes.rows) {
        const materialized = materializeNodePayload({
          id: row.id,
          collectionId: row.collection_id,
          parentId: row.parent_id,
          kind: row.kind,
          isRoot: row.is_root,
          title: row.title,
          url: row.url,
          description: row.description,
          tags: row.tags,
          visibility: row.visibility,
          positionToken: row.position_token,
          resourceRevision: row.resource_revision,
          childrenRevision: row.children_revision,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          deletedAt: row.deleted_at,
          deletedCommitOrdinal: row.deleted_commit_ordinal,
        });
        assert.equal(materialized.ok, true);
        if (!materialized.ok) throw new Error(materialized.reason);
        await client.query(
          `update nodes
            set payload_json = $2::jsonb, payload_schema_version = 1, payload_authority_status = 'backfilled'
            where id = $1`,
          [row.id, JSON.stringify(materialized.payload)],
        );
      }
      await client.query('commit');
    } catch (error: unknown) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }

  async function materializeCurrentNodes(nodeIds: readonly string[]): Promise<void> {
    const fixtureNodes = await runtime.pool.query(
      'select * from nodes where id = any($1::text[])',
      [nodeIds],
    );
    assert.equal(fixtureNodes.rowCount, nodeIds.length);
    const payloads = fixtureNodes.rows.map((row) => {
      const materialized = materializeNodePayload({
        id: row.id,
        collectionId: row.collection_id,
        parentId: row.parent_id,
        kind: row.kind,
        isRoot: row.is_root,
        title: row.title,
        url: row.url,
        description: row.description,
        tags: row.tags,
        visibility: row.visibility,
        positionToken: row.position_token,
        resourceRevision: row.resource_revision,
        childrenRevision: row.children_revision,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        deletedAt: row.deleted_at,
        deletedCommitOrdinal: row.deleted_commit_ordinal,
      });
      assert.equal(materialized.ok, true);
      if (!materialized.ok) throw new Error(materialized.reason);
      return { id: row.id, payload_json: materialized.payload };
    });
    const updated = await runtime.pool.query(
      `update nodes as n
        set payload_json = input.payload_json, payload_schema_version = 1,
            payload_authority_status = 'backfilled'
        from jsonb_to_recordset($1::jsonb) as input(id text, payload_json jsonb)
        where n.id = input.id`,
      [JSON.stringify(payloads)],
    );
    assert.equal(updated.rowCount, nodeIds.length);
  }

  function mutation(operationId: string, expectedResourceRevision = 'node-r1'): CanonicalMutationInput {
    return {
      operationId,
      collectionId: COLLECTION_ID,
      actor: { principalId: PRINCIPAL_ID, principalType: 'account' },
      mutation: {
        action: 'update',
        target: { collectionId: COLLECTION_ID, resourceId: NODE_ID, resourceKind: 'node' },
        parentId: ROOT_ID,
        expectedResourceRevision,
        fields: {
          kindFields: {
            kind: 'bookmark',
            title: 'After',
            url: 'https://example.test/after',
            description: 'canonical write',
            tags: ['adapter'],
            visibility: 'inherit',
          },
          extensions: { 'example.test/source': 'caller-must-not-overwrite' },
        },
      },
    };
  }

  function collectionMutation(
    operationId: string,
    kindFields: Record<string, unknown>,
    expectedResourceRevision?: string,
  ): CanonicalMutationInput {
    return {
      operationId,
      collectionId: COLLECTION_ID,
      actor: { principalId: PRINCIPAL_ID, principalType: 'account' },
      mutation: {
        action: 'update',
        target: { collectionId: COLLECTION_ID, resourceId: COLLECTION_ID, resourceKind: 'collection' },
        parentId: null,
        ...(expectedResourceRevision ? { expectedResourceRevision } : {}),
        fields: { kindFields, extensions: {} },
      },
    };
  }

  function nodeMutation(
    operationId: string,
    action: 'create' | 'move' | 'delete',
    resourceId: string,
    parentId: string | null,
    options: {
      expectedResourceRevision?: string;
      kindFields?: Record<string, unknown>;
      beforeId?: string;
      afterId?: string;
      extensions?: Record<string, unknown>;
      deleteScope?: 'single' | 'subtree';
    } = {},
  ): CanonicalMutationInput {
    return {
      operationId,
      collectionId: COLLECTION_ID,
      actor: { principalId: PRINCIPAL_ID, principalType: 'account' },
      mutation: {
        action,
        target: { collectionId: COLLECTION_ID, resourceId, resourceKind: 'node' },
        parentId,
        ...(options.expectedResourceRevision ? { expectedResourceRevision: options.expectedResourceRevision } : {}),
        ...(options.beforeId || options.afterId ? { relativePosition: {
          ...(options.beforeId ? { beforeId: options.beforeId } : {}),
          ...(options.afterId ? { afterId: options.afterId } : {}),
        } } : {}),
        ...(action === 'delete' && options.kindFields === undefined && options.extensions === undefined ? {} : {
          fields: {
            kindFields: options.kindFields ?? {
              kind: 'folder', title: 'Folder', url: null, description: null, tags: [], visibility: 'inherit',
            },
            extensions: options.extensions ?? {},
          },
        }),
        ...(action === 'delete' ? { deleteIntent: { scope: options.deleteScope ?? 'single' } } : {}),
      },
    };
  }

  async function executeMutation(
    input: CanonicalMutationInput,
    faultInjector?: { afterPhase(context: PostgresCanonicalMutationFaultContext): void | Promise<void> },
    db = runtime.db,
    options: { readonly metrics?: InMemoryMetrics; readonly positionRebalanceWindow?: number } = {},
  ) {
    const binding = {
      principalId: PRINCIPAL_ID,
      commandScope: `canonical:${input.mutation.action}`,
      commandId: input.operationId,
    };
    const fingerprint = `fp-${input.operationId}`;
    return createPostgresCanonicalMutationUnitOfWork(db, {
      ...(faultInjector ? { canonicalFaultInjector: faultInjector } : {}),
      ...options,
    }).execute(async (ports) => {
      assert.deepEqual(await ports.receipts.claim(binding, fingerprint), { kind: 'claimed' });
      const result = await ports.canonical.execute(input);
      await ports.receipts.complete(binding, fingerprint, {
        status: 200,
        body: Buffer.from(JSON.stringify({ operationId: input.operationId })),
        stableHeaders: { 'content-type': 'application/json' },
        mediaType: 'application/json',
        contractVersion: '1.0.0',
        targetIdentity: input.mutation.target.resourceId,
      });
      return result;
    });
  }

  async function insertFolderTree(): Promise<void> {
    await runtime.pool.query(
      `insert into resource_id_ledger (resource_id, resource_type) values ($1, 'node'), ($2, 'node')`,
      [FOLDER_ID, CHILD_FOLDER_ID],
    );
    await runtime.pool.query(
      `insert into nodes (
         id, collection_id, parent_id, kind, is_root, title, url, description, tags,
         visibility, position_token, resource_revision, children_revision
       ) values
       ($1, $3, $4, 'folder', false, 'Folder', null, null, '[]'::jsonb,
        'inherit', 'E', 'folder-r1', 'folder-children-r1'),
       ($2, $3, $1, 'folder', false, 'Child', null, null, '[]'::jsonb,
        'inherit', 'U', 'child-r1', 'child-children-r1')`,
      [FOLDER_ID, CHILD_FOLDER_ID, COLLECTION_ID, ROOT_ID],
    );
    await materializeCurrentNodes([FOLDER_ID, CHILD_FOLDER_ID]);
  }

  async function insertDeleteBatchTree(nodeCount: number): Promise<readonly string[]> {
    assert.ok(nodeCount >= 1);
    const targetId = 'canonical-adapter-batch-target';
    const childCount = nodeCount - 1;
    await runtime.pool.query(
      `insert into resource_id_ledger(resource_id, resource_type)
       values ($1, 'node')`,
      [targetId],
    );
    await runtime.pool.query(
      `insert into nodes(
         id, collection_id, parent_id, kind, is_root, title, url, description, tags,
         visibility, position_token, resource_revision, children_revision
       ) values (
         $1, $2, $3, 'folder', false, 'Batch target', null, null, '[]'::jsonb,
         'inherit', 'batch-target', 'batch-target-r1', 'batch-target-children-r1'
       )`,
      [targetId, COLLECTION_ID, ROOT_ID],
    );
    if (childCount > 0) {
      await runtime.pool.query(
        `insert into resource_id_ledger(resource_id, resource_type)
         select 'canonical-adapter-batch-child-' || series::text, 'node'
         from generate_series(1, $1::integer) series`,
        [childCount],
      );
      await runtime.pool.query(
        `insert into nodes(
           id, collection_id, parent_id, kind, is_root, title, url, description, tags,
           visibility, position_token, resource_revision, children_revision
         )
         select 'canonical-adapter-batch-child-' || series::text, $2, $3,
           'bookmark', false, 'Batch child ' || series::text,
           'https://example.test/batch/' || series::text, null, '[]'::jsonb,
           'inherit', lpad(series::text, 8, '0'),
           'batch-child-r1-' || series::text, 'batch-child-children-r1-' || series::text
         from generate_series(1, $1::integer) series`,
        [childCount, COLLECTION_ID, targetId],
      );
    }
    const ids = [
      targetId,
      ...Array.from({ length: childCount }, (_, index) => `canonical-adapter-batch-child-${index + 1}`),
    ];
    await materializeCurrentNodes(ids);
    return ids;
  }

  async function insertRootSiblings(): Promise<{ firstId: string; lastId: string }> {
    const firstId = 'canonical-adapter-first';
    const lastId = 'canonical-adapter-last';
    await runtime.pool.query(
      `insert into resource_id_ledger (resource_id, resource_type) values ($1, 'node'), ($2, 'node')`,
      [firstId, lastId],
    );
    await runtime.pool.query(
      `insert into nodes (
         id, collection_id, parent_id, kind, is_root, title, url, description, tags,
         visibility, position_token, resource_revision, children_revision
       ) values
       ($1, $3, $4, 'folder', false, 'First', null, null, '[]'::jsonb,
        'inherit', 'E', 'first-r1', 'first-children-r1'),
       ($2, $3, $4, 'folder', false, 'Last', null, null, '[]'::jsonb,
        'inherit', 'k', 'last-r1', 'last-children-r1')`,
      [firstId, lastId, COLLECTION_ID, ROOT_ID],
    );
    await materializeCurrentNodes([firstId, lastId]);
    return { firstId, lastId };
  }

  async function executeCommand(operationId: string, fingerprint = `fp-${operationId}`) {
    const binding = { principalId: PRINCIPAL_ID, commandScope: 'node:update', commandId: operationId };
    return createPostgresCanonicalMutationUnitOfWork(runtime.db).execute(async (ports) => {
      const claim = await ports.receipts.claim(binding, fingerprint);
      assert.deepEqual(claim, { kind: 'claimed' });
      const result = await ports.canonical.execute(mutation(operationId));
      const body = Buffer.from(JSON.stringify({ operationId, revision: result.allocation.resourceRevision }));
      await ports.receipts.complete(binding, fingerprint, {
        status: 200,
        body,
        stableHeaders: { 'content-type': 'application/json', etag: `"${result.allocation.resourceRevision}"` },
        mediaType: 'application/json',
        contractVersion: '1.0.0',
        targetIdentity: NODE_ID,
      });
      return result;
    });
  }

  async function assertRoutableOutbox(operationIds: readonly string[]): Promise<void> {
    const rows = await runtime.pool.query(
      `select e.domain_event_id, e.event_type, e.event_version, e.handler_name, e.handler_mode,
              e.aggregate_type, e.aggregate_id, e.aggregate_scope, e.aggregate_revision,
              e.commit_ordinal::text, e.occurred_at, e.payload_json
       from outbox_events e
       join operations o on o.collection_id = e.aggregate_scope
         and o.commit_ordinal = e.commit_ordinal
       where o.operation_id = any($1::text[])
         and e.handler_mode = 'projection_latest_only' and e.handler_name <> $2
       order by e.commit_ordinal`,
      [operationIds, SOCIAL_COLLECTION_CHANGE_HANDLER_NAME],
    );
    assert.equal(rows.rowCount, operationIds.length);
    const registry = createCollectionMutationEnvelopeRegistry();
    const sink = new RecordingDurableProjectionSink();
    const router = createProductionCollectionMutationOutboxRouter({ sink });
    for (const row of rows.rows) {
      const envelope = registry.validate({
        event_id: row.domain_event_id,
        event_type: row.event_type,
        event_version: row.event_version,
        aggregate_identity: {
          aggregate_type: row.aggregate_type,
          aggregate_id: row.aggregate_id,
          aggregate_scope: row.aggregate_scope,
        },
        aggregate_revision: row.aggregate_revision,
        commit_ordinal: row.commit_ordinal,
        occurred_at: row.occurred_at.toISOString(),
        payload: row.payload_json,
      });
      const route = router.resolve({
        handlerName: row.handler_name,
        handlerMode: row.handler_mode,
        eventType: row.event_type,
        eventVersion: row.event_version,
      });
      assert.equal(route.eventType, envelope.event_type);
      await route.handle({
        envelope,
        idempotencyKey: envelope.event_id,
        signal: new AbortController().signal,
      });
    }
    assert.deepEqual(
      sink.deliveries.map((delivery) => delivery.eventId),
      rows.rows.map((row) => row.domain_event_id),
    );
  }

  test('commits resource, revision evidence, operation, audit, outbox and receipt atomically', async () => {
    await resetFixture();
    const existing = (await runtime.pool.query('select * from nodes where id = $1', [NODE_ID])).rows[0];
    const materialized = materializeNodePayload({
      id: existing.id,
      collectionId: existing.collection_id,
      parentId: existing.parent_id,
      kind: existing.kind,
      isRoot: existing.is_root,
      title: existing.title,
      url: existing.url,
      description: existing.description,
      tags: existing.tags,
      visibility: existing.visibility,
      positionToken: existing.position_token,
      resourceRevision: existing.resource_revision,
      childrenRevision: existing.children_revision,
      createdAt: existing.created_at,
      updatedAt: existing.updated_at,
      deletedAt: existing.deleted_at,
      deletedCommitOrdinal: existing.deleted_commit_ordinal,
    });
    assert.equal(materialized.ok, true);
    if (!materialized.ok) throw new Error(materialized.reason);
    await runtime.pool.query(
      `update nodes
        set payload_json = $2::jsonb, payload_schema_version = 1, payload_authority_status = 'backfilled'
        where id = $1`,
      [NODE_ID, JSON.stringify({
        ...materialized.payload,
        extensions: { 'example.test/source': 'postgres-contract' },
      })],
    );
    const operationId = '11111111-1111-4111-8111-111111111111';
    const result = await executeCommand(operationId);

    const state = await runtime.pool.query(
      `select n.title, n.resource_revision, n.payload_json, c.content_revision, c.commit_ordinal,
        (select count(*)::int from resource_revisions where resource_id = $1) as resource_revisions,
        (select count(*)::int from operations where operation_id = $2) as operations,
        (select actor_principal_id from operations where operation_id = $2) as operation_actor,
        (select principal_id from audit_events where operation_id = $2) as audit_actor,
        (select count(*)::int from audit_events where operation_id = $2) as audit,
        (select count(*)::int from outbox_events e join operations o
          on o.collection_id=e.aggregate_scope and o.commit_ordinal=e.commit_ordinal
          where o.operation_id = $2) as outbox,
        (select count(*)::int from product_command_receipts where command_id = $2 and completed_at is not null) as receipt
       from nodes n join collections c on c.id = n.collection_id where n.id = $1`,
      [NODE_ID, operationId],
    );
    const row = state.rows[0];
    assert.equal(row.title, 'After');
    assert.equal(row.resource_revision, result.allocation.resourceRevision);
    assert.equal(row.payload_json.title, 'After');
    assert.deepEqual(row.payload_json.extensions, { 'example.test/source': 'postgres-contract' });
    assert.equal(row.content_revision, result.allocation.contentRevision);
    assert.equal(row.commit_ordinal, '2');
    assert.deepEqual(
      [row.resource_revisions, row.operations, row.audit, row.outbox, row.receipt],
      [1, 1, 1, 3, 1],
    );
    assert.equal(row.operation_actor, PRINCIPAL_ID);
    assert.equal(row.audit_actor, PRINCIPAL_ID);
  });

  test('returns the completed durable receipt on duplicate command without a second mutation', async () => {
    await resetFixture();
    const operationId = '22222222-2222-4222-8222-222222222222';
    await executeCommand(operationId);

    const claim = await createPostgresCanonicalMutationUnitOfWork(runtime.db).execute(
      (ports) => ports.receipts.claim(
        { principalId: PRINCIPAL_ID, commandScope: 'node:update', commandId: operationId },
        `fp-${operationId}`,
      ),
    );
    assert.equal(claim.kind, 'replay');
    if (claim.kind !== 'replay') return;
    assert.equal(claim.result.status, 200);
    assert.equal(claim.result.contractVersion, '1.0.0');
    const counts = await runtime.pool.query(
      `select (select count(*)::int from operations) operations,
              (select count(*)::int from outbox_events) outbox`,
    );
    assert.deepEqual(counts.rows[0], { operations: 1, outbox: 3 });
  });

  test('binds a distinct Product command to one canonical operation and its resource target', async () => {
    await resetFixture();
    const commandId = '31313131-3131-4131-8131-313131313131';
    const operationId = '32323232-3232-4232-8232-323232323232';
    await createPostgresCanonicalMutationUnitOfWork(runtime.db).execute(async (ports) => {
      assert.equal('transaction' in ports, false);
      const binding = { principalId: PRINCIPAL_ID, commandScope: 'node:update', commandId };
      assert.equal((await ports.receipts.claim(binding, 'distinct-command-operation')).kind, 'claimed');
      const result = await ports.canonical.execute(mutation(operationId));
      await ports.receipts.complete(binding, 'distinct-command-operation', {
        status: 200, body: Buffer.from('{}'), stableHeaders: { 'content-type': 'application/json' },
        mediaType: 'application/json', contractVersion: '1.0.0', targetIdentity: result.resourceId,
      });
    });
    const evidence = await runtime.pool.query(
      `select r.command_id, r.target_identity, o.operation_id
       from product_command_receipts r cross join operations o`,
    );
    assert.deepEqual(evidence.rows[0], { command_id: commandId, target_identity: NODE_ID, operation_id: operationId });
  });

  test('unit of work fails closed for incomplete, unowned, duplicate and replay-consumed commands', async () => {
    const productResult = {
      status: 200, body: Buffer.from('{}'), stableHeaders: { 'content-type': 'application/json' },
      mediaType: 'application/json', contractVersion: '1.0.0', targetIdentity: NODE_ID,
    } as const;
    const assertEmpty = async () => {
      const state = await runtime.pool.query(
        `select (select count(*)::int from product_command_receipts) receipts,
                (select count(*)::int from operations) operations,
                (select count(*)::int from outbox_events) outbox,
                (select commit_ordinal::text from collections where id = $1) ordinal`,
        [COLLECTION_ID],
      );
      assert.deepEqual(state.rows[0], { receipts: 0, operations: 0, outbox: 0, ordinal: '1' });
    };

    await resetFixture();
    await assert.rejects(
      createPostgresCanonicalMutationUnitOfWork(runtime.db).execute(async () => undefined),
      /must claim one product command/,
    );
    await assertEmpty();

    await resetFixture();
    const mismatchedActorId = '29292929-2929-4929-8929-292929292929';
    await assert.rejects(createPostgresCanonicalMutationUnitOfWork(runtime.db).execute(async (ports) => {
      const binding = { principalId: 'different-principal', commandScope: 'node:update', commandId: mismatchedActorId };
      assert.equal((await ports.receipts.claim(binding, 'fp-actor-mismatch')).kind, 'claimed');
      await ports.canonical.execute(mutation(mismatchedActorId));
    }), /actor does not own the claimed product command/);
    await assertEmpty();

    await resetFixture();
    const mismatchedTargetId = '30303030-3030-4030-8030-303030303030';
    await assert.rejects(createPostgresCanonicalMutationUnitOfWork(runtime.db).execute(async (ports) => {
      const binding = { principalId: PRINCIPAL_ID, commandScope: 'node:update', commandId: mismatchedTargetId };
      assert.equal((await ports.receipts.claim(binding, 'fp-target-mismatch')).kind, 'claimed');
      await ports.canonical.execute(mutation(mismatchedTargetId));
      await ports.receipts.complete(binding, 'fp-target-mismatch', {
        ...productResult, targetIdentity: COLLECTION_ID,
      });
    }), /receipt target does not match/);
    await assertEmpty();

    await resetFixture();
    const noCanonicalId = '21212121-2121-4121-8121-212121212121';
    await assert.rejects(createPostgresCanonicalMutationUnitOfWork(runtime.db).execute(async (ports) => {
      const binding = { principalId: PRINCIPAL_ID, commandScope: 'node:update', commandId: noCanonicalId };
      assert.equal((await ports.receipts.claim(binding, 'fp-no-canonical')).kind, 'claimed');
      await ports.receipts.complete(binding, 'fp-no-canonical', productResult);
    }), /cannot complete before canonical outbox success/);
    await assertEmpty();

    await resetFixture();
    const incompleteId = '23232323-2323-4323-8323-232323232323';
    await assert.rejects(createPostgresCanonicalMutationUnitOfWork(runtime.db).execute(async (ports) => {
      const binding = { principalId: PRINCIPAL_ID, commandScope: 'node:update', commandId: incompleteId };
      assert.equal((await ports.receipts.claim(binding, 'fp-incomplete')).kind, 'claimed');
      await ports.canonical.execute(mutation(incompleteId));
    }), /left a claimed product command incomplete/);
    await assertEmpty();

    await resetFixture();
    const duplicateId = '24242424-2424-4424-8424-242424242424';
    await assert.rejects(createPostgresCanonicalMutationUnitOfWork(runtime.db).execute(async (ports) => {
      const binding = { principalId: PRINCIPAL_ID, commandScope: 'node:update', commandId: duplicateId };
      assert.equal((await ports.receipts.claim(binding, 'fp-duplicate')).kind, 'claimed');
      await ports.canonical.execute(mutation(duplicateId));
      await ports.receipts.complete(binding, 'fp-duplicate', productResult);
      await ports.receipts.complete(binding, 'fp-duplicate', productResult);
    }), /cannot be completed twice/);
    await assertEmpty();

    await resetFixture();
    const multipleId = '25252525-2525-4525-8525-252525252525';
    await assert.rejects(createPostgresCanonicalMutationUnitOfWork(runtime.db).execute(async (ports) => {
      const binding = { principalId: PRINCIPAL_ID, commandScope: 'node:update', commandId: multipleId };
      assert.equal((await ports.receipts.claim(binding, 'fp-multiple')).kind, 'claimed');
      await ports.receipts.claim({ ...binding, commandId: '26262626-2626-4626-8626-262626262626' }, 'fp-second');
    }), /may claim exactly one product command/);
    await assertEmpty();

    await resetFixture();
    const replayId = '27272727-2727-4727-8727-272727272727';
    await executeCommand(replayId);
    await assert.rejects(createPostgresCanonicalMutationUnitOfWork(runtime.db).execute(async (ports) => {
      const binding = { principalId: PRINCIPAL_ID, commandScope: 'node:update', commandId: replayId };
      assert.equal((await ports.receipts.claim(binding, `fp-${replayId}`)).kind, 'replay');
      await ports.canonical.execute(
        collectionMutation('28282828-2828-4828-8828-282828282828', { title: 'Must not write' }),
      );
    }), /requires an owned product command claim/);
    const replayState = await runtime.pool.query(
      `select title, commit_ordinal::text ordinal,
              (select count(*)::int from product_command_receipts) receipts,
              (select count(*)::int from operations) operations,
              (select count(*)::int from outbox_events) outbox
       from collections where id = $1`,
      [COLLECTION_ID],
    );
    assert.deepEqual(replayState.rows[0], {
      title: 'Canonical', ordinal: '2', receipts: 1, operations: 1, outbox: 3,
    });
    // Eight command cycles already take about 32s on an idle host.
  }, 90_000);

  test('revision conflict rolls back the command claim and every mutation artifact', async () => {
    await resetFixture();
    const operationId = '33333333-3333-4333-8333-333333333333';
    await assert.rejects(
      createPostgresCanonicalMutationUnitOfWork(runtime.db).execute(async (ports) => {
        const binding = { principalId: PRINCIPAL_ID, commandScope: 'node:update', commandId: operationId };
        assert.equal((await ports.receipts.claim(binding, 'conflict-fp')).kind, 'claimed');
        return ports.canonical.execute(mutation(operationId, 'stale-revision'));
      }),
      (error: unknown) => error instanceof CanonicalMutationInvariantError
        && error.message === 'resource revision conflict',
    );
    const state = await runtime.pool.query(
      `select n.title, n.resource_revision,
        (select count(*)::int from operations) operations,
        (select count(*)::int from outbox_events) outbox,
        (select count(*)::int from product_command_receipts) receipts
       from nodes n where n.id = $1`,
      [NODE_ID],
    );
    assert.deepEqual(state.rows[0], {
      title: 'Before', resource_revision: 'node-r1', operations: 0, outbox: 0, receipts: 0,
    });
  });

  test('persists a production-routable closed node.updated event at version one', async () => {
    await resetFixture();
    const operationId = '44444444-4444-4444-8444-444444444444';
    await executeCommand(operationId);
    const event = await runtime.pool.query(
      `select event_type, event_version, handler_name, aggregate_scope, aggregate_id,
              aggregate_revision, commit_ordinal, payload_json
       from outbox_events where handler_name = 'node_updated_projection'`,
    );
    assert.deepEqual(event.rows[0], {
      event_type: 'node.updated',
      event_version: 1,
      handler_name: 'node_updated_projection',
      aggregate_scope: COLLECTION_ID,
      aggregate_id: NODE_ID,
      aggregate_revision: event.rows[0].aggregate_revision,
      commit_ordinal: '2',
      payload_json: {
        collectionId: COLLECTION_ID,
        contentRevision: event.rows[0].payload_json.contentRevision,
        kind: 'bookmark',
        nodeId: NODE_ID,
        policyRevision: 'policy-r1',
        resourceRevision: event.rows[0].aggregate_revision,
      },
    });
    assert.match(event.rows[0].aggregate_revision, /^[A-Za-z0-9_-]{22}$/);
    await assertRoutableOutbox([operationId]);
  });

  test('fault before commit rolls back resource, receipt, revision and outbox together', async () => {
    await resetFixture();
    const operationId = '55555555-5555-4555-8555-555555555555';
    const fault = new Error('injected before commit');
    const uow = createPostgresCanonicalMutationUnitOfWork(runtime.db, {
      faultInjector: { afterCallbackBeforeCommit: () => { throw fault; } },
    });
    await assert.rejects(
      uow.execute(async (ports) => {
        const binding = { principalId: PRINCIPAL_ID, commandScope: 'node:update', commandId: operationId };
        assert.equal((await ports.receipts.claim(binding, 'fault-fp')).kind, 'claimed');
        const result = await ports.canonical.execute(mutation(operationId));
        await ports.receipts.complete(binding, 'fault-fp', {
          status: 200, body: Buffer.from('{}'), stableHeaders: { 'content-type': 'application/json' },
          mediaType: 'application/json', contractVersion: '1.0.0', targetIdentity: NODE_ID,
        });
        return result;
      }),
      fault,
    );
    const state = await runtime.pool.query(
      `select n.title, n.resource_revision,
        (select count(*)::int from resource_revisions) revisions,
        (select count(*)::int from operations) operations,
        (select count(*)::int from audit_events) audit,
        (select count(*)::int from outbox_events) outbox,
        (select count(*)::int from product_command_receipts) receipts
       from nodes n where n.id = $1`,
      [NODE_ID],
    );
    assert.deepEqual(state.rows[0], {
      title: 'Before', resource_revision: 'node-r1', revisions: 0,
      operations: 0, audit: 0, outbox: 0, receipts: 0,
    });
  });

  test('collection visibility advances policy revision and canonical evidence atomically', async () => {
    await resetFixture();
    const operationId = '66666666-6666-4666-8666-666666666666';
    const result = await executeMutation(collectionMutation(
      operationId,
      { title: 'Visible Canonical', visibility: 'public', publicationSlug: 'visible-canonical' },
      'collection-r1',
    ));
    const state = await runtime.pool.query(
      `select title, visibility, resource_revision, content_revision, policy_revision,
              payload_json, commit_ordinal,
              (select count(*)::int from policy_revisions where collection_id = $1) policy_evidence,
              (select count(*)::int from outbox_events e join operations o
                on o.collection_id=e.aggregate_scope and o.commit_ordinal=e.commit_ordinal
                where o.operation_id = $2) outbox
       from collections where id = $1`,
      [COLLECTION_ID, operationId],
    );
    const row = state.rows[0];
    assert.equal(row.visibility, 'public');
    assert.equal(row.payload_json.visibility, 'public');
    assert.equal(row.payload_json.title, 'Visible Canonical');
    assert.equal(row.resource_revision, result.allocation.resourceRevision);
    assert.equal(row.content_revision, result.allocation.contentRevision);
    assert.equal(row.policy_revision, result.allocation.policyRevision);
    assert.notEqual(row.policy_revision, 'policy-r1');
    assert.equal(row.commit_ordinal, '2');
    assert.deepEqual([row.policy_evidence, row.outbox], [1, 4]);
    const routes = await runtime.pool.query(
      `select event_type, handler_name, handler_mode
       from outbox_events e join operations o
         on o.collection_id=e.aggregate_scope and o.commit_ordinal=e.commit_ordinal
       where o.operation_id = $1 order by e.handler_name`,
      [operationId],
    );
    assert.deepEqual(routes.rows, [
      {
        event_type: COLLECTION_UPDATED_EVENT_TYPE,
        handler_name: COLLECTION_UPDATED_HANDLER_NAME,
        handler_mode: 'projection_latest_only',
      },
      {
        event_type: PUBLICATION_CACHE_PURGE_EVENT_TYPE,
        handler_name: PUBLICATION_CACHE_PURGE_HANDLER_NAME,
        handler_mode: 'delivery_each_event',
      },
      {
        event_type: SOCIAL_COLLECTION_CHANGE_EVENT_TYPE,
        handler_name: SOCIAL_COLLECTION_CHANGE_HANDLER_NAME,
        handler_mode: SOCIAL_COLLECTION_CHANGE_HANDLER_MODE,
      },
      {
        event_type: SOCIAL_COLLECTION_CHANGE_EVENT_TYPE,
        handler_name: SOCIAL_PUBLIC_ACTIVITY_HANDLER_NAME,
        handler_mode: SOCIAL_PUBLIC_ACTIVITY_HANDLER_MODE,
      },
    ]);
    await assertRoutableOutbox([operationId]);
  });

  test('node create validates parent and persists position plus children revision evidence', async () => {
    await resetFixture();
    const createdId = 'canonical-adapter-created';
    const operationId = '77777777-7777-4777-8777-777777777777';
    const result = await executeMutation(nodeMutation(operationId, 'create', createdId, ROOT_ID, {
      beforeId: NODE_ID,
      kindFields: {
        kind: 'bookmark', title: 'Created', url: 'https://example.test/created',
        description: null, tags: ['new'], visibility: 'private',
      },
    }));
    const state = await runtime.pool.query(
      `select n.parent_id, n.position_token, n.resource_revision, n.payload_json,
              n.children_revision created_children_revision,
              r.children_revision root_children_revision, c.content_revision, c.policy_revision,
              (select count(*)::int from children_revisions where parent_id = $1) children_evidence,
              (select count(*)::int from children_revisions where parent_id = $3) created_children_evidence,
              (select count(*)::int from policy_revisions where collection_id = $2) policy_evidence
       from nodes n
       join nodes r on r.id = $1
       join collections c on c.id = n.collection_id
       where n.id = $3`,
      [ROOT_ID, COLLECTION_ID, createdId],
    );
    const row = state.rows[0];
    assert.equal(row.parent_id, ROOT_ID);
    assert.ok(row.position_token < 'U');
    assert.equal(row.resource_revision, result.allocation.resourceRevision);
    assert.equal(row.payload_json.title, 'Created');
    assert.equal(row.payload_json.position, row.position_token);
    assert.equal(row.root_children_revision, result.allocation.childrenRevisions[ROOT_ID]);
    assert.equal(row.created_children_revision, result.allocation.createdNodeChildrenRevision);
    assert.equal(row.created_children_evidence, 0);
    assert.equal(row.content_revision, result.allocation.contentRevision);
    assert.equal(row.policy_revision, result.allocation.policyRevision);
    assert.deepEqual([row.children_evidence, row.policy_evidence], [1, 1]);
    await assertRoutableOutbox([operationId]);
  });

  test('folder create persists its allocated initial children revision at the same ordinal', async () => {
    await resetFixture();
    const createdId = 'canonical-adapter-created-folder';
    const operationId = '76767676-7676-4676-8676-767676767676';
    const result = await executeMutation(nodeMutation(operationId, 'create', createdId, ROOT_ID));
    const evidence = await runtime.pool.query(
      `select n.kind, n.children_revision,
              created.revision created_revision, created.ordinal::text created_ordinal,
              parent.revision parent_revision, parent.ordinal::text parent_ordinal
       from nodes n
       join children_revisions created on created.parent_id = n.id
       join children_revisions parent on parent.parent_id = $1
       where n.id = $2`,
      [ROOT_ID, createdId],
    );
    assert.deepEqual(evidence.rows[0], {
      kind: 'folder',
      children_revision: result.allocation.createdNodeChildrenRevision,
      created_revision: result.allocation.createdNodeChildrenRevision,
      created_ordinal: '2',
      parent_revision: result.allocation.childrenRevisions[ROOT_ID],
      parent_ordinal: '2',
    });
    await assertRoutableOutbox([operationId]);
  });

  test('strict global ID reservations reject same-type node, operation and outbox collisions with full rollback', async () => {
    const collisions = [
      { kind: 'node', reservedId: 'canonical-adapter-reserved-node' },
      { kind: 'operation', reservedId: '61616161-6161-4161-8161-616161616161' },
      { kind: 'outbox', reservedId: 'canonical-adapter-reserved-outbox' },
    ] as const;
    for (const collision of collisions) {
      await resetFixture();
      await runtime.pool.query(
        'insert into resource_id_ledger (resource_id, resource_type) values ($1, $2)',
        [collision.reservedId, collision.kind],
      );
      const operationId = collision.kind === 'operation'
        ? collision.reservedId
        : collision.kind === 'node'
          ? '62626262-6262-4262-8262-626262626262'
          : '63636363-6363-4363-8363-636363636363';
      const input = collision.kind === 'node'
        ? nodeMutation(operationId, 'create', collision.reservedId, ROOT_ID)
        : mutation(operationId);
      const unitOfWork = createPostgresCanonicalMutationUnitOfWork(runtime.db, {
        ...(collision.kind === 'outbox' ? { outboxIdGenerator: () => collision.reservedId } : {}),
      });
      await assert.rejects(unitOfWork.execute(async (ports) => {
        const binding = { principalId: PRINCIPAL_ID, commandScope: 'canonical:collision', commandId: operationId };
        assert.equal((await ports.receipts.claim(binding, `fp-${operationId}`)).kind, 'claimed');
        return ports.canonical.execute(input);
      }));
      const state = await runtime.pool.query(
        `select (select count(*)::int from resource_id_ledger where resource_id = $1) ledger,
                (select count(*)::int from nodes where id = $1) node,
                (select commit_ordinal::text from collections where id = $2) ordinal,
                (select count(*)::int from resource_revisions) resource_revisions,
                (select count(*)::int from content_revisions) content_revisions,
                (select count(*)::int from policy_revisions) policy_revisions,
                (select count(*)::int from children_revisions) children_revisions,
                (select count(*)::int from operations) operations,
                (select count(*)::int from audit_events) audit,
                (select count(*)::int from outbox_events) outbox,
                (select count(*)::int from product_command_receipts) receipts`,
        [collision.reservedId, COLLECTION_ID],
      );
      assert.deepEqual(state.rows[0], {
        ledger: 1, node: 0, ordinal: '1', resource_revisions: 0, content_revisions: 0,
        policy_revisions: 0, children_revisions: 0, operations: 0, audit: 0, outbox: 0, receipts: 0,
      });
    }
  }, 30_000);

  test('resolves before, after, adjacent dual-anchor and append placement against immediate siblings', async () => {
    const cases = [
      { label: 'before', anchors: (firstId: string) => ({ beforeId: NODE_ID }), expected: (id: string, firstId: string, lastId: string) => [firstId, id, NODE_ID, lastId] },
      { label: 'after', anchors: (firstId: string) => ({ afterId: NODE_ID }), expected: (id: string, firstId: string, lastId: string) => [firstId, NODE_ID, id, lastId] },
      { label: 'both', anchors: (firstId: string) => ({ afterId: firstId, beforeId: NODE_ID }), expected: (id: string, firstId: string, lastId: string) => [firstId, id, NODE_ID, lastId] },
      { label: 'append', anchors: (firstId: string) => ({}), expected: (id: string, firstId: string, lastId: string) => [firstId, NODE_ID, lastId, id] },
    ] as const;
    let ordinal = 0;
    for (const placement of cases) {
      await resetFixture();
      const { firstId, lastId } = await insertRootSiblings();
      ordinal += 1;
      const createdId = `canonical-placement-${placement.label}`;
      await executeMutation(nodeMutation(
        `71717171-7171-4171-8171-7171717171${String(ordinal).padStart(2, '0')}`,
        'create', createdId, ROOT_ID, placement.anchors(firstId),
      ));
      const ordered = await runtime.pool.query<{ id: string }>(
        `select id from nodes where parent_id = $1 and deleted_at is null order by position_token collate "C"`,
        [ROOT_ID],
      );
      assert.deepEqual(ordered.rows.map((row) => row.id), placement.expected(createdId, firstId, lastId));
    }
  }, 30_000);

  test('rejects stale non-adjacent and non-sibling placement context without artifacts', async () => {
    await resetFixture();
    const { firstId, lastId } = await insertRootSiblings();
    await assert.rejects(executeMutation(nodeMutation(
      '72727272-7272-4272-8272-727272727272', 'create', 'node-stale-non-adjacent', ROOT_ID,
      { afterId: firstId, beforeId: lastId },
    )));
    await resetFixture();
    await insertFolderTree();
    await assert.rejects(executeMutation(nodeMutation(
      '73737373-7373-4373-8373-737373737373', 'create', 'node-stale-non-sibling', ROOT_ID,
      { beforeId: CHILD_FOLDER_ID },
    )));
    const state = await runtime.pool.query(
      `select (select commit_ordinal::text from collections where id = $1) ordinal,
              (select count(*)::int from resource_revisions) revisions,
              (select count(*)::int from operations) operations,
              (select count(*)::int from audit_events) audit,
              (select count(*)::int from outbox_events) outbox`,
      [COLLECTION_ID],
    );
    assert.deepEqual(state.rows[0], { ordinal: '1', revisions: 0, operations: 0, audit: 0, outbox: 0 });
  });

  test('rejects a bookmark parent and rolls back all canonical artifacts', async () => {
    await resetFixture();
    const createdId = 'canonical-adapter-invalid-parent';
    await assert.rejects(
      executeMutation(nodeMutation(
        '88888888-8888-4888-8888-888888888888', 'create', createdId, NODE_ID,
      )),
      (error: unknown) => error instanceof CanonicalMutationInvariantError
        && error.message === 'target parent must be a live folder in the collection',
    );
    const state = await runtime.pool.query(
      `select (select count(*)::int from nodes where id = $1) nodes,
              (select count(*)::int from resource_id_ledger where resource_id = $1) ledger,
              (select count(*)::int from operations) operations,
              (select count(*)::int from outbox_events) outbox,
              (select commit_ordinal::text from collections where id = $2) ordinal`,
      [createdId, COLLECTION_ID],
    );
    assert.deepEqual(state.rows[0], { nodes: 0, ledger: 0, operations: 0, outbox: 0, ordinal: '1' });
  });

  test.each([
    ['itself', FOLDER_ID, 'target parent ancestry already contains a cycle'],
    ['its descendant', CHILD_FOLDER_ID, 'target parent must not be the node or its descendant'],
  ])('rejects moving a folder beneath %s with full rollback', async (_label, parentId, invariantMessage) => {
    await resetFixture();
    await insertFolderTree();
    const operationId = parentId === FOLDER_ID
      ? '99999999-9999-4999-8999-999999999999'
      : 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    await assert.rejects(
      executeMutation(nodeMutation(operationId, 'move', FOLDER_ID, parentId, {
        expectedResourceRevision: 'folder-r1',
      })),
      (error: unknown) => error instanceof CanonicalMutationInvariantError
        && error.message === invariantMessage,
    );
    const state = await runtime.pool.query(
      `select parent_id, resource_revision,
              (select commit_ordinal::text from collections where id = $2) ordinal,
              (select count(*)::int from resource_revisions) revisions,
              (select count(*)::int from operations) operations,
              (select count(*)::int from outbox_events) outbox
       from nodes where id = $1`,
      [FOLDER_ID, COLLECTION_ID],
    );
    assert.deepEqual(state.rows[0], {
      parent_id: ROOT_ID, resource_revision: 'folder-r1', ordinal: '1', revisions: 0, operations: 0, outbox: 0,
    });
  });

  async function insertDeepFolderChain(depth: number): Promise<string> {
    // canonical-deep-1 under ROOT, ..., canonical-deep-depth under canonical-deep-(depth-1).
    await runtime.pool.query(
      `insert into resource_id_ledger(resource_id, resource_type)
       select 'canonical-deep-' || series::text, 'node'
       from generate_series(1, $1::integer) series
       on conflict (resource_id) do nothing`,
      [depth],
    );
    await runtime.pool.query(
      `insert into nodes (
         id, collection_id, parent_id, kind, is_root, title, url, description, tags,
         visibility, position_token, resource_revision, children_revision
       )
       with recursive chain as (
         select 1 as n, $1::text as id, $2::text as parent
         union all
         select chain.n + 1, 'canonical-deep-' || (chain.n + 1)::text, chain.id
         from chain where chain.n < $3::integer
       )
       select id, $4, parent, 'folder', false, 'deep ' || n::text, null, null, '[]'::jsonb,
         'inherit', 'deep-' || n::text, 'deep-r1-' || n::text, 'deep-children-r1-' || n::text
       from chain`,
      ['canonical-deep-1', ROOT_ID, depth, COLLECTION_ID],
    );
    return `canonical-deep-${depth}`;
  }

  test('rejects moving into a pre-existing ancestry cycle with the cycle invariant and full rollback', async () => {
    await resetFixture();
    await insertFolderTree();
    // Corrupt the tree into a two-node cycle: FOLDER <-> CHILD_FOLDER.
    await runtime.pool.query(
      'update nodes set parent_id = $1 where id = $2',
      [CHILD_FOLDER_ID, FOLDER_ID],
    );
    await assert.rejects(
      executeMutation(nodeMutation(
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab', 'move', NODE_ID, CHILD_FOLDER_ID,
        { expectedResourceRevision: 'node-r1' },
      )),
      (error: unknown) => error instanceof CanonicalMutationInvariantError
        && error.message === 'target parent ancestry already contains a cycle',
    );
    const state = await runtime.pool.query(
      `select parent_id, resource_revision,
              (select commit_ordinal::text from collections where id = $2) ordinal,
              (select count(*)::int from resource_revisions) revisions,
              (select count(*)::int from operations) operations,
              (select count(*)::int from outbox_events) outbox
       from nodes where id = $1`,
      [NODE_ID, COLLECTION_ID],
    );
    assert.deepEqual(state.rows[0], {
      parent_id: ROOT_ID, resource_revision: 'node-r1', ordinal: '1', revisions: 0, operations: 0, outbox: 0,
    });
  });

  test('rejects moving beyond the depth cap with the depth invariant, distinct from a cycle, and full rollback', async () => {
    await resetFixture();
    const leaf = await insertDeepFolderChain(257);
    await assert.rejects(
      executeMutation(nodeMutation(
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaac', 'move', NODE_ID, leaf,
        { expectedResourceRevision: 'node-r1' },
      )),
      (error: unknown) => error instanceof CanonicalMutationInvariantError
        && error.message === 'target parent ancestry exceeds maximum depth'
        && error.message !== 'target parent ancestry already contains a cycle',
    );
    const state = await runtime.pool.query(
      `select parent_id, resource_revision,
              (select commit_ordinal::text from collections where id = $2) ordinal,
              (select count(*)::int from resource_revisions) revisions,
              (select count(*)::int from operations) operations,
              (select count(*)::int from outbox_events) outbox
       from nodes where id = $1`,
      [NODE_ID, COLLECTION_ID],
    );
    assert.deepEqual(state.rows[0], {
      parent_id: ROOT_ID, resource_revision: 'node-r1', ordinal: '1', revisions: 0, operations: 0, outbox: 0,
    });
  });

  test('node move and delete update both parent revisions and durable deletion evidence', async () => {
    await resetFixture();
    await insertFolderTree();
    const move = await executeMutation(nodeMutation(
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'move', NODE_ID, FOLDER_ID,
      {
        expectedResourceRevision: 'node-r1',
        kindFields: {
          kind: 'folder', title: 'Forged move title', url: null, description: 'forged',
          tags: ['forged'], visibility: 'private',
        },
        extensions: { forged: true },
      },
    ));
    assert.ok(move.allocation.childrenRevisions[ROOT_ID]);
    assert.ok(move.allocation.childrenRevisions[FOLDER_ID]);
    const moved = await runtime.pool.query(
      `select n.parent_id, n.position_token, n.kind, n.title, n.url, n.description, n.tags,
              n.visibility, n.payload_json,
              root.children_revision root_revision, folder.children_revision folder_revision,
              (select count(*)::int from children_revisions) evidence,
              (select e.event_type from outbox_events e join operations o
                on o.collection_id=e.aggregate_scope and o.commit_ordinal=e.commit_ordinal
                where o.operation_id=$4 and e.event_type='node.moved') event_type,
              (select e.payload_json from outbox_events e join operations o
                on o.collection_id=e.aggregate_scope and o.commit_ordinal=e.commit_ordinal
                where o.operation_id=$4 and e.event_type='node.moved') event_payload
       from nodes n join nodes root on root.id = $2 join nodes folder on folder.id = $3 where n.id = $1`,
      [NODE_ID, ROOT_ID, FOLDER_ID, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'],
    );
    assert.equal(moved.rows[0].parent_id, FOLDER_ID);
    assert.equal(moved.rows[0].payload_json.parentId, FOLDER_ID);
    assert.deepEqual({
      kind: moved.rows[0].kind,
      title: moved.rows[0].title,
      url: moved.rows[0].url,
      description: moved.rows[0].description,
      tags: moved.rows[0].tags ?? [],
      visibility: moved.rows[0].visibility,
      extensions: moved.rows[0].payload_json.extensions,
    }, {
      kind: 'bookmark', title: 'Before', url: 'https://example.test/before', description: null,
      tags: [], visibility: 'inherit', extensions: {},
    });
    assert.equal(moved.rows[0].root_revision, move.allocation.childrenRevisions[ROOT_ID]);
    assert.equal(moved.rows[0].folder_revision, move.allocation.childrenRevisions[FOLDER_ID]);
    assert.equal(moved.rows[0].evidence, 2);
    assert.equal(moved.rows[0].event_type, 'node.moved');
    assert.deepEqual(Object.keys(moved.rows[0].event_payload).sort(), [
      'collectionId', 'contentRevision', 'kind', 'nodeId', 'policyRevision', 'resourceRevision',
      'sourceChildrenRevision', 'sourceParentId', 'targetChildrenRevision', 'targetParentId',
    ]);

    const deletion = await executeMutation(nodeMutation(
      'cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'delete', NODE_ID, FOLDER_ID,
      {
        expectedResourceRevision: move.allocation.resourceRevision,
        kindFields: {
          kind: 'folder', title: 'Forged delete title', url: null, description: 'forged delete',
          tags: ['forged-delete'], visibility: 'private',
        },
        extensions: { forgedDelete: true },
      },
    ));
    const deleted = await runtime.pool.query(
      `select kind, title, url, description, tags, visibility,
              deleted_at is not null deleted, deleted_commit_ordinal::text, resource_revision,
              payload_json, (select count(*)::int from children_revisions) evidence,
              (select payload_json from operation_payloads where operation_id = $2) operation_payload,
              (select details_json from audit_event_payloads where event_id=(select id from audit_events where operation_id = $2)) audit_payload,
              (select e.payload_json from outbox_events e join operations o
                on o.collection_id=e.aggregate_scope and o.commit_ordinal=e.commit_ordinal
                where o.operation_id=$2 and e.event_type='node.deleted') outbox_payload
       from nodes where id = $1`,
      [NODE_ID, 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'],
    );
    assert.deepEqual({
      kind: deleted.rows[0].kind, title: deleted.rows[0].title, url: deleted.rows[0].url,
      description: deleted.rows[0].description, tags: deleted.rows[0].tags ?? [],
      visibility: deleted.rows[0].visibility, extensions: deleted.rows[0].payload_json.extensions,
    }, {
      kind: 'bookmark', title: 'Before', url: 'https://example.test/before', description: null,
      tags: [], visibility: 'inherit', extensions: {},
    });
    assert.equal(deleted.rows[0].deleted, true);
    assert.equal(deleted.rows[0].deleted_commit_ordinal, '3');
    assert.equal(deleted.rows[0].resource_revision, deletion.allocation.resourceRevision);
    assert.equal(deleted.rows[0].payload_json.deletedCommitOrdinal, '3');
    assert.equal(deleted.rows[0].evidence, 3);
    assert.equal('kindFields' in deleted.rows[0].operation_payload, false);
    assert.equal('extensions' in deleted.rows[0].operation_payload, false);
    assert.deepEqual(deleted.rows[0].audit_payload, deleted.rows[0].operation_payload);
    assert.deepEqual(Object.keys(deleted.rows[0].outbox_payload).sort(), [
      'affectedCount', 'collectionId', 'contentRevision', 'kind', 'nodeId',
      'parentChildrenRevision', 'parentId', 'policyRevision', 'scope',
    ]);
    await assertRoutableOutbox([
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    ]);
  });

  test('recursive delete batches 128-row boundaries with exact tombstones, revisions and one summary event', async () => {
    const cases = [
      { nodeCount: 128, expectedBatches: 1, operationId: '90909090-9090-4090-8090-909090909090' },
      { nodeCount: 129, expectedBatches: 2, operationId: '91919191-9191-4191-8191-919191919191' },
      { nodeCount: 257, expectedBatches: 3, operationId: '92929292-9292-4292-8292-929292929292' },
    ] as const;

    for (const testCase of cases) {
      await resetFixture();
      const nodeIds = await insertDeleteBatchTree(testCase.nodeCount);
      const resourceBatchIndexes: number[] = [];
      let queryCount = 0;
      const countedDb = runtime.db.withPlugin({
        transformQuery(args) {
          queryCount += 1;
          return args.node;
        },
        async transformResult(args) {
          return args.result;
        },
      });
      const result = await executeMutation(nodeMutation(
        testCase.operationId,
        'delete',
        nodeIds[0]!,
        ROOT_ID,
        { expectedResourceRevision: 'batch-target-r1', deleteScope: 'subtree' },
      ), {
        afterPhase(context) {
          if (context.phase === 'resource' && context.resourceIndex !== undefined) {
            resourceBatchIndexes.push(context.resourceIndex);
          }
        },
      }, countedDb);

      assert.equal(resourceBatchIndexes.length, testCase.expectedBatches);
      assert.equal(resourceBatchIndexes.at(-1), testCase.nodeCount - 1);
      // Per-batch: tombstone update + revision write, plus bookmark_icons (BF-03)
      // and collection_link_health (LH-01) cleanup.
      assert.ok(
        queryCount <= 42 + (testCase.expectedBatches * 4)
          + Math.ceil(testCase.nodeCount / NODE_DELETE_AFFECTED_FACT_PAGE_SIZE),
        `recursive delete used ${queryCount} queries for ${testCase.nodeCount} nodes`,
      );
      assert.equal(Object.keys(result.allocation.deletedResourceRevisions ?? {}).length, testCase.nodeCount);
      const rows = await runtime.pool.query(
        `select n.id, n.resource_revision, n.deleted_at, n.deleted_commit_ordinal::text,
                n.payload_json, rr.revision evidence_revision
         from nodes n
         left join resource_revisions rr
           on rr.collection_id = n.collection_id and rr.resource_id = n.id and rr.ordinal = $2
         where n.id = any($1::text[])
         order by n.id`,
        [nodeIds, result.allocation.commitOrdinal.toString()],
      );
      assert.equal(rows.rowCount, testCase.nodeCount);
      for (const row of rows.rows) {
        const expectedRevision = result.allocation.deletedResourceRevisions?.[row.id];
        assert.ok(expectedRevision);
        assert.ok(row.deleted_at instanceof Date);
        assert.equal(row.deleted_commit_ordinal, result.allocation.commitOrdinal.toString());
        assert.equal(row.resource_revision, expectedRevision);
        assert.equal(row.evidence_revision, expectedRevision);
        assert.equal(row.payload_json.resourceRevision, expectedRevision);
        assert.equal(row.payload_json.deletedCommitOrdinal, result.allocation.commitOrdinal.toString());
      }
      const evidence = await runtime.pool.query(
        `select
           (select count(*)::int from resource_revisions where ordinal = $2) resource_revisions,
           (select count(*)::int from sync_node_revision_history where operation_id = $1) node_history,
           (select count(*)::int from operations where operation_id = $1) operations,
           (select count(*)::int from audit_events where operation_id = $1) audit,
           (select count(*)::int from outbox_events e join operations o
             on o.collection_id=e.aggregate_scope and o.commit_ordinal=e.commit_ordinal
             where o.operation_id=$1) outbox,
           (select payload_json->'affectedResourceIds' from operation_payloads where operation_id = $1) affected_ids,
           (select (e.payload_json->>'affectedCount')::int from outbox_events e join operations o
             on o.collection_id=e.aggregate_scope and o.commit_ordinal=e.commit_ordinal
             where o.operation_id=$1 and e.event_type='node.deleted') affected_count,
           (select e.payload_json->>'scope' from outbox_events e join operations o
             on o.collection_id=e.aggregate_scope and o.commit_ordinal=e.commit_ordinal
             where o.operation_id=$1 and e.event_type='node.deleted') delete_scope`,
        [testCase.operationId, result.allocation.commitOrdinal.toString()],
      );
      assert.deepEqual(evidence.rows[0], {
        resource_revisions: testCase.nodeCount,
        node_history: testCase.nodeCount,
        operations: 1,
        audit: 1,
        outbox: 3,
        affected_ids: evidence.rows[0].affected_ids,
        affected_count: testCase.nodeCount,
        delete_scope: 'subtree',
      });
      assert.equal(evidence.rows[0].affected_ids.length, testCase.nodeCount);
      assert.deepEqual(new Set(evidence.rows[0].affected_ids), new Set(nodeIds));
    }
  }, 60_000);

  test('failure after the first recursive-delete batch rolls back every batch and artifact', async () => {
    await resetFixture();
    const nodeIds = await insertDeleteBatchTree(129);
    const operationId = '93939393-9393-4393-8393-939393939393';
    const fault = new Error('injected recursive delete batch fault');
    const observedIndexes: number[] = [];
    await assert.rejects(executeMutation(nodeMutation(
      operationId,
      'delete',
      nodeIds[0]!,
      ROOT_ID,
      { expectedResourceRevision: 'batch-target-r1', deleteScope: 'subtree' },
    ), {
      afterPhase(context) {
        if (context.phase !== 'resource' || context.resourceIndex === undefined) return;
        observedIndexes.push(context.resourceIndex);
        if (context.resourceIndex === 127) throw fault;
      },
    }), fault);
    assert.deepEqual(observedIndexes, [127]);

    const state = await runtime.pool.query(
      `select
         (select count(*)::int from nodes where id = any($1::text[]) and deleted_at is null) live_nodes,
         (select count(*)::int from resource_revisions) resource_revisions,
         (select count(*)::int from children_revisions) children_revisions,
         (select count(*)::int from content_revisions) content_revisions,
         (select count(*)::int from operations) operations,
         (select count(*)::int from audit_events) audit,
         (select count(*)::int from outbox_events) outbox,
         (select count(*)::int from product_command_receipts) receipts,
         (select commit_ordinal::text from collections where id = $2) ordinal`,
      [nodeIds, COLLECTION_ID],
    );
    assert.deepEqual(state.rows[0], {
      live_nodes: 129,
      resource_revisions: 0,
      children_revisions: 0,
      content_revisions: 0,
      operations: 0,
      audit: 0,
      outbox: 0,
      receipts: 0,
      ordinal: '1',
    });
  });

  test('same-parent move preserves content and advances one children revision', async () => {
    await resetFixture();
    const { firstId } = await insertRootSiblings();
    const result = await executeMutation(nodeMutation(
      '74747474-7474-4474-8474-747474747474', 'move', NODE_ID, ROOT_ID,
      {
        expectedResourceRevision: 'node-r1',
        beforeId: firstId,
        kindFields: {
          kind: 'folder', title: 'Ignored', url: null, description: 'ignored', tags: ['ignored'], visibility: 'private',
        },
        extensions: { ignored: true },
      },
    ));
    assert.deepEqual(Object.keys(result.allocation.childrenRevisions), [ROOT_ID]);
    const state = await runtime.pool.query(
      `select kind, title, url, description, tags, visibility, parent_id, payload_json,
              (select count(*)::int from children_revisions) children_evidence,
              (select count(*)::int from resource_revisions where resource_id = $1) resource_evidence
       from nodes where id = $1`,
      [NODE_ID],
    );
    assert.deepEqual({
      kind: state.rows[0].kind, title: state.rows[0].title, url: state.rows[0].url,
      description: state.rows[0].description, tags: state.rows[0].tags ?? [],
      visibility: state.rows[0].visibility, parent_id: state.rows[0].parent_id,
      extensions: state.rows[0].payload_json.extensions,
    }, {
      kind: 'bookmark', title: 'Before', url: 'https://example.test/before', description: null,
      tags: [], visibility: 'inherit', parent_id: ROOT_ID, extensions: {},
    });
    assert.deepEqual([state.rows[0].children_evidence, state.rows[0].resource_evidence], [1, 1]);
    await assertRoutableOutbox(['74747474-7474-4474-8474-747474747474']);
  });

  test('exhausted position gap performs a bounded sibling rebalance atomically', async () => {
    await resetFixture();
    const lowerId = 'canonical-tight-lower';
    const upperId = 'canonical-tight-upper';
    const lowerToken = 'a'.repeat(128);
    const upperToken = `${'a'.repeat(127)}b`;
    await runtime.pool.query(
      `insert into resource_id_ledger (resource_id, resource_type) values ($1, 'node'), ($2, 'node')`,
      [lowerId, upperId],
    );
    await runtime.pool.query(
      `insert into nodes (
         id, collection_id, parent_id, kind, is_root, title, url, description, tags,
         visibility, position_token, resource_revision, children_revision
       ) values
       ($1, $3, $4, 'folder', false, 'Lower', null, null, '[]'::jsonb,
        'inherit', $5, 'lower-r1', 'lower-children-r1'),
       ($2, $3, $4, 'folder', false, 'Upper', null, null, '[]'::jsonb,
        'inherit', $6, 'upper-r1', 'upper-children-r1')`,
      [lowerId, upperId, COLLECTION_ID, ROOT_ID, lowerToken, upperToken],
    );
    await runtime.pool.query('update nodes set position_token = $1 where id = $2', ['1', NODE_ID]);
    await materializeCurrentNodes([lowerId, upperId, NODE_ID]);
    const createdId = 'canonical-rebalanced-created';
    const operationId = '75757575-7575-4575-8575-757575757575';
    const result = await executeMutation(nodeMutation(operationId, 'create', createdId, ROOT_ID, {
      afterId: lowerId,
      beforeId: upperId,
    }));
    assert.equal(result.allocation.rebalancedSiblings?.length, 3);
    const rows = await runtime.pool.query(
      `select id, position_token, resource_revision,
              payload_json->>'position' payload_position,
              payload_json->>'resourceRevision' payload_revision,
              (select count(*)::int from resource_revisions rr
               where rr.resource_id = n.id and rr.ordinal = 2) revision_evidence
       from nodes n where parent_id = $1 and deleted_at is null order by position_token collate "C"`,
      [ROOT_ID],
    );
    assert.deepEqual(rows.rows.map((row) => row.id), [NODE_ID, lowerId, createdId, upperId]);
    for (const row of rows.rows) {
      assert.equal(row.payload_position, row.position_token);
      assert.equal(row.payload_revision, row.resource_revision);
      assert.equal(row.revision_evidence, 1);
    }
    const evidence = await runtime.pool.query(
      `select commit_ordinal::text ordinal,
              (select count(*)::int from children_revisions where ordinal = 2) children_evidence,
              (select count(*)::int from content_revisions where ordinal = 2) content_evidence,
              (select count(*)::int from operations where operation_id = $2) operations,
              (select count(*)::int from audit_events where operation_id = $2) audit,
              (select count(*)::int from outbox_events e join operations o
                on o.collection_id=e.aggregate_scope and o.commit_ordinal=e.commit_ordinal
                where o.operation_id=$2) outbox
       from collections where id = $1`,
      [COLLECTION_ID, operationId],
    );
    assert.deepEqual(evidence.rows[0], {
      ordinal: '2', children_evidence: 2, content_evidence: 1, operations: 1, audit: 1, outbox: 3,
    });
    await assertRoutableOutbox([operationId]);
  });

  test('bounded rebalance leaves a large sibling set unchanged outside its configured window', async () => {
    await resetFixture();
    const siblingIds = Array.from({ length: 40 }, (_, index) => `bounded-sibling-${index + 1}`);
    await runtime.pool.query(
      `insert into resource_id_ledger(resource_id, resource_type)
       select 'bounded-sibling-' || series::text, 'node'
       from generate_series(1, 40) series`,
    );
    await runtime.pool.query(
      `insert into nodes(
         id, collection_id, parent_id, kind, is_root, title, visibility,
         position_token, resource_revision, children_revision
       )
       select 'bounded-sibling-' || series::text, $1, $2, 'folder', false,
         'Sibling ' || series::text, 'inherit',
         case
           when series <= 20 then 'A' || lpad(series::text, 3, '0')
           when series = 21 then repeat('a', 128)
           when series = 22 then repeat('a', 127) || 'b'
           else 'z' || lpad(series::text, 3, '0')
         end,
         'bounded-r1-' || series::text,
         'bounded-children-r1-' || series::text
       from generate_series(1, 40) series`,
      [COLLECTION_ID, ROOT_ID],
    );
    await materializeCurrentNodes(siblingIds);
    const before = await runtime.pool.query(
      `select id, position_token, resource_revision from nodes
       where id = any($1::text[]) order by id`,
      [siblingIds],
    );
    const beforeById = new Map(before.rows.map((row) => [row.id, row] as const));
    const metrics = new InMemoryMetrics();
    let queryCount = 0;
    const countedDb = runtime.db.withPlugin({
      transformQuery(args) {
        queryCount += 1;
        return args.node;
      },
      async transformResult(args) {
        return args.result;
      },
    });
    const createdId = 'bounded-window-created';
    const operationId = '25252525-2525-4525-8525-252525252525';
    const result = await executeMutation(
      nodeMutation(operationId, 'create', createdId, ROOT_ID, {
        afterId: 'bounded-sibling-21',
        beforeId: 'bounded-sibling-22',
      }),
      undefined,
      countedDb,
      { metrics, positionRebalanceWindow: 4 },
    );
    assert.ok(queryCount <= 75, `bounded rebalance used ${queryCount} database round trips`);
    assert.equal(result.allocation.rebalancedSiblings?.length, 4);
    assert.equal(metrics.get('position.rebalance.bounded_total'), 1);
    assert.deepEqual(metrics.observations('position.rebalance.rewritten_siblings'), [4]);
    assert.equal(metrics.get('position.rebalance.escalation_total'), 0);
    const rewrittenIds = new Set(result.allocation.rebalancedSiblings!.map((row) => row.resourceId));
    const after = await runtime.pool.query(
      `select id, position_token, resource_revision from nodes
       where id = any($1::text[]) order by id`,
      [siblingIds],
    );
    for (const row of after.rows) {
      const previous = beforeById.get(row.id)!;
      if (rewrittenIds.has(row.id)) {
        assert.notEqual(row.resource_revision, previous.resource_revision);
      } else {
        assert.deepEqual(row, previous);
      }
    }
    const ordered = await runtime.pool.query(
      `select id, position_token from nodes
       where collection_id = $1 and parent_id = $2 and deleted_at is null
       order by position_token collate "C", id collate "C"`,
      [COLLECTION_ID, ROOT_ID],
    );
    const orderedIds = ordered.rows.map((row) => row.id);
    assert.ok(orderedIds.indexOf('bounded-sibling-21') < orderedIds.indexOf(createdId));
    assert.ok(orderedIds.indexOf(createdId) < orderedIds.indexOf('bounded-sibling-22'));
    assert.equal(new Set(ordered.rows.map((row) => row.position_token)).size, ordered.rows.length);
    const revisionBudget = await runtime.pool.query(
      `select
        (select count(*)::int from resource_revisions where ordinal = 2) revisions,
        (select count(*)::int from sync_node_revision_history where operation_id = $1) history`,
      [operationId],
    );
    assert.deepEqual(revisionBudget.rows[0], { revisions: 5, history: 5 },
      'target plus four bounded sibling rewrites');
  });

  test('local exhaustion escalates explicitly and rolls back instead of widening the window', async () => {
    await resetFixture();
    const ids = ['escalation-lower', 'escalation-inside', 'escalation-upper'];
    await runtime.pool.query(
      `insert into resource_id_ledger(resource_id, resource_type)
       values ($1, 'node'), ($2, 'node'), ($3, 'node')`,
      ids,
    );
    await runtime.pool.query(
      `insert into nodes(
         id, collection_id, parent_id, kind, is_root, title, visibility,
         position_token, resource_revision, children_revision
       ) values
       ($1, $4, $5, 'folder', false, 'Lower', 'inherit', $6, 'escalation-lower-r1', 'el-c1'),
       ($2, $4, $5, 'folder', false, 'Inside', 'inherit', $7, 'escalation-inside-r1', 'ei-c1'),
       ($3, $4, $5, 'folder', false, 'Upper', 'inherit', $8, 'escalation-upper-r1', 'eu-c1')`,
      [...ids, COLLECTION_ID, ROOT_ID, '0', '0-', '0--'],
    );
    await materializeCurrentNodes(ids);
    const metrics = new InMemoryMetrics();
    const createdId = 'escalation-created';
    await assert.rejects(
      executeMutation(
        nodeMutation('26262626-2626-4626-8626-262626262626', 'create', createdId, ROOT_ID, {
          afterId: ids[0], beforeId: ids[1],
        }),
        undefined,
        runtime.db,
        { metrics, positionRebalanceWindow: 1 },
      ),
      (error: unknown) => error instanceof PositionRebalanceEscalationError
        && error.code === 'position_context_stale'
        && error.windowSize === 1,
    );
    assert.equal(metrics.get('position.rebalance.escalation_total'), 1);
    const state = await runtime.pool.query(
      `select (select count(*)::int from nodes where id = $2) created,
              (select count(*)::int from resource_revisions) revisions,
              (select count(*)::int from operations) operations,
              (select count(*)::int from product_command_receipts) receipts,
              commit_ordinal::text ordinal
       from collections where id = $1`,
      [COLLECTION_ID, createdId],
    );
    assert.deepEqual(state.rows[0], { created: 0, revisions: 0, operations: 0, receipts: 0, ordinal: '1' });
  });

  test('concurrent dense-anchor inserts serialize and cannot create duplicate positions', async () => {
    await resetFixture();
    const lowerId = 'concurrent-position-lower';
    const upperId = 'concurrent-position-upper';
    await runtime.pool.query(
      `insert into resource_id_ledger(resource_id, resource_type) values ($1, 'node'), ($2, 'node')`,
      [lowerId, upperId],
    );
    await runtime.pool.query(
      `insert into nodes(
         id, collection_id, parent_id, kind, is_root, title, visibility,
         position_token, resource_revision, children_revision
       ) values
       ($1, $3, $4, 'folder', false, 'Lower', 'inherit', $5, 'concurrent-lower-r1', 'cl-c1'),
       ($2, $3, $4, 'folder', false, 'Upper', 'inherit', $6, 'concurrent-upper-r1', 'cu-c1')`,
      [lowerId, upperId, COLLECTION_ID, ROOT_ID, 'a'.repeat(128), `${'a'.repeat(127)}b`],
    );
    await materializeCurrentNodes([lowerId, upperId]);
    const firstId = 'concurrent-position-first';
    const secondId = 'concurrent-position-second';
    const [first, second] = await Promise.all([
      executeMutation(nodeMutation('27272727-2727-4727-8727-272727272727', 'create', firstId, ROOT_ID, {
        afterId: lowerId,
      })),
      executeMutation(nodeMutation('28282828-2828-4828-8828-282828282828', 'create', secondId, ROOT_ID, {
        afterId: lowerId,
      })),
    ]);
    assert.deepEqual([first.allocation.commitOrdinal, second.allocation.commitOrdinal].sort(), [2n, 3n]);
    const rows = await runtime.pool.query(
      `select id, position_token from nodes
       where collection_id = $1 and parent_id = $2 and deleted_at is null
       order by position_token collate "C", id collate "C"`,
      [COLLECTION_ID, ROOT_ID],
    );
    assert.equal(new Set(rows.rows.map((row) => row.position_token)).size, rows.rows.length);
    const idsInOrder = rows.rows.map((row) => row.id);
    assert.ok(idsInOrder.indexOf(lowerId) < idsInOrder.indexOf(firstId));
    assert.ok(idsInOrder.indexOf(lowerId) < idsInOrder.indexOf(secondId));
    assert.ok(idsInOrder.indexOf(firstId) < idsInOrder.indexOf(upperId));
    assert.ok(idsInOrder.indexOf(secondId) < idsInOrder.indexOf(upperId));
  }, 30_000);

  test('rolls back when a rebalance staging UPDATE does not affect exactly one row', async () => {
    await resetFixture();
    const lowerId = 'canonical-staging-lower';
    const upperId = 'canonical-staging-upper';
    const createdId = 'canonical-staging-created';
    const metrics = new InMemoryMetrics();
    await runtime.pool.query(
      `insert into resource_id_ledger (resource_id, resource_type) values ($1, 'node'), ($2, 'node')`,
      [lowerId, upperId],
    );
    await runtime.pool.query(
      `insert into nodes (
         id, collection_id, parent_id, kind, is_root, title, visibility, position_token,
         resource_revision, children_revision
       ) values
       ($1, $3, $4, 'folder', false, 'Lower', 'inherit', $5, 'lower-r1', 'lower-children-r1'),
       ($2, $3, $4, 'folder', false, 'Upper', 'inherit', $6, 'upper-r1', 'upper-children-r1')`,
      [lowerId, upperId, COLLECTION_ID, ROOT_ID, 'a'.repeat(128), `${'a'.repeat(127)}b`],
    );
    await materializeCurrentNodes([lowerId, upperId]);
    await runtime.pool.query(`
      create function canonical_adapter_suppress_staging_update() returns trigger language plpgsql as $$
      begin
        if starts_with(new.position_token, '_stage_') then return null; end if;
        return new;
      end $$;
      create trigger canonical_adapter_suppress_staging_update before update on nodes
      for each row execute function canonical_adapter_suppress_staging_update()
    `);
    try {
      await assert.rejects(
        executeMutation(nodeMutation(
          '78787878-7878-4878-8878-787878787878', 'create', createdId, ROOT_ID,
          { afterId: lowerId, beforeId: upperId },
        ), undefined, runtime.db, { metrics }),
        /rebalance staging.*updated 0 rows instead of one/,
      );
    } finally {
      await runtime.pool.query('drop trigger canonical_adapter_suppress_staging_update on nodes');
      await runtime.pool.query('drop function canonical_adapter_suppress_staging_update()');
    }
    const evidence = await runtime.pool.query(
      `select commit_ordinal::text ordinal,
              (select count(*)::int from nodes where id = $2) created,
              (select count(*)::int from operations) operations,
              (select count(*)::int from outbox_events) outbox,
              (select count(*)::int from product_command_receipts) receipts
       from collections where id = $1`, [COLLECTION_ID, createdId],
    );
    assert.deepEqual(evidence.rows[0], { ordinal: '1', created: 0, operations: 0, outbox: 0, receipts: 0 });
    assert.equal(metrics.get('position.rebalance.bounded_total'), 0);
    assert.deepEqual(metrics.observations('position.rebalance.rewritten_siblings'), []);
  });

  test.each([
    { label: 'same-parent', operationId: '76767676-7676-4676-8676-767676767676', crossParent: false },
    { label: 'cross-parent', operationId: '77777777-7777-4777-8777-777777777777', crossParent: true },
  ])('$label move stages occupied final rebalance positions before authoritative writes', async ({
    operationId, crossParent,
  }) => {
    await resetFixture();
    const ownerId = `collision-owner-${crossParent ? 'cross' : 'same'}`;
    const lowerId = `collision-lower-${crossParent ? 'cross' : 'same'}`;
    const upperId = `collision-upper-${crossParent ? 'cross' : 'same'}`;
    await runtime.pool.query(
      `insert into resource_id_ledger (resource_id, resource_type) values
       ($1, 'node'), ($2, 'node'), ($3, 'node')`,
      [ownerId, lowerId, upperId],
    );
    await runtime.pool.query(
      `insert into nodes (
         id, collection_id, parent_id, kind, is_root, title, visibility, position_token,
         resource_revision, children_revision
       ) values
       ($1, $4, $5, 'folder', false, 'Owner', 'inherit', $6, 'owner-r1', 'owner-children-r1'),
       ($2, $4, $5, 'folder', false, 'Lower', 'inherit', $7, 'lower-r1', 'lower-children-r1'),
       ($3, $4, $5, 'folder', false, 'Upper', 'inherit', $8, 'upper-r1', 'upper-children-r1')`,
      [ownerId, lowerId, upperId, COLLECTION_ID, ROOT_ID, '1', 'a'.repeat(128), `${'a'.repeat(127)}b`],
    );
    if (crossParent) {
      await runtime.pool.query(
        `insert into resource_id_ledger (resource_id, resource_type) values ($1, 'node')`,
        [FOLDER_ID],
      );
      await runtime.pool.query(
        `insert into nodes (id, collection_id, parent_id, kind, is_root, title, visibility,
          position_token, resource_revision, children_revision)
         values ($1, $2, $3, 'folder', false, 'Source', 'inherit', 'z', 'source-r1', 'source-children-r1')`,
        [FOLDER_ID, COLLECTION_ID, ROOT_ID],
      );
      await runtime.pool.query('update nodes set parent_id = $1, position_token = $2 where id = $3', [
        FOLDER_ID, 'U', NODE_ID,
      ]);
      await materializeCurrentNodes([ownerId, lowerId, upperId, FOLDER_ID, NODE_ID]);
    } else {
      await runtime.pool.query('update nodes set position_token = $1 where id = $2', ['0', NODE_ID]);
      await materializeCurrentNodes([ownerId, lowerId, upperId, NODE_ID]);
    }
    const result = await executeMutation(nodeMutation(operationId, 'move', NODE_ID, ROOT_ID, {
      expectedResourceRevision: 'node-r1', afterId: lowerId, beforeId: upperId,
    }));
    assert.equal(result.allocation.rebalancedSiblings?.length, crossParent ? 4 : 3);
    const rows = await runtime.pool.query(
      `select id, position_token, resource_revision,
              payload_json->>'position' payload_position,
              payload_json->>'resourceRevision' payload_revision
       from nodes where parent_id = $1 and deleted_at is null order by position_token collate "C"`,
      [ROOT_ID],
    );
    assert.deepEqual(rows.rows.map((row) => row.id), [
      ownerId, lowerId, NODE_ID, upperId, ...(crossParent ? [FOLDER_ID] : []),
    ]);
    for (const row of rows.rows) {
      assert.equal(row.payload_position, row.position_token);
      assert.equal(row.payload_revision, row.resource_revision);
    }
    const evidence = await runtime.pool.query(
      `select (select count(*)::int from resource_revisions where ordinal = 2) revisions,
              (select count(*)::int from operations where operation_id = $1) operations,
              (select count(*)::int from audit_events where operation_id = $1) audit,
              (select count(*)::int from outbox_events e join operations o
                on o.collection_id=e.aggregate_scope and o.commit_ordinal=e.commit_ordinal
                where o.operation_id=$1) outbox,
              (select count(*)::int from product_command_receipts where command_id = $1 and completed_at is not null) receipt`,
      [operationId],
    );
    assert.deepEqual(evidence.rows[0], {
      revisions: crossParent ? 5 : 4, operations: 1, audit: 1, outbox: 3, receipt: 1,
    });
    await assertRoutableOutbox([operationId]);
  });

  test('normalizes stale graph hints before resource, operation, audit and outbox evidence', async () => {
    await resetFixture();
    const updateId = '13131313-1313-4313-8313-131313131313';
    const forgedUpdate = mutation(updateId);
    forgedUpdate.mutation.parentId = FOLDER_ID;
    await executeMutation(forgedUpdate);
    const updateEvidence = await runtime.pool.query(
      `select n.parent_id, n.payload_json->>'parentId' payload_parent,
              op.payload_json->>'parentId' operation_parent,
              ap.details_json->>'parentId' audit_parent
       from nodes n
       join operations o on o.operation_id = $2
       join operation_payloads op on op.operation_id = o.operation_id
       join audit_events a on a.operation_id = $2
       join audit_event_payloads ap on ap.event_id = a.id
       where n.id = $1`,
      [NODE_ID, updateId],
    );
    assert.deepEqual(updateEvidence.rows[0], {
      parent_id: ROOT_ID, payload_parent: ROOT_ID, operation_parent: ROOT_ID, audit_parent: ROOT_ID,
    });
    await assertRoutableOutbox([updateId]);

    await resetFixture();
    const deleteId = '14141414-1414-4414-8414-141414141414';
    await executeMutation(nodeMutation(deleteId, 'delete', NODE_ID, FOLDER_ID, {
      expectedResourceRevision: 'node-r1',
    }));
    const deleteEvidence = await runtime.pool.query(
      `select n.parent_id, op.payload_json->>'parentId' operation_parent,
              ap.details_json->>'parentId' audit_parent, e.payload_json->>'parentId' outbox_parent
       from nodes n
       join operations o on o.operation_id = $2
       join operation_payloads op on op.operation_id = o.operation_id
       join audit_events a on a.operation_id = $2
       join audit_event_payloads ap on ap.event_id = a.id
       join outbox_events e on e.aggregate_scope=o.collection_id
         and e.commit_ordinal=o.commit_ordinal and e.event_type='node.deleted'
       where n.id = $1`,
      [NODE_ID, deleteId],
    );
    assert.deepEqual(deleteEvidence.rows[0], {
      parent_id: ROOT_ID, operation_parent: ROOT_ID, audit_parent: ROOT_ID, outbox_parent: ROOT_ID,
    });
    await assertRoutableOutbox([deleteId]);

    await resetFixture();
    const collectionId = '15151515-1515-4515-8515-151515151515';
    const forgedCollection = collectionMutation(collectionId, { title: 'Normalized collection' });
    forgedCollection.mutation.parentId = ROOT_ID;
    await executeMutation(forgedCollection);
    const collectionEvidence = await runtime.pool.query(
      `select payload.payload_json->'parentId' parent_id
       from operations operation join operation_payloads payload using (operation_id)
       where operation.operation_id = $1`,
      [collectionId],
    );
    assert.equal(collectionEvidence.rows[0].parent_id, null);
    await assertRoutableOutbox([collectionId]);
  }, 30_000);

  test('rejects a trigger-corrupted target relational field while payload remains unchanged', async () => {
    await resetFixture();
    await runtime.pool.query(`
      create function canonical_adapter_corrupt_target_metadata() returns trigger language plpgsql as $$
      begin
        if new.id = '${COLLECTION_ID}' then new.root_node_id = '${NODE_ID}'; end if;
        return new;
      end $$;
      create trigger canonical_adapter_corrupt_target_metadata before update on collections
      for each row execute function canonical_adapter_corrupt_target_metadata()
    `);
    try {
      await assert.rejects(
        executeMutation(collectionMutation(
          '41414141-4141-4141-8141-414141414141', { title: 'Intended title' }, 'collection-r1',
        )),
        (error: unknown) => error instanceof CanonicalMutationInvariantError
          && error.code === 'resource_field_authority_violation',
      );
    } finally {
      await runtime.pool.query('drop trigger canonical_adapter_corrupt_target_metadata on collections');
      await runtime.pool.query('drop function canonical_adapter_corrupt_target_metadata()');
    }
    const evidence = await runtime.pool.query(
      `select c.title collection_title, c.commit_ordinal::text ordinal,
              n.title node_title, n.resource_revision node_revision,
              (select count(*)::int from operations) operations,
              (select count(*)::int from outbox_events) outbox,
              (select count(*)::int from product_command_receipts) receipts
       from collections c join nodes n on n.id = $2 where c.id = $1`,
      [COLLECTION_ID, NODE_ID],
    );
    assert.deepEqual(evidence.rows[0], {
      collection_title: 'Canonical', ordinal: '1', node_title: 'Before', node_revision: 'node-r1',
      operations: 0, outbox: 0, receipts: 0,
    });
  });

  test('requires every authoritative UPDATE to affect exactly one row', async () => {
    await resetFixture();
    await runtime.pool.query(`
      create function canonical_adapter_suppress_collection_update() returns trigger language plpgsql as $$
      begin return null; end $$;
      create trigger canonical_adapter_suppress_collection_update before update on collections
      for each row execute function canonical_adapter_suppress_collection_update()
    `);
    try {
      await assert.rejects(
        executeMutation(collectionMutation(
          '43434343-4343-4343-8343-434343434343', { title: 'Suppressed' }, 'collection-r1',
        )),
        /updated 0 rows instead of one/,
      );
    } finally {
      await runtime.pool.query('drop trigger canonical_adapter_suppress_collection_update on collections');
      await runtime.pool.query('drop function canonical_adapter_suppress_collection_update()');
    }
    const evidence = await runtime.pool.query(
      `select title, commit_ordinal::text ordinal,
              (select count(*)::int from operations) operations,
              (select count(*)::int from product_command_receipts) receipts
       from collections where id = $1`, [COLLECTION_ID],
    );
    assert.deepEqual(evidence.rows[0], { title: 'Canonical', ordinal: '1', operations: 0, receipts: 0 });
  });

  test('authority validation and read-back mismatch each roll back the unit of work', async () => {
    await resetFixture();
    await assert.rejects(
      executeMutation(collectionMutation(
        'dddddddd-dddd-4ddd-8ddd-dddddddddddd', { resourceRevision: 'forbidden' }, 'collection-r1',
      )),
      (error: unknown) => error instanceof CanonicalMutationInvariantError
        && error.code === 'resource_field_authority_violation',
    );

    await runtime.pool.query(`
      create function canonical_adapter_corrupt_payload() returns trigger language plpgsql as $$
      begin
        if new.id = '${NODE_ID}' and new.payload_json is not null then
          new.payload_json = jsonb_set(new.payload_json, '{title}', '"corrupted"'::jsonb);
        end if;
        return new;
      end $$;
      create trigger canonical_adapter_corrupt_payload before update on nodes
      for each row execute function canonical_adapter_corrupt_payload()
    `);
    try {
      await assert.rejects(
        executeMutation(mutation('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee')),
        (error: unknown) => error instanceof CanonicalMutationInvariantError
          && error.code === 'resource_field_authority_violation',
      );
    } finally {
      await runtime.pool.query('drop trigger canonical_adapter_corrupt_payload on nodes');
      await runtime.pool.query('drop function canonical_adapter_corrupt_payload()');
    }
    const state = await runtime.pool.query(
      `select n.title, n.resource_revision, c.commit_ordinal::text ordinal,
              (select count(*)::int from operations) operations,
              (select count(*)::int from outbox_events) outbox
       from nodes n join collections c on c.id = n.collection_id where n.id = $1`,
      [NODE_ID],
    );
    assert.deepEqual(state.rows[0], {
      title: 'Before', resource_revision: 'node-r1', ordinal: '1', operations: 0, outbox: 0,
    });
  });

  test.each([
    { label: 'parent children revision', operationId: '18181818-1818-4818-8818-181818181818', table: 'nodes', column: 'children_revision', predicate: `new.id = '${ROOT_ID}'`, assignment: "new.children_revision = 'trigger-corrupted'", input: 'create' },
    { label: 'collection commit ordinal', operationId: '24242424-2424-4424-8424-242424242429', table: 'collections', column: 'commit_ordinal', predicate: `new.id = '${COLLECTION_ID}'`, assignment: 'new.commit_ordinal = new.commit_ordinal + 100', input: 'update' },
  ])('rejects trigger-corrupted $label relational authority and fully rolls back', async ({
    operationId, table, column, predicate, assignment, input,
  }) => {
    await resetFixture();
    const functionName = `canonical_adapter_corrupt_${column}`;
    await runtime.pool.query(`
      create function ${functionName}() returns trigger language plpgsql as $$
      begin
        if ${predicate} then ${assignment}; end if;
        return new;
      end $$;
      create trigger ${functionName} before insert or update on ${table}
      for each row execute function ${functionName}()
    `);
    try {
      await assert.rejects(
        executeMutation(input === 'create'
          ? nodeMutation(operationId, 'create', 'revision-trigger-created-node', ROOT_ID)
          : mutation(operationId)),
        (error: unknown) => error instanceof CanonicalMutationInvariantError
          && error.code === 'resource_field_authority_violation',
      );
    } finally {
      await runtime.pool.query(`drop trigger ${functionName} on ${table}`);
      await runtime.pool.query(`drop function ${functionName}()`);
    }
    const state = await runtime.pool.query(
      `select n.title, n.resource_revision, root.children_revision,
              c.content_revision, c.policy_revision, c.commit_ordinal::text ordinal,
              (select count(*)::int from resource_revisions) resource_revisions,
              (select count(*)::int from children_revisions) children_revisions,
              (select count(*)::int from content_revisions) content_revisions,
              (select count(*)::int from policy_revisions) policy_revisions,
              (select count(*)::int from operations) operations,
              (select count(*)::int from audit_events) audit,
              (select count(*)::int from outbox_events) outbox,
              (select count(*)::int from product_command_receipts) receipts
       from nodes n join nodes root on root.id = $2
       join collections c on c.id = n.collection_id where n.id = $1`,
      [NODE_ID, ROOT_ID],
    );
    assert.deepEqual(state.rows[0], {
      title: 'Before', resource_revision: 'node-r1', children_revision: 'root-children-r1',
      content_revision: 'content-r1', policy_revision: 'policy-r1', ordinal: '1',
      resource_revisions: 0, children_revisions: 0, content_revisions: 0,
      policy_revisions: 0, operations: 0, audit: 0, outbox: 0, receipts: 0,
    });
  });

  test('concurrent collection mutations serialize commit ordinals without lost evidence', async () => {
    await resetFixture();
    let releaseFirst!: () => void;
    const releaseBarrier = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let firstHoldingLock!: () => void;
    const firstHoldingLockBarrier = new Promise<void>((resolve) => { firstHoldingLock = resolve; });
    let secondEnteredTransaction!: () => void;
    const secondEnteredBarrier = new Promise<void>((resolve) => { secondEnteredTransaction = resolve; });

    const first = createPostgresCanonicalMutationUnitOfWork(runtime.db).execute(async (ports) => {
      const operationId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
      const binding = { principalId: PRINCIPAL_ID, commandScope: 'collection:update', commandId: operationId };
      assert.equal((await ports.receipts.claim(binding, `fp-${operationId}`)).kind, 'claimed');
      const result = await ports.canonical.execute(collectionMutation(operationId, { title: 'Concurrent A' }));
      firstHoldingLock();
      await releaseBarrier;
      await ports.receipts.complete(binding, `fp-${operationId}`, {
        status: 200, body: Buffer.from('{}'), stableHeaders: {}, mediaType: 'application/json', contractVersion: '1.0.0',
        targetIdentity: COLLECTION_ID,
      });
      return result;
    });
    await firstHoldingLockBarrier;
    const second = createPostgresCanonicalMutationUnitOfWork(runtime.db).execute(async (ports) => {
      const operationId = '12121212-1212-4212-8212-121212121212';
      const binding = { principalId: PRINCIPAL_ID, commandScope: 'collection:update', commandId: operationId };
      assert.equal((await ports.receipts.claim(binding, `fp-${operationId}`)).kind, 'claimed');
      secondEnteredTransaction();
      const result = await ports.canonical.execute(collectionMutation(operationId, { summary: 'Concurrent B' }));
      await ports.receipts.complete(binding, `fp-${operationId}`, {
        status: 200, body: Buffer.from('{}'), stableHeaders: {}, mediaType: 'application/json', contractVersion: '1.0.0',
        targetIdentity: COLLECTION_ID,
      });
      return result;
    });
    await secondEnteredBarrier;
    let blocked = 0;
    const observedBackends: {
      pid: number; state: string; wait_event_type: string | null; wait_event: string | null; query_tag: string;
    }[] = [];
    let conditionFailure: unknown;
    try {
      // The second mutation can take a moment to reach its lock wait under V8
      // coverage instrumentation. A shared condition wait owns the deadline
      // and polling cadence; on timeout, capture live backends with sanitized
      // query tags (command word only) so failures stay diagnosable without
      // dumping mutation payloads. The replica gate is taken before the
      // collection row, and lock_timeout is 5s, so the probe has to see the
      // advisory wait or the second command is cancelled first.
      try {
        await waitForCondition(async () => {
          const observed = await runtime.pool.query<{ blocked: number }>(
            `select count(*)::int blocked from pg_stat_activity
             where application_name = 'known-canonical-adapter-test'
               and wait_event_type = 'Lock'
               and (query ilike '%collections%' or query ilike '%pg_advisory_xact_lock%')`,
          );
          blocked = observed.rows[0]!.blocked;
          return blocked > 0;
        }, {
          timeoutMs: 10_000,
          pollIntervalMs: 50,
          description: 'the second canonical mutation to wait on the collection lock',
        });
      } catch (error) {
        conditionFailure = error;
      }
      if (blocked === 0) {
        const backends = await runtime.pool.query<{
          pid: number; state: string; wait_event_type: string | null; wait_event: string | null; query_tag: string;
        }>(
          `select pid, state, wait_event_type, wait_event,
                  split_part(btrim(left(query, 200)), ' ', 1) as query_tag
           from pg_stat_activity
           where application_name = 'known-canonical-adapter-test'
           order by pid`,
        );
        observedBackends.push(...backends.rows);
      }
    } finally {
      releaseFirst();
    }
    const results = await Promise.all([first, second]);
    assert.equal(
      blocked,
      1,
      `expected the second canonical mutation to wait on the collection lock; wait result: ${String(conditionFailure)}; observed backends: ${JSON.stringify(observedBackends)}`,
    );
    assert.deepEqual(results.map((result) => result.allocation.commitOrdinal).sort(), [2n, 3n]);
    const state = await runtime.pool.query(
      `select title, summary, commit_ordinal::text ordinal,
              (select count(*)::int from operations) operations,
              (select count(*)::int from resource_revisions) resource_revisions,
              (select count(*)::int from outbox_events) outbox
       from collections where id = $1`,
      [COLLECTION_ID],
    );
    assert.deepEqual(state.rows[0], {
      title: 'Concurrent A', summary: 'Concurrent B', ordinal: '3', operations: 2, resource_revisions: 2, outbox: 6,
    });
  }, 30_000);

});
