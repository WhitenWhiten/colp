import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPersonalSyncPolicyStore, parsePersonalSyncPolicy, personalSyncAllowed, personalSyncKey } from '../src/personal-sync-policy.js';
const a = { serverOrigin: 'https://know-n.test', accountId: 'a', collectionId: 'one' };
function fixture() {
  const data = {};
  const storage = { async get(key) { return { [key]: structuredClone(data[key]) }; }, async set(items) { Object.assign(data, structuredClone(items)); } };
  return { data, storage, policy: createPersonalSyncPolicyStore(storage) };
}
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
test('legacy policy does not create a target; corrupt/future policy fails closed', () => {
  assert.equal(parsePersonalSyncPolicy(undefined).revision, 'legacy');
  for (const raw of [null, {}, false, { version: 2 }, { version: 1, mode: 'enabled' }]) assert.equal(parsePersonalSyncPolicy(raw).mode, 'paused');
});
test('policy identities isolate accounts, origins and target collections', async () => {
  const { policy } = fixture(); await policy.write(a, 'paused');
  assert.equal(await policy.allowed(a), false);
  assert.equal(await policy.allowed({ ...a, accountId: 'b' }), true);
  assert.equal(await policy.allowed({ ...a, serverOrigin: 'https://another.test' }), true);
  await policy.write(a, 'enabled');
  assert.equal(await policy.allowed({ ...a, collectionId: 'two' }), false);
  assert.equal(personalSyncAllowed(await policy.read(a), a), true);
});
test('pause survives a store restart and a resumed connection cannot revive an old capability', async () => {
  const { policy, storage } = fixture(); const old = await policy.capture(a);
  await policy.write(a, 'paused'); assert.equal(old.signal.aborted, true);
  const restarted = createPersonalSyncPolicyStore(storage); assert.equal(await restarted.allowed(a), false);
  await policy.write(a, 'enabled'); await assert.rejects(old.assertCurrent(), /personal_sync_stopped/);
  await assert.rejects(old.dispatch(async () => 'must not send'), /personal_sync_stopped/);
  assert.equal(await (await policy.capture(a)).dispatch(async () => 'fresh'), 'fresh');
});
test('an in-flight HTTP response does not hold Pause and receives an abort signal', async () => {
  const { policy } = fixture(), response = deferred(), dispatched = deferred(); const lease = await policy.capture(a);
  let signal; const pending = lease.dispatch(current => { signal = current; dispatched.resolve(); return response.promise; });
  await dispatched.promise; await policy.write(a, 'paused');
  assert.equal(signal.aborted, true); response.resolve('already dispatched'); await pending;
  await assert.rejects(lease.assertCurrent(), /personal_sync_stopped/);
});
test('an off intent rejects a send even before persistence completes', async () => {
  const { policy, storage } = fixture(), write = deferred(); const lease = await policy.capture(a);
  storage.set = () => write.promise;
  const paused = policy.write(a, 'paused'); let calls = 0;
  const send = lease.dispatch(async () => { calls++; });
  write.resolve(); await paused; await assert.rejects(send, /personal_sync_stopped/); assert.equal(calls, 0);
});
test('failed persistence stays blocked until a newer successful explicit choice', async () => {
  const { policy, storage } = fixture(), set = storage.set;
  storage.set = async () => { throw new Error('disk unavailable'); };
  await assert.rejects(policy.write(a, 'paused'), /disk unavailable/);
  assert.equal(await policy.allowed(a), false);
  storage.set = set; await policy.write(a, 'enabled'); assert.equal(await policy.allowed(a), true);
});
test('stale background results cannot replace a newer target decision', async () => {
  const { policy } = fixture(); const initial = await policy.read(a);
  await policy.write({ ...a, collectionId: 'two' }, 'enabled');
  await assert.rejects(policy.write(a, 'target-unavailable', 'target-unavailable', initial.revision), /preview_stale/);
  assert.equal((await policy.read(a)).collectionId, 'two');
  assert.equal(await policy.allowed({ ...a, collectionId: 'two' }), true);
});
test('storage change notifications fence leases but do not strand the worker own writes', async () => {
  const { policy, storage } = fixture(), set = storage.set;
  storage.set = async items => { await set(items); policy.changed(Object.keys(items)); };
  await policy.write(a, 'paused'); await policy.write(a, 'enabled');
  assert.equal(await policy.allowed(a), true);
  const lease = await policy.capture(a); policy.changed([personalSyncKey(a)]);
  assert.equal(lease.signal.aborted, true); await assert.rejects(lease.assertCurrent());
});
test('a write racing initial capability acquisition fails closed', async () => {
  const { policy, storage } = fixture(), get = storage.get, gate = deferred();
  storage.get = async key => { const value = await get(key); await gate.promise; return value; };
  const lease = policy.capture(a); await Promise.resolve(); const off = policy.write(a, 'paused'); gate.resolve();
  await off; await assert.rejects(lease, /personal_sync_stopped/);
});
test('rapid off/on/off requests finish off without reviving a pending send', async () => {
  const { policy } = fixture(), lease = await policy.capture(a);
  await Promise.all([policy.write(a, 'paused'), policy.write(a, 'enabled'), policy.write(a, 'disconnected')]);
  assert.equal((await policy.read(a)).mode, 'disconnected'); await assert.rejects(lease.assertCurrent());
});
test('scope mismatch is blocked while a sibling account remains independent', async () => {
  const { policy } = fixture(); await policy.write(a, 'enabled');
  await assert.rejects(policy.capture({ ...a, collectionId: 'other' }), /personal_sync_stopped/);
  const sibling = await policy.capture({ ...a, accountId: 'b' }); await policy.write(a, 'paused');
  await sibling.assertCurrent(); assert.equal(sibling.signal.aborted, false);
});
test('pause, logout and unavailable listings preserve durable or failed disconnect intent', async () => {
  for (const failed of [false, true]) {
    const { policy, storage } = fixture(), set = storage.set;
    if (failed) storage.set = async () => { throw new Error('disk unavailable'); };
    if (failed) await assert.rejects(policy.write(a, 'disconnected'), /disk unavailable/);
    else await policy.write(a, 'disconnected');
    assert.equal((await policy.read(a)).mode, 'disconnected');
    storage.set = set;
    await policy.write(a, 'paused', 'signed-out');
    await policy.write(a, 'target-unavailable', 'target-unavailable');
    assert.equal((await createPersonalSyncPolicyStore(storage).read(a)).mode, 'disconnected');
  }
});
test('local attachment publication rejects a superseded policy before running its effect', async () => {
  const { policy } = fixture(), before = await policy.write(a, 'paused');
  await policy.write(a, 'disconnected');
  let attached = false;
  await assert.rejects(policy.withRevision(a, before.revision, async () => { attached = true; }), /preview_stale/);
  assert.equal(attached, false);
});
test('disconnect persistence follows an admitted local mutation while network admission closes immediately', async () => {
  const { policy } = fixture(), before = await policy.write(a, 'enabled'), lease = await policy.capture(a);
  const entered = deferred(), complete = deferred();
  let attached = false;
  const publication = policy.withRevision(a, before.revision, async () => {
    entered.resolve(); await complete.promise; attached = true;
  });
  await entered.promise;
  const disconnect = policy.write(a, 'disconnected', 'user', before.revision);
  assert.equal(lease.signal.aborted, true);
  await assert.rejects(lease.assertCurrent(), /personal_sync_stopped/);
  complete.resolve(); await publication; await disconnect;
  assert.equal(attached, true);
  assert.equal((await policy.read(a)).mode, 'disconnected');
});
