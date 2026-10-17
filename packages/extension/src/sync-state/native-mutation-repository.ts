import { cursorPage, requestValue, requireActiveScope, runTransaction, scopeRowsRange } from './idb.js';
import { scopeKey, validateScope } from './scope-key.js';
import { STORES } from './schema.js';
import type { SyncStoreRuntime } from './runtime.js';
import type { BookmarkEventRecord, DeletionJournalRecord, MappingInput, SyncScope } from './types.js';

export function createNativeMutationRepository(ctx: SyncStoreRuntime) {
  async function discardSatisfiedNativeMutation(input: SyncScope, eventId: string, nativeMissing = false): Promise<boolean> {
    ctx.assertWritable(); const key = scopeKey(validateScope(input)); let discarded = false;
    await runTransaction(await ctx.writableDatabase(), [STORES.scopes, STORES.bookmarkEvents, STORES.deletionJournal, STORES.mappings], 'readwrite', async tx => {
      await requireActiveScope(tx, key);
      const events = tx.objectStore(STORES.bookmarkEvents);
      const event = await requestValue(events.get([key, eventId])) as BookmarkEventRecord | undefined;
      if (!event || event.status !== 'pending' || event.details.nativeMutation !== true) return;
      const ancestors = Array.isArray(event.details.ancestorNativeIds) ? event.details.ancestorNativeIds : [];
      const removed = await cursorPage<DeletionJournalRecord>(tx.objectStore(STORES.deletionJournal), scopeRowsRange(key), Number.POSITIVE_INFINITY);
      const mapping = await requestValue(tx.objectStore(STORES.mappings).get([key, event.nativeId])) as MappingInput | undefined;
      const fields = ['title', 'url'].filter(field => typeof event.details[field] === 'string');
      const satisfied = event.kind === 'change' && fields.length > 0 && mapping && !mapping.colpId.startsWith('pending-')
        && !mapping.projection.revision.startsWith('local-')
        && fields.every(field => mapping.projection.content?.[field] === event.details[field]);
      if (!satisfied && !removed.some(row => row.nativeId === event.nativeId || nativeMissing && ancestors.includes(row.nativeId))) return;
      events.delete([key, eventId]); discarded = true;
    });
    return discarded;
  }
  return { discardSatisfiedNativeMutation };
}
