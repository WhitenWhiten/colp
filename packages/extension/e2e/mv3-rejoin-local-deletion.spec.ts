import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { KNS08_BINDINGS, confirmFirstRun, evidence, grantBookmarks, launchPersistent, liveCanonical,
  login, optionsPage, runtimeMessage, specialRoots, startRealStack, terminateWorker,
  waitFirstRunProductQuiet, waitQueueQuiet, wakeEngine } from './kns-08-harness.js';
import { showOptionsPane } from './extension-auth.js';
import type { createSyncStateStore } from '../src/sync-state-store.js';

type Export = Awaited<ReturnType<ReturnType<typeof createSyncStateStore>['exportScope']>>;

test('paused native folder deletion reconciles with another browser and Keep cloud survives worker and profile restart', async () => {
  test.setTimeout(300_000);
  const stack = await startRealStack();
  const profiles = await Promise.all(['a', 'b'].map(id => mkdtemp(resolve(tmpdir(), `colp-rejoin-delete-${id}-`))));
  let a: BrowserContext | undefined; let b: BrowserContext | undefined;
  try {
    a = await launchPersistent(profiles[0]!, stack.browserHostResolverRules);
    let pageA = await optionsPage(a); await login(pageA, KNS08_BINDINGS[0]); await grantBookmarks(pageA);
    const rootsA = await specialRoots(pageA);
    const folderA = await pageA.evaluate(parentId => chrome.bookmarks.create({ parentId, title: 'Rejoin original folder' }), rootsA.barId);
    await confirmFirstRun(pageA, [rootsA.barTitle, rootsA.otherTitle]);
    await waitFirstRunProductQuiet(pageA, stack, KNS08_BINDINGS[0]);
    b = await launchPersistent(profiles[1]!, stack.browserHostResolverRules);
    const pageB = await optionsPage(b); await login(pageB, KNS08_BINDINGS[1]); await grantBookmarks(pageB);
    const rootsB = await specialRoots(pageB);
    await confirmFirstRun(pageB, [rootsB.barTitle, rootsB.otherTitle]);
    await waitFirstRunProductQuiet(pageB, stack, KNS08_BINDINGS[1]);
    await expect.poll(() => find(pageB, 'Rejoin original folder'), { timeout: 60_000 }).toHaveLength(1);
    const [folderB] = await find(pageB, 'Rejoin original folder');
    const before = await evidence<Export>(pageA, 'exportOutboundPushEvidence');
    const mount = before.mountBindings.find(row => row.nativeRootId === rootsA.barId)!;
    expect(await runtimeMessage(pageA, { kind: 'known.scope.detach', mountId: mount.mountId })).toMatchObject({ ok: true });
    await pageA.evaluate(id => chrome.bookmarks.removeTree(id), folderA.id);
    await pageB.evaluate(async id => {
      await chrome.bookmarks.update(id, { title: 'Rejoin cloud folder' });
      await chrome.bookmarks.create({ parentId: id, title: 'A cloud child', url: 'https://example.test/rejoin/a' });
      const z = await chrome.bookmarks.create({ parentId: id, title: 'Z cloud child', url: 'https://example.test/rejoin/z' });
      await chrome.bookmarks.move(z.id, { parentId: id, index: 0 });
    }, folderB!.id);
    // A prior quiet status can precede delivery of Chrome's callbacks. Wait for
    // the actual capture lane, then the last move's server-side placement.
    await evidence(pageB, 'drainBookmarkEventCaptureEvidence');
    const folderColpId = before.mappings.find(row => row.nativeId === folderA.id)!.colpId;
    await expect.poll(async () => {
      await evidence(pageB, 'drainBookmarkEventCaptureEvidence');
      await wakeEngine(pageB);
      return (await stack.canonicalSiblingOrder(folderColpId)).map(row => row.url);
    }, { timeout: 60_000 }).toEqual(['https://example.test/rejoin/z', 'https://example.test/rejoin/a']);
    await waitQueueQuiet(pageB, stack, KNS08_BINDINGS[1]);
    const [cloudZ, cloudA] = await stack.canonicalSiblingOrder(folderColpId);
    expect((await liveCanonical(stack)).find(row => row.id === folderColpId)?.title).toBe('Rejoin cloud folder');
    // Keep the decision tied to a settled cloud snapshot. Paused A must have
    // observed B's final placement before the user reviews its one token.
    await expect.poll(async () => {
      await wakeEngine(pageA);
      const state = await evidence<Export>(pageA, 'exportOutboundPushEvidence');
      return state.remoteObservations.find(row => row.colpId === cloudZ!.id);
    }, { timeout: 60_000 }).toMatchObject({ kind: 'placement',
      payload: { parentId: folderColpId, beforeId: cloudA!.id } });
    expect(await runtimeMessage(pageA, { kind: 'known.scope.rejoin', mountId: mount.mountId }))
      .toMatchObject({ ok: false, error: 'rejoin_pending' });
    await pageA.reload(); await showOptionsPane(pageA, 'sync-center');
    const panel = pageA.locator('#rejoin-decisions');
    await expect(panel.locator('[data-rejoin-action="keep_remote"]')).toBeVisible({ timeout: 30_000 });
    const reviewed = await evidence<Export>(pageA, 'exportOutboundPushEvidence');
    const frames: Record<string, ReturnType<typeof rejoinSummary>> = {
      before: rejoinSummary(before, mount.mountId, folderA.id),
      reviewed: rejoinSummary(reviewed, mount.mountId, folderA.id),
    };
    await panel.locator('[data-rejoin-action="keep_remote"]').click();
    try {
      await expect.poll(() => find(pageA, 'Rejoin cloud folder'), { timeout: 60_000 }).toHaveLength(1);
      const [restored] = await find(pageA, 'Rejoin cloud folder');
      expect(restored!.id).not.toBe(folderA.id);
      expect(await pageA.evaluate(id => chrome.bookmarks.getChildren(id).then(rows => rows.map(row => row.title)), restored!.id))
        .toEqual(['Z cloud child', 'A cloud child']);
      frames.materialized = rejoinSummary(await evidence<Export>(pageA, 'exportOutboundPushEvidence'), mount.mountId, folderA.id, restored!.id);
      await terminateWorker(a, pageA);
      await runtimeMessage(pageA, { kind: 'known.sync.rejoinDecisions.get' });
      frames.workerRestart = rejoinSummary(await evidence<Export>(pageA, 'exportOutboundPushEvidence'), mount.mountId, folderA.id, restored!.id);
      await a.close(); a = await launchPersistent(profiles[0]!, stack.browserHostResolverRules); pageA = await optionsPage(a);
      await runtimeMessage(pageA, { kind: 'known.sync.rejoinDecisions.get' });
      expect((await find(pageA, 'Rejoin cloud folder')).map(row => row.id)).toEqual([restored!.id]);
      expect(await pageA.evaluate(id => chrome.bookmarks.getChildren(id).then(rows => rows.map(row => row.title)), restored!.id))
        .toEqual(['Z cloud child', 'A cloud child']);
      await waitQueueQuiet(pageA, stack, KNS08_BINDINGS[0]);
      const after = await evidence<Export>(pageA, 'exportOutboundPushEvidence');
      frames.profileRestart = rejoinSummary(after, mount.mountId, folderA.id, restored!.id);
      expect(after.mountBindings.find(row => row.mountId === mount.mountId)?.status).toBe('active');
      expect(after.queue.map(row => ({ opId: row.opId, digest: row.digest })))
        .toEqual(before.queue.map(row => ({ opId: row.opId, digest: row.digest })));
      expect((await liveCanonical(stack)).filter(row => row.url === 'https://example.test/rejoin/a')).toHaveLength(1);
      expect((await liveCanonical(stack)).filter(row => row.url === 'https://example.test/rejoin/z')).toHaveLength(1);
    } catch (error) {
      // Preserve the actual failed choice. Reading the export cannot retry it,
      // accept a newer token, mutate native state, or manufacture a receipt.
      frames.failure = rejoinSummary(await evidence<Export>(pageA, 'exportOutboundPushEvidence'), mount.mountId, folderA.id);
      // Only states, counts and identity relationships are emitted. Bookmark
      // content, IDs, immutable request bodies and credentials stay out of the log.
      throw new Error(`Keep cloud did not complete: ${JSON.stringify(frames)}`, { cause: error });
    }
  } finally {
    await a?.close(); await b?.close(); await stack.close();
    await Promise.all(profiles.map(path => rm(path, { recursive: true, force: true })));
  }
});
async function find(page: Page, title: string) {
  return page.evaluate(title => chrome.bookmarks.search({ title }), title);
}

function rejoinSummary(value: Export, mountId: string, oldNativeId: string, restoredNativeId?: string) {
  const code = (input: unknown) => typeof input === 'string' && /^[a-z][a-z0-9_:-]{0,63}$/u.test(input) ? input : undefined;
  return {
    scope: { lifecycle: code(value.scope?.lifecycle), rootStatus: code(value.scope?.rootStatus),
      firstRun: code(value.scope?.firstRun), recovery: code(value.scope?.metadata?.recoveryCode) },
    mount: value.mountBindings.filter(row => row.mountId === mountId).map(row => ({ status: row.status,
      materialized: row.materialized, pause: row.pauseBaseline?.completeness })),
    commands: value.scopeCommandPlans.map(row => ({ kind: row.kind, phase: row.phase, sameMount: row.mountId === mountId,
      retry: code(row.retryReason), decision: code(row.rejoinDecision?.kind),
      affectedCount: typeof row.rejoinDecision?.affectedCount === 'number' ? row.rejoinDecision.affectedCount : undefined,
      blocked: code(row.rejoinDecision?.blockedReason), superseded: !!row.rejoinDecision?.supersededBy,
      dependencies: row.dependencies.length, dependencyStates: row.dependencies.map(id =>
        value.scopeCommandPlans.find(candidate => candidate.commandId === id)?.phase ?? 'other') })),
    resolutions: value.diagnostics.filter(row => row.kind === 'rejoin_queue_resolution').length,
    mappings: { count: value.mappings.length, oldFolderPresent: value.mappings.some(row => row.nativeId === oldNativeId),
      restoredFolderMapped: restoredNativeId === undefined ? undefined : value.mappings.some(row => row.nativeId === restoredNativeId),
      virtual: value.mappings.filter(row => row.nativeId.startsWith('unmounted:')).length },
    intents: value.intents.map(row => ({ kind: code(row.expected.kind), state: code(row.state), apiPhase: code(row.apiPhase),
      nativeResult: code(row.nativeResult), confirmation: code(row.nativeResultConfirmation?.kind),
      wait: code(row.waitReason), oldTarget: row.expected.nativeId === oldNativeId,
      restoredTarget: restoredNativeId === undefined ? undefined : row.expected.nativeId === restoredNativeId })),
    queue: value.queue.map(row => ({ type: code(row.payload.type), status: row.status, recovery: code(row.recovery?.code),
      echoApplied: row.echoApplied === true })),
    captures: value.bookmarkEvents.map(row => ({ kind: code(row.kind), status: code(row.status) })),
    observations: value.remoteObservations.map(row => ({ kind: row.kind,
      mapped: value.mappings.some(mapping => mapping.colpId === row.colpId) })),
  };
}
