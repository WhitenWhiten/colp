import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, test } from 'vitest';
import { createIsolatedPostgresRuntime, describeWithPostgres, type IsolatedPostgresRuntime } from '../../support/postgres-test-runtime.js';
import { resetCollectionNodeContractFixture } from '../../support/collection-node-contract-postgres.js';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import { createPostgresReadableReplicaEnqueueUnitOfWork, createPostgresReadableReplicaWorkerRepository } from '../../../src/infrastructure/collections/index.js';
import { enqueueNodeReadableExtract, ReadableReplicaCooldownError } from '../../../src/modules/collections/index.js';
describeWithPostgres('C-02 readable enqueue serialization', () => {
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
  for (const { initial, force } of [
    { initial: 'absent', force: false }, { initial: 'failed', force: false },
    { initial: 'absent', force: true }, { initial: 'failed', force: true },
  ]) {
    test(`concurrent enqueue preserves worker lease from ${initial}, force=${force}`, async () => {
      await isolated.runtime.pool.query('DELETE FROM collection_readable_replicas');
      const unit = createPostgresReadableReplicaEnqueueUnitOfWork(isolated.runtime.db);
      const input = { actor, collectionId: 'Z2dnZ2dnZ2dnZ2dnZ2dnZw', nodeId: 'aWlpaWlpaWlpaWlpaWlpaQ', force: false, cooldownMs: 60000 };
      if (initial === 'failed') {
        await unit.execute(ports => enqueueNodeReadableExtract(ports, { ...input, commandId: randomUUID() }));
        await isolated.runtime.pool.query("UPDATE collection_readable_replicas SET status='failed', enqueued_at=current_timestamp-interval '1 hour'");
      }
      let releaseFirst!: () => void;
      const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
      let firstRead!: () => void;
      const firstLoaded = new Promise<void>(resolve => { firstRead = resolve; });
      const first = unit.execute(ports => enqueueNodeReadableExtract({ ...ports, replicas: { ...ports.replicas,
        async loadEnqueueState(identity) {
          const state = await ports.replicas.loadEnqueueState(identity);
          firstRead(); await firstGate; return state;
        },
      } }, { ...input, commandId: randomUUID() }));
      await firstLoaded;
      let secondStarted!: () => void;
      const started = new Promise<void>(resolve => { secondStarted = resolve; });
      let secondRead!: () => void;
      const secondLoaded = new Promise<void>(resolve => { secondRead = resolve; });
      let releaseSecond!: () => void;
      const secondGate = new Promise<void>(resolve => { releaseSecond = resolve; });
      const second = unit.execute(ports => enqueueNodeReadableExtract({ ...ports, replicas: { ...ports.replicas,
        async loadEnqueueState(identity) {
          secondStarted();
          const state = await ports.replicas.loadEnqueueState(identity);
          secondRead(); await secondGate; return state;
        },
      } }, { ...input, force, commandId: randomUUID() }));
      const secondResult = force ? assert.rejects(second, ReadableReplicaCooldownError) : second;
      await started;
      releaseFirst();
      assert.equal((await first).kind, 'succeeded');
      await secondLoaded;
      const worker = createPostgresReadableReplicaWorkerRepository(isolated.runtime.pool);
      const [claim] = await worker.claimDue({ limit: 1, leaseOwner: 'reader-worker', leaseDurationMs: 60000 });
      assert.ok(claim);
      releaseSecond();
      await secondResult;
      const row = await isolated.runtime.pool.query('SELECT lease_owner FROM collection_readable_replicas WHERE node_id=$1', [input.nodeId]);
      assert.equal(row.rows[0].lease_owner, claim.leaseOwner);
      assert.equal(await worker.completeExtract({ ...claim, status: 'ready', sourceUrl: claim.url, title: 'A', byline: null,
        wordCount: 1, sections: [], failureCode: null, extractedAt: new Date(), updatedAt: new Date() }), true);
    });
  }
});
