import { test, expect, chromium, type BrowserContext, type CDPSession, type Page } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { grantOptionalBookmarks } from './bookmark-permission.js';
import { installFixtureReplicaBinding, openExtensionOptions, showOptionsPane, signInExtension } from './extension-auth.js';
import { startRealStack } from './real-stack.js';
import { fixtureCollectionId } from './external-backend.js';
import { KNS08_BINDINGS, confirmFirstRun, grantBookmarks as grantRealBookmarks, launchPersistent,
  login, optionsPage, runtimeMessage, specialRoots, waitFirstRunProductQuiet, waitQueueQuiet } from './kns-08-harness.js';
import type { createSyncStateStore } from '../src/sync-state-store.js';
import type { PublicNativeWait } from '../src/types.js';

type ScopeExport = Awaited<ReturnType<ReturnType<typeof createSyncStateStore>['exportScope']>>;

const EXTENSION_ID = 'pplpnpegpnghcddhmpgkbfkdfadjiaen';
const extensionPath = resolve(import.meta.dirname, '../dist/production');
const scope = { environment: 'production', serverId: 'server-pull-e2e', serverOrigin: 'https://known.example',
  accountId: 'account-pull-e2e', browserProfileId: 'profile-pull-e2e', collectionId: 'collection-pull-e2e',
  replicaId: 'replica-pull-e2e', generation: 1 } as const;

test('production MV3 consumes the real chrome.bookmarks event and queues a similar user event', async () => {
  const profileA = await mkdtemp(resolve(tmpdir(), 'known-p3-32-profileA-'));
  let context = await launchPersistentContext(profileA);
  try {
    let page = await extensionPage(context);
    await grantBookmarks(page);
    const roots = await page.evaluate(() => chrome.bookmarks.getTree()); const bar = roots[0]!.children![0]!.id;
    const selected = await page.evaluate((parentId) => chrome.bookmarks.create({ parentId, title: 'Pull selected' }), bar);
    await evidence(page, 'registerEvidenceScope', scope);
    await evidence(page, 'configureEventEvidence', scope, selected.id, null);
    const interrupted = await evidence<any>(page, 'stagePullCreateCrashEvidence', scope, selected.id);
    // The interrupt lands after the create's Chrome call started and before the event commits, so
    // the durable state is `browser_call_started` - unless the real `chrome.bookmarks.onCreated`
    // listener processes the new bookmark first, which advances that same event to
    // `native_event_observed`. Both mean "interrupted in flight", and which one is observed depends
    // on a listener race this fixture cannot pin; the assertions below hold for either.
    expect(['browser_call_started', 'native_event_observed']).toContain(interrupted.pullEvents[0].state);
    expect(interrupted.cursor).toBeNull();
    await terminateExtensionWorker(context, page); await context.close(); context = await launchPersistentContext(profileA);
    page = await extensionPage(context); await evidence(page, 'configureEventEvidence', scope, selected.id, null);
    const applied = await evidence<any>(page, 'resumePullApplyEvidence', scope);
    expect(applied.pullPages.every((pullPage: any) => pullPage.state === 'page_complete')).toBe(true);
    expect(applied.pullEvents.every((event: any) => event.state === 'page_complete')).toBe(true);
    expect(applied.intents.every((intent: any) => intent.state === 'page_complete')).toBe(true);
    expect(applied.queue).toHaveLength(0);

    const similarUserEvent = await page.evaluate((parentId) => chrome.bookmarks.create({ parentId,
      title: 'Remote user edit', url: 'https://example.test/user' }), selected.id);
    await page.evaluate((id) => chrome.bookmarks.update(id, { title: 'Remote user edit 2' }), similarUserEvent.id);
    await page.evaluate(({ id, parentId }) => chrome.bookmarks.move(id, { parentId, index: 0 }),
      { id: similarUserEvent.id, parentId: selected.id });
    await page.evaluate((id) => chrome.bookmarks.remove(id), similarUserEvent.id);
    await expect.poll(async () => (await evidence<any>(page, 'exportScope', scope)).queue.length).toBeGreaterThanOrEqual(1);
    await terminateExtensionWorker(context, page); await context.close(); context = await launchPersistentContext(profileA);
    page = await extensionPage(context); const recovered = await evidence<any>(page, 'exportScope', scope);
    expect(recovered.pullPages[0].state).toBe('page_complete'); expect(recovered.queue.length).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(recovered.intents)).not.toContain('Remote user edit');
  } finally { await context.close(); await rm(profileA, { recursive: true, force: true }); }
});

test('real Backend/PostgreSQL effect pages resume across 429 and MV3 worker restarts', async () => {
  test.setTimeout(180_000);
  const stack = await startRealStack();
  const profile = await mkdtemp(resolve(tmpdir(), 'known-q001-effect-pages-'));
  let context = await launchRealPersistentContext(profile, stack.browserHostResolverRules);
  try {
    let page = await extensionPage(context);
    await installFixtureReplicaBinding(page, stack.extensionBinding);
    await page.evaluate(collection => chrome.storage.local.set({ 'known.sync.collection.v1': collection }), fixtureCollectionId());
    await signInExtension(page);
    const effect = await stack.seedPagedSubtree(10_000);
    expect(effect).toMatchObject({ pageCount: 20, memberCount: 10_000 });
    stack.setEffectPageRateLimitPages([1, 10, 11, 20]);

    for (const expectedPage of [1, 10, 11, 20]) {
      const interrupted = await evidence<any>(page, 'downloadEffectPagesEvidence',
        effect.effectId, effect.pageCount, effect.memberCount);
      expect(interrupted.status, `page ${expectedPage}: ${JSON.stringify(interrupted)}`).toBe('rate_limited');
      expect(interrupted.download.nextPageNumber).toBe(expectedPage);
      await terminateExtensionWorker(context, page);
      await context.close(); context = await launchRealPersistentContext(profile, stack.browserHostResolverRules);
      page = await extensionPage(context);
      // The downloader compares its durable deadline against the browser clock.
      // A fixed host sleep does not prove that a restarted browser passed it.
      await expect.poll(() => page.evaluate(deadline => Date.now() >= deadline,
        interrupted.download.retryNotBefore), { timeout: 30_000 }).toBe(true);
    }
    const completed = await evidence<any>(page, 'downloadEffectPagesEvidence',
      effect.effectId, effect.pageCount, effect.memberCount);
    expect(completed).toMatchObject({ status: 'complete', pageCount: 20, memberCount: 10_000,
      download: null });
  } finally { await context.close(); await stack.close(); await rm(profile, { recursive: true, force: true }); }
});

test('real child native-wait binds an onCreated candidate after worker stop and persistent-profile restart', async () => {
  test.setTimeout(300_000);
  const stack = await startRealStack();
  const profiles = await Promise.all(['a', 'b'].map(id => mkdtemp(resolve(tmpdir(), `known-r5-child-wait-${id}-`))));
  let a: BrowserContext | undefined, b: BrowserContext | undefined;
  const folderTitle = 'Native wait source folder', childTitle = 'Native wait child';
  const childUrl = 'https://example.test/native-wait-child';
  try {
    a = await launchPersistent(profiles[0]!, stack.browserHostResolverRules);
    const pageA = await optionsPage(a); await login(pageA, KNS08_BINDINGS[0]); await grantRealBookmarks(pageA);
    const rootsA = await specialRoots(pageA);
    const originalA = await pageA.evaluate(async ({ parentId, folderTitle, childTitle, childUrl }) => {
      const folder = await chrome.bookmarks.create({ parentId, title: folderTitle });
      const child = await chrome.bookmarks.create({ parentId: folder.id, title: childTitle, url: childUrl });
      return { folder, child };
    }, { parentId: rootsA.barId, folderTitle, childTitle, childUrl });
    await confirmFirstRun(pageA, [rootsA.barTitle, rootsA.otherTitle]);
    await waitFirstRunProductQuiet(pageA, stack, KNS08_BINDINGS[0]);

    b = await launchPersistent(profiles[1]!, stack.browserHostResolverRules);
    let pageB = await optionsPage(b); await login(pageB, KNS08_BINDINGS[1]); await grantRealBookmarks(pageB);
    const rootsB = await specialRoots(pageB);
    await confirmFirstRun(pageB, [rootsB.barTitle, rootsB.otherTitle]);
    await waitFirstRunProductQuiet(pageB, stack, KNS08_BINDINGS[1]);
    const originalB = await pageB.evaluate(async ({ folderTitle, childUrl }) => {
      const [folder] = await chrome.bookmarks.search({ title: folderTitle });
      const [child] = await chrome.bookmarks.search({ url: childUrl });
      return { folder: folder!, child: child! };
    }, { folderTitle, childUrl });
    expect(originalB.child.parentId).toBe(originalB.folder.id);
    const before = await evidence<ScopeExport>(pageB, 'exportOutboundPushEvidence');
    const folderColp = before.mappings.find(row => row.nativeId === originalB.folder.id)!.colpId;
    const childColp = before.mappings.find(row => row.nativeId === originalB.child.id)!.colpId;
    const sourceMount = before.mountBindings.find(row => row.nativeRootId === rootsB.barId)!;
    expect(await runtimeMessage(pageB, { kind: 'known.scope.detach', mountId: sourceMount.mountId })).toMatchObject({ ok: true });

    const worker = b.serviceWorkers().find(row => row.url() === `chrome-extension://${EXTENSION_ID}/service-worker.js`)!;
    // The real Chrome call and its onCreated listener run unchanged. Only its
    // return to the applier is suspended, so stopping MV3 loses the API receipt
    // without inventing a failure, a candidate event, or durable confirmation.
    await worker.evaluate(({ childTitle, childUrl }) => {
      const create = chrome.bookmarks.create.bind(chrome.bookmarks);
      let held = false;
      chrome.bookmarks.create = async details => {
        const native = await create(details);
        if (!held && details.title === childTitle && details.url === childUrl) {
          held = true; await new Promise<void>(() => undefined);
        }
        return native;
      };
    }, { childTitle, childUrl });
    await pageA.evaluate(({ id, parentId }) => chrome.bookmarks.move(id, { parentId }),
      { id: originalA.folder.id, parentId: rootsA.otherId });
    await evidence(pageA, 'drainBookmarkEventCaptureEvidence');
    await waitQueueQuiet(pageA, stack, KNS08_BINDINGS[0]);
    // This production request acknowledges the wake before the held engine
    // cycle finishes; awaiting the evidence wake would wait on the barrier.
    expect(await runtimeMessage(pageB, { kind: 'known.sync.engine.retry' })).toMatchObject({ ok: true });
    await expect.poll(async () => {
      const state = await evidence<ScopeExport>(pageB, 'exportOutboundPushEvidence');
      return state.intents.find(row => row.colpId === childColp && row.substep === 'range-materialize'
        && typeof row.nativeEventEvidence?.nativeId === 'string')?.replayState;
    }, { timeout: 60_000 }).toBe('started');
    const interrupted = await evidence<ScopeExport>(pageB, 'exportOutboundPushEvidence');
    const childIntent = interrupted.intents.find(row => row.colpId === childColp && row.substep === 'range-materialize')!;
    const parentIntent = interrupted.intents.find(row => row.intentId === `intent:${childIntent.operationId}`)!;
    const childNative = String(childIntent.nativeEventEvidence!.nativeId);
    const parentNative = String(parentIntent.nativeResultConfirmation!.nativeId);
    expect(childIntent.apiResultEvidence ?? null).toBeNull();
    expect(parentIntent.nativeResultConfirmation).toEqual({ kind: 'api_return', nativeId: parentNative });
    expect(parentNative).not.toBe(childNative);
    expect(interrupted.mappings.some(row => row.nativeId === parentNative || row.nativeId === childNative)).toBe(false);
    expect(interrupted.bookmarkEvents.some(row => row.nativeId === childNative && row.kind === 'create')).toBe(false);
    expect(await pageB.evaluate(id => chrome.bookmarks.get(id), childNative)).toMatchObject([{ parentId: parentNative }]);

    await stopActiveWorker(b, pageB);
    await b.close(); b = await launchPersistent(profiles[1]!, stack.browserHostResolverRules); pageB = await optionsPage(b);
    const waits = async () => runtimeMessage<{ ok: boolean; waits: PublicNativeWait[] }>(pageB, { kind: 'known.nativeWait.list' });
    await expect.poll(async () => (await waits()).waits?.find(row => row.colpId === childColp), { timeout: 60_000 })
      .toMatchObject({ candidates: [{ nativeId: childNative }] });
    const resumed = await evidence<ScopeExport>(pageB, 'exportOutboundPushEvidence');
    const waitingChild = resumed.intents.find(row => row.intentId === childIntent.intentId)!;
    expect(waitingChild).toMatchObject({ nativeResult: 'result_unknown', nativeResultConfirmation: { kind: 'unknown' } });
    expect(waitingChild.apiResultEvidence ?? null).toBeNull();
    expect(resumed.intents.find(row => row.intentId === parentIntent.intentId)?.nativeResultConfirmation)
      .toEqual(parentIntent.nativeResultConfirmation);

    await showOptionsPane(pageB, 'sync-center');
    const row = pageB.locator('#native-wait-list [data-sync-node]').filter({ hasText: childTitle });
    await expect(row.locator('select.native-wait-candidate')).toHaveValue(childNative);
    await row.locator('[data-native-wait-action="bind"]').click();
    await expect.poll(async () => (await waits()).waits?.length, { timeout: 60_000 }).toBe(0);
    await waitQueueQuiet(pageB, stack, KNS08_BINDINGS[1]);
    const bound = await evidence<ScopeExport>(pageB, 'exportOutboundPushEvidence');
    expect(bound.mappings.find(row => row.colpId === folderColp)?.nativeId).toBe(parentNative);
    expect(bound.mappings.find(row => row.colpId === childColp)?.nativeId).toBe(childNative);
    const boundChild = bound.intents.find(row => row.intentId === childIntent.intentId)!;
    expect(boundChild.nativeResultConfirmation).toEqual({ kind: 'candidate_event', nativeId: childNative });
    expect(boundChild.apiResultEvidence ?? null).toBeNull();
    expect(bound.intents.find(row => row.intentId === parentIntent.intentId)?.nativeResultConfirmation)
      .toEqual(parentIntent.nativeResultConfirmation);

    await b.close(); b = await launchPersistent(profiles[1]!, stack.browserHostResolverRules); pageB = await optionsPage(b);
    await waitQueueQuiet(pageB, stack, KNS08_BINDINGS[1]);
    const final = await evidence<ScopeExport>(pageB, 'exportOutboundPushEvidence');
    expect(final.mappings.find(row => row.colpId === folderColp)?.nativeId).toBe(parentNative);
    expect(final.mappings.find(row => row.colpId === childColp)?.nativeId).toBe(childNative);
    const natives = await pageB.evaluate(async ({ childUrl, sourceFolder, sourceChild, parentNative }) => ({
      children: await chrome.bookmarks.search({ url: childUrl }),
      sourceFolder: (await chrome.bookmarks.get(sourceFolder))[0], sourceChild: (await chrome.bookmarks.get(sourceChild))[0],
      destinationChildren: await chrome.bookmarks.getChildren(parentNative),
    }), { childUrl, sourceFolder: originalB.folder.id, sourceChild: originalB.child.id, parentNative });
    expect(natives.children.map(row => row.id).sort()).toEqual([originalB.child.id, childNative].sort());
    expect(natives.sourceFolder?.parentId).toBe(rootsB.barId);
    expect(natives.sourceChild?.parentId).toBe(originalB.folder.id);
    expect(natives.destinationChildren.map(row => row.id)).toEqual([childNative]);
    expect(await stack.canonicalSiblingOrder(folderColp)).toMatchObject([{ id: childColp, url: childUrl }]);
  } finally {
    await a?.close(); await b?.close(); await stack.close();
    await Promise.all(profiles.map(profile => rm(profile, { recursive: true, force: true })));
  }
});

async function launchPersistentContext(profile: string) { return chromium.launchPersistentContext(profile, { headless: false, channel: 'chromium',
  args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`] }); }
async function launchRealPersistentContext(profile: string, browserHostResolverRules: string) { return chromium.launchPersistentContext(profile, { headless: false,
  channel: 'chromium', ignoreHTTPSErrors: true, args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`,
    `--host-resolver-rules=${browserHostResolverRules}`,
    '--no-proxy-server', '--ignore-certificate-errors'] }); }
async function extensionPage(context: BrowserContext) {
  return (await openExtensionOptions(context)).page;
}
async function grantBookmarks(page: Page) {
  await page.evaluate(() => {
    const button = document.createElement('button'); button.textContent = 'Grant pull access';
    button.addEventListener('click', () => { void chrome.permissions.request({ permissions: ['bookmarks'] }); });
    document.body.append(button);
  });
  await grantOptionalBookmarks(page, 'Grant pull access', 'Known pull permission');
  await expect.poll(() => page.evaluate(() => chrome.permissions.contains({ permissions: ['bookmarks'] }))).toBe(true);
}
async function evidence<T = unknown>(page: Page, method: string, ...args: unknown[]): Promise<T> {
  const result = await page.evaluate(({ method, args }) => chrome.runtime.sendMessage({
    kind: 'known.sync-state.evidence', method, args }), { method, args }) as any;
  if (!result.ok) throw new Error(result.error); return result.value as T;
}
async function terminateExtensionWorker(context: BrowserContext, page: Page) { const cdp = await context.newCDPSession(page);
  await cdp.send('ServiceWorker.enable'); const targets = await cdp.send('Target.getTargets');
  const target = targets.targetInfos.find((item) => item.type === 'service_worker' && item.url.includes(EXTENSION_ID));
  await cdp.send('Target.closeTarget', { targetId: target!.targetId }); await cdp.detach();
}

async function stopActiveWorker(context: BrowserContext, page: Page) {
  const cdp = await context.newCDPSession(page);
  try {
    const running = waitForWorkerStatus(cdp, 'running');
    await cdp.send('ServiceWorker.enable'); const version = await running;
    const stopped = waitForWorkerStatus(cdp, 'stopped');
    await cdp.send('ServiceWorker.stopWorker', { versionId: version.versionId }); await stopped;
  } finally { await cdp.detach(); }
}
function waitForWorkerStatus(cdp: CDPSession, status: 'running' | 'stopped') {
  return new Promise<{ versionId: string }>((resolveWorker, reject) => {
    const timeout = setTimeout(() => { cdp.off('ServiceWorker.workerVersionUpdated', listener);
      reject(new Error(`Timed out waiting for service worker ${status}`)); }, 10_000);
    const listener = (event: { versions: Array<{ versionId: string; scriptURL: string; runningStatus: string }> }) => {
      const version = event.versions.find(row => row.scriptURL === `chrome-extension://${EXTENSION_ID}/service-worker.js`
        && row.runningStatus === status);
      if (!version) return;
      clearTimeout(timeout); cdp.off('ServiceWorker.workerVersionUpdated', listener); resolveWorker(version);
    };
    cdp.on('ServiceWorker.workerVersionUpdated', listener);
  });
}
