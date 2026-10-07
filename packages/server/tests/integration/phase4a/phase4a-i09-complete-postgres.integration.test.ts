/**
 * P4A-I09 PostgreSQL integration suite (part 1): the authenticated explicit
 * complete coordinator against the PRODUCTION migration.
 *
 * Proves the verification-lease schema, the complete + verification-Outbox
 * SAME-commit atomicity (a before-commit fault rolls back both; a
 * commit-response-lost fault leaves both durable and a retry converges with a
 * single outbox row), idempotent duplicate/concurrent complete, the frozen
 * late-upload/expired policy, and principal fencing.
 */
import assert from 'node:assert/strict';
import { sql } from 'kysely';
import { afterAll, beforeAll, test } from 'vitest';
import { createPostgresAttachmentsPorts, createUnitOfWork } from '../../../src/infrastructure/database/index.js';
import {
  appendAttachmentsVerificationOutbox,
} from '../../../src/infrastructure/outbox/index.js';
import {
  completeUpload,
  type CompleteUploadDeps,
} from '../../../src/modules/attachments/index.js';
import type { DatabaseTransaction } from '../../../src/infrastructure/database/index.js';
import { describeWithPostgres } from '../../support/postgres-test-runtime.js';
import {
  BarrierGroup,
  createI07MigrationRuntime,
  type I07MigrationRuntime,
} from '../../support/phase4a-i07-test-helpers.js';
import {
  InMemoryVerificationObjectStore,
  allocateInput,
  identityFor,
  makeActor,
  makeI09Config,
  sha256HexBytes,
} from '../../support/phase4a-i09-test-helpers.js';

const CONFIG = makeI09Config();
const ports = createPostgresAttachmentsPorts();

function pngBody(bytes = 16): Uint8Array {
  const body = new Uint8Array(bytes);
  body.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  for (let index = 8; index < body.length; index += 1) body[index] = index % 251;
  return body;
}

function declaredFor(id: ReturnType<typeof identityFor>, body: Uint8Array) {
  return {
    size: body.byteLength,
    sha256: sha256HexBytes(body),
    mediaType: 'image/png',
    etag: `"etag-${id.generationId}"`,
  };
}

function completeInput(id: ReturnType<typeof identityFor>, body: Uint8Array) {
  return {
    actor: makeActor(),
    binding: { intentId: id.intentId, generationId: id.generationId, blobId: id.blobId },
    declared: declaredFor(id, body),
  };
}

function completeDeps(
  runtime: I07MigrationRuntime['runtime'],
  store: InMemoryVerificationObjectStore,
  options: { enqueue?: (tx: DatabaseTransaction, payload: { blobId: string; generationId: string; intentId: string }) => Promise<void>; barrier?: BarrierGroup } = {},
): CompleteUploadDeps<DatabaseTransaction> {
  return {
    ledger: ports,
    blobStore: store,
    uow: createUnitOfWork(runtime.db),
    enqueueVerification: options.enqueue ?? ((tx, payload) => appendAttachmentsVerificationOutbox(tx, payload)),
    config: CONFIG,
    barrier: options.barrier,
  };
}

async function seedAllocated(
  runtime: I07MigrationRuntime['runtime'],
  id: ReturnType<typeof identityFor>,
  body: Uint8Array = pngBody(),
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

async function outboxCount(runtime: I07MigrationRuntime['runtime'], handlerName: string, blobId: string): Promise<number> {
  const rows = await sql<{ count: string }>`
    select count(*)::text as count from outbox_events
    where handler_name = ${handlerName} and aggregate_id = ${blobId}
  `.execute(runtime.db);
  return Number(rows.rows[0]!.count);
}

describeWithPostgres('P4A-I09 complete + verification outbox (same commit)', () => {
  let isolated: I07MigrationRuntime;

  beforeAll(async () => {
    isolated = await createI07MigrationRuntime('i09_complete', { maxConnections: 12 });
  });

  afterAll(async () => {
    await isolated?.dropSchema();
  });

  test('the production migration carries the verification lease columns', async () => {
    const rows = await sql<{ column_name: string }>`
      select column_name from information_schema.columns
      where table_schema = current_schema() and table_name = 'blob_records'
        and column_name in ('verification_lease_owner','verification_lease_generation','verification_lease_expires_at','verification_policy_version')
    `.execute(isolated.runtime.db);
    const names = rows.rows.map((row) => row.column_name).sort();
    assert.deepEqual(names, ['verification_lease_expires_at', 'verification_lease_generation', 'verification_lease_owner', 'verification_policy_version']);
  });

  test('complete binds uploaded and enqueues the verification outbox in the SAME commit', async () => {
    const id = identityFor(1);
    const body = pngBody();
    await seedAllocated(isolated.runtime, id, body);
    const store = new InMemoryVerificationObjectStore();
    store.seed(id.key, body, { etag: `"etag-${id.generationId}"` });
    const result = await completeUpload(completeDeps(isolated.runtime, store), completeInput(id, body));
    assert.equal(result.outcome, 'completed');
    const blob = await sql<{ logical_state: string; current_generation_id: string | null }>`
      select logical_state, current_generation_id from blob_records where blob_id = ${id.blobId}
    `.execute(isolated.runtime.db);
    assert.equal(blob.rows[0]!.logical_state, 'uploaded');
    assert.equal(blob.rows[0]!.current_generation_id, id.generationId);
    assert.equal(await outboxCount(isolated.runtime, 'attachments_verify_generation', id.blobId), 1);
    const gen = await sql<{ observed_etag: string | null; observed_size: string | null }>`
      select observed_etag, observed_size::text from blob_generations where generation_id = ${id.generationId}
    `.execute(isolated.runtime.db);
    assert.equal(gen.rows[0]!.observed_etag, `"etag-${id.generationId}"`);
    assert.equal(Number(gen.rows[0]!.observed_size), body.byteLength);
  });

  test('a before-commit outbox failure rolls back BOTH the CAS and the outbox row', async () => {
    const id = identityFor(2);
    const body = pngBody();
    await seedAllocated(isolated.runtime, id, body);
    const store = new InMemoryVerificationObjectStore();
    store.seed(id.key, body, { etag: `"etag-${id.generationId}"` });
    let failEnqueue = true;
    const deps = completeDeps(isolated.runtime, store, {
      enqueue: async (tx, payload) => {
        if (failEnqueue) {
          failEnqueue = false;
          throw new Error('simulated outbox insert failure');
        }
        await appendAttachmentsVerificationOutbox(tx, payload);
      },
    });
    await assert.rejects(completeUpload(deps, completeInput(id, body)), /simulated outbox insert failure/);
    const blob = await sql<{ logical_state: string }>`select logical_state from blob_records where blob_id = ${id.blobId}`.execute(isolated.runtime.db);
    assert.equal(blob.rows[0]!.logical_state, 'issued', 'the CAS must roll back with the outbox row');
    assert.equal(await outboxCount(isolated.runtime, 'attachments_verify_generation', id.blobId), 0);
    // The retry succeeds atomically.
    const retry = await completeUpload(deps, completeInput(id, body));
    assert.equal(retry.outcome, 'completed');
    assert.equal(await outboxCount(isolated.runtime, 'attachments_verify_generation', id.blobId), 1);
  });

  test('commit-response-lost leaves both durable; a retry converges with a single outbox row', async () => {
    const id = identityFor(3);
    const body = pngBody();
    await seedAllocated(isolated.runtime, id, body);
    const store = new InMemoryVerificationObjectStore();
    store.seed(id.key, body, { etag: `"etag-${id.generationId}"` });
    let lost = true;
    const uow = createUnitOfWork(isolated.runtime.db, {
      faultInjector: {
        // Fire only after the transaction that made the CAS durable (the blob
        // reached `uploaded`), not after the read-only `findCompleteTarget`
        // transaction that runs first.
        afterCommitAcknowledged: async () => {
          if (!lost) return;
          const rows = await isolated.runtime.pool.query<{ logical_state: string }>(
            'select logical_state from blob_records where blob_id = $1',
            [id.blobId],
          );
          if (rows.rows[0]?.logical_state === 'uploaded') {
            lost = false;
            throw new Error('simulated lost commit acknowledgement');
          }
        },
      },
    });
    const deps: CompleteUploadDeps<DatabaseTransaction> = {
      ledger: ports,
      blobStore: store,
      uow,
      enqueueVerification: (tx, payload) => appendAttachmentsVerificationOutbox(tx, payload),
      config: CONFIG,
    };
    await assert.rejects(
      completeUpload(deps, completeInput(id, body)),
      /commit outcome is unknown|simulated lost commit/,
    );
    const blob = await sql<{ logical_state: string }>`select logical_state from blob_records where blob_id = ${id.blobId}`.execute(isolated.runtime.db);
    assert.equal(blob.rows[0]!.logical_state, 'uploaded', 'the commit actually landed');
    assert.equal(await outboxCount(isolated.runtime, 'attachments_verify_generation', id.blobId), 1);
    const retry = await completeUpload(deps, completeInput(id, body));
    assert.equal(retry.outcome, 'idempotent');
    assert.equal(await outboxCount(isolated.runtime, 'attachments_verify_generation', id.blobId), 1, 'recovery must not duplicate the outbox row');
  });

  test('duplicate complete is idempotent with a single outbox row', async () => {
    const id = identityFor(4);
    const body = pngBody();
    await seedAllocated(isolated.runtime, id, body);
    const store = new InMemoryVerificationObjectStore();
    store.seed(id.key, body, { etag: `"etag-${id.generationId}"` });
    const deps = completeDeps(isolated.runtime, store);
    assert.equal((await completeUpload(deps, completeInput(id, body))).outcome, 'completed');
    assert.equal((await completeUpload(deps, completeInput(id, body))).outcome, 'idempotent');
    assert.equal(await outboxCount(isolated.runtime, 'attachments_verify_generation', id.blobId), 1);
  });

  test('concurrent complete over two connections yields one winner and one outbox row', async () => {
    const id = identityFor(5);
    const body = pngBody();
    await seedAllocated(isolated.runtime, id, body);
    const barrier = new BarrierGroup();
    const storeA = new InMemoryVerificationObjectStore();
    storeA.seed(id.key, body, { etag: `"etag-${id.generationId}"` });
    const storeB = new InMemoryVerificationObjectStore();
    storeB.seed(id.key, body, { etag: `"etag-${id.generationId}"` });
    const depsA = completeDeps(isolated.runtime, storeA, { barrier });
    const depsB = completeDeps(isolated.runtime, storeB, { barrier });
    const pending = Promise.all([
      completeUpload(depsA, completeInput(id, body)),
      completeUpload(depsB, completeInput(id, body)),
    ]);
    // Deterministic barriers: both completions reach the target resolve, then
    // both reach the CAS; the row lock serializes the winner.
    await barrier.waitAllArrived(['complete_target_before'], 2);
    barrier.releaseAll(['complete_target_before']);
    await barrier.waitAllArrived(['complete_cas_before'], 2);
    barrier.releaseAll(['complete_cas_before']);
    const [a, b] = await pending;
    const outcomes = [a.outcome, b.outcome].sort();
    assert.deepEqual(outcomes, ['completed', 'idempotent']);
    assert.equal(await outboxCount(isolated.runtime, 'attachments_verify_generation', id.blobId), 1);
  });

  test('an expired intent is late-rejected and orphans the generation (frozen late-upload policy)', async () => {
    const id = identityFor(6);
    const body = pngBody();
    await seedAllocated(isolated.runtime, id, body, { expiresAt: new Date(Date.now() - 3_600_000) });
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
    assert.equal(await outboxCount(isolated.runtime, 'attachments_verify_generation', id.blobId), 0);
  });

  test('a different principal cannot complete the intent', async () => {
    const id = identityFor(7);
    const body = pngBody();
    await seedAllocated(isolated.runtime, id, body);
    const store = new InMemoryVerificationObjectStore();
    store.seed(id.key, body, { etag: `"etag-${id.generationId}"` });
    const result = await completeUpload(completeDeps(isolated.runtime, store), {
      ...completeInput(id, body),
      actor: makeActor('i09-subject-owner', 'i09-outsider-principal'),
    });
    assert.equal(result.outcome, 'principal_mismatch');
    assert.equal(await outboxCount(isolated.runtime, 'attachments_verify_generation', id.blobId), 0);
  });

  test('a missing object is rejected with no ledger side effect', async () => {
    const id = identityFor(8);
    const body = pngBody();
    await seedAllocated(isolated.runtime, id, body);
    const store = new InMemoryVerificationObjectStore();
    store.options.forceHeadNotFound = true;
    const result = await completeUpload(completeDeps(isolated.runtime, store), completeInput(id, body));
    assert.equal(result.outcome, 'missing');
    const blob = await sql<{ logical_state: string }>`select logical_state from blob_records where blob_id = ${id.blobId}`.execute(isolated.runtime.db);
    assert.equal(blob.rows[0]!.logical_state, 'issued');
    assert.equal(await outboxCount(isolated.runtime, 'attachments_verify_generation', id.blobId), 0);
  });
});
