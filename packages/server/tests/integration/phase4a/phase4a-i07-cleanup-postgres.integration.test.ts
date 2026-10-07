/**
 * P4A-I07 cleanup claim/complete fencing, finalize mutual exclusion, keyset
 * pagination, and rollback against the PRODUCTION migration.
 *
 * Provider calls (HEAD/DELETE) are driven outside the transaction through a
 * recording store; tests prove the loser sent no wrong DELETE, candidate
 * mismatch quarantines with NO delete, and lease takeover fences with a higher
 * lease generation. Keyset pagination is proven with a fixed-scale fixture
 * (enough retired/orphaned/active rows for a real planner choice) by a cursor
 * proof plus an EXPLAIN plan assertion on the bounded candidate index — the
 * Seq Scan is never disabled to cheat.
 */
import assert from 'node:assert/strict';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, test } from 'vitest';
import { createUnitOfWork } from '../../../src/infrastructure/database/index.js';
import { DatabaseOperationError } from '../../../src/infrastructure/database/index.js';
import { createPostgresAttachmentsPorts } from '../../../src/infrastructure/database/index.js';
import type { DatabaseTransaction } from '../../../src/infrastructure/database/index.js';
import type { AllocateGenerationInput, CompleteGenerationInput, CleanupKeysetCursor } from '../../../src/modules/attachments/index.js';
import { nextCleanupKeysetCursor } from '../../../src/modules/attachments/index.js';
import {
  BarrierGroup,
  RecordingObjectStore,
  createI07MigrationRuntime,
  i07Uow,
  identityFor,
  makeBucket,
  uuidFor,
  sha256Hex,
  keyFor,
  type I07MigrationRuntime,
} from '../../support/phase4a-i07-test-helpers.js';
import { describeWithPostgres } from '../../support/postgres-test-runtime.js';

const BYTES_OLD = new TextEncoder().encode('retired-bytes-marker-old');
const BYTES_NEW = new TextEncoder().encode('active-bytes-marker-new');

const ports = createPostgresAttachmentsPorts();

function allocateInput(id: ReturnType<typeof identityFor>, overrides: Partial<AllocateGenerationInput> = {}): AllocateGenerationInput {
  return {
    blobId: id.blobId,
    intentId: id.intentId,
    generationId: id.generationId,
    principalId: 'principal-i07',
    collectionId: 'collection-i07',
    subjectIdentity: 'subject-owner-i07',
    bucket: makeBucket(),
    key: id.key,
    keyFingerprint: id.fingerprint,
    expectedSize: 7,
    expectedSha256: 'a'.repeat(64),
    mediaHint: 'application/octet-stream',
    policyRevision: 'policy-rev-1',
    idempotencyKey: `idem-${id.intentId}`,
    expiresAt: new Date(Date.now() + 3_600_000),
    ...overrides,
  };
}

function completeForStore(id: ReturnType<typeof identityFor>, store: RecordingObjectStore, blobId = id.blobId): CompleteGenerationInput {
  const etag = store.etagOf(id.key);
  const size = store.bytesOf(id.key)?.byteLength;
  if (!etag || size === undefined) throw new Error('store must be seeded before complete');
  return {
    intentId: id.intentId, generationId: id.generationId, blobId,
    observedEtag: etag, observedSize: size, observedContentType: 'application/octet-stream',
    observedMetadata: { probe: 'phase4a-i07' },
  };
}

async function seedBlobWithRetired(runtime: I07MigrationRuntime['runtime'], old: ReturnType<typeof identityFor>, next: ReturnType<typeof identityFor>, store: RecordingObjectStore): Promise<void> {
  const uow = i07Uow(runtime);
  store.seed(old.key, BYTES_OLD);
  store.seed(next.key, BYTES_NEW);
  await uow.execute((tx) => ports.allocate(tx, allocateInput(old)));
  await uow.execute((tx) => ports.complete(tx, completeForStore(old, store)));
  await uow.execute((tx) => ports.allocate(tx, allocateInput(next, { blobId: old.blobId })));
  await uow.execute((tx) => ports.complete(tx, completeForStore(next, store, old.blobId)));
  await uow.execute((tx) => ports.activateReplacement(tx, {
    blobId: old.blobId, expectedActiveGenerationId: old.generationId, newGenerationId: next.generationId,
  }));
}

async function seedStoredPrivate(runtime: I07MigrationRuntime['runtime'], blobId: string): Promise<void> {
  await sql`
    update blob_records
    set logical_state = 'stored_private', verification_policy_version = 'phase4a-i07-fixture', verified_size = 8, verified_sha256 = ${'b'.repeat(64)},
        media_type = 'application/octet-stream'
    where blob_id = ${blobId}
  `.execute(runtime.db);
}

async function generationRowFor(runtime: I07MigrationRuntime['runtime'], generationId: string) {
  const result = await sql<{
    generation_state: string; cleanup_attempt_token: string | null; cleanup_lease_owner: string | null;
    cleanup_lease_generation: string; confirmed_absent_at: Date | null; deleted_at: Date | null;
    quarantined_at: Date | null; quarantined_reason: string | null; contract_corrupt_at: Date | null;
  }>`
    select generation_state, cleanup_attempt_token, cleanup_lease_owner, cleanup_lease_generation::text,
           confirmed_absent_at, deleted_at, quarantined_at, quarantined_reason, contract_corrupt_at
    from blob_generations where generation_id = ${generationId}
  `.execute(runtime.db);
  assert.ok(result.rows[0], `generation ${generationId} must exist`);
  return result.rows[0]!;
}

async function withLockTimeout<Result>(
  uow: ReturnType<typeof i07Uow>,
  timeoutMs: number,
  operation: (tx: DatabaseTransaction) => Promise<Result>,
): Promise<Result> {
  return uow.execute(async (tx) => {
    await sql.raw(`SET LOCAL lock_timeout = '${timeoutMs}ms'`).execute(tx);
    return operation(tx);
  });
}

/**
 * Seeds a fixed-scale keyset fixture in ONE transaction with batched
 * multi-row inserts: `candidateCount` retired/orphaned generations on their own
 * blobs plus `activeCount` active generations. `created_at` is deterministic
 * (`epoch + n seconds`) so the keyset order is provable and the planner sees
 * enough rows to choose the bounded candidate index.
 */
async function seedKeysetFixture(
  runtime: I07MigrationRuntime['runtime'],
  candidateCount: number,
  activeCount: number,
): Promise<void> {
  const keyRows: unknown[][] = [];
  const blobRows: unknown[][] = [];
  const generationRows: unknown[][] = [];
  for (let n = 0; n < candidateCount; n += 1) {
    const slot = 100 + n;
    const blobId = uuidFor(9000 + slot);
    const generationId = uuidFor(9100 + slot);
    const key = keyFor(uuidFor(9200 + slot));
    const state = n % 2 === 0 ? 'retired' : 'orphaned';
    keyRows.push([generationId, key, sha256Hex(key), blobId]);
    blobRows.push([blobId, 'subject-owner']);
    generationRows.push([generationId, blobId, makeBucket(), key, sha256Hex(key), state, n]);
  }
  for (let n = 0; n < activeCount; n += 1) {
    const slot = 1000 + n;
    const blobId = uuidFor(9000 + slot);
    const generationId = uuidFor(9100 + slot);
    const key = keyFor(uuidFor(9200 + slot));
    keyRows.push([generationId, key, sha256Hex(key), blobId]);
    blobRows.push([blobId, 'subject-owner']);
    generationRows.push([generationId, blobId, makeBucket(), key, sha256Hex(key), 'active', 10_000 + n]);
  }

  const client = await runtime.pool.connect();
  try {
    await client.query('begin');
    const keyValues = keyRows.map((_, i) => `($${i * 4 + 1}, $${i * 4 + 2}, $${i * 4 + 3}, $${i * 4 + 4})`).join(', ');
    await client.query(
      // created_reason defaults to 'allocate'; the fixture only binds the four identity columns.
      `insert into generation_keys (generation_id, key, key_fingerprint, blob_id)
       values ${keyValues}`,
      keyRows.flat(),
    );
    const blobValues = blobRows.map((_, i) => `($${i * 2 + 1}, $${i * 2 + 2})`).join(', ');
    await client.query(
      `insert into blob_records (blob_id, owner_subject_id) values ${blobValues}`,
      blobRows.flat(),
    );
    const generationValues = generationRows.map((_, i) =>
      `($${i * 7 + 1}, $${i * 7 + 2}, $${i * 7 + 3}, $${i * 7 + 4}, $${i * 7 + 5}, $${i * 7 + 6}, '2026-08-08T00:00:00Z'::timestamptz + make_interval(secs => $${i * 7 + 7}))`).join(', ');
    await client.query(
      `insert into blob_generations (generation_id, blob_id, bucket, key, key_fingerprint, generation_state, created_at)
       values ${generationValues}`,
      generationRows.flat(),
    );
    for (let n = 0; n < activeCount; n += 1) {
      const slot = 1000 + n;
      const blobId = uuidFor(9000 + slot);
      const generationId = uuidFor(9100 + slot);
      await client.query(`update blob_records set current_generation_id = $2 where blob_id = $1`, [blobId, generationId]);
    }
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

describeWithPostgres('P4A-I07 cleanup fencing, keyset pagination, and rollback', () => {
  let isolated: I07MigrationRuntime;

  beforeAll(async () => {
    isolated = await createI07MigrationRuntime('i07_cleanup', { maxConnections: 10 });
  });

  afterAll(async () => {
    await isolated?.dropSchema();
  });

  test('cleanup deletes only the retired key and preserves the active bytes', async () => {
    const g1 = identityFor(1);
    const g2 = identityFor(2);
    const store = new RecordingObjectStore();
    await seedBlobWithRetired(isolated.runtime, g1, g2, store);
    const uow = i07Uow(isolated.runtime);

    const claim = await uow.execute((tx) => ports.claimCleanup(tx, { leaseOwner: 'cleaner', leaseTtlSeconds: 60, generationId: g1.generationId }));
    assert.equal(claim.outcome, 'claimed');
    const claimFacts = claim.claim;
    assert.equal(claimFacts.key, g1.key, 'the claim must snapshot the exact retired key');
    assert.equal(claimFacts.currentGenerationId, g2.generationId, 'the claim must never be the current generation');

    const head = await store.head({ bucket: claimFacts.bucket, key: claimFacts.key });
    assert.equal(head.class, 'ok');
    const deleted = await store.deleteExactKey({ bucket: claimFacts.bucket, key: claimFacts.key });
    assert.equal(deleted.class, 'deleted');
    const absent = await store.head({ bucket: claimFacts.bucket, key: claimFacts.key });
    assert.equal(absent.class, 'not_found');

    const completed = await uow.execute((tx) => ports.completeCleanup(tx, { claim: claimFacts, verdict: 'deleted' }));
    assert.equal(completed.outcome, 'completed');
    assert.deepEqual(store.deletedKeys(), [g1.key], 'only the retired key may be deleted');
    assert.equal(store.bytesOf(g2.key)?.byteLength, BYTES_NEW.byteLength, 'active bytes must be preserved');
    assert.equal(store.bytesOf(g1.key), undefined, 'retired key must be confirmed absent');

    const row = await generationRowFor(isolated.runtime, g1.generationId);
    assert.equal(row.generation_state, 'deleted');
    assert.ok(row.confirmed_absent_at, 'deletion evidence must be recorded');
    assert.ok(row.deleted_at);
  });

  test('cleanup can only claim retired/orphaned generations, never the active one', async () => {
    const g1 = identityFor(3);
    const g2 = identityFor(4);
    const store = new RecordingObjectStore();
    await seedBlobWithRetired(isolated.runtime, g1, g2, store);

    const activeClaim = await i07Uow(isolated.runtime).execute((tx) => ports.claimCleanup(tx, {
      leaseOwner: 'cleaner', leaseTtlSeconds: 60, generationId: g2.generationId,
    }));
    assert.equal(activeClaim.outcome, 'not_claimable');
    assert.deepEqual(store.deleteCalls, [], 'no DELETE may be sent for the active generation');
  });

  test('two cleanup owners: lease held, then takeover with a higher lease generation', async () => {
    const g1 = identityFor(5);
    const g2 = identityFor(6);
    const store = new RecordingObjectStore();
    await seedBlobWithRetired(isolated.runtime, g1, g2, store);
    const uow = i07Uow(isolated.runtime);

    const ownerA = await uow.execute((tx) => ports.claimCleanup(tx, { leaseOwner: 'owner-a', leaseTtlSeconds: 3_600, generationId: g1.generationId }));
    assert.equal(ownerA.outcome, 'claimed');

    const ownerBWhileHeld = await uow.execute((tx) => ports.claimCleanup(tx, { leaseOwner: 'owner-b', leaseTtlSeconds: 60, generationId: g1.generationId }));
    assert.equal(ownerBWhileHeld.outcome, 'lease_held');

    // Lease expires (database clock); owner B takes over with a higher lease generation.
    await sql`update blob_generations set cleanup_lease_expires_at = now() - interval '1 second' where generation_id = ${g1.generationId}`.execute(isolated.runtime.db);
    const ownerB = await uow.execute((tx) => ports.claimCleanup(tx, { leaseOwner: 'owner-b', leaseTtlSeconds: 60, generationId: g1.generationId }));
    assert.equal(ownerB.outcome, 'claimed');
    assert.ok(BigInt(ownerB.claim.leaseGeneration) > BigInt(ownerA.claim.leaseGeneration), 'takeover must fence with a higher lease generation');

    // The stale owner A can no longer commit anything.
    const staleComplete = await uow.execute((tx) => ports.completeCleanup(tx, { claim: ownerA.claim, verdict: 'deleted' }));
    assert.equal(staleComplete.outcome, 'lease_lost');

    const bComplete = await uow.execute((tx) => ports.completeCleanup(tx, { claim: ownerB.claim, verdict: 'confirmed_absent' }));
    assert.equal(bComplete.outcome, 'completed');
    const row = await generationRowFor(isolated.runtime, g1.generationId);
    assert.equal(row.generation_state, 'deleted');
    assert.deepEqual(store.deleteCalls, [], 'no DELETE may be sent by the takeover test');
  });

  test('finalize locks first: a cleanup claim blocks with lock_timeout until finalize commits', async () => {
    const g1 = identityFor(7);
    const g2 = identityFor(8);
    const store = new RecordingObjectStore();
    await seedBlobWithRetired(isolated.runtime, g1, g2, store);
    await seedStoredPrivate(isolated.runtime, g1.blobId);
    const uow = i07Uow(isolated.runtime);
    const group = new BarrierGroup();
    const finalizeBarrier = { arriveAndWait: (name: string) => group.arriveAndWait(`${name}:f`) };

    const finalizePromise = uow.execute((tx) => ports.finalizeLock(tx, {
      blobId: g1.blobId, leaseOwner: 'finalizer', leaseTtlSeconds: 60,
    }, { barrier: finalizeBarrier }));
    await group.waitArrived('after_finalize_lock:f');

    await assert.rejects(
      withLockTimeout(uow, 400, (tx) => ports.claimCleanup(tx, { leaseOwner: 'cleaner', leaseTtlSeconds: 60, generationId: g1.generationId })),
      (error: unknown) => error instanceof DatabaseOperationError && error.kind === 'lock_timeout',
    );

    group.release('after_finalize_lock:f');
    const locked = await finalizePromise;
    assert.equal(locked.outcome, 'locked');
    assert.equal(locked.currentGenerationId, g2.generationId);

    const claim = await uow.execute((tx) => ports.claimCleanup(tx, { leaseOwner: 'cleaner', leaseTtlSeconds: 60, generationId: g1.generationId }));
    assert.equal(claim.outcome, 'claimed');
    assert.deepEqual(store.deleteCalls, [], 'no DELETE may be sent while the blob is finalize-locked');
  });

  test('cleanup claims first: finalize waits for the claim transaction, then locks the current generation', async () => {
    const g1 = identityFor(9);
    const g2 = identityFor(10);
    const store = new RecordingObjectStore();
    await seedBlobWithRetired(isolated.runtime, g1, g2, store);
    await seedStoredPrivate(isolated.runtime, g1.blobId);
    const uow = i07Uow(isolated.runtime);
    const group = new BarrierGroup();
    const claimBarrier = { arriveAndWait: (name: string) => group.arriveAndWait(`${name}:c`) };

    const claimPromise = uow.execute((tx) => ports.claimCleanup(tx, {
      leaseOwner: 'cleaner', leaseTtlSeconds: 60, generationId: g1.generationId,
    }, { barrier: claimBarrier }));
    await group.waitArrived('before_cleanup_claim:c');
    group.release('before_cleanup_claim:c');
    await group.waitArrived('after_cleanup_claim:c');

    await assert.rejects(
      withLockTimeout(uow, 400, (tx) => ports.finalizeLock(tx, { blobId: g1.blobId, leaseOwner: 'finalizer', leaseTtlSeconds: 60 })),
      (error: unknown) => error instanceof DatabaseOperationError && error.kind === 'lock_timeout',
    );

    group.release('after_cleanup_claim:c');
    const claimed = await claimPromise;
    assert.equal(claimed.outcome, 'claimed');

    const locked = await uow.execute((tx) => ports.finalizeLock(tx, { blobId: g1.blobId, leaseOwner: 'finalizer', leaseTtlSeconds: 60 }));
    assert.equal(locked.outcome, 'locked');
    assert.equal(locked.currentGenerationId, g2.generationId);
  });

  test('candidate mismatch quarantines the generation and sends NO delete', async () => {
    const g1 = identityFor(11);
    const g2 = identityFor(12);
    const store = new RecordingObjectStore();
    await seedBlobWithRetired(isolated.runtime, g1, g2, store);
    const uow = i07Uow(isolated.runtime);

    const claim = await uow.execute((tx) => ports.claimCleanup(tx, { leaseOwner: 'cleaner', leaseTtlSeconds: 60, generationId: g1.generationId }));
    assert.equal(claim.outcome, 'claimed');

    // Same-key corruption: the provider object at the retired key now differs
    // from the claimed snapshot (bytes/ETag/size changed).
    store.objects.set(g1.key, { etag: '"tampered"', size: 999, bytes: BYTES_OLD, metadata: {} });
    const head = await store.head({ bucket: claim.claim.bucket, key: claim.claim.key });
    assert.equal(head.class, 'ok');
    assert.notEqual(head.etag, claim.claim.observedEtag);

    const completed = await uow.execute((tx) => ports.completeCleanup(tx, {
      claim: claim.claim, verdict: 'candidate_mismatch', mismatchReason: 'candidate_mismatch',
    }));
    assert.equal(completed.outcome, 'quarantined');
    assert.deepEqual(store.deletedKeys(), [], 'mismatch must never send a DELETE');

    const row = await generationRowFor(isolated.runtime, g1.generationId);
    assert.equal(row.generation_state, 'quarantined');
    assert.equal(row.quarantined_reason, 'candidate_mismatch');
    assert.ok(row.contract_corrupt_at, 'the quarantine must traverse the contract_corrupt step');
    assert.ok(row.quarantined_at);
    assert.equal(store.bytesOf(g1.key)?.byteLength, BYTES_OLD.byteLength, 'quarantined bytes stay untouched for operator review');

    const reClaim = await uow.execute((tx) => ports.claimCleanup(tx, { leaseOwner: 'cleaner', leaseTtlSeconds: 60, generationId: g1.generationId }));
    assert.equal(reClaim.outcome, 'not_claimable');
  });

  test('unknown cleanup outcome releases the lease for a later takeover', async () => {
    const g1 = identityFor(13);
    const g2 = identityFor(14);
    const store = new RecordingObjectStore();
    await seedBlobWithRetired(isolated.runtime, g1, g2, store);
    const uow = i07Uow(isolated.runtime);

    const claim = await uow.execute((tx) => ports.claimCleanup(tx, { leaseOwner: 'cleaner', leaseTtlSeconds: 60, generationId: g1.generationId }));
    assert.equal(claim.outcome, 'claimed');
    const released = await uow.execute((tx) => ports.completeCleanup(tx, { claim: claim.claim, verdict: 'unknown_retryable' }));
    assert.equal(released.outcome, 'released');
    const row = await generationRowFor(isolated.runtime, g1.generationId);
    assert.equal(row.generation_state, 'deletion_pending');
    assert.equal(row.cleanup_lease_owner, null, 'the lease must be released');
    assert.equal(row.cleanup_attempt_token, null);
    assert.equal(store.bytesOf(g1.key) !== undefined, true, 'the object still exists for a later takeover');
  });

  // The keyset proof must run against a HERMETIC schema: the earlier tests in
  // this file leave retired/deletion_pending generations behind (unclaimed or
  // lease-released), which would otherwise join the candidate scan and break
  // the exact batch/order accounting. A dedicated schema keeps the seeded
  // fixture the only candidate source.
  describe('P4A-I07 keyset pagination and query plan (hermetic schema)', () => {
    let keyset: I07MigrationRuntime;

    beforeAll(async () => {
      keyset = await createI07MigrationRuntime('i07_keyset', { maxConnections: 10 });
      // The EXPLAIN plan proof runs FIRST while the full fixture is still
      // unclaimed, so the planner sees the complete 640-row table and must
      // choose the bounded candidate index for first/middle/final batches.
      await seedKeysetFixture(keyset.runtime, 600, 40);
    }, 120_000);

    afterAll(async () => {
      await keyset?.dropSchema();
    });

    test('cleanup keyset query uses the bounded candidate index for first/middle/final plans (no Seq Scan)', async () => {
      const planFor = async (cursor: CleanupKeysetCursor | null) => {
        const createdAtBound = cursor?.createdAtIso ?? '1970-01-01T00:00:00.000Z';
        const generationBound = cursor?.generationId ?? '';
        const result = await keyset.runtime.pool.query<Record<string, unknown>>(`
          explain (format json)
          select bg2.generation_id
          from blob_generations bg2
          join blob_records br2 on br2.blob_id = bg2.blob_id
          where bg2.generation_state in ('retired','orphaned','deletion_pending')
            and (bg2.cleanup_lease_expires_at is null or bg2.cleanup_lease_expires_at < now())
            and br2.current_generation_id is distinct from bg2.generation_id
            and (bg2.created_at, bg2.generation_id) > ($1::timestamptz, $2)
          order by bg2.created_at, bg2.generation_id
          limit 50
        `, [createdAtBound, generationBound]);
        return JSON.stringify(result.rows[0]);
      };

      // First batch: no cursor. Middle batch: after the first page. Final batch:
      // near the end of the candidate window. All must use the bounded index.
      const first = await planFor(null);
      assert.match(first, /blob_generations_cleanup_candidate_idx/, 'first-batch plan must use the candidate index');
      assert.doesNotMatch(first, /Seq Scan/);

      const middle = await planFor({ createdAtIso: '2026-08-08T00:00:49.000Z', generationId: uuidFor(9249) });
      assert.match(middle, /blob_generations_cleanup_candidate_idx/, 'middle-batch plan must use the candidate index');
      assert.doesNotMatch(middle, /Seq Scan/);

      const final = await planFor({ createdAtIso: '2026-08-08T00:09:09.000Z', generationId: uuidFor(9749) });
      assert.match(final, /blob_generations_cleanup_candidate_idx/, 'final-batch plan must use the candidate index');
      assert.doesNotMatch(final, /Seq Scan/);
    }, 60_000);

    test('cleanup keyset pagination: first/middle/final batches are disjoint, ordered, and complete', async () => {
      const CANDIDATES = 600;
      const BATCH = 50;
      const uow = i07Uow(keyset.runtime);
      const seen: string[] = [];
      let cursor: CleanupKeysetCursor | null = null;
      let batches = 0;
      for (;;) {
        const result = await uow.execute((tx) => ports.claimCleanup(tx, { leaseOwner: 'keyset-cleaner', leaseTtlSeconds: 60, limit: BATCH, cursor }));
        if (result.outcome !== 'batch') break;
        batches += 1;
        if (result.claims.length === 0) break;
        seen.push(...result.claims.map((claim) => claim.generationId));
        const lastClaim = result.claims[result.claims.length - 1]!;
        cursor = nextCleanupKeysetCursor({ createdAt: lastClaim.createdAt, generationId: lastClaim.generationId });
      }
      assert.equal(batches, Math.ceil(CANDIDATES / BATCH), 'each batch must be bounded by limit and advance the cursor');
      assert.equal(seen.length, CANDIDATES, 'every retired/orphaned candidate must be claimed exactly once');
      assert.equal(new Set(seen).size, CANDIDATES, 'no generation may be claimed twice');

      // Order proof: claims follow (created_at, generation_id) strictly.
      const claimedRows = await sql<{ generation_id: string; created_at: Date }>`
        select generation_id, created_at from blob_generations
        where generation_id = any(${seen}::text[])
      `.execute(keyset.runtime.db);
      const byId = new Map(claimedRows.rows.map((row) => [row.generation_id, row.created_at.toISOString()]));
      for (let i = 1; i < seen.length; i += 1) {
        const left = `${byId.get(seen[i - 1]!)}|${seen[i - 1]}`;
        const right = `${byId.get(seen[i]!)}|${seen[i]}`;
        assert.ok(left < right, `claims must be strictly ordered at index ${i}`);
      }
    }, 60_000);
  });

  test('rollback at the cleanup write point: a commit fault leaves the claim durable and reclaimable', async () => {
    const g1 = identityFor(15);
    const g2 = identityFor(16);
    const store = new RecordingObjectStore();
    await seedBlobWithRetired(isolated.runtime, g1, g2, store);

    const claimUow = i07Uow(isolated.runtime);
    const claim = await claimUow.execute((tx) => ports.claimCleanup(tx, { leaseOwner: 'cleaner', leaseTtlSeconds: 60, generationId: g1.generationId }));
    assert.equal(claim.outcome, 'claimed');

    const faultUow = createUnitOfWork(isolated.runtime.db, {
      faultInjector: {
        afterCallbackBeforeCommit: async () => {
          throw new Error('simulated crash before commit');
        },
      },
    });
    await assert.rejects(
      faultUow.execute(({ transaction }) => ports.completeCleanup(transaction, { claim: claim.claim, verdict: 'confirmed_absent' })),
      /simulated crash before commit/,
    );
    const row = await generationRowFor(isolated.runtime, g1.generationId);
    assert.equal(row.generation_state, 'deletion_pending', 'the deletion evidence must not be half-written');
    assert.equal(row.cleanup_attempt_token, claim.claim.attemptToken, 'the durable claim must survive the failed commit');
    assert.equal(store.bytesOf(g1.key)?.byteLength, BYTES_OLD.byteLength, 'no provider call may be recorded as committed');

    // The same claim can be replayed after recovery.
    const completed = await claimUow.execute((tx) => ports.completeCleanup(tx, { claim: claim.claim, verdict: 'confirmed_absent' }));
    assert.equal(completed.outcome, 'completed');
    const finalRow = await generationRowFor(isolated.runtime, g1.generationId);
    assert.equal(finalRow.generation_state, 'deleted');
    assert.ok(finalRow.confirmed_absent_at);
  });
});

