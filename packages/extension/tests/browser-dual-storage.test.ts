import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { expect, test } from 'vitest';
import { createChromeBookmarkTreeAdapter, type ChromeBookmarkNode } from '../src/chrome-bookmark-tree.js';
import { scanBoundary } from '../src/bookmark-boundary.js';
import { browserRootDisplayTitle } from '../src/browser-root-identity.js';
import { createSyncStateStore, type SyncScope } from '../src/sync-state-store.js';
import { matchLocalRemote } from '../src/bootstrap/matcher.js';
import { localFactsFromRoots } from '../src/bootstrap/local-facts.js';
import { createBootstrapCoordinator } from '../src/bootstrap/coordinator.js';

const scope: SyncScope = { environment: 'development', serverId: 'server', serverOrigin: 'https://known.test',
  accountId: 'account', browserProfileId: 'profile', collectionId: 'collection', replicaId: 'replica', generation: 1 };

async function dualRoots(withChildren = false) {
  const children: ChromeBookmarkNode[] = [true, false].map(syncing => {
    const id = syncing ? 'account-bar' : 'local-bar';
    return { id, parentId: '0', title: 'Bookmarks bar', folderType: 'bookmarks-bar', syncing,
      children: withChildren ? [{ id: `${id}-bookmark`, parentId: id, title: `${id} page`,
        url: `https://example.test/${id}` }] : [] };
  });
  return (await createChromeBookmarkTreeAdapter({ getTree: async () => [{ id: '0', title: '', children }],
    getChildren: async () => [], getSubTree: async () => [] }).read()).roots;
}

async function setup() {
  const store = createSyncStateStore({ indexedDB: new IDBFactory() });
  await store.registerScope({ ...scope, lifecycle: 'active',
    lease: { leaseId: 'lease', expiresAt: Date.now() + 60_000 }, checkpoint: null,
    selectedRoots: [], privateRoots: [], rootStatus: 'ready', firstRun: 'none' });
  return store;
}

test('account and local Chrome bars retain storage provenance and independent IndexedDB mounts', async () => {
  const roots = await dualRoots();
  const scan = scanBoundary({ roots, selectedNativeIds: roots.map(row => row.nativeId) });
  expect(roots.map(row => row.syncing)).toEqual([true, false]);
  expect(scan.mounts).toEqual([
    { nativeRootId: 'account-bar', writable: true, materialized: false, rootRole: 'bookmarks-bar' },
    { nativeRootId: 'local-bar', writable: true, materialized: false, customSourceKey: 'folder:local-bar' },
  ]);
  const store = await setup();
  try {
    await store.replaceMountBindings(scope, scan.mounts.map(row => ({ mountId: row.nativeRootId,
      nativeRootId: row.nativeRootId, materialized: row.materialized,
      ...(row.rootRole ? { rootRole: row.rootRole } : { customSourceKey: row.customSourceKey! }),
      remoteMountNodeId: null, status: 'pending', boundaryVersion: '1' })));
    expect(await store.listMountBindings(scope)).toHaveLength(2);
    const reloaded = await store.listMountBindings(scope);
    expect(scanBoundary({ roots: [...roots].reverse(), selectedNativeIds: ['local-bar', 'account-bar'],
      existingMounts: reloaded }).mounts).toEqual([...scan.mounts].reverse());
  } finally { await store.close(); }
});

test('an empty secondary Chrome root has a custom folder fact and distinct create identity', async () => {
  const roots = await dualRoots();
  const selectedNativeIds = roots.map(row => row.nativeId);
  const scan = scanBoundary({ roots, selectedNativeIds });
  const local = localFactsFromRoots(roots, selectedNativeIds);
  expect(local).toEqual([{ nativeId: 'local-bar', mountNativeRootId: 'local-bar', parentNativeId: null,
    kind: 'folder', title: 'Bookmarks bar' }]);
  const report = matchLocalRemote({ scopeKey: 'scope', confirmationId: 'confirm', local, remote: [], mappings: [],
    mounts: scan.mounts.map(row => ({ ...row, remoteMountNodeId: null })),
    rootNodeId: 'canonical-root', bootstrapMode: 'merge' });
  expect(report.planned).toHaveLength(2);
  expect(new Set(report.planned.map(row => row.opId)).size).toBe(2);
  expect(report.planned.map(row => row.nativeId).sort()).toEqual(['account-bar', 'local-bar']);
  expect(report.planned.find(row => row.nativeId === 'local-bar')?.node).toMatchObject({
    kind: 'folder', title: 'Bookmarks bar', folderRole: 'custom' });
});

test('first selection order, root discovery order and later selection changes cannot transfer the role', async () => {
  const roots = await dualRoots();
  for (const ordered of [roots, [...roots].reverse()]) {
    const scan = scanBoundary({ roots: ordered, selectedNativeIds: ['local-bar'] });
    expect(scan.mounts).toEqual([{ nativeRootId: 'local-bar', writable: true, materialized: false,
      customSourceKey: 'folder:local-bar' }]);
    expect(scanBoundary({ roots: ordered, selectedNativeIds: ['account-bar'], existingMounts: scan.mounts }).mounts)
      .toEqual([{ nativeRootId: 'account-bar', writable: true, materialized: false, rootRole: 'bookmarks-bar' }]);
  }
});

test('adding an account root preserves a legacy local role and its existing remote binding', async () => {
  const roots = await dualRoots();
  const existingMounts = [{ nativeRootId: 'local-bar', rootRole: 'bookmarks-bar' as const }];
  const scan = scanBoundary({ roots, selectedNativeIds: roots.map(row => row.nativeId), existingMounts });
  expect(scan.mounts.find(row => row.nativeRootId === 'local-bar')?.rootRole).toBe('bookmarks-bar');
  expect(scan.mounts.find(row => row.nativeRootId === 'account-bar')?.customSourceKey).toBe('folder:account-bar');
  expect(localFactsFromRoots(roots, ['account-bar', 'local-bar'], [], [], existingMounts)
    .map(row => row.nativeId)).toEqual(['account-bar']);
});

test('an absent or detached primary does not promote an existing secondary mount', async () => {
  const roots = await dualRoots();
  const prior = scanBoundary({ roots, selectedNativeIds: roots.map(row => row.nativeId) }).mounts;
  const scan = scanBoundary({ roots: roots.filter(row => row.nativeId === 'local-bar'),
    selectedNativeIds: ['local-bar'], existingMounts: prior });
  expect(scan.mounts[0]?.rootRole).toBeUndefined();
  expect(scan.mounts[0]?.customSourceKey).toBe('folder:local-bar');
});

test('storage flag changes invalidate a preview while preserving the native mount identity', async () => {
  const roots = await dualRoots();
  const selectedNativeIds = roots.map(row => row.nativeId);
  const before = scanBoundary({ roots, selectedNativeIds });
  const after = scanBoundary({ roots: roots.map(row => ({ ...row, syncing: !row.syncing })),
    selectedNativeIds, existingMounts: before.mounts });
  expect(after.treeDigest).not.toBe(before.treeDigest);
  expect(after.mounts).toEqual(before.mounts);
});

test('the picker distinguishes storage provenance without changing canonical title or identity', () => {
  expect(browserRootDisplayTitle('Bookmarks bar', true)).toBe('Bookmarks bar (Browser account)');
  expect(browserRootDisplayTitle('Bookmarks bar', false)).toBe('Bookmarks bar (On this device)');
  expect(browserRootDisplayTitle('Bookmarks bar', undefined)).toBe('Bookmarks bar');
  expect(browserRootDisplayTitle('Bookmarks bar', false, false)).toBe('Bookmarks bar');
});

test('bootstrap receipts and a reconstructed coordinator upload each bar child to its own parent once', async () => {
  const roots = await dualRoots(true);
  const selectedNativeIds = roots.map(row => row.nativeId);
  const scan = scanBoundary({ roots, selectedNativeIds });
  const localFacts = localFactsFromRoots(roots, selectedNativeIds);
  const store = await setup();
  const input = { confirmationId: 'confirm-dual', treeDigest: scan.treeDigest, confirmationVersion: '1',
    localFacts, remoteFacts: [{ nodeId: 'canonical-root', parentId: null, kind: 'folder' as const,
      title: '', folderRole: 'root', revision: 'r0' }],
    mounts: scan.mounts.map(row => ({ ...row, remoteMountNodeId: null })), rootNodeId: 'canonical-root' };
  try {
    const first = await createBootstrapCoordinator({ store, scope }).confirm(input);
    const queuedMounts = await store.listQueue(scope);
    expect(queuedMounts).toHaveLength(2);
    for (const queued of queuedMounts) {
      const nativeId = first.report!.planned.find(row => row.opId === queued.opId)!.nativeId;
      await store.completeQueueWithReceipt(scope, queued.sequence, { opId: queued.opId,
        operationDigest: queued.digest, kind: 'terminal', receiptId: `receipt-${nativeId}`,
        resultDigest: `sha256:${nativeId}`, result: { results: [{ opId: queued.opId, sequence: queued.sequence,
          status: 'applied', targetId: `remote-${nativeId}`, revision: `rev-${nativeId}` }] } });
    }
    const coordinator = createBootstrapCoordinator({ store, scope });
    await coordinator.resume(input);
    const pending = await store.listQueue(scope, 'pending');
    expect(pending).toHaveLength(2);
    for (const row of pending) {
      expect(row.payload.type).toBe('create_node');
      const payload = row.payload.payload as { parentId: string; node: { url: string } };
      const nativeRoot = payload.node.url.split('/').at(-1);
      expect(payload.parentId).toBe(`remote-${nativeRoot}`);
    }
    expect((await store.listMountBindings(scope)).map(row => row.remoteMountNodeId).sort())
      .toEqual(['remote-account-bar', 'remote-local-bar']);
    await coordinator.resume(input);
    expect((await store.listQueue(scope)).map(row => row.opId)).toHaveLength(4);
  } finally { await store.close(); }
});
