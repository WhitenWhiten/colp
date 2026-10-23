import { activityAgentRegistration, createActivityAgentRoute, purgeActivity, setAgentActivityEnabled } from '../infrastructure/activity/index.js';
import { createAutomationIngestRoute, createAutomationManualRoute, automationManualRegistration, automationIngestRegistration, automationResumeRegistration, AUTOMATION_RESUME_EVENT } from '../infrastructure/outbox/index.js';
import { createAutomationSourceInspector, createManualRunConsumer, createAutomationRuntime, setAutomationCaptureEnabled } from '../infrastructure/automation/index.js';
import { createAutomationHealthMonitor } from '../infrastructure/automation/index.js';
import { createAutomationBindingVerifier } from './automation-binding-verifier.js';
import { composeWorkerAutomationMaintenance } from './worker-automation-maintenance.js';
import { createMcpSecurityEpochReader } from './api-mcp-oauth-composition.js';
import { createPostgresMcpOauthRevocationStore } from '../infrastructure/database/index.js';
import { createDatabaseFaviconStore, FaviconProviderCache } from '../infrastructure/collections/index.js';
import { loadSharedFaviconConfig } from './config-favicon-shared.js';
import { SharedFaviconCache } from '../infrastructure/collections/favicon-shared-cache.js';
import { createScheduledFaviconFetcher } from '../infrastructure/collections/favicon-provider-scheduler.js';
import { composeFaviconObjectStore } from './public-object-storage-composition.js';
import { createFaviconWorkerRuntime, createPostgresFaviconJobWorkerRepository,
  createPostgresFaviconJobWorkerUnitOfWork, createPostgresFaviconGcRepository,
  defaultFaviconDecompressedBudget, fetchFaviconImage, type FaviconWorkerRuntime,
} from '../infrastructure/collections/index.js';
import { composeProductionOutboxProjectionRoutes,resolveProductionProjectionSink } from './worker-projection-composition.js';
export { composeProductionOutboxProjectionRoutes,resolveProductionProjectionSink } from './worker-projection-composition.js';
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
import { createPostgresReplicaLifecycleService, ReplicaExpiryJob, PostgresSyncEvidenceMaintenanceCoordinator, PostgresSyncTombstonePurgeCoordinator, SyncEvidenceMaintenanceJob, SyncTombstonePurgeJob } from '../infrastructure/sync/index.js';
import {
  type CacheReadinessState,
  type CacheStore,
  type RedisCacheConnectionConfig,
  type RedisClientLike,
  type RedisClientOptions,
} from '../infrastructure/cache/index.js';
import { createPostgresPublisherReceiptMaintenancePortFactory } from '../infrastructure/publisher/index.js';
import {
  schedulePublisherReceiptPurge,
  PUBLISHER_MIN_REPLAY_WINDOW_SECONDS,
  type PublisherReceiptMaintenancePortFactory,
  type PublisherReceiptPurgeSchedule,
} from '../modules/publisher/index.js';
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
  createPostgresReportInvalidationCursorStore,
  createReportCacheInvalidationRoutes,
  type CollectionMutationProjectionSink,
  type PublicationCachePurgeProvider,
  type PublicationCachePurgeReadinessState,
  type OutboxWorker,
} from '../infrastructure/outbox/index.js';
import {
  composePublicationCachePurgeRoutes,
  resolvePublicationCachePurgeProvider,
} from './publication-cache-purge-composition.js';
import { isReportCacheInvalidationEnabled } from './report-cache-enablement.js';
export { resolvePublicationCachePurgeProvider } from './publication-cache-purge-composition.js';
import {
  createLinkHealthWorkerRuntime,
  createPostgresLinkHealthWorkerRepository,
  linkHealthProbeInjectionFromEnv,
  type LinkHealthWorkerLoopOptions,
  type LinkHealthWorkerRuntime,
  createDatabaseLinkPreviewStore,
  createLinkPreviewWorkerRuntime,
  createPostgresLinkPreviewRepository,
  linkPreviewEgressFromEnv,
  type LinkPreviewWorkerLoopOptions,
  type LinkPreviewWorkerRuntime,
} from '../infrastructure/collections/index.js';
import { createPostgresInviteEmailDeliveryRepository } from '../infrastructure/access-policy/index.js';
import { createPostgresCollaborationInviteMaintenancePortFactory } from '../infrastructure/access-policy/index.js';
import { buildInviteLoginUrl, processOne, scheduleCollaborationInviteCleanup,
  type CollaborationInviteCleanupSchedule,
  type CollaborationInviteMaintenancePortFactory } from '../modules/access-policy/index.js';
import {
  composeAuthEmailAdapter,
  composeInviteEmailAdapter,
  type AuthEmailAdapter,
  type AuthEmailComposition,
  type InviteEmailAdapter,
  type InviteEmailComposition,
} from '../infrastructure/email/index.js';
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
import { composeLedgerArchiveWorker } from './ledger-archive-worker-composition.js';
import type { LedgerArchiveExportWorkerRuntime } from '../infrastructure/ledger-archive/index.js';
import type { LedgerArchiveSourceResolver } from './ledger-archive-worker-composition.js';
import type { BookmarkFaviconObjectStore, LinkPreviewObjectStore } from '../modules/collections/index.js';
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
  /**
   * T11 live Redis cache readiness fact for the worker
   * (disabled/degraded/healthy). mode=off always reports disabled; shadow/serve
   * probe the worker-owned store health and refresh the readiness gauge.
   */
  cacheReadiness(): Promise<CacheReadinessState>;
  /** LH-02 optional link-health probe worker, composed only when the feature is enabled. */
  readonly linkHealth?: LinkHealthWorkerRuntime;
  /** LP-03 link preview fetch loop, composed only when the feature is enabled. */
  readonly linkPreview?: LinkPreviewWorkerRuntime;
  readonly faviconJobs?: FaviconWorkerRuntime;
  readonly ledgerArchive?: LedgerArchiveExportWorkerRuntime;
  /**
   * C1 auth email surface (plan §9 Task C1); present only when
   * AUTH_EMAIL_ENABLED=true. Test mode composes the in-process mailbox sink;
   * any other environment composes the DirectMail adapter (fail closed on
   * missing credentials). Never touches the notification worker semantics.
   */
  readonly authEmail?: { readonly sender: AuthEmailAdapter };
  /** Credential-free capacity snapshot used for startup telemetry/readiness. */
  readonly capacity: ReturnType<typeof sanitizedRuntimeCapacity>;
  start(): Promise<void>;
  stop(): Promise<void>;
}
export interface WorkerProcessResources {
  readonly metricsServer: { close(): Promise<void> };
  readonly worker: { stop(): Promise<void> };
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
  /** Optional overdue-invite expiry adapter for deterministic lifecycle composition tests. */
  readonly inviteCleanup?: CollaborationInviteMaintenancePortFactory;
  /** Optional Sync operations inspect seam so inspection failures stay unit-testable. */
  readonly syncOperations?: {
    inspect(): Promise<Parameters<typeof publishSyncOperationalTelemetry>[0]>;
  };
  readonly logger?: ReturnType<typeof createLogger>;
  /**
   * LH-02 link-health probe injection. Tests supply `connect` + `resolve` so
   * the worker never opens a real socket. Production omits this and uses the
   * hardened egress defaults (HTTPS still only in infrastructure/collections).
   */
  readonly linkHealth?: Pick<LinkHealthWorkerLoopOptions, 'resolve' | 'connect'>;
  /** LP-03 link preview seam: tests inject a store and egress fakes. */
  readonly linkPreview?: Partial<Pick<LinkPreviewWorkerLoopOptions, 'resolve' | 'connect'>> & {
    readonly store?: LinkPreviewObjectStore;
  };
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
  readonly ledgerArchiveSourceResolver?: LedgerArchiveSourceResolver;
  readonly ledgerArchiveWorkerId?: string;
  /**
   * When false, stop() leaves the database open. The self-hosted process
   * shares one pool and closes it after the API stops.
   */
  readonly closeDatabase?: boolean;
}
function composeFaviconWorkerRuntime(
  config: AppConfig,
  database: DatabaseRuntime,
  metrics: Metrics,
  logger: ReturnType<typeof createLogger>,
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
  const cached = new FaviconProviderCache(database.pool, scheduledFetch, sharedConfig.refreshIntervalMs);
  const shared = new SharedFaviconCache(database.pool, store, cached.fetch, {
    fetchCacheExpiry: cached.expiresAt,
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
    maintainSharedCache: async () => {
      await cached.collectExpired();
      return shared.runOnce();
    },
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
export function buildWorker(
  config: AppConfig = loadConfig(),
  database?: DatabaseRuntime,
  metrics: Metrics = new InMemoryMetrics(),
  options: BuildWorkerOptions = {},
): WorkerRuntime {
  const logger: ReturnType<typeof createLogger> = options.logger ?? createLogger(config.logLevel);
  setAutomationCaptureEnabled(config.automationCaptureEnabled === true);
  setAgentActivityEnabled(config.agentActivityEnabled === true);
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
  // Production requires a durable PostgreSQL projection; transient sinks are refused.
  const originalProjectionSink = resolveProductionProjectionSink({
    database,
    projectionSink: options.projectionSink,
  });
  const automationHealth = config.automationRulesEnabled && database
    ? createAutomationHealthMonitor(database.db, config.publication.serverUuid, metrics, config.automationAdmissionEnabled, {
      eventsEnabled:config.mcpEventsEnabled === true,workerEnabled: config.automationWorkEnabled === true,
      verifyTargetBinding: createAutomationBindingVerifier(config,createMcpSecurityEpochReader(config,createPostgresMcpOauthRevocationStore({ db: database.db }))),
    }) : undefined;
  // Capture alone (shadow mode) still needs the facts retention sweep.
  const automationMaintenance = (config.automationRulesEnabled || config.automationCaptureEnabled) && database
    ? composeWorkerAutomationMaintenance(config, database.db, metrics) : undefined;
  const baseProjectionSink = originalProjectionSink && automationHealth ? automationHealth.wrap(originalProjectionSink) : originalProjectionSink;
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
    reportCacheEnabled: isReportCacheInvalidationEnabled(config),
    ...(options.createCacheStore === undefined ? {} : { createStore: options.createCacheStore }),
    ...(options.createCacheClient === undefined ? {} : { createClient: options.createCacheClient }),
    ...(options.cacheCloseTimeoutMs === undefined ? {} : { closeTimeoutMs: options.cacheCloseTimeoutMs }),
  });
  const publicationCachePurgeProvider = workerCacheComposition.publicationCachePurgeProvider
    ?? cdnPublicationCachePurgeProvider;
  const publicationCachePurgeRoutes = composePublicationCachePurgeRoutes({
    provider: publicationCachePurgeProvider,
    config,
    database,
    handlerTimeoutMs: capacity.worker.handlerTimeoutMs,
    metrics,
  });
  const syncConflictRoutes = database
    ? Object.freeze([createSyncConflictOutboxRoute(database.pool)])
    : Object.freeze([]);
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
  const routes = Object.freeze([
    ...projectionRoutes, ...syncConflictRoutes,
    ...(database ? [createActivityAgentRoute(database.db)] : []),
    ...(database ? [undefined, AUTOMATION_RESUME_EVENT].map(eventType => createAutomationIngestRoute(createAutomationSourceInspector(database.db,
      // Shadow capture (admission off) only advances the source cursor: no account or Sync locks.
      config.automationAdmissionEnabled ? createAutomationRuntime(config.publication.serverUuid,config.automationWorkEnabled === true) : null), eventType)) : []),
    ...(database ? [createAutomationManualRoute(createManualRunConsumer(database.db, config.publication.serverUuid,
      { runtimeEnabled: config.automationAdmissionEnabled === true, workerEnabled: config.automationWorkEnabled === true }))] : []),
    ...publicationCachePurgeRoutes,
    ...collectionInviteEmailRoutes,
    ...(database && workerCacheComposition.reportCacheInvalidator
      ? createReportCacheInvalidationRoutes({
        invalidator: workerCacheComposition.reportCacheInvalidator,
        store: createPostgresReportInvalidationCursorStore(database.db),
      })
      : []),
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
      ...createCollectionMutationEnvelopeRegistrations(),
      syncConflictEnvelopeRegistration,
      activityAgentRegistration,
      automationIngestRegistration,
      automationResumeRegistration,
      automationManualRegistration,
      collectionInviteCreatedEnvelopeRegistration,
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
  const inviteCleanup = options.inviteCleanup
    ?? (database ? createPostgresCollaborationInviteMaintenancePortFactory(database.db) : undefined);
  let inviteCleanupSchedule: CollaborationInviteCleanupSchedule | undefined;
  let activityRetentionTimer: NodeJS.Timeout | undefined;
  let syncOperationsTimer: NodeJS.Timeout | undefined;
  const syncOperationsInspectionGate = { running: false };
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
  const linkPreviewRuntime = (database && config.linkPreview?.enabled === true)
    ? createLinkPreviewWorkerRuntime({
        repository: createPostgresLinkPreviewRepository(database.pool, { cancelBackend: database.cancelBackend }),
        store: options.linkPreview?.store ?? createDatabaseLinkPreviewStore(database.db),
        logger,
        metrics,
        retentionSeconds: config.linkPreview.retentionSeconds,
        concurrency: config.linkPreview.workerConcurrency,
        perHostGapMs: config.linkPreview.perHostGapMs,
        ...(options.linkPreview?.resolve === undefined ? {} : { resolve: options.linkPreview.resolve }),
        ...(options.linkPreview?.connect === undefined ? {} : { connect: options.linkPreview.connect }),
      })
    : undefined;
  const faviconJobsRuntime = (database && config.faviconPolicy.enabled)
    ? composeFaviconWorkerRuntime(config, database, metrics, logger, options)
    : undefined;
  const ledgerArchiveRuntime = composeLedgerArchiveWorker({
    config: config.ledgerArchive,
    database,
    ...(options.ledgerArchiveSourceResolver === undefined
      ? {} : { resolveSource: options.ledgerArchiveSourceResolver }),
    ...(options.ledgerArchiveWorkerId === undefined ? {} : { workerId: options.ledgerArchiveWorkerId }),
    logger,
  });
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
  const replicaExpiryJob = database && (config.syncSession || config.syncTombstonePurge.enabled)
    ? new ReplicaExpiryJob(createPostgresReplicaLifecycleService(database.db), {
      intervalMs: 60_000, batchSize: 500,
      onResult(count) { metrics.increment('sync.replica_expiry.expired', count); },
      onError() {
        metrics.increment('sync.replica_expiry.errors');
        logger.warn({ code: 'replica_expiry_failed' }, 'Sync Replica expiry failed');
      },
    }) : undefined;
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
        batchSize: config.syncEvidenceMaintenance.batchSize,
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
    linkHealth: linkHealthRuntime,
    linkPreview: linkPreviewRuntime,
    faviconJobs: faviconJobsRuntime,
    ledgerArchive: ledgerArchiveRuntime,
    ...(authEmailComposition === undefined ? {} : { authEmail: { sender: authEmailComposition.sender } }),
    projectionSink,
    publicationCachePurgeProvider,
    cacheReadiness: workerCacheReadiness,
    capacity,
    async start() {
      await database?.verifyReady();
      await automationHealth?.revalidateAll();
      // Re-assert durability at start so miscomposed runtimes fail closed before polling.
      if (outbox) {
        const readiness = outbox.projectionReadiness();
        if (
          !readiness.allDurable
          || readiness.acknowledgesTransientSideEffects
          || readiness.routeCount < 1
          || (config.nodeEnv === 'production'
            && process.env.KNOWN_EDITION !== 'self-hosted'
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
      // Validate scheduler dependencies before starting any worker timers.
      if (database && !activityRetentionTimer) activityRetentionTimer = setInterval(() => {
        void purgeActivity(database.db).catch((error: unknown) => logger.warn({ err: error }, 'activity retention failed'));
      }, 3_600_000);
      activityRetentionTimer?.unref();
      automationMaintenance?.start();
      outbox?.start();
      linkHealthRuntime?.loop.start();
      linkPreviewRuntime?.loop.start();
      faviconJobsRuntime?.jobs.start();
      faviconJobsRuntime?.gc.start();
      ledgerArchiveRuntime?.start();
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
      replicaExpiryJob?.start();
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
        cacheMode: config.cache.redis.mode,
        cacheReadiness: cacheReadinessState,
        capacity,
        concurrency: outbox?.concurrencyReadiness() ?? null,
      }, 'worker started');
    },
    async stop() {
      const failures: WorkerStopFailure[] = [];
      await attemptWorkerStop(failures, 'automationMaintenance', () => automationMaintenance?.stop());
      if (activityRetentionTimer) clearInterval(activityRetentionTimer);
      activityRetentionTimer = undefined;
      if (syncOperationsTimer) clearInterval(syncOperationsTimer);
      syncOperationsTimer = undefined;
      await attemptWorkerStop(failures, 'replicaExpiryJob', () => replicaExpiryJob?.stop());
      await attemptWorkerStop(failures, 'tombstonePurgeJob', () => tombstonePurgeJob?.stop());
      await attemptWorkerStop(failures, 'evidenceMaintenanceJob', () => evidenceMaintenanceJob?.stop());
      await attemptWorkerStop(failures, 'mcpWriteMaintenanceJob', () => mcpWriteMaintenanceJob?.stop());
      await attemptWorkerStop(failures, 'receiptPurgeSchedule', async () => {
        await receiptPurgeSchedule?.stop();
        receiptPurgeSchedule = undefined;
      });
      await attemptWorkerStop(failures, 'inviteCleanupSchedule', async () => {
        await inviteCleanupSchedule?.stop();
        inviteCleanupSchedule = undefined;
      });
      // Stop the report scheduler before draining outbox handlers. Otherwise
      // a connector can append fresh runs/events while the outbox is already
      // shutting down, leaving work stranded behind the drain boundary.
      await attemptWorkerStop(failures, 'outbox', () => outbox?.stop());
      await attemptWorkerStop(failures, 'linkHealthLoop', () => linkHealthRuntime?.loop.stop());
      await attemptWorkerStop(failures, 'linkPreviewLoop', () => linkPreviewRuntime?.loop.stop());
      await attemptWorkerStop(failures, 'faviconJobsLoop', () => faviconJobsRuntime?.jobs.stop());
      await attemptWorkerStop(failures, 'faviconGcLoop', () => faviconJobsRuntime?.gc.stop());
      await attemptWorkerStop(failures, 'ledgerArchive', () => ledgerArchiveRuntime?.stop());
      // C1 auth email surface lifecycle (DirectMail adapter owned by the
      // composition; the unavailable sender and mailbox sink close as no-ops).
      await attemptWorkerStop(failures, 'authEmailComposition', () => authEmailComposition?.close());
      await attemptWorkerStop(failures, 'inviteEmailComposition', () => inviteEmailComposition?.close());
      // T11: release the worker-owned Redis client only after outbox stop() has
      // stopped claiming new tasks and drained in-flight delivery; idempotent.
      await attemptWorkerStop(failures, 'workerCacheComposition', () => workerCacheComposition.close());
      await attemptWorkerStop(failures, 'mcpReadChangeSignalSource', () => mcpReadChangeSignalSource?.close?.());
      if (options.closeDatabase !== false) {
        await attemptWorkerStop(failures, 'database', () => database?.close());
      }
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
export interface CreateWorkerProcessOptions {
  readonly logger?: ReturnType<typeof createLogger>;
  /** Default true. Self-hosted passes false so the shared pool outlives the worker. */
  readonly closeDatabase?: boolean;
  readonly env?: NodeJS.ProcessEnv;
}
export interface WorkerProcessHandle {
  readonly worker: WorkerRuntime;
  start(): Promise<void>;
  stop(): Promise<void>;
}

/** Same production wiring the worker entry uses, on a caller-supplied pool. */
export async function createWorkerProcess(
  config: AppConfig,
  database: DatabaseRuntime,
  options: CreateWorkerProcessOptions = {},
): Promise<WorkerProcessHandle> {
  const env = options.env ?? process.env;
  const logger = options.logger ?? createLogger(config.logLevel);
  const mcpReadChangeSignalSource = config.mcp
    ? createPostgresMcpChangeSignalSource({
        pool: database.pool,
        channel: createPostgresMcpChangeSignalChannel(config.mcp.serverUuid),
      })
    : undefined;
  const linkHealthProbe = linkHealthProbeInjectionFromEnv(env, config.nodeEnv);
  const linkPreviewEgress = linkPreviewEgressFromEnv(env, config.nodeEnv);
  const metrics = new InMemoryMetrics();
  const faviconObjectStore = config.faviconPolicy.enabled
    ? (await composeFaviconObjectStore(config)) ?? createDatabaseFaviconStore(database.db)
    : undefined;
  const metricsServer = createPrometheusMetricsServer({
    metrics,
    host: env.WORKER_METRICS_HOST?.trim() || '127.0.0.1',
    port: parseMetricsPort(env.WORKER_METRICS_PORT),
  });
  let worker: WorkerRuntime;
  try {
    worker = buildWorker(config, database, metrics, {
      ...(faviconObjectStore === undefined ? {} : { favicon: { store: faviconObjectStore } }),
      logger,
      closeDatabase: options.closeDatabase,
      mcpReadChangeSignalSource,
      ...(linkHealthProbe === undefined ? {} : { linkHealth: linkHealthProbe }),
      ...(linkPreviewEgress === undefined ? {} : { linkPreview: linkPreviewEgress }),
    });
  } catch (error) {
    await mcpReadChangeSignalSource?.close?.();
    await faviconObjectStore?.close?.();
    throw error;
  }
  return {
    worker,
    async start() {
      await worker.start();
      await metricsServer.start();
    },
    async stop() {
      await closeWorkerProcessResources({ metricsServer, worker, faviconObjectStore });
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
  const handle = await createWorkerProcess(config, database, { logger: processLogger });
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
        await handle.stop();
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
  startPromise = handle.start().catch(async (error: unknown) => {
    removeSignalHandlers();
    if (!stopRequested) {
      try {
        await handle.stop();
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
