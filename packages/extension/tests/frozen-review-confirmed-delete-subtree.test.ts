import { afterEach, expect, test, vi } from 'vitest';
import { canonicalAuthoritativeEffectDigest } from '@know-n/colp/sync';
import { subscriptionStore } from '../src/bookmark-subscriptions/store.js';
import { createChromePullBookmarkApi } from '../src/pull-bookmark-api.js';
import { createPullApplier } from '../src/pull-applier.js';
import { NativeWriteNotStartedError } from '../src/native-call-result.js';
import { recoverVerifiedOrFreeze } from '../src/recovery-guard.js';
import { duringNativeAdmission, pullNativeWrapperFixture } from './pull-native-wrapper-fixture.js';
import { rejoinSession } from './rejoin-http-fixture.js';
import { pullFixtures } from './pull-effect-fixtures.js';

afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); await subscriptionStore.close(); });

test.each(['original-members', 'ancestor-snapshot-hold', 'late-child-keep-local'] as const)
('explicit Snapshot-held subtree deletion retains the exact %s authority', async change => {
  const f = await heldSubtree();
  try {
    const recursive = vi.spyOn(f.native, 'removeTree');
    const injected = duringNativeAdmission(async () => {
      if (change === 'original-members') return;
      await f.store.putLocalSyncExclusion(f.scope, {
        nativeId: change === 'ancestor-snapshot-hold' ? '1' : '6', rootNativeId: '1',
        priorColpId: change === 'ancestor-snapshot-hold' ? 'root' : 'child', generation: f.scope.generation,
        decisionId: change === 'ancestor-snapshot-hold' ? 'snapshot-issue:snapshot' : 'new-keep-local',
        ...(change === 'late-child-keep-local' ? { sourceKind: 'remote_delete' as const } : {}),
      });
    });
    if (change === 'original-members') {
      await (await f.applier()).resume();
      expect(f.native.calls).toEqual([{ kind: 'delete', nativeId: '6' }, { kind: 'delete', nativeId: '2' }]);
      expect(f.native.getNode('6')).toBeUndefined(); expect(f.native.getNode('2')).toBeUndefined();
      expect((await f.store.getPullEvent(f.scope, f.decision.eventId))?.state).toBe('page_complete');
    } else {
      await expect((await f.applier()).resume()).rejects.toBeInstanceOf(NativeWriteNotStartedError);
      expect(f.native.calls).toEqual([]);
      expect(f.native.getNode('2')?.title).toBe('Target'); expect(f.native.getNode('6')?.title).toBe('Child');
      expect(await f.store.getApplyIntent(f.scope, `intent:${f.decision.eventId}`)).toMatchObject({
        nativeResult: 'not_started', replayState: 'not_started',
        anchors: { deleteMemberResults: { target: 'not_started', child: 'not_started' } },
      });
      f.restart();
      expect((await f.store.getLocalSyncExclusion(f.scope, change === 'ancestor-snapshot-hold' ? '1' : '6'))?.decisionId)
        .toBe(change === 'ancestor-snapshot-hold' ? 'snapshot-issue:snapshot' : 'new-keep-local');
    }
    expect(injected()).toBe(true); expect(recursive).not.toHaveBeenCalled();
    expect((await f.store.getCursor(f.scope))?.cursor).toBe('snapshot-cursor');
  } finally { f.close(); }
});

async function heldSubtree() {
  const f = await pullNativeWrapperFixture();
  f.native.seed({ id: '2', parentId: '1', index: 1, title: 'Target' });
  f.native.seed({ id: '6', parentId: '2', index: 0, title: 'Child', url: 'https://child.test/' });
  await f.store.putMapping(f.scope, { ...f.target, nodeKind: 'folder',
    projection: { ...f.target.projection, content: { title: 'Target' } } });
  await f.store.putMapping(f.scope, { ...f.target, nativeId: '6', colpId: 'child', parentNativeId: '2', parentColpId: 'target',
    projection: { ...f.target.projection, content: { title: 'Child', url: 'https://child.test/' } } });
  await f.store.setRemoteDeletePolicy(f.scope, { policy: 'confirm', expectedCasVersion: 0, now: 1 });
  const effects = await f.effects(createChromePullBookmarkApi()), session = await rejoinSession(f.scope);
  const applier = createPullApplier({ scope: f.scope, api: effects.api, store: f.store,
    assertCurrent: async () => {
      await effects.assertCurrent();
      // Crash at the real authority boundary before page completion. Do not
      // replace a store transition or manufacture any successful evidence.
      if ((await f.store.listRemoteDeleteDecisions(f.scope, ['pending'])).length) throw new Error('worker_crash');
    },
    session: { acceptedProtocolVersion: '0.2', sessionId: session.sessionId, collectionId: f.scope.collectionId,
      conversionPolicy: { separator: 'preserve_remote' } },
    effectPageTemplate: `${f.scope.serverOrigin}/effects/{effectId}/pages/{pageNumber}`,
    effectPageAuthority: f.scope.serverOrigin });
  const event = pullFixtures.subtreeEvent({ sequence: 1, collectionId: f.scope.collectionId,
    targetId: 'target', members: ['target', 'child'], paged: false });
  const effect = { ...event.effect, parentRevision: { parentId: 'root', childrenRevision: 'children-1' } };
  await applier.stage(pullFixtures.page({ events: [{ ...event,
    effect: { ...effect, effectDigest: canonicalAuthoritativeEffectDigest(effect) } }],
  nextCursor: 'next', collectionRevision: 'next-r1' }));
  await expect(applier.resume()).rejects.toThrow('worker_crash');
  const staged = (await f.store.listMappings(f.scope)).filter(row => !['target', 'child'].includes(row.colpId))
    .map(({ scopeKey: _key, ...mapping }) => mapping);
  await f.stageSnapshot(staged);
  const projected = await recoverVerifiedOrFreeze({ scope: f.scope, store: f.store, api: effects.api,
    staged, freezeUnprovenIdentity: true });
  await f.store.finalizeRecoveryMappings(f.scope, 'snapshot', projected);
  await f.store.commitRecovery(f.scope, 'snapshot');
  for (const nativeId of ['2', '6']) expect(await f.store.getLocalSyncExclusion(f.scope, nativeId))
    .toMatchObject({ nativeId, decisionId: 'snapshot-issue:snapshot' });
  const decision = (await f.store.listRemoteDeleteDecisions(f.scope, ['pending']))[0]!;
  expect(decision.nativeIds).toEqual(['2', '6']);
  await f.store.decideRemoteDelete(f.scope, { decisionId: decision.decisionId, action: 'apply',
    expectedCasVersion: decision.casVersion, deleteRevision: decision.deleteRevision,
    generation: f.scope.generation, now: 2, permissionGranted: true });
  f.restart(); f.native.calls.length = 0;
  return { ...f, get store() { return f.store; }, decision };
}
