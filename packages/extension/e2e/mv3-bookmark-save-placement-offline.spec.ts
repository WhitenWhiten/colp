import { chromium, expect, test, type BrowserContext, type Page } from '@playwright/test';
import { resolve } from 'node:path';
import { startRealStack, type RealStack } from './real-stack.js';
import { openExtensionOptions } from './extension-auth.js';
import { FIXTURE_COLLECTION_ID } from './fixture-ids.js';
import { grantOptionalBookmarks } from './bookmark-permission.js';

const extensionPath = resolve(import.meta.dirname, '../dist/production');
const INSERT_CACHE = 'known.sync.save-context.v1';
const COLLECTION_CACHE = 'known.sync.collection.v1';
test.setTimeout(300_000);


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

async function children(page: Page, parentId: string): Promise<readonly chrome.bookmarks.BookmarkTreeNode[]> {
  return page.evaluate((id) => chrome.bookmarks.getChildren(id), parentId);
}

function slim(node: chrome.bookmarks.BookmarkTreeNode): Record<string, unknown> {
  return { id: node.id, title: node.title, url: node.url ?? null, index: node.index };
}

async function openHttpTab(context: BrowserContext, url: string): Promise<Page> {
  const page = await context.newPage();
  await page.route('**/*', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: `<title>${url}</title>` }));
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  return page;
}
