import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm, truncate } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, test } from 'vitest';

import { runLedgerArchiveCli } from '../../../scripts/ledger-archive-command.js';
import { runMigrations } from '../../../src/infrastructure/database/migrations.js';
import { createPostgresLedgerArchiveExportJobRepository } from '../../../src/infrastructure/database/ledger-archive-export-job-repository.js';
import { createPostgresLedgerArchiveSegmentRepository } from '../../../src/infrastructure/database/ledger-archive-segment-repository.js';
import {
  createFilesystemLedgerArchiveObjectStore,
  createLedgerArchiveExporter,
  cutoverLedgerArchiveReader,
  type LedgerArchiveSource,
} from '../../../src/infrastructure/ledger-archive/index.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';

interface Row { readonly key: bigint; readonly value: unknown }

describeWithPostgres('verified archive reader cutover', () => {
  let isolated: IsolatedPostgresRuntime;
  let objectRoot: string;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('archive_reader_cutover', { maxConnections: 8 });
    await runMigrations(isolated.runtime.db, 'latest');
    objectRoot = await mkdtemp(join(tmpdir(), 'known-reader-cutover-'));
  }, 120_000);

  afterAll(async () => {
    await isolated?.close();
    if (objectRoot) await rm(objectRoot, { recursive: true, force: true });
  });

  test('fully reads a production operation payload, records evidence, and has one CAS winner', async () => {
    const context = await exportedOperation(validOperationValue(1n));
    assert.deepEqual((await statusFor(context.segmentId)).cutover, {
      ready: false, blockers: ['export_job_not_succeeded'],
    });
    await succeedExportJob(context.segmentId);
    assert.deepEqual((await statusFor(context.segmentId)).cutover, { ready: true, blockers: [] });
    const options = cutoverOptions(context.segmentId, 4n);
    const outcomes = await Promise.allSettled([
      cutoverLedgerArchiveReader(options), cutoverLedgerArchiveReader(options),
    ]);
    const winner = outcomes.find((outcome) => outcome.status === 'fulfilled');
    const loser = outcomes.find((outcome) => outcome.status === 'rejected');
    assert.ok(winner && winner.status === 'fulfilled');
    assert.equal(winner.value.state, 'reader_cutover');
    assert.deepEqual(winner.value.stageEvidence.reader_cutover, {
      readBackVerified: true, readerKind: 'filesystem', family: 'operation',
      verifiedAt: winner.value.verifiedAt!.toISOString(),
      commandIdentity: 'integration:reader-cutover', verifiedRows: '1',
    });
    assert.ok(loser && loser.status === 'rejected');
    assert.equal((loser.reason as { stableCode?: unknown }).stableCode,
      'archive_reader_cutover_conflict');
    await assert.rejects(() => cutoverLedgerArchiveReader(options),
      stableCode('archive_reader_cutover_conflict'));
  });

  test('refuses tampered and missing objects without advancing verified state', async () => {
    const tampered = await exportedOperation(validOperationValue(1n));
    await succeedExportJob(tampered.segmentId);
    await truncate(tampered.objectPath, 8);
    await assert.rejects(() => cutoverLedgerArchiveReader(cutoverOptions(tampered.segmentId, 4n)));
    assert.equal((await segments().get(tampered.segmentId))?.state, 'verified');

    const missing = await exportedOperation(validOperationValue(1n));
    await succeedExportJob(missing.segmentId);
    await rm(missing.objectPath);
    await assert.rejects(() => cutoverLedgerArchiveReader(cutoverOptions(missing.segmentId, 4n)),
      stableCode('archive_object_not_found'));
    assert.equal((await segments().get(missing.segmentId))?.state, 'verified');
  });

  test('refuses legal hold, wrong revision, and an export job that did not succeed', async () => {
    const held = await exportedOperation(validOperationValue(1n));
    await succeedExportJob(held.segmentId);
    const heldSegment = await segments().setLegalHold({
      segmentId: held.segmentId, expectedState: 'verified', expectedRevision: 4n, legalHold: true,
    });
    await assert.rejects(() => cutoverLedgerArchiveReader(
      cutoverOptions(held.segmentId, heldSegment.stateRevision),
    ), stableCode('archive_reader_cutover_blocked_legal_hold'));

    const wrongRevision = await exportedOperation(validOperationValue(1n));
    await succeedExportJob(wrongRevision.segmentId);
    await assert.rejects(() => cutoverLedgerArchiveReader(cutoverOptions(wrongRevision.segmentId, 3n)),
      stableCode('archive_reader_cutover_conflict'));

    const failedJob = await exportedOperation(validOperationValue(1n));
    const job = await jobs().enqueue({ jobId: randomUUID(), segmentId: failedJob.segmentId });
    const claim = (await jobs().claimDue({ leaseOwner: 'cutover-test', leaseDurationMs: 60_000, limit: 100 }))
      .find((candidate) => candidate.jobId === job.jobId)!;
    await jobs().fail(claim, 'deliberate_test_failure');
    await assert.rejects(() => cutoverLedgerArchiveReader(cutoverOptions(failedJob.segmentId, 4n)),
      stableCode('archive_reader_cutover_blocked_export_job_not_succeeded'));
  });

  test('uses the production payload parser, not generic JSONL verification alone', async () => {
    const invalid = await exportedOperation({
      ...validOperationValue(1n), canonicalPayloadEnvelopeJson: '{"payloadJson":{}}',
    });
    await succeedExportJob(invalid.segmentId);
    await assert.rejects(() => cutoverLedgerArchiveReader(cutoverOptions(invalid.segmentId, 4n)),
      (error: unknown) => (error as { stableCode?: unknown }).stableCode === 'archive_read_failed'
        && ((error as { cause?: { code?: unknown } }).cause?.code
          === 'operation_payload_integrity_failure'));
    assert.equal((await segments().get(invalid.segmentId))?.state, 'verified');
  });

  function segments() {
    return createPostgresLedgerArchiveSegmentRepository(isolated.runtime.db);
  }

  function jobs() {
    return createPostgresLedgerArchiveExportJobRepository(isolated.runtime.db);
  }

  function store() {
    return createFilesystemLedgerArchiveObjectStore({
      rootDirectory: objectRoot, kmsKeyId: 'dev:reader-cutover',
    });
  }

  function cutoverOptions(segmentId: string, expectedRevision: bigint) {
    return {
      segmentId, expectedRevision, segments: segments(), jobs: jobs(), objects: store(),
      byteCeiling: 1_000_000n, readerKind: 'filesystem' as const,
      commandIdentity: 'integration:reader-cutover',
    };
  }

  async function exportedOperation(value: unknown) {
    const collectionId = `reader-cutover-${randomUUID()}`;
    const boundValue = value !== null && typeof value === 'object' && !Array.isArray(value)
      ? { ...value, collectionId } : value;
    const segment = await createLedgerArchiveExporter({
      segments: segments(), objects: store(), spoolDirectory: join(objectRoot, 'spool'),
      byteCeiling: 1_000_000n,
    }).export({
      segmentId: randomUUID(), source: source(boundValue, collectionId), lowerInclusive: 1n,
      upperExclusive: 2n, kmsKeyId: 'dev:reader-cutover',
    });
    const key = new URL(segment.archiveObjectUri).pathname.replace(/^\//u, '');
    return { segmentId: segment.segmentId, objectPath: join(objectRoot, ...key.split('/')) };
  }

  async function succeedExportJob(segmentId: string): Promise<void> {
    const repository = jobs();
    const job = await repository.enqueue({ jobId: randomUUID(), segmentId });
    const claims = await repository.claimDue({
      leaseOwner: `cutover-test:${segmentId}`, leaseDurationMs: 60_000, limit: 100,
    });
    const claim = claims.find((candidate) => candidate.jobId === job.jobId);
    assert.ok(claim);
    await repository.succeed(claim);
  }

  async function statusFor(segmentId: string): Promise<{
    cutover: { ready: boolean; blockers: string[] };
  }> {
    let output = '';
    await runLedgerArchiveCli(['status'], {
      DATABASE_URL: isolated.databaseUrl, LEDGER_ARCHIVE_READ_ENABLED: 'true',
      LEDGER_ARCHIVE_STORE: 'filesystem', LEDGER_ARCHIVE_FILESYSTEM_ROOT: objectRoot,
      LEDGER_ARCHIVE_KMS_KEY_ID: 'dev:reader-cutover',
    },
      (value) => { output += value; });
    const status = JSON.parse(output) as {
      segments: Array<{ segmentId: string; cutover: { ready: boolean; blockers: string[] } }>;
    };
    return status.segments.find((segment) => segment.segmentId === segmentId)!;
  }
});

function source(value: unknown, collectionId: string): LedgerArchiveSource<Row> {
  return Object.freeze({
    ledgerFamily: 'operation', sourceRelation: 'public.operation_payloads',
    sourceScope: `collection:${collectionId}`, keyOf: (row: Row) => row.key,
    archiveValue: (row: Row) => row.value,
    async readPage(input) {
      if (input.afterExclusive !== undefined) return Object.freeze({ rows: [], hasMore: false });
      return Object.freeze({ rows: Object.freeze([{ key: 1n, value }]), hasMore: false });
    },
  });
}

function validOperationValue(commitOrdinal: bigint): Record<string, unknown> {
  const canonicalPayloadEnvelopeJson = JSON.stringify({ payloadJson: { title: 'archive' }, syncWireJson: null });
  return {
    kind: 'operation-payload-v1', operationId: 'operation-reader-cutover',
    collectionId: 'reader-cutover', commitOrdinal: commitOrdinal.toString(),
    canonicalPayloadEnvelopeJson,
    digestSha256: createHash('sha256').update(canonicalPayloadEnvelopeJson).digest('hex'),
    byteCount: String(Buffer.byteLength(canonicalPayloadEnvelopeJson)), schemaVersion: 1,
    bucket: '2026-08-30', syncWirePresent: false,
  };
}

function stableCode(expected: string) {
  return (error: unknown) => (error as { stableCode?: unknown }).stableCode === expected;
}
