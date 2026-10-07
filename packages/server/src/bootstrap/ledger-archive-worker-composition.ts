import { randomUUID } from 'node:crypto';

import type { LedgerArchiveRuntimeConfig } from './config-ledger-archive.js';
import type { DatabaseRuntime } from '../infrastructure/database/runtime.js';
import type { LedgerArchiveSegment } from '../infrastructure/database/ledger-archive-segment-repository.js';
import { createPostgresLedgerArchiveExportJobRepository } from '../infrastructure/database/ledger-archive-export-job-repository.js';
import { createPostgresLedgerArchiveSegmentRepository } from '../infrastructure/database/ledger-archive-segment-repository.js';
import {
  AUDIT_PAYLOAD_ARCHIVE_FAMILY,
  createPostgresAuditPayloadLedgerArchiveSource,
  createPostgresOperationLedgerArchiveSource,
  createPostgresSocialOutboxLedgerArchiveSource,
  createFilesystemLedgerArchiveObjectStore,
  createLedgerArchiveExporter,
  createLedgerArchiveExportWorker,
  createS3LedgerArchiveObjectStore,
  isLedgerArchiveSpoolUnavailable,
  LedgerArchiveExportError,
  LedgerArchiveObjectStoreError,
  reclaimLedgerArchiveSpoolSync,
  OPERATION_ARCHIVE_FAMILY,
  SOCIAL_OUTBOX_ARCHIVE_FAMILY,
  type LedgerArchiveExportWorkerLogger,
  type LedgerArchiveExportWorkerRuntime,
  type LedgerArchiveObjectStore,
  type LedgerArchiveSource,
} from '../infrastructure/ledger-archive/index.js';

export type LedgerArchiveSourceResolver = (
  segment: LedgerArchiveSegment,
  signal: AbortSignal,
) => Promise<LedgerArchiveSource<unknown>>;

export interface ComposeLedgerArchiveWorkerOptions {
  readonly config: LedgerArchiveRuntimeConfig;
  readonly database?: DatabaseRuntime;
  readonly resolveSource?: LedgerArchiveSourceResolver;
  readonly logger?: LedgerArchiveExportWorkerLogger;
  readonly workerId?: string;
}

export function composeLedgerArchiveWorker(
  options: ComposeLedgerArchiveWorkerOptions,
): LedgerArchiveExportWorkerRuntime | undefined {
  const { config } = options;
  if (!config.enabled) return undefined;
  if (!options.database) throw new Error('ledger_archive_database_required');
  if (!config.storage || !config.kmsKeyId) throw new Error('ledger_archive_storage_required');
  reclaimLedgerArchiveSpoolSync(config.spoolDirectory, { maxAgeMs: config.leaseDurationMs });

  const segments = createPostgresLedgerArchiveSegmentRepository(options.database.db);
  const exporter = createLedgerArchiveExporter({
    segments,
    objects: createWriter(config),
    spoolDirectory: config.spoolDirectory,
    pageSize: config.pageSize,
    byteCeiling: config.byteCeiling,
  });
  const resolveSource = options.resolveSource ?? productionSourceResolver(options.database);
  return createLedgerArchiveExportWorker({
    jobs: createPostgresLedgerArchiveExportJobRepository(options.database.db),
    leaseOwner: options.workerId ?? `ledger-archive:${randomUUID()}`,
    leaseDurationMs: config.leaseDurationMs,
    retryDelayMs: config.retryDelayMs,
    maxAttempts: config.maxAttempts,
    concurrency: config.concurrency,
    pollIntervalMs: config.pollIntervalMs,
    ...(options.logger === undefined ? {} : { logger: options.logger }),
    classifyFailure: classifyLedgerArchiveFailure,
    async exportSegment(segmentId, signal) {
      const segment = await segments.get(segmentId);
      if (!segment) throw stableError('archive_segment_not_found');
      const source = await resolveSource(segment, signal);
      if (source.sourceRelation !== segment.sourceRelation || source.sourceScope !== segment.sourceScope) {
        throw stableError('archive_source_binding_mismatch');
      }
      await exporter.export({
        segmentId,
        source,
        lowerInclusive: segment.sourceKeyBounds.lowerInclusive,
        upperExclusive: segment.sourceKeyBounds.upperExclusive,
        kmsKeyId: segment.kmsKeyId,
        deleteAfter: segment.deleteAfter,
        legalHold: segment.legalHold,
        signal,
      });
    },
  });
}

function productionSourceResolver(database: DatabaseRuntime): LedgerArchiveSourceResolver {
  return async (segment) => {
    if (segment.ledgerFamily === OPERATION_ARCHIVE_FAMILY) {
      return await createPostgresOperationLedgerArchiveSource(
        database.db, segment.sourceScope,
      ) as unknown as LedgerArchiveSource<unknown>;
    }
    if (segment.ledgerFamily === AUDIT_PAYLOAD_ARCHIVE_FAMILY) {
      return createPostgresAuditPayloadLedgerArchiveSource(
        database.db, segment.sourceScope,
      ) as unknown as LedgerArchiveSource<unknown>;
    }
    if (segment.ledgerFamily === SOCIAL_OUTBOX_ARCHIVE_FAMILY) {
      return await createPostgresSocialOutboxLedgerArchiveSource(
        database.db, segment.sourceScope,
      ) as unknown as LedgerArchiveSource<unknown>;
    }
    throw stableError('archive_source_family_not_supported');
  };
}

export function classifyLedgerArchiveFailure(
  error: unknown,
): Readonly<{ errorClass: string; retryable: boolean }> {
  if (isLedgerArchiveSpoolUnavailable(error)
      || (error instanceof Error && error.message === 'archive_spool_unavailable')) {
    return Object.freeze({ errorClass: 'archive_spool_unavailable', retryable: true });
  }
  if (error instanceof LedgerArchiveObjectStoreError) {
    return Object.freeze({
      errorClass: error.stableCode,
      retryable: error.failureClass === 'retryable' || error.failureClass === 'aborted',
    });
  }
  if (error instanceof LedgerArchiveExportError) {
    return Object.freeze({ errorClass: normalizeErrorClass(error.stableCode), retryable: false });
  }
  const stableCode = (error as { stableCode?: unknown }).stableCode;
  if (typeof stableCode === 'string') {
    return Object.freeze({ errorClass: normalizeErrorClass(stableCode), retryable: false });
  }
  const message = error instanceof Error ? error.message : '';
  if (/^[a-z][a-z0-9_]{0,95}$/u.test(message)) {
    return Object.freeze({ errorClass: message, retryable: false });
  }
  return Object.freeze({ errorClass: 'archive_export_failed', retryable: true });
}

function createWriter(config: LedgerArchiveRuntimeConfig): LedgerArchiveObjectStore {
  const storage = config.storage!;
  const kmsKeyId = config.kmsKeyId!;
  if (storage.kind === 'filesystem') {
    return createFilesystemLedgerArchiveObjectStore({
      rootDirectory: storage.rootDirectory,
      ...(storage.uriBucket === undefined ? {} : { uriBucket: storage.uriBucket }),
      kmsKeyId,
    });
  }
  return createS3LedgerArchiveObjectStore({
    endpoint: storage.endpoint,
    region: storage.region,
    bucket: storage.bucket,
    readerCredential: storage.readerCredential,
    writerCredential: storage.writerCredential,
    kmsKeyId,
  });
}

function stableError(code: string): Error {
  return Object.assign(new Error(code), { stableCode: code });
}

function normalizeErrorClass(code: string): string {
  return /^[a-z][a-z0-9_]{0,95}$/u.test(code) ? code : 'archive_export_failed';
}
