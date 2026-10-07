/**
 * P4A-P05 production attachments worker composition.
 *
 * Owns everything the Worker process needs for Product traffic beyond the
 * generic outbox loop:
 *
 *  1. the production `attachments.upload-verified` outbox ROUTE: the worker
 *     claims the row produced by the Product complete use case, runs the I09
 *     verification coordinator (RO credential reads only), and permanently
 *     completes the row only after the durable `verifying -> stored_private`
 *     / quarantine CAS committed (sideEffectDurability: 'durable');
 *  2. the bounded CLEANUP SCHEDULER: a separate RW path running the I14
 *     cleanup batch coordinator on a bounded timer with keyset-cursor
 *     continuation (retired/orphan/deletion-pending retention cleanup AND the
 *     late-upload `allocated -> orphaned` reconciliation driven by the
 *     database clock);
 *  3. the BACKLOG TELEMETRY: a bounded sample ring (I15 fixed-label store)
 *     fed from live PostgreSQL facts (verification backlog, cleanup backlog,
 *     quarantine count, dead-letter count), bridged onto the infrastructure
 *     `Metrics` gauges, evaluated against the I15 sustained-window alert
 *     conditions, and exposed as `AttachmentsReadinessFacts` for partial
 *     readiness.
 *
 * Failure isolation (plan §6 P4A-P05): every attachments failure surfaces on
 * its own outbox row (retryable -> dead-letter) or its own cleanup run; the
 * generic worker loop and every unrelated route keep running. Shutdown stops
 * the sampler, waits for the in-flight cleanup batch, and lets the outbox
 * stop drain handlers; provider clients are owned by the caller (the worker
 * CLI closes the composed object store after `stop()`).
 */
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { createPostgresAttachmentsPorts, createUnitOfWork, type DatabaseRuntime, type DatabaseTransaction, type UnitOfWork } from '../infrastructure/database/index.js';
import { createGenerationObjectStoreAdapter, type BlobStorePort } from '../infrastructure/object-storage/index.js';
import type { Metrics } from '../infrastructure/telemetry/index.js';
import {
  attachmentsVerificationEnvelopeRegistration,
  createAttachmentsVerificationOutboxRoute,
} from '../infrastructure/outbox/index.js';
import type {
  EventPayloadRegistration,
  OutboxRoute,
} from '../infrastructure/outbox/index.js';
import {
  ATTACHMENT_ALERT_NAMES,
  DEFAULT_ATTACHMENT_ALERT_CONFIG,
  createAttachmentMetricsStore,
  evaluateAttachmentAlerts,
  runCleanupBatch,
  type AttachmentAlertConfig,
  type AttachmentAlertName,
  type AttachmentAlertVerdict,
  type AttachmentBacklogSample,
  type AttachmentMetricsSnapshot,
  type AttachmentMetricsStore,
  type AttachmentsFeatureConfig,
  type AttachmentsLedgerPort,
  type AttachmentsReadinessFacts,
  type CleanupBatchResult,
  type CleanupKeysetCursor,
  type GenerationObjectStorePort,
} from '../modules/attachments/index.js';

// ---------------------------------------------------------------------------
// Bounded timing constants
// ---------------------------------------------------------------------------

export const ATTACHMENTS_CLEANUP_INTERVAL_DEFAULT_MS = 60_000;
export const ATTACHMENTS_CLEANUP_INTERVAL_MIN_MS = 100;
export const ATTACHMENTS_CLEANUP_INTERVAL_MAX_MS = 3_600_000;
export const ATTACHMENTS_TELEMETRY_SAMPLE_INTERVAL_DEFAULT_MS = 30_000;
export const ATTACHMENTS_TELEMETRY_SAMPLE_INTERVAL_MIN_MS = 100;
export const ATTACHMENTS_TELEMETRY_SAMPLE_INTERVAL_MAX_MS = 3_600_000;

// ---------------------------------------------------------------------------
// Backlog probe (live PostgreSQL facts, fixed SQL only)
// ---------------------------------------------------------------------------

export interface AttachmentsWorkerBacklogFacts {
  /** Outbox rows for the verification handler still pending/retryable/leased. */
  readonly verificationBacklog: number;
  /** Retired/orphan/deletion-pending generations awaiting cleanup. */
  readonly cleanupBacklog: number;
  /** Quarantined generations (contract corruption review surface). */
  readonly quarantineCount: number;
  /** Dead-lettered verification outbox rows. */
  readonly deadLetterCount: number;
}

export interface AttachmentsWorkerBacklogProbe {
  read(): Promise<AttachmentsWorkerBacklogFacts>;
}

export function createPostgresAttachmentsWorkerBacklogProbe(pool: Pool): AttachmentsWorkerBacklogProbe {
  return {
    async read(): Promise<AttachmentsWorkerBacklogFacts> {
      const result = await pool.query<{
        verification_backlog: string;
        cleanup_backlog: string;
        quarantine_count: string;
        dead_letter_count: string;
      }>(`
        SELECT
          (SELECT count(*)::text FROM outbox_events
            WHERE handler_name = 'attachments_verify_generation'
              AND state IN ('pending', 'retryable', 'leased')) AS verification_backlog,
          (SELECT count(*)::text FROM blob_generations
            WHERE generation_state IN ('retired', 'orphaned', 'deletion_pending')) AS cleanup_backlog,
          (SELECT count(*)::text FROM blob_generations
            WHERE generation_state = 'quarantined') AS quarantine_count,
          (SELECT count(*)::text FROM outbox_events
            WHERE handler_name = 'attachments_verify_generation'
              AND dead_lettered_at IS NOT NULL) AS dead_letter_count
      `);
      const row = result.rows[0]!;
      return {
        verificationBacklog: Number(row.verification_backlog),
        cleanupBacklog: Number(row.cleanup_backlog),
        quarantineCount: Number(row.quarantine_count),
        deadLetterCount: Number(row.dead_letter_count),
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Backlog telemetry (bounded ring + infra gauge bridge + I15 alerts/readiness)
// ---------------------------------------------------------------------------

export interface AttachmentsWorkerTelemetryOptions {
  readonly probe: AttachmentsWorkerBacklogProbe;
  /** Infrastructure metrics bridge (fixed gauge names only). */
  readonly metrics?: Metrics;
  /** Injectable fixed-label store; production default is a bounded ring. */
  readonly store?: AttachmentMetricsStore;
  /** I15 alert thresholds; production default is the sustained-window baseline. */
  readonly alertConfig?: AttachmentAlertConfig;
  /** Bounded auto-sample interval (ms); 100..3_600_000. */
  readonly sampleIntervalMs?: number;
  /** Deterministic clock seam for alert-window tests. */
  readonly now?: () => Date;
}

export interface AttachmentsWorkerTelemetry {
  /** Live backlog facts (no caching). */
  readFacts(): Promise<AttachmentsWorkerBacklogFacts>;
  /** Record one backlog sample into the ring and refresh gauges + alerts. */
  sample(): Promise<AttachmentBacklogSample>;
  /** I15 sustained-window alert verdicts over the recorded ring. */
  alertVerdicts(): Readonly<Record<AttachmentAlertName, AttachmentAlertVerdict>>;
  /** AttachmentsReadinessFacts from live worker backlog facts. */
  readinessFacts(): Promise<AttachmentsReadinessFacts>;
  /** Bounded fixed-label metrics snapshot. */
  metricsSnapshot(): AttachmentMetricsSnapshot;
  start(): void;
  stop(): void;
}

export function createAttachmentsWorkerTelemetry(
  options: AttachmentsWorkerTelemetryOptions,
): AttachmentsWorkerTelemetry {
  const sampleIntervalMs = options.sampleIntervalMs ?? ATTACHMENTS_TELEMETRY_SAMPLE_INTERVAL_DEFAULT_MS;
  if (!Number.isSafeInteger(sampleIntervalMs)
    || sampleIntervalMs < ATTACHMENTS_TELEMETRY_SAMPLE_INTERVAL_MIN_MS
    || sampleIntervalMs > ATTACHMENTS_TELEMETRY_SAMPLE_INTERVAL_MAX_MS) {
    throw new RangeError('attachments telemetry sample interval out of bounds');
  }
  const now = options.now ?? (() => new Date());
  const store = options.store ?? createAttachmentMetricsStore();
  const alertConfig = options.alertConfig ?? DEFAULT_ATTACHMENT_ALERT_CONFIG;
  let timer: NodeJS.Timeout | undefined;
  let sampling = false;

  const sample = async (): Promise<AttachmentBacklogSample> => {
    const facts = await options.probe.read();
    const atIso = now().toISOString();
    const record: AttachmentBacklogSample = {
      atIso,
      verificationBacklog: facts.verificationBacklog,
      cleanupBacklog: facts.cleanupBacklog,
      quarantineCount: facts.quarantineCount,
      deadLetterCount: facts.deadLetterCount,
    };
    store.recordBacklogSample(record);
    // Fixed-label module gauges (I15) + the infrastructure bridge share the
    // same live facts; both surfaces stay low-cardinality.
    store.setGauge('verification_backlog', facts.verificationBacklog);
    store.setGauge('cleanup_backlog', facts.cleanupBacklog);
    store.setGauge('quarantine_count', facts.quarantineCount);
    store.setGauge('dead_letter_count', facts.deadLetterCount);
    options.metrics?.gauge('attachments.verification_backlog', facts.verificationBacklog);
    options.metrics?.gauge('attachments.cleanup_backlog', facts.cleanupBacklog);
    options.metrics?.gauge('attachments.quarantine_count', facts.quarantineCount);
    options.metrics?.gauge('attachments.dead_letter_count', facts.deadLetterCount);
    const verdicts = evaluateAttachmentAlerts({
      samples: store.snapshot().backlogSamples,
      config: alertConfig,
      nowIso: atIso,
    });
    for (const name of ATTACHMENT_ALERT_NAMES) {
      options.metrics?.gauge(`attachments.alert.${name}`, verdicts[name].firing ? 1 : 0);
    }
    return record;
  };

  return Object.freeze({
    readFacts: () => options.probe.read(),
    sample,
    alertVerdicts: (): Readonly<Record<AttachmentAlertName, AttachmentAlertVerdict>> =>
      evaluateAttachmentAlerts({
        samples: store.snapshot().backlogSamples,
        config: alertConfig,
        nowIso: now().toISOString(),
      }),
    readinessFacts: async (): Promise<AttachmentsReadinessFacts> => {
      const facts = await options.probe.read();
      return {
        worker: { verificationBacklog: facts.verificationBacklog, cleanupBacklog: facts.cleanupBacklog },
      };
    },
    metricsSnapshot: () => store.snapshot(),
    start(): void {
      if (timer) return;
      timer = setInterval(() => {
        if (sampling) return;
        sampling = true;
        void sample().catch(() => {
          options.metrics?.increment('attachments.telemetry_error');
        }).finally(() => {
          sampling = false;
        });
      }, sampleIntervalMs);
      timer.unref();
    },
    stop(): void {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  });
}

// ---------------------------------------------------------------------------
// Cleanup scheduler (bounded timer; RW path independent from verification)
// ---------------------------------------------------------------------------

export interface AttachmentsCleanupSchedulerOptions {
  readonly ledger: AttachmentsLedgerPort<DatabaseTransaction>;
  readonly objectStore: GenerationObjectStorePort;
  readonly config: AttachmentsFeatureConfig;
  readonly uow: UnitOfWork;
  readonly leaseOwner: string;
  /** Bounded scheduler interval (ms); 100..3_600_000. */
  readonly intervalMs: number;
  readonly metrics?: Metrics;
  readonly logger?: { warn(bindings: object, message: string): void };
}

export interface AttachmentsCleanupScheduler {
  /** Run one bounded batch now; keyset cursor continues across runs. */
  runOnce(): Promise<CleanupBatchResult>;
  start(): void;
  /** Stop the timer and wait for the in-flight batch (bounded drain). */
  stop(): Promise<void>;
}

export function createAttachmentsCleanupScheduler(
  options: AttachmentsCleanupSchedulerOptions,
): AttachmentsCleanupScheduler {
  if (!Number.isSafeInteger(options.intervalMs)
    || options.intervalMs < ATTACHMENTS_CLEANUP_INTERVAL_MIN_MS
    || options.intervalMs > ATTACHMENTS_CLEANUP_INTERVAL_MAX_MS) {
    throw new RangeError('attachments cleanup interval out of bounds');
  }
  let cursor: CleanupKeysetCursor | null = null;
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  let inFlight: Promise<CleanupBatchResult> | undefined;
  let abortBatch: AbortController | undefined;

  const runOnce = (): Promise<CleanupBatchResult> => {
    if (inFlight) return inFlight;
    if (stopped) return Promise.resolve({ claimed: 0, outcomes: [], nextCursor: null });
    abortBatch = new AbortController();
    inFlight = runCleanupBatch({
      signal: abortBatch.signal,
      ledger: options.ledger,
      objectStore: options.objectStore,
      config: options.config,
      uow: options.uow,
      leaseOwner: options.leaseOwner,
      cursor,
    }).then((result) => {
      cursor = result.nextCursor;
      options.metrics?.gauge('attachments.cleanup.claimed', result.claimed);
      options.metrics?.increment('attachments.cleanup.runs');
      options.metrics?.increment('attachments.cleanup.candidates', result.claimed);
      return result;
    }).finally(() => {
      inFlight = undefined;
      abortBatch = undefined;
    });
    return inFlight;
  };

  return Object.freeze({
    runOnce,
    start(): void {
      if (timer || stopped) return;
      timer = setInterval(() => {
        void runOnce().catch((error: unknown) => {
          options.metrics?.increment('attachments.cleanup_error');
          options.logger?.warn(
            { error: error instanceof Error ? error.message : String(error) },
            'attachments cleanup run failed',
          );
        });
      }, options.intervalMs);
      timer.unref();
    },
    async stop(): Promise<void> {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = undefined;
      abortBatch?.abort(new Error('attachments cleanup stopping'));
      if (inFlight) await inFlight;
    },
  });
}

// ---------------------------------------------------------------------------
// Full attachments worker composition
// ---------------------------------------------------------------------------

export interface AttachmentsWorkerCompositionOptions {
  readonly config: AttachmentsFeatureConfig;
  readonly database: DatabaseRuntime;
  /** Production object storage (RW+RO); the route reads via RO only. */
  readonly objectStorage: BlobStorePort;
  readonly metrics?: Metrics;
  readonly logger?: { info(bindings: object, message: string): void; warn(bindings: object, message: string): void };
  /** Bounded cleanup scheduler interval (ms). */
  readonly cleanupIntervalMs?: number;
  /** Bounded backlog sample interval (ms). */
  readonly telemetrySampleIntervalMs?: number;
  /** I15 alert thresholds (test seam; production uses the baseline). */
  readonly alertConfig?: AttachmentAlertConfig;
  /** Injectable fixed-label backlog store (test seam). */
  readonly metricsStore?: AttachmentMetricsStore;
  /** Deterministic clock for backlog samples (test seam). */
  readonly now?: () => Date;
  /** Stable cleanup lease owner; defaults to a random worker identity. */
  readonly workerId?: string;
}

export interface AttachmentsWorkerComposition {
  /** The production `attachments.upload-verified` outbox route (durable). */
  readonly route: OutboxRoute;
  readonly envelopeRegistration: EventPayloadRegistration;
  readonly cleanup: AttachmentsCleanupScheduler;
  readonly telemetry: AttachmentsWorkerTelemetry;
  start(): void;
  stop(): Promise<void>;
}

export function composeAttachmentsWorker(
  options: AttachmentsWorkerCompositionOptions,
): AttachmentsWorkerComposition {
  const uow: UnitOfWork = createUnitOfWork(options.database.db);
  const moduleStore: GenerationObjectStorePort = createGenerationObjectStoreAdapter(options.objectStorage);
  const ledger = createPostgresAttachmentsPorts();
  const workerId = options.workerId ?? `known-worker-${randomUUID()}`;

  const route = createAttachmentsVerificationOutboxRoute({
    repository: ledger,
    blobStore: moduleStore,
    uow,
    config: options.config,
  });
  const cleanup = createAttachmentsCleanupScheduler({
    ledger,
    objectStore: moduleStore,
    config: options.config,
    uow,
    leaseOwner: workerId,
    intervalMs: options.cleanupIntervalMs ?? ATTACHMENTS_CLEANUP_INTERVAL_DEFAULT_MS,
    metrics: options.metrics,
    logger: options.logger,
  });
  const telemetry = createAttachmentsWorkerTelemetry({
    probe: createPostgresAttachmentsWorkerBacklogProbe(options.database.pool),
    metrics: options.metrics,
    store: options.metricsStore,
    alertConfig: options.alertConfig,
    sampleIntervalMs: options.telemetrySampleIntervalMs,
    now: options.now,
  });

  return Object.freeze({
    route,
    envelopeRegistration: attachmentsVerificationEnvelopeRegistration,
    cleanup,
    telemetry,
    start(): void {
      telemetry.start();
      cleanup.start();
    },
    async stop(): Promise<void> {
      telemetry.stop();
      await cleanup.stop();
    },
  });
}
