import {
  LEDGER_CAPACITY_TARGETS,
  type LedgerCapacityTarget,
  type LedgerFamily,
} from './ledger-capacity.js';
import { LEDGER_RETENTION_POLICIES } from './ledger-append-authority.js';

export { LEDGER_RETENTION_POLICIES };

export type LedgerTableName =
  | 'operations'
  | 'operation_payloads'
  | 'operation_lookup_facts'
  | 'audit_events'
  | 'digest_audit_events'
  | 'audit_event_payloads'
  | 'outbox_events'
  | 'sync_node_revision_history'
  | 'sync_sequence_receipts'
  | 'resource_id_ledger'
  | 'sync_sequence_operation_claims'
  | 'sync_operation_effects'
  | 'sync_operation_effect_pages'
  | 'sync_purged_node_id_watermarks'
  | 'sync_replica_retirement_receipts'
  | 'sync_recovery_ack_receipts'
  | 'sync_bootstrap_snapshot_pages'
  | 'outbox_delivery_receipts'
  | 'product_command_receipts'
  | 'sync_pull_cursor_evidence'
  | 'sync_pull_cursor_recovery_proofs'
  | 'sync_pull_cursor_lineage'
  | 'sync_pull_page_evidence'
  | 'sync_node_tombstones';

export interface LedgerFamilyByTable {
  readonly operations: 'operation';
  readonly operation_payloads: 'operation';
  readonly operation_lookup_facts: 'operation';
  readonly audit_events: 'audit';
  readonly digest_audit_events: 'audit';
  readonly audit_event_payloads: 'audit_payload';
  readonly outbox_events: 'outbox';
  readonly sync_node_revision_history: 'sync';
  readonly sync_sequence_receipts: 'sync';
  readonly resource_id_ledger: 'identity';
  readonly sync_sequence_operation_claims: 'sync';
  readonly sync_operation_effects: 'sync';
  readonly sync_operation_effect_pages: 'sync';
  readonly sync_purged_node_id_watermarks: 'sync';
  readonly sync_replica_retirement_receipts: 'sync';
  readonly sync_recovery_ack_receipts: 'sync';
  readonly sync_bootstrap_snapshot_pages: 'sync';
  readonly outbox_delivery_receipts: 'outbox';
  readonly product_command_receipts: 'idempotency';
  readonly sync_pull_cursor_evidence: 'sync';
  readonly sync_pull_cursor_recovery_proofs: 'sync';
  readonly sync_pull_cursor_lineage: 'sync';
  readonly sync_pull_page_evidence: 'sync';
  readonly sync_node_tombstones: 'sync';
}

export const ELIGIBILITY_GATES = Object.freeze([
  'terminal',
  'protocol_watermark',
  'no_fk_or_live_reference',
  'archive_verified',
  'restore_test_passed',
  'legal_hold_clear',
  'pitr_backup_aligned',
  'reader_cutover_complete',
  'explicit_deletion_approval',
] as const);

export type EligibilityGate = typeof ELIGIBILITY_GATES[number];

export type AccountableOwnerRole =
  | 'canonical_mutation_governance'
  | 'compliance_governance'
  | 'social_feed_and_messaging_governance'
  | 'sync_protocol_governance'
  | 'identity_governance'
  | 'product_api_governance';

export type RetentionPolicyStatus =
  | 'permanent'
  | 'compliance_blocked'
  | 'correctness_blocked'
  | 'implementation_blocked'
  | 'development_authorized'
  | 'deletion_ready';

export type SourceDeletionAuthorization =
  | 'not_authorized'
  | 'development_only'
  | 'production_explicit_approval';

export type LegalBasis =
  | 'correctness_authority'
  | 'protocol_integrity'
  | 'accepted_product_contract'
  | 'compliance_decision_pending';

export type DecisionReference =
  | 'append_only_ledger_capacity_runbook'
  | 'ledger_archive_control_plane_runbook'
  | 'data_and_transactions_sync_contract'
  | 'phase5_social_retention_contract'
  | 'adr_0012_product_command_retention';

export type RetentionScope =
  | 'whole_table'
  | 'social_feed_source_stream'
  | 'full_result_payload';

export type RetentionWindow =
  | { readonly kind: 'permanent'; readonly scope: 'whole_table' }
  | { readonly kind: 'identity_lifetime'; readonly scope: 'whole_table' }
  | { readonly kind: 'protocol_watermark'; readonly scope: 'whole_table' }
  | { readonly kind: 'decision_pending'; readonly scope: 'whole_table' }
  | { readonly kind: 'not_approved'; readonly scope: 'whole_table' }
  | {
    readonly kind: 'scoped_minimum_days';
    readonly scope: 'social_feed_source_stream';
    readonly minimumDays: 90;
    readonly uncoveredTableScope: 'decision_pending';
  }
  | {
    readonly kind: 'staged_minimum_days_then_identity_lifetime';
    readonly scope: 'full_result_payload';
    readonly minimumDays: 30;
    readonly retainedRemainder: 'compact_command_claim';
  };

export type PermanentFact =
  | 'canonical_operation_identity'
  | 'canonical_mutation_fact'
  | 'operation_identity_lookup'
  | 'global_resource_id_non_reuse'
  | 'purged_resource_id_watermark';

export type OnlineColdRead =
  | 'not_configured'
  | 'required_before_source_detach'
  | 'verified_available';

export interface LedgerRetentionPolicyFor<Table extends LedgerTableName> {
  readonly tableName: Table;
  readonly family: LedgerFamilyByTable[Table];
  readonly accountableOwnerRole: AccountableOwnerRole;
  readonly policyStatus: RetentionPolicyStatus;
  readonly hotRetention: RetentionWindow;
  readonly coldRetention: RetentionWindow;
  readonly permanentFacts: readonly PermanentFact[];
  readonly onlineColdRead: OnlineColdRead;
  readonly recoveryWindow: RetentionWindow;
  readonly legalBasis: LegalBasis;
  readonly decisionReference: readonly DecisionReference[];
  readonly sourceDeletionAuthorization: SourceDeletionAuthorization;
  readonly sourceDeletionAuthorized: boolean;
  readonly requiredEligibilityGates: readonly EligibilityGate[];
}

export type LedgerRetentionPolicy = {
  readonly [Table in LedgerTableName]: LedgerRetentionPolicyFor<Table>
}[LedgerTableName];

/**
 * Governance inventory only. `development_authorized` records the separately
 * gated development executor; it is never production deletion readiness.
 * Table set is generated with capacity contracts from `ledger-append-authority.ts`.
 */

export interface LedgerRetentionPolicyCandidate {
  readonly tableName?: unknown;
  readonly family?: unknown;
  readonly accountableOwnerRole?: unknown;
  readonly policyStatus?: unknown;
  readonly hotRetention?: unknown;
  readonly coldRetention?: unknown;
  readonly permanentFacts?: unknown;
  readonly onlineColdRead?: unknown;
  readonly recoveryWindow?: unknown;
  readonly legalBasis?: unknown;
  readonly decisionReference?: unknown;
  readonly sourceDeletionAuthorization?: unknown;
  readonly sourceDeletionAuthorized?: unknown;
  readonly requiredEligibilityGates?: unknown;
}

export type LedgerRetentionValidationCode =
  | 'missing_target'
  | 'duplicate_target'
  | 'unknown_target'
  | 'family_mismatch'
  | 'owner_missing_or_invalid'
  | 'legal_basis_invalid'
  | 'decision_reference_missing_or_invalid'
  | 'policy_status_invalid'
  | 'retention_window_invalid'
  | 'retention_window_conflict'
  | 'permanent_fact_invalid'
  | 'online_cold_read_invalid'
  | 'source_deletion_environment_invalid'
  | 'source_deletion_authorization_invalid'
  | 'permanent_fact_deletion_authorized'
  | 'deletion_authorization_status_mismatch'
  | 'eligibility_gate_missing'
  | 'eligibility_gate_duplicate_or_invalid';

export interface LedgerRetentionValidationIssue {
  readonly code: LedgerRetentionValidationCode;
  readonly tableName: string;
  readonly detail: string;
}

const OWNER_ROLES = new Set<AccountableOwnerRole>([
  'canonical_mutation_governance', 'compliance_governance',
  'social_feed_and_messaging_governance', 'sync_protocol_governance',
  'identity_governance', 'product_api_governance',
]);
const POLICY_STATUSES = new Set<RetentionPolicyStatus>([
  'permanent', 'compliance_blocked', 'correctness_blocked',
  'implementation_blocked', 'development_authorized', 'deletion_ready',
]);
const SOURCE_DELETION_AUTHORIZATIONS = new Set<SourceDeletionAuthorization>([
  'not_authorized', 'development_only', 'production_explicit_approval',
]);
const LEGAL_BASES = new Set<LegalBasis>([
  'correctness_authority', 'protocol_integrity', 'accepted_product_contract',
  'compliance_decision_pending',
]);
const DECISION_REFERENCES = new Set<DecisionReference>([
  'append_only_ledger_capacity_runbook', 'ledger_archive_control_plane_runbook',
  'data_and_transactions_sync_contract', 'phase5_social_retention_contract',
  'adr_0012_product_command_retention',
]);
const PERMANENT_FACTS = new Set<PermanentFact>([
  'canonical_operation_identity', 'canonical_mutation_fact',
  'operation_identity_lookup', 'global_resource_id_non_reuse', 'purged_resource_id_watermark',
]);
const ONLINE_COLD_READ_STATES = new Set<OnlineColdRead>([
  'not_configured', 'required_before_source_detach', 'verified_available',
]);
const GATE_SET = new Set<EligibilityGate>(ELIGIBILITY_GATES);

export function validateLedgerRetentionPolicies(
  policies: readonly LedgerRetentionPolicyCandidate[],
  targets: readonly LedgerCapacityTarget[] = LEDGER_CAPACITY_TARGETS,
): readonly LedgerRetentionValidationIssue[] {
  const issues: LedgerRetentionValidationIssue[] = [];
  const targetsByName = new Map(targets.map((target) => [target.tableName, target]));
  const counts = new Map<string, number>();
  for (const candidate of policies) {
    const tableName = typeof candidate.tableName === 'string' ? candidate.tableName : '<missing>';
    counts.set(tableName, (counts.get(tableName) ?? 0) + 1);
    const target = targetsByName.get(tableName);
    if (!target) {
      issue(issues, 'unknown_target', tableName, 'policy has no capacity target');
      continue;
    }
    validatePolicy(candidate, target, issues);
  }
  for (const target of targets) {
    const count = counts.get(target.tableName) ?? 0;
    if (count === 0) issue(issues, 'missing_target', target.tableName, 'capacity target has no policy');
    if (count > 1) issue(issues, 'duplicate_target', target.tableName, `capacity target has ${count} policies`);
  }
  return Object.freeze(issues.sort((left, right) =>
    left.tableName.localeCompare(right.tableName, 'en')
      || left.code.localeCompare(right.code, 'en')
      || left.detail.localeCompare(right.detail, 'en')));
}

function validatePolicy(
  policy: LedgerRetentionPolicyCandidate,
  target: LedgerCapacityTarget,
  issues: LedgerRetentionValidationIssue[],
): void {
  if (policy.family !== target.family) {
    issue(issues, 'family_mismatch', target.tableName,
      `expected ${target.family}, received ${String(policy.family)}`);
  }
  if (!OWNER_ROLES.has(policy.accountableOwnerRole as AccountableOwnerRole)) {
    issue(issues, 'owner_missing_or_invalid', target.tableName, 'accountable owner role is invalid');
  }
  if (!POLICY_STATUSES.has(policy.policyStatus as RetentionPolicyStatus)) {
    issue(issues, 'policy_status_invalid', target.tableName, 'policy status is invalid');
  }
  if (!LEGAL_BASES.has(policy.legalBasis as LegalBasis)) {
    issue(issues, 'legal_basis_invalid', target.tableName, 'legal basis is invalid');
  }
  validateDecisionReferences(policy, target.tableName, issues);
  const hot = policy.hotRetention;
  const cold = policy.coldRetention;
  const recovery = policy.recoveryWindow;
  if (!isRetentionWindow(hot) || !isRetentionWindow(cold) || !isRetentionWindow(recovery)) {
    issue(issues, 'retention_window_invalid', target.tableName, 'one or more windows are invalid');
  } else {
    validateWindowOrder(hot, cold, recovery, target.tableName, issues);
  }
  const permanentFacts = Array.isArray(policy.permanentFacts) ? policy.permanentFacts : [];
  if (!Array.isArray(policy.permanentFacts)
      || new Set(permanentFacts).size !== permanentFacts.length
      || permanentFacts.some((fact) => !PERMANENT_FACTS.has(fact as PermanentFact))) {
    issue(issues, 'permanent_fact_invalid', target.tableName,
      'permanent facts must be an explicit unique recognized list');
  }
  if (!ONLINE_COLD_READ_STATES.has(policy.onlineColdRead as OnlineColdRead)) {
    issue(issues, 'online_cold_read_invalid', target.tableName,
      'online cold-read state is invalid');
  }
  if (typeof policy.sourceDeletionAuthorized !== 'boolean') {
    issue(issues, 'source_deletion_authorization_invalid', target.tableName,
      'source deletion authorization must be boolean');
  }
  if (!SOURCE_DELETION_AUTHORIZATIONS.has(
    policy.sourceDeletionAuthorization as SourceDeletionAuthorization,
  )) {
    issue(issues, 'source_deletion_authorization_invalid', target.tableName,
      'source deletion authorization scope is invalid');
  }
  if (permanentFacts.length > 0 && policy.sourceDeletionAuthorized === true) {
    issue(issues, 'permanent_fact_deletion_authorized', target.tableName,
      'a table containing permanent facts cannot authorize source deletion');
  }
  const deletionReady = policy.policyStatus === 'deletion_ready';
  const developmentAuthorized = policy.policyStatus === 'development_authorized';
  const authorizationScope = policy.sourceDeletionAuthorization;
  if (policy.sourceDeletionAuthorized !== deletionReady
      || (deletionReady && authorizationScope !== 'production_explicit_approval')
      || (developmentAuthorized && authorizationScope !== 'development_only')
      || (!deletionReady && !developmentAuthorized && authorizationScope !== 'not_authorized')) {
    issue(issues, 'deletion_authorization_status_mismatch', target.tableName,
      'source deletion authorization scope and policy status disagree');
  }
  if (developmentAuthorized
      && !['operation_payloads', 'audit_event_payloads', 'outbox_events'].includes(target.tableName)) {
    issue(issues, 'source_deletion_environment_invalid', target.tableName,
      'development-only deletion is not allowed for this ledger target');
  }
  validateGates(policy.requiredEligibilityGates, target, issues);
}

function validateDecisionReferences(
  policy: LedgerRetentionPolicyCandidate,
  tableName: string,
  issues: LedgerRetentionValidationIssue[],
): void {
  const references = policy.decisionReference;
  if (!Array.isArray(references) || references.length === 0
      || references.some((reference) => !DECISION_REFERENCES.has(reference as DecisionReference))) {
    issue(issues, 'decision_reference_missing_or_invalid', tableName,
      'at least one recognized decision reference is required');
  }
}

const COMMON_GATES = Object.freeze([
  'no_fk_or_live_reference', 'archive_verified', 'restore_test_passed',
  'legal_hold_clear', 'pitr_backup_aligned', 'reader_cutover_complete',
  'explicit_deletion_approval',
] as const satisfies readonly EligibilityGate[]);
const TERMINAL_GATES = Object.freeze([
  'terminal', ...COMMON_GATES,
] as const satisfies readonly EligibilityGate[]);
const PROTOCOL_GATES = Object.freeze([
  'terminal', 'protocol_watermark', ...COMMON_GATES,
] as const satisfies readonly EligibilityGate[]);

function validateGates(
  value: unknown,
  target: LedgerCapacityTarget,
  issues: LedgerRetentionValidationIssue[],
): void {
  const gates = Array.isArray(value) ? value : [];
  const unique = new Set(gates);
  if (unique.size !== gates.length
      || gates.some((gate) => !GATE_SET.has(gate as EligibilityGate))) {
    issue(issues, 'eligibility_gate_duplicate_or_invalid', target.tableName,
      'eligibility gates contain a duplicate or unknown value');
  }
  for (const required of requiredGatesForFamily(target.family)) {
    if (!unique.has(required)) {
      issue(issues, 'eligibility_gate_missing', target.tableName,
        `required gate is absent: ${required}`);
    }
  }
}

function requiredGatesForFamily(family: LedgerFamily): readonly EligibilityGate[] {
  if (family === 'sync' || family === 'outbox') return PROTOCOL_GATES;
  if (family === 'operation' || family === 'audit' || family === 'idempotency') {
    return TERMINAL_GATES;
  }
  return COMMON_GATES;
}

function isRetentionWindow(value: unknown): value is RetentionWindow {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { readonly kind?: unknown; readonly scope?: unknown;
    readonly minimumDays?: unknown; readonly uncoveredTableScope?: unknown;
    readonly retainedRemainder?: unknown };
  if (candidate.kind === 'permanent' || candidate.kind === 'identity_lifetime'
      || candidate.kind === 'protocol_watermark' || candidate.kind === 'decision_pending'
      || candidate.kind === 'not_approved') return candidate.scope === 'whole_table';
  if (candidate.kind === 'scoped_minimum_days') {
    return candidate.scope === 'social_feed_source_stream' && candidate.minimumDays === 90
      && candidate.uncoveredTableScope === 'decision_pending';
  }
  return candidate.kind === 'staged_minimum_days_then_identity_lifetime'
    && candidate.scope === 'full_result_payload' && candidate.minimumDays === 30
    && candidate.retainedRemainder === 'compact_command_claim';
}

function validateWindowOrder(
  hot: RetentionWindow,
  cold: RetentionWindow,
  recovery: RetentionWindow,
  tableName: string,
  issues: LedgerRetentionValidationIssue[],
): void {
  const hotDays = minimumDays(hot);
  const coldDays = minimumDays(cold);
  const recoveryDays = minimumDays(recovery);
  if (hotDays !== null && coldDays !== null && coldDays < hotDays) {
    issue(issues, 'retention_window_conflict', tableName,
      'cold retention cannot be shorter than hot retention');
  }
  if (hotDays !== null && recoveryDays !== null && recoveryDays > hotDays
      && (coldDays === null || recoveryDays > coldDays)) {
    issue(issues, 'retention_window_conflict', tableName,
      'recovery window exceeds available hot and cold retention');
  }
}

function minimumDays(window: RetentionWindow): number | null {
  return 'minimumDays' in window ? window.minimumDays : null;
}

function issue(
  issues: LedgerRetentionValidationIssue[],
  code: LedgerRetentionValidationCode,
  tableName: string,
  detail: string,
): void {
  issues.push(Object.freeze({ code, tableName, detail }));
}

export interface LedgerRetentionEvidence {
  readonly evidence: 'known.ledger_retention_policy.v1';
  readonly valid: boolean;
  readonly targetCount: number;
  readonly policyCount: number;
  readonly deletionAuthorization: {
    readonly posture: 'invalid_contract' | 'fail_closed' | 'authorized';
    readonly readyPolicyCount: number;
    readonly blockedPolicyCount: number;
  };
  readonly validationIssues: readonly LedgerRetentionValidationIssue[];
  readonly policies: readonly LedgerRetentionPolicy[];
}

export function createLedgerRetentionEvidence(
  policies: readonly LedgerRetentionPolicy[] = LEDGER_RETENTION_POLICIES,
  targets: readonly LedgerCapacityTarget[] = LEDGER_CAPACITY_TARGETS,
): LedgerRetentionEvidence {
  const validationIssues = validateLedgerRetentionPolicies(policies, targets);
  const readyPolicyCount = policies.filter((policy) =>
    policy.policyStatus === 'deletion_ready' && policy.sourceDeletionAuthorized).length;
  const valid = validationIssues.length === 0;
  return Object.freeze({
    evidence: 'known.ledger_retention_policy.v1',
    valid,
    targetCount: targets.length,
    policyCount: policies.length,
    deletionAuthorization: Object.freeze({
      posture: !valid ? 'invalid_contract' : readyPolicyCount === 0 ? 'fail_closed' : 'authorized',
      readyPolicyCount,
      blockedPolicyCount: policies.length - readyPolicyCount,
    }),
    validationIssues,
    policies,
  });
}

export function serializeLedgerRetentionEvidence(evidence: LedgerRetentionEvidence): string {
  return `${JSON.stringify(evidence, null, 2)}\n`;
}

export interface LedgerRetentionPolicyCommandResult {
  readonly stdout: string;
  readonly exitCode: 0 | 1 | 2;
}

export function evaluateLedgerRetentionPolicyCommand(
  arguments_: readonly string[],
  evidence: LedgerRetentionEvidence = createLedgerRetentionEvidence(),
): LedgerRetentionPolicyCommandResult {
  let requireDeletionReady = false;
  for (const argument of arguments_) {
    if (argument !== '--require-deletion-ready') {
      throw new Error(`unknown ledger-retention-policy argument: ${argument}`);
    }
    if (requireDeletionReady) {
      throw new Error('--require-deletion-ready may be supplied only once');
    }
    requireDeletionReady = true;
  }
  const exitCode = !evidence.valid ? 1
    : requireDeletionReady && evidence.deletionAuthorization.readyPolicyCount === 0 ? 2 : 0;
  return Object.freeze({ stdout: serializeLedgerRetentionEvidence(evidence), exitCode });
}
