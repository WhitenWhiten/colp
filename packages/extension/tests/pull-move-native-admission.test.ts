import { afterEach, expect, test, vi } from 'vitest';
import { subscriptionStore } from '../src/bookmark-subscriptions/store.js';
import { NativeWriteNotStartedError } from '../src/native-call-result.js';
import { createChromePullBookmarkApi } from '../src/pull-bookmark-api.js';
import { recoverVerifiedOrFreeze } from '../src/recovery-guard.js';
import { detachScopeMount } from '../src/scope-detach.js';
import { duringNativeAdmission, pullNativeWrapperFixture } from './pull-native-wrapper-fixture.js';
import { canonicalAuthoritativeEffectDigest, canonicalOperationDigest } from '@know-n/colp/sync';
import { pullFixtures } from './pull-effect-fixtures.js';

afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); await subscriptionStore.close(); });

test.each(['local-move', 'destination-private', 'destination-order', 'detach'] as const)
('Pull move retains the original source and destination decision after late %s', async changed => {
  const f = await pullNativeWrapperFixture();
  try {
    const applier = await f.stage('move');
    const injected = duringNativeAdmission(async () => {
      if (changed === 'local-move') await f.native.move('2', { parentId: '1', index: 0 });
      if (changed === 'destination-private') await f.native.move('4', { parentId: '3', index: 0 });
      if (changed === 'destination-order') await f.native.create({ parentId: '4', title: 'New local child', url: 'https://local.test/' });
      if (changed === 'detach') await detachScopeMount(f.store, f.scope, 'mount');
    });
    await expect(applier.resume()).rejects.toBeInstanceOf(NativeWriteNotStartedError);
    expect(injected()).toBe(true);
    expect(f.native.calls.filter(call => call.kind === 'move' && call.nativeId === '2'))
      .toHaveLength(changed === 'local-move' ? 1 : 0);
    expect(f.native.getNode('2')?.parentId).toBe('1');
    const intent = (await f.store.listApplyIntents(f.scope))[0]!;
    expect(intent).toMatchObject({ state: 'intent_prepared', nativeResult: 'not_started', replayState: 'not_started',
      anchors: { nativePreimage: { id: '2', parentId: '1', index: 1, title: 'Target' } } });
    expect(intent.apiResultEvidence).toBeNull();
    expect((await f.store.getCursor(f.scope))?.cursor).not.toBe('next');
    expect(await f.store.listAckIntents(f.scope)).toEqual([]);
    if (changed === 'local-move') {
      f.restart(); await expect((await f.applier()).resume()).rejects.toBeInstanceOf(NativeWriteNotStartedError);
      expect(f.native.getNode('2')?.index).toBe(0);
      // An explicit restoration of the original source permits this same
      // durable intent to finish; restart itself must not bless the new move.
      await f.native.move('2', { parentId: '1', index: 1 });
      f.restart(); await (await f.applier()).resume();
      expect(f.native.getNode('2')?.parentId).toBe('4');
      expect((await f.store.getCursor(f.scope))?.cursor).toBe('next');
    }
  } finally { f.close(); }
});

test('Snapshot placement refuses a late private destination and keeps its durable recovery intent', async () => {
  const f = await pullNativeWrapperFixture();
  try {
    const { scopeKey: _key, ...parent } = (await f.store.getMappingByColpId(f.scope, 'destination'))!;
    const incoming = { ...f.target, parentNativeId: '4', parentColpId: 'destination' };
    const staged = [f.root, f.privateRoot, parent, incoming]; await f.stageSnapshot(staged);
    const effects = await f.effects(createChromePullBookmarkApi());
    const injected = duringNativeAdmission(() => f.native.move('4', { parentId: '3', index: 0 }));
    await expect(recoverVerifiedOrFreeze({ scope: f.scope, store: f.store, staged, api: effects.api,
      freezeUnprovenIdentity: true })).rejects.toBeInstanceOf(NativeWriteNotStartedError);
    expect(injected()).toBe(true);
    expect(f.native.calls).toEqual([{ kind: 'move', nativeId: '4' }]);
    expect(f.native.getNode('2')?.parentId).toBe('1');
    expect((await f.store.listProjectionIntents(f.scope)).find(intent => intent.kind === 'move')?.state).toBe('recovery');
    await f.native.move('4', { parentId: '1', index: 2 }); f.restart();
    const resumed = await f.effects(createChromePullBookmarkApi());
    await recoverVerifiedOrFreeze({ scope: f.scope, store: f.store, staged, api: resumed.api,
      freezeUnprovenIdentity: true, recoveryOnly: true });
    expect(f.native.calls.filter(call => call.kind === 'move' && call.nativeId === '2')).toHaveLength(1);
    expect(f.native.getNode('2')?.parentId).toBe('4');
  } finally { f.close(); }
});

test('a placement anchor cannot acquire another native identity during final move admission', async () => {
  const f = await pullNativeWrapperFixture();
  try {
    const anchor = { ...f.target, nativeId: '6', colpId: 'anchor', parentNativeId: '4', parentColpId: 'destination' };
    await f.store.putMapping(f.scope, anchor);
    f.native.seed({ id: '6', parentId: '4', index: 0, title: 'Anchor', url: 'https://anchor.test/' });
    f.native.seed({ id: '7', parentId: '3', index: 0, title: 'Private identity', url: 'https://private.test/' });
    const event = pullFixtures.mutationEvent({ kind: 'move', sequence: 1, collectionId: f.scope.collectionId,
      targetId: 'target', parentId: 'destination' });
    if (event.kind !== 'operation' || event.effect.kind !== 'node_moved' || event.operation.type !== 'move_node') {
      throw new Error('fixture_move');
    }
    const operation = { ...event.operation, payload: { ...event.operation.payload, afterId: 'anchor' } };
    const effect = { ...event.effect, placement: { ...event.effect.placement, afterId: 'anchor' },
      operationDigest: canonicalOperationDigest(operation) };
    const applier = await f.applier();
    await applier.stage(pullFixtures.page({ events: [{ ...event, operation,
      effect: { ...effect, effectDigest: canonicalAuthoritativeEffectDigest(effect) } }],
    nextCursor: 'next', collectionRevision: 'next-r1' }));
    const injected = duringNativeAdmission(async () => {
      await f.store.deleteMapping(f.scope, '6');
      await f.store.putMapping(f.scope, { ...anchor, nativeId: '7', parentNativeId: '3', parentColpId: 'private' });
    });
    await expect(applier.resume()).rejects.toBeInstanceOf(NativeWriteNotStartedError);
    expect(injected()).toBe(true); expect(f.native.calls).toEqual([]);
    expect(f.native.getNode('2')?.parentId).toBe('1');
    expect((await f.store.getCursor(f.scope))?.cursor).not.toBe('next');
  } finally { f.close(); }
});
