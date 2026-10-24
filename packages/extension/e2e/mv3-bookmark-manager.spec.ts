import { expect, test as base, type BrowserContext, type Page } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { grantOptionalBookmarks } from './bookmark-permission.js';
import { openExtensionOptions } from './extension-auth.js';

const extensionPath = resolve(import.meta.dirname, '../dist/production');

const test = base.extend<{ managerPage: Page }>({
  // Install/onboarding can wait 30s and the native permission driver may retry.
  // Give setup its own budget; manager actions still use the normal test timeout.
  managerPage: [async ({ playwright }, use) => {
    const profile = await mkdtemp(resolve(tmpdir(), 'known-bookmark-manager-'));
    let context: BrowserContext | undefined;
    try {
      context = await playwright.chromium.launchPersistentContext(profile, {
        headless: false, channel: 'chromium', viewport: { width: 1100, height: 760 },
        args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`,
          '--host-resolver-rules=MAP known.example 127.0.0.1,MAP identity.known.example 127.0.0.1', '--no-proxy-server'],
      });
      const { page } = await openExtensionOptions(context);
      await page.locator('#nav-bookmarks').click();
      await expect(page.getByRole('heading', { name: 'Bookmarks', exact: true })).toBeVisible();
      if (!await page.evaluate(() => chrome.permissions.contains({ permissions: ['bookmarks'] }))) {
        await grantOptionalBookmarks(page, 'Allow bookmark access', 'Known bookmark manager');
      }
      // Chromium installs the optional API binding only in the next document.
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.locator('#nav-bookmarks').click();
      await expect(page.locator('#manager-body')).toBeVisible();
      page.setDefaultTimeout(10_000);
      await use(page);
    } finally {
      await context?.close();
      await rm(profile, { recursive: true, force: true });
    }
  }, { timeout: 90_000 }],
});

test('production MV3 bookmark manager performs real create, rename, move and keyboard delete', async ({ managerPage: page }) => {
  const destination = await test.step('Create a folder', async () => {
    await page.getByRole('button', { name: 'New folder' }).click();
    await page.getByLabel('New folder name').fill('Manager destination');
    await page.getByRole('button', { name: 'Create folder' }).click();
    await expect(page.locator('#manager-feedback')).toHaveText('Folder created.');
    return bookmarkByTitle(page, 'Manager destination');
  });

  const source = await test.step('Create a bookmark while native events arrive', async () => {
    // The toolbar and the open composer both say Add bookmark; the toolbar has
    // its own id, and the composer's submit is scoped to the composer row.
    await page.locator('#manager-new-bookmark').click();
    await page.getByLabel('New bookmark name').fill('Manager source');
    await page.getByLabel('New bookmark URL').fill('example.com/manager-source');
    // A native event arriving while the composer is open must not rebuild the
    // row and discard pending user input. The manager debounces these events
    // for 150ms, so cross that boundary before submitting.
    await page.evaluate(async () => {
      const tree = await chrome.bookmarks.getTree();
      await chrome.bookmarks.create({ parentId: tree[0]!.children![0]!.id, title: 'Concurrent manager event' });
    });
    await page.waitForTimeout(250);
    await expect(page.getByLabel('New bookmark name')).toHaveValue('Manager source');
    await expect(page.getByLabel('New bookmark URL')).toHaveValue('example.com/manager-source');
    await page.locator('.mgr-composer').getByRole('button', { name: 'Add bookmark' }).click();
    await expect(page.locator('#manager-feedback')).toHaveText('Bookmark added.');
    const source = await bookmarkByTitle(page, 'Manager source');
    await expect(row(page, source.id).getByRole('link', { name: 'Manager source' }))
      .toHaveAttribute('href', 'https://example.com/manager-source');
    return source;
  });

  await test.step('Rename the bookmark', async () => {
    // Rename is part of the Edit bookmark dialog: a labelled Title field, then Save.
    await row(page, source.id).getByRole('button', { name: 'Edit bookmark Manager source' }).click();
    const editor = page.getByRole('dialog', { name: 'Edit bookmark' });
    await editor.getByLabel('Title', { exact: true }).fill('Manager renamed');
    await editor.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.locator('#manager-feedback')).toHaveText('Bookmark saved.');
    expect((await chromeBookmark(page, source.id)).title).toBe('Manager renamed');
  });

  await test.step('Move the bookmark', async () => {
    await row(page, source.id).getByRole('button', { name: 'More actions Manager renamed' }).click();
    await page.locator('.mgr-menu-item', { hasText: 'Move' }).click();
    await expect(page.getByRole('dialog', { name: 'Move to' })).toBeVisible();
    await page.getByRole('dialog').getByRole('option', { name: 'Manager destination' }).click();
    await expect(page.locator('#manager-feedback')).toHaveText('Moved.');
    expect((await chromeBookmark(page, source.id)).parentId).toBe(destination.id);
  });

  await test.step('Rename and delete using the keyboard', async () => {
    await page.locator('#manager-tree').getByRole('button', { name: 'Manager destination' }).click();
    const moved = row(page, source.id);
    await expect(moved.getByRole('link', { name: 'Manager renamed' })).toBeVisible();
    await moved.focus();
    await moved.press('F2');
    await page.getByRole('dialog', { name: 'Edit bookmark' }).getByLabel('Title', { exact: true }).fill('Keyboard renamed');
    await page.getByRole('dialog', { name: 'Edit bookmark' }).getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.locator('#manager-feedback')).toHaveText('Bookmark saved.');
    await moved.focus();
    await moved.press('Delete');
    await expect(page.getByRole('dialog', { name: 'Delete selected item' })).toBeVisible();
    await page.locator('#manager-batch-confirm').click();
    await expect(moved).toHaveCount(0);
    await expect.poll(async () => page.evaluate(async (id) => {
      try { await chrome.bookmarks.get(id); return 'present'; } catch { return 'deleted'; }
    }, source.id)).toBe('deleted');
  });
});

function row(page: Page, id: string) {
  return page.locator(`.mgr-row[data-id="${id}"]`);
}

async function bookmarkByTitle(page: Page, title: string): Promise<chrome.bookmarks.BookmarkTreeNode> {
  return page.evaluate(async (value) => {
    const matches = await chrome.bookmarks.search({ title: value });
    const exact = matches.find((item) => item.title === value);
    if (!exact) throw new Error(`bookmark fixture missing: ${value}`);
    return exact;
  }, title);
}

async function chromeBookmark(page: Page, id: string): Promise<chrome.bookmarks.BookmarkTreeNode> {
  return page.evaluate(async (value) => (await chrome.bookmarks.get(value))[0]!, id);
}
