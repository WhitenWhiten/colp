/**
 * P4A-I15 PITR reconcile ledger port over PostgreSQL.
 *
 * Reads every NON-deleted generation row from the production
 * `blob_generations` ledger (per-exact-key facts: generation_id, blob_id,
 * bucket, key, state, observed etag/size). This is the read-only source for
 * `reconcileGenerationLedger`; the reconcile itself HEADs each claimed row
 * through the RO object store and NEVER lists the bucket.
 */
import type { DatabaseRuntime } from './runtime.js';
import type {
  PitrLedgerPort,
  PitrLedgerRow,
} from '../../modules/attachments/index.js';

interface PitrLedgerSqlRow {
  generation_id: string;
  blob_id: string;
  bucket: string;
  key: string;
  generation_state: string;
  observed_etag: string | null;
  observed_size: string | null;
}

export function createPostgresPitrLedgerPort(runtime: DatabaseRuntime): PitrLedgerPort {
  return Object.freeze({
    async listClaimedGenerations(): Promise<readonly PitrLedgerRow[]> {
      const rows = await runtime.pool.query<PitrLedgerSqlRow>(`
        select bg.generation_id, bg.blob_id, bg.bucket, bg.key,
               bg.generation_state, bg.observed_etag, bg.observed_size::text as observed_size
        from blob_generations bg
        where bg.generation_state <> 'deleted'
        order by bg.created_at, bg.generation_id
      `);
      return rows.rows.map((row) => ({
        generationId: row.generation_id,
        blobId: row.blob_id,
        key: row.key,
        bucket: row.bucket,
        generationState: row.generation_state,
        expectedEtag: row.observed_etag,
        expectedSize: row.observed_size === null ? null : Number(row.observed_size),
      }));
    },
  });
}