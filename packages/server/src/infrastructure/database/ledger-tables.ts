import type { Generated, GeneratedAlways } from 'kysely';

export interface ProductCommandReceiptTable {
  principal_id: string;
  command_scope: string;
  command_id: string;
  request_fingerprint: string;
  target_identity: string | null;
  result_status: number | null;
  result_headers: Record<string, string> | null;
  result_media_type: string | null;
  result_bytes: Buffer | null;
  result_digest: string | null;
  contract_version: string;
  claimed_at: Date;
  completed_at: Date | null;
  result_expires_at: Date | null;
  result_purged_at: Date | null;
  compact_claim: boolean;
}

/** Publisher admission ownership — isolated from product_command_receipts. */
export interface PublisherIdempotencyTable {
  namespace: string;
  principal_id: string;
  idempotency_key: string;
  request_fingerprint: string;
  target_identity: string | null;
  result_status: number | null;
  result_headers: Record<string, string> | null;
  result_media_type: string | null;
  result_bytes: Buffer | null;
  result_digest: string | null;
  contract_version: string;
  claimed_at: Date;
  completed_at: Date | null;
  result_expires_at: Date | null;
}

export interface ResourceIdLedgerTable {
  resource_id: string;
  resource_type: string;
  reserved_at: Generated<Date>;
  committed_at: Date | null;
}

export interface ResourceRevisionTable {
  collection_id: string;
  resource_id: string;
  revision: string;
  ordinal: bigint;
  created_at: Date;
}

export interface ChildrenRevisionTable {
  collection_id: string;
  parent_id: string;
  revision: string;
  ordinal: bigint;
}

export interface ContentRevisionTable {
  collection_id: string;
  revision: string;
  ordinal: bigint;
  created_at: Date;
}

export interface PolicyRevisionTable {
  collection_id: string;
  revision: string;
  ordinal: bigint;
  created_at: Date;
}

export interface OperationTable {
  operation_id: string;
  collection_id: string;
  commit_ordinal: bigint;
  operation_type: string;
  payload_source: 'hot' | 'archive';
  payload_locator: string;
  payload_digest_sha256: string;
  payload_bytes: bigint;
  payload_schema_version: 1;
  payload_bucket: Date;
  sync_wire_present: boolean;
  sync_stream_kind: Generated<number>;
  actor_principal_id: string | null;
  created_at: Date;
}

export interface AuditEventTable {
  id: GeneratedAlways<bigint>;
  operation_id: string | null;
  collection_id: string | null;
  principal_id: string | null;
  event_type: string;
  created_at: Date;
  payload_digest: string;
  payload_bytes: bigint;
  payload_schema_version: number;
  payload_bucket_locator: string;
  hot_payload_id: bigint | null;
  payload_archive_segment_id: string | null;
}

export interface AuditEventPayloadTable {
  event_id: bigint;
  details_json: Record<string, unknown>;
  created_at: Date;
}

/** Durable applied-event ledger for collection mutation projections (Task 12). */
export interface CollectionMutationProjectionAppliedTable {
  handler_name: string;
  domain_event_id: string;
  event_type: string;
  event_version: number;
  aggregate_id: string;
  aggregate_scope: string;
  commit_ordinal: bigint;
  disposition: 'applied' | 'stale_skipped';
  payload_json: Record<string, unknown>;
  applied_at: Date;
}

/** Materialised collection/node projection rows fenced by commit ordinal. */
export interface CollectionMutationProjectionResourceTable {
  collection_id: string;
  resource_type: 'collection' | 'node' | 'annotation' | 'relation';
  resource_id: string;
  last_handler_name: string;
  last_event_type: string;
  last_event_version: number;
  last_domain_event_id: string;
  last_commit_ordinal: bigint;
  state_json: Record<string, unknown>;
  deleted: boolean;
  updated_at: Date;
}

/** Per-handler, per-resource fence inside the projection transaction. */
export interface CollectionMutationProjectionWatermarkTable {
  handler_name: string;
  aggregate_id: string;
  last_commit_ordinal: bigint;
  last_domain_event_id: string;
  updated_at: Date;
}

/** Session-free durable MCP 2026-07-28 Change Plan authority (MCP-W02). */
export interface McpChangePlanTable {
  plan_id: string;
  binding_kind: 'authenticated';
  principal_id: string;
  client_id: string;
  credential_binding_id: string;
  resource_audience: string;
  security_epoch: string;
  binding_digest: string;
  binding_json: Record<string, unknown>;
  status: 'pending' | 'approved' | 'committing' | 'consumed' | 'cancelled' | 'expired';
  risk: 'low' | 'medium' | 'high';
  requires_approval: boolean;
  approval_method: string | null;
  approval_uri: string | null;
  summary: string;
  impact_json: Record<string, unknown>;
  required_scopes_json: readonly string[];
  base_revisions_json: Record<string, string>;
  operations_json: readonly unknown[];
  operations_digest: string;
  untrusted_note: string;
  expires_at: Date;
  created_at: Date;
  updated_at: Date;
  retained_until: Date;
}

/** One-time server-bound MCP Approval decision (MCP-W02). */
export interface McpApprovalTable {
  plan_id: string;
  binding_digest: string;
  operations_digest: string;
  decided_at: Date;
  consumed_at: Date | null;
  retained_until: Date;
}

/** First Commit result replay receipt keyed by Plan + idempotency key (MCP-W02). */
export interface McpCommitReceiptTable {
  plan_id: string;
  idempotency_key: string;
  binding_digest: string;
  operations_digest: string;
  result_json: Record<string, unknown> | null;
  result_digest: string | null;
  claimed_at: Date;
  completed_at: Date | null;
  retained_until: Date;
}
