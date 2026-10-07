/**
 * P4A-P07 evidence script verification-contract tests (plan §4 fail-closed).
 *
 * Pins the verification-convergence fix in `scripts/phase4a-p07-evidence.ts`:
 *  1. `verifyToStored` must NOT append a second verification outbox event —
 *     the P03 complete route already enqueues exactly one event inside the
 *     complete transaction (the real-R2 rerun root cause: a doubled pending
 *     row made the old `rowCount !== 1` check throw `verification_not_converged`
 *     deterministically);
 *  2. the verify step must claim through the PRODUCTION outbox repository and
 *     drive the PRODUCTION verification route (real HEAD witness + bounded
 *     stream digest + CAS to stored_private) — no manual `state='leased'` SQL
 *     and no direct state writes that could fabricate success;
 *  3. a claim whose aggregate binding is not the expected blob/generation
 *     fails closed with the stable `verification_not_converged:wrong_event`
 *     code instead of guessing.
 *
 * The DB+object-store end-to-end path cannot run inside the unit suite (the
 * production route needs a real unit of work and a real object store); the
 * production route's digest-mismatch -> quarantine behavior is covered by
 * the i09 unit suites and the claim-loop/complete postgres suites, and the
 * full evidence flow runs against real R2 + PostgreSQL as the
 * `evidence:phase4a-p07` subcommand. Here the script's claim/target logic is
 * exercised against fake claims, the worker wiring is asserted against the
 * REAL production route/repository shapes, and a static source pin forbids
 * the double-append and the manual lease SQL from returning (both root
 * causes).
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'vitest';
import type { Pool } from 'pg';
import { claimMatchesTarget } from '../../../scripts/evidence/phase4a-verification-claim-loop.js';
import {
  ATTACHMENTS_VERIFICATION_EVENT_TYPE,
  ATTACHMENTS_VERIFICATION_EVENT_VERSION,
  ATTACHMENTS_VERIFICATION_HANDLER_NAME,
  ATTACHMENTS_VERIFICATION_HANDLER_MODE,
  PostgresOutboxRepository,
  type OutboxClaim,
} from '../../../src/infrastructure/outbox/index.js';
import {
  VERIFICATION_CLAIM_LEASE_MS,
  claimVerificationTargetEvent,
  p07VerificationWorker,
  stableProbeFailureCode,
} from '../../../scripts/phase4a-p07-evidence.js';

const TARGET = { blobId: 'blob-1', generationId: 'generation-1' };

/** Node's assert.rejects matches a RegExp against String(error) (which includes
 * the 'Error: ' prefix), so a validator keeps the exact stable-code contract. */
async function rejectsStableCode(promise: Promise<unknown>, message: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof Error, `expected Error with message '${message}'`);
    assert.equal(error.message, message);
    return true;
  });
}

/** A production-shaped attachments verification outbox claim. */
function verificationClaim(overrides: Partial<OutboxClaim> = {}): OutboxClaim {
  return {
    outboxId: 'outbox-1',
    eventId: 'event-1',
    eventType: ATTACHMENTS_VERIFICATION_EVENT_TYPE,
    eventVersion: 1,
    handlerName: ATTACHMENTS_VERIFICATION_HANDLER_NAME,
    handlerMode: ATTACHMENTS_VERIFICATION_HANDLER_MODE,
    aggregateType: 'attachment_blob',
    aggregateId: TARGET.blobId,
    aggregateScope: TARGET.generationId,
    aggregateRevision: null,
    commitOrdinal: null,
    occurredAt: new Date('2026-01-01T00:00:00.000Z'),
    payload: { blobId: TARGET.blobId, generationId: TARGET.generationId },
    attemptCount: 0,
    leaseGeneration: '0',
    ...overrides,
  };
}

test('claimVerificationTargetEvent fails closed with claim_missing when the outbox has no pending event', async () => {
  await rejectsStableCode(
    claimVerificationTargetEvent(async () => null, TARGET),
    'verification_not_converged:claim_missing',
  );
});

test('claimVerificationTargetEvent fails closed with wrong_event on a fully foreign claim', async () => {
  await rejectsStableCode(
    claimVerificationTargetEvent(
      async () => verificationClaim({ aggregateId: 'blob-9', aggregateScope: 'generation-9' }),
      TARGET,
    ),
    'verification_not_converged:wrong_event',
  );
});

test('claimVerificationTargetEvent fails closed with wrong_event on a partial aggregate mismatch', async () => {
  await rejectsStableCode(
    claimVerificationTargetEvent(
      async () => verificationClaim({ aggregateId: TARGET.blobId, aggregateScope: 'generation-9' }),
      TARGET,
    ),
    'verification_not_converged:wrong_event',
  );
});

test('claimVerificationTargetEvent returns the claim when it matches the target and never re-claims', async () => {
  let calls = 0;
  const target = verificationClaim();
  const claimed = await claimVerificationTargetEvent(async () => {
    calls += 1;
    return target;
  }, TARGET);
  assert.equal(claimed, target);
  assert.equal(calls, 1, 'a matching claim must be accepted on the first (and only) claim');
});

test('claimMatchesTarget pins the production aggregate-binding contract (aggregate_id = blobId, aggregate_scope = generationId)', () => {
  assert.equal(claimMatchesTarget(verificationClaim(), TARGET), true);
  assert.equal(
    claimMatchesTarget(verificationClaim({ aggregateScope: 'generation-2' }), TARGET),
    false,
    'a different generation must never match',
  );
  assert.equal(
    claimMatchesTarget(verificationClaim({ aggregateId: 'blob-2' }), TARGET),
    false,
    'a different blob must never match',
  );
});

test('p07VerificationWorker wires the PRODUCTION route and repository with the evidence claim lease', () => {
  const worker = p07VerificationWorker(
    {} as unknown as Pool,
    {} as never,
    {} as never,
    {} as never,
  );
  assert.ok(
    worker.repository instanceof PostgresOutboxRepository,
    'the evidence worker must claim/complete through the production outbox repository',
  );
  assert.equal(worker.route.handlerName, ATTACHMENTS_VERIFICATION_HANDLER_NAME);
  assert.equal(worker.route.handlerMode, ATTACHMENTS_VERIFICATION_HANDLER_MODE);
  assert.equal(worker.route.eventType, ATTACHMENTS_VERIFICATION_EVENT_TYPE);
  assert.equal(worker.route.eventVersion, ATTACHMENTS_VERIFICATION_EVENT_VERSION);
  assert.equal(worker.route.sideEffectDurability, 'durable');
  assert.equal(worker.route.routeClass, 'projection');
  assert.equal(typeof worker.route.handle, 'function');
  assert.equal(VERIFICATION_CLAIM_LEASE_MS, 30_000);
});

test('verification_not_converged keeps its stable probe failure code with diagnostic tails', () => {
  assert.equal(stableProbeFailureCode(new Error('verification_not_converged:wrong_event')), 'verification_not_converged');
  assert.equal(stableProbeFailureCode(new Error('verification_not_converged:stored_private')), 'verification_not_converged');
  assert.equal(stableProbeFailureCode(new Error('verification_not_converged:verified_facts')), 'verification_not_converged');
});

test('the evidence script never double-enqueues verification and never hand-writes outbox leases (root-cause pin)', async () => {
  const source = await readFile(new URL('../../../scripts/phase4a-p07-evidence.ts', import.meta.url), 'utf8');
  // The identifier may appear ONLY as the import and inside the P03
  // complete-route wiring (`enqueueVerification`). Any third occurrence
  // (e.g. a verify-path append) resurrects the doubled-pending-row root
  // cause and must fail this test.
  const appendCount = source.split('appendAttachmentsVerificationOutbox').length - 1;
  assert.equal(
    appendCount,
    2,
    'appendAttachmentsVerificationOutbox must appear exactly twice in the script: '
      + 'the import and the P03 complete-route wiring; the verify path must not append a second event',
  );
  const verifyStart = source.indexOf('async function verifyToStored');
  const mainStart = source.indexOf('async function main');
  assert.ok(
    verifyStart !== -1 && mainStart !== -1 && verifyStart < mainStart,
    'verifyToStored must be defined before main',
  );
  const verifyRegion = source.slice(verifyStart, mainStart);
  assert.ok(
    !verifyRegion.includes('appendAttachmentsVerificationOutbox'),
    'verifyToStored must not enqueue verification events (the complete route already did)',
  );
  assert.ok(
    !/set\s+state\s*=\s*'leased'/iu.test(verifyRegion),
    'verifyToStored must not hand-write outbox lease state (the production repository claim owns the lease)',
  );
  assert.ok(
    /repository\.claim\(/u.test(verifyRegion),
    'verifyToStored must claim through the production outbox repository',
  );
  assert.ok(
    /route\.handle\(/u.test(verifyRegion),
    'verifyToStored must drive the production verification route',
  );
  assert.ok(
    /repository\.complete\(/u.test(verifyRegion),
    'verifyToStored must durably complete the claimed outbox row',
  );
  assert.ok(
    !/set\s+state\s*=\s*'leased'/iu.test(source),
    'the whole script must never hand-write outbox lease state',
  );
});
