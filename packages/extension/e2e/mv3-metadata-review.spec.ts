import { test, expect, chromium, type BrowserContext } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { EXTENSION_ID } from './extension-auth.js';
import { grantOptionalBookmarks } from './bookmark-permission.js';

test('the bookmark editor reviews stale drafts and cloud conflicts locally', async () => {
  const profile = await mkdtemp(resolve(tmpdir(), 'known-metadata-review-'));
  const extension = resolve(import.meta.dirname, '../dist/development');
  let context: BrowserContext | undefined;
  try {
    context = await chromium.launchPersistentContext(profile, { headless: false, channel: 'chromium', args: [
      `--disable-extensions-except=${extension}`, `--load-extension=${extension}`,
    ] });
    const page = context.pages()[0] ?? await context.newPage();
    await page.goto(`chrome-extension://${EXTENSION_ID}/options.html#bookmarks`);
    await grantOptionalBookmarks(page, 'Allow bookmark access', 'Review'); await page.reload(); await context.setOffline(true);
    await page.getByRole('button', { name: 'Add bookmark', exact: true }).click();
    await page.getByLabel('New bookmark name').fill('Review bookmark');
    await page.getByLabel('New bookmark URL').fill('https://example.org/review-bookmark');
    await page.locator('form').filter({ has: page.getByLabel('New bookmark name') })
      .getByRole('button', { name: 'Add bookmark', exact: true }).click();
    const edit = async () => { await page.getByRole('button', { name: 'Edit bookmark Review bookmark', exact: true }).click(); return page.getByRole('dialog', { name: 'Edit bookmark' }); };
    let editor = await edit(); await editor.getByLabel('Note', { exact: true }).fill('Before');
    await editor.getByRole('button', { name: 'Save', exact: true }).click(); await expect(page.locator('.mgr-note')).toHaveText('Before');
    editor = await edit(); await editor.getByLabel('Note', { exact: true }).fill('My draft');
    await page.evaluate(async () => {
      const [bookmark] = await chrome.bookmarks.search({ url: 'https://example.org/review-bookmark' });
      await new Promise<void>((resolve, reject) => {
        const open = indexedDB.open('known-bookmark-annotations', 1);
        open.onsuccess = () => { const db = open.result, tx = db.transaction('bookmarks', 'readwrite'), table = tx.objectStore('bookmarks'), get = table.get(bookmark!.id);
          get.onsuccess = () => { const row = get.result; table.put({ ...row, note: 'Elsewhere', noteSync: { value: 'Elsewhere', version: row.noteSync.version + 1, state: 'synced' } }); };
          tx.oncomplete = () => { db.close(); resolve(); }; tx.onabort = () => { db.close(); reject(tx.error); };
        };
      });
    });
    await editor.getByRole('button', { name: 'Save', exact: true }).click();
    let review = page.getByRole('dialog', { name: 'Review both versions' });
    await expect(review.getByLabel('Your draft', { exact: true })).toHaveValue('My draft');
    await expect(review.getByLabel('Saved version', { exact: true })).toHaveValue('Elsewhere');
    await review.getByRole('button', { name: 'Use my draft', exact: true }).click(); await expect(page.locator('.mgr-note')).toHaveText('My draft');
    await page.evaluate(async () => {
      const [bookmark] = await chrome.bookmarks.search({ url: 'https://example.org/review-bookmark' });
      await new Promise<void>((resolve, reject) => {
        const open = indexedDB.open('known-bookmark-annotations', 1);
        open.onsuccess = () => { const db = open.result, tx = db.transaction('bookmarks', 'readwrite'), table = tx.objectStore('bookmarks'), get = table.get(bookmark!.id);
          get.onsuccess = () => { const row = get.result, version = row.noteSync.version;
            table.put({ ...row, noteConflictVersion: version, noteSync: { ...row.noteSync, state: 'dirty', reviewVersion: version,
              remote: { scopeKey: 'scope', resourceId: 'node', revision: 'r1', annotationId: 'note', value: 'Cloud note', supported: true } } }); };
          tx.oncomplete = () => { db.close(); resolve(); }; tx.onabort = () => { db.close(); reject(tx.error); };
        };
      });
    });
    editor = await edit(); await editor.getByRole('button', { name: 'Save', exact: true }).click();
    review = page.getByRole('dialog', { name: 'Review both versions' });
    await expect(review.getByLabel('Saved version', { exact: true })).toHaveValue('Cloud note');
    await review.getByRole('button', { name: 'Use saved version', exact: true }).click();
    await expect(page.locator('.mgr-note')).toHaveText('Cloud note');
  } finally { await context?.close(); await rm(profile, { recursive: true, force: true }); }
});
