import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, unlink, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';

import { settleBestEffort } from '../async/best-effort.js';
import {
  LedgerArchiveSegmentRepositoryError,
  type CreateLedgerArchiveSegmentInput,
  type LedgerArchiveSegment,
  type LedgerArchiveSegmentRepository,
} from '../database/ledger-archive-segment-repository.js';
import { encodeLedgerArchiveV1, verifyLedgerArchiveV1 } from './canonical-format.js';
import {
  LedgerArchiveObjectStoreError,
  type LedgerArchiveObjectIdentity,
  type LedgerArchiveObjectStore,
} from './object-store.js';
import { readLedgerArchiveSourceRows, type LedgerArchiveSource } from './source.js';

export interface LedgerArchiveExportInput<Row> {
  readonly segmentId: string;
  readonly source: LedgerArchiveSource<Row>;
  readonly lowerInclusive: bigint;
  readonly upperExclusive: bigint;
  readonly kmsKeyId: string;
  readonly deleteAfter?: Date | null;
  readonly legalHold?: boolean;
  readonly signal?: AbortSignal;
}

export interface LedgerArchiveExporterOptions {
  readonly segments: LedgerArchiveSegmentRepository;
  readonly objects: LedgerArchiveObjectStore;
  readonly spoolDirectory: string;
  readonly pageSize?: number;
  readonly byteCeiling?: bigint;
}

export class LedgerArchiveExportError extends Error {
  constructor(readonly stableCode: string, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'LedgerArchiveExportError';
  }
}

export function createLedgerArchiveExporter(options: LedgerArchiveExporterOptions) {
  const pageSize = options.pageSize ?? 1_000;
  const byteCeiling = options.byteCeiling ?? 20n * 1024n * 1024n * 1024n;
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || byteCeiling < 1n) {
    throw new RangeError('ledger_archive_exporter_options_invalid');
  }

  return Object.freeze({
    async export<Row>(input: LedgerArchiveExportInput<Row>): Promise<LedgerArchiveSegment> {
      await mkdir(options.spoolDirectory, { recursive: true });
      const spoolPath = join(options.spoolDirectory, `${input.segmentId}.${randomUUID()}.jsonl`);
      let spool: FileHandle | undefined;
      try {
        spool = await open(spoolPath, 'wx', 0o600);
        const summary = await encodeLedgerArchiveV1({
          ledgerFamily: input.source.ledgerFamily,
          sourceRelation: input.source.sourceRelation,
          sourceScope: input.source.sourceScope,
          lowerInclusive: input.lowerInclusive,
          upperExclusive: input.upperExclusive,
        }, readLedgerArchiveSourceRows(input.source, {
          lowerInclusive: input.lowerInclusive, upperExclusive: input.upperExclusive,
        }, { pageSize, ...(input.signal === undefined ? {} : { signal: input.signal }) }),
        async (chunk) => writeAll(spool!, chunk), {
          byteCeiling, ...(input.signal === undefined ? {} : { signal: input.signal }),
        });
        await spool.sync();
        await spool.close();
        spool = undefined;

        const key = archiveObjectKey(input, summary.contentDigest);
        const manifestInput: CreateLedgerArchiveSegmentInput = {
          segmentId: input.segmentId,
          ledgerFamily: input.source.ledgerFamily,
          sourceRelation: input.source.sourceRelation,
          sourceScope: input.source.sourceScope,
          sourceKeyKind: 'bigint',
          sourceKeyComparator: 'signed-bigint-ascending-v1',
          sourceKeyBounds: {
            lowerInclusive: input.lowerInclusive, upperExclusive: input.upperExclusive,
          },
          rowCount: summary.rowCount,
          sourceBytes: summary.byteLength,
          contentDigest: summary.contentDigest,
          archiveObjectUri: options.objects.uriForKey(key),
          archiveObjectEtag: summary.contentDigest,
          archiveSchemaVersion: 1,
          kmsKeyId: input.kmsKeyId,
          deleteAfter: input.deleteAfter ?? null,
          legalHold: input.legalHold ?? false,
        };
        let segment = await createOrLoadMatching(options.segments, manifestInput);
        if (segment.state === 'open') {
          segment = await transition(options.segments, segment, 'sealed', {
            contentDigest: summary.contentDigest, rowCount: summary.rowCount.toString(),
          });
        }
        if (segment.state === 'sealed') {
          await createOrConfirmObject(options.objects, {
            key, spoolPath, byteLength: summary.byteLength, sha256: summary.contentDigest,
            kmsKeyId: input.kmsKeyId, signal: input.signal,
          });
          const identity = await options.objects.head(key, input.signal);
          assertObjectBinding(identity, manifestInput);
          segment = await transition(options.segments, segment, 'exported', {
            objectHeadBound: true, contentEtag: identity.contentEtag,
            providerEtag: identity.providerEtag ?? 'unavailable',
          });
        }
        if (segment.state === 'exported') {
          const object = await options.objects.read({
            key, byteCeiling, ...(input.signal === undefined ? {} : { signal: input.signal }),
          });
          try {
            assertObjectBinding(object.identity, manifestInput);
            const verified = await verifyLedgerArchiveV1(object.body, {
              ledgerFamily: segment.ledgerFamily, sourceRelation: segment.sourceRelation,
              sourceScope: segment.sourceScope,
              lowerInclusive: segment.sourceKeyBounds.lowerInclusive,
              upperExclusive: segment.sourceKeyBounds.upperExclusive,
              rowCount: segment.rowCount, contentDigest: segment.contentDigest,
            }, { byteCeiling, ...(input.signal === undefined ? {} : { signal: input.signal }) });
            if (verified.byteLength !== segment.sourceBytes) throw exportError('archive_length_mismatch', 'Archive length does not match manifest.');
            segment = await transition(options.segments, segment, 'verified', {
              readBackVerified: true, contentDigest: verified.contentDigest,
              rowCount: verified.rowCount.toString(),
            });
          } finally { await object.close(); }
        }
        if (segment.state !== 'verified') {
          throw exportError('archive_state_out_of_scope', 'Exporter will not advance post-verification lifecycle states.');
        }
        return segment;
      } finally {
        if (spool) await settleBestEffort(spool.close(), 'the authoritative exporter result is already preserved');
        await settleBestEffort(unlink(spoolPath), 'a private spool cleanup failure cannot alter durable archive state');
      }
    },
  });
}

async function createOrLoadMatching(
  repository: LedgerArchiveSegmentRepository,
  input: CreateLedgerArchiveSegmentInput,
): Promise<LedgerArchiveSegment> {
  try {
    return await repository.create(input);
  } catch (error) {
    if (!(error instanceof LedgerArchiveSegmentRepositoryError) || error.code !== 'segment_exists') throw error;
    const existing = await repository.get(input.segmentId);
    if (!existing || !manifestMatches(existing, input)) {
      throw exportError('archive_manifest_conflict', 'Existing archive manifest does not match the spooled source.', error);
    }
    return existing;
  }
}

function manifestMatches(segment: LedgerArchiveSegment, input: CreateLedgerArchiveSegmentInput): boolean {
  return segment.ledgerFamily === input.ledgerFamily
    && segment.sourceRelation === input.sourceRelation && segment.sourceScope === input.sourceScope
    && segment.sourceKeyBounds.lowerInclusive === input.sourceKeyBounds.lowerInclusive
    && segment.sourceKeyBounds.upperExclusive === input.sourceKeyBounds.upperExclusive
    && segment.rowCount === input.rowCount && segment.sourceBytes === input.sourceBytes
    && segment.contentDigest === input.contentDigest && segment.archiveObjectUri === input.archiveObjectUri
    && segment.archiveObjectEtag === input.archiveObjectEtag && segment.kmsKeyId === input.kmsKeyId
    && segment.archiveSchemaVersion === input.archiveSchemaVersion
    && segment.legalHold === (input.legalHold ?? false)
    && sameDate(segment.deleteAfter, input.deleteAfter ?? null);
}

function sameDate(left: Date | null, right: Date | null): boolean {
  return left === null ? right === null : right !== null && left.getTime() === right.getTime();
}

async function transition(
  repository: LedgerArchiveSegmentRepository,
  segment: LedgerArchiveSegment,
  targetState: 'sealed' | 'exported' | 'verified',
  evidence: Record<string, unknown>,
): Promise<LedgerArchiveSegment> {
  try {
    return await repository.transition({
      segmentId: segment.segmentId, expectedState: segment.state,
      expectedRevision: segment.stateRevision, targetState, evidence,
    });
  } catch (error) {
    if (!(error instanceof LedgerArchiveSegmentRepositoryError) || error.code !== 'cas_conflict') throw error;
    const current = await repository.get(segment.segmentId);
    if (current?.state === targetState) return current;
    throw error;
  }
}

async function createOrConfirmObject(
  store: LedgerArchiveObjectStore,
  input: Readonly<{
    key: string; spoolPath: string; byteLength: bigint; sha256: string;
    kmsKeyId: string; signal?: AbortSignal;
  }>,
): Promise<void> {
  try {
    await store.putCreateOnly({
      key: input.key, body: readSpool(input.spoolPath), byteLength: input.byteLength,
      sha256: input.sha256, kmsKeyId: input.kmsKeyId,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
  } catch (error) {
    if (!(error instanceof LedgerArchiveObjectStoreError) || error.failureClass !== 'already_exists') throw error;
    const identity = await store.head(input.key, input.signal);
    if (identity.byteLength !== input.byteLength || identity.sha256 !== input.sha256
        || identity.kmsKeyId !== input.kmsKeyId) {
      throw exportError('archive_existing_object_conflict', 'Existing archive object does not match the source spool.', error);
    }
  }
}

async function* readSpool(path: string): AsyncGenerator<Uint8Array> {
  for await (const chunk of createReadStream(path)) yield chunk as Buffer;
}

function assertObjectBinding(identity: LedgerArchiveObjectIdentity, manifest: CreateLedgerArchiveSegmentInput): void {
  if (identity.uri !== manifest.archiveObjectUri || identity.byteLength !== manifest.sourceBytes
      || identity.sha256 !== manifest.contentDigest || identity.contentEtag !== manifest.archiveObjectEtag
      || identity.kmsKeyId !== manifest.kmsKeyId) {
    throw exportError('archive_head_binding_mismatch', 'Archive object HEAD does not match its manifest.');
  }
}

function archiveObjectKey<Row>(input: LedgerArchiveExportInput<Row>, digest: string): string {
  const scope = createHash('sha256').update(input.source.sourceScope).digest('hex').slice(0, 24);
  return `ledger-archives/v1/${input.source.ledgerFamily}/${scope}/${input.lowerInclusive}-${input.upperExclusive}-${digest.slice(7)}.jsonl`;
}

async function writeAll(handle: FileHandle, chunk: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < chunk.byteLength) {
    const result = await handle.write(chunk, offset, chunk.byteLength - offset);
    offset += result.bytesWritten;
  }
}

function exportError(code: string, message: string, cause?: unknown): LedgerArchiveExportError {
  return new LedgerArchiveExportError(code, message, cause);
}
