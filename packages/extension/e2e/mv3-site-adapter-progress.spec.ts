import { test, expect, chromium, type Page } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { openExtensionOptions } from './extension-auth.js';
import { grantOptionalBookmarks } from './bookmark-permission.js';

const extensionPath = resolve(import.meta.dirname, '../dist/development'), extensionId = 'pplpnpegpnghcddhmpgkbfkdfadjiaen';
interface SiteStatus { candidateAccount?: string | null; archive: { import?: { id: string; phase: string } | null } }
const status = (page: Page): Promise<SiteStatus> => page.evaluate(() => chrome.runtime.sendMessage({ kind: 'known.siteAdapters.status' }) as Promise<SiteStatus>);

test('favorites become a preview in the background, skip deleted videos, and show a compact task before settings', async () => {
  test.setTimeout(180000);
  const profile = await mkdtemp(resolve(tmpdir(), 'known-site-progress-'));
  const context = await chromium.launchPersistentContext(profile, { headless: false, channel: 'chromium', viewport: { width: 1280, height: 900 }, args: [
    `--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`,
  ] });
  const cors = { 'access-control-allow-origin': 'https://www.bilibili.com', 'access-control-allow-credentials': 'true' };
  let limitReads = false, sharedItems = false;
  try {
    await context.route('https://www.bilibili.com/**', route => route.fulfill({ contentType: 'text/html', body: '<title>Controlled favorites</title>' }));
    await context.route('https://api.bilibili.com/**', route => {
      const url = new URL(route.request().url());
      if (limitReads && url.pathname.endsWith('/ids')) return route.fulfill({ status: 429, headers: { ...cors, 'retry-after': '2' }, contentType: 'application/json', body: '{"private":"not-for-diagnostics"}' });
      const data = url.pathname.endsWith('/nav') ? { isLogin: true, mid: 42 }
        : url.pathname.endsWith('/list-all') ? { list: [{ id: 101, title: 'Favorites' }, ...sharedItems ? [{ id: 102, title: 'Shared favorites' }] : []] }
        : url.pathname.endsWith('/ids') ? url.searchParams.get('pn') === '1' ? [{ id: 1, type: 2 }, { id: 9, type: 2 }, ...sharedItems ? [{ id: 2, type: 2 }] : []] : []
        : url.pathname.endsWith('/infos') ? [{ id: 1, type: 2, title: 'A useful video', attr: 0 }, { id: 9, type: 2, title: '已失效视频', attr: 9 },
          ...sharedItems ? [{ id: 2, type: 2, title: 'A shared video', attr: 0 }] : []] : {};
      return route.fulfill({ contentType: 'application/json', headers: cors, body: JSON.stringify({ code: 0, data }) });
    });
    const { page } = await openExtensionOptions(context);
    const grants = { permissions: ['bookmarks', 'scripting', 'webNavigation'], origins: ['https://www.bilibili.com/*'] };
    await page.evaluate(g => {
      const b = document.createElement('button'); b.id = 'grant-site-progress'; b.textContent = 'Allow controlled favorites';
      b.onclick = () => { void chrome.permissions.request(g); }; document.body.prepend(b);
    }, grants);
    await grantOptionalBookmarks(page, page.locator('#grant-site-progress'), 'Site progress test', grants);
    const root = await page.evaluate(async () => chrome.bookmarks.create({ parentId: (await chrome.bookmarks.getTree())[0]!.children![0]!.id, title: 'Adapter destination' }));
    const site = await context.newPage(); await site.goto('https://www.bilibili.com/');
    await page.goto(`chrome-extension://${extensionId}/site-adapters.html`);
    await page.bringToFront();
    await page.locator('#enable').click();
    await expect.poll(async () => !!(await status(page)).candidateAccount).toBe(true);
    await page.locator('#refresh').click(); await page.locator('#confirm').click();
    await expect(page.locator('#archive-collections input')).toHaveCount(1, { timeout: 30000 });
    await page.locator('#archive-root').click();
    await page.locator(`#archive-root-picker [data-folder-id="${root.id}"]`).click();
    await page.locator('#archive-collections input').check();
    await page.locator('#configure-archive').click();
    await expect.poll(async () => (await status(page)).archive.import?.phase).toBe('scanning');
    // The worker must make the preview even while this UI is closed.
    await page.goto(`chrome-extension://${extensionId}/options.html`);
    await expect.poll(async () => (await status(page)).archive.import?.phase, { timeout: 45000 }).toBe('preview');
    expect(await page.evaluate(id => chrome.bookmarks.getChildren(id), root.id)).toEqual([]);
    await page.goto(`chrome-extension://${extensionId}/site-adapters.html`);
    await expect(page.locator('#import-state')).toContainText('1');
    await expect(page.locator('#site-settings-dialog')).not.toHaveAttribute('open');
    await expect(page.locator('#overview-result')).toContainText('0 bookmarks');
    await expect(page.locator('#import-omissions-title')).toContainText('1');
    await expect(page.locator('#import-badge')).toBeHidden();
    await expect(page.locator('#overview-mappings [role="row"]')).toHaveCount(1);
    expect((await page.locator('#approve-import').boundingBox())!.y).toBeLessThan(900);
    await page.locator('#approve-import').click();
    await expect.poll(async () => (await status(page)).archive.import?.phase, { timeout: 30000 }).toBe('completed');
    const tree = await page.evaluate(id => chrome.bookmarks.getSubTree(id), root.id);
    expect(tree[0]!.children).toHaveLength(1);
    expect(tree[0]!.children![0]!.children?.map(n => n.url)).toEqual(['https://www.bilibili.com/video/av1']);
    await expect(page.locator('#import-state')).toHaveText('This check is complete');
    await expect(page.locator('#overview-result')).toContainText('1 bookmark');
    await page.locator('#site-history').evaluate((node: HTMLDetailsElement) => { node.open = true; });
    await expect(page.locator('#site-activity-list')).toContainText('Bookmark saves confirmed');
    // Errors survive a page reload, copy their original incident, and remain traceable after a successful retry.
    limitReads = true;
    await page.locator('#start-import').click();
    await expect.poll(async () => (await status(page)).archive.import?.phase, { timeout: 45000 }).toBe('paused');
    await expect(page.locator('#site-problem')).toBeVisible();
    const failedRun = (await status(page)).archive.import!.id;
    await page.reload();
    await expect(page.locator('#site-problem')).toBeVisible();
    await page.evaluate(() => {
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => {
        (globalThis as unknown as { siteReport: string }).siteReport = text;
      } } });
    });
    await page.locator('#problem-copy').click();
    const copied = await page.evaluate(() => (globalThis as unknown as { siteReport: string }).siteReport);
    const report = JSON.parse(copied);
    expect(report.incident).toMatchObject({ operation: 'read', code: 'rateLimited', httpStatus: 429, taskRef: failedRun });
    for (const secret of ['not-for-diagnostics', 'A useful video', 'Adapter destination', 'accountId', 'capability', 'accessToken']) expect(copied).not.toContain(secret);
    limitReads = false;
    await page.locator('#resume-import').click();
    await expect.poll(async () => (await status(page)).archive.import?.phase, { timeout: 45000 }).toBe('preview');
    await expect(page.locator('#site-problem')).toBeHidden();
    const recovered = await page.evaluate(id => chrome.runtime.sendMessage({ kind: 'known.siteAdapters.activity.report', id }), report.incident.id) as { report: { incident: { firstAt: number; resolvedAt: number } } };
    expect(recovered.report.incident.firstAt).toBe(report.incident.firstAt);
    expect(recovered.report.incident.resolvedAt).toBeGreaterThanOrEqual(report.incident.firstAt);
    // A single-copy conflict has a readable item list and a durable reason, not a dead-end attention label.
    await page.locator('#cancel-import').click();
    sharedItems = true;
    await page.locator('#site-configure').click();
    await page.locator('#read-catalog').click();
    await expect(page.locator('#archive-collections input')).toHaveCount(2, { timeout: 30000 });
    await page.locator('#archive-collections input[value="102"]').check();
    await page.locator('#archive-options').evaluate((node: HTMLDetailsElement) => { node.open = true; });
    await page.locator('#archive-copies').selectOption('singleKeepExisting');
    await page.locator('#configure-archive').click();
    await page.locator('#start-import').click();
    await expect.poll(async () => (await status(page)).archive.import?.phase, { timeout: 45000 }).toBe('preview');
    await page.locator('#approve-import').click();
    await expect.poll(async () => (await status(page)).archive.import?.phase).toBe('attention');
    await page.locator('#import-review-items').click();
    await expect(page.locator('#import-review')).toBeVisible();
    await expect(page.locator('#import-review-list')).toContainText('A shared video');
    await expect(page.locator('#import-review-list')).toContainText('Choose its primary collection');
    await expect(page.locator('#import-review-list')).not.toContainText('primarySourceCollectionRequired');
    await page.locator('#problem-copy').click();
    const reviewReport = await page.evaluate(() => (globalThis as unknown as { siteReport: string }).siteReport);
    expect(JSON.parse(reviewReport).incident.review).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'primarySourceCollectionRequired' })]));
    expect(reviewReport).not.toContain('A shared video');
  } finally { await context.close(); await rm(profile, { recursive: true, force: true }); }
});
