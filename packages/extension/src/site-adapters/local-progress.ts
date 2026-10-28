import { requestValue, cursorPage } from '../sync-state/idb.js';
import { get, type SourceDatabase } from './source-db.js';
import { managedLibraryKey, type ManagedLibrary } from './copy-identity.js';
import type { SourceAuthority } from './ledger-types.js';
import type { SourcePolicyRecord } from './layout.js';
import { installationKey } from './installation.js';
import { legacySite } from './registry.js';
export interface LocalSourceProgress {
  available: boolean; pendingLocal: number; pendingSync: number; attention: number; pendingConfirmation?: number;
  lastSavedAt?: number; lastCommandId?: string; associatedAt?: number;
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
    const pendingLocal = observations + await requestValue(connectionId ? tx.objectStore('work').index('connectionId').count(connectionId) : tx.objectStore('work').count());
    const transfers = tx.objectStore('transfers');
    const count = (state: string) => requestValue(connectionId ? transfers.index('connectionState').count([connectionId, state])
      : owner ? transfers.index('ownerState').count([managedLibraryKey(owner), state]) : transfers.index('state').count(state));
    const pendingSync = await count('pending'), attention = await count('attention');
    const last = connectionId ? await get<{ at: number; commandId: string }>(tx, 'meta', `localPipelineLast:${connectionId}`) : undefined;
    const transfer = last ? await get<{ associatedAt?: number }>(tx, 'meta', JSON.stringify(['localSourceTransfer', last.commandId])) : undefined;
    return { available: true, pendingLocal, pendingSync, attention, pendingConfirmation, ...(last ? { lastSavedAt: last.at, lastCommandId: last.commandId } : {}),
      ...(transfer?.associatedAt ? { associatedAt: transfer.associatedAt } : {}) };
  }).catch(() => ({ available: false, pendingLocal: 0, pendingSync: 0, attention: 0 }));
}
