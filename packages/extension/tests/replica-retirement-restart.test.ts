import assert from 'node:assert/strict';
import { afterEach, test } from 'vitest';
import { createReplicaRebuilder, REPLICA_REBUILD_JOURNAL } from '../src/replica-rebuild.js';
import { confirmNativeWait } from '../src/native-wait.js';
import { setupRetirement, seedNativeUnknown } from './replica-retirement-harness.js';

const fixtures: Awaited<ReturnType<typeof setupRetirement>>[] = [];
afterEach(() => { for (const f of fixtures.splice(0)) f.close(); });
async function setup() { const f = await setupRetirement(); fixtures.push(f); return f; }

for (const when of ['before-preview', 'after-preview', 'before-retry', 'after-204', 'after-logout-archive'] as const) {
  test(`native unknown ${when} still prevents reset; server retirement cannot settle Chrome results`, async () => {
    const f = await setup(); const request = await f.request();
    if (when === 'before-retry' || when === 'after-logout-archive') {
      f.setResponse(async () => { throw new Error('lost_response'); });
      await f.rebuilder.handle(request);
    }
    if (when === 'after-204') f.setResponse(async () => {
      await seedNativeUnknown(f); return new Response(null, { status: 204 });
    });
    else await seedNativeUnknown(f);
    if (when === 'after-logout-archive') await f.store.cleanupAccount({ environment: f.scope.environment,
      serverId: f.scope.serverId, accountId: f.scope.accountId, browserProfileId: f.scope.browserProfileId });
    if (when === 'before-preview') assert.deepEqual(await f.rebuilder.handle({ kind: 'known.scope.rebuild.preview' }),
      { ok: false, code: 'native_outcome_unsettled' });
    else if (when === 'before-retry' || when === 'after-logout-archive') {
      assert.deepEqual(await f.rebuilder.pendingStatus(), { available: false, reason: 'native_outcome_unsettled' });
      await assert.rejects(createReplicaRebuilder(f.deps).resume(), /native_outcome_unsettled/);
    } else assert.deepEqual(await f.rebuilder.handle(request), { ok: false, code: 'native_outcome_unsettled' });
    assert.deepEqual(await f.credentials.loadBinding(), f.binding); assert.equal(f.pushCalls, 1);
    assert.equal(f.requests.length, ['before-retry', 'after-204', 'after-logout-archive'].includes(when) ? 1 : 0);
    if (when !== 'after-logout-archive') {
      assert.deepEqual(await f.store.listQueue(f.scope), f.original);
      await assert.rejects(f.store.exportArchive(f.scope), /archive_not_found/);
    } else assert.deepEqual((await f.store.exportArchive(f.scope)).queue, f.original);
    if (when === 'after-204') {
      // A durable, explicit native decision is the existing lawful exit. The
      // completed retirement is not sent again and no native receipt is forged.
      const native = (await f.store.getApplyIntent(f.scope, 'native-intent'))!;
      assert.deepEqual(await confirmNativeWait({ scope: f.scope, store: f.store, intentId: native.intentId,
        generation: native.generation!, waitRef: 'nwr:retirement', action: 'cancel' }), { ok: true, result: 'cancelled' });
      assert.equal(await createReplicaRebuilder(f.deps).resume(), true);
      assert.equal(f.requests.length, 1);
      assert.deepEqual((await f.store.exportArchive(f.scope)).queue, f.original);
    }
  });
}

for (const failureWrite of [1, 2]) {
  test(`journal write ${failureWrite} failure preserves the command across restart`, async () => {
    const f = await setup(); let writes = 0, fail = true;
    const journal = { get: f.journal.get.bind(f.journal), remove: f.journal.remove.bind(f.journal),
      set: async (items: Record<string, unknown>) => {
        writes++; if (fail && writes === failureWrite) throw new Error('storage_unavailable');
        await f.journal.set(items);
      } };
    const rebuilder = createReplicaRebuilder({ ...f.deps, journal });
    assert.deepEqual(await rebuilder.handle(await f.request()), { ok: false, code: 'storage_unavailable' });
    assert.deepEqual(await f.store.listQueue(f.scope), f.original);
    assert.deepEqual(await f.credentials.loadBinding(), f.binding);
    assert.equal(f.requests.length, failureWrite - 1);
    fail = false;
    if (failureWrite === 1) assert.deepEqual(await rebuilder.handle(await f.request()), { ok: true, result: 'setup_required' });
    else {
      assert.equal(await createReplicaRebuilder({ ...f.deps, journal }).resume(), true);
      assert.deepEqual(new Headers(f.requests[1]!.init.headers), new Headers(f.requests[0]!.init.headers));
    }
    assert.deepEqual((await f.store.exportArchive(f.scope)).queue, f.original);
    assert.equal(f.pushCalls, 1);
  });
}

for (const boundary of ['archive', 'binding', 'new-scope']) {
  test(`restart after retirement and ${boundary} failure never repeats a confirmed DELETE or rotates twice`, async () => {
    const f = await setup(); let fail = true;
    const deps = { ...f.deps,
      store: { ...f.store, retireScope: async (...args: Parameters<typeof f.store.retireScope>) => {
        if (fail && boundary === 'archive') throw new Error('storage_unavailable'); return f.store.retireScope(...args);
      } }, credentials: { ...f.credentials, replaceBindingForRebuild: async (...args: Parameters<typeof f.credentials.replaceBindingForRebuild>) => {
        if (fail && boundary === 'binding') throw new Error('storage_unavailable'); return f.credentials.replaceBindingForRebuild(...args);
      } }, ensureScope: async () => {
        if (fail && boundary === 'new-scope') throw new Error('storage_unavailable'); return f.deps.ensureScope();
      } };
    assert.deepEqual(await createReplicaRebuilder(deps).handle(await f.request()), { ok: false, code: 'storage_unavailable' });
    const plan = (await f.journal.get(REPLICA_REBUILD_JOURNAL))[REPLICA_REBUILD_JOURNAL] as {
      retirement: { confirmed?: true }; nextBinding: { replicaId: string } };
    assert.equal(plan.retirement.confirmed, true); assert.equal(f.requests.length, 1);
    await f.credentials.clearSession(); fail = false;
    assert.equal(await createReplicaRebuilder(deps).resume(), true);
    assert.equal((await f.credentials.loadBinding())?.replicaId, plan.nextBinding.replicaId);
    assert.deepEqual((await f.store.exportArchive(f.scope)).queue, f.original);
    assert.equal(f.requests.length, 1); assert.equal(f.authorityCalls, 0);
  });
}

test('credential, target and authority changes cannot turn a late 204 into local retirement', async () => {
  const f = await setup(); f.setResponse(async () => {
    await f.credentials.revokeAuthority(); return new Response(null, { status: 204 });
  });
  const result = await f.rebuilder.handle(await f.request()); assert.equal(result.ok, false);
  assert.deepEqual(await f.store.listQueue(f.scope), f.original);
  assert.deepEqual(await f.credentials.loadBinding(), f.binding);
  await assert.rejects(f.store.exportArchive(f.scope), /archive_not_found/);
  assert.equal(f.requests.length, 1);
  f.setRestore(null); await assert.rejects(createReplicaRebuilder(f.deps).resume(), /rebuild_authentication_required/);
  assert.ok((await f.journal.get(REPLICA_REBUILD_JOURNAL))[REPLICA_REBUILD_JOURNAL]);
});

test('rediscovery cannot silently move a retained request to a different endpoint', async () => {
  const f = await setup(); f.setResponse(async () => { throw new Error('offline'); });
  await f.rebuilder.handle(await f.request()); const retained = await f.journal.get(null);
  f.setEndpoint({ href: 'https://known.example/another-retire', reauthorization: true });
  assert.deepEqual(await f.rebuilder.handle(await f.request()), { ok: false, code: 'retirement_target_changed' });
  assert.deepEqual(await f.journal.get(null), retained); assert.equal(f.requests.length, 1);
  assert.deepEqual(await f.store.listQueue(f.scope), f.original);
});
