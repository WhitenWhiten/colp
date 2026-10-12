import { chromium, expect, test } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { grantOptionalBookmarks } from './bookmark-permission.js';
import { openExtensionOptions } from './extension-auth.js';
test('AC-13 confirms mode, persists pause and saves a real local target without a paid call', async () => {
  const profile = await mkdtemp(resolve(tmpdir(), 'known-capture-controls-')), extension = resolve(import.meta.dirname, '../dist/production');
  const context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: false,
    args: ['--no-sandbox', `--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  const paid: string[] = []; context.on('request', request => { if (request.method() === 'POST' && /classification\/preview|capture-decisions/u.test(request.url())) paid.push(request.url()); });
  try {
    const { page } = await openExtensionOptions(context); await page.locator('#nav-saving').click();
    await page.getByRole('radio', { name: /^Automatic/ }).check();
    await expect(page.getByRole('dialog', { name: 'Enable automatic capture', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Cancel', exact: true }).click(); await expect(page.locator('#capture-mode')).toHaveValue('manual');
    await page.getByRole('radio', { name: /^Automatic/ }).check(); await page.getByRole('button', { name: 'Save automatic mode' }).click();
    await expect(page.locator('#capture-mode')).toHaveValue('automatic');
    await expect.poll(() => page.evaluate(() => chrome.runtime.sendMessage({ kind: 'known.bookmark.preferences.local' })))
      .toMatchObject({ preferences: { captureMode: 'automatic' } });
    // Pausing needs suggestions to pause: the account-free route is the user's own AI service (never called here).
    await page.evaluate(() => chrome.storage.local.set({ 'known.classification.local-enabled.v1': true,
      'known.classification.local-key.v1': { version: 3, generation: 'g1', presetId: 'typesafe', endpoint: 'https://api.typesafe.ai/v1/systemone',
        model: 'jev-1.13.0', secret: 'sk-fixture', disclosed: true } }));
    // The pause/resume control sits with the saves it governs, on the History page.
    await page.locator('#nav-history').click();
    await page.getByRole('button', { name: 'Pause this browser’s classification' }).click();
    await expect(page.locator('[data-capture-controls]')).toContainText(/paused/i);
    await page.reload(); await expect(page.getByRole('button', { name: 'Resume this browser’s classification' })).toBeVisible();
    await page.getByRole('button', { name: 'Resume this browser’s classification' }).click();
    await expect(page.getByRole('button', { name: 'Pause this browser’s classification' })).toBeVisible();
    await page.locator('#nav-bookmarks').click(); await grantOptionalBookmarks(page, 'Allow bookmark access', 'Known bookmark manager');
    await page.reload(); await page.locator('#nav-saving').click();
    // "Default folder" lives on the Saving page; the spending limit on AI suggestions.
    const folder = await page.evaluate(async () => { const root = (await chrome.bookmarks.getTree())[0]!.children![0]!;
      return chrome.bookmarks.create({ parentId: root.id, title: 'Capture control destination' }); });
    await page.locator('[data-capture-default-target]').getByRole('button', { name: 'Change' }).click();
    await page.getByLabel('Default folder on this browser').selectOption(folder.id);
    await page.getByRole('button', { name: 'Save this browser’s settings' }).click();
    await page.locator('#nav-ai').click();
    // With the user's own service in use no credits are spent, so there is no limit to set (and no paid call).
    await expect(page.locator('[data-capture-authorization]')).toContainText('No credits are spent');
    await expect(page.locator('[data-capture-authorization]').getByRole('button')).toHaveCount(0);
    await page.locator('#nav-history').click();
    await expect(page.locator('[data-capture-controls]')).toContainText('Capture control destination');
    // Suggestions are on and nothing is waiting, so the Folder suggestions row says Ready.
    await expect(page.locator('[data-capture-controls]')).toContainText('Ready');
    await page.setViewportSize({ width: 320, height: 720 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
    await page.screenshot({ path: resolve(import.meta.dirname, '../test-results/automatic-bookmark-capture/control-settings-320.png'), fullPage: true });
    expect(paid).toEqual([]);
  } finally { await context.close(); await rm(profile, { recursive: true, force: true }); }
});
