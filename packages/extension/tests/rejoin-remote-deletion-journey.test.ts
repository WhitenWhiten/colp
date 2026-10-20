// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { MemoryStorageArea } from '../src/credential-store.js';
import { createSyncStateStore, DATABASE_NAME } from '../src/sync-state-store.js';
import { createPersonalSyncPolicyStore } from '../src/personal-sync-policy.js';
import { configurePersonalSyncTransport } from '../src/personal-sync-fetch.js';
import { detachScopeMount } from '../src/scope-commands.js';
import { handleScopeCommand } from '../src/sw/first-run.js';
import { handleRejoinDecisionRequest } from '../src/sw/rejoin-decisions.js';
import { rejoinFixture } from './rejoin-recovery-harness.js';
import { indexedDB, installKns05IndexedDb, scope } from './kns-05-pull-harness.js';
import { installRejoinHttp, REJOIN_TOKEN, rejoinSession } from './rejoin-http-fixture.js';
import { pullFixtures } from './pull-effect-fixtures.js';
import { createOutboundPushWorker } from '../src/outbound-push-worker.js';
import { assertQueuedUploadAllowed } from '../src/queued-upload-boundary.js';
import { queueRejoinOperation } from '../src/scope-rejoin-queue.js';
import { remoteRejoinDeleteCandidate, stageRemoteRejoinDelete } from '../src/scope-rejoin-remote-delete.js';
import { requestValue, runTransaction } from '../src/sync-state/idb.js';
import { STORES } from '../src/sync-state/schema.js';
import type { RejoinNative } from '../src/scope-rejoin-mutation.js';
import { endpoints } from './outbound-push-worker-harness.js';
import type { ChromeBookmarkNode } from '../src/chrome-bookmark-tree.js';
import { validRejoinDecisionRequest, type PublicRejoinDecision, type RejoinDecisionRequest } from '../src/scope-rejoin-decisions.js';
import { bindRejoinDecisions } from '../src/rejoin-decisions-ui.js';
import { REPLICA_REBUILD_JOURNAL } from '../src/replica-rebuild.js';

const state = vi.hoisted(() => ({ fixture: undefined as unknown as Awaited<ReturnType<typeof fixture>>,
  storage: undefined as unknown as MemoryStorageArea, permission: true, wakes: 0 }));
vi.mock('../src/sw/runtime.js', async () => {
  const { createAuthorityFence, createExtensionWorkCoordinator } = await import('../src/authority-fence.js');
  return { syncState: new Proxy({}, { get: (_target, key) => (...args: unknown[]) => {
    const store = state.fixture.getStore();
    return (store[key as keyof typeof store] as (...values: unknown[]) => unknown)(...args);
  } }), sw: { rootViewTokens: undefined },
  store: { loadCredential: async () => ({ accessToken: REJOIN_TOKEN, subject: scope.accountId }),
    loadSession: async () => rejoinSession(scope) }, extensionOrigin: () => 'chrome-extension://remote-delete-test',
  workCoordinator: createExtensionWorkCoordinator(createAuthorityFence({
    get: keys => state.storage.get(keys), set: values => state.storage.set(values) })),
  hasBookmarkPermission: async () => state.permission, rootScopeKey: (value: unknown) => JSON.stringify(value),
  DEFAULT_SYNC_FOLDER_TITLE: 'Know-N' };
});
vi.mock('../src/sw/scope.js', () => ({ currentSyncScope: async () => scope,
  pushSessionAuthority: async () => { throw new Error('unexpected_authority_refresh'); },
  loadConfig: async () => ({ serverOrigin: scope.serverOrigin, manifestUrl: `${scope.serverOrigin}/manifest.json` }) }));
vi.mock('../src/sw/engine.js', () => ({ scheduleSyncEngineWake: () => { state.wakes++; } }));
vi.mock('../src/sw/bookmarks.js', () => ({ bookmarkListenerLifecycle: { install: () => {} }, recoverBookmarkEvents: async () => {} }));
vi.mock('../src/bookmark-subscriptions/store.js', () => ({ subscriptionStore: {
  pendingOperations: async () => [], all: async () => [], count: async () => 0, ready: async () => {},
} }));

installKns05IndexedDb();
const policy = createPersonalSyncPolicyStore({ get: key => state.storage.get(key), set: values => state.storage.set(values) });
configurePersonalSyncTransport(policy);

async function fixture(beforePause?: (f: Awaited<ReturnType<typeof rejoinFixture>>) => Promise<void>) {
  const f = await rejoinFixture(); let store = f.store;
  f.api.seed({ id: '0', title: '' });
  f.api.seed({ id: 'native-root', parentId: '0', title: 'Bookmarks bar', folderType: 'bookmarks-bar' });
  f.api.seed({ id: 'native-folder', parentId: 'native-root', title: 'Folder', index: 0 });
  await f.api.move('native-node', { parentId: 'native-folder', index: 0 });
  const { scopeKey: _key, ...leaf } = (await store.getMappingByNativeId(scope, 'native-node'))!;
  await store.putMapping(scope, { ...leaf, parentNativeId: 'native-folder', parentColpId: 'remote-folder' });
  await store.putMapping(scope, { nativeId: 'native-folder', colpId: 'remote-folder', rootNativeId: 'native-root',
    parentNativeId: 'native-root', parentColpId: 'root-colp', nodeKind: 'folder', mountId: 'mount-bar',
    projection: { revision: 'folder-r1', childrenRevision: 'folder-c1', digest: 'folder',
      content: { title: 'Folder' }, childrenOrder: ['native-node'] } });
  const { scopeKey: _scopeKey, ...root } = (await store.getMappingByNativeId(scope, 'native-root'))!;
  await store.putMapping(scope, { ...root, parentColpId: 'library-root', mountId: 'mount-bar',
    rootRole: 'bookmarks-bar', projection: { ...root.projection, childrenOrder: ['native-child', 'native-folder'],
      content: { title: 'Bookmarks bar', folderRole: 'bookmarks-bar' } } });
  await store.putMapping(scope, { nativeId: 'recovery:library-root', colpId: 'library-root',
    rootNativeId: 'recovery:library-root', nodeKind: 'folder', projection: { revision: 'library-r1',
      childrenRevision: 'library-c1', digest: 'library', content: { title: 'Library', folderRole: 'root' } } });
  await beforePause?.(f);
  await detachScopeMount(store, scope, 'mount-bar');
  await f.api.update('native-node', { title: 'Only on this browser' });
  expect((await f.queue.changed('native-node', { title: 'Only on this browser' })).outcome).toBe('filtered');
  const added = await f.api.create({ parentId: 'native-folder', title: 'New local child', url: 'https://local-only.test/' });
  const created = (await f.api.get(added.id))[0]!;
  expect((await f.queue.created(added.id, { ...created, title: created.title ?? '' })).outcome).toBe('filtered');
  const deletion = pullFixtures.subtreeEvent({ sequence: 811, collectionId: scope.collectionId,
    targetId: 'remote-folder', members: ['remote-folder', 'node-1'], paged: false });
  await f.applier.stage(f.page([deletion], 'after-remote-family-delete')); await f.applier.resume();
  expect((await store.getRemoteObservation(scope, 'remote-folder'))?.kind).toBe('tombstone');
  expect(f.api.getNode('native-node')?.title).toBe('Only on this browser');
  f.api.calls.length = 0;
  return { ...f, addedId: added.id, getStore: () => store,
    reopen: () => { store.close(); store = createSyncStateStore({ indexedDB }); },
    facts: [
      { nodeId: 'library-root', parentId: null, kind: 'folder' as const, folderRole: 'root', title: 'Library',
        revision: 'library-r1', childrenRevision: 'library-c1' },
      { nodeId: 'root-colp', parentId: 'library-root', kind: 'folder' as const, folderRole: 'bookmarks-bar', title: 'Bookmarks bar',
        revision: 'revision-old', childrenRevision: 'bar-after-delete', position: 'p1' },
      { nodeId: 'node-child', parentId: 'root-colp', kind: 'bookmark' as const, title: 'node-child',
        url: 'https://example.test/', revision: 'revision-old', position: 'p1' },
    ],
  };
}
function nativeTree(id = '0'): ChromeBookmarkNode[] {
  const api = state.fixture.api;
  const visit = (nativeId: string): ChromeBookmarkNode => {
    const node = api.getNode(nativeId);
    if (!node) throw new Error("Can't find bookmark for id.");
    return { ...node, id: nativeId, title: String(node.title ?? ''),
      children: api.all().filter(row => row.parentId === nativeId).map(row => visit(String(row.id))) };
  };
  return [visit(id)];
}
beforeEach(async () => {
  state.storage = new MemoryStorageArea(); await policy.write(scope, 'enabled');
  state.fixture = await fixture(); state.permission = true; state.wakes = 0;
  installRejoinHttp(() => scope, () => state.fixture.facts);
  installNative();
});
afterEach(() => {
  window.dispatchEvent(new Event('pagehide')); document.body.replaceChildren();
  state.fixture?.getStore().close(); vi.unstubAllGlobals();
});
function installNative() {
  vi.stubGlobal('chrome', { storage: { local: state.storage }, bookmarks: { ...state.fixture.api,
    getTree: async () => nativeTree(), getSubTree: async (id: string) => nativeTree(id) } });
}
async function replaceFixture(beforePause: NonNullable<Parameters<typeof fixture>[0]>) {
  state.fixture.getStore().close();
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DATABASE_NAME);
    request.onsuccess = () => resolve(); request.onerror = () => reject(request.error);
  });
  state.fixture = await fixture(beforePause); installNative(); return state.fixture;
}
async function uploadBeforePause(f: Awaited<ReturnType<typeof rejoinFixture>>,
  result: 'pending' | 'unknown' | 'rejected' | 'applied', nativeIds = ['native-node']) {
  for (const nativeId of nativeIds) {
    const title = `Unsettled ${nativeId}`;
    await f.api.update(nativeId, { title }); expect((await f.queue.changed(nativeId, { title })).outcome).toBe('staged');
    await f.queue.flush();
  }
  if (result === 'pending') return;
  const session = await rejoinSession(scope);
  const worker = createOutboundPushWorker({ scope, store: f.store, endpoints: async () => endpoints,
    sessions: { get: async () => ({ credential: { accessToken: REJOIN_TOKEN, subject: scope.accountId }, session }) },
    ownerId: () => 'remote-delete-test', random: () => 0,
    assertUploadAllowed: queue => assertQueuedUploadAllowed({ store: f.store, scope, queue,
      parentOf: async id => (await f.native.getNative(id))?.parentId }),
    fetch: async (_url, init) => {
      const body = JSON.parse(String(init?.body)); expect(body.operations).toHaveLength(1);
      if (result === 'unknown') throw new Error('lost_response');
      const op = body.operations[0];
      return Response.json({ batchId: body.batchId, serverCursor: `receipt-${op.sequence}`,
        results: [{ opId: op.opId, sequence: op.sequence, status: result, warnings: [],
          ...(result === 'rejected' ? { code: 'resource_id_unavailable' }
            : { targetId: op.targetId, revision: `applied-${op.sequence}`, cursor: `receipt-${op.sequence}` }) }] });
    } });
  expect((await worker.drain()).outcome).toBe(result === 'unknown' ? 'unknown' : 'terminal');
}

async function decision() {
  await handleScopeCommand({ kind: 'known.scope.rejoin', mountId: 'mount-bar' });
  return listedDecision();
}
async function listedDecision() {
  const listed = await handleRejoinDecisionRequest({ kind: 'known.sync.rejoinDecisions.get' });
  expect(listed.ok).toBe(true); if (!listed.ok) throw new Error(listed.error);
  expect(listed.decisions).toHaveLength(1); return listed.decisions[0]!;
}
function choose(value: PublicRejoinDecision, choice: 'keep_local' | 'apply_remote_delete'): RejoinDecisionRequest {
  const base = { kind: 'known.sync.rejoinDecisions.resolve' as const, commandId: value.commandId,
    token: value.token, userGesture: true as const };
  return choice === 'apply_remote_delete' ? { ...base, choice, affectedCount: value.affectedCount, confirmSubtree: true }
    : { ...base, choice };
}

test.each(['keep_local', 'apply_remote_delete'] as const)
('a cloud tombstone with browser-only edits has a real handler decision and completes %s', async choice => {
  const f = state.fixture;
  expect(await handleScopeCommand({ kind: 'known.scope.rejoin', mountId: 'mount-bar' }))
    .toMatchObject({ ok: false, error: 'rejoin_pending' });
  const listed = await handleRejoinDecisionRequest({ kind: 'known.sync.rejoinDecisions.get' });
  expect(listed.ok).toBe(true); if (!listed.ok) throw new Error(listed.error);
  expect(listed.decisions).toHaveLength(1);
  const decision = listed.decisions[0]!;
  expect(decision).toMatchObject({ kind: 'remote_delete', title: 'Folder', affectedCount: 3, state: 'pending' });
  expect(decision.blockedReason).toBeUndefined();
  const originalQueue = await f.getStore().listQueue(scope);
  const base = { kind: 'known.sync.rejoinDecisions.resolve' as const, commandId: decision.commandId,
    token: decision.token, userGesture: true as const };
  const request: RejoinDecisionRequest = choice === 'apply_remote_delete'
    ? { ...base, choice, affectedCount: 3, confirmSubtree: true } : { ...base, choice };
  expect(await handleRejoinDecisionRequest(request)).toEqual({ ok: true, decisions: [] });
  expect((await f.getStore().getMountBinding(scope, 'mount-bar'))?.status).toBe('active');
  expect(await f.getStore().listQueue(scope)).toEqual(originalQueue);
  expect(await f.getStore().getMappingByColpId(scope, 'remote-folder')).toBeNull();
  expect(await f.getStore().getMappingByColpId(scope, 'node-1')).toBeNull();
  expect(f.api.getNode('native-child')?.title).toBe('node-child');
  if (choice === 'keep_local') {
    expect(f.api.calls).toEqual([]);
    expect(f.api.getNode('native-node')?.title).toBe('Only on this browser');
    expect(f.api.getNode(f.addedId)?.title).toBe('New local child');
    for (const nativeId of ['native-folder', 'native-node', f.addedId]) {
      expect(await f.getStore().getLocalSyncExclusion(scope, nativeId)).toMatchObject({ sourceKind: 'remote_delete', nativeId });
    }
  } else {
    expect(f.api.getNode('native-folder')).toBeUndefined();
    expect(f.api.getNode('native-node')).toBeUndefined(); expect(f.api.getNode(f.addedId)).toBeUndefined();
    expect(f.api.calls.filter(row => row.kind === 'delete')).toHaveLength(3);
  }
  f.reopen();
  expect(await handleRejoinDecisionRequest(request)).toEqual({ ok: true, decisions: [] });
  expect(f.api.calls.filter(row => row.kind === 'delete')).toHaveLength(choice === 'keep_local' ? 0 : 3);
});

test('a child added after preview requires a new count and an explicit fresh choice', async () => {
  const f = state.fixture, before = await decision();
  const added = await f.api.create({ parentId: 'native-folder', title: 'After preview', url: 'https://later.test/' });
  expect(await handleRejoinDecisionRequest(choose(before, 'apply_remote_delete'))).toEqual({ ok: false, error: 'preview_stale' });
  expect(f.api.calls.filter(row => row.kind === 'delete')).toEqual([]);
  const fresh = await listedDecision(); expect(fresh.affectedCount).toBe(4); expect(fresh.token).not.toBe(before.token);
  expect((await f.getStore().getScopeCommandPlan(scope, before.commandId))?.rejoinDecision?.supersededBy).toBe(fresh.commandId);
  expect(await handleRejoinDecisionRequest(choose(fresh, 'apply_remote_delete'))).toEqual({ ok: true, decisions: [] });
  expect(f.api.getNode(added.id)).toBeUndefined(); expect(f.api.calls.filter(row => row.kind === 'delete')).toHaveLength(4);
});

test('undoing a preview change never revives an earlier superseded authorization', async () => {
  const f = state.fixture, original = await decision();
  await f.api.update('native-node', { title: 'Temporary edit' });
  const changed = await listedDecision(); expect(changed.token).not.toBe(original.token);
  await f.api.update('native-node', { title: 'Only on this browser' });
  const undone = await listedDecision(); expect(undone.token).toBe(original.token);
  expect(undone.commandId).not.toBe(original.commandId); expect(undone.state).toBe('pending');
  expect((await f.getStore().getScopeCommandPlan(scope, original.commandId))?.phase).toBe('failed');
  expect(await handleRejoinDecisionRequest(choose(undone, 'keep_local'))).toEqual({ ok: true, decisions: [] });
  expect(f.api.calls.filter(row => row.kind === 'delete')).toEqual([]);
});

test('the delete request needs the exact displayed subtree count and explicit confirmation', async () => {
  const value = await decision(), request = choose(value, 'apply_remote_delete');
  const fields = { ...request } as Record<string, unknown>;
  for (const key of ['affectedCount', 'confirmSubtree']) {
    const incomplete = { ...fields }; delete incomplete[key]; expect(validRejoinDecisionRequest(incomplete)).toBe(false);
  }
  expect(validRejoinDecisionRequest({ ...fields, confirmSubtree: false })).toBe(false);
  expect(validRejoinDecisionRequest({ ...fields, affectedCount: 1.5 })).toBe(false);
  expect(validRejoinDecisionRequest({ ...fields, extra: true })).toBe(false);
  expect(await handleRejoinDecisionRequest({ kind: 'known.sync.rejoinDecisions.resolve', commandId: value.commandId,
    token: value.token, userGesture: true, choice: 'apply_remote_delete', affectedCount: 2, confirmSubtree: true }))
    .toEqual({ ok: false, error: 'preview_stale' });
  expect(await handleRejoinDecisionRequest({ kind: 'known.sync.rejoinDecisions.resolve', commandId: value.commandId,
    token: value.token, userGesture: true, choice: 'delete_remote' })).toEqual({ ok: false, error: 'request_invalid' });
  expect(state.fixture.api.calls).toEqual([]);
});

test.each([1, 3])('worker loss after native deletion %i resumes from actual absence without repeating it', async lostAt => {
  const f = state.fixture, value = await decision(); let removed = 0;
  chrome.bookmarks.remove = async id => { await f.api.remove(id); if (++removed === lostAt) throw new Error('worker_crash'); };
  expect(await handleRejoinDecisionRequest(choose(value, 'apply_remote_delete'))).toEqual({ ok: false, error: 'worker_crash' });
  expect((await f.getStore().getScopeCommandPlan(scope, value.commandId))?.phase).toBe('applying');
  f.reopen(); chrome.bookmarks.remove = id => f.api.remove(id);
  expect(await handleRejoinDecisionRequest({ kind: 'known.sync.rejoinDecisions.get' })).toEqual({ ok: true, decisions: [] });
  expect((await f.getStore().getScopeCommandPlan(scope, value.commandId))?.phase).toBe('active');
  expect(f.api.calls.filter(row => row.kind === 'delete')).toHaveLength(3);
  expect(new Set(f.api.calls.filter(row => row.kind === 'delete').map(row => row.nativeId)).size).toBe(3);
  expect(await f.getStore().listQueue(scope)).toEqual([]);
});

test('an unknown child arriving inside the final remove API survives and requires a new decision', async () => {
  const f = state.fixture, value = await decision(); let injected = false;
  chrome.bookmarks.remove = async id => {
    if (id === 'native-folder' && !injected) {
      injected = true;
      // External UI insertion at the actual Chrome API entry, after every
      // application read. Chrome ids are unique even if old leaves are gone.
      f.api.seed({ id: 'api-entry-new', parentId: id, index: 0, title: 'Never confirmed', url: 'https://new.test/' });
    }
    return f.api.remove(id); // honest Chrome refuses this nonempty folder
  };
  const result = await handleRejoinDecisionRequest(choose(value, 'apply_remote_delete'));
  expect(result).toMatchObject({ ok: true, decisions: [{ kind: 'remote_delete', state: 'pending', affectedCount: 2 }] });
  expect(injected).toBe(true); expect(f.api.getNode('api-entry-new')?.title).toBe('Never confirmed');
  expect(f.api.getNode('native-folder')).toBeDefined(); expect(f.api.getNode('native-node')).toBeUndefined();
  expect(f.api.calls.filter(row => row.kind === 'delete')).toHaveLength(2);
  expect((await f.getStore().getScopeCommandPlan(scope, value.commandId))?.phase).toBe('failed');
  f.reopen(); const fresh = await listedDecision(); expect(fresh.token).not.toBe(value.token);
  expect(f.api.getNode('api-entry-new')).toBeDefined();
  expect(await handleRejoinDecisionRequest(choose(fresh, 'keep_local'))).toEqual({ ok: true, decisions: [] });
  expect(await f.getStore().getMappingByNativeId(scope, 'native-node')).toBeNull();
  expect(await f.getStore().getLocalSyncExclusion(scope, 'api-entry-new')).toMatchObject({ sourceKind: 'remote_delete' });
  expect(f.api.calls.filter(row => row.kind === 'delete')).toHaveLength(2);
});

test('late native remove callbacks use durable actual deletion evidence after mappings are gone', async () => {
  const f = state.fixture, value = await decision();
  expect(await handleRejoinDecisionRequest(choose(value, 'apply_remote_delete'))).toEqual({ ok: true, decisions: [] });
  for (const nativeId of ['native-node', f.addedId, 'native-folder']) {
    expect((await f.queue.removed(nativeId, { parentId: nativeId === 'native-folder' ? 'native-root' : 'native-folder', index: 0 }))
      .outcome).toBe('apply_intent_reserved');
  }
  expect(await f.getStore().listQueue(scope)).toEqual([]);
  expect(await f.getStore().listLocalIssues(scope)).toEqual([]);
});

test('a live cloud member in a fresh complete snapshot blocks both local disposition choices', async () => {
  const f = state.fixture, value = await decision();
  f.facts.push({ nodeId: 'node-1', parentId: 'root-colp', kind: 'bookmark', title: 'Moved out in cloud',
    url: 'https://example.test/', revision: 'cloud-live-r2', position: 'p2' });
  expect(await handleRejoinDecisionRequest(choose(value, 'apply_remote_delete'))).toEqual({ ok: false, error: 'preview_stale' });
  const fresh = await listedDecision(); expect(fresh).toMatchObject({ blockedReason: 'native_unavailable' });
  expect(await handleRejoinDecisionRequest(choose(fresh, 'keep_local'))).toEqual({ ok: false, error: 'rejoin_dependency_pending' });
  expect(f.api.calls).toEqual([]); expect(await f.getStore().getMappingByColpId(scope, 'node-1')).not.toBeNull();
});

test.each(['pending', 'unknown', 'applied'] as const)
('a real %s upload remains unmodified and cannot be acknowledged by either deletion choice', async result => {
  const f = await replaceFixture(value => uploadBeforePause(value, result));
  const before = await f.getStore().listQueue(scope), receipts = await Promise.all(before.map(row => f.getStore().getQueueReceipt(scope, row.sequence)));
  expect(before).toHaveLength(1); expect(before[0]?.echoApplied).not.toBe(true);
  if (result === 'unknown') expect(before[0]?.attempt?.body).toBeTypeOf('string');
  const journalRead = vi.spyOn(state.storage, 'get');
  const value = await decision(); expect(value).toMatchObject({ kind: 'remote_delete',
    blockedReason: result === 'unknown' ? 'unknown_upload' : 'pending_upload' });
  expect(journalRead).toHaveBeenCalledWith(REPLICA_REBUILD_JOURNAL);
  journalRead.mockRestore();
  for (const choice of ['keep_local', 'apply_remote_delete'] as const) {
    expect(await handleRejoinDecisionRequest(choose(value, choice))).toEqual({ ok: false, error: 'rejoin_dependency_pending' });
  }
  expect(await f.getStore().listQueue(scope)).toEqual(before);
  expect(await Promise.all(before.map(row => f.getStore().getQueueReceipt(scope, row.sequence)))).toEqual(receipts);
  expect(f.api.calls).toEqual([]); expect(f.api.getNode('native-node')?.title).toBe('Only on this browser');
  expect(await f.getStore().getMappingByColpId(scope, 'node-1')).not.toBeNull();
});

test.each(['edit', 'mapping', 'exclusion', 'queued_metadata', 'attempt', 'clear', 'privacy'] as const)
('a %s change after confirmation and intent persistence cannot authorize native deletion', async change => {
  const f = state.fixture, value = await decision(); let injected = false;
  chrome.bookmarks.get = async id => {
    if (!injected && id === f.addedId && (await f.getStore().listApplyIntents(scope))
      .some(row => row.commandId === value.commandId)) {
      injected = true;
      if (change === 'edit') await f.api.update(f.addedId, { title: 'Latest local edit' });
      else if (change === 'mapping') await f.getStore().deleteMapping(scope, 'native-folder');
      else if (change === 'exclusion') await f.getStore().putLocalSyncExclusion(scope, { nativeId: f.addedId,
        generation: scope.generation, rootNativeId: 'native-root', decisionId: 'private-choice', sourceKind: 'remote_delete' });
      else if (change === 'queued_metadata') {
        const mapping = (await f.getStore().getMappingByNativeId(scope, 'native-folder'))!;
        await queueRejoinOperation(f.getStore(), scope, mapping, mapping.projection.revision,
          'update_node_content', { base: { description: null }, value: { description: 'New independent metadata' } });
      } else if (change === 'attempt') {
        const { scopeKey: _key, ...mount } = (await f.getStore().getMountBinding(scope, 'mount-bar'))!;
        await f.getStore().putMountBinding(scope, { ...mount, pauseBaseline: { ...mount.pauseBaseline!, lastAppliedCursor: 'another-pause' } });
      } else if (change === 'clear') await f.getStore().retireScope(scope, { retiredAt: Date.now(), reason: 'user_clear' });
      else await policy.write(scope, 'paused');
    }
    return (await f.api.get(String(id))).map(row => ({ ...row, id: String(id), title: row.title ?? '' }));
  };
  await handleRejoinDecisionRequest(choose(value, 'apply_remote_delete'));
  expect(injected).toBe(true); expect(f.api.calls.filter(row => row.kind === 'delete')).toEqual([]);
  expect(f.api.getNode('native-folder')).toBeDefined(); expect(f.api.getNode(f.addedId)).toBeDefined();
  if (change === 'mapping') expect(await f.getStore().getMappingByNativeId(scope, 'native-folder')).toBeNull();
  if (change === 'edit') expect(f.api.getNode(f.addedId)?.title).toBe('Latest local edit');
  if (change === 'exclusion') expect(await f.getStore().getLocalSyncExclusion(scope, f.addedId)).toMatchObject({ decisionId: 'private-choice' });
  if (change === 'clear') expect(await f.getStore().getScope(scope)).toBeNull();
  if (change === 'queued_metadata') {
    const [row] = await f.getStore().listQueue(scope); expect(row?.status).toBe('pending');
    expect(await f.getStore().getQueueReceipt(scope, row!.sequence)).toBeNull();
  }
});

test('a true server rejection resolves only the chosen subtree issue and preserves an unrelated rejection', async () => {
  const f = await replaceFixture(value => uploadBeforePause(value, 'rejected', ['native-node', 'native-child']));
  const before = await f.getStore().listQueue(scope), receipts = await Promise.all(before.map(row => f.getStore().getQueueReceipt(scope, row.sequence)));
  expect(before).toHaveLength(2); expect(receipts.every(row => row?.kind === 'terminal')).toBe(true);
  const value = await decision(); expect(value.blockedReason).toBeUndefined();
  expect(await handleRejoinDecisionRequest(choose(value, 'keep_local'))).toEqual({ ok: true, decisions: [] });
  expect(await f.getStore().listQueue(scope)).toEqual(before);
  expect(await Promise.all(before.map(row => f.getStore().getQueueReceipt(scope, row.sequence)))).toEqual(receipts);
  expect(await f.getStore().filterResolvedQueueIssues(scope, before)).toEqual(before.filter(row => row.payload.targetId === 'node-child'));
  expect(f.api.getNode('native-child')?.title).toBe('Unsettled native-child');
  f.reopen();
  expect(await f.getStore().filterResolvedQueueIssues(scope, before)).toEqual(before.filter(row => row.payload.targetId === 'node-child'));
  expect(await f.getStore().listQueue(scope)).toEqual(before);
});

test('a later pending row cannot downgrade an earlier unknown upload to a sendable draft', async () => {
  const f = await replaceFixture(async value => {
    await uploadBeforePause(value, 'unknown');
    const mapping = (await value.store.getMappingByNativeId(scope, 'native-folder'))!;
    await queueRejoinOperation(value.store, scope, mapping, mapping.projection.revision,
      'update_node_content', { base: { description: null }, value: { description: 'Later metadata edit' } });
  });
  const before = await f.getStore().listQueue(scope); expect(before.map(row => row.status)).toEqual(['unknown', 'pending']);
  expect(await decision()).toMatchObject({ blockedReason: 'unknown_upload' });
  expect(await f.getStore().listQueue(scope)).toEqual(before);
});

test('5000 long native ids remain complete under the default record cap and archive atomically', async () => {
  const f = state.fixture, store = f.getStore();
  const native = new Map<string, RejoinNative & { id: string; title: string }>(f.api.all()
    .map(row => [String(row.id), { ...row, id: String(row.id), title: String(row.title ?? '') }]));
  const additional = Array.from({ length: 4_997 }, (_, i) => `native-${String(i).padStart(5, '0')}-${'長'.repeat(128)}`);
  for (const [index, id] of additional.entries()) native.set(id, { id, parentId: 'native-folder', index: index + 2,
    title: `Local ${index}`, url: `https://wide.test/${index}` });
  const children = new Map<string, Array<{ id: string; title: string }>>();
  for (const node of native.values()) if (typeof node.parentId === 'string') {
    const siblings = children.get(node.parentId) ?? []; siblings.push(node); children.set(node.parentId, siblings);
  }
  let reads = 0, childReads = 0;
  const mount = (await store.getMountBinding(scope, 'mount-bar'))!, root = (await store.getMappingByNativeId(scope, 'native-folder'))!;
  const input = { store, scope, mount,
    getNative: async (id: string) => { reads++; return native.get(id); },
    getChildren: async (id: string) => { childReads++; return children.get(id) ?? []; },
    readRemoteSnapshot: async () => ({ snapshotId: 'complete', revision: 'complete', syncCursor: 'complete',
      identityDigest: 'complete', pageCount: 2, remoteFacts: f.facts }),
  };
  const candidate = await remoteRejoinDeleteCandidate(input, root);
  expect(candidate.affectedCount).toBe(5_000); expect(candidate.blockedReason).toBeUndefined();
  expect(reads).toBeLessThanOrEqual(5_020); expect(childReads).toBeLessThanOrEqual(3);
  await stageRemoteRejoinDelete(input, candidate);
  const saved = (await store.getScopeCommandPlan(scope, candidate.commandId))!;
  const db = await store.open(), tx = db.transaction([STORES.metadata, STORES.scopeCommandPlans], 'readonly');
  const pages = (await requestValue<Record<string, unknown>[]>(tx.objectStore(STORES.metadata).getAll()))
    .filter(row => row.kind === 'scope_command_evidence_v1');
  const headers = await requestValue<Record<string, unknown>[]>(tx.objectStore(STORES.scopeCommandPlans).getAll());
  expect(pages.length).toBeGreaterThan(1);
  for (const row of [...pages, ...headers]) expect(new TextEncoder().encode(JSON.stringify(row)).length).toBeLessThanOrEqual(256 * 1_024);
  expect(JSON.stringify(saved)).toContain(additional.at(-1));
  const original = IDBObjectStore.prototype.add;
  const fault = vi.spyOn(IDBObjectStore.prototype, 'add').mockImplementation(function(this: IDBObjectStore, value, key) {
    if (this.name === STORES.archives) throw new Error('archive_write_failed');
    return original.call(this, value, key);
  });
  try { await expect(store.retireScope(scope, { retiredAt: 1, reason: 'user_reset' })).rejects.toThrow('archive_write_failed'); }
  finally { fault.mockRestore(); }
  expect(await store.getScopeCommandPlan(scope, candidate.commandId)).toEqual(saved);
  expect(await store.getScope(scope)).not.toBeNull();
  f.reopen(); expect(await f.getStore().getScopeCommandPlan(scope, candidate.commandId)).toEqual(saved);
  await f.getStore().retireScope(scope, { retiredAt: 2, reason: 'user_reset' });
  expect((await f.getStore().exportArchive(scope)).scopeCommandPlans).toContainEqual(saved);
  // This scale scenario executes candidate capture, paged rereads, rollback,
  // store restart and a complete archive; native read counts above stay O(N).
}, 15_000);

test.each(['missing', 'operation', 'digest', 'different_result'] as const)
('a %s receipt at the final confirmation transaction cannot turn rejected work into resolved work', async damage => {
  const f = await replaceFixture(value => uploadBeforePause(value, 'rejected'));
  const value = await decision(), before = await f.getStore().listQueue(scope), row = before[0]!;
  const receipt = (await f.getStore().getQueueReceipt(scope, row.sequence))!;
  const db = await f.getStore().open();
  const physicalBefore = await requestValue(db.transaction(STORES.queue, 'readonly').objectStore(STORES.queue).getAll());
  // Simulate damage/racing loss after the true HTTP refusal and displayed
  // preview. No forged receipt is ever accepted as a successful outcome.
  await runTransaction(db, [STORES.receipts], 'readwrite', async tx => {
    const receipts = tx.objectStore(STORES.receipts);
    if (damage === 'missing') receipts.delete([receipt.scopeKey, receipt.receiptId]);
    else receipts.put({ ...receipt, ...(damage === 'operation' ? { opId: 'not-this-operation' }
      : damage === 'digest' ? { operationDigest: 'sha256:not-this-operation' }
        : { result: { results: [{ opId: 'unrelated', status: 'rejected' }] } }) });
  });
  await expect(f.getStore().confirmRejoinDecision(scope, { commandId: value.commandId, token: value.token,
    choice: 'keep_local', dependencies: [] })).rejects.toThrow('rejoin_dependency_pending');
  expect((await f.getStore().getScopeCommandPlan(scope, value.commandId))?.phase).toBe('pending');
  // listQueue derives visible refusal facts from the receipt being damaged;
  // compare the actual durable queue bytes to prove the failed CAS wrote none.
  expect(await requestValue(db.transaction(STORES.queue, 'readonly').objectStore(STORES.queue).getAll())).toEqual(physicalBefore);
  expect(f.api.calls).toEqual([]);
  expect(await f.getStore().filterResolvedQueueIssues(scope, before)).toEqual(before);
});

test('confirmation cannot replace the frozen subtree evidence with a different body', async () => {
  const value = await decision(), store = state.fixture.getStore();
  const before = await store.getScopeCommandPlan(scope, value.commandId);
  await expect(store.confirmRejoinDecision(scope, { commandId: value.commandId, token: value.token,
    choice: 'apply_remote_delete', dependencies: [], evidence: { remoteDeletion: {} } }))
    .rejects.toThrow('command_decision_invalid');
  expect(await store.getScopeCommandPlan(scope, value.commandId)).toEqual(before);
  expect(state.fixture.api.calls).toEqual([]);
});

test('a crash while renewing a changed preview rolls back both supersession and the new evidence', async () => {
  const f = state.fixture, value = await decision(), before = await f.getStore().getScopeCommandPlan(scope, value.commandId);
  await f.api.update('native-node', { title: 'Changed preview' });
  const original = IDBObjectStore.prototype.put;
  const fault = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function(this: IDBObjectStore, value, key) {
    if (this.name === STORES.scopeCommandPlans && value.commandId !== before!.commandId) throw new Error('worker_crash');
    return original.call(this, value, key);
  });
  try {
    expect(await handleRejoinDecisionRequest({ kind: 'known.sync.rejoinDecisions.get' })).toEqual({ ok: false, error: 'worker_crash' });
  } finally { fault.mockRestore(); }
  expect(await f.getStore().listScopeCommandPlans(scope)).toContainEqual(before);
  f.reopen(); const fresh = await listedDecision(); expect(fresh.token).not.toBe(value.token);
  expect((await f.getStore().getScopeCommandPlan(scope, value.commandId))?.rejoinDecision?.supersededBy).toBe(fresh.commandId);
  expect(f.api.calls.filter(row => row.kind === 'delete')).toEqual([]);
});

async function decisionScreen() {
  expect(await handleScopeCommand({ kind: 'known.scope.rejoin', mountId: 'mount-bar' }))
    .toMatchObject({ ok: false, error: 'rejoin_pending' });
  const requests: RejoinDecisionRequest[] = [];
  Object.assign(chrome, { runtime: { sendMessage: async (message: RejoinDecisionRequest) => {
    requests.push(message); return handleRejoinDecisionRequest(message);
  } } });
  document.body.innerHTML = '<section id="rejoin-decisions"></section>';
  const host = { panel: document.getElementById('rejoin-decisions')!, show: vi.fn(), onResolved: vi.fn() };
  const ui = bindRejoinDecisions(host); ui.setLibraryId(scope.collectionId); ui.onConnection(true);
  const choice = (value: string) => host.panel.querySelector<HTMLButtonElement>(`[data-rejoin-action="${value}"]`)!;
  const confirmation = () => host.panel.querySelector<HTMLInputElement>('[data-rejoin-delete-confirm]')!;
  await vi.waitFor(() => expect(host.panel.textContent).toContain('current browser copy contains 3 items'));
  return { ...host, ui, requests, choice, confirmation };
}

test.each(['keep_local', 'apply_remote_delete'] as const)
('the actual DOM choice %s reaches the runtime handler and settles native and durable facts', async choice => {
  const f = state.fixture, screen = await decisionScreen();
  const queue = await f.getStore().listQueue(scope), canonical = structuredClone(f.facts);
  expect(await f.getStore().getRemoteObservation(scope, 'remote-folder')).toMatchObject({ kind: 'tombstone' });
  expect(screen.choice('apply_remote_delete').disabled).toBe(true);
  if (choice === 'apply_remote_delete') {
    screen.choice(choice).click(); expect(f.api.calls.filter(row => row.kind === 'delete')).toEqual([]);
    screen.confirmation().checked = true; screen.confirmation().dispatchEvent(new Event('change'));
  }
  screen.choice(choice).click(); await vi.waitFor(() => expect(screen.onResolved).toHaveBeenCalledTimes(1));
  expect(screen.panel.textContent).toContain('Your choice is saved.');
  const requests = screen.requests.filter((row): row is Extract<RejoinDecisionRequest, { kind: 'known.sync.rejoinDecisions.resolve' }> =>
    row.kind === 'known.sync.rejoinDecisions.resolve');
  expect(requests).toHaveLength(1); const request = requests[0]!;
  expect(Object.keys(request)).toHaveLength(choice === 'apply_remote_delete' ? 7 : 5);
  expect(await f.getStore().getScopeCommandPlan(scope, request.commandId)).toMatchObject({ phase: 'active',
    baselineDigest: request.token, retryReason: choice });
  expect(await f.getStore().listQueue(scope)).toEqual(queue);
  expect(await f.getStore().getRemoteObservation(scope, 'remote-folder')).toBeNull();
  expect(f.facts).toEqual(canonical);
  expect(await f.getStore().getMappingByColpId(scope, 'remote-folder')).toBeNull();
  expect(await f.getStore().getMappingByColpId(scope, 'node-1')).toBeNull();
  expect(f.api.getNode('native-child')?.title).toBe('node-child');
  for (const nativeId of ['native-folder', 'native-node', f.addedId]) {
    if (choice === 'keep_local') {
      expect(f.api.getNode(nativeId)).toBeDefined();
      expect(await f.getStore().getLocalSyncExclusion(scope, nativeId)).toMatchObject({ sourceKind: 'remote_delete', nativeId });
    } else expect(f.api.getNode(nativeId)).toBeUndefined();
  }
  expect(f.api.calls.filter(row => row.kind === 'delete')).toHaveLength(choice === 'keep_local' ? 0 : 3);
  const intents = (await f.getStore().listApplyIntents(scope)).filter(row => row.commandId === request.commandId);
  expect(intents.map(row => row.nativeTargetId).sort()).toEqual(choice === 'keep_local'
    ? [] : ['native-folder', 'native-node', f.addedId].sort());
  for (const intent of intents) expect(intent).toMatchObject({ state: 'page_complete', nativeResult: 'applied_with_evidence',
    nativeResultConfirmation: { kind: 'api_return', nativeId: intent.nativeTargetId } });
  f.reopen(); await screen.ui.refresh();
  expect(screen.choice(choice)).toBeNull(); expect(screen.requests.filter(row => row.kind.endsWith('.resolve'))).toHaveLength(1);
  expect(await handleRejoinDecisionRequest(request)).toEqual({ ok: true, decisions: [] });
  expect(f.api.calls.filter(row => row.kind === 'delete')).toHaveLength(choice === 'keep_local' ? 0 : 3);
});

test('the actual DOM refreshes a grown subtree and waits for a new checked deletion before the handler removes it', async () => {
  const f = state.fixture, screen = await decisionScreen();
  screen.confirmation().checked = true; screen.confirmation().dispatchEvent(new Event('change'));
  const added = await f.api.create({ parentId: 'native-folder', title: 'After UI preview', url: 'https://later.test/' });
  screen.choice('apply_remote_delete').click();
  await vi.waitFor(() => expect(screen.panel.textContent).toContain('current browser copy contains 4 items'));
  expect(screen.confirmation().checked).toBe(false); expect(screen.choice('apply_remote_delete').disabled).toBe(true);
  expect(f.api.calls.filter(row => row.kind === 'delete')).toEqual([]); expect(screen.onResolved).not.toHaveBeenCalled();
  expect(screen.requests.filter(row => row.kind.endsWith('.resolve'))).toHaveLength(1);
  screen.confirmation().checked = true; screen.confirmation().dispatchEvent(new Event('change'));
  screen.choice('apply_remote_delete').click(); await vi.waitFor(() => expect(screen.onResolved).toHaveBeenCalledTimes(1));
  expect(screen.requests.filter(row => row.kind.endsWith('.resolve'))).toHaveLength(2);
  expect(f.api.getNode(added.id)).toBeUndefined(); expect(f.api.calls.filter(row => row.kind === 'delete')).toHaveLength(4);
  expect(await f.getStore().listQueue(scope)).toEqual([]);
  f.reopen(); expect(await handleRejoinDecisionRequest({ kind: 'known.sync.rejoinDecisions.get' })).toEqual({ ok: true, decisions: [] });
});
