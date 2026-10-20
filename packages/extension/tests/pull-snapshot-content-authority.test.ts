import { afterEach, expect, test, vi } from 'vitest';
import { subscriptionStore } from '../src/bookmark-subscriptions/store.js';
import { NativeWriteNotStartedError } from '../src/native-call-result.js';
import { createChromePullBookmarkApi } from '../src/pull-bookmark-api.js';
import { applyRemoteMappingContentUpdate } from '../src/pull-native-content-barrier.js';
import { lookupBookmark } from '../src/bookmark-api-error.js';
import { duringNativeAdmission, pullNativeWrapperFixture } from './pull-native-wrapper-fixture.js';

afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); await subscriptionStore.close(); });

test.each(['unchanged', 'new-native-edit', 'new-authority'] as const)
('a confirmed old native baseline uses the exact newer Snapshot authority (%s)', async change => {
  const f = await pullNativeWrapperFixture();
  try {
    const staged = { ...f.target, projection: { ...f.target.projection, revision: 'snapshot-r2',
      content: { title: 'Newer snapshot', url: 'https://target.test/' } } };
    await f.store.putMapping(f.scope, staged);
    const authority = (await f.store.getMappingByColpId(f.scope, 'target'))!;
    const effects = await f.effects(createChromePullBookmarkApi()), mounts = await f.store.listMountBindings(f.scope);
    const injected = duringNativeAdmission(async () => {
      if (change === 'new-native-edit') await f.native.update('2', { title: 'Even newer local title' });
      if (change === 'new-authority') await f.store.putMapping(f.scope, { ...authority,
        projection: { ...authority.projection, revision: 'snapshot-r3' } });
    });
    const apply = () => applyRemoteMappingContentUpdate({ store: f.store, scope: f.scope, api: effects.api,
      mapping: f.target, authorityMapping: authority, incomingMapping: authority, effectDigest: 'snapshot-r2',
      eventId: 'confirmed-snapshot:event', mounts, now: Date.now, queuedLocal: {},
      lookup: id => lookupBookmark(key => effects.api.get(key), id),
      targetMissingError: async () => new Error('missing_target') });
    if (change === 'unchanged') {
      expect((await apply()).mapping.projection.revision).toBe('snapshot-r2');
      expect(f.native.getNode('2')?.title).toBe('Newer snapshot');
      expect(f.native.calls).toEqual([{ kind: 'update', nativeId: '2' }]);
    } else {
      await expect(apply()).rejects.toBeInstanceOf(NativeWriteNotStartedError);
      expect(f.native.calls).toEqual(change === 'new-native-edit' ? [{ kind: 'update', nativeId: '2' }] : []);
      expect(f.native.getNode('2')?.title).toBe(change === 'new-native-edit' ? 'Even newer local title' : 'Target');
    }
    expect(injected()).toBe(true);
  } finally { f.close(); }
});
