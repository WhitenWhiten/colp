import 'fake-indexeddb/auto';
import { canonicalAuthoritativeEffectDigest, canonicalOperationDigest } from '@know-n/colp/sync';
import type { Operation, SyncPullEventV02 } from '@know-n/colp/types';
import { afterAll, afterEach, beforeEach, expect, test, vi } from 'vitest';
import { createDurableSyncEngine } from '../src/durable-sync-engine.js';
import { createPullApplier } from '../src/pull-applier.js';
import { createOutboundPushWorker } from '../src/outbound-push-worker.js';
import { recoverVerifiedOrFreeze } from '../src/recovery-guard.js';
import { assertQueuedUploadAllowed } from '../src/queued-upload-boundary.js';
import { handleRootRequest, loadRootView, readRootFolders } from '../src/sw/roots.js';
import { resumeRunningBootstrap } from '../src/sw/first-run.js';
import { syncState, sw } from '../src/sw/runtime.js';
import { LIBRARY_STATE } from '../src/library.js';
import type { ChromeBookmarkNode } from '../src/chrome-bookmark-tree.js';
import type { RemoteNodeFact } from '../src/bootstrap/matcher.js';
import type { SyncScope } from '../src/sync-state-store.js';
import type { StoredSession } from '../src/types.js';
import { installRejoinHttp, REJOIN_TOKEN, rejoinSession } from './rejoin-http-fixture.js';
import { endpoints } from './outbound-push-worker-harness.js';
import { pullFixtures } from './pull-effect-fixtures.js';

// Only account/config, Chrome, network and background scheduling are ports.
// Both Acks, the range command, bootstrap matcher, Push settlement and Pull
// page-local mapping publication use the shipped owners and real IndexedDB.
vi.mock('../src/sw/runtime.js', async () => {
  const { IDBFactory } = await import('fake-indexeddb');
  const { createSyncStateStore } = await import('../src/sync-state-store.js');
  return { syncState: createSyncStateStore({ indexedDB: new IDBFactory() }), sw: { rootViewTokens: undefined },
    store: { loadCredential: async () => ({ accessToken: REJOIN_TOKEN, subject: scope.accountId, serverOrigin: scope.serverOrigin }),
      loadSession: async () => session },
    hasBookmarkPermission: async () => true, rootScopeKey: (value: unknown) => JSON.stringify(value),
    extensionOrigin: () => 'chrome-extension://range-own-create', DEFAULT_SYNC_FOLDER_TITLE: 'Know-N' };
});
vi.mock('../src/sw/scope.js', () => ({ currentSyncScope: async () => scope,
  loadConfig: async () => ({ serverOrigin: scope.serverOrigin, manifestUrl: `${scope.serverOrigin}/manifest.json` }) }));
vi.mock('../src/sw/bookmarks.js', () => ({ bookmarkListenerLifecycle: { install: vi.fn() }, recoverBookmarkEvents: vi.fn() }));
vi.mock('../src/sw/engine.js', () => ({ scheduleSyncEngineWake: vi.fn() }));
vi.mock('../src/bookmark-subscriptions/store.js', () => ({ subscriptionStore: {
  pendingOperations: async () => [], all: async () => [], count: async () => 0, ready: async () => {},
} }));

let scope: SyncScope, session: StoredSession, raw: ChromeBookmarkNode[], serial = 0;
const flatten = (nodes: readonly ChromeBookmarkNode[]): ChromeBookmarkNode[] => nodes.flatMap(node => [node, ...flatten(node.children ?? [])]);
const remote: RemoteNodeFact[] = [
  { nodeId: 'cloud-root', parentId: null, folderRole: 'root', kind: 'folder', title: 'Library', revision: 'r-root', childrenRevision: 'c-root' },
  { nodeId: 'cloud-bar', parentId: 'cloud-root', folderRole: 'bookmarks-bar', kind: 'folder', title: 'Bar', revision: 'r-bar', childrenRevision: 'c-bar' },
  { nodeId: 'cloud-other', parentId: 'cloud-root', folderRole: 'other-bookmarks', kind: 'folder', title: 'Other', revision: 'r-other', childrenRevision: 'c-other' },
];
beforeEach(async () => {
  scope = { environment: 'development', serverId: 'server', serverOrigin: 'https://known.test', accountId: `range-pull-${++serial}`,
    browserProfileId: 'profile', collectionId: 'collection', replicaId: 'replica', generation: 1 };
  session = { ...await rejoinSession(scope), snapshotRequired: true };
  sw.rootViewTokens = undefined;
  raw = [{ id: '0', title: '', children: [
    { id: '1', parentId: '0', title: 'Bar', folderType: 'bookmarks-bar', children: [
      { id: '10', parentId: '1', title: 'Selected child', children: [
        { id: '11', parentId: '10', title: 'Local bookmark', url: 'https://example.test/local' },
      ] }, { id: '12', parentId: '1', title: 'Unselected sentinel', url: 'https://sentinel.invalid/' },
    ] }, { id: '2', parentId: '0', title: 'Other', folderType: 'other', children: [] },
  ] }];
  const unexpected = vi.fn(async (): Promise<never> => { throw new Error('self Pull must not mutate native bookmarks'); });
  vi.stubGlobal('chrome', { storage: { local: { get: async () => ({ [LIBRARY_STATE]: {
    accountId: scope.accountId, serverOrigin: scope.serverOrigin, status: 'ready', library: {
      id: scope.collectionId, title: 'Library', rootNodeId: 'cloud-root', library: true,
      bookmarksBarId: 'cloud-bar', otherBookmarksId: 'cloud-other',
    },
  } }), set: async () => {} } }, bookmarks: {
    getTree: async () => structuredClone(raw), get: async (id: string) => {
      const node = flatten(raw).find(row => row.id === id);
      if (!node) throw new Error("Can't find bookmark for id.");
      return [structuredClone(node)];
    }, getChildren: async (id: string) => {
      const node = flatten(raw).find(row => row.id === id);
      if (!node) throw new Error("Can't find bookmark for id.");
      return structuredClone(node.children ?? []);
    },
    create: unexpected, update: unexpected, move: unexpected, remove: unexpected, removeTree: unexpected,
  } });
  await syncState.registerScope({ ...scope, lifecycle: 'active', lease: { leaseId: 'lease', expiresAt: Date.now() + 60_000 },
    checkpoint: { cursor: 'before-cut', serverRevision: 'before-revision' },
    selectedRoots: ['cloud-other'], privateRoots: [], rootStatus: 'ready', firstRun: 'completed' });
  await syncState.putMountBinding(scope, { mountId: 'mount-other', nativeRootId: '2', remoteMountNodeId: 'cloud-other',
    rootRole: 'other-bookmarks', status: 'active', materialized: true, boundaryVersion: '0' });
  await syncState.putMapping(scope, { nativeId: '2', colpId: 'cloud-other', rootNativeId: '2', mountId: 'mount-other',
    nodeKind: 'folder', rootRole: 'other-bookmarks', parentColpId: 'cloud-root',
    projection: { revision: 'r-other', digest: 'sha256:other', childrenRevision: 'c-other', content: { title: 'Other', folderRole: 'other-bookmarks' } } });
  await syncState.configureBrowserRoots(scope, { discovered: (await readRootFolders()).discovered,
    selectedNativeIds: ['2'], privateNativeIds: [], status: 'ready' });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
afterAll(() => syncState.close());

test.each(['unchanged', 'selection_removed', 'private_root', 'private_ancestor', 'managed_root', 'managed_ancestor',
  'permission_revoked', 'native_permission_revoked', 'remote_changed', 'mapping_changed', 'parent_changed', 'excluded_ancestor',
  'selection_during_lookup', 'detach_during_lookup', 'private_during_lookup'] as const)
('a selected ordinary subfolder receives its own Push/Pull only under current exact authority (%s)', async scenario => {
  const beforeNative = structuredClone(raw);
  const snapshotRequests = installRejoinHttp(() => scope, () => remote);
  const snapshotFetch = fetch, clock = { now: Date.now() }, acked: string[] = [];
  const events: Extract<SyncPullEventV02, { kind: 'operation' }>[] = [];
  const canonical = new Map(remote.map(row => [row.nodeId, { ...row }]));
  let delivered = false;
  const transport: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === '/manifest.json' || url.pathname === '/v1/snapshot') return snapshotFetch(input, init);
    if (url.pathname === '/v1/snapshot/conflicts') return Response.json({
      snapshotId: 'rejoin-snapshot', offset: 0, nextOffset: null, conflictCount: 0, conflicts: [] });
    if (url.pathname === '/v1/ack') {
      const body = JSON.parse(String(init?.body));
      expect(await syncState.getPendingAckIntent(scope)).toMatchObject({ cursor: body.cursor, state: 'pending' });
      expect(body.cursor).toBe(acked.length === 0 ? 'cloud-cursor' : 'all-created');
      acked.push(body.cursor); session = { ...session, snapshotRequired: false };
      return Response.json({ replicaId: scope.replicaId, ackedCursor: body.cursor, ackedAt: new Date().toISOString() });
    }
    if (url.pathname === '/v1/push') {
      const body = JSON.parse(String(init?.body)) as { batchId: string; operations: Operation[] };
      expect(body.operations).toHaveLength(1);
      const operation = body.operations[0]!;
      if (operation.type !== 'create_node') throw new Error('unexpected range operation');
      if (operation.payload.node.kind !== 'folder' && operation.payload.node.kind !== 'bookmark') throw new Error('unexpected range node');
      expect(canonical.has(operation.payload.parentId)).toBe(true);
      const template = pullFixtures.createEvent({ kind: operation.payload.node.kind === 'folder' ? 'Folder' : 'Bookmark',
        sequence: operation.sequence, collectionId: scope.collectionId, parentId: operation.payload.parentId,
        replicaId: scope.replicaId, opId: operation.opId });
      if (template.kind !== 'operation' || template.effect.kind !== 'node_created') throw new Error('invalid create fixture');
      const effect = { ...template.effect, node: { ...operation.payload.node, id: `created-${events.length + 1}`,
        revision: `created-r${events.length + 1}`, collectionId: scope.collectionId, parentId: operation.payload.parentId,
        position: template.effect.placement.position, visibility: 'private' as const,
        createdAt: operation.occurredAt, updatedAt: operation.occurredAt },
      operationDigest: canonicalOperationDigest(operation), effectDigest: '' };
      effect.effectDigest = canonicalAuthoritativeEffectDigest(effect);
      events.push({ ...template, operation, effect });
      canonical.set(effect.node.id, { nodeId: effect.node.id, parentId: effect.node.parentId,
        kind: effect.node.kind === 'bookmark' ? 'bookmark' : 'folder', title: effect.node.title ?? '', revision: effect.node.revision });
      return Response.json({ batchId: body.batchId, serverCursor: template.cursor, results: [{
        opId: operation.opId, sequence: operation.sequence, status: 'applied', targetId: effect.node.id,
        revision: effect.node.revision, cursor: template.cursor, warnings: [] }] });
    }
    if (url.pathname === '/v1/pull') {
      const page = pullFixtures.page({ events: delivered ? [] : events, nextCursor: 'all-created', collectionRevision: 'after-create' });
      delivered = true; return Response.json(page);
    }
    throw new Error(`undeclared HTTP ${url.pathname}`);
  };
  vi.stubGlobal('fetch', transport);
  const sessions = { get: async () => ({ credential: { accessToken: REJOIN_TOKEN }, session }) };
  const worker = createOutboundPushWorker({ scope, store: syncState, endpoints: async () => endpoints, sessions,
    fetch: transport, now: () => clock.now, ownerId: () => 'range-pull-worker',
    assertUploadAllowed: queue => assertQueuedUploadAllowed({ store: syncState, scope, queue,
      parentOf: async id => (await chrome.bookmarks.get(id))[0]?.parentId }) });
  const applier = createPullApplier({ scope, store: syncState, api: chrome.bookmarks,
    session: { ...session, collectionId: scope.collectionId }, endpoints, credential: { accessToken: REJOIN_TOKEN },
    effectPageTemplate: endpoints.syncEffectPages, effectPageAuthority: 'https://known.example',
    origin: 'chrome-extension://range-own-create', fetch: transport });
  const engine = () => createDurableSyncEngine({ scope, store: syncState, sessions, endpoints: async () => ({ ...endpoints,
    syncSnapshot: `${scope.serverOrigin}/v1/snapshot` }), fetch: transport, now: () => clock.now,
    pushWorker: worker, pullApplier: applier, snapshotProjector: staged => recoverVerifiedOrFreeze({
      scope, store: syncState, staged, api: chrome.bookmarks, freezeUnprovenIdentity: true }) });
  await engine().wake('manual');
  expect((await syncState.getEngineState(scope))?.lastError).toBeUndefined();
  expect(acked).toEqual(['cloud-cursor']);
  expect(snapshotRequests.filter(row => row.url.pathname === '/v1/snapshot')).toHaveLength(2);

  const view = await loadRootView(scope);
  const preview = await handleRootRequest({ kind: 'known.roots.preview', viewId: view.viewId,
    selectedRefs: view.roots.filter(row => ['Other', 'Selected child'].includes(row.title)).map(row => row.ref), privateRefs: [] });
  if (!preview.ok || !('preview' in preview)) throw new Error(`preview failed: ${JSON.stringify(preview)}`);
  const request = { kind: 'known.roots.confirm' as const, previewId: preview.preview.previewId,
    confirmationId: 'select-existing-child', treeDigest: preview.preview.treeDigest, remoteDeleteRefs: [] };
  expect(await handleRootRequest(request)).toMatchObject({ ok: true, confirmation: { state: 'committed' } });
  for (let turn = 0; turn < 3 && events.length < 2; turn++) {
    expect(await worker.drain()).toMatchObject({ outcome: 'terminal' });
    syncState.close(); await resumeRunningBootstrap(scope);
  }
  expect(events).toHaveLength(2);
  expect((await syncState.getMappingByNativeId(scope, '10'))?.colpId).toBe('created-1');
  expect((await syncState.getMappingByNativeId(scope, '11'))?.colpId).toBe('created-2');
  const binding = (await syncState.listMountBindings(scope)).find(row => row.nativeRootId === '10')!;
  expect(binding).toMatchObject({ status: 'active', remoteMountNodeId: 'created-1' });
  if (scenario === 'selection_removed' || scenario === 'private_root' || scenario === 'private_ancestor') {
    // Exercise the durable boundary repository while deliberately retaining the
    // old active mount: that row is identity evidence, never fresh permission.
    await syncState.configureBrowserRoots(scope, { discovered: (await readRootFolders()).discovered,
      selectedNativeIds: scenario === 'selection_removed' ? ['2'] : ['2', '10'],
      privateNativeIds: scenario === 'private_root' ? ['10'] : scenario === 'private_ancestor' ? ['1'] : [], status: 'ready' });
  }
  if (scenario === 'managed_root' || scenario === 'managed_ancestor') {
    const managed = scenario === 'managed_root' ? '10' : '1';
    const protect = (nodes: readonly ChromeBookmarkNode[]): ChromeBookmarkNode[] => nodes.map(node => ({ ...node,
      ...(node.id === managed ? { unmodifiable: 'managed' } : {}), ...(node.children ? { children: protect(node.children) } : {}) }));
    raw = protect(raw);
  }
  if (scenario === 'permission_revoked') await syncState.setBrowserRootStatus(scope, 'permission_required');
  if (scenario === 'native_permission_revoked') vi.spyOn(chrome.bookmarks, 'get').mockRejectedValue(new Error('Bookmark permission revoked'));
  if (scenario === 'remote_changed') await syncState.putMountBinding(scope, { ...binding, remoteMountNodeId: 'unrelated-remote' });
  if (scenario === 'mapping_changed' || scenario === 'parent_changed') {
    const { scopeKey: _scopeKey, ...existing } = (await syncState.getMappingByNativeId(scope, '10'))!;
    if (scenario === 'mapping_changed') await syncState.deleteMapping(scope, '10');
    await syncState.putMapping(scope, { ...existing,
      ...(scenario === 'mapping_changed' ? { colpId: 'unrelated-identity' } : { parentColpId: 'cloud-other' }) });
  }
  if (scenario === 'excluded_ancestor') await syncState.putLocalSyncExclusion(scope, { nativeId: '1', rootNativeId: '1',
    generation: scope.generation, decisionId: 'exclude-parent', priorColpId: 'cloud-bar', sourceKind: 'range_exit' });
  if (scenario === 'selection_during_lookup' || scenario === 'detach_during_lookup' || scenario === 'private_during_lookup') {
    const get = chrome.bookmarks.get;
    let changed = false;
    vi.spyOn(chrome.bookmarks, 'get').mockImplementation(async id => {
      const nodes = await get(id);
      if (id === '10' && !changed) {
        changed = true;
        if (scenario === 'detach_during_lookup') await syncState.detachMount(scope, binding.mountId);
        else await syncState.configureBrowserRoots(scope, { discovered: (await readRootFolders()).discovered,
          selectedNativeIds: scenario === 'selection_during_lookup' ? ['2'] : ['2', '10'],
          privateNativeIds: scenario === 'private_during_lookup' ? ['10'] : [], status: 'ready' });
      }
      return nodes;
    });
  }
  const beforePullNative = structuredClone(raw), beforePullMappings = await syncState.listMappings(scope);
  const beforePullQueue = await syncState.listQueue(scope);
  clock.now += 31_000; await engine().wake('alarm');
  if (scenario === 'remote_changed') {
    // A different live mount leaves these old canonical nodes outside the
    // selected range. Consuming their authority may advance the cursor, but
    // cannot adopt the still-present local folders into the new remote root.
    expect(acked).toEqual(['cloud-cursor', 'all-created']);
    expect((await syncState.getMountBinding(scope, binding.mountId))?.remoteMountNodeId).toBe('unrelated-remote');
    expect((await syncState.getMappingByNativeId(scope, '10'))?.colpId).toBe('created-1');
    expect((await syncState.getMappingByNativeId(scope, '11'))?.colpId).toBe('created-2');
    expect(await syncState.getMappingByColpId(scope, 'unrelated-remote')).toBeNull();
    const settled = await syncState.listQueue(scope);
    expect(settled.map(({ opId, sequence, digest, status }) => ({ opId, sequence, digest, status })))
      .toEqual(beforePullQueue.map(({ opId, sequence, digest, status }) => ({ opId, sequence, digest, status })));
    for (const row of settled) expect(await syncState.getQueueReceipt(scope, row.sequence)).toMatchObject({
      opId: row.opId, operationDigest: row.digest, kind: 'terminal' });
    expect(raw).toEqual(beforePullNative);
    for (const method of ['create', 'update', 'move', 'remove', 'removeTree'] as const) expect(chrome.bookmarks[method]).not.toHaveBeenCalled();
    return;
  }
  if (scenario !== 'unchanged') {
    expect(acked).toEqual(['cloud-cursor']);
    expect(await syncState.listMappings(scope)).toEqual(beforePullMappings);
    expect(await syncState.listQueue(scope)).toEqual(beforePullQueue);
    expect((await syncState.getEngineState(scope))?.lastError).toBeTruthy();
    if (scenario === 'detach_during_lookup') expect((await syncState.getMountBinding(scope, binding.mountId))?.status).toBe('detached');
    expect(raw).toEqual(beforePullNative);
    for (const method of ['create', 'update', 'move', 'remove', 'removeTree'] as const) expect(chrome.bookmarks[method]).not.toHaveBeenCalled();
    return;
  }
  expect((await syncState.getScope(scope))?.metadata?.recoveryCode).toBeUndefined();
  expect(await syncState.getEngineState(scope)).toMatchObject({ phase: 'sleeping', recoveryFrozen: false });
  expect(acked).toEqual(['cloud-cursor', 'all-created']);
  expect(await syncState.getMappingByNativeId(scope, '10')).toMatchObject({ colpId: 'created-1', rootNativeId: '10' });
  expect(await syncState.getMappingByNativeId(scope, '11')).toMatchObject({ colpId: 'created-2', parentNativeId: '10' });
  const queue = await syncState.listQueue(scope);
  expect(queue.map(row => row.status)).toEqual(['terminal', 'terminal']);
  for (const row of queue) expect(await syncState.getQueueReceipt(scope, row.sequence)).toMatchObject({
    opId: row.opId, operationDigest: row.digest, kind: 'terminal' });
  expect([...canonical.keys()]).toEqual(['cloud-root', 'cloud-bar', 'cloud-other', 'created-1', 'created-2']);
  expect(raw).toEqual(beforeNative);
  for (const method of ['create', 'update', 'move', 'remove', 'removeTree'] as const) expect(chrome.bookmarks[method]).not.toHaveBeenCalled();
  syncState.close(); clock.now += 31_000; await engine().wake('startup');
  expect(await syncState.listQueue(scope)).toEqual(queue);
  expect((await syncState.getMappingByNativeId(scope, '10'))?.colpId).toBe('created-1');
  expect(raw).toEqual(beforeNative);
});
