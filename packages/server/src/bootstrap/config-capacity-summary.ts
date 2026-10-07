import type { AppConfig, SanitizedRuntimeCapacity } from './config-types.js';
import { sanitizeAttachmentRateLimitConfig } from '../modules/attachments/index.js';
import { sanitizeLedgerArchiveRuntimeConfig } from './config-ledger-archive.js';
import { sanitizeLedgerArchiveReaderRuntimeConfig } from './config-ledger-archive-reader.js';

/**
 * Credential-free capacity snapshot for startup logs and readiness probes.
 * Never includes DATABASE_URL, secrets, or connection userinfo.
 */
export function sanitizedRuntimeCapacity(config: AppConfig): SanitizedRuntimeCapacity {
  return Object.freeze({
    database: Object.freeze({ ...config.database }),
    worker: Object.freeze({ ...config.worker }),
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
    // P4A-RL04: credential-free rate-limit snapshot (never the URL/secret).
    attachmentsRateLimit: sanitizeAttachmentRateLimitConfig(config.attachmentsRateLimit),
    // FIX-L-001: startup summary records the explicit auth mode, never the secret.
    oidcClientAuthMode: config.oidc.clientAuthMode,
    ledgerArchive: sanitizeLedgerArchiveRuntimeConfig(config.ledgerArchive),
    ledgerArchiveReader: sanitizeLedgerArchiveReaderRuntimeConfig(config.ledgerArchiveReader),
  });
}

