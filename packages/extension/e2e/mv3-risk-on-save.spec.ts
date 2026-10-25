import { test, expect, chromium, type BrowserContext } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { EXTENSION_ID } from './extension-auth.js';
import { grantOptionalBookmarks } from './bookmark-permission.js';
import { grantTabAccess, openPopupOver } from './popup-page.js';

/**
 * Doc 17 RW-16 (RS-16.1, RS-17.1, RS-18.1, RS-18.2): with no account, risk alerts are switched on for
 * saves in Options and a `colp.risklist/v1` list served from a `node:http` fixture on 127.0.0.1 is
 * subscribed to, its site granted in the Subscribe click. The popup over a listed page shows the notice
 * — list, kind, scope, evidence — beside the folder line, and Save still files the page where the
 * browser rule puts it.
 */
const extensionPath = resolve(import.meta.dirname, '../dist/development');
const LISTED = 'https://login-example-support.com/account';

const risklist = JSON.stringify({ format: 'colp.risklist/v1', id: 'example-phishing', name: 'Example phishing list', version: '2026-10-18T06:00:00Z',
  publisher: { name: 'Example', url: 'https://example.org', feedbackUrl: null }, license: 'MIT',
  entries: [{ scope: 'domain', value: 'login-example-support.com', kind: 'phishing', since: '2026-10-17T00:00:00Z', expires: null,
    evidenceUrl: 'https://example.org/r/1' }] });

async function serve(): Promise<{ server: Server; url: string; origin: string; hits: string[] }> {
  const hits: string[] = [];
  const server = createServer((request, response) => {
    hits.push(`${request.method} ${request.url}`);
    if (request.url !== '/risk.json') { response.writeHead(404).end(); return; }
    response.writeHead(200, { 'Content-Type': 'application/json', ETag: '"1"' }).end(risklist);
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { server, url: `${origin}/risk.json`, origin, hits };
}

async function launch(profile: string): Promise<BrowserContext> {
  return chromium.launchPersistentContext(profile, { headless: false, channel: 'chromium', args: [
    '--remote-debugging-port=0', `--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`,
  ] });
}

test('a page on a subscribed risk list gets the notice in the popup, and saves anyway into the rule’s folder', async ({}, testInfo) => {
  test.setTimeout(150_000);
  const fixture = await serve();
  const profile = await mkdtemp(resolve(tmpdir(), 'known-risk-on-save-'));
  const context = await launch(profile);
  try {
    await context.route(/^https:\/\/login-example-support\.com\//u, (route) => route.fulfill({ contentType: 'text/html', body: '<title>Account</title><p>Fixture</p>' }));
    const options = context.pages().find((page) => page.url().includes('/options.html')) ?? await context.newPage();
    await options.goto(`chrome-extension://${EXTENSION_ID}/options.html`);
    await expect(options.locator('body')).toHaveAttribute('data-pane', 'bookmarks');
    await grantOptionalBookmarks(options, 'Allow bookmark access', 'Known risk on save');
    await grantTabAccess(context);
    const accounts = await options.evaluate(() => chrome.bookmarks.create({ parentId: '1', title: 'Accounts' }));
    await options.bringToFront();
    await options.locator('#nav-automations').click();
    await expect(options.locator('#automation-browser-heading')).toBeVisible();

    // A browser rule that files the listed site: the risk list must not change where it goes.
    await options.locator('[data-automations-new]').click();
    const editor = options.locator('dialog.automation-rule-editor');
    await editor.getByLabel('Condition', { exact: true }).selectOption('siteIs');
    await editor.locator('.automation-condition input:not([hidden])').first().fill('login-example-support.com');
    await editor.locator('.folder-pill').click();
    await editor.locator(`.folder-opt[data-folder-id="${accounts.id}"]`).click();
    await editor.locator('input[maxlength="200"]').fill('Support site to Accounts');
    await editor.getByRole('button', { name: 'Save rule' }).click();
    await expect(editor).toHaveCount(0);

    // Risk alerts: off until switched on; then a list, its site allowed in the Subscribe click.
    const risk = options.locator('#automation-risk');
    await expect(risk.locator('.risk-mode input[value="off"]')).toBeChecked();
    await expect(risk).toContainText('A page on no list gets no notice, good or bad.');
    await risk.getByText('When I save a page', { exact: true }).click();
    await expect.poll(() => options.evaluate(async () => (await chrome.runtime.sendMessage({ kind: 'known.risk.state' }) as { state: { mode: string } }).state.mode))
      .toBe('onSave');
    await risk.locator('[data-risk-subscribe]').click();
    const dialog = options.locator('dialog.automation-config-dialog');
    await dialog.locator('input[type="url"]').fill(fixture.url);
    await grantOptionalBookmarks(options, dialog.getByRole('button', { name: 'Subscribe', exact: true }), 'Known risk list site', { origins: [`${fixture.origin}/*`] });
    await expect(dialog).toHaveCount(0, { timeout: 20_000 });
    const row = risk.locator('[data-risk-list] .list-row');
    await expect(row.locator('.list-row-title')).toHaveText('Example phishing list');
    await expect(row.locator('.list-row-meta')).toContainText('1 entry · version 2026-10-18T06:00:00Z · checked');
    await risk.scrollIntoViewIfNeeded();
    await options.screenshot({ path: testInfo.outputPath('risk-settings.png'), fullPage: true });

    // The popup over the listed page: the notice above the form, the rule's folder on the pill.
    const page = await context.newPage(); await page.goto(LISTED);
    const popup = await openPopupOver(context, page);
    const notice = popup.locator('#risk-notice');
    await expect(notice).toBeVisible({ timeout: 20_000 });
    await expect(notice.locator('.risk-notice-title')).toHaveText('This page is on a risk list you subscribe to');
    await expect(notice.locator('.risk-notice-matches li')).toContainText(/^Example phishing list: listed as phishing since .+ · all of login-example-support\.com · Evidence$/u);
    await expect(notice.getByRole('link', { name: 'Evidence' })).toHaveAttribute('href', 'https://example.org/r/1');
    await expect(popup.locator('#dest-folder')).toHaveText('Accounts', { timeout: 20_000 });
    await expect(popup.locator('#save')).toBeEnabled();
    await popup.screenshot({ path: testInfo.outputPath('risk-popup-notice.png') });

    // Save anyway: the bookmark goes where the rule files it.
    await popup.locator('#save').click();
    await expect.poll(() => options.evaluate((url) => chrome.bookmarks.search({ url }).then((nodes) => nodes[0]?.parentId ?? null), LISTED),
      { timeout: 30_000 }).toBe(accounts.id);
    const saved = () => options.evaluate(() => chrome.runtime.sendMessage({ kind: 'known.capture.list' })) as Promise<{ tasks: { save: string }[] }>;
    await expect.poll(async () => (await saved()).tasks[0]?.save, { timeout: 15_000 }).toBe('local-saved');
    expect(await saved()).toMatchObject({ tasks: [expect.objectContaining({ automation: expect.objectContaining({ source: 'browser', outcome: 'placed',
      folderTitle: 'Accounts', rule: expect.objectContaining({ name: 'Support site to Accounts' }) }) })] });
    // The list was fetched once, at Subscribe; the check read only what was stored.
    expect(fixture.hits).toEqual(['GET /risk.json']);
  } finally {
    await context.close(); await rm(profile, { recursive: true, force: true });
    await new Promise((done) => fixture.server.close(done));
  }
});
