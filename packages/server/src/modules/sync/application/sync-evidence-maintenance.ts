/**
 * R15 global evidence/proof maintenance port.
 *
 * The maintenance worker is a standalone schedule independent of Pull that sweeps
 * expired/consumed/retired recovery proofs and expired pull-cursor evidence across
 * all replicas. Row-level concurrency comes from a candidate CTE using
 * FOR UPDATE SKIP LOCKED; there is deliberately no per-collection lease, so
 * candidate rows are the only unit of claim.
 *
 * Metric contract (counters/gauges wired in bootstrap/worker.ts):
 * - attempted : candidate rows considered this run (proofs + evidence), capped by batchSize
 * - deleted   : recovery proofs deleted + cursor evidence rows deleted
 * - redacted  : cursor evidence rows whose checkpoint-referenced cursor was redacted to NULL
 * - skipped   : expired evidence protected only by an Ack receipt (candidate but not acted on)
 * - errors    : run-level failures (a throw is reported through the job's onError)
 * - gauge oldest_expired_age : age (ms) of the oldest expired candidate, computed with DB time
 */
export const SYNC_EVIDENCE_MAINTENANCE_METRICS = Object.freeze({
  runs: 'sync.evidence_maintenance.runs',
  attempted: 'sync.evidence_maintenance.attempted',
  deleted: 'sync.evidence_maintenance.deleted',
  redacted: 'sync.evidence_maintenance.redacted',
  skipped: 'sync.evidence_maintenance.skipped',
  errors: 'sync.evidence_maintenance.errors',
  oldestExpiredAge: 'sync.evidence_maintenance.oldest_expired_age',
} as const);

export type SyncEvidenceMaintenanceMetricName
  = typeof SYNC_EVIDENCE_MAINTENANCE_METRICS[keyof typeof SYNC_EVIDENCE_MAINTENANCE_METRICS];

export interface SyncEvidenceMaintenanceResult {
  /** Candidate rows considered this run (proofs + evidence), capped by batchSize. */
  readonly attempted: number;
  /** Recovery proofs deleted + cursor evidence rows deleted. */
  readonly deleted: number;
  /** Cursor evidence rows whose checkpoint-referenced cursor was redacted to NULL. */
  readonly redacted: number;
  /** Expired evidence protected only by an Ack receipt (candidate but not acted on). */
  readonly skipped: number;
  /** Run-level failures; success reports 0 and a throw surfaces through onError. */
  readonly errors: number;
  /** Age in milliseconds of the oldest expired candidate (DB time; 0 when none). */
  readonly oldestExpiredAgeMs: number;
}

/** Coordinator-facing interface implemented by the PostgreSQL adapter. */
export interface SyncEvidenceMaintenanceCoordinator {
  runBatch(input?: { readonly now?: Date }): Promise<SyncEvidenceMaintenanceResult>;
}

export type SyncEvidenceMaintenanceFaultPhase = 'candidates_selected' | 'proofs_deleted'
  | 'evidence_deleted' | 'evidence_redacted' | 'before_commit';

export interface SyncEvidenceMaintenanceFaultInjector {
  afterPhase?(phase: SyncEvidenceMaintenanceFaultPhase): Promise<void>;
}

export interface SyncEvidenceMaintenanceCoordinatorOptions {
  /** Process identity used as a debug context while a maintenance transaction runs. */
  readonly workerId: string;
  /** Maximum candidate rows (proofs + evidence) processed in one run. */
  readonly batchSize: number;
  /** Bounds how long a single maintenance transaction may hold row locks. */
  readonly leaseDurationMs: number;
  readonly faultInjector?: SyncEvidenceMaintenanceFaultInjector;
}

/** Structural metrics sink matching infrastructure/telemetry Metrics. */
export interface SyncEvidenceMaintenanceMetricsSink {
  increment(name: string, value?: number): void;
  gauge(name: string, value: number): void;
}

/**
 * Publish a completed run to the sync.evidence_maintenance.* counters/gauges.
 * Shared by bootstrap/worker.ts and by tests so the metric contract is exercised
 * exactly once and asserted directly.
 */
export function applySyncEvidenceMaintenanceMetrics(
  metrics: SyncEvidenceMaintenanceMetricsSink,
  result: SyncEvidenceMaintenanceResult,
): void {
  metrics.increment(SYNC_EVIDENCE_MAINTENANCE_METRICS.runs);
  metrics.increment(SYNC_EVIDENCE_MAINTENANCE_METRICS.attempted, result.attempted);
  metrics.increment(SYNC_EVIDENCE_MAINTENANCE_METRICS.deleted, result.deleted);
  metrics.increment(SYNC_EVIDENCE_MAINTENANCE_METRICS.redacted, result.redacted);
  metrics.increment(SYNC_EVIDENCE_MAINTENANCE_METRICS.skipped, result.skipped);
  metrics.increment(SYNC_EVIDENCE_MAINTENANCE_METRICS.errors, result.errors);
  metrics.gauge(SYNC_EVIDENCE_MAINTENANCE_METRICS.oldestExpiredAge, result.oldestExpiredAgeMs);
}
