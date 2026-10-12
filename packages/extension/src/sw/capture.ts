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
import { sameCaptureScope } from '../capture/contracts.js';
import { assertCaptureOwner } from './capture-native.js';
import { transitionCapture } from '../capture/state.js';
import { localClassificationEnabled } from '../classification-local-session.js';
import { classificationTriggerReason } from '../classification-intent.js';
import { cancelRemovedCapture } from './capture-remove.js';
import { persistCaptureAnnotation } from './capture-annotation.js';
import { pinNode } from './bookmark-pins.js';
import { annotationForCaptureStart, type BookmarkAnnotationInput } from '../bookmark-annotation-store.js';

export const CAPTURE_ALARM = 'known-capture-recovery';
export const captureStore = createCaptureStore(indexedDB, () => {
  void chrome.runtime.sendMessage({ kind: 'known.capture.invalidated' }).catch(() => undefined);
});
export const captureCoordinator = createCaptureCoordinator({ store: captureStore, now: Date.now,
  assertCurrent: assertCaptureScope, existence: captureExistence, create: createNativeCapture, receipt: recoverNativeCapture,
  acknowledge: async task => {
    if (task.nativeIntentId) await createBookmarkCreatePlacementStore().acknowledge(task.nativeIntentId);
    return persistCaptureAnnotation(task, bookmark => pinNode(bookmark, true));
  } });

export async function startCapture(input: {
  readonly commandId: string; readonly source: CaptureSource; readonly url: string; readonly title: string;
  readonly parentNativeId?: string; readonly collectionId?: string; readonly insertPosition?: 'top' | 'bottom'; readonly tabId?: number; readonly batchId?: string;
  readonly saveAnother?: boolean; readonly allowUnverifiedCloud?: boolean; readonly annotation?: BookmarkAnnotationInput;
  readonly resumeNativeIds?: readonly string[];
}): Promise<CaptureTask> {
  if (!supportedCaptureUrl(input.url)) throw new Error('capture_url_unsupported');
  const annotation = annotationForCaptureStart(input.annotation, { preserveTags: true });
  if (!await hasBookmarkPermission()) throw new Error('permission_required');
  const scope = await currentCaptureScope();
  if (input.collectionId && input.collectionId !== scope.collectionId) throw new Error('capture_scope_changed');
  const preferences = await readEffectiveBookmarkPreferences();
  const control = await readCaptureControl(scope);
  const automatic = input.source !== 'batch' && input.source !== 'manual-popup' && preferences.captureMode === 'automatic';
  const { nativeId: targetNativeId, inRange } = await captureTarget(scope, input.parentNativeId);
  // Local mode files into any browser folder, so it never needs the synced range, an account or credits.
  const local = automatic && await localClassificationEnabled();
  const classify = automatic && (local || inRange && Boolean(control.consent));
  const tab = input.source === 'context-link' ? null : input.tabId !== undefined
    ? await chrome.tabs.get(input.tabId).catch(() => null) : (await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []))[0];
  const favIconUrl = tab?.url === input.url ? tab.favIconUrl : undefined;
  const now = Date.now();
  await ensurePeriodicAlarm(chrome, CAPTURE_ALARM, 1);
  const task = await captureCoordinator.start({ version: 1, captureId: crypto.randomUUID(), commandId: input.commandId,
    batchId: input.batchId ?? null, source: input.source, scope, tabId: input.tabId ?? null,
    url: input.url, title: input.title, targetNativeId, insertPosition: input.insertPosition ?? preferences.bookmarkInsertPosition,
    ...(favIconUrl ? { favIconUrl } : {}), ...(annotation ? { annotation } : {}),
    saveAnother: input.saveAnother ?? false, allowUnverifiedCloud: input.allowUnverifiedCloud ?? false,
    ...(input.resumeNativeIds ? { resumeNativeIds: [...input.resumeNativeIds] } : {}),
    createdAt: now, updatedAt: now, revision: 0, deviceId: await captureDeviceId(), policyVersion: 'capture-folder.v1', automaticIntent: automatic,
    ...(local ? { local: { commandId: null, state: 'waiting' as const } } : { billingAuthorization: control.consent }),
    disposition: 'new', save: 'unsubmitted', classification: classify ? 'waiting' : 'none', sync: inRange ? 'pending' : 'local-only', existence: null,
    nativeIntentId: null, nativeId: null, nodeId: null, executionId: null, decisionId: null,
    localLocation: null, cloudLocation: null, appliedRevision: null, manualFence: 0, controlGeneration: control.generation,
    reason: null });
  // The pre-registered alarm recovers even a crash immediately after admission.
  void resumeCapture(task).catch(() => undefined);
  return task;
}

export function resumeCapture(task: CaptureTask): Promise<CaptureTask> {
  return workCoordinator.run('local-bookmark', () => captureCoordinator.resume(task.scope, task.captureId))
    .then(saved => { if (!classificationTriggerReason({ kind: 'saved-capture', task: saved })) void classifySavedCapture(saved, captureStore).catch(() => undefined); return saved; });
}

export async function wakeCaptures(): Promise<void> {
  const scope = await currentCaptureScope();
  let before: readonly [number, string] | undefined;
  for (;;) {
    const page = await captureStore.list(scope, before);
    for (const task of page) if (task.disposition === 'new' && (['unsubmitted', 'unknown'].includes(task.save)
      || task.save === 'local-saved' && task.annotation && !task.annotationPersisted
      || (task.automaticIntent && ['waiting', 'running'].includes(task.classification)))) {
      await resumeCapture(task);
    }
    const last = page.at(-1);
    if (!last || page.length < 50) break;
    before = [last.createdAt, last.captureId];
  }
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
