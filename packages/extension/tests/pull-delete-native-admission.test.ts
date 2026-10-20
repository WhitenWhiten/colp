import { afterEach, expect, test, vi } from 'vitest';
import { canonicalAuthoritativeEffectDigest } from '@know-n/colp/sync';
import { subscriptionStore } from '../src/bookmark-subscriptions/store.js';
import { NativeWriteNotStartedError } from '../src/native-call-result.js';
import { detachScopeMount } from '../src/scope-detach.js';
import { duringNativeAdmission, pullNativeWrapperFixture } from './pull-native-wrapper-fixture.js';
import { pullFixtures } from './pull-effect-fixtures.js';

afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); await subscriptionStore.close(); });

test('a late local title refuses delete, persists not-started and survives restart as retained local work', async () => {
  const f = await pullNativeWrapperFixture();
  try {
    const applier = await f.stage('delete');
    const injected = duringNativeAdmission(() => f.native.update('2', { title: 'Keep this local edit' }));
    await expect(applier.resume()).rejects.toBeInstanceOf(NativeWriteNotStartedError);
    expect(injected()).toBe(true);
    expect(f.native.calls).toEqual([{ kind: 'update', nativeId: '2' }]);
    expect((await f.store.listPullEvents(f.scope))[0]?.state).toBe('intent_prepared');
    expect((await f.store.listApplyIntents(f.scope))[0]).toMatchObject({ state: 'intent_prepared',
      nativeResult: 'not_started', replayState: 'not_started',
      anchors: { deleteMemberResults: { target: 'not_started' },
        deletePreimages: { target: { nativeId: '2', title: 'Target', url: 'https://target.test/', parentId: '1' } } } });
    expect((await f.store.getCursor(f.scope))?.cursor).not.toBe('next');
    expect(await f.store.listAckIntents(f.scope)).toEqual([]);
    f.restart(); await (await f.applier()).resume();
    expect(f.native.getNode('2')?.title).toBe('Keep this local edit');
    expect(f.native.calls).toEqual([{ kind: 'update', nativeId: '2' }]);
    expect(await f.store.getLocalSyncExclusion(f.scope, '2')).toMatchObject({ priorColpId: 'target' });
    expect((await f.store.listApplyIntents(f.scope))[0]?.anchors).toMatchObject({ deleteMemberResults: { target: 'retained' } });
    expect((await f.store.getCursor(f.scope))?.cursor).toBe('next');
    expect(await f.store.listQueue(f.scope)).toEqual([]);
  } finally { f.close(); }
});

test.each(['private', 'detach', 'local-exclusion'] as const)
('delete refuses a late %s boundary without calling raw Chrome', async change => {
  const f = await pullNativeWrapperFixture();
  try {
    const applier = await f.stage('delete');
    const injected = duringNativeAdmission(async () => {
      if (change === 'private') await f.native.move('2', { parentId: '3', index: 0 });
      if (change === 'detach') await detachScopeMount(f.store, f.scope, 'mount');
      if (change === 'local-exclusion') await f.store.putLocalSyncExclusion(f.scope, {
        nativeId: '2', rootNativeId: '1', priorColpId: 'target', generation: f.scope.generation,
        decisionId: 'keep-local', sourceKind: 'remote_delete',
      });
    });
    await expect(applier.resume()).rejects.toBeInstanceOf(NativeWriteNotStartedError);
    expect(injected()).toBe(true);
    expect(f.native.calls.filter(call => call.kind === 'delete')).toEqual([]);
    expect(f.native.getNode('2')?.title).toBe('Target');
    expect((await f.store.getCursor(f.scope))?.cursor).not.toBe('next');
    expect(await f.store.listAckIntents(f.scope)).toEqual([]);
    f.restart();
    expect((await f.store.listApplyIntents(f.scope))[0]).toMatchObject({ state: 'intent_prepared',
      nativeResult: 'not_started', replayState: 'not_started' });
  } finally { f.close(); }
});

test('a partial subtree delete retains its completed ledger when the remaining parent is edited late', async () => {
  const f = await pullNativeWrapperFixture();
  try {
    const applier = await subtree(f, true), read = subscriptionStore.pendingOperations.bind(subscriptionStore);
    let injected = false;
    vi.spyOn(subscriptionStore, 'pendingOperations').mockImplementation(async () => {
      const rows = await read();
      if (!injected && !f.native.getNode('6')) { injected = true; await f.native.update('2', { title: 'Keep folder' }); }
      return rows;
    });
    await expect(applier.resume()).rejects.toBeInstanceOf(NativeWriteNotStartedError);
    expect(injected).toBe(true);
    expect(f.native.calls).toEqual([{ kind: 'delete', nativeId: '6' }, { kind: 'update', nativeId: '2' }]);
    expect((await f.store.listPullEvents(f.scope))[0]?.state).toBe('browser_call_started');
    expect((await f.store.listApplyIntents(f.scope))[0]).toMatchObject({ replayState: 'started',
      anchors: { deleteMemberResults: { child: 'applied', target: 'not_started' } } });
    expect((await f.store.getCursor(f.scope))?.cursor).not.toBe('next');
    expect(await f.store.listAckIntents(f.scope)).toEqual([]);
    f.restart(); await (await f.applier()).resume();
    expect(f.native.getNode('2')?.title).toBe('Keep folder');
    expect(f.native.calls.filter(call => call.kind === 'delete')).toEqual([{ kind: 'delete', nativeId: '6' }]);
    expect((await f.store.listApplyIntents(f.scope))[0]?.anchors).toMatchObject({
      deleteMemberResults: { child: 'applied', target: 'retained' } });
    expect((await f.store.getCursor(f.scope))?.cursor).toBe('next');
  } finally { f.close(); }
});

test('a child arriving after the approved member set is never recursively deleted', async () => {
  const f = await pullNativeWrapperFixture();
  try {
    const applier = await subtree(f, false);
    const remove = vi.spyOn(f.native, 'remove'), recursive = vi.spyOn(f.native, 'removeTree');
    const injected = duringNativeAdmission(() => f.native.create({ parentId: '2', title: 'Unapproved child', url: 'https://local.test/' }));
    await applier.resume();
    expect(injected()).toBe(true);
    expect(remove).toHaveBeenCalledOnce(); expect(recursive).not.toHaveBeenCalled();
    expect(f.native.getNode('2')?.title).toBe('Target');
    expect((await f.native.getChildren('2'))[0]?.title).toBe('Unapproved child');
    expect(f.native.calls.filter(call => call.kind === 'delete')).toEqual([]);
    expect((await f.store.listApplyIntents(f.scope))[0]?.anchors).toMatchObject({
      deleteMemberSet: [{ nativeId: '2', colpId: 'target' }], deleteMemberResults: { target: 'retained' } });
    expect((await f.store.getCursor(f.scope))?.cursor).toBe('next');
  } finally { f.close(); }
});

test('a later admission refusal never rewrites evidence of an older raw remove invocation', async () => {
  const f = await pullNativeWrapperFixture();
  try {
    const applier = await f.stage('delete');
    const remove = vi.spyOn(f.native, 'remove').mockImplementationOnce(async () => { throw new Error('worker_crash'); });
    await expect(applier.resume()).rejects.toThrow('worker_crash');
    expect(remove).toHaveBeenCalledOnce();
    expect((await f.store.listPullEvents(f.scope))[0]?.state).toBe('browser_call_started');
    f.restart();
    const injected = duringNativeAdmission(() => f.native.update('2', { title: 'After restart edit' }));
    await expect((await f.applier()).resume()).rejects.toBeInstanceOf(NativeWriteNotStartedError);
    expect(injected()).toBe(true); expect(remove).toHaveBeenCalledOnce();
    expect((await f.store.listPullEvents(f.scope))[0]?.state).toBe('browser_call_started');
    expect((await f.store.listApplyIntents(f.scope))[0]?.replayState).toBe('started');
    expect(f.native.getNode('2')?.title).toBe('After restart edit');
    expect((await f.store.getCursor(f.scope))?.cursor).not.toBe('next');
  } finally { f.close(); }
});

async function subtree(f: Awaited<ReturnType<typeof pullNativeWrapperFixture>>, withChild: boolean) {
  f.native.seed({ id: '2', parentId: '1', index: 1, title: 'Target' });
  await f.store.putMapping(f.scope, { ...f.target, nodeKind: 'folder',
    projection: { ...f.target.projection, content: { title: 'Target' } } });
  if (withChild) {
    f.native.seed({ id: '6', parentId: '2', index: 0, title: 'Child', url: 'https://child.test/' });
    await f.store.putMapping(f.scope, { ...f.target, nativeId: '6', colpId: 'child', parentNativeId: '2', parentColpId: 'target',
      projection: { ...f.target.projection, content: { title: 'Child', url: 'https://child.test/' } } });
  }
  const event = pullFixtures.subtreeEvent({ sequence: 1, collectionId: f.scope.collectionId,
    targetId: 'target', members: withChild ? ['target', 'child'] : ['target'], paged: false });
  const effect = { ...event.effect, parentRevision: { parentId: 'root', childrenRevision: 'children-1' } };
  const applier = await f.applier();
  await applier.stage(pullFixtures.page({ events: [{ ...event,
    effect: { ...effect, effectDigest: canonicalAuthoritativeEffectDigest(effect) } }],
  nextCursor: 'next', collectionRevision: 'next-r1' }));
  return applier;
}
