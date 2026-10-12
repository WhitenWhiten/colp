import { localized, t } from '../i18n.js';
/**
 * User-facing wording for `CaptureTask.reason` codes in charts and the
 * detail facts row. The codes themselves stay stable: they are stored in
 * capture history and reported to the cloud, so renaming them would break
 * compatibility. Unknown codes read 'Other' in aggregate lists; the detail
 * facts row keeps the raw code as a diagnostic field.
 */
export let CAPTURE_REASON_LABELS: Record<string, string>;
localized(() => {
  CAPTURE_REASON_LABELS = {
  application_result_unknown: t('common_resultUnknown', 'Result unknown'),
  authority_fenced: t('common_sessionChanged', 'Session changed'),
  authorization_expired: t('common_authorizationExpired', 'Authorization expired'),
  authorization_required: t('common_authorizationRequired', 'Authorization required'),
  awaiting_sync_receipt: t('capture_waitingReceipt', 'Waiting for receipt'),
  bookmark_deleted: t('capture_bookmarkDeletedLocally', 'Bookmark deleted locally'),
  bookmark_edited_after_classification: t('capture_bookmarkEditedAfterClassification', 'Bookmark edited after classification'),
  capture_control_conflict: t('common_controlConflict', 'Control conflict'),
  capture_scope_changed: t('common_collectionChanged', 'Collection changed'),
  classification_corrected: t('common_classificationCorrected', 'Classification corrected'),
  classification_unavailable: t('common_classificationUnavailable', 'Classification unavailable'),
  credits_required: t('common_creditsRequired', 'Credits required'),
  classification_undone: t('common_classificationUndone', 'Classification undone'),
  credit_price_changed: t('capture_creditPriceChanged', 'Credit price changed'),
  execution_control_changed: t('capture_pausedResumed', 'Paused or resumed'),
  existence_unavailable: t('capture_alreadySavedCheckUnavailable', 'Already-saved check unavailable'),
  feedback_conflict: t('common_ratingConflict', 'Rating conflict'),
  feedback_needs_attention: t('capture_ratingNeedsAttention', 'Rating needs attention'),
  feedback_pending: t('common_ratingPending', 'Rating pending'),
  insufficient_credits: t('capture_notEnoughCredits', 'Not enough credits'),
  local_classification_failed: t('capture_localClassificationFailed', 'Your AI service could not classify this page'),
  local_key_rejected: t('capture_providerKeyRejected', 'Provider key rejected'),
  local_key_required: t('capture_providerKeyNeeded', 'Provider key needed'),
  local_no_folder: t('capture_noFolderFit', 'No folder fit'),
  local_no_folders: t('capture_noBookmarkFolders', 'No bookmark folders'),
  local_provider_unavailable: t('capture_providerUnavailable', 'Provider unavailable'),
  local_result_unknown: t('capture_classificationInterrupted', 'Classification interrupted'),
  manual: t('common_markedManually', 'Marked manually'),
  manually_edited: t('capture_bookmarkEditedBrowser', 'Bookmark edited in browser'),
  native_save_unavailable: t('capture_browserSaveUnavailable', 'Browser save unavailable'),
  offline: t('common_offline', 'Offline'),
  paused: t('common_paused', 'Paused'),
  permission_required: t('capture_bookmarkPermissionNeeded', 'Bookmark permission needed'),
  policy_unavailable: t('common_policyUnavailable', 'Policy unavailable'),
  preferences_conflict: t('common_settingsConflict', 'Settings conflict'),
  resume_disabled: t('common_autoResumeDisabled', 'Auto-resume disabled'),
  save_failed: t('common_saveFailed', 'Save failed'),
  sign_in_required: t('common_signInNeeded', 'Sign-in needed'),
  startup: t('capture_recoveredBrowserStartup', 'Recovered at browser startup'),
  subscription_capture_excluded: t('capture_excludedCapture', 'Excluded from capture'),
  suggestion_applied_explicitly: t('common_appliedManually', 'Applied manually'),
  suggestion_requires_confirmation: t('capture_waitingConfirmation', 'Waiting for confirmation'),
  target_not_mapped: t('capture_noFolderRuleMatched', 'No folder rule matched'),
  waiting: t('common_waiting', 'Waiting'),
};
});

export function captureReasonLabel(reason: string | null | undefined): string {
  if (!reason) return t('common_none', 'None');
  return CAPTURE_REASON_LABELS[reason] ?? t('common_other', 'Other');
}
