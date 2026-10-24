import { localized, t } from './i18n.js';
import { reasonCode } from './push-error-code.js';
import { askResetConfirmation } from './reset-confirm-ui.js';
import { storageResetConfirmation, storageResetDoneCopy, storageResetFailureCopy } from './replica-rebuild-copy.js';
import type { SyncStorageResetRequest, SyncStorageResetResponse } from './sync-storage-reset.js';

export let STORAGE_RESET_LABEL: string, STORAGE_RESET_CONFIRM_LABEL: string, STORAGE_RESET_KEEP_LABEL: string;
localized(() => {
  STORAGE_RESET_LABEL = t('sync_resetLocalSyncData', 'Reset local sync data');
  STORAGE_RESET_CONFIRM_LABEL = t('sync_resetSyncData', 'Reset sync data');
  STORAGE_RESET_KEEP_LABEL = t('common_cancel', 'Cancel');
});

/**
 * W2A-01: "Reset local sync data", the way out when the sync database itself cannot be used (written by a newer
 * version, damaged, or failing to open). The worker saves the unsent changes it can still read to a local archive,
 * gives this browser a new replica identity and deletes the database; the bookmarks are never touched. The button is
 * on the card only when the attention read says a reset can recover the state (`storageResetAvailable`).
 */
export function bindStorageResetButton(hostId: string, onChanged?: () => Promise<unknown> | void): void {
  const button = document.getElementById(`${hostId}-storage-reset`) as HTMLButtonElement | null;
  const feedback = document.getElementById(`${hostId}-feedback`);
  if (!button || !feedback) return;
  button.textContent = STORAGE_RESET_LABEL;
  button.addEventListener('click', () => { void reset(); });
  async function send(message: SyncStorageResetRequest): Promise<SyncStorageResetResponse> {
    return chrome.runtime.sendMessage(message) as Promise<SyncStorageResetResponse>;
  }
  async function reset(): Promise<void> {
    if (!button || !feedback || button.disabled) return;
    button.disabled = true;
    let message: string;
    try {
      const preview = await send({ kind: 'known.sync.storage.reset.preview' });
      if (!preview.ok) throw new Error(preview.code);
      if (!('preview' in preview)) throw new Error('request_invalid');
      const proceed = await askResetConfirmation(button, feedback, storageResetConfirmation(preview.preview),
        { confirm: STORAGE_RESET_CONFIRM_LABEL, keep: STORAGE_RESET_KEEP_LABEL });
      if (!proceed) return;
      const result = await send({ kind: 'known.sync.storage.reset.confirm', userGesture: true });
      if (!result.ok) throw new Error(result.code);
      if (!('result' in result)) throw new Error('request_invalid');
      message = storageResetDoneCopy(result);
    } catch (error) { message = storageResetFailureCopy(reasonCode(error, 'storage_reset_failed')); }
    finally { button.disabled = false; }
    // Read the card again first: it repaints its feedback line, and what happened is said last.
    await onChanged?.();
    feedback.hidden = false; feedback.textContent = message;
  }
}
