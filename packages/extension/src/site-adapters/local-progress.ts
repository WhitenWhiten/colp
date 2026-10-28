import { requestValue, cursorPage } from '../sync-state/idb.js';
import { get, type SourceDatabase } from './source-db.js';
import { managedLibraryKey, type ManagedLibrary } from './copy-identity.js';
import type { SourceAuthority } from './ledger-types.js';
import type { SourcePolicyRecord } from './layout.js';
import { installationKey } from './installation.js';
import { legacySite } from './registry.js';
export interface LocalSourceProgress {
  available: boolean; pendingLocal: number; pendingSync: number; attention: number; pendingConfirmation?: number; localAttention?: number;
  lastSavedAt?: number; lastCommandId?: string; associatedAt?: number;
  readyAt?: number; plannedAt?: number; localConfirmedAt?: number; readyToLocalMs?: number; uploadObservedAt?: number; reason?: string; retryAt?: number;
}
export async function localSourceProgress(db: SourceDatabase, connectionId?: string, owner?: ManagedLibrary): Promise<LocalSourceProgress> {
  return db.transaction(['meta', 'work', 'transfers', 'observations', 'authorities'], 'readonly', async tx => {
    let observations = 0, pendingConfirmation = 0;
    const authorities = await cursorPage<SourceAuthority>(tx.objectStore('authorities'), null, 1001);
    if (authorities.length > 1000) throw Error('capacity');
    for (const authority of authorities) {
      if (!authority.enabled || !authority.connectionId || connectionId && authority.connectionId !== connectionId) continue;
      const policy = await get<SourcePolicyRecord>(tx, 'meta', `policy:${authority.connectionId}`);
      if (policy?.enabled && policy.liveArchive) {
        observations += await requestValue(tx.objectStore('observations').index('connectionState').count([authority.connectionId, 'pending']));
        pendingConfirmation += (await get<string[]>(tx, 'meta', installationKey('confirmationQueue:v1', { adapterId: authority.installationId ?? legacySite.adapterId })) ?? []).length;
      }
    }
    const localAttention = await requestValue(connectionId ? tx.objectStore('work').index('connectionDue').count([connectionId, Number.MAX_SAFE_INTEGER])
      : tx.objectStore('work').index('dueAt').count(Number.MAX_SAFE_INTEGER));
    const pendingLocal = observations - localAttention + await requestValue(connectionId ? tx.objectStore('work').index('connectionId').count(connectionId) : tx.objectStore('work').count());
    const transfers = tx.objectStore('transfers');
    const count = (state: string) => requestValue(connectionId ? transfers.index('connectionState').count([connectionId, state])
      : owner ? transfers.index('ownerState').count([managedLibraryKey(owner), state]) : transfers.index('state').count(state));
    const pendingSync = await count('pending'), attention = await count('attention') + localAttention;
    const last = connectionId ? await get<{ at: number; commandId: string; readyAt?: number; plannedAt?: number; localConfirmedAt?: number; readyToLocalMs?: number }>(tx, 'meta', `localPipelineLast:${connectionId}`) : undefined;
    const rebound = last ? await get<{ commandId: string }>(tx, 'meta', `localOwnerBinding:${last.commandId}`) : undefined;
    const transfer = last ? await get<{ associatedAt?: number }>(tx, 'meta', JSON.stringify(['localSourceTransfer', rebound?.commandId ?? last.commandId])) : undefined;
    const uploadObservedAt = last ? await get<number>(tx, 'meta', `localUploadObserved:${rebound?.commandId ?? last.commandId}`) : undefined;
    const transferProblem = await requestValue<{ reason?: string } | undefined>(connectionId ? transfers.index('connectionState').get([connectionId, 'attention'])
      : owner ? transfers.index('ownerState').get([managedLibraryKey(owner), 'attention']) : transfers.index('state').get('attention'));
    const work = tx.objectStore('work');
    const localProblem = await requestValue<{ reason?: string; dueAt: number } | undefined>(connectionId ? work.index('connectionDue').get([connectionId, Number.MAX_SAFE_INTEGER])
      : work.index('dueAt').get(Number.MAX_SAFE_INTEGER));
    const retry = await requestValue<{ reason?: string; dueAt: number } | undefined>(connectionId ? work.index('connectionDue').get(IDBKeyRange.bound([connectionId, 0], [connectionId, Number.MAX_SAFE_INTEGER]))
      : work.index('dueAt').get(IDBKeyRange.lowerBound(0)));
    const problem = localProblem ?? transferProblem ?? retry;
    return { available: true, pendingLocal, pendingSync, attention, pendingConfirmation, localAttention, ...(last ? { lastSavedAt: last.at, lastCommandId: last.commandId, readyAt: last.readyAt, plannedAt: last.plannedAt, localConfirmedAt: last.localConfirmedAt, readyToLocalMs: last.readyToLocalMs } : {}),
      ...(uploadObservedAt !== undefined ? { uploadObservedAt } : {}), ...(problem?.reason ? { reason: problem.reason } : {}),
      ...(retry && retry.dueAt > 0 && retry.dueAt < Number.MAX_SAFE_INTEGER ? { retryAt: retry.dueAt } : {}),
      ...(transfer?.associatedAt ? { associatedAt: transfer.associatedAt } : {}) };
  }).catch(() => ({ available: false, pendingLocal: 0, pendingSync: 0, attention: 0 }));
}
