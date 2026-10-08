import { createCanonicalMutationApplication } from '../../../src/modules/collections/index.js';
import { createPostgresCanonicalMutationPorts } from '../../../src/infrastructure/collections/canonical-mutation-postgres-ports.js';
import { sql } from 'kysely';
import { measureCanonicalTree, withCanonicalTreeCapacityBatch } from '../../../src/infrastructure/collections/canonical-tree-capacity.js';
import { createUnitOfWork } from '../../../src/infrastructure/database/unit-of-work.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, test } from 'vitest';
import { createIsolatedPostgresRuntime, describeWithPostgres, type IsolatedPostgresRuntime } from '../../support/postgres-test-runtime.js';
import { resetCollectionNodeContractFixture, type CollectionNodeContractNode } from '../../support/collection-node-contract-postgres.js';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import { createPostgresCanonicalMutationUnitOfWork, createPostgresExportJobWorkerRepository, createPostgresExportJobEnqueueUnitOfWork, createPostgresReadableReplicaEnqueueUnitOfWork, createPostgresReadableReplicaWorkerRepository, createPostgresReadableReplicaUnitOfWork } from '../../../src/infrastructure/collections/index.js';
import { SnapshotTreeCapacityError, SNAPSHOT_TREE_CAPACITY, updateCollectionNode, createMyExportJob, ExportJobConflictError, enqueueNodeReadableExtract, getNodeReadableReplica } from '../../../src/modules/collections/index.js';
describeWithPostgres('C-04 canonical Snapshot capacity', () => {
  let isolated: IsolatedPostgresRuntime;
  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('collections_audit', {maxConnections: 6});
    await runMigrations(isolated.runtime.db, 'latest');
    await resetCollectionNodeContractFixture(isolated.runtime,{
      principals:[{principalId:'ZWVlZWVlZWVlZWVlZWVlZQ',subjectId:'ZmZmZmZmZmZmZmZmZmZmZg'}],
      collection:{id:'Z2dnZ2dnZ2dnZ2dnZ2dnZw',ownerSubjectId:'ZmZmZmZmZmZmZmZmZmZmZg',rootNodeId:'aGhoaGhoaGhoaGhoaGhoaA',resourceRevision:'r1',contentRevision:'c1',policyRevision:'p1',commitOrdinal:1n},
      nodes:[{id:'aGhoaGhoaGhoaGhoaGhoaA',parentId:null,kind:'folder',isRoot:true,title:'Root',positionToken:null,resourceRevision:'r1',childrenRevision:'c1'},
        {id:'aWlpaWlpaWlpaWlpaWlpaQ',parentId:'aGhoaGhoaGhoaGhoaGhoaA',kind:'bookmark',title:'A',url:'https://example.test/a',positionToken:'A',resourceRevision:'r2',childrenRevision:'c2'}],
    });
  },180000);
  afterAll(async()=>isolated?.close());
  const actor={principalId:'ZWVlZWVlZWVlZWVlZWVlZQ',subjectId:'ZmZmZmZmZmZmZmZmZmZmZg'};
  test('PATCH uses actual Snapshot document bytes and rolls back every canonical effect', async () => {
    const collectionId = 'ampqampqampqampqampqag';
    const root = 'a2tra2tra2tra2tra2traw';
    const nodeId = 'bGxsbGxsbGxsbGxsbGxsbA';
    const nodes: CollectionNodeContractNode[] = [
      { id: root, parentId: null, kind: 'folder', isRoot: true, title: 'Root', positionToken: null, resourceRevision: 'r1', childrenRevision: 'c1' },
      { id: nodeId, parentId: root, kind: 'bookmark', title: 'A', url: 'https://example.test/a', positionToken: 'A', resourceRevision: 'r2', childrenRevision: 'c2' },
    ];
    for (let i = 0; i < 125; i++) nodes.push({ id: `capacity-${i}`, parentId: root, kind: 'bookmark', title: 'Filler', url: 'https://example.test/filler',
      description: 'x'.repeat(16000), positionToken: `B${String(i).padStart(4, '0')}`, resourceRevision: `rf${i}`, childrenRevision: `cf${i}` });
    await resetCollectionNodeContractFixture(isolated.runtime, { principals: [actor],
      collection: { id: collectionId, ownerSubjectId: actor.subjectId, rootNodeId: root, resourceRevision: 'r1', contentRevision: 'c1', policyRevision: 'p1', commitOrdinal: 1n }, nodes });
    const measure = () => createUnitOfWork(isolated.runtime.db).execute(({ transaction }) => measureCanonicalTree(transaction, collectionId));
    // Calibrate a valid authority payload to the actual serializer, not the old five-field estimate.
    const initial = await measure();
    const target = SNAPSHOT_TREE_CAPACITY.maxAggregateBytes - 8000;
    const extra = target - initial.bytes;
    assert.ok(extra > 0);
    let remaining = extra;
    for (let i = 0; i < 125 && remaining > 0; i++) {
      const addition = Math.min(384, remaining);
      await isolated.runtime.pool.query(`UPDATE nodes SET description=$2, payload_json=jsonb_set(payload_json,'{description}',to_jsonb($2::text)) WHERE id=$1`, [`capacity-${i}`, 'x'.repeat(16000 + addition)]);
      remaining -= addition;
    }
    assert.equal(remaining, 0, 'all fixture descriptions remain individually valid');
    assert.equal((await measure()).bytes, target);
    const snapshot = () => isolated.runtime.pool.query(`SELECT
      (SELECT count(*) FROM operations) AS operations, (SELECT count(*) FROM audit_events) AS audits,
      (SELECT count(*) FROM outbox_events) AS outbox, (SELECT count(*) FROM product_command_receipts) AS receipts,
      (SELECT commit_ordinal FROM collections WHERE id=$1) AS ordinal`, [collectionId]);
    const before = await snapshot();
    await assert.rejects(createPostgresCanonicalMutationUnitOfWork(isolated.runtime.db).execute(ports => updateCollectionNode(ports, {
      actor: { ...actor, principalType: 'account' }, command: { commandId: randomUUID(), fingerprint: 'capacity-test' },
      collectionId, nodeId, ifMatch: '"r2"', patch: { description: '界'.repeat(5461) },
    })), SnapshotTreeCapacityError);
    assert.deepEqual((await snapshot()).rows, before.rows);
    assert.equal((await measure()).bytes, target);
    const accepted = await createPostgresCanonicalMutationUnitOfWork(isolated.runtime.db).execute(ports => updateCollectionNode(ports, {
      actor: { ...actor, principalType: 'account' }, command: { commandId: randomUUID(), fingerprint: 'capacity-small' },
      collectionId, nodeId, ifMatch: '"r2"', patch: { description: '界'.repeat(100) },
    }));
    assert.equal(accepted.kind, 'updated');
    assert.ok((await measure()).bytes <= SNAPSHOT_TREE_CAPACITY.maxAggregateBytes);
    const beforeBatch = await snapshot();
    let writes = 0;
    let scans = 0;
    const observed = isolated.runtime.db.withPlugin({
      transformQuery({ node }) {
        if (node.kind === 'RawNode' && 'sqlFragments' in node
          && (node.sqlFragments as readonly string[]).join('').includes('row_to_json(c) AS collection')) scans++;
        return node;
      },
      async transformResult({ result }) { return result; },
    });
    await assert.rejects(createUnitOfWork(observed).execute(({ transaction }) =>
      withCanonicalTreeCapacityBatch(transaction, collectionId, async treeCapacityAdmission => {
        const canonical = createCanonicalMutationApplication(createPostgresCanonicalMutationPorts(transaction, { treeCapacityAdmission }));
        for (const size of [5000, 9000]) {
          const current = await transaction.selectFrom('nodes').select('resource_revision').where('id', '=', nodeId).executeTakeFirstOrThrow();
          await canonical.execute({ transaction }, { operationId: randomUUID(), collectionId,
            actor: { principalId: actor.principalId, principalType: 'account' }, mutation: {
              action: 'update', target: { collectionId, resourceId: nodeId, resourceKind: 'node' }, parentId: root,
              expectedResourceRevision: current.resource_revision, fields: { kindFields: { description: 'x'.repeat(size) }, extensions: {} },
            } });
          writes++;
        }
      })), SnapshotTreeCapacityError);
    assert.equal(writes, 2, 'the whole atomic batch reaches its one final capacity decision');
    assert.equal(scans, 2, 'one before and one after serialization for the entire batch');
    assert.deepEqual((await snapshot()).rows, beforeBatch.rows, 'all batch effects roll back together');
  });
});
