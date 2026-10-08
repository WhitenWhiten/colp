import type { Generated } from 'kysely';

export type LedgerArchiveExportJobStatus = 'pending' | 'running' | 'retryable' | 'succeeded' | 'failed';

export interface LedgerArchiveExportJobTable {
  job_id: string;
  segment_id: string;
  status: Generated<LedgerArchiveExportJobStatus>;
  attempt_count: Generated<number>;
  lease_owner: string | null;
  lease_token: Generated<bigint>;
  lease_expires_at: Date | null;
  available_at: Generated<Date>;
  last_error_class: string | null;
  created_at: Generated<Date>;
  started_at: Date | null;
  completed_at: Date | null;
  updated_at: Generated<Date>;
}
