import { test, expect, chromium, type BrowserContext, type Page } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { EXTENSION_ID } from './extension-auth.js';
import { grantOptionalBookmarks } from './bookmark-permission.js';

/**
 * Doc 17 RW-07 (RS-14, §6.4): with no account, one rule and three bookmarks already in a folder.
 * Run once previews the folder and moves nothing; the second click moves the two the rule takes,
 * and Undo puts them back where they were, in their old order.
 */
const extensionPath = resolve(import.meta.dirname, '../dist/development');

async function launch(profile: string): Promise<BrowserContext> {
  return chromium.launchPersistentContext(profile, { headless: false, channel: 'chromium', args: [
    '--remote-debugging-port=0', `--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`,
  ] });
}

const children = (options: Page, id: string) => options.evaluate((folderId) => chrome.bookmarks.getChildren(folderId)
  .then((nodes) => nodes.map((node) => node.title)), id);

test('Run once moves what the preview listed, and Undo survives a browser restart', async ({}, testInfo) => {
  test.setTimeout(120_000);
  const profile = await mkdtemp(resolve(tmpdir(), 'known-browser-rule-run-'));
  let context = await launch(profile);
  try {
    let options = context.pages().find((page) => page.url().includes('/options.html')) ?? await context.newPage();
    await options.goto(`chrome-extension://${EXTENSION_ID}/options.html`);
    await expect(options.locator('body')).toHaveAttribute('data-pane', 'bookmarks');
    await grantOptionalBookmarks(options, 'Allow bookmark access', 'Known browser rule run once');
    const [inbox, papers] = await options.evaluate(async () => {
      const made = await Promise.all([chrome.bookmarks.create({ parentId: '1', title: 'Inbox' }), chrome.bookmarks.create({ parentId: '1', title: 'Papers' })]);
      for (const [title, url] of [['First paper', 'https://arxiv.org/abs/1'], ['A blog', 'https://example.org/post'], ['Second paper', 'https://arxiv.org/abs/2']]) {
        await chrome.bookmarks.create({ parentId: made[0].id, title, url });
      }
      return made;
    });
    await options.goto(`chrome-extension://${EXTENSION_ID}/options.html#automations`);
    await expect(options.locator('#automation-browser-heading')).toBeVisible();

    await options.locator('[data-automations-new]').click();
    const editor = options.locator('dialog.automation-rule-editor');
    await editor.locator('.automation-condition select').selectOption('siteIs');
    await editor.locator('.automation-condition input').fill('arxiv.org');
    await editor.locator('.folder-pill').click();
    await editor.locator(`.folder-opt[data-folder-id="${papers.id}"]`).click();
    await editor.getByRole('button', { name: 'Save rule' }).click();
    await expect(editor).toHaveCount(0);

    // Preview: nothing moves yet.
    await options.getByRole('button', { name: 'Run once' }).click();
    const dialog = options.locator('dialog.automation-run-dialog');
    await dialog.locator('.folder-pill').click();
    await dialog.locator(`.folder-opt[data-folder-id="${inbox.id}"]`).click();
    await dialog.getByRole('button', { name: 'Preview' }).click();
    await expect(dialog.locator('.automation-preview-verdict')).toHaveText('2 of 3 bookmarks in “Inbox” would move.');
    await expect(dialog.locator('.automation-run-folders')).toHaveText('Papers: 2 bookmarks');
    expect(await children(options, inbox.id)).toEqual(['First paper', 'A blog', 'Second paper']);
    await options.screenshot({ path: testInfo.outputPath('run-once-preview.png'), fullPage: true });

    // Apply: the two papers move.
    await dialog.getByRole('button', { name: 'Move 2 bookmarks' }).click();
    await expect(dialog).toHaveCount(0);
    await expect.poll(() => children(options, papers.id)).toEqual(['First paper', 'Second paper']);
    expect(await children(options, inbox.id)).toEqual(['A blog']);

    // A new browser process reads the same durable intents and item receipts.
    await context.close();
    context = await launch(profile);
    options = await context.newPage();
    await options.goto(`chrome-extension://${EXTENSION_ID}/options.html#automations`);
    await expect(options.locator('#automation-browser-heading')).toBeVisible();
    // Undo: back where they were, in their old order.
    const run = options.locator('.automation-runs-card .automation-run-row').first();
    await expect(run.locator('.list-row-title')).toHaveText('Ran on “Inbox”');
    await run.getByRole('button', { name: 'Undo the run on “Inbox”' }).click();
    await expect.poll(() => children(options, inbox.id)).toEqual(['First paper', 'A blog', 'Second paper']);
    expect(await children(options, papers.id)).toEqual([]);
    await expect(run.locator('.badge')).toHaveText('Undone');
    await options.screenshot({ path: testInfo.outputPath('run-once-undone.png'), fullPage: true });
  } finally { await context.close(); await rm(profile, { recursive: true, force: true }); }
});
