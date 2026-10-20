import { afterEach, expect, test, vi } from 'vitest';
import { subscriptionStore } from '../src/bookmark-subscriptions/store.js';
import { NativeWriteNotStartedError } from '../src/native-call-result.js';
import { detachScopeMount } from '../src/scope-detach.js';
import { createChromePullBookmarkApi } from '../src/pull-bookmark-api.js';
import { recoverVerifiedOrFreeze } from '../src/recovery-guard.js';
import { duringNativeAdmission, pullNativeWrapperFixture } from './pull-native-wrapper-fixture.js';

afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); await subscriptionStore.close(); });

test('a refused Pull update persists not-started and captures the exact local title after restart', async () => {
  const f = await pullNativeWrapperFixture();
  try {
    const applier = await f.stage('update');
    const injected = duringNativeAdmission(() => f.native.update('2', { title: 'Keep my edit' }));
    await expect(applier.resume()).rejects.toBeInstanceOf(NativeWriteNotStartedError);
    expect(injected()).toBe(true);
    const events = await f.store.listPullEvents(f.scope), event = events[0]!;
    expect(event.state).toBe('intent_prepared');
    expect(await f.store.getApplyIntent(f.scope, String(event.intentId))).toMatchObject({
      nativeResult: 'not_started', replayState: 'not_started', state: 'intent_prepared', apiPhase: 'intent_prepared',
    });
    expect((await f.store.getApplyIntent(f.scope, String(event.intentId)))?.apiResultEvidence).toBeNull();
    expect((await f.store.getCursor(f.scope))?.cursor).not.toBe('next');
    expect(await f.store.listAckIntents(f.scope)).toEqual([]);
    f.restart(); await (await f.applier()).resume();
    expect(f.native.calls).toEqual([{ kind: 'update', nativeId: '2' }]);
    expect(f.native.getNode('2')?.title).toBe('Keep my edit');
    const captured = await f.store.listBookmarkEvents(f.scope);
    expect(captured).toHaveLength(1);
    expect(captured[0]?.details.draft).toMatchObject({ type: 'update_node_content',
      payload: { base: { title: 'Target' }, value: { title: 'Keep my edit' } } });
    expect((await f.store.getMappingByColpId(f.scope, 'target'))?.projection.content?.title).toBe('Keep my edit');
    expect(await f.store.getRemoteObservation(f.scope, 'target')).toMatchObject({ kind: 'content',
      payload: { title: 'Remote update' } });
    expect(await f.store.listQueue(f.scope)).toEqual([]);
    expect((await f.store.getCursor(f.scope))?.cursor).toBe('next');
  } finally { f.close(); }
});

test.each(['private-ancestor', 'private-identity-loss', 'detach', 'boundary-version', 'mapping-rebind',
  'root-unavailable', 'local-exclusion', 'managed-ancestor'] as const)
('Pull update refuses a current %s change after subscription admission', async kind => {
  const f = await pullNativeWrapperFixture();
  try {
    const applier = await f.stage('update');
    const injected = duringNativeAdmission(async () => {
      if (kind === 'private-ancestor') await f.native.move('2', { parentId: '3', index: 0 });
      if (kind === 'private-identity-loss') await f.store.deleteMapping(f.scope, '3');
      if (kind === 'detach') await detachScopeMount(f.store, f.scope, 'mount');
      if (kind === 'boundary-version') {
        const { scopeKey: _key, ...mount } = (await f.store.getMountBinding(f.scope, 'mount'))!;
        await f.store.putMountBinding(f.scope, { ...mount, boundaryVersion: 'new-confirmation' });
      }
      if (kind === 'mapping-rebind') {
        await f.store.deleteMapping(f.scope, '2');
        await f.store.putMapping(f.scope, { ...f.target, nativeId: '6' });
        f.native.seed({ ...f.native.getNode('2')!, id: '6' });
      }
      if (kind === 'root-unavailable') await f.store.setBrowserRootStatus(f.scope, 'permission_required');
      if (kind === 'local-exclusion') await f.store.putLocalSyncExclusion(f.scope, {
        nativeId: '2', rootNativeId: '1', priorColpId: 'target', generation: f.scope.generation,
        decisionId: 'keep-local', sourceKind: 'remote_delete',
      });
      if (kind === 'managed-ancestor') f.native.seed({ ...f.native.getNode('1')!, unmodifiable: 'managed' });
    });
    await expect(applier.resume()).rejects.toBeInstanceOf(NativeWriteNotStartedError);
    expect(injected()).toBe(true);
    expect(f.native.calls.filter(call => call.kind === 'update')).toEqual([]);
    expect(f.native.getNode('2')?.title).toBe('Target');
    expect((await f.store.getCursor(f.scope))?.cursor).not.toBe('next');
    expect(await f.store.listAckIntents(f.scope)).toEqual([]);
    f.restart();
    expect((await f.store.listPullEvents(f.scope))[0]?.state).toBe('intent_prepared');
    expect((await f.store.listApplyIntents(f.scope))[0]).toMatchObject({ nativeResult: 'not_started', replayState: 'not_started',
      apiPhase: 'intent_prepared' });
  } finally { f.close(); }
});

test('Snapshot content uses the same original preimage through the real mutation wrapper', async () => {
  const f = await pullNativeWrapperFixture();
  try {
    const { scopeKey: _scopeKey, ...destination } = (await f.store.getMappingByColpId(f.scope, 'destination'))!;
    const incoming = { ...f.target, projection: { ...f.target.projection, revision: 'snapshot-next',
      content: { title: 'Remote snapshot title', url: 'https://target.test/' } } };
    const staged = [f.root, f.privateRoot, incoming, destination]; await f.stageSnapshot(staged);
    const effects = await f.effects(createChromePullBookmarkApi());
    const injected = duringNativeAdmission(() => f.native.update('2', { title: 'New local snapshot edit' }));
    await expect(recoverVerifiedOrFreeze({ scope: f.scope, store: f.store, staged, api: effects.api,
      freezeUnprovenIdentity: true })).rejects.toBeInstanceOf(NativeWriteNotStartedError);
    expect(injected()).toBe(true);
    expect(f.native.calls).toEqual([{ kind: 'update', nativeId: '2' }]);
    expect(f.native.getNode('2')?.title).toBe('New local snapshot edit');
    expect((await f.store.listProjectionIntents(f.scope)).find(intent => intent.kind === 'update')?.state).toBe('recovery');
  } finally { f.close(); }
});

test('a genuine raw update failure retains its started evidence and is never labelled not-started', async () => {
  const f = await pullNativeWrapperFixture();
  try {
    const applier = await f.stage('update'), update = f.native.update.bind(f.native);
    vi.spyOn(f.native, 'update').mockImplementationOnce(async (id, changes) => {
      await update(id, changes); throw new Error('worker_crash');
    });
    await expect(applier.resume()).rejects.toThrow('worker_crash');
    expect(f.native.calls).toEqual([{ kind: 'update', nativeId: '2' }]);
    expect((await f.store.listPullEvents(f.scope))[0]?.state).toBe('browser_call_started');
    expect((await f.store.listApplyIntents(f.scope))[0]?.apiPhase).toBe('browser_call_started');
    expect((await f.store.listApplyIntents(f.scope))[0]?.replayState).not.toBe('not_started');
    f.restart(); await (await f.applier()).resume();
    expect(f.native.calls).toEqual([{ kind: 'update', nativeId: '2' }]);
    expect((await f.store.getCursor(f.scope))?.cursor).toBe('next');
  } finally { f.close(); }
});
