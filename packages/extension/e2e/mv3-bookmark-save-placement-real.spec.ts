import { grantOptionalBookmarks } from './bookmark-permission.js';
import { chromium, expect, test, type BrowserContext, type Page } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { startRealStack } from './real-stack.js';
import { openExtensionOptions } from './extension-auth.js';
import { KNS08_BINDINGS, confirmFirstRun, evidence, grantBookmarks, login, waitFirstRunProductQuiet } from './kns-08-harness.js';
import { FIXTURE_COLLECTION_ID } from './fixture-ids.js';

const extensionPath = resolve(import.meta.dirname, '../dist/production');
const COLLECTION_ID = FIXTURE_COLLECTION_ID;
test.use({ actionTimeout: 20_000 });

test('SP-07 G2 preserves save placement through PostgreSQL and a second browser profile', async ({}, testInfo) => {
  test.setTimeout(300_000);
  const stack = await startRealStack();
  const profileA = await mkdtemp(resolve(tmpdir(), 'known-placement-a-'));
  const profileB = await mkdtemp(resolve(tmpdir(), 'known-placement-b-'));
  let contextA: BrowserContext | undefined; let contextB: BrowserContext | undefined;
  try {
    contextA = await launch(profileA, stack.browserHostResolverRules);
    contextB = await launch(profileB, stack.browserHostResolverRules);
    let pageA = (await openExtensionOptions(contextA)).page;
    const pageB = (await openExtensionOptions(contextB)).page;
    await login(pageA, KNS08_BINDINGS[0]); await login(pageB, KNS08_BINDINGS[1]);
    await grantBookmarks(pageA); await grantBookmarks(pageB);
    const rootA = await configureRoot(pageA, stack, KNS08_BINDINGS[0]); const rootB = await configureRoot(pageB, stack, KNS08_BINDINGS[1]);
    const rootColpId = (await evidence<any>(pageA, 'exportOutboundPushEvidence')).mappings.find((row: any) => row.nativeId === rootA)!.colpId as string;
    await wakeUntilQuiet(pageA); await wakeUntilQuiet(pageB);
    await cacheSaveTarget(pageA, rootA); await cacheSaveTarget(pageB, rootB);

    await pageA.evaluate(async (parentId) => {
      await chrome.bookmarks.create({ parentId, title: 'G2 folder A' });
      await chrome.bookmarks.create({ parentId, title: 'G2 existing X', url: 'https://known.example/g2/existing-x' });
      await chrome.bookmarks.create({ parentId, title: 'G2 local browser page', url: 'chrome://settings/' });
      await chrome.bookmarks.create({ parentId, title: 'G2 folder B' });
      await chrome.bookmarks.create({ parentId, title: 'G2 existing Y', url: 'https://known.example/g2/existing-y' });
    }, rootA);
    await convergePush(pageA);

    await setPreference(pageA, 'top');
    await nativePageSave(pageA, contextA, 'https://known.example/g2/top'); await convergePush(pageA);
    await setPreference(pageA, 'bottom');
    await nativePageSave(pageA, contextA, 'https://known.example/g2/bottom'); await convergePush(pageA);
    await setPreference(pageA, 'top');
    await nativeWindowSave(pageA, contextA, [
      'https://known.example/g2/top-batch-1', 'https://known.example/g2/top-batch-2',
    ]); await convergePush(pageA);
    await setPreference(pageA, 'bottom');
    await nativeWindowSave(pageA, contextA, [
      'https://known.example/g2/bottom-batch-1', 'https://known.example/g2/bottom-batch-2',
    ]); await convergePush(pageA);

    // Capture a new parent and all children while the real sync transport is
    // unavailable; none of these nodes has an authoritative mapping yet.
    stack.setSyncOffline(true);
    const pendingFolder = await pageA.evaluate(parentId => chrome.bookmarks.create({
      parentId, title: 'G2 offline pending folder',
    }), rootA);
    await cacheSaveTarget(pageA, pendingFolder.id);
    await setPreference(pageA, 'top');
    await nativeWindowSave(pageA, contextA, [
      'https://known.example/g2/offline-1', 'https://known.example/g2/offline-2',
    ]);
    await evidence(pageA, 'drainBookmarkEventCaptureEvidence');
    const offlineState = await evidence<any>(pageA, 'exportOutboundPushEvidence');
    expect(offlineState.mappings.some((row: any) => row.nativeId === pendingFolder.id)).toBe(true);
    expect(offlineState.mappings.filter((row: any) => [pendingFolder.id,
      ...offlineState.mappings.filter((child: any) => child.parentNativeId === pendingFolder.id)
        .map((child: any) => child.nativeId)].includes(row.nativeId))
      .every((row: any) => row.colpId.startsWith('pending-'))).toBe(true);
    expect((await mappedOrder(pageA, pendingFolder.id)).native.map(row => row.url)).toEqual([
      'https://known.example/g2/offline-1', 'https://known.example/g2/offline-2',
    ]);
    stack.setSyncOffline(false);
    await pageA.evaluate(() => chrome.runtime.sendMessage({ kind: 'known.connectivity.online' }));
    await convergePush(pageA);
    await cacheSaveTarget(pageA, rootA);
    await setPreference(pageA, 'bottom');

    const beforeLost = Number((await stack.observations(KNS08_BINDINGS[0].replicaId)).serverMutationCount);
    await stack.commitAfterDisconnect();
    await nativePageSave(pageA, contextA, 'https://known.example/g2/lost-response');
    await expect.poll(async () => {
      await evidence(pageA, 'wakeDurableEngineEvidence').catch(() => undefined);
      return Number((await stack.observations(KNS08_BINDINGS[0].replicaId)).serverMutationCount);
    }, { timeout: 30_000 }).toBeGreaterThan(beforeLost);
    await expect.poll(async () => (await evidence<any>(pageA, 'exportOutboundPushEvidence'))
      .queue.some((row: any) => row.status === 'unknown'), { timeout: 30_000 }).toBe(true);
    const beforeRestart = await evidence<any>(pageA, 'exportOutboundPushEvidence');
    const unknown = beforeRestart.queue.find((row: any) => row.status === 'unknown');
    await contextA.close();
    contextA = await launch(profileA, stack.browserHostResolverRules);
    pageA = (await openExtensionOptions(contextA)).page;
    await stack.restorePushResponses();
    await convergePush(pageA);
    const afterRestart = await evidence<any>(pageA, 'exportOutboundPushEvidence');
    const replayed = afterRestart.queue.find((row: any) => row.opId === unknown.opId);
    expect(replayed).toMatchObject({ status: 'terminal', sequence: unknown.sequence,
      idempotencyKey: unknown.idempotencyKey, digest: unknown.digest });
    // Terminal compaction intentionally removes transport/anchor payload fields.
    // Compare the actual operation bodies observed by HTTP before/after restart.
    const replayObservations = await stack.observations(KNS08_BINDINGS[0].replicaId);
    const replayOperations = (replayObservations.pushRequests as Array<{ body: string }>)
      .flatMap(request => JSON.parse(request.body).operations as Array<{ opId: string }>)
      .filter(operation => operation.opId === unknown.opId);
    expect(replayOperations.length).toBeGreaterThanOrEqual(2);
    for (const operation of replayOperations) expect(operation).toEqual(replayOperations[0]);

    await setPreference(pageB, 'top');
    const server = await stack.canonicalSiblingOrder(rootColpId);
    await pullUntilOrder(pageB, rootB, server.map((row) => row.id));
    const parentMapping = (await evidence<any>(pageA, 'exportOutboundPushEvidence')).mappings
      .find((row: any) => row.nativeId === pendingFolder.id);
    const nestedServer = await stack.canonicalSiblingOrder(parentMapping.colpId);
    const bParent = (await evidence<any>(pageB, 'exportOutboundPushEvidence')).mappings
      .find((row: any) => row.colpId === parentMapping.colpId);
    await pullUntilOrder(pageB, bParent.nativeId, nestedServer.map(row => row.id));
    const nestedA = await mappedOrder(pageA, pendingFolder.id);
    const nestedB = await mappedOrder(pageB, bParent.nativeId);
    expect(nestedA.colpIds).toEqual(nestedServer.map(row => row.id));
    expect(nestedB.colpIds).toEqual(nestedA.colpIds);
    expect(nestedServer.map(row => row.url)).toEqual([
      'https://known.example/g2/offline-1', 'https://known.example/g2/offline-2',
    ]);
    const [orderA, orderB] = await Promise.all([mappedOrder(pageA, rootA), mappedOrder(pageB, rootB)]);
    expect(orderA.colpIds).toEqual(server.map((row) => row.id));
    expect(orderB.colpIds).toEqual(server.map((row) => row.id));
    expect(orderB.colpIds).toEqual(orderA.colpIds);
    expect(orderA.native.filter(row => row.url !== 'chrome://settings/')
      .every(row => row.colpId && !row.colpId.startsWith('pending-'))).toBe(true);
    expect(orderA.native.filter(row => row.url === 'chrome://settings/')).toHaveLength(1);
    expect(orderB.native.some(row => row.url === 'chrome://settings/')).toBe(false);
    expect(server.some(row => row.url === 'chrome://settings/')).toBe(false);
    expect(orderB.native.every(row => row.colpId && !row.colpId.startsWith('pending-'))).toBe(true);
    expect(orderA.native.map(row => row.url ?? row.title)).toEqual([
      'https://known.example/g2/top-batch-1', 'https://known.example/g2/top-batch-2',
      'https://known.example/g2/top', 'G2 folder A', 'https://known.example/g2/existing-x',
      'chrome://settings/', 'G2 folder B', 'https://known.example/g2/existing-y', 'https://known.example/g2/bottom',
      'https://known.example/g2/bottom-batch-1', 'https://known.example/g2/bottom-batch-2',
      'G2 offline pending folder', 'https://known.example/g2/lost-response',
    ]);
    expect(await pageB.evaluate(() => chrome.runtime.sendMessage({ kind: 'known.bookmark.preferences.local' })))
      .toMatchObject({ ok: true, preferences: { bookmarkInsertPosition: 'top' } });
    expect(orderA.native.filter((row) => row.url === 'https://known.example/g2/lost-response')).toHaveLength(1);
    expect(orderB.native.filter((row) => row.url === 'https://known.example/g2/lost-response')).toHaveLength(1);

    const [localA, localB, observations] = await Promise.all([
      evidence<any>(pageA, 'exportOutboundPushEvidence'),
      evidence<any>(pageB, 'exportOutboundPushEvidence'),
      stack.observations(KNS08_BINDINGS[0].replicaId),
    ]);
    expect(localA.queue.every((row: any) => row.status === 'terminal')).toBe(true);
    expect(localA.bookmarkEvents.every((row: any) => row.status === 'processed')).toBe(true);
    expect(localB.engine?.recoveryFrozen ?? false).toBe(false);
    expect(localB.queue.every((row: any) => row.status === 'terminal')).toBe(true);
    const settledMutations = observations.serverMutationCount;
    await evidence(pageA, 'wakeDurableEngineEvidence');
    await evidence(pageB, 'wakeDurableEngineEvidence');
    expect((await stack.observations(KNS08_BINDINGS[0].replicaId)).serverMutationCount).toBe(settledMutations);
    await testInfo.attach('g2-placement-authority', { contentType: 'application/json', body: JSON.stringify({
      server, orderA, orderB, nestedServer, nestedA, nestedB,
      replay: { before: unknown, after: replayed },
      profileA: { queue: localA.queue, receipts: localA.receipts, events: localA.bookmarkEvents },
      profileB: { queue: localB.queue, receipts: localB.receipts, pullEvents: localB.pullEvents },
      serverReceipts: (observations.sequenceReceipts as unknown[]).length,
      canonicalSiblingOrders: observations.canonicalSiblingOrders,
    }, null, 2) });
  } finally {
    await contextA?.close().catch(() => undefined); await contextB?.close().catch(() => undefined);
    await stack.close();
    await rm(profileA, { recursive: true, force: true }); await rm(profileB, { recursive: true, force: true });
  }
});

async function launch(profile: string, resolver: string): Promise<BrowserContext> {
  return chromium.launchPersistentContext(profile, { headless: false, channel: 'chromium', ignoreHTTPSErrors: true,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`,
      `--host-resolver-rules=${resolver}`, '--no-proxy-server', '--ignore-certificate-errors'] });
}

async function configureRoot(page: Page, stack: Awaited<ReturnType<typeof startRealStack>>, binding: typeof KNS08_BINDINGS[number]): Promise<string> {
  const bar = await page.evaluate(async () => (await chrome.bookmarks.getTree())[0]!.children![0]!.id);
  const title = await page.evaluate(async id => (await chrome.bookmarks.get(id))[0]!.title, bar);
  await confirmFirstRun(page, [title]); await waitFirstRunProductQuiet(page, stack, binding);
  return bar;
}

async function cacheSaveTarget(page: Page, parentNativeId: string): Promise<void> {
  await page.evaluate(({ collectionId, parentNativeId: parent }) => chrome.storage.local.set({
    'known.sync.collection.v1': collectionId,
    'known.sync.save-context.v1': { collectionId, parentNativeId: parent },
    'known.sync.folder.v1': { collectionId, folderNativeId: parent },
  }), { collectionId: COLLECTION_ID, parentNativeId });
}

async function setPreference(page: Page, position: 'top' | 'bottom'): Promise<void> {
  const result = await page.evaluate((bookmarkInsertPosition) => chrome.runtime.sendMessage({
    kind: 'known.bookmark.preferences.update', userGesture: true, bookmarkInsertPosition, foldersFirst: false,
  }), position) as { readonly ok?: boolean };
  expect(result.ok).toBe(true);
}

async function nativePageSave(page: Page, context: BrowserContext, url: string): Promise<void> {
  const tab = await openHttpTab(context, url); await tab.bringToFront();
  try {
    const result = await page.evaluate(() => chrome.runtime.sendMessage({
      kind: 'known.save.native', entry: 'page', userGesture: true,
    })) as { readonly ok?: boolean; readonly error?: string };
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
  } finally { await tab.close(); }
}

async function nativeWindowSave(page: Page, context: BrowserContext, urls: readonly string[]): Promise<void> {
  const tabs: Page[] = [];
  try {
    for (const url of urls) tabs.push(await openHttpTab(context, url));
    await tabs.at(-1)!.bringToFront();
    const opened = context.waitForEvent('page', candidate => candidate !== page && !tabs.includes(candidate));
    const result = await page.evaluate(() => chrome.runtime.sendMessage({ kind: 'known.save.native', entry: 'window', userGesture: true })) as { readonly ok?: boolean };
    expect(result).toMatchObject({ ok: true });
    const preview = await opened; await preview.waitForLoadState('domcontentloaded');
    if (!await preview.evaluate(() => chrome.permissions.contains({ permissions: ['tabs'] }))) {
      await grantOptionalBookmarks(preview, 'Allow tab access', 'Known tab preview', { permissions: ['tabs'] });
    }
    await expect(preview.locator('#tabs-allow-cloud')).toHaveCount(0);
    const selected = await page.evaluate(async () => (await chrome.storage.local.get('known.sync.folder.v1'))['known.sync.folder.v1']) as { folderNativeId: string };
    await preview.locator('#tabs-target').selectOption(selected.folderNativeId);
    await expect(preview.locator('#tabs-confirm')).toBeEnabled(); await preview.locator('#tabs-confirm').click();
    for (const url of urls) await expect.poll(() => page.evaluate(url => chrome.bookmarks.search({ url }), url)).toHaveLength(1);
    await preview.close();
  } finally { await Promise.all(tabs.map((tab) => tab.close())); }
}

async function openHttpTab(context: BrowserContext, url: string): Promise<Page> {
  const tab = await context.newPage();
  await tab.route('**/*', route => route.fulfill({ status: 200, contentType: 'text/html', body: `<title>${url}</title>` }));
  await tab.goto(url, { waitUntil: 'domcontentloaded' }); return tab;
}

async function convergePush(page: Page): Promise<void> {
  await evidence(page, 'drainBookmarkEventCaptureEvidence');
  await expect.poll(async () => {
    await evidence(page, 'wakeDurableEngineEvidence');
    let state: any;
    try { state = await evidence<any>(page, 'exportOutboundPushEvidence'); }
    catch (error) {
      const diagnostic = await page.evaluate(async () => ({
        auth: await chrome.runtime.sendMessage({ kind: 'known.auth.status' }).catch(() => null),
        local: await chrome.storage.local.get(['known.auth.binding.v1', 'known.sync.collection.v1']),
        sessionKeys: Object.keys(await chrome.storage.session.get(null)),
        scopes: await new Promise<unknown[]>((resolve) => {
          const request = indexedDB.open('known-phase3-indexeddb-entry');
          request.onerror = () => resolve([]);
          request.onsuccess = () => {
            const db = request.result;
            const tx = db.transaction('sync_scopes', 'readonly');
            const rows = tx.objectStore('sync_scopes').getAll();
            rows.onerror = () => resolve([]);
            rows.onsuccess = () => resolve((rows.result as Array<Record<string, unknown>>).map((row) => ({
              lifecycle: row.lifecycle, accountId: row.accountId, collectionId: row.collectionId,
              replicaId: row.replicaId, generation: row.generation,
            })));
          };
        }),
      }));
      throw new Error(`placement_scope_lost:${JSON.stringify(diagnostic)}`, { cause: error });
    }
    const live = state.queue.filter((row: any) => !['terminal', 'rejected'].includes(row.status));
    const pendingEvents = state.bookmarkEvents.filter((row: any) => row.status !== 'processed');
    return { live: live.length, pendingEvents: pendingEvents.length, frozen: state.engine?.recoveryFrozen ?? false };
  }, { timeout: 45_000 }).toEqual({ live: 0, pendingEvents: 0, frozen: false });
}

async function wakeUntilQuiet(page: Page): Promise<void> {
  await expect.poll(async () => {
    await evidence(page, 'wakeDurableEngineEvidence');
    return (await evidence<any>(page, 'syncEngineState')).phase;
  }, { timeout: 30_000 }).toMatch(/sleeping|idle/u);
}

async function pullUntilOrder(page: Page, rootNativeId: string, expected: readonly string[]): Promise<void> {
  await expect.poll(async () => {
    await evidence(page, 'pullNowEvidence').catch(() => undefined);
    await evidence(page, 'wakeDurableEngineEvidence').catch(() => undefined);
    return (await mappedOrder(page, rootNativeId)).colpIds;
  }, { timeout: 60_000 }).toEqual(expected);
}

async function mappedOrder(page: Page, rootNativeId: string): Promise<{
  readonly colpIds: readonly string[];
  readonly native: readonly { readonly id: string; readonly title: string; readonly url?: string; readonly colpId?: string }[];
}> {
  return page.evaluate(async (parentId) => {
    const children = await chrome.bookmarks.getChildren(parentId);
    const state = await chrome.runtime.sendMessage({ kind: 'known.sync-state.evidence',
      method: 'exportOutboundPushEvidence', args: [] }) as any;
    const mappings = new Map((state.value?.mappings ?? []).map((row: any) => [row.nativeId, row.colpId]));
    const native = children.map((node) => { const colpId = mappings.get(node.id); return { id: node.id, title: node.title,
      ...(node.url ? { url: node.url } : {}), ...(typeof colpId === 'string' ? { colpId } : {}) }; });
    return { native, colpIds: native.flatMap((node) => typeof node.colpId === 'string'
      && !node.colpId.startsWith('pending-') ? [node.colpId] : []) };
  }, rootNativeId);
}
