import { verifySyncResilienceCase } from '../../conformance/src/sync-resilience.mjs';
import assert from 'node:assert/strict';
import { test } from 'vitest';
import { setup } from './replica-rebuild-harness.js';
import { createReplicaRebuilder, runReplicaRebuildCommand } from '../src/replica-rebuild.js';
import { sendReplicaHealthReport } from '../src/sw/replica-health-report.js';

for (const field of ['replicaId', 'accountId', 'serverOrigin', 'collectionId', 'generation'] as const) {
  test(`a delayed command cannot adopt another ${field}`, async () => {
    const a = await setup({ degraded: true }); const b = await setup({ degraded: true });
    try {
      const result = await runReplicaRebuildCommand(request => b.rebuilder.handle(request), a.scope);
      assert.equal(result.outcome, 'failed'); assert.equal(b.registrations, 0);
      const changed = { ...a.scope, [field]: field === 'generation' ? 2 : `other-${field}` };
      const rebuilder = createReplicaRebuilder({ ...a.deps, currentScope: async () => changed });
      assert.equal((await rebuilder.handle(a.request)).ok, false); assert.equal(a.registrations, 0);
    } finally { a.store.close(); b.store.close(); }
  });
}

test('actions are read again after the network wait', async () => {
  const f = await setup({ degraded: true }); let calls = 0;
  try {
    await sendReplicaHealthReport({ scope: f.scope, store: f.store, storage: f.journal,
      credential: async () => ({ accessToken: 'token', subject: f.scope.accountId, serverOrigin: f.scope.serverOrigin }),
      mode: async () => 'enabled', now: () => 2000, origin: 'chrome-extension://fixture',
      commands: { replica: async () => { calls++; return { outcome: 'done' }; }, issue: async () => ({ outcome: 'failed' }) },
      fetch: async () => { await f.store.retireScope(f.scope, { retiredAt: 2000, reason: 'user_replica_rebuild' });
        return Response.json({ accepted: true, commands: [{ commandId: 'late', action: 'rebuild' }] }); } });
    assert.equal(calls, 0);
  } finally { f.store.close(); }
});

test('preview cannot survive an authority fence change', async () => {
  const f = await setup({ degraded: true });
  try {
    await f.credentials.fence.activate();
    assert.equal((await f.rebuilder.handle(f.request)).ok, false);
    assert.equal(f.registrations, 0);
  } finally { f.store.close(); }
});

test('delayed health response binds real Rebuild and reports rejection under A', async () => {
  const a = await setup({ degraded: true }); const b = await setup({ degraded: true }); let current = a;
  try {
    const bodies: any[] = [];
    const deps = { scope: a.scope, store: a.store, storage: a.journal, mode: async () => 'enabled' as const,
      credential: async () => ({ accessToken: 'token', subject: a.scope.accountId, serverOrigin: a.scope.serverOrigin }),
      now: () => 2000, origin: 'chrome-extension://fixture',
      commands: { replica: () => runReplicaRebuildCommand(request => current.rebuilder.handle(request), a.scope),
        issue: async () => ({ outcome: 'failed' as const }) },
      fetch: async (_url: RequestInfo | URL, init?: RequestInit) => { bodies.push(JSON.parse(String(init?.body))); current = b;
        return Response.json({ accepted: true, commands: [{ commandId: 'for-a', action: 'rebuild' }] }); } };
    await sendReplicaHealthReport(deps);
    await sendReplicaHealthReport({ ...deps, force: true });
    assert.equal(a.registrations, 0); assert.equal(b.registrations, 0);
    assert.deepEqual(bodies[1].commandResults, [{ commandId: 'for-a', outcome: 'failed', code: 'stale_ref' }]);
    assert.deepEqual(verifySyncResilienceCase('SYNC-0038', { originalReplica: a.scope.replicaId, currentBefore: b.scope.replicaId,
      currentAfter: (await b.deps.currentScope()).replicaId, commandId: 'for-a', originalRebuilds: a.registrations, currentRebuilds: b.registrations, reports: bodies }), []);
  } finally { a.store.close(); b.store.close(); }
});

test('a pending Rebuild journal cannot adopt a changed generation on restart', async () => {
  const f = await setup({ degraded: true });
  try {
    f.setOffline(true); await f.rebuilder.handle(f.request);
    const resumed = createReplicaRebuilder({ ...f.deps, currentScope: async () => ({ ...f.scope, generation: 2 }) });
    await assert.rejects(resumed.resume(), /stale_ref/u);
    assert.equal(f.registrations, 0);
  } finally { f.store.close(); }
});

test('a health response explicitly naming another replica cannot authorize a Rebuild', async () => {
  const f = await setup({ degraded: true });
  try {
    await sendReplicaHealthReport({ scope: f.scope, store: f.store, storage: f.journal,
      mode: async () => 'enabled', credential: async () => ({ accessToken: 'token', subject: f.scope.accountId, serverOrigin: f.scope.serverOrigin }),
      now: () => 2000, origin: 'chrome-extension://fixture',
      commands: { replica: () => runReplicaRebuildCommand(request => f.rebuilder.handle(request), f.scope), issue: async () => ({ outcome: 'failed' }) },
      fetch: async () => Response.json({ replicaId: 'different-replica', accepted: true, commands: [{ commandId: 'misbound', action: 'rebuild' }] }) });
    assert.equal(f.registrations, 0);
  } finally { f.store.close(); }
});
