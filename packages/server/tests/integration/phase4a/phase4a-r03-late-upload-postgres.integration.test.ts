/**
 * P4A-R03 PostgreSQL integration suite (part 3): the `late_upload` negative
 * control against the PRODUCTION migration (plan §6 P4A-R03).
 *
 * Proves the frozen complete-upload late-upload policy with the DATABASE
 * clock as the deadline authority: complete before the intent deadline
 * succeeds, complete exactly AT the deadline is late-rejected (inclusive
 * `expires_at <= now()` boundary), and complete AFTER the deadline — crossed
 * by polling the SAME PostgreSQL clock — is `late_rejected`, orphans the
 * generation, expires the blob, writes ZERO outbox rows and NEVER revives the
 * expired key. Duplicate complete converges idempotently on the happy side
 * and stays late-rejected on the late side.
 *
 * Anti-false-positive (plan §4.1/§6 R03): the late case is not a mocked
 * clock or an already-past fixture — the deadline is allocated a few seconds
 * in the future on the DB clock and the test WAITS for the same database to
 * cross it. Anti-false-negative (plan §4.2): the crossing uses a generous
 * DB-clock poll (never a fixed short sleep as the only sync) and the store
 * fixtures come from production ports.
 *
 * The suite also drives the in-run control (`executeR03LateUploadControl`)
 * through the fixed R01 executor contract on the real database.
 */
import assert from 'node:assert/strict';
import { sql } from 'kysely';
import { afterAll, beforeAll, test } from 'vitest';
import { createPostgresAttachmentsPorts, createUnitOfWork } from '../../../src/infrastructure/database/index.js';
import { appendAttachmentsVerificationOutbox } from '../../../src/infrastructure/outbox/index.js';
import {
  completeUpload,
  type CompleteUploadDeps,
} from '../../../src/modules/attachments/index.js';
import type { DatabaseTransaction } from '../../../src/infrastructure/database/index.js';
import { describeWithPostgres } from '../../support/postgres-test-runtime.js';
import { waitForCondition } from '../../support/async-test-helpers.js';
import {
  createI07MigrationRuntime,
  type I07MigrationRuntime,
} from '../../support/phase4a-i07-test-helpers.js';
import {
  I09_COLLECTION,
  InMemoryVerificationObjectStore,
  allocateInput,
  identityFor,
  makeActor,
  makeI09Config,
  sha256HexBytes,
  type I09Identity,
} from '../../support/phase4a-i09-test-helpers.js';
import { I16NegativeControlExecutor } from '../../../scripts/evidence/phase4a-i16-acceptance.js';
import {
  executeR03LateUploadControl,
  type R03ControlDeps,
  type R03LateUploadControlFacts,
} from '../../../scripts/evidence/phase4a-r03-controls.js';

const CONFIG = makeI09Config();
const ports = createPostgresAttachmentsPorts();
const HANDLER = 'attachments_verify_generation';

function pngBody(bytes: number): Uint8Array {
  const body = new Uint8Array(bytes);
  body.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  for (let index = 8; index < body.length; index += 1) body[index] = index % 251;
  return body;
}

async function dbNow(runtime: I07MigrationRuntime['runtime']): Promise<Date> {
  const rows = await sql<{ now: Date }>`select now() as now`.execute(runtime.db);
  return rows.rows[0]!.now;
}

/** Polls the SAME database clock until it strictly passes the deadline. */
async function waitForDbClockPast(runtime: I07MigrationRuntime['runtime'], deadline: Date): Promise<void> {
  await waitForCondition(
    async () => (await dbNow(runtime)).getTime() > deadline.getTime(),
    {
      timeoutMs: 30_000,
      pollIntervalMs: 25,
      description: 'the PostgreSQL clock to cross the upload-intent deadline',
    },
  );
}

async function seedAllocated(
  runtime: I07MigrationRuntime['runtime'],
  id: I09Identity,
  body: Uint8Array,
  overrides: Record<string, unknown> = {},
): Promise<void> {
  await createUnitOfWork(runtime.db).execute(({ transaction }) =>
    ports.allocate(transaction, allocateInput(id, {
      expectedSize: body.byteLength,
      expectedSha256: sha256HexBytes(body),
      mediaHint: 'image/png',
      ...overrides,
    })));
}

function completeDeps(
  runtime: I07MigrationRuntime['runtime'],
  store: InMemoryVerificationObjectStore,
): CompleteUploadDeps<DatabaseTransaction> {
  return {
    ledger: ports,
    blobStore: store,
    uow: createUnitOfWork(runtime.db),
    enqueueVerification: async (tx, payload) => {
      await appendAttachmentsVerificationOutbox(tx, payload);
    },
    config: CONFIG,
  };
}

function completeInput(id: I09Identity, body: Uint8Array) {
  return {
    actor: makeActor(),
    binding: { intentId: id.intentId, generationId: id.generationId, blobId: id.blobId },
    declared: {
      size: body.byteLength,
      sha256: sha256HexBytes(body),
      mediaType: 'image/png',
      etag: `"etag-${id.generationId}"`,
    },
  };
}

async function outboxCount(runtime: I07MigrationRuntime['runtime'], blobId: string): Promise<number> {
  const rows = await sql<{ count: string }>`
    select count(*)::text as count from outbox_events
    where handler_name = ${HANDLER} and aggregate_id = ${blobId}
  `.execute(runtime.db);
  return Number(rows.rows[0]!.count);
}

function controlDeps(
  executionLedger: I16NegativeControlExecutor,
  runtime: I07MigrationRuntime['runtime'],
  store: InMemoryVerificationObjectStore,
  nonce: string,
): R03ControlDeps {
  return {
    executionLedger,
    runtime,
    ledger: ports,
    objectStore: store,
    config: CONFIG,
    actor: makeActor(),
    collectionId: I09_COLLECTION,
    nonce,
    provisionObject: async (id, body) => {
      const etag = `"etag-${id.generationId}"`;
      store.seed(id.key, body, { etag, contentType: 'image/png' });
      return etag;
    },
  };
}

describeWithPostgres('P4A-R03 late upload', () => {
  let isolated: I07MigrationRuntime;

  beforeAll(async () => {
    isolated = await createI07MigrationRuntime('r03_late_upload', { maxConnections: 12 });
  });

  afterAll(async () => {
    await isolated?.dropSchema();
  });

  test('complete BEFORE the DB-clock deadline succeeds (uploaded + one outbox row)', async () => {
    const id = identityFor(20);
    const body = pngBody(18);
    const deadline = new Date((await dbNow(isolated.runtime)).getTime() + 60_000);
    await seedAllocated(isolated.runtime, id, body, { expiresAt: deadline });
    const store = new InMemoryVerificationObjectStore();
    store.seed(id.key, body, { etag: `"etag-${id.generationId}"` });
    const result = await completeUpload(completeDeps(isolated.runtime, store), completeInput(id, body));
    assert.equal(result.outcome, 'completed');
    const blob = await sql<{ logical_state: string }>`
      select logical_state from blob_records where blob_id = ${id.blobId}
    `.execute(isolated.runtime.db);
    assert.equal(blob.rows[0]!.logical_state, 'uploaded');
    assert.equal(await outboxCount(isolated.runtime, id.blobId), 1);
    const gen = await sql<{ generation_state: string }>`
      select generation_state from blob_generations where generation_id = ${id.generationId}
    `.execute(isolated.runtime.db);
    assert.equal(gen.rows[0]!.generation_state, 'active');
  });

  test('complete exactly AT the DB-clock deadline is late-rejected (inclusive boundary)', async () => {
    const id = identityFor(21);
    const body = pngBody(18);
    const deadline = await dbNow(isolated.runtime);
    await seedAllocated(isolated.runtime, id, body, { expiresAt: deadline });
    const store = new InMemoryVerificationObjectStore();
    store.seed(id.key, body, { etag: `"etag-${id.generationId}"` });
    const result = await completeUpload(completeDeps(isolated.runtime, store), completeInput(id, body));
    assert.equal(result.outcome, 'late_rejected');
    assert.equal((result as { reason: string }).reason, 'expired');
    const gen = await sql<{ generation_state: string; retire_reason: string | null }>`
      select generation_state, retire_reason from blob_generations where generation_id = ${id.generationId}
    `.execute(isolated.runtime.db);
    assert.equal(gen.rows[0]!.generation_state, 'orphaned');
    assert.equal(gen.rows[0]!.retire_reason, 'expired');
    assert.equal(await outboxCount(isolated.runtime, id.blobId), 0);
  });

  test('complete AFTER the deadline (the same database clock crosses it) is late-rejected; the expired key is NEVER revived', async () => {
    const id = identityFor(22);
    const body = pngBody(18);
    const deadline = new Date((await dbNow(isolated.runtime)).getTime() + 2_000);
    await seedAllocated(isolated.runtime, id, body, { expiresAt: deadline });
    const store = new InMemoryVerificationObjectStore();
    store.seed(id.key, body, { etag: `"etag-${id.generationId}"` });

    // The intent deadline is crossed by the SAME PostgreSQL clock.
    await waitForDbClockPast(isolated.runtime, deadline);
    const result = await completeUpload(completeDeps(isolated.runtime, store), completeInput(id, body));
    assert.equal(result.outcome, 'late_rejected');
    assert.equal((result as { reason: string }).reason, 'expired');

    // Frozen late-upload policy at the DB level: generation orphaned, blob
    // expired, zero outbox rows, and the exact key stays bound to the
    // orphaned generation — the late complete never restores it.
    const gen = await sql<{ generation_state: string; retire_reason: string | null }>`
      select generation_state, retire_reason from blob_generations where generation_id = ${id.generationId}
    `.execute(isolated.runtime.db);
    assert.equal(gen.rows[0]!.generation_state, 'orphaned');
    assert.equal(gen.rows[0]!.retire_reason, 'expired');
    const blob = await sql<{ logical_state: string }>`
      select logical_state from blob_records where blob_id = ${id.blobId}
    `.execute(isolated.runtime.db);
    assert.equal(blob.rows[0]!.logical_state, 'expired');
    assert.equal(await outboxCount(isolated.runtime, id.blobId), 0);
    const keys = await sql<{ key: string }>`
      select bg.key from generation_keys bg where bg.generation_id = ${id.generationId}
    `.execute(isolated.runtime.db);
    assert.equal(keys.rows.length, 1);
    assert.equal(keys.rows[0]!.key, id.key, 'the expired key must remain bound to the orphaned generation');

    // A duplicate late complete stays late-rejected with no side effects.
    const duplicate = await completeUpload(completeDeps(isolated.runtime, store), completeInput(id, body));
    assert.equal(duplicate.outcome, 'late_rejected');
    assert.equal(await outboxCount(isolated.runtime, id.blobId), 0);

    // A FRESH binding gets a fresh key — the expired key is never re-signed.
    const fresh = identityFor(23);
    await seedAllocated(isolated.runtime, fresh, body);
    const freshStore = new InMemoryVerificationObjectStore();
    freshStore.seed(fresh.key, body, { etag: `"etag-${fresh.generationId}"` });
    const freshResult = await completeUpload(completeDeps(isolated.runtime, freshStore), completeInput(fresh, body));
    assert.equal(freshResult.outcome, 'completed');
    assert.notEqual(fresh.key, id.key);
  });

  test('duplicate complete: success then idempotent with ONE outbox row; late then late again', async () => {
    const id = identityFor(24);
    const body = pngBody(18);
    await seedAllocated(isolated.runtime, id, body);
    const store = new InMemoryVerificationObjectStore();
    store.seed(id.key, body, { etag: `"etag-${id.generationId}"` });
    const deps = completeDeps(isolated.runtime, store);
    assert.equal((await completeUpload(deps, completeInput(id, body))).outcome, 'completed');
    assert.equal((await completeUpload(deps, completeInput(id, body))).outcome, 'idempotent');
    assert.equal(await outboxCount(isolated.runtime, id.blobId), 1);

    const lateId = identityFor(25);
    await seedAllocated(isolated.runtime, lateId, body, { expiresAt: new Date(Date.now() - 3_600_000) });
    const lateStore = new InMemoryVerificationObjectStore();
    lateStore.seed(lateId.key, body, { etag: `"etag-${lateId.generationId}"` });
    const lateDeps = completeDeps(isolated.runtime, lateStore);
    assert.equal((await completeUpload(lateDeps, completeInput(lateId, body))).outcome, 'late_rejected');
    assert.equal((await completeUpload(lateDeps, completeInput(lateId, body))).outcome, 'late_rejected');
    assert.equal(await outboxCount(isolated.runtime, lateId.blobId), 0);
  });

  // The control allocates the deadline R03_LATE_UPLOAD_HEADROOM_MS (8s) ahead
  // on the DATABASE clock and polls the same clock across it, so it needs a
  // generous test timeout (the poll itself still fails after 30s if the clock
  // never crosses). The control runs on its OWN fresh schema: the earlier
  // tests in this file leave pending verification events for their
  // direct-complete fixtures (blobs that only exist in per-test stores), so a
  // shared schema would exercise the claim loop against foreign events whose
  // objects are absent — the isolated schema keeps the root-cause assertions
  // (before-deadline blob converged + ZERO residual events) unambiguous.
  test('the in-run control completes the executor contract at the real DB boundary', async () => {
    const controlIsolated = await createI07MigrationRuntime('r03_late_upload_control', { maxConnections: 8 });
    try {
      const executionLedger = new I16NegativeControlExecutor();
      const store = new InMemoryVerificationObjectStore();
      const facts: R03LateUploadControlFacts = await executeR03LateUploadControl(
        controlDeps(executionLedger, controlIsolated.runtime, store, 'r03-late-upload-nonce'),
      );
      assert.equal(facts.stableCode, 'late_rejected');
      assert.equal(facts.beforeDeadlineOutcome, 'completed');
      assert.equal(facts.lateOutcome, 'late_rejected');
      assert.equal(facts.lateReason, 'expired');
      assert.equal(facts.expiredKeyNotRevived, true);
      assert.equal(facts.duplicateLateOutcome, 'late_rejected');
      const receipt = executionLedger.receiptFor('late_upload');
      assert.equal(receipt.stableCode, 'late_rejected');
      assert.equal(receipt.verificationSource, 'postgres-integration-suite');
      assert.equal(receipt.cleanupReceipt, 'no_outbox_row_orphaned_generation_key_preserved');

      // Root-cause semantics: the before-deadline complete is followed by the
      // PRODUCTION worker route, so the before blob converges to
      // `stored_private` (exactly the seedStoredPrivateBlob semantics) while
      // the late blob stays `expired` — and the handler leaves ZERO
      // pending/retryable/leased events in this schema (the before blob's
      // event was claimed, handled and completed, so no later control's claim
      // can be polluted by it).
      const blobStates = await sql<{ logical_state: string }>`
        select logical_state from blob_records
      `.execute(controlIsolated.runtime.db);
      assert.deepEqual(
        blobStates.rows.map((row) => row.logical_state).sort(),
        ['expired', 'stored_private'],
        'the before-deadline blob must converge to stored_private and the late blob to expired',
      );
      const verified = await sql<{ count: string }>`
        select count(*)::text as count from blob_records
        where logical_state = 'stored_private' and verified_sha256 is not null
      `.execute(controlIsolated.runtime.db);
      assert.equal(Number(verified.rows[0]!.count), 1, 'the stored_private blob carries verified facts');
      const residual = await sql<{ count: string }>`
        select count(*)::text as count from outbox_events
        where handler_name = ${HANDLER} and state in ('pending', 'retryable', 'leased')
      `.execute(controlIsolated.runtime.db);
      assert.equal(
        Number(residual.rows[0]!.count),
        0,
        'the control must leave ZERO pending/retryable/leased verification events in its schema',
      );
      const delivered = await sql<{ count: string }>`
        select count(*)::text as count from outbox_events
        where handler_name = ${HANDLER} and state = 'completed'
      `.execute(controlIsolated.runtime.db);
      assert.equal(
        Number(delivered.rows[0]!.count),
        1,
        'the before-deadline verification event is delivered exactly once (completed)',
      );
    } finally {
      await controlIsolated.dropSchema();
    }
  }, 120_000);
});
