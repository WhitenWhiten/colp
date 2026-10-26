import 'fake-indexeddb/auto';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { afterEach, expect, test, vi } from 'vitest';
import { createSourceDatabase, sourceKey } from '../src/site-adapters/source-db.js';
import { assertReconcileOwnershipRecords } from '../src/site-adapters/reconcile-ownership.js';
import { writeReconcileData, readReconcilePage } from '../src/site-adapters/reconcile-storage.js';
import { createReconcileRuns } from '../src/site-adapters/reconcile-run.js';
import type { ReconcilePreview } from '../src/site-adapters/reconcile-model.js';

const native = { nativeId: 'bookmark', dateAdded: 1, deviceId: 'device', bindingId: 'proof', kind: 'bookmark' as const, proof: { kind: 'writeReceipt' as const, id: 'receipt' } };
const row = { id: 'row', itemId: null, collectionId: 'saved', kind: 'personal' as const, title: 'Title', choices: ['keep', 'move'] as const };
const preview: ReconcilePreview = { version: 1, id: 'preview', importId: 'import', digest: 'digest', createdAt: 1, policyRevision: 1,
  context: { connectionId: 'source', installationGeneration: 1, sourceSessionGeneration: 1, documentId: 'doc', tabId: 1, routeEpoch: 0, leaseId: 'lease' },
  differences: [row], snapshots: [] };
const scope = { serverOrigin: 'https://sync.test', accountId: 'owner', collectionId: 'library', authorityGeneration: 1 };
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

test('ownership checks use affected native indexes and detect newly acquired semantic ownership', async () => {
  const db = createSourceDatabase(new IDBFactory());
  try {
    await db.open();
    vi.stubGlobal('chrome', { bookmarks: { getSubTree: async () => [{ id: native.nativeId, title: 'Title', dateAdded: 1, url: 'https://posts.test/one' }] } });
    const scan = vi.spyOn(IDBObjectStore.prototype, 'openCursor');
    await assertReconcileOwnershipRecords(db, 'source', row, native.nativeId);
    expect(scan).not.toHaveBeenCalled();
    await db.transaction(['contentBindings'], 'readwrite', async tx => { tx.objectStore('contentBindings').put({ native, state: 'active' }, 'new-owner'); });
    await expect(assertReconcileOwnershipRecords(db, 'source', row, native.nativeId)).rejects.toThrow('source_copy_protected');
    expect(scan).not.toHaveBeenCalled();
  } finally { await db.close(); }
});
test('status reads one visible page and keeps global counts without transferring source snapshots', async () => {
  const db = createSourceDatabase(new IDBFactory());
  try {
    const differences = Array.from({ length: 500 }, (_, i) => ({ ...row, id: String(i), kind: i < 250 ? 'present' as const : 'personal' as const }));
    await writeReconcileData(db, 'preview', { ...preview, differences });
    const read = vi.spyOn(db, 'read');
    const page = await readReconcilePage(db, 'preview', 100);
    expect(page?.differences).toHaveLength(100); expect(page?.differences[0]?.id).toBe('350');
    expect(page?.page).toEqual({ offset: 100, next: 200, total: 250, counts: { present: 250, personal: 250 } });
    expect(read).toHaveBeenCalledTimes(2);
  } finally { await db.close(); }
});
test('operation checkpoints do not rewrite a retained preview or unchanged operations', async () => {
  const db = createSourceDatabase(new IDBFactory());
  try {
    const runs = createReconcileRuns(db, { authorize: async () => {}, prepare: async () => ({ command: 'move' }),
      execute: async () => ({ receipt: 'saved' }), finish: async () => {}, schedule() {} });
    const differences = Array.from({ length: 200 }, (_, i) => ({ ...row, id: String(i) }));
    await runs.approve({ ...preview, differences }, scope, differences.map(d => ({ id: d.id, choice: 'move', destinationId: 'history' })));
    const put = vi.spyOn(IDBObjectStore.prototype, 'put'), get = vi.spyOn(IDBObjectStore.prototype, 'get'); await runs.wake();
    expect(get.mock.calls.filter(([key]) => String(key).startsWith('["reconcileOperation",'))).toHaveLength(10);
    const operationWrites = put.mock.calls.filter(([, key]) => String(key).startsWith('["reconcileOperation",'));
    expect(operationWrites.length).toBeLessThanOrEqual(40);
    expect(put.mock.calls.some(([, key]) => String(key).includes('reconcileRunPreview:'))).toBe(false);
    expect(await db.read('meta', sourceKey('reconcileOperation', preview.id, 10))).toMatchObject({ state: 'pending' });
    expect((await runs.view(preview.id, ['0', '150']))?.operations).toHaveLength(2);
    expect((await runs.view(preview.id))?.progress).toMatchObject({ completed: 10, pending: 190 });
  } finally { await db.close(); }
});
