/**
 * First-run remediation MV3: F2/F3/F4, crash, closed UI, permission, move.
 * Owner: KNS-08 (QA). Fixture: e2e/real-stack.ts + profileA/profileB persistent Chromium.
 * Run: npm run evidence:first-run-sync
 * Evidence: test-results/known-extension-first-run-sync/<commit>/
 *
 * kns08:FRR-RANGE-REJOIN
 */
import { expect, test, type BrowserContext, type Page, type Worker } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import {
  KNS08_BINDINGS, PUBLIC_URL, captureReplayFacts, collectLogs, confirmFirstRun, evidence,
  grantBookmarks, launchPersistent, liveCanonical, liveTitles, login, optionsPage, revokeBookmarks,
  saveReplayFixture, specialRoots, startRealStack, terminateWorker, waitFirstRunProductQuiet,
  waitTitles, wakeEngine, writeScenarioEvidence, type ProfileBinding,
} from './kns-08-harness.js';
import {
  assertBothSides, assertQueueFinished, assertUniqueMappings, chromeTree, colpBag, contentKey,
  countBy, exportedScope, serverBag, waitBarrierHeld, waitBarrierHits, waitObservedQuiet,
} from './first-run-remediation-oracle.js';

const bindingA = KNS08_BINDINGS[0];
const bindingB = KNS08_BINDINGS[1];
test.describe.configure({ timeout: 600_000 });

test('FR-F2-CAPTURE-LOSS / FR-F2-RECEIPT-REPLAY recover exactly one remote Node', async ({}, testInfo) => {
  const id = 'FR-F2-CAPTURE-LOSS';
  const stack = await startRealStack();
  const dirs = await twinDirs();
  let a: BrowserContext | undefined;
  try {
    a = await launchPersistent(dirs.a, stack.browserHostResolverRules);
    const logs = collectLogs(a);
    const page = await ready(a, bindingA);
    const roots = await specialRoots(page);
    await confirmFirstRun(page, [roots.barTitle]);
    await waitFirstRunProductQuiet(page, stack, bindingA);
    const before = (await liveTitles(stack)).filter((title) => title === 'FR capture loss').length;

    await evidence(page, 'configureCaptureFaultEvidence', 'before_stage');
    await page.evaluate(async ({ barId, url }) => {
      await chrome.bookmarks.create({ parentId: barId, title: 'FR capture loss', url: `${url}/capture-loss` });
    }, { barId: roots.barId, url: PUBLIC_URL });
    expect((await liveTitles(stack)).filter((title) => title === 'FR capture loss')).toHaveLength(before);
    await terminateWorker(a, page);
    const page2 = await optionsPage(a);
    const worker = a.serviceWorkers()[0] ?? await a.waitForEvent('serviceworker');
    await clearCaptureRecoveryAlarm(worker);
    await expect(page2.locator('body')).toHaveAttribute('data-state', 'connected', { timeout: 20_000 });
    await expect.poll(async () => (await liveTitles(stack)).filter((title) => title === 'FR capture loss').length,
      { timeout: 25_000 }).toBe(1);
    const captureNative = (await chromeTree(page2)).find((node) => node.title === 'FR capture loss');
    expect(captureNative?.id).toBeTruthy();
    expect((await exportedScope(page2)).mappings?.some((row: { nativeId?: string }) =>
      row.nativeId === captureNative?.id)).toBe(true);

    await page2.evaluate(async ({ barId, url }) => {
      await chrome.bookmarks.create({ parentId: barId, title: 'FR receipt replay', url: `${url}/receipt-replay` });
    }, { barId: roots.barId, url: PUBLIC_URL });
    await expect.poll(async () => {
      await wakeEngine(page2);
      return (await liveTitles(stack)).filter((title) => title === 'FR receipt replay').length;
    }, { timeout: 90_000 }).toBe(1);
    const receiptNative = (await chromeTree(page2)).find((node) => node.title === 'FR receipt replay');
    expect(receiptNative?.id).toBeTruthy();
    const beforeDrop = await exportedScope(page2);
    const receiptColp = (beforeDrop.mappings ?? []).find((row: { nativeId?: string }) =>
      row.nativeId === receiptNative?.id)?.colpId;
    expect(receiptColp).toBeTruthy();
    expect(await evidence(page2, 'dropNativeMappingEvidence', receiptNative!.id)).toBe(true);
    await terminateWorker(a, page2);
    const page3 = await optionsPage(a);
    await waitObservedQuiet(page3, stack, bindingA);
    expect((await liveTitles(stack)).filter((title) => title === 'FR receipt replay')).toHaveLength(1);
    await expect.poll(async () => (await exportedScope(page3)).mappings?.find((row: { nativeId?: string }) =>
      row.nativeId === receiptNative?.id)?.colpId, { timeout: 15_000 }).toBe(receiptColp);
    const exported = await exportedScope(page3);
    expect((exported.mappings ?? []).find((row: { nativeId?: string }) =>
      row.nativeId === receiptNative?.id)?.colpId).toBe(receiptColp);
    assertUniqueMappings(exported);
    assertQueueFinished(exported);
    await writeScenarioEvidence({
      testInfo, id, startDigest: 'n/a', ops: ['capture-loss', 'receipt-replay'],
      endTree: { titles: await liveTitles(stack) }, mapping: { count: exported.mappings?.length },
      cursor: exported.cursor?.cursor ?? null, receipt: exported.receipts?.length, logs,
      extraRedact: [stack.authUserId],
    });
  } catch (error) {
    await saveReplayFixture(testInfo, id, error, a
      ? await captureReplayFacts(await optionsPage(a), stack, bindingA).catch((cause) => String(cause)) : {});
    throw error;
  } finally { await a?.close().catch(() => undefined); await stack.close(); await rmDirs(dirs); }
});

test('FR-F3-DUPLICATE-SIBLINGS / FR-F3-APPLY-CRASH keep one native per remote Node', async ({}, testInfo) => {
  const id = 'FR-F3-DUPLICATE-SIBLINGS';
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
      await chrome.bookmarks.create({ parentId: barId, title: 'FR equal sibling', url: `${url}/equal` });
      await chrome.bookmarks.create({ parentId: barId, title: 'FR equal sibling', url: `${url}/equal` });
    }, { barId: rootsA.barId, url: PUBLIC_URL });
    await confirmFirstRun(pageA, [rootsA.barTitle]);
    await waitFirstRunProductQuiet(pageA, stack, bindingA);
    const live = serverBag(await liveCanonical(stack)).filter((node) => node.title === 'FR equal sibling');
    expect(live).toHaveLength(2);
    expect(new Set(live.map((node) => node.colpId)).size).toBe(2);

    await evidence(pageB, 'configureProjectionApplyBarrierEvidence', 'after_chrome_create_before_mapping');
    const confirm = confirmFirstRun(pageB, [rootsB.barTitle]);
    await waitBarrierHits(pageB);
    await terminateWorker(b, pageB);
    await confirm.catch(() => undefined);
    await b.close();
    b = await launchPersistent(dirs.b, stack.browserHostResolverRules);
    const pageB2 = await optionsPage(b);
    // Signed in again on boot from the session cookie — see FR-F3-APPLY-HELD.
    await expect(pageB2.locator('body')).toHaveAttribute('data-state', 'connected', { timeout: 20_000 });
    await waitFirstRunProductQuiet(pageB2, stack, bindingB);
    const exportB = await exportedScope(pageB2);
    const bagB = colpBag(await chromeTree(pageB2), exportB).filter((node) => node.title === 'FR equal sibling');
    expect(bagB).toHaveLength(2);
    expect(new Set(bagB.map((node) => node.colpId)).size).toBe(2);
    expect(countBy(bagB, contentKey).get(contentKey(bagB[0]!))).toBe(2);
    assertUniqueMappings(exportB);
    await writeScenarioEvidence({
      testInfo, id, startDigest: 'n/a', ops: ['duplicate-siblings', 'apply-crash'],
      endTree: { b: bagB.length }, mapping: { count: exportB.mappings?.length },
      cursor: exportB.cursor?.cursor ?? null, receipt: exportB.receipts?.length, logs,
      extraRedact: [stack.authUserId],
    });
  } catch (error) {
    await saveReplayFixture(testInfo, id, error, { a: 'see-replay' });
    throw error;
  } finally { await closeAll(a, b); await stack.close(); await rmDirs(dirs); }
});

// Regression guard for APPLY-HELD-RECOVERY-DEADLOCK (fixed).
//
// Killing the worker while an apply is SUSPENDED (the `hold` barrier) leaves a
// baseline-less Replica whose bootstrap Ack is then denied. Measured state while it
// was broken:
//   frozen=true | phase=recovery | boot=syncing | acks=0 | maps=4 |
//   cursors=drift | recovery=none | retry=snapshot_pending
//
// The cause was on the SERVER, not in the client. The denial path
// (`rejectBootstrapAckAndRequireAuthorityRefresh`) deletes the Ack intent, freezes
// recovery and sets `authorityRefreshRequired`; the client then force-refreshes
// Session authority and re-enters recovery — which is the DESIGNED exit, and it
// works. What was missing is that the server kept the Replica `active`, and it issues
// a recovery capability only for `replicaState === 'recovery_required'`
// (`sync-bootstrap-snapshot.ts`). So the client correctly refused every plain
// Snapshot it was offered (`recovery_capability_invalid`, which P3-33 pins as
// required behaviour) and retried forever: a contract mismatch, not a client bug.
//
// Fixed in `sync-ack-postgres.ts`: when an Ack is denied with `stale_replica` or
// `sync_cursor_expired` for a Replica whose `checkpoint_commit_ordinal IS NULL` and
// whose status is `active|expired`, the server migrates it to `recovery_required`
// under a four-way CAS in its own committed transaction, writing a
// `sync.replica.lifecycle.recovery_required` audit event. The next Session then
// issues recovery authority — Snapshot capability plus the recovery Ack path — and
// the client recovers through the existing protocol-0.2 `recoveryCapability` field
// with no client change.
//
// NOT limited to this test: the sibling FR-F3-DUPLICATE-SIBLINGS / FR-F3-APPLY-CRASH
// test hits the same window and failed with a byte-identical state string. Both are
// kept as regression tests. Note that when the crash window is MISSED the Ack simply
// succeeds and the run completes on the active path — that is correct protocol
// behaviour, not a coverage gap; the migration audit event is what proves the crash
// path was actually exercised.
test('FR-F3-APPLY-HELD interrupts a write held mid-apply, not one already unwound', async ({}, testInfo) => {
  const id = 'FR-F3-APPLY-HELD';
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
      await chrome.bookmarks.create({ parentId: barId, title: 'FR equal sibling', url: `${url}/equal` });
      await chrome.bookmarks.create({ parentId: barId, title: 'FR equal sibling', url: `${url}/equal` });
    }, { barId: rootsA.barId, url: PUBLIC_URL });
    await confirmFirstRun(pageA, [rootsA.barTitle]);
    await waitFirstRunProductQuiet(pageA, stack, bindingA);
    const live = serverBag(await liveCanonical(stack)).filter((node) => node.title === 'FR equal sibling');
    expect(live).toHaveLength(2);
    expect(new Set(live.map((node) => node.colpId)).size).toBe(2);

    // `hold` leaves the window OPEN: the bookmark exists in the browser tree and
    // its mapping is not yet durable. The older crash test used the default
    // `throw` and waited for the hit, so by the time it terminated the worker the
    // apply had already failed and unwound. This terminates while the write is
    // still suspended, which is the interruption MV3 actually produces.
    await evidence(pageB, 'configureProjectionApplyBarrierEvidence',
      'after_chrome_create_before_mapping', 'hold');
    const confirm = confirmFirstRun(pageB, [rootsB.barTitle]);
    await waitBarrierHeld(pageB);
    await terminateWorker(b, pageB);
    await confirm.catch(() => undefined);
    await b.close();
    b = await launchPersistent(dirs.b, stack.browserHostResolverRules);
    const pageB2 = await optionsPage(b);
    // The session area is cleared by the restart, but the session cookie is in the
    // browser's jar and the credential IS that cookie's value, so the profile is
    // re-established on boot and stays signed in.
    await expect(pageB2.locator('body')).toHaveAttribute('data-state', 'connected', { timeout: 20_000 });
    await waitFirstRunProductQuiet(pageB2, stack, bindingB);
    const exportB = await exportedScope(pageB2);
    const bagB = colpBag(await chromeTree(pageB2), exportB).filter((node) => node.title === 'FR equal sibling');
    expect(bagB).toHaveLength(2);
    expect(new Set(bagB.map((node) => node.colpId)).size).toBe(2);
    expect(countBy(bagB, contentKey).get(contentKey(bagB[0]!))).toBe(2);
    assertUniqueMappings(exportB);
    await writeScenarioEvidence({
      testInfo, id, startDigest: 'n/a', ops: ['duplicate-siblings', 'apply-held-interruption'],
      endTree: { b: bagB.length }, mapping: { count: exportB.mappings?.length },
      cursor: exportB.cursor?.cursor ?? null, receipt: exportB.receipts?.length, logs,
      extraRedact: [stack.authUserId],
    });
  } catch (error) {
    await saveReplayFixture(testInfo, id, error, { a: 'see-replay' });
    throw error;
  } finally { await closeAll(a, b); await stack.close(); await rmDirs(dirs); }
});

test('FR-F4-CUSTOM-ONLY mounts an ordinary folder in place', async ({}, testInfo) => {
  const id = 'FR-F4-CUSTOM-ONLY';
  const stack = await startRealStack();
  const dirs = await twinDirs();
  let a: BrowserContext | undefined;
  try {
    a = await launchPersistent(dirs.a, stack.browserHostResolverRules);
    const logs = collectLogs(a);
    const page = await ready(a, bindingA);
    const roots = await specialRoots(page);
    await page.evaluate(async ({ barId, url }) => {
      const empty = await chrome.bookmarks.create({ parentId: barId, title: 'FR custom empty' });
      const research = await chrome.bookmarks.create({ parentId: barId, title: 'FR custom research' });
      await chrome.bookmarks.create({ parentId: research.id, title: 'FR custom child', url: `${url}/custom` });
      return empty.id;
    }, { barId: roots.barId, url: PUBLIC_URL });
    const before = await chromeTree(page);
    await confirmFirstRun(page, ['FR custom empty', 'FR custom research']);
    await waitFirstRunProductQuiet(page, stack, bindingA);
    const after = await chromeTree(page);
    const empty = after.find((node) => node.title === 'FR custom empty');
    const research = after.find((node) => node.title === 'FR custom research');
    expect(empty?.parentId).toBe(before.find((node) => node.title === 'FR custom empty')?.parentId);
    expect(research?.parentId).toBe(before.find((node) => node.title === 'FR custom research')?.parentId);
    const exported = await exportedScope(page);
    const bindings = exported.mountBindings ?? [];
    const emptyKey = `folder:${empty!.id}`;
    const researchKey = `folder:${research!.id}`;
    const byKey = new Map<string, { remoteMountNodeId?: string }>(
      bindings.map((row: { customSourceKey?: string; remoteMountNodeId?: string }) =>
        [String(row.customSourceKey ?? ''), row]));
    expect(byKey.get(emptyKey)?.remoteMountNodeId).toBeTruthy();
    expect(byKey.get(researchKey)?.remoteMountNodeId).toBeTruthy();
    expect(bindings.every((row: { rootRole?: string }) => row.rootRole !== 'bookmarks-bar')).toBe(true);
    const live = await liveTitles(stack);
    expect(live.filter((title) => title === 'FR custom empty')).toHaveLength(1);
    expect(live.filter((title) => title === 'FR custom research')).toHaveLength(1);
    expect(live.filter((title) => title === 'FR custom child')).toHaveLength(1);
    assertUniqueMappings(exported);
    assertQueueFinished(exported);
    await writeScenarioEvidence({
      testInfo, id, startDigest: 'n/a', ops: ['custom-only'],
      endTree: { titles: live }, mapping: { count: exported.mappings?.length },
      cursor: exported.cursor?.cursor ?? null, receipt: exported.receipts?.length, logs,
      extraRedact: [stack.authUserId],
    });
  } catch (error) {
    await saveReplayFixture(testInfo, id, error, a
      ? await captureReplayFacts(await optionsPage(a), stack, bindingA).catch((cause) => String(cause)) : {});
    throw error;
  } finally { await a?.close().catch(() => undefined); await stack.close(); await rmDirs(dirs); }
});

test('FR-F4-CUSTOM-PROFILE-ISOLATION rejects peer mount claims with the same native id', async () => {
  const stack = await startRealStack(); const dirs = await twinDirs();
  let a: BrowserContext | undefined; let b: BrowserContext | undefined;
  try {
    a = await launchPersistent(dirs.a, stack.browserHostResolverRules);
    b = await launchPersistent(dirs.b, stack.browserHostResolverRules);
    const pageA = await ready(a, bindingA); const pageB = await ready(b, bindingB);
    const createRoot = async (page: Page, title: string) => {
      const roots = await specialRoots(page);
      return page.evaluate(({ parentId, title }) => chrome.bookmarks.create({ parentId, title }),
        { parentId: roots.barId, title });
    };
    const rootA = await createRoot(pageA, 'FR isolated custom A');
    const rootB = await createRoot(pageB, 'FR isolated custom B');
    expect(rootA.id).toBe(rootB.id);
    await confirmFirstRun(pageA, [rootA.title]);
    await waitFirstRunProductQuiet(pageA, stack, bindingA);
    type Facts = { mountBindings: Array<{ nativeRootId: string; remoteMountNodeId: string; status: string }>;
      mappings: Array<{ nativeId: string; colpId: string }> };
    const beforeA = await evidence<Facts>(pageA, 'exportOutboundPushEvidence');
    const mountA = beforeA.mountBindings.find((mount) => mount.nativeRootId === rootA.id)!;
    await confirmFirstRun(pageB, [rootB.title]);
    await waitFirstRunProductQuiet(pageB, stack, bindingB);
    const beforeB = await evidence<Facts>(pageB, 'exportOutboundPushEvidence');
    const mountB = beforeB.mountBindings.find((mount) => mount.nativeRootId === rootB.id)!;
    expect(mountA.remoteMountNodeId).not.toBe(mountB.remoteMountNodeId);
    await wakeEngine(pageA);
    await expect.poll(async () => {
      await wakeEngine(pageA);
      const facts = await evidence<Facts>(pageA, 'exportOutboundPushEvidence');
      return facts.mappings.find((mapping) => mapping.colpId === mountB.remoteMountNodeId)?.nativeId;
    }, { timeout: 45_000 }).toBe(`unmounted:${mountB.remoteMountNodeId}`);
    const afterA = await evidence<Facts>(pageA, 'exportOutboundPushEvidence');
    expect(afterA.mountBindings).toContainEqual(expect.objectContaining(mountA));
    expect(afterA.mappings).toContainEqual(expect.objectContaining({ nativeId: rootA.id,
      colpId: mountA.remoteMountNodeId }));
    expect((await chromeTree(pageA)).some((node) => node.title === rootB.title)).toBe(false);
    await pageA.evaluate(({ parentId, url }) => chrome.bookmarks.create({ parentId,
      title: 'FR isolated child A', url }), { parentId: rootA.id, url: `${PUBLIC_URL}/isolated-a` });
    await expect.poll(async () => (await liveCanonical(stack)).filter((node) => node.title === 'FR isolated child A')
      .map((node) => node.parent_id)).toEqual([mountA.remoteMountNodeId]);
  } finally {
    await Promise.allSettled([a?.close(), b?.close()]); await stack.close(); await rmDirs(dirs);
  }
});

test('FR-PRODUCT-CLOSED-UI converges after options close without status polling', async ({}, testInfo) => {
  const id = 'FR-PRODUCT-CLOSED-UI';
  const stack = await startRealStack();
  const dirs = await twinDirs();
  let a: BrowserContext | undefined;
  try {
    a = await launchPersistent(dirs.a, stack.browserHostResolverRules);
    const logs = collectLogs(a);
    const page = await ready(a, bindingA);
    const roots = await specialRoots(page);
    await confirmFirstRun(page, [roots.barTitle]);
    await waitFirstRunProductQuiet(page, stack, bindingA);
    await page.close();
    const worker = a.serviceWorkers()[0] ?? await a.waitForEvent('serviceworker');
    await worker.evaluate(async ({ barId, url }) => {
      await chrome.bookmarks.create({ parentId: barId, title: 'FR closed ui', url: `${url}/closed` });
    }, { barId: roots.barId, url: PUBLIC_URL });
    await expect.poll(async () => (await liveTitles(stack)).filter((title) => title === 'FR closed ui').length,
      { timeout: 90_000 }).toBe(1);
    const observer = await optionsPage(a);
    const exported = await exportedScope(observer);
    assertQueueFinished(exported);
    await writeScenarioEvidence({
      testInfo, id, startDigest: 'n/a', ops: ['closed-ui'],
      endTree: { titles: await liveTitles(stack) }, mapping: { count: exported.mappings?.length },
      cursor: exported.cursor?.cursor ?? null, receipt: exported.receipts?.length, logs,
      extraRedact: [stack.authUserId],
    });
  } catch (error) {
    await saveReplayFixture(testInfo, id, error, {});
    throw error;
  } finally { await a?.close().catch(() => undefined); await stack.close(); await rmDirs(dirs); }
});

test('FR-PERMISSION-RECONCILE and FR-MOVE-CONVERGENCE keep both sides aligned', async ({}, testInfo) => {
  const id = 'FR-PERMISSION-RECONCILE';
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
      const folder = await chrome.bookmarks.create({ parentId: barId, title: 'FR move dest' });
      const bookmark = await chrome.bookmarks.create({ parentId: barId, title: 'FR move item', url });
      return { folderId: folder.id, bookmarkId: bookmark.id };
    }, { barId: rootsA.barId, url: PUBLIC_URL });
    await confirmFirstRun(pageA, [rootsA.barTitle]);
    await waitFirstRunProductQuiet(pageA, stack, bindingA);
    await confirmFirstRun(pageB, [rootsB.barTitle]);
    await waitFirstRunProductQuiet(pageB, stack, bindingB);
    await waitTitles(pageB, ['FR move item', 'FR move dest']);

    const beforeRevoke = await exportedScope(pageA);
    await revokeBookmarks(pageA);
    const revoked = await exportedScope(pageA);
    expect(revoked.mappings?.length).toBe(beforeRevoke.mappings?.length);
    const beforeOpIds = (beforeRevoke.queue ?? []).map((row: { opId?: string }) => String(row.opId ?? '')).sort();
    const revokedOpIds = (revoked.queue ?? []).map((row: { opId?: string }) => String(row.opId ?? '')).sort();
    expect(revokedOpIds).toEqual(beforeOpIds);
    if (beforeOpIds.length > 0) expect(revokedOpIds.length).not.toBe(0);
    // Chrome cannot bookmarks.create without permission; do not create after re-grant.
    const independent = await a.newPage();
    const mutated = await independent.goto('chrome://bookmarks').then(async () => independent.evaluate(
      async ({ parentId, url }) => {
        const api = (globalThis as { chrome?: { bookmarks?: { create?: Function } } }).chrome?.bookmarks;
        if (!api?.create) return { ok: false };
        await api.create({ parentId, title: 'FR perm added', url: `${url}/perm` });
        return { ok: true };
      }, { parentId: rootsA.barId, url: PUBLIC_URL },
    )).catch(() => ({ ok: false }));
    await independent.close().catch(() => undefined);
    await grantBookmarks(pageA);
    const grantWorker = a.serviceWorkers()[0];
    if (grantWorker) await clearCaptureRecoveryAlarm(grantWorker);
    const local = await chromeTree(pageA);
    const landed = local.some((node) => node.title === 'FR perm added');
    if (mutated.ok) expect(landed).toBe(true);
    if (landed) {
      await expect.poll(async () => (await liveTitles(stack)).filter((title) => title === 'FR perm added').length,
        { timeout: 25_000 }).toBe(1);
    }
    await pageA.evaluate(({ bookmarkId, folderId }) => chrome.bookmarks.move(bookmarkId, { parentId: folderId }),
      created);
    await expect.poll(async () => {
      const live = serverBag(await liveCanonical(stack));
      const dest = live.find((node) => node.title === 'FR move dest');
      const item = live.find((node) => node.title === 'FR move item');
      if (!dest || !item) return 'missing';
      return item.parentColp === dest.colpId ? 'moved' : `parent=${item.parentColp}`;
    }, { timeout: 90_000 }).toBe('moved');
    await wakeEngine(pageB);
    await assertBothSides(pageA, pageB, stack, 'FR move item', PUBLIC_URL);
    await writeScenarioEvidence({
      testInfo, id, startDigest: 'n/a', ops: ['permission-reconcile', 'move-convergence'],
      endTree: { a: (await chromeTree(pageA)).length }, mapping: { count: (await exportedScope(pageA)).mappings?.length },
      cursor: (await exportedScope(pageA)).cursor?.cursor ?? null,
      receipt: (await exportedScope(pageA)).receipts?.length, logs, extraRedact: [stack.authUserId],
    });
  } catch (error) {
    await saveReplayFixture(testInfo, id, error, {});
    throw error;
  } finally { await closeAll(a, b); await stack.close(); await rmDirs(dirs); }
});

async function ready(context: BrowserContext, binding: ProfileBinding): Promise<Page> {
  const page = await optionsPage(context);
  await login(page, binding);
  await grantBookmarks(page);
  return page;
}

async function twinDirs(): Promise<{ a: string; b: string }> {
  return {
    a: await mkdtemp(resolve(tmpdir(), 'known-fr-a-')),
    b: await mkdtemp(resolve(tmpdir(), 'known-fr-b-')),
  };
}

async function closeAll(...contexts: Array<BrowserContext | undefined>): Promise<void> {
  await Promise.all(contexts.map(async (context) => { if (context) await context.close().catch(() => undefined); }));
}

async function rmDirs(dirs: { a: string; b: string }): Promise<void> {
  await Promise.all([rm(dirs.a, { recursive: true, force: true }), rm(dirs.b, { recursive: true, force: true })]);
}

async function clearCaptureRecoveryAlarm(worker: Worker): Promise<void> {
  await worker.evaluate((name) => {
    const alarms = (globalThis as { chrome?: { alarms?: { clear?: (alarm: string) => Promise<boolean> } } })
      .chrome?.alarms;
    return alarms?.clear?.(name);
  }, 'known-bookmark-capture-recovery');
}

test('FRR-01/02 cross-range continuation and detached deletion converge across real profiles', async ({}, testInfo) => {
  const id = 'FRR-RANGE-REJOIN'; const stack = await startRealStack(); const dirs = await twinDirs();
  let a: BrowserContext | undefined; let b: BrowserContext | undefined;
  try {
    a = await launchPersistent(dirs.a, stack.browserHostResolverRules);
    b = await launchPersistent(dirs.b, stack.browserHostResolverRules);
    const logs = collectLogs(b);
    const pageA = await ready(a, bindingA); const pageB = await ready(b, bindingB);
    const rootsA = await specialRoots(pageA); const rootsB = await specialRoots(pageB);
    const nativeA = await pageA.evaluate(async ({ barId, url }) =>
      (await chrome.bookmarks.create({ parentId: barId, title: 'FRR range original', url: `${url}/range` })).id,
    { barId: rootsA.barId, url: PUBLIC_URL });
    await confirmFirstRun(pageA, [rootsA.barTitle, rootsA.otherTitle]);
    await waitFirstRunProductQuiet(pageA, stack, bindingA);
    await confirmFirstRun(pageB, [rootsB.barTitle, rootsB.otherTitle]);
    await waitFirstRunProductQuiet(pageB, stack, bindingB);
    const originalB = (await chromeTree(pageB)).find(node => node.title === 'FRR range original')!;
    expect(originalB).toBeTruthy();
    const mounts = (await exportedScope(pageB)).mountBindings as Array<{ mountId: string; rootRole: string }>;
    const barMount = mounts.find(mount => mount.rootRole === 'bookmarks-bar')!.mountId;
    const otherMount = mounts.find(mount => mount.rootRole === 'other-bookmarks')!.mountId;
    const command = (kind: 'known.scope.detach' | 'known.scope.rejoin', mountId: string) => pageB.evaluate(
      async message => chrome.runtime.sendMessage(message) as Promise<{ ok: boolean }>, { kind, mountId });
    expect((await command('known.scope.detach', otherMount)).ok).toBe(true);
    await pageA.evaluate(async ({ id, parentId }) => chrome.bookmarks.move(id, { parentId }), { id: nativeA, parentId: rootsA.otherId });
    await expect.poll(async () => {
      return (await exportedScope(pageB)).mappings?.find((row: { nativeId: string }) => row.nativeId === originalB.id)?.colpId ?? null;
    }, { timeout: 90_000 }).toBe(null);
    await pageA.evaluate(async id => chrome.bookmarks.update(id, { title: 'FRR range renamed' }), nativeA);
    await expect.poll(async () => {
      const rows = (await exportedScope(pageB)).remoteObservations ?? [];
      return rows.some((row: { payload?: { title?: string } }) => row.payload?.title === 'FRR range renamed');
    }, { timeout: 90_000 }).toBe(true);
    expect((await chromeTree(pageB)).find(node => node.id === originalB.id)?.title).toBe('FRR range original');
    expect((await chromeTree(pageB)).filter(node => node.parentId === rootsB.otherId && node.url === `${PUBLIC_URL}/range`)).toHaveLength(0);
    await pageA.evaluate(async ({ id, parentId }) => chrome.bookmarks.move(id, { parentId }), { id: nativeA, parentId: rootsA.barId });
    await expect.poll(async () => {
      return (await chromeTree(pageB)).filter(node => node.title === 'FRR range renamed' && node.parentId === rootsB.barId).length;
    }, { timeout: 90_000 }).toBe(1);
    const materialized = (await chromeTree(pageB)).find(node => node.title === 'FRR range renamed')!;
    expect(materialized.id).not.toBe(originalB.id);
    expect((await chromeTree(pageB)).filter(node => node.url === `${PUBLIC_URL}/range`)).toHaveLength(2);
    expect((await command('known.scope.rejoin', otherMount)).ok).toBe(true);
    expect((await command('known.scope.detach', barMount)).ok).toBe(true);
    await pageA.evaluate(async id => chrome.bookmarks.remove(id), nativeA);
    await expect.poll(async () => {
      return ((await exportedScope(pageB)).remoteObservations ?? []).some((row: { kind?: string }) => row.kind === 'tombstone');
    }, { timeout: 90_000 }).toBe(true);
    expect((await chromeTree(pageB)).some(node => node.id === materialized.id)).toBe(true);
    expect((await command('known.scope.rejoin', barMount)).ok).toBe(true);
    await expect.poll(async () => (await chromeTree(pageB)).some(node => node.id === materialized.id)).toBe(false);
    expect((await chromeTree(pageB)).some(node => node.id === originalB.id)).toBe(true);
    assertUniqueMappings(await exportedScope(pageB));
    await writeScenarioEvidence({ testInfo, id, startDigest: 'n/a',
      ops: ['range-exit', 'remote-update', 'range-entry', 'detached-delete', 'rejoin'],
      endTree: { retainedLocalCopies: 1 }, mapping: { count: (await exportedScope(pageB)).mappings?.length },
      cursor: (await exportedScope(pageB)).cursor?.cursor ?? null, receipt: {}, logs, extraRedact: [stack.authUserId] });
  } catch (error) {
    await saveReplayFixture(testInfo, id, error, {
      a: a ? await captureReplayFacts(await optionsPage(a), stack, bindingA).catch(() => ({})) : {},
      b: b ? await captureReplayFacts(await optionsPage(b), stack, bindingB).catch(() => ({})) : {},
    });
    throw error;
  } finally { await closeAll(a, b); await stack.close(); await rmDirs(dirs); }
});
