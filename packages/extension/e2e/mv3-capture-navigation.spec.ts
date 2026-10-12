import { chromium, expect, test } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
test('AC-12 preserves legacy views, task deep links, browser history and settings drafts', async () => {
  const profile = await mkdtemp(resolve(tmpdir(), 'known-capture-navigation-'));
  const extension = resolve(import.meta.dirname, '../dist/production');
  const context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: false,
    args: ['--no-sandbox', `--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  try {
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
    const page = await context.newPage(), id = new URL(worker.url()).host;
    // The retired Capture and Saving tab hashes land on the page that owns their content.
    await page.goto(`chrome-extension://${id}/options.html#capture/overview`);
    await expect(page.locator('#history-card')).toBeVisible();
    await expect(page).toHaveURL(/#history$/u);
    // One page at a time: History is up, and the Saving settings are down.
    await expect(page.locator('[data-capture-view="history"]')).toBeVisible();
    await expect(page.locator('#bookmark-preferences')).toBeHidden();
    await page.evaluate(() => { location.hash = 'saving/history'; });
    await expect(page).toHaveURL(/#history$/u);
    await expect(page.locator('#nav-history')).toHaveAttribute('aria-current', 'page');
    await page.evaluate(() => { location.hash = 'saving'; });
    await expect(page.locator('#bookmark-preferences')).toBeVisible();
    await expect(page).toHaveURL(/#saving$/u);
    await page.goBack(); await expect(page.locator('[data-capture-view="history"]')).toBeVisible();
    await page.goForward(); await expect(page.locator('#bookmark-preferences')).toBeVisible();
    await page.evaluate(() => { location.hash = 'saving/settings'; });
    await expect(page.locator('#bookmark-preferences')).toBeVisible();
    await expect(page).toHaveURL(/#saving$/u);
    await page.evaluate(() => { location.hash = 'preferences?section=capture'; });
    await expect(page).toHaveURL(/#saving$/u);
    for (const pane of ['account', 'saving', 'sync', 'bookmarks']) {
      await page.locator(`#nav-${pane}`).click(); await expect(page.locator('body')).toHaveAttribute('data-pane', pane);
    }
    await page.locator('#nav-account').click();
    await page.locator('#login-email').fill('draft@example.org');
    await page.locator('#nav-saving').click(); await page.goBack();
    await expect(page.locator('#login-email')).toHaveValue('draft@example.org');
    await page.goto(`chrome-extension://${id}/options.html#capture/history?task=12345678-1234-4123-8123-123456789abc`);
    await expect(page.locator('[data-capture-view="history"]')).toBeVisible();
    await expect(page).toHaveURL(/task=12345678-1234-4123-8123-123456789abc/u);
    await page.setViewportSize({ width: 320, height: 720 });
    await page.screenshot({ path: resolve(import.meta.dirname, '../test-results/automatic-bookmark-capture/options-navigation-320.png'), fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
  } finally { await context.close(); await rm(profile, { recursive: true, force: true }); }
});
