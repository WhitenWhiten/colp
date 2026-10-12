import { chromium, expect, test } from '@playwright/test';
import { mkdir, mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { grantOptionalBookmarks } from './bookmark-permission.js';
import { openExtensionOptions } from './extension-auth.js';
test('AC-14 locates a moved bookmark in a 10000-bookmark tree, preserves return context and explains deletion', async () => {
  test.setTimeout(120000);
  const profile = await mkdtemp(resolve(tmpdir(), 'known-capture-locate-')), extension = resolve(import.meta.dirname, '../dist/production');
  const evidence = resolve(import.meta.dirname, '../test-results/automatic-bookmark-capture');
  await mkdir(evidence, { recursive: true });
  const context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: false,
    args: ['--no-sandbox', `--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  try {
    const { page } = await openExtensionOptions(context); await page.locator('#nav-bookmarks').click();
    await grantOptionalBookmarks(page, 'Allow bookmark access', 'Known bookmark manager'); await page.reload();
    await page.locator('#nav-saving').click();
    const fixture = await page.evaluate(async () => {
      const root = (await chrome.bookmarks.getTree())[0]!.children![0]!;
      const a = await chrome.bookmarks.create({ parentId: root.id, title: 'Locate source' }), b = await chrome.bookmarks.create({ parentId: root.id, title: 'Locate destination' });
      let target = '';
      for (let i = 0; i < 10000; i += 100) {
        const batch = await Promise.all(Array.from({ length: 100 }, (_, n) => chrome.bookmarks.create({ parentId: a.id, title: `Large tree bookmark ${i + n}`, url: `https://example.org/large/${i + n}` })));
        target = batch.at(-1)!.id;
      }
      return { target, a: a.id, b: b.id };
    });
    const returnTo = 'saving/history?status=attention&q=kept-filter';
    const hash = `#bookmarks?native=${fixture.target}&return=${encodeURIComponent(returnTo)}`;
    const timings: number[] = [];
    for (let i = 0; i < 5; i++) {
      await page.locator('#nav-saving').click(); const start = performance.now();
      await page.evaluate(hash => { location.hash = hash; }, hash);
      await expect(page.locator(`[data-id="${fixture.target}"][data-capture-located=true]`)).toBeVisible(); timings.push(performance.now() - start);
      expect(await page.locator('#manager-list .mgr-row').count()).toBeLessThanOrEqual(200);
    }
    await page.getByRole('link', { name: 'Return to capture', exact: true }).click(); await expect(page).toHaveURL(/kept-filter/u);
    await page.evaluate(async ids => { await chrome.bookmarks.move(ids.target, { parentId: ids.b }); }, fixture);
    await page.evaluate(hash => { location.hash = hash; }, hash);
    await expect(page.locator('#manager-path')).toContainText('Locate destination');
    await expect(page.locator(`[data-id="${fixture.target}"][data-capture-located=true]`)).toBeVisible();
    await page.getByRole('link', { name: 'Return to capture', exact: true }).click();
    await page.evaluate(async id => { await chrome.bookmarks.remove(id); }, fixture.target);
    await page.evaluate(hash => { location.hash = hash; }, hash);
    await expect(page.locator('#bookmarks-card')).toContainText('unavailable or was deleted');
    const sorted = [...timings].sort((a, b) => a - b);
    await writeFile(resolve(evidence, 'native-tree-performance.json'), JSON.stringify({ fixture: true, bookmarks: 10000, renderedRows: 200,
      browser: await context.browser()?.version(), samplesMs: timings, p50Ms: sorted[2], p95Ms: sorted[4], warm: false, warmAfterFirst: true,
      measurement: 'Playwright navigation to visible highlighted native row, includes getTree and automation overhead',
      bundleSha256: createHash('sha256').update(await readFile(resolve(extension, 'options.js'))).digest('hex') }, null, 2));
  } finally { await context.close(); await rm(profile, { recursive: true, force: true }); }
});
