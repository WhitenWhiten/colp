import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { LEDGER_CAPACITY_TARGETS } from '../../../src/infrastructure/database/ledger-capacity.js';
import {
  createLedgerRetentionEvidence,
  evaluateLedgerRetentionPolicyCommand,
  LEDGER_RETENTION_POLICIES,
  serializeLedgerRetentionEvidence,
  validateLedgerRetentionPolicies,
  type LedgerRetentionPolicyCandidate,
  type LedgerRetentionValidationCode,
} from '../../../src/infrastructure/database/ledger-retention-policy.js';

describe('ledger retention policy governance contract', () => {
  test('is bidirectionally complete with exactly one matching policy per capacity target', () => {
    const targetKeys = LEDGER_CAPACITY_TARGETS
      .map((target) => `${target.tableName}:${target.family}`).sort();
    const policyKeys = LEDGER_RETENTION_POLICIES
      .map((policy) => `${policy.tableName}:${policy.family}`).sort();

    assert.deepEqual(policyKeys, targetKeys);
    assert.equal(new Set(LEDGER_RETENTION_POLICIES.map((policy) => policy.tableName)).size,
      LEDGER_RETENTION_POLICIES.length);
    assert.deepEqual(validateLedgerRetentionPolicies(LEDGER_RETENTION_POLICIES), []);
  });

  test('freezes current decisions without authorizing whole-table source deletion', () => {
    assert.ok(LEDGER_RETENTION_POLICIES.every((policy) => !policy.sourceDeletionAuthorized));
    assert.equal(policy('resource_id_ledger').policyStatus, 'permanent');
    assert.equal(policy('audit_events').policyStatus, 'compliance_blocked');
    assert.equal(policy('audit_events').hotRetention.kind, 'permanent');
    assert.equal(policy('audit_event_payloads').policyStatus, 'development_authorized');
    assert.equal(policy('audit_event_payloads').onlineColdRead, 'verified_available');
    assert.equal(policy('audit_event_payloads').sourceDeletionAuthorization, 'development_only');
    assert.equal(policy('audit_event_payloads').sourceDeletionAuthorized, false);
    assert.equal(policy('operations').policyStatus, 'correctness_blocked');
    assert.equal(policy('operation_payloads').policyStatus, 'development_authorized');
    assert.equal(policy('operation_payloads').sourceDeletionAuthorization, 'development_only');
    assert.equal(policy('operation_lookup_facts').policyStatus, 'permanent');
    assert.equal(policy('operation_lookup_facts').hotRetention.kind, 'identity_lifetime');
    assert.deepEqual(policy('operation_lookup_facts').permanentFacts,
      ['operation_identity_lookup']);
    assert.ok(LEDGER_RETENTION_POLICIES
      .filter((item) => item.family === 'sync')
      .every((item) => item.policyStatus === 'correctness_blocked'));

    const outbox = policy('outbox_events');
    assert.equal(outbox.policyStatus, 'development_authorized');
    assert.equal(outbox.sourceDeletionAuthorization, 'development_only');
    assert.deepEqual(outbox.hotRetention, {
      kind: 'scoped_minimum_days', scope: 'social_feed_source_stream', minimumDays: 90,
      uncoveredTableScope: 'decision_pending',
    });
    assert.equal(outbox.onlineColdRead, 'not_configured');
  });

  test('rejects missing, duplicate, unknown and family-mismatched targets', () => {
    assert.ok(codes(validateLedgerRetentionPolicies(LEDGER_RETENTION_POLICIES.slice(1)))
      .has('missing_target'));
    assert.ok(codes(validateLedgerRetentionPolicies([
      ...LEDGER_RETENTION_POLICIES, LEDGER_RETENTION_POLICIES[0]!,
    ])).has('duplicate_target'));
    assert.ok(codes(validateLedgerRetentionPolicies([
      ...LEDGER_RETENTION_POLICIES,
      { ...LEDGER_RETENTION_POLICIES[0], tableName: 'invented_ledger' },
    ])).has('unknown_target'));
    assert.ok(codes(validateLedgerRetentionPolicies(replace('operations', {
      ...policy('operations'), family: 'audit',
    }))).has('family_mismatch'));
  });

  test('rejects unsafe deletion, missing governance, window conflicts and incomplete gates', () => {
    const unsafe = validateLedgerRetentionPolicies(replace('resource_id_ledger', {
      ...policy('resource_id_ledger'), policyStatus: 'deletion_ready',
      sourceDeletionAuthorized: true,
    }));
    assert.ok(codes(unsafe).has('permanent_fact_deletion_authorized'));

    const missingGovernance = validateLedgerRetentionPolicies(replace('audit_events', {
      ...policy('audit_events'), accountableOwnerRole: '', legalBasis: '', decisionReference: [],
    }));
    assert.ok(codes(missingGovernance).has('owner_missing_or_invalid'));
    assert.ok(codes(missingGovernance).has('legal_basis_invalid'));
    assert.ok(codes(missingGovernance).has('decision_reference_missing_or_invalid'));

    const conflicting = validateLedgerRetentionPolicies(replace('outbox_events', {
      ...policy('outbox_events'),
      coldRetention: {
        kind: 'staged_minimum_days_then_identity_lifetime', scope: 'full_result_payload',
        minimumDays: 30, retainedRemainder: 'compact_command_claim',
      },
    }));
    assert.ok(codes(conflicting).has('retention_window_conflict'));

    const incomplete = validateLedgerRetentionPolicies(replace('sync_operation_effects', {
      ...policy('sync_operation_effects'), requiredEligibilityGates: ['terminal'],
    }));
    assert.ok(codes(incomplete).has('eligibility_gate_missing'));

    const ambiguous = validateLedgerRetentionPolicies(replace('operations', {
      ...policy('operations'), permanentFacts: ['unknown'], onlineColdRead: 'sometimes',
      sourceDeletionAuthorized: 'pending',
    }));
    assert.ok(codes(ambiguous).has('permanent_fact_invalid'));
    assert.ok(codes(ambiguous).has('online_cold_read_invalid'));
    assert.ok(codes(ambiguous).has('source_deletion_authorization_invalid'));

    const promotedDevelopment = validateLedgerRetentionPolicies(replace('operation_payloads', {
      ...policy('operation_payloads'), policyStatus: 'deletion_ready',
      sourceDeletionAuthorized: true,
    }));
    assert.ok(codes(promotedDevelopment).has('deletion_authorization_status_mismatch'));
  });

  test('serializes deterministic fail-closed JSON evidence', () => {
    const first = serializeLedgerRetentionEvidence(createLedgerRetentionEvidence());
    const second = serializeLedgerRetentionEvidence(createLedgerRetentionEvidence());
    assert.equal(first, second);
    const parsed = JSON.parse(first) as {
      valid: boolean;
      deletionAuthorization: { posture: string; readyPolicyCount: number };
      policies: unknown[];
    };
    assert.equal(parsed.valid, true);
    assert.deepEqual(parsed.deletionAuthorization,
      { posture: 'fail_closed', readyPolicyCount: 0, blockedPolicyCount: 24 });
    assert.equal(parsed.policies.length, LEDGER_CAPACITY_TARGETS.length);
  });

  test('CLI treats a valid deletion block as success and readiness demand as unmet', () => {
    const first = evaluateLedgerRetentionPolicyCommand([]);
    const second = evaluateLedgerRetentionPolicyCommand([]);
    assert.equal(first.exitCode, 0);
    assert.equal(first.stdout, second.stdout);
    assert.equal(JSON.parse(first.stdout).deletionAuthorization.posture, 'fail_closed');

    const required = evaluateLedgerRetentionPolicyCommand(['--require-deletion-ready']);
    assert.equal(required.exitCode, 2);
    assert.equal(JSON.parse(required.stdout).valid, true);

    const validEvidence = createLedgerRetentionEvidence();
    const invalid = evaluateLedgerRetentionPolicyCommand([], {
      ...validEvidence, valid: false,
      deletionAuthorization: {
        ...validEvidence.deletionAuthorization, posture: 'invalid_contract',
      },
    });
    assert.equal(invalid.exitCode, 1);

    assert.throws(() => evaluateLedgerRetentionPolicyCommand(['--delete']),
      /unknown ledger-retention-policy argument/u);
    assert.throws(() => evaluateLedgerRetentionPolicyCommand([
      '--require-deletion-ready', '--require-deletion-ready',
    ]), /may be supplied only once/u);
  });
});

function policy(tableName: string) {
  const found = LEDGER_RETENTION_POLICIES.find((item) => item.tableName === tableName);
  assert.ok(found, `missing fixture policy for ${tableName}`);
  return found;
}

function replace(
  tableName: string,
  replacement: LedgerRetentionPolicyCandidate,
): readonly LedgerRetentionPolicyCandidate[] {
  return LEDGER_RETENTION_POLICIES.map((item) =>
    item.tableName === tableName ? replacement : item);
}

function codes(issues: readonly { readonly code: LedgerRetentionValidationCode }[]) {
  return new Set(issues.map((issue) => issue.code));
}
