import { afterEach, expect, test, vi } from 'vitest';
import { subscriptionStore } from '../src/bookmark-subscriptions/store.js';
import { confirmNativeWait, projectNativeWaits } from '../src/native-wait.js';
import { createChromePullBookmarkApi } from '../src/pull-bookmark-api.js';
import { pullNativeWrapperFixture } from './pull-native-wrapper-fixture.js';
import { stageMaterialization } from './pull-materialize-wait-fixture.js';

afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); await subscriptionStore.close(); });

test('an unobserved same-shaped native is not proof for the unknown range create', async () => {
  const f = await pullNativeWrapperFixture();
  try {
    const applier = await stageMaterialization(f, 'materialize', true), create = f.native.create.bind(f.native);
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
      generation: f.scope.generation, action: 'bind', nativeId: parent.id })).toMatchObject({ ok: false, code: 'request_invalid' });
    f.restart();
    expect((await f.store.getMappingByColpId(f.scope, 'target'))?.nativeId).toBe('2');
    expect((await f.store.getApplyIntent(f.scope, wait!.intentId))?.nativeResult).toBe('result_unknown');
    expect(await projectNativeWaits(f.store, f.scope)).toHaveLength(1);
    expect(raw).toHaveBeenCalledTimes(1);
    expect((await f.store.getCursor(f.scope))?.cursor).not.toBe('next');
    expect(f.native.getNode('2')?.parentId).toBe('8'); expect(f.native.getNode('6')?.parentId).toBe('2');
  } finally { f.close(); }
});
