import type { ReplicaCheckpoint } from './replica-lifecycle.js';
export type { PushReplicaOwnershipVerifier } from './push-ownership.js';
export { SUBTREE_OBSERVATION_EXTENSION, subtreeDeleteSource, type SubtreeMemberRevision } from './subtree-observation.js';

export {
  type SequenceCoordinatorReceiptStore,
  type SequenceCoordinatorResult,
  type SequenceCoordinatorTransaction,
  type SequenceCoordinatorUnitOfWork,
  type SequenceEvaluation,
  type SequenceEvaluationContext,
  type SequenceLaneKey,
  type SequenceLaneState,
  type SequenceOperationRequest,
  type SequenceReceiptWriteCondition,
} from './sequence.js';

export {
  AtomicPushNotCommittableError,
  PushOperationReuseError,
  type PushArtifactBuilder,
  type PushDeniedOperation,
  type PushPartialProgress,
  type PushCommitContext,
  type PushConflictRecord,
  type PurePushPreflight,
  type PushOperationIdOwner,
  type PushPreflight,
  type PushPreflightContext,
  type PushPreparedOperation,
  type PushTransactionOperation,
  type PushTransactionRequest,
  type PushTransactionResult,
} from './push-transaction.js';

export {
  SYNC_PULL_MAX_LIMIT,
  SyncPullLogTruncatedError,
  AUTHORITATIVE_EFFECT_MAX_BYTES,
  AUTHORITATIVE_EFFECT_MAX_DEPTH,
  AUTHORITATIVE_EFFECT_MAX_MEMBERS,
  AUTHORITATIVE_EFFECT_PAGE_MAX_BYTES,
  canonicalAuthoritativeEffectDigest,
  canonicalAuthoritativeEffectPageDigest,
  canonicalAuthoritativeMemberDigest,
  canonicalOperationDigest,
  assertAuthoritativeEffectPageUrlSafe,
  expandAuthoritativeEffectPageUrl,
  EFFECT_PAGE_TEMPLATE_VARIABLES,
  rejectPrivateOrLocalSnapshotUrl,
  withRecommendedSnapshotUrlHostPolicy,
  validateAuthoritativePullEvent,
  validateAuthoritativePullEventPage,
  validateAuthoritativePullEventPages,
  type AuthoritativeEffectPageExpectation,
  type EffectPageRequest,
  type AuthoritativePullProtocolVersion,
  type SyncPullCommittedEvent,
  type SyncPullCoordinatorFailure,
  type SyncPullCoordinatorResult,
  type SyncPullCoordinatorSuccess,
  type SyncPullCursorRecord,
  type SyncPullCursorState,
  type SyncPullCursorStore,
  type SyncPullEventPage,
  type SyncPullEventReadRequest,
  type SyncPullEventStore,
  type SyncPullProblem,
  type SyncPullRequestContext,
  type SyncPullSnapshotUrlOptions,
  type SyncPullSnapshotUrlSafetyAssert,
} from './pull.js';
export type { SyncPullCursorBinding, SyncPullCursorHandoffAuthorization, SyncPullCursorHandoffRequest, SyncPullInitialCursorRequest } from './pull-cursor-lifecycle.js';

export {
  SyncSessionAlreadyExistsError,
  SyncSessionGateDeniedError,
  assertVerifiedSyncSession,
  createSyncSession,
  isVerifiedSyncSession,
  requireVerifiedSyncSession,
  terminateSyncSession,
  verifySyncSessionContext,
  type ActiveSyncSessionRecord,
  type CreateSyncSessionInput,
  type SyncSessionAuthorizationContext,
  type SyncSessionBinding,
  type SyncSessionCredentialBinding,
  type SyncSessionCredentialKind,
  type SyncSessionGateDenial,
  type SyncSessionGateDenialState,
  type SyncSessionProtocolVersion,
  type SyncSessionRecord,
  type SyncSessionScope,
  type SyncSessionStore,
  type SyncSessionStoreCreateResult,
  type SyncSessionTermination,
  type SyncSessionTerminationReason,
  type SyncSessionVerificationResult,
  type TerminatedSyncSessionRecord,
  type VerifiedSyncSession,
  type VerifySyncSessionContextInput,
} from './session.js';

export {
  defaultServerTransportBudget,
  encodeSyncTransportBudgetHeader,
  jsonFitsTransportBudget,
  LEGACY_SYNC_TRANSPORT_BUDGET_BYTES,
  legacySyncTransportBudget,
  negotiateSyncTransportBudget,
  parseSyncTransportBudget,
  parseSyncTransportBudgetHeader,
  readDeclaredTransportBudget,
  SYNC_TRANSPORT_BUDGET_EXTENSION,
  SYNC_TRANSPORT_BUDGET_HEADER,
  SYNC_TRANSPORT_BUDGET_KEYS,
  SYNC_TRANSPORT_BUDGET_MAX_BYTES,
  SYNC_TRANSPORT_BUDGET_MIN_BYTES,
  utf8JsonByteLength,
  type SyncTransportBudget,
} from './transport-budget.js';

export {
  coordinateSessionBootstrap,
  type SessionBootstrapArtifactBuilder,
  type SessionBootstrapArtifactStore,
  type SessionBootstrapCollectionAggregate,
  type SessionBootstrapCollectionStore,
  type SessionBootstrapCommitContext,
  type SessionBootstrapIdentity,
  type SessionBootstrapLane,
  type SessionBootstrapLaneState,
  type SessionBootstrapLaneStore,
  type SessionBootstrapOperationStore,
  type SessionBootstrapPrepare,
  type SessionBootstrapPrepareContext,
  type SessionBootstrapPrepared,
  type SessionBootstrapReceiptStore,
  type SessionBootstrapReceiptWriteCondition,
  type SessionBootstrapRequest,
  type SessionBootstrapResult,
  type SessionBootstrapSequenceLane,
  type SessionBootstrapSessionStore,
  type SessionBootstrapStatus,
  type SessionBootstrapTransaction,
  type SessionBootstrapUnitOfWork,
  type StoredSessionBootstrapReceipt,
} from './session-bootstrap.js';

export {
  SyncOperationReceiptUnavailableError,
  SyncOperationReuseError,
  appendSyncOperationReuseAudit,
  claimSyncOperation,
  claimSyncOperations,
  immutableSyncOperationClaim,
  loadSyncOperationClaim,
  syncOperationClaimsMatch,
  type SyncOperationClaim,
  type SyncOperationClaimResult,
  type SyncOperationClaimsResult,
  type SyncOperationClaimStore,
  type SyncOperationReuseAudit,
  type SyncOperationReuseAuditStore,
  type SyncOperationReuseCode,
  type SyncOperationReuseTransaction,
} from './operation-reuse.js';

export {
  SyncTypedUpdateSemanticError,
  assertSyncTypedUpdateOperationPayload,
  validateSyncTypedUpdateOperationPayload,
  type SyncTypedUpdateOperation,
  type SyncTypedUpdateSemanticValidationResult,
} from './typed-operations.js';

export {
  applySyncTypedUpdatePatch,
  deepEqualSyncMergeValue,
  mergeSyncTagsObservedRemove,
  mergeSyncTypedUpdate,
  type SyncTagsMergeResult,
  type SyncTypedMergeConflict,
  type SyncTypedMergeFieldResult,
  type SyncTypedMergeInput,
  type SyncTypedMergeResult,
} from './typed-update-merge.js';

export {
  applySyncBrowserBatch,
  type SyncBrowserBatchAdapter,
  type SyncBrowserBatchChange,
  type SyncBrowserBatchDriver,
} from './browser-batch-adapter.js';

export {
  translateSyncBrowserDelete,
  translateSyncBrowserDeleteOperation,
  translateSyncBrowserEvent,
  type SyncBrowserDeleteTranslation,
  type SyncBrowserEvent,
  type SyncBrowserEventOperationContext,
  type SyncBrowserEventType,
  type SyncBrowserNodeKind,
} from './browser-event-translation.js';

export {
  projectSyncSeparatorForUi,
  representSyncSeparatorForUiMode,
  type SyncSeparatorVisualMode,
  type SyncSeparatorVisualPresentation,
} from './separator-visual.js';

export {
  adviseLightPullBeforePush,
  type LightPullAdvisory,
  type LightPullAdvisoryFacts,
} from './light-pull-advisory.js';

export {
  NETSCAPE_BOOKMARK_FILE_MARKER,
  parseNetscapeBookmarkHtml,
  type NetscapeBookmarkDocument,
  type NetscapeBookmarkEntry,
  type NetscapeBookmarkFolder,
  type NetscapeBookmarkItem,
} from './netscape-bookmark.js';

export {
  SAFARI_ADAPTER_PROFILE,
  assertPublicHttpManifest,
  assertSafariReplicaCapability,
  declareSafariReplicaCapability,
  type SafariReplicaCapability,
} from './replica-capability.js';

export {
  establishSyncRootMapping,
  resolveSyncRootMapping,
  type SyncBrowserRoot,
  type SyncRootMapping,
  type SyncRootMappingAdapter,
} from './root-mapping.js';

export {
  exportSyncSidecars,
  persistSyncSidecar,
  type SyncSidecarAdapter,
  type SyncSidecarExportAdapter,
  type SyncSidecarExporter,
  type SyncSidecarRecord,
} from './sidecar.js';

export {
  coordinateTombstonePurge,
  type DeletionWatermark,
  type TombstoneDeletedMember,
  type TombstonePurgeBlockedReason,
  type TombstonePurgeBoundary,
  type TombstonePurgeCandidate,
  type TombstonePurgeIdentity,
  type TombstonePurgeReplicaState,
  type TombstonePurgeRequest,
  type TombstonePurgeResult,
  type TombstonePurgeTransaction,
  type TombstonePurgeUnitOfWork,
} from './tombstone-purge.js';

export { createSyncTombstone } from './tombstone.js';

export {
  asReplicaAuthenticatedCommand,
  assertReplicaCallerAuthenticated,
  coordinateReplicaDueExpiry,
  coordinateReplicaLifecycle,
  createReplicaAuthProofFromVerifiedSession,
  // createUnverifiedReplicaAuthProofForTests intentionally omitted — testing surface only
  evaluateReplicaSyncBehavior,
  isReplicaAuthProof,
  requiredReplicaLifecycleScope,
  type AuthoritativeSnapshotBinding,
  type DurableReplicaCheckpoint,
  type ReplicaAuthProof,
  type ReplicaAuthProofSource,
  type ReplicaAuthenticatedLifecycleCommandInput,
  type ReplicaCheckpoint,
  type ReplicaLifecycle,
  type ReplicaLifecycleCommand,
  type ReplicaLifecycleCoordinatorResult,
  type ReplicaLifecycleKey,
  type ReplicaLifecycleOwnershipVerifier,
  type ReplicaLifecycleProblemCode,
  type ReplicaLifecycleTransaction,
  type ReplicaLifecycleUnitOfWork,
  type ReplicaRetentionBoundary,
  type ReplicaRetentionWindow,
  type ReplicaSnapshotAck,
  type ReplicaSyncBehavior,
  type ReplicaSyncBehaviorDecision,
} from './replica-lifecycle.js';

export {
  SYNC_HOST_COMPOSITION_NOTES,
  SYNC_PUSH_BATCH_BINDING_VERSION,
  assertSyncPushBatchBoundToSession,
  bindSyncPushBatchId,
  collectionSequenceScopeKey,
  coordinateSessionBoundPull,
  coordinateSessionBoundPush,
  coordinateSessionBoundReplicaLifecycle,
  coordinateSessionBoundSequence,
  legacySyncPushBatchInReceiptScope,
  readSyncPushBatchBinding,
  sequenceScopeMatchesCollection,
  type SessionBoundVerifyInput,
  type SyncPushBatchBinding,
  type SyncPushBatchReceiptScope,
  type SyncWriteCoordinatorOwner,
} from './composition.js';

export {
  createSyncHost,
  type PushSyncHost,
  type PushSyncHostConfig,
  type SequenceSyncHost,
  type SequenceSyncHostConfig,
  type SyncHostConfig,
  type SyncHostWriteOwner,
} from './host.js';

export {
  SYNC_HOST_COMPOSITION_RECIPE,
  SYNC_HOST_RECOMMENDED_WRITE_PATHS,
  createTypedUpdateMergePushPreflight,
  isSyncTypedUpdateOperation,
  isSyncTypedUpdateOperationType,
  type SyncTypedUpdateOperationType,
  type TypedUpdateMergeConflictPlanContext,
  type TypedUpdateMergeMergedPlanContext,
  type TypedUpdateMergePushPreflightHandlers,
} from './host-composition-recipe.js';

export {
  reserveServerIds,
  ServerIdAlreadyReservedError,
  type ServerIdReservation,
  type ServerIdReservationConflict,
  type ServerIdReservationResult,
  type ServerIdReservationStore,
  type ServerIdReservationTransaction,
  type ServerIdResourceType,
} from '../shared/server-id-reservations.js';

export type TerminalOperationStatus =
  | 'applied'
  | 'rebased'
  | 'noop'
  | 'conflicted'
  | 'rejected';
export type OperationReceiptStatus = TerminalOperationStatus | 'deferred';

export interface SequenceReceipt<Result> {
  readonly sequence: number;
  readonly digest: string;
  readonly status: OperationReceiptStatus;
  readonly result: Result;
}

export { PushReceiptConditionFailedError } from './push-unit-of-work.js';
export type {
  OperationReceiptStore,
  PushExecutionScope,
  PushReceiptWriteCondition,
  PushSequenceLane,
  StoredOperationReceipt,
  SyncTransaction,
  SyncUnitOfWork,
} from './push-unit-of-work.js';

export {
  loadSyncExtensionCarrier,
  relaySyncExtensionCarrier,
  transformSyncExtensionCarrier,
  type ProjectedSyncExtensionCarrier,
  type StoredSyncExtensionCarrier,
  type SyncExtensionLoadOptions,
  type SyncExtensionReceiptStore,
  type SyncExtensionRelayRequest,
  type SyncExtensionRelayResult,
  type SyncExtensionReplacement,
  type SyncExtensionResourceKey,
  type SyncExtensionStore,
  type SyncExtensionStoreWrite,
  type SyncExtensionStoreWriteResult,
  type SyncExtensionTransaction,
  type SyncExtensionTransformation,
  type SyncExtensionTransformationOptions,
  type SyncExtensionUnitOfWork,
} from './extension-relay.js';
