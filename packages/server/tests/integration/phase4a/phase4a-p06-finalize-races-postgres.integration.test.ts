/**
 * P4A-P06 focused PostgreSQL suite (part 2): finalize races, rollback,
 * commit-unknown, deadlock contract and the frozen rejection matrix over the
 * production HTTP route.
 *
 * Every concurrency claim uses INDEPENDENT app requests (real HTTP inject)
 * against the PRODUCTION app composition with deterministic barrier seams —
 * never a short timeout misreported as safety:
 * - concurrent finalizers with the SAME Known-Command-Id both succeed
 *   (finalized + already_finalized) with exactly ONE committed side-effect
 *   set (anti-false-positive: two independent transactions or a second
 *   attachment row can never satisfy these assertions);
 * - concurrent finalizers with DIFFERENT command ids: one winner commits, the
 *   loser gets the stable 409 attachment_state_conflict and the committed
 *   binding never changes (anti-false-negative: only a different binding is a
 *   conflict — the loser's retry stays 409 by contract);
 * - a REAL row-lock wait: the second request parks on the Collection lock
 *   while the winner is mid-transaction and converges to the deterministic
 *   outcome after the winner commits (lock retries are never judged failed on
 *   the first wait);
 * - rollback: a canonical write fault aborts the WHOLE transaction — zero
 *   half-commit across Attachment, blob binding, Operation/Audit/Outbox,
 *   ledger and collection ordinal — and the retry converges;
 * - commit unknown (committed direction): after a lost commit acknowledgement
 *   the route re-reads the receipt and binding and returns the committed
 *   receipt; commit unknown (rolled-back direction): zero half-commit and the
 *   retry converges;
 * - deadlock/serialization failures map to the stable retryable 503
 *   (rate_limit_unavailable, no Retry-After) and the retry converges (the
 *   real 40P01 deadlock -> retryable classification is pinned by the P02 race
 *   suite against the same production assembly);
 * - the frozen canonical-outcome -> HTTP mapping matrix covers every
 *   rejection class (wrong intent/generation/digest/policy/etag, expiry,
 *   binding conflict, concealment, inconsistency).
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, test } from 'vitest';
import { createI07MigrationRuntime, type I07MigrationRuntime } from '../../support/phase4a-i07-test-helpers.js';
import {
  createIdentityMemoryState,
  createIdentityMemoryUnitOfWork,
  issueTestSession,
  type AuthenticatedTestClient,
} from '../../support/product-http-harness.js';
import { createInMemoryBetterAuthTestFactory } from '../../support/better-auth-test-factory.js';
import {
  buildP03App,
  makeP03Config,
  type P03FinalizeSeams,
} from '../../support/phase4a-p03-test-helpers.js';
import {
  readAttachmentRow,
  readFinalizeSideEffects,
  readP02CollectionRow,
} from '../../support/phase4a-p02-test-helpers.js';
import { describeWithPostgres } from '../../support/postgres-test-runtime.js';
import { identityFor, BarrierGroup } from '../../support/phase4a-i07-test-helpers.js';
import { waitForCondition } from '../../support/async-test-helpers.js';
import {
  P06_COLLECTION_A,
  expectedP06AttachmentId,
  finalizeHeaders,
  p06BlobOwnerOf,
  p06FinalizeOperationCount,
  readP06FinalizeOperationByCommandId,
  seedP06Collection,
  seedP06StoredPrivate,
} from '../../support/phase4a-p06-test-helpers.js';
import type { FinalizeAttachmentResult } from '../../../src/modules/attachments/index.js';

const NOW = new Date('2026-08-08T12:00:00.000Z');
const CONFIG = makeP03Config();

interface FinalizeResultBody {
  kind: 'finalized' | 'already_finalized';
  blobId: string;
  logicalState: string;
}

interface FinalizeProblem {
  error: {
    code: string;
    message: string;
    requestId: string;
    recovery: string;
    sameRequestRetrySafe: boolean;
    precondition: unknown;
    currentEtag: unknown;
    retryAfterSeconds: unknown;
    fieldErrors: Array<{ path: string; code: string; message: string }>;
  };
}

function finalizeUrl(blobId: string): string {
  return `/api/v1/attachments/${encodeURIComponent(blobId)}/finalize`;
}

function finalizeInject(bundle: ReturnType<typeof buildP03App>, client: AuthenticatedTestClient, blobId: string, commandId: string) {
  return bundle.app.inject({
    method: 'POST',
    url: finalizeUrl(blobId),
    headers: finalizeHeaders(client, commandId),
    payload: '{}',
  });
}

async function committedSet(
  runtime: I07MigrationRuntime['runtime'],
  blobId: string,
  attachmentId: string,
  operationId: string,
) {
  const effects = await readFinalizeSideEffects(runtime, blobId, attachmentId, operationId);
  return {
    attachments: effects.attachments.length,
    operations: effects.operations.length,
    audits: effects.audits.length,
    outbox: effects.outbox.length,
    binding: effects.blob?.attachmentBindingId,
    ordinal: effects.collection?.commitOrdinal,
  };
}

describeWithPostgres('P4A-P06 production finalize races and recovery', () => {
  let isolated: I07MigrationRuntime;
  let identityUnitOfWork: ReturnType<typeof createIdentityMemoryUnitOfWork>;
  let factory: ReturnType<typeof createInMemoryBetterAuthTestFactory>;
  let owner: AuthenticatedTestClient;

  beforeAll(async () => {
    isolated = await createI07MigrationRuntime('phase4a_p06_races', { maxConnections: 14 });
    identityUnitOfWork = createIdentityMemoryUnitOfWork(createIdentityMemoryState(NOW));
    factory = createInMemoryBetterAuthTestFactory({ identityUnitOfWork });
    owner = await issueTestSession({
      factory,
      subject: 'p06-owner', handle: 'p06_owner' });
    await seedP06Collection(isolated.runtime, {
      collectionId: P06_COLLECTION_A,
      ownerSubjectId: owner.subjectId,
      members: [{ subjectId: owner.subjectId, role: 'owner' }],
    });
  }, 120_000);

  afterAll(async () => {
    await isolated?.dropSchema();
  });

  function newApp(seams?: P03FinalizeSeams) {
    return buildP03App({
      runtime: isolated.runtime,
      databaseUrl: isolated.databaseUrl,
      identityUnitOfWork,
      browserSessionAuthority: factory.authority,
      objectServerUrl: 'http://127.0.0.1:1',
      attachmentsConfig: CONFIG,
      ...(seams === undefined ? {} : { finalizeSeams: seams }),
    });
  }

  test('concurrent finalizers with the SAME Known-Command-Id both succeed with exactly ONE committed side-effect set', async () => {
    const id = identityFor(400);
    await seedP06StoredPrivate(isolated.runtime, id, p06BlobOwnerOf(owner));
    const commandId = randomUUID();
    const ordinalBefore = await readP02CollectionRow(isolated.runtime, P06_COLLECTION_A);
    assert.ok(ordinalBefore);
    const bundle = newApp();
    try {
      const [left, right] = await Promise.all([
        finalizeInject(bundle, owner, id.blobId, commandId),
        finalizeInject(bundle, owner, id.blobId, commandId),
      ]);
      assert.equal(left.statusCode, 200, left.body);
      assert.equal(right.statusCode, 200, right.body);
      const kinds = [left.json<FinalizeResultBody>().kind, right.json<FinalizeResultBody>().kind].sort();
      assert.deepEqual(kinds, ['already_finalized', 'finalized'],
        'the loser must converge to the winner identity (both requests succeed)');

      const attachmentId = expectedP06AttachmentId(owner.accountId, id.blobId, commandId);
      const operation = await readP06FinalizeOperationByCommandId(isolated.runtime, commandId);
      assert.ok(operation);
      assert.equal(operation.attachmentId, attachmentId);
      const set = await committedSet(isolated.runtime, id.blobId, attachmentId, operation.operationId);
      assert.equal(set.attachments, 1, 'exactly one Attachment row');
      assert.equal(set.operations, 1, 'exactly one Operation row');
      assert.equal(set.audits, 1, 'exactly one Audit row');
      assert.equal(set.outbox, 1, 'exactly one Outbox row');
      assert.equal(set.binding, attachmentId, 'exactly one committed binding');
      assert.equal(set.ordinal, ordinalBefore.commitOrdinal + 1n, 'the collection ordinal advanced exactly once');
      assert.equal(await p06FinalizeOperationCount(isolated.runtime, commandId), 1);
    } finally {
      await bundle.app.close();
      await bundle.store.close();
    }
  });

  test('concurrent finalizers with DIFFERENT command ids: one winner, the loser gets the permanent 409 and the committed binding never changes', async () => {
    const id = identityFor(401);
    await seedP06StoredPrivate(isolated.runtime, id, p06BlobOwnerOf(owner));
    const winnerCommand = randomUUID();
    const loserCommand = randomUUID();
    const bundle = newApp();
    try {
      const [left, right] = await Promise.all([
        finalizeInject(bundle, owner, id.blobId, winnerCommand),
        finalizeInject(bundle, owner, id.blobId, loserCommand),
      ]);
      const statuses = [left.statusCode, right.statusCode].sort((a, b) => a - b);
      assert.deepEqual(statuses, [200, 409], `one winner and one conflict, got ${statuses}`);
      const conflict = left.statusCode === 409 ? left : right;
      const problem = conflict.json<FinalizeProblem>().error;
      assert.equal(problem.code, 'attachment_state_conflict');

      const winner = left.statusCode === 200 ? left : right;
      const loser = left.statusCode === 409 ? left : right;
      const winnerCommandId = winner === left ? winnerCommand : loserCommand;
      const loserCommandId = loser === left ? winnerCommand : loserCommand;
      const attachmentId = expectedP06AttachmentId(owner.accountId, id.blobId, winnerCommandId);
      const operation = await readP06FinalizeOperationByCommandId(isolated.runtime, winnerCommandId);
      assert.ok(operation);
      assert.equal(operation.attachmentId, attachmentId);
      const set = await committedSet(isolated.runtime, id.blobId, attachmentId, operation.operationId);
      assert.equal(set.attachments, 1);
      assert.equal(set.operations, 1);
      assert.equal(set.outbox, 1);
      assert.equal(set.binding, attachmentId);

      // The loser's binding is permanently different: its retry stays 409 and
      // the committed binding never changes (anti-false-negative: only a
      // different binding is a conflict; it never becomes success).
      const retry = await finalizeInject(bundle, owner, id.blobId, loserCommandId);
      assert.equal(retry.statusCode, 409);
      const row = await readAttachmentRow(isolated.runtime, id.blobId);
      assert.ok(row);
      assert.equal(row.attachmentId, attachmentId);
    } finally {
      await bundle.app.close();
      await bundle.store.close();
    }
  });

  test('a REAL lock wait: the second finalizer parks on the Collection row lock and converges after the winner commits', async () => {
    const id = identityFor(402);
    await seedP06StoredPrivate(isolated.runtime, id, p06BlobOwnerOf(owner));
    const group = new BarrierGroup();
    const barrier = { arriveAndWait: (name: string) => group.arriveAndWait(`lw:${name}`) };
    const bundle = newApp({ barrier });
    try {
      const winnerCommand = randomUUID();
      const loserCommand = randomUUID();
      const winner = finalizeInject(bundle, owner, id.blobId, winnerCommand);
      // The winner parks holding the Collection FOR UPDATE lock.
      await group.waitArrived('lw:attachment_collection_locked');

      const loser = finalizeInject(bundle, owner, id.blobId, loserCommand);
      let loserSettled = false;
      void loser.then(() => { loserSettled = true; });
      await waitForCondition(async () => {
        const waiting = await isolated.runtime.pool.query<{ count: number }>(`
          select count(*)::int as count
          from pg_stat_activity
          where datname = current_database()
            and pid <> pg_backend_pid()
            and wait_event_type = 'Lock'
            and query like '%from collections where id =%for update%'
        `);
        return (waiting.rows[0]?.count ?? 0) > 0;
      }, {
        timeoutMs: 5_000,
        pollIntervalMs: 10,
        description: 'the losing finalizer to enter a PostgreSQL row-lock wait',
      });
      assert.equal(loserSettled, false, 'the second finalizer must wait on the Collection row lock, never fail');

      // Release the winner sequentially through the handoff lock barrier.
      group.release('lw:attachment_collection_locked');
      await group.waitArrived('lw:after_finalize_handoff_lock');
      group.release('lw:after_finalize_handoff_lock');

      const winnerResponse = await winner;
      assert.equal(winnerResponse.statusCode, 200, winnerResponse.body);
      const loserResponse = await loser;
      assert.equal(loserResponse.statusCode, 409, loserResponse.body);
      assert.equal(loserResponse.json<FinalizeProblem>().error.code, 'attachment_state_conflict');
      const row = await readAttachmentRow(isolated.runtime, id.blobId);
      assert.ok(row);
      assert.equal(row.attachmentId, expectedP06AttachmentId(owner.accountId, id.blobId, winnerCommand));
    } finally {
      await bundle.app.close();
      await bundle.store.close();
    }
  });

  test('rollback: a canonical write fault aborts the WHOLE transaction with zero half-commit, and the retry converges', async () => {
    const id = identityFor(403);
    await seedP06StoredPrivate(isolated.runtime, id, p06BlobOwnerOf(owner));
    const commandId = randomUUID();
    const attachmentId = expectedP06AttachmentId(owner.accountId, id.blobId, commandId);
    const ordinalBefore = await readP02CollectionRow(isolated.runtime, P06_COLLECTION_A);
    assert.ok(ordinalBefore);
    const ledgerBefore = (await readFinalizeSideEffects(isolated.runtime, id.blobId, attachmentId, 'p06-rollback-op')).ledger;

    const failing = newApp({
      canonicalFaults: {
        afterPhase: async (phase) => {
          if (phase === 'outbox') throw new Error('p06-rollback-fault');
        },
      },
    });
    try {
      const response = await finalizeInject(failing, owner, id.blobId, commandId);
      assert.equal(response.statusCode, 500, response.body);
      assert.equal(response.json<FinalizeProblem>().error.code, 'internal_error');
    } finally {
      await failing.app.close();
      await failing.store.close();
    }

    // Zero half-commit across EVERY surface (the deepest write already ran).
    const after = await readFinalizeSideEffects(isolated.runtime, id.blobId, attachmentId, 'p06-rollback-op');
    assert.equal(after.attachments.length, 0, 'no half-committed Attachment metadata');
    assert.equal(after.blob?.logicalState, 'stored_private', 'no half-committed blob binding');
    assert.equal(after.blob?.attachmentBindingId, null);
    assert.equal(after.operations.length, 0, 'no half-committed Operation');
    assert.equal(after.audits.length, 0, 'no half-committed Audit');
    assert.equal(after.outbox.length, 0, 'no half-committed Outbox');
    const collectionAfter = await readP02CollectionRow(isolated.runtime, P06_COLLECTION_A);
    assert.ok(collectionAfter);
    assert.equal(collectionAfter.commitOrdinal, ordinalBefore.commitOrdinal, 'no half-committed collection revision');
    assert.deepEqual(after.ledger, ledgerBefore, 'no half-committed ledger reservations');
    assert.equal(await p06FinalizeOperationCount(isolated.runtime, commandId), 0);

    // The identical request converges after the fault is gone.
    const retry = newApp();
    try {
      const response = await finalizeInject(retry, owner, id.blobId, commandId);
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.json<FinalizeResultBody>().kind, 'finalized');
    } finally {
      await retry.app.close();
      await retry.store.close();
    }
  });

  test('commit unknown (committed direction): the route re-reads the receipt and binding and returns the committed receipt', async () => {
    const id = identityFor(404);
    await seedP06StoredPrivate(isolated.runtime, id, p06BlobOwnerOf(owner));
    const commandId = randomUUID();
    let armed = true;
    const bundle = newApp({
      uowFaults: {
        afterCommitAcknowledged: async () => {
          if (!armed) return;
          armed = false;
          throw new Error('p06-lost-commit-ack');
        },
      },
    });
    try {
      const response = await finalizeInject(bundle, owner, id.blobId, commandId);
      assert.equal(response.statusCode, 200, response.body);
      const body = response.json<FinalizeResultBody>();
      assert.equal(body.kind, 'finalized');
      assert.equal(body.blobId, id.blobId);
      assert.equal(body.logicalState, 'attached_private');

      // The re-read proved the commit landed: exactly one committed set.
      const operation = await readP06FinalizeOperationByCommandId(isolated.runtime, commandId);
      assert.ok(operation);
      const attachmentId = expectedP06AttachmentId(owner.accountId, id.blobId, commandId);
      assert.equal(operation.attachmentId, attachmentId);
      const set = await committedSet(isolated.runtime, id.blobId, attachmentId, operation.operationId);
      assert.equal(set.attachments, 1);
      assert.equal(set.operations, 1);
      assert.equal(set.audits, 1);
      assert.equal(set.outbox, 1);
      assert.equal(set.binding, attachmentId);

      // A subsequent replay converges idempotently.
      const replay = await finalizeInject(bundle, owner, id.blobId, commandId);
      assert.equal(replay.statusCode, 200, replay.body);
      assert.equal(replay.json<FinalizeResultBody>().kind, 'already_finalized');
    } finally {
      await bundle.app.close();
      await bundle.store.close();
    }
  });

  test('commit unknown (rolled-back direction): zero half-commit and the retry converges', async () => {
    const id = identityFor(405);
    await seedP06StoredPrivate(isolated.runtime, id, p06BlobOwnerOf(owner));
    const commandId = randomUUID();
    const attachmentId = expectedP06AttachmentId(owner.accountId, id.blobId, commandId);
    const ordinalBefore = await readP02CollectionRow(isolated.runtime, P06_COLLECTION_A);
    assert.ok(ordinalBefore);

    const failing = newApp({
      uowFaults: {
        afterCallbackBeforeCommit: async () => {
          throw new Error('p06-pre-commit-fault');
        },
      },
    });
    try {
      const response = await finalizeInject(failing, owner, id.blobId, commandId);
      assert.equal(response.statusCode, 500, response.body);
    } finally {
      await failing.app.close();
      await failing.store.close();
    }

    const after = await readFinalizeSideEffects(isolated.runtime, id.blobId, attachmentId, 'p06-precommit-op');
    assert.equal(after.attachments.length, 0);
    assert.equal(after.blob?.logicalState, 'stored_private');
    assert.equal(after.operations.length, 0);
    assert.equal(after.outbox.length, 0);
    const collectionAfter = await readP02CollectionRow(isolated.runtime, P06_COLLECTION_A);
    assert.ok(collectionAfter);
    assert.equal(collectionAfter.commitOrdinal, ordinalBefore.commitOrdinal);

    const retry = newApp();
    try {
      const response = await finalizeInject(retry, owner, id.blobId, commandId);
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.json<FinalizeResultBody>().kind, 'finalized');
    } finally {
      await retry.app.close();
      await retry.store.close();
    }
  });

  test('deadlock/serialization failures map to the stable retryable 503 and the retry converges', async () => {
    const id = identityFor(406);
    await seedP06StoredPrivate(isolated.runtime, id, p06BlobOwnerOf(owner));
    const commandId = randomUUID();
    // The production use case classifies the structural DatabaseOperationError
    // shape ({ kind }) exactly like the real 40P01 the P02 race suite proves
    // retryable against the same production assembly.
    const failing = newApp({
      canonicalOverride: async () => {
        throw Object.assign(new Error('p06-deadlock'), { kind: 'deadlock' });
      },
    });
    try {
      const response = await finalizeInject(failing, owner, id.blobId, commandId);
      assert.equal(response.statusCode, 503, response.body);
      const problem = response.json<FinalizeProblem>().error;
      assert.equal(problem.code, 'rate_limit_unavailable');
      assert.equal(problem.sameRequestRetrySafe, true);
      assert.equal(response.headers['retry-after'], undefined, '503 must never fabricate a quota fact');
      assert.equal(await p06FinalizeOperationCount(isolated.runtime, commandId), 0, 'no half-commit from the aborted attempt');
    } finally {
      await failing.app.close();
      await failing.store.close();
    }
    const retry = newApp();
    try {
      const response = await finalizeInject(retry, owner, id.blobId, commandId);
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.json<FinalizeResultBody>().kind, 'finalized');
    } finally {
      await retry.app.close();
      await retry.store.close();
    }
  });

  test('the frozen canonical-outcome -> HTTP mapping matrix (wrong intent/generation/digest/etag/policy, expiry, binding, concealment)', async () => {
    const id = identityFor(407);
    await seedP06StoredPrivate(isolated.runtime, id, p06BlobOwnerOf(owner));
    const attachmentId = expectedP06AttachmentId(owner.accountId, id.blobId, 'p06-matrix-command');
    const receipt = {
      attachmentId,
      blobId: id.blobId,
      operationId: 'p06-matrix-operation',
      collectionId: P06_COLLECTION_A,
      commitOrdinal: 1n,
      logicalState: 'attached_private' as const,
    };
    const matrix: Array<{ outcome: FinalizeAttachmentResult; status: number; code: string }> = [
      { outcome: { outcome: 'binding_conflict', existingAttachmentId: attachmentId }, status: 409, code: 'attachment_state_conflict' },
      { outcome: { outcome: 'collection_not_found' }, status: 404, code: 'resource_not_found' },
      { outcome: { outcome: 'collection_deleted' }, status: 404, code: 'resource_not_found' },
      { outcome: { outcome: 'collection_owner_mismatch' }, status: 404, code: 'resource_not_found' },
      { outcome: { outcome: 'collection_binding_mismatch' }, status: 409, code: 'attachment_state_conflict' },
      { outcome: { outcome: 'not_found' }, status: 404, code: 'resource_not_found' },
      { outcome: { outcome: 'not_finalizable', logicalState: 'issued' }, status: 409, code: 'attachment_state_conflict' },
      { outcome: { outcome: 'generation_mismatch', expectedGenerationId: 'g1', currentGenerationId: 'g2' }, status: 409, code: 'attachment_state_conflict' },
      { outcome: { outcome: 'owner_mismatch' }, status: 404, code: 'resource_not_found' },
      { outcome: { outcome: 'etag_mismatch' }, status: 409, code: 'attachment_state_conflict' },
      { outcome: { outcome: 'verified_facts_mismatch', code: 'digest' }, status: 409, code: 'attachment_state_conflict' },
      { outcome: { outcome: 'policy_mismatch' }, status: 409, code: 'attachment_state_conflict' },
      { outcome: { outcome: 'expired' }, status: 409, code: 'attachment_state_conflict' },
      { outcome: { outcome: 'inconsistent', reason: 'binding_without_metadata' }, status: 500, code: 'internal_error' },
      { outcome: { outcome: 'finalized', receipt }, status: 200, code: 'finalized' },
      { outcome: { outcome: 'already_finalized', receipt }, status: 200, code: 'already_finalized' },
    ];
    for (const entry of matrix) {
      const bundle = newApp({ canonicalOverride: async () => entry.outcome });
      try {
        const response = await finalizeInject(bundle, owner, id.blobId, randomUUID());
        assert.equal(response.statusCode, entry.status,
          `${JSON.stringify(entry.outcome, (_key, value) => typeof value === 'bigint' ? value.toString() : value)} -> ${response.statusCode}`);
        const parsed = response.json<FinalizeProblem | FinalizeResultBody>();
        if (entry.status === 200) {
          const body = parsed as FinalizeResultBody;
          assert.equal(body.kind, entry.code);
        } else {
          assert.equal((parsed as FinalizeProblem).error.code, entry.code, JSON.stringify(entry.outcome));
        }
      } finally {
        await bundle.app.close();
        await bundle.store.close();
      }
    }
  });
});
