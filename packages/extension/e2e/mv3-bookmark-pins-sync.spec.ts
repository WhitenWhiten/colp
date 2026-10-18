import { chromium, expect, test, type BrowserContext, type Page } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { startRealStack } from './real-stack.js';
import { grantOptionalBookmarks } from './bookmark-permission.js';
import { installFixtureReplicaBinding, openExtensionOptions, chooseLibraryMetadata, waitForLibraryBinding, signInExtension, showOptionsPane } from './extension-auth.js';
import { FIXTURE_COLLECTION_ID } from './fixture-ids.js';

const extensionPath = resolve(import.meta.dirname, '../dist/production');
const PIN = 'https://known.example/extensions/bookmark-pin-v1';
const FIRST = 'https://example.test/pins/first';
const SECOND = 'https://example.test/pins/second';

/**
 * Two browsers on one collection, with browser metadata sync on, against the real backend: a pin set on A reaches
 * the server and B (flag and order), and an unpin made on B, which moves nothing,
 * still uploads without any other change waking sync, and reaches A.
 */
test('a pin travels from one browser to the server and the other browser, and back', async () => {
  test.setTimeout(180_000); const stack = await startRealStack();
  const profileA = await mkdtemp(resolve(tmpdir(), 'known-pins-profileA-'));
  const profileB = await mkdtemp(resolve(tmpdir(), 'known-pins-profileB-'));
  const contextA = await launch(profileA, stack.browserHostResolverRules); let contextB: BrowserContext | undefined;
  try {
    const pageA = await extensionPage(contextA); await login(pageA, stack.extensionBindings[0]); await grantBookmarks(pageA, 'A');
    contextB = await launch(profileB, stack.browserHostResolverRules);
    const pageB = await extensionPage(contextB); await login(pageB, stack.extensionBindings[1]); await grantBookmarks(pageB, 'B');
    const rootA = await evidence<string>(pageA, 'configureDurableEngineEvidence', await barOf(pageA));
    const rootB = await evidence<string>(pageB, 'configureDurableEngineEvidence', await barOf(pageB));
    await wakeUntilSleeping(pageA); await wakeUntilSleeping(pageB);
    await topOfFolder(pageA); await topOfFolder(pageB);

    for (const [title, url] of [['First', FIRST], ['Second', SECOND]]) {
      await pageA.evaluate(({ parentId, title, url }) => chrome.bookmarks.create({ parentId, title, url }), { parentId: rootA, title, url });
    }
    await expect.poll(async () => { await evidence(pageB, 'wakeDurableEngineEvidence'); return urlsIn(pageB, rootB); },
      { timeout: 60_000 }).toEqual([FIRST, SECOND]);

    // A pins the second bookmark: it moves above the first, and both the flag and the order sync.
    const secondA = await idOf(pageA, rootA, SECOND);
    expect(await setPin(pageA, secondA, true)).toEqual({ ok: true, blockers: [] });
    expect(await urlsIn(pageA, rootA)).toEqual([SECOND, FIRST]);
    try { await expect.poll(() => stack.canonicalBookmarkExtensions(SECOND), { timeout: 30_000 }).toEqual([{ [PIN]: { pinned: true } }]); }
    catch (error) { throw new Error(`pin_upload_timeout:${JSON.stringify(await diagnose(pageA, secondA, stack))}`, { cause: error }); }
    await expect.poll(async () => {
      await evidence(pageB, 'wakeDurableEngineEvidence');
      const secondB = await idOf(pageB, rootB, SECOND);
      return { order: await urlsIn(pageB, rootB), pinned: secondB ? await pinnedIn(pageB, secondB) : false };
    }, { timeout: 60_000 }).toEqual({ order: [SECOND, FIRST], pinned: true });

    // B unpins it. It is already the first unpinned bookmark, so nothing moves and only
    // the pin change itself can wake B's sync: B's engine is idle first, there is no
    // manual wake from here, and the window is shorter than MV3's 30s alarm floor.
    const secondB = await idOf(pageB, rootB, SECOND);
    await expect.poll(async () => (await evidence<{ engineWakeInFlight: boolean }>(pageB, 'syncEngineState')).engineWakeInFlight,
      { timeout: 30_000 }).toBe(false);
    expect(await setPin(pageB, secondB, false)).toEqual({ ok: true, blockers: [] });
    expect(await urlsIn(pageB, rootB)).toEqual([SECOND, FIRST]);
    await expect.poll(() => stack.canonicalBookmarkExtensions(SECOND), { timeout: 10_000 }).toEqual([{}]);
    await expect.poll(async () => { await evidence(pageA, 'wakeDurableEngineEvidence'); return pinnedIn(pageA, secondA); },
      { timeout: 60_000 }).toBe(false);
  } finally {
    await contextA.close(); await contextB?.close(); await stack.close();
    await rm(profileA, { recursive: true, force: true }); await rm(profileB, { recursive: true, force: true });
  }
});

async function launch(profile: string, browserHostResolverRules: string) {
  return chromium.launchPersistentContext(profile, { headless: false, channel: 'chromium', ignoreHTTPSErrors: true,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`,
      `--host-resolver-rules=${browserHostResolverRules}`, '--no-proxy-server', '--ignore-certificate-errors'] });
}
async function extensionPage(context: BrowserContext) { return (await openExtensionOptions(context)).page; }
async function login(page: Page, binding: import('./real-stack.js').FixtureReplicaBinding) {
  await installFixtureReplicaBinding(page, binding);
  await page.evaluate(collection => chrome.storage.local.set({ 'known.sync.collection.v1': collection }), FIXTURE_COLLECTION_ID);
  await signInExtension(page);
}
async function grantBookmarks(page: Page, suffix: string) {
  await showOptionsPane(page, 'folders');
  await grantOptionalBookmarks(page, 'Allow bookmark access', `Known pins ${suffix}`);
  await expect.poll(() => page.evaluate(() => chrome.permissions.contains({ permissions: ['bookmarks'] }))).toBe(true);
  // Pins sync with tags and notes, which only leave the browser after this consent.
  await waitForLibraryBinding(page, FIXTURE_COLLECTION_ID);
  await chooseLibraryMetadata(page, 'sync');
}
async function barOf(page: Page) { return (await page.evaluate(() => chrome.bookmarks.getTree()))[0]!.children![0]!.id; }
async function topOfFolder(page: Page) {
  expect(await page.evaluate(() => chrome.runtime.sendMessage({ kind: 'known.bookmark.preferences.update', userGesture: true,
    bookmarkInsertPosition: 'top', foldersFirst: true }))).toMatchObject({ ok: true });
}
async function evidence<T = unknown>(page: Page, method: string, ...args: unknown[]): Promise<T> {
  const result = await page.evaluate(({ method, args }) => chrome.runtime.sendMessage({ kind: 'known.sync-state.evidence', method, args }),
    { method, args }) as { ok: boolean; value?: T; error?: string };
  if (!result.ok) throw new Error(result.error); return result.value as T;
}
async function wakeUntilSleeping(page: Page) {
  await expect.poll(async () => { await evidence(page, 'wakeDurableEngineEvidence');
    return (await evidence<{ phase: string }>(page, 'syncEngineState')).phase; }, { timeout: 30_000 }).toBe('sleeping');
}
async function urlsIn(page: Page, parentId: string) {
  return page.evaluate(async id => (await chrome.bookmarks.getChildren(id)).flatMap(node => node.url ? [node.url] : []), parentId);
}
async function idOf(page: Page, parentId: string, url: string) {
  return page.evaluate(async ({ id, url }) => (await chrome.bookmarks.getChildren(id)).find(node => node.url === url)?.id ?? '',
    { id: parentId, url });
}
async function setPin(page: Page, nativeId: string, pinned: boolean) {
  return page.evaluate(({ nativeId, pinned }) => chrome.runtime.sendMessage({ kind: 'known.bookmarks.pin.set', userGesture: true,
    nativeId, pinned }), { nativeId, pinned });
}
/** Reads the pin flag from the browser's own annotation row; never creates the database. */
async function pinnedIn(page: Page, nativeId: string) {
  return page.evaluate(async id => {
    if (!(await indexedDB.databases()).some(database => database.name === 'known-bookmark-annotations')) return false;
    return new Promise<boolean>((resolve, reject) => {
      const open = indexedDB.open('known-bookmark-annotations');
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const db = open.result;
        if (!db.objectStoreNames.contains('bookmarks')) { db.close(); resolve(false); return; }
        const read = db.transaction('bookmarks').objectStore('bookmarks').get(id);
        read.onsuccess = () => { db.close(); resolve(read.result?.pinned === true && read.result.removedAt === undefined); };
        read.onerror = () => { db.close(); reject(read.error); };
      };
    });
  }, nativeId);
}

async function diagnose(page: Page, nativeId: string, stack: Awaited<ReturnType<typeof startRealStack>>) {
  const row = await page.evaluate(async id => new Promise<unknown>((resolve) => {
    const open = indexedDB.open('known-bookmark-annotations');
    open.onsuccess = () => { const read = open.result.transaction('bookmarks').objectStore('bookmarks').get(id);
      read.onsuccess = () => { open.result.close(); resolve(read.result); }; };
  }), nativeId);
  const state = await evidence<any>(page, 'exportOutboundPushEvidence');
  const engine = await evidence<any>(page, 'syncEngineState');
  return { row, engine, server: await stack.canonicalBookmarkExtensions(SECOND),
    mapping: state.mappings.find((item: any) => item.nativeId === nativeId),
    queue: state.queue.map((item: any) => ({ status: item.status, type: item.payload?.type, payload: item.payload?.payload, result: item.result })),
    events: state.bookmarkEvents?.slice(-6) };
}
