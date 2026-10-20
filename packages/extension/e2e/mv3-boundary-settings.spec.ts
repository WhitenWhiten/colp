import { expect, test, type BrowserContext } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { KNS08_BINDINGS, grantBookmarks, launchPersistent, login, optionsPage,
  liveCanonical, specialRoots, startRealStack, waitFirstRunProductQuiet } from './kns-08-harness.js';
import { showOptionsPane } from './extension-auth.js';

test.describe.configure({ timeout: 180_000 });

test('direct bookmarks remain selectable when every child folder is excluded', async () => {
  const stack = await startRealStack(); const profile = await mkdtemp(resolve(tmpdir(), 'known-root-only-ui-'));
  let context: BrowserContext | undefined;
  try {
    context = await launchPersistent(profile, stack.browserHostResolverRules);
    const page = await optionsPage(context); await login(page, KNS08_BINDINGS[0]); await grantBookmarks(page);
    const roots = await specialRoots(page);
    await page.evaluate(async parentId => {
      await chrome.bookmarks.create({ parentId, title: 'Direct bookmark to sync', url: 'https://example.test/direct' });
      const child = await chrome.bookmarks.create({ parentId, title: 'Keep this child local' });
      await chrome.bookmarks.create({ parentId: child.id, title: 'Private child bookmark', url: 'https://example.test/private-child' });
    }, roots.barId);
    await page.reload(); await showOptionsPane(page, 'folders');
    await expect(page.locator('#first-run-start')).toBeEnabled({ timeout: 15_000 });
    await page.locator('#tree-clear-selection').click();
    const bar = page.locator('.root-row[data-depth="0"] .root-select input').first();
    await bar.check();
    await page.locator('.root-row').filter({ has: page.getByText('Keep this child local', { exact: true }) })
      .locator('.root-select input').uncheck();
    await expect(page.locator('#first-run-totals')).toContainText('1 bookmark');
    await expect(page.locator('.root-select input:checked')).toHaveCount(0);
    expect(await bar.evaluate(element => (element as HTMLInputElement).indeterminate)).toBe(true);
    await expect(page.locator('#first-run-start')).toBeEnabled();
    await page.locator('#first-run-start').click();
    await waitFirstRunProductQuiet(page, stack, KNS08_BINDINGS[0]);
    const live = await liveCanonical(stack);
    expect(live.filter(node => node.url === 'https://example.test/direct')).toHaveLength(1);
    expect(live.filter(node => node.url === 'https://example.test/private-child')).toHaveLength(0);
  } finally { await context?.close(); await stack.close(); await rm(profile, { recursive: true, force: true }); }
});
