import { requestValue } from './idb.js';
import { STORES } from './schema.js';

/** Retention bookmarks are bookkeeping, never operation-replay authority. They
 * share the existing scoped summary store and disappear with their source row. */
export async function retainedLongEnough(tx: IDBTransaction, key: string, kind: string,
  id: string, now: number, retention: number): Promise<boolean> {
  const summaries = tx.objectStore(STORES.compactSummaries);
  const markKey = [key, 'retention', JSON.stringify([kind, id])];
  const prior = await requestValue(summaries.get(markKey)) as { eligibleAt: number } | undefined;
  if (!prior || !Number.isSafeInteger(prior.eligibleAt) || prior.eligibleAt > now) {
    summaries.put({ scopeKey: key, kind: 'retention', id: markKey[2], eligibleAt: now });
    return false;
  }
  return now - prior.eligibleAt >= retention;
}

export function removeRetentionMark(tx: IDBTransaction, key: string, kind: string, id: string): void {
  tx.objectStore(STORES.compactSummaries).delete([key, 'retention', JSON.stringify([kind, id])]);
}

/** Bound examined rows, including protected rows. Resume after their actual
 * index key, and wrap on the next wake so one protected head cannot starve GC. */
export async function retentionBatch<T>(source: IDBObjectStore | IDBIndex, range: IDBKeyRange,
  limit: number, visit: (row: T) => Promise<void>): Promise<IDBValidKey | null> {
  let last: IDBValidKey | null = null;
  let examined = 0;
  await new Promise<void>((resolve, reject) => {
    const request = source.openCursor(range);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor || examined === limit) { if (!cursor) last = null; resolve(); return; }
      examined += 1;
      last = cursor.key;
      void visit(cursor.value as T).then(() => cursor.continue()).catch(reject);
    };
  });
  return last;
}
