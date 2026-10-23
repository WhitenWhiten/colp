import { chromium, expect, test, type BrowserContext } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { startRealStack } from './real-stack.js';
import { openExtensionOptions, showOptionsPane, waitForLibraryBinding, signInExtension, EXTENSION_FIXTURE_EMAIL, EXTENSION_FIXTURE_PASSWORD } from './extension-auth.js';
import { grantOptionalBookmarks } from './bookmark-permission.js';

const extension = resolve(import.meta.dirname, '../dist/production');
type CanonicalNode = { id: string; parent_id: string | null; title: string; url: string | null; folder_role: string | null; deleted_at: string | null };

test('a fresh browser merges both roots into one library, keeps exclusions local and syncs later folders', async () => {
  // SYNC_EXISTING_COUNT=1019 also exercises completion with 1,021 synced bookmarks.
  const extraBookmarks = Number(process.env.SYNC_EXISTING_COUNT ?? 0);
  test.setTimeout(extraBookmarks > 0 ? 600_000 : 180_000);
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
    const native = await page.evaluate(async (extraCount) => {
      const roots = (await chrome.bookmarks.getTree())[0]!.children!;
      const bar = roots.find(node => node.id === '1') ?? roots[0]!;
      const other = roots.find(node => node.id === '2') ?? roots[1]!;
      await chrome.bookmarks.create({ parentId: bar.id, title: 'From the bar', url: 'https://example.test/from-bar' });
      await chrome.bookmarks.create({ parentId: other.id, title: 'From other bookmarks', url: 'https://example.test/from-other' });
      for (let index = 0; index < extraCount; index++) await chrome.bookmarks.create({ parentId: bar.id,
        title: `Existing ${index}`, url: `https://example.test/existing/${index}` });
      const local = await chrome.bookmarks.create({ parentId: bar.id, title: 'Only on this browser' });
      await chrome.bookmarks.create({ parentId: local.id, title: 'Private browser page', url: 'https://example.test/browser-only' });
      return { bar: bar.id, other: other.id, local: local.id };
    }, extraBookmarks);
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
    try {
      await expect.poll(async () => (await nodes()).filter(node => node.url).length,
        { timeout: extraBookmarks > 0 ? 400_000 : 90_000 }).toBe(extraBookmarks + 2);
      await expect.poll(() => page.evaluate(async () => (await chrome.runtime.sendMessage({ kind: 'known.firstRun.status' }) as { firstRun?: string }).firstRun),
        { timeout: 45_000 }).toBe('completed');
    } catch (error) {
      console.log(JSON.stringify(await page.evaluate(async () => ({
        progress: await chrome.runtime.sendMessage({ kind: 'known.sync.progress.get' }),
        bootstrap: await chrome.runtime.sendMessage({ kind: 'known.firstRun.status' }),
        engine: await chrome.runtime.sendMessage({ kind: 'known.sync.engine.status' }),
        attention: await chrome.runtime.sendMessage({ kind: 'known.sync.attention.get' }),
      }))));
      throw error;
    }
    await expect(page.locator('#sync-progress-title')).toHaveText('Sync complete', { timeout: 5_000 });
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
    await expect(page.locator('#personal-sync-status')).toHaveText('Sync is on');
    await expect(page.locator('#library-metadata-configure')).toBeVisible();
    await page.screenshot({ path: '/tmp/colp-e2-status-desktop.png', fullPage: true });
  } finally { await context?.close(); await stack.close(); await rm(profile, { recursive: true, force: true }); }
});

test('a directly selected subfolder survives reload and reconnect without duplicate uploads', async () => {
  test.setTimeout(180_000);
  const stack = await startRealStack(), profile = await mkdtemp(resolve(tmpdir(), 'known-subfolder-ui-'));
  let context: BrowserContext | undefined;
  try {
    context = await chromium.launchPersistentContext(profile, { headless: false, channel: 'chromium', ignoreHTTPSErrors: true,
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`,
        `--host-resolver-rules=${stack.browserHostResolverRules}`, '--no-proxy-server', '--ignore-certificate-errors'] });
    const { page } = await openExtensionOptions(context);
    await showOptionsPane(page, 'bookmarks');
    await grantOptionalBookmarks(page, page.locator('#manager-grant'), 'COLP selected subfolder');
    await page.evaluate(async () => {
      const roots = (await chrome.bookmarks.getTree())[0]!.children!;
      const bar = roots.find(node => node.id === '1') ?? roots[0]!;
      const other = roots.find(node => node.id === '2') ?? roots[1]!;
      await chrome.bookmarks.create({ parentId: bar.id, title: 'Parent bookmark stays local', url: 'https://example.test/parent-local' });
      await chrome.bookmarks.create({ parentId: other.id, title: 'Other root stays local', url: 'https://example.test/other-local' });
      const parent = await chrome.bookmarks.create({ parentId: bar.id, title: 'Unselected parent' });
      await chrome.bookmarks.create({ parentId: parent.id, title: 'Sibling stays local', url: 'https://example.test/sibling-local' });
      const child = await chrome.bookmarks.create({ parentId: parent.id, title: 'Selected child' });
      await chrome.bookmarks.create({ parentId: child.id, title: 'Only selected bookmark', url: 'https://example.test/selected-only' });
    });
    await signInExtension(page);
    await showOptionsPane(page, 'folders');
    await expect(page.locator('#tree-clear-selection')).toBeEnabled();
    await page.locator('#tree-clear-selection').click();
    const child = page.locator('.root-row').filter({ has: page.getByText('Selected child', { exact: true }) }).locator('input');
    const parent = page.locator('.root-row').filter({ has: page.getByText('Unselected parent', { exact: true }) }).locator('input');
    await expect(child).toBeEnabled();
    await child.check();
    await expect.poll(() => parent.evaluate(input => (input as HTMLInputElement).indeterminate)).toBe(true);
    await expect(page.locator('#first-run-start')).toBeEnabled();
    await page.reload();
    await showOptionsPane(page, 'folders');
    await expect(child).toBeChecked();
    await expect.poll(() => parent.evaluate(input => (input as HTMLInputElement).indeterminate)).toBe(true);
    await expect(page.locator('#first-run-start')).toBeEnabled();
    await page.locator('#first-run-start').click();
    await expect.poll(() => page.evaluate(async () => (await chrome.runtime.sendMessage({ kind: 'known.firstRun.status' }) as { firstRun?: string }).firstRun),
      { timeout: 90_000 }).toBe('completed');
    await expect.poll(async () => ((await stack.observations()).canonicalNodes as CanonicalNode[])
      .filter(node => node.deleted_at === null && node.url).map(node => node.url)).toEqual(['https://example.test/selected-only']);
    expect(await page.evaluate(() => chrome.bookmarks.search({ url: 'https://example.test/parent-local' }).then(rows => rows.length))).toBe(1);
    await page.reload();
    await showOptionsPane(page, 'folders');
    await expect(child).toBeChecked();
    await expect.poll(() => parent.evaluate(input => (input as HTMLInputElement).indeterminate)).toBe(true);
    const before = ((await stack.observations()).canonicalNodes as CanonicalNode[])
      .filter(node => node.deleted_at === null).map(node => node.id).sort();
    const nativeBefore = await page.evaluate(async () => {
      const flatten = (nodes: chrome.bookmarks.BookmarkTreeNode[]): string[] => nodes.flatMap(node =>
        [JSON.stringify([node.id, node.parentId, node.title, node.url]), ...flatten(node.children ?? [])]);
      return flatten(await chrome.bookmarks.getTree());
    });
    await showOptionsPane(page, 'sync-center');
    await page.getByRole('button', { name: 'Disconnect sync', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Disconnect sync', exact: true }).click();
    await expect(page.locator('#personal-sync-status')).toHaveText('Sync is disconnected');
    await page.getByRole('button', { name: 'Reconnect sync', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Resume sync', exact: true }).click();
    await expect(page.locator('#personal-sync-status')).toHaveText(/^(Sync is on|Ready to sync\.)/u);
    await page.reload();
    await showOptionsPane(page, 'folders');
    await page.locator('#tree-clear-selection').click();
    await child.check();
    await expect(page.locator('#first-run-start')).toBeEnabled();
    await page.locator('#first-run-start').click();
    await expect.poll(() => page.evaluate(async () => (await chrome.runtime.sendMessage({ kind: 'known.firstRun.status' }) as { firstRun?: string }).firstRun),
      { timeout: 90_000 }).toBe('completed');
    expect(((await stack.observations()).canonicalNodes as CanonicalNode[])
      .filter(node => node.deleted_at === null).map(node => node.id).sort()).toEqual(before);
    expect(await page.evaluate(async () => {
      const flatten = (nodes: chrome.bookmarks.BookmarkTreeNode[]): string[] => nodes.flatMap(node =>
        [JSON.stringify([node.id, node.parentId, node.title, node.url]), ...flatten(node.children ?? [])]);
      return flatten(await chrome.bookmarks.getTree());
    })).toEqual(nativeBefore);
    await page.reload();
    await showOptionsPane(page, 'folders');
    await expect(page.locator('body')).toHaveAttribute('data-first-run', '');
    await page.evaluate(async () => {
      const bar = (await chrome.bookmarks.getTree())[0]!.children![0]!;
      const folder = await chrome.bookmarks.create({ parentId: bar.id, title: 'Later selected folder' });
      for (let index = 0; index < 10; index++) await chrome.bookmarks.create({ parentId: folder.id,
        title: `Later bookmark ${index}`, url: `https://example.test/later-selected/${index}` });
    });
    await page.locator('#refresh-roots').click();
    const later = page.locator('.root-row').filter({ has: page.getByText('Later selected folder', { exact: true }) }).locator('input');
    await expect(later).toBeEnabled();
    await later.check();
    await page.locator('#save-roots').click();
    await expect(page.locator('#range-preview-totals')).toContainText('1 folder and 10 bookmarks will start syncing.');
    await page.locator('#range-confirm').click();
    await expect(page.locator('#range-preview')).toBeHidden();
    await expect(page.locator('#sync-progress')).toBeVisible({ timeout: 5_000 });
    const readStatus = () => page.evaluate(async () => ({
      progress: await chrome.runtime.sendMessage({ kind: 'known.sync.progress.get' }),
      bootstrap: await chrome.runtime.sendMessage({ kind: 'known.firstRun.status' }),
      engine: await chrome.runtime.sendMessage({ kind: 'known.sync.engine.status' }),
      attention: await chrome.runtime.sendMessage({ kind: 'known.sync.attention.get' }),
    }));
    expect((await readStatus() as { progress: { progress: { firstSync: boolean } } }).progress.progress.firstSync).toBe(false);
    try {
      await expect.poll(async () => ((await stack.observations()).canonicalNodes as CanonicalNode[])
        .filter(node => node.deleted_at === null && node.url?.startsWith('https://example.test/later-selected/')).length,
      { timeout: 60_000 }).toBe(10);
      await expect.poll(async () => {
        const status = await readStatus() as { progress: { progress?: { stage: string } }; engine: { engine?: { errorCode?: string } } };
        return { stage: status.progress.progress?.stage, error: status.engine.engine?.errorCode };
      }, { timeout: 45_000 }).toEqual({ stage: 'done', error: undefined });
      await expect(page.locator('#sync-progress-title')).toHaveText('Sync complete', { timeout: 5_000 });
    } catch (error) {
      console.log(JSON.stringify(await readStatus()));
      throw error;
    }
    const nativeAfter = await page.evaluate(async () => {
      const flatten = (nodes: chrome.bookmarks.BookmarkTreeNode[]): string[] => nodes.flatMap(node =>
        [JSON.stringify([node.id, node.parentId, node.title, node.url]), ...flatten(node.children ?? [])]);
      return flatten(await chrome.bookmarks.getTree());
    });
    expect(nativeAfter).toHaveLength(nativeBefore.length + 11);
    expect(nativeBefore.every(node => nativeAfter.includes(node))).toBe(true);
  } finally { await context?.close(); await stack.close(); await rm(profile, { recursive: true, force: true }); }
});
