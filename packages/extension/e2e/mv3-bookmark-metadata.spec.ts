import { test, expect, chromium, type BrowserContext } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { EXTENSION_ID } from './extension-auth.js';
import { grantOptionalBookmarks } from './bookmark-permission.js';

test('guest tags and notes persist through restart and clearing retains the pending metadata deletion', async () => {
  const profile = await mkdtemp(resolve(tmpdir(), 'known-bookmark-metadata-'));
  const extension = resolve(import.meta.dirname, '../dist/development');
  const launch = () => chromium.launchPersistentContext(profile, { headless: false, channel: 'chromium', args: [
    `--disable-extensions-except=${extension}`, `--load-extension=${extension}`,
  ] });
  let context: BrowserContext | undefined;
  try {
    context = await launch();
    let page = context.pages()[0] ?? await context.newPage();
    await page.goto(`chrome-extension://${EXTENSION_ID}/options.html#bookmarks`);
    await grantOptionalBookmarks(page, 'Allow bookmark access', 'Metadata'); await page.reload();
    await context.setOffline(true);
    await page.getByRole('button', { name: 'New bookmark' }).click();
    await page.getByLabel('New bookmark name').fill('Metadata bookmark');
    await page.getByLabel('New bookmark URL').fill('https://example.org/metadata-bookmark');
    await page.getByRole('button', { name: 'Add bookmark' }).click();
    const edit = async () => {
      await page.getByRole('button', { name: 'Edit bookmark Metadata bookmark', exact: true }).click();
      return page.getByRole('dialog', { name: 'Edit bookmark' });
    };
    let dialog = await edit();
    await dialog.getByLabel('Tags', { exact: true }).fill('research');
    await dialog.getByLabel('Tags', { exact: true }).press('Enter');
    await dialog.getByLabel('Note', { exact: true }).fill('Private offline note');
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.locator('.mgr-note')).toHaveText('Private offline note');
    await context.close(); context = await launch(); await context.setOffline(true);
    page = context.pages()[0] ?? await context.newPage();
    await page.goto(`chrome-extension://${EXTENSION_ID}/options.html#bookmarks`);
    await expect(page.locator('.mini-tag')).toHaveText('research');
    await expect(page.locator('.mgr-note')).toHaveText('Private offline note');
    dialog = await edit();
    await dialog.getByRole('button', { name: 'Remove tag research', exact: true }).click();
    await dialog.getByLabel('Note', { exact: true }).fill('');
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.locator('.mini-tag')).toHaveCount(0); await expect(page.locator('.mgr-note')).toHaveCount(0);
    const row = await page.evaluate(async () => {
      const [bookmark] = await chrome.bookmarks.search({ url: 'https://example.org/metadata-bookmark' });
      return new Promise(resolve => {
        const open = indexedDB.open('known-bookmark-annotations', 1);
        open.onsuccess = () => {
          const db = open.result, request = db.transaction('bookmarks').objectStore('bookmarks').get(bookmark!.id);
          request.onsuccess = () => { resolve(request.result); db.close(); };
        };
      });
    });
    expect(row).toMatchObject({ tags: [], note: null, tagsSync: { state: 'dirty' }, noteSync: { state: 'dirty' } });
  } finally { await context?.close(); await rm(profile, { recursive: true, force: true }); }
});

test('a guest can edit a note without truncating retained overflow or legacy tag members', async () => {
  const profile = await mkdtemp(resolve(tmpdir(), 'known-bookmark-overflow-'));
  const extension = resolve(import.meta.dirname, '../dist/development');
  const context = await chromium.launchPersistentContext(profile, { headless: false, channel: 'chromium', args: [
    `--disable-extensions-except=${extension}`, `--load-extension=${extension}`,
  ] });
  try {
    const page = context.pages()[0] ?? await context.newPage();
    await page.goto(`chrome-extension://${EXTENSION_ID}/options.html#bookmarks`);
    await grantOptionalBookmarks(page, 'Allow bookmark access', 'Retained tags'); await page.reload();
    await page.getByRole('button', { name: 'New bookmark' }).click();
    await page.getByLabel('New bookmark name').fill('Retained tags');
    await page.getByLabel('New bookmark URL').fill('https://example.org/retained-tags');
    await page.getByRole('button', { name: 'Add bookmark' }).click();
    await expect(page.locator('#manager-feedback')).toHaveText('Bookmark added.');
    const tags = [...Array.from({ length: 80 }, (_, i) => `tag-${i}`), '😀'.repeat(48)];
    await page.evaluate(async tags => {
      const [bookmark] = await chrome.bookmarks.search({ url: 'https://example.org/retained-tags' });
      await new Promise<void>((resolve, reject) => {
        const open = indexedDB.open('known-bookmark-annotations', 1);
        open.onerror = () => reject(open.error);
        open.onupgradeneeded = () => { open.result.createObjectStore('bookmarks', { keyPath: 'nativeId' }); };
        open.onsuccess = () => {
          const db = open.result, tx = db.transaction('bookmarks', 'readwrite');
          tx.objectStore('bookmarks').put({ nativeId: bookmark!.id, dateAdded: bookmark!.dateAdded, url: bookmark!.url,
            tags, note: 'Before', version: 1, updatedAt: Date.now() });
          tx.oncomplete = () => { db.close(); resolve(); };
          tx.onabort = tx.onerror = () => { db.close(); reject(tx.error); };
        };
      });
    }, tags);
    await page.getByRole('button', { name: 'Edit bookmark Retained tags', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Edit bookmark' });
    await expect(dialog.locator('.tag-input .chip')).toHaveCount(tags.length);
    await expect(dialog).toContainText('All tags are saved in this browser');
    await dialog.getByLabel('Note', { exact: true }).fill('Changed note only');
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await page.getByRole('button', { name: 'Edit bookmark Retained tags', exact: true }).click();
    await expect(page.getByRole('dialog').locator('.tag-input .chip')).toHaveCount(tags.length);
    await expect(page.getByRole('dialog').getByLabel('Note', { exact: true })).toHaveValue('Changed note only');
  } finally { await context.close(); await rm(profile, { recursive: true, force: true }); }
});
