import type {
  LedgerCapacityTarget,
  LedgerFamily,
  LedgerRetentionClass,
} from './ledger-capacity.js';
import type {
  AccountableOwnerRole,
  DecisionReference,
  EligibilityGate,
  LedgerRetentionPolicy,
  LedgerTableName,
  LegalBasis,
  OnlineColdRead,
  PermanentFact,
  RetentionPolicyStatus,
  RetentionWindow,
  SourceDeletionAuthorization,
} from './ledger-retention-policy.js';

const TEN_MILLION = 10_000_000n;
const ONE_MILLION = 1_000_000n;
const TEN_GIB = 10n * 1024n * 1024n * 1024n;
const TWO_GIB = 2n * 1024n * 1024n * 1024n;
const DEAD_RATIO = 0.2;

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

const PERMANENT = Object.freeze({ kind: 'permanent', scope: 'whole_table' } as const);
const IDENTITY_LIFETIME = Object.freeze(
  { kind: 'identity_lifetime', scope: 'whole_table' } as const,
);
const PROTOCOL_WATERMARK = Object.freeze(
  { kind: 'protocol_watermark', scope: 'whole_table' } as const,
);
const DECISION_PENDING = Object.freeze(
  { kind: 'decision_pending', scope: 'whole_table' } as const,
);
const COLD_NOT_APPROVED = Object.freeze(
  { kind: 'not_approved', scope: 'whole_table' } as const,
);
const SOCIAL_FEED_90_DAYS = Object.freeze({
  kind: 'scoped_minimum_days',
  scope: 'social_feed_source_stream',
  minimumDays: 90,
  uncoveredTableScope: 'decision_pending',
} as const);
const PRODUCT_RESULT_THEN_CLAIM = Object.freeze({
  kind: 'staged_minimum_days_then_identity_lifetime',
  scope: 'full_result_payload',
  minimumDays: 30,
  retainedRemainder: 'compact_command_claim',
} as const);

const CAPACITY_AND_ARCHIVE_REFERENCES = Object.freeze([
  'append_only_ledger_capacity_runbook',
  'ledger_archive_control_plane_runbook',
] as const satisfies readonly DecisionReference[]);
const SYNC_REFERENCES = Object.freeze([
  ...CAPACITY_AND_ARCHIVE_REFERENCES,
  'data_and_transactions_sync_contract',
] as const satisfies readonly DecisionReference[]);

interface LedgerAppendAuthority {
  readonly tableName: LedgerTableName;
  readonly family: LedgerFamily;
  readonly retentionClass: LedgerRetentionClass;
  readonly archiveBlocker: string;
  readonly owner: AccountableOwnerRole;
  readonly growthDriver: string;
  readonly cleanupMechanism: string;
  readonly requiredIndex: string;
  readonly warnRows: bigint;
  readonly warnBytes: bigint;
  readonly warnDeadRatio: number;
  readonly recoveryDependency: string;
  readonly replacesTableName: string | null;
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

function row(
  tableName: LedgerTableName,
  family: LedgerFamily,
  retentionClass: LedgerRetentionClass,
  archiveBlocker: string,
  growthDriver: string,
  cleanupMechanism: string,
  requiredIndex: string,
  recoveryDependency: string,
  policy: Omit<LedgerAppendAuthority,
    'tableName' | 'family' | 'retentionClass' | 'archiveBlocker' | 'owner' | 'growthDriver'
    | 'cleanupMechanism' | 'requiredIndex' | 'warnRows' | 'warnBytes' | 'warnDeadRatio'
    | 'recoveryDependency' | 'replacesTableName'>,
  capacity?: {
    readonly warnRows?: bigint;
    readonly warnBytes?: bigint;
    readonly warnDeadRatio?: number;
    readonly replacesTableName?: string | null;
  },
): LedgerAppendAuthority {
  return Object.freeze({
    tableName, family, retentionClass, archiveBlocker,
    owner: policy.accountableOwnerRole, growthDriver, cleanupMechanism, requiredIndex,
    warnRows: capacity?.warnRows ?? TEN_MILLION,
    warnBytes: capacity?.warnBytes ?? TEN_GIB,
    warnDeadRatio: capacity?.warnDeadRatio ?? DEAD_RATIO,
    recoveryDependency,
    replacesTableName: capacity?.replacesTableName ?? null,
    ...policy,
  });
}

/**
 * Single source for capacity inventory and retention matrix views.
 * Adding an append-heavy table requires a row here, a table comment, and docs.
 */
const LEDGER_APPEND_AUTHORITY: readonly LedgerAppendAuthority[] = Object.freeze([
  row('operations', 'operation', 'authoritative_permanent',
    'canonical mutation authority and audit/outbox foreign-key graph',
    'canonical mutation commits', 'none; permanent authority',
    'operations_operation_collection_ordinal_unique',
    'audit and outbox foreign-key graph', {
      accountableOwnerRole: 'canonical_mutation_governance',
      policyStatus: 'correctness_blocked', hotRetention: PERMANENT,
      coldRetention: COLD_NOT_APPROVED,
      permanentFacts: ['canonical_operation_identity', 'canonical_mutation_fact'],
      onlineColdRead: 'not_configured', recoveryWindow: PERMANENT,
      legalBasis: 'correctness_authority',
      decisionReference: CAPACITY_AND_ARCHIVE_REFERENCES,
      sourceDeletionAuthorization: 'not_authorized',
      sourceDeletionAuthorized: false, requiredEligibilityGates: TERMINAL_GATES,
    }),
  row('operation_payloads', 'operation', 'protocol_retained_source',
    'history floor fences development purge; ordinary Pull is hot-history only',
    'canonical mutation payload bytes', 'development purge behind history floor',
    'operation_payloads_operation_id_pkey',
    'ordinary Pull hot-history and HistoricalOperationPayloadPort', {
      accountableOwnerRole: 'canonical_mutation_governance',
      policyStatus: 'development_authorized', hotRetention: PROTOCOL_WATERMARK,
      coldRetention: PROTOCOL_WATERMARK, permanentFacts: [],
      onlineColdRead: 'verified_available', recoveryWindow: PROTOCOL_WATERMARK,
      legalBasis: 'protocol_integrity', decisionReference: SYNC_REFERENCES,
      sourceDeletionAuthorization: 'development_only',
      sourceDeletionAuthorized: false, requiredEligibilityGates: PROTOCOL_GATES,
    }),
  row('operation_lookup_facts', 'operation', 'identity_lifetime',
    'permanent attachment identity and command replay facts; monitor append-only growth',
    'attachment finalize and retire facts', 'none; identity-lifetime lookup',
    'operation_lookup_facts_pkey',
    'attachment command replay identity', {
      accountableOwnerRole: 'canonical_mutation_governance',
      policyStatus: 'permanent', hotRetention: IDENTITY_LIFETIME,
      coldRetention: COLD_NOT_APPROVED,
      permanentFacts: ['operation_identity_lookup'],
      onlineColdRead: 'not_configured', recoveryWindow: IDENTITY_LIFETIME,
      legalBasis: 'correctness_authority',
      decisionReference: CAPACITY_AND_ARCHIVE_REFERENCES,
      sourceDeletionAuthorization: 'not_authorized',
      sourceDeletionAuthorized: false, requiredEligibilityGates: TERMINAL_GATES,
    }),
  row('audit_events', 'audit', 'authoritative_permanent',
    'permanent audit fact headers remain online compliance authority',
    'canonical mutation and product command audit headers', 'none; permanent headers',
    'audit_events_pkey',
    'compliance search and payload split', {
      accountableOwnerRole: 'compliance_governance',
      policyStatus: 'compliance_blocked', hotRetention: PERMANENT,
      coldRetention: COLD_NOT_APPROVED, permanentFacts: [],
      onlineColdRead: 'not_configured', recoveryWindow: PERMANENT,
      legalBasis: 'compliance_decision_pending',
      decisionReference: CAPACITY_AND_ARCHIVE_REFERENCES,
      sourceDeletionAuthorization: 'not_authorized',
      sourceDeletionAuthorized: false, requiredEligibilityGates: TERMINAL_GATES,
    }),
  row('digest_audit_events', 'audit', 'authoritative_permanent',
    'report state and policy changes are append-only audit authority',
    'News Digest series/edition/member/follow audit events', 'none; permanent report audit',
    'digest_audit_events_series_time_idx',
    'report lifecycle and compliance investigations', {
      accountableOwnerRole: 'product_api_governance',
      policyStatus: 'compliance_blocked', hotRetention: PERMANENT,
      coldRetention: COLD_NOT_APPROVED, permanentFacts: [],
      onlineColdRead: 'not_configured', recoveryWindow: PERMANENT,
      legalBasis: 'accepted_product_contract',
      decisionReference: CAPACITY_AND_ARCHIVE_REFERENCES,
      sourceDeletionAuthorization: 'not_authorized',
      sourceDeletionAuthorized: false, requiredEligibilityGates: TERMINAL_GATES,
    }),
  row('audit_event_payloads', 'audit_payload', 'protocol_retained_source',
    'dev_authorized archive mechanics are ready; production legal basis and deletion approval remain blocked',
    'audit payload bytes', 'development archive executor; production deletion blocked',
    'audit_event_payloads_pkey',
    'audit payload reader cutover', {
      accountableOwnerRole: 'compliance_governance',
      policyStatus: 'development_authorized', hotRetention: DECISION_PENDING,
      coldRetention: PERMANENT, permanentFacts: [],
      onlineColdRead: 'verified_available', recoveryWindow: PERMANENT,
      legalBasis: 'compliance_decision_pending',
      decisionReference: CAPACITY_AND_ARCHIVE_REFERENCES,
      sourceDeletionAuthorization: 'development_only',
      sourceDeletionAuthorized: false, requiredEligibilityGates: TERMINAL_GATES,
    }),
  row('outbox_events', 'outbox', 'protocol_retained_source',
    'Feed rebuild and delivery recovery consume retained event evidence',
    'canonical mutation outbox envelopes', 'development Social Feed floor; other handlers pending',
    'outbox_events_pkey',
    'Feed rebuild and delivery recovery', {
      accountableOwnerRole: 'social_feed_and_messaging_governance',
      policyStatus: 'development_authorized', hotRetention: SOCIAL_FEED_90_DAYS,
      coldRetention: SOCIAL_FEED_90_DAYS, permanentFacts: [],
      onlineColdRead: 'not_configured', recoveryWindow: SOCIAL_FEED_90_DAYS,
      legalBasis: 'accepted_product_contract',
      decisionReference: [
        ...CAPACITY_AND_ARCHIVE_REFERENCES, 'phase5_social_retention_contract',
      ],
      sourceDeletionAuthorization: 'development_only',
      sourceDeletionAuthorized: false, requiredEligibilityGates: PROTOCOL_GATES,
    }),
  row('sync_node_revision_history', 'sync', 'identity_lifetime',
    'Sync merge proof is retained for the Replica lifetime',
    'per-resource Sync revision facts', 'Replica retirement only',
    'sync_node_revision_history_pkey',
    'Sync merge and identity proof', {
      accountableOwnerRole: 'sync_protocol_governance',
      policyStatus: 'correctness_blocked', hotRetention: IDENTITY_LIFETIME,
      coldRetention: COLD_NOT_APPROVED, permanentFacts: [],
      onlineColdRead: 'not_configured', recoveryWindow: IDENTITY_LIFETIME,
      legalBasis: 'protocol_integrity', decisionReference: SYNC_REFERENCES,
      sourceDeletionAuthorization: 'not_authorized',
      sourceDeletionAuthorized: false, requiredEligibilityGates: PROTOCOL_GATES,
    }),
  row('sync_sequence_receipts', 'sync', 'identity_lifetime',
    'Sequence and Operation non-reuse proof is Replica-lifetime authority',
    'Sequence receipt rows per Replica', 'Replica retirement only',
    'sync_sequence_receipts_pkey',
    'Sequence non-reuse recovery', {
      accountableOwnerRole: 'sync_protocol_governance',
      policyStatus: 'correctness_blocked', hotRetention: IDENTITY_LIFETIME,
      coldRetention: COLD_NOT_APPROVED, permanentFacts: [],
      onlineColdRead: 'not_configured', recoveryWindow: IDENTITY_LIFETIME,
      legalBasis: 'protocol_integrity', decisionReference: SYNC_REFERENCES,
      sourceDeletionAuthorization: 'not_authorized',
      sourceDeletionAuthorized: false, requiredEligibilityGates: PROTOCOL_GATES,
    }),
  row('resource_id_ledger', 'identity', 'authoritative_permanent',
    'global resource-id non-reuse authority is immutable',
    'global Resource ID allocations', 'none; permanent non-reuse',
    'resource_id_ledger_pkey',
    'global identity non-reuse', {
      accountableOwnerRole: 'identity_governance', policyStatus: 'permanent',
      hotRetention: PERMANENT, coldRetention: COLD_NOT_APPROVED,
      permanentFacts: ['global_resource_id_non_reuse'],
      onlineColdRead: 'not_configured', recoveryWindow: PERMANENT,
      legalBasis: 'correctness_authority',
      decisionReference: CAPACITY_AND_ARCHIVE_REFERENCES,
      sourceDeletionAuthorization: 'not_authorized',
      sourceDeletionAuthorized: false, requiredEligibilityGates: COMMON_GATES,
    }),
  row('sync_sequence_operation_claims', 'sync', 'identity_lifetime',
    'immutable Operation and Sequence ownership is retained through Replica retirement',
    'Operation/Sequence ownership claims', 'Replica retirement only',
    'sync_sequence_operation_claims_pkey',
    'Sequence ownership recovery', {
      accountableOwnerRole: 'sync_protocol_governance',
      policyStatus: 'correctness_blocked', hotRetention: IDENTITY_LIFETIME,
      coldRetention: COLD_NOT_APPROVED, permanentFacts: [],
      onlineColdRead: 'not_configured', recoveryWindow: IDENTITY_LIFETIME,
      legalBasis: 'protocol_integrity', decisionReference: SYNC_REFERENCES,
      sourceDeletionAuthorization: 'not_authorized',
      sourceDeletionAuthorized: false, requiredEligibilityGates: PROTOCOL_GATES,
    }),
  row('sync_operation_effects', 'sync', 'protocol_retained_source',
    'authoritative pull reads effects until the fenced Sync purge boundary advances',
    'authoritative Pull effect headers', 'fenced Sync purge worker',
    'sync_operation_effects_pkey',
    'ordinary Pull hot-history', {
      accountableOwnerRole: 'sync_protocol_governance',
      policyStatus: 'correctness_blocked', hotRetention: PROTOCOL_WATERMARK,
      coldRetention: COLD_NOT_APPROVED, permanentFacts: [],
      onlineColdRead: 'not_configured', recoveryWindow: PROTOCOL_WATERMARK,
      legalBasis: 'protocol_integrity', decisionReference: SYNC_REFERENCES,
      sourceDeletionAuthorization: 'not_authorized',
      sourceDeletionAuthorized: false, requiredEligibilityGates: PROTOCOL_GATES,
    }),
  row('sync_operation_effect_pages', 'sync', 'protocol_retained_source',
    'paged authoritative effects remain readable until their fenced parent purge',
    'authoritative Pull effect page bytes', 'fenced Sync purge worker',
    'sync_operation_effect_pages_pkey',
    'ordinary Pull page reads', {
      accountableOwnerRole: 'sync_protocol_governance',
      policyStatus: 'correctness_blocked', hotRetention: PROTOCOL_WATERMARK,
      coldRetention: COLD_NOT_APPROVED, permanentFacts: [],
      onlineColdRead: 'not_configured', recoveryWindow: PROTOCOL_WATERMARK,
      legalBasis: 'protocol_integrity', decisionReference: SYNC_REFERENCES,
      sourceDeletionAuthorization: 'not_authorized',
      sourceDeletionAuthorized: false, requiredEligibilityGates: PROTOCOL_GATES,
    }),
  row('sync_purged_node_id_watermarks', 'sync', 'authoritative_permanent',
    'immutable watermark prevents resurrection after tombstone payload compaction',
    'purged Node ID watermarks', 'none; permanent anti-resurrection',
    'sync_purged_node_id_watermarks_boundary_idx',
    'tombstone compaction anti-resurrection', {
      accountableOwnerRole: 'sync_protocol_governance',
      policyStatus: 'correctness_blocked', hotRetention: PERMANENT,
      coldRetention: COLD_NOT_APPROVED,
      permanentFacts: ['purged_resource_id_watermark'],
      onlineColdRead: 'not_configured', recoveryWindow: PERMANENT,
      legalBasis: 'protocol_integrity', decisionReference: SYNC_REFERENCES,
      sourceDeletionAuthorization: 'not_authorized',
      sourceDeletionAuthorized: false, requiredEligibilityGates: PROTOCOL_GATES,
    }),
  row('sync_replica_retirement_receipts', 'sync', 'identity_lifetime',
    'immutable retirement idempotency and lifecycle proof is Replica-lifetime evidence',
    'Replica retirement receipts', 'Replica retirement lifecycle only',
    'sync_replica_retirement_receipts_pkey',
    'Replica retirement idempotency', {
      accountableOwnerRole: 'sync_protocol_governance',
      policyStatus: 'correctness_blocked', hotRetention: IDENTITY_LIFETIME,
      coldRetention: COLD_NOT_APPROVED, permanentFacts: [],
      onlineColdRead: 'not_configured', recoveryWindow: IDENTITY_LIFETIME,
      legalBasis: 'protocol_integrity', decisionReference: SYNC_REFERENCES,
      sourceDeletionAuthorization: 'not_authorized',
      sourceDeletionAuthorized: false, requiredEligibilityGates: PROTOCOL_GATES,
    }),
  row('sync_recovery_ack_receipts', 'sync', 'identity_lifetime',
    'recovery replay and lease-generation proof is retained for the Replica lifetime',
    'recovery Ack receipts', 'Replica retirement only',
    'sync_recovery_ack_receipts_pkey',
    'recovery replay fencing', {
      accountableOwnerRole: 'sync_protocol_governance',
      policyStatus: 'correctness_blocked', hotRetention: IDENTITY_LIFETIME,
      coldRetention: COLD_NOT_APPROVED, permanentFacts: [],
      onlineColdRead: 'not_configured', recoveryWindow: IDENTITY_LIFETIME,
      legalBasis: 'protocol_integrity', decisionReference: SYNC_REFERENCES,
      sourceDeletionAuthorization: 'not_authorized',
      sourceDeletionAuthorized: false, requiredEligibilityGates: PROTOCOL_GATES,
    }),
  row('sync_bootstrap_snapshot_pages', 'sync', 'protocol_retained_source',
    'immutable page evidence is read to validate recovery completion and retains its snapshot',
    'bootstrap Snapshot pages', 'fenced Snapshot retention',
    'sync_bootstrap_snapshot_pages_pkey',
    'Snapshot recovery completion', {
      accountableOwnerRole: 'sync_protocol_governance',
      policyStatus: 'correctness_blocked', hotRetention: PROTOCOL_WATERMARK,
      coldRetention: COLD_NOT_APPROVED, permanentFacts: [],
      onlineColdRead: 'not_configured', recoveryWindow: PROTOCOL_WATERMARK,
      legalBasis: 'protocol_integrity', decisionReference: SYNC_REFERENCES,
      sourceDeletionAuthorization: 'not_authorized',
      sourceDeletionAuthorized: false, requiredEligibilityGates: PROTOCOL_GATES,
    }),
  row('outbox_delivery_receipts', 'outbox', 'protocol_retained_source',
    'delivery_each_event retries read the receipt as durable duplicate-delivery proof',
    'outbox delivery receipts', 'protocol watermark with delivery recovery',
    'outbox_delivery_receipts_pkey',
    'duplicate-delivery retry proof', {
      accountableOwnerRole: 'social_feed_and_messaging_governance',
      policyStatus: 'correctness_blocked', hotRetention: PROTOCOL_WATERMARK,
      coldRetention: COLD_NOT_APPROVED, permanentFacts: [],
      onlineColdRead: 'not_configured', recoveryWindow: PROTOCOL_WATERMARK,
      legalBasis: 'protocol_integrity',
      decisionReference: CAPACITY_AND_ARCHIVE_REFERENCES,
      sourceDeletionAuthorization: 'not_authorized',
      sourceDeletionAuthorized: false, requiredEligibilityGates: PROTOCOL_GATES,
    }),
  row('product_command_receipts', 'idempotency', 'identity_lifetime',
    'result purge preserves a compact command claim until principal lifecycle cleanup',
    'product command claims and result payloads',
    'result expiry leaves compact claim; principal lifecycle cleanup',
    'product_command_receipts_pkey',
    'product command replay', {
      accountableOwnerRole: 'product_api_governance',
      policyStatus: 'correctness_blocked', hotRetention: PRODUCT_RESULT_THEN_CLAIM,
      coldRetention: COLD_NOT_APPROVED, permanentFacts: [],
      onlineColdRead: 'not_configured', recoveryWindow: IDENTITY_LIFETIME,
      legalBasis: 'accepted_product_contract',
      decisionReference: [
        ...CAPACITY_AND_ARCHIVE_REFERENCES, 'adr_0012_product_command_retention',
      ],
      sourceDeletionAuthorization: 'not_authorized',
      sourceDeletionAuthorized: false, requiredEligibilityGates: TERMINAL_GATES,
    }),
  row('sync_pull_cursor_evidence', 'sync', 'protocol_retained_source',
    'next-cursor handshake leftover after page-level Pull evidence; not per-event growth',
    'one next-cursor row per issued Pull page',
    'evidence maintenance worker; never request-path DELETE',
    'sync_pull_cursor_evidence_cleanup_idx',
    'Ack receipt and checkpoint cursor_digest foreign keys', {
      accountableOwnerRole: 'sync_protocol_governance',
      policyStatus: 'correctness_blocked', hotRetention: PROTOCOL_WATERMARK,
      coldRetention: COLD_NOT_APPROVED, permanentFacts: [],
      onlineColdRead: 'not_configured', recoveryWindow: PROTOCOL_WATERMARK,
      legalBasis: 'protocol_integrity', decisionReference: SYNC_REFERENCES,
      sourceDeletionAuthorization: 'not_authorized',
      sourceDeletionAuthorized: false, requiredEligibilityGates: PROTOCOL_GATES,
    }, { warnRows: ONE_MILLION, warnBytes: TWO_GIB }),
  row('sync_pull_cursor_recovery_proofs', 'sync', 'protocol_retained_source',
    'digest-only expired-cursor recovery proof; one row per issued Pull page',
    'one recovery proof per issued Pull page',
    'evidence maintenance worker; never request-path DELETE',
    'sync_pull_cursor_recovery_proofs_cleanup_idx',
    'expired cursor recovery without payload storage', {
      accountableOwnerRole: 'sync_protocol_governance',
      policyStatus: 'correctness_blocked', hotRetention: PROTOCOL_WATERMARK,
      coldRetention: COLD_NOT_APPROVED, permanentFacts: [],
      onlineColdRead: 'not_configured', recoveryWindow: PROTOCOL_WATERMARK,
      legalBasis: 'protocol_integrity', decisionReference: SYNC_REFERENCES,
      sourceDeletionAuthorization: 'not_authorized',
      sourceDeletionAuthorized: false, requiredEligibilityGates: PROTOCOL_GATES,
    }, { warnRows: ONE_MILLION, warnBytes: TWO_GIB }),
  row('sync_pull_cursor_lineage', 'sync', 'protocol_retained_source',
    'digest-only signed lineage that outlives cursor evidence after key rotation',
    'one lineage row per issued Pull page when the writer keyring is configured',
    'evidence maintenance worker; never request-path DELETE',
    'sync_pull_cursor_lineage_cleanup_idx',
    'key-rotation recovery of expired next-cursors', {
      accountableOwnerRole: 'sync_protocol_governance',
      policyStatus: 'correctness_blocked', hotRetention: PROTOCOL_WATERMARK,
      coldRetention: COLD_NOT_APPROVED, permanentFacts: [],
      onlineColdRead: 'not_configured', recoveryWindow: PROTOCOL_WATERMARK,
      legalBasis: 'protocol_integrity', decisionReference: SYNC_REFERENCES,
      sourceDeletionAuthorization: 'not_authorized',
      sourceDeletionAuthorized: false, requiredEligibilityGates: PROTOCOL_GATES,
    }, { warnRows: ONE_MILLION, warnBytes: TWO_GIB }),
  row('sync_pull_page_evidence', 'sync', 'protocol_retained_source',
    'page-level Pull envelope is the append authority that replaced per-event evidence growth',
    'one envelope row per non-empty or initial Pull page',
    'evidence maintenance worker; never request-path DELETE',
    'sync_pull_page_evidence_cleanup_idx',
    'Pull handoff and page-range recovery', {
      accountableOwnerRole: 'sync_protocol_governance',
      policyStatus: 'correctness_blocked', hotRetention: PROTOCOL_WATERMARK,
      coldRetention: COLD_NOT_APPROVED, permanentFacts: [],
      onlineColdRead: 'not_configured', recoveryWindow: PROTOCOL_WATERMARK,
      legalBasis: 'protocol_integrity', decisionReference: SYNC_REFERENCES,
      sourceDeletionAuthorization: 'not_authorized',
      sourceDeletionAuthorized: false, requiredEligibilityGates: PROTOCOL_GATES,
    }, {
      warnRows: ONE_MILLION, warnBytes: TWO_GIB,
      replacesTableName: 'sync_pull_cursor_evidence',
    }),
  row('sync_node_tombstones', 'sync', 'protocol_retained_source',
    'durable per-Node deletion membership until the fenced tombstone purge worker runs',
    'one row per deleted Node until purge_after and watermark advance',
    'fenced tombstone purge worker; never ad-hoc DELETE',
    'sync_node_tombstones_purge_candidate_idx',
    'Pull tombstone delivery and anti-resurrection watermarks', {
      accountableOwnerRole: 'sync_protocol_governance',
      policyStatus: 'correctness_blocked', hotRetention: PROTOCOL_WATERMARK,
      coldRetention: COLD_NOT_APPROVED, permanentFacts: [],
      onlineColdRead: 'not_configured', recoveryWindow: PROTOCOL_WATERMARK,
      legalBasis: 'protocol_integrity', decisionReference: SYNC_REFERENCES,
      sourceDeletionAuthorization: 'not_authorized',
      sourceDeletionAuthorized: false, requiredEligibilityGates: PROTOCOL_GATES,
    }),
]);

type ListedTable = (typeof LEDGER_APPEND_AUTHORITY)[number]['tableName'];
type MissingAuthorityTable = Exclude<LedgerTableName, ListedTable>;
const _authorityListsEveryTable: MissingAuthorityTable extends never ? true : MissingAuthorityTable = true;
void _authorityListsEveryTable;

export const LEDGER_CAPACITY_TARGETS: readonly LedgerCapacityTarget[] = Object.freeze(
  LEDGER_APPEND_AUTHORITY.map((item) => Object.freeze({
    tableName: item.tableName,
    family: item.family,
    retentionClass: item.retentionClass,
    archiveBlocker: item.archiveBlocker,
    owner: item.owner,
    growthDriver: item.growthDriver,
    cleanupMechanism: item.cleanupMechanism,
    requiredIndex: item.requiredIndex,
    warnRows: item.warnRows,
    warnBytes: item.warnBytes,
    warnDeadRatio: item.warnDeadRatio,
    recoveryDependency: item.recoveryDependency,
    replacesTableName: item.replacesTableName,
  })),
);

export const LEDGER_RETENTION_POLICIES = Object.freeze(
  LEDGER_APPEND_AUTHORITY.map((item) => Object.freeze({
    tableName: item.tableName,
    family: item.family,
    accountableOwnerRole: item.accountableOwnerRole,
    policyStatus: item.policyStatus,
    hotRetention: item.hotRetention,
    coldRetention: item.coldRetention,
    permanentFacts: item.permanentFacts,
    onlineColdRead: item.onlineColdRead,
    recoveryWindow: item.recoveryWindow,
    legalBasis: item.legalBasis,
    decisionReference: item.decisionReference,
    sourceDeletionAuthorization: item.sourceDeletionAuthorization,
    sourceDeletionAuthorized: item.sourceDeletionAuthorized,
    requiredEligibilityGates: item.requiredEligibilityGates,
  })),
) as readonly LedgerRetentionPolicy[];
