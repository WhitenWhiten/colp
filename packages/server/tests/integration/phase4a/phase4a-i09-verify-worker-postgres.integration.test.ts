/**
 * P4A-I09 PostgreSQL integration suite (part 2): the verification worker
 * against the PRODUCTION migration + outbox machinery.
 *
 * Proves the full worker flow (claim -> HEAD -> conditional read -> verify ->
 * stored_private CAS with the lease token), TWO worker instances with
 * deterministic barriers (lease steal: an old-lease late result CAS-fails),
 * the crash matrix with restart (claim-after, HEAD-after, first-byte-before,
 * partial-stream, digest-after, CAS-before, commit-response-lost) checking DB,
 * Outbox and the exact R2 object, duplicate outbox delivery producing no
 * contradictory evidence, and oversize/unknown-MIME policies.
 */
import assert from 'node:assert/strict';
import { sql } from 'kysely';
import { afterAll, beforeAll, test } from 'vitest';
import { createPostgresAttachmentsPorts, createUnitOfWork } from '../../../src/infrastructure/database/index.js';
import {
  EventEnvelopeRegistry,
  OutboxRouter,
  PostgresOutboxRepository,
  VersionedOutboxWorker,
  appendAttachmentsVerificationOutbox,
  attachmentsVerificationEnvelopeRegistration,
  createAttachmentsVerificationOutboxRoute,
  createExponentialRetryPolicy,
  type OutboxClaim,
  type OutboxRepository,
  type OutboxWorkerLogger,
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
  InMemoryVerificationObjectStore,
  allocateInput,
  expectedDigest,
  identityFor,
  makeActor,
  makeI09Config,
  sha256HexBytes,
  type I09Identity,
} from '../../support/phase4a-i09-test-helpers.js';

const CONFIG = makeI09Config();
const ports = createPostgresAttachmentsPorts();
const HANDLER = 'attachments_verify_generation';

const workerLogger: OutboxWorkerLogger = {
  info: () => {}, warn: () => {}, error: () => {},
};

function pngBody(bytes = 16): Uint8Array {
  const body = new Uint8Array(bytes);
  body.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  for (let index = 8; index < body.length; index += 1) body[index] = index % 251;
  return body;
}

async function seedUploaded(
  runtime: I07MigrationRuntime['runtime'],
  id: I09Identity,
  body: Uint8Array = pngBody(),
  options: { store?: InMemoryVerificationObjectStore } = {},
): Promise<InMemoryVerificationObjectStore> {
  await createUnitOfWork(runtime.db).execute(({ transaction }) =>
    ports.allocate(transaction, allocateInput(id, {
      expectedSize: body.byteLength,
      expectedSha256: sha256HexBytes(body),
      mediaHint: 'image/png',
    })));
  const store = options.store ?? new InMemoryVerificationObjectStore();
  store.seed(id.key, body, { etag: `"etag-${id.generationId}"` });
  const deps: CompleteUploadDeps<DatabaseTransaction> = {
    ledger: ports,
    blobStore: store,
    uow: createUnitOfWork(runtime.db),
    enqueueVerification: (tx, payload) => appendAttachmentsVerificationOutbox(tx, payload),
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
    payload: claim.payload,
  };
}

async function expireLeases(runtime: I07MigrationRuntime['runtime'], outboxId: string, blobId: string): Promise<void> {
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
    // Production worker behavior: the durable side effect (stored_private /
    // quarantine / already_stored) committed inside the handler, so the row is
    // completed now. Retryable/lease-lost outcomes threw above and leave the
    // row for re-delivery.
    await repository.complete(claim);
  } catch (error) {
    threw = error instanceof Error ? error : new Error(String(error));
  }
  return { claim, threw };
}

async function blobRow(runtime: I07MigrationRuntime['runtime'], blobId: string): Promise<Record<string, unknown>> {
  const rows = await sql<Record<string, unknown>>`
    select logical_state, current_generation_id, verified_size::text, verified_sha256, media_type, verification_policy_version, verification_lease_generation::text
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

describeWithPostgres('P4A-I09 verification worker', () => {
  let isolated: I07MigrationRuntime;

  beforeAll(async () => {
    isolated = await createI07MigrationRuntime('i09_worker', { maxConnections: 16 });
  });

  afterAll(async () => {
    await isolated?.dropSchema();
  });

  test('happy path: the production outbox worker verifies and stores with facts matching the R2 bytes', async () => {
    const id = identityFor(1);
    const body = pngBody(31);
    const store = await seedUploaded(isolated.runtime, id, body);
    const repository = new PostgresOutboxRepository(isolated.runtime.pool);
    const route = createAttachmentsVerificationOutboxRoute({
      repository: ports, blobStore: store, uow: createUnitOfWork(isolated.runtime.db), config: CONFIG,
    });
    const worker = new VersionedOutboxWorker({
      repository,
      router: new OutboxRouter([route]),
      envelopes: new EventEnvelopeRegistry([attachmentsVerificationEnvelopeRegistration]),
      logger: workerLogger,
      leaseDurationMs: 5_000,
      heartbeatIntervalMs: 1_000,
      handlerTimeoutMs: 3_000,
      maxConcurrentHandlers: 1,
      batchSize: 1,
      pollIntervalMs: 10,
      retryPolicy: createExponentialRetryPolicy({ baseDelayMs: 10, maxDelayMs: 50, maxAttempts: 5, jitterRatio: 0 }),
    });
    const worked = await worker.runOnce();
    assert.equal(worked, true);
    const blob = await blobRow(isolated.runtime, id.blobId);
    assert.equal(blob.logical_state, 'stored_private');
    assert.equal(Number(blob.verified_size), body.byteLength);
    assert.equal(blob.verified_sha256, expectedDigest(body), 'verified digest must match the independent digest of the exact R2 bytes');
    assert.equal(blob.media_type, 'image/png');
    assert.equal(blob.verification_policy_version, 'phase4a-i09-policy-v1');
    const receipts = await sql<{ count: string }>`select count(*)::text as count from outbox_delivery_receipts where handler_name = ${HANDLER}`.execute(isolated.runtime.db);
    assert.equal(Number(receipts.rows[0]!.count), 1);
  });

  test('TWO worker instances verify distinct rows concurrently with no double-verify', async () => {
    const ids = [identityFor(2), identityFor(3), identityFor(4)];
    const bodies = ids.map((_id, index) => pngBody(20 + index * 3));
    for (let index = 0; index < ids.length; index += 1) {
      await seedUploaded(isolated.runtime, ids[index]!, bodies[index]!);
    }
    const store = new InMemoryVerificationObjectStore();
    for (let index = 0; index < ids.length; index += 1) {
      store.seed(ids[index]!.key, bodies[index]!, { etag: `"etag-${ids[index]!.generationId}"` });
    }
    const route = createAttachmentsVerificationOutboxRoute({
      repository: ports, blobStore: store, uow: createUnitOfWork(isolated.runtime.db), config: CONFIG,
    });
    const repository = new PostgresOutboxRepository(isolated.runtime.pool);
    const makeWorker = () => new VersionedOutboxWorker({
      repository,
      router: new OutboxRouter([route]),
      envelopes: new EventEnvelopeRegistry([attachmentsVerificationEnvelopeRegistration]),
      logger: workerLogger,
      leaseDurationMs: 5_000,
      heartbeatIntervalMs: 1_000,
      handlerTimeoutMs: 3_000,
      maxConcurrentHandlers: 1,
      batchSize: 1,
      pollIntervalMs: 10,
      retryPolicy: createExponentialRetryPolicy({ baseDelayMs: 10, maxDelayMs: 50, maxAttempts: 5, jitterRatio: 0 }),
    });
    const workerA = makeWorker();
    const workerB = makeWorker();
    let iterations = 0;
    while (iterations < 50) {
      iterations += 1;
      const [a, b] = await Promise.all([workerA.runOnce(), workerB.runOnce()]);
      if (!a && !b) break;
    }
    for (let index = 0; index < ids.length; index += 1) {
      const blob = await blobRow(isolated.runtime, ids[index]!.blobId);
      assert.equal(blob.logical_state, 'stored_private');
      assert.equal(blob.verified_sha256, expectedDigest(bodies[index]!));
    }
    const blobIds = ids.map((entry) => entry.blobId);
    const receipts = await sql<{ count: string }>`
      select count(*)::text as count
      from outbox_delivery_receipts r
      join outbox_events e on e.domain_event_id = r.domain_event_id
      where r.handler_name = ${HANDLER} and e.aggregate_id in (${sql.join(blobIds)})
    `.execute(isolated.runtime.db);
    assert.equal(Number(receipts.rows[0]!.count), 3, 'each outbox row completes exactly once');
    const pending = await sql<{ count: string }>`
      select count(*)::text as count from outbox_events
      where handler_name = ${HANDLER} and state = 'completed' and aggregate_id in (${sql.join(blobIds)})
    `.execute(isolated.runtime.db);
    assert.equal(Number(pending.rows[0]!.count), 3);
  });

  test('lease steal: an old-lease late result CAS-fails; the new owner stores', async () => {
    const id = identityFor(5);
    const body = pngBody(26);
    const store = await seedUploaded(isolated.runtime, id, body);
    const repository = new PostgresOutboxRepository(isolated.runtime.pool);

    // Worker A claims and crashes after the digest (before the stored CAS).
    let crashA = true;
    const injectorA: VerificationFaultInjector = {
      afterDigest: async () => {
        if (crashA) {
          crashA = false;
          throw new Error('worker A crashed after digest');
        }
      },
    };
    const first = await claimAndHandle(isolated.runtime, repository, store, injectorA, new AbortController().signal);
    assert.ok(first && first.threw, 'worker A must crash after digest');
    const aClaim = first!.claim;
    let state = await blobRow(isolated.runtime, id.blobId);
    assert.equal(state.logical_state, 'verifying');

    // A's leases expire; worker B claims and stores.
    await expireLeases(isolated.runtime, aClaim.outboxId, id.blobId);
    const second = await claimAndHandle(isolated.runtime, repository, store, undefined, new AbortController().signal);
    assert.ok(second && second.threw === null, 'worker B must succeed');
    state = await blobRow(isolated.runtime, id.blobId);
    assert.equal(state.logical_state, 'stored_private');
    assert.equal(state.verified_sha256, expectedDigest(body));

    // A's late stored CAS with its old lease generation fails.
    const late = await createUnitOfWork(isolated.runtime.db).execute(({ transaction }) =>
      ports.completeVerification(transaction, {
        blobId: id.blobId,
        generationId: id.generationId,
        attempt: { outboxId: aClaim.outboxId, leaseGeneration: aClaim.leaseGeneration },
        verifiedSize: body.byteLength,
        verifiedSha256: 'f'.repeat(64),
        mediaType: 'image/png',
        policyVersion: 'phase4a-i09-policy-v1',
      }));
    assert.equal(late.outcome, 'lease_lost');
    state = await blobRow(isolated.runtime, id.blobId);
    assert.notEqual(state.verified_sha256, 'f'.repeat(64), 'the stored facts must never be overwritten by an old lease');
  });

  test('crash matrix: every verification crash point recovers after restart', async () => {
    const crashPoints: Array<{ name: string; hook: (injector: VerificationFaultInjector) => void }> = [
      { name: 'claim-after', hook: (injector) => { injector.afterClaim = async () => { throw new Error('crash after claim'); }; } },
      { name: 'head-after', hook: (injector) => { injector.afterHead = async () => { throw new Error('crash after head'); }; } },
      { name: 'first-byte-before', hook: (injector) => { injector.beforeFirstByte = async () => { throw new VerificationFatalError('crash before first byte'); }; } },
      { name: 'partial-stream', hook: (injector) => { injector.afterPartial = async () => { throw new VerificationFatalError('crash mid stream'); }; } },
      { name: 'digest-after', hook: (injector) => { injector.afterDigest = async () => { throw new Error('crash after digest'); }; } },
      { name: 'cas-before', hook: (injector) => { injector.beforeStoredCas = async () => { throw new Error('crash before stored CAS'); }; } },
    ];
    let slot = 10;
    for (const point of crashPoints) {
      slot += 1;
      const id = identityFor(slot);
      const body = pngBody(20);
      const store = await seedUploaded(isolated.runtime, id, body);
      const repository = new PostgresOutboxRepository(isolated.runtime.pool);
      const injector: VerificationFaultInjector = {};
      point.hook(injector);
      const first = await claimAndHandle(isolated.runtime, repository, store, injector, new AbortController().signal);
      assert.ok(first && first.threw, `${point.name}: the crash must interrupt the worker`);
      let state = await blobRow(isolated.runtime, id.blobId);
      assert.equal(state.logical_state, 'verifying', `${point.name}: the claim must be durable before the crash`);

      // Restart: expire the leases and let a fresh worker claim + converge.
      await expireLeases(isolated.runtime, first!.claim.outboxId, id.blobId);
      const restarted = await claimAndHandle(isolated.runtime, repository, store, undefined, new AbortController().signal);
      assert.ok(restarted && restarted.threw === null, `${point.name}: the restarted worker must converge`);
      state = await blobRow(isolated.runtime, id.blobId);
      assert.equal(state.logical_state, 'stored_private', `${point.name}: restart must reach stored_private`);
      assert.equal(state.verified_sha256, expectedDigest(body), `${point.name}: verified fields must match the exact R2 bytes`);
      const outbox = await outboxState(isolated.runtime, restarted!.claim.outboxId);
      assert.equal(outbox.state, 'completed', `${point.name}: the outbox row must complete`);
      assert.equal(store.bytesOf(id.key)!.byteLength, body.byteLength, `${point.name}: the R2 object must be intact`);
    }
  });

  test('commit-response-lost: the outbox completion fails once, retry converges with no contradiction', async () => {
    const id = identityFor(30);
    const body = pngBody(24);
    const store = await seedUploaded(isolated.runtime, id, body);
    const base = new PostgresOutboxRepository(isolated.runtime.pool);
    let failComplete = true;
    const repository: OutboxRepository = {
      claim: (leaseDurationMs) => base.claim(leaseDurationMs),
      inspectBacklog: () => base.inspectBacklog(),
      heartbeat: (claim, leaseDurationMs) => base.heartbeat(claim, leaseDurationMs),
      isObsoleteProjection: (claim) => base.isObsoleteProjection(claim),
      hasDeliveryReceipt: (claim) => base.hasDeliveryReceipt(claim),
      continue: (claim) => base.continue(claim),
      fail: (claim, error, retryDelayMs, maxAttempts) => base.fail(claim, error, retryDelayMs, maxAttempts),
      complete: async (claim) => {
        if (failComplete) {
          failComplete = false;
          throw new Error('simulated lost outbox completion acknowledgement');
        }
        return base.complete(claim);
      },
    };
    const route = createAttachmentsVerificationOutboxRoute({
      repository: ports, blobStore: store, uow: createUnitOfWork(isolated.runtime.db), config: CONFIG,
    });
    const makeWorker = () => new VersionedOutboxWorker({
      repository,
      router: new OutboxRouter([route]),
      envelopes: new EventEnvelopeRegistry([attachmentsVerificationEnvelopeRegistration]),
      logger: workerLogger,
      leaseDurationMs: 5_000,
      heartbeatIntervalMs: 1_000,
      handlerTimeoutMs: 3_000,
      maxConcurrentHandlers: 1,
      batchSize: 1,
      pollIntervalMs: 10,
      retryPolicy: createExponentialRetryPolicy({ baseDelayMs: 10, maxDelayMs: 50, maxAttempts: 5, jitterRatio: 0 }),
    });
    const worker = makeWorker();
    await worker.runOnce(); // handler stores; complete() throws -> retryable
    let state = await blobRow(isolated.runtime, id.blobId);
    assert.equal(state.logical_state, 'stored_private');
    const rowAfterFirst = await sql<{ state: string; attempt_count: string }>`
      select state, attempt_count::text from outbox_events where handler_name = ${HANDLER} and aggregate_id = ${id.blobId}
    `.execute(isolated.runtime.db);
    assert.notEqual(rowAfterFirst.rows[0]!.state, 'completed');
    // Poll until the retry delay elapses, then re-deliver: already_stored -> complete() succeeds.
    let completed = false;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      const row = await sql<{ state: string }>`
        select state from outbox_events where handler_name = ${HANDLER} and aggregate_id = ${id.blobId}
      `.execute(isolated.runtime.db);
      if (row.rows[0]!.state === 'completed') { completed = true; break; }
      await worker.runOnce();
    }
    state = await blobRow(isolated.runtime, id.blobId);
    assert.equal(state.logical_state, 'stored_private');
    assert.equal(state.verified_sha256, expectedDigest(body), 'the redelivery must not rewrite the verified facts');
    assert.equal(completed, true, 'the duplicate delivery must eventually complete the outbox row');
    const rowAfterSecond = await sql<{ state: string }>`
      select state from outbox_events where handler_name = ${HANDLER} and aggregate_id = ${id.blobId}
    `.execute(isolated.runtime.db);
    assert.equal(rowAfterSecond.rows[0]!.state, 'completed');
  });

  test('duplicate outbox delivery after completion converges idempotently with no contradiction', async () => {
    const id = identityFor(31);
    const body = pngBody(22);
    const store = await seedUploaded(isolated.runtime, id, body);
    const repository = new PostgresOutboxRepository(isolated.runtime.pool);
    const first = await claimAndHandle(isolated.runtime, repository, store, undefined, new AbortController().signal);
    assert.ok(first && first.threw === null);
    let state = await blobRow(isolated.runtime, id.blobId);
    assert.equal(state.logical_state, 'stored_private');
    // Force a redelivery of the SAME outbox row (delivery state only).
    await isolated.runtime.pool.query(
      `update outbox_events set state = 'pending', locked_until = null, lease_generation = 0 where outbox_id = $1`,
      [first!.claim.outboxId],
    );
    const duplicate = await claimAndHandle(isolated.runtime, repository, store, undefined, new AbortController().signal);
    assert.ok(duplicate && duplicate.threw === null);
    state = await blobRow(isolated.runtime, id.blobId);
    assert.equal(state.logical_state, 'stored_private');
    assert.equal(state.verified_sha256, expectedDigest(body), 'a duplicate delivery must not contradict the stored facts');
    const outbox = await outboxState(isolated.runtime, duplicate!.claim.outboxId);
    assert.equal(outbox.state, 'completed');
  });

  test('oversize corrupts to quarantine with the stream never opened; the blob expires', async () => {
    const id = identityFor(32);
    const body = pngBody(16);
    const store = await seedUploaded(isolated.runtime, id, body);
    // Same-key provider corruption: same etag, oversized object.
    const big = new Uint8Array(CONFIG.singlePutMaxBytes + 1);
    store.seed(id.key, big, { etag: `"etag-${id.generationId}"` });
    const repository = new PostgresOutboxRepository(isolated.runtime.pool);
    const result = await claimAndHandle(isolated.runtime, repository, store, undefined, new AbortController().signal);
    assert.ok(result, 'oversize: claim must succeed');
    assert.equal(result!.threw, null, result!.threw?.message ?? 'oversize: handler must not throw');
    const state = await blobRow(isolated.runtime, id.blobId);
    assert.equal(state.logical_state, 'expired');
    const gen = await sql<{ generation_state: string }>`
      select generation_state from blob_generations where generation_id = ${id.generationId}
    `.execute(isolated.runtime.db);
    assert.equal(gen.rows[0]!.generation_state, 'quarantined');
    assert.equal(store.readCalls.length, 1, 'the read was attempted');
    assert.equal(store.destroyedStreams.includes(id.key), false, 'no stream was opened for an oversized object');
  });

  test('unknown MIME stores as a generic private download (never clean/safe)', async () => {
    const id = identityFor(33);
    const body = new Uint8Array(14);
    for (let index = 0; index < body.length; index += 1) body[index] = index % 251;
    const store = await seedUploaded(isolated.runtime, id, body);
    const repository = new PostgresOutboxRepository(isolated.runtime.pool);
    const result = await claimAndHandle(isolated.runtime, repository, store, undefined, new AbortController().signal);
    assert.ok(result && result.threw === null);
    const state = await blobRow(isolated.runtime, id.blobId);
    assert.equal(state.logical_state, 'stored_private');
    assert.equal(state.media_type, 'application/octet-stream');
    assert.equal(state.verified_sha256, expectedDigest(body));
  });

  test('FIX-L-045: a stale verification event for a replaced generation completes terminal (already_replaced); the new generation verifies untouched', async () => {
    const g1 = identityFor(40);
    const body1 = pngBody(19);
    const store = await seedUploaded(isolated.runtime, g1, body1);
    // A replacement completes over g1 in the SAME canonical transaction:
    // g1 -> retired, g2 -> active, the pointer moves, and g2's own
    // verification event is enqueued (FIFO behind g1's event).
    const g2 = identityFor(41);
    const body2 = pngBody(23);
    store.seed(g2.key, body2, { etag: `"etag-${g2.generationId}"` });
    await createUnitOfWork(isolated.runtime.db).execute(({ transaction }) =>
      ports.allocate(transaction, allocateInput(g2, {
        blobId: g1.blobId,
        expectedSize: body2.byteLength,
        expectedSha256: sha256HexBytes(body2),
        mediaHint: 'image/png',
      })));
    const replaced = await completeUpload({
      ledger: ports,
      blobStore: store,
      uow: createUnitOfWork(isolated.runtime.db),
      enqueueVerification: (tx, payload) => appendAttachmentsVerificationOutbox(tx, payload),
      config: CONFIG,
    }, {
      actor: makeActor(),
      binding: { intentId: g2.intentId, generationId: g2.generationId, blobId: g1.blobId },
      declared: {
        size: body2.byteLength,
        sha256: sha256HexBytes(body2),
        mediaType: 'image/png',
        etag: `"etag-${g2.generationId}"`,
      },
    });
    assert.equal(replaced.outcome, 'completed');
    const gen1 = await sql<{ generation_state: string }>`
      select generation_state from blob_generations where generation_id = ${g1.generationId}
    `.execute(isolated.runtime.db);
    assert.equal(gen1.rows[0]!.generation_state, 'retired');
    let state = await blobRow(isolated.runtime, g1.blobId);
    assert.equal(state.current_generation_id, g2.generationId);

    // The OLD event redelivers: the claim proves the replacement inside the
    // transaction and completes terminal WITHOUT touching the new generation
    // (this is where the pre-fix code returned lease_lost -> retryable ->
    // dead-letter forever).
    const repository = new PostgresOutboxRepository(isolated.runtime.pool);
    // The store already carries the complete-phase HEAD calls; the stale
    // event must add none.
    const headCallsBefore = store.headCalls.length;
    const readCallsBefore = store.readCalls.length;
    const stale = await claimAndHandle(isolated.runtime, repository, store, undefined, new AbortController().signal);
    assert.ok(stale && stale.threw === null, 'the stale event must complete without throwing');
    const stalePayload = stale!.claim.payload as { generationId?: string };
    assert.equal(stalePayload.generationId, g1.generationId, 'the first claim must be the OLD generation event (FIFO)');
    state = await blobRow(isolated.runtime, g1.blobId);
    assert.equal(state.logical_state, 'uploaded', 'the stale event must not store or demote the new generation');
    assert.equal(state.current_generation_id, g2.generationId, 'the new generation pointer must stay untouched');
    assert.equal(state.verified_sha256, null, 'no verified facts may be written for the replaced generation');
    assert.equal(state.verification_lease_generation, '0', 'no verification lease may be taken');
    assert.equal(store.headCalls.length, headCallsBefore, 'no provider HEAD may run for a replaced generation');
    assert.equal(store.readCalls.length, readCallsBefore, 'no provider read may run for a replaced generation');
    const staleOutbox = await outboxState(isolated.runtime, stale!.claim.outboxId);
    assert.equal(staleOutbox.state, 'completed', 'the stale event row must complete, not dead-letter');

    // The NEW generation's own event still verifies and stores its facts.
    const fresh = await claimAndHandle(isolated.runtime, repository, store, undefined, new AbortController().signal);
    assert.ok(fresh && fresh.threw === null, 'the new generation event must store');
    const freshPayload = fresh!.claim.payload as { generationId?: string };
    assert.equal(freshPayload.generationId, g2.generationId);
    state = await blobRow(isolated.runtime, g1.blobId);
    assert.equal(state.logical_state, 'stored_private');
    assert.equal(state.verified_sha256, expectedDigest(body2), 'the stored facts must match the new generation bytes');
    const freshOutbox = await outboxState(isolated.runtime, fresh!.claim.outboxId);
    assert.equal(freshOutbox.state, 'completed');
  });

  test('FIX-L-045 crash window: an event claimed before the replacement converges terminal (already_replaced) on redelivery', async () => {
    const g1 = identityFor(50);
    const body1 = pngBody(17);
    const store = await seedUploaded(isolated.runtime, g1, body1);
    const repository = new PostgresOutboxRepository(isolated.runtime.pool);

    // Worker A claims g1's event and crashes after the claim (blob verifying).
    let crashA = true;
    const injectorA: VerificationFaultInjector = {
      afterClaim: async () => {
        if (crashA) {
          crashA = false;
          throw new Error('worker A crashed after claim');
        }
      },
    };
    const first = await claimAndHandle(isolated.runtime, repository, store, injectorA, new AbortController().signal);
    assert.ok(first && first.threw, 'worker A must crash after the claim');
    const aClaim = first!.claim;
    assert.equal((aClaim.payload as { generationId?: string }).generationId, g1.generationId);
    let state = await blobRow(isolated.runtime, g1.blobId);
    assert.equal(state.logical_state, 'verifying');

    // The replacement completes while the blob is verifying under A's lease:
    // the pointer moves, g1 is retired, and the blob stays verifying (the
    // stored_private demotion cannot apply to a verifying blob).
    const g2 = identityFor(51);
    const body2 = pngBody(27);
    store.seed(g2.key, body2, { etag: `"etag-${g2.generationId}"` });
    await createUnitOfWork(isolated.runtime.db).execute(({ transaction }) =>
      ports.allocate(transaction, allocateInput(g2, {
        blobId: g1.blobId,
        expectedSize: body2.byteLength,
        expectedSha256: sha256HexBytes(body2),
        mediaHint: 'image/png',
      })));
    const replaced = await completeUpload({
      ledger: ports,
      blobStore: store,
      uow: createUnitOfWork(isolated.runtime.db),
      enqueueVerification: (tx, payload) => appendAttachmentsVerificationOutbox(tx, payload),
      config: CONFIG,
    }, {
      actor: makeActor(),
      binding: { intentId: g2.intentId, generationId: g2.generationId, blobId: g1.blobId },
      declared: {
        size: body2.byteLength,
        sha256: sha256HexBytes(body2),
        mediaType: 'image/png',
        etag: `"etag-${g2.generationId}"`,
      },
    });
    assert.equal(replaced.outcome, 'completed');
    state = await blobRow(isolated.runtime, g1.blobId);
    assert.equal(state.current_generation_id, g2.generationId);

    // A's leases expire; the redelivered old event proves the replacement
    // in-transaction and completes terminal (no provider traffic). The store
    // already carries the complete-phase HEAD calls; the stale event must
    // add none.
    await expireLeases(isolated.runtime, aClaim.outboxId, g1.blobId);
    const headCallsBefore = store.headCalls.length;
    const readCallsBefore = store.readCalls.length;
    const stale = await claimAndHandle(isolated.runtime, repository, store, undefined, new AbortController().signal);
    assert.ok(stale && stale.threw === null, 'the redelivered old event must complete terminal');
    assert.equal((stale!.claim.payload as { generationId?: string }).generationId, g1.generationId);
    assert.equal(store.headCalls.length, headCallsBefore, 'no provider HEAD may run for a replaced generation');
    assert.equal(store.readCalls.length, readCallsBefore, 'no provider read may run for a replaced generation');
    const staleOutbox = await outboxState(isolated.runtime, stale!.claim.outboxId);
    assert.equal(staleOutbox.state, 'completed', 'the stale event row must complete, not dead-letter');
    state = await blobRow(isolated.runtime, g1.blobId);
    assert.equal(state.current_generation_id, g2.generationId);
    assert.equal(state.verified_sha256, null);

    // The NEW generation's own event verifies and stores its facts.
    const fresh = await claimAndHandle(isolated.runtime, repository, store, undefined, new AbortController().signal);
    assert.ok(fresh && fresh.threw === null, 'the new generation event must store');
    assert.equal((fresh!.claim.payload as { generationId?: string }).generationId, g2.generationId);
    state = await blobRow(isolated.runtime, g1.blobId);
    assert.equal(state.logical_state, 'stored_private');
    assert.equal(state.verified_sha256, expectedDigest(body2));
  });
});
