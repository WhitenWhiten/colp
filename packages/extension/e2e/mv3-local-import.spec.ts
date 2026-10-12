import { test, expect, chromium, type BrowserContext } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { openExtensionOptions } from './extension-auth.js';
import { grantOptionalBookmarks } from './bookmark-permission.js';

const extensionPath = resolve(import.meta.dirname, '../dist/development');
const html = '<!DOCTYPE NETSCAPE-Bookmark-file-1><DL><DT><H3>Recipes</H3><DL><DT><A HREF="https://example.org/local-import">Pasta</A><DT><A HREF="https://example.org/local-import">Pasta</A></DL></DL>';
const launch = (profile: string) => chromium.launchPersistentContext(profile, { headless: false, channel: 'chromium', args: [
  `--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`,
] });

test('a fresh guest imports an HTML file offline and keeps the completed import after browser restart', async () => {
  test.setTimeout(90_000);
  const profile = await mkdtemp(resolve(tmpdir(), 'known-local-import-'));
  let context: BrowserContext | undefined;
  try {
    context = await launch(profile);
    let { page } = await openExtensionOptions(context);
    await page.locator('#nav-bookmarks').click();
    await grantOptionalBookmarks(page, 'Allow bookmark access', 'Known local import');
    await page.reload();
    await page.locator('#nav-bookmarks').click();
    await page.locator('#manager-import').click();
    const parentId = await page.evaluate(async () => (await chrome.bookmarks.getTree())[0]!.children![0]!.id);
    await expect(page.locator('#local-import-target')).toHaveAttribute('data-value', parentId);
    await context.setOffline(true);
    await page.locator('#local-import-file').setInputFiles({ name: 'bookmarks.html', mimeType: 'text/html', buffer: Buffer.from(html) });
    await page.locator('#local-import-title').fill('My offline import');
    await expect(page.locator('#local-import-commit')).toBeEnabled();
    expect(await page.evaluate(() => chrome.bookmarks.search({ title: 'My offline import' }))).toHaveLength(0);
    await page.locator('#local-import-commit').click();
    await expect(page.locator('#local-import-status')).toHaveText('Imported 4 items to this browser.');
    expect(await page.evaluate(() => chrome.bookmarks.search({ url: 'https://example.org/local-import' }))).toHaveLength(2);
    const auth = await page.evaluate(() => chrome.runtime.sendMessage({ kind: 'known.auth.status' }));
    expect(auth).toMatchObject({ state: { status: 'signed_out' } });
    await context.close();
    context = await launch(profile);
    ({ page } = await openExtensionOptions(context));
    await context.setOffline(true);
    await page.locator('#nav-bookmarks').click();
    await page.locator('#manager-import').click();
    await expect(page.locator('#local-import-status')).toHaveText('Imported 4 items to this browser.');
    expect(await page.evaluate(() => chrome.bookmarks.search({ title: 'My offline import' }))).toHaveLength(1);
    expect(await page.evaluate(() => chrome.bookmarks.search({ url: 'https://example.org/local-import' }))).toHaveLength(2);
  } finally { await context?.close(); await rm(profile, { recursive: true, force: true }); }
});
