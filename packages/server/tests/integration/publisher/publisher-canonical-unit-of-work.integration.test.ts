import assert from 'node:assert/strict';
import { afterAll, beforeAll, test } from 'vitest';
import { runMigrations, type DatabaseRuntime } from '../../../src/infrastructure/database/index.js';
import {
  createPostgresPublisherCanonicalMutationApplication,
  createPostgresPublisherCanonicalMutationUnitOfWork,
} from '../../../src/infrastructure/publisher/index.js';
import {
  materializeCollectionPayload,
  materializeNodePayload,
  type CanonicalMutationInput,
} from '../../../src/modules/collections/index.js';
import type { ExecutePublisherCanonicalMutationInput } from '../../../src/modules/publisher/index.js';
import { InMemoryMetrics } from '../../../src/infrastructure/telemetry/index.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  truncateGuardedTablesInTransaction,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';

const COLLECTION_ID = 'AQEBAQEBAQEBAQEBAQEBAQ';
const ROOT_ID = 'publisher-canonical-root';
const NODE_ID = 'publisher-canonical-node';
const PRINCIPAL_ID = 'BgYGBgYGBgYGBgYGBgYGBg';

describeWithPostgres('Publisher PostgreSQL canonical transaction composition', () => {
  let isolated: IsolatedPostgresRuntime;
  let runtime: DatabaseRuntime;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('publisher_canonical_uow', {
      maxConnections: 6,
      applicationName: 'known-publisher-canonical-uow-test',
    });
    runtime = isolated.runtime;
    await runMigrations(runtime.db, 'latest');
  });

  afterAll(async () => isolated?.close());

  async function resetFixture(): Promise<void> {
    const client = await runtime.pool.connect();
    try {
      await client.query('begin');
      await truncateGuardedTablesInTransaction(client, `
        truncate table publisher_idempotency, product_command_receipts, outbox_events,
          audit_events, operations, policy_revisions, content_revisions, children_revisions,
          resource_revisions, collection_policies, collection_members, nodes, collections,
          resource_id_ledger, profiles, accounts cascade
      `);
      await client.query(
        `insert into accounts(id, subject_id, status, security_epoch) values ($1, $1, 'active', 0)`,
        [PRINCIPAL_ID],
      );
      await client.query(
        `insert into profiles(account_id, display_name, avatar_url) values ($1, 'Publisher owner', null)`,
        [PRINCIPAL_ID],
      );
      await client.query(
        `insert into resource_id_ledger(resource_id, resource_type)
           values ($1, 'collection'), ($2, 'node'), ($3, 'node')`,
        [COLLECTION_ID, ROOT_ID, NODE_ID],
      );
      await client.query(
        `insert into collections(
           id, owner_subject_id, title, kind, visibility, root_node_id,
           resource_revision, content_revision, policy_revision, commit_ordinal
         ) values ($1, $2, 'Publisher', 'bookmarks', 'private', $3,
           'collection-r1', 'content-r1', 'policy-r1', 1)`,
        [COLLECTION_ID, PRINCIPAL_ID, ROOT_ID],
      );
      await client.query(
        `insert into nodes(
           id, collection_id, parent_id, kind, is_root, title, url, tags, visibility,
           position_token, resource_revision, children_revision
         ) values
           ($2, $1, null, 'folder', true, 'Publisher', null, '[]'::jsonb, 'inherit', null,
             'root-r1', 'root-children-r1'),
           ($3, $1, $2, 'bookmark', false, 'Before', 'https://example.test/before',
             '[]'::jsonb, 'inherit', 'U', 'node-r1', 'node-children-r1')`,
        [COLLECTION_ID, ROOT_ID, NODE_ID],
      );
      await materializeCollection(client);
      await materializeNodes([ROOT_ID, NODE_ID], client);
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }

  async function materializeCollection(client: Awaited<ReturnType<typeof runtime.pool.connect>>): Promise<void> {
    const row = (await client.query('select * from collections where id=$1', [COLLECTION_ID])).rows[0];
    const materialized = materializeCollectionPayload({
      id: row.id, ownerSubjectId: row.owner_subject_id, title: row.title, summary: row.summary,
      kind: row.kind, visibility: row.visibility, rootNodeId: row.root_node_id,
      resourceRevision: row.resource_revision, contentRevision: row.content_revision,
      policyRevision: row.policy_revision, commitOrdinal: row.commit_ordinal,
      createdAt: row.created_at, updatedAt: row.updated_at, deletedAt: row.deleted_at,
    });
    assert.equal(materialized.ok, true);
    if (!materialized.ok) throw new Error(materialized.reason);
    await client.query(
      `update collections set payload_json=$2::jsonb, payload_schema_version=1,
        payload_authority_status='backfilled' where id=$1`,
      [COLLECTION_ID, JSON.stringify(materialized.payload)],
    );
  }

  async function materializeNodes(
    ids: readonly string[],
    queryable: Pick<DatabaseRuntime['pool'], 'query'> = runtime.pool,
  ): Promise<void> {
    const rows = await queryable.query('select * from nodes where id=any($1::text[])', [ids]);
    assert.equal(rows.rowCount, ids.length);
    for (const row of rows.rows) {
      const materialized = materializeNodePayload({
        id: row.id, collectionId: row.collection_id, parentId: row.parent_id, kind: row.kind,
        isRoot: row.is_root, title: row.title, url: row.url, description: row.description,
        tags: row.tags, visibility: row.visibility, positionToken: row.position_token,
        resourceRevision: row.resource_revision, childrenRevision: row.children_revision,
        createdAt: row.created_at, updatedAt: row.updated_at, deletedAt: row.deleted_at,
        deletedCommitOrdinal: row.deleted_commit_ordinal,
      });
      assert.equal(materialized.ok, true);
      if (!materialized.ok) throw new Error(materialized.reason);
      await queryable.query(
        `update nodes set payload_json=$2::jsonb, payload_schema_version=1,
          payload_authority_status='backfilled' where id=$1`,
        [row.id, JSON.stringify(materialized.payload)],
      );
    }
  }

  function publisherUpdateInput(): ExecutePublisherCanonicalMutationInput {
    return {
      binding: {
        namespace: 'colp.publisher.v0.1.nodes.update',
        principalId: PRINCIPAL_ID,
        idempotencyKey: 'publisher-canonical-exact-replay',
      },
      payload: { title: 'Publisher update', kind: 'bookmark' },
      collectionId: COLLECTION_ID,
      operationId: '31313131-3131-4131-8131-313131313131',
      mutation: {
        action: 'update',
        target: { collectionId: COLLECTION_ID, resourceId: NODE_ID, resourceKind: 'node' },
        parentId: ROOT_ID,
        expectedResourceRevision: 'node-r1',
        fields: { kindFields: {
          kind: 'bookmark', title: 'Publisher update', url: 'https://example.test/publisher',
          description: 'publisher canonical composition', tags: ['publisher'], visibility: 'inherit',
        }, extensions: {} },
      },
    };
  }

  function createNode(
    operationId: string,
    resourceId: string,
    parentId: string,
    afterId: string,
    beforeId: string,
  ): CanonicalMutationInput {
    return {
      operationId,
      collectionId: COLLECTION_ID,
      actor: { principalId: PRINCIPAL_ID, principalType: 'account' },
      mutation: {
        action: 'create',
        target: { collectionId: COLLECTION_ID, resourceId, resourceKind: 'node' },
        parentId,
        relativePosition: { afterId, beforeId },
        fields: { kindFields: {
          kind: 'folder', title: resourceId, url: null, description: null, tags: [], visibility: 'inherit',
        }, extensions: {} },
      },
    };
  }

  async function insertRebalancePairs(): Promise<readonly [
    string, string, string, string, string, string,
  ]> {
    const ids = [
      'publisher-rebalance-a-parent', 'publisher-rebalance-a-lower', 'publisher-rebalance-a-upper',
      'publisher-rebalance-m-parent', 'publisher-rebalance-m-lower', 'publisher-rebalance-m-upper',
    ] as const;
    await runtime.pool.query(
      `insert into resource_id_ledger(resource_id, resource_type) select unnest($1::text[]), 'node'`,
      [ids],
    );
    await runtime.pool.query(
      `insert into nodes(id, collection_id, parent_id, kind, is_root, title, visibility,
         position_token, resource_revision, children_revision) values
       ($1,$7,$8,'folder',false,'A parent','inherit','E','pub-a-parent-r1','pub-a-parent-c1'),
       ($2,$7,$1,'folder',false,'A lower','inherit',$9,'pub-a-lower-r1','pub-a-lower-c1'),
       ($3,$7,$1,'folder',false,'A upper','inherit',$10,'pub-a-upper-r1','pub-a-upper-c1'),
       ($4,$7,$8,'folder',false,'M parent','inherit','k','pub-m-parent-r1','pub-m-parent-c1'),
       ($5,$7,$4,'folder',false,'M lower','inherit',$11,'pub-m-lower-r1','pub-m-lower-c1'),
       ($6,$7,$4,'folder',false,'M upper','inherit',$12,'pub-m-upper-r1','pub-m-upper-c1')`,
      [...ids, COLLECTION_ID, ROOT_ID, 'a'.repeat(128), `${'a'.repeat(127)}b`,
        'm'.repeat(128), `${'m'.repeat(127)}n`],
    );
    await materializeNodes(ids);
    return ids;
  }

  test('application commits one canonical transaction and exact replay performs no second write', async () => {
    await resetFixture();
    const input = publisherUpdateInput();
    const application = createPostgresPublisherCanonicalMutationApplication(runtime.db);
    const first = await application.execute(input);
    assert.equal(first.kind, 'executed');
    if (first.kind !== 'executed') throw new Error(`expected executed, got ${first.kind}`);
    const replay = await application.execute(input);
    assert.equal(replay.kind, 'replay');
    if (replay.kind !== 'replay') throw new Error(`expected replay, got ${replay.kind}`);
    assert.deepEqual(replay.contract, first.contract);
    assert.deepEqual(replay.result, first.result);

    const state = await runtime.pool.query(
      `select n.title, c.commit_ordinal::text ordinal,
        (select count(*)::int from operations where operation_id=$2) operations,
        (select count(*)::int from publisher_idempotency where idempotency_key=$3) publisher_receipts,
        (select count(*)::int from product_command_receipts) product_receipts
       from nodes n join collections c on c.id=n.collection_id where n.id=$1`,
      [NODE_ID, input.operationId, input.binding.idempotencyKey],
    );
    assert.deepEqual(state.rows[0], {
      title: 'Publisher update', ordinal: '2', operations: 1, publisher_receipts: 1, product_receipts: 0,
    });
  });

  test('UoW reports every committed rebalance and reports none after rollback', async () => {
    await resetFixture();
    const [aParent, aLower, aUpper, mParent, mLower, mUpper] = await insertRebalancePairs();
    const metrics = new InMemoryMetrics();
    const committed = await createPostgresPublisherCanonicalMutationUnitOfWork(runtime.db, {
      metrics, positionRebalanceWindow: 4,
    }).execute(async (ports, context) => {
      const first = await ports.canonical.execute(context, createNode(
        '32323232-3232-4232-8232-323232323232', 'publisher-rebalance-a-created',
        aParent, aLower, aUpper,
      ));
      const second = await ports.canonical.execute(context, createNode(
        '33333333-3333-4333-8333-333333333333', 'publisher-rebalance-m-created',
        mParent, mLower, mUpper,
      ));
      assert.equal(metrics.get('position.rebalance.bounded_total'), 0, 'metrics must wait for commit');
      return [first, second] as const;
    });
    const counts = committed.map((result) => result.allocation.rebalancedSiblings?.length ?? 0);
    assert.ok(counts.every((count) => count > 0));
    assert.equal(metrics.get('position.rebalance.bounded_total'), 2);
    assert.deepEqual(metrics.observations('position.rebalance.rewritten_siblings'), counts);

    await resetFixture();
    const [parent, lower, upper] = await insertRebalancePairs();
    const rollbackMetrics = new InMemoryMetrics();
    const fault = new Error('publisher work failed after canonical rebalance');
    await assert.rejects(
      createPostgresPublisherCanonicalMutationUnitOfWork(runtime.db, {
        metrics: rollbackMetrics, positionRebalanceWindow: 4,
      }).execute(async (ports, context) => {
        const result = await ports.canonical.execute(context, createNode(
          '34343434-3434-4434-8434-343434343434', 'publisher-rebalance-rolled-back',
          parent, lower, upper,
        ));
        assert.ok((result.allocation.rebalancedSiblings?.length ?? 0) > 0);
        throw fault;
      }),
      fault,
    );
    assert.equal(rollbackMetrics.get('position.rebalance.bounded_total'), 0);
    assert.deepEqual(rollbackMetrics.observations('position.rebalance.rewritten_siblings'), []);
    const rolledBack = await runtime.pool.query(
      `select (select count(*)::int from nodes where id=$1) nodes,
        (select count(*)::int from operations where operation_id=$2) operations,
        commit_ordinal::text ordinal from collections where id=$3`,
      ['publisher-rebalance-rolled-back', '34343434-3434-4434-8434-343434343434', COLLECTION_ID],
    );
    assert.deepEqual(rolledBack.rows[0], { nodes: 0, operations: 0, ordinal: '1' });
  });
});
