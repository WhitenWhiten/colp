import type { BrowserContext, Page } from '@playwright/test';
import { EXTENSION_ID } from './extension-auth.js';
import { grantOptionalBookmarks } from './bookmark-permission.js';

/**
 * A real action popup floats above the browser chrome, so the
 * `chrome.tabs.query({ active: true, currentWindow: true })` it performs on open
 * resolves to the page the user is looking at. These specs drive `popup.html` as
 * an ordinary tab instead, where the popup itself is the active tab and the
 * savability gate (`popup.ts` reflectSavable, E10) therefore closes the save lane.
 *
 * Bring `target` to the front first, then load the popup in the background: the
 * navigation does not activate the tab, so the popup judges the page under it
 * exactly like the real surface does.
 */
export async function openPopupOver(context: BrowserContext, target: Page): Promise<Page> {
  const popup = await context.newPage();
  await target.bringToFront();
  await popup.goto(`chrome-extension://${EXTENSION_ID}/popup.html`, { waitUntil: 'domcontentloaded' });
  return popup;
}

/**
 * The savability gate needs real tab URLs, which `chrome.tabs.query` only returns
 * with the optional `tabs` permission (a real popup gets them through `activeTab`
 * on action invocation, which a `popup.html` tab never receives). Grant it through
 * the product's own control on the tab-preview page, the same way the window-save
 * specs do.
 */
export async function grantTabAccess(context: BrowserContext): Promise<void> {
  const page = await context.newPage();
  try {
    await page.goto(`chrome-extension://${EXTENSION_ID}/capture-tabs.html`, { waitUntil: 'domcontentloaded' });
    if (await page.evaluate(() => chrome.permissions.contains({ permissions: ['tabs'] }))) return;
    await grantOptionalBookmarks(page, 'Allow tab access', 'Known tab access', { permissions: ['tabs'] });
  } finally { await page.close(); }
}
