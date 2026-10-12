import { createDialog, dialogButton } from './dialog.js';
import { el } from './library-dom.js';
import { t } from './i18n.js';
import type { MetadataReassociationCommand } from './metadata-reassociation-commands.js';

export async function openMetadataReassociation(base64: string) {
  const { dialog, body, actions } = createDialog(t('backup_existingMetadata', 'Restore metadata to existing bookmarks'));
  dialog.id = 'metadata-restore-dialog';
  const status = el('p'); status.id = 'metadata-restore-status'; status.setAttribute('role', 'status');
  body.append(el('p', t('backup_existingMetadataHint', 'Match unique bookmark paths and exact URLs. Existing bookmarks are kept and no copies are created. Current conflicting values are kept; retain the backup to review skipped values.')), status);
  const cancel = dialogButton(t('common_cancel', 'Cancel')), confirm = dialogButton(t('backup_confirmMetadata', 'Restore matching metadata'), 'primary');
  confirm.id = 'metadata-restore-confirm'; confirm.disabled = true;
  actions.append(cancel, confirm); document.body.append(dialog); dialog.showModal();
  let token: string | undefined;
  async function send(command: MetadataReassociationCommand) {
    const result = await chrome.runtime.sendMessage(command) as { ok: boolean; token?: string; matches?: number;
      ambiguous?: number; unmatched?: number; conflicts?: number; restored?: number };
    if (!result?.ok) throw new Error('metadata_restore_failed');
    return result;
  }
  cancel.onclick = () => dialog.close();
  dialog.addEventListener('close', () => dialog.remove(), { once: true });
  confirm.onclick = () => {
    if (!token) return;
    confirm.disabled = true;
    void send({ kind: 'known.metadataRestore.confirm', token, userGesture: true }).then(result => {
      status.textContent = t('backup_metadataRestored', 'Metadata restored to $1 existing items. $2 items have conflicting values kept for review.', result.restored ?? 0, result.conflicts ?? 0);
      cancel.textContent = t('common_done', 'Done');
    }).catch(() => { status.textContent = t('backup_metadataChanged', 'The restore could not finish. Bookmarks or metadata may have changed. Choose the backup again to review current matches.'); });
  };
  try {
    const result = await send({ kind: 'known.metadataRestore.preview', base64 });
    if (!dialog.isConnected) return;
    token = result.token;
    status.textContent = t('backup_metadataMatches', '$1 matching items; $2 ambiguous items skipped; $3 unmatched items skipped; $4 items with conflicts.',
      result.matches ?? 0, result.ambiguous ?? 0, result.unmatched ?? 0, result.conflicts ?? 0);
    confirm.disabled = !token || !result.matches;
  } catch { status.textContent = t('backup_metadataChanged', 'The restore could not finish. Bookmarks or metadata may have changed. Choose the backup again to review current matches.'); }
}
