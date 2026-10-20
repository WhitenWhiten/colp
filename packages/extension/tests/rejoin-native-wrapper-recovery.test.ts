import 'fake-indexeddb/auto';
import { afterEach, expect, test, vi } from 'vitest';
import { subscriptionStore } from '../src/bookmark-subscriptions/store.js';
import { detachScopeMount, rejoinScopeMount } from '../src/scope-commands.js';
import { listRejoinDecisions, refreshRejoinDecisions, resolveRejoinDecision } from '../src/scope-rejoin-decisions.js';
import { remoteRejoinDeleteCandidate, stageRemoteRejoinDelete } from '../src/scope-rejoin-remote-delete.js';
import { nativeChromeFacts } from '../src/sw/native-chrome.js';
import { deletionFixture } from './rejoin-decision-harness.js';
import { rejoinFixture } from './rejoin-recovery-harness.js';
import { installKns05IndexedDb, scope, type Kns05Chrome } from './kns-05-pull-harness.js';

installKns05IndexedDb();
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function install(api: Kns05Chrome) {
  api.seed({ id: '0', title: '' });
  api.seed({ ...api.getNode('native-root'), parentId: '0', folderType: 'bookmarks-bar' });
  vi.stubGlobal('chrome', { bookmarks: api });
  return nativeChromeFacts();
}
function duringAdmission(mutate: () => Promise<unknown>) {
  let armed = false, changed = false;
  const read = subscriptionStore.pendingOperations;
  vi.spyOn(subscriptionStore, 'pendingOperations').mockImplementation(async () => {
    const result = await read();
    if (armed && !changed) { changed = true; await mutate(); }
    return result;
  });
  return () => { armed = true; };
}

test('a refused real update is durably not started, and a new unchanged comparison can apply it once', async () => {
  const f = await rejoinFixture();
  try {
    const native = install(f.api);
    await detachScopeMount(f.store, scope, 'mount-bar');
    const mount = (await f.store.getMountBinding(scope, 'mount-bar'))!;
    await f.store.putRemoteObservation(scope, { colpId: 'node-1', remoteRevision: 'cloud-r2', kind: 'content',
      cursor: 'cloud-c2', payload: { title: 'Cloud title' }, observedAt: 1, sourceDigest: 'sha256:cloud-r2',
      pauseGeneration: scope.generation, pauseBoundaryVersion: mount.pauseBaseline!.boundaryVersion,
      pauseCursor: mount.pauseBaseline!.lastAppliedCursor });
    const arm = duringAdmission(() => f.api.update('native-node', { title: 'New user title' }));
    let writes = 0;
    vi.stubGlobal('chrome', { bookmarks: { ...f.api, update: async (id: string, value: { title?: string; url?: string }) => {
      writes++; return f.api.update(id, value);
    } } });
    const port = { ...native, updateNative: (id: string, value: { title?: string; url?: string },
      check?: Parameters<typeof native.updateNative>[2]) => { arm(); return native.updateNative(id, value, check); } };
    await rejoinScopeMount(f.store, scope, 'mount-bar', new Set(), [], port);
    expect(writes).toBe(0);
    expect(f.api.getNode('native-node')?.title).toBe('New user title');
    const refused = (await f.store.listApplyIntents(scope)).find(row => row.expected.kind === 'change')!;
    expect(refused).toMatchObject({ replayState: 'not_started', nativeResult: 'not_started' });
    expect(refused.apiResultEvidence).toBeUndefined();
    expect((await f.store.getScopeCommandPlan(scope, 'rejoin:mount-bar'))?.retryReason).toBe('rejoin_boundary_changed');
    await f.api.update('native-node', { title: 'node-1' });
    await rejoinScopeMount(f.store, scope, 'mount-bar', new Set(), [], port);
    expect(writes).toBe(1); expect(f.api.getNode('native-node')?.title).toBe('Cloud title');
    expect((await f.store.getApplyIntent(scope, refused.intentId))?.state).toBe('page_complete');
    expect(await f.store.listQueue(scope)).toEqual([]);
  } finally { f.store.close(); }
});

test('a Keep cloud create rejected at the real wrapper records no native return and stays not started', async () => {
  const f = await deletionFixture(0);
  try {
    const native = install(f.api); await f.compare();
    const arm = duringAdmission(async () => {
      await f.getStore().putLocalSyncExclusion(scope, { nativeId: 'native-root', rootNativeId: 'native-root',
        generation: scope.generation, priorColpId: 'root-colp', decisionId: 'new-exclusion' });
    });
    let writes = 0;
    await f.resolve('keep_remote', { ...native, createNative: (value, check) => {
      arm();
      return native.createNative(value, async () => { await check?.(); writes++; });
    } });
    expect(writes).toBe(0);
    expect(f.api.calls.filter(row => row.kind === 'create')).toEqual([]);
    const intent = (await f.getStore().listApplyIntents(scope)).find(row => row.expected.kind === 'create')!;
    expect(intent).toMatchObject({ nativeResult: 'not_started', replayState: 'not_started' });
    expect(intent.apiResultEvidence).toBeUndefined();
    expect((await f.getStore().getMappingByColpId(scope, 'restore-folder'))?.nativeId).toBe('unmounted:restore-folder');
  } finally { f.getStore().close(); }
});

test('a real wrapper create that landed without return evidence stays unknown across restart', async () => {
  const f = await deletionFixture(0);
  try {
    const native = install(f.api); await f.compare();
    await expect(f.resolve('keep_remote', { ...native, crash: at => {
      if (at === 'after_create_before_evidence') throw new Error('worker_crash');
    } })).rejects.toThrow('worker_crash');
    const before = f.api.all(); expect(f.api.calls.filter(row => row.kind === 'create')).toHaveLength(1);
    f.api.seed({ id: 'same-name-newcomer', parentId: 'native-root', title: 'Cloud folder' });
    f.reopen();
    await refreshRejoinDecisions({ ...f.input(), ...native });
    await refreshRejoinDecisions({ ...f.input(), ...native });
    expect(f.api.calls.filter(row => row.kind === 'create')).toHaveLength(1);
    expect(f.api.all().filter(row => row.id !== 'same-name-newcomer')).toEqual(before);
    expect(await f.getStore().getMappingByNativeId(scope, 'same-name-newcomer')).toBeNull();
    expect((await f.getStore().getMappingByColpId(scope, 'restore-folder'))?.nativeId).toBe('unmounted:restore-folder');
    const intent = (await f.getStore().listApplyIntents(scope)).find(row => row.expected.kind === 'create')!;
    expect(intent.nativeResult).toBe('result_unknown'); expect(intent.apiResultEvidence).toBeUndefined();
  } finally { f.getStore().close(); }
});

test('an explicitly confirmed cloud deletion rechecks its exact member after subscription admission', async () => {
  const f = await rejoinFixture();
  try {
    const native = install(f.api); await detachScopeMount(f.store, scope, 'mount-bar');
    const mount = (await f.store.getMountBinding(scope, 'mount-bar'))!;
    const mapping = (await f.store.getMappingByNativeId(scope, 'native-node'))!;
    const input = { ...native, store: f.store, scope, mount, readRemoteSnapshot: async () => ({
      snapshotId: 'complete-after-delete', revision: 'deleted-r2', syncCursor: 'deleted-c2', pageCount: 1, identityDigest: 'sha256:deleted',
      remoteFacts: [{ nodeId: 'root-colp', parentId: null, kind: 'folder' as const, title: 'Bar',
        revision: 'root-r1', childrenRevision: 'root-c2' }, { nodeId: 'node-child', parentId: 'root-colp',
        kind: 'bookmark' as const, title: 'node-child', url: 'https://example.test/', revision: 'revision-old', position: 'a' }],
    }) };
    await stageRemoteRejoinDelete(input, await remoteRejoinDeleteCandidate(input, mapping));
    const [decision] = await listRejoinDecisions(input); expect(decision?.blockedReason).toBeUndefined();
    const arm = duringAdmission(() => f.api.update('native-node', { title: 'After confirmation' }));
    let removes = 0;
    vi.stubGlobal('chrome', { bookmarks: { ...f.api, remove: async (id: string) => { removes++; return f.api.remove(id); } } });
    await resolveRejoinDecision({ ...input, removeNative: (id, tree, check) => { arm(); return native.removeNative(id, tree, check); } },
      { kind: 'known.sync.rejoinDecisions.resolve', commandId: decision!.commandId, token: decision!.token,
        choice: 'apply_remote_delete', userGesture: true, confirmSubtree: true, affectedCount: decision!.affectedCount });
    expect(removes).toBe(0); expect(f.api.getNode('native-node')?.title).toBe('After confirmation');
    const intent = (await f.store.listApplyIntents(scope)).find(row => row.expected.kind === 'remove')!;
    expect(intent).toMatchObject({ nativeResult: 'not_started', replayState: 'not_started' });
    expect(await f.store.getMappingByNativeId(scope, 'native-node')).not.toBeNull();
    expect((await f.store.getMountBinding(scope, 'mount-bar'))?.status).toBe('detached');
    expect((await listRejoinDecisions(input)).some(row => row.token !== decision!.token)).toBe(true);
  } finally { f.store.close(); }
});
