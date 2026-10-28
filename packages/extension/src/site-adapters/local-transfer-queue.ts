import { cursorPage } from '../sync-state/idb.js';
import { get, put, type SourceDatabase } from './source-db.js';
import { localTransferKey, type LocalCopyTransfer } from './local-identity.js';
import type { ManagedReference } from './managed-client.js';
export interface PendingLocalTransfer extends LocalCopyTransfer { dueAt: number; attempts: number }
export function createLocalTransferQueue(db: SourceDatabase, ports: {
  register(transfer: LocalCopyTransfer): Promise<ManagedReference>;
  attach?(tx: IDBTransaction, transfer: LocalCopyTransfer, reference: ManagedReference): Promise<void>;
  schedule(at: number): void; now?(): number;
}) {
  const now = ports.now ?? Date.now;
  return async () => {
    const ready = await db.transaction(['transfers'], 'readwrite', async tx => {
      const rows = await cursorPage<PendingLocalTransfer>(tx.objectStore('transfers').index('dueAt'), IDBKeyRange.upperBound(now()), 10);
      for (const row of rows) put(tx, 'transfers', row.commandId, { ...row, dueAt: now() + 30000 });
      return rows;
    });
    for (const transfer of ready) {
      try {
        const reference = await ports.register(transfer);
        await db.transaction(['meta', 'transfers', 'representations', 'folderReservations', 'contentBindings'], 'readwrite', async tx => {
          const current = await get<LocalCopyTransfer>(tx, 'meta', localTransferKey(transfer.commandId));
          if (!current || current.native.nativeId !== transfer.native.nativeId || current.native.dateAdded !== transfer.native.dateAdded) throw Error('localReceiptChanged');
          await ports.attach?.(tx, current, reference);
          put(tx, 'meta', localTransferKey(transfer.commandId), { ...current, state: 'registered', updatedAt: now(), reason: undefined });
          tx.objectStore('transfers').delete(transfer.commandId);
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : 'sourceSyncPending';
        const attention = ['sourceCopyDetached', 'sourceCopySuppressed', 'source_copy_adoption_conflict', 'source_mapping_migration_required', 'sourceSyncInvalid'].includes(reason);
        await db.transaction(['meta', 'transfers'], 'readwrite', async tx => {
          const current = await get<LocalCopyTransfer>(tx, 'meta', localTransferKey(transfer.commandId));
          if (current) put(tx, 'meta', localTransferKey(transfer.commandId), { ...current, state: attention ? 'attention' : 'pending', reason, updatedAt: now() });
          if (attention) tx.objectStore('transfers').delete(transfer.commandId);
          else put(tx, 'transfers', transfer.commandId, { ...transfer, dueAt: now() + 30000, attempts: transfer.attempts + 1, reason });
        });
      }
    }
    const next = await db.transaction(['transfers'], 'readonly', async tx => (await cursorPage<PendingLocalTransfer>(tx.objectStore('transfers').index('dueAt'), null, 1))[0]);
    if (next) ports.schedule(Math.max(now() + 1000, next.dueAt));
  };
}
