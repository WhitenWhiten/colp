/**
 * P4A-P07 focused PostgreSQL suite (part 2): the production retire command
 * and the retention-window cleanup convergence.
 *
 * Boots the PRODUCTION app composition (`buildP03App`) with the REAL
 * PostgreSQL attachments ports and the REAL R2 adapter over the local
 * create-only object server, and drives blobs through the REAL routes with
 * session cookie + Origin + CSRF + Known-Command-Id.
 *
 * Covers the P07 retire/cleanup test scope (anti-false-positive /
 * anti-false-negative per plan §4):
 * - the retire command retires ONE finalized owner-private Attachment into
 *   retention in ONE canonical transaction: Attachment metadata ->
 *   retired (DB-clock retired_at), CURRENT generation -> retired, pointer
 *   cleared, Operation/Audit/Outbox + collection ordinal committed
 *   atomically — the route response is the stable 200 receipt and the
 *   status read CONCEALS the retired Attachment exactly like a missing blob;
 * - retirement is terminal: any replay (same or different Known-Command-Id)
 *   converges to `already_retired` with the ORIGINAL committed receipt;
 *   the same Known-Command-Id on a DIFFERENT blob is the permanent 409
 *   idempotency conflict;
 * - concealment: member non-owner / outsider / cross-owner / tombstoned
 *   (`deleted`) identity -> identical 404; anonymous -> 401; inadmissible
 *   states (issued/uploaded/stored_private-not-finalized) -> stable 409;
 *   a fabricated `retired` metadata row WITHOUT its canonical Operation is
 *   never reported as already_retired (500 inconsistent, no fabrication);
 * - rollback: a canonical write fault aborts the WHOLE retirement with zero
 *   half-commit (metadata, generation, pointer, Operation/Audit/Outbox,
 *   ordinal all unchanged) and the retry converges;
 * - cleanup convergence: a retirement INSIDE the retention window is NOT a
 *   failure (claimed 0 — anti-false-negative); after the DATABASE clock
 *   crosses the window the production coordinator claims the retired
 *   generation, deletes the exact key and HEAD-confirms absence, retains the
 *   permanent tombstones (generation row + generation_keys + upload_intents),
 *   and a delete replay claims 0 again; the same physical key can never be
 *   reissued (permanent unique tombstones); the ACTIVE marker of a replaced
 *   blob is preserved while only the retired keys are cleaned.
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
  P03ObjectServer,
  type P03AppBundle,
  type P03RetireSeams,
} from '../../support/phase4a-p03-test-helpers.js';
import { describeWithPostgres } from '../../support/postgres-test-runtime.js';
import { seedP04TerminalAttachmentMetadata } from '../../support/phase4a-p04-test-helpers.js';
import { seedP06Issued } from '../../support/phase4a-p06-test-helpers.js';
import { identityFor } from '../../support/phase4a-i07-test-helpers.js';
import { runCleanupBatch } from '../../../src/modules/attachments/index.js';
import {
  P07_COLLECTION_A,
  P07_COLLECTION_B,
  p07BlobOwnerOf,
  p07Body,
  p07Cleanup,
  P07_CLEANUP_CONFIG,
  p07Finalize,
  p07Headers,
  p07OperationCount,
  p07OutboxCount,
  p07ReissueKeyRejected,
  p07Retire,
  p07SeedCollection,
  p07Status,
  p07TombstoneCounts,
  p07UploadToStored,
  p07ReplaceAndVerify,
  readP07Attachment,
  readP07Blob,
  readP07Generation,
  readP07OperationByCommandId,
} from '../../support/phase4a-p07-test-helpers.js';

const NOW = new Date('2026-08-08T12:00:00.000Z');

interface RetireBody {
  kind: 'retired' | 'already_retired';
  blobId: string;
  logicalState: string;
}

interface StatusBody {
  blobId: string;
  logicalState: string;
  allowedActions: string[];
}

interface ProblemBody {
  error: {
    code: string;
    message: string;
    recovery: string;
    sameRequestRetrySafe: boolean;
    fieldErrors: Array<{ path: string; code: string; message: string }>;
  };
}

function assertProblem(response: { statusCode: number; body: string }, code: string): void {
  assert.equal(response.statusCode >= 400, true);
  const problem = (JSON.parse(response.body) as ProblemBody).error;
  assert.equal(problem.code, code);
}

describeWithPostgres('P4A-P07 production retire route and retention cleanup', () => {
  let isolated: I07MigrationRuntime;
  let identityUnitOfWork: ReturnType<typeof createIdentityMemoryUnitOfWork>;
  let factory: ReturnType<typeof createInMemoryBetterAuthTestFactory>;
  let owner: AuthenticatedTestClient;
  let editor: AuthenticatedTestClient;
  let outsider: AuthenticatedTestClient;
  let otherOwner: AuthenticatedTestClient;
  let objectServer: P03ObjectServer;

  beforeAll(async () => {
    isolated = await createI07MigrationRuntime('phase4a_p07_retire_cleanup', { maxConnections: 16 });
    identityUnitOfWork = createIdentityMemoryUnitOfWork(createIdentityMemoryState(NOW));
    factory = createInMemoryBetterAuthTestFactory({ identityUnitOfWork });
    owner = await issueTestSession({
      factory,
      subject: 'p07-retire-owner', handle: 'p07_retire_owner' });
    editor = await issueTestSession({
      factory,
      subject: 'p07-retire-editor', handle: 'p07_retire_editor' });
    outsider = await issueTestSession({
      factory,
      subject: 'p07-retire-outsider', handle: 'p07_retire_outsider' });
    otherOwner = await issueTestSession({
      factory,
      subject: 'p07-retire-other', handle: 'p07_retire_other' });
    await p07SeedCollection(isolated.runtime, {
      collectionId: P07_COLLECTION_A,
      ownerSubjectId: owner.subjectId,
      members: [
        { subjectId: owner.subjectId, role: 'owner' },
        { subjectId: editor.subjectId, role: 'editor' },
      ],
    });
    await p07SeedCollection(isolated.runtime, {
      collectionId: P07_COLLECTION_B,
      ownerSubjectId: owner.subjectId,
      members: [{ subjectId: owner.subjectId, role: 'owner' }],
    });
    await p07SeedCollection(isolated.runtime, {
      collectionId: 'p07-retire-other-owner',
      ownerSubjectId: otherOwner.subjectId,
      members: [{ subjectId: otherOwner.subjectId, role: 'owner' }],
    });
    objectServer = new P03ObjectServer();
    await objectServer.start();
  }, 120_000);

  afterAll(async () => {
    await objectServer?.close();
    await isolated?.dropSchema();
  });

  function newApp(retireSeams?: P03RetireSeams): P03AppBundle {
    return buildP03App({
      runtime: isolated.runtime,
      databaseUrl: isolated.databaseUrl,
      identityUnitOfWork,
      browserSessionAuthority: factory.authority,
      objectServerUrl: objectServer.url,
      attachmentsConfig: P07_CLEANUP_CONFIG,
      retireSeams,
    });
  }

  /** Uploads -> stored_private -> finalize -> attached_private. */
  async function uploadFinalized(bundle: P03AppBundle, body: Uint8Array): Promise<{ blobId: string; key: string }> {
    const uploaded = await p07UploadToStored(bundle.app, owner, isolated.runtime, {
      collectionId: P07_COLLECTION_A,
      body,
    });
    const finalize = await p07Finalize(bundle.app, owner, uploaded.blobId, randomUUID());
    assert.equal(finalize.statusCode, 200, finalize.body);
    const finalized = JSON.parse(finalize.body) as RetireBody;
    assert.equal(finalized.kind, 'finalized');
    assert.equal(finalized.logicalState, 'attached_private');
    return { blobId: uploaded.blobId, key: uploaded.key };
  }

  test('retire commits the canonical side-effect set in ONE transaction; the status read conceals the retired Attachment; replays converge to the ORIGINAL receipt', async () => {
    const bundle = newApp();
    try {
      const body = p07Body(51);
      const { blobId, key } = await uploadFinalized(bundle, body);
      const attachmentBefore = await readP07Attachment(isolated.runtime, blobId);
      assert.ok(attachmentBefore);
      assert.equal(attachmentBefore.logicalState, 'attached_private');

      // The status read exposes the retire action BEFORE the retirement.
      const before = await p07Status(bundle.app, owner, blobId);
      assert.equal(before.statusCode, 200, before.body);
      const beforeView = JSON.parse(before.body) as StatusBody;
      assert.equal(beforeView.logicalState, 'attached_private');
      assert.ok(beforeView.allowedActions.includes('retire'), 'attached_private + active exposes retire');

      const retireCommandId = randomUUID();
      const ordinalBefore = await isolated.runtime.pool.query<{ commit_ordinal: string }>(
        `select commit_ordinal::text from collections where id = $1`, [P07_COLLECTION_A],
      );
      const retire = await p07Retire(bundle.app, owner, blobId, retireCommandId);
      assert.equal(retire.statusCode, 200, retire.body);
      const retired = JSON.parse(retire.body) as RetireBody;
      assert.equal(retired.kind, 'retired');
      assert.equal(retired.logicalState, 'retired');
      assert.equal(retired.blobId, blobId);

      // Canonical side-effect set, committed together:
      const attachment = await readP07Attachment(isolated.runtime, blobId);
      assert.ok(attachment);
      assert.equal(attachment.logicalState, 'retired');
      assert.ok(attachment.retiredAt, 'retirement is DB-clock stamped');
      const operation = await readP07OperationByCommandId(isolated.runtime, 'attachment.retired', retireCommandId);
      assert.ok(operation, 'the retire Operation row is committed');
      assert.equal(operation.attachmentId, attachment.attachmentId);
      assert.equal(operation.blobId, blobId);
      assert.equal(await p07OperationCount(isolated.runtime, 'attachment.retired', retireCommandId), 1);
      const audit = await isolated.runtime.pool.query<{ count: string }>(
        `select count(*)::text as count from audit_events where operation_id = $1`, [operation.operationId],
      );
      assert.equal(Number(audit.rows[0]!.count), 1, 'one canonical Audit row');
      const outbox = await isolated.runtime.pool.query<{ count: string }>(
        `select count(*)::text as count from outbox_events where handler_name = 'attachments_retire_attachment' and aggregate_id = $1`,
        [blobId],
      );
      assert.equal(Number(outbox.rows[0]!.count), 1, 'one canonical Outbox row');
      assert.equal(await p07OutboxCount(isolated.runtime, blobId, 'attachments_retire_attachment'), 1);
      const ordinalAfter = await isolated.runtime.pool.query<{ commit_ordinal: string }>(
        `select commit_ordinal::text from collections where id = $1`, [P07_COLLECTION_A],
      );
      assert.equal(
        BigInt(ordinalAfter.rows[0]!.commit_ordinal),
        BigInt(ordinalBefore.rows[0]!.commit_ordinal) + 1n,
        'the collection ordinal advances exactly once',
      );

      // The blob pointer is cleared so the retired generation becomes
      // cleanup-claimable; the generation itself is retired.
      const blob = await readP07Blob(isolated.runtime, blobId);
      assert.ok(blob);
      assert.equal(blob.currentGenerationId, null, 'the retire clears the current pointer');
      const generation = await readP07Generation(isolated.runtime, operation.payloadJson['generationId'] as string);
      assert.ok(generation);
      assert.equal(generation.generationState, 'retired');

      // The status read conceals the retired Attachment exactly like a
      // missing blob (frozen contract); replacement is concealed identically.
      const after = await p07Status(bundle.app, owner, blobId);
      assert.equal(after.statusCode, 404, after.body);
      assertProblem(after, 'resource_not_found');

      // Retirement is terminal: a replay with a DIFFERENT command id returns
      // the ORIGINAL committed receipt — never a second operation.
      const replay = await p07Retire(bundle.app, owner, blobId, randomUUID());
      assert.equal(replay.statusCode, 200, replay.body);
      const replayView = JSON.parse(replay.body) as RetireBody;
      assert.equal(replayView.kind, 'already_retired');
      assert.equal(await p07OperationCount(isolated.runtime, 'attachment.retired', retireCommandId), 1);
      const retireOperationsForAttachment = await isolated.runtime.pool.query<{ count: string }>(
        `select count(*)::text as count from operation_lookup_facts
         where operation_type = 'attachment.retired' and attachment_id = $1`,
        [attachment.attachmentId],
      );
      assert.equal(Number(retireOperationsForAttachment.rows[0]!.count), 1, 'a terminal replay never writes a second Operation');
      assert.equal(await p07OutboxCount(isolated.runtime, blobId, 'attachments_retire_attachment'), 1, 'no second Outbox row');

      // The retired body bytes survive until the retention cleanup converges
      // (external deletion is never synchronous with the retirement).
      assert.equal(objectServer.has(key), true, 'retired body stays until retention cleanup');
    } finally {
      await bundle.app.close();
      await bundle.store.close();
    }
  });

  test('retire idempotency: same Known-Command-Id replay returns the SAME receipt; the same command id on a DIFFERENT blob is a permanent 409', async () => {
    const bundle = newApp();
    try {
      const { blobId: blobA } = await uploadFinalized(bundle, p07Body(52));
      const { blobId: blobB } = await uploadFinalized(bundle, p07Body(53));
      const commandId = randomUUID();

      const first = await p07Retire(bundle.app, owner, blobA, commandId);
      assert.equal(first.statusCode, 200, first.body);
      const firstOperation = await readP07OperationByCommandId(isolated.runtime, 'attachment.retired', commandId);
      assert.ok(firstOperation);

      // The same command id on the SAME blob converges to the original receipt.
      const replay = await p07Retire(bundle.app, owner, blobA, commandId);
      assert.equal(replay.statusCode, 200, replay.body);
      const replayView = JSON.parse(replay.body) as RetireBody;
      assert.equal(replayView.kind, 'already_retired');
      assert.equal(await p07OperationCount(isolated.runtime, 'attachment.retired', commandId), 1, 'replay never writes a second operation');

      // The same command id on a DIFFERENT blob is the permanent 409.
      const cross = await p07Retire(bundle.app, owner, blobB, commandId);
      assert.equal(cross.statusCode, 409, cross.body);
      assertProblem(cross, 'attachment_idempotency_conflict');

      // The different blob is untouched and can still retire with a fresh id.
      const fresh = await p07Retire(bundle.app, owner, blobB, randomUUID());
      assert.equal(fresh.statusCode, 200, fresh.body);
    } finally {
      await bundle.app.close();
      await bundle.store.close();
    }
  });

  test('retire concealment and inadmissible states: foreign/outsider/tombstoned -> 404, anonymous -> 401, not-finalized -> 409, fabricated-retired never reported as already_retired', async () => {
    const bundle = newApp();
    try {
      const { blobId } = await uploadFinalized(bundle, p07Body(54));

      // Member non-owner / outsider are concealed identically (404).
      const editorAttempt = await p07Retire(bundle.app, editor, blobId, randomUUID());
      assert.equal(editorAttempt.statusCode, 404, editorAttempt.body);
      assertProblem(editorAttempt, 'resource_not_found');
      const outsiderAttempt = await p07Retire(bundle.app, outsider, blobId, randomUUID());
      assert.equal(outsiderAttempt.statusCode, 404);

      // Cross-owner blob -> 404.
      const foreign = await p07UploadToStored(bundle.app, otherOwner, isolated.runtime, {
        collectionId: 'p07-retire-other-owner',
        body: p07Body(55),
      });
      await p07Finalize(bundle.app, otherOwner, foreign.blobId, randomUUID());
      const crossOwner = await p07Retire(bundle.app, owner, foreign.blobId, randomUUID());
      assert.equal(crossOwner.statusCode, 404, 'cross-owner retire is concealed');

      // Anonymous: the mutation gate requires a session -> 401.
      const anonymous = await bundle.app.inject({
        method: 'POST',
        url: `/api/v1/attachments/${encodeURIComponent(blobId)}/retire`,
        headers: { origin: 'https://app.known.example', 'content-type': 'application/json' },
        payload: '{}',
      });
      assert.equal(anonymous.statusCode, 401);

      // Tombstoned (`deleted`) attachment identity -> 404.
      const deletedId = identityFor(56);
      await seedP04TerminalAttachmentMetadata(isolated.runtime, deletedId, {
        owner: p07BlobOwnerOf(owner),
        collectionId: P07_COLLECTION_A,
        terminalState: 'deleted',
      });
      const deletedAttempt = await p07Retire(bundle.app, owner, deletedId.blobId, randomUUID());
      assert.equal(deletedAttempt.statusCode, 404, deletedAttempt.body);
      assertProblem(deletedAttempt, 'resource_not_found');

      // A fabricated `retired` metadata row WITHOUT its canonical Operation
      // is NEVER reported as already_retired — recovery cannot fabricate the
      // receipt (500 inconsistent), and the retry with the real command path
      // cannot invent a retirement.
      const fabricatedId = identityFor(57);
      await seedP04TerminalAttachmentMetadata(isolated.runtime, fabricatedId, {
        owner: p07BlobOwnerOf(owner),
        collectionId: P07_COLLECTION_A,
        terminalState: 'retired',
      });
      const fabricated = await p07Retire(bundle.app, owner, fabricatedId.blobId, randomUUID());
      assert.equal(fabricated.statusCode, 500, fabricated.body);
      assertProblem(fabricated, 'internal_error');

      // Inadmissible states -> stable 409: issued (no attachment), uploaded
      // (no attachment), stored_private (not finalized).
      const issuedId = identityFor(58);
      await seedP06Issued(isolated.runtime, issuedId, p07BlobOwnerOf(owner), P07_COLLECTION_A);
      const issuedAttempt = await p07Retire(bundle.app, owner, issuedId.blobId, randomUUID());
      assert.equal(issuedAttempt.statusCode, 409, issuedAttempt.body);
      assertProblem(issuedAttempt, 'attachment_state_conflict');

      const uploadedGen = await p07UploadToStored(bundle.app, owner, isolated.runtime, {
        collectionId: P07_COLLECTION_A,
        body: p07Body(59),
      });
      const storedNotFinalized = await p07Retire(bundle.app, owner, uploadedGen.blobId, randomUUID());
      assert.equal(storedNotFinalized.statusCode, 409, storedNotFinalized.body);
      assertProblem(storedNotFinalized, 'attachment_state_conflict');

      // Body-shape validation: a retire request must be an empty object.
      const invalidBody = await bundle.app.inject({
        method: 'POST',
        url: `/api/v1/attachments/${encodeURIComponent(blobId)}/retire`,
        headers: p07Headers(owner, randomUUID()),
        payload: JSON.stringify({ bogus: 1 }),
      });
      assert.equal(invalidBody.statusCode, 422);
      assertProblem(invalidBody, 'invalid_document');

      // The committed attachment is untouched by every rejection.
      const untouched = await readP07Attachment(isolated.runtime, blobId);
      assert.ok(untouched);
      assert.equal(untouched.logicalState, 'attached_private');
    } finally {
      await bundle.app.close();
      await bundle.store.close();
    }
  });

  test('rollback: a canonical write fault aborts the WHOLE retirement with zero half-commit and the retry converges', async () => {
    const body = p07Body(60);
    const seed = newApp();
    let blobId = '';
    try {
      const uploaded = await p07UploadToStored(seed.app, owner, isolated.runtime, {
        collectionId: P07_COLLECTION_A,
        body,
      });
      blobId = uploaded.blobId;
      const finalize = await p07Finalize(seed.app, owner, blobId, randomUUID());
      assert.equal(finalize.statusCode, 200, finalize.body);
    } finally {
      await seed.app.close();
      await seed.store.close();
    }

    const attachmentBefore = await readP07Attachment(isolated.runtime, blobId);
    assert.ok(attachmentBefore);
    const blobBefore = await readP07Blob(isolated.runtime, blobId);
    assert.ok(blobBefore);
    assert.ok(blobBefore.currentGenerationId);
    const ordinalBefore = await isolated.runtime.pool.query<{ commit_ordinal: string }>(
      `select commit_ordinal::text from collections where id = $1`, [P07_COLLECTION_A],
    );
    const commandId = randomUUID();

    const failing = newApp({
      canonicalFaults: {
        afterPhase: async (phase) => {
          // Fire AFTER the deepest write phase: metadata + generation +
          // pointer + Operation/Audit/Outbox already ran inside the
          // transaction — the rollback must still undo ALL of them.
          if (phase === 'revision') throw new Error('p07-retire-rollback-fault');
        },
      },
    });
    try {
      const response = await p07Retire(failing.app, owner, blobId, commandId);
      assert.equal(response.statusCode, 500, response.body);
      assertProblem(response, 'internal_error');
    } finally {
      await failing.app.close();
      await failing.store.close();
    }

    // Zero half-commit across EVERY surface.
    const attachmentAfter = await readP07Attachment(isolated.runtime, blobId);
    assert.ok(attachmentAfter);
    assert.equal(attachmentAfter.logicalState, 'attached_private', 'no half-committed metadata retirement');
    assert.equal(attachmentAfter.retiredAt, null);
    const blobAfter = await readP07Blob(isolated.runtime, blobId);
    assert.ok(blobAfter);
    assert.equal(blobAfter.currentGenerationId, blobBefore.currentGenerationId, 'pointer unchanged');
    const generationAfter = await readP07Generation(isolated.runtime, blobBefore.currentGenerationId);
    assert.ok(generationAfter);
    assert.equal(generationAfter.generationState, 'active', 'generation unchanged');
    assert.equal(await p07OperationCount(isolated.runtime, 'attachment.retired', commandId), 0, 'no half-committed Operation');
    assert.equal(await p07OutboxCount(isolated.runtime, blobId, 'attachments_retire_attachment'), 0, 'no half-committed Outbox');
    const ordinalAfter = await isolated.runtime.pool.query<{ commit_ordinal: string }>(
      `select commit_ordinal::text from collections where id = $1`, [P07_COLLECTION_A],
    );
    assert.equal(ordinalAfter.rows[0]!.commit_ordinal, ordinalBefore.rows[0]!.commit_ordinal, 'no half-committed ordinal');

    // The identical request converges after the fault is gone.
    const retry = newApp();
    try {
      const response = await p07Retire(retry.app, owner, blobId, commandId);
      assert.equal(response.statusCode, 200, response.body);
      assert.equal((JSON.parse(response.body) as RetireBody).kind, 'retired');
    } finally {
      await retry.app.close();
      await retry.store.close();
    }
  });

  test('retention cleanup: within-window is not a failure; DB-clock advance -> exact-key delete, tombstones retained, delete replay claims 0, key reissue rejected, active marker preserved', async () => {
    const bundle = newApp();
    try {
      // One blob with TWO retired generations: the replacement retires gen1
      // (old marker), then the retire command retires the new current
      // generation and clears the pointer. Both retired keys must converge
      // through cleanup while the tombstones survive.
      const oldBody = p07Body(61);
      const newBody = p07Body(62);
      const gen1 = await p07UploadToStored(bundle.app, owner, isolated.runtime, {
        collectionId: P07_COLLECTION_A,
        body: oldBody,
      });
      const gen2 = await p07ReplaceAndVerify(bundle.app, owner, isolated.runtime, gen1.blobId, newBody);
      const finalize = await p07Finalize(bundle.app, owner, gen1.blobId, randomUUID());
      assert.equal(finalize.statusCode, 200, finalize.body);
      const retire = await p07Retire(bundle.app, owner, gen1.blobId, randomUUID());
      assert.equal(retire.statusCode, 200, retire.body);

      const g1 = await readP07Generation(isolated.runtime, gen1.generationId);
      const g2 = await readP07Generation(isolated.runtime, gen2.generationId);
      assert.ok(g1 && g2);
      assert.equal(g1.generationState, 'retired');
      assert.equal(g2.generationState, 'retired');
      const blob = await readP07Blob(isolated.runtime, gen1.blobId);
      assert.ok(blob);
      assert.equal(blob.currentGenerationId, null);

      // Within the retention window the coordinator claims NOTHING — the
      // retirement inside the window is not a failure (anti-false-negative).
      const withinWindow = await runCleanupBatch(p07Cleanup(isolated.runtime, bundle.moduleStore, P07_CLEANUP_CONFIG, 'p07-cleaner'));
      assert.equal(withinWindow.claimed, 0, 'within-window retirement is not claimable');
      assert.deepEqual(withinWindow.outcomes, []);
      assert.equal(objectServer.has(gen1.key), true);
      assert.equal(objectServer.has(gen2.key), true);

      // The DATABASE clock crosses the window for BOTH retired generations.
      await isolated.runtime.pool.query(
        `update blob_generations set retired_at = now() - interval '91 days'
         where generation_id = any($1::text[])`,
        [[gen1.generationId, gen2.generationId]],
      );

      // The production coordinator converges the external deletion of the
      // retired keys; the ACTIVE marker (gen2's body) is gone only because
      // gen2 itself is retired — nothing ACTIVE is ever deleted.
      const cleanup = await runCleanupBatch(p07Cleanup(isolated.runtime, bundle.moduleStore, P07_CLEANUP_CONFIG, 'p07-cleaner'));
      assert.ok(cleanup.claimed >= 1, 'retired generations become claimable after the window');
      const kinds = cleanup.outcomes.map((o) => o.kind).sort();
      assert.deepEqual(kinds, ['deleted', 'deleted'], `both retired keys deleted, got ${JSON.stringify(kinds)}`);
      assert.equal(objectServer.has(gen1.key), false, 'old retired key is exact-absent');
      assert.equal(objectServer.has(gen2.key), false, 'new retired key is exact-absent');

      // Tombstones survive the deletion evidence: generation rows (state
      // deleted + confirmed absence), the permanent key tombstones and the
      // intent rows.
      for (const generationId of [gen1.generationId, gen2.generationId]) {
        const row = await readP07Generation(isolated.runtime, generationId);
        assert.ok(row);
        assert.equal(row.generationState, 'deleted');
        assert.ok(row.confirmedAbsentAt, 'deletion evidence is recorded');
        const tombstones = await p07TombstoneCounts(isolated.runtime, generationId);
        assert.equal(tombstones.keys, 1, 'the permanent key tombstone survives');
        assert.equal(tombstones.generations, 1);
        assert.equal(tombstones.intents, 1);
      }

      // Delete replay: a second cleanup run claims nothing and deletes nothing.
      const replay = await runCleanupBatch(p07Cleanup(isolated.runtime, bundle.moduleStore, P07_CLEANUP_CONFIG, 'p07-cleaner'));
      assert.equal(replay.claimed, 0, 'delete replay claims 0');
      assert.deepEqual(replay.outcomes, []);

      // The same physical key can never be reissued (permanent tombstones).
      const reissue = await p07ReissueKeyRejected(isolated.runtime, gen1.generationId, gen1.key, gen1.blobId);
      assert.equal(reissue.code, '23505', 'reissuing a tombstoned key is rejected by the unique constraint');

      // The attachment metadata tombstone also survives cleanup.
      const attachment = await readP07Attachment(isolated.runtime, gen1.blobId);
      assert.ok(attachment);
      assert.equal(attachment.logicalState, 'retired');
    } finally {
      await bundle.app.close();
      await bundle.store.close();
    }
  });
});
