import { createLocalTransferQueue } from './local-transfer-queue.js';
import { siteLedger } from './source-runtime.js';
import { sourceDigest, get, put } from './source-db.js';
import { managedLibraryKey } from './copy-identity.js';
import { managedClientForLibrary } from './managed-runtime.js';
import { assertManagedReceipt } from './managed-saves.js';
import type { ManagedReference, ManagedSaveCommand, ManagedSaveReceipt } from './managed-client.js';
import type { LocalCopyTransfer } from './local-identity.js';
import { currentSyncScope } from '../sw/scope.js';
import { syncState } from '../sw/runtime.js';
import { scheduleSourceAlarm } from './wake-scheduler.js';
async function register(transfer: LocalCopyTransfer): Promise<ManagedReference> {
  if (!transfer.owner) throw Error('sourceSyncOwnerChanged');
  const scope = await currentSyncScope();
  if (managedLibraryKey(scope) !== managedLibraryKey(transfer.owner)) throw Error('sourceSyncOwnerChanged');
  const native = (await chrome.bookmarks.get(transfer.native.nativeId).catch(() => []))[0];
  if (!native) throw Error('sourceCopySuppressed');
  if (native.dateAdded !== transfer.native.dateAdded || native.parentId !== transfer.parent.nativeId || native.title !== transfer.title
    || (native.url ?? null) !== transfer.url) throw Error('sourceCopyDetached');
  const [mapping, parent] = await Promise.all([syncState.getMappingByNativeId(scope, native.id), syncState.getMappingByNativeId(scope, transfer.parent.nativeId)]);
  if (!mapping || !parent || mapping.quarantine || parent.quarantine || mapping.colpId.startsWith('pending-') || parent.colpId.startsWith('pending-')) throw Error('sourceSyncPending');
  // Ordinary Sync has already created this exact canonical node. This request may only adopt it.
  const candidate: ManagedSaveCommand = { commandId: `local-adopt:${sourceDigest({ owner: transfer.owner, command: transfer.commandId, node: mapping.colpId }).slice(7)}`,
    replicaId: scope.replicaId, collectionId: scope.collectionId, parentId: parent.colpId, parentRevision: parent.projection.resourceRevision ?? parent.projection.revision,
    slot: transfer.slot, ...(transfer.copyPolicy ? { copyPolicy: transfer.copyPolicy } : {}), title: transfer.title, url: transfer.url,
    adopt: { nodeId: mapping.colpId, revision: mapping.projection.resourceRevision ?? mapping.projection.revision } };
  const key = `localAdoptCommand:${candidate.commandId}`, old = await siteLedger.db.read<ManagedSaveCommand>('meta', key), command = old ?? candidate;
  if (!old) await siteLedger.db.transaction(['meta'], 'readwrite', async tx => put(tx, 'meta', key, candidate));
  const client = await managedClientForLibrary(transfer.owner); await client.profile();
  const receipt = await client.call<ManagedSaveReceipt>('managed.save', command);
  assertManagedReceipt(receipt, command);
  if (receipt.node.nodeId !== command.adopt!.nodeId) throw Error('source_copy_adoption_conflict');
  if (receipt.disposition === 'suppressed' || receipt.disposition === 'detached') throw Error(receipt.disposition === 'suppressed' ? 'sourceCopySuppressed' : 'sourceCopyDetached');
  return { library: transfer.owner, slot: transfer.slot, nodeId: receipt.node.nodeId, controlRevision: receipt.controlRevision ?? 0 };
}
const run = createLocalTransferQueue(siteLedger.db, { register, schedule: scheduleSourceAlarm,
  async attach(tx, transfer, reference) {
    const stores = transfer.slot.kind === 'folder' ? ['folderReservations'] as const : transfer.slot.copy.purpose === 'semantic'
      ? ['representations', 'contentBindings'] as const : ['representations'] as const;
    for (const name of stores) {
      const store = tx.objectStore(name), request = store.index('nativeId').openCursor(IDBKeyRange.only(transfer.native.nativeId));
      await new Promise<void>((resolve, reject) => {
        request.onerror = () => reject(request.error); request.onsuccess = () => { const cursor = request.result; if (!cursor) return resolve();
          const row = cursor.value;
          const sameRole = transfer.slot.kind === 'folder' || row.purpose === transfer.slot.copy.purpose
            && (transfer.slot.copy.purpose !== 'sourceArchive' || row.sourceCollectionId === transfer.slot.copy.sourceCollectionId);
          if (sameRole && row.native?.dateAdded === transfer.native.dateAdded && row.native.deviceId === transfer.native.deviceId)
            cursor.update({ ...row, shared: reference });
          cursor.continue();
        };
      });
    }
    // Persist the receipt for recovery tools; native success never waits for it.
    const key = `localShared:${transfer.commandId}`;
    if (!await get(tx, 'meta', key)) put(tx, 'meta', key, reference);
  },
});
let running: Promise<void> | undefined;
export function flushLocalTransfers() { return running ??= run().finally(() => { running = undefined; }); }
