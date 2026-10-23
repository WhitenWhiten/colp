import { test, expect, chromium } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { EXTENSION_ID } from './extension-auth.js';
import { grantOptionalBookmarks } from './bookmark-permission.js';

test('a guest grants and revokes bookmark permission in General settings without losing bookmarks', async () => {
  const profile = await mkdtemp(resolve(tmpdir(), 'known-permission-settings-'));
  const extension = resolve(import.meta.dirname, '../dist/development');
  const context = await chromium.launchPersistentContext(profile, { headless: false, channel: 'chromium',
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  try {
    await (context.serviceWorkers()[0] ? Promise.resolve() : context.waitForEvent('serviceworker'));
    const page = context.pages()[0] ?? await context.newPage();
    const url = `chrome-extension://${EXTENSION_ID}/options.html#general`;
    await page.goto(url); await expect(page.locator('#side-name')).toHaveText('Not signed in');
    await expect(page.locator('#pref-permissions')).toContainText('Your browser’s own account sync is separate.');
    await grantOptionalBookmarks(page, page.locator('#permissions-grant-bookmarks'), 'Know-N permission settings');
    await expect(page.locator('#permissions-status-bookmarks')).toHaveText('Allowed');
    const id = await page.evaluate(async () => {
      const root = (await chrome.bookmarks.getTree())[0]!.children![0]!;
      return (await chrome.bookmarks.create({ parentId: root.id, title: 'Keep after revoking', url: 'https://example.test/keep-permission' })).id;
    });
    await page.locator('#permissions-revoke-bookmarks').click();
    await expect(page.locator('#remove-permission-dialog')).toContainText('Existing bookmarks and Know-N copies are kept');
    await page.locator('#remove-permission-confirm').click();
    await expect(page.locator('#permissions-status-bookmarks')).toHaveText('Off');
    await page.locator('#nav-bookmarks').click();
    await expect(page.locator('#manager-gate')).toBeVisible(); await expect(page.locator('#manager-body')).toBeHidden();
    await page.goto(url); await expect(page.locator('#side-name')).toHaveText('Not signed in');
    await grantOptionalBookmarks(page, page.locator('#permissions-grant-bookmarks'), 'Know-N restored permissions');
    const retained = await page.evaluate(id => chrome.bookmarks.get(id), id);
    expect(retained).toMatchObject([{ id, title: 'Keep after revoking', url: 'https://example.test/keep-permission' }]);
    expect(await page.evaluate(() => chrome.runtime.sendMessage({ kind: 'known.auth.status' }))).toMatchObject({ state: { status: 'signed_out' } });
  } finally { await context.close(); await rm(profile, { recursive: true, force: true }); }
});
