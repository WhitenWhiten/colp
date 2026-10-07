import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, test } from 'vitest';
import { createUnitOfWork, runMigrations, type DatabaseRuntime } from '../../../src/infrastructure/database/index.js';
import {
  createPostgresPublisherIdempotencyPort,
  createPostgresPublisherReceiptMaintenancePort,
  createPostgresPublisherReceiptMaintenancePortFactory,
} from '../../../src/infrastructure/publisher/index.js';
import type {
  PublisherIdempotencyBinding,
  PublisherStoredResult,
} from '../../../src/modules/publisher/index.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';

const DAY_SECONDS = 86_400;

function binding(id = randomUUID()): PublisherIdempotencyBinding {
  return {
    namespace: 'publisher:collection.create',
    principalId: 'publisher-retention-principal',
    idempotencyKey: id,
  };
}

function result(): PublisherStoredResult {
  return {
    status: 201,
    body: Buffer.from('{"collectionId":"retained"}'),
    stableHeaders: {
      'content-type': 'application/json',
      location: '/collections/c/retained',
    },
    mediaType: 'application/json',
    contractVersion: '1.0.0',
    targetIdentity: 'retained',
  };
}

describeWithPostgres('Publisher receipt retention policy', () => {
  let isolated: IsolatedPostgresRuntime;
  let runtime: DatabaseRuntime;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('publisher_receipt_retention', {
      maxConnections: 6,
      applicationName: 'known-publisher-receipt-retention-test',
    });
    runtime = isolated.runtime;
    await runMigrations(runtime.db, 'latest');
  });

  afterAll(async () => {
    await isolated?.close();
  });

  async function claim(seen: PublisherIdempotencyBinding, fingerprint: string) {
    return createUnitOfWork(runtime.db).execute(({ transaction }) =>
      createPostgresPublisherIdempotencyPort(transaction).claim(seen, fingerprint));
  }

  async function complete(
    seen: PublisherIdempotencyBinding,
    fingerprint: string,
  ): Promise<void> {
    await createUnitOfWork(runtime.db).execute(async ({ transaction }) => {
      const receipts = createPostgresPublisherIdempotencyPort(transaction);
      assert.deepEqual(await receipts.claim(seen, fingerprint), { kind: 'claimed' });
      await receipts.complete(seen, fingerprint, result());
    });
  }

  async function purge(limit = 100): Promise<number> {
    return createUnitOfWork(runtime.db).execute(({ transaction }) =>
      createPostgresPublisherReceiptMaintenancePort(transaction).purgeExpired({ limit }));
  }

  test('actual receipt writer enforces the fixed Manifest TTL and replays only while retained', async () => {
    const seen = binding();
    const fingerprint = 'a'.repeat(64);
    await complete(seen, fingerprint);

    const stored = await runtime.pool.query<{
      completed_at: Date;
      result_expires_at: Date;
    }>(`select completed_at, result_expires_at
          from publisher_idempotency
         where namespace = $1 and principal_id = $2 and idempotency_key = $3`,
    [seen.namespace, seen.principalId, seen.idempotencyKey]);
    assert.equal(
      stored.rows[0]!.result_expires_at.getTime() - stored.rows[0]!.completed_at.getTime(),
      DAY_SECONDS * 1_000,
    );

    await runtime.pool.query(`update publisher_idempotency
      set completed_at = current_timestamp - interval '1 day' + interval '10 seconds',
          result_expires_at = current_timestamp + interval '10 seconds'
      where namespace = $1 and principal_id = $2 and idempotency_key = $3`,
    [seen.namespace, seen.principalId, seen.idempotencyKey]);
    assert.equal(await purge(), 0);
    assert.equal((await claim(seen, fingerprint)).kind, 'replay');

    await runtime.pool.query(`update publisher_idempotency
      set completed_at = current_timestamp - interval '1 day',
          result_expires_at = current_timestamp
      where namespace = $1 and principal_id = $2 and idempotency_key = $3`,
    [seen.namespace, seen.principalId, seen.idempotencyKey]);
    assert.equal(await purge(), 1);
    assert.deepEqual(await claim(seen, fingerprint), { kind: 'claimed' });
  });

  test('database rejects receipt retention below the fixed Manifest TTL', async () => {
    const seen = binding();
    await complete(seen, 'b'.repeat(64));
    await assert.rejects(runtime.pool.query(`update publisher_idempotency
      set result_expires_at = completed_at + interval '86399 seconds'
      where namespace = $1 and principal_id = $2 and idempotency_key = $3`,
    [seen.namespace, seen.principalId, seen.idempotencyKey]), /publisher_receipt_replay_window/i);
  });

  test('purges completed receipts in bounded batches and never purges in-progress receipts', async () => {
    const completed = [binding(), binding(), binding()];
    for (const [index, seen] of completed.entries()) {
      await complete(seen, String(index + 1).repeat(64));
    }
    const inProgress = binding();
    assert.deepEqual(await claim(inProgress, 'f'.repeat(64)), { kind: 'claimed' });
    const unrelated = binding();
    await complete(unrelated, 'e'.repeat(64));

    await runtime.pool.query(`update publisher_idempotency
      set completed_at = current_timestamp - interval '2 days',
          result_expires_at = current_timestamp - interval '1 day'
      where namespace = $1 and principal_id = $2 and idempotency_key = any($3::text[])`,
    [completed[0]!.namespace, completed[0]!.principalId,
      completed.map((seen) => seen.idempotencyKey)]);
    assert.equal(await purge(2), 2);
    assert.equal(await purge(2), 1);
    assert.equal(await purge(2), 0);

    const expiredCaseRows = await runtime.pool.query<{ count: string }>(
      `select count(*)::text as count from publisher_idempotency
        where namespace = $1 and principal_id = $2 and idempotency_key = any($3::text[])`,
      [completed[0]!.namespace, completed[0]!.principalId,
        completed.map((seen) => seen.idempotencyKey)],
    );
    assert.equal(expiredCaseRows.rows[0]?.count, '0');

    const live = await runtime.pool.query<{ completed_at: Date | null }>(
      `select completed_at from publisher_idempotency
        where namespace = $1 and principal_id = $2 and idempotency_key = $3`,
      [inProgress.namespace, inProgress.principalId, inProgress.idempotencyKey],
    );
    assert.equal(live.rowCount, 1);
    assert.equal(live.rows[0]?.completed_at, null);
    assert.equal((await claim(unrelated, 'e'.repeat(64))).kind, 'replay');
  });

  test('classifies in-progress and reused claims and rejects completion by a non-owner fingerprint', async () => {
    const seen = binding();
    const fingerprint = 'd'.repeat(64);
    assert.deepEqual(await claim(seen, fingerprint), { kind: 'claimed' });
    assert.deepEqual(await claim(seen, fingerprint), { kind: 'in_progress', retryAfterSeconds: 1 });
    assert.deepEqual(await claim(seen, 'e'.repeat(64)), { kind: 'reused' });

    await assert.rejects(
      createUnitOfWork(runtime.db).execute(({ transaction }) =>
        createPostgresPublisherIdempotencyPort(transaction).complete(
          seen,
          'f'.repeat(64),
          result(),
        )),
      /publisher receipt was not claim owner/u,
    );
    assert.deepEqual(await claim(seen, fingerprint), { kind: 'in_progress', retryAfterSeconds: 1 });
  });

  test('maintenance factory applies default, lower and upper purge bounds in fresh transactions', async () => {
    const bounded = [binding(), binding(), binding()];
    for (const [index, seen] of bounded.entries()) {
      await complete(seen, `${index + 4}`.repeat(64));
    }
    await runtime.pool.query(`update publisher_idempotency
      set completed_at = current_timestamp - interval '2 days',
          result_expires_at = current_timestamp - interval '1 day'
      where namespace = $1 and principal_id = $2 and idempotency_key = any($3::text[])`,
    [bounded[0]!.namespace, bounded[0]!.principalId, bounded.map((seen) => seen.idempotencyKey)]);

    const createMaintenancePort = createPostgresPublisherReceiptMaintenancePortFactory(runtime.db);
    assert.equal(await (await createMaintenancePort()).purgeExpired({ limit: 0 }), 1);
    assert.equal(await (await createMaintenancePort()).purgeExpired({ limit: 10_001 }), 2);

    const defaultBound = binding();
    await complete(defaultBound, '9'.repeat(64));
    await runtime.pool.query(`update publisher_idempotency
      set completed_at = current_timestamp - interval '2 days',
          result_expires_at = current_timestamp - interval '1 day'
      where namespace = $1 and principal_id = $2 and idempotency_key = $3`,
    [defaultBound.namespace, defaultBound.principalId, defaultBound.idempotencyKey]);
    assert.equal(await (await createMaintenancePort()).purgeExpired(), 1);
  });

  test('concurrent replay claim fences cleanup and cleanup skips the locked receipt', async () => {
    const seen = binding();
    const fingerprint = 'c'.repeat(64);
    await complete(seen, fingerprint);
    await runtime.pool.query(`update publisher_idempotency
      set completed_at = current_timestamp - interval '2 days',
          result_expires_at = current_timestamp - interval '1 day'
      where namespace = $1 and principal_id = $2 and idempotency_key = $3`,
    [seen.namespace, seen.principalId, seen.idempotencyKey]);

    let releaseClaim!: () => void;
    let signalClaimed!: () => void;
    const claimed = new Promise<void>((resolve) => { signalClaimed = resolve; });
    const release = new Promise<void>((resolve) => { releaseClaim = resolve; });
    const activeClaim = createUnitOfWork(runtime.db).execute(async ({ transaction }) => {
      const outcome = await createPostgresPublisherIdempotencyPort(transaction).claim(
        seen,
        fingerprint,
      );
      assert.equal(outcome.kind, 'replay');
      signalClaimed();
      await release;
    });

    await claimed;
    assert.equal(await purge(), 0);
    releaseClaim();
    await activeClaim;
    assert.equal(await purge(), 1);
  });
});
