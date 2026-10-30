import { queueManagedChange } from './managed-changes.js';
import { cursorPage } from '../sync-state/idb.js';
import { get, put, type SourceDatabase } from './source-db.js';
import { localTransferKey, type LocalCopyTransfer } from './local-identity.js';
import type { ManagedReference } from './managed-client.js';
export interface PendingLocalTransfer extends LocalCopyTransfer { dueAt: number; attempts: number }
export interface LocalTransferRegistration extends ManagedReference {
  projection?: { native: import('./contracts.js').NativeBinding; parentId: string; title: string; url: string | null };
}
export function createLocalTransferQueue(db: SourceDatabase, ports: {
  register(transfer: LocalCopyTransfer): Promise<LocalTransferRegistration>;
  attach?(tx: IDBTransaction, transfer: LocalCopyTransfer, reference: LocalTransferRegistration): Promise<void>;
  schedule(at: number): void; now?(): number;
}) {
  const now = ports.now ?? Date.now;
  return async () => {
    const ready = await db.transaction(['transfers'], 'readwrite', async tx => {
      const rows = await cursorPage<PendingLocalTransfer>(tx.objectStore('transfers').index('dueAt'), IDBKeyRange.upperBound(now()), 10);
      for (const row of rows) put(tx, 'transfers', row.commandId, { ...row, dueAt: now() + 30000 });
      return rows;
    });
    if (ready.length) ports.schedule(now() + 30000);
    for (const transfer of ready) {
      try {
        const reference = await ports.register(transfer);
        await db.transaction(['meta', 'transfers', 'representations', 'folderReservations', 'contentBindings', 'mounts', 'itemReservations'], 'readwrite', async tx => {
          const current = await get<LocalCopyTransfer>(tx, 'meta', localTransferKey(transfer.commandId));
          if (!current || current.native.nativeId !== transfer.native.nativeId || current.native.dateAdded !== transfer.native.dateAdded) throw Error('localReceiptChanged');
          await ports.attach?.(tx, current, reference);
          const closed = current.state === 'suppressed' || current.state === 'detached' ? current.state : undefined;
          if (closed) await queueManagedChange(tx, reference, closed);
          put(tx, 'meta', localTransferKey(transfer.commandId), { ...current, state: closed ?? 'registered', updatedAt: now(), associatedAt: now(), reason: undefined });
          tx.objectStore('transfers').delete(transfer.commandId);
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : 'sourceSyncPending';
        const attention = ['sourceCopyDetached', 'sourceCopySuppressed', 'semanticBindingNeedsReview', 'sourceDestinationMigrationRequired', 'source_copy_adoption_conflict', 'source_copy_convergence_review', 'source_copy_protected', 'source_mapping_migration_required', 'sourceSyncInvalid', 'sourceSyncUpgradeRequired'].includes(reason);
        await db.transaction(['meta', 'transfers'], 'readwrite', async tx => {
          const current = await get<LocalCopyTransfer>(tx, 'meta', localTransferKey(transfer.commandId));
          const closed = current?.state === 'suppressed' || current?.state === 'detached' ? current.state : undefined;
          if (current) put(tx, 'meta', localTransferKey(transfer.commandId), { ...current, state: closed ?? (attention ? 'attention' : 'pending'), reason, updatedAt: now() });
          if (closed) { tx.objectStore('transfers').delete(transfer.commandId); return; }
          if (attention) put(tx, 'transfers', transfer.commandId, { ...transfer, state: 'attention', reason, dueAt: Number.MAX_SAFE_INTEGER });
          else put(tx, 'transfers', transfer.commandId, { ...transfer, dueAt: now() + 30000, attempts: transfer.attempts + 1, reason });
        });
      }
    }
    const next = await db.transaction(['transfers'], 'readonly', async tx => (await cursorPage<PendingLocalTransfer>(tx.objectStore('transfers').index('dueAt'), null, 1))[0]);
    if (next && next.dueAt < Number.MAX_SAFE_INTEGER) ports.schedule(Math.max(now() + 1000, next.dueAt));
  };
}
/** An explicit user retry changes derived work only, retaining the original owner and command identity. */
export async function retryLocalTransfers(db: SourceDatabase, connectionId: string, commandId?: string) {
  await db.transaction(['transfers', 'meta'], 'readwrite', async tx => {
    const selected = commandId ? await get<PendingLocalTransfer>(tx, 'transfers', commandId) : undefined;
    const rows = commandId ? selected?.connectionId === connectionId && selected.state === 'attention' ? [selected] : []
      : await cursorPage<PendingLocalTransfer>(tx.objectStore('transfers').index('connectionState'), IDBKeyRange.only([connectionId, 'attention']), 50);
    for (const row of rows) {
      put(tx, 'transfers', row.commandId, { ...row, state: 'pending', dueAt: 0 });
      const record = await get<LocalCopyTransfer>(tx, 'meta', localTransferKey(row.commandId));
      if (record) put(tx, 'meta', localTransferKey(row.commandId), { ...record, state: 'pending' });
    }
  });
}
