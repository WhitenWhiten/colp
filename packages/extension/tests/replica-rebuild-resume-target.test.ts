import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createReplicaRebuilder, REPLICA_REBUILD_JOURNAL } from '../src/replica-rebuild.js';
import { setup } from './replica-rebuild-harness.js';
import { setupRetirement } from './replica-retirement-harness.js';

async function pendingRebuild() {
  const f = await setup({ degraded: true });
  f.setOffline(true);
  assert.deepEqual(await f.rebuilder.handle(f.request), { ok: false, code: 'offline' });
  const binding = (await f.credentials.loadBinding())!;
  const nextScope = { ...f.scope, replicaId: binding.replicaId, generation: Number(binding.generation) };
  assert.notEqual(binding.replicaId, f.scope.replicaId);
  assert.equal(await f.store.getScope(nextScope), null);
  const journal = await f.journal.get(REPLICA_REBUILD_JOURNAL);
  const archive = await f.store.exportArchive(f.scope);
  return { ...f, nextScope, binding, journalBefore: journal, archiveBefore: archive };
}

test('an archived rebuild rejects a public binding generation change before registration', async () => {
  const f = await pendingRebuild(); let registrations = 0;
  try {
    const changed = await f.credentials.bumpBindingGeneration(0);
    const resumed = createReplicaRebuilder({ ...f.deps,
      currentScope: async () => ({ ...f.nextScope, generation: Number(changed.generation) }),
      ensureScope: async () => { registrations++; return f.deps.ensureScope(); } });
    await assert.rejects(resumed.resume(), /stale_ref/u);
    assert.equal(registrations, 0);
    assert.deepEqual(await f.credentials.loadBinding(), changed);
    assert.deepEqual(await f.journal.get(REPLICA_REBUILD_JOURNAL), f.journalBefore);
    assert.deepEqual(await f.store.exportArchive(f.scope), f.archiveBefore);
  } finally { f.store.close(); }
});

for (const field of ['environment', 'serverId', 'serverOrigin', 'accountId', 'browserProfileId', 'collectionId', 'replicaId'] as const) {
  test(`an archived rebuild rejects changed ${field} before registration`, async () => {
    const f = await pendingRebuild(); let registrations = 0;
    try {
      const changed = { ...f.nextScope, [field]: `different-${field}` };
      const resumed = createReplicaRebuilder({ ...f.deps, currentScope: async () => changed,
        ensureScope: async () => { registrations++; return f.deps.ensureScope(); } });
      await assert.rejects(resumed.resume(), /stale_ref/u);
      assert.equal(registrations, 0);
      assert.deepEqual(await f.credentials.loadBinding(), f.binding);
      assert.deepEqual(await f.journal.get(REPLICA_REBUILD_JOURNAL), f.journalBefore);
      assert.deepEqual(await f.store.exportArchive(f.scope), f.archiveBefore);
    } finally { f.store.close(); }
  });
}

for (const address of ['previous', 'replacement'] as const) {
  test(`the exact ${address} address can resume a replacement with no Session or IDB scope`, async () => {
    const f = await pendingRebuild();
    try {
      f.setOffline(false);
      const resumed = createReplicaRebuilder({ ...f.deps,
        currentScope: async () => address === 'previous' ? f.scope : f.nextScope });
      assert.equal(await f.credentials.loadSession(), null);
      assert.equal(await resumed.resume(), true);
      assert.deepEqual(await f.credentials.loadBinding(), f.binding);
      assert.ok(await f.store.getScope(f.nextScope));
      assert.deepEqual(await f.store.exportArchive(f.scope), f.archiveBefore);
      assert.equal((await f.journal.get(REPLICA_REBUILD_JOURNAL))[REPLICA_REBUILD_JOURNAL], undefined);
      assert.equal(await resumed.resume(), false);
    } finally { f.store.close(); }
  });
}

for (const loseCredential of [false, true]) test(`a confirmed retirement rejects a changed generation before registration or credential restore (${loseCredential})`, async () => {
  const f = await setupRetirement(); let registrations = 0;
  try {
    f.setOfflineRegistration(true);
    assert.deepEqual(await f.rebuilder.handle(await f.request()), { ok: false, code: 'offline' });
    assert.equal(f.requests.length, 1);
    const journal = await f.journal.get(REPLICA_REBUILD_JOURNAL);
    const archive = await f.store.exportArchive(f.scope);
    const changed = await f.credentials.bumpBindingGeneration(0);
    if (loseCredential) await f.credentials.clearCredential();
    const restarted = createReplicaRebuilder({ ...f.deps,
      ensureScope: async () => { registrations++; return f.deps.ensureScope(); } });
    await assert.rejects(restarted.resume(), /stale_ref/u);
    assert.equal(registrations, 0);
    assert.equal(f.restorations, 0, 'a stale replacement must not start authentication traffic');
    assert.equal(f.requests.length, 1, 'the confirmed DELETE must not be sent again');
    assert.equal(f.pushCalls, 1, 'the archived metadata attempt must not be sent again');
    assert.deepEqual(await f.credentials.loadBinding(), changed);
    assert.deepEqual(await f.journal.get(REPLICA_REBUILD_JOURNAL), journal);
    assert.deepEqual(await f.store.exportArchive(f.scope), archive);
  } finally { f.close(); }
});
