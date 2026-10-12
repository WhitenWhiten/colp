import { chromium, expect, test, type BrowserContext } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { startRealStack } from './real-stack.js';
import { openExtensionOptions, showOptionsPane, EXTENSION_FIXTURE_EMAIL, EXTENSION_FIXTURE_PASSWORD } from './extension-auth.js';
import { grantOptionalBookmarks } from './bookmark-permission.js';
import { FIXTURE_COLLECTION_ID } from './fixture-ids.js';

const extension = resolve(import.meta.dirname, '../dist/production');

/* The path a real user takes, with no binding written by the test: local bookmarks, sign in,
   Use this collection, Folders, Start first sync. signInExtension() pre-binds a collection, so
   no other spec clicks this path. */
test('a local user connects a collection from the Sync page and the first sync finishes', async () => {
  test.setTimeout(180_000);
  const stack = await startRealStack(), profile = await mkdtemp(resolve(tmpdir(), 'known-first-sync-ui-'));
  let context: BrowserContext | undefined;
  try {
    context = await chromium.launchPersistentContext(profile, { headless: false, channel: 'chromium', ignoreHTTPSErrors: true,
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`,
        `--host-resolver-rules=${stack.browserHostResolverRules}`, '--no-proxy-server', '--ignore-certificate-errors'] });
    const { page } = await openExtensionOptions(context);
    await showOptionsPane(page, 'bookmarks');
    await grantOptionalBookmarks(page, page.locator('#manager-grant'), 'Know-N first sync from UI');
    await page.evaluate(async () => {
      const bar = (await chrome.bookmarks.getTree())[0]!.children![0]!.id;
      await chrome.bookmarks.create({ parentId: bar, title: 'First sync from UI', url: 'https://example.test/first-sync-ui' });
    });

    await showOptionsPane(page, 'account');
    await page.locator('#login-email').fill(EXTENSION_FIXTURE_EMAIL);
    await page.locator('#login-password').fill(EXTENSION_FIXTURE_PASSWORD);
    await page.locator('#login-submit').click();
    await expect(page.locator('body')).toHaveAttribute('data-state', 'connected', { timeout: 20_000 });
    // Signing in chooses nothing: no binding, no personal sync controls, nothing pushed.
    expect(await page.evaluate(() => chrome.storage.local.get('known.sync.collection.v1'))).toEqual({});

    await showOptionsPane(page, 'collection');
    await expect(page.locator('#personal-sync-controls')).toBeHidden();
    await page.locator(`.collection-choice[data-id="${FIXTURE_COLLECTION_ID}"]`).click();
    const consent = page.getByRole('dialog', { name: 'Connect browser metadata', exact: true });
    await expect(consent).toContainText('Tags, notes and folder descriptions you add in this browser can sync');
    await consent.getByRole('button', { name: 'Keep metadata local', exact: true }).click();
    // Nothing syncs until folders are chosen, so choosing continues there.
    await expect(page.locator('#tab-sync-folders')).toHaveAttribute('aria-selected', 'true', { timeout: 15_000 });

    await showOptionsPane(page, 'collection');
    await expect(page.locator('#personal-sync-status')).toHaveText('Ready to sync. Choose folders to start the first sync.');
    await expect(page.locator(`.collection-row[data-id="${FIXTURE_COLLECTION_ID}"] [data-role="here-label"]`)).toHaveText('Selected');
    expect((await stack.observations() as { pushRequestDigests?: unknown[] }).pushRequestDigests ?? []).toHaveLength(0);

    await expect(page.locator('#personal-sync-toggle')).toHaveText('Pause personal sync');
    await page.locator('#goto-folders').click();
    await expect(page.locator('#tab-sync-folders')).toHaveAttribute('aria-selected', 'true');
    const start = page.locator('#first-run-start');
    await expect(start).toBeVisible({ timeout: 15_000 });
    if (!await start.isEnabled()) await page.locator('.root-row .root-select').first().click();
    await expect(start).toBeEnabled({ timeout: 15_000 });
    await start.click();
    await expect.poll(() => page.evaluate(async () => (await chrome.runtime.sendMessage({ kind: 'known.firstRun.status' }) as { firstRun?: string }).firstRun),
      { timeout: 90_000 }).toBe('completed');
    await expect.poll(async () => ((await stack.observations()) as { canonicalNodes?: { title?: string }[] }).canonicalNodes?.map(node => node.title),
      { timeout: 45_000 }).toContain('First sync from UI');

    await showOptionsPane(page, 'collection');
    await expect(page.locator('#personal-sync-status')).toHaveText('Personal sync is enabled');
    await expect(page.locator(`.collection-row[data-id="${FIXTURE_COLLECTION_ID}"] [data-role="here-label"]`)).toHaveText('Syncing here');
    await showOptionsPane(page, 'sync-center');
    await expect(page.locator('#remote-delete-feedback')).toBeHidden({ timeout: 20_000 });
  } finally { await context?.close(); await stack.close(); await rm(profile, { recursive: true, force: true }); }
});
