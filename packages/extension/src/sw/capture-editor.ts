import { withSubscriptionRead } from '../bookmark-subscriptions/barrier.js';
import { assertPersonalNativeAllowed } from '../bookmark-subscriptions/guards.js';
import { assertPersonalCapture } from '../bookmark-subscriptions/capture-boundary.js';
import { personalBookmarks } from '../bookmark-subscriptions/guards.js';
import type { CaptureEditCancelRequest, CaptureEditRequest } from '../capture/editor.js';
import { captureStore } from './capture.js';
import { currentCaptureScope, assertCaptureScope, nativeCaptureLocation } from './capture-native.js';
import { captureIsInSyncRange } from './capture-privacy.js';
import { isDefinitiveClassificationRejection, createClassificationProductClient } from '../classification-product-client.js';
import { personalSyncFetch } from '../personal-sync-fetch.js';
import { currentSyncScope } from './scope.js';
import { syncState, workCoordinator } from './runtime.js';
import type { CaptureTask } from '../capture/contracts.js';
import { scheduleSyncEngineWake } from './engine.js';
import { readEffectiveBookmarkPreferences } from './bookmark-preferences.js';
import { readCaptureControl } from '../capture/control.js';
import { createBookmarkAnnotationStore, normalizeAnnotationEditTags } from '../bookmark-annotation-store.js';

/**
 * Terminal edit states let a later user command replace the intent. A missing
 * `state` is a legacy pending intent (older workers only persisted `completed`),
 * so it must keep blocking a different command while remaining replayable by its
 * own command id — and cancellable through `handleCaptureEditCancel`.
 */
const SUPERSEDED_EDIT_STATES = new Set<NonNullable<CaptureTask['editIntent']>['state']>(['rejected', 'cancelled']);
function supersededEditIntent(intent: NonNullable<CaptureTask['editIntent']> | undefined): boolean {
  return intent !== undefined && SUPERSEDED_EDIT_STATES.has(intent.state);
}

export function handleCaptureEdit(request: CaptureEditRequest) {
  // Mark the human fence outside the model lane so an in-flight model cannot delay it.
  return workCoordinator.run('local-bookmark', async () => {
    const scope = await currentCaptureScope();
    let current = await captureStore.getForOwner(scope, request.captureId);
    if (!current?.nativeId || current.save !== 'local-saved' || current.scope.collectionId !== scope.collectionId) throw new Error('capture_edit_unavailable');
    await assertPersonalCapture(current);await assertPersonalNativeAllowed(request.parentNativeId);
    const previous = supersededEditIntent(current.editIntent) ? undefined : current.editIntent;
    if (previous && !previous.completed && (previous.commandId !== request.commandId || previous.parentNativeId !== request.parentNativeId
      || JSON.stringify(previous.tags) !== JSON.stringify(request.tags))) throw new Error('capture_edit_pending');
    if (previous?.commandId === request.commandId && previous.completed) return { ok: true, task: current };
    const preferences = await readEffectiveBookmarkPreferences(), control = await readCaptureControl(scope);
    let intent: NonNullable<CaptureTask['editIntent']> = previous && !previous.completed ? previous : { commandId: request.commandId, parentNativeId: request.parentNativeId,
      originalParentNativeId: request.originalParentNativeId, tags: request.tags, ifMatch: current.automatic?.decision?.nodeEtag ?? null, completed: false,
      learningEligible: preferences.learnFromCorrections !== false, evidenceGeneration: control.evidenceGeneration ?? 0 };
    // Human intent fences model work immediately, but validation does not admit a command.
    const fenced: CaptureTask = { ...current, manualFence: current.manualFence + 1,
      classification: 'manual', revision: current.revision + 1, updatedAt: Date.now() };
    await captureStore.update(fenced, current.revision); current = fenced;
    const [target] = await chrome.bookmarks.get(intent.parentNativeId);
    if (!target || target.url || target.unmodifiable) throw new Error('capture_target_unavailable');
    let execute: () => Promise<import('../capture/automatic.js').AutomaticDecision | undefined>;
    const capture = current;
    const hasCloudIdentity = Boolean(current.decisionId && scope.accountId && scope.collectionId && intent.ifMatch);
    let cloudCorrection = intent.execution !== 'native' && hasCloudIdentity
      && (typeof navigator === 'undefined' || navigator.onLine !== false) && await captureIsInSyncRange(current);
    // Never reinterpret an admitted cloud command whose response was lost as a
    // different native command. Its retry keeps the original request identity.
    if (previous && !previous.completed && previous.execution !== 'native' && hasCloudIdentity && !cloudCorrection) {
      throw new Error('capture_edit_unavailable');
    }
    const syncScope = cloudCorrection ? await currentSyncScope().catch(() => null) : null;
    const mapping = syncScope ? await syncState.getMappingByNativeId(syncScope, target.id).catch(() => null) : null;
    if (cloudCorrection && (!mapping || mapping.nodeKind !== 'folder' || mapping.colpId.startsWith('pending-'))) {
      if (previous && !previous.completed) throw new Error('capture_target_not_mapped');
      cloudCorrection = false;
    }
    if (cloudCorrection && mapping) {
      const client = createClassificationProductClient({ serverOrigin: scope.serverOrigin, expectedAuthUserId: scope.accountId!,
        fetch: personalSyncFetch({ serverOrigin: scope.serverOrigin, accountId: scope.accountId!, collectionId: scope.collectionId! }),
        assertCurrent: () => assertCaptureScope(scope),dispatch:send=>withSubscriptionRead(async()=>{await assertPersonalCapture(capture);await assertPersonalNativeAllowed(intent.parentNativeId);return send();}) });
      execute = () => client.correctCapture(scope.collectionId!, capture.decisionId!,
        { parentId: mapping.colpId, tags: intent.tags, learningEligible: intent.learningEligible ?? false,
          evidenceGeneration: intent.evidenceGeneration ?? 0 }, intent.commandId, intent.ifMatch!);
    } else {
      intent = { ...intent, execution: 'native' };
      const [node] = await chrome.bookmarks.get(current.nativeId!);
      if (!node?.url || node.unmodifiable || ![intent.originalParentNativeId, intent.parentNativeId].includes(node.parentId ?? '')) throw new Error('capture_bookmark_changed');
      execute = async () => {
        await assertCaptureScope(scope);
        const annotations = createBookmarkAnnotationStore();
        try {
          const row = await annotations.get(node), base = { tags: row?.tags ?? [], note: row?.note ?? null };
          // Folder corrections carry the retained decision tags. Preserve tags
          // the user added independently in the local annotation editor.
          const decisionTags = new Set(capture.automatic?.decision?.tags ?? []);
          const inputTags = capture.decisionId ? [...base.tags.filter(tag => !decisionTags.has(tag)), ...intent.tags] : intent.tags;
          const tags = normalizeAnnotationEditTags(inputTags, base.tags);
          await withSubscriptionRead(async () => {
            await assertCaptureScope(scope); await assertPersonalNativeAllowed(node.id);
            await annotations.save(node, { tags, note: base.note }, { preserveTags: true, base });
          });
        } finally { annotations.close(); }
        if (node.parentId !== intent.parentNativeId) await personalBookmarks.move(capture.nativeId!, { parentId: intent.parentNativeId });
        return capture.automatic?.decision ?? undefined;
      };
    }
    const pending: CaptureTask = { ...current, editIntent: { ...intent, state: 'outcome-unknown' },
      revision: current.revision + 1, updatedAt: Date.now() };
    await assertCaptureScope(scope); await captureStore.update(pending, current.revision);
    let decision;
    try { decision = await execute(); }
    catch (error) {
      // Only a definitive server rejection closes an admitted command. Transport
      // failures and a transient Product-session expiry keep its identity so
      // retry cannot duplicate an unknown mutation and re-auth can replay it.
      if (isDefinitiveClassificationRejection(error)) {
        const latest = await captureStore.get(capture.scope, capture.captureId);
        if (latest) await captureStore.update({ ...latest, editIntent: { ...intent, state: 'rejected', error: error.code },
          revision: latest.revision + 1, updatedAt: Date.now() }, latest.revision);
      }
      throw error;
    }
    const latest = await captureStore.get(current.scope, current.captureId);
    if (!latest) throw new Error('capture_not_found');
    const localLocation = cloudCorrection ? latest.localLocation : await nativeCaptureLocation(latest.nativeId!, scope);
    const sync = cloudCorrection ? 'syncing' : await captureIsInSyncRange(latest) ? 'pending' : 'local-only';
    const next: CaptureTask = { ...latest, editIntent: { ...intent, completed: true, state: 'completed' }, reason: 'classification_corrected',
      ...(!cloudCorrection ? { annotationPersisted: true } : {}),
      automatic: latest.automatic && decision ? { ...latest.automatic, decision } : latest.automatic,
      ...(decision ? { feedbackKind: decision.effectiveFeedback ?? undefined, feedbackServerRevision: decision.feedbackRevision } : {}),
      revision: latest.revision + 1, updatedAt: Date.now(), sync, localLocation };
    await assertCaptureScope(scope); await captureStore.update(next, latest.revision);
    if (next.sync !== 'local-only') void scheduleSyncEngineWake('manual');
    return { ok: true, task: next };
  });
}

/**
 * Abandon an edit command whose outcome was never confirmed, so the user can
 * issue a new one. The command identity is only released on an explicit user
 * gesture naming that exact command; the durable record keeps its id and error
 * for audit. This does not touch the remote or the native tree.
 */
export function handleCaptureEditCancel(request: CaptureEditCancelRequest) {
  return workCoordinator.run('local-bookmark', async () => {
    const scope = await currentCaptureScope();
    const current = await captureStore.getForOwner(scope, request.captureId);
    if (!current || current.scope.collectionId !== scope.collectionId) throw new Error('capture_edit_unavailable');
    const intent = current.editIntent;
    if (!intent) return { ok: true, task: current };
    if (intent.commandId !== request.editCommandId) throw new Error('capture_edit_command_changed');
    if (intent.completed) return { ok: true, task: current };
    const next: CaptureTask = { ...current, editIntent: { ...intent, completed: true, state: 'cancelled', error: 'abandoned_by_user' },
      revision: current.revision + 1, updatedAt: Date.now() };
    await assertCaptureScope(scope); await captureStore.update(next, current.revision);
    return { ok: true, task: next };
  });
}
