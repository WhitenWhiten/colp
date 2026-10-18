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

  recovery_identity_unproven: entry('item', 'decide', FREEZES),
  deletion_identity_unproven: entry('item', 'decide', FREEZES),
  create_placement_parent_deleted: entry('item', 'decide'),
  create_placement_unproven: entry('item', 'decide'),
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
  mapping_identity_collision: entry('replica', 'rebuild', FREEZES),
  legacy_resolution_sequence_collision: entry('replica', 'rebuild', FREEZES),
  payload_too_large: entry('replica', 'rebuild'),
  // B6: more open Pull issues than this browser may hold; divergence must never be unbounded.
  pull_issue_ceiling: entry('replica', 'rebuild', FREEZES),
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
  indexeddb_unavailable: entry('transient', 'retry'),
  ingress_diagnostic_invalid: entry('replica', 'stop'),
  ingress_diagnostic_scan_exceeded: entry('replica', 'stop'),
  intent_correlation_active: entry('transient', 'retry'),
  intent_mapping_mismatch: entry('replica', 'stop'),
  intent_not_found: entry('replica', 'stop'),
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
  queue_not_found: entry('replica', 'stop'),
  queue_recovery_frozen: entry('transient', 'retry'),
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
  snapshot_content_target_missing: entry('replica', 'refresh', FREEZES),
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
  snapshot_placement_local_identity_unproven: entry('replica', 'refresh', FREEZES),
  snapshot_placement_parent_missing: entry('replica', 'refresh', FREEZES),
  snapshot_placement_target_missing: entry('replica', 'refresh', FREEZES),
  snapshot_root_mapping_missing: entry('replica', 'refresh', FREEZES),
  snapshot_semantic_invalid: entry('replica', 'refresh', FREEZES),
  snapshot_session_scope_mismatch: entry('replica', 'refresh', FREEZES),
  stale_fence: entry('transient', 'retry'),
  stale_ref: entry('transient', 'retry'),
  sync_paused: entry('transient', 'retry'),
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

/** Unknown external codes retain existing retry behavior; P3's bounded breaker is not implemented. */
export function classifySyncFailure(code: string | undefined, subject?: SyncFailureSubject): SyncFailureEntry | undefined {
  if (code === undefined) return undefined;
  // Snapshot HTTP expiry is an explicit transport wrapper, not an arbitrary suffix match.
  const normalized = /^snapshot_[1-5][0-9]{2}_sync_cursor_expired$/u.test(code) ? 'sync_cursor_expired' : code;
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
