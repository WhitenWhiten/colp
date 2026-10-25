import type { SourceDatabase } from './source-db.js';
import { cursorPage } from '../sync-state/idb.js';
import type { SourceMount } from './layout.js';
import type { SourceFolderReservation } from './contracts.js';
/** Includes proven collection folders moved away from a root, plus dedicated reconciliation history. */
export async function managedDestinations(db: SourceDatabase): Promise<SourceMount[]> {
  return db.transaction(['mounts', 'folderReservations', 'meta'], 'readonly', async tx => {
    const mounts = await cursorPage<SourceMount>(tx.objectStore('mounts'), null, 10001);
    const folders = await cursorPage<SourceFolderReservation>(tx.objectStore('folderReservations'), null, 10001);
    const history = await cursorPage<SourceMount>(tx.objectStore('meta'), IDBKeyRange.bound('reconcileHistory:', 'reconcileHistory:\uffff'), 10001);
    if (mounts.length + folders.length + history.length > 10000) throw new Error('destination_policy_capacity');
    const parent = new Map(mounts.map(m => [m.id, m]));
    return [...mounts, ...history, ...folders.flatMap(f => f.native && parent.has(f.mountId) ? [{ ...parent.get(f.mountId)!, id: `folder:${f.id}`, root: f.native, state: 'suppressed' as const }] : [])];
  });
}
