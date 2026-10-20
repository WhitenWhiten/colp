import { requestValue } from './idb.js';
import { INDEXES, STORES } from './schema.js';
import type { BookmarkEventInput, BookmarkEventRecord, QueueOperation } from './types.js';

/** Explicitly cancelled, never-uploaded creates do not own a future authorized capture. */
export async function bookmarkEventDuplicate(tx: IDBTransaction, key: string, event: BookmarkEventInput):
  Promise<BookmarkEventRecord | undefined> {
  const events = tx.objectStore(STORES.bookmarkEvents);
  const duplicate = await requestValue(events.index(INDEXES.eventByDedupe).get([key, event.dedupeKey])) as BookmarkEventRecord | undefined;
  if (duplicate?.kind === 'create' && duplicate.status === 'processed' && duplicate.opId) {
    const queue = await requestValue(tx.objectStore(STORES.queue).index(INDEXES.queueByOpId).get([key, duplicate.opId])) as QueueOperation | undefined;
    if (queue?.status === 'rejected' && queue.recovery?.code === 'queued_upload_excluded') {
      events.put({ ...duplicate, dedupeKey: `cancelled:${duplicate.eventId}` });
      return undefined;
    }
  }
  return duplicate;
}
