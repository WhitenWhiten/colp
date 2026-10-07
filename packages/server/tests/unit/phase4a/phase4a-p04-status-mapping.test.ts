/**
 * P4A-P04 pure mapping matrix for the owner-private status DTO.
 *
 * Pins `composeAttachmentStatusView` for every reachable blob logical state /
 * current-generation state pair (issued/uploaded/verifying/stored_private/
 * attached_private/expired + allocated/active/quarantined/orphaned) and the
 * defensive unreachable combos. The unit layer pins the vocabulary; the
 * focused PostgreSQL suites prove the same mapping end to end through the
 * production HTTP route against REAL ledger rows.
 *
 * Anti-false-positive: an empty DTO, a mock authorization, or a nonexistent
 * ID cannot produce these assertions — the matrix asserts exact
 * logicalState/verificationStatus/availability/size/mediaType/allowedActions
 * for real state facts.
 *
 * Anti-false-negative: the mapping never reads the internal denial reason
 * (404/403 are route concerns) and never compares cross-process milliseconds
 * — the view only carries ISO-8601 UTC strings and derived facts.
 */
import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  ATTACHMENT_RATE_LIMIT_FIXED_SCOPE,
  ATTACHMENT_RATE_LIMIT_ROUTE_CLASSES,
  ATTACHMENTS_STATUS_RATE_MAX_DEFAULT,
  ATTACHMENTS_STATUS_RATE_WINDOW_MS_DEFAULT,
  buildAttachmentRateLimitKey,
  formatRateLimitPolicyHeader,
  parseAttachmentRateLimitConfig,
  rateLimitSubjectHmac,
  resolveRouteRatePolicy,
} from '../../../src/modules/attachments/index.js';
import {
  composeAttachmentStatusView,
  type AttachmentStatusView,
} from '../../../src/modules/attachments/read-attachment-status.js';
import type { StatusBlobFacts } from '../../../src/modules/attachments/attachments-repository-port.js';

const DTO_KEYS = Object.freeze([
  'blobId', 'logicalState', 'verificationStatus', 'availability',
  'size', 'mediaType', 'createdAt', 'updatedAt', 'allowedActions',
] as const);

const CREATED_AT = new Date('2026-08-08T12:00:00.000Z');
const UPDATED_AT = new Date('2026-08-08T12:05:00.000Z');

function facts(overrides: Partial<StatusBlobFacts> = {}): StatusBlobFacts {
  return {
    blobId: 'blob-1',
    ownerSubjectId: 'subject-1',
    logicalState: 'issued',
    currentGenerationId: 'generation-1',
    currentGenerationState: 'allocated',
    collectionId: 'collection-1',
    verifiedSize: null,
    mediaType: null,
    expectedSize: 2048,
    mediaHint: 'image/png',
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
    attachmentLogicalState: null,
    ...overrides,
  };
}

function assertViewShape(view: AttachmentStatusView): void {
  assert.deepEqual(Object.keys(view), [...DTO_KEYS],
    'the status view must expose exactly the frozen DTO fields');
  // Time facts: ISO-8601 UTC with millisecond precision, parseable, ordered.
  assert.match(view.createdAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u);
  assert.match(view.updatedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u);
  assert.ok(Number.isFinite(Date.parse(view.createdAt)));
  assert.ok(Number.isFinite(Date.parse(view.updatedAt)));
  assert.ok(view.createdAt <= view.updatedAt, 'createdAt must never follow updatedAt');
  // No digest, key, URL, credential, generation, or lease vocabulary.
  const serialized = JSON.stringify(view);
  for (const forbidden of ['sha256', 'digest', 'key', 'url', 'etag', 'lease', 'generationId',
    'intentId', 'credential', 'filename', 'bucket', 'http']) {
    assert.equal(serialized.includes(forbidden), false, `the DTO must not leak ${forbidden}`);
  }
}

test('issued/allocated: pending, unavailable, declared facts, complete only', () => {
  const view = composeAttachmentStatusView(facts(), 'blob-1');
  assertViewShape(view);
  assert.equal(view.logicalState, 'issued');
  assert.equal(view.verificationStatus, 'pending');
  assert.equal(view.availability, 'unavailable');
  assert.equal(view.size, 2048);
  assert.equal(view.mediaType, 'image/png');
  assert.deepEqual(view.allowedActions, ['complete']);
});

test('uploaded/active: pending until the verification pipeline runs', () => {
  const view = composeAttachmentStatusView(facts({
    logicalState: 'uploaded',
    currentGenerationState: 'active',
  }), 'blob-1');
  assertViewShape(view);
  assert.equal(view.logicalState, 'uploaded');
  assert.equal(view.verificationStatus, 'pending');
  assert.equal(view.availability, 'unavailable');
  assert.deepEqual(view.allowedActions, ['complete']);
});

test('verifying: verification progress is observable while the lease is held', () => {
  const view = composeAttachmentStatusView(facts({
    logicalState: 'verifying',
    currentGenerationState: 'active',
  }), 'blob-1');
  assertViewShape(view);
  assert.equal(view.logicalState, 'verifying');
  assert.equal(view.verificationStatus, 'verifying');
  assert.equal(view.availability, 'unavailable');
  assert.deepEqual(view.allowedActions, ['complete']);
});

test('stored_private/active: verified size/media, available, finalize/download/replace', () => {
  const view = composeAttachmentStatusView(facts({
    logicalState: 'stored_private',
    currentGenerationState: 'active',
    verifiedSize: 4096,
    mediaType: 'application/pdf',
    expectedSize: 2048,
    mediaHint: 'image/png',
  }), 'blob-1');
  assertViewShape(view);
  assert.equal(view.logicalState, 'stored_private');
  assert.equal(view.verificationStatus, 'verified');
  assert.equal(view.availability, 'available');
  assert.equal(view.size, 4096, 'the verified size wins over the declared size');
  assert.equal(view.mediaType, 'application/pdf', 'the verified media wins over the hint');
  assert.deepEqual(view.allowedActions, ['finalize', 'download', 'replace']);
});

test('attached_private/active: verified and downloadable, retire is the only lifecycle command', () => {
  const view = composeAttachmentStatusView(facts({
    logicalState: 'attached_private',
    currentGenerationState: 'active',
    verifiedSize: 4096,
    mediaType: 'application/pdf',
  }), 'blob-1');
  assertViewShape(view);
  assert.equal(view.logicalState, 'attached_private');
  assert.equal(view.verificationStatus, 'verified');
  assert.equal(view.availability, 'available');
  assert.deepEqual(view.allowedActions, ['download', 'retire']);
});

test('quarantined generation: failed verification, nothing available, no actions', () => {
  const view = composeAttachmentStatusView(facts({
    logicalState: 'expired',
    currentGenerationState: 'quarantined',
  }), 'blob-1');
  assertViewShape(view);
  assert.equal(view.logicalState, 'quarantined');
  assert.equal(view.verificationStatus, 'failed');
  assert.equal(view.availability, 'unavailable');
  assert.deepEqual(view.allowedActions, []);
});

test('expired/orphaned: never verified, unavailable, no actions', () => {
  const view = composeAttachmentStatusView(facts({
    logicalState: 'expired',
    currentGenerationState: 'orphaned',
  }), 'blob-1');
  assertViewShape(view);
  assert.equal(view.logicalState, 'expired');
  assert.equal(view.verificationStatus, 'pending');
  assert.equal(view.availability, 'unavailable');
  assert.deepEqual(view.allowedActions, []);
});

// ---------------------------------------------------------------------------
// FIX-L-051 status budget contract: the owner-private read is admission-gated
// on a STABLE per-principal budget BEFORE any repository work (KA-P4-AM-16)
// ---------------------------------------------------------------------------

const STATUS_BUDGET_SECRET = Buffer.from('p04-status-budget-unit-secret', 'utf8');

function statusBudgetSubject(principalId: string) {
  return { principalId, scope: ATTACHMENT_RATE_LIMIT_FIXED_SCOPE };
}

test('the status read is a sealed admission route class with its own fixed budget', () => {
  assert.ok(ATTACHMENT_RATE_LIMIT_ROUTE_CLASSES.includes('status'),
    'the status read must be a sealed route class of the shared admission limiter');
  assert.equal(ATTACHMENTS_STATUS_RATE_MAX_DEFAULT, 60);
  assert.equal(ATTACHMENTS_STATUS_RATE_WINDOW_MS_DEFAULT, 60000);
  const policy = resolveRouteRatePolicy(parseAttachmentRateLimitConfig({}), 'status');
  assert.deepEqual(policy, { routeClass: 'status', rateMax: 60, rateWindowMs: 60000 },
    'the status budget must resolve from the shared per-route policy');
  assert.equal(formatRateLimitPolicyHeader('status', policy.rateMax, policy.rateWindowMs),
    'attachments-status:60:60000',
    'the 429 RateLimit-Policy header must match the frozen attachments-<route> pattern');
});

test('the status budget is per-PRINCIPAL with the fixed scope — a rotatable blobId can never mint a fresh bucket', () => {
  const window = 1_750_000_000_000;
  const owner = statusBudgetSubject('p04-principal-1');
  const key = buildAttachmentRateLimitKey({
    environment: 'test',
    keySecret: STATUS_BUDGET_SECRET,
    routeClass: 'status',
    subject: owner,
    windowStartEpochMs: window,
  });
  assert.match(key, /:status:\d+$/u, 'the status admission key must carry the sealed status route class');
  assert.equal(key.includes('blob'), false, 'the key must never carry blob identity');
  // The blobId is NOT an input of the key builder: polling MANY blobIds
  // shares ONE per-principal budget (KA-P4-AM-16: never per-rotatable-blobId).
  const samePrincipalAgain = buildAttachmentRateLimitKey({
    environment: 'test',
    keySecret: STATUS_BUDGET_SECRET,
    routeClass: 'status',
    subject: owner,
    windowStartEpochMs: window,
  });
  assert.equal(samePrincipalAgain, key, 'the same principal always maps to the same stable bucket');
  const other = buildAttachmentRateLimitKey({
    environment: 'test',
    keySecret: STATUS_BUDGET_SECRET,
    routeClass: 'status',
    subject: statusBudgetSubject('p04-principal-2'),
    windowStartEpochMs: window,
  });
  assert.notEqual(other, key, 'different principals must be isolated');
  assert.notEqual(
    rateLimitSubjectHmac(STATUS_BUDGET_SECRET, statusBudgetSubject('p04-principal-1')),
    rateLimitSubjectHmac(STATUS_BUDGET_SECRET, statusBudgetSubject('p04-principal-2')),
    'the HMAC subject segments must differ across principals',
  );
  // The anonymous path has NO principal and therefore can never enter the
  // budget: the codec fails closed on an empty principal (the route keeps the
  // cheap concealed 404 with zero database work and zero budget consumption).
  assert.throws(
    () => rateLimitSubjectHmac(STATUS_BUDGET_SECRET, statusBudgetSubject('')),
    /principalId/,
    'an anonymous request must never construct an admission subject',
  );
});

test('defensive combos stay deterministic and never invent facts', () => {
  // stored_private with a non-active current generation (unreachable in a
  // consistent ledger): verified facts are shown but no capability is claimed.
  const observed = composeAttachmentStatusView(facts({
    logicalState: 'stored_private',
    currentGenerationState: 'observed',
    verifiedSize: 100,
  }), 'blob-1');
  assert.equal(observed.logicalState, 'stored_private');
  assert.equal(observed.verificationStatus, 'verified');
  assert.equal(observed.availability, 'unavailable');
  assert.deepEqual(observed.allowedActions, []);

  // uploaded with a quarantined generation: quarantine dominates the state.
  const quarantined = composeAttachmentStatusView(facts({
    logicalState: 'uploaded',
    currentGenerationState: 'quarantined',
  }), 'blob-1');
  assert.equal(quarantined.logicalState, 'quarantined');
  assert.equal(quarantined.verificationStatus, 'failed');
  assert.deepEqual(quarantined.allowedActions, []);

  // Missing size facts (defensive nulls) collapse to a zero size and null
  // media type instead of throwing or inventing a digest.
  const nulls = composeAttachmentStatusView(facts({
    logicalState: 'issued',
    currentGenerationState: 'allocated',
    expectedSize: null,
    mediaHint: null,
  }), 'blob-1');
  assert.equal(nulls.size, 0);
  assert.equal(nulls.mediaType, null);
  assertViewShape(nulls);
});
