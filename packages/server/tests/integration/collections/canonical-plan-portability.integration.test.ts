import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, test } from 'vitest';
import { createUnitOfWork } from '../../../src/infrastructure/database/unit-of-work.js';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import { createPostgresCanonicalMutationPorts } from '../../../src/infrastructure/collections/canonical-mutation-postgres-ports.js';
import { createPostgresAnnotationMutationUnitOfWork } from '../../../src/infrastructure/collections/index.js';
import { createAnnotation, createCanonicalMutationApplication } from '../../../src/modules/collections/index.js';
import { resetCollectionNodeContractFixture } from '../../support/collection-node-contract-postgres.js';
import { createIsolatedPostgresRuntime, describeWithPostgres, type IsolatedPostgresRuntime } from '../../support/postgres-test-runtime.js';

const COLLECTION_ID = Buffer.alloc(16, 4).toString('base64url');
const ROOT_ID = 'canonical-plan-root';
const FOLDER_ID = 'canonical-plan-folder';
const NODE_ID = 'canonical-plan-node';

// Every stage gets a fresh adapter: only the explicit immutable plan may carry facts.
describeWithPostgres('C-06 canonical execution plan portability', () => {
  let isolated: IsolatedPostgresRuntime;
  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('canonical_plan_portability', { maxConnections: 4 });
    await runMigrations(isolated.runtime.db, 'latest');
    await resetCollectionNodeContractFixture(isolated.runtime, {
      principals: [{ principalId: Buffer.alloc(16, 8).toString('base64url'), subjectId: 'subject-owner' },
        { principalId: 'principal-creator', subjectId: 'subject-creator' }],
      memberships: [{ subjectId: 'subject-creator', role: 'editor' }],
      collection: { id: COLLECTION_ID, ownerSubjectId: 'subject-owner', rootNodeId: ROOT_ID,
        resourceRevision: 'collection-r1', contentRevision: 'content-r1', policyRevision: 'policy-r1', commitOrdinal: 1n },
      nodes: [
        { id: ROOT_ID, parentId: null, kind: 'folder', isRoot: true, title: 'Root', positionToken: null,
          resourceRevision: 'root-r1', childrenRevision: 'root-c1' },
        { id: FOLDER_ID, parentId: ROOT_ID, kind: 'folder', title: 'Folder', positionToken: 'A',
          resourceRevision: 'folder-r1', childrenRevision: 'folder-c1' },
        { id: NODE_ID, parentId: FOLDER_ID, kind: 'bookmark', title: 'Bookmark', url: 'https://example.test/plan', positionToken: 'A',
          resourceRevision: 'node-r1', childrenRevision: 'node-c1' },
      ],
    });
    await isolated.runtime.pool.query(`UPDATE collections SET visibility='public',
      publication_slug='canonical-plan-portability', published_at=current_timestamp,
      payload_json=jsonb_set(payload_json,'{visibility}','"public"'::jsonb) WHERE id=$1`, [COLLECTION_ID]);
  }, 120_000);
  afterAll(async () => isolated?.close());

  async function seed(annotationId: string) {
    const result = await createPostgresAnnotationMutationUnitOfWork(isolated.runtime.db).execute(ports => createAnnotation(ports, {
      actor: { principalId: 'principal-creator', subjectId: 'subject-creator', principalType: 'account',
        creator: { id: 'https://known.test/profiles/principal-creator', name: 'principal-creator' } },
      command: { commandId: randomUUID(), fingerprint: randomUUID() }, collectionId: COLLECTION_ID,
      annotation: { subject: { type: 'node', id: NODE_ID }, type: 'note', format: 'plain',
        value: `body-${annotationId}`, visibility: 'protected', extensions: {} },
      annotationId, operationId: `operation-create-${annotationId}`,
    }));
    assert.equal(result.kind, 'created');
    if (result.kind !== 'created') throw new Error('seed Annotation was not created');
    return result.annotation;
  }

  test('C-06 immutable deletion plan carries cascades across independently constructed stages', async () => {
    const annotation = await seed('explicit-plan-annotation');
    await createUnitOfWork(isolated.runtime.db).execute(async ({ transaction }) => {
      const fresh = () => createPostgresCanonicalMutationPorts(transaction);
      const ports = fresh();
      const current = await transaction.selectFrom('nodes').select('resource_revision').where('id', '=', NODE_ID).executeTakeFirstOrThrow();
      const application = createCanonicalMutationApplication({ ...ports,
        planner: { async planCanonicalMutation(tx, input, locked) {
          const plan = await fresh().planner.planCanonicalMutation(tx, input, locked);
          assert.equal(plan.facts?.resourceKind, 'node');
          assert.equal(plan.facts?.action, 'delete');
          assert.deepEqual(plan.facts?.annotations.map(row => row.id), [annotation.id]);
          assert.equal(Object.isFrozen(plan.facts), true);
          return plan;
        } },
        allocator: { allocate: (tx, input) => fresh().allocator.allocate(tx, input) },
        resources: { applyCanonicalMutation: (tx, input) => fresh().resources.applyCanonicalMutation(tx, input) },
        operations: { appendCanonicalOperation: (tx, input) => fresh().operations.appendCanonicalOperation(tx, input) },
        audit: { appendAuditEvent: (tx, input) => fresh().audit.appendAuditEvent(tx, input) },
        outbox: { appendDomainEvents: (tx, input) => fresh().outbox.appendDomainEvents(tx, input) },
      });
      await application.execute({ transaction }, {
        operationId: randomUUID(), collectionId: COLLECTION_ID, actor: { principalId: 'principal-creator', principalType: 'account' },
        mutation: { action: 'delete', target: { collectionId: COLLECTION_ID, resourceId: NODE_ID, resourceKind: 'node' },
          parentId: FOLDER_ID, expectedResourceRevision: current.resource_revision, deleteIntent: { scope: 'single' } },
      });
    });
    const deleted = await isolated.runtime.db.selectFrom('annotations').select('deleted_at').where('id', '=', annotation.id).executeTakeFirstOrThrow();
    assert.ok(deleted.deleted_at);
    const event = await isolated.runtime.db.selectFrom('outbox_events').select('outbox_id').where('aggregate_id', '=', annotation.id)
      .where('event_type', '=', 'annotation.deleted').execute();
    assert.equal(event.length, 1);
  });

});
