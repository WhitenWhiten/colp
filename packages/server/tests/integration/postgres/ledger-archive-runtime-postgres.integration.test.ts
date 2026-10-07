import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, test } from 'vitest';

import { loadLedgerArchiveRuntimeConfig } from '../../../src/bootstrap/config-ledger-archive.js';
import { composeLedgerArchiveWorker } from '../../../src/bootstrap/ledger-archive-worker-composition.js';
import {
  createPostgresLedgerArchiveExportJobRepository,
  LedgerArchiveExportJobError,
} from '../../../src/infrastructure/database/ledger-archive-export-job-repository.js';
import { createPostgresLedgerArchiveSegmentRepository } from '../../../src/infrastructure/database/ledger-archive-segment-repository.js';
import { runMigrations } from '../../../src/infrastructure/database/migrations.js';
import { appendOperationWithPayload } from '../../../src/infrastructure/database/operation-payload-store.js';
import {
  createFilesystemLedgerArchiveObjectStore,
  createPostgresOperationLedgerArchiveSource,
  encodeLedgerArchiveV1,
  readLedgerArchiveSourceRows,
  type LedgerArchiveSource,
} from '../../../src/infrastructure/ledger-archive/index.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';

interface FixtureRow { readonly key: bigint; readonly payload: string }

describeWithPostgres('ledger archive job state machine and filesystem runtime', () => {
  let isolated: IsolatedPostgresRuntime;
  let objectRoot: string;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('ledger_archive_runtime', { maxConnections: 4 });
    await runMigrations(isolated.runtime.db, 'latest');
    objectRoot = await mkdtemp(join(tmpdir(), 'known-ledger-runtime-'));
  }, 120_000);

  afterAll(async () => {
    await isolated?.close();
    if (objectRoot) await rm(objectRoot, { recursive: true, force: true });
    if (objectRoot) await rm(`${objectRoot}-spool`, { recursive: true, force: true });
  });

  test('direct SQL cannot skip states and repository success requires verified segment', async () => {
    const segments = createPostgresLedgerArchiveSegmentRepository(isolated.runtime.db);
    const segment = await segments.create(manifest(`state:${randomUUID()}`));
    const jobs = createPostgresLedgerArchiveExportJobRepository(isolated.runtime.db);
    const job = await jobs.enqueue({ jobId: randomUUID(), segmentId: segment.segmentId });

    await expectConstraint(
      `update ledger_archive_export_jobs set status='succeeded', completed_at=current_timestamp where job_id=$1`,
      job.jobId,
      'ledger_archive_export_jobs_transition_guard',
    );
    await expectConstraint(
      'update ledger_archive_export_jobs set attempt_count=attempt_count+1 where job_id=$1',
      job.jobId,
      'ledger_archive_export_jobs_transition_guard',
    );

    const claim = (await jobs.claimDue({ leaseOwner: 'gate-worker', leaseDurationMs: 10_000 }))[0]!;
    await assert.rejects(
      () => jobs.succeed(claim),
      (error: unknown) => error instanceof LedgerArchiveExportJobError
        && error.stableCode === 'segment_not_verified',
    );
    let current = segment;
    for (const targetState of ['sealed', 'exported', 'verified'] as const) {
      current = await segments.transition({
        segmentId: current.segmentId,
        expectedState: current.state,
        expectedRevision: current.stateRevision,
        targetState,
        evidence: { test: targetState },
      });
    }
    assert.equal((await jobs.succeed(claim)).status, 'succeeded');
    await expectConstraint(
      `update ledger_archive_export_jobs set status='running', lease_owner='reopen',
       lease_token=lease_token+1, lease_expires_at=current_timestamp+interval '1 minute',
       attempt_count=attempt_count+1, completed_at=null where job_id=$1`,
      job.jobId,
      'ledger_archive_export_jobs_transition_guard',
    );
  });

  test('an expired lease is reclaimed and the stale fence cannot finish', async () => {
    const segments = createPostgresLedgerArchiveSegmentRepository(isolated.runtime.db);
    const segment = await segments.create(manifest(`lease:${randomUUID()}`));
    const jobs = createPostgresLedgerArchiveExportJobRepository(isolated.runtime.db);
    const job = await jobs.enqueue({ jobId: randomUUID(), segmentId: segment.segmentId });
    const stale = (await jobs.claimDue({ leaseOwner: 'stale-worker', leaseDurationMs: 1_000 }))[0]!;
    await isolated.runtime.pool.query('select pg_sleep(1.05)');
    const reclaimed = (await jobs.claimDue({ leaseOwner: 'new-worker', leaseDurationMs: 10_000 }))[0]!;
    assert.equal(reclaimed.leaseToken, stale.leaseToken + 1n);
    assert.equal(reclaimed.attemptCount, stale.attemptCount + 1);
    await assert.rejects(
      () => jobs.retry(stale, 'stale_worker', 0),
      (error: unknown) => error instanceof LedgerArchiveExportJobError
        && error.stableCode === 'lease_fenced',
    );
    assert.equal((await jobs.fail(reclaimed, 'lease_test_complete')).status, 'failed');
  });

  test('filesystem composition exports, reads back for verification, and completes its job', async () => {
    const rows = [{ key: 10n, payload: 'first' }, { key: 12n, payload: 'last' }] as const;
    const source = fixtureSource(`runtime:${randomUUID()}`, rows);
    const encodedChunks: Buffer[] = [];
    const summary = await encodeLedgerArchiveV1({
      ledgerFamily: source.ledgerFamily,
      sourceRelation: source.sourceRelation,
      sourceScope: source.sourceScope,
      lowerInclusive: 10n,
      upperExclusive: 13n,
    }, (async function* () {
      for (const row of rows) yield { key: row.key, value: { payload: row.payload } };
    })(), async (chunk) => { encodedChunks.push(Buffer.from(chunk)); }, { byteCeiling: 1_000_000n });
    assert.equal(BigInt(Buffer.concat(encodedChunks).byteLength), summary.byteLength);

    const kmsKeyId = 'dev:runtime-key';
    const store = createFilesystemLedgerArchiveObjectStore({ rootDirectory: objectRoot, kmsKeyId });
    const objectKey = archiveKey(source.ledgerFamily, source.sourceScope, 10n, 13n, summary.contentDigest);
    const segments = createPostgresLedgerArchiveSegmentRepository(isolated.runtime.db);
    const segment = await segments.create({
      segmentId: randomUUID(), ledgerFamily: source.ledgerFamily,
      sourceRelation: source.sourceRelation, sourceScope: source.sourceScope,
      sourceKeyKind: 'bigint', sourceKeyComparator: 'signed-bigint-ascending-v1',
      sourceKeyBounds: { lowerInclusive: 10n, upperExclusive: 13n },
      rowCount: summary.rowCount, sourceBytes: summary.byteLength,
      contentDigest: summary.contentDigest, archiveObjectUri: store.uriForKey(objectKey),
      archiveObjectEtag: summary.contentDigest, archiveSchemaVersion: 1, kmsKeyId,
    });
    const jobs = createPostgresLedgerArchiveExportJobRepository(isolated.runtime.db);
    const job = await jobs.enqueue({ jobId: randomUUID(), segmentId: segment.segmentId });
    const worker = composeLedgerArchiveWorker({
      config: loadLedgerArchiveRuntimeConfig({
        LEDGER_ARCHIVE_WORKER_ENABLED: 'true',
        LEDGER_ARCHIVE_STORE: 'filesystem',
        LEDGER_ARCHIVE_FILESYSTEM_ROOT: objectRoot,
        LEDGER_ARCHIVE_SPOOL_DIR: `${objectRoot}-spool`,
        LEDGER_ARCHIVE_KMS_KEY_ID: kmsKeyId,
      }, 'test'),
      database: isolated.runtime,
      resolveSource: async () => source as unknown as LedgerArchiveSource<unknown>,
      workerId: 'filesystem-runtime-test',
    });
    assert.ok(worker);
    assert.equal(await worker.tick(), true);
    assert.equal((await segments.get(segment.segmentId))?.state, 'verified');
    assert.equal((await jobs.get(job.jobId))?.status, 'succeeded');
  });

  test('one production worker resolves and exports jobs for two Collections, then rejects bad scope', async () => {
    const kmsKeyId = 'dev:multi-collection';
    const store = createFilesystemLedgerArchiveObjectStore({ rootDirectory: objectRoot, kmsKeyId });
    const segments = createPostgresLedgerArchiveSegmentRepository(isolated.runtime.db);
    const jobs = createPostgresLedgerArchiveExportJobRepository(isolated.runtime.db);
    const jobIds: string[] = [];
    for (const suffix of ['first', 'second']) {
      const collectionId = `runtime-${suffix}-${randomUUID()}`;
      await seedCollection(collectionId, `runtime-root-${randomUUID()}`);
      const operationId = `runtime-operation-${randomUUID()}`;
      await isolated.runtime.pool.query(`insert into resource_id_ledger(resource_id,resource_type)
        values($1,'operation')`, [operationId]);
      await isolated.runtime.db.transaction().execute((transaction) => appendOperationWithPayload(transaction, {
        operationId, collectionId, commitOrdinal: 1n, operationType: 'runtime.archive',
        payloadJson: { collectionId, suffix }, actorPrincipalId: null,
      }));
      const source = await createPostgresOperationLedgerArchiveSource(
        isolated.runtime.db, `collection:${collectionId}`,
      );
      const summary = await encodeLedgerArchiveV1({
        ledgerFamily: source.ledgerFamily, sourceRelation: source.sourceRelation,
        sourceScope: source.sourceScope, lowerInclusive: 1n, upperExclusive: 2n,
      }, readLedgerArchiveSourceRows(source, { lowerInclusive: 1n, upperExclusive: 2n }, {
        pageSize: 10,
      }), async () => {}, { byteCeiling: 1_000_000n });
      const key = archiveKey(source.ledgerFamily, source.sourceScope, 1n, 2n, summary.contentDigest);
      const segment = await segments.create({
        segmentId: randomUUID(), ledgerFamily: source.ledgerFamily,
        sourceRelation: source.sourceRelation, sourceScope: source.sourceScope,
        sourceKeyKind: 'bigint', sourceKeyComparator: 'signed-bigint-ascending-v1',
        sourceKeyBounds: { lowerInclusive: 1n, upperExclusive: 2n },
        rowCount: summary.rowCount, sourceBytes: summary.byteLength,
        contentDigest: summary.contentDigest, archiveObjectUri: store.uriForKey(key),
        archiveObjectEtag: summary.contentDigest, archiveSchemaVersion: 1, kmsKeyId,
      });
      jobIds.push((await jobs.enqueue({ jobId: randomUUID(), segmentId: segment.segmentId })).jobId);
    }
    const worker = composeLedgerArchiveWorker({
      config: filesystemConfig(objectRoot, kmsKeyId), database: isolated.runtime,
      workerId: 'multi-collection-runtime-test',
    });
    assert.ok(worker);
    assert.equal(await worker.tick(), true);
    assert.equal(await worker.tick(), true);
    assert.deepEqual(await Promise.all(jobIds.map(async (jobId) => (await jobs.get(jobId))?.status)), [
      'succeeded', 'succeeded',
    ]);

    const invalidSegment = await segments.create({
      ...manifest(`bad-scope:${randomUUID()}`),
      ledgerFamily: 'operation', sourceRelation: 'public.operation_payloads', sourceScope: 'global',
    });
    const invalidJob = await jobs.enqueue({ jobId: randomUUID(), segmentId: invalidSegment.segmentId });
    assert.equal(await worker.tick(), true);
    assert.deepEqual({
      status: (await jobs.get(invalidJob.jobId))?.status,
      error: (await jobs.get(invalidJob.jobId))?.lastErrorClass,
    }, { status: 'failed', error: 'archive_source_scope_invalid' });
  });

  async function expectConstraint(query: string, id: string, constraint: string): Promise<void> {
    await assert.rejects(
      () => isolated.runtime.pool.query(query, [id]),
      (error: unknown) => (error as { constraint?: unknown }).constraint === constraint,
    );
  }

  async function seedCollection(collectionId: string, rootId: string): Promise<void> {
    const client = await isolated.runtime.pool.connect();
    try {
      await client.query('begin');
      await client.query(`insert into resource_id_ledger(resource_id,resource_type)
        values($1,'collection'),($2,'node')`, [collectionId, rootId]);
      await client.query(`insert into collections(id,owner_subject_id,title,kind,
        root_node_id,resource_revision,content_revision,policy_revision)
        values($1,'runtime-owner','Runtime','bookmarks',$2,'r1','c1','p1')`, [collectionId, rootId]);
      await client.query(`insert into nodes(id,collection_id,kind,is_root,title,
        resource_revision,children_revision) values($1,$2,'folder',true,'Root','r1','ch1')`,
      [rootId, collectionId]);
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }
});

function filesystemConfig(root: string, kmsKeyId: string) {
  return loadLedgerArchiveRuntimeConfig({
    LEDGER_ARCHIVE_WORKER_ENABLED: 'true',
    LEDGER_ARCHIVE_STORE: 'filesystem',
    LEDGER_ARCHIVE_FILESYSTEM_ROOT: root,
    LEDGER_ARCHIVE_SPOOL_DIR: `${root}-spool`,
    LEDGER_ARCHIVE_KMS_KEY_ID: kmsKeyId,
  }, 'test');
}

function manifest(scope: string) {
  const segmentId = randomUUID();
  return {
    segmentId, ledgerFamily: 'operations', sourceRelation: 'public.operations', sourceScope: scope,
    sourceKeyKind: 'bigint' as const, sourceKeyComparator: 'signed-bigint-ascending-v1' as const,
    sourceKeyBounds: { lowerInclusive: 1n, upperExclusive: 2n }, rowCount: 1n, sourceBytes: 10n,
    contentDigest: `sha256:${'1'.repeat(64)}`,
    archiveObjectUri: `s3://known-ledger-test/ledger-archives/v1/operations/${segmentId}.jsonl`,
    archiveObjectEtag: `sha256:${'1'.repeat(64)}`, archiveSchemaVersion: 1, kmsKeyId: 'dev:key',
  };
}

function fixtureSource(scope: string, rows: readonly FixtureRow[]): LedgerArchiveSource<FixtureRow> {
  return Object.freeze({
    ledgerFamily: 'operations', sourceRelation: 'public.operations', sourceScope: scope,
    keyOf: (row: FixtureRow) => row.key,
    archiveValue: (row: FixtureRow) => ({ payload: row.payload }),
    async readPage(input) {
      const eligible = rows.filter((row) => row.key >= input.bounds.lowerInclusive
        && row.key < input.bounds.upperExclusive
        && (input.afterExclusive === undefined || row.key > input.afterExclusive));
      return { rows: eligible.slice(0, input.limit), hasMore: eligible.length > input.limit };
    },
  });
}

function archiveKey(
  ledgerFamily: string,
  sourceScope: string,
  lower: bigint,
  upper: bigint,
  digest: string,
): string {
  const scope = createHash('sha256').update(sourceScope).digest('hex').slice(0, 24);
  return `ledger-archives/v1/${ledgerFamily}/${scope}/${lower}-${upper}-${digest.slice(7)}.jsonl`;
}
