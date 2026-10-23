import { chromium, expect, test, type BrowserContext, type Page, type TestInfo } from '@playwright/test';
import { resolve } from 'node:path';
import { startRealStack, type RealStack } from './real-stack.js';
import { KNOW_N_BACKEND_ONLY, knowNBackendRoot } from './cloud-product-fixtures.js';
import { openExtensionOptions, signInExtension } from './extension-auth.js';
import { FIXTURE_COLLECTION_ID } from './fixture-ids.js';
import { grantOptionalBookmarks } from './bookmark-permission.js';
import { grantBookmarks } from './kns-08-harness.js';
import { grantTabAccess, openPopupOver } from './popup-page.js';

const extensionPath = resolve(import.meta.dirname, '../dist/production');
const INSERT_CACHE = 'known.sync.save-context.v1';
const COLLECTION_CACHE = 'known.sync.collection.v1';

test.describe.configure({ mode: 'serial', timeout: 300_000 });

test('SP-05 G1 native placement, manager projection, offline save, and classification ingress', async ({}, testInfo) => {
  test.skip(!knowNBackendRoot, KNOW_N_BACKEND_ONLY);
  const stack = await startRealStack({ classification: true });
  let context: BrowserContext | undefined;
  try {
    context = await launch(stack);
    const options = (await openExtensionOptions(context)).page;
    await signInExtension(options, FIXTURE_COLLECTION_ID);
    await grantBookmarks(options);

    const bar = await browserBar(options);
    const target = await seedMixedChildren(options, bar.id);
    await verifyDirectoryShapes(options, context, bar.id, testInfo);
    await cacheSaveTarget(options, target.id);
    await grantTabAccess(context);

    // The worker's native message is the same path used by context-menu and
    // command listeners. Playwright cannot click the browser OS menu, so this
    // exercises the service-worker ingress while static listener tests cover
    // the menu/command registrations.
    await setPreference(options, 'top', false);
    const initial = await children(options, target.id);
    const topSave = await nativeSave(options, context, 'https://known.example/g1/top', 'page');
    expect(topSave.ok, JSON.stringify(topSave)).toBe(true);
    const afterTop = await children(options, target.id);
    expect(afterTop[0]?.url).toBe('https://known.example/g1/top');
    expect(relativeOrder(afterTop, initial.map((node) => node.id))).toEqual(initial.map((node) => node.id));

    await setPreference(options, 'bottom', false);
    const bottomSave = await nativeSave(options, context, 'https://known.example/g1/bottom', 'page');
    expect(bottomSave.ok, JSON.stringify(bottomSave)).toBe(true);
    const afterBottom = await children(options, target.id);
    expect(afterBottom.at(-1)?.url).toBe('https://known.example/g1/bottom');

    // Window saves preserve the browser tab order even when the insertion
    // policy puts the whole batch at the top of the target folder.
    await setPreference(options, 'top', false);
    const batchUrls = ['one', 'two', 'three'].map((name) => `https://known.example/g1/window-${name}`);
    const batchTabs = await Promise.all(batchUrls.map((url) => openHttpTab(context!, url)));
    // AC-04: the window entry hands off to the recoverable preview, so the tabs are
    // saved by the preview's own confirm step (same flow as
    // mv3-bookmark-save-placement-real.spec.ts).
    const previewOpened = context!.waitForEvent('page', (candidate) => candidate.url().includes('capture-tabs.html'));
    const batch = await options.evaluate(() => chrome.runtime.sendMessage({ kind: 'known.save.native', entry: 'window', userGesture: true }));
    expect(batch).toMatchObject({ ok: true, previewOpened: true });
    const preview = await previewOpened;
    await preview.waitForLoadState('domcontentloaded');
    if (!await preview.evaluate(() => chrome.permissions.contains({ permissions: ['tabs'] }))) {
      await grantOptionalBookmarks(preview, 'Allow tab access', 'Known tab preview', { permissions: ['tabs'] });
    }
    // The "save even if Know-N can't check" override was retired by 8dfc0fc00: browser saves never look anything up remotely.
    await preview.locator('#tabs-target').selectOption(target.id);
    await expect(preview.locator('#tabs-confirm')).toBeEnabled();
    await preview.locator('#tabs-confirm').click();
    await expect.poll(() => children(options, target.id).then((nodes) => nodes.slice(0, 3).map((node) => node.url))).toEqual(batchUrls);
    await preview.close();
    await Promise.all(batchTabs.map((page) => page.close()));

    // Network loss does not prevent the already cached local preference from
    // placing a new native bookmark.
    await context.setOffline(true);
    const offline = await nativeSave(options, context, 'https://known.example/g1/offline', 'page');
    expect(offline.ok, JSON.stringify(offline)).toBe(true);
    await context.setOffline(false);
    await options.evaluate(() => chrome.runtime.sendMessage({ kind: 'known.connectivity.online' }));
    expect((await children(options, target.id))[0]?.url).toBe('https://known.example/g1/offline');

    // The popup honors the account preference as the default; the per-save
    // position control moved to Options → Saving, so a save never updates
    // that account preference.
    const popupEvidence = [];
    for (const defaultPosition of ['bottom', 'top'] as const) {
      await setPreference(options, defaultPosition, false);
      const before = await preference(options);
      const url = `https://known.example/g1/popup-default-${defaultPosition}`;
      const popupTab = await openHttpTab(context, `https://known.example/g1/popup-source-${defaultPosition}`);
      const popup = await openPopupOver(context, popupTab);
      await popup.waitForFunction(() => document.body.dataset.state === 'connected', undefined, { timeout: 20_000 });
      await popup.fill('#tab-title', `G1 popup default ${defaultPosition}`);
      await popup.locator('#tab-url-display').click();
      await popup.fill('#tab-url', url);
      await popup.getByRole('button', { name: 'Save', exact: true }).click();
      await expect.poll(async () => countUrl(options, url), { timeout: 30_000 }).toBe(1);
      const native = await options.evaluate(async (savedUrl) => {
        const [saved] = await chrome.bookmarks.search({ url: savedUrl });
        return chrome.bookmarks.getChildren(saved!.parentId!);
      }, url);
      expect((defaultPosition === 'top' ? native[0] : native.at(-1))?.url).toBe(url);
      const after = await preference(options);
      expect(after.preferences).toEqual(before.preferences);
      popupEvidence.push({ defaultPosition, before, after, native: native.map(slim) });
      await popupTab.bringToFront();
      if (!popup.isClosed()) await popup.close();
      await popupTab.close();
    }

    // Options manager creates bookmarks at the preference position, while
    // folder creation remains native append semantics.
    await setPreference(options, 'top', false);
    await openManagerFolder(options, target.title);
    await options.locator('#manager-new-bookmark').click();
    await options.locator('.mgr-composer input[aria-label="New bookmark name"]').fill('G1 manager bookmark');
    await options.locator('.mgr-composer input[aria-label="New bookmark URL"]').fill('https://known.example/g1/manager-bookmark');
    await options.locator('.mgr-composer button[type="submit"]').click();
    await expect(options.locator('#manager-feedback')).toContainText('Bookmark added', { timeout: 15_000 });
    await options.locator('#manager-new-folder').click();
    await options.locator('.mgr-composer input[aria-label="New folder name"]').fill('G1 manager folder');
    await options.locator('.mgr-composer button[type="submit"]').click();
    await expect(options.locator('#manager-feedback')).toContainText('Folder created', { timeout: 15_000 });
    const afterManager = await children(options, target.id);
    expect(afterManager[0]?.url).toBe('https://known.example/g1/manager-bookmark');
    expect(afterManager.at(-1)?.title).toBe('G1 manager folder');

    // Enabling foldersFirst applies the same stable grouping to the native tree
    // and the manager. Disabling it keeps the grouped native order.
    await setPreference(options, 'top', false);
    await openManagerFolder(options, target.title);
    const nativeBeforeGrouping = await children(options, target.id);
    const groupedIds = [
      ...nativeBeforeGrouping.filter((node) => !node.url).map((node) => node.id),
      ...nativeBeforeGrouping.filter((node) => Boolean(node.url)).map((node) => node.id),
    ];
    await setFoldersFirstFromManager(options, true);
    await expect.poll(async () => (await children(options, target.id)).map(node => node.id)).toEqual(groupedIds);
    await expect.poll(() => managerListIds(options)).toEqual(groupedIds);
    await setFoldersFirstFromManager(options, false);
    await expect.poll(() => managerListIds(options)).toEqual(groupedIds);
    await setFoldersFirstFromManager(options, true);
    await expect.poll(() => managerListIds(options)).toEqual(groupedIds);
    expect((await children(options, target.id)).map(node => node.id)).toEqual(groupedIds);
    await options.screenshot({ path: testInfo.outputPath('g1-manager-folders-first.png'), fullPage: true });

    await verifyGroupedInteractions(options, target, testInfo);

    await testInfo.attach('g1-observations', {
      body: JSON.stringify({
        mixedChildren: { parentId: target.id, initial: initial.map(slim), afterTop: afterTop.map(slim), afterBottom: afterBottom.map(slim) },
        batchUrls, offlineUrl: 'https://known.example/g1/offline',
        popup: popupEvidence,
        manager: { native: nativeBeforeGrouping.map(slim), groupedIds, ungroupedIds: nativeBeforeGrouping.map((node) => node.id) },
      }, null, 2), contentType: 'application/json',
    });
  } finally {
    await context?.close().catch(() => undefined);
    await stack.close();
  }
});

test('SP-05 G1 signed-out offline device preference deduplicates rapid saves without uploading', async ({}, testInfo) => {
  const stack = await startRealStack();
  let context: BrowserContext | undefined;
  try {
    context = await launch(stack);
    const options = (await openExtensionOptions(context)).page;
    await options.locator('#nav-bookmarks').click();
    if (!await options.evaluate(() => chrome.permissions.contains({ permissions: ['bookmarks'] }))) {
      await grantOptionalBookmarks(options, 'Allow bookmark access', 'Known device save permission');
    }
    await options.reload({ waitUntil: 'domcontentloaded' });
    const bar = await browserBar(options);
    const target = await seedMixedChildren(options, bar.id);
    await cacheSaveTarget(options, target.id);
    const before = await children(options, target.id);
    const beforeServer = await stack.observations();
    const url = 'https://known.example/g1/device-offline-double-save';
    const tab = await openHttpTab(context, url);
    await tab.bringToFront();
    await context.setOffline(true);
    const updated = await options.evaluate(() => chrome.runtime.sendMessage({
      kind: 'known.bookmark.preferences.update', userGesture: true,
      bookmarkInsertPosition: 'top', foldersFirst: false,
    }));
    expect(updated).toMatchObject({ ok: true, scope: 'device', preferences: { bookmarkInsertPosition: 'top' } });
    const responses = await options.evaluate(() => Promise.all([
      chrome.runtime.sendMessage({ kind: 'known.save.native', entry: 'page', userGesture: true }),
      chrome.runtime.sendMessage({ kind: 'known.save.native', entry: 'page', userGesture: true }),
    ])) as Array<{ readonly ok: boolean; readonly error?: string }>;
    expect(responses.some(response => response.ok === true)).toBe(true);
    for (const response of responses) {
      if (!response.ok) expect(response).toMatchObject({ ok: false, error: 'busy' });
    }
    const replay = await options.evaluate(() => chrome.runtime.sendMessage({
      kind: 'known.save.native', entry: 'page', userGesture: true,
    }));
    expect(replay).toMatchObject({ ok: true, reused: true });
    const after = await children(options, target.id);
    expect(after[0]?.url).toBe(url);
    expect(after.filter((node) => node.url === url)).toHaveLength(1);
    expect(after.slice(1).map((node) => node.id)).toEqual(before.map((node) => node.id));
    await context.setOffline(false);
    await options.evaluate(() => chrome.runtime.sendMessage({ kind: 'known.connectivity.online' }));
    const local = await options.evaluate(() => chrome.runtime.sendMessage({ kind: 'known.bookmark.preferences.local' }));
    expect(local).toMatchObject({ ok: true, scope: 'device', preferences: { bookmarkInsertPosition: 'top' } });
    const server = await stack.observations();
    expect((server.canonicalNodes as Array<{ url?: string }>).filter((node) => node.url === url)).toHaveLength(0);
    expect(server.serverMutationCount).toBe(beforeServer.serverMutationCount);
    expect(server.pushRequests).toEqual(beforeServer.pushRequests);
    await testInfo.attach('g1-device-offline-save', { contentType: 'application/json', body: JSON.stringify({
      preferences: local, responses, before: before.map(slim), after: after.map(slim),
      server: { canonicalNodes: server.canonicalNodes, pushRequests: server.pushRequests,
        mutationCountBefore: beforeServer.serverMutationCount, mutationCountAfter: server.serverMutationCount },
    }, null, 2) });
  } finally {
    await context?.close().catch(() => undefined);
    await stack.close();
  }
});

async function launch(stack: RealStack): Promise<BrowserContext> {
  return chromium.launchPersistentContext('', {
    headless: false, channel: 'chromium', viewport: { width: 1100, height: 760 },
    ignoreHTTPSErrors: true,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`,
      `--host-resolver-rules=${stack.browserHostResolverRules}`, '--no-proxy-server', '--ignore-certificate-errors'],
  });
}

async function browserBar(page: Page): Promise<{ readonly id: string; readonly title: string }> {
  return page.evaluate(async () => {
    const node = (await chrome.bookmarks.getTree())[0]?.children?.[0];
    if (!node) throw new Error('bookmark_bar_missing');
    return { id: node.id, title: node.title };
  });
}

async function seedMixedChildren(page: Page, parentId: string): Promise<{ readonly id: string; readonly title: string }> {
  return page.evaluate(async (id) => {
    const target = await chrome.bookmarks.create({ parentId: id, title: 'G1 mixed target' });
    await chrome.bookmarks.create({ parentId: target.id, title: 'G1 folder A' });
    await chrome.bookmarks.create({ parentId: target.id, title: 'G1 bookmark X', url: 'https://known.example/g1/existing-x' });
    await chrome.bookmarks.create({ parentId: target.id, title: 'G1 folder B' });
    await chrome.bookmarks.create({ parentId: target.id, title: 'G1 bookmark Y', url: 'https://known.example/g1/existing-y' });
    return { id: target.id, title: target.title };
  }, parentId);
}

async function cacheSaveTarget(page: Page, parentNativeId: string): Promise<void> {
  await page.evaluate(({ collectionId, parentNativeId: parent, collectionKey, insertKey }) => chrome.storage.local.set({
    [collectionKey]: collectionId,
    [insertKey]: { collectionId, parentNativeId: parent },
    'known.sync.folder.v1': { collectionId, folderNativeId: parent },
  }), { collectionId: FIXTURE_COLLECTION_ID, parentNativeId,
    collectionKey: COLLECTION_CACHE, insertKey: INSERT_CACHE });
}

/**
 * T13 split the options page into panes, so a preference that lives in the Saving
 * pane can no longer be toggled while the Bookmarks manager is on screen. Toggle
 * it there, then come back so the caller can observe the freshly grouped manager.
 */
async function setFoldersFirstFromManager(page: Page, checked: boolean): Promise<void> {
  await page.evaluate(() => { location.hash = '#saving'; });
  await expect(page.locator('#bookmark-preferences')).toBeVisible();
  const folders = page.locator('#bookmark-folders-first');
  if (checked !== await folders.isChecked()) await folders.click();
  await expect.poll(async () => (await preference(page)).preferences.foldersFirst, { timeout: 15_000 }).toBe(checked);
  await page.evaluate(() => { location.hash = '#bookmarks'; });
  await page.locator('#manager-body').waitFor({ state: 'visible', timeout: 15_000 });
}

async function setPreference(page: Page, position: 'top' | 'bottom', foldersFirst: boolean): Promise<void> {
  // T13 moved "Save and display" into the Saving pane's settings view; the
  // bookmarks nav step now shows the bookmark hub only. The hash is the router's
  // own surface (`#saving`), set in place so no reload is needed.
  await page.evaluate(() => { location.hash = '#saving'; });
  await expect(page.locator('#bookmark-preferences')).toBeVisible();
  await page.locator(position === 'top' ? '#bookmark-insert-top' : '#bookmark-insert-bottom').click();
  const folders = page.locator('#bookmark-folders-first');
  if (foldersFirst !== await folders.isChecked()) await folders.click();
  // Success is a toast now (the status notice only appears for conflicts and failures), so wait on the stored value.
  await expect.poll(async () => (await preference(page)).preferences, { timeout: 15_000 })
    .toMatchObject({ bookmarkInsertPosition: position, foldersFirst });
}

async function preference(page: Page): Promise<{ readonly preferences: { readonly bookmarkInsertPosition: string; readonly foldersFirst: boolean } }> {
  return page.evaluate(() => chrome.runtime.sendMessage({ kind: 'known.bookmark.preferences.get' })) as Promise<{
    readonly preferences: { readonly bookmarkInsertPosition: string; readonly foldersFirst: boolean } }>;
}

async function children(page: Page, parentId: string): Promise<readonly chrome.bookmarks.BookmarkTreeNode[]> {
  return page.evaluate((id) => chrome.bookmarks.getChildren(id), parentId);
}

function slim(node: chrome.bookmarks.BookmarkTreeNode): Record<string, unknown> {
  return { id: node.id, title: node.title, url: node.url ?? null, index: node.index };
}

function relativeOrder(childrenNow: readonly chrome.bookmarks.BookmarkTreeNode[], ids: readonly string[]): string[] {
  const positions = new Map(childrenNow.map((node, index) => [node.id, index]));
  return [...ids].sort((left, right) => (positions.get(left) ?? -1) - (positions.get(right) ?? -1));
}

async function nativeSave(page: Page, context: BrowserContext, url: string, entry: 'page' | 'window') {
  const tab = await openHttpTab(context, url);
  try {
    await tab.bringToFront();
    return await page.evaluate((kind) => chrome.runtime.sendMessage({ kind: 'known.save.native', entry: kind, userGesture: true }), entry) as {
      readonly ok: boolean; readonly nativeIds?: readonly string[]; readonly error?: string };
  } finally { await tab.close(); }
}

async function openHttpTab(context: BrowserContext, url: string): Promise<Page> {
  const page = await context.newPage();
  await page.route('**/*', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: `<title>${url}</title>` }));
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  return page;
}

async function openManagerFolder(page: Page, title: string): Promise<void> {
  // T13 put the manager behind the Bookmarks hub pane; the hash is the router's
  // own surface, so no reload is needed.
  await page.evaluate(() => { location.hash = '#bookmarks'; });
  await page.locator('#manager-body').waitFor({ state: 'visible', timeout: 15_000 });
  const folder = page.locator('#manager-tree .mgr-tree-name').filter({ hasText: title }).first();
  await expect(folder).toBeVisible({ timeout: 15_000 });
  await folder.click();
  await expect(page.locator('#manager-path')).toContainText(title);
}

async function managerListIds(page: Page): Promise<readonly string[]> {
  return page.locator('#manager-list .mgr-row[data-id]').evaluateAll((rows) => rows.map((row) => row.getAttribute('data-id'))
    .filter((id): id is string => typeof id === 'string'));
}

async function countUrl(page: Page, url: string): Promise<number> {
  return page.evaluate(async (target) => (await chrome.bookmarks.search({ url: target })).length, url);
}

async function verifyDirectoryShapes(page: Page, context: BrowserContext, parentId: string, testInfo: TestInfo): Promise<void> {
  const observations = [];
  for (const position of ['top', 'bottom'] as const) {
    await setPreference(page, position, false);
    for (const shape of ['empty', 'bookmarks', 'folders'] as const) {
      const folder = await page.evaluate(async ({ parent, kind, placement }) => {
        const node = await chrome.bookmarks.create({ parentId: parent, title: `G1 ${kind} ${placement}` });
        if (kind !== 'empty') {
          for (const suffix of ['a', 'b']) {
            await chrome.bookmarks.create({ parentId: node.id, title: `${kind} ${suffix}`,
              ...(kind === 'bookmarks' ? { url: `https://known.example/g1/seed-${placement}-${suffix}` } : {}) });
          }
        }
        return node;
      }, { parent: parentId, kind: shape, placement: position });
      await cacheSaveTarget(page, folder.id);
      const before = await children(page, folder.id);
      const url = `https://known.example/g1/${shape}-${position}`;
      expect(await nativeSave(page, context, url, 'page')).toMatchObject({ ok: true });
      const after = await children(page, folder.id);
      expect((position === 'top' ? after[0] : after.at(-1))?.url).toBe(url);
      expect(after.filter((node) => node.url !== url).map((node) => node.id)).toEqual(before.map((node) => node.id));
      observations.push({ shape, position, before: before.map(slim), after: after.map(slim) });
    }
  }
  await testInfo.attach('g1-directory-shapes', { contentType: 'application/json', body: JSON.stringify(observations, null, 2) });
}

async function verifyGroupedInteractions(page: Page, target: { readonly id: string; readonly title: string }, testInfo: TestInfo): Promise<void> {
  // Rows are 58px tall now. Drags must not need a scroll between pressing and dropping (a scroll would move another row
  // under the pressed pointer), so the window is made tall enough to show the whole folder.
  await page.setViewportSize({ width: 1280, height: 1600 });
  const nativeBefore = await children(page, target.id);
  const visible = await managerListIds(page);
  const folderCount = nativeBefore.filter((node) => !node.url).length;
  const row = (id: string) => page.locator(`#manager-list .mgr-row[data-id="${id}"]`);
  // Checkboxes appear once Select is on.
  await page.locator('#manager-select').click();
  await expect(page.locator('#manager-select')).toHaveAttribute('aria-pressed', 'true');
  await row(visible[0]!).locator('.mgr-select').click();
  await row(visible[folderCount]!).locator('.mgr-select').click({ modifiers: ['Shift'] });
  const selected = await page.locator('#manager-list .mgr-row[data-selected]').evaluateAll((rows) => rows.map((item) => item.getAttribute('data-id')));
  expect(selected).toEqual(visible.slice(0, folderCount + 1));
  for (const id of visible.slice(0, folderCount + 1)) await row(id).locator('.mgr-select').uncheck();
  await page.locator('#manager-select').click();
  await expect(page.locator('#manager-select')).toHaveAttribute('aria-pressed', 'false');

  const source = nativeBefore.find((node) => node.title === 'G1 bookmark Y')!;
  const destination = nativeBefore.find((node) => node.title === 'G1 bookmark X')!;
  const folder = nativeBefore.find((node) => node.title === 'G1 folder B')!;
  await row(source.id).focus();
  await row(source.id).press('F2');
  // F2 opens the Edit bookmark dialog; its Title field is a labelled input holding the current title.
  const editor = page.getByRole('dialog', { name: 'Edit bookmark' });
  await expect(editor.getByLabel('Title', { exact: true })).toHaveValue(source.title);
  await editor.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(editor).toBeHidden();
  expect((await children(page, target.id)).map((node) => node.id)).toEqual(nativeBefore.map((node) => node.id));

  // Dragging Y before X preserves the native grouping and all other IDs.
  await row(source.id).dragTo(row(destination.id));
  const expectedBefore = nativeBefore.filter((node) => node.id !== source.id).map((node) => node.id);
  expectedBefore.splice(expectedBefore.indexOf(destination.id), 0, source.id);
  await expect.poll(async () => (await children(page, target.id)).map((node) => node.id)).toEqual(expectedBefore);
  await expect.poll(() => managerListIds(page)).toEqual([
    ...nativeBefore.filter((node) => !node.url).map((node) => node.id),
    ...expectedBefore.filter((id) => nativeBefore.find((node) => node.id === id)?.url),
  ]);
  await row(source.id).dragTo(row(folder.id));
  await expect.poll(async () => (await children(page, folder.id)).map((node) => node.id)).toContain(source.id);
  expect((await children(page, target.id)).map((node) => node.id)).toEqual(expectedBefore.filter((id) => id !== source.id));

  const query = 'G1';
  const searchOrder = await page.evaluate(async (value) => (await chrome.bookmarks.search({ query: value })).slice(0, 200).map((node) => node.id), query);
  await page.locator('#manager-search').fill(query);
  await expect.poll(() => managerListIds(page)).toEqual(searchOrder);
  await setFoldersFirstFromManager(page, false);
  await expect.poll(() => managerListIds(page)).toEqual(searchOrder);
  await setFoldersFirstFromManager(page, true);
  await expect.poll(() => managerListIds(page)).toEqual(searchOrder);
  await page.locator('#manager-search').fill('');
  await openManagerFolder(page, target.title);
  await testInfo.attach('g1-grouped-interactions', { contentType: 'application/json', body: JSON.stringify({
    nativeBefore: nativeBefore.map(slim), visible, selected, keyboardTarget: source.id,
    dragBefore: { source: source.id, destination: destination.id, nativeOrder: expectedBefore },
    dragInto: { source: source.id, destination: folder.id, native: (await children(page, folder.id)).map(slim) },
    searchOrder,
  }, null, 2) });
}
