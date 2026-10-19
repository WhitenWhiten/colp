import { test, expect, chromium, type BrowserContext, type Page } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { EXTENSION_ID } from './extension-auth.js';
import { grantOptionalBookmarks } from './bookmark-permission.js';
import { grantTabAccess, openPopupOver } from './popup-page.js';

/**
 * Doc 17 RW-13 (RS-04, RS-05, RS-10): with no account, a rule set served from a `node:http` fixture on
 * 127.0.0.1 is subscribed to in Options; reading its site is granted in the Subscribe click; its role
 * gets a folder, and a save files by its entry, citing the version. A new version served later waits
 * as an update; Review shows what it adds and what it would do to recent bookmarks, Apply makes it
 * current (RW-14), and the next save follows it. The hourly refresh alarm is registered.
 */
const extensionPath = resolve(import.meta.dirname, '../dist/development');
const PAPER = 'https://arxiv.org/abs/2410.00003', SCHOLAR = 'https://scholar.example/paper/7';

function ruleset(version: string, extra: object[] = []): string {
  return JSON.stringify({ format: 'colp.ruleset/v1', id: 'community', name: 'Community papers', version,
    publisher: { name: 'Example Collective', url: null, feedbackUrl: null }, license: 'CC0-1.0',
    roles: [{ key: 'papers', description: 'Academic papers' }],
    sites: [{ id: 'arxiv', name: 'arXiv', addresses: [{ host: 'arxiv.org', scope: 'domain', status: 'current' }] }],
    entries: [{ id: 'e-arxiv', name: 'arXiv papers', site: 'arxiv', role: 'papers' }, ...extra] });
}

async function serve(): Promise<{ server: Server; url: string; origin: string; set(version: string, extra?: object[]): void; hits: string[] }> {
  let body = ruleset('1'), etag = '"1"';
  const hits: string[] = [];
  const server = createServer((request, response) => {
    hits.push(`${request.method} ${request.url} ${request.headers['if-none-match'] ?? ''}`.trim());
    if (request.url !== '/rules.json') { response.writeHead(404).end(); return; }
    if (request.headers['if-none-match'] === etag) { response.writeHead(304, { ETag: etag }).end(); return; }
    response.writeHead(200, { 'Content-Type': 'application/json', ETag: etag }).end(body);
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { server, url: `${origin}/rules.json`, origin, hits, set: (version, extra = []) => { body = ruleset(version, extra); etag = `"${version}"`; } };
}

async function launch(profile: string): Promise<BrowserContext> {
  return chromium.launchPersistentContext(profile, { headless: false, channel: 'chromium', args: [
    '--remote-debugging-port=0', `--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`,
  ] });
}
const state = (options: Page) => options.evaluate(async () => {
  const reply = await chrome.runtime.sendMessage({ kind: 'known.automation.state' }) as { state: { browserList: { entries: { kind: string;
    subscription?: { state: string; currentVersion: string | null; candidateVersion: string | null } }[] } } };
  return reply.state.browserList.entries.find((entry) => entry.kind === 'subscription')?.subscription ?? null;
});

test('a subscribed rule set files a save by its entry, and a reviewed new version takes over', async ({}, testInfo) => {
  test.setTimeout(180_000);
  const fixture = await serve();
  const profile = await mkdtemp(resolve(tmpdir(), 'known-rule-subscription-'));
  const context = await launch(profile);
  try {
    await context.route(/^https:\/\/(?:arxiv\.org|scholar\.example)\//u, (route) => route.fulfill({ contentType: 'text/html', body: '<title>A paper</title><p>Fixture</p>' }));
    const options = context.pages().find((page) => page.url().includes('/options.html')) ?? await context.newPage();
    await options.goto(`chrome-extension://${EXTENSION_ID}/options.html`);
    await expect(options.locator('body')).toHaveAttribute('data-pane', 'bookmarks');
    await grantOptionalBookmarks(options, 'Allow bookmark access', 'Known rule subscription');
    await grantTabAccess(context);
    const papers = await options.evaluate(() => chrome.bookmarks.create({ parentId: '1', title: 'Papers' }));
    await options.bringToFront();
    await options.locator('#nav-automations').click();
    await expect(options.locator('#automation-browser-heading')).toBeVisible();

    // The refresh alarm is there with no account (RS-04.3).
    expect(await options.evaluate(async () => (await chrome.alarms.get('known.automation.subscriptionRefresh'))?.periodInMinutes ?? null)).toBe(60);

    // Subscribe: reading the fixture's site is asked for in the Check click, then the file is checked.
    await options.locator('[data-subscribe]').click();
    const dialog = options.locator('dialog.automation-subscribe');
    await dialog.locator('input[type="url"]').fill(fixture.url);
    await grantOptionalBookmarks(options, dialog.getByRole('button', { name: 'Check', exact: true }), 'Known rule subscription site',
      { origins: [`${fixture.origin}/*`] });
    await expect(dialog).toContainText('Community papers · version 1 · Example Collective', { timeout: 20_000 });
    await dialog.locator('.folder-pill').click();
    await dialog.locator(`.folder-opt[data-folder-id="${papers.id}"]`).click();
    await dialog.getByRole('button', { name: 'Subscribe', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect.poll(() => state(options)).toMatchObject({ state: 'ready', currentVersion: '1', candidateVersion: null });
    const block = options.locator('.automation-subscription');
    await expect(block.locator('.rule-set-head .list-row-title')).toHaveText('Community papers');
    await expect(block.locator('[data-entry-id$=":e-arxiv"] .automation-recipe-folder')).toHaveText('Papers');
    await options.screenshot({ path: testInfo.outputPath('rule-subscription.png'), fullPage: true });

    // Offline, a save of an arXiv page goes where the entry files it, from the stored version.
    const paper = await context.newPage(); await paper.goto(PAPER);
    await context.setOffline(true);
    const popup = await openPopupOver(context, paper);
    await expect(popup.locator('#dest-folder')).toHaveText('Papers', { timeout: 20_000 });
    await popup.locator('#save').click();
    await expect.poll(() => options.evaluate((url) => chrome.bookmarks.search({ url }).then((nodes) => nodes[0]?.parentId ?? null), PAPER),
      { timeout: 30_000 }).toBe(papers.id);
    const saved = () => options.evaluate(() => chrome.runtime.sendMessage({ kind: 'known.capture.list' })) as Promise<{ tasks: { save: string; url: string }[] }>;
    await expect.poll(async () => (await saved()).tasks[0]?.save, { timeout: 15_000 }).toBe('local-saved');
    expect(await saved()).toMatchObject({ tasks: [expect.objectContaining({ automation: expect.objectContaining({ source: 'browser', outcome: 'placed',
      folderTitle: 'Papers', sourceName: 'Community papers', entry: expect.objectContaining({ kind: 'subscriptionEntry', entryId: 'e-arxiv', contentVersion: '1' }) }) })] });
    await context.setOffline(false);
    await popup.close(); await paper.close();

    // A new version: Refresh now keeps version 1 in force and shows the update waiting (RS-12.1).
    fixture.set('2', [{ id: 'e-scholar', name: 'Scholar', match: { kind: 'field', field: 'bookmark.url.host', op: 'eq', value: 'scholar.example' }, role: 'papers' }]);
    await options.bringToFront();
    const head = block.locator('.rule-set-head');
    await head.hover();
    await head.getByRole('button', { name: 'Refresh now' }).click();
    await expect.poll(() => state(options), { timeout: 20_000 }).toMatchObject({ currentVersion: '1', candidateVersion: '2' });
    await expect(head.locator('.badge')).toHaveText('Update available');
    // Every request was a GET of the subscribed address, the later ones with the ETag kept.
    expect(fixture.hits.every((hit) => hit.startsWith('GET /rules.json'))).toBe(true);
    expect(fixture.hits.at(-1)).toBe('GET /rules.json "1"');

    // Review: what version 2 adds, and what it would do to the bookmark already saved; Apply makes it current.
    await block.locator('[data-review]').click();
    const review = options.locator('dialog.automation-review');
    await expect(review).toContainText('Added (1)');
    await expect(review).toContainText('Scholar');
    await expect(review).toContainText('Your last bookmark would be filed the same way.');
    await options.screenshot({ path: testInfo.outputPath('rule-subscription-review.png') });
    await review.getByRole('button', { name: 'Apply version 2' }).click();
    await expect(review).toHaveCount(0);
    await expect.poll(() => state(options)).toMatchObject({ currentVersion: '2', candidateVersion: null });
    await expect(head.locator('.badge')).toHaveCount(0);

    // The next save goes by version 2's new entry.
    const second = await context.newPage(); await second.goto(SCHOLAR);
    await context.setOffline(true);
    const again = await openPopupOver(context, second);
    await expect(again.locator('#dest-folder')).toHaveText('Papers', { timeout: 20_000 });
    await again.locator('#save').click();
    await expect.poll(() => options.evaluate((url) => chrome.bookmarks.search({ url }).then((nodes) => nodes[0]?.parentId ?? null), SCHOLAR),
      { timeout: 30_000 }).toBe(papers.id);
    await expect.poll(async () => (await saved()).tasks.find((task) => task.url === SCHOLAR)?.save, { timeout: 15_000 }).toBe('local-saved');
    expect((await saved()).tasks.find((task) => task.url === SCHOLAR)).toMatchObject({ automation: expect.objectContaining({ outcome: 'placed',
      entry: expect.objectContaining({ kind: 'subscriptionEntry', entryId: 'e-scholar', contentVersion: '2' }) }) });
    await context.setOffline(false);
  } finally {
    await context.close(); await rm(profile, { recursive: true, force: true });
    await new Promise((done) => fixture.server.close(done));
  }
});
