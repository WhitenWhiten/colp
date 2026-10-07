import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, test } from 'vitest';
import { sql } from 'kysely';
import { loadLedgerArchiveReaderRuntimeConfig } from '../../../src/bootstrap/config-ledger-archive-reader.js';
import { composeLedgerArchiveColdReaders } from '../../../src/bootstrap/ledger-archive-reader-composition.js';

import {
  appendOperationWithPayload,
  createPostgresLedgerArchiveSegmentRepository,
  runMigrations,
  readOperationPayload,
} from '../../../src/infrastructure/database/index.js';
import {
  applyLedgerPayloadPurgeBatch,
} from '../../../src/infrastructure/database/ledger-payload-purge.js';
import { createPostgresLedgerPayloadPurgeJobRepository } from '../../../src/infrastructure/database/ledger-payload-purge-job-repository.js';
import {
  createFilesystemLedgerArchiveObjectStore,
  createLedgerArchiveExporter,
  createPostgresOperationLedgerArchiveSource,
  type LedgerArchiveSource,
} from '../../../src/infrastructure/ledger-archive/index.js';
import { waitForCondition } from '../../support/async-test-helpers.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';
import {
  applyAsExecutor,
  enqueueAndClaim,
  provisionRoles,
  seedCollection,
  transitionReaderCutover,
} from '../../support/ledger-payload-purge-postgres.js';

describeWithPostgres('fenced ledger payload purge legal-hold serialization', () => {
  let isolated: IsolatedPostgresRuntime;
  let executorRole: string;
  let ordinaryRole: string;
  let archiveRoot: string;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('ledger_payload_purge_hold');
    await runMigrations(isolated.runtime.db, 'latest');
    archiveRoot = await mkdtemp(join(tmpdir(), 'known-ledger-purge-hold-'));
    executorRole = `payload_purger_${randomUUID().replaceAll('-', '_')}`;
    ordinaryRole = `payload_ordinary_${randomUUID().replaceAll('-', '_')}`;
    await provisionRoles(isolated, executorRole, ordinaryRole);
  }, 120_000);

  afterAll(async () => {
    if (!isolated) return;
    await isolated.runtime.pool.query(`DROP OWNED BY ${executorRole},${ordinaryRole}`);
    await isolated.runtime.pool.query(`DROP ROLE IF EXISTS ${executorRole},${ordinaryRole}`);
    await isolated.close();
    await rm(archiveRoot, { recursive: true, force: true });
  });

  test('a batch that starts after a committed legal hold deletes zero rows', async () => {
    const seeded = await seedHotOperationSegment();
    const claim = await enqueueAndClaim(isolated, executorRole, {
      segmentId: seeded.segmentId, family: 'operation', scopeKey: seeded.collectionId,
      lower: 1n, upper: 3n, floorOrdinal: 2n,
      floorTieBreaker: seeded.boundaryOperationId, floorRevision: 1n,
    });
    for (const gate of [
      { nodeEnvironment: 'production', destructiveMode: 'development' },
      { nodeEnvironment: 'test', destructiveMode: 'disabled' },
    ]) {
      await assert.rejects(() => isolated.runtime.db.transaction().execute((transaction) =>
        applyLedgerPayloadPurgeBatch(transaction, {
          claim, confirmedSegmentId: seeded.segmentId, batchSize: 1, ...gate,
        })), (error: unknown) => (error as { stableCode?: string }).stableCode
          === 'destructive_mode_disabled');
    }
    await isolated.runtime.pool.query(`update ledger_archive_segments
      set legal_hold=true, state_revision=state_revision+1 where segment_id=$1`,
    [seeded.segmentId]);
    await assert.rejects(() => applyAsExecutor(isolated, executorRole, claim),
      (error: unknown) => (error as { stableCode?: string }).stableCode === 'job_binding_mismatch');
    assert.equal(await hotPayloadCount(seeded.operationId), 1);
    assert.equal(await hotPayloadCount(seeded.boundaryOperationId), 1);
    const job = await createPostgresLedgerPayloadPurgeJobRepository(isolated.runtime.db).get(claim.jobId);
    assert.equal(job?.deletedRowCount, 0n);
    assert.equal(job?.status, 'running');
  });

  test('an in-progress batch and a legal hold serialize, and a committed delete stays readable', async () => {
    const seeded = await seedHotOperationSegment();
    const claim = await enqueueAndClaim(isolated, executorRole, {
      segmentId: seeded.segmentId, family: 'operation', scopeKey: seeded.collectionId,
      lower: 1n, upper: 3n, floorOrdinal: 2n,
      floorTieBreaker: seeded.boundaryOperationId, floorRevision: 1n,
    });
    const holding = gate();
    const release = gate();
    let batchPid = 0;
    const batch = isolated.runtime.db.transaction().execute(async (transaction) => {
      try {
        await sql.raw(`set local session authorization ${executorRole}`).execute(transaction);
        await sql`select set_config('application_name', 'purge-u11-batch-holder', true)`.execute(transaction);
        await sql`select set_config('statement_timeout', '0', true)`.execute(transaction);
        const applied = await applyLedgerPayloadPurgeBatch(transaction, {
          claim, confirmedSegmentId: seeded.segmentId, nodeEnvironment: 'test',
          destructiveMode: 'development', batchSize: 1,
        });
        batchPid = Number((await sql<{ pid: string | number }>`select pg_backend_pid() pid`
          .execute(transaction)).rows[0]?.pid);
        return applied;
      } finally {
        holding.resolve();
        await release.promise;
      }
    });
    const holder = await isolated.runtime.pool.connect();
    let holdUpdate: Promise<unknown> = Promise.resolve();
    let committed = false;
    try {
      await holding.promise;
      assert.ok(batchPid > 0);
      await holder.query('begin');
      await holder.query("select set_config('statement_timeout', '0', true)");
      await holder.query("select set_config('application_name', 'purge-u11-hold-waiter', true)");
      const holdPid = Number((await holder.query<{ pid: string | number }>('select pg_backend_pid() pid')).rows[0]?.pid);
      holdUpdate = holder.query(`update ledger_archive_segments
        set legal_hold=true, state_revision=state_revision+1 where segment_id=$1`, [seeded.segmentId]);
      await waitForCondition(
        () => blockedBy('purge-u11-hold-waiter', batchPid),
        { timeoutMs: 8_000, pollIntervalMs: 10, description: 'legal hold to wait on the in-progress purge batch' },
      );
      assert.equal(await holdsRelation(batchPid, 'ledger_payload_purge_jobs'), true);
      assert.equal(await holdsRelation(batchPid, 'ledger_archive_segments'), true);
      assert.equal(await holdsRelation(holdPid, 'ledger_payload_purge_jobs'), false);
      release.resolve();
      const applied = await batch;
      assert.equal(applied.status, 'retryable');
      assert.equal(applied.deletedThisBatch, 1n);
      await holdUpdate;
      await holder.query('commit');
      committed = true;
    } finally {
      release.resolve();
      await Promise.allSettled([batch, holdUpdate]);
      if (!committed) await holder.query('rollback').catch(() => undefined);
      await holder.query('reset application_name').catch(() => undefined);
      holder.release();
    }
    assert.equal(await hotPayloadCount(seeded.operationId), 0);
    assert.equal(await hotPayloadCount(seeded.boundaryOperationId), 1);
    assert.deepEqual(await readArchivedPayload(seeded.operationId), { marker: 'first' });
    await assert.rejects(() => createPostgresLedgerPayloadPurgeJobRepository(isolated.runtime.db)
      .claimSegment({ segmentId: seeded.segmentId, leaseOwner: executorRole, leaseDurationMs: 300_000 }),
    (error: unknown) => constraintOf(error) === 'ledger_payload_purge_jobs_manifest_not_ready');
    assert.equal(await hotPayloadCount(seeded.operationId), 0);
    assert.deepEqual(await readArchivedPayload(seeded.operationId), { marker: 'first' });
  });

  test('a hold that owns the segment blocks the batch until commit, and that batch deletes nothing', async () => {
    const seeded = await seedHotOperationSegment();
    const claim = await enqueueAndClaim(isolated, executorRole, {
      segmentId: seeded.segmentId, family: 'operation', scopeKey: seeded.collectionId,
      lower: 1n, upper: 3n, floorOrdinal: 2n,
      floorTieBreaker: seeded.boundaryOperationId, floorRevision: 1n,
    });
    const holder = await isolated.runtime.pool.connect();
    let holdCommitted = false;
    let batch: Promise<unknown> = Promise.resolve();
    try {
      await holder.query('begin');
      await holder.query("select set_config('statement_timeout', '0', true)");
      await holder.query(`update ledger_archive_segments
        set legal_hold=true, state_revision=state_revision+1 where segment_id=$1`, [seeded.segmentId]);
      const holdPid = Number((await holder.query<{ pid: string | number }>('select pg_backend_pid() pid')).rows[0]?.pid);
      batch = isolated.runtime.db.transaction().execute(async (transaction) => {
        await sql.raw(`set local session authorization ${executorRole}`).execute(transaction);
        await sql`select set_config('application_name', 'purge-u11-batch-waiter', true)`.execute(transaction);
        await sql`select set_config('statement_timeout', '0', true)`.execute(transaction);
        return applyLedgerPayloadPurgeBatch(transaction, {
          claim, confirmedSegmentId: seeded.segmentId, nodeEnvironment: 'test',
          destructiveMode: 'development', batchSize: 1,
        });
      });
      await waitForCondition(
        () => blockedBy('purge-u11-batch-waiter', holdPid),
        { timeoutMs: 8_000, pollIntervalMs: 10, description: 'purge batch to wait for the uncommitted legal hold' },
      );
      const batchPid = Number((await isolated.runtime.pool.query<{ pid: string | number }>(
        `select pid from pg_stat_activity where application_name='purge-u11-batch-waiter'`,
      )).rows[0]?.pid);
      assert.equal(await holdsRelation(batchPid, 'ledger_payload_purge_jobs'), true);
      assert.equal(await holdsRelation(holdPid, 'ledger_archive_segments'), true);
      assert.equal(await holdsRelation(holdPid, 'ledger_payload_purge_jobs'), false);
      await holder.query('commit');
      holdCommitted = true;
      await assert.rejects(batch, (error: unknown) =>
        (error as { stableCode?: string }).stableCode === 'job_binding_mismatch');
    } finally {
      if (!holdCommitted) await holder.query('rollback').catch(() => undefined);
      await holder.query('reset application_name').catch(() => undefined);
      holder.release();
      await Promise.allSettled([batch]);
    }
    assert.equal(await hotPayloadCount(seeded.operationId), 1);
    assert.equal(await hotPayloadCount(seeded.boundaryOperationId), 1);
  });

  test('a batch blocked on the job lock has not taken the segment, so claim can share it', async () => {
    const seeded = await seedHotOperationSegment();
    const claim = await enqueueAndClaim(isolated, executorRole, {
      segmentId: seeded.segmentId, family: 'operation', scopeKey: seeded.collectionId,
      lower: 1n, upper: 3n, floorOrdinal: 2n,
      floorTieBreaker: seeded.boundaryOperationId, floorRevision: 1n,
    });
    const holder = await isolated.runtime.pool.connect();
    let batch: Promise<unknown> = Promise.resolve();
    try {
      await holder.query('begin');
      await holder.query("select set_config('statement_timeout', '5000', true)");
      await holder.query(
        'select job_id from ledger_payload_purge_jobs where job_id=$1 for update',
        [claim.jobId],
      );
      const holdPid = Number((await holder.query<{ pid: string | number }>('select pg_backend_pid() pid')).rows[0]?.pid);
      batch = isolated.runtime.db.transaction().execute(async (transaction) => {
        await sql.raw(`set local session authorization ${executorRole}`).execute(transaction);
        await sql`select set_config('application_name', 'purge-u11-claim-order', true)`.execute(transaction);
        await sql`select set_config('statement_timeout', '0', true)`.execute(transaction);
        return applyLedgerPayloadPurgeBatch(transaction, {
          claim, confirmedSegmentId: seeded.segmentId, nodeEnvironment: 'test',
          destructiveMode: 'development', batchSize: 1,
        });
      });
      await waitForCondition(
        () => blockedBy('purge-u11-claim-order', holdPid),
        { timeoutMs: 8_000, pollIntervalMs: 10, description: 'purge batch to wait on the claim job lock' },
      );
      const batchPid = Number((await isolated.runtime.pool.query<{ pid: string | number }>(
        `select pid from pg_stat_activity where application_name='purge-u11-claim-order'`,
      )).rows[0]?.pid);
      assert.equal(await holdsRelation(batchPid, 'ledger_archive_segments'), false);
      assert.equal(await holdsRelation(holdPid, 'ledger_archive_segments'), false);
      assert.equal(await holdsRelation(holdPid, 'ledger_payload_purge_jobs'), true);
      await holder.query(
        'select segment_id from ledger_archive_segments where segment_id=$1 for share',
        [seeded.segmentId],
      );
      await holder.query('commit');
      await batch;
      assert.equal(await hotPayloadCount(seeded.operationId), 0);
    } finally {
      await holder.query('rollback').catch(() => undefined);
      await holder.query('reset application_name').catch(() => undefined);
      holder.release();
      await Promise.allSettled([batch]);
    }
  });

  async function seedHotOperationSegment(): Promise<{
    collectionId: string;
    operationId: string;
    boundaryOperationId: string;
    segmentId: string;
  }> {
    const collectionId = `purge-hold-${randomUUID()}`;
    const operationId = `purge-op-${randomUUID()}`;
    const boundaryOperationId = `purge-op-${randomUUID()}`;
    await seedCollection(isolated, collectionId, `purge-root-${randomUUID()}`);
    await appendHotOperation(collectionId, operationId, 1n, 'first');
    await appendHotOperation(collectionId, boundaryOperationId, 2n, 'boundary');
    const segmentId = await exportVerifiedSegment(
      await createPostgresOperationLedgerArchiveSource(isolated.runtime.db, `collection:${collectionId}`),
      1n, 3n,
    );
    await isolated.runtime.pool.query(`update sync_history_floors set
      floor_commit_ordinal=2,floor_stable_id=$2,archive_segment_id=$3,state_revision=1
      where collection_id=$1`, [collectionId, boundaryOperationId, segmentId]);
    await transitionReaderCutover(isolated, segmentId);
    return { collectionId, operationId, boundaryOperationId, segmentId };
  }

  async function appendHotOperation(
    collectionId: string,
    operationId: string,
    ordinal: bigint,
    marker: string,
  ): Promise<void> {
    await isolated.runtime.pool.query(
      `insert into resource_id_ledger(resource_id,resource_type) values($1,'operation')`,
      [operationId],
    );
    await isolated.runtime.db.transaction().execute((transaction) => appendOperationWithPayload(
      transaction,
      {
        operationId, collectionId, commitOrdinal: ordinal, operationType: 'ledger.note',
        payloadJson: { marker },
        syncWireJson: { opId: operationId, collectionId }, actorPrincipalId: null,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      },
    ));
  }

  async function hotPayloadCount(operationId: string): Promise<number> {
    const result = await isolated.runtime.pool.query<{ count: number }>(
      'select count(*)::int count from operation_payloads where operation_id=$1',
      [operationId],
    );
    return result.rows[0]!.count;
  }

  async function readArchivedPayload(operationId: string): Promise<unknown> {
    const operation = (await isolated.runtime.pool.query<{
      collection_id: string; commit_ordinal: string; payload_source: 'archive';
      payload_locator: string; payload_digest_sha256: string; payload_bytes: string;
      payload_schema_version: 1; payload_bucket: string; sync_wire_present: boolean;
    }>(`select collection_id,commit_ordinal::text,payload_source,payload_locator,
        payload_digest_sha256,payload_bytes::text,payload_schema_version,
        payload_bucket::text,sync_wire_present from operations where operation_id=$1`,
    [operationId])).rows[0]!;
    const cold = await isolated.runtime.db.transaction().execute((transaction) => readOperationPayload(
      transaction,
      {
        operationId, collectionId: operation.collection_id,
        commitOrdinal: BigInt(operation.commit_ordinal), source: operation.payload_source,
        locator: operation.payload_locator, digestSha256: operation.payload_digest_sha256,
        byteCount: BigInt(operation.payload_bytes), schemaVersion: operation.payload_schema_version,
        bucket: operation.payload_bucket, syncWirePresent: operation.sync_wire_present,
      },
      composedColdReaders().operationPayloadSource,
    ));
    return cold.payloadJson;
  }

  async function blockedBy(applicationName: string, blockerPid: number): Promise<boolean> {
    const result = await isolated.runtime.pool.query<{ waiting: boolean }>(
      `select exists (
         select 1 from pg_stat_activity
         where application_name=$1 and $2::int = any(pg_blocking_pids(pid))
       ) waiting`,
      [applicationName, blockerPid],
    );
    return result.rows[0]?.waiting === true;
  }

  async function holdsRelation(pid: number, relation: string): Promise<boolean> {
    const result = await isolated.runtime.pool.query<{ held: boolean }>(
      `select exists (
         select 1 from pg_locks lock
         join pg_class class on class.oid = lock.relation
         where lock.pid=$1 and class.relname=$2
           and lock.locktype='relation' and lock.granted
       ) held`,
      [pid, relation],
    );
    return result.rows[0]?.held === true;
  }

  function composedColdReaders() {
    const sources = composeLedgerArchiveColdReaders({
      config: loadLedgerArchiveReaderRuntimeConfig({
        LEDGER_ARCHIVE_READ_ENABLED: 'true',
        LEDGER_ARCHIVE_STORE: 'filesystem',
        LEDGER_ARCHIVE_FILESYSTEM_ROOT: archiveRoot,
        LEDGER_ARCHIVE_KMS_KEY_ID: 'dev:payload-purge-e2e',
      }, 'test'),
      database: isolated.runtime,
    });
    if (!sources) throw new Error('cold reader composition was unexpectedly disabled');
    return sources;
  }

  async function exportVerifiedSegment<Row>(
    source: LedgerArchiveSource<Row>,
    lowerInclusive: bigint,
    upperExclusive: bigint,
  ): Promise<string> {
    const segmentId = randomUUID();
    const store = createFilesystemLedgerArchiveObjectStore({
      rootDirectory: archiveRoot, kmsKeyId: 'dev:payload-purge-e2e',
    });
    const exporter = createLedgerArchiveExporter({
      segments: createPostgresLedgerArchiveSegmentRepository(isolated.runtime.db),
      objects: store, spoolDirectory: join(archiveRoot, 'spool'),
      pageSize: 10, byteCeiling: 10_000_000n,
    });
    const segment = await exporter.export({
      segmentId, source, lowerInclusive, upperExclusive,
      kmsKeyId: 'dev:payload-purge-e2e',
    });
    assert.equal(segment.state, 'verified');
    return segmentId;
  }
});

function gate(): { readonly promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function constraintOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const record = error as { constraint?: unknown; cause?: unknown };
  if (typeof record.constraint === 'string') return record.constraint;
  return constraintOf(record.cause);
}
