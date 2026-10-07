import assert from 'node:assert/strict';
import { afterAll, beforeAll } from 'vitest';
import {
  createPostgresCanonicalMutationUnitOfWork,
} from '../../../src/infrastructure/collections/index.js';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import { updateCollectionNode } from '../../../src/modules/collections/index.js';
import {
  COLLECTION_NODE_UPDATE_CONTRACT_FIXTURE,
  defineCollectionNodeUpdateWriteContract,
} from '../../contracts/collection-node-update-write.contract.js';
import {
  readCollectionNodeContractEvidenceCounts,
  resetCollectionNodeContractFixture,
} from '../../support/collection-node-contract-postgres.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';

describeWithPostgres('PostgreSQL collection-node update write adapter', () => {
  let isolated: IsolatedPostgresRuntime;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('node_update_contract', { maxConnections: 4 });
    await runMigrations(isolated.runtime.db, 'latest');
  }, 180_000);

  afterAll(async () => isolated?.close());

  defineCollectionNodeUpdateWriteContract({
    name: 'shared collection-node update behavior',
    createAdapter: async () => {
      const fixture = COLLECTION_NODE_UPDATE_CONTRACT_FIXTURE;
      await resetCollectionNodeContractFixture(isolated.runtime, {
        principals: [
          { principalId: fixture.ownerPrincipalId, subjectId: fixture.ownerSubjectId },
          { principalId: fixture.editorPrincipalId, subjectId: fixture.editorSubjectId },
          { principalId: fixture.viewerPrincipalId, subjectId: fixture.viewerSubjectId },
        ],
        collection: {
          id: fixture.collectionId,
          ownerSubjectId: fixture.ownerSubjectId,
          rootNodeId: fixture.rootId,
          resourceRevision: fixture.collectionResourceRevision,
          contentRevision: fixture.contentRevision,
          policyRevision: fixture.policyRevision,
          commitOrdinal: 2n,
        },
        memberships: [
          { subjectId: fixture.ownerSubjectId, role: 'owner' },
          { subjectId: fixture.editorSubjectId, role: 'editor' },
          { subjectId: fixture.viewerSubjectId, role: 'viewer' },
        ],
        nodes: [
          {
            id: fixture.rootId,
            parentId: null,
            kind: 'folder',
            isRoot: true,
            title: 'Root title',
            positionToken: null,
            resourceRevision: fixture.rootResourceRevision,
            childrenRevision: fixture.rootChildrenRevision,
          },
          {
            id: fixture.nodeId,
            parentId: fixture.rootId,
            kind: 'folder',
            title: 'Folder title',
            description: 'contract description',
            tags: ['before'],
            positionToken: 'U',
            resourceRevision: fixture.nodeResourceRevision,
            childrenRevision: fixture.nodeChildrenRevision,
          },
        ],
      });

      return {
        execute: (input) => createPostgresCanonicalMutationUnitOfWork(isolated.runtime.db)
          .execute((ports) => updateCollectionNode(ports, input)),
        snapshot: async () => {
          const result = await isolated.runtime.pool.query(
            `select n.title, n.url, n.description, n.tags, n.visibility,
                    n.resource_revision, n.children_revision,
                    c.content_revision, c.policy_revision, c.commit_ordinal::text
             from nodes n join collections c on c.id = n.collection_id
             where n.id = $1`,
            [fixture.nodeId],
          );
          const row = result.rows[0];
          assert.ok(row);
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
               where aggregate_scope = $1 and handler_name = 'node_updated_projection'
               order by commit_ordinal`,
              [fixture.collectionId],
            ),
          ]);
          return {
            node: {
              title: row.title,
              url: row.url,
              description: row.description,
              tags: row.tags,
              visibility: row.visibility,
              resourceRevision: row.resource_revision,
              childrenRevision: row.children_revision,
            },
            collection: {
              contentRevision: row.content_revision,
              policyRevision: row.policy_revision,
              commitOrdinal: BigInt(row.commit_ordinal),
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
});
