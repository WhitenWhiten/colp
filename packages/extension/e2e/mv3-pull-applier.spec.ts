import { test, expect, chromium, type BrowserContext, type Page } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { grantOptionalBookmarks } from './bookmark-permission.js';
import { openExtensionOptions, signInExtension } from './extension-auth.js';
import { startRealStack } from './real-stack.js';
import { fixtureCollectionId } from './external-backend.js';

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
    await page.evaluate(({ binding, collection }) => chrome.storage.local.set({
      'known.auth.binding.v1': binding, 'known.sync.collection.v1': collection,
    }), { binding: stack.extensionBinding, collection: fixtureCollectionId() });
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
