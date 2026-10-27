import { test, expect, chromium, type Page } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { openExtensionOptions } from './extension-auth.js';
import { grantOptionalBookmarks } from './bookmark-permission.js';

const extensionPath = resolve(import.meta.dirname, '../dist/development');
interface Status {
  error?: string; candidateAccount?: string | null; documents: number;
  archive: { import: { id: string; phase: string; reason: string | null; edgeCount: number } | null };
}
const status = (page: Page): Promise<Status> => page.evaluate(() => chrome.runtime.sendMessage({ kind: 'known.siteAdapters.status' }) as Promise<Status>);

test('connection renewal and confirming an old blocked mapping preserve the complete scope and save without an open source tab', async () => {
  test.setTimeout(240000);
  const profile = await mkdtemp(resolve(tmpdir(), 'known-site-connection-'));
  const context = await chromium.launchPersistentContext(profile, { headless: false, channel: 'chromium', args: [
    `--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`,
  ] });
  const cors = { 'access-control-allow-origin': 'https://www.bilibili.com', 'access-control-allow-credentials': 'true' };
  let limited = true, delayProbe = false, sourceReads = 0;
  try {
    await context.route('https://www.bilibili.com/**', route => route.fulfill({ contentType: 'text/html', body: '<title>Connection recovery fixture</title>' }));
    await context.route('https://api.bilibili.com/**', async route => {
      const url = new URL(route.request().url());
      if (url.pathname.endsWith('/ids') || url.pathname.endsWith('/infos')) sourceReads++;
      if (url.pathname.endsWith('/nav') && delayProbe) await new Promise(resolve => setTimeout(resolve, 1000));
      if (url.pathname.endsWith('/ids') && url.searchParams.get('pn') === '2' && limited) {
        await route.fulfill({ status: 429, headers: cors, contentType: 'application/json', body: '{}' }); return;
      }
      const data = url.pathname.endsWith('/nav') ? { isLogin: true, mid: 42 }
        : url.pathname.endsWith('/list-all') ? { list: Array.from({ length: 22 }, (_, i) => ({ id: 101 + i, title: `Favorites ${i + 1}` })) }
        : url.pathname.endsWith('/ids') ? url.searchParams.get('media_id') === '101' && url.searchParams.get('pn') === '1' ? [{ id: 1, type: 2 }] : []
        : url.pathname.endsWith('/infos') ? [{ id: 1, type: 2, title: 'A saved video', attr: 0 }] : {};
      await route.fulfill({ contentType: 'application/json', headers: cors, body: JSON.stringify({ code: 0, data }) });
    });
    const { page, worker } = await openExtensionOptions(context);
    page.setDefaultTimeout(15000);
    const extensionOrigin = `chrome-extension://${new URL(worker.url()).hostname}`;
    const grants = { permissions: ['bookmarks', 'scripting', 'webNavigation'], origins: ['https://www.bilibili.com/*'] };
    await page.evaluate(grants => {
      const button = document.createElement('button'); button.id = 'grant-connection'; button.textContent = 'Allow source recovery';
      button.onclick = () => { void chrome.permissions.request(grants); }; document.body.prepend(button);
    }, grants);
    await grantOptionalBookmarks(page, page.locator('#grant-connection'), 'Source connection test', grants);
    const root = await page.evaluate(async () => chrome.bookmarks.create({ parentId: (await chrome.bookmarks.getTree())[0]!.children![0]!.id, title: 'Recovered archive' }));
    const site = await context.newPage(); await site.goto('https://www.bilibili.com/');
    await page.goto(`${extensionOrigin}/site-adapters.html`); await page.bringToFront(); await page.locator('#enable').click();
    await expect.poll(async () => (await status(page)).candidateAccount).toBe('42');
    await page.locator('#refresh').click(); await page.locator('#confirm').click();
    await expect(page.locator('#archive-collections input')).toHaveCount(22, { timeout: 30000 });
    await page.locator('#archive-root').click(); await page.locator(`#archive-root-picker [data-folder-id="${root.id}"]`).click();
    await page.locator('#archive-collections input[value="101"]').check();
    await page.locator('#configure-archive').click();
    await expect.poll(async () => (await status(page)).archive.import?.phase, { timeout: 30000 }).toBe('paused');
    const original = (await status(page)).archive.import!;
    expect(original).toMatchObject({ reason: 'rateLimited', edgeCount: 1 });
    // Re-enabling renews authority without changing the connected account or the paused task.
    for (const enabled of [false, true]) {
      const result = await page.evaluate(enabled => chrome.runtime.sendMessage({ kind: 'known.siteAdapters.enable', enabled }), enabled) as Status;
      expect(result.error).toBeUndefined();
    }
    await expect.poll(async () => (await status(page)).documents).toBe(1);
    // A tab being open does not mean its extension port is still connected.
    await page.evaluate(async () => {
      const tab = (await chrome.tabs.query({ url: ['https://www.bilibili.com/*'] }))[0]!;
      await chrome.scripting.executeScript({ target: { tabId: tab.id! }, world: 'ISOLATED',
        func: () => { window.dispatchEvent(new Event('known-site-adapter-stop:bundled.bilibili')); } });
    });
    await expect.poll(async () => (await status(page)).documents).toBe(0);
    await page.locator('#refresh').click();
    await expect(page.locator('#import-open-source')).toBeVisible();
    limited = false; delayProbe = true;
    await page.locator('#import-open-source').click();
    await expect(page.locator('#step-import')).toHaveAttribute('aria-busy', 'true');
    await expect(page.locator('#import-state')).toHaveText('Checking the Bilibili connection…');
    await expect(page.locator('#import-open-source')).toBeDisabled();
    await expect.poll(async () => (await status(page)).archive.import?.phase, { timeout: 45000 }).toBe('preview');
    expect((await status(page)).archive.import).toMatchObject({ id: original.id, edgeCount: 1 });
    await expect(page.locator('#site-problem')).toBeHidden();
    expect(context.pages().filter(p => p.url().startsWith('https://www.bilibili.com/'))).toHaveLength(1);
    expect(await page.evaluate(id => chrome.bookmarks.getChildren(id), root.id)).toEqual([]);
    // Restore the old release's all-blocked preview: there are source items but
    // no executable plans, and reviewCounts has not been introduced yet.
    const pagesBeforeRepair = await page.evaluate(async jobId => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('known-site-adapters'); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
      });
      try {
        const tx = db.transaction(['meta', 'importPreviews', 'importPages'], 'readwrite');
        const get = (store: string, key: string) => new Promise<any>((resolve, reject) => {
          const request = tx.objectStore(store).get(key); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
        });
        const job = await get('meta', `importJob:${jobId}`), preview = await get('importPreviews', job.previewId);
        // Retained legacy scope is deliberately larger than the one source item
        // needed for this browser fixture; the full 4,917-item flow has its own test.
        const selected = Array.from({ length: 22 }, (_, i) => String(101 + i));
        const configKey = `archiveConfig:${job.context.connectionId}`, config = await get('meta', configKey);
        tx.objectStore('meta').put({ ...config, collectionIds: selected }, configKey);
        job.selected = selected; job.found = selected; job.collectionIndex = selected.length;
        preview.counts = { createFolders: 0, createBookmarks: 0, reuseBookmarks: 0, review: 1 }; preview.planIds = []; delete preview.reviewCounts;
        const sample = preview.reviewSamples[0] ?? { itemId: 'video:av:1', collectionId: '101' };
        preview.reviewSamples = [{ ...sample, reason: 'sourceDestinationNeedsReview' }];
        const key = JSON.stringify(['frozenEdge', preview.id, sample.collectionId, sample.itemId]), edge = await get('importPages', key);
        tx.objectStore('importPages').put({ ...edge, planId: null, reviewReason: 'sourceDestinationNeedsReview' }, key);
        tx.objectStore('importPreviews').put(preview, preview.id);
        tx.objectStore('meta').put({ ...job, phase: 'attention', reason: 'sourceReviewRequired', counts: preview.counts }, `importJob:${jobId}`);
        await new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); });
        return job.pages as number;
      } finally { db.close(); }
    }, original.id);
    await page.reload();
    await expect(page.locator('#import-state')).toHaveText('The save location is blocking this import');
    await expect(page.locator('#approve-import')).toBeHidden();
    await expect(page.locator('#import-review-summary')).toContainText('individual videos do not need review');
    await expect(page.locator('#import-review-list .set-row')).toHaveCount(1);
    // Restore the other half of the reported state: the same account was
    // reconnected while the blocked task retained its previous generations.
    for (const enabled of [false, true]) await page.evaluate(enabled => chrome.runtime.sendMessage({ kind: 'known.siteAdapters.enable', enabled }), enabled);
    await expect.poll(async () => (await status(page)).documents).toBe(1);
    await site.close(); await expect.poll(async () => (await status(page)).documents).toBe(0);
    await page.evaluate(async taskId => {
      const catalogKey = 'known.siteAdapters.catalog.v1', activityKey = 'known.siteAdapters.activity.v1:bundled.bilibili';
      const stored = await chrome.storage.local.get([catalogKey, activityKey]);
      const catalog = stored[catalogKey] as any, activity = stored[activityKey] as any;
      catalog.items = catalog.items.slice(0, 1);
      activity.events.push({ id: crypto.randomUUID(), taskRef: taskId, kind: 'problem', operation: 'read', action: 'known.siteAdapters.import.freeze',
        code: 'sourceAuthorizationChanged', family: 'connection', firstAt: Date.now(), lastAt: Date.now(), occurrences: 1 });
      await chrome.storage.local.set({ [catalogKey]: catalog, [activityKey]: activity });
    }, original.id);
    await page.locator('#refresh').click();
    await expect(page.locator('#site-problem-what')).toContainText('access changed');
    const readsBeforeConfirmation = sourceReads;
    await page.locator('#import-edit-settings').click();
    await expect(page.locator('#configure-archive')).toBeEnabled();
    await page.locator('#configure-archive').click();
    await expect(page.locator('#site-settings-dialog')).not.toHaveAttribute('open');
    await expect.poll(async () => (await status(page)).archive.import?.phase, { timeout: 15000 }).toBe('preview');
    expect(sourceReads).toBe(readsBeforeConfirmation);
    expect(await page.evaluate(async () => (await chrome.runtime.sendMessage({ kind: 'known.siteAdapters.status' }) as any).archive.import.pages)).toBe(pagesBeforeRepair);
    const repaired = await page.evaluate(async () => chrome.runtime.sendMessage({ kind: 'known.siteAdapters.status' })) as any;
    expect(repaired.archive.config.collectionIds).toHaveLength(22); expect(repaired.archive.import.selected).toHaveLength(22);
    expect(repaired.archive.import.authorization).toBe('current');
    await expect(page.locator('#site-problem')).toBeHidden();
    await expect(page.locator('#approve-import')).toHaveText('Add 1 bookmark');
    await page.locator('#approve-import').click();
    await expect.poll(async () => (await status(page)).archive.import?.phase).toBe('completed');
    expect((await page.evaluate(id => chrome.bookmarks.getSubTree(id), root.id))[0]!.children![0]!.children?.map(n => n.url))
      .toEqual(['https://www.bilibili.com/video/av1']);
  } finally { await context.close(); await rm(profile, { recursive: true, force: true }); }
});
