/**
 * P4A-I09 unit/contract suite (part 3): the verification worker coordinator
 * (`verifyUploadedGeneration`).
 *
 * Proves the claim -> HEAD -> conditional read -> verify -> CAS flow with the
 * verification lease fence: stored_private with verified facts that match the
 * R2 bytes one by one, old-lease late results CAS-fail, lease takeover after
 * expiry, duplicate outbox delivery converging idempotently (already_stored),
 * oversize/digest/etag corruption quarantining the generation and expiring
 * the blob, unknown MIME storing as a generic private download (never
 * clean/safe), retryable provider outcomes leaving the blob in verifying, the
 * crash-hook ordering, and the FIX-L-045 terminal convergence of a stale
 * verification event for an authoritatively replaced generation
 * (already_replaced, without touching the new generation) while non-terminal
 * non-current states keep retrying.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import {
  ATTACHMENTS_VERIFICATION_POLICY_VERSION,
  completeUpload,
  verifyUploadedGeneration,
  type CompleteUploadDeps,
  type VerificationFaultInjector,
  type VerificationWorkerDeps,
} from '../../../src/modules/attachments/index.js';
import {
  InMemoryVerificationLedger,
  InMemoryVerificationObjectStore,
  InMemoryVerificationUow,
  I09_PRINCIPAL,
  RecordingVerificationOutbox,
  allocateInput,
  expectedDigest,
  fakeAttempt,
  identityFor,
  makeI09Config,
  sha256HexBytes,
  type I09Tx,
} from '../../support/phase4a-i09-test-helpers.js';

const CONFIG = makeI09Config();

function pngBody(bytes = 16): Uint8Array {
  const body = new Uint8Array(bytes);
  body.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  for (let index = 8; index < body.length; index += 1) body[index] = index % 251;
  return body;
}

interface Flow {
  ledger: InMemoryVerificationLedger;
  store: InMemoryVerificationObjectStore;
  uow: InMemoryVerificationUow;
  id: ReturnType<typeof identityFor>;
  payload: { blobId: string; generationId: string; intentId: string };
}

/** Issue -> PUT (test store) -> complete, leaving an uploaded blob. */
async function uploadedFlow(n: number, body = pngBody()): Promise<Flow> {
  const id = identityFor(n);
  const ledger = new InMemoryVerificationLedger();
  const uow = new InMemoryVerificationUow(ledger);
  await uow.execute(({ transaction }) => ledger.allocate(transaction, allocateInput(id, {
    expectedSize: body.byteLength,
    expectedSha256: sha256HexBytes(body),
    mediaHint: 'image/png',
  })));
  const store = new InMemoryVerificationObjectStore();
  store.seed(id.key, body, { etag: `"etag-${id.generationId}"` });
  const outbox = new RecordingVerificationOutbox();
  const completeDeps: CompleteUploadDeps<I09Tx> = {
    ledger, blobStore: store, uow,
    enqueueVerification: outbox.enqueue.bind(outbox),
    config: CONFIG,
  };
  const result = await completeUpload(completeDeps, {
    actor: { principalId: 'i09-principal', subjectId: 'i09-subject-owner', kind: 'account' },
    binding: { intentId: id.intentId, generationId: id.generationId, blobId: id.blobId },
    declared: {
      size: body.byteLength,
      sha256: sha256HexBytes(body),
      mediaType: 'image/png',
      etag: `"etag-${id.generationId}"`,
    },
  });
  assert.equal(result.outcome, 'completed');
  return { ledger, store, uow, id, payload: { blobId: id.blobId, generationId: id.generationId, intentId: id.intentId } };
}

function workerDeps(flow: Flow, options: {
  faultInjector?: VerificationFaultInjector;
  log?: (entry: { class: string }) => void;
} = {}): VerificationWorkerDeps<I09Tx> {
  return {
    ledger: flow.ledger,
    blobStore: flow.store,
    uow: flow.uow,
    config: CONFIG,
    faultInjector: options.faultInjector,
    log: options.log,
  };
}

function signal(): AbortSignal {
  return new AbortController().signal;
}

describe('P4A-I09 worker coordinator: stored_private evidence', () => {
  test('happy path: verified fields match the R2 bytes one by one', async () => {
    const body = pngBody(37);
    const flow = await uploadedFlow(1, body);
    const outcome = await verifyUploadedGeneration(workerDeps(flow), flow.payload, fakeAttempt(1), signal());
    assert.equal(outcome.outcome, 'stored_private');
    if (outcome.outcome !== 'stored_private') return;
    assert.equal(outcome.verifiedSize, body.byteLength);
    assert.equal(outcome.verifiedSha256, expectedDigest(body), 'digest must match the independent digest of the R2 bytes');
    assert.equal(outcome.mediaType, 'image/png');
    const blob = flow.ledger.blobState(flow.id.blobId)!;
    assert.equal(blob.logicalState, 'stored_private');
    assert.equal(blob.verifiedSize, body.byteLength);
    assert.equal(blob.verifiedSha256, expectedDigest(body));
    assert.equal(blob.mediaType, 'image/png');
    assert.equal(blob.verificationPolicyVersion, ATTACHMENTS_VERIFICATION_POLICY_VERSION);
    assert.equal(blob.verificationLeaseOwner, null, 'the lease must be released on stored_private');
  });

  test('unknown MIME stores as a generic private download and never claims clean/safe', async () => {
    const body = new Uint8Array(12); // no magic bytes
    for (let index = 0; index < body.length; index += 1) body[index] = index % 251;
    const flow = await uploadedFlow(2, body);
    const outcome = await verifyUploadedGeneration(workerDeps(flow), flow.payload, fakeAttempt(1), signal());
    assert.equal(outcome.outcome, 'stored_private');
    if (outcome.outcome !== 'stored_private') return;
    assert.equal(outcome.mediaType, 'application/octet-stream');
    const blob = flow.ledger.blobState(flow.id.blobId)!;
    assert.equal(blob.mediaType, 'application/octet-stream');
    assert.equal(Object.values(blob).some((value) => value === 'clean' || value === 'safe'), false);
  });

  test('crash hooks fire in the documented order on the happy path', async () => {
    const flow = await uploadedFlow(3);
    const order: string[] = [];
    const injector: VerificationFaultInjector = {
      afterClaim: async () => { order.push('afterClaim'); },
      afterHead: async () => { order.push('afterHead'); },
      beforeFirstByte: async () => { order.push('beforeFirstByte'); },
      afterPartial: async () => { order.push('afterPartial'); },
      afterDigest: async () => { order.push('afterDigest'); },
      beforeStoredCas: async () => { order.push('beforeStoredCas'); },
    };
    const outcome = await verifyUploadedGeneration(workerDeps(flow, { faultInjector: injector }), flow.payload, fakeAttempt(1), signal());
    assert.equal(outcome.outcome, 'stored_private');
    // `afterPartial` fires after EVERY yielded chunk; the 16-byte fixture is
    // streamed in 7-byte chunks (3 chunks), so it appears 3 times.
    const expectedOrder = ['afterClaim', 'afterHead', 'beforeFirstByte'];
    for (let index = 0; index < 3; index += 1) expectedOrder.push('afterPartial');
    expectedOrder.push('afterDigest', 'beforeStoredCas');
    assert.deepEqual(order, expectedOrder);
  });
});

describe('P4A-I09 worker coordinator: lease fencing and takeover', () => {
  test('an old-lease late result CAS-fails after a takeover', async () => {
    const flow = await uploadedFlow(4);
    // Worker A claims + reads + computes the digest, then crashes before CAS.
    let crashAfterDigest = true;
    const injectorA: VerificationFaultInjector = {
      afterDigest: async () => {
        if (crashAfterDigest) {
          crashAfterDigest = false;
          throw new Error('worker A crashed after digest');
        }
      },
    };
    await assert.rejects(
      verifyUploadedGeneration(workerDeps(flow, { faultInjector: injectorA }), flow.payload, fakeAttempt(1), signal()),
      /crashed after digest/,
    );
    // A's claim committed: blob verifying with A's lease.
    assert.equal(flow.ledger.blobState(flow.id.blobId)!.logicalState, 'verifying');
    assert.equal(flow.ledger.blobState(flow.id.blobId)!.verificationLeaseGeneration, 1001n);

    // The lease expires; worker B takes over and stores.
    flow.ledger.advanceNow(61_000);
    const outcomeB = await verifyUploadedGeneration(workerDeps(flow), flow.payload, fakeAttempt(2), signal());
    assert.equal(outcomeB.outcome, 'stored_private');

    // A's late CAS with its old lease generation fails (lease_lost).
    const late = await flow.uow.execute(({ transaction }) => flow.ledger.completeVerification(transaction, {
      blobId: flow.id.blobId,
      generationId: flow.id.generationId,
      attempt: fakeAttempt(1),
      verifiedSize: 16,
      verifiedSha256: 'x'.repeat(64),
      mediaType: 'image/png',
      policyVersion: ATTACHMENTS_VERIFICATION_POLICY_VERSION,
    }));
    assert.equal(late.outcome, 'lease_lost');
    // The stored facts remain B's facts (no contradiction).
    assert.equal(flow.ledger.blobState(flow.id.blobId)!.verifiedSize, 16);
    assert.notEqual(flow.ledger.blobState(flow.id.blobId)!.verifiedSha256, 'x'.repeat(64));
  });

  test('an active lease blocks a second worker (lease held -> lease_lost)', async () => {
    const flow = await uploadedFlow(5);
    // Worker A claims, signals that it holds the fresh lease, then stalls at a
    // deterministic gate (its lease is still valid).
    let releaseA: () => void = () => {};
    const gateA = new Promise<void>((resolve) => { releaseA = resolve; });
    let signalClaimed: () => void = () => {};
    const claimed = new Promise<void>((resolve) => { signalClaimed = resolve; });
    const injectorA: VerificationFaultInjector = {
      afterClaim: async () => {
        signalClaimed();
        await gateA;
      },
    };
    const aStarted = verifyUploadedGeneration(workerDeps(flow, { faultInjector: injectorA }), flow.payload, fakeAttempt(1), signal());
    await claimed;
    const outcomeB = await verifyUploadedGeneration(workerDeps(flow), flow.payload, fakeAttempt(2), signal());
    assert.equal(outcomeB.outcome, 'lease_lost');
    releaseA();
    const outcomeA = await aStarted;
    assert.equal(outcomeA.outcome, 'stored_private');
  });

  test('a duplicate outbox delivery converges idempotently (already_stored)', async () => {
    const flow = await uploadedFlow(6);
    const first = await verifyUploadedGeneration(workerDeps(flow), flow.payload, fakeAttempt(1), signal());
    assert.equal(first.outcome, 'stored_private');
    const duplicate = await verifyUploadedGeneration(workerDeps(flow), flow.payload, fakeAttempt(9), signal());
    assert.equal(duplicate.outcome, 'already_stored');
    const blob = flow.ledger.blobState(flow.id.blobId)!;
    assert.equal(blob.logicalState, 'stored_private');
  });
});

describe('P4A-I09 worker coordinator: corruption and quarantine', () => {
  test('oversize (provider identity bigger than the ceiling) quarantines without opening a stream', async () => {
    const flow = await uploadedFlow(7);
    // Same-key provider corruption: same etag, but the object is now oversized.
    const big = new Uint8Array(CONFIG.singlePutMaxBytes + 1);
    flow.store.seed(flow.id.key, big, { etag: `"etag-${flow.id.generationId}"` });
    const outcome = await verifyUploadedGeneration(workerDeps(flow), flow.payload, fakeAttempt(1), signal());
    assert.equal(outcome.outcome, 'quarantined');
    if (outcome.outcome === 'quarantined') assert.equal(outcome.reason, 'oversize');
    assert.equal(flow.ledger.blobState(flow.id.blobId)!.logicalState, 'expired');
    assert.equal(flow.ledger.generationState(flow.id.generationId)!.generationState, 'quarantined');
    assert.equal(flow.store.readCalls.length, 1, 'the read was attempted but the body was never opened');
  });

  test('a digest mismatch quarantines the generation and expires the blob', async () => {
    const flow = await uploadedFlow(8);
    // Same-key corruption: same etag, different bytes -> digest mismatch.
    const tampered = pngBody(16);
    tampered[9] = (tampered[9]! + 1) % 251;
    flow.store.seed(flow.id.key, tampered, { etag: `"etag-${flow.id.generationId}"` });
    const outcome = await verifyUploadedGeneration(workerDeps(flow), flow.payload, fakeAttempt(1), signal());
    assert.equal(outcome.outcome, 'quarantined');
    if (outcome.outcome === 'quarantined') assert.equal(outcome.reason, 'digest_mismatch');
    assert.equal(flow.ledger.blobState(flow.id.blobId)!.logicalState, 'expired');
    assert.equal(flow.ledger.generationState(flow.id.generationId)!.generationState, 'quarantined');
  });

  test('a HEAD etag mismatch after attestation is same-key corruption -> quarantine', async () => {
    const flow = await uploadedFlow(9);
    flow.store.options.forceHeadEtag = '"different-etag"';
    const outcome = await verifyUploadedGeneration(workerDeps(flow), flow.payload, fakeAttempt(1), signal());
    assert.equal(outcome.outcome, 'quarantined');
    if (outcome.outcome === 'quarantined') assert.equal(outcome.reason, 'etag_mismatch_after_attestation');
    assert.equal(flow.ledger.blobState(flow.id.blobId)!.logicalState, 'expired');
  });

  test('a missing object after attestation quarantines', async () => {
    const flow = await uploadedFlow(10);
    flow.store.options.forceHeadNotFound = true;
    const outcome = await verifyUploadedGeneration(workerDeps(flow), flow.payload, fakeAttempt(1), signal());
    assert.equal(outcome.outcome, 'quarantined');
    assert.equal(flow.ledger.blobState(flow.id.blobId)!.logicalState, 'expired');
  });
});

describe('P4A-I09 worker coordinator: retryable provider outcomes', () => {
  test('a retryable read leaves the blob in verifying for a later worker', async () => {
    const flow = await uploadedFlow(11);
    flow.store.options.forceReadClass = 'retryable';
    const outcome = await verifyUploadedGeneration(workerDeps(flow), flow.payload, fakeAttempt(1), signal());
    assert.equal(outcome.outcome, 'retryable');
    if (outcome.outcome === 'retryable') assert.equal(outcome.reason, 'read_retryable');
    const blob = flow.ledger.blobState(flow.id.blobId)!;
    assert.equal(blob.logicalState, 'verifying');
    assert.equal(blob.verificationLeaseGeneration, 1001n);
  });

  test('a denied HEAD is retryable, never corruption', async () => {
    const flow = await uploadedFlow(12);
    flow.store.options.forceHeadClass = 'denied';
    const outcome = await verifyUploadedGeneration(workerDeps(flow), flow.payload, fakeAttempt(1), signal());
    assert.equal(outcome.outcome, 'retryable');
    if (outcome.outcome === 'retryable') assert.equal(outcome.reason, 'head_denied');
    assert.equal(flow.ledger.blobState(flow.id.blobId)!.logicalState, 'verifying');
  });

  test('a mid-stream interruption is retryable (unified, not corruption)', async () => {
    const flow = await uploadedFlow(13, pngBody(40));
    flow.store.options.failStreamAfterBytes = 12;
    const outcome = await verifyUploadedGeneration(workerDeps(flow), flow.payload, fakeAttempt(1), signal());
    assert.equal(outcome.outcome, 'retryable');
    assert.equal(flow.ledger.blobState(flow.id.blobId)!.logicalState, 'verifying');
  });
});

describe('P4A-I09 worker coordinator: replaced generation terminal convergence (FIX-L-045)', () => {
  test('a stale event for an authoritatively replaced generation converges terminal (already_replaced) without touching the new generation', async () => {
    const flow = await uploadedFlow(40);
    // A second generation completes and activates as the replacement over the
    // first: the pointer moves and g1 is retired in ONE CAS (mirrored by the
    // in-memory ledger exactly like the production activateReplacement).
    const g2 = identityFor(41);
    const body2 = pngBody(21);
    flow.store.seed(g2.key, body2, { etag: `"etag-${g2.generationId}"` });
    await flow.uow.execute(({ transaction }) => flow.ledger.allocate(transaction, allocateInput(g2, {
      blobId: flow.id.blobId,
      expectedSize: body2.byteLength,
      expectedSha256: sha256HexBytes(body2),
      mediaHint: 'image/png',
    })));
    const cas = await flow.uow.execute(({ transaction }) => flow.ledger.completeUploadCas(transaction, {
      intentId: g2.intentId,
      generationId: g2.generationId,
      blobId: flow.id.blobId,
      actorPrincipalId: I09_PRINCIPAL,
      declaredSize: body2.byteLength,
      declaredSha256: sha256HexBytes(body2),
      declaredMediaType: 'image/png',
      observedEtag: `"etag-${g2.generationId}"`,
      observedSize: body2.byteLength,
      observedContentType: 'image/png',
      observedMetadata: {},
    }));
    assert.equal(cas.outcome, 'uploaded');
    const activation = await flow.uow.execute(({ transaction }) => flow.ledger.activateReplacement(transaction, {
      blobId: flow.id.blobId,
      expectedActiveGenerationId: flow.id.generationId,
      newGenerationId: g2.generationId,
    }));
    assert.equal(activation.outcome, 'activated');
    assert.equal(flow.ledger.generationState(flow.id.generationId)!.generationState, 'retired');
    assert.equal(flow.ledger.blobState(flow.id.blobId)!.currentGenerationId, g2.generationId);

    // The OLD event redelivers: the claim proves the replacement inside the
    // transaction and terminates WITHOUT any provider traffic or mutation.
    // (The store already carries the complete-phase HEAD calls; the stale
    // event must add none.)
    const headCallsBefore = flow.store.headCalls.length;
    const readCallsBefore = flow.store.readCalls.length;
    const outcome = await verifyUploadedGeneration(workerDeps(flow), flow.payload, fakeAttempt(2), signal());
    assert.equal(outcome.outcome, 'already_replaced');
    if (outcome.outcome !== 'already_replaced') return;
    assert.equal(outcome.blobId, flow.id.blobId);
    assert.equal(outcome.generationId, flow.id.generationId);
    assert.equal(flow.store.headCalls.length, headCallsBefore, 'no provider HEAD may run for a replaced generation');
    assert.equal(flow.store.readCalls.length, readCallsBefore, 'no provider read may run for a replaced generation');
    const blob = flow.ledger.blobState(flow.id.blobId)!;
    assert.equal(blob.logicalState, 'uploaded', 'the stale event must not alter the blob state');
    assert.equal(blob.currentGenerationId, g2.generationId, 'the new generation pointer must stay untouched');
    assert.equal(blob.verifiedSize, null);
    assert.equal(flow.ledger.generationState(g2.generationId)!.generationState, 'active');

    // The NEW generation's own event still verifies and stores its facts.
    const fresh = await verifyUploadedGeneration(workerDeps(flow), {
      blobId: flow.id.blobId,
      generationId: g2.generationId,
      intentId: g2.intentId,
    }, fakeAttempt(3), signal());
    assert.equal(fresh.outcome, 'stored_private');
    assert.equal(flow.ledger.blobState(flow.id.blobId)!.verifiedSha256, expectedDigest(body2));
  });

  test('a non-current generation that is NOT authoritatively replaced stays retryable (lease_lost), never dropping a real verification', async () => {
    const flow = await uploadedFlow(42);
    // An event for an `observed` replacement candidate whose activation has
    // NOT committed yet: the pointer still names g1, so the candidate is
    // non-current but NOT terminal — the claim must retry, not complete.
    const g2 = identityFor(43);
    await flow.uow.execute(({ transaction }) => flow.ledger.allocate(transaction, allocateInput(g2, { blobId: flow.id.blobId })));
    const cas = await flow.uow.execute(({ transaction }) => flow.ledger.completeUploadCas(transaction, {
      intentId: g2.intentId,
      generationId: g2.generationId,
      blobId: flow.id.blobId,
      actorPrincipalId: I09_PRINCIPAL,
      declaredSize: 16,
      declaredSha256: 'a'.repeat(64),
      declaredMediaType: 'image/png',
      observedEtag: `"etag-${g2.generationId}"`,
      observedSize: 16,
      observedContentType: 'image/png',
      observedMetadata: {},
    }));
    assert.equal(cas.outcome, 'uploaded');
    assert.equal(flow.ledger.generationState(g2.generationId)!.generationState, 'observed');
    assert.equal(flow.ledger.blobState(flow.id.blobId)!.currentGenerationId, flow.id.generationId);

    const claim = await flow.uow.execute(({ transaction }) => flow.ledger.claimVerification(transaction, {
      blobId: flow.id.blobId,
      generationId: g2.generationId,
      attempt: fakeAttempt(1),
      leaseTtlSeconds: 60,
    }));
    assert.equal(claim.outcome, 'lease_lost');
    const outcome = await verifyUploadedGeneration(workerDeps(flow), {
      blobId: flow.id.blobId,
      generationId: g2.generationId,
      intentId: g2.intentId,
    }, fakeAttempt(1), signal());
    assert.equal(outcome.outcome, 'lease_lost');
    const blob = flow.ledger.blobState(flow.id.blobId)!;
    assert.equal(blob.logicalState, 'uploaded', 'a retryable claim must not mutate the blob');
    assert.equal(flow.ledger.generationState(flow.id.generationId)!.generationState, 'active', 'the current generation must stay untouched');
  });
});
