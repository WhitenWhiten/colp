import { evaluateLedgerArchivePolicyFromLinear } from '../database/ledger-archive-policy.js';
import {
  LedgerArchiveSegmentRepositoryError,
  type LedgerArchiveSegment,
  type LedgerArchiveSegmentRepository,
} from '../database/ledger-archive-segment-repository.js';
import type { LedgerArchiveExportJobRepository } from '../database/ledger-archive-export-job-repository.js';
import { LEDGER_ARCHIVE_SCHEMA_VERSION } from './canonical-format.js';
import { createLedgerArchiveColdReader } from './cold-reader.js';
import type { LedgerArchiveObjectReader } from './object-store.js';
import { validatePayloadArchiveRowForCutover } from './payload-cold-sources.js';
import {
  AUDIT_PAYLOAD_ARCHIVE_FAMILY,
  AUDIT_PAYLOAD_ARCHIVE_RELATION,
  AUDIT_PAYLOAD_ARCHIVE_SCOPE,
  OPERATION_ARCHIVE_FAMILY,
  OPERATION_ARCHIVE_RELATION,
} from './production-sources.js';
import { SOCIAL_OUTBOX_ARCHIVE_FAMILY, SOCIAL_OUTBOX_ARCHIVE_RELATION } from './social-outbox-source.js';

export interface LedgerArchiveCutoverReadiness {
  readonly ready: boolean;
  readonly blockers: readonly string[];
}

export function ledgerArchiveCutoverReadiness(
  segment: LedgerArchiveSegment,
  exportJobStatus: string | undefined,
): LedgerArchiveCutoverReadiness {
  const blockers: string[] = [];
  if (!evaluateLedgerArchivePolicyFromLinear(segment.state, false).canCutoverReader) {
    blockers.push(`state_${segment.state}`);
  }
  if (segment.legalHold) blockers.push('legal_hold');
  if (segment.archiveSchemaVersion !== LEDGER_ARCHIVE_SCHEMA_VERSION) blockers.push('schema_unsupported');
  if (segment.verifiedAt === null) blockers.push('verification_evidence_missing');
  if (!supportedManifestBinding(segment)) {
    blockers.push('reader_family_unsupported');
  }
  if (exportJobStatus !== 'succeeded') blockers.push('export_job_not_succeeded');
  return Object.freeze({ ready: blockers.length === 0, blockers: Object.freeze(blockers) });
}

function supportedManifestBinding(segment: LedgerArchiveSegment): boolean {
  if (segment.ledgerFamily === OPERATION_ARCHIVE_FAMILY) {
    return segment.sourceRelation === OPERATION_ARCHIVE_RELATION
      && /^collection:[A-Za-z0-9]/u.test(segment.sourceScope);
  }
  if (segment.ledgerFamily === AUDIT_PAYLOAD_ARCHIVE_FAMILY) {
    return segment.sourceRelation === AUDIT_PAYLOAD_ARCHIVE_RELATION
      && segment.sourceScope === AUDIT_PAYLOAD_ARCHIVE_SCOPE;
  }
  return segment.ledgerFamily === SOCIAL_OUTBOX_ARCHIVE_FAMILY
    && segment.sourceRelation === SOCIAL_OUTBOX_ARCHIVE_RELATION;
}

export async function cutoverLedgerArchiveReader(options: Readonly<{
  segmentId: string;
  expectedRevision: bigint;
  segments: LedgerArchiveSegmentRepository;
  jobs: LedgerArchiveExportJobRepository;
  objects: LedgerArchiveObjectReader;
  byteCeiling: bigint;
  readerKind: 'filesystem' | 's3';
  commandIdentity: string;
}>): Promise<LedgerArchiveSegment> {
  const segment = await options.segments.get(options.segmentId);
  if (!segment) throw cutoverError('archive_manifest_not_found');
  if (segment.state !== 'verified' || segment.stateRevision !== options.expectedRevision) {
    throw cutoverError('archive_reader_cutover_conflict');
  }
  const job = await options.jobs.getBySegment(options.segmentId);
  const readiness = ledgerArchiveCutoverReadiness(segment, job?.status);
  if (!readiness.ready) throw cutoverError(`archive_reader_cutover_blocked_${readiness.blockers[0]}`);

  const summary = await createLedgerArchiveColdReader({
    segments: options.segments, objects: options.objects, byteCeiling: options.byteCeiling,
  }).readRows(options.segmentId, (row) => {
    validatePayloadArchiveRowForCutover(segment.ledgerFamily, row, segment.sourceScope);
  });

  try {
    return await options.segments.transition({
      segmentId: segment.segmentId, expectedState: 'verified',
      expectedRevision: options.expectedRevision, targetState: 'reader_cutover',
      evidence: {
        readBackVerified: true, readerKind: options.readerKind,
        family: segment.ledgerFamily, verifiedAt: segment.verifiedAt!.toISOString(),
        commandIdentity: options.commandIdentity,
        verifiedRows: summary.rowCount.toString(),
      },
    });
  } catch (error) {
    if (error instanceof LedgerArchiveSegmentRepositoryError && error.code === 'cas_conflict') {
      throw cutoverError('archive_reader_cutover_conflict', error);
    }
    throw error;
  }
}

function cutoverError(code: string, cause?: unknown): Error {
  return Object.assign(new Error(code, cause === undefined ? undefined : { cause }), { stableCode: code });
}
