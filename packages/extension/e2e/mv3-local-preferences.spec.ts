import { test, expect, chromium } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { EXTENSION_ID, gotoOptions } from './extension-auth.js';
import { interceptPreferenceNetwork, setPreferenceAccount } from './bookmark-preference-fixture.js';
import { grantOptionalBookmarks } from './bookmark-permission.js';
import { grantTabAccess, openPopupOver } from './popup-page.js';
import type { LocalHistoryItem } from '../src/capture/local-history.js';

test('account preferences acknowledge local commits and remain editable while Product waits', async () => {
  const profile = await mkdtemp(resolve(tmpdir(), 'known-local-preferences-'));
  const extension = resolve(import.meta.dirname, '../dist/development');
  const context = await chromium.launchPersistentContext(profile, { headless: false, channel: 'chromium',
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  try {
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
    await interceptPreferenceNetwork(worker);
    const page = context.pages()[0] ?? await context.newPage();
    await gotoOptions(page, '#saving');
    await setPreferenceAccount(page); await page.reload();
    await expect(page.locator('#bookmark-insert-bottom')).toBeChecked();
    await worker.evaluate(() => { (globalThis as typeof globalThis & { fixtureHoldPatch?: boolean }).fixtureHoldPatch = true; });
    await page.locator('#bookmark-insert-top').click();
    await expect.poll(() => worker.evaluate(() => (globalThis as typeof globalThis & { fixturePatchStarted?: boolean }).fixturePatchStarted)).toBe(true);
    await expect(page.locator('#bookmark-insert-top')).toBeEnabled();
    await expect(page.locator('#bookmark-preferences-status')).toContainText('Saved on this browser');
    // Folders first is off by default; the click turns it on.
    await page.locator('#bookmark-folders-first').click();
    await expect(page.locator('#bookmark-folders-first')).toBeEnabled();
    const effective = await page.evaluate(() => chrome.runtime.sendMessage({ kind: 'known.bookmark.preferences.local' }));
    expect(effective).toMatchObject({ pending: true, preferences: { bookmarkInsertPosition: 'top', foldersFirst: true } });
    await worker.evaluate(() => (globalThis as typeof globalThis & { fixtureReleasePatch?: () => void }).fixtureReleasePatch?.());
    await expect(page.locator('#bookmark-insert-top')).toBeChecked();
    await expect(page.locator('#bookmark-folders-first')).toBeChecked();
  } finally { await context.close(); await rm(profile, { recursive: true, force: true }); }
});

test('sign-in preserves device saving choices and the guest timeline, while guest records stay local', async () => {
  const profile = await mkdtemp(resolve(tmpdir(), 'known-device-continuity-'));
  const extension = resolve(import.meta.dirname, '../dist/development');
  const context = await chromium.launchPersistentContext(profile, { headless: false, channel: 'chromium',
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  try {
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
    const page = context.pages()[0] ?? await context.newPage();
    await page.goto(`chrome-extension://${EXTENSION_ID}/options.html#bookmarks`);
    await expect(page.locator('#side-name')).toHaveText('Not signed in');
    await grantOptionalBookmarks(page, 'Allow bookmark access', 'Know-N continuity'); await grantTabAccess(context);
    await context.route('https://example.test/**', route => route.fulfill({ contentType: 'text/html', body: '<title>Saved as guest</title>' }));
    const target = await context.newPage(); await target.goto('https://example.test/guest-record');
    const popup = await openPopupOver(context, target); await expect(popup.locator('#save')).toBeEnabled(); await popup.locator('#save').click();
    await expect.poll(() => page.evaluate(() => chrome.bookmarks.search({ url: 'https://example.test/guest-record' }).then(nodes => nodes.length))).toBe(1);
    await popup.close();
    await page.locator('#nav-saving').click();
    await page.locator('#bookmark-insert-top').click();
    await page.getByRole('radio', { name: /^Automatic/ }).check();
    await page.getByRole('button', { name: 'Save automatic mode', exact: true }).click();
    await expect(page.getByRole('radio', { name: /^Automatic/ })).toBeChecked();
    await interceptPreferenceNetwork(worker); await setPreferenceAccount(page); await page.reload();
    await expect(page.locator('#bookmark-insert-top')).toBeChecked();
    await expect(page.getByRole('radio', { name: /^Automatic/ })).toBeChecked();
    await page.locator('#nav-history').click();
    await expect(page.locator('.hist-row').filter({ hasText: 'Saved as guest' })).toContainText('Saved before sign-in');
    await page.locator('.hist-row').getByRole('button', { name: 'Saved as guest', exact: true }).click();
    await expect(page.locator('.hist-detail')).toContainText('This record stays local');
    await expect(page.locator('.hist-detail').getByRole('button', { name: 'Edit saved bookmark', exact: true })).toHaveCount(0);
    await expect(page.locator('.hist-detail').getByRole('link', { name: 'Locate bookmark', exact: true })).toBeVisible();
    const history = await page.evaluate(() => chrome.runtime.sendMessage({ kind: 'known.capture.history', days: 7, timezone: 'UTC',
      status: 'all', q: '', source: '', collectionId: '', deviceScope: 'local' })) as { items: LocalHistoryItem[]; unreported: number };
    expect(history.items).toHaveLength(1); expect(history.items[0]).toMatchObject({ scope: { accountId: null }, historyReadOnly: true });
    expect(history.unreported).toBe(0);
    await page.evaluate(() => chrome.storage.session.remove('known.auth.credential.v1'));
    await page.goto(`chrome-extension://${EXTENSION_ID}/options.html#saving`);
    await expect(page.locator('#bookmark-insert-top')).toBeChecked();
    await expect(page.getByRole('radio', { name: /^Automatic/ })).toBeChecked();
  } finally { await context.close(); await rm(profile, { recursive: true, force: true }); }
});
