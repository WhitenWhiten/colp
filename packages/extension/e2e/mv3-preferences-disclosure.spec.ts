import { test, expect, chromium } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { EXTENSION_ID, gotoOptions } from './extension-auth.js';

for (const width of [1280, 480]) test(`settings at ${width}px prioritize everyday saving and reveal expert setup on request`, async ({}, testInfo) => {
  const profile = await mkdtemp(resolve(tmpdir(), 'known-preference-disclosure-'));
  const extension = resolve(import.meta.dirname, '../dist/development');
  const context = await chromium.launchPersistentContext(profile, { headless: false, channel: 'chromium', viewport: { width, height: 850 },
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  try {
    await (context.serviceWorkers()[0] ? Promise.resolve() : context.waitForEvent('serviceworker'));
    const page = context.pages()[0] ?? await context.newPage();
    await gotoOptions(page, '#saving');
    await expect(page.locator('[data-capture-default-target]')).toContainText('Default folder');
    await expect(page.locator('#bookmark-preferences-notice')).toBeHidden();
    const target = await page.locator('[data-capture-default-target]').boundingBox();
    expect(target!.y + target!.height).toBeLessThan(850);
    // Expert setup lives on its own pages, so none of it competes with the everyday Saving choices.
    await expect(page.locator('#classification-local-secret')).toBeHidden();
    await expect(page.locator('#classification-local-endpoint')).toBeHidden();
    await expect(page.locator('#subscription-default-interval')).toBeHidden();
    await expect(page.locator('#capture-learning')).toBeHidden();
    await page.screenshot({ path: testInfo.outputPath('preferences-basic.png'), fullPage: true });
    await page.locator('#nav-ai').click();
    // Know-N suggestions need an account, so a signed-out page opens on your own AI service.
    await expect(page.locator('#classification-source-own')).toBeChecked();
    await page.locator('#classification-source-know-n').check();
    await expect(page.locator('#classification-local-secret')).toBeHidden();
    await page.locator('#classification-source-own').check();
    await expect(page.locator('#classification-local-preset')).toBeVisible();
    await expect(page.locator('#classification-local-secret')).toBeVisible();
    await expect(page.locator('#classification-local-endpoint')).toBeHidden();
    await page.locator('#classification-local-advanced > summary').click();
    await expect(page.locator('#classification-local-endpoint')).toBeVisible();
    await page.locator('#classification-local-preset').selectOption('custom');
    await expect(page.locator('#classification-local-endpoint')).toBeVisible();
    await page.locator('#classification-local-advanced > summary').click();
    await expect(page.locator('#classification-local-endpoint')).toBeHidden();
    // A retired Preferences link lands on the AI suggestions page.
    await page.goto(`chrome-extension://${EXTENSION_ID}/options.html#preferences?section=local-classification`);
    await expect(page).toHaveURL(/#ai$/u);
    await expect(page.locator('#ai-card')).toBeVisible();
    await page.locator('#nav-subscriptions').click();
    // Signed out, the page offers only the sign-in step; subscription defaults wait behind it.
    await expect(page.getByText('Sign in to use subscriptions')).toBeVisible();
    await expect(page.locator('#subscription-default-interval')).toBeHidden();
  } finally { await context.close(); await rm(profile, { recursive: true, force: true }); }
});
