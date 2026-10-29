import { cursorPage, iterateCursorSequentially, requestValue } from '../sync-state/idb.js';
import { get, put, sourceKey, type SourceDatabase } from './source-db.js';
import type { ConfirmationRow } from './confirmation-queue.js';
import type { SourceAuthority } from './ledger-types.js';
import type { MembershipHint } from './contracts.js';

export function createConfirmationRetry(db: SourceDatabase, installationId: string, pendingKey: string,
  limit: number, hasMemberships: (hint: MembershipHint) => boolean) {
  const eligible = (row: ConfirmationRow, authority: SourceAuthority) => row.state === 'uncertain' && row.hint.code === 0
    && hasMemberships(row.hint) && row.origin.connectionId === authority.connectionId
    && row.origin.installationGeneration === authority.installationGeneration
    && row.origin.sourceSessionGeneration === authority.sourceSessionGeneration
    && !['siteWriteFailed', 'negativeReadbackUnavailable', 'sourceChanged', 'conflict'].includes(row.reason ?? '');
  const authority = (tx: IDBTransaction) => get<SourceAuthority>(tx, 'authorities', installationId);
  return {
    async request(pauseKey: string) {
      await db.transaction(['authorities', 'meta', 'readRequests'], 'readwrite', async tx => {
        const current = await authority(tx); if (!current?.enabled || !current.connectionId) return;
        await iterateCursorSequentially(tx.objectStore('readRequests').index('confirmationState'), IDBKeyRange.only([current.connectionId, 'uncertain']), async value => {
          const row = value as ConfirmationRow;
          if (eligible(row, current)) put(tx, 'readRequests', sourceKey('hint', row.id), { ...row, retryRequested: 1 });
        });
        tx.objectStore('meta').delete(pauseKey);
      });
    },
    async fill(): Promise<boolean> {
      return db.transaction(['authorities', 'meta', 'readRequests'], 'readwrite', async tx => {
        const current = await authority(tx); if (!current?.enabled || !current.connectionId) return false;
        const pending = await get<string[]>(tx, 'meta', pendingKey) ?? [];
        const range = IDBKeyRange.only([current.connectionId, 1]), index = tx.objectStore('readRequests').index('confirmationRetry');
        if (pending.length < limit) for (const row of await cursorPage<ConfirmationRow>(index, range, limit - pending.length)) {
          const next = { ...row, retryRequested: undefined };
          if (eligible(row, current) && !pending.includes(row.id)) {
            put(tx, 'readRequests', sourceKey('hint', row.id), { ...next, state: 'membership', attempts: 0,
              cycle: (row.cycle ?? 0) + 1, active: undefined, known: undefined, absent: undefined, baselineOrdinal: undefined, sourceWaitUntil: undefined, reason: undefined });
            pending.push(row.id);
          } else put(tx, 'readRequests', sourceKey('hint', row.id), next);
        }
        put(tx, 'meta', pendingKey, pending);
        return await requestValue(index.count(range)) > 0;
      });
    },
    async waiting() {
      return db.transaction(['authorities', 'readRequests'], 'readonly', async tx => {
        const current = await authority(tx);
        return current?.connectionId ? requestValue(tx.objectStore('readRequests').index('confirmationRetry').count([current.connectionId, 1])) : 0;
      });
    },
  };
}
