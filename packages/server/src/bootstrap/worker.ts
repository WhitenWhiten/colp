import { loadSharedFaviconConfig } from './config-favicon-shared.js';
import { SharedFaviconCache } from '../infrastructure/collections/favicon-shared-cache.js';
import { composeLinkPreviewWorker, composeLinkPreviewWorkerStore, type ComposedLinkPreviewWorker, type LinkPreviewWorkerSeam } from './link-preview-worker-composition.js';
import { createScheduledFaviconFetcher } from '../infrastructure/collections/favicon-provider-scheduler.js';
import { composeProductionOutboxProjectionRoutes,resolveProductionProjectionSink } from './worker-projection-composition.js';
export { composeProductionOutboxProjectionRoutes,resolveProductionProjectionSink } from './worker-projection-composition.js';
import { createPostgresClassificationAutoTagRoute } from '../infrastructure/collections/index.js';
import { classificationAutoTagEnvelopeRegistration } from '../infrastructure/outbox/index.js';
import {
  loadConfig,
  sanitizedRuntimeCapacity,
  type AppConfig,
} from './config.js';
import {
  createLogger,
  createSyncServerTelemetry,
  syncDurationBucket,
  InMemoryMetrics,
  createPrometheusMetricsServer,
  parseMetricsPort,
  redactSensitiveText,
  type Metrics,
} from '../infrastructure/telemetry/index.js';
import { createDatabaseRuntime, createPostgresMcpWriteOperationsStore, type DatabaseRuntime } from '../infrastructure/database/index.js';
import { PostgresSyncEvidenceMaintenanceCoordinator, PostgresSyncTombstonePurgeCoordinator, SyncEvidenceMaintenanceJob, SyncTombstonePurgeJob } from '../infrastructure/sync/index.js';
import {
  type CacheReadinessState,
  type CacheStore,
  type RedisCacheConnectionConfig,
  type RedisClientLike,
  type RedisClientOptions,
} from '../infrastructure/cache/index.js';
import { createPostgresPublisherReceiptMaintenancePortFactory } from '../infrastructure/publisher/index.js';
import { createPostgresPublicationInsightMaintenancePortFactory } from '../infrastructure/publication/index.js';
import {
  schedulePublisherReceiptPurge,
  PUBLISHER_MIN_REPLAY_WINDOW_SECONDS,
  type PublisherReceiptMaintenancePortFactory,
  type PublisherReceiptPurgeSchedule,
} from '../modules/publisher/index.js';
import {
  schedulePublicationInsightPurge,
  type PublicationInsightMaintenancePortFactory,
  type PublicationInsightPurgeSchedule,
} from '../modules/publication/index.js';
import {
  OutboxRouter,
  EventEnvelopeRegistry,
  PostgresOutboxRepository,
  VersionedOutboxWorker,
  assertProductionOutboxRouteDurability,
  createCollectionMutationEnvelopeRegistrations,
  createPhase4bMcpChangeSignalSink,
  createSyncConflictOutboxRoute,
  createPostgresMcpChangeSignalChannel,
  createPostgresMcpChangeSignalSource,
  syncConflictEnvelopeRegistration,
  collectionInviteCreatedEnvelopeRegistration,
  createCollectionInviteEmailOutboxRoute,
  BestEffortIndexNowPublisher,
  type CollectionMutationProjectionSink,
  type IndexNowFetch,
  type IndexNowPublisher,
  type PublicationCachePurgeProvider,
  type PublicationCachePurgeReadinessState,
  type OutboxRoute,
  type OutboxWorker,
} from '../infrastructure/outbox/index.js';
import {
  composePublicationCachePurgeRoutes,
  resolvePublicationCachePurgeProvider,
} from './publication-cache-purge-composition.js';
export { resolvePublicationCachePurgeProvider } from './publication-cache-purge-composition.js';
import {
  createPostgresEmailDeliveryWorkerRepository,
  createPostgresEmailSuppressionOpsRepository,
  createEmailDeliveryWorkerRuntime,
  type EmailDeliveryWorkerLoopLogger,
  type EmailDeliveryWorkerRuntime,
} from '../infrastructure/email/index.js';
import {
  createLinkHealthWorkerRuntime,
  createPostgresLinkHealthWorkerRepository,
  createReadableReplicaWorkerRuntime,
  createPostgresReadableReplicaWorkerRepository,
  createExportJobWorkerRuntime,
  createPostgresExportJobWorkerRepository,
  createPostgresExportLibraryProjectionPort,
  createR2ExportStore,
  createFaviconWorkerRuntime,
  createPostgresFaviconJobWorkerRepository,
  createPostgresFaviconJobWorkerUnitOfWork,
  createPostgresFaviconGcRepository,
  defaultFaviconDecompressedBudget,
  fetchFaviconImage,
  linkHealthProbeInjectionFromEnv,
  type FaviconWorkerRuntime,
  type LinkHealthWorkerLoopOptions,
  type LinkHealthWorkerRuntime,
  type ReadableReplicaWorkerLoopOptions,
  type ReadableReplicaWorkerRuntime,
  type ExportJobWorkerRuntime,
} from '../infrastructure/collections/index.js';
import { createPostgresInviteEmailDeliveryRepository } from '../infrastructure/access-policy/index.js';
import { createPostgresCollaborationInviteMaintenancePortFactory } from '../infrastructure/access-policy/index.js';
import { buildInviteLoginUrl, processOne, scheduleCollaborationInviteCleanup,
  type CollaborationInviteCleanupSchedule,
  type CollaborationInviteMaintenancePortFactory } from '../modules/access-policy/index.js';
import { createEmailDeliveryRetryPolicy, type EmailProviderAdapter }
  from '../modules/email/index.js';
import {
  AliyunDirectMailAdapter,
  composeAuthEmailAdapter,
  composeInviteEmailAdapter,
  type AuthEmailAdapter,
  type AuthEmailComposition,
  type InviteEmailAdapter,
  type InviteEmailComposition,
} from '../infrastructure/email/index.js';
import { inspectEmailDeliveryMetrics } from '../modules/email/index.js';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import {
  registerFatalProcessHandlers,
  registerGracefulShutdown,
  reportFatalProcessError,
  DEFAULT_GRACEFUL_SHUTDOWN_DEADLINE_MS,
} from './process-lifecycle.js';
import { runWorkerInspectionTick } from './worker-inspection-tick.js';
import { randomUUID } from 'node:crypto';
import {
  applySyncEvidenceMaintenanceMetrics,
  createPostgresSyncOperationalTelemetry,
  publishSyncOperationalTelemetry,
} from '../infrastructure/sync/index.js';
import {
  DEFAULT_MCP_WRITE_MAINTENANCE_INTERVAL_MS,
  McpWriteMaintenanceJob,
  createPhase4bMcpWriteOperations,
  mcpReadFeatureConfigAssertOptions,
  type Phase4bMcpChangeSignalSource,
  type Phase4bMcpWriteMaintenanceJobLike,
  type Phase4bMcpWriteOperations,
} from '../modules/mcp/index.js';
import {
  composeAttachmentsWorker,
  type AttachmentsWorkerComposition,
} from './attachments-worker-composition.js';
import {
  composeAttachmentsObjectStorage,
  type ResolvedR2Secret,
} from './attachments-object-storage-composition.js';
import type { BlobStorePort } from '../infrastructure/object-storage/index.js';
import type {
  AttachmentAlertConfig,
  AttachmentAlertName,
  AttachmentAlertVerdict,
  AttachmentMetricsSnapshot,
  AttachmentMetricsStore,
  AttachmentsReadinessFacts,
  CleanupBatchResult,
} from '../modules/attachments/index.js';
import { composeLedgerArchiveWorker } from './ledger-archive-worker-composition.js';
import type { LedgerArchiveExportWorkerRuntime } from '../infrastructure/ledger-archive/index.js';
import type { LedgerArchiveSourceResolver } from './ledger-archive-worker-composition.js';
import { composeFaviconObjectStore } from './favicon-object-storage-composition.js';
import type { BookmarkFaviconObjectStore } from '../modules/collections/index.js';
import {
  CACHE_WORKER_READINESS_GAUGE,
  CACHE_WORKER_READINESS_METRIC,
  createWorkerCacheComposition,
} from './worker-cache-composition.js';
export {
  CACHE_WORKER_READINESS_GAUGE,
  CACHE_WORKER_READINESS_METRIC,
  createWorkerCacheComposition,
} from './worker-cache-composition.js';
export type {
  WorkerCacheComposition,
  WorkerCacheCompositionOptions,
} from './worker-cache-composition.js';
export interface WorkerRuntime {
  readonly metrics: Metrics;
  /** Optional outbox worker when a database runtime is composed. */
  readonly outbox?: OutboxWorker;
  /** Production-default durable projection sink when a database is composed. */
  readonly projectionSink?: CollectionMutationProjectionSink;
  /** Configured vendor-neutral cache purge boundary, when available. */
  readonly publicationCachePurgeProvider?: PublicationCachePurgeProvider;
  readonly indexNowPublisher?: IndexNowPublisher;
  /**
   * T11 live Redis cache readiness fact for the worker
   * (disabled/degraded/healthy). mode=off always reports disabled; shadow/serve
   * probe the worker-owned store health and refresh the readiness gauge.
   */
  cacheReadiness(): Promise<CacheReadinessState>;
  /** P5-29 optional email delivery worker, composed only when the feature is enabled. */
  readonly emailDelivery?: EmailDeliveryWorkerRuntime;
  /** LH-02 optional link-health probe worker, composed only when the feature is enabled. */
  readonly linkHealth?: LinkHealthWorkerRuntime;
  /** RX-02 optional readable-replica worker, composed only when the feature is enabled. */
  readonly readableReplica?: ReadableReplicaWorkerRuntime;
  readonly linkPreview?: ComposedLinkPreviewWorker; // LP-03, composed only when the feature is enabled
  /** EXJ-01 optional export-job worker, composed only when the feature is enabled. */
  readonly exportJobs?: ExportJobWorkerRuntime;
  /** FO-02 optional favicon job + GC workers, composed only when the feature is enabled. */
  readonly faviconJobs?: FaviconWorkerRuntime;
  readonly ledgerArchive?: LedgerArchiveExportWorkerRuntime;
  /**
   * C1 auth email surface (plan §9 Task C1); present only when
   * AUTH_EMAIL_ENABLED=true. Test mode composes the in-process mailbox sink;
   * any other environment composes the DirectMail adapter (fail closed on
   * missing credentials). Never touches the notification worker semantics.
   */
  readonly authEmail?: { readonly sender: AuthEmailAdapter };
  /**
   * P4A-P05 attachments worker surface: live backlog facts for partial
   * readiness, I15 sustained-window alert verdicts, and the bounded
   * fixed-label metrics snapshot. Present only when attachments are composed.
   */
  readonly attachments?: {
    readonly readinessFacts: () => Promise<AttachmentsReadinessFacts>;
    readonly alertVerdicts: () => Readonly<Record<AttachmentAlertName, AttachmentAlertVerdict>>;
    readonly metricsSnapshot: () => AttachmentMetricsSnapshot;
    /** P4A-P05: run one bounded cleanup batch now (keyset cursor continues). */
    readonly runCleanupOnce: () => Promise<CleanupBatchResult>;
  };
  /** Credential-free capacity snapshot used for startup telemetry/readiness. */
  readonly capacity: ReturnType<typeof sanitizedRuntimeCapacity>;
  start(): Promise<void>;
  stop(): Promise<void>;
}
export interface WorkerProcessResources {
  readonly metricsServer: { close(): Promise<void> };
  readonly worker: { stop(): Promise<void> };
  readonly attachmentsObjectStorage?: { close?: () => Promise<void> };
  readonly faviconObjectStore?: { close?: () => Promise<void> };
}
interface WorkerStopFailure {
  readonly resource: string;
  readonly error: unknown;
}
async function attemptWorkerStop(
  failures: WorkerStopFailure[],
  resource: string,
  stop: () => void | Promise<void>,
): Promise<void> {
  try {
    await stop();
  } catch (error: unknown) {
    failures.push({ resource, error });
  }
}
export async function closeWorkerProcessResources(input: WorkerProcessResources): Promise<void> {
  const failures: WorkerStopFailure[] = [];
  await attemptWorkerStop(failures, 'metricsServer', () => input.metricsServer.close());
  await attemptWorkerStop(failures, 'worker', () => input.worker.stop());
  const objectStorage = input.attachmentsObjectStorage;
  if (objectStorage?.close !== undefined) {
    const close = objectStorage.close;
    await attemptWorkerStop(failures, 'attachmentsObjectStorage', () => close.call(objectStorage));
  }
  const faviconStore = input.faviconObjectStore;
  if (faviconStore?.close !== undefined) {
    const close = faviconStore.close;
    await attemptWorkerStop(failures, 'faviconObjectStore', () => close.call(faviconStore));
  }
  if (failures.length > 0) {
    throw new AggregateError(
      failures.map(({ error }) => error),
      `Worker process resource close failed: ${failures.map(({ resource }) => resource).join(', ')}`,
    );
  }
}
export interface BuildWorkerOptions {
  /**
   * Optional durable collection/node mutation projection sink.
   * When omitted with a database runtime, production defaults to
   * PostgresCollectionMutationProjectionSink. Without a database, routes stay empty.
   * Transient sinks are rejected at composition time.
   */
  readonly projectionSink?: CollectionMutationProjectionSink;
  /** Optional provider injection; production config otherwise builds the generic HTTP adapter. */
  readonly publicationCachePurgeProvider?: PublicationCachePurgeProvider;
  /** Test seam that prevents real IndexNow egress. */
  readonly indexNowFetch?: IndexNowFetch;
  /**
   * T11 test seam: replaces the Redis runtime factory for the worker's own
   * store. mode=off must never call it. Production builds createRedisCacheStore.
   */
  readonly createCacheStore?: (config: RedisCacheConnectionConfig) => CacheStore;
  /** T11 test seam: pass through to createRedisCacheStore's createClient. */
  readonly createCacheClient?: (url: string, options: RedisClientOptions) => RedisClientLike;
  /** T11 bounded graceful-close budget (ms) for the worker Redis runtime. */
  readonly cacheCloseTimeoutMs?: number;
  /** Optional maintenance adapter for deterministic lifecycle composition tests. */
  readonly receiptMaintenance?: PublisherReceiptMaintenancePortFactory;
  /** Optional insight retention adapter for deterministic lifecycle composition tests. */
  readonly insightMaintenance?: PublicationInsightMaintenancePortFactory;
  /** Optional overdue-invite expiry adapter for deterministic lifecycle composition tests. */
  readonly inviteCleanup?: CollaborationInviteMaintenancePortFactory;
  /** Optional Sync operations inspect seam so inspection failures stay unit-testable. */
  readonly syncOperations?: {
    inspect(): Promise<Parameters<typeof publishSyncOperationalTelemetry>[0]>;
  };
  /** Optional logger injection for deterministic composition tests; production defaults to pino. */
  readonly logger?: EmailDeliveryWorkerLoopLogger;
  /**
   * Optional P5-29 email provider injection. Production builds the P5-28 Aliyun
   * DirectMail adapter from config + environment references and FAILS CLOSED
   * when the feature is enabled but credentials are missing. Injection is a
   * fixture-only seam (the P5-27/28 controlled fixture requires the test TLS
   * acceptance flag); the production repository/loop are always composed.
   */
  readonly emailDelivery?: { readonly provider?: EmailProviderAdapter };
  /**
   * LH-02 link-health probe injection. Tests supply `connect` + `resolve` so
   * the worker never opens a real socket. Production omits this and uses the
   * hardened egress defaults (HTTPS still only in infrastructure/collections).
   */
  readonly linkHealth?: Pick<LinkHealthWorkerLoopOptions, 'resolve' | 'connect'>;
  /**
   * RX-02 readable-replica fetch injection. Tests supply `connect` + `resolve`
   * so the worker never opens a real socket. Production omits this.
   */
  readonly readableReplica?: Pick<ReadableReplicaWorkerLoopOptions, 'resolve' | 'connect'>;
  readonly linkPreview?: LinkPreviewWorkerSeam; // LP-03 store + egress seam; production passes the process store
  /**
   * FO-02 favicon job/GC worker seam. Tests inject `store` + `resolve` +
   * `connect` so the worker never opens a real socket or R2 client. Production
   * composes the R2 favicon store from the same attachment/avatar secrets the
   * API uses and uses the hardened egress defaults.
   */
  readonly favicon?: {
    readonly store?: BookmarkFaviconObjectStore;
    readonly resolve?: import('../infrastructure/egress/index.js').HardenedEgressResolver;
    readonly connect?: import('../infrastructure/egress/index.js').HardenedEgressConnector;
  };
  /**
   * C1 auth email sender injection (fixture-only seam; production composes the
   * DirectMail adapter / test-mode mailbox sink from config and FAILS CLOSED
   * when the flag is on but credentials are missing, exactly like
   * emailDelivery.provider). The flag still gates the surface.
   */
  readonly authEmail?: { readonly sender?: AuthEmailAdapter };
  /**
   * SC-04 collection invite email sender injection (fixture-only seam).
   * Production composes DirectMail / test mailbox from config.
   */
  readonly inviteEmail?: { readonly sender?: InviteEmailAdapter };
  /** Optional MCP-W09 operations seam for maintenance composition tests. */
  readonly mcpWriteOperations?: Phase4bMcpWriteOperations;
  /** Optional MCP Write maintenance schedule for deterministic lifecycle tests. */
  readonly mcpWriteMaintenanceJob?: Phase4bMcpWriteMaintenanceJobLike;
  /** P4B-R11 non-durable MCP change-signal source. */
  readonly mcpReadChangeSignalSource?: Phase4bMcpChangeSignalSource;
  /**
   * P4A-P05 production attachments object storage (RW+RO). Required when
   * ATTACHMENTS_ENABLED=true: the worker composes the verification outbox
   * route (RO credential reads) and the independent cleanup RW scheduler.
   */
  readonly attachmentsObjectStorage?: BlobStorePort;
  /** P4A-P05 bounded cleanup scheduler interval (ms); default 60s. */
  readonly attachmentsCleanupIntervalMs?: number;
  /** P4A-P05 bounded backlog sample interval (ms); default 30s. */
  readonly attachmentsTelemetryIntervalMs?: number;
  /** P4A-P05 I15 alert thresholds (test seam; production uses the baseline). */
  readonly attachmentsAlertConfig?: AttachmentAlertConfig;
  /** P4A-P05 injectable fixed-label backlog store (test seam). */
  readonly attachmentsMetricsStore?: AttachmentMetricsStore;
  /** P4A-P05 deterministic backlog clock (test seam). */
  readonly attachmentsNow?: () => Date;
  /** P4A-P05 stable cleanup lease owner identity. */
  readonly attachmentsWorkerId?: string;
  readonly ledgerArchiveSourceResolver?: LedgerArchiveSourceResolver;
  readonly ledgerArchiveWorkerId?: string;
}
/**
 * FO-02 favicon worker composition. Fails closed when the feature is enabled
 * without a durable object store. Tests inject store/resolve/connect through
 * `BuildWorkerOptions.favicon`; production composes the shared R2 store and
 * uses hardened egress defaults.
 */
function composeFaviconWorkerRuntime(
  config: AppConfig,
  database: DatabaseRuntime,
  metrics: Metrics,
  logger: EmailDeliveryWorkerLoopLogger,
  options: BuildWorkerOptions,
): FaviconWorkerRuntime {
  const store = options.favicon?.store;
  const resolve = options.favicon?.resolve;
  const connect = options.favicon?.connect;
  if (store === undefined) {
    throw new Error(
      'worker composition refused: KNOWN_FEATURE_FAVICON_POLICY enabled requires a favicon object store',
    );
  }
  const sharedConfig = config.faviconPolicy.shared ?? loadSharedFaviconConfig({});
  const scheduledFetch = createScheduledFaviconFetcher(database.pool, (input) => fetchFaviconImage({
      url: input.url,
      timeoutMs: input.timeoutMs,
      maxBytes: input.maxBytes,
      maxDecompressedBytes: input.maxDecompressedBytes,
      maxRedirects: input.maxRedirects,
      ...(resolve === undefined ? {} : { resolve }),
      ...(connect === undefined ? {} : { connect }),
    }), sharedConfig.providerIntervalMs);
  const shared = new SharedFaviconCache(database.pool, store, scheduledFetch, {
    providerTemplate: sharedConfig.providerTemplate,
    refreshIntervalMs: sharedConfig.refreshIntervalMs,
    retentionSeconds: config.faviconPolicy.historyRetentionSeconds,
    fetch: {
      timeoutMs: config.faviconPolicy.fetchTimeoutMs,
      maxBytes: config.faviconPolicy.fetchMaxBytes,
      maxDecompressedBytes: defaultFaviconDecompressedBudget(config.faviconPolicy.fetchMaxBytes),
      maxRedirects: config.faviconPolicy.fetchMaxRedirects,
    },
  });
  return createFaviconWorkerRuntime({
    repository: createPostgresFaviconJobWorkerRepository(database.pool),
    gc: createPostgresFaviconGcRepository(database.pool),
    verify: createPostgresFaviconJobWorkerUnitOfWork(database.db),
    fetcher: shared.fetch,
    maintainSharedCache: () => shared.runOnce(),
    store,
    logger,
    metrics,
    concurrency: config.faviconPolicy.jobConcurrency,
    pollIntervalMs: config.faviconPolicy.workerPollIntervalMs,
    leaseDurationMs: config.faviconPolicy.workerLeaseDurationMs,
    gcPollIntervalMs: config.faviconPolicy.gcPollIntervalMs,
    batchSize: config.faviconPolicy.jobBatchSize,
    options: {
      maxAttempts: config.faviconPolicy.jobMaxAttempts,
      backoffSeconds: config.faviconPolicy.retryBackoffSeconds,
      retentionSeconds: config.faviconPolicy.historyRetentionSeconds,
      maxBytes: config.faviconPolicy.fetchMaxBytes,
      maxDecompressedBytes: defaultFaviconDecompressedBudget(config.faviconPolicy.fetchMaxBytes),
      fetchTimeoutMs: config.faviconPolicy.fetchTimeoutMs,
      maxRedirects: config.faviconPolicy.fetchMaxRedirects,
    },
  });
}

/** Honest publication cache purge provider readiness state for worker composition. */
export function resolvePublicationCachePurgeReadinessState(
  provider: PublicationCachePurgeProvider | undefined,
): PublicationCachePurgeReadinessState {
  if (provider === undefined) return 'missing';
  return provider.kind === 'stub' ? 'stubbed' : 'durable';
}
/**
 * P5-29 production email delivery composition.
 *
 * - Composed ONLY when the email feature is enabled AND a database runtime is
 *   present; otherwise no email worker runs.
 * - Fails closed at composition when the feature is enabled but provider
 *   credentials are missing (production adapter path). An injected provider is
 *   the fixture-only seam (controlled P5-27/28 fixture TLS) and bypasses the
 *   credential check; the production repository/loop are always used.
 * - The loop and the callback reconciler run through the production Postgres
 *   repository; the provider send/lookup/verify surface is the P5-28 adapter
 *   port injected from the notifications facade.
 */
function composeEmailDeliveryRuntime(
  config: AppConfig,
  database: DatabaseRuntime,
  metrics: Metrics,
  logger: EmailDeliveryWorkerLoopLogger,
  options: BuildWorkerOptions,
): EmailDeliveryWorkerRuntime {
  const email = config.email!;
  const provider = options.emailDelivery?.provider ?? (() => {
    const accessKeyId = process.env.ALIBABA_CLOUD_ACCESS_KEY_ID?.trim();
    const accessKeySecret = process.env.ALIBABA_CLOUD_ACCESS_KEY_SECRET?.trim();
    if (!accessKeyId || !accessKeySecret || !email.accountName) {
      throw new Error(
        'worker composition refused: KNOWN_FEATURE_EMAIL enabled requires '
        + 'ALIBABA_CLOUD_ACCESS_KEY_ID/ALIBABA_CLOUD_ACCESS_KEY_SECRET and EMAIL_DM_ACCOUNT_NAME',
      );
    }
    return new AliyunDirectMailAdapter({
      endpoint: email.endpoint,
      regionId: email.regionId,
      accountName: email.accountName,
      accessKeyId,
      accessKeySecret,
      timeoutMs: email.timeoutMs,
      tagPrefix: email.tagPrefix,
      maxTagChars: email.maxTagChars,
      ...(email.callback.hmacSecret !== null
        ? { callbackHmacSecret: email.callback.hmacSecret } : {}),
      callbackTimestampReplayWindowMs: email.callback.timestampReplayWindowMs,
    });
  })();
  return createEmailDeliveryWorkerRuntime({
    repository: createPostgresEmailDeliveryWorkerRepository(database.pool),
    provider,
    logger,
    metrics,
    leaseDurationMs: email.worker.leaseDurationMs,
    heartbeatIntervalMs: email.worker.heartbeatIntervalMs,
    pollIntervalMs: email.worker.pollIntervalMs,
    batchSize: email.worker.batchSize,
    retryPolicy: createEmailDeliveryRetryPolicy({
      baseDelayMs: email.worker.baseBackoffMs,
      maxDelayMs: email.worker.maxBackoffMs,
      maxAttempts: email.worker.maxAttempts,
    }),
    tagPrefix: email.tagPrefix,
    emailSkins: config.emailSkins,
  });
}
export function buildWorker(
  config: AppConfig = loadConfig(),
  database?: DatabaseRuntime,
  metrics: Metrics = new InMemoryMetrics(),
  options: BuildWorkerOptions = {},
): WorkerRuntime {
  const logger: EmailDeliveryWorkerLoopLogger = options.logger ?? createLogger(config.logLevel);
  const capacity = sanitizedRuntimeCapacity(config);
  if (config.syncTombstonePurge.enabled && !database) {
    throw new Error('worker composition refused: Sync Tombstone purge requires PostgreSQL');
  }
  if (config.syncEvidenceMaintenance.enabled && !database) {
    throw new Error('worker composition refused: Sync Evidence maintenance requires PostgreSQL');
  }
  // Fail closed if composition is handed a pool smaller than configured concurrency.
  if (database) {
    const poolMax = database.pool.options.max ?? capacity.database.maxConnections;
    if (capacity.worker.concurrency > poolMax) {
      throw new Error(
        `worker composition refused: WORKER_CONCURRENCY (${capacity.worker.concurrency}) `
        + `exceeds database pool max (${poolMax})`,
      );
    }
  }
  // Task 12: production default is the durable PostgreSQL collection mutation projection.
  // Task 11 invariants still hold: never default to memory; refuse transient sinks.
  const baseProjectionSink = resolveProductionProjectionSink({
    database,
    projectionSink: options.projectionSink,
  });
  if (config.mcp && options.mcpReadChangeSignalSource === undefined) {
    throw new Error(
      'worker composition refused: MCP Read enabled requires an MCP change signal source for subscriptions/listen hints',
    );
  }
  if (config.mcp && baseProjectionSink === undefined) {
    throw new Error(
      'worker composition refused: MCP Read enabled requires the durable collection mutation projection sink',
    );
  }
  const projectionSink = config.mcp && baseProjectionSink && options.mcpReadChangeSignalSource
    ? createPhase4bMcpChangeSignalSink({
        projectionSink: baseProjectionSink,
        signalSource: options.mcpReadChangeSignalSource,
        config: config.mcp,
        assertOptions: mcpReadFeatureConfigAssertOptions({
          nodeEnv: config.nodeEnv,
          oauthIssuerEnabled: config.betterAuth.oauthIssuerEnabled,
        }),
        onError(error) {
          logger.warn(
            { error: redactSensitiveText(error) },
            'MCP change signal fan-out failed; durable projection was already applied',
          );
        },
      })
    : baseProjectionSink;
  const mcpReadChangeSignalSource = options.mcpReadChangeSignalSource;
  const projectionRoutes = composeProductionOutboxProjectionRoutes({
    projectionSink,
    logger,
  });
  const cdnPublicationCachePurgeProvider = resolvePublicationCachePurgeProvider(
    config,
    options.publicationCachePurgeProvider,
  );
  // T11: shadow/serve compose the T09 Redis invalidator with the existing CDN
  // provider; mode=off keeps the CDN provider untouched (reference behavior).
  const workerCacheComposition = createWorkerCacheComposition({
    config: config.cache,
    cdn: cdnPublicationCachePurgeProvider,
    metrics,
    environment: config.nodeEnv,
    ...(options.createCacheStore === undefined ? {} : { createStore: options.createCacheStore }),
    ...(options.createCacheClient === undefined ? {} : { createClient: options.createCacheClient }),
    ...(options.cacheCloseTimeoutMs === undefined ? {} : { closeTimeoutMs: options.cacheCloseTimeoutMs }),
  });
  const publicationCachePurgeProvider = workerCacheComposition.publicationCachePurgeProvider
    ?? cdnPublicationCachePurgeProvider;
  const indexNowPublisher = config.publication.indexNow.enabled
    ? new BestEffortIndexNowPublisher({
        key: config.publication.indexNow.key,
        timeoutMs: config.publication.indexNow.timeoutMs,
        metrics,
        logger,
        ...(options.indexNowFetch === undefined ? {} : { fetch: options.indexNowFetch }),
      })
    : undefined;
  const publicationCachePurgeRoutes = composePublicationCachePurgeRoutes({
    provider: publicationCachePurgeProvider,
    config,
    database,
    handlerTimeoutMs: capacity.worker.handlerTimeoutMs,
    metrics,
    ...(indexNowPublisher === undefined ? {} : { indexNowPublisher }),
  });
  const syncConflictRoutes = database
    ? Object.freeze([createSyncConflictOutboxRoute(database.pool)])
    : Object.freeze([]);
  // P4A-P05: production attachments worker composition. Fail closed when
  // ATTACHMENTS_ENABLED=true but the worker cannot consume product traffic
  // (no database or no object storage). Runtime attachments failures stay
  // isolated to their own outbox rows / cleanup runs and never disable the
  // unrelated routes below.
  let attachmentsComposition: AttachmentsWorkerComposition | undefined;
  if (config.attachments) {
    if (!database) {
      throw new Error('worker composition refused: ATTACHMENTS_ENABLED requires PostgreSQL');
    }
    if (!options.attachmentsObjectStorage) {
      throw new Error(
        'worker composition refused: ATTACHMENTS_ENABLED requires an attachments '
        + 'object storage (attachmentsObjectStorage) for verification + cleanup',
      );
    }
    attachmentsComposition = composeAttachmentsWorker({
      config: config.attachments,
      database,
      objectStorage: options.attachmentsObjectStorage,
      metrics,
      logger,
      ...(options.attachmentsCleanupIntervalMs === undefined
        ? {} : { cleanupIntervalMs: options.attachmentsCleanupIntervalMs }),
      ...(options.attachmentsTelemetryIntervalMs === undefined
        ? {} : { telemetrySampleIntervalMs: options.attachmentsTelemetryIntervalMs }),
      ...(options.attachmentsAlertConfig === undefined ? {} : { alertConfig: options.attachmentsAlertConfig }),
      ...(options.attachmentsMetricsStore === undefined ? {} : { metricsStore: options.attachmentsMetricsStore }),
      ...(options.attachmentsNow === undefined ? {} : { now: options.attachmentsNow }),
      ...(options.attachmentsWorkerId === undefined ? {} : { workerId: options.attachmentsWorkerId }),
    });
  }
  const inviteEmailComposition: InviteEmailComposition | undefined = database
    ? options.inviteEmail?.sender !== undefined
      ? { sender: options.inviteEmail.sender, close: async () => {} }
      : composeInviteEmailAdapter({
        enabled: config.collaborationInviteEmail.enabled,
        nodeEnv: config.nodeEnv,
        directMail: config.collaborationInviteEmail,
        resolveCredentials: () => {
          const accessKeyId = process.env.ALIBABA_CLOUD_ACCESS_KEY_ID?.trim();
          const accessKeySecret = process.env.ALIBABA_CLOUD_ACCESS_KEY_SECRET?.trim();
          if (!accessKeyId || !accessKeySecret) {
            throw new Error(
              'worker composition refused: COLLABORATION_INVITE_EMAIL_ENABLED requires '
              + 'ALIBABA_CLOUD_ACCESS_KEY_ID/ALIBABA_CLOUD_ACCESS_KEY_SECRET',
            );
          }
          return { accessKeyId, accessKeySecret };
        },
        logger,
        emailSkins: config.emailSkins,
      })
    : undefined;
  const collectionInviteEmailRoutes = database && inviteEmailComposition
    ? Object.freeze([createCollectionInviteEmailOutboxRoute({
      processOne: (input) => processOne({
        repository: createPostgresInviteEmailDeliveryRepository(database.pool),
        sender: inviteEmailComposition.sender,
        loginUrl: buildInviteLoginUrl(config.productOrigin),
        leaseDurationMs: 30_000,
        inviteId: input.inviteId,
        ...(input.signal !== undefined ? { signal: input.signal } : {}),
      }),
    })])
    : Object.freeze([]);
  const autoTagRoute=database?createPostgresClassificationAutoTagRoute(database,config.classification,metrics,
    false):undefined;
  const routes = Object.freeze([
    ...(autoTagRoute?[autoTagRoute]:[]),
    ...projectionRoutes, ...syncConflictRoutes,
    ...publicationCachePurgeRoutes,
    ...collectionInviteEmailRoutes,
    ...(attachmentsComposition === undefined ? [] : [attachmentsComposition.route]),
  ]);
  const durability = assertProductionOutboxRouteDurability(routes);
  metrics.gauge('outbox.projection_routes', durability.routeCount);
  metrics.gauge('outbox.projection_durable_routes', durability.durableCount);
  metrics.gauge('outbox.projection_transient_routes', durability.transientCount);
  metrics.gauge('outbox.projection_all_durable', durability.allDurable ? 1 : 0);
  metrics.gauge(
    'publication.cache_purge.route_configured',
    durability.publicationCachePurge.configured ? 1 : 0,
  );
  // Honest gauge: 1 only when a durable provider is actually wired. The worker
  // route-level default counts the test-mode no-op stub as durable; the actual
  // provider kind is overlaid here so readiness never lies.
  const publicationCachePurgeReadinessState = resolvePublicationCachePurgeReadinessState(
    publicationCachePurgeProvider,
  );
  metrics.gauge(
    'publication.cache_purge.route_durable',
    publicationCachePurgeReadinessState === 'durable' ? 1 : 0,
  );
  // T11: worker cache readiness gauge (0=disabled, 1=degraded, 2=healthy).
  // mode=off is decided synchronously here; shadow/serve refresh it in
  // start() and on every cacheReadiness() probe.
  metrics.gauge(CACHE_WORKER_READINESS_METRIC, CACHE_WORKER_READINESS_GAUGE.disabled);
  metrics.gauge('database.pool_max', capacity.database.maxConnections);
  metrics.gauge('outbox.worker_concurrency', capacity.worker.concurrency);
  metrics.gauge('outbox.worker_batch_size', capacity.worker.batchSize);
  metrics.gauge(
    'publisher.receipt_replay_window_seconds',
    PUBLISHER_MIN_REPLAY_WINDOW_SECONDS,
  );
  metrics.gauge(
    'publisher.receipt_cleanup_batch_size',
    config.publisherReceipts.cleanupBatchSize,
  );
  metrics.gauge(
    'publisher.receipt_cleanup_interval_ms',
    config.publisherReceipts.cleanupIntervalMs,
  );
  metrics.gauge(
    'publication.insight_cleanup_batch_size',
    config.publicationInsightRetention.cleanupBatchSize,
  );
  metrics.gauge(
    'publication.insight_cleanup_interval_ms',
    config.publicationInsightRetention.cleanupIntervalMs,
  );
  metrics.gauge(
    'collaboration.invite_cleanup_batch_size',
    config.collaborationInviteCleanup.cleanupBatchSize,
  );
  metrics.gauge(
    'collaboration.invite_cleanup_interval_ms',
    config.collaborationInviteCleanup.cleanupIntervalMs,
  );
  const outbox = database ? new VersionedOutboxWorker({
    repository: new PostgresOutboxRepository(database.pool),
    router: new OutboxRouter(routes),
    envelopes: new EventEnvelopeRegistry([
      ...createCollectionMutationEnvelopeRegistrations(), classificationAutoTagEnvelopeRegistration,
      syncConflictEnvelopeRegistration,
      collectionInviteCreatedEnvelopeRegistration,
      ...(attachmentsComposition === undefined ? [] : [attachmentsComposition.envelopeRegistration]),
    ]),
    logger,
    metrics,
    leaseDurationMs: capacity.worker.leaseDurationMs,
    heartbeatIntervalMs: capacity.worker.heartbeatIntervalMs,
    handlerTimeoutMs: capacity.worker.handlerTimeoutMs,
    shutdownDeadlineMs: capacity.worker.handlerTimeoutMs,
    maxConcurrentHandlers: capacity.worker.concurrency,
    batchSize: capacity.worker.batchSize,
    pollIntervalMs: capacity.worker.pollIntervalMs,
    // Production never acknowledges transient side effects.
    acknowledgeTransientSideEffects: false,
    // Overlay the honest provider readiness onto projectionReadiness() so the
    // test-mode no-op stub is never reported durable.
    publicationCachePurgeState: publicationCachePurgeReadinessState,
  }) : undefined;
  const receiptMaintenance = options.receiptMaintenance
    ?? (database ? createPostgresPublisherReceiptMaintenancePortFactory(database.db) : undefined);
  let receiptPurgeSchedule: PublisherReceiptPurgeSchedule | undefined;
  const insightMaintenance = options.insightMaintenance
    ?? (database ? createPostgresPublicationInsightMaintenancePortFactory(database.db) : undefined);
  let insightPurgeSchedule: PublicationInsightPurgeSchedule | undefined;
  const inviteCleanup = options.inviteCleanup
    ?? (database ? createPostgresCollaborationInviteMaintenancePortFactory(database.db) : undefined);
  let inviteCleanupSchedule: CollaborationInviteCleanupSchedule | undefined;
  let notificationOperationsTimer: NodeJS.Timeout | undefined;
  let syncOperationsTimer: NodeJS.Timeout | undefined;
  const syncOperationsInspectionGate = { running: false };
  const emailDeliveryRuntime = (database && config.email?.enabled)
    ? composeEmailDeliveryRuntime(config, database, metrics, logger, options)
    : undefined;
  const linkHealthRuntime = (database && config.linkHealth.enabled)
    ? createLinkHealthWorkerRuntime({
        repository: createPostgresLinkHealthWorkerRepository(database.pool),
        logger,
        metrics,
        probeTimeoutMs: config.linkHealth.probeTimeoutMs,
        connectTimeoutMs: config.linkHealth.connectTimeoutMs,
        concurrency: config.linkHealth.workerConcurrency,
        perHostGapMs: config.linkHealth.perHostGapMs,
        pollIntervalMs: config.linkHealth.workerPollIntervalMs,
        leaseDurationMs: config.linkHealth.workerLeaseDurationMs,
        ...(options.linkHealth?.resolve === undefined ? {} : { resolve: options.linkHealth.resolve }),
        ...(options.linkHealth?.connect === undefined ? {} : { connect: options.linkHealth.connect }),
      })
    : undefined;
  const readableReplicaRuntime = (database && config.readableReplica.enabled)
    ? createReadableReplicaWorkerRuntime({
        repository: createPostgresReadableReplicaWorkerRepository(database.pool),
        logger,
        metrics,
        probeTimeoutMs: config.readableReplica.probeTimeoutMs,
        connectTimeoutMs: config.readableReplica.connectTimeoutMs,
        maxBodyBytes: config.readableReplica.maxBodyBytes,
        concurrency: config.readableReplica.workerConcurrency,
        perHostGapMs: config.readableReplica.perHostGapMs,
        pollIntervalMs: config.readableReplica.workerPollIntervalMs,
        leaseDurationMs: config.readableReplica.workerLeaseDurationMs,
        ...(options.readableReplica?.resolve === undefined ? {} : { resolve: options.readableReplica.resolve }),
        ...(options.readableReplica?.connect === undefined ? {} : { connect: options.readableReplica.connect }),
      })
    : undefined;
  const linkPreviewRuntime = composeLinkPreviewWorker({ config, database, metrics, logger, seam: options.linkPreview });
  const exportJobRuntime = (database && config.exportJobs.enabled && config.exportJobs.r2)
    ? createExportJobWorkerRuntime({
        repository: createPostgresExportJobWorkerRepository(database.pool),
        projection: createPostgresExportLibraryProjectionPort(database.db),
        store: createR2ExportStore(config.exportJobs.r2),
        logger,
        metrics,
        concurrency: config.exportJobs.workerConcurrency,
        pollIntervalMs: config.exportJobs.workerPollIntervalMs,
        leaseDurationMs: config.exportJobs.workerLeaseDurationMs,
      })
    : undefined;
  const ledgerArchiveRuntime = composeLedgerArchiveWorker({
    config: config.ledgerArchive,
    database,
    ...(options.ledgerArchiveSourceResolver === undefined
      ? {} : { resolveSource: options.ledgerArchiveSourceResolver }),
    ...(options.ledgerArchiveWorkerId === undefined ? {} : { workerId: options.ledgerArchiveWorkerId }),
    logger,
  });
  // FO-02: favicon refresh + GC workers. Composed only when the feature is
  // enabled; fail closed (startup) when the durable store is missing.
  const faviconJobsRuntime = (database && config.faviconPolicy.enabled)
    ? composeFaviconWorkerRuntime(config, database, metrics, logger, options)
    : undefined;
  // C1 auth email surface: composed only when AUTH_EMAIL_ENABLED=true (test
  // mode -> in-process mailbox sink; otherwise DirectMail, fail closed). The
  // fixture seam bypasses the credential check exactly like emailDelivery.
  const authEmailComposition: AuthEmailComposition | undefined = config.authEmail.enabled
    ? options.authEmail?.sender !== undefined
      ? { sender: options.authEmail.sender, close: async () => {} }
      : composeAuthEmailAdapter({
        enabled: true,
        nodeEnv: config.nodeEnv,
        directMail: config.authEmail,
        resolveCredentials: () => {
          const accessKeyId = process.env.ALIBABA_CLOUD_ACCESS_KEY_ID?.trim();
          const accessKeySecret = process.env.ALIBABA_CLOUD_ACCESS_KEY_SECRET?.trim();
          if (!accessKeyId || !accessKeySecret) {
            throw new Error(
              'worker composition refused: AUTH_EMAIL_ENABLED requires '
              + 'ALIBABA_CLOUD_ACCESS_KEY_ID/ALIBABA_CLOUD_ACCESS_KEY_SECRET',
            );
          }
          return { accessKeyId, accessKeySecret };
        },
        logger,
        emailSkins: config.emailSkins,
      })
    : undefined;
  const syncOperations = options.syncOperations
    ?? (database ? createPostgresSyncOperationalTelemetry(database) : undefined);
  const tombstonePurgeJob = database && config.syncTombstonePurge.enabled
    ? (() => {
      const purgeTelemetry = createSyncServerTelemetry({ metrics, logger });
      let purgeStartedAt = 0;
      return new SyncTombstonePurgeJob(new PostgresSyncTombstonePurgeCoordinator(database.db, {
        workerId: `known-worker-${randomUUID()}`,
        batchSize: config.syncTombstonePurge.batchSize,
        leaseDurationMs: config.syncTombstonePurge.leaseDurationMs,
      }), {
        intervalMs: config.syncTombstonePurge.intervalMs,
        onStart() { purgeStartedAt = performance.now(); },
        onResult(result) {
          const durationMs = Math.max(0, performance.now() - purgeStartedAt);
          purgeTelemetry.record({ endpoint: 'purge', outcome: 'success', problem: 'none',
            bucket: syncDurationBucket(durationMs), durationMs });
          metrics.increment('sync.tombstone_purge.runs');
          metrics.increment('sync.tombstone_purge.payloads', result.purgedCount);
          metrics.gauge('sync.tombstone_purge.has_more', result.hasMore ? 1 : 0);
        },
        onError(error) {
          const durationMs = Math.max(0, performance.now() - purgeStartedAt);
          purgeTelemetry.record({ endpoint: 'purge', outcome: 'internal', problem: 'internal_error',
            bucket: syncDurationBucket(durationMs), durationMs });
          metrics.increment('sync.tombstone_purge.errors');
          logger.warn({ code: error instanceof Error ? 'run_failed' : 'unknown_failure' },
            'Sync Tombstone purge failed');
        },
      });
    })()
    : undefined;
  const evidenceMaintenanceJob = database && config.syncEvidenceMaintenance.enabled
    ? (() => {
      let maintenanceStartedAt = 0;
      return new SyncEvidenceMaintenanceJob(new PostgresSyncEvidenceMaintenanceCoordinator(database.db, {
        workerId: `known-worker-${randomUUID()}`,
        batchSize: config.syncEvidenceMaintenance.batchSize,
        leaseDurationMs: config.syncEvidenceMaintenance.leaseDurationMs,
      }), {
        intervalMs: config.syncEvidenceMaintenance.intervalMs,
        onStart() { maintenanceStartedAt = performance.now(); },
        onResult(result) {
          const durationMs = Math.max(0, performance.now() - maintenanceStartedAt);
          if (durationMs > config.syncEvidenceMaintenance.leaseDurationMs) {
            logger.warn({ durationMs, code: 'run_exceeded_lease' },
              'Sync evidence maintenance run exceeded its lock lease window');
          }
          applySyncEvidenceMaintenanceMetrics(metrics, result);
        },
        onError(error) {
          metrics.increment('sync.evidence_maintenance.errors');
          metrics.increment('sync.evidence_maintenance.runs');
          logger.warn({ code: error instanceof Error ? 'run_failed' : 'unknown_failure' },
            'Sync evidence maintenance failed');
        },
      });
    })()
    : undefined;
  const mcpWriteMaintenanceJob = config.mcpWriteEnabled
    ? options.mcpWriteMaintenanceJob
      ?? (config.mcpWriteEnabled && database
        ? (() => {
            const operationsStore = createPostgresMcpWriteOperationsStore(database.db);
            const operations = options.mcpWriteOperations
              ?? createPhase4bMcpWriteOperations({ metrics, store: operationsStore });
            return new McpWriteMaintenanceJob(operations, {
              intervalMs: config.mcpWrite?.maintenanceIntervalMs
                ?? DEFAULT_MCP_WRITE_MAINTENANCE_INTERVAL_MS,
              onError(error) {
                logger.warn(
                  { error: redactSensitiveText(error) },
                  'MCP Write maintenance failed',
                );
              },
            });
          })()
        : undefined)
    : undefined;
  // T11: refresh the readiness gauge from a live store.health() probe.
  async function workerCacheReadiness(): Promise<CacheReadinessState> {
    const state = await workerCacheComposition.readiness();
    metrics.gauge(CACHE_WORKER_READINESS_METRIC, CACHE_WORKER_READINESS_GAUGE[state]);
    return state;
  }
  return {
    metrics,
    outbox,
    emailDelivery: emailDeliveryRuntime,
    linkHealth: linkHealthRuntime,
    readableReplica: readableReplicaRuntime,
    linkPreview: linkPreviewRuntime,
    exportJobs: exportJobRuntime,
    faviconJobs: faviconJobsRuntime,
    ledgerArchive: ledgerArchiveRuntime,
    ...(authEmailComposition === undefined ? {} : { authEmail: { sender: authEmailComposition.sender } }),
    attachments: attachmentsComposition === undefined ? undefined : {
      readinessFacts: () => attachmentsComposition!.telemetry.readinessFacts(),
      alertVerdicts: () => attachmentsComposition!.telemetry.alertVerdicts(),
      metricsSnapshot: () => attachmentsComposition!.telemetry.metricsSnapshot(),
      runCleanupOnce: () => attachmentsComposition!.cleanup.runOnce(),
    },
    projectionSink,
    publicationCachePurgeProvider,
    indexNowPublisher,
    cacheReadiness: workerCacheReadiness,
    capacity,
    async start() {
      await database?.verifyReady();
      // Re-assert durability at start so miscomposed runtimes fail closed before polling.
      if (outbox) {
        const readiness = outbox.projectionReadiness();
        if (
          !readiness.allDurable
          || readiness.acknowledgesTransientSideEffects
          || readiness.routeCount < 1
          || (config.nodeEnv === 'production'
            && (!readiness.publicationCachePurge.configured
              || !readiness.publicationCachePurge.allDurable))
        ) {
          throw new Error(
            'worker start refused: outbox routes are not production-durable '
            + `(routes=${readiness.routeCount}, transient=${readiness.transientCount}, `
            + `acknowledgeTransient=${readiness.acknowledgesTransientSideEffects}, `
            + `publicationCachePurgeConfigured=${readiness.publicationCachePurge.configured}, `
            + `publicationCachePurgeDurable=${readiness.publicationCachePurge.allDurable})`,
          );
        }
      }
      // T11: fail closed when the cache is required but not healthy. Runs before
      // outbox.start() so a required cache failure never claims outbox work.
      const cacheReadinessState = await workerCacheReadiness();
      if (config.cache.redis.required && cacheReadinessState !== 'healthy') {
        throw new Error(
          'worker start refused: KNOWN_CACHE_REQUIRED=true requires a healthy '
          + `cache, got ${cacheReadinessState}`);
      }
      // Validate the scheduler dependency before any worker loop is started;
      // otherwise an enabled-but-unwired connector would leave outbox/email
      // timers running after start() rejects.
      outbox?.start();
      // P4A-P05: start the attachments sampler + cleanup scheduler only after
      // the outbox loop is live; independent timers, bounded, unref'd.
      attachmentsComposition?.start();
      emailDeliveryRuntime?.loop.start();
      linkHealthRuntime?.loop.start();
      readableReplicaRuntime?.loop.start();
      linkPreviewRuntime?.loop.start();
      exportJobRuntime?.loop.start();
      faviconJobsRuntime?.jobs.start();
      faviconJobsRuntime?.gc.start();
      ledgerArchiveRuntime?.start();
      const emailSuppressionOps = emailDeliveryRuntime && database
        ? createPostgresEmailSuppressionOpsRepository(database.pool)
        : undefined;
      metrics.gauge('notifications.email_delivery.enabled',
        emailDeliveryRuntime ? 1 : 0);
      metrics.gauge('notifications.email_delivery.worker_running',
        emailDeliveryRuntime?.loop.isRunning() ? 1 : 0);
      const publishNotificationStatus = () => runWorkerInspectionTick({
        enabled: emailDeliveryRuntime !== undefined,
        gate: { running: false },
        inspect: async () => {
          metrics.gauge('notifications.email_delivery.enabled',
            emailDeliveryRuntime ? 1 : 0);
          metrics.gauge('notifications.email_delivery.worker_running',
            emailDeliveryRuntime?.loop.isRunning() ? 1 : 0);
          await inspectEmailDeliveryMetrics(emailSuppressionOps, {
            enabled: emailDeliveryRuntime !== undefined,
            workerRunning: emailDeliveryRuntime?.loop.isRunning() ?? false,
            probeStatus: 0,
            optionalDeliveryAvailable: true,
          }, metrics);
        },
        onError(error) {
          metrics.increment('notifications.operations_inspect_error');
          logger.warn(
            { error: redactSensitiveText(error) },
            'Notification operations inspection failed',
          );
        },
      });
      await publishNotificationStatus();
      notificationOperationsTimer = setInterval(() => { void publishNotificationStatus(); },
        Math.max(1_000, Math.min(30_000,
          config.notifications?.operations.queueAgeNotReadyMs ?? 30_000)));
      notificationOperationsTimer.unref();
      const publishSyncStatus = () => runWorkerInspectionTick({
        enabled: syncOperations !== undefined,
        gate: syncOperationsInspectionGate,
        inspect: async () => {
          if (!syncOperations) return;
          publishSyncOperationalTelemetry(await syncOperations.inspect(), metrics, logger);
        },
        onError(error) {
          metrics.increment('sync.operations_inspect_error');
          logger.warn({ error: redactSensitiveText(error) }, 'Sync operations inspection failed');
        },
      });
      await publishSyncStatus();
      syncOperationsTimer = setInterval(() => { void publishSyncStatus(); }, 30_000);
      syncOperationsTimer.unref();
      if (receiptMaintenance && !receiptPurgeSchedule) {
        receiptPurgeSchedule = schedulePublisherReceiptPurge(
          receiptMaintenance,
          {
            intervalMs: config.publisherReceipts.cleanupIntervalMs,
            batchSize: config.publisherReceipts.cleanupBatchSize,
            onPurged(count) {
              metrics.increment('publisher.receipt_cleanup_runs');
              metrics.increment('publisher.receipt_purged', count);
              metrics.observe('publisher.receipt_cleanup_batch', count);
            },
            onError(error) {
              metrics.increment('publisher.receipt_cleanup_error');
              logger.warn({ error: redactSensitiveText(error) }, 'Publisher receipt cleanup failed');
            },
          },
        );
      }
      if (insightMaintenance && !insightPurgeSchedule) {
        insightPurgeSchedule = schedulePublicationInsightPurge(
          insightMaintenance,
          {
            intervalMs: config.publicationInsightRetention.cleanupIntervalMs,
            batchSize: config.publicationInsightRetention.cleanupBatchSize,
            onPurged(counts) {
              metrics.increment('publication.insight_cleanup_runs');
              metrics.increment('publication.insight_purged_events', counts.events);
              metrics.increment('publication.insight_purged_daily', counts.daily);
              metrics.observe(
                'publication.insight_cleanup_batch',
                counts.events + counts.daily,
              );
            },
            onError(error) {
              metrics.increment('publication.insight_cleanup_error');
              logger.warn({ error: redactSensitiveText(error) }, 'Publication insight cleanup failed');
            },
          },
        );
      }
      if (inviteCleanup && !inviteCleanupSchedule) {
        inviteCleanupSchedule = scheduleCollaborationInviteCleanup(
          inviteCleanup,
          {
            intervalMs: config.collaborationInviteCleanup.cleanupIntervalMs,
            batchSize: config.collaborationInviteCleanup.cleanupBatchSize,
            onExpired(count) {
              metrics.increment('collaboration.invite_cleanup_runs');
              metrics.increment('collaboration.invite_expired', count);
              metrics.observe('collaboration.invite_cleanup_batch', count);
            },
            onError(error) {
              metrics.increment('collaboration.invite_cleanup_error');
              logger.warn({ error: redactSensitiveText(error) }, 'Collaboration invite cleanup failed');
            },
          },
        );
      }
      tombstonePurgeJob?.start();
      evidenceMaintenanceJob?.start();
      mcpWriteMaintenanceJob?.start();
      // Sanitized capacity only — never log DATABASE_URL or credentials.
      logger.info({
        service: 'worker',
        outboxProjectionRoutes: durability.routeCount,
        outboxProjectionAllDurable: durability.allDurable,
        publicationCachePurgeRoutes: durability.publicationCachePurge.routeCount,
        publicationCachePurgeRouteDurable: durability.publicationCachePurge.allDurable,
        reportsOutboxRoutes: durability.reportPublicSurfacePurge.routeCount,
        reportsOutboxRoutesDurable: durability.reportPublicSurfacePurge.allDurable,
        projectionSinkDurability: projectionSink?.durability ?? 'none',
        attachmentsVerificationRoutes: attachmentsComposition === undefined ? 0 : 1,
        attachmentsCleanupScheduler: attachmentsComposition === undefined ? 'off' : 'on',
        cacheMode: config.cache.redis.mode,
        cacheReadiness: cacheReadinessState,
        capacity,
        concurrency: outbox?.concurrencyReadiness() ?? null,
      }, 'worker started');
    },
    async stop() {
      const failures: WorkerStopFailure[] = [];
      if (notificationOperationsTimer) clearInterval(notificationOperationsTimer);
      notificationOperationsTimer = undefined;
      if (syncOperationsTimer) clearInterval(syncOperationsTimer);
      syncOperationsTimer = undefined;
      await attemptWorkerStop(failures, 'tombstonePurgeJob', () => tombstonePurgeJob?.stop());
      await attemptWorkerStop(failures, 'evidenceMaintenanceJob', () => evidenceMaintenanceJob?.stop());
      await attemptWorkerStop(failures, 'mcpWriteMaintenanceJob', () => mcpWriteMaintenanceJob?.stop());
      await attemptWorkerStop(failures, 'receiptPurgeSchedule', async () => {
        await receiptPurgeSchedule?.stop();
        receiptPurgeSchedule = undefined;
      });
      await attemptWorkerStop(failures, 'insightPurgeSchedule', async () => {
        await insightPurgeSchedule?.stop();
        insightPurgeSchedule = undefined;
      });
      await attemptWorkerStop(failures, 'inviteCleanupSchedule', async () => {
        await inviteCleanupSchedule?.stop();
        inviteCleanupSchedule = undefined;
      });
      // Stop the report scheduler before draining outbox handlers. Otherwise
      // a connector can append fresh runs/events while the outbox is already
      // shutting down, leaving work stranded behind the drain boundary.
      await attemptWorkerStop(failures, 'outbox', () => outbox?.stop());
      await attemptWorkerStop(failures, 'indexNowPublisher', () => indexNowPublisher?.close());
      // P4A-P05: stop the sampler and drain the in-flight cleanup batch AFTER
      // the outbox loop drained, so no new verification claims race cleanup.
      await attemptWorkerStop(failures, 'attachmentsComposition', () => attachmentsComposition?.stop());
      await attemptWorkerStop(failures, 'emailDeliveryLoop', () => emailDeliveryRuntime?.loop.stop());
      await attemptWorkerStop(failures, 'linkHealthLoop', () => linkHealthRuntime?.loop.stop());
      await attemptWorkerStop(failures, 'readableReplicaLoop', () => readableReplicaRuntime?.loop.stop());
      await attemptWorkerStop(failures, 'linkPreviewLoop', () => linkPreviewRuntime?.stop());
      await attemptWorkerStop(failures, 'exportJobLoop', () => exportJobRuntime?.loop.stop());
      await attemptWorkerStop(failures, 'faviconJobsLoop', () => faviconJobsRuntime?.jobs.stop());
      await attemptWorkerStop(failures, 'faviconGcLoop', () => faviconJobsRuntime?.gc.stop());
      await attemptWorkerStop(failures, 'ledgerArchive', () => ledgerArchiveRuntime?.stop());
      await attemptWorkerStop(failures, 'emailDeliveryProvider', () => emailDeliveryRuntime?.provider.close());
      // C1 auth email surface lifecycle (DirectMail adapter owned by the
      // composition; the unavailable sender and mailbox sink close as no-ops).
      await attemptWorkerStop(failures, 'authEmailComposition', () => authEmailComposition?.close());
      await attemptWorkerStop(failures, 'inviteEmailComposition', () => inviteEmailComposition?.close());
      // T11: release the worker-owned Redis client only after outbox stop() has
      // stopped claiming new tasks and drained in-flight delivery; idempotent.
      await attemptWorkerStop(failures, 'workerCacheComposition', () => workerCacheComposition.close());
      await attemptWorkerStop(failures, 'mcpReadChangeSignalSource', () => mcpReadChangeSignalSource?.close?.());
      await attemptWorkerStop(failures, 'database', () => database?.close());
      if (failures.length > 0) {
        throw new AggregateError(
          failures.map(({ error }) => error),
          `Worker runtime stop failed: ${failures.map(({ resource }) => resource).join(', ')}`,
        );
      }
      logger.info({ service: 'worker' }, 'worker stopped');
    },
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const processLogger = createLogger(process.env.LOG_LEVEL?.trim() || 'info');
  registerFatalProcessHandlers({ logger: processLogger });
  const config = loadConfig();
  const database = createDatabaseRuntime(config.databaseUrl, {
    maxConnections: config.database.maxConnections,
    connectionTimeoutMs: config.database.connectionTimeoutMs,
    idleTimeoutMs: config.database.idleTimeoutMs,
    statementTimeoutMs: config.database.statementTimeoutMs,
    lockTimeoutMs: config.database.lockTimeoutMs,
    idleTransactionTimeoutMs: config.database.idleTransactionTimeoutMs,
    applicationName: 'known-worker',
    production: config.nodeEnv === 'production',
    ssl: config.databaseSsl,
  });
  const mcpReadChangeSignalSource = config.mcp
    ? createPostgresMcpChangeSignalSource({
        pool: database.pool,
        channel: createPostgresMcpChangeSignalChannel(config.mcp.serverUuid),
      })
    : undefined;
  // P4A-P05: resolve the attachments R2 secrets through the configured secret
  // references (values arrive as ATTACHMENTS_R2_<REF_SUFFIX>_ACCESS_KEY_ID /
  // _SECRET_ACCESS_KEY env vars; the refs name which secret, never a value).
  const attachmentsObjectStorage = config.attachments
    ? await composeAttachmentsObjectStorage(config.attachments, resolveWorkerAttachmentSecret)
    : undefined;
  // FO-02: the favicon worker shares the attachments/avatar R2 storage the API
  // uses (same bucket, isolated FAVICON_R2_PREFIX). Enabled feature without
  // storage fails closed at startup.
  const faviconObjectStore = config.faviconPolicy.enabled
    ? await composeFaviconObjectStore(config, resolveWorkerAttachmentSecret)
    : undefined;
  if (config.faviconPolicy.enabled && faviconObjectStore === undefined) {
    throw new Error(
      'worker composition refused: KNOWN_FEATURE_FAVICON_POLICY enabled requires favicon object storage',
    );
  }
  const linkPreviewStore = await composeLinkPreviewWorkerStore(config, resolveWorkerAttachmentSecret);
  const linkHealthProbe = linkHealthProbeInjectionFromEnv(process.env, config.nodeEnv);
  const metrics = new InMemoryMetrics();
  const metricsServer = createPrometheusMetricsServer({
    metrics,
    host: process.env.WORKER_METRICS_HOST?.trim() || '127.0.0.1',
    port: parseMetricsPort(process.env.WORKER_METRICS_PORT),
  });
  const worker = buildWorker(config, database, metrics, {
    logger: processLogger,
    mcpReadChangeSignalSource,
    ...(attachmentsObjectStorage === undefined ? {} : { attachmentsObjectStorage }),
    ...(linkPreviewStore === undefined ? {} : { linkPreview: { store: linkPreviewStore } }),
    ...(linkHealthProbe === undefined ? {} : { linkHealth: linkHealthProbe }),
    ...(faviconObjectStore === undefined ? {} : { favicon: { store: faviconObjectStore } }),
  });
  // Serialize shutdown with startup: stop() waits for start() to settle so a
  // signal during startup can never close the database under the pending
  // startup queries (which would surface as a misleading "start failed" and
  // exit 1 after an otherwise clean stop).
  let stopRequested = false;
  let stopPromise: Promise<void> | undefined;
  const removeSignalHandlers = registerGracefulShutdown({
    stop() {
      stopPromise ??= (async () => {
        stopRequested = true;
        if (startPromise) await startPromise;
        // The worker owns its provider clients; release them after the outbox
        // loop and cleanup scheduler have fully drained.
        await closeWorkerProcessResources({ metricsServer, worker, attachmentsObjectStorage, faviconObjectStore });
      })();
      return stopPromise;
    },
  }, {
    onError: (error) => processLogger.error(
      { event: 'graceful_shutdown_failure', error },
      'worker graceful shutdown failed',
    ),
    deadlineMs: DEFAULT_GRACEFUL_SHUTDOWN_DEADLINE_MS,
  });
  let startPromise: Promise<void> | undefined;
  startPromise = worker.start().then(async () => { await metricsServer.start(); }).catch(async (error: unknown) => {
    removeSignalHandlers();
    if (!stopRequested) {
      try {
        await closeWorkerProcessResources({ metricsServer, worker, attachmentsObjectStorage, faviconObjectStore });
      } catch (cleanupError: unknown) {
        error = new AggregateError(
          [error, cleanupError],
          'Worker startup failed and process cleanup also failed',
        );
      }
    }
    reportFatalProcessError(processLogger, 'startup_failure', error);
    process.exitCode = 1;
  });
}
/**
 * P4A-P05 worker CLI secret resolver: maps each configured R2 secret REF to
 * env vars named after the ref suffix (e.g. ref `known/prod/r2/ro` reads
 * `ATTACHMENTS_R2_RO_ACCESS_KEY_ID` / `ATTACHMENTS_R2_RO_SECRET_ACCESS_KEY`).
 * Fails closed when the ref is unknown or the values are missing.
 */
async function resolveWorkerAttachmentSecret(ref: string): Promise<ResolvedR2Secret> {
  const suffix = ref.split('/').filter(Boolean).pop()
    ?.replace(/[^A-Za-z0-9]/g, '_').toUpperCase() ?? '';
  if (suffix.length === 0) throw new Error(`worker composition refused: invalid R2 secret ref ${ref}`);
  const accessKeyId = process.env[`ATTACHMENTS_R2_${suffix}_ACCESS_KEY_ID`]?.trim();
  const secretAccessKey = process.env[`ATTACHMENTS_R2_${suffix}_SECRET_ACCESS_KEY`]?.trim();
  if (!accessKeyId || !secretAccessKey) {
    throw new Error(
      `worker composition refused: ATTACHMENTS_R2_${suffix}_ACCESS_KEY_ID / `
      + `ATTACHMENTS_R2_${suffix}_SECRET_ACCESS_KEY are required to resolve ${ref}`,
    );
  }
  return { accessKeyId, secretAccessKey };
}
