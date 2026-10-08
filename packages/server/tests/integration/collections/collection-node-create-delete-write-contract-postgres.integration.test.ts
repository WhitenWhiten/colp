import assert from 'node:assert/strict';
import { afterAll, beforeAll } from 'vitest';
import {
  createPostgresCanonicalMutationUnitOfWork,
} from '../../../src/infrastructure/collections/index.js';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import {
  createCollectionNode,
  deleteCollectionNode,
} from '../../../src/modules/collections/index.js';
import {
  COLLECTION_NODE_CREATE_DELETE_CONTRACT_FIXTURE,
  defineCollectionNodeCreateDeleteWriteContract,
} from '../../contracts/collection-node-create-delete-write.contract.js';
import {
  readCollectionNodeContractEvidenceCounts,
  resetCollectionNodeContractFixture,
} from '../../support/collection-node-contract-postgres.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';

describeWithPostgres('PostgreSQL collection-node create/delete write adapter', () => {
  let isolated: IsolatedPostgresRuntime;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('node_write_contract', { maxConnections: 4 });
    await runMigrations(isolated.runtime.db, 'latest');
  }, 180_000);

  afterAll(async () => isolated?.close());

  defineCollectionNodeCreateDeleteWriteContract({
    name: 'shared collection-node create/delete behavior',
    createAdapter: async () => {
      const fixture = COLLECTION_NODE_CREATE_DELETE_CONTRACT_FIXTURE;
      await resetCollectionNodeContractFixture(isolated.runtime, {
        principals: [
          { principalId: fixture.ownerPrincipalId, subjectId: fixture.ownerSubjectId },
        ],
        collection: {
          id: fixture.collectionId,
          ownerSubjectId: fixture.ownerSubjectId,
          rootNodeId: fixture.rootId,
          title: 'Collection node create/delete contract',
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
            id: fixture.leafId,
            parentId: fixture.rootId,
            kind: 'bookmark',
            title: 'Leaf',
            url: 'https://example.test/leaf',
            positionToken: 'a',
            resourceRevision: fixture.leafResourceRevision,
            childrenRevision: fixture.leafChildrenRevision,
          },
          {
            id: fixture.folderId,
            parentId: fixture.rootId,
            kind: 'folder',
            title: 'Folder',
            positionToken: 'm',
            resourceRevision: fixture.folderResourceRevision,
            childrenRevision: fixture.folderChildrenRevision,
          },
          {
            id: fixture.childId,
            parentId: fixture.folderId,
            kind: 'bookmark',
            title: 'Child',
            url: 'https://example.test/child',
            positionToken: 'a',
            resourceRevision: fixture.childResourceRevision,
            childrenRevision: fixture.childChildrenRevision,
          },
        ],
      });

      const unitOfWork = () => createPostgresCanonicalMutationUnitOfWork(isolated.runtime.db);
      return {
        create: (input) => unitOfWork().execute((ports) => createCollectionNode(ports, input)),
        delete: (input) => unitOfWork().execute((ports) => deleteCollectionNode(ports, input)),
        snapshot: async () => {
          const nodeRows = await isolated.runtime.pool.query(
            `select id, parent_id, kind, title, visibility, position_token,
                    resource_revision, children_revision, deleted_at,
                    deleted_commit_ordinal::text
             from nodes where collection_id = $1`,
            [fixture.collectionId],
          );
          const nodes = Object.fromEntries(nodeRows.rows.map((row) => [row.id, {
            parentId: row.parent_id,
            kind: row.kind,
            title: row.title,
            visibility: row.visibility,
            positionToken: row.position_token,
            resourceRevision: row.resource_revision,
            childrenRevision: row.children_revision,
            deleted: row.deleted_at !== null,
            deletedCommitOrdinal: row.deleted_commit_ordinal === null
              ? null
              : BigInt(row.deleted_commit_ordinal),
          }]));
          for (const nodeId of [
            fixture.leafId,
            fixture.folderId,
            fixture.childId,
            fixture.newNodeId,
          ]) {
            if (!Object.hasOwn(nodes, nodeId)) nodes[nodeId] = null;
          }
          const collection = await isolated.runtime.pool.query(
            `select content_revision, policy_revision, commit_ordinal::text
             from collections where id = $1`,
            [fixture.collectionId],
          );
          const collectionRow = collection.rows[0];
          assert.ok(collectionRow);
          const root = nodeRows.rows.find((row) => row.id === fixture.rootId);
          assert.ok(root);
          const [ledger, operations, audit, createdOutbox, deletedOutbox] = await Promise.all([
            isolated.runtime.pool.query(
              `select resource_id from resource_id_ledger order by resource_id`,
            ),
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
               where aggregate_scope = $1 and handler_name = 'node_created_projection'
               order by commit_ordinal`,
              [fixture.collectionId],
            ),
            isolated.runtime.pool.query(
              `select event_type from outbox_events
               where aggregate_scope = $1 and handler_name = 'node_deleted_projection'
               order by commit_ordinal`,
              [fixture.collectionId],
            ),
          ]);
          return {
            nodes,
            rootChildrenRevision: root.children_revision,
            collection: {
              contentRevision: collectionRow.content_revision,
              policyRevision: collectionRow.policy_revision,
              commitOrdinal: BigInt(collectionRow.commit_ordinal),
            },
            reservedResourceIds: ledger.rows.map((row) => row.resource_id),
            evidence: await readCollectionNodeContractEvidenceCounts(
              isolated.runtime,
              fixture.collectionId,
            ),
            operationTypes: operations.rows.map((row) => row.operation_type),
            auditEventTypes: audit.rows.map((row) => row.event_type),
            createdOutboxEventTypes: createdOutbox.rows.map((row) => row.event_type),
            deletedOutboxEventTypes: deletedOutbox.rows.map((row) => row.event_type),
          };
        },
      };
    },
  });
});
