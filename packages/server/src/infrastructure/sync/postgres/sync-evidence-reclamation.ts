/**
 * Reclaimability predicates and the redacted-evidence release pass of the R15
 * evidence/proof maintenance coordinator.
 *
 * The coordinator's candidate CTE, the backlog-age inspection, and the
 * redacted-evidence second pass all evaluate the same trigger-allowed DELETE
 * allowances. Keeping them here puts the SQL predicates next to the pass that
 * consumes them and keeps `sync-evidence-maintenance-postgres.ts` under the
 * production source-size limit.
 */
import { sql } from 'kysely';
import type { DatabaseTransaction } from '../../database/unit-of-work.js';

/** Retained Ack evidence must not consume every slot ahead of reclaimable work. */
export function actionableEvidence(now: Date) {
  return sql`evidence.cursor IS NOT NULL
    AND (evidence.cursor_expires_at <= ${now} OR EXISTS (
      SELECT 1 FROM sync_replicas replica WHERE replica.replica_id=evidence.replica_id
        AND replica.status IN ('recovery_required','retired')))
    AND (NOT EXISTS (SELECT 1 FROM sync_ack_receipts receipt
      WHERE receipt.replica_id=evidence.replica_id AND receipt.cursor_digest=evidence.cursor_digest)
      OR EXISTS (SELECT 1 FROM sync_replicas replica
        WHERE replica.replica_id=evidence.replica_id AND replica.checkpoint_cursor=evidence.cursor))`;
}

/**
 * A2-2: redacted rows (cursor IS NULL) keep the digest and tuple authority that
 * a checkpoint still needs, so the first cleanup pass deliberately stops at
 * redaction. They still pin their Session through the RESTRICT foreign key,
 * forever. A second pass may delete a redacted row once nothing authority-bearing
 * still names its digest: no Ack receipt (the retention trigger's own DELETE
 * allowance), no Replica checkpoint for that digest, no live unconsumed recovery
 * proof (a pending recovery capability), and no page envelope handoff.
 *
 * Digest-only lineage is also a blocker while it is live. It outlives the
 * evidence row, but it still references the Session (`ON DELETE CASCADE`) and
 * its guard forbids deletion before `lineage_expires_at`; deleting the evidence
 * first would therefore release nothing and leave the Session pinned by
 * lineage alone. Once lineage expires, the lineage pass deletes it in the same
 * run and this predicate admits the redacted row (candidate selection already
 * sees a non-live lineage row, and the write re-check sees it gone).
 */
export function reclaimableRedactedEvidence(now: Date) {
  return sql`evidence.cursor IS NULL
    AND (evidence.cursor_expires_at <= ${now} OR EXISTS (
      SELECT 1 FROM sync_replicas replica WHERE replica.replica_id=evidence.replica_id
        AND replica.status IN ('recovery_required','retired')))
    AND NOT EXISTS (SELECT 1 FROM sync_ack_receipts receipt
      WHERE receipt.replica_id=evidence.replica_id AND receipt.cursor_digest=evidence.cursor_digest)
    AND NOT EXISTS (SELECT 1 FROM sync_replicas replica
      WHERE replica.replica_id=evidence.replica_id AND replica.checkpoint_cursor IS NOT NULL
        AND encode(public.digest(convert_to(replica.checkpoint_cursor, 'UTF8'), 'sha256'), 'hex')
          = evidence.cursor_digest)
    AND NOT EXISTS (SELECT 1 FROM sync_pull_cursor_recovery_proofs proof
      WHERE proof.replica_id=evidence.replica_id AND proof.cursor_digest=evidence.cursor_digest
        AND proof.consumed_at IS NULL AND proof.proof_expires_at > ${now})
    AND NOT EXISTS (SELECT 1 FROM sync_pull_cursor_lineage lineage
      WHERE lineage.replica_id=evidence.replica_id AND lineage.cursor_digest=evidence.cursor_digest
        AND lineage.lineage_expires_at > ${now})
    AND NOT EXISTS (SELECT 1 FROM sync_pull_page_evidence page
      WHERE page.replica_id=evidence.replica_id AND page.next_cursor_digest=evidence.cursor_digest)`;
}

export function actionablePages(now: Date) {
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
export function actionableSnapshots(now: Date) {
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
 * A2-2 second pass: redacted rows whose digest no authority still needs release
 * the RESTRICT Session reference so terminal cleanup can proceed. It runs after
 * the page pass so an envelope deleted earlier in the transaction is already
 * gone when the write re-check evaluates the predicate.
 */
export async function reclaimRedactedEvidence(
  transaction: DatabaseTransaction,
  now: Date,
  evidenceIds: readonly (bigint | string)[],
): Promise<number> {
  if (evidenceIds.length === 0) return 0;
  const deleted = await sql<{ evidence_id: bigint | string }>`
    DELETE FROM sync_pull_cursor_evidence AS evidence
    WHERE evidence.evidence_id = ANY(${evidenceIds}::bigint[])
      AND ${reclaimableRedactedEvidence(now)}
    RETURNING evidence.evidence_id
  `.execute(transaction);
  return deleted.rows.length;
}
