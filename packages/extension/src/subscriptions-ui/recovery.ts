import { t } from '../i18n.js';
import type { ExitPreview, ProjectionNode, SnapshotDescriptor } from '../bookmark-subscriptions/contracts.js';
import type { BookmarkPreferencesResponse } from '../types.js';
import type { MappingDetail } from './detail.js';
import type { Send } from './client.js';
import { button, el, errorCopy, link, modal, status } from './dom.js';
import { createNativePicker, type FolderSelection } from './native-picker.js';
import { renderProjection } from './content-settings.js';
interface RecoveryPreview { token: string; expiresAt: number; action: 'restore'|'copy_detach'; copyCount: number; copyReused?: boolean; preservationPath: string[]; exitPreview?: ExitPreview; targetRequired: boolean }
export function openRecovery(send: Send, detail: MappingDetail, action: RecoveryPreview['action'], completed: () => Promise<void>) {
  const label = action === 'restore' ? t('subscription_restoreSource', 'Undo my changes') : t('subscription_copyDetach', 'Keep a copy and remove');
  const view = modal(label), feedback = status(), content = el('div'), pickerHost = el('div'); let target: FolderSelection | undefined, preview: RecoveryPreview | undefined, generation = 0, busy = false;
  let picker: ReturnType<typeof createNativePicker> | undefined, requestId = crypto.randomUUID();
  view.body.append(el('p', t('subscription_copyBeforeChange', 'Your changes are copied to your backup folder and checked first. If the copy fails, nothing is removed.')), link(t('subscription_choosePreservation', 'Choose backup folder'), '#subscriptions/list'), pickerHost, content, feedback);
  const review = button(t('subscription_reviewRecovery', 'Review recovery'), () => { void load(); });
  const confirm = button(label, () => { void commit(); }, true); confirm.disabled = true; view.actions.append(review, confirm);
  if (action === 'restore' && (!detail.local?.rootNativeId || detail.local.state === 'target_missing')) {
    picker = createNativePicker(pickerHost, send, value => { target = value; preview = undefined; confirm.disabled = true; });
    feedback.textContent = t('subscription_recoveryChooseLocation', 'Choose where to put the restored folder, then review. Nothing is created until you confirm.');
  } else void load();
  async function load() {
    if (busy) return; if (picker && !target) { feedback.textContent = t('subscription_locationRequired', 'Pick a folder and enter a name.'); return; }
    const version = ++generation; busy = true; review.disabled = true; confirm.disabled = true;
    try {
      if (action === 'copy_detach') { const preferences = await chrome.runtime.sendMessage({ kind: 'known.bookmark.preferences.get' }) as BookmarkPreferencesResponse; if (version !== generation) return; if (!preferences.ok || preferences.pending || preferences.conflict) throw new Error('resolve_exit_policy'); }
      const result = await send<RecoveryPreview>({ kind: 'recoveryPreview', mappingId: detail.mapping.mappingId, expectedGeneration: detail.mapping.generation, action, ...(target ? { parentNativeId: target.id, ...(target.index === undefined ? {} : { index: target.index }) } : {}) });
      if (version !== generation) return; preview = result; requestId = crypto.randomUUID();
      content.replaceChildren(el('p', t('subscription_localCopyCount', 'Bookmarks to copy') + ': ' + result.copyCount), el('p', t('subscription_preservationLocation', 'Backup folder') + ': ' + result.preservationPath.join(' › ')));
      if (result.copyReused) content.append(el('p', t('subscription_reuseVerifiedCopy', 'A checked copy already exists and will be reused. Review what happens next before confirming.')));
      if (target) content.append(el('p', t('subscription_restoreLocation', 'Restored folder location') + ': ' + target.path));
      if (result.exitPreview) for (const item of result.exitPreview.targets) content.append(el('p', item.profileLabel + ': ' + (item.effectiveAction === 'keep' ? t('subscription_keep', 'Keep the bookmarks as your own') : t('subscription_remove', 'Delete the folder')) + ' · ' + item.policyOrigin));
      if (action === 'restore' && detail.sourceRef) {
        const source = await send<{ descriptor: SnapshotDescriptor; nodes: ProjectionNode[] }>({ kind: 'sourcePreview', ...detail.sourceRef, digestMode: detail.mapping.digestMode, editionLimit: detail.mapping.editionLimit });
        if (version !== generation) return; const projection = el('div'); renderProjection(projection, source); content.append(projection);
      }
      feedback.textContent = t('subscription_recoveryReviewHint', "Check the copy and what will happen to the folder. If anything changes before you confirm, you'll be asked to review again."); confirm.disabled = false;
    } catch (error) { if (version === generation) { preview = undefined; feedback.textContent = errorCopy(error); } }
    finally { busy = false; if (version === generation) review.disabled = false; }
  }
  async function commit() {
    if (busy || !preview) return; if (preview.expiresAt <= Date.now()) { preview = undefined; confirm.disabled = true; feedback.textContent = t('subscription_previewExpired', 'The preview expired. Review the location again.'); return; }
    const version = generation; busy = true; confirm.disabled = true; review.disabled = true;
    feedback.textContent = t('subscription_recoveryStarted', "Recovery is running. Closing this window won't stop it."); view.cancel.textContent = t('common_close', 'Close');
    try {
      await send({ kind: 'recoveryConfirm', token: preview.token }, requestId); if (version !== generation) return;
      view.dialog.close(); await completed();
    } catch (error) { if (version === generation) { feedback.textContent = errorCopy(error); if (error instanceof Error && /preview|generation|epoch|policy|snapshot|precondition|revision|local_copy_changed|local_copy_missing/.test(error.message)) { preview = undefined; } } }
    finally { busy = false; if (version === generation) { review.disabled = false; confirm.disabled = !preview; } }
  }
  view.dialog.addEventListener('close', () => { generation++; picker?.dispose(); }); return view;
}
