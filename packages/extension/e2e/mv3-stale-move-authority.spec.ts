import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { KNS08_BINDINGS, confirmPreview, grantBookmarks, launchPersistent, liveCanonical, login,
  optionsPage, previewFirstRun, specialRoots, startRealStack, wakeEngine,
  waitFirstRunProductQuiet } from './kns-08-harness.js';

async function staleMove(page: Page, nativeId: string, accelerate = false) {
  return page.evaluate(async ({ nativeId, accelerate }) => {
    const read = (request: IDBRequest<any>) => new Promise<any>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    const db = await read(indexedDB.open('known-phase3-indexeddb-entry')) as IDBDatabase;
    try {
      const tx = db.transaction(['native_mappings', 'outbound_queue'], 'readwrite');
      const done = new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
      });
      const mappings = tx.objectStore('native_mappings'); const queue = tx.objectStore('outbound_queue');
      const mapping = (await read(mappings.getAll())).find((row: any) => row.nativeId === nativeId);
      if (!accelerate) mappings.put({ ...mapping, projection: { ...mapping.projection,
        revision: 'obsolete-snapshot-revision', resourceRevision: 'obsolete-snapshot-revision' } });
      const row = (await read(queue.getAll())).find((row: any) => row.payload?.type === 'move_node'
        && row.payload?.targetId === mapping.colpId && row.status !== 'terminal');
      if (accelerate && row?.recovery?.code === 'revision_conflict' && !row.attempt) {
        queue.put({ ...row, retry: { attempt: 220, notBefore: 0 } });
      }
      await done;
      return row ? { opId: row.opId, sequence: row.sequence, code: row.recovery?.code, bound: !!row.attempt } : null;
    } finally { db.close(); }
  }, { nativeId, accelerate });
}

test('an old Snapshot move with 220 revision denials recovers through real Snapshot and Push', async () => {
  test.setTimeout(180_000);
  const stack = await startRealStack(); const profile = await mkdtemp(resolve(tmpdir(), 'known-stale-move-'));
  let context: BrowserContext | undefined;
  try {
    context = await launchPersistent(profile, stack.browserHostResolverRules);
    const page = await optionsPage(context); await login(page, KNS08_BINDINGS[0]); await grantBookmarks(page);
    const roots = await specialRoots(page);
    const ids = await page.evaluate(async parentId => {
      const folder = await chrome.bookmarks.create({ parentId, title: 'Destination' });
      const bookmark = await chrome.bookmarks.create({ parentId, title: 'Retained move', url: 'https://example.test/move' });
      return { folder: folder.id, bookmark: bookmark.id };
    }, roots.barId);
    const preview = await previewFirstRun(page, [roots.barTitle]); await confirmPreview(page, preview.previewId);
    await waitFirstRunProductQuiet(page, stack, KNS08_BINDINGS[0]);
    const count = (await liveCanonical(stack)).length;
    stack.setSyncOffline(true);
    await staleMove(page, ids.bookmark);
    await page.evaluate(async ids => { await chrome.bookmarks.move(ids.bookmark, { parentId: ids.folder }); }, ids);
    await expect.poll(async () => Boolean(await staleMove(page, ids.bookmark)), { timeout: 15_000 }).toBe(true);
    stack.setSyncOffline(false);
    await page.evaluate(() => chrome.runtime.sendMessage({ kind: 'known.connectivity.online' }));
    let head: Awaited<ReturnType<typeof staleMove>>;
    await expect.poll(async () => {
      head = await staleMove(page, ids.bookmark, true);
      return head?.code === 'revision_conflict' && !head.bound;
    }, { timeout: 30_000 }).toBe(true);
    await wakeEngine(page);
    await waitFirstRunProductQuiet(page, stack, KNS08_BINDINGS[0], 60_000);
    const nodes = await liveCanonical(stack);
    const moved = nodes.find(node => node.url === 'https://example.test/move')!;
    const folder = nodes.find(node => node.title === 'Destination')!;
    expect(moved.parent_id).toBe(folder.id); expect(nodes.length).toBe(count);
    expect(head!.opId).toBeTruthy(); expect(head!.sequence).toBeGreaterThan(0);
    const native = await page.evaluate(async id => (await chrome.bookmarks.get(id))[0], ids.bookmark);
    expect(native?.parentId).toBe(ids.folder);
  } finally { await context?.close(); await stack.close(); await rm(profile, { recursive: true, force: true }); }
});
