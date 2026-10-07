/**
 * Task 12: durable Phase 1 collection mutation projection against real PostgreSQL.
 * Covers create/update/node/move/delete materialisation, replay idempotency,
 * out-of-order fencing, crash between projection and outbox completion, and restart.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, test } from 'vitest';
import { Pool } from 'pg';
import { runMigrations, createDatabaseRuntime, type DatabaseRuntime } from '../../../src/infrastructure/database/index.js';
import {
  COLLECTION_CREATED_EVENT_VERSION_N,
  COLLECTION_CREATED_EVENT_VERSION_N_PLUS,
  OutboxRouter,
  PostgresCollectionMutationProjectionSink,
  PostgresOutboxRepository,
  VersionedOutboxWorker,
  createCollectionMutationEnvelopeRegistry,
  createProductionCollectionMutationOutboxRouter,
  type CollectionMutationDelivery,
  type OutboxWorkerLogger,
} from '../../../src/infrastructure/outbox/index.js';
import {
  ANNOTATION_DELETED_EVENT_TYPE,
  ANNOTATION_DELETED_HANDLER_NAME,
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
  NODE_UPDATED_EVENT_TYPE,
  NODE_UPDATED_HANDLER_NAME,
} from '../../../src/modules/collections/index.js';
import {
  buildWorker,
  resolveProductionProjectionSink,
} from '../../../src/bootstrap/worker.js';
import { loadConfig } from '../../support/test-config.js';
import {
  configuredTestDatabaseUrl,
  describeWithPostgres,
} from '../../support/postgres-test-runtime.js';

const logger: OutboxWorkerLogger = {
  info() {},
  warn() {},
  error() {},
};

describeWithPostgres('PostgreSQL collection mutation projection (Task 12)', () => {
  const databaseUrl = configuredTestDatabaseUrl();
  const schema = `cmp_${randomUUID().replaceAll('-', '_')}`;
  let admin: Pool;
  let runtime: DatabaseRuntime;
  let sink: PostgresCollectionMutationProjectionSink;
  let outboxRepository: PostgresOutboxRepository;

  beforeAll(async () => {
    assert.ok(databaseUrl, 'KNOWN_TEST_DATABASE_URL or DATABASE_URL is required');
    admin = new Pool({ connectionString: databaseUrl, max: 1 });
    await admin.query(`create schema ${schema}`);
    const isolated = new URL(databaseUrl);
    isolated.searchParams.set('options', `-c search_path=${schema}`);
    const migrationRuntime = createDatabaseRuntime(isolated.toString(), {
      maxConnections: 1,
      applicationName: 'known-cmp-migration-test',
    });
    await runMigrations(migrationRuntime.db, 'latest');
    await migrationRuntime.close();
    runtime = createDatabaseRuntime(isolated.toString(), {
      maxConnections: 4,
      applicationName: 'known-cmp-integration-test',
    });
    sink = new PostgresCollectionMutationProjectionSink(runtime.pool);
    outboxRepository = new PostgresOutboxRepository(runtime.pool);
  });

  afterAll(async () => {
    await runtime?.close();
    await admin?.query(`drop schema if exists ${schema} cascade`);
    await admin?.end();
  });

  function delivery(partial: {
    readonly eventId: string;
    readonly eventType: string;
    readonly eventVersion?: number;
    readonly handlerName: string;
    readonly aggregateId: string;
    readonly aggregateScope?: string;
    readonly commitOrdinal: string;
    readonly payload: Record<string, unknown>;
  }): CollectionMutationDelivery {
    return {
      eventId: partial.eventId,
      eventType: partial.eventType,
      eventVersion: partial.eventVersion ?? 1,
      handlerName: partial.handlerName,
      idempotencyKey: partial.eventId,
      aggregateId: partial.aggregateId,
      aggregateScope: partial.aggregateScope ?? partial.aggregateId,
      commitOrdinal: partial.commitOrdinal,
      payload: partial.payload,
      aggregateRevision: 'rev-1',
      occurredAt: '2026-07-22T12:00:00.000Z',
    };
  }

  async function insertOutboxRow(input: {
    readonly outboxId: string;
    readonly eventId: string;
    readonly eventType: string;
    readonly eventVersion?: number;
    readonly handlerName: string;
    readonly aggregateId: string;
    readonly aggregateScope?: string;
    readonly commitOrdinal: number;
    readonly payload: Record<string, unknown>;
  }): Promise<void> {
    await runtime.pool.query(
      `insert into resource_id_ledger(resource_id, resource_type)
       values ($1, 'outbox'), ($2, 'domain-event')
       on conflict (resource_id) do nothing`,
      [input.outboxId, input.eventId],
    );
    await runtime.pool.query(
      `insert into outbox_events(
         outbox_id, domain_event_id, event_type, event_version, handler_name, handler_mode,
         aggregate_type, aggregate_id, aggregate_scope, aggregate_revision, commit_ordinal,
         occurred_at, payload_json, available_at
       ) values (
         $1, $2, $3, $4, $5, 'projection_latest_only',
         'collection', $6, $7, 'rev-1', $8,
         current_timestamp, $9::jsonb, current_timestamp
       )`,
      [
        input.outboxId,
        input.eventId,
        input.eventType,
        input.eventVersion ?? 1,
        input.handlerName,
        input.aggregateId,
        input.aggregateScope ?? input.aggregateId,
        input.commitOrdinal,
        JSON.stringify(input.payload),
      ],
    );
  }

  function makeWorker() {
    const routes = createProductionCollectionMutationOutboxRouter({ sink }).listRoutes();
    return new VersionedOutboxWorker({
      repository: outboxRepository,
      router: new OutboxRouter(routes),
      envelopes: createCollectionMutationEnvelopeRegistry(),
      logger,
      leaseDurationMs: 10_000,
      heartbeatIntervalMs: 5_000,
      acknowledgeTransientSideEffects: false,
    });
  }

  test('migration creates durable projection tables', async () => {
    const result = await runtime.pool.query<{
      applied_table: string | null;
      resources_table: string | null;
      watermarks_table: string | null;
    }>(`
      select
        to_regclass('collection_mutation_projection_applied')::text as applied_table,
        to_regclass('collection_mutation_projection_resources')::text as resources_table,
        to_regclass('collection_mutation_projection_watermarks')::text as watermarks_table
    `);
    assert.equal(result.rows[0]?.applied_table, 'collection_mutation_projection_applied');
    assert.equal(result.rows[0]?.resources_table, 'collection_mutation_projection_resources');
    assert.equal(result.rows[0]?.watermarks_table, 'collection_mutation_projection_watermarks');
  });

  test('annotation.deleted@1 marks the projected Annotation tombstone and replays idempotently', async () => {
    const collectionId = `collection-annotation-delete-${randomUUID()}`;
    const annotationId = `annotation-delete-${randomUUID()}`;
    const eventId = `event-annotation-delete-${randomUUID()}`;
    const value = delivery({
      eventId,
      eventType: ANNOTATION_DELETED_EVENT_TYPE,
      handlerName: ANNOTATION_DELETED_HANDLER_NAME,
      aggregateId: annotationId,
      aggregateScope: collectionId,
      commitOrdinal: '11',
      payload: {
        affectedCount: 1, annotationId, collectionId, contentRevision: 'content-11',
        deletedAt: '2026-07-25T02:00:00Z', deleteRevision: 'annotation-r11',
        operationId: 'operation-annotation-delete', subjectId: 'node-1',
        subjectType: 'node', visibility: 'protected',
      },
    });
    await sink.apply(value);
    await sink.apply(value);
    const row = await sink.repository.getResource(collectionId, 'annotation', annotationId);
    assert.ok(row);
    assert.equal(row.deleted, true);
    assert.equal(row.lastEventType, ANNOTATION_DELETED_EVENT_TYPE);
    assert.equal(row.lastCommitOrdinal, '11');
  });

  test('production worker default wires the durable PostgreSQL sink', () => {
    const resolved = resolveProductionProjectionSink({ database: runtime });
    assert.ok(resolved instanceof PostgresCollectionMutationProjectionSink);
    assert.equal(resolved.durability, 'durable');

    const worker = buildWorker(
      loadConfig({ DATABASE_URL: databaseUrl!, LOG_LEVEL: 'silent',
        OIDC_JWKS_URI: 'https://issuer.example/realms/known/certs' }),
      runtime,
    );
    assert.ok(worker.outbox);
    assert.ok(worker.projectionSink instanceof PostgresCollectionMutationProjectionSink);
    assert.equal(worker.projectionSink.durability, 'durable');
    const readiness = worker.outbox!.projectionReadiness();
    assert.equal(readiness.allDurable, true);
    assert.ok(readiness.routeCount >= 6);
    assert.equal(readiness.transientCount, 0);
    assert.equal(readiness.acknowledgesTransientSideEffects, false);
  });

  test('projects create/update/node/move/delete and survives process restart observation', async () => {
    const collectionId = `col-${randomUUID()}`;
    const rootNodeId = `root-${randomUUID()}`;
    const childNodeId = `node-${randomUUID()}`;
    const folderId = `folder-${randomUUID()}`;

    // create collection
    await sink.apply(delivery({
      eventId: `evt-create-${collectionId}`,
      eventType: COLLECTION_CREATED_EVENT_TYPE,
      eventVersion: COLLECTION_CREATED_EVENT_VERSION_N,
      handlerName: COLLECTION_CREATED_HANDLER_NAME,
      aggregateId: collectionId,
      commitOrdinal: '1',
      payload: {
        collectionId,
        kind: 'bookmarks',
        ownerSubjectId: 'subject-1',
        rootNodeId,
      },
    }));

    // collection.created@2 expand sibling still materialises
    await sink.apply(delivery({
      eventId: `evt-create-v2-${collectionId}`,
      eventType: COLLECTION_CREATED_EVENT_TYPE,
      eventVersion: COLLECTION_CREATED_EVENT_VERSION_N_PLUS,
      handlerName: COLLECTION_CREATED_HANDLER_NAME,
      aggregateId: collectionId,
      commitOrdinal: '2',
      payload: {
        collectionId,
        kind: 'bookmarks',
        ownerSubjectId: 'subject-1',
        rootNodeId,
        title: 'Titled List',
      },
    }));

    await sink.apply(delivery({
      eventId: `evt-update-${collectionId}`,
      eventType: COLLECTION_UPDATED_EVENT_TYPE,
      handlerName: COLLECTION_UPDATED_HANDLER_NAME,
      aggregateId: collectionId,
      commitOrdinal: '3',
      payload: {
        collectionId,
        contentRevision: 'cr-3',
        resourceRevision: 'rr-3',
        summary: 'updated',
        title: 'Updated Title',
      },
    }));

    await sink.apply(delivery({
      eventId: `evt-node-create-${childNodeId}`,
      eventType: NODE_CREATED_EVENT_TYPE,
      handlerName: NODE_CREATED_HANDLER_NAME,
      aggregateId: collectionId,
      commitOrdinal: '4',
      payload: {
        collectionId,
        contentRevision: 'cr-4',
        kind: 'bookmark',
        nodeId: childNodeId,
        parentChildrenRevision: 'pcr-4',
        parentId: rootNodeId,
        policyRevision: 'pr-4',
        resourceRevision: 'nrr-4',
      },
    }));

    await sink.apply(delivery({
      eventId: `evt-node-update-${childNodeId}`,
      eventType: NODE_UPDATED_EVENT_TYPE,
      handlerName: NODE_UPDATED_HANDLER_NAME,
      aggregateId: collectionId,
      commitOrdinal: '5',
      payload: {
        collectionId,
        contentRevision: 'cr-5',
        kind: 'bookmark',
        nodeId: childNodeId,
        policyRevision: 'pr-5',
        resourceRevision: 'nrr-5',
      },
    }));

    await sink.apply(delivery({
      eventId: `evt-node-move-${childNodeId}`,
      eventType: NODE_MOVED_EVENT_TYPE,
      handlerName: NODE_MOVED_HANDLER_NAME,
      aggregateId: collectionId,
      commitOrdinal: '6',
      payload: {
        collectionId,
        contentRevision: 'cr-6',
        kind: 'bookmark',
        nodeId: childNodeId,
        policyRevision: 'pr-6',
        resourceRevision: 'nrr-6',
        sourceChildrenRevision: 'scr-6',
        sourceParentId: rootNodeId,
        targetChildrenRevision: 'tcr-6',
        targetParentId: folderId,
      },
    }));

    await sink.apply(delivery({
      eventId: `evt-node-delete-${childNodeId}`,
      eventType: NODE_DELETED_EVENT_TYPE,
      handlerName: NODE_DELETED_HANDLER_NAME,
      aggregateId: collectionId,
      commitOrdinal: '7',
      payload: {
        affectedCount: 1,
        collectionId,
        contentRevision: 'cr-7',
        kind: 'bookmark',
        nodeId: childNodeId,
        parentChildrenRevision: 'pcr-7',
        parentId: folderId,
        policyRevision: 'pr-7',
        scope: 'single',
      },
    }));

    // New repository instance = restarted worker observing durable projection.
    const restarted = new PostgresCollectionMutationProjectionSink(runtime.pool);
    const collection = await restarted.repository.getResource(
      collectionId, 'collection', collectionId,
    );
    assert.ok(collection);
    assert.equal(collection.lastEventType, COLLECTION_UPDATED_EVENT_TYPE);
    assert.equal(collection.lastCommitOrdinal, '3');
    assert.equal((collection.stateJson as { title?: string }).title, 'Updated Title');
    assert.equal(collection.deleted, false);

    const node = await restarted.repository.getResource(collectionId, 'node', childNodeId);
    assert.ok(node);
    assert.equal(node.lastEventType, NODE_DELETED_EVENT_TYPE);
    assert.equal(node.deleted, true);
    assert.equal(node.lastCommitOrdinal, '7');
    assert.equal((node.stateJson as { targetParentId?: string }).targetParentId, undefined);
    assert.equal((node.stateJson as { parentId?: string }).parentId, folderId);

    const resources = await restarted.repository.listResources(collectionId);
    assert.equal(resources.length, 2);

    const createdApplied = await restarted.repository.getApplied(
      COLLECTION_CREATED_HANDLER_NAME,
      `evt-create-v2-${collectionId}`,
    );
    assert.ok(createdApplied);
    assert.equal(createdApplied.eventVersion, COLLECTION_CREATED_EVENT_VERSION_N_PLUS);
    assert.equal(createdApplied.disposition, 'applied');
  });

  test('replay is idempotent and does not double-materialise', async () => {
    const collectionId = `col-replay-${randomUUID()}`;
    const d = delivery({
      eventId: `evt-replay-${collectionId}`,
      eventType: COLLECTION_CREATED_EVENT_TYPE,
      handlerName: COLLECTION_CREATED_HANDLER_NAME,
      aggregateId: collectionId,
      commitOrdinal: '10',
      payload: {
        collectionId,
        kind: 'bookmarks',
        ownerSubjectId: 'subject-replay',
        rootNodeId: 'root-replay',
      },
    });

    const first = await sink.repository.apply(d);
    const second = await sink.repository.apply(d);
    assert.equal(first, 'applied');
    assert.equal(second, 'replay');

    const count = await runtime.pool.query<{ n: string }>(
      `select count(*)::text as n from collection_mutation_projection_applied
       where handler_name = $1 and domain_event_id = $2`,
      [COLLECTION_CREATED_HANDLER_NAME, d.eventId],
    );
    assert.equal(count.rows[0]?.n, '1');

    const resource = await sink.repository.getResource(collectionId, 'collection', collectionId);
    assert.ok(resource);
    assert.equal(resource.lastDomainEventId, d.eventId);
  });

  test('single node.deleted rejects affectedCount greater than one before projection or acknowledgement', async () => {
    const collectionId = `col-single-count-${randomUUID()}`;
    const eventId = `evt-single-count-${collectionId}`;
    const invalid = delivery({
      eventId,
      eventType: NODE_DELETED_EVENT_TYPE,
      handlerName: NODE_DELETED_HANDLER_NAME,
      aggregateId: collectionId,
      commitOrdinal: '11',
      payload: {
        collectionId,
        nodeId: `node-${collectionId}`,
        scope: 'single',
        affectedCount: 2,
      },
    });
    assert.throws(() => sink.repository.apply(invalid), /invalid node\.deleted scope or affectedCount/);
    assert.equal(await sink.repository.getApplied(NODE_DELETED_HANDLER_NAME, eventId), null);
    assert.equal(
      (await runtime.pool.query(
        'select count(*)::int as count from collection_mutation_projection_resources where collection_id = $1',
        [collectionId],
      )).rows[0]?.count,
      0,
    );
  });

  test('single-resource projection rejects a zero-row conflict update and rolls back evidence', async () => {
    const collectionId = `col-zero-row-${randomUUID()}`;
    const first = delivery({
      eventId: `evt-zero-row-first-${collectionId}`,
      eventType: COLLECTION_UPDATED_EVENT_TYPE,
      handlerName: COLLECTION_UPDATED_HANDLER_NAME,
      aggregateId: collectionId,
      commitOrdinal: '1',
      payload: { collectionId, title: 'before' },
    });
    await sink.apply(first);

    await runtime.pool.query(`
      create function cmp_projection_skip_update() returns trigger
      language plpgsql as $$ begin return null; end $$;
    `);
    await runtime.pool.query(`
      create trigger cmp_projection_skip_update_trigger
      before update on collection_mutation_projection_resources
      for each row execute function cmp_projection_skip_update();
    `);
    try {
      const second = delivery({
        eventId: `evt-zero-row-second-${collectionId}`,
        eventType: COLLECTION_UPDATED_EVENT_TYPE,
        handlerName: COLLECTION_UPDATED_HANDLER_NAME,
        aggregateId: collectionId,
        commitOrdinal: '2',
        payload: { collectionId, title: 'after' },
      });
      await assert.rejects(
        () => sink.apply(second),
        /expected exactly one resource.*materialised 0/i,
      );
      assert.equal(await sink.repository.getApplied(COLLECTION_UPDATED_HANDLER_NAME, second.eventId), null);
      const resource = await sink.repository.getResource(collectionId, 'collection', collectionId);
      assert.ok(resource);
      assert.equal(resource.lastCommitOrdinal, '1');
      assert.equal(resource.lastDomainEventId, first.eventId);
      const watermark = await sink.repository.getWatermark(COLLECTION_UPDATED_HANDLER_NAME, collectionId);
      assert.ok(watermark);
      assert.equal(watermark.lastCommitOrdinal, '1');
    } finally {
      await runtime.pool.query('drop trigger cmp_projection_skip_update_trigger on collection_mutation_projection_resources');
      await runtime.pool.query('drop function cmp_projection_skip_update()');
    }
  });

  test('older create from another handler skips a resource already at a newer ordinal', async () => {
    const collectionId = `col-cross-handler-${randomUUID()}`;
    const updated = delivery({
      eventId: `evt-cross-handler-updated-${collectionId}`,
      eventType: COLLECTION_UPDATED_EVENT_TYPE,
      handlerName: COLLECTION_UPDATED_HANDLER_NAME,
      aggregateId: collectionId,
      commitOrdinal: '20',
      payload: { collectionId, title: 'Published' },
    });
    const created = delivery({
      eventId: `evt-cross-handler-created-${collectionId}`,
      eventType: COLLECTION_CREATED_EVENT_TYPE,
      handlerName: COLLECTION_CREATED_HANDLER_NAME,
      aggregateId: collectionId,
      commitOrdinal: '1',
      payload: { collectionId, title: 'Created' },
    });

    assert.equal(await sink.repository.apply(updated), 'applied');
    assert.equal(await sink.repository.apply(created), 'stale_skipped');

    const resource = await sink.repository.getResource(collectionId, 'collection', collectionId);
    assert.ok(resource);
    assert.equal(resource.lastCommitOrdinal, '20');
    assert.equal(resource.lastDomainEventId, updated.eventId);
    assert.equal((resource.stateJson as { title?: string }).title, 'Published');

    const skipped = await sink.repository.getApplied(COLLECTION_CREATED_HANDLER_NAME, created.eventId);
    assert.ok(skipped);
    assert.equal(skipped.disposition, 'stale_skipped');
    const createdWatermark = await sink.repository.getWatermark(COLLECTION_CREATED_HANDLER_NAME, collectionId);
    assert.ok(createdWatermark);
    assert.equal(createdWatermark.lastCommitOrdinal, '1');
  });

  test('out-of-order lower ordinal is fenced without overwriting newer state', async () => {
    const collectionId = `col-fence-${randomUUID()}`;
    const newer = delivery({
      eventId: `evt-fence-new-${collectionId}`,
      eventType: COLLECTION_UPDATED_EVENT_TYPE,
      handlerName: COLLECTION_UPDATED_HANDLER_NAME,
      aggregateId: collectionId,
      commitOrdinal: '20',
      payload: {
        collectionId,
        contentRevision: 'cr-20',
        resourceRevision: 'rr-20',
        summary: null,
        title: 'Newer',
      },
    });
    const older = delivery({
      eventId: `evt-fence-old-${collectionId}`,
      eventType: COLLECTION_UPDATED_EVENT_TYPE,
      handlerName: COLLECTION_UPDATED_HANDLER_NAME,
      aggregateId: collectionId,
      commitOrdinal: '15',
      payload: {
        collectionId,
        contentRevision: 'cr-15',
        resourceRevision: 'rr-15',
        summary: null,
        title: 'Older',
      },
    });

    assert.equal(await sink.repository.apply(newer), 'applied');
    assert.equal(await sink.repository.apply(older), 'stale_skipped');

    const resource = await sink.repository.getResource(collectionId, 'collection', collectionId);
    assert.ok(resource);
    assert.equal(resource.lastCommitOrdinal, '20');
    assert.equal((resource.stateJson as { title?: string }).title, 'Newer');
    assert.equal(resource.lastDomainEventId, newer.eventId);

    const stale = await sink.repository.getApplied(
      COLLECTION_UPDATED_HANDLER_NAME,
      older.eventId,
    );
    assert.ok(stale);
    assert.equal(stale.disposition, 'stale_skipped');

    const watermark = await sink.repository.getWatermark(
      COLLECTION_UPDATED_HANDLER_NAME,
      collectionId,
    );
    assert.ok(watermark);
    assert.equal(watermark.lastCommitOrdinal, '20');
  });

  test('does not fence an older event for a different node in the same collection', async () => {
    const collectionId = `col-cross-resource-${randomUUID()}`;
    const nodeA = `node-a-${randomUUID()}`;
    const nodeB = `node-b-${randomUUID()}`;
    const makeUpdate = (nodeId: string, ordinal: string) => delivery({
      eventId: `evt-${nodeId}-${ordinal}`,
      eventType: NODE_UPDATED_EVENT_TYPE,
      handlerName: NODE_UPDATED_HANDLER_NAME,
      aggregateId: nodeId,
      aggregateScope: collectionId,
      commitOrdinal: ordinal,
      payload: {
        collectionId,
        contentRevision: `cr-${ordinal}`,
        kind: 'bookmark',
        nodeId,
        policyRevision: `pr-${ordinal}`,
        resourceRevision: `rr-${ordinal}`,
      },
    });

    assert.equal(await sink.repository.apply(makeUpdate(nodeA, '20')), 'applied');
    assert.equal(await sink.repository.apply(makeUpdate(nodeB, '15')), 'applied');

    const [resourceA, resourceB] = await Promise.all([
      sink.repository.getResource(collectionId, 'node', nodeA),
      sink.repository.getResource(collectionId, 'node', nodeB),
    ]);
    assert.equal(resourceA?.lastCommitOrdinal, '20');
    assert.equal(resourceB?.lastCommitOrdinal, '15');
  });

  test('unknown event type is refused and does not acknowledge as applied', async () => {
    await assert.rejects(
      () => sink.apply(delivery({
        eventId: `evt-unknown-${randomUUID()}`,
        eventType: 'collection.unknown_future',
        handlerName: 'collection_unknown_projection',
        aggregateId: 'col-x',
        commitOrdinal: '1',
        payload: { collectionId: 'col-x' },
      })),
      /unknown event type/i,
    );
  });

  test('crash between projection commit and outbox complete is replay-safe', async () => {
    const collectionId = `col-crash-${randomUUID()}`;
    const eventId = `evt-crash-${collectionId}`;
    const outboxId = `outbox-crash-${collectionId}`;
    const payload = {
      collectionId,
      kind: 'bookmarks',
      ownerSubjectId: 'subject-crash',
      rootNodeId: 'root-crash',
    };

    await insertOutboxRow({
      outboxId,
      eventId,
      eventType: COLLECTION_CREATED_EVENT_TYPE,
      handlerName: COLLECTION_CREATED_HANDLER_NAME,
      aggregateId: collectionId,
      commitOrdinal: 1,
      payload,
    });

    // Simulate: durable apply succeeded, then crash before complete.
    await sink.apply(delivery({
      eventId,
      eventType: COLLECTION_CREATED_EVENT_TYPE,
      handlerName: COLLECTION_CREATED_HANDLER_NAME,
      aggregateId: collectionId,
      commitOrdinal: '1',
      payload,
    }));
    const appliedBefore = await sink.repository.getApplied(
      COLLECTION_CREATED_HANDLER_NAME,
      eventId,
    );
    assert.ok(appliedBefore);
    assert.equal(appliedBefore.disposition, 'applied');

    const stateBefore = await runtime.pool.query<{ state: string }>(
      'select state from outbox_events where outbox_id = $1',
      [outboxId],
    );
    assert.equal(stateBefore.rows[0]?.state, 'pending');

    // Restarted worker redelivers; apply is idempotent; complete succeeds.
    const worker = makeWorker();
    assert.equal(await worker.runOnce(), true);

    const stateAfter = await runtime.pool.query<{ state: string }>(
      'select state from outbox_events where outbox_id = $1',
      [outboxId],
    );
    assert.equal(stateAfter.rows[0]?.state, 'completed');

    const appliedAfter = await sink.repository.getApplied(
      COLLECTION_CREATED_HANDLER_NAME,
      eventId,
    );
    assert.ok(appliedAfter);
    assert.equal(appliedAfter.disposition, 'applied');

    const resource = await sink.repository.getResource(collectionId, 'collection', collectionId);
    assert.ok(resource);
    assert.equal(resource.lastDomainEventId, eventId);
  });

  test('end-to-end worker projects supported events and completes only after durable apply', async () => {
    const collectionId = `col-e2e-${randomUUID()}`;
    const nodeId = `node-e2e-${randomUUID()}`;
    const rows = [
      {
        outboxId: `outbox-e2e-c-${collectionId}`,
        eventId: `evt-e2e-c-${collectionId}`,
        eventType: COLLECTION_CREATED_EVENT_TYPE,
        handlerName: COLLECTION_CREATED_HANDLER_NAME,
        aggregateId: collectionId,
        commitOrdinal: 1,
        payload: {
          collectionId,
          kind: 'bookmarks',
          ownerSubjectId: 'subject-e2e',
          rootNodeId: 'root-e2e',
        },
      },
      {
        outboxId: `outbox-e2e-n-${collectionId}`,
        eventId: `evt-e2e-n-${collectionId}`,
        eventType: NODE_CREATED_EVENT_TYPE,
        handlerName: NODE_CREATED_HANDLER_NAME,
        aggregateId: nodeId,
        aggregateScope: collectionId,
        commitOrdinal: 2,
        payload: {
          collectionId,
          contentRevision: 'cr-2',
          kind: 'folder',
          nodeId,
          parentChildrenRevision: 'pcr-2',
          parentId: 'root-e2e',
          policyRevision: 'pr-2',
          resourceRevision: 'rr-2',
        },
      },
    ] as const;

    for (const row of rows) {
      await insertOutboxRow(row);
    }

    const worker = makeWorker();
    assert.equal(await worker.runOnce(), true);
    assert.equal(await worker.runOnce(), true);
    // No more work.
    assert.equal(await worker.runOnce(), false);

    const completed = await runtime.pool.query<{ n: string }>(
      `select count(*)::text as n from outbox_events
       where outbox_id = any($1::text[]) and state = 'completed'`,
      [rows.map((r) => r.outboxId)],
    );
    assert.equal(completed.rows[0]?.n, '2');

    const collection = await sink.repository.getResource(collectionId, 'collection', collectionId);
    const node = await sink.repository.getResource(collectionId, 'node', nodeId);
    assert.ok(collection);
    assert.ok(node);
    assert.equal(collection.lastEventType, COLLECTION_CREATED_EVENT_TYPE);
    assert.equal(node.lastEventType, NODE_CREATED_EVENT_TYPE);
    assert.equal(node.deleted, false);
  });
});
