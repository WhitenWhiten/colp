import type { Generated, GeneratedAlways } from 'kysely';

export interface SyncNodeRevisionHistoryTable {
  collection_id: string;
  resource_id: string;
  revision: string;
  kind: 'folder' | 'bookmark' | 'separator';
  payload_json: Record<string, unknown>;
  commit_ordinal: bigint;
  operation_id: string | null;
  recorded_at: Generated<Date>;
}

export interface SyncNodeTombstoneTable {
  collection_id: string;
  target_id: string;
  root_target_id: string;
  operation_id: string;
  scope: 'single' | 'subtree';
  delete_revision: string;
  delete_commit_ordinal: bigint;
  delete_cursor: string;
  deleted_at: Date;
  purge_after: Date;
  affected_count: number;
  payload_json: Record<string, unknown>;
  payload_purged_at: Generated<Date | null>;
  purge_state_revision: Generated<bigint | null>;
  created_at: Generated<Date>;
}

export interface SyncCollectionEffectCutoverTable {
  collection_id: string;
  effect_cutover_ordinal: bigint;
  created_at: Generated<Date>;
}

export interface SyncOperationEffectTable {
  effect_id: string;
  collection_id: string;
  operation_id: string;
  origin_replica_id: string;
  origin_sequence: bigint;
  commit_ordinal: bigint;
  protocol_version: '0.2';
  terminal_status: 'applied' | 'rebased';
  operation_digest: string;
  effect_json: Record<string, unknown>;
  effect_digest: string;
  created_at: Generated<Date>;
}

export interface SyncOperationEffectPageTable {
  effect_id: string;
  page_number: number;
  page_count: number;
  member_count: number;
  page_json: Record<string, unknown>;
  page_digest: string;
  previous_page_digest: string | null;
  created_at: Generated<Date>;
}

export interface SyncCollectionPurgeStateTable {
  collection_id: string;
  purged_through_commit_ordinal: Generated<bigint>;
  purged_through_stream_kind: Generated<number>;
  purged_through_stable_id: Generated<string>;
  state_revision: Generated<bigint>;
  lease_owner: Generated<string | null>;
  lease_token: Generated<string | null>;
  lease_generation: Generated<bigint>;
  lease_expires_at: Generated<Date | null>;
  attempt_count: Generated<bigint>;
  last_attempt_at: Generated<Date | null>;
  last_completed_at: Generated<Date | null>;
  updated_at: Generated<Date>;
}

export interface SyncPurgedNodeIdWatermarkTable {
  collection_id: string;
  target_id: string;
  delete_commit_ordinal: bigint;
  delete_revision: string;
  delete_operation_id: string;
  purge_state_revision: bigint;
  purged_at: Date;
}

export interface SyncConflictTable {
  conflict_id: string;
  collection_id: string;
  replica_id: string;
  session_id: string;
  operation_id: string;
  target_id: string;
  base_revision: string;
  trusted_base_revision: string | null;
  current_revision: string;
  conflict_type: 'concurrent_field_update' | 'unprovable_base' | 'untrusted_base' | 'delete_update';
  conflicting_fields: readonly string[];
  base_projection: Record<string, unknown>;
  current_projection: Record<string, unknown>;
  incoming_projection: Record<string, unknown>;
  private_payload_ciphertext: Buffer;
  private_payload_iv: Buffer;
  private_payload_auth_tag: Buffer;
  private_payload_key_version: number;
  private_payload_digest: string;
  allowed_resolutions: readonly ('server' | 'incoming' | 'custom' | 'both')[];
  pull_wire_json: Record<string, unknown>;
  sync_stream_kind: Generated<number>;
  status: 'open' | 'resolved';
  revision: string;
  commit_ordinal: bigint;
  created_at: Generated<Date>;
  resolved_by_operation_id: Generated<string | null>;
  resolved_by_principal_id: Generated<string | null>;
  resolution: Generated<'server' | 'incoming' | 'custom' | 'both' | null>;
  resolution_result_json: Generated<Record<string, unknown> | null>;
  resolved_at: Generated<Date | null>;
}

export interface SyncConflictResolutionReceiptTable {
  principal_id: string;
  conflict_id: string;
  conflict_revision: string;
  idempotency_key: string;
  request_digest: string;
  resolution: 'server' | 'incoming' | 'custom' | 'both';
  result_json: Record<string, unknown> | null;
  result_digest: string | null;
  operation_id: string | null;
  claimed_at: Generated<Date>;
  completed_at: Date | null;
}

export interface SyncDeviceTable {
  device_id: string;
  account_id: string;
  device_name: string;
  created_at: Date;
}

export interface SyncReplicaIdLedgerTable {
  replica_id: string;
  account_id: string;
  device_id: string;
  collection_id: string;
  initial_lease_generation: bigint;
  binding_mode: 'whole-profile' | 'mounted-folder';
  browser_profile_id: string;
  browser_generation: string;
  reserved_at: Date;
}

export interface SyncReplicaGenerationTable {
  replica_id: string;
  lease_generation: bigint;
  lease_id: string;
  issued_at: Date;
}

export interface SyncReplicaTable {
  replica_id: string;
  account_id: string;
  device_id: string;
  collection_id: string;
  replica_name: string;
  kind: 'browser_extension' | 'desktop_client' | 'mobile_client' | 'server' | 'importer' | 'other';
  lease_generation: bigint;
  lease_id: string;
  binding_mode: 'whole-profile' | 'mounted-folder';
  browser_profile_id: string;
  browser_generation: string;
  adapter_profile: string;
  adapter_version: string;
  capabilities_json: Record<string, unknown>;
  checkpoint_cursor: string | null;
  checkpoint_commit_ordinal: bigint | null;
  checkpoint_stream_kind: Generated<number | null>;
  checkpoint_stable_id: Generated<string | null>;
  status: 'active' | 'expired' | 'recovery_required' | 'retired';
  created_at: Date;
  last_seen_at: Date;
  lease_expires_at: Date;
  retired_at: Date | null;
  lifecycle_revision: Generated<bigint>;
  wire_json: Record<string, unknown>;
}

/** What the owner asked a replica to do from the Sync center (202611010300_sync_replica_commands). */
export interface SyncReplicaCommandTable {
  command_id: string;
  replica_id: string;
  account_id: string;
  action: 'retry' | 'use_server' | 'keep_local' | 'discard_local' | 'delete' | 'keep' | 'resume' | 'rebuild';
  issue_id: string | null;
  state: 'pending' | 'delivered' | 'done' | 'failed' | 'expired';
  result_code: string | null;
  created_at: Date;
  delivered_at: Date | null;
  completed_at: Date | null;
  expires_at: Date;
}

/** What a replica last reported about itself (202611010200_sync_replica_reports). */
export interface SyncReplicaReportTable {
  replica_id: string;
  account_id: string;
  health_state: 'syncing' | 'degraded' | 'stopped' | 'paused' | null;
  health_code: string | null;
  health_since: Date | null;
  health_revision: bigint | null;
  health_reported_at: Date | null;
  issue_total: number | null;
  issues: unknown[] | null;
  /** Defaults to an empty array (202611010300). */
  health_actions: Generated<string[]>;
  extension_version: string | null;
  ack_warnings: unknown[] | null;
  ack_warnings_at: Date | null;
}

export interface SyncPullCursorEvidenceTable {
  evidence_id: GeneratedAlways<bigint>;
  cursor: string | null;
  cursor_digest: string;
  session_id: string;
  account_id: string;
  collection_id: string;
  replica_id: string;
  lease_generation: bigint;
  policy_revision: string;
  protocol_version: '0.1' | '0.2';
  tuple_commit_ordinal: bigint;
  tuple_stream_kind: number;
  tuple_stable_id: string;
  cursor_expires_at: Date;
  issued_at: Generated<Date>;
  upper_commit_ordinal: bigint;
  upper_stream_kind: number;
  upper_stable_id: string;
  collection_revision: string;
  page_limit: number;
  purge_commit_ordinal: bigint;
  purge_stream_kind: number;
  purge_stable_id: string;
}

export interface SyncPullCursorRecoveryProofTable {
  proof_id: GeneratedAlways<bigint>;
  cursor_digest: string;
  authority_session_id: string;
  authority_lifecycle_revision: bigint;
  account_id: string;
  collection_id: string;
  replica_id: string;
  lease_generation: bigint;
  policy_revision: string;
  protocol_version: '0.1' | '0.2';
  page_limit: number;
  tuple_commit_ordinal: bigint;
  tuple_stream_kind: number;
  tuple_stable_id: string;
  upper_commit_ordinal: bigint;
  upper_stream_kind: number;
  upper_stable_id: string;
  purge_commit_ordinal: bigint;
  purge_stream_kind: number;
  purge_stable_id: string;
  cursor_expires_at: Date;
  proof_expires_at: Date;
  issued_at: Date;
  consumed_at: Date | null;
}

export interface SyncAckReceiptTable {
  principal_id: string;
  idempotency_key: string;
  request_digest: string;
  session_id: string;
  collection_id: string;
  replica_id: string;
  lease_generation: bigint;
  cursor_digest: string;
  result_json: Record<string, unknown>;
  result_digest: string;
  claimed_at: Date;
  completed_at: Date;
}

export interface SyncRecoveryCapabilityTable {
  capability_digest: string; session_id: string; account_id: string; replica_id: string;
  collection_id: string; old_lease_generation: bigint; purge_commit_ordinal: bigint;
  purge_stream_kind: number; purge_stable_id: string; snapshot_id: string;
  snapshot_revision: string; snapshot_page_count: number; snapshot_node_count: number;
  snapshot_cursor: string; purpose: 'sync-recovery-bootstrap-ack'; version: number;
  key_version: string; issued_at: Generated<Date>; expires_at: Date; consumed_at: Date | null;
}

/**
 * FIX-L-035: digest-only signed lineage that outlives cursor evidence and
 * recovery proofs so a legitimately expired long-offline cursor can be
 * distinguished from a random/tampered one. Never stores the full cursor.
 */
export interface SyncPullCursorLineageTable {
  lineage_id: GeneratedAlways<bigint>;
  cursor_digest: string;
  session_id: string;
  account_id: string;
  collection_id: string;
  replica_id: string;
  lease_generation: bigint;
  policy_revision: string;
  protocol_version: '0.1' | '0.2';
  page_limit: number;
  tuple_commit_ordinal: bigint;
  tuple_stream_kind: number;
  tuple_stable_id: string;
  cursor_expires_at: Date;
  lineage_expires_at: Date;
  issued_at: Date;
  key_version: string;
  receipt: string;
}

export interface SyncBootstrapSnapshotPageTable {
  snapshot_id: string; session_id: string; replica_id: string; old_lease_generation: bigint;
  page_sequence: number; page_start_offset: number; page_end_offset: number; complete: boolean;
  response_digest: string; served_at: Generated<Date>;
}

export interface SyncRecoveryAckReceiptTable {
  replica_id: string; idempotency_key: string; principal_id: string; request_digest: string;
  capability_digest: string; session_id: string; collection_id: string; snapshot_id: string;
  snapshot_revision: string; old_lease_generation: bigint; new_lease_generation: bigint;
  new_lease_id: string; result_json: Record<string, unknown>; result_digest: string; completed_at: Date;
}

export interface SyncReplicaRetirementReceiptTable {
  replica_id: string;
  idempotency_key: string;
  principal_id: string;
  request_digest: string;
  session_id: string;
  collection_id: string;
  lease_generation: bigint;
  retired_lifecycle_revision: bigint;
  result_digest: string;
  completed_at: Date;
}

export interface SyncExtensionCredentialTable {
  issuer: string;
  credential_id: string;
  credential_digest: string;
  subject: string;
  account_id: string;
  client_id: string;
  audience: string;
  scopes_json: unknown;
  credential_issued_at: Date;
  credential_expires_at: Date;
  evidence_expires_at: Date;
  security_epoch: bigint;
  revoked_at: Date | null;
  first_seen_at: Date;
  last_verified_at: Date;
}

export interface SyncSessionTable {
  session_id: string;
  account_id: string;
  principal_subject_id: string;
  credential_issuer: string;
  credential_id: string;
  oauth_client_id: string;
  origin: string | null;
  session_scope: 'collection';
  protocol_version: '0.1' | '0.2';
  collection_id: string;
  replica_id: string;
  lease_generation: bigint;
  lease_id: string;
  lifecycle_revision: bigint;
  policy_revision: string;
  account_security_epoch: bigint;
  issued_at: Date;
  expires_at: Date;
  status: 'active' | 'terminated';
  termination_reason: 'credential_revoked' | 'scope_reduced' | 'bootstrap_rejected'
    | 'administrative' | 'lease_expired' | null;
  terminated_at: Date | null;
  secret_digest: string;
  capability_digest: string;
  binding_json: Record<string, unknown>;
}

export interface SyncSessionScopeTable {
  session_id: string;
  scope: 'sync:bootstrap' | 'sync:pull' | 'sync:push';
}

export interface SyncSessionBindingTable {
  session_id: string;
  account_id: string;
  collection_id: string;
  replica_id: string;
  lease_generation: bigint;
  lease_id: string;
  lifecycle_revision: bigint;
  policy_revision: string;
  binding_mode: 'whole-profile' | 'mounted-folder';
  browser_profile_id: string;
  browser_generation: string;
  created_at: Date;
}

export interface SyncSessionIdempotencyReceiptTable {
  principal_id: string;
  session_scope: 'collection';
  idempotency_key: string;
  request_fingerprint: string;
  collection_id: string;
  replica_id: string;
  session_id: string;
  result_ciphertext: Buffer;
  result_iv: Buffer;
  result_auth_tag: Buffer;
  result_key_version: number;
  result_digest: string;
  claimed_at: Date;
  completed_at: Date;
}

export interface SyncSequenceLaneTable {
  replica_id: string;
  collection_id: string;
  sequence_scope: string;
  next_sequence: bigint;
  retention_policy: 'replica_lifetime';
  retained_through_retirement: true;
  created_at: Date;
  updated_at: Date;
}

export interface SyncSequenceOperationClaimTable {
  operation_id: string;
  replica_id: string;
  collection_id: string;
  sequence_scope: string;
  sequence_number: bigint;
  canonical_digest: string; digest_algorithm: 'known.sync-sequence.v1' | 'known.sync-sequence.logical.v2';
  retention_policy: 'replica_lifetime';
  retained_through_retirement: true;
  claimed_at: Date;
}

export interface SyncSequenceReceiptTable {
  replica_id: string;
  collection_id: string;
  sequence_scope: string;
  sequence_number: bigint;
  operation_id: string;
  canonical_digest: string; digest_algorithm: 'known.sync-sequence.v1' | 'known.sync-sequence.logical.v2';
  session_id: string;
  lease_generation: bigint;
  server_batch_id: string;
  media_type: string;
  endpoint_identity: string;
  status: 'applied' | 'rebased' | 'noop' | 'conflicted' | 'rejected' | 'deferred';
  result_json: Record<string, unknown>;
  result_digest: string;
  terminal: GeneratedAlways<boolean>;
  retention_policy: 'replica_lifetime';
  retained_through_retirement: true;
  created_at: Date;
  updated_at: Date;
  finalized_at: Date | null;
}

export interface SyncReplicaReportAuthorityTable {
  proof_digest: string; replica_id: string; account_id: string; device_id: string;
  browser_profile_id: string; browser_generation: string; credential_issuer: string;
  oauth_client_id: string; account_security_epoch: bigint; created_at: Date;
}
