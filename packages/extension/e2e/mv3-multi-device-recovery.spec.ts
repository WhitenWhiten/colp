import { chromium, expect, test, type BrowserContext, type Page } from '@playwright/test';
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { SESSION_COOKIE_NAME } from '../src/auth-client.js';
import { grantOptionalBookmarks } from './bookmark-permission.js';
import { engineStatusIsStable, waitForEngineStability, type EngineStabilityStatus } from './engine-stability-barrier.js';
import { copyProfileSnapshot, probeRetiredReplicaSession, remoteCollectionIdentity } from './mv3-multi-device-recovery-profile.js';
import { nativeIdentityDiagnostics } from './mv3-multi-device-recovery-identity.js';
import { EXTENSION_FIXTURE_EMAIL, EXTENSION_FIXTURE_PASSWORD, openExtensionOptions, selectCollectionFromList, showOptionsPane, signInExtension } from './extension-auth.js';
import {
  boundedRetryAfter, containsFieldValue, containsJsonString, credentialTokenMetadata, diagnosticMetadata,
  pullQueryMetadata, redactUrl, safeDiagnosticCode, safeProblemFields, secretMarkers, secretMetadata, sha,
  snapshotMetadata, snapshotQueryMetadata, splitMarker, syncAuthorityMetadata, syncRequestMetadata,
} from './mv3-multi-device-recovery-redaction.js';

const runtimePath = process.env.KNOWN_P3_38_RUNTIME ?? '';
if (!runtimePath) throw new Error('runner_runtime_missing');
const runtime = JSON.parse(await readFile(runtimePath, 'utf8')) as { mode: 'acceptance' | 'diagnostic';
  stage: 'full' | 'runtime-preflight' | 'bootstrap' | 'core-sync' | 'recovery-fast' | 'recovery-exact' | 'full-fast';
  recoveryWaitMs: number; origin: string; spki: string; extensionId: string;
  retentionAdvanceToken: string;
  hostname: string; artifact: string; result: string; console: string; network: string; problems: string; screenshots: string;
  traces: string; markers: string; timeline: string; managedPolicyInHost: boolean };
const artifact = resolve(runtime.artifact);
const extensionId = runtime.extensionId;
const resultPath = runtime.result;
const seed = process.env.KNOWN_P3_38_SEED ?? '';
const browserLogPath = runtime.console;
const screenshotDirectory = runtime.screenshots;
const browserLogs: string[] = [];
const networkLogs: string[] = [];
const problemLogs: string[] = [];
const pullStructures: unknown[] = [];
const sessionAuthorityDigests = new Map<string, string>();
const observedPages = new Set<Page>();
const replicaHistory = new Map<string, { identityDigest: string; generation: number;
  status: 'active' | 'expired' | 'recovery_required' | 'retired'; oldIdentityRejected: boolean }>();
const temporaryDirectories = new Set<string>();
const refreshCooldownUntil = new WeakMap<Page, number>();
const scenarioNames = [
  'install-login-root-bootstrap', 'two-device-create', 'two-device-update', 'two-device-move',
  'two-device-delete', 'same-field-conflict', 'different-field-merge', 'offline-durable-queue',
  'push-commit-response-loss', 'seeded-worker-termination', 'browser-profile-restart',
  'ack-tombstone-purge', 'stale-snapshot-recovery', 'uninstall-without-notification',
  'reinstall-new-replica', 'backup-window-recovery', 'retired-replica-rejected',
  'unknown-extension-round-trip', 'managed-bookmark-capability', 'final-convergence',
] as const;

test('production MV3 replays the complete two-device recovery sequence', async () => {
  test.setTimeout(45 * 60_000);
  if (runtime.mode === 'acceptance') {
    expect(runtime.stage).toBe('full'); expect(runtime.recoveryWaitMs).toBe(601_000);
  } else {
    expect(runtime.stage).not.toBe('full');
    expect(runtime.recoveryWaitMs).toBe(['recovery-fast', 'full-fast'].includes(runtime.stage) ? 121_000 : 601_000);
  }
  expect(extensionId).toMatch(/^[a-p]{32}$/u);
  expect(seed.length).toBeGreaterThanOrEqual(16);
  expect(JSON.parse(await readFile(resolve(artifact, 'generated-config.json'), 'utf8')).environment).toBe('production');

  const profileA = await mkdtemp(resolve(tmpdir(), 'known-p3-38-a-'));
  const profileB = await mkdtemp(resolve(tmpdir(), 'known-p3-38-b-'));
  temporaryDirectories.add(profileA); temporaryDirectories.add(profileB);
  let a = await launch(profileA); let b: BrowserContext;
  try { b = await launch(profileB); }
  catch (error) { await a.close().catch(() => undefined);
    for (const directory of temporaryDirectories) await rm(directory, { recursive: true, force: true }).catch(() => undefined); throw error; }
  const crashSequence = seededCrashSequence(seed);
  expect(crashSequence).toHaveLength(11);
  const observations: Record<string, unknown> = { seed, crashSequence };
  const scenarioFacts = new Map<string, Record<string, unknown>>();
  let unknownClientDigests: string[] = []; let managedScenarioFact: Record<string, unknown> = {};
  let publicManagedWriteRejected = false;
  let collectionId = '';
  const boundaryEvidence: Record<string, unknown> = {};
  try {
    let pageA = await openOptions(a); let pageB = await openOptions(b);
    const recordScenario = async (name: typeof scenarioNames[number], action: unknown) => {
      const actionEvidence = { surface: 'production-extension', digest: sha(JSON.stringify(action)) };
      const observationEvidence = [
        { surface: 'device-a-browser-tree', digest: await bookmarkTreeDigest(pageA) },
        { surface: 'device-b-browser-tree', digest: await bookmarkTreeDigest(pageB) },
        { surface: 'device-a-indexeddb', digest: await indexedDbDigest(pageA) },
        { surface: 'device-b-indexeddb', digest: await indexedDbDigest(pageB) },
        { surface: 'public-http', digest: sha(JSON.stringify(await publicCanonicalFacts(collectionId, pageB))) },
      ];
      scenarioFacts.set(name, { name, actionEvidence, observationEvidence });
    };
    await markStage('runtime-preflight', 'entered');
    await preflight(a, pageA, profileA); await preflight(b, pageB, profileB);
    if (await finishDiagnosticStage(['runtime-preflight'], a, b, pageA, pageB)) return;
    await markStage('bootstrap', 'entered');
    collectionId = await bootstrapProductAccount(pageA);
    await signInAndSelectRoot(pageA, 'Device A', collectionId);
    await signInAndSelectRoot(pageB, 'Device B', collectionId);
    await ensureEnginesStable([pageA, pageB]);
    const identityA = await remoteCollectionIdentity(pageA); const identityB = await remoteCollectionIdentity(pageB);
    expect(identityA.remoteCollectionDigest).toBe(sha(collectionId));
    expect(identityA.selectedCollectionDigest).toBe(identityA.remoteCollectionDigest);
    expect(identityB.selectedCollectionDigest).toBe(identityB.remoteCollectionDigest);
    expect(identityA.remoteCollectionDigest).toBe(identityB.remoteCollectionDigest);
    expect(identityA.accountDigest).toBe(identityB.accountDigest);
    await expect.poll(async () => Number((await publicCanonicalFacts(collectionId, pageB) as { bootstrappedClients?: number }).bootstrappedClients ?? 0),
      { timeout: 60_000 }).toBe(2);
    await recordScenario('install-login-root-bootstrap', { kind: 'options-login-root-select' });
    const rootA = await selectedRoot(pageA); const rootB = await selectedRoot(pageB);
    await a.setOffline(true); await b.setOffline(true);
    await terminateServiceWorker(a, pageA); await terminateServiceWorker(b, pageB);
    await a.tracing.start({ screenshots: true, snapshots: true, sources: false });
    await b.tracing.start({ screenshots: true, snapshots: true, sources: false });
    await showOptionsPane(pageA, 'account');
    await showOptionsPane(pageB, 'account');
    await expect(pageA.locator('body')).toHaveAttribute('data-state', 'connected');
    await expect(pageB.locator('body')).toHaveAttribute('data-state', 'connected');
    await stopTrace(a, 'device-a'); await stopTrace(b, 'device-b');
    await a.setOffline(false); await b.setOffline(false);
    await a.close(); await b.close();
    a = await launch(profileA); b = await launch(profileB);
    pageA = await openOptions(a); pageB = await openOptions(b);
    await ensureDeviceReady(a, pageA, 'Device A restarted');
    await ensureDeviceReady(b, pageB, 'Device B restarted');
    const observationBaseline = await ensureEnginesStable([pageA, pageB]);
    const restartedIdentityA = await remoteCollectionIdentity(pageA);
    const restartedIdentityB = await remoteCollectionIdentity(pageB);
    expect(restartedIdentityA).toEqual(identityA); expect(restartedIdentityB).toEqual(identityB);
    if (await finishDiagnosticStage(['bootstrap'], a, b, pageA, pageB,
      { remoteCollectionDigest: identityA.remoteCollectionDigest })) return;

    // Local and remote create/update/move/delete through real chrome.bookmarks.
    await markStage('core-sync', 'entered');
    await markStage('core-create', 'entered');
    const authRequestsBeforeObservation = observationBaseline.authRequests;
    const sessionRequestsBeforeObservation = observationBaseline.sessionRequests;
    const ingressBeforeCreate = await bookmarkIngressStatus(pageA);
    expect(ingressBeforeCreate.listenerInstalled).toBe(true);
    const folder = await pageA.evaluate((parentId) => chrome.bookmarks.create({ parentId, title: 'P3-38 folder' }), rootA);
    const bookmark = await pageA.evaluate((parentId) => chrome.bookmarks.create({ parentId, title: 'P3-38 create',
      url: 'https://example.test/p3-38/create' }), rootA);
    await expect.poll(async () => (await bookmarkIngressStatus(pageA)).eventObserved,
      { timeout: 10_000 }).toBeGreaterThanOrEqual(ingressBeforeCreate.eventObserved + 2);
    try { await expect.poll(async () => (await bookmarkIngressStatus(pageA)).eventAccepted,
      { timeout: 10_000 }).toBeGreaterThanOrEqual(ingressBeforeCreate.eventAccepted + 2); }
    catch (error) { throw new Error(`bookmark_ingress_rejected:${JSON.stringify({
      ingress: await bookmarkIngressStatus(pageA), root: await rootDiagnostics(pageA, rootA),
      queue: await queueDiagnostics(pageA), events: (await readStore(pageA, 'bookmark_events')).length,
      bookmarkApi: await bookmarkApiDiagnostics(a, pageA, rootA),
    })}`, { cause: error }); }
    try { await waitForBookmark(pageB, rootB, 'P3-38 create'); }
    catch (error) { throw new Error(`initial_sync_failed: ${JSON.stringify({ queueA: await queueDepth(pageA),
      queueB: await queueDepth(pageB), engineA: await syncEngineStatus(pageA), engineB: await syncEngineStatus(pageB),
      queueFactsA: await queueDiagnostics(pageA), queueFactsB: await queueDiagnostics(pageB),
      receiptsA: (await readStore(pageA, 'receipts')).length, receiptsB: (await readStore(pageB, 'receipts')).length,
      eventsA: (await readStore(pageA, 'bookmark_events')).length,
      rootA: await rootDiagnostics(pageA, rootA), rootB: await rootDiagnostics(pageB, rootB),
      pullB: await pullDiagnostics(pageB),
      pullStructures: pullStructures.slice(-8),
      pushes: networkLogs.filter((row) => row.includes('/sync/push')).slice(-20),
      network: networkLogs.slice(-20), problems: problemLogs.slice(-20) })}`, { cause: error }); }
    expect(networkRequestCount('/oauth2/token')).toBe(authRequestsBeforeObservation);
    expect(networkRequestCount('/colp/v0.1/sync/sessions')).toBe(sessionRequestsBeforeObservation);
    const outsideRoot = await pageA.evaluate(() => chrome.bookmarks.getTree().then((tree) => tree[0]!.children![1]!.id));
    const ingressBeforeOutside = await bookmarkIngressStatus(pageA);
    await pageA.evaluate((parentId) => chrome.bookmarks.create({ parentId, title: 'P3-38 outside root' }), outsideRoot);
    await expect.poll(async () => (await bookmarkIngressStatus(pageA)).eventRejected,
      { timeout: 10_000 }).toBeGreaterThan(ingressBeforeOutside.eventRejected);
    expect((await bookmarkIngressStatus(pageA)).eventAccepted).toBe(ingressBeforeOutside.eventAccepted);
    await recordScenario('two-device-create', { kind: 'chrome.bookmarks.create', nativeId: bookmark.id });
    await markStage('core-create', 'passed'); await markStage('core-conflict', 'entered');
    await drainQueue(pageA); await drainQueue(pageB);
    await a.setOffline(true); await b.setOffline(true);
    await pageA.evaluate((id) => chrome.bookmarks.update(id, { title: 'P3-38 same-field conflict A' }), bookmark.id);
    const remote = await findBookmark(pageB, rootB, 'P3-38 create');
    await pageB.evaluate((id) => chrome.bookmarks.update(id, { title: 'P3-38 same-field conflict B' }), remote.id);
    try { await expect.poll(() => queueDepth(pageA), { timeout: 60_000 }).toBe(1);
      await expect.poll(() => queueDepth(pageB), { timeout: 60_000 }).toBe(1); }
    catch (error) { throw new Error(`offline_conflict_capture_failed:${JSON.stringify({
      ingressA: await bookmarkIngressStatus(pageA), ingressB: await bookmarkIngressStatus(pageB),
      queueA: await queueDiagnostics(pageA), queueB: await queueDiagnostics(pageB),
      eventsA: (await readStore(pageA, 'bookmark_events')).length,
      eventsB: (await readStore(pageB, 'bookmark_events')).length,
      recoveryA: await captureRecoveryDiagnostics(pageA), recoveryB: await captureRecoveryDiagnostics(pageB),
    })}`, { cause: error }); }
    await a.setOffline(false); await b.setOffline(false);
    try { await waitForConflict([pageA, pageB]); }
    catch (error) { throw new Error(`same_field_conflict_failed: ${JSON.stringify({
      queueA: await queueDiagnostics(pageA), queueB: await queueDiagnostics(pageB),
      receiptsA: { count: (await readStore(pageA, 'receipts')).length, digest: await storeDigest(pageA, 'receipts') },
      receiptsB: { count: (await readStore(pageB, 'receipts')).length, digest: await storeDigest(pageB, 'receipts') },
      engineA: await syncEngineStatus(pageA), engineB: await syncEngineStatus(pageB),
      pullA: await pullDiagnostics(pageA), pullB: await pullDiagnostics(pageB),
      network: networkLogs.slice(-40), problems: problemLogs.slice(-20),
    })}`, { cause: error }); }
    await recordScenario('two-device-update', { kind: 'chrome.bookmarks.update', nativeId: bookmark.id });
    await recordScenario('same-field-conflict', { kind: 'two-offline-chrome.bookmarks.update' });
    await resolveOpenConflict([pageA, pageB]);
    await ensureEnginesStable([pageA, pageB]);
    await drainQueue(pageA); await drainQueue(pageB);
    await markStage('core-conflict', 'passed'); await markStage('core-merge-move', 'entered');
    const mergeA = await pageA.evaluate((parentId) => chrome.bookmarks.create({ parentId, title: 'P3-38 merge base',
      url: 'https://example.test/p3-38/base' }), rootA);
    try { await waitForBookmark(pageB, rootB, 'P3-38 merge base'); }
    catch (error) { throw new Error(`merge_base_projection_failed:${JSON.stringify({
      ingressA: await bookmarkIngressStatus(pageA), ingressB: await bookmarkIngressStatus(pageB),
      queueA: await queueDiagnostics(pageA), queueB: await queueDiagnostics(pageB),
      engineA: await syncEngineStatus(pageA), engineB: await syncEngineStatus(pageB),
      pullA: await pullDiagnostics(pageA), pullB: await pullDiagnostics(pageB),
      rootA: await rootDiagnostics(pageA, rootA), rootB: await rootDiagnostics(pageB, rootB),
      network: networkLogs.slice(-50), problems: problemLogs.slice(-20),
    })}`, { cause: error }); }
    const mergeB = await findBookmark(pageB, rootB, 'P3-38 merge base');
    await drainQueue(pageA); await drainQueue(pageB);
    await a.setOffline(true); await b.setOffline(true);
    await pageA.evaluate((id) => chrome.bookmarks.update(id, { title: 'P3-38 different-field merge' }), mergeA.id);
    await pageB.evaluate((id) => chrome.bookmarks.update(id, { url: 'https://example.test/p3-38/merged' }), mergeB.id);
    await expect.poll(() => queueDepth(pageA), { timeout: 10_000 }).toBe(1);
    await expect.poll(() => queueDepth(pageB), { timeout: 10_000 }).toBe(1);
    await a.setOffline(false); await b.setOffline(false);
    try {
      await drainQueue(pageA); await drainQueue(pageB);
    } catch (error) {
      throw new Error(`different_field_queue_failed: ${JSON.stringify({
        queueA: await queueDiagnostics(pageA), queueB: await queueDiagnostics(pageB),
        engineA: await syncEngineStatus(pageA), engineB: await syncEngineStatus(pageB),
        pullA: await pullDiagnostics(pageA), pullB: await pullDiagnostics(pageB),
        network: networkLogs.slice(-40), problems: problemLogs.slice(-20),
      })}`, { cause: error });
    }
    await waitForBookmark(pageA, rootA, 'P3-38 different-field merge');
    await waitForBookmark(pageB, rootB, 'P3-38 different-field merge');
    await expect.poll(async () => { await observeConvergence(pageA);
      return (await findBookmark(pageA, rootA, 'P3-38 different-field merge')).url;
    }, { timeout: 60_000, intervals: [1_000] }).toBe('https://example.test/p3-38/merged');
    await expect.poll(async () => { await observeConvergence(pageB);
      return (await findBookmark(pageB, rootB, 'P3-38 different-field merge')).url;
    }, { timeout: 60_000, intervals: [1_000] }).toBe('https://example.test/p3-38/merged');
    await recordScenario('different-field-merge', { kind: 'two-field-update' });
    await pageA.evaluate(({ id, parentId }) => chrome.bookmarks.move(id, { parentId }), { id: mergeA.id, parentId: folder.id });
    await expect.poll(() => queueDepth(pageA), { timeout: 10_000 }).toBe(1);
    try { await drainQueue(pageA); }
    catch (error) { throw new Error(`move_queue_failed: ${JSON.stringify({
      queueA: await queueDiagnostics(pageA), engineA: await syncEngineStatus(pageA),
      ingressA: await bookmarkIngressStatus(pageA), pullA: await pullDiagnostics(pageA),
      rootA: await rootDiagnostics(pageA, rootA),
      network: networkLogs.slice(-40), problems: problemLogs.slice(-20),
    })}`, { cause: error }); }
    await waitForBookmark(pageB, rootB, 'P3-38 folder');
    const folderB = await findBookmark(pageB, rootB, 'P3-38 folder');
    try {
      await expect.poll(async () => { await observeConvergence(pageB); try {
        return (await findBookmark(pageB, rootB, 'P3-38 different-field merge')).parentId;
      } catch { return undefined; } }, { timeout: 60_000, intervals: [1_000] }).toBe(folderB.id);
    } catch (error) {
      throw new Error(`move_convergence_failed: ${JSON.stringify({
        queueA: await queueDiagnostics(pageA), queueB: await queueDiagnostics(pageB),
        engineA: await syncEngineStatus(pageA), engineB: await syncEngineStatus(pageB),
        pullA: await pullDiagnostics(pageA), pullB: await pullDiagnostics(pageB),
        network: networkLogs.slice(-40), problems: problemLogs.slice(-20),
      })}`, { cause: error });
    }
    await recordScenario('two-device-move', { kind: 'chrome.bookmarks.move', nativeId: mergeA.id, parentId: folder.id });
    await markStage('core-merge-move', 'passed'); await markStage('core-offline-response-loss', 'entered');

    // Queue persisted offline, exact retry after commit response loss, and seeded service-worker termination.
    await a.setOffline(true);
    const [secretTitle, secretUrl, extensionPayload] = secretMarkers(seed);
    const secretBookmarkId = await pageA.evaluate(async ({ parentId, scenarioSeed }) => {
      const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(scenarioSeed));
      const suffix = [...new Uint8Array(bytes)].map((value) => value.toString(16).padStart(2, '0')).join('').slice(0, 20);
      return (await chrome.bookmarks.create({ parentId, title: `P3-38 confidential ${suffix}`,
        url: `https://marker.invalid/${suffix}` })).id;
    }, { parentId: rootA, scenarioSeed: seed });
    const authorityMarkers = await pageA.evaluate(async () => { const value = (await chrome.storage.session.get(
      'known.auth.credential.v1'))['known.auth.credential.v1'] as { accessToken?: string; refreshToken?: string } | undefined;
      return [value?.accessToken, value?.refreshToken].filter((item): item is string => typeof item === 'string'); });
    await writeFile(runtime.markers, `${JSON.stringify([secretBookmarkId, `nativeId=${secretBookmarkId}`, ...authorityMarkers])}\n`,
      { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    await expect.poll(() => queueDepth(pageA)).toBeGreaterThan(0);
    await recordScenario('offline-durable-queue', { kind: 'offline-create', nativeId: secretBookmarkId });
    await terminateServiceWorker(a, pageA);
    const receiptsBeforeLoss = (await readStore(pageA, 'receipts')).length;
    const receiptDigestBeforeLoss = await storeDigest(pageA, 'receipts');
    const armedLoss = await fetch(`${runtime.origin}/__runner/commit-response-loss`, { method: 'POST' });
    expect(armedLoss.status).toBe(202);
    await a.setOffline(false);
    await a.close(); a = await launch(profileA); pageA = await openOptions(a);
    try { await ensureDeviceReady(a, pageA, 'Device A response-loss restart'); }
    catch (error) { throw new Error(`commit_response_loss_restart_not_ready: ${JSON.stringify({
      queue: await queueDiagnostics(pageA), engine: await syncEngineStatus(pageA),
      loss: await fetch(`${runtime.origin}/__runner/commit-response-loss`).then((response) => response.json()),
      pushes: networkLogs.filter((row) => row.includes('/sync/push')).slice(-20),
      network: networkLogs.slice(-50), problems: problemLogs.slice(-20) })}`, { cause: error }); }
    try { await drainQueue(pageA, 120_000); }
    catch (error) { throw new Error(`commit_response_loss_recovery_failed: ${JSON.stringify({
      queue: await queueDiagnostics(pageA), engine: await syncEngineStatus(pageA),
      receiptCount: (await readStore(pageA, 'receipts')).length,
      loss: await fetch(`${runtime.origin}/__runner/commit-response-loss`).then((response) => response.json()),
      pushes: networkLogs.filter((row) => row.includes('/sync/push')).slice(-20),
      network: networkLogs.slice(-50),
      problems: problemLogs.slice(-20) })}`, { cause: error }); }
    const lossResponse = await fetch(`${runtime.origin}/__runner/commit-response-loss`);
    const loss = await lossResponse.json() as { upstreamCommitted?: boolean; downstreamDropped?: boolean };
    expect(loss).toMatchObject({ upstreamCommitted: true, downstreamDropped: true });
    expect((await readStore(pageA, 'receipts')).length).toBe(receiptsBeforeLoss + 1);
    const receiptDigestAfterLoss = await storeDigest(pageA, 'receipts');
    expect(receiptDigestAfterLoss).not.toBe(receiptDigestBeforeLoss);
    boundaryEvidence['push-commit-response-loss'] = {
      point: 'push-commit-response-loss',
      triggerEvidence: { surface: 'ingress-socket-drop-after-upstream-commit', digest: sha(JSON.stringify(loss)) },
      observationEvidence: [
        { surface: 'device-a-indexeddb-receipts-before', digest: receiptDigestBeforeLoss },
        { surface: 'device-a-indexeddb-receipts-after', digest: receiptDigestAfterLoss },
      ],
      recoveryEvidence: { surface: 'device-a-indexeddb-exact-retry', digest: await storeDigest(pageA, 'receipts') },
    };
    await recordScenario('push-commit-response-loss', { kind: 'ingress-socket-drop-after-upstream-commit' });
    await markStage('core-offline-response-loss', 'passed'); await markStage('core-worker-boundaries', 'entered');
    for (const point of observations.crashSequence as string[]) {
      if (point === 'push-commit-response-loss') continue;
      const outboundBoundary = /^(?:queue|push|receipt)/u.test(point);
      let observationPage = outboundBoundary ? pageA : pageB;
      let observationContext = outboundBoundary ? a : b;
      const beforePhase = point.includes('-before');
      try { await drainQueue(pageA); await drainQueue(pageB); }
      catch (error) { throw new Error(`boundary_precondition_queue_not_drained: ${JSON.stringify({ point,
        completedBoundaries: Object.keys(boundaryEvidence),
        queueA: (await queueDiagnostics(pageA)).filter((row) => !['terminal', 'rejected'].includes(String(row.status))),
        queueB: (await queueDiagnostics(pageB)).filter((row) => !['terminal', 'rejected'].includes(String(row.status))),
        engineA: await syncEngineStatus(pageA), engineB: await syncEngineStatus(pageB),
        network: networkLogs.slice(-20), problems: problemLogs.slice(-20) })}`, { cause: error }); }
      const store = boundaryStore(point); const beforeBoundary = await stableStoreDigest(observationPage, store);
      const treeBefore = await bookmarkTreeDigest(observationPage); await a.setOffline(true);
      if (!outboundBoundary) await b.setOffline(true);
      await pageA.evaluate(({ parentId, title }) => chrome.bookmarks.create({ parentId, title }),
        { parentId: rootA, title: `P3-38 boundary ${sha(point).slice(0, 8)}` });
      await expect.poll(() => queueDepth(pageA), { timeout: 10_000 }).toBeGreaterThan(0);
      if (!outboundBoundary) { await a.setOffline(false); await drainQueue(pageA);
        if (!beforePhase) await b.setOffline(false); }
      else if (!beforePhase) await a.setOffline(false);
      let terminatedTarget: string;
      let crashBoundary: string;
      if (beforePhase) {
        terminatedTarget = await terminateServiceWorker(observationContext, observationPage);
        crashBoundary = await storeDigest(observationPage, store);
        expect(crashBoundary, `${point} must terminate before ${store} changes`).toBe(beforeBoundary);
        await observationContext.setOffline(false);
        await observationContext.close();
        if (outboundBoundary) { a = await launch(profileA); pageA = await openOptions(a);
          await ensureDeviceReady(a, pageA, 'Device A boundary restart');
          observationContext = a; observationPage = pageA; }
        else { b = await launch(profileB); pageB = await openOptions(b);
          await ensureDeviceReady(b, pageB, 'Device B boundary restart');
          observationContext = b; observationPage = pageB; }
      } else {
        await observeConvergence(observationPage);
        try {
          await expect.poll(() => storeDigest(observationPage, store), { timeout: 60_000 }).not.toBe(beforeBoundary);
        } catch (error) {
          throw new Error(`boundary_store_unchanged: ${JSON.stringify({ point, store, beforeBoundary,
            currentBoundary: await storeDigest(observationPage, store),
            engine: await syncEngineStatus(observationPage), queue: (await queueDiagnostics(observationPage))
              .filter((row) => !['terminal', 'rejected'].includes(String(row.status))),
            storeRowCount: (await readStore(observationPage, store)).length, network: networkLogs.slice(-12),
            problems: problemLogs.slice(-20) })}`, { cause: error });
        }
        crashBoundary = await storeDigest(observationPage, store);
        terminatedTarget = await terminateServiceWorker(observationContext, observationPage);
        await wakeSyncEngine(observationPage);
      }
      await observeConvergence(observationPage);
      try {
        await expect.poll(async () => { await observeConvergence(observationPage); return storeDigest(observationPage, store); },
          { timeout: 120_000, intervals: [1_000] }).not.toBe(beforeBoundary);
      } catch (error) {
        throw new Error(`boundary_recovery_store_unchanged: ${JSON.stringify({ point, store, beforeBoundary,
          crashBoundary, currentBoundary: await storeDigest(observationPage, store),
          engine: await syncEngineStatus(observationPage), queue: (await queueDiagnostics(observationPage))
            .filter((row) => !['terminal', 'rejected'].includes(String(row.status))),
          storeRowCount: (await readStore(observationPage, store)).length, network: networkLogs.slice(-12),
          problems: problemLogs.slice(-20) })}`, { cause: error });
      }
      const recoveryDigest = await storeDigest(observationPage, store);
      const treeRecovery = await bookmarkTreeDigest(observationPage);
      boundaryEvidence[point] = { point,
        triggerEvidence: { surface: 'cdp-service-worker-termination',
          digest: sha(JSON.stringify({ point, beforePhase, terminatedTarget })) },
        observationEvidence: [
          { surface: `indexeddb-${store}-before`, digest: beforeBoundary },
          { surface: `indexeddb-${store}-at-termination`, digest: crashBoundary },
          { surface: 'browser-tree-before', digest: treeBefore },
          { surface: 'browser-tree-after-recovery', digest: treeRecovery },
        ],
        recoveryEvidence: { surface: 'indexeddb-after-worker-restart', digest: recoveryDigest } };
    }
    await markStage('core-worker-boundaries', 'passed'); await markStage('core-delete-restart', 'entered');
    await pageA.evaluate((id) => chrome.bookmarks.remove(id), mergeA.id);
    await drainQueue(pageA);
    // The worker-boundary sequence can invalidate B's Sync Session before the
    // deletion Pull. Refresh real authority so a stale replica can recover.
    await refreshAfterAuthorityInvalidation(pageB);
    await expect.poll(async () => { await observeConvergence(pageB); try {
      await findBookmark(pageB, rootB, 'P3-38 different-field merge'); return false; } catch { return true; } },
      { timeout: 120_000, intervals: [1_000] }).toBe(true);
    await recordScenario('two-device-delete', { kind: 'chrome.bookmarks.remove', nativeId: mergeA.id });
    await recordScenario('seeded-worker-termination', { kind: 'cdp-close-service-worker', boundaries: crashSequence });

    // Browser restart preserves isolated IndexedDB authority and converges both real trees.
    await a.close(); await b.close();
    a = await launch(profileA); b = await launch(profileB);
    pageA = await openOptions(a); pageB = await openOptions(b);
    try { await ensureDeviceReady(a, pageA, 'Device A browser restart'); }
    catch (error) { throw new Error(`browser_restart_a_not_ready: ${JSON.stringify({
      engine: await engineDiagnostics(pageA), queue: (await queueDiagnostics(pageA))
        .filter((row) => !['terminal', 'rejected'].includes(String(row.status))),
      pull: await pullDiagnostics(pageA), network: networkLogs.slice(-30), problems: problemLogs.slice(-20),
    })}`, { cause: error }); }
    try { await ensureDeviceReady(b, pageB, 'Device B browser restart'); }
    catch (error) { throw new Error(`browser_restart_b_not_ready: ${JSON.stringify({
      engine: await engineDiagnostics(pageB), queue: (await queueDiagnostics(pageB))
        .filter((row) => !['terminal', 'rejected'].includes(String(row.status))),
      pull: await pullDiagnostics(pageB), network: networkLogs.slice(-30), problems: problemLogs.slice(-20),
    })}`, { cause: error }); }
    expect(await indexedDbDigest(pageA)).not.toBe(await indexedDbDigest(pageB));
    await waitForBookmark(pageB, await selectedRoot(pageB), secretTitle);
    await recordScenario('browser-profile-restart', { kind: 'persistent-context-close-relaunch' });
    await markStage('core-delete-restart', 'passed');
    if (await finishDiagnosticStage(['core-sync'], a, b, pageA, pageB,
      { scenarioCount: scenarioFacts.size, boundaryCount: Object.keys(boundaryEvidence).length })) return;

    // Ack, tombstone purge, and stale recovery are driven by production Sync traffic and the production worker.
    await markStage('stale-recovery', 'entered');
    const cursorBeforeStaleRecovery = await latestCursorDigest(pageA);
    await a.setOffline(true);
    await pageB.waitForTimeout(runtime.recoveryWaitMs);
    const staleCandidate = await pageB.evaluate((parentId) => chrome.bookmarks.create({ parentId,
      title: 'P3-38 stale recovery candidate', url: 'https://example.test/p3-38/stale' }), rootB);
    await refreshAfterAuthorityInvalidation(pageB);
    await expect.poll(() => queueDepth(pageB), { timeout: 60_000 }).toBe(0);
    await pageB.evaluate((id) => chrome.bookmarks.remove(id), staleCandidate.id);
    await expect.poll(() => queueDepth(pageB), { timeout: 60_000 }).toBe(0);
    await pageB.waitForTimeout(3_000);
    const acknowledgedAfterDelete = await durableFacts(pageB, profileB);
    expect(acknowledgedAfterDelete.cursorDigest).toBe(acknowledgedAfterDelete.ackDigest);
    const retentionOrigin = new URL(runtime.origin); const retentionDirect = new URL(runtime.origin);
    retentionDirect.hostname = '127.0.0.1';
    const retentionAdvance = await pageB.request.post(
      `${retentionDirect.origin}/__runner/sync-retention-advance`,
      { headers: { authorization: `Bearer ${runtime.retentionAdvanceToken}`, Host: retentionOrigin.host }, timeout: 60_000 },
    );
    expect(retentionAdvance.status()).toBe(200);
    const retentionResult = await retentionAdvance.json() as { purgedCount?: number };
    expect(retentionResult.purgedCount).toBeGreaterThan(0);
    await recordScenario('ack-tombstone-purge', {
      kind: 'production-ack-and-explicit-operations-clock',
      purgedCount: retentionResult.purgedCount,
    });
    await a.setOffline(false);
    await waitForRecoveryComplete(pageA, cursorBeforeStaleRecovery);
    await showOptionsPane(pageA, 'account');
    await expect(pageA.locator('body')).toHaveAttribute('data-state', 'connected', { timeout: 60_000 });
    await recordScenario('stale-snapshot-recovery', { kind: 'offline-client-crosses-purge-watermark' });
    if (await finishDiagnosticStage(['recovery-fast', 'recovery-exact'], a, b, pageA, pageB,
      { scenarioCount: scenarioFacts.size, boundaryCount: Object.keys(boundaryEvidence).length,
        recoveryWaitMs: runtime.recoveryWaitMs })) return;

    // Unknown transaction extensions must survive each real IndexedDB transaction; managed capability is browser-provided.
    await markStage('unknown-extension-round-trip', 'entered');
    const unknownPush = await pushUnknownExtension(pageA, seed);
    expect(unknownPush.status).toBe(200);
    expect(unknownPush.resultStatus).toBe('applied');
    expect(unknownPush.managedWriteCode).toBe('node_read_only');
    expect(unknownPush.retireStatus).toBe(204);
    expect(unknownPush.retired).toBe(true);
    publicManagedWriteRejected = unknownPush.managedWriteCode === 'node_read_only';
    try {
      await expect.poll(async () => { await observeConvergence(pageA);
        return storeContains(pageA, 'native_mappings', splitMarker(extensionPayload)); }, { timeout: 60_000 }).toBe(true);
      await expect.poll(async () => { await observeConvergence(pageB);
        return storeContains(pageB, 'native_mappings', splitMarker(extensionPayload)); }, { timeout: 60_000 }).toBe(true);
    } catch (error) {
      throw new Error(`unknown_extension_round_trip_failed: ${JSON.stringify({
        engineA: await syncEngineStatus(pageA), engineB: await syncEngineStatus(pageB),
        pullA: await pullDiagnostics(pageA), pullB: await pullDiagnostics(pageB),
        network: networkLogs.slice(-40), problems: problemLogs.slice(-20),
      })}`, { cause: error });
    }
    unknownClientDigests = [await storeDigest(pageA, 'native_mappings'), await storeDigest(pageB, 'native_mappings')];
    await recordScenario('unknown-extension-round-trip', { kind: 'public-push-pull-unknown-extension', clientTransactionDigests: unknownClientDigests });
    await markStage('unknown-extension-round-trip', 'passed');
    if (runtime.managedPolicyInHost) {
      await markStage('managed-bookmark-capability', 'entered');
      const managedProfile = await mkdtemp(resolve(tmpdir(), 'known-p3-38-managed-')); temporaryDirectories.add(managedProfile);
      const managedContext = await launch(managedProfile);
      try { const managedPage = await openOptions(managedContext);
        expect(managedContext.serviceWorkers().some((worker) => worker.url().includes(extensionId))).toBe(true);
        await ensureBootstrapPrerequisites(managedContext, managedPage, 'Managed policy profile');
        const managed = await managedPage.evaluate(async (expectedOrigin) => {
          const flattenTree = (nodes: chrome.bookmarks.BookmarkTreeNode[]): chrome.bookmarks.BookmarkTreeNode[] =>
            nodes.flatMap((node) => [node, ...flattenTree(node.children ?? [])]);
          const policy = await chrome.storage.managed.get(['identityDisabled', 'serverOrigin']);
          const managedNodes = flattenTree(await chrome.bookmarks.getTree()).filter((node) => node.unmodifiable);
          let browserWriteRejected = false;
          if (managedNodes[0]) { try { await chrome.bookmarks.update(managedNodes[0].id, { title: 'P3-38 forbidden managed edit' }); }
            catch { browserWriteRejected = true; } }
          return { policy, expectedOrigin, managedNodeCount: managedNodes.length, browserWriteRejected };
        }, runtime.origin);
        expect(managed.policy).toEqual({ identityDisabled: false, serverOrigin: runtime.origin });
        expect(managed.managedNodeCount).toBeGreaterThan(0); expect(managed.browserWriteRejected).toBe(true);
        managedScenarioFact = { managedStorageDigest: sha(JSON.stringify(managed.policy)), managedTreeDigest: sha(JSON.stringify(managed)),
          managedNodeCount: managed.managedNodeCount, serviceWorkerObserved: managedContext.serviceWorkers().length > 0,
          writeRejected: managed.browserWriteRejected, writeRejectionCode: 'chrome.bookmarks.update-rejected',
          browserWriteRejected: managed.browserWriteRejected, publicWriteRejected: publicManagedWriteRejected };
        scenarioFacts.set('managed-bookmark-capability', { name: 'managed-bookmark-capability',
          actionEvidence: { surface: 'independent-managed-browser-profile', digest: sha(managedProfile) },
          observationEvidence: [{ surface: 'chrome.storage.managed', digest: managedScenarioFact.managedStorageDigest },
            { surface: 'managed-browser-tree', digest: managedScenarioFact.managedTreeDigest },
            { surface: 'browser-and-public-write-rejections', digest: sha(JSON.stringify({ browser: true, public: true })) }] });
        await assertPageRedacted(managedPage); await saveScreenshot(managedPage, 'managed-capability.png');
      } finally { await managedContext.close(); await rm(managedProfile, { recursive: true, force: true }); }
      await markStage('managed-bookmark-capability', 'passed');
    }

    await markStage('final-convergence', 'entered');
    await Promise.all([wakeSyncEngine(pageA), wakeSyncEngine(pageB)]);
    await ensureEnginesStable([pageA, pageB]);
    await expect.poll(async () => finalConvergenceState(pageA, pageB),
      { timeout: 120_000, intervals: [1_000, 2_000, 4_000] }).toEqual({
      treesEqual: true, clientsDurable: true, checkpointOrdinalsEqual: true,
    });
    const checkpointOrdinals = await clientCheckpointOrdinals(pageB, [pageA, pageB]);
    if (checkpointOrdinals.length !== 2 || checkpointOrdinals.some((value) => value === null)
        || checkpointOrdinals[0] !== checkpointOrdinals[1]) throw new Error('durable_checkpoint_convergence_incomplete');
    const clients = [await durableFacts(pageA, profileA, checkpointOrdinals[0]!),
      await durableFacts(pageB, profileB, checkpointOrdinals[1]!)];
    const trees = [await managedBookmarkTreeDigest(pageA), await managedBookmarkTreeDigest(pageB)];
    expect(trees[0]).toBe(trees[1]);
    expect(clients[0]!.cursorDigest).toBe(clients[0]!.ackDigest);
    expect(clients[1]!.cursorDigest).toBe(clients[1]!.ackDigest);
    await recordScenario('final-convergence', { kind: 'tree-cursor-ack-convergence' });
    for (const page of [pageA, pageB]) expect((await nativeIdentityDiagnostics(page, (name) => readStore(page, name))).missingCount).toBe(0);
    await markStage('final-convergence', 'passed');
    await assertPageRedacted(pageA); await assertPageRedacted(pageB);
    await saveScreenshot(pageA, 'device-a-converged.png'); await saveScreenshot(pageB, 'device-b-converged.png');
    observations.trees = trees;
    const clientCounts = { bootstrappedClients: clients.length, durableClientCount: clients.length };
    observations.server = await publicCanonicalFacts(collectionId, pageB, clientCounts);
    const serverFacts = observations.server as { manifestDigest: string; durableClientCount: number; bootstrappedClients: number };
    expect(serverFacts.manifestDigest).toEqual(expect.any(String));
    expect(serverFacts.durableClientCount).toBeGreaterThanOrEqual(2);

    // Uninstall sends no notification. Reinstall is a fresh profile/Replica; backup restore obeys the window.
    await markStage('uninstall-and-reinstall', 'entered');
    const backupRoot = await mkdtemp(resolve(tmpdir(), 'known-p3-38-backup-'));
    const retiredBackupRoot = await mkdtemp(resolve(tmpdir(), 'known-p3-38-retired-backup-'));
    temporaryDirectories.add(backupRoot); temporaryDirectories.add(retiredBackupRoot);
    const backupProfile = resolve(backupRoot, 'profile'); const retiredBackupProfile = resolve(retiredBackupRoot, 'profile');
    const sourceBackupBinding = await backupBindingFact(pageA);
    if (!sourceBackupBinding) throw new Error('source_backup_binding_missing');
    await a.close();
    await copyProfileSnapshot(profileA, backupProfile);
    await copyProfileSnapshot(profileA, retiredBackupProfile);
    a = await launch(profileA); pageA = await openOptions(a);
    try { await ensureDeviceReady(a, pageA, 'Device A snapshot restart'); }
    catch (error) {
      const status = await readSyncEngineStatus(pageA) as { error?: string } | undefined;
      if (status?.error !== 'not_connected') throw error;
      await reauthenticateFixtureDevice(pageA);
      await ensureDeviceReady(a, pageA, 'Device A snapshot restart after sign-in');
    }
    expect(await backupBindingFact(pageA)).toEqual(sourceBackupBinding);
    const beforeUninstall = await publicReplicaFacts(pageB); await uninstallExtension(a, pageA); await a.close();
    expect(await publicReplicaFacts(pageB)).toEqual(beforeUninstall);
    scenarioFacts.set('uninstall-without-notification', {
      name: 'uninstall-without-notification',
      actionEvidence: { surface: 'cdp-extensions-uninstall', digest: sha(JSON.stringify(beforeUninstall)) },
      observationEvidence: [
        { surface: 'device-b-browser-tree', digest: await bookmarkTreeDigest(pageB) },
        { surface: 'public-http-before', digest: sha(JSON.stringify(beforeUninstall)) },
        { surface: 'public-http-after', digest: sha(JSON.stringify(await publicReplicaFacts(pageB))) },
      ],
    });
    const reinstallProfile = await mkdtemp(resolve(tmpdir(), 'known-p3-38-reinstall-'));
    temporaryDirectories.add(reinstallProfile);
    const reinstall = await launch(reinstallProfile);
    try {
      const page = await openOptions(reinstall); await signInAndSelectRoot(page, 'Device A reinstalled', collectionId);
      const freshBinding = await backupBindingFact(page);
      if (!freshBinding) throw new Error('fresh_reinstall_binding_missing');
      expect(freshBinding.identityDigest).not.toBe(sourceBackupBinding.identityDigest);
      expect(freshBinding.generation).toBe(1);
      await expect.poll(publicReplicaFacts).not.toEqual(beforeUninstall);
      scenarioFacts.set('reinstall-new-replica', { name: 'reinstall-new-replica',
        actionEvidence: { surface: 'fresh-persistent-profile-install', digest: sha(reinstallProfile) },
        observationEvidence: [{ surface: 'reinstalled-browser-tree', digest: await bookmarkTreeDigest(page) },
          { surface: 'reinstalled-indexeddb', digest: await indexedDbDigest(page) },
          { surface: 'public-http', digest: sha(JSON.stringify(await publicReplicaFacts(pageB))) }] });
      await markStage('uninstall-and-reinstall', 'passed');
      await markStage('backup-window-recovery', 'entered');
      const restored = await launch(backupProfile, 'copied-backup'); let restoredEvidence: Record<string, unknown>;
      try { const restoredPage = await openOptions(restored);
        await ensureDeviceReady(restored, restoredPage, 'Recovered profile');
        const backupBinding = await backupBindingFact(restoredPage); if (!backupBinding) throw new Error('backup_binding_missing');
        expect(backupBinding).toEqual(sourceBackupBinding);
        await observeConvergence(restoredPage);
        const recoveredBinding = await backupBindingFact(restoredPage); expect(recoveredBinding).toEqual(sourceBackupBinding);
        await showOptionsPane(restoredPage, 'account');
        await expect(restoredPage.locator('body')).toHaveAttribute('data-state', 'connected', { timeout: 60_000 });
        restoredEvidence = { tree: await bookmarkTreeDigest(restoredPage), indexeddb: await indexedDbDigest(restoredPage) };
        const retired = await bindingFact(restoredPage);         await restoredPage.getByRole('button', { name: 'Sign out' }).click();
        await expect(restoredPage.locator('#login-panel')).toBeVisible({ timeout: 120_000 });
        if (retired) replicaHistory.set(retired.identityDigest, { ...retired, status: 'retired', oldIdentityRejected: true }); }
      finally { await restored.close(); }
      scenarioFacts.set('backup-window-recovery', { name: 'backup-window-recovery',
        actionEvidence: { surface: 'explicit-profile-backup-restore', digest: sha(backupProfile) },
        observationEvidence: [{ surface: 'restored-browser-tree', digest: restoredEvidence!.tree },
          { surface: 'restored-indexeddb', digest: restoredEvidence!.indexeddb },
          { surface: 'public-http', digest: sha(JSON.stringify(await publicReplicaFacts(pageB))) }] });
      await markStage('backup-window-recovery', 'passed');
      await markStage('retired-replica-rejected', 'entered');
      const retiredBackup = await launch(retiredBackupProfile, 'copied-backup'); let retiredResponseEvidence: unknown;
      try { const retiredPage = await openOptions(retiredBackup);
        await ensureBootstrapPrerequisites(retiredBackup, retiredPage, 'Retired backup profile');
        const retiredBackupBinding = await backupBindingFact(retiredPage);
        expect(retiredBackupBinding).toEqual(sourceBackupBinding);
        const retiredResponse = await probeRetiredReplicaSession(retiredPage);
        expect(retiredResponse).toMatchObject({ status: 410, code: 'replica_retired' });
        expect(await backupBindingFact(retiredPage)).toEqual(sourceBackupBinding);
        retiredResponseEvidence = retiredResponse;
        await expect(retiredResponse.status).toBe(410); }
      finally { await retiredBackup.close(); }
      scenarioFacts.set('retired-replica-rejected', { name: 'retired-replica-rejected',
        actionEvidence: { surface: 'retired-profile-backup-restore', digest: sha(retiredBackupProfile) },
        observationEvidence: [{ surface: 'extension-message', digest: sha(JSON.stringify(retiredResponseEvidence)) },
          { surface: 'public-http', digest: sha(JSON.stringify(await publicReplicaFacts(pageB))) },
          { surface: 'device-b-browser-tree', digest: await bookmarkTreeDigest(pageB) }] });
      await markStage('retired-replica-rejected', 'passed');
    } finally { await reinstall.close(); await rm(reinstallProfile, { recursive: true, force: true });
      await rm(backupRoot, { recursive: true, force: true });
      await rm(retiredBackupRoot, { recursive: true, force: true }); }

    const replicas = await publicReplicaFacts(pageB) as { replicas?: unknown[] };
    if (!Array.isArray(replicas.replicas) || replicas.replicas.length < 3) throw new Error('replica_evidence_incomplete');
    await assertPublicCanonicalFinalState(collectionId, pageB);
    const finalServerFacts = await publicCanonicalFacts(collectionId, pageB, clientCounts) as typeof serverFacts;
    expect(finalServerFacts.manifestDigest).toBe(serverFacts.manifestDigest);
    const expectedScenarioNames = runtime.managedPolicyInHost ? [...scenarioNames]
      : scenarioNames.filter((name) => name !== 'managed-bookmark-capability');
    expect([...scenarioFacts.keys()].sort()).toEqual(expectedScenarioNames.sort());
    const packagedManifest = JSON.parse(await readFile(resolve(artifact, 'manifest.json'), 'utf8'));
    const packagedConfig = JSON.parse(await readFile(resolve(artifact, 'generated-config.json'), 'utf8'));
    const publicManifest = await pageB.evaluate(async (origin) => (await fetch(`${origin}/.well-known/collection-protocol`)).json(), runtime.origin);
    const browserVersion = b.browser()?.version();
    if (!browserVersion) throw new Error('browser_version_missing');
    const preflightFacts = {
      'production-artifact': { environment: packagedConfig.environment, deploymentId: packagedConfig.deploymentId },
      'artifact-digest': { config: sha(JSON.stringify(packagedConfig)), manifest: sha(JSON.stringify(packagedManifest)) },
      'manifest-v3': { manifestVersion: packagedManifest.manifest_version }, 'extension-id': { actual: extensionId },
      'extension-permissions': { permissions: packagedManifest.permissions, optional: packagedManifest.optional_permissions },
      chromium: { userAgent: browserVersion }, 'service-worker': { urls: (await b.serviceWorkers()).map((worker) => worker.url()) },
      'bookmarks-permission': { granted: await pageB.evaluate(() => chrome.permissions.contains({ permissions: ['bookmarks'] })) },
      indexeddb: { databases: await pageB.evaluate(() => indexedDB.databases()) },
      'two-profile-isolation': { left: sha(profileA), right: sha(profileB) },
      postgresql: { observedThrough: 'production-sync-http-receipts' },
      'fastify-endpoints': { manifestDigest: sha(JSON.stringify(publicManifest)) },
      'managed-policy': managedScenarioFact, 'protocol-0.2': { versions: (publicManifest as { protocolVersions?: string[] }).protocolVersions },
    };
    const fullResult = { accepted: true, browserVersion, publicManagedWriteRejected, managedPolicy: managedScenarioFact,
      preflight: preflightFacts,
      scenarios: Object.fromEntries(scenarioFacts),
      faults: { seededCrashSequence: crashSequence, requiredBoundaries: [...crashSequence].sort(),
        boundaryEvidence },
      clients, replicas: replicas.replicas,
      server: finalServerFacts };
    if (runtime.mode === 'diagnostic') {
      await publishResult({ format: 'known.phase3.multi-device-recovery.browser-diagnostic.v1', schemaVersion: 1,
        accepted: false, mode: 'diagnostic', stage: runtime.stage, browserVersion, observations: fullResult });
      await markStage('full-fast', 'passed');
    } else await publishResult(fullResult);
  } finally {
    await a.close().catch(() => undefined); await b.close().catch(() => undefined);
    if (browserLogPath) await writeFile(browserLogPath, `${browserLogs.join('\n')}\n`,
      { encoding: 'utf8', flag: 'wx', mode: 0o600 }).catch(() => undefined);
    await writeFile(runtime.network, `${networkLogs.join('\n')}\n`,
      { encoding: 'utf8', flag: 'wx', mode: 0o600 }).catch(() => undefined);
    await writeFile(runtime.problems, `${problemLogs.join('\n')}\n`,
      { encoding: 'utf8', flag: 'wx', mode: 0o600 }).catch(() => undefined);
    await rm(profileA, { recursive: true, force: true }); await rm(profileB, { recursive: true, force: true });
    for (const directory of temporaryDirectories) await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
});

async function launch(profile: string, mode: 'profile-install' | 'copied-backup' = 'profile-install') {
  const networkArgs = ['--disable-dev-shm-usage', `--ignore-certificate-errors-spki-list=${runtime.spki}`,
    `--host-resolver-rules=MAP ${runtime.hostname} 127.0.0.1`, '--no-proxy-server'];
  const context = mode === 'copied-backup'
    ? await chromium.launchPersistentContext(profile, { headless: false, channel: 'chromium',
      args: [`--disable-extensions-except=${artifact}`, `--load-extension=${artifact}`, ...networkArgs] })
    : await chromium.launchPersistentContext(profile, { headless: false, channel: 'chromium', ignoreDefaultArgs: ['--disable-extensions'],
      args: ['--enable-unsafe-extension-debugging', ...networkArgs] });
  if (mode === 'profile-install') { const browser = context.browser();
    if (!browser) { await context.close(); throw new Error('cdp_browser_missing'); }
    const loaded = await (await browser.newBrowserCDPSession()).send('Extensions.loadUnpacked', { path: artifact });
    if (loaded.id !== extensionId) { await context.close(); throw new Error(`cdp_extension_id_${loaded.id}`); } }
  context.on('console', (message) => browserLogs.push(JSON.stringify({ type: message.type(),
    text: diagnosticMetadata(message.text(), 'browser-console-message') })));
  context.on('request', (request) => { const requestUrl = new URL(request.url());
    networkLogs.push(JSON.stringify({ kind: 'request', method: request.method(), url: redactUrl(request.url()),
      ...(requestUrl.pathname.endsWith('/sync/pull') ? { query: pullQueryMetadata(requestUrl),
        authority: syncAuthorityMetadata(request) } : {}),
      ...(requestUrl.pathname.endsWith('/sync/snapshot') ? { query: snapshotQueryMetadata(requestUrl),
        authority: syncAuthorityMetadata(request) } : {}),
      ...(/\/sync\/(?:sessions|ack)$/u.test(requestUrl.pathname)
        ? { body: syncRequestMetadata(requestUrl, request.postData()) } : {}) })); });
  context.on('request', (request) => {
    const requestUrl = new URL(request.url());
    if (!/\/sync\/(?:sessions|push|pull|ack|snapshot)/u.test(requestUrl.pathname)) return;
    void request.allHeaders().then((headers) => networkLogs.push(JSON.stringify({
      kind: 'credential-metadata',
      path: requestUrl.pathname,
      authorization: secretMetadata(headers.authorization ?? null, 'network-authorization-header'),
      authorizationToken: credentialTokenMetadata(headers.authorization?.startsWith('Bearer ')
        ? headers.authorization.slice(7) : null, 'network-authorization-token'),
      cookie: secretMetadata(headers.cookie ?? null, 'network-cookie-header'),
    })), () => undefined);
  });
    context.on('response', (response) => { const responseUrl = new URL(response.url()); const contentType = response.headers()['content-type'] ?? '';
    const retryAfter = response.headers()['retry-after'];
    networkLogs.push(JSON.stringify({ kind: 'response', status: response.status(), url: redactUrl(response.url()),
      ...(responseUrl.pathname.endsWith('/sync/pull') ? { query: pullQueryMetadata(responseUrl) } : {}),
      ...(responseUrl.pathname.endsWith('/sync/sessions') ? {
        retryAfterSeconds: boundedRetryAfter(retryAfter), authority: syncAuthorityMetadata(response.request()),
      } : {}) }));
    if (responseUrl.pathname.endsWith('/sync/sessions') && response.status() === 201) {
      void response.json().then((body: { sessionId?: unknown }) => {
        if (typeof body.sessionId === 'string') sessionAuthorityDigests.set(sha(body.sessionId),
          syncAuthorityMetadata(response.request()).authorityDigest);
      }, () => undefined);
    }
    if (responseUrl.pathname.endsWith('/sync/snapshot') && response.status() === 200) {
      void response.json().then((body: unknown) => networkLogs.push(JSON.stringify({
        kind: 'snapshot-metadata',
        ...snapshotMetadata(body),
      })), () => undefined);
    }
    if (responseUrl.pathname.endsWith('/sync/pull') && response.status() === 200) {
      void response.json().then((body: { events?: Array<{ operation?: { type?: unknown }; effect?: {
        kind?: unknown; node?: { id?: unknown; parentId?: unknown }; placement?: { parentId?: unknown } } }> }) =>
        pullStructures.push((body.events ?? []).map((event) => ({ type: safeDiagnosticCode(event.operation?.type),
          kind: safeDiagnosticCode(event.effect?.kind),
          nodeId: secretMetadata(typeof event.effect?.node?.id === 'string' ? event.effect.node.id : null,
            'pull-effect-node-id'),
          nodeParentId: secretMetadata(typeof event.effect?.node?.parentId === 'string' ? event.effect.node.parentId : null,
            'pull-effect-node-parent-id'),
          placementParentId: secretMetadata(typeof event.effect?.placement?.parentId === 'string'
            ? event.effect.placement.parentId : null, 'pull-effect-placement-parent-id') }))), () => undefined);
    }
    if (responseUrl.pathname.endsWith('/sync/pull') && !response.ok()) {
      void response.json().then((body: unknown) => problemLogs.push(JSON.stringify({ kind: 'pull_problem', status: response.status(),
        contentType, ...safeProblemFields(body), query: pullQueryMetadata(responseUrl),
        authority: syncAuthorityMetadata(response.request()) })),
      (error) => problemLogs.push(JSON.stringify({ kind: 'pull_problem', status: response.status(), contentType,
        readError: error instanceof Error ? error.message : 'unknown', query: pullQueryMetadata(responseUrl),
        authority: syncAuthorityMetadata(response.request()) })));
    } else if (responseUrl.pathname.endsWith('/sync/snapshot') && !response.ok()) {
      void response.text().then((raw) => {
        let body: unknown = null; try { body = JSON.parse(raw); } catch { body = null; }
        problemLogs.push(JSON.stringify({ kind: 'snapshot_problem', status: response.status(), contentType,
          bodyBytes: new TextEncoder().encode(raw).byteLength, bodyDigest: sha(raw),
          ...safeProblemFields(body), query: snapshotQueryMetadata(responseUrl),
          authoritySource: snapshotAuthoritySource(responseUrl, response.request()),
          authority: syncAuthorityMetadata(response.request()) }));
      }, (error) => problemLogs.push(JSON.stringify({ kind: 'snapshot_problem', status: response.status(),
        contentType, bodyBytes: 0, bodyDigest: sha(''),
        readError: error instanceof Error ? error.message : 'unknown', query: snapshotQueryMetadata(responseUrl),
        authoritySource: snapshotAuthoritySource(responseUrl, response.request()),
        authority: syncAuthorityMetadata(response.request()) })));
    } else if (contentType.toLowerCase().includes('application/problem+json')) {
      void response.json().then((body: unknown) => problemLogs.push(JSON.stringify({ status: response.status(),
        contentType, ...safeProblemFields(body), ...(responseUrl.pathname.endsWith('/sync/sessions') ? {
          retryAfterSeconds: boundedRetryAfter(retryAfter), authority: syncAuthorityMetadata(response.request()),
        } : {}) })),
        (error) => problemLogs.push(JSON.stringify({ status: response.status(), readError: error instanceof Error ? error.message : 'unknown' })));
    } });
  context.on('page', (page) => page.on('pageerror', (error) => problemLogs.push(JSON.stringify({ kind: 'pageerror', message: error.message }))));
  return context; }
async function stopTrace(context: BrowserContext, name: string) { await context.tracing.stop({ path: resolve(runtime.traces, `${name}-trace.zip`) }); }
async function openOptions(context: BrowserContext) {
  const { page } = await openExtensionOptions(context, extensionId);
  observedPages.add(page); page.once('close', () => observedPages.delete(page)); return page;
}
async function preflight(context: BrowserContext, page: Page, profile: string) {
  expect((await context.serviceWorkers()).some((worker) => worker.url().includes(extensionId))).toBe(true);
  expect(JSON.parse(await readFile(resolve(artifact, 'manifest.json'), 'utf8')).optional_permissions).toContain('bookmarks');
  expect(await page.evaluate(() => typeof chrome.permissions?.contains === 'function')).toBe(true);
  expect(await page.evaluate(() => indexedDB.databases())).toEqual(expect.any(Array));
  expect(profile).toBeTruthy();
}
async function ensureBootstrapPrerequisites(context: BrowserContext, page: Page, permissionTitle: string) {
  try { await expect.poll(() => context.serviceWorkers().some((worker) => worker.url().includes(extensionId)),
    { timeout: 30_000, intervals: [250] }).toBe(true); }
  catch { throw new Error('service_worker_unavailable'); }
  const containsPermission = async () => {
    let checkTimer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([
      page.evaluate(() => chrome.permissions.contains({ permissions: ['bookmarks'] })),
      new Promise<never>((_resolve, reject) => { checkTimer = setTimeout(
        () => reject(new Error('bookmarks_permission_timeout')), 10_000); }),
    ]); }
    catch (error) {
      if (error instanceof Error && error.message === 'bookmarks_permission_timeout') {
        throw new Error('bookmarks_permission_timeout');
      }
      throw new Error('bookmarks_permission_check_failed');
    } finally { if (checkTimer) clearTimeout(checkTimer); }
  };
  let granted = await containsPermission();
  if (!granted) {
    await showOptionsPane(page, 'folders');
    await expect(page.getByRole('button', { name: 'Allow bookmark access' })).toBeVisible({ timeout: 10_000 })
      .catch(() => { throw new Error('bookmarks_permission_denied'); });
    try {
      await grantOptionalBookmarks(page, 'Allow bookmark access', permissionTitle);
    } catch (error) {
      if (error instanceof Error && error.message === 'bookmarks_permission_timeout') {
        throw new Error('bookmarks_permission_timeout');
      }
      throw new Error('bookmarks_permission_denied');
    }
    granted = await containsPermission();
  }
  if (!granted) throw new Error('bookmarks_permission_denied');
  const apiAvailable = await page.evaluate(() => typeof chrome.bookmarks?.create === 'function'
    && typeof chrome.bookmarks?.getTree === 'function' && typeof chrome.bookmarks?.getSubTree === 'function'
    && typeof chrome.bookmarks?.update === 'function' && typeof chrome.bookmarks?.move === 'function'
    && typeof chrome.bookmarks?.remove === 'function');
  if (!apiAvailable) throw new Error('bookmarks_api_unavailable');
}
async function ensureDeviceReady(context: BrowserContext, page: Page, permissionTitle: string) {
  await ensureBootstrapPrerequisites(context, page, permissionTitle);
  await wakeSyncEngine(page);
  try { await ensureEnginesStable([page]); }
  catch (error) {
    let diagnostics: unknown = { pullStructures: pullStructures.slice(-12) };
    try { diagnostics = { engine: await syncEngineStatus(page), queue: await queueDiagnostics(page),
      pull: await pullDiagnostics(page), pullStructures: pullStructures.slice(-12) }; } catch { /* best-effort capsule */ }
    throw new Error(`sync_engine_not_ready:${error instanceof Error
      ? error.message : 'engine_stability_failed'}:${JSON.stringify(diagnostics)}`);
  }
}
async function wakeSyncEngine(page: Page) {
  const wake = await page.evaluate(() => chrome.runtime.sendMessage({ kind: 'known.connectivity.online' })) as { ok?: boolean };
  if (wake?.ok !== true) throw new Error('sync_engine_wake_failed');
}
async function ensureEnginesStable(pages: readonly Page[]) {
  if (pages.length < 1) throw new Error('sync_engine_target_missing');
  try { return await waitForEngineStability({ readStatus: async () => {
    const statuses = await Promise.all(pages.map((page) => readSyncEngineStatus(page)));
    return statuses.find((status) => !engineStatusIsStable(status)) ?? statuses[0]!;
  }, networkCounts: networkRequestCounts, wait: (milliseconds) => pages[0]!.waitForTimeout(milliseconds) }); }
  catch (error) { throw new Error(`engine_stability_failed:${JSON.stringify(await Promise.all(pages.map(async (page, device) => ({
    device, recovery: await captureRecoveryDiagnostics(page),
  }))))}`, { cause: error }); }
}
async function bootstrapProductAccount(product: Page): Promise<string> { const observerUrl = product.url(); const context = product.context();
  try {
    const publicOrigin = new URL(runtime.origin); const directOrigin = new URL(runtime.origin);
    directOrigin.hostname = '127.0.0.1';
    const signIn = await context.request.post(`${directOrigin.origin}/api/v1/auth/sign-in/email`, {
      headers: { Host: publicOrigin.host, Origin: publicOrigin.origin, 'Content-Type': 'application/json' },
      data: { email: EXTENSION_FIXTURE_EMAIL, password: EXTENSION_FIXTURE_PASSWORD },
    });
    if (!signIn.ok()) {
      const signUp = await context.request.post(`${directOrigin.origin}/api/v1/auth/sign-up/email`, {
        headers: { Host: publicOrigin.host, Origin: publicOrigin.origin, 'Content-Type': 'application/json' },
        data: { email: EXTENSION_FIXTURE_EMAIL, password: EXTENSION_FIXTURE_PASSWORD, name: 'P3-38 fixture' },
      });
      if (!signUp.ok()) throw new Error(`product_auth_${signUp.status()}`);
    }
    await mirrorDirectProductCookies(context, directOrigin.origin, publicOrigin.origin);
    const response = await product.goto(`${publicOrigin.origin}/api/v1/session`); if (!response?.ok()) throw new Error(`product_session_${response?.status()}`);
    const session = JSON.parse(await response.text()) as { authenticated?: boolean; csrfToken?: string };
    expect(session.authenticated).toBe(true); expect(session.csrfToken).toEqual(expect.any(String));
    const cookie = (await context.cookies(runtime.origin)).map((value) => `${value.name}=${value.value}`).join('; ');
    const requestHeaders = { Host: publicOrigin.host, Cookie: cookie };
    const listed = await context.request.get(`${directOrigin.origin}/api/v1/collections?limit=100`, { headers: requestHeaders });
    const list = await listed.json() as { items?: Array<{ collection?: { id?: string } }> };
    let collectionId = list.items?.[0]?.collection?.id;
    if (!collectionId) {
      const created = await context.request.post(`${directOrigin.origin}/api/v1/collections`, { headers: { ...requestHeaders,
        Origin: runtime.origin, 'X-CSRF-Token': session.csrfToken!, 'Known-Command-Id': crypto.randomUUID() },
      data: { kind: 'bookmarks', title: 'P3-38 browser collection', summary: null } });
      if (created.status() !== 201) throw new Error(`product_collection_${created.status()}`);
      collectionId = ((await created.json()) as { collection: { id: string } }).collection.id;
    }
    const signedOut = await context.request.post(`${directOrigin.origin}/api/v1/auth/sign-out`, {
      headers: { ...requestHeaders, Origin: runtime.origin },
    });
    if (!signedOut.ok()) throw new Error(`product_bootstrap_signout_${signedOut.status()}`);
    await context.clearCookies({ name: SESSION_COOKIE_NAME });
    return collectionId;
  } finally { await product.goto(observerUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 }); } }
async function selectCollectionThroughOptions(page: Page, value: string) {
  await selectCollectionFromList(page, value);
}
async function signInAndSelectRoot(page: Page, name: string, collectionId = '') {
  await page.evaluate(() => { const scope = window as typeof window & { __p338LoginResult?: unknown; __p338SendMessage?: typeof chrome.runtime.sendMessage };
    scope.__p338SendMessage = chrome.runtime.sendMessage.bind(chrome.runtime); chrome.runtime.sendMessage = async (message: unknown) => {
      const result = await scope.__p338SendMessage!(message);       if ((message as { kind?: string })?.kind === 'known.auth.login') {
        const value = result as { ok?: boolean; error?: string; state?: { status?: string; errorCode?: string } };
        scope.__p338LoginResult = { ok: value.ok, error: value.error, status: value.state?.status, errorCode: value.state?.errorCode };
      } return result; }; });
  await signInExtension(page, collectionId || undefined);
  try { await expect.poll(() => page.locator('body').getAttribute('data-state'), { timeout: 30_000 })
      .toMatch(/^(?:connected|error|offline|policy_blocked)$/u);
    await expect(page.locator('body')).toHaveAttribute('data-state', 'connected');
    await page.evaluate(() => { const scope = window as typeof window & { __p338SendMessage?: typeof chrome.runtime.sendMessage };
      if (scope.__p338SendMessage) chrome.runtime.sendMessage = scope.__p338SendMessage; delete scope.__p338SendMessage; }); }
  catch (error) { const status = await page.evaluate(() => chrome.runtime.sendMessage({ kind: 'known.auth.status' })) as
      { ok?: boolean; error?: string; state?: { status?: string; errorCode?: string } };
    const login = await page.evaluate(() => (window as typeof window & { __p338LoginResult?: unknown }).__p338LoginResult);
    throw new Error(`extension_login_failed: ${JSON.stringify({ ok: status.ok, error: safeDiagnosticCode(status.error),
      status: safeDiagnosticCode(status.state?.status), errorCode: safeDiagnosticCode(status.state?.errorCode),
      login: diagnosticMetadata(login, 'bootstrap-login-result'),
      console: browserLogs.slice(-20), network: networkLogs.slice(-20), problems: problemLogs.slice(-20) })}`, { cause: error }); }
  if (collectionId) await selectCollectionThroughOptions(page, collectionId);
  await ensureBootstrapPrerequisites(page.context(), page, name);
  // Standard folder roles identify the same remote mount across devices.
  // Ordinary custom roots are local selections and cannot be matched by native id.
  const fixtureRootTitle = await page.evaluate(async () => {
    const tree = await chrome.bookmarks.getTree();
    const browserRoot = tree[0]?.children?.find((node) => node.folderType === 'bookmarks-bar')
      ?? tree[0]?.children?.find((node) => node.url === undefined);
    if (!browserRoot) throw new Error('browser_root_missing');
    return browserRoot.title;
  });
  await showOptionsPane(page, 'folders');
  await page.locator('#refresh-roots').click();
  const fixtureRoot = page.getByRole('checkbox', { name: fixtureRootTitle, exact: true });
  await expect(fixtureRoot).toBeVisible({ timeout: 15_000 });
  for (const selection of await page.locator('.root-select input:enabled').all()) await selection.uncheck();
  await fixtureRoot.check();
  const start = page.locator('#first-run-start');
  await expect(start).toBeEnabled({ timeout: 15_000 });
  await start.click();
  await expect(page.locator('body')).toHaveAttribute('data-first-run', '', { timeout: 90_000 });
  await ensureDeviceReady(page.context(), page, name);
  await selectedRoot(page);
}
async function refreshConnection(page: Page) {
  let response: { ok?: boolean; error?: string; state?: unknown; messageTimedOut?: boolean } | undefined;
  try { response = await sendRefreshMessage(page); }
  catch (error) {
    if (!(error instanceof Error) || !error.message.includes(
      'message channel closed before a response was received')) throw error;
    throw new Error('connection_refresh_failed: message_channel_closed', { cause: error });
  }
  if (!response) throw new Error('connection_refresh_failed: missing_response');
  if (response.messageTimedOut) throw new Error('connection_refresh_indeterminate');
  if (response.ok !== true && (response.error === 'credential_revoked'
      || (response.state as { errorCode?: unknown } | undefined)?.errorCode === 'credential_revoked')) {
    // A revoked browser Session requires a real user credential exchange.
    // Reauthenticate the same fixture account, preserving the selected root
    // and durable Sync state before continuing the retention recovery.
    await reauthenticateFixtureDevice(page);
    await ensureDeviceReady(page.context(), page, 'Reauthenticated profile');
    return;
  }
  if (response.ok !== true) throw new Error(`connection_refresh_failed: ${JSON.stringify({ response,
    network: networkLogs.slice(-20), problems: problemLogs.slice(-20) })}`);
  await ensureDeviceReady(page.context(), page, 'Recovered profile');
}
async function reauthenticateFixtureDevice(page: Page) {
  const login = await page.evaluate(({ email, password }) => chrome.runtime.sendMessage({
    kind: 'known.auth.login', method: 'password', userGesture: true, email, password,
  }), { email: EXTENSION_FIXTURE_EMAIL, password: EXTENSION_FIXTURE_PASSWORD }) as {
    ok?: boolean; state?: { status?: string; errorCode?: string }; error?: string;
  };
  if (login.ok !== true || login.state?.status !== 'connected') {
    throw new Error(`connection_reauthentication_failed:${safeDiagnosticCode(login.state?.errorCode ?? login.error)}`);
  }
}
async function refreshAfterAuthorityInvalidation(page: Page) {
  const now = Date.now();
  if (now < (refreshCooldownUntil.get(page) ?? 0)) { await observeConvergence(page); return; }
  refreshCooldownUntil.set(page, now + 60_000);
  await refreshConnection(page);
}
async function sendRefreshMessage(page: Page) {
  return page.evaluate(() => Promise.race([
    chrome.runtime.sendMessage({ kind: 'known.auth.refresh' }),
    new Promise<{ messageTimedOut: true }>((resolveTimeout) =>
      setTimeout(() => resolveTimeout({ messageTimedOut: true }), 15_000)),
  ])) as Promise<{ ok?: boolean; error?: string; state?: unknown; messageTimedOut?: boolean }>;
}
async function selectedRoot(page: Page) {
  const status = await readSyncEngineStatus(page) as { engine?: { scopeKey?: string } };
  const [mounts, mappings] = await Promise.all([
    readStore(page, 'mount_bindings') as Promise<Array<{ scopeKey: string; status: string;
      nativeRootId: string; remoteMountNodeId: string | null }>>,
    readStore(page, 'native_mappings') as Promise<Array<{ scopeKey: string; nativeId: string; colpId: string }>>,
  ]);
  const active = mounts.filter((mount) => mount.scopeKey === status.engine?.scopeKey && mount.status === 'active');
  if (active.length !== 1) throw new Error(`selected_root_mount_count:${active.length}`);
  const mount = active[0]!;
  const root = mappings.find((mapping) => mapping.scopeKey === mount.scopeKey
    && mapping.colpId === mount.remoteMountNodeId
    && (mapping.nativeId === mount.nativeRootId || mapping.nativeId.startsWith('recovery:')));
  if (!root) throw new Error(`selected_root_mapping_missing:${JSON.stringify({
    mountHasRemote: typeof mount.remoteMountNodeId === 'string', mappingCount: mappings.length,
    mappings: mappings.map((mapping) => ({ sameScope: mapping.scopeKey === mount.scopeKey,
      sameNative: mapping.nativeId === mount.nativeRootId, sameRemote: mapping.colpId === mount.remoteMountNodeId,
      nativeKind: /^(recovery|unmounted|sidecar|pending)[-:]/u.exec(mapping.nativeId)?.[1] ?? 'native',
      remoteKind: /^(recovery|unmounted|sidecar|pending)[-:]/u.exec(mapping.colpId)?.[1] ?? 'authoritative' })),
  })}`);
  const native = await page.evaluate((id) => chrome.bookmarks.get(id), mount.nativeRootId);
  expect(native).toHaveLength(1);
  expect(native[0]!.url).toBeUndefined();
  return mount.nativeRootId;
}
async function findBookmark(page: Page, root: string, title: string) { const children = await page.evaluate((id) => chrome.bookmarks.getSubTree(id), root);
  const found = flatten(children).find((node) => node.title === title); if (!found) throw new Error('bookmark_not_observed'); return found; }
async function waitForBookmark(page: Page, root: string, title: string) { await expect.poll(async () => {
  await observeConvergence(page);
  try { return Boolean(await findBookmark(page, root, title)); } catch { return false; }
}, { timeout: 60_000, intervals: [1_000] }).toBe(true); }
function flatten(nodes: chrome.bookmarks.BookmarkTreeNode[]): chrome.bookmarks.BookmarkTreeNode[] {
  return nodes.flatMap((node) => [node, ...flatten(node.children ?? [])]);
}
async function waitForConflict(pages: Page[]) { await expect.poll(async () => {
  for (const page of pages) {
    await observeConvergence(page);
    if ((await readStore(page, 'receipts') as unknown[]).some((row) => JSON.stringify(row).includes('conflictId'))) return true;
  }
  return false;
}, { timeout: 60_000, intervals: [1_000] }).toBe(true); }
async function queueDepth(page: Page) { const facts = await readStore(page, 'outbound_queue') as Array<{ status?: string }>;
  return facts.filter((fact) => !['terminal', 'rejected'].includes(String(fact.status))).length; }
async function captureRecoveryDiagnostics(page: Page) {
  const engines = await readStore(page, 'sync_engine') as Array<Record<string, unknown>>;
  const scopes = await readStore(page, 'sync_scopes') as Array<{ scopeKey: string; lifecycle: string;
    lease: { generation?: string }; checkpoint?: { cursor?: string } }>;
  const cursors = await readStore(page, 'cursors') as Array<{ scopeKey: string; cursor?: string }>;
  const acks = await readStore(page, 'ack_intents') as Array<{ scopeKey: string; kind: string; state: string; cursor: string }>;
  return { status: await syncEngineStatus(page), nativeIdentity: await nativeIdentityDiagnostics(page, (name) => readStore(page, name)),
    checkpoints: scopes.map((scope) => ({
    lifecycle: scope.lifecycle, leaseGeneration: scope.lease.generation,
    checkpointMatchesCursor: cursors.some((cursor) => cursor.scopeKey === scope.scopeKey && cursor.cursor === scope.checkpoint?.cursor),
    pendingAckCount: acks.filter((ack) => ack.scopeKey === scope.scopeKey && ack.state !== 'complete').length,
    completedBootstrapAck: acks.some((ack) => ack.scopeKey === scope.scopeKey && ack.kind === 'bootstrap'
      && ack.state === 'complete' && ack.cursor === scope.checkpoint?.cursor),
  })), session: await page.evaluate(async () => {
    const session = (await chrome.storage.session.get('known.auth.session.v1'))['known.auth.session.v1'] as {
      snapshotRequired?: boolean; replicaLease?: { generation?: string }; expiresAt?: string } | undefined;
    return { present: Boolean(session), snapshotRequired: session?.snapshotRequired,
      leaseGeneration: session?.replicaLease?.generation, expiresAt: session?.expiresAt };
  }), engines: engines.map((row) => ({
    phase: safeDiagnosticCode(row.phase), revision: row.revision, recoveryFrozen: row.recoveryFrozen,
    localProjectionOwner: row.localProjectionOwner, authorityRefreshRequired: row.authorityRefreshRequired,
    lastError: safeDiagnosticCode(row.lastError), notBefore: row.notBefore, updatedAt: row.updatedAt,
  })), alarms: await page.evaluate(async () => {
    const alarms = chrome.alarms as typeof chrome.alarms & { getAll(): Promise<chrome.alarms.Alarm[]> };
    return (await alarms.getAll())
      .filter((alarm) => ['known-bookmark-capture-recovery', 'known-sync-engine'].includes(alarm.name))
      .map(({ name, scheduledTime }) => ({ name, scheduledTime }));
  }), pull: await pullDiagnostics(page) };
}
async function stableStoreDigest(page: Page, store: string) {
  const deadline = Date.now() + 30_000; let current = await storeDigest(page, store); let stableSince = Date.now();
  while (Date.now() < deadline) {
    await page.waitForTimeout(250); const next = await storeDigest(page, store);
    if (next !== current) { current = next; stableSince = Date.now(); }
    else if (Date.now() - stableSince >= 2_000) return current;
  }
  throw new Error(`boundary_store_not_stable: ${store}`);
}
async function drainQueue(page: Page, timeout = 180_000) { await expect.poll(async () => {
  await observeConvergence(page); return queueDepth(page);
}, { timeout }).toBe(0); }
async function syncEngineStatus(page: Page) {
  const status = await readSyncEngineStatus(page); const engine = status && typeof status === 'object'
    ? (status as { engine?: Record<string, unknown> }).engine : undefined;
  return { ok: (status as { ok?: unknown } | null)?.ok === true,
    error: safeDiagnosticCode((status as { error?: unknown } | null)?.error),
    engine: { phase: safeDiagnosticCode(engine?.phase), recoveryFrozen: engine?.recoveryFrozen === true,
      authorityRefreshRequired: engine?.authorityRefreshRequired === true,
      cooldownPending: engine?.cooldownPending === true, engineWakeInFlight: engine?.engineWakeInFlight === true,
      authorityRefreshInFlight: engine?.authorityRefreshInFlight === true,
      credentialReady: engine?.credentialReady === true, sessionReady: engine?.sessionReady === true,
      hasPendingWork: engine?.hasPendingWork === true,
      errorCode: safeDiagnosticCode(engine?.errorCode), hasPublishedCursor: engine?.hasPublishedCursor === true,
      hasPushServerCursor: engine?.hasPushServerCursor === true,
      cursorsConverged: engine?.cursorsConverged === true, listenerInstalled: engine?.listenerInstalled === true,
      eventObserved: Number(engine?.eventObserved ?? 0), eventAccepted: Number(engine?.eventAccepted ?? 0),
      eventRejected: Number(engine?.eventRejected ?? 0),
      eventRejectedReason: safeDiagnosticCode(engine?.eventRejectedReason),
      captureFailureCode: safeDiagnosticCode(engine?.captureFailureCode) } };
}
async function readSyncEngineStatus(page: Page): Promise<EngineStabilityStatus> {
  return await page.evaluate(() => chrome.runtime.sendMessage({ kind: 'known.sync.engine.status' })) as EngineStabilityStatus;
}
async function bookmarkIngressStatus(page: Page) {
  const status = await readSyncEngineStatus(page) as { ok?: boolean; engine?: { listenerInstalled?: unknown;
    eventObserved?: unknown; eventAccepted?: unknown; eventRejected?: unknown; eventRejectedReason?: unknown;
    captureFailureCode?: unknown } };
  if (status.ok !== true || !status.engine) throw new Error('bookmark_ingress_status_unavailable');
  return { listenerInstalled: status.engine.listenerInstalled === true,
    eventObserved: Number(status.engine.eventObserved ?? 0), eventAccepted: Number(status.engine.eventAccepted ?? 0),
    eventRejected: Number(status.engine.eventRejected ?? 0),
    eventRejectedReason: safeDiagnosticCode(status.engine.eventRejectedReason),
    captureFailureCode: safeDiagnosticCode(status.engine.captureFailureCode) };
}
async function observeConvergence(page: Page) {
  const status = await readSyncEngineStatus(page) as { ok?: boolean; error?: string } | undefined;
  if (status?.ok !== true && status?.error !== 'not_connected') throw new Error('sync_status_unavailable');
  return status;
}
async function waitForRecoveryComplete(page: Page, previousCursorDigest: string) {
  try { await expect.poll(async () => {
    const status = await readSyncEngineStatus(page) as { ok?: boolean; engine?: { phase?: string; recoveryFrozen?: boolean;
      authorityRefreshRequired?: boolean; cursorsConverged?: boolean } };
    let cursorDigest: string | undefined;
    try { cursorDigest = (await durableFacts(page, 'recovery-probe')).cursorDigest; } catch { return false; }
    // F023: cursorsConverged is the honest Pull/Ack convergence fact — Push
    // receipts feed lastPushServerCursor (surfaced as hasPushServerCursor) and
    // can no longer satisfy this gate. Recovery completion still requires the
    // real pull/ack pair to converge plus a changed durable cursor digest.
    return status.ok === true && status.engine?.phase === 'sleeping' && status.engine.recoveryFrozen === false
      && status.engine.authorityRefreshRequired === false
      && status.engine.cursorsConverged === true && cursorDigest !== previousCursorDigest;
  }, { timeout: 120_000, intervals: [1_000] }).toBe(true);
    expect((await nativeIdentityDiagnostics(page, (name) => readStore(page, name))).missingCount).toBe(0); }
  catch (error) {
    const status = await readSyncEngineStatus(page) as { ok?: boolean; error?: string; engine?: { phase?: string;
      recoveryFrozen?: boolean; authorityRefreshRequired?: boolean; errorCode?: string; cursorsConverged?: boolean } };
    throw new Error(`stale_recovery_incomplete: ${JSON.stringify({ engine: { ok: status.ok, error: status.error,
      phase: status.engine?.phase, recoveryFrozen: status.engine?.recoveryFrozen,
      authorityRefreshRequired: status.engine?.authorityRefreshRequired, errorCode: status.engine?.errorCode,
      cursorsConverged: status.engine?.cursorsConverged === true },
    durableConverged: await durableConverged(page), recovery: await captureRecoveryDiagnostics(page), pull: await pullDiagnostics(page),
    network: networkLogs.slice(-40), problems: problemLogs.slice(-20) })}`, { cause: error });
  }
}
async function queueDiagnostics(page: Page) {
  const [rows, events, mappings] = await Promise.all([readStore(page, 'outbound_queue'),
    readStore(page, 'bookmark_events'), readStore(page, 'native_mappings')]) as [Array<{ sequence?: unknown; opId?: unknown;
    baseRevision?: unknown; status?: unknown; retry?: { attempt?: unknown; notBefore?: unknown; claimExpiresAt?: unknown };
    recovery?: { code?: unknown }; payload?: { type?: unknown; targetId?: unknown; payload?: { value?: unknown } } }>,
    Array<{ opId?: unknown; kind?: unknown; ordinal?: unknown; occurredAt?: unknown; details?: unknown }>,
    Array<{ colpId?: unknown; projection?: { revision?: unknown; content?: unknown } }>];
  return rows.map((row) => { const event = events.find((candidate) => candidate.opId === row.opId);
    const mapping = mappings.find((candidate) => candidate.colpId === row.payload?.targetId);
    return { sequence: row.sequence, status: row.status, attempt: row.retry?.attempt,
    notBefore: row.retry?.notBefore, claimExpiresAt: row.retry?.claimExpiresAt,
    recovery: safeDiagnosticCode(row.recovery?.code),
    opId: secretMetadata(typeof row.opId === 'string' ? row.opId : null, 'queue-operation-id'),
    baseRevision: secretMetadata(typeof row.baseRevision === 'string' ? row.baseRevision : null, 'queue-base-revision'),
    operationType: safeDiagnosticCode(row.payload?.type),
    targetId: secretMetadata(typeof row.payload?.targetId === 'string' ? row.payload.targetId : null, 'queue-target-id'),
    value: diagnosticMetadata(row.payload?.payload?.value, 'queue-payload-value'),
    event: event ? { kind: safeDiagnosticCode(event.kind), ordinal: event.ordinal, occurredAt: event.occurredAt,
      details: diagnosticMetadata(event.details, 'queue-native-event-details') } : undefined,
    mapping: mapping ? { revision: secretMetadata(typeof mapping.projection?.revision === 'string'
      ? mapping.projection.revision : null, 'queue-mapping-revision'),
    content: diagnosticMetadata(mapping.projection?.content, 'queue-mapping-content') } : undefined }; });
}
async function rootDiagnostics(page: Page, root: string) {
  const mappings = await readStore(page, 'native_mappings') as Array<{ nativeId?: unknown; colpId?: unknown }>;
  const scopes = await readStore(page, 'sync_scopes') as Array<{ selectedRoots?: unknown; rootStatus?: unknown }>;
  const selected = Array.isArray(scopes.at(-1)?.selectedRoots) ? scopes.at(-1)!.selectedRoots as unknown[] : [];
  const rootMapping = mappings.find((row) => row.nativeId === root);
  return { mappingCount: mappings.length, rootMapped: Boolean(rootMapping), selectionMapped: selected.includes(rootMapping?.colpId),
    selectedRoots: selected.map((value) => secretMetadata(typeof value === 'string' ? value : null,
      'root-diagnostic-selected-root')),
    rootStatus: safeDiagnosticCode(scopes.at(-1)?.rootStatus),
    permission: await page.evaluate(() => chrome.permissions.contains({ permissions: ['bookmarks'] })) };
}
async function bookmarkApiDiagnostics(context: BrowserContext, page: Page, parentId: string) {
  const probe = async (target: Page | NonNullable<ReturnType<BrowserContext['serviceWorkers']>[number]>) =>
    target.evaluate(async (id) => {
      const classify = (error: unknown) => { const message = error instanceof Error ? error.message.toLowerCase() : '';
        if (/context.*invalid|extension context/u.test(message)) return 'context_invalidated';
        if (/permission|not permitted|access denied/u.test(message)) return 'permission_denied';
        if (/not a function|undefined/u.test(message)) return 'method_unavailable';
        if (/illegal invocation/u.test(message)) return 'illegal_invocation';
        if (/find bookmark|bookmark.*not found|no bookmark/u.test(message)) return 'bookmark_not_found';
        return 'api_unknown'; };
      const call = async (operation: () => Promise<chrome.bookmarks.BookmarkTreeNode[]>) => {
        try { return { ok: true, count: (await operation()).length }; }
        catch (error) { return { ok: false, code: classify(error) }; }
      };
      return { children: await call(() => chrome.bookmarks.getChildren(id)),
        subtree: await call(() => chrome.bookmarks.getSubTree(id)) };
    }, parentId);
  const worker = context.serviceWorkers().find((candidate) => candidate.url().includes(extensionId));
  return { page: await probe(page), worker: worker ? await probe(worker) : { unavailable: true } };
}
async function pullDiagnostics(page: Page) {
  const events = await readStore(page, 'pull_events') as Array<{ state?: unknown; kind?: unknown; operationId?: unknown }>;
  const intents = await readStore(page, 'apply_intents') as Array<{ state?: unknown; correlationId?: unknown;
    operationId?: unknown; expiresAt?: unknown; nativeTargetId?: unknown; expected?: { kind?: unknown };
    expectedPostState?: unknown; nativeEventEvidence?: unknown; apiResultEvidence?: unknown }>;
  const pages = await readStore(page, 'pull_pages') as Array<{ state?: unknown; eventCount?: unknown }>;
  const scopes = await readStore(page, 'sync_scopes') as Array<{ lifecycle?: unknown; metadata?: unknown }>;
  return { events: events.map((row) => ({ state: safeDiagnosticCode(row.state), kind: safeDiagnosticCode(row.kind),
      operationId: secretMetadata(typeof row.operationId === 'string' ? row.operationId : null,
        'apply-intent-operation-id') })),
    intents: intents.map((row) => ({ state: safeDiagnosticCode(row.state), kind: safeDiagnosticCode(row.expected?.kind),
      correlationId: secretMetadata(typeof row.correlationId === 'string' ? row.correlationId : null,
        'receipt-correlation-id'),
      operationId: secretMetadata(typeof row.operationId === 'string' ? row.operationId : null,
        'receipt-operation-id'),
      nativeTargetId: secretMetadata(typeof row.nativeTargetId === 'string' ? row.nativeTargetId : null,
        'receipt-native-target-id'),
      expiresAt: row.expiresAt,
      expectedPostState: diagnosticMetadata(row.expectedPostState, 'receipt-expected-post-state'),
      nativeEventEvidence: diagnosticMetadata(row.nativeEventEvidence, 'receipt-native-event-evidence'),
      apiResultEvidence: diagnosticMetadata(row.apiResultEvidence, 'receipt-api-result-evidence') })),
    pages: pages.map((row) => ({ state: row.state, eventCount: row.eventCount })),
    scope: scopes.map((row) => ({ lifecycle: safeDiagnosticCode(row.lifecycle),
      metadata: diagnosticMetadata(row.metadata, 'recovery-scope-metadata') })) };
}
async function engineDiagnostics(page: Page) {
  const rows = await readStore(page, 'sync_engine') as Array<{ phase?: unknown; revision?: unknown; notBefore?: unknown;
    lastError?: unknown; connectivityConfirmationRevision?: unknown }>;
  return rows.map((row) => ({ phase: safeDiagnosticCode(row.phase), revision: row.revision,
    notBefore: row.notBefore, lastError: safeDiagnosticCode(row.lastError),
    connectivityConfirmationRevision: row.connectivityConfirmationRevision }));
}
async function readStore(page: Page, store: string) { return page.evaluate(async (storeName) => {
  const request = indexedDB.open('known-phase3-indexeddb-entry');
  const database = await new Promise<IDBDatabase>((resolveRequest, reject) => { request.onsuccess = () => resolveRequest(request.result); request.onerror = () => reject(request.error); });
  try { const transaction = database.transaction(storeName, 'readonly'); const values = transaction.objectStore(storeName).getAll();
    return await new Promise<unknown[]>((resolveRequest, reject) => { values.onsuccess = () => resolveRequest(values.result); values.onerror = () => reject(values.error); }); }
  finally { database.close(); }
}, store); }
async function storeContains(page: Page, store: string, markerParts: string[]) { return page.evaluate(async ({ storeName, parts }) => {
  const request = indexedDB.open('known-phase3-indexeddb-entry');
  const database = await new Promise<IDBDatabase>((resolveRequest, reject) => { request.onsuccess = () => resolveRequest(request.result); request.onerror = () => reject(request.error); });
  try { const transaction = database.transaction(storeName, 'readonly'); const values = transaction.objectStore(storeName).getAll();
    const rows = await new Promise<unknown[]>((resolveRequest, reject) => { values.onsuccess = () => resolveRequest(values.result); values.onerror = () => reject(values.error); });
    return JSON.stringify(rows).includes(parts.join('')); } finally { database.close(); }
}, { storeName: store, parts: markerParts }); }
async function storeDigest(page: Page, store: string) { return page.evaluate(async (storeName) => {
  const request = indexedDB.open('known-phase3-indexeddb-entry');
  const database = await new Promise<IDBDatabase>((resolveRequest, reject) => { request.onsuccess = () => resolveRequest(request.result); request.onerror = () => reject(request.error); });
  try { const transaction = database.transaction(storeName, 'readonly'); const values = transaction.objectStore(storeName).getAll();
    const rows = await new Promise<unknown[]>((resolveRequest, reject) => { values.onsuccess = () => resolveRequest(values.result); values.onerror = () => reject(values.error); });
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(rows)));
    return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join(''); } finally { database.close(); }
}, store); }
async function indexedDbDigest(page: Page) { return sha(JSON.stringify(await Promise.all(['sync_scopes', 'outbound_queue', 'pull_pages', 'apply_intents'].map((name) => readStore(page, name))))); }
async function bookmarkTreeDigest(page: Page) { const tree = await page.evaluate(() => chrome.bookmarks.getTree());
  const normalize = (nodes: chrome.bookmarks.BookmarkTreeNode[]): unknown[] => nodes.map((node) => ({ title: node.title,
    ...(node.url ? { url: node.url } : {}), children: normalize(node.children ?? []) }));
  return sha(JSON.stringify(normalize(tree))); }
async function managedBookmarkTreeDigest(page: Page) {
  const rootId = await selectedRoot(page);
  const children = await page.evaluate(async (id) => (await chrome.bookmarks.getSubTree(id))[0]?.children ?? [], rootId);
  const normalize = (nodes: chrome.bookmarks.BookmarkTreeNode[]): unknown[] => nodes.map((node) => ({ title: node.title,
    ...(node.url ? { url: node.url } : {}), children: normalize(node.children ?? []) }));
  return sha(JSON.stringify(normalize(children)));
}
async function durableFacts(page: Page, profile: string, checkpointOrdinal?: string) { const cursors = await readStore(page, 'cursors') as Array<{ cursor?: unknown }>;
  const scopes = await readStore(page, 'sync_scopes') as Array<{ checkpoint?: { cursor?: unknown } | null }>;
  const cursor = cursors.findLast((value) => typeof value.cursor === 'string')?.cursor;
  const acknowledged = scopes.findLast((value) => typeof value.checkpoint?.cursor === 'string')?.checkpoint?.cursor;
  if (typeof cursor !== 'string' || typeof acknowledged !== 'string' || cursor !== acknowledged) throw new Error('durable_cursor_ack_incomplete');
  return { profileDigest: sha(profile), treeDigest: await managedBookmarkTreeDigest(page), cursorDigest: sha(cursor),
    ackDigest: sha(acknowledged), indexedDbDigest: await indexedDbDigest(page),
    ...(checkpointOrdinal === undefined ? {} : { checkpointOrdinal }) }; }
async function latestCursorDigest(page: Page) { const cursors = await readStore(page, 'cursors') as Array<{ cursor?: unknown }>;
  const cursor = cursors.findLast((value) => typeof value.cursor === 'string')?.cursor;
  if (typeof cursor !== 'string') throw new Error('durable_cursor_missing'); return sha(cursor); }
async function durableConverged(page: Page) { try { await durableFacts(page, 'probe'); return true; } catch { return false; } }
async function finalConvergenceState(pageA: Page, pageB: Page) {
  const [treeA, treeB, durableA, durableB, ordinals] = await Promise.all([
    managedBookmarkTreeDigest(pageA), managedBookmarkTreeDigest(pageB), durableConverged(pageA), durableConverged(pageB),
    clientCheckpointOrdinals(pageB, [pageA, pageB]),
  ]);
  return { treesEqual: treeA === treeB, clientsDurable: durableA && durableB,
    checkpointOrdinalsEqual: ordinals.length === 2 && ordinals[0] !== null && ordinals[0] === ordinals[1] };
}
async function clientCheckpointOrdinals(host: Page, clients: readonly Page[]): Promise<Array<string | null>> {
  const replicaIds = await Promise.all(clients.map((page) => page.evaluate(async () => {
    const binding = (await chrome.storage.local.get('known.auth.binding.v1'))['known.auth.binding.v1'] as
      { replicaId?: unknown } | undefined;
    return typeof binding?.replicaId === 'string' ? binding.replicaId : null;
  })));
  const status = await productJson(host, '/api/v1/sync/status') as { replicas?: Array<{
    id?: unknown; acknowledgedCommitOrdinal?: unknown;
  }> };
  return replicaIds.map((replicaId) => {
    const ordinal = status.replicas?.find((replica) => replica.id === replicaId)?.acknowledgedCommitOrdinal;
    return typeof ordinal === 'string' ? ordinal : null;
  });
}
async function terminateServiceWorker(context: BrowserContext, page: Page) { const cdp = await context.newCDPSession(page);
  await cdp.send('ServiceWorker.enable'); const targets = await cdp.send('Target.getTargets'); const target = targets.targetInfos.find((x) => x.type === 'service_worker' && x.url.includes(extensionId));
  if (!target) throw new Error('service_worker_missing'); await cdp.send('Target.closeTarget', { targetId: target.targetId }); await cdp.detach(); return target.targetId; }
async function uninstallExtension(context: BrowserContext, _page: Page) {
  const browser = context.browser(); if (!browser) throw new Error('cdp_browser_missing');
  const cdp = await browser.newBrowserCDPSession(); await cdp.send('Extensions.uninstall', { id: extensionId });
  const installed = await cdp.send('Extensions.getExtensions');
  expect(installed.extensions.some((extension) => extension.id === extensionId)).toBe(false);
  await expect.poll(() => context.serviceWorkers().some((worker) => worker.url().includes(extensionId)),
    { timeout: 30_000 }).toBe(false); }
function seededCrashSequence(value: string) { const points = ['queue-persisted', 'push-commit-response-loss', 'receipt-before-persist', 'receipt-after-persist',
  'pull-intent-persisted', 'chrome-mutation-before', 'chrome-mutation-after', 'cursor-before-persist', 'cursor-after-persist', 'ack-before', 'ack-after'];
  return [...points].sort((left, right) => sha(`${value}:${left}`).localeCompare(sha(`${value}:${right}`))); }
function boundaryStore(point: string) { if (/^queue/u.test(point)) return 'outbound_queue';
  if (/^(?:push|receipt)/u.test(point)) return 'receipts'; if (/^(?:pull-intent|chrome-mutation)/u.test(point)) return 'apply_intents';
  if (/^cursor/u.test(point)) return 'cursors'; if (/^ack/u.test(point)) return 'ack_intents'; throw new Error('unknown_boundary'); }
async function resolveOpenConflict(pages: Page[]) {
  let match: RegExpMatchArray | null = null;
  for (const page of pages) {
    match = JSON.stringify(await readStore(page, 'receipts')).match(/"conflictId":"([^"]+)"/u);
    if (match) break;
  }
  if (!match) throw new Error('conflict_id_not_observed');
  const conflictId = match[1]!;
  const product = pages[0]!; const observerUrl = product.url();
  const observer = await product.context().newCDPSession(product);
  await observer.send('Page.setBypassCSP', { enabled: true });
  let result: { status: number; body: string };
  try { await ensureProductSession(product);
    result = await product.evaluate(async ({ origin, conflictId }) => {
      const session = await (await fetch(`${origin}/api/v1/session`, { credentials: 'include' })).json() as
        { authenticated?: boolean; csrfToken?: string };
      if (!session.authenticated || !session.csrfToken) throw new Error('product_session_missing');
      const response = await fetch(`${origin}/api/v1/sync/conflicts/${encodeURIComponent(conflictId)}/resolution`, {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json', 'If-Match': '"conflict-r1"',
          'Known-Command-Id': crypto.randomUUID(), 'X-CSRF-Token': session.csrfToken },
        body: JSON.stringify({ resolution: 'incoming' }) });
      return { status: response.status, body: await response.text() };
    }, { origin: runtime.origin, conflictId });
  } finally { await product.goto(observerUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 }); }
  expect(result.status).toBe(200);
}
async function pushUnknownExtension(page: Page, scenarioSeed: string) {
  return page.evaluate(async ({ origin, seedValue }) => {
    const retireNamespace = 'https://known.example/extensions/sync-retire';
    const markerBytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(seedValue));
    const markerSuffix = [...new Uint8Array(markerBytes)].map((value) => value.toString(16).padStart(2, '0')).join('').slice(0, 20);
    const extensionMarker = `p3-38-extension-${markerSuffix}`;
    const authority = await chrome.storage.session.get(['known.auth.credential.v1', 'known.auth.session.v1']);
    const credential = authority['known.auth.credential.v1'] as { accessToken?: string } | undefined;
    if (!credential?.accessToken) throw new Error('unknown_extension_credential_missing');
    const storedSession = authority['known.auth.session.v1'] as { collection?: { collectionId?: unknown } } | undefined;
    const collectionId = storedSession?.collection?.collectionId;
    if (typeof collectionId !== 'string' || collectionId.length === 0) throw new Error('unknown_extension_collection_missing');
    const replicaId = `replica-${crypto.randomUUID()}`; const browserProfileId = `profile-${crypto.randomUUID()}`;
    const requestOrigin = chrome.runtime.getURL('').replace(/\/$/u, '');
    const commonHeaders = { Authorization: `Bearer ${credential.accessToken}`, 'Content-Type': 'application/json',
      'Collection-Protocol-Version': '0.2', Origin: requestOrigin };
    const config = await (await fetch(chrome.runtime.getURL('generated-config.json'), { cache: 'no-store' })).json() as
      { manifestUrl?: unknown };
    if (typeof config.manifestUrl !== 'string') throw new Error('unknown_extension_manifest_config_invalid');
    const manifestResponse = await fetch(config.manifestUrl, { redirect: 'error', cache: 'no-store', headers: {
      Accept: 'application/vnd.collection-protocol.manifest+json;version=0.2', 'Collection-Protocol-Version': '0.2' } });
    const manifest = await manifestResponse.json() as { mounts?: Array<Record<string, unknown>> };
    const retireCandidates = (manifest.mounts ?? []).flatMap((mount) => {
      const candidate = mount[retireNamespace] as { href?: unknown; method?: unknown; requestBody?: unknown;
        successStatus?: unknown } | undefined;
      return candidate?.method === 'DELETE' && candidate.requestBody === false && candidate.successStatus === 204
          && typeof candidate.href === 'string' ? [candidate.href] : [];
    });
    if (manifestResponse.status !== 200 || retireCandidates.length !== 1) throw new Error('unknown_extension_retire_manifest_invalid');
    const retireUrl = new URL(retireCandidates[0]!);
    if (retireUrl.origin !== origin || retireUrl.search || retireUrl.hash
        || retireCandidates[0]!.includes('{') || retireCandidates[0]!.includes('}')) {
      throw new Error('unknown_extension_retire_endpoint_invalid');
    }
    let sessionId: string | null = null; let retireStatus: number | null = null;
    let outcome: { status: number; resultStatus: unknown; managedWriteStatus: number; managedWriteCode: string } | null = null;
    try {
      const sessionResponse = await fetch(`${origin}/colp/v0.1/sync/sessions`, { method: 'POST', headers: {
        ...commonHeaders, 'Idempotency-Key': crypto.randomUUID() },
        body: JSON.stringify({ protocolVersion: '0.2', replica: { replicaId, name: 'Public protocol driver',
          kind: 'browser_extension', adapter: { profile: 'chromium-bookmarks-v1', version: '1.0.0' },
          capabilities: { read: true, write: true, events: true, separator: false, alias: false,
            annotations: 'sidecar', maxBatchOperations: 1 }, binding: { browserProfileId, mountMode: 'mounted-folder',
            mountNativeId: 'driver', generation: '1' } }, scope: 'collection', collection: { collectionId,
            lastCursor: null, lastRevision: null, bootstrapMode: 'download' }, clientTime: new Date().toISOString() }) });
      if (sessionResponse.status !== 201) throw new Error(`unknown_extension_session_${sessionResponse.status}`);
      const session = await sessionResponse.json() as { sessionId?: unknown };
      if (typeof session.sessionId !== 'string') throw new Error('unknown_extension_session_invalid');
      sessionId = session.sessionId;
      const snapshotResponse = await fetch(`${origin}/colp/v0.1/sync/snapshot?sessionId=${encodeURIComponent(sessionId)}&limit=200`, {
        headers: { Accept: 'application/json', Authorization: `Bearer ${credential.accessToken}`, Origin: requestOrigin,
          'Known-Sync-Session': sessionId, 'Collection-Protocol-Version': '0.2' } });
      if (snapshotResponse.status !== 200) {
        const problem = await snapshotResponse.json().catch(() => null) as { code?: unknown } | null;
        const code = typeof problem?.code === 'string' && /^[a-z_]{1,64}$/u.test(problem.code) ? problem.code : 'invalid_problem';
        throw new Error(`unknown_extension_snapshot_${snapshotResponse.status}_${code}`);
      }
      const snapshot = await snapshotResponse.json() as { collection: { id: string; rootNodeId: string; revision: string } };
      const opId = crypto.randomUUID(); const operation = { opId, replicaId, sequence: 1, collectionId: snapshot.collection.id,
        type: 'create_node', baseRevision: null, occurredAt: new Date().toISOString(), dependencies: [],
        payload: { parentId: snapshot.collection.rootNodeId, node: { kind: 'bookmark', title: 'P3-38 unknown extension',
          url: 'https://example.test/p3-38/unknown-extension', extensions: {
            'https://p3-38.unknown.invalid/extension': { marker: extensionMarker } } } } };
      const response = await fetch(`${origin}/colp/v0.1/sync/push`, { method: 'POST', headers: {
        ...commonHeaders, 'Idempotency-Key': crypto.randomUUID() },
      body: JSON.stringify({ sessionId, batchId: `${sessionId}.${crypto.randomUUID()}`, atomic: false, operations: [operation] }) });
      const body = await response.text();
      const result = JSON.parse(body) as { results?: readonly { status?: unknown }[] };
      const managedOperation = { ...operation, opId: crypto.randomUUID(), sequence: 2, payload: {
        parentId: snapshot.collection.rootNodeId, node: { kind: 'folder', title: 'P3-38 forbidden managed', folderRole: 'managed-bookmarks' } } };
      const managedResponse = await fetch(`${origin}/colp/v0.1/sync/push`, { method: 'POST', headers: {
        ...commonHeaders, 'Idempotency-Key': crypto.randomUUID() }, body: JSON.stringify({ sessionId,
        batchId: `${sessionId}.${crypto.randomUUID()}`, atomic: false, operations: [managedOperation] }) });
      const managedProblem = await managedResponse.json().catch(() => null) as { code?: unknown } | null;
      const managedWriteCode = typeof managedProblem?.code === 'string' && /^[a-z][a-z0-9_]{0,63}$/u.test(managedProblem.code)
        ? managedProblem.code : 'invalid_problem';
      outcome = { status: response.status, resultStatus: result.results?.[0]?.status,
        managedWriteStatus: managedResponse.status, managedWriteCode };
    } finally {
      if (sessionId) {
        const retireResponse = await fetch(retireUrl, { method: 'DELETE', redirect: 'error', headers: {
          Authorization: `Bearer ${credential.accessToken}`, Origin: requestOrigin, 'Known-Sync-Session': sessionId,
          'Idempotency-Key': crypto.randomUUID() } });
        retireStatus = retireResponse.status;
        if (retireStatus !== 204) throw new Error(`unknown_extension_retire_${retireStatus}`);
      }
    }
    if (!outcome || retireStatus !== 204) throw new Error('unknown_extension_protocol_driver_not_retired');
    return { ...outcome, retireStatus, retired: true, replicaId };
  }, { origin: runtime.origin, seedValue: scenarioSeed });
}
async function publicCanonicalFacts(collectionId: string, preferredHost?: Page,
  observedClientCounts?: { bootstrappedClients: number; durableClientCount: number }) {
  const pages = [...observedPages].filter((page) => !page.isClosed()); const facts = [];
  if (!observedClientCounts) for (const page of pages) facts.push(await page.evaluate(async () => {
    const binding = (await chrome.storage.local.get('known.auth.binding.v1'))['known.auth.binding.v1'];
    const session = (await chrome.storage.session.get('known.auth.session.v1'))['known.auth.session.v1'];
    return { binding, session };
  }));
  const host = preferredHost && !preferredHost.isClosed() ? preferredHost : pages[0];
  if (!host) throw new Error('public_http_observer_missing');
  if (!collectionId) throw new Error('canonical_collection_missing');
  const authority = {
    manifest: await productJson(host, '/.well-known/collection-protocol', !observedClientCounts),
    collections: await productJson(host, '/api/v1/collections?limit=100', !observedClientCounts),
    editor: await productJson(host, `/api/v1/collections/${encodeURIComponent(collectionId)}/editor?limit=200`, !observedClientCounts),
    syncStatus: await productJson(host, '/api/v1/sync/status', !observedClientCounts),
    conflicts: await productJson(host, '/api/v1/sync/conflicts?limit=100', !observedClientCounts),
  };
  return {
    manifestDigest: sha(JSON.stringify(authority.manifest)),
    bootstrappedClients: observedClientCounts?.bootstrappedClients ?? facts.filter((fact) => fact.session).length,
    durableClientCount: observedClientCounts?.durableClientCount ?? facts.length,
    canonicalResourceDigest: sha(JSON.stringify(authority)),
    canonicalResourceBytes: JSON.stringify(authority).length,
  };
}
async function assertPublicCanonicalFinalState(collectionId: string, host: Page) {
  const authority = {
    editor: await productJson(host, `/api/v1/collections/${encodeURIComponent(collectionId)}/editor?limit=200`),
    conflicts: await productJson(host, '/api/v1/sync/conflicts?limit=100'),
  };
  if (!containsJsonString(authority.editor, 'P3-38 folder')
      || !containsJsonString(authority.editor, 'P3-38 unknown extension')
      || containsJsonString(authority.editor, 'P3-38 different-field merge')
      || containsJsonString(authority.editor, 'P3-38 stale recovery candidate')
      || containsFieldValue(authority.conflicts, 'status', 'open')) {
    throw new Error('public_canonical_final_state_invalid');
  }
}
async function bindingFact(page: Page) { if (page.isClosed()) return undefined; const binding = await page.evaluate(async () =>
  (await chrome.storage.local.get('known.auth.binding.v1'))['known.auth.binding.v1']) as { replicaId?: string; generation?: string } | undefined;
  if (!binding?.replicaId) return undefined; return { identityDigest: sha(binding.replicaId), generation: Number(binding.generation ?? 1),
    status: 'active' as const, oldIdentityRejected: false }; }
async function backupBindingFact(page: Page) { if (page.isClosed()) return undefined; const binding = await page.evaluate(async () =>
  (await chrome.storage.local.get('known.auth.binding.v1'))['known.auth.binding.v1']) as
  ({ replicaId?: string; generation?: string } & Record<string, unknown>) | undefined;
  if (!binding?.replicaId) return undefined;
  return { bindingDigest: sha(JSON.stringify(binding)), identityDigest: sha(binding.replicaId),
    generation: Number(binding.generation ?? 1) }; }
async function publicReplicaFacts(preferredHost?: Page) {
  const host = preferredHost && !preferredHost.isClosed()
    ? preferredHost : [...observedPages].find((page) => !page.isClosed());
  if (host) { const status = await productJson(host, '/api/v1/sync/status') as
    { replicas?: Array<{ id?: string; status?: string }> };
    for (const replica of status.replicas ?? []) if (replica.id) { const identityDigest = sha(replica.id);
      const lifecycle = ['active', 'expired', 'recovery_required', 'retired'].includes(String(replica.status))
        ? replica.status as 'active' | 'expired' | 'recovery_required' | 'retired' : 'recovery_required';
      replicaHistory.set(identityDigest, { identityDigest, generation: 1,
        status: lifecycle, oldIdentityRejected: lifecycle === 'retired' }); }
  }
  return { replicas: [...replicaHistory.values()] };
}
async function productJson(host: Page, path: string, authenticateIfMissing = false) {
  const publicOrigin = new URL(runtime.origin); const directOrigin = new URL(runtime.origin);
  directOrigin.hostname = '127.0.0.1'; const readCookie = async () => (await host.context().cookies(runtime.origin))
    .map((value) => `${value.name}=${value.value}`).join('; ');
  let cookie = await readCookie();
  if (!cookie && authenticateIfMissing) { const observerUrl = host.url();
    try { await ensureProductSession(host); }
    finally { await host.goto(observerUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 }); }
    cookie = await readCookie(); }
  if (!cookie) throw new Error('product_cookie_missing');
  const response = await host.context().request.get(`${directOrigin.origin}${path}`, {
    timeout: 30_000, headers: { Accept: 'application/json', Host: publicOrigin.host, Cookie: cookie },
  });
  if (!response.ok()) throw new Error(`product_http_${response.status()}`);
  return response.json() as Promise<unknown>;
}
async function ensureProductSession(page: Page) {
  const sessionUrl = `${runtime.origin}/api/v1/session`;
  const current = await page.goto(sessionUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  const currentBody = current?.ok() ? await current.json().catch(() => null) as { authenticated?: unknown } | null : null;
  if (currentBody?.authenticated === true) return;
  const publicOrigin = new URL(runtime.origin); const directOrigin = new URL(runtime.origin);
  directOrigin.hostname = '127.0.0.1';
  const signIn = await page.context().request.post(`${directOrigin.origin}/api/v1/auth/sign-in/email`, {
    headers: { Host: publicOrigin.host, Origin: publicOrigin.origin, 'Content-Type': 'application/json' },
    data: { email: EXTENSION_FIXTURE_EMAIL, password: EXTENSION_FIXTURE_PASSWORD },
  });
  if (!signIn.ok()) {
    const signUp = await page.context().request.post(`${directOrigin.origin}/api/v1/auth/sign-up/email`, {
      headers: { Host: publicOrigin.host, Origin: publicOrigin.origin, 'Content-Type': 'application/json' },
      data: { email: EXTENSION_FIXTURE_EMAIL, password: EXTENSION_FIXTURE_PASSWORD, name: 'P3-38 fixture' },
    });
    if (!signUp.ok()) throw new Error(`product_auth_${signUp.status()}`);
  }
  await mirrorDirectProductCookies(page.context(), directOrigin.origin, publicOrigin.origin);
  const verified = await page.goto(sessionUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  const body = verified?.ok() ? await verified.json().catch(() => null) as { authenticated?: unknown } | null : null;
  if (body?.authenticated !== true) throw new Error(`product_session_${verified?.status() ?? 'missing'}`);
}
async function mirrorDirectProductCookies(context: BrowserContext, directOrigin: string, publicOrigin: string) {
  if ((await context.cookies(publicOrigin)).length > 0) return;
  const directCookies = await context.cookies(directOrigin);
  if (directCookies.length < 1) throw new Error('direct_product_cookie_missing');
  await context.addCookies(directCookies.map(({ domain: _domain, path: _path, ...cookie }) => ({
    ...cookie,
    url: `${publicOrigin}/`,
  })));
}
async function finishDiagnosticStage(stages: ReadonlyArray<typeof runtime.stage>, a: BrowserContext, b: BrowserContext,
  pageA: Page, pageB: Page, extra: Record<string, unknown> = {}) {
  const phase = stages.some((stage) => stage.startsWith('recovery-')) ? 'stale-recovery' : stages[0]!;
  if (runtime.mode !== 'diagnostic' || !stages.includes(runtime.stage)) {
    await markStage(phase, 'passed'); return false;
  }
  const browserVersion = b.browser()?.version();
  if (!browserVersion) throw new Error('browser_version_missing');
  const bookmarkPermissionsGranted = await Promise.all([pageA, pageB].map((page) =>
    page.evaluate(() => chrome.permissions.contains({ permissions: ['bookmarks'] }))));
  const indexedDb = runtime.stage === 'runtime-preflight'
    ? await Promise.all([pageA, pageB].map(async (page) => sha(JSON.stringify(await page.evaluate(() => indexedDB.databases())))))
    : await Promise.all([indexedDbDigest(pageA), indexedDbDigest(pageB)]);
  const observations = {
    profileIsolation: true,
    serviceWorkers: [a.serviceWorkers().length, b.serviceWorkers().length],
    bookmarkPermissionApis: await Promise.all([pageA, pageB].map((page) =>
      page.evaluate(() => typeof chrome.permissions?.contains === 'function'))),
    bookmarkPermissionsGranted,
    browserTrees: await Promise.all([pageA, pageB].map((page, index) =>
      bookmarkPermissionsGranted[index] ? bookmarkTreeDigest(page) : Promise.resolve(null))),
    indexedDb,
    ...extra,
  };
  await publishResult({ format: 'known.phase3.multi-device-recovery.browser-diagnostic.v1', schemaVersion: 1,
    accepted: false, mode: 'diagnostic', stage: runtime.stage, browserVersion, observations });
  await markStage(phase, 'passed');
  return true;
}
async function markStage(phase: string, event: 'entered' | 'passed') {
  if (!runtime.timeline) throw new Error('stage_timeline_missing');
  await appendFile(runtime.timeline, `${JSON.stringify({ at: new Date().toISOString(), source: 'browser', phase, event })}\n`,
    { encoding: 'utf8', mode: 0o600 });
}
async function publishResult(value: unknown) { if (!resultPath) throw new Error('result_path_missing');
  await writeFile(resultPath, `${JSON.stringify(value)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 }); }
async function saveScreenshot(page: Page, name: string) { if (!screenshotDirectory) throw new Error('screenshot_directory_missing');
  await mkdir(screenshotDirectory, { recursive: true }); const bytes = await page.screenshot({ path: resolve(screenshotDirectory, name), fullPage: true });
  const pixels = await page.evaluate(async (encoded) => { const binary = atob(encoded); const raw = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([raw], { type: 'image/png' })); const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext('2d'); if (!context) throw new Error('screenshot_pixel_context_missing'); context.drawImage(bitmap, 0, 0);
    const data = context.getImageData(0, 0, bitmap.width, bitmap.height).data; const colors = new Set<string>();
    for (let index = 0; index < data.length; index += Math.max(4, Math.floor(data.length / 4096 / 4) * 4)) colors.add(`${data[index]}:${data[index + 1]}:${data[index + 2]}:${data[index + 3]}`);
    return { width: bitmap.width, height: bitmap.height, distinctSampledColors: colors.size }; }, bytes.toString('base64'));
  expect(pixels.width).toBeGreaterThan(100); expect(pixels.height).toBeGreaterThan(100); expect(pixels.distinctSampledColors).toBeGreaterThan(8); }
async function assertPageRedacted(page: Page) { const surface = await page.locator('html').evaluate((element) => element.outerHTML);
  const markers = secretMarkers(seed);
  if (markers.some((marker) => surface.includes(marker))) throw new Error('screenshot_surface_marker_leak'); }
function networkRequestCount(pathname: string) { return networkLogs.reduce((count, row) => {
  try { const value = JSON.parse(row) as { kind?: unknown; url?: unknown };
    return value.kind === 'request' && typeof value.url === 'string' && new URL(value.url).pathname === pathname
      ? count + 1 : count; }
  catch { return count; }
}, 0); }
function networkRequestCounts() { return { authRequests: networkRequestCount('/oauth2/token'),
  sessionRequests: networkRequestCount('/colp/v0.1/sync/sessions') }; }
function snapshotAuthoritySource(url: URL, request: import('@playwright/test').Request) {
  const sessionId = url.searchParams.get('sessionId');
  if (!sessionId) return 'session_missing';
  const issuedAuthority = sessionAuthorityDigests.get(sha(sessionId));
  if (!issuedAuthority) return 'session_missing';
  return issuedAuthority === syncAuthorityMetadata(request).authorityDigest
    ? 'session_collection_replica' : 'session_credential';
}
