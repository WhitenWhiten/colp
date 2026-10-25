import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { ReconcileRun, ReconcileOperation } from '../src/site-adapters/reconcile-run.js';
import type { ManagedNode } from '../src/site-adapters/managed-client.js';

const mocks = vi.hoisted(() => ({ inventory: vi.fn(), mapping: vi.fn(), call: vi.fn(), get: vi.fn() }));
vi.mock('../src/site-adapters/source-runtime.js', () => ({ siteLedger: { db: {} } }));
vi.mock('../src/site-adapters/content-identity.js', () => ({ readSourceConnection: async () => ({ siteKey: 'fixture.posts', identityVersion: 1, accountId: 'reader' }) }));
vi.mock('../src/site-adapters/registry.js', () => ({ identityDefinition: () => ({ contentIdScope: 'site' }) }));
vi.mock('../src/site-adapters/managed-runtime.js', () => ({ managedSaves: {}, managedClientForLibrary: async () => ({ reconcileProfile: async () => {}, call: mocks.call }), projectManagedBinding: vi.fn() }));
vi.mock('../src/sw/scope.js', () => ({ currentSyncScope: async () => ({ serverOrigin: 'https://sync.test', accountId: 'owner', collectionId: 'library', replicaId: 'replica' }) }));
vi.mock('../src/sw/runtime.js', () => ({ syncState: { getMappingByNativeId: mocks.mapping }, workCoordinator: {} }));
vi.mock('../src/sw/capture-history.js', () => ({ captureDeviceId: async () => 'device' }));
vi.mock('../src/sw/planned-capture.js', () => ({ assertSourceRoot: async () => ({ inRange: true }), executePlannedNative: vi.fn(), recoverPlannedNative: vi.fn() }));
vi.mock('../src/site-adapters/reconcile-projection.js', () => ({ restoreReconcileProjection: vi.fn() }));
vi.mock('../src/bookmark-annotation-store.js', () => ({ createBookmarkAnnotationStore: () => ({ get: async () => null, close() {} }) }));
vi.mock('../src/site-adapters/reconcile-inventory.js', () => ({ reconcileInventory: mocks.inventory, reconcileTreeDigest: vi.fn() }));
vi.mock('../src/sw/capture-native.js', () => ({ assertCaptureOwner: vi.fn() }));
vi.mock('../src/sw/engine.js', () => ({ scheduleSyncEngineWake: vi.fn() }));
import { prepareReconcileCommand } from '../src/site-adapters/reconcile-executor.js';

const parent = { nativeId: 'folder', kind: 'folder' as const, bindingId: 'proof', deviceId: 'device', dateAdded: 1, proof: { kind: 'explicitAdoption' as const, id: 'proof' } };
const candidate = { native: { ...parent, nativeId: 'bookmark', kind: 'bookmark' as const }, title: 'Original', url: 'https://posts.test/one', parentId: 'folder', pinned: false, protected: false };
const slot = { kind: 'bookmark' as const, copy: { purpose: 'sourceArchive' as const, sourceAccount: 'reader', sourceCollectionId: 'saved',
  content: { site: 'fixture.posts', identityVersion: 1, itemId: 'post', accountId: null } } };
const representation = { connectionId: 'source', itemId: 'post', purpose: 'sourceArchive' as const, sourceCollectionId: 'saved', mountId: 'mount', native: candidate.native,
  state: 'active' as const, manualRevision: 0, shared: { library: { serverOrigin: 'https://sync.test', accountId: 'owner', collectionId: 'library' }, slot, nodeId: 'canonical', controlRevision: 0 } };
const op: ReconcileOperation = { id: 'operation', state: 'pending', reason: null, decision: { id: 'title', choice: 'updateTitle' }, difference: {
  id: 'title', collectionId: 'saved', itemId: 'post', kind: 'title', title: 'New title', choices: ['keep', 'updateTitle'], expected: candidate, representation,
  source: { id: 'post', kind: 'post', identity: 'siteId', title: 'New title', url: candidate.url },
} };
const run: ReconcileRun = { id: 'run', state: 'approved', operations: [op], updatedAt: 1,
  scope: { serverOrigin: 'https://sync.test', accountId: 'owner', collectionId: 'library', authorityGeneration: 1 },
  preview: { version: 1, id: 'preview', importId: 'import', digest: 'frozen', createdAt: 1, policyRevision: 1, differences: [op.difference],
    context: { connectionId: 'source', installationGeneration: 1, sourceSessionGeneration: 1, documentId: 'doc', leaseId: 'lease', tabId: 1, routeEpoch: 0 },
    snapshots: [{ collectionId: 'saved', items: [], complete: true, absence: 'unverified', snapshotId: null, reason: null }] },
};
let canonical: ManagedNode, revision: number;
beforeEach(() => {
  canonical = { nodeId: 'canonical', parentId: 'canonical-folder', title: candidate.title, url: candidate.url, revision: 'r1' }; revision = 0;
  mocks.get.mockImplementation(async () => [{ id: 'bookmark', dateAdded: 1, title: candidate.title, url: candidate.url, parentId: 'folder' }]);
  mocks.inventory.mockResolvedValue({ nodes: [candidate], movedFolders: [], representations: [representation] });
  mocks.mapping.mockImplementation(async (_scope, id) => ({ colpId: id === 'bookmark' ? 'canonical' : 'canonical-folder' }));
  mocks.call.mockImplementation(async action => action === 'managed.node' ? { node: canonical } : { binding: { controlRevision: revision } });
  vi.stubGlobal('chrome', { bookmarks: { get: mocks.get } });
});
afterEach(() => vi.unstubAllGlobals());

test('a title choice uses the frozen location and association', async () => {
  expect(await prepareReconcileCommand(run, op, parent, false)).toMatchObject({ mode: 'cloud', input: {
    action: 'rename', parentId: 'canonical-folder', title: 'New title', associationRevision: 0,
  } });
});
test.each(['move', 'delete'] as const)('a remote %s not yet projected locally cannot be overwritten by a title choice', async change => {
  canonical = change === 'move' ? { ...canonical, parentId: 'personal-folder' } : { ...canonical, deleted: true };
  await expect(prepareReconcileCommand(run, op, parent, false)).rejects.toThrow('source_reconcile_conflict');
});
test('a newer association decision on another device invalidates the frozen choice', async () => {
  revision = 1;
  await expect(prepareReconcileCommand(run, op, parent, false)).rejects.toThrow('source_association_changed');
});
