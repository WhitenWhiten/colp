import { cursorPage, requestValue } from '../sync-state/idb.js';
import { get, put, type SourceDatabase } from './source-db.js';
import { authorityForConnection } from './ledger.js';
import type { SourcePolicyRecord } from './layout.js';
import type { ObservationRow } from './ledger-types.js';
import type { SourceWork } from './work-queue.js';
/** Explicit retry may reopen a failed observation, but never grants a new account/generation authority. */
export async function retrySourceObservations(db: SourceDatabase, connectionId: string) {
  await db.transaction(['work', 'observations', 'authorities', 'meta'], 'readwrite', async tx => {
    const authority = await authorityForConnection(tx, connectionId), policy = await get<SourcePolicyRecord>(tx, 'meta', `policy:${connectionId}`);
    if (!authority?.enabled || !policy?.enabled || !policy.liveArchive) return;
    const rows = await cursorPage<SourceWork>(tx.objectStore('work').index('connectionDue'), IDBKeyRange.only([connectionId, Number.MAX_SAFE_INTEGER]), 50);
    for (const work of rows) {
      if (!work.id.startsWith('observation:')) continue;
      const id = work.id.slice('observation:'.length), row = await get<ObservationRow>(tx, 'observations', id);
      if (!row || row.context.installationGeneration !== authority.installationGeneration || row.context.sourceSessionGeneration !== authority.sourceSessionGeneration
        || row.ordinal <= (policy.admittedAfterOrdinal ?? 0)) continue;
      put(tx, 'observations', id, { ...row, state: 'pending', readyAt: 0 }); tx.objectStore('work').delete(work.id);
    }
    put(tx, 'meta', 'pendingObservations', await requestValue(tx.objectStore('observations').index('state').count('pending')));
  });
}
