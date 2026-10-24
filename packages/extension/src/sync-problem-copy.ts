import { formatMoment, t } from './i18n.js';
import type { SyncProblemFamily } from './sync-problem-families.js';

/**
 * The words for `sync-problem-catalog.ts`: one sentence per family, a sentence
 * of their own for the few codes where the family would be vague, and the
 * closing clause that says what happens by itself or what to press. Every call
 * carries its literal key and English so `scripts/i18n-catalog.mjs` can read it.
 */
export interface SyncProblemNext {
  /** The engine's own deadline for its next attempt (epoch milliseconds). */
  readonly retryAt?: number;
  /** False once the engine has stopped instead of backing off. */
  readonly retryAutomatic?: boolean;
  /** The Reset button is on this card. */
  readonly resetOffered?: boolean;
  /** This surface has no Reset button, but the Status tab does. */
  readonly resetInStatus?: boolean;
  /** Why Reset is not on the card, when one was needed (`rebuildUnavailableReason`). */
  readonly resetUnavailableReason?: string;
  readonly now: number;
}

export const FAMILY_WHAT: Readonly<Record<SyncProblemFamily, () => string>> = {
  offline: () => t('syncProblem_offline', "Sync can't reach the server right now."),
  server_busy: () => t('syncProblem_serverBusy', "The server didn't answer properly, or asked sync to slow down."),
  waiting: () => t('syncProblem_waiting', 'Sync is waiting for something on this device to finish.'),
  permission: () => t('syncProblem_permission', 'Sync needs permission to read and change your bookmarks.'),
  authority: () => t('syncProblem_authority', 'Sync is renewing its access to your library.'),
  sign_in: () => t('syncProblem_signIn', 'Your sign-in no longer works for sync.'),
  retired: () => t('syncProblem_retired', 'This browser was stopped from the Sync center, so it no longer syncs.'),
  integrity_pull: () => t('syncProblem_integrityPull', 'Changes from your library failed a safety check, so this device stopped taking them in.'),
  integrity_snapshot: () => t('syncProblem_integritySnapshot', 'The copy of your library that the server sent failed a safety check, so this device stopped using it.'),
  item_mapping: () => t('syncProblem_itemMapping', 'A change from your library refers to a bookmark or folder this device does not know yet.'),
  rebuild: () => t('syncProblem_rebuild', "This device's record of which bookmark is which no longer matches your library, so sync stopped before it could do any harm."),
  decide: () => t('syncProblem_decide', 'A bookmark needs your decision before sync can continue.'),
  confirm: () => t('syncProblem_confirm', 'A change from your library is waiting for your answer.'),
  codec: () => t('syncProblem_codec', "A bookmark has a value sync can't store, such as a very long title or address."),
  stop_upload: () => t('syncProblem_stopUpload', 'Sync on this device stopped because its record of changes waiting to upload failed an internal check.'),
  stop_download: () => t('syncProblem_stopDownload', 'Sync on this device stopped because its record of changes from your library failed an internal check.'),
  stop_first_sync: () => t('syncProblem_stopFirstSync', 'Sync on this device stopped because the setup of your first sync, an import or your folder choice failed an internal check.'),
  stop_feature: () => t('syncProblem_stopFeature', 'Sync on this device stopped because a bookmark management step failed an internal check.'),
  stop_local: () => t('syncProblem_stopLocal', 'Sync on this device stopped because the sync data stored in this browser failed an internal check.'),
  unknown: () => t('syncProblem_unknown', 'Sync ran into a problem it has no description for.'),
};

/** Codes whose family sentence would be too vague. */
export const CODE_WHAT: Readonly<Record<string, () => string>> = {
  pull_apply_target_missing: () => t('syncProblem_applyTargetMissing', 'A bookmark that a change from your library refers to is no longer on this device.'),
  pull_apply_evidence_missing: () => t('syncProblem_applyEvidenceMissing', "Sync couldn't read the folder it needed to apply a change from your library."),
  create_ambiguous: () => t('syncProblem_createAmbiguous', "Sync can't tell which of several identical bookmarks on this device is the one it just created."),
  create_evidence_missing: () => t('syncProblem_createEvidenceMissing', "Sync can't confirm that a bookmark it just created is on this device."),
  create_placement_parent_deleted: () => t('sync_syncDeviceHasStopped', 'Sync on this device has stopped: the saved bookmark’s original folder or position cannot be confirmed. Its save location needs review.'),
  create_placement_unproven: () => t('sync_syncDeviceHasStopped', 'Sync on this device has stopped: the saved bookmark’s original folder or position cannot be confirmed. Its save location needs review.'),
  recovery_identity_unproven: () => t('sync_syncDeviceHasStopped5', 'Sync on this device has stopped: this device cannot verify local bookmarks match cloud items.'),
  deletion_identity_unproven: () => t('sync_syncDeviceHasStopped4', 'Sync on this device has stopped: this device cannot verify the bookmark to delete matches the cloud item.'),
  delete_subtree_changed: () => t('syncProblem_deleteSubtreeChanged', 'A folder was deleted on this device, but it gained bookmarks on another device first, so sync held the deletion.'),
  managed_not_writable: () => t('syncProblem_managedNotWritable', "This bookmark is managed by your browser or organization, so sync can't change it."),
  mapping_identity_collision: () => t('syncProblem_internalMismatch', 'Sync on this device stopped because of an internal mismatch.'),
  legacy_resolution_sequence_collision: () => t('syncProblem_internalMismatch', 'Sync on this device stopped because of an internal mismatch.'),
  payload_too_large: () => t('sync_syncDeviceHasStopped2', 'Sync on this device has stopped: the transfer size exceeds supported limits. Retrying will not change the result.'),
  pull_issue_ceiling: () => t('syncProblem_ceiling', 'Sync on this device has stopped: it set aside too many items to keep syncing safely.'),
  sync_issue_ceiling: () => t('syncProblem_ceiling', 'Sync on this device has stopped: it set aside too many items to keep syncing safely.'),
  replica_rebuild_pending: () => t('syncProblem_rebuildPending', "The sync reset isn't finished. Your bookmarks are safe."),
  replica_retired: () => t('syncProblem_replicaRetired', 'This browser was stopped from the Sync center, so it no longer syncs.'),
  resource_not_found: () => t('syncProblem_resourceNotFound', "The server doesn't recognize this browser's sync copy."),
  origin_not_allowed: () => t('syncProblem_originNotAllowed', "The server doesn't accept connections from this extension."),
  insufficient_scope: () => t('syncProblem_insufficientScope', "Your sign-in isn't allowed to sync bookmarks."),
  session_invalid: () => t('syncProblem_sessionInvalid', "The server didn't accept this browser's sync session. This happens when the computer's clock is far off or the extension is out of date."),
  bookmark_api_error: () => t('syncProblem_bookmarkApiError', 'The browser refused to apply a change from your library to a bookmark.'),
  snapshot_native_projection_ambiguous: () => t('syncProblem_nativeProjectionAmbiguous', "Sync can't tell which bookmark on this device matches one from your library."),
  operation_byte_budget_exceeded: () => t('syncProblem_byteBudget', 'A bookmark change is too large to upload.'),
  sync_failed: () => t('syncProblem_syncFailed', 'Sync failed for a reason it did not record.'),
};

/** Codes whose whole sentence was written for them, next step included. */
export const CODE_WHOLE: Readonly<Record<string, () => string>> = {
  metadata_sync_disabled: () => t('sync_metadataConsentStopped', 'A queued change contains browser metadata that you have not allowed to sync. Reset sync on this device to set aside queued changes and review the merge again. Your bookmarks and local metadata are preserved.'),
};

/** Codes where the family's closing clause would point at an exit that does not help. */
export const CODE_NEXT: Readonly<Record<string, (context: SyncProblemNext) => string>> = {
  payload_too_large: () => t('syncProblem_nextTooLarge', 'Copy details and send them to whoever runs your Know-N server.'),
  pull_issue_ceiling: ceilingClause,
  sync_issue_ceiling: ceilingClause,
  replica_rebuild_pending: (context) => context.resetOffered
    ? t('syncProblem_nextFinishReset', 'Press Reset sync on this device to finish it.')
    : t('syncProblem_nextFinishResetElsewhere', 'Finish it from the Sync center on the web.'),
};

function ceilingClause(context: SyncProblemNext): string {
  return context.resetOffered
    ? t('syncProblem_nextCeiling', 'Try again, release or dismiss some of the items below and sync continues by itself. Or reset sync on this device: your bookmarks stay, and changes that have not synced yet are set aside.')
    : t('syncProblem_nextCeilingNoReset', 'Try again, release or dismiss some of the items below and sync continues by itself.');
}

/** The clause after the sentence: what happens by itself, or what to press. */
export function nextClause(family: SyncProblemFamily, context: SyncProblemNext): string {
  const waits = context.retryAt !== undefined && context.retryAt > context.now;
  const time = waits ? formatMoment(context.retryAt!, 'time') : '';
  switch (family) {
    case 'offline': case 'server_busy': case 'waiting': case 'authority': case 'unknown':
      if (context.retryAutomatic === false) {
        return waits ? t('syncProblem_nextCooling', 'It paused after repeated errors and will try again at $1. Retry sync tries now.', time)
          : t('syncProblem_nextHalted', 'It stopped after repeated errors. Retry sync tries again now.');
      }
      return waits ? `${t('syncProblem_nextByItself', 'It will retry automatically.')} ${t('sync_recoveryNextAttempt', 'Next attempt: $1.', time)}`
        : t('syncProblem_nextByItself', 'It will retry automatically.');
    case 'permission': return t('syncProblem_nextPermission', 'Allow bookmark access in the Folders tab and sync resumes.');
    case 'sign_in': return t('syncProblem_nextSignIn', 'Sign in again from Account and sync resumes.');
    case 'retired': case 'rebuild': case 'decide': return resetClause(context);
    case 'confirm': return t('syncProblem_nextConfirm', 'Answer it under Waiting for you or Deletions below.');
    case 'integrity_pull': case 'integrity_snapshot':
      return `${t('syncProblem_nextCheckAgain', 'Retry sync checks with the server again.')} ${keepsStoppingClause(context)}`;
    default:
      return `${t('syncProblem_nextMayStopAgain', 'Retry sync tries once more, but it may stop the same way.')} ${keepsStoppingClause(context)}`;
  }
}

function keepsStoppingClause(context: SyncProblemNext): string {
  return context.resetOffered
    ? t('syncProblem_nextKeepsStoppingReset', 'If it keeps stopping, copy details and reset sync on this device. Your bookmarks stay either way.')
    : t('syncProblem_nextKeepsStoppingDetails', 'If it keeps stopping, copy details to investigate. Your bookmarks are not affected.');
}

/** A Reset this card may or may not offer: the sentence never promises a button that is not there. */
function resetClause(context: SyncProblemNext): string {
  if (context.resetInStatus) {
    return t('syncProblem_nextResetInStatus', 'Open Sync, then Status, and press Reset sync on this device to continue. Your bookmarks stay; changes that have not synced yet are set aside and not retried.');
  }
  if (context.resetOffered) {
    return t('syncProblem_nextReset', 'Reset sync on this device to continue. Your bookmarks stay; changes that have not synced yet are set aside and not retried.');
  }
  return context.resetUnavailableReason === 'upload_outcome_unsettled' || context.resetUnavailableReason === 'native_outcome_unsettled'
    ? t('syncProblem_nextResetBlocked', 'Reset is not available on this device yet: a change sent to the server has no confirmed result. Reset it from the Sync center on the web.')
    : t('syncProblem_nextResetElsewhere', 'Reset it from the Sync center on the web.');
}
