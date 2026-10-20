import { chromium, expect, test, type BrowserContext, type Page } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { startRealStack, type PushRequestObservation } from './real-stack.js';
import { expectAuthenticatedRestartReplay } from './push-replay-assertions.js';
import { grantOptionalBookmarks } from './bookmark-permission.js';
import { installFixtureReplicaBinding, openExtensionOptions, signInExtension, showOptionsPane } from './extension-auth.js';

const EXTENSION_ID = 'pplpnpegpnghcddhmpgkbfkdfadjiaen';
const extensionPath = resolve(import.meta.dirname, '../dist/production');

test('real bookmark create/update/delete events become one canonical Push and receipt each', async () => {
  test.setTimeout(120_000);
  const stack = await startRealStack(); const profile = await mkdtemp(resolve(tmpdir(), 'known-p3-31-crud-'));
  const context = await launchPersistentContext(profile, stack.browserHostResolverRules);
  try {
    const browserEvidence: string[] = [];
    context.on('console', (message) => browserEvidence.push(`console:${message.text()}`));
    context.on('request', (request) => browserEvidence.push(`request:${request.url()}`));
    const page = await extensionPage(context); await login(page, stack.extensionBinding); await grantBookmarks(page);
    const roots = await page.evaluate(() => chrome.bookmarks.getTree()); const bar = roots[0]!.children![0]!.id;
    const selected = await page.evaluate((parentId) => chrome.bookmarks.create({ parentId, title: 'P3-31 selected' }), bar);
    const privateRoot = await page.evaluate((parentId) => chrome.bookmarks.create({ parentId,
      title: 'PRIVATE-P3-31-ROOT' }), bar);
    await evidence(page, 'configureOutboundBookmarkRoot', selected.id, privateRoot.id, 'p3-27-root', 'r1');
    const privateBookmark = await page.evaluate((parentId) => chrome.bookmarks.create({ parentId,
      title: 'PRIVATE-P3-31-TITLE', url: 'https://private-p3-31.invalid/token-private' }), privateRoot.id);
    const unselectedBookmark = await page.evaluate((parentId) => chrome.bookmarks.create({ parentId,
      title: 'UNSELECTED-P3-31-TITLE', url: 'https://unselected-p3-31.invalid/token-unselected' }), bar);
    const folder = await page.evaluate((parentId) => chrome.bookmarks.create({ parentId, title: 'Public folder' }), selected.id);
    await waitForTerminalCount(page, 1, true);
    const bookmark = await page.evaluate((parentId) => chrome.bookmarks.create({ parentId, title: 'Public bookmark',
      url: 'https://example.test/p3-31/crud' }), folder.id);
    await waitForTerminalCount(page, 2, true);
    await page.evaluate((id) => chrome.bookmarks.update(id, { title: 'Public bookmark updated' }), bookmark.id);
    await waitForTerminalCount(page, 3, true);
    await page.evaluate((id) => chrome.bookmarks.remove(id), bookmark.id); await waitForTerminalCount(page, 4, true);

    const local = await evidence<any>(page, 'exportOutboundPushEvidence'); const server = await stack.observations() as any;
    expect(local.queue.map((item: any) => item.payload.type)).toEqual(
      ['create_node', 'create_node', 'update_node_content', 'delete_node']);
    expect(local.queue.map((item: any) => item.sequence)).toEqual([1, 2, 3, 4]);
    expect(local.queue.every((item: any) => item.status === 'terminal')).toBe(true);
    // Ack-driven compaction may remove attempt bytes after the terminal receipt.
    for (const item of local.queue) {
      if (item.attempt) continue;
      expect(item.payload.compacted).toBe(true);
      expect(local.compactSummaries).toContainEqual(expect.objectContaining({
        kind: 'queue', opId: item.opId, sequence: item.sequence, digest: item.digest,
      }));
    }
    expect(local.receipts.map((receipt: any) => receipt.result.results[0].status)
      .every((status: string) => /^(applied|rebased|noop)$/u.test(status))).toBe(true);
    expect(local.receipts).toHaveLength(4); expect(server.sequenceReceipts).toHaveLength(4);
    expect(server.pushRequestDigests).toHaveLength(4); expect(new Set(server.pushRequestDigests).size).toBe(4);
    for (let index = 0; index < local.queue.length; index += 1) {
      expect(Number(server.sequenceReceipts[index].sequence_number)).toBe(index + 1);
      expect(server.sequenceReceipts[index].op_id).toBe(local.queue[index].opId);
      expect(server.sequenceReceipts[index].result_json).toEqual(
        local.receipts.find((receipt: any) => receipt.opId === local.queue[index].opId).result);
    }
    const bookmarkId = local.receipts.find((receipt: any) => receipt.opId === local.queue[1].opId)
      .result.results[0].targetId;
    const deleted = server.canonicalNodes.find((node: any) => node.id === bookmarkId);
    expect(deleted).toMatchObject({ title: 'Public bookmark updated' }); expect(deleted.deleted_at).not.toBeNull();
    const privacyEvidence = JSON.stringify({ queue: local.queue, receipts: local.receipts,
      requests: server.pushRequests, responses: server.pushResponses,
      canonical: server.canonicalNodes,
      browserEvidence });
    for (const nativeId of [selected.id, privateRoot.id, privateBookmark.id, unselectedBookmark.id, folder.id, bookmark.id]) {
      expect(privacyEvidence).not.toContain(JSON.stringify(nativeId));
    }
    for (const sentinel of ['PRIVATE-P3-31-ROOT', 'PRIVATE-P3-31-TITLE',
      'UNSELECTED-P3-31-TITLE', 'private-p3-31.invalid', 'unselected-p3-31.invalid', 'token-private',
      'token-unselected', 'p3-27-access-', 'refresh-', 'eyJ']) expect(privacyEvidence).not.toContain(sentinel);
    // The opaque session credential uses the COLP Bearer transport and must
    // be redacted in observations; no browser cookie is forwarded.
    expect(server.pushRequests.every((request: PushRequestObservation) => request.url === '/v1/push'
      && !request.sessionCookiePresent && request.bearerAuthorizationPresent
      && request.headers.authorization === '[redacted]' && request.headers.cookie === undefined)).toBe(true);
  } finally { await context.close(); await stack.close(); await rm(profile, { recursive: true, force: true }); }
});

test('real bookmark move uses public-HTTP seeded parent revisions and commits one canonical move', async () => {
  test.setTimeout(90_000);
  const stack = await startRealStack(); const profile = await mkdtemp(resolve(tmpdir(), 'known-p3-31-move-'));
  const context = await launchPersistentContext(profile, stack.browserHostResolverRules);
  try {
    const canonical = await stack.seedCanonicalFixture();
    const page = await extensionPage(context); await login(page, stack.extensionBinding); await grantBookmarks(page);
    const roots = await page.evaluate(() => chrome.bookmarks.getTree()); const bar = roots[0]!.children![0]!.id;
    const selected = await page.evaluate((parentId) => chrome.bookmarks.create({ parentId, title: 'Move selected' }), bar);
    const folder = await page.evaluate((parentId) => chrome.bookmarks.create({ parentId, title: 'Authority folder' }), selected.id);
    const bookmark = await page.evaluate((parentId) => chrome.bookmarks.create({ parentId, title: 'Authority bookmark',
      url: 'https://example.test/p3-31/authority' }), selected.id);
    await evidence(page, 'drainBookmarkEventCaptureEvidence');
    await evidence(page, 'configureOutboundCanonicalFixture', selected.id, null, folder.id, bookmark.id, canonical);
    await page.evaluate(({ id, parentId }) => chrome.bookmarks.move(id, { parentId, index: 0 }),
      { id: bookmark.id, parentId: folder.id });
    await waitForTerminalCount(page, 1);
    const local = await evidence<any>(page, 'exportOutboundPushEvidence'); const observed = await stack.observations() as any;
    expect(local.queue).toHaveLength(1); expect(local.queue[0].payload.type).toBe('move_node');
    expect(local.queue[0].payload.targetId).toBe(canonical.bookmarkId);
    // Terminal queue bodies may already be compacted; verify the actual wire operation.
    const sent = (observed.pushRequests as PushRequestObservation[]).flatMap((request) =>
      (JSON.parse(request.body) as { operations: Array<{ opId: string; payload: unknown }> }).operations)
      .filter((operation) => operation.opId === local.queue[0].opId);
    expect(sent.length).toBeGreaterThanOrEqual(1);
    // A rejected stale parent revision can be rebased under the same opId.
    expect(sent.at(-1)!.payload).toMatchObject({ newParentId: canonical.folderId,
      baseSourceParentRevision: canonical.rootRevision, baseTargetParentRevision: canonical.folderRevision });
    expect(local.receipts[0].result.results[0].status).toMatch(/applied|rebased/);
    const serverMoves = observed.sequenceReceipts.filter((item: any) => item.op_id === local.queue[0].opId);
    expect(serverMoves).toHaveLength(1);
    const serverMove = serverMoves[0];
    expect(serverMove.result_json).toEqual(local.receipts[0].result);
    expect(observed.canonicalNodes.find((node: any) => node.id === canonical.bookmarkId).parent_id).toBe(canonical.folderId);
  } finally { await context.close(); await stack.close(); await rm(profile, { recursive: true, force: true }); }
});

test('real concurrent authority update yields durable Conflict and blocks later sequence without auto-resolution', async () => {
  test.setTimeout(90_000);
  const stack = await startRealStack(); const profile = await mkdtemp(resolve(tmpdir(), 'known-p3-31-conflict-'));
  const context = await launchPersistentContext(profile, stack.browserHostResolverRules);
  try {
    const browserEvidence: string[] = []; context.on('console', (message) => browserEvidence.push(message.text()));
    const canonical = await stack.seedCanonicalFixture();
    const page = await extensionPage(context); await login(page, stack.extensionBinding); await grantBookmarks(page);
    const roots = await page.evaluate(() => chrome.bookmarks.getTree()); const bar = roots[0]!.children![0]!.id;
    const selected = await page.evaluate((parentId) => chrome.bookmarks.create({ parentId, title: 'Conflict selected' }), bar);
    const folder = await page.evaluate((parentId) => chrome.bookmarks.create({ parentId, title: 'Authority folder' }), selected.id);
    const bookmark = await page.evaluate((parentId) => chrome.bookmarks.create({ parentId, title: 'Authority bookmark',
      url: 'https://example.test/p3-31/authority' }), selected.id);
    await evidence(page, 'drainBookmarkEventCaptureEvidence');
    await evidence(page, 'configureOutboundCanonicalFixture', selected.id, null, folder.id, bookmark.id, canonical);
    await stack.concurrentlyUpdateCanonicalBookmark(canonical);
    await page.evaluate((id) => chrome.bookmarks.update(id, { title: 'Extension stale update' }), bookmark.id);
    await expect.poll(async () => (await evidence<any>(page, 'exportOutboundPushEvidence')).queue[0]?.status,
      { timeout: 15_000 }).toBe('blocked');
    const conflict = await evidence<any>(page, 'exportOutboundPushEvidence');
    expect(conflict.queue[0].payload.type).toBe('update_node_content');
    expect(conflict.receipts[0].result.results[0]).toMatchObject({ status: 'conflicted' });
    expect(conflict.queue[0]).toMatchObject({ status: 'blocked', recovery: { code: 'conflict_pending' } });
    const requestCount = ((await stack.observations() as any).pushRequests as unknown[]).length;
    // The second native update must be captured as new pending work for this
    // bookmark. Events merely in flight when this snapshot was taken (the
    // conflicted one is still transitioning) are filtered out. The capture can
    // land in either lane: the listener's own row, or a `native-barrier:` row
    // when a pull applies first (src/pull-native-content-barrier.ts), which
    // moves the projection so the listener then sees no change. Both may exist.
    const pendingBefore = new Set((await evidence<any>(page, 'exportOutboundPushEvidence')).bookmarkEvents
      .filter((event: any) => event.status === 'pending').map((event: any) => event.eventId));
    await page.evaluate((id) => chrome.bookmarks.update(id, { title: 'Must remain behind conflict' }), bookmark.id);
    await expect.poll(async () => {
      const added = (await evidence<any>(page, 'exportOutboundPushEvidence')).bookmarkEvents
        .filter((event: any) => event.status === 'pending' && !pendingBefore.has(event.eventId));
      return { nativeIds: [...new Set(added.map((event: any) => event.nativeId))],
        listenerRows: added.filter((event: any) => !String(event.eventId).startsWith('native-barrier:')).length <= 1,
        captured: added.some((event: any) => event.details?.draft?.payload?.value?.title === 'Must remain behind conflict') };
    }, { timeout: 15_000 }).toEqual({ nativeIds: [bookmark.id], listenerRows: true, captured: true });
    await Promise.all([evidence(page, 'duplicateAlarm'), evidence(page, 'wakeOutboundPushEvidence')]);
    const barrier = await evidence<any>(page, 'exportOutboundPushEvidence');
    const observed = await stack.observations() as any;
    expect((observed.pushRequests as unknown[])).toHaveLength(requestCount);
    expect(barrier.queue).toHaveLength(1); expect(barrier.sequence.next).toBe(2); expect(barrier.receipts).toHaveLength(1);
    expect(observed.sequenceReceipts).toHaveLength(1);
    expect(observed.sequenceReceipts[0].result_json).toEqual(barrier.receipts[0].result);
    expect(observed.canonicalNodes.find((node: any) => node.id === canonical.bookmarkId).title)
      .toBe('Concurrent authority update');
    const privacy = JSON.stringify({ queue: barrier.queue, receipts: barrier.receipts, browserEvidence,
      requests: observed.pushRequests, responses: observed.pushResponses });
    expect(privacy).not.toContain(JSON.stringify(folder.id));
    expect(privacy).not.toContain(JSON.stringify(bookmark.id));
  } finally { await context.close(); await stack.close(); await rm(profile, { recursive: true, force: true }); }
});

for (const boundary of ['before_attempt_persist', 'after_attempt_persist'] as const) {
  test(`${boundary} CDP termination recovers without send/gap/duplicate`, async () => {
    test.setTimeout(90_000);
    const stack = await startRealStack(); const profile = await mkdtemp(resolve(tmpdir(), `known-p3-31-${boundary}-`));
    let context = await launchPersistentContext(profile, stack.browserHostResolverRules);
    try {
      let page = await extensionPage(context); await login(page, stack.extensionBinding);
      await evidence(page, 'configureOutboundLeaseEvidence', 1_000);
      await evidence(page, 'configureOutboundBoundaryEvidence', boundary); await evidence(page, 'seedOutboundPushEvidence');
      void evidence(page, 'wakeOutboundPushEvidence').catch(() => undefined);
      await expect.poll(async () => { const queue = (await evidence<any>(page, 'exportOutboundPushEvidence')).queue[0];
        return { status: queue.status, attempted: queue.attempt !== undefined };
      }).toEqual({ status: 'claimed', attempted: boundary === 'after_attempt_persist' });
      const crashed = await evidence<any>(page, 'exportOutboundPushEvidence');
      expect(((await stack.observations() as any).pushRequests as unknown[])).toHaveLength(0);
      await terminateExtensionWorker(context, page); await context.close();
      context = await launchPersistentContext(profile, stack.browserHostResolverRules);
      page = await extensionPage(context); await evidence(page, 'wakeOutboundPushEvidence'); await waitForTerminalCount(page, 1);
      const recovered = await evidence<any>(page, 'exportOutboundPushEvidence'); const observed = await stack.observations() as any;
      expect(recovered.queue[0].sequence).toBe(crashed.queue[0].sequence);
      if (boundary === 'after_attempt_persist') {
        expectAuthenticatedRestartReplay(crashed.queue[0], recovered.queue[0], observed);
        expect(observed.pushRequests[0].fingerprint).toBe(crashed.queue[0].attempt.bodyDigest);
        expect(observed.pushRequests[0].headers['idempotency-key']).toBe(crashed.queue[0].attempt.idempotencyKey);
      }
      expect(observed.pushRequests).toHaveLength(boundary === 'after_attempt_persist' ? 2 : 1);
      expect(observed.serverMutationCount).toBe(1);
      expect(observed.sequenceReceipts).toHaveLength(1); expect(recovered.receipts).toHaveLength(1);
    } finally { await context.close(); await stack.close(); await rm(profile, { recursive: true, force: true }); }
  });
}

test('401 rejects the old attempt before credential refresh replaces Session-bound bytes exactly once', async () => {
  const stack = await startRealStack(); const profile = await mkdtemp(resolve(tmpdir(), 'known-p3-31-auth-'));
  const context = await launchPersistentContext(profile, stack.browserHostResolverRules);
  try {
    const page = await extensionPage(context); await login(page, stack.extensionBinding);
    const beforeDenial = await stack.observations() as any;
    stack.setPushFault('authentication_required_once'); await evidence(page, 'seedOutboundPushEvidence');
    const seeded = await evidence<any>(page, 'exportOutboundPushEvidence');
    await evidence(page, 'wakeOutboundPushEvidence'); await waitForTerminalCount(page, 1);
    const state = await evidence<any>(page, 'exportOutboundPushEvidence');     const observed = await stack.observations() as any;
    expect(observed.sessions).toBe(beforeDenial.sessions + 1); expect(observed.pushRequests).toHaveLength(2);
    const [denied, accepted] = observed.pushRequests.map((request: PushRequestObservation) => JSON.parse(request.body));
    expect(denied.sessionId).not.toBe(accepted.sessionId); expect(denied.batchId).not.toBe(accepted.batchId);
    expect(denied.operations).toEqual(accepted.operations);
    expect(observed.pushRequests[0].headers['idempotency-key']).toBe(observed.pushRequests[1].headers['idempotency-key']);
    expect(state.queue[0].opId).toBe(accepted.operations[0].opId);
    expect(state.queue[0].sequence).toBe(accepted.operations[0].sequence);
    expect(state.queue[0].digest).toBe(seeded.queue[0].digest);
    expect(state.queue[0].idempotencyKey).toBe(seeded.queue[0].idempotencyKey);
    expect(state.queue[0].attempt.body).toBe(observed.pushRequests[1].body);
    expect(observed.serverMutationCount).toBe(1);
    expect(observed.sequenceReceipts).toHaveLength(1);
  } finally { await context.close(); await stack.close(); await rm(profile, { recursive: true, force: true }); }
});

for (const fault of ['service_unavailable_once', 'rate_limited_once'] as const) {
  test(`${fault} persists an immutable attempt and recovers through the production Push route`, async () => {
    const stack = await startRealStack(); const profile = await mkdtemp(resolve(tmpdir(), `known-p3-31-${fault}-`));
    const context = await launchPersistentContext(profile, stack.browserHostResolverRules);
    try {
      const page = await extensionPage(context); await login(page, stack.extensionBinding);
      stack.setPushFault(fault); await evidence(page, 'seedOutboundPushEvidence'); await evidence(page, 'wakeOutboundPushEvidence');
      await expect.poll(async () => (await evidence<any>(page, 'exportOutboundPushEvidence')).queue[0].status).toBe('unknown');
      const before = await evidence<any>(page, 'exportOutboundPushEvidence');
      if (fault === 'rate_limited_once') expect(before.queue[0].retry.notBefore).toBeGreaterThan(Date.now());
      // MV3 clamps every scheduled retry to a 30s alarm floor (`sw/engine.ts`), which is
      // exactly this helper's poll budget, so a wake driven inside the retry window only
      // arms an alarm that races the assertion. Wait the window out and drive the wake
      // ourselves: the assertions below are about the durable attempt and the production
      // Push route, not about which timer delivered the retry.
      await waitForRetryWindow(page, before.queue[0].retry.notBefore);
      await evidence(page, 'wakeOutboundPushEvidence');
      await waitForTerminalCount(page, 1); const after = await evidence<any>(page, 'exportOutboundPushEvidence');
      const observed = await stack.observations() as any;
      expect(after.queue[0].attempt).toEqual(before.queue[0].attempt);
      expect(observed.pushRequests[0].fingerprint).toBe(observed.pushRequests[1].fingerprint);
      expect(observed.serverMutationCount).toBe(1); expect(observed.sequenceReceipts).toHaveLength(1);
    } finally { await context.close(); await stack.close(); await rm(profile, { recursive: true, force: true }); }
  });
}

/**
 * Waits until a durable retry is claimable. The row's `retry.notBefore` is the only clock the
 * claim path honours, and it is always in the future right after a fault.
 */
async function waitForRetryWindow(page: Page, notBefore: number) {
  await expect.poll(async () => (await evidence<any>(page, 'exportOutboundPushEvidence')).queue[0].retry.notBefore <= Date.now(),
    { timeout: 15_000, message: `retry window for notBefore ${notBefore} did not open` }).toBe(true);
}

test('deferred receipt persists across restart, holds sequence order, then converges through Postgres', async () => {
  test.setTimeout(90_000);
  const stack = await startRealStack(); const profile = await mkdtemp(resolve(tmpdir(), 'known-p3-31-deferred-'));
  let context = await launchPersistentContext(profile, stack.browserHostResolverRules);
  try {
    let page = await extensionPage(context); await login(page, stack.extensionBinding);
    await evidence(page, 'configureOutboundLeaseEvidence', 1_000);
    stack.setPushFault('deferred_once'); await evidence(page, 'seedOutboundPushEvidence');
    await evidence(page, 'wakeOutboundPushEvidence');
    await expect.poll(async () => (await evidence<any>(page, 'exportOutboundPushEvidence')).queue[0].status).toBe('deferred');
    const deferred = await evidence<any>(page, 'exportOutboundPushEvidence'); expect(deferred.receipts[0].kind).toBe('deferred');
    await terminateExtensionWorker(context, page); await context.close();
    context = await launchPersistentContext(profile, stack.browserHostResolverRules);
    page = await extensionPage(context); await evidence(page, 'wakeOutboundPushEvidence'); await waitForTerminalCount(page, 1);
    const recovered = await evidence<any>(page, 'exportOutboundPushEvidence'); const observed = await stack.observations() as any;
    expectAuthenticatedRestartReplay(deferred.queue[0], recovered.queue[0], observed);
    expect(recovered.receipts[0].kind).toBe('terminal'); expect(observed.serverMutationCount).toBe(1);
    expect(observed.sequenceReceipts).toHaveLength(1);
  } finally { await context.close(); await stack.close(); await rm(profile, { recursive: true, force: true }); }
});

for (const [fault, status] of [['sequence_blocked_once', 'blocked']] as const) {
  test(`${status} preserves exact bytes until a bounded retry across browser restart`, async () => {
    const stack = await startRealStack(); const profile = await mkdtemp(resolve(tmpdir(), `known-p3-31-${status}-`));
    let context = await launchPersistentContext(profile, stack.browserHostResolverRules);
    try {
      let page = await extensionPage(context); await login(page, stack.extensionBinding);
      stack.setPushFault(fault); await evidence(page, 'seedOutboundPushEvidence'); await evidence(page, 'duplicateAlarm');
      await expect.poll(async () => (await evidence<any>(page, 'exportOutboundPushEvidence')).queue[0].status).toBe(status);
      const before = await evidence<any>(page, 'exportOutboundPushEvidence');
      await terminateExtensionWorker(context, page); await context.close();
      context = await launchPersistentContext(profile, stack.browserHostResolverRules);
      page = await extensionPage(context); await evidence(page, 'wakeOutboundPushEvidence');
      await waitForTerminalCount(page, 1);
      const local = await evidence<any>(page, 'exportOutboundPushEvidence'); const after = await stack.observations() as any;
      expect(local.queue[0].opId).toBe(before.queue[0].opId);
      expect(local.queue[0].sequence).toBe(before.queue[0].sequence);
      expectAuthenticatedRestartReplay(before.queue[0], local.queue[0], after);
      expect(after.serverMutationCount).toBe(1); expect(after.sequenceReceipts).toHaveLength(1);
    } finally { await context.close(); await stack.close(); await rm(profile, { recursive: true, force: true }); }
  });
}

/**
 * `sequence_gap` is deliberately NOT in the durable-barrier loop above. When the server reports the
 * lane's own next slot (`expected === head.sequence`, which is what a real gap carries), the queue
 * documents the barrier as healable: `realignQueueAfterGap` clears it and replays the retained
 * attempt as-is (`src/sync-state/queue-repository.ts:305-317`). The old shared body asserted the row
 * stayed `gap` after several wakes, which that realign makes impossible - the row healed into
 * `terminal` before the assertion could see it. A blocked sequence retries only its retained exact attempt; a gap is durable *evidence* that heals exactly once, and that is what
 * this asserts.
 */
test('sequence_gap stands as durable evidence with the lane slot, then heals exactly once', async () => {
  const stack = await startRealStack(); const profile = await mkdtemp(resolve(tmpdir(), 'known-p3-31-gap-'));
  const context = await launchPersistentContext(profile, stack.browserHostResolverRules);
  try {
    const page = await extensionPage(context); await login(page, stack.extensionBinding);
    stack.setPushFault('sequence_gap'); await evidence(page, 'seedOutboundPushEvidence');
    // One wake: the refused attempt is settled as a `gap` barrier carrying the server's slot.
    await evidence(page, 'wakeOutboundPushEvidence');
    await expect.poll(async () => (await evidence<any>(page, 'exportOutboundPushEvidence')).queue[0].status).toBe('gap');
    const gapped = await evidence<any>(page, 'exportOutboundPushEvidence');
    expect(gapped.queue[0].recovery.code).toBe('sequence_gap');
    expect(gapped.queue[0].recovery.expectedSequence).toBe(gapped.queue[0].sequence);
    const before = await stack.observations() as any;
    expect(before.sequenceReceipts).toHaveLength(0); expect(before.serverMutationCount).toBe(0);
    // Release the held denial only after observing the durable gap.
    stack.setPushFault('none');
    // The next drain realigns onto that slot and replays the same bytes, once.
    await evidence(page, 'wakeOutboundPushEvidence'); await waitForTerminalCount(page, 1);
    const after = await stack.observations() as any; const healed = await evidence<any>(page, 'exportOutboundPushEvidence');
    expect(healed.queue[0].status).toBe('terminal');
    expect(after.pushRequests).toHaveLength(before.pushRequests.length + 1);
    expect(after.serverMutationCount).toBe(1); expect(after.sequenceReceipts).toHaveLength(1);
  } finally { await context.close(); await stack.close(); await rm(profile, { recursive: true, force: true }); }
});

test('timeout survives worker and browser restart with byte-identical unknown attempt and one mutation', async () => {
  test.setTimeout(90_000);
  const stack = await startRealStack(); const profile = await mkdtemp(resolve(tmpdir(), 'known-p3-31-timeout-'));
  let context = await launchPersistentContext(profile, stack.browserHostResolverRules);
  try {
    let page = await extensionPage(context); await login(page, stack.extensionBinding);
    await evidence(page, 'configureOutboundLeaseEvidence', 1_000);
    stack.setPushFault('timeout_once'); await evidence(page, 'seedOutboundPushEvidence');
    void evidence(page, 'wakeOutboundPushEvidence').catch(() => undefined);
    await expect.poll(async () => (await evidence<any>(page, 'exportOutboundPushEvidence')).queue[0].status,
      { timeout: 25_000 }).toBe('unknown');
    const before = await evidence<any>(page, 'exportOutboundPushEvidence'); await terminateExtensionWorker(context, page);
    await context.close(); context = await launchPersistentContext(profile, stack.browserHostResolverRules);
    page = await extensionPage(context);
    await evidence(page, 'wakeOutboundPushEvidence'); await waitForTerminalCount(page, 1);
    const after = await evidence<any>(page, 'exportOutboundPushEvidence'); const observed = await stack.observations() as any;
    expectAuthenticatedRestartReplay(before.queue[0], after.queue[0], observed);
    expect(after.queue[0].retry.fence).toBeUndefined();
    expect(observed.pushRequests[0].fingerprint).toBe(observed.pushRequests[1].fingerprint);
    expect(observed.serverMutationCount).toBe(1); expect(observed.sequenceReceipts).toHaveLength(1);
  } finally { await context.close(); await stack.close(); await rm(profile, { recursive: true, force: true }); }
});

test('receipt transaction abort rolls back local receipt and queue commit, then exact-replays after restart', async () => {
  test.setTimeout(90_000);
  const stack = await startRealStack(); const profile = await mkdtemp(resolve(tmpdir(), 'known-p3-31-receipt-abort-'));
  let context = await launchPersistentContext(profile, stack.browserHostResolverRules);
  try {
    let page = await extensionPage(context); await login(page, stack.extensionBinding);
    await evidence(page, 'configureOutboundLeaseEvidence', 1_000);
    await evidence(page, 'configureOutboundPushFaultEvidence', 'after_receipt');
    await evidence(page, 'seedOutboundPushEvidence'); await evidence(page, 'wakeOutboundPushEvidence');
    await expect.poll(async () => (await evidence<any>(page, 'exportOutboundPushEvidence')).queue[0].status).toBe('unknown');
    const aborted = await evidence<any>(page, 'exportOutboundPushEvidence'); expect(aborted.receipts).toHaveLength(0);
    await terminateExtensionWorker(context, page); await context.close();
    context = await launchPersistentContext(profile, stack.browserHostResolverRules);
    page = await extensionPage(context); await evidence(page, 'wakeOutboundPushEvidence'); await waitForTerminalCount(page, 1);
    const recovered = await evidence<any>(page, 'exportOutboundPushEvidence'); const observed = await stack.observations() as any;
    expectAuthenticatedRestartReplay(aborted.queue[0], recovered.queue[0], observed); expect(recovered.receipts).toHaveLength(1);
    expect(observed.serverMutationCount).toBe(1); expect(observed.sequenceReceipts).toHaveLength(1);
  } finally { await context.close(); await stack.close(); await rm(profile, { recursive: true, force: true }); }
});

test('production MV3 exact-replays a committed Push after disconnect and converges after restart', async () => {
  test.setTimeout(90_000);
  const stack = await startRealStack(); const profile = await mkdtemp(resolve(tmpdir(), 'known-p3-31-profile-'));
  let context = await launchPersistentContext(profile, stack.browserHostResolverRules);
  try {
    let page = await extensionPage(context); await login(page, stack.extensionBinding);
    await stack.commitAfterDisconnect(); await evidence(page, 'seedOutboundPushEvidence'); await evidence(page, 'wakeOutboundPushEvidence');
    await expect.poll(async () => (await evidence<any>(page, 'exportOutboundPushEvidence')).queue[0].status).toBe('unknown');
    const before = await evidence<any>(page, 'exportOutboundPushEvidence');
    await terminateExtensionWorker(context, page); await context.close();
    context = await launchPersistentContext(profile, stack.browserHostResolverRules); page = await extensionPage(context);
    await stack.restorePushResponses(); await evidence(page, 'wakeOutboundPushEvidence');
    await expect.poll(async () => {
      const state = await evidence<any>(page, 'exportOutboundPushEvidence');
      if (state.queue[0].status === 'rejected') {
        const observed = await stack.observations() as any;
        throw new Error(`push rejected: ${JSON.stringify({ recovery: state.queue[0].recovery,
          mutationCount: observed.serverMutationCount, requestCount: observed.pushRequestDigests.length,
          pushErrors: observed.pushErrors })}`);
      }
      return state.queue[0].status;
    }, { timeout: 40_000 }).toBe('terminal');
    const after = await evidence<any>(page, 'exportOutboundPushEvidence'); const observed = await stack.observations() as any;
    expect(after.queue[0].opId).toBe(before.queue[0].opId); expect(after.queue[0].sequence).toBe(before.queue[0].sequence);
    expect(after.queue[0].idempotencyKey).toBe(before.queue[0].idempotencyKey);
    expect(after.queue[0].digest).toBe(before.queue[0].digest);
    expect(after.queue[0].payload).toEqual(before.queue[0].payload);
    expectAuthenticatedRestartReplay(before.queue[0], after.queue[0], observed);
    expect(observed.serverMutationCount).toBe(1); expect(observed.serverReceiptDigest).toMatch(/^[0-9a-f]{64}$/);
    // The immutable Sequence result survives; the transport envelope is bound
    // to the Session that answered the authenticated replay.
    const { batchId: storedBatch, ...storedResult } = observed.serverReceipt;
    const { batchId: replayBatch, ...replayedResult } = after.receipts[0].result;
    expect(replayedResult).toEqual(storedResult);
    expect(storedBatch.startsWith(`${before.queue[0].attempt.sessionId}.`)).toBe(true);
    expect(replayBatch.startsWith(`${after.queue[0].attempt.sessionId}.`)).toBe(true);
  } finally { await context.close(); await stack.close(); await rm(profile, { recursive: true, force: true }); }
});

test('duplicate alarm and two extension contexts cannot produce divergent sends', async () => {
  const stack = await startRealStack();
  const profileA = await mkdtemp(resolve(tmpdir(), 'known-p3-31-race-a-'));
  const profileB = await mkdtemp(resolve(tmpdir(), 'known-p3-31-race-b-'));
  const contextA = await launchPersistentContext(profileA, stack.browserHostResolverRules);
  const contextB = await launchPersistentContext(profileB, stack.browserHostResolverRules);
  try {
    const first = await extensionPage(contextA); const second = await extensionPage(contextB);
    await login(first, stack.extensionBinding); await login(second, stack.extensionBinding);
    await evidence(first, 'seedOutboundPushEvidence'); await evidence(second, 'seedOutboundPushEvidence');
    await Promise.all([evidence(first, 'duplicateAlarm'), evidence(second, 'duplicateAlarm')]);
    await expect.poll(async () => (await stack.observations() as any).serverMutationCount, { timeout: 20_000 }).toBe(1);
    const observed = await stack.observations() as any; expect(observed.serverMutationCount).toBe(1);
    expect(observed.pushRequestDigests.length).toBeGreaterThanOrEqual(1);
    await expect.poll(async () => {
      const [left, right] = await Promise.all([evidence<any>(first, 'exportOutboundPushEvidence'),
        evidence<any>(second, 'exportOutboundPushEvidence')]);
      const statuses = [left.queue[0].status, right.queue[0].status].sort();
      // The refused replica settles through a retry, and every MV3 retry is clamped to a 30s
      // alarm floor (`sw/engine.ts`) - longer than this poll. Nudge both replicas instead of
      // waiting for that timer: the claim under test is the outcome (one mutation, no divergent
      // send), not which timer delivered the re-examination.
      if (statuses.includes('unknown')) {
        await Promise.all([evidence(first, 'wakeOutboundPushEvidence'), evidence(second, 'wakeOutboundPushEvidence')]);
      }
      return statuses;
    }, { timeout: 30_000 }).toEqual(['terminal', 'unknown']);
    const states = await Promise.all([evidence<any>(first, 'exportOutboundPushEvidence'),
      evidence<any>(second, 'exportOutboundPushEvidence')]);
    // The loser is durably `unknown` carrying the server's reuse refusal, not `rejected`:
    // `classifySequenceReuse` only returns `illegal` (which settles the row `rejected`) when an
    // identity fact mismatches, and two contexts bound to the same replica match on every one of
    // them. `sequence_reuse` means "your result is unknown", not "your operation did not execute"
    // (`src/logical-operation-identity.ts:53-61`), so the row stays replayable with the server's
    // code - which is exactly what keeps this from being a silent divergent send.
    const refused = states.find((state) => state.queue[0].status !== 'terminal')!;
    expect(refused.queue[0].recovery.code).toMatch(/stale_replica|sequence_reuse|op_id_reused/);
    expect((await stack.observations() as any).serverMutationCount).toBe(1);
  } finally {
    await contextA.close(); await contextB.close(); await stack.close();
    await rm(profileA, { recursive: true, force: true }); await rm(profileB, { recursive: true, force: true });
  }
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
  await signInExtension(page); await grantBookmarks(page); }
async function grantBookmarks(page: Page) {
  if (await page.evaluate(() => chrome.permissions.contains({ permissions: ['bookmarks'] }))) return;
  await showOptionsPane(page, 'folders');
  await grantOptionalBookmarks(page, 'Allow bookmark access', 'Known outbound permission');
  await expect.poll(() => page.evaluate(() => chrome.permissions.contains({ permissions: ['bookmarks'] }))).toBe(true);
}
async function waitForTerminalCount(page: Page, count: number, awaitPullEcho = false) {
  // A callback racing Pull's recovery freeze is staged for the recovery alarm.
  // Its 30-second MV3 minimum must elapse before we allow time for Push/receipt.
  try { await expect.poll(async () => { const state = await evidence<any>(page, 'exportOutboundPushEvidence');
    // Sequential CRUD checks need the full round trip before the next edit; a Push receipt can precede Pull.
    return state.queue.filter((item: any) => item.status === 'terminal'
      && (!awaitPullEcho || item.echoApplied === true)).length; }, { timeout: 60_000 }).toBe(count); }
  catch (error) { const state = await evidence<any>(page, 'exportOutboundPushEvidence');
    const engine = await evidence<any>(page, 'syncEngineState');
    const summary = state.queue.map((item: any) => ({ sequence: item.sequence, status: item.status,
      recovery: item.recovery, type: item.payload.type, baseRevision: item.baseRevision,
      attemptDigest: item.attempt?.bodyDigest }));
    const events = state.bookmarkEvents.map((item: any) => ({ kind: item.kind, status: item.status,
      hasOpId: item.opId !== null }));
    const mappings = state.mappings.map((item: any) => ({ nodeKind: item.nodeKind, colpId: item.colpId,
      nativeId: item.nativeId, revision: item.projection.revision,
      childrenRevision: item.projection.childrenRevision ?? null }));
    throw new Error(`terminal_count_timeout:${JSON.stringify({ queue: summary, events, mappings,
      selectedRoots: state.scope?.selectedRoots ?? null, rootStatus: state.scope?.rootStatus ?? null,
      engine })}`, { cause: error }); }
}
async function evidence<T = unknown>(page: Page, method: string, ...args: unknown[]): Promise<T> {
  const result = await page.evaluate(({ method, args }) =>
    chrome.runtime.sendMessage({ kind: 'known.sync-state.evidence', method, args }), { method, args }) as any;
  if (!result.ok) throw new Error(result.error); return result.value as T; }
async function terminateExtensionWorker(context: BrowserContext, page: Page) { const cdp = await context.newCDPSession(page);
  await cdp.send('ServiceWorker.enable'); const targets = await cdp.send('Target.getTargets');
  const target = targets.targetInfos.find((item) => item.type === 'service_worker' && item.url.includes(EXTENSION_ID));
  await cdp.send('Target.closeTarget', { targetId: target!.targetId }); await cdp.detach(); }
