import { managedLibraryKey } from './copy-identity.js';
import { managedSlotKey } from './managed-saves.js';
import type { ManagedDestination, ManagedReference, ManagedSaveReceipt } from './managed-client.js';
import { get, put } from './source-db.js';
export async function managedReference(tx: IDBTransaction, managed?: ManagedDestination): Promise<ManagedReference | undefined> {
  if (!managed) return;
  const receipt = await get<ManagedSaveReceipt>(tx, 'meta', `managedReceipt:${managedLibraryKey(managed.library)}:${managed.command.commandId}`);
  if (!receipt) throw new Error('sourceSyncPending');
  return { library: managed.library, slot: managed.command.slot, nodeId: receipt.node.nodeId, controlRevision: receipt.controlRevision ?? 0 };
}
export async function queueManagedChange(tx: IDBTransaction, reference: ManagedReference | undefined, state: 'detached' | 'suppressed') {
  if (!reference) return;
  const key = `managedManual:${managedLibraryKey(reference.library)}:${managedSlotKey(reference.library.collectionId, reference.slot)}`;
  const old = await get<{ state: string }>(tx, 'meta', key);
  put(tx, 'meta', key, { reference, state: old?.state === 'suppressed' ? 'suppressed' : state });
}
