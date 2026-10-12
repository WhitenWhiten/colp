import type { CaptureExistence, CaptureLocation, CaptureTask, SyncState } from './contracts.js';

export type CaptureEvent =
  | { readonly kind: 'existence'; readonly result: CaptureExistence; readonly saveAnother: boolean }
  | { readonly kind: 'submitted'; readonly intentId: string }
  | { readonly kind: 'saved'; readonly nativeId: string; readonly location: CaptureLocation; readonly sync: SyncState; readonly savedAt?: number }
  | { readonly kind: 'save-failed'; readonly reason: string }
  | { readonly kind: 'classifying'; readonly executionId: string; readonly controlGeneration: number }
  | { readonly kind: 'applied'; readonly decisionId: string; readonly revision: string;
      readonly location: CaptureLocation; readonly manualFence: number; readonly controlGeneration: number }
  | { readonly kind: 'deferred'; readonly reason: string }
  | { readonly kind: 'manual-edit' }
  | { readonly kind: 'sync'; readonly state: SyncState; readonly location?: CaptureLocation }
  | { readonly kind: 'cancelled' };

/** Unknown native outcomes can only leave via a proven receipt, never a second create. */
export function transitionCapture(task: CaptureTask, event: CaptureEvent, now: number): CaptureTask {
  const patch = (): Partial<CaptureTask> => {
    switch (event.kind) {
      case 'existence':
        if (task.save !== 'unsubmitted') throw new Error('capture_already_submitted');
        return { existence: event.result, disposition: event.result.exact.length && !event.saveAnother ? 'existing' : 'new' };
      case 'submitted':
        if (task.save !== 'unsubmitted' || task.disposition !== 'new') throw new Error('capture_create_forbidden');
        return { nativeIntentId: event.intentId, save: 'unknown' };
      case 'saved':
        if (task.save !== 'unknown' && task.save !== 'local-saved') throw new Error('capture_receipt_without_intent');
        if (task.nativeId && task.nativeId !== event.nativeId) throw new Error('capture_receipt_conflict');
        return { save: 'local-saved', savedAt: task.savedAt ?? event.savedAt ?? now, nativeId: event.nativeId, localLocation: event.location, sync: event.sync, reason: null };
      case 'save-failed':
        if (task.save !== 'unsubmitted') throw new Error('capture_unknown_requires_reconciliation');
        return { save: 'failed', reason: event.reason };
      case 'classifying':
        if (task.save !== 'local-saved' || !task.automaticIntent || task.manualFence
          || task.executionId || event.controlGeneration !== task.controlGeneration) throw new Error('capture_classification_forbidden');
        return { classification: 'running', executionId: event.executionId };
      case 'applied':
        if (task.classification !== 'running' || task.manualFence !== event.manualFence
          || task.manualFence !== 0 || task.controlGeneration !== event.controlGeneration
          || !event.location.writable || event.location.collectionId !== task.scope.collectionId) {
          throw new Error('capture_apply_forbidden');
        }
        return { classification: 'applied', decisionId: event.decisionId, appliedRevision: event.revision,
          cloudLocation: event.location, nodeId: event.location.nodeId, sync: 'syncing', reason: null };
      case 'deferred': return { classification: 'manual', reason: event.reason };
      case 'manual-edit': return { manualFence: task.manualFence + 1, classification: 'manual' };
      case 'sync': return { sync: event.state, ...(event.location ? { localLocation: event.location } : {}) };
      case 'cancelled':
        // Before submission nothing was written; after a local save the user took the bookmark back out.
        if (task.save !== 'unsubmitted' && task.save !== 'local-saved') throw new Error('capture_already_submitted');
        return { disposition: 'cancelled' };
    }
  };
  return { ...task, ...patch(), revision: task.revision + 1, updatedAt: now };
}
