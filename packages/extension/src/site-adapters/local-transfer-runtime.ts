import { bindUnownedLocalTransfers } from './local-unbound-transfers.js';
import { createLocalTransferQueue } from './local-transfer-queue.js';
import { siteLedger } from './source-runtime.js';
import { get, put } from './source-db.js';
import { assertTransferCurrent } from './local-transfer-authority.js';
import { registerLocalTransfer } from './local-registration-runtime.js';
export { registerLocalTransfer } from './local-registration-runtime.js';
import { currentSyncScope } from '../sw/scope.js';
import { syncState } from '../sw/runtime.js';
import { scheduleSourceAlarm } from './wake-scheduler.js';
const run = createLocalTransferQueue(siteLedger.db, { register: registerLocalTransfer, schedule: scheduleSourceAlarm,
  async attach(tx, transfer, reference) {
    const { projection, ...shared } = reference;
    const stores = transfer.slot.kind === 'folder' ? ['folderReservations'] as const : transfer.slot.copy.purpose === 'semantic'
      ? ['representations', 'contentBindings'] as const : ['representations'] as const;
    for (const name of stores) {
      const store = tx.objectStore(name), request = store.index('nativeId').openCursor(IDBKeyRange.only(transfer.native.nativeId));
      await new Promise<void>((resolve, reject) => {
        request.onerror = () => reject(request.error); request.onsuccess = () => { const cursor = request.result; if (!cursor) return resolve();
          const row = cursor.value;
          const sameRole = transfer.slot.kind === 'folder' || row.purpose === transfer.slot.copy.purpose
            && (transfer.slot.copy.purpose !== 'sourceArchive' || row.sourceCollectionId === transfer.slot.copy.sourceCollectionId);
          if (sameRole && row.native?.dateAdded === transfer.native.dateAdded && row.native.deviceId === transfer.native.deviceId) {
            const replacement = projection && !['suppressed', 'detached'].includes(transfer.state) && !['suppressed', 'detached', 'blocked'].includes(row.state)
              ? { native: projection.native, ...(name === 'contentBindings' ? { parentId: projection.parentId, title: projection.title, url: projection.url }
                : name === 'representations' ? { lastWritten: { parentId: projection.parentId, title: projection.title, url: projection.url } } : { nativeTitle: projection.title }) } : {};
            cursor.update({ ...row, ...replacement, shared });
          }
          cursor.continue();
        };
      });
    }
    // Persist the receipt for recovery tools; native success never waits for it.
    const key = `localShared:${transfer.commandId}`;
    if (!await get(tx, 'meta', key)) put(tx, 'meta', key, shared);
    if (projection) put(tx, 'meta', `localConverged:${transfer.commandId}`, { original: transfer.native, projection, shared });
  },
});
let running: Promise<void> | undefined;
export function flushLocalTransfers() {
  return running ??= (async () => {
    const scope = await currentSyncScope().catch(() => null);
    if (scope) await bindUnownedLocalTransfers(siteLedger.db, { schedule: scheduleSourceAlarm, ownerFor: async local => {
      const owner = { serverOrigin: scope.serverOrigin, accountId: scope.accountId, collectionId: scope.collectionId };
      const { native } = await assertTransferCurrent({ ...local, owner });
      const mapping = await syncState.getMappingByNativeId(scope, native.id);
      return mapping && !mapping.quarantine && !mapping.colpId.startsWith('pending-') ? owner : null;
    } });
    await run();
  })().finally(() => { running = undefined; });
}
