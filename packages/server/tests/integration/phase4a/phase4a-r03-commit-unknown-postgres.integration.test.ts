/**
 * P4A-R03 PostgreSQL integration suite (part 2a): the `db_commit_unknown`
 * negative control — finalize + complete-upload directions — against the
 * PRODUCTION migration (plan §6 P4A-R03, §4.3 mutation control "commit error
 * 后直接重做外部副作用").
 *
 * Proves the commit-unknown recovery contract for
 * `resolveFinalizeUnknownOutcome` at the real database boundary:
 *
 *  - committed direction: a REAL finalize commit lands and the client
 *    response is lost (`afterCommitAcknowledged` fault); the recovery
 *    RE-READS the blob/binding facts and decides `committed_same_binding`; an
 *    idempotent replay converges to the SAME single database fact;
 *  - rolled-back direction: a before-commit fault rolls back; the recovery
 *    re-reads and decides `not_committed`; a retry attaches exactly once;
 *  - a DIFFERENT binding after a committed unknown is
 *    `committed_different_binding` and a replay CONFLICTS — the recovery
 *    never blindly re-attaches a different Attachment;
 *  - complete-upload unknown re-reads intent/blob/generation through the
 *    production ports and converges idempotently with ONE outbox row and the
 *    SAME committed generation key (no second PUT, no key re-sign).
 *
 * Anti-false-positive: catching the commit exception and asserting "no
 * throw" is NOT enough — every direction asserts the re-read decision AND
 * the final unique database fact.
 */
import assert from 'node:assert/strict';
import { sql } from 'kysely';
import { afterAll, beforeAll, test } from 'vitest';
import { DatabaseOperationError, createPostgresAttachmentsPorts, createUnitOfWork } from '../../../src/infrastructure/database/index.js';
import {
  PostgresOutboxRepository,
  appendAttachmentsVerificationOutbox,
  createAttachmentsVerificationOutboxRoute,
  type ClosedPayload,
  type OutboxClaim,
  type VersionedEventEnvelope,
} from '../../../src/infrastructure/outbox/index.js';
import {
  completeUpload,
  resolveFinalizeUnknownOutcome,
  type BlobLogicalState,
  type CompleteUploadDeps,
  type FinalizeBindingFacts,
  type FinalizeHandoffInput,
} from '../../../src/modules/attachments/index.js';
import type { DatabaseTransaction } from '../../../src/infrastructure/database/index.js';
import { describeWithPostgres } from '../../support/postgres-test-runtime.js';
import {
  createI07MigrationRuntime,
  type I07MigrationRuntime,
} from '../../support/phase4a-i07-test-helpers.js';
import {
  I09_COLLECTION,
  I09_SUBJECT,
  InMemoryVerificationObjectStore,
  allocateInput,
  identityFor,
  makeActor,
  makeI09Config,
  sha256HexBytes,
  type I09Identity,
} from '../../support/phase4a-i09-test-helpers.js';

const CONFIG = makeI09Config();
const ports = createPostgresAttachmentsPorts();

function pngBody(bytes: number): Uint8Array {
  const body = new Uint8Array(bytes);
  body.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  for (let index = 8; index < body.length; index += 1) body[index] = index % 251;
  return body;
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
 * Seeds a blob in `stored_private` through production ports: allocate ->
 * complete (+ verification outbox in the same commit) -> production worker
 * route claim/handle/complete with the exact bytes.
 */
async function seedStoredPrivate(
  runtime: I07MigrationRuntime['runtime'],
  id: I09Identity,
  body: Uint8Array,
): Promise<InMemoryVerificationObjectStore> {
  await seedAllocated(runtime, id, body);
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
  const repository = new PostgresOutboxRepository(runtime.pool);
  const claim = await repository.claim(5_000);
  assert.ok(claim, 'the verification outbox row must be claimable');
  const route = createAttachmentsVerificationOutboxRoute({
    repository: ports,
    blobStore: store,
    uow: createUnitOfWork(runtime.db),
    config: CONFIG,
  });
  await route.handle({
    envelope: envelopeFromClaim(claim),
    idempotencyKey: claim.eventId,
    signal: new AbortController().signal,
    attempt: { outboxId: claim.outboxId, leaseGeneration: claim.leaseGeneration },
  });
  const completed = await repository.complete(claim);
  assert.ok(completed, 'the verification outbox row must complete');
  const rows = await sql<{ logical_state: string }>`
    select logical_state from blob_records where blob_id = ${id.blobId}
  `.execute(runtime.db);
  assert.equal(rows.rows[0]!.logical_state, 'stored_private');
  return store;
}

function handoffFor(id: I09Identity, body: Uint8Array, bindingId: string): FinalizeHandoffInput {
  return {
    blobId: id.blobId,
    attachmentBindingId: bindingId,
    expectedGenerationId: id.generationId,
    ownerSubjectId: I09_SUBJECT,
    expectedEtag: `"etag-${id.generationId}"`,
    verifiedSize: body.byteLength,
    verifiedSha256: sha256HexBytes(body),
    mediaType: 'image/png',
    policyRevision: 'phase4a-i09-policy-v1',
  };
}

type ReReadFinalizeState =
  | { outcome: 'attached'; binding: FinalizeBindingFacts }
  | { outcome: 'stored_private' }
  | { outcome: 'not_found' }
  | { outcome: 'other'; logicalState: BlobLogicalState };

async function reReadBinding(runtime: I07MigrationRuntime['runtime'], blobId: string): Promise<ReReadFinalizeState> {
  const rows = await sql<{
    logical_state: string;
    attachment_binding_id: string | null;
    attached_at: Date | null;
    attachment_binding_generation_id: string | null;
    attachment_binding_etag: string | null;
    attachment_binding_policy_version: string | null;
  }>`
    select logical_state, attachment_binding_id, attached_at, attachment_binding_generation_id,
           attachment_binding_etag, attachment_binding_policy_version
    from blob_records where blob_id = ${blobId}
  `.execute(runtime.db);
  if (rows.rows.length === 0) return { outcome: 'not_found' };
  const row = rows.rows[0]!;
  if (row.logical_state === 'attached_private' && row.attachment_binding_id !== null
    && row.attached_at !== null && row.attachment_binding_generation_id !== null
    && row.attachment_binding_etag !== null && row.attachment_binding_policy_version !== null) {
    return {
      outcome: 'attached',
      binding: {
        blobId,
        attachmentBindingId: row.attachment_binding_id,
        generationId: row.attachment_binding_generation_id,
        etag: row.attachment_binding_etag,
        policyVersion: row.attachment_binding_policy_version,
        attachedAt: new Date(row.attached_at),
      },
    };
  }
  if (row.logical_state === 'stored_private') return { outcome: 'stored_private' };
  return { outcome: 'other', logicalState: row.logical_state as BlobLogicalState };
}

async function outboxCount(runtime: I07MigrationRuntime['runtime'], blobId: string): Promise<number> {
  const rows = await sql<{ count: string }>`
    select count(*)::text as count from outbox_events
    where handler_name = 'attachments_verify_generation' and aggregate_id = ${blobId}
  `.execute(runtime.db);
  return Number(rows.rows[0]!.count);
}

describeWithPostgres('P4A-R03 db commit unknown (finalize + complete)', () => {
  let isolated: I07MigrationRuntime;

  beforeAll(async () => {
    isolated = await createI07MigrationRuntime('r03_commit_unknown_finalize', { maxConnections: 16 });
  });

  afterAll(async () => {
    await isolated?.dropSchema();
  });

  test('finalize committed direction: a lost commit response re-reads the DB and converges idempotent to the SAME binding', async () => {
    const id = identityFor(10);
    const body = pngBody(23);
    await seedStoredPrivate(isolated.runtime, id, body);
    const bindingId = `r03-binding-committed-${id.generationId}`;
    const handoff = handoffFor(id, body, bindingId);
    let ackLost = false;
    const uow = createUnitOfWork(isolated.runtime.db, {
      faultInjector: {
        afterCommitAcknowledged: async () => {
          if (ackLost) return;
          const rows = await isolated.runtime.pool.query<{ logical_state: string }>(
            'select logical_state from blob_records where blob_id = $1',
            [id.blobId],
          );
          if (rows.rows[0]?.logical_state === 'attached_private') {
            ackLost = true;
            throw new Error('simulated lost finalize commit acknowledgement');
          }
        },
      },
    });
    await assert.rejects(
      uow.execute(({ transaction }) => ports.finalizeHandoff(transaction, handoff)),
      (error: unknown) => error instanceof DatabaseOperationError && error.kind === 'commit_outcome_unknown',
    );
    assert.equal(ackLost, true, 'the commit must have landed before the response was lost');

    // Unknown recovery: RE-READ the binding, then decide — never a blind redo.
    const reRead = await reReadBinding(isolated.runtime, id.blobId);
    const decision = resolveFinalizeUnknownOutcome({ attemptedBindingId: bindingId, reRead });
    if (decision.decision !== 'committed_same_binding') assert.fail(`expected committed_same_binding, got ${decision.decision}`);
    assert.equal(decision.binding.attachmentBindingId, bindingId);

    // Idempotent replay returns the SAME committed binding.
    const replay = await createUnitOfWork(isolated.runtime.db).execute(({ transaction }) =>
      ports.finalizeHandoff(transaction, handoff));
    assert.equal(replay.outcome, 'idempotent');
    if (replay.outcome !== 'idempotent') return;
    assert.equal(replay.binding.attachmentBindingId, bindingId);

    // The database holds exactly ONE binding fact.
    const rows = await sql<{ logical_state: string; attachment_binding_id: string | null }>`
      select logical_state, attachment_binding_id from blob_records where blob_id = ${id.blobId}
    `.execute(isolated.runtime.db);
    assert.equal(rows.rows.length, 1);
    assert.equal(rows.rows[0]!.logical_state, 'attached_private');
    assert.equal(rows.rows[0]!.attachment_binding_id, bindingId);
  });

  test('finalize rolled-back direction: a before-commit fault rolls back; recovery decides not_committed and a retry attaches once', async () => {
    const id = identityFor(11);
    const body = pngBody(24);
    await seedStoredPrivate(isolated.runtime, id, body);
    const bindingId = `r03-binding-rolled-back-${id.generationId}`;
    const handoff = handoffFor(id, body, bindingId);
    let beforeCommitFault = true;
    const uow = createUnitOfWork(isolated.runtime.db, {
      faultInjector: {
        afterCallbackBeforeCommit: async () => {
          if (beforeCommitFault) {
            beforeCommitFault = false;
            throw new Error('simulated before-commit finalize fault');
          }
        },
      },
    });
    await assert.rejects(
      uow.execute(({ transaction }) => ports.finalizeHandoff(transaction, handoff)),
      /simulated before-commit finalize fault/,
    );

    // Unknown recovery: the DB was NOT modified — re-read says stored_private.
    const reRead = await reReadBinding(isolated.runtime, id.blobId);
    assert.deepEqual(reRead, { outcome: 'stored_private' });
    const decision = resolveFinalizeUnknownOutcome({ attemptedBindingId: bindingId, reRead });
    assert.equal(decision.decision, 'not_committed');

    // A safe retry attaches exactly once.
    const retry = await createUnitOfWork(isolated.runtime.db).execute(({ transaction }) =>
      ports.finalizeHandoff(transaction, handoff));
    assert.equal(retry.outcome, 'attached');
    const rows = await sql<{ logical_state: string; attachment_binding_id: string | null }>`
      select logical_state, attachment_binding_id from blob_records where blob_id = ${id.blobId}
    `.execute(isolated.runtime.db);
    assert.equal(rows.rows.length, 1);
    assert.equal(rows.rows[0]!.logical_state, 'attached_private');
    assert.equal(rows.rows[0]!.attachment_binding_id, bindingId);
  });

  test('a DIFFERENT binding after a committed unknown is reported and CONFLICTS on replay — never a blind redo', async () => {
    const id = identityFor(12);
    const body = pngBody(25);
    await seedStoredPrivate(isolated.runtime, id, body);
    const committedBinding = `r03-binding-x-${id.generationId}`;
    const otherBinding = `r03-binding-y-${id.generationId}`;
    let ackLost = false;
    const uow = createUnitOfWork(isolated.runtime.db, {
      faultInjector: {
        afterCommitAcknowledged: async () => {
          if (ackLost) return;
          const rows = await isolated.runtime.pool.query<{ logical_state: string }>(
            'select logical_state from blob_records where blob_id = $1',
            [id.blobId],
          );
          if (rows.rows[0]?.logical_state === 'attached_private') {
            ackLost = true;
            throw new Error('simulated lost finalize commit acknowledgement');
          }
        },
      },
    });
    await assert.rejects(
      uow.execute(({ transaction }) => ports.finalizeHandoff(transaction, handoffFor(id, body, committedBinding))),
      (error: unknown) => error instanceof DatabaseOperationError && error.kind === 'commit_outcome_unknown',
    );

    // The recovery attempt for a DIFFERENT binding must surface the committed
    // binding instead of redoing it.
    const reRead = await reReadBinding(isolated.runtime, id.blobId);
    const decision = resolveFinalizeUnknownOutcome({ attemptedBindingId: otherBinding, reRead });
    if (decision.decision !== 'committed_different_binding') {
      assert.fail(`expected committed_different_binding, got ${decision.decision}`);
    }
    assert.equal(decision.existingBindingId, committedBinding);

    // A replay with the different binding conflicts; the committed binding stays.
    const conflict = await createUnitOfWork(isolated.runtime.db).execute(({ transaction }) =>
      ports.finalizeHandoff(transaction, handoffFor(id, body, otherBinding)));
    assert.equal(conflict.outcome, 'binding_conflict');
    const rows = await sql<{ attachment_binding_id: string | null }>`
      select attachment_binding_id from blob_records where blob_id = ${id.blobId}
    `.execute(isolated.runtime.db);
    assert.equal(rows.rows[0]!.attachment_binding_id, committedBinding, 'the committed binding must never be overwritten');
  });

  test('complete-upload unknown re-reads intent/blob/generation and converges idempotently with ONE outbox row and the SAME key', async () => {
    const id = identityFor(15);
    const body = pngBody(26);
    await seedAllocated(isolated.runtime, id, body);
    const store = new InMemoryVerificationObjectStore();
    store.seed(id.key, body, { etag: `"etag-${id.generationId}"` });
    const completeInput = {
      actor: makeActor(),
      binding: { intentId: id.intentId, generationId: id.generationId, blobId: id.blobId },
      declared: {
        size: body.byteLength,
        sha256: sha256HexBytes(body),
        mediaType: 'image/png',
        etag: `"etag-${id.generationId}"`,
      },
    };
    let lost = true;
    const uow = createUnitOfWork(isolated.runtime.db, {
      faultInjector: {
        afterCommitAcknowledged: async () => {
          if (!lost) return;
          const rows = await isolated.runtime.pool.query<{ logical_state: string }>(
            'select logical_state from blob_records where blob_id = $1',
            [id.blobId],
          );
          if (rows.rows[0]?.logical_state === 'uploaded') {
            lost = false;
            throw new Error('simulated lost complete commit acknowledgement');
          }
        },
      },
    });
    await assert.rejects(
      completeUpload({
        ledger: ports,
        blobStore: store,
        uow,
        enqueueVerification: async (tx, payload) => {
          await appendAttachmentsVerificationOutbox(tx, payload);
        },
        config: CONFIG,
      }, completeInput),
      /commit outcome is unknown/,
    );
    const blob = await sql<{ logical_state: string }>`
      select logical_state from blob_records where blob_id = ${id.blobId}
    `.execute(isolated.runtime.db);
    assert.equal(blob.rows[0]!.logical_state, 'uploaded', 'the commit actually landed');
    assert.equal(await outboxCount(isolated.runtime, id.blobId), 1);

    // Unknown recovery: re-read the intent/blob/generation through production
    // ports — the committed generation and key are the ONLY facts.
    const intent = await createUnitOfWork(isolated.runtime.db).execute(({ transaction }) =>
      ports.findIntentByBinding(transaction, {
        collectionId: I09_COLLECTION,
        subjectIdentity: I09_SUBJECT,
        idempotencyKey: `idem-${id.intentId}`,
      }));
    assert.equal(intent.outcome, 'found');
    if (intent.outcome !== 'found') return;
    assert.equal(intent.intent.generationId, id.generationId);
    assert.equal(intent.intent.key, id.key, 'the committed key is the ONLY key — never re-signed');
    const target = await createUnitOfWork(isolated.runtime.db).execute(({ transaction }) =>
      ports.findCompleteTarget(transaction, {
        intentId: id.intentId,
        generationId: id.generationId,
        blobId: id.blobId,
      }));
    assert.equal(target.outcome, 'found');

    // The safe retry converges idempotently: same generation, same key, one
    // outbox row, no second PUT.
    const retry = await completeUpload({
      ledger: ports,
      blobStore: store,
      uow: createUnitOfWork(isolated.runtime.db),
      enqueueVerification: async (tx, payload) => {
        await appendAttachmentsVerificationOutbox(tx, payload);
      },
      config: CONFIG,
    }, completeInput);
    assert.equal(retry.outcome, 'idempotent');
    assert.equal(await outboxCount(isolated.runtime, id.blobId), 1, 'recovery must not duplicate the outbox row');
    const keys = await sql<{ count: string }>`
      select count(*)::text as count from generation_keys where generation_id = ${id.generationId}
    `.execute(isolated.runtime.db);
    assert.equal(Number(keys.rows[0]!.count), 1);
  });
});
