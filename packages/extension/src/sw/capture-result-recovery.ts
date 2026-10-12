import { readCaptureControl } from '../capture/control.js';
import type { CaptureTask } from '../capture/contracts.js';
import type { CaptureStore } from '../capture/store.js';
import { createClassificationProductClient } from '../classification-product-client.js';
import { assertCaptureOwner, assertCaptureScope, currentCaptureScope } from './capture-native.js';
import { currentSyncScope } from './scope.js';
import { hasBookmarkPermission, syncState, workCoordinator } from './runtime.js';
import { resolveIngressBoundary } from '../bookmark-event-ingress.js';
import { resolveClassificationNativeFolder } from '../classification-folder.js';
import { folderIsInMount, walkAncestorIds } from '../save-folder.js';
import { scheduleSyncEngineWake } from './engine.js';
export async function inspectCaptureDecision(task: CaptureTask, ledger: CaptureStore): Promise<CaptureTask> {
  if (!task.automatic || !task.scope.accountId || !task.scope.collectionId || navigator.onLine === false || task.classification === 'applied') return task;
  const client = createClassificationProductClient({ serverOrigin: task.scope.serverOrigin, expectedAuthUserId: task.scope.accountId,
    assertCurrent: () => assertCaptureOwner(task.scope) });
  const decision = await client.findCaptureDecision(task.scope.collectionId, task.captureId);
  if (!decision || JSON.stringify(decision) === JSON.stringify(task.automatic.decision)) return task;
  const next: CaptureTask = { ...task, revision: task.revision + 1, updatedAt: Date.now(), decisionId: decision.decisionId,
    executionId: decision.executionId, automatic: { ...task.automatic, decision },
    ...(decision.status === 'applied' ? { classification: 'applied', appliedRevision: decision.nodeEtag,
      classificationAppliedAt: decision.appliedAt ? Date.parse(decision.appliedAt) : undefined, sync: 'syncing' }
      : decision.status === 'suggested' ? { classification: 'manual', reason: 'suggestion_requires_confirmation' } : {}) };
  await assertCaptureOwner(task.scope); await ledger.update(next, task.revision); return next;
}
export function applyCaptureSuggestion(task: CaptureTask, ledger: CaptureStore): Promise<CaptureTask> {
  return workCoordinator.run('classification', async () => {
    let current = await ledger.get(task.scope, task.captureId);
    const authority = await currentCaptureScope();
    await assertCaptureScope(task.scope);
    if (!current?.automatic?.decision || !current.scope.accountId || !current.scope.collectionId || !current.nativeId) throw new Error('capture_suggestion_unavailable');
    if (current.automatic.applySubmitted) {
      const inspected = await inspectCaptureDecision(current, ledger);
      if (inspected.classification === 'applied') return inspected;
      if (current.automatic.applyState === 'rejected') throw new Error('capture_suggestion_rejected');
      current = inspected;
    }
    if (!current.nativeId || !current.scope.accountId || !current.scope.collectionId || !current.automatic?.decision || current.automatic.decision.status !== 'suggested' || current.manualFence || !await hasBookmarkPermission()) throw new Error('capture_suggestion_unavailable');
    const native = (await chrome.bookmarks.get(current.nativeId))[0];
    if (!native || native.url !== current.url || native.title !== current.title || native.parentId !== current.targetNativeId) throw new Error('manually_edited');
    const scope = await currentSyncScope(), boundary = await resolveIngressBoundary(syncState, scope);
    let after = 0;
    for (;;) { const events = await syncState.listBookmarkEventsByNative(scope, current.nativeId, after, 1000);
      if (events.some(event => event.kind !== 'create' && Date.parse(event.occurredAt) >= current.createdAt)) throw new Error('manually_edited');
      if (events.length < 1000) break; after = events.at(-1)!.ordinal; }
    const target = await resolveClassificationNativeFolder(current.automatic.decision.suggestedParentId!, {
      mapping: id => syncState.getMappingByColpId(scope, id), native: async id => (await chrome.bookmarks.get(id).catch(() => []))[0],
      inScope: async id => folderIsInMount(id, await walkAncestorIds(id, async parent => (await chrome.bookmarks.get(parent))[0]?.parentId), boundary.selectedNative) });
    if (!target) throw new Error('target_not_mapped');
    const controlGeneration = (await readCaptureControl(authority)).generation;
    const pending: CaptureTask = { ...current, automatic: { ...current.automatic, applySubmitted: true, applyState: 'outcome-unknown',
      applyUserInitiated: current.automatic.applySubmitted ? current.automatic.applyUserInitiated ?? false : true },
      classification: 'running', reason: 'application_result_unknown', revision: current.revision + 1, updatedAt: Date.now() };
    await assertCaptureScope(authority); await ledger.update(pending, current.revision);
    const client = createClassificationProductClient({ serverOrigin: scope.serverOrigin, expectedAuthUserId: current.scope.accountId,
      assertCurrent: () => assertCaptureScope(authority), assertMutation: async () => {
        const latest = await ledger.get(task.scope, task.captureId), control = await readCaptureControl(authority);
        const currentNative = (await chrome.bookmarks.get(current.nativeId!))[0];
        if (!latest || latest.manualFence || control.generation !== controlGeneration || !currentNative || currentNative.parentId !== current.targetNativeId
          || currentNative.title !== current.title || currentNative.url !== current.url) throw new Error('capture_dispatch_fenced');
      } });
    let result;
    try { result = await client.applyCapture(current.scope.collectionId, current.decisionId!, current.automatic.document.controlGeneration,
      current.automatic.applyCommandId, current.automatic.document.nodeEtag, pending.automatic!.applyUserInitiated);
    } catch (error) {
      if (error instanceof Error && error.message === 'capture_dispatch_fenced') {
        const latest = await ledger.get(task.scope, task.captureId);
        if (latest?.automatic) await ledger.update({ ...latest, revision: latest.revision + 1, updatedAt: Date.now(),
          automatic: latest.automatic, classification: 'manual', reason: 'execution_control_changed' }, latest.revision);
      }
      throw error;
    }
    const applied: CaptureTask = { ...pending, revision: pending.revision + 1, updatedAt: Date.now(), classification: 'applied',
      appliedRevision: result.nodeEtag, classificationAppliedAt: Date.parse(result.appliedAt!), sync: 'syncing', reason: 'suggestion_applied_explicitly',
      automatic: { ...pending.automatic!, decision: result, applyState: 'applied' } };
    await ledger.update(applied, pending.revision); void scheduleSyncEngineWake('manual'); return applied;
  });
}
