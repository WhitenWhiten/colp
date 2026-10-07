/**
 * P4A-P07 focused PostgreSQL suite (part 1): the production replacement
 * intent route.
 *
 * Boots the PRODUCTION app composition (`buildApiApp`) with the REAL
 * PostgreSQL attachments ports and the REAL R2 adapter over the local
 * create-only object server, and drives blobs through the REAL routes with
 * session cookie + Origin + CSRF + Known-Command-Id and INDEPENDENT HTTP PUTs
 * on real presigned grants.
 *
 * Covers the P07 replacement test scope (anti-false-positive / anti-false-
 * negative per plan §4):
 * - replacement BEFORE/AFTER owner status read: the new generation is
 *   complete-attested and CAS-activated in the complete route's canonical
 *   transaction, the blob is demoted to `uploaded` with cleared verified
 *   facts, and ONLY after the new current generation is digest-verified does
 *   the owner status read expose the NEW size/media facts (a test that only
 *   checked the current DB column, or switched after a synchronous DELETE of
 *   the old object, would not cover this);
 * - the replacement ALWAYS allocates a NEW physical key (asserted from the
 *   real grant URL path AND the ledger); same-key overwrite is impossible
 *   (create-only PUT on the old key -> 412; the permanent key tombstones);
 * - two sequential replacements: the current winner is unique and every
 *   superseded generation is `retired` with a distinct key (old/new markers
 *   are REAL bytes with different sizes);
 * - idempotent replay with the same Known-Command-Id recovers the SAME
 *   generation (never a second one); different facts -> 409
 *   attachment_idempotency_conflict;
 * - a late complete of the OLD generation cannot resurrect it (409
 *   attachment_state_conflict, the old generation stays retired) and the old
 *   grant PUT is rejected (create-only 412);
 * - concealment: member non-owner / outsider / terminal attachment -> 404;
 *   inadmissible states (issued) -> 409; anonymous -> 401.
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
} from '../../support/phase4a-p03-test-helpers.js';
import { describeWithPostgres } from '../../support/postgres-test-runtime.js';
import {
  P07_COLLECTION_A,
  P07_COLLECTION_B,
  p07BlobOwnerOf,
  p07Body,
  p07Cleanup,
  P07_CLEANUP_CONFIG,
  P07_CONFIG,
  p07Complete,
  p07Headers,
  p07KeyFromGrantUrl,
  p07Put,
  p07Replacement,
  p07ReplaceAndVerify,
  p07SeedCollection,
  p07Status,
  p07UploadToStored,
  p07VerifyToStored,
  readP07Blob,
  readP07Generation,
} from '../../support/phase4a-p07-test-helpers.js';
import { seedP06Issued } from '../../support/phase4a-p06-test-helpers.js';
import { identityFor } from '../../support/phase4a-i07-test-helpers.js';
import { runCleanupBatch } from '../../../src/modules/attachments/index.js';

const NOW = new Date('2026-08-08T12:00:00.000Z');

interface StatusBody {
  blobId: string;
  logicalState: string;
  verificationStatus: string;
  availability: string;
  size: number;
  mediaType: string | null;
  createdAt: string;
  updatedAt: string;
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

describeWithPostgres('P4A-P07 production replacement route', () => {
  let isolated: I07MigrationRuntime;
  let identityUnitOfWork: ReturnType<typeof createIdentityMemoryUnitOfWork>;
  let factory: ReturnType<typeof createInMemoryBetterAuthTestFactory>;
  let owner: AuthenticatedTestClient;
  let editor: AuthenticatedTestClient;
  let outsider: AuthenticatedTestClient;
  let otherOwner: AuthenticatedTestClient;
  let objectServer: P03ObjectServer;

  beforeAll(async () => {
    isolated = await createI07MigrationRuntime('phase4a_p07_replacement', { maxConnections: 16 });
    identityUnitOfWork = createIdentityMemoryUnitOfWork(createIdentityMemoryState(NOW));
    factory = createInMemoryBetterAuthTestFactory({ identityUnitOfWork });
    owner = await issueTestSession({
      factory,
      subject: 'p07-owner', handle: 'p07_owner' });
    editor = await issueTestSession({
      factory,
      subject: 'p07-editor', handle: 'p07_editor' });
    outsider = await issueTestSession({
      factory,
      subject: 'p07-outsider', handle: 'p07_outsider' });
    otherOwner = await issueTestSession({
      factory,
      subject: 'p07-other', handle: 'p07_other' });
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
      collectionId: 'p07-collection-other-owner',
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

  function newApp(): P03AppBundle {
    return buildP03App({
      runtime: isolated.runtime,
      databaseUrl: isolated.databaseUrl,
      identityUnitOfWork,
      browserSessionAuthority: factory.authority,
      objectServerUrl: objectServer.url,
      attachmentsConfig: P07_CONFIG,
    });
  }

  test('replacement issues a NEW generation with a NEW physical key; the owner status read shows the new verified facts after re-verification', async () => {
    const bundle = newApp();
    try {
      const oldBody = p07Body(1);
      const newBody = p07Body(2);
      assert.notEqual(oldBody.byteLength, newBody.byteLength, 'old/new markers must differ in SIZE');
      const oldGen = await p07UploadToStored(bundle.app, owner, isolated.runtime, {
        collectionId: P07_COLLECTION_A,
        body: oldBody,
      });

      // Owner status read BEFORE the replacement: the old verified facts.
      const before = await p07Status(bundle.app, owner, oldGen.blobId);
      assert.equal(before.statusCode, 200, before.body);
      const beforeView = JSON.parse(before.body) as StatusBody;
      assert.equal(beforeView.logicalState, 'stored_private');
      assert.equal(beforeView.verificationStatus, 'verified');
      assert.equal(beforeView.availability, 'available');
      assert.equal(beforeView.size, oldBody.byteLength);
      assert.ok(beforeView.allowedActions.includes('replace'), 'stored_private + active exposes replace');

      // Replacement intent: a NEW generation with a NEW physical key.
      const issued = await p07Replacement(bundle.app, owner, oldGen.blobId, { body: newBody });
      assert.equal(issued.statusCode, 201);
      assert.equal(issued.kind, 'issued');
      assert.equal(issued.receipt.blobId, oldGen.blobId);
      assert.notEqual(issued.receipt.generationId, oldGen.generationId, 'replacement must never reuse a generation');
      const newKey = p07KeyFromGrantUrl(issued.grant.url);
      assert.notEqual(newKey, oldGen.key, 'replacement must allocate a NEW physical key');
      assert.ok(newKey.startsWith(P07_CONFIG.r2.livePrefix));

      // Independent PUT on the NEW key + complete (CAS activation in the same
      // canonical transaction: old -> retired, new -> active, pointer moved).
      const { etag } = await p07Put(issued.grant.url, newBody);
      const complete = await p07Complete(bundle.app, owner, issued.receipt, newBody, etag, randomUUID());
      assert.equal(complete.statusCode, 200, complete.body);
      const completed = JSON.parse(complete.body) as { kind: string; receipt: { generationId: string } };
      assert.equal(completed.kind, 'completed');
      assert.equal(completed.receipt.generationId, issued.receipt.generationId);

      // Atomic activation facts: old generation retired (DB-clock retired_at),
      // new generation active, pointer on the new generation, blob demoted to
      // uploaded with cleared verified facts (the digest of the new current
      // generation is not verified yet).
      const oldRow = await readP07Generation(isolated.runtime, oldGen.generationId);
      assert.ok(oldRow);
      assert.equal(oldRow.generationState, 'retired');
      assert.ok(oldRow.retiredAt, 'retirement is DB-clock stamped');
      assert.equal(oldRow.retireReason, 'replaced');
      const newRow = await readP07Generation(isolated.runtime, issued.receipt.generationId);
      assert.ok(newRow);
      assert.equal(newRow.generationState, 'active');
      const blob = await readP07Blob(isolated.runtime, oldGen.blobId);
      assert.ok(blob);
      assert.equal(blob.currentGenerationId, issued.receipt.generationId);
      assert.equal(blob.logicalState, 'uploaded', 'the new current generation must be re-verified before stored_private');
      assert.equal(blob.verifiedSize, null, 'stale verified facts are cleared at activation');

      // Digest verification of the NEW current generation -> the status read
      // exposes the NEW verified facts (old/new markers differ in size).
      await p07VerifyToStored(isolated.runtime, oldGen.blobId, issued.receipt.generationId, newBody);
      const after = await p07Status(bundle.app, owner, oldGen.blobId);
      assert.equal(after.statusCode, 200, after.body);
      const afterView = JSON.parse(after.body) as StatusBody;
      assert.equal(afterView.logicalState, 'stored_private');
      assert.equal(afterView.verificationStatus, 'verified');
      assert.equal(afterView.size, newBody.byteLength, 'the status read must expose the NEW generation facts');
      assert.ok(afterView.allowedActions.includes('replace'));

      // The old key's bytes are still present (retention: external deletion
      // converges via cleanup, never synchronously with the switch).
      assert.equal(objectServer.has(oldGen.key), true, 'old body must survive until retention cleanup');
      assert.equal(objectServer.has(newKey), true, 'new body is present under the new key');

      // Cleanup converges the retired old generation after the retention
      // window (DB-time advance) and leaves the active marker untouched.
      await isolated.runtime.pool.query(
        `update blob_generations set retired_at = now() - interval '91 days' where generation_id = $1`,
        [oldGen.generationId],
      );
      const cleanup = await runCleanupBatch(p07Cleanup(isolated.runtime, bundle.moduleStore, P07_CLEANUP_CONFIG, 'p07-cleaner'));
      assert.deepEqual(cleanup.outcomes.map((o) => o.kind), ['deleted']);
      assert.equal(objectServer.has(oldGen.key), false, 'retired key is exact-absent after cleanup');
      assert.equal(objectServer.has(newKey), true, 'active marker bytes are preserved');
      const deletedRow = await readP07Generation(isolated.runtime, oldGen.generationId);
      assert.ok(deletedRow);
      assert.equal(deletedRow.generationState, 'deleted');
      assert.ok(deletedRow.confirmedAbsentAt, 'deletion evidence is recorded');
    } finally {
      await bundle.app.close();
      await bundle.store.close();
    }
  });

  test('replacement replay with the same Known-Command-Id recovers the SAME generation; different facts -> 409 idempotency conflict', async () => {
    // A monotonic signing clock makes every grant re-signing deterministic
    // (SigV4 URLs are identical within the same signing second; the local
    // object server never validates signatures, so the fresh-signature proof
    // must be pinned by the production adapter's injectable clock).
    let signedAt = NOW.getTime();
    const bundle = buildP03App({
      runtime: isolated.runtime,
      databaseUrl: isolated.databaseUrl,
      identityUnitOfWork,
      browserSessionAuthority: factory.authority,
      objectServerUrl: objectServer.url,
      attachmentsConfig: P07_CONFIG,
      storeClock: () => new Date((signedAt += 1_000)),
    });
    try {
      const oldBody = p07Body(11);
      const newBody = p07Body(12);
      const oldGen = await p07UploadToStored(bundle.app, owner, isolated.runtime, {
        collectionId: P07_COLLECTION_A,
        body: oldBody,
      });
      const commandId = randomUUID();

      const first = await p07Replacement(bundle.app, owner, oldGen.blobId, { body: newBody, commandId });
      assert.equal(first.statusCode, 201);
      assert.equal(first.kind, 'issued');
      const { etag } = await p07Put(first.grant.url, newBody);
      const complete = await p07Complete(bundle.app, owner, first.receipt, newBody, etag, randomUUID());
      assert.equal(complete.statusCode, 200, complete.body);
      // A second create-only PUT on the SAME grant URL is rejected (412) —
      // the old/new markers are never overwritten, only ever replaced.
      const replayPut = await fetch(first.grant.url, {
        method: 'PUT',
        headers: { 'If-None-Match': '*', 'Content-Type': 'application/octet-stream' },
        body: newBody as unknown as BodyInit,
        redirect: 'error',
      });
      assert.equal(replayPut.status, 412, 'create-only PUT replay must be rejected');

      // Replay of the SAME replacement command -> the SAME generation.
      const replay = await p07Replacement(bundle.app, owner, oldGen.blobId, { body: newBody, commandId });
      assert.equal(replay.statusCode, 201);
      assert.equal(replay.kind, 'recovered');
      assert.equal(replay.receipt.generationId, first.receipt.generationId, 'replay must recover the SAME generation');
      assert.notEqual(replay.grant.url, first.grant.url, 'a fresh grant is re-signed, the identity never changes');

      // Same command id with DIFFERENT declared facts -> permanent conflict.
      const differentFacts = await p07Replacement(bundle.app, owner, oldGen.blobId, {
        body: newBody,
        commandId,
        declaredSha256: 'a'.repeat(64),
      });
      assert.equal(differentFacts.statusCode, 409);
      assertProblem(differentFacts, 'attachment_idempotency_conflict');

      // Exactly ONE replacement generation exists for the binding.
      const rows = await isolated.runtime.pool.query<{ count: string }>(
        `select count(*)::text as count from upload_intents where blob_id = $1 and idempotency_key = $2`,
        [oldGen.blobId, commandId],
      );
      assert.equal(Number(rows.rows[0]!.count), 1, 'replay must never create a second generation');
    } finally {
      await bundle.app.close();
      await bundle.store.close();
    }
  });

  test('two sequential replacements: the current winner is unique and every superseded generation is retired with a distinct key', async () => {
    const bundle = newApp();
    try {
      const body1 = p07Body(21);
      const body2 = p07Body(22);
      const body3 = p07Body(23);
      const gen1 = await p07UploadToStored(bundle.app, owner, isolated.runtime, {
        collectionId: P07_COLLECTION_A,
        body: body1,
      });
      const gen2 = await p07ReplaceAndVerify(bundle.app, owner, isolated.runtime, gen1.blobId, body2);
      const gen3 = await p07ReplaceAndVerify(bundle.app, owner, isolated.runtime, gen1.blobId, body3);

      assert.notEqual(gen1.key, gen2.key);
      assert.notEqual(gen2.key, gen3.key);
      assert.notEqual(gen1.generationId, gen2.generationId);
      assert.notEqual(gen2.generationId, gen3.generationId);

      const g1 = await readP07Generation(isolated.runtime, gen1.generationId);
      const g2 = await readP07Generation(isolated.runtime, gen2.generationId);
      const g3 = await readP07Generation(isolated.runtime, gen3.generationId);
      assert.ok(g1 && g2 && g3);
      assert.equal(g1.generationState, 'retired');
      assert.equal(g2.generationState, 'retired');
      assert.equal(g3.generationState, 'active');
      assert.ok(g1.retiredAt && g2.retiredAt, 'both superseded generations are DB-clock retired');

      const blob = await readP07Blob(isolated.runtime, gen1.blobId);
      assert.ok(blob);
      assert.equal(blob.currentGenerationId, gen3.generationId, 'the current winner is the LAST replacement');
      assert.equal(blob.verifiedSize, body3.byteLength, 'the verified facts follow the current winner');

      // Exactly one active generation per blob.
      const active = await isolated.runtime.pool.query<{ count: string }>(
        `select count(*)::text as count from blob_generations
         where blob_id = $1 and generation_state = 'active'`,
        [gen1.blobId],
      );
      assert.equal(Number(active.rows[0]!.count), 1, 'current winner is unique');
    } finally {
      await bundle.app.close();
      await bundle.store.close();
    }
  });

  test('a late complete of the old generation cannot resurrect it; the old grant PUT is rejected (create-only)', async () => {
    const bundle = newApp();
    try {
      const oldBody = p07Body(31);
      const newBody = p07Body(32);
      const oldGen = await p07UploadToStored(bundle.app, owner, isolated.runtime, {
        collectionId: P07_COLLECTION_A,
        body: oldBody,
      });
      await p07ReplaceAndVerify(bundle.app, owner, isolated.runtime, oldGen.blobId, newBody);

      // Late complete replay of the OLD binding: the old generation is
      // retired -> stable 409 attachment_state_conflict, never a resurrection.
      const late = await p07Complete(bundle.app, owner,
        { blobId: oldGen.blobId, intentId: oldGen.intentId, generationId: oldGen.generationId },
        oldBody, oldGen.etag, randomUUID());
      assert.equal(late.statusCode, 409, late.body);
      assertProblem(late, 'attachment_state_conflict');
      const lateRow = await readP07Generation(isolated.runtime, oldGen.generationId);
      assert.ok(lateRow);
      assert.equal(lateRow.generationState, 'retired', 'the late complete must never resurrect the old generation');
      assert.equal(lateRow.observedEtag, oldGen.etag, 'the old observed facts are untouched');

      // The old grant URL can never overwrite: the object exists -> 412, and
      // the key is permanently tombstoned (a replacement grant for the old
      // key is impossible — every replacement allocates a new key). A direct
      // create-only PUT on the old key with the old body is rejected by the
      // object server (real create-only semantics, not a mock).
      const oldPut = await fetch(`${objectServer.url}/${P07_CONFIG.r2.bucket}/${oldGen.key}`, {
        method: 'PUT',
        headers: { 'If-None-Match': '*', 'Content-Type': 'application/octet-stream' },
        body: oldBody as unknown as BodyInit,
        redirect: 'error',
      });
      assert.equal(oldPut.status, 412, 'create-only semantics reject a second PUT on the old key');

      // The owner status read now exposes ONLY the new generation facts.
      const status = await p07Status(bundle.app, owner, oldGen.blobId);
      assert.equal(status.statusCode, 200);
      const view = JSON.parse(status.body) as StatusBody;
      assert.equal(view.size, newBody.byteLength);
    } finally {
      await bundle.app.close();
      await bundle.store.close();
    }
  });

  test('replacement concealment and inadmissible states: foreign/non-owner -> 404, issued -> 409, anonymous -> 401', async () => {
    const bundle = newApp();
    try {
      const oldBody = p07Body(41);
      const newBody = p07Body(42);
      const oldGen = await p07UploadToStored(bundle.app, owner, isolated.runtime, {
        collectionId: P07_COLLECTION_A,
        body: oldBody,
      });

      // Member non-owner and outsider are concealed identically (404).
      const editorAttempt = await p07Replacement(bundle.app, editor, oldGen.blobId, { body: newBody });
      assert.equal(editorAttempt.statusCode, 404, editorAttempt.body);
      assertProblem(editorAttempt, 'resource_not_found');
      const outsiderAttempt = await p07Replacement(bundle.app, outsider, oldGen.blobId, { body: newBody });
      assert.equal(outsiderAttempt.statusCode, 404);
      const foreignBlob = await p07UploadToStored(bundle.app, otherOwner, isolated.runtime, {
        collectionId: 'p07-collection-other-owner',
        body: p07Body(43),
      });
      const crossOwner = await p07Replacement(bundle.app, owner, foreignBlob.blobId, { body: newBody });
      assert.equal(crossOwner.statusCode, 404, 'cross-owner replacement is concealed');

      // Anonymous: the mutation gate requires a session -> 401.
      const anonymous = await bundle.app.inject({
        method: 'POST',
        url: `/api/v1/attachments/${encodeURIComponent(oldGen.blobId)}/replacement`,
        headers: { origin: 'https://app.known.example', 'content-type': 'application/json' },
        payload: JSON.stringify({ declaredSize: newBody.byteLength }),
      });
      assert.equal(anonymous.statusCode, 401);

      // Inadmissible logical state (issued, no active generation) -> 409.
      const issuedId = identityFor(44);
      await seedP06Issued(isolated.runtime, issuedId, p07BlobOwnerOf(owner), P07_COLLECTION_A);
      const issuedAttempt = await p07Replacement(bundle.app, owner, issuedId.blobId, { body: newBody });
      assert.equal(issuedAttempt.statusCode, 409, issuedAttempt.body);
      assertProblem(issuedAttempt, 'attachment_state_conflict');

      // Body-shape validation: unknown field -> 422; oversize -> 413; missing
      // declaredSize -> 422.
      const unknown = await bundle.app.inject({
        method: 'POST',
        url: `/api/v1/attachments/${encodeURIComponent(oldGen.blobId)}/replacement`,
        headers: p07Headers(owner, randomUUID()),
        payload: JSON.stringify({ declaredSize: newBody.byteLength, bogus: 1 }),
      });
      assert.equal(unknown.statusCode, 422);
      assertProblem(unknown, 'invalid_document');
      const oversize = await bundle.app.inject({
        method: 'POST',
        url: `/api/v1/attachments/${encodeURIComponent(oldGen.blobId)}/replacement`,
        headers: p07Headers(owner, randomUUID()),
        payload: JSON.stringify({ declaredSize: P07_CONFIG.singlePutMaxBytes + 1 }),
      });
      assert.equal(oversize.statusCode, 413);
      assertProblem(oversize, 'payload_too_large');
      const missing = await bundle.app.inject({
        method: 'POST',
        url: `/api/v1/attachments/${encodeURIComponent(oldGen.blobId)}/replacement`,
        headers: p07Headers(owner, randomUUID()),
        payload: JSON.stringify({}),
      });
      assert.equal(missing.statusCode, 422);
      assertProblem(missing, 'invalid_document');

      // The committed generation is untouched by every rejection.
      const blob = await readP07Blob(isolated.runtime, oldGen.blobId);
      assert.ok(blob);
      assert.equal(blob.currentGenerationId, oldGen.generationId);
      assert.equal(blob.verifiedSize, oldBody.byteLength);
      assert.equal(await readP07Generation(isolated.runtime, oldGen.generationId).then((row) => row?.generationState), 'active');
    } finally {
      await bundle.app.close();
      await bundle.store.close();
    }
  });
});
