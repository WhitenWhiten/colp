import type { Pool, PoolClient } from 'pg';
import type { OutboxHandlerMode } from './router.js';
import { redactSensitiveText } from '../telemetry/index.js';
import { rollbackTransaction } from '../database/transaction-rollback.js';

export interface OutboxClaim {
  readonly outboxId: string;
  readonly eventId: string;
  readonly eventType: string;
  readonly eventVersion: number;
  readonly handlerName: string;
  readonly handlerMode: OutboxHandlerMode;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly aggregateScope: string | null;
  readonly aggregateRevision: string | null;
  readonly commitOrdinal: string | null;
  readonly occurredAt: Date;
  readonly payload: unknown;
  readonly attemptCount: number;
  readonly leaseGeneration: string;
}

export type FailureDisposition = 'retryable' | 'dead_letter' | 'lease_lost';

export interface OutboxBacklog {
  readonly count: number;
  readonly oldestAgeMs: number;
}

export interface OutboxRepository {
  claim(leaseDurationMs: number): Promise<OutboxClaim | null>;
  inspectBacklog(): Promise<OutboxBacklog>;
  heartbeat(claim: OutboxClaim, leaseDurationMs: number): Promise<boolean>;
  isObsoleteProjection(claim: OutboxClaim): Promise<boolean>;
  hasDeliveryReceipt(claim: OutboxClaim): Promise<boolean>;
  complete(claim: OutboxClaim): Promise<boolean>;
  /**
   * Normal continuation control flow: CAS the active lease back to pending.
   * Preserves available_at and attempt_count; clears lease and last_error.
   * Returns false when the lease fence is lost (expired or taken over).
   */
  continue(claim: OutboxClaim): Promise<boolean>;
  fail(
    claim: OutboxClaim,
    error: string,
    retryDelayMs: number,
    maxAttempts: number,
  ): Promise<FailureDisposition>;
}

interface OutboxRow {
  outbox_id: string;
  domain_event_id: string;
  event_type: string;
  event_version: number;
  handler_name: string;
  handler_mode: OutboxHandlerMode;
  aggregate_type: string;
  aggregate_id: string;
  aggregate_scope: string | null;
  aggregate_revision: string | null;
  commit_ordinal: string | null;
  occurred_at: Date;
  payload_json: unknown;
  attempt_count: number;
  lease_generation: string;
}

interface OutboxCandidateRow {
  outbox_id: string;
  handler_name: string;
  handler_mode: OutboxHandlerMode;
  aggregate_id: string;
}

/**
 * Projection handlers serialize an aggregate's unfinished ordinals and reject
 * a candidate while another live lease owns that aggregate. Kept once here so
 * the pending and expired-lease index branches cannot drift semantically.
 */
const PROJECTION_CLAIM_FENCE_SQL = `
  AND NOT (
    event.handler_mode = 'projection_latest_only'
    AND EXISTS (
      SELECT 1 FROM outbox_events AS active
      WHERE active.outbox_id <> event.outbox_id
        AND active.handler_name = event.handler_name
        AND active.aggregate_id = event.aggregate_id
        AND active.state = 'leased'
        AND active.locked_until > current_timestamp
    )
  )
  AND NOT (
    event.handler_mode = 'projection_latest_only'
    AND EXISTS (
      SELECT 1 FROM outbox_events AS earlier
      WHERE earlier.outbox_id <> event.outbox_id
        AND earlier.handler_name = event.handler_name
        AND earlier.aggregate_id = event.aggregate_id
        AND earlier.state IN ('pending', 'retryable', 'leased')
        AND earlier.commit_ordinal < event.commit_ordinal
    )
  )
`;

// Large enough for cross-process SKIP LOCKED concurrency, while bounding the
// merge/sort work to 2 * this window regardless of total backlog size.
const OUTBOX_CLAIM_CANDIDATE_WINDOW = 128;

async function inTransaction<Result>(
  pool: Pool,
  callback: (client: PoolClient) => Promise<Result>,
): Promise<Result> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error: unknown) {
    await rollbackTransaction(error, () => client.query('ROLLBACK'), 'Outbox repository transaction');
    throw error;
  } finally {
    client.release();
  }
}

function toClaim(row: OutboxRow): OutboxClaim {
  return Object.freeze({
    outboxId: row.outbox_id,
    eventId: row.domain_event_id,
    eventType: row.event_type,
    eventVersion: row.event_version,
    handlerName: row.handler_name,
    handlerMode: row.handler_mode,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    aggregateScope: row.aggregate_scope,
    aggregateRevision: row.aggregate_revision,
    commitOrdinal: row.commit_ordinal,
    occurredAt: row.occurred_at,
    payload: row.payload_json,
    attemptCount: row.attempt_count,
    leaseGeneration: row.lease_generation,
  });
}

export class PostgresOutboxRepository implements OutboxRepository {
  constructor(private readonly pool: Pool) {}

  claim(leaseDurationMs: number): Promise<OutboxClaim | null> {
    if (!Number.isInteger(leaseDurationMs) || leaseDurationMs < 1) {
      throw new RangeError('leaseDurationMs must be a positive integer');
    }
    return inTransaction(this.pool, async (client) => {
      // projection_latest_only claims are ordinal-serialized: only the minimum unfinished
      // ordinal (pending/retryable/leased) of a handler/aggregate may be claimed, so a
      // transiently failed lower-ordinal retry is never overtaken by a later event that
      // would advance the watermark past it. Dead-lettered rows are terminal and do not
      // count as unfinished; explicit ops replay/rebuild decisions own them.
      // Keep the two readiness states in independent index-ordered arms. The old
      // OR predicate forced PostgreSQL to merge a queued scan with an expired-
      // lease scan before finding one row, which degraded badly during a
      // backlog. Locking happens only after UNION, by joining the candidate ids
      // back to the base table: PostgreSQL forbids FOR UPDATE directly on a
      // UNION. Each arm contributes a bounded window so the final merge never
      // grows with backlog size, while 128 rows leave ample room for concurrent
      // workers to skip rows already locked by another process.
      const candidateResult = await client.query<OutboxCandidateRow>(`
        WITH candidates AS (
          (
            SELECT event.outbox_id, event.available_at AS ready_at
              FROM outbox_events AS event
             WHERE event.state IN ('pending', 'retryable')
               AND event.available_at <= current_timestamp
               ${PROJECTION_CLAIM_FENCE_SQL}
             ORDER BY event.available_at, event.outbox_id
             LIMIT ${OUTBOX_CLAIM_CANDIDATE_WINDOW}
          )
          UNION ALL
          (
            SELECT event.outbox_id, event.locked_until AS ready_at
              FROM outbox_events AS event
             WHERE event.state = 'leased'
               AND event.locked_until <= current_timestamp
               ${PROJECTION_CLAIM_FENCE_SQL}
             ORDER BY event.locked_until, event.outbox_id
             LIMIT ${OUTBOX_CLAIM_CANDIDATE_WINDOW}
          )
        )
        SELECT event.outbox_id, event.handler_name, event.handler_mode, event.aggregate_id
          FROM candidates candidate
          JOIN outbox_events event ON event.outbox_id = candidate.outbox_id
         ORDER BY candidate.ready_at, candidate.outbox_id
         FOR UPDATE OF event SKIP LOCKED
         LIMIT 1
      `);
      const candidate = candidateResult.rows[0];
      if (!candidate) return null;

      if (candidate.handler_mode === 'projection_latest_only') {
        // The row lock only protects one event. The transaction-scoped advisory lock protects
        // the handler/resource pair so two workers cannot both pass the MVCC lease check.
        await client.query(
          'SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))',
          [candidate.handler_name, candidate.aggregate_id],
        );
      }

      // The candidate CTE uses the SELECT's older snapshot. Another claimant
      // can commit this same row before we acquire its lock; recheck readiness
      // here so a live lease (including our own candidate id) cannot be stolen.
      const result = await client.query<OutboxRow>(`
        UPDATE outbox_events AS event
        SET state = 'leased',
            attempt_count = event.attempt_count + 1,
            lease_generation = event.lease_generation + 1,
            locked_until = current_timestamp + ($1 * interval '1 millisecond'),
            last_error = NULL
        WHERE event.outbox_id = $2
          AND (
            (event.state IN ('pending', 'retryable') AND event.available_at <= current_timestamp)
            OR (event.state = 'leased' AND event.locked_until <= current_timestamp)
          )
          AND NOT (
            event.handler_mode = 'projection_latest_only'
            AND EXISTS (
              SELECT 1 FROM outbox_events AS active
              WHERE active.outbox_id <> event.outbox_id
                AND active.handler_name = event.handler_name
                AND active.aggregate_id = event.aggregate_id
                AND active.state = 'leased'
                AND active.locked_until > current_timestamp
            )
          )
          AND NOT (
            event.handler_mode = 'projection_latest_only'
            AND EXISTS (
              SELECT 1 FROM outbox_events AS earlier
              WHERE earlier.outbox_id <> event.outbox_id
                AND earlier.handler_name = event.handler_name
                AND earlier.aggregate_id = event.aggregate_id
                AND earlier.state IN ('pending', 'retryable', 'leased')
                AND earlier.commit_ordinal < event.commit_ordinal
            )
          )
        RETURNING event.outbox_id, event.domain_event_id, event.event_type, event.event_version,
                  event.handler_name, event.handler_mode, event.aggregate_type, event.aggregate_id,
                  event.aggregate_scope, event.aggregate_revision, event.commit_ordinal,
                  event.occurred_at, event.payload_json, event.attempt_count, event.lease_generation
      `, [leaseDurationMs, candidate.outbox_id]);
      return result.rows[0] ? toClaim(result.rows[0]) : null;
    });
  }

  async inspectBacklog(): Promise<OutboxBacklog> {
    const result = await this.pool.query<{ count: string; oldest_age_ms: string | null }>(`
      SELECT count(*)::text AS count,
             coalesce(extract(epoch FROM (current_timestamp - min(occurred_at))) * 1000, 0)::text
               AS oldest_age_ms
      FROM outbox_events
      WHERE state IN ('pending', 'retryable', 'leased')
    `);
    return {
      count: Number(result.rows[0]?.count ?? 0),
      oldestAgeMs: Math.max(0, Number(result.rows[0]?.oldest_age_ms ?? 0)),
    };
  }

  async heartbeat(claim: OutboxClaim, leaseDurationMs: number): Promise<boolean> {
    if (!Number.isInteger(leaseDurationMs) || leaseDurationMs < 1) {
      throw new RangeError('leaseDurationMs must be a positive integer');
    }
    const result = await this.pool.query(`
      UPDATE outbox_events
      SET locked_until = current_timestamp + ($3 * interval '1 millisecond')
      WHERE outbox_id = $1
        AND state = 'leased'
        AND lease_generation = $2
        AND locked_until > current_timestamp
    `, [claim.outboxId, claim.leaseGeneration, leaseDurationMs]);
    return result.rowCount === 1;
  }

  async isObsoleteProjection(claim: OutboxClaim): Promise<boolean> {
    if (claim.handlerMode !== 'projection_latest_only' || claim.commitOrdinal === null) return false;
    const result = await this.pool.query<{ obsolete: boolean }>(`
      SELECT EXISTS (
        SELECT 1 FROM outbox_projection_watermarks
        WHERE handler_name = $1 AND aggregate_id = $2 AND commit_ordinal >= $3
      ) AS obsolete
    `, [claim.handlerName, claim.aggregateId, claim.commitOrdinal]);
    return result.rows[0]?.obsolete === true;
  }

  async hasDeliveryReceipt(claim: OutboxClaim): Promise<boolean> {
    if (claim.handlerMode !== 'delivery_each_event') return false;
    const result = await this.pool.query<{ delivered: boolean }>(`
      SELECT EXISTS (
        SELECT 1 FROM outbox_delivery_receipts
        WHERE handler_name = $1 AND domain_event_id = $2
      ) AS delivered
    `, [claim.handlerName, claim.eventId]);
    return result.rows[0]?.delivered === true;
  }

  complete(claim: OutboxClaim): Promise<boolean> {
    return inTransaction(this.pool, async (client) => {
      const completed = await client.query(`
        UPDATE outbox_events
        SET state = 'completed', completed_at = current_timestamp, locked_until = NULL
        WHERE outbox_id = $1
          AND state = 'leased'
          AND lease_generation = $2
          AND locked_until > current_timestamp
      `, [claim.outboxId, claim.leaseGeneration]);
      if (completed.rowCount !== 1) return false;

      if (claim.handlerMode === 'projection_latest_only'
        && claim.commitOrdinal !== null) {
        await client.query(`
          INSERT INTO outbox_projection_watermarks(handler_name, aggregate_id, commit_ordinal)
          VALUES ($1, $2, $3)
          ON CONFLICT (handler_name, aggregate_id) DO UPDATE
          SET commit_ordinal = GREATEST(outbox_projection_watermarks.commit_ordinal, EXCLUDED.commit_ordinal),
              updated_at = current_timestamp
        `, [claim.handlerName, claim.aggregateId, claim.commitOrdinal]);
      } else if (claim.handlerMode === 'delivery_each_event') {
        await client.query(`
          INSERT INTO outbox_delivery_receipts(handler_name, domain_event_id)
          VALUES ($1, $2)
          ON CONFLICT DO NOTHING
        `, [claim.handlerName, claim.eventId]);
      }
      return true;
    });
  }

  async continue(claim: OutboxClaim): Promise<boolean> {
    const result = await this.pool.query(`
      UPDATE outbox_events
      SET state = 'pending',
          locked_until = NULL,
          last_error = NULL
      WHERE outbox_id = $1
        AND state = 'leased'
        AND lease_generation = $2
        AND locked_until > current_timestamp
    `, [claim.outboxId, claim.leaseGeneration]);
    return result.rowCount === 1;
  }

  async fail(
    claim: OutboxClaim,
    error: string,
    retryDelayMs: number,
    maxAttempts: number,
  ): Promise<FailureDisposition> {
    if (!Number.isFinite(retryDelayMs) || retryDelayMs < 1) {
      throw new RangeError('retryDelayMs must be positive');
    }
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
      throw new RangeError('maxAttempts must be a positive integer');
    }
    const deadLetter = claim.attemptCount >= maxAttempts;
    const result = await this.pool.query(`
      UPDATE outbox_events
      SET state = $3,
          available_at = CASE WHEN $3 = 'retryable'
            THEN current_timestamp + ($4 * interval '1 millisecond') ELSE available_at END,
          locked_until = NULL,
          dead_lettered_at = CASE WHEN $3 = 'dead_letter' THEN current_timestamp ELSE NULL END,
          last_error = $5
      WHERE outbox_id = $1
        AND state = 'leased'
        AND lease_generation = $2
        AND locked_until > current_timestamp
    `, [
      claim.outboxId,
      claim.leaseGeneration,
      deadLetter ? 'dead_letter' : 'retryable',
      retryDelayMs,
      redactSensitiveText(error).slice(0, 4_000),
    ]);
    if (result.rowCount !== 1) return 'lease_lost';
    return deadLetter ? 'dead_letter' : 'retryable';
  }
}
