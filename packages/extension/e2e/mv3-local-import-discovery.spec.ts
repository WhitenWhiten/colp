import { test, expect, chromium } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { EXTENSION_ID } from './extension-auth.js';

test('a guest discovers local import directly and from cloud setup, including reopening the same deep link', async () => {
  const profile = await mkdtemp(resolve(tmpdir(), 'known-import-discovery-'));
  const extension = resolve(import.meta.dirname, '../dist/development');
  const context = await chromium.launchPersistentContext(profile, { headless: false, channel: 'chromium',
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  try {
    await (context.serviceWorkers()[0] ? Promise.resolve() : context.waitForEvent('serviceworker'));
    const page = context.pages()[0] ?? await context.newPage();
    await page.goto(`chrome-extension://${EXTENSION_ID}/options.html#bookmarks`);
    await expect(page.locator('#side-name')).toHaveText('Not signed in');
    await page.locator('#manager-import').click();
    await expect(page.locator('#local-import-file')).toBeVisible();
    await expect(page).toHaveURL(/#bookmarks\?section=import/);
    await page.locator('#local-import > summary').click();
    await page.locator('#manager-import').click();
    await expect(page.locator('#local-import-file')).toBeVisible();
    await page.locator('#nav-sync').click();
    await expect(page.locator('#sync-connect')).toContainText('without an account');
    await page.getByRole('link', { name: 'Import into this browser', exact: true }).click();
    await expect(page.locator('#local-import-file')).toBeVisible();
    expect(await page.evaluate(() => chrome.runtime.sendMessage({ kind: 'known.auth.status' }))).toMatchObject({ state: { status: 'signed_out' } });
  } finally { await context.close(); await rm(profile, { recursive: true, force: true }); }
});
