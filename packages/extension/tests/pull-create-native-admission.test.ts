import { afterEach, expect, test, vi } from 'vitest';
import { subscriptionStore } from '../src/bookmark-subscriptions/store.js';
import { NativeWriteNotStartedError } from '../src/native-call-result.js';
import { duringNativeAdmission, pullNativeWrapperFixture } from './pull-native-wrapper-fixture.js';
import { pullFixtures } from './pull-effect-fixtures.js';

afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); await subscriptionStore.close(); });

for (const kind of ['create', 'restore', 'materialize'] as const) {
  test.each(['unchanged', 'private-parent', 'excluded-parent'] as const)
  (`ordinary Pull ${kind} checks its parent after final native admission (%s)`, async change => {
    const f = await pullNativeWrapperFixture();
    try {
      const applier = await stage(f, kind), rawCreate = vi.spyOn(f.native, 'create');
      const injected = duringNativeAdmission(async () => {
        if (change === 'private-parent') await f.native.move('4', { parentId: '3', index: 0 });
        if (change === 'excluded-parent') await exclude(f, '4', 'destination');
      });
      let refusal: unknown; await applier.resume().catch(error => { refusal = error; });
      expect(injected()).toBe(true);
      if (change === 'unchanged') {
        expect(refusal).toBeUndefined(); expect(rawCreate).toHaveBeenCalledOnce();
        expect((await f.native.getChildren('4'))).toHaveLength(1);
        expect((await f.store.getCursor(f.scope))?.cursor).toBe('next');
      } else {
        expect(rawCreate).not.toHaveBeenCalled();
        expect(refusal).toBeInstanceOf(NativeWriteNotStartedError);
        expect((await f.native.getChildren('4'))).toEqual([]);
        expect((await f.store.getCursor(f.scope))?.cursor).not.toBe('next');
        expect(await f.store.listAckIntents(f.scope)).toEqual([]);
        const attempts = await f.store.listApplyIntents(f.scope);
        expect(attempts.some(row => row.nativeResult === 'not_started' && row.replayState === 'not_started')).toBe(true);
        expect(attempts.some(row => row.apiResultEvidence?.nativeId)).toBe(false);
        expect((await f.store.listPullEvents(f.scope))[0]?.state).toBe('intent_prepared');
        f.restart();
        await expect((await f.applier()).resume()).rejects.toThrow('recovery_required');
        expect(rawCreate).not.toHaveBeenCalled();
        expect((await f.store.getScope(f.scope))?.metadata?.recoveryCode).toBe('need_authority');
        expect((await f.store.listApplyIntents(f.scope)).some(row => row.nativeResult === 'result_unknown')).toBe(false);
      }
    } finally { f.close(); }
  });
}

test.each(['unchanged', 'private-parent', 'excluded-parent'] as const)
('independent subtree child create uses the current authority of its receipt-proven new parent (%s)', async change => {
  const f = await pullNativeWrapperFixture();
  try {
    const applier = await stage(f, 'materialize', true), read = subscriptionStore.pendingOperations.bind(subscriptionStore);
    let injected = false, createdParent: string | undefined;
    vi.spyOn(subscriptionStore, 'pendingOperations').mockImplementation(async () => {
      const rows = await read();
      const created = f.native.calls.find(call => call.kind === 'create')?.nativeId;
      if (!injected && created) {
        injected = true; createdParent = created;
        if (change === 'private-parent') await f.native.move(created, { parentId: '3', index: 0 });
        if (change === 'excluded-parent') await exclude(f, created, 'target');
      }
      return rows;
    });
    let refusal: unknown; await applier.resume().catch(error => { refusal = error; });
    expect(injected).toBe(true); expect(createdParent).toBeTruthy();
    const creates = f.native.calls.filter(call => call.kind === 'create');
    if (change === 'unchanged') {
      expect(refusal).toBeUndefined(); expect(creates).toHaveLength(2);
      expect((await f.native.getChildren(createdParent!))[0]?.title).toBe('Child');
      expect((await f.store.getCursor(f.scope))?.cursor).toBe('next');
    } else {
      expect(creates).toHaveLength(1);
      expect(refusal).toBeInstanceOf(NativeWriteNotStartedError);
      expect(await f.native.getChildren(createdParent!)).toEqual([]);
      expect((await f.store.getCursor(f.scope))?.cursor).not.toBe('next');
      expect(await f.store.listAckIntents(f.scope)).toEqual([]);
    }
    expect(f.native.getNode('2')?.parentId).toBe('8');
    expect(f.native.getNode('6')?.parentId).toBe('2');
  } finally { f.close(); }
});

test.each(['create', 'restore', 'materialize'] as const)
('a real %s create call interrupted before its receipt stays unknown and never repeats', async kind => {
  const f = await pullNativeWrapperFixture();
  try {
    const applier = await stage(f, kind), create = f.native.create.bind(f.native);
    const raw = vi.spyOn(f.native, 'create').mockImplementationOnce(async details => {
      await create(details); throw new Error('worker_crash');
    });
    await expect(applier.resume()).rejects.toThrow('worker_crash');
    expect(raw).toHaveBeenCalledOnce();
    f.restart();
    await expect((await f.applier()).resume()).rejects.toThrow('native_result_unknown');
    expect(raw).toHaveBeenCalledOnce(); expect(await f.native.getChildren('4')).toHaveLength(1);
    expect((await f.store.getCursor(f.scope))?.cursor).not.toBe('next');
    expect(await f.store.listAckIntents(f.scope)).toEqual([]);
  } finally { f.close(); }
});

test.each(['create', 'restore', 'materialize'] as const)
('an unstarted %s retries after a public parent edit without losing the local title', async kind => {
  const f = await pullNativeWrapperFixture();
  try {
    const applier = await stage(f, kind), raw = vi.spyOn(f.native, 'create');
    const injected = duringNativeAdmission(() => f.native.update('4', { title: 'Locally renamed parent' }));
    await expect(applier.resume()).rejects.toBeInstanceOf(NativeWriteNotStartedError);
    expect(injected()).toBe(true); expect(raw).not.toHaveBeenCalled();
    expect((await f.store.listPullEvents(f.scope))[0]?.state).toBe('intent_prepared');
    expect((await f.store.getScope(f.scope))?.lifecycle).toBe('active');
    f.restart(); await (await f.applier()).resume();
    expect(raw).toHaveBeenCalledOnce();
    expect(await f.native.getChildren('4')).toHaveLength(1);
    expect(f.native.getNode('4')?.title).toBe('Locally renamed parent');
    expect((await f.store.getCursor(f.scope))?.cursor).toBe('next');
  } finally { f.close(); }
});

async function exclude(f: Awaited<ReturnType<typeof pullNativeWrapperFixture>>, nativeId: string, priorColpId: string) {
  await f.store.putLocalSyncExclusion(f.scope, { nativeId, rootNativeId: '1', priorColpId,
    generation: f.scope.generation, decisionId: 'keep-local', sourceKind: 'remote_delete' });
}

async function stage(f: Awaited<ReturnType<typeof pullNativeWrapperFixture>>,
  kind: 'create' | 'restore' | 'materialize', withChild = false) {
  if (kind === 'restore') {
    await f.native.remove('2'); await f.store.deleteMapping(f.scope, '2');
    await f.store.putMapping(f.scope, { ...f.target, nativeId: 'unmounted:target' });
  }
  if (kind === 'materialize') {
    f.native.seed({ id: '8', parentId: '0', index: 1, title: 'Detached source' });
    await f.store.putMountBinding(f.scope, { mountId: 'source', nativeRootId: '8', remoteMountNodeId: 'source-root',
      customSourceKey: 'folder:8', boundaryVersion: 'source-v1', materialized: true, status: 'detached' });
    await f.store.putMapping(f.scope, { ...f.root, nativeId: '8', colpId: 'source-root', rootNativeId: '8', mountId: 'source' });
    await f.native.move('2', { parentId: '8', index: 0 });
    await f.store.putMapping(f.scope, { ...f.target, rootNativeId: '8', mountId: 'source', parentNativeId: '8', parentColpId: 'source-root',
      ...(withChild ? { nodeKind: 'folder', projection: { ...f.target.projection, content: { title: 'Target' } } } : {}) });
    if (withChild) {
      f.native.seed({ id: '2', parentId: '8', index: 0, title: 'Target' });
      f.native.seed({ id: '6', parentId: '2', index: 0, title: 'Child', url: 'https://child.test/' });
      await f.store.putMapping(f.scope, { ...f.target, nativeId: '6', colpId: 'child', rootNativeId: '8', mountId: 'source',
        parentNativeId: '2', parentColpId: 'target', projection: { ...f.target.projection,
          content: { title: 'Child', url: 'https://child.test/' } } });
    }
  }
  f.native.calls.length = 0;
  const common = { sequence: 1, collectionId: f.scope.collectionId, parentId: 'destination' };
  const event = kind === 'create' ? pullFixtures.createEvent({ ...common, kind: 'Bookmark' })
    : kind === 'restore' ? pullFixtures.restoreEvent({ ...common, targetId: 'target' })
      : pullFixtures.mutationEvent({ ...common, kind: 'move', targetId: 'target', targetKind: withChild ? 'folder' : 'bookmark' });
  const applier = await f.applier();
  await applier.stage(pullFixtures.page({ events: [event], nextCursor: 'next', collectionRevision: 'next-r1' }));
  return applier;
}
