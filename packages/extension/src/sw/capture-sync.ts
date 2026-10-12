import type { CaptureTask } from '../capture/contracts.js';
import type { CaptureStore } from '../capture/store.js';
import { nativeCaptureLocation, assertCaptureScope, currentCaptureScope } from './capture-native.js';
import { sameCaptureScope } from '../capture/contracts.js';
import { handleSaveStatus } from './save-status.js';
import { currentSyncScope } from './scope.js';
import { syncState, hasBookmarkPermission } from './runtime.js';

export async function reconcileCaptureSync(task: CaptureTask, ledger: Pick<CaptureStore, 'update' | 'get'>): Promise<CaptureTask> {
  if (task.save !== 'local-saved' || !task.nativeId) return task;
  if (!sameCaptureScope(task.scope, await currentCaptureScope())) return task;
  if (!await hasBookmarkPermission()) return { ...task, reason: 'permission_required' };
  const location = await nativeCaptureLocation(task.nativeId, task.scope).catch(() => null);
  await assertCaptureScope(task.scope);
  const status = await handleSaveStatus(task.nativeId);
  if (!status.ok) return task;
  let sync: CaptureTask['sync'] = status.localOnly ? 'local-only' : status.status.kind === 'synced' ? 'confirmed'
    : ['action-required', 'review-conflicts'].includes(status.status.kind) ? 'attention' : 'pending';
  let changedAfterClassification = false;
  if (task.classification === 'applied' && task.automatic?.decision && sync === 'confirmed') {
    const scope = await currentSyncScope();
    const mapping = await syncState.getMappingByNativeId(scope, task.nativeId);
    if (!mapping || `"${mapping.projection.revision}"` !== task.automatic.decision.nodeEtag) {
      if (task.classificationNativeConfirmedAt) changedAfterClassification = true; else sync = 'syncing';
    }
  }
  if (sync === task.sync && JSON.stringify(location) === JSON.stringify(task.localLocation) && !changedAfterClassification) return task;
  const next: CaptureTask = { ...task, sync, localLocation: location, reason: !location ? 'bookmark_deleted' : task.reason,
    ...(sync === 'confirmed' ? { syncConfirmedAt: task.syncConfirmedAt ?? Date.now() } : {}),
    ...(sync === 'confirmed' && task.classification === 'applied' && !changedAfterClassification ? { classificationNativeConfirmedAt: task.classificationNativeConfirmedAt ?? Date.now() } : {}),
    ...(changedAfterClassification ? { classification: 'manual', manualFence: task.manualFence + 1, reason: location ? 'bookmark_edited_after_classification' : 'bookmark_deleted' } : {}),
    revision: task.revision + 1, updatedAt: Date.now() };
  await assertCaptureScope(task.scope);
  try { await ledger.update(next, task.revision); return next; }
  catch (error) {
    if (error instanceof Error && error.message === 'capture_revision_conflict') return await ledger.get(task.scope, task.captureId) ?? task;
    throw error;
  }
}
