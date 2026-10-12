import { SyncStateError, type ScopeRecord } from './types.js';
import { clone } from './codec.js';
import { STORES } from './schema.js';

export function requestValue<T = unknown>(request: IDBRequest<T>): Promise<T> { return new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error ?? new SyncStateError('request_failed')); }); }
export function transactionDone(tx: IDBTransaction): Promise<void> { return new Promise((resolve, reject) => { tx.oncomplete = () => resolve();
  tx.onabort = () => reject(tx.error ?? new SyncStateError('transaction_aborted')); tx.onerror = () => undefined; }); }
export async function runTransaction(db: IDBDatabase, names: string[], mode: IDBTransactionMode, work: (tx: IDBTransaction) => Promise<void>) {
  const tx = db.transaction(names, mode); const completion = transactionDone(tx);
  try { await work(tx); await completion; } catch (error) { try { tx.abort(); } catch { /* already completed or aborted */ }
    await completion.catch(() => undefined);
    if (error instanceof Error && error.name === 'AbortError') {
      if (tx.error) throw tx.error;
      throw new SyncStateError('transaction_aborted');
    }
    throw error; } }
export async function requireActiveScope(tx: IDBTransaction, key: string): Promise<ScopeRecord> { const scope = await requestValue(tx.objectStore(STORES.scopes).get(key)) as ScopeRecord | undefined;
  if (!scope) throw new SyncStateError('scope_not_found'); if (scope.lifecycle === 'retired') throw new SyncStateError('scope_retired'); return scope; }
export async function cursorPage<T>(source: IDBObjectStore | IDBIndex, range: IDBKeyRange | null, limit: number): Promise<T[]> { const values: T[] = [];
  await iterateCursor(source, range, (value) => { values.push(value as T); return values.length < limit; }); return values; }
export async function iterateCursor(source: IDBObjectStore | IDBIndex, range: IDBKeyRange | null,
  visit: (value: unknown, cursor: IDBCursorWithValue) => boolean | void) { await new Promise<void>((resolve, reject) => {
    const request = source.openCursor(range); request.onerror = () => reject(request.error); request.onsuccess = () => { const cursor = request.result;
      if (!cursor) { resolve(); return; } try { const proceed = visit(clone(cursor.value), cursor);
        if (proceed === false) resolve(); else cursor.continue(); } catch (error) { reject(error); } }; }); }
export async function deleteByIndexRange(index: IDBIndex, range: IDBKeyRange) { await iterateCursor(index, range, (_value, cursor) => { cursor.delete(); }); }
export async function deleteScopeRows(store: IDBObjectStore, key: string) { if (store.keyPath === 'scopeKey') { store.delete(key); return; }
  await iterateCursor(store, scopeRowsRange(key), (_value, cursor) => { cursor.delete(); }); }
export function scopeRowsRange(key: string) { return IDBKeyRange.bound([key], [key, []]); }
export function pageEventsRange(key: string, pageId: string) {
  return IDBKeyRange.bound([key, pageId], [key, pageId, []]);
}

/** Await nested IDB requests before advancing a cursor. Visitors must not await external I/O. */
export function iterateCursorSequentially(store: IDBObjectStore | IDBIndex, range: IDBKeyRange,
  visit: (value: unknown, cursor: IDBCursorWithValue) => Promise<void>): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = store.openCursor(range);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) { resolve(); return; }
      void visit(cursor.value, cursor).then(() => cursor.continue()).catch(reject);
    };
  });
}
