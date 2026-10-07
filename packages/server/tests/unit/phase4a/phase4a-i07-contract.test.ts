/**
 * P4A-I07 pure contract suite (no database, no network).
 *
 * Pins the §3.1/§3.2 state machine legality, the stable identity-error mapping
 * from named PostgreSQL constraints, the cleanup claim/commit CAS verdict
 * resolution, lease takeover, the cleanup keyset cursor logic (first/middle/
 * final batch cursor provenance), and the fixed provider-metadata allowlist.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import {
  ALLOWED_OBSERVED_METADATA_KEYS,
  ATTACHMENTS_CONSTRAINT_NAMES,
  ATTACHMENTS_IDENTITY_CONSTRAINTS,
  AttachmentsIdentityError,
  BLOB_LOGICAL_STATES,
  BLOB_LOGICAL_TRANSITIONS,
  GENERATION_STATES,
  GENERATION_TRANSITIONS,
  assertObservedMetadataAllowlist,
  attachmentsIdentityCodeForConstraint,
  blobLogicalTransitionIsLegal,
  canTakeoverCleanupLease,
  candidateMatchesClaim,
  canonicalizeObservedMetadata,
  claimFactsMatch,
  classifyAttachmentsLedgerError,
  cleanupCursorIsStrictlyAfter,
  compareCleanupKeys,
  generationTransitionIsLegal,
  nextCleanupKeysetCursor,
  resolveCleanupVerdict,
} from '../../../src/modules/attachments/attachments-ledger-contract.js';

const CLAIM = { observedEtag: '"etag-1"', observedSize: 7 };

describe('P4A-I07 §3.2 physical generation state machine', () => {
  test('the transition table matches the plan and every state is terminal or reachable', () => {
    assert.deepEqual(
      Object.keys(GENERATION_TRANSITIONS).sort(),
      [...GENERATION_STATES].sort(),
    );
    assert.deepEqual(GENERATION_TRANSITIONS.allocated, ['observed', 'orphaned', 'contract_corrupt']);
    assert.deepEqual(GENERATION_TRANSITIONS.observed, ['active', 'orphaned', 'contract_corrupt']);
    assert.deepEqual(GENERATION_TRANSITIONS.active, ['retired', 'contract_corrupt']);
    assert.deepEqual(GENERATION_TRANSITIONS.orphaned, ['deletion_pending', 'contract_corrupt']);
    assert.deepEqual(GENERATION_TRANSITIONS.retired, ['deletion_pending', 'contract_corrupt']);
    assert.deepEqual(GENERATION_TRANSITIONS.deletion_pending, ['deleted', 'contract_corrupt']);
    assert.deepEqual(GENERATION_TRANSITIONS.contract_corrupt, ['quarantined']);
    assert.deepEqual(GENERATION_TRANSITIONS.deleted, []);
    assert.deepEqual(GENERATION_TRANSITIONS.quarantined, []);
  });

  test('legal transitions are accepted and illegal ones are rejected', () => {
    const legal = [
      ['allocated', 'observed'],
      ['allocated', 'orphaned'],
      ['observed', 'active'],
      ['observed', 'orphaned'],
      ['active', 'retired'],
      ['orphaned', 'deletion_pending'],
      ['retired', 'deletion_pending'],
      ['deletion_pending', 'deleted'],
      ['active', 'contract_corrupt'],
      ['deletion_pending', 'contract_corrupt'],
      ['contract_corrupt', 'quarantined'],
    ] as const;
    for (const [from, to] of legal) {
      assert.equal(generationTransitionIsLegal(from, to), true, `${from}->${to}`);
    }
    const illegal = [
      ['allocated', 'active'],
      ['observed', 'retired'],
      ['active', 'observed'],
      ['active', 'orphaned'],
      ['retired', 'deleted'],
      ['orphaned', 'deleted'],
      ['deleted', 'contract_corrupt'],
      ['quarantined', 'contract_corrupt'],
      ['deleted', 'deletion_pending'],
      ['quarantined', 'deletion_pending'],
    ] as const;
    for (const [from, to] of illegal) {
      assert.equal(generationTransitionIsLegal(from, to), false, `${from}->${to}`);
    }
  });
});

describe('P4A-I07 §3.1 logical blob state machine', () => {
  test('the transition table matches the plan and rejects shortcuts', () => {
    assert.deepEqual(
      Object.keys(BLOB_LOGICAL_TRANSITIONS).sort(),
      [...BLOB_LOGICAL_STATES].sort(),
    );
    assert.deepEqual(BLOB_LOGICAL_TRANSITIONS.issued, ['uploaded', 'expired']);
    assert.deepEqual(BLOB_LOGICAL_TRANSITIONS.uploaded, ['verifying', 'expired']);
    assert.deepEqual(BLOB_LOGICAL_TRANSITIONS.verifying, ['stored_private', 'expired']);
    assert.deepEqual(BLOB_LOGICAL_TRANSITIONS.stored_private, ['attached_private', 'expired']);
    assert.deepEqual(BLOB_LOGICAL_TRANSITIONS.attached_private, []);
    assert.deepEqual(BLOB_LOGICAL_TRANSITIONS.expired, []);
    assert.equal(blobLogicalTransitionIsLegal('issued', 'stored_private'), false);
    assert.equal(blobLogicalTransitionIsLegal('issued', 'uploaded'), true);
    assert.equal(blobLogicalTransitionIsLegal('stored_private', 'attached_private'), true);
    assert.equal(blobLogicalTransitionIsLegal('attached_private', 'expired'), false);
  });
});

describe('P4A-I07 stable identity errors and constraint mapping', () => {
  test('named production constraints map to stable identity codes', () => {
    assert.equal(attachmentsIdentityCodeForConstraint(ATTACHMENTS_CONSTRAINT_NAMES.generationKeysKeyUnique), 'key_issued');
    assert.equal(attachmentsIdentityCodeForConstraint(ATTACHMENTS_CONSTRAINT_NAMES.generationKeysFingerprintUnique), 'fingerprint_issued');
    assert.equal(attachmentsIdentityCodeForConstraint(ATTACHMENTS_CONSTRAINT_NAMES.generationKeysPkey), 'generation_issued');
    assert.equal(attachmentsIdentityCodeForConstraint(ATTACHMENTS_CONSTRAINT_NAMES.uploadIntentsGenerationUnique), 'generation_issued');
    assert.equal(attachmentsIdentityCodeForConstraint(ATTACHMENTS_CONSTRAINT_NAMES.uploadIntentsIdempotencyUnique), 'idempotency_conflict');
    assert.equal(attachmentsIdentityCodeForConstraint(ATTACHMENTS_CONSTRAINT_NAMES.blobGenerationsKeyUnique), 'key_issued');
    assert.equal(attachmentsIdentityCodeForConstraint(ATTACHMENTS_CONSTRAINT_NAMES.blobGenerationsKeyFingerprintUnique), 'fingerprint_issued');
    assert.equal(attachmentsIdentityCodeForConstraint(ATTACHMENTS_CONSTRAINT_NAMES.blobGenerationsOneActivePerBlob), 'one_active_per_blob');
    assert.equal(attachmentsIdentityCodeForConstraint('some_unrelated_constraint'), null);
    assert.equal(attachmentsIdentityCodeForConstraint(null), null);
  });

  test('identity failures are distinct from retryable database failures', () => {
    const identity = classifyAttachmentsLedgerError(new AttachmentsIdentityError('key_issued'));
    assert.equal(identity.class, 'identity_failure');
    assert.equal(identity.code, 'key_issued');

    // Structural mapping mirrors DatabaseOperationError without importing infra.
    const unique = classifyAttachmentsLedgerError({
      kind: 'unique_violation', constraint: ATTACHMENTS_CONSTRAINT_NAMES.generationKeysKeyUnique,
    });
    assert.equal(unique.class, 'identity_failure');
    assert.equal(unique.code, 'key_issued');
    assert.equal(unique.constraint, ATTACHMENTS_CONSTRAINT_NAMES.generationKeysKeyUnique);

    const oneActive = classifyAttachmentsLedgerError({
      kind: 'unique_violation', constraint: ATTACHMENTS_CONSTRAINT_NAMES.blobGenerationsOneActivePerBlob,
    });
    assert.equal(oneActive.class, 'identity_failure');
    assert.equal(oneActive.code, 'one_active_per_blob');

    for (const kind of ['serialization_failure', 'deadlock', 'lock_timeout', 'unavailable'] as const) {
      const classified = classifyAttachmentsLedgerError({ kind });
      assert.equal(classified.class, 'retryable', kind);
    }
    assert.equal(
      classifyAttachmentsLedgerError({ kind: 'commit_outcome_unknown' }).class,
      'unknown_outcome',
    );
    assert.equal(
      classifyAttachmentsLedgerError({ kind: 'database_failure', constraint: 'some_ck' }).class,
      'database_failure',
    );
    assert.equal(classifyAttachmentsLedgerError(new Error('boom')).class, 'database_failure');
    assert.equal(classifyAttachmentsLedgerError(undefined).class, 'database_failure');
  });

  test('every identity constraint name is a real entry in the catalog', () => {
    for (const name of Object.values(ATTACHMENTS_IDENTITY_CONSTRAINTS)) {
      assert.ok(name.length > 0);
    }
    const catalogNames = new Set(Object.keys(ATTACHMENTS_IDENTITY_CONSTRAINTS));
    for (const key of [
      'generation_keys_key_unique',
      'generation_keys_key_fingerprint_unique',
      'generation_keys_pkey',
      'upload_intents_generation_id_unique',
      'upload_intents_blob_idempotency_unique',
      'blob_generations_key_unique',
      'blob_generations_key_fingerprint_unique',
      'blob_generations_one_active_per_blob',
    ]) {
      assert.ok(catalogNames.has(key), `missing identity constraint catalog entry ${key}`);
    }
  });
});

describe('P4A-I07 cleanup CAS verdict resolution', () => {
  test('head not-found confirms absence with no DELETE', () => {
    const result = resolveCleanupVerdict({ claim: CLAIM, headBefore: { class: 'not_found' } });
    assert.equal(result.verdict, 'confirmed_absent');
    assert.equal(result.deleteAttempted, false);
    assert.equal(result.detail, 'exact_key_head_not_found_before_delete');
  });

  test('head etag/size mismatch quarantines before any DELETE', () => {
    const result = resolveCleanupVerdict({
      claim: CLAIM,
      headBefore: { class: 'ok', etag: '"tampered"', size: 999 },
    });
    assert.equal(result.verdict, 'candidate_mismatch');
    assert.equal(result.deleteAttempted, false);
    assert.equal(candidateMatchesClaim(CLAIM, { etag: '"tampered"', size: 999 }), false);
    assert.equal(candidateMatchesClaim(CLAIM, { etag: '"etag-1"', size: 7 }), true);
  });

  test('DELETE success only counts with confirmed absence', () => {
    const deleted = resolveCleanupVerdict({
      claim: CLAIM,
      headBefore: { class: 'ok', etag: '"etag-1"', size: 7 },
      deleteOutcome: { class: 'deleted' },
      headAfter: { class: 'not_found' },
    });
    assert.equal(deleted.verdict, 'deleted');
    assert.equal(deleted.deleteAttempted, true);
    assert.equal(deleted.detail, 'delete_plus_confirmed_absent_head');

    const stillPresent = resolveCleanupVerdict({
      claim: CLAIM,
      headBefore: { class: 'ok', etag: '"etag-1"', size: 7 },
      deleteOutcome: { class: 'deleted' },
      headAfter: { class: 'ok', etag: '"etag-1"', size: 7 },
    });
    assert.equal(stillPresent.verdict, 'unknown_retryable');
    assert.equal(stillPresent.detail, 'object_still_present_after_delete');
  });

  test('DELETE unknown reconciled to absent converges as deleted; still-present stays retryable', () => {
    const reconciled = resolveCleanupVerdict({
      claim: CLAIM,
      headBefore: { class: 'ok', etag: '"etag-1"', size: 7 },
      deleteOutcome: { class: 'unknown' },
      headAfter: { class: 'not_found' },
    });
    assert.equal(reconciled.verdict, 'deleted');
    assert.equal(reconciled.detail, 'delete_unknown_reconciled_absent_by_head');

    const present = resolveCleanupVerdict({
      claim: CLAIM,
      headBefore: { class: 'ok', etag: '"etag-1"', size: 7 },
      deleteOutcome: { class: 'unknown' },
      headAfter: { class: 'ok', etag: '"etag-1"', size: 7 },
    });
    assert.equal(present.verdict, 'unknown_retryable');
    assert.equal(present.detail, 'delete_unknown_object_still_present');
  });

  test('a delete not attempted stays retryable; provider denial/retryable stay retryable', () => {
    assert.equal(
      resolveCleanupVerdict({ claim: CLAIM, headBefore: { class: 'ok', etag: '"etag-1"', size: 7 } }).verdict,
      'unknown_retryable',
    );
    assert.equal(
      resolveCleanupVerdict({
        claim: CLAIM,
        headBefore: { class: 'ok', etag: '"etag-1"', size: 7 },
        deleteOutcome: { class: 'denied' },
      }).verdict,
      'unknown_retryable',
    );
  });
});

describe('P4A-I07 cleanup lease takeover', () => {
  test('a lease may only be taken over after the database deadline', () => {
    const now = new Date('2026-08-08T00:00:00.000Z');
    assert.equal(canTakeoverCleanupLease(new Date('2026-08-08T00:00:01.000Z'), now), false);
    assert.equal(canTakeoverCleanupLease(new Date('2026-08-07T23:59:59.000Z'), now), true);
    assert.equal(canTakeoverCleanupLease(null, now), true);
  });

  test('the claim fence compares attempt token, owner, and lease generation', () => {
    const claim = { attemptToken: 'a1', leaseOwner: 'worker-1', leaseGeneration: 2n };
    assert.equal(claimFactsMatch(claim, {
      cleanupAttemptToken: 'a1', cleanupLeaseOwner: 'worker-1', cleanupLeaseGeneration: '2',
    }), true);
    assert.equal(claimFactsMatch(claim, {
      cleanupAttemptToken: 'a2', cleanupLeaseOwner: 'worker-1', cleanupLeaseGeneration: 2n,
    }), false);
    assert.equal(claimFactsMatch(claim, {
      cleanupAttemptToken: 'a1', cleanupLeaseOwner: 'worker-2', cleanupLeaseGeneration: 2n,
    }), false);
    assert.equal(claimFactsMatch(claim, {
      cleanupAttemptToken: 'a1', cleanupLeaseOwner: 'worker-1', cleanupLeaseGeneration: 3n,
    }), false);
  });
});

describe('P4A-I07 cleanup keyset cursor logic', () => {
  const FIRST = nextCleanupKeysetCursor({ createdAt: '2026-08-08T00:00:00.000Z', generationId: 'gen-001' });
  const SECOND = nextCleanupKeysetCursor({ createdAt: '2026-08-08T00:00:01.000Z', generationId: 'gen-002' });

  test('the next cursor is derived from the last claimed row (Date or ISO string)', () => {
    assert.deepEqual(nextCleanupKeysetCursor({ createdAt: '2026-08-08T00:00:01.000Z', generationId: 'gen-002' }), SECOND);
    assert.deepEqual(nextCleanupKeysetCursor({ createdAt: new Date('2026-08-08T00:00:00.000Z'), generationId: 'gen-001' }), FIRST);
  });

  test('keys compare on (created_at, generation_id) exactly like the SQL row comparison', () => {
    assert.equal(compareCleanupKeys(FIRST, FIRST), 0);
    assert.ok(compareCleanupKeys(SECOND, FIRST) > 0, 'later created_at is strictly after');
    assert.ok(compareCleanupKeys(FIRST, SECOND) < 0);
    // Same created_at (same millisecond): generation_id breaks the tie.
    const sameTimeA = nextCleanupKeysetCursor({ createdAt: FIRST.createdAtIso, generationId: 'gen-a' });
    const sameTimeB = nextCleanupKeysetCursor({ createdAt: FIRST.createdAtIso, generationId: 'gen-b' });
    assert.ok(compareCleanupKeys(sameTimeA, sameTimeB) < 0);
    assert.ok(compareCleanupKeys(sameTimeB, sameTimeA) > 0);
  });

  test('strict-after semantics match a keyset page boundary', () => {
    assert.equal(cleanupCursorIsStrictlyAfter(SECOND, FIRST), true);
    assert.equal(cleanupCursorIsStrictlyAfter(FIRST, FIRST), false);
    assert.equal(cleanupCursorIsStrictlyAfter(FIRST, SECOND), false);
    // A cursor derived from the last row of batch N always starts batch N+1.
    const lastOfBatchOne = nextCleanupKeysetCursor({ createdAt: '2026-08-08T00:00:00.499Z', generationId: 'gen-050' });
    const firstOfBatchTwo = nextCleanupKeysetCursor({ createdAt: '2026-08-08T00:00:00.500Z', generationId: 'gen-051' });
    assert.equal(cleanupCursorIsStrictlyAfter(firstOfBatchTwo, lastOfBatchOne), true);
    assert.equal(cleanupCursorIsStrictlyAfter(lastOfBatchOne, firstOfBatchTwo), false);
  });

  test('ISO timestamps compare lexicographically for fixed-format UTC strings', () => {
    const earlier = nextCleanupKeysetCursor({ createdAt: '2026-08-08T00:00:00.999Z', generationId: 'g' });
    const later = nextCleanupKeysetCursor({ createdAt: '2026-08-08T00:00:01.000Z', generationId: 'g' });
    assert.ok(compareCleanupKeys(later, earlier) > 0);
  });
});

describe('P4A-I07 provider metadata allowlist', () => {
  test('canonicalization lowercases keys and strips the x-amz-meta- prefix', () => {
    assert.deepEqual(
      canonicalizeObservedMetadata({ 'X-Amz-Meta-Probe': 'phase4a-i07', NONCE: 'n1' }),
      { probe: 'phase4a-i07', nonce: 'n1' },
    );
    assert.deepEqual(canonicalizeObservedMetadata({}), {});
  });

  test('only the fixed allowlist keys may be bound', () => {
    assert.deepEqual([...ALLOWED_OBSERVED_METADATA_KEYS].sort(), ['nonce', 'probe']);
    assertObservedMetadataAllowlist({ probe: 'x', nonce: 'y' });
    assert.throws(() => assertObservedMetadataAllowlist({ filename: 'secret.txt' }), /metadata_key_not_allowed/);
    assert.throws(() => assertObservedMetadataAllowlist({ probe: 'x', uploader: 'someone' }), /metadata_key_not_allowed/);
  });
});
