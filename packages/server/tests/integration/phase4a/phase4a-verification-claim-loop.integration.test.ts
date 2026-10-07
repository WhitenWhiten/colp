/**
 * P4A verification claim-loop suite (I16 sealed-run hardening).
 *
 * Exercises `claimAndVerifyTargetEvent` — the bounded claim-until-target
 * verification outbox loop shared by the R03 late-upload consumption, the
 * R04 `verifyToStoredPrivate` seed and the I16 `verifyGenerationThroughWorker`
 * step. The production outbox repository claim takes the OLDEST pending
 * event with NO target filter, so a residual event left by an earlier
 * control would be claimed and verified as if it were the seed's own event
 * (the sealed-run `r04_races_seed_failed:stored_private` root cause).
 *
 * Real-DB scenarios (synthetic stale-event setup, plan §4):
 *  - an OLDER foreign event is claimed FIRST; the loop settles it through
 *    the PRODUCTION route + completes it (harmless convergence), re-claims
 *    and still verifies the TARGET blob; the outbox ends clean;
 *  - a foreign event the production route cannot settle (missing target ->
 *    retryable) fails closed with the stable `r04_races_seed_failed` prefix.
 *
 * Fake-repository scenarios (the loop's pure contract):
 *  - settle order (foreign first, then target), bounded-loop exhaustion
 *    (`claim_loop_exhausted`), missing claim (`target_event_missing`),
 *    foreign/target settle failures keeping the stable prefix, and the
 *    aggregate-binding target matcher.
 */
import assert from 'node:assert/strict';
import { sql } from 'kysely';
import { afterAll, beforeAll, test } from 'vitest';
import { createPostgresAttachmentsPorts, createUnitOfWork } from '../../../src/infrastructure/database/index.js';
import {
  PostgresOutboxRepository,
  appendAttachmentsVerificationOutbox,
  createAttachmentsVerificationOutboxRoute,
  type ClosedPayload,
  type OutboxClaim,
  type VersionedEventEnvelope,
} from '../../../src/infrastructure/outbox/index.js';
import { describeWithPostgres } from '../../support/postgres-test-runtime.js';
import {
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
  type I09Identity,
} from '../../support/phase4a-i09-test-helpers.js';
import {
  VERIFICATION_CLAIM_LOOP_MAX_ITERATIONS,
  claimAndVerifyTargetEvent,
  claimMatchesTarget,
  withStableFailureCode,
} from '../../../scripts/evidence/phase4a-verification-claim-loop.js';
import { stableI16FailureCode } from '../../../scripts/evidence/phase4a-i16-acceptance.js';

const CONFIG = makeI09Config();
const ports = createPostgresAttachmentsPorts();
const HANDLER = 'attachments_verify_generation';

function pngBody(bytes: number): Uint8Array {
  const body = new Uint8Array(bytes);
  body.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  for (let index = 8; index < body.length; index += 1) body[index] = index % 251;
  return body;
}

function verificationEnvelope(claim: OutboxClaim): VersionedEventEnvelope {
  return {
    event_id: claim.eventId,
    event_type: claim.eventType,
    event_version: claim.eventVersion,
    aggregate_identity: {
      aggregate_type: claim.aggregateType,
      aggregate_id: claim.aggregateId,
      aggregate_scope: claim.aggregateScope,
    },
    aggregate_revision: claim.aggregateRevision,
    commit_ordinal: claim.commitOrdinal,
    occurred_at: claim.occurredAt.toISOString(),
    payload: claim.payload as ClosedPayload,
  };
}

/** Seeds an `uploaded` blob through production ports WITHOUT any outbox
 * event (allocate + provision + ledger.complete). */
async function seedUploadedBlob(
  runtime: I07MigrationRuntime['runtime'],
  store: InMemoryVerificationObjectStore,
  id: I09Identity,
  body: Uint8Array,
): Promise<void> {
  await createUnitOfWork(runtime.db).execute(async ({ transaction }) => {
    const allocated = await ports.allocate(transaction, allocateInput(id, {
      expectedSize: body.byteLength,
      expectedSha256: sha256HexBytes(body),
      mediaHint: 'image/png',
    }));
    assert.equal(allocated.outcome, 'issued');
    const etag = `"etag-${id.generationId}"`;
    store.seed(id.key, body, { etag, contentType: 'image/png' });
    const completed = await ports.complete(transaction, {
      intentId: id.intentId,
      generationId: id.generationId,
      blobId: id.blobId,
      observedEtag: etag,
      observedSize: body.byteLength,
      observedContentType: 'image/png',
      observedMetadata: {},
    });
    assert.equal(completed.outcome, 'verified_active');
  });
}

async function nonTerminalOutboxCount(runtime: I07MigrationRuntime['runtime']): Promise<number> {
  const rows = await sql<{ count: string }>`
    select count(*)::text as count from outbox_events
    where handler_name = ${HANDLER} and state in ('pending', 'retryable', 'leased')
  `.execute(runtime.db);
  return Number(rows.rows[0]!.count);
}

/** The DATABASE clock: the repository claim only sees events whose
 * `available_at` has PASSED `current_timestamp` (the same clock), so target
 * events must be stamped with the DB clock — a JS-`new Date()` stamp can sit
 * a few milliseconds in the future when the container clock lags, making the
 * claim return null (`target_event_missing`) even though the event exists. */
async function dbNow(runtime: I07MigrationRuntime['runtime']): Promise<Date> {
  const rows = await sql<{ now: Date }>`select now() as now`.execute(runtime.db);
  return rows.rows[0]!.now;
}

/** Production settle used by the real-DB scenarios: route.handle + complete. */
function productionSettle(
  runtime: I07MigrationRuntime['runtime'],
  store: InMemoryVerificationObjectStore,
): { repository: PostgresOutboxRepository; settle: (claim: OutboxClaim) => Promise<void> } {
  const repository = new PostgresOutboxRepository(runtime.pool);
  const route = createAttachmentsVerificationOutboxRoute({
    repository: ports,
    blobStore: store,
    uow: createUnitOfWork(runtime.db),
    config: CONFIG,
  });
  return {
    repository,
    settle: async (claim: OutboxClaim): Promise<void> => {
      await route.handle({
        envelope: verificationEnvelope(claim),
        idempotencyKey: claim.eventId,
        signal: new AbortController().signal,
        attempt: { outboxId: claim.outboxId, leaseGeneration: claim.leaseGeneration },
      });
      const completedRow = await repository.complete(claim);
      assert.ok(completedRow, 'the claim must complete');
    },
  };
}

function fakeClaim(aggregateId: string, aggregateScope: string): OutboxClaim {
  return {
    outboxId: 'outbox-' + aggregateId,
    eventId: 'event-' + aggregateId,
    eventType: 'attachments.upload-verified',
    eventVersion: 1,
    handlerName: HANDLER,
    handlerMode: 'delivery_each_event',
    aggregateType: 'blob',
    aggregateId,
    aggregateScope,
    aggregateRevision: null,
    commitOrdinal: null,
    occurredAt: new Date(),
    payload: { blobId: aggregateId, generationId: aggregateScope, intentId: 'intent-' + aggregateId },
    attemptCount: 0,
    leaseGeneration: '0',
  };
}

describeWithPostgres('P4A verification claim loop (I16 sealed-run hardening)', () => {
  let isolated: I07MigrationRuntime;

  beforeAll(async () => {
    isolated = await createI07MigrationRuntime('r04_claim_loop', { maxConnections: 10 });
  }, 120_000);

  afterAll(async () => {
    await isolated?.dropSchema();
  });

  test('real outbox: an OLDER foreign event is claimed first; the loop settles it through the production route and still verifies the TARGET blob', async () => {
    const foreign = identityFor(30);
    const target = identityFor(31);
    const store = new InMemoryVerificationObjectStore();
    await seedUploadedBlob(isolated.runtime, store, foreign, pngBody(24));
    await seedUploadedBlob(isolated.runtime, store, target, pngBody(32));
    // Deterministic stale-event setup: the foreign event is a full minute
    // OLDER (explicit occurred_at -> available_at) than the target event, so
    // the naive oldest-pending claim (the pre-hardening behavior) would
    // verify the WRONG blob. The target event is stamped with the DATABASE
    // clock (not JS `new Date()`), so its `available_at` is guaranteed to be
    // in the past at claim time.
    await createUnitOfWork(isolated.runtime.db).execute(async ({ transaction }) => {
      await appendAttachmentsVerificationOutbox(transaction, {
        blobId: foreign.blobId,
        generationId: foreign.generationId,
        intentId: foreign.intentId,
      }, { occurredAt: new Date(Date.now() - 60_000) });
    });
    await createUnitOfWork(isolated.runtime.db).execute(async ({ transaction }) => {
      await appendAttachmentsVerificationOutbox(transaction, {
        blobId: target.blobId,
        generationId: target.generationId,
        intentId: target.intentId,
      }, { occurredAt: await dbNow(isolated.runtime) });
    });
    assert.equal(await nonTerminalOutboxCount(isolated.runtime), 2);

    const { repository, settle } = productionSettle(isolated.runtime, store);
    const targetClaim = await claimAndVerifyTargetEvent({
      stableCode: 'r04_races_seed_failed',
      claim: () => repository.claim(30_000),
      isTargetEvent: (claim) => claimMatchesTarget(claim, { blobId: target.blobId, generationId: target.generationId }),
      settleTarget: settle,
      settleForeign: settle,
    });
    assert.equal(targetClaim.aggregateId, target.blobId, 'the loop must return the TARGET claim');
    // Both blobs converged through the PRODUCTION route — the foreign event
    // was harmlessly completed, never left for a later claim.
    const foreignRow = await isolated.runtime.pool.query<{ logical_state: string }>(
      'select logical_state from blob_records where blob_id = $1',
      [foreign.blobId],
    );
    assert.equal(foreignRow.rows[0]!.logical_state, 'stored_private');
    const targetRow = await isolated.runtime.pool.query<{ logical_state: string }>(
      'select logical_state from blob_records where blob_id = $1',
      [target.blobId],
    );
    assert.equal(targetRow.rows[0]!.logical_state, 'stored_private');
    assert.equal(
      await nonTerminalOutboxCount(isolated.runtime),
      0,
      'the loop must leave the outbox clean (foreign event completed, target event completed)',
    );
    const delivered = await sql<{ count: string }>`
      select count(*)::text as count from outbox_events
      where handler_name = ${HANDLER} and state = 'completed'
    `.execute(isolated.runtime.db);
    assert.equal(Number(delivered.rows[0]!.count), 2, 'both events are delivered exactly once');
  });

  test('real outbox: a foreign event the production route cannot settle (missing target -> retryable) fails closed with the stable prefix', async () => {
    const ghost = identityFor(32);
    const target = identityFor(33);
    // OLDER ghost event for a blob that was NEVER allocated: the production
    // claimVerification returns not_found and the route throws retryable.
    await createUnitOfWork(isolated.runtime.db).execute(async ({ transaction }) => {
      await appendAttachmentsVerificationOutbox(transaction, {
        blobId: ghost.blobId,
        generationId: ghost.generationId,
        intentId: ghost.intentId,
      }, { occurredAt: new Date(Date.now() - 60_000) });
    });
    const store = new InMemoryVerificationObjectStore();
    await seedUploadedBlob(isolated.runtime, store, target, pngBody(16));
    await createUnitOfWork(isolated.runtime.db).execute(async ({ transaction }) => {
      await appendAttachmentsVerificationOutbox(transaction, {
        blobId: target.blobId,
        generationId: target.generationId,
        intentId: target.intentId,
      }, { occurredAt: await dbNow(isolated.runtime) });
    });
    const { repository, settle } = productionSettle(isolated.runtime, store);
    await assert.rejects(
      claimAndVerifyTargetEvent({
        stableCode: 'r04_races_seed_failed',
        claim: () => repository.claim(30_000),
        isTargetEvent: (claim) => claimMatchesTarget(claim, { blobId: target.blobId, generationId: target.generationId }),
        settleTarget: settle,
        settleForeign: settle,
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message, 'r04_races_seed_failed:foreign_event_failed');
        assert.equal(stableI16FailureCode(error), 'r04_races_seed_failed');
        return true;
      },
    );
  });

  test('loop: an older foreign event is settled first, then the target event is claimed and settled', async () => {
    const foreign = fakeClaim('foreign-blob', 'foreign-gen');
    const target = fakeClaim('target-blob', 'target-gen');
    const claims: Array<OutboxClaim | null> = [foreign, target];
    const settled: string[] = [];
    const result = await claimAndVerifyTargetEvent({
      stableCode: 'r04_races_seed_failed',
      claim: async () => claims.shift() ?? null,
      isTargetEvent: (claim) => claimMatchesTarget(claim, { blobId: 'target-blob', generationId: 'target-gen' }),
      settleTarget: async (claim) => { settled.push('target:' + claim.aggregateId); },
      settleForeign: async (claim) => { settled.push('foreign:' + claim.aggregateId); },
    });
    assert.equal(result.aggregateId, 'target-blob');
    assert.deepEqual(settled, ['foreign:foreign-blob', 'target:target-blob']);
  });

  test('loop: bounded — exhausting the iteration ceiling fails closed with the stable code', async () => {
    const claims: Array<OutboxClaim | null> = Array.from(
      { length: VERIFICATION_CLAIM_LOOP_MAX_ITERATIONS + 1 },
      (_, index) => fakeClaim('foreign-' + index, 'gen'),
    );
    let settles = 0;
    await assert.rejects(
      claimAndVerifyTargetEvent({
        stableCode: 'r04_races_seed_failed',
        claim: async () => claims.shift() ?? null,
        isTargetEvent: () => false,
        settleTarget: async () => { throw new Error('must not settle a target'); },
        settleForeign: async () => { settles += 1; },
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message, 'r04_races_seed_failed:claim_loop_exhausted');
        assert.equal(stableI16FailureCode(error), 'r04_races_seed_failed');
        return true;
      },
    );
    assert.equal(
      settles,
      VERIFICATION_CLAIM_LOOP_MAX_ITERATIONS,
      'the loop settles exactly maxIterations foreign events, then fails closed',
    );
  });

  test('loop: no claimable event fails closed with target_event_missing', async () => {
    await assert.rejects(
      claimAndVerifyTargetEvent({
        stableCode: 'r04_races_seed_failed',
        claim: async () => null,
        isTargetEvent: () => true,
        settleTarget: async () => {},
        settleForeign: async () => {},
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message, 'r04_races_seed_failed:target_event_missing');
        assert.equal(stableI16FailureCode(error), 'r04_races_seed_failed');
        return true;
      },
    );
  });

  test('loop: a foreign settle failure keeps the stable prefix; an already-stable error propagates unchanged', async () => {
    const cause = new Error('attachments verification target not found');
    await assert.rejects(
      claimAndVerifyTargetEvent({
        stableCode: 'r04_races_seed_failed',
        claim: async () => fakeClaim('foreign-blob', 'gen'),
        isTargetEvent: () => false,
        settleTarget: async () => {},
        settleForeign: async () => { throw cause; },
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message, 'r04_races_seed_failed:foreign_event_failed');
        assert.equal((error as Error & { cause?: unknown }).cause, cause);
        assert.equal(stableI16FailureCode(error), 'r04_races_seed_failed');
        return true;
      },
    );
    await assert.rejects(
      claimAndVerifyTargetEvent({
        stableCode: 'r04_races_seed_failed',
        claim: async () => fakeClaim('foreign-blob', 'gen'),
        isTargetEvent: () => false,
        settleTarget: async () => {},
        settleForeign: async () => { throw new Error('r04_races_seed_failed:outbox_complete'); },
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message, 'r04_races_seed_failed:outbox_complete', 'an already-stable error keeps its tail');
        return true;
      },
    );
  });

  test('loop: a target settle failure keeps the stable prefix', async () => {
    await assert.rejects(
      claimAndVerifyTargetEvent({
        stableCode: 'r04_races_seed_failed',
        claim: async () => fakeClaim('target-blob', 'target-gen'),
        isTargetEvent: () => true,
        settleTarget: async () => { throw new Error('boom'); },
        settleForeign: async () => { throw new Error('unexpected'); },
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message, 'r04_races_seed_failed:target_event_failed');
        assert.equal(stableI16FailureCode(error), 'r04_races_seed_failed');
        return true;
      },
    );
  });

  test('claimMatchesTarget + withStableFailureCode: exact aggregate binding and prefix preservation', async () => {
    const claim = fakeClaim('blob-1', 'gen-1');
    assert.equal(claimMatchesTarget(claim, { blobId: 'blob-1', generationId: 'gen-1' }), true);
    assert.equal(claimMatchesTarget(claim, { blobId: 'blob-1', generationId: 'gen-2' }), false);
    assert.equal(claimMatchesTarget(claim, { blobId: 'blob-2', generationId: 'gen-1' }), false);
    const stable = withStableFailureCode('r04_races_seed_failed', 'foreign_event_failed', new Error('r04_races_seed_failed:outbox_complete'));
    assert.equal(stable.message, 'r04_races_seed_failed:outbox_complete');
    const wrapped = withStableFailureCode('r04_races_seed_failed', 'foreign_event_failed', new Error('raw boom'));
    assert.equal(wrapped.message, 'r04_races_seed_failed:foreign_event_failed');
  });
});
