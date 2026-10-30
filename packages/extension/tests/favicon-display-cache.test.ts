import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { rememberDisplayFavicon, readDisplayFavicon } from '../src/favicon-display-cache.js';
const png = Uint8Array.from([137,80,78,71,13,10,26,10,1,2]);
beforeEach(() => vi.stubGlobal('indexedDB', new IDBFactory()));
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
test('persists page icons and shares a site fallback without crossing origins', async () => {
  await rememberDisplayFavicon('https://example.test/a', png);
  expect(await readDisplayFavicon('https://example.test/a')).toMatch(/^data:image\/png;base64,/);
  expect(await readDisplayFavicon('https://example.test/b')).toBe(await readDisplayFavicon('https://example.test/a'));
  expect(await readDisplayFavicon('https://other.test/a')).toBeNull();
});
test('rejects invalid bytes and expires old display data', async () => {
  await rememberDisplayFavicon('https://example.test/a', new Uint8Array([1,2]));
  expect(await readDisplayFavicon('https://example.test/a')).toBeNull();
  await rememberDisplayFavicon('https://example.test/a', png);
  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 31 * 86400000);
  expect(await readDisplayFavicon('https://example.test/a')).toBeNull();
});
test('deduplicates identical bytes and bounds retained bindings', async () => {
  for (let i = 0; i < 520; i++) await rememberDisplayFavicon(`https://example.test/${i}`, png);
  const request = indexedDB.open('known-favicon-display', 1);
  const db = await new Promise<IDBDatabase>(resolve => { request.onsuccess = () => resolve(request.result); });
  try {
    const tx = db.transaction(['bindings', 'images'], 'readonly');
    const count = (name: string) => new Promise<number>(resolve => {
      const r = tx.objectStore(name).count(); r.onsuccess = () => resolve(r.result);
    });
    const [bindings, images] = await Promise.all([count('bindings'), count('images')]);
    expect(bindings).toBeLessThanOrEqual(512); expect(images).toBe(1);
  } finally { db.close(); }
});
