import { cursorPage } from '../sync-state/idb.js';
import { get, put, type SourceDatabase } from './source-db.js';
import { localTransferKey, type LocalCopyTransfer } from './local-identity.js';
/** User edits/deletions close pending association work without reviving or deleting a native node. */
export async function settleLocalTransferOwnership(db: SourceDatabase, ids: readonly string[], deleted: boolean,
  lookup: (id: string) => Promise<{ dateAdded?: number; title: string; parentId?: string; url?: string } | null>) {
  const entries = await db.transaction(['transfers', 'unboundTransfers'], 'readonly', async tx => {
    const rows: { store: 'transfers' | 'unboundTransfers'; row: LocalCopyTransfer }[] = [];
    for (const store of ['transfers', 'unboundTransfers'] as const) for (const id of new Set(ids)) {
      const values = await cursorPage<LocalCopyTransfer>(tx.objectStore(store).index('nativeId'), IDBKeyRange.only(id), 1001);
      if (values.length > 1000) throw Error('capacity');
      rows.push(...values.map(row => ({ store, row })));
    }
    return rows;
  });
  for (const { store, row } of entries) {
    const native = deleted ? null : await lookup(row.native.nativeId);
    if (native?.dateAdded === row.native.dateAdded && native.parentId === row.parent.nativeId && native.title === row.title && (native.url ?? null) === row.url) continue;
    const state = !native || native.dateAdded !== row.native.dateAdded ? 'suppressed' : 'detached';
    await db.transaction(['meta', 'transfers', 'unboundTransfers'], 'readwrite', async tx => {
      const current = await get<LocalCopyTransfer>(tx, 'meta', localTransferKey(row.commandId));
      if (current) put(tx, 'meta', localTransferKey(row.commandId), { ...current, state, updatedAt: Date.now() });
      tx.objectStore(store).delete(row.commandId);
    });
  }
}
