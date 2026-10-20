import { afterEach, expect, test, vi } from 'vitest';
import { subscriptionStore } from '../src/bookmark-subscriptions/store.js';
import { NativeWriteNotStartedError } from '../src/native-call-result.js';
import { createChromePullBookmarkApi } from '../src/pull-bookmark-api.js';
import { recoverVerifiedOrFreeze } from '../src/recovery-guard.js';
import { duringNativeAdmission, pullNativeWrapperFixture } from './pull-native-wrapper-fixture.js';

afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); await subscriptionStore.close(); });

test.each(['unchanged', 'local-content', 'local-exclusion'] as const)
('Snapshot deletion preserves the last native admission decision (%s)', async change => {
  const f = await pullNativeWrapperFixture();
  try {
    const { scopeKey: _key, ...destination } = (await f.store.getMappingByColpId(f.scope, 'destination'))!;
    const staged = [f.root, f.privateRoot, destination]; await f.stageSnapshot(staged);
    const effects = await f.effects(createChromePullBookmarkApi());
    const injected = duringNativeAdmission(async () => {
      if (change === 'local-content') await f.native.update('2', { title: 'Snapshot must retain this' });
      if (change === 'local-exclusion') await f.store.putLocalSyncExclusion(f.scope, {
        nativeId: '2', rootNativeId: '1', priorColpId: 'target', generation: f.scope.generation,
        decisionId: 'keep-local', sourceKind: 'remote_delete',
      });
    });
    let refused: unknown;
    await recoverVerifiedOrFreeze({ scope: f.scope, store: f.store, staged, api: effects.api,
      freezeUnprovenIdentity: true }).catch(error => { refused = error; });
    expect(injected()).toBe(true);
    if (change === 'unchanged') {
      expect(refused).toBeUndefined();
      expect(f.native.calls).toEqual([{ kind: 'delete', nativeId: '2' }]);
      expect(f.native.getNode('2')).toBeUndefined();
      expect((await f.store.listProjectionIntents(f.scope))[0]?.state).toBe('terminal');
    } else {
      expect(f.native.calls.filter(call => call.kind === 'delete')).toEqual([]);
      expect(refused).toBeInstanceOf(NativeWriteNotStartedError);
      expect(f.native.getNode('2')?.title).toBe(change === 'local-content' ? 'Snapshot must retain this' : 'Target');
      expect((await f.store.listProjectionIntents(f.scope))[0]?.state).toBe('recovery');
      expect(await f.store.getMappingByColpId(f.scope, 'target')).toMatchObject(f.target);
      f.restart(); const resumed = await f.effects(createChromePullBookmarkApi());
      await recoverVerifiedOrFreeze({ scope: f.scope, store: f.store, staged, api: resumed.api,
        freezeUnprovenIdentity: true, recoveryOnly: true }).catch(() => undefined);
      expect(f.native.calls.filter(call => call.kind === 'delete')).toEqual([]);
      expect(f.native.getNode('2')?.title).toBe(change === 'local-content' ? 'Snapshot must retain this' : 'Target');
      expect((await f.store.listProjectionIntents(f.scope))[0]?.state).not.toBe('terminal');
    }
    expect(await f.store.listQueue(f.scope)).toEqual([]);
  } finally { f.close(); }
});
