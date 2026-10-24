import type { SyncReplicaIssue } from '../../api'

/**
 * Plain words for why a browser stopped, what an item it set aside is waiting
 * for, and how a request sent to it ended.
 *
 * A browser reports a code. The table that classifies those codes lives in the
 * extension (`packages/extension/src/sync-failure-class.ts`), so this page reads
 * a code's family from the lists below and from its spelling, mirroring
 * `packages/extension/src/sync-problem-families.ts`. `problems.test.ts` walks the
 * extension's table, so a code added there can never reach this page as a bare
 * “it reported x”: it lands in a family, and a code no family knows still gets a
 * sentence with the code in brackets.
 */
export type ProblemFamily =
  | 'offline' | 'server_busy' | 'waiting' | 'permission' | 'authority' | 'sign_in' | 'retired'
  | 'integrity_pull' | 'integrity_snapshot' | 'item_mapping' | 'rebuild' | 'decide' | 'confirm' | 'codec'
  | 'stop_upload' | 'stop_download' | 'stop_first_sync' | 'stop_feature' | 'stop_local' | 'stalled' | 'unknown'

const list = (words: string): ReadonlySet<string> => new Set(words.split(/\s+/u).filter(Boolean))

const OFFLINE = list('network_unavailable push_network_failed pull_transport_unavailable indexeddb_unavailable')
const SERVER_BUSY = list(`server_unavailable rate_limited service_unavailable internal_error push_batch_timeout
  push_batch_response_unknown request_failed pull_failed manifest_unavailable push_dispatch_failed push_response_unrecognized`)
const PERMISSION = list('permission_required permission_revoked')
const SIGN_IN = list(`credential_revoked authentication_required insufficient_scope session_invalid origin_not_allowed
  server_configuration_failed`)
const RETIRED = list('replica_retired resource_not_found')
/** Told by the extension's watchdog, not by its engine: nothing short of looking into it helps. */
const STALLED = list('sync_stuck sync_not_completing')
const WAITING = list(`position_context_stale revision_conflict concurrent_local_mutation push_batch_prefix_pending ack_pending
  action_unavailable advanced_plan_changed advanced_plan_completed advanced_plan_in_progress authority_rebase_not_required
  batch_in_progress bootstrap_confirmation_stale command_in_flight commit_outcome_unknown engine_revision_stale
  exact_retry_pending fault_injected generation_mismatch intent_correlation_active move_predecessor_pending native_call_failed
  native_result_cas projection_apply_barrier projection_generation_fenced pull_page_pending push_batch_placement_changed
  push_batch_recovery_barrier queue_recovery_frozen quota_exceeded range_dependency_pending remote_delete_command_pending
  remote_delete_decision_stale remote_delete_generation_fenced remote_delete_policy_stale remote_delete_revision_stale
  session_handoff_pending stale_fence stale_ref sync_paused transaction_aborted`)
const AUTHORITY = list(`snapshot_expired sync_cursor_expired need_authority recovery_required recovery_capability_premature
  recovery_capability_invalid recovery_authority_invalid effect_page_transport_unavailable stale_replica
  push_authentication_rejected push_denial_escalated push_scope_mismatch push_authority_expired push_authority_denied
  push_authority_response_invalid push_authentication_refresh_required push_authentication_exhausted push_denial_unrecognized
  push_session_unavailable push_session_refresh_failed lease_authority_invalid recovery_authority_not_activated
  scope_mismatch session_authority_invalid`)
const CONFIRM = list('remote_delete_confirmation_required native_result_unknown')
const DECIDE = list(`recovery_identity_unproven deletion_identity_unproven create_placement_parent_deleted
  create_placement_unproven delete_subtree_changed managed_not_writable`)
const REBUILD = list(`pull_apply_target_missing pull_apply_evidence_missing anchor_mapping_missing create_ambiguous
  create_evidence_missing snapshot_content_target_missing snapshot_placement_local_identity_unproven
  snapshot_placement_target_missing mapping_identity_conflict mapping_identity_collision legacy_resolution_sequence_collision
  payload_too_large pull_issue_ceiling sync_issue_ceiling metadata_sync_disabled replica_rebuild_pending`)
/** `mapping_missing:subtree_root` travels as `mapping_missing_subtree_root`: a report code is one lowercase word. */
const ITEM_MAPPING = list(`anchor_parent_mismatch unmounted_restore_repair preflight_parent_mapping_missing
  preflight_target_mapping_missing preflight_member_mapping_missing deletion_mapping_missing mapping_missing_subtree_root
  mapping_missing_parent parent_mapping_missing parent_revision_mapping_missing target_mapping_missing`)
const CODEC = list('bounded_string_invalid secret_field_forbidden i_json_invalid record_too_large operation_schema_invalid')
/** A Pull page or Snapshot that failed a safety check; `snapshot_*` ones are about the server's copy. */
const INTEGRITY = list(`pull_page_invalid effect_page_invalid pull_event_invalid pull_event_duplicate pull_event_conflict
  pull_effect_binding_invalid pull_effect_kind_invalid pull_cursor_chain_invalid pull_source_binding_invalid
  unexpected_effect_page pull_page_reuse effect_page_failed snapshot_page_missing refuse_rewind refuse_stale_chain
  private_root_mapping_missing snapshot_chain_invalid snapshot_conflict_confirm_invalid snapshot_conflict_page_invalid
  snapshot_content_baseline_missing snapshot_cutover_missing snapshot_graph_incomplete snapshot_identity_conflict
  snapshot_invalid snapshot_node_duplicate snapshot_parent_authority_invalid snapshot_parent_authority_missing
  snapshot_parent_mapping_missing snapshot_placement_baseline_missing snapshot_placement_boundary
  snapshot_placement_children_fence_missing snapshot_placement_parent_missing snapshot_root_mapping_missing
  snapshot_semantic_invalid snapshot_session_scope_mismatch`)
/** Stop codes whose first word names no area. */
const STOP_LOCAL = list(`archive_not_found canonical_json_invalid conflict_resolution_binding_invalid constraint corruption_detected
  delete_journal_invalid diagnostic_read_only digest_mismatch engine_state_invalid engine_state_missing environment_invalid
  future_schema identity_conflict journal_kind_invalid journal_scope_invalid lease_result_missing lifecycle_invalid
  lifecycle_transition_invalid limit_exceeded live_work_invalid mapping_scope_invalid object_invalid request_invalid
  retry_invalid scope_not_found scope_retired server_origin_invalid unknown_or_missing_field unsafe_integer upgrade_failed`)

/** The area a stop code belongs to, read off its first word (the same rule the extension uses). */
const STOP_AREAS: readonly (readonly [ProblemFamily, RegExp])[] = [
  ['stop_upload', /^(?:push_|queue_|attempt_|authoritative_|bookmark_event_|recapture_|receipt_|op_id_|operation_|sequence_|set_aside_)/u],
  ['stop_download', /^(?:pull_|ack_|effect_|cursor_|page_chain|recovery_|replay_|reorder_|projection_|provisional_|observation_|attention_page|intent_|native_result|node_kind|resource_revision|snapshot_|separator_|private_ancestry)/u],
  ['stop_first_sync', /^(?:bootstrap_|advanced_|import_|preview_|first_run|pause_|preformal|root_|selected_roots|private_roots|discovered_roots|mount_|legacy_store)/u],
  ['stop_feature', /^(?:batch_|command_|remote_delete_|ingress_|native_wait_|exclusion_)/u],
]
/** The shapes the extension synthesises for a Snapshot request the server answered with an error. */
const SYNTHESISED_SNAPSHOT = /^snapshot_(?:\d{3}_|http_\d{3}$)/u

/** The family of one reported code. Total: every string has one. */
export function problemFamily(code: string | null | undefined): ProblemFamily {
  if (!code) return 'unknown'
  if (RETIRED.has(code)) return 'retired'
  if (STALLED.has(code)) return 'stalled'
  if (REBUILD.has(code)) return 'rebuild'
  if (SIGN_IN.has(code)) return 'sign_in'
  if (PERMISSION.has(code)) return 'permission'
  if (OFFLINE.has(code)) return 'offline'
  if (SERVER_BUSY.has(code)) return 'server_busy'
  if (WAITING.has(code)) return 'waiting'
  if (AUTHORITY.has(code)) return 'authority'
  if (CONFIRM.has(code)) return 'confirm'
  if (DECIDE.has(code)) return 'decide'
  if (ITEM_MAPPING.has(code)) return 'item_mapping'
  if (CODEC.has(code)) return 'codec'
  if (INTEGRITY.has(code)) return code.startsWith('snapshot_') ? 'integrity_snapshot' : 'integrity_pull'
  if (SYNTHESISED_SNAPSHOT.test(code)) return 'integrity_snapshot'
  if (STOP_LOCAL.has(code)) return 'stop_local'
  return STOP_AREAS.find(([, pattern]) => pattern.test(code))?.[0] ?? 'unknown'
}

/** What a stopped browser's reason reads like after “Sync on this browser has stopped:”. */
const FAMILY_REASON: Readonly<Record<ProblemFamily, string>> = {
  offline: 'it couldn’t reach the server several times in a row.',
  server_busy: 'the server kept failing or asking it to slow down.',
  waiting: 'something on that browser kept it from finishing, several times in a row.',
  permission: 'it needs permission to read and change bookmarks.',
  authority: 'it kept failing to renew its access to your library.',
  sign_in: 'its sign-in no longer works for sync.',
  retired: 'this browser was stopped, so it no longer syncs.',
  integrity_pull: 'changes it downloaded from your library failed a safety check, so it stopped taking them in.',
  integrity_snapshot: 'the copy of your library the server sent failed a safety check, so it stopped using it.',
  item_mapping: 'a change from your library refers to a bookmark or folder it doesn’t know yet.',
  rebuild: 'its record of which bookmark is which no longer matches your library.',
  decide: 'a bookmark needs a decision before it can go on.',
  confirm: 'a change from your library is waiting for an answer.',
  codec: 'a bookmark has a value it can’t store, such as a very long title or address.',
  stop_upload: 'its record of changes waiting to upload failed an internal check.',
  stop_download: 'its record of changes from your library failed an internal check.',
  stop_first_sync: 'the setup of its first sync, an import or the folder choice failed an internal check.',
  stop_feature: 'a bookmark management step failed an internal check.',
  stop_local: 'the sync data stored in that browser failed an internal check.',
  stalled: 'it has stopped making progress and hasn’t said why.',
  unknown: 'it reported a problem that has no description yet.',
}

/** Codes where the family's sentence would be too vague; written for them, as the extension's own card does. */
const CODE_REASON: Readonly<Record<string, string>> = {
  create_placement_unproven: 'it can’t tell where a saved bookmark belongs.',
  create_placement_parent_deleted: 'a saved bookmark’s folder was deleted before the bookmark synced.',
  recovery_identity_unproven: 'it can’t match a bookmark in the browser with its copy here.',
  deletion_identity_unproven: 'it can’t confirm which bookmark a deletion was for.',
  delete_subtree_changed: 'a folder deleted there gained bookmarks on another device first, so it held the deletion.',
  managed_not_writable: 'a bookmark is managed by that browser or its organization, so sync can’t change it.',
  payload_too_large: 'an item is too large to sync.',
  target_unavailable: 'the library it syncs with isn’t available.',
  replica_rebuild_pending: 'its copy of your library is being rebuilt.',
  pull_issue_ceiling: 'it set aside too many items to keep syncing safely.',
  sync_issue_ceiling: 'it has too many unresolved items to keep syncing safely.',
  snapshot_invalid: 'the server’s Snapshot failed integrity checks. Retry after the source is repaired, or rebuild this browser’s copy.',
  snapshot_graph_incomplete: 'the server’s Snapshot has an incomplete library graph.',
  snapshot_chain_invalid: 'the server’s Snapshot pages do not form a valid chain.',
  replica_rebuilt: 'its sync was reset.',
  sync_diagnostics_unavailable: 'it can’t read its local sync status. It will retry reporting automatically.',
  sync_stopped: 'it stopped and didn’t record why.',
  sync_stuck: 'the oldest change waiting to upload hasn’t moved for a while.',
  sync_not_completing: 'it hasn’t finished a pass in over an hour, and nothing says why.',
  sync_failed: 'sync failed and the browser didn’t record why.',
  metadata_sync_disabled: 'a queued change contains browser metadata you haven’t allowed to sync. Reset sync on that browser to set aside queued changes and review the merge again.',
  pull_apply_target_missing: 'a bookmark that a change from your library refers to is no longer in that browser, so its copy of your library needs a rebuild.',
  pull_apply_evidence_missing: 'it couldn’t read the folder it needed to apply a change from your library, so its copy of your library needs a rebuild.',
  create_ambiguous: 'it can’t tell which of several identical bookmarks is the one it just created, so its copy of your library needs a rebuild.',
  create_evidence_missing: 'it can’t confirm that a bookmark it just created is in that browser, so its copy of your library needs a rebuild.',
  mapping_identity_collision: 'it stopped because of an internal mismatch, so its copy of your library needs a rebuild.',
  legacy_resolution_sequence_collision: 'it stopped because of an internal mismatch, so its copy of your library needs a rebuild.',
  anchor_mapping_missing: 'its copy of your library needs a rebuild.',
  mapping_identity_conflict: 'its copy of your library needs a rebuild.',
  snapshot_projection_incomplete: 'its copy of your library needs a rebuild.',
  record_too_large: 'a bookmark in it can’t be stored.',
  bounded_string_invalid: 'a bookmark in it can’t be stored.',
  secret_field_forbidden: 'a bookmark in it can’t be stored.',
  i_json_invalid: 'a bookmark in it can’t be stored.',
  operation_schema_invalid: 'a bookmark in it can’t be stored.',
  operation_byte_budget_exceeded: 'a bookmark in it can’t be stored.',
  replica_retired: 'this browser was stopped, so it no longer syncs.',
  resource_not_found: 'the server doesn’t recognize this browser’s sync copy.',
  origin_not_allowed: 'the server doesn’t accept connections from its extension.',
  insufficient_scope: 'its sign-in isn’t allowed to sync bookmarks.',
  session_invalid: 'the server didn’t accept its sync session. That happens when the computer’s clock is far off or the extension is out of date.',
  bookmark_api_error: 'the browser refused to apply a change from your library to a bookmark.',
  snapshot_native_projection_ambiguous: 'it can’t tell which bookmark in that browser matches one from your library.',
}

/** The reason a browser gave for stopping, in plain words. A code with no words of its own reads as its family, code in brackets. */
export function stopReason(code: string | null | undefined): string {
  if (!code) return 'it didn’t say why.'
  const own = CODE_REASON[code]
  if (own) return own
  return `${FAMILY_REASON[problemFamily(code)].slice(0, -1)} (${code}).`
}

type Offered = readonly string[]

/** What to do next, after the reason: a sign-in, a permission, a reset, or just the buttons below. */
export function stopNext(code: string | null | undefined, offered: Offered): string {
  const retry = offered.includes('retry')
  switch (problemFamily(code)) {
    case 'sign_in': return 'Open the extension on that browser and sign in again.'
    case 'permission': return 'Open the extension on that browser and allow bookmark access.'
    case 'offline': case 'server_busy': case 'waiting': case 'authority':
      return retry ? 'It tries again by itself; Retry below tries now.' : 'It tries again by itself.'
    case 'stalled': return retry ? 'Retry below tries now. If it stays this way, open the extension on that browser and copy its details.'
      : 'Open the extension on that browser and copy its details.'
    case 'rebuild': return offered.includes('rebuild')
      ? 'Reset sync below to continue. That browser keeps its bookmarks; changes it hasn’t synced yet are archived and not retried.'
      : 'Open the extension on that browser to reset its sync.'
    default: return offered.length > 0 ? 'Try the options below, or open the extension on that browser.'
      : 'Open the extension on that browser to fix it.'
  }
}

/** True for a time worth showing: the browser sends the epoch where it has no honest timestamp. */
export function isRealInstant(value: string | null | undefined): value is string {
  const time = value ? Date.parse(value) : Number.NaN
  return Number.isFinite(time) && time >= Date.UTC(2000, 0, 1)
}

const UNSETTLED_UPLOAD = 'a change that browser sent has no confirmed result yet, so it can’t reset safely. Try Retry first, then reset once that change settles'
const RESULT_REASONS: Readonly<Record<string, string>> = {
  stale_ref: 'that browser switched libraries, accounts, or sync copies before it ran',
  authority_fenced: 'that browser changed its sign-in before it ran',
  action_unavailable: 'that browser no longer offered it',
  issue_gone: 'the item had already cleared',
  command_interrupted: 'the browser stopped before it finished',
  rebuild_not_required: 'its sync no longer needed a reset',
  upload_outcome_unsettled: UNSETTLED_UPLOAD,
  native_outcome_unsettled: 'a bookmark change in that browser is waiting for your answer there. Answer it in the extension, then reset',
  rebuild_failed: 'the reset didn’t finish and the browser didn’t say why. Its bookmarks are untouched; try again, or open the extension on that browser',
  command_failed: 'the browser hit an unexpected error while carrying it out',
  command_context_missing: 'the browser wasn’t ready to run it. Try again in a minute',
  account_switch: 'that browser is signed in to a different account now',
  not_connected: 'that browser isn’t signed in',
}

/** Why a request to a browser failed, in plain words; a code nobody wrote words for still reads as a sentence. */
export function resultReason(code: string): string {
  return RESULT_REASONS[code] ?? `the browser couldn’t carry it out (${code})`
}

type IssueSummaryInput = Pick<SyncReplicaIssue, 'code' | 'direction' | 'actions'> & Partial<SyncReplicaIssue>

/** One sentence for one item a browser set aside, in the same vocabulary as the extension's own list. */
export function issueSummary(issue: IssueSummaryInput): string {
  switch (issue.code) {
    case 'remote_delete_confirmation_required': return 'Waiting for a deletion decision in the extension: delete, restore, or keep on this browser'
    case 'conflict_pending': return 'Waiting for a conflict to be resolved'
    case 'conflict_hold': return 'Waiting for a conflict on this bookmark to be resolved'
    case 'dependency_hold': return 'Waiting for an earlier change to it that couldn’t sync'
    case 'parent_set_aside': return 'Its folder couldn’t be added to this browser'
    case 'create_placement_parent_deleted': return 'Its folder was deleted before it synced'
    case 'create_placement_unproven': return 'Its place in the folder couldn’t be confirmed'
    case 'recovery_identity_unproven': return 'It couldn’t be matched with one saved bookmark'
    case 'deletion_identity_unproven': return 'Deleted on that browser, but it couldn’t be matched, so nothing else was deleted'
    case 'delete_subtree_changed': return 'Deleted on that browser, but the folder changed elsewhere first. Retry deletes it anyway, with those changes'
    case 'record_too_large': return 'Too large for this browser to store'
    case 'managed_not_writable': return 'This bookmark is managed by the browser and cannot be changed here'
    case 'bounded_string_invalid': return 'A field is too long for this browser to store'
    case 'secret_field_forbidden': return 'A field looks like a password or key, so it is not synced'
    case 'native_result_unknown': return 'Waiting for a decision in the browser'
    case 'local_merge_difference': return 'Review this local merge difference in the extension’s Sync → Folders list. It is not a server conflict.'
    case 'duplicate_candidate': return 'Review possible duplicates in the extension’s Sync → Folders list.'
    case 'dependency_pending': case 'dependency_parked': return 'Waiting for an earlier operation; the browser checks its dependency automatically'
    case 'sequence_blocked': return 'An earlier deferred operation holds this upload sequence. Exact retries are bounded; Retry checks again without changing its identity.'
    case 'resource_id_unavailable': return 'The server consumed this operation but refused its resource identity. The change has not been applied.'
    case 'waiting_dependency': return 'Waiting for another change to finish'
    // A sent change the server keeps unsettled; the browser's later uploads wait behind it.
    case 'push_deferred': return 'The server keeps deferring this change; later uploads from that browser wait behind it'
    case 'sequence_gap': return 'The server is waiting for an earlier change first; later uploads from that browser wait behind it'
    case 'push_response_unrecognized': case 'push_result_processing_failed': case 'push_problem_status_mismatch':
    case 'push_batch_response_invalid': case 'push_stalled':
      return 'The server’s answer to this change couldn’t be settled; later uploads from that browser wait behind it'
  }
  // `apply_failed:<code>` travels as `apply_failed_<code>`: the browser refused a call while applying a change.
  if (issue.code.startsWith('apply_failed')) return 'The browser refused to apply this change from your library, so it was set aside'
  // A held upload that offers Retry never reached the server: the browser could not get it ready.
  if (issue.direction === 'push') return issue.actions.includes('retry')
    ? 'That browser couldn’t get it ready to upload'
    : 'The server didn’t accept this change'
  if (issue.direction === 'pull') return 'Couldn’t be applied in the browser'
  return 'Couldn’t be prepared for sync'
}

/** A browser stops syncing above this many open items, and its Status tab warns from the lower number. */
export const SYNC_ISSUE_WARNING = 150
export const SYNC_ISSUE_LIMIT = 200

/** The line before (or at) the limit: how many items are open, and where they can be cleared in bulk. */
export function issueLimitNote(total: number): string | undefined {
  if (total < SYNC_ISSUE_WARNING) return undefined
  return `This browser has ${total} open items. It stops syncing above ${SYNC_ISSUE_LIMIT}. In the extension, open Sync, then Status, and use Try again or Dismiss to clear some.`
}
