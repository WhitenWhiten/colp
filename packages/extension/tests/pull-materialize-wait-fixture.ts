import { expect, vi } from 'vitest';
import { projectNativeWaits } from '../src/native-wait.js';
import { handleNativeWaitRequest } from '../src/sw/native-wait.js';
import type { NativeWaitConfirmAction } from '../src/types.js';
import { pullNativeWrapperFixture } from './pull-native-wrapper-fixture.js';
import { pullFixtures } from './pull-effect-fixtures.js';
import { createPullApplier } from '../src/pull-applier.js';
import { createChromePullBookmarkApi } from '../src/pull-bookmark-api.js';
import { rejoinSession } from './rejoin-http-fixture.js';

export async function materializationApplier(f: Awaited<ReturnType<typeof pullNativeWrapperFixture>>,
  crash?: (boundary: string) => void) {
  const effects = await f.effects(createChromePullBookmarkApi()), session = await rejoinSession(f.scope);
  return createPullApplier({ store: f.store, scope: f.scope, api: effects.api, assertCurrent: effects.assertCurrent,
    session: { acceptedProtocolVersion: '0.2', sessionId: session.sessionId, collectionId: f.scope.collectionId,
      conversionPolicy: { separator: 'preserve_remote' } },
    effectPageTemplate: `${f.scope.serverOrigin}/effects/{effectId}/pages/{pageNumber}`,
    effectPageAuthority: f.scope.serverOrigin, crash });
}

export async function stageMaterialization(f: Awaited<ReturnType<typeof pullNativeWrapperFixture>>,
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

export async function materializationWait(observed = true) {
  const f = await pullNativeWrapperFixture();
  const applier = await stageMaterialization(f, 'materialize', true), create = f.native.create.bind(f.native);
  const raw = vi.spyOn(f.native, 'create').mockImplementationOnce(async details => {
    const created = await create(details);
    if (observed) expect(await applier.observe({ kind: 'create', nativeId: created.id,
      details: { parentId: details.parentId!, node: { kind: 'folder', title: details.title! } } })).toBe(true);
    throw new Error('worker_crash');
  });
  await expect(applier.resume()).rejects.toThrow('worker_crash'); f.restart();
  await expect((await f.applier()).resume()).rejects.toThrow('native_result_unknown');
  const [wait] = await projectNativeWaits(f.store, f.scope), orphan = (await f.native.getChildren('4'))[0]!;
  expect(wait).toBeDefined();
  const deps = { scope: async () => f.scope, get store() { return f.store; }, permissionGranted: async () => true, wake: vi.fn() };
  const confirm = async (action: NativeWaitConfirmAction, nativeId = orphan.id, afterCurrent?: () => Promise<void>) => {
    const effects = await f.effects(createChromePullBookmarkApi());
    return handleNativeWaitRequest({ kind: 'known.nativeWait.confirm', userGesture: true, waitRef: wait!.waitRef,
      intentId: wait!.intentId, generation: f.scope.generation, action, nativeId }, deps,
    { ...effects, assertCurrent: async () => { await effects.assertCurrent(); await afterCurrent?.(); } });
  };
  return { ...f, get store() { return f.store; }, raw, wait: wait!, orphan, deps, confirm };
}
