import { test, expect, chromium } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { gotoOptions } from './extension-auth.js';

test('local tag disclosure survives language changes without a synced account', async () => {
  const profile = await mkdtemp(resolve(tmpdir(), 'known-disclosure-security-'));
  const extension = resolve(import.meta.dirname, '../dist/development');
  const context = await chromium.launchPersistentContext(profile, {
    headless: false, channel: 'chromium',
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  try {
    await (context.serviceWorkers()[0] ? Promise.resolve() : context.waitForEvent('serviceworker'));
    const page = context.pages()[0] ?? await context.newPage();
    await gotoOptions(page, '#ai');
    await page.locator('#classification-source-own').check();
    const consent = page.locator('#classification-local-disclosure-option .check-line span');
    const details = page.locator('#classification-local-disclosure-option .disclosure p');
    await expect(consent).toContainText('local and synced tag names');
    await expect(details).toContainText('even when no account or library is synced');
    expect(await page.evaluate(async () => (await chrome.storage.local.get('known.auth.binding.v1'))['known.auth.binding.v1']))
      .toBeUndefined();

    await page.locator('#nav-general').click();
    await page.locator('#ui-language').selectOption('zh-CN');
    await page.locator('#nav-ai').click();
    await expect(consent).toContainText('本地和已同步的标签名称');
    await expect(details).toContainText('即使没有连接账号或同步书签库');
    await page.reload();
    await expect(consent).toContainText('本地和已同步的标签名称');

    await page.locator('#nav-general').click();
    await page.locator('#ui-language').selectOption('en');
    await page.locator('#nav-ai').click();
    await expect(consent).toContainText('local and synced tag names');
    await expect(details).toContainText('even when no account or library is synced');
  } finally {
    await context.close();
    await rm(profile, { recursive: true, force: true });
  }
});
