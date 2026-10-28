import { requestValue } from '../sync-state/idb.js';
import { managedLibraryKey, type ManagedLibrary } from './copy-identity.js';
import { managedSlotKey } from './managed-saves.js';
import type { ManagedBinding } from './managed-client.js';
import type { NativeBinding } from './contracts.js';
import type { SourceDatabase } from './source-db.js';
/** Refresh an existing role after a proven remote host move; never adopt a lookalike or override local opt-outs. */
export async function refreshSharedProjection(db: SourceDatabase, library: ManagedLibrary, binding: ManagedBinding,
  projection: { native: NativeBinding; parentId: string }) {
  if (binding.state !== 'active' || binding.collectionId !== library.collectionId) return;
  await db.transaction(['representations', 'contentBindings', 'folderReservations'], 'readwrite', async tx => {
    for (const name of ['representations', 'contentBindings', 'folderReservations'] as const) {
      const store = tx.objectStore(name), index = store.index('nativeId');
      const [rows, keys] = await Promise.all([requestValue(index.getAll(projection.native.nativeId, 1001)), requestValue(index.getAllKeys(projection.native.nativeId, 1001))]);
      if (rows.length > 1000) throw Error('capacity');
      for (const [i, row] of rows.entries()) {
        if (!row.shared || !['active', 'confirmed'].includes(row.state) || row.native?.dateAdded !== projection.native.dateAdded
          || row.native.deviceId !== projection.native.deviceId || row.shared.nodeId !== binding.node.nodeId
          || managedLibraryKey(row.shared.library) !== managedLibraryKey(library)
          || managedSlotKey(library.collectionId, row.shared.slot) !== managedSlotKey(library.collectionId, binding.slot)) continue;
        const written = { parentId: projection.parentId, title: binding.node.title, url: binding.node.url };
        store.put({ ...row, ...(name === 'representations' ? { lastWritten: written } : name === 'contentBindings' ? written : { nativeTitle: binding.node.title }),
          shared: { ...row.shared, controlRevision: binding.controlRevision ?? 0 } }, keys[i]!);
      }
    }
  });
}
