import { afterEach, expect, test, vi } from 'vitest';
import { canonicalAuthoritativeEffectDigest } from '@know-n/colp/sync';
import { subscriptionStore } from '../src/bookmark-subscriptions/store.js';
import { confirmNativeWait, projectNativeWaits } from '../src/native-wait.js';
import { detachScopeMount } from '../src/scope-commands.js';
import { pullNativeWrapperFixture } from './pull-native-wrapper-fixture.js';
import { adapterRuntime, dispatchPreparedRestore, prepareRestore } from './pull-adapter-audit-fixture.js';
import { pullFixtures } from './pull-effect-fixtures.js';

afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); await subscriptionStore.close(); });
const restored = (collectionId: string) => pullFixtures.restoreEvent({ sequence: 81, collectionId,
  targetId: 'restored-bookmark', parentId: 'destination', title: 'Restored content' });

test('restore adapter replay reuses the actual API receipt before outer page commit, including IDB reopen', async () => {
  const f = await pullNativeWrapperFixture();
  try {
    await prepareRestore(f, restored(f.scope.collectionId));
    const applied = await dispatchPreparedRestore(f);
    const nativeId = applied.mappings[0]!.nativeId;
    expect(f.native.getNode(nativeId)).toMatchObject({ parentId: '4', title: 'Restored content' });
    expect(await f.store.getMappingByColpId(f.scope, 'restored-bookmark')).toBeNull();
    expect((await f.store.listApplyIntents(f.scope))[0]).toMatchObject({ nativeResult: 'applied_with_evidence',
      nativeResultConfirmation: { kind: 'api_return', nativeId } });
    f.restart();
    expect((await dispatchPreparedRestore(f)).mappings[0]?.nativeId).toBe(nativeId);
    expect(f.native.calls.filter(call => call.kind === 'create')).toHaveLength(1);
    await (await adapterRuntime(f)).applier.resume();
    expect((await f.store.getMappingByColpId(f.scope, 'restored-bookmark'))?.nativeId).toBe(nativeId);
    expect((await f.store.getCursor(f.scope))?.cursor).toBe('restored-cursor');
    expect(await f.store.listQueue(f.scope)).toEqual([]);
  } finally { f.close(); }
});

test.each(['permission', 'response-loss'] as const)('restore retains its actual %s call fact on adapter replay', async fault => {
  const f = await pullNativeWrapperFixture();
  try {
    await prepareRestore(f, restored(f.scope.collectionId));
    const create = f.native.create.bind(f.native);
    const calls = vi.spyOn(f.native, 'create').mockImplementation(async input => {
      if (fault === 'permission') throw new Error('Permission denied');
      await create(input); throw new Error('native response lost');
    });
    await expect(dispatchPreparedRestore(f)).rejects.toThrow(fault === 'permission' ? 'permission_revoked' : 'native response lost');
    const intent = (await f.store.listApplyIntents(f.scope)).find(row => row.eventId)!;
    expect(intent.nativeResult).toBe(fault === 'permission' ? 'failed' : 'result_unknown');
    expect(intent.apiResultEvidence).toBeNull();
    expect(await f.store.getMappingByColpId(f.scope, 'restored-bookmark')).toBeNull();
    expect((await f.store.getCursor(f.scope))?.cursor).not.toBe('restored-cursor');
    f.restart();
    await expect(dispatchPreparedRestore(f)).rejects.toThrow(fault === 'permission' ? 'permission_revoked' : 'native_result_unknown');
    expect(calls).toHaveBeenCalledOnce();
    if (fault === 'permission') expect((await f.store.getScope(f.scope))?.rootStatus).toBe('permission_required');
    else {
      expect(f.native.all().filter(node => node.title === 'Restored content')).toHaveLength(1);
      await expect((await adapterRuntime(f)).applier.resume()).rejects.toThrow('native_result_unknown');
      expect(await projectNativeWaits(f.store, f.scope)).toHaveLength(1);
    }
    expect(await f.store.listQueue(f.scope)).toEqual([]);
  } finally { f.close(); }
});

test('restoring below the concrete identity of an active virtual root preserves that mount and parent revision', async () => {
  const f = await pullNativeWrapperFixture();
  try {
    await f.store.deleteMapping(f.scope, '1');
    await f.store.putMapping(f.scope, { ...f.root, nativeId: 'recovery:root', rootNativeId: 'recovery:root' });
    const runtime = await adapterRuntime(f);
    await runtime.applier.stage(pullFixtures.page({ events: [pullFixtures.restoreEvent({ sequence: 83,
      collectionId: f.scope.collectionId, targetId: 'virtual-restore', parentId: 'root', title: 'Virtual restore' })],
    nextCursor: 'restored-cursor', collectionRevision: 'restored-r1' }));
    await runtime.applier.resume();
    const mapping = await f.store.getMappingByColpId(f.scope, 'virtual-restore');
    expect(mapping?.parentNativeId).toBe('1');
    expect(f.native.getNode(mapping!.nativeId)).toMatchObject({ parentId: '1', title: 'Virtual restore' });
    expect((await f.store.getMountBinding(f.scope, 'mount'))?.nativeRootId).toBe('1');
    expect((await f.store.getMappingByColpId(f.scope, 'root'))?.projection.childrenRevision).toBe('children-83');
    f.restart(); await (await adapterRuntime(f)).applier.resume();
    expect(f.native.calls.filter(call => call.kind === 'create')).toHaveLength(1);
    expect(await f.store.listQueue(f.scope)).toEqual([]);
  } finally { f.close(); }
});

test('a restored separator replaces only its virtual mapping and never calls Chrome create', async () => {
  const f = await pullNativeWrapperFixture();
  try {
    const event = pullFixtures.restoreEvent({ sequence: 84, collectionId: f.scope.collectionId,
      targetId: 'restored-separator', parentId: 'destination' });
    if (event.kind !== 'operation' || event.effect.kind !== 'node_restored') throw new Error('fixture_effect');
    const prior = event.effect.node;
    const effect = { ...event.effect, node: { id: prior.id, kind: 'separator' as const,
      collectionId: prior.collectionId, parentId: prior.parentId, position: prior.position,
      visibility: prior.visibility, revision: prior.revision, createdAt: prior.createdAt, updatedAt: prior.updatedAt } };
    await f.store.putMapping(f.scope, { nativeId: 'unmounted:restored-separator', colpId: prior.id,
      rootNativeId: '1', nodeKind: 'separator', parentColpId: 'destination',
      projection: { revision: 'old-separator', digest: 'separator', content: {} } });
    const runtime = await adapterRuntime(f);
    await runtime.applier.stage(pullFixtures.page({ events: [{ ...event,
      effect: { ...effect, effectDigest: canonicalAuthoritativeEffectDigest(effect) } }],
    nextCursor: 'restored-cursor', collectionRevision: 'restored-r1' }));
    await runtime.applier.resume();
    expect(await f.store.getMappingByColpId(f.scope, prior.id)).toMatchObject({ nativeId: 'sidecar:restored-separator',
      nodeKind: 'separator', parentNativeId: '4', parentColpId: 'destination' });
    expect(await f.store.getMappingByNativeId(f.scope, 'unmounted:restored-separator')).toBeNull();
    expect(f.native.calls.filter(call => call.kind === 'create' || call.kind === 'delete')).toEqual([]);
    expect((await f.store.getCursor(f.scope))?.cursor).toBe('restored-cursor');
    expect(await f.store.listQueue(f.scope)).toEqual([]);
  } finally { f.close(); }
});

test('an explicit binding of the actual unknown restore survives restart without becoming an API receipt', async () => {
  const f = await pullNativeWrapperFixture();
  try {
    const first = await adapterRuntime(f, 'after_create_before_evidence');
    await first.applier.stage(pullFixtures.page({ events: [restored(f.scope.collectionId)],
      nextCursor: 'restored-cursor', collectionRevision: 'restored-r1' }));
    await expect(first.applier.resume()).rejects.toThrow('worker_crash');
    const nativeId = f.native.calls.find(call => call.kind === 'create')!.nativeId!;
    f.restart();
    await expect((await adapterRuntime(f)).applier.resume()).rejects.toThrow('native_result_unknown');
    const [wait] = await projectNativeWaits(f.store, f.scope); expect(wait).toBeDefined();
    const runtime = await adapterRuntime(f);
    expect(await confirmNativeWait({ scope: f.scope, store: f.store, api: runtime.api,
      waitRef: wait!.waitRef, intentId: wait!.intentId, generation: f.scope.generation,
      action: 'bind', nativeId })).toEqual({ ok: true, result: 'bound', nativeId });
    const confirmed = await f.store.getApplyIntent(f.scope, wait!.intentId);
    expect(confirmed?.apiResultEvidence).toBeNull();
    expect(confirmed?.nativeResultConfirmation).toEqual({ kind: 'candidate_event', nativeId });
    f.restart();
    expect((await dispatchPreparedRestore(f)).mappings[0]?.nativeId).toBe(nativeId);
    await (await adapterRuntime(f)).applier.resume();
    expect(await f.store.getMappingByColpId(f.scope, 'restored-bookmark')).toMatchObject({ nativeId, parentNativeId: '4' });
    expect(f.native.getNode(nativeId)).toMatchObject({ parentId: '4', title: 'Restored content' });
    expect(f.native.calls.filter(call => call.kind === 'create')).toHaveLength(1);
    expect(await projectNativeWaits(f.store, f.scope)).toEqual([]);
    expect(await f.store.listQueue(f.scope)).toEqual([]);
    expect((await f.store.getCursor(f.scope))?.cursor).toBe('restored-cursor');
  } finally { f.close(); }
});

test.each(['receipt', 'permission'] as const)('restore rechecks the actual %s recorded while its anchor read was pending', async outcome => {
  const f = await pullNativeWrapperFixture();
  let releaseRead: () => void = () => undefined;
  let enteredRead: () => void = () => undefined;
  const gate = new Promise<void>(resolve => { releaseRead = resolve; });
  const entered = new Promise<void>(resolve => { enteredRead = resolve; });
  try {
    await prepareRestore(f, pullFixtures.restoreEvent({ sequence: 86, collectionId: f.scope.collectionId,
      targetId: 'overlapping-restore', parentId: 'root', afterId: 'target', title: 'Overlapping restore' }));
    const get = f.native.get.bind(f.native); let paused = false;
    vi.spyOn(f.native, 'get').mockImplementation(async id => {
      const observed = await get(id);
      if (id === '2' && !paused) { paused = true; enteredRead(); await gate; }
      return observed;
    });
    const create = vi.spyOn(f.native, 'create');
    if (outcome === 'permission') create.mockRejectedValueOnce(new Error('Permission denied'));
    const pending = dispatchPreparedRestore(f).then(value => ({ ok: true as const, value }),
      error => ({ ok: false as const, error }));
    try {
      await entered;
      if (outcome === 'receipt') {
        const concurrent = await dispatchPreparedRestore(f);
        const nativeId = concurrent.mappings[0]!.nativeId;
        releaseRead(); const first = await pending;
        expect(first.ok).toBe(true);
        if (!first.ok) throw first.error;
        expect(first.value.mappings[0]?.nativeId).toBe(nativeId);
        expect(f.native.getNode(nativeId)).toMatchObject({ parentId: '1', title: 'Overlapping restore' });
        await (await adapterRuntime(f)).applier.resume();
        expect((await f.store.getMappingByColpId(f.scope, 'overlapping-restore'))?.nativeId).toBe(nativeId);
        expect((await f.store.getCursor(f.scope))?.cursor).toBe('restored-cursor');
      } else {
        await expect(dispatchPreparedRestore(f)).rejects.toThrow('permission_revoked');
        releaseRead(); const first = await pending;
        expect(first.ok).toBe(false);
        if (first.ok) throw new Error('fixture_expected_refusal');
        expect(first.error).toMatchObject({ message: 'permission_revoked' });
        expect(await f.store.getMappingByColpId(f.scope, 'overlapping-restore')).toBeNull();
        expect((await f.store.getCursor(f.scope))?.cursor).not.toBe('restored-cursor');
        expect(f.native.all().some(node => node.title === 'Overlapping restore')).toBe(false);
      }
      expect(create).toHaveBeenCalledOnce();
      expect(await f.store.listQueue(f.scope)).toEqual([]);
    } finally { releaseRead(); await pending; }
  } finally { releaseRead(); f.close(); }
});

test('a detached root whose mapping was lost still records the remote restore without touching native bookmarks', async () => {
  const f = await pullNativeWrapperFixture();
  try {
    await detachScopeMount(f.store, f.scope, 'mount');
    await f.store.deleteMapping(f.scope, '1');
    f.restart();
    const before = f.native.all();
    const runtime = await adapterRuntime(f);
    await runtime.applier.stage(pullFixtures.page({ events: [pullFixtures.restoreEvent({ sequence: 87,
      collectionId: f.scope.collectionId, targetId: 'detached-restore', parentId: 'root', title: 'Detached restore' })],
    nextCursor: 'restored-cursor', collectionRevision: 'restored-r1' }));
    await runtime.applier.resume();
    expect(await f.store.getMappingByColpId(f.scope, 'detached-restore')).toMatchObject({
      nativeId: 'unmounted:detached-restore', parentNativeId: 'unmounted:root', parentColpId: 'root' });
    expect(f.native.all()).toEqual(before);
    expect(f.native.calls.filter(call => ['create', 'move', 'update', 'delete'].includes(call.kind))).toEqual([]);
    expect(await f.store.getRemoteObservation(f.scope, 'detached-restore')).toMatchObject({ kind: 'content' });
    expect((await f.store.getCursor(f.scope))?.cursor).toBe('restored-cursor');
    expect(await f.store.listQueue(f.scope)).toEqual([]);
  } finally { f.close(); }
});
