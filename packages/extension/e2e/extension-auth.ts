import { expect, type BrowserContext, type Page, type Worker } from '@playwright/test';
import { fixtureCollectionId } from './external-backend.js';

export const EXTENSION_ID = 'pplpnpegpnghcddhmpgkbfkdfadjiaen';

/** Task E3 fixture — same values as real-stack Better Auth registration. */
export const EXTENSION_FIXTURE_EMAIL = 'p3-27-extension@example.test';
export const EXTENSION_FIXTURE_PASSWORD = 'p3-27-extension-password-e3';

const COLLECTION_BINDING = 'known.sync.collection.v1';

export async function openExtensionOptions(
  context: BrowserContext,
  extensionId = EXTENSION_ID,
): Promise<{ worker: Worker; page: Page }> {
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  const target = `chrome-extension://${extensionId}/options.html`;
  const existing = context.pages().find((candidate) => candidate.url().startsWith(target));
  const page = existing ?? await context.newPage();
  page.on('dialog', (dialog) => { void dialog.accept(); });
  if (existing) await page.waitForLoadState('domcontentloaded'); else await gotoOptions(page, '', extensionId);
  await expect(page.locator('#login-form')).toBeAttached();
  /* A fresh install steers a hash-less options page to the Bookmarks welcome after the
     install flag is cleared. One Account click can lose that race. Keep choosing Account
     until that pane stays visible. A hash-less open is what resumes an unfinished first run. */
  await expect.poll(() => page.evaluate(async () => (await chrome.storage.local.get('known.onboarding.installed.v1'))['known.onboarding.installed.v1'] ?? 'gone'))
    .toBe('gone');
  /* The welcome redirect is decided during initialize(), which can finish after the
     flag is already gone. A later load with an explicit #account does not take that path. */
  await gotoOptions(page, '#account', extensionId);
  const accountCard = page.locator('#account-card');
  await expect(accountCard).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.body.dataset.pane ?? '')).toBe('account');
  // A visible options shell can precede cookie restoration after browser restart.
  // Wait for the same auth status request as the UI before reading durable state.
  const initial = await page.evaluate(() => chrome.runtime.sendMessage({ kind: 'known.auth.status' }));
  expect(initial).toMatchObject({ ok: true });
  return { worker, page };
}

/** Opens the options page at `hash` (for example `#saving`). A fresh profile opens options.html itself on install,
 *  so the first navigation can be interrupted by that one; wait for the requested page instead of failing. */
export async function gotoOptions(page: Page, hash = '', extensionId = EXTENSION_ID): Promise<void> {
  const target = `chrome-extension://${extensionId}/options.html${hash}`;
  try {
    await page.goto(target, { waitUntil: 'domcontentloaded' });
  } catch (error) {
    if (!/interrupted by another navigation/u.test(String(error))) throw error;
    await page.waitForLoadState('domcontentloaded');
    if (page.url() !== target) await page.goto(target, { waitUntil: 'domcontentloaded' });
  }
}

export type OptionsPane = 'account' | 'saving' | 'history' | 'ai' | 'general' | 'help' | 'subscriptions' | 'sync' | 'bookmarks' | 'collection' | 'folders' | 'import' | 'credits' | 'sync-center';

/* The retired Sync panes are tab panels inside Sync, so reaching one is a nav click followed by a tab click.
   Credits is a sub-page of Account, reached from its "View activity" link. */
const PANE_TABS: Readonly<Record<string, { readonly nav: string; readonly tab: string; readonly card: string }>> = {
  collection: { nav: 'nav-sync', tab: 'tab-sync-collections', card: 'collection-card' },
  folders: { nav: 'nav-sync', tab: 'tab-sync-folders', card: 'folder-card' },
  import: { nav: 'nav-sync', tab: 'tab-sync-import', card: 'import-card' },
  'sync-center': { nav: 'nav-sync', tab: 'tab-sync-center', card: 'sync-center' },
};

export async function showOptionsPane(page: Page, pane: OptionsPane): Promise<void> {
  if (pane === 'credits') {
    await page.locator('#nav-account').click();
    await page.locator('#account-card a[href="#account/credits"]').click();
    await expect(page.locator('#credits-card')).toBeVisible();
    return;
  }
  const nested = PANE_TABS[pane];
  if (nested) {
    await page.locator(`#${nested.nav}`).click();
    await page.locator(`#${nested.tab}`).click();
    await expect(page.locator(`#${nested.card}`)).toBeVisible();
    return;
  }
  const navId = `nav-${pane}`;
  await page.locator(`#${navId}`).click();
  await expect(page.locator(`#${pane === 'sync' ? 'sync-card' : `${pane}-card`}`)).toBeVisible();
}

/** Selects one of Sync's tab panels by its view name (`#sync/center`). */
export async function showOptionsView(page: Page, pane: 'sync', view: string): Promise<void> {
  await page.locator(`#nav-${pane}`).click();
  await page.locator(`#tab-${pane}-${view}`).click();
  await expect(page.locator(`#${pane}-card [role="tabpanel"][data-view-panel="${view}"]`)).toBeVisible();
}

/** An omitted mode preserves an existing selection; a new selection defaults to local-only metadata. */
export async function selectCollectionFromList(page: Page, collectionId: string,
  metadataMode?: 'local-only' | 'sync'): Promise<void> {
  await showOptionsPane(page, 'collection');
  const byData = page.locator(`.collection-choice[data-id="${collectionId}"]`);
  const current = page.locator(`.collection-row[data-id="${collectionId}"][aria-current="true"]`);
  await expect(byData.first().or(current).first()).toBeVisible({ timeout: 15_000 });
  if (await current.count()) {
    if (metadataMode === undefined) return;
    await current.locator('[data-role="metadata"]').click();
  } else await byData.first().click();
  // Do not fall back to a worker RPC when this UI fails: that bypassed user
  // consent and could turn an unhandled modal into a false-positive browser test.
  const consent = page.getByRole('dialog', { name: 'Connect browser metadata', exact: true });
  await expect(consent).toBeVisible();
  // With no tags, notes or descriptions yet the sync choice reads Sync with collection.
  await consent.getByRole('button', { name: metadataMode === 'sync'
    ? /^(Copy metadata to collection|Sync with collection)$/u : /^Keep metadata local$/u }).click();
  await expect(consent).toHaveCount(0);
  await expect(page.locator('#collection-feedback')).toHaveText('Collection selected.', { timeout: 15_000 });
}

export async function signInExtension(page: Page, collectionId = fixtureCollectionId()): Promise<void> {
  await showOptionsPane(page, 'account');
  await page.evaluate(async ({ collectionKey, collection }) => {
    const current = await chrome.storage.local.get(collectionKey);
    if (typeof current[collectionKey] !== 'string') {
      await chrome.storage.local.set({ [collectionKey]: collection });
    }
  }, { collectionKey: COLLECTION_BINDING, collection: collectionId });
  // A fresh profile's welcome page can hide Account after the binding is stored.
  // The login panel stays in the DOM with its own hidden flag cleared.
  await expect.poll(async () => {
    if (await page.evaluate(() => document.body.dataset.pane) !== 'account') {
      await page.evaluate(() => { location.hash = '#account'; });
    }
    return page.locator('#login-panel').isVisible();
  }, { timeout: 15_000 }).toBe(true);
  await page.locator('#login-email').fill(EXTENSION_FIXTURE_EMAIL);
  await page.locator('#login-password').fill(EXTENSION_FIXTURE_PASSWORD);
  await expect(page.locator('#login-submit')).toBeEnabled();
  await page.locator('#login-submit').click();
  try {
    // First-run onboarding may navigate away from Account after authentication.
    await expect(page.locator('body')).toHaveAttribute('data-state', 'connected', { timeout: 15_000 });
  } catch (error) {
    const toast = page.locator('.toast--error:not(.is-closing) .toast-message');
    const alert = await toast.count() ? (await toast.first().textContent())?.trim() ?? '' : '';
    throw new Error(alert ? `extension_sign_in_failed:${alert}` : 'extension_sign_in_failed', { cause: error });
  }
}
