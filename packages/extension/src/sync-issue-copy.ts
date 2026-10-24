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
};

/** Codes the item vocabulary names; the Sync center's list is kept in step with this one by a test. */
export const ISSUE_SUMMARY_CODES: readonly string[] = Object.freeze(Object.keys(ITEM));

/** `apply_failed:<code>` is the pull side-lining of a rejected browser call: its sentence names the underlying cause. */
export function issueCauseCode(code: string): string {
  return code.startsWith('apply_failed:') ? code.slice('apply_failed:'.length) : code;
}

export function issueSummaryCopy(issue: IssueSummaryInput): string {
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

/** What a row calls the bookmark when no title survived. */
export function issueTitleCopy(issue: Pick<SyncIssueDiagnostic, 'title' | 'nodeId'>): string {
  return issue.title?.trim() || (issue.nodeId
    ? t('syncIssue_libraryBookmark', 'A bookmark in your library') : t('syncIssue_deviceBookmark', 'A bookmark on this device'));
}

/** A merge upload the server or this browser refused: the sentence first, the code after it. */
export function mergeResolutionFailureCopy(code: string): string {
  return t('firstRun_mergeResolutionFailed', 'That upload did not go through. $1 ($2)', issueSummaryCopy({ code, direction: 'push' }), code);
}
