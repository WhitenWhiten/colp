import { afterEach, expect, test, vi } from 'vitest';
import { subscriptionStore } from '../src/bookmark-subscriptions/store.js';
import { createChromePullBookmarkApi } from '../src/pull-bookmark-api.js';
import { createPullApplier } from '../src/pull-applier.js';
import { NativeWriteNotStartedError } from '../src/native-call-result.js';
import { recoverVerifiedOrFreeze } from '../src/recovery-guard.js';
import { duringNativeAdmission, pullNativeWrapperFixture } from './pull-native-wrapper-fixture.js';
import { rejoinSession } from './rejoin-http-fixture.js';
import { pullFixtures } from './pull-effect-fixtures.js';

afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); await subscriptionStore.close(); });

test('an explicit delete still applies after Snapshot safely holds its original native identity', async () => {
  const f = await confirmedSnapshotDelete();
  try {
    await (await f.applier()).resume();
    expect(f.native.calls).toEqual([{ kind: 'delete', nativeId: '2' }]);
    expect(f.native.getNode('2')).toBeUndefined();
    expect(await f.store.getMappingByColpId(f.scope, 'target')).toBeNull();
    expect((await f.store.getCursor(f.scope))?.cursor).toBe('snapshot-cursor');
    expect((await f.store.getPullEvent(f.scope, f.decision.eventId))?.state).toBe('page_complete');
  } finally { f.close(); }
});

test.each(['new-exclusion', 'ancestor-exclusion', 'unrelated-snapshot'] as const)
('Snapshot delete confirmation cannot authorize a late %s', async change => {
  const f = await confirmedSnapshotDelete();
  try {
    const injected = duringNativeAdmission(async () => {
      await f.store.putLocalSyncExclusion(f.scope, {
        nativeId: change === 'ancestor-exclusion' ? '1' : '2', rootNativeId: '1',
        priorColpId: change === 'ancestor-exclusion' ? 'root' : 'target', generation: f.scope.generation,
        decisionId: change === 'unrelated-snapshot' ? 'snapshot-issue:another-snapshot' : 'new-keep-local',
        ...(change === 'unrelated-snapshot' ? {} : { sourceKind: 'remote_delete' as const }),
      });
    });
    await expect((await f.applier()).resume()).rejects.toBeInstanceOf(NativeWriteNotStartedError);
    expect(injected()).toBe(true);
    expect(f.native.calls).toEqual([]);
    expect(f.native.getNode('2')?.title).toBe('Target');
    expect((await f.store.getCursor(f.scope))?.cursor).toBe('snapshot-cursor');
    expect((await f.store.getPullEvent(f.scope, f.decision.eventId))?.state).toBe('intent_prepared');
    expect((await f.store.getApplyIntent(f.scope, `intent:${f.decision.eventId}`))).toMatchObject({
      nativeResult: 'not_started', replayState: 'not_started', anchors: { deleteMemberResults: { target: 'not_started' } },
    });
    f.restart();
    expect((await f.store.getLocalSyncExclusion(f.scope, change === 'ancestor-exclusion' ? '1' : '2'))?.decisionId)
      .toBe(change === 'unrelated-snapshot' ? 'snapshot-issue:another-snapshot' : 'new-keep-local');
  } finally { f.close(); }
});

async function confirmedSnapshotDelete() {
  const f = await pullNativeWrapperFixture();
  await f.store.setRemoteDeletePolicy(f.scope, { policy: 'confirm', expectedCasVersion: 0, now: 1 });
  const effects = await f.effects(createChromePullBookmarkApi()), session = await rejoinSession(f.scope);
  const applier = createPullApplier({ scope: f.scope, api: effects.api, assertCurrent: effects.assertCurrent,
    store: { ...f.store, completePullPage: async () => { throw new Error('worker_crash'); } },
    session: { acceptedProtocolVersion: '0.2', sessionId: session.sessionId, collectionId: f.scope.collectionId,
      conversionPolicy: { separator: 'preserve_remote' } },
    effectPageTemplate: `${f.scope.serverOrigin}/effects/{effectId}/pages/{pageNumber}`,
    effectPageAuthority: f.scope.serverOrigin });
  const event = pullFixtures.mutationEvent({ kind: 'delete', sequence: 1, collectionId: f.scope.collectionId,
    targetId: 'target', parentId: 'root' });
  await applier.stage(pullFixtures.page({ events: [event], nextCursor: 'next', collectionRevision: 'next-r1' }));
  await expect(applier.resume()).rejects.toThrow('worker_crash');
  const staged = (await f.store.listMappings(f.scope)).filter(row => row.colpId !== 'target')
    .map(({ scopeKey: _key, ...mapping }) => mapping);
  await f.stageSnapshot(staged);
  const projected = await recoverVerifiedOrFreeze({ scope: f.scope, store: f.store, api: effects.api,
    staged, freezeUnprovenIdentity: true });
  await f.store.finalizeRecoveryMappings(f.scope, 'snapshot', projected);
  await f.store.commitRecovery(f.scope, 'snapshot');
  expect(await f.store.getLocalSyncExclusion(f.scope, '2')).toMatchObject({ decisionId: 'snapshot-issue:snapshot',
    nativeId: '2', priorColpId: 'target' });
  const decision = (await f.store.listRemoteDeleteDecisions(f.scope, ['pending']))[0]!;
  expect(decision).toBeDefined();
  await f.store.decideRemoteDelete(f.scope, { decisionId: decision.decisionId, action: 'apply',
    expectedCasVersion: decision.casVersion, deleteRevision: decision.deleteRevision,
    generation: f.scope.generation, now: 2, permissionGranted: true });
  f.restart(); f.native.calls.length = 0;
  return { ...f, get store() { return f.store; }, decision };
}
