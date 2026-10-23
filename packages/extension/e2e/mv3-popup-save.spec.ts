import { test, expect, chromium, type BrowserContext, type Page } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { startRealStack, type RealStack } from './real-stack.js';
import { openExtensionOptions, signInExtension } from './extension-auth.js';
import { FIXTURE_COLLECTION_ID } from './fixture-ids.js';
import { grantOptionalBookmarks } from './bookmark-permission.js';
import { confirmFirstRun, evidence, grantBookmarks, waitFirstRunProductQuiet } from './kns-08-harness.js';
import { grantTabAccess, openPopupOver } from './popup-page.js';

const extensionPath = resolve(import.meta.dirname, '../dist/production');
const SAVED_URL = 'https://example.com/popup-save';
const SAVED_TITLE = 'Popup Save Title';
let stack: RealStack | undefined;

test.beforeEach(async () => { stack = await startRealStack(); });
test.afterEach(async () => { await stack?.close(); stack = undefined; });

/** A fresh save stays local until the user confirms its sync range. */
test('popup saves locally before first-run confirmation then syncs the same bookmark', async ({}, testInfo) => {
  test.setTimeout(120_000);
  const context = await launch();
  try {
    // No pre-installed replica binding: the extension mints a fresh replica and
    // completes its own first-run bootstrap, exactly like a real install.
    const { page } = await openExtensionOptions(context);
    await signInExtension(page, FIXTURE_COLLECTION_ID);

    // The popup gates its save lane on the active tab (E10), so it must be opened
    // over the page it will save.
    await grantTabAccess(context);
    const popupTarget = await openHttpTab(context, SAVED_URL);
    const popup = await openPopupOver(context, popupTarget);
    await popup.waitForFunction(() => document.body.dataset.state === 'connected', undefined, { timeout: 15_000 });
    // The popup names a folder, never a collection: the bound library is derived.
    await expect(popup.locator('#dest-toggle')).toBeVisible({ timeout: 15_000 });
    await expect(popup.locator('#collection-select')).toHaveCount(0);
    await expect(popup.locator('#pp-fields')).not.toContainText(/collection|P3-27/iu);
    // R13 E-04: Save stays demoted (aria-disabled) until bookmark access is granted below.
    await expect(popup.locator('#save')).toHaveAttribute('aria-disabled', 'true');
    await expect(popup.locator('#permission-grant')).toBeVisible();
    await popup.screenshot({ path: testInfo.outputPath('popup-connected.png') });

    await popup.fill('#tab-title', SAVED_TITLE);
    await popup.locator('#tab-url-display').click();
    await popup.fill('#tab-url', SAVED_URL);
    await grantOptionalBookmarks(popup, 'Allow bookmark access', 'popup save activation');
    if (await popup.locator('#dest-panel').isVisible()) await popup.locator('[data-folder-id]').first().click();
    await popup.getByRole('button', { name: 'Save', exact: true }).click();

    // The initial save feedback describes the local commit, before sync consent.
    for (let attempt = 0; attempt < 80 && !popup.isClosed(); attempt += 1) {
      const outcome = await popup.evaluate(() => ({
        state: document.body.dataset.state,
        feedback: document.getElementById('pp-note')?.textContent ?? '',
        status: document.getElementById('capture-status-text')?.textContent ?? '',
        tone: (document.getElementById('pp-note') as HTMLElement | null)?.dataset.tone ?? '',
      })).catch(() => null);
      if (!outcome) break;
      expect(outcome.tone, outcome.feedback).not.toBe('error');
      if (outcome.state === 'saved') {
        // The status line carries "Saved to <folder>"; the note is empty or one calm line.
        expect(outcome.status).toMatch(/^Saved/u);
        expect(outcome.feedback).toMatch(/^(?:|Saved to this browser|The icon will be added when you are back online\.|This device only|Sync is off)$/u);
        break;
      }
      await page.waitForTimeout(500);
    }

    await expect.poll(async () => page.evaluate(async (url) => {
      const matches = await chrome.bookmarks.search({ url });
      return matches.length;
    }, SAVED_URL), { timeout: 45_000 }).toBe(1);
    const placement = await page.evaluate(async (url) => {
      const match = (await chrome.bookmarks.search({ url }))[0]!;
      const parent = (await chrome.bookmarks.get(match.parentId!))[0]!;
      return { nativeId: match.id, title: match.title, parentTitle: parent.title, parentId: parent.id };
    }, SAVED_URL);
    expect(placement.title).toBe(SAVED_TITLE);
    const beforeConfirmation = await requireStack().observations();
    expect((beforeConfirmation.canonicalNodes as Array<{ url?: string }>)
      .filter((node) => node.url === SAVED_URL)).toHaveLength(0);
    if (!popup.isClosed()) await popup.close();

    const binding = await page.evaluate(async () => (await chrome.storage.local.get('known.auth.binding.v1'))
      ['known.auth.binding.v1']) as RealStack['extensionBinding'];
    await confirmFirstRun(page, [placement.parentTitle]);
    await waitFirstRunProductQuiet(page, requireStack(), binding);
    const local = await evidence<{ mappings: Array<{ nativeId: string; colpId: string }> }>(page, 'exportOutboundPushEvidence');
    const parent = local.mappings.find((mapping) => mapping.nativeId === placement.parentId);
    expect(parent).toBeDefined();
    const observations = await requireStack().observations();
    const saved = (observations.canonicalNodes as Array<Record<string, unknown>>).filter((node) => node.url === SAVED_URL);
    expect(saved).toEqual([expect.objectContaining({
      title: SAVED_TITLE, parent_id: parent!.colpId, deleted_at: null,
    })]);
    expect(await page.evaluate(async (url) => (await chrome.bookmarks.search({ url })).map((node) => node.id), SAVED_URL))
      .toEqual([placement.nativeId]);
  } finally { await context.close(); }
});

test('popup and native entries surface permission denial without creating bookmarks', async () => {
  test.setTimeout(90_000);
  const context = await launch();
  try {
    const { page } = await openExtensionOptions(context);
    await signInExtension(page, FIXTURE_COLLECTION_ID);
    await grantTabAccess(context);
    const popup = await openPopupOver(context, await openHttpTab(context, 'https://example.com/permission-note'));
    await popup.waitForFunction(() => document.body.dataset.state === 'connected', undefined, { timeout: 15_000 });
    await expect(popup.locator('#permission-note')).toBeVisible();
    const native = await page.evaluate(async () => chrome.runtime.sendMessage({
      kind: 'known.save.native', entry: 'page', userGesture: true,
    })) as { ok?: boolean; error?: string };
    expect(native).toEqual({ ok: false, error: 'permission_required' });
    const feedback = await page.evaluate(async () => (await chrome.storage.local.get('known.save.feedback.v1'))
      ['known.save.feedback.v1']) as { code?: string; message?: string };
    expect(feedback.code).toBe('permission_required');
    expect(feedback.message).toContain('Allow bookmark access');
    expect(await page.evaluate(() => chrome.action.getBadgeText({}))).toBe('!');
  } finally { await context.close(); }
});

test('native page and window saves share Chrome create, remember the in-range folder, and survive restart', async () => {
  test.setTimeout(180_000);
  const profile = await mkdtemp(resolve(tmpdir(), 'known-p2-01-native-'));
  let context = await launch(profile);
  try {
    let { page } = await openExtensionOptions(context);
    await signInExtension(page, FIXTURE_COLLECTION_ID);
    await grantBookmarks(page);
    const bar = await barFolder(page);
    const research = await page.evaluate(async (parentId) => chrome.bookmarks.create({
      parentId, title: 'P2-01 Research',
    }), bar.id);
    await page.evaluate(async ({ collectionId, folderNativeId }) => chrome.storage.local.set({
      'known.sync.folder.v1': { collectionId, folderNativeId },
    }), { collectionId: FIXTURE_COLLECTION_ID, folderNativeId: research.id });
    const binding = await page.evaluate(async () => (await chrome.storage.local.get('known.auth.binding.v1'))
      ['known.auth.binding.v1']) as RealStack['extensionBinding'];
    await confirmFirstRun(page, [bar.title]);
    await waitFirstRunProductQuiet(page, requireStack(), binding);

    const pageUrl = 'https://known.example/__test/health?p2=page';
    await openHttpTab(context, pageUrl);
    const first = await nativeSave(page, 'page');
    expect(first, JSON.stringify(first)).toMatchObject({ ok: true });
    if (!first.ok) return;
    expect(first.reused).toBe(false);
    expect(first.parentNativeId).toBe(research.id);
    expect(await countUrl(page, pageUrl)).toBe(1);
    const duplicate = await nativeSave(page, 'page');
    expect(duplicate.ok).toBe(true);
    if (!duplicate.ok) return;
    expect(duplicate.reused).toBe(true);
    expect(duplicate.nativeIds).toEqual(first.nativeIds);
    expect(await countUrl(page, pageUrl)).toBe(1);

    const windowUrl = 'https://known.example/__test/health?p2=window';
    await openHttpTab(context, windowUrl);
    // AC-04 turned the window entry into a recoverable preview: it opens the tab
    // picker and writes nothing until the user confirms there. This spec pins the
    // hand-off; the confirm-and-save flow belongs to
    // mv3-bookmark-save-placement-real.spec.ts.
    const previewOpened = context.waitForEvent('page', candidate => candidate.url().includes('capture-tabs.html'));
    const windowSave = await nativeSave(page, 'window');
    expect(windowSave).toMatchObject({ ok: true, previewOpened: true });
    const preview = await previewOpened;
    await preview.waitForLoadState('domcontentloaded');
    await expect(preview.locator('#tabs-confirm')).toBeVisible();
    expect(await countUrl(page, windowUrl)).toBe(0);
    await preview.close();
    const offlineUrl = 'https://known.example/__test/health?p2=offline';
    await openHttpTab(context, offlineUrl);
    await context.setOffline(true);
    const offline = await nativeSave(page, 'page');
    expect(offline.ok).toBe(true);
    expect(await countUrl(page, offlineUrl)).toBe(1);
    await context.setOffline(false);

    const exported = await evidence<{
      bookmarkEvents: Array<{ nativeId: string; kind: string }>;
      queue: Array<{ payload?: { type?: string } }>;
      mappings: Array<{ nativeId: string }>;
    }>(page, 'exportOutboundPushEvidence');
    expect(exported.bookmarkEvents.some((event) => first.nativeIds.includes(event.nativeId))).toBe(true);
    expect(exported.queue.some((row) => row.payload?.type === 'create_node')).toBe(true);

    await context.close();
    context = await launch(profile);
    page = (await openExtensionOptions(context)).page;
    const restartUrl = 'https://known.example/__test/health?p2=restart';
    await openHttpTab(context, restartUrl);
    const restarted = await nativeSave(page, 'page');
    expect(restarted.ok).toBe(true);
    if (!restarted.ok) return;
    expect(restarted.reused).toBe(false);
    expect(restarted.parentNativeId).toBe(research.id);
    expect(await countUrl(page, restartUrl)).toBe(1);
    expect(await countUrl(page, pageUrl)).toBeGreaterThanOrEqual(1);
  } finally {
    await context.close();
    await rm(profile, { recursive: true, force: true });
  }
});

test('an out-of-range popup folder saves without a prompt and stays local-only', async ({}, testInfo) => {
  test.setTimeout(180_000);
  const context = await launch();
  try {
    const { page } = await openExtensionOptions(context);
    await signInExtension(page, FIXTURE_COLLECTION_ID);
    await grantBookmarks(page);
    const bar = await barFolder(page);
    const other = await page.evaluate(async () => {
      const tree = await chrome.bookmarks.getTree();
      return tree[0]!.children![1]!;
    });
    const binding = await page.evaluate(async () => (await chrome.storage.local.get('known.auth.binding.v1'))
      ['known.auth.binding.v1']) as RealStack['extensionBinding'];
    await confirmFirstRun(page, [bar.title]);
    await waitFirstRunProductQuiet(page, requireStack(), binding);
    await page.evaluate(async ({ collectionId, folderNativeId }) => chrome.storage.local.set({
      'known.sync.folder.v1': { collectionId, folderNativeId },
    }), { collectionId: FIXTURE_COLLECTION_ID, folderNativeId: bar.id });
    await page.evaluate(() => chrome.runtime.sendMessage({ kind: 'known.favicon.save-context' })).catch(() => undefined);

    await grantTabAccess(context);
    const popup = await openPopupOver(context, await openHttpTab(context, 'https://example.com/out-of-range'));

    await popup.waitForFunction(() => document.body.dataset.state === 'connected', undefined, { timeout: 15_000 });
    await expect.poll(async () => popup.locator('#pp-fields').isVisible(), { timeout: 20_000 }).toBe(true);
    // A folder that syncs needs no sentence: the pill names it and the note stays empty.
    await expect(popup.locator('#dest-folder')).toHaveText(bar.title, { timeout: 20_000 });
    await expect(popup.locator('#pp-note')).toBeHidden();
    await popup.screenshot({ path: testInfo.outputPath('popup-dest-synced.png') });
    await popup.locator('#dest-toggle').click();
    await popup.screenshot({ path: testInfo.outputPath('popup-dest-picker.png') });
    await popup.locator(`[data-folder-id="${other.id}"]`).first().click();
    // The pick applies at once; whether it syncs is passive status, never a question.
    await expect(popup.locator('#dest-panel')).toBeHidden();
    await expect(popup.locator('#dest-folder')).toHaveText(other.title);
    await expect(popup.locator('#pp-note')).toHaveText("This folder stays on this browser · Sync it…");
    await expect(popup.locator('#local-only-prompt')).toHaveCount(0);
    await popup.screenshot({ path: testInfo.outputPath('popup-dest-local.png') });
    const localUrl = 'https://example.com/known-p2-01-local-only';
    await popup.fill('#tab-title', 'Local only');
    await popup.locator('#tab-url-display').click();
    await popup.fill('#tab-url', localUrl);
    await popup.locator('#save').click();
    await expect.poll(async () => countUrl(page, localUrl), { timeout: 30_000 }).toBe(1);
    const parentId = await page.evaluate(async (url) => (await chrome.bookmarks.search({ url }))[0]!.parentId, localUrl);
    expect(parentId).toBe(other.id);
    await page.waitForTimeout(4_000);
    const remote = ((await requireStack().observations()).canonicalNodes as Array<{ url?: string }>)
      .filter((node) => node.url === localUrl);
    expect(remote).toHaveLength(0);
    const exported = await evidence<{ bookmarkEvents: Array<{ nativeId: string }>; queue: Array<{ payload?: { url?: string } }> }>(
      page, 'exportOutboundPushEvidence',
    );
    const localNative = await page.evaluate(async (url) => (await chrome.bookmarks.search({ url }))[0]!.id, localUrl);
    expect(exported.queue.some((row) => JSON.stringify(row).includes(localUrl))).toBe(false);
    expect(exported.bookmarkEvents.some((event) => event.nativeId === localNative)).toBe(false);

    // Reopened over the same page, the popup edits that bookmark in place, like the native star.
    const again = await openPopupOver(context, await openHttpTab(context, localUrl));
    await expect(again.locator('#save')).toHaveText('Done', { timeout: 20_000 });
    await expect(again.locator('#tab-title')).toHaveValue('Local only');
    await expect(again.locator('#dest-folder')).toHaveText(other.title);
    await again.screenshot({ path: testInfo.outputPath('popup-edit-existing.png') });
    await again.locator('#remove-bookmark').click();
    await expect.poll(async () => countUrl(page, localUrl), { timeout: 15_000 }).toBe(0);
  } finally { await context.close(); }
});

// The popup no longer offers a per-save "Only in this browser" opt-out: the
// privacy boundary is the options page's "Stay local" folders, which the
// bookmark-roots journey covers. Every popup save targets the library.

async function launch(profile = ''): Promise<BrowserContext> {
  return chromium.launchPersistentContext(profile, {
    headless: false,
    channel: 'chromium',
    viewport: { width: 900, height: 720 },
    ignoreHTTPSErrors: true,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      `--host-resolver-rules=${requireStack().browserHostResolverRules}`,
      '--no-proxy-server',
      '--ignore-certificate-errors',
    ],
  });
}

function requireStack(): RealStack {
  if (!stack) throw new Error('popup save real stack is unavailable');
  return stack;
}

async function barFolder(page: Page): Promise<{ id: string; title: string }> {
  return page.evaluate(async () => {
    const tree = await chrome.bookmarks.getTree();
    const bar = tree[0]!.children![0]!;
    return { id: bar.id, title: bar.title };
  });
}

async function openHttpTab(context: BrowserContext, url: string): Promise<Page> {
  const tab = await context.newPage();
  await tab.route('**/*', async (route) => {
    await route.fulfill({
      status: 200, contentType: 'text/html',
      body: `<!doctype html><title>P2-01</title><p>${url}</p>`,
    });
  });
  await tab.goto(url, { waitUntil: 'domcontentloaded' });
  await tab.bringToFront();
  return tab;
}

async function nativeSave(page: Page, entry: 'page' | 'window'): Promise<{
  ok: boolean; nativeIds: string[]; reused?: boolean; parentNativeId?: string; error?: string;
}> {
  return page.evaluate(async (kind) => chrome.runtime.sendMessage({
    kind: 'known.save.native', entry: kind, userGesture: true,
  }) as Promise<{ ok: boolean; nativeIds: string[]; reused?: boolean; parentNativeId?: string; error?: string }>, entry);
}

async function countUrl(page: Page, url: string): Promise<number> {
  return page.evaluate(async (target) => (await chrome.bookmarks.search({ url: target })).length, url);
}
