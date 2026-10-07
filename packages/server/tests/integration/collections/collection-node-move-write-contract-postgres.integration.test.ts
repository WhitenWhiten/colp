import assert from 'node:assert/strict';
import { afterAll, beforeAll, describe, test } from 'vitest';
import {
  createPostgresCanonicalMutationUnitOfWork,
} from '../../../src/infrastructure/collections/index.js';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import {
  moveCollectionNode,
  NodeConflictError,
  CollectionPreconditionError,
  CollectionsError,
  moveCollectionNodeCommandScope,
  strongEntityTag,
  type MoveCollectionNodeInput,
} from '../../../src/modules/collections/index.js';
import {
  COLLECTION_NODE_MOVE_CONTRACT_FIXTURE,
  defineCollectionNodeMoveWriteContract,
} from '../../contracts/collection-node-move-write.contract.js';
import {
  readCollectionNodeContractEvidenceCounts,
  resetCollectionNodeContractFixture,
} from '../../support/collection-node-contract-postgres.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';

describeWithPostgres('PostgreSQL collection-node move write adapter', () => {
  let isolated: IsolatedPostgresRuntime;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('node_move_contract', { maxConnections: 4 });
    await runMigrations(isolated.runtime.db, 'latest');
  }, 180_000);

  afterAll(async () => isolated?.close());

  defineCollectionNodeMoveWriteContract({
    name: 'shared collection-node move behavior',
    createAdapter: async () => {
      const fixture = COLLECTION_NODE_MOVE_CONTRACT_FIXTURE;
      await resetCollectionNodeContractFixture(isolated.runtime, {
        principals: [
          { principalId: fixture.ownerPrincipalId, subjectId: fixture.ownerSubjectId },
        ],
        collection: {
          id: fixture.collectionId,
          ownerSubjectId: fixture.ownerSubjectId,
          rootNodeId: fixture.rootId,
          title: 'Collection node move contract',
          resourceRevision: fixture.collectionResourceRevision,
          contentRevision: fixture.contentRevision,
          policyRevision: fixture.policyRevision,
          commitOrdinal: 2n,
        },
        memberships: [
          { subjectId: fixture.ownerSubjectId, role: 'owner' },
        ],
        nodes: [
          {
            id: fixture.rootId,
            parentId: null,
            kind: 'folder',
            isRoot: true,
            title: 'Root',
            positionToken: null,
            resourceRevision: fixture.rootResourceRevision,
            childrenRevision: fixture.rootChildrenRevision,
          },
          {
            id: fixture.folderId,
            parentId: fixture.rootId,
            kind: 'folder',
            title: 'Folder',
            positionToken: 'a',
            resourceRevision: fixture.folderResourceRevision,
            childrenRevision: fixture.folderChildrenRevision,
          },
          {
            id: fixture.childId,
            parentId: fixture.folderId,
            kind: 'folder',
            title: 'Child',
            positionToken: 'a',
            resourceRevision: fixture.childResourceRevision,
            childrenRevision: fixture.childChildrenRevision,
          },
          {
            id: fixture.targetId,
            parentId: fixture.rootId,
            kind: 'folder',
            title: 'Move target',
            positionToken: 'm',
            resourceRevision: fixture.targetResourceRevision,
            childrenRevision: fixture.targetChildrenRevision,
          },
        ],
      });

      return {
        execute: (input) => createPostgresCanonicalMutationUnitOfWork(isolated.runtime.db)
          .execute((ports) => moveCollectionNode(ports, input)),
        snapshot: async () => {
          const rows = await isolated.runtime.pool.query(
            `select n.id, n.parent_id, n.position_token, n.resource_revision,
                    n.children_revision, c.content_revision, c.policy_revision,
                    c.commit_ordinal::text
             from nodes n join collections c on c.id = n.collection_id
             where n.id = any($1::text[])`,
            [[fixture.targetId, fixture.folderId, fixture.rootId]],
          );
          const byId = new Map(rows.rows.map((row) => [row.id, row]));
          const target = byId.get(fixture.targetId);
          const folder = byId.get(fixture.folderId);
          const sourceParent = byId.get(fixture.rootId);
          assert.ok(target && folder && sourceParent);
          const [operations, audit, outbox] = await Promise.all([
            isolated.runtime.pool.query(
              `select operation_type from operations where collection_id = $1 order by commit_ordinal`,
              [fixture.collectionId],
            ),
            isolated.runtime.pool.query(
              `select event_type from audit_events where collection_id = $1 order by created_at`,
              [fixture.collectionId],
            ),
            isolated.runtime.pool.query(
              `select event_type from outbox_events
               where aggregate_scope = $1 and handler_name = 'node_moved_projection'
               order by commit_ordinal`,
              [fixture.collectionId],
            ),
          ]);
          return {
            target: {
              parentId: target.parent_id,
              positionToken: target.position_token,
              resourceRevision: target.resource_revision,
            },
            folderParentId: folder.parent_id,
            sourceParentChildrenRevision: sourceParent.children_revision,
            targetParentChildrenRevision: folder.children_revision,
            collection: {
              contentRevision: target.content_revision,
              policyRevision: target.policy_revision,
              commitOrdinal: BigInt(target.commit_ordinal),
            },
            evidence: await readCollectionNodeContractEvidenceCounts(
              isolated.runtime,
              fixture.collectionId,
            ),
            operationTypes: operations.rows.map((item) => item.operation_type),
            auditEventTypes: audit.rows.map((item) => item.event_type),
            primaryOutboxEventTypes: outbox.rows.map((item) => item.event_type),
          };
        },
      };
    },
  });

  // -------------------------------------------------------------------------
  // FO-06 manual-order interaction invariants exercised against the real
  // PostgreSQL adapter. The error codes themselves are asserted in the
  // memory unit suite (move-collection-node.test.ts) and the 409/412 status
  // mapping in product-command-mapping.test.ts; these cases prove the PG
  // adapter refuses each stale/foreign move with zero durable evidence, so a
  // UI refresh-and-retry can never double-apply a rejected command.
  // -------------------------------------------------------------------------
  describe('FO-06 manual reorder interaction invariants (PostgreSQL adapter)', () => {
    const fixture = COLLECTION_NODE_MOVE_CONTRACT_FIXTURE;

    async function seedFixture(): Promise<void> {
      await resetCollectionNodeContractFixture(isolated.runtime, {
        principals: [
          { principalId: fixture.ownerPrincipalId, subjectId: fixture.ownerSubjectId },
        ],
        collection: {
          id: fixture.collectionId,
          ownerSubjectId: fixture.ownerSubjectId,
          rootNodeId: fixture.rootId,
          title: 'Collection node move contract',
          resourceRevision: fixture.collectionResourceRevision,
          contentRevision: fixture.contentRevision,
          policyRevision: fixture.policyRevision,
          commitOrdinal: 2n,
        },
        memberships: [
          { subjectId: fixture.ownerSubjectId, role: 'owner' },
        ],
        nodes: [
          {
            id: fixture.rootId,
            parentId: null,
            kind: 'folder',
            isRoot: true,
            title: 'Root',
            positionToken: null,
            resourceRevision: fixture.rootResourceRevision,
            childrenRevision: fixture.rootChildrenRevision,
          },
          {
            id: fixture.folderId,
            parentId: fixture.rootId,
            kind: 'folder',
            title: 'Folder',
            positionToken: 'a',
            resourceRevision: fixture.folderResourceRevision,
            childrenRevision: fixture.folderChildrenRevision,
          },
          {
            id: fixture.childId,
            parentId: fixture.folderId,
            kind: 'folder',
            title: 'Child',
            positionToken: 'a',
            resourceRevision: fixture.childResourceRevision,
            childrenRevision: fixture.childChildrenRevision,
          },
          {
            id: fixture.targetId,
            parentId: fixture.rootId,
            kind: 'folder',
            title: 'Move target',
            positionToken: 'm',
            resourceRevision: fixture.targetResourceRevision,
            childrenRevision: fixture.targetChildrenRevision,
          },
        ],
      });
    }

    function reorderInput(overrides: Partial<MoveCollectionNodeInput>): MoveCollectionNodeInput {
      const collectionId = overrides.collectionId ?? fixture.collectionId;
      const nodeId = overrides.nodeId ?? fixture.targetId;
      return {
        actor: {
          principalId: fixture.ownerPrincipalId,
          principalType: 'account',
          subjectId: fixture.ownerSubjectId,
        },
        command: {
          commandId: '61616161-6161-4161-8161-616161616161',
          fingerprint: 'c'.repeat(64),
          commandScope: moveCollectionNodeCommandScope(collectionId, nodeId),
        },
        collectionId,
        nodeId,
        ifMatch: overrides.ifMatch ?? strongEntityTag(fixture.targetResourceRevision),
        newParentId: overrides.newParentId ?? fixture.rootId,
        afterId: overrides.afterId === undefined ? null : overrides.afterId,
        beforeId: overrides.beforeId ?? null,
        baseSourceParentRevision:
          overrides.baseSourceParentRevision ?? fixture.rootChildrenRevision,
        baseTargetParentRevision:
          overrides.baseTargetParentRevision ?? fixture.rootChildrenRevision,
        operationId: '62626262-6262-4262-8262-626262626262',
      };
    }

    async function assertNoDurableEvidence(): Promise<void> {
      const evidence = await readCollectionNodeContractEvidenceCounts(
        isolated.runtime,
        fixture.collectionId,
      );
      assert.deepEqual(
        {
          receipts: evidence.receipts,
          resourceRevisions: evidence.resourceRevisions,
          contentRevisions: evidence.contentRevisions,
          policyRevisions: evidence.policyRevisions,
          childrenRevisions: evidence.childrenRevisions,
          operations: evidence.operations,
          audit: evidence.audit,
          outbox: evidence.outbox,
        },
        {
          receipts: 0,
          resourceRevisions: 0,
          contentRevisions: 0,
          policyRevisions: 0,
          childrenRevisions: 0,
          operations: 0,
          audit: 0,
          outbox: 0,
        },
      );
      const row = await isolated.runtime.pool.query(
        `select n.parent_id, n.position_token, c.commit_ordinal::text
         from nodes n join collections c on c.id = n.collection_id
         where n.id = $1`,
        [fixture.targetId],
      );
      assert.equal(row.rows[0]?.parent_id, fixture.rootId);
      assert.equal(row.rows[0]?.position_token, 'm');
      assert.equal(row.rows[0]?.commit_ordinal, '2');
    }

    test('stale node If-Match is refused with zero durable evidence (412 refresh-and-retry)', async () => {
      await seedFixture();
      await assert.rejects(
        createPostgresCanonicalMutationUnitOfWork(isolated.runtime.db)
          .execute((ports) => moveCollectionNode(ports, reorderInput({
            ifMatch: strongEntityTag('stale-node-revision'),
          }))),
        (error: unknown) => {
          assert.ok(error instanceof CollectionPreconditionError);
          assert.equal(error.code, 'precondition_failed');
          assert.equal(error.currentEtag, strongEntityTag(fixture.targetResourceRevision));
          return true;
        },
      );
      await assertNoDurableEvidence();
    }, 60_000);

    test('stale source-parent children revision is refused with zero durable evidence (409 refresh-and-retry)', async () => {
      await seedFixture();
      await assert.rejects(
        createPostgresCanonicalMutationUnitOfWork(isolated.runtime.db)
          .execute((ports) => moveCollectionNode(ports, reorderInput({
            baseSourceParentRevision: 'stale-source-children',
          }))),
        (error: unknown) => {
          assert.ok(error instanceof NodeConflictError);
          assert.equal(error.code, 'position_context_stale');
          return true;
        },
      );
      await assertNoDurableEvidence();
    }, 60_000);

    test('newParent from another collection is refused with zero durable evidence', async () => {
      await seedFixture();
      // A real second collection whose folder is invisible to the source
      // collection's node reader: the canonical move must refuse it. The
      // root/collection FKs are deferred, so the rows are committed together.
      const client = await isolated.runtime.pool.connect();
      try {
        await client.query('begin');
        await client.query(
          `insert into resource_id_ledger(resource_id, resource_type)
           values ($1, 'collection'), ($2, 'node'), ($3, 'node')`,
          ['foreign-collection', 'foreign-folder', 'foreign-root'],
        );
        await client.query(
          `insert into collections (
             id, owner_subject_id, title, summary, kind, visibility, root_node_id,
             resource_revision, content_revision, policy_revision, commit_ordinal
           ) values ($1, $2, $3, null, 'bookmarks', 'private', $4, $5, $5, $5, 1)`,
          ['foreign-collection', fixture.ownerSubjectId, 'Foreign collection', 'foreign-root', 'foreign-collection-res'],
        );
        await client.query(
          `insert into nodes (
             id, collection_id, parent_id, kind, is_root, title, url, description,
             tags, visibility, position_token, resource_revision, children_revision
           ) values ($1, $2, $3, 'folder', true, 'Foreign root', null, null,
             '[]'::jsonb, 'inherit', null, 'foreign-root-res', 'foreign-root-ch')`,
          ['foreign-root', 'foreign-collection', null],
        );
        await client.query(
          `insert into nodes (
             id, collection_id, parent_id, kind, is_root, title, url, description,
             tags, visibility, position_token, resource_revision, children_revision
           ) values ($1, $2, $3, 'folder', false, 'Foreign folder', null, null,
             '[]'::jsonb, 'inherit', 'a', 'foreign-folder-res', 'foreign-folder-ch')`,
          ['foreign-folder', 'foreign-collection', 'foreign-root'],
        );
        await client.query('commit');
      } catch (error) {
        await client.query('rollback');
        throw error;
      } finally {
        client.release();
      }
      await assert.rejects(
        createPostgresCanonicalMutationUnitOfWork(isolated.runtime.db)
          .execute((ports) => moveCollectionNode(ports, reorderInput({
            newParentId: 'foreign-folder',
            baseTargetParentRevision: 'foreign-folder-ch',
          }))),
        (error: unknown) => {
          assert.ok(error instanceof CollectionsError);
          assert.equal(error.code, 'invalid_node_parent');
          return true;
        },
      );
      // The foreign parent must never have been adopted by the source node.
      const row = await isolated.runtime.pool.query(
        `select n.parent_id, n.collection_id
         from nodes n where n.id = $1`,
        [fixture.targetId],
      );
      assert.equal(row.rows[0]?.parent_id, fixture.rootId);
      assert.equal(row.rows[0]?.collection_id, fixture.collectionId);
      await assertNoDurableEvidence();
    }, 60_000);
  });
});
