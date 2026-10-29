import { assertPlannedCaptureAuthority } from '../capture/planned.js';
import { prepareCaptureContent, acknowledgeCaptureContent, moveCaptureContent } from '../capture/content-binding.js';
import { personalBookmarks } from '../bookmark-subscriptions/guards.js';
import { classificationDestinationPolicy } from './classification-destination.js';
import { createBookmarkCreatePlacementStore } from '../bookmark-create-placement.js';
import { inspectCaptureDecision, applyCaptureSuggestion } from './capture-result-recovery.js';
import { captureTarget } from './capture-target.js';
import { createClassificationProductClient } from '../classification-product-client.js';
import { createCaptureStore } from '../capture/store.js';
import { createCaptureCoordinator } from '../capture/coordinator.js';
import type { CaptureSource, CaptureTask } from '../capture/contracts.js';
import { isActionPopup, type CaptureRequest } from '../capture/messages.js';
import { supportedCaptureUrl } from '../capture/existence.js';
import { readEffectiveBookmarkPreferences } from './bookmark-preferences.js';
import { assertCaptureScope, captureExistence, createNativeCapture, currentCaptureScope, recoverNativeCapture } from './capture-native.js';
import { hasBookmarkPermission, workCoordinator } from './runtime.js';
import { ensurePeriodicAlarm } from './reconcile-alarm.js';
import { readCaptureControl } from '../capture/control.js';
import { classifySavedCapture, undoSavedCapture } from './capture-classification.js';
import { reconcileCaptureSync } from './capture-sync.js';
import { captureDeviceId } from './capture-history.js';
import { isAccountAutomation, sameCaptureScope } from '../capture/contracts.js';
import { assertCaptureOwner } from './capture-native.js';
import { transitionCapture } from '../capture/state.js';
import { localClassificationEnabled } from '../classification-local-session.js';
import { classificationTriggerReason } from '../classification-intent.js';
import { cancelRemovedCapture } from './capture-remove.js';
import { persistCaptureAnnotation } from './capture-annotation.js';
import { pinNode } from './bookmark-pins.js';
import { annotationForCaptureStart, type BookmarkAnnotationInput } from '../bookmark-annotation-store.js';
import { blockedPlacement } from '../automation/pre-save.js';
import { recordPreSaveReceipt, recoverPreSaveReceipts, rulesDecision } from './automation.js';
import { RECEIPT_MAX_AGE_MS } from '../automation/receipt-sync.js';
import { captureTagMode } from './capture-local.js';

export const CAPTURE_ALARM = 'known-capture-recovery';
export const captureStore = createCaptureStore(indexedDB, () => {
  void chrome.runtime.sendMessage({ kind: 'known.capture.invalidated' }).catch(() => undefined);
});
export const captureCoordinator = createCaptureCoordinator({ store: captureStore, now: Date.now,
  assertCurrent: (scope, task) => task?.planned ? assertPlannedCaptureAuthority(task) : assertCaptureScope(scope), existence: captureExistence, create: createNativeCapture, receipt: recoverNativeCapture,
  acknowledge: async task => {
    await acknowledgeCaptureContent(task);
    if (task.nativeIntentId && !task.planned) await createBookmarkCreatePlacementStore().acknowledge(task.nativeIntentId);
    // A rule's placement is receipted before anything is sent; a failure here must not undo the save.
    if (!task.planned) await recordPreSaveReceipt(task).catch(() => undefined);
    return persistCaptureAnnotation(task, bookmark => pinNode(bookmark, true));
  } });

export async function startCapture(input: {
  readonly commandId: string; readonly source: CaptureSource; readonly url: string; readonly title: string;
  readonly parentNativeId?: string; readonly collectionId?: string; readonly insertPosition?: 'top' | 'bottom'; readonly tabId?: number; readonly batchId?: string;
  readonly saveAnother?: boolean; readonly allowUnverifiedCloud?: boolean; readonly annotation?: BookmarkAnnotationInput;
  readonly resumeNativeIds?: readonly string[];
  /** `explicit`: the user picked this folder for this save, and no rule overrides it. Remembered and default folders are not explicit. */
  readonly aiDestinationPolicyDigest?: string;
  readonly folderChoice?: 'explicit' | 'default';
}): Promise<CaptureTask> {
  if (!supportedCaptureUrl(input.url)) throw new Error('capture_url_unsupported');
  const annotation = annotationForCaptureStart(input.annotation, { preserveTags: true });
  if (!await hasBookmarkPermission()) throw new Error('permission_required');
  const scope = await currentCaptureScope();
  if (input.collectionId && input.collectionId !== scope.collectionId) throw new Error('capture_scope_changed');
  const preferences = await readEffectiveBookmarkPreferences();
  const control = await readCaptureControl(scope);
  const automatic = input.source !== 'batch' && input.source !== 'manual-popup' && preferences.captureMode === 'automatic';
  // A save with no folder of its own (none picked, no default) goes only where a rule files it.
  const requested = await captureTarget(scope, input.parentNativeId)
    .catch((error: unknown) => { if (error instanceof Error && error.message === 'capture_target_required') return null; throw error; });
  // Rules decide before the native create, so a rule places the bookmark directly. The account's rules
  // come first; this browser's own rules decide only a page none of them matched, and pause with them (design 01 §7.5).
  const page = { url: input.url, title: input.title, parentNativeId: requested?.nativeId ?? '', explicit: input.folderChoice === 'explicit' };
  const decision = await rulesDecision(scope, page);
  const ruled = decision?.targetNativeId ? await captureTarget(scope, decision.targetNativeId).catch(() => null) : null;
  const target = ruled ?? requested;
  if (!target) throw new Error('capture_target_required');
  const automation = decision && decision.targetNativeId && !ruled ? blockedPlacement(decision.automation) : decision?.automation;
  const { nativeId: targetNativeId, inRange } = target;
  // Local mode files into any browser folder, so it never needs the synced range, an account or credits.
  const local = automatic && await localClassificationEnabled();
  // A matching rule owns the folder, whatever it decided: no model is asked for one. The user's own
  // provider may still suggest tags (`folder: false`); the cloud path does nothing.
  const classify = automatic && (automation ? local && await captureTagMode(true) !== 'off' : local || inRange && Boolean(control.consent));
  const tab = input.source === 'context-link' ? null : input.tabId !== undefined
    ? await chrome.tabs.get(input.tabId).catch(() => null) : (await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []))[0];
  const favIconUrl = tab?.url === input.url ? tab.favIconUrl : undefined;
  if (input.aiDestinationPolicyDigest) await classificationDestinationPolicy.assertAllowed(targetNativeId, input.aiDestinationPolicyDigest);
  const captureIntentId = crypto.randomUUID();
  // An explicit extra copy is an ordinary bookmark, outside the adapter's managed copy slot.
  const content = input.saveAnother ? null : await prepareCaptureContent({ captureIntentId, commandId: input.commandId, source: input.source, ...(tab?.id !== undefined ? { tabId: tab.id } : {}), url: input.url, title: input.title, parentId: targetNativeId, automatic });
  const reused = content?.nativeId ? (await chrome.bookmarks.get(content.nativeId))[0] : undefined;
  const explicitSemanticMove = reused && content && (content.mode === 'reclassify' && automation?.outcome === 'placed' || input.folderChoice === 'explicit' || input.aiDestinationPolicyDigest);
  const existingLocation = reused ? await import('./capture-native.js').then(m => m.nativeCaptureLocation(reused.id, scope)) : null;
  const now = Date.now();
  await ensurePeriodicAlarm(chrome, CAPTURE_ALARM, 1);
  const task = await captureCoordinator.start({ version: 1, captureId: content?.captureIntentId ?? captureIntentId, commandId: input.commandId,
    batchId: input.batchId ?? null, source: input.source, scope, tabId: input.tabId ?? null,
    url: reused ? content!.url : input.url, title: reused ? content!.title : input.title, targetNativeId: reused?.parentId ?? targetNativeId,
    ...(input.aiDestinationPolicyDigest ? { aiDestinationPolicyDigest: input.aiDestinationPolicyDigest } : {}),
    ...(content ? { contentIntent: { ...content, ...(explicitSemanticMove ? { desiredParentId: targetNativeId } : {}) } } : {}),
    ...(reused ? { nativeDateAdded: reused.dateAdded } : {}), insertPosition: input.insertPosition ?? preferences.bookmarkInsertPosition,
    ...(favIconUrl ? { favIconUrl } : {}), ...(annotation ? { annotation } : {}),
    saveAnother: content?.forceAnother || input.saveAnother || false, allowUnverifiedCloud: input.allowUnverifiedCloud ?? false,
    ...(input.resumeNativeIds ? { resumeNativeIds: [...input.resumeNativeIds] } : {}),
    createdAt: now, updatedAt: now, revision: 0, deviceId: await captureDeviceId(), policyVersion: 'capture-folder.v1', automaticIntent: reused && content?.mode !== 'reclassify' ? false : automatic,
    ...(!local ? { billingAuthorization: control.consent } : classify ? { local: { commandId: null, state: 'waiting' as const } } : {}),
    ...(automation ? { automation } : {}),
    disposition: reused ? 'existing' : 'new', save: reused ? 'local-saved' : 'unsubmitted', classification: classify && (!reused || content?.mode === 'reclassify') ? 'waiting' : 'none', sync: inRange ? 'pending' : 'local-only', existence: null,
    nativeIntentId: null, nativeId: reused?.id ?? null, nodeId: null, executionId: null, decisionId: null,
    localLocation: existingLocation, cloudLocation: null, appliedRevision: null, manualFence: 0, controlGeneration: control.generation,
    reason: null });
  // The pre-registered alarm recovers even a crash immediately after admission.
  void resumeCapture(task).catch(() => undefined);
  return task;
}

export function resumeCapture(task: CaptureTask): Promise<CaptureTask> {
  return workCoordinator.run('local-bookmark', () => captureCoordinator.resume(task.scope, task.captureId))
    .then(async saved => {
      if (saved.contentIntent?.desiredParentId && saved.nativeId && saved.contentIntent.desiredParentId !== saved.targetNativeId) {
        const target = saved.contentIntent.desiredParentId;
        if (saved.aiDestinationPolicyDigest) await classificationDestinationPolicy.assertAllowed(target, saved.aiDestinationPolicyDigest);
        await moveCaptureContent(saved, target, () => personalBookmarks.move(saved.nativeId!, { parentId: target }));
        const next = { ...saved, targetNativeId: target, localLocation: await import('./capture-native.js').then(m => m.nativeCaptureLocation(saved.nativeId!, saved.scope)), revision: saved.revision + 1, updatedAt: Date.now() };
        await captureStore.update(next, saved.revision); saved = next;
      }
      await acknowledgeCaptureContent(saved);
      if (!classificationTriggerReason({ kind: 'saved-capture', task: saved })) void classifySavedCapture(saved, captureStore).then(async result => { await acknowledgeCaptureContent(result); return result; }).catch(() => undefined); return saved; });
}

export async function wakeCaptures(): Promise<void> {
  const scope = await currentCaptureScope();
  const placed: CaptureTask[] = [], now = Date.now();
  let before: readonly [number, string] | undefined;
  for (;;) {
    const page = await captureStore.list(scope, before);
    // Only an account rule's placement has a receipt to recover; a browser rule's is logged when it is acknowledged.
    for (const task of page) if (isAccountAutomation(task.automation) && task.automation.outcome === 'placed' && task.save === 'local-saved'
      && task.disposition === 'new' && now - (task.savedAt ?? task.createdAt) < RECEIPT_MAX_AGE_MS) placed.push(task);
    for (const task of page) if (!task.planned && (task.disposition === 'new' || task.contentIntent?.mode === 'reclassify') && (['unsubmitted', 'unknown'].includes(task.save)
      || task.save === 'local-saved' && task.annotation && !task.annotationPersisted
      || (task.automaticIntent && ['waiting', 'running'].includes(task.classification)))) {
      await resumeCapture(task);
    }
    const last = page.at(-1);
    if (!last || page.length < 50) break;
    before = [last.createdAt, last.captureId];
  }
  // A placed save's receipt that a worker stop cut off between the save and its acknowledgement.
  await recoverPreSaveReceipts(placed).catch(() => undefined);
}

export async function handleCaptureRequest(request: CaptureRequest, sender: chrome.runtime.MessageSender) {
  if (request.kind === 'known.capture.start') {
    if (request.trigger === 'action-popup') {
      if (!await isActionPopup(sender)) throw new Error('capture_popup_required');
      const preferences = await readEffectiveBookmarkPreferences();
      if (preferences.captureMode !== 'automatic') throw new Error('capture_automatic_not_enabled');
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.url || tab.url !== request.url) throw new Error('capture_tab_changed');
      return { ok: true, task: await startCapture({ commandId: request.commandId, source: 'action-popup',
        url: tab.url, title: tab.title ?? tab.url, tabId: tab.id, allowUnverifiedCloud: request.allowUnverifiedCloud,
        ...(request.annotation ? { annotation: request.annotation } : {}) }) };
    }
    return { ok: true, task: await startCapture({ ...request, source: request.trigger }) };
  }
  const scope = await currentCaptureScope();
  if (request.kind === 'known.capture.list') { const tasks = await captureStore.listForOwner(scope, request.before); await assertCaptureOwner(scope); return { ok: true, tasks }; }
  let task = await captureStore.getForOwner(scope, request.captureId);
  if (!task) return { ok: false, error: 'capture_not_found' };
  if (request.kind === 'known.capture.report.retry') { await assertCaptureOwner(scope); await captureStore.reportFailure(task); return { ok: true, task: { ...task, reportFailure: undefined } }; }
  if (task.reason === 'feedback_conflict' && task.decisionId && scope.accountId && task.scope.collectionId && navigator.onLine !== false) {
    try {
      const client = createClassificationProductClient({ serverOrigin: scope.serverOrigin, expectedAuthUserId: scope.accountId, assertCurrent: () => assertCaptureOwner(scope) });
      const decision = await client.captureDecision(task.scope.collectionId, task.decisionId);
      task = { ...task, remoteFeedback: { revision: decision.feedbackRevision, kind: decision.effectiveFeedback } };
    } catch { /* The existing local conflict remains visible offline. */ }
  }
  if (request.kind === 'known.capture.check') {
    const receipt = task.save === 'unknown' ? await recoverNativeCapture(task) : null;
    if (!receipt) return { ok: true, task };
    const next = transitionCapture(task, { kind: 'saved', ...receipt, sync: task.scope.collectionId === scope.collectionId ? receipt.sync : task.sync }, Date.now());
    await assertCaptureOwner(scope); await captureStore.update(next, task.revision); return { ok: true, task: await resumeCapture(next) };
  }
  if (request.kind === 'known.capture.decision.check') return { ok: true, task: await inspectCaptureDecision(task, captureStore) };
  if (request.kind === 'known.capture.apply') return { ok: true, task: await applyCaptureSuggestion(task, captureStore) };
  if (request.kind === 'known.capture.remove') return { ok: true, task: await cancelRemovedCapture(task, captureStore, scope) };
  if (request.kind === 'known.capture.undo') return { ok: true, task: await undoSavedCapture(task, request.commandId, captureStore) };
  if (request.kind === 'known.capture.resume' && !sameCaptureScope(scope, task.scope)) {
    const receipt = task.save === 'unknown' ? await recoverNativeCapture(task) : null;
    if (!receipt) return { ok: true, task: { ...task, reason: 'authorization_expired' } };
    const next = transitionCapture(task, { kind: 'saved', ...receipt }, Date.now());
    await assertCaptureOwner(scope); await captureStore.update(next, task.revision); return { ok: true, task: next };
  }
  await assertCaptureOwner(scope);
  return { ok: true, task: request.kind === 'known.capture.resume' ? await resumeCapture(task) : await reconcileCaptureSync(task, captureStore) };
}

/** Internal host boundary; management/page message schemas deliberately expose no planned arguments. */
export { executePlannedSave } from '../site-adapters/planned-runtime.js';
