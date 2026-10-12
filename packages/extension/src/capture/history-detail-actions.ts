import type { CaptureTask } from './contracts.js';
import { appendCaptureDetailLinks } from './detail-links.js';
import { createDialog, dialogButton } from '../dialog.js';
import { createIcon } from '../icons.js';
import { button, el, inlineAlert } from '../library-dom.js';
import { localized, t } from '../i18n.js';

let FEEDBACK_LABEL: Record<string, string>;
localized(() => {
  FEEDBACK_LABEL = {
    explicit_positive: t('common_rightFolder', 'Right folder'),
    explicit_negative: t('common_wrongFolder', 'Wrong folder'),
    correction_applied: t('common_folderCorrected', 'Folder corrected'),
    implicit_positive: t('common_kept', 'Kept'),
    dismissed_unrated: t('common_dismissed', 'Dismissed'),
    not_presented: t('common_notShown', 'Not shown'),
    withdrawn: t('common_noRating', 'No rating'),
  };
});
const feedbackLabel = (kind: string | null | undefined) => (kind ? FEEDBACK_LABEL[kind] : undefined) ?? t('common_noRating', 'No rating');

export interface DetailActionsOptions {
  readonly readOnly: boolean;
  readonly historyOrigin?: 'backup' | 'device';
  readonly onChanged: () => void;
  readonly status: (text: string) => void;
  /** Where dialogs are mounted. */
  readonly host: HTMLElement;
}

/**
 * Everything the worker can still do for one capture: check or resume it,
 * apply or undo the AI's suggestion, rate it, settle a rating conflict, retry
 * its report. `alerts` explain why; `actions` is one wrapped row of buttons,
 * commands first and navigation after them.
 */
export function detailActions(task: CaptureTask, options: DetailActionsOptions): { readonly alerts: HTMLElement[]; readonly actions: HTMLElement } {
  const alerts: HTMLElement[] = [];
  const actions = el('div', undefined, 'detail-actions');
  const deleted = task.reason === 'bookmark_deleted';
  const failed = () => { options.status(t('capture_operationCouldNotFinish', 'This operation could not finish. Your bookmark and draft are preserved.')); };
  async function command(message: unknown): Promise<void> {
    const result = await chrome.runtime.sendMessage(message) as { ok?: boolean };
    if (!result?.ok) throw new Error('capture_command_failed');
    options.onChanged();
  }
  function act(label: string, run: () => Promise<void>, className = 'btn btn-secondary btn-sm'): HTMLButtonElement {
    const node = button(label, className);
    node.addEventListener('click', () => { node.disabled = true; void run().catch(failed).finally(() => { node.disabled = false; }); });
    actions.append(node);
    return node;
  }
  const note = (text: string, tone: 'info' | 'warning' = 'info', action?: HTMLElement) => { alerts.push(inlineAlert(tone, text, action)); };

  if (options.readOnly) {
    note(options.historyOrigin === 'device' ? t('capture_savedBrowser2', 'Saved in browser')
      : options.historyOrigin === 'backup'
        ? t('backup_restoredHistoryHint', 'Restored from a backup. This is a local historical record; its old operations will not run again. Use Locate bookmark to edit the restored bookmark.')
        : t('capture_beforeSignInDetails', 'Saved before sign-in on this browser. This record stays local. Use Locate bookmark to edit the bookmark itself.'));
  }
  if (deleted) note(t('capture_originalBookmarkDeletedHistory', 'The original bookmark was deleted. This history record is retained.'));

  if (!options.readOnly) {
    if (task.reportFailure) {
      const retry = button(t('capture_retryHistoryReport', 'Retry history report'), 'btn btn-ghost btn-sm');
      retry.addEventListener('click', () => { retry.disabled = true; void command({ kind: 'known.capture.report.retry', captureId: task.captureId }).catch(failed).finally(() => { retry.disabled = false; }); });
      note(t('capture_taskStoredLocallyIts', 'This task is stored locally; its cloud history report needs review.'), 'warning', retry);
    }
    if (task.reason === 'feedback_conflict' && task.remoteFeedback) {
      const remote = task.remoteFeedback;
      note(t('capture_ratingConflictBrowserAccount', 'Rating conflict. This browser: $1; account: $2.', feedbackLabel(task.feedbackKind), feedbackLabel(remote.kind)), 'warning');
      act(t('capture_useAccountRating', 'Use account rating'), () => command({ kind: 'known.capture.feedback.adopt', captureId: task.captureId, revision: remote.revision }));
      act(t('capture_applyBrowsersRating', 'Apply this browser’s rating'), () => command({ kind: 'known.capture.feedback', captureId: task.captureId, eventId: crypto.randomUUID(),
        nodeRevision: task.appliedRevision, feedback: task.feedbackKind === 'correction_applied' ? 'explicit_negative' : task.feedbackKind ?? 'withdrawn', expectedRevision: remote.revision }));
    }
    if (task.automatic && task.classification !== 'applied') {
      if (task.automatic.decision?.suggestedPath?.length) note(t('capture_proposedFolder', 'Proposed folder: $1', task.automatic.decision.suggestedPath.join(' › ')));
      act(t('capture_checkClassificationResult', 'Check classification result'), () => command({ kind: 'known.capture.decision.check', captureId: task.captureId }));
      if (task.automatic.decision?.status === 'suggested' && !task.automatic.applySubmitted && !task.manualFence) {
        let applyCommand: string | undefined;
        act(t('capture_applySuggestion', 'Apply this suggestion'), async () => {
          const { dialog, body, actions: dialogActions } = createDialog(t('capture_applyClassificationSuggestion', 'Apply classification suggestion'));
          const description = el('p', t('capture_applySuggestionNoNew', 'Apply this suggestion to $1? No new classification call will be made.', task.automatic?.decision?.suggestedPath?.join(' › ') || t('capture_proposedFolder2', 'the proposed folder')));
          const cancel = dialogButton(t('common_cancel', 'Cancel')), apply = dialogButton(t('common_applySuggestion', 'Apply suggestion'), 'primary');
          cancel.addEventListener('click', () => dialog.close()); dialog.addEventListener('close', () => dialog.remove());
          apply.addEventListener('click', () => {
            apply.disabled = true; applyCommand ??= crypto.randomUUID();
            void command({ kind: 'known.capture.apply', captureId: task.captureId, commandId: applyCommand, userGesture: true })
              .then(() => dialog.close()).catch(() => { description.textContent = t('capture_applicationNotConfirmedClose', 'Application is not confirmed. Close this dialog and check the saved result.'); });
          });
          body.append(description); dialogActions.append(cancel, apply); options.host.append(dialog); dialog.showModal(); cancel.focus();
        });
      }
    }
    if (task.save === 'unknown') act(t('capture_checkSaveResult', 'Check save result'), () => command({ kind: 'known.capture.check', captureId: task.captureId }));
    if (task.save === 'unsubmitted') act(t('capture_resumeCapture', 'Resume this capture'), () => command({ kind: 'known.capture.resume', captureId: task.captureId }));
    if (task.appliedRevision && !task.undo?.completed && !deleted) {
      let undoCommand: string | undefined;
      act(t('capture_undoAutomaticClassification', 'Undo automatic classification'), () => { undoCommand ??= crypto.randomUUID(); return command({ kind: 'known.capture.undo', captureId: task.captureId, commandId: undoCommand, userGesture: true }); });
      act(t('common_rightFolder', 'Right folder'), () => command({ kind: 'known.capture.feedback', captureId: task.captureId, eventId: crypto.randomUUID(), feedback: 'explicit_positive', nodeRevision: task.appliedRevision }));
      if (task.feedbackKind && task.feedbackKind !== 'withdrawn') act(t('common_withdrawRating', 'Withdraw rating'), () => command({ kind: 'known.capture.feedback', captureId: task.captureId, eventId: crypto.randomUUID(), feedback: 'withdrawn', nodeRevision: task.appliedRevision }));
    }
  }
  if (task.automatic?.decision?.explanation?.kind === 'exact_score_tie') note(t('capture_explicitFolderChoicesBroke', 'Your explicit folder choices broke a tie between equally scored candidates.'));
  if (task.automatic?.decision?.path?.length) note(t('capture_lastRecordedCloudLocation', 'Last recorded cloud location: $1', task.automatic.decision.path.join(' › ')));

  // Navigation sits after the commands, quieter, so the row reads verb-first.
  const open = el('a', undefined, 'btn btn-ghost btn-sm'); open.href = task.url; open.target = '_blank'; open.rel = 'noreferrer';
  open.append(createIcon('arrow-up-right', 14), t('common_openWebpage', 'Open webpage')); actions.append(open);
  if (task.nativeId && !deleted) {
    const locate = el('a', undefined, 'btn btn-ghost btn-sm'); locate.append(createIcon('bookmark', 14), t('common_locateBookmark', 'Locate bookmark'));
    locate.href = `#bookmarks?native=${encodeURIComponent(task.nativeId)}&return=${encodeURIComponent(location.hash.startsWith('#history') ? location.hash.slice(1) : `history?task=${task.captureId}`)}`;
    actions.append(locate);
  }
  appendCaptureDetailLinks(actions, task);
  return { alerts, actions };
}
