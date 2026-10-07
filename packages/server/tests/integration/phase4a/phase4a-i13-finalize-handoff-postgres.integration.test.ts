/**
 * P4A-I13 PostgreSQL integration suite (handoff semantics): the transaction-
 * bound finalize handoff against the PRODUCTION migration with real
 * PostgreSQL.
 *
 * Proves with ONE real transaction per call (never a mock transaction):
 * - a successful handoff writes the unique future Attachment binding facts
 *   and `stored_private -> attached_private` atomically, fences the CURRENT
 *   generation, and creates NO production Attachment/Operation/Audit/Outbox
 *   row (the future Canonical Mutation owns those);
 * - a commit fault rolls back the whole handoff: the blob stays
 *   `stored_private` with no binding (no half-commit), and a re-read decides
 *   `not_committed` so the SAME input retries and converges;
 * - the full input verification matrix (wrong generation/ETag/verified
 *   size/digest/media, expired retention deadline, revoked policy, owner
 *   mismatch, non-stored logical states) rejects WITHOUT writing anything;
 * - after a committed handoff the cleanup candidate query can never claim the
 *   attached/current generation;
 * - same-binding replay returns the committed result (idempotent), a
 *   different binding conflicts and never rebinds;
 * - a process restart (pool closed, schema kept, runtime reopened) preserves a
 *   committed binding and leaves unbound blobs untouched, and same-binding
 *   replay still returns the committed result after restart.
 */
import assert from 'node:assert/strict';
import { sql } from 'kysely';
import { afterAll, beforeAll, test } from 'vitest';
import { createDatabaseRuntime, createPostgresAttachmentsPorts, createUnitOfWork } from '../../../src/infrastructure/database/index.js';
import {
  resolveFinalizeUnknownOutcome,
} from '../../../src/modules/attachments/index.js';
import { describeWithPostgres } from '../../support/postgres-test-runtime.js';
import {
  I13_MEDIA_TYPE,
  I13_POLICY_VERSION,
  i13HandoffInput,
  finalizeHandoffInTx,
  identityFor,
  readBlobBinding,
  seedObservedReplacement,
  seedStoredPrivate,
} from '../../support/phase4a-i13-test-helpers.js';
import {
  createI07MigrationRuntime,
  type I07MigrationRuntime,
} from '../../support/phase4a-i07-test-helpers.js';

const ports = createPostgresAttachmentsPorts();

async function assertCleanupCandidatesEmpty(runtime: I07MigrationRuntime['runtime'], blobId: string): Promise<void> {
  const rows = await sql<{ count: string }>`
    select count(*)::text as count
    from blob_generations bg
    join blob_records br on br.blob_id = bg.blob_id
    where bg.generation_state in ('retired', 'orphaned', 'deletion_pending')
      and br.current_generation_id is distinct from bg.generation_id
      and br.blob_id = ${blobId}
  `.execute(runtime.db);
  assert.equal(Number(rows.rows[0]!.count), 0, 'cleanup must never claim the attached/current generation');
}

async function assertNoPrematureRows(runtime: I07MigrationRuntime['runtime'], bindingId: string): Promise<void> {
  const operations = await sql<{ count: string }>`
    select count(*)::text as count from operations where operation_id = ${bindingId}
  `.execute(runtime.db);
  assert.equal(Number(operations.rows[0]!.count), 0, 'the handoff must not create a production Operation');
  const audit = await sql<{ count: string }>`
    select count(*)::text as count from audit_events where operation_id = ${bindingId}
  `.execute(runtime.db);
  assert.equal(Number(audit.rows[0]!.count), 0, 'the handoff must not create an Audit row');
  const ledger = await sql<{ count: string }>`
    select count(*)::text as count from resource_id_ledger where resource_id = ${bindingId}
  `.execute(runtime.db);
  assert.equal(Number(ledger.rows[0]!.count), 0, 'the handoff must not reserve the Attachment id in the ID ledger');
  const outbox = await sql<{ count: string }>`
    select count(*)::text as count from outbox_events
    where payload_json::text like ${`%${bindingId}%`}
  `.execute(runtime.db);
  assert.equal(Number(outbox.rows[0]!.count), 0, 'the handoff must not enqueue an Outbox event');
  const attachmentsTable = await sql<{ present: boolean }>`
    select to_regclass(current_schema() || '.attachments') is not null as present
  `.execute(runtime.db);
  assert.equal(attachmentsTable.rows[0]!.present, true, 'P4A-P02 production Attachment schema must exist at latest');
  const attachmentRows = await sql<{ count: string }>`
    select count(*)::text as count from attachments where attachment_id = ${bindingId}
  `.execute(runtime.db);
  assert.equal(Number(attachmentRows.rows[0]!.count), 0, 'the handoff must not create a production Attachment row');
}

describeWithPostgres('P4A-I13 transaction-bound finalize handoff', () => {
  let isolated: I07MigrationRuntime;

  beforeAll(async () => {
    isolated = await createI07MigrationRuntime('i13_handoff', { maxConnections: 12 });
  }, 120_000);

  afterAll(async () => {
    await isolated?.dropSchema();
  });

  test('success: exactly one committed binding fenced to the current generation, no premature Attachment/Operation', async () => {
    const id = identityFor(1);
    const { body, digest } = await seedStoredPrivate(isolated.runtime, id);
    const bindingId = `i13-success-binding-${id.generationId}`;
    const result = await finalizeHandoffInTx(isolated.runtime, i13HandoffInput(id, { attachmentBindingId: bindingId }));
    assert.equal(result.outcome, 'attached');
    if (result.outcome !== 'attached') return;
    assert.equal(result.binding.blobId, id.blobId);
    assert.equal(result.binding.attachmentBindingId, bindingId);
    assert.equal(result.binding.generationId, id.generationId, 'the binding must be fenced to the current generation');
    assert.equal(result.binding.etag, `"etag-${id.generationId}"`);
    assert.equal(result.binding.policyVersion, I13_POLICY_VERSION);
    assert.ok(result.binding.attachedAt instanceof Date);

    const row = await readBlobBinding(isolated.runtime, id.blobId);
    assert.ok(row);
    assert.equal(row.logicalState, 'attached_private');
    assert.equal(row.attachmentBindingId, bindingId);
    assert.equal(row.attachmentBindingGenerationId, id.generationId);
    assert.equal(row.attachmentBindingEtag, `"etag-${id.generationId}"`);
    assert.equal(row.attachmentBindingPolicyVersion, I13_POLICY_VERSION);
    assert.ok(row.attachedAt);
    assert.equal(row.verifiedSize, body.byteLength);
    assert.equal(row.verifiedSha256, digest, 'verified digest preserved');
    assert.equal(row.mediaType, I13_MEDIA_TYPE);
    await assertCleanupCandidatesEmpty(isolated.runtime, id.blobId);
    await assertNoPrematureRows(isolated.runtime, bindingId);
  });

  test('rollback: a commit fault leaves the blob stored_private with NO binding, then the SAME input retries and converges', async () => {
    const id = identityFor(2);
    await seedStoredPrivate(isolated.runtime, id);
    const bindingId = `i13-rollback-binding-${id.generationId}`;
    const faultUow = createUnitOfWork(isolated.runtime.db, {
      faultInjector: {
        afterCallbackBeforeCommit: async () => {
          throw new Error('simulated crash before commit');
        },
      },
    });
    await assert.rejects(
      faultUow.execute(({ transaction }) => ports.finalizeHandoff(transaction, i13HandoffInput(id, { attachmentBindingId: bindingId }))),
      /simulated crash before commit/,
    );
    const row = await readBlobBinding(isolated.runtime, id.blobId);
    assert.ok(row);
    assert.equal(row.logicalState, 'stored_private', 'rollback must leave the blob stored_private');
    assert.equal(row.attachmentBindingId, null, 'rollback must leave NO binding');
    assert.equal(row.attachedAt, null);
    assert.equal(row.attachmentBindingGenerationId, null);
    // Commit-unknown style re-read decides `not_committed` -> safe to retry the
    // SAME input (never redo a different Attachment).
    const decision = resolveFinalizeUnknownOutcome({ attemptedBindingId: bindingId, reRead: { outcome: 'stored_private' } });
    assert.deepEqual(decision, { decision: 'not_committed' });
    const retried = await finalizeHandoffInTx(isolated.runtime, i13HandoffInput(id, { attachmentBindingId: bindingId }));
    assert.equal(retried.outcome, 'attached');
    const after = await readBlobBinding(isolated.runtime, id.blobId);
    assert.ok(after);
    assert.equal(after.logicalState, 'attached_private');
    assert.equal(after.attachmentBindingId, bindingId);
    await assertCleanupCandidatesEmpty(isolated.runtime, id.blobId);
  });

  test('input verification matrix rejects without writing anything', async () => {
    const good = identityFor(3);
    await seedStoredPrivate(isolated.runtime, good);
    const cases: Array<{ label: string; input: ReturnType<typeof i13HandoffInput>; expected: string }> = [
      { label: 'wrong generation', input: i13HandoffInput(good, { expectedGenerationId: 'gen-other' }), expected: 'generation_mismatch' },
      { label: 'wrong ETag', input: i13HandoffInput(good, { expectedEtag: '"etag-other"' }), expected: 'etag_mismatch' },
      { label: 'wrong size', input: i13HandoffInput(good, { verifiedSize: 999_999 }), expected: 'verified_facts_mismatch' },
      { label: 'wrong digest', input: i13HandoffInput(good, { verifiedSha256: 'b'.repeat(64) }), expected: 'verified_facts_mismatch' },
      { label: 'wrong media', input: i13HandoffInput(good, { mediaType: 'application/pdf' }), expected: 'verified_facts_mismatch' },
      { label: 'revoked policy', input: i13HandoffInput(good, { policyRevision: 'i13-policy-v2' }), expected: 'policy_mismatch' },
      { label: 'wrong owner', input: i13HandoffInput(good, { ownerSubjectId: 'other-owner' }), expected: 'owner_mismatch' },
    ];
    for (const { label, input, expected } of cases) {
      const result = await finalizeHandoffInTx(isolated.runtime, input);
      assert.equal(result.outcome, expected, label);
    }
    const row = await readBlobBinding(isolated.runtime, good.blobId);
    assert.ok(row);
    assert.equal(row.logicalState, 'stored_private');
    assert.equal(row.attachmentBindingId, null, 'every rejected matrix input must leave no binding');

    const expired = identityFor(4);
    await seedStoredPrivate(isolated.runtime, expired, { retentionExpired: true });
    const expiredResult = await finalizeHandoffInTx(isolated.runtime, i13HandoffInput(expired));
    assert.equal(expiredResult.outcome, 'expired', 'a blob past its retention deadline is rejected as expired');

    const expiredState = identityFor(5);
    await seedStoredPrivate(isolated.runtime, expiredState);
    await isolated.runtime.pool.query(
      `update blob_records set logical_state = 'expired', updated_at = now() where blob_id = $1`,
      [expiredState.blobId],
    );
    const stateResult = await finalizeHandoffInTx(isolated.runtime, i13HandoffInput(expiredState));
    assert.equal(stateResult.outcome, 'not_finalizable', 'a logically expired blob is not finalizable');

    const nonStored = identityFor(6);
    await seedStoredPrivate(isolated.runtime, nonStored);
    await isolated.runtime.pool.query(
      `update blob_records set logical_state = 'uploaded', updated_at = now() where blob_id = $1`,
      [nonStored.blobId],
    );
    const nonStoredResult = await finalizeHandoffInTx(isolated.runtime, i13HandoffInput(nonStored));
    assert.equal(nonStoredResult.outcome, 'not_finalizable', 'a non-stored logical state is not finalizable');
  });

  test('same-binding replay returns the committed result; a different binding conflicts and never rebinds', async () => {
    const id = identityFor(7);
    await seedStoredPrivate(isolated.runtime, id);
    const bindingA = `i13-replay-binding-${id.generationId}`;
    const bindingB = `i13-other-binding-${id.generationId}`;
    const first = await finalizeHandoffInTx(isolated.runtime, i13HandoffInput(id, { attachmentBindingId: bindingA }));
    assert.equal(first.outcome, 'attached');
    const replay = await finalizeHandoffInTx(isolated.runtime, i13HandoffInput(id, { attachmentBindingId: bindingA }));
    assert.equal(replay.outcome, 'idempotent', 'same-binding replay returns the committed result');
    if (replay.outcome === 'idempotent') {
      assert.equal(replay.binding.attachmentBindingId, bindingA);
      assert.equal(replay.binding.attachedAt.getTime(), first.outcome === 'attached' ? first.binding.attachedAt.getTime() : replay.binding.attachedAt.getTime());
    }
    const conflict = await finalizeHandoffInTx(isolated.runtime, i13HandoffInput(id, { attachmentBindingId: bindingB }));
    assert.equal(conflict.outcome, 'binding_conflict');
    if (conflict.outcome === 'binding_conflict') {
      assert.equal(conflict.existingBindingId, bindingA, 'the committed binding is returned, never rebound');
    }
    const row = await readBlobBinding(isolated.runtime, id.blobId);
    assert.ok(row);
    assert.equal(row.attachmentBindingId, bindingA, 'the committed binding survives replay and conflict');
  });

  test('replacement before finalize: the handoff rejects with generation_mismatch and the caller re-reads without binding', async () => {
    const original = identityFor(8);
    const replacement = identityFor(80);
    await seedStoredPrivate(isolated.runtime, original);
    await seedObservedReplacement(isolated.runtime, original, replacement);
    const activated = await createUnitOfWork(isolated.runtime.db).execute(({ transaction }) =>
      ports.activateReplacement(transaction, {
        blobId: original.blobId,
        expectedActiveGenerationId: original.generationId,
        newGenerationId: replacement.generationId,
      }));
    assert.equal(activated.outcome, 'activated');

    const handoff = await finalizeHandoffInTx(isolated.runtime, i13HandoffInput(original));
    // P4A-P07: activating a replacement demotes a stored_private blob back to
    // `uploaded` (verified facts cleared) so the new current generation is
    // re-verified before any finalize can consume it. The handoff therefore
    // rejects as not_finalizable and the caller re-reads without binding.
    assert.equal(handoff.outcome, 'not_finalizable');
    const row = await readBlobBinding(isolated.runtime, original.blobId);
    assert.ok(row);
    assert.equal(row.logicalState, 'uploaded', 'the moved pointer demotes the blob for re-verification');
    assert.equal(row.attachmentBindingId, null);
    assert.equal(row.currentGenerationId, replacement.generationId);
  });

  test('process restart: a committed binding survives; an unbound blob stays unbound; replay still returns the committed result', async () => {
    const committedId = identityFor(9);
    const unboundId = identityFor(10);
    await seedStoredPrivate(isolated.runtime, committedId);
    await seedStoredPrivate(isolated.runtime, unboundId);
    const bindingId = `i13-restart-binding-${committedId.generationId}`;
    const committed = await finalizeHandoffInTx(isolated.runtime, i13HandoffInput(committedId, { attachmentBindingId: bindingId }));
    assert.equal(committed.outcome, 'attached');

    // Simulate a process exit: close the pool but keep the schema.
    await isolated.closeKeepSchema();
    const restarted = createDatabaseRuntime(isolated.databaseUrl, {
      maxConnections: 6,
      applicationName: 'known-i13-restart',
      connectionTimeoutMs: 5_000,
      idleTimeoutMs: 1_000,
      statementTimeoutMs: 30_000,
    });
    try {
      const committedRow = await readBlobBinding(restarted, committedId.blobId);
      assert.ok(committedRow);
      assert.equal(committedRow.logicalState, 'attached_private');
      assert.equal(committedRow.attachmentBindingId, bindingId, 'the committed binding survives restart');
      assert.equal(committedRow.attachmentBindingGenerationId, committedId.generationId);

      const unboundRow = await readBlobBinding(restarted, unboundId.blobId);
      assert.ok(unboundRow);
      assert.equal(unboundRow.logicalState, 'stored_private', 'an unbound blob stays unbound across restart');
      assert.equal(unboundRow.attachmentBindingId, null);

      const replay = await finalizeHandoffInTx(restarted, i13HandoffInput(committedId, { attachmentBindingId: bindingId }));
      assert.equal(replay.outcome, 'idempotent', 'same-binding replay returns the committed result after restart');
    } finally {
      await restarted.close();
    }
  });
});