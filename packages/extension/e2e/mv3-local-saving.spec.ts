import { test, expect, chromium } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { EXTENSION_ID } from './extension-auth.js';
import { grantOptionalBookmarks } from './bookmark-permission.js';
import { grantTabAccess } from './popup-page.js';
import { capturePopupTarget } from './capture-popup-cdp.js';

const extensionPath = resolve(import.meta.dirname, '../dist/development');
test('a guest enables auto-save without AI, then saves a page and a tab batch while offline', async () => {
  test.setTimeout(90_000);
  const profile = await mkdtemp(resolve(tmpdir(), 'known-local-saving-'));
  const context = await chromium.launchPersistentContext(profile, { headless: false, channel: 'chromium', args: [
    '--remote-debugging-port=0', `--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`,
  ] });
  try {
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
    const options = context.pages().find(page => page.url().includes('/options.html')) ?? await context.newPage();
    await options.goto(`chrome-extension://${EXTENSION_ID}/options.html`);
    await expect(options.locator('body')).toHaveAttribute('data-pane', 'bookmarks');
    await grantOptionalBookmarks(options, 'Allow bookmark access', 'Known local saving');
    await grantTabAccess(context);
    await options.evaluate(async () => {
      const folder = (await chrome.bookmarks.getTree())[0]!.children![0]!;
      await chrome.storage.local.set({ 'known.sync.folder.v1': { collectionId: 'device', folderNativeId: folder.id } });
    });
    await options.bringToFront();
    await options.locator('#nav-saving').click();
    await expect(options.locator('#classification-local-settings')).toBeHidden();
    await options.getByRole('radio', { name: /^Automatic/ }).check();
    await expect(options.locator('dialog[open]')).toContainText('No account or AI service is needed');
    await options.getByRole('button', { name: 'Save automatic mode', exact: true }).click();
    await options.locator('#nav-history').click();
    // Without an AI service there is no suggestions row; the card names where saves go and the worker reports the mode.
    await expect(options.locator('[data-capture-controls]')).toContainText('Saves go to');
    const control = await options.evaluate(() => chrome.runtime.sendMessage({ kind: 'known.capture.control' }));
    expect(control).toMatchObject({ signedIn: false, local: false, mode: 'automatic', state: 'automatic', classificationState: 'off' });

    await context.route('https://example.org/local-first-*', route => route.fulfill({ contentType: 'text/html', body: '<title>Offline local save</title><p>Local bookmark fixture</p>' }));
    const second = await context.newPage(); await second.goto('https://example.org/local-first-batch');
    const active = await context.newPage(); await active.goto('https://example.org/local-first-auto');
    await context.setOffline(true);
    const popup = await capturePopupTarget(context, profile, active);
    await expect.poll(() => popup.evaluate<string>("document.body.dataset.complete")).toBe("true");
    expect(await popup.evaluate<string>("document.getElementById(\"capture\")?.textContent")).not.toContain("Choosing a folder");
    await popup.evaluate('document.activeElement?.blur()');
    await expect.poll(() => options.evaluate(() => chrome.bookmarks.search({ url: 'https://example.org/local-first-auto' }).then(nodes => nodes.length))).toBe(1);
    await expect.poll(() => worker.evaluate(() => chrome.runtime.getContexts({ contextTypes: ['POPUP'] }).then(contexts => contexts.length)), { timeout: 15_000 }).toBe(0);
    const captures = await options.evaluate(() => chrome.runtime.sendMessage({ kind: 'known.capture.list' }));
    expect(captures).toMatchObject({ tasks: [expect.objectContaining({ save: 'local-saved', classification: 'none', sync: 'local-only', scope: expect.objectContaining({ accountId: null, collectionId: null }) })] });

    const batch = await context.newPage();
    await batch.goto(`chrome-extension://${EXTENSION_ID}/capture-tabs.html`);
    await expect(batch.locator('#tabs-confirm')).toBeEnabled();
    await expect(batch.locator('#tabs-allow-cloud')).toHaveCount(0);
    await batch.locator('#tabs-confirm').click();
    await expect.poll(() => options.evaluate(() => chrome.bookmarks.search({ url: 'https://example.org/local-first-batch' }).then(nodes => nodes.length))).toBe(1);
    expect(await options.evaluate(() => chrome.bookmarks.search({ url: 'https://example.org/local-first-auto' }))).toHaveLength(1);
  } finally { await context.close(); await rm(profile, { recursive: true, force: true }); }
});
