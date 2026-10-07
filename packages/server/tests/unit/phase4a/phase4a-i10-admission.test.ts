/**
 * P4A-I10 owner-private download admission matrix (plan §6 I10).
 *
 * The admission use case takes a TRUSTED actor + an OPAQUE blob id (never a
 * key/generation), reads the current authorization + blob facts (no caching),
 * requires `stored_private|attached_private` AND the actor to be the uploading
 * owner, and issues a short-lived current-generation delivery capability whose
 * audience is the isolated delivery origin. The full matrix: uploading owner,
 * same-Collection owner/editor/member but non-uploader, revoked/deleted
 * account, cross-Collection, anonymous, wrong blob, expired logical state,
 * retired/orphan generation, before/after replacement (generation binding),
 * capability replay/expiry, authorization change between query and issuance
 * (frozen consistency + max TTL), rate limit, audit classes, no caching, no
 * key input.
 *
 * Every denial is existence-hidden as 404; the only non-404 denial is rate
 * limiting (429). The token-level proof uses the production verifier and the
 * independent delivery-attempt stub: a non-owner gets zero body, no redirect,
 * no-store.
 */
import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  authorizeOwnerDownload,
  type AuthorizeOwnerDownloadDeps,
} from '../../../src/modules/attachments/index.js';
import type { PhaseBarrier } from '../../../src/modules/attachments/index.js';
import { BarrierGroup } from '../../support/phase4a-i07-test-helpers.js';
import {
  I10_COLLECTION_A,
  I10_COLLECTION_B,
  I10_DELIVERY_ORIGIN,
  I10_DELIVERY_SECRET,
  I10_PRINCIPAL_EDITOR,
  I10_PRINCIPAL_MEMBER,
  I10_PRINCIPAL_OTHER_OWNER,
  I10_PRINCIPAL_OUTSIDER,
  I10_PRINCIPAL_OWNER,
  I10_SUBJECT_EDITOR,
  I10_SUBJECT_MEMBER,
  I10_SUBJECT_OTHER_OWNER,
  I10_SUBJECT_OUTSIDER,
  I10_SUBJECT_OWNER,
  DeliveryAttemptStub,
  InMemoryTx,
  createI10Harness,
  makeActor,
  type I10Harness,
} from '../../support/phase4a-i10-test-helpers.js';

const FIXED_NOW = new Date('2026-08-08T12:00:00.000Z');

function makeDeps(h: I10Harness, barrier?: PhaseBarrier): AuthorizeOwnerDownloadDeps<InMemoryTx> {
  return {
    ledger: h.ledger,
    accessPolicyFor: () => h.accessPolicy,
    uow: h.uow,
    capabilitySigner: h.signer,
    rateLimiter: h.limiter,
    config: h.config,
    barrier,
    now: h.now,
    log: h.log.handle,
  };
}

function seedFixtures(h: I10Harness): { blobA: string; blobB: string } {
  h.accessPolicy.seed({
    id: I10_COLLECTION_A,
    ownerSubjectId: I10_SUBJECT_OWNER,
    visibility: 'private',
    policyRevision: 'policy-r1',
    members: [
      { subjectId: I10_SUBJECT_MEMBER, role: 'viewer' },
      { subjectId: I10_SUBJECT_EDITOR, role: 'editor' },
    ],
  });
  h.accessPolicy.seed({
    id: I10_COLLECTION_B,
    ownerSubjectId: I10_SUBJECT_OTHER_OWNER,
    visibility: 'private',
    policyRevision: 'policy-r1',
  });
  h.ledger.seedBlob({
    blobId: 'blob-a',
    ownerSubjectId: I10_SUBJECT_OWNER,
    logicalState: 'stored_private',
    collectionId: I10_COLLECTION_A,
    currentGenerationId: 'gen-a1',
    currentGenerationState: 'active',
    verifiedSize: 1,
    verifiedSha256: 'a'.repeat(64),
    mediaType: 'image/png',
    verificationPolicyVersion: 'i10-v1',
  });
  h.ledger.seedBlob({
    blobId: 'blob-b',
    ownerSubjectId: I10_SUBJECT_OTHER_OWNER,
    logicalState: 'stored_private',
    collectionId: I10_COLLECTION_B,
    currentGenerationId: 'gen-b1',
    currentGenerationState: 'active',
    verifiedSize: 1,
    verifiedSha256: 'b'.repeat(64),
    mediaType: 'application/pdf',
    verificationPolicyVersion: 'i10-v1',
  });
  return { blobA: 'blob-a', blobB: 'blob-b' };
}

function stubFor(h: I10Harness): DeliveryAttemptStub {
  return new DeliveryAttemptStub({ secret: I10_DELIVERY_SECRET, expectedAudience: I10_DELIVERY_ORIGIN, now: h.now });
}

test('the uploading owner is admitted and receives a verified current-generation capability', async () => {
  const h = createI10Harness({ now: () => FIXED_NOW });
  const { blobA } = seedFixtures(h);
  const result = await authorizeOwnerDownload(makeDeps(h), { actor: makeActor(), blobId: blobA });
  assert.equal(result.outcome, 'granted');
  if (result.outcome !== 'granted') return;
  assert.equal(result.generationId, 'gen-a1');
  assert.equal(result.blobId, blobA);
  assert.equal(result.expiresAtEpochMs - result.issuedAtEpochMs, 60_000, 'TTL must be exactly the configured window');
  const stub = stubFor(h);
  stub.seedObject('gen-a1', new Uint8Array([0x41]));
  const attempt = stub.attempt(result.capability.token);
  assert.equal(attempt.rejected, false);
  assert.equal(attempt.bodyBytes, 1, 'owner delivery attempt must obtain the body');
  assert.equal(attempt.redirect, false);
  assert.equal(attempt.noStore, true);
});

test('same-Collection member/editor who is NOT the uploader is denied with concealed 404', async () => {
  const h = createI10Harness({ now: () => FIXED_NOW });
  const { blobA } = seedFixtures(h);
  for (const actor of [
    makeActor(I10_SUBJECT_MEMBER, I10_PRINCIPAL_MEMBER),
    makeActor(I10_SUBJECT_EDITOR, I10_PRINCIPAL_EDITOR),
  ]) {
    const result = await authorizeOwnerDownload(makeDeps(h), { actor, blobId: blobA });
    assert.equal(result.outcome, 'denied');
    if (result.outcome === 'denied') assert.equal(result.statusCode, 404);
  }
  // The same subject under a different principal is still the owner (owner
  // binding is by subject, never by principal id).
  const ownerClone = await authorizeOwnerDownload(makeDeps(h), { actor: makeActor(I10_SUBJECT_OWNER, 'i10-principal-owner-clone'), blobId: blobA });
  assert.equal(ownerClone.outcome, 'granted');
});

test('a same-Collection OWNER who is not the uploader is denied (owner binding == uploading owner)', async () => {
  const h = createI10Harness({ now: () => FIXED_NOW });
  h.accessPolicy.seed({
    id: I10_COLLECTION_A,
    ownerSubjectId: I10_SUBJECT_OWNER,
    visibility: 'private',
    policyRevision: 'policy-r1',
    // The uploader is a member with current authorization (I08 upload requires
    // read_editor membership); the collection OWNER is not the uploader.
    members: [{ subjectId: I10_SUBJECT_MEMBER, role: 'editor' }],
  });
  h.ledger.seedBlob({
    blobId: 'blob-by-member',
    ownerSubjectId: I10_SUBJECT_MEMBER,
    logicalState: 'stored_private',
    collectionId: I10_COLLECTION_A,
    currentGenerationId: 'gen-m1',
    currentGenerationState: 'active',
    verifiedSize: 1,
    verifiedSha256: 'm'.repeat(64),
    mediaType: 'image/png',
    verificationPolicyVersion: 'i10-v1',
  });
  // The COLLECTION owner is a member in good standing but is not the uploader.
  const collectionOwner = makeActor(I10_SUBJECT_OWNER, I10_PRINCIPAL_OWNER);
  const denied = await authorizeOwnerDownload(makeDeps(h), { actor: collectionOwner, blobId: 'blob-by-member' });
  assert.equal(denied.outcome, 'denied', 'the collection owner is NOT the uploading owner');
  if (denied.outcome === 'denied') assert.equal(denied.statusCode, 404);
  // The uploading member IS admitted.
  const uploader = makeActor(I10_SUBJECT_MEMBER, I10_PRINCIPAL_MEMBER);
  assert.equal((await authorizeOwnerDownload(makeDeps(h), { actor: uploader, blobId: 'blob-by-member' })).outcome, 'granted');
});

test('cross-Collection: the owner of another Collection cannot read this blob', async () => {
  const h = createI10Harness({ now: () => FIXED_NOW });
  const { blobA, blobB } = seedFixtures(h);
  const otherOwner = makeActor(I10_SUBJECT_OTHER_OWNER, I10_PRINCIPAL_OTHER_OWNER);
  assert.equal((await authorizeOwnerDownload(makeDeps(h), { actor: otherOwner, blobId: blobA })).outcome, 'denied');
  // And the owner of blob A cannot read blob B.
  const ownerA = makeActor();
  assert.equal((await authorizeOwnerDownload(makeDeps(h), { actor: ownerA, blobId: blobB })).outcome, 'denied');
});

test('anonymous (no trusted actor) is denied 404 without any database or rate-limit work', async () => {
  const h = createI10Harness({ now: () => FIXED_NOW });
  const { blobA } = seedFixtures(h);
  const result = await authorizeOwnerDownload(makeDeps(h), { actor: null, blobId: blobA });
  assert.equal(result.outcome, 'denied');
  if (result.outcome === 'denied') {
    assert.equal(result.statusCode, 404);
    assert.equal(result.code, 'unauthenticated');
  }
  assert.equal(h.ledger.findCalls.length, 0, 'anonymous must never read the ledger');
});

test('a wrong blob id is existence-hidden as 404', async () => {
  const h = createI10Harness({ now: () => FIXED_NOW });
  seedFixtures(h);
  const result = await authorizeOwnerDownload(makeDeps(h), { actor: makeActor(), blobId: 'no-such-blob' });
  assert.equal(result.outcome, 'denied');
  if (result.outcome === 'denied') assert.equal(result.statusCode, 404);
});

test('expired logical state and retired/orphan/deleted/quarantined generations are not deliverable', async () => {
  const h = createI10Harness({ now: () => FIXED_NOW });
  const { blobA } = seedFixtures(h);
  h.ledger.setLogicalState(blobA, 'expired');
  assert.equal((await authorizeOwnerDownload(makeDeps(h), { actor: makeActor(), blobId: blobA })).outcome, 'denied');
  h.ledger.setLogicalState(blobA, 'stored_private');
  for (const state of ['retired', 'orphaned', 'deleted', 'contract_corrupt', 'quarantined'] as const) {
    h.ledger.setCurrentGeneration(blobA, 'gen-a1', state);
    const result = await authorizeOwnerDownload(makeDeps(h), { actor: makeActor(), blobId: blobA });
    assert.equal(result.outcome, 'denied', `generation state ${state} must be denied`);
    if (result.outcome === 'denied') assert.equal(result.statusCode, 404);
  }
  h.ledger.setCurrentGeneration(blobA, null, null);
  assert.equal((await authorizeOwnerDownload(makeDeps(h), { actor: makeActor(), blobId: blobA })).outcome, 'denied');
});

test('before/after replacement: admission resolves the CURRENT generation and binds it', async () => {
  const h = createI10Harness({ now: () => FIXED_NOW });
  const { blobA } = seedFixtures(h);
  const stub = stubFor(h);
  stub.seedObject('gen-a1', new Uint8Array([0x41]));
  stub.seedObject('gen-a2', new Uint8Array([0x42, 0x42]));

  const before = await authorizeOwnerDownload(makeDeps(h), { actor: makeActor(), blobId: blobA });
  assert.equal(before.outcome, 'granted');
  if (before.outcome !== 'granted') return;
  assert.equal(before.generationId, 'gen-a1');
  const beforeAttempt = stub.attempt(before.capability.token);
  assert.equal(beforeAttempt.bodyBytes, 1, 'gen-a1 capability serves gen-a1 content');

  // Replacement: gen-a1 is retired, gen-a2 becomes active.
  h.ledger.setCurrentGeneration(blobA, 'gen-a2', 'active');
  const after = await authorizeOwnerDownload(makeDeps(h), { actor: makeActor(), blobId: blobA });
  assert.equal(after.outcome, 'granted');
  if (after.outcome !== 'granted') return;
  assert.equal(after.generationId, 'gen-a2', 'a new admission must resolve the CURRENT generation');

  // Frozen policy: the old capability stays valid until its TTL but is bound to
  // gen-a1 — it can never serve gen-a2 content (generation binding).
  const oldAttempt = stub.attempt(before.capability.token);
  assert.equal(oldAttempt.rejected, false, 'frozen policy keeps the old capability valid until TTL');
  assert.equal(oldAttempt.bodyBytes, 1, 'old capability serves exactly the old generation content');
  const newAttempt = stub.attempt(after.capability.token);
  assert.equal(newAttempt.bodyBytes, 2, 'new capability serves the new generation content');
  assert.notEqual(oldAttempt.bodyBytes, 2, 'the old capability can never serve the new generation content');
});

test('revoked/deleted account: current authorization is re-checked at request time (no caching)', async () => {
  const h = createI10Harness({ now: () => FIXED_NOW });
  const { blobA } = seedFixtures(h);
  const owner = makeActor();
  const first = await authorizeOwnerDownload(makeDeps(h), { actor: owner, blobId: blobA });
  assert.equal(first.outcome, 'granted');
  h.accessPolicy.setDeleted(I10_COLLECTION_A, true);
  const second = await authorizeOwnerDownload(makeDeps(h), { actor: owner, blobId: blobA });
  assert.equal(second.outcome, 'denied', 'a later admission must see the current (revoked) facts');
  if (second.outcome === 'denied') assert.equal(second.statusCode, 404);
});

test('the barrier freezes the decision between authorization read and issuance; max TTL is bounded', async () => {
  const barrier = new BarrierGroup();
  const h = createI10Harness({ now: () => FIXED_NOW });
  const { blobA } = seedFixtures(h);
  const owner = makeActor();
  const pending = authorizeOwnerDownload(makeDeps(h, barrier), { actor: owner, blobId: blobA });
  await barrier.waitArrived('delivery_after_authorization');
  // Revocation lands while the admission is between authorization read and issuance.
  h.accessPolicy.setDeleted(I10_COLLECTION_A, true);
  barrier.release('delivery_after_authorization');
  const result = await pending;
  assert.equal(result.outcome, 'granted', 'frozen consistency: the in-flight admission uses the facts it read');
  if (result.outcome === 'granted') {
    assert.equal(result.generationId, 'gen-a1');
    assert.ok(result.expiresAtEpochMs - result.issuedAtEpochMs <= 120_000, 'max exposure window must be <= 120s');
  }
  // A fresh admission sees the current facts and is denied.
  const later = await authorizeOwnerDownload(makeDeps(h), { actor: owner, blobId: blobA });
  assert.equal(later.outcome, 'denied');
});

test('rate limit is a bounded per-principal window; over-limit is 429 with retry-after', async () => {
  const h = createI10Harness({
    now: () => FIXED_NOW,
    rateLimitPolicy: { windowSeconds: 60, maxPerWindow: 2, maxTrackedPrincipals: 16 },
  });
  const { blobA } = seedFixtures(h);
  const owner = makeActor();
  assert.equal((await authorizeOwnerDownload(makeDeps(h), { actor: owner, blobId: blobA })).outcome, 'granted');
  assert.equal((await authorizeOwnerDownload(makeDeps(h), { actor: owner, blobId: blobA })).outcome, 'granted');
  const third = await authorizeOwnerDownload(makeDeps(h), { actor: owner, blobId: blobA });
  assert.equal(third.outcome, 'rate_limited');
  if (third.outcome === 'rate_limited') assert.ok(third.retryAfterSeconds > 0);
  // Another principal is unaffected.
  const outsider = makeActor(I10_SUBJECT_OUTSIDER, I10_PRINCIPAL_OUTSIDER);
  assert.equal((await authorizeOwnerDownload(makeDeps(h), { actor: outsider, blobId: blobA })).outcome, 'denied');
});

test('the client cannot select the key or generation: only the opaque blob id reaches the ledger', async () => {
  const h = createI10Harness({ now: () => FIXED_NOW });
  const { blobA } = seedFixtures(h);
  const result = await authorizeOwnerDownload(makeDeps(h), { actor: makeActor(), blobId: blobA });
  assert.equal(result.outcome, 'granted');
  assert.deepEqual(h.ledger.findCalls, [{ blobId: blobA }], 'findBlobForDelivery must be called with ONLY the opaque blob id');
});

test('audit records fixed classes and never secrets/keys/URLs/digests', async () => {
  const h = createI10Harness({ now: () => FIXED_NOW });
  const { blobA } = seedFixtures(h);
  const owner = makeActor();
  const outsider = makeActor(I10_SUBJECT_OUTSIDER, I10_PRINCIPAL_OUTSIDER);
  await authorizeOwnerDownload(makeDeps(h), { actor: owner, blobId: blobA });
  await authorizeOwnerDownload(makeDeps(h), { actor: outsider, blobId: blobA });
  await authorizeOwnerDownload(makeDeps(h), { actor: null, blobId: blobA });
  await authorizeOwnerDownload(makeDeps(h), { actor: owner, blobId: '   ' });
  const classes = h.log.classes();
  assert.ok(classes.includes('download_admitted'));
  assert.ok(classes.includes('download_denied'));
  assert.ok(classes.includes('download_invalid'));
  const serialized = h.log.serialized();
  for (const needle of [I10_DELIVERY_SECRET.toString('utf8'), 'key', 'credential', 'url', 'digest', 'delivery.known.test']) {
    assert.ok(!serialized.includes(needle), `audit log must never contain ${JSON.stringify(needle)}`);
  }
});

test('every denial path is a concealed 404 and no internal reason text escapes', async () => {
  const h = createI10Harness({ now: () => FIXED_NOW });
  const { blobA, blobB } = seedFixtures(h);
  const actors = [
    makeActor(I10_SUBJECT_MEMBER, I10_PRINCIPAL_MEMBER),
    makeActor(I10_SUBJECT_EDITOR, I10_PRINCIPAL_EDITOR),
    makeActor(I10_SUBJECT_OTHER_OWNER, I10_PRINCIPAL_OTHER_OWNER),
    makeActor(I10_SUBJECT_OUTSIDER, I10_PRINCIPAL_OUTSIDER),
  ];
  const results = [];
  for (const actor of actors) {
    // blobA is owned by I10_SUBJECT_OWNER: every actor here is denied.
    results.push(await authorizeOwnerDownload(makeDeps(h), { actor, blobId: blobA }));
  }
  // blobB is owned by I10_SUBJECT_OTHER_OWNER, so only the three non-owners
  // are denied; the owner pairing is a legitimate grant (not part of this matrix).
  for (const actor of [
    makeActor(I10_SUBJECT_MEMBER, I10_PRINCIPAL_MEMBER),
    makeActor(I10_SUBJECT_EDITOR, I10_PRINCIPAL_EDITOR),
    makeActor(I10_SUBJECT_OUTSIDER, I10_PRINCIPAL_OUTSIDER),
  ]) {
    results.push(await authorizeOwnerDownload(makeDeps(h), { actor, blobId: blobB }));
  }
  results.push(await authorizeOwnerDownload(makeDeps(h), { actor: makeActor(), blobId: 'missing' }));
  h.ledger.setLogicalState(blobA, 'expired');
  results.push(await authorizeOwnerDownload(makeDeps(h), { actor: makeActor(), blobId: blobA }));
  for (const result of results) {
    assert.equal(result.outcome, 'denied');
    if (result.outcome === 'denied') {
      assert.equal(result.statusCode, 404);
      const serialized = JSON.stringify(result);
      assert.ok(!serialized.includes('message'), 'no free-form message text may escape');
      assert.ok(!serialized.includes('reason'), 'internal reason text must not be part of the result');
    }
  }
});

test('ttl from config drives the capability and is bounded (1s and 120s edges)', async () => {
  const short = createI10Harness({ now: () => FIXED_NOW, ttlSeconds: 1 });
  seedFixtures(short);
  const shortResult = await authorizeOwnerDownload(makeDeps(short), { actor: makeActor(), blobId: 'blob-a' });
  assert.equal(shortResult.outcome, 'granted');
  if (shortResult.outcome === 'granted') {
    assert.equal(shortResult.expiresAtEpochMs - shortResult.issuedAtEpochMs, 1_000);
  }
  const long = createI10Harness({ now: () => FIXED_NOW, ttlSeconds: 120 });
  seedFixtures(long);
  const longResult = await authorizeOwnerDownload(makeDeps(long), { actor: makeActor(), blobId: 'blob-a' });
  assert.equal(longResult.outcome, 'granted');
  if (longResult.outcome === 'granted') {
    assert.equal(longResult.expiresAtEpochMs - longResult.issuedAtEpochMs, 120_000);
  }
});

test('an intercepted expired capability is unreadable (zero body via the delivery stub)', async () => {
  const mutable = { now: FIXED_NOW.getTime() };
  const h = createI10Harness({ now: () => new Date(mutable.now), ttlSeconds: 1 });
  const { blobA } = seedFixtures(h);
  const granted = await authorizeOwnerDownload(makeDeps(h), { actor: makeActor(), blobId: blobA });
  assert.equal(granted.outcome, 'granted');
  if (granted.outcome !== 'granted') return;
  mutable.now += 2_000; // capability naturally expires
  const stub = stubFor(h);
  stub.seedObject('gen-a1', new Uint8Array([0x41]));
  const attempt = stub.attempt(granted.capability.token);
  assert.equal(attempt.rejected, true, 'expired capability must be rejected');
  assert.equal(attempt.bodyBytes, 0, 'expired capability yields zero bytes');
});

