import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, test } from 'vitest';
import {
  COLLECTION_CREATED_EVENT_TYPE,
  COLLECTION_CREATED_HANDLER_NAME,
  COLLECTION_UPDATED_EVENT_TYPE,
  COLLECTION_UPDATED_HANDLER_NAME,
  NODE_CREATED_EVENT_TYPE,
  NODE_CREATED_HANDLER_NAME,
  NODE_DELETED_EVENT_TYPE,
  NODE_DELETED_HANDLER_NAME,
  NODE_MOVED_EVENT_TYPE,
  NODE_MOVED_HANDLER_NAME,
  NODE_RESTORED_EVENT_TYPE,
  NODE_RESTORED_HANDLER_NAME,
  NODE_UPDATED_EVENT_TYPE,
  NODE_UPDATED_HANDLER_NAME,
} from '../../../src/modules/collections/index.js';
import {
  OutboxRouter,
  PHASE1_MUTATION_EVENT_COMPATIBILITY,
  PostgresCollectionMutationProjectionSink,
  PostgresOutboxRepository,
  VersionedOutboxWorker,
  createCollectionMutationEnvelopeRegistry,
  createCollectionMutationEnvelopeRegistryNMinus1,
  createProductionCollectionMutationOutboxRouter,
  type EventEnvelopeRegistry,
  type OutboxWorkerLogger,
} from '../../../src/infrastructure/outbox/index.js';
import { runMigrations, type DatabaseRuntime } from '../../../src/infrastructure/database/index.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';

const logger: OutboxWorkerLogger = { info() {}, warn() {}, error() {} };

const EVENT_CASES = [
  {
    eventType: COLLECTION_CREATED_EVENT_TYPE,
    handlerName: COLLECTION_CREATED_HANDLER_NAME,
    payload: (id: string) => ({
      collectionId: id, kind: 'bookmarks', ownerSubjectId: 'subject-1', rootNodeId: `root-${id}`,
    }),
  },
  {
    eventType: COLLECTION_UPDATED_EVENT_TYPE,
    handlerName: COLLECTION_UPDATED_HANDLER_NAME,
    payload: (id: string) => ({
      collectionId: id, contentRevision: 'cr-1', resourceRevision: 'rr-1', summary: null, title: 'Title',
    }),
  },
  {
    eventType: NODE_CREATED_EVENT_TYPE,
    handlerName: NODE_CREATED_HANDLER_NAME,
    payload: (id: string) => ({
      collectionId: id, contentRevision: 'cr-1', kind: 'bookmark', nodeId: `node-${id}`,
      parentChildrenRevision: 'pcr-1', parentId: `root-${id}`, policyRevision: 'pr-1',
      resourceRevision: 'rr-1',
    }),
  },
  {
    eventType: NODE_UPDATED_EVENT_TYPE,
    handlerName: NODE_UPDATED_HANDLER_NAME,
    payload: (id: string) => ({
      collectionId: id, contentRevision: 'cr-1', kind: 'bookmark', nodeId: `node-${id}`,
      policyRevision: 'pr-1', resourceRevision: 'rr-1',
    }),
  },
  {
    eventType: NODE_MOVED_EVENT_TYPE,
    handlerName: NODE_MOVED_HANDLER_NAME,
    payload: (id: string) => ({
      collectionId: id, contentRevision: 'cr-1', kind: 'bookmark', nodeId: `node-${id}`,
      policyRevision: 'pr-1', resourceRevision: 'rr-1', sourceChildrenRevision: 'scr-1',
      sourceParentId: `source-${id}`, targetChildrenRevision: 'tcr-1', targetParentId: `target-${id}`,
    }),
  },
  {
    eventType: NODE_DELETED_EVENT_TYPE,
    handlerName: NODE_DELETED_HANDLER_NAME,
    payload: (id: string) => ({
      affectedCount: 1, collectionId: id, contentRevision: 'cr-1', kind: 'bookmark',
      nodeId: `node-${id}`, parentChildrenRevision: 'pcr-1', parentId: `root-${id}`,
      policyRevision: 'pr-1', scope: 'single',
    }),
  },
  {
    // SD-02: restore is a first-class @1 producer event; the N-1 registry
    // intentionally does not accept it until consumers are upgraded.
    eventType: NODE_RESTORED_EVENT_TYPE,
    handlerName: NODE_RESTORED_HANDLER_NAME,
    payload: (id: string) => ({
      collectionId: id, contentRevision: 'cr-1', kind: 'bookmark', nodeId: `node-${id}`,
      parentChildrenRevision: 'pcr-1', parentId: `root-${id}`, policyRevision: 'pr-1',
      resourceRevision: 'rr-1',
    }),
  },
] as const;

describeWithPostgres('Phase 1 Publisher mutation event rollout matrix', () => {
  let isolated: IsolatedPostgresRuntime;
  let runtime: DatabaseRuntime;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('publisher_rollout_compat', {
      maxConnections: 6,
      applicationName: 'known-publisher-rollout-compat-test',
    });
    runtime = isolated.runtime;
    await runMigrations(runtime.db, 'latest');
  });

  afterAll(async () => {
    await isolated?.close();
  });

  async function insertEvent(input: {
    eventType: string;
    eventVersion: number;
    handlerName: string;
    payload: Record<string, unknown>;
  }): Promise<{ outboxId: string; eventId: string }> {
    const outboxId = `outbox-${randomUUID()}`;
    const eventId = `event-${randomUUID()}`;
    const aggregateId = String(input.payload.collectionId);
    await runtime.pool.query(
      `insert into resource_id_ledger(resource_id, resource_type)
       values ($1, 'outbox'), ($2, 'domain-event')`,
      [outboxId, eventId],
    );
    await runtime.pool.query(
      `insert into outbox_events(
         outbox_id, domain_event_id, event_type, event_version, handler_name, handler_mode,
         aggregate_type, aggregate_id, aggregate_scope, aggregate_revision, commit_ordinal,
         occurred_at, payload_json, available_at
       ) values ($1, $2, $3, $4, $5, 'projection_latest_only', 'collection', $6, $6,
                 'rev-1', 1, current_timestamp, $7::jsonb, current_timestamp)`,
      [
        outboxId, eventId, input.eventType, input.eventVersion, input.handlerName,
        aggregateId, JSON.stringify(input.payload),
      ],
    );
    return { outboxId, eventId };
  }

  async function createAuthority(eventCase: typeof EVENT_CASES[number], collectionId: string) {
    const rootId = `root-${collectionId}`;
    const nodeId = `node-${collectionId}`;
    const sourceId = `source-${collectionId}`;
    const targetId = `target-${collectionId}`;
    const client = await runtime.pool.connect();
    try {
      await client.query('begin');
      await client.query('set constraints all deferred');
      await client.query(
      `insert into resource_id_ledger(resource_id, resource_type) values
       ($1, 'collection'), ($2, 'node'), ($3, 'node'), ($4, 'node'), ($5, 'node')`,
      [collectionId, rootId, nodeId, sourceId, targetId],
      );
      await client.query(
      `insert into collections(
         id, owner_subject_id, title, kind, visibility, root_node_id,
         resource_revision, content_revision, policy_revision, commit_ordinal
       ) values ($1, 'subject-1', 'Rollout', 'bookmarks', 'private', $2,
                 'rr-1', 'cr-1', 'pr-1', 1)`,
      [collectionId, rootId],
      );
      await client.query(
      `insert into nodes(
         id, collection_id, parent_id, kind, is_root, title, url, tags,
         visibility, position_token, resource_revision, children_revision,
         deleted_at, deleted_commit_ordinal
       ) values
       ($1, $5, null, 'folder', true, 'Root', null, '[]'::jsonb,
        'inherit', null, 'rr-1', 'pcr-1', null, null),
       ($2, $5, $1, 'bookmark', false, 'Node', 'https://example.test/node', '[]'::jsonb,
        'inherit', 'U', 'rr-1', 'ncr-1', $6, $7),
       ($3, $5, $1, 'folder', false, 'Source', null, '[]'::jsonb,
        'inherit', 'F', 'rr-1', 'scr-1', null, null),
       ($4, $5, $1, 'folder', false, 'Target', null, '[]'::jsonb,
        'inherit', 'V', 'rr-1', 'tcr-1', null, null)`,
      [rootId, nodeId, sourceId, targetId, collectionId,
        eventCase.eventType === NODE_DELETED_EVENT_TYPE ? new Date() : null,
        eventCase.eventType === NODE_DELETED_EVENT_TYPE ? '1' : null],
      );
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }

  function worker(generation: 'current' | 'previous') {
    const nMinus1Only = generation === 'previous';
    const sink = new PostgresCollectionMutationProjectionSink(runtime.pool);
    const routes = createProductionCollectionMutationOutboxRouter({ sink, nMinus1Only }).listRoutes();
    const envelopes: EventEnvelopeRegistry = nMinus1Only
      ? createCollectionMutationEnvelopeRegistryNMinus1()
      : createCollectionMutationEnvelopeRegistry();
    return new VersionedOutboxWorker({
      repository: new PostgresOutboxRepository(runtime.pool),
      router: new OutboxRouter(routes),
      envelopes,
      logger,
      leaseDurationMs: 10_000,
      heartbeatIntervalMs: 5_000,
    });
  }

  test('each consumer generation processes every actual @1 mutation kind it advertises', async () => {
    assert.deepEqual(Object.keys(PHASE1_MUTATION_EVENT_COMPATIBILITY).sort(),
      EVENT_CASES.map((entry) => entry.eventType).sort());

    for (const generation of ['current', 'previous'] as const) {
      const consumer = worker(generation);
      for (const eventCase of EVENT_CASES) {
        // The rollout matrix, not the fixture, decides whether this generation
        // accepts the version: N-1 rejects node.restored@1 until it is upgraded.
        const compatibility = PHASE1_MUTATION_EVENT_COMPATIBILITY[eventCase.eventType];
        assert.ok(compatibility, eventCase.eventType);
        const accepted = generation === 'current'
          || compatibility.previousConsumerVersions.includes(1);
        const collectionId = `collection-${randomUUID()}`;
        await createAuthority(eventCase, collectionId);
        const inserted = await insertEvent({
          eventType: eventCase.eventType,
          eventVersion: 1,
          handlerName: eventCase.handlerName,
          payload: eventCase.payload(collectionId),
        });
        assert.equal(await consumer.runOnce(), true);
        const state = await runtime.pool.query<{ state: string }>(
          'select state from outbox_events where outbox_id = $1',
          [inserted.outboxId],
        );
        assert.equal(state.rows[0]?.state, accepted ? 'completed' : 'retryable',
          `${generation}:${eventCase.eventType}@1`);
        const projected = await runtime.pool.query<{ disposition: string }>(
          `select disposition from collection_mutation_projection_applied
            where handler_name = $1 and domain_event_id = $2`,
          [eventCase.handlerName, inserted.eventId],
        );
        assert.equal(projected.rows[0]?.disposition, accepted ? 'applied' : undefined,
          `${generation}:${eventCase.eventType}@1`);
      }
    }
  });

  test('new consumer accepts collection.created@2 while previous and future versions fail closed', async () => {
    const collectionId = `collection-${randomUUID()}`;
    await createAuthority(EVENT_CASES[0], collectionId);
    const v2 = await insertEvent({
      eventType: COLLECTION_CREATED_EVENT_TYPE,
      eventVersion: 2,
      handlerName: COLLECTION_CREATED_HANDLER_NAME,
      payload: {
        ...EVENT_CASES[0].payload(collectionId),
        title: 'Expanded title',
      },
    });
    assert.equal(await worker('previous').runOnce(), true);
    let state = await runtime.pool.query<{ state: string }>(
      'select state from outbox_events where outbox_id = $1', [v2.outboxId],
    );
    assert.equal(state.rows[0]?.state, 'retryable');
    assert.equal((await runtime.pool.query(
      'select 1 from collection_mutation_projection_applied where domain_event_id = $1',
      [v2.eventId],
    )).rowCount, 0);

    await runtime.pool.query(
      'update outbox_events set available_at = current_timestamp where outbox_id = $1',
      [v2.outboxId],
    );
    assert.equal(await worker('current').runOnce(), true);
    state = await runtime.pool.query<{ state: string }>(
      'select state from outbox_events where outbox_id = $1', [v2.outboxId],
    );
    assert.equal(state.rows[0]?.state, 'completed');
    assert.equal((await runtime.pool.query(
      'select 1 from collection_mutation_projection_applied where domain_event_id = $1',
      [v2.eventId],
    )).rowCount, 1);

    const futureCollectionId = `collection-${randomUUID()}`;
    await createAuthority(EVENT_CASES[3], futureCollectionId);
    const future = await insertEvent({
      eventType: NODE_UPDATED_EVENT_TYPE,
      eventVersion: 99,
      handlerName: NODE_UPDATED_HANDLER_NAME,
      payload: EVENT_CASES[3].payload(futureCollectionId),
    });
    assert.equal(await worker('current').runOnce(), true);
    const futureState = await runtime.pool.query<{ state: string; completed_at: Date | null }>(
      'select state, completed_at from outbox_events where outbox_id = $1', [future.outboxId],
    );
    assert.equal(futureState.rows[0]?.state, 'retryable');
    assert.equal(futureState.rows[0]?.completed_at, null);
    assert.equal((await runtime.pool.query(
      'select 1 from collection_mutation_projection_applied where domain_event_id = $1',
      [future.eventId],
    )).rowCount, 0);
  });
});
