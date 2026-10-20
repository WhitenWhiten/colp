import { afterEach, expect, test, vi } from 'vitest';
import { subscriptionStore } from '../src/bookmark-subscriptions/store.js';
import { projectNativeWaits } from '../src/native-wait.js';
import { createChromePullBookmarkApi } from '../src/pull-bookmark-api.js';
import { handleNativeWaitRequest } from '../src/sw/native-wait.js';
import { pullNativeWrapperFixture } from './pull-native-wrapper-fixture.js';
import { stageMaterialization } from './pull-materialize-wait-fixture.js';

afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); await subscriptionStore.close(); });

test.each(['bind', 'keep_local_and_create', 'cancel'] as const)
  ('a lost child create receipt supports %s without overwriting its parent receipt', async action => {
    const f = await pullNativeWrapperFixture();
    try {
      const applier = await stageMaterialization(f, 'materialize', true), create = f.native.create.bind(f.native);
      let observed: boolean | undefined, count = 0;
      const raw = vi.spyOn(f.native, 'create').mockImplementation(async details => {
        const result = await create(details);
        if (++count === 2) {
          observed = await applier.observe({ kind: 'create', nativeId: result.id,
            details: { parentId: details.parentId!, node: { kind: 'bookmark', title: details.title!, url: details.url! } } });
          throw new Error('worker_crash');
        }
        return result;
      });
      await expect(applier.resume()).rejects.toThrow('worker_crash'); f.restart();
      await expect((await f.applier()).resume()).rejects.toThrow('native_result_unknown');
      const [wait] = await projectNativeWaits(f.store, f.scope);
      expect(wait?.colpId).toBe('child');
      const rootId = wait!.intentId.replace(':range:child', '');
      const root = (await f.store.getApplyIntent(f.scope, rootId))!;
      const parentNativeId = root.nativeResultConfirmation!.nativeId!;
      const orphan = (await f.native.getChildren(parentNativeId))[0]!;
      const result = await handleNativeWaitRequest({ kind: 'known.nativeWait.confirm', userGesture: true,
        waitRef: wait!.waitRef, intentId: wait!.intentId, generation: f.scope.generation, action,
        ...(action === 'bind' ? { nativeId: orphan.id } : {}) },
      { scope: async () => f.scope, store: f.store, permissionGranted: async () => true, wake: vi.fn() },
      await f.effects(createChromePullBookmarkApi()));
      expect(result).toMatchObject({ ok: true });
      if (action === 'bind') expect(observed).toBe(true);
      expect((await f.store.getApplyIntent(f.scope, rootId))?.nativeResultConfirmation).toEqual(root.nativeResultConfirmation);
      f.restart(); await (await f.applier()).resume();
      expect((await f.store.getCursor(f.scope))?.cursor).toBe('next');
      expect(await projectNativeWaits(f.store, f.scope)).toEqual([]);
      expect(raw).toHaveBeenCalledTimes(action === 'keep_local_and_create' ? 3 : 2);
      expect(f.native.getNode('2')?.parentId).toBe('8'); expect(f.native.getNode('6')?.parentId).toBe('2');
      if (action === 'cancel') {
        expect((await f.store.getMappingByColpId(f.scope, 'target'))?.nativeId).toBe('2');
        expect((await f.store.listPullIssues(f.scope))[0]?.code).toBe('native_result_unknown');
      } else {
        expect((await f.store.getMappingByColpId(f.scope, 'target'))?.nativeId).toBe(parentNativeId);
        const mapped = (await f.store.getMappingByColpId(f.scope, 'child'))?.nativeId;
        if (action === 'bind') expect(mapped).toBe(orphan.id);
        else expect(mapped).not.toBe(orphan.id);
      }
    } finally { f.close(); }
  });
