import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, truncate } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll, test } from 'vitest';

import { createMigrator, runMigrations } from '../../../src/infrastructure/database/migrations.js';
import { createPostgresLedgerArchiveSegmentRepository } from '../../../src/infrastructure/database/ledger-archive-segment-repository.js';
import {
  createPostgresLedgerArchiveExportJobRepository,
  LedgerArchiveExportJobError,
} from '../../../src/infrastructure/database/ledger-archive-export-job-repository.js';
import {
  createFilesystemLedgerArchiveObjectStore,
  createLedgerArchiveColdReader,
  createLedgerArchiveExportWorker,
  createLedgerArchiveExporter,
  LedgerArchiveColdReadError,
  LedgerArchiveExportError,
  LedgerArchiveObjectStoreError,
  type LedgerArchiveObjectStore,
  type LedgerArchiveSource,
} from '../../../src/infrastructure/ledger-archive/index.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';

interface SourceRow { readonly key: bigint; readonly payload: string }

describeWithPostgres('ledger archive exporter and durable jobs', () => {
  let isolated: IsolatedPostgresRuntime;
  let objectRoot: string;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('ledger_archive_export', { maxConnections: 8 });
    await runMigrations(isolated.runtime.db, 'latest');
    objectRoot = await mkdtemp(join(tmpdir(), 'known-ledger-archive-pg-'));
  }, 120_000);

  afterAll(async () => {
    await isolated?.close();
    if (objectRoot) await rm(objectRoot, { recursive: true, force: true });
  });

  test('spools, creates, seals, uploads, HEAD-binds, reads back, and reaches verified only', async () => {
    const segments = createPostgresLedgerArchiveSegmentRepository(isolated.runtime.db);
    const store = createFilesystemLedgerArchiveObjectStore({ rootDirectory: objectRoot, kmsKeyId: 'dev:archive-key' });
    const source = fixtureSource(`scope:${randomUUID()}`, [
      { key: 100n, payload: 'first' }, { key: 103n, payload: 'second' }, { key: 109n, payload: 'last' },
    ]);
    const segment = await createLedgerArchiveExporter({
      segments, objects: store, spoolDirectory: join(objectRoot, 'spool'), pageSize: 2, byteCeiling: 1_000_000n,
    }).export({
      segmentId: randomUUID(), source, lowerInclusive: 100n, upperExclusive: 110n, kmsKeyId: 'dev:archive-key',
    });
    assert.equal(segment.state, 'verified');
    assert.equal(segment.stateRevision, 4n);
    assert.equal(segment.rowCount, 3n);
    assert.deepEqual(Object.keys(segment.stageEvidence).sort(), ['exported', 'sealed', 'verified']);

    const rows: Array<{ key: bigint; value: unknown }> = [];
    const verified = await createLedgerArchiveColdReader({
      segments, objects: store, byteCeiling: 1_000_000n,
    }).readRows(segment.segmentId, (row) => rows.push(row));
    assert.equal(verified.contentDigest, segment.contentDigest);
    assert.deepEqual(rows.map((row) => row.key), [100n, 103n, 109n]);

    // A repeated command is idempotent through every persisted stage.
    const repeated = await createLedgerArchiveExporter({
      segments, objects: store, spoolDirectory: join(objectRoot, 'spool'), pageSize: 1,
    }).export({
      segmentId: segment.segmentId, source, lowerInclusive: 100n, upperExclusive: 110n, kmsKeyId: 'dev:archive-key',
    });
    assert.equal(repeated.stateRevision, 4n);
  });

  test('job leases recover after a crash and fence the stale worker', async () => {
    const segments = createPostgresLedgerArchiveSegmentRepository(isolated.runtime.db);
    const source = fixtureSource(`job:${randomUUID()}`, [{ key: 1n, payload: 'one' }]);
    const segment = await createLedgerArchiveExporter({
      segments,
      objects: createFilesystemLedgerArchiveObjectStore({ rootDirectory: objectRoot, kmsKeyId: 'dev:key' }),
      spoolDirectory: join(objectRoot, 'spool'),
    }).export({ segmentId: randomUUID(), source, lowerInclusive: 1n, upperExclusive: 2n, kmsKeyId: 'dev:key' });
    const jobs = createPostgresLedgerArchiveExportJobRepository(isolated.runtime.db);
    const job = await jobs.enqueue({ jobId: randomUUID(), segmentId: segment.segmentId });
    assert.equal(job.status, 'pending');
    const first = (await jobs.claimDue({ leaseOwner: 'worker-a', leaseDurationMs: 1_000 }))[0]!;
    await isolated.runtime.pool.query('select pg_sleep(1.05)');
    await assert.rejects(() => jobs.succeed(first),
      (error: unknown) => error instanceof LedgerArchiveExportJobError && error.stableCode === 'lease_fenced');
    const recovered = (await jobs.claimDue({ leaseOwner: 'worker-b', leaseDurationMs: 1_000 }))[0]!;
    assert.equal(recovered.leaseToken, first.leaseToken + 1n);
    const retry = await jobs.retry(recovered, 'provider_timeout', 0);
    assert.equal(retry.status, 'retryable');
    let exportedSegment: string | undefined;
    const worker = createLedgerArchiveExportWorker({
      jobs, leaseOwner: 'worker-c',
      exportSegment: async (segmentId) => { exportedSegment = segmentId; },
    });
    assert.equal(await worker.runOnce(), true);
    assert.equal(exportedSegment, segment.segmentId);
    assert.equal((await jobs.get(job.jobId))?.status, 'succeeded');

    await assert.rejects(() => isolated.runtime.pool.query('delete from ledger_archive_export_jobs where job_id=$1', [job.jobId]),
      (error: unknown) => (error as { constraint?: string }).constraint === 'ledger_archive_export_jobs_delete_guard');
    await assert.rejects(() => isolated.runtime.pool.query('truncate ledger_archive_export_jobs'),
      (error: unknown) => (error as { constraint?: string }).constraint === 'ledger_archive_export_jobs_truncate_guard');
  });

  test('verified cold read reports corruption instead of returning an empty collection', async () => {
    const segments = createPostgresLedgerArchiveSegmentRepository(isolated.runtime.db);
    const store = createFilesystemLedgerArchiveObjectStore({ rootDirectory: objectRoot, kmsKeyId: 'dev:key' });
    const source = fixtureSource(`corrupt:${randomUUID()}`, [{ key: 20n, payload: 'durable' }]);
    const segment = await createLedgerArchiveExporter({
      segments, objects: store, spoolDirectory: join(objectRoot, 'spool'),
    }).export({ segmentId: randomUUID(), source, lowerInclusive: 20n, upperExclusive: 21n, kmsKeyId: 'dev:key' });
    const key = new URL(segment.archiveObjectUri).pathname.replace(/^\//u, '');
    await truncate(join(objectRoot, ...key.split('/')), 5);
    let emitted = 0;
    await assert.rejects(
      () => createLedgerArchiveColdReader({ segments, objects: store, byteCeiling: 1_000_000n })
        .readRows(segment.segmentId, () => { emitted += 1; }),
      (error: unknown) => error instanceof LedgerArchiveColdReadError
        && error.stableCode === 'archive_object_corrupt',
    );
    assert.equal(emitted, 0);
    await assert.rejects(
      () => createLedgerArchiveColdReader({
        segments,
        objects: {
          uriForKey: (objectKey) => store.uriForKey(objectKey),
          async head() { throw new Error('unused'); },
          async read() {
            throw new LedgerArchiveObjectStoreError('not_found', 'archive_object_not_found', 'missing');
          },
        },
        byteCeiling: 1_000_000n,
      }).readRows(segment.segmentId, () => { throw new Error('must not emit'); }),
      (error: unknown) => error instanceof LedgerArchiveColdReadError
        && error.stableCode === 'archive_object_not_found',
    );
  });

  test('an existing object with a conflicting content ETag fails closed at HEAD binding', async () => {
    const segments = createPostgresLedgerArchiveSegmentRepository(isolated.runtime.db);
    let attempted: { key: string; byteLength: bigint; sha256: string; kmsKeyId: string } | undefined;
    const conflictingStore: LedgerArchiveObjectStore = {
      uriForKey: (key) => `s3://conflict-bucket/${key}`,
      async putCreateOnly(input) {
        attempted = input;
        throw new LedgerArchiveObjectStoreError('already_exists', 'archive_object_exists', 'exists');
      },
      async head(key) {
        assert.ok(attempted);
        return {
          key, uri: `s3://conflict-bucket/${key}`, byteLength: attempted.byteLength,
          sha256: attempted.sha256, contentEtag: `sha256:${'0'.repeat(64)}`,
          kmsKeyId: attempted.kmsKeyId,
        };
      },
      async read() { throw new Error('must not read a conflicting object'); },
    };
    const source = fixtureSource(`etag-conflict:${randomUUID()}`, [{ key: 30n, payload: 'immutable' }]);
    await assert.rejects(() => createLedgerArchiveExporter({
      segments, objects: conflictingStore, spoolDirectory: join(objectRoot, 'spool'),
    }).export({ segmentId: randomUUID(), source, lowerInclusive: 30n, upperExclusive: 31n, kmsKeyId: 'kms:key' }),
    (error: unknown) => error instanceof LedgerArchiveExportError
      && error.stableCode === 'archive_head_binding_mismatch');
  });

  test('migration 010700 rolls down and up without touching segment manifests', async () => {
    const smoke = await createIsolatedPostgresRuntime('ledger_archive_export_migration');
    try {
      const migrator = createMigrator(smoke.runtime.db, 'migrations', smoke.schema);
      const up = await migrator.migrateTo('202610010700_ledger_archive_export_jobs');
      assert.equal(up.error, undefined);
      assert.equal(await relationExists(smoke, 'ledger_archive_export_jobs'), true);
      const down = await migrator.migrateDown();
      assert.equal(down.error, undefined);
      assert.equal(await relationExists(smoke, 'ledger_archive_export_jobs'), false);
      assert.equal(await relationExists(smoke, 'ledger_archive_segments'), true);
      const forward = await migrator.migrateUp();
      assert.equal(forward.error, undefined);
      assert.equal(await relationExists(smoke, 'ledger_archive_export_jobs'), true);
    } finally {
      await smoke.close();
    }
  }, 120_000);
});

function fixtureSource(scope: string, rows: readonly SourceRow[]): LedgerArchiveSource<SourceRow> {
  return Object.freeze({
    ledgerFamily: 'operations', sourceRelation: 'public.operations', sourceScope: scope,
    keyOf: (row) => row.key,
    archiveValue: (row) => ({ payload: row.payload }),
    async readPage(input) {
      const eligible = rows.filter((row) => row.key >= input.bounds.lowerInclusive
        && row.key < input.bounds.upperExclusive
        && (input.afterExclusive === undefined || row.key > input.afterExclusive));
      return Object.freeze({
        rows: Object.freeze(eligible.slice(0, input.limit)), hasMore: eligible.length > input.limit,
      });
    },
  });
}

async function relationExists(runtime: IsolatedPostgresRuntime, relation: string): Promise<boolean> {
  const result = await runtime.runtime.pool.query<{ present: boolean }>(
    'select to_regclass($1) is not null as present', [relation],
  );
  return result.rows[0]?.present ?? false;
}
