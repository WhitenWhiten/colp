import { test, expect, chromium, type Page, type BrowserContext } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { openExtensionOptions } from './extension-auth.js';
import { grantOptionalBookmarks } from './bookmark-permission.js';
const extensionPath = resolve(import.meta.dirname, '../dist/development'), extensionId = 'pplpnpegpnghcddhmpgkbfkdfadjiaen';
const status = (page: Page): Promise<any> => page.evaluate(() => chrome.runtime.sendMessage({ kind: 'known.siteAdapters.status' }));
async function nativeCounts(page: Page, root: string) {
  return page.evaluate(async id => {
    const tree = (await chrome.bookmarks.getSubTree(id))[0]!; let folders = 0; const urls: string[] = [];
    const walk = (n: chrome.bookmarks.BookmarkTreeNode) => { if (n.url) urls.push(n.url); else if (n.id !== id) folders++; for (const child of n.children ?? []) walk(child); };
    walk(tree); return { folders, urls: urls.sort() };
  }, root);
}
async function stopWorker(context: BrowserContext, page: Page) {
  const cdp = await context.newCDPSession(page), targets = await cdp.send('Target.getTargets');
  const worker = targets.targetInfos.find(t => t.type === 'service_worker' && t.url.includes(extensionId)); expect(worker).toBeTruthy();
  await cdp.send('Target.closeTarget', { targetId: worker!.targetId }); await cdp.detach();
}
async function waitQueue(page: Page) {
  await expect.poll(() => page.evaluate(async () => { const s = (await chrome.storage.local.get('known.siteAdapters.readQueue.v1'))['known.siteAdapters.readQueue.v1'] as { active?: unknown; nextAt?: number } | undefined;
    return !s?.active && (s?.nextAt ?? 0) <= Date.now(); })).toBe(true);
}
/** The page reads the collections on its own, following every page of them. */
async function loadCatalog(page: Page) {
  await expect(page.locator('#archive-collections input')).toHaveCount(205, { timeout: 60000 });
}
async function pickFolder(page: Page, id: string) {
  await page.locator('#archive-root').click(); await page.locator(`#archive-root-picker [data-folder-id="${id}"]`).click();
  await expect(page.locator('#archive-root')).toHaveAttribute('data-value', id);
}
test('source import prepares an exact partial preview in the background and preserves live work across worker restarts', async () => {
  test.setTimeout(240000);
  const profile = await mkdtemp(resolve(tmpdir(), 'known-site-import-'));
  const context = await chromium.launchPersistentContext(profile, { headless: false, channel: 'chromium', args: [
    `--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`,
  ] });
  const members = new Map([['101', [1]], ['202', [2]], ['305', [3, 9]]]); let modelCalls = 0;
  const cors = { 'access-control-allow-origin': 'https://www.bilibili.com', 'access-control-allow-credentials': 'true' };
  try {
    await context.route('https://provider.test/**', route => { modelCalls++; return route.fulfill({ status: 500, body: '{}' }); });
    await context.route('https://www.bilibili.com/**', route => route.fulfill({ contentType: 'text/html', body: '<title>Controlled import source</title>' }));
    await context.route('https://api.bilibili.com/x/web-interface/nav', route => route.fulfill({ contentType: 'application/json', headers: cors, body: JSON.stringify({ code: 0, data: { isLogin: true, mid: 42 } }) }));
    await context.route('https://api.bilibili.com/x/v3/fav/folder/created/list-all*', route => route.fulfill({ contentType: 'application/json', headers: cors,
      body: JSON.stringify({ code: 0, data: { list: Array.from({ length: 205 }, (_, i) => ({ id: i + 101, title: i === 0 ? 'A' : i === 101 ? 'B' : i === 204 ? 'C' : `Unselected ${i + 101}` })) } }) }));
    await context.route('https://api.bilibili.com/x/v3/fav/resource/ids*', route => {
      const u = new URL(route.request().url()), ids = u.searchParams.get('pn') === '1' ? members.get(u.searchParams.get('media_id')!) ?? [] : [];
      return route.fulfill({ contentType: 'application/json', headers: cors, body: JSON.stringify({ code: 0, data: ids.map(id => ({ id, type: 2 })) }) });
    });
    await context.route('https://api.bilibili.com/x/v3/fav/resource/infos*', route => {
      const ids = new URL(route.request().url()).searchParams.get('resources')!.split(',').map(p => Number(p.split(':')[0]));
      return route.fulfill({ contentType: 'application/json', headers: cors, body: JSON.stringify({ code: 0,
        data: ids.map(id => ({ id, type: 2, title: id === 9 ? '已失效视频' : `Video ${id}`, attr: id === 9 ? 9 : 1 })) }) });
    });
    await context.route('https://api.bilibili.com/x/v3/fav/resource/deal', route => {
      members.set('202', [2, 4]); return route.fulfill({ contentType: 'application/json', headers: cors, body: JSON.stringify({ code: 0 }) });
    });
    const { page } = await openExtensionOptions(context);
    const grants = { permissions: ['bookmarks', 'scripting', 'webNavigation'], origins: ['https://www.bilibili.com/*', 'https://provider.test/*'] };
    await page.evaluate(g => { const b = document.createElement('button'); b.id = 'grant-import-test'; b.textContent = 'Grant controlled source import access';
      b.onclick = () => { void chrome.permissions.request(g); }; document.body.prepend(b); }, grants);
    await grantOptionalBookmarks(page, page.locator('#grant-import-test'), 'Known source import test', grants);
    await page.evaluate(() => chrome.storage.local.set({ 'known.classification.local-enabled.v1': true,
      'known.classification.local-key.v1': { version: 3, generation: 'controlled', presetId: 'custom', endpoint: 'https://provider.test/v1/chat/completions', model: 'controlled', secret: 'controlled-value', disclosed: true } }));
    expect(await page.evaluate(() => chrome.runtime.sendMessage({ kind: 'known.bookmark.preferences.update', captureMode: 'automatic', aiTagMode: 'add', userGesture: true }))).toMatchObject({ ok: true });
    const root = await page.evaluate(async () => chrome.bookmarks.create({ parentId: (await chrome.bookmarks.getTree())[0]!.children![0]!.id, title: 'Controlled source import' }));
    const site = await context.newPage(); await site.goto('https://www.bilibili.com/video/av2');
    await page.goto(`chrome-extension://${extensionId}/site-adapters.html`); await page.bringToFront(); await page.locator('#enable').click();
    await expect.poll(async () => !!(await status(page)).candidateAccount).toBe(true);
    await page.locator('#refresh').click(); await page.locator('#confirm').click(); await expect.poll(async () => (await status(page)).documents).toBe(1);
    await loadCatalog(page);
    await pickFolder(page, root.id);
    for (const id of ['101', '202', '305']) await page.locator(`#archive-collections input[value="${id}"]`).check();
    await expect(page.locator('#archive-live')).toHaveAttribute('aria-checked', 'true'); await page.locator('#configure-archive').click();
    await expect.poll(async () => (await status(page)).archive.config?.state).toBe('active');
    expect(await nativeCounts(page, root.id)).toEqual({ folders: 0, urls: [] });
    const initialLease = (await page.evaluate(async () => (await chrome.storage.local.get('known.siteAdapters.runtime.v1'))['known.siteAdapters.runtime.v1'] as { leases: { id: string; documentId: string }[] })).leases[0]!;
    // Starting to sync starts the scan; the worker prepares its preview while Settings is closed.
    await expect.poll(async () => (await status(page)).archive.import?.phase).toBe('scanning');
    await page.goto(`chrome-extension://${extensionId}/options.html#bookmarks`);
    await expect.poll(async () => { const j = (await status(page)).archive.import; return j?.stage === 'items' && j.collectionIndex >= 2; }, { timeout: 75000 }).toBe(true);
    expect(await nativeCounts(page, root.id)).toEqual({ folders: 0, urls: [] });
    await site.evaluate(() => fetch('https://api.bilibili.com/x/v3/fav/resource/deal', { method: 'POST', credentials: 'include', body: new URLSearchParams({ rid: '4', type: '2', add_media_ids: '202' }) }));
    await expect.poll(async () => (await nativeCounts(page, root.id)).urls, { timeout: 45000 }).toEqual(['https://www.bilibili.com/video/av4']);
    // Observe a real lease renewal, then reuse a page-side cursor under its renewed transport.
    const bCursor = await page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => { const r = indexedDB.open('known-site-adapters'); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
      try { const rows = await new Promise<any[]>((resolve, reject) => { const r = db.transaction('importPages').objectStore('importPages').getAll(); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
        return rows.find(r => r.result?.kind === 'items' && r.result.collectionId === '202' && r.result.page.nextCursor)?.result.page.nextCursor as string;
      } finally { db.close(); }
    }); expect(bCursor).toBeTruthy();
    await expect.poll(async () => { const s = await page.evaluate(async () => (await chrome.storage.local.get('known.siteAdapters.runtime.v1'))['known.siteAdapters.runtime.v1'] as { leases: { id: string; documentId: string }[] });
      return s.leases.some(l => l.id !== initialLease.id && l.documentId === initialLease.documentId); }, { timeout: 75000 }).toBe(true);
    await expect.poll(async () => (await status(page)).archive.import.phase, { timeout: 30000 }).toBe('preview');
    await waitQueue(page);
    // A lease close to expiry is renewed first and the read waits; ask again until it starts.
    await expect.poll(async () => {
      const response = await page.evaluate(cursor => chrome.runtime.sendMessage({ kind: 'known.siteAdapters.inspect', operation: 'items', collectionId: '202', cursor }), bCursor) as { inspectionStatus?: { status: string } };
      return response.inspectionStatus?.status;
    },
      { timeout: 30000, intervals: [1500] }).toBe('reading');
    await expect.poll(async () => (await status(page)).inspection?.result?.status, { timeout: 15000 }).toBe('ok');
    expect((await status(page)).inspection.result).toMatchObject({ kind: 'items', collectionId: '202' });
    // Once the preview is ready, losing the source document and worker does not require another scan.
    await site.reload(); await stopWorker(context, page);
    await expect.poll(async () => (await status(page)).documents, { timeout: 30000 }).toBe(1);
    await expect.poll(async () => (await status(page)).archive.import?.phase, { timeout: 40000 }).toBe('preview');
    await page.goto(`chrome-extension://${extensionId}/site-adapters.html`);
    // The preview prepared in the background leads the page; settings are folded away.
    await expect.poll(async () => (await status(page)).archive.import?.phase, { timeout: 90000 }).toBe('preview');
    const frozen = (await status(page)).archive.import;
    expect(frozen.edgeCount).toBe(3); expect(frozen.omissions).toBe(1); expect(frozen.preview.coverage).toBe('partial');
    expect(frozen.preview.counts).toMatchObject({ createFolders: 2, createBookmarks: 3, reuseBookmarks: 0, review: 0 });
    expect((await nativeCounts(page, root.id)).urls).toEqual(['https://www.bilibili.com/video/av4']);
    // The collections read before the tab reloaded and the worker stopped still count: Save needs no second read.
    await page.locator('#site-configure').click();
    await loadCatalog(page);
    await page.locator('#archive-live').uncheck(); await page.locator('#configure-archive').click();
    await expect.poll(async () => (await status(page)).archive.config?.live).toBe(false);
    expect(await page.evaluate(j => chrome.runtime.sendMessage({ kind: 'known.siteAdapters.import.approve', jobId: j.id,
      previewId: j.preview.id, revision: j.preview.revision, digest: j.preview.digest }), frozen)).toMatchObject({ error: 'previewStale' });
    expect((await nativeCounts(page, root.id)).urls).toEqual(['https://www.bilibili.com/video/av4']);
    await page.locator('#freeze-import').click();
    await expect.poll(async () => { const j = (await status(page)).archive.import; return j?.phase === 'preview' && j.preview?.digest !== frozen.preview.digest; }).toBe(true);
    await page.locator('#refresh').click(); await page.locator('#approve-import').click();
    await expect.poll(async () => (await status(page)).archive.import?.phase, { timeout: 20000 }).toBe('completed');
    const final = await nativeCounts(page, root.id); expect(final).toEqual({ folders: 3, urls: [1, 2, 3, 4].map(i => `https://www.bilibili.com/video/av${i}`) });
    expect(modelCalls).toBe(0);
    await test.info().attach('source-import-acceptance.json', { body: Buffer.from(JSON.stringify({ schemaVersion: 1, fixture: true, realSite: false,
      browserVersion: context.browser()?.version(), observedAt: new Date().toISOString(), preapprovalImportWrites: 0, liveCopiesBeforeApproval: 1,
      restart: 'new document and CDP worker termination; prepared preview retained', collectedEdges: frozen.edgeCount, omittedRecords: frozen.omissions,
      sameDocumentLeaseContinuation: true, catalogPages: 3, selectedCollectionsAcrossPages: true, staleApprovalRejected: true, finalNativeFolders: final.folders, finalNativeBookmarks: final.urls.length, modelCalls }, null, 2)), contentType: 'application/json' });
  } finally { await context.close(); await rm(profile, { recursive: true, force: true }); }
});
