import { withDestinationPolicyBoundary } from '../classification-destination-boundary.js';
import { classificationDestinationPolicy } from './classification-destination.js';
import { withSubscriptionRead } from '../bookmark-subscriptions/barrier.js';
import { personalSyncFetch } from '../personal-sync-fetch.js';
import { isSubscriptionExcluded, assertPersonalNativeAllowed } from '../bookmark-subscriptions/guards.js';
import { advanceAutomaticCapture } from '../capture/automatic.js';
import { effectiveCaptureState, readCaptureControl } from '../capture/control.js';
import type { CaptureTask } from '../capture/contracts.js';
import type { CaptureStore } from '../capture/store.js';
import { createClassificationProductClient, ClassificationProductError, isDefinitiveClassificationRejection } from '../classification-product-client.js';
import { classificationCreateReceipt } from '../classification-create-receipt.js';
import { resolveClassificationNativeFolder } from '../classification-folder.js';
import { resolveIngressBoundary } from '../bookmark-event-ingress.js';
import { folderIsInMount, walkAncestorIds } from '../save-folder.js';
import { assertCaptureScope, assertCaptureOwner, currentCaptureScope } from './capture-native.js';
import { handleBookmarkPreferencesRequest } from './bookmark-preferences.js';
import { hasBookmarkPermission, syncState, workCoordinator } from './runtime.js';
import { currentSyncScope } from './scope.js';
import { scheduleSyncEngineWake } from './engine.js';
import { captureTagMode, classifyLocalCapture, undoLocalCapture } from './capture-local.js';
import { classificationTriggerReason } from '../classification-intent.js';

export async function undoSavedCapture(task: CaptureTask, commandId: string, ledger: CaptureStore): Promise<CaptureTask> {
  if (task.local) return workCoordinator.run('local-bookmark', async () => undoLocalCapture(await ledger.get(task.scope, task.captureId) ?? task, ledger));
  return workCoordinator.run('classification', async () => {
    const authority = await currentCaptureScope(); await assertCaptureOwner(task.scope);
    const current = await ledger.get(task.scope, task.captureId);
    if (!current?.decisionId || !current.appliedRevision || !current.scope.accountId || !current.scope.collectionId) throw new Error('capture_undo_unavailable');
    if (current.undo?.completed) return current;
    const intent = current.undo ?? { commandId, ifMatch: current.appliedRevision, completed: false };
    const pending = { ...current, revision: current.revision + 1, updatedAt: Date.now(), undo: intent, manualFence: current.manualFence + 1 };
    await ledger.update(pending, current.revision);
    const client = createClassificationProductClient({ serverOrigin: current.scope.serverOrigin, expectedAuthUserId: current.scope.accountId,
      fetch: personalSyncFetch({ serverOrigin: current.scope.serverOrigin, accountId: current.scope.accountId, collectionId: current.scope.collectionId }),
      assertCurrent: () => assertCaptureScope(authority) });
    const decision = await client.undoCapture(current.scope.collectionId, current.decisionId, intent.commandId, intent.ifMatch);
    const next: CaptureTask = { ...pending, revision: pending.revision + 1, updatedAt: Date.now(), undo: { ...intent, completed: true },
      automatic: current.automatic ? { ...current.automatic, decision } : undefined,
      classification: 'manual', reason: 'classification_undone', sync: 'syncing' };
    await ledger.update(next, pending.revision); void scheduleSyncEngineWake('manual'); return next;
  });
}

export function classifySavedCapture(task: CaptureTask, ledger: CaptureStore): Promise<CaptureTask> {
  if (task.planned?.classification === 'disabled') return Promise.resolve(task);
  // Local-first: the user's own provider, same classify-and-apply semantics as the server path.
  if (task.local) return classifyLocalCapture(task, ledger);
  return workCoordinator.run('classification', async () => {
    if (classificationTriggerReason({ kind: 'saved-capture', task }) || !task.scope.accountId || !task.scope.collectionId) return task;
    const read = async () => { await assertCaptureScope(task.scope); const fresh = await ledger.get(task.scope, task.captureId);
      if (!fresh) throw new Error('capture_not_found'); return fresh; };
    try { await classificationDestinationPolicy.assertCloudSupported(); } catch (error) {
      const current = await read(), next = { ...current, classification: 'manual' as const, reason: error instanceof Error ? error.message : 'destination_policy_unresolved', revision: current.revision + 1, updatedAt: Date.now() };
      await ledger.update(next, current.revision); return next;
    }
    const client = createClassificationProductClient({ serverOrigin: task.scope.serverOrigin, expectedAuthUserId: task.scope.accountId,
      fetch: personalSyncFetch({ serverOrigin: task.scope.serverOrigin, accountId: task.scope.accountId, collectionId: task.scope.collectionId }),
      dispatch: send=>withDestinationPolicyBoundary(()=>withSubscriptionRead(async()=>{await classificationDestinationPolicy.assertCloudSupported();const current=await read();if(current.nativeId&&await isSubscriptionExcluded(current.nativeId)||current.targetNativeId&&await isSubscriptionExcluded(current.targetNativeId))throw new Error('subscription_capture_excluded');return send();})),
      assertCurrent: () => assertCaptureScope(task.scope), assertMutation: async () => {
        const current = await read(), control = await readCaptureControl(task.scope);
        if(current.nativeId)await assertPersonalNativeAllowed(current.nativeId);
        await assertPersonalNativeAllowed(current.targetNativeId);
        const preferences = await handleBookmarkPreferencesRequest({ kind: 'known.bookmark.preferences.local' });
        if (current.manualFence || control.generation !== current.controlGeneration || control.paused || control.manualOverride
          || !preferences.ok || preferences.preferences.captureMode !== 'automatic' || preferences.conflict) throw new Error('capture_dispatch_fenced');
      } });
    const authorize = async (current: CaptureTask): Promise<string | null> => {
      await assertCaptureScope(current.scope);
      const preference = await handleBookmarkPreferencesRequest({ kind: 'known.bookmark.preferences.local' });
      if (!preference.ok || preference.conflict) return 'preferences_conflict';
      const preferences = preference.preferences, control = await readCaptureControl(current.scope);
      if (control.generation !== current.controlGeneration) return 'execution_control_changed';
      if (Date.now() - current.createdAt >= 86400000) return 'authorization_expired';
      if (navigator.onLine === false) return 'offline';
      if (current.nativeId) {
        if(await isSubscriptionExcluded(current.nativeId))return 'subscription_capture_excluded';
        const [native] = await chrome.bookmarks.get(current.nativeId).catch(() => []);
        if (!native || native.url !== (current.localLocation?.url ?? current.url) || native.title !== current.title
          || native.parentId !== current.targetNativeId) return 'manually_edited';
        const scope = await currentSyncScope().catch(() => null);
        if (scope) {
          let after = 0;
          for (;;) {
            const events = await syncState.listBookmarkEventsByNative(scope, current.nativeId, after, 1000);
            // Projection echoes are filtered by ingress before this ledger. Any later
            // change/move/remove here is user work, even if the user moved it back.
            if (events.some(event => event.kind !== 'create' && Date.parse(event.occurredAt) >= current.createdAt)) return 'manually_edited';
            if (events.length < 1000) break;
            after = events.at(-1)!.ordinal;
          }
        }
      }
      if (!preferences.resumeClassificationWhenOnline && Date.now() - current.createdAt > 60000 && !current.automatic) return 'resume_disabled';
      const authorization = current.billingAuthorization;
      const preliminary = effectiveCaptureState(preferences, { ...control, consent: authorization ?? null }, {
        account: Boolean(current.scope.accountId), permission: await hasBookmarkPermission(), policy: true,
        collectionId: current.scope.collectionId, now: Date.now() });
      if (preliminary !== 'automatic') return preliminary;
      const capability = await client.captureCapabilities();
      if (capability === 'unsupported') return 'policy_unavailable';
      return capability.automaticFolderAvailable && capability.policyVersion === current.policyVersion ? null : 'policy_unavailable';
    };
    try {
      const result = await advanceAutomaticCapture({ now: Date.now, uuid: () => crypto.randomUUID(), read,
        async save(next) { await assertCaptureScope(next.scope); await ledger.update(next, next.revision - 1); }, authorize,
        async prepare(current) {
          const scope = await currentSyncScope().catch(() => null);
          if (!scope) return null;
          const receipt = current.nativeId && await classificationCreateReceipt(syncState, scope, current.nativeId, current.createdAt);
          if (!receipt || !current.billingAuthorization) return null;
          // The browser's tag preference travels with the paid intent, so a replay never changes what it asked for.
          const tagMode = await captureTagMode(false);
          return { captureId: current.captureId, nodeId: receipt.nodeId, nodeEtag: receipt.etag, policyVersion: 'capture-folder.v1',
            periodPoints: current.billingAuthorization.periodPoints, tagMode,
            controlGeneration: current.controlGeneration, billing: { priceVersion: current.billingAuthorization.priceVersion,
              maxPoints: current.billingAuthorization.maxPoints } };
        },
        async classify(intent) {
          const current = await read();
          if (await authorize(current)) throw new Error('capture_classification_paused');
          return client.classifyCapture(task.scope.collectionId!, intent.document, intent.classifyCommandId);
        },
        get: id => client.captureDecision(task.scope.collectionId!, id),
        async apply(intent) {
          const current = await read();
          if (current.manualFence || await authorize(current)) throw new Error('capture_classification_paused');
          return client.applyCapture(task.scope.collectionId!, intent.decision!.decisionId, intent.document.controlGeneration,
            intent.applyCommandId, intent.document.nodeEtag, intent.applyUserInitiated ?? false);
        },
        async mappedTarget(id) {
          const scope = await currentSyncScope(), boundary = await resolveIngressBoundary(syncState, scope);
          return Boolean(await resolveClassificationNativeFolder(id, { mapping: nodeId => syncState.getMappingByColpId(scope, nodeId),
            native: async nativeId => (await chrome.bookmarks.get(nativeId).catch(() => []))[0],
            inScope: async nativeId => !await isSubscriptionExcluded(nativeId)&&folderIsInMount(nativeId, await walkAncestorIds(nativeId,
              async parentId => (await chrome.bookmarks.get(parentId).catch(() => []))[0]?.parentId), boundary.selectedNative) }));
        },
      });
      if (result.classification === 'applied') void scheduleSyncEngineWake('manual');
      return result;
    } catch (error) {
      // A concurrent writer (sync status, another resume) won the CAS. Nothing was decided; the
      // durable intent is intact, so the next resume continues it — same rule as capture-sync.
      if (error instanceof Error && error.message === 'capture_revision_conflict') return await ledger.get(task.scope, task.captureId) ?? task;
      const current = await read();
      if (error instanceof Error && error.message === 'capture_dispatch_fenced') {
        const stopped: CaptureTask = { ...current, revision: current.revision + 1, updatedAt: Date.now(), classification: 'manual', reason: 'execution_control_changed',
          automatic: current.automatic };
        await ledger.update(stopped, current.revision); return stopped;
      }
      // A transient Product-session expiry (401 reconnect_required) is an
      // authorization change: keep the durable command identity and stay
      // recoverable so an explicit confirmation can replay it after re-auth.
      const rejected = isDefinitiveClassificationRejection(error);
      const safeRetry = error instanceof ClassificationProductError && error.sameRequestRetrySafe;
      const next = { ...current, revision: current.revision + 1, updatedAt: Date.now(),
        classification: !rejected && (current.automatic?.applySubmitted || safeRetry) ? current.classification : 'manual' as const,
        ...(rejected && current.automatic?.applySubmitted ? { automatic: { ...current.automatic, applyState: 'rejected' as const } } : {}),
        reason: !rejected && current.automatic?.applySubmitted ? 'application_result_unknown'
          : error instanceof ClassificationProductError ? error.code : 'classification_unavailable' };
      await ledger.update(next, current.revision); return next;
    }
  });
}
