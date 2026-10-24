import { requestValue } from './idb.js';
import { STORES } from './schema.js';

const retryRowId = (key: string, pageId: string) => `pull_page_concurrent_retry:${key}:${pageId}`;

/**
 * W2C-09: the first time a page cannot complete because a bookmark it changed was edited locally in the same
 * moment (`concurrent_local_mutation`), complete it again on the next wake instead of blocking it. The local
 * edit usually reaches its queue revision within that moment and the page then completes; blocking at once sent
 * an ordinary race to a Snapshot recovery. Returns true on that first sighting (the caller must not block the
 * page and must report the transient `concurrent_local_mutation`); the second sighting returns false and the
 * page is blocked exactly as before.
 */
export async function takeConcurrentMutationRetry(tx: IDBTransaction, key: string, pageId: string,
  at: number): Promise<boolean> {
  const rows = tx.objectStore(STORES.diagnostics); const id = retryRowId(key, pageId);
  if (await requestValue(rows.get(id))) return false;
  rows.put({ id, scopeKey: key, kind: 'pull_page_concurrent_retry', pageId, code: 'concurrent_local_mutation', at });
  return true;
}
