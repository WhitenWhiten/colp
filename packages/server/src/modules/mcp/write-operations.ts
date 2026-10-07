/**
 * MCP-W09 bounded Write Plan/Approval/Commit operations surface.
 *
 * This module owns inspection, stable feature readiness, safe cancel/recovery
 * outcomes, and flat `mcp.write.*` metrics. It never persists or exposes Plan
 * IDs, principals, clients, credentials, origins, requestState values, raw
 * errors, or untrusted content. The durable store uses PostgreSQL time for
 * expiry/retention classification so operators can distinguish waiting-for-
 * user, expired, retrying, concurrent commit, unknown outcome, and permanent
 * failure states without changing MCP Read or the rest of the API.
 */
import { types as nodeTypes } from 'node:util';

export const PHASE4B_MCP_WRITE_OPERATIONS_METRIC_PREFIX = 'mcp.write' as const;

export type Phase4bMcpWriteReadinessStatus = 'ready' | 'degraded' | 'not_ready';
export type Phase4bMcpWriteCommitResult =
  | 'committed'
  | 'replayed'
  | 'cancelled'
  | 'expired'
  | 'rejected';
export type Phase4bMcpWriteErrorCategory =
  | 'binding'
  | 'digest'
  | 'revision'
  | 'scope'
  | 'rate'
  | 'impact'
  | 'expiry'
  | 'concurrent'
  | 'unknown';

export interface Phase4bMcpWriteMetrics {
  readonly increment: (name: string, value?: number) => void;
  readonly gauge: (name: string, value: number) => void;
  readonly observe: (name: string, value: number) => void;
}

export interface Phase4bMcpWriteOperationsCounts {
  readonly plans: number;
  readonly pending: number;
  readonly approved: number;
  readonly committing: number;
  readonly consumed: number;
  readonly cancelled: number;
  readonly expired: number;
  readonly waitingForUser: number;
  readonly retrying: number;
  readonly concurrentCommit: number;
  readonly unknownOutcome: number;
  readonly permanentlyFailed: number;
  readonly lowRisk: number;
  readonly mediumRisk: number;
  readonly highRisk: number;
  readonly approvals: number;
  readonly approvalsConsumed: number;
  readonly incompleteReceipts: number;
  readonly completedReceipts: number;
  readonly dueExpiry: number;
  readonly retainedPlans: number;
  readonly retainedApprovals: number;
  readonly retainedReceipts: number;
}

export interface Phase4bMcpWriteOperationsAges {
  readonly oldestWaitingForUserMs: number | null;
  readonly oldestApprovedMs: number | null;
  readonly oldestCommittingMs: number | null;
  readonly oldestRetryingMs: number | null;
  readonly oldestUnknownOutcomeMs: number | null;
  readonly oldestPermanentFailureMs: number | null;
}

export interface Phase4bMcpWriteOperationsRetention {
  readonly dueExpiry: number;
  readonly retainedPlans: number;
  readonly retainedApprovals: number;
  readonly retainedReceipts: number;
}

export interface Phase4bMcpWriteOperationsSnapshot {
  readonly counts: Phase4bMcpWriteOperationsCounts;
  readonly ages: Phase4bMcpWriteOperationsAges;
  readonly retention: Phase4bMcpWriteOperationsRetention;
  readonly dependency: 'available' | 'unavailable';
  readonly scannedAtMs: number;
}

export type Phase4bMcpWriteActionResult =
  | {
      readonly status: 'succeeded';
      readonly action: 'cancel' | 'recover';
      readonly planStatus: 'cancelled' | 'approved';
    }
  | {
      readonly status: 'unknown_outcome';
      readonly action: 'cancel' | 'recover';
      readonly reason: 'completed_receipt_present' | 'plan_consumed';
    }
  | {
      readonly status: 'noop';
      readonly action: 'cancel' | 'recover';
      readonly reason: 'already_cancelled' | 'already_expired' | 'not_committing';
    }
  | {
      readonly status: 'not_found';
      readonly action: 'cancel' | 'recover';
    };

export interface Phase4bMcpWriteInspectionInput {
  readonly retryAfterMs: number;
  readonly unknownAfterMs: number;
  readonly permanentFailureAfterMs: number;
}

export interface Phase4bMcpWriteRetentionPurgeResult {
  readonly receipts: number;
  readonly approvals: number;
  readonly plans: number;
}

export interface Phase4bMcpWriteOperationsStorePort {
  readonly inspect: (
    input: Phase4bMcpWriteInspectionInput,
  ) => Phase4bMcpWriteOperationsSnapshot | PromiseLike<Phase4bMcpWriteOperationsSnapshot>;
  readonly cancel: (
    planId: string,
  ) => Phase4bMcpWriteActionResult | PromiseLike<Phase4bMcpWriteActionResult>;
  readonly recover: (
    planId: string,
  ) => Phase4bMcpWriteActionResult | PromiseLike<Phase4bMcpWriteActionResult>;
  readonly expireDuePlans: () => number | PromiseLike<number>;
  readonly purgeRetained: () =>
    Phase4bMcpWriteRetentionPurgeResult | PromiseLike<Phase4bMcpWriteRetentionPurgeResult>;
}

export interface Phase4bMcpWriteReadinessLimits {
  readonly waitingForUserDegraded: number;
  readonly expiredDegraded: number;
  readonly retryBacklogDegraded: number;
  readonly concurrentCommitDegraded: number;
  readonly unknownOutcomeNotReady: number;
  readonly permanentFailureNotReady: number;
  readonly maxBacklogNotReady: number;
  readonly retryAfterMs: number;
  readonly unknownAfterMs: number;
  readonly permanentFailureAfterMs: number;
}

export interface Phase4bMcpWriteReadiness {
  readonly capability: 'mcp-write';
  readonly protocolVersion: '2026-07-28';
  readonly status: Phase4bMcpWriteReadinessStatus;
  readonly reasons: readonly string[];
  readonly counts: Phase4bMcpWriteOperationsCounts;
  readonly ages: Phase4bMcpWriteOperationsAges;
  readonly retention: Phase4bMcpWriteOperationsRetention;
  readonly limits: Phase4bMcpWriteReadinessLimits;
  readonly enabled: boolean;
}

export interface Phase4bMcpWriteOperationsOptions {
  readonly metrics: Phase4bMcpWriteMetrics;
  readonly store: Phase4bMcpWriteOperationsStorePort;
  readonly enabled?: boolean;
  readonly waitingForUserDegraded?: number;
  readonly expiredDegraded?: number;
  readonly retryBacklogDegraded?: number;
  readonly concurrentCommitDegraded?: number;
  readonly unknownOutcomeNotReady?: number;
  readonly permanentFailureNotReady?: number;
  readonly maxBacklogNotReady?: number;
  readonly retryAfterMs?: number;
  readonly unknownAfterMs?: number;
  readonly permanentFailureAfterMs?: number;
}

export interface Phase4bMcpWriteOperations {
  readonly inspect: () => Promise<Phase4bMcpWriteOperationsSnapshot>;
  readonly readiness: () => Promise<Phase4bMcpWriteReadiness>;
  readonly cancel: (planId: string) => Promise<Phase4bMcpWriteActionResult>;
  readonly recover: (planId: string) => Promise<Phase4bMcpWriteActionResult>;
  readonly expireDuePlans: () => Promise<number>;
  readonly purgeRetained: () => Promise<Phase4bMcpWriteRetentionPurgeResult>;
  readonly disable: () => void;
  readonly enable: () => void;
  readonly recordCommitResult: (result: Phase4bMcpWriteCommitResult) => void;
  readonly recordCommitError: (category: Phase4bMcpWriteErrorCategory) => void;
}

const DEFAULT_WAITING_FOR_USER_DEGRADED = 1_000;
const DEFAULT_EXPIRED_DEGRADED = 1_000;
const DEFAULT_RETRY_BACKLOG_DEGRADED = 1_000;
const DEFAULT_CONCURRENT_COMMIT_DEGRADED = 1_000;
const DEFAULT_UNKNOWN_OUTCOME_NOT_READY = 1;
const DEFAULT_PERMANENT_FAILURE_NOT_READY = 1;
const DEFAULT_MAX_BACKLOG_NOT_READY = 10_000;
const DEFAULT_RETRY_AFTER_MS = 60_000;
const DEFAULT_UNKNOWN_AFTER_MS = 300_000;
const DEFAULT_PERMANENT_FAILURE_AFTER_MS = 24 * 60 * 60 * 1_000;

const COMMIT_RESULTS: ReadonlySet<string> = new Set([
  'committed',
  'replayed',
  'cancelled',
  'expired',
  'rejected',
]);

const ERROR_CATEGORIES: ReadonlySet<string> = new Set([
  'binding',
  'digest',
  'revision',
  'scope',
  'rate',
  'impact',
  'expiry',
  'concurrent',
  'unknown',
]);

export function createPhase4bMcpWriteOperations(
  options: Phase4bMcpWriteOperationsOptions,
): Phase4bMcpWriteOperations {
  readOptions(options);
  const metrics = options.metrics;
  const store = options.store;
  let enabled = options.enabled !== false;

  const resolved = resolveOptions(options);

  const publishSnapshot = (snapshot: Phase4bMcpWriteOperationsSnapshot): void => {
    metrics.gauge(`${PHASE4B_MCP_WRITE_OPERATIONS_METRIC_PREFIX}.enabled`, enabled ? 1 : 0);
    metrics.gauge(`${PHASE4B_MCP_WRITE_OPERATIONS_METRIC_PREFIX}.plans`, snapshot.counts.plans);
    metrics.gauge(`${PHASE4B_MCP_WRITE_OPERATIONS_METRIC_PREFIX}.plans.pending`, snapshot.counts.pending);
    metrics.gauge(`${PHASE4B_MCP_WRITE_OPERATIONS_METRIC_PREFIX}.plans.approved`, snapshot.counts.approved);
    metrics.gauge(
      `${PHASE4B_MCP_WRITE_OPERATIONS_METRIC_PREFIX}.plans.committing`,
      snapshot.counts.committing,
    );
    metrics.gauge(
      `${PHASE4B_MCP_WRITE_OPERATIONS_METRIC_PREFIX}.plans.consumed`,
      snapshot.counts.consumed,
    );
    metrics.gauge(
      `${PHASE4B_MCP_WRITE_OPERATIONS_METRIC_PREFIX}.plans.cancelled`,
      snapshot.counts.cancelled,
    );
    metrics.gauge(
      `${PHASE4B_MCP_WRITE_OPERATIONS_METRIC_PREFIX}.plans.expired`,
      snapshot.counts.expired,
    );
    metrics.gauge(
      `${PHASE4B_MCP_WRITE_OPERATIONS_METRIC_PREFIX}.backlog.waiting_for_user`,
      snapshot.counts.waitingForUser,
    );
    metrics.gauge(
      `${PHASE4B_MCP_WRITE_OPERATIONS_METRIC_PREFIX}.backlog.expired`,
      snapshot.counts.expired,
    );
    metrics.gauge(
      `${PHASE4B_MCP_WRITE_OPERATIONS_METRIC_PREFIX}.backlog.retry`,
      snapshot.counts.retrying,
    );
    metrics.gauge(
      `${PHASE4B_MCP_WRITE_OPERATIONS_METRIC_PREFIX}.backlog.concurrent_commit`,
      snapshot.counts.concurrentCommit,
    );
    metrics.gauge(
      `${PHASE4B_MCP_WRITE_OPERATIONS_METRIC_PREFIX}.backlog.unknown_outcome`,
      snapshot.counts.unknownOutcome,
    );
    metrics.gauge(
      `${PHASE4B_MCP_WRITE_OPERATIONS_METRIC_PREFIX}.backlog.permanent_failure`,
      snapshot.counts.permanentlyFailed,
    );
    metrics.gauge(`${PHASE4B_MCP_WRITE_OPERATIONS_METRIC_PREFIX}.risk.low`, snapshot.counts.lowRisk);
    metrics.gauge(
      `${PHASE4B_MCP_WRITE_OPERATIONS_METRIC_PREFIX}.risk.medium`,
      snapshot.counts.mediumRisk,
    );
    metrics.gauge(`${PHASE4B_MCP_WRITE_OPERATIONS_METRIC_PREFIX}.risk.high`, snapshot.counts.highRisk);
    metrics.gauge(
      `${PHASE4B_MCP_WRITE_OPERATIONS_METRIC_PREFIX}.approvals.pending`,
      Math.max(0, snapshot.counts.approvals - snapshot.counts.approvalsConsumed),
    );
    metrics.gauge(
      `${PHASE4B_MCP_WRITE_OPERATIONS_METRIC_PREFIX}.approvals.consumed`,
      snapshot.counts.approvalsConsumed,
    );
    metrics.gauge(
      `${PHASE4B_MCP_WRITE_OPERATIONS_METRIC_PREFIX}.receipts.incomplete`,
      snapshot.counts.incompleteReceipts,
    );
    metrics.gauge(
      `${PHASE4B_MCP_WRITE_OPERATIONS_METRIC_PREFIX}.receipts.completed`,
      snapshot.counts.completedReceipts,
    );
    metrics.gauge(
      `${PHASE4B_MCP_WRITE_OPERATIONS_METRIC_PREFIX}.retention.due_expiry`,
      snapshot.retention.dueExpiry,
    );
    metrics.gauge(
      `${PHASE4B_MCP_WRITE_OPERATIONS_METRIC_PREFIX}.retention.retained_plans`,
      snapshot.retention.retainedPlans,
    );
    metrics.gauge(
      `${PHASE4B_MCP_WRITE_OPERATIONS_METRIC_PREFIX}.retention.retained_approvals`,
      snapshot.retention.retainedApprovals,
    );
    metrics.gauge(
      `${PHASE4B_MCP_WRITE_OPERATIONS_METRIC_PREFIX}.retention.retained_receipts`,
      snapshot.retention.retainedReceipts,
    );
  };

  const recordAction = (
    action: 'cancel' | 'recover',
    outcome: Phase4bMcpWriteActionResult,
  ): Phase4bMcpWriteActionResult => {
    metrics.increment(`${PHASE4B_MCP_WRITE_OPERATIONS_METRIC_PREFIX}.action.${action}.${outcome.status}`);
    if (outcome.status === 'unknown_outcome') {
      metrics.increment(`${PHASE4B_MCP_WRITE_OPERATIONS_METRIC_PREFIX}.action.unknown_outcome`);
    }
    return outcome;
  };

  return Object.freeze({
    async inspect() {
      metrics.increment(`${PHASE4B_MCP_WRITE_OPERATIONS_METRIC_PREFIX}.inspect.total`);
      try {
        const snapshot = await store.inspect(resolved);
        publishSnapshot(snapshot);
        metrics.increment(`${PHASE4B_MCP_WRITE_OPERATIONS_METRIC_PREFIX}.inspect.success`);
        return snapshot;
      } catch (error) {
        metrics.increment(`${PHASE4B_MCP_WRITE_OPERATIONS_METRIC_PREFIX}.inspect.error`);
        metrics.increment(`${PHASE4B_MCP_WRITE_OPERATIONS_METRIC_PREFIX}.dependency.unavailable`);
        throw error;
      }
    },

    async readiness() {
      let snapshot: Phase4bMcpWriteOperationsSnapshot;
      try {
        snapshot = await store.inspect(resolved);
        publishSnapshot(snapshot);
        metrics.increment(`${PHASE4B_MCP_WRITE_OPERATIONS_METRIC_PREFIX}.inspect.total`);
        metrics.increment(`${PHASE4B_MCP_WRITE_OPERATIONS_METRIC_PREFIX}.inspect.success`);
      } catch {
        metrics.increment(`${PHASE4B_MCP_WRITE_OPERATIONS_METRIC_PREFIX}.inspect.error`);
        metrics.increment(`${PHASE4B_MCP_WRITE_OPERATIONS_METRIC_PREFIX}.dependency.unavailable`);
        return unavailableReadiness(resolved, enabled);
      }
      return evaluateReadiness(snapshot, resolved, enabled);
    },

    async cancel(planId: string) {
      assertActionPlanId(planId);
      try {
        return recordAction('cancel', await store.cancel(planId));
      } catch (error) {
        metrics.increment(`${PHASE4B_MCP_WRITE_OPERATIONS_METRIC_PREFIX}.action.error.internal`);
        throw error;
      }
    },

    async recover(planId: string) {
      assertActionPlanId(planId);
      try {
        return recordAction('recover', await store.recover(planId));
      } catch (error) {
        metrics.increment(`${PHASE4B_MCP_WRITE_OPERATIONS_METRIC_PREFIX}.action.error.internal`);
        throw error;
      }
    },

    async expireDuePlans() {
      try {
        const count = await store.expireDuePlans();
        metrics.increment(`${PHASE4B_MCP_WRITE_OPERATIONS_METRIC_PREFIX}.expiry.applied`, count);
        return count;
      } catch (error) {
        metrics.increment(`${PHASE4B_MCP_WRITE_OPERATIONS_METRIC_PREFIX}.action.error.internal`);
        throw error;
      }
    },

    async purgeRetained() {
      try {
        const result = await store.purgeRetained();
        metrics.increment(
          `${PHASE4B_MCP_WRITE_OPERATIONS_METRIC_PREFIX}.retention.purged_receipts`,
          result.receipts,
        );
        metrics.increment(
          `${PHASE4B_MCP_WRITE_OPERATIONS_METRIC_PREFIX}.retention.purged_approvals`,
          result.approvals,
        );
        metrics.increment(
          `${PHASE4B_MCP_WRITE_OPERATIONS_METRIC_PREFIX}.retention.purged_plans`,
          result.plans,
        );
        return result;
      } catch (error) {
        metrics.increment(`${PHASE4B_MCP_WRITE_OPERATIONS_METRIC_PREFIX}.action.error.internal`);
        throw error;
      }
    },

    disable() {
      enabled = false;
      metrics.gauge(`${PHASE4B_MCP_WRITE_OPERATIONS_METRIC_PREFIX}.enabled`, 0);
    },

    enable() {
      enabled = true;
      metrics.gauge(`${PHASE4B_MCP_WRITE_OPERATIONS_METRIC_PREFIX}.enabled`, 1);
    },

    recordCommitResult(result: Phase4bMcpWriteCommitResult) {
      if (!COMMIT_RESULTS.has(result)) {
        throw new TypeError(`Unknown MCP Write commit result: ${String(result)}`);
      }
      metrics.increment(
        `${PHASE4B_MCP_WRITE_OPERATIONS_METRIC_PREFIX}.commit.result.${result}`,
      );
    },

    recordCommitError(category: Phase4bMcpWriteErrorCategory) {
      if (!ERROR_CATEGORIES.has(category)) {
        throw new TypeError(`Unknown MCP Write commit error category: ${String(category)}`);
      }
      metrics.increment(
        `${PHASE4B_MCP_WRITE_OPERATIONS_METRIC_PREFIX}.commit.error.${category}`,
      );
    },
  });
}

function evaluateReadiness(
  snapshot: Phase4bMcpWriteOperationsSnapshot,
  limits: Phase4bMcpWriteReadinessLimits,
  enabled: boolean,
): Phase4bMcpWriteReadiness {
  const reasons: string[] = [];
  let status: Phase4bMcpWriteReadinessStatus = 'ready';

  if (!enabled) {
    status = 'not_ready';
    reasons.push('mcp_write_disabled');
  }
  if (snapshot.counts.waitingForUser > 0) {
    reasons.push('mcp_write_waiting_for_user');
    if (snapshot.counts.waitingForUser >= limits.waitingForUserDegraded && status === 'ready') {
      status = 'degraded';
    }
  }
  if (snapshot.counts.expired > 0) {
    reasons.push('mcp_write_expired');
    if (snapshot.counts.expired >= limits.expiredDegraded && status === 'ready') {
      status = 'degraded';
    }
  }
  if (snapshot.counts.retrying > 0) {
    reasons.push('mcp_write_retry_backlog');
    if (snapshot.counts.retrying >= limits.retryBacklogDegraded && status === 'ready') {
      status = 'degraded';
    }
  }
  if (snapshot.counts.concurrentCommit > 0) {
    reasons.push('mcp_write_concurrent_commit');
    if (snapshot.counts.concurrentCommit >= limits.concurrentCommitDegraded && status === 'ready') {
      status = 'degraded';
    }
  }
  if (snapshot.counts.unknownOutcome > 0) {
    reasons.push('mcp_write_unknown_outcome');
    if (snapshot.counts.unknownOutcome >= limits.unknownOutcomeNotReady) {
      status = 'not_ready';
    }
  }
  if (snapshot.counts.permanentlyFailed > 0) {
    reasons.push('mcp_write_permanent_failure');
    if (snapshot.counts.permanentlyFailed >= limits.permanentFailureNotReady) {
      status = 'not_ready';
    }
  }
  if (snapshot.counts.plans >= limits.maxBacklogNotReady) {
    status = 'not_ready';
    reasons.push('mcp_write_capacity_exhausted');
  }

  return Object.freeze({
    capability: 'mcp-write' as const,
    protocolVersion: '2026-07-28' as const,
    status,
    reasons: Object.freeze(reasons),
    counts: snapshot.counts,
    ages: snapshot.ages,
    retention: snapshot.retention,
    limits,
    enabled,
  });
}

function unavailableReadiness(
  limits: Phase4bMcpWriteReadinessLimits,
  enabled: boolean,
): Phase4bMcpWriteReadiness {
  const emptySnapshot = emptyCountsSnapshot();
  return Object.freeze({
    capability: 'mcp-write' as const,
    protocolVersion: '2026-07-28' as const,
    status: 'not_ready' as const,
    reasons: Object.freeze(['mcp_write_dependency_unavailable']),
    counts: emptySnapshot.counts,
    ages: emptySnapshot.ages,
    retention: emptySnapshot.retention,
    limits,
    enabled,
  });
}

function emptyCountsSnapshot(): Phase4bMcpWriteOperationsSnapshot {
  return Object.freeze({
    counts: Object.freeze({
      plans: 0,
      pending: 0,
      approved: 0,
      committing: 0,
      consumed: 0,
      cancelled: 0,
      expired: 0,
      waitingForUser: 0,
      retrying: 0,
      concurrentCommit: 0,
      unknownOutcome: 0,
      permanentlyFailed: 0,
      lowRisk: 0,
      mediumRisk: 0,
      highRisk: 0,
      approvals: 0,
      approvalsConsumed: 0,
      incompleteReceipts: 0,
      completedReceipts: 0,
      dueExpiry: 0,
      retainedPlans: 0,
      retainedApprovals: 0,
      retainedReceipts: 0,
    }),
    ages: Object.freeze({
      oldestWaitingForUserMs: null,
      oldestApprovedMs: null,
      oldestCommittingMs: null,
      oldestRetryingMs: null,
      oldestUnknownOutcomeMs: null,
      oldestPermanentFailureMs: null,
    }),
    retention: Object.freeze({
      dueExpiry: 0,
      retainedPlans: 0,
      retainedApprovals: 0,
      retainedReceipts: 0,
    }),
    dependency: 'unavailable' as const,
    scannedAtMs: 0,
  });
}

function resolveOptions(options: Phase4bMcpWriteOperationsOptions): Phase4bMcpWriteReadinessLimits {
  const limits = {
    waitingForUserDegraded: options.waitingForUserDegraded ?? DEFAULT_WAITING_FOR_USER_DEGRADED,
    expiredDegraded: options.expiredDegraded ?? DEFAULT_EXPIRED_DEGRADED,
    retryBacklogDegraded: options.retryBacklogDegraded ?? DEFAULT_RETRY_BACKLOG_DEGRADED,
    concurrentCommitDegraded: options.concurrentCommitDegraded ?? DEFAULT_CONCURRENT_COMMIT_DEGRADED,
    unknownOutcomeNotReady: options.unknownOutcomeNotReady ?? DEFAULT_UNKNOWN_OUTCOME_NOT_READY,
    permanentFailureNotReady: options.permanentFailureNotReady ?? DEFAULT_PERMANENT_FAILURE_NOT_READY,
    maxBacklogNotReady: options.maxBacklogNotReady ?? DEFAULT_MAX_BACKLOG_NOT_READY,
    retryAfterMs: options.retryAfterMs ?? DEFAULT_RETRY_AFTER_MS,
    unknownAfterMs: options.unknownAfterMs ?? DEFAULT_UNKNOWN_AFTER_MS,
    permanentFailureAfterMs: options.permanentFailureAfterMs ?? DEFAULT_PERMANENT_FAILURE_AFTER_MS,
  };
  assertNonNegative(limits.waitingForUserDegraded, 'waitingForUserDegraded');
  assertNonNegative(limits.expiredDegraded, 'expiredDegraded');
  assertNonNegative(limits.retryBacklogDegraded, 'retryBacklogDegraded');
  assertNonNegative(limits.concurrentCommitDegraded, 'concurrentCommitDegraded');
  assertPositive(limits.unknownOutcomeNotReady, 'unknownOutcomeNotReady');
  assertPositive(limits.permanentFailureNotReady, 'permanentFailureNotReady');
  assertPositive(limits.maxBacklogNotReady, 'maxBacklogNotReady');
  assertPositive(limits.retryAfterMs, 'retryAfterMs');
  assertPositive(limits.unknownAfterMs, 'unknownAfterMs');
  assertPositive(limits.permanentFailureAfterMs, 'permanentFailureAfterMs');
  if (limits.retryAfterMs >= limits.unknownAfterMs) {
    throw new TypeError('MCP Write retryAfterMs must be less than unknownAfterMs.');
  }
  if (limits.unknownAfterMs >= limits.permanentFailureAfterMs) {
    throw new TypeError('MCP Write unknownAfterMs must be less than permanentFailureAfterMs.');
  }
  return Object.freeze(limits);
}

function readOptions(options: Phase4bMcpWriteOperationsOptions): void {
  if (typeof options !== 'object' || options === null || nodeTypes.isProxy(options)) {
    throw new TypeError('MCP-W09 operations options must be an own-data object.');
  }
  const metrics = options.metrics;
  if (
    typeof metrics !== 'object'
    || metrics === null
    || nodeTypes.isProxy(metrics)
    || typeof metrics.increment !== 'function'
    || typeof metrics.gauge !== 'function'
    || typeof metrics.observe !== 'function'
  ) {
    throw new TypeError('MCP-W09 operations require a Metrics seam.');
  }
  const store = options.store;
  if (
    typeof store !== 'object'
    || store === null
    || nodeTypes.isProxy(store)
    || typeof store.inspect !== 'function'
    || typeof store.cancel !== 'function'
    || typeof store.recover !== 'function'
    || typeof store.expireDuePlans !== 'function'
    || typeof store.purgeRetained !== 'function'
  ) {
    throw new TypeError('MCP-W09 operations require a durable operations store port.');
  }
}

function assertNonNegative(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`MCP-W09 ${name} must be a non-negative safe integer.`);
  }
}

function assertPositive(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`MCP-W09 ${name} must be a positive safe integer.`);
  }
}

function assertActionPlanId(planId: string): void {
  if (typeof planId !== 'string' || planId.length === 0 || planId.length > 256) {
    throw new TypeError('MCP-W09 action plan id must be a non-empty string.');
  }
}
