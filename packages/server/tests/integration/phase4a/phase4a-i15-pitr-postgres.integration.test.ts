/**
 * P4A-I15 PostgreSQL integration suite: PITR reconciliation against the
 * PRODUCTION generation ledger with a recording per-exact-key RO store.
 *
 * Proves, against real PostgreSQL (production migration chain to latest):
 *  - the production ledger port returns exactly the non-deleted generations
 *    (upload point = active, replacement point = retired + active, cleanup
 *    point = deleted EXCLUDED);
 *  - reconcile compares each claimed row with per-exact-key HEAD facts and
 *    reports match / missing / mismatch -> quarantine candidate with ZERO
 *    destructive action and NO bucket list;
 *  - running reconcile before and after a new ledger point changes the claimed
 *    set and the new row is probed;
 *  - provider retryable/denied heads are 'unknown' (environment), never
 *    mismatch (provider throttling is not contract corruption).
 */
import assert from 'node:assert/strict';
import { sql } from 'kysely';
import { afterAll, beforeAll, test } from 'vitest';
import { createPostgresPitrLedgerPort } from '../../../src/infrastructure/database/index.js';
import {
  reconcileGenerationLedger,
  type PitrLedgerPort,
} from '../../../src/modules/attachments/index.js';
import { describeWithPostgres } from '../../support/postgres-test-runtime.js';
import {
  createI07MigrationRuntime,
  identityFor,
  type I07MigrationRuntime,
} from '../../support/phase4a-i07-test-helpers.js';
import {
  seedStoredPrivate,
  seedStoredPrivateWithRetired,
} from '../../support/phase4a-i13-test-helpers.js';
import {
  I15_BUCKET,
  RecordingPitrStore,
} from '../../support/phase4a-i15-test-helpers.js';

async function observedFacts(
  runtime: I07MigrationRuntime['runtime'],
  generationId: string,
): Promise<{ etag: string | null; size: number | null; state: string }> {
  const rows = await sql<{ observed_etag: string | null; observed_size: string | null; generation_state: string }>`
    select observed_etag, observed_size::text as observed_size, generation_state
    from blob_generations where generation_id = ${generationId}
  `.execute(runtime.db);
  assert.ok(rows.rows[0], `generation ${generationId} must exist`);
  const row = rows.rows[0]!;
  return {
    etag: row.observed_etag,
    size: row.observed_size === null ? null : Number(row.observed_size),
    state: row.generation_state,
  };
}

/** Direct-SQL cleanup point: a deleted generation that must never be claimed. */
async function seedDeletedGeneration(
  runtime: I07MigrationRuntime['runtime'],
  id: ReturnType<typeof identityFor>,
): Promise<void> {
  await runtime.pool.query(
    `insert into generation_keys (generation_id, key, key_fingerprint, blob_id, created_reason)
     values ($1, $2, $3, $4, 'allocate')`,
    [id.generationId, id.key, id.fingerprint, id.blobId],
  );
  await runtime.pool.query(
    `insert into blob_records (blob_id, owner_subject_id) values ($1, 'subject-owner')`,
    [id.blobId],
  );
  await runtime.pool.query(
    `insert into blob_generations
       (generation_id, blob_id, bucket, key, key_fingerprint, generation_state, deleted_at, confirmed_absent_at)
     values ($1, $2, $3, $4, $5, 'deleted', now(), now())`,
    [id.generationId, id.blobId, I15_BUCKET, id.key, id.fingerprint],
  );
}

describeWithPostgres('P4A-I15 PITR reconcile against the production ledger', () => {
  let isolated: I07MigrationRuntime;
  let ledgerPort: PitrLedgerPort;

  // upload point (active), replacement point (retired + active), cleanup point
  // (deleted, excluded), missing point (active, no object in the store).
  const upload = identityFor(1);
  const retired = identityFor(2);
  const replacement = identityFor(3);
  const cleaned = identityFor(4);
  const missing = identityFor(5);

  beforeAll(async () => {
    isolated = await createI07MigrationRuntime('i15_pitr', { maxConnections: 10 });
    await seedStoredPrivate(isolated.runtime, upload);
    await seedStoredPrivateWithRetired(isolated.runtime, retired, replacement);
    await seedDeletedGeneration(isolated.runtime, cleaned);
    await seedStoredPrivate(isolated.runtime, missing);
    ledgerPort = createPostgresPitrLedgerPort(isolated.runtime);
  }, 120_000);

  afterAll(async () => {
    await isolated?.dropSchema();
  });

  test('the production ledger port returns exactly the non-deleted generations', async () => {
    const rows = await ledgerPort.listClaimedGenerations();
    const ids = new Set(rows.map((row) => row.generationId));
    assert.ok(ids.has(upload.generationId), 'upload point must be claimed');
    assert.ok(ids.has(retired.generationId), 'replacement (retired) must be claimed');
    assert.ok(ids.has(replacement.generationId), 'replacement (active) must be claimed');
    assert.ok(ids.has(missing.generationId), 'missing point must be claimed');
    assert.ok(!ids.has(cleaned.generationId), 'a deleted generation must never be claimed');
    for (const row of rows) {
      assert.equal(row.bucket, I15_BUCKET);
      assert.ok(row.key.length > 0, 'each claimed row must carry its exact key');
      assert.notEqual(row.generationState, 'deleted');
    }
  });

  test('reconcile reports match/missing/mismatch over the upload/replacement/cleanup points with per-exact-key facts and no destructive action', async () => {
    const store = new RecordingPitrStore();
    const uploadFacts = await observedFacts(isolated.runtime, upload.generationId);
    const retiredFacts = await observedFacts(isolated.runtime, retired.generationId);
    const replacementFacts = await observedFacts(isolated.runtime, replacement.generationId);
    assert.equal(uploadFacts.state, 'active');
    assert.equal(retiredFacts.state, 'retired');
    assert.equal(replacementFacts.state, 'active');
    store.seed(upload.key, uploadFacts.etag!, uploadFacts.size!);           // match
    store.seed(retired.key, '"etag-corrupt"', (retiredFacts.size ?? 0) + 1); // mismatch
    store.seed(replacement.key, replacementFacts.etag!, replacementFacts.size!); // match
    // missing.key is intentionally NOT seeded -> missing.

    const report = await reconcileGenerationLedger({ ledger: ledgerPort, objectStore: store });
    assert.equal(report.plane, 'reconcile');
    assert.equal(report.method, 'per_exact_key_head');
    assert.equal(report.destructiveActionsTaken, false, 'reconcile must never take a destructive action');
    assert.equal(report.counts.match, 2);
    assert.equal(report.counts.missing, 1);
    assert.equal(report.counts.mismatch, 1);
    assert.equal(report.counts.unknown, 0);
    assert.deepEqual(report.quarantineCandidates, [retired.generationId]);

    const byId = new Map(report.findings.map((finding) => [finding.generationId, finding.verdict]));
    assert.equal(byId.get(upload.generationId), 'match');
    assert.equal(byId.get(retired.generationId), 'mismatch');
    assert.equal(byId.get(replacement.generationId), 'match');
    assert.equal(byId.get(missing.generationId), 'missing');

    // Per-exact-key, never a bucket list: every claimed row is probed exactly
    // once and no deleted row is probed.
    assert.deepEqual(
      store.headCalls.map((call) => call.generationId).sort(),
      [upload, retired, replacement, missing].map((id) => id.generationId).sort(),
    );
    assert.equal(store.headCalls.some((call) => call.key === cleaned.key), false);
  });

  test('running reconcile before and after a new ledger point changes the claimed set', async () => {
    const store = new RecordingPitrStore();
    const before = await reconcileGenerationLedger({ ledger: ledgerPort, objectStore: store });
    const beforeCount = before.counts.match + before.counts.missing + before.counts.mismatch + before.counts.unknown;
    assert.equal(store.headCalls.length, beforeCount);

    const extra = identityFor(6);
    await seedStoredPrivate(isolated.runtime, extra);
    const extraFacts = await observedFacts(isolated.runtime, extra.generationId);
    store.seed(extra.key, extraFacts.etag!, extraFacts.size!);

    const after = await reconcileGenerationLedger({ ledger: ledgerPort, objectStore: store });
    const afterCount = after.counts.match + after.counts.missing + after.counts.mismatch + after.counts.unknown;
    assert.equal(afterCount, beforeCount + 1, 'the new ledger point must be claimed by the next reconcile');
    assert.equal(after.counts.match, before.counts.match + 1);
    assert.ok(store.headCalls.some((call) => call.generationId === extra.generationId));
  });

  test('provider retryable/denied heads are unknown, never mismatch', async () => {
    const rows = await ledgerPort.listClaimedGenerations();
    const store = new RecordingPitrStore();
    // Script every claimed row as an environment class (retryable/denied/
    // unknown) so provider throttling can never be misread as corruption.
    store.options.script = rows.map((_row, index) => (
      index % 3 === 0 ? { class: 'retryable' } : index % 3 === 1 ? { class: 'denied' } : { class: 'unknown' }
    ));
    const report = await reconcileGenerationLedger({ ledger: ledgerPort, objectStore: store });
    assert.equal(report.counts.unknown, rows.length, 'environment classes must stay unknown');
    assert.equal(report.counts.mismatch, 0, 'provider throttling must never be reported as corruption');
    assert.equal(report.quarantineCandidates.length, 0);
  });
});