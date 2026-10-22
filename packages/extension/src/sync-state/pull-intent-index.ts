import { boundedString } from './codec.js';
import { cursorPage, requestValue } from './idb.js';
import { expiredCompletedIntentCanBeDeleted, openDeferredIntentIds } from './pull-workset.js';
import { INDEXES, STORES } from './schema.js';
import type { IntentRecord, UnknownRecord } from './types.js';

export type ExpiredIntentCursor = { readonly expiresAt: number; readonly intentId: string };
export type ExpiredIntentPruneResult = {
  readonly deleted: number; readonly done: boolean; readonly after?: ExpiredIntentCursor;
};

export function intentsForNativeTarget(tx: IDBTransaction, key: string, nativeId: string): Promise<IntentRecord[]> {
  const target = boundedString(nativeId, 'nativeId');
  return cursorPage<IntentRecord>(tx.objectStore(STORES.intents).index(INDEXES.intentByNativeTarget),
    IDBKeyRange.bound([key, target, ''], [key, target, '\uffff']), Number.MAX_SAFE_INTEGER);
}

/** Delete one bounded batch of expired, unreferenced page-complete intents. */
export async function pruneExpiredCompletedIntents(
  tx: IDBTransaction, key: string, now: number, limit: number, after?: ExpiredIntentCursor,
): Promise<ExpiredIntentPruneResult> {
  const events = tx.objectStore(STORES.pullEvents);
  const referenced = await openDeferredIntentIds(events, key);
  const range = IDBKeyRange.bound(
    after ? [key, 'page_complete', after.expiresAt, after.intentId] : [key, 'page_complete', 0, ''],
    [key, 'page_complete', now, '\uffff'], Boolean(after), false);
  const index = tx.objectStore(STORES.intents).index(INDEXES.intentByCompletedExpiry);
  let deleted = 0; let examined = 0; let done = true; let cursorAfter = after;
  await new Promise<void>((resolve, reject) => {
    const request = index.openCursor(range);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor || examined >= limit) { done = !cursor; resolve(); return; }
      const intent = cursor.value as IntentRecord;
      void (async () => {
        examined += 1;
        cursorAfter = { expiresAt: intent.expiresAt, intentId: intent.intentId };
        const event = intent.eventId
          ? await requestValue(events.get([key, intent.eventId])) as UnknownRecord | undefined : undefined;
        if (expiredCompletedIntentCanBeDeleted(intent, event, referenced)) { cursor.delete(); deleted += 1; }
        cursor.continue();
      })().catch(reject);
    };
  });
  return done ? { deleted, done } : { deleted, done, after: cursorAfter };
}
