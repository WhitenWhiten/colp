import 'fake-indexeddb/auto';
import { afterAll, afterEach, beforeEach, expect, test, vi } from 'vitest';
import { MemoryStorageArea } from '../src/credential-store.js';
import { credentialAuthorityDigest } from '../src/session-client.js';
import { handleFirstRunRequest } from '../src/sw/first-run.js';
import { loadRootView } from '../src/sw/roots.js';
import { store, sw, syncState } from '../src/sw/runtime.js';
import { executeActiveAdvancedPlan } from '../src/bootstrap/advanced-run.js';
import type { AdvancedNativeApi } from '../src/bootstrap/advanced-local-executor.js';
import { assertQueuedUploadAllowed } from '../src/queued-upload-boundary.js';
import { digestJson } from '../src/bookmark-event-codec.js';
import { createOutboundPushWorker } from '../src/outbound-push-worker.js';
import type { ChromeBookmarkNode } from '../src/chrome-bookmark-tree.js';
import type { QueueOperation, SyncScope } from '../src/sync-state-store.js';
import type { StoredCredential, StoredSession } from '../src/types.js';
import { endpoints } from './outbound-push-worker-harness.js';
import { nonemptyMountSnapshot } from './durable-sync-engine-harness.js';

// Only the account/config boundary, independent subscription database, Chrome
// and HTTP are ports. Preview, complete snapshot reads, confirmation, planner,
// activation, executor, upload guard, Push settlement and IndexedDB stay real.
vi.mock('../src/sw/runtime.js', async () => {
  const { IDBFactory } = await import('fake-indexeddb');
  const { createSyncStateStore } = await import('../src/sync-state-store.js');
  const { createCredentialStore, MemoryStorageArea } = await import('../src/credential-store.js');
  const { createExtensionWorkCoordinator } = await import('../src/authority-fence.js');
  const store = createCredentialStore(new MemoryStorageArea());
  return { store, workCoordinator: createExtensionWorkCoordinator(store.fence),
    syncState: createSyncStateStore({ indexedDB: new IDBFactory() }), sw: { rootViewTokens: undefined },
    hasBookmarkPermission: async () => true, extensionOrigin: () => 'chrome-extension://advanced-fixture',
    rootScopeKey: (value: unknown) => JSON.stringify(value), DEFAULT_SYNC_FOLDER_TITLE: 'Know-N' };
});
vi.mock('../src/sw/scope.js', () => ({ currentSyncScope: async () => scope,
  loadConfig: async () => ({ serverOrigin: scope.serverOrigin, manifestUrl: `${scope.serverOrigin}/manifest` }) }));
vi.mock('../src/sw/bookmarks.js', () => ({ bookmarkListenerLifecycle: { install: vi.fn() }, recoverBookmarkEvents: vi.fn() }));
vi.mock('../src/sw/engine.js', () => ({ scheduleSyncEngineWake: vi.fn() }));
vi.mock('../src/bookmark-subscriptions/store.js', () => ({ subscriptionStore: {
  pendingOperations: async () => [], all: async () => [], count: async () => 0, ready: async () => {},
} }));

let scope: SyncScope, tree: ChromeBookmarkNode[], credential: StoredCredential, session: StoredSession, serial = 0;
let snapshotReads: string[], remoteHasBar = true;
function remoteSnapshot() {
  const full = nonemptyMountSnapshot();
  return remoteHasBar ? full : { ...full, nodes: full.nodes.slice(0, 1), parentRevisions: full.parentRevisions.slice(0, 1) };
}
const flatten = (nodes: readonly ChromeBookmarkNode[]): ChromeBookmarkNode[] => nodes.flatMap(node => [node, ...flatten(node.children ?? [])]);
beforeEach(async () => {
  scope = { environment: 'production', serverId: 'server', serverOrigin: 'https://known.example', accountId: `advanced-dispatch-${++serial}`,
    browserProfileId: 'profile', collectionId: 'collection-engine', replicaId: 'replica', generation: 1 };
  tree = [{ id: '0', title: '', children: [
    { id: '1', parentId: '0', title: 'Bar', folderType: 'bookmarks-bar', children: [
      { id: '10', parentId: '1', title: 'Local folder', children: [
        { id: '11', parentId: '10', title: 'Local bookmark', url: 'https://example.test/local' },
      ] },
    ] }, { id: '2', parentId: '0', title: 'Other', folderType: 'other', children: [
      { id: '20', parentId: '2', title: 'Unselected sentinel', url: 'https://sentinel.invalid/other' },
    ] },
  ] }];
  const unexpected = vi.fn(async (): Promise<never> => { throw new Error('upload must not mutate Chrome'); });
  vi.stubGlobal('chrome', { storage: { local: new MemoryStorageArea() }, bookmarks: {
    getTree: async () => structuredClone(tree), get: async (id: string) => {
      const node = flatten(tree).find(row => row.id === id); if (!node) throw new Error(`Can't find bookmark for id. ${id}`); return [structuredClone(node)];
    }, getChildren: async (id: string) => structuredClone(flatten(tree).find(row => row.id === id)?.children ?? []),
    create: unexpected, update: unexpected, move: unexpected, remove: unexpected, removeTree: unexpected,
  } });
  credential = { accessToken: 'advanced-test-token', tokenType: 'Bearer', subject: scope.accountId,
    accountLabel: 'Advanced fixture', expiresAt: Date.now() + 3_600_000, scope: ['known.sync'], serverOrigin: scope.serverOrigin,
    issuer: `${scope.serverOrigin}/`, audience: 'known-sync-api', clientId: 'known-chromium-extension' };
  session = { sessionId: 'advanced-session', expiresAt: '2099-01-01T00:00:00Z', scope: 'collection',
    acceptedProtocolVersion: '0.2', snapshotRequired: false, credentialAuthorityDigest: await credentialAuthorityDigest(credential.accessToken),
    collection: { collectionId: scope.collectionId, serverCursor: 'bootstrap-cursor', serverRevision: 'revision-snapshot' },
    replicaLease: { leaseId: 'lease', generation: '1', state: 'active', expiresAt: '2099-01-01T00:00:00Z' },
    conversionPolicy: { separator: 'preserve_remote' } };
  await store.saveCredential(credential); await store.saveSession(session);
  await syncState.registerScope({ ...scope, lifecycle: 'active', lease: { leaseId: 'lease', expiresAt: Date.now() + 60_000 },
    checkpoint: { serverRevision: 'revision-snapshot', cursor: 'bootstrap-cursor' },
    selectedRoots: [], privateRoots: [], firstRun: 'none', rootStatus: 'ready' });
  sw.rootViewTokens = undefined; snapshotReads = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname === '/manifest') return Response.json(manifest());
    if (url.pathname !== '/v1/snapshot') throw new Error(`undeclared HTTP request ${url.pathname}`);
    snapshotReads.push(url.searchParams.get('pageCursor') ?? 'first');
    const full = remoteSnapshot();
    if (!remoteHasBar) return Response.json(full);
    return Response.json(url.searchParams.has('pageCursor')
      ? { ...full, nodes: full.nodes.slice(2), parentRevisions: [], page: { sequence: 2, hasMore: false, nextCursor: null } }
      : { ...full, nodes: full.nodes.slice(0, 2), page: { sequence: 1, hasMore: true, nextCursor: 'last-page' } });
  });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
afterAll(() => syncState.close());

async function advancedFixture(existingRemoteMount: boolean) {
  remoteHasBar = existingRemoteMount;
  const view = await loadRootView(scope);
  const preview = await handleFirstRunRequest({ kind: 'known.firstRun.preview', viewId: view.viewId,
    selectedRefs: [view.roots.find(row => row.title === 'Bar')!.ref], excludedRefs: [], bootstrapMode: 'upload' });
  expect(preview).toMatchObject({ ok: true, advanced: { mode: 'upload' } });
  if (!preview.ok || !('previewId' in preview) || !preview.advanced) throw new Error('missing advanced preview');
  const request = { kind: 'known.firstRun.confirm' as const, previewId: preview.previewId, confirmationId: 'reviewed-upload',
    libraryId: scope.collectionId, bootstrapMode: 'upload' as const, advancedConfirmation: preview.advanced };
  expect(await handleFirstRunRequest(request)).toMatchObject({ ok: true, firstRun: 'running' });
  expect(snapshotReads).toEqual(existingRemoteMount ? ['first', 'last-page', 'first', 'last-page'] : ['first', 'first']);
  const admitted = (await syncState.listAdvancedPlans(scope))[0]!;
  expect(admitted.metadata).toMatchObject({ selectedNativeIds: ['1'], excludedNativeIds: [] });
  expect(await syncState.listMountBindings(scope)).toEqual([expect.objectContaining({ nativeRootId: '1', status: 'active',
    remoteMountNodeId: existingRemoteMount ? 'mount-bar' : null })]);
  const nativeBefore = structuredClone(tree);
  const sent: Array<Record<string, unknown>> = [];
  const canonical = new Map(remoteSnapshot().nodes.map(node => [node.id, { ...node }]));
  let created = 0;
  const workerOptions: Parameters<typeof createOutboundPushWorker>[0] = { scope, store: syncState, ownerId: () => 'advanced-worker',
    sessions: { get: async () => ({ credential, session }) }, endpoints: async () => ({ ...endpoints, syncPush: `${scope.serverOrigin}/v1/push` }),
    assertUploadAllowed: guard,
    fetch: async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      expect(body.operations).toHaveLength(1);
      const operation = body.operations[0]; sent.push(operation);
      const targetId = operation.type === 'create_node' ? `created-${++created}` : operation.targetId;
      if (operation.type === 'create_node') {
        expect(canonical.has(operation.payload.parentId)).toBe(true);
        canonical.set(targetId, { ...operation.payload.node, id: targetId, parentId: operation.payload.parentId });
      } else if (operation.type === 'delete_node') expect(canonical.delete(targetId)).toBe(true);
      else throw new Error(`unexpected advanced operation ${operation.type}`);
      return Response.json({ batchId: body.batchId, serverCursor: `cursor-${sent.length}`,
        results: [{ opId: operation.opId, sequence: operation.sequence, status: 'applied', targetId,
          revision: `r-${sent.length}`, cursor: `cursor-${sent.length}`, warnings: [] }] });
    } };
  return { request, admitted, nativeBefore, sent, canonical, workerOptions };
}

const guard = (queue: QueueOperation) => assertQueuedUploadAllowed({ store: syncState, scope, queue,
  parentOf: async id => (await chrome.bookmarks.get(id))[0]!.parentId });

test.each([true, false])('a newly confirmed advanced upload settles its reviewed tree with existing remote mount=%s', async existingRemoteMount => {
  const { request, admitted, nativeBefore, sent, canonical, workerOptions } = await advancedFixture(existingRemoteMount);
  const worker = createOutboundPushWorker(workerOptions);
  for (let step = 0; step < 6; step += 1) {
    await executeActiveAdvancedPlan(syncState, scope, chrome.bookmarks as AdvancedNativeApi);
    if ((await syncState.listAdvancedPlans(scope))[0]!.state === 'completed') break;
    const result = await worker.drain();
    expect(result, JSON.stringify({ scope: await syncState.getScope(scope), mounts: await syncState.listMountBindings(scope),
      queue: (await syncState.listQueue(scope)).map(({ sequence, status, recovery, payload }) => ({ sequence, status, recovery, payload })),
      confirmedMetadata: admitted.metadata })).toMatchObject({ outcome: 'terminal' });
    syncState.close();
  }
  expect((await syncState.listAdvancedPlans(scope))[0]!.state).toBe('completed');
  expect((await syncState.getScope(scope))?.firstRun).toBe('completed');
  expect([...canonical.values()].map(row => row.title).sort()).toEqual([
    existingRemoteMount ? 'Bar' : 'bookmarks-bar', 'Local bookmark', 'Local folder', 'root-server',
  ].sort());
  expect(tree).toEqual(nativeBefore);
  expect(JSON.stringify(sent)).not.toContain('Unselected sentinel');
  const queue = await syncState.listQueue(scope);
  expect(queue).toHaveLength(3);
  expect(queue.every(row => row.status === 'terminal')).toBe(true);
  for (const row of queue) expect(await syncState.getQueueReceipt(scope, row.sequence)).toMatchObject({ opId: row.opId, operationDigest: row.digest });
  const mappings = await syncState.listMappings(scope);
  const bookmark = mappings.find(row => row.nativeId === '11')!;
  expect(canonical.get(bookmark.colpId)?.title).toBe('Local bookmark');
  expect(new Set(mappings.map(row => row.nativeId)).size).toBe(mappings.length);
  expect(mappings.some(row => row.nativeId === '20')).toBe(false);
  expect(await handleFirstRunRequest(request)).toMatchObject({ ok: true });
  expect(await syncState.listQueue(scope)).toEqual(queue);
  await expect(guard(queue.at(-1)!)).rejects.toThrow('queued_upload_excluded');
});

async function stagedGrant(kind: 'mount-create' | 'cloud-delete') {
  const fixture = await advancedFixture(kind === 'cloud-delete');
  const worker = createOutboundPushWorker(fixture.workerOptions);
  if (kind === 'cloud-delete') for (let count = 0; count < 2; count++) {
    await executeActiveAdvancedPlan(syncState, scope, chrome.bookmarks as AdvancedNativeApi);
    expect(await worker.drain()).toMatchObject({ outcome: 'terminal' });
  }
  await executeActiveAdvancedPlan(syncState, scope, chrome.bookmarks as AdvancedNativeApi);
  const queued = (await syncState.listQueue(scope)).at(-1)!;
  expect(queued.status).toBe('pending');
  expect(queued.payload.type).toBe(kind === 'cloud-delete' ? 'delete_node' : 'create_node');
  return { ...fixture, queued };
}

for (const kind of ['mount-create', 'cloud-delete'] as const) {
  test.each(['private', 'paused', 'plan-attention', 'boundary', 'mount-identity'] as const)(
    `a confirmed ${kind} loses its grant before the last dispatch when %s changes`, async changed => {
      const f = await stagedGrant(kind);
      const before = await syncState.exportScope(scope);
      const sent = f.sent.length;
      const worker = createOutboundPushWorker({ ...f.workerOptions, beforeDispatch: async row => {
        expect(row.opId).toBe(f.queued.opId);
        expect((await syncState.getQueueByOpId(scope, row.opId))?.attempt).toBeDefined();
        const mount = (await syncState.listMountBindings(scope))[0]!;
        if (changed === 'private') await syncState.configureBrowserRoots(scope, {
          discovered: [{ nativeId: '1', ancestorNativeIds: [] }, { nativeId: '2', ancestorNativeIds: [] }],
          selectedNativeIds: [], privateNativeIds: ['1'], status: 'ready' });
        else if (changed === 'paused') await syncState.detachMount(scope, mount.mountId);
        else if (changed === 'boundary') await syncState.bumpBoundaryVersion(scope);
        else if (changed === 'mount-identity') await syncState.putMountBinding(scope, { ...mount, remoteMountNodeId: 'different-cloud-mount' });
        else {
          const loaded = await syncState.readAdvancedPlan(scope, f.admitted.planId);
          const executing = loaded!.steps.find(step => step.state === 'executing')!;
          await syncState.settleAdvancedStep(scope, f.admitted.planId, executing.order,
            { expectedState: 'executing', state: 'attention', error: 'advanced_boundary_changed' });
        }
      } });
      await worker.drain();
      expect(f.sent).toHaveLength(sent);
      const retained = (await syncState.getQueueByOpId(scope, f.queued.opId))!;
      expect(retained.payload).toEqual(f.queued.payload);
      expect(retained.digest).toBe(f.queued.digest);
      expect(retained.sequence).toBe(f.queued.sequence);
      expect(await syncState.getQueueReceipt(scope, retained.sequence)).toBeNull();
      expect((await syncState.exportScope(scope)).receipts).toEqual(before.receipts);
      expect(tree).toEqual(f.nativeBefore);
      syncState.close();
      await expect(guard(retained)).rejects.toThrow();
      expect(f.sent).toHaveLength(sent);
    });
}

test.each(['opId', 'target', 'payload', 'digest', 'sequence'] as const)(
  'the cloud command grant cannot be borrowed by a changed %s', async changed => {
    const f = await stagedGrant('cloud-delete');
    const payload = { ...f.queued.payload,
      ...(changed === 'opId' ? { opId: 'ab.unknown' } : {}),
      ...(changed === 'target' ? { targetId: 'outside-confirmed-snapshot' } : {}),
      ...(changed === 'payload' ? { payload: { reason: 'scope_remote_delete' } } : {}),
      ...(changed === 'sequence' ? { sequence: f.queued.sequence + 1 } : {}) };
    const impostor = { ...f.queued, payload,
      opId: changed === 'opId' ? 'ab.unknown' : f.queued.opId,
      sequence: changed === 'sequence' ? f.queued.sequence + 1 : f.queued.sequence,
      digest: changed === 'digest' ? 'sha256:changed' : digestJson(payload) };
    await expect(guard(impostor)).rejects.toThrow('upload_boundary_unavailable');
    expect(await syncState.getQueueByOpId(scope, f.queued.opId)).toEqual(f.queued);
    expect(await syncState.getQueueReceipt(scope, f.queued.sequence)).toBeNull();
    expect(f.sent).toHaveLength(2);
  });

test('a real advanced source moved under private content remains excluded even with its selected destination', async () => {
  const f = await advancedFixture(true);
  await executeActiveAdvancedPlan(syncState, scope, chrome.bookmarks as AdvancedNativeApi);
  const queued = (await syncState.listQueue(scope))[0]!;
  await syncState.configureBrowserRoots(scope, { discovered: [
    { nativeId: '1', ancestorNativeIds: [] }, { nativeId: '2', ancestorNativeIds: [] },
  ], selectedNativeIds: [], privateNativeIds: ['2'], status: 'ready' });
  const bar = tree[0]!.children![0]!, other = tree[0]!.children![1]!;
  const moved = bar.children![0]!;
  tree = [{ ...tree[0]!, children: [{ ...bar, children: bar.children!.slice(1) },
    { ...other, children: [...other.children!, { ...moved, parentId: '2' }] }] }];
  await expect(guard(queued)).rejects.toThrow('queued_upload_excluded');
  expect(await createOutboundPushWorker(f.workerOptions).drain()).toMatchObject({ outcome: 'rejected' });
  expect(f.sent).toEqual([]);
  expect((await chrome.bookmarks.get('10'))[0]!.parentId).toBe('2');
});

function manifest() {
  return { protocol: 'https://know-n.com/colp/spec/0.2', protocolVersions: ['0.2'], serverId: scope.serverOrigin,
    serverUuid: 'advanced-server', title: 'Advanced server', syncEffectPages: `${scope.serverOrigin}/effects/{effectId}/pages/{pageNumber}`,
    mounts: [{ id: 'bookmarks', baseUrl: scope.serverOrigin, profiles: ['bookmarks'], auth: { oauth: true }, limits: {}, features: {},
      endpoints: { syncSessions: `${scope.serverOrigin}/v1/sessions`, syncSnapshot: `${scope.serverOrigin}/v1/snapshot`,
        syncPush: `${scope.serverOrigin}/v1/push`, syncPull: `${scope.serverOrigin}/v1/pull`, syncAck: `${scope.serverOrigin}/v1/ack`,
        syncConflict: `${scope.serverOrigin}/conflicts/{conflictId}` },
      'https://known.example/extensions/sync-retire': { method: 'DELETE', requestBody: false, successStatus: 204,
        requiredHeaders: ['Authorization', 'Origin', 'Known-Sync-Session', 'Idempotency-Key'], href: `${scope.serverOrigin}/v1/retire` } }],
  };
}
