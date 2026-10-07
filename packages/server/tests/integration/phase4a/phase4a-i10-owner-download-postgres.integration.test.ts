/**
 * P4A-I10 PostgreSQL integration suite: owner-private download admission
 * against the PRODUCTION migration with real PostgreSQL (two connections for
 * every concurrency claim, deterministic barriers, DB clock semantics).
 *
 * Proves at the token level (the exact verifier logic I11 will consume):
 * - the production port resolves the CURRENT active generation from the opaque
 *   blob id and never exposes the physical key;
 * - the uploading owner obtains a short-lived, audience-bound GET capability
 *   that the production verifier + an independent delivery-attempt stub accept
 *   (nonzero body, no redirect, no-store);
 * - every non-owner identity/state (same-Collection member, cross-Collection
 *   owner, outsider with the real blob id, intercepted EXPIRED capability)
 *   gets zero body and can never obtain a capability;
 * - replacement binds the capability to the generation current at admission:
 *   an old capability can never serve the new generation (frozen policy);
 * - a barrier between the authorization read and capability issuance freezes
 *   the decision (revocation/replacement while the admission holds the read
 *   lock), while a LATER admission always reads the current facts (no caching).
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { Pool } from 'pg';
import { afterAll, beforeAll, test } from 'vitest';
import {
  createPostgresAccessPolicyFactsPort,
} from '../../../src/infrastructure/access-policy/index.js';
import { createPostgresAttachmentsPorts, createUnitOfWork } from '../../../src/infrastructure/database/index.js';
import type { DatabaseTransaction } from '../../../src/infrastructure/database/index.js';
import {
  authorizeOwnerDownload,
  createDeliveryRateLimiter,
  createHmacOwnerDeliveryCapabilitySigner,
  type AuthorizeOwnerDownloadDeps,
} from '../../../src/modules/attachments/index.js';
import { describeWithPostgres } from '../../support/postgres-test-runtime.js';
import {
  BarrierGroup,
  createI07MigrationRuntime,
  type I07MigrationRuntime,
} from '../../support/phase4a-i07-test-helpers.js';
import {
  I10_COLLECTION_A,
  I10_COLLECTION_B,
  I10_DELIVERY_ORIGIN,
  I10_DELIVERY_SECRET,
  I10_PRINCIPAL_EDITOR,
  I10_PRINCIPAL_MEMBER,
  I10_PRINCIPAL_OTHER_OWNER,
  I10_PRINCIPAL_OWNER,
  I10_PRINCIPAL_OUTSIDER,
  I10_SUBJECT_EDITOR,
  I10_SUBJECT_MEMBER,
  I10_SUBJECT_OTHER_OWNER,
  I10_SUBJECT_OUTSIDER,
  I10_SUBJECT_OWNER,
  DeliveryAttemptStub,
  allocateInput,
  identityFor,
  makeActor,
  makeI10Config,
  sha256HexBytes,
} from '../../support/phase4a-i10-test-helpers.js';

const ports = createPostgresAttachmentsPorts();
const FIXED_NOW = new Date('2026-08-08T12:00:00.000Z');

async function seedCollection(runtime: I07MigrationRuntime['runtime'], collectionId: string, ownerSubjectId: string): Promise<void> {
  const rootId = `${collectionId}-root`;
  await createUnitOfWork(runtime.db).execute(async ({ transaction }) => {
    await sql`
      insert into resource_id_ledger (resource_id, resource_type)
      values (${collectionId}, 'collection'), (${rootId}, 'node')
    `.execute(transaction);
    await sql`
      insert into collections
        (id, owner_subject_id, title, kind, root_node_id, resource_revision,
         content_revision, policy_revision, visibility, commit_ordinal, created_at, updated_at)
      values (${collectionId}, ${ownerSubjectId}, 'I10 collection', 'bookmarks', ${rootId},
        ${`resource-${collectionId}`}, ${`content-${collectionId}`}, 'policy-r1', 'private', 1, now(), now())
    `.execute(transaction);
    await sql`
      insert into nodes (id, collection_id, kind, is_root, title, resource_revision, children_revision)
      values (${rootId}, ${collectionId}, 'folder', true, 'Root', 'r1', 'ch1')
    `.execute(transaction);
  });
}

async function seedMembership(runtime: I07MigrationRuntime['runtime'], collectionId: string, subjectId: string, role: 'owner' | 'editor' | 'viewer'): Promise<void> {
  await runtime.pool.query(
    'insert into collection_members (collection_id, subject_id, role, granted_at) values ($1, $2, $3, now())',
    [collectionId, subjectId, role],
  );
}

/**
 * Soft-delete/restore the collection AND its root node in ONE transaction: the
 * deferred `collections_root_lifecycle_integrity` trigger requires the pair to
 * stay in parity at commit time.
 */
async function softDeleteCollection(runtime: I07MigrationRuntime['runtime'], collectionId: string, deleted: boolean): Promise<void> {
  await createUnitOfWork(runtime.db).execute(async ({ transaction }) => {
    if (deleted) {
      await sql`update collections set deleted_at = now(), updated_at = now() where id = ${collectionId}`.execute(transaction);
      await sql`update nodes set deleted_at = now() where collection_id = ${collectionId}`.execute(transaction);
    } else {
      await sql`update collections set deleted_at = null, updated_at = now() where id = ${collectionId}`.execute(transaction);
      await sql`update nodes set deleted_at = null where collection_id = ${collectionId}`.execute(transaction);
    }
  });
}

/** Drives the PRODUCTION ledger to `stored_private` with an active generation. */
async function seedStoredPrivate(
  runtime: I07MigrationRuntime['runtime'],
  id: ReturnType<typeof identityFor>,
  body: Uint8Array,
  options: { collectionId: string; ownerSubjectId: string; principalId: string },
): Promise<void> {
  const digest = sha256HexBytes(body);
  await createUnitOfWork(runtime.db).execute(async ({ transaction }) => {
    const allocated = await ports.allocate(transaction, allocateInput(id, {
      collectionId: options.collectionId,
      subjectIdentity: options.ownerSubjectId,
      principalId: options.principalId,
      expectedSize: body.byteLength,
      expectedSha256: digest,
      mediaHint: 'image/png',
    }));
    assert.equal(allocated.outcome, 'issued');
    const cas = await ports.completeUploadCas(transaction, {
      intentId: id.intentId,
      generationId: id.generationId,
      blobId: id.blobId,
      actorPrincipalId: options.principalId,
      declaredSize: body.byteLength,
      declaredSha256: digest,
      declaredMediaType: 'image/png',
      observedEtag: `"etag-${id.generationId}"`,
      observedSize: body.byteLength,
      observedContentType: 'image/png',
      observedMetadata: {},
    });
    assert.equal(cas.outcome, 'uploaded');
  });
  await createUnitOfWork(runtime.db).execute(async ({ transaction }) => {
    const attempt = { outboxId: `outbox-${id.generationId}`, leaseGeneration: '1' };
    // claimVerification fences on a LEASED outbox row (plan §6 I09: the worker
    // claims the verification event before the verification CAS). The seed
    // drives the production port directly, so mirror the production enqueue
    // shape (appendAttachmentsVerificationOutbox) but in the post-claim
    // 'leased' state (lease_generation 1, locked_until in the future).
    const domainEventId = randomUUID();
    await sql`
      insert into resource_id_ledger (resource_id, resource_type)
      values (${attempt.outboxId}, 'outbox'), (${domainEventId}, 'outbox')
    `.execute(transaction);
    await sql`
      insert into outbox_events
        (outbox_id, domain_event_id, event_type, event_version, handler_name, handler_mode,
         aggregate_type, aggregate_id, aggregate_scope, occurred_at, payload_json, state,
         attempt_count, available_at, locked_until, lease_generation)
      values (${attempt.outboxId}, ${domainEventId}, 'attachments.upload-verified', 1,
         'attachments_verify_generation', 'delivery_each_event', 'blob', ${id.blobId},
         ${id.generationId}, now(), '{}'::jsonb, 'leased', 1, now(), now() + interval '1 hour', 1)
    `.execute(transaction);
    const claimed = await ports.claimVerification(transaction, {
      blobId: id.blobId,
      generationId: id.generationId,
      attempt,
      leaseTtlSeconds: 60,
    });
    assert.equal(claimed.outcome, 'claimed');
    const completed = await ports.completeVerification(transaction, {
      blobId: id.blobId,
      generationId: id.generationId,
      attempt,
      verifiedSize: body.byteLength,
      verifiedSha256: digest,
      mediaType: 'image/png',
      policyVersion: 'i10-policy-v1',
    });
    assert.equal(completed.outcome, 'stored_private');
  });
}

/**
 * P4A-P07 re-verification after replacement: activation demotes the blob back
 * to `uploaded` (verified facts cleared). Mirror the production verification
 * worker (leased outbox row -> claim -> verified CAS) so admission can grant
 * the NEW current generation again.
 */
async function reverifyToStored(
  runtime: I07MigrationRuntime['runtime'],
  blobId: string,
  generationId: string,
  body: Uint8Array,
): Promise<void> {
  const digest = sha256HexBytes(body);
  await createUnitOfWork(runtime.db).execute(async ({ transaction }) => {
    const attempt = { outboxId: `outbox-reverify-${generationId}`, leaseGeneration: '1' };
    const domainEventId = randomUUID();
    await sql`
      insert into resource_id_ledger (resource_id, resource_type)
      values (${attempt.outboxId}, 'outbox'), (${domainEventId}, 'outbox')
    `.execute(transaction);
    await sql`
      insert into outbox_events
        (outbox_id, domain_event_id, event_type, event_version, handler_name, handler_mode,
         aggregate_type, aggregate_id, aggregate_scope, occurred_at, payload_json, state,
         attempt_count, available_at, locked_until, lease_generation)
      values (${attempt.outboxId}, ${domainEventId}, 'attachments.upload-verified', 1,
         'attachments_verify_generation', 'delivery_each_event', 'blob', ${blobId},
         ${generationId}, now(), '{}'::jsonb, 'leased', 1, now(), now() + interval '1 hour', 1)
    `.execute(transaction);
    const claimed = await ports.claimVerification(transaction, {
      blobId,
      generationId,
      attempt,
      leaseTtlSeconds: 60,
    });
    assert.equal(claimed.outcome, 'claimed');
    const completed = await ports.completeVerification(transaction, {
      blobId,
      generationId,
      attempt,
      verifiedSize: body.byteLength,
      verifiedSha256: digest,
      mediaType: 'image/png',
      policyVersion: 'i10-policy-v1',
    });
    assert.equal(completed.outcome, 'stored_private');
  });
}

/** Seeds a second, still-`observed` generation for the SAME blob (replacement candidate). */
async function seedObservedReplacement(
  runtime: I07MigrationRuntime['runtime'],
  original: ReturnType<typeof identityFor>,
  replacement: ReturnType<typeof identityFor>,
  body: Uint8Array,
  options: { collectionId: string; ownerSubjectId: string; principalId: string },
): Promise<void> {
  const digest = sha256HexBytes(body);
  await createUnitOfWork(runtime.db).execute(async ({ transaction }) => {
    const allocated = await ports.allocate(transaction, allocateInput(replacement, {
      blobId: original.blobId,
      collectionId: options.collectionId,
      subjectIdentity: options.ownerSubjectId,
      principalId: options.principalId,
      expectedSize: body.byteLength,
      expectedSha256: digest,
      mediaHint: 'image/png',
      idempotencyKey: `idem-${replacement.intentId}`,
    }));
    assert.equal(allocated.outcome, 'issued');
    // The replacement generation is completed to 'observed' through the
    // production complete port method (the first-generation CAS
    // completeUploadCas deliberately rejects a replacement as not_current);
    // activateReplacement later CASes it to active and retires gen1.
    const cas = await ports.complete(transaction, {
      intentId: replacement.intentId,
      generationId: replacement.generationId,
      blobId: original.blobId,
      observedEtag: `"etag-${replacement.generationId}"`,
      observedSize: body.byteLength,
      observedContentType: 'image/png',
      observedMetadata: {},
    });
    assert.equal(cas.outcome, 'verified_observed');
  });
}

function makeDeps(
  runtime: I07MigrationRuntime['runtime'],
  options: { barrier?: BarrierGroup; now?: () => Date } = {},
): AuthorizeOwnerDownloadDeps<DatabaseTransaction> {
  return {
    ledger: ports,
    accessPolicyFor: (transaction) => createPostgresAccessPolicyFactsPort(transaction),
    uow: createUnitOfWork(runtime.db),
    capabilitySigner: createHmacOwnerDeliveryCapabilitySigner({
      secret: I10_DELIVERY_SECRET,
      audienceOrigin: I10_DELIVERY_ORIGIN,
      now: options.now,
    }),
    rateLimiter: createDeliveryRateLimiter(),
    config: makeI10Config(),
    barrier: options.barrier,
    now: options.now,
  };
}

describeWithPostgres('P4A-I10 owner-private download admission (production PostgreSQL)', () => {
  let isolated: I07MigrationRuntime;

  beforeAll(async () => {
    isolated = await createI07MigrationRuntime('i10_owner_download', { maxConnections: 12 });
    await seedCollection(isolated.runtime, I10_COLLECTION_A, I10_SUBJECT_OWNER);
    await seedMembership(isolated.runtime, I10_COLLECTION_A, I10_SUBJECT_OWNER, 'owner');
    await seedMembership(isolated.runtime, I10_COLLECTION_A, I10_SUBJECT_MEMBER, 'viewer');
    await seedMembership(isolated.runtime, I10_COLLECTION_A, I10_SUBJECT_EDITOR, 'editor');
    await seedCollection(isolated.runtime, I10_COLLECTION_B, I10_SUBJECT_OTHER_OWNER);
    await seedMembership(isolated.runtime, I10_COLLECTION_B, I10_SUBJECT_OTHER_OWNER, 'owner');
  });

  afterAll(async () => {
    await isolated?.dropSchema();
  });

  test('the production port resolves current generation + owner facts and exposes no physical key', async () => {
    const id = identityFor(1);
    const body = new Uint8Array([0x41]);
    await seedStoredPrivate(isolated.runtime, id, body, {
      collectionId: I10_COLLECTION_A,
      ownerSubjectId: I10_SUBJECT_OWNER,
      principalId: I10_PRINCIPAL_OWNER,
    });
    const found = await createUnitOfWork(isolated.runtime.db).execute(({ transaction }) =>
      ports.findBlobForDelivery(transaction, { blobId: id.blobId }));
    assert.equal(found.outcome, 'found');
    if (found.outcome !== 'found') return;
    assert.equal(found.facts.ownerSubjectId, I10_SUBJECT_OWNER);
    assert.equal(found.facts.logicalState, 'stored_private');
    assert.equal(found.facts.collectionId, I10_COLLECTION_A);
    assert.equal(found.facts.currentGenerationId, id.generationId);
    assert.equal(found.facts.currentGenerationState, 'active');
    assert.equal(found.facts.verifiedSize, body.byteLength);
    assert.equal(found.facts.verifiedSha256, sha256HexBytes(body));
    assert.equal(found.facts.mediaType, 'image/png');
    assert.equal(found.facts.verificationPolicyVersion, 'i10-policy-v1');
    assert.ok(!('key' in found.facts), 'the delivery facts must never carry the physical key');
  });

  test('the uploading owner gets a capability the production verifier + delivery stub accept end to end', async () => {
    const id = identityFor(2);
    const body = new Uint8Array([0x41, 0x42, 0x43]);
    await seedStoredPrivate(isolated.runtime, id, body, {
      collectionId: I10_COLLECTION_A,
      ownerSubjectId: I10_SUBJECT_OWNER,
      principalId: I10_PRINCIPAL_OWNER,
    });
    const granted = await authorizeOwnerDownload(makeDeps(isolated.runtime, { now: () => FIXED_NOW }), {
      actor: makeActor(I10_SUBJECT_OWNER, I10_PRINCIPAL_OWNER),
      blobId: id.blobId,
    });
    assert.equal(granted.outcome, 'granted');
    if (granted.outcome !== 'granted') return;
    assert.equal(granted.generationId, id.generationId);
    const stub = new DeliveryAttemptStub({
      secret: I10_DELIVERY_SECRET,
      expectedAudience: I10_DELIVERY_ORIGIN,
      now: () => FIXED_NOW,
    });
    stub.seedObject(id.generationId, body);
    const attempt = stub.attempt(granted.capability.token);
    assert.equal(attempt.rejected, false);
    assert.equal(attempt.bodyBytes, body.byteLength, 'owner delivery attempt must obtain the exact body');
    assert.equal(attempt.redirect, false);
    assert.equal(attempt.noStore, true);
  });

  test('same-Collection non-uploaders with the real blob id get zero body (no capability obtainable)', async () => {
    const id = identityFor(3);
    await seedStoredPrivate(isolated.runtime, id, new Uint8Array([0x41]), {
      collectionId: I10_COLLECTION_A,
      ownerSubjectId: I10_SUBJECT_OWNER,
      principalId: I10_PRINCIPAL_OWNER,
    });
    const stub = new DeliveryAttemptStub({ secret: I10_DELIVERY_SECRET, expectedAudience: I10_DELIVERY_ORIGIN, now: () => FIXED_NOW });
    stub.seedObject(id.generationId, new Uint8Array([0x41]));
    for (const actor of [
      makeActor(I10_SUBJECT_MEMBER, I10_PRINCIPAL_MEMBER),
      makeActor(I10_SUBJECT_EDITOR, I10_PRINCIPAL_EDITOR),
    ]) {
      const result = await authorizeOwnerDownload(makeDeps(isolated.runtime), { actor, blobId: id.blobId });
      assert.equal(result.outcome, 'denied');
      if (result.outcome === 'denied') assert.equal(result.statusCode, 404);
    }
    // The independent client attempt with no (or an empty) capability is zero body.
    const attempt = stub.attempt('');
    assert.equal(attempt.rejected, true);
    assert.equal(attempt.bodyBytes, 0, 'non-owner read must yield zero body');
    assert.equal(attempt.redirect, false);
    assert.equal(attempt.noStore, true);
  });

  test('an outsider with the real blob id and an intercepted EXPIRED capability is unreadable', async () => {
    const id = identityFor(4);
    await seedStoredPrivate(isolated.runtime, id, new Uint8Array([0x41]), {
      collectionId: I10_COLLECTION_A,
      ownerSubjectId: I10_SUBJECT_OWNER,
      principalId: I10_PRINCIPAL_OWNER,
    });
    const outsider = makeActor(I10_SUBJECT_OUTSIDER, I10_PRINCIPAL_OUTSIDER);
    const denied = await authorizeOwnerDownload(makeDeps(isolated.runtime), { actor: outsider, blobId: id.blobId });
    assert.equal(denied.outcome, 'denied');
    assert.equal(denied.outcome === 'denied' ? denied.statusCode : 0, 404);
    // Intercept an owner capability, then let it naturally expire.
    const mutable = { now: FIXED_NOW.getTime() };
    const granted = await authorizeOwnerDownload(makeDeps(isolated.runtime, { now: () => new Date(mutable.now) }), {
      actor: makeActor(I10_SUBJECT_OWNER, I10_PRINCIPAL_OWNER),
      blobId: id.blobId,
    });
    assert.equal(granted.outcome, 'granted');
    if (granted.outcome !== 'granted') return;
    mutable.now += 61_000; // config TTL is 60s
    const stub = new DeliveryAttemptStub({ secret: I10_DELIVERY_SECRET, expectedAudience: I10_DELIVERY_ORIGIN, now: () => new Date(mutable.now) });
    stub.seedObject(id.generationId, new Uint8Array([0x41]));
    const attempt = stub.attempt(granted.capability.token);
    assert.equal(attempt.rejected, true, 'expired capability must be rejected');
    assert.equal(attempt.bodyBytes, 0);
  });

  test('cross-Collection: the owner of collection B cannot read collection A blob', async () => {
    const id = identityFor(5);
    await seedStoredPrivate(isolated.runtime, id, new Uint8Array([0x41]), {
      collectionId: I10_COLLECTION_A,
      ownerSubjectId: I10_SUBJECT_OWNER,
      principalId: I10_PRINCIPAL_OWNER,
    });
    const otherOwner = makeActor(I10_SUBJECT_OTHER_OWNER, I10_PRINCIPAL_OTHER_OWNER);
    const result = await authorizeOwnerDownload(makeDeps(isolated.runtime), { actor: otherOwner, blobId: id.blobId });
    assert.equal(result.outcome, 'denied');
    if (result.outcome === 'denied') assert.equal(result.statusCode, 404);
  });

  test('replacement binds the capability to the generation current at admission; old capability never serves new bytes', async () => {
    const id = identityFor(6);
    const replacement = identityFor(60);
    const g1Body = new Uint8Array([0x41]);
    const g2Body = new Uint8Array([0x42, 0x42]);
    await seedStoredPrivate(isolated.runtime, id, g1Body, {
      collectionId: I10_COLLECTION_A,
      ownerSubjectId: I10_SUBJECT_OWNER,
      principalId: I10_PRINCIPAL_OWNER,
    });
    await seedObservedReplacement(isolated.runtime, id, replacement, g2Body, {
      collectionId: I10_COLLECTION_A,
      ownerSubjectId: I10_SUBJECT_OWNER,
      principalId: I10_PRINCIPAL_OWNER,
    });
    const owner = makeActor(I10_SUBJECT_OWNER, I10_PRINCIPAL_OWNER);
    const before = await authorizeOwnerDownload(makeDeps(isolated.runtime, { now: () => FIXED_NOW }), { actor: owner, blobId: id.blobId });
    assert.equal(before.outcome, 'granted');
    if (before.outcome !== 'granted') return;
    assert.equal(before.generationId, id.generationId, 'pre-replacement admission binds generation 1');

    const activated = await createUnitOfWork(isolated.runtime.db).execute(({ transaction }) =>
      ports.activateReplacement(transaction, {
        blobId: id.blobId,
        expectedActiveGenerationId: id.generationId,
        newGenerationId: replacement.generationId,
      }));
    assert.equal(activated.outcome, 'activated');

    // P4A-P07: activation demotes the blob back to `uploaded` (verified facts
    // cleared for re-verification of the NEW current generation), so download
    // admission denies until the verification worker completes again.
    const demoted = await authorizeOwnerDownload(makeDeps(isolated.runtime, { now: () => FIXED_NOW }), { actor: owner, blobId: id.blobId });
    assert.equal(demoted.outcome, 'denied');
    await reverifyToStored(isolated.runtime, id.blobId, replacement.generationId, g2Body);

    const after = await authorizeOwnerDownload(makeDeps(isolated.runtime, { now: () => FIXED_NOW }), { actor: owner, blobId: id.blobId });
    assert.equal(after.outcome, 'granted');
    if (after.outcome !== 'granted') return;
    assert.equal(after.generationId, replacement.generationId, 'post-replacement admission resolves the NEW current generation');

    const stub = new DeliveryAttemptStub({ secret: I10_DELIVERY_SECRET, expectedAudience: I10_DELIVERY_ORIGIN, now: () => FIXED_NOW });
    stub.seedObject(id.generationId, g1Body);
    stub.seedObject(replacement.generationId, g2Body);
    const oldAttempt = stub.attempt(before.capability.token);
    assert.equal(oldAttempt.rejected, false, 'frozen policy keeps the old capability valid until TTL');
    assert.equal(oldAttempt.bodyBytes, g1Body.byteLength, 'old capability serves exactly the old generation');
    const newAttempt = stub.attempt(after.capability.token);
    assert.equal(newAttempt.bodyBytes, g2Body.byteLength, 'new capability serves exactly the new generation');
    // Old object physically existing must NOT be mistaken for admission leakage:
    // the old capability cannot serve the new bytes.
    assert.notEqual(oldAttempt.bodyBytes, g2Body.byteLength);
  });

  test('two connections: revocation between authorization read and issuance freezes the decision; a later admission sees current facts', async () => {
    const id = identityFor(7);
    await seedStoredPrivate(isolated.runtime, id, new Uint8Array([0x41]), {
      collectionId: I10_COLLECTION_A,
      ownerSubjectId: I10_SUBJECT_OWNER,
      principalId: I10_PRINCIPAL_OWNER,
    });
    const barrier = new BarrierGroup();
    const owner = makeActor(I10_SUBJECT_OWNER, I10_PRINCIPAL_OWNER);
    const pending = authorizeOwnerDownload(makeDeps(isolated.runtime, { barrier, now: () => FIXED_NOW }), { actor: owner, blobId: id.blobId });
    await barrier.waitArrived('delivery_after_authorization');
    // Connection B revokes the collection while A is between read and issuance.
    await softDeleteCollection(isolated.runtime, I10_COLLECTION_A, true);
    barrier.release('delivery_after_authorization');
    const frozen = await pending;
    assert.equal(frozen.outcome, 'granted', 'frozen consistency: in-flight admission uses the facts it read');
    // A fresh admission reads CURRENT facts and is denied.
    const later = await authorizeOwnerDownload(makeDeps(isolated.runtime), { actor: owner, blobId: id.blobId });
    assert.equal(later.outcome, 'denied');
    if (later.outcome === 'denied') assert.equal(later.statusCode, 404);
    // Restore for the remaining tests.
    await softDeleteCollection(isolated.runtime, I10_COLLECTION_A, false);
  });

  test('two connections: concurrent replacement cannot move the pointer while admission holds the frozen read', async () => {
    const id = identityFor(8);
    const replacement = identityFor(80);
    await seedStoredPrivate(isolated.runtime, id, new Uint8Array([0x41]), {
      collectionId: I10_COLLECTION_A,
      ownerSubjectId: I10_SUBJECT_OWNER,
      principalId: I10_PRINCIPAL_OWNER,
    });
    await seedObservedReplacement(isolated.runtime, id, replacement, new Uint8Array([0x42, 0x42]), {
      collectionId: I10_COLLECTION_A,
      ownerSubjectId: I10_SUBJECT_OWNER,
      principalId: I10_PRINCIPAL_OWNER,
    });
    const barrier = new BarrierGroup();
    const owner = makeActor(I10_SUBJECT_OWNER, I10_PRINCIPAL_OWNER);
    const pending = authorizeOwnerDownload(makeDeps(isolated.runtime, { barrier, now: () => FIXED_NOW }), { actor: owner, blobId: id.blobId });
    await barrier.waitArrived('delivery_after_authorization');
    // Connection B tries to take the blob row FOR UPDATE; the frozen FOR SHARE
    // read blocks it (deterministic lock_timeout proof, not a sleep).
    const client = await new Pool({ connectionString: isolated.databaseUrl, max: 1 }).connect();
    try {
      await client.query('begin');
      await client.query("set local lock_timeout = '200ms'");
      await assert.rejects(
        client.query('select current_generation_id from blob_records where blob_id = $1 for update', [id.blobId]),
        /lock timeout/u,
        'replacement must block on the admission frozen read',
      );
      await client.query('rollback');
    } finally {
      client.release();
    }
    barrier.release('delivery_after_authorization');
    const frozen = await pending;
    assert.equal(frozen.outcome, 'granted');
    if (frozen.outcome !== 'granted') return;
    assert.equal(frozen.generationId, id.generationId, 'capability is bound to the pre-replacement generation');
    // Now the replacement completes.
    const activated = await createUnitOfWork(isolated.runtime.db).execute(({ transaction }) =>
      ports.activateReplacement(transaction, {
        blobId: id.blobId,
        expectedActiveGenerationId: id.generationId,
        newGenerationId: replacement.generationId,
      }));
    assert.equal(activated.outcome, 'activated');
    const stub = new DeliveryAttemptStub({ secret: I10_DELIVERY_SECRET, expectedAudience: I10_DELIVERY_ORIGIN, now: () => FIXED_NOW });
    stub.seedObject(id.generationId, new Uint8Array([0x41]));
    stub.seedObject(replacement.generationId, new Uint8Array([0x42, 0x42]));
    const oldAttempt = stub.attempt(frozen.capability.token);
    assert.equal(oldAttempt.rejected, false, 'frozen policy: old capability remains valid until its TTL');
    assert.equal(oldAttempt.bodyBytes, 1, 'old capability serves exactly the old generation bytes');
    assert.notEqual(oldAttempt.bodyBytes, 2, 'the frozen old capability can never serve the new generation');
    // P4A-P07 demotion: activation leaves the blob `uploaded`, so a fresh
    // admission is denied until the new generation is re-verified.
    const demoted = await authorizeOwnerDownload(makeDeps(isolated.runtime, { now: () => FIXED_NOW }), { actor: owner, blobId: id.blobId });
    assert.equal(demoted.outcome, 'denied');
    await reverifyToStored(isolated.runtime, id.blobId, replacement.generationId, new Uint8Array([0x42, 0x42]));
    const after = await authorizeOwnerDownload(makeDeps(isolated.runtime, { now: () => FIXED_NOW }), { actor: owner, blobId: id.blobId });
    assert.equal(after.outcome, 'granted');
    if (after.outcome === 'granted') assert.equal(after.generationId, replacement.generationId);
  });

  test('two accounts concurrent: the owner is admitted while the outsider is denied on separate connections', async () => {
    const id = identityFor(9);
    await seedStoredPrivate(isolated.runtime, id, new Uint8Array([0x41]), {
      collectionId: I10_COLLECTION_A,
      ownerSubjectId: I10_SUBJECT_OWNER,
      principalId: I10_PRINCIPAL_OWNER,
    });
    const owner = makeActor(I10_SUBJECT_OWNER, I10_PRINCIPAL_OWNER);
    const outsider = makeActor(I10_SUBJECT_OUTSIDER, I10_PRINCIPAL_OUTSIDER);
    const [ownerResult, outsiderResult] = await Promise.all([
      authorizeOwnerDownload(makeDeps(isolated.runtime), { actor: owner, blobId: id.blobId }),
      authorizeOwnerDownload(makeDeps(isolated.runtime), { actor: outsider, blobId: id.blobId }),
    ]);
    assert.equal(ownerResult.outcome, 'granted');
    assert.equal(outsiderResult.outcome, 'denied');
  });
});


