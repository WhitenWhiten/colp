import assert from 'node:assert/strict';
import { test } from 'vitest';
import { MemoryStorageArea } from '../src/credential-store.js';
import { createPersonalSyncPolicyStore } from '../src/personal-sync-policy.js';
import { createPersonalSyncLifecycle, type LifecycleFacts } from '../src/personal-sync-lifecycle.js';

const libraryFor = (id: string) => ({ id, title: 'Bookmarks', library: true as const,
  rootNodeId: `${id}-root`, bookmarksBarId: `${id}-bar`, otherBookmarksId: `${id}-other` });

function fixture() {
  const identity = { serverOrigin: 'https://known.test', accountId: 'one', collectionId: 'collection' };
  const storage = new MemoryStorageArea(), policy = createPersonalSyncPolicyStore(storage);
  let generation = 1, facts: LifecycleFacts = { digest: 'tree-and-work', queued: 2, attached: true };
  let available: 'available' | 'unavailable' | 'unknown' = 'available', archives = 0, reconnects = 0, wakes = 0;
  const lifecycle = createPersonalSyncLifecycle({ policy, identity: async () => identity, generation: async () => generation,
    assertCurrent: async expected => { if (expected !== generation) throw new Error('authority_fenced'); },
    facts: async () => facts, resolveTarget: async target => libraryFor(target.collectionId), available: async () => available,
    disconnect: async () => { archives++; facts = { ...facts, attached: false }; },
    reconnect: async (_identity, _generation, publish) => publish(async () => { reconnects++; }), wake: () => { wakes++; } });
  const preview = async (action: 'resume' | 'disconnect') => {
    const result = await lifecycle.handle({ kind: 'known.personalSync.preview', action });
    assert.ok('token' in result && 'revision' in result);
    return { kind: 'known.personalSync.change' as const, action, token: result.token!, revision: result.revision!, userGesture: true as const };
  };
  return { lifecycle, policy, identity, preview, storage,
    changeFacts: () => { facts = { ...facts, digest: 'changed' }; },
    switchAccount: () => { identity.accountId = 'other'; generation++; },
    setAvailability: (value: typeof available) => { available = value; },
    counts: () => ({ archives, reconnects, wakes }) };
}
test('Pause keeps the connection and work; Resume requires a fresh single-use preview', async () => {
  const f = fixture();
  await f.lifecycle.handle({ kind: 'known.personalSync.change', action: 'pause', revision: 'legacy', userGesture: true });
  assert.equal((await f.policy.read(f.identity)).mode, 'paused');
  assert.deepEqual(f.counts(), { archives: 0, reconnects: 0, wakes: 0 });
  const confirmation = await f.preview('resume');
  await f.lifecycle.handle(confirmation);
  assert.equal((await f.policy.read(f.identity)).mode, 'enabled');
  assert.deepEqual(f.counts(), { archives: 0, reconnects: 1, wakes: 1 });
  await assert.rejects(f.lifecycle.handle(confirmation), /preview_stale/);
});
test('changed trees, pending work and account authority invalidate disconnect without archiving', async () => {
  for (const change of ['tree', 'account']) {
    const f = fixture(), confirmation = await f.preview('disconnect');
    if (change === 'tree') f.changeFacts(); else f.switchAccount();
    await assert.rejects(f.lifecycle.handle(confirmation), /preview_stale/);
    assert.equal(f.counts().archives, 0);
  }
});
test('a disconnected connection archives once and resumes using a verified fresh connection', async () => {
  const f = fixture(); await f.lifecycle.handle(await f.preview('disconnect'));
  assert.equal((await f.policy.read(f.identity)).mode, 'disconnected');
  assert.equal(f.counts().archives, 1);
  await f.lifecycle.handle(await f.preview('resume'));
  assert.equal((await f.policy.read(f.identity)).mode, 'enabled');
  assert.equal(f.counts().reconnects, 1);
});
test('partial/offline listings and inaccessible targets cannot reopen sync or create a connection', async () => {
  for (const value of ['unknown', 'unavailable'] as const) {
    const f = fixture(); f.setAvailability(value);
    await assert.rejects(f.lifecycle.handle(await f.preview('resume')), /target_unverified|target_unavailable/);
    assert.equal(await f.policy.allowed(f.identity), false);
    assert.equal(f.counts().reconnects, 0); assert.equal(f.counts().wakes, 0);
  }
});
test('an interrupted disconnect with attached old work cannot silently resume it', async () => {
  const f = fixture(); await f.policy.write(f.identity, 'disconnected');
  for (let attempt = 0; attempt < 3; attempt++) {
    await assert.rejects(f.lifecycle.handle(await f.preview('resume')), /disconnect_incomplete/);
    const stopped = await f.policy.read(f.identity);
    assert.equal(stopped.mode, 'disconnected');
    await f.lifecycle.handle({ kind: 'known.personalSync.change', action: 'pause', revision: stopped.revision, userGesture: true });
  }
  assert.equal((await f.policy.read(f.identity)).mode, 'disconnected');
  assert.equal(await f.policy.allowed(f.identity), false);
  assert.equal(f.counts().reconnects, 0);
});
test('failed off persistence cannot archive the queue and stays closed for this worker', async () => {
  const f = fixture(), confirmation = await f.preview('disconnect');
  f.storage.set = async () => { throw new Error('disk unavailable'); };
  await assert.rejects(f.lifecycle.handle(confirmation), /disk unavailable/);
  assert.equal(await f.policy.allowed(f.identity), false); assert.equal(f.counts().archives, 0);
});

test('failed retirement refuses repeated Resume without changing disconnected state', async () => {
  const identity = { serverOrigin: 'https://known.test', accountId: 'owner', collectionId: 'one' };
  const policy = createPersonalSyncPolicyStore(new MemoryStorageArea());
  let reconnects = 0, wakes = 0;
  const lifecycle = createPersonalSyncLifecycle({ policy, identity: async () => identity, generation: async () => 1,
    assertCurrent: async () => undefined, facts: async () => ({ digest: 'old-queue', queued: 2, attached: true }),
    resolveTarget: async target => libraryFor(target.collectionId),
    available: async () => 'available', disconnect: async () => { throw new Error('archive_failed'); },
    reconnect: async (_identity, _generation, publish) => publish(async () => { reconnects++; }), wake: () => { wakes++; } });
  async function command(action: 'resume' | 'disconnect') {
    const preview = await lifecycle.handle({ kind: 'known.personalSync.preview', action });
    assert.ok('token' in preview && 'revision' in preview);
    return { kind: 'known.personalSync.change' as const, action, token: preview.token!, revision: preview.revision!, userGesture: true as const };
  }
  await assert.rejects(lifecycle.handle(await command('disconnect')), /archive_failed/);
  assert.equal((await policy.read(identity)).mode, 'disconnected');
  await assert.rejects(lifecycle.handle(await command('resume')), /disconnect_incomplete/);
  assert.equal((await policy.read(identity)).mode, 'disconnected');
  await assert.rejects(lifecycle.handle(await command('resume')), /disconnect_incomplete/);
  assert.equal((await policy.read(identity)).mode, 'disconnected');
  assert.equal(reconnects, 0); assert.equal(wakes, 0);
});

test('a stale Resume cannot publish attachment after a newer Disconnect', async () => {
  const identity = { serverOrigin: 'https://known.test', accountId: 'owner', collectionId: 'one' };
  const policy = createPersonalSyncPolicyStore(new MemoryStorageArea());
  let attached = true, reconnects = 0;
  let release!: (value: 'available') => void, entered!: () => void;
  const available = new Promise<'available'>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const lifecycle = createPersonalSyncLifecycle({ policy, identity: async () => identity, generation: async () => 1,
    assertCurrent: async () => undefined, facts: async () => ({ digest: attached ? 'attached' : 'detached', queued: 0, attached }),
    resolveTarget: async target => libraryFor(target.collectionId),
    available: async () => { entered(); return available; }, disconnect: async () => { attached = false; },
    reconnect: async (_identity, _generation, publish) => publish(async () => { attached = true; reconnects++; }), wake: () => undefined });
  async function command(action: 'resume' | 'disconnect') {
    const preview = await lifecycle.handle({ kind: 'known.personalSync.preview', action });
    assert.ok('token' in preview && 'revision' in preview);
    return { kind: 'known.personalSync.change' as const, action, token: preview.token!, revision: preview.revision!, userGesture: true as const };
  }
  const resume = lifecycle.handle(await command('resume'));
  const refused = assert.rejects(resume, /preview_stale/);
  await started; await lifecycle.handle(await command('disconnect'));
  assert.equal(attached, false);
  release('available'); await refused;
  assert.equal((await policy.read(identity)).mode, 'disconnected');
  assert.equal(reconnects, 0); assert.equal(attached, false);
});

test('a disconnected library rebuilt on the server reconnects to the reviewed current library', async () => {
  const identity = { serverOrigin: 'https://known.test', accountId: 'owner', collectionId: 'old-library' };
  const policy = createPersonalSyncPolicyStore(new MemoryStorageArea());
  await policy.write(identity, 'disconnected');
  let currentLibrary = libraryFor('rebuilt-library'), connected = '';
  const lifecycle = createPersonalSyncLifecycle({ policy, identity: async () => identity, generation: async () => 1,
    assertCurrent: async () => undefined, facts: async () => ({ digest: 'detached', queued: 0, attached: false }),
    resolveTarget: async () => currentLibrary,
    available: async target => target.collectionId === currentLibrary.id ? 'available' : 'unavailable',
    disconnect: async () => undefined,
    reconnect: async (target, _generation, publish) => publish(async () => { connected = target.collectionId; }),
    wake: () => undefined });
  async function preview() {
    const result = await lifecycle.handle({ kind: 'known.personalSync.preview', action: 'resume' });
    assert.ok('token' in result && 'revision' in result);
    return { result, command: { kind: 'known.personalSync.change' as const, action: 'resume' as const,
      token: result.token!, revision: result.revision!, userGesture: true as const } };
  }
  const first = await preview();
  assert.equal(first.result.collectionId, 'rebuilt-library');
  currentLibrary = libraryFor('changed-again');
  await assert.rejects(lifecycle.handle(first.command), /preview_stale/);
  assert.equal(connected, '');
  assert.equal((await policy.read(identity)).mode, 'disconnected');
  const reviewed = await preview();
  await lifecycle.handle(reviewed.command);
  assert.equal(connected, 'changed-again');
  assert.equal((await policy.read(identity)).mode, 'enabled');
  assert.equal((await policy.read(identity)).collectionId, 'changed-again');
});
