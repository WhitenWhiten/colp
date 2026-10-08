export { createDatabase, createDatabasePoolConfig, createDatabaseRuntime } from './runtime.js';
export type {
  DatabaseRuntime,
  DatabaseRuntimeOptions,
  DatabaseSchema,
  AccountTable,
  BookmarkPreferencesTable,
  ProfileTable,
  ProfileHandleTable,
  AccountIdentityTable,
  SessionTable,
  OidcLoginTransactionTable,
  ResourceIdLedgerTable,
  CollectionTable,
  PublicationInsightEventTable,
  PublicationInsightDailyTable,
  NodeTable,
  AnnotationTable,
  RelationTable,
  SavedResourceTable,
  FollowTable,
  SocialFeedItemTable,
  SocialFeedWatermarkTable,
  SyncDeviceTable,
  SyncReplicaIdLedgerTable,
  SyncReplicaGenerationTable,
  SyncReplicaTable,
  SyncExtensionCredentialTable,
  SyncSessionTable,
  SyncSessionScopeTable,
  SyncSessionBindingTable,
  SyncSessionIdempotencyReceiptTable,
  SyncPullCursorEvidenceTable,
  SyncAckReceiptTable,
  SyncSequenceLaneTable,
  SyncSequenceOperationClaimTable,
  SyncSequenceReceiptTable,
  SyncNodeRevisionHistoryTable,
  SyncNodeTombstoneTable,
  SyncConflictTable,
  CollectionMemberTable,
  CollectionInviteTable,
  CollectionInviteDeliveryTable,
  CollectionPolicyTable,
  ResourceRevisionTable,
  ChildrenRevisionTable,
  ContentRevisionTable,
  PolicyRevisionTable,
  OperationTable,
  AuditEventTable,
  AuditEventPayloadTable,
  OutboxEventTable,
  CollectionMutationProjectionAppliedTable,
  CollectionMutationProjectionResourceTable,
  CollectionMutationProjectionWatermarkTable,
  McpChangePlanTable,
  McpApprovalTable,
  McpCommitReceiptTable,
  ProductCommandReceiptTable,
  PublisherIdempotencyTable,
  AttachmentsTable,
} from './runtime.js';
export type {
  DigestSeriesTable,
  DigestEditionTable,
  DigestMemberTable,
  DigestFollowTable,
  DigestScheduleTable,
  DigestRunTable,
  DigestAuditEventTable,
  DigestSourceInvalidationProgressTable,
} from './reports-tables.js';
export type { SyncPullPageEvidenceTable } from './sync-pull-page-evidence-tables.js';

export {
  appendAuditEvent,
  AUDIT_PAYLOAD_SCHEMA_VERSION,
  AuditPayloadArchiveError,
  AuditPayloadReadError,
  createPostgresAuditPayloadArchiveCapability,
  createPostgresAuditHotPayloadSource,
  createPostgresAuditPayloadReader,
} from './audit-event-payload.js';
export type {
  AppendAuditEventInput,
  AuditHotPayloadRecord,
  AuditHotPayloadSource,
  AuditPayloadColdFacts,
  AuditPayloadColdSource,
  AuditPayloadArchiveCapability,
  AuditPayloadArchiveErrorCode,
  AuditPayloadKey,
  AuditPayloadReader,
  AuditPayloadReadErrorCode,
} from './audit-event-payload.js';

export {
  createLedgerRetentionEvidence,
  ELIGIBILITY_GATES,
  evaluateLedgerRetentionPolicyCommand,
  LEDGER_RETENTION_POLICIES,
  serializeLedgerRetentionEvidence,
  validateLedgerRetentionPolicies,
} from './ledger-retention-policy.js';
export type {
  AccountableOwnerRole,
  DecisionReference,
  EligibilityGate,
  LedgerRetentionEvidence,
  LedgerRetentionPolicy,
  LedgerRetentionPolicyCommandResult,
  LedgerRetentionValidationCode,
  LedgerRetentionValidationIssue,
  LedgerTableName,
  LegalBasis,
  OnlineColdRead,
  PermanentFact,
  RetentionPolicyStatus,
  RetentionWindow,
  SourceDeletionAuthorization,
} from './ledger-retention-policy.js';

export type { LedgerArchiveSegmentTable } from './ledger-archive-tables.js';
export type { SyncHistoryFloorTable } from './sync-history-floor-tables.js';
export type {
  HistoricalOperationPayloadPort,
  HistoricalOperationPayloadPurpose,
  OperationPayloadDocument,
  OperationPayloadFacts,
  OperationPayloadSource,
  OperationPayloadSourceKind,
  OperationPayloadTable,
} from './operation-payload-tables.js';
export {
  appendOperationWithPayload,
  OperationPayloadReadError,
  readOperationPayload,
} from './operation-payload-store.js';
export type {
  AppendOperationWithPayloadInput,
  OperationPayloadReadErrorCode,
} from './operation-payload-store.js';
export type {
  OutboxDatabaseSchema,
  OutboxDispatchClaimTable,
  OutboxRetentionFloorTable,
} from './outbox-tables.js';

export {
  applyLedgerPayloadPurgeBatch,
  LedgerPayloadPurgeError,
} from './ledger-payload-purge.js';
export type {
  ApplyLedgerPayloadPurgeInput,
  LedgerPayloadPurgeBatchResult,
  LedgerPayloadPurgeClaim,
  LedgerPayloadPurgeErrorCode,
} from './ledger-payload-purge.js';
export {
  createPostgresLedgerPayloadPurgeJobRepository,
  LedgerPayloadPurgeJobError,
} from './ledger-payload-purge-job-repository.js';
export type {
  EnqueueLedgerPayloadPurgeJobInput,
  LedgerPayloadPurgeJob,
  LedgerPayloadPurgeJobClaim,
  LedgerPayloadPurgeJobRepository,
} from './ledger-payload-purge-job-repository.js';
export {
  runLedgerPayloadPurgeWorkerOnce,
  serializeLedgerPayloadPurgeJob,
} from './ledger-payload-purge-worker.js';
export type {
  LedgerPayloadPurgeWorkerOutcome,
  RunLedgerPayloadPurgeWorkerOnceInput,
} from './ledger-payload-purge-worker.js';
export type {
  LedgerPayloadPurgeFamily,
  LedgerPayloadPurgeJobTable,
  LedgerPayloadPurgeReceiptTable,
  LedgerPayloadPurgeStatus,
} from './ledger-payload-purge-tables.js';
export {
  LEDGER_RECLAIM_RELATIONS,
  reclaimLedgerStorage,
} from './ledger-storage-reclaim.js';
export type {
  LedgerReclaimRelation,
  LedgerStorageMeasurement,
  LedgerStorageReclaimEvidence,
} from './ledger-storage-reclaim.js';

export {
  ARCHIVE_HOT_SOURCE_STATES,
  ARCHIVE_OBJECT_STATES,
  ARCHIVE_READ_STATES,
  evaluateLedgerArchivePolicy,
  evaluateLedgerArchivePolicyFromLinear,
  lifecycleFromLinearState,
  lifecycleMatchesLinear,
  parseLedgerArchiveLifecycle,
} from './ledger-archive-policy.js';
export type {
  ArchiveHotSourceState,
  ArchiveObjectState,
  ArchiveReadState,
  LedgerArchiveLifecycle,
  LedgerArchiveLinearState,
  LedgerArchivePolicy,
  LedgerArchivePolicyInput,
} from './ledger-archive-policy.js';

export {
  createPostgresLedgerArchiveSegmentRepository,
  LedgerArchiveSegmentRepositoryError,
} from './ledger-archive-segment-repository.js';
export type {
  CreateLedgerArchiveSegmentInput,
  LedgerArchiveSegment,
  LedgerArchiveSegmentRepository,
  LedgerArchiveSegmentRepositoryErrorCode,
  LedgerArchiveSegmentState,
  LedgerArchiveTransitionInput,
  ListPendingLedgerArchiveSegmentsInput,
  SetLedgerArchiveLegalHoldInput,
} from './ledger-archive-segment-repository.js';

export {
  createPostgresSyncHistoryFloorRepository,
  SyncHistoryFloorRepositoryError,
} from './sync-history-floor-repository.js';
export type {
  AdvanceSyncHistoryFloorInput,
  SyncHistoryFloor,
  SyncHistoryFloorRepository,
  SyncHistoryFloorRepositoryErrorCode,
} from './sync-history-floor-repository.js';

export { databaseNow } from './time.js';
export { readBackendPid, withPostgresAbort } from './query-abort.js';
export { rollbackTransaction } from './transaction-rollback.js';
export {
  createPostgresProductCommandReceiptPort,
  createPostgresProductCommandReceiptPortFactory,
} from './product-command-receipt.js';
export { createPostgresSharedExposureFactsPort } from './postgres-shared-exposure-facts.js';
export { createAttachmentExposurePolicyAdapter } from './attachment-exposure-policy-adapter.js';
export type { AttachmentExposurePolicyAdapter } from './attachment-exposure-policy-adapter.js';
export type { SharedExposureFactsPort, SharedExposureFactsScope } from '../../modules/exposure/index.js';
export {
  assertNoLegacyMcpSessionFields,
  buildPostgresMcpChangePlanRow,
  createMcpBindingDigest,
  createPostgresMcpChangePlanStore,
  expireDuePlansAt,
  purgeRetainedAt,
  PostgresMcpChangePlanStoreError,
} from './mcp-change-plan-store.js';
export { createPostgresMcpWriteApprovalPorts } from './mcp-write-approval-port.js';
export { createPostgresMcpWriteOperationsStore } from './mcp-write-operations-store.js';
export { createPostgresMcpOauthRevocationStore } from './postgres-mcp-oauth-revocation-store.js';
export type {
  PostgresMcpApprovalBeginResult,
  PostgresMcpApprovalStorePort,
  PostgresMcpChangePlanCommitApprovalStorePort,
  PostgresMcpChangePlanCommitPlanStorePort,
  PostgresMcpChangePlanRow,
  PostgresMcpChangePlanStore,
  PostgresMcpChangePlanStoreErrorCode,
  PostgresMcpChangePlanStorePort,
  PostgresMcpPlanCommitResult,
  PostgresMcpRetentionPurgeResult,
  PostgresMcpStoredPlan,
} from './mcp-change-plan-store.js';
export {
  DatabaseOperationError,
  classifyDatabaseError,
  isPostgresErrorCode,
} from './errors.js';
export type { DatabaseFailureKind } from './errors.js';
export { createUnitOfWork } from './unit-of-work.js';
export { createPostgresResourceIdLedgerPort } from './resource-id-ledger.js';
export type {
  DatabaseTransaction,
  TransactionContext,
  TransactionFaultInjector,
  TransactionIsolationLevel,
  UnitOfWork,
  UnitOfWorkOptions,
} from './unit-of-work.js';
export {
  canonicalizeExecutedMigrationTimestamps,
  createMigrator,
  isMigrationTimestampOrderError,
  resolveMigrationDirectory,
  runMigrations,
} from './migrations.js';
export type { MigrationCommand, MigrationRunResult } from './migrations.js';
export { isConcurrentCatalogRaceError } from './concurrent-catalog.js';
// T-10 lock order (ADR-0027): bootstrap compositions whose canonical writes mark
// replicas `recovery_required` acquire the Replica rows before the Collection
// row through the single lock-order module instead of re-deriving the SELECT.
export { lockCollectionForReplicaInvalidation } from './lock-order.js';
// Self-hosted entry and CLI open the maintenance (migrator) runtime.
export { maintenanceDatabaseRuntimeOptions } from './maintenance-options.js';
export { isAvatarPublicationRestricted, isFaviconHiddenPublic, isFaviconPubliclyAccessible } from './publication-object-controls.js';
