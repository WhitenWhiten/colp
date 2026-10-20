import { afterEach, expect, test, vi } from 'vitest';
import { subscriptionStore } from '../src/bookmark-subscriptions/store.js';
import { confirmNativeWait, projectNativeWaits } from '../src/native-wait.js';
import { createChromePullBookmarkApi } from '../src/pull-bookmark-api.js';
import { pullNativeWrapperFixture } from './pull-native-wrapper-fixture.js';
import { pullFixtures } from './pull-effect-fixtures.js';

afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); await subscriptionStore.close(); });

test('explicit native-wait confirmation proves a materialized parent without recreating it', async () => {
  const f = await pullNativeWrapperFixture();
  try {
    const applier = await stage(f, 'materialize', true), create = f.native.create.bind(f.native);
    const raw = vi.spyOn(f.native, 'create').mockImplementationOnce(async details => {
      await create(details); throw new Error('worker_crash');
    });
    await expect(applier.resume()).rejects.toThrow('worker_crash'); f.restart();
    await expect((await f.applier()).resume()).rejects.toThrow('native_result_unknown');
    const [wait] = await projectNativeWaits(f.store, f.scope);
    expect(wait).toBeDefined();
    const parent = (await f.native.getChildren('4'))[0]!;
    const effects = await f.effects(createChromePullBookmarkApi());
    expect(await confirmNativeWait({ scope: f.scope, store: f.store, api: effects.api,
      assertCurrent: effects.assertCurrent, waitRef: wait!.waitRef, intentId: wait!.intentId,
      generation: f.scope.generation, action: 'bind', nativeId: parent.id })).toMatchObject({ ok: true });
    f.restart(); await (await f.applier()).resume();
    expect(raw).toHaveBeenCalledTimes(2);
    expect(await f.native.getChildren('4')).toHaveLength(1);
    expect((await f.native.getChildren(parent.id))[0]?.title).toBe('Child');
    expect((await f.store.getCursor(f.scope))?.cursor).toBe('next');
    expect(f.native.getNode('2')?.parentId).toBe('8'); expect(f.native.getNode('6')?.parentId).toBe('2');
  } finally { f.close(); }
});

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
