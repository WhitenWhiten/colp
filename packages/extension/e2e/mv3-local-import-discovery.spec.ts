import { test, expect, chromium } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { EXTENSION_ID, openExtensionOptions } from './extension-auth.js';

test('a guest discovers local import directly and from cloud setup, including reopening the same deep link', async () => {
  const profile = await mkdtemp(resolve(tmpdir(), 'known-import-discovery-'));
  const extension = resolve(import.meta.dirname, '../dist/development');
  const context = await chromium.launchPersistentContext(profile, { headless: false, channel: 'chromium',
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  try {
    // Settle the install-time welcome redirect before exercising hash navigation.
    const { page } = await openExtensionOptions(context);
    await page.goto(`chrome-extension://${EXTENSION_ID}/options.html#bookmarks`);
    await expect(page.locator('#side-name')).toHaveText('Not signed in');
    await page.locator('#manager-import').click();
    await expect(page.locator('#local-import-dialog')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Choose file…', exact: true })).toBeVisible();
    await expect(page).toHaveURL(/#bookmarks$/);
    await page.locator('#local-import-close').click();
    for (let visit = 0; visit < 2; visit++) {
      await page.goto(`chrome-extension://${EXTENSION_ID}/options.html#bookmarks?section=import`);
      await expect(page.locator('#local-import-dialog')).toBeVisible();
      await expect(page).toHaveURL(/#bookmarks\?section=import$/u);
      await page.locator('#local-import-close').click();
    }
    await page.locator('#manager-import').click();
    await expect(page.locator('#local-import-dialog')).toBeVisible();
    await page.locator('#local-import-close').click();
    await page.locator('#nav-sync').click();
    await expect(page.locator('#sync-connect')).toContainText('without an account');
    await page.locator('#nav-bookmarks').click();
    await page.locator('#manager-import').click();
    await expect(page.locator('#local-import-dialog')).toBeVisible();
    expect(await page.evaluate(() => chrome.runtime.sendMessage({ kind: 'known.auth.status' }))).toMatchObject({ state: { status: 'signed_out' } });
  } finally { await context.close(); await rm(profile, { recursive: true, force: true }); }
});
