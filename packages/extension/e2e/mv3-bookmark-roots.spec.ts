import { chromium, expect, test, type BrowserContext, type Page } from '@playwright/test';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { startRealStack, type RealStack } from './real-stack.js';
import { grantOptionalBookmarks } from './bookmark-permission.js';
import { openExtensionOptions, signInExtension, showOptionsPane } from './extension-auth.js';
import { FIXTURE_COLLECTION_ID } from './fixture-ids.js';
import { confirmFirstRun, specialRoots, waitFirstRunProductQuiet } from './kns-08-harness.js';
import { withSyncFailureDetails } from './sync-failure-diagnostics.js';
import { expectProfileMappingBoundary, expectRootAuthorityRejected, readStores, reviewCurrentRootAuthority } from './bookmark-roots-authority.js';
import type { BoundaryCommandRecord, SyncScope } from '../src/sync-state-store.js';
import type { PublicRootView } from '../src/types.js';

const EXTENSION_ID = 'pplpnpegpnghcddhmpgkbfkdfadjiaen';
const PRIVATE_TITLE = 'PRIVATE-LOCAL-SENTINEL';
const PRIVATE_URL = 'https://sentinel.invalid/private?native=native-sensitive-id';
const UNSELECTED_TITLE = 'UNSELECTED-SENTINEL';
const UNSELECTED_URL = 'https://sentinel.invalid/unselected';
const PROFILE_A_TITLE = 'PROFILE-A-PRIVATE-SENTINEL';
const PROFILE_B_TITLE = 'PROFILE-B-PRIVATE-SENTINEL';
const PROFILE_A_URL = 'https://sentinel.invalid/profile-a-private';
const PROFILE_B_URL = 'https://sentinel.invalid/profile-b-private';
const PROFILE_A_UNSELECTED = 'PROFILE-A-UNSELECTED-SENTINEL';
const PROFILE_B_UNSELECTED = 'PROFILE-B-UNSELECTED-SENTINEL';
const PROFILE_A_UNSELECTED_URL = 'https://sentinel.invalid/profile-a-unselected';
const PROFILE_B_UNSELECTED_URL = 'https://sentinel.invalid/profile-b-unselected';
const extensionPath = resolve(import.meta.dirname, '../dist/production');
const execFileAsync = promisify(execFile);
const profileBindings = {
  main: { replicaId: 'replica-root-management', browserProfileId: 'profile-root-management', generation: '1' as const },
  a: { replicaId: 'replica-root-management-a', browserProfileId: 'profile-root-management-a', generation: '1' as const },
  b: { replicaId: 'replica-root-management-b', browserProfileId: 'profile-root-management-b', generation: '1' as const },
};
let stack: RealStack | undefined;

test.beforeEach(async () => { stack = await startRealStack(); });
test.afterEach(async () => { await stack?.close(); stack = undefined; });

test('optional bookmark permission revokes and recovers real root authority without disclosure', async ({}, testInfo) => {
  test.setTimeout(120_000);
  const context = await launch(); const page = await openOptions(context); const evidence = observe(context);
  try {
    await connect(page, false);
    await expectPermission(page, false);
    await expect(page.getByText(/bookmark permission is required/i)).toBeVisible();
    await grantBookmarkPermission(page);
    await expectPermission(page, true);
    await expect(page.locator('#root-tree .root-row').first()).toBeVisible();

    const ids = await createFixture(page, { selectedTitle: 'Work', privateTitle: PRIVATE_TITLE, privateUrl: PRIVATE_URL,
      unselectedTitle: UNSELECTED_TITLE, unselectedUrl: UNSELECTED_URL });
    await configure(page, 'Work', PRIVATE_TITLE);
    const scope = scopeFor(profileBindings.main);
    const before = await evidenceRequest(page, 'exportScope', scope);
    await expect.poll(async () => {
      const result = await page.evaluate(() => chrome.runtime.sendMessage({
        kind: 'known.sync-state.evidence', method: 'syncEngineState', args: [] })) as {
        ok?: boolean; value?: { phase?: string; engineWakeInFlight?: boolean } };
      return result.ok === true && result.value?.phase === 'sleeping' && result.value.engineWakeInFlight !== true
        ? 'sleeping' : JSON.stringify(result.value ?? result);
    }, { timeout: 15_000 }).toBe('sleeping');

    const networkAtRevoke = evidence.network.length;
    await page.getByRole('button', { name: 'Remove bookmark access' }).click();
    await page.getByRole('button', { name: 'Remove access' }).click();
    await expectPermission(page, false);
    await expect(page.getByText(/bookmark permission is required/i)).toBeVisible();
    await expect(page.locator('.root-row')).toHaveCount(0);
    const revoked = await evidenceRequest(page, 'exportScope', scope);
    expect(privateAuthority(revoked)).toEqual(privateAuthority(before));
    expect(revoked.scope.rootStatus).toBe('permission_required');
    const deniedRead = await page.evaluate(() => chrome.runtime.sendMessage({ kind: 'known.roots.get' }));
    expect(deniedRead).toMatchObject({ ok: true, view: { status: 'permission_required', roots: [] } });
    // The reload that follows a permission change reads the page and the session; nothing is uploaded.
    expect(evidence.network.slice(networkAtRevoke).filter((request) => /^(POST|PUT|PATCH|DELETE) /u.test(request))).toEqual([]);

    await grantBookmarkPermission(page);
    await expectPermission(page, true);
    await expectPrivateSelection(page, 'Work', PRIVATE_TITLE);
    const recovered = await evidenceRequest(page, 'exportScope', scope);
    expect(privateAuthority(recovered)).toEqual(privateAuthority(before));
    expect(recovered.scope.rootStatus).toBe('ready');

    await page.evaluate(async (id) => chrome.bookmarks.removeTree(id), ids.selected);
    await page.getByRole('button', { name: 'Remove bookmark access' }).click();
    await page.getByRole('button', { name: 'Remove access' }).click();
    await expectPermission(page, false);
    await grantBookmarkPermission(page);
    await expectPermission(page, true);
    await expect(page.getByText(/selected folder is missing/i)).toBeVisible();
    const missing = await evidenceRequest(page, 'exportScope', scope);
    expect(privateAuthority(missing)).toEqual(privateAuthority(before));
    expect(missing.scope.rootStatus).toBe('root_missing');

    assertNoBookmarkDisclosure(evidence, [PRIVATE_TITLE, PRIVATE_URL, UNSELECTED_TITLE, UNSELECTED_URL],
      [ids.privateRoot, ids.unselected]);
    await page.evaluate(async (id) => chrome.bookmarks.update(id, { title: 'Personal' }), ids.unselected);
    await page.getByRole('button', { name: 'Refresh folders' }).click();
    await expect(page.getByText(/selected folder is missing/i)).toBeVisible();
    await page.setViewportSize({ width: 400, height: 820 });
    await page.screenshot({ path: testInfo.outputPath('permission-recovered-missing-400-hidpi.png'), fullPage: true });
    await scanArtifacts(testInfo.outputDir);
  } finally { await context.close(); }
});

test('two persistent Chromium profiles retain isolated root authorities and archives across restart', async ({}, testInfo) => {
  test.setTimeout(180_000);
  const profileA = await mkdtemp(resolve(tmpdir(), 'known-p3-29-profile-a-'));
  const profileB = await mkdtemp(resolve(tmpdir(), 'known-p3-29-profile-b-'));
  let contextA = await launch(profileA); let contextB = await launch(profileB);
  const evidenceA = observe(contextA); const evidenceB = observe(contextB);
  try {
    let pageA = await openOptions(contextA); let pageB = await openOptions(contextB);
    await connect(pageA, true, profileBindings.a);
    await connect(pageB, true, profileBindings.b);
    const fixtureA = await createFixture(pageA, { selectedTitle: 'Profile A root', privateTitle: PROFILE_A_TITLE,
      privateUrl: PROFILE_A_URL, unselectedTitle: PROFILE_A_UNSELECTED, unselectedUrl: PROFILE_A_UNSELECTED_URL });
    const fixtureB = await createFixture(pageB, { selectedTitle: 'Profile B root', privateTitle: PROFILE_B_TITLE,
      privateUrl: PROFILE_B_URL, unselectedTitle: PROFILE_B_UNSELECTED, unselectedUrl: PROFILE_B_UNSELECTED_URL,
      dummyFolders: 4 });
    expect(fixtureA.selected).not.toBe(fixtureB.selected);
    await configure(pageA, 'Profile A root', PROFILE_A_TITLE);
    await configure(pageB, 'Profile B root', PROFILE_B_TITLE);
    const viewA = await expectProfileRootAuthority(pageA, fixtureA, scopeFor(profileBindings.a), 'Profile A root', 'Profile B root');
    const viewB = await expectProfileRootAuthority(pageB, fixtureB, scopeFor(profileBindings.b), 'Profile B root', 'Profile A root');
    const tokenA = viewA.roots.find((root) => root.title === 'Profile A root')!.ref;
    const tokenB = viewB.roots.find((root) => root.title === 'Profile B root')!.ref;
    const reviewA = await reviewCurrentRootAuthority(pageA, viewA);
    const reviewB = await reviewCurrentRootAuthority(pageB, viewB);
    await expectRootAuthorityRejected(pageB, scopeFor(profileBindings.b), [
      { ...reviewB.request, selectedRefs: [tokenA] },
      { kind: 'known.roots.confirm', previewId: reviewA.preview.previewId,
        treeDigest: reviewA.preview.treeDigest, confirmationId: crypto.randomUUID() },
    ]);
    await expectRootAuthorityRejected(pageA, scopeFor(profileBindings.a), [
      { ...reviewA.request, selectedRefs: [tokenB] },
      { kind: 'known.roots.confirm', previewId: reviewB.preview.previewId,
        treeDigest: reviewB.preview.treeDigest, confirmationId: crypto.randomUUID() },
    ]);

    await Promise.all([terminateExtensionWorker(contextA, pageA), terminateExtensionWorker(contextB, pageB)]);
    // Installation can leave an extra welcome tab. Reload the two pages we
    // actually configured; selecting the first options tab may pick a stale,
    // never-signed-in welcome view instead of exercising worker recovery.
    await Promise.all([pageA.reload(), pageB.reload()]);
    await Promise.all([expectConfigured(pageA, 'Profile A root', PROFILE_A_TITLE),
      expectConfigured(pageB, 'Profile B root', PROFILE_B_TITLE)]);
    await Promise.all([contextA.close(), contextB.close()]);
    contextA = await launch(profileA); contextB = await launch(profileB);
    observe(contextA, evidenceA); observe(contextB, evidenceB);
    [pageA, pageB] = await Promise.all([openOptions(contextA), openOptions(contextB)]);
    await Promise.all([expectConfigured(pageA, 'Profile A root', PROFILE_A_TITLE),
      expectConfigured(pageB, 'Profile B root', PROFILE_B_TITLE)]);
    const restartedViewA = await expectProfileRootAuthority(pageA, fixtureA, scopeFor(profileBindings.a), 'Profile A root', 'Profile B root');
    const restartedViewB = await expectProfileRootAuthority(pageB, fixtureB, scopeFor(profileBindings.b), 'Profile B root', 'Profile A root');
    const restartedTokenA = restartedViewA.roots.find((root) => root.title === 'Profile A root')!.ref;
    const restartedTokenB = restartedViewB.roots.find((root) => root.title === 'Profile B root')!.ref;
    const restartedReviewA = await reviewCurrentRootAuthority(pageA, restartedViewA);
    const restartedReviewB = await reviewCurrentRootAuthority(pageB, restartedViewB);
    expect(restartedViewA.viewId).not.toBe(viewA.viewId); expect(restartedViewB.viewId).not.toBe(viewB.viewId);
    // Refs identify scope + native folder and may remain stable. The stale
    // worker's viewId is the invalid authority; a ref alone is not an expiry.
    await expectRootAuthorityRejected(pageA, scopeFor(profileBindings.a), [
      { ...restartedReviewA.request, viewId: viewA.viewId },
      { ...restartedReviewA.request, selectedRefs: [restartedTokenB] },
    ]);
    await expectRootAuthorityRejected(pageB, scopeFor(profileBindings.b), [
      { ...restartedReviewB.request, viewId: viewB.viewId },
      { ...restartedReviewB.request, selectedRefs: [restartedTokenA] },
    ]);

    const scopeA = scopeFor(profileBindings.a); const scopeB = scopeFor(profileBindings.b);
    const exportA = await evidenceRequest(pageA, 'exportScope', scopeA);
    const exportB = await evidenceRequest(pageB, 'exportScope', scopeB);
    const crossA = await evidenceRequest(pageA, 'exportScope', scopeB);
    const crossB = await evidenceRequest(pageB, 'exportScope', scopeA);
    expect(crossA).toMatchObject({ scope: null, mappings: [], queue: [], receipts: [], intents: [] });
    expect(crossB).toMatchObject({ scope: null, mappings: [], queue: [], receipts: [], intents: [] });
    assertAuthorityIsolation(exportA, exportB); assertAuthorityIsolation(exportB, exportA);
    expect(exportA.scope).toMatchObject({ browserProfileId: profileBindings.a.browserProfileId,
      replicaId: profileBindings.a.replicaId, rootStatus: 'ready' });
    expect(exportB.scope).toMatchObject({ browserProfileId: profileBindings.b.browserProfileId,
      replicaId: profileBindings.b.replicaId, rootStatus: 'ready' });
    expect(exportA.scope.selectedRoots).toHaveLength(1); expect(exportA.scope.privateRoots).toHaveLength(1);
    expect(exportB.scope.selectedRoots).toHaveLength(1); expect(exportB.scope.privateRoots).toHaveLength(1);
    await expectProfileMappingBoundary(pageA, exportA, fixtureA, exportB.scope.selectedRoots[0]);
    await expectProfileMappingBoundary(pageB, exportB, fixtureB, exportA.scope.selectedRoots[0]);
    expect(privateAuthority(exportA)).not.toEqual(privateAuthority(exportB));

    await showOptionsPane(pageA, 'account');
    await showOptionsPane(pageB, 'account');
    await pageA.getByRole('button', { name: 'Sign out' }).click(); await pageA.locator('#logout-confirm').click();
    await expect(pageA.locator('#login-panel')).toBeVisible();
    await pageB.getByRole('button', { name: 'Sign out' }).click(); await pageB.locator('#logout-confirm').click();
    await expect(pageB.locator('#login-panel')).toBeVisible();
    const archiveA = await evidenceRequest(pageA, 'exportArchive', scopeA);
    const archiveB = await evidenceRequest(pageB, 'exportArchive', scopeB);
    expect(archiveA).toMatchObject({ browserProfileId: profileBindings.a.browserProfileId,
      replicaId: profileBindings.a.replicaId, lifecycle: 'retired' });
    expect(archiveB).toMatchObject({ browserProfileId: profileBindings.b.browserProfileId,
      replicaId: profileBindings.b.replicaId, lifecycle: 'retired' });
    assertAuthorityIsolation(archiveA, archiveB); assertAuthorityIsolation(archiveB, archiveA);
    await expectEvidenceFailure(pageA, 'exportArchive', scopeB, 'archive_not_found');
    await expectEvidenceFailure(pageB, 'exportArchive', scopeA, 'archive_not_found');

    assertNoBookmarkDisclosure(evidenceA, [PROFILE_A_TITLE, PROFILE_A_URL, PROFILE_A_UNSELECTED, PROFILE_A_UNSELECTED_URL,
      PROFILE_B_TITLE, PROFILE_B_URL, PROFILE_B_UNSELECTED, PROFILE_B_UNSELECTED_URL],
      [fixtureA.privateRoot, fixtureB.privateRoot]);
    assertNoBookmarkDisclosure(evidenceB, [PROFILE_A_TITLE, PROFILE_A_URL, PROFILE_A_UNSELECTED, PROFILE_A_UNSELECTED_URL,
      PROFILE_B_TITLE, PROFILE_B_URL, PROFILE_B_UNSELECTED, PROFILE_B_UNSELECTED_URL],
      [fixtureA.privateRoot, fixtureB.privateRoot]);
    expect(evidenceA.bodies.some((body) => containsJsonStringValue(body, profileBindings.b.browserProfileId)
      || containsJsonStringValue(body, profileBindings.b.replicaId))).toBe(false);
    expect(evidenceB.bodies.some((body) => containsJsonStringValue(body, profileBindings.a.browserProfileId)
      || containsJsonStringValue(body, profileBindings.a.replicaId))).toBe(false);
    await Promise.all([pageA.screenshot({ path: testInfo.outputPath('profile-a-restarted.png'), fullPage: true }),
      pageB.screenshot({ path: testInfo.outputPath('profile-b-restarted.png'), fullPage: true })]);
    await scanArtifacts(testInfo.outputDir);
  } finally {
    await Promise.allSettled([contextA.close(), contextB.close()]);
    await Promise.all([rm(profileA, { recursive: true, force: true }), rm(profileB, { recursive: true, force: true })]);
  }
});

test('options root permission and tree controls are keyboard accessible at narrow, desktop and HiDPI sizes', async ({}, testInfo) => {
  const context = await launch(); const page = await openOptions(context);
  try {
    await connect(page, false); await page.setViewportSize({ width: 400, height: 820 });
    await expect(page.getByRole('button', { name: 'Allow bookmark access' })).toBeEnabled();
    await page.getByRole('button', { name: 'Allow bookmark access' }).focus();
    await expect(page.getByRole('button', { name: 'Allow bookmark access' })).toBeFocused();
    await page.screenshot({ path: testInfo.outputPath('permission-required-400.png'), fullPage: true });
    await grantBookmarkPermission(page);
    await page.setViewportSize({ width: 1280, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await expect(page.getByRole('button', { name: 'Remove bookmark access' })).toBeEnabled();
    await page.screenshot({ path: testInfo.outputPath('roots-desktop.png'), fullPage: true });
    await scanArtifacts(testInfo.outputDir);
  } finally { await context.close(); }
});

test('stale folder tokens fail closed after the native tree changes', async () => {
  test.setTimeout(120_000);
  const context = await launch();
  try {
    const page = await openOptions(context); await connect(page);
    const roots = await specialRoots(page);
    await finishFirstRun(page, [roots.otherTitle]);
    const folderId = await page.evaluate(async () => {
      const tree = await chrome.bookmarks.getTree();
      return (await chrome.bookmarks.create({ parentId: tree[0]!.children![0]!.id, title: 'Stale boundary' })).id;
    });
    await page.getByRole('button', { name: 'Refresh folders' }).click();
    await page.getByRole('checkbox', { name: 'Stale boundary', exact: true }).check();
    await page.evaluate(async (id) => { await chrome.bookmarks.create({ parentId: id, title: 'Tree changed' }); }, folderId);
    const boundaryFacts = async () => {
      const exported = await evidenceRequest(page, 'exportScope', scopeFor(profileBindings.main));
      const journal = (await readStores(page, ['boundary_confirmation_commands'])).boundary_confirmation_commands as BoundaryCommandRecord[] | undefined;
      return { selectedRoots: exported.scope.selectedRoots, privateRoots: exported.scope.privateRoots,
        version: exported.scope.boundaryVersion, queue: exported.queue, receipts: exported.receipts,
        journal: journal?.filter(row => row.scopeKey === exported.scope.scopeKey) ?? [] };
    };
    const before = await boundaryFacts();
    await page.getByRole('button', { name: 'Review changes' }).click();
    await expect(page.locator('#root-alert-copy, #root-feedback').filter({ hasText: /could not be loaded|Folder tree changed/i })).toBeVisible();
    expect(await boundaryFacts()).toEqual(before);
    // Retry refreshes the token and keeps the unsaved choice. It grants no
    // authority: the user must review the changed tree and explicitly confirm.
    await page.locator('#root-retry').click();
    await expect(page.getByRole('checkbox', { name: 'Stale boundary', exact: true })).toBeChecked();
    await expect(page.locator('#range-preview')).toBeHidden();
    expect(await boundaryFacts()).toEqual(before);
    await page.getByRole('button', { name: 'Review changes' }).click();
    await expect(page.locator('#range-preview')).toBeVisible();
    expect(await boundaryFacts()).toEqual(before);
    await page.locator('#range-confirm').click();
    await withSyncFailureDetails(page, 'roots: commit explicitly reviewed replacement token', () => expect.poll(async () => (await boundaryFacts()).journal.filter(row =>
      !before.journal.some(prior => prior.commandId === row.commandId)
      && row.kind === 'range' && row.state === 'committed').length).toBe(1));
    const after = await evidenceRequest(page, 'exportScope', scopeFor(profileBindings.main));
    const selected = after.mappings.find((row: { nativeId: string }) => row.nativeId === folderId);
    expect(selected?.colpId).toBeTruthy();
    expect(after.scope.selectedRoots).toContain(selected.colpId);
    expect(Number(after.scope.boundaryVersion)).toBe(Number(before.version) + 1);
    expect(await page.evaluate(async id => (await chrome.bookmarks.getSubTree(id))[0]?.children?.map(row => row.title), folderId))
      .toEqual(['Tree changed']);
  } finally { await context.close(); }
});

test('expanding first-sync coverage from 12/28 to 28/28 lists the added folders and bookmarks', async ({}, testInfo) => {
  test.setTimeout(120_000);
  const context = await launch();
  try {
    const page = await openOptions(context); await connect(page);
    const roots = await specialRoots(page);
    await page.evaluate(async barId => {
      for (let group = 0; group < 2; group += 1) {
        const parent = await chrome.bookmarks.create({ parentId: barId, title: `Previously synced ${group}` });
        for (let child = 0; child < 4 + group; child += 1) {
          await chrome.bookmarks.create({ parentId: parent.id, title: `Already covered ${group}-${child}` });
        }
        await chrome.bookmarks.create({ parentId: parent.id, title: `Existing bookmark ${group}`, url: `https://example.test/old/${group}` });
      }
      for (let index = 0; index < 15; index += 1) {
        const title = `New coverage ${index}${index === 14 ? ' DeepFolderName'.repeat(10) : ''}`;
        const folder = await chrome.bookmarks.create({ parentId: barId, title });
        await chrome.bookmarks.create({ parentId: folder.id, title: `New bookmark ${index}`, url: `https://example.test/new/${index}` });
      }
      await chrome.bookmarks.create({ parentId: barId, title: 'Loose new bookmark', url: 'https://example.test/new/loose' });
    }, roots.barId);
    await finishFirstRun(page, ['Previously synced 0', 'Previously synced 1', roots.otherTitle]);
    await expect(page.locator('#folder-count')).toHaveText('12 of 28 folders sync');
    await page.locator('#tree-select-level').click();
    await expect(page.locator('#folder-count')).toHaveText('28 of 28 folders sync');
    await page.locator('#save-roots').click();
    await expect(page.locator('#range-preview-totals')).toContainText('Will sync 18 bookmarks in 28 folders.');
    await expect(page.locator('#range-preview-totals')).toContainText('16 folders and 16 bookmarks will start syncing');
    await expect(page.locator('#range-add-list > li')).toHaveCount(16);
    await expect(page.locator('#range-add-list')).toContainText(`${roots.barTitle} / New coverage 0: 1 bookmark directly in this folder.`);
    await expect(page.locator('#range-add-list')).not.toContainText('Previously synced');
    await expect(page.locator('#range-remove-list')).toBeHidden();
    await page.screenshot({ path: testInfo.outputPath('range-expansion-review.png'), fullPage: true });
    await page.setViewportSize({ width: 360, height: 700 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await page.locator('#range-cancel').click();
    await page.reload(); await showOptionsPane(page, 'folders');
    await expect(page.locator('#folder-count')).toHaveText('12 of 28 folders sync');
  } finally { await context.close(); }
});

async function openOptions(context: BrowserContext): Promise<Page> {
  return (await openExtensionOptions(context)).page;
}
async function connect(page: Page, grantBookmarks = true, binding = profileBindings.main) {
  if (!stack || !binding) throw new Error('real stack unavailable');
  await page.evaluate((value) => chrome.storage.local.set({ 'known.auth.binding.v1': value }), binding);
  await withSyncFailureDetails(page, 'roots: establish account session', () => signInExtension(page));
  await showOptionsPane(page, 'folders');
  await expect(page.locator('#folder-card')).toBeVisible();
  if (grantBookmarks && !await permissionState(page)) {
    await grantBookmarkPermission(page); await expectPermission(page, true);
  }
}
async function grantBookmarkPermission(page: Page) {
  await withSyncFailureDetails(page, 'roots: grant native bookmark permission', () => grantOptionalBookmarks(page, 'Allow bookmark access', 'Known permission'));
}
async function launch(profile = ''): Promise<BrowserContext> {
  if (!stack) throw new Error('real stack unavailable');
  return chromium.launchPersistentContext(profile, { headless: false, channel: 'chromium', viewport: { width: 900, height: 720 },
    deviceScaleFactor: 2, ignoreHTTPSErrors: true, args: [`--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`, `--host-resolver-rules=${stack.browserHostResolverRules}`,
      '--no-proxy-server', '--ignore-certificate-errors'] });
}
async function createFixture(page: Page, input: { selectedTitle: string; privateTitle: string; privateUrl: string;
  unselectedTitle: string; unselectedUrl: string; dummyFolders?: number }) {
  return page.evaluate(async (value) => {
    const tree = await chrome.bookmarks.getTree(); const root = tree[0]!.children![0]!.id;
    for (let index = 0; index < (value.dummyFolders ?? 0); index += 1) {
      await chrome.bookmarks.create({ parentId: root, title: `Profile fixture ${index}` });
    }
    const selected = await chrome.bookmarks.create({ parentId: root, title: value.selectedTitle });
    const privateRoot = await chrome.bookmarks.create({ parentId: selected.id, title: value.privateTitle });
    await chrome.bookmarks.create({ parentId: privateRoot.id, title: value.privateTitle, url: value.privateUrl });
    const unselected = await chrome.bookmarks.create({ parentId: root, title: value.unselectedTitle });
    await chrome.bookmarks.create({ parentId: unselected.id, title: value.unselectedTitle, url: value.unselectedUrl });
    return { selected: selected.id, privateRoot: privateRoot.id, unselected: unselected.id };
  }, input);
}
async function finishFirstRun(page: Page, selectedTitles: readonly string[], excludedTitles: readonly string[] = []) {
  if (!stack) throw new Error('real stack unavailable');
  // These journeys test established root management. Complete the real
  // onboarding handshake before using its privacy/settings controls.
  const binding = await page.evaluate(async () => (await chrome.storage.local.get('known.auth.binding.v1'))
    ['known.auth.binding.v1']) as RealStack['extensionBinding'];
  await withSyncFailureDetails(page, 'roots: admit first-run selection', () => confirmFirstRun(page, selectedTitles, undefined, excludedTitles));
  const currentStack = stack;
  await withSyncFailureDetails(page, 'roots: await first-run native and canonical convergence', () => waitFirstRunProductQuiet(page, currentStack, binding));
  await page.reload();
  await showOptionsPane(page, 'folders');
  await expect(page.locator('body')).toHaveAttribute('data-first-run', '');
}

async function configure(page: Page, selectedTitle: string, privateTitle: string) {
  await finishFirstRun(page, [selectedTitle], [privateTitle]);
  // The production first-run Review + Confirm already persisted this exact
  // selection. Checking its mixed parent again would explicitly include the
  // private child, so verify the restored authority without changing the draft.
  await expectPrivateSelection(page, selectedTitle, privateTitle);
}
async function expectConfigured(page: Page, selectedTitle: string, privateTitle: string) {
  await showOptionsPane(page, 'account');
  await expect(page.locator('body')).toHaveAttribute('data-state', 'connected', { timeout: 15_000 });
  await showOptionsPane(page, 'folders');
  await expectPrivateSelection(page, selectedTitle, privateTitle);
}
async function expectPrivateSelection(page: Page, selectedTitle: string, privateTitle: string) {
  await expect(page.getByRole('checkbox', { name: selectedTitle, exact: true })).toHaveJSProperty('indeterminate', true);
  await expect(page.getByRole('checkbox', { name: privateTitle, exact: true })).not.toBeChecked();
  const view = await getRootView(page);
  expect(view.roots.find(root => root.title === selectedTitle)).toMatchObject({ selected: true, privateLocal: false });
  expect(view.roots.find(root => root.title === privateTitle)).toMatchObject({ selected: false, privateLocal: true });
}
async function expectProfileRootAuthority(page: Page, fixture: { selected: string; privateRoot: string },
  scope: ReturnType<typeof scopeFor>, ownTitle: string, otherTitle: string): Promise<PublicRootView> {
  // Both profiles intentionally share a cloud library. Its remote folders may
  // appear elsewhere in options; they must never become this profile's native
  // root controls or acquire its selected/private native identities.
  const view = await getRootView(page);
  const native = await page.evaluate(async ({ ownId, foreignTitle }) => {
    const visit = (nodes: chrome.bookmarks.BookmarkTreeNode[]): chrome.bookmarks.BookmarkTreeNode[] =>
      nodes.flatMap(node => [node, ...visit(node.children ?? [])]);
    const nodes = visit(await chrome.bookmarks.getTree());
    return { own: nodes.filter(node => node.id === ownId).map(node => ({ id: node.id, title: node.title })),
      foreign: nodes.filter(node => node.title === foreignTitle).map(node => ({ id: node.id, title: node.title })),
      nodes: nodes.map(node => ({ id: node.id, parentId: node.parentId })) };
  }, { ownId: fixture.selected, foreignTitle: otherTitle });
  const durable = await evidenceRequest(page, 'exportScope', scope);
  const related = await readStores(page, ['mount_bindings', 'bootstrap_runs', 'sync_engine', 'diagnostics']);
  const scoped = (name: string) => (related[name] ?? []).filter(row => row.scopeKey === durable.scope?.scopeKey);
  const mappings: Array<{ colpId: string; nativeId: string; rootNativeId: string; parentColpId?: string;
    rootRole?: string }> = durable.mappings;
  const ownMapping = mappings.find(row => row.nativeId === fixture.selected);
  // Collect all three independent views before any assertion can abort. Log
  // only fixture relationships/counts: no native ids, view tokens, titles or URLs.
  console.info('Profile root authority evidence', JSON.stringify({
    profile: scope.browserProfileId === profileBindings.a.browserProfileId ? 'a' : 'b',
    view: { status: view.status, own: view.roots.filter(row => row.title === ownTitle).map(({ kind, selected,
      privateLocal, depth }) => ({ kind, selected, privateLocal, depth })),
    foreign: view.roots.filter(row => row.title === otherTitle).map(({ kind, selected, privateLocal, depth }) =>
      ({ kind, selected, privateLocal, depth })) },
    native: { count: native.nodes.length, ownCount: native.own.length,
      foreign: native.foreign.map(row => {
        const mapping = mappings.find(item => item.nativeId === row.id);
        const parent = native.nodes.find(item => item.id === row.id)?.parentId;
        return { mapped: Boolean(mapping), selected: durable.scope?.selectedRoots.includes(mapping?.colpId),
          privateLocal: durable.scope?.privateRoots.includes(mapping?.colpId),
          parentIsOwn: parent === fixture.selected, parentIsOwnParent: parent !== undefined
            && parent === native.nodes.find(item => item.id === fixture.selected)?.parentId,
          sharesOwnCanonicalParent: mapping?.parentColpId !== undefined && mapping.parentColpId === ownMapping?.parentColpId,
          rootIsOwn: mapping?.rootNativeId === fixture.selected, role: mapping?.rootRole ?? null };
      }) },
    durable: { firstRun: durable.scope?.firstRun, rootStatus: durable.scope?.rootStatus,
      selectedCount: durable.scope?.selectedRoots.length, privateCount: durable.scope?.privateRoots.length,
      mappingCount: mappings.length, queueCount: durable.queue.length, receiptCount: durable.receipts.length,
      mounts: scoped('mount_bindings').map(row => ({ status: row.status, bound: row.remoteMountNodeId !== null,
        rootIsOwn: row.nativeRootId === fixture.selected, materialized: row.materialized, role: row.rootRole ?? null })),
      runs: scoped('bootstrap_runs').map(row => ({ phase: row.phase, retryReason: row.retryReason ?? null })),
      engine: scoped('sync_engine').map(row => ({ phase: row.phase, recoveryFrozen: row.recoveryFrozen,
        errorCode: row.lastError ?? null })),
      projections: scoped('diagnostics').filter(row => row.kind === 'projection_intent').map(row => ({ kind: row.intentKind, state: row.state,
        targetsForeign: native.foreign.some(item => mappings.some(mapping => mapping.nativeId === item.id && mapping.colpId === row.colpId)) })) },
  }));
  await expect(page.locator('#root-tree').getByText(otherTitle, { exact: true })).toHaveCount(0);
  expect(view.roots.some(row => row.title === otherTitle)).toBe(false);
  expect(view.roots.find(row => row.title === ownTitle)).toMatchObject({ selected: true, privateLocal: false });
  expect(native).toMatchObject({ own: [{ id: fixture.selected, title: ownTitle }], foreign: [] });
  expect(durable.scope).toMatchObject({ firstRun: 'completed', browserProfileId: scope.browserProfileId,
    replicaId: scope.replicaId, rootStatus: 'ready' });
  expect(mappings.filter(row => durable.scope.selectedRoots.includes(row.colpId)).map(row => row.nativeId))
    .toEqual([fixture.selected]);
  expect(mappings.filter(row => durable.scope.privateRoots.includes(row.colpId)).map(row => row.nativeId))
    .toEqual([fixture.privateRoot]);
  return view;
}
async function permissionState(page: Page) {
  return page.evaluate(() => chrome.permissions.contains({ permissions: ['bookmarks'] }));
}
async function expectPermission(page: Page, expected: boolean) {
  await expect.poll(() => permissionState(page)).toBe(expected);
}
async function getRootView(page: Page): Promise<PublicRootView> {
  const response = await page.evaluate(() => chrome.runtime.sendMessage({ kind: 'known.roots.get' })) as any;
  expect(response.ok).toBe(true); return response.view;
}
function scopeFor(binding: { replicaId: string; browserProfileId: string }): SyncScope {
  if (!stack) throw new Error('real stack unavailable');
  return { environment: 'production', serverId: 'https://known.example', serverOrigin: 'https://known.example',
    accountId: stack.authUserId, browserProfileId: binding.browserProfileId, collectionId: FIXTURE_COLLECTION_ID,
    replicaId: binding.replicaId, generation: 1 };
}
async function evidenceRequest(page: Page, method: string, scope: ReturnType<typeof scopeFor>): Promise<any> {
  const stores = method === 'exportArchive' ? ['retired_archives']
    : ['sync_scopes', 'native_mappings', 'outbound_queue', 'receipts', 'apply_intents'];
  const rows = await readStores(page, stores);
  if (method === 'exportArchive') {
    const archive = rows.retired_archives?.find((value) =>
      ['environment', 'serverId', 'accountId', 'browserProfileId', 'replicaId', 'generation']
        .every((key) => value[key] === scope[key as keyof typeof scope]));
    if (!archive) throw new Error('archive_not_found');
    return archive;
  }
  if (method !== 'exportScope') throw new Error('evidence_method_invalid');
  const current = rows.sync_scopes?.find((value) => matchesScope(value, scope));
  if (!current || typeof current.scopeKey !== 'string') {
    return { scope: null, mappings: [], queue: [], receipts: [], intents: [] };
  }
  const byScope = (name: string) => (rows[name] ?? []).filter((value) => value.scopeKey === current.scopeKey);
  return { scope: current, mappings: byScope('native_mappings'), queue: byScope('outbound_queue'),
    receipts: byScope('receipts'), intents: byScope('apply_intents') };
}
async function expectEvidenceFailure(page: Page, method: string, scope: ReturnType<typeof scopeFor>, error: string) {
  await expect(evidenceRequest(page, method, scope)).rejects.toThrow(error);
}
function matchesScope(value: Record<string, unknown>, scope: ReturnType<typeof scopeFor>) {
  return Object.entries(scope).every(([key, expected]) => value[key] === expected);
}
function privateAuthority(value: any) {
  const privateRoots = value.scope.privateRoots ?? [];
  return { privateRoots, mappings: (value.mappings ?? []).filter((mapping: any) => privateRoots.includes(mapping.colpId)) };
}
function assertAuthorityIsolation(left: any, right: any) {
  const rightScope = right.scope ?? {};
  const profiles = [right.browserProfileId, rightScope.browserProfileId]
    .filter((value): value is string => typeof value === 'string');
  for (const profile of profiles) expect(containsValue(left, profile)).toBe(false);
  const ownScope = left.scope ?? left;
  expect(ownScope.replicaId).not.toBe(rightScope.replicaId ?? right.replicaId);
  // Shared Collection Pull history legitimately names remote authors' replicaIds.
  // Every local durable row must still belong to this browser's own scope.
  const checkOwner = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (key === 'scopeKey') expect(child).toBe(ownScope.scopeKey);
      else checkOwner(child);
    }
  };
  checkOwner(left);
  for (const row of left.queue ?? []) {
    if (row.payload?.replicaId !== undefined) expect(row.payload.replicaId).toBe(ownScope.replicaId);
  }
}
function observe(context: BrowserContext, collected = { network: [] as string[], bodies: [] as string[], logs: [] as string[] }) {
  context.on('request', (request) => { collected.network.push(`${request.method()} ${request.url()}`);
    if (request.postData()) collected.bodies.push(request.postData()!); });
  context.on('console', (message) => collected.logs.push(message.text()));
  return collected;
}
function assertNoBookmarkDisclosure(evidence: ReturnType<typeof observe>, sentinels: string[], nativeIds: string[]) {
  const values = [...evidence.network, ...evidence.bodies, ...evidence.logs];
  for (const sentinel of sentinels) expect(values.some((value) => value.includes(sentinel))).toBe(false);
  for (const nativeId of nativeIds) expect(values.some((value) => containsJsonStringValue(value, nativeId))).toBe(false);
}
async function scanArtifacts(directory: string) {
  await execFileAsync(process.execPath, [resolve(import.meta.dirname, '../scripts/verify-bookmark-privacy-artifacts.mjs'), directory]);
}
function containsJsonStringValue(value: string, sensitive: string) {
  try { return containsValue(JSON.parse(value), sensitive); } catch { return false; }
}
function containsValue(value: unknown, sensitive: string): boolean {
  if (value === sensitive) return true;
  if (Array.isArray(value)) return value.some((item) => containsValue(item, sensitive));
  return Boolean(value && typeof value === 'object'
    && Object.values(value as Record<string, unknown>).some((item) => containsValue(item, sensitive)));
}
async function terminateExtensionWorker(context: BrowserContext, page: Page) {
  const session = await context.newCDPSession(page);
  try {
    const targets = await session.send('Target.getTargets');
    const worker = targets.targetInfos.find((target) => target.type === 'service_worker'
      && target.url.startsWith(`chrome-extension://${EXTENSION_ID}/`));
    if (!worker) throw new Error('extension worker target unavailable');
    const result = await session.send('Target.closeTarget', { targetId: worker.targetId });
    if (!result.success) throw new Error('extension worker termination failed');
  } finally { await session.detach(); }
}
