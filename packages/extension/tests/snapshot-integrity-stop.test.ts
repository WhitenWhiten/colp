import assert from 'node:assert/strict';
import { test } from 'vitest';
import { setup, scope, json, recoverySnapshot, ack } from './durable-sync-engine-harness.js';
import { sendReplicaHealthReport } from '../src/sw/replica-health-report.js';
import { handleSyncAttentionRequest } from '../src/sw/sync-attention.js';
import { recoveryFailureCopy, terminalFreezeReport } from '../src/sync-attention-ui.js';
import { MemoryStorageArea } from '../src/credential-store.js';

test('repeated malformed Snapshot with no progress must stop and report a reason', async () => {
  const f = await setup({ snapshotRequired: true, emptyCollection: true, useRealPullApplier: true });
  try {
    for (let n = 0; n < 6; n++) {
      f.snapshotResponses.push(json(200, { invalid: true }));
      const state = await f.reopen().wake(n === 0 ? 'manual' : 'startup');
      f.clock.now = Math.max(f.clock.now + 1000, state!.notBefore);
    }
    const bodies: any[] = [];
    await sendReplicaHealthReport({ scope, store: f.store, storage: new MemoryStorageArea(),
      mode: async () => 'enabled', origin: 'chrome-extension://known', now: () => f.clock.now,
      credential: async () => ({ accessToken: 'token', serverOrigin: scope.serverOrigin, subject: scope.accountId }),
      fetch: async (_url, init) => { bodies.push(JSON.parse(String(init?.body))); return json(200, { replicaId: scope.replicaId, revision: bodies.at(-1).revision, accepted: true, commands: [] }); } });
    assert.equal(f.snapshotRequests.length, 5, 'automatic integrity recovery has a persistent bound');
    assert.equal(bodies[0].state, 'stopped');
    assert.equal(bodies[0].code, 'snapshot_invalid');
    assert.deepEqual(bodies[0].actions, ['retry', 'rebuild']);
    const status = await handleSyncAttentionRequest({ scope: async () => scope, store: f.store });
    assert.ok(status.ok); assert.equal(status.attention.retryAutomatic, false);
    assert.ok(terminalFreezeReport(status.attention).includes('snapshot_invalid'));
    assert.ok(recoveryFailureCopy(status.attention).includes('Retry'));
    // Advancing far beyond the authority cooldown must not silently retry corruption.
    const sessions = f.sessionForces.length;
    f.clock.now += 24 * 60 * 60_000;
    for (const reason of ['startup', 'online', 'alarm'] as const) await f.reopen().wake(reason);
    assert.equal(f.sessionForces.length, sessions);
    f.forcedSessions.push({ state: 'active', snapshotRequired: false, cursor: 'opaque-renewal' });
    const denied = await f.reopen().wake('manual');
    assert.equal(denied?.lastError, 'snapshot_invalid', 'Session renewal cannot prove Snapshot integrity');
    assert.equal(f.pullRequests.length, 0);
    f.forcedSessions.push({ state: 'active', snapshotRequired: true, cursor: 'repaired-authority' });
    // A repaired source can be explicitly probed; no corrupt data was applied.
    f.chromeNodes.set('native-root', { id: 'native-root', title: 'Root' });
    f.snapshotResponses.length = 0;
    f.snapshotResponses.push(json(200, recoverySnapshot(1, false, null)));
    f.ackResponses.push(json(200, ack('bootstrap-cursor')));
    const recovered = await f.reopen().wake('manual');
    assert.equal(recovered?.phase, 'sleeping', JSON.stringify(recovered));
    assert.equal(recovered?.lastError, undefined);
    assert.equal(recovered?.circuitBreaker, undefined);
    assert.equal(recovered?.recoveryFrozen, false);
    assert.equal((await f.store.getScope(scope))?.metadata?.recoveryCode, undefined);

  } finally { f.store.close(); }
});
