import { reasonCode } from './push-error-code.js';
import { localized, t, tn } from './i18n.js';
import type { ReplicaRebuildRequest, ReplicaRebuildResponse } from './replica-rebuild.js';

export let REBUILD_LABEL: string, REBUILD_CONFIRM_LABEL: string, REBUILD_CANCEL_LABEL: string;
localized(() => {
  REBUILD_LABEL = t('sync_resetSyncDevice', 'Reset sync on this device');
  REBUILD_CONFIRM_LABEL = t('common_resetSync', 'Reset sync');
  REBUILD_CANCEL_LABEL = t('common_cancel', 'Cancel');
});
export function replicaRebuildConfirmation(queuedOperations: number, retirementRequired = false): string {
  if (retirementRequired) return t('sync_rebuildConfirmRetirement', 'Reset needs an internet connection to stop the old sync connection on the server. Pending changes will be kept on this device and will not be sent again. Earlier changes may already be in your library. Your bookmarks stay in place. Afterwards, choose which folders sync and review the merge again. Reset sync now?');
  if (queuedOperations === 0) return t('sync_rebuildConfirm', "Your bookmarks stay on this device and in your library. Afterwards you'll choose which folders sync and review the merge again. Reset sync now?");
  return t('sync_rebuildConfirmSetAside', "Your bookmarks stay on this device and in your library. $1 Afterwards you'll choose which folders sync and review the merge again. Reset sync now?",
    tn('sync_rebuildSetAside', queuedOperations, '$1 change that has not synced yet will be set aside and not retried.', '$1 changes that have not synced yet will be set aside and not retried.'));
}

export function replicaRebuildFailureCopy(code: string): string {
  if (code === 'retirement_pending') return t('sync_rebuildRetirementPending', 'Waiting for the server to confirm that the old sync connection has stopped. Your pending changes are kept and will not be sent again. Connect to the internet and try Reset again.');
  if (code === 'rebuild_authentication_required' || code === 'retirement_authentication_required') return t('sync_rebuildRetirementAuthentication', 'Reset needs authorization from the same account. Sign in again, check that you still have access to this library, then review and confirm Reset again. Your pending changes are kept.');
  if (code === 'retirement_authority_denied') return t('sync_rebuildRetirementDenied', 'The server did not authorize this reset. Signing in again cannot restore revoked library access or invalid device authorization. Your pending changes are kept and will not be sent again. You can continue using bookmarks on this device while the library owner or server administrator reviews access.');
  if (code === 'retirement_legacy_authority_required') return t('sync_rebuildRetirementLegacy', 'This server cannot authorize the pending reset with this sign-in. Update the server to support reset recovery, or restore the original sign-in. Your pending changes are kept and will not be sent again.');
  if (code === 'rebuild_other_account_pending') return t('sync_rebuildRetirementOtherAccount', 'An unfinished reset belongs to another account. Sign in to that account to finish it. Its pending changes have been kept.');
  if (code === 'retirement_target_changed') return t('sync_rebuildRetirementTargetChanged', 'The server reset address changed before confirmation. Restore the previous server connection to finish this reset. Your pending changes have been kept.');
  if (code === 'upload_outcome_unsettled' || code === 'native_outcome_unsettled') return t('sync_rebuildUnsettled', 'A previous change has an unknown result ($1). Resolve it in Status before resetting sync.', code);
  if (code === 'rebuild_not_required' || code === 'stale_ref') return t('sync_rebuildNoLongerAvailable', 'Sync state changed. Refresh Status to review the available actions ($1).', code);
  return t('sync_resetIsntFinishedYet', "Reset isn't finished yet. Try again.");
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
  function askConfirmation(feedbackElement: HTMLElement, question: string): Promise<{ proceed: boolean; restoreFocus: boolean }> {
    return new Promise((resolve) => {
      const strip = document.createElement('div'); strip.className = 'rebuild-confirm';
      const copy = document.createElement('p'); copy.className = 'rebuild-confirm-copy'; copy.textContent = question;
      const actions = document.createElement('div'); actions.className = 'row-actions';
      const confirmButton = document.createElement('button'); confirmButton.type = 'button';
      confirmButton.className = 'btn btn-danger btn-sm'; confirmButton.textContent = REBUILD_CONFIRM_LABEL;
      const cancelButton = document.createElement('button'); cancelButton.type = 'button';
      cancelButton.className = 'btn btn-ghost btn-sm'; cancelButton.textContent = REBUILD_CANCEL_LABEL;
      let settled = false;
      const settle = (proceed: boolean) => {
        if (settled) return;
        settled = true;
        const restoreFocus = !proceed && strip.contains(document.activeElement);
        strip.remove(); resolve({ proceed, restoreFocus });
      };
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
    let restoreFocus = false;
    try {
      const preview = await send({ kind: 'known.scope.rebuild.preview' });
      if (!preview.ok) throw new Error(preview.code);
      if (!('preview' in preview)) throw new Error('request_invalid');
      const confirmation = await askConfirmation(feedback, replicaRebuildConfirmation(preview.preview.queuedOperations,
        preview.preview.retirementRequired));
      if (!confirmation.proceed) { restoreFocus = confirmation.restoreFocus; return; }
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
      feedback.textContent = replicaRebuildFailureCopy(code);
    } finally {
      button.disabled = false;
      // The disabled trigger cannot receive focus while the dialog settles.
      // Restore it only if this view and its vacated focus still belong to us.
      if (restoreFocus && button.isConnected && document.getElementById(`${hostId}-rebuild`) === button
          && document.getElementById(`${hostId}-feedback`) === feedback && document.activeElement === document.body) button.focus();
    }
  }
}
