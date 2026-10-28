import { cursorPage } from '../sync-state/idb.js';
import { get, put, sourceDigest, type SourceDatabase } from './source-db.js';
import { localTransferKey, type LocalCopyTransfer } from './local-identity.js';
import { managedLibraryKey, type ManagedLibrary } from './copy-identity.js';
/** User-selected Sync mappings prove a new transport binding; the original local-only record stays immutable. */
export async function bindUnownedLocalTransfers(db: SourceDatabase, ports: {
  ownerFor(transfer: LocalCopyTransfer): Promise<ManagedLibrary | null>;
  schedule(at: number): void; now?(): number;
}) {
  const now = ports.now ?? Date.now;
  const ready = await db.transaction(['unboundTransfers'], 'readonly', tx => cursorPage<LocalCopyTransfer>(
    tx.objectStore('unboundTransfers').index('dueAt'), IDBKeyRange.upperBound(now()), 20));
  if (ready.length) ports.schedule(now() + 30000);
  for (const local of ready) {
    let owner: ManagedLibrary | null = null, gone = false;
    try { owner = await ports.ownerFor(local); }
    catch (error) { gone = error instanceof Error && ['sourceCopySuppressed', 'sourceCopyDetached'].includes(error.message); }
    await db.transaction(['meta', 'transfers', 'unboundTransfers'], 'readwrite', async tx => {
      const current = await get<LocalCopyTransfer>(tx, 'meta', localTransferKey(local.commandId));
      if (!current || current.state === 'suppressed' || current.state === 'detached'
        || !await get(tx, 'unboundTransfers', local.commandId)) return;
      if (owner) {
        const commandId = `local-bound:${sourceDigest({ commandId: local.commandId, owner }).slice(7)}`;
        const key = localTransferKey(commandId), old = await get<LocalCopyTransfer>(tx, 'meta', key);
        if (!old) {
          const transfer: LocalCopyTransfer = { ...local, commandId, owner, ownerKey: managedLibraryKey(owner), state: 'pending', updatedAt: now() };
          put(tx, 'meta', key, transfer); put(tx, 'transfers', commandId, { ...transfer, attempts: 0, dueAt: 0 });
          put(tx, 'meta', `localOwnerBinding:${local.commandId}`, { commandId });
        }
      }
      if (owner || gone) tx.objectStore('unboundTransfers').delete(local.commandId);
      else put(tx, 'unboundTransfers', local.commandId, { ...local, dueAt: now() + 60000 });
    });
  }
  const next = await db.transaction(['unboundTransfers'], 'readonly', async tx => (await cursorPage<LocalCopyTransfer & { dueAt: number }>(tx.objectStore('unboundTransfers').index('dueAt'), null, 1))[0]);
  if (next) ports.schedule(Math.max(now() + 1000, next.dueAt));
}
