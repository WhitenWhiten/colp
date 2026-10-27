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

interface SnapshotCleanupCandidateRow {
  snapshot_id: string;
  expires_at: Date;
  receipt_pinned: boolean;
}

/** Bound bootstrap Snapshot reclamation by both header count and cascaded node rows. */
const SNAPSHOT_CLEANUP_LIMIT = 25;
const SNAPSHOT_NODE_BUDGET = 100_000;
/** Terminal Ack receipts are small; a wider batch releases their pinned evidence sooner. */
const ACK_RECEIPT_CLEANUP_LIMIT = 500;

/** Retained Ack evidence must not consume every slot ahead of reclaimable work. */
function actionableEvidence(now: Date) {
  return sql`evidence.cursor IS NOT NULL
    AND (evidence.cursor_expires_at <= ${now} OR EXISTS (
      SELECT 1 FROM sync_replicas replica WHERE replica.replica_id=evidence.replica_id
        AND replica.status IN ('recovery_required','retired')))
    AND (NOT EXISTS (SELECT 1 FROM sync_ack_receipts receipt
      WHERE receipt.replica_id=evidence.replica_id AND receipt.cursor_digest=evidence.cursor_digest)
      OR EXISTS (SELECT 1 FROM sync_replicas replica
        WHERE replica.replica_id=evidence.replica_id AND replica.checkpoint_cursor=evidence.cursor))`;
}

function actionablePages(now: Date) {
  return sql`(page.page_expires_at <= ${now} OR EXISTS (
      SELECT 1 FROM sync_replicas replica WHERE replica.replica_id=page.replica_id
        AND replica.status IN ('recovery_required','retired')))
    AND NOT EXISTS (SELECT 1 FROM sync_ack_receipts receipt
      WHERE receipt.replica_id=page.replica_id AND receipt.cursor_digest=page.next_cursor_digest)
    AND NOT EXISTS (SELECT 1 FROM sync_replicas replica JOIN sync_pull_cursor_evidence evidence
      ON evidence.replica_id=replica.replica_id AND evidence.cursor=replica.checkpoint_cursor
      WHERE replica.replica_id=page.replica_id AND evidence.cursor_digest=page.next_cursor_digest)`;
}

/** A Snapshot can only be reclaimed after its expiry fence and without a live capability. */
function actionableSnapshots(now: Date) {
  return sql`snapshot.expires_at <= ${now}
    AND NOT EXISTS (
      SELECT 1 FROM sync_recovery_capabilities AS capability
      WHERE capability.snapshot_id = snapshot.snapshot_id
        AND capability.expires_at > ${now}
    )
    AND (
      NOT EXISTS (SELECT 1 FROM sync_recovery_ack_receipts AS receipt
        WHERE receipt.snapshot_id = snapshot.snapshot_id)
      OR EXISTS (SELECT 1 FROM sync_bootstrap_snapshot_pages AS page
        WHERE page.snapshot_id = snapshot.snapshot_id)
      OR EXISTS (SELECT 1 FROM sync_bootstrap_snapshot_nodes AS node
        WHERE node.snapshot_id = snapshot.snapshot_id)
    )`;
}

/**
 * R15 global evidence/proof maintenance coordinator.
 *
 * One transaction per run:
 * 1. Terminal Ack receipts (terminated Session or retired Replica) are deleted
 *    first, bounded by ACK_RECEIPT_CLEANUP_LIMIT. Their RESTRICT evidence can
 *    then be reclaimed by the same run.
 * 2. A candidate CTE over proofs, next-cursor evidence, lineage, and page
 *    envelopes selects the oldest expired/consumed/retired rows, oldest-first,
 *    and locks the batch with FOR UPDATE SKIP LOCKED so concurrent workers never
 *    process the same rows. batchSize caps the total candidate rows per run.
 * 3. Proofs are deleted first: the candidate predicate mirrors exactly the
 *    guard_sync_pull_cursor_recovery_proof() DELETE allowance
 *    (proof_expires_at <= now OR consumed_at IS NOT NULL OR retired status).
 * 4. Evidence whose cursor is neither an Ack receipt target nor a checkpoint
 *    reference is deleted; the predicate mirrors guard_sync_pull_cursor_evidence_retention()
 *    DELETE allowance (expired-or-retired AND NOT EXISTS ack AND NOT EXISTS checkpoint).
 * 5. Expired checkpoint-referenced evidence is only redacted (cursor -> NULL),
 *    keeping cursor_digest + tuple authority; the UPDATE predicate mirrors the
 *    trigger's UPDATE allowance. Redacted rows are excluded from future runs
 *    (cursor IS NOT NULL), so repeated runs are idempotent.
 * 6. Live-Ack-protected evidence and protected page envelopes stay intact and
 *    do not occupy candidate slots. A protection race is still classified at write time.
 * 7. Expired bootstrap Snapshot evidence is reclaimed after the active stores:
 *    page and node rows and expired capabilities are deleted for Snapshots past
 *    their expiry fence, then the Snapshot header is deleted unless a recovery
 *    Ack receipt needs it for Replica-lifetime replay.
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

      // Release terminal Ack receipts first so the evidence candidate pass below
      // can reclaim the cursor/page rows they were pinning in the same run.
      const ackReceiptsDeleted = await sql<{ principal_id: string; idempotency_key: string }>`
        WITH receipts AS MATERIALIZED (
          SELECT receipt.principal_id AS ack_principal_id, receipt.idempotency_key AS ack_idempotency_key
          FROM sync_ack_receipts AS receipt
          WHERE EXISTS (SELECT 1 FROM sync_sessions AS session
              WHERE session.session_id = receipt.session_id AND session.status = 'terminated')
            OR EXISTS (SELECT 1 FROM sync_replicas AS replica
              WHERE replica.replica_id = receipt.replica_id AND replica.status = 'retired')
          ORDER BY receipt.completed_at, receipt.principal_id, receipt.idempotency_key
          LIMIT ${Math.min(this.options.batchSize, ACK_RECEIPT_CLEANUP_LIMIT)}
          FOR UPDATE SKIP LOCKED
        )
        DELETE FROM sync_ack_receipts AS receipt
        USING receipts
        WHERE receipt.principal_id = receipts.ack_principal_id
          AND receipt.idempotency_key = receipts.ack_idempotency_key
          AND (EXISTS (SELECT 1 FROM sync_sessions AS session
                WHERE session.session_id = receipt.session_id AND session.status = 'terminated')
            OR EXISTS (SELECT 1 FROM sync_replicas AS replica
              WHERE replica.replica_id = receipt.replica_id AND replica.status = 'retired'))
        RETURNING principal_id, idempotency_key
      `.execute(transaction);

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
          WHERE ${actionableEvidence(now)}
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
          WHERE ${actionablePages(now)}
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

      const snapshotCandidates = await sql<SnapshotCleanupCandidateRow>`
        WITH snapshots AS MATERIALIZED (
          SELECT snapshot.snapshot_id, snapshot.expires_at, coalesce(snapshot.node_count, 1) AS node_count,
            EXISTS (SELECT 1 FROM sync_recovery_ack_receipts AS receipt
              WHERE receipt.snapshot_id = snapshot.snapshot_id) AS receipt_pinned
          FROM sync_bootstrap_snapshots AS snapshot
          WHERE ${actionableSnapshots(now)}
          ORDER BY snapshot.expires_at, snapshot.snapshot_id
          LIMIT ${Math.min(this.options.batchSize, SNAPSHOT_CLEANUP_LIMIT)}
          FOR UPDATE SKIP LOCKED
        )
        SELECT snapshot_id, expires_at, receipt_pinned
        FROM (
          SELECT snapshot_id, expires_at, receipt_pinned, node_count,
            sum(node_count) OVER (ORDER BY expires_at, snapshot_id ROWS UNBOUNDED PRECEDING) AS cumulative_nodes
          FROM snapshots
        ) AS ranked
        WHERE cumulative_nodes <= ${SNAPSHOT_NODE_BUDGET}
          OR cumulative_nodes = node_count
        ORDER BY expires_at, snapshot_id
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
      deleted += ackReceiptsDeleted.rows.length;
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

      // A Snapshot is unusable past expires_at: page reads, capability issuance
      // and Ack all reject it. Reclaim its page and node bytes, then delete the
      // header when no Ack receipt pins it. A receipt keeps only the small header
      // and capability row needed for idempotent replay.
      if (snapshotCandidates.rows.length > 0) {
        const snapshotIds = snapshotCandidates.rows.map((row) => row.snapshot_id);
        const snapshotPagesDeleted = await sql<{ snapshot_id: string }>`
          DELETE FROM sync_bootstrap_snapshot_pages AS page
          USING sync_bootstrap_snapshots AS snapshot
          WHERE page.snapshot_id = snapshot.snapshot_id
            AND page.snapshot_id = ANY(${snapshotIds}::text[])
            AND snapshot.expires_at <= current_timestamp
          RETURNING page.snapshot_id
        `.execute(transaction);
        deleted += snapshotPagesDeleted.rows.length;

        const snapshotNodesDeleted = await sql<{ snapshot_id: string }>`
          DELETE FROM sync_bootstrap_snapshot_nodes AS snapshot_node
          USING sync_bootstrap_snapshots AS snapshot
          WHERE snapshot_node.snapshot_id = snapshot.snapshot_id
            AND snapshot_node.snapshot_id = ANY(${snapshotIds}::text[])
            AND snapshot.expires_at <= current_timestamp
          RETURNING snapshot_node.snapshot_id
        `.execute(transaction);
        deleted += snapshotNodesDeleted.rows.length;

        const snapshotCapabilitiesDeleted = await sql<{ capability_digest: string }>`
          DELETE FROM sync_recovery_capabilities AS capability
          WHERE capability.snapshot_id = ANY(${snapshotIds}::text[])
            AND capability.expires_at <= current_timestamp
            AND NOT EXISTS (SELECT 1 FROM sync_recovery_ack_receipts AS receipt
              WHERE receipt.capability_digest = capability.capability_digest)
          RETURNING capability.capability_digest
        `.execute(transaction);
        deleted += snapshotCapabilitiesDeleted.rows.length;

        const snapshotHeadersDeleted = await sql<{ snapshot_id: string }>`
          DELETE FROM sync_bootstrap_snapshots AS snapshot
          WHERE snapshot.snapshot_id = ANY(${snapshotIds}::text[])
            AND snapshot.expires_at <= current_timestamp
            AND NOT EXISTS (SELECT 1 FROM sync_bootstrap_snapshot_pages AS page
              WHERE page.snapshot_id = snapshot.snapshot_id)
            AND NOT EXISTS (SELECT 1 FROM sync_recovery_capabilities AS capability
              WHERE capability.snapshot_id = snapshot.snapshot_id)
            AND NOT EXISTS (SELECT 1 FROM sync_recovery_ack_receipts AS receipt
              WHERE receipt.snapshot_id = snapshot.snapshot_id)
          RETURNING snapshot.snapshot_id
        `.execute(transaction);
        deleted += snapshotHeadersDeleted.rows.length;
      }

      const oldestExpiredAgeMs = await computeOldestExpiredAgeMs(transaction, now);
      await this.options.faultInjector?.afterPhase?.('before_commit');

      return Object.freeze({
        attempted: candidates.rows.length + snapshotCandidates.rows.length + ackReceiptsDeleted.rows.length,
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

/** Inspect at most one oldest actionable result per table; held retention is not backlog. */
async function computeOldestExpiredAgeMs(transaction: DatabaseTransaction, now: Date): Promise<number> {
  const result = await sql<{ oldest: Date | null }>`
    SELECT MIN(expiry)::timestamptz AS oldest
    FROM (
      (SELECT proof.proof_expires_at AS expiry
      FROM sync_pull_cursor_recovery_proofs AS proof
      WHERE proof.proof_expires_at <= ${now}
      ORDER BY proof.proof_expires_at LIMIT 1)
      UNION ALL
      (SELECT evidence.cursor_expires_at AS expiry
      FROM sync_pull_cursor_evidence AS evidence
      WHERE ${actionableEvidence(now)} AND evidence.cursor_expires_at <= ${now}
      ORDER BY evidence.cursor_expires_at LIMIT 1)
      UNION ALL
      (SELECT lineage.lineage_expires_at AS expiry
      FROM sync_pull_cursor_lineage AS lineage
      WHERE lineage.lineage_expires_at <= ${now}
      ORDER BY lineage.lineage_expires_at LIMIT 1)
      UNION ALL
      (SELECT page.page_expires_at AS expiry
      FROM sync_pull_page_evidence AS page
      WHERE ${actionablePages(now)} AND page.page_expires_at <= ${now}
      ORDER BY page.page_expires_at LIMIT 1)
      UNION ALL
      (SELECT receipt.completed_at AS expiry
      FROM sync_ack_receipts AS receipt
      WHERE EXISTS (SELECT 1 FROM sync_sessions AS session
          WHERE session.session_id = receipt.session_id AND session.status = 'terminated')
        OR EXISTS (SELECT 1 FROM sync_replicas AS replica
          WHERE replica.replica_id = receipt.replica_id AND replica.status = 'retired')
      ORDER BY receipt.completed_at LIMIT 1)
      UNION ALL
      (SELECT snapshot.expires_at AS expiry
      FROM sync_bootstrap_snapshots AS snapshot
      WHERE ${actionableSnapshots(now)}
      ORDER BY snapshot.expires_at LIMIT 1)
    ) AS expired_candidates
    WHERE expiry <= ${now}
  `.execute(transaction);
  const oldest = result.rows[0]?.oldest;
  if (!(oldest instanceof Date)) return 0;
  return Math.max(0, now.getTime() - oldest.getTime());
}

export interface SyncEvidenceMaintenanceJobOptions {
  readonly intervalMs: number;
  /** Must match the coordinator's per-transaction bound; defaults to 500. */
  readonly batchSize?: number;
  readonly now?: () => number;
  readonly onStart?: () => void;
  readonly onResult?: (result: SyncEvidenceMaintenanceResult) => void;
  readonly onError?: (error: unknown) => void;
}

export class SyncEvidenceMaintenanceJob {
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | undefined;
  private active = false;
  private stopped = false;
  constructor(private readonly coordinator: SyncEvidenceMaintenanceCoordinator,
    private readonly options: SyncEvidenceMaintenanceJobOptions) {
    if (!Number.isSafeInteger(options.intervalMs) || options.intervalMs < 1) {
      throw new TypeError('Invalid maintenance interval.');
    }
    if (options.batchSize !== undefined && (!Number.isSafeInteger(options.batchSize)
      || options.batchSize < 1 || options.batchSize > 20_000)) throw new TypeError('Invalid maintenance batch size.');
  }
  start(): void {
    if (this.active) return;
    this.active = true; this.stopped = false; this.schedule(0);
  }
  async stop(): Promise<void> {
    this.active = false; this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.running;
  }
  async tick(): Promise<void> {
    if (this.running || this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.running = this.drain();
    try { await this.running; }
    finally { this.running = undefined; }
  }
  private schedule(delay: number): void {
    if (!this.active) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = undefined; void this.tick(); }, delay);
    this.timer.unref();
  }
  private async drain(): Promise<void> {
    const now = this.options.now ?? (() => performance.now());
    const deadline = now() + 1_000;
    let backlog = false;
    try {
      // Each transaction keeps its existing row/lock bound. A burst yields
      // after 20 batches or one second, then resumes after 250 ms if still full.
      for (let batch = 0; batch < 20 && !this.stopped; batch++) {
        this.options.onStart?.();
        const result = await this.coordinator.runBatch();
        this.options.onResult?.(result);
        backlog = result.attempted >= (this.options.batchSize ?? 500)
          && result.deleted + result.redacted > 0;
        if (!backlog || now() >= deadline) break;
      }
    } catch (error) { backlog = false; this.options.onError?.(error); }
    finally { this.schedule(backlog ? 250 : this.options.intervalMs); }
  }
}
