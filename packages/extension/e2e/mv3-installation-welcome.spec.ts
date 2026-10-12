import { test, expect, chromium } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { EXTENSION_ID } from './extension-auth.js';
import { grantOptionalBookmarks } from './bookmark-permission.js';

for (const width of [1280, 480]) test(`installation at ${width}px offers a readable, usable local start`, async () => {
  const profile = await mkdtemp(resolve(tmpdir(), 'known-installation-'));
  const extension = resolve(import.meta.dirname, '../dist/development');
  const context = await chromium.launchPersistentContext(profile, { headless: false, channel: 'chromium',
    viewport: { width, height: 850 }, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  try {
    await (context.serviceWorkers()[0] ? Promise.resolve() : context.waitForEvent('serviceworker'));
    const page = context.pages().find(page => page.url().includes('/options.html')) ?? await context.newPage();
    await page.goto(`chrome-extension://${EXTENSION_ID}/options.html`);
    await expect(page.locator('#welcome')).toBeVisible();
    await expect(page.locator('#welcome-copy')).toContainText('No account needed');
    await expect(page.locator('#welcome-steps')).toContainText('Pin Know-N to your toolbar');
    const text = await page.locator('.welcome-copy').boundingBox();
    const dismiss = await page.locator('#dismiss-welcome').boundingBox();
    expect(text!.width).toBeGreaterThan(240);
    expect(dismiss!.y + dismiss!.height).toBeLessThan(850);
    // Before access is granted the only primary action is Allow bookmark access.
    await expect(page.locator('#bookmarks-card .btn-primary:visible')).toHaveCount(1);
    await expect(page.locator('#manager-grant')).toHaveClass(/btn-primary/u);
    await grantOptionalBookmarks(page, 'Allow bookmark access', 'Know-N installation');
    await expect(page.locator('#manager-body')).toBeVisible();
    await expect(page.locator('#welcome-import')).toHaveClass(/btn-primary/u);
    await page.locator('#dismiss-welcome').click();
    await expect(page.locator('#welcome')).toBeHidden();
    expect(await page.evaluate(() => chrome.runtime.sendMessage({ kind: 'known.auth.status' })))
      .toMatchObject({ state: { status: 'signed_out' } });
  } finally { await context.close(); await rm(profile, { recursive: true, force: true }); }
});
