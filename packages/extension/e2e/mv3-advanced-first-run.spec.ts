/** P1-01 advanced first-run coverage through the real options UI. */
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { showOptionsPane } from './extension-auth.js';
import { withSyncFailureDetails } from './sync-failure-diagnostics.js';
import {
  KNS08_BINDINGS, PUBLIC_URL, assertQueueTerminal, captureReplayFacts, collectLogs, evidence,
  grantBookmarks, launchPersistent, liveCanonical, liveTitles, login, optionsPage, saveReplayFixture,
  screenshotRedacted, scopeFacts, specialRoots, startRealStack, terminateWorker, waitEngineReady,
  waitFirstRunProductQuiet, waitTitles, waitTitlesGone, writeScenarioEvidence, sha, type ProfileBinding, type RealStack,
} from './kns-08-harness.js';

test.describe.configure({ timeout: 600_000 });

const bindingA = KNS08_BINDINGS[0];
const bindingB = KNS08_BINDINGS[1];

test('P1-01 upload uses the UI, lists cloud deletions, and resumes after lost response and profile restart', async ({}, testInfo) => {
  const id = 'P1-01-advanced-upload-restart';
  const stack = await startRealStack(); const dirs = await twinDirs();
  let a: BrowserContext | undefined; let b: BrowserContext | undefined;
  try {
    a = await launchPersistent(dirs.a, stack.browserHostResolverRules);
    const pageA = await ready(a, bindingA); const rootsA = await specialRoots(pageA);
    const cloud = await pageA.evaluate(async ({ barId, url }) => {
      const folder = await chrome.bookmarks.create({ parentId: barId, title: 'P1 cloud folder' });
      const bookmark = await chrome.bookmarks.create({ parentId: folder.id, title: 'P1 cloud bookmark', url });
      return { folderId: folder.id, bookmarkId: bookmark.id };
    }, { barId: rootsA.barId, url: `${PUBLIC_URL}/cloud` });
    await chooseRoots(pageA, [rootsA.barTitle]); await pageA.locator('#first-run-start').click();
    await waitFirstRunProductQuiet(pageA, stack, bindingA);
    const remoteBefore = (await liveCanonical(stack)).find((node) => node.title === 'P1 cloud bookmark');
    expect(remoteBefore?.id).toBeTruthy();

    b = await launchPersistent(dirs.b, stack.browserHostResolverRules);
    const pageB = await ready(b, bindingB); const rootsB = await specialRoots(pageB);
    const local = await pageB.evaluate(async ({ barId, otherId }) => {
      const folder = await chrome.bookmarks.create({ parentId: barId, title: 'P1 local folder' });
      const bookmark = await chrome.bookmarks.create({ parentId: folder.id, title: 'P1 local bookmark', url: 'https://example.test/p1/local' });
      await chrome.bookmarks.create({ parentId: otherId, title: 'P1 unselected sentinel', url: 'https://sentinel.invalid/p1' });
      return { folderId: folder.id, bookmarkId: bookmark.id };
    }, { barId: rootsB.barId, otherId: rootsB.otherId });
    await waitEngineReady(pageB);
    await chooseRoots(pageB, [rootsB.barTitle]);
    const before = await observationBaseline(pageB, stack);
    await pageB.locator('#first-run-advanced summary').click();
    await pageB.locator('#first-run-advanced-mode').selectOption('preview-only');
    await pageB.locator('#first-run-advanced-preview').click();
    await expect(pageB.locator('#first-run-advanced-hint')).toContainText('1 matched item');
    await expect(pageB.locator('#first-run-advanced-confirm')).toBeHidden();
    expect(await observationBaseline(pageB, stack)).toEqual(before);
    const deleteLabels = await openAdvancedPreview(pageB, 'upload');
    expect(deleteLabels).toEqual(expect.arrayContaining(['Know-N · folder · P1 cloud folder', 'Know-N · bookmark · P1 cloud bookmark']));
    expect(deleteLabels.join('\n')).not.toContain('P1 unselected sentinel');
    const afterPreview = await observationBaseline(pageB, stack);
    expect(afterPreview.exported).toEqual(before.exported);
    expect(afterPreview.tree).toEqual(before.tree);
    expect(afterPreview.canonical).toEqual(before.canonical);
    expect(afterPreview.pushes).toEqual(before.pushes);

    await stack.commitAfterDisconnect();
    stack.setPushFault('timeout_once');
    await confirmAdvancedThroughUi(pageB);
    await expect.poll(async () => {
      const exported = await evidence<Record<string, unknown>>(pageB, 'exportOutboundPushEvidence');
      return Array.isArray(exported.advancedPlans) && exported.advancedPlans.length > 0 ? 'active' : 'pending';
    }, { timeout: 30_000 }).toBe('active');
    await expect.poll(() => liveTitles(stack), { timeout: 60_000 }).toContain('P1 local folder');
    await terminateWorker(b, pageB); await b.close(); b = undefined;
    await stack.restorePushResponses();
    b = await launchPersistent(dirs.b, stack.browserHostResolverRules);
    const pageB2 = await optionsPage(b);
    await expect(pageB2.locator('body')).toHaveAttribute('data-state', 'connected', { timeout: 30_000 });
    await withSyncFailureDetails(pageB2, 'advanced-upload: await resumed native and canonical convergence', () => waitAdvancedQuiet(pageB2, 150_000));
    await expectAdvancedComplete(pageB2);

    await waitTitlesGone(pageA, ['P1 cloud folder', 'P1 cloud bookmark'], 120_000);
    await waitTitles(pageA, ['P1 local folder', 'P1 local bookmark'], 120_000);
    const treeB = await nativeTree(pageB2);
    expect(treeB.titles.filter((title) => title === 'P1 local bookmark')).toHaveLength(1);
    expect(treeB.titles).toContain('P1 unselected sentinel');
    expect((await liveTitles(stack)).filter((title) => title === 'P1 local bookmark')).toHaveLength(1);
    expect((await liveTitles(stack)).some((title) => title === 'P1 unselected sentinel')).toBe(false);
    const factsA = await scopeFacts(pageA, stack, bindingA); const factsB = await scopeFacts(pageB2, stack, bindingB);
    assertQueueTerminal(factsA); assertQueueTerminal(factsB);
    const exportedB = await evidence<Record<string, unknown>>(pageB2, 'exportOutboundPushEvidence');
    const mapping = records(exportedB.mappings).find((row) => row.nativeId === local.bookmarkId);
    expect(mapping?.colpId).toBeTruthy();
    expect((await liveCanonical(stack)).find((node) => node.id === mapping?.colpId)?.title).toBe('P1 local bookmark');
    expect((await stack.listDeletedCanonicalNodes()).find((node) => node.id === remoteBefore?.id)?.titlePresent).toBe(true);
    expect(repeatedPushDigest(await stack.observations(), before.pushes.length)).toBe(true);
    await screenshotRedacted(pageB2, testInfo, id);
    await writeScenarioEvidence({ testInfo, id, startDigest: before.tree.digest, ops: ['ui-preview-upload', 'lost-push', 'profile-restart'],
      endTree: { a: await nativeTree(pageA), b: treeB }, mapping: { a: factsA.mappingCount, b: factsB.mappingCount },
      cursor: factsB.cursor, receipt: { a: factsA.receiptCount, b: factsB.receiptCount }, logs: collectLogs(b),
      extraRedact: [stack.authUserId, 'https://sentinel.invalid/p1'] });
  } catch (error) {
    const facts = b ? await captureReplayFacts(await optionsPage(b), stack, bindingB).catch((cause) => ({ error: String(cause) })) : {};
    await saveReplayFixture(testInfo, id, error, { facts, advanced: b ? await advancedReplay(await optionsPage(b)) : null }); throw error;
  } finally { await closeAll(a, b); await stack.close(); await rmDirs(dirs); }
});

test('P1-01 download uses the UI and binds the original remote Node while deleting local leaves', async ({}, testInfo) => {
  const id = 'P1-01-advanced-download';
  const stack = await startRealStack(); const dirs = await twinDirs();
  let a: BrowserContext | undefined; let b: BrowserContext | undefined;
  try {
    a = await launchPersistent(dirs.a, stack.browserHostResolverRules);
    const pageA = await ready(a, bindingA); const rootsA = await specialRoots(pageA);
    await pageA.evaluate(async ({ barId, url }) => {
      const folder = await chrome.bookmarks.create({ parentId: barId, title: 'P1 remote folder' });
      await chrome.bookmarks.create({ parentId: folder.id, title: 'P1 remote bookmark', url });
    }, { barId: rootsA.barId, url: `${PUBLIC_URL}/remote` });
    await chooseRoots(pageA, [rootsA.barTitle]); await pageA.locator('#first-run-start').click();
    await waitFirstRunProductQuiet(pageA, stack, bindingA);
    const remoteBookmark = (await liveCanonical(stack)).find((node) => node.title === 'P1 remote bookmark');
    expect(remoteBookmark?.id).toBeTruthy();

    b = await launchPersistent(dirs.b, stack.browserHostResolverRules);
    const pageB = await ready(b, bindingB); const rootsB = await specialRoots(pageB);
    const local = await pageB.evaluate(async ({ barId, otherId }) => {
      const folder = await chrome.bookmarks.create({ parentId: barId, title: 'P1 remove folder' });
      const bookmark = await chrome.bookmarks.create({ parentId: folder.id, title: 'P1 remove bookmark', url: 'https://example.test/p1/remove' });
      await chrome.bookmarks.create({ parentId: otherId, title: 'P1 download sentinel', url: 'https://sentinel.invalid/p1-download' });
      return { folderId: folder.id, bookmarkId: bookmark.id };
    }, { barId: rootsB.barId, otherId: rootsB.otherId });
    await waitEngineReady(pageB); await chooseRoots(pageB, [rootsB.barTitle]);
    const before = await observationBaseline(pageB, stack); const labels = await openAdvancedPreview(pageB, 'download');
    expect(labels).toEqual(expect.arrayContaining(['Browser · folder · P1 remove folder', 'Browser · bookmark · P1 remove bookmark']));
    expect(labels.join('\n')).not.toContain('P1 download sentinel');
    const afterPreview = await observationBaseline(pageB, stack);
    expect(afterPreview.exported).toEqual(before.exported); expect(afterPreview.tree).toEqual(before.tree);
    await confirmAdvancedThroughUi(pageB);
    await withSyncFailureDetails(pageB, 'advanced-download: await native and canonical convergence', () => waitAdvancedQuiet(pageB, 120_000));
    await expectAdvancedComplete(pageB);
    await expect.poll(async () => (await nativeTree(pageB)).titles, { timeout: 60_000 })
      .toEqual(expect.arrayContaining(['P1 remote folder', 'P1 remote bookmark', 'P1 download sentinel']));
    const tree = await nativeTree(pageB);
    expect(tree.titles).not.toContain('P1 remove folder'); expect(tree.titles).not.toContain('P1 remove bookmark');
    expect(tree.titles.filter((title) => title === 'P1 remote bookmark')).toHaveLength(1);
    expect((await liveTitles(stack)).filter((title) => title === 'P1 remote bookmark')).toHaveLength(1);
    const exported = await evidence<Record<string, unknown>>(pageB, 'exportOutboundPushEvidence');
    const mapping = records(exported.mappings).find((row) => row.colpId === remoteBookmark?.id);
    expect(mapping?.nativeId).toBeTruthy(); expect(mapping?.nativeId).not.toMatch(/^unmounted:/u);
    const facts = await scopeFacts(pageB, stack, bindingB);
    expect(facts.queueStatuses.filter((status) => ['pending', 'claimed', 'deferred', 'blocked', 'unknown', 'rejected'].includes(status))).toEqual([]);
    expect(facts.queueTypes).toEqual([]);
    expect(await liveCanonical(stack)).toEqual(before.canonical);
    assertQueueTerminal(await scopeFacts(pageA, stack, bindingA));
    await screenshotRedacted(pageB, testInfo, id);
    await writeScenarioEvidence({ testInfo, id, startDigest: before.tree.digest, ops: ['ui-preview-download', 'ui-confirm-download'],
      endTree: tree, mapping: { nativeId: mapping?.nativeId, remoteNodeId: remoteBookmark?.id }, cursor: facts.cursor,
      receipt: facts.receiptCount, logs: collectLogs(b), extraRedact: [stack.authUserId, 'https://sentinel.invalid/p1-download'] });
    void local;
  } catch (error) {
    const facts = b ? await captureReplayFacts(await optionsPage(b), stack, bindingB).catch((cause) => ({ error: String(cause) })) : {};
    await saveReplayFixture(testInfo, id, error, { facts, advanced: b ? await advancedReplay(await optionsPage(b)) : null }); throw error;
  } finally { await closeAll(a, b); await stack.close(); await rmDirs(dirs); }
});

for (const changedSide of ['local', 'remote'] as const) {
test(`P1-01 rejects a second confirmation after the ${changedSide} tree changes`, async ({}, testInfo) => {
  const id = `P1-01-advanced-stale-${changedSide}`;
  const stack = await startRealStack(); const dirs = await twinDirs();
  let a: BrowserContext | undefined; let b: BrowserContext | undefined;
  try {
    a = await launchPersistent(dirs.a, stack.browserHostResolverRules);
    const pageA = await ready(a, bindingA); const rootsA = await specialRoots(pageA);
    await pageA.evaluate(async ({ barId, url }) => chrome.bookmarks.create({ parentId: barId, title: 'P1 stale remote', url: `${url}/stale` }), { barId: rootsA.barId, url: PUBLIC_URL });
    await chooseRoots(pageA, [rootsA.barTitle]); await pageA.locator('#first-run-start').click();
    await waitFirstRunProductQuiet(pageA, stack, bindingA);
    b = await launchPersistent(dirs.b, stack.browserHostResolverRules);
    const pageB = await ready(b, bindingB); const rootsB = await specialRoots(pageB);
    const local = await pageB.evaluate(async ({ barId }) => chrome.bookmarks.create({ parentId: barId, title: 'P1 stale local', url: 'https://example.test/p1/stale-local' }), { barId: rootsB.barId });
    await waitEngineReady(pageB); await chooseRoots(pageB, [rootsB.barTitle]);
    const before = await observationBaseline(pageB, stack); await openAdvancedPreview(pageB, 'download');
    if (changedSide === 'local') {
      await pageB.evaluate((id) => chrome.bookmarks.update(id, { title: 'P1 edited after preview' }), local.id);
    } else {
      await pageA.evaluate((parentId) => chrome.bookmarks.create({ parentId, title: 'P1 cloud changed after preview',
        url: 'https://example.test/p1/cloud-change' }), rootsA.barId);
      await expect.poll(() => liveTitles(stack), { timeout: 30_000 }).toContain('P1 cloud changed after preview');
    }
    const canonicalBeforeConfirmation = await liveCanonical(stack);
    const rejected = await confirmAdvancedThroughUi(pageB, false);
    expect(rejected.error).toBe('preview_stale');
    await expect(pageB.locator('#first-run-error')).toContainText(/Review .*again before confirming/u, { timeout: 30_000 });
    // The UI loads a fresh preview, but still needs a new explicit confirmation.
    await expect(pageB.locator('#first-run-advanced-confirm')).toBeEnabled();
    const exported = await evidence<Record<string, unknown>>(pageB, 'exportOutboundPushEvidence');
    expect(exported.advancedPlans ?? []).toEqual([]);
    expect(await liveCanonical(stack)).toEqual(canonicalBeforeConfirmation);
    expect((await nativeTree(pageB)).titles).toContain(changedSide === 'local' ? 'P1 edited after preview' : 'P1 stale local');
    await screenshotRedacted(pageB, testInfo, id);
    await writeScenarioEvidence({ testInfo, id, startDigest: before.tree.digest, ops: ['ui-preview-download', `${changedSide}-edit`, 'stale-confirmation'],
      endTree: await nativeTree(pageB), mapping: { advancedPlans: exported.advancedPlans ?? [] }, cursor: null, receipt: 0,
      logs: collectLogs(b), extraRedact: [stack.authUserId] });
  } catch (error) {
    const facts = b ? await captureReplayFacts(await optionsPage(b), stack, bindingB).catch((cause) => ({ error: String(cause) })) : {};
    await saveReplayFixture(testInfo, id, error, { facts, advanced: b ? await advancedReplay(await optionsPage(b)) : null }); throw error;
  } finally { await closeAll(a, b); await stack.close(); await rmDirs(dirs); }
});
}

async function ready(context: BrowserContext, binding: ProfileBinding): Promise<Page> {
  const page = await optionsPage(context); await login(page, binding); await grantBookmarks(page); return page;
}

async function chooseRoots(page: Page, selectedTitles: readonly string[]): Promise<void> {
  await showOptionsPane(page, 'folders'); await page.getByRole('button', { name: 'Refresh folders' }).click();
  await expect(page.locator('#root-tree .root-row').first()).toBeVisible({ timeout: 30_000 });
  // First-run defaults cover every writable root. A scenario that selects Bar
  // alone must explicitly clear Other too, or its sentinel is genuinely in scope.
  await page.locator('#tree-clear-selection').click();
  for (const title of selectedTitles) {
    const checkbox = page.getByRole('checkbox', { name: title, exact: true });
    await expect(checkbox).toBeVisible({ timeout: 30_000 });
    if (!(await checkbox.isChecked())) await checkbox.click();
  }
  const selected = await page.locator('#root-tree .root-row[data-depth="0"] .root-select input:checked')
    .evaluateAll(inputs => inputs.map(input => input.getAttribute('aria-label')));
  expect(selected.sort()).toEqual([...selectedTitles].sort());
  await expect(page.locator('#first-run-start')).toBeEnabled({ timeout: 30_000 });
}

async function openAdvancedPreview(page: Page, mode: 'upload' | 'download'): Promise<string[]> {
  const advanced = page.locator('#first-run-advanced');
  if (!await advanced.evaluate((node) => (node as HTMLDetailsElement).open)) await advanced.locator('summary').click();
  await page.locator('#first-run-advanced-mode').selectOption(mode);
  await expect(page.locator('#first-run-advanced-preview')).toBeEnabled({ timeout: 30_000 });
  await page.locator('#first-run-advanced-preview').click();
  try {
    await expect.poll(async () => page.locator('#first-run-delete-list li').count(), { timeout: 30_000 }).toBeGreaterThan(0);
  } catch (error) {
    const message = await page.locator('#first-run-error').textContent().catch(() => '');
    const hint = await page.locator('#first-run-advanced-hint').textContent().catch(() => '');
    throw new Error(`${error instanceof Error ? error.message : String(error)}; advancedError=${message ?? ''}; advancedHint=${hint ?? ''}`);
  }
  await expect(page.locator('#first-run-advanced-confirm')).toBeEnabled({ timeout: 30_000 });
  return page.locator('#first-run-delete-list li').allTextContents();
}

async function confirmAdvancedThroughUi(page: Page, expectedOk = true): Promise<{ ok: boolean; error?: string }> {
  const response = page.evaluate(() => new Promise<unknown>((resolve) => {
    const original = chrome.runtime.sendMessage;
    chrome.runtime.sendMessage = ((...args: unknown[]) => {
      const result: unknown = Reflect.apply(original, chrome.runtime, args);
      const message = args[0] as { readonly kind?: string } | undefined;
      if (message?.kind === 'known.firstRun.confirm') {
        chrome.runtime.sendMessage = original;
        Promise.resolve(result).then(resolve, () => resolve({ ok: false, error: 'transport_rejected' }));
      }
      return result;
    }) as typeof chrome.runtime.sendMessage;
  }));
  await page.locator('#first-run-advanced-confirm').click();
  const result = await response;
  expect(result).toMatchObject({ ok: expectedOk });
  return result as { ok: boolean; error?: string };
}

async function advancedReplay(page: Page): Promise<unknown> {
  try {
    const exported = await evidence<Record<string, unknown>>(page, 'exportOutboundPushEvidence');
    const native = await page.evaluate(() => chrome.bookmarks.getTree());
    const data = { plans: exported.advancedPlans, steps: exported.advancedSteps, mappings: exported.mappings,
      engine: exported.engine, observations: exported.remoteObservations, native };
    return JSON.parse(JSON.stringify(data, (key, value: unknown) =>
      typeof value === 'string' && (/id$/iu.test(key) || key === 'scopeKey' || key === 'title' || key === 'url')
        ? `hash:${sha(value).slice(0, 12)}` : value));
  } catch { return { unavailable: true }; }
}

async function expectAdvancedComplete(page: Page): Promise<void> {
  const exported = await evidence<{ advancedPlans: Array<{ state: string }>; advancedSteps: Array<{ state: string; error?: string }> }>(page, 'exportOutboundPushEvidence');
  expect(exported.advancedPlans.map((plan) => plan.state), JSON.stringify(exported.advancedSteps.map((step) =>
    ({ state: step.state, error: step.error })))).toEqual(['completed']);
  expect(exported.advancedSteps.every((step) => step.state === 'terminal')).toBe(true);
}

async function waitAdvancedQuiet(page: Page, timeout: number): Promise<void> {
  await expect.poll(async () => {
    const data = await evidence<{
      advancedPlans: Array<{ state: string }>; advancedSteps: Array<{ state: string; error?: string }>;
      queue: Array<{ status: string }>; bookmarkEvents: Array<{ status: string }>;
      ackIntents: Array<{ state: string }>; scope: { firstRun?: string };
      engine?: { phase: string; recoveryFrozen: boolean; lastPublishedCursor?: string; lastAckedCursor?: string };
    }>(page, 'exportOutboundPushEvidence');
    const engine = data.engine;
    const attention = data.advancedSteps.find((step) => step.state === 'attention');
    if (attention) return `attention:${attention.error ?? 'unknown'}`;
    const complete = data.advancedPlans.length === 1 && data.advancedPlans[0]?.state === 'completed'
      && data.advancedSteps.every((step) => step.state === 'terminal') && data.scope.firstRun === 'completed';
    const settled = data.queue.every((row) => row.status === 'terminal')
      && data.bookmarkEvents.every((row) => row.status === 'processed')
      && data.ackIntents.every((row) => row.state === 'complete');
    return complete && settled && engine && ['sleeping', 'idle'].includes(engine.phase)
      && !engine.recoveryFrozen && typeof engine.lastPublishedCursor === 'string'
      && engine.lastPublishedCursor === engine.lastAckedCursor ? 'quiet' : 'pending';
  }, { timeout }).toBe('quiet');
}

async function nativeTree(page: Page): Promise<{ readonly digest: string; readonly titles: readonly string[] }> {
  const tree = await page.evaluate(async () => {
    const walk = (nodes: chrome.bookmarks.BookmarkTreeNode[]): unknown[] => nodes.map((node) => ({
      id: node.id, parentId: node.parentId ?? null, title: node.title ?? '', url: node.url ?? null,
      children: node.children ? walk(node.children) : [],
    }));
    return walk(await chrome.bookmarks.getTree());
  });
  const titles: string[] = []; const collect = (value: unknown): void => {
    if (!Array.isArray(value)) return;
    for (const node of value) if (node && typeof node === 'object' && !Array.isArray(node)) {
      const row = node as { title?: unknown; children?: unknown }; if (typeof row.title === 'string') titles.push(row.title);
      collect(row.children);
    }
  };
  collect(tree); return { digest: sha(JSON.stringify(tree)), titles };
}

async function observationBaseline(page: Page, stack: RealStack): Promise<{
  readonly exported: unknown; readonly tree: Awaited<ReturnType<typeof nativeTree>>;
  readonly canonical: readonly Record<string, unknown>[]; readonly pushes: readonly unknown[];
}> {
  const observations = await stack.observations();
  // The evidence endpoint is named exportOutboundPushEvidence; it returns
  // the exact store export produced by exportScope for the current scope.
  return { exported: await evidence(page, 'exportOutboundPushEvidence'), tree: await nativeTree(page),
    canonical: await liveCanonical(stack), pushes: Array.isArray(observations.pushRequestDigests) ? observations.pushRequestDigests : [] };
}

function records(value: unknown): Array<{ readonly nativeId?: string; readonly colpId?: string }> {
  return Array.isArray(value) ? value.filter((row): row is { nativeId?: string; colpId?: string } =>
    Boolean(row) && typeof row === 'object' && !Array.isArray(row)) : [];
}

function repeatedPushDigest(observations: Record<string, unknown>, beforeCount: number): boolean {
  if (!Array.isArray(observations.pushRequestDigests)) return false;
  const counts = new Map<string, number>();
  for (const value of observations.pushRequestDigests.slice(beforeCount)) { const digest = String(value); counts.set(digest, (counts.get(digest) ?? 0) + 1); }
  return [...counts.values()].some((count) => count > 1);
}

async function twinDirs(): Promise<{ readonly a: string; readonly b: string }> {
  return { a: await mkdtemp(resolve(tmpdir(), 'known-p1-advanced-a-')), b: await mkdtemp(resolve(tmpdir(), 'known-p1-advanced-b-')) };
}
async function closeAll(...contexts: Array<BrowserContext | undefined>): Promise<void> {
  await Promise.all(contexts.map(async (context) => { if (context) await context.close().catch(() => undefined); }));
}
async function rmDirs(dirs: { readonly a: string; readonly b: string }): Promise<void> {
  await Promise.all([rm(dirs.a, { recursive: true, force: true }), rm(dirs.b, { recursive: true, force: true })]);
}
