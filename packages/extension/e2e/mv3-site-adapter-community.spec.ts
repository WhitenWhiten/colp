import { test, expect, chromium, type BrowserContext, type Page } from '@playwright/test';
import { mkdtemp, cp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { openExtensionOptions } from './extension-auth.js';
import { grantOptionalBookmarks } from './bookmark-permission.js';
import { packSiteAdapter } from '../scripts/pack-site-adapter.mjs';
const id = 'pplpnpegpnghcddhmpgkbfkdfadjiaen', origin = `chrome-extension://${id}`, adapterId = 'community.shelf';
const STATE = `known.siteAdapters.runtime.v1:${adapterId}`;
async function stopWorker(context: BrowserContext, page: Page) {
  const cdp = await context.newCDPSession(page), targets = await cdp.send('Target.getTargets');
  const worker = targets.targetInfos.find(t => t.type === 'service_worker' && t.url.includes(id));
  if (worker) await cdp.send('Target.closeTarget', { targetId: worker.targetId }); await cdp.detach();
}
// Shelf as the guide describes it (docs/site-adapters/adding-a-site.md): one Saved list per account, a Save button the site presses once saved.
const article = (slug: string) => `<!doctype html><meta name="shelf:user" content="42"><title>${slug}</title>
<article data-shelf-id="${slug}"><h1>${slug[0]!.toUpperCase()}${slug.slice(1)}</h1><button data-shelf-save aria-pressed="false">Save</button></article>
<script>document.querySelector('button').onclick = e => setTimeout(() => e.target.setAttribute('aria-pressed', 'true'), 200);</script>`;
async function shelfPackage(version: string) {
  const value = JSON.parse(await packSiteAdapter(resolve(import.meta.dirname, '../tests/fixtures/site-adapters/shelf-package')));
  value.manifest.version = version; return { name: `shelf-${version}.json`, mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(value)) };
}
test('an installed package is a full site: live saves, import, a worker restart, an update in a new world, and removal', async () => {
  test.setTimeout(180000);
  const directory = await mkdtemp(resolve(tmpdir(), 'colp-community-')), extension = resolve(directory, 'extension');
  await cp(resolve(import.meta.dirname, '../dist/development'), extension, { recursive: true });
  const context = await chromium.launchPersistentContext(resolve(directory, 'profile'), { headless: false, channel: 'chromium',
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  context.setDefaultTimeout(15000);
  try {
    await context.route('https://shelf.example/a/**', r => r.fulfill({ contentType: 'text/html', body: article(new URL(r.request().url()).pathname.split('/')[2]!) }));
    await context.route('https://shelf.example/api/saved*', r => r.fulfill({ contentType: 'application/json', body: JSON.stringify({ items: [{ slug: 'alpha', title: 'Alpha' }, { slug: 'beta', title: 'Beta' }], next: null }) }));
    const { page } = await openExtensionOptions(context);
    const grants = { permissions: ['bookmarks', 'userScripts', 'webNavigation'], origins: ['https://shelf.example/*'] };
    await page.evaluate(g => { const b = document.createElement('button'); b.id = 'grant-shelf'; b.textContent = 'Grant'; b.onclick = () => { void chrome.permissions.request(g); }; document.body.prepend(b); }, grants);
    await grantOptionalBookmarks(page, page.locator('#grant-shelf'), 'Shelf package', grants);
    const details = await context.newPage(); await details.goto(`chrome://extensions/?id=${id}`);
    const toggle = details.locator('extensions-toggle-row').filter({ hasText: 'Allow User Scripts' }).locator('cr-toggle');
    if (!await toggle.evaluate(n => (n as unknown as { checked: boolean }).checked)) await toggle.click();
    await expect.poll(() => toggle.evaluate(n => (n as unknown as { checked: boolean }).checked)).toBe(true);
    await stopWorker(context, page);
    const send = (message: Record<string, unknown>) => page.evaluate(m => chrome.runtime.sendMessage(m), message) as Promise<Record<string, any>>;
    const status = () => send({ kind: 'known.siteAdapters.status', adapterId });
    const leased = (url = 'https://shelf.example/a/alpha') => page.evaluate(({ key, url }) => chrome.storage.local.get(key)
      .then(v => (v[key] as { leases?: { url: string; expiresAt: number }[] } | undefined)?.leases?.some(l => l.url === url && l.expiresAt > Date.now() + 1000) ?? false), { key: STATE, url });
    const world = async () => (await page.evaluate(() => chrome.userScripts.getScripts())).find(s => s.id.startsWith('colp-user-'))?.worldId;
    const bookmarks = (url: string) => page.evaluate(u => chrome.bookmarks.search({ url: u }).then(v => v.map(b => b.title)), url);

    // Install: the reviewed package adds Shelf to the Sites list and opens its page.
    await page.goto(`${origin}/site-adapters.html#packages`);
    await expect.poll(async () => (await send({ kind: 'known.community.status' })).available).toBe(true);
    await page.locator('#community-file').setInputFiles(await shelfPackage('1.0.0'));
    await expect(page.locator('#community-preview')).toContainText('"adapterId": "community.shelf"');
    await expect(page.locator('#community-install')).toBeDisabled(); await page.locator('#community-ack').check(); await page.locator('#community-install').click();
    await expect(page).toHaveURL(`${origin}/site-adapters.html?adapterId=community.shelf#sync`);
    await expect(page.locator(`#site-list [data-adapter-id="${adapterId}"]`)).toContainText('Shelf');
    await expect(page.locator('#site-title')).toHaveText('Shelf'); await expect(page.locator('#tab-cloud')).toBeHidden();
    expect(await world()).toBeUndefined(); // Off until turned on, like a built-in site.

    // Logging in within the same document is detected without reloading the site or Settings.
    const site = await context.newPage(); await site.goto('https://shelf.example/a/alpha');
    await site.locator('meta[name="shelf:user"]').evaluate(meta => meta.setAttribute('content', '0'));
    const bilibiliBefore = await send({ kind: 'known.siteAdapters.status', adapterId: 'bundled.bilibili' });
    await page.bringToFront();
    await page.locator('#enable').click();
    await expect(page.locator('#connection-title')).toHaveText('Open Shelf and sign in');
    expect((await status()).candidateAccount).toBeNull();
    await site.bringToFront();
    await site.locator('meta[name="shelf:user"]').evaluate(meta => meta.setAttribute('content', '42'));
    await expect.poll(async () => (await status()).candidateAccount, { timeout: 20000 }).toBe('42');
    await page.bringToFront(); await expect(page.locator('#confirm')).toBeVisible();
    await expect(page.locator('#connection-title')).toHaveText('Confirm the account detected on Shelf');
    await page.locator('#confirm').click();
    await expect.poll(async () => (await status()).documents, { timeout: 20000 }).toBe(1);
    expect((await send({ kind: 'known.siteAdapters.status', adapterId: 'bundled.bilibili' })).enabled).toBe(bilibiliBefore.enabled);
    const root = await page.evaluate(async () => chrome.bookmarks.create({ parentId: (await chrome.bookmarks.getTree())[0]!.children![0]!.id, title: 'Shelf archive' }));
    expect(await send({ kind: 'known.siteAdapters.archive.configure', adapterId, rootNativeId: root.id, collectionIds: ['saved'], live: true })).toMatchObject({ archiveResult: { configured: true }, writes: true });
    await expect.poll(() => leased(), { timeout: 20000 }).toBe(true);

    // The package's world has messaging to the host and nothing else of the extension.
    const firstWorld = (await world())!;
    const run = (code: string, worldId: string) => page.evaluate(async ({ code, worldId }) => {
      const tab = (await chrome.tabs.query({ url: ['https://shelf.example/*'] }))[0]!;
      const result = await chrome.userScripts.execute({ target: { tabId: tab.id! }, world: 'USER_SCRIPT', worldId, js: [{ code }], injectImmediately: true });
      return result[0]?.error ? { error: result[0].error } : result[0]?.result;
    }, { code, worldId });
    expect(await run('[typeof chrome.bookmarks, typeof chrome.storage, typeof chrome.runtime.sendMessage, typeof globalThis.__knownCommunityAdapter]', firstWorld))
      .toEqual(['undefined', 'undefined', 'function', 'undefined']);

    // A live save becomes a bookmark in the chosen folder; the import then reuses it.
    await site.locator('[data-shelf-save]').click();
    await expect.poll(() => bookmarks('https://shelf.example/a/alpha'), { timeout: 15000 }).toEqual(['Alpha']);
    expect(await page.evaluate(id => chrome.bookmarks.getChildren(id).then(v => v.map(b => b.title)), root.id)).toEqual(['Saved']);
    await send({ kind: 'known.siteAdapters.import.start', adapterId });
    await expect.poll(async () => (await status()).archive?.import?.preview?.counts, { timeout: 30000 }).toEqual({ createFolders: 0, createBookmarks: 1, reuseBookmarks: 1, review: 0 });

    // Status must count a reattached port, not the stopped worker's retained lease.
    // A new live favorite also saves while the earlier bulk import awaits approval.
    await stopWorker(context, page);
    await expect.poll(async () => (await status()).documents, { timeout: 20000 }).toBe(1);
    await site.evaluate(() => {
      document.querySelector('article')!.setAttribute('data-shelf-id', 'gamma');
      document.querySelector('h1')!.textContent = 'Gamma';
      document.querySelector('button')!.setAttribute('aria-pressed', 'false');
    });
    await site.locator('[data-shelf-save]').click();
    await expect.poll(() => bookmarks('https://shelf.example/a/gamma'), { timeout: 20000 }).toEqual(['Gamma']);
    expect((await status()).archive?.import?.phase).toBe('preview');
    await site.goto('https://shelf.example/a/gamma');
    await expect.poll(() => leased('https://shelf.example/a/gamma'), { timeout: 20000 }).toBe(true);
    await site.locator('[data-shelf-save]').click();
    await expect.poll(() => bookmarks('https://shelf.example/a/gamma'), { timeout: 20000 }).toEqual(['Gamma']);

    // An update runs in a new world; the site stays on and the open page reattaches. The old credential grants nothing.
    const oldCredential = await page.evaluate(() => chrome.storage.local.get('known.siteAdapters.community.v1').then(v => (v['known.siteAdapters.community.v1'] as { installations: { credential: string }[] }).installations[0]!.credential));
    await page.goto(`${origin}/site-adapters.html?adapterId=${adapterId}#packages`);
    await page.locator('#community-file').setInputFiles(await shelfPackage('1.0.1'));
    await page.locator('#community-ack').check();
    // Same page with a new hash: Settings reloads it so the sidebar and site page read the updated package.
    await Promise.all([page.waitForEvent('load'), page.locator('#community-install').click()]);
    await expect(page).toHaveURL(`${origin}/site-adapters.html?adapterId=community.shelf#sync`);
    await expect.poll(world).not.toBe(firstWorld);
    expect((await status()).enabled).toBe(true);
    await expect.poll(async () => (await status()).documents, { timeout: 20000 }).toBe(1);
    await page.evaluate(worldId => chrome.userScripts.configureWorld({ worldId, messaging: true }), firstWorld); // A surviving old world, as if cleanup failed.
    expect(await run(`chrome.runtime.sendMessage(${JSON.stringify({ kind: 'known.siteAdapters.activation', adapterId, installationCredential: oldCredential })})`, firstWorld))
      .toMatchObject({ status: 'unavailable' });
    expect(await run('chrome.runtime.sendMessage({ kind: "known.community.status" })', firstWorld)).toMatchObject({ status: 'unavailable' });

    // Removing the package turns its site off and takes it out of the Sites list. Bookmarks stay.
    await page.goto(`${origin}/site-adapters.html?adapterId=${adapterId}#packages`);
    await Promise.all([page.waitForEvent('load'), page.getByRole('button', { name: 'Remove package' }).click()]);
    await expect(page.locator(`#site-list [data-adapter-id="${adapterId}"]`)).toHaveCount(0);
    await expect.poll(world).toBeUndefined();
    expect(await page.evaluate(key => chrome.storage.local.get(key).then(v => (v[key] as { enabled: boolean }).enabled), STATE)).toBe(false);
    expect(await bookmarks('https://shelf.example/a/alpha')).toEqual(['Alpha']);
  } finally { await context.close(); await rm(directory, { recursive: true, force: true }); }
});
