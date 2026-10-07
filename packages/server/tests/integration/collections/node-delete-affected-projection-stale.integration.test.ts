/**
 * P1-7: subtree delete projection follows immutable affected-resource facts.
 * Real PostgreSQL only. A live tombstone is not the target list.
 */
import assert from 'node:assert/strict';
import { afterAll, beforeAll, test } from 'vitest';
import { runMigrations, type DatabaseRuntime } from '../../../src/infrastructure/database/index.js';
import {
  kyselyAffectedFactExecutor,
  persistNodeDeleteAffectedFacts,
} from '../../../src/infrastructure/collections/canonical-node-delete-affected-facts.js';
import { appendOperationWithPayload } from '../../../src/infrastructure/database/operation-payload-store.js';
import { PostgresCollectionMutationProjectionSink } from '../../../src/infrastructure/outbox/postgres-collection-mutation-projection.js';
import {
  NODE_DELETED_EVENT_TYPE,
  NODE_DELETED_HANDLER_NAME,
  NODE_UPDATED_EVENT_TYPE,
  NODE_UPDATED_HANDLER_NAME,
} from '../../../src/modules/collections/index.js';
import type { CollectionMutationDelivery } from '../../../src/infrastructure/outbox/collection-mutation-events.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';

describeWithPostgres('node delete affected-resource facts', () => {
  let isolated: IsolatedPostgresRuntime;
  let runtime: DatabaseRuntime;
  let sink: PostgresCollectionMutationProjectionSink;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('p17_delete_facts', {
      maxConnections: 4,
      applicationName: 'known-p17-delete-facts',
    });
    runtime = isolated.runtime;
    await runMigrations(runtime.db, 'latest');
    sink = new PostgresCollectionMutationProjectionSink(runtime.pool);
  });

  afterAll(async () => {
    await isolated?.close();
  });

  test('resources already at a newer ordinal are stale-skipped and the watermark still advances', async () => {
    const collectionId = 'p17-stale-collection';
    const rootId = 'p17-stale-root';
    const ownerId = 'p17-stale-owner';
    const operationId = '17171717-1717-4171-8171-171717171702';
    const ids = ['stale-0', 'stale-1', 'stale-2'];
    const client = await runtime.pool.connect();
    try {
      await client.query('begin');
      await client.query(
        `insert into accounts(id, subject_id, status, security_epoch) values ($1, $1, 'active', 0)`,
        [ownerId],
      );
      await client.query(
        `insert into profiles(account_id, display_name, avatar_url) values ($1, 'Stale owner', null)`,
        [ownerId],
      );
      await client.query(
        `insert into resource_id_ledger (resource_id, resource_type) values
         ($1, 'collection'), ($2, 'node'), ($3, 'operation')`,
        [collectionId, rootId, operationId],
      );
      await client.query(
        `insert into collections (
           id, owner_subject_id, title, summary, kind, visibility, root_node_id,
           resource_revision, content_revision, policy_revision, commit_ordinal
         ) values ($1, $2, 'Stale', null, 'bookmarks', 'private', $3,
           'collection-r1', 'content-r1', 'policy-r1', 1)`,
        [collectionId, ownerId, rootId],
      );
      await client.query(
        `insert into nodes (
           id, collection_id, parent_id, kind, is_root, title, url, description, tags,
           visibility, position_token, resource_revision, children_revision
         ) values (
           $1, $2, null, 'folder', true, 'Stale', null, null, '[]'::jsonb,
           'inherit', null, 'root-r1', 'root-children-r1'
         )`,
        [rootId, collectionId],
      );
      await client.query('commit');
    } catch (error: unknown) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
    await runtime.db.transaction().execute(async (tx) => {
      await appendOperationWithPayload(tx, {
        operationId,
        collectionId,
        commitOrdinal: 9002n,
        operationType: 'resource.delete',
        payloadJson: { note: 'stale fixture' },
        actorPrincipalId: ownerId,
      });
      await persistNodeDeleteAffectedFacts(kyselyAffectedFactExecutor(tx), {
        collectionId,
        commitOrdinal: 9002n,
        rootNodeId: ids[0]!,
        operationId,
        resourceIds: ids,
      });
    });
    for (const resourceId of ids) {
      assert.equal(await sink.repository.apply({
        eventId: `p17-newer-${resourceId}`,
        eventType: NODE_UPDATED_EVENT_TYPE,
        eventVersion: 1,
        handlerName: NODE_UPDATED_HANDLER_NAME,
        idempotencyKey: `p17-newer-${resourceId}`,
        aggregateId: resourceId,
        aggregateScope: collectionId,
        commitOrdinal: '99999',
        payload: { collectionId, nodeId: resourceId, title: 'kept' },
        aggregateRevision: 'rev-1',
        occurredAt: '2026-10-03T00:00:00.000Z',
      }), 'applied');
    }
    const delivery: CollectionMutationDelivery = {
      eventId: 'p17-stale-event',
      eventType: NODE_DELETED_EVENT_TYPE,
      eventVersion: 1,
      handlerName: NODE_DELETED_HANDLER_NAME,
      idempotencyKey: 'p17-stale-event',
      aggregateId: ids[0]!,
      aggregateScope: collectionId,
      commitOrdinal: '9002',
      payload: {
        affectedCount: 3,
        collectionId,
        contentRevision: 'content-r1',
        kind: 'folder',
        nodeId: ids[0],
        parentChildrenRevision: 'parent-children',
        parentId: rootId,
        policyRevision: 'policy-r1',
        scope: 'subtree',
      },
      aggregateRevision: 'rev-1',
      occurredAt: '2026-10-03T00:00:00.000Z',
    };
    assert.equal(await sink.repository.apply(delivery), 'stale_skipped');
    const restarted = new PostgresCollectionMutationProjectionSink(runtime.pool);
    for (const resourceId of ids) {
      const resource = await restarted.repository.getResource(collectionId, 'node', resourceId);
      assert.ok(resource);
      assert.equal(resource.deleted, false);
      assert.equal(resource.lastCommitOrdinal, '99999');
      assert.equal(resource.lastEventType, NODE_UPDATED_EVENT_TYPE);
    }
    const watermark = await restarted.repository.getWatermark(NODE_DELETED_HANDLER_NAME, ids[0]!);
    assert.equal(watermark?.lastCommitOrdinal, '9002');
    assert.equal(watermark?.lastDomainEventId, delivery.eventId);
    const applied = await restarted.repository.getApplied(NODE_DELETED_HANDLER_NAME, delivery.eventId);
    assert.equal(applied?.disposition, 'stale_skipped');
  });
});
