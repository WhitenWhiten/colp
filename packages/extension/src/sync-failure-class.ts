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
 * - decide: a person decides about one bookmark; until then the engine stays frozen.
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

export const SYNC_FAILURE_TABLE: Readonly<Record<string, SyncFailureEntry>> = Object.freeze({
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
  // Looks like a setting rather than a failure; kept on the rebuild exit until reviewed.
  metadata_sync_disabled: entry('replica', 'rebuild'),
});

/** Families that share an entry: the code names its role or its HTTP shape. */
const FAMILIES: readonly (readonly [(code: string) => boolean, SyncFailureEntry])[] = [
  // `snapshot_<status>_sync_cursor_expired`, from snapshotFailure.
  [(code) => code.endsWith('_sync_cursor_expired'), SYNC_FAILURE_TABLE.sync_cursor_expired!],
  // A page that names a node this browser has no mapping for, while staging or applying.
  [(code) => code.startsWith('preflight_'), entry('item', 'refresh', FREEZES)],
  [(code) => code.startsWith('mapping_missing') || code.endsWith('_mapping_missing'), entry('item', 'refresh', SETS_ASIDE)],
];

/** The entry for a code; undefined for a code nobody classified, which gets bounded retries. */
export function classifySyncFailure(code: string | undefined): SyncFailureEntry | undefined {
  if (code === undefined) return undefined;
  return SYNC_FAILURE_TABLE[code] ?? FAMILIES.find(([matches]) => matches(code))?.[1];
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
export function setsAsidePullItem(code: string): boolean {
  return classifySyncFailure(code)?.setsAsidePull === true;
}

/** Any recorded failure holds the inbound Pull of a wake, except the few that end by themselves. */
export function holdsInboundPull(code: string | undefined): boolean {
  return code !== undefined && classifySyncFailure(code)?.pullsOnWake !== true;
}
