import { createPostgresCollectionVersionStore } from '../../../src/infrastructure/collections/collection-tree-version-postgres.js';
import { createPostgresOrganizePlanCollectionPort } from '../../../src/infrastructure/collections/organize-plan-postgres.js';
import { lockRunContext } from '../../../src/infrastructure/collections/classification-run-billing.js';
import { purgeOwnedTrashInTransaction } from '../../../src/infrastructure/sync/sync-tombstone-user-purge-postgres.js';
import { PostgresSyncTombstonePurgeCoordinator, SyncTombstonePurgeFenceLostError } from '../../../src/infrastructure/sync/sync-tombstone-purge-postgres.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, test } from 'vitest';
import { createPostgresCanonicalMutationPorts } from '../../../src/infrastructure/collections/canonical-mutation-postgres-ports.js';
import { classifyDatabaseError } from '../../../src/infrastructure/database/errors.js';
import {
  lockCollectionReplicaGate,
  lockSyncReplicaBeforeCollection,
} from '../../../src/infrastructure/database/lock-order.js';
import {
  createPostgresReplicaLifecycleService,
  createPostgresReplicaStore,
} from '../../../src/infrastructure/sync/index.js';
import { withTransactionRetry } from '../../../src/infrastructure/database/transaction-retry.js';
import { createUnitOfWork } from '../../../src/infrastructure/database/unit-of-work.js';
import {
  materializeCollectionPayload,
  RESOURCE_PAYLOAD_SCHEMA_VERSION,
} from '../../../src/modules/collections/index.js';
import { waitForCondition } from '../../support/async-test-helpers.js';
import { describeWithPostgres } from '../../support/postgres-test-runtime.js';
import {
  bootSyncSessionPostgres,
  capabilities,
  type SyncSessionPostgresHarness,
} from '../../support/sync-session-postgres.js';

/**
 * T-10 / ADR-0027: the Product node-write path and the Sync authority prefix
 * must take `sync_replicas` before `collections`.
 *
 * Every case uses two real PostgreSQL connections and proves the reverse wait
 * happened through `pg_blocking_pids()`, so a green run cannot be vacuous.
 */
describeWithPostgres('Sync transaction lock order (ADR-0027)', () => {
  let harness: SyncSessionPostgresHarness;
  let collectionId: string;
  let replicaId: string;

  beforeAll(async () => {
    harness = await bootSyncSessionPostgres('t10_lock_order');
    const replica = await harness.createReplica('owner');
    collectionId = replica.collectionId;
    replicaId = replica.replicaId;
    await backfillCollectionPayload();
  }, 120_000);

  afterAll(async () => {
    await harness?.close();
  });

  test('T-10 product node write waits instead of deadlocking when sync holds the replica', async () => {
    const syncHoldsReplica = deferred();
    const syncMayFinish = deferred();

    // Side B starts first and holds this collection's Replica row while the
    // Product transaction runs its canonical node-mutation prefix.
    const syncSide = createUnitOfWork(harness.isolated.runtime.db).execute(async ({ transaction }) => {
      await lockSyncReplicaBeforeCollection(transaction, replicaId);
      syncHoldsReplica.resolve();
      await syncMayFinish.promise;
      await transaction.selectFrom('collections').select('id')
        .where('id', '=', collectionId).forUpdate().executeTakeFirstOrThrow();
      return 'sync';
    });
    await syncHoldsReplica.promise;

    // Side A: the real Product canonical collection lock plus the trailing
    // invalidation UPDATE the operations port performs before commit.
    const productWrite = createUnitOfWork(harness.isolated.runtime.db).execute(async ({ transaction }) => {
      const ports = createPostgresCanonicalMutationPorts(transaction, {
        invalidateSyncReplicasOnNodeMutation: true,
      });
      const locked = await ports.collectionLock.lockForCanonicalMutation(transaction, collectionId);
      assert.ok(locked, 'the seeded collection must be lockable');
      await transaction.updateTable('sync_replicas').set({
        status: 'recovery_required',
        lifecycle_revision: sql<bigint>`lifecycle_revision + 1`,
      }).where('collection_id', '=', collectionId).where('status', '=', 'active').execute();
      return 'product';
    });

    try {
      // Non-vacuity: the Product transaction really is waiting on a lock the
      // Sync side holds. Under the pre-fix order it holds `collections` at this
      // point, so releasing the Sync side into its own `collections` request
      // produced a real 40P01 instead of a clean hand-off.
      await waitForCondition(
        () => anyBackendWaiting(),
        {
          timeoutMs: 15_000,
          pollIntervalMs: 10,
          description: 'the Product canonical write to wait on the Sync replica lock',
        },
      );
      syncMayFinish.resolve();
      const settled = await Promise.allSettled([productWrite, syncSide]);
      assert.deepEqual(
        settled.map((entry) => (entry.status === 'fulfilled' ? entry.value : String(entry.reason))),
        ['product', 'sync'],
      );
    } finally {
      syncMayFinish.resolve();
      await Promise.allSettled([productWrite, syncSide]);
    }
  }, 40_000);

  test.each(['version', 'organize-plan', 'classification-run', 'user-purge', 'background-purge'] as const)(
    'BECORE-01 %s admission waits on replicas before holding collection', async (entry) => {
      await harness.isolated.runtime.db.updateTable('sync_replicas').set({ status: 'active' })
        .where('replica_id', '=', replicaId).execute();
      const held = deferred();
      const release = deferred();
      const sync = createUnitOfWork(harness.isolated.runtime.db).execute(async ({ transaction }) => {
        await lockSyncReplicaBeforeCollection(transaction, replicaId);
        held.resolve();
        await release.promise;
        await transaction.selectFrom('collections').select('id')
          .where('id', '=', collectionId).forUpdate().executeTakeFirstOrThrow();
      });
      await held.promise;
      const caller = entry === 'background-purge'
        ? new PostgresSyncTombstonePurgeCoordinator(harness.isolated.runtime.db, {
            workerId: 'lock-order', batchSize: 10, leaseDurationMs: 30_000,
          }).purgeClaim({ collectionId, leaseToken: 'missing', leaseGeneration: '0' })
            .catch(error => { assert.ok(error instanceof SyncTombstonePurgeFenceLostError); })
        : createUnitOfWork(harness.isolated.runtime.db).execute(async ({ transaction }) => {
            if (entry === 'version') {
              assert.ok(await createPostgresCollectionVersionStore(transaction)
                .lockOwnedLive(collectionId, 'owner-subject'));
            } else if (entry === 'organize-plan') {
              // The production organize-plan admission port, unlocked by the
              // real account subject the Sync harness seeds.
              const owned = await createPostgresOrganizePlanCollectionPort(transaction)
                .lockOwnedLive(collectionId, 'owner-subject');
              assert.ok(owned, 'the seeded collection must be owned by the fixture subject');
            } else if (entry === 'classification-run') {
              // The real classification run-context helper, called by the run
              // apply path (and the run worker job/lease transitions) before
              // canonical node mutations that invalidate replicas.
              await lockRunContext(transaction, 'lock-order-run', collectionId);
            } else {
              await purgeOwnedTrashInTransaction(transaction, {
                collectionId, workerId: 'lock-order', leaseDurationMs: 30_000,
              });
            }
          });
      try {
        await waitForCondition(anyBackendWaiting, { timeoutMs: 15_000, pollIntervalMs: 10,
          description: `${entry} must actually wait on the replica` });
        release.resolve();
        await Promise.all([caller, sync]);
      } finally {
        release.resolve();
        await Promise.allSettled([caller, sync]);
      }
    }, 40_000,
  );

  test('T-10 the pre-fix reverse order is a real 40P01 and rolls back without durable rows', async () => {
    const left = await harness.isolated.runtime.pool.connect();
    const right = await harness.isolated.runtime.pool.connect();
    const leftMarker = `t10-rollback-left-${Date.now()}`;
    const rightMarker = `t10-rollback-right-${Date.now()}`;
    let failure: unknown;
    try {
      await left.query('begin');
      await right.query('begin');
      await left.query(
        'insert into resource_id_ledger(resource_id, resource_type) values ($1, $2)', [leftMarker, 'node']);
      await right.query(
        'insert into resource_id_ledger(resource_id, resource_type) values ($1, $2)', [rightMarker, 'node']);
      // Pre-fix Product order: collections first, replicas later.
      await left.query('select id from collections where id = $1 for update', [collectionId]);
      // Sync order: replicas first, collections later.
      await right.query('select replica_id from sync_replicas where replica_id = $1 for update', [replicaId]);

      const leftSecond = left
        .query('select replica_id from sync_replicas where replica_id = $1 for update', [replicaId])
        .then(() => undefined, (error: unknown) => error);
      await waitForCondition(
        () => anyBackendWaiting(),
        {
          timeoutMs: 10_000,
          pollIntervalMs: 10,
          description: 'the product-side second lock to wait on the replica row',
        },
      );

      // Closing the cycle: the Sync side now wants the collection row.
      const rightSecond = right
        .query('select id from collections where id = $1 for update', [collectionId])
        .then(() => undefined, (error: unknown) => error);
      failure = await leftSecond ?? await rightSecond;
      if (failure === undefined) failure = (await leftSecond) ?? (await rightSecond);

      assert.ok(failure !== undefined, 'the reverse order must produce a real PostgreSQL failure');
      const classified = classifyDatabaseError(failure);
      assert.equal(classified.kind, 'deadlock');
      assert.equal(classified.retryableAtCommandBoundary, true);
    } finally {
      await left.query('rollback').catch(() => undefined);
      await right.query('rollback').catch(() => undefined);
      left.release();
      right.release();
    }

    // Rollback safety: the aborted participant and the survivor both leave no
    // partial durable row behind.
    const markers = await harness.isolated.runtime.pool.query<{ resource_id: string }>(
      'select resource_id from resource_id_ledger where resource_id = any($1)',
      [[leftMarker, rightMarker]],
    );
    assert.deepEqual(markers.rows, []);
  }, 40_000);

  test('T-10 bounded retry converges after a real deadlock and applies each effect once', async () => {
    const retries: string[] = [];
    const firstId = `t10-retry-a-${Date.now()}`;
    const secondId = `t10-retry-b-${Date.now()}`;

    async function preFixProductOrder(operationId: string): Promise<void> {
      await withTransactionRetry(async () => {
        await createUnitOfWork(harness.isolated.runtime.db).execute(async ({ transaction }) => {
          // Deliberately the pre-fix order: this participant can lose the race.
          await transaction.selectFrom('collections').select('id')
            .where('id', '=', collectionId).forUpdate().executeTakeFirstOrThrow();
          await lockSyncReplicaBeforeCollection(transaction, replicaId);
          await transaction.insertInto('resource_id_ledger')
            .values({ resource_id: operationId, resource_type: 'node' }).execute();
        });
      }, {
        maxAttempts: 4,
        baseDelayMs: 5,
        onRetry: ({ attempt, error }) => { retries.push(`${operationId}:${attempt}:${error.kind}`); },
      });
    }

    async function syncOrder(operationId: string): Promise<void> {
      await withTransactionRetry(async () => {
        await createUnitOfWork(harness.isolated.runtime.db).execute(async ({ transaction }) => {
          await lockSyncReplicaBeforeCollection(transaction, replicaId);
          await transaction.selectFrom('collections').select('id')
            .where('id', '=', collectionId).forUpdate().executeTakeFirstOrThrow();
          await transaction.insertInto('resource_id_ledger')
            .values({ resource_id: operationId, resource_type: 'node' }).execute();
        });
      }, {
        maxAttempts: 4,
        baseDelayMs: 5,
        onRetry: ({ attempt, error }) => { retries.push(`${operationId}:${attempt}:${error.kind}`); },
      });
    }

    await Promise.all([preFixProductOrder(firstId), syncOrder(secondId)]);

    // Bounded retry absorbed whatever the deadlock victim was; it never looped.
    assert.ok(retries.length <= 6, `retry must stay bounded, saw ${retries.join(',')}`);
    assert.ok(retries.every((entry) => entry.endsWith(':deadlock')), retries.join(','));

    const rows = await harness.isolated.runtime.pool.query<{ resource_id: string; count: string }>(
      `select resource_id, count(*)::text as count from resource_id_ledger
        where resource_id = any($1) group by resource_id`,
      [[firstId, secondId]],
    );
    assert.equal(rows.rows.length, 2);
    assert.deepEqual(rows.rows.map((row) => row.count), ['1', '1']);
  }, 40_000);

  test('U-9 a replica missed by the active prelock cannot invert the collection lock', async () => {
    await harness.isolated.runtime.db.updateTable('sync_replicas').set({ status: 'active' })
      .where('replica_id', '=', replicaId).execute();
    const missed = await harness.createReplica('owner');
    await harness.isolated.runtime.pool.query(`update sync_replicas set status='expired',
      checkpoint_cursor='cursor-4', checkpoint_commit_ordinal=4, checkpoint_stream_kind=0,
      checkpoint_stable_id='op-4',
      wire_json=jsonb_set(jsonb_set(jsonb_set(wire_json, '{status}', '"expired"'),
        '{checkpoint,acknowledgedCursor}', '"cursor-4"'),
        '{checkpoint,acknowledgedCommitOrdinal}', '"4"')
      where replica_id=$1`, [missed.replicaId]);
    const before = await harness.isolated.runtime.pool.query<{
      content_revision: string; commit_ordinal: string;
    }>('select content_revision, commit_ordinal::text from collections where id=$1', [collectionId]);
    const originalRevision = before.rows[0]?.content_revision;
    const originalOrdinal = before.rows[0]?.commit_ordinal;

    const scanned = deferred();
    const mayFinish = deferred();
    const product = createUnitOfWork(harness.isolated.runtime.db).execute(async ({ transaction }) => {
      const ports = createPostgresCanonicalMutationPorts(transaction, {
        invalidateSyncReplicasOnNodeMutation: true,
      });
      const locked = await ports.collectionLock.lockForCanonicalMutation(transaction, collectionId);
      assert.ok(locked);
      scanned.resolve();
      await mayFinish.promise;
      await transaction.updateTable('collections').set({
        content_revision: 'c-u9',
        commit_ordinal: sql`5::bigint`,
      }).where('id', '=', collectionId).execute();
      await transaction.updateTable('sync_replicas').set({
        status: 'recovery_required',
        lifecycle_revision: sql<bigint>`lifecycle_revision + 1`,
        wire_json: sql<Record<string, unknown>>`jsonb_set(
          wire_json, '{status}', '"recovery_required"'::jsonb, true
        )`,
      }).where('collection_id', '=', collectionId).where('status', '=', 'active').execute();
      return 'product';
    });
    void product.catch(() => scanned.resolve());
    const phantomId = `replica-u9-${randomUUID()}`;
    let phantom: Promise<Awaited<ReturnType<ReturnType<typeof createPostgresReplicaStore>['create']>>> = Promise.resolve() as never;
    let activation: Promise<Awaited<ReturnType<ReturnType<typeof createPostgresReplicaLifecycleService>['resume']>>> = Promise.resolve() as never;
    let push: Promise<string> = Promise.resolve('not-started');

    try {
      await scanned.promise;
      const probe = await harness.isolated.runtime.pool.connect();
      try {
        await probe.query('begin');
        await probe.query('select replica_id from sync_replicas where replica_id=$1 for update nowait',
          [missed.replicaId]);
        await probe.query('rollback');
      } finally {
        probe.release();
      }
      phantom = createPostgresReplicaStore(harness.isolated.runtime.db, { ids: {
        deviceId: () => `device-u9-${phantomId}`,
        replicaId: () => phantomId,
        leaseId: () => `lease-u9-${phantomId}`,
      } }).create({
        accountId: 'owner', collectionId, deviceName: 'Laptop', replicaName: 'Chrome',
        kind: 'browser_extension', adapter: { profile: 'chromium-bookmarks-v1', version: '1.0.0' },
        capabilities, binding: { browserProfileId: `profile-${phantomId}`, mountMode: 'mounted-folder',
          browserGeneration: 'installation-u9' }, leaseDurationSeconds: 3_600,
      }, { actorAccountId: 'owner' });
      activation = createPostgresReplicaLifecycleService(harness.isolated.runtime.db, {
        leaseId: () => `lease-u9-resume-${randomUUID()}`,
        retentionWindow: { async load(_transaction, id) {
          return { collectionId: id, earliestPull: { cursor: 'cursor-4', commitOrdinal: '4' },
            purgedThrough: { cursor: 'cursor-4', commitOrdinal: '4' }, snapshotUrl: '/snapshots/current' };
        } },
      }).resume({
        scope: { accountId: missed.accountId, collectionId: missed.collectionId, replicaId: missed.replicaId,
          expectedLeaseGeneration: missed.leaseGeneration, expectedLifecycleRevision: missed.lifecycleRevision },
        outcome: 'authorized_success', leaseDurationSeconds: 3_600,
      });
      push = createUnitOfWork(harness.isolated.runtime.db).execute(async ({ transaction }) => {
        await lockSyncReplicaBeforeCollection(transaction, missed.replicaId);
        await transaction.selectFrom('collections').select('id')
          .where('id', '=', collectionId).forUpdate().executeTakeFirstOrThrow();
        return 'push';
      });
      const absent = await harness.isolated.runtime.pool.query(
        'select replica_id from sync_replicas where replica_id=$1', [phantomId]);
      assert.equal(absent.rowCount, 0);
      await waitForCondition(async () => {
        const waiting = await harness.isolated.runtime.pool.query<{ blocked: string; idle: string }>(`
          select count(*) filter (where cardinality(pg_blocking_pids(pid)) > 0)::text blocked,
                 count(*) filter (
                   where cardinality(pg_blocking_pids(pid)) = 0
                     and pid in (select unnest(pg_blocking_pids(other.pid)) from pg_stat_activity other)
                 )::text idle
            from pg_stat_activity
           where application_name = 'known-test-t10_lock_order'`);
        return waiting.rows[0]?.blocked === '3' && waiting.rows[0]?.idle === '1';
      }, { timeoutMs: 15_000, pollIntervalMs: 10,
        description: 'activation, phantom register, and push to wait on the product gate' });
      const stillAbsent = await harness.isolated.runtime.pool.query(
        'select replica_id from sync_replicas where replica_id=$1', [phantomId]);
      assert.equal(stillAbsent.rowCount, 0);
      mayFinish.resolve();
      const productResult = await product;
      const [activated, pushed, registered] = await Promise.all([activation, push, phantom]);
      assert.equal(productResult, 'product');
      assert.equal(pushed, 'push');
      assert.equal(activated.state, 'denied');
      if (activated.state === 'denied') assert.equal(activated.code, 'stale_replica');
      assert.equal(registered.replicaId, phantomId);
      assert.equal(registered.status, 'active');
      assert.equal(registered.checkpoint.acknowledgedCommitOrdinal, null);

      const head = await harness.isolated.runtime.pool.query<{
        content_revision: string; commit_ordinal: string;
      }>('select content_revision, commit_ordinal::text from collections where id=$1', [collectionId]);
      assert.deepEqual(head.rows[0], { content_revision: 'c-u9', commit_ordinal: '5' });
      const missedRow = await harness.isolated.runtime.pool.query<{
        status: string; checkpoint_commit_ordinal: string;
      }>(`select status, checkpoint_commit_ordinal::text
          from sync_replicas where replica_id=$1`, [missed.replicaId]);
      assert.deepEqual(missedRow.rows[0], { status: 'recovery_required', checkpoint_commit_ordinal: '4' });
      const seeded = await harness.isolated.runtime.pool.query<{ status: string }>(
        'select status from sync_replicas where replica_id=$1', [replicaId]);
      assert.equal(seeded.rows[0]?.status, 'recovery_required');
      const phantomRow = await harness.isolated.runtime.pool.query<{
        status: string; checkpoint_commit_ordinal: string | null;
      }>(`select status, checkpoint_commit_ordinal::text
          from sync_replicas where replica_id=$1`, [phantomId]);
      assert.deepEqual(phantomRow.rows[0], { status: 'active', checkpoint_commit_ordinal: null });
    } finally {
      mayFinish.resolve();
      await Promise.allSettled([product, activation, push, phantom]);
      await harness.isolated.runtime.pool.query(
        `update collections set content_revision=$2, commit_ordinal=$3::bigint where id=$1`,
        [collectionId, originalRevision, originalOrdinal]);
      await harness.isolated.runtime.pool.query(
        `update sync_replicas set status='active',
           wire_json=jsonb_set(wire_json, '{status}', '"active"')
         where replica_id=$1`, [replicaId]);
    }
  }, 40_000);

  test('U-9 a failed collection transaction rolls back the gate writes completely', async () => {
    const before = await harness.isolated.runtime.pool.query<{
      content_revision: string; commit_ordinal: string;
    }>('select content_revision, commit_ordinal::text from collections where id=$1', [collectionId]);
    const marker = `u9-rollback-${randomUUID()}`;
    await assert.rejects(createUnitOfWork(harness.isolated.runtime.db).execute(async ({ transaction }) => {
      await lockCollectionReplicaGate(transaction, collectionId);
      await transaction.insertInto('resource_id_ledger')
        .values({ resource_id: marker, resource_type: 'node' }).execute();
      await transaction.updateTable('collections').set({ content_revision: 'c-u9-rollback' })
        .where('id', '=', collectionId).execute();
      throw new Error('u9-rollback');
    }), /u9-rollback/);
    const after = await harness.isolated.runtime.pool.query<{
      content_revision: string; commit_ordinal: string;
    }>('select content_revision, commit_ordinal::text from collections where id=$1', [collectionId]);
    assert.deepEqual(after.rows, before.rows);
    const markers = await harness.isolated.runtime.pool.query(
      'select resource_id from resource_id_ledger where resource_id=$1', [marker]);
    assert.equal(markers.rowCount, 0);

    const missed = await harness.createReplica('owner');
    await harness.isolated.runtime.pool.query(`update sync_replicas set status='expired',
      checkpoint_cursor='cursor-4', checkpoint_commit_ordinal=4, checkpoint_stream_kind=0,
      checkpoint_stable_id='op-4',
      wire_json=jsonb_set(jsonb_set(jsonb_set(wire_json, '{status}', '"expired"'),
        '{checkpoint,acknowledgedCursor}', '"cursor-4"'),
        '{checkpoint,acknowledgedCommitOrdinal}', '"4"')
      where replica_id=$1`, [missed.replicaId]);
    await harness.isolated.runtime.pool.query(
      'update collections set commit_ordinal=5 where id=$1', [collectionId]);
    try {
      await assert.rejects(createPostgresReplicaLifecycleService(harness.isolated.runtime.db, {
        leaseId: () => `lease-u9-fault-${randomUUID()}`,
        faultInjector: { afterPhase(phase) { if (phase === 'replica') throw new Error('u9-activate-rollback'); } },
        retentionWindow: { async load(_transaction, id) {
          return { collectionId: id, earliestPull: { cursor: 'cursor-4', commitOrdinal: '4' },
            purgedThrough: { cursor: 'cursor-4', commitOrdinal: '4' }, snapshotUrl: '/snapshots/current' };
        } },
      }).resume({
        scope: { accountId: missed.accountId, collectionId: missed.collectionId, replicaId: missed.replicaId,
          expectedLeaseGeneration: missed.leaseGeneration, expectedLifecycleRevision: missed.lifecycleRevision },
        outcome: 'authorized_success', leaseDurationSeconds: 3_600,
      }), /u9-activate-rollback/);
      const stored = await harness.isolated.runtime.pool.query<{
        status: string; checkpoint_commit_ordinal: string; lifecycle_revision: string; generations: string;
      }>(`select status, checkpoint_commit_ordinal::text, lifecycle_revision::text,
            (select count(*)::text from sync_replica_generations where replica_id=$1) generations
          from sync_replicas where replica_id=$1`, [missed.replicaId]);
      assert.deepEqual(stored.rows[0], {
        status: 'expired', checkpoint_commit_ordinal: '4', lifecycle_revision: '0', generations: '1',
      });
    } finally {
      await harness.isolated.runtime.pool.query(
        'update collections set commit_ordinal=$2::bigint where id=$1',
        [collectionId, before.rows[0]?.commit_ordinal]);
    }
  }, 40_000);

  /**
   * The shared Sync session harness seeds relational rows only; the Product
   * canonical lock asserts resource-payload authority, so give the seeded
   * collection its materialized payload before exercising that path.
   */
  async function backfillCollectionPayload(): Promise<void> {
    const row = (await harness.isolated.runtime.pool.query(
      `select id, owner_subject_id, title, summary, kind, visibility, root_node_id,
              resource_revision, content_revision, policy_revision, commit_ordinal,
              created_at, updated_at, deleted_at
         from collections where id = $1`, [collectionId],
    )).rows[0];
    assert.ok(row, 'the harness must seed the owner collection');
    const materialized = materializeCollectionPayload({
      id: row.id, ownerSubjectId: row.owner_subject_id, title: row.title, summary: row.summary,
      kind: row.kind, visibility: row.visibility, rootNodeId: row.root_node_id,
      resourceRevision: row.resource_revision, contentRevision: row.content_revision,
      policyRevision: row.policy_revision, commitOrdinal: BigInt(row.commit_ordinal),
      createdAt: row.created_at, updatedAt: row.updated_at, deletedAt: row.deleted_at,
    });
    assert.equal(materialized.ok, true);
    await harness.isolated.runtime.pool.query(
      `update collections set payload_json = $2, payload_schema_version = $3,
         payload_authority_status = 'backfilled' where id = $1`,
      [collectionId, materialized.ok ? materialized.payload : {}, RESOURCE_PAYLOAD_SCHEMA_VERSION],
    );
  }

  async function anyBackendWaiting(): Promise<boolean> {
    const blocked = await harness.isolated.runtime.pool.query<{ waiting: boolean }>(`
      select exists(select 1 from pg_stat_activity
        where application_name = 'known-test-t10_lock_order'
          and cardinality(pg_blocking_pids(pid)) > 0) waiting
    `);
    return blocked.rows[0]?.waiting === true;
  }
});

function deferred(): { readonly promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
