import type { DatabaseRuntime } from '../infrastructure/database/index.js';
import {
  createPostgresReportOutboxConsumer,
  createReportsOutboxRoutes,
  RedisReportCacheInvalidator as RedisReportCacheInvalidatorClass,
  type OutboxRoute,
  type PublicSurfacePurgePort,
  type RedisReportCacheInvalidator,
} from '../infrastructure/outbox/index.js';
import { createPostgresDigestSchedulerStore } from '../infrastructure/reports/index.js';
import {
  composeReportsScheduler,
  type DigestScheduleConnector,
  type DigestSchedulerOptions,
  type ReportsSchedulerComposition,
} from '../modules/reports/index.js';
import type { AppConfig } from './config.js';
import type { SanitizedRuntimeCapacity } from './config-types.js';

export type { ReportsSchedulerComposition } from '../modules/reports/index.js';
export type { RedisReportCacheInvalidator } from '../infrastructure/outbox/index.js';
export { reportsEnvelopeRegistrations } from '../infrastructure/outbox/index.js';

export interface ReportsWorkerCompositionOptions {
  readonly config: AppConfig;
  readonly database?: DatabaseRuntime;
  readonly capacity: SanitizedRuntimeCapacity;
  readonly connector?: DigestScheduleConnector;
  readonly store?: DigestSchedulerOptions['store'];
  readonly ownerId?: string;
  readonly cacheInvalidator?: RedisReportCacheInvalidator;
  readonly publicSurfacePurge?: PublicSurfacePurgePort;
}

export interface ReportsWorkerComposition {
  readonly scheduler: ReportsSchedulerComposition;
  readonly outboxRoutes: readonly OutboxRoute[];
}

export function createReportsCacheInvalidator(options: {
  readonly store: import('../infrastructure/cache/index.js').CacheStore;
  readonly environment: string;
  readonly keyPrefix: string;
}): RedisReportCacheInvalidator {
  return new RedisReportCacheInvalidatorClass({
    store: options.store,
    key: { environment: options.environment, keyPrefix: options.keyPrefix },
  });
}

/** Compose all report-owned worker dependencies in one bounded seam. */
export function composeReportsWorker(
  options: ReportsWorkerCompositionOptions,
): ReportsWorkerComposition {
  const { config, database, capacity } = options;
  const store = options.store
    ?? (database && config.reports.schedulerEnabled
      ? createPostgresDigestSchedulerStore(database.pool)
      : undefined);
  const scheduler = composeReportsScheduler({
    enabled: config.reports.schedulerEnabled,
    connector: options.connector,
    store,
    ownerId: options.ownerId,
    concurrency: 1,
    pollIntervalMs: capacity.worker.pollIntervalMs,
    maxAttempts: config.reports.limits.maxAttempts,
    maxCatchUp: config.reports.limits.maxCatchUp,
    leaseMs: capacity.worker.leaseDurationMs,
    handlerTimeoutMs: capacity.worker.handlerTimeoutMs,
  });
  const outboxRoutes = database
    ? createReportsOutboxRoutes(createPostgresReportOutboxConsumer(database.pool, {
        ...(options.cacheInvalidator === undefined ? {} : { cacheInvalidator: options.cacheInvalidator }),
        ...(options.publicSurfacePurge === undefined ? {} : { publicSurfacePurge: options.publicSurfacePurge }),
      }))
    : Object.freeze([]);
  return { scheduler, outboxRoutes };
}

export function composeReportsSchedulerWorker(
  options: Pick<ReportsWorkerCompositionOptions, 'config' | 'database' | 'capacity' | 'connector' | 'store' | 'ownerId'>,
): ReportsSchedulerComposition {
  return composeReportsWorker(options).scheduler;
}

export function composeReportsOutboxRoutes(
  options: Pick<ReportsWorkerCompositionOptions, 'database' | 'cacheInvalidator' | 'publicSurfacePurge'>,
): readonly OutboxRoute[] {
  if (!options.database) return Object.freeze([]);
  return createReportsOutboxRoutes(createPostgresReportOutboxConsumer(options.database.pool, {
    ...(options.cacheInvalidator === undefined ? {} : { cacheInvalidator: options.cacheInvalidator }),
    ...(options.publicSurfacePurge === undefined ? {} : { publicSurfacePurge: options.publicSurfacePurge }),
  }));
}

export function publishReportsOutboxMetrics(
  metrics: { gauge(name: string, value: number): void },
  readiness: {
    readonly routeCount: number;
    readonly durableCount: number;
    readonly allDurable: boolean;
    readonly configured: boolean;
  },
): void {
  metrics.gauge('reports.outbox.routes', readiness.routeCount);
  metrics.gauge('reports.outbox.routes_durable', readiness.durableCount);
  metrics.gauge('reports.outbox.routes_all_durable', readiness.allDurable ? 1 : 0);
  metrics.gauge('reports.public_surface_purge.route_configured', readiness.configured ? 1 : 0);
  metrics.gauge('reports.public_surface_purge.route_durable', readiness.allDurable ? 1 : 0);
}
