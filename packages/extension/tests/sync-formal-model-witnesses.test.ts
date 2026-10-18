import assert from 'node:assert/strict';
import { test } from 'vitest';
import { MemoryStorageArea } from '../src/credential-store.js';
import { createDurableSyncEngine } from '../src/durable-sync-engine.js';
import { sendReplicaHealthReport } from '../src/sw/replica-health-report.js';
import { scope, setup } from './durable-sync-engine-harness.js';

// Implementation witness for formal/sync/ColpSync/Health.lean.
// This records the current gap, not the desired guarantee: a failed wake should
// eventually become visible even when the health reader itself remains usable.
test('model witness: repeated preflight read failures leave healthy reports and no circuit history', async () => {
  const fixture = await setup();
  const storage = new MemoryStorageArea();
  const reports: Array<{ state: string; revision: number; issues: { total: number } }> = [];
  let failRead = false;
  const unexpectedWork = async () => { throw new Error('unexpected_sync_work'); };
  const scheduled: number[] = [];
  const engine = createDurableSyncEngine({
    scope, store: { ...fixture.store, async getScope(input) {
      if (failRead) { failRead = false; throw new Error('indexeddb_read_failed'); }
      return fixture.store.getScope(input);
    } },
    endpoints: unexpectedWork, sessions: { get: unexpectedWork },
    pullApplier: { stage: unexpectedWork, resume: unexpectedWork },
    pushWorker: { drain: unexpectedWork }, snapshotProjector: unexpectedWork,
    schedule: delay => scheduled.push(delay),
  });
  try {
    await fixture.enqueue('preflight-1', { payload: { parentId: 'root-old',
      node: { kind: 'bookmark', title: 'Pending upload', url: 'https://example.test/pending' } } });
    for (let cycle = 0; cycle < 10; cycle += 1) {
      // A failed individual read, not a permanently unreadable database.
      // getScope runs before wakeOnce's try/catch; later health reads succeed.
      failRead = true;
      await assert.rejects(engine.wake('alarm'), /indexeddb_read_failed/u);
      const recorded = await fixture.store.getEngineState(scope);
      assert.equal(recorded?.lastError, undefined);
      assert.equal(recorded?.circuitBreaker, undefined);
      assert.equal(await sendReplicaHealthReport({
        scope, store: fixture.store, storage, mode: async () => 'enabled',
        credential: async () => ({ accessToken: 'test-token', serverOrigin: scope.serverOrigin, subject: scope.accountId }),
        replicaProof: async () => 'test-installation-proof',
        origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop', force: true,
        now: () => 1_000 + cycle,
        fetch: async (_input, init) => {
          const report = JSON.parse(String(init?.body));
          reports.push(report);
          return Response.json({ replicaId: scope.replicaId, revision: report.revision, accepted: true, commands: [] });
        },
      }), 'sent');
    }
    assert.equal(reports.length, 10);
    assert.ok(reports.every(report => report.state === 'syncing' && report.issues.total === 0));
    const pending = await fixture.store.getQueueByOpId(scope, 'preflight-1');
    assert.equal(pending?.status, 'pending');
    assert.equal(pending?.retry.attempt, 0);
    assert.equal(pending?.attempt, undefined);
    assert.equal(scheduled.length, 0);
  } finally {
    fixture.store.close();
  }
});
