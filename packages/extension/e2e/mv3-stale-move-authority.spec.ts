import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { KNS08_BINDINGS, confirmPreview, grantBookmarks, launchPersistent, liveCanonical, login,
  optionsPage, previewFirstRun, specialRoots, startRealStack, wakeEngine,
  waitFirstRunProductQuiet } from './kns-08-harness.js';

// Marks the bookmark's mapping with an obsolete Snapshot revision unless
// `readOnly`, and returns the live (non-terminal) move row for it, if any.
async function staleMove(page: Page, nativeId: string, readOnly = false) {
  return page.evaluate(async ({ nativeId, readOnly }) => {
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
      if (!readOnly) mappings.put({ ...mapping, projection: { ...mapping.projection,
        revision: 'obsolete-snapshot-revision', resourceRevision: 'obsolete-snapshot-revision' } });
      const row = (await read(queue.getAll())).find((row: any) => row.payload?.type === 'move_node'
        && row.payload?.targetId === mapping.colpId && row.status !== 'terminal');
      await done;
      return row ? { opId: row.opId, sequence: row.sequence, code: row.recovery?.code } : null;
    } finally { db.close(); }
  }, { nativeId, readOnly });
}

// A move owns placement only: the server rebases it on locked current state
// instead of denying the obsolete base revision (protocol/docs/03-sync.md).
test('an old Snapshot move is rebased onto the current server placement through real Push', async () => {
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
    const head = (await staleMove(page, ids.bookmark, true))!;
    expect(head.opId).toBeTruthy(); expect(head.sequence).toBeGreaterThan(0);
    stack.setSyncOffline(false);
    await page.evaluate(() => chrome.runtime.sendMessage({ kind: 'known.connectivity.online' }));
    await wakeEngine(page);
    await waitFirstRunProductQuiet(page, stack, KNS08_BINDINGS[0], 60_000);
    expect(await staleMove(page, ids.bookmark, true)).toBeNull();
    const receipts = (await stack.observations(KNS08_BINDINGS[0].replicaId)).sequenceReceipts as
      Array<{ op_id: string; result_json: { results?: Array<{ opId: string; status: string }> } }>;
    const receipt = receipts.find(row => row.op_id === head.opId)?.result_json;
    expect(receipt?.results?.find(row => row.opId === head.opId)?.status).toBe('rebased');
    const nodes = await liveCanonical(stack);
    const moved = nodes.find(node => node.url === 'https://example.test/move')!;
    const folder = nodes.find(node => node.title === 'Destination')!;
    expect(moved.parent_id).toBe(folder.id); expect(nodes.length).toBe(count);
    const native = await page.evaluate(async id => (await chrome.bookmarks.get(id))[0], ids.bookmark);
    expect(native?.parentId).toBe(ids.folder);
  } finally { await context?.close(); await stack.close(); await rm(profile, { recursive: true, force: true }); }
});
