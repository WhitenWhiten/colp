import { afterEach, expect, test, vi } from 'vitest';
import { subscriptionStore } from '../src/bookmark-subscriptions/store.js';
import { createChromePullBookmarkApi } from '../src/pull-bookmark-api.js';
import { recoverVerifiedOrFreeze } from '../src/recovery-guard.js';
import { detachScopeMount } from '../src/scope-detach.js';
import { NativeWriteNotStartedError } from '../src/native-call-result.js';
import type { MappingInput } from '../src/sync-state-store.js';
import { snapshotNativeFixture } from './snapshot-native-authority-fixture.js';

afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); await subscriptionStore.close(); });
type Fixture = Awaited<ReturnType<typeof snapshotNativeFixture>>;

async function actualApi(f: Fixture) {
  vi.stubGlobal('chrome', { bookmarks: f.chrome.api });
  const effects = await f.effects(createChromePullBookmarkApi());
  await effects.assertCurrent(); return effects.api;
}
function duringAdmission(change: () => Promise<unknown>) {
  const read = subscriptionStore.pendingOperations.bind(subscriptionStore);
  let injected = false;
  vi.spyOn(subscriptionStore, 'pendingOperations').mockImplementation(async () => {
    const rows = await read();
    if (!injected) { injected = true; await change(); }
    return rows;
  });
  return () => injected;
}
async function stageCreate(f: Fixture) {
  const parent: MappingInput = { ...f.privateRoot, nativeId: '4', colpId: 'parent',
    projection: { revision: 'parent-r1', digest: 'parent', childrenRevision: 'parent-c1', content: { title: 'Parent' } } };
  const fresh: MappingInput = { ...f.target, nativeId: 'recovery:fresh', colpId: 'fresh',
    parentNativeId: '4', parentColpId: 'parent',
    projection: { revision: 'fresh-r1', digest: 'fresh', content: { title: 'Fresh', url: 'https://fresh.test/' } } };
  await f.store.putMapping(f.scope, parent);
  const staged = [f.root, f.privateRoot, f.target, parent, fresh]; await f.stage(staged); return staged;
}

test('a real Snapshot create refused after wrapper admission resumes the same not-started intent once', async () => {
  const f = await snapshotNativeFixture();
  try {
    const api = await actualApi(f), staged = await stageCreate(f);
    const injected = duringAdmission(() => f.chrome.api.move('4', { parentId: '3', index: 0 }));
    await expect(recoverVerifiedOrFreeze({ scope: f.scope, store: f.store, staged, api, freezeUnprovenIdentity: true }))
      .rejects.toBeInstanceOf(NativeWriteNotStartedError);
    expect(injected()).toBe(true); expect(f.chrome.creates).toBe(0);
    const before = await f.store.getApplyIntent(f.scope, 'projection:create:fresh');
    expect(before).toMatchObject({ replayState: 'not_started', nativeResult: 'not_started' });
    expect(before?.apiResultEvidence).toBeUndefined();
    await f.chrome.api.move('4', { parentId: '1', index: 2 }); f.restart();
    const resumed = await actualApi(f);
    await recoverVerifiedOrFreeze({ scope: f.scope, store: f.store, staged, api: resumed,
      freezeUnprovenIdentity: true, recoveryOnly: true });
    expect(f.chrome.creates).toBe(1);
    expect(await f.store.getApplyIntent(f.scope, 'projection:create:fresh')).toMatchObject({
      intentId: before!.intentId, nativeResult: 'applied_with_evidence', apiResultEvidence: { nativeId: '5' },
    });
    expect(f.chrome.nodes.get('5')).toMatchObject({ parentId: '4', url: 'https://fresh.test/' });
    expect(await f.store.listQueue(f.scope)).toEqual([]);
  } finally { f.close(); }
});

test('a real Snapshot create with a lost native return cannot be replayed or adopted by name', async () => {
  const f = await snapshotNativeFixture();
  try {
    const api = await actualApi(f), staged = await stageCreate(f);
    const create = f.chrome.api.create;
    vi.spyOn(f.chrome.api, 'create').mockImplementationOnce(async input => {
      await create(input); throw new Error('worker_crash');
    });
    await expect(recoverVerifiedOrFreeze({ scope: f.scope, store: f.store, staged, api, freezeUnprovenIdentity: true }))
      .rejects.toThrow('worker_crash');
    const started = await f.store.getApplyIntent(f.scope, 'projection:create:fresh');
    expect(started).toMatchObject({ state: 'browser_call_started', replayState: 'started' });
    expect(started?.apiResultEvidence).toBeUndefined(); expect(f.chrome.creates).toBe(1);
    await create({ parentId: '4', title: 'Fresh', url: 'https://fresh.test/' });
    f.restart(); const resumed = await actualApi(f);
    await expect(recoverVerifiedOrFreeze({ scope: f.scope, store: f.store, staged, api: resumed,
      freezeUnprovenIdentity: true, recoveryOnly: true })).rejects.toThrow('snapshot_native_projection_ambiguous');
    expect(f.chrome.creates).toBe(2);
    expect(await f.store.getApplyIntent(f.scope, 'projection:create:fresh')).toEqual(started);
    expect(await f.store.getMappingByNativeId(f.scope, '6')).toBeNull();
  } finally { f.close(); }
});

test.each(['detach', 'private_identity_loss', 'private_ancestor'] as const)
('Snapshot delete rechecks %s after all native wrapper admission awaits', async changed => {
  const f = await snapshotNativeFixture();
  try {
    const api = await actualApi(f), staged = [f.root, f.privateRoot]; await f.stage(staged);
    const remove = vi.spyOn(f.chrome.api, 'remove');
    const injected = duringAdmission(async () => {
      if (changed === 'detach') await detachScopeMount(f.store, f.scope, 'mount');
      else if (changed === 'private_identity_loss') await f.store.deleteMapping(f.scope, '3');
      else await f.chrome.api.move('2', { parentId: '3', index: 0 });
    });
    await expect(recoverVerifiedOrFreeze({ scope: f.scope, store: f.store, staged, api, freezeUnprovenIdentity: true }))
      .rejects.toBeInstanceOf(NativeWriteNotStartedError);
    expect(injected()).toBe(true); expect(remove).not.toHaveBeenCalled(); expect(f.chrome.nodes.has('2')).toBe(true);
    expect(await f.store.getMappingByColpId(f.scope, 'target')).toMatchObject(f.target);
    expect((await f.store.listProjectionIntents(f.scope))[0]?.state).toBe('recovery');
    expect(await f.store.listQueue(f.scope)).toEqual([]);
  } finally { f.close(); }
});
