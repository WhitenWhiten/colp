import { chromium, expect, test, type Page } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { grantOptionalBookmarks } from './bookmark-permission.js';
import { gotoOptions, openExtensionOptions, waitForLibraryBinding, showOptionsPane } from './extension-auth.js';
import type { RuleDraft } from '../src/automation/rule-conditions.js';

/**
 * AC-73 against a real colp-server (browser rules follow-up L3). Nothing is
 * mocked or seeded: the extension signs in, syncs the bookmarks bar, and a rule
 * made in this browser goes to the account through the web editor it opens.
 * Once the account's enabled copy reaches this browser, the browser rule retires.
 *
 * Set COLP_AW_ORIGIN, COLP_AW_USER and COLP_AW_PASSWORD for a disposable
 * server whose owner is that user.
 */
const origin = process.env.COLP_AW_ORIGIN?.replace(/\/$/u, '');
const user = process.env.COLP_AW_USER;
const password = process.env.COLP_AW_PASSWORD;
const extension = resolve(import.meta.dirname, '../dist/production');
// Sign-in actions carry the owner's password; keep them out of traces.
test.use({ trace: 'off', actionTimeout: 20_000 });

test('a browser rule moves to the account through the web editor and retires when the account’s copy arrives', async () => {
  if (!origin || !user || !password) throw new Error('Run npm run test:e2e:self-hosted for an isolated owner server.');
  test.setTimeout(300_000);
  const dir = await mkdtemp(resolve(tmpdir(), 'colp-aw-l3-profile-'));
  const context = await chromium.launchPersistentContext(dir, { headless: false, channel: 'chromium',
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--no-proxy-server'] });
  try {
    const { page } = await openExtensionOptions(context);
    page.on('pageerror', (error) => process.stdout.write(`extension error: ${error.message}\n`));
    await connect(page);
    await showOptionsPane(page, 'bookmarks');
    await grantOptionalBookmarks(page, page.locator('#manager-grant'), 'Bookmarks');
    const collection = await createCollection(await context.newPage());
    await firstSync(page, collection);

    // A synced folder, and a rule made in this browser that files into it.
    const papers = await page.evaluate(async () => {
      const bar = (await chrome.bookmarks.getTree())[0]!.children![0]!.id;
      return chrome.bookmarks.create({ parentId: bar, title: 'Papers' });
    });
    const name = `arXiv to Papers ${Date.now()}`;
    expect(await page.evaluate((draft) => chrome.runtime.sendMessage({ kind: 'known.automation.browser.save', draft }),
      { name, combinator: 'all', conditions: [{ kind: 'siteIs', value: 'arxiv.org' }],
        action: { kind: 'file', folderNativeId: papers.id } } satisfies RuleDraft)).toMatchObject({ ok: true });

    // "Add to your account" appears once the folder is on the server.
    await gotoOptions(page, '#automations');
    const row = page.locator('.automation-browser-rule').filter({ hasText: name });
    const move = row.getByRole('button', { name: 'Add to your account', exact: true });
    await expect.poll(async () => {
      await page.reload({ waitUntil: 'domcontentloaded' });
      await row.hover().catch(() => undefined);
      return move.isVisible();
    }, { timeout: 90_000, intervals: [2_000] }).toBe(true);

    // The web editor opens filled in with this rule, in this browser's own session.
    const [editor] = await Promise.all([context.waitForEvent('page'), move.click()]);
    await editor.waitForLoadState('domcontentloaded');
    const opened = new URL(editor.url());
    expect(opened.origin + opened.pathname).toBe(`${origin}/automations/new`);
    expect(opened.searchParams.get('from')).toBe('browser');
    await expect(editor.getByTestId('automation-from-browser')).toBeVisible({ timeout: 20_000 });
    await expect(editor.locator('#automation-name')).toHaveValue(name);
    await expect(editor.getByRole('button', { name: /^Folder .*Papers$/u })).toBeVisible();
    await expect(row).toContainText('Moving');

    // The Owner previews it and turns it on.
    await editor.getByRole('button', { name: 'Preview', exact: true }).click();
    await expect(editor.getByTestId('automation-turn-on')).toBeEnabled({ timeout: 20_000 });
    await editor.getByTestId('automation-turn-on').click();
    await expect(editor).toHaveURL(`${origin}/automations`, { timeout: 20_000 });

    // The next check installs the account's copy; the browser rule retires and says so.
    await page.bringToFront();
    await expect.poll(async () => {
      const response = await page.evaluate(() => chrome.runtime.sendMessage({ kind: 'known.automation.refresh', userGesture: true })) as
        { state?: { rules: { name: string }[]; browserRules: { name: string }[] } };
      return { account: response.state?.rules.some((rule) => rule.name === name), browser: response.state?.browserRules.some((rule) => rule.name === name) };
    }, { timeout: 90_000, intervals: [3_000] }).toEqual({ account: true, browser: false });
    await expect(page.locator('.toast', { hasText: `“${name}” now runs from your account, on every device.` })).toBeVisible();

    // The account's rule now files arXiv pages into Papers.
    const bar = await page.evaluate(async () => (await chrome.bookmarks.getTree())[0]!.children![0]!.id);
    expect(await page.evaluate((parentNativeId) => chrome.runtime.sendMessage({ kind: 'known.automation.match',
      url: 'https://arxiv.org/abs/2410.00001', title: 'A paper', parentNativeId }), bar))
      .toMatchObject({ ok: true, match: { outcome: 'placed', ruleName: name, folderNativeId: papers.id } });
  } finally {
    await context.close();
    await rm(dir, { recursive: true, force: true });
  }
});

async function connect(page: Page): Promise<void> {
  await gotoOptions(page, '#account');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.locator('#login-panel')).toBeVisible();
  // The field saves on `change`; alternating the trailing slash refires it on a retry.
  let attempt = 0;
  await grantOptionalBookmarks(page, page.locator('#login-email'), 'COLP server permission',
    { origins: [`${origin}/*`] }, async () => { await page.locator('#server-origin').fill(`${origin}${attempt++ % 2 ? '/' : ''}`); });
  await expect.poll(() => page.evaluate(async () => (await chrome.storage.local.get('runtimeServerOrigin')).runtimeServerOrigin),
    { timeout: 25_000 }).toBe(origin);
  await expect(page.locator('#server-origin')).toBeEnabled();
  await page.locator('#login-email').fill(user!);
  await page.locator('#login-password').fill(password!);
  await page.locator('#login-submit').click();
  await expect(page.locator('body')).toHaveAttribute('data-state', 'connected', { timeout: 25_000 });
}

/** Discover the owner's single library through the real web session. */
async function createCollection(web: Page): Promise<string> {
  await web.goto(`${origin}/library`);
  if (new URL(web.url()).pathname === '/login') {
    await web.locator('#login-identifier').fill(user!);
    await web.locator('#login-password').fill(password!);
    await web.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(web).not.toHaveURL(/\/login/u);
    await web.goto(`${origin}/library`);
  }
  const id = await web.evaluate(async () => {
    const response = await fetch('/api/v1/me/library', { headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error(`Library discovery failed (${response.status})`);
    const result = await response.json() as { id: string; library: boolean };
    if (!result.library || !result.id) throw new Error('Owner library missing');
    return result.id;
  });
  await web.close();
  return id;
}

async function firstSync(page: Page, collection: string): Promise<void> {
  // The owner's library binds automatically at sign-in.
  await waitForLibraryBinding(page, collection);
  await showOptionsPane(page, 'folders');
  const start = page.locator('#first-run-start');
  await expect(start).toBeVisible({ timeout: 20_000 });
  const root = page.locator('.root-row .root-select').first();
  if (!await root.locator('input').isChecked()) await root.click();
  await expect(start).toBeEnabled({ timeout: 20_000 });
  await start.click();
  await expect.poll(() => page.evaluate(async () => (await chrome.runtime.sendMessage({ kind: 'known.firstRun.status' }) as { firstRun?: string }).firstRun),
    { timeout: 90_000 }).toBe('completed');
}
