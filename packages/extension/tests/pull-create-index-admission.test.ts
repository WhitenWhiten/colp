import { afterEach, expect, test, vi } from 'vitest';
import { subscriptionStore } from '../src/bookmark-subscriptions/store.js';
import { NativeWriteNotStartedError } from '../src/native-call-result.js';
import { adapterRuntime } from './pull-adapter-audit-fixture.js';
import { pullFixtures } from './pull-effect-fixtures.js';
import { pullNativeWrapperFixture } from './pull-native-wrapper-fixture.js';

afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); await subscriptionStore.close(); });

test.each(['after', 'before'] as const)('a %s anchor reordered after its index read refuses the stale create and safely retries after reopen', async side => {
  const f = await pullNativeWrapperFixture();
  try {
    await f.store.putMapping(f.scope, { ...f.target, nativeId: '6', colpId: 'anchor',
      parentNativeId: '4', parentColpId: 'destination' });
    f.native.seed({ id: '6', parentId: '4', index: 0, title: 'Anchor', url: 'https://anchor.test/' });
    f.native.seed({ id: '7', parentId: '4', index: 1, title: 'Sibling', url: 'https://sibling.test/' });
    const event = pullFixtures.createEvent({ kind: 'Bookmark', sequence: 92, collectionId: f.scope.collectionId,
      parentId: 'destination', ...(side === 'after' ? { afterId: 'anchor' } : { beforeId: 'anchor' }) });
    if (event.kind !== 'operation' || event.effect.kind !== 'node_created') throw new Error('fixture_create_event');
    const first = await adapterRuntime(f, 'after_intent');
    await first.applier.stage(pullFixtures.page({ events: [event], nextCursor: 'created-cursor', collectionRevision: 'created-r1' }));
    await expect(first.applier.resume()).rejects.toThrow('worker_crash');
    const get = f.native.get.bind(f.native); let reordered = false;
    vi.spyOn(f.native, 'get').mockImplementation(async id => {
      const observed = (await get(id)).map(node => ({ ...node }));
      if (id === '6' && !reordered) {
        reordered = true;
        await f.native.move('6', { parentId: '4', index: 1 });
      }
      return observed;
    });
    await expect((await adapterRuntime(f)).applier.resume()).rejects.toBeInstanceOf(NativeWriteNotStartedError);
    expect(reordered).toBe(true);
    expect(f.native.calls.filter(call => call.kind === 'create')).toEqual([]);
    expect(await f.store.getMappingByColpId(f.scope, event.effect.node.id)).toBeNull();
    expect((await f.store.listApplyIntents(f.scope))[0]).toMatchObject({ state: 'intent_prepared',
      apiPhase: 'intent_prepared', nativeResult: 'not_started', replayState: 'not_started',
      apiResultEvidence: null, nativeEventEvidence: null });
    expect((await f.store.getCursor(f.scope))?.cursor).not.toBe('created-cursor');
    expect(await f.store.listQueue(f.scope)).toEqual([]);

    f.restart(); await (await adapterRuntime(f)).applier.resume();
    const mapping = (await f.store.getMappingByColpId(f.scope, event.effect.node.id))!;
    expect(f.native.getNode(mapping.nativeId)).toMatchObject({ parentId: '4', title: 'Remote',
      index: side === 'after' ? 2 : 1 });
    expect((await f.native.getChildren('4')).map(node => node.title)).toEqual(side === 'after'
      ? ['Sibling', 'Anchor', 'Remote'] : ['Sibling', 'Remote', 'Anchor']);
    expect(f.native.calls.filter(call => call.kind === 'create')).toHaveLength(1);
    expect((await f.store.listApplyIntents(f.scope))[0]?.nativeResultConfirmation)
      .toEqual({ kind: 'api_return', nativeId: mapping.nativeId });
    expect((await f.store.getCursor(f.scope))?.cursor).toBe('created-cursor');
    expect(await f.store.listQueue(f.scope)).toEqual([]);
    f.restart(); await (await adapterRuntime(f)).applier.resume();
    expect(f.native.calls.filter(call => call.kind === 'create')).toHaveLength(1);
  } finally { f.close(); }
});
