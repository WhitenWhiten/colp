import { sql } from 'kysely';
import { appendAuditEvent } from '../../database/audit-event-payload.js';
import type { DatabaseTransaction } from '../../database/unit-of-work.js';

/** Terminal Ack receipts are small; a wider batch releases their pinned evidence sooner. */
const ACK_RECEIPT_CLEANUP_LIMIT = 500;
/** Keep terminal Session authority for one day after termination, then reclaim it. */
const SESSION_CLEANUP_LIMIT = 100;
const SESSION_CLEANUP_GRACE_MS = 24 * 60 * 60 * 1000;
/** Bound the retired Replicas whose sequence authority is reclaimed in one run. */
const SEQUENCE_CLEANUP_LIMIT = 50;
/** A bounded sweep: an idle renewal cadence must not accumulate active Sessions. */
const EXPIRED_SESSION_CLEANUP_LIMIT = 100;

/** A terminated Session with no protocol child reference is safe to reclaim. */
export function reclaimableTerminalSessions(now: Date) {
  const cutoff = new Date(now.getTime() - SESSION_CLEANUP_GRACE_MS);
  // Sequence receipts are retained for the Replica lifetime (and replay by
  // replica + sequence), so they are deliberately not a child reference here:
  // the migration releasing their Session FK lets a superseded Session go.
  return sql`session.status = 'terminated'
    AND session.terminated_at <= ${cutoff}
    AND NOT EXISTS (SELECT 1 FROM sync_pull_cursor_evidence child WHERE child.session_id = session.session_id)
    AND NOT EXISTS (SELECT 1 FROM sync_pull_page_evidence child WHERE child.session_id = session.session_id)
    AND NOT EXISTS (SELECT 1 FROM sync_ack_receipts child WHERE child.session_id = session.session_id)
    AND NOT EXISTS (SELECT 1 FROM sync_conflicts child WHERE child.session_id = session.session_id)
    AND NOT EXISTS (SELECT 1 FROM sync_recovery_capabilities child WHERE child.session_id = session.session_id)
    AND NOT EXISTS (SELECT 1 FROM sync_bootstrap_snapshots child WHERE child.session_id = session.session_id)
    AND NOT EXISTS (SELECT 1 FROM sync_bootstrap_snapshot_pages child WHERE child.session_id = session.session_id)
    AND NOT EXISTS (SELECT 1 FROM sync_recovery_ack_receipts child WHERE child.session_id = session.session_id)
    AND NOT EXISTS (SELECT 1 FROM sync_replica_retirement_receipts child WHERE child.session_id = session.session_id)
    AND NOT EXISTS (SELECT 1 FROM sync_bootstrap_snapshot_conflict_receipts child WHERE child.session_id = session.session_id)
    AND NOT EXISTS (SELECT 1 FROM sync_bootstrap_snapshot_conflict_page_proofs child WHERE child.session_id = session.session_id)
    AND NOT EXISTS (SELECT 1 FROM sync_pull_cursor_recovery_proofs child WHERE child.authority_session_id = session.session_id)
    AND NOT EXISTS (SELECT 1 FROM sync_pull_cursor_lineage child WHERE child.session_id = session.session_id)`;
}

/**
 * A2-3: issuance normally terminates its predecessor, but a Session whose
 * lifetime lapses without a renewal is otherwise left active forever. Terminate
 * it durably (with the same audit event as every other transition) before the
 * receipt/evidence/session passes so terminal cleanup can reclaim it later.
 */
async function expireLapsedSyncSessions(
  transaction: DatabaseTransaction,
  now: Date,
  batchSize: number,
): Promise<{ attempted: number; deleted: number }> {
  const expired = await sql<{ session_id: string; account_id: string; collection_id: string;
    replica_id: string }>`
    WITH lapsed AS MATERIALIZED (
      SELECT session.session_id
      FROM sync_sessions AS session
      WHERE session.status = 'active' AND session.expires_at <= ${now}
      ORDER BY session.expires_at, session.session_id
      LIMIT ${Math.min(batchSize, EXPIRED_SESSION_CLEANUP_LIMIT)}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE sync_sessions AS session
    SET status = 'terminated', termination_reason = 'lease_expired', terminated_at = ${now}
    FROM lapsed
    WHERE session.session_id = lapsed.session_id AND session.status = 'active'
    RETURNING session.session_id, session.account_id, session.collection_id, session.replica_id
  `.execute(transaction);
  for (const row of expired.rows) {
    await appendAuditEvent(transaction, {
      operationId: null,
      collectionId: null,
      principalId: row.account_id,
      eventType: 'sync.session.terminated',
      details: {
        sessionId: row.session_id,
        collectionId: row.collection_id,
        replicaId: row.replica_id,
        reason: 'lease_expired',
      },
      createdAt: now,
    });
  }
  return { attempted: expired.rows.length, deleted: 0 };
}

/** Reclaim terminal protocol authority inside the coordinator's existing transaction. */
export async function cleanupTerminalSyncAuthority(
  transaction: DatabaseTransaction,
  now: Date,
  batchSize: number,
): Promise<{ attempted: number; deleted: number }> {
  // A2-3: durably close lapsed active Sessions before the receipt/evidence/
  // session passes so they enter the normal terminal-retention lifecycle.
  const lapsedSessions = await expireLapsedSyncSessions(transaction, now, batchSize);

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
      LIMIT ${Math.min(batchSize, ACK_RECEIPT_CLEANUP_LIMIT)}
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

  const sequenceReplicas = await sql<{ replica_id: string }>`
    SELECT replica.replica_id
    FROM sync_replicas AS replica
    WHERE replica.status = 'retired'
      AND (EXISTS (SELECT 1 FROM sync_sequence_receipts AS receipt
            WHERE receipt.replica_id = replica.replica_id)
        OR EXISTS (SELECT 1 FROM sync_sequence_operation_claims AS claim
            WHERE claim.replica_id = replica.replica_id)
        OR EXISTS (SELECT 1 FROM sync_sequence_lanes AS lane
            WHERE lane.replica_id = replica.replica_id))
    ORDER BY replica.replica_id
    LIMIT ${Math.min(batchSize, SEQUENCE_CLEANUP_LIMIT)}
    FOR UPDATE SKIP LOCKED
  `.execute(transaction);

  let sequenceRowsDeleted = 0;
  if (sequenceReplicas.rows.length > 0) {
    const replicaIds = sequenceReplicas.rows.map((row) => row.replica_id);
    const retired = sql<{ replica_id: string }>`EXISTS (SELECT 1 FROM sync_replicas AS replica
      WHERE replica.replica_id = retired_replica.replica_id AND replica.status = 'retired')`;
    const receiptsDeleted = await sql<{ replica_id: string }>`
      DELETE FROM sync_sequence_receipts AS retired_replica
      WHERE retired_replica.replica_id = ANY(${replicaIds}::text[])
        AND ${retired}
      RETURNING replica_id
    `.execute(transaction);
    const claimsDeleted = await sql<{ replica_id: string }>`
      DELETE FROM sync_sequence_operation_claims AS retired_replica
      WHERE retired_replica.replica_id = ANY(${replicaIds}::text[])
        AND ${retired}
      RETURNING replica_id
    `.execute(transaction);
    const lanesDeleted = await sql<{ replica_id: string }>`
      DELETE FROM sync_sequence_lanes AS retired_replica
      WHERE retired_replica.replica_id = ANY(${replicaIds}::text[])
        AND ${retired}
      RETURNING replica_id
    `.execute(transaction);
    sequenceRowsDeleted = receiptsDeleted.rows.length + claimsDeleted.rows.length
      + lanesDeleted.rows.length;
  }

  return {
    attempted: lapsedSessions.attempted + ackReceiptsDeleted.rows.length + sequenceReplicas.rows.length,
    deleted: lapsedSessions.deleted + ackReceiptsDeleted.rows.length + sequenceRowsDeleted,
  };
}

/**
 * Reclaim terminal Sessions after the same run's evidence/page/snapshot passes
 * have released every protocol child row that pinned them. Running this after
 * those passes lets a Session whose last redacted child was deleted in this
 * transaction become reclaimable immediately instead of a run later.
 */
export async function reclaimTerminalSyncSessions(
  transaction: DatabaseTransaction,
  now: Date,
  batchSize: number,
): Promise<{ attempted: number; deleted: number }> {
  // Conflict page proofs are Snapshot-lifetime delivery facts. A terminated
  // Session can never list or confirm again, so their RESTRICT reference must
  // be released before the candidate predicate can see that Session.
  const cutoff = new Date(now.getTime() - SESSION_CLEANUP_GRACE_MS);
  const conflictProofsDeleted = await sql<{ session_id: string }>`
    WITH proofs AS MATERIALIZED (
      SELECT proof.snapshot_id, proof.session_id, proof.page_offset, proof.returned_count
      FROM sync_bootstrap_snapshot_conflict_page_proofs AS proof
      JOIN sync_sessions AS session ON session.session_id = proof.session_id
      WHERE session.status = 'terminated' AND session.terminated_at <= ${cutoff}
      ORDER BY proof.served_at, proof.snapshot_id, proof.page_offset
      LIMIT ${batchSize}
      FOR UPDATE OF proof SKIP LOCKED
    )
    DELETE FROM sync_bootstrap_snapshot_conflict_page_proofs AS proof
    USING proofs
    WHERE proof.snapshot_id = proofs.snapshot_id AND proof.session_id = proofs.session_id
      AND proof.page_offset = proofs.page_offset AND proof.returned_count = proofs.returned_count
    RETURNING proof.session_id
  `.execute(transaction);

  const sessionCandidates = await sql<{ session_id: string }>`
    SELECT session.session_id
    FROM sync_sessions AS session
    WHERE ${reclaimableTerminalSessions(now)}
    ORDER BY session.terminated_at, session.session_id
    LIMIT ${Math.min(batchSize, SESSION_CLEANUP_LIMIT)}
    FOR UPDATE SKIP LOCKED
  `.execute(transaction);

  let terminalSessionRowsDeleted = 0;
  if (sessionCandidates.rows.length > 0) {
    const sessionIds = sessionCandidates.rows.map((row) => row.session_id);
    const receiptsDeleted = await sql<{ session_id: string }>`
      DELETE FROM sync_session_idempotency_receipts
      WHERE session_id = ANY(${sessionIds}::text[])
      RETURNING session_id
    `.execute(transaction);
    const bindingsDeleted = await sql<{ session_id: string }>`
      DELETE FROM sync_session_bindings
      WHERE session_id = ANY(${sessionIds}::text[])
      RETURNING session_id
    `.execute(transaction);
    const scopesDeleted = await sql<{ session_id: string }>`
      DELETE FROM sync_session_scopes
      WHERE session_id = ANY(${sessionIds}::text[])
      RETURNING session_id
    `.execute(transaction);
    const sessionsDeleted = await sql<{ session_id: string }>`
      DELETE FROM sync_sessions AS session
      WHERE session.session_id = ANY(${sessionIds}::text[])
        AND ${reclaimableTerminalSessions(now)}
      RETURNING session.session_id
    `.execute(transaction);
    if (sessionsDeleted.rows.length !== sessionIds.length) {
      throw new Error('Sync Session cleanup authority changed during reclamation');
    }
    terminalSessionRowsDeleted = receiptsDeleted.rows.length + bindingsDeleted.rows.length
      + scopesDeleted.rows.length + sessionsDeleted.rows.length;
  }

  return {
    attempted: sessionCandidates.rows.length,
    deleted: conflictProofsDeleted.rows.length + terminalSessionRowsDeleted,
  };
}
