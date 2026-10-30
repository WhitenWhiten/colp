import { sniffBookmarkFaviconCanonicalMime, BOOKMARK_FAVICON_MAX_BYTES } from './favicon-sniff.js';

const MAX_BINDINGS = 512;
const TTL = 30 * 24 * 60 * 60 * 1000;
interface Binding { url: string; hash: string; updated: number }
const value = <T>(request: IDBRequest<T>) => new Promise<T>((resolve, reject) => {
  request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
});
async function open(): Promise<IDBDatabase> {
  const request = indexedDB.open('known-favicon-display', 1);
  request.onupgradeneeded = () => {
    request.result.createObjectStore('bindings', { keyPath: 'url' });
    request.result.createObjectStore('images');
  };
  return value(request);
}
function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve(); tx.onerror = tx.onabort = () => reject(tx.error);
  });
}
function pageIdentity(raw: string): URL | null {
  try { const url = new URL(raw); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url : null; }
  catch { return null; }
}
/** Device-local captured icons, independent of the cloud upload queue. */
export async function rememberDisplayFavicon(pageUrl: string, bytes: Uint8Array): Promise<void> {
  const page = pageIdentity(pageUrl);
  const mime = sniffBookmarkFaviconCanonicalMime(bytes);
  if (!page || !mime || bytes.length > BOOKMARK_FAVICON_MAX_BYTES) return;
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes))), b => b.toString(16).padStart(2, '0')).join('');
  let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte);
  const image = `data:${mime};base64,${btoa(binary)}`;
  const db = await open();
  try {
    const tx = db.transaction(['bindings', 'images'], 'readwrite'); const completed = done(tx);
    const bindings = tx.objectStore('bindings'); const images = tx.objectStore('images');
    images.put(image, hash);
    for (const url of [page.href, page.origin + '/']) bindings.put({ url, hash, updated: Date.now() });
    const rows = await value<Binding[]>(bindings.getAll());
    rows.sort((a, b) => b.updated - a.updated);
    const retained = rows.filter((row, index) => {
      if (index < MAX_BINDINGS && row.updated > Date.now() - TTL) return true;
      bindings.delete(row.url); return false;
    });
    const used = new Set(retained.map(row => row.hash));
    for (const key of await value(images.getAllKeys())) if (!used.has(String(key))) images.delete(key);
    await completed;
  } finally { db.close(); }
}
export async function readDisplayFavicon(pageUrl: string): Promise<string | null> {
  const page = pageIdentity(pageUrl); if (!page) return null;
  const db = await open();
  try {
    const tx = db.transaction(['bindings', 'images'], 'readonly'); const completed = done(tx);
    const bindings = tx.objectStore('bindings');
    const exact = await value<Binding | undefined>(bindings.get(page.href));
    const row = exact ?? await value<Binding | undefined>(bindings.get(page.origin + '/'));
    const image = row && row.updated > Date.now() - TTL ? await value<string | undefined>(tx.objectStore('images').get(row.hash)) : null;
    await completed; return image ?? null;
  } finally { db.close(); }
}
