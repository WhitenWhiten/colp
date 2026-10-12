import type { AppConfig, SanitizedRuntimeCapacity } from './config-types.js';
import { sanitizeLedgerArchiveRuntimeConfig } from './config-ledger-archive.js';
import { sanitizeLedgerArchiveReaderRuntimeConfig } from './config-ledger-archive-reader.js';

/**
 * Credential-free capacity snapshot for startup logs and readiness probes.
 * Never includes DATABASE_URL, secrets, or connection userinfo.
 *
 * API and worker share DATABASE_POOL_MAX (default 10; the self-hosted edition
 * defaults it to 12). The self-hosted worker reserves at most 9 connections:
 * the outbox, 2 link-health probes, 2 favicon jobs, 2 favicon cleanup tasks
 * and 2 link preview fetches, which leaves the API 3.
 */
export const SHARED_POOL_WORKER_RESERVE_MAX = 9;

export function workerReservedConnections(config: AppConfig): number {
  return config.worker.concurrency
    + (config.reports.schedulerEnabled ? 1 : 0)
    + (config.linkHealth.enabled ? config.linkHealth.workerConcurrency : 0)
    + (config.faviconPolicy.enabled ? 2 * config.faviconPolicy.jobConcurrency : 0)
    + (config.linkPreview?.enabled === true ? config.linkPreview.workerConcurrency : 0)
    + (config.ledgerArchive.enabled ? config.ledgerArchive.concurrency : 0);
}

function assertSharedPoolWorkerReserve(reserved: number): void {
  if (process.env.KNOWN_EDITION === 'self-hosted' && reserved > SHARED_POOL_WORKER_RESERVE_MAX) {
    throw new Error(
      `worker reserves ${reserved} connections on the shared pool, which exceeds the cap of ${SHARED_POOL_WORKER_RESERVE_MAX}`,
    );
  }
}

export function sanitizedRuntimeCapacity(config: AppConfig): SanitizedRuntimeCapacity {
  const reserved = workerReservedConnections(config);
  assertSharedPoolWorkerReserve(reserved);
  if (reserved >= config.database.maxConnections) {
    throw new Error('worker reserve must leave at least one database connection for API requests');
  }
  return Object.freeze({
    database: Object.freeze({ ...config.database }),
    worker: Object.freeze({ ...config.worker }),
    workerReservedConnections: reserved,
    cache: Object.freeze({
      mode: config.cache.redis.mode,
      required: config.cache.redis.required,
      keyPrefix: config.cache.redis.keyPrefix,
      commandTimeoutMs: config.cache.redis.commandTimeoutMs,
      connectTimeoutMs: config.cache.redis.connectTimeoutMs,
      maxRetriesPerRequest: config.cache.redis.maxRetriesPerRequest,
      maxEntryBytes: config.cache.limits.maxEntryBytes,
      lockTtlMs: config.cache.limits.lockTtlMs,
      publication: Object.freeze({
        metadataEnabled: config.cache.publication.metadataEnabled,
        directoryEnabled: config.cache.publication.directoryEnabled,
        snapshotEnabled: config.cache.publication.snapshotEnabled,
        metadata: Object.freeze({ ...config.cache.publication.metadata }),
        snapshot: Object.freeze({ ...config.cache.publication.snapshot }),
        directory: Object.freeze({ ...config.cache.publication.directory }),
      }),
      collectionBookmarkCountEnabled: config.cache.collection.bookmarkCountEnabled,
      collectionBookmarkCount: Object.freeze({ ...config.cache.collection.bookmarkCount }),
      reports: Object.freeze({
        metadataEnabled: config.cache.reports.metadataEnabled,
        issuesEnabled: config.cache.reports.issuesEnabled,
        directoryEnabled: config.cache.reports.directoryEnabled,
        metadata: Object.freeze({ ...config.cache.reports.metadata }),
        issues: Object.freeze({ ...config.cache.reports.issues }),
        directory: Object.freeze({ ...config.cache.reports.directory }),
      }),
    }),
    // FIX-L-001: startup summary records the explicit auth mode, never the secret.
    oidcClientAuthMode: config.oidc.clientAuthMode,
    ledgerArchive: sanitizeLedgerArchiveRuntimeConfig(config.ledgerArchive),
    ledgerArchiveReader: sanitizeLedgerArchiveReaderRuntimeConfig(config.ledgerArchiveReader),
  });
}

