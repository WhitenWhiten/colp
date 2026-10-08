import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, test, vi } from 'vitest';
import {
  createExportJobWorkerRuntime,
  createPostgresExportJobEnqueueUnitOfWork,
  createPostgresExportJobReadPort,
  createPostgresExportJobWorkerRepository,
  createPostgresExportLibraryProjectionPort,
} from '../../../src/infrastructure/collections/index.js';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import {
  createMyExportJob,
  processExportJobClaim,
  downloadMyExportJob,
  ExportJobCapacityError,
  ExportJobConflictError,
  type ExportLibraryDocument,
  type ExportObjectStore,
} from '../../../src/modules/collections/index.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
  truncateGuardedTablesInTransaction,
} from '../../support/postgres-test-runtime.js';

const NOW = new Date('2026-08-23T08:00:00.000Z');
const OWNER = 'exj-owner-subject';
const SHARED_OWNER = 'exj-shared-owner-subject';
const PRINCIPAL = 'exj-owner-account';
const COL_A = 'exj-col-a';
const COL_B = 'exj-col-b';
const COL_DELETED = 'exj-col-deleted';
const COL_SHARED = 'exj-col-shared';
const ROOT_A = 'exj-root-a';
const ROOT_B = 'exj-root-b';
const ROOT_DELETED = 'exj-root-deleted';
const ROOT_SHARED = 'exj-root-shared';
const BOOKMARK_A = 'exj-bookmark-a';
const BOOKMARK_B = 'exj-bookmark-b';

describeWithPostgres('EXJ-01 PostgreSQL export jobs', () => {
  let isolated: IsolatedPostgresRuntime;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('exj01_export_jobs', { maxConnections: 4 });
    await runMigrations(isolated.runtime.db, 'latest');
  }, 180_000);

  afterAll(async () => isolated?.close());

  async function resetLibrary(): Promise<void> {
    const client = await isolated.runtime.pool.connect();
    try {
      await client.query('begin');
      await truncateGuardedTablesInTransaction(client, `
        truncate table product_command_receipts, collection_export_jobs, collection_invites,
          collection_members, nodes, collections, resource_id_ledger, profiles, accounts cascade
      `);
      await client.query(
        `insert into accounts(id, subject_id, status, security_epoch)
         values ($1, $2, 'active', 0), ('exj-shared-account', $3, 'active', 0)`,
        [PRINCIPAL, OWNER, SHARED_OWNER],
      );
      await client.query(
        `insert into profiles(account_id, display_name, avatar_url)
         values ($1, 'Export owner', null), ('exj-shared-account', 'Shared owner', null)`,
        [PRINCIPAL],
      );
      await client.query(
        `insert into resource_id_ledger(resource_id, resource_type) values
         ($1, 'collection'), ($2, 'collection'), ($3, 'collection'), ($4, 'collection'),
         ($5, 'node'), ($6, 'node'), ($7, 'node'), ($8, 'node'),
         ($9, 'node'), ($10, 'node')`,
        [COL_A, COL_B, COL_DELETED, COL_SHARED, ROOT_A, ROOT_B, ROOT_DELETED, ROOT_SHARED,
          BOOKMARK_A, BOOKMARK_B],
      );
      await client.query(
        `insert into collections (
           id, owner_subject_id, title, summary, kind, visibility, root_node_id,
           resource_revision, content_revision, policy_revision, commit_ordinal, deleted_at
         ) values
         ($1, $5, 'Alpha library', null, 'bookmarks', 'private', $6, 'a-r1', 'a-c1', 'a-p1', 1, null),
         ($2, $5, 'Beta library', null, 'bookmarks', 'private', $7, 'b-r1', 'b-c1', 'b-p1', 1, null),
         ($3, $5, 'Deleted library', null, 'bookmarks', 'private', $8, 'd-r1', 'd-c1', 'd-p1', 1, $10),
         ($4, $11, 'Shared-with-owner', null, 'bookmarks', 'private', $9, 's-r1', 's-c1', 's-p1', 1, null)`,
        [COL_A, COL_B, COL_DELETED, COL_SHARED, OWNER, ROOT_A, ROOT_B, ROOT_DELETED, ROOT_SHARED,
          NOW, SHARED_OWNER],
      );
      await client.query(
        `insert into nodes (
           id, collection_id, parent_id, kind, is_root, title, url, description, tags,
           visibility, position_token, resource_revision, children_revision, created_at, deleted_at
         ) values
         ($1, $5, null, 'folder', true, 'Alpha root', null, null, '[]'::jsonb, 'inherit', null, 'ra-r1', 'ra-cr1', $9, null),
         ($2, $5, $1, 'bookmark', false, 'Alpha bookmark', 'https://example.test/a', null, '[]'::jsonb,
          'inherit', 'A', 'ba-r1', 'ba-cr1', $9, null),
         ($3, $6, null, 'folder', true, 'Beta root', null, null, '[]'::jsonb, 'inherit', null, 'rb-r1', 'rb-cr1', $9, null),
         ($4, $6, $3, 'bookmark', false, 'Beta bookmark', 'https://example.test/b', null, '[]'::jsonb,
          'inherit', 'A', 'bb-r1', 'bb-cr1', $9, null),
         ($7, $8, null, 'folder', true, 'Deleted root', null, null, '[]'::jsonb, 'inherit', null, 'rd-r1', 'rd-cr1', $9, $9),
         ($10, $11, null, 'folder', true, 'Shared root', null, null, '[]'::jsonb, 'inherit', null, 'rs-r1', 'rs-cr1', $9, null)`,
        [ROOT_A, BOOKMARK_A, ROOT_B, BOOKMARK_B, COL_A, COL_B, ROOT_DELETED, COL_DELETED, NOW,
          ROOT_SHARED, COL_SHARED],
      );
      await client.query(
        `insert into collection_members (collection_id, subject_id, role)
         values ($1, $2, 'editor')`,
        [COL_SHARED, OWNER],
      );
      await client.query(
        `insert into collection_invites (
           id, collection_id, role, email_normalized, invited_by_subject_id, status,
           expires_at, collection_title_snapshot
         ) values (
           'exj-invite-1', $1, 'viewer', 'collaborator@example.test', $2, 'pending',
           $3, 'Alpha library'
         )`,
        [COL_A, OWNER, new Date(NOW.getTime() + 86_400_000)],
      );
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }

  function countingStore(): ExportObjectStore & { readonly puts: string[] } {
    const objects = new Map<string, Buffer>();
    const puts: string[] = [];
    return {
      puts,
      async put(jobId, body) {
        puts.push(jobId);
        objects.set(jobId, body);
      },
      async get(jobId) {
        return objects.get(jobId) ?? null;
      },
      async delete(jobId) {
        objects.delete(jobId);
      },
    };
  }

  test('projection enforces byte capacity before returning a full tree', async () => {
    await resetLibrary();
    await isolated.runtime.pool.query(`insert into resource_id_ledger(resource_id, resource_type, committed_at)
      select 'export-paged-' || n, 'node', current_timestamp from generate_series(1,260) n`);
    await isolated.runtime.pool.query(`insert into nodes
      (id, collection_id, parent_id, kind, is_root, title, url, tags, visibility, position_token, resource_revision, children_revision)
      select 'export-paged-' || n, $1, $2, 'bookmark', false, 'Paged ' || n, 'https://example.test/' || n,
        '[]'::jsonb, 'inherit', 'B' || lpad(n::text, 4, '0'), 'r-' || n, 'cr-' || n
      from generate_series(1,260) n`, [COL_A, ROOT_A]);
    const projection = createPostgresExportLibraryProjectionPort(isolated.runtime.db);
    await assert.rejects(projection.loadOwnedLiveTree(OWNER, 16), ExportJobCapacityError);
    // Capacity aborts during node consumption must close the cursor even when
    // the caller keeps its repeatable-read transaction alive for another read.
    await isolated.runtime.db.transaction().setIsolationLevel('repeatable read').execute(async transaction => {
      const sameTransaction = createPostgresExportLibraryProjectionPort(transaction);
      await assert.rejects(sameTransaction.loadOwnedLiveTree(OWNER, 1024), ExportJobCapacityError);
      const retry = await sameTransaction.loadOwnedLiveTree(OWNER);
      assert.equal(retry.find(collection => collection.id === COL_A)?.nodes.length, 262);
    });
    const tree = await projection.loadOwnedLiveTree(OWNER);
    assert.equal(tree.find(collection => collection.id === COL_A)?.nodes.length, 262);
    assert.deepEqual(tree.find(collection => collection.id === COL_A)?.nodes.slice(2).map(node => node.title),
      Array.from({ length: 260 }, (_, index) => `Paged ${index + 1}`));
  });

  for (const crashWindow of ['before-put', 'after-put'] as const) {
    test(`reclaims running job ${crashWindow} and fences the old generation`, async () => {
      await resetLibrary();
      await createPostgresExportJobEnqueueUnitOfWork(isolated.runtime.db).execute(ports => createMyExportJob(ports, {
        actor: { principalId: PRINCIPAL, subjectId: OWNER }, commandId: randomUUID(),
      }));
      const repo = createPostgresExportJobWorkerRepository(isolated.runtime.pool);
      const [old] = await repo.claimDue({ limit: 1, leaseOwner: 'same-process', leaseDurationMs: 60000 });
      assert.ok(old);
      const store = countingStore();
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      let entered!: () => void;
      const atPut = new Promise<void>(resolve => { entered = resolve; });
      const ports = { worker: repo.worker, projection: createPostgresExportLibraryProjectionPort(isolated.runtime.db), store, clock: { now: () => new Date() } };
      const previous = processExportJobClaim({ ...ports, store: { ...store, async put(key, body, type) {
        if (crashWindow === 'after-put') await store.put(key, body, type);
        entered(); await gate;
        if (crashWindow === 'before-put') await store.put(key, body, type);
      } } }, old);
      await atPut;
      await isolated.runtime.pool.query("UPDATE collection_export_jobs SET lease_until=current_timestamp-interval '1 second' WHERE job_id=$1", [old.jobId]);
      const [next] = await repo.claimDue({ limit: 1, leaseOwner: 'same-process', leaseDurationMs: 60000 });
      assert.ok(next); assert.notEqual(next.leaseOwner, old.leaseOwner);
      await processExportJobClaim(ports, next);
      release(); await previous;
      assert.equal(await repo.worker.markFailed({ ...old, errorClass: 'late-worker' }), false);
      const ready = await createPostgresExportJobReadPort(isolated.runtime.db).getById(old.jobId);
      assert.equal(ready?.status, 'ready'); assert.ok(ready?.objectKey);
      assert.ok(await store.get(ready.objectKey));
      assert.equal(await store.get(next.objectKey!), null, 'old generation cleanup cannot delete the new object');
      const created = await createPostgresExportJobEnqueueUnitOfWork(isolated.runtime.db).execute(ports => createMyExportJob(ports, {
        actor: { principalId: PRINCIPAL, subjectId: OWNER }, commandId: randomUUID(),
      }));
      assert.equal(created.kind, 'succeeded');
    });
  }

  test('worker renews its current generation while the projection remains blocked', async () => {
    await resetLibrary();
    await createPostgresExportJobEnqueueUnitOfWork(isolated.runtime.db).execute(ports => createMyExportJob(ports, {
      actor: { principalId: PRINCIPAL, subjectId: OWNER }, commandId: randomUUID(),
    }));
    const repo = createPostgresExportJobWorkerRepository(isolated.runtime.pool);
    let projectionStarted!: () => void;
    const started = new Promise<void>(resolve => { projectionStarted = resolve; });
    let releaseProjection!: () => void;
    const projectionGate = new Promise<void>(resolve => { releaseProjection = resolve; });
    let renewalFinished!: (renewed: boolean) => void;
    const renewal = new Promise<boolean>(resolve => { renewalFinished = resolve; });
    const errors: object[] = [];
    const observedRepo = { ...repo, worker: { ...repo.worker,
      async renewLease(input: Parameters<NonNullable<typeof repo.worker.renewLease>>[0]) {
        const result = await repo.worker.renewLease!(input);
        renewalFinished(result);
        return result;
      },
    } };
    // Control only heartbeat scheduling. Date and PostgreSQL clocks remain real.
    // Expiry/reclaim is covered by the separate before/after PUT regressions.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const runtime = createExportJobWorkerRuntime({ repository: observedRepo, leaseDurationMs: 60_000,
      projection: { async loadOwnedLiveTree() { projectionStarted(); await projectionGate; return []; } },
      store: countingStore(), logger: { info() {}, warn(value) { errors.push(value); }, error(value) { errors.push(value); } },
    });
    const pending = runtime.loop.runOnce();
    try {
      await started;
      // Model half a lease already spent, without making correctness depend on
      // the host scheduling a 333ms timer before a 1-second real lease expires.
      const before = await isolated.runtime.pool.query<{ lease_owner: string; lease_until: Date }>(`
        UPDATE collection_export_jobs SET lease_until=current_timestamp+interval '30 seconds'
        WHERE owner_subject_id=$1 RETURNING lease_owner,lease_until`, [OWNER]);
      await vi.advanceTimersByTimeAsync(20_000);
      assert.equal(await Promise.race([renewal, delay(5_000).then(() => { throw new Error('heartbeat did not complete'); })]), true);
      const after = await isolated.runtime.pool.query<{ lease_owner: string; lease_until: Date }>(
        'SELECT lease_owner,lease_until FROM collection_export_jobs WHERE owner_subject_id=$1', [OWNER]);
      assert.equal(after.rows[0]!.lease_owner, before.rows[0]!.lease_owner);
      assert.ok(after.rows[0]!.lease_until.getTime() > before.rows[0]!.lease_until.getTime() + 20_000);
      assert.deepEqual(await repo.claimDue({ limit: 1, leaseOwner: 'competitor', leaseDurationMs: 60_000 }), []);
      releaseProjection();
      assert.equal(await pending, true);
      assert.deepEqual(errors, []);
      const jobs = await createPostgresExportJobReadPort(isolated.runtime.db).listByOwner(OWNER, 10);
      assert.equal(jobs[0]?.status, 'ready');
    } finally {
      releaseProjection();
      await pending;
      vi.useRealTimers();
    }
  });

  test('owned live tree has two collections and root nodes; shared membership is absent; no emails', async () => {
    await resetLibrary();
    const enqueue = createPostgresExportJobEnqueueUnitOfWork(isolated.runtime.db);
    const created = await enqueue.execute((ports) => createMyExportJob(ports, {
      actor: { principalId: PRINCIPAL, subjectId: OWNER },
      commandId: randomUUID(),
    }));
    assert.equal(created.kind, 'succeeded');
    if (created.kind !== 'succeeded') return;
    const store = countingStore();
    const runtime = createExportJobWorkerRuntime({
      repository: createPostgresExportJobWorkerRepository(isolated.runtime.pool),
      projection: createPostgresExportLibraryProjectionPort(isolated.runtime.db),
      store,
      logger: { info() {}, warn() {}, error() {} },
      now: () => NOW,
    });
    await runtime.loop.runOnce();
    assert.equal(store.puts.length, 1);
    const body = await store.get(store.puts[0]!);
    assert.notEqual(store.puts[0], created.job.jobId);
    assert.ok(body);
    const text = body.toString('utf8');
    assert.equal(text.includes('@'), false);
    const document = JSON.parse(text) as ExportLibraryDocument;
    assert.equal(JSON.stringify(document).includes('@'), false);
    assert.equal(document.collections.length, 2);
    const ids = document.collections.map((collection) => collection.id).sort();
    assert.deepEqual(ids, [COL_A, COL_B].sort());
    assert.equal(document.collections.some((collection) => collection.id === COL_SHARED), false);
    assert.equal(document.collections.some((collection) => collection.id === COL_DELETED), false);
    for (const collection of document.collections) {
      assert.equal(collection.nodes.some((node) => node.isRoot), true);
    }
    const downloaded = await downloadMyExportJob({
      reads: createPostgresExportJobReadPort(isolated.runtime.db),
      store,
      clock: { now: () => NOW },
    }, { ownerSubjectId: OWNER, jobId: created.job.jobId });
    assert.ok(downloaded);
    assert.equal(downloaded.toString('utf8').includes('@'), false);
  });

  test('over-capacity fixture fails with put 0', async () => {
    await resetLibrary();
    const enqueue = createPostgresExportJobEnqueueUnitOfWork(isolated.runtime.db);
    const created = await enqueue.execute((ports) => createMyExportJob(ports, {
      actor: { principalId: PRINCIPAL, subjectId: OWNER },
      commandId: randomUUID(),
    }));
    assert.equal(created.kind, 'succeeded');
    if (created.kind !== 'succeeded') return;
    const store = countingStore();
    const runtime = createExportJobWorkerRuntime({
      repository: createPostgresExportJobWorkerRepository(isolated.runtime.pool),
      projection: createPostgresExportLibraryProjectionPort(isolated.runtime.db),
      store,
      logger: { info() {}, warn() {}, error() {} },
      maxBytes: 16,
      now: () => NOW,
    });
    await runtime.loop.runOnce();
    assert.equal(store.puts.length, 0);
    const row = await isolated.runtime.pool.query<{ status: string; error_class: string | null }>(
      'select status, error_class from collection_export_jobs where job_id = $1',
      [created.job.jobId],
    );
    assert.equal(row.rows[0]?.status, 'failed');
    assert.equal(row.rows[0]?.error_class, 'over_capacity');
  });

  test('second command id is conflict 409 with no success or in_progress receipt', async () => {
    await resetLibrary();
    const enqueue = createPostgresExportJobEnqueueUnitOfWork(isolated.runtime.db);
    const commandA = randomUUID();
    const commandB = randomUUID();
    const first = await enqueue.execute((ports) => createMyExportJob(ports, {
      actor: { principalId: PRINCIPAL, subjectId: OWNER },
      commandId: commandA,
    }));
    assert.equal(first.kind, 'succeeded');
    await assert.rejects(
      () => enqueue.execute((ports) => createMyExportJob(ports, {
        actor: { principalId: PRINCIPAL, subjectId: OWNER },
        commandId: commandB,
      })),
      (error: unknown) => error instanceof ExportJobConflictError,
    );
    const receipts = await isolated.runtime.pool.query<{ command_id: string; completed_at: Date | null }>(
      `select command_id, completed_at from product_command_receipts
       where principal_id = $1 and command_scope = 'collections:export-jobs:v1'`,
      [PRINCIPAL],
    );
    assert.equal(receipts.rowCount, 1);
    assert.equal(receipts.rows[0]?.command_id, commandA);
    assert.ok(receipts.rows[0]?.completed_at);
    const missingB = await isolated.runtime.pool.query(
      'select 1 from product_command_receipts where command_id = $1',
      [commandB],
    );
    assert.equal(missingB.rowCount, 0);
  });

  test('expires_at in the past marks pending expired and download is 404', async () => {
    await resetLibrary();
    const enqueue = createPostgresExportJobEnqueueUnitOfWork(isolated.runtime.db);
    const created = await enqueue.execute((ports) => createMyExportJob(ports, {
      actor: { principalId: PRINCIPAL, subjectId: OWNER },
      commandId: randomUUID(),
    }));
    assert.equal(created.kind, 'succeeded');
    if (created.kind !== 'succeeded') return;
    await isolated.runtime.pool.query(
      `update collection_export_jobs set expires_at = $2 where job_id = $1`,
      [created.job.jobId, new Date(NOW.getTime() - 1_000)],
    );
    const store = countingStore();
    const runtime = createExportJobWorkerRuntime({
      repository: createPostgresExportJobWorkerRepository(isolated.runtime.pool),
      projection: createPostgresExportLibraryProjectionPort(isolated.runtime.db),
      store,
      logger: { info() {}, warn() {}, error() {} },
      now: () => NOW,
    });
    await runtime.loop.runOnce();
    assert.equal(store.puts.length, 0);
    const row = await isolated.runtime.pool.query<{ status: string }>(
      'select status from collection_export_jobs where job_id = $1',
      [created.job.jobId],
    );
    assert.equal(row.rows[0]?.status, 'expired');
    const downloaded = await downloadMyExportJob({
      reads: createPostgresExportJobReadPort(isolated.runtime.db),
      store,
      clock: { now: () => NOW },
    }, { ownerSubjectId: OWNER, jobId: created.job.jobId });
    assert.equal(downloaded, null);
  });
});
