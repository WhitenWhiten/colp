import { chromium, expect, test } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { EXTENSION_ID } from './extension-auth.js';
import { grantOptionalBookmarks } from './bookmark-permission.js';

test('one-click organization honors independent root and recursive folder selections with existing dialog styles', async ({}, testInfo) => {
  test.setTimeout(90_000);
  const profile = await mkdtemp(resolve(tmpdir(), 'known-organizer-'));
  const extension = resolve(import.meta.dirname, '../dist/development');
  const context = await chromium.launchPersistentContext(profile, { headless: false, channel: 'chromium',
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  try {
    const page = context.pages()[0] ?? await context.newPage();
    await page.setViewportSize({ width: 1200, height: 900 });
    await page.goto(`chrome-extension://${EXTENSION_ID}/options.html#bookmarks`);
    await grantOptionalBookmarks(page, 'Allow bookmark access', 'Know-N organization');
    await page.evaluate(() => chrome.runtime.sendMessage({ kind: 'known.bookmark.preferences.update', userGesture: true, foldersFirst: false }));
    const ids = await page.evaluate(async () => {
      const create = (parentId: string, title: string, url?: string) => chrome.bookmarks.create({ parentId, title, ...(url ? { url } : {}) });
      const r1 = await create('1', 'Root link 1', 'https://example.test/root-1');
      const a = await create('1', '工作与学习');
      const r2 = await create('1', 'Root link 2', 'https://example.test/root-2');
      const b = await create('1', '暂不整理的收藏夹');
      const a1 = await create(a.id, 'A link 1', 'https://example.test/a-1');
      const n1 = await create(a.id, 'Nested folder 1');
      const a2 = await create(a.id, 'A link 2', 'https://example.test/a-2');
      const n2 = await create(a.id, 'Nested folder 2');
      const nlink = await create(n1.id, 'Nested link', 'https://example.test/nested');
      const deep = await create(n1.id, 'Deep folder');
      const dlink = await create(deep.id, 'Deep link', 'https://example.test/deep');
      const leaf = await create(deep.id, 'Deepest folder');
      const blink = await create(b.id, 'B link', 'https://example.test/b');
      const bfolder = await create(b.id, 'B folder');
      const otherLink = await create('2', 'Other root link', 'https://example.test/other');
      const otherFolder = await create('2', 'Other root folder');
      return Object.fromEntries(Object.entries({ r1, a, r2, b, a1, n1, a2, n2, nlink, deep, dlink, leaf, blink, bfolder, otherLink, otherFolder }).map(([key, node]) => [key, node.id]));
    });
    await page.evaluate(() => chrome.storage.local.set({ 'known.ui-language.v1': 'zh-CN' }));
    await page.reload();
    await page.locator('#nav-saving').click();
    await expect(page.locator('#bookmarks-card #manager-organize')).toHaveCount(0);
    expect(await page.locator('#manager-organize').evaluate(button =>
      Boolean(button.closest('.set-row')?.previousElementSibling?.querySelector('#bookmark-folders-first')))).toBe(true);
    const order = (id: string) => page.evaluate(parent => chrome.bookmarks.getChildren(parent).then(nodes => nodes.map(node => node.id)), id);
    const beforeRoot = await order('1');
    const beforeB = await order(ids.b!);
    const beforeOther = await order('2');
    const button = page.locator('#saving-card').getByRole('button', { name: '一键整理', exact: true });
    await expect(button).toBeVisible();
    await button.click();
    const dialog = page.getByRole('dialog', { name: '一键整理书签' });
    await expect(dialog.locator('input[type="checkbox"]')).not.toHaveCount(0);
    expect(await dialog.locator('input[type="checkbox"]').evaluateAll(boxes => boxes.every(box => (box as HTMLInputElement).checked))).toBe(true);
    for (const deepId of [ids.n1, ids.n2, ids.deep, ids.leaf]) {
      await expect(dialog.locator(`input[value="${deepId}"]`)).toHaveCount(0);
    }
    await expect(dialog).toHaveClass('capture-dialog mgr-batch');
    await expect(dialog.getByRole('button', { name: '应用', exact: true })).toHaveClass('btn btn-primary');
    await page.screenshot({ path: testInfo.outputPath('organize-desktop.png') });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: testInfo.outputPath('organize-narrow.png') });
    const bounds = await dialog.boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await dialog.getByRole('button', { name: '取消', exact: true }).click();
    expect(await order('1')).toEqual(beforeRoot);
    expect(await order(ids.a!)).toEqual([ids.a1, ids.n1, ids.a2, ids.n2]);
    await button.click();
    await expect(dialog.locator(`input[value="${ids.a}"]`)).toBeChecked();
    for (const box of await dialog.locator('input[type="checkbox"]').all()) await box.uncheck();
    const apply = dialog.getByRole('button', { name: '应用', exact: true });
    await expect(apply).toBeDisabled();
    await dialog.locator(`input[value="${ids.a}"]`).check();
    await apply.click();
    await expect(dialog).toBeHidden();
    await expect(page.locator('.toast:not(.is-closing)')).toContainText('共移动 4 次');
    expect(await order('1')).toEqual(beforeRoot);
    expect(await order(ids.a!)).toEqual([ids.n1, ids.n2, ids.a1, ids.a2]);
    expect(await order(ids.n1!)).toEqual([ids.deep, ids.nlink]);
    expect(await order(ids.deep!)).toEqual([ids.leaf, ids.dlink]);
    expect(await order(ids.b!)).toEqual(beforeB);
    expect(await order('2')).toEqual(beforeOther);
    // Reapplying the same selection requires zero moves.
    expect(await page.evaluate(nativeId => chrome.runtime.sendMessage({ kind: 'known.bookmarks.organize.apply', userGesture: true, nativeIds: [nativeId] }), ids.a!))
      .toEqual({ ok: true, moved: 0 });
    await button.click();
    await expect(dialog.locator('input[value="1"]')).toBeChecked();
    for (const box of await dialog.locator('input[type="checkbox"]').all()) await box.uncheck();
    await dialog.locator('input[value="1"]').check();
    await apply.click();
    await expect(dialog).toBeHidden();
    await expect(page.locator('.toast:not(.is-closing)')).toContainText('共移动 2 次');
    expect(await order('1')).toEqual([ids.a, ids.b, ids.r1, ids.r2]);
    expect(await order(ids.b!)).toEqual(beforeB);
    expect(await order('2')).toEqual(beforeOther);
    const rejected = await page.evaluate(id => chrome.runtime.sendMessage({ kind: 'known.bookmarks.organize.apply', userGesture: true, nativeIds: [id] }), ids.deep!);
    expect(rejected).toMatchObject({ ok: false, error: 'tree_changed', moved: 0 });
  } finally { await context.close(); await rm(profile, { recursive: true, force: true }); }
});
