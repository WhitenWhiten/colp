import { afterEach, expect, test, vi } from 'vitest';
import { createChromePullBookmarkApi } from '../src/pull-bookmark-api.js';
import { confirmNativeWait, projectNativeWaits } from '../src/native-wait.js';
import { recoverVerifiedOrFreeze } from '../src/recovery-guard.js';
import { subscriptionStore } from '../src/bookmark-subscriptions/store.js';
import type { MappingInput } from '../src/sync-state-store.js';
import { pullFixtures } from './pull-effect-fixtures.js';
import { pullNativeWrapperFixture } from './pull-native-wrapper-fixture.js';
import { recoveryAuditApplier } from './pull-recovery-audit-fixture.js';

afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); await subscriptionStore.close(); });

test.each([false, true])('confirming an unknown create adopts the newer Snapshot placement after IDB reopen (move interrupted=%s)', async interrupted => {
  const f = await pullNativeWrapperFixture();
  try {
    const event = pullFixtures.createEvent({ kind: 'Bookmark', sequence: 21,
      collectionId: f.scope.collectionId, parentId: 'root' });
    if (event.kind !== 'operation' || event.effect.kind !== 'node_created'
        || event.effect.node.kind !== 'bookmark' || event.effect.node.redacted) throw new Error('fixture_create');
    const first = await recoveryAuditApplier(f, 'after_create_before_evidence');
    await first.stage(pullFixtures.page({ events: [event], nextCursor: 'create-cursor', collectionRevision: 'create-r1' }));
    await expect(first.resume()).rejects.toThrow('worker_crash');
    const nativeId = f.native.calls.find(call => call.kind === 'create')!.nativeId!;
    expect(f.native.getNode(nativeId)?.parentId).toBe('1');
    f.restart();
    await expect((await recoveryAuditApplier(f)).resume()).rejects.toThrow('native_result_unknown');
    expect(await projectNativeWaits(f.store, f.scope)).toHaveLength(1);

    const live = (await f.store.listMappings(f.scope)).map(({ scopeKey: _key, ...mapping }) => mapping);
    const incoming: MappingInput = { nativeId: `recovery:${event.effect.node.id}`, colpId: event.effect.node.id,
      rootNativeId: '1', parentColpId: 'destination', nodeKind: 'bookmark',
      projection: { revision: 'snapshot-newer', digest: 'snapshot-newer-content',
        content: { title: 'Newer Snapshot title', url: event.effect.node.url } } };
    const staged = [...live, incoming];
    await f.stageSnapshot(staged);
    const effects = await f.effects(createChromePullBookmarkApi());
    const projected = await recoverVerifiedOrFreeze({ scope: f.scope, store: f.store, api: effects.api,
      staged, freezeUnprovenIdentity: true });
    await f.store.finalizeRecoveryMappings(f.scope, 'snapshot', projected);
    await f.store.commitRecovery(f.scope, 'snapshot');
    expect(f.native.calls.filter(call => call.kind === 'create')).toHaveLength(1);
    f.restart();

    const [wait] = await projectNativeWaits(f.store, f.scope); expect(wait).toBeDefined();
    const approved = await confirmNativeWait({ scope: f.scope, store: f.store, api: effects.api,
      waitRef: wait!.waitRef, intentId: wait!.intentId, generation: f.scope.generation, action: 'bind', nativeId });
    expect(approved).toEqual({ ok: true, result: 'bound', nativeId });
    const beforeMapping = await f.store.getMappingByColpId(f.scope, incoming.colpId);
    expect(beforeMapping).toMatchObject({ nativeId, parentColpId: 'destination', parentNativeId: '1' });
    if (interrupted) {
      const move = f.native.move.bind(f.native);
      vi.spyOn(f.native, 'move').mockImplementationOnce(async (...args) => {
        await move(...args); throw new Error('worker_crash_after_native_move');
      });
      await expect((await recoveryAuditApplier(f)).resume()).rejects.toThrow('worker_crash_after_native_move');
      expect(f.native.getNode(nativeId)?.parentId).toBe('4');
      f.restart();
    }
    await (await recoveryAuditApplier(f)).resume();
    expect(f.native.getNode(nativeId)).toMatchObject({ parentId: '4', title: 'Newer Snapshot title' });
    expect(await f.store.getMappingByColpId(f.scope, incoming.colpId)).toMatchObject({ nativeId,
      parentColpId: 'destination', parentNativeId: '4', projection: { revision: 'snapshot-newer' } });
    expect(f.native.calls.filter(call => call.kind === 'create')).toHaveLength(1);
    expect(f.native.calls.filter(call => call.kind === 'move' && call.nativeId === nativeId)).toHaveLength(1);
    expect(f.native.calls.filter(call => call.kind === 'update' && call.nativeId === nativeId)).toHaveLength(1);
    expect(await projectNativeWaits(f.store, f.scope)).toEqual([]);
    expect((await f.store.getCursor(f.scope))?.cursor).toBe('snapshot-cursor');
    expect(await f.store.listQueue(f.scope)).toEqual([]);
    f.restart(); await (await recoveryAuditApplier(f)).resume();
    expect(f.native.calls.filter(call => call.kind === 'create')).toHaveLength(1);
    expect(f.native.calls.filter(call => call.kind === 'move' && call.nativeId === nativeId)).toHaveLength(1);
  } finally { f.close(); }
});
