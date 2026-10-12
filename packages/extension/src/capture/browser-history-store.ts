import type { CaptureScope, CaptureTask } from './contracts.js';
import { browserHistoryFact, browserHistoryItem, isBrowserHistoryFact, type BrowserHistoryFact } from './browser-history-fact.js';

export const BROWSER_HISTORY_DATABASE = 'known-browser-capture-history-v1';
export const BROWSER_HISTORY_RETENTION_MS = 90 * 86400000;
const TABLE = 'activity', INDEX = 'createdAt', SETTINGS = 'settings';

/** Facts about native writes belong to this browser profile, independently of Know-N login. */
export function createBrowserHistoryStore(options: { indexedDB?: IDBFactory; now?: () => number } = {}) {
  let opening: Promise<IDBDatabase> | undefined;
  let pruneAfter = 0;
  const now = options.now ?? Date.now;
  const open = () => opening ??= new Promise<IDBDatabase>((resolve, reject) => {
    let refused = false;
    const request = (options.indexedDB ?? indexedDB).open(BROWSER_HISTORY_DATABASE, 2);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(TABLE)) {
        const table = request.result.createObjectStore(TABLE, { keyPath: 'captureId' });
        table.createIndex(INDEX, ['createdAt', 'captureId']);
      }
      request.result.createObjectStore(SETTINGS);
    };
    request.onerror = () => { opening = undefined; reject(request.error); };
    request.onblocked = () => { refused = true; opening = undefined; reject(new Error('browser_history_unavailable')); };
    request.onsuccess = () => {
      const db = request.result;
      if (refused) { db.close(); return; }
      db.onversionchange = () => { db.close(); opening = undefined; };
      resolve(db);
    };
  });
  type SavedTask = Pick<CaptureTask, 'captureId' | 'targetNativeId' | 'title' | 'url' | 'source' | 'automaticIntent' | 'createdAt' | 'savedAt'>;
  async function remember(task: SavedTask, nativeId: string) {
    await writeFacts([browserHistoryFact(task, nativeId, task.savedAt ?? now())]);
  }
  async function rememberMany(tasks: readonly CaptureTask[]) {
    if (tasks.length > 200) throw new Error('browser_history_invalid');
    const facts: BrowserHistoryFact[] = [];
    for (const task of tasks) {
      if (task.save !== 'local-saved' || task.disposition !== 'new' || !task.nativeId
        || ('historyReadOnly' in task && task.historyReadOnly === true)) continue;
      // Legacy rows have no immutable save timestamp. Status updates are not new saves.
      try { facts.push(browserHistoryFact(task, task.nativeId, task.savedAt ?? task.createdAt)); }
      catch { /* A corrupt legacy row must not prevent other device facts from migrating. */ }
    }
    if (facts.length) await writeFacts(facts);
  }
  async function writeFacts(facts: readonly BrowserHistoryFact[]) {
    const cutoff = Math.max(0, now() - BROWSER_HISTORY_RETENTION_MS);
    const db = await open();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([TABLE, SETTINGS], 'readwrite'), table = tx.objectStore(TABLE);
      tx.oncomplete = () => { pruneAfter = now() + 60000; resolve(); }; tx.onabort = tx.onerror = () => reject(tx.error ?? new Error('browser_history_unavailable'));
      const seen = new Set<string>();
      const clearing = tx.objectStore(SETTINGS).get('clearedThrough');
      clearing.onsuccess = () => {
        for (const fact of facts) {
          if (fact.createdAt < cutoff || fact.savedAt <= Number(clearing.result ?? -1) || seen.has(fact.captureId)) continue;
          seen.add(fact.captureId);
          const existing = table.get(fact.captureId);
          existing.onsuccess = () => { if (existing.result === undefined) table.put(fact); };
        }
      };
      const expired = table.index(INDEX).openCursor(IDBKeyRange.upperBound([cutoff, '']));
      expired.onsuccess = () => { const cursor = expired.result; if (cursor) { cursor.delete(); cursor.continue(); } };
    });
  }
  async function listForOwner(scope: CaptureScope, before?: readonly [number, string], limit = 50) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('browser_history_invalid');
    const cutoff = Math.max(0, now() - BROWSER_HISTORY_RETENTION_MS);
    if (before && (!Number.isSafeInteger(before[0]) || before[0] < 0
      || typeof before[1] !== 'string' || !before[1] || before[1].length > 2048)) throw new Error('browser_history_invalid');
    if (before && before[0] < cutoff) return [];
    if (now() >= pruneAfter || pruneAfter - now() > 60000) await writeFacts([]);
    const db = await open();
    return new Promise<ReturnType<typeof browserHistoryItem>[]>((resolve, reject) => {
      const tx = db.transaction(TABLE, 'readonly');
      const rows: ReturnType<typeof browserHistoryItem>[] = [];
      tx.oncomplete = () => resolve(rows); tx.onabort = tx.onerror = () => reject(tx.error ?? new Error('browser_history_unavailable'));
      const range = before ? IDBKeyRange.bound([cutoff, ''], [...before], false, true)
        : IDBKeyRange.lowerBound([cutoff, '']);
      const request = tx.objectStore(TABLE).index(INDEX).openCursor(range, 'prev');
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor || rows.length >= limit) return;
        if (isBrowserHistoryFact(cursor.value)) rows.push(browserHistoryItem(cursor.value, scope));
        if (rows.length < limit) cursor.continue();
      };
    });
  }
  async function clear() {
    const db = await open();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([TABLE, SETTINGS], 'readwrite');
      tx.oncomplete = () => resolve(); tx.onabort = tx.onerror = () => reject(tx.error);
      tx.objectStore(TABLE).clear(); tx.objectStore(SETTINGS).put(now(), 'clearedThrough');
    });
  }
  return Object.freeze({ remember, rememberMany, listForOwner, clear,
    close() { void opening?.then(db => db.close()).catch(() => undefined); opening = undefined; } });
}

export const browserHistoryStore = createBrowserHistoryStore();
