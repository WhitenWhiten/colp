import { cursorPage, requestValue, requireActiveScope, runTransaction, scopeRowsRange } from './idb.js';
import { scopeKey, validateScope } from './scope-key.js';
import { STORES } from './schema.js';
import type { SyncStoreRuntime } from './runtime.js';
import type { BookmarkEventRecord, DeletionJournalRecord, SyncScope } from './types.js';

export function createNativeMutationRepository(ctx: SyncStoreRuntime) {
  async function discardRemovedNativeMutation(input: SyncScope, eventId: string, nativeMissing = false): Promise<boolean> {
    ctx.assertWritable(); const key = scopeKey(validateScope(input)); let discarded = false;
    await runTransaction(await ctx.writableDatabase(), [STORES.scopes, STORES.bookmarkEvents, STORES.deletionJournal, STORES.mappings], 'readwrite', async tx => {
      await requireActiveScope(tx, key);
      const events = tx.objectStore(STORES.bookmarkEvents);
      const event = await requestValue(events.get([key, eventId])) as BookmarkEventRecord | undefined;
      if (!event || event.status !== 'pending' || event.details.nativeMutation !== true) return;
      // A mapped edit may already be the deletion's observed predecessor. Drain
      // that chain normally; only unowned edits can be subsumed by the journal.
      if (await requestValue(tx.objectStore(STORES.mappings).get([key, event.nativeId]))) return;
      const ancestors = Array.isArray(event.details.ancestorNativeIds) ? event.details.ancestorNativeIds : [];
      const removed = await cursorPage<DeletionJournalRecord>(tx.objectStore(STORES.deletionJournal), scopeRowsRange(key), Number.POSITIVE_INFINITY);
      // A content-equivalent edit can still be the predecessor of a later edit.
      // Keep it until a receipt resolves that dependency; only deletion subsumes it.
      if (!removed.some(row => row.nativeId === event.nativeId || nativeMissing && ancestors.includes(row.nativeId))) return;
      events.delete([key, eventId]); discarded = true;
    });
    return discarded;
  }
  return { discardRemovedNativeMutation };
}
