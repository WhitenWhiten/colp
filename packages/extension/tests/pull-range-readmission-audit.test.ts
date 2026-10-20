import { afterEach, expect, test, vi } from 'vitest';
import { canonicalAuthoritativeEffectDigest, canonicalOperationDigest } from '@know-n/colp/sync';
import { subscriptionStore } from '../src/bookmark-subscriptions/store.js';
import { NativeWriteNotStartedError } from '../src/native-call-result.js';
import { pullFixtures } from './pull-effect-fixtures.js';
import { pullNativeWrapperFixture } from './pull-native-wrapper-fixture.js';
import { recoveryAuditApplier } from './pull-recovery-audit-fixture.js';

afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); await subscriptionStore.close(); });

test.each(['source-parent', 'destination-read', 'anchor-identity', 'anchor-parent'] as const)
('a persisted move does not start after the original %s evidence changes', async changed => {
  const f = await pullNativeWrapperFixture();
  try {
    const anchored = changed.startsWith('anchor');
    if (anchored) {
      await f.store.putMapping(f.scope, { ...f.target, nativeId: '6', colpId: 'anchor',
        parentNativeId: '4', parentColpId: 'destination' });
      f.native.seed({ id: '6', parentId: '4', index: 0, title: 'Anchor', url: 'https://anchor.test/' });
    }
    const raw = pullFixtures.mutationEvent({ kind: 'move', sequence: 31,
      collectionId: f.scope.collectionId, targetId: 'target', parentId: 'destination' });
    if (raw.kind !== 'operation' || raw.effect.kind !== 'node_moved' || raw.operation.type !== 'move_node') {
      throw new Error('fixture_move');
    }
    const operation = { ...raw.operation, payload: { ...raw.operation.payload,
      ...(anchored ? { afterId: 'anchor' } : {}) } };
    const effect = { ...raw.effect, placement: { ...raw.effect.placement, afterId: anchored ? 'anchor' : null },
      operationDigest: canonicalOperationDigest(operation) };
    const event = { ...raw, operation, effect: { ...effect, effectDigest: canonicalAuthoritativeEffectDigest(effect) } };
    const first = await recoveryAuditApplier(f, 'after_intent');
    await first.stage(pullFixtures.page({ events: [event], nextCursor: 'move-cursor', collectionRevision: 'move-r1' }));
    await expect(first.resume()).rejects.toThrow('worker_crash');
    expect((await f.store.listApplyIntents(f.scope))[0]).toMatchObject({ state: 'intent_prepared',
      anchors: { nativePreimage: { id: '2', parentId: '1' } } });
    f.restart();
    let readChanged = false;
    if (changed === 'source-parent') await f.native.move('2', { parentId: '3', index: 0 });
    if (changed === 'destination-read') {
      const children = f.native.getChildren.bind(f.native);
      vi.spyOn(f.native, 'getChildren').mockImplementation(async id => {
        if (id === '4') { readChanged = true; throw new Error('User denied permission to modify bookmarks.'); }
        return children(id);
      });
    }
    if (anchored) {
      const get = f.native.get.bind(f.native);
      vi.spyOn(f.native, 'get').mockImplementation(async id => {
        const result = (await get(id)).map(node => ({ ...node }));
        if (id === '6' && !readChanged) {
          readChanged = true;
          if (changed === 'anchor-identity') await f.store.deleteMapping(f.scope, '6');
          else await f.native.move('6', { parentId: '3', index: 0 });
        }
        return result;
      });
    }
    const rejection = (await recoveryAuditApplier(f)).resume();
    if (anchored) await expect(rejection).resolves.toBeUndefined();
    else if (changed === 'destination-read') await expect(rejection).rejects.toThrow('range_dependency_pending');
    else await expect(rejection).rejects.toBeInstanceOf(NativeWriteNotStartedError);
    if (changed !== 'source-parent') expect(readChanged).toBe(true);
    expect(f.native.calls.filter(call => call.kind === 'move' && call.nativeId === '2'))
      .toHaveLength(changed === 'source-parent' ? 1 : 0);
    expect(f.native.getNode('2')?.parentId).toBe(changed === 'source-parent' ? '3' : '1');
    expect(await f.store.getMappingByColpId(f.scope, 'target')).toMatchObject({ nativeId: '2', parentNativeId: '1' });
    if (anchored) expect((await f.store.getCursor(f.scope))?.cursor).toBe('move-cursor');
    else expect((await f.store.getCursor(f.scope))?.cursor).not.toBe('move-cursor');
    expect(await f.store.listAckIntents(f.scope)).toEqual([]);
    expect(await f.store.listQueue(f.scope)).toEqual([]);
    const intent = (await f.store.listApplyIntents(f.scope))[0]!;
    if (anchored) {
      const code = changed === 'anchor-identity' ? 'anchor_mapping_missing' : 'anchor_parent_mismatch';
      expect(intent.apiResultEvidence).toEqual({ setAside: code });
      expect(await f.store.listPullIssues(f.scope)).toEqual([expect.objectContaining({ code, nodeId: 'target' })]);
      expect((await f.store.getScope(f.scope))?.lifecycle).toBe('active');
      f.restart(); await (await recoveryAuditApplier(f)).resume();
      expect((await f.store.listPullIssues(f.scope))[0]?.code).toBe(code);
      expect(f.native.calls.filter(call => call.kind === 'move' && call.nativeId === '2')).toEqual([]);
    } else expect(intent.apiResultEvidence).toBeNull();
    if (changed !== 'destination-read') expect(intent).toMatchObject({ nativeResult: 'not_started', replayState: 'not_started' });
  } finally { f.close(); }
});
