import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, expect, test, vi } from 'vitest';
import { createSourceDatabase, sourceKey } from '../src/site-adapters/source-db.js';
import { representationKey } from '../src/site-adapters/reservations.js';
import type { ReconcileRun, ReconcileOperation, ReconcileRunPorts } from '../src/site-adapters/reconcile-run.js';
import type { Representation, SourceFolderReservation } from '../src/site-adapters/contracts.js';
import { reconcileTreeDigest } from '../src/site-adapters/reconcile-inventory.js';

vi.mock('../src/site-adapters/source-runtime.js', () => ({ siteLedger: { db: null }, SITE_RECOVERY_ALARM: 'recover' }));
vi.mock('../src/site-adapters/reconcile-run.js', () => ({ createReconcileRuns: (_db: unknown, ports: unknown) => ports }));
vi.mock('../src/site-adapters/reconcile-executor.js', () => ({ executeReconcileCommand: vi.fn(), prepareReconcileCommand: vi.fn(), assertReconcileOwnership: vi.fn(), assertReconcileUndoState: vi.fn() }));
vi.mock('../src/sw/capture-native.js', () => ({ assertCaptureOwner: async () => {}, assertCaptureScope: vi.fn(), currentCaptureScope: vi.fn() }));
vi.mock('../src/sw/planned-capture.js', () => ({ assertSourceRoot: vi.fn(), acknowledgePlannedNative: vi.fn() }));
vi.mock('../src/sw/capture-history.js', () => ({ captureDeviceId: async () => 'device' }));
vi.mock('../src/sw/bookmark-folders-first.js', () => ({ scheduleNativeFoldersFirst: vi.fn() }));
vi.mock('../src/bookmark-annotation-store.js', () => ({ createBookmarkAnnotationStore: () => ({ get: async () => null, close() {} }) }));
import { siteLedger } from '../src/site-adapters/source-runtime.js';
import { reconciliationRuns } from '../src/site-adapters/reconcile-runtime.js';

const native = { nativeId: 'bookmark', kind: 'bookmark' as const, bindingId: 'proof', deviceId: 'device', dateAdded: 1, proof: { kind: 'writeReceipt' as const, id: 'proof' } };
const shared = { library: { serverOrigin: 'https://sync.test', accountId: 'owner', collectionId: 'library' }, nodeId: 'canonical', controlRevision: 0,
  slot: { kind: 'bookmark' as const, copy: { purpose: 'sourceArchive' as const, sourceAccount: 'reader', sourceCollectionId: 'saved', content: { site: 'fixture.posts', identityVersion: 1, itemId: 'post', accountId: null } } } };
const old: Representation = { connectionId: 'source', itemId: 'post', sourceCollectionId: 'saved', purpose: 'sourceArchive', mountId: 'mount',
  native, state: 'detached', manualRevision: 1, localTitle: 'My title', lastWritten: { title: 'Source title', parentId: 'folder', url: 'https://posts.test/one' }, shared };
const run = { id: 'run', scope: {}, preview: { context: { connectionId: 'source' } } } as unknown as ReconcileRun;
const finish = (reconciliationRuns as unknown as ReconcileRunPorts).finish;
afterEach(() => vi.unstubAllGlobals());

test.each(['return', 'updateTitle', 'archive'] as const)('undo of %s restores the original association state and personal title', async choice => {
  const db = createSourceDatabase(new IDBFactory()); siteLedger.db = db;
  vi.stubGlobal('chrome', { bookmarks: { get: async () => [{ id: 'bookmark', dateAdded: 1, title: 'My title', parentId: 'personal', url: old.lastWritten!.url }] } });
  try {
    await db.transaction(['representations'], 'readwrite', async tx => { tx.objectStore('representations').put({ ...old, state: 'active', localTitle: undefined }, representationKey(old)); });
    const op = { decision: { choice }, difference: { itemId: old.itemId, collectionId: 'saved', representation: old },
      undoReceipt: { native, written: { title: 'My title', parentId: 'personal', url: old.lastWritten!.url }, cloud: { controlRevision: 2 } }, command: {} } as unknown as ReconcileOperation;
    await finish(run, op, true);
    expect(await db.read('representations', representationKey(old))).toEqual({ ...old, shared: { ...shared, controlRevision: 2 } });
  } finally { await db.close(); }
});
test('folder reconciliation advances the shared fence and undo restores its old location policy', async () => {
  const db = createSourceDatabase(new IDBFactory()); siteLedger.db = db;
  const folder: SourceFolderReservation = { id: 'reservation', commandId: 'create-folder', payloadDigest: 'digest', state: 'blocked', mountId: 'mount', mountRevision: 1, collectionId: 'saved',
    title: 'Saved', parent: { kind: 'native', binding: { ...native, kind: 'folder', nativeId: 'root' } }, native: { ...native, kind: 'folder', nativeId: 'saved' },
    shared: { ...shared, slot: { kind: 'folder', source: { site: 'fixture.posts', identityVersion: 1, sourceAccount: 'reader', sourceCollectionId: 'saved' } } } };
  let parentId = 'root';
  const tree = () => ({ id: 'saved', title: 'Saved', dateAdded: 1, parentId, children: [] });
  vi.stubGlobal('chrome', { bookmarks: { get: async (id: string) => [{ ...tree(), id }], getSubTree: async () => [tree()] } });
  const receipt = { native: folder.native, written: { title: 'Saved', parentId: 'root' }, cloud: { controlRevision: 1 } };
  const op = { id: 'operation', decision: { choice: 'return' }, difference: { folder, expected: {
    title: 'Saved', parentId: 'personal', subtreeDigest: reconcileTreeDigest({ ...tree(), parentId: 'personal' }),
  } }, receipt } as unknown as ReconcileOperation;
  try {
    await db.transaction(['folderReservations'], 'readwrite', async tx => { tx.objectStore('folderReservations').put(folder, sourceKey('mount', 'saved')); });
    await finish(run, op, false);
    expect(await db.read('folderReservations', sourceKey('mount', 'saved'))).toMatchObject({ state: 'confirmed', shared: { controlRevision: 1 }, locationOverride: { nativeId: 'root' } });
    op.undoReceipt = { ...receipt, written: { title: 'Saved', parentId: 'personal' }, cloud: { controlRevision: 2 } };
    parentId = 'personal';
    await finish(run, op, true);
    expect(await db.read('folderReservations', sourceKey('mount', 'saved'))).toEqual({ ...folder, shared: { ...folder.shared, controlRevision: 2 } });
  } finally { await db.close(); }
});
test('finalization cannot replace personal edits made after the durable receipt', async () => {
  const db = createSourceDatabase(new IDBFactory()); siteLedger.db = db;
  vi.stubGlobal('chrome', { bookmarks: { get: async () => [{ id: 'bookmark', dateAdded: 1, title: 'Later personal title', parentId: 'folder', url: old.lastWritten!.url }] } });
  const op = { decision: { choice: 'updateTitle' }, difference: { representation: old },
    receipt: { native, written: { title: 'Approved source title', parentId: 'folder', url: old.lastWritten!.url } } } as unknown as ReconcileOperation;
  try {
    await expect(finish(run, op, false)).rejects.toThrow('source_reconcile_conflict');
  } finally { await db.close(); }
});
