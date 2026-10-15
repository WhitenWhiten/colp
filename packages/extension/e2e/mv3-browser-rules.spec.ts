import { test, expect, chromium } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { EXTENSION_ID } from './extension-auth.js';
import { grantOptionalBookmarks } from './bookmark-permission.js';
import { grantTabAccess, openPopupOver } from './popup-page.js';

/**
 * AC-69 (AW-68): with no account and no server, a rule written in Options ›
 * Automations files a matching popup save, made offline, straight into its
 * folder; the popup shows that folder as "By rule" before Save, and a page the
 * rule does not match keeps the folder it would have had.
 */
const extensionPath = resolve(import.meta.dirname, '../dist/development');
const PAPER = 'https://arxiv.org/abs/2410.00001';
const OTHER = 'https://example.org/browser-rules-other';

test('a rule made in Options with no account files an offline popup save into its folder', async ({}, testInfo) => {
  test.setTimeout(120_000);
  const profile = await mkdtemp(resolve(tmpdir(), 'known-browser-rules-'));
  const context = await chromium.launchPersistentContext(profile, { headless: false, channel: 'chromium', args: [
    '--remote-debugging-port=0', `--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`,
  ] });
  try {
    await context.route(/^https:\/\/(arxiv\.org|example\.org)\//u, (route) => route.fulfill({ contentType: 'text/html',
      body: `<title>${route.request().url().includes('arxiv') ? 'A paper' : 'Another page'}</title><p>Fixture</p>` }));
    const options = context.pages().find((page) => page.url().includes('/options.html')) ?? await context.newPage();
    await options.goto(`chrome-extension://${EXTENSION_ID}/options.html`);
    await expect(options.locator('body')).toHaveAttribute('data-pane', 'bookmarks');
    await grantOptionalBookmarks(options, 'Allow bookmark access', 'Known browser rules');
    await grantTabAccess(context);
    const papers = await options.evaluate(() => chrome.bookmarks.create({ parentId: '1', title: 'Papers' }));

    // Signed out, the page leads with this browser's rules; New rule writes one.
    await options.bringToFront();
    await options.locator('#nav-automations').click();
    await expect(options.locator('#automation-browser-heading')).toHaveText('Rules in this browser');
    await options.locator('[data-automations-new]').click();
    const dialog = options.locator('dialog.automation-rule-editor');
    await expect(dialog).toBeVisible();
    // A pasted link stands for its site.
    await dialog.locator('.automation-condition input').fill(PAPER);
    await dialog.locator('.folder-pill').click();
    await dialog.locator(`.folder-opt[data-folder-id="${papers.id}"]`).click();
    await dialog.screenshot({ path: testInfo.outputPath('browser-rule-editor.png') });
    await dialog.getByRole('button', { name: 'Save rule' }).click();
    await expect(dialog).toHaveCount(0);
    const row = options.locator('.automation-browser-rule');
    await expect(row).toHaveCount(1);
    await expect(row.locator('.automation-recipe')).toContainText('From arxiv.org');
    await expect(row.locator('.automation-recipe-folder')).toHaveText('Papers');
    const state = await options.evaluate(() => chrome.runtime.sendMessage({ kind: 'known.automation.state' }));
    expect(state).toMatchObject({ ok: true, state: { account: 'signedOut', browserRules: [{ name: 'arxiv.org → Papers', enabled: true, folder: { title: 'Papers' } }] } });

    // Offline: the popup shows the rule's folder before Save, and the bookmark is created there.
    const paper = await context.newPage(); await paper.goto(PAPER);
    const other = await context.newPage(); await other.goto(OTHER);
    await context.setOffline(true);
    const popup = await openPopupOver(context, paper);
    await expect(popup.locator('#dest-folder')).toHaveText('Papers', { timeout: 20_000 });
    await expect(popup.locator('#rule-mark')).toBeVisible();
    await popup.screenshot({ path: testInfo.outputPath('browser-rule-popup.png') });
    await popup.locator('#save').click();
    await expect.poll(() => options.evaluate((url) => chrome.bookmarks.search({ url }).then((nodes) => nodes[0]?.parentId ?? null), PAPER),
      { timeout: 30_000 }).toBe(papers.id);
    // The ledger records the save just after the bookmark exists.
    const saved = () => options.evaluate(() => chrome.runtime.sendMessage({ kind: 'known.capture.list' })) as Promise<{ tasks: { save: string }[] }>;
    await expect.poll(async () => (await saved()).tasks[0]?.save, { timeout: 15_000 }).toBe('local-saved');
    expect(await saved()).toMatchObject({ tasks: [expect.objectContaining({ url: PAPER, save: 'local-saved', targetNativeId: papers.id,
      automation: expect.objectContaining({ source: 'browser', outcome: 'placed', folderTitle: 'Papers' }),
      scope: expect.objectContaining({ accountId: null }) })] });

    // A page the rule does not match keeps the folder it would have had, with no rule mark.
    const second = await openPopupOver(context, other);
    await expect(second.locator('#dest-folder')).not.toHaveText('', { timeout: 20_000 });
    await expect(second.locator('#rule-mark')).toBeHidden();
    await expect(second.locator('#dest-folder')).not.toHaveText('Papers');

    // Options lists what the rule filed.
    await options.bringToFront();
    await options.reload();
    await options.locator('#nav-automations').click();
    await expect(options.locator('.automation-activity')).toContainText('A paper');
    await options.screenshot({ path: testInfo.outputPath('browser-rules-options.png'), fullPage: true });
  } finally { await context.close(); await rm(profile, { recursive: true, force: true }); }
});
