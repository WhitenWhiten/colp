import { afterEach, expect, test, vi } from 'vitest';
import { subscriptionStore } from '../src/bookmark-subscriptions/store.js';
import { createExpectation, executePullNativeCreate, recoverCreatedNative } from '../src/pull-create-evidence.js';
import { pullNativeWrapperFixture } from './pull-native-wrapper-fixture.js';
import { adapterRuntime } from './pull-adapter-audit-fixture.js';
import { pullFixtures } from './pull-effect-fixtures.js';

afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); await subscriptionStore.close(); });

test('a non-create effect cannot open native create evidence or invoke a browser write', async () => {
  const f = await pullNativeWrapperFixture();
  try {
    const runtime = await adapterRuntime(f);
    const event = pullFixtures.mutationEvent({ kind: 'delete', sequence: 85, collectionId: f.scope.collectionId,
      targetId: 'target', parentId: 'root' });
    if (event.kind !== 'operation') throw new Error('fixture_operation');
    const before = await f.store.getMappingByColpId(f.scope, 'target');
    expect(() => createExpectation(event.effect, '1', 0, [])).toThrow('pull_effect_kind_invalid');
    await expect(recoverCreatedNative(runtime.options, runtime.api, event, '1', null))
      .resolves.toEqual({ result: 'failed', code: 'pull_effect_kind_invalid' });
    await expect(executePullNativeCreate(runtime.options, runtime.api, event, '1', 'unexpected-delete',
      () => runtime.api.create({ parentId: '1', title: 'Must not be created' }))).rejects.toThrow('pull_effect_kind_invalid');
    expect(f.native.calls.filter(call => call.kind === 'create' || call.kind === 'delete')).toEqual([]);
    expect(await f.store.getMappingByColpId(f.scope, 'target')).toEqual(before);
    expect(await f.store.listApplyIntents(f.scope)).toEqual([]); expect(await f.store.listQueue(f.scope)).toEqual([]);
  } finally { f.close(); }
});
