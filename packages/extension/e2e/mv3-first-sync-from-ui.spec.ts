import { chromium, expect, test, type BrowserContext } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { startRealStack } from './real-stack.js';
import { openExtensionOptions, showOptionsPane, waitForLibraryBinding, EXTENSION_FIXTURE_EMAIL, EXTENSION_FIXTURE_PASSWORD } from './extension-auth.js';
import { grantOptionalBookmarks } from './bookmark-permission.js';

const extension = resolve(import.meta.dirname, '../dist/production');
type CanonicalNode = { id: string; parent_id: string | null; title: string; url: string | null; folder_role: string | null; deleted_at: string | null };

test('a fresh browser merges both roots into one library, keeps exclusions local and syncs later folders', async () => {
  test.setTimeout(180_000);
  const stack = await startRealStack(), profile = await mkdtemp(resolve(tmpdir(), 'known-library-ui-'));
  let context: BrowserContext | undefined;
  const nodes = async () => ((await stack.observations()).canonicalNodes as CanonicalNode[]).filter(node => node.deleted_at === null);
  try {
    const initial = await nodes();
    expect(initial).toHaveLength(3);
    expect(initial.filter(node => node.folder_role === 'bookmarks-bar')).toHaveLength(1);
    expect(initial.filter(node => node.folder_role === 'other-bookmarks')).toHaveLength(1);
    context = await chromium.launchPersistentContext(profile, { headless: false, channel: 'chromium', ignoreHTTPSErrors: true,
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`,
        `--host-resolver-rules=${stack.browserHostResolverRules}`, '--no-proxy-server', '--ignore-certificate-errors'] });
    const { page } = await openExtensionOptions(context);
    await showOptionsPane(page, 'bookmarks');
    await grantOptionalBookmarks(page, page.locator('#manager-grant'), 'COLP library first sync');
    const native = await page.evaluate(async () => {
      const roots = (await chrome.bookmarks.getTree())[0]!.children!;
      const bar = roots.find(node => node.id === '1') ?? roots[0]!;
      const other = roots.find(node => node.id === '2') ?? roots[1]!;
      await chrome.bookmarks.create({ parentId: bar.id, title: 'From the bar', url: 'https://example.test/from-bar' });
      await chrome.bookmarks.create({ parentId: other.id, title: 'From other bookmarks', url: 'https://example.test/from-other' });
      const local = await chrome.bookmarks.create({ parentId: bar.id, title: 'Only on this browser' });
      await chrome.bookmarks.create({ parentId: local.id, title: 'Private browser page', url: 'https://example.test/browser-only' });
      return { bar: bar.id, other: other.id, local: local.id };
    });
    await showOptionsPane(page, 'account');
    await page.locator('#login-email').fill(EXTENSION_FIXTURE_EMAIL);
    await page.locator('#login-password').fill(EXTENSION_FIXTURE_PASSWORD);
    await page.locator('#login-submit').click();
    await expect(page.locator('body')).toHaveAttribute('data-state', 'connected', { timeout: 20_000 });
    expect(await waitForLibraryBinding(page)).toBe(stack.collectionId);
    await showOptionsPane(page, 'folders');
    await expect(page.locator('#folder-heading')).toContainText("Sync this browser's bookmarks with");
    const rows = page.locator('.root-row');
    await expect(rows.filter({ has: page.locator('.folder-name', { hasText: 'Bookmarks bar' }) }).locator('.root-select input')).toBeChecked();
    await expect(rows.filter({ has: page.locator('.folder-name', { hasText: 'Other bookmarks' }) }).locator('.root-select input')).toBeChecked();
    const localRow = rows.filter({ has: page.locator('.folder-name', { hasText: 'Only on this browser' }) });
    await localRow.locator('.root-select input').uncheck();
    await expect(page.locator('#first-run-start')).toBeEnabled({ timeout: 15_000 });
    // One list card contains the tree, the merge explanation, Advanced and confirmation.
    await expect(page.locator('.folder-tree-card #first-run-confirm')).toHaveCount(1);
    await expect(page.locator('#first-run-advanced')).not.toHaveAttribute('open');
    await page.setViewportSize({ width: 1280, height: 960 });
    await page.screenshot({ path: '/tmp/colp-e2-first-run-desktop.png', fullPage: true });
    await page.setViewportSize({ width: 640, height: 960 });
    await page.screenshot({ path: '/tmp/colp-e2-first-run-narrow.png', fullPage: true });
    await page.setViewportSize({ width: 1280, height: 960 });
    await page.locator('#first-run-start').click();
    await expect(page.locator('#sync-progress')).toBeVisible({ timeout: 5_000 });
    await expect.poll(() => page.evaluate(async () => (await chrome.runtime.sendMessage({ kind: 'known.firstRun.status' }) as { firstRun?: string }).firstRun),
      { timeout: 90_000 }).toBe('completed');
    await expect.poll(async () => (await nodes()).filter(node => node.url).map(node => node.url), { timeout: 45_000 })
      .toEqual(expect.arrayContaining(['https://example.test/from-bar', 'https://example.test/from-other']));
    const merged = await nodes();
    const bars = merged.filter(node => node.folder_role === 'bookmarks-bar');
    const others = merged.filter(node => node.folder_role === 'other-bookmarks');
    expect(bars).toHaveLength(1); expect(others).toHaveLength(1);
    expect(bars[0]!.id).toBe(initial.find(node => node.folder_role === 'bookmarks-bar')!.id);
    expect(others[0]!.id).toBe(initial.find(node => node.folder_role === 'other-bookmarks')!.id);
    expect(merged.find(node => node.url === 'https://example.test/from-bar')!.parent_id).toBe(bars[0]!.id);
    expect(merged.find(node => node.url === 'https://example.test/from-other')!.parent_id).toBe(others[0]!.id);
    expect(merged.some(node => node.title === 'Only on this browser' || node.url === 'https://example.test/browser-only')).toBe(false);
    expect(await page.evaluate(async id => (await chrome.bookmarks.get(id)).length, native.local)).toBe(1);
    await page.evaluate(async ({ bar }) => {
      const folder = await chrome.bookmarks.create({ parentId: bar, title: 'Created after first sync' });
      await chrome.bookmarks.create({ parentId: folder.id, title: 'Later page', url: 'https://example.test/later-folder' });
    }, native);
    await expect.poll(async () => (await nodes()).map(node => node.title), { timeout: 45_000 }).toContain('Created after first sync');
    await expect.poll(async () => (await nodes()).map(node => node.url), { timeout: 45_000 }).toContain('https://example.test/later-folder');
    await showOptionsPane(page, 'sync-center');
    await expect(page.locator('#personal-sync-status')).toHaveText('Personal sync is enabled');
    await expect(page.locator('#library-metadata-configure')).toBeVisible();
    await page.screenshot({ path: '/tmp/colp-e2-status-desktop.png', fullPage: true });
  } finally { await context?.close(); await stack.close(); await rm(profile, { recursive: true, force: true }); }
});
