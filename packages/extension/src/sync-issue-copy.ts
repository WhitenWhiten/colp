import { t } from './i18n.js';
import { describeSyncProblem } from './sync-problem-catalog.js';
import { CODE_WHAT } from './sync-problem-copy.js';
import type { SyncIssueDiagnostic } from './types.js';

/**
 * One sentence for one item that could not sync, in the vocabulary the Sync
 * center uses (`issueSummary` in `packages/web/src/pages/sync/health.tsx`), so
 * a row reads the same on this device and on the web. The code never stands
 * alone: a code nobody wrote an item sentence for falls back to the problem
 * catalog and then to the direction it failed in.
 */
export type IssueSummaryInput = Pick<SyncIssueDiagnostic, 'code' | 'direction'> & {
  readonly actions?: readonly string[];
  /** `sync_step_failed` only: the step of the sync pass that keeps failing, and the code it failed with. */
  readonly stage?: string;
  readonly rootCause?: string;
};

const ITEM: Readonly<Record<string, () => string>> = {
  remote_delete_confirmation_required: () => t('syncIssue_deleteDecision', 'Waiting for your decision under Deletions: delete, restore, or keep it on this browser'),
  conflict_pending: () => t('syncIssue_conflictPending', 'Waiting for a conflict to be resolved'),
  conflict_hold: () => t('syncIssue_conflictHold', 'Waiting for a conflict on this bookmark to be resolved'),
  dependency_hold: () => t('syncIssue_dependencyHold', "Waiting for an earlier change to it that couldn't sync"),
  parent_set_aside: () => t('syncIssue_parentSetAside', "Its folder couldn't be added to this browser"),
  create_placement_parent_deleted: () => t('syncIssue_placementParentDeleted', 'Its folder was deleted before it synced'),
  create_placement_unproven: () => t('syncIssue_placementUnproven', "Its place in the folder couldn't be confirmed"),
  recovery_identity_unproven: () => t('syncIssue_identityUnproven', "It couldn't be matched with one saved bookmark"),
  deletion_identity_unproven: () => t('syncIssue_deletionUnproven', "Deleted here, but it couldn't be matched, so nothing else was deleted"),
  delete_subtree_changed: () => t('syncIssue_subtreeChanged', 'Deleted here, but the folder changed elsewhere first. Try again deletes it anyway, with those changes'),
  record_too_large: () => t('syncIssue_recordTooLarge', 'Too large for this browser to store'),
  managed_not_writable: () => t('syncIssue_managedNotWritable', 'This bookmark is managed by the browser and cannot be changed here'),
  bounded_string_invalid: () => t('syncIssue_stringTooLong', 'A field is too long for this browser to store'),
  secret_field_forbidden: () => t('syncIssue_secretField', 'A field looks like a password or key, so it is not synced'),
  native_result_unknown: () => t('syncIssue_nativeUnknown', 'Waiting for your decision under Waiting for you'),
  local_merge_difference: () => t('syncIssue_mergeDifference', 'Review this difference in the Folders tab. It is not a server conflict.'),
  duplicate_candidate: () => t('syncIssue_duplicateCandidate', 'Review possible duplicates in the Folders tab.'),
  dependency_pending: () => t('syncIssue_dependencyPending', 'Waiting for an earlier operation; this browser checks it automatically'),
  dependency_parked: () => t('syncIssue_dependencyPending', 'Waiting for an earlier operation; this browser checks it automatically'),
  sequence_blocked: () => t('syncIssue_sequenceBlocked', 'An earlier deferred operation holds this upload. Try again checks it without changing the change itself.'),
  resource_id_unavailable: () => t('syncIssue_resourceId', 'The server used this change up but refused its identity. The change has not been applied.'),
  waiting_dependency: () => t('syncIssue_waitingDependency', 'Waiting for another change to finish'),
  // A sent change the server keeps unsettled; this browser's later uploads wait behind it.
  push_deferred: () => t('syncIssue_pushDeferred', 'The server keeps deferring this change; later uploads from this browser wait behind it'),
  sequence_gap: () => t('syncIssue_sequenceGap', 'The server is waiting for an earlier change first; later uploads from this browser wait behind it'),
  push_response_unrecognized: () => t('syncIssue_pushUnsettled', "The server's answer to this change couldn't be settled; later uploads from this browser wait behind it"),
  push_result_processing_failed: () => t('syncIssue_pushUnsettled', "The server's answer to this change couldn't be settled; later uploads from this browser wait behind it"),
  push_problem_status_mismatch: () => t('syncIssue_pushUnsettled', "The server's answer to this change couldn't be settled; later uploads from this browser wait behind it"),
  push_batch_response_invalid: () => t('syncIssue_pushUnsettled', "The server's answer to this change couldn't be settled; later uploads from this browser wait behind it"),
  push_stalled: () => t('syncIssue_pushUnsettled', "The server's answer to this change couldn't be settled; later uploads from this browser wait behind it"),
  push_response_invalid: () => t('syncIssue_pushUnsettled', "The server's answer to this change couldn't be settled; later uploads from this browser wait behind it"),
  push_problem_invalid: () => t('syncIssue_pushUnsettled', "The server's answer to this change couldn't be settled; later uploads from this browser wait behind it"),
  // The server is not answering, so the change at the head of the line waits and everything behind it with it.
  push_server_unavailable: () => t('syncIssue_serverNotAnswering', "The server isn't answering this change; later uploads from this browser wait behind it. Retry sync sends it again"),
  service_unavailable: () => t('syncIssue_serverNotAnswering', "The server isn't answering this change; later uploads from this browser wait behind it. Retry sync sends it again"),
  internal_error: () => t('syncIssue_serverNotAnswering', "The server isn't answering this change; later uploads from this browser wait behind it. Retry sync sends it again"),
  // Held or refused before anything was sent: the change is an item, everything else keeps syncing (A-F2, A-F6, A-F7).
  push_request_refused: () => t('syncIssue_requestRefused', 'A firewall or network filter keeps refusing this change, so it was set aside. Everything else keeps syncing'),
  metadata_sync_disabled: () => t('syncIssue_metadataNotSynced', 'It includes tags or a description, which you chose not to sync, so it was not uploaded'),
  subscription_upload_excluded: () => t('syncIssue_subscriptionExcluded', 'Not uploaded: the bookmark is in a subscribed folder'),
  bootstrap_boundary_unavailable: () => t('syncIssue_boundaryUnavailable', "It couldn't be checked against the first sync because its folder couldn't be read"),
  bootstrap_upload_excluded: () => t('syncIssue_bootstrapExcluded', 'Not part of the first sync, so it was left out'),
  push_attempt_bind_failed: () => t('syncIssue_bindFailed', "This browser couldn't prepare it for upload"),
  push_media_type_invalid: () => t('syncIssue_mediaTypeInvalid', 'It is in a format sync cannot send'),
  // A saved change this browser cannot read (Rule C): unsent ones are set aside, a possibly sent one holds the line.
  queue_row_unreadable: () => t('syncIssue_rowUnreadable', 'One saved change could not be read, so it was set aside. The bookmark is unchanged; Try again saves it again'),
  queue_head_unreadable: () => t('syncIssue_headUnreadable', 'A change that may already have reached the server cannot be read on this device, so later uploads are waiting. Resetting sync on this device clears it'),
  push_attempt_operation_changed: () => t('syncIssue_attemptChanged', 'A change that may already have reached the server could not be sent again, so later uploads are waiting. Resetting sync on this device clears it'),
  // Rule E: a step of the sync pass that keeps failing (the row names the step and the cause when it knows them).
  sync_step_failed: () => t('syncIssue_stepFailedPlain', 'Part of syncing keeps failing and will be tried again'),
};

/** Codes the item vocabulary names; the Sync center's list is kept in step with this one by a test. */
export const ISSUE_SUMMARY_CODES: readonly string[] = Object.freeze(Object.keys(ITEM));

/** The steps of one sync pass that can be recorded as failing, in words (`wake-failure.ts`). */
const STAGE: Readonly<Record<string, () => string>> = {
  scope_restore: () => t('syncStage_scopeRestore', 'restoring this browser’s sync setup'),
  scope_registration: () => t('syncStage_scopeRegistration', 'registering this browser with the server again'),
  history_prune: () => t('syncStage_historyPrune', 'clearing old sync history'),
  advanced_plan: () => t('syncStage_advancedPlan', 'the advanced first sync'),
  state_read: () => t('syncStage_stateRead', 'reading sync data'),
  identity_freeze_recovery: () => t('syncStage_identityRecovery', 'recovering from a paused identity check'),
  local_save_recovery: () => t('syncStage_saveRecovery', 'recovering a bookmark that was being saved'),
  recovery_state: () => t('syncStage_recoveryState', 'checking where recovery stands'),
  missing_removals: () => t('syncStage_missingRemovals', 'looking for bookmarks removed here'),
  work_facts: () => t('syncStage_workFacts', 'counting pending work'),
  metadata_pass: () => t('syncStage_metadataPass', 'checking tags and descriptions'),
  bootstrap_run: () => t('syncStage_bootstrapRun', 'the first sync'),
  push_drain: () => t('syncStage_pushDrain', 'uploading changes'),
  engine_wake: () => t('syncStage_syncPass', 'the sync pass'),
  wake: () => t('syncStage_syncPass', 'the sync pass'),
};

/**
 * A step that keeps failing, in the order a person needs it: which part, why, and that it is tried again.
 * A reset that cannot finish is the one with an exit of its own (Cancel pending reset), so it reads as itself.
 */
function stepFailedCopy(issue: IssueSummaryInput): string {
  const cause = issue.rootCause?.trim() ? issue.rootCause : undefined;
  if (issue.stage === 'rebuild_resume') {
    return cause ? t('syncIssue_resetNotFinishing', 'The reset could not finish ($1). It is tried again on the next pass', cause)
      : t('syncIssue_resetNotFinishingPlain', 'The reset could not finish. It is tried again on the next pass');
  }
  const stage = issue.stage ? STAGE[issue.stage]?.() : undefined;
  if (stage && cause) return t('syncIssue_stepFailed', 'Part of syncing keeps failing ($1) and will be tried again. Cause: $2', stage, cause);
  if (cause) return t('syncIssue_stepFailedCause', 'Part of syncing keeps failing and will be tried again. Cause: $1', cause);
  return stage ? t('syncIssue_stepFailedStage', 'Part of syncing keeps failing ($1) and will be tried again', stage) : ITEM.sync_step_failed!();
}

/** `apply_failed:<code>` is the pull side-lining of a rejected browser call: its sentence names the underlying cause. */
export function issueCauseCode(code: string): string {
  return code.startsWith('apply_failed:') ? code.slice('apply_failed:'.length) : code;
}

export function issueSummaryCopy(issue: IssueSummaryInput): string {
  if (issue.code === 'sync_step_failed') return stepFailedCopy(issue);
  const specific = ITEM[issue.code];
  if (specific) return specific();
  if (issue.code.startsWith('apply_failed:')) {
    return t('syncIssue_applyFailed', "The browser refused to apply this change from your library, so it was set aside. Dismiss keeps this browser's version.");
  }
  if (CODE_WHAT[issue.code]) return describeSyncProblem(issue.code).what;
  // A held upload that offers a retry never reached the server: this browser could not get it ready.
  if (issue.direction === 'push') {
    return issue.actions?.includes('retry')
      ? t('syncIssue_pushNotReady', "This browser couldn't get it ready to upload")
      : t('syncIssue_pushRefused', "The server didn't accept this change");
  }
  if (issue.direction === 'pull') return t('syncIssue_pullNotApplied', "Couldn't be applied in this browser");
  return t('syncIssue_localNotPrepared', "Couldn't be prepared for sync");
}

export function issueDirectionCopy(direction: SyncIssueDiagnostic['direction']): string {
  return direction === 'push' ? t('syncIssue_upload', 'Upload')
    : direction === 'pull' ? t('syncIssue_download', 'Download') : t('syncIssue_onDevice', 'On this device');
}

/** What a row calls the bookmark when no title survived. Items that are not about one bookmark say what they are about. */
export function issueTitleCopy(issue: Pick<SyncIssueDiagnostic, 'title' | 'nodeId'> & { readonly code?: string }): string {
  if (issue.title?.trim()) return issue.title.trim();
  if (issue.code === 'sync_step_failed') return t('syncIssue_stepTitle', 'Part of syncing');
  if (!issue.nodeId && (issue.code === 'queue_row_unreadable' || issue.code === 'queue_head_unreadable')) {
    return t('syncIssue_savedChangeTitle', 'A saved change');
  }
  return issue.nodeId ? t('syncIssue_libraryBookmark', 'A bookmark in your library') : t('syncIssue_deviceBookmark', 'A bookmark on this device');
}

/** A merge upload the server or this browser refused: the sentence first, the code after it. */
export function mergeResolutionFailureCopy(code: string): string {
  return t('firstRun_mergeResolutionFailed', 'That upload did not go through. $1 ($2)', issueSummaryCopy({ code, direction: 'push' }), code);
}
