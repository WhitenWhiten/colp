import { test, expect, chromium, type Page } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { grantOptionalBookmarks } from './bookmark-permission.js';
import { openExtensionOptions } from './extension-auth.js';

const extensionPath = resolve(import.meta.dirname, '../dist/development');
interface Lease { id: string; documentId: string; tabId: number; routeEpoch: number; url: string }
interface SiteStatus { candidateAccount: string | null; archive: { import: { id: string; phase: string; reason: string | null; edgeCount: number; omissions: number } | null } }
const status = (page: Page): Promise<SiteStatus> => page.evaluate(() => chrome.runtime.sendMessage({ kind: 'known.siteAdapters.status' }) as Promise<SiteStatus>);
const leases = (page: Page): Promise<Lease[]> => page.evaluate(async () =>
  ((await chrome.storage.local.get('known.siteAdapters.runtime.v1'))['known.siteAdapters.runtime.v1'] as { leases: Lease[] }).leases);

test('multi-tab imports keep their document-local cursor through repeated lease renewals', async () => {
  test.setTimeout(240000);
  const profile = await mkdtemp(resolve(tmpdir(), 'known-site-renewal-'));
  const context = await chromium.launchPersistentContext(profile, { headless: false, channel: 'chromium', args: [
    `--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`,
  ] });
  const cors = { 'access-control-allow-origin': 'https://www.bilibili.com', 'access-control-allow-credentials': 'true' };
  let importPage: Page | undefined, origin: Lease | undefined, holdRenewal = false, delayedRenewals = 0;
  const readers: Page[] = [], renewals = new Set<string>();
  try {
    await context.route('https://www.bilibili.com/**', route => route.fulfill({ contentType: 'text/html', body: '<title>Controlled renewal source</title>' }));
    await context.route('https://api.bilibili.com/**', async route => {
      const url = new URL(route.request().url()), source = route.request().frame().page();
      if (url.pathname.endsWith('/nav') && holdRenewal && source === importPage && origin) {
        const current = (await leases(page)).find(l => l.documentId === origin!.documentId);
        // Bootstrap runs after disconnecting the old lease. Make that gap span a worker wake.
        if (!current && delayedRenewals < 2) { delayedRenewals++; await new Promise(resolve => setTimeout(resolve, 3500)); }
      }
      if (url.pathname.endsWith('/ids') || url.pathname.endsWith('/infos')) readers.push(source);
      const ids = url.searchParams.get('resources')?.split(',').map(value => Number(value.split(':')[0])) ?? [];
      const data = url.pathname.endsWith('/nav') ? { isLogin: true, mid: 42 }
        : url.pathname.endsWith('/list-all') ? { list: [{ id: 101, title: 'Favorites' }] }
        : url.pathname.endsWith('/ids') ? Array.from({ length: url.searchParams.get('pn') === '1' ? 1000 : url.searchParams.get('pn') === '2' ? 400 : 0 },
          (_, i) => ({ id: i + 1 + (url.searchParams.get('pn') === '2' ? 1000 : 0), type: 2 }))
        : url.pathname.endsWith('/infos') ? ids.map(id => ({ id, type: 2, title: `Video ${id}`, attr: id % 20 === 0 ? 9 : 0 })) : {};
      await route.fulfill({ contentType: 'application/json', headers: cors, body: JSON.stringify({ code: 0, data }) });
    });
    const { page, worker } = await openExtensionOptions(context);
    page.setDefaultTimeout(15000);
    const extensionOrigin = `chrome-extension://${new URL(worker.url()).hostname}`;
    const grants = {
      permissions: ['bookmarks', 'scripting', 'webNavigation'], origins: ['https://www.bilibili.com/*'],
    };
    await page.evaluate(grants => {
      const button = document.createElement('button'); button.id = 'grant-renewal'; button.textContent = 'Allow controlled renewal';
      button.onclick = () => { void chrome.permissions.request(grants); }; document.body.prepend(button);
    }, grants);
    await grantOptionalBookmarks(page, page.locator('#grant-renewal'), 'Site renewal test', grants);
    const root = await page.evaluate(async () => chrome.bookmarks.create({ parentId: (await chrome.bookmarks.getTree())[0]!.children![0]!.id, title: 'Renewal archive' }));
    const site = await context.newPage(); await site.goto('https://www.bilibili.com/video/av1');
    await page.goto(`${extensionOrigin}/site-adapters.html`); await page.bringToFront(); await page.locator('#enable').click();
    await expect.poll(async () => (await status(page)).candidateAccount).toBe('42');
    await page.locator('#refresh').click(); await page.locator('#confirm').click();
    await expect(page.locator('#archive-collections input')).toHaveCount(1, { timeout: 30000 });
    await page.locator('#archive-root').click(); await page.locator(`#archive-root-picker [data-folder-id="${root.id}"]`).click();
    await page.locator('#archive-collections input').check(); await page.locator('#configure-archive').click();
    await expect.poll(async () => (await status(page)).archive.import?.edgeCount, { timeout: 30000 }).toBeGreaterThan(0);
    origin = (await leases(page))[0]!; importPage = site; renewals.add(origin.id);
    const second = await context.newPage(); await second.goto('https://www.bilibili.com/video/av2');
    await expect.poll(async () => (await leases(page)).length, { timeout: 15000 }).toBe(2);
    holdRenewal = true;
    await expect.poll(async () => {
      const current = (await leases(page)).find(l => l.documentId === origin!.documentId);
      if (current) renewals.add(current.id);
      const job = (await status(page)).archive.import!;
      return job.phase === 'paused' && job.reason !== 'scanFinished' ? 'paused' : job.phase === 'preview' ? 'preview' : 'reading';
    }, { timeout: 210000, intervals: [500] }).toMatch(/^(paused|preview)$/);
    expect((await status(page)).archive.import).toMatchObject({ phase: 'preview', reason: null });
    expect(delayedRenewals).toBe(2); expect(renewals.size).toBeGreaterThanOrEqual(3);
    expect(new Set(readers)).toEqual(new Set([site]));
    expect((await status(page)).archive.import).toMatchObject({ edgeCount: 1330, omissions: 70 });
    expect(await page.evaluate(id => chrome.bookmarks.getChildren(id), root.id)).toEqual([]);
  } finally { await context.close(); await rm(profile, { recursive: true, force: true }); }
});
