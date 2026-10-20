import { createQueueRecapture } from '../queue-recapture.js';
import { repairOwnCreateFromNative } from '../bookmark-own-create-repair.js';
import { recoverLocalSaveFreeze, recoverMappedIdentityFreeze } from '../local-save-freeze-recovery.js';
import { assertQueuedUploadAllowed } from '../queued-upload-boundary.js';
import { withSubscriptionRead } from '../bookmark-subscriptions/barrier.js';
import { assertSubscriptionUploadAllowed } from '../bookmark-subscriptions/personal-boundary.js';
import { BookmarkApiError, bookmarkApiErrorFromUnknown, classifyBookmarkApiFailure } from '../bookmark-api-error.js';
import { createSyncEffectAuthority } from '../sync-effect-authority.js';
import { configuredPersonalSyncPolicy, personalSyncNativeApi } from '../personal-sync-fetch.js';
import { refreshLocalClassificationProjection } from './classification-local-projection.js';
import { syncBrowserMetadata } from './bookmark-metadata.js';
import { replicaRebuilder } from './scope-rebuild.js';
import { AuthorityFencedError, type AuthorityContext } from '../authority-fence.js';
import { activateAdvancedPlan, activeAdvancedPlan, executeActiveAdvancedPlan,
  projectAdvancedSnapshot } from '../bootstrap/advanced-run.js';
import { loadCompleteRemoteSnapshot } from '../bootstrap/remote-snapshot.js';
import { createBookmarkImportCoordinator } from '../bookmark-import-plan.js';
import { createDurableSyncEngine } from '../durable-sync-engine.js';
import { cooldownIsPending, hasConflictBarrier, hasRecoverableQueueWork, hasRejectedBarrier,
  queueStatusProjection } from '../engine-public-stability.js';
import { kns09Paused, observeKns09EngineWake, observeKns09PushReceipt, recordKns09PermissionRevoked,
  snapshotKns09Metrics } from '../kns-09-release.js';
import { fetchSyncEndpoints } from '../manifest-client.js';
import { createOutboundPushWorker } from '../outbound-push-worker.js';
import { createChromePullBookmarkApi } from '../pull-bookmark-api.js';
import { createPullApplier } from '../pull-applier.js';
import { recoverVerifiedOrFreeze } from '../recovery-guard.js';
import { sessionMatchesCredentialAuthority, syncSessionNeedsRenewal } from '../session-client.js';
import { pullApplyAllowed } from '../scope-reconcile.js';
import type { MappingInput, QueueOperation, SyncScope } from '../sync-state-store.js';
import type { BuildConfig, StoredCredential, StoredSession, SyncEngineResponse } from '../types.js';
import { projectNativeWaits } from '../native-wait.js';
import { currentBookmarkEventQueue, bookmarkListenerLifecycle } from './bookmarks.js';
import { drainFaviconSidecarsForCurrentScope } from './favicon.js';
import { resumeRunningBootstrap } from './first-run.js';
import { hasBookmarkPermission, extensionOrigin, safeError, store, sw, syncState, workCoordinator } from './runtime.js';
import { currentSyncScope, currentSyncStatusAuthority, loadConfig, pushSessionAuthority, restoredSyncScope } from './scope.js';
import { createSyncAlarmScheduler } from '../sync-alarm.js';
import { reportReplicaHealth } from './replica-health.js';
import { readUnresolvedConsumedQueueIssues, readUnresolvedQueuePage } from '../sync-status-queue.js';

let syncAlarmScheduler: ReturnType<typeof createSyncAlarmScheduler> | undefined;

export function scheduleSyncEngineWake(reason: 'startup' | 'alarm' | 'online' | 'manual', delayMilliseconds = 0,
  connectivityRestored = false, assertTarget?: () => Promise<void>) {
  if (delayMilliseconds > 0) {
    // Chromium clamps alarms to roughly thirty seconds in MV3 service workers.
    // Keep the durable deadline aligned with that platform floor so sub-minute
    // retries do not pretend to run sooner than they can be delivered.
    syncAlarmScheduler ??= createSyncAlarmScheduler(chrome.alarms);
    return syncAlarmScheduler(delayMilliseconds);
  }
  if (reason === 'online' && connectivityRestored) {
    if (sw.confirmedOnlineWakePending && sw.coalescedOnlineWake) return sw.coalescedOnlineWake;
    sw.confirmedOnlineWakePending = true;
  }
  const operation = workCoordinator.run('engine', async (context) => {
    try { await assertTarget?.(); await runSyncEngine(reason, connectivityRestored, context); }
    finally {
      // Every pass, including one a stopped engine returns from at once, tells
      // the Sync center where this browser stands.
      void reportReplicaHealth();
      if (reason === 'online' && connectivityRestored) {
        sw.confirmedOnlineWakePending = false;
        sw.coalescedOnlineWake = undefined;
      }
    }
  }).catch((error: unknown) => {
    if (error instanceof AuthorityFencedError) return;
    throw error;
  });
  if (reason === 'online' && connectivityRestored) sw.coalescedOnlineWake = operation;
  return operation;
}

/** Drops the durable sync wake. Sign-out revokes authority, which stops an in-flight pass. */
export async function stopSyncEngine(): Promise<void> {
  await chrome.alarms.clear('known-sync-engine');
}

export async function runSyncEngine(reason: 'startup' | 'alarm' | 'online' | 'manual', connectivityRestored = false,
  context: AuthorityContext) {
  try { await store.assertWritable(context.generation); } catch { return; }
  try { await replicaRebuilder().resume(); } catch { return; }
  let scope: SyncScope; try { scope = await restoredSyncScope(); } catch { return; }
  if (configuredPersonalSyncPolicy() && !await configuredPersonalSyncPolicy()!.allowed(scope)) return;
  await syncState.prunePullHistory(scope).catch(() => undefined);
  const advanced = await activeAdvancedPlan(syncState, scope);
  if (advanced) await activateAdvancedPlan(syncState, scope, advanced);
  const recorded = await syncState.getScope(scope);
  const permissionGranted = await hasBookmarkPermission();
  if (permissionGranted) bookmarkListenerLifecycle.install();
  const hasMounts = await syncState.hasActiveMounts(scope);
  const applyAllowed = pullApplyAllowed({
    hasBookmarkPermission: permissionGranted, rootStatus: recorded?.rootStatus, hasActiveMounts: hasMounts,
  });
  const frozenBeforeWake = (await syncState.getEngineState(scope))?.recoveryFrozen === true;
  if (permissionGranted && frozenBeforeWake) {
    await recoverMappedIdentityFreeze({ scope, store: syncState, api: chrome.bookmarks,
      assertCurrent: async () => { await store.assertWritable(context.generation); } });
    await recoverLocalSaveFreeze({ scope, store: syncState, storage: chrome.storage.local, api: chrome.bookmarks,
      assertCurrent: async () => { await store.assertWritable(context.generation); } }).catch(() => undefined);
  }
  const needsRecoveryProgress = frozenBeforeWake || await snapshotRecoveryInFlight(scope);
  if (permissionGranted && needsRecoveryProgress && !advanced) {
    await bookmarkListenerLifecycle.settled();
    await (await currentBookmarkEventQueue(true))?.captureMissingRemovals();
  }
  if (!applyAllowed && !needsRecoveryProgress && !(await pendingDurableWorkFacts(scope)).hasPendingWork) return;
  let cycleAuthority: Awaited<ReturnType<typeof pushSessionAuthority>> | undefined;
  let discoveredEndpoints: Awaited<ReturnType<typeof fetchSyncEndpoints>> | undefined;
  const endpoints = async () => { discoveredEndpoints ??= await fetchSyncEndpoints(await loadConfig()); return discoveredEndpoints; };
  const sessions = { async get(forceRefresh = false) {
    await store.assertWritable(context.generation);
    cycleAuthority = await pushSessionAuthority(forceRefresh);
    return cycleAuthority; } };
  // SR-14: the Push peer asks for fresh placement facts before rebasing a
  // retried create/move, and the engine owns the only Pull path — but the worker
  // is an engine constructor argument, so the hook is late-bound. The holder is
  // assigned before the first `worker.drain(...)` below. The bootstrap and
  // apply-not-allowed drains that deliberately run without an engine wake stay
  // refresh-free (`placementRefreshEnabled`): a refresh is a real Pull that
  // projects remote facts, and those branches exist precisely to not do that
  // while an advanced plan owns the tree or apply is not allowed.
  let placementRefresh: (() => Promise<'continue' | 'recovery'>) | undefined;
  let placementRefreshEnabled = false;
  // EXT-01: the push network dispatch rides the same live-authority capability
  // as ordinary Pull, so a late Drain cannot POST under a revoked generation.
  const effects = syncEffects(scope, context);
  const assertBootstrapBoundary = (queue: QueueOperation) => assertQueuedUploadAllowed({ store: syncState, scope, queue,
    parentOf: async id => {
      const nodes = await readPermittedBookmarkApi(() => chrome.bookmarks.get(id));
      if (!nodes[0]) throw new Error('bootstrap_boundary_unavailable');
      return nodes[0].parentId;
    } });
  const worker = createOutboundPushWorker({ scope, store: syncState, endpoints, sessions, fetch: effects.fetch,
    origin: extensionOrigin(), assertUploadAllowed: assertBootstrapBoundary,
    recaptureHeld: createQueueRecapture({ store: syncState, scope, api: chrome.bookmarks, permission: hasBookmarkPermission }),
    dispatch: (queue,send) => withSubscriptionRead(async()=>{await assertSubscriptionUploadAllowed(syncState,scope,queue);await assertBootstrapBoundary(queue);return send();}),
    dispatchBatch: (rows, send) => withSubscriptionRead(async () => {
      for (const row of rows) { await assertSubscriptionUploadAllowed(syncState, scope, row); await assertBootstrapBoundary(row); }
      return send();
    }),
    readChildrenOrder: async (parentId) => (await readPermittedBookmarkApi(
      () => chrome.bookmarks.getChildren(parentId))).map((node) => node.id),
    ownerId: () => `replica:${scope.replicaId}`, schedule: (delay) => scheduleSyncEngineWake('alarm', delay),
    refreshPlacement: async () => placementRefreshEnabled
      ? (await placementRefresh?.() ?? 'continue') : 'continue',
    allowRecoveryFrozenPush: () => !placementRefreshEnabled,
    ...(__KNOWN_EXTENSION_EVIDENCE__ && sw.outboundPushFaultEvidence ? { settlementFault: sw.outboundPushFaultEvidence } : {}),
    ...(__KNOWN_EXTENSION_EVIDENCE__ && sw.outboundLeaseDurationEvidence ? { leaseDurationMilliseconds: sw.outboundLeaseDurationEvidence } : {}),
    ...(__KNOWN_EXTENSION_EVIDENCE__ && sw.outboundBoundaryEvidence ? { boundary: async (point: 'before_attempt_persist' | 'after_attempt_persist') => {
      if (point === sw.outboundBoundaryEvidence) await new Promise<void>(() => undefined);
    } } : {}),
    onTerminal: async (queue) => { observeKns09PushReceipt(scope, queue);
      if (await activeAdvancedPlan(syncState, scope)) return;
      await (await currentBookmarkEventQueue())?.flush();
      const plans = await syncState.listImportPlans(scope); const active = plans
        .filter((plan) => plan.state === 'active').sort((left, right) => right.updatedAt - left.updatedAt)[0];
      if (active) await createBookmarkImportCoordinator({ store: syncState, scope }).advance(active.planId);
    } });
  // SR-14: constructed (and the late-bound refresh assigned) before any drain so
  // no drain path can observe an unassigned hook. Construction is side-effect
  // free: the engine only performs network/persistence work inside `wake`.
  const applier = () => { if (!cycleAuthority || !discoveredEndpoints) throw new Error('sync_authority_unavailable');
    return createPullApplier({ scope, store: syncState, api: effects.api, fetch: effects.fetch, assertCurrent: effects.assertCurrent, session: { acceptedProtocolVersion: '0.2',
      sessionId: cycleAuthority.session.sessionId, collectionId: scope.collectionId,
      conversionPolicy: cycleAuthority.session.conversionPolicy,
      transportBudget: cycleAuthority.session.transportBudget }, effectPageTemplate: discoveredEndpoints.syncEffectPages,
      effectPageAuthority: discoveredEndpoints.effectPageAuthority, endpoints: discoveredEndpoints,
      credential: cycleAuthority.credential, origin: extensionOrigin(), settleNativeEvents: async () => {
        await new Promise<void>(resolve => setTimeout(resolve, 0));
        await bookmarkListenerLifecycle.settled();
      }, repairOwnCreate: async (mapping, parent) => {
        const queue = await currentBookmarkEventQueue(true); if (!queue) return;
        await repairOwnCreateFromNative(queue, id => readPermittedBookmarkApi(() => chrome.bookmarks.get(id)), mapping, parent);
      } }); };
  const engine = createDurableSyncEngine({ scope, store: syncState, endpoints, sessions, fetch: effects.fetch,
    origin: extensionOrigin(),
    pullApplier: { stage: (page, cursorAuthority) => effects.run(() => applier().stage(page, cursorAuthority)),
      resume: (mode) => effects.run(() => applier().resume(mode)) }, pushWorker: worker,
    schedule: (delay) => scheduleSyncEngineWake('alarm', delay), snapshotProjector: (staged, mode) => projectSnapshotNode(scope, context, staged, mode) });
  placementRefresh = () => engine.refreshPlacement();
  const bootstrapComplete = advanced && !frozenBeforeWake
    && (await syncState.listAckIntents(scope)).some((intent) => intent.kind === 'bootstrap' && intent.state === 'complete'
      && intent.cursor === advanced.metadata.remoteCursor)
    && !await syncState.getPendingAckIntent(scope);
  if (bootstrapComplete) {
    if (!permissionGranted || advanced.state === 'attention') return;
    if (await kns09Paused('coordinator')) { await worker.drain(); return; }
    let delay = 1_000;
    try {
      const refreshRemoteFacts = async () => {
        const authority = await sessions.get();
        return (await loadCompleteRemoteSnapshot({ endpoint: (await endpoints()).syncSnapshot,
          credential: authority.credential, session: authority.session, scope, origin: extensionOrigin(), fetcher: effects.fetch })).remoteFacts;
      };
      const assertAuthority = effects.assertCurrent;
      const native = await personalSyncNativeApi(scope, chrome.bookmarks);
      await executeActiveAdvancedPlan(syncState, scope, native, refreshRemoteFacts, assertAuthority);
      await worker.drain();
      await executeActiveAdvancedPlan(syncState, scope, native, refreshRemoteFacts, assertAuthority);
      if (!await activeAdvancedPlan(syncState, scope)) await (await currentBookmarkEventQueue())?.recover();
    } catch (error) {
      if (error instanceof AuthorityFencedError) return;
      const code = safeError(error); delay = 30_000;
      const run = (await syncState.listBootstrapRuns(scope)).find((row) => row.runId === advanced.planId);
      if (run) await syncState.putBootstrapRun(scope, { ...run, retryReason: code, updatedAt: Date.now() });
    }
    chrome.alarms.create('known-sync-engine', { when: Date.now() + delay });
    return;
  }
  if (!applyAllowed && !needsRecoveryProgress) {
    try {
      await worker.drain();
      if (await resumeRunningBootstrap(scope)) scheduleSyncEngineWake('manual');
    }
    catch (error) {
      if (error instanceof AuthorityFencedError) return;
      await markImportEngineRecovery(scope, safeError(error));
      chrome.alarms.create('known-sync-engine', { when: Date.now() + 30_000 });
    }
    return;
  }
  placementRefreshEnabled = true;
  try {
    // The durable engine resumes owned local projection before network work.
    // Pull resolves endpoints before constructing/resuming the bound applier.
    const result = await engine.wake(reason, { connectivityRestored });
    // The backlog age comes from the same live-status scan the facts use: a
    // `listQueue` default page returns the OLDEST 100 rows, so on a long-lived
    // scope it measured terminal history and reported ages that grew without
    // bound, while a short-lived scope reported null.
    const pending = await pendingDurableWorkFacts(scope);
    const engineState = await syncState.getEngineState(scope);
    observeKns09EngineWake({
      scope, frozenBefore: frozenBeforeWake, frozenAfter: result?.recoveryFrozen === true,
      pendingCount: pending.hasPendingWork ? 1 : 0,
      backlogAgeMs: pending.oldestLiveOccurredAt === null ? null
        : Math.max(0, Date.now() - pending.oldestLiveOccurredAt),
      lastError: engineState?.lastError,
    });
    await syncState.putScopeDiagnostic(scope, { kind: 'kns09', code: 'metrics',
      details: snapshotKns09Metrics() as unknown as import('../sync-state-store.js').JsonObject });
    if (result && !result.recoveryFrozen && result.phase !== 'error') {
      bookmarkListenerLifecycle.install();
      if (await activeAdvancedPlan(syncState, scope)) {
        scheduleSyncEngineWake('manual');
        return;
      }
      // Captures observed while the engine held recoveryFrozen were discarded
      // (e.g. a popup save during first-run bootstrap). When THIS wake lifted
      // the freeze, reconcile the native tree once to repair them. On an
      // ordinary unfrozen wake keep the cheap flush: pull projection
      // callbacks are already captured by the listener, and a full tree
      // reconciliation there can observe Chrome's pre-projection snapshot
      // and manufacture a local rollback operation.
      const eventQueue = await currentBookmarkEventQueue();
      if (frozenBeforeWake) await eventQueue?.recover();
      else await eventQueue?.flush();
      const plans = await syncState.listImportPlans(scope); const latest = plans.sort((a, b) => b.updatedAt - a.updatedAt)[0];
      if (latest?.state === 'active') { const view = await createBookmarkImportCoordinator({ store: syncState, scope }).advance(latest.planId);
        if (view.progress.queued > 0) scheduleSyncEngineWake('manual'); }
      if (await resumeRunningBootstrap(scope)) scheduleSyncEngineWake('manual');
      await drainFaviconSidecarsForCurrentScope();
      const descriptions=await syncBrowserMetadata(scope,context,!result.lastError).catch(()=>({staged:0,needsSnapshot:false}));
      if(!result.lastError)await refreshLocalClassificationProjection(scope,context,async classificationProjection=>{
        const authority=await sessions.get();return loadCompleteRemoteSnapshot({endpoint:(await endpoints()).syncSnapshot,credential:authority.credential,
          session:authority.session,scope,origin:extensionOrigin(),fetcher:effects.fetch,
          signal:classificationProjection?AbortSignal.any([context.signal,AbortSignal.timeout(20000)]):context.signal,classificationProjection});
      },descriptions.needsSnapshot);
      if(descriptions.needsSnapshot&&!result.lastError)await syncBrowserMetadata(scope,context,false);
      // The flush above can commit captured events into the outbound queue after
      // the push phase already ran. Wake once more for never-attempted work so a
      // popup save uploads immediately instead of waiting for the next alarm.
      // Queue rows are never pruned, so page by sequence: a single bounded page
      // stops seeing fresh work once the scope accumulates terminal history.
      if (!result.lastError && await hasNeverAttemptedQueueWork(scope)) scheduleSyncEngineWake('manual');
    } }
  catch (error) {
    if (error instanceof AuthorityFencedError) return;
    await markImportEngineRecovery(scope, safeError(error));
    chrome.alarms.create('known-sync-engine', { when: Date.now() + 30_000 }); }
  finally { if (__KNOWN_EXTENSION_EVIDENCE__) sw.outboundPushFaultEvidence = undefined; }
}

async function snapshotRecoveryInFlight(scope: SyncScope): Promise<boolean> {
  const engine = await syncState.getEngineState(scope);
  return engine?.phase === 'bootstrap' || engine?.phase === 'recovery'
    || engine?.authorityRefreshRequired === true
    || await syncState.hasRecoveryStaging(scope)
    || (await syncState.getPendingAckIntent(scope))?.kind === 'bootstrap';
}

async function hasNeverAttemptedQueueWork(scope: SyncScope): Promise<boolean> {
  let after = 0;
  for (;;) {
    const page = await syncState.listQueue(scope, 'pending', after, 1_000);
    if (page.some((row) => row.retry.attempt === 0)) return true;
    if (page.length < 1_000) return false;
    after = page.at(-1)!.sequence;
  }
}

async function markImportEngineRecovery(scope: SyncScope, code: string) {
  const recovery = code === 'permission_required' ? 'permission_required' as const
    : code === 'session_expired' || code === 'credential_revoked' || code === 'invalid_grant'
      ? 'session_expired' as const : null;
  if (!recovery) return; const plans = await syncState.listImportPlans(scope);
  const plan = plans.filter((item) => item.state === 'active').sort((a, b) => b.updatedAt - a.updatedAt)[0];
  if (!plan) return; const nodes = await syncState.listImportNodes(scope, plan.planId);
  const queue: QueueOperation[] = [];
  for (const status of ['pending', 'claimed', 'deferred', 'gap', 'blocked', 'unknown', 'set_aside'] as const) {
    let after = 0;
    while (true) {
      const page = await syncState.listQueue(scope, status, after, 1_000);
      queue.push(...page);
      if (page.length < 1_000) break;
      after = page.at(-1)!.sequence;
    }
  }
  const queued = new Map(queue.map((item) => [item.opId, item]));
  const affected = nodes.find((node) => node.choice === 'import' && queued.get(node.opId)?.status !== 'terminal');
  if (affected) await createBookmarkImportCoordinator({ store: syncState, scope }).recordRecovery(plan.planId, affected.opId, recovery);
}

function syncEffects(scope: SyncScope, context: AuthorityContext) {
  const chromeApi = createChromePullBookmarkApi();
  return createSyncEffectAuthority({ scope, context, api: {
    ...chromeApi,
    get: (id) => readPermittedBookmarkApi(() => chromeApi.get(id)),
    getChildren: (id) => readPermittedBookmarkApi(() => chromeApi.getChildren(id)),
  }, assertWritable: generation => store.assertWritable(generation), currentScope: currentSyncScope });
}

/**
 * Native reads check permission before the call and again if the call fails, so a revoke in
 * that gap is `permission_required` rather than a missing bookmark or an unknown result to recreate.
 */
export async function readPermittedBookmarkApi<T>(read: () => Promise<T>): Promise<T> {
  if (!await hasBookmarkPermission()) throw new BookmarkApiError('permission_denied', 'permission_required');
  try {
    const result = await read();
    if (!await hasBookmarkPermission()) throw new BookmarkApiError('permission_denied', 'permission_required');
    return result;
  } catch (error) {
    if (error instanceof BookmarkApiError && error.failureClass === 'permission_denied') throw error;
    if (!await hasBookmarkPermission() || classifyBookmarkApiFailure(error) === 'permission_denied') {
      throw new BookmarkApiError('permission_denied', 'permission_required');
    }
    throw error instanceof BookmarkApiError ? error : bookmarkApiErrorFromUnknown(error);
  }
}

const bookmarkPermissionRemovedPorts = new WeakSet<object>();

function onBookmarkPermissionRemoved(change: { permissions?: string[] }): void {
  if (!change.permissions?.includes('bookmarks')) return;
  void pauseBookmarkSyncForPermissionLoss();
}

/** Temporary bookmark-permission loss pauses sync. It does not retire the scope or its queue. */
export function installBookmarkPermissionRemovedListener(): void {
  if (typeof chrome === 'undefined') return;
  const port = chrome.permissions?.onRemoved;
  if (!port?.addListener || bookmarkPermissionRemovedPorts.has(port)) return;
  bookmarkPermissionRemovedPorts.add(port);
  port.addListener(onBookmarkPermissionRemoved);
}

async function pauseBookmarkSyncForPermissionLoss(): Promise<void> {
  try {
    if (await hasBookmarkPermission()) return;
    const scope = await currentSyncScope();
    const recorded = await syncState.getScope(scope);
    if (!recorded) return;
    if (recorded.rootStatus === 'ready') recordKns09PermissionRevoked(scope);
    await syncState.setBrowserRootStatus(scope, 'permission_required');
  } catch { /* the browser event must not reject; the next native read pauses the same way */ }
}

installBookmarkPermissionRemovedListener();

async function projectSnapshotNode(scope: SyncScope, context: AuthorityContext,
  staged: readonly MappingInput[], mode?: { readonly recoveryOnly?: boolean }): Promise<readonly MappingInput[]> {
  const { assertCurrent, api } = syncEffects(scope, context);
  await assertCurrent();
  const advanced = mode?.recoveryOnly ? undefined : await projectAdvancedSnapshot(syncState, scope, staged);
  await assertCurrent();
  if (advanced) return advanced;
  const projected = await recoverVerifiedOrFreeze({
    scope, store: syncState, staged, freezeUnprovenIdentity: true, recoveryOnly: mode?.recoveryOnly,
    api,
  });
  await assertCurrent();
  return projected;
}

/** The statuses scanned; one page of unresolved rows each, ordered by sequence. */
const LIVE_QUEUE_STATUSES = ['pending', 'claimed', 'deferred', 'gap', 'blocked', 'unknown', 'rejected', 'set_aside'] as const;

async function pendingDurableWorkFacts(scope: SyncScope) {
  let hasPendingWork = Boolean(await syncState.getPendingAckIntent(scope));
  let conflictPending = false;
  let rejectedPending = false;
  let oldestLiveOccurredAt: number | null = null;
  const live: Array<{ readonly status?: string; readonly recovery?: { readonly code?: string } }> = [];
  for (const status of LIVE_QUEUE_STATUSES) {
    const rows = await readUnresolvedQueuePage(syncState, scope, status);
    live.push(...rows);
    hasPendingWork ||= hasRecoverableQueueWork(rows);
    conflictPending ||= hasConflictBarrier(rows);
    rejectedPending ||= hasRejectedBarrier(rows);
    // `listQueue` is ordered by sequence, so the oldest live row of each status
    // is the first one; the earliest across statuses is the backlog head.
    //
    // `rejected` is scanned because it is a barrier the UI must surface, but it
    // is NOT backlog: `hasRecoverableQueueWork` excludes it, and a rejected row
    // is never retried. Counting it here made the age of one permanently
    // rejected row grow without bound, which is the opposite of what a backlog
    // metric is for.
    for (const row of rows) {
      if (row.status === 'rejected' || row.status === 'set_aside') continue;
      const occurredAt = Date.parse(String(row.payload.occurredAt));
      if (!Number.isFinite(occurredAt)) continue;
      oldestLiveOccurredAt = oldestLiveOccurredAt === null ? occurredAt : Math.min(oldestLiveOccurredAt, occurredAt);
    }
  }
  // Terminal means the sequence was consumed, not that the user's edit was
  // accepted. Keep that business refusal visible without calling it backlog.
  if ((await syncState.getScope(scope))?.lifecycle === 'active') {
    const consumed = await readUnresolvedConsumedQueueIssues(syncState, scope);
    live.push(...consumed); rejectedPending ||= hasRejectedBarrier(consumed);
  }
  return { hasPendingWork, conflictPending, rejectedPending, oldestLiveOccurredAt,
    queueProjection: queueStatusProjection(live) };
}

export async function publicSyncEngineState(scope: SyncScope, credential: StoredCredential, session: StoredSession,
  config: BuildConfig) {
  const [value, recorded, pendingWork, bookmarkPermissionGranted, nativeWaits] = await Promise.all([
    syncState.getEngineState(scope), syncState.getScope(scope), pendingDurableWorkFacts(scope), hasBookmarkPermission(),
    projectNativeWaits(syncState, scope).catch(() => []),
  ]);
  const nativeWaitPending = nativeWaits.length > 0;
  const { hasPendingWork, conflictPending, rejectedPending, queueProjection } = pendingWork;
  const scopeKey = value?.scopeKey ?? recorded?.scopeKey ?? JSON.stringify([
    scope.environment, scope.serverId, scope.serverOrigin, scope.accountId,
    scope.browserProfileId, scope.collectionId, scope.replicaId, scope.generation]);
  const credentialReady = credential.subject === scope.accountId
    && credential.serverOrigin === config.serverOrigin
    && credential.issuer === config.issuer && credential.audience === config.audience
    && credential.clientId === config.clientId && config.scopes.every((required) => credential.scope.includes(required))
    && credential.expiresAt - Date.now() > config.refreshBeforeExpirySeconds * 1_000;
  const sessionReady = credentialReady && session.collection.collectionId === scope.collectionId
    && session.scope === 'collection' && session.acceptedProtocolVersion === '0.2'
    && !syncSessionNeedsRenewal(session) && await sessionMatchesCredentialAuthority(session, credential);
  const authorityFacts = { cooldownPending: cooldownIsPending({ now: Date.now(), sessionNotBefore: sw.sessionRetryNotBefore,
      errorCode: value?.lastError, engineNotBefore: value?.notBefore ?? 0 }),
    engineWakeInFlight: workCoordinator.hasInFlight('engine'),
    authorityRefreshInFlight: workCoordinator.hasInFlight('auth') || workCoordinator.hasInFlight('session'),
    credentialReady, sessionReady, hasPendingWork: hasPendingWork || nativeWaitPending, conflictPending, rejectedPending, queueProjection };
  const bookmarkIngressStatus = bookmarkListenerLifecycle.status();
  const bookmarkIngress = { ...bookmarkIngressStatus,
    listenerInstalled: bookmarkPermissionGranted && bookmarkIngressStatus.listenerInstalled };
  if (!value) return { phase: 'idle' as const, recoveryFrozen: false,
    authorityRefreshRequired: false, hasPublishedCursor: false, hasPushServerCursor: false,
    cursorsConverged: false, ...authorityFacts, ...bookmarkIngress,
    scopeKey, nativeWaitPending };
  return { phase: value.phase, recoveryFrozen: value.recoveryFrozen,
    authorityRefreshRequired: value.authorityRefreshRequired,
    hasPublishedCursor: typeof value.lastPublishedCursor === 'string',
    hasPushServerCursor: typeof value.lastPushServerCursor === 'string',
    cursorsConverged: typeof value.lastPublishedCursor === 'string'
      && value.lastPublishedCursor === value.lastAckedCursor,
    ...authorityFacts, ...bookmarkIngress, scopeKey, nativeWaitPending,
    ...(value.lastError ? { errorCode: value.lastError } : {}) };
}

export async function handleSyncEngineRequest(): Promise<SyncEngineResponse> {
  try { const authority = await currentSyncStatusAuthority();
    return { ok: true, engine: await publicSyncEngineState(authority.scope, authority.credential,
      authority.session, authority.config) }; }
  catch (error) { return { ok: false, error: error instanceof Error && error.message === 'state_unavailable'
    ? 'state_unavailable' : 'not_connected' }; }
}
