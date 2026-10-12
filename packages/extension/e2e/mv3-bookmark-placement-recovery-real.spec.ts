import { chromium, expect, test, type BrowserContext, type Page } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { startRealStack } from './real-stack.js';
import { openExtensionOptions, showOptionsPane } from './extension-auth.js';
import { evidence, grantBookmarks, login } from './kns-08-harness.js';
import { FIXTURE_COLLECTION_ID } from './fixture-ids.js';

const extensionPath = resolve(import.meta.dirname, '../dist/production');
const COLLECTION_ID = FIXTURE_COLLECTION_ID;
const ROOT_COLP_ID = 'p3-27-root';

for (const scenario of [
  { position: 'top', mutation: 'move' },
  { position: 'bottom', mutation: 'delete' },
] as const) {
  test(`SP-07 R-04 ${scenario.position} save survives remote anchor ${scenario.mutation} and insertion`, async ({}, testInfo) => {
    test.setTimeout(300_000);
    const stack = await startRealStack();
    const profileA = await mkdtemp(resolve(tmpdir(), 'known-placement-recovery-a-'));
    const profileB = await mkdtemp(resolve(tmpdir(), 'known-placement-recovery-b-'));
    let contextA: BrowserContext | undefined; let contextB: BrowserContext | undefined;
    const savedUrl = `https://known.example/g2/recovery/${scenario.mutation}`;
    try {
      contextA = await launch(profileA, stack.browserHostResolverRules);
      contextB = await launch(profileB, stack.browserHostResolverRules);
      let pageA = (await openExtensionOptions(contextA)).page;
      const pageB = (await openExtensionOptions(contextB)).page;
      await login(pageA, stack.extensionBindings[0]); await login(pageB, stack.extensionBindings[1]);
      await grantBookmarks(pageA); await grantBookmarks(pageB);
      const rootA = await configureRoot(pageA); const rootB = await configureRoot(pageB);
      await wakeUntilQuiet(pageA); await wakeUntilQuiet(pageB);
      await cacheSaveTarget(pageA, rootA);
      await pageA.evaluate(async (parentId) => {
        await chrome.bookmarks.create({ parentId, title: 'R04 first', url: 'https://known.example/r04/first' });
        await chrome.bookmarks.create({ parentId, title: 'R04 destination' });
        await chrome.bookmarks.create({ parentId, title: 'R04 last', url: 'https://known.example/r04/last' });
      }, rootA);
      await convergePush(pageA);
      const initialServer = await stack.canonicalSiblingOrder(ROOT_COLP_ID);
      await pullUntilOrder(pageB, rootB, initialServer.map((node) => node.id));
      const anchor = scenario.position === 'top' ? initialServer[0]! : initialServer.at(-1)!;
      const destination = initialServer.find((node) => node.title === 'R04 destination')!;
      expect(anchor.url).toBeTruthy(); expect(destination).toBeDefined();
      await setPreference(pageA, scenario.position);

      // Block real sync sockets, capture the frozen save intent, then stop A entirely.
      // B can subsequently commit while no Pull or retry in A can observe that change.
      stack.setSyncOffline(true);
      await nativePageSave(pageA, contextA, savedUrl);
      await evidence(pageA, 'drainBookmarkEventCaptureEvidence');
      const savedQueue = async () => (await evidence<any>(pageA, 'exportOutboundPushEvidence')).queue
        .find((row: any) => row.payload?.type === 'create_node' && row.payload.payload?.node?.url === savedUrl);
      await expect.poll(async () => Boolean(await savedQueue()), { timeout: 15_000 }).toBe(true);
      const queued = await savedQueue();
      expect(queued.status).not.toBe('terminal');
      expect(queued.payload.payload[scenario.position === 'top' ? 'beforeId' : 'afterId']).toBe(anchor.id);
      const localBefore = await mappedOrder(pageA, rootA);
      const savedNative = localBefore.native.find((node) => node.url === savedUrl)!;
      expect(savedNative).toBeDefined();
      expect((scenario.position === 'top' ? localBefore.native[0] : localBefore.native.at(-1))?.id)
        .toBe(savedNative.id);
      await contextA.close(); contextA = undefined;
      stack.setSyncOffline(false);

      const bBefore = await mappedOrder(pageB, rootB);
      const anchorNative = bBefore.native.find((node) => node.colpId === anchor.id)!.id;
      const destinationNative = bBefore.native.find((node) => node.colpId === destination.id)!.id;
      await pageB.evaluate(async ({ anchorId, destinationId, mutation, parentId, position }) => {
        if (mutation === 'move') await chrome.bookmarks.move(anchorId, { parentId: destinationId });
        else await chrome.bookmarks.remove(anchorId);
        await chrome.bookmarks.create({ parentId, title: 'R04 concurrent insertion',
          url: 'https://known.example/r04/concurrent', ...(position === 'top' ? { index: 0 } : {}) });
      }, { anchorId: anchorNative, destinationId: destinationNative, mutation: scenario.mutation,
        parentId: rootB, position: scenario.position });
      await pageB.evaluate(() => chrome.runtime.sendMessage({ kind: 'known.connectivity.online' }));
      await convergePush(pageB);
      const changedServer = await stack.canonicalSiblingOrder(ROOT_COLP_ID);
      expect(changedServer.some((node) => node.id === anchor.id)).toBe(false);
      expect(changedServer.some((node) => node.url === 'https://known.example/r04/concurrent')).toBe(true);
      if (scenario.mutation === 'move') {
        expect((await stack.canonicalSiblingOrder(destination.id)).map((node) => node.id)).toEqual([anchor.id]);
      } else {
        expect((await stack.listDeletedCanonicalNodes()).some((node) => node.id === anchor.id)).toBe(true);
      }

      contextA = await launch(profileA, stack.browserHostResolverRules);
      pageA = (await openExtensionOptions(contextA)).page;
      // A browser restart drops session credentials, but must preserve queued operation identity.
      const retained = (await evidence<any>(pageA, 'exportOutboundPushEvidence')).queue
        .find((row: any) => row.opId === queued.opId);
      expect(retained).toMatchObject({ opId: queued.opId, sequence: queued.sequence });
      await pageA.evaluate(() => chrome.runtime.sendMessage({ kind: 'known.connectivity.online' }));
      await convergePush(pageA);
      const server = await stack.canonicalSiblingOrder(ROOT_COLP_ID);
      const saved = server.filter((node) => node.url === savedUrl);
      expect(saved).toHaveLength(1);
      expect(server.map((node) => node.id)).toEqual(scenario.position === 'top'
        ? [saved[0]!.id, ...changedServer.map((node) => node.id)]
        : [...changedServer.map((node) => node.id), saved[0]!.id]);
      await pullUntilOrder(pageA, rootA, server.map((node) => node.id));
      await pullUntilOrder(pageB, rootB, server.map((node) => node.id));
      const [orderA, orderB, stateA, stateB, observations] = await Promise.all([
        mappedOrder(pageA, rootA), mappedOrder(pageB, rootB),
        evidence<any>(pageA, 'exportOutboundPushEvidence'),
        evidence<any>(pageB, 'exportOutboundPushEvidence'), stack.observations(),
      ]);
      expect(orderA.native.filter((node) => node.url === savedUrl)).toEqual([
        expect.objectContaining({ id: savedNative.id, colpId: saved[0]!.id }),
      ]);
      expect(orderB.native.filter((node) => node.url === savedUrl)).toHaveLength(1);
      expect(stateA.queue.find((row: any) => row.opId === queued.opId)).toMatchObject({ status: 'terminal' });
      expect(stateA.queue.every((row: any) => row.status === 'terminal')).toBe(true);
      expect(stateA.bookmarkEvents.every((row: any) => row.status === 'processed')).toBe(true);
      expect(stateB.engine?.recoveryFrozen ?? false).toBe(false);
      await testInfo.attach('r04-placement-recovery-authority', { contentType: 'application/json',
        body: JSON.stringify({ scenario, initialServer, changedServer, server, queued, retained, orderA, orderB,
          profileA: { queue: stateA.queue, events: stateA.bookmarkEvents, receipts: stateA.receipts },
          profileB: { queue: stateB.queue, receipts: stateB.receipts },
          pushRequests: observations.pushRequests, canonicalSiblingOrders: observations.canonicalSiblingOrders,
        }, null, 2) });
    } catch (error) {
      const observations = await stack.observations().catch(() => null);
      const page = contextA?.pages().find(item => item.url().startsWith('chrome-extension:'));
      const local = page ? await evidence(page, 'exportOutboundPushEvidence').catch(() => null) : null;
      await testInfo.attach('r04-failure-authority', { contentType: 'application/json',
        body: JSON.stringify({ scenario, observations, local }, null, 2) });
      throw error;
    } finally {
      await contextA?.close().catch(() => undefined); await contextB?.close().catch(() => undefined);
      await stack.close();
      await rm(profileA, { recursive: true, force: true }); await rm(profileB, { recursive: true, force: true });
    }
  });
}

test('SP-07 R-04 deleted save parent requires explicit placement recovery', async ({}, testInfo) => {
  test.setTimeout(180_000);
  const stack = await startRealStack();
  const profileA = await mkdtemp(resolve(tmpdir(), 'known-placement-parent-a-'));
  const profileB = await mkdtemp(resolve(tmpdir(), 'known-placement-parent-b-'));
  let contextA: BrowserContext | undefined; let contextB: BrowserContext | undefined;
  let pageA: Page | undefined;
  const savedUrl = 'https://known.example/g2/recovery/parent-deleted';
  try {
    contextA = await launch(profileA, stack.browserHostResolverRules);
    contextB = await launch(profileB, stack.browserHostResolverRules);
    pageA = (await openExtensionOptions(contextA)).page;
    const pageB = (await openExtensionOptions(contextB)).page;
    await login(pageA, stack.extensionBindings[0]); await login(pageB, stack.extensionBindings[1]);
    await grantBookmarks(pageA); await grantBookmarks(pageB);
    const rootA = await configureRoot(pageA); const rootB = await configureRoot(pageB);
    await wakeUntilQuiet(pageA); await wakeUntilQuiet(pageB);
    const folder = await pageA.evaluate(parentId => chrome.bookmarks.create({ parentId, title: 'R04 deleted parent' }), rootA);
    await convergePush(pageA);
    const rootServer = await stack.canonicalSiblingOrder(ROOT_COLP_ID);
    const parentColpId = rootServer.find(row => row.title === folder.title)!.id;
    await pullUntilOrder(pageB, rootB, rootServer.map(row => row.id));
    const parentB = (await mappedOrder(pageB, rootB)).native.find(row => row.colpId === parentColpId)!.id;
    await cacheSaveTarget(pageA, folder.id); await setPreference(pageA, 'top');
    stack.setSyncOffline(true);
    await nativePageSave(pageA, contextA, savedUrl);
    await evidence(pageA, 'drainBookmarkEventCaptureEvidence');
    await expect.poll(async () => (await evidence<any>(pageA!, 'exportOutboundPushEvidence')).queue
      .some((row: any) => row.payload?.payload?.node?.url === savedUrl), { timeout: 15_000 }).toBe(true);
    const queued = (await evidence<any>(pageA, 'exportOutboundPushEvidence')).queue
      .find((row: any) => row.payload?.payload?.node?.url === savedUrl);
    expect(queued.payload.payload.parentId).toBe(parentColpId);
    await contextA.close(); contextA = undefined;
    stack.setSyncOffline(false);
    await pageB.evaluate(id => chrome.bookmarks.removeTree(id), parentB);
    await convergePush(pageB);
    expect((await stack.listDeletedCanonicalNodes()).some(row => row.id === parentColpId)).toBe(true);
    contextA = await launch(profileA, stack.browserHostResolverRules);
    pageA = (await openExtensionOptions(contextA)).page;
    await pageA.evaluate(() => chrome.runtime.sendMessage({ kind: 'known.connectivity.online' }));
    await expect.poll(async () => {
      await evidence(pageA!, 'wakeDurableEngineEvidence');
      const state = await evidence<any>(pageA!, 'exportOutboundPushEvidence');
      return { frozen: state.engine?.recoveryFrozen, code: state.scope?.metadata?.recoveryCode };
    }, { timeout: 60_000 }).toEqual({ frozen: true, code: 'create_placement_parent_deleted' });
    // Repeated wakes must retain an explainable pending operation, not silently reparent it.
    await evidence(pageA, 'wakeDurableEngineEvidence');
    const state = await evidence<any>(pageA, 'exportOutboundPushEvidence');
    const pending = state.queue.find((row: any) => row.opId === queued.opId);
    expect(pending).toMatchObject({ status: 'unknown', sequence: queued.sequence,
      payload: { payload: { parentId: parentColpId } } });
    expect(state.engine.recoveryFrozen).toBe(true);
    const attention = await pageA.evaluate(() => chrome.runtime.sendMessage({ kind: 'known.sync.attention.get' }));
    expect(attention).toMatchObject({ ok: true, attention: { terminal: true,
      terminalCode: 'create_placement_parent_deleted' } });
    await showOptionsPane(pageA, 'sync-center');
    await expect(pageA.locator('#sync-attention-settings')).toContainText('save location needs review');
    const observations = await stack.observations();
    expect((observations.canonicalNodes as any[]).some(row => row.url === savedUrl)).toBe(false);
    await testInfo.attach('r04-parent-recovery-authority', { contentType: 'application/json',
      body: JSON.stringify({ queued, pending, engine: state.engine, scope: state.scope, attention, observations }, null, 2) });
  } catch (error) {
    await testInfo.attach('r04-parent-failure-authority', { contentType: 'application/json',
      body: JSON.stringify({ local: pageA ? await evidence(pageA, 'exportOutboundPushEvidence').catch(() => null) : null,
        observations: await stack.observations() }, null, 2) });
    throw error;
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

async function configureRoot(page: Page): Promise<string> {
  const bar = await page.evaluate(async () => (await chrome.bookmarks.getTree())[0]!.children![0]!.id);
  return evidence<string>(page, 'configureDurableEngineEvidence', bar);
}

async function cacheSaveTarget(page: Page, parentNativeId: string): Promise<void> {
  await page.evaluate(({ collectionId, parentNativeId: parent }) => chrome.storage.local.set({
    'known.sync.collection.v1': collectionId,
    'known.sync.folder.v1': { collectionId, folderNativeId: parent },
    'known.sync.save-context.v1': { collectionId, parentNativeId: parent },
  }), { collectionId: COLLECTION_ID, parentNativeId });
}

async function setPreference(page: Page, position: 'top' | 'bottom'): Promise<void> {
  const result = await page.evaluate((bookmarkInsertPosition) => chrome.runtime.sendMessage({
    kind: 'known.bookmark.preferences.update', userGesture: true, bookmarkInsertPosition, foldersFirst: true,
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
