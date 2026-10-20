import { afterEach, expect, test, vi } from 'vitest';
import { subscriptionStore } from '../src/bookmark-subscriptions/store.js';
import { projectNativeWaits } from '../src/native-wait.js';
import { duringNativeAdmission } from './pull-native-wrapper-fixture.js';
import { materializationApplier, materializationWait } from './pull-materialize-wait-fixture.js';

afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); await subscriptionStore.close(); });

test('correlated onCreated plus explicit bind survives reopen and defers the entire mapping handoff', async () => {
  const f = await materializationWait();
  try {
    const before = await f.store.getApplyIntent(f.scope, f.wait.intentId);
    expect(before?.nativeEventEvidence?.nativeId).toBe(f.orphan.id);
    expect(before?.apiResultEvidence).toBeNull();
    expect(await f.confirm('bind')).toEqual({ ok: true, result: 'bound', nativeId: f.orphan.id });
    expect((await f.store.getMappingByColpId(f.scope, 'target'))?.nativeId).toBe('2');
    expect(await f.store.getMappingByNativeId(f.scope, f.orphan.id)).toBeNull();
    expect((await f.store.getApplyIntent(f.scope, f.wait.intentId))?.nativeResultConfirmation)
      .toEqual({ kind: 'candidate_event', nativeId: f.orphan.id });
    f.restart(); await (await f.applier()).resume();
    expect(f.raw).toHaveBeenCalledTimes(2);
    expect((await f.store.getCursor(f.scope))?.cursor).toBe('next');
    expect((await f.store.getMappingByColpId(f.scope, 'target'))?.nativeId).toBe(f.orphan.id);
    expect((await f.store.getMappingByColpId(f.scope, 'child'))?.nativeId).not.toBe('6');
    expect(await f.native.getChildren('4')).toHaveLength(1);
    expect((await f.native.getChildren(f.orphan.id))[0]?.title).toBe('Child');
    expect((await f.store.getApplyIntent(f.scope, f.wait.intentId))?.nativeResultConfirmation)
      .toEqual({ kind: 'candidate_event', nativeId: f.orphan.id });
    for (const nativeId of ['2', '6']) {
      expect(await f.store.getMappingByNativeId(f.scope, nativeId)).toBeNull();
      expect(await f.store.getLocalSyncExclusion(f.scope, nativeId)).toMatchObject({ sourceKind: 'range_exit' });
    }
    expect(f.native.getNode('2')?.parentId).toBe('8'); expect(f.native.getNode('6')?.parentId).toBe('2');
    f.restart(); await (await f.applier()).resume();
    expect(await f.confirm('bind')).toMatchObject({ ok: true, result: 'duplicate' });
    expect(f.raw).toHaveBeenCalledTimes(2);
  } finally { f.close(); }
});

test('without event evidence keep-local-and-create uses a new receipt, preserves the orphan and completes the copy', async () => {
  const f = await materializationWait(false);
  try {
    const result = await f.confirm('keep_local_and_create');
    expect(result).toMatchObject({ ok: true, result: 'kept_local' });
    if (!result.ok || !('nativeId' in result)) throw new Error('expected_native_result');
    expect(result.nativeId).not.toBe(f.orphan.id);
    expect((await f.store.getMappingByColpId(f.scope, 'target'))?.nativeId).toBe('2');
    expect((await f.store.getApplyIntent(f.scope, f.wait.intentId))?.nativeResultConfirmation)
      .toEqual({ kind: 'api_return', nativeId: result.nativeId });
    f.restart(); await (await f.applier()).resume();
    expect(f.raw).toHaveBeenCalledTimes(3);
    expect(await f.native.getChildren('4')).toHaveLength(2);
    expect(await f.native.getChildren(f.orphan.id)).toHaveLength(0);
    expect(await f.store.getMappingByNativeId(f.scope, f.orphan.id)).toBeNull();
    expect((await f.store.getMappingByColpId(f.scope, 'target'))?.nativeId).toBe(result.nativeId);
    expect((await f.store.getCursor(f.scope))?.cursor).toBe('next');
    expect(await f.confirm('keep_local_and_create')).toMatchObject({ ok: true, result: 'duplicate' });
    expect(f.raw).toHaveBeenCalledTimes(3);
  } finally { f.close(); }
});

test('a crash after the child receipt retains separate parent confirmation and child API evidence', async () => {
  const f = await materializationWait();
  try {
    expect((await f.confirm('bind')).ok).toBe(true);
    const applier = await materializationApplier(f, boundary => {
      if (boundary === 'after_evidence_before_mapping') throw new Error('worker_crash');
    });
    await expect(applier.resume()).rejects.toThrow('worker_crash');
    const root = (await f.store.getApplyIntent(f.scope, f.wait.intentId))!;
    const child = (await f.store.getApplyIntent(f.scope, `${f.wait.intentId}:range:child`))!;
    expect(root.nativeResultConfirmation).toEqual({ kind: 'candidate_event', nativeId: f.orphan.id });
    expect(root.apiResultEvidence).toBeNull();
    expect(child.nativeResultConfirmation).toEqual({ kind: 'api_return', nativeId: child.apiResultEvidence?.nativeId });
    expect(child.apiResultEvidence?.nativeId).not.toBe(f.orphan.id);
    expect(child.eventId).toBeUndefined(); // This owner cannot overwrite the parent's event receipt.
    f.restart(); await (await f.applier()).resume();
    expect(f.raw).toHaveBeenCalledTimes(2);
    expect((await f.store.getCursor(f.scope))?.cursor).toBe('next');
    expect((await f.store.getApplyIntent(f.scope, f.wait.intentId))?.nativeResultConfirmation).toEqual(root.nativeResultConfirmation);
    expect((await f.store.getMappingByColpId(f.scope, 'child'))?.nativeId).toBe(child.apiResultEvidence?.nativeId);
  } finally { f.close(); }
});

test('cancel preserves unknown and old source, creates no destination child, and publishes a visible item issue', async () => {
  const f = await materializationWait(false);
  try {
    expect(await f.confirm('cancel')).toEqual({ ok: true, result: 'cancelled' });
    f.restart(); await (await f.applier()).resume();
    expect(f.raw).toHaveBeenCalledTimes(1);
    expect((await f.store.getCursor(f.scope))?.cursor).toBe('next');
    expect((await f.store.getMappingByColpId(f.scope, 'target'))?.nativeId).toBe('2');
    expect((await f.store.getApplyIntent(f.scope, f.wait.intentId))?.nativeResult).toBe('result_unknown');
    expect(await f.native.getChildren(f.orphan.id)).toHaveLength(0);
    expect((await f.store.listPullIssues(f.scope))[0]?.code).toBe('native_result_unknown');
    expect(await f.confirm('bind')).toMatchObject({ ok: false, code: 'native_result_cas' });
  } finally { f.close(); }
});

test.each(['source-edit', 'source-private', 'destination-private', 'source-rebind', 'candidate-manual', 'private-mapping-missing'])
  ('refuses %s without consuming the range wait or changing any old identity', async change => {
    const f = await materializationWait();
    try {
      let nativeId = f.orphan.id;
      if (change === 'source-edit') await f.native.update('2', { title: 'Local edit' });
      if (change === 'source-private') await f.native.move('8', { parentId: '3', index: 0 });
      if (change === 'destination-private') await f.native.move('4', { parentId: '3', index: 0 });
      if (change === 'source-rebind') {
        const { scopeKey: _scopeKey, ...source } = (await f.store.getMappingByColpId(f.scope, 'target'))!;
        await f.store.deleteMapping(f.scope, '2'); await f.store.putMapping(f.scope, { ...source, nativeId: 'replacement' });
      }
      if (change === 'candidate-manual') nativeId = (await f.native.create({ parentId: '4', title: f.orphan.title })).id;
      if (change === 'private-mapping-missing') await f.store.deleteMapping(f.scope, '3');
      const before = await f.store.getApplyIntent(f.scope, f.wait.intentId);
      expect((await f.confirm('bind', nativeId)).ok).toBe(false);
      expect(await f.store.getApplyIntent(f.scope, f.wait.intentId)).toEqual(before);
      expect(await projectNativeWaits(f.store, f.scope)).toHaveLength(1);
      expect(await f.store.getMappingByNativeId(f.scope, f.orphan.id)).toBeNull();
      expect(await f.native.getChildren(f.orphan.id)).toHaveLength(0);
    } finally { f.close(); }
  });

test('a mapping contender arriving after the native proof loses the atomic confirmation CAS', async () => {
  const f = await materializationWait();
  try {
    let injected = false;
    // Run the actual live authority verifier, then let another writer win
    // while its final await is returning. The real confirmation CAS must see it.
    expect(await f.confirm('bind', f.orphan.id, async () => {
      injected = true; await f.store.putMapping(f.scope, { ...f.target, nativeId: f.orphan.id, colpId: 'contender' });
    })).toEqual({ ok: false, code: 'native_result_cas' });
    expect(injected).toBe(true);
    expect((await f.store.getApplyIntent(f.scope, f.wait.intentId))?.nativeResult).toBe('result_unknown');
    expect((await f.store.getMappingByColpId(f.scope, 'target'))?.nativeId).toBe('2');
    expect((await f.store.getMappingByNativeId(f.scope, f.orphan.id))?.colpId).toBe('contender');
  } finally { f.close(); }
});

test.each(['mapping-content', 'mount', 'exclusion', 'scope-private'])
  ('confirmation rereads %s in the same transaction that consumes the wait', async change => {
    const f = await materializationWait();
    try {
      const before = await f.store.getApplyIntent(f.scope, f.wait.intentId);
      expect(await f.confirm('bind', f.orphan.id, async () => {
        if (change === 'mapping-content') {
          const { scopeKey: _scopeKey, ...mapping } = (await f.store.getMappingByColpId(f.scope, 'target'))!;
          await f.store.putMapping(f.scope, { ...mapping, projection: { ...mapping.projection,
            resourceRevision: 'newer', revision: 'newer', content: { title: 'Fresh content' } } });
        }
        if (change === 'mount') await f.store.detachMount(f.scope, 'mount');
        if (change === 'exclusion') await f.store.putLocalSyncExclusion(f.scope, {
          nativeId: '2', priorColpId: 'target', rootNativeId: '8', decisionId: 'keep-local',
          generation: f.scope.generation, sourceKind: 'remote_delete' });
        if (change === 'scope-private') {
          await f.store.configureBrowserRoots(f.scope, {
            discovered: [{ nativeId: '1', ancestorNativeIds: [] }, { nativeId: '8', ancestorNativeIds: [] }],
            selectedNativeIds: ['1'], privateNativeIds: ['8'], status: 'ready' });
        }
      })).toEqual({ ok: false, code: 'native_result_cas' });
      expect(await f.store.getApplyIntent(f.scope, f.wait.intentId)).toEqual(before);
      expect(f.raw).toHaveBeenCalledTimes(1);
    } finally { f.close(); }
  });

test('a refused keep-new call remains not-started after final subscription admission, never unknown success', async () => {
  const f = await materializationWait(false);
  try {
    const injected = duringNativeAdmission(() => f.native.update('4', { title: 'New local parent title' }));
    expect((await f.confirm('keep_local_and_create')).ok).toBe(false);
    expect(injected()).toBe(true); expect(f.raw).toHaveBeenCalledTimes(1);
    expect(await f.store.getApplyIntent(f.scope, f.wait.intentId)).toMatchObject({
      nativeResult: 'not_started', replayState: 'not_started', apiPhase: 'intent_prepared', state: 'intent_prepared',
      nativeWaitDecision: { action: 'keep_local_and_create' } });
    f.restart(); await (await f.applier()).resume();
    expect(f.raw).toHaveBeenCalledTimes(3);
    expect(f.native.getNode('4')?.title).toBe('New local parent title');
    expect((await f.store.getCursor(f.scope))?.cursor).toBe('next');
  } finally { f.close(); }
});
