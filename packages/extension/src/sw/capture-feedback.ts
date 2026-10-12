import { isActionPopup, actionPopupIdentity, type CapturePanelRequest } from '../capture/messages.js';
import { currentCaptureScope, captureExistence, assertCaptureScope } from './capture-native.js';
import { captureStore } from './capture.js';
import { readEffectiveBookmarkPreferences } from './bookmark-preferences.js';
import { readCaptureControl } from '../capture/control.js';
import { createClassificationProductClient } from '../classification-product-client.js';
const presentations = new Map<string, { captureId: string; revision: string; earliestTimeout: number }>();

export async function handleCapturePanel(request: CapturePanelRequest, sender: chrome.runtime.MessageSender) {
  if (request.kind === 'known.capture.context') return { ok: true, actionPopup: await isActionPopup(sender) };
  const scope = await currentCaptureScope();
  if (request.kind === 'known.capture.existence') {
    const existence = await captureExistence({ scope, url: request.url }); await assertCaptureScope(scope);
    return { ok: true, existence };
  }
  const task = await captureStore.getForOwner(scope, request.captureId);
  if (request.kind === 'known.capture.feedback.adopt') {
    if (!task?.decisionId || !scope.accountId || !task.scope.collectionId) throw new Error('capture_feedback_unavailable');
    const client = createClassificationProductClient({ serverOrigin: scope.serverOrigin, expectedAuthUserId: scope.accountId, assertCurrent: () => assertCaptureScope(scope) });
    const current = await client.captureDecision(task.scope.collectionId, task.decisionId);
    if (current.feedbackRevision !== request.revision) throw new Error('feedback_conflict');
    return { ok: true, task: await captureStore.adoptFeedback(task, { revision: current.feedbackRevision, kind: current.effectiveFeedback }) };
  }
  if (!task?.decisionId || task.appliedRevision !== request.nodeRevision) throw new Error('capture_feedback_unavailable');
  const preferences = await readEffectiveBookmarkPreferences();
  if (request.kind === 'known.capture.presented') {
    const documentId = await actionPopupIdentity(sender);
    if (!documentId || task.sync !== 'confirmed') throw new Error('capture_presentation_unavailable');
    const duration = preferences.resultPanelAutoDismissMs ?? 3000;
    if (presentations.size > 100) presentations.clear();
    presentations.set(documentId, { captureId: task.captureId, revision: request.nodeRevision,
      earliestTimeout: duration === 0 ? Infinity : Date.now() + duration });
    return { ok: true };
  }
  if (request.feedback === 'implicit_positive') {
    const documentId = await actionPopupIdentity(sender);
    const shown = documentId ? presentations.get(documentId) : undefined;
    if (!shown || shown.captureId !== task.captureId || shown.revision !== task.appliedRevision
      || Date.now() < shown.earliestTimeout || !await isActionPopup(sender)) throw new Error('capture_not_presented');
    presentations.delete(documentId!);
  }
  await assertCaptureScope(scope);
  const control = await readCaptureControl(scope);
  return { ok: true, task: await captureStore.enqueueFeedback({ scope: task.scope, eventId: request.eventId, captureId: task.captureId,
    decisionId: task.decisionId, nodeRevision: request.nodeRevision, kind: request.feedback, occurredAt: Date.now(),
    learningEligible: preferences.learnFromCorrections !== false && request.feedback !== 'implicit_positive',
    evidenceGeneration: control.evidenceGeneration ?? 0, ...(request.expectedRevision === undefined ? {} : { expectedServerRevision: request.expectedRevision }), uploaded: false }) };
}
