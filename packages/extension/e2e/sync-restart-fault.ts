import type { BrowserContext } from '@playwright/test';

/** Eviction after staging Pull, before the native change callback commits. */
export async function dropPendingChangeAndInterruptPull(context: BrowserContext, nativeId: string): Promise<number> {
  return await context.serviceWorkers()[0]!.evaluate(async nativeId => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('known-phase3-indexeddb-entry');
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    try {
      return await new Promise<number>((resolve, reject) => {
        const tx = db.transaction(['sync_engine', 'bookmark_events'], 'readwrite'), store = tx.objectStore('sync_engine');
        const events = tx.objectStore('bookmark_events'); let removed = 0;
        const captured = events.getAll();
        captured.onsuccess = () => { for (const row of captured.result) if (row.kind === 'change'
          && row.nativeId === nativeId && row.status === 'pending') { events.delete([row.scopeKey, row.eventId]); removed++; } };
        const request = store.getAll();
        request.onsuccess = () => { for (const row of request.result) store.put({ ...row,
          phase: 'applying', revision: row.revision + 1, updatedAt: Date.now() }); };
        tx.oncomplete = () => resolve(removed); tx.onabort = () => reject(tx.error);
      });
    } finally { db.close(); }
  }, nativeId);
}
