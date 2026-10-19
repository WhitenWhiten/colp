import { test, expect, chromium, type BrowserContext, type Page } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { EXTENSION_ID } from './extension-auth.js';
import { grantOptionalBookmarks } from './bookmark-permission.js';
import { grantTabAccess, openPopupOver } from './popup-page.js';

/**
 * Doc 17 RW-04 (RS-00, RS-01, RS-06): with no account, two rules that both match a page and a set are
 * made in Options; Move up puts the second rule first, and the next save goes where the upper rule files
 * it. The order is the stored one: it is the same after the browser restarts.
 */
const extensionPath = resolve(import.meta.dirname, '../dist/development');
const PAPER = 'https://arxiv.org/abs/2410.00002';

async function launch(profile: string): Promise<BrowserContext> {
  return chromium.launchPersistentContext(profile, { headless: false, channel: 'chromium', args: [
    '--remote-debugging-port=0', `--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`,
  ] });
}

async function optionsPage(context: BrowserContext): Promise<Page> {
  const options = context.pages().find((page) => page.url().includes('/options.html')) ?? await context.newPage();
  await options.goto(`chrome-extension://${EXTENSION_ID}/options.html`);
  await expect(options.locator('body')).toHaveAttribute('data-pane', 'bookmarks');
  return options;
}
async function automations(options: Page): Promise<void> {
  await options.bringToFront();
  await options.locator('#nav-automations').click();
  await expect(options.locator('#automation-browser-heading')).toBeVisible();
}

const order = (options: Page) => options.evaluate(async () => {
  const reply = await chrome.runtime.sendMessage({ kind: 'known.automation.state' }) as { state: { browserList: { entries: (
    { kind: 'rule'; rule: { name: string } } | { kind: 'set'; set: { name: string } })[] } } };
  return reply.state.browserList.entries.map((entry) => entry.kind === 'rule' ? entry.rule.name : `set:${entry.set.name}`);
});

test('the order of this browser’s rules decides a save, and is the same after a restart', async ({}, testInfo) => {
  test.setTimeout(150_000);
  const profile = await mkdtemp(resolve(tmpdir(), 'known-browser-rule-list-'));
  let context = await launch(profile);
  try {
    await context.route(/^https:\/\/arxiv\.org\//u, (route) => route.fulfill({ contentType: 'text/html', body: '<title>A paper</title><p>Fixture</p>' }));
    let options = await optionsPage(context);
    await grantOptionalBookmarks(options, 'Allow bookmark access', 'Known browser rule list');
    await grantTabAccess(context);
    const [papers, reading] = await options.evaluate(() => Promise.all([chrome.bookmarks.create({ parentId: '1', title: 'Papers' }),
      chrome.bookmarks.create({ parentId: '1', title: 'Reading' })]));
    await automations(options);

    // Two rules that both take the paper, each to its own folder.
    const rule = async (kind: string, value: string, folderId: string, name: string) => {
      await options.locator('[data-automations-new]').click();
      const dialog = options.locator('dialog.automation-rule-editor');
      await dialog.locator('.automation-condition select').selectOption(kind);
      await dialog.locator('.automation-condition input').fill(value);
      await dialog.locator('.folder-pill').click();
      await dialog.locator(`.folder-opt[data-folder-id="${folderId}"]`).click();
      await dialog.locator('input[maxlength="200"]').fill(name);
      await dialog.getByRole('button', { name: 'Save rule' }).click();
      await expect(dialog).toHaveCount(0);
    };
    await rule('siteIs', 'arxiv.org', papers.id, 'arXiv to Papers');
    await rule('titleContains', 'paper', reading.id, 'Papers to Reading');
    await options.getByRole('button', { name: 'New set' }).click();
    const setDialog = options.locator('dialog.automation-set-dialog');
    await setDialog.locator('input').fill('Research');
    await setDialog.getByRole('button', { name: 'Create set' }).click();
    await expect(setDialog).toHaveCount(0);
    await expect.poll(() => order(options)).toEqual(['arXiv to Papers', 'Papers to Reading', 'set:Research']);

    // Move up: the title rule now comes first, and the focus stays on it.
    const second = options.locator('.rule-list > li').nth(1);
    await second.hover();
    await second.locator('> .list-row [data-move="up"]').click();
    await expect.poll(() => order(options)).toEqual(['Papers to Reading', 'arXiv to Papers', 'set:Research']);
    await expect(options.locator('.rule-list > li').first().locator('.list-row-title')).toHaveText('Papers to Reading');
    await options.screenshot({ path: testInfo.outputPath('browser-rule-list.png'), fullPage: true });

    // Offline, the save goes where the upper rule files it.
    const paper = await context.newPage(); await paper.goto(PAPER);
    await context.setOffline(true);
    const popup = await openPopupOver(context, paper);
    await expect(popup.locator('#dest-folder')).toHaveText('Reading', { timeout: 20_000 });
    await popup.locator('#save').click();
    await expect.poll(() => options.evaluate((url) => chrome.bookmarks.search({ url }).then((nodes) => nodes[0]?.parentId ?? null), PAPER),
      { timeout: 30_000 }).toBe(reading.id);
    const saved = () => options.evaluate(() => chrome.runtime.sendMessage({ kind: 'known.capture.list' })) as Promise<{ tasks: { save: string }[] }>;
    await expect.poll(async () => (await saved()).tasks[0]?.save, { timeout: 15_000 }).toBe('local-saved');
    expect(await saved()).toMatchObject({ tasks: [expect.objectContaining({ automation: expect.objectContaining({ source: 'browser', outcome: 'placed',
      folderTitle: 'Reading', rule: expect.objectContaining({ name: 'Papers to Reading' }), entry: expect.objectContaining({ kind: 'rule' }) }) })] });
    await context.setOffline(false);

    // A restart keeps the list as it was left.
    await context.close();
    context = await launch(profile);
    options = context.pages().find((page) => page.url().includes('/options.html')) ?? await context.newPage();
    await options.goto(`chrome-extension://${EXTENSION_ID}/options.html#automations`);
    await expect(options.locator('#automation-browser-heading')).toBeVisible();
    await expect.poll(() => order(options), { timeout: 20_000 }).toEqual(['Papers to Reading', 'arXiv to Papers', 'set:Research']);
    await expect(options.locator('.rule-list > li')).toHaveCount(3);
  } finally { await context.close(); await rm(profile, { recursive: true, force: true }); }
});
