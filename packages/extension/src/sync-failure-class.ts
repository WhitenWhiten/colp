/**
 * How much one sync failure stops, decided once per code.
 *
 * Before this table a code was classified by whichever of five lists its
 * author remembered (the Pull freeze set, the unproven-identity gate, the
 * rebuild exit, the persistent local failure, the inbound Pull hold). Every
 * behaviour is now read off one entry: its class says what the failure is
 * about, its exit says what ends it.
 *
 * - transient: the network or the server is busy; backoff, as before.
 * - authority: the Session, cursor or Snapshot authority must be renewed.
 * - item: one bookmark, event or record. Where the failure has a subject it is
 *   set aside at its write site and only reaches the engine without one.
 * - replica: the stream or the local replica itself is broken.
 */
export type SyncFailureClass = 'transient' | 'authority' | 'item' | 'replica';

/**
 * - retry: ends by itself.
 * - refresh: fresh Session or Snapshot authority ends it.
 * - decide: a person decides about one bookmark; its dependent work stays held.
 * - confirm: a person answers a prompt that Pull itself raised, while the engine keeps waking.
 * - rebuild: only a user-confirmed replica rebuild ends it.
 * - stop: nothing short of a fix; retrying gives the same result.
 */
export type SyncFailureExit = 'retry' | 'refresh' | 'decide' | 'confirm' | 'rebuild' | 'stop';

export interface SyncFailureEntry {
  readonly class: SyncFailureClass;
  readonly exit: SyncFailureExit;
  /** Thrown while a Pull page applies, it freezes the scope for recovery instead of retrying the page. */
  readonly freezesPull?: true;
  /** While it is the last error, a wake may still take in changes. */
  readonly pullsOnWake?: true;
  /**
   * Thrown while one Pull event applies, before the browser was changed for
   * it, it sets that event's node aside instead of stopping the page (B5).
   */
  readonly setsAsidePull?: true;
  /** Missing local evidence may stage as an item; structural page failures never do. */
  readonly stagesAsItem?: true;
}

const entry = (failureClass: SyncFailureClass, exit: SyncFailureExit,
  flags: Omit<SyncFailureEntry, 'class' | 'exit'> = {}): SyncFailureEntry =>
  Object.freeze({ class: failureClass, exit, ...flags });
const FREEZES = { freezesPull: true } as const;
const SETS_ASIDE = { freezesPull: true, setsAsidePull: true } as const;

export const SYNC_FAILURE_TABLE = Object.freeze({
  server_unavailable: entry('transient', 'retry'),
  network_unavailable: entry('transient', 'retry', { pullsOnWake: true }),
  position_context_stale: entry('transient', 'retry', { pullsOnWake: true }),
  revision_conflict: entry('transient', 'retry', { pullsOnWake: true }),
  rate_limited: entry('transient', 'retry'),
  concurrent_local_mutation: entry('transient', 'retry'),

  snapshot_expired: entry('authority', 'refresh', FREEZES),
  sync_cursor_expired: entry('authority', 'refresh', FREEZES),
  need_authority: entry('authority', 'refresh', FREEZES),
  recovery_required: entry('authority', 'refresh', FREEZES),
  recovery_capability_premature: entry('authority', 'refresh', FREEZES),
  recovery_capability_invalid: entry('authority', 'refresh', FREEZES),
  recovery_authority_invalid: entry('authority', 'refresh', FREEZES),
  effect_page_transport_unavailable: entry('authority', 'refresh', FREEZES),
  stale_replica: entry('authority', 'refresh'),
  push_authentication_rejected: entry('authority', 'refresh'),
  push_denial_escalated: entry('authority', 'refresh'),
  push_scope_mismatch: entry('authority', 'refresh'),
  // Push settlement reasons about the browser's authority or connectivity, never about one change:
  // a never-sent change is not held for them, and a sent change waiting on them is not a stalled upload.
  push_authority_expired: entry('authority', 'refresh'),
  push_authority_denied: entry('authority', 'refresh'),
  push_authority_response_invalid: entry('authority', 'refresh'),
  push_authentication_refresh_required: entry('authority', 'refresh'),
  push_authentication_exhausted: entry('authority', 'refresh'),
  push_denial_unrecognized: entry('authority', 'refresh'),
  push_session_unavailable: entry('authority', 'refresh'),
  push_session_refresh_failed: entry('authority', 'refresh'),
  push_network_failed: entry('transient', 'retry'),
  push_batch_prefix_pending: entry('transient', 'retry'),
  // A hook or endpoint discovery that failed before the request left, or a server that cannot
  // answer right now: neither is the change's fault, so neither holds it or reports it as stalled.
  push_dispatch_failed: entry('transient', 'retry'),
  push_server_unavailable: entry('transient', 'retry'),
  push_attempt_missing: entry('transient', 'retry'),
  // W2C: replacing a sent change's attempt after an authentication denial would have changed its bytes. The
  // change may be on the server, so it stays bound; the lane waits and the stalled-upload report names it.
  push_attempt_operation_changed: entry('replica', 'stop'),
  // One change leaves the lane as an item: the network kept refusing its request (A-F2), or an
  // upload policy / local check refused it again and again (A-F7). The rest of the lane goes on.
  push_request_refused: entry('item', 'decide'),
  push_attempt_bind_failed: entry('item', 'decide'),
  push_media_type_invalid: entry('item', 'decide'),
  subscription_upload_excluded: entry('item', 'decide'),
  bootstrap_upload_excluded: entry('item', 'decide'),
  bootstrap_boundary_unavailable: entry('item', 'decide'),
  // The server's answer to a sent change cannot be read or settled: the same bytes get the same
  // answer, so the head is reported as a stalled upload instead of being retried unseen.
  push_response_invalid: entry('replica', 'stop'),
  push_response_unrecognized: entry('replica', 'stop'),
  push_problem_invalid: entry('replica', 'stop'),
  push_problem_status_mismatch: entry('replica', 'stop'),
  push_result_processing_failed: entry('replica', 'stop'),

  recovery_identity_unproven: entry('item', 'decide', FREEZES),
  deletion_identity_unproven: entry('item', 'decide', FREEZES),
  create_placement_parent_deleted: entry('item', 'decide'),
  create_placement_unproven: entry('item', 'decide'),
  // A folder deleted here gained members on another device first; Retry deletes it anyway.
  delete_subtree_changed: entry('item', 'decide'),
  remote_delete_confirmation_required: entry('item', 'confirm', FREEZES),
  pull_apply_target_missing: entry('item', 'rebuild', SETS_ASIDE),
  pull_apply_evidence_missing: entry('item', 'rebuild', FREEZES),
  anchor_mapping_missing: entry('item', 'rebuild', { ...SETS_ASIDE, stagesAsItem: true }),
  create_ambiguous: entry('item', 'rebuild', FREEZES),
  create_evidence_missing: entry('item', 'rebuild', FREEZES),
  anchor_parent_mismatch: entry('item', 'refresh', SETS_ASIDE),
  unmounted_restore_repair: entry('item', 'refresh', FREEZES),
  preflight_parent_mapping_missing: entry('item', 'refresh', { ...SETS_ASIDE, stagesAsItem: true }),
  preflight_target_mapping_missing: entry('item', 'refresh', { ...SETS_ASIDE, stagesAsItem: true }),
  preflight_member_mapping_missing: entry('item', 'refresh', { ...SETS_ASIDE, stagesAsItem: true }),
  // Codec failures. With a subject they are set aside where they happen;
  // one that still reaches the engine has none, and retrying cannot help.
  bounded_string_invalid: entry('item', 'stop'),
  secret_field_forbidden: entry('item', 'stop'),
  i_json_invalid: entry('item', 'stop'),
  record_too_large: entry('item', 'stop'),
  operation_schema_invalid: entry('item', 'stop'),

  pull_page_invalid: entry('replica', 'refresh', FREEZES),
  effect_page_invalid: entry('replica', 'refresh', FREEZES),
  // Integrity audit codes: a corrupt staged event freezes the page chain like a corrupt page.
  pull_event_invalid: entry('replica', 'refresh', FREEZES),
  pull_event_duplicate: entry('replica', 'refresh', FREEZES),
  pull_event_conflict: entry('replica', 'refresh', FREEZES),
  pull_effect_binding_invalid: entry('replica', 'refresh', FREEZES),
  pull_effect_kind_invalid: entry('replica', 'refresh', FREEZES),
  pull_cursor_chain_invalid: entry('replica', 'refresh', FREEZES),
  pull_source_binding_invalid: entry('replica', 'refresh', FREEZES),
  unexpected_effect_page: entry('replica', 'refresh', FREEZES),
  pull_page_reuse: entry('replica', 'refresh', FREEZES),
  effect_page_failed: entry('replica', 'refresh', FREEZES),
  snapshot_page_missing: entry('replica', 'refresh', FREEZES),
  mapping_identity_conflict: entry('replica', 'rebuild', FREEZES),
  refuse_rewind: entry('replica', 'refresh', FREEZES),
  refuse_stale_chain: entry('replica', 'refresh', FREEZES),
  mapping_identity_collision: entry('replica', 'rebuild', FREEZES),
  legacy_resolution_sequence_collision: entry('replica', 'rebuild', FREEZES),
  payload_too_large: entry('replica', 'rebuild'),
  // B6: more open Pull issues than this browser may hold; divergence must never be unbounded.
  pull_issue_ceiling: entry('replica', 'rebuild', FREEZES),
  sync_issue_ceiling: entry('replica', 'rebuild'),
  snapshot_projection_incomplete: entry('replica', 'stop'),
  // A queued operation contradicts current consent; rebuilding archives it before setup.
  metadata_sync_disabled: entry('replica', 'rebuild'),
  // Other local sync boundaries are explicitly registered: contention retries;
  // invalid durable records stop with a visible repair path.
  ack_cursor_not_published: entry('replica', 'stop'),
  ack_intent_invalid: entry('replica', 'stop'),
  ack_intent_missing: entry('replica', 'stop'),
  ack_intent_reuse: entry('replica', 'stop'),
  ack_invalid: entry('replica', 'stop'),
  ack_pending: entry('transient', 'retry'),
  ack_result_mismatch: entry('replica', 'stop'),
  action_unavailable: entry('transient', 'retry'),
  advanced_plan_changed: entry('transient', 'retry'),
  advanced_plan_completed: entry('transient', 'retry'),
  advanced_plan_corrupt: entry('replica', 'stop'),
  advanced_plan_in_progress: entry('transient', 'retry'),
  advanced_plan_incomplete: entry('replica', 'stop'),
  advanced_plan_too_large: entry('replica', 'stop'),
  advanced_record_invalid: entry('replica', 'stop'),
  advanced_step_corrupt: entry('replica', 'stop'),
  advanced_step_stale: entry('replica', 'stop'),
  advanced_step_transition_invalid: entry('replica', 'stop'),
  archive_not_found: entry('replica', 'stop'),
  attempt_binding_immutable: entry('replica', 'stop'),
  attempt_binding_invalid: entry('replica', 'stop'),
  attention_page_missing: entry('replica', 'stop'),
  authoritative_create_result_invalid: entry('replica', 'stop'),
  authoritative_projection_invalid: entry('replica', 'stop'),
  authoritative_projection_stale: entry('replica', 'stop'),
  authority_rebase_not_required: entry('transient', 'retry'),
  batch_command_conflict: entry('replica', 'stop'),
  batch_empty: entry('replica', 'stop'),
  batch_in_progress: entry('transient', 'retry'),
  batch_item_invalid: entry('replica', 'stop'),
  batch_item_stale: entry('replica', 'stop'),
  batch_item_transition_invalid: entry('replica', 'stop'),
  batch_plan_invalid: entry('replica', 'stop'),
  batch_plan_stale: entry('replica', 'stop'),
  batch_plan_transition_invalid: entry('replica', 'stop'),
  batch_too_large: entry('replica', 'stop'),
  bookmark_event_kind_invalid: entry('replica', 'stop'),
  bookmark_event_not_found: entry('replica', 'stop'),
  bookmark_event_operation_missing: entry('replica', 'stop'),
  bookmark_event_operation_state_invalid: entry('replica', 'stop'),
  bookmark_event_ordinal_exhausted: entry('replica', 'stop'),
  bookmark_event_park_state_invalid: entry('replica', 'stop'),
  bookmark_event_queue_missing: entry('replica', 'stop'),
  bookmark_event_status_invalid: entry('replica', 'stop'),
  bootstrap_ack_discard_invalid: entry('replica', 'stop'),
  bootstrap_ack_intent_missing: entry('replica', 'stop'),
  bootstrap_attention_invalid: entry('replica', 'stop'),
  bootstrap_confirmation_stale: entry('transient', 'retry'),
  bootstrap_mode_invalid: entry('replica', 'stop'),
  bootstrap_native_removed: entry('replica', 'stop'),
  bootstrap_phase_invalid: entry('replica', 'stop'),
  bootstrap_scope_invalid: entry('replica', 'stop'),
  canonical_json_invalid: entry('replica', 'stop'),
  command_dependencies_invalid: entry('replica', 'stop'),
  command_in_flight: entry('transient', 'retry'),
  command_kind_invalid: entry('replica', 'stop'),
  command_phase_invalid: entry('replica', 'stop'),
  command_scope_invalid: entry('replica', 'stop'),
  commit_outcome_unknown: entry('transient', 'retry'),
  conflict_resolution_binding_invalid: entry('replica', 'stop'),
  constraint: entry('replica', 'stop'),
  corruption_detected: entry('replica', 'stop'),
  cursor_evidence_unbound: entry('replica', 'stop'),
  // W2C-19: a damaged delete journal cannot be cured by a recovery (which would also discard live captures),
  // so it stops like every other unreadable record instead of also asking for a freeze.
  delete_journal_invalid: entry('replica', 'stop'),
  deletion_mapping_missing: entry('item', 'refresh', SETS_ASIDE),
  diagnostic_read_only: entry('replica', 'stop'),
  digest_mismatch: entry('replica', 'stop'),
  discovered_roots_invalid: entry('replica', 'stop'),
  effect_endpoint_binding_invalid: entry('replica', 'stop'),
  effect_page_event_unbound: entry('replica', 'stop'),
  engine_revision_stale: entry('transient', 'retry'),
  engine_state_invalid: entry('replica', 'stop'),
  engine_state_missing: entry('replica', 'stop'),
  environment_invalid: entry('replica', 'stop'),
  exact_retry_pending: entry('transient', 'retry'),
  exclusion_source_invalid: entry('replica', 'stop'),
  fault_injected: entry('transient', 'retry'),
  first_run_invalid: entry('replica', 'stop'),
  future_schema: entry('replica', 'stop'),
  generation_mismatch: entry('transient', 'retry'),
  identity_conflict: entry('replica', 'stop'),
  import_empty: entry('replica', 'stop'),
  import_node_duplicate: entry('replica', 'stop'),
  import_node_not_found: entry('replica', 'stop'),
  import_node_not_recoverable: entry('replica', 'stop'),
  import_node_state_invalid: entry('replica', 'stop'),
  import_plan_invalid: entry('replica', 'stop'),
  import_plan_not_found: entry('replica', 'stop'),
  import_plan_reuse: entry('replica', 'stop'),
  import_recovery_invalid: entry('replica', 'stop'),
  import_source_invalid: entry('replica', 'stop'),
  import_state_invalid: entry('replica', 'stop'),
  // W2A-05: an IndexedDB exception that has no better name. The browser's storage failed this once; the next try may work.
  indexeddb_failure: entry('transient', 'retry'),
  indexeddb_unavailable: entry('transient', 'retry'),
  ingress_diagnostic_invalid: entry('replica', 'stop'),
  ingress_diagnostic_scan_exceeded: entry('replica', 'stop'),
  intent_correlation_active: entry('transient', 'retry'),
  intent_mapping_mismatch: entry('replica', 'stop'),
  intent_not_found: entry('replica', 'stop'),
  // A stored intent without its scope key is corruption, not a retryable race.
  intent_scope_invalid: entry('replica', 'stop'),
  journal_kind_invalid: entry('replica', 'stop'),
  journal_scope_invalid: entry('replica', 'stop'),
  lease_authority_invalid: entry('authority', 'refresh', FREEZES),
  lease_result_missing: entry('replica', 'stop'),
  legacy_store_missing: entry('replica', 'stop'),
  lifecycle_invalid: entry('replica', 'stop'),
  lifecycle_transition_invalid: entry('replica', 'stop'),
  limit_exceeded: entry('replica', 'stop'),
  live_work_invalid: entry('replica', 'stop'),
  'mapping_missing:subtree_root': entry('item', 'refresh', SETS_ASIDE),
  mapping_missing_parent: entry('item', 'refresh', SETS_ASIDE),
  mapping_scope_invalid: entry('replica', 'stop'),
  mount_mode_invalid: entry('replica', 'stop'),
  mount_not_found: entry('replica', 'stop'),
  mount_role_invalid: entry('replica', 'stop'),
  mount_scope_invalid: entry('replica', 'stop'),
  mount_status_invalid: entry('replica', 'stop'),
  move_predecessor_pending: entry('transient', 'retry'),
  managed_not_writable: entry('item', 'decide', SETS_ASIDE),
  native_call_failed: entry('transient', 'retry'),
  native_result_cas: entry('transient', 'retry'),
  native_result_confirmation_invalid: entry('replica', 'stop'),
  native_result_invalid: entry('replica', 'stop'),
  native_result_unknown: entry('item', 'confirm'),
  native_wait_template_invalid: entry('replica', 'stop'),
  node_kind_invalid: entry('replica', 'stop'),
  object_invalid: entry('replica', 'stop'),
  observation_kind_invalid: entry('replica', 'stop'),
  observation_pause_invalid: entry('replica', 'stop'),
  observation_payload_invalid: entry('replica', 'stop'),
  observation_scope_invalid: entry('replica', 'stop'),
  op_id_reuse: entry('replica', 'stop'),
  operation_byte_budget_exceeded: entry('replica', 'stop'),
  operation_validator_missing: entry('replica', 'stop'),
  page_chain_invalid: entry('replica', 'stop'),
  parent_mapping_missing: entry('item', 'refresh', SETS_ASIDE),
  parent_revision_mapping_missing: entry('item', 'refresh', SETS_ASIDE),
  pause_baseline_invalid: entry('replica', 'stop'),
  permission_required: entry('transient', 'retry'),
  permission_revoked: entry('transient', 'retry'),
  preformal_invalid: entry('replica', 'stop'),
  preview_boundary_invalid: entry('replica', 'stop'),
  preview_content_forbidden: entry('replica', 'stop'),
  preview_kind_invalid: entry('replica', 'stop'),
  preview_remote_evidence_invalid: entry('replica', 'stop'),
  preview_scope_invalid: entry('replica', 'stop'),
  preview_too_large: entry('replica', 'stop'),
  private_ancestry_unproven: entry('replica', 'stop'),
  private_root_mapping_missing: entry('replica', 'refresh', FREEZES),
  private_roots_invalid: entry('replica', 'stop'),
  projection_apply_barrier: entry('transient', 'retry'),
  projection_generation_fenced: entry('transient', 'retry'),
  projection_intent_invalid: entry('replica', 'stop'),
  provisional_mapping_binding_invalid: entry('replica', 'stop'),
  pull_ack_discard_invalid: entry('replica', 'stop'),
  pull_cursor_discontinuous: entry('replica', 'stop'),
  pull_cursor_missing: entry('replica', 'stop'),
  pull_cursor_not_durable: entry('replica', 'stop'),
  pull_effect_gate_closed: entry('replica', 'stop'),
  pull_event_state_invalid: entry('replica', 'stop'),
  pull_failed: entry('transient', 'retry'),
  pull_invalid: entry('replica', 'stop'),
  pull_node_kind_invalid: entry('replica', 'stop'),
  pull_page_incomplete: entry('replica', 'stop'),
  pull_page_pending: entry('transient', 'retry'),
  pull_page_state_invalid: entry('replica', 'stop'),
  pull_transport_unavailable: entry('transient', 'retry'),
  push_batch_byte_limit: entry('replica', 'stop'),
  push_batch_placement_changed: entry('transient', 'retry'),
  push_batch_recovery_barrier: entry('transient', 'retry'),
  push_batch_response_invalid: entry('replica', 'stop'),
  push_batch_response_unknown: entry('transient', 'retry'),
  push_batch_timeout: entry('transient', 'retry'),
  push_request_invalid: entry('replica', 'stop'),
  // Rule C: a saved upload that cannot be read. One that was never sent leaves the lane as an item;
  // one the server may own keeps the push lane waiting (Pull and Ack carry on) until Reset.
  queue_head_unreadable: entry('replica', 'stop'),
  // The legacy first-sync move waits for uploads that are still on their way; they leave the line on their own.
  queue_not_drained: entry('transient', 'retry'),
  queue_not_found: entry('replica', 'stop'),
  queue_recovery_frozen: entry('transient', 'retry'),
  queue_row_unreadable: entry('item', 'decide'),
  queue_state_invalid: entry('replica', 'stop'),
  quota_exceeded: entry('transient', 'retry'),
  range_dependency_pending: entry('transient', 'retry'),
  recapture_identity_reused: entry('replica', 'stop'),
  recapture_required: entry('replica', 'stop'),
  receipt_binding_invalid: entry('replica', 'stop'),
  receipt_id_reuse: entry('replica', 'stop'),
  receipt_invalid: entry('replica', 'stop'),
  receipt_kind_invalid: entry('replica', 'stop'),
  recovery_authority_not_activated: entry('authority', 'refresh', FREEZES),
  recovery_incomplete: entry('replica', 'stop'),
  recovery_invalid: entry('replica', 'stop'),
  recovery_header_invalid: entry('replica', 'stop'),
  recovery_node_invalid: entry('replica', 'stop'),
  recovery_page_invalid: entry('replica', 'stop'),
  recovery_rebase_invalid: entry('replica', 'stop'),
  remote_delete_command_pending: entry('transient', 'retry'),
  remote_delete_decision_conflict: entry('replica', 'stop'),
  remote_delete_decision_invalid: entry('replica', 'stop'),
  remote_delete_decision_stale: entry('transient', 'retry'),
  remote_delete_generation_fenced: entry('transient', 'retry'),
  remote_delete_policy_invalid: entry('replica', 'stop'),
  remote_delete_policy_stale: entry('transient', 'retry'),
  remote_delete_revision_stale: entry('transient', 'retry'),
  reorder_incomplete: entry('replica', 'stop'),
  replay_state_invalid: entry('replica', 'stop'),
  request_failed: entry('transient', 'retry'),
  request_invalid: entry('replica', 'stop'),
  resource_revision_missing: entry('replica', 'stop'),
  retry_invalid: entry('replica', 'stop'),
  root_role_invalid: entry('replica', 'stop'),
  root_selection_invalid: entry('replica', 'stop'),
  root_selection_unknown: entry('replica', 'stop'),
  root_status_invalid: entry('replica', 'stop'),
  scope_mismatch: entry('authority', 'refresh', FREEZES),
  scope_not_found: entry('replica', 'stop'),
  // A Retry that needs sync to be running: the scope is not active (reset, recovery) or its folders are not ready.
  scope_not_writable: entry('transient', 'retry'),
  scope_retired: entry('replica', 'stop'),
  selected_roots_invalid: entry('replica', 'stop'),
  separator_conversion_blocked: entry('replica', 'stop'),
  sequence_exhausted: entry('replica', 'stop'),
  sequence_missing: entry('replica', 'stop'),
  server_origin_invalid: entry('replica', 'stop'),
  session_authority_invalid: entry('authority', 'refresh', FREEZES),
  session_handoff_pending: entry('transient', 'retry'),
  set_aside_refused: entry('replica', 'stop'),
  snapshot_chain_invalid: entry('replica', 'refresh', FREEZES),
  snapshot_conflict_confirm_invalid: entry('replica', 'refresh', FREEZES),
  snapshot_conflict_page_invalid: entry('replica', 'refresh', FREEZES),
  snapshot_content_baseline_missing: entry('replica', 'refresh', FREEZES),
  snapshot_content_target_missing: entry('item', 'rebuild', FREEZES),
  snapshot_cutover_missing: entry('replica', 'refresh', FREEZES),
  snapshot_graph_incomplete: entry('replica', 'refresh', FREEZES),
  snapshot_identity_conflict: entry('replica', 'refresh', FREEZES),
  snapshot_invalid: entry('replica', 'refresh', FREEZES),
  snapshot_node_duplicate: entry('replica', 'refresh', FREEZES),
  snapshot_parent_authority_invalid: entry('replica', 'refresh', FREEZES),
  snapshot_parent_authority_missing: entry('replica', 'refresh', FREEZES),
  snapshot_parent_mapping_missing: entry('replica', 'refresh', FREEZES),
  snapshot_placement_baseline_missing: entry('replica', 'refresh', FREEZES),
  snapshot_placement_boundary: entry('replica', 'refresh', FREEZES),
  snapshot_placement_children_fence_missing: entry('replica', 'refresh', FREEZES),
  snapshot_placement_local_identity_unproven: entry('item', 'rebuild', FREEZES),
  snapshot_placement_parent_missing: entry('replica', 'refresh', FREEZES),
  snapshot_placement_target_missing: entry('item', 'rebuild', FREEZES),
  snapshot_root_mapping_missing: entry('replica', 'refresh', FREEZES),
  snapshot_semantic_invalid: entry('replica', 'refresh', FREEZES),
  snapshot_session_scope_mismatch: entry('replica', 'refresh', FREEZES),
  stale_fence: entry('transient', 'retry'),
  stale_ref: entry('transient', 'retry'),
  // W2A-05: the browser's storage cannot be used right now (backing store failed, connection closed, site data
  // blocked) and a try later may work; a record the store refuses (not cloneable, bad key) never will.
  storage_record_rejected: entry('replica', 'stop'),
  storage_unavailable: entry('transient', 'retry'),
  sync_paused: entry('transient', 'retry'),
  // Rule E: a step of the engine wake keeps failing; the next wake tries it again (the cause is `rootCause`).
  sync_step_failed: entry('transient', 'retry'),
  target_mapping_missing: entry('item', 'refresh', SETS_ASIDE),
  transaction_aborted: entry('transient', 'retry'),
  unknown_or_missing_field: entry('replica', 'stop'),
  unsafe_integer: entry('replica', 'stop'),
  upgrade_failed: entry('replica', 'stop'),
} satisfies Record<string, SyncFailureEntry>);
export type SyncFailureCode = keyof typeof SYNC_FAILURE_TABLE;
export interface SyncFailureSubject { readonly nodeId?: string; readonly nativeId?: string; readonly opId?: string; readonly eventId?: string }

/** A typed emission site: adding a local policy failure requires registering its behavior. */
export class SyncFailureError extends Error {
  constructor(readonly code: SyncFailureCode, readonly subject?: SyncFailureSubject) { super(code); this.name = 'SyncFailureError'; }
}

/** Unknown external codes are bounded by the engine's durable circuit breaker. */
export function normalizeSyncFailureCode(code: string): string {
  const expiry = /^snapshot_[1-5][0-9]{2}_(sync_cursor_expired|snapshot_expired)$/u.exec(code);
  return expiry?.[1] ?? code;
}

export function classifySyncFailure(code: string | undefined, subject?: SyncFailureSubject): SyncFailureEntry | undefined {
  if (code === undefined) return undefined;
  // Snapshot HTTP expiry is an explicit transport wrapper, not an arbitrary suffix match.
  const normalized = normalizeSyncFailureCode(code);
  const policy = (SYNC_FAILURE_TABLE as Readonly<Record<string, SyncFailureEntry>>)[normalized];
  if (!policy) return undefined;
  // Class reflects the actual blast radius: an item requires a concrete subject.
  const hasSubject = subject && Object.values(subject).some(value => typeof value === 'string' && value.length > 0);
  return policy.class === 'item' && !hasSubject ? { ...policy, class: 'replica' } : policy;
}

export const PULL_MAPPING_FAILURE = {
  anchor: 'anchor_mapping_missing', deletion: 'deletion_mapping_missing', parent: 'parent_mapping_missing',
  parent_revision: 'parent_revision_mapping_missing', target: 'target_mapping_missing',
} as const satisfies Record<string, SyncFailureCode>;
export const PULL_PREFLIGHT_FAILURE = {
  member: 'preflight_member_mapping_missing', parent: 'preflight_parent_mapping_missing', target: 'preflight_target_mapping_missing',
} as const satisfies Record<string, SyncFailureCode>;

export function syncFailureCode(error: unknown): string {
  return error instanceof SyncFailureError ? error.code
    : error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code
      : error instanceof Error ? error.message : '';
}

/** A failure thrown while a Pull page applies freezes the scope instead of retrying the page. */
export function freezesPullApply(code: string): boolean {
  return classifySyncFailure(code)?.freezesPull === true;
}

/** A Session proves server authority, never an unknown browser identity: only a person's decision ends it. */
export function holdsUnprovenIdentity(code: string | undefined): boolean {
  return classifySyncFailure(code)?.exit === 'decide';
}

/** Local projection damage cannot be cured by minting another active Session. */
export function needsReplicaRebuild(code: string | undefined): boolean {
  return classifySyncFailure(code)?.exit === 'rebuild';
}

/** Retrying cannot change the result, so the engine stops instead of backing off. */
export function persistentLocalSyncFailure(code: string | undefined): boolean {
  return classifySyncFailure(code)?.exit === 'stop';
}

/** With a subject and before the browser changed, this Pull failure sets one node aside. */
export function setsAsidePullItem(code: string, subject: SyncFailureSubject): boolean {
  const failure = classifySyncFailure(code, subject);
  return failure?.class === 'item' && failure.setsAsidePull === true;
}

/** Any recorded failure holds the inbound Pull of a wake, except the few that end by themselves. */
export function holdsInboundPull(code: string | undefined): boolean {
  return code !== undefined && classifySyncFailure(code)?.pullsOnWake !== true;
}

/** Refresh may repair integrity, but repeated failures require an explicit retry. */
export function refreshesReplicaIntegrity(code: string | undefined): boolean {
  const policy = classifySyncFailure(code);
  return policy?.class === 'replica' && policy.exit === 'refresh';
}

/**
 * A Pull-time integrity stop keeps its Session `active`, so authority refresh never re-runs the
 * pull and Retry used to be a no-op. A user's Retry re-requests from the durable cursor once.
 * Snapshot-time stops (`snapshot_*`) keep the Session in `snapshotRequired`, so their refresh
 * already re-runs the recovery.
 */
export function repullsOnExplicitRetry(code: string | undefined): boolean {
  return code !== undefined && refreshesReplicaIntegrity(code) && !code.startsWith('snapshot_');
}
