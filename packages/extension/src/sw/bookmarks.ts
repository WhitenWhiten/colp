import { subscriptionEvent } from '../bookmark-subscriptions/events.js';
import { recordRecoveryDiagnostic } from '../recovery-diagnostic.js';
import { createBookmarkRecoveryScheduler } from './bookmark-recovery-alarm.js';
import { AuthorityFencedError } from '../authority-fence.js';
import { activeAdvancedPlan } from '../bootstrap/advanced-run.js';
import { captureWhileAdvanced } from '../bootstrap/advanced-event-capture.js';
import { createBookmarkEventQueue } from '../bookmark-event-queue.js';
import { createBookmarkListenerLifecycle, type BookmarkCaptureDisposition,
  type BookmarkCaptureEvent } from '../bookmark-listener-lifecycle.js';
import { stableCode } from '../sync-state/errors.js';
import type { SyncScope } from '../sync-state-store.js';
import { resumeActiveBatchPlans } from './batch.js';
import { scheduleSyncEngineWake } from './engine.js';
import { BOOKMARK_RECOVERY_ALARM, hasBookmarkPermission, rootScopeKey, store, sw, syncState,
  workCoordinator } from './runtime.js';
import { recoverPendingNativeSideEffects } from '../native-repair.js';
import { currentSyncScope } from './scope.js';
import { createBookmarkCreatePlacementStore } from '../bookmark-create-placement.js';
import { configuredPersonalSyncPolicy } from '../personal-sync-fetch.js';
import { collectAnnotationGarbage, retainRemovedAnnotations, restoreCreatedAnnotations } from './bookmark-annotations.js';
import { observeCreatedBookmark, observeRemovedBookmark } from './automation-observed.js';

export const bookmarkListenerLifecycle = createBookmarkListenerLifecycle({
  bookmarks: () => typeof chrome.bookmarks === 'undefined' ? undefined : chrome.bookmarks,
  capture: captureBookmarkEvent,
  // A real mutation that failed to stage durably must not wait for the next
  // browser startup: a bounded alarm re-runs the startup recover path.
  scheduleRecovery: scheduleBookmarkRecovery,
});

const recoveryScheduler = createBookmarkRecoveryScheduler({ name: BOOKMARK_RECOVERY_ALARM,
  alarms: { get: name => chrome.alarms.get(name), create: (name, info) => chrome.alarms.create(name, info) },
  storage: { get: key => chrome.storage.session.get(key), set: values => chrome.storage.session.set(values) },
});
let createPlacementStore: ReturnType<typeof createBookmarkCreatePlacementStore> | undefined;
function placementStore() { return createPlacementStore ??= createBookmarkCreatePlacementStore(); }

function scheduleBookmarkRecovery(): void {
  void recoveryScheduler.schedule().catch(() => {
    console.warn('bookmark_recovery_alarm_state_unavailable');
    // Storage/registry failure must not remove the original recovery backstop.
    try { chrome.alarms.create(BOOKMARK_RECOVERY_ALARM, { when: Date.now() + 30_000 }); }
    catch { console.warn('bookmark_recovery_alarm_unavailable'); }
  });
}

async function captureBookmarkEvent(event: BookmarkCaptureEvent): Promise<BookmarkCaptureDisposition> {
  // Notes and tags are profile-local, so they follow the bookmark whether or not it is synced or mounted.
  if (event.kind === 'removed') {
    await retainRemovedAnnotations(event).catch(() => undefined);
    await observeRemovedBookmark(event.removal).catch(() => undefined);
  }
  if (await subscriptionEvent(event)) return 'filtered';
  if (event.kind === 'created') await restoreCreatedAnnotations(event.node).catch(() => undefined);
  const advancedCaptured = await workCoordinator.run('bookmark', async () => {
    if (!await hasBookmarkPermission()) return false;
    let scope: SyncScope | undefined;
    try { scope = (__KNOWN_EXTENSION_EVIDENCE__ ? sw.eventEvidenceScope : undefined) ?? await currentSyncScope(); }
    catch { /* Ordinary capture reports disconnected. */ }
    return scope ? captureWhileAdvanced({ store: syncState, scope, api: chrome.bookmarks, event }) : false;
  }).catch((error: unknown) => { if (error instanceof AuthorityFencedError) return false; throw error; });
  if (advancedCaptured) return 'filtered';
  if (event.kind === 'children_reordered') return projectReordered(event);
  if (event.kind === 'created') {
    if (__KNOWN_EXTENSION_EVIDENCE__ && sw.eventEvidenceFault === 'before_stage') {
      sw.eventEvidenceFault = undefined;
      sw.bookmarkEventQueue = undefined;
      return Promise.reject(new Error('fault_injected'));
    }
    const outcome = await scheduleBookmarkEvent((queue) => queue.created(event.nativeId, event.node));
    // Rules may file a bookmark created outside Know-N (the star button) once it settles.
    void observeCreatedBookmark(event.nativeId, event.node).catch(() => undefined);
    return outcome;
  }
  if (event.kind === 'changed') return scheduleBookmarkEvent((queue) => queue.changed(event.nativeId, event.changes, 'callback'), true);
  if (event.kind === 'moved') return scheduleBookmarkEvent((queue) => queue.moved(event.nativeId, event.move), true);
  if (event.kind === 'reordered') return scheduleBookmarkEvent((queue) => queue.reordered(event.nativeId, event.childIds), true);
  return scheduleBookmarkEvent((queue) => queue.removed(event.nativeId, event.removal), true);
}

/**
 * SR-08: a drag is a real user edit, so it has to reach the collection. The
 * queue owns the projection write, the per-parent merge window and the honest
 * diagnostic (`uplink_staged` / `unmapped_children` / ...); this seam only
 * gates permission, scope, freeze and mount activity like every other capture.
 */
async function projectReordered(event: Extract<BookmarkCaptureEvent, { kind: 'children_reordered' }>): Promise<BookmarkCaptureDisposition> {
  return scheduleBookmarkEvent((queue) => queue.reordered(event.nativeId, event.childIds), true);
}

function scheduleBookmarkEvent(work: (queue: ReturnType<typeof createBookmarkEventQueue>) => Promise<{ readonly outcome: string }>,
  captureWhileFrozen = false): Promise<BookmarkCaptureDisposition> {
  const capture = async (): Promise<BookmarkCaptureDisposition> => {
    if (!await hasBookmarkPermission()) return 'permission_required';
    let scope: SyncScope;
    try { scope = (__KNOWN_EXTENSION_EVIDENCE__ ? sw.eventEvidenceScope : undefined) ?? await currentSyncScope({ allowStopped: true }); }
    catch { return 'not_connected'; }
    const frozen = (await syncState.getEngineState(scope))?.recoveryFrozen === true;
    // Snapshot creates have no settled identity yet. Mapped moves and reorders
    // remain durable; the queue filters projection echoes before staging them.
    // A tree scan cannot recover a same-parent reorder after its callback is lost.
    if (frozen && !captureWhileFrozen) return 'recovery_frozen';
    const paused = configuredPersonalSyncPolicy() && !await configuredPersonalSyncPolicy()!.allowed(scope);
    if (!await syncState.hasActiveMounts(scope)) return 'filtered';
    const queue = await currentBookmarkEventQueue(frozen || paused); if (!queue) return 'queue_unavailable';
    const result = await work(queue);
    if (result.outcome === 'identity_unproven') return 'recovery_frozen';
    if (!paused) {
      if (frozen) scheduleBookmarkRecovery();
      else scheduleSyncEngineWake('manual');
    }
    return result.outcome === 'filtered' ? 'filtered' : 'accepted';
  };
  return workCoordinator.run('bookmark', capture).catch((error: unknown): BookmarkCaptureDisposition => {
    if (error instanceof AuthorityFencedError) return 'not_connected';
    throw error;
  });
}

export async function currentBookmarkEventQueue(captureOnly = false) {
  if ((await store.fence.read()).revoked) {
    sw.bookmarkEventQueue = undefined;
    sw.bookmarkEventScopeKey = undefined;
    return undefined;
  }
  let scope: SyncScope;
  try { scope = (__KNOWN_EXTENSION_EVIDENCE__ ? sw.eventEvidenceScope : undefined) ?? await currentSyncScope({ allowStopped: true }); } catch { return undefined; }
  captureOnly ||= configuredPersonalSyncPolicy() !== undefined && !await configuredPersonalSyncPolicy()!.allowed(scope);
  // Freeze processing, not ingress. These drafts survive even if Pull replaces
  // the browser value before the callback finishes or the worker restarts.
  if (captureOnly) return createBookmarkEventQueue({ scope, store: syncState, api: chrome.bookmarks, autoFlush: false });
  const key = rootScopeKey(scope);
  if (!sw.bookmarkEventQueue || sw.bookmarkEventScopeKey !== key) {
    const queueFault = sw.eventEvidenceFault;
    sw.bookmarkEventQueue = createBookmarkEventQueue({ scope, store: syncState, api: chrome.bookmarks,
      resolveCreatePlacement: async (nativeId, node) => {
        if (typeof node.url !== 'string' || typeof node.parentId !== 'string' || typeof node.index !== 'number') return undefined;
        const store = placementStore();
        return store.consumeForCreated({ id: nativeId, parentId: node.parentId,
          index: node.index, title: node.title, url: node.url });
      },
      completeCreatePlacement: (intentId, nativeId) => placementStore().complete(intentId, nativeId),
      markCreatePlacementAttention: intentId => placementStore().markAttention(intentId),
      // SR-08: the merged reorder batch commits after the capture's own wake, so
      // the host owes Push one more wake once the moves are durable.
      onReorderFlushFailed: scheduleBookmarkRecovery,
      onReorderQueued: () => { void scheduleSyncEngineWake('manual').catch(() => undefined); },
      ...(__KNOWN_EXTENSION_EVIDENCE__ && queueFault && queueFault !== 'before_stage' ? { fault: queueFault } : {}) });
    sw.bookmarkEventScopeKey = key;
  }
  return sw.bookmarkEventQueue;
}

export async function recoverBookmarkEvents() {
  if (!await hasBookmarkPermission()) return;
  bookmarkListenerLifecycle.install();
  if (typeof chrome.bookmarks === 'undefined') return;
  let scope: SyncScope | undefined;
  try {
    scope = (__KNOWN_EXTENSION_EVIDENCE__ ? sw.eventEvidenceScope : undefined) ?? await currentSyncScope();
  } catch { return; }
  if (!scope) return;
  if (await activeAdvancedPlan(syncState, scope)) return;
  const queue = await currentBookmarkEventQueue();
  try { await queue?.recover(); }
  catch (error) {
    if (error instanceof Error && error.message === 'queue_recovery_frozen') return;
    throw error;
  }
}

/**
 * Recovery after a transient capture failure. Take the engine lane immediately
 * so an options status wake cannot Pull-create a second native before receipt
 * rebind. Skip the tree walk while a prior wake left pull/apply in flight.
 */
export async function recoverBookmarkEventsAfterEngineSettles(
  reason: 'startup' | 'alarm' | 'online' | 'manual' = 'manual',
) {
  await workCoordinator.run('engine', async () => {
    await bookmarkListenerLifecycle.settled();
    let repairScope: SyncScope | undefined;
    try { repairScope = (__KNOWN_EXTENSION_EVIDENCE__ ? sw.eventEvidenceScope : undefined) ?? await currentSyncScope(); }
    catch { /* No connected scope has no native repair authority. */ }
    if (repairScope) await recoverPendingNativeSideEffects(syncState, repairScope,
      typeof chrome.bookmarks === 'undefined' ? undefined : chrome.bookmarks);
    if (repairScope && !await activeAdvancedPlan(syncState, repairScope)) {
      await (await currentBookmarkEventQueue(true))?.captureMissingRemovals();
    }
    if (await treeRecoverShouldWait()) {
      // Alarm delivery is one-shot. Keep the repair request alive if this wake
      // still cannot inspect Chrome safely; a same-wake freeze has no before/
      // after edge for runSyncEngine's unfreeze reconciliation to observe.
      scheduleBookmarkRecovery(); return;
    }
    await recoverBookmarkEvents();
    await resumeActiveBatchPlans();
    await recoveryScheduler.reset().catch(() => console.warn('bookmark_recovery_retry_reset_failed'));
  }).catch(async (error: unknown) => {
    if (error instanceof AuthorityFencedError) return;
    scheduleBookmarkRecovery();
    // Never silent: this swallow used to hide a poison inbox event (F003), so a
    // failed recovery chain now leaves a bounded, durable scope signal without
    // making the fire-and-forget chain fatal.
    try {
      const scope = (__KNOWN_EXTENSION_EVIDENCE__ ? sw.eventEvidenceScope : undefined) ?? await currentSyncScope();
      await recordRecoveryDiagnostic(syncState, scope, 'bookmark_event_recovery', recoveryCode(error));
    } catch { console.warn('bookmark_recovery_scope_unavailable'); }
  });
  if (reason === 'startup' || reason === 'alarm') void collectAnnotationGarbage().catch(() => undefined);
  scheduleSyncEngineWake(reason);
}

/** Bounded, non-secret error code for the durable recovery signal. */
function recoveryCode(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  return /^[a-z][a-z0-9_:-]{0,63}$/u.test(message) ? message : stableCode(error);
}

async function treeRecoverShouldWait(): Promise<boolean> {
  try {
    const scope = (__KNOWN_EXTENSION_EVIDENCE__ ? sw.eventEvidenceScope : undefined) ?? await currentSyncScope();
    const engine = await syncState.getEngineState(scope);
    if (engine?.recoveryFrozen) return true;
    return engine?.phase === 'pulling' || engine?.phase === 'applying'
      || engine?.phase === 'bootstrap' || engine?.phase === 'recovery';
  } catch {
    return false;
  }
}

export async function resumeBookmarkEvents() {
  if (!await hasBookmarkPermission()) return;
  bookmarkListenerLifecycle.install();
  if (typeof chrome.bookmarks === 'undefined') return;
  const queue = await currentBookmarkEventQueue(); await queue?.flush();
}

/**
 * Chrome bookmark creates observed while `recoveryFrozen` are discarded
 * (`recovery_frozen`); first-run snapshot bootstrap holds that freeze until
 * the engine sleeps. Give the bootstrap a short, bounded head start so most
 * first saves upload immediately — but never hang the popup: a save that
 * proceeds while ingress is still frozen is repaired by the unfreeze
 * reconcile in runSyncEngine and still reaches the collection.
 */
export const INGRESS_OPEN_WAIT_MS = 3_000;
export async function waitUntilBookmarkIngressOpen(scope: SyncScope): Promise<void> {
  const deadline = Date.now() + INGRESS_OPEN_WAIT_MS;
  await workCoordinator.run('engine', async () => undefined).catch(() => undefined);
  while ((await syncState.getEngineState(scope))?.recoveryFrozen && Date.now() < deadline) {
    await scheduleSyncEngineWake('manual').catch(() => undefined);
    // Each wake can hit the network; pace the loop instead of hammering it.
    await new Promise<void>((resolve) => setTimeout(resolve, 500));
  }
}
