import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, test } from 'vitest';
import { createIsolatedPostgresRuntime, describeWithPostgres, type IsolatedPostgresRuntime } from '../../support/postgres-test-runtime.js';
import { resetCollectionNodeContractFixture } from '../../support/collection-node-contract-postgres.js';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import { createPostgresCanonicalMutationUnitOfWork, createPostgresReadableReplicaEnqueueUnitOfWork, createPostgresReadableReplicaWorkerRepository, createPostgresReadableReplicaUnitOfWork } from '../../../src/infrastructure/collections/index.js';
import { updateCollectionNode, enqueueNodeReadableExtract, getNodeReadableReplica } from '../../../src/modules/collections/index.js';
describeWithPostgres('C-03 reader content identity', () => {
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
  test('URL change invalidates ready data and fences late claims, including A-B-A', async () => {
    const collectionId = 'Z2dnZ2dnZ2dnZ2dnZ2dnZw';
    const nodeId = 'aWlpaWlpaWlpaWlpaWlpaQ';
    const enqueue = createPostgresReadableReplicaEnqueueUnitOfWork(isolated.runtime.db);
    const worker = createPostgresReadableReplicaWorkerRepository(isolated.runtime.pool);
    const get = () => createPostgresReadableReplicaUnitOfWork(isolated.runtime.db).execute(ports => getNodeReadableReplica(ports, { actor, collectionId, nodeId }));
    const queue = () => enqueue.execute(ports => enqueueNodeReadableExtract(ports, { actor, collectionId, nodeId, force: false, cooldownMs: 60000, commandId: randomUUID() }));
    const claim = async () => {
      const [result] = await worker.claimDue({ limit: 1, leaseOwner: 'same-process', leaseDurationMs: 60000 });
      assert.ok(result); return result;
    };
    const complete = (lease: Awaited<ReturnType<typeof claim>>) => worker.completeExtract({ ...lease, status: 'ready', sourceUrl: lease.url,
      title: 'article', byline: null, wordCount: 1, sections: [], failureCode: null, extractedAt: new Date(), updatedAt: new Date() });
    const update = async (url: string) => {
      const row = await isolated.runtime.db.selectFrom('nodes').select('resource_revision').where('id', '=', nodeId).executeTakeFirstOrThrow();
      const result = await createPostgresCanonicalMutationUnitOfWork(isolated.runtime.db).execute(ports => updateCollectionNode(ports, {
        actor: { ...actor, principalType: 'account' }, command: { commandId: randomUUID(), fingerprint: randomUUID() }, collectionId, nodeId,
        ifMatch: `"${row.resource_revision}"`, patch: { url },
      }));
      assert.equal(result.kind, 'updated');
    };
    await queue(); const readyA = await claim(); assert.equal(await complete(readyA), true);
    assert.equal((await get()).status, 'ready');
    await update('https://example.test/b'); assert.equal((await get()).status, 'none');
    await queue(); const pendingB = await claim();
    await update('https://example.test/a'); assert.equal(await complete(pendingB), false);
    await queue(); const pendingA = await claim();
    assert.notEqual(pendingA.leaseOwner, pendingB.leaseOwner);
    assert.equal(await complete(pendingB), false);
    assert.equal(await complete(pendingA), true);
    assert.equal((await get()).sourceUrl, 'https://example.test/a');
    // Legacy mismatched rows are never projected as ready, even before cleanup.
    await isolated.runtime.pool.query("UPDATE collection_readable_replicas SET source_url='https://example.test/old'");
    assert.equal((await get()).status, 'none');
  });
});
