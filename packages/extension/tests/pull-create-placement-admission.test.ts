import { afterEach, expect, test, vi } from 'vitest';
import { subscriptionStore } from '../src/bookmark-subscriptions/store.js';
import { createChromePullBookmarkApi } from '../src/pull-bookmark-api.js';
import { createCheckedPullNative } from '../src/pull-native-create-boundary.js';
import { NativeWriteNotStartedError } from '../src/native-call-result.js';
import { duringNativeAdmission, pullNativeWrapperFixture } from './pull-native-wrapper-fixture.js';
import { pullFixtures } from './pull-effect-fixtures.js';

afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); await subscriptionStore.close(); });

test.each(['after', 'before', 'anchor-mapping', 'anchor-native', 'new-child'] as const)
('create preserves its original placement after final admission (%s)', async change => {
  const f = await pullNativeWrapperFixture();
  try {
    const anchor = { ...f.target, nativeId: '6', colpId: 'anchor', parentNativeId: '4', parentColpId: 'destination' };
    await f.store.putMapping(f.scope, anchor);
    f.native.seed({ id: '6', parentId: '4', index: 0, title: 'Anchor', url: 'https://anchor.test/' });
    f.native.seed({ id: '7', parentId: '4', index: 1, title: 'Other', url: 'https://other.test/' });
    const applier = await f.applier(), raw = vi.spyOn(f.native, 'create');
    await applier.stage(pullFixtures.page({ events: [pullFixtures.createEvent({ kind: 'Bookmark', sequence: 1,
      collectionId: f.scope.collectionId, parentId: 'destination',
      ...(change === 'before' ? { beforeId: 'anchor' } : { afterId: 'anchor' }) })],
    nextCursor: 'next', collectionRevision: 'next-r1' }));
    const injected = duringNativeAdmission(async () => {
      if (change === 'anchor-mapping') {
        await f.store.deleteMapping(f.scope, '6'); await f.store.putMapping(f.scope, { ...anchor, nativeId: '7' });
      }
      if (change === 'anchor-native') await f.native.move('6', { parentId: '3', index: 0 });
      if (change === 'new-child') await f.native.create({ parentId: '4', index: 0, title: 'Local child', url: 'https://local.test/' });
    });
    if (change === 'after' || change === 'before') {
      await applier.resume();
      expect(raw).toHaveBeenCalledOnce();
      expect((await f.native.getChildren('4')).find(row => row.title === 'Remote')?.index).toBe(change === 'after' ? 1 : 0);
      expect((await f.store.getCursor(f.scope))?.cursor).toBe('next');
    } else {
      await expect(applier.resume()).rejects.toBeInstanceOf(NativeWriteNotStartedError);
      expect(raw.mock.calls.filter(([input]) => input.title === 'Remote')).toEqual([]);
      expect((await f.store.getCursor(f.scope))?.cursor).not.toBe('next');
      expect((await f.store.listApplyIntents(f.scope))[0]).toMatchObject({ state: 'intent_prepared',
        apiPhase: 'intent_prepared', replayState: 'not_started', nativeResult: 'not_started' });
    }
    expect(injected()).toBe(true);
  } finally { f.close(); }
});

test('an exact active mount may supply its first concrete native root to a virtual canonical root', async () => {
  const f = await pullNativeWrapperFixture();
  try {
    await f.store.deleteMapping(f.scope, '1');
    await f.store.putMapping(f.scope, { ...f.root, nativeId: 'recovery:root', rootNativeId: 'recovery:root' });
    const applier = await f.applier();
    await applier.stage(pullFixtures.page({ events: [pullFixtures.createEvent({ kind: 'Bookmark', sequence: 1,
      collectionId: f.scope.collectionId, parentId: 'root' })], nextCursor: 'next', collectionRevision: 'next-r1' }));
    await applier.resume();
    expect(f.native.calls.filter(row => row.kind === 'create')).toHaveLength(1);
    expect((await f.native.getChildren('1'))[0]?.title).toBe('Remote');
    expect((await f.store.getCursor(f.scope))?.cursor).toBe('next');
  } finally { f.close(); }
});

test('a virtual descendant cannot borrow the native identity of its active mount root', async () => {
  const f = await pullNativeWrapperFixture();
  try {
    const { scopeKey: _key, ...parent } = (await f.store.getMappingByColpId(f.scope, 'destination'))!;
    await f.store.deleteMapping(f.scope, '4');
    await f.store.putMapping(f.scope, { ...parent, nativeId: 'recovery:destination' });
    const effects = await f.effects(createChromePullBookmarkApi()), raw = vi.spyOn(f.native, 'create');
    await expect(createCheckedPullNative({ store: f.store, scope: f.scope, api: effects.api,
      parentColpId: 'destination', details: { parentId: '1', title: 'Remote', url: 'https://remote.test/' } }))
      .rejects.toBeInstanceOf(NativeWriteNotStartedError);
    expect(raw).not.toHaveBeenCalled();
    expect(f.native.getNode('1')?.title).toBe('Selected');
  } finally { f.close(); }
});
