import { requestValue } from '../sync-state/idb.js';
import { get, put, sourceKey } from './source-db.js';
import { managedLibraryKey, sameDestinationOwner } from './copy-identity.js';
import { representationKey, type ItemReservation } from './reservations.js';
import type { LocalCopyTransfer } from './local-identity.js';
import type { LocalTransferRegistration } from './local-transfer-queue.js';
import type { SourceMount } from './layout.js';
import type { Representation } from './contracts.js';
/** Ordinary Sync has proven the owner. Update derived role indexes, preserving original save/transfer receipts. */
export async function attachLocalAssociation(tx: IDBTransaction, transfer: LocalCopyTransfer, registration: LocalTransferRegistration) {
  const { projection, ...shared } = registration, scopeId = managedLibraryKey(shared.library);
  if (!sameDestinationOwner(transfer.owner, shared.library)) throw Error('sourceSyncOwnerChanged');
  const stores = transfer.slot.kind === 'folder' ? ['folderReservations'] as const : transfer.slot.copy.purpose === 'semantic'
    ? ['representations', 'contentBindings'] as const : ['representations'] as const;
  for (const name of stores) {
    const store = tx.objectStore(name), index = store.index('nativeId');
    const [rows, keys] = await Promise.all([requestValue(index.getAll(transfer.native.nativeId, 1001)), requestValue(index.getAllKeys(transfer.native.nativeId, 1001))]);
    if (rows.length > 1000) throw Error('capacity');
    for (const [i, row] of rows.entries()) {
      const sameRole = transfer.slot.kind === 'folder' || row.purpose === transfer.slot.copy.purpose
        && (transfer.slot.copy.purpose !== 'sourceArchive' || row.sourceCollectionId === transfer.slot.copy.sourceCollectionId);
      if (!sameRole || row.native?.dateAdded !== transfer.native.dateAdded || row.native.deviceId !== transfer.native.deviceId) continue;
      const replacement = projection && !['suppressed', 'detached'].includes(transfer.state) && !['suppressed', 'detached', 'blocked'].includes(row.state)
        ? { native: projection.native, ...(name === 'contentBindings' ? { parentId: projection.parentId, title: projection.title, url: projection.url }
          : name === 'representations' ? { lastWritten: { parentId: projection.parentId, title: projection.title, url: projection.url } } : { nativeTitle: projection.title }) } : {};
      const next = { ...row, ...replacement, shared, ...(name === 'folderReservations' ? {} : { scopeId }), ...(name === 'contentBindings' ? { scopeVersion: 2 } : {}) };
      const key = name === 'representations' ? representationKey(next) : keys[i]!;
      if (key !== keys[i]) {
        const existing = await get<Representation>(tx, 'representations', key);
        if (existing && (existing.native.nativeId !== next.native.nativeId || existing.native.dateAdded !== next.native.dateAdded || existing.state !== next.state)) throw Error('semanticBindingNeedsReview');
        const reservation = await get<ItemReservation>(tx, 'itemReservations', keys[i]!);
        if (reservation?.state === 'confirmed') {
          const target = await get<ItemReservation>(tx, 'itemReservations', key);
          if (target && target.commandId !== reservation.commandId) throw Error('semanticBindingNeedsReview');
          tx.objectStore('itemReservations').delete(keys[i]!);
          put(tx, 'itemReservations', key, { ...reservation, representation: { ...reservation.representation, scopeId } });
        }
        store.delete(keys[i]!);
      }
      store.put(next, key);
      if (name === 'folderReservations') {
        const mounts = await requestValue(tx.objectStore('mounts').index('id').getAll(row.mountId, 1001)) as SourceMount[];
        if (mounts.length > 1000) throw Error('capacity');
        for (const mount of mounts) {
          if (mount.destination && !sameDestinationOwner(mount.destination, shared.library)) throw Error('sourceDestinationMigrationRequired');
          if (mount.destination !== null || mount.state !== 'active' || mount.root.deviceId !== transfer.parent.deviceId
            || mount.root.nativeId !== transfer.parent.nativeId || mount.root.dateAdded !== transfer.parent.dateAdded) continue;
          // Transport adoption changes neither the selected native root nor its placement authority revision.
          put(tx, 'mounts', sourceKey(mount.connectionId, mount.rootRuleId), { ...mount, destination: shared.library });
          put(tx, 'meta', `localMountOwnerBinding:${mount.id}`, { root: mount.root, owner: shared.library, commandId: transfer.commandId });
        }
      }
    }
  }
  const key = `localShared:${transfer.commandId}`;
  if (!await get(tx, 'meta', key)) put(tx, 'meta', key, shared);
  if (projection) put(tx, 'meta', `localConverged:${transfer.commandId}`, { original: transfer.native, projection, shared });
}
