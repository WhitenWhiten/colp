import { reasonCode } from './push-error-code.js';
import { localized, t } from './i18n.js';
import { askResetConfirmation } from './reset-confirm-ui.js';
import { cancelPendingResetConfirmation, rebuildFailureCopy, replicaRebuildConfirmation } from './replica-rebuild-copy.js';
import type { ReplicaRebuildRequest, ReplicaRebuildResponse } from './replica-rebuild.js';

export { replicaRebuildConfirmation };
export let REBUILD_LABEL: string, REBUILD_CONFIRM_LABEL: string, REBUILD_CANCEL_LABEL: string, REBUILD_CANCEL_PENDING_LABEL: string,
  REBUILD_KEEP_PENDING_LABEL: string;
localized(() => {
  REBUILD_LABEL = t('sync_resetSyncDevice', 'Reset sync on this device');
  REBUILD_CONFIRM_LABEL = t('common_resetSync', 'Reset sync');
  REBUILD_CANCEL_LABEL = t('common_cancel', 'Cancel');
  REBUILD_CANCEL_PENDING_LABEL = t('sync_cancelPendingReset', 'Cancel pending reset');
  REBUILD_KEEP_PENDING_LABEL = t('sync_keepPendingReset', 'Keep it pending');
});

export interface ReplicaRebuildBinding {
  /** The card should be read again (a reset was cancelled, or the state it was offered for changed). */
  readonly onChanged?: () => Promise<unknown> | void;
}

/**
 * K3: "Reset sync on this device" and "Cancel pending reset" for one card. The button is shown by the card only when a
 * Reset is possible from the state (`rebuildAvailable`); pressing it previews first, so the confirmation can say which
 * kind of Reset this is, and sends nothing until it is confirmed.
 */
export function bindReplicaRebuildButton(hostId: string, binding: ReplicaRebuildBinding = {}): void {
  const button = document.getElementById(`${hostId}-rebuild`) as HTMLButtonElement | null;
  const feedback = document.getElementById(`${hostId}-feedback`);
  if (!button || !feedback) return;
  const cancelButton = document.getElementById(`${hostId}-rebuild-cancel`) as HTMLButtonElement | null;
  button.textContent = REBUILD_LABEL;
  button.addEventListener('click', () => { void rebuild(); });
  if (cancelButton) {
    cancelButton.textContent = REBUILD_CANCEL_PENDING_LABEL;
    cancelButton.addEventListener('click', () => { void cancelPending(cancelButton); });
  }
  async function send(message: ReplicaRebuildRequest): Promise<ReplicaRebuildResponse> {
    return chrome.runtime.sendMessage(message) as Promise<ReplicaRebuildResponse>;
  }
  async function rebuild(): Promise<void> {
    if (!button || !feedback || button.disabled) return;
    button.disabled = true;
    try {
      const preview = await send({ kind: 'known.scope.rebuild.preview' });
      if (!preview.ok) throw new Error(preview.code);
      if (!('preview' in preview)) throw new Error('request_invalid');
      const proceed = await askResetConfirmation(button, feedback,
        replicaRebuildConfirmation(preview.preview.queuedOperations, preview.preview.mode), { confirm: REBUILD_CONFIRM_LABEL, keep: REBUILD_CANCEL_LABEL });
      if (!proceed) return;
      const result = await send({ kind: 'known.scope.rebuild.confirm', userGesture: true,
        replicaId: preview.preview.replicaId, generation: preview.preview.generation, revision: preview.preview.revision, targetFence: preview.preview.targetFence });
      if (!result.ok) throw new Error(result.code);
      feedback.hidden = false; feedback.textContent = t('sync_syncDeviceResetBookmarks', 'Sync on this device was reset and your bookmarks were kept. Choose which folders sync, then review the merge again.');
      const url = chrome.runtime.getURL('options.html#sync');
      if (location.pathname.endsWith('/options.html')) { location.href = url; location.reload(); }
      else await chrome.tabs.create({ url });
    } catch (error) {
      feedback.hidden = false;
      feedback.textContent = rebuildFailureCopy(reasonCode(error, 'rebuild_failed'));
    } finally { button.disabled = false; }
  }
  /** W2A-02: a reset that cannot finish can be given up while nothing is archived; once archived it can only be finished. */
  async function cancelPending(target: HTMLButtonElement): Promise<void> {
    if (!feedback || target.disabled) return;
    target.disabled = true;
    let message: string;
    try {
      const proceed = await askResetConfirmation(target, feedback, cancelPendingResetConfirmation(),
        { confirm: REBUILD_CANCEL_PENDING_LABEL, keep: REBUILD_KEEP_PENDING_LABEL });
      if (!proceed) return;
      const result = await send({ kind: 'known.scope.rebuild.cancel', userGesture: true });
      if (!result.ok) throw new Error(result.code);
      message = t('sync_resetCancelled', 'The reset was cancelled. Sync on this device is as it was before.');
    } catch (error) { message = rebuildFailureCopy(reasonCode(error, 'rebuild_failed')); }
    finally { target.disabled = false; }
    // Read the card again first: it repaints its feedback line, and what happened is said last.
    await binding.onChanged?.();
    feedback.hidden = false; feedback.textContent = message;
  }
}
