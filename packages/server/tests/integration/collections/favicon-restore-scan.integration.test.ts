import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, test } from 'vitest';
import { createUnitOfWork, runMigrations } from '../../../src/infrastructure/database/index.js';
import {
  createPostgresFaviconJobWorkerRepository,
  createPostgresFaviconJobWorkerUnitOfWork,
  insertFaviconJobRow,
} from '../../../src/infrastructure/collections/favicon-job-postgres.js';
import {
  createPostgresFaviconBatchItemPort,
  createPostgresFaviconBatchWritePorts,
} from '../../../src/infrastructure/collections/favicon-job-items-postgres.js';
import {
  FAVICON_RESTORE_SCAN_LIMIT,
  type FaviconRestoreReadObserver,
} from '../../../src/infrastructure/collections/favicon-restore-scan-postgres.js';
import { insertPolicyBatchJob } from '../../../src/modules/collections/application/favicon-batch-job.js';
import { processFaviconBatchClaim } from '../../../src/modules/collections/application/favicon-batch-execution.js';
import type { FaviconFetcher, FaviconJobClaim } from '../../../src/modules/collections/application/favicon-job-execution.js';
import { DEFAULT_FAVICON_PROVIDER_TEMPLATE } from '../../../src/modules/collections/application/favicon-policy.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';

// The test owns and resets its samples; no production module retains them.
const faviconRestoreReadProbe = {
  maxScanSummaryRows: 0, maxGapSummaryRows: 0, maxAggregateSummaryRows: 0,
  readCounts: [] as number[], gapCounts: [] as number[],
};
function resetFaviconRestoreReadProbe() {
  Object.assign(faviconRestoreReadProbe, {
    maxScanSummaryRows: 0, maxGapSummaryRows: 0, maxAggregateSummaryRows: 0, readCounts: [], gapCounts: [],
  });
}
const observeRestoreRead: FaviconRestoreReadObserver = sample => {
  if (sample.kind === 'scan') {
    faviconRestoreReadProbe.maxScanSummaryRows = Math.max(faviconRestoreReadProbe.maxScanSummaryRows, sample.summaryRows);
    faviconRestoreReadProbe.readCounts.push(sample.readCount);
  } else if (sample.kind === 'gap') {
    faviconRestoreReadProbe.maxGapSummaryRows = Math.max(faviconRestoreReadProbe.maxGapSummaryRows, sample.summaryRows);
    faviconRestoreReadProbe.gapCounts.push(sample.readCount);
  } else {
    faviconRestoreReadProbe.maxAggregateSummaryRows = Math.max(faviconRestoreReadProbe.maxAggregateSummaryRows, sample.summaryRows);
  }
};

const ACCOUNT_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SUBJECT_ID = 'restore-scan-owner';
const SUCCESS_ACCOUNT = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const SUCCESS_SUBJECT = 'restore-scan-success';
const LEASE = 'restore-scan-lease';
const BULK_OBJECT = '11111111-1111-4111-8111-111111111111';
const LATE_OBJECT = '22222222-2222-4222-8222-222222222222';
const ORIGINAL_OBJECT = '33333333-3333-4333-8333-333333333333';
const FORCE_OBJECT = '44444444-4444-4444-8444-444444444444';
const DIGEST_HEX = 'ab'.repeat(32);
const LATE_HEX = 'cd'.repeat(32);
const ORIGINAL_HEX = 'ef'.repeat(32);
const FORCE_HEX = '12'.repeat(32);
const RESTORE_ROWS = 10_001;
const LATE_NODE = 'm-late';

describeWithPostgres('favicon restore scan checkpoint and SQL aggregate (U-5)', () => {
  let isolated: IsolatedPostgresRuntime;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('favicon_restore_scan', { maxConnections: 8 });
    await runMigrations(isolated.runtime.db, 'latest');
    await isolated.runtime.pool.query(
      `insert into accounts(id, subject_id, status) values ($1, $2, 'active'), ($3, $4, 'active')`,
      [ACCOUNT_ID, SUBJECT_ID, SUCCESS_ACCOUNT, SUCCESS_SUBJECT],
    );
    await isolated.runtime.pool.query(
      `insert into favicon_source_restores (
         node_id, collection_id, account_id, original_source_mode, original_object_id,
         original_content_type, original_byte_size, original_digest_sha256, source_revision,
         created_at, updated_at
       )
       select 'n' || lpad(gs::text, 6, '0'), 'restore-scan-col', $1, 'uploaded', $2::uuid,
              'image/png', 8, decode($3, 'hex'), 1, now(), now()
       from generate_series(0, $4) as gs`,
      [ACCOUNT_ID, BULK_OBJECT, DIGEST_HEX, RESTORE_ROWS - 1],
    );
  }, 180_000);

  afterAll(async () => {
    await isolated?.close();
  });

  test('more than 10000 restore rows page from the checkpoint and aggregate one row', async () => {
    const pool = isolated.runtime.pool;
    const seeded = await pool.query<{ n: number }>(
      `select count(*)::int as n from favicon_source_restores where account_id = $1`,
      [ACCOUNT_ID],
    );
    assert.equal(seeded.rows[0]?.n, RESTORE_ROWS);

    resetFaviconRestoreReadProbe();
    const now = new Date();
    const jobId = await createUnitOfWork(isolated.runtime.db).execute(({ transaction }) => {
      const batch = createPostgresFaviconBatchWritePorts(transaction, observeRestoreRead);
      return insertPolicyBatchJob({
        jobs: batch.faviconBatchJobs,
        candidates: batch.faviconBatchCandidates,
        restores: batch.faviconRestoreRead,
      }, {
        accountId: ACCOUNT_ID,
        subjectId: SUBJECT_ID,
        operation: 'restore_sources',
        now,
        policy: {
          accountId: ACCOUNT_ID,
          newDefault: 'capture',
          providerTemplate: DEFAULT_FAVICON_PROVIDER_TEMPLATE,
          fillMissing: false,
          forceAllOnline: false,
          revision: 1n,
          updatedAt: now,
        },
      });
    });

    const created = await scanRow(jobId);
    assert.equal(created.scan_complete, false);
    assert.equal(created.cursor_node_id, 'n000511');
    assert.equal(await itemCount(jobId), FAVICON_RESTORE_SCAN_LIMIT * 2);
    assert.equal(await jobStatus(jobId), 'pending');
    assert.equal(faviconRestoreReadProbe.maxScanSummaryRows, 1);
    assert.equal(faviconRestoreReadProbe.maxGapSummaryRows, 1);
    assert.deepEqual(faviconRestoreReadProbe.readCounts, [FAVICON_RESTORE_SCAN_LIMIT]);
    await assertDigest('n000000', DIGEST_HEX, BULK_OBJECT);

    await pool.query(
      `insert into favicon_source_restores (
         node_id, collection_id, account_id, original_source_mode, original_object_id,
         original_content_type, original_byte_size, original_digest_sha256, source_revision,
         created_at, updated_at
       ) values ($1, 'restore-scan-col', $2, 'uploaded', $3::uuid, 'image/png', 8,
                 decode($4, 'hex'), 1, now(), now())`,
      [LATE_NODE, ACCOUNT_ID, LATE_OBJECT, LATE_HEX],
    );

    await runCycle(jobId, ACCOUNT_ID, SUBJECT_ID, 0);
    assert.equal((await scanRow(jobId)).cursor_node_id, 'n001023');
    assert.equal(await itemsFor(jobId, LATE_NODE), 1, 'a restore row behind the checkpoint still enters the job');
    await assertDigest(LATE_NODE, LATE_HEX, LATE_OBJECT);

    let scanComplete = (await scanRow(jobId)).scan_complete;
    let cycles = 1;
    while (!scanComplete) {
      cycles += 1;
      assert.ok(cycles <= 40, `scan did not finish after ${cycles} cycles`);
      await runCycle(jobId, ACCOUNT_ID, SUBJECT_ID, 0);
      scanComplete = (await scanRow(jobId)).scan_complete;
      assert.equal(await jobStatus(jobId), 'pending');
    }

    const readCounts = faviconRestoreReadProbe.readCounts.slice();
    const gapCounts = faviconRestoreReadProbe.gapCounts.slice();
    assert.equal(readCounts.length, Math.ceil(RESTORE_ROWS / FAVICON_RESTORE_SCAN_LIMIT));
    assert.ok(readCounts.every((count) => count <= FAVICON_RESTORE_SCAN_LIMIT));
    assert.equal(readCounts.reduce((sum, count) => sum + count, 0), RESTORE_ROWS);
    assert.equal(readCounts.at(-1), RESTORE_ROWS % FAVICON_RESTORE_SCAN_LIMIT);
    assert.ok(gapCounts.every((count) => count <= FAVICON_RESTORE_SCAN_LIMIT));
    assert.equal(faviconRestoreReadProbe.maxScanSummaryRows, 1);
    assert.equal(faviconRestoreReadProbe.maxGapSummaryRows, 1);
    assert.equal(faviconRestoreReadProbe.maxAggregateSummaryRows, 1);
    const distinct = await pool.query<{ n: number; d: number }>(
      `select count(*)::int as n, count(distinct node_id)::int as d
       from favicon_job_items where job_id = $1`,
      [jobId],
    );
    assert.equal(distinct.rows[0]?.n, RESTORE_ROWS + 1);
    assert.equal(distinct.rows[0]?.d, RESTORE_ROWS + 1);
    assert.equal(await jobStatus(jobId), 'pending', 'pending items block completion after the scan finishes');
    await assertDigest('n010000', DIGEST_HEX, BULK_OBJECT);
    await assertDigest(LATE_NODE, LATE_HEX, LATE_OBJECT);

    await createUnitOfWork(isolated.runtime.db).execute(async ({ transaction }) => {
      const restores = createPostgresFaviconBatchWritePorts(transaction, observeRestoreRead).faviconRestoreRead;
      await assert.rejects(() => restores.listByAccountId(ACCOUNT_ID), /node id set|keyset/);
      const one = await restores.listByAccountId(ACCOUNT_ID, ['n000000']);
      assert.equal(one.length, 1);
      assert.equal(one[0]?.originalDigestSha256?.toString('hex'), DIGEST_HEX);
    });

    const aggregate = await createUnitOfWork(isolated.runtime.db).execute(({ transaction }) =>
      createPostgresFaviconBatchItemPort(transaction, observeRestoreRead).aggregateItems(jobId));
    const listed = await pool.query<{ node_id: string; status: string }>(
      `select node_id, status from favicon_job_items where job_id = $1`,
      [jobId],
    );
    let listedBytes = 0;
    for (const row of listed.rows) listedBytes += row.node_id.length + row.status.length;
    const aggregateBytes = Buffer.byteLength(JSON.stringify(aggregate));
    assert.ok((listed.rowCount ?? 0) > 10_000);
    assert.equal(aggregate.total, RESTORE_ROWS + 1);
    assert.equal(aggregate.pendingCount, RESTORE_ROWS + 1);
    assert.ok(listedBytes > 10_000 * 8, `listed bytes ${listedBytes}`);
    assert.ok(aggregateBytes * 20 < listedBytes, `aggregate bytes ${aggregateBytes}, listed bytes ${listedBytes}`);
    assert.equal(faviconRestoreReadProbe.maxAggregateSummaryRows, 1);

    await pool.query(`update favicon_job_items set status = 'succeeded' where job_id = $1`, [jobId]);
    await pool.query(
      `update favicon_restore_scans set scan_complete = false, cursor_node_id = null where job_id = $1`,
      [jobId],
    );
    await runCycle(jobId, ACCOUNT_ID, SUBJECT_ID, 0);
    assert.equal(await jobStatus(jobId), 'pending', 'a finished item set must not complete an open scan');
    assert.equal((await scanRow(jobId)).scan_complete, false);
    await assertDigest('n000000', DIGEST_HEX, BULK_OBJECT);

    await pool.query(`update favicon_restore_scans set scan_complete = true where job_id = $1`, [jobId]);
    await runCycle(jobId, ACCOUNT_ID, SUBJECT_ID, 0);
    assert.equal(await jobStatus(jobId), 'succeeded');
    await assertDigest('n010000', DIGEST_HEX, BULK_OBJECT);
    const stillThere = await pool.query<{ n: number }>(
      `select count(*)::int as n from favicon_source_restores where account_id = $1`,
      [ACCOUNT_ID],
    );
    assert.equal(stillThere.rows[0]?.n, RESTORE_ROWS + 1, 'job success without restore CAS keeps the original reference');

    const emptyJob = randomUUID();
    await createUnitOfWork(isolated.runtime.db).execute(({ transaction }) => insertFaviconJobRow(transaction, {
      jobId: emptyJob,
      accountId: ACCOUNT_ID,
      ownerSubjectId: SUBJECT_ID,
      operation: 'restore_sources',
      policyRevision: 1n,
      total: 0,
      createdAt: now,
      updatedAt: now,
    }));
    assert.equal(await itemCount(emptyJob), 0);
    await runCycle(emptyJob, ACCOUNT_ID, SUBJECT_ID, 0);
    const emptyItems = await itemCount(emptyJob);
    assert.equal(await jobStatus(emptyJob), 'pending', 'an empty unscanned job must not complete');
    assert.ok(emptyItems > 0 && emptyItems <= FAVICON_RESTORE_SCAN_LIMIT * 2, `items ${emptyItems}`);
    assert.equal((await scanRow(emptyJob)).scan_complete, false);
  }, 120_000);

  test('original digest and object stay until restore CAS succeeds', async () => {
    const collectionId = randomUUID();
    const rootId = randomUUID();
    const nodeId = randomUUID();
    const client = await isolated.runtime.pool.connect();
    try {
      await client.query('begin');
      await client.query(
        `insert into resource_id_ledger(resource_id, resource_type) values ($1, 'collection'), ($2, 'node'), ($3, 'node')`,
        [collectionId, rootId, nodeId],
      );
      await client.query(
        `insert into collections(
           id, owner_subject_id, title, kind, visibility, publication_slug, published_at,
           root_node_id, root_node_is_root, resource_revision, content_revision,
           policy_revision, commit_ordinal)
         values ($1, $2, 'Restore scan', 'bookmarks', 'public', $3, now(),
                 $4, true, 'r1', 'c1', 'p1', 1)`,
        [collectionId, SUCCESS_SUBJECT, `restore-scan-${collectionId.slice(0, 8)}`, rootId],
      );
      await client.query(
        `insert into nodes(
           id, collection_id, parent_id, kind, is_root, title, url, position_token,
           resource_revision, children_revision)
         values ($1, $2, null, 'folder', true, 'Root', null, null, 'r1', 'ch1')`,
        [rootId, collectionId],
      );
      await client.query(
        `insert into nodes(
           id, collection_id, parent_id, kind, is_root, title, url, position_token,
           resource_revision, children_revision)
         values ($1, $2, $3, 'bookmark', false, 'Bookmark', 'https://example.test/b', 'p1', 'r2', 'ch2')`,
        [nodeId, collectionId, rootId],
      );
      await client.query(
        `insert into bookmark_icons(
           node_id, collection_id, object_id, content_type, byte_size, digest_sha256, created_at, updated_at)
         values ($1, $2, $3::uuid, 'image/png', 8, decode($4, 'hex'), now(), now())`,
        [nodeId, collectionId, FORCE_OBJECT, FORCE_HEX],
      );
      await client.query(
        `insert into favicon_source_restores(
           node_id, collection_id, account_id, original_source_mode, original_object_id,
           original_content_type, original_byte_size, original_digest_sha256, source_revision,
           created_at, updated_at)
         values ($1, $2, $3, 'uploaded', $4::uuid, 'image/png', 9, decode($5, 'hex'), 1, now(), now())`,
        [nodeId, collectionId, SUCCESS_ACCOUNT, ORIGINAL_OBJECT, ORIGINAL_HEX],
      );
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }

    const now = new Date();
    const jobId = await createUnitOfWork(isolated.runtime.db).execute(({ transaction }) => {
      const batch = createPostgresFaviconBatchWritePorts(transaction, observeRestoreRead);
      return insertPolicyBatchJob({
        jobs: batch.faviconBatchJobs,
        candidates: batch.faviconBatchCandidates,
        restores: batch.faviconRestoreRead,
      }, {
        accountId: SUCCESS_ACCOUNT,
        subjectId: SUCCESS_SUBJECT,
        operation: 'restore_sources',
        now,
        policy: {
          accountId: SUCCESS_ACCOUNT,
          newDefault: 'capture',
          providerTemplate: DEFAULT_FAVICON_PROVIDER_TEMPLATE,
          fillMissing: false,
          forceAllOnline: false,
          revision: 1n,
          updatedAt: now,
        },
      });
    });
    const before = await isolated.runtime.pool.query<{ digest: string; object_id: string }>(
      `select encode(original_digest_sha256, 'hex') as digest, original_object_id::text as object_id
       from favicon_source_restores where node_id = $1`,
      [nodeId],
    );
    assert.equal(before.rows[0]?.digest, ORIGINAL_HEX);
    assert.equal(before.rows[0]?.object_id, ORIGINAL_OBJECT);
    assert.equal((await scanRow(jobId)).scan_complete, true, 'one restore row is a finished scan');

    await runCycle(jobId, SUCCESS_ACCOUNT, SUCCESS_SUBJECT, 1);
    assert.equal(await jobStatus(jobId), 'succeeded');
    const after = await isolated.runtime.pool.query<{ n: number }>(
      `select count(*)::int as n from favicon_source_restores where node_id = $1`,
      [nodeId],
    );
    assert.equal(after.rows[0]?.n, 0, 'restore CAS consumes the original reference');
    const binding = await isolated.runtime.pool.query<{ object_id: string }>(
      `select object_id::text as object_id from bookmark_icons where node_id = $1`,
      [nodeId],
    );
    assert.equal(binding.rows[0]?.object_id, ORIGINAL_OBJECT);
  }, 60_000);

  async function scanRow(jobId: string): Promise<{ cursor_node_id: string | null; scan_complete: boolean }> {
    const result = await isolated.runtime.pool.query<{ cursor_node_id: string | null; scan_complete: boolean }>(
      `select cursor_node_id, scan_complete from favicon_restore_scans where job_id = $1`,
      [jobId],
    );
    const row = result.rows[0];
    assert.ok(row !== undefined, 'scan checkpoint missing');
    return row;
  }

  async function itemCount(jobId: string): Promise<number> {
    const result = await isolated.runtime.pool.query<{ n: number }>(
      `select count(*)::int as n from favicon_job_items where job_id = $1`,
      [jobId],
    );
    return result.rows[0]?.n ?? 0;
  }

  async function itemsFor(jobId: string, nodeId: string): Promise<number> {
    const result = await isolated.runtime.pool.query<{ n: number }>(
      `select count(*)::int as n from favicon_job_items where job_id = $1 and node_id = $2`,
      [jobId, nodeId],
    );
    return result.rows[0]?.n ?? 0;
  }

  async function jobStatus(jobId: string): Promise<string> {
    const result = await isolated.runtime.pool.query<{ status: string }>(
      `select status from favicon_jobs where id = $1`,
      [jobId],
    );
    return result.rows[0]?.status ?? '';
  }

  async function assertDigest(nodeId: string, digestHex: string, objectId: string): Promise<void> {
    const result = await isolated.runtime.pool.query<{ digest: string; object_id: string }>(
      `select encode(original_digest_sha256, 'hex') as digest, original_object_id::text as object_id
       from favicon_source_restores where node_id = $1`,
      [nodeId],
    );
    assert.equal(result.rows[0]?.digest, digestHex);
    assert.equal(result.rows[0]?.object_id, objectId);
  }

  async function runCycle(jobId: string, accountId: string, subjectId: string, batchSize: number): Promise<void> {
    await isolated.runtime.pool.query(
      `update favicon_jobs
       set status = 'running', lease_owner = $2, lease_until = now() + interval '5 minutes',
           next_attempt_at = null
       where id = $1`,
      [jobId, LEASE],
    );
    const claim: FaviconJobClaim = {
      jobId,
      leaseOwner: LEASE,
      accountId,
      ownerSubjectId: subjectId,
      operation: 'restore_sources',
      status: 'running',
      attempts: 0,
      collectionId: '',
      nodeId: '',
      sourceUrl: '',
      sourceRevision: '1',
      policyRevision: '1',
      nodeResourceRevision: '',
      objectId: null,
    };
    const fetcher: FaviconFetcher = async () => {
      throw new Error('restore generation must not fetch');
    };
    const result = await processFaviconBatchClaim({
      verify: createPostgresFaviconJobWorkerUnitOfWork(isolated.runtime.db, observeRestoreRead),
      worker: createPostgresFaviconJobWorkerRepository(isolated.runtime.pool).worker,
      fetcher,
      store: {
        async get() { return null; },
        async put() { throw new Error('restore generation must not put'); },
      },
      clock: { async now() { return new Date(); } },
      now: () => new Date(),
      options: {
        maxAttempts: 3,
        backoffSeconds: [1],
        retentionSeconds: 60,
        maxBytes: 1024,
        maxDecompressedBytes: 4096,
        fetchTimeoutMs: 1000,
        maxRedirects: 0,
        batchSize,
        leaseDurationMs: 60_000,
      },
    }, claim);
    assert.notEqual(result.outcome, 'lease_lost', `lease lost for ${jobId}`);
  }
});
