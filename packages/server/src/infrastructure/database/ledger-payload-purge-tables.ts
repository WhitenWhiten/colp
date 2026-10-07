import type { Generated } from 'kysely';

export type LedgerPayloadPurgeFamily = 'operation' | 'audit_payload' | 'outbox_social';
export type LedgerPayloadPurgeStatus =
  | 'pending' | 'running' | 'retryable' | 'succeeded' | 'failed';

export interface LedgerPayloadPurgeJobTable {
  job_id: string;
  segment_id: string;
  family: LedgerPayloadPurgeFamily;
  scope_key: string;
  lower_bound: bigint;
  upper_bound: bigint;
  floor_commit_ordinal: bigint | null;
  floor_tie_breaker: string | null;
  floor_revision: bigint | null;
  authorization_mode: 'development';
  authorization_environment: 'development';
  authorization_reference: string;
  authorization_evidence: Record<string, unknown>;
  status: Generated<LedgerPayloadPurgeStatus>;
  attempt_count: Generated<number>;
  lease_owner: string | null;
  lease_token: Generated<bigint>;
  lease_expires_at: Date | null;
  available_at: Generated<Date>;
  last_error_class: string | null;
  deleted_row_count: Generated<bigint>;
  created_at: Generated<Date>;
  started_at: Date | null;
  completed_at: Date | null;
  updated_at: Generated<Date>;
}

export interface LedgerPayloadPurgeReceiptTable {
  receipt_id: string;
  job_id: string;
  segment_id: string;
  family: LedgerPayloadPurgeFamily;
  scope_key: string;
  lower_bound: bigint;
  upper_bound: bigint;
  deleted_row_count: bigint;
  authorization_mode: 'development';
  evidence: Record<string, unknown>;
  completed_at: Generated<Date>;
}
