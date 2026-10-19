import { test, expect, chromium, type BrowserContext, type Page } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { EXTENSION_ID } from './extension-auth.js';
import { grantOptionalBookmarks } from './bookmark-permission.js';

/**
 * Doc 17 RW-17 (RS-16.3, RS-17.4, R12): with no account, a `colp.risklist/v1` list served from a
 * `node:http` fixture on 127.0.0.1 is subscribed to, and risk alerts are switched to *while I browse*,
 * which asks for `tabs` and `webNavigation` in the switch. A tab that opens a listed page gets "!" on the
 * Know-N button; a second page of that domain in the same tab within 10 minutes gets none; another tab
 * gets its own. Switching back to saves only clears the badges.
 */
const extensionPath = resolve(import.meta.dirname, '../dist/development');

const risklist = JSON.stringify({ format: 'colp.risklist/v1', id: 'example-phishing', name: 'Example phishing list', version: '1',
  entries: [{ scope: 'domain', value: 'login-example-support.com', kind: 'phishing', since: '2026-10-17T00:00:00Z', expires: null, evidenceUrl: null }] });

async function serve(): Promise<{ server: Server; url: string; origin: string }> {
  const server = createServer((request, response) => {
    if (request.url !== '/risk.json') { response.writeHead(404).end(); return; }
    response.writeHead(200, { 'Content-Type': 'application/json' }).end(risklist);
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { server, url: `${origin}/risk.json`, origin };
}
async function launch(profile: string): Promise<BrowserContext> {
  return chromium.launchPersistentContext(profile, { headless: false, channel: 'chromium', args: [
    '--remote-debugging-port=0', `--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`,
  ] });
}
const mode = (options: Page) => options.evaluate(async () => (await chrome.runtime.sendMessage({ kind: 'known.risk.state' }) as { state: { mode: string } }).state.mode);
/** The badge the Know-N button shows on the tab that has `url` open. */
const badgeOn = (options: Page, url: string) => options.evaluate(async (wanted) => {
  const tab = (await chrome.tabs.query({})).find((item) => item.url === wanted);
  return tab?.id === undefined ? null : chrome.action.getBadgeText({ tabId: tab.id });
}, url);

test('a listed page puts ! on its tab once, not again on the same domain within the window', async ({}, testInfo) => {
  test.setTimeout(150_000);
  const fixture = await serve();
  const profile = await mkdtemp(resolve(tmpdir(), 'known-risk-browse-'));
  const context = await launch(profile);
  try {
    await context.route(/^https:\/\/(?:[a-z]+\.)?(?:login-example-support\.com|example\.org)\//u,
      (route) => route.fulfill({ contentType: 'text/html', body: '<title>Fixture</title><p>Fixture</p>' }));
    const options = context.pages().find((page) => page.url().includes('/options.html')) ?? await context.newPage();
    await options.goto(`chrome-extension://${EXTENSION_ID}/options.html#automations`);
    const risk = options.locator('#automation-risk');
    await expect(risk.locator('.risk-mode input[value="off"]')).toBeChecked({ timeout: 20_000 });

    // The list, its site allowed in the Subscribe click.
    await risk.locator('[data-risk-subscribe]').click();
    const dialog = options.locator('dialog.automation-config-dialog');
    await dialog.locator('input[type="url"]').fill(fixture.url);
    await grantOptionalBookmarks(options, dialog.getByRole('button', { name: 'Subscribe', exact: true }), 'Known risk browse list', { origins: [`${fixture.origin}/*`] });
    await expect(dialog).toHaveCount(0, { timeout: 20_000 });
    await expect(risk.locator('[data-risk-list] .list-row-title')).toHaveText('Example phishing list');

    // While browsing: tabs and webNavigation are asked for in the switch.
    await grantOptionalBookmarks(options, risk.getByText('When I save, and while I browse', { exact: true }), 'Known risk browse mode',
      { permissions: ['tabs', 'webNavigation'] });
    await expect.poll(() => mode(options), { timeout: 15_000 }).toBe('onSaveAndBrowse');
    await expect(risk.locator('.risk-mode input[value="onSaveAndBrowse"]')).toBeChecked();
    await risk.scrollIntoViewIfNeeded();
    await options.screenshot({ path: testInfo.outputPath('risk-browse-settings.png'), fullPage: true });

    // A listed page: ! on its tab. An unlisted page in another tab: nothing.
    const page = await context.newPage();
    await page.goto('https://login-example-support.com/first');
    await expect.poll(() => badgeOn(options, 'https://login-example-support.com/first'), { timeout: 15_000 }).toBe('!');
    const other = await context.newPage();
    await other.goto('https://example.org/');
    await expect.poll(() => badgeOn(options, 'https://example.org/')).toBe('');

    // The same domain again in that tab, within 10 minutes: no badge (R12).
    await page.goto('https://www.login-example-support.com/second');
    await expect.poll(() => badgeOn(options, 'https://www.login-example-support.com/second'), { timeout: 15_000 }).toBe('');
    // Another tab is its own: ! there.
    await other.goto('https://login-example-support.com/third');
    await expect.poll(() => badgeOn(options, 'https://login-example-support.com/third'), { timeout: 15_000 }).toBe('!');

    // Back to saves only: the listener goes and the badges with it.
    await options.bringToFront();
    await risk.getByText('When I save a page', { exact: true }).click();
    await expect.poll(() => mode(options)).toBe('onSave');
    await expect.poll(() => badgeOn(options, 'https://login-example-support.com/third')).toBe('');
    await page.goto('https://login-example-support.com/fourth');
    await page.waitForLoadState();
    expect(await badgeOn(options, 'https://login-example-support.com/fourth')).toBe('');
  } finally {
    await context.close(); await rm(profile, { recursive: true, force: true });
    await new Promise((done) => fixture.server.close(done));
  }
});
