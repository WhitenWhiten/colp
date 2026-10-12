export const FAVICON_SIDECAR_DATABASE = 'known-favicon-sidecar';
export const FAVICON_SIDECAR_VERSION = 2;
export const FAVICON_SIDECAR_STORE = 'captures';
export const FAVICON_SIDECAR_TTL_MS = 15 * 60 * 1_000;
export const FAVICON_SIDECAR_ALARM = 'known-favicon-sidecar';

export type FaviconSidecarOrigin = 'import' | 'capture';

export interface FaviconSidecarRecord {
  readonly nativeId: string; readonly contentType: string; readonly bytes: ArrayBuffer;
  readonly commandId: string; readonly collectionId: string; readonly createdAt: number;
  readonly attempts: number; readonly notBefore: number;
  readonly origin?: FaviconSidecarOrigin;
  /**
   * FO-04 URL identity of the page the bytes were captured from. Recorded for
   * every capture; absent on imports (their bytes come from the user's own
   * export, not from a live page) and on pre-upgrade rows. The drain refuses to
   * bind bytes whose recorded page is no longer the bookmark's URL, so a URL
   * edit can never attach the old site's icon to the new site.
   */
  readonly pageUrl?: string;
}

export interface FaviconSidecarInput {
  readonly nativeId: string; readonly contentType: string; readonly bytes: Uint8Array | ArrayBuffer;
  readonly commandId: string; readonly collectionId: string; readonly createdAt: number;
  readonly attempts?: number; readonly notBefore?: number;
  readonly origin?: FaviconSidecarOrigin;
  readonly pageUrl?: string;
}

export function createFaviconSidecarStore(options: { readonly indexedDB?: IDBFactory; readonly now?: () => number } = {}) {
  const factory = options.indexedDB ?? globalThis.indexedDB;
  if (!factory) throw new Error('indexeddb_unavailable');
  const now = options.now ?? Date.now;
  let connection: IDBDatabase | undefined;

  async function open(): Promise<IDBDatabase> {
    if (connection) return connection;
    const request = factory.open(FAVICON_SIDECAR_DATABASE, FAVICON_SIDECAR_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (db.objectStoreNames.contains(FAVICON_SIDECAR_STORE)) return;
      db.createObjectStore(FAVICON_SIDECAR_STORE, { keyPath: 'nativeId' }).createIndex('by_collection', 'collectionId');
    };
    connection = await requestValue(request);
    connection.onversionchange = () => { connection?.close(); connection = undefined; };
    return connection;
  }

  function close(): void { connection?.close(); connection = undefined; }

  async function put(input: FaviconSidecarInput): Promise<void> {
    const record: FaviconSidecarRecord = {
      nativeId: input.nativeId, contentType: input.contentType, bytes: cloneBytes(input.bytes),
      commandId: input.commandId, collectionId: input.collectionId, createdAt: input.createdAt,
      attempts: input.attempts ?? 0, notBefore: input.notBefore ?? 0,
      ...(input.origin === 'import' || input.origin === 'capture' ? { origin: input.origin } : {}),
      ...(typeof input.pageUrl === 'string' && input.pageUrl.length > 0
        ? { pageUrl: input.pageUrl }
        : {}),
    };
    const db = await open();
    const tx = db.transaction(FAVICON_SIDECAR_STORE, 'readwrite');
    tx.objectStore(FAVICON_SIDECAR_STORE).put(record);
    await transactionDone(tx);
  }

  async function get(nativeId: string): Promise<FaviconSidecarRecord | null> {
    const db = await open();
    const tx = db.transaction(FAVICON_SIDECAR_STORE, 'readonly');
    const done = transactionDone(tx);
    const value = await requestValue(tx.objectStore(FAVICON_SIDECAR_STORE).get(nativeId));
    await done;
    return value ?? null;
  }

  async function list(collectionId: string): Promise<readonly FaviconSidecarRecord[]> {
    const db = await open();
    const tx = db.transaction(FAVICON_SIDECAR_STORE, 'readonly');
    const done = transactionDone(tx);
    const rows = await requestValue(tx.objectStore(FAVICON_SIDECAR_STORE).index('by_collection').getAll(collectionId));
    await done;
    return rows;
  }

  async function discard(nativeId: string): Promise<void> {
    const db = await open();
    const tx = db.transaction(FAVICON_SIDECAR_STORE, 'readwrite');
    tx.objectStore(FAVICON_SIDECAR_STORE).delete(nativeId);
    await transactionDone(tx);
  }

  async function markAttempt(nativeId: string, attempts: number, notBefore: number): Promise<void> {
    const current = await get(nativeId);
    if (!current) return;
    await put({ ...current, bytes: new Uint8Array(current.bytes), attempts, notBefore });
  }

  /**
   * Streaming prune of rows that belong to no-longer-active collections. Only
   * rows whose collectionId differs from the ACTIVE one AND whose age exceeds
   * the TTL are removed; the active collection's rows (including rows simply
   * waiting out their backoff) and every fresh row are left untouched.
   */
  async function prune(activeCollectionId: string): Promise<number> {
    const db = await open();
    const tx = db.transaction(FAVICON_SIDECAR_STORE, 'readwrite');
    const store = tx.objectStore(FAVICON_SIDECAR_STORE);
    const done = transactionDone(tx);
    const t = now();
    let pruned = 0;
    await visitRows(store, (row, cursor) => {
      if (row.collectionId !== activeCollectionId && t - row.createdAt > FAVICON_SIDECAR_TTL_MS) {
        cursor.delete();
        pruned += 1;
      }
    });
    await done;
    return pruned;
  }

  async function listReady(collectionId: string): Promise<readonly FaviconSidecarRecord[]> {
    const t = now();
    const ready: FaviconSidecarRecord[] = [];
    const db = await open();
    const tx = db.transaction(FAVICON_SIDECAR_STORE, 'readwrite');
    const done = transactionDone(tx);
    await visitRows(tx.objectStore(FAVICON_SIDECAR_STORE).index('by_collection'), (row, cursor) => {
      if (t - row.createdAt > FAVICON_SIDECAR_TTL_MS) { cursor.delete(); return; }
      if (row.notBefore <= t) ready.push(row);
    }, IDBKeyRange.only(collectionId));
    await done;
    return ready;
  }

  return Object.freeze({ put, get, list, listReady, discard, markAttempt, prune, close });
}

function cloneBytes(bytes: Uint8Array | ArrayBuffer): ArrayBuffer {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const copy = new Uint8Array(view.byteLength);
  copy.set(view);
  return copy.buffer;
}

function requestValue<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

/** Synchronous cursor visitors keep pruning inside one live IDB transaction. */
function visitRows(source: IDBObjectStore | IDBIndex,
  visit: (row: FaviconSidecarRecord, cursor: IDBCursorWithValue) => void,
  range?: IDBKeyRange): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = source.openCursor(range);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) { resolve(); return; }
      try { visit(cursor.value as FaviconSidecarRecord, cursor); cursor.continue(); }
      catch (error) { reject(error); ('transaction' in source ? source.transaction : source.objectStore.transaction).abort(); }
    };
  });
}
