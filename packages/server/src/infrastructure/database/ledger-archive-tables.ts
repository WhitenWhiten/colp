import type { Generated } from 'kysely';

/** Expand-only archive lifecycle manifest; never a source-data deletion port. */
export interface LedgerArchiveSegmentTable {
  segment_id: string;
  ledger_family: string;
  source_relation: string;
  source_scope: string;
  source_key_kind: 'bigint';
  source_key_comparator: 'signed-bigint-ascending-v1';
  source_key_bounds: unknown;
  row_count: bigint;
  source_bytes: bigint;
  content_digest: string;
  archive_object_uri: string;
  archive_object_etag: string;
  archive_schema_version: number;
  kms_key_id: string;
  state: Generated<
    | 'open'
    | 'sealed'
    | 'exported'
    | 'verified'
    | 'reader_cutover'
    | 'detached'
    | 'deletable'
    | 'deleted'
  >;
  state_revision: Generated<bigint>;
  stage_evidence: Generated<Record<string, Record<string, unknown>>>;
  sealed_at: Generated<Date | null>;
  exported_at: Generated<Date | null>;
  verified_at: Generated<Date | null>;
  reader_cutover_at: Generated<Date | null>;
  detached_at: Generated<Date | null>;
  deletable_at: Generated<Date | null>;
  deleted_at: Generated<Date | null>;
  delete_after: Date | null;
  legal_hold: Generated<boolean>;
  object_state: Generated<'creating' | 'verified' | 'unavailable' | 'deleted'>;
  read_state: Generated<'disabled' | 'verified' | 'cutover'>;
  hot_source_state: Generated<'attached' | 'purging' | 'detached'>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}
