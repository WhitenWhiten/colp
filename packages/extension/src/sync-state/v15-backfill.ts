/**
 * Post-open v15 backfill. Upgrade must not scan queue/history; this pages
 * missing nativeResult as unknown and is a no-op when there is no work.
 */
import { STORES, V15_BACKFILL_KEY } from './schema.js';
import type { IntentRecord } from './types.js';
import { requestValue, transactionDone } from './idb.js';

export { V15_BACKFILL_KEY };
const DEFAULT_LIMIT = 50;

export interface V15BackfillPage {
  readonly scanned: number;
  readonly written: number;
  readonly done: boolean;
}

type StoreOpen = { readonly open: () => Promise<IDBDatabase> };

export async function pageV15Backfill(store: StoreOpen, limit = DEFAULT_LIMIT): Promise<V15BackfillPage> {
  const pageSize = Number.isSafeInteger(limit) && limit > 0 ? limit : DEFAULT_LIMIT;
  const db = await store.open();
  const peek = db.transaction([STORES.metadata, STORES.intents], 'readonly');
  const peekDone = transactionDone(peek);
  const marker = await requestValue(peek.objectStore(STORES.metadata).get(V15_BACKFILL_KEY)) as
    { readonly status?: string } | undefined;
  await peekDone;
  if (marker?.status === 'complete') return { scanned: 0, written: 0, done: true };

  const tx = db.transaction([STORES.metadata, STORES.intents], 'readwrite');
  const completion = transactionDone(tx);
  const intents = tx.objectStore(STORES.intents);
  let scanned = 0;
  let written = 0;
  let exhausted = true;
  await new Promise<void>((resolve, reject) => {
    const cursor = intents.openCursor();
    cursor.onerror = () => reject(cursor.error);
    cursor.onsuccess = () => {
      const current = cursor.result;
      if (!current) { resolve(); return; }
      scanned += 1;
      const row = current.value as IntentRecord;
      if (row.nativeResult === undefined) {
        if (written >= pageSize) { exhausted = false; resolve(); return; }
        current.update({ ...row, nativeResult: 'unknown' });
        written += 1;
      }
      current.continue();
    };
  });
  const done = exhausted && scanned > 0;
  tx.objectStore(STORES.metadata).put({ key: V15_BACKFILL_KEY, status: done ? 'complete' : 'unknown' });
  await completion;
  return { scanned, written, done };
}
