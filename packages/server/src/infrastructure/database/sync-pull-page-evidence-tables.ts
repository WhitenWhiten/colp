import type { Generated, GeneratedAlways } from 'kysely';

/**
 * SYNC-Q-011: one durable envelope per Pull response. Event cursors stay
 * HMAC-stateless; Ack still keys off next-cursor evidence during this expand.
 */
export interface SyncPullPageEvidenceTable {
  page_id: GeneratedAlways<bigint>;
  page_digest: string;
  next_cursor_digest: string;
  session_id: string;
  account_id: string;
  collection_id: string;
  replica_id: string;
  lease_generation: bigint;
  lifecycle_revision: bigint;
  policy_revision: string;
  protocol_version: '0.1' | '0.2';
  page_limit: number;
  event_count: number;
  lower_commit_ordinal: bigint;
  lower_stream_kind: number;
  lower_stable_id: string;
  upper_commit_ordinal: bigint;
  upper_stream_kind: number;
  upper_stable_id: string;
  purge_commit_ordinal: bigint;
  purge_stream_kind: number;
  purge_stable_id: string;
  page_expires_at: Date;
  issued_at: Generated<Date>;
}
