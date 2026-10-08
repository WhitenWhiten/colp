import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { afterAll, beforeAll, test } from 'vitest';
import { sql } from 'kysely';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import { createPostgresCanonicalMutationUnitOfWork, type PostgresCanonicalMutationFaultContext } from '../../../src/infrastructure/collections/index.js';
import {
  ANNOTATION_DELETED_EVENT_TYPE,
  RELATION_DELETED_EVENT_TYPE,
  CanonicalMutationInvariantError,
  DeleteSubtreeLimitError,
  formatUtcDateTime,
  materializeCollectionPayload,
  materializeNodePayload,
  type CanonicalMutationInput,
} from '../../../src/modules/collections/index.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
  truncateGuardedTablesInTransaction,
} from '../../support/postgres-test-runtime.js';

const COLLECTION_ID = 'AQEBAQEBAQEBAQEBAQEBAQ';
const ROOT_ID = 'r14-root';
const TARGET_ID = 'r14-subtree-target';
const PRINCIPAL_ID = 'BgYGBgYGBgYGBgYGBgYGBg';
const SEED_TS = '2026-01-02T03:04:05Z';

describeWithPostgres('R14 batched subtree delete authority and sidecars', () => {
  let isolated: IsolatedPostgresRuntime;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('r14_subtree_delete_batching', {
      maxConnections: 6,
      applicationName: 'known-r14-batching-test',
    });
    await runMigrations(isolated.runtime.db, 'latest');
  }, 120_000);

  afterAll(async () => {
    await isolated?.close();
  });

  async function resetFixture(): Promise<void> {
    const client = await isolated.runtime.pool.connect();
    try {
      await client.query('begin');
      await truncateGuardedTablesInTransaction(client, `
        truncate table product_command_receipts, outbox_events, audit_events, operations,
          policy_revisions, content_revisions, children_revisions, resource_revisions,
          sync_node_revision_history, relations, annotations, collection_policies,
          collection_members, nodes, collections, resource_id_ledger, profiles, accounts cascade
      `);
      await client.query(
        `insert into accounts(id, subject_id, status, security_epoch)
         values ($1, $1, 'active', 0)`,
        [PRINCIPAL_ID],
      );
      await client.query(
        `insert into profiles(account_id, display_name, avatar_url)
         values ($1, 'R14 owner', null)`,
        [PRINCIPAL_ID],
      );
      await client.query(
        `insert into resource_id_ledger (resource_id, resource_type) values
         ($1, 'collection'), ($2, 'node')`,
        [COLLECTION_ID, ROOT_ID],
      );
      await client.query(
        `insert into collections (
           id, owner_subject_id, title, summary, kind, visibility, root_node_id,
           resource_revision, content_revision, policy_revision, commit_ordinal
         ) values ($1, $2, 'R14', null, 'bookmarks', 'private', $3, 'collection-r1', 'content-r1', 'policy-r1', 1)`,
        [COLLECTION_ID, PRINCIPAL_ID, ROOT_ID],
      );
      await client.query(
        `insert into nodes (
           id, collection_id, parent_id, kind, is_root, title, url, description, tags,
           visibility, position_token, resource_revision, children_revision
         ) values (
           $1, $2, null, 'folder', true, 'R14 root', null, null, '[]'::jsonb,
           'inherit', null, 'r14-root-r1', 'r14-root-children-r1'
         )`,
        [ROOT_ID, COLLECTION_ID],
      );
      await client.query('commit');
    } catch (error: unknown) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
    // materializeRows updates payload_json via the shared pool, which uses a
    // different connection than `client`; running it while the fixture inserts
    // are uncommitted would block on their row locks until lock_timeout.
    await materializeRows('collections', [COLLECTION_ID]);
    await materializeRows('nodes', [ROOT_ID]);
  }

  async function materializeRows(table: 'collections' | 'nodes', ids: readonly string[]): Promise<void> {
    const rows = await isolated.runtime.pool.query(
      `select * from ${table} where id = any($1::text[])`,
      [ids],
    );
    assert.equal(rows.rowCount, ids.length);
    for (const row of rows.rows) {
      if (table === 'collections') {
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
        await isolated.runtime.pool.query(
          `update collections
             set payload_json = $2::jsonb, payload_schema_version = 1, payload_authority_status = 'backfilled'
           where id = $1`,
          [row.id, JSON.stringify(materialized.payload)],
        );
      } else {
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
        await isolated.runtime.pool.query(
          `update nodes
             set payload_json = $2::jsonb, payload_schema_version = 1, payload_authority_status = 'backfilled'
           where id = $1`,
          [row.id, JSON.stringify(materialized.payload)],
        );
      }
    }
  }

  /** target folder + (totalNodes - 1) bookmark children; returns [target, ...children]. */
  async function insertFlatSubtree(totalNodes: number): Promise<readonly string[]> {
    assert.ok(totalNodes >= 1);
    const childCount = totalNodes - 1;
    await isolated.runtime.pool.query(
      `insert into resource_id_ledger(resource_id, resource_type) values ($1, 'node')`,
      [TARGET_ID],
    );
    await isolated.runtime.pool.query(
      `insert into nodes(
         id, collection_id, parent_id, kind, is_root, title, url, description, tags,
         visibility, position_token, resource_revision, children_revision
       ) values (
         $1, $2, $3, 'folder', false, 'R14 target', null, null, '[]'::jsonb,
         'inherit', 'zz-r14-target', 'r14-target-rev', 'r14-target-children-rev'
       )`,
      [TARGET_ID, COLLECTION_ID, ROOT_ID],
    );
    if (childCount > 0) {
      await isolated.runtime.pool.query(
        `insert into resource_id_ledger(resource_id, resource_type)
         select 'r14-node-' || lpad(series::text, 4, '0'), 'node'
         from generate_series(1, $1::integer) series`,
        [childCount],
      );
      await isolated.runtime.pool.query(
        `insert into nodes(
           id, collection_id, parent_id, kind, is_root, title, url, description, tags,
           visibility, position_token, resource_revision, children_revision
         )
         select 'r14-node-' || lpad(series::text, 4, '0'), $2, $3,
           'bookmark', false, 'R14 node ' || series::text,
           'https://example.test/r14/' || series::text, null, '[]'::jsonb,
           'inherit', lpad(series::text, 8, '0'),
           'r14-node-rev-' || series::text, 'r14-node-children-rev-' || series::text
         from generate_series(1, $1::integer) series`,
        [childCount, COLLECTION_ID, TARGET_ID],
      );
    }
    const ids = [
      TARGET_ID,
      ...Array.from({ length: childCount }, (_, index) => `r14-node-${String(index + 1).padStart(4, '0')}`),
    ];
    await materializeRows('nodes', ids);
    return ids;
  }

  /** A chain target -> c1 -> ... -> c{depth}; returns [target, c1, ..., c{depth}]. */
  async function insertChainSubtree(depth: number): Promise<readonly string[]> {
    assert.ok(depth >= 0);
    await isolated.runtime.pool.query(
      `insert into resource_id_ledger(resource_id, resource_type) values ($1, 'node')`,
      [TARGET_ID],
    );
    await isolated.runtime.pool.query(
      `insert into nodes(
         id, collection_id, parent_id, kind, is_root, title, url, description, tags,
         visibility, position_token, resource_revision, children_revision
       ) values (
         $1, $2, $3, 'folder', false, 'R14 chain target', null, null, '[]'::jsonb,
         'inherit', 'zz-r14-chain-target', 'r14-target-rev', 'r14-target-children-rev'
       )`,
      [TARGET_ID, COLLECTION_ID, ROOT_ID],
    );
    if (depth > 0) {
      await isolated.runtime.pool.query(
        `insert into resource_id_ledger(resource_id, resource_type)
         select 'r14-chain-' || lpad(series::text, 4, '0'), 'node'
         from generate_series(1, $1::integer) series`,
        [depth],
      );
      await isolated.runtime.pool.query(
        `insert into nodes(
           id, collection_id, parent_id, kind, is_root, title, url, description, tags,
           visibility, position_token, resource_revision, children_revision
         )
         select 'r14-chain-' || lpad(series::text, 4, '0'), $2,
           case when series = 1 then $3 else 'r14-chain-' || lpad((series - 1)::text, 4, '0') end,
           'folder', false, 'R14 chain ' || series::text,
           null, null, '[]'::jsonb,
           'inherit', lpad(series::text, 8, '0'),
           'r14-chain-rev-' || series::text, 'r14-chain-children-rev-' || series::text
         from generate_series(1, $1::integer) series`,
        [depth, COLLECTION_ID, TARGET_ID],
      );
    }
    const ids = [
      TARGET_ID,
      ...Array.from({ length: depth }, (_, index) => `r14-chain-${String(index + 1).padStart(4, '0')}`),
    ];
    await materializeRows('nodes', ids);
    return ids;
  }

  /** Annotation n is attached to node 'r14-node-{n}' with revision 'r14-annotation-rev-{n}'. */
  async function insertAnnotations(count: number): Promise<readonly string[]> {
    assert.ok(count >= 1);
    const ids = Array.from({ length: count }, (_, index) => `r14-annotation-${String(index + 1).padStart(4, '0')}`);
    await isolated.runtime.pool.query(
      `insert into resource_id_ledger(resource_id, resource_type)
       select 'r14-annotation-' || lpad(series::text, 4, '0'), 'annotation'
       from generate_series(1, $1::integer) series`,
      [count],
    );
    await isolated.runtime.pool.query(
      `insert into annotations (
         id, collection_id, subject_type, subject_id, creator_principal_id, type, format, value_json,
         visibility, resource_revision, created_at, updated_at, payload_json,
         payload_schema_version, payload_authority_status
       )
       select
         'r14-annotation-' || lpad(series::text, 4, '0'), $2::text, 'node',
         'r14-node-' || lpad(series::text, 4, '0'), $3::text,
         'note', 'plain', jsonb_build_object('text', 'R14 note ' || series::text),
         'private', 'r14-annotation-rev-' || series::text, $4::timestamptz, $4::timestamptz,
         jsonb_build_object(
           'id', 'r14-annotation-' || lpad(series::text, 4, '0'),
           'collectionId', $2,
           'subject', jsonb_build_object('type', 'node', 'id', 'r14-node-' || lpad(series::text, 4, '0')),
           'creator', jsonb_build_object('type', 'account', 'id', $3),
           'type', 'note', 'format', 'plain',
           'value', jsonb_build_object('text', 'R14 note ' || series::text),
           'visibility', 'private',
           'revision', 'r14-annotation-rev-' || series::text,
           'createdAt', $4, 'updatedAt', $4
         ),
         1, 'backfilled'
       from generate_series(1, $1::integer) series`,
      [count, COLLECTION_ID, PRINCIPAL_ID, SEED_TS],
    );
    return ids;
  }

  /** Relation n links 'r14-node-{n}' -> 'r14-node-{(n % count) + 1}' with a distinct revision. */
  async function insertRelations(count: number): Promise<readonly string[]> {
    assert.ok(count >= 1);
    const ids = Array.from({ length: count }, (_, index) => `r14-relation-${String(index + 1).padStart(4, '0')}`);
    await isolated.runtime.pool.query(
      `insert into resource_id_ledger(resource_id, resource_type)
       select 'r14-relation-' || lpad(series::text, 4, '0'), 'relation'
       from generate_series(1, $1::integer) series`,
      [count],
    );
    await isolated.runtime.pool.query(
      `insert into relations (
         id, collection_id, from_node_id, to_node_id, type, label, visibility,
         resource_revision, created_at, updated_at, payload_json,
         payload_schema_version, payload_authority_status
       )
       select
         'r14-relation-' || lpad(series::text, 4, '0'), $2::text,
         'r14-node-' || lpad(series::text, 4, '0'),
         case when $1::integer = 1 then $3::text
              else 'r14-node-' || lpad(((series % $1::integer) + 1)::text, 4, '0')
         end,
         'related', null, 'private',
         'r14-relation-rev-' || series::text, $4::timestamptz, $4::timestamptz,
         jsonb_build_object(
           'id', 'r14-relation-' || lpad(series::text, 4, '0'),
           'collectionId', $2,
           'type', 'related',
           'fromNodeId', 'r14-node-' || lpad(series::text, 4, '0'),
           'toNodeId', case when $1::integer = 1 then $3::text
                            else 'r14-node-' || lpad(((series % $1::integer) + 1)::text, 4, '0')
                       end,
           'visibility', 'private',
           'revision', 'r14-relation-rev-' || series::text,
           'createdAt', $4, 'updatedAt', $4
         ),
         1, 'backfilled'
       from generate_series(1, $1::integer) series`,
      [count, COLLECTION_ID, TARGET_ID, SEED_TS],
    );
    return ids;
  }

  async function insertOutsideNode(id: string): Promise<void> {
    await isolated.runtime.pool.query(
      `insert into resource_id_ledger(resource_id, resource_type) values ($1, 'node')`,
      [id],
    );
    await isolated.runtime.pool.query(
      `insert into nodes(
         id, collection_id, parent_id, kind, is_root, title, url, description, tags,
         visibility, position_token, resource_revision, children_revision
       ) values (
         $1, $2, $3, 'bookmark', false, 'R14 outside', 'https://example.test/outside', null, '[]'::jsonb,
         'inherit', 'zz-outside-' || $1, 'r14-outside-rev-1', 'r14-outside-children-rev-1'
       )`,
      [id, COLLECTION_ID, ROOT_ID],
    );
    await materializeRows('nodes', [id]);
  }

  async function insertAnnotation(spec: {
    id: string;
    subjectId: string;
    revision: string;
  }): Promise<void> {
    await isolated.runtime.pool.query(
      `insert into resource_id_ledger(resource_id, resource_type) values ($1, 'annotation')`,
      [spec.id],
    );
    await isolated.runtime.pool.query(
      `insert into annotations (
         id, collection_id, subject_type, subject_id, creator_principal_id, type, format, value_json,
         visibility, resource_revision, created_at, updated_at, payload_json,
         payload_schema_version, payload_authority_status
       ) values (
         $1::text, $2::text, 'node', $3::text, $4::text, 'note', 'plain', jsonb_build_object('text', 'note'),
         'private', $5::text, $6::timestamptz, $6::timestamptz,
         jsonb_build_object(
           'id', $1, 'collectionId', $2,
           'subject', jsonb_build_object('type', 'node', 'id', $3),
           'creator', jsonb_build_object('type', 'account', 'id', $4),
           'type', 'note', 'format', 'plain',
           'value', jsonb_build_object('text', 'note'),
           'visibility', 'private', 'revision', $5,
           'createdAt', $6, 'updatedAt', $6
         ),
         1, 'backfilled'
       )`,
      [spec.id, COLLECTION_ID, spec.subjectId, PRINCIPAL_ID, spec.revision, SEED_TS],
    );
  }

  async function insertRelation(spec: {
    id: string;
    fromNodeId: string;
    toNodeId: string;
    revision: string;
  }): Promise<void> {
    await isolated.runtime.pool.query(
      `insert into resource_id_ledger(resource_id, resource_type) values ($1, 'relation')`,
      [spec.id],
    );
    await isolated.runtime.pool.query(
      `insert into relations (
         id, collection_id, from_node_id, to_node_id, type, label, visibility,
         resource_revision, created_at, updated_at, payload_json,
         payload_schema_version, payload_authority_status
       ) values (
         $1::text, $2::text, $3::text, $4::text, 'related', null, 'private',
         $5::text, $6::timestamptz, $6::timestamptz,
         jsonb_build_object(
           'id', $1, 'collectionId', $2, 'type', 'related',
           'fromNodeId', $3, 'toNodeId', $4,
           'visibility', 'private', 'revision', $5,
           'createdAt', $6, 'updatedAt', $6
         ),
         1, 'backfilled'
       )`,
      [spec.id, COLLECTION_ID, spec.fromNodeId, spec.toNodeId, spec.revision, SEED_TS],
    );
  }

  function deleteMutation(
    operationId: string,
    resourceId: string,
    parentId: string | null,
    options: { expectedResourceRevision?: string; deleteScope?: 'single' | 'subtree' } = {},
  ): CanonicalMutationInput {
    return {
      operationId,
      collectionId: COLLECTION_ID,
      actor: { principalId: PRINCIPAL_ID, principalType: 'account' },
      mutation: {
        action: 'delete',
        target: { collectionId: COLLECTION_ID, resourceId, resourceKind: 'node' },
        parentId,
        ...(options.expectedResourceRevision ? { expectedResourceRevision: options.expectedResourceRevision } : {}),
        deleteIntent: { scope: options.deleteScope ?? 'subtree' },
      },
    };
  }

  async function executeMutation(
    input: CanonicalMutationInput,
    faultInjector?: { afterPhase(context: PostgresCanonicalMutationFaultContext): void | Promise<void> },
    db = isolated.runtime.db,
  ) {
    const binding = {
      principalId: PRINCIPAL_ID,
      commandScope: `canonical:delete`,
      commandId: input.operationId,
    };
    const fingerprint = `fp-${input.operationId}`;
    return createPostgresCanonicalMutationUnitOfWork(db, {
      ...(faultInjector ? { canonicalFaultInjector: faultInjector } : {}),
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

  async function withDeleteLimits(
    nodes: number,
    depth: number,
    fn: () => Promise<void>,
  ): Promise<void> {
    const prevNodes = process.env.KNOW_N_MAX_DELETE_SUBTREE_NODES;
    const prevDepth = process.env.KNOW_N_MAX_DELETE_SUBTREE_DEPTH;
    process.env.KNOW_N_MAX_DELETE_SUBTREE_NODES = String(nodes);
    process.env.KNOW_N_MAX_DELETE_SUBTREE_DEPTH = String(depth);
    try {
      await fn();
    } finally {
      if (prevNodes === undefined) delete process.env.KNOW_N_MAX_DELETE_SUBTREE_NODES;
      else process.env.KNOW_N_MAX_DELETE_SUBTREE_NODES = prevNodes;
      if (prevDepth === undefined) delete process.env.KNOW_N_MAX_DELETE_SUBTREE_DEPTH;
      else process.env.KNOW_N_MAX_DELETE_SUBTREE_DEPTH = prevDepth;
    }
  }

  async function assertSubtreeTombstoned(
    nodeIds: readonly string[],
    commitOrdinal: bigint,
  ): Promise<void> {
    const rows = await isolated.runtime.pool.query(
      `select n.id, n.resource_revision, n.deleted_at, n.deleted_commit_ordinal::text, n.payload_json,
              rr.revision evidence_revision
       from nodes n
       left join resource_revisions rr
         on rr.collection_id = n.collection_id and rr.resource_id = n.id and rr.ordinal = $2
       where n.id = any($1::text[])
       order by n.id`,
      [nodeIds, commitOrdinal.toString()],
    );
    assert.equal(rows.rowCount, nodeIds.length);
    for (const row of rows.rows) {
      assert.ok(row.deleted_at instanceof Date, `${row.id} must be tombstoned`);
      assert.equal(row.deleted_commit_ordinal, commitOrdinal.toString());
      assert.equal(row.payload_json.deletedCommitOrdinal, commitOrdinal.toString());
      assert.equal(row.payload_json.resourceRevision, row.resource_revision);
      assert.equal(row.evidence_revision, row.resource_revision);
    }
  }

  async function assertZeroWrites(
    operationId: string,
    nodeIds: readonly string[],
    annotationIds: readonly string[],
    relationIds: readonly string[],
  ): Promise<void> {
    const state = await isolated.runtime.pool.query(
      `select
         (select count(*)::int from nodes where id = any($1::text[]) and deleted_at is null) live_nodes,
         (select count(*)::int from annotations where id = any($2::text[]) and deleted_at is not null) annotations_deleted,
         (select count(*)::int from relations where id = any($3::text[]) and deleted_at is not null) relations_deleted,
         (select count(*)::int from operations where operation_id = $4) operations,
         (select count(*)::int from audit_events where operation_id = $4) audit,
         (select count(*)::int from product_command_receipts) receipts,
         (select count(*)::int from outbox_events) outbox,
         (select count(*)::int from resource_revisions) revisions,
         (select commit_ordinal::text from collections where id = $5) ordinal`,
      [nodeIds, annotationIds, relationIds, operationId, COLLECTION_ID],
    );
    assert.deepEqual(state.rows[0], {
      live_nodes: nodeIds.length,
      annotations_deleted: 0,
      relations_deleted: 0,
      operations: 0,
      audit: 0,
      receipts: 0,
      outbox: 0,
      revisions: 0,
      ordinal: '1',
    });
  }

  async function assertOutboxCounts(
    operationId: string,
    expectedTotal: number,
  ): Promise<{ nodeDeletedCount: number; affectedCount: number | null }> {
    const rows = await isolated.runtime.pool.query(
      `select e.event_type, count(*)::int as count,
              max((e.payload_json->>'affectedCount')::int) as affected_count
       from outbox_events e
       join operations o on o.collection_id = e.aggregate_scope and o.commit_ordinal = e.commit_ordinal
       where o.operation_id = $1
       group by e.event_type
       order by e.event_type`,
      [operationId],
    );
    const total = rows.rows.reduce((sum: number, row) => sum + row.count, 0);
    assert.equal(total, expectedTotal, `expected ${expectedTotal} outbox events, got ${total}`);
    const nodeDeleted = rows.rows.find((row) => row.event_type === 'node.deleted');
    assert.ok(nodeDeleted, 'node.deleted summary event must exist');
    assert.equal(nodeDeleted.count, 1, 'the main node.deleted domain event count must be independent of N');
    return { nodeDeletedCount: nodeDeleted.count, affectedCount: nodeDeleted.affected_count as number | null };
  }

  function batchCountsByPrefix(contexts: readonly PostgresCanonicalMutationFaultContext[]): {
    node: number;
    annotation: number;
    relation: number;
  } {
    let node = 0;
    let annotation = 0;
    let relation = 0;
    for (const context of contexts) {
      if (context.phase !== 'resource') continue;
      if (context.resourceId?.startsWith('r14-annotation-')) annotation += 1;
      else if (context.resourceId?.startsWith('r14-relation-')) relation += 1;
      else node += 1;
    }
    return { node, annotation, relation };
  }

  test('size matrix: 1, max and max+1 within a small configured sync budget', async () => {
    await withDeleteLimits(64, 16, async () => {
      await resetFixture();
      const sizeOne = await insertFlatSubtree(1);
      const opOne = randomUUID();
      const resultOne = await executeMutation(deleteMutation(opOne, TARGET_ID, ROOT_ID, {
        expectedResourceRevision: 'r14-target-rev',
        deleteScope: 'subtree',
      }));
      await assertSubtreeTombstoned(sizeOne, resultOne.allocation.commitOrdinal);
      await assertOutboxCounts(opOne, 1);

      await resetFixture();
      const sizeMax = await insertFlatSubtree(64);
      const opMax = randomUUID();
      const resultMax = await executeMutation(deleteMutation(opMax, TARGET_ID, ROOT_ID, {
        expectedResourceRevision: 'r14-target-rev',
        deleteScope: 'subtree',
      }));
      assert.equal(resultMax.allocation.deletedResourceRevisions
        ? Object.keys(resultMax.allocation.deletedResourceRevisions).length : 0, 64);
      await assertSubtreeTombstoned(sizeMax, resultMax.allocation.commitOrdinal);
      await assertOutboxCounts(opMax, 1);

      await resetFixture();
      const sizeOver = await insertFlatSubtree(65);
      const opOver = randomUUID();
      await assert.rejects(
        executeMutation(deleteMutation(opOver, TARGET_ID, ROOT_ID, {
          expectedResourceRevision: 'r14-target-rev',
          deleteScope: 'subtree',
        })),
        (error: unknown) => error instanceof DeleteSubtreeLimitError
          && error.code === 'payload_too_large'
          && /maximum node count of 64/.test(error.message),
      );
      await assertZeroWrites(opOver, sizeOver, [], []);
    });
  }, 120_000);

  test('depth matrix: 1, max and max+1 within a small configured sync budget', async () => {
    await withDeleteLimits(64, 16, async () => {
      await resetFixture();
      const depthOne = await insertChainSubtree(1);
      const opDepthOne = randomUUID();
      const resultOne = await executeMutation(deleteMutation(opDepthOne, TARGET_ID, ROOT_ID, {
        expectedResourceRevision: 'r14-target-rev',
        deleteScope: 'subtree',
      }));
      await assertSubtreeTombstoned(depthOne, resultOne.allocation.commitOrdinal);

      await resetFixture();
      const depthMax = await insertChainSubtree(16);
      const opDepthMax = randomUUID();
      const resultMax = await executeMutation(deleteMutation(opDepthMax, TARGET_ID, ROOT_ID, {
        expectedResourceRevision: 'r14-target-rev',
        deleteScope: 'subtree',
      }));
      await assertSubtreeTombstoned(depthMax, resultMax.allocation.commitOrdinal);

      await resetFixture();
      const depthOver = await insertChainSubtree(17);
      const opDepthOver = randomUUID();
      await assert.rejects(
        executeMutation(deleteMutation(opDepthOver, TARGET_ID, ROOT_ID, {
          expectedResourceRevision: 'r14-target-rev',
          deleteScope: 'subtree',
        })),
        (error: unknown) => error instanceof DeleteSubtreeLimitError
          && error.code === 'payload_too_large'
          && /maximum depth of 16/.test(error.message),
      );
      await assertZeroWrites(opDepthOver, depthOver, [], []);
    });
  }, 120_000);

  test('annotation cascade batches at 128-row boundaries and preserves read-back semantics', async () => {
    for (const annotationCount of [1, 128, 129]) {
      await resetFixture();
      const nodeIds = await insertFlatSubtree(annotationCount + 1);
      const annotationIds = await insertAnnotations(annotationCount);
      const operationId = randomUUID();
      const contexts: PostgresCanonicalMutationFaultContext[] = [];
      const result = await executeMutation(deleteMutation(operationId, TARGET_ID, ROOT_ID, {
        expectedResourceRevision: 'r14-target-rev',
        deleteScope: 'subtree',
      }), {
        afterPhase(context) {
          contexts.push(context);
        },
      });
      const counts = batchCountsByPrefix(contexts);
      assert.equal(counts.annotation, Math.ceil(annotationCount / 128),
        `annotation batch count for A=${annotationCount}`);
      assert.equal(counts.node, Math.ceil(nodeIds.length / 128));
      await assertSubtreeTombstoned(nodeIds, result.allocation.commitOrdinal);
      await assertOutboxCounts(operationId, 1 + annotationCount);
      await assertAnnotationCascades(annotationIds, annotationCount, result.allocation.commitOrdinal, operationId);
    }
  }, 120_000);

  async function assertAnnotationCascades(
    annotationIds: readonly string[],
    annotationCount: number,
    commitOrdinal: bigint,
    operationId: string,
  ): Promise<void> {
    const rows = await isolated.runtime.pool.query(
      `select id, collection_id, subject_type, subject_id, visibility, resource_revision,
              deleted_at, deleted_commit_ordinal::text, payload_json
       from annotations where id = any($1::text[])
       order by id`,
      [annotationIds],
    );
    assert.equal(rows.rowCount, annotationCount);
    const events = await isolated.runtime.pool.query(
      `select count(*)::int count
       from outbox_events e
       join operations o on o.collection_id = e.aggregate_scope and o.commit_ordinal = e.commit_ordinal
       where o.operation_id = $1 and e.event_type = $2`,
      [operationId, ANNOTATION_DELETED_EVENT_TYPE],
    );
    assert.equal(events.rows[0].count, annotationCount);
    for (const row of rows.rows) {
      assert.equal(row.collection_id, COLLECTION_ID);
      assert.equal(row.subject_type, 'node');
      assert.equal(row.visibility, 'private');
      assert.ok(row.deleted_at instanceof Date);
      assert.equal(row.deleted_commit_ordinal, commitOrdinal.toString());
      assert.equal(row.payload_json.revision, row.resource_revision);
      assert.equal(row.payload_json.deletedCommitOrdinal, commitOrdinal.toString());
      assert.equal(row.payload_json.deletionOperationId, operationId);
      assert.equal(row.payload_json.deletedAt, formatUtcDateTime(row.deleted_at));
      assert.equal(row.payload_json.subject.id, row.subject_id);
    }
  }

  test('relation cascade batches at 128-row boundaries and preserves read-back semantics', async () => {
    for (const relationCount of [1, 128, 129]) {
      await resetFixture();
      const nodeIds = await insertFlatSubtree(relationCount + 1);
      const relationIds = await insertRelations(relationCount);
      const operationId = randomUUID();
      const contexts: PostgresCanonicalMutationFaultContext[] = [];
      const result = await executeMutation(deleteMutation(operationId, TARGET_ID, ROOT_ID, {
        expectedResourceRevision: 'r14-target-rev',
        deleteScope: 'subtree',
      }), {
        afterPhase(context) {
          contexts.push(context);
        },
      });
      const counts = batchCountsByPrefix(contexts);
      assert.equal(counts.relation, Math.ceil(relationCount / 128),
        `relation batch count for R=${relationCount}`);
      assert.equal(counts.node, Math.ceil(nodeIds.length / 128));
      await assertSubtreeTombstoned(nodeIds, result.allocation.commitOrdinal);
      await assertOutboxCounts(operationId, 1 + relationCount);
      await assertRelationCascades(relationIds, relationCount, result.allocation.commitOrdinal, operationId);
    }
  }, 120_000);

  async function assertRelationCascades(
    relationIds: readonly string[],
    relationCount: number,
    commitOrdinal: bigint,
    operationId: string,
  ): Promise<void> {
    const rows = await isolated.runtime.pool.query(
      `select id, collection_id, from_node_id, to_node_id, visibility, resource_revision,
              deleted_at, updated_at, deleted_commit_ordinal::text, payload_json
       from relations where id = any($1::text[])
       order by id`,
      [relationIds],
    );
    assert.equal(rows.rowCount, relationCount);
    const events = await isolated.runtime.pool.query(
      `select count(*)::int count
       from outbox_events e
       join operations o on o.collection_id = e.aggregate_scope and o.commit_ordinal = e.commit_ordinal
       where o.operation_id = $1 and e.event_type = $2`,
      [operationId, RELATION_DELETED_EVENT_TYPE],
    );
    assert.equal(events.rows[0].count, relationCount);
    for (const row of rows.rows) {
      assert.equal(row.collection_id, COLLECTION_ID);
      assert.equal(row.visibility, 'private');
      assert.ok(row.deleted_at instanceof Date);
      assert.equal(row.deleted_commit_ordinal, commitOrdinal.toString());
      assert.equal(row.payload_json.revision, row.resource_revision);
      assert.equal(row.payload_json.deletedCommitOrdinal, commitOrdinal.toString());
      assert.equal(row.payload_json.deletionOperationId, operationId);
      assert.equal(row.payload_json.deletedAt, formatUtcDateTime(row.deleted_at));
      assert.equal(row.payload_json.updatedAt, formatUtcDateTime(row.updated_at));
      assert.equal(row.payload_json.fromNodeId, row.from_node_id);
      assert.equal(row.payload_json.toNodeId, row.to_node_id);
    }
  }

  test('multi-sidecar: several annotations across the subtree and two on one node cascade exactly once', async () => {
    await resetFixture();
    await insertFlatSubtree(4);
    await insertAnnotation({ id: 'r14-annotation-a1', subjectId: 'r14-node-0001', revision: 'r14-a-rev-1' });
    await insertAnnotation({ id: 'r14-annotation-a2', subjectId: 'r14-node-0002', revision: 'r14-a-rev-2' });
    await insertAnnotation({ id: 'r14-annotation-a3', subjectId: 'r14-node-0002', revision: 'r14-a-rev-3' });
    await insertAnnotation({ id: 'r14-annotation-a4', subjectId: TARGET_ID, revision: 'r14-a-rev-4' });
    const operationId = randomUUID();
    const result = await executeMutation(deleteMutation(operationId, TARGET_ID, ROOT_ID, {
      expectedResourceRevision: 'r14-target-rev',
      deleteScope: 'subtree',
    }));
    await assertAnnotationCascades(
      ['r14-annotation-a1', 'r14-annotation-a2', 'r14-annotation-a3', 'r14-annotation-a4'],
      4,
      result.allocation.commitOrdinal,
      operationId,
    );
  }, 120_000);

  test('shared relation endpoint cascades once; half-inside and fully-outside relations are exact', async () => {
    await resetFixture();
    await insertFlatSubtree(3);
    await insertOutsideNode('r14-outside-0001');
    await insertOutsideNode('r14-outside-0002');
    const shared = 'r14-relation-shared';
    const half = 'r14-relation-half';
    const outside = 'r14-relation-outside';
    await insertRelation({ id: shared, fromNodeId: 'r14-node-0001', toNodeId: 'r14-node-0002', revision: 'r14-rel-shared-rev' });
    await insertRelation({ id: half, fromNodeId: 'r14-node-0001', toNodeId: 'r14-outside-0001', revision: 'r14-rel-half-rev' });
    await insertRelation({ id: outside, fromNodeId: 'r14-outside-0001', toNodeId: 'r14-outside-0002', revision: 'r14-rel-outside-rev' });
    const operationId = randomUUID();
    const result = await executeMutation(deleteMutation(operationId, TARGET_ID, ROOT_ID, {
      expectedResourceRevision: 'r14-target-rev',
      deleteScope: 'subtree',
    }));
    const rows = await isolated.runtime.pool.query(
      `select id, deleted_at is not null as deleted from relations where id = any($1::text[]) order by id`,
      [[shared, half, outside]],
    );
    const deletedById = new Map(rows.rows.map((row) => [row.id, row.deleted] as const));
    assert.deepEqual(
      [shared, half, outside].map((id) => ({ id, deleted: deletedById.get(id) })),
      [
        { id: shared, deleted: true },
        { id: half, deleted: true },
        { id: outside, deleted: false },
      ],
    );
    const relationEvents = await isolated.runtime.pool.query(
      `select e.payload_json->>'relationId' as relation_id
       from outbox_events e
       join operations o on o.collection_id = e.aggregate_scope and o.commit_ordinal = e.commit_ordinal
       where o.operation_id = $1 and e.event_type = $2
       order by relation_id`,
      [operationId, RELATION_DELETED_EVENT_TYPE],
    );
    assert.deepEqual(
      relationEvents.rows.map((row) => row.relation_id),
      [half, shared],
      'shared endpoint must cascade once and half-inside once',
    );
    const outsideNode = await isolated.runtime.pool.query(
      `select deleted_at is not null as deleted from nodes where id = $1`,
      ['r14-outside-0001'],
    );
    assert.equal(outsideNode.rows[0].deleted, false);
    await assertOutboxCounts(operationId, 1 + 2);
  }, 120_000);

  test('mid-batch stale sidecar revision fails closed with full rollback and zero writes', async () => {
    await resetFixture();
    const nodeIds = await insertFlatSubtree(130);
    const annotationIds = await insertAnnotations(129);
    const operationId = randomUUID();
    const staleId = 'r14-annotation-0129';
    const fault = new CanonicalMutationInvariantError('invalid_canonical_mutation', 'expected stale revision rollback');
    let corrupted = false;
    await assert.rejects(
      executeMutation(deleteMutation(operationId, TARGET_ID, ROOT_ID, {
        expectedResourceRevision: 'r14-target-rev',
        deleteScope: 'subtree',
      }), {
        afterPhase(context) {
          if (context.phase !== 'resource') return;
          if (context.resourceCount === 129 && context.resourceIndex === 127) {
            corrupted = true;
            if (!context.transaction) throw fault;
            return context.transaction.updateTable('annotations').set({
              resource_revision: 'r14-stale-annotation-revision',
              payload_json: sql`payload_json || jsonb_build_object('revision', 'r14-stale-annotation-revision')`,
            }).where('id', '=', staleId).execute();
          }
        },
      }),
      (error: unknown) => error instanceof CanonicalMutationInvariantError
        && error.code === 'invalid_canonical_mutation'
        && /Annotation cascade batch updated \d+ rows instead of 1/.test(error.message),
    );
    assert.equal(corrupted, true, 'the mid-batch fault hook must run');
    await assertZeroWrites(operationId, nodeIds, annotationIds, []);
  }, 120_000);

  test('fault at every batch boundary rolls back nodes, sidecars, operation, audit, outbox and ordinal', async () => {
    const boundaries = [
      { name: 'node batch', phase: 'resource' as const, prefix: 'r14-node-' },
      { name: 'annotation batch', phase: 'resource' as const, prefix: 'r14-annotation-' },
      { name: 'relation batch', phase: 'resource' as const, prefix: 'r14-relation-' },
      { name: 'revision evidence', phase: 'revision' as const, prefix: undefined },
      { name: 'operation append', phase: 'operation' as const, prefix: undefined },
      { name: 'audit append', phase: 'audit' as const, prefix: undefined },
      { name: 'outbox append', phase: 'outbox' as const, prefix: undefined },
    ] as const;
    for (const boundary of boundaries) {
      await resetFixture();
      const nodeIds = await insertFlatSubtree(130);
      const annotationIds = await insertAnnotations(129);
      const relationIds = await insertRelations(129);
      const operationId = randomUUID();
      const injected = new Error(`injected ${boundary.name} fault`);
      let fired = false;
      await assert.rejects(
        executeMutation(deleteMutation(operationId, TARGET_ID, ROOT_ID, {
          expectedResourceRevision: 'r14-target-rev',
          deleteScope: 'subtree',
        }), {
          afterPhase(context) {
            if (context.phase !== boundary.phase) return;
            if (boundary.prefix !== undefined && !context.resourceId?.startsWith(boundary.prefix)) return;
            fired = true;
            throw injected;
          },
        }),
        (error: unknown) => error === injected,
      );
      assert.equal(fired, true, `${boundary.name} fault must fire`);
      await assertZeroWrites(operationId, nodeIds, annotationIds, relationIds);
    }
  }, 120_000);

  test('main node.deleted domain event count is independent of subtree node count', async () => {
    for (const nodeCount of [1, 300]) {
      await resetFixture();
      const nodeIds = await insertFlatSubtree(nodeCount);
      const operationId = randomUUID();
      const result = await executeMutation(deleteMutation(operationId, TARGET_ID, ROOT_ID, {
        expectedResourceRevision: 'r14-target-rev',
        deleteScope: 'subtree',
      }));
      const counts = await assertOutboxCounts(operationId, 1);
      assert.equal(counts.affectedCount, nodeCount);
      assert.equal(result.allocation.deletedResourceRevisions
        ? Object.keys(result.allocation.deletedResourceRevisions).length : 0, nodeCount);
      await assertSubtreeTombstoned(nodeIds, result.allocation.commitOrdinal);
    }
  }, 120_000);

  test('records bounded heap, statements, per-chunk payload size, tx duration and lock duration', async () => {
    await resetFixture();
    const nodeIds = await insertFlatSubtree(301);
    const annotationIds = await insertAnnotations(300);
    const relationIds = await insertRelations(300);
    const operationId = randomUUID();
    const baseExecutor = isolated.runtime.db.getExecutor();
    const captured: Array<{ sql: string; parameters: readonly unknown[] }> = [];
    const countedDb = isolated.runtime.db.withPlugin({
      transformQuery(args) {
        const compiled = baseExecutor.compileQuery(args.node, args.queryId);
        captured.push({ sql: compiled.sql, parameters: compiled.parameters });
        return args.node;
      },
      async transformResult(args) {
        return args.result;
      },
    });
    const heapBefore = process.memoryUsage().heapUsed;
    const startedAt = performance.now();
    let firstResourceAt = 0;
    let outboxAt = 0;
    const result = await executeMutation(deleteMutation(operationId, TARGET_ID, ROOT_ID, {
      expectedResourceRevision: 'r14-target-rev',
      deleteScope: 'subtree',
    }), {
      afterPhase(context) {
        if (context.phase === 'resource' && firstResourceAt === 0) firstResourceAt = performance.now();
        if (context.phase === 'outbox' && outboxAt === 0) outboxAt = performance.now();
      },
    }, countedDb);
    const txDurationMs = performance.now() - startedAt;
    const heapDeltaBytes = process.memoryUsage().heapUsed - heapBefore;
    const lockWriteMs = outboxAt - firstResourceAt;

    const recordsetLengths: number[] = [];
    for (const entry of captured) {
      if (!entry.sql.includes('jsonb_to_recordset')) continue;
      for (const parameter of entry.parameters) {
        if (typeof parameter !== 'string') continue;
        try {
          const parsed = JSON.parse(parameter);
          if (Array.isArray(parsed)) {
            recordsetLengths.push(parsed.length);
            break;
          }
        } catch {
          // not the recordset payload parameter
        }
      }
    }
    const annotationUpdateStatements = captured.filter((entry) =>
      entry.sql.includes('jsonb_to_recordset') && /update\s+annotations/i.test(entry.sql));
    const relationUpdateStatements = captured.filter((entry) =>
      entry.sql.includes('jsonb_to_recordset') && /update\s+relations/i.test(entry.sql));
    const nodeUpdateStatements = captured.filter((entry) =>
      entry.sql.includes('jsonb_to_recordset') && /update\s+nodes/i.test(entry.sql));
    assert.equal(nodeUpdateStatements.length, Math.ceil(301 / 128),
      `node tombstones must be one batched UPDATE..RETURNING per chunk, got ${nodeUpdateStatements.length}`);
    assert.equal(annotationUpdateStatements.length, Math.ceil(300 / 128),
      `annotation cascades must be one batched UPDATE..RETURNING per chunk, got ${annotationUpdateStatements.length}`);
    assert.equal(relationUpdateStatements.length, Math.ceil(300 / 128),
      `relation cascades must be one batched UPDATE..RETURNING per chunk, got ${relationUpdateStatements.length}`);
    assert.ok(recordsetLengths.length >= 12,
      `expected node tombstone + node revision + annotation + relation recordset batches, got ${recordsetLengths.length}`);
    assert.ok(Math.max(...recordsetLengths) <= 128,
      `recordset statements must stay bounded by the batch size, got ${Math.max(...recordsetLengths)}`);
    assert.ok(captured.length < 4000,
      `statement count ${captured.length} must stay a loose bound; the per-event outbox appends dominate`);
    await assertSubtreeTombstoned(nodeIds, result.allocation.commitOrdinal);
    await assertOutboxCounts(operationId, 1 + 300 + 300);
    await assertAnnotationCascades(annotationIds, 300, result.allocation.commitOrdinal, operationId);
    await assertRelationCascades(relationIds, 300, result.allocation.commitOrdinal, operationId);
    // Measurements are recorded for the sync-delete budget evidence; only loose bounds assert.
    assert.ok(txDurationMs < 60_000, `tx duration ${txDurationMs}ms must be a loose upper bound`);
    assert.ok(lockWriteMs < 60_000, `lock write phase ${lockWriteMs}ms must be a loose upper bound`);
    assert.ok(heapDeltaBytes < 512 * 1024 * 1024, `heap delta ${heapDeltaBytes} must stay loose-bounded`);
    console.log(JSON.stringify({
      r14: 'subtree-delete-batching',
      nodes: nodeIds.length,
      annotations: annotationIds.length,
      relations: relationIds.length,
      txDurationMs,
      lockWriteMs,
      heapDeltaBytes,
      statements: captured.length,
      maxRecordsetBatchLength: Math.max(...recordsetLengths),
    }));
  }, 120_000);
});
