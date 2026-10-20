import { expect, test } from 'vitest';
import { digestJson } from '../src/bookmark-event-codec.js';
import { recoverVerifiedOrFreeze } from '../src/recovery-guard.js';
import { detachScopeMount } from '../src/scope-detach.js';
import { SyncFailureError } from '../src/sync-failure-class.js';
import type { MappingInput } from '../src/sync-state-store.js';
import { snapshotNativeFixture as fixture } from './snapshot-native-authority-fixture.js';

test.each(['active', 'detached', 'private'] as const)(
  'a persisted Snapshot delete respects its current native authority after restart (%s)', async boundary => {
    const f = await fixture();
    try {
      const staged = [f.root, f.privateRoot]; await f.stage(staged);
      const before = await f.effects(); await before.assertCurrent();
      f.chrome.crashOn.remove = 1;
      await expect(recoverVerifiedOrFreeze({ scope: f.scope, store: f.store, staged, api: before.api,
        freezeUnprovenIdentity: true })).rejects.toThrow('chrome_crash');
      expect(await f.store.listProjectionIntents(f.scope)).toEqual([expect.objectContaining({
        kind: 'delete', colpId: 'target', nativeId: '2', generation: f.scope.generation, state: 'recovery',
      })]);
      expect(f.chrome.nodes.has('2')).toBe(true);
      // These are real durable detach semantics / an independent Chrome user
      // move while no event listener is running. The canonical parent stays old.
      if (boundary === 'detached') await detachScopeMount(f.store, f.scope, 'mount');
      f.restart();
      if (boundary === 'private') await f.chrome.api.move('2', { parentId: '3', index: 0 });
      f.removals.length = 0;
      const after = await f.effects(); await after.assertCurrent();
      expect((await f.store.exportScope(f.scope)).recovery).toMatchObject({
        complete: true, sessionId: 'rejoin-session', syncCursor: 'snapshot-cursor',
      });
      await recoverVerifiedOrFreeze({ scope: f.scope, store: f.store, staged, api: after.api,
        freezeUnprovenIdentity: true, recoveryOnly: true }).catch(error => {
        expect(boundary).not.toBe('active'); expect(error).toBeInstanceOf(SyncFailureError);
      });
      await after.assertCurrent();
      if (boundary === 'active') {
        expect(f.removals).toEqual(['2']); expect(f.chrome.nodes.has('2')).toBe(false);
        expect(await f.store.getMappingByColpId(f.scope, 'target')).toBeNull();
        expect(await f.store.listProjectionIntents(f.scope)).toEqual([expect.objectContaining({ state: 'terminal' })]);
      } else {
        expect({ nativeRemoveCalls: f.removals, targetStillPresent: f.chrome.nodes.has('2') })
          .toEqual({ nativeRemoveCalls: [], targetStillPresent: true });
        expect(await f.store.getMappingByColpId(f.scope, 'target')).toMatchObject(f.target);
        expect((await f.store.listProjectionIntents(f.scope))[0]?.state).not.toBe('terminal');
      }
      expect(await f.store.listQueue(f.scope)).toEqual([]);
    } finally { f.close(); }
  });

test.each(['active', 'moved-private'] as const)(
  'Snapshot create checks the native parent again after reading its children (%s)', async boundary => {
    const f = await fixture();
    try {
      const parent: MappingInput = { ...f.privateRoot, nativeId: '4', colpId: 'parent',
        projection: { revision: 'parent-r1', digest: digestJson({ title: 'Parent' }),
          childrenRevision: 'parent-children-r1', content: { title: 'Parent' } } };
      const fresh: MappingInput = { ...f.target, nativeId: 'recovery:fresh', colpId: 'fresh',
        parentNativeId: '4', parentColpId: 'parent',
        projection: { revision: 'fresh-r1', digest: digestJson({ title: 'Fresh', url: 'https://fresh.test/' }),
          content: { title: 'Fresh', url: 'https://fresh.test/' } } };
      await f.store.putMapping(f.scope, parent);
      const staged = [f.root, f.privateRoot, f.target, parent, fresh]; await f.stage(staged);
      let moved = false;
      f.ports.afterChildren = async id => {
        if (boundary !== 'moved-private' || moved || id !== '4') return;
        moved = true;
        // An independent browser edit races the worker's final create. No
        // listener flush has changed the durable canonical parent chain.
        await f.chrome.api.move('4', { parentId: '3', index: 0 });
      };
      const effects = await f.effects(); await effects.assertCurrent();
      await recoverVerifiedOrFreeze({ scope: f.scope, store: f.store, staged, api: effects.api,
        freezeUnprovenIdentity: true }).catch(error => {
        expect(boundary).toBe('moved-private'); expect(error).toBeInstanceOf(SyncFailureError);
      });
      await effects.assertCurrent();
      if (boundary === 'active') {
        expect(f.chrome.creates).toBe(1);
        expect([...f.chrome.nodes.values()].find(row => row.url === 'https://fresh.test/')).toMatchObject({ parentId: '4' });
      } else {
        expect(moved).toBe(true);
        expect(f.chrome.nodes.get('4')?.parentId).toBe('3');
        expect((await f.store.getMappingByColpId(f.scope, 'parent'))?.parentColpId).toBe('root');
        expect({ nativeCreates: f.chrome.creates,
          leakedChild: [...f.chrome.nodes.values()].some(row => row.url === 'https://fresh.test/') })
          .toEqual({ nativeCreates: 0, leakedChild: false });
        const attempt = await f.store.getApplyIntent(f.scope, 'projection:create:fresh');
        expect(attempt).toMatchObject({ nativeResult: 'not_started', replayState: 'not_started' });
        expect(attempt?.apiResultEvidence).toBeUndefined();
        expect((await f.store.listProjectionIntents(f.scope)).find(row => row.colpId === 'fresh')?.state).toBe('recovery');
        // Restoring actual ancestry, then restarting, resumes that same attempt.
        // The refusal neither loses the plan nor invents a successful receipt.
        await f.chrome.api.move('4', { parentId: '1', index: 2 });
        f.ports.afterChildren = undefined; f.restart();
        const resumed = await f.effects(); await resumed.assertCurrent();
        await recoverVerifiedOrFreeze({ scope: f.scope, store: f.store, staged, api: resumed.api,
          freezeUnprovenIdentity: true, recoveryOnly: true });
        expect(f.chrome.creates).toBe(1);
        const applied = await f.store.getApplyIntent(f.scope, 'projection:create:fresh');
        expect(applied).toMatchObject({ nativeResult: 'applied_with_evidence', intentId: attempt!.intentId,
          apiResultEvidence: { nativeId: '5' } });
        expect(f.chrome.nodes.get('5')).toMatchObject({ parentId: '4', url: 'https://fresh.test/' });
      }
      expect(await f.store.listQueue(f.scope)).toEqual([]);
    } finally { f.close(); }
  });

test('an unknown Snapshot create remains unknown after its parent moves into private and the worker restarts', async () => {
  const f = await fixture();
  try {
    const fresh: MappingInput = { ...f.target, nativeId: 'recovery:fresh', colpId: 'fresh',
      projection: { revision: 'fresh-r1', digest: digestJson({ title: 'Fresh', url: 'https://fresh.test/' }),
        content: { title: 'Fresh', url: 'https://fresh.test/' } } };
    const staged = [f.root, f.privateRoot, f.target, fresh]; await f.stage(staged);
    f.ports.afterCreate = async () => { throw new Error('worker_crash'); };
    const before = await f.effects(); await before.assertCurrent();
    await expect(recoverVerifiedOrFreeze({ scope: f.scope, store: f.store, staged, api: before.api,
      freezeUnprovenIdentity: true })).rejects.toThrow('worker_crash');
    const started = await f.store.getApplyIntent(f.scope, 'projection:create:fresh');
    expect(started).toMatchObject({ state: 'browser_call_started', replayState: 'started' });
    expect(started?.apiResultEvidence).toBeUndefined(); expect(f.chrome.creates).toBe(1);
    // Move the selected custom root under a private folder outside that root.
    await f.chrome.api.move('3', { parentId: '0', index: 0 });
    await f.chrome.api.move('1', { parentId: '3', index: 0 });
    f.ports.afterCreate = undefined; f.restart();
    const after = await f.effects(); await after.assertCurrent();
    await expect(recoverVerifiedOrFreeze({ scope: f.scope, store: f.store, staged, api: after.api,
      freezeUnprovenIdentity: true, recoveryOnly: true })).rejects.toThrow('snapshot_native_projection_ambiguous');
    expect(f.chrome.creates).toBe(1);
    expect(await f.store.getApplyIntent(f.scope, 'projection:create:fresh')).toEqual(started);
    expect((await f.store.listProjectionIntents(f.scope)).find(row => row.colpId === 'fresh')?.state).toBe('ambiguous');
    expect(await f.store.listQueue(f.scope)).toEqual([]);
  } finally { f.close(); }
});
