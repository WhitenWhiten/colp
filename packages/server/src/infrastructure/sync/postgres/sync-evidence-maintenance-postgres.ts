import { sql, type Kysely } from 'kysely';
import { createUnitOfWork, type DatabaseTransaction } from '../../database/unit-of-work.js';
import type { DatabaseSchema } from '../../database/runtime.js';
import type {
  SyncEvidenceMaintenanceCoordinator,
  SyncEvidenceMaintenanceCoordinatorOptions,
  SyncEvidenceMaintenanceResult,
} from '../../../modules/sync/index.js';

interface MaintenanceCandidateRow {
  kind: 'proof' | 'evidence' | 'lineage' | 'page';
  id: bigint | string;
  expiry: Date;
}

interface EvidenceClassificationRow {
  evidence_id: bigint | string;
  deletable: boolean;
  checkpointed: boolean;
  ack_protected: boolean;
}

/**
 * R15 global evidence/proof maintenance coordinator.
 *
 * One transaction per run:
 * 1. A candidate CTE over proofs, next-cursor evidence, lineage, and page
 *    envelopes selects the oldest expired/consumed/retired rows, oldest-first,
 *    and locks the batch with FOR UPDATE SKIP LOCKED so concurrent workers never
 *    process the same rows. batchSize caps the total candidate rows per run.
 * 2. Proofs are deleted first: the candidate predicate mirrors exactly the
 *    guard_sync_pull_cursor_recovery_proof() DELETE allowance
 *    (proof_expires_at <= now OR consumed_at IS NOT NULL OR retired status).
 * 3. Evidence whose cursor is neither an Ack receipt target nor a checkpoint
 *    reference is deleted; the predicate mirrors guard_sync_pull_cursor_evidence_retention()
 *    DELETE allowance (expired-or-retired AND NOT EXISTS ack AND NOT EXISTS checkpoint).
 * 4. Expired checkpoint-referenced evidence is only redacted (cursor -> NULL),
 *    keeping cursor_digest + tuple authority; the UPDATE predicate mirrors the
 *    trigger's UPDATE allowance. Redacted rows are excluded from future runs
 *    (cursor IS NOT NULL), so repeated runs are idempotent.
 * 5. Ack-protected-only evidence is left intact (skipped).
 *
 * Every DML statement re-checks the full trigger-allowed predicate so the
 * retention triggers are always satisfied and never reject a worker statement.
 */
export class PostgresSyncEvidenceMaintenanceCoordinator implements SyncEvidenceMaintenanceCoordinator {
  private readonly options: Required<SyncEvidenceMaintenanceCoordinatorOptions>;

  constructor(private readonly db: Kysely<DatabaseSchema>, options: SyncEvidenceMaintenanceCoordinatorOptions) {
    if (!options.workerId || options.workerId.length > 128 || !Number.isInteger(options.batchSize)
        || options.batchSize < 1 || options.batchSize > 20_000
        || !Number.isInteger(options.leaseDurationMs) || options.leaseDurationMs < 1) {
      throw new TypeError('Invalid Sync Evidence maintenance coordinator options.');
    }
    this.options = { ...options, faultInjector: options.faultInjector ?? {} };
  }

  runBatch(input: { readonly now?: Date } = {}): Promise<SyncEvidenceMaintenanceResult> {
    return createUnitOfWork(this.db).execute(async ({ transaction }) => {
      const now = await databaseNow(transaction, input.now);
      // Bound how long this run may hold its SKIP LOCKED row locks. Uses
      // set_config(..., true) because SET LOCAL does not accept a bind
      // parameter under the extended query protocol (syntax error 42601).
      await sql`select set_config('statement_timeout',
        ${String(this.options.leaseDurationMs)}, true)`.execute(transaction);
      // Debug context in pg_stat_activity / current_setting() during the run.
      await sql`select set_config('known.sync_evidence_maintenance_worker',
        ${this.options.workerId}, true)`.execute(transaction);

      const candidates = await sql<MaintenanceCandidateRow>`
        WITH proofs AS MATERIALIZED (
          SELECT 'proof'::text AS kind, proof.proof_id AS id, proof.proof_expires_at AS expiry
          FROM sync_pull_cursor_recovery_proofs AS proof
          WHERE proof.proof_expires_at <= ${now}
             OR proof.consumed_at IS NOT NULL
             OR EXISTS (SELECT 1 FROM sync_replicas AS replica
               WHERE replica.replica_id = proof.replica_id
                 AND replica.status IN ('recovery_required', 'retired'))
          ORDER BY proof.proof_expires_at, proof.proof_id
          LIMIT ${this.options.batchSize}
          FOR UPDATE SKIP LOCKED
        ),
        evidence AS MATERIALIZED (
          SELECT 'evidence'::text AS kind, evidence.evidence_id AS id, evidence.cursor_expires_at AS expiry
          FROM sync_pull_cursor_evidence AS evidence
          WHERE evidence.cursor IS NOT NULL
            AND (evidence.cursor_expires_at <= ${now}
              OR EXISTS (SELECT 1 FROM sync_replicas AS replica
                WHERE replica.replica_id = evidence.replica_id
                  AND replica.status IN ('recovery_required', 'retired')))
          ORDER BY evidence.cursor_expires_at, evidence.evidence_id
          LIMIT ${this.options.batchSize}
          FOR UPDATE SKIP LOCKED
        ),
        lineage AS MATERIALIZED (
          SELECT 'lineage'::text AS kind, lineage.lineage_id AS id, lineage.lineage_expires_at AS expiry
          FROM sync_pull_cursor_lineage AS lineage
          WHERE lineage.lineage_expires_at <= ${now}
             OR EXISTS (SELECT 1 FROM sync_replicas AS replica
               WHERE replica.replica_id = lineage.replica_id
                 AND replica.status IN ('recovery_required', 'retired'))
          ORDER BY lineage.lineage_expires_at, lineage.lineage_id
          LIMIT ${this.options.batchSize}
          FOR UPDATE SKIP LOCKED
        ),
        pages AS MATERIALIZED (
          SELECT 'page'::text AS kind, page.page_id AS id, page.page_expires_at AS expiry
          FROM sync_pull_page_evidence AS page
          WHERE page.page_expires_at <= ${now}
             OR EXISTS (SELECT 1 FROM sync_replicas AS replica
               WHERE replica.replica_id = page.replica_id
                 AND replica.status IN ('recovery_required', 'retired'))
          ORDER BY page.page_expires_at, page.page_id
          LIMIT ${this.options.batchSize}
          FOR UPDATE SKIP LOCKED
        ),
        candidates AS (
          SELECT kind, id, expiry FROM proofs
          UNION ALL
          SELECT kind, id, expiry FROM evidence
          UNION ALL
          SELECT kind, id, expiry FROM lineage
          UNION ALL
          SELECT kind, id, expiry FROM pages
        )
        SELECT kind, id, expiry FROM candidates
        ORDER BY expiry
        LIMIT ${this.options.batchSize}
      `.execute(transaction);

      const proofIds = candidates.rows
        .filter((row) => row.kind === 'proof').map((row) => row.id);
      const evidenceIds = candidates.rows
        .filter((row) => row.kind === 'evidence').map((row) => row.id);
      const lineageIds = candidates.rows
        .filter((row) => row.kind === 'lineage').map((row) => row.id);
      const pageIds = candidates.rows
        .filter((row) => row.kind === 'page').map((row) => row.id);

      // Classify the locked evidence batch while our transaction still holds the locks.
      const evidenceRows = evidenceIds.length > 0
        ? (await sql<EvidenceClassificationRow>`
            SELECT evidence.evidence_id,
              (NOT EXISTS (SELECT 1 FROM sync_ack_receipts AS receipt
                  WHERE receipt.replica_id = evidence.replica_id
                    AND receipt.cursor_digest = evidence.cursor_digest)
               AND NOT EXISTS (SELECT 1 FROM sync_replicas AS replica
                  WHERE replica.replica_id = evidence.replica_id
                    AND replica.checkpoint_cursor = evidence.cursor)) AS deletable,
              (EXISTS (SELECT 1 FROM sync_replicas AS replica
                  WHERE replica.replica_id = evidence.replica_id
                    AND replica.checkpoint_cursor = evidence.cursor)) AS checkpointed,
              (NOT EXISTS (SELECT 1 FROM sync_replicas AS replica
                  WHERE replica.replica_id = evidence.replica_id
                    AND replica.checkpoint_cursor = evidence.cursor)
               AND EXISTS (SELECT 1 FROM sync_ack_receipts AS receipt
                  WHERE receipt.replica_id = evidence.replica_id
                    AND receipt.cursor_digest = evidence.cursor_digest)) AS ack_protected
            FROM sync_pull_cursor_evidence AS evidence
            WHERE evidence.evidence_id = ANY(${evidenceIds}::bigint[])
          `.execute(transaction)).rows
        : [];

      const pageRows = pageIds.length > 0
        ? (await sql<{ page_id: bigint | string; deletable: boolean; ack_protected: boolean }>`
            SELECT page.page_id,
              (NOT EXISTS (SELECT 1 FROM sync_ack_receipts AS receipt
                  WHERE receipt.replica_id = page.replica_id
                    AND receipt.cursor_digest = page.next_cursor_digest)
               AND NOT EXISTS (SELECT 1 FROM sync_replicas AS replica
                  JOIN sync_pull_cursor_evidence AS evidence
                    ON evidence.replica_id = replica.replica_id
                   AND evidence.cursor = replica.checkpoint_cursor
                  WHERE replica.replica_id = page.replica_id
                    AND evidence.cursor_digest = page.next_cursor_digest)) AS deletable,
              (EXISTS (SELECT 1 FROM sync_ack_receipts AS receipt
                  WHERE receipt.replica_id = page.replica_id
                    AND receipt.cursor_digest = page.next_cursor_digest)
               OR EXISTS (SELECT 1 FROM sync_replicas AS replica
                  JOIN sync_pull_cursor_evidence AS evidence
                    ON evidence.replica_id = replica.replica_id
                   AND evidence.cursor = replica.checkpoint_cursor
                  WHERE replica.replica_id = page.replica_id
                    AND evidence.cursor_digest = page.next_cursor_digest)) AS ack_protected
            FROM sync_pull_page_evidence AS page
            WHERE page.page_id = ANY(${pageIds}::bigint[])
          `.execute(transaction)).rows
        : [];

      await this.options.faultInjector?.afterPhase?.('candidates_selected');

      // Proofs FIRST: expired, consumed, or retired-replica proofs are all deletable.
      let deleted = 0;
      if (proofIds.length > 0) {
        const proofDeleted = await sql<{ proof_id: bigint | string }>`
          DELETE FROM sync_pull_cursor_recovery_proofs AS proof
          WHERE proof.proof_id = ANY(${proofIds}::bigint[])
            AND (proof.proof_expires_at <= ${now}
              OR proof.consumed_at IS NOT NULL
              OR EXISTS (SELECT 1 FROM sync_replicas AS replica
                WHERE replica.replica_id = proof.replica_id
                  AND replica.status IN ('recovery_required', 'retired')))
          RETURNING proof.proof_id
        `.execute(transaction);
        deleted += proofDeleted.rows.length;
      }
      await this.options.faultInjector?.afterPhase?.('proofs_deleted');

      const deletableIds = evidenceRows.filter((row) => row.deletable).map((row) => row.evidence_id);
      const checkpointedIds = evidenceRows.filter((row) => row.checkpointed).map((row) => row.evidence_id);
      if (deletableIds.length > 0) {
        const evidenceDeleted = await sql<{ evidence_id: bigint | string }>`
          DELETE FROM sync_pull_cursor_evidence AS evidence
          WHERE evidence.evidence_id = ANY(${deletableIds}::bigint[])
            AND evidence.cursor IS NOT NULL
            AND (evidence.cursor_expires_at <= ${now}
              OR EXISTS (SELECT 1 FROM sync_replicas AS replica
                WHERE replica.replica_id = evidence.replica_id
                  AND replica.status IN ('recovery_required', 'retired')))
            AND NOT EXISTS (SELECT 1 FROM sync_ack_receipts AS receipt
              WHERE receipt.replica_id = evidence.replica_id
                AND receipt.cursor_digest = evidence.cursor_digest)
            AND NOT EXISTS (SELECT 1 FROM sync_replicas AS replica
              WHERE replica.replica_id = evidence.replica_id
                AND replica.checkpoint_cursor = evidence.cursor)
          RETURNING evidence.evidence_id
        `.execute(transaction);
        deleted += evidenceDeleted.rows.length;
      }
      await this.options.faultInjector?.afterPhase?.('evidence_deleted');

      let redacted = 0;
      if (checkpointedIds.length > 0) {
        const redactedRows = await sql<{ evidence_id: bigint | string }>`
          UPDATE sync_pull_cursor_evidence AS evidence SET cursor = NULL
          WHERE evidence.evidence_id = ANY(${checkpointedIds}::bigint[])
            AND evidence.cursor IS NOT NULL
            AND (evidence.cursor_expires_at <= ${now}
              OR EXISTS (SELECT 1 FROM sync_replicas AS replica
                WHERE replica.replica_id = evidence.replica_id
                  AND replica.status IN ('recovery_required', 'retired')))
            AND EXISTS (SELECT 1 FROM sync_replicas AS replica
              WHERE replica.replica_id = evidence.replica_id
                AND replica.checkpoint_cursor = evidence.cursor)
          RETURNING evidence.evidence_id
        `.execute(transaction);
        redacted = redactedRows.rows.length;
      }
      const skipped = evidenceRows.filter((row) => row.ack_protected).length
        + pageRows.filter((row) => row.ack_protected).length;
      await this.options.faultInjector?.afterPhase?.('evidence_redacted');

      if (lineageIds.length > 0) {
        const lineageDeleted = await sql<{ lineage_id: bigint | string }>`
          DELETE FROM sync_pull_cursor_lineage AS lineage
          WHERE lineage.lineage_id = ANY(${lineageIds}::bigint[])
            AND (lineage.lineage_expires_at <= ${now}
              OR EXISTS (SELECT 1 FROM sync_replicas AS replica
                WHERE replica.replica_id = lineage.replica_id
                  AND replica.status IN ('recovery_required', 'retired')))
          RETURNING lineage.lineage_id
        `.execute(transaction);
        deleted += lineageDeleted.rows.length;
      }
      const deletablePageIds = pageRows.filter((row) => row.deletable).map((row) => row.page_id);
      if (deletablePageIds.length > 0) {
        const pagesDeleted = await sql<{ page_id: bigint | string }>`
          DELETE FROM sync_pull_page_evidence AS page
          WHERE page.page_id = ANY(${deletablePageIds}::bigint[])
            AND (page.page_expires_at <= ${now}
              OR EXISTS (SELECT 1 FROM sync_replicas AS replica
                WHERE replica.replica_id = page.replica_id
                  AND replica.status IN ('recovery_required', 'retired')))
            AND NOT EXISTS (SELECT 1 FROM sync_ack_receipts AS receipt
              WHERE receipt.replica_id = page.replica_id
                AND receipt.cursor_digest = page.next_cursor_digest)
            AND NOT EXISTS (SELECT 1 FROM sync_replicas AS replica
              JOIN sync_pull_cursor_evidence AS evidence
                ON evidence.replica_id = replica.replica_id
               AND evidence.cursor = replica.checkpoint_cursor
              WHERE replica.replica_id = page.replica_id
                AND evidence.cursor_digest = page.next_cursor_digest)
          RETURNING page.page_id
        `.execute(transaction);
        deleted += pagesDeleted.rows.length;
      }

      const oldestExpiredAgeMs = await computeOldestExpiredAgeMs(transaction, now);
      await this.options.faultInjector?.afterPhase?.('before_commit');

      return Object.freeze({
        attempted: candidates.rows.length,
        deleted,
        redacted,
        skipped,
        errors: 0,
        oldestExpiredAgeMs,
      });
    });
  }
}

async function databaseNow(transaction: DatabaseTransaction, override?: Date): Promise<Date> {
  const result = override
    ? await sql<{ now: Date }>`SELECT ${override}::timestamptz AS now`.execute(transaction)
    : await sql<{ now: Date }>`SELECT current_timestamp AS now`.execute(transaction);
  const now = result.rows[0]?.now;
  if (!(now instanceof Date)) throw new TypeError('PostgreSQL did not return an authoritative timestamp.');
  return now;
}

/** Age (ms) of the oldest expired candidate across both tables, computed in SQL with DB time. */
async function computeOldestExpiredAgeMs(transaction: DatabaseTransaction, now: Date): Promise<number> {
  const result = await sql<{ oldest: Date | null }>`
    SELECT MIN(expiry)::timestamptz AS oldest
    FROM (
      SELECT proof.proof_expires_at AS expiry
      FROM sync_pull_cursor_recovery_proofs AS proof
      WHERE proof.proof_expires_at <= ${now}
         OR proof.consumed_at IS NOT NULL
         OR EXISTS (SELECT 1 FROM sync_replicas AS replica
           WHERE replica.replica_id = proof.replica_id
             AND replica.status IN ('recovery_required', 'retired'))
      UNION ALL
      SELECT evidence.cursor_expires_at AS expiry
      FROM sync_pull_cursor_evidence AS evidence
      WHERE evidence.cursor IS NOT NULL
        AND (evidence.cursor_expires_at <= ${now}
          OR EXISTS (SELECT 1 FROM sync_replicas AS replica
            WHERE replica.replica_id = evidence.replica_id
              AND replica.status IN ('recovery_required', 'retired')))
      UNION ALL
      SELECT lineage.lineage_expires_at AS expiry
      FROM sync_pull_cursor_lineage AS lineage
      WHERE lineage.lineage_expires_at <= ${now}
         OR EXISTS (SELECT 1 FROM sync_replicas AS replica
           WHERE replica.replica_id = lineage.replica_id
             AND replica.status IN ('recovery_required', 'retired'))
      UNION ALL
      SELECT page.page_expires_at AS expiry
      FROM sync_pull_page_evidence AS page
      WHERE page.page_expires_at <= ${now}
         OR EXISTS (SELECT 1 FROM sync_replicas AS replica
           WHERE replica.replica_id = page.replica_id
             AND replica.status IN ('recovery_required', 'retired'))
    ) AS expired_candidates
    WHERE expiry <= ${now}
  `.execute(transaction);
  const oldest = result.rows[0]?.oldest;
  if (!(oldest instanceof Date)) return 0;
  return Math.max(0, now.getTime() - oldest.getTime());
}

export interface SyncEvidenceMaintenanceJobOptions {
  readonly intervalMs: number;
  readonly onStart?: () => void;
  readonly onResult?: (result: SyncEvidenceMaintenanceResult) => void;
  readonly onError?: (error: unknown) => void;
}

export class SyncEvidenceMaintenanceJob {
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  constructor(private readonly coordinator: SyncEvidenceMaintenanceCoordinator,
    private readonly options: SyncEvidenceMaintenanceJobOptions) {
    if (!Number.isInteger(options.intervalMs) || options.intervalMs < 1) {
      throw new TypeError('Invalid maintenance interval.');
    }
  }
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick(); }, this.options.intervalMs);
    this.timer.unref();
  }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined; }
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      this.options.onStart?.();
      const result = await this.coordinator.runBatch();
      this.options.onResult?.(result);
    } catch (error) { this.options.onError?.(error); }
    finally { this.running = false; }
  }
}
