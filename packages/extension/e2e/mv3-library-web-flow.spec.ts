import { chromium, expect, test, type BrowserContext } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { startRealStack } from './real-stack.js';
import { openExtensionOptions, showOptionsPane, signInExtension, EXTENSION_FIXTURE_EMAIL, EXTENSION_FIXTURE_PASSWORD } from './extension-auth.js';
import { grantOptionalBookmarks } from './bookmark-permission.js';
import { grantTabAccess, openPopupOver } from './popup-page.js';

const extension = resolve(import.meta.dirname, '../dist/production');
test.use({ actionTimeout: 15_000, navigationTimeout: 20_000 });
test('one library works across the real web, extension, local exclusions, saves and anonymous shares', async () => {
  test.setTimeout(300_000);
  const stack = await startRealStack({ web: true, freshLibrary: true }), profile = await mkdtemp(resolve(tmpdir(), 'known-library-web-'));
  let context: BrowserContext | undefined;
  let guest: BrowserContext | undefined;
  try {
    expect((await stack.observations()).libraryCount).toBe(0);
    const args = [`--host-resolver-rules=${stack.browserHostResolverRules}`, '--no-proxy-server', '--ignore-certificate-errors'];
    context = await chromium.launchPersistentContext(profile, { headless: false, channel: 'chromium', ignoreHTTPSErrors: true,
      args: [...args, `--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
    const web = await context.newPage();
    await web.goto(stack.serverOrigin + '/login');
    await web.getByLabel('Username or email').fill(EXTENSION_FIXTURE_EMAIL);
    await web.getByLabel('Password', { exact: true }).fill(EXTENSION_FIXTURE_PASSWORD);
    await web.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(web).toHaveURL(/\/library/);
    const nav = web.getByTestId('library-nav');
    await expect(nav.getByRole('link', { name: /Bookmarks bar/ })).toBeVisible();
    await expect(nav.getByRole('link', { name: /Other bookmarks/ })).toBeVisible();
    await expect(web.getByTestId('library-main')).toContainText('0 bookmarks');
    const created = await stack.observations();
    expect(created.libraryCount).toBe(1);
    const initialRoles = created.canonicalNodes as Array<{ id: string; folder_role: string | null }>;
    expect(initialRoles).toHaveLength(3);
    const barId = initialRoles.find(node => node.folder_role === 'bookmarks-bar')!.id;
    const otherId = initialRoles.find(node => node.folder_role === 'other-bookmarks')!.id;
    const { page } = await openExtensionOptions(context);
    await showOptionsPane(page, 'bookmarks');
    await grantOptionalBookmarks(page, page.locator('#manager-grant'), 'Library web acceptance');
    const native = await page.evaluate(async () => {
      const roots = (await chrome.bookmarks.getTree())[0]!.children!;
      const bar = roots.find(node => node.id === '1')!, other = roots.find(node => node.id === '2')!;
      const folder = await chrome.bookmarks.create({ parentId: bar.id, title: 'Keep on this browser' });
      await chrome.bookmarks.create({ parentId: folder.id, title: 'Local copy', url: 'https://example.test/local-copy' });
      await chrome.bookmarks.create({ parentId: other.id, title: 'From browser', url: 'https://example.test/from-browser' });
      return { bar: bar.id, other: other.id, privateFolder: folder.id };
    });
    await showOptionsPane(page, 'account');
    if (await page.locator('#login-email').isVisible()) await signInExtension(page, stack.collectionId);
    else await expect(page.locator('body')).toHaveAttribute('data-state', 'connected');
    console.info('library-flow: account and library connected');
    await showOptionsPane(page, 'folders');
    await expect(page.locator('#folder-heading')).toContainText("Sync this browser's bookmarks with");
    await expect(page.locator('#first-run-start')).toBeEnabled();
    await page.locator('#first-run-start').click();
    await expect.poll(() => page.evaluate(async () => (await chrome.runtime.sendMessage({ kind: 'known.firstRun.status' }) as { firstRun?: string }).firstRun), { timeout: 90_000 }).toBe('completed');
    console.info('library-flow: first sync completed');
    const roles = (await stack.observations()).canonicalNodes as Array<{ folder_role: string | null; deleted_at: string | null }>;
    for (const role of ['bookmarks-bar', 'other-bookmarks']) expect(roles.filter(node => node.folder_role === role && node.deleted_at === null)).toHaveLength(1);
    await web.goto(stack.serverOrigin + '/library?folder=' + encodeURIComponent(barId)); await expect(nav.getByRole('link', { name: /Keep on this browser/ })).toBeVisible();
    await web.goto(stack.serverOrigin + '/library?folder=' + encodeURIComponent(otherId));
    await expect(web.getByText('From browser', { exact: true })).toBeVisible();
    // Review explicitly chooses the existing cloud-trash option; the native copy stays put.
    const privateRow = page.locator('.root-row').filter({ has: page.locator('.folder-name', { hasText: 'Keep on this browser' }) });
    await privateRow.locator('.root-select input').uncheck();
    await page.locator('#save-roots').click();
    await expect(page.locator('#range-preview')).toBeVisible();
    await page.locator('#range-remote-delete').check();
    await page.locator('#range-confirm').click();
    await expect(page.locator('#range-preview')).toBeHidden();
    await expect.poll(async () => ((await stack.observations()).canonicalNodes as Array<{ title: string; deleted_at: string | null }>).some(node => node.title === 'Keep on this browser' && node.deleted_at === null), { timeout: 45_000 }).toBe(false);
    expect(await page.evaluate(async id => (await chrome.bookmarks.getSubTree(id))[0]?.children?.length, native.privateFolder)).toBe(1);
    await web.goto(stack.serverOrigin + '/library');
    await expect(nav.getByRole('link', { name: /Keep on this browser/ })).toHaveCount(0);
    console.info('library-flow: excluded folder trashed remotely and retained locally');
    // A web create reaches Chrome through the ordinary sync poll.
    await nav.getByRole('link', { name: /Bookmarks bar/ }).click();
    await nav.getByRole('button', { name: 'New folder', exact: true }).click();
    await web.locator('#lc-title').fill('Web to browser');
    await web.getByTestId('library-compose').getByRole('button', { name: 'Create folder', exact: true }).click();
    const webFolder = web.locator('[data-folder-actions]', { hasText: 'Web to browser' });
    await expect(webFolder).toBeVisible();
    const remoteFolderId = new URL((await webFolder.getByRole('link').first().getAttribute('href'))!, stack.serverOrigin).searchParams.get('folder')!;
    await expect.poll(() => page.evaluate(() => chrome.bookmarks.search({ title: 'Web to browser' }).then(nodes => nodes.length)), { timeout: 60_000 }).toBe(1);
    const nativeWebFolder = await page.evaluate(() => chrome.bookmarks.search({ title: 'Web to browser' }).then(nodes => nodes[0]!.id));
    console.info('library-flow: web-created folder arrived in browser');
    // The popup chooses its destination explicitly, then the web observes the save.
    await grantTabAccess(context);
    const source = await context.newPage(); await source.goto(stack.serverOrigin + '/index.html');
    const popup = await openPopupOver(context, source);
    await expect(popup.locator('#dest-toggle')).toBeVisible();
    await expect(popup.locator('#dest-panel')).toBeVisible();
    await expect(popup.locator('#dest-toggle')).toHaveAttribute('aria-expanded', 'true');
    await popup.getByRole('searchbox', { name: 'Search folders' }).fill('Keep on this browser');
    await popup.locator(`[data-folder-id="${native.privateFolder}"]`).first().click();
    await expect(popup.getByText('This folder stays on this browser', { exact: false })).toBeVisible();
    await expect(popup.getByRole('button', { name: 'Sync it…', exact: true })).toBeVisible();
    await popup.locator('#dest-toggle').click();
    await popup.getByRole('searchbox', { name: 'Search folders' }).fill('Web to browser');
    await popup.locator(`[data-folder-id="${nativeWebFolder}"]`).first().click();
    await popup.locator('#tab-title').fill('Saved from popup');
    await popup.locator('#tab-url-display').click(); await popup.locator('#tab-url').fill('https://example.test/popup-library');
    await popup.getByRole('button', { name: 'Save', exact: true }).click();
    await expect.poll(async () => ((await stack.observations()).canonicalNodes as Array<{ title: string; parent_id: string }>).some(node => node.title === 'Saved from popup' && node.parent_id === remoteFolderId), { timeout: 45_000 }).toBe(true);
    console.info('library-flow: popup save arrived on server');
    await web.goto(stack.serverOrigin + '/library?folder=' + encodeURIComponent(remoteFolderId));
    await expect(web.getByText('Saved from popup', { exact: true })).toBeVisible();
    await nav.getByRole('link', { name: /Bookmarks bar/ }).click();
    await web.locator('[data-folder-actions]', { hasText: 'Web to browser' }).getByRole('button', { name: 'Actions for Web to browser', exact: true }).click();
    await web.getByRole('menuitem', { name: 'Share…', exact: true }).click();
    const dialog = web.getByRole('dialog', { name: 'Share Web to browser' });
    await dialog.getByRole('button', { name: 'Create link', exact: true }).click();
    const link = await dialog.getByRole('link', { name: 'Open link', exact: true }).getAttribute('href');
    const visitorBrowser = await chromium.launch({ headless: false, channel: 'chromium', args });
    guest = await visitorBrowser.newContext({ ignoreHTTPSErrors: true });
    try {
      const visitor = await guest.newPage(); await visitor.goto(link!);
      await expect(visitor.getByRole('heading', { name: 'Web to browser', exact: true })).toBeVisible();
      await expect(visitor.getByText('Saved from popup', { exact: true })).toBeVisible();
      await expect(visitor.getByText('From browser', { exact: true })).toHaveCount(0);
      await expect(visitor.getByText('Local copy', { exact: true })).toHaveCount(0);
      await visitor.screenshot({ path: '/tmp/colp-real-shared-folder.png', fullPage: true });
      await dialog.getByRole('button', { name: 'Stop sharing', exact: true }).click();
      await expect(dialog.getByRole('button', { name: 'Create link', exact: true })).toBeVisible();
      await visitor.reload(); await expect(visitor.getByRole('heading', { name: 'Link unavailable', exact: true })).toBeVisible();
    } finally { await guest.close(); guest = undefined; await visitorBrowser.close(); }
    console.info('library-flow: anonymous share and revocation verified');
    // Including the trashed folder again uploads fresh identities, preserving the native tree.
    await showOptionsPane(page, 'folders'); await page.locator('#refresh-roots').click();
    await privateRow.locator('.root-select input').check();
    await page.locator('#save-roots').click(); await page.locator('#range-confirm').click();
    await expect.poll(async () => ((await stack.observations()).canonicalNodes as Array<{ title: string; deleted_at: string | null }>).filter(node => node.title === 'Keep on this browser' && node.deleted_at === null).length, { timeout: 45_000 }).toBe(1);
    expect(await page.evaluate(async id => (await chrome.bookmarks.getSubTree(id))[0]?.children?.length, native.privateFolder)).toBe(1);
    // The preceding inclusion can still change mapping evidence after the folder appears remotely.
    // Wait for its queue to settle before reviewing a new whole-root exclusion.
    await expect.poll(async () => {
      const reply = await page.evaluate(() => chrome.runtime.sendMessage({ kind: 'known.sync-state.evidence', method: 'exportOutboundPushEvidence', args: [] })) as {
        ok: boolean; value?: { engine?: { phase?: string }; queue?: { status: string }[] };
      };
      return reply.ok && reply.value?.engine?.phase === 'sleeping' && reply.value.queue?.every(row => row.status === 'terminal');
    }, { timeout: 60000 }).toBe(true);
    await page.locator('#refresh-roots').click();
    await expect(page.locator('#refresh-roots')).toBeEnabled();
    const otherRow = page.locator('.root-row[data-depth="0"]').filter({ has: page.locator('.folder-name', { hasText: 'Other bookmarks' }) });
    await otherRow.locator('.root-select input').uncheck();
    await page.locator('#save-roots').click();
    await expect(page.locator('#range-preview')).toContainText('Other bookmarks');
    await page.locator('#range-remote-delete').check();
    await page.locator('#range-confirm').click();
    await expect(page.locator('#range-preview')).toBeHidden();
    await expect(page.locator('#root-feedback')).toHaveText('Folder settings saved');
    await expect.poll(async () => ((await stack.observations()).canonicalNodes as Array<{ title: string; deleted_at: string | null }>).some(node => node.title === 'From browser' && node.deleted_at === null), { timeout: 45_000 }).toBe(false);
    expect(await page.evaluate(() => chrome.bookmarks.search({ title: 'From browser' }).then(nodes => nodes.length))).toBe(1);
    const afterRootExclusion = (await stack.observations()).canonicalNodes as Array<{ id: string; deleted_at: string | null }>;
    for (const id of [barId, otherId]) expect(afterRootExclusion.find(node => node.id === id)?.deleted_at).toBeNull();
  } finally { await guest?.close(); await context?.close(); await stack.close(); await rm(profile, { recursive: true, force: true }); }
});
