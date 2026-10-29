import { iterateCursorSequentially, requestValue } from '../sync-state/idb.js';
import { get, put, type SourceDatabase } from './source-db.js';
import { authorityForConnection } from './ledger.js';
import type { SourcePolicyRecord } from './layout.js';
import type { ObservationRow } from './ledger-types.js';
import type { SourceWork } from './work-queue.js';
import type { SourceOutbox, StoredSavePlan } from './planned-types.js';
import type { SourceFolderReservation } from './contracts.js';
/** Explicit retry may reopen a failed observation, but never grants a new account/generation authority. */
export async function retrySourceObservations(db: SourceDatabase, connectionId: string) {
  await db.transaction(['work', 'observations', 'authorities', 'meta', 'savePlans', 'outbox', 'folderReservations'], 'readwrite', async tx => {
    const authority = await authorityForConnection(tx, connectionId), policy = await get<SourcePolicyRecord>(tx, 'meta', `policy:${connectionId}`);
    if (!authority?.enabled || !policy?.enabled || !policy.liveArchive) return;
    // Scan past ineligible entries too; a prefix of old plans must not hide later observations.
    await iterateCursorSequentially(tx.objectStore('work').index('connectionDue'), IDBKeyRange.only([connectionId, Number.MAX_SAFE_INTEGER]), async value => {
      const work = value as SourceWork;
      const plan = work.id.startsWith('observation:') ? undefined : await get<StoredSavePlan>(tx, 'savePlans', work.id);
      if (plan && (plan.state !== 'approved' || plan.plan.trigger.kind !== 'observation')) return;
      const id = work.id.startsWith('observation:') ? work.id.slice('observation:'.length)
        : plan?.plan.trigger.kind === 'observation' ? plan.plan.trigger.observationId : undefined;
      const row = id ? await get<ObservationRow>(tx, 'observations', id) : undefined;
      if (!row || row.context.installationGeneration !== authority.installationGeneration || row.context.sourceSessionGeneration !== authority.sourceSessionGeneration
        || row.context.connectionId !== connectionId || row.ordinal <= (policy.admittedAfterOrdinal ?? 0)) return;
      put(tx, 'observations', row.id, { ...row, state: 'pending', readyAt: 0, retryRevision: (row.retryRevision ?? 0) + 1 });
      tx.objectStore('work').delete(work.id);
      // Unsent plans are replaced by the planner. Previously issued commands must retain their recovery work.
      for (const effect of plan?.plan.effects ?? []) {
        const folder = effect.kind === 'ensureSourceFolder'
          ? await requestValue<SourceFolderReservation | undefined>(tx.objectStore('folderReservations').index('id').get(effect.reservationId)) : undefined;
        const outbox = await get<SourceOutbox>(tx, 'outbox', folder?.commandId ?? effect.commandId);
        if (outbox && outbox.state !== 'reserved' && !outbox.executorAcknowledged) {
          put(tx, 'work', work.id, { ...work, dueAt: 0 }); break;
        }
      }
    });
    put(tx, 'meta', 'pendingObservations', await requestValue(tx.objectStore('observations').index('state').count('pending')));
  });
}
