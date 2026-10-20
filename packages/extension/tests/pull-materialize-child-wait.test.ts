import { afterEach, expect, test, vi } from 'vitest';
import { subscriptionStore } from '../src/bookmark-subscriptions/store.js';
import { projectNativeWaits } from '../src/native-wait.js';
import { createChromePullBookmarkApi } from '../src/pull-bookmark-api.js';
import { handleNativeWaitRequest } from '../src/sw/native-wait.js';
import { pullNativeWrapperFixture } from './pull-native-wrapper-fixture.js';
import { stageMaterialization } from './pull-materialize-wait-fixture.js';
import { pullFixtures } from './pull-effect-fixtures.js';
import type { NativeWaitConfirmAction } from '../src/types.js';

afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); await subscriptionStore.close(); });

async function childWait(withEvent = true, nested = false) {
  const f = await pullNativeWrapperFixture();
  const applier = await stageMaterialization(f, 'materialize', true), create = f.native.create.bind(f.native);
  if (nested) {
    f.native.seed({ id: '6', parentId: '2', index: 0, title: 'Child' });
    const { scopeKey: _scopeKey, ...child } = (await f.store.getMappingByColpId(f.scope, 'child'))!;
    await f.store.putMapping(f.scope, { ...child, nodeKind: 'folder', projection: { ...child.projection, content: { title: 'Child' } } });
    f.native.seed({ id: '7', parentId: '6', index: 0, title: 'Grandchild', url: 'https://grand.test/' });
    await f.store.putMapping(f.scope, { ...child, nativeId: '7', colpId: 'grandchild', parentNativeId: '6', parentColpId: 'child',
      projection: { ...child.projection, content: { title: 'Grandchild', url: 'https://grand.test/' } } });
  }
  let observed: boolean | undefined, count = 0;
  const raw = vi.spyOn(f.native, 'create').mockImplementation(async details => {
    const result = await create(details);
    if (++count === 2) {
      if (withEvent) observed = await applier.observe({ kind: 'create', nativeId: result.id,
        details: { parentId: details.parentId!, node: { kind: nested ? 'folder' : 'bookmark', title: details.title!,
          ...(details.url ? { url: details.url } : {}) } } });
      throw new Error('worker_crash');
    }
    return result;
  });
  await expect(applier.resume()).rejects.toThrow('worker_crash'); f.restart();
  await expect((await f.applier()).resume()).rejects.toThrow('native_result_unknown');
  const [wait] = await projectNativeWaits(f.store, f.scope);
  expect(wait?.colpId).toBe('child'); expect(wait?.title).toBe('Child');
  const rootId = wait!.intentId.replace(':range:child', '');
  const root = (await f.store.getApplyIntent(f.scope, rootId))!;
  const parentNativeId = root.nativeResultConfirmation!.nativeId!;
  const orphan = (await f.native.getChildren(parentNativeId))[0]!;
  expect(wait?.candidates).toEqual(withEvent ? [{ nativeId: orphan.id }] : []);
  const confirm = async (action: NativeWaitConfirmAction, nativeId = orphan.id, generation = f.scope.generation) => handleNativeWaitRequest({
    kind: 'known.nativeWait.confirm', userGesture: true, waitRef: wait!.waitRef, intentId: wait!.intentId,
    generation, action, ...(action === 'bind' ? { nativeId } : {}) },
  { scope: async () => f.scope, get store() { return f.store; }, permissionGranted: async () => true, wake: vi.fn() },
  await f.effects(createChromePullBookmarkApi()));
  return { ...f, get store() { return f.store; }, confirm, raw, wait: wait!, root, rootId, parentNativeId, orphan, observed };
}

test.each(['bind', 'keep_local_and_create', 'cancel'] as const)
  ('a lost child create receipt supports %s without overwriting its parent receipt', async action => {
    const f = await childWait();
    const { raw, rootId, root, parentNativeId, orphan, observed } = f;
    try {
      const result = await f.confirm(action);
      expect(result).toMatchObject({ ok: true });
      if (action === 'bind') expect(observed).toBe(true);
      expect((await f.store.getApplyIntent(f.scope, rootId))?.nativeResultConfirmation).toEqual(root.nativeResultConfirmation);
      const childIntent = (await f.store.getApplyIntent(f.scope, f.wait.intentId))!;
      if (action === 'bind') {
        expect(childIntent.nativeResultConfirmation).toEqual({ kind: 'candidate_event', nativeId: orphan.id });
        expect(childIntent.apiResultEvidence ?? null).toBeNull();
      } else if (action === 'keep_local_and_create') {
        expect(childIntent.nativeResultConfirmation?.kind).toBe('api_return');
        expect(childIntent.nativeResultConfirmation?.nativeId).not.toBe(orphan.id);
        expect(childIntent.apiResultEvidence?.nativeId).toBe(childIntent.nativeResultConfirmation?.nativeId);
      } else expect(childIntent.nativeResult).toBe('result_unknown');
      f.restart(); await (await f.applier()).resume();
      expect((await f.store.getCursor(f.scope))?.cursor).toBe('next');
      expect(await projectNativeWaits(f.store, f.scope)).toEqual([]);
      expect(raw).toHaveBeenCalledTimes(action === 'keep_local_and_create' ? 3 : 2);
      expect(f.native.getNode('2')?.parentId).toBe('8'); expect(f.native.getNode('6')?.parentId).toBe('2');
      if (action === 'cancel') {
        expect((await f.store.getMappingByColpId(f.scope, 'target'))?.nativeId).toBe(parentNativeId);
        expect((await f.store.getMappingByColpId(f.scope, 'child'))?.nativeId).toBe('unmounted:child');
        expect((await f.store.listPullIssues(f.scope))[0]?.code).toBe('native_result_unknown');
        expect(await f.store.getMappingByNativeId(f.scope, orphan.id)).toBeNull();
        expect(f.native.getNode(orphan.id)?.parentId).toBe(parentNativeId);
      } else {
        expect((await f.store.getMappingByColpId(f.scope, 'target'))?.nativeId).toBe(parentNativeId);
        const mapped = (await f.store.getMappingByColpId(f.scope, 'child'))?.nativeId;
        if (action === 'bind') expect(mapped).toBe(orphan.id);
        else expect(mapped).not.toBe(orphan.id);
      }
      expect(await f.store.getLocalSyncExclusion(f.scope, '6')).toMatchObject({ sourceKind: 'range_exit', priorColpId: 'child' });
      f.restart(); await (await f.applier()).resume();
      expect(raw).toHaveBeenCalledTimes(action === 'keep_local_and_create' ? 3 : 2);
    } finally { f.close(); }
  });

test.each(['keep_local_and_create', 'cancel'] as const)('a child without event evidence still supports %s', async action => {
  const f = await childWait(false);
  try {
    expect(await f.confirm('bind')).toMatchObject({ ok: false, code: 'request_invalid' });
    expect((await f.store.getApplyIntent(f.scope, f.wait.intentId))?.nativeResult).toBe('result_unknown');
    expect((await f.confirm(action)).ok).toBe(true);
    f.restart(); await (await f.applier()).resume();
    expect((await f.store.getCursor(f.scope))?.cursor).toBe('next');
    expect(await projectNativeWaits(f.store, f.scope)).toEqual([]);
    expect(f.native.getNode(f.orphan.id)).toBeDefined();
  } finally { f.close(); }
});

test('cancelling a child folder preserves its orphan and old subtree, never fills descendants or deletes them on a later Pull', async () => {
  const f = await childWait(true, true);
  try {
    expect((await f.confirm('cancel')).ok).toBe(true);
    f.restart(); await (await f.applier()).resume();
    expect(f.raw).toHaveBeenCalledTimes(2);
    expect(await f.native.getChildren(f.orphan.id)).toHaveLength(0);
    for (const [colpId, nativeId] of [['child', '6'], ['grandchild', '7']] as const) {
      expect((await f.store.getMappingByColpId(f.scope, colpId))?.nativeId).toBe(`unmounted:${colpId}`);
      expect(await f.store.getLocalSyncExclusion(f.scope, nativeId)).toMatchObject({ sourceKind: 'range_exit', priorColpId: colpId });
      expect((await f.store.getRemoteObservation(f.scope, colpId))?.kind).toBe('placement');
    }
    expect(f.native.getNode('7')).toMatchObject({ parentId: '6', title: 'Grandchild', url: 'https://grand.test/' });
    const next = await f.applier();
    await next.stage(pullFixtures.page({ events: [pullFixtures.mutationEvent({ kind: 'delete', sequence: 2,
      collectionId: f.scope.collectionId, targetId: 'child', parentId: 'target', targetKind: 'folder' })],
    nextCursor: 'after-delete', collectionRevision: 'after-delete' }));
    await next.resume(); f.restart(); await (await f.applier()).resume();
    expect(f.native.getNode('6')?.parentId).toBe('2'); expect(f.native.getNode('7')?.parentId).toBe('6');
    expect(f.native.getNode(f.orphan.id)?.parentId).toBe(f.parentNativeId);
    expect(f.raw).toHaveBeenCalledTimes(2);
  } finally { f.close(); }
});

test.each(['source-edit', 'parent-private', 'wrong-candidate', 'parent-contender', 'wrong-generation'])(
  'a child wait refuses %s and preserves both durable receipts', async change => {
    const f = await childWait();
    try {
      let nativeId = f.orphan.id;
      if (change === 'source-edit') await f.native.update('6', { title: 'New local child title' });
      if (change === 'parent-private') await f.native.move(f.parentNativeId, { parentId: '3', index: 0 });
      if (change === 'parent-contender') await f.store.putMapping(f.scope, {
        ...f.target, nativeId: f.parentNativeId, colpId: 'new-owner' });
      if (change === 'wrong-candidate') nativeId = (await f.native.create({ parentId: f.parentNativeId,
        title: f.orphan.title, url: f.orphan.url })).id;
      expect((await f.confirm('bind', nativeId, f.scope.generation + (change === 'wrong-generation' ? 1 : 0))).ok).toBe(false);
      expect((await f.store.getApplyIntent(f.scope, f.rootId))?.nativeResultConfirmation).toEqual(f.root.nativeResultConfirmation);
      expect((await f.store.getApplyIntent(f.scope, f.wait.intentId))?.nativeResult).toBe('result_unknown');
      expect((await f.store.getMappingByColpId(f.scope, 'child'))?.nativeId).toBe('6');
    } finally { f.close(); }
  });
