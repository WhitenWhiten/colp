import { chromium, expect, test, type BrowserContext, type Page } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { EXTENSION_ID } from './extension-auth.js';
import { grantOptionalBookmarks } from './bookmark-permission.js';
import { grantTabAccess, openPopupOver } from './popup-page.js';
import { capturePopupTarget } from './capture-popup-cdp.js';
import { writeFile } from 'node:fs/promises';

const titles = (page: Page, parentId: string) => page.evaluate(id => chrome.bookmarks.getChildren(id).then(nodes => nodes.map(node => node.title)), parentId);
const preferences = (page: Page, bookmarkInsertPosition: 'top' | 'bottom') => page.evaluate(value =>
  chrome.runtime.sendMessage({ kind: 'known.bookmark.preferences.update', userGesture: true, bookmarkInsertPosition: value, foldersFirst: true }), bookmarkInsertPosition);

async function launch(): Promise<{ context: BrowserContext; profile: string; page: Page }> {
  const profile = await mkdtemp(resolve(tmpdir(), 'known-pins-'));
  const extension = resolve(import.meta.dirname, '../dist/development');
  const context = await chromium.launchPersistentContext(profile, { headless: false, channel: 'chromium',
    args: ['--remote-debugging-port=0', `--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  const page = context.pages()[0] ?? await context.newPage();
  await page.setViewportSize({ width: 1200, height: 900 });
  // Install opens the options page itself; let that navigation land before the permission bubble.
  await page.goto(`chrome-extension://${EXTENSION_ID}/options.html#bookmarks`);
  await page.waitForTimeout(2_000);
  await page.goto(`chrome-extension://${EXTENSION_ID}/options.html#bookmarks`);
  await grantOptionalBookmarks(page, 'Allow bookmark access', 'Know-N pins');
  return { context, profile, page };
}

test('pins in the bookmarks manager: native order, drag groups and the conditions dialog', async ({}, testInfo) => {
  test.setTimeout(90_000);
  const { context, profile, page } = await launch();
  try {
    await preferences(page, 'top');
    const folder = await page.evaluate(async () => {
      const parent = await chrome.bookmarks.create({ parentId: '1', title: 'Pins' });
      await chrome.bookmarks.create({ parentId: parent.id, title: 'Sub' });
      for (const title of ['A', 'B', 'C', 'D', 'E']) await chrome.bookmarks.create({ parentId: parent.id, title, url: `https://${title.toLowerCase()}.example.test/` });
      return parent.id;
    });
    await page.reload();
    await page.locator('#manager-list .mgr-row').filter({ hasText: 'Pins' }).locator('.mgr-name').click();
    const row = (title: string) => page.locator('#manager-list .mgr-row').filter({ has: page.locator('.mgr-name', { hasText: new RegExp(`^${title}$`) }) });
    const listed = () => page.locator('#manager-list .mgr-row .mgr-name').allTextContents();
    await expect.poll(listed).toEqual(['Sub', 'A', 'B', 'C', 'D', 'E']);

    // A new pin joins the end of the pinned section, right below the folders.
    for (const title of ['C', 'E']) {
      await row(title).hover();
      await row(title).getByRole('button', { name: `Pin ${title}`, exact: true }).click();
      await expect(row(title).locator('.mgr-actions > .mgr-pin[aria-pressed="true"]')).toBeVisible();
    }
    await expect.poll(() => titles(page, folder)).toEqual(['Sub', 'C', 'E', 'A', 'B', 'D']);
    await expect.poll(listed).toEqual(['Sub', 'C', 'E', 'A', 'B', 'D']);
    await page.mouse.move(0, 0);
    await page.locator('#manager-card').screenshot({ path: testInfo.outputPath('pins-manager.png') });

    // Each group reorders inside itself; an unpinned bookmark cannot land among the pins.
    await row('E').dragTo(row('C'));
    await expect.poll(() => titles(page, folder)).toEqual(['Sub', 'E', 'C', 'A', 'B', 'D']);
    await row('A').dragTo(row('D'));
    await expect.poll(() => titles(page, folder)).toEqual(['Sub', 'E', 'C', 'B', 'A', 'D']);
    await row('D').dragTo(row('C'));
    await page.waitForTimeout(300);
    expect(await titles(page, folder)).toEqual(['Sub', 'E', 'C', 'B', 'A', 'D']);
    // Dropping a pin on the first other bookmark puts it at the end of the pinned section.
    await row('E').dragTo(row('B'));
    await expect.poll(() => titles(page, folder)).toEqual(['Sub', 'C', 'E', 'B', 'A', 'D']);

    // With new bookmarks going to the bottom, pins pause: kept, shown muted, and unpinning still works.
    await preferences(page, 'bottom');
    await expect(row('C').locator('.mgr-pin[data-paused]')).toBeVisible();
    await row('B').hover();
    const offer = row('B').getByRole('button', { name: 'Pin B', exact: true });
    await expect(offer).toHaveAttribute('aria-disabled', 'true');
    // aria-disabled keeps the button focusable and clickable: it explains instead of acting.
    await offer.click({ force: true });
    const dialog = page.getByRole('dialog', { name: 'Pinning is off in this folder' });
    await expect(dialog).toHaveClass('capture-dialog mgr-pin-conditions');
    expect(await dialog.locator('.mgr-pin-condition-list > li').evaluateAll(items => items.map(item => (item as HTMLElement).dataset.met))).toEqual(['false', 'true', 'true']);
    await dialog.screenshot({ path: testInfo.outputPath('pins-conditions.png') });
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(dialog).toBeHidden();
    expect(await titles(page, folder)).toEqual(['Sub', 'C', 'E', 'B', 'A', 'D']);
    await row('C').getByRole('button', { name: 'Unpin C', exact: true }).click();
    // Unpin follows "New bookmarks go": the bottom of the folder.
    await expect.poll(() => titles(page, folder)).toEqual(['Sub', 'E', 'B', 'A', 'D', 'C']);

    // Back to the top: the remaining pin is enforced again, and an unpin goes to the top of the others.
    await preferences(page, 'top');
    await expect(row('E').locator('.mgr-pin:not([data-paused])')).toBeVisible();
    await row('E').getByRole('button', { name: 'Unpin E', exact: true }).click();
    await expect.poll(() => titles(page, folder)).toEqual(['Sub', 'E', 'B', 'A', 'D', 'C']);
    await expect(row('E').locator('.mgr-actions > .mgr-pin')).toHaveCount(0);
  } finally {
    await context.close();
    await rm(profile, { recursive: true, force: true });
  }
});

test('the popup saves a pinned bookmark at the end of the pinned section', async ({}, testInfo) => {
  test.setTimeout(90_000);
  const { context, profile, page } = await launch();
  try {
    await preferences(page, 'top');
    const folder = await page.evaluate(async () => {
      const parent = await chrome.bookmarks.create({ parentId: '1', title: 'Pins' });
      await chrome.bookmarks.create({ parentId: parent.id, title: 'Sub' });
      for (const title of ['Kept', 'Other']) await chrome.bookmarks.create({ parentId: parent.id, title, url: `https://${title.toLowerCase()}.example.test/` });
      return parent.id;
    });
    await page.evaluate(id => chrome.runtime.sendMessage({ kind: 'known.bookmarks.pin.set', userGesture: true, nativeId: id, pinned: true }),
      (await page.evaluate(parent => chrome.bookmarks.getChildren(parent), folder)).find(node => node.title === 'Kept')!.id);
    await grantTabAccess(context);
    const tab = await context.newPage();
    await tab.route('**/*', route => route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>Pinned page</title>' }));
    await tab.goto('https://pinned.example.test/', { waitUntil: 'domcontentloaded' });
    const popup = await openPopupOver(context, tab);
    await popup.setViewportSize({ width: 380, height: 600 });
    await popup.locator('#dest-toggle').click();
    await popup.locator('#folder-tree').getByRole('option', { name: /^Pins/ }).click();
    const toggle = popup.locator('#folder-pin');
    await expect(toggle).toBeVisible();
    await expect(toggle).not.toHaveAttribute('aria-disabled', 'true');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await popup.screenshot({ path: testInfo.outputPath('popup-pin.png') });
    await popup.getByRole('button', { name: 'Save', exact: true }).click();
    await expect.poll(() => titles(page, folder)).toEqual(['Sub', 'Kept', 'Pinned page', 'Other']);

    // Where pins are off, the saved page shows its pin paused, and a new page's toggle explains what is missing.
    await preferences(page, 'bottom');
    const edit = await openPopupOver(context, tab);
    await expect(edit.locator('#folder-pin')).toHaveAttribute('aria-pressed', 'true');
    await expect(edit.locator('#folder-pin')).toHaveAttribute('data-paused', '');
    await edit.close();
    await tab.goto('https://another.example.test/', { waitUntil: 'domcontentloaded' });
    const second = await openPopupOver(context, tab);
    await second.setViewportSize({ width: 380, height: 600 });
    await second.locator('#dest-toggle').click();
    await second.locator('#folder-tree').getByRole('option', { name: /^Pins/ }).first().click();
    await expect(second.locator('#folder-pin')).toHaveAttribute('aria-disabled', 'true');
    await second.locator('#folder-pin').click({ force: true });
    await expect(second.locator('#folder-pin-hint')).toContainText('New bookmarks go to the top of the folder');
    await second.mouse.move(0, 0);
    await second.screenshot({ path: testInfo.outputPath('popup-pin-hint.png') });
  } finally {
    await context.close();
    await rm(profile, { recursive: true, force: true });
  }
});

test('the automatic result panel pins the bookmark it just saved on Done', async ({}, testInfo) => {
  test.setTimeout(90_000);
  const { context, profile, page } = await launch();
  try {
    await grantTabAccess(context);
    await page.bringToFront();
    await page.locator('#nav-saving').click();
    await page.getByRole('radio', { name: /^Automatic/ }).check();
    await page.getByRole('button', { name: 'Save automatic mode', exact: true }).click();
    await preferences(page, 'top');
    await context.route('https://example.org/pin-auto', route => route.fulfill({ contentType: 'text/html', body: '<title>Auto pinned</title>' }));
    const active = await context.newPage(); await active.goto('https://example.org/pin-auto');
    const popup = await capturePopupTarget(context, profile, active);
    await expect.poll(() => popup.evaluate<boolean>("!document.getElementById('folder-pin').hidden"), { timeout: 15_000 }).toBe(true);
    expect(await popup.evaluate<string>("document.getElementById('folder-pin').getAttribute('aria-pressed')")).toBe('false');
    await popup.evaluate("document.getElementById('folder-pin').click()");
    expect(await popup.evaluate<string>("document.getElementById('folder-pin').getAttribute('aria-pressed')")).toBe('true');
    const shot = await popup.send('Page.captureScreenshot', { format: 'png' }) as { data: string };
    await writeFile(testInfo.outputPath('automatic-pin.png'), Buffer.from(shot.data, 'base64'));
    await popup.evaluate("document.getElementById('capture-done').click()");
    // The manager shows the saved bookmark pinned in its folder.
    await expect.poll(() => page.evaluate(() => chrome.bookmarks.search({ url: 'https://example.org/pin-auto' }).then(nodes => nodes[0]?.parentId ?? ''))).not.toBe('');
    const parentId = await page.evaluate(() => chrome.bookmarks.search({ url: 'https://example.org/pin-auto' }).then(nodes => nodes[0]!.parentId!));
    await page.goto(`chrome-extension://${EXTENSION_ID}/options.html#bookmarks`);
    const parentTitle = await page.evaluate(id => chrome.bookmarks.get(id).then(nodes => nodes[0]!.title), parentId);
    await page.locator('#manager-tree').getByText(parentTitle, { exact: true }).first().click();
    const row = page.locator('#manager-list .mgr-row').filter({ has: page.locator('.mgr-name', { hasText: /^Auto pinned$/ }) });
    await expect(row.locator('.mgr-actions > .mgr-pin[aria-pressed="true"]')).toBeVisible({ timeout: 15_000 });
  } finally {
    await context.close();
    await rm(profile, { recursive: true, force: true });
  }
});
