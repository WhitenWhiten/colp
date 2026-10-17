/**
 * KNS-08 first-run / dual-Profile matrix.
 * Owner: KNS-08 (QA). Fixture: e2e/real-stack.ts + profileA/profileB persistent Chromium.
 * Run: npm run evidence:first-run-sync
 * Evidence: test-results/known-extension-first-run-sync/<commit>/
 *
 * kns08:KNS-08-AC-01-preview-zero-mutation kns08:KNS-08-AC-02-dual-root-mount
 * kns08:KNS-08-AC-02-nested-boundary kns08:KNS-08-AC-03-empty-bootstrap
 * kns08:KNS-08-AC-03-nonempty-merge kns08:KNS-08-AC-04-offline-queue
 * kns08:KNS-08-AC-04-lost-push kns08:KNS-08-AC-04-concurrent-move
 * kns08:KNS-08-AC-05-pull-interrupt kns08:KNS-08-AC-06-ab-fork
 * kns08:KNS-08-AC-06-duplicate-candidate kns08:KNS-08-AC-06-field-conflict
 * kns08:KNS-08-AC-08-unselected-not-uploaded kns08:KNS-08-AC-09-permission-revoke
 */
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import {
  KNS08_BINDINGS, PUBLIC_URL, UNSELECTED_SENTINEL, UNSELECTED_URL, assertNoSentinel, assertPushEnvelopeReused,
  assertQueueTerminal, bookmarkPlacement, captureReplayFacts, collectLogs, confirmFirstRun, confirmPreview,
  evidence, grantBookmarks, launchPersistent, liveCanonical, liveTitles, login, optionsPage, previewFirstRun,
  restoreConnectivity, revokeBookmarks, saveReplayFixture, screenshotRedacted, specialRoots, startRealStack,
  scopeFacts, terminateWorker, treeProjection, waitFirstRunProductQuiet, waitNonterminalQueue, waitQueueQuiet,
  waitTitles, wakeEngine, writeScenarioEvidence, type ProfileBinding, type RealStack,
} from './kns-08-harness.js';
import { resolveIncomingConflict } from './kns-08-conflict.js';
import { seedPreexistingBookmarks } from './preexisting-bookmarks.js';
import { knowNBackendRoot } from './cloud-product-fixtures.js';

const bindingA = KNS08_BINDINGS[0];
const bindingB = KNS08_BINDINGS[1];

test.describe.configure({ timeout: 600_000 });

test('first-run sync uploads selected ordinary folders as custom mounts', async () => {
  const stack = await startRealStack();
  const dirs = await twinDirs();
  let context: BrowserContext | undefined;
  try {
    context = await launchPersistent(dirs.a, stack.browserHostResolverRules);
    const page = await ready(context, bindingA);
    const roots = await specialRoots(page);
    await page.evaluate(async (parentId) => {
      for (const title of ['Selected ordinary folder A', 'Selected ordinary folder B']) {
        const folder = await chrome.bookmarks.create({ parentId, title });
        await chrome.bookmarks.create({ parentId: folder.id, title: `${title} bookmark`, url: 'https://example.test/custom-mount' });
      }
    }, roots.barId);
    const preview = await previewFirstRun(page, ['Selected ordinary folder A', 'Selected ordinary folder B']);
    expect(preview.bookmarkCount).toBe(2);
    const stale = await page.evaluate(async (previewId) => chrome.runtime.sendMessage({
      kind: 'known.firstRun.confirm', previewId, confirmationId: crypto.randomUUID(), libraryId: 'different-library',
    }), preview.previewId);
    expect(stale).toEqual({ ok: false, error: 'bootstrap_confirmation_stale' });
    expect((await liveCanonical(stack)).map(node => node.folder_role).sort()).toEqual(['bookmarks-bar', 'other-bookmarks']);
    await confirmPreview(page, preview.previewId);
    await waitFirstRunProductQuiet(page, stack, bindingA);
    const live = await liveCanonical(stack);
    expect(live.filter(node => String(node.title ?? '').endsWith(' bookmark'))).toHaveLength(2);
    expect((await scopeFacts(page, stack, bindingA)).receiptCount).toBeGreaterThan(0);
  } finally {
    await closeAll(context);
    await stack.close();
    await rmDirs(dirs);
  }
});

test('first-sync shares live bookmark creates and finishes nested uploads', async () => {
  const stack = await startRealStack();
  const dirs = await twinDirs();
  let context: BrowserContext | undefined;
  try {
    context = await launchPersistent(dirs.a, stack.browserHostResolverRules);
    const page = await ready(context, bindingA);
    const roots = await specialRoots(page);
    await page.evaluate(async parentId => {
      await chrome.bookmarks.create({ parentId, title: 'Initial bookmark', url: 'https://example.test/initial' });
      const parent = await chrome.bookmarks.create({ parentId, title: 'Nested upload parent' });
      for (const title of ['Nested A', 'Nested B']) {
        const child = await chrome.bookmarks.create({ parentId: parent.id, title });
        await chrome.bookmarks.create({ parentId: child.id, title: `${title} bookmark`,
          url: `https://example.test/nested-${title.endsWith('A') ? 'a' : 'b'}` });
      }
    }, roots.barId);
    const preview = await previewFirstRun(page, [roots.barTitle]);
    // Hold transport while both real producers see the new native bookmark.
    stack.setSyncOffline(true);
    await confirmPreview(page, preview.previewId);
    await expect.poll(async () => {
      const facts = await scopeFacts(page, stack, bindingA);
      return facts.firstRun === 'running' && facts.recoveryFrozen !== true;
    }, { timeout: 30_000 }).toBe(true);
    const added = await page.evaluate(parentId => chrome.bookmarks.create({ parentId,
      title: 'Added during first sync', url: 'https://example.test/live-first-sync' }), roots.barId);
    await expect.poll(async () => {
      await page.evaluate(() => chrome.runtime.sendMessage({ kind: 'known.firstRun.status' }));
      const facts = await scopeFacts(page, stack, bindingA);
      return facts.queueOpIds.filter(opId => opId.endsWith(`.create.${added.id}`)).length;
    }, { timeout: 30_000 }).toBe(1);
    stack.setSyncOffline(false);
    await wakeEngine(page);
    const settled = await waitFirstRunProductQuiet(page, stack, bindingA);
    expect(settled.recoveryFrozen).toBe(false);
    expect(settled.cursor).toBe(settled.ackedCursor);
    const live = await liveCanonical(stack);
    expect(live.filter(node => node.url === 'https://example.test/live-first-sync')).toHaveLength(1);
    for (const suffix of ['a', 'b']) {
      const child = live.find(node => node.title === `Nested ${suffix.toUpperCase()}`)!;
      expect(child).toBeDefined();
      expect(live.filter(node => node.url === `https://example.test/nested-${suffix}`)
        .map(node => node.parent_id)).toEqual([child.id]);
    }
    const exported = await evidence<any>(page, 'exportOutboundPushEvidence');
    expect(exported.queue.filter((row: any) => row.payload.type === 'create_node'
      && row.payload.payload.node.url === 'https://example.test/live-first-sync')).toHaveLength(1);
    expect(exported.mappings.filter((row: any) => row.nativeId === added.id)).toHaveLength(1);
  } finally {
    await closeAll(context);
    await stack.close();
    await rmDirs(dirs);
  }
});

test('KNS-08-AC-01/02/03/08 first-run preview is local then dual-mount bootstrap skips unselected', async ({}, testInfo) => {
  const id = 'KNS-08-AC-01-preview-zero-mutation';
  const stack = await startRealStack();
  const dirs = await twinDirs();
  let a: BrowserContext | undefined;
  try {
    if (!knowNBackendRoot) await seedPreexistingBookmarks(dirs.a, 100);
    a = await launchPersistent(dirs.a, stack.browserHostResolverRules);
    const logs = collectLogs(a);
    const page = await ready(a, bindingA);
    const roots = await specialRoots(page);
    const localOnlyTitle = 'KNS08 local-only';
    await page.evaluate(async ({ barId, otherId, url, localOnlyTitle, sentinelTitle, sentinelUrl }) => {
      await chrome.bookmarks.create({ parentId: barId, title: 'KNS08 bar public', url });
      await chrome.bookmarks.create({ parentId: otherId, title: 'KNS08 other public', url: `${url}/other` });
      const localOnly = await chrome.bookmarks.create({ parentId: otherId, title: localOnlyTitle });
      await chrome.bookmarks.create({ parentId: localOnly.id, title: sentinelTitle, url: sentinelUrl });
    }, {
      barId: roots.barId, otherId: roots.otherId, url: PUBLIC_URL, localOnlyTitle,
      sentinelTitle: UNSELECTED_SENTINEL, sentinelUrl: UNSELECTED_URL,
    });
    const start = await treeProjection(page);
    const before = await stack.observations() as { pushRequestDigests?: unknown[]; canonicalNodes?: unknown[] };
    expect(before.pushRequestDigests ?? []).toEqual([]);
    expect((await liveCanonical(stack)).map(node => node.folder_role).sort()).toEqual(['bookmarks-bar', 'other-bookmarks']);
    const preview = await previewFirstRun(page, [roots.barTitle, roots.otherTitle], [localOnlyTitle]);
    expect(preview.bookmarkCount).toBeGreaterThanOrEqual(2);
    expect(preview.skippedCount).toBeGreaterThan(0);
    expect(preview.treeDigest).toMatch(/^sha256:/u);
    const afterPreview = await stack.observations() as { pushRequestDigests?: unknown[] };
    expect(afterPreview.pushRequestDigests ?? []).toEqual([]);
    expect((await liveCanonical(stack)).map(node => node.folder_role).sort()).toEqual(['bookmarks-bar', 'other-bookmarks']);
    const confirmationId = crypto.randomUUID();
    await confirmPreview(page, preview.previewId, confirmationId);
    await waitFirstRunProductQuiet(page, stack, bindingA);
    const facts = await scopeFacts(page, stack, bindingA);
    const live = await liveCanonical(stack);
    expect(facts.mountRoles).toEqual(expect.arrayContaining(['bookmarks-bar', 'other-bookmarks']));
    expect(facts.mappingCount).toBeGreaterThan(0);
    expect(facts.receiptCount).toBeGreaterThan(0);
    expect(live.some((node) => node.parent_id === 'p3-27-root' && String(node.title ?? '').includes('KNS08'))).toBe(false);
    const observed = await stack.observations() as { canonicalNodes?: Array<{ title?: string; url?: string }> };
    if (!knowNBackendRoot) {
      const transport = await stack.observations() as { pushRequests: Array<{ body: string; responseStatus?: number }> };
      const sizes = transport.pushRequests.map(request => JSON.parse(request.body).operations.length);
      const operations = transport.pushRequests.flatMap(request => JSON.parse(request.body).operations) as
        Array<{ opId: string; dependencies: unknown[]; payload: { afterId?: unknown; beforeId?: unknown; node?: { folderRole?: string } } }>;
      expect(sizes.some(size => size > 1)).toBe(true);
      expect(sizes.length).toBeLessThanOrEqual(16);
      expect(sizes.every(size => size <= 50)).toBe(true);
      expect(live.filter(node => String(node.title ?? '').startsWith('KNS08 batched '))).toHaveLength(100);
      expect(transport.pushRequests.every(request => request.responseStatus === 200)).toBe(true);
      await testInfo.attach('sync-batch-metrics', { contentType: 'application/json',
        body: Buffer.from(JSON.stringify({ operations: sizes.reduce((a, b) => a + b, 0),
          requests: sizes.length, sizes, bootstrap: operations.filter(op => op.opId.startsWith('b3.')).length,
          dependent: operations.filter(op => op.dependencies.length).length,
          anchored: operations.filter(op => op.payload.afterId != null || op.payload.beforeId != null).length,
          mounts: operations.filter(op => op.payload.node?.folderRole !== undefined).length })) });
    }
    const blob = JSON.stringify(observed.canonicalNodes ?? []);
    expect(blob).not.toContain(UNSELECTED_SENTINEL);
    expect(blob).not.toContain(UNSELECTED_URL);
    assertNoSentinel(logs, [UNSELECTED_SENTINEL, UNSELECTED_URL]);
    await screenshotRedacted(page, testInfo, id);
    await writeScenarioEvidence({
      testInfo, id, startDigest: start.digest, ops: ['preview-zero-mutation', 'confirm-dual-mount', 'empty-bootstrap'],
      endTree: { digest: (await treeProjection(page)).digest, bookmarkCount: start.bookmarkCount },
      mapping: { count: facts.mappingCount, mounts: facts.mountRoles }, cursor: facts.cursor,
      receipt: { count: facts.receiptCount, queue: facts.queueTypes }, logs,
      extraRedact: [stack.authUserId, UNSELECTED_URL],
    });
  } catch (error) {
    const facts = a ? await captureReplayFacts(await optionsPage(a), stack, bindingA).catch((cause) => ({
      owner: 'unknown', error: cause instanceof Error ? cause.message : String(cause),
    })) : { owner: 'unknown' };
    await saveReplayFixture(testInfo, id, error, facts);
    throw error;
  } finally { await closeAll(a); await stack.close(); await rmDirs(dirs); }
});

test('KNS-08-AC-02 nested boundary collapses parent+child to one mount', async ({}, testInfo) => {
  const id = 'KNS-08-AC-02-nested-boundary';
  const stack = await startRealStack();
  const dirs = await twinDirs();
  let a: BrowserContext | undefined;
  try {
    a = await launchPersistent(dirs.a, stack.browserHostResolverRules);
    const logs = collectLogs(a);
    const page = await ready(a, bindingA);
    const roots = await specialRoots(page);
    const nestedTitle = await page.evaluate(async (barId) => {
      const folder = await chrome.bookmarks.create({ parentId: barId, title: 'KNS08 nested research' });
      await chrome.bookmarks.create({ parentId: folder.id, title: 'KNS08 nested paper',
        url: 'https://example.test/kns08/paper' });
      return folder.title ?? 'KNS08 nested research';
    }, roots.barId);
    const start = await treeProjection(page);
    const preview = await previewFirstRun(page, [roots.barTitle, nestedTitle]);
    expect(preview.warnings.some((warning) => warning.code === 'nested_normalized')).toBe(true);
    await confirmPreview(page, preview.previewId);
    await waitFirstRunProductQuiet(page, stack, bindingA);
    const facts = await scopeFacts(page, stack, bindingA);
    expect(facts.mountRoles.filter((role) => role === 'bookmarks-bar').length).toBe(1);
    expect(facts.mountRoles.includes(nestedTitle)).toBe(false);
    await writeScenarioEvidence({
      testInfo, id, startDigest: start.digest, ops: ['select-parent-and-child', 'confirm'],
      endTree: { digest: (await treeProjection(page)).digest }, mapping: facts.mountRoles,
      cursor: facts.cursor, receipt: facts.queueTypes, logs, extraRedact: [stack.authUserId],
    });
  } catch (error) {
    const facts = a ? await captureReplayFacts(await optionsPage(a), stack, bindingA).catch((cause) => ({
      owner: 'unknown', error: cause instanceof Error ? cause.message : String(cause),
    })) : { owner: 'unknown' };
    await saveReplayFixture(testInfo, id, error, facts);
    throw error;
  } finally { await closeAll(a); await stack.close(); await rmDirs(dirs); }
});

test('KNS-08-AC-03/06 A/B nonempty merge keeps fork and duplicate candidates', async ({}, testInfo) => {
  const id = 'KNS-08-AC-06-ab-fork';
  const stack = await startRealStack();
  const dirs = await twinDirs();
  let a: BrowserContext | undefined; let b: BrowserContext | undefined;
  try {
    a = await launchPersistent(dirs.a, stack.browserHostResolverRules);
    b = await launchPersistent(dirs.b, stack.browserHostResolverRules);
    const logs = [...collectLogs(a), ...collectLogs(b)];
    const pageA = await ready(a, bindingA);
    const pageB = await ready(b, bindingB);
    const rootsA = await specialRoots(pageA);
    const rootsB = await specialRoots(pageB);
    await pageA.evaluate(async ({ barId, url }) => {
      await chrome.bookmarks.create({ parentId: barId, title: 'KNS08 shared', url });
      await chrome.bookmarks.create({ parentId: barId, title: 'KNS08 only A', url: `${url}/a` });
    }, { barId: rootsA.barId, url: PUBLIC_URL });
    await pageB.evaluate(async ({ barId, url }) => {
      await chrome.bookmarks.create({ parentId: barId, title: 'KNS08 shared', url });
      await chrome.bookmarks.create({ parentId: barId, title: 'KNS08 only B', url: `${url}/b` });
      const other = await chrome.bookmarks.create({ parentId: barId, title: 'KNS08 other folder' });
      await chrome.bookmarks.create({ parentId: other.id, title: 'KNS08 shared', url });
    }, { barId: rootsB.barId, url: PUBLIC_URL });
    const startA = await treeProjection(pageA);
    await confirmFirstRun(pageA, [rootsA.barTitle]);
    await waitFirstRunProductQuiet(pageA, stack, bindingA);
    await confirmFirstRun(pageB, [rootsB.barTitle]);
    await waitFirstRunProductQuiet(pageB, stack, bindingB);
    await wakeEngine(pageA); await wakeEngine(pageB);
    // A terminal outbound queue and a completed wake do not imply inbound
    // convergence: A may still be sleeping until its scheduled Pull. Observe
    // both native trees without bypassing the product's cooldown or alarms.
    await expect(async () => {
      const titles = await liveTitles(stack);
      expect(titles).toEqual(expect.arrayContaining(['KNS08 shared', 'KNS08 only A', 'KNS08 only B']));
      expect(titles.filter((title) => title === 'KNS08 shared').length).toBeGreaterThanOrEqual(2);
      const factsA = await scopeFacts(pageA, stack, bindingA);
      const factsB = await scopeFacts(pageB, stack, bindingB);
      expect(['completed', 'needs_attention']).toContain(factsA.bootstrapPhase ?? factsA.firstRun);
      expect(['completed', 'needs_attention']).toContain(factsB.bootstrapPhase ?? factsB.firstRun);
      assertQueueTerminal(factsA);
      assertQueueTerminal(factsB);
      expect(factsA.recoveryFrozen).toBe(false);
      expect(factsB.recoveryFrozen).toBe(false);
      const chromeA = (await treeProjection(pageA)).titles;
      const chromeB = (await treeProjection(pageB)).titles;
      expect(chromeA).toContain('KNS08 only A');
      expect(chromeA).toContain('KNS08 only B');
      expect(chromeB).toContain('KNS08 only A');
      expect(chromeB).toContain('KNS08 only B');
    }).toPass({ timeout: 60_000 });
    const factsA = await scopeFacts(pageA, stack, bindingA);
    const factsB = await scopeFacts(pageB, stack, bindingB);
    await writeScenarioEvidence({
      testInfo, id, startDigest: startA.digest, ops: ['A-bootstrap', 'B-merge'],
      endTree: { a: (await treeProjection(pageA)).digest, b: (await treeProjection(pageB)).digest },
      mapping: { a: factsA.mappingCount, b: factsB.mappingCount },
      cursor: factsB.cursor, receipt: factsB.receiptCount, logs, extraRedact: [stack.authUserId],
    });
  } catch (error) {
    const factsA = a ? await captureReplayFacts(await optionsPage(a), stack, bindingA).catch((cause) => ({
      owner: 'unknown', error: cause instanceof Error ? cause.message : String(cause),
    })) : { owner: 'unknown' };
    const factsB = b ? await captureReplayFacts(await optionsPage(b), stack, bindingB).catch((cause) => ({
      owner: 'unknown', error: cause instanceof Error ? cause.message : String(cause),
    })) : { owner: 'unknown' };
    await saveReplayFixture(testInfo, id, error, { a: factsA, b: factsB });
    throw error;
  } finally { await closeAll(a, b); await stack.close(); await rmDirs(dirs); }
});

test('KNS-08-AC-04/05/09 offline, lost push, pull interrupt, permission revoke', async ({}, testInfo) => {
  const id = 'KNS-08-AC-04-offline-queue';
  const stack = await startRealStack();
  const dirs = await twinDirs();
  let a: BrowserContext | undefined; let b: BrowserContext | undefined;
  try {
    a = await launchPersistent(dirs.a, stack.browserHostResolverRules);
    b = await launchPersistent(dirs.b, stack.browserHostResolverRules);
    const logs = collectLogs(a);
    const pageA = await ready(a, bindingA);
    const pageB = await ready(b, bindingB);
    const rootsA = await specialRoots(pageA);
    const rootsB = await specialRoots(pageB);
    await pageA.evaluate(async ({ barId, url }) => {
      await chrome.bookmarks.create({ parentId: barId, title: 'KNS08 durable', url });
    }, { barId: rootsA.barId, url: PUBLIC_URL });
    await confirmFirstRun(pageA, [rootsA.barTitle]);
    await waitFirstRunProductQuiet(pageA, stack, bindingA);
    await confirmFirstRun(pageB, [rootsB.barTitle]);
    await waitFirstRunProductQuiet(pageB, stack, bindingB);

    await a.setOffline(true);
    await pageA.evaluate(async ({ barId, url }) => {
      await chrome.bookmarks.create({ parentId: barId, title: 'KNS08 offline', url: `${url}/offline` });
    }, { barId: rootsA.barId, url: PUBLIC_URL });
    await waitNonterminalQueue(pageA, stack, bindingA);
    await restoreConnectivity(a, pageA);
    await waitQueueQuiet(pageA, stack, bindingA, 90_000);

    stack.setPushFault('timeout_once');
    await stack.commitAfterDisconnect();
    const digestsBeforeLost = ((await stack.observations()) as { pushRequestDigests?: string[] }).pushRequestDigests;
    await pageA.evaluate(async ({ barId, url }) => {
      await chrome.bookmarks.create({ parentId: barId, title: 'KNS08 lost push', url: `${url}/lost` });
    }, { barId: rootsA.barId, url: PUBLIC_URL });
    await wakeEngine(pageA);
    await stack.restorePushResponses();
    await waitQueueQuiet(pageA, stack, bindingA, 90_000);
    const lost = await stack.observations() as { pushRequestDigests?: string[] };
    assertPushEnvelopeReused(digestsBeforeLost, lost.pushRequestDigests);
    expect((await liveTitles(stack)).filter((title) => title === 'KNS08 lost push')).toHaveLength(1);

    await evidence(pageB, 'pullNowEvidence').catch(() => undefined);
    await terminateWorker(b, pageB);
    await b.close();
    b = await launchPersistent(dirs.b, stack.browserHostResolverRules);
    const pageB2 = await optionsPage(b);
    await expect(pageB2.locator('body')).toHaveAttribute('data-state', 'connected', { timeout: 20_000 });
    await wakeEngine(pageB2);
    await waitTitles(pageB2, ['KNS08 lost push']);
    const factsB = await scopeFacts(pageB2, stack, bindingB);
    expect(factsB.mappingCount).toBeGreaterThan(0);
    expect(factsB.cursor).not.toBeNull();

    const beforeRevoke = await scopeFacts(pageA, stack, bindingA);
    await revokeBookmarks(pageA);
    const revoked = await scopeFacts(pageA, stack, bindingA);
    expect(revoked.mappingCount).toBe(beforeRevoke.mappingCount);
    expect([...new Set(revoked.queueOpIds)].sort()).toEqual([...new Set(beforeRevoke.queueOpIds)].sort());
    if (beforeRevoke.queueOpIds.length > 0) {
      expect(revoked.queueOpIds.length).not.toBe(0);
    }
    await grantBookmarks(pageA);
    const restored = await scopeFacts(pageA, stack, bindingA);
    expect(restored.mappingCount).toBe(revoked.mappingCount);
    await writeScenarioEvidence({
      testInfo, id, startDigest: 'n/a', ops: ['offline', 'lost-push', 'pull-interrupt', 'permission-revoke'],
      endTree: { digest: (await treeProjection(pageA)).digest }, mapping: { count: restored.mappingCount },
      cursor: restored.cursor, receipt: restored.receiptCount, logs, extraRedact: [stack.authUserId],
    });
  } catch (error) {
    const facts = a ? await captureReplayFacts(await optionsPage(a), stack, bindingA).catch((cause) => ({
      owner: 'unknown', error: cause instanceof Error ? cause.message : String(cause),
    })) : { owner: 'unknown' };
    await saveReplayFixture(testInfo, id, error, facts);
    throw error;
  } finally { await closeAll(a, b); await stack.close(); await rmDirs(dirs); }
});

test('KNS-08-AC-04/06 field conflict and concurrent move', async ({}, testInfo) => {
  const id = 'KNS-08-AC-06-field-conflict';
  const stack = await startRealStack();
  const dirs = await twinDirs();
  let a: BrowserContext | undefined; let b: BrowserContext | undefined;
  try {
    a = await launchPersistent(dirs.a, stack.browserHostResolverRules);
    b = await launchPersistent(dirs.b, stack.browserHostResolverRules);
    const logs = collectLogs(a);
    const pageA = await ready(a, bindingA);
    const pageB = await ready(b, bindingB);
    const rootsA = await specialRoots(pageA);
    const rootsB = await specialRoots(pageB);
    const created = await pageA.evaluate(async ({ barId, url }) => {
      const folder = await chrome.bookmarks.create({ parentId: barId, title: 'KNS08 move folder' });
      const otherFolder = await chrome.bookmarks.create({ parentId: barId, title: 'KNS08 move folder B' });
      const bookmark = await chrome.bookmarks.create({ parentId: barId, title: 'KNS08 conflict', url });
      return { folderId: folder.id, otherFolderId: otherFolder.id, bookmarkId: bookmark.id };
    }, { barId: rootsA.barId, url: PUBLIC_URL });
    await confirmFirstRun(pageA, [rootsA.barTitle]);
    await waitFirstRunProductQuiet(pageA, stack, bindingA);
    await confirmFirstRun(pageB, [rootsB.barTitle]);
    await waitFirstRunProductQuiet(pageB, stack, bindingB);
    await wakeEngine(pageA); await wakeEngine(pageB);
    await waitTitles(pageB, ['KNS08 conflict', 'KNS08 move folder B']);
    const beforeConflict = await evidence<{ mappings: Array<{ nativeId: string; colpId: string }> }>(pageA, 'exportOutboundPushEvidence');
    const conflictNodeId = beforeConflict.mappings.find((mapping) => mapping.nativeId === created.bookmarkId)?.colpId;
    if (!conflictNodeId || conflictNodeId.startsWith('pending-')) throw new Error('conflict_mapping_missing');

    await a.setOffline(true); await b.setOffline(true);
    await pageA.evaluate((id) => chrome.bookmarks.update(id, { title: 'KNS08 conflict A' }), created.bookmarkId);
    const remote = await pageB.evaluate(async () => {
      const tree = await chrome.bookmarks.getTree();
      const walk = (nodes: chrome.bookmarks.BookmarkTreeNode[]): chrome.bookmarks.BookmarkTreeNode | undefined => {
        for (const node of nodes) {
          if (node.title === 'KNS08 conflict') return node;
          const nested = node.children ? walk(node.children) : undefined;
          if (nested) return nested;
        }
      };
      return walk(tree[0]?.children ?? [])?.id;
    });
    expect(remote).toBeTruthy();
    await pageB.evaluate((id) => chrome.bookmarks.update(id!, { title: 'KNS08 conflict B' }), remote);
    await waitNonterminalQueue(pageA, stack, bindingA);
    await waitNonterminalQueue(pageB, stack, bindingB);
    await restoreConnectivity(a, pageA); await restoreConnectivity(b, pageB);
    const incomingProfile = await resolveIncomingConflict([pageA, pageB]);
    // Share the original 90s quiet budget with the actual convergence oracle.
    // No wake or mutation inside this observation: the peer may still await Pull.
    await expect(async () => {
      const factsA = await scopeFacts(pageA, stack, bindingA);
      const factsB = await scopeFacts(pageB, stack, bindingB);
      assertQueueTerminal(factsA); assertQueueTerminal(factsB);
      for (const facts of [factsA, factsB]) {
        expect(facts.recoveryFrozen).toBe(false);
        expect(['sleeping', 'idle']).toContain(facts.enginePhase);
      }
      const forkA = await bookmarkPlacement(pageA, 'KNS08 conflict');
      const forkB = await bookmarkPlacement(pageB, 'KNS08 conflict');
      const canonical = await canonicalPlacement(stack, conflictNodeId);
      expect(['KNS08 conflict A', 'KNS08 conflict B']).toContain(forkA.title);
      expect(forkA.title).toBe(incomingProfile === 0 ? 'KNS08 conflict A' : 'KNS08 conflict B');
      expect(forkB.title).toBe(forkA.title);
      expect(canonical.title).toBe(forkA.title);
    }).toPass({ timeout: 90_000 });

    await a.setOffline(true); await b.setOffline(true);
    await pageA.evaluate(({ id, folderId }) => chrome.bookmarks.move(id, { parentId: folderId }),
      { id: created.bookmarkId, folderId: created.folderId });
    const bMove = await pageB.evaluate(async () => {
      const tree = await chrome.bookmarks.getTree();
      const walk = (nodes: chrome.bookmarks.BookmarkTreeNode[]): chrome.bookmarks.BookmarkTreeNode[] => {
        const found: chrome.bookmarks.BookmarkTreeNode[] = [];
        for (const node of nodes) {
          found.push(node);
          if (node.children) found.push(...walk(node.children));
        }
        return found;
      };
      const nodes = walk(tree[0]?.children ?? []);
      const bookmark = nodes.find((node) => (node.title ?? '').startsWith('KNS08 conflict') && Boolean(node.url));
      const folder = nodes.find((node) => node.title === 'KNS08 move folder B');
      if (!bookmark?.id || !folder?.id) return null;
      await chrome.bookmarks.move(bookmark.id, { parentId: folder.id });
      return bookmark.id;
    });
    expect(bMove).toBeTruthy();
    await waitNonterminalQueue(pageA, stack, bindingA);
    await waitNonterminalQueue(pageB, stack, bindingB);
    await restoreConnectivity(a, pageA); await restoreConnectivity(b, pageB);
    // A stale move may need a rebase cycle before its receipt. Start the
    // propagation budget after both writes settle: the final Push can land
    // just after the peer's Pull, requiring one more MV3 alarm delivery.
    await expect(async () => {
      assertQueueTerminal(await scopeFacts(pageA, stack, bindingA));
      assertQueueTerminal(await scopeFacts(pageB, stack, bindingB));
    }).toPass({ timeout: 90_000 });
    await expect(async () => {
      const factsA = await scopeFacts(pageA, stack, bindingA);
      const factsB = await scopeFacts(pageB, stack, bindingB);
      assertQueueTerminal(factsA); assertQueueTerminal(factsB);
      for (const facts of [factsA, factsB]) {
        expect(facts.recoveryFrozen).toBe(false);
        expect(['sleeping', 'idle']).toContain(facts.enginePhase);
      }
      const movedA = await bookmarkPlacement(pageA, 'KNS08 conflict');
      const movedB = await bookmarkPlacement(pageB, 'KNS08 conflict');
      const canonical = await canonicalPlacement(stack, conflictNodeId);
      expect(movedA.title).toBe(movedB.title);
      expect(movedA.title).toBe(incomingProfile === 0 ? 'KNS08 conflict A' : 'KNS08 conflict B');
      expect(movedA.title).toBe(canonical.title);
      expect(movedA.parentTitle).toBe(movedB.parentTitle);
      expect(movedA.parentTitle).toBe(canonical.parentTitle);
      expect(['KNS08 move folder', 'KNS08 move folder B']).toContain(movedA.parentTitle);
    }).toPass({ timeout: 90_000 });
    const factsA = await scopeFacts(pageA, stack, bindingA);
    const factsB = await scopeFacts(pageB, stack, bindingB);
    assertQueueTerminal(factsA);
    assertQueueTerminal(factsB);
    await writeScenarioEvidence({
      testInfo, id, startDigest: 'n/a', ops: ['offline-title-fork', 'explicit-incoming-resolution', 'concurrent-move'],
      endTree: { a: (await treeProjection(pageA)).digest, b: (await treeProjection(pageB)).digest },
      mapping: { count: factsA.mappingCount }, cursor: factsA.cursor, receipt: factsA.receiptCount, logs,
      extraRedact: [stack.authUserId],
    });
  } catch (error) {
    const factsA = a ? await captureReplayFacts(await optionsPage(a), stack, bindingA).catch((cause) => ({
      owner: 'unknown', error: cause instanceof Error ? cause.message : String(cause),
    })) : { owner: 'unknown' };
    const factsB = b ? await captureReplayFacts(await optionsPage(b), stack, bindingB).catch((cause) => ({
      owner: 'unknown', error: cause instanceof Error ? cause.message : String(cause),
    })) : { owner: 'unknown' };
    await saveReplayFixture(testInfo, id, error, { a: factsA, b: factsB });
    throw error;
  } finally { await closeAll(a, b); await stack.close(); await rmDirs(dirs); }
});

async function canonicalPlacement(stack: RealStack, nodeId: string) {
  const nodes = await liveCanonical(stack);
  const node = nodes.find((row) => row.id === nodeId);
  const parent = nodes.find((row) => row.id === node?.parent_id);
  if (!node || !parent) throw new Error('canonical_placement_missing');
  return { title: String(node.title ?? ''), parentTitle: String(parent.title ?? '') };
}

async function ready(context: BrowserContext, binding: ProfileBinding): Promise<Page> {
  const page = await optionsPage(context);
  await login(page, binding);
  await grantBookmarks(page);
  return page;
}

async function twinDirs(): Promise<{ a: string; b: string }> {
  return {
    a: await mkdtemp(resolve(tmpdir(), 'known-kns08-a-')),
    b: await mkdtemp(resolve(tmpdir(), 'known-kns08-b-')),
  };
}

async function closeAll(...contexts: Array<BrowserContext | undefined>): Promise<void> {
  await Promise.all(contexts.map(async (context) => { if (context) await context.close().catch(() => undefined); }));
}

async function rmDirs(dirs: { a: string; b: string }): Promise<void> {
  await Promise.all([rm(dirs.a, { recursive: true, force: true }), rm(dirs.b, { recursive: true, force: true })]);
}
