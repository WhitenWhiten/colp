import {
  createPostgresLedgerArchiveSegmentRepository,
  type AuditPayloadColdSource,
  type DatabaseRuntime,
  type HistoricalOperationPayloadPort,
} from '../infrastructure/database/index.js';
import {
  createFilesystemLedgerArchiveObjectStore,
  createLedgerArchiveAuditPayloadColdSource,
  createLedgerArchiveColdReader,
  createLedgerArchiveOperationPayloadSource,
  createS3LedgerArchiveReader,
  createSegmentPayloadCache,
  type LedgerArchiveObjectReader,
} from '../infrastructure/ledger-archive/index.js';
import type { LedgerArchiveReaderRuntimeConfig } from './config-ledger-archive-reader.js';

export interface LedgerArchiveColdReadSources {
  readonly operationPayloadSource: HistoricalOperationPayloadPort;
  readonly auditPayloadColdSource: AuditPayloadColdSource;
}

export function composeLedgerArchiveColdReaders(options: Readonly<{
  config: LedgerArchiveReaderRuntimeConfig;
  database?: DatabaseRuntime;
  objects?: LedgerArchiveObjectReader;
}>): LedgerArchiveColdReadSources | undefined {
  if (!options.config.enabled) return undefined;
  if (!options.database) throw new Error('ledger_archive_read_database_required');
  if (!options.config.storage && !options.objects) throw new Error('ledger_archive_read_storage_required');
  const segments = createPostgresLedgerArchiveSegmentRepository(options.database.db);
  const reader = createLedgerArchiveColdReader({
    segments,
    objects: options.objects ?? createLedgerArchiveObjectReader(options.config),
    byteCeiling: options.config.byteCeiling,
  });
  const cache = createSegmentPayloadCache({
    maxRowsPerSegment: options.config.maxRowsPerSegment,
    maxBytesPerSegment: options.config.maxBytesPerSegment,
    maxCachedBytes: options.config.maxCachedBytes,
    maxConcurrentLoads: options.config.maxConcurrentLoads,
    loadTimeoutMs: options.config.timeoutMs,
  });
  return Object.freeze({
    operationPayloadSource: createLedgerArchiveOperationPayloadSource({
      segments, reader, cache, purpose: 'command',
    }),
    auditPayloadColdSource: createLedgerArchiveAuditPayloadColdSource({
      segments, reader, cache,
    }),
  });
}

/** Narrow reader-only adapter factory shared by API runtime and operator verification. */
export function createLedgerArchiveObjectReader(
  config: LedgerArchiveReaderRuntimeConfig,
): LedgerArchiveObjectReader {
  const storage = config.storage;
  if (!storage) throw new Error('ledger_archive_read_storage_required');
  if (storage.kind === 's3') {
    return createS3LedgerArchiveReader({
      endpoint: storage.endpoint, region: storage.region, bucket: storage.bucket,
      readerCredential: storage.readerCredential, timeoutMs: config.timeoutMs,
    });
  }
  const store = createFilesystemLedgerArchiveObjectStore({
    rootDirectory: storage.rootDirectory, kmsKeyId: storage.kmsKeyId,
    ...(storage.uriBucket === undefined ? {} : { uriBucket: storage.uriBucket }),
  });
  // Do not expose the development adapter's create-only write capability to the read composition.
  return Object.freeze({ uriForKey: store.uriForKey, head: store.head, read: store.read });
}
