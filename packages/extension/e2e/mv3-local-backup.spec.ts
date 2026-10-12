import { test, expect, chromium, type BrowserContext } from '@playwright/test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { EXTENSION_ID } from './extension-auth.js';
import { grantOptionalBookmarks } from './bookmark-permission.js';
import { grantTabAccess, openPopupOver } from './popup-page.js';
import type { LocalBackup } from '../src/local-backup/codec.js';
const extension = resolve(import.meta.dirname, '../dist/development');
const launch = (profile: string) => chromium.launchPersistentContext(profile, { headless: false, channel: 'chromium',
  args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });

test('a guest exports HTML and metadata, then restores offline into a different browser profile', async () => {
  test.setTimeout(90_000);
  const source = await mkdtemp(resolve(tmpdir(), 'known-backup-source-'));
  const destination = await mkdtemp(resolve(tmpdir(), 'known-backup-destination-'));
  let context: BrowserContext | undefined;
  try {
    context = await launch(source);
    let page = context.pages()[0] ?? await context.newPage();
    await page.goto(`chrome-extension://${EXTENSION_ID}/options.html#bookmarks`);
    await expect(page.locator('#side-name')).toHaveText('Not signed in');
    await grantOptionalBookmarks(page, 'Allow bookmark access', 'Know-N backup source'); await page.reload();
    await grantTabAccess(context); await page.bringToFront();
    await page.getByRole('button', { name: 'New folder', exact: true }).click();
    await page.getByRole('textbox', { name: 'New folder name', exact: true }).fill('Portable folder');
    await page.getByLabel('Description (optional)', { exact: true }).fill('Keep my local description');
    await page.locator('.mgr-composer button[type="submit"]').click();
    const row = page.locator('.mgr-row').filter({ has: page.getByRole('button', { name: 'Portable folder', exact: true }) });
    await expect(row.locator('.mgr-folder-description')).toHaveText('Keep my local description');
    const folderId = (await row.getAttribute('data-id'))!;
    await page.evaluate(async folderNativeId => {
      await chrome.storage.local.set({ 'known.sync.folder.v1': { collectionId: 'device', folderNativeId },
        'known.classification.local-key.v1': { version: 3, generation: crypto.randomUUID(), presetId: 'custom',
          endpoint: 'http://localhost:8080/classify', model: 'portable-model', secret: 'BACKUP-SECRET-MUST-NOT-EXPORT', disclosed: true } });
    }, folderId);
    await context.route('https://example.test/portable', route => route.fulfill({ contentType: 'text/html', body: '<title>Portable bookmark</title>' }));
    const target = await context.newPage(); await target.goto('https://example.test/portable');
    const popup = await openPopupOver(context, target); await expect(popup.locator('#save')).toBeEnabled(); await popup.locator('#save').click();
    await expect.poll(() => page.evaluate(() => chrome.bookmarks.search({ url: 'https://example.test/portable' }).then(nodes => nodes.length))).toBe(1);
    await popup.close(); await target.close();
    await page.locator('#nav-saving').click(); await page.locator('#bookmark-insert-top').click();
    await page.getByRole('radio', { name: /^Automatic/ }).check(); await page.getByRole('button', { name: 'Save automatic mode', exact: true }).click();
    await page.locator('#nav-bookmarks').click(); await context.setOffline(true);
    // Export is one dialog: pick the format, then Export.
    await page.locator('#manager-export').click(); await page.getByRole('radio', { name: /^Know-N backup/ }).check();
    const jsonDownload = page.waitForEvent('download'); await page.locator('#local-backup-export').click();
    const jsonFile = resolve(source, 'backup.json'); await (await jsonDownload).saveAs(jsonFile);
    const json = await readFile(jsonFile, 'utf8'), data = JSON.parse(json) as LocalBackup;
    expect(json).not.toContain('BACKUP-SECRET-MUST-NOT-EXPORT'); expect(data.history).toHaveLength(1);
    expect(data.preferences).toMatchObject({ bookmarkInsertPosition: 'top', captureMode: 'automatic' });
    expect(data.nodes.find(node => node.sourceId === folderId)?.description).toBe('Keep my local description');
    await page.locator('#manager-export').click(); await page.getByRole('radio', { name: /^HTML file/ }).check();
    const htmlDownload = page.waitForEvent('download'); await page.locator('#local-backup-export').click();
    const htmlFile = resolve(source, 'bookmarks.html'); await (await htmlDownload).saveAs(htmlFile);
    expect(await readFile(htmlFile, 'utf8')).toContain('https://example.test/portable');
    await context.close(); context = await launch(destination);
    page = context.pages()[0] ?? await context.newPage(); await page.goto(`chrome-extension://${EXTENSION_ID}/options.html#bookmarks`);
    await expect(page.locator('#side-name')).toHaveText('Not signed in');
    await grantOptionalBookmarks(page, 'Allow bookmark access', 'Know-N backup destination'); await page.reload();
    await context.setOffline(true); await page.locator('#manager-import').click();
    await page.locator('#local-import-file').setInputFiles(jsonFile);
    await expect(page.locator('#local-import-dialog')).toContainText('1 history records will be restored');
    expect(await page.evaluate(() => chrome.bookmarks.search({ title: 'Portable folder' }))).toEqual([]);
    await page.locator('#local-import-restore-settings').check();
    await page.locator('#local-import-commit').click();
    await expect(page.locator('#local-import-status')).toHaveText(`Restored ${data.nodes.length + 1} items and 1 history records to this browser.`);
    const restoredFolder = await page.evaluate(() => chrome.bookmarks.search({ title: 'Portable folder' }));
    expect(restoredFolder).toHaveLength(1);
    const effective = await page.evaluate(() => chrome.runtime.sendMessage({ kind: 'known.bookmark.preferences.local' }));
    expect(effective).toMatchObject({ ok: true, preferences: { bookmarkInsertPosition: 'top', captureMode: 'manual' } });
    const remembered = await page.evaluate(() => chrome.storage.local.get('known.sync.folder.v1'));
    expect(remembered['known.sync.folder.v1']).toMatchObject({ folderNativeId: restoredFolder[0]!.id });
    const credentials = await page.evaluate(() => chrome.storage.local.get(['known.classification.local-key.v1', 'known.classification.local-enabled.v1', 'known.classification.local-draft.v1']));
    expect(credentials['known.classification.local-key.v1']).toBeUndefined();
    expect(credentials['known.classification.local-enabled.v1']).toBe(false);
    expect(credentials['known.classification.local-draft.v1']).toMatchObject({ endpoint: 'http://localhost:8080/classify', model: 'portable-model' });
    await page.locator('#local-import-reload').click();
    await page.goto(`chrome-extension://${EXTENSION_ID}/options.html#bookmarks?native=${restoredFolder[0]!.id}`);
    await expect(page.locator('.mgr-row').filter({ has: page.getByRole('button', { name: 'Portable folder', exact: true }) }).locator('.mgr-folder-description')).toHaveText('Keep my local description');
    await page.goto(`chrome-extension://${EXTENSION_ID}/options.html#history`);
    await expect(page.locator('.hist-row')).toContainText('Restored history');
    await page.getByRole('button', { name: 'Portable bookmark', exact: true }).click();
    await expect(page.locator('.hist-detail')).toContainText('old operations will not run again');
    await expect(page.locator('.hist-detail').getByRole('link', { name: 'Locate bookmark', exact: true })).toBeVisible();
    expect(await page.evaluate(() => chrome.runtime.sendMessage({ kind: 'known.capture.list' }))).toMatchObject({ tasks: [] });
    await page.goto(`chrome-extension://${EXTENSION_ID}/options.html#ai`);
    await page.locator('#classification-source-own').check();
    if (!await page.locator('#classification-local-advanced').evaluate(node => (node as HTMLDetailsElement).open)) await page.locator('#classification-local-advanced > summary').click();
    await expect(page.locator('#classification-local-endpoint')).toHaveValue('http://localhost:8080/classify');
    await expect(page.locator('#classification-local-model')).toHaveValue('portable-model');
    await context.close(); context = await launch(destination); await context.setOffline(true);
    page = context.pages()[0] ?? await context.newPage(); await page.goto(`chrome-extension://${EXTENSION_ID}/options.html#history`);
    await expect(page.locator('.hist-row')).toContainText('Restored history');
    expect(await page.evaluate(() => chrome.bookmarks.search({ url: 'https://example.test/portable' }))).toHaveLength(1);
  } finally { await context?.close(); await rm(source, { recursive: true, force: true }); await rm(destination, { recursive: true, force: true }); }
});
