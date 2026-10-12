import { chromium, expect, test, type BrowserContext } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { EXTENSION_ID } from './extension-auth.js';
import { grantOptionalBookmarks } from './bookmark-permission.js';
import type { LocalBackup } from '../src/local-backup/codec.js';

test('a reinstalled extension associates metadata with existing bookmarks without creating copies', async () => {
  test.setTimeout(90000);
  const profile = await mkdtemp(resolve(tmpdir(), 'known-metadata-reassociation-'));
  let context: BrowserContext | undefined;
  try {
    const extension = resolve(import.meta.dirname, '../dist/development');
    context = await chromium.launchPersistentContext(profile, { headless: false, channel: 'chromium',
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
    const page = context.pages()[0] ?? await context.newPage();
    await page.goto(`chrome-extension://${EXTENSION_ID}/options.html#bookmarks`);
    await expect(page.locator('body')).toHaveAttribute('data-pane', 'bookmarks');
    await expect(page.locator('#side-name')).toHaveText('Not signed in');
    await grantOptionalBookmarks(page, 'Allow bookmark access', 'Know-N metadata reassociation'); await page.reload();
    const native = await page.evaluate(async () => {
      const bar = (await chrome.bookmarks.getTree())[0]!.children![0]!;
      const folder = await chrome.bookmarks.create({ parentId: bar.id, title: 'Recovered metadata' });
      const bookmark = await chrome.bookmarks.create({ parentId: folder.id, title: 'Kept bookmark', url: 'https://example.test/kept' });
      return { bar: { id: bar.id, title: bar.title }, folder, bookmark };
    });
    const backup: LocalBackup = { format: 'known-browser-backup', version: 1, exportedAt: Date.now(), nodes: [
      { sourceId: 'old-bar', parentIndex: null, title: native.bar.title },
      { sourceId: 'old-folder', parentIndex: 0, title: native.folder.title, description: 'Recovered folder description' },
      { sourceId: 'old-bookmark', parentIndex: 1, title: native.bookmark.title, url: native.bookmark.url!, tags: ['restored'], note: 'Recovered note' },
    ], history: [], preferences: {}, language: 'en', defaultFolderSourceId: null, aiConfig: null };
    await context.setOffline(true);
    for (let i = 0; i < 2; i++) {
      await page.locator('#manager-import').click();
      await page.locator('#local-import-file').setInputFiles({ name: 'metadata.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(backup)) });
      await expect(page.locator('#local-import-existing-metadata')).toBeVisible();
      await page.locator('#local-import-existing-metadata').click();
      await expect(page.locator('#metadata-restore-status')).toContainText('2 matching items');
      await page.locator('#metadata-restore-confirm').click();
      await expect(page.locator('#metadata-restore-status')).toContainText('Metadata restored to 2 existing items');
      await page.locator('#metadata-restore-dialog').getByRole('button', { name: 'Done', exact: true }).click();
    }
    const exported = await page.evaluate(() => chrome.runtime.sendMessage({ kind: 'known.localBackup.export', format: 'json' })) as { ok: boolean; content: string };
    expect(exported.ok).toBe(true);
    const restored = JSON.parse(exported.content) as LocalBackup;
    expect(restored.nodes.find(node => node.sourceId === native.folder.id)?.description).toBe('Recovered folder description');
    expect(restored.nodes.find(node => node.sourceId === native.bookmark.id)).toMatchObject({ tags: ['restored'], note: 'Recovered note' });
    expect(await page.evaluate(() => chrome.bookmarks.search({ url: 'https://example.test/kept' }))).toHaveLength(1);
    expect(await page.evaluate(() => chrome.bookmarks.search({ title: 'Recovered metadata' }))).toHaveLength(1);
  } finally { await context?.close(); await rm(profile, { recursive: true, force: true }); }
});
