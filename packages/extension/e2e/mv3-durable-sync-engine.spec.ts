import { chromium, expect, test, type BrowserContext, type Page } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { startRealStack } from './real-stack.js';
import { grantOptionalBookmarks } from './bookmark-permission.js';
import { openExtensionOptions, signInExtension, showOptionsPane } from './extension-auth.js';
import { fixtureCollectionId } from './external-backend.js';

const EXTENSION_ID = 'pplpnpegpnghcddhmpgkbfkdfadjiaen';
const extensionPath = resolve(import.meta.dirname, '../dist/production');

test('two isolated production MV3 profiles retain independent durable lifecycle state across worker restart', async () => {
  test.setTimeout(120_000); const stack = await startRealStack();
  const profileA = await mkdtemp(resolve(tmpdir(), 'known-p3-33-profileA-'));
  const profileB = await mkdtemp(resolve(tmpdir(), 'known-p3-33-profileB-'));
  let contextA = await launch(profileA, stack.browserHostResolverRules); let contextB: BrowserContext | undefined;
  try {
    let pageA = await extensionPage(contextA); await login(pageA, stack.extensionBindings[0]);
    await grantBookmarks(pageA, 'A'); contextB = await launch(profileB, stack.browserHostResolverRules);
    let pageB = await extensionPage(contextB); await login(pageB, stack.extensionBindings[1]);
    await grantBookmarks(pageB, 'B');
    const barA = (await pageA.evaluate(() => chrome.bookmarks.getTree()))[0]!.children![0]!.id;
    const barB = (await pageB.evaluate(() => chrome.bookmarks.getTree()))[0]!.children![0]!.id;
    let rootA = barA;
    let rootB = barB;
    expect(rootA).toBeTruthy(); expect(rootB).toBeTruthy();
    rootA = await evidence<string>(pageA, 'configureDurableEngineEvidence', rootA);
    rootB = await evidence<string>(pageB, 'configureDurableEngineEvidence', rootB);
    await wakeUntilSleeping(pageA); await wakeUntilSleeping(pageB);
    const beforeA = await evidence<any>(pageA, 'syncEngineState'); const beforeB = await evidence<any>(pageB, 'syncEngineState');
    expect(beforeA.scopeKey).not.toBe(beforeB.scopeKey); expect(beforeA.phase).toBe('sleeping'); expect(beforeB.phase).toBe('sleeping');
    const IndexedDB = await Promise.all([pageA.evaluate(() => indexedDB.databases()),
      pageB.evaluate(() => indexedDB.databases())]);
    expect(IndexedDB[0].some((database) => database.name === 'known-phase3-indexeddb-entry')).toBe(true);
    expect(IndexedDB[1].some((database) => database.name === 'known-phase3-indexeddb-entry')).toBe(true);
    // Drop real sync sockets to prove the worker observes a transport failure,
    // independently of Chromium's context offline emulation.
    stack.setSyncOffline(true);
    await pageA.evaluate((parentId) => chrome.bookmarks.create({ parentId, title: 'P3-33 profile transfer',
      url: 'https://example.test/p3-33/profile-transfer' }), rootA);
    await evidence(pageA, 'drainBookmarkEventCaptureEvidence');
    try { await expect.poll(async () => (await evidence<any>(pageA, 'exportOutboundPushEvidence')).queue.length,
      { timeout: 10_000 }).toBe(1); }
    catch (error) { const state = await evidence<any>(pageA, 'exportOutboundPushEvidence');
      throw new Error(`bookmark_capture_timeout:${JSON.stringify({ engine: state.engine,
        scope: state.scope && { lifecycle: state.scope.lifecycle, rootStatus: state.scope.rootStatus,
          selectedRoots: state.scope.selectedRoots }, mappings: state.mappings.map((item: any) => ({
          colpId: item.colpId, nodeKind: item.nodeKind, hasParent: item.parentNativeId !== undefined })),
        events: state.bookmarkEvents })}`, { cause: error }); }
    const queuedA = await evidence<any>(pageA, 'exportOutboundPushEvidence');
    expect(['pending', 'claimed', 'unknown']).toContain(queuedA.queue[0].status);
    // A manual wake may still be inside the server's next-Pull deadline.
    // Wait for the scheduled network attempt to observe the offline transport.
    await expect.poll(async () => {
      await evidence(pageA, 'wakeDurableEngineEvidence');
      const state = await evidence<{ phase: string; errorCode?: string }>(pageA, 'syncEngineState');
      return { phase: state.phase, errorCode: state.errorCode };
    }, { timeout: 30_000 }).toEqual({ phase: 'offline', errorCode: 'network_unavailable' });
    const offline = await evidence<{ queue: Array<{ status: string }> }>(pageA, 'exportOutboundPushEvidence');
    expect(offline.queue.some((item) => item.status === 'terminal')).toBe(false);
    const offlineServer = await stack.observations();
    expect(offlineServer.syncOfflineBlockedRequests).toBeGreaterThan(0);
    expect(offlineServer.sequenceReceipts).toHaveLength(0);
    await terminateExtensionWorker(contextA, pageA); await terminateExtensionWorker(contextB, pageB);
    await contextA.close(); await contextB.close();
    contextA = await launch(profileA, stack.browserHostResolverRules);
    contextB = await launch(profileB, stack.browserHostResolverRules);
    pageA = await extensionPage(contextA); pageB = await extensionPage(contextB);
    // Browser restart clears Session secrets. While the transport is offline,
    // inspect retained durable records without claiming a live COLP Session.
    const afterA = await evidence<any>(pageA, 'exportOutboundPushEvidence');
    const afterB = await evidence<any>(pageB, 'exportOutboundPushEvidence');
    expect(afterA.scope.scopeKey).toBe(beforeA.scopeKey); expect(afterB.scope.scopeKey).toBe(beforeB.scopeKey);
    expect(afterA.engine.phase).not.toBe('acking'); expect(afterB.engine.phase).not.toBe('acking');
    const restartedA = await evidence<any>(pageA, 'exportOutboundPushEvidence');
    expect(restartedA.queue[0].opId).toBe(queuedA.queue[0].opId);
    expect(restartedA.queue[0].sequence).toBe(queuedA.queue[0].sequence);
    stack.setSyncOffline(false);
    await pageA.evaluate(() => chrome.runtime.sendMessage({ kind: 'known.connectivity.online' }));
    await evidence(pageA, 'wakeDurableEngineEvidence');
    await waitForTerminal(pageA, stack);
    const publishedNodes = (await stack.observations()).canonicalNodes as Array<{ title: string; url: string | null }>;
    expect(publishedNodes.some(node => node.title === 'P3-33 profile transfer'
      && node.url === 'https://example.test/p3-33/profile-transfer')).toBe(true);
    try { await expect.poll(async () => {
      // An early manual wake can only arm MV3's 30s floor, which races this
      // poll budget. Drive the next wake after its durable deadline opens.
      await evidence(pageB, 'wakeDurableEngineEvidence');
      return pageB.evaluate(async (parentId) => (await chrome.bookmarks.getChildren(parentId))
        .some((node) => node.title === 'P3-33 profile transfer'
          && node.url === 'https://example.test/p3-33/profile-transfer'), rootB);
    }, { timeout: 30_000 }).toBe(true); }
    catch (error) { const state = await evidence<any>(pageB, 'exportOutboundPushEvidence');
      const server = await stack.observations() as any;
      throw new Error(`profile_b_pull_timeout:${JSON.stringify({ engine: state.engine,
        cursorMatchesCheckpoint: state.cursor?.cursor === state.scope?.checkpoint?.cursor,
        applyIntents: (state.intents ?? []).map((item: any) => ({ state: item.state, apiPhase: item.apiPhase })),
        mappings: state.mappings.map((item: any) => ({ kind: item.nodeKind, hasParent: item.parentNativeId !== undefined })),
        pullResponses: server.pullResponses, receipts: server.sequenceReceipts.length })}`, { cause: error }); }
  } finally {
    await contextA.close(); await contextB?.close(); await stack.close();
    await rm(profileA, { recursive: true, force: true }); await rm(profileB, { recursive: true, force: true });
  }
});

async function launch(profile: string, browserHostResolverRules: string) { return chromium.launchPersistentContext(profile, { headless: false, channel: 'chromium',
  ignoreHTTPSErrors: true, args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`,
    `--host-resolver-rules=${browserHostResolverRules}`,
    '--no-proxy-server', '--ignore-certificate-errors'] }); }
async function extensionPage(context: BrowserContext) {
  return (await openExtensionOptions(context)).page;
}
async function login(page: Page, binding: unknown) {
  await page.evaluate(({ value, collection }) => chrome.storage.local.set({
    'known.auth.binding.v1': value, 'known.sync.collection.v1': collection,
  }), { value: binding, collection: fixtureCollectionId() });
  await signInExtension(page);
}
async function grantBookmarks(page: Page, suffix: string) {
  await showOptionsPane(page, 'folders');
  await grantOptionalBookmarks(page, 'Allow bookmark access', `Known P3-33 ${suffix}`);
  await expect.poll(() => page.evaluate(() => chrome.permissions.contains({ permissions: ['bookmarks'] }))).toBe(true);
}
async function evidence<T = unknown>(page: Page, method: string, ...args: unknown[]): Promise<T> { const result = await page.evaluate(
  ({ method, args }) => chrome.runtime.sendMessage({ kind: 'known.sync-state.evidence', method, args }), { method, args }) as any;
  if (!result.ok) throw new Error(result.error); return result.value as T; }
async function waitForTerminal(page: Page, stack: Awaited<ReturnType<typeof startRealStack>>) {
  try { await expect.poll(async () => {
    await page.evaluate(() => chrome.runtime.sendMessage({ kind: 'known.connectivity.online' }));
    await evidence(page, 'wakeDurableEngineEvidence');
    return (await evidence<any>(page, 'exportOutboundPushEvidence')).queue
      .some((item: any) => item.status === 'terminal');
  }, { timeout: 30_000 }).toBe(true); }
  catch (error) { const state = await evidence<any>(page, 'exportOutboundPushEvidence');
    const engine = await evidence<any>(page, 'syncEngineState');
    const server = await stack.observations() as any;
    throw new Error(`terminal_push_timeout:${JSON.stringify({ phase: engine.phase, errorCode: engine.errorCode,
      queue: state.queue.map((item: any) => ({ sequence: item.sequence, status: item.status,
        type: item.payload.type, recovery: item.recovery, hasAttempt: item.attempt !== undefined })),
      events: state.bookmarkEvents.map((item: any) => ({ kind: item.kind, status: item.status,
        hasOpId: item.opId !== null })), pullResponses: server.pullResponses })}`, { cause: error }); }
}
async function wakeUntilSleeping(page: Page) {
  try { await expect.poll(async () => { await evidence(page, 'wakeDurableEngineEvidence');
    return (await evidence<any>(page, 'syncEngineState')).phase; }, { timeout: 30_000 }).toBe('sleeping'); }
  catch (error) { const state = await evidence<any>(page, 'exportOutboundPushEvidence');
    throw new Error(`engine_sleep_timeout:${JSON.stringify({ engine: state.engine,
      recovery: state.recovery, ackIntents: state.ackIntents })}`, { cause: error }); }
}
async function terminateExtensionWorker(context: BrowserContext, page: Page) { const cdp = await context.newCDPSession(page);
  await cdp.send('ServiceWorker.enable'); const targets = await cdp.send('Target.getTargets');
  const target = targets.targetInfos.find((item) => item.type === 'service_worker' && item.url.includes(EXTENSION_ID));
  await cdp.send('Target.closeTarget', { targetId: target!.targetId }); await cdp.detach(); }


for (const code of ['pull_apply_target_missing', 'payload_too_large']) {
  test(`replica rebuild exits ${code}, preserves Chrome and registers fresh authority`, async () => {
    test.setTimeout(120_000);
    const stack = await startRealStack(); const profile = await mkdtemp(resolve(tmpdir(), 'known-rebuild-'));
    const context = await launch(profile, stack.browserHostResolverRules);
    try {
      const page = await extensionPage(context); await login(page, stack.extensionBinding);
      await grantBookmarks(page, 'rebuild');
      let root = (await page.evaluate(() => chrome.bookmarks.getTree()))[0]!.children![0]!.id;
      root = await evidence<string>(page, 'configureDurableEngineEvidence', root);
      await wakeUntilSleeping(page);
      stack.setSyncOffline(true);
      const bookmark = await page.evaluate(parentId => chrome.bookmarks.create({ parentId,
        title: 'Preserved across rebuild', url: 'https://example.test/rebuild-preserved' }), root);
      await evidence(page, 'drainBookmarkEventCaptureEvidence');
      const before = await evidence<any>(page, 'exportOutboundPushEvidence');
      expect(before.queue.length).toBeGreaterThan(0);
      // Inject only the terminal fact; the button, archive, new Session and
      // first-run status below all execute production code against PostgreSQL.
      await page.evaluate(async ({ key, code }) => {
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
          const request = indexedDB.open('known-phase3-indexeddb-entry');
          request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
        });
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction(['sync_engine', 'sync_scopes'], 'readwrite');
          const request = tx.objectStore('sync_engine').get(key);
          request.onsuccess = () => tx.objectStore('sync_engine').put({ ...request.result,
            revision: request.result.revision + 1, phase: 'recovery', recoveryFrozen: true,
            // Deliberately NOT `authorityRefreshRequired: true`: the wake's authority-refresh
            // branch recomputes recoveryFrozen from unfinished work
            // (durable-sync-engine.ts: pendingIncompletePull || nativeResultUnknown), so the
            // hand-written freeze raced the startup refresh and the rebuild prompt appeared
            // only sometimes. The freeze flag is what `inspect()` gates on; the post-confirm
            // re-registration below still exercises the fresh-authority path for real.
            lastError: code, notBefore: 0 });
          const scope = tx.objectStore('sync_scopes').get(key);
          scope.onsuccess = () => tx.objectStore('sync_scopes').put({ ...scope.result, lifecycle: 'recovery_required',
            metadata: { ...scope.result.metadata, recoveryCode: code } });
          tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error);
        });
        db.close();
      }, { key: before.scope.scopeKey, code });
      stack.setSyncOffline(false);
      await page.reload(); await showOptionsPane(page, 'sync-center');
      const button = page.locator('#sync-attention-settings-rebuild');
      await expect(button).toBeVisible();
      await button.click();
      const confirmation = page.locator('.rebuild-confirm');
      await expect(confirmation).toContainText('Your bookmarks stay on this device and in Know-N');
      await Promise.all([page.waitForEvent('domcontentloaded', { timeout: 30_000 }),
        confirmation.getByRole('button', { name: 'Reset sync', exact: true }).click()]);
      await expect.poll(async () => page.evaluate(async () =>
        (await chrome.storage.local.get('known.auth.binding.v1'))['known.auth.binding.v1']),
      { timeout: 30_000 }).not.toMatchObject({ replicaId: before.scope.replicaId });
      await expect.poll(async () => page.evaluate(() => chrome.runtime.sendMessage({ kind: 'known.firstRun.status' })),
        { timeout: 30_000 }).toMatchObject({ ok: true, firstRun: 'none' });
      const kept = await page.evaluate(id => chrome.bookmarks.get(id), bookmark.id);
      expect(kept[0]).toMatchObject({ title: 'Preserved across rebuild', url: 'https://example.test/rebuild-preserved' });
      const oldScope = Object.fromEntries(['environment', 'serverId', 'serverOrigin', 'accountId', 'browserProfileId',
        'collectionId', 'replicaId', 'generation'].map(key => [key, before.scope[key]]));
      const archive = await evidence<any>(page, 'exportArchive', oldScope);
      expect(archive.reason).toBe('user_replica_rebuild');
      expect(archive.queue.length).toBe(before.queue.length);
      const after = await evidence<any>(page, 'exportOutboundPushEvidence');
      expect(after.scope.replicaId).not.toBe(before.scope.replicaId);
      expect(after.engine?.recoveryFrozen ?? false).toBe(false);
      expect(after.queue).toEqual([]);
    } finally { await context.close(); await stack.close(); await rm(profile, { recursive: true, force: true }); }
  });
}
