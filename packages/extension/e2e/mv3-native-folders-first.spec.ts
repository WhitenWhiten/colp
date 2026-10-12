import { test, expect, chromium, type Page } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { EXTENSION_ID } from './extension-auth.js';
import { grantOptionalBookmarks } from './bookmark-permission.js';

test('folders-first is opt-in, updates native browser order and persists across profile restart', async () => {
  test.setTimeout(90_000);
  const profile = await mkdtemp(resolve(tmpdir(), 'known-native-folders-first-'));
  const extension = resolve(import.meta.dirname, '../dist/development');
  const launch = () => chromium.launchPersistentContext(profile, { headless: false, channel: 'chromium',
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  let context = await launch();
  try {
    let page = context.pages()[0] ?? await context.newPage();
    await page.goto(`chrome-extension://${EXTENSION_ID}/options.html#bookmarks`);
    await grantOptionalBookmarks(page, 'Allow bookmark access', 'Know-N native grouping');
    await page.goto(`chrome-extension://${EXTENSION_ID}/options.html#saving`);
    await expect(page.locator('#bookmark-folders-first')).toBeEnabled();
    await expect(page.locator('#bookmark-folders-first')).not.toBeChecked();
    const ids = await page.evaluate(async () => {
      const parent = await chrome.bookmarks.create({ parentId: '1', title: 'Grouping test' });
      const x = await chrome.bookmarks.create({ parentId: parent.id, title: 'X', url: 'https://example.test/x' });
      const a = await chrome.bookmarks.create({ parentId: parent.id, title: 'A' });
      const y = await chrome.bookmarks.create({ parentId: parent.id, title: 'Y', url: 'https://example.test/y' });
      const b = await chrome.bookmarks.create({ parentId: parent.id, title: 'B' });
      await chrome.bookmarks.create({ parentId: a.id, title: 'Nested link', url: 'https://example.test/nested' });
      await chrome.bookmarks.create({ parentId: a.id, title: 'Nested folder' });
      return { parent: parent.id, x: x.id, a: a.id, y: y.id, b: b.id };
    });
    const order = () => page.evaluate(id => chrome.bookmarks.getChildren(id).then(nodes => nodes.map(node => node.id)), ids.parent);
    // Off by default: granting access and adding items never reorders the user's bookmarks.
    await page.waitForTimeout(1_500);
    expect(await order()).toEqual([ids.x, ids.a, ids.y, ids.b]);
    await setFoldersFirst(page, true);
    await expect.poll(order).toEqual([ids.a, ids.b, ids.x, ids.y]);
    await expect.poll(() => page.evaluate(id => chrome.bookmarks.getChildren(id).then(nodes => nodes.map(node => node.title)), ids.a))
      .toEqual(['Nested folder', 'Nested link']);
    const added = await page.evaluate(async id => {
      const link = await chrome.bookmarks.create({ parentId: id, index: 0, title: 'Top link', url: 'https://example.test/top' });
      const folder = await chrome.bookmarks.create({ parentId: id, title: 'New folder' });
      return { link: link.id, folder: folder.id };
    }, ids.parent);
    await expect.poll(order).toEqual([ids.a, ids.b, added.folder, added.link, ids.x, ids.y]);
    await page.evaluate(({ x, parent }) => chrome.bookmarks.move(x, { parentId: parent, index: 0 }), ids);
    await expect.poll(order).toEqual([ids.a, ids.b, added.folder, ids.x, added.link, ids.y]);
    await setFoldersFirst(page, false);
    await page.evaluate(({ y, parent }) => chrome.bookmarks.move(y, { parentId: parent, index: 0 }), ids);
    const manual = [ids.y, ids.a, ids.b, added.folder, ids.x, added.link];
    await expect.poll(order).toEqual(manual);
    await context.close();
    context = await launch();
    page = context.pages()[0] ?? await context.newPage();
    await page.goto(`chrome-extension://${EXTENSION_ID}/options.html#saving`);
    await expect(page.locator('#bookmark-folders-first')).not.toBeChecked();
    expect(await order()).toEqual(manual);
    await setFoldersFirst(page, true);
    await expect.poll(order).toEqual([ids.a, ids.b, added.folder, ids.y, ids.x, added.link]);
    await context.close();
    context = await launch();
    page = context.pages()[0] ?? await context.newPage();
    await page.goto(`chrome-extension://${EXTENSION_ID}/options.html#saving`);
    await expect(page.locator('#bookmark-folders-first')).toBeChecked();
    await expect.poll(order).toEqual([ids.a, ids.b, added.folder, ids.y, ids.x, added.link]);
  } finally { await context.close(); await rm(profile, { recursive: true, force: true }); }
});

async function setFoldersFirst(page: Page, foldersFirst: boolean): Promise<void> {
  await page.goto(`chrome-extension://${EXTENSION_ID}/options.html#saving`);
  const control = page.locator('#bookmark-folders-first');
  await expect(control).toBeEnabled();
  if (await control.isChecked() !== foldersFirst) await control.click();
  await expect.poll(() => page.evaluate(() => chrome.runtime.sendMessage({ kind: 'known.bookmark.preferences.local' })))
    .toMatchObject({ ok: true, preferences: { foldersFirst } });
}
