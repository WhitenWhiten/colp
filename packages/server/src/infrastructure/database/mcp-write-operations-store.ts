import { sql, type Kysely } from 'kysely';
import type {
  Phase4bMcpWriteActionResult,
  Phase4bMcpWriteInspectionInput,
  Phase4bMcpWriteOperationsSnapshot,
  Phase4bMcpWriteOperationsStorePort,
} from '../../modules/mcp/index.js';
import type { DatabaseSchema } from './runtime.js';
import { createUnitOfWork, type DatabaseTransaction } from './unit-of-work.js';
import { expireDuePlansAt, purgeRetainedAt } from './mcp-change-plan-store.js';

/**
 * MCP-W09 PostgreSQL operations adapter over the session-free W02 store.
 *
 * Inspection is aggregate-only and never returns Plan IDs, binding facts,
 * summaries, notes, raw results, or errors. Expiry/retention and retry age
 * classification use the database clock so multi-instance operators share one
 * authority. Cancel/recovery use row locks and keep a completed receipt as an
 * unsafe unknown outcome rather than hiding an externally visible commit.
 */
interface InspectionRow {
  readonly plans: number;
  readonly pending: number;
  readonly approved: number;
  readonly committing: number;
  readonly consumed: number;
  readonly cancelled: number;
  readonly expired: number;
  readonly waiting_for_user: number;
  readonly retrying: number;
  readonly concurrent_commit: number;
  readonly unknown_outcome: number;
  readonly permanently_failed: number;
  readonly low_risk: number;
  readonly medium_risk: number;
  readonly high_risk: number;
  readonly approvals: number;
  readonly approvals_consumed: number;
  readonly incomplete_receipts: number;
  readonly completed_receipts: number;
  readonly due_expiry: number;
  readonly retained_plans: number;
  readonly retained_approvals: number;
  readonly retained_receipts: number;
  readonly oldest_waiting_for_user_ms: number | null;
  readonly oldest_approved_ms: number | null;
  readonly oldest_committing_ms: number | null;
  readonly oldest_retrying_ms: number | null;
  readonly oldest_unknown_outcome_ms: number | null;
  readonly oldest_permanent_failure_ms: number | null;
  readonly scanned_at: string;
}

export function createPostgresMcpWriteOperationsStore(
  db: Kysely<DatabaseSchema>,
): Phase4bMcpWriteOperationsStorePort {
  if (typeof db !== 'object' || db === null) {
    throw new TypeError('MCP-W09 PostgreSQL operations store requires a Kysely database.');
  }

  return Object.freeze({
    async inspect(input: Phase4bMcpWriteInspectionInput) {
      return inspectMcpWriteOperations(db, input);
    },
    async cancel(planId: string) {
      return createUnitOfWork(db).execute(({ transaction }) =>
        cancelMcpWritePlan(transaction, planId));
    },
    async recover(planId: string) {
      return createUnitOfWork(db).execute(({ transaction }) =>
        recoverMcpWriteCommit(transaction, planId));
    },
    async expireDuePlans() {
      return expireDuePlansAt(db);
    },
    async purgeRetained() {
      return purgeRetainedAt(db);
    },
  });
}

async function inspectMcpWriteOperations(
  executor: Kysely<DatabaseSchema> | DatabaseTransaction,
  input: Phase4bMcpWriteInspectionInput,
): Promise<Phase4bMcpWriteOperationsSnapshot> {
  assertInspectionInput(input);
  const row = await sql<InspectionRow>`
    WITH plan_facts AS (
      SELECT p.plan_id, p.status, p.risk, p.requires_approval, p.expires_at,
             p.created_at, p.updated_at, p.retained_until,
             count(r.claimed_at) FILTER (WHERE r.completed_at IS NULL)::int AS incomplete_receipts,
             count(r.claimed_at) FILTER (WHERE r.completed_at IS NOT NULL)::int AS completed_receipts,
             min(r.claimed_at) FILTER (WHERE r.completed_at IS NULL) AS oldest_incomplete_claimed_at
      FROM mcp_change_plans p
      LEFT JOIN mcp_commit_receipts r ON r.plan_id = p.plan_id
      GROUP BY p.plan_id
    )
    SELECT
      count(*)::int AS plans,
      count(*) FILTER (WHERE status = 'pending')::int AS pending,
      count(*) FILTER (WHERE status = 'approved')::int AS approved,
      count(*) FILTER (WHERE status = 'committing')::int AS committing,
      count(*) FILTER (WHERE status = 'consumed')::int AS consumed,
      count(*) FILTER (WHERE status = 'cancelled')::int AS cancelled,
      count(*) FILTER (WHERE status = 'expired')::int AS expired,
      count(*) FILTER (
        WHERE status = 'pending' AND requires_approval AND expires_at > current_timestamp
      )::int AS waiting_for_user,
      count(*) FILTER (
        WHERE status IN ('approved', 'committing')
          AND incomplete_receipts = 1
          AND completed_receipts = 0
          AND oldest_incomplete_claimed_at > current_timestamp
            - make_interval(secs => ${input.retryAfterMs / 1_000})
      )::int AS retrying,
      count(*) FILTER (
        WHERE status IN ('approved', 'committing')
          AND incomplete_receipts > 1
          AND completed_receipts = 0
      )::int AS concurrent_commit,
      count(*) FILTER (
        WHERE (status = 'committing' AND incomplete_receipts = 0)
          OR (
            status IN ('approved', 'committing')
            AND incomplete_receipts = 1
            AND completed_receipts = 0
            AND oldest_incomplete_claimed_at <= current_timestamp
              - make_interval(secs => ${input.retryAfterMs / 1_000})
            AND oldest_incomplete_claimed_at > current_timestamp
              - make_interval(secs => ${input.unknownAfterMs / 1_000})
          )
          OR (status IN ('approved', 'committing') AND completed_receipts > 0)
      )::int AS unknown_outcome,
      count(*) FILTER (
        WHERE status IN ('approved', 'committing')
          AND incomplete_receipts = 1
          AND completed_receipts = 0
          AND oldest_incomplete_claimed_at <= current_timestamp
            - make_interval(secs => ${input.permanentFailureAfterMs / 1_000})
      )::int AS permanently_failed,
      count(*) FILTER (WHERE risk = 'low')::int AS low_risk,
      count(*) FILTER (WHERE risk = 'medium')::int AS medium_risk,
      count(*) FILTER (WHERE risk = 'high')::int AS high_risk,
      (SELECT count(*)::int FROM mcp_approvals) AS approvals,
      (SELECT count(*)::int FROM mcp_approvals WHERE consumed_at IS NOT NULL) AS approvals_consumed,
      (SELECT count(*)::int FROM mcp_commit_receipts WHERE completed_at IS NULL)
        AS incomplete_receipts,
      (SELECT count(*)::int FROM mcp_commit_receipts WHERE completed_at IS NOT NULL)
        AS completed_receipts,
      count(*) FILTER (
        WHERE status IN ('pending', 'approved') AND expires_at <= current_timestamp
      )::int AS due_expiry,
      count(*) FILTER (
        WHERE status IN ('consumed', 'cancelled', 'expired')
          AND retained_until <= current_timestamp
      )::int AS retained_plans,
      (SELECT count(*)::int FROM mcp_approvals approval
        WHERE approval.retained_until <= current_timestamp
          AND (
            approval.consumed_at IS NOT NULL
            OR EXISTS (
              SELECT 1 FROM mcp_change_plans plan
              WHERE plan.plan_id = approval.plan_id
                AND plan.status IN ('consumed', 'cancelled', 'expired')
            )
          )) AS retained_approvals,
      (SELECT count(*)::int FROM mcp_commit_receipts receipt
        WHERE receipt.completed_at IS NOT NULL
          AND receipt.retained_until <= current_timestamp) AS retained_receipts,
      (extract(epoch FROM (
        current_timestamp - min(created_at) FILTER (
          WHERE status = 'pending' AND requires_approval AND expires_at > current_timestamp
        )
      )) * 1000)::double precision AS oldest_waiting_for_user_ms,
      (extract(epoch FROM (
        current_timestamp - min(updated_at) FILTER (WHERE status = 'approved')
      )) * 1000)::double precision AS oldest_approved_ms,
      (extract(epoch FROM (
        current_timestamp - min(updated_at) FILTER (WHERE status = 'committing')
      )) * 1000)::double precision AS oldest_committing_ms,
      (extract(epoch FROM (
        current_timestamp - min(updated_at) FILTER (
          WHERE status IN ('approved', 'committing')
            AND incomplete_receipts = 1
            AND completed_receipts = 0
            AND oldest_incomplete_claimed_at > current_timestamp
              - make_interval(secs => ${input.retryAfterMs / 1_000})
        )
      )) * 1000)::double precision AS oldest_retrying_ms,
      (extract(epoch FROM (
        current_timestamp - min(updated_at) FILTER (
          WHERE (status = 'committing' AND incomplete_receipts = 0)
            OR (
              status IN ('approved', 'committing')
              AND incomplete_receipts = 1
              AND completed_receipts = 0
              AND oldest_incomplete_claimed_at <= current_timestamp
                - make_interval(secs => ${input.retryAfterMs / 1_000})
              AND oldest_incomplete_claimed_at > current_timestamp
                - make_interval(secs => ${input.unknownAfterMs / 1_000})
            )
            OR (status IN ('approved', 'committing') AND completed_receipts > 0)
        )
      )) * 1000)::double precision AS oldest_unknown_outcome_ms,
      (extract(epoch FROM (
        current_timestamp - min(updated_at) FILTER (
          WHERE status IN ('approved', 'committing')
            AND incomplete_receipts = 1
            AND completed_receipts = 0
            AND oldest_incomplete_claimed_at <= current_timestamp
              - make_interval(secs => ${input.permanentFailureAfterMs / 1_000})
        )
      )) * 1000)::double precision AS oldest_permanent_failure_ms,
      current_timestamp::text AS scanned_at
    FROM plan_facts
  `.execute(executor);
  const value = row.rows[0];
  if (value === undefined) {
    throw new Error('MCP-W09 inspection returned no aggregate row.');
  }
  return mapInspectionRow(value);
}

async function cancelMcpWritePlan(
  transaction: DatabaseTransaction,
  planId: string,
): Promise<Phase4bMcpWriteActionResult> {
  assertPlanId(planId);
  const plan = await sql<{ readonly status: string }>`
    SELECT status FROM mcp_change_plans WHERE plan_id = ${planId} FOR UPDATE
  `.execute(transaction);
  if (plan.rows.length === 0) {
    return Object.freeze({ status: 'not_found', action: 'cancel' });
  }
  const status = plan.rows[0]!.status;
  const completed = await countCompletedReceipts(transaction, planId);
  if (completed > 0) {
    return Object.freeze({
      status: 'unknown_outcome',
      action: 'cancel',
      reason: 'completed_receipt_present',
    });
  }
  if (status === 'consumed') {
    return Object.freeze({
      status: 'unknown_outcome',
      action: 'cancel',
      reason: 'plan_consumed',
    });
  }
  if (status === 'cancelled') {
    return Object.freeze({
      status: 'noop',
      action: 'cancel',
      reason: 'already_cancelled',
    });
  }
  if (status === 'expired') {
    return Object.freeze({
      status: 'noop',
      action: 'cancel',
      reason: 'already_expired',
    });
  }

  if (status === 'committing') {
    await sql`
      DELETE FROM mcp_commit_receipts
      WHERE plan_id = ${planId} AND completed_at IS NULL
    `.execute(transaction);
    await sql`
      UPDATE mcp_change_plans
      SET status = 'approved', updated_at = current_timestamp
      WHERE plan_id = ${planId} AND status = 'committing'
    `.execute(transaction);
  } else {
    await sql`
      DELETE FROM mcp_commit_receipts
      WHERE plan_id = ${planId} AND completed_at IS NULL
    `.execute(transaction);
  }
  await sql`
    UPDATE mcp_change_plans
    SET status = 'cancelled', updated_at = current_timestamp
    WHERE plan_id = ${planId}
  `.execute(transaction);
  return Object.freeze({
    status: 'succeeded',
    action: 'cancel',
    planStatus: 'cancelled',
  });
}

async function recoverMcpWriteCommit(
  transaction: DatabaseTransaction,
  planId: string,
): Promise<Phase4bMcpWriteActionResult> {
  assertPlanId(planId);
  const plan = await sql<{ readonly status: string }>`
    SELECT status FROM mcp_change_plans WHERE plan_id = ${planId} FOR UPDATE
  `.execute(transaction);
  if (plan.rows.length === 0) {
    return Object.freeze({ status: 'not_found', action: 'recover' });
  }
  const status = plan.rows[0]!.status;
  const completed = await countCompletedReceipts(transaction, planId);
  if (completed > 0) {
    return Object.freeze({
      status: 'unknown_outcome',
      action: 'recover',
      reason: 'completed_receipt_present',
    });
  }
  if (status === 'consumed') {
    return Object.freeze({
      status: 'unknown_outcome',
      action: 'recover',
      reason: 'plan_consumed',
    });
  }
  if (status === 'cancelled' || status === 'expired') {
    return Object.freeze({
      status: 'noop',
      action: 'recover',
      reason: 'not_committing',
    });
  }
  const incomplete = await sql<{ readonly count: number }>`
    SELECT count(*)::int AS count
    FROM mcp_commit_receipts
    WHERE plan_id = ${planId} AND completed_at IS NULL
  `.execute(transaction);
  if (status !== 'committing' && incomplete.rows[0]?.count === 0) {
    return Object.freeze({
      status: 'noop',
      action: 'recover',
      reason: 'not_committing',
    });
  }
  await sql`
    DELETE FROM mcp_commit_receipts
    WHERE plan_id = ${planId} AND completed_at IS NULL
  `.execute(transaction);
  if (status === 'committing') {
    await sql`
      UPDATE mcp_change_plans
      SET status = 'approved', updated_at = current_timestamp
      WHERE plan_id = ${planId} AND status = 'committing'
    `.execute(transaction);
  }
  return Object.freeze({
    status: 'succeeded',
    action: 'recover',
    planStatus: 'approved',
  });
}

async function countCompletedReceipts(
  transaction: DatabaseTransaction,
  planId: string,
): Promise<number> {
  const result = await sql<{ readonly count: number }>`
    SELECT count(*)::int AS count
    FROM mcp_commit_receipts
    WHERE plan_id = ${planId} AND completed_at IS NOT NULL
  `.execute(transaction);
  return result.rows[0]?.count ?? 0;
}

function mapInspectionRow(row: InspectionRow): Phase4bMcpWriteOperationsSnapshot {
  return Object.freeze({
    counts: Object.freeze({
      plans: row.plans,
      pending: row.pending,
      approved: row.approved,
      committing: row.committing,
      consumed: row.consumed,
      cancelled: row.cancelled,
      expired: row.expired,
      waitingForUser: row.waiting_for_user,
      retrying: row.retrying,
      concurrentCommit: row.concurrent_commit,
      unknownOutcome: row.unknown_outcome,
      permanentlyFailed: row.permanently_failed,
      lowRisk: row.low_risk,
      mediumRisk: row.medium_risk,
      highRisk: row.high_risk,
      approvals: row.approvals,
      approvalsConsumed: row.approvals_consumed,
      incompleteReceipts: row.incomplete_receipts,
      completedReceipts: row.completed_receipts,
      dueExpiry: row.due_expiry,
      retainedPlans: row.retained_plans,
      retainedApprovals: row.retained_approvals,
      retainedReceipts: row.retained_receipts,
    }),
    ages: Object.freeze({
      oldestWaitingForUserMs: nullableNumber(row.oldest_waiting_for_user_ms),
      oldestApprovedMs: nullableNumber(row.oldest_approved_ms),
      oldestCommittingMs: nullableNumber(row.oldest_committing_ms),
      oldestRetryingMs: nullableNumber(row.oldest_retrying_ms),
      oldestUnknownOutcomeMs: nullableNumber(row.oldest_unknown_outcome_ms),
      oldestPermanentFailureMs: nullableNumber(row.oldest_permanent_failure_ms),
    }),
    retention: Object.freeze({
      dueExpiry: row.due_expiry,
      retainedPlans: row.retained_plans,
      retainedApprovals: row.retained_approvals,
      retainedReceipts: row.retained_receipts,
    }),
    dependency: 'available' as const,
    scannedAtMs: Date.parse(row.scanned_at),
  });
}

function nullableNumber(value: number | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(Math.max(0, parsed)) : null;
}

function assertInspectionInput(input: Phase4bMcpWriteInspectionInput): void {
  if (
    typeof input !== 'object'
    || input === null
    || !Number.isSafeInteger(input.retryAfterMs)
    || input.retryAfterMs < 1
    || !Number.isSafeInteger(input.unknownAfterMs)
    || input.unknownAfterMs <= input.retryAfterMs
    || !Number.isSafeInteger(input.permanentFailureAfterMs)
    || input.permanentFailureAfterMs <= input.unknownAfterMs
  ) {
    throw new TypeError('MCP-W09 inspection thresholds must be ordered positive safe integers.');
  }
}

function assertPlanId(planId: string): void {
  if (typeof planId !== 'string' || planId.length === 0 || planId.length > 256) {
    throw new TypeError('MCP-W09 action plan id must be a non-empty string.');
  }
}
