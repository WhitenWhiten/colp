/**
 * P4A-R03 PostgreSQL integration suite (part 1): the `verification_lease_steal`
 * negative control against the PRODUCTION migration (plan §6 P4A-R03, §4.3
 * mutation control "移除 verification lease token CAS").
 *
 * Proves the claimVerification/completeVerification lease fence with TWO
 * independent worker connections and attempt tokens: a stale worker loses its
 * verification lease at every crash position (claim-after, first-byte-before,
 * partial-stream, digest-after, CAS-before) and a NEW worker takes the
 * expired lease through the PRODUCTION claimVerification SQL on the DATABASE
 * clock — never through test SQL that rewrites the lease owner. The old
 * owner's late CAS and late quarantine must fail `lease_lost` and can never
 * commit; the database converges to the new owner's single verified fact.
 *
 * Anti-false-positive (plan §4.1/§6 R03): no sequential two-worker calls, no
 * mock, no direct `verification_lease_owner` writes; the takeover is the
 * production lease fence and DB-time expiry alone. Anti-false-negative:
 * lock waits are avoided with event-driven barriers and the leases are
 * expired on the database clock, never with a fixed short sleep.
 *
 * The suite also drives the in-run control
 * (`executeR03VerificationLeaseStealControl`) through the fixed R01 executor
 * contract (`I16NegativeControlExecutor`) on the real database, proving the
 * acceptance path completes `executed:true` only with the full in-run record.
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
  type OutboxRepository,
  type VersionedEventEnvelope,
} from '../../../src/infrastructure/outbox/index.js';
import {
  VerificationFatalError,
  completeUpload,
  type CompleteUploadDeps,
  type VerificationFaultInjector,
} from '../../../src/modules/attachments/index.js';
import type { DatabaseTransaction } from '../../../src/infrastructure/database/index.js';
import { describeWithPostgres } from '../../support/postgres-test-runtime.js';
import {
  BarrierGroup,
  createI07MigrationRuntime,
  type I07MigrationRuntime,
} from '../../support/phase4a-i07-test-helpers.js';
import {
  I09_COLLECTION,
  InMemoryVerificationObjectStore,
  allocateInput,
  expectedDigest,
  identityFor,
  makeActor,
  makeI09Config,
  sha256HexBytes,
  type I09Identity,
} from '../../support/phase4a-i09-test-helpers.js';
import { I16NegativeControlExecutor } from '../../../scripts/evidence/phase4a-i16-acceptance.js';
import {
  executeR03VerificationLeaseStealControl,
  type R03ControlDeps,
  type R03LeaseStealControlFacts,
} from '../../../scripts/evidence/phase4a-r03-controls.js';

const CONFIG = makeI09Config();
const ports = createPostgresAttachmentsPorts();

function pngBody(bytes: number): Uint8Array {
  const body = new Uint8Array(bytes);
  body.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  for (let index = 8; index < body.length; index += 1) body[index] = index % 251;
  return body;
}

async function seedUploaded(
  runtime: I07MigrationRuntime['runtime'],
  id: I09Identity,
  body: Uint8Array,
): Promise<InMemoryVerificationObjectStore> {
  await createUnitOfWork(runtime.db).execute(({ transaction }) =>
    ports.allocate(transaction, allocateInput(id, {
      expectedSize: body.byteLength,
      expectedSha256: sha256HexBytes(body),
      mediaHint: 'image/png',
    })));
  const store = new InMemoryVerificationObjectStore();
  store.seed(id.key, body, { etag: `"etag-${id.generationId}"`, contentType: 'image/png' });
  const deps: CompleteUploadDeps<DatabaseTransaction> = {
    ledger: ports,
    blobStore: store,
    uow: createUnitOfWork(runtime.db),
    enqueueVerification: async (tx, payload) => {
      await appendAttachmentsVerificationOutbox(tx, payload);
    },
    config: CONFIG,
  };
  const result = await completeUpload(deps, {
    actor: makeActor(),
    binding: { intentId: id.intentId, generationId: id.generationId, blobId: id.blobId },
    declared: {
      size: body.byteLength,
      sha256: sha256HexBytes(body),
      mediaType: 'image/png',
      etag: `"etag-${id.generationId}"`,
    },
  });
  assert.equal(result.outcome, 'completed');
  return store;
}

function envelopeFromClaim(claim: OutboxClaim): VersionedEventEnvelope {
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

async function expireLeases(runtime: I07MigrationRuntime['runtime'], outboxId: string, blobId: string): Promise<void> {
  // Database-clock lease expiry (never a JS wall clock): the takeover below
  // must go through the PRODUCTION claimVerification fence, not a rewritten
  // owner.
  await runtime.pool.query(
    `update outbox_events set locked_until = current_timestamp - interval '1 second' where outbox_id = $1`,
    [outboxId],
  );
  await runtime.pool.query(
    `update blob_records set verification_lease_expires_at = current_timestamp - interval '1 second' where blob_id = $1`,
    [blobId],
  );
}

interface HandleResult {
  claim: OutboxClaim;
  threw: Error | null;
}

async function claimAndHandle(
  runtime: I07MigrationRuntime['runtime'],
  repository: OutboxRepository,
  store: InMemoryVerificationObjectStore,
  faultInjector: VerificationFaultInjector | undefined,
  signal: AbortSignal,
): Promise<HandleResult | null> {
  const claim = await repository.claim(5_000);
  if (!claim) return null;
  const route = createAttachmentsVerificationOutboxRoute({
    repository: ports,
    blobStore: store,
    uow: createUnitOfWork(runtime.db),
    config: CONFIG,
    faultInjector,
  });
  let threw: Error | null = null;
  try {
    await route.handle({
      envelope: envelopeFromClaim(claim),
      idempotencyKey: claim.eventId,
      signal,
      attempt: { outboxId: claim.outboxId, leaseGeneration: claim.leaseGeneration },
    });
    await repository.complete(claim);
  } catch (error) {
    threw = error instanceof Error ? error : new Error(String(error));
  }
  return { claim, threw };
}

async function blobRow(runtime: I07MigrationRuntime['runtime'], blobId: string): Promise<Record<string, unknown>> {
  const rows = await sql<Record<string, unknown>>`
    select logical_state, current_generation_id, verified_size::text, verified_sha256, media_type,
           verification_policy_version, verification_lease_generation::text, verification_lease_owner
    from blob_records where blob_id = ${blobId}
  `.execute(runtime.db);
  assert.ok(rows.rows[0], `blob ${blobId} must exist`);
  return rows.rows[0]!;
}

async function outboxState(runtime: I07MigrationRuntime['runtime'], outboxId: string): Promise<{ state: string; lease_generation: string }> {
  const rows = await sql<{ state: string; lease_generation: string }>`
    select state, lease_generation::text from outbox_events where outbox_id = ${outboxId}
  `.execute(runtime.db);
  assert.ok(rows.rows[0], `outbox ${outboxId} must exist`);
  return rows.rows[0]!;
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

describeWithPostgres('P4A-R03 verification lease steal', () => {
  let isolated: I07MigrationRuntime;

  beforeAll(async () => {
    isolated = await createI07MigrationRuntime('r03_lease_steal', { maxConnections: 16 });
  });

  afterAll(async () => {
    await isolated?.dropSchema();
  });

  test('the production claim fence blocks a foreign claim while the first lease is unexpired; DB-time expiry alone lets a NEW worker claim (no SQL lease-owner writes)', async () => {
    const id = identityFor(1);
    const body = pngBody(21);
    const store = await seedUploaded(isolated.runtime, id, body);
    const repository = new PostgresOutboxRepository(isolated.runtime.pool);
    const first = await claimAndHandle(
      isolated.runtime, repository, store,
      { afterDigest: async () => { throw new Error('worker A crashed after digest'); } },
      new AbortController().signal,
    );
    assert.ok(first && first.threw, 'worker A must crash after the digest');
    const aClaim = first!.claim;
    let state = await blobRow(isolated.runtime, id.blobId);
    assert.equal(state.logical_state, 'verifying');
    assert.equal(state.verification_lease_owner, aClaim.outboxId);

    // A foreign worker cannot claim while the lease is unexpired: the
    // PRODUCTION claimVerification port must reject before any state change.
    const foreign = await createUnitOfWork(isolated.runtime.db).execute(({ transaction }) =>
      ports.claimVerification(transaction, {
        blobId: id.blobId,
        generationId: id.generationId,
        attempt: { outboxId: `foreign-outbox-${id.blobId}`, leaseGeneration: '1' },
        leaseTtlSeconds: 60,
      }));
    assert.equal(foreign.outcome, 'lease_lost');
    state = await blobRow(isolated.runtime, id.blobId);
    assert.equal(state.verification_lease_owner, aClaim.outboxId, 'a rejected claim must not change the lease owner');

    // The leases expire on the DATABASE clock; the takeover is the PRODUCTION
    // claimVerification fence (worker B claims the outbox row itself), never
    // test SQL that rewrites the owner.
    await expireLeases(isolated.runtime, aClaim.outboxId, id.blobId);
    const second = await claimAndHandle(isolated.runtime, repository, store, undefined, new AbortController().signal);
    assert.ok(second && second.threw === null, 'the new worker must store');
    // The outbox row keeps its identity; the attempt token independence is the
    // INCREMENTED lease generation (the production claimVerification fence
    // checks `lease_generation`, never the outbox id).
    assert.notEqual(second!.claim.leaseGeneration, aClaim.leaseGeneration, 'the new worker must use an independent attempt token');
    state = await blobRow(isolated.runtime, id.blobId);
    assert.equal(state.logical_state, 'stored_private');
    assert.equal(state.verified_sha256, expectedDigest(body));

    // The old owner's late CAS and late quarantine can never commit.
    const lateCas = await createUnitOfWork(isolated.runtime.db).execute(({ transaction }) =>
      ports.completeVerification(transaction, {
        blobId: id.blobId,
        generationId: id.generationId,
        attempt: { outboxId: aClaim.outboxId, leaseGeneration: aClaim.leaseGeneration },
        verifiedSize: body.byteLength,
        verifiedSha256: 'f'.repeat(64),
        mediaType: 'image/png',
        policyVersion: 'phase4a-i09-policy-v1',
      }));
    assert.equal(lateCas.outcome, 'lease_lost');
    const lateQuarantine = await createUnitOfWork(isolated.runtime.db).execute(({ transaction }) =>
      ports.quarantineVerification(transaction, {
        blobId: id.blobId,
        generationId: id.generationId,
        attempt: { outboxId: aClaim.outboxId, leaseGeneration: aClaim.leaseGeneration },
        reason: 'late-corruption',
      }));
    assert.equal(lateQuarantine.outcome, 'lease_lost');
    state = await blobRow(isolated.runtime, id.blobId);
    assert.equal(state.verified_sha256, expectedDigest(body), 'the stored facts must never be overwritten by the old lease');
  });

  test('lease steal at every worker crash point: the old owner can never commit', async () => {
    const crashPoints: Array<{ name: string; hook: (injector: VerificationFaultInjector) => void }> = [
      { name: 'claim-after', hook: (injector) => { injector.afterClaim = async () => { throw new Error('crash after claim'); }; } },
      { name: 'first-byte-before', hook: (injector) => { injector.beforeFirstByte = async () => { throw new VerificationFatalError('crash before first byte'); }; } },
      { name: 'partial-stream', hook: (injector) => { injector.afterPartial = async () => { throw new VerificationFatalError('crash mid stream'); }; } },
      { name: 'digest-after', hook: (injector) => { injector.afterDigest = async () => { throw new Error('crash after digest'); }; } },
      { name: 'cas-before', hook: (injector) => { injector.beforeStoredCas = async () => { throw new Error('crash before stored CAS'); }; } },
    ];
    let slot = 10;
    for (const point of crashPoints) {
      slot += 1;
      const id = identityFor(slot);
      const body = pngBody(20 + slot);
      const store = await seedUploaded(isolated.runtime, id, body);
      const repository = new PostgresOutboxRepository(isolated.runtime.pool);
      const injector: VerificationFaultInjector = {};
      point.hook(injector);
      const first = await claimAndHandle(isolated.runtime, repository, store, injector, new AbortController().signal);
      assert.ok(first && first.threw, `${point.name}: the crash must interrupt the first worker`);
      let state = await blobRow(isolated.runtime, id.blobId);
      assert.equal(state.logical_state, 'verifying', `${point.name}: the first claim must be durable`);
      assert.equal(state.verification_lease_owner, first!.claim.outboxId, `${point.name}: the lease must belong to the crashed worker`);

      // The crashed worker's leases expire on the DATABASE clock; a NEW worker
      // (independent connection + attempt token) claims through the production
      // port and stores.
      await expireLeases(isolated.runtime, first!.claim.outboxId, id.blobId);
      const second = await claimAndHandle(isolated.runtime, repository, store, undefined, new AbortController().signal);
      assert.ok(second && second.threw === null, `${point.name}: the new worker must store`);
      // Attempt-token independence is the incremented lease generation on the
      // SAME outbox row (the production fence checks `lease_generation`).
      assert.notEqual(second!.claim.leaseGeneration, first!.claim.leaseGeneration, `${point.name}: the new worker must use an independent attempt token`);
      state = await blobRow(isolated.runtime, id.blobId);
      assert.equal(state.logical_state, 'stored_private', `${point.name}: the new owner stores`);
      assert.equal(state.verified_sha256, expectedDigest(body), `${point.name}: the verified facts match the exact bytes`);

      // The old owner's late CAS must fail lease_lost and never commit.
      const late = await createUnitOfWork(isolated.runtime.db).execute(({ transaction }) =>
        ports.completeVerification(transaction, {
          blobId: id.blobId,
          generationId: id.generationId,
          attempt: { outboxId: first!.claim.outboxId, leaseGeneration: first!.claim.leaseGeneration },
          verifiedSize: body.byteLength,
          verifiedSha256: 'f'.repeat(64),
          mediaType: 'image/png',
          policyVersion: 'phase4a-i09-policy-v1',
        }));
      assert.equal(late.outcome, 'lease_lost', `${point.name}: the old lease can never commit`);
      state = await blobRow(isolated.runtime, id.blobId);
      assert.notEqual(state.verified_sha256, 'f'.repeat(64), `${point.name}: the stored facts must never be overwritten by the old lease`);
      const outbox = await outboxState(isolated.runtime, second!.claim.outboxId);
      assert.equal(outbox.state, 'completed', `${point.name}: the outbox row converges`);
    }
  });

  test('lease steal at the CAS-before barrier: the old owner is blocked while the new owner stores; the late CAS then fails', async () => {
    const id = identityFor(40);
    const body = pngBody(28);
    const store = await seedUploaded(isolated.runtime, id, body);
    const repository = new PostgresOutboxRepository(isolated.runtime.pool);
    const barrier = new BarrierGroup();
    const claimA = await repository.claim(5_000);
    assert.ok(claimA, 'worker A must claim');
    let atCasBarrier = false;
    const routeA = createAttachmentsVerificationOutboxRoute({
      repository: ports,
      blobStore: store,
      uow: createUnitOfWork(isolated.runtime.db),
      config: CONFIG,
      faultInjector: {
        beforeStoredCas: async () => {
          atCasBarrier = true;
          await barrier.arriveAndWait('a-at-cas');
        },
      },
    });
    const pendingA = (async () => {
      try {
        await routeA.handle({
          envelope: envelopeFromClaim(claimA),
          idempotencyKey: claimA.eventId,
          signal: new AbortController().signal,
          attempt: { outboxId: claimA.outboxId, leaseGeneration: claimA.leaseGeneration },
        });
        return null;
      } catch (error) {
        return error instanceof Error ? error : new Error(String(error));
      }
    })();
    await barrier.waitArrived('a-at-cas', 1);
    assert.equal(atCasBarrier, true, 'worker A must be blocked immediately before its stored CAS');

    // Worker B steals the expired lease and stores while A is blocked.
    await expireLeases(isolated.runtime, claimA.outboxId, id.blobId);
    const second = await claimAndHandle(isolated.runtime, repository, store, undefined, new AbortController().signal);
    assert.ok(second && second.threw === null, 'worker B must store while A is blocked');
    let state = await blobRow(isolated.runtime, id.blobId);
    assert.equal(state.logical_state, 'stored_private');

    barrier.release('a-at-cas');
    const aError = await pendingA;
    assert.ok(aError, 'worker A must observe the lost lease after B stored');
    assert.match(aError!.message, /lease lost|retryable/, 'A must fail with the retryable lease-lost class');
    state = await blobRow(isolated.runtime, id.blobId);
    assert.equal(state.logical_state, 'stored_private');
    assert.equal(state.verified_sha256, expectedDigest(body), 'B\'s facts must be the committed facts');

    // A's late CAS with its old attempt token can never commit.
    const late = await createUnitOfWork(isolated.runtime.db).execute(({ transaction }) =>
      ports.completeVerification(transaction, {
        blobId: id.blobId,
        generationId: id.generationId,
        attempt: { outboxId: claimA.outboxId, leaseGeneration: claimA.leaseGeneration },
        verifiedSize: body.byteLength,
        verifiedSha256: 'f'.repeat(64),
        mediaType: 'image/png',
        policyVersion: 'phase4a-i09-policy-v1',
      }));
    assert.equal(late.outcome, 'lease_lost');
  });

  test('a duplicate delivery of the stolen outbox row converges idempotently with no contradiction', async () => {
    const id = identityFor(60);
    const body = pngBody(19);
    const store = await seedUploaded(isolated.runtime, id, body);
    const repository = new PostgresOutboxRepository(isolated.runtime.pool);
    const first = await claimAndHandle(
      isolated.runtime, repository, store,
      { afterDigest: async () => { throw new Error('crash'); } },
      new AbortController().signal,
    );
    assert.ok(first && first.threw);
    await expireLeases(isolated.runtime, first!.claim.outboxId, id.blobId);
    const second = await claimAndHandle(isolated.runtime, repository, store, undefined, new AbortController().signal);
    assert.ok(second && second.threw === null);
    let state = await blobRow(isolated.runtime, id.blobId);
    assert.equal(state.logical_state, 'stored_private');
    // Force a redelivery of the SAME outbox row (delivery state only).
    await isolated.runtime.pool.query(
      `update outbox_events set state = 'pending', locked_until = null, lease_generation = 0 where outbox_id = $1`,
      [second!.claim.outboxId],
    );
    const duplicate = await claimAndHandle(isolated.runtime, repository, store, undefined, new AbortController().signal);
    assert.ok(duplicate && duplicate.threw === null, 'the duplicate delivery must converge');
    state = await blobRow(isolated.runtime, id.blobId);
    assert.equal(state.logical_state, 'stored_private');
    assert.equal(state.verified_sha256, expectedDigest(body), 'a duplicate delivery must not contradict the stored facts');
    const outbox = await outboxState(isolated.runtime, duplicate!.claim.outboxId);
    assert.equal(outbox.state, 'completed');
  });

  test('the in-run control completes the executor contract at the real DB boundary', async () => {
    const executionLedger = new I16NegativeControlExecutor();
    const store = new InMemoryVerificationObjectStore();
    const facts: R03LeaseStealControlFacts = await executeR03VerificationLeaseStealControl(
      controlDeps(executionLedger, isolated.runtime, store, 'r03-lease-steal-nonce'),
    );
    assert.equal(facts.stableCode, 'lease_lost');
    assert.equal(facts.oldOwnerNeverCommitted, true);
    assert.equal(facts.finalBlobState, 'stored_private');
    const receipt = executionLedger.receiptFor('verification_lease_steal');
    assert.equal(receipt.stableCode, 'lease_lost');
    assert.equal(receipt.verificationSource, 'postgres-integration-suite');
    assert.equal(receipt.cleanupReceipt, 'old_owner_never_committed_blob_stored_private');
    // The final database fact is the new owner's verified digest, exactly once.
    const rows = await sql<{ count: string }>`
      select count(*)::text as count from blob_records
      where blob_id = ${facts.blobId} and logical_state = 'stored_private' and verified_sha256 = ${facts.finalVerifiedSha256}
    `.execute(isolated.runtime.db);
    assert.equal(Number(rows.rows[0]!.count), 1);
  });
});
