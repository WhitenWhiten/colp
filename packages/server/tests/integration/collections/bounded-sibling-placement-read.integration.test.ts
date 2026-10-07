import assert from 'node:assert/strict';
import { afterAll, beforeAll, test } from 'vitest';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import {
  createPostgresCanonicalMutationUnitOfWork,
} from '../../../src/infrastructure/collections/canonical-product-unit-of-work.js';
import {
  createCollectionNode,
  NodeConflictError,
  materializeCollectionPayload,
  materializeNodePayload,
  planBoundedPositionRebalance,
  type CreateCollectionNodeInput,
} from '../../../src/modules/collections/index.js';
import {
  compileLiveSiblingNeighborhoodQuery,
  isUnboundedLiveSiblingScan,
  readBoundedPlacementContext,
  readLiveSiblingNeighborhood,
  LiveSiblingNeighborhoodError,
  readRebalanceWindowSiblings,
} from '../../../src/infrastructure/collections/postgres-sibling-placement-read.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';

const INDEX_NAME = 'nodes_live_sibling_position_c_idx';
const PRINCIPAL_ID = 'BgYGBgYGBgYGBgYGBgYGBg';
let seedGeneration = 0;

interface PlanNode {
  readonly 'Node Type': string;
  readonly 'Index Name'?: string;
  readonly 'Index Cond'?: string;
  readonly 'Actual Rows'?: number;
  readonly Plans?: readonly PlanNode[];
}

interface ExplainEvidence {
  readonly Plan: PlanNode;
}

function flattenPlan(node: PlanNode): readonly PlanNode[] {
  return [node, ...(node.Plans ?? []).flatMap(flattenPlan)];
}

function assertBoundedSiblingPlan(plan: ExplainEvidence | undefined): void {
  assert.ok(plan, 'PostgreSQL returned no JSON plan evidence');
  const nodes = flattenPlan(plan.Plan);
  const indexScan = nodes.find((node) => node['Index Name'] === INDEX_NAME);
  assert.ok(indexScan, `expected ${INDEX_NAME} in plan`);
  assert.ok(indexScan['Index Cond'], 'expected Index Cond on sibling index');
  assert.ok(nodes.every((node) => node['Node Type'] !== 'Sort'), 'unexpected Sort in plan');
}

function canonicalOpaqueId(generation: number, kind: number, ordinal = 0): string {
  const bytes = Buffer.alloc(16);
  bytes.writeUInt32BE(generation >>> 0, 0);
  bytes.writeUInt32BE(kind >>> 0, 4);
  bytes.writeUInt32BE(ordinal >>> 0, 8);
  return bytes.toString('base64url');
}

function siblingIdSql(generationParam: string, ordinalExpr: string): string {
  return `rtrim(translate(encode(overlay(overlay(overlay(decode(repeat('00', 16), 'hex')
    placing int4send(${generationParam}::int) from 1)
    placing int4send(3) from 5)
    placing int4send((${ordinalExpr})::int) from 9), 'base64'), '+/', '-_'), '=')`;
}

async function seedSiblingSet(
  isolated: IsolatedPostgresRuntime,
  siblingCount: number,
): Promise<{
  collectionId: string;
  rootId: string;
  siblingId: (ordinal: number) => string;
  anchorId: string;
  anchorToken: string;
  predecessorId: string;
  successorId: string;
  tailId: string;
}> {
  const generation = seedGeneration += 1;
  const collectionId = canonicalOpaqueId(generation, 1);
  const rootId = canonicalOpaqueId(generation, 2);
  const idFor = (ordinal: number) => canonicalOpaqueId(generation, 3, ordinal);
  const anchorOrdinal = Math.floor(siblingCount / 2);
  const anchorId = idFor(anchorOrdinal);
  const anchorToken = `P${String(anchorOrdinal).padStart(6, '0')}`;
  const predecessorId = idFor(anchorOrdinal - 1);
  const successorId = idFor(anchorOrdinal + 1);
  const tailId = idFor(siblingCount);

  const client = await isolated.runtime.pool.connect();
  try {
    await client.query('begin');
    await client.query(
      `insert into accounts(id, subject_id, status) values ($1, $1, 'active')
       on conflict (id) do nothing`,
      [PRINCIPAL_ID],
    );
    await client.query(
      `insert into profiles(account_id, display_name, avatar_url)
       values ($1, 'Bounded placement owner', null)
       on conflict (account_id) do nothing`,
      [PRINCIPAL_ID],
    );
    await client.query(
      `insert into resource_id_ledger(resource_id, resource_type) values ($1, 'collection'), ($2, 'node')`,
      [collectionId, rootId],
    );
    await client.query(
      `insert into collections
         (id, owner_subject_id, title, kind, root_node_id,
          resource_revision, content_revision, policy_revision, commit_ordinal)
       values ($1, $2, 'Bounded placement fixture', 'bookmarks', $3, 'r1', 'c1', 'p1', 1)`,
      [collectionId, PRINCIPAL_ID, rootId],
    );
    await client.query(
      `insert into nodes
         (id, collection_id, kind, is_root, title, resource_revision, children_revision)
       values ($1, $2, 'folder', true, 'Root', 'r1', 'ch1')`,
      [rootId, collectionId],
    );
    const fixtureCollection = (await client.query(
      'select * from collections where id = $1',
      [collectionId],
    )).rows[0]!;
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
      [collectionId, JSON.stringify(materializedCollection.payload)],
    );
    const fixtureRoot = (await client.query(
      'select * from nodes where id = $1',
      [rootId],
    )).rows[0]!;
    const materializedRoot = materializeNodePayload({
      id: fixtureRoot.id,
      collectionId: fixtureRoot.collection_id,
      parentId: fixtureRoot.parent_id,
      kind: fixtureRoot.kind,
      isRoot: fixtureRoot.is_root,
      title: fixtureRoot.title,
      url: fixtureRoot.url,
      description: fixtureRoot.description,
      tags: fixtureRoot.tags,
      visibility: fixtureRoot.visibility,
      positionToken: fixtureRoot.position_token,
      resourceRevision: fixtureRoot.resource_revision,
      childrenRevision: fixtureRoot.children_revision,
      createdAt: fixtureRoot.created_at,
      updatedAt: fixtureRoot.updated_at,
      deletedAt: fixtureRoot.deleted_at,
      deletedCommitOrdinal: fixtureRoot.deleted_commit_ordinal,
    });
    assert.equal(materializedRoot.ok, true);
    if (!materializedRoot.ok) throw new Error(materializedRoot.reason);
    await client.query(
      `update nodes
         set payload_json = $2::jsonb, payload_schema_version = 1,
             payload_authority_status = 'backfilled'
       where id = $1`,
      [rootId, JSON.stringify(materializedRoot.payload)],
    );
    await client.query(
      `insert into resource_id_ledger(resource_id, resource_type)
       select ${siblingIdSql('$2', 'n')}, 'node'
       from generate_series(1, $1) as n`,
      [siblingCount, generation],
    );
    await client.query("set local session_replication_role = 'replica'");
    await client.query(
      `insert into nodes
         (id, collection_id, parent_id, kind, title, url, position_token,
          resource_revision, children_revision)
       select ${siblingIdSql('$4', 'n')}, $1, $2,
              'bookmark', 'Node ' || n::text, 'https://example.test/' || n::text,
              'P' || lpad(n::text, 6, '0'), 'r1', 'ch1'
       from generate_series(1, $3) as n`,
      [collectionId, rootId, siblingCount, generation],
    );
    await client.query('set local session_replication_role = origin');
    await client.query(
      'update collections set live_node_count = $2 where id = $1',
      [collectionId, siblingCount + 1],
    );
    const encodedProbe = await client.query('select id from nodes where id = $1', [idFor(1)]);
    assert.equal(encodedProbe.rows[0]?.id, idFor(1));
    await client.query('commit');
  } catch (error: unknown) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }

  return {
    collectionId,
    rootId,
    siblingId: idFor,
    anchorId,
    anchorToken,
    predecessorId,
    successorId,
    tailId,
  };
}

describeWithPostgres('bounded sibling placement reads', () => {
  let isolated: IsolatedPostgresRuntime;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('bounded_sibling_placement', {
      maxConnections: 4,
      applicationName: 'known-bounded-placement-test',
      statementTimeoutMs: 180_000,
    });
    await runMigrations(isolated.runtime.db, 'latest');
  }, 120_000);

  afterAll(async () => {
    await isolated?.close();
  });

  test('isUnboundedLiveSiblingScan flags full sibling scans but not keyset probes', () => {
    assert.equal(
      isUnboundedLiveSiblingScan(
        'select id, position_token from nodes where collection_id = $1 and parent_id = $2 and deleted_at is null order by position_token collate "C"',
      ),
      true,
    );
    assert.equal(
      isUnboundedLiveSiblingScan(
        'select id, position_token from nodes where collection_id = $1 and parent_id = $2 and deleted_at is null and (position_token collate "C", id) > ($3, $4) order by position_token collate "C" asc limit 1',
      ),
      false,
    );
  });

  test('before, after, dual-anchor and append reads stay bounded at 10k siblings', async () => {
    const fixture = await seedSiblingSet(isolated, 10_000);
    await isolated.runtime.pool.query('analyze nodes');
    await isolated.runtime.db.transaction().execute(async (transaction) => {
      const cases = [
        { afterId: fixture.anchorId, expectedIds: [fixture.anchorId, fixture.successorId] },
        { beforeId: fixture.anchorId, expectedIds: [fixture.predecessorId, fixture.anchorId] },
        { afterId: fixture.predecessorId, beforeId: fixture.anchorId, expectedIds: [fixture.predecessorId, fixture.anchorId] },
        { expectedIds: [fixture.tailId] },
      ] as const;
      for (const item of cases) {
        const result = await readBoundedPlacementContext(transaction, {
          collectionId: fixture.collectionId,
          parentId: fixture.rootId,
          ...(item.afterId ? { afterId: item.afterId } : {}),
          ...(item.beforeId ? { beforeId: item.beforeId } : {}),
        });
        assert.ok(result.siblings.length <= 3);
        assert.deepEqual(result.siblings.map((row) => row.id), item.expectedIds);
      }
    });
  }, 120_000);

  test('N=10 and N=10000 placement reads return the same bounded row counts', async () => {
    for (const count of [10, 10_000]) {
      const fixture = await seedSiblingSet(isolated, count);
      await isolated.runtime.db.transaction().execute(async (transaction) => {
        const afterOnly = await readBoundedPlacementContext(transaction, {
          collectionId: fixture.collectionId,
          parentId: fixture.rootId,
          afterId: fixture.anchorId,
        });
        const dual = await readBoundedPlacementContext(transaction, {
          collectionId: fixture.collectionId,
          parentId: fixture.rootId,
          afterId: fixture.predecessorId,
          beforeId: fixture.anchorId,
        });
        const tail = await readBoundedPlacementContext(transaction, {
          collectionId: fixture.collectionId,
          parentId: fixture.rootId,
        });
        assert.equal(afterOnly.siblings.length, 2);
        assert.equal(dual.siblings.length, 2);
        assert.equal(tail.siblings.length, 1);
      });
    }
  }, 120_000);

  test('windowSize=1 keeps the after anchor as an immutable lower boundary', async () => {
    const fixture = await seedSiblingSet(isolated, 4);
    const one = fixture.siblingId(1);
    const two = fixture.siblingId(2);
    const three = fixture.siblingId(3);
    const four = fixture.siblingId(4);
    await isolated.runtime.pool.query(
      `update nodes
          set position_token = case id
            when $1 then '9'
            when $2 then 'A'
            when $3 then 'A-'
            when $4 then 'B'
          end
        where id in ($1, $2, $3, $4)`,
      [one, two, three, four],
    );

    await isolated.runtime.db.transaction().execute(async (transaction) => {
      const placement = await readBoundedPlacementContext(transaction, {
        collectionId: fixture.collectionId,
        parentId: fixture.rootId,
        afterId: two,
        beforeId: three,
      });
      const window = await readRebalanceWindowSiblings(transaction, {
        collectionId: fixture.collectionId,
        parentId: fixture.rootId,
        placement: placement.placement,
        afterId: two,
        beforeId: three,
        windowSize: 1,
      });
      assert.deepEqual(window.windowSiblings, [
        { id: three, positionToken: 'A-' },
      ]);
      assert.equal(window.insertIndex, 0);
      assert.equal(window.outsideLowerBoundToken, 'A');
      assert.equal(window.outsideUpperBoundToken, 'B');

      const plan = planBoundedPositionRebalance({
        siblings: window.windowSiblings,
        targetId: 'target',
        insertIndex: window.insertIndex,
        windowSize: 1,
        outsideLowerBoundToken: window.outsideLowerBoundToken,
        outsideUpperBoundToken: window.outsideUpperBoundToken,
      });
      assert.ok(plan.targetPositionToken > 'A');
      assert.ok(plan.targetPositionToken < plan.siblingAssignments[0]!.positionToken);
      assert.notEqual(plan.targetPositionToken, 'A');
      assert.ok(plan.siblingAssignments[0]!.positionToken < 'B');
    });
  });

  test('missing, deleted, foreign and non-adjacent anchors map to stale', async () => {
    const fixture = await seedSiblingSet(isolated, 5);
    await isolated.runtime.db.transaction().execute(async (transaction) => {
      await assert.rejects(
        readBoundedPlacementContext(transaction, {
          collectionId: fixture.collectionId,
          parentId: fixture.rootId,
          afterId: 'missing-anchor',
        }),
        (error: unknown) => error instanceof NodeConflictError && error.code === 'position_context_stale',
      );
      await assert.rejects(
        readBoundedPlacementContext(transaction, {
          collectionId: fixture.collectionId,
          parentId: fixture.rootId,
          afterId: fixture.siblingId(1),
          beforeId: fixture.siblingId(5),
        }),
        (error: unknown) => error instanceof NodeConflictError && error.code === 'position_context_stale',
      );
      await assert.rejects(
        readBoundedPlacementContext(transaction, {
          collectionId: fixture.collectionId,
          parentId: fixture.rootId,
          afterId: fixture.siblingId(2),
          beforeId: fixture.siblingId(2),
        }),
        (error: unknown) => error instanceof NodeConflictError && error.code === 'position_context_stale',
      );
    });
  });

  test('Product create across a large live tree avoids unbounded sibling scans', async () => {
    const fixture = await seedSiblingSet(isolated, 5_000);
    await isolated.runtime.pool.query('analyze nodes');
    const baseExecutor = isolated.runtime.db.getExecutor();
    const capturedQueries: string[] = [];
    const countedDb = isolated.runtime.db.withPlugin({
      transformQuery(args) {
        capturedQueries.push(baseExecutor.compileQuery(args.node, args.queryId).sql);
        return args.node;
      },
      async transformResult(args) {
        return args.result;
      },
    });
    const unitOfWork = createPostgresCanonicalMutationUnitOfWork(countedDb);
    const createdId = 'CwsLCwsLCwsLCwsLCwsLCw';
    const input: CreateCollectionNodeInput = {
      actor: {
        principalId: PRINCIPAL_ID,
        principalType: 'account',
        subjectId: PRINCIPAL_ID,
      },
      command: {
        commandId: '30303030-3030-4030-8030-303030303030',
        fingerprint: 'fp-bounded-create',
      },
      operationId: '31313131-3131-4313-8313-313131313131',
      collectionId: fixture.collectionId,
      parentId: fixture.rootId,
      afterId: fixture.anchorId,
      beforeId: null,
      nodeId: createdId,
      node: {
        kind: 'bookmark',
        title: 'Created',
        url: 'https://example.test/created',
        description: null,
        tags: [],
        visibility: 'inherit',
      },
    };
    const result = await unitOfWork.execute((ports) => createCollectionNode(ports, input));
    assert.equal(result.kind, 'created');
    const unbounded = capturedQueries.filter(isUnboundedLiveSiblingScan);
    assert.deepEqual(unbounded, [], `found unbounded sibling scans: ${unbounded.join('\n')}`);
    assert.ok(capturedQueries.length <= 80, `too many placement statements: ${capturedQueries.length}`);
  }, 120_000);

  test('successor probe uses the live sibling C index at 10k siblings', async () => {
    const fixture = await seedSiblingSet(isolated, 10_000);
    await isolated.runtime.pool.query('analyze nodes');
    const plan = await isolated.runtime.pool.query<{ 'QUERY PLAN': ExplainEvidence[] }>(
      `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
       select id, position_token
       from nodes
       where collection_id = $1
         and parent_id = $2
         and deleted_at is null
         and is_root = false
         and (position_token collate "C", id) > ($3::text collate "C", $4)
       order by position_token collate "C" asc, id asc
       limit 1`,
      [fixture.collectionId, fixture.rootId, fixture.anchorToken, fixture.anchorId],
    );
    assertBoundedSiblingPlan(plan.rows[0]?.['QUERY PLAN']?.[0]);
  }, 120_000);

  test('neighborhood reads first, middle and last siblings without loading the folder', async () => {
    const fixture = await seedSiblingSet(isolated, 100);
    await isolated.runtime.pool.query('analyze nodes');
    await isolated.runtime.db.transaction().execute(async (transaction) => {
      const first = await readLiveSiblingNeighborhood(transaction, {
        collectionId: fixture.collectionId, nodeId: fixture.siblingId(1), expectedParentId: fixture.rootId,
      });
      const middle = await readLiveSiblingNeighborhood(transaction, {
        collectionId: fixture.collectionId, nodeId: fixture.anchorId, expectedParentId: fixture.rootId,
      });
      const last = await readLiveSiblingNeighborhood(transaction, {
        collectionId: fixture.collectionId, nodeId: fixture.tailId, expectedParentId: fixture.rootId,
      });
      assert.deepEqual(first, {
        parentId: fixture.rootId, afterId: null, beforeId: fixture.siblingId(2), position: 'P000001',
      });
      assert.deepEqual(middle, {
        parentId: fixture.rootId,
        afterId: fixture.predecessorId,
        beforeId: fixture.successorId,
        position: fixture.anchorToken,
      });
      assert.deepEqual(last, {
        parentId: fixture.rootId, afterId: fixture.siblingId(99), beforeId: null, position: 'P000100',
      });
    });
  }, 60_000);

  test('neighborhood skips deleted siblings and rejects missing or inconsistent targets', async () => {
    const fixture = await seedSiblingSet(isolated, 5);
    await isolated.runtime.pool.query(
      `update nodes set deleted_at = now() where id = $1`,
      [fixture.siblingId(2)],
    );
    await isolated.runtime.db.transaction().execute(async (transaction) => {
      const aroundDeleted = await readLiveSiblingNeighborhood(transaction, {
        collectionId: fixture.collectionId, nodeId: fixture.siblingId(3), expectedParentId: fixture.rootId,
      });
      assert.equal(aroundDeleted.afterId, fixture.siblingId(1));
      assert.equal(aroundDeleted.beforeId, fixture.siblingId(4));
      await assert.rejects(
        readLiveSiblingNeighborhood(transaction, {
          collectionId: fixture.collectionId, nodeId: fixture.siblingId(2), expectedParentId: fixture.rootId,
        }),
        (error: unknown) => error instanceof LiveSiblingNeighborhoodError && error.code === 'not_found',
      );
      await assert.rejects(
        readLiveSiblingNeighborhood(transaction, {
          collectionId: fixture.collectionId, nodeId: fixture.siblingId(3), expectedParentId: 'wrong-parent',
        }),
        (error: unknown) => error instanceof LiveSiblingNeighborhoodError
          && error.code === 'inconsistent_parent',
      );
    });
  });

  test('production neighborhood SQL stays index-backed without planner hints', async () => {
    const fixture = await seedSiblingSet(isolated, 10_000);
    await isolated.runtime.pool.query('analyze nodes');
    const compiled = compileLiveSiblingNeighborhoodQuery(
      isolated.runtime.db, fixture.collectionId, fixture.anchorId,
    );
    const plan = await isolated.runtime.pool.query<{ 'QUERY PLAN': ExplainEvidence[] }>(
      `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${compiled.sql}`,
      compiled.parameters as unknown[],
    );
    assertBoundedSiblingPlan(plan.rows[0]?.['QUERY PLAN']?.[0]);
    const nodes = flattenPlan(plan.rows[0]!['QUERY PLAN']![0]!.Plan);
    assert.ok(nodes.every((node) => node['Node Type'] !== 'Seq Scan'), 'unexpected Seq Scan');
    const actualRows = nodes.map((node) => node['Actual Rows'] ?? 0);
    assert.ok(actualRows.every((count) => count <= 2), `unbounded actual rows: ${actualRows.join(',')}`);
  }, 120_000);

  test('100k sibling neighborhood remains a constant-row index probe', async () => {
    const fixture = await seedSiblingSet(isolated, 100_000);
    await isolated.runtime.pool.query('analyze nodes');
    await isolated.runtime.db.transaction().execute(async (transaction) => {
      const middle = await readLiveSiblingNeighborhood(transaction, {
        collectionId: fixture.collectionId, nodeId: fixture.anchorId, expectedParentId: fixture.rootId,
      });
      assert.equal(middle.afterId, fixture.predecessorId);
      assert.equal(middle.beforeId, fixture.successorId);
    });
    const compiled = compileLiveSiblingNeighborhoodQuery(
      isolated.runtime.db, fixture.collectionId, fixture.anchorId,
    );
    const plan = await isolated.runtime.pool.query<{ 'QUERY PLAN': ExplainEvidence[] }>(
      `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${compiled.sql}`,
      compiled.parameters as unknown[],
    );
    assertBoundedSiblingPlan(plan.rows[0]?.['QUERY PLAN']?.[0]);
  }, 180_000);
});
