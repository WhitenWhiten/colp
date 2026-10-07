/**
 * P1-7: subtree delete projection follows immutable affected-resource facts.
 * Real PostgreSQL only. A live tombstone is not the target list.
 */
import assert from 'node:assert/strict';
import { afterAll, beforeAll, test } from 'vitest';
import { runMigrations, type DatabaseRuntime } from '../../../src/infrastructure/database/index.js';
import { createPostgresCanonicalMutationUnitOfWork } from '../../../src/infrastructure/collections/index.js';
import {
  kyselyAffectedFactExecutor,
  persistNodeDeleteAffectedFacts,
} from '../../../src/infrastructure/collections/canonical-node-delete-affected-facts.js';
import { appendOperationWithPayload } from '../../../src/infrastructure/database/operation-payload-store.js';
import { PostgresCollectionMutationProjectionSink } from '../../../src/infrastructure/outbox/postgres-collection-mutation-projection.js';
import {
  NODE_DELETED_EVENT_TYPE,
  NODE_DELETED_HANDLER_NAME,
  NODE_RESTORED_EVENT_TYPE,
  NODE_RESTORED_HANDLER_NAME,
  materializeCollectionPayload,
  materializeNodePayload,
  type CanonicalMutationInput,
} from '../../../src/modules/collections/index.js';
import type { CollectionMutationDelivery } from '../../../src/infrastructure/outbox/collection-mutation-events.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  truncateGuardedTablesInTransaction,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';

const COLLECTION_ID = 'AQEBAQEBAQEBAQEBAQEBAQ';
const ROOT_ID = 'p17-root';
const FOLDER_ID = 'p17-folder';
const BOOKMARK_ID = 'p17-bookmark';
const PRINCIPAL_ID = 'BgYGBgYGBgYGBgYGBgYGBg';
const DELETE_OPERATION_ID = '17171717-1717-4171-8171-171717171717';

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

  async function resetTree(): Promise<void> {
    const client = await runtime.pool.connect();
    try {
      await client.query('begin');
      await truncateGuardedTablesInTransaction(client, `
        truncate table collection_mutation_projection_applied,
          collection_mutation_projection_resources,
          collection_mutation_projection_watermarks,
          product_command_receipts, outbox_events, audit_events, operations,
          policy_revisions, content_revisions, children_revisions, resource_revisions,
          collection_policies, collection_members, nodes, collections, resource_id_ledger,
          profiles, accounts cascade
      `);
      await client.query(
        `insert into accounts(id, subject_id, status, security_epoch) values ($1, $1, 'active', 0)`,
        [PRINCIPAL_ID],
      );
      await client.query(
        `insert into profiles(account_id, display_name, avatar_url) values ($1, 'P17 owner', null)`,
        [PRINCIPAL_ID],
      );
      await client.query(
        `insert into resource_id_ledger (resource_id, resource_type) values
         ($1, 'collection'), ($2, 'node'), ($3, 'node'), ($4, 'node')`,
        [COLLECTION_ID, ROOT_ID, FOLDER_ID, BOOKMARK_ID],
      );
      await client.query(
        `insert into collections (
           id, owner_subject_id, title, summary, kind, visibility, root_node_id,
           resource_revision, content_revision, policy_revision, commit_ordinal
         ) values ($1, $2, 'P17', null, 'bookmarks', 'private', $3, 'collection-r1', 'content-r1', 'policy-r1', 1)`,
        [COLLECTION_ID, PRINCIPAL_ID, ROOT_ID],
      );
      await client.query(
        `insert into nodes (
           id, collection_id, parent_id, kind, is_root, title, url, description, tags,
           visibility, position_token, resource_revision, children_revision
         ) values
         ($1, $4, null, 'folder', true, 'P17', null, null, '[]'::jsonb,
          'inherit', null, 'root-r1', 'root-children-r1'),
         ($2, $4, $1, 'folder', false, 'Folder', null, null, '[]'::jsonb,
          'inherit', 'E', 'folder-r1', 'folder-children-r1'),
         ($3, $4, $2, 'bookmark', false, 'Bookmark', 'https://example.test/p17', null, '[]'::jsonb,
          'inherit', 'U', 'bookmark-r1', 'bookmark-children-r1')`,
        [ROOT_ID, FOLDER_ID, BOOKMARK_ID, COLLECTION_ID],
      );
      await client.query('commit');
    } catch (error: unknown) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
    await materializeCollection();
    await materializeNodes([ROOT_ID, FOLDER_ID, BOOKMARK_ID]);
  }

  async function materializeCollection(): Promise<void> {
    const row = (await runtime.pool.query('select * from collections where id = $1', [COLLECTION_ID])).rows[0];
    const materialized = materializeCollectionPayload({
      id: row.id,
      ownerSubjectId: row.owner_subject_id,
      title: row.title,
      summary: row.summary,
      kind: row.kind,
      visibility: row.visibility,
      rootNodeId: row.root_node_id,
      resourceRevision: row.resource_revision,
      contentRevision: row.content_revision,
      policyRevision: row.policy_revision,
      commitOrdinal: row.commit_ordinal,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      deletedAt: row.deleted_at,
    });
    assert.equal(materialized.ok, true);
    if (!materialized.ok) throw new Error(materialized.reason);
    await runtime.pool.query(
      `update collections set payload_json = $2::jsonb, payload_schema_version = 1,
         payload_authority_status = 'backfilled' where id = $1`,
      [COLLECTION_ID, JSON.stringify(materialized.payload)],
    );
  }

  async function materializeNodes(nodeIds: readonly string[]): Promise<void> {
    const rows = await runtime.pool.query('select * from nodes where id = any($1::text[])', [nodeIds]);
    assert.equal(rows.rowCount, nodeIds.length);
    for (const row of rows.rows) {
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
      await runtime.pool.query(
        `update nodes set payload_json = $2::jsonb, payload_schema_version = 1,
           payload_authority_status = 'backfilled' where id = $1`,
        [row.id, JSON.stringify(materialized.payload)],
      );
    }
  }

  function deleteInput(): CanonicalMutationInput {
    return {
      operationId: DELETE_OPERATION_ID,
      collectionId: COLLECTION_ID,
      actor: { principalId: PRINCIPAL_ID, principalType: 'account' },
      mutation: {
        action: 'delete',
        target: { collectionId: COLLECTION_ID, resourceId: FOLDER_ID, resourceKind: 'node' },
        parentId: ROOT_ID,
        expectedResourceRevision: 'folder-r1',
        deleteIntent: { scope: 'subtree' },
      },
    };
  }

  async function executeDelete(): Promise<void> {
    const input = deleteInput();
    const binding = {
      principalId: PRINCIPAL_ID,
      commandScope: 'canonical:delete',
      commandId: input.operationId,
    };
    await createPostgresCanonicalMutationUnitOfWork(runtime.db).execute(async (ports) => {
      assert.deepEqual(await ports.receipts.claim(binding, `fp-${input.operationId}`), { kind: 'claimed' });
      await ports.canonical.execute(input);
      await ports.receipts.complete(binding, `fp-${input.operationId}`, {
        status: 200,
        body: Buffer.from('{}'),
        stableHeaders: { 'content-type': 'application/json' },
        mediaType: 'application/json',
        contractVersion: '1.0.0',
        targetIdentity: FOLDER_ID,
      });
    });
  }

  async function loadDeleteDelivery(): Promise<CollectionMutationDelivery> {
    const result = await runtime.pool.query<{
      domain_event_id: string;
      event_type: string;
      event_version: number;
      handler_name: string;
      aggregate_id: string;
      aggregate_scope: string;
      commit_ordinal: string;
      payload_json: Record<string, unknown>;
    }>(
      `select e.domain_event_id, e.event_type, e.event_version, e.handler_name,
              e.aggregate_id, e.aggregate_scope, e.commit_ordinal::text, e.payload_json
       from outbox_events e
       join operations o
         on o.collection_id = e.aggregate_scope and o.commit_ordinal = e.commit_ordinal
       where o.operation_id = $1 and e.event_type = 'node.deleted'`,
      [DELETE_OPERATION_ID],
    );
    assert.equal(result.rowCount, 1);
    const row = result.rows[0]!;
    return {
      eventId: row.domain_event_id,
      eventType: row.event_type,
      eventVersion: row.event_version,
      handlerName: row.handler_name,
      idempotencyKey: row.domain_event_id,
      aggregateId: row.aggregate_id,
      aggregateScope: row.aggregate_scope,
      commitOrdinal: row.commit_ordinal,
      payload: row.payload_json,
      aggregateRevision: 'rev-1',
      occurredAt: '2026-10-03T00:00:00.000Z',
    };
  }

  async function factIds(collectionId: string, commitOrdinal: string): Promise<string[]> {
    const result = await runtime.pool.query<{ resource_id: string }>(
      `select resource_id from node_delete_affected_resources
       where collection_id = $1 and commit_ordinal = $2::bigint
       order by fact_ordinal`,
      [collectionId, commitOrdinal],
    );
    return result.rows.map((row) => row.resource_id);
  }

  test('delete then restore skips the old delete without reading the cleared tombstone', async () => {
    await resetTree();
    await executeDelete();
    const delivery = await loadDeleteDelivery();
    assert.equal(delivery.aggregateId, FOLDER_ID);
    assert.equal(delivery.payload.scope, 'subtree');
    assert.equal(delivery.payload.affectedCount, 2);
    assert.equal('affectedResourceIds' in delivery.payload, false);
    const payloadIds = (await runtime.pool.query<{ ids: string[] }>(
      `select payload_json->'affectedResourceIds' as ids from operation_payloads where operation_id = $1`,
      [DELETE_OPERATION_ID],
    )).rows[0]?.ids;
    assert.deepEqual(await factIds(COLLECTION_ID, delivery.commitOrdinal), payloadIds);
    assert.deepEqual(new Set(payloadIds), new Set([FOLDER_ID, BOOKMARK_ID]));
    await assert.rejects(
      runtime.pool.query(
        `update node_delete_affected_resources set recorded_at = recorded_at where collection_id = $1`,
        [COLLECTION_ID],
      ),
      /immutable/u,
    );

    await runtime.pool.query(
      `update nodes set deleted_at = null, deleted_commit_ordinal = null
       where collection_id = $1 and id = any($2::text[])`,
      [COLLECTION_ID, [FOLDER_ID, BOOKMARK_ID]],
    );
    const cleared = await runtime.pool.query<{ n: number }>(
      `select count(*)::int as n from nodes
       where collection_id = $1 and id = any($2::text[]) and deleted_commit_ordinal is not null`,
      [COLLECTION_ID, [FOLDER_ID, BOOKMARK_ID]],
    );
    assert.equal(cleared.rows[0]?.n, 0);

    const restoreOrdinal = (BigInt(delivery.commitOrdinal) + 1n).toString();
    assert.equal(await sink.repository.apply({
      eventId: `p17-restore-${FOLDER_ID}`,
      eventType: NODE_RESTORED_EVENT_TYPE,
      eventVersion: 1,
      handlerName: NODE_RESTORED_HANDLER_NAME,
      idempotencyKey: `p17-restore-${FOLDER_ID}`,
      aggregateId: FOLDER_ID,
      aggregateScope: COLLECTION_ID,
      commitOrdinal: restoreOrdinal,
      payload: { collectionId: COLLECTION_ID, nodeId: FOLDER_ID },
      aggregateRevision: 'rev-1',
      occurredAt: '2026-10-03T00:00:01.000Z',
    }), 'applied');

    assert.equal(await sink.repository.apply(delivery), 'applied');
    assert.equal(await sink.repository.apply(delivery), 'replay');
    const restarted = new PostgresCollectionMutationProjectionSink(runtime.pool);
    const folder = await restarted.repository.getResource(COLLECTION_ID, 'node', FOLDER_ID);
    const bookmark = await restarted.repository.getResource(COLLECTION_ID, 'node', BOOKMARK_ID);
    assert.ok(folder);
    assert.equal(folder.deleted, false);
    assert.equal(folder.lastCommitOrdinal, restoreOrdinal);
    assert.equal(folder.lastEventType, NODE_RESTORED_EVENT_TYPE);
    assert.ok(bookmark);
    assert.equal(bookmark.deleted, true);
    assert.equal(bookmark.lastCommitOrdinal, delivery.commitOrdinal);
    assert.equal(bookmark.lastEventType, NODE_DELETED_EVENT_TYPE);
    const watermark = await restarted.repository.getWatermark(NODE_DELETED_HANDLER_NAME, FOLDER_ID);
    assert.ok(watermark);
    assert.equal(watermark.lastCommitOrdinal, delivery.commitOrdinal);
    assert.equal(watermark.lastDomainEventId, delivery.eventId);
  });

  test('an old delete is backfilled from the hot payload, not the live tree', async () => {
    await resetTree();
    await executeDelete();
    const delivery = await loadDeleteDelivery();
    const client = await runtime.pool.connect();
    try {
      await client.query('begin');
      await client.query("set local session_replication_role = 'replica'");
      await client.query(
        'delete from node_delete_affected_resources where collection_id = $1',
        [COLLECTION_ID],
      );
      await client.query('commit');
    } catch (error: unknown) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
    await runtime.pool.query(
      `update nodes set deleted_at = null, deleted_commit_ordinal = null
       where collection_id = $1 and id = any($2::text[])`,
      [COLLECTION_ID, [FOLDER_ID, BOOKMARK_ID]],
    );
    assert.equal(await sink.repository.apply(delivery), 'applied');
    const ids = await factIds(COLLECTION_ID, delivery.commitOrdinal);
    assert.deepEqual(new Set(ids), new Set([FOLDER_ID, BOOKMARK_ID]));
    const bookmark = await sink.repository.getResource(COLLECTION_ID, 'node', BOOKMARK_ID);
    assert.equal(bookmark?.deleted, true);
    const stillCleared = await runtime.pool.query<{ n: number }>(
      `select count(*)::int as n from nodes
       where id = any($1::text[]) and deleted_commit_ordinal is not null`,
      [[FOLDER_ID, BOOKMARK_ID]],
    );
    assert.equal(stillCleared.rows[0]?.n, 0);
  });

  test('a matching live tombstone is not used when no trustworthy id source remains', async () => {
    const collectionId = 'p17-noguess-collection';
    const rootId = 'p17-noguess-root';
    const folderId = 'p17-noguess-folder';
    const childId = 'p17-noguess-child';
    const ownerId = 'p17-noguess-owner';
    const client = await runtime.pool.connect();
    try {
      await client.query('begin');
      await client.query(
        `insert into accounts(id, subject_id, status, security_epoch) values ($1, $1, 'active', 0)`,
        [ownerId],
      );
      await client.query(
        `insert into profiles(account_id, display_name, avatar_url) values ($1, 'No guess', null)`,
        [ownerId],
      );
      await client.query(
        `insert into resource_id_ledger (resource_id, resource_type) values
         ($1, 'collection'), ($2, 'node'), ($3, 'node'), ($4, 'node')`,
        [collectionId, rootId, folderId, childId],
      );
      await client.query(
        `insert into collections (
           id, owner_subject_id, title, summary, kind, visibility, root_node_id,
           resource_revision, content_revision, policy_revision, commit_ordinal
         ) values ($1, $2, 'No guess', null, 'bookmarks', 'private', $3,
           'collection-r1', 'content-r1', 'policy-r1', 1)`,
        [collectionId, ownerId, rootId],
      );
      await client.query(
        `insert into nodes (
           id, collection_id, parent_id, kind, is_root, title, url, description, tags,
           visibility, position_token, resource_revision, children_revision,
           deleted_at, deleted_commit_ordinal
         ) values
         ($1, $4, null, 'folder', true, 'Root', null, null, '[]'::jsonb,
          'inherit', null, 'root-r1', 'root-children-r1', null, null),
         ($2, $4, $1, 'folder', false, 'Folder', null, null, '[]'::jsonb,
          'inherit', 'E', 'folder-r1', 'folder-children-r1', current_timestamp, 77),
         ($3, $4, $2, 'bookmark', false, 'Child', 'https://example.test/noguess', null, '[]'::jsonb,
          'inherit', 'U', 'child-r1', 'child-children-r1', current_timestamp, 77)`,
        [rootId, folderId, childId, collectionId],
      );
      await client.query('commit');
    } catch (error: unknown) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
    const delivery: CollectionMutationDelivery = {
      eventId: 'p17-noguess-event',
      eventType: NODE_DELETED_EVENT_TYPE,
      eventVersion: 1,
      handlerName: NODE_DELETED_HANDLER_NAME,
      idempotencyKey: 'p17-noguess-event',
      aggregateId: folderId,
      aggregateScope: collectionId,
      commitOrdinal: '77',
      payload: {
        affectedCount: 2,
        collectionId,
        contentRevision: 'content-r1',
        kind: 'folder',
        nodeId: folderId,
        parentChildrenRevision: 'root-children-r1',
        parentId: rootId,
        policyRevision: 'policy-r1',
        scope: 'subtree',
      },
      aggregateRevision: 'rev-1',
      occurredAt: '2026-10-03T00:00:00.000Z',
    };
    await assert.rejects(
      () => sink.repository.apply(delivery),
      /no immutable affected-resource facts and no trustworthy hot operation payload/u,
    );
    assert.equal(await sink.repository.getApplied(NODE_DELETED_HANDLER_NAME, delivery.eventId), null);
    assert.equal(await sink.repository.getWatermark(NODE_DELETED_HANDLER_NAME, folderId), null);
    assert.equal(await sink.repository.getResource(collectionId, 'node', folderId), null);
    assert.equal(await sink.repository.getResource(collectionId, 'node', childId), null);
    assert.deepEqual(await factIds(collectionId, '77'), []);
  });

  test('a failed page does not advance the watermark and a restart finishes every target', async () => {
    const collectionId = 'p17-page-collection';
    const rootId = 'p17-page-root';
    const ownerId = 'p17-page-owner';
    const operationId = '17171717-1717-4171-8171-171717171701';
    const ids = Array.from({ length: 129 }, (_, index) => `fact-${index.toString().padStart(3, '0')}`);
    const client = await runtime.pool.connect();
    try {
      await client.query('begin');
      await client.query(
        `insert into accounts(id, subject_id, status, security_epoch) values ($1, $1, 'active', 0)`,
        [ownerId],
      );
      await client.query(
        `insert into profiles(account_id, display_name, avatar_url) values ($1, 'Page owner', null)`,
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
         ) values ($1, $2, 'Pages', null, 'bookmarks', 'private', $3,
           'collection-r1', 'content-r1', 'policy-r1', 1)`,
        [collectionId, ownerId, rootId],
      );
      await client.query(
        `insert into nodes (
           id, collection_id, parent_id, kind, is_root, title, url, description, tags,
           visibility, position_token, resource_revision, children_revision
         ) values (
           $1, $2, null, 'folder', true, 'Pages', null, null, '[]'::jsonb,
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
        commitOrdinal: 9001n,
        operationType: 'resource.delete',
        payloadJson: { note: 'paging fixture' },
        actorPrincipalId: ownerId,
      });
      await persistNodeDeleteAffectedFacts(kyselyAffectedFactExecutor(tx), {
        collectionId,
        commitOrdinal: 9001n,
        rootNodeId: ids[0]!,
        operationId,
        resourceIds: ids,
      });
    });
    assert.equal((await factIds(collectionId, '9001')).length, 129);
    const delivery: CollectionMutationDelivery = {
      eventId: 'p17-page-event',
      eventType: NODE_DELETED_EVENT_TYPE,
      eventVersion: 1,
      handlerName: NODE_DELETED_HANDLER_NAME,
      idempotencyKey: 'p17-page-event',
      aggregateId: ids[0]!,
      aggregateScope: collectionId,
      commitOrdinal: '9001',
      payload: {
        affectedCount: 129,
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
    await runtime.pool.query(`
      create function p17_fail_last_target() returns trigger language plpgsql as $$
      begin
        if new.resource_id = 'fact-128' then
          raise exception 'injected projection page failure';
        end if;
        return new;
      end $$
    `);
    await runtime.pool.query(`
      create trigger p17_fail_last_target
      before insert or update on collection_mutation_projection_resources
      for each row execute function p17_fail_last_target()
    `);
    try {
      await assert.rejects(() => sink.repository.apply(delivery), /injected projection page failure/u);
      assert.equal(await sink.repository.getWatermark(NODE_DELETED_HANDLER_NAME, ids[0]!), null);
      assert.equal(await sink.repository.getApplied(NODE_DELETED_HANDLER_NAME, delivery.eventId), null);
      const stranded = await runtime.pool.query<{ n: number }>(
        `select count(*)::int as n from collection_mutation_projection_resources where collection_id = $1`,
        [collectionId],
      );
      assert.equal(stranded.rows[0]?.n, 0);
    } finally {
      await runtime.pool.query('drop trigger if exists p17_fail_last_target on collection_mutation_projection_resources');
      await runtime.pool.query('drop function if exists p17_fail_last_target()');
    }
    const restarted = new PostgresCollectionMutationProjectionSink(runtime.pool);
    assert.equal(await restarted.repository.apply(delivery), 'applied');
    assert.equal(await restarted.repository.apply(delivery), 'replay');
    const watermark = await restarted.repository.getWatermark(NODE_DELETED_HANDLER_NAME, ids[0]!);
    assert.equal(watermark?.lastCommitOrdinal, '9001');
    const projected = await restarted.repository.listResources(collectionId);
    assert.equal(projected.length, 129);
    assert.equal(projected.every((row) => row.deleted && row.lastCommitOrdinal === '9001'), true);
  });
});
