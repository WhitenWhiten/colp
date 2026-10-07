/**
 * P4A-P07 focused PostgreSQL suite (part 3): deterministic races across the
 * replacement/retire/cleanup lifecycle over the PRODUCTION ledger ports and
 * the PRODUCTION app composition.
 *
 * Every concurrency claim uses TWO INDEPENDENT connections with deterministic
 * promise barriers (`BarrierGroup`) at the production port phase points —
 * never a short timeout misreported as safety:
 * - two concurrent replacement activations on one blob: exactly ONE
 *   `activated` (the current winner), the other `stale_cas`, the current
 *   pointer is unique and the loser's generation stays `observed`; after the
 *   production verification converges the owner status read exposes ONLY the
 *   winner's facts (old/new markers are real bytes with different sizes);
 * - replacement activation vs finalize handoff: the fenced handoff that read
 *   the OLD generation never binds after the pointer moved — the finalize
 *   CAS misses and the whole request rolls back with zero Operation/Audit/
 *   Outbox/Attachment side effects, and the replacement winner finalizes
 *   cleanly afterwards;
 * - cleanup claim vs replacement activation: the coordinator claims the
 *   retired old generation (claim committed) while a NEW replacement moves
 *   the pointer — the claim's exact-key DELETE converges for the old key
 *   only, the newly-activated marker is preserved and the retire/delete
 *   fences never cross;
 * - retire vs replacement activation: `attached_private` is terminal — the
 *   retire commits and the concurrent activation is `attached_not_replaced`
 *   (the pointer can never move on a bound blob; the replacement generation
 *   stays `observed`).
 *
 * Anti-false-positive: no sequential "replacement then cleanup" calls, no
 * checking only the current DB column, no SQL that rewrites lease owners or
 * states — every interleaving asserts the provider bytes (object server
 * markers) and the exact per-generation rows. Anti-false-negative: each
 * interleaving is proven by barrier phase arrival, not by a sleep.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
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
  type P03FinalizeSeams,
  type P03RetireSeams,
} from '../../support/phase4a-p03-test-helpers.js';
import { describeWithPostgres } from '../../support/postgres-test-runtime.js';
import { BarrierGroup } from '../../support/phase4a-i07-test-helpers.js';
import { appendAttachmentsVerificationOutbox } from '../../../src/infrastructure/outbox/index.js';
import { createPostgresAttachmentsPorts, createUnitOfWork } from '../../../src/infrastructure/database/index.js';
import { runCleanupBatch } from '../../../src/modules/attachments/index.js';
import {
  P07_COLLECTION_A,
  p07Body,
  p07Cleanup,
  P07_CLEANUP_CONFIG,
  p07Finalize,
  p07KeyFromGrantUrl,
  p07Put,
  p07Replacement,
  p07SeedCollection,
  p07Status,
  p07UploadToStored,
  p07VerifyToStored,
  readP07Blob,
  readP07Generation,
  readP07Attachment,
  readP07OperationByCommandId,
} from '../../support/phase4a-p07-test-helpers.js';

const NOW = new Date('2026-08-08T12:00:00.000Z');
const ports = createPostgresAttachmentsPorts();

/** A promise pair that blocks until explicitly released (deterministic). */
function gate(): { arrive(): Promise<void>; release(): void } {
  let release: () => void = () => undefined;
  const arrived = new Promise<void>((resolvePromise) => {
    release = resolvePromise;
  });
  return {
    arrive: () => arrived,
    release,
  };
}

describeWithPostgres('P4A-P07 replacement/retire/cleanup races', () => {
  let isolated: I07MigrationRuntime;
  let identityUnitOfWork: ReturnType<typeof createIdentityMemoryUnitOfWork>;
  let factory: ReturnType<typeof createInMemoryBetterAuthTestFactory>;
  let owner: AuthenticatedTestClient;
  let objectServer: P03ObjectServer;

  beforeAll(async () => {
    isolated = await createI07MigrationRuntime('phase4a_p07_races', { maxConnections: 24 });
    identityUnitOfWork = createIdentityMemoryUnitOfWork(createIdentityMemoryState(NOW));
    factory = createInMemoryBetterAuthTestFactory({ identityUnitOfWork });
    owner = await issueTestSession({
      factory,
      subject: 'p07-races-owner', handle: 'p07_races_owner' });
    await p07SeedCollection(isolated.runtime, {
      collectionId: P07_COLLECTION_A,
      ownerSubjectId: owner.subjectId,
      members: [{ subjectId: owner.subjectId, role: 'owner' }],
    });
    objectServer = new P03ObjectServer();
    await objectServer.start();
  }, 120_000);

  afterAll(async () => {
    await objectServer?.close();
    await isolated?.dropSchema();
  });

  function newApp(seams: { readonly finalizeSeams?: P03FinalizeSeams; readonly retireSeams?: P03RetireSeams } = {}): P03AppBundle {
    return buildP03App({
      runtime: isolated.runtime,
      databaseUrl: isolated.databaseUrl,
      identityUnitOfWork,
      browserSessionAuthority: factory.authority,
      objectServerUrl: objectServer.url,
      attachmentsConfig: P07_CLEANUP_CONFIG,
      ...(seams.finalizeSeams === undefined ? {} : { finalizeSeams: seams.finalizeSeams }),
      ...(seams.retireSeams === undefined ? {} : { retireSeams: seams.retireSeams }),
    });
  }

  /**
   * Issues a replacement intent, PUTs the new body and completes the
   * generation through the PRODUCTION ledger `complete` port — the generation
   * reaches `observed` WITHOUT the auto-activation the complete use case
   * performs, so the test controls the CAS activation interleaving itself.
   */
  async function issueObservedReplacement(
    bundle: P03AppBundle,
    blobId: string,
    body: Uint8Array,
  ): Promise<{ generationId: string; intentId: string; key: string; body: Uint8Array }> {
    const issued = await p07Replacement(bundle.app, owner, blobId, { body });
    assert.equal(issued.statusCode, 201, `replacement issue failed: ${issued.statusCode}`);
    const key = p07KeyFromGrantUrl(issued.grant.url);
    const { etag } = await p07Put(issued.grant.url, body);
    await createUnitOfWork(isolated.runtime.db).execute(async ({ transaction }) => {
      const completed = await ports.complete(transaction, {
        intentId: issued.receipt.intentId,
        generationId: issued.receipt.generationId,
        blobId,
        observedEtag: etag,
        observedSize: body.byteLength,
        observedContentType: 'application/octet-stream',
        observedMetadata: {},
      });
      assert.equal(completed.outcome, 'verified_observed', `expected observed, got ${completed.outcome}`);
    });
    return { generationId: issued.receipt.generationId, intentId: issued.receipt.intentId, key, body };
  }

  /** Production verification convergence for a generation the use case never
   * completed (the complete use case enqueues this exact outbox row). */
  async function verifyWinner(blobId: string, generationId: string, intentId: string, body: Uint8Array): Promise<void> {
    await createUnitOfWork(isolated.runtime.db).execute(async ({ transaction }) => {
      await appendAttachmentsVerificationOutbox(transaction, { blobId, generationId, intentId });
    });
    await p07VerifyToStored(isolated.runtime, blobId, generationId, body);
  }

  test('two concurrent replacement activations: exactly one current winner, one stale_cas, active unique, owner read exposes ONLY the winner', async () => {
    const bundle = newApp();
    try {
      const body1 = p07Body(71);
      const body2 = p07Body(72);
      const body3 = p07Body(73);
      const gen1 = await p07UploadToStored(bundle.app, owner, isolated.runtime, {
        collectionId: P07_COLLECTION_A,
        body: body1,
      });
      const gen2 = await issueObservedReplacement(bundle, gen1.blobId, body2);
      const gen3 = await issueObservedReplacement(bundle, gen1.blobId, body3);

      const group = new BarrierGroup();
      const activation = (newGenerationId: string) => createUnitOfWork(isolated.runtime.db).execute(({ transaction }) =>
        ports.activateReplacement(transaction, {
          blobId: gen1.blobId,
          expectedActiveGenerationId: gen1.generationId,
          newGenerationId,
        }, { barrier: group }));

      const winnerPromise = activation(gen2.generationId);
      const loserPromise = activation(gen3.generationId);
      await group.waitAllArrived(['replacement_cas'], 2);
      group.release('replacement_cas');
      const [first, second] = await Promise.all([winnerPromise, loserPromise]);

      // Exactly one CAS won; the loser saw the moved pointer (stale_cas).
      const outcomes = [first.outcome, second.outcome].sort();
      assert.deepEqual(outcomes, ['activated', 'stale_cas'], `got ${JSON.stringify(outcomes)}`);
      const blob = await readP07Blob(isolated.runtime, gen1.blobId);
      assert.ok(blob);
      assert.ok(blob.currentGenerationId, 'the current winner is set');
      const winnerGeneration = blob.currentGenerationId;
      const winnerBody = winnerGeneration === gen2.generationId ? gen2.body : gen3.body;
      const loserGeneration = winnerGeneration === gen2.generationId ? gen3.generationId : gen2.generationId;

      const winnerRow = await readP07Generation(isolated.runtime, winnerGeneration);
      const loserRow = await readP07Generation(isolated.runtime, loserGeneration);
      assert.ok(winnerRow && loserRow);
      assert.equal(winnerRow.generationState, 'active', 'the current winner is active');
      assert.equal(loserRow.generationState, 'observed', 'the loser stays observed, never resurrected');
      const g1 = await readP07Generation(isolated.runtime, gen1.generationId);
      assert.ok(g1);
      assert.equal(g1.generationState, 'retired');

      // The current winner is unique: exactly one active generation per blob.
      const active = await isolated.runtime.pool.query<{ count: string }>(
        `select count(*)::text as count from blob_generations
         where blob_id = $1 and generation_state = 'active'`,
        [gen1.blobId],
      );
      assert.equal(Number(active.rows[0]!.count), 1, 'current winner is unique');

      // Production verification converges the winner; the owner status read
      // exposes ONLY the winner's real facts (markers differ in size).
      await verifyWinner(gen1.blobId, winnerGeneration, winnerGeneration === gen2.generationId ? gen2.intentId : gen3.intentId, winnerBody);
      const status = await p07Status(bundle.app, owner, gen1.blobId);
      assert.equal(status.statusCode, 200, status.body);
      const view = JSON.parse(status.body) as { logicalState: string; size: number };
      assert.equal(view.logicalState, 'stored_private');
      assert.equal(view.size, winnerBody.byteLength);
      assert.equal(objectServer.has(winnerGeneration === gen2.generationId ? gen2.key : gen3.key), true);
    } finally {
      await bundle.app.close();
      await bundle.store.close();
    }
  });

  test('replacement activation vs finalize handoff: the fenced handoff never binds a replaced generation (zero side effects) and the winner finalizes cleanly', async () => {
    const group = new BarrierGroup();
    const bundle2 = newApp({ finalizeSeams: { barrier: group } });
    try {
      const body1 = p07Body(74);
      const body2 = p07Body(75);
      const gen1 = await p07UploadToStored(bundle2.app, owner, isolated.runtime, {
        collectionId: P07_COLLECTION_A,
        body: body1,
      });
      const gen2 = await issueObservedReplacement(bundle2, gen1.blobId, body2);

      // A: the finalize route reads the OLD facts, then parks INSIDE the
      // canonical transaction at the collection-lock phase (holding ONLY the
      // collection lock — its blob-row lock is still ahead). B: the
      // replacement activation parks at the CAS barrier. B commits FIRST
      // (the pointer moves, old generation retired), then A's fenced handoff
      // re-reads the blob under its own FOR UPDATE lock and must miss.
      const finalizeCommandId = randomUUID();
      const finalizePromise = bundle2.app.inject({
        method: 'POST',
        url: `/api/v1/attachments/${encodeURIComponent(gen1.blobId)}/finalize`,
        headers: {
          cookie: owner.cookie,
          origin: 'https://app.known.example',
          'x-csrf-token': owner.csrfToken,
          'known-command-id': finalizeCommandId,
          'content-type': 'application/json',
        },
        payload: '{}',
      });
      const activationPromise = createUnitOfWork(isolated.runtime.db).execute(({ transaction }) =>
        ports.activateReplacement(transaction, {
          blobId: gen1.blobId,
          expectedActiveGenerationId: gen1.generationId,
          newGenerationId: gen2.generationId,
        }, { barrier: group }));

      await group.waitAllArrived(['replacement_cas', 'attachment_collection_locked'], 1);
      group.release('replacement_cas');
      const activation = await activationPromise;
      assert.equal(activation.outcome, 'activated', `activation must win this interleaving, got ${activation.outcome}`);
      // The canonical finalize parks TWICE: at the collection-lock phase and
      // again inside the handoff (after its authoritative blob-row re-read).
      // Both must be released — the handoff re-read already saw the moved
      // pointer, so its evaluation must miss.
      group.release('attachment_collection_locked');
      group.release('after_finalize_handoff_lock');
      const finalize = await finalizePromise;
      assert.equal(finalize.statusCode, 409, finalize.body);
      assert.equal((JSON.parse(finalize.body) as { error: { code: string } }).error.code, 'attachment_state_conflict');

      // Zero finalize side effects: no metadata row, no binding, no
      // Operation/Audit/Outbox, ordinal untouched.
      assert.equal(await readP07Attachment(isolated.runtime, gen1.blobId), null, 'no half-committed Attachment metadata');
      const blob = await readP07Blob(isolated.runtime, gen1.blobId);
      assert.ok(blob);
      assert.equal(blob.currentGenerationId, gen2.generationId, 'the pointer stayed on the replacement winner');
      const sideEffects = await readP07OperationByCommandId(
        isolated.runtime, 'attachment.finalized', finalizeCommandId,
      );
      assert.equal(sideEffects, null, 'no half-committed Operation');
      const g2 = await readP07Generation(isolated.runtime, gen2.generationId);
      assert.ok(g2);
      assert.equal(g2.generationState, 'active');

      // The replacement winner converges and finalizes cleanly afterwards.
      await verifyWinner(gen1.blobId, gen2.generationId, gen2.intentId, gen2.body);
      const finalizeOk = await p07Finalize(bundle2.app, owner, gen1.blobId, randomUUID());
      assert.equal(finalizeOk.statusCode, 200, finalizeOk.body);
      assert.equal((JSON.parse(finalizeOk.body) as { kind: string }).kind, 'finalized');
    } finally {
      await bundle2.app.close();
      await bundle2.store.close();
    }
  });

  test('cleanup claim vs replacement activation: the claimed old key converges exactly once while the new active marker is preserved', async () => {
    const bundle = newApp();
    try {
      const body1 = p07Body(76);
      const body2 = p07Body(77);
      const body3 = p07Body(78);
      const gen1 = await p07UploadToStored(bundle.app, owner, isolated.runtime, {
        collectionId: P07_COLLECTION_A,
        body: body1,
      });
      // First replacement (route-complete auto-activation): gen1 retired,
      // gen2 active + verified.
      const gen2 = await p07Replacement(bundle.app, owner, gen1.blobId, { body: body2 });
      assert.equal(gen2.statusCode, 201);
      const gen2Key = p07KeyFromGrantUrl(gen2.grant.url);
      const { etag: etag2 } = await p07Put(gen2.grant.url, body2);
      const complete2 = await bundle.app.inject({
        method: 'POST',
        url: '/api/v1/attachments/complete',
        headers: {
          cookie: owner.cookie,
          origin: 'https://app.known.example',
          'x-csrf-token': owner.csrfToken,
          'known-command-id': randomUUID(),
          'content-type': 'application/json',
        },
        payload: JSON.stringify({
          binding: { blobId: gen1.blobId, intentId: gen2.receipt.intentId, generationId: gen2.receipt.generationId },
          declared: { size: body2.byteLength, sha256: createHash('sha256').update(body2).digest('hex'), mediaType: 'image/png', etag: etag2 },
        }),
      });
      assert.equal(complete2.statusCode, 200, complete2.body);
      await p07VerifyToStored(isolated.runtime, gen1.blobId, gen2.receipt.generationId, body2);
      // gen3 observed (ledger-port complete, activation controlled below).
      const gen3 = await issueObservedReplacement(bundle, gen1.blobId, body3);

      // The old generation crosses the retention window on the DB clock.
      await isolated.runtime.pool.query(
        `update blob_generations set retired_at = now() - interval '91 days' where generation_id = $1`,
        [gen1.generationId],
      );

      // A: the cleanup coordinator claims the retired old generation and
      // parks AFTER the claim committed (a separate `claimCommitted` signal
      // proves the claim landed; the gate then parks the coordinator until
      // the activation won). B: the replacement activation for gen3 parks at
      // the CAS barrier; B moves the pointer to gen3 first.
      const afterClaim = gate();
      let claimReached: () => void = () => undefined;
      const claimCommitted = new Promise<void>((resolvePromise) => {
        claimReached = resolvePromise;
      });
      const cleanupPromise = runCleanupBatch(p07Cleanup(isolated.runtime, bundle.moduleStore, P07_CLEANUP_CONFIG, 'p07-race-cleaner', {
        afterClaim: async () => {
          claimReached();
          await afterClaim.arrive();
        },
      }));
      const group = new BarrierGroup();
      const activationPromise = createUnitOfWork(isolated.runtime.db).execute(({ transaction }) =>
        ports.activateReplacement(transaction, {
          blobId: gen1.blobId,
          expectedActiveGenerationId: gen2.receipt.generationId,
          newGenerationId: gen3.generationId,
        }, { barrier: group }));

      // Wait until the claim COMMITTED and the coordinator is parked, then
      // run the activation to completion before releasing the coordinator.
      await claimCommitted;
      await group.waitAllArrived(['replacement_cas'], 1);
      group.release('replacement_cas');
      const activation = await activationPromise;
      assert.equal(activation.outcome, 'activated', `activation must win, got ${activation.outcome}`);
      afterClaim.release();
      const cleanup = await cleanupPromise;

      // Exactly the claimed OLD key converges; the new active marker and the
      // intermediate retired marker are preserved (bytes on the object server).
      assert.deepEqual(cleanup.outcomes.map((o) => o.kind), ['deleted'], JSON.stringify(cleanup.outcomes));
      assert.equal(objectServer.has(gen1.key), false, 'the retired old key is exact-absent');
      assert.equal(objectServer.has(gen2Key), true, 'the intermediate retired marker is preserved (window not crossed)');
      assert.equal(objectServer.has(gen3.key), true, 'the newly activated active marker is preserved');
      const g1 = await readP07Generation(isolated.runtime, gen1.generationId);
      assert.ok(g1);
      assert.equal(g1.generationState, 'deleted');
      assert.ok(g1.confirmedAbsentAt, 'deletion evidence is recorded');
      const g3 = await readP07Generation(isolated.runtime, gen3.generationId);
      assert.ok(g3);
      assert.equal(g3.generationState, 'active');
      const blob = await readP07Blob(isolated.runtime, gen1.blobId);
      assert.ok(blob);
      assert.equal(blob.currentGenerationId, gen3.generationId, 'the pointer follows the NEW winner');
    } finally {
      await bundle.app.close();
      await bundle.store.close();
    }
  });

  test('retire vs replacement activation: attached_private is terminal — retire commits and the activation is attached_not_replaced', async () => {
    const group = new BarrierGroup();
    const bundle = newApp({ retireSeams: { barrier: group } });
    try {
      const body1 = p07Body(79);
      const body2 = p07Body(80);
      const gen1 = await p07UploadToStored(bundle.app, owner, isolated.runtime, {
        collectionId: P07_COLLECTION_A,
        body: body1,
      });
      const gen2 = await issueObservedReplacement(bundle, gen1.blobId, body2);
      const finalize = await p07Finalize(bundle.app, owner, gen1.blobId, randomUUID());
      assert.equal(finalize.statusCode, 200, finalize.body);
      assert.equal((JSON.parse(finalize.body) as { logicalState: string }).logicalState, 'attached_private');

      // A: the retire command parks after the collection lock. B: the
      // replacement activation parks at the CAS barrier. A commits FIRST —
      // the retirement is terminal, so B can never move the pointer.
      const retireCommandId = randomUUID();
      const retirePromise = bundle.app.inject({
        method: 'POST',
        url: `/api/v1/attachments/${encodeURIComponent(gen1.blobId)}/retire`,
        headers: {
          cookie: owner.cookie,
          origin: 'https://app.known.example',
          'x-csrf-token': owner.csrfToken,
          'known-command-id': retireCommandId,
          'content-type': 'application/json',
        },
        payload: '{}',
      });
      const activationPromise = createUnitOfWork(isolated.runtime.db).execute(({ transaction }) =>
        ports.activateReplacement(transaction, {
          blobId: gen1.blobId,
          expectedActiveGenerationId: gen1.generationId,
          newGenerationId: gen2.generationId,
        }, { barrier: group }));

      await group.waitAllArrived(['attachment_retire_collection_locked', 'replacement_cas'], 1);
      group.release('attachment_retire_collection_locked');
      const retire = await retirePromise;
      assert.equal(retire.statusCode, 200, retire.body);
      assert.equal((JSON.parse(retire.body) as { kind: string }).kind, 'retired');
      group.release('replacement_cas');
      const activation = await activationPromise;
      assert.equal(activation.outcome, 'attached_not_replaced', `the pointer can never move on a bound blob, got ${activation.outcome}`);

      // Terminal state: attachment retired, pointer cleared, the replacement
      // generation stays observed (never activated, never deleted).
      const attachment = await readP07Attachment(isolated.runtime, gen1.blobId);
      assert.ok(attachment);
      assert.equal(attachment.logicalState, 'retired');
      const blob = await readP07Blob(isolated.runtime, gen1.blobId);
      assert.ok(blob);
      assert.equal(blob.currentGenerationId, null, 'the retire cleared the pointer');
      const g2 = await readP07Generation(isolated.runtime, gen2.generationId);
      assert.ok(g2);
      assert.equal(g2.generationState, 'observed', 'the replacement generation is never activated');
      const g1 = await readP07Generation(isolated.runtime, gen1.generationId);
      assert.ok(g1);
      assert.equal(g1.generationState, 'retired');
    } finally {
      await bundle.app.close();
      await bundle.store.close();
    }
  });
});
