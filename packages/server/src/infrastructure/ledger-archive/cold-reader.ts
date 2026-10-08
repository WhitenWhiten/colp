import { evaluateLedgerArchivePolicyFromLinear } from '../database/ledger-archive-policy.js';
import type { LedgerArchiveSegmentRepository } from '../database/ledger-archive-segment-repository.js';
import { LedgerArchiveFormatError, verifyLedgerArchiveV1 } from './canonical-format.js';
import { LedgerArchiveObjectStoreError, type LedgerArchiveObjectReader } from './object-store.js';

export class LedgerArchiveColdReadError extends Error {
  constructor(readonly stableCode: string, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'LedgerArchiveColdReadError';
  }
}

export function createLedgerArchiveColdReader(options: Readonly<{
  segments: LedgerArchiveSegmentRepository;
  objects: LedgerArchiveObjectReader;
  byteCeiling: bigint;
}>) {
  return Object.freeze({
    async readRows(
      segmentId: string,
      onRow: (row: Readonly<{ key: bigint; value: unknown }>) => void | Promise<void>,
      signal?: AbortSignal,
    ) {
      const segment = await options.segments.get(segmentId);
      if (!segment) throw coldError('archive_manifest_not_found', 'Archive manifest was not found.');
      if (!evaluateLedgerArchivePolicyFromLinear(segment.state, segment.legalHold).canReadObject) {
        throw coldError('archive_not_verified', 'Archive manifest is not verified for cold reads.');
      }
      if (segment.archiveSchemaVersion !== 1) {
        throw coldError('archive_schema_unsupported', 'Archive manifest schema is unsupported.');
      }
      const key = keyFromUri(segment.archiveObjectUri);
      try {
        if (options.objects.uriForKey(key) !== segment.archiveObjectUri) {
          throw coldError('archive_uri_not_configured', 'Archive URI is not served by this reader.');
        }
        const object = await options.objects.read({
          key, byteCeiling: options.byteCeiling, ...(signal === undefined ? {} : { signal }),
        });
        try {
          if (object.identity.sha256 !== segment.contentDigest
              || object.identity.contentEtag !== segment.archiveObjectEtag
              || object.identity.byteLength !== segment.sourceBytes
              || object.identity.kmsKeyId !== segment.kmsKeyId) {
            throw coldError('archive_object_binding_mismatch', 'Archive object does not match its verified manifest.');
          }
          return await verifyLedgerArchiveV1(object.body, {
            ledgerFamily: segment.ledgerFamily, sourceRelation: segment.sourceRelation,
            sourceScope: segment.sourceScope,
            lowerInclusive: segment.sourceKeyBounds.lowerInclusive,
            upperExclusive: segment.sourceKeyBounds.upperExclusive,
            rowCount: segment.rowCount, contentDigest: segment.contentDigest,
          }, { byteCeiling: options.byteCeiling, onRow, ...(signal === undefined ? {} : { signal }) });
        } finally { await object.close(); }
      } catch (error) {
        if (error instanceof LedgerArchiveColdReadError) throw error;
        if (error instanceof LedgerArchiveObjectStoreError) {
          throw coldError(`archive_object_${error.failureClass}`, 'Verified archive object is unavailable.', error);
        }
        if (error instanceof LedgerArchiveFormatError) {
          throw coldError(`archive_corrupt_${error.stableCode}`, 'Verified archive object is corrupt.', error);
        }
        throw coldError('archive_read_failed', 'Verified archive read failed.', error);
      }
    },
  });
}

function keyFromUri(uri: string): string {
  try {
    const parsed = new URL(uri);
    if (parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error('credentials');
    return parsed.pathname.replace(/^\//u, '');
  } catch (error) {
    throw coldError('archive_uri_invalid', 'Archive manifest URI is invalid.', error);
  }
}

function coldError(code: string, message: string, cause?: unknown): LedgerArchiveColdReadError {
  return new LedgerArchiveColdReadError(code, message, cause);
}
