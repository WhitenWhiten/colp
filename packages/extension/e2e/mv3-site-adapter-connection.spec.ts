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

test('a paused import reconnects an already open tab after authorization renewal, keeps its items, and gives immediate feedback', async () => {
  test.setTimeout(120000);
  const profile = await mkdtemp(resolve(tmpdir(), 'known-site-connection-'));
  const context = await chromium.launchPersistentContext(profile, { headless: false, channel: 'chromium', args: [
    `--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`,
  ] });
  const cors = { 'access-control-allow-origin': 'https://www.bilibili.com', 'access-control-allow-credentials': 'true' };
  let limited = true, delayProbe = false;
  try {
    await context.route('https://www.bilibili.com/**', route => route.fulfill({ contentType: 'text/html', body: '<title>Connection recovery fixture</title>' }));
    await context.route('https://api.bilibili.com/**', async route => {
      const url = new URL(route.request().url());
      if (url.pathname.endsWith('/nav') && delayProbe) await new Promise(resolve => setTimeout(resolve, 1000));
      if (url.pathname.endsWith('/ids') && url.searchParams.get('pn') === '2' && limited) {
        await route.fulfill({ status: 429, headers: cors, contentType: 'application/json', body: '{}' }); return;
      }
      const data = url.pathname.endsWith('/nav') ? { isLogin: true, mid: 42 }
        : url.pathname.endsWith('/list-all') ? { list: [{ id: 101, title: 'Favorites' }] }
        : url.pathname.endsWith('/ids') ? url.searchParams.get('pn') === '1' ? [{ id: 1, type: 2 }] : []
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
    await expect(page.locator('#archive-collections input')).toHaveCount(1, { timeout: 30000 });
    await page.locator('#archive-root').click(); await page.locator(`#archive-root-picker [data-folder-id="${root.id}"]`).click();
    await page.locator('#archive-collections input').check(); await page.locator('#configure-archive').click();
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
    await page.locator('#approve-import').click();
    await expect.poll(async () => (await status(page)).archive.import?.phase).toBe('completed');
    expect((await page.evaluate(id => chrome.bookmarks.getSubTree(id), root.id))[0]!.children![0]!.children?.map(n => n.url))
      .toEqual(['https://www.bilibili.com/video/av1']);
  } finally { await context.close(); await rm(profile, { recursive: true, force: true }); }
});
