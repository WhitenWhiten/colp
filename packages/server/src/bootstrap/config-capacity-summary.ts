import type { AppConfig, SanitizedRuntimeCapacity } from './config-types.js';
import { sanitizeLedgerArchiveRuntimeConfig } from './config-ledger-archive.js';
import { sanitizeLedgerArchiveReaderRuntimeConfig } from './config-ledger-archive-reader.js';

/**
 * Credential-free capacity snapshot for startup logs and readiness probes.
 * Never includes DATABASE_URL, secrets, or connection userinfo.
 *
 * API and worker share DATABASE_POOL_MAX (default 10). On the self-hosted
 * edition the worker side of that one pool may reserve at most 3 connections.
 */
export const SHARED_POOL_WORKER_RESERVE_MAX = 3;

export function workerReservedConnections(config: AppConfig): number {
  return config.worker.concurrency
    + (config.reports.schedulerEnabled ? 1 : 0)
    + (config.linkHealth.enabled ? config.linkHealth.workerConcurrency : 0)
    + (config.readableReplica.enabled ? config.readableReplica.workerConcurrency : 0)
    + (config.linkPreview.enabled ? config.linkPreview.workerConcurrency : 0)
    + (config.exportJobs.enabled ? config.exportJobs.workerConcurrency : 0)
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

