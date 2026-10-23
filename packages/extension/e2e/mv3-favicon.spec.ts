/**
 * FO-04/FO-07 extension real-stack evidence: built MV3 + real service worker +
 * real backend exercising the four /colp/v0.1/sync favicon helper operations.
 *
 * Deterministic sidecar source: a REAL popup save of a page served by the
 * harness at https://known.example/site.html whose <link rel=icon> points at
 * /favicon.png. The durable engine's save path captures the tab favicon over
 * the real fetch boundary (captureTabFavicon), writes a sidecar keyed by the
 * real Chrome bookmark id, and the SW drain rebuilds intent from the real
 * server policy/source and POSTs through the helper.
 *
 * Legs (per the favicon-ordering plan 真实浏览器 row):
 *  1. capture        — a popup save drains to the real helper; the server
 *                      persists bookmark_icons + bookmark_icon_sources and the
 *                      favicon object store receives the put.
 *  2. offline replay — browser offline: policy read fails, bytes stay stashed;
 *                      back online the next drain posts them.
 *  3. manual protection — a real updateMyFaviconPolicy(newDefault none) makes
 *                      the next automatic capture discard with no object put.
 *
 * The fixture policy default (capture) and empty source (inherit => effective
 * capture) make the capture leg capturable without any UI poke: exactly the
 * contract state the FO-04 client gates on.
 */
import { chromium, expect, test, type BrowserContext, type Page } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { startRealStack } from './real-stack.js';
import { KNOW_N_BACKEND_ONLY, knowNBackendRoot } from './cloud-product-fixtures.js';
import { grantOptionalBookmarks } from './bookmark-permission.js';
import { installFixtureReplicaBinding, openExtensionOptions, signInExtension } from './extension-auth.js';
import { FIXTURE_COLLECTION_ID } from './fixture-ids.js';

const extensionPath = resolve(import.meta.dirname, '../dist/production');
const SITE_URL = 'https://known.example/site.html';

// Capture, classification, credits and the favicon helper are Know-N backend routes.
test.skip(!knowNBackendRoot, KNOW_N_BACKEND_ONLY);

test('captures a real favicon through the built MV3 + real backend helper and persists server rows', async () => {
  test.setTimeout(180_000);
  process.env.KNOWN_FEATURE_FAVICON_POLICY = 'true';
  const stack = await startRealStack();
  const profile = await mkdtemp(resolve(tmpdir(), 'known-fo04-capture-'));
  const context = await launchPersistentContext(profile, stack.browserHostResolverRules);
  try {
    const page = await extensionPage(context); await login(page, stack.extensionBinding); await grantBookmarks(page);
    const roots = await page.evaluate(() => chrome.bookmarks.getTree()); const bar = roots[0]!.children![0]!.id;
    await evidence(page, 'configureDurableEngineEvidence', bar);
    // A real page tab with a favicon; the SW native-save message (the same
    // handler the context-menu save drives) captures that favicon over fetch.
    const site = await context.newPage();
    await site.goto(SITE_URL, { waitUntil: 'domcontentloaded' });
    await site.bringToFront();
    await waitForTabFavicon(page);
    await nativeSave(page);
    await expect.poll(async () => {
      const rows = await evidence<any>(page, 'exportFaviconSidecarEvidence') as any[];
      return rows.filter((row) => row.collectionId === FIXTURE_COLLECTION_ID).length;
    }, { timeout: 30_000 }).toBeGreaterThan(0);
    await waitForMappedSave(page);
    await drainUntil(page, async () => {
      const observed = await stack.observations() as any;
      const favicon = observed.faviconEvidence;
      return favicon.bindings.length >= 1 && favicon.sources.length >= 1 && favicon.objectPuts.length >= 1
        ? JSON.stringify({ bindings: favicon.bindings, sources: favicon.sources, puts: favicon.objectPuts })
        : JSON.stringify(favicon);
    }, '"object_id"');
    const observed = await stack.observations() as any;
    const favicon = observed.faviconEvidence;
    expect(favicon.bindings[0]?.content_type).toBe('image/png');
    expect(favicon.objectCount).toBeGreaterThan(0);
    expect(favicon.objectPuts.length).toBeGreaterThan(0);
  } finally { await context.close(); await stack.close(); await rm(profile, { recursive: true, force: true }); }
});

test('offline drain keeps the sidecar and posts it once the browser is online again', async () => {
  test.setTimeout(180_000);
  process.env.KNOWN_FEATURE_FAVICON_POLICY = 'true';
  const stack = await startRealStack();
  const profile = await mkdtemp(resolve(tmpdir(), 'known-fo04-offline-'));
  const context = await launchPersistentContext(profile, stack.browserHostResolverRules);
  try {
    const page = await extensionPage(context); await login(page, stack.extensionBinding); await grantBookmarks(page);
    const roots = await page.evaluate(() => chrome.bookmarks.getTree()); const bar = roots[0]!.children![0]!.id;
    await evidence(page, 'configureDurableEngineEvidence', bar);
    const site = await context.newPage();
    await site.goto(SITE_URL, { waitUntil: 'domcontentloaded' });
    await site.bringToFront();
    await waitForTabFavicon(page);
    // Go offline immediately after the save materializes the sidecar, before
    // the engine's scheduled drain can reach the helper.
    await nativeSave(page);
    await context.setOffline(true);
    await expect.poll(async () => {
      const rows = await evidence<any>(page, 'exportFaviconSidecarEvidence') as any[];
      return rows.filter((row) => row.collectionId === FIXTURE_COLLECTION_ID).length;
    }, { timeout: 30_000 }).toBeGreaterThan(0);
    const stashedRows = await evidence<any>(page, 'exportFaviconSidecarEvidence') as any[];
    expect(stashedRows.some((row) => row.contentType === 'image/png'
      && row.collectionId === FIXTURE_COLLECTION_ID)).toBe(true);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await drain(page);
      await page.waitForTimeout(2_000);
    }
    await expect.poll(async () => {
      const rows = await evidence<any>(page, 'exportFaviconSidecarEvidence') as any[];
      return rows.filter((row) => row.collectionId === FIXTURE_COLLECTION_ID).length;
    }, { timeout: 30_000 }).toBeGreaterThan(0);
    await expect.poll(async () => {
      const observed = await stack.observations() as any;
      return observed.faviconEvidence.bindings.length;
    }, { timeout: 30_000 }).toBe(0);
    // Online again: the next drain posts it.
    await context.setOffline(false);
    await drainUntil(page, async () => {
      const observed = await stack.observations() as any;
      return observed.faviconEvidence.bindings.length;
    }, 1);
    await expect.poll(async () => {
      const rows = await evidence<any>(page, 'exportFaviconSidecarEvidence') as any[];
      return rows.filter((row) => row.collectionId === FIXTURE_COLLECTION_ID).length;
    }, { timeout: 30_000 }).toBe(0);
  } finally { await context.close(); await stack.close(); await rm(profile, { recursive: true, force: true }); }
});

test('manual protection: a real policy none command makes the next automatic capture discard, no object put', async () => {
  test.setTimeout(180_000);
  process.env.KNOWN_FEATURE_FAVICON_POLICY = 'true';
  const stack = await startRealStack();
  const profile = await mkdtemp(resolve(tmpdir(), 'known-fo04-protected-'));
  const context = await launchPersistentContext(profile, stack.browserHostResolverRules);
  try {
    const page = await extensionPage(context); await login(page, stack.extensionBinding); await grantBookmarks(page);
    const roots = await page.evaluate(() => chrome.bookmarks.getTree()); const bar = roots[0]!.children![0]!.id;
    await evidence(page, 'configureDurableEngineEvidence', bar);
    // Real production command (the function the Product PATCH route calls):
    // the account is already protected before the save so no automatic
    // capture can ever race ahead of the policy.
    await stack.setFaviconPolicyForFixture({ newDefault: 'none' });
    const before = await stack.observations() as any;
    expect(before.faviconEvidence.policies[0]?.new_default).toBe('none');
    const site = await context.newPage();
    await site.goto(SITE_URL, { waitUntil: 'domcontentloaded' });
    await site.bringToFront();
    await waitForTabFavicon(page);
    await nativeSave(page);
    await expect.poll(async () => {
      const rows = await evidence<any>(page, 'exportFaviconSidecarEvidence') as any[];
      return rows.filter((row) => row.collectionId === FIXTURE_COLLECTION_ID).length;
    }, { timeout: 30_000 }).toBeGreaterThan(0);
    const stashedBefore = await evidence<any>(page, 'exportFaviconSidecarEvidence') as any[];
    expect(stashedBefore.some((row) => row.contentType === 'image/png'
      && row.collectionId === FIXTURE_COLLECTION_ID)).toBe(true);
    // With newDefault none the client discards the queued bytes before any PUT.
    await expect.poll(async () => {
      await drain(page);
      const rows = await evidence<any>(page, 'exportFaviconSidecarEvidence') as any[];
      return rows.filter((row) => row.collectionId === FIXTURE_COLLECTION_ID).length;
    }, { timeout: 60_000 }).toBe(0);
    const after = await stack.observations() as any;
    expect(after.faviconEvidence.bindings.length).toBe(0);
    expect(after.faviconEvidence.objectPuts.length).toBe(0);
    expect(after.faviconEvidence.objectCount).toBe(0);
  } finally { await context.close(); await stack.close(); await rm(profile, { recursive: true, force: true }); }
});

test('clear leg: the clear consumer DELETEs the auto-captured binding from the real backend', async () => {
  test.setTimeout(180_000);
  process.env.KNOWN_FEATURE_FAVICON_POLICY = 'true';
  const stack = await startRealStack();
  const profile = await mkdtemp(resolve(tmpdir(), 'known-fo04-clear-'));
  const context = await launchPersistentContext(profile, stack.browserHostResolverRules);
  try {
    const page = await extensionPage(context); await login(page, stack.extensionBinding); await grantBookmarks(page);
    const roots = await page.evaluate(() => chrome.bookmarks.getTree()); const bar = roots[0]!.children![0]!.id;
    await evidence(page, 'configureDurableEngineEvidence', bar);
    const site = await context.newPage();
    await site.goto(SITE_URL, { waitUntil: 'domcontentloaded' });
    await site.bringToFront();
    await waitForTabFavicon(page);
    await nativeSave(page);
    await expect.poll(async () => {
      const rows = await evidence<any>(page, 'exportFaviconSidecarEvidence') as any[];
      return rows.filter((row) => row.collectionId === FIXTURE_COLLECTION_ID).length;
    }, { timeout: 30_000 }).toBeGreaterThan(0);
    await waitForMappedSave(page);
    await drainUntil(page, async () => {
      const observed = await stack.observations() as any;
      const favicon = observed.faviconEvidence;
      return favicon.bindings.length >= 1 && favicon.sources.length >= 1 && favicon.objectPuts.length >= 1
        ? JSON.stringify({ bindings: favicon.bindings, sources: favicon.sources, puts: favicon.objectPuts })
        : JSON.stringify(favicon);
    }, '"object_id"');
    const before = await stack.observations() as any;
    expect(before.faviconEvidence.bindings.length).toBeGreaterThan(0);

    // FO-04 clear consumer: the same message the popup "Clear auto-captured
    // icon" button sends, driven over the real bookmark native id. The
    // sidecar row is already gone (the drain posted it), so the native id
    // comes from the real bookmark tree.
    const matches = await page.evaluate(() => chrome.bookmarks.search({ url: SITE_URL }));
    const nativeId = matches[0]?.id as string | undefined;
    expect(nativeId).toBeTruthy();
    const cleared = await page.evaluate(
      (id) => chrome.runtime.sendMessage({ kind: 'known.favicon.clear', nativeId: id }), nativeId,
    ) as { readonly ok?: boolean; readonly outcome?: string; readonly error?: string };
    expect(cleared.ok).toBe(true);
    expect(cleared.outcome).toBe('cleared');
    await expect.poll(async () => {
      const after = await stack.observations() as any;
      return after.faviconEvidence.bindings.length;
    }, { timeout: 30_000 }).toBe(0);
  } finally { await context.close(); await stack.close(); await rm(profile, { recursive: true, force: true }); }
});

async function launchPersistentContext(profile: string, browserHostResolverRules: string) {
  return chromium.launchPersistentContext(profile, {
    headless: false, channel: 'chromium', ignoreHTTPSErrors: true, args: [
      `--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`,
      `--host-resolver-rules=${browserHostResolverRules}`,
      '--no-proxy-server', '--ignore-certificate-errors',
    ] });
}
async function extensionPage(context: BrowserContext) {
  return (await openExtensionOptions(context)).page;
}
async function login(page: Page, binding: import('./real-stack.js').FixtureReplicaBinding) {
  await installFixtureReplicaBinding(page, binding);
  await signInExtension(page);
}
async function grantBookmarks(page: Page) {
  await showOptionsPane(page, 'folders');
  await grantOptionalBookmarks(page, 'Allow bookmark access', 'Known FO-04 favicon');
}
async function evidence<T = unknown>(page: Page, method: string, ...args: unknown[]): Promise<T> {
  const result = await page.evaluate(
    ({ method, args }) => chrome.runtime.sendMessage({ kind: 'known.sync-state.evidence', method, args }),
    { method, args }) as any;
  if (!result.ok) throw new Error(result.error); return result.value as T;
}
/** Chromium loads <link rel=icon> asynchronously; wait until the active tab exposes favIconUrl. */
async function waitForTabFavicon(page: Page) {
  await expect.poll(async () => page.evaluate(() => chrome.tabs.query({ active: true, currentWindow: true })
    .then((tabs) => tabs[0]?.favIconUrl ?? '')), { timeout: 30_000 }).toContain('known.example');
}
/** Real SW native save (the same handler the context-menu save drives). */
async function nativeSave(page: Page) {
  const result = await page.evaluate(async () => {
    const response = await chrome.runtime.sendMessage(
      { kind: 'known.save.native', entry: 'page', userGesture: true });
    return response as { readonly ok: boolean; readonly error?: string; readonly nativeIds?: readonly string[] };
  });
  if (!result.ok) throw new Error(result.error ?? 'native_save_failed');
}
async function drain(page: Page) {
  await page.evaluate(() => chrome.runtime.sendMessage({ kind: 'known.favicon.drain' }));
}
/** Repeatedly wake + drain until the predicate's string form contains `needle`. */
async function drainUntil(page: Page, predicate: () => Promise<unknown>, needle: string | number) {
  await expect.poll(async () => {
    await evidence(page, 'wakeDurableEngineEvidence');
    await drain(page);
    const value = await predicate();
    return String(value);
  }, { timeout: 90_000 }).toContain(String(needle));
}
/** The sidecar needs a real (non-pending) mapping before the drain can POST. */
async function waitForMappedSave(page: Page) {
  try {
    await expect.poll(async () => {
      await evidence(page, 'wakeDurableEngineEvidence');
      const value = await evidence<any>(page, 'exportOutboundPushEvidence');
      const queue = value.queue ?? [];
      const committed = queue.some((item: any) => item.status === 'terminal'
        && item.payload.type === 'create_node' && String(item.payload.payload?.node?.url ?? item.payload.url ?? '') === SITE_URL);
      return committed ? 'mapped' : 'pending';
    }, { timeout: 120_000 }).toBe('mapped');
  } catch (error) {
    const value = await evidence<any>(page, 'exportOutboundPushEvidence');
    const engine = await evidence<any>(page, 'syncEngineState');
    const summary = {
      queue: value.queue.map((item: any) => ({ sequence: item.sequence, status: item.status,
        type: item.payload.type, url: item.payload.payload?.node?.url ?? item.payload.url })),
      mappings: value.mappings.map((item: any) => ({ nativeId: item.nativeId, colpId: item.colpId })),
      engine,
    };
    throw new Error(`save_mapping_timeout:${JSON.stringify(summary)}`, { cause: error });
  }
}
async function showOptionsPane(page: Page, pane: 'folders' | 'sync-center') {
  const { showOptionsPane } = await import('./extension-auth.js');
  await showOptionsPane(page, pane);
}
