import { reasonCode } from './push-error-code.js';
import { localized, t, tn } from './i18n.js';
import type { ReplicaRebuildRequest, ReplicaRebuildResponse } from './replica-rebuild.js';

export let REBUILD_LABEL: string, REBUILD_CONFIRM_LABEL: string, REBUILD_CANCEL_LABEL: string;
localized(() => {
  REBUILD_LABEL = t('sync_resetSyncDevice', 'Reset sync on this device');
  REBUILD_CONFIRM_LABEL = t('common_resetSync', 'Reset sync');
  REBUILD_CANCEL_LABEL = t('common_cancel', 'Cancel');
});
export function replicaRebuildConfirmation(queuedOperations: number): string {
  if (queuedOperations === 0) return t('sync_rebuildConfirm', "Your bookmarks stay on this device and in your library. Afterwards you'll choose which folders sync and review the merge again. Reset sync now?");
  return t('sync_rebuildConfirmSetAside', "Your bookmarks stay on this device and in your library. $1 Afterwards you'll choose which folders sync and review the merge again. Reset sync now?",
    tn('sync_rebuildSetAside', queuedOperations, '$1 change that has not synced yet will be set aside and not retried.', '$1 changes that have not synced yet will be set aside and not retried.'));
}

export function bindReplicaRebuildButton(hostId: string): void {
  const button = document.getElementById(`${hostId}-rebuild`) as HTMLButtonElement | null;
  const feedback = document.getElementById(`${hostId}-feedback`);
  if (!button || !feedback) return;
  button.textContent = REBUILD_LABEL;
  button.addEventListener('click', () => { void rebuild(); });
  async function send(message: ReplicaRebuildRequest): Promise<ReplicaRebuildResponse> {
    return chrome.runtime.sendMessage(message) as Promise<ReplicaRebuildResponse>;
  }
  function askConfirmation(hostButton: HTMLButtonElement, feedbackElement: HTMLElement, question: string): Promise<boolean> {
    return new Promise((resolve) => {
      const strip = document.createElement('div'); strip.className = 'rebuild-confirm';
      const copy = document.createElement('p'); copy.className = 'rebuild-confirm-copy'; copy.textContent = question;
      const actions = document.createElement('div'); actions.className = 'row-actions';
      const confirmButton = document.createElement('button'); confirmButton.type = 'button';
      confirmButton.className = 'btn btn-danger btn-sm'; confirmButton.textContent = REBUILD_CONFIRM_LABEL;
      const cancelButton = document.createElement('button'); cancelButton.type = 'button';
      cancelButton.className = 'btn btn-ghost btn-sm'; cancelButton.textContent = REBUILD_CANCEL_LABEL;
      const settle = (proceed: boolean) => { strip.remove(); if (!proceed) hostButton.focus(); resolve(proceed); };
      confirmButton.addEventListener('click', () => settle(true));
      cancelButton.addEventListener('click', () => settle(false));
      strip.addEventListener('keydown', (event) => { if (event.key === 'Escape') settle(false); });
      actions.append(confirmButton, cancelButton); strip.append(copy, actions); feedbackElement.before(strip);
      confirmButton.focus();
    });
  }
  async function rebuild(): Promise<void> {
    if (!button || !feedback || button.disabled) return;
    button.disabled = true;
    try {
      const preview = await send({ kind: 'known.scope.rebuild.preview' });
      if (!preview.ok) throw new Error(preview.code);
      if (!('preview' in preview)) throw new Error('request_invalid');
      const proceed = await askConfirmation(button, feedback, replicaRebuildConfirmation(preview.preview.queuedOperations));
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
      const code = reasonCode(error, 'rebuild_failed');
      feedback.textContent = code === 'upload_outcome_unsettled' || code === 'native_outcome_unsettled'
        ? t('sync_rebuildUnsettled', 'A previous change has an unknown result ($1). Resolve it in Status before resetting sync.', code)
        : code === 'rebuild_not_required' || code === 'stale_ref'
          ? t('sync_rebuildNoLongerAvailable', 'Sync state changed. Refresh Status to review the available actions ($1).', code) : t('sync_resetIsntFinishedYet', "Reset isn't finished yet. Try again.");
    } finally { button.disabled = false; }
  }
}
