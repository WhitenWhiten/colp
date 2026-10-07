/**
 * P4A-I04 production-contract suite (no database, no network).
 *
 * Pins the §3.1/§3.2 state machine legality, production identity-error mapping
 * (`AttachmentsIdentityError` / named constraint codes), cleanup CAS verdict
 * resolution, and lease takeover logic against the production ledger contract.
 * Spike I04IdentityError / probe evidence are not covered here.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { DatabaseOperationError } from '../../../src/infrastructure/database/index.js';
import {
  ATTACHMENTS_CONSTRAINT_NAMES,
  AttachmentsIdentityError,
  BLOB_LOGICAL_STATES,
  BLOB_LOGICAL_TRANSITIONS,
  GENERATION_STATES,
  GENERATION_TRANSITIONS,
  blobLogicalTransitionIsLegal,
  canTakeoverCleanupLease,
  candidateMatchesClaim,
  claimFactsMatch,
  classifyAttachmentsLedgerError,
  generationTransitionIsLegal,
  resolveCleanupVerdict,
} from '../../../src/modules/attachments/index.js';

const CLAIM = { observedEtag: '"etag-1"', observedSize: 7 };

describe('P4A-I04 §3.2 physical generation state machine', () => {
  test('the transition table matches the plan and every state is reachable or terminal', () => {
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

describe('P4A-I04 §3.1 logical blob state machine', () => {
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

describe('P4A-I04 production identity error classes', () => {
  test('identity failures are distinct from retryable database failures', () => {
    const identity = classifyAttachmentsLedgerError(new AttachmentsIdentityError('key_issued'));
    assert.equal(identity.class, 'identity_failure');
    assert.equal(identity.code, 'key_issued');

    const unique = classifyAttachmentsLedgerError(
      new DatabaseOperationError('unique_violation', Object.assign(new Error('dup'), { constraint: ATTACHMENTS_CONSTRAINT_NAMES.generationKeysKeyUnique })),
    );
    assert.equal(unique.class, 'identity_failure');
    assert.equal(unique.code, 'key_issued');

    const oneActive = classifyAttachmentsLedgerError(
      new DatabaseOperationError('unique_violation', Object.assign(new Error('dup'), { constraint: ATTACHMENTS_CONSTRAINT_NAMES.blobGenerationsOneActivePerBlob })),
    );
    assert.equal(oneActive.class, 'identity_failure');
    assert.equal(oneActive.code, 'one_active_per_blob');

    for (const kind of ['serialization_failure', 'deadlock', 'lock_timeout', 'unavailable'] as const) {
      const classified = classifyAttachmentsLedgerError(new DatabaseOperationError(kind, new Error('x')));
      assert.equal(classified.class, 'retryable', kind);
    }
    assert.equal(
      classifyAttachmentsLedgerError(new DatabaseOperationError('commit_outcome_unknown', new Error('x'))).class,
      'unknown_outcome',
    );
    assert.equal(
      classifyAttachmentsLedgerError(new DatabaseOperationError('database_failure', new Error('x'))).class,
      'database_failure',
    );
    assert.equal(classifyAttachmentsLedgerError(new Error('unrelated')).class, 'database_failure');
  });
});

describe('P4A-I04 cleanup CAS verdict resolution', () => {
  test('confirmed absent before delete is convergence without a delete', () => {
    const result = resolveCleanupVerdict({ claim: CLAIM, headBefore: { class: 'not_found' } });
    assert.equal(result.verdict, 'confirmed_absent');
    assert.equal(result.deleteAttempted, false);
  });

  test('delete + confirmed absent HEAD is the normal success path', () => {
    const result = resolveCleanupVerdict({
      claim: CLAIM,
      headBefore: { class: 'ok', etag: '"etag-1"', size: 7 },
      deleteOutcome: { class: 'deleted' },
      headAfter: { class: 'not_found' },
    });
    assert.equal(result.verdict, 'deleted');
    assert.equal(result.deleteAttempted, true);
  });

  test('already-absent delete converges to deleted (not an error)', () => {
    const result = resolveCleanupVerdict({
      claim: CLAIM,
      headBefore: { class: 'ok', etag: '"etag-1"', size: 7 },
      deleteOutcome: { class: 'not_found' },
      headAfter: { class: 'not_found' },
    });
    assert.equal(result.verdict, 'deleted');
    assert.equal(result.deleteAttempted, true);
  });

  test('candidate mismatch quarantines and never attempts a delete', () => {
    const result = resolveCleanupVerdict({
      claim: CLAIM,
      headBefore: { class: 'ok', etag: '"tampered"', size: 99 },
      deleteOutcome: { class: 'deleted' },
      headAfter: { class: 'not_found' },
    });
    assert.equal(result.verdict, 'candidate_mismatch');
    assert.equal(result.deleteAttempted, false, 'mismatch must short-circuit before any DELETE');
  });

  test('DELETE-unknown reconciled to absent is convergence, NOT quarantine', () => {
    const result = resolveCleanupVerdict({
      claim: CLAIM,
      headBefore: { class: 'ok', etag: '"etag-1"', size: 7 },
      deleteOutcome: { class: 'unknown' },
      headAfter: { class: 'not_found' },
    });
    assert.equal(result.verdict, 'deleted', 'DELETE unknown + HEAD absent must converge as deleted');
    assert.equal(result.deleteAttempted, true);
  });

  test('DELETE-unknown reconciled to still-present stays unknown/retryable', () => {
    const result = resolveCleanupVerdict({
      claim: CLAIM,
      headBefore: { class: 'ok', etag: '"etag-1"', size: 7 },
      deleteOutcome: { class: 'unknown' },
      headAfter: { class: 'ok', etag: '"etag-1"', size: 7 },
    });
    assert.equal(result.verdict, 'unknown_retryable');
    assert.equal(result.deleteAttempted, true);
  });

  test('retryable head or delete stays unknown/retryable for a later takeover', () => {
    assert.equal(
      resolveCleanupVerdict({ claim: CLAIM, headBefore: { class: 'unknown' } }).verdict,
      'unknown_retryable',
    );
    assert.equal(
      resolveCleanupVerdict({ claim: CLAIM, headBefore: { class: 'retryable' } }).verdict,
      'unknown_retryable',
    );
    const deletedThenRetryable = resolveCleanupVerdict({
      claim: CLAIM,
      headBefore: { class: 'ok', etag: '"etag-1"', size: 7 },
      deleteOutcome: { class: 'retryable' },
    });
    assert.equal(deletedThenRetryable.verdict, 'unknown_retryable');
    assert.equal(deletedThenRetryable.deleteAttempted, true);
  });

  test('denied delete is never recorded as success', () => {
    const result = resolveCleanupVerdict({
      claim: CLAIM,
      headBefore: { class: 'ok', etag: '"etag-1"', size: 7 },
      deleteOutcome: { class: 'denied' },
    });
    assert.equal(result.verdict, 'unknown_retryable');
  });
});

describe('P4A-I04 claim snapshot and lease takeover logic', () => {
  test('candidate matches the claim only on exact etag and size', () => {
    assert.equal(candidateMatchesClaim(CLAIM, { etag: '"etag-1"', size: 7 }), true);
    assert.equal(candidateMatchesClaim(CLAIM, { etag: '"etag-1"', size: 8 }), false);
    assert.equal(candidateMatchesClaim(CLAIM, { etag: '"other"', size: 7 }), false);
  });

  test('lease takeover is allowed only after the DB-time deadline', () => {
    const now = new Date('2026-08-08T00:00:00.000Z');
    assert.equal(canTakeoverCleanupLease(null, now), true);
    assert.equal(canTakeoverCleanupLease(new Date('2026-08-08T00:00:00.001Z'), now), false);
    assert.equal(canTakeoverCleanupLease(new Date('2026-08-07T23:59:59.000Z'), now), true);
  });

  test('a stale claim never matches a taken-over row (attempt token, owner, lease generation)', () => {
    const row = { cleanupAttemptToken: 'token-b', cleanupLeaseOwner: 'owner-b', cleanupLeaseGeneration: 2n };
    const stale = { attemptToken: 'token-a', leaseOwner: 'owner-a', leaseGeneration: 1n };
    const current = { attemptToken: 'token-b', leaseOwner: 'owner-b', leaseGeneration: 2n };
    assert.equal(claimFactsMatch(stale, row), false);
    assert.equal(claimFactsMatch(current, row), true);
  });
});
