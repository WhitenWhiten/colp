/**
 * P4A-P06 focused PostgreSQL suite (part 1): the production finalize route —
 * canonical side-effect set, replay semantics and non-stored rejections.
 *
 * Boots the PRODUCTION app composition (`buildApiApp`) with the REAL
 * PostgreSQL attachments ports and drives blobs through the PRODUCTION ledger
 * ports into genuine states, then finalizes through the real HTTP route with
 * session cookie + Origin + CSRF + Known-Command-Id.
 *
 * Covers the P06 test scope:
 * - stored_private -> 200 finalized with the FULL canonical side-effect set
 *   (Attachment metadata, blob binding, Operation/Audit/Outbox, resource
 *   ledger, collection ordinal) — anti-false-positive: no test SQL writes the
 *   target rows, and the attachment identity is asserted against the
 *   deterministic production derivation;
 * - same-binding replay (same Known-Command-Id) -> 200 already_finalized with
 *   the ORIGINAL receipt and zero new rows; different binding (new command id
 *   on the same blob) -> 409 attachment_state_conflict; the same command id
 *   on a different blob -> 409 attachment_idempotency_conflict (anti-false-
 *   negative: replays are success, only different bindings conflict);
 * - non-stored states (issued/uploaded/verifying/expired) and corrupted
 *   preconditions (retention deadline expired, missing current-generation
 *   pointer) -> 409 attachment_state_conflict with zero side effects.
 *
 * The concealment matrix, response loss, API restart, Sync/Publication
 * exclusion and input-gate proofs live in
 * phase4a-p06-finalize-concealment-recovery-postgres.integration.test.ts
 * (a dedicated isolated schema, because the concealment matrix mutates
 * collections).
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
  readLedgerIds,
  readOutboxRows,
  readP02CollectionRow,
} from '../../support/phase4a-p02-test-helpers.js';
import { describeWithPostgres } from '../../support/postgres-test-runtime.js';
import { identityFor } from '../../support/phase4a-i07-test-helpers.js';
import {
  P06_COLLECTION_A,
  P06_COLLECTION_B,
  P06_COLLECTION_C,
  P06_COLLECTION_OTHER,
  expectedP06AttachmentId,
  finalizeHeaders,
  p06BlobOwnerOf,
  p06FinalizeOperationCount,
  readP06BlobBinding,
  readP06FinalizeOperationByCommandId,
  seedP06Collection,
  seedP06Expired,
  seedP06Issued,
  seedP06StoredPrivate,
  seedP06Uploaded,
  seedP06Verifying,
} from '../../support/phase4a-p06-test-helpers.js';

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

const CONCEALED_404 = {
  code: 'resource_not_found',
  message: 'The requested Attachment resource was not found.',
  recovery: 'none',
  sameRequestRetrySafe: false,
  precondition: null,
  currentEtag: null,
  retryAfterSeconds: null,
  fieldErrors: [],
} as const;

function assertConcealed404(response: { statusCode: number; headers: Record<string, unknown>; body: string }): void {
  assert.equal(response.statusCode, 404);
  assert.equal(response.headers['cache-control'], 'private, no-store');
  assert.equal(typeof response.headers['x-request-id'], 'string');
  const problem = (JSON.parse(response.body) as FinalizeProblem).error;
  assert.deepEqual(
    {
      code: problem.code,
      message: problem.message,
      recovery: problem.recovery,
      sameRequestRetrySafe: problem.sameRequestRetrySafe,
      precondition: problem.precondition,
      currentEtag: problem.currentEtag,
      retryAfterSeconds: problem.retryAfterSeconds,
      fieldErrors: problem.fieldErrors,
    },
    CONCEALED_404,
    'every concealed 404 must carry the identical stable external Problem',
  );
}

function assertStateConflict(response: { statusCode: number; headers: Record<string, unknown>; body: string }): void {
  assert.equal(response.statusCode, 409);
  assert.equal(response.headers['cache-control'], 'private, no-store');
  const problem = (JSON.parse(response.body) as FinalizeProblem).error;
  assert.equal(problem.code, 'attachment_state_conflict');
  assert.equal(problem.recovery, 'user_action');
}

function finalizeUrl(blobId: string): string {
  return `/api/v1/attachments/${encodeURIComponent(blobId)}/finalize`;
}

describeWithPostgres('P4A-P06 production finalize route', () => {
  let isolated: I07MigrationRuntime;
  let identityUnitOfWork: ReturnType<typeof createIdentityMemoryUnitOfWork>;
  let factory: ReturnType<typeof createInMemoryBetterAuthTestFactory>;
  let owner: AuthenticatedTestClient;
  let editor: AuthenticatedTestClient;
  let outsider: AuthenticatedTestClient;
  let otherOwner: AuthenticatedTestClient;

  beforeAll(async () => {
    isolated = await createI07MigrationRuntime('phase4a_p06_finalize', { maxConnections: 12 });
    identityUnitOfWork = createIdentityMemoryUnitOfWork(createIdentityMemoryState(NOW));
    factory = createInMemoryBetterAuthTestFactory({ identityUnitOfWork });
    owner = await issueTestSession({
      factory,
      subject: 'p06-owner', handle: 'p06_owner' });
    editor = await issueTestSession({
      factory,
      subject: 'p06-editor', handle: 'p06_editor' });
    outsider = await issueTestSession({
      factory,
      subject: 'p06-outsider', handle: 'p06_outsider' });
    otherOwner = await issueTestSession({
      factory,
      subject: 'p06-other-owner', handle: 'p06_other' });
    await seedP06Collection(isolated.runtime, {
      collectionId: P06_COLLECTION_A,
      ownerSubjectId: owner.subjectId,
      members: [
        { subjectId: owner.subjectId, role: 'owner' },
        { subjectId: editor.subjectId, role: 'editor' },
      ],
    });
    await seedP06Collection(isolated.runtime, {
      collectionId: P06_COLLECTION_B,
      ownerSubjectId: owner.subjectId,
      members: [{ subjectId: owner.subjectId, role: 'owner' }],
    });
    // Dedicated collection for the revocation case (mutated by the
    // concealment matrix, never reused by later tests).
    await seedP06Collection(isolated.runtime, {
      collectionId: P06_COLLECTION_C,
      ownerSubjectId: owner.subjectId,
      members: [{ subjectId: owner.subjectId, role: 'owner' }],
    });
    await seedP06Collection(isolated.runtime, {
      collectionId: P06_COLLECTION_OTHER,
      ownerSubjectId: otherOwner.subjectId,
      members: [{ subjectId: otherOwner.subjectId, role: 'owner' }],
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

  test('a stored_private blob finalizes with the FULL canonical side-effect set in one commit', async () => {
    const id = identityFor(300);
    const { body: seedBody } = await seedP06StoredPrivate(isolated.runtime, id, p06BlobOwnerOf(owner));
    const commandId = randomUUID();
    const bundle = newApp();
    try {
      const collectionBefore = await readP02CollectionRow(isolated.runtime, P06_COLLECTION_A);
      assert.ok(collectionBefore);
      const response = await bundle.app.inject({
        method: 'POST',
        url: finalizeUrl(id.blobId),
        headers: finalizeHeaders(owner, commandId),
        payload: '{}',
      });
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.headers['cache-control'], 'private, no-store');
      assert.equal(typeof response.headers['x-request-id'], 'string');
      const body = response.json() as FinalizeResultBody;
      assert.equal(body.kind, 'finalized');
      assert.equal(body.blobId, id.blobId);
      assert.equal(body.logicalState, 'attached_private');
      assert.deepEqual(Object.keys(body).sort(), ['blobId', 'kind', 'logicalState']);

      // The committed attachment identity equals the deterministic production
      // derivation from (principalId, blobId, Known-Command-Id).
      const attachmentId = expectedP06AttachmentId(owner.accountId, id.blobId, commandId);
      const operation = await readP06FinalizeOperationByCommandId(isolated.runtime, commandId);
      assert.ok(operation);
      assert.equal(operation.attachmentId, attachmentId);
      assert.equal(operation.blobId, id.blobId);
      assert.equal(operation.collectionId, P06_COLLECTION_A);
      assert.equal(operation.actorPrincipalId, owner.accountId);
      assert.equal(operation.payloadJson.generationId, id.generationId);
      assert.equal(operation.payloadJson.commandId, commandId);
      for (const key of ['sanitizedFilename', 'key', 'url', 'sha256', 'credential']) {
        assert.ok(!(key in operation.payloadJson), `operation payload must not carry ${key}`);
      }

      // Attachment metadata row: only owner-private snapshot facts.
      const attachment = await readAttachmentRow(isolated.runtime, id.blobId);
      assert.ok(attachment);
      assert.equal(attachment.attachmentId, attachmentId);
      assert.equal(attachment.blobId, id.blobId);
      assert.equal(attachment.collectionId, P06_COLLECTION_A);
      assert.equal(attachment.ownerSubjectId, owner.subjectId);
      assert.equal(attachment.sanitizedFilename, null);
      assert.equal(attachment.size, seedBody.byteLength, 'the verified size is bound, not a declared fiction');
      assert.equal(attachment.mediaType, 'image/png');
      assert.equal(attachment.logicalState, 'attached_private');
      assert.ok(attachment.attachedAt, 'attached_at must be DB-clock bound');
      assert.equal(attachment.retiredAt, null);
      assert.equal(attachment.deletedAt, null);

      // Blob binding: the handoff fenced the current generation.
      const binding = await readP06BlobBinding(isolated.runtime, id.blobId);
      assert.ok(binding);
      assert.equal(binding.logicalState, 'attached_private');
      assert.equal(binding.attachmentBindingId, attachmentId);
      assert.equal(binding.attachmentBindingGenerationId, id.generationId);
      assert.ok(binding.attachedAt);

      // Operation + Audit + Outbox: exactly one of each, closed payloads.
      const effects = await readFinalizeSideEffects(isolated.runtime, id.blobId, attachmentId, operation.operationId);
      assert.equal(effects.operations.length, 1);
      assert.equal(effects.audits.length, 1);
      assert.equal(effects.outbox.length, 1);
      const audit = effects.audits[0]!;
      assert.equal(audit.eventType, 'attachment.finalized');
      assert.equal(audit.principalId, owner.accountId);
      const outbox = effects.outbox[0]!;
      assert.equal(outbox.eventType, 'attachments.finalized');
      assert.equal(outbox.aggregateId, id.blobId);
      assert.equal(outbox.aggregateScope, attachmentId);
      assert.equal(outbox.state, 'pending');
      assert.ok(!('sanitizedFilename' in outbox.payloadJson) && !('key' in outbox.payloadJson)
        && !('url' in outbox.payloadJson), 'outbox payload carries no filename/key/URL');

      // Resource ledger: attachment + operation reserved; no physical facts.
      const ledger = new Set(await readLedgerIds(isolated.runtime));
      assert.ok(ledger.has(attachmentId), 'attachment id must be ledger-reserved');
      assert.ok(ledger.has(operation.operationId), 'operation id must be ledger-reserved');

      // Collection ordinal advanced exactly once.
      const collectionAfter = await readP02CollectionRow(isolated.runtime, P06_COLLECTION_A);
      assert.ok(collectionAfter);
      assert.equal(collectionAfter.commitOrdinal, collectionBefore.commitOrdinal + 1n);
    } finally {
      await bundle.app.close();
      await bundle.store.close();
    }
  });

  test('same-binding replay returns already_finalized with the ORIGINAL receipt and writes nothing', async () => {
    const id = identityFor(301);
    await seedP06StoredPrivate(isolated.runtime, id, p06BlobOwnerOf(owner));
    const commandId = randomUUID();
    const bundle = newApp();
    try {
      const first = await bundle.app.inject({
        method: 'POST', url: finalizeUrl(id.blobId), headers: finalizeHeaders(owner, commandId), payload: '{}',
      });
      assert.equal(first.statusCode, 200);
      const firstBody = first.json() as FinalizeResultBody;
      assert.equal(firstBody.kind, 'finalized');
      const ordinalBefore = await readP02CollectionRow(isolated.runtime, P06_COLLECTION_A);
      assert.ok(ordinalBefore);

      const replay = await bundle.app.inject({
        method: 'POST', url: finalizeUrl(id.blobId), headers: finalizeHeaders(owner, commandId), payload: '{}',
      });
      assert.equal(replay.statusCode, 200, replay.body);
      const replayBody = replay.json() as FinalizeResultBody;
      assert.equal(replayBody.kind, 'already_finalized');
      assert.equal(replayBody.blobId, firstBody.blobId);
      assert.equal(replayBody.logicalState, 'attached_private');

      // The committed identity is unchanged and no new row was written.
      assert.equal(await p06FinalizeOperationCount(isolated.runtime, commandId), 1, 'exactly one Operation per binding');
      assert.equal((await readOutboxRows(isolated.runtime, id.blobId)).length, 1, 'exactly one Outbox row');
      const attachment = await readAttachmentRow(isolated.runtime, id.blobId);
      assert.ok(attachment);
      assert.equal(attachment.attachmentId, expectedP06AttachmentId(owner.accountId, id.blobId, commandId));
      const ordinalAfter = await readP02CollectionRow(isolated.runtime, P06_COLLECTION_A);
      assert.ok(ordinalAfter);
      assert.equal(ordinalAfter.commitOrdinal, ordinalBefore.commitOrdinal, 'replay must not advance the ordinal');
    } finally {
      await bundle.app.close();
      await bundle.store.close();
    }
  });

  test('a different binding on the same blob is a permanent 409 attachment_state_conflict', async () => {
    const id = identityFor(302);
    await seedP06StoredPrivate(isolated.runtime, id, p06BlobOwnerOf(owner));
    const firstCommand = randomUUID();
    const otherCommand = randomUUID();
    const bundle = newApp();
    try {
      const first = await bundle.app.inject({
        method: 'POST', url: finalizeUrl(id.blobId), headers: finalizeHeaders(owner, firstCommand), payload: '{}',
      });
      assert.equal(first.statusCode, 200);
      const ordinalBefore = await readP02CollectionRow(isolated.runtime, P06_COLLECTION_A);
      assert.ok(ordinalBefore);

      for (const attempt of [1, 2]) {
        const conflict = await bundle.app.inject({
          method: 'POST', url: finalizeUrl(id.blobId), headers: finalizeHeaders(owner, otherCommand), payload: '{}',
        });
        assertStateConflict(conflict);
        assert.equal(conflict.headers['retry-after'], undefined);
      }
      const attachment = await readAttachmentRow(isolated.runtime, id.blobId);
      assert.ok(attachment);
      assert.equal(attachment.attachmentId, expectedP06AttachmentId(owner.accountId, id.blobId, firstCommand),
        'the committed binding is never overwritten');
      assert.equal(await p06FinalizeOperationCount(isolated.runtime, otherCommand), 0, 'the conflicting command never commits');
      const ordinalAfter = await readP02CollectionRow(isolated.runtime, P06_COLLECTION_A);
      assert.ok(ordinalAfter);
      assert.equal(ordinalAfter.commitOrdinal, ordinalBefore.commitOrdinal);
    } finally {
      await bundle.app.close();
      await bundle.store.close();
    }
  });

  test('the same Known-Command-Id on a DIFFERENT blob is 409 attachment_idempotency_conflict', async () => {
    const firstId = identityFor(303);
    const secondId = identityFor(304);
    await seedP06StoredPrivate(isolated.runtime, firstId, p06BlobOwnerOf(owner));
    await seedP06StoredPrivate(isolated.runtime, secondId, p06BlobOwnerOf(owner));
    const commandId = randomUUID();
    const bundle = newApp();
    try {
      const first = await bundle.app.inject({
        method: 'POST', url: finalizeUrl(firstId.blobId), headers: finalizeHeaders(owner, commandId), payload: '{}',
      });
      assert.equal(first.statusCode, 200);

      const conflict = await bundle.app.inject({
        method: 'POST', url: finalizeUrl(secondId.blobId), headers: finalizeHeaders(owner, commandId), payload: '{}',
      });
      assert.equal(conflict.statusCode, 409);
      const problem = (conflict.json() as FinalizeProblem).error;
      assert.equal(problem.code, 'attachment_idempotency_conflict');
      assert.equal(problem.recovery, 'user_action');
      assert.equal(conflict.headers['cache-control'], 'private, no-store');
      // The second blob stays stored_private: zero side effects.
      assert.equal(await readAttachmentRow(isolated.runtime, secondId.blobId), null);
      const secondBinding = await readP06BlobBinding(isolated.runtime, secondId.blobId);
      assert.ok(secondBinding);
      assert.equal(secondBinding.logicalState, 'stored_private');
      assert.equal(await p06FinalizeOperationCount(isolated.runtime, commandId), 1, 'only the first binding committed');
    } finally {
      await bundle.app.close();
      await bundle.store.close();
    }
  });

  test('non-stored states are 409 attachment_state_conflict with zero side effects', async () => {
    const states: Array<{ seed: typeof seedP06Issued; slot: number }> = [
      { seed: seedP06Issued, slot: 305 },
      { seed: seedP06Uploaded, slot: 306 },
      { seed: seedP06Verifying, slot: 307 },
      { seed: seedP06Expired, slot: 308 },
    ];
    const bundle = newApp();
    try {
      for (const { seed, slot } of states) {
        const id = identityFor(slot);
        await seed(isolated.runtime, id, p06BlobOwnerOf(owner));
        const commandId = randomUUID();
        const response = await bundle.app.inject({
          method: 'POST', url: finalizeUrl(id.blobId), headers: finalizeHeaders(owner, commandId), payload: '{}',
        });
        assertStateConflict(response);
        assert.equal(await readAttachmentRow(isolated.runtime, id.blobId), null, `no attachment for state seed ${slot}`);
        assert.equal(await p06FinalizeOperationCount(isolated.runtime, commandId), 0, `no operation for state seed ${slot}`);
        const binding = await readP06BlobBinding(isolated.runtime, id.blobId);
        assert.ok(binding);
        assert.notEqual(binding.logicalState, 'attached_private', `no binding for state seed ${slot}`);
      }
    } finally {
      await bundle.app.close();
      await bundle.store.close();
    }
  });

  test('an expired retention deadline is rejected 409 with zero side effects', async () => {
    const id = identityFor(309);
    await seedP06StoredPrivate(isolated.runtime, id, p06BlobOwnerOf(owner));
    // Negative control: the blob is a REAL stored_private generation whose
    // retention deadline has passed (the handoff checks the DB clock).
    await isolated.runtime.pool.query(
      'update blob_records set retention_deadline = now() - interval \'1 day\' where blob_id = $1',
      [id.blobId],
    );
    const bundle = newApp();
    try {
      const response = await bundle.app.inject({
        method: 'POST', url: finalizeUrl(id.blobId), headers: finalizeHeaders(owner, randomUUID()), payload: '{}',
      });
      assertStateConflict(response);
      assert.equal(await readAttachmentRow(isolated.runtime, id.blobId), null);
    } finally {
      await bundle.app.close();
      await bundle.store.close();
    }
  });

  test('a missing current-generation pointer is rejected 409 with zero side effects', async () => {
    const id = identityFor(310);
    await seedP06StoredPrivate(isolated.runtime, id, p06BlobOwnerOf(owner));
    await isolated.runtime.pool.query(
      'update blob_records set current_generation_id = null where blob_id = $1',
      [id.blobId],
    );
    const bundle = newApp();
    try {
      const response = await bundle.app.inject({
        method: 'POST', url: finalizeUrl(id.blobId), headers: finalizeHeaders(owner, randomUUID()), payload: '{}',
      });
      assertStateConflict(response);
      assert.equal(await readAttachmentRow(isolated.runtime, id.blobId), null);
    } finally {
      await bundle.app.close();
      await bundle.store.close();
    }
  });

});
