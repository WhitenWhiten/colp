import { t, tn } from './i18n.js';
import { resetBlockedCopy } from './sync-problem-copy.js';

/**
 * The words around "Reset sync on this device" and its two siblings (K3, W2A-01, W2A-02): what the confirmation
 * says before anything is touched, and what each way it can fail means for the data. Pure, so the sentences are
 * tested without a DOM. Every call carries its literal key and English for `scripts/i18n-catalog.mjs`.
 */

/**
 * What the person agrees to. A local Reset archives the unsent work and starts again. When a change may already be
 * on the server (`server_fenced`) the confirmation spells out why the server is told first, and that it needs a
 * connection: that is the whole reason this Reset is safe.
 */
export function replicaRebuildConfirmation(queuedOperations: number, mode: 'local' | 'server_fenced' = 'local'): string {
  const queued = queuedOperations === 0 ? '' : tn('sync_rebuildSetAside', queuedOperations,
    '$1 change that has not synced yet will be set aside and not retried.', '$1 changes that have not synced yet will be set aside and not retried.');
  if (mode === 'server_fenced') {
    return queued === ''
      ? t('sync_rebuildConfirmFenced', "A change from this browser may already have reached the server, and sync can't tell whether it did. To make a reset safe, the server first stops taking anything from this browser's current sync copy; then sync on this device starts again. This needs a connection. Your bookmarks stay on this device and in your library. Afterwards you'll choose which folders sync and review the merge again. Reset sync now?")
      : t('sync_rebuildConfirmFencedSetAside', "A change from this browser may already have reached the server, and sync can't tell whether it did. To make a reset safe, the server first stops taking anything from this browser's current sync copy; then sync on this device starts again. This needs a connection. Your bookmarks stay on this device and in your library. $1 Afterwards you'll choose which folders sync and review the merge again. Reset sync now?", queued);
  }
  if (queued === '') return t('sync_rebuildConfirm', "Your bookmarks stay on this device and in your library. Afterwards you'll choose which folders sync and review the merge again. Reset sync now?");
  return t('sync_rebuildConfirmSetAside', "Your bookmarks stay on this device and in your library. $1 Afterwards you'll choose which folders sync and review the merge again. Reset sync now?", queued);
}

/**
 * Why a Reset did not run, or did not finish. Everything the server fence can refuse says that nothing was reset:
 * the fence comes first, so a refusal leaves this browser exactly as it was.
 */
export function rebuildFailureCopy(code: string): string {
  const blocked = resetBlockedCopy(code);
  if (blocked) return blocked;
  switch (code) {
    case 'fence_unauthorized':
      return t('sync_rebuildFenceUnauthorized', 'Your sign-in no longer works, so the server could not be told. Nothing was reset. Sign in again from Account, then reset.');
    case 'rate_limited':
      return t('sync_rebuildRateLimited', 'The server asked sync to wait. Nothing was reset; try again in a minute.');
    case 'server_unavailable':
      return t('sync_rebuildServerDown', 'The server is not answering. Nothing was reset; try again later.');
    case 'fence_session_unavailable':
      return t('sync_rebuildNoSession', 'Sync could not get permission from the server to reset. Nothing was reset; try again.');
    case 'fence_refused': case 'fence_unavailable':
      return t('sync_rebuildFenceRefused', 'The server did not accept the reset ($1). Nothing was reset.', code);
    case 'account_switch':
      return t('sync_rebuildAccountSwitch', 'This browser is signed in to a different account now. Nothing was reset.');
    case 'rebuild_not_cancellable':
      return t('sync_rebuildNotCancellable', 'The reset has already started and can only be finished. Press Reset sync on this device to finish it.');
    case 'rebuild_not_required': case 'stale_ref':
      return t('sync_rebuildNoLongerAvailable', 'Sync state changed. Refresh Status to review the available actions ($1).', code);
    case 'rebuild_cannot_help':
      return t('sync_rebuildCannotHelp', 'A reset would not help here: a new copy meets the same refusal. Nothing was reset. The card says what does.');
    default:
      return t('sync_resetIsntFinishedYet', "Reset isn't finished yet. Try again.");
  }
}

/** Giving up a reset that was confirmed but cannot finish: nothing has been changed yet, so sync stays as it was. */
export function cancelPendingResetConfirmation(): string {
  return t('sync_cancelResetConfirm', 'Cancel the pending reset? Nothing on this device has been changed yet, so sync stays as it was. You can press Reset sync on this device again later.');
}

/** What a person agrees to when the sync data itself cannot be used (W2A-01): the copy that is saved first, and what follows. */
export function storageResetConfirmation(preview: { readonly unsentChanges: number; readonly readable: boolean }): string {
  const saved = preview.unsentChanges > 0
    ? tn('sync_storageResetSaved', preview.unsentChanges, '$1 unsent change is saved to a local archive first.', '$1 unsent changes are saved to a local archive first.')
    : preview.readable ? t('sync_storageResetNoneFound', 'No unsent changes were found.')
      : t('sync_storageResetUnreadable', 'The data could not be read at all, so nothing can be saved first.');
  return [t('sync_storageResetHead', 'This resets the sync data stored in this browser. Your bookmarks are not changed.'), saved,
    t('sync_storageResetTail', 'Afterwards sync starts again from the first-sync merge, and this browser becomes a new device on the server. Reset the sync data now?')].join(' ');
}

/** The sync data was reset: what was kept aside, and that setting sync up again is the next step. */
export function storageResetDoneCopy(result: { readonly archivedChanges: number; readonly omittedChanges: number }): string {
  const parts = [t('sync_storageResetDone', 'Sync data on this device was reset. Your bookmarks were not changed.')];
  if (result.archivedChanges > 0) {
    parts.push(tn('sync_storageResetArchived', result.archivedChanges, '$1 unsent change was saved to a local archive.', '$1 unsent changes were saved to a local archive.'));
  }
  if (result.omittedChanges > 0) {
    parts.push(tn('sync_storageResetOmitted', result.omittedChanges, '$1 more change was too much to keep.', '$1 more changes were too much to keep.'));
  }
  return parts.join(' ');
}

/** Why the sync data was not reset. The copy of unsent changes comes first, so a failure before the delete changes nothing. */
export function storageResetFailureCopy(code: string): string {
  switch (code) {
    case 'storage_reset_not_needed':
      return t('sync_storageResetNotNeeded', 'Sync data on this device works now, so there is nothing to reset.');
    case 'archive_failed':
      return t('sync_storageResetArchiveFailed', 'Sync could not save a copy of your unsent changes, so nothing was reset. Free some disk space and try again.');
    case 'storage_reset_blocked':
      return t('sync_storageResetBlocked', 'Something is still using the sync data. Close other Know-N windows; the reset finishes by itself once nothing uses it.');
    default:
      return t('sync_storageResetFailed', 'The reset could not finish ($1). Try again.', code);
  }
}
