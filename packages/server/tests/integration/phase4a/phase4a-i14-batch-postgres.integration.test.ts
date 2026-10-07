/**
});
  }, 120_000);
});
/**
 * P4A-I14 PostgreSQL integration suite: batch pagination / fairness and the
 * bounded-index proof for the retention-expired cleanup claim.
 *
 * A fixed-scale fixture (600 retired/orphaned candidates on their own blobs,
 * DB-clock backdated retirement timestamps, deterministic created_at) proves:
 *  - the coordinator pages the whole candidate window with the keyset cursor,
 *    claims every candidate exactly once in (created_at, generation_id)
 *    order, and stops on a short page;
 *  - the retention claim plan uses a bounded partial index (candidate or
 *    retention) with NO Seq Scan — the Seq Scan is never disabled to cheat;
 *  - a crashed owner's lease-held rows are never starved: a later run with a
 *    reset cursor claims them after lease expiry (bounded fairness).
 */
import assert from 'node:assert/strict';
import { sql } from 'kysely';
import { afterAll, beforeAll, test } from 'vitest';
import { createPostgresAttachmentsPorts } from '../../../src/infrastructure/database/index.js';
import {
  runCleanupBatch,
  type CleanupKeysetCursor,
  type RunCleanupBatchInput,
} from '../../../src/modules/attachments/index.js';
import { describeWithPostgres } from '../../support/postgres-test-runtime.js';
import {
  RecordingObjectStore,
  createI07MigrationRuntime,
  keyFor,
  makeBucket,
  sha256Hex,
  uuidFor,
  type I07MigrationRuntime,
} from '../../support/phase4a-i07-test-helpers.js';
import { i14Uow, makeI14Config } from '../../support/phase4a-i14-test-helpers.js';

const ports = createPostgresAttachmentsPorts();

const BATCH_CONFIG = makeI14Config({
  retention: { intentRetentionHours: 1, storedRetentionDays: 1, retiredRetentionDays: 1 },
  cleanupBatchSize: 50,
  cleanup: { leaseMs: 60_000, retryCount: 0 },
});

type I14Tx = { readonly ledger: unknown };

function coordinator(runtime: I07MigrationRuntime['runtime'], store: RecordingObjectStore): RunCleanupBatchInput<I14Tx> {
  return {
    ledger: ports,
    objectStore: {
      async headExact(handle: { generationId: string; key: string }) {
        const out = await store.head({ bucket: 'known-i14', key: handle.key });
        if (out.class === 'ok') return { class: 'ok', identity: { generationId: handle.generationId, etag: out.etag, size: out.size, metadata: {} } };
        if (out.class === 'not_found') return { class: 'not_found' };
        if (out.class === 'denied') return { class: 'denied' };
        if (out.class === 'retryable') return { class: 'retryable' };
        return { class: 'unknown' };
      },
      async readBounded() { throw new Error('unused'); },
      async deleteExact(handle: { generationId: string; key: string }) {
        const out = await store.deleteExactKey({ bucket: 'known-i14', key: handle.key });
        if (out.class === 'deleted') return { class: 'deleted' };
        if (out.class === 'not_found') return { class: 'not_found' };
        if (out.class === 'denied') return { class: 'denied' };
        if (out.class === 'retryable') return { class: 'retryable' };
        return { class: 'unknown' };
      },
      async confirmAbsent(handle: { generationId: string; key: string }) {
        const out = await store.head({ bucket: 'known-i14', key: handle.key });
        return { absent: out.class === 'not_found' };
      },
    } as never,
    config: BATCH_CONFIG,
    uow: i14Uow(runtime),
    leaseOwner: 'batch-cleaner',
  };
}

/** Pages the whole candidate window through the production coordinator. */
async function pageAll(runtime: I07MigrationRuntime['runtime'], store: RecordingObjectStore, leaseOwner = 'batch-cleaner'): Promise<{
  seen: string[];
  runs: number;
}> {
  const seen: string[] = [];
  let cursor: CleanupKeysetCursor | null = null;
  let runs = 0;
  for (let index = 0; index < 200; index += 1) {
    const result = await runCleanupBatch({ ...coordinator(runtime, store), cursor, leaseOwner });
    runs += 1;
    seen.push(...result.outcomes.map((outcome) => outcome.generationId));
    if (result.nextCursor === null) return { seen, runs };
    cursor = result.nextCursor;
  }
  throw new Error('pagination did not terminate');
}

/**
 * Seeds `candidateCount` retired/orphaned generations (alternating) on their
 * own blobs with DB-clock backdated retirement timestamps and deterministic
 * created_at (`epoch + n seconds`), so the keyset order is provable and the
 * planner sees enough rows to choose a bounded index.
 */
async function seedBatchFixture(runtime: I07MigrationRuntime['runtime'], candidateCount: number, slotBase = 100): Promise<void> {
  const client = await runtime.pool.connect();
  try {
    await client.query('begin');
    const keyRows: unknown[][] = [];
    const blobRows: unknown[][] = [];
    const generationRows: unknown[][] = [];
    for (let n = 0; n < candidateCount; n += 1) {
      const slot = slotBase + n;
      const blobId = uuidFor(9000 + slot);
      const generationId = uuidFor(9100 + slot);
      const key = keyFor(uuidFor(9200 + slot));
      const state = n % 2 === 0 ? 'retired' : 'orphaned';
      keyRows.push([generationId, key, sha256Hex(key), blobId]);
      blobRows.push([blobId, 'subject-owner']);
      generationRows.push([generationId, blobId, makeBucket(), key, sha256Hex(key), state, n]);
    }
    const keyValues = keyRows.map((_, i) => `($${i * 4 + 1}, $${i * 4 + 2}, $${i * 4 + 3}, $${i * 4 + 4})`).join(', ');
    await client.query(
      `insert into generation_keys (generation_id, key, key_fingerprint, blob_id) values ${keyValues}`,
      keyRows.flat(),
    );
    const blobValues = blobRows.map((_, i) => `($${i * 2 + 1}, $${i * 2 + 2})`).join(', ');
    await client.query(
      `insert into blob_records (blob_id, owner_subject_id) values ${blobValues}`,
      blobRows.flat(),
    );
    const generationValues = generationRows.map((_, i) =>
      `($${i * 7 + 1}, $${i * 7 + 2}, $${i * 7 + 3}, $${i * 7 + 4}, $${i * 7 + 5}, $${i * 7 + 6}, '2026-08-08T00:00:00Z'::timestamptz + make_interval(secs => $${i * 7 + 7}),
        now() - interval '2 days', now() - interval '2 days')`).join(', ');
    await client.query(
      `insert into blob_generations
         (generation_id, blob_id, bucket, key, key_fingerprint, generation_state, created_at, retired_at, orphaned_at)
       values ${generationValues}`,
      generationRows.flat(),
    );
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

describeWithPostgres('P4A-I14 cleanup batch pagination, fairness, and index proof', () => {
  let isolated: I07MigrationRuntime;

  beforeAll(async () => {
    isolated = await createI07MigrationRuntime('i14_batch', { maxConnections: 10 });
  }, 120_000);

  afterAll(async () => {
    await isolated?.dropSchema();
  });

  test('600 candidates are claimed exactly once, ordered, with a bounded index and no Seq Scan', async () => {
    const CANDIDATES = 600;
    await seedBatchFixture(isolated.runtime, CANDIDATES);

    const planRows = await isolated.runtime.pool.query<Record<string, unknown>>(
      `explain (format json)
        select bg2.generation_id
        from blob_generations bg2
        join blob_records br2 on br2.blob_id = bg2.blob_id
        where bg2.generation_state in ('retired', 'orphaned', 'deletion_pending')
          and (bg2.cleanup_lease_expires_at is null or bg2.cleanup_lease_expires_at < now())
          and br2.current_generation_id is distinct from bg2.generation_id
          and ($1::int is null or bg2.generation_state = 'deletion_pending'
               or coalesce(bg2.retired_at, bg2.orphaned_at) <= now() - make_interval(days => $1))
          and (bg2.created_at, bg2.generation_id) > ($2::timestamptz, $3)
        order by bg2.created_at, bg2.generation_id
        limit 50`,
      [1, '1970-01-01T00:00:00.000Z', ''],
    );
    const plan = JSON.stringify(planRows.rows);
    assert.match(plan, /blob_generations_cleanup_(?:candidate|retention)_idx/, 'the plan must use a bounded cleanup index');
    assert.doesNotMatch(plan, /Seq Scan/, 'the retention claim must never Seq Scan');

    const store = new RecordingObjectStore();
    const { seen, runs } = await pageAll(isolated.runtime, store);
    assert.equal(seen.length, CANDIDATES, 'every candidate is claimed and converged exactly once');
    assert.equal(new Set(seen).size, CANDIDATES, 'no generation is claimed twice');
    assert.ok(runs >= Math.ceil(CANDIDATES / 50), 'each run is bounded by the batch size');

    const claimedRows = await sql<{ generation_id: string; created_at: Date }>`
      select generation_id, created_at from blob_generations
      where generation_id = any(${seen}::text[])
    `.execute(isolated.runtime.db);
    const byId = new Map(claimedRows.rows.map((row) => [row.generation_id, row.created_at.toISOString()]));
    for (let index = 1; index < seen.length; index += 1) {
      const left = `${byId.get(seen[index - 1]!)!}|${seen[index - 1]}`;
      const right = `${byId.get(seen[index]!)!}|${seen[index]}`;
      assert.ok(left < right, `claims must be strictly ordered at index ${index}`);
    }
    const terminal = await sql<{ count: string }>`
      select count(*)::text as count from blob_generations
      where generation_id = any(${seen}::text[]) and generation_state = 'deleted'
    `.execute(isolated.runtime.db);
    assert.equal(terminal.rows[0]!.count, String(CANDIDATES), 'every candidate finally converges to deleted');
  }, 120_000);

  test('a crashed owner is never starved: a reset cursor claims the lease-expired rows', async () => {
    const SMALL = 5;
    await seedBatchFixture(isolated.runtime, SMALL, 2000);
    const store = new RecordingObjectStore();
    const smallConfig = makeI14Config({
      retention: { intentRetentionHours: 1, storedRetentionDays: 1, retiredRetentionDays: 1 },
      cleanupBatchSize: 2,
      cleanup: { leaseMs: 60_000, retryCount: 0 },
    });

    await assert.rejects(
      runCleanupBatch({
        ...coordinator(isolated.runtime, store),
        config: smallConfig,
        leaseOwner: 'owner-a',
        faultInjector: { afterClaim: () => { throw new Error('cleanup_crash:afterClaim'); } },
      }),
      /cleanup_crash:afterClaim/,
    );
    const held = await isolated.runtime.pool.query<{ count: string }>(
      `select count(*)::text as count from blob_generations
       where cleanup_lease_owner = 'owner-a' and generation_state = 'deletion_pending'`,
    );
    assert.equal(held.rows[0]!.count, '2', 'owner A holds exactly the claimed batch');

    const b = await pageAll(isolated.runtime, store, 'owner-b');
    assert.equal(b.seen.length, SMALL - 2, 'owner B converges the unheld candidates');

    await isolated.runtime.pool.query(
      `update blob_generations set cleanup_lease_expires_at = now() - interval '1 second'
       where cleanup_lease_owner = 'owner-a'`,
    );
    const recovered = await pageAll(isolated.runtime, store, 'owner-c');
    assert.equal(recovered.seen.length, 2, 'the crashed owner rows are recovered after lease expiry');

    const myGenerationIds = Array.from({ length: SMALL }, (_, n) => uuidFor(9100 + (2000 + n)));
    const terminal = await sql<{ count: string }>`
      select count(*)::text as count from blob_generations
      where generation_state = 'deleted' and generation_id = any(${myGenerationIds}::text[])
    `.execute(isolated.runtime.db);
    assert.equal(terminal.rows[0]!.count, String(SMALL), 'all candidates converge to deleted');
  }, 120_000);
});
