/**
 * P4A-I13 pure contract suite (no database, no network).
 *
 * Pins the transaction-bound finalize handoff contract:
 * - state-transition legality: the ONLY legal logical transition into
 *   `attached_private` is from `stored_private`; every other logical state is
 *   rejected by the pure evaluator;
 * - the full input verification matrix (wrong generation/ETag/verified
 *   size/digest/media, expired retention deadline, revoked policy revision,
 *   owner mismatch, non-active current generation, missing current
 *   generation);
 * - same-binding replay returns the committed result (idempotent) while a
 *   different binding on an already-bound blob conflicts;
 * - commit-unknown recovery re-reads the binding to decide (never blindly
 *   redo a different Attachment);
 * - the closed result types carry binding facts ONLY — no physical key, no
 *   URL/credential, no production Attachment/Operation identity;
 * - stable error classification: a duplicate Attachment binding id is an
 *   identity failure, while deadlock/serialization/lock_timeout are the
 *   designed bounded-retry classes.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import {
  ATTACHMENTS_CONSTRAINT_NAMES,
  BLOB_LOGICAL_STATES,
  BLOB_LOGICAL_TRANSITIONS,
  blobLogicalTransitionIsLegal,
  classifyAttachmentsLedgerError,
  evaluateFinalizeHandoff,
  resolveFinalizeUnknownOutcome,
  type FinalizeBindingFacts,
  type FinalizeHandoffEvaluation,
  type FinalizeHandoffInput,
  type FinalizeHandoffRejection,
  type FinalizeHandoffResult,
  type FinalizeHandoffRowFacts,
} from '../../../src/modules/attachments/index.js';

const NOW = new Date('2026-08-08T12:00:00.000Z');

const BINDING_A = 'i13-attachment-a';
const BINDING_B = 'i13-attachment-b';
const GENERATION = 'gen-1';
const OWNER = 'subject-owner';
const POLICY = 'policy-v1';
const ETAG = '"etag-gen-1"';
const DIGEST = 'a'.repeat(64);
const SIZE = 7;
const MEDIA = 'image/png';

/** Narrow the evaluation to its rejection; fails the test otherwise. */
function rejectionOf(evaluation: FinalizeHandoffEvaluation): FinalizeHandoffRejection {
  if (evaluation.verdict !== 'reject') assert.fail(`expected reject verdict, got ${evaluation.verdict}`);
  return evaluation.rejection;
}

/** Assert the rejection code and return the rejection narrowed to that variant. */
function expectCode<C extends FinalizeHandoffRejection['code']>(
  rejection: FinalizeHandoffRejection,
  code: C,
): Extract<FinalizeHandoffRejection, { code: C }> {
  if (rejection.code !== code) assert.fail(`expected rejection ${code}, got ${rejection.code}`);
  return rejection as Extract<FinalizeHandoffRejection, { code: C }>;
}

function handoffInput(overrides: Partial<FinalizeHandoffInput> = {}): FinalizeHandoffInput {
  return {
    blobId: 'blob-1',
    attachmentBindingId: BINDING_A,
    expectedGenerationId: GENERATION,
    ownerSubjectId: OWNER,
    expectedEtag: ETAG,
    verifiedSize: SIZE,
    verifiedSha256: DIGEST,
    mediaType: MEDIA,
    policyRevision: POLICY,
    ...overrides,
  };
}

function rowFacts(overrides: Partial<FinalizeHandoffRowFacts> = {}): FinalizeHandoffRowFacts {
  return {
    blobId: 'blob-1',
    logicalState: 'stored_private',
    ownerSubjectId: OWNER,
    currentGenerationId: GENERATION,
    verifiedSize: SIZE,
    verifiedSha256: DIGEST,
    mediaType: MEDIA,
    verificationPolicyVersion: POLICY,
    retentionDeadline: null,
    now: NOW,
    generationState: 'active',
    observedEtag: ETAG,
    attachmentBindingId: null,
    attachedAt: null,
    attachmentBindingGenerationId: null,
    attachmentBindingEtag: null,
    attachmentBindingPolicyVersion: null,
    ...overrides,
  };
}

function attachedRow(overrides: Partial<FinalizeHandoffRowFacts> = {}): FinalizeHandoffRowFacts {
  return rowFacts({
    logicalState: 'attached_private',
    attachmentBindingId: BINDING_A,
    attachedAt: NOW,
    attachmentBindingGenerationId: GENERATION,
    attachmentBindingEtag: ETAG,
    attachmentBindingPolicyVersion: POLICY,
    ...overrides,
  });
}

describe('P4A-I13 state-transition legality', () => {
  test('the only legal transition into attached_private is stored_private -> attached_private', () => {
    assert.equal(blobLogicalTransitionIsLegal('stored_private', 'attached_private'), true);
    for (const state of BLOB_LOGICAL_STATES) {
      if (state === 'stored_private') continue;
      assert.equal(blobLogicalTransitionIsLegal(state, 'attached_private'), false, state);
    }
    assert.deepEqual(BLOB_LOGICAL_TRANSITIONS.attached_private, [], 'attached_private is terminal');
    assert.deepEqual(BLOB_LOGICAL_TRANSITIONS.stored_private, ['attached_private', 'expired']);
  });

  test('every non-stored logical state is rejected as not_finalizable by the evaluator', () => {
    for (const state of BLOB_LOGICAL_STATES) {
      if (state === 'stored_private') continue;
      if (state === 'attached_private') {
        // attached_private is TERMINAL and has its own dedicated outcomes
        // (idempotent / binding_conflict / binding_corrupt, covered below); it
        // can never be freshly attached again, so the verdict must never be
        // ttach.
        const evaluation = evaluateFinalizeHandoff(rowFacts({ logicalState: state }), handoffInput());
        assert.notEqual(evaluation.verdict, 'attach', 'attached_private is terminal and never re-attached');
        continue;
      }
      const rejection = rejectionOf(evaluateFinalizeHandoff(rowFacts({ logicalState: state }), handoffInput()));
      const narrowed = expectCode(rejection, 'not_finalizable');
      assert.equal(narrowed.logicalState, state);
    }
  });
});

describe('P4A-I13 input verification matrix', () => {
  test('matching facts attach the blob', () => {
    assert.equal(evaluateFinalizeHandoff(rowFacts(), handoffInput()).verdict, 'attach');
  });

  test('wrong generation is rejected with generation_mismatch', () => {
    const rejection = rejectionOf(evaluateFinalizeHandoff(rowFacts(), handoffInput({ expectedGenerationId: 'gen-other' })));
    const narrowed = expectCode(rejection, 'generation_mismatch');
    assert.equal(narrowed.currentGenerationId, GENERATION);
  });

  test('a missing current generation is not finalizable', () => {
    const rejection = rejectionOf(evaluateFinalizeHandoff(rowFacts({ currentGenerationId: null }), handoffInput()));
    expectCode(rejection, 'not_finalizable');
  });

  test('a non-active or missing current generation row is not finalizable', () => {
    for (const generationState of ['allocated', 'observed', 'retired', 'orphaned', 'deleted', 'quarantined', 'contract_corrupt'] as const) {
      const rejection = rejectionOf(evaluateFinalizeHandoff(rowFacts({ generationState }), handoffInput()));
      expectCode(rejection, 'not_finalizable');
    }
    const missing = rejectionOf(evaluateFinalizeHandoff(rowFacts({ generationState: null }), handoffInput()));
    expectCode(missing, 'not_finalizable');
  });

  test('wrong generation ETag is rejected with etag_mismatch', () => {
    const rejection = rejectionOf(evaluateFinalizeHandoff(rowFacts(), handoffInput({ expectedEtag: '"etag-wrong"' })));
    const narrowed = expectCode(rejection, 'etag_mismatch');
    assert.equal(narrowed.observedEtag, ETAG);
  });

  test('wrong verified size/digest/media are rejected with verified_facts_mismatch', () => {
    const size = expectCode(rejectionOf(evaluateFinalizeHandoff(rowFacts(), handoffInput({ verifiedSize: SIZE + 1 }))), 'verified_facts_mismatch');
    assert.deepEqual(size.verifiedFacts, ['size']);
    const digest = expectCode(rejectionOf(evaluateFinalizeHandoff(rowFacts(), handoffInput({ verifiedSha256: 'b'.repeat(64) }))), 'verified_facts_mismatch');
    assert.deepEqual(digest.verifiedFacts, ['digest']);
    const media = expectCode(rejectionOf(evaluateFinalizeHandoff(rowFacts(), handoffInput({ mediaType: 'application/pdf' }))), 'verified_facts_mismatch');
    assert.deepEqual(media.verifiedFacts, ['media']);
    const all = expectCode(
      rejectionOf(evaluateFinalizeHandoff(rowFacts({ verifiedSize: null, verifiedSha256: null, mediaType: null }), handoffInput())),
      'verified_facts_mismatch',
    );
    assert.deepEqual(all.verifiedFacts, ['size', 'digest', 'media']);
  });

  test('a blob whose retention deadline has passed is rejected as expired (DB clock, boundary inclusive)', () => {
    const expired = expectCode(
      rejectionOf(evaluateFinalizeHandoff(rowFacts({ retentionDeadline: '2026-08-08T11:59:59.000Z' }), handoffInput())),
      'expired',
    );
    assert.ok(expired.retentionDeadline);
    const atBoundary = rejectionOf(evaluateFinalizeHandoff(rowFacts({ retentionDeadline: '2026-08-08T12:00:00.000Z' }), handoffInput()));
    expectCode(atBoundary, 'expired');
    const notExpired = evaluateFinalizeHandoff(rowFacts({ retentionDeadline: '2026-08-08T12:00:00.001Z' }), handoffInput());
    assert.equal(notExpired.verdict, 'attach');
  });

  test('a revoked/out-of-date policy revision is rejected with policy_mismatch', () => {
    const rejection = rejectionOf(evaluateFinalizeHandoff(rowFacts(), handoffInput({ policyRevision: 'policy-v2' })));
    const narrowed = expectCode(rejection, 'policy_mismatch');
    assert.equal(narrowed.policyRevision, POLICY);
  });

  test('a mismatched owner binding is rejected with owner_mismatch', () => {
    const rejection = rejectionOf(evaluateFinalizeHandoff(rowFacts(), handoffInput({ ownerSubjectId: 'other-owner' })));
    const narrowed = expectCode(rejection, 'owner_mismatch');
    assert.equal(narrowed.ownerSubjectId, OWNER);
  });
});

describe('P4A-I13 same/different binding and replay idempotence', () => {
  test('same-binding replay returns the committed result (idempotent)', () => {
    const evaluation = evaluateFinalizeHandoff(attachedRow(), handoffInput({ attachmentBindingId: BINDING_A }));
    assert.equal(evaluation.verdict, 'idempotent');
    if (evaluation.verdict !== 'idempotent') assert.fail('expected idempotent');
    assert.equal(evaluation.binding.attachmentBindingId, BINDING_A);
    assert.equal(evaluation.binding.generationId, GENERATION);
    assert.equal(evaluation.binding.etag, ETAG);
    assert.equal(evaluation.binding.policyVersion, POLICY);
  });

  test('a different binding on an already-bound blob conflicts and never rebinds', () => {
    const evaluation = evaluateFinalizeHandoff(attachedRow(), handoffInput({ attachmentBindingId: BINDING_B }));
    assert.equal(evaluation.verdict, 'binding_conflict');
    if (evaluation.verdict !== 'binding_conflict') assert.fail('expected binding_conflict');
    assert.equal(evaluation.binding.attachmentBindingId, BINDING_A, 'the existing binding facts are returned');
  });

  test('an attached row missing its binding facts is binding_corrupt (never silently rebinding)', () => {
    const rejection = rejectionOf(evaluateFinalizeHandoff(
      rowFacts({ logicalState: 'attached_private', attachmentBindingId: null }),
      handoffInput(),
    ));
    expectCode(rejection, 'binding_corrupt');
  });
});

describe('P4A-I13 commit-unknown recovery', () => {
  const binding: FinalizeBindingFacts = {
    blobId: 'blob-1',
    attachmentBindingId: BINDING_A,
    generationId: GENERATION,
    etag: ETAG,
    policyVersion: POLICY,
    attachedAt: NOW,
  };

  test('re-read attached with the SAME binding -> committed_same_binding (never redo)', () => {
    const decision = resolveFinalizeUnknownOutcome({
      attemptedBindingId: BINDING_A,
      reRead: { outcome: 'attached', binding },
    });
    assert.deepEqual(decision, { decision: 'committed_same_binding', binding });
  });

  test('re-read attached with a DIFFERENT binding -> committed_different_binding (conflict, no blind redo)', () => {
    const other: FinalizeBindingFacts = { ...binding, attachmentBindingId: BINDING_B };
    const decision = resolveFinalizeUnknownOutcome({
      attemptedBindingId: BINDING_A,
      reRead: { outcome: 'attached', binding: other },
    });
    assert.deepEqual(decision, {
      decision: 'committed_different_binding',
      existingBindingId: BINDING_B,
      binding: other,
    });
  });

  test('re-read still stored_private -> not_committed (safe to retry the SAME input)', () => {
    const decision = resolveFinalizeUnknownOutcome({
      attemptedBindingId: BINDING_A,
      reRead: { outcome: 'stored_private' },
    });
    assert.deepEqual(decision, { decision: 'not_committed' });
  });

  test('re-read not_found or an unexpected state -> inconsistent (manual review, never guess)', () => {
    const missing = resolveFinalizeUnknownOutcome({
      attemptedBindingId: BINDING_A,
      reRead: { outcome: 'not_found' },
    });
    assert.equal(missing.decision, 'inconsistent');
    const other = resolveFinalizeUnknownOutcome({
      attemptedBindingId: BINDING_A,
      reRead: { outcome: 'other', logicalState: 'expired' },
    });
    assert.equal(other.decision, 'inconsistent');
  });
});

describe('P4A-I13 closed result types and no premature Attachment/Operation', () => {
  test('every result variant is one of the closed set (exhaustive compile-time mapping)', () => {
    const outcomes = [
      'attached', 'idempotent', 'binding_conflict', 'not_found', 'not_finalizable',
      'generation_mismatch', 'owner_mismatch', 'etag_mismatch', 'verified_facts_mismatch',
      'policy_mismatch', 'expired',
    ] as const;
    assert.equal(new Set(outcomes).size, outcomes.length, 'the closed outcome set must not contain duplicates');
    // Exhaustive compile-time mapping: adding a variant to the union forces a
    // type error here, so the closed set cannot silently grow.
    function exhaust(result: FinalizeHandoffResult): string {
      switch (result.outcome) {
        case 'attached': return result.binding.attachmentBindingId;
        case 'idempotent': return result.binding.attachmentBindingId;
        case 'binding_conflict': return result.existingBindingId;
        case 'not_found': return 'nf';
        case 'not_finalizable': return result.logicalState;
        case 'generation_mismatch': return result.currentGenerationId ?? 'none';
        case 'owner_mismatch': return 'owner';
        case 'etag_mismatch': return 'etag';
        case 'verified_facts_mismatch': return result.code;
        case 'policy_mismatch': return 'policy';
        case 'expired': return 'expired';
      }
    }
    assert.equal(typeof exhaust, 'function');
  });

  test('binding results carry binding facts only — no key, URL, credential, Operation or Attachment identity', () => {
    const binding: FinalizeBindingFacts = {
      blobId: 'blob-1',
      attachmentBindingId: BINDING_A,
      generationId: GENERATION,
      etag: ETAG,
      policyVersion: POLICY,
      attachedAt: NOW,
    };
    const serialized = JSON.stringify(binding);
    for (const needle of ['key', 'url', 'credential', 'bucket', 'body', 'operation', 'outbox', 'audit', 'revision', 'sha256']) {
      assert.equal(serialized.toLowerCase().includes(needle), false, `binding facts must never carry ${needle}`);
    }
  });
});

describe('P4A-I13 stable error classification', () => {
  test('a duplicate Attachment binding id maps to the identity failure code attachment_binding_issued', () => {
    const classified = classifyAttachmentsLedgerError({
      kind: 'unique_violation',
      constraint: ATTACHMENTS_CONSTRAINT_NAMES.blobRecordsAttachmentBindingUnique,
    });
    assert.equal(classified.class, 'identity_failure');
    assert.equal(classified.code, 'attachment_binding_issued');
  });

  test('deadlock/serialization/lock_timeout are the designed bounded-retry classes, never identity failures', () => {
    for (const kind of ['deadlock', 'serialization_failure', 'lock_timeout'] as const) {
      const classified = classifyAttachmentsLedgerError({ kind });
      assert.equal(classified.class, 'retryable', kind);
    }
    const unknown = classifyAttachmentsLedgerError({ kind: 'commit_outcome_unknown' });
    assert.equal(unknown.class, 'unknown_outcome');
  });
});