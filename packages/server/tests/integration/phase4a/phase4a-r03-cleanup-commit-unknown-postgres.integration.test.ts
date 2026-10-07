/**
 * P4A-R03 PostgreSQL integration suite (part 2b): the `db_commit_unknown`
 * negative control — cleanup direction + the in-run control — against the
 * PRODUCTION migration (plan §6 P4A-R03, §4.3 mutation control "commit error
 * 后直接重做外部副作用").
 *
 * Proves `resolveCleanupCommitUnknown` at the real database boundary:
 *
 *  - committed direction: a REAL completeCleanup commit lands and the client
 *    response is lost; the recovery RE-READS the generation row + the
 *    attempt-token fence and decides `committed_deleted`; the row is
 *    `deleted` and the exact-key tombstone survives (cleanup never fabricates
 *    a rollback of the key binding);
 *  - rolled-back direction: a before-commit fault rolls back; the recovery
 *    re-reads under the SAME fence and decides `not_committed`; the SAME
 *    claim retries and completes exactly once.
 *
 * Anti-false-positive: catching the commit exception and asserting "no
 * throw" is NOT enough — each direction asserts the re-read decision AND the
 * final unique database fact. The suite also drives the FULL in-run control
 * (`executeR03DbCommitUnknownControl`, finalize + cleanup, both directions)
 * through the fixed R01 executor contract on the real database.
 */
import assert from 'node:assert/strict';
import { sql } from 'kysely';
import { afterAll, beforeAll, test } from 'vitest';
import { DatabaseOperationError, createPostgresAttachmentsPorts, createUnitOfWork } from '../../../src/infrastructure/database/index.js';
import {
  appendAttachmentsVerificationOutbox,
} from '../../../src/infrastructure/outbox/index.js';
import {
  completeUpload,
  resolveCleanupCommitUnknown,
  type CleanupClaim,
  type CompleteUploadDeps,
} from '../../../src/modules/attachments/index.js';
import type { DatabaseTransaction } from '../../../src/infrastructure/database/index.js';
import { describeWithPostgres } from '../../support/postgres-test-runtime.js';
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
  executeR03DbCommitUnknownControl,
  type R03CommitUnknownControlFacts,
  type R03ControlDeps,
} from '../../../scripts/evidence/phase4a-r03-controls.js';

const CONFIG = makeI09Config();
const ports = createPostgresAttachmentsPorts();

function pngBody(bytes: number): Uint8Array {
  const body = new Uint8Array(bytes);
  body.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  for (let index = 8; index < body.length; index += 1) body[index] = index % 251;
  return body;
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

/**
 * Seeds an ORPHANED generation through the production frozen late-upload
 * policy (allocate with a past DB deadline + complete -> late_rejected,
 * generation orphaned with retire_reason 'expired').
 */
async function seedOrphaned(
  runtime: I07MigrationRuntime['runtime'],
  id: I09Identity,
  body: Uint8Array,
): Promise<void> {
  await seedAllocated(runtime, id, body, { expiresAt: new Date(Date.now() - 3_600_000) });
  const store = new InMemoryVerificationObjectStore();
  store.seed(id.key, body, { etag: `"etag-${id.generationId}"` });
  const deps: CompleteUploadDeps<DatabaseTransaction> = {
    ledger: ports,
    blobStore: store,
    uow: createUnitOfWork(runtime.db),
    enqueueVerification: async (tx, payload) => {
      await appendAttachmentsVerificationOutbox(tx, payload);
    },
    config: CONFIG,
  };
  const late = await completeUpload(deps, {
    actor: makeActor(),
    binding: { intentId: id.intentId, generationId: id.generationId, blobId: id.blobId },
    declared: {
      size: body.byteLength,
      sha256: sha256HexBytes(body),
      mediaType: 'image/png',
      etag: `"etag-${id.generationId}"`,
    },
  });
  assert.equal(late.outcome, 'late_rejected');
}

async function claimOrphaned(
  runtime: I07MigrationRuntime['runtime'],
  id: I09Identity,
  leaseOwner: string,
): Promise<CleanupClaim> {
  const claimed = await createUnitOfWork(runtime.db).execute(({ transaction }) =>
    ports.claimCleanup(transaction, {
      leaseOwner,
      leaseTtlSeconds: 60,
      generationId: id.generationId,
      retiredRetentionDays: 0,
    }));
  assert.equal(claimed.outcome, 'claimed');
  if (claimed.outcome !== 'claimed') throw new Error('cleanup claim missing');
  return claimed.claim;
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

describeWithPostgres('P4A-R03 db commit unknown (cleanup + in-run control)', () => {
  let isolated: I07MigrationRuntime;

  beforeAll(async () => {
    isolated = await createI07MigrationRuntime('r03_commit_unknown_cleanup', { maxConnections: 16 });
  });

  afterAll(async () => {
    await isolated?.dropSchema();
  });

  test('cleanup committed direction: resolveCleanupCommitUnknown re-reads the generation + attempt token and decides committed_deleted; the tombstone survives', async () => {
    const id = identityFor(13);
    const body = pngBody(16);
    await seedOrphaned(isolated.runtime, id, body);
    const claim = await claimOrphaned(isolated.runtime, id, 'r03-cleanup-owner');

    let ackLost = false;
    const uow = createUnitOfWork(isolated.runtime.db, {
      faultInjector: {
        afterCommitAcknowledged: async () => {
          if (ackLost) return;
          const rows = await isolated.runtime.pool.query<{ generation_state: string }>(
            'select generation_state from blob_generations where generation_id = $1',
            [id.generationId],
          );
          if (rows.rows[0]?.generation_state === 'deleted') {
            ackLost = true;
            throw new Error('simulated lost cleanup commit acknowledgement');
          }
        },
      },
    });
    await assert.rejects(
      uow.execute(({ transaction }) => ports.completeCleanup(transaction, { claim, verdict: 'confirmed_absent' })),
      (error: unknown) => error instanceof DatabaseOperationError && error.kind === 'commit_outcome_unknown',
    );
    assert.equal(ackLost, true, 'the cleanup commit must have landed before the response was lost');

    // Unknown recovery: re-read the generation + attempt-token fence, decide.
    const reRead = await createUnitOfWork(isolated.runtime.db).execute(({ transaction }) =>
      ports.readCleanupState(transaction, { generationId: id.generationId }));
    const decision = resolveCleanupCommitUnknown({
      attemptedClaim: {
        attemptToken: claim.attemptToken,
        leaseOwner: claim.leaseOwner,
        leaseGeneration: claim.leaseGeneration,
      },
      reRead,
    });
    assert.equal(decision.decision, 'committed_deleted');
    const gen = await sql<{ generation_state: string }>`
      select generation_state from blob_generations where generation_id = ${id.generationId}
    `.execute(isolated.runtime.db);
    assert.equal(gen.rows[0]!.generation_state, 'deleted');
    // The tombstone (exact key row) is preserved — cleanup never fabricates a
    // rollback of the key binding.
    const keys = await sql<{ count: string }>`
      select count(*)::text as count from generation_keys where generation_id = ${id.generationId}
    `.execute(isolated.runtime.db);
    assert.equal(Number(keys.rows[0]!.count), 1);
  });

  test('cleanup rolled-back direction: resolveCleanupCommitUnknown decides not_committed under the SAME fence; a retry completes', async () => {
    const id = identityFor(14);
    const body = pngBody(17);
    await seedOrphaned(isolated.runtime, id, body);
    const claim = await claimOrphaned(isolated.runtime, id, 'r03-cleanup-owner-2');

    let beforeCommitFault = true;
    const uow = createUnitOfWork(isolated.runtime.db, {
      faultInjector: {
        afterCallbackBeforeCommit: async () => {
          if (beforeCommitFault) {
            beforeCommitFault = false;
            throw new Error('simulated before-commit cleanup fault');
          }
        },
      },
    });
    await assert.rejects(
      uow.execute(({ transaction }) => ports.completeCleanup(transaction, { claim, verdict: 'confirmed_absent' })),
      /simulated before-commit cleanup fault/,
    );

    const reRead = await createUnitOfWork(isolated.runtime.db).execute(({ transaction }) =>
      ports.readCleanupState(transaction, { generationId: id.generationId }));
    const decision = resolveCleanupCommitUnknown({
      attemptedClaim: {
        attemptToken: claim.attemptToken,
        leaseOwner: claim.leaseOwner,
        leaseGeneration: claim.leaseGeneration,
      },
      reRead,
    });
    assert.equal(decision.decision, 'not_committed');

    // The SAME claim fence retries and completes exactly once.
    const retry = await createUnitOfWork(isolated.runtime.db).execute(({ transaction }) =>
      ports.completeCleanup(transaction, { claim, verdict: 'confirmed_absent' }));
    assert.equal(retry.outcome, 'completed');
    const gen = await sql<{ generation_state: string }>`
      select generation_state from blob_generations where generation_id = ${id.generationId}
    `.execute(isolated.runtime.db);
    assert.equal(gen.rows[0]!.generation_state, 'deleted');
  });

  test('the in-run control completes the executor contract at the real DB boundary', async () => {
    const executionLedger = new I16NegativeControlExecutor();
    const store = new InMemoryVerificationObjectStore();
    const facts: R03CommitUnknownControlFacts = await executeR03DbCommitUnknownControl(
      controlDeps(executionLedger, isolated.runtime, store, 'r03-commit-unknown-nonce'),
    );
    assert.equal(facts.stableCode, 'converges');
    assert.equal(facts.convergedToSingleDatabaseFact, true);
    assert.equal(facts.finalizeCommitted, true);
    assert.equal(facts.finalizeRolledBack, true);
    assert.equal(facts.cleanupCommitted, true);
    assert.equal(facts.cleanupRolledBack, true);
    const receipt = executionLedger.receiptFor('db_commit_unknown');
    assert.equal(receipt.stableCode, 'converges');
    assert.equal(receipt.verificationSource, 'postgres-integration-suite');
    assert.equal(receipt.cleanupReceipt, 'single_database_fact_per_write');
  });
});
