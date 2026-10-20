import type { CompactFault } from '../sync-compaction.js';

export type Environment = 'development' | 'staging' | 'production' | 'legacy';
export type Lifecycle = 'new' | 'active' | 'expired' | 'recovery_required' | 'retired';
export interface SyncScope {
  readonly environment: Environment; readonly serverId: string; readonly serverOrigin: string;
  readonly accountId: string; readonly browserProfileId: string; readonly collectionId: string;
  readonly replicaId: string; readonly generation: number;
}
export type FirstRunState = 'none' | 'deferred' | 'running' | 'completed';
export type ScopeMountMode = 'whole-profile' | 'mounted-folder';
export type BootstrapMode = 'download' | 'upload' | 'merge' | 'mirror';
export type ColpFolderRole = 'bookmarks-bar' | 'other-bookmarks' | 'mobile-bookmarks' | 'managed-bookmarks' | 'custom';
export type SpecialFolderRole = 'bookmarks-bar' | 'other-bookmarks' | 'mobile-bookmarks';
export type MountBindingStatus = 'pending' | 'active' | 'detached';
export type WritableScopeKind = 'active' | 'detached' | 'unmounted' | 'private_local' | 'pending' | 'unknown';
export type RangeTransitionAction =
  | 'native_move' | 'observe_only' | 'retain_local_copy' | 'materialize_independent' | 'await_dependency';
export type MountPauseCompleteness = 'complete' | 'unknown';
export type RemoteObservationKind = 'content' | 'placement' | 'tombstone';
export type ScopeCommandKind = 'detach' | 'rejoin' | 'remoteDelete' | 'rangeExit';
export type ScopeCommandPhase =
  | 'preview' | 'confirmed' | 'fetching' | 'comparing' | 'applying' | 'pending' | 'active' | 'failed';
export type LocalExclusionSourceKind = 'remote_delete' | 'range_exit';
export type RejoinCompareOutcome =
  | 'apply_remote' | 'queue_local_at_baseline_revision' | 'typed_merge' | 'conflict'
  | 'apply_delete_policy' | 'retain_local_edit' | 'baseline_unknown' | 'already_equal';
export interface RangeTransitionDecision {
  readonly action: RangeTransitionAction; readonly chromeMutation: boolean;
  readonly persistObservation: boolean; readonly persistExclusion: boolean;
  readonly preservePendingOperations: boolean;
}
export interface MountPauseBaseline {
  readonly generation: number; readonly boundaryVersion: string;
  readonly lastAppliedCursor: string | null; readonly completeness: MountPauseCompleteness;
}
export interface RemoteObservationRecord {
  readonly scopeKey: string; readonly colpId: string; readonly remoteRevision: string;
  readonly cursor: string; readonly kind: RemoteObservationKind; readonly payload: JsonObject;
  readonly sourceDigest: string; readonly observedAt: number;
  readonly pauseGeneration?: number; readonly pauseBoundaryVersion?: string;
  readonly pauseCursor?: string | null;
}
export interface ScopeCommandPlanRecord {
  readonly rejoinDecision?: JsonObject;
  readonly scopeKey: string; readonly commandId: string; readonly kind: ScopeCommandKind;
  readonly confirmationVersion: string; readonly baselineDigest: string | null;
  readonly phase: ScopeCommandPhase; readonly dependencies: readonly string[];
  readonly retryReason?: string; readonly mountId?: string; readonly updatedAt: number;
}
export type BootstrapRunPhase =
  | 'draft' | 'confirmed' | 'scanning' | 'matching' | 'syncing' | 'completed' | 'needs_attention';
export interface ScopeRecord extends SyncScope {
  readonly scopeKey: string; readonly lifecycle: Lifecycle;
  readonly lease: { readonly leaseId: string; readonly expiresAt: number; readonly generation?: string };
  readonly checkpoint: { readonly serverRevision: string; readonly cursor: string } | null;
  readonly selectedRoots: string[]; readonly privateRoots?: string[];
  readonly rootStatus?: 'ready' | 'nested_normalized' | 'root_missing' | 'permission_required' | 'tree_unavailable' | 'corrupt';
  readonly metadata?: JsonObject;
  readonly mountMode?: ScopeMountMode; readonly boundaryVersion?: string;
  readonly firstRun?: FirstRunState; readonly legacyCanonicalRoot?: string;
}
export interface QueueOperation {
  readonly scopeKey: string; readonly sequence: number; readonly opId: string; readonly batchId: string;
  readonly idempotencyKey: string; readonly digest: string; readonly endpointIdentity: 'syncPush';
  readonly mediaType: string; readonly baseRevision: string | null; readonly operationRevision: string;
  /**
   * `set_aside`: held out of the push lane because of one item's problem; never
   * sent, so it owns no server sequence. It is outstanding local work, not
   * settled history, and is recaptured as a fresh operation at the tail when the problem
   * clears (`releaseSetAsideQueue`).
   */
  readonly status: 'pending' | 'claimed' | 'deferred' | 'terminal' | 'gap' | 'blocked' | 'unknown' | 'rejected'
    | 'set_aside';
  readonly retry: { readonly attempt: number; readonly notBefore: number; readonly ownerId?: string;
    readonly fence?: number; readonly claimExpiresAt?: number };
  readonly recovery?: { readonly code: string; readonly expectedSequence?: number; readonly resultStatus?: 'rejected' };
  /** Set when the authoritative Pull echo for this opId has been applied. Survives pull-history prune. */
  readonly echoApplied?: true;
  readonly attempt?: { readonly sessionId: string; readonly batchId: string; readonly idempotencyKey: string;
    readonly endpointIdentity: 'syncPush'; readonly mediaType: 'application/json'; readonly body: string;
    readonly bodyDigest: string; readonly startedAt?: number; readonly requestedAt?: number;
    readonly serverBatchId?: string; readonly tracing?: { readonly traceId: string; readonly spanId?: string } };
  readonly payload: JsonObject;
}
type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject { readonly [key: string]: JsonValue }
export type UnknownRecord = Record<string, unknown>;
export interface ReceiptInput { readonly opId: string; readonly operationDigest: string; readonly kind: 'terminal' | 'deferred';
  readonly receiptId: string; readonly resultDigest: string; readonly result?: JsonObject }
export interface ReceiptRecord extends ReceiptInput { readonly scopeKey: string; readonly sequence: number }
export type PushSettlement = { readonly outcome: 'terminal' | 'deferred'; readonly receipt: ReceiptInput;
  readonly retry?: { readonly attempt: number; readonly notBefore: number };
  readonly authoritativeCreate?: { readonly nativeId: string; readonly targetId: string; readonly revision: string };
  readonly authoritativeProjection?: { readonly targetId: string; readonly revision: string;
    readonly content?: JsonObject } }
  | { readonly outcome: 'gap' | 'blocked'; readonly retry: { readonly attempt: number; readonly notBefore: number };
    readonly recovery: { readonly code: string; readonly expectedSequence?: number }; readonly receipt?: ReceiptInput }
  | { readonly outcome: 'rejected'; readonly recovery: { readonly code: string } }
  | { readonly outcome: 'unknown'; readonly retry: { readonly attempt: number; readonly notBefore: number };
    readonly recovery?: { readonly code: string }; readonly clearAttempt?: true };
export interface LeaseRecord { readonly scopeKey: string; readonly ownerId: string; readonly fence: number; readonly expiresAt: number }
export type PullApplyState = 'staged' | 'intent_prepared' | 'browser_call_started' | 'native_event_observed'
  | 'awaiting_confirmation' | 'authority_committed' | 'page_complete' | 'blocked';
export type NativeCallResult =
  | 'not_started' | 'applied_with_evidence' | 'absent' | 'result_unknown' | 'waiting_dependency' | 'failed';
export type PersistedNativeCallResult = NativeCallResult | 'unknown';
export type IntentReplayState = 'unknown' | 'not_started' | 'started' | 'awaiting_receipt' | 'committed';
export type IntentLiveWorkKind = 'create' | 'restore' | 'move' | 'delete' | 'rejoin' | 'unknown';
export type NativeResultConfirmationKind =
  | 'unknown' | 'api_return' | 'candidate_event' | 'absent' | 'failed';
export interface NativeResultConfirmation {
  readonly kind: NativeResultConfirmationKind; readonly nativeId?: string; readonly code?: string;
}
export type RemoteDeletePolicy = 'sync' | 'confirm' | 'keep_local';
export type RemoteDeleteDecisionState =
  | 'pending' | 'applying' | 'applied' | 'keep_local' | 'restoring' | 'restored' | 'rejected';
export type RemoteDeleteAction = 'apply' | 'restore' | 'keep_local';
export interface NativeWaitDecision {
  readonly action: 'bind' | 'keep_local_and_create' | 'cancel'; readonly waitRef: string;
}
export interface IntentRecord { readonly scopeKey: string; readonly intentId: string; readonly correlationId: string; readonly suspendedCorrelationId?: string;
  readonly operationId: string; readonly expected: { readonly kind: string; readonly nativeId: string };
  readonly expiresAt: number; readonly state?: PullApplyState; readonly eventId?: string; readonly effectId?: string;
  readonly preStateDigest?: string; readonly expectedPostState?: JsonObject; readonly nativeTargetId?: string | null;
  readonly nativeParentId?: string | null; readonly anchors?: JsonObject; readonly apiPhase?: string;
  readonly nativeEventEvidence?: JsonObject | null; readonly apiResultEvidence?: JsonObject | null;
  readonly generation?: number; readonly nativeResult?: PersistedNativeCallResult;
  readonly nativeWaitDecision?: NativeWaitDecision;
  readonly waitReason?: string; readonly nativeResultConfirmation?: NativeResultConfirmation;
  readonly repairJobId?: string; readonly replayState?: IntentReplayState;
  readonly commandId?: string; readonly colpId?: string; readonly substep?: string;
  readonly liveWorkKind?: IntentLiveWorkKind }
export interface PullPageInput { readonly pageId: string; readonly previousCursor: string; readonly nextCursor: string;
  readonly collectionRevision: string; readonly pageDigest: string; readonly events: readonly PullEventInput[];
  readonly effectPages?: readonly EffectPageInput[] }
export interface PullEventInput { readonly eventId: string; readonly cursor: string; readonly operationId: string;
  readonly effectId: string; readonly effectDigest: string; readonly operationDigest: string; readonly kind: string;
  readonly payload: JsonObject; readonly initialState?: 'staged' | 'authority_committed' }
export interface EffectPageInput { readonly eventId: string; readonly effectId: string; readonly pageNumber: number;
  readonly pageDigest: string; readonly previousPageDigest: string | null; readonly payload: JsonObject }
export interface EffectPageDownloadRecord {
  readonly effectId: string; readonly pageCount: number; readonly nextPageNumber: number;
  readonly lastDigest: string | null; readonly remainingBytes: number; readonly remainingMembers: number;
  readonly retryNotBefore: number; readonly pages: readonly JsonValue[];
}
export interface RecoveryHeader { readonly scopeKey: string; readonly snapshotId: string; readonly sessionId: string | null;
  readonly revision: string;
  readonly syncCursor: string; readonly capability?: string; readonly identityDigest: string; readonly rootNodeId: string;
  readonly lastPage: number; readonly lastPageDigest: string; readonly nextCursor: string | null;
  readonly complete: boolean; readonly materializationVersion?: string }
export interface RecoveryNodeRecord { readonly scopeKey: string; readonly snapshotId: string; readonly page: number;
  readonly colpId: string; readonly parentId: string | null; readonly position: string;
  readonly kind: 'Folder' | 'Bookmark' | 'Separator'; readonly payloadDigest: string; readonly mapping: MappingInput;
  readonly snapshotChildrenRevision?: string }
export type SyncEnginePhase = 'idle' | 'session' | 'bootstrap' | 'pulling' | 'applying' | 'acking' | 'pushing'
  | 'sleeping' | 'offline' | 'recovery' | 'retired' | 'error';
export interface DurableSyncEngineState {
  readonly scopeKey: string; readonly phase: SyncEnginePhase; readonly revision: number; readonly updatedAt: number;
  readonly sessionId?: string; readonly recoveryFrozen: boolean; readonly authorityRefreshRequired: boolean;
  readonly notBefore: number;
  readonly localProjectionOwner?: number;
  readonly connectivityConfirmationRevision?: number;
  readonly lastPublishedCursor?: string; readonly lastAckedCursor?: string;
  // F023: Push receipts carry their server cursor in a dedicated field so the
  // Pull/Ack convergence pair (lastPublishedCursor/lastAckedCursor) stays honest.
  // Non-cursor sentinels ('repair', 'sync-unchanged') land in lastPushOutcomeHint.
  readonly lastPushServerCursor?: string; readonly lastPushOutcomeHint?: string;
  // SYNC-F001: consecutive network-failure count, independent of `revision`.
  // The engine revision increments on EVERY transition (several per healthy
  // wake), so it is not a failure counter: an exponential backoff keyed on it
  // never starts near 1s and never resets on success. This field is bumped
  // only by offline()/recovery network failures and cleared at the first
  // successful pull/ack/sleep after a streak.
  readonly circuitBreaker?: import('../sync-circuit-breaker.js').SyncCircuitBreaker;
  readonly networkBackoffCount?: number;
  readonly lastError?: string;
}
export interface AckIntentRecord {
  readonly scopeKey: string; readonly intentId: string; readonly kind: 'pull' | 'bootstrap';
  readonly sessionId: string; readonly cursor: string; readonly idempotencyKey: string;
  readonly endpointIdentity: 'syncAck'; readonly mediaType: 'application/json'; readonly body: string;
  readonly bodyDigest: string; readonly state: 'pending' | 'complete'; readonly result?: JsonObject;
}
export interface LeaseResult { readonly outcome: 'acquired' | 'contended'; readonly ownerId: string; readonly fence: number;
  readonly expiresAt?: number }
export interface LegacyState extends SyncScope { readonly nextSequence: number; readonly cursor: string;
  readonly queuedOperation: { readonly sequence: number; readonly opId: string; readonly eventId: string; readonly digest: string;
    readonly acknowledged?: boolean };
  readonly receipt: { readonly sequence: number; readonly opId: string; readonly digest: string; readonly receiptId: string;
    readonly publishedCursor: string }; readonly nativeMapping: { readonly nativeId: string; readonly colpId: string };
  readonly applyIntent: { readonly intentId: string; readonly correlationId: string; readonly status: string;
    readonly expectedMutation: string } }
export interface MappingInput { readonly nativeId: string; readonly colpId: string; readonly rootNativeId: string;
  readonly nodeKind?: 'folder' | 'bookmark' | 'separator'; readonly parentNativeId?: string; readonly parentColpId?: string;
  readonly mountId?: string; readonly rootRole?: ColpFolderRole;
  /** Remote identity only: no native application or content baseline is claimed. */
  readonly quarantine?: { readonly code: string; readonly snapshotId: string; readonly payloadDigest: string };
  readonly projection: { readonly revision: string; readonly resourceRevision?: string;
    readonly childrenRevision?: string | null; readonly digest: string; readonly contentDigest?: string;
    readonly childrenOrder?: readonly string[];
    readonly content?: JsonObject } }
export interface BindMountMappingInput {
  readonly nativeId: string; readonly colpId: string; readonly mountId: string;
  readonly rootRole?: ColpFolderRole; readonly revision: string;
}
export interface MountBindingRecord {
  readonly scopeKey: string; readonly mountId: string; readonly nativeRootId: string;
  readonly remoteMountNodeId: string | null; readonly boundaryVersion: string;
  readonly materialized: boolean; readonly status: MountBindingStatus;
  readonly rootRole?: SpecialFolderRole; readonly customSourceKey?: string;
  readonly lastReconcile?: { readonly treeDigest: string; readonly at: number };
  readonly pendingRemoteDelete?: { readonly confirmation: string; readonly affectedCount: number;
    readonly opId?: string };
  readonly pendingShift?: { readonly colpId: string; readonly fromParentNativeId?: string;
    readonly toParentNativeId?: string };
  readonly pauseBaseline?: MountPauseBaseline;
}
export interface ScopePreviewRecord {
  readonly scopeKey: string; readonly previewId: string; readonly boundaryVersion: string;
  readonly treeDigest: string; readonly bookmarkCount: number; readonly folderCount: number;
  readonly skippedCount: number; readonly expiresAt: number;
  readonly warnings: readonly { readonly code: string }[];
  readonly boundary: { readonly selectedNativeIds: readonly string[];
    readonly excludedNativeIds: readonly string[];
    readonly mounts: readonly { readonly nativeRootId: string; readonly rootRole?: SpecialFolderRole;
      readonly customSourceKey?: string; readonly materialized: boolean; readonly writable: boolean }[] };
  readonly kind?: 'range'; readonly consumedAt?: number; readonly consumedBy?: string; readonly boundaryDigest?: string;
  readonly addedNativeIds?: readonly string[]; readonly removedNativeIds?: readonly string[];
  readonly privateNativeIds?: readonly string[]; readonly shiftNativeIds?: readonly string[];
  readonly remoteDeleteEvidence?: readonly RemoteDeleteFreezeEntry[];
}
export interface RemoteDeleteFreezeEntry {
  readonly nativeRootId: string; readonly mountId: string; readonly remoteMountNodeId: string;
  readonly affectedCount: number; readonly boundaryVersion: string;
  readonly subtreeSource?: JsonObject;
  /** Role folders survive; only these frozen direct children enter trash. */
  readonly contentDeletes?: readonly { readonly targetId: string; readonly kind: 'folder' | 'bookmark' | 'separator';
    readonly baseRevision: string; readonly source: JsonObject }[];
}
export interface BootstrapRunRecord {
  readonly scopeKey: string; readonly runId: string; readonly phase: BootstrapRunPhase;
  readonly bootstrapMode: BootstrapMode; readonly confirmationId: string; readonly updatedAt: number;
  readonly reportDigest?: string; readonly snapshotCursor?: string; readonly resumeCursor?: string;
  readonly confirmationVersion?: string; readonly previewId?: string; readonly treeDigest?: string;
  readonly libraryId?: string; readonly retryReason?: string; readonly mountResolveRequest?: string;
  readonly previewOnly?: boolean; readonly destructiveConfirmed?: boolean;
  readonly attention?: BootstrapAttentionReport;
}
export interface BootstrapAttentionItem {
  readonly parentRefs?: readonly string[];
  readonly evidenceDigest?: string;
  readonly resolutionOpIds?: readonly string[];
  readonly nodeRefs?: readonly string[];
  readonly itemId: string; readonly kind: 'duplicate_candidate' | 'local_difference' | 'conflict';
  readonly locationCount: number; readonly decision: 'open' | 'keep_both';
}
export interface BootstrapAttentionReport {
  readonly pageCount?: number;
  readonly reportId: string; readonly version: 1;
  readonly candidateCount: number; readonly conflictCount: number;
  readonly localOnlyCount: number; readonly remoteOnlyCount: number; readonly matchedCount: number;
  readonly items: readonly BootstrapAttentionItem[]; readonly createdAt: number;
}
export interface DeletionJournalRecord {
  readonly scopeKey: string; readonly nativeId: string; readonly ordinal: number;
  readonly kind: 'folder' | 'bookmark' | 'separator'; readonly parentNativeId?: string;
  readonly position?: number; readonly mountId?: string; readonly contentDigest?: string;
}
export type ScopeDetachCommand = { readonly kind: 'detach'; readonly mountId: string };
export type ScopeRejoinCommand = { readonly kind: 'rejoin'; readonly mountId: string };
export type ScopeRemoteDeleteCommand = { readonly kind: 'remoteDelete'; readonly mountId: string;
  readonly confirmationToken: string; readonly affectedCount: number };
export type ScopeRangeCommand = { readonly kind: 'addRange'; readonly nativeIds: readonly string[] }
  | { readonly kind: 'removeRange'; readonly mountId: string };
export type ScopeDurableCommand = ScopeDetachCommand | ScopeRejoinCommand | ScopeRemoteDeleteCommand | ScopeRangeCommand;
export interface BookmarkEventInput { readonly eventId: string; readonly dedupeKey: string;
  readonly occurredAt: string; readonly kind: 'create' | 'change' | 'move' | 'remove'; readonly nativeId: string;
  readonly details: JsonObject }
export interface BookmarkEventRecord extends BookmarkEventInput { readonly scopeKey: string; readonly ordinal: number;
  readonly status: 'pending' | 'processed'; readonly opId: string | null }
/**
 * F003: a pending inbox event that cannot be prepared (its dependency was
 * permanently refused, or its durable draft is not a
 * protocol operation) is quarantined instead of blocking the events behind it.
 * The event row itself is preserved unchanged; the quarantine is a durable,
 * bounded marker keyed by the event id, carrying the reason and the number of
 * consecutive failed prepare rounds. `open` means the event is tracked but
 * still retried; `parked` means it is isolated until its recorded dependency
 * stamp changes (its dependency converged) or forever when there is no
 * dependency to wait for (a deterministic terminal failure).
 */
export type BookmarkEventParkState = 'open' | 'parked';
export interface BookmarkEventParkMarker {
  readonly eventId: string; readonly state: BookmarkEventParkState; readonly code: string;
  readonly attempts: number; readonly at: string; readonly reason?: string;
  readonly dependencyNativeId?: string; readonly dependencyOpId?: string; readonly dependencyEventId?: string;
  readonly dependencyStamp?: string }
export interface CommitBookmarkEventInput {
  readonly operation: JsonObject; readonly baseRevision: string | null; readonly operationRevision: string;
  readonly validateOperation: (operation: JsonObject) => boolean; readonly digestOperation: (operation: JsonObject) => string;
  readonly allocateOperationId: () => string;
  readonly mapping?: MappingInput; readonly deleteNativeIds?: readonly string[];
}
export interface RecoveryPageInput { readonly snapshotId: string; readonly sessionId?: string;
  readonly revision: string; readonly syncCursor: string; readonly capability?: string;
  readonly materializationVersion?: string;
  readonly identityDigest: string; readonly rootNodeId: string;
  readonly page: number; readonly pageDigest: string; readonly previousPageDigest: string | null;
  readonly nextCursor: string | null; readonly complete: boolean; readonly nodes: ReadonlyArray<{
    readonly colpId: string; readonly parentId: string | null; readonly position: string;
    readonly kind: 'Folder' | 'Bookmark' | 'Separator'; readonly payloadDigest: string; readonly mapping?: MappingInput;
  }> }
export interface StoreOptions { readonly indexedDB?: IDBFactory; readonly maxRecordBytes?: number;
  readonly onBlocked?: (event: Event) => void; readonly injectUpgradeFailure?: boolean }
export interface FaultOptions { readonly fault?: 'after_sequence' | 'after_queue' | 'after_receipt' | 'after_cursor'
  | 'after_mapping' | 'after_event' | 'quota' | 'unknown_commit' | CompactFault }

export class SyncStateError extends Error {
  constructor(readonly code: string, message = code) { super(message); this.name = 'SyncStateError'; }
}

export interface DiscoveredRoot { readonly nativeId: string; readonly ancestorNativeIds: readonly string[] }
export interface ConfigureBrowserRootsInput { readonly discovered: readonly DiscoveredRoot[];
  readonly selectedNativeIds: readonly string[]; readonly privateNativeIds: readonly string[];
  readonly expectedBoundaryVersion?: string;
  readonly status: 'ready' | 'permission_required' | 'tree_unavailable' | 'corrupt' }
export interface BrowserRootAuthority {
  readonly selectedRoots: readonly string[]; readonly privateRoots: readonly string[];
  readonly rootStatus: NonNullable<ScopeRecord['rootStatus']>;
}

export type ImportRecoveryCode = 'conflict' | 'session_expired' | 'permission_required' | 'push_rejected';
export interface ImportPlanRecord {
  readonly scopeKey: string; readonly planId: string; readonly conversionDigest: string;
  readonly sourceProfile: 'netscape-bookmarks-v1' | 'chromium-bookmarks-v1'; readonly sourceIdentity: string;
  readonly choiceDigest: string; readonly state: 'active' | 'paused' | 'complete' | 'attention';
  readonly createdAt: number; readonly updatedAt: number;
}
export interface ImportNodeRecord {
  readonly scopeKey: string; readonly planId: string; readonly sourceNodeId: string; readonly order: number;
  readonly parentSourceNodeId: string | null; readonly opId: string; readonly choice: 'import' | 'skip';
  readonly status: 'staged' | 'skipped' | 'queued' | 'terminal' | 'recoverable'; readonly sequence?: number;
  readonly recovery?: ImportRecoveryCode; readonly target?: { readonly nativeId: string; readonly colpId: string;
    readonly revision: string }; readonly authoritativeTarget?: { readonly colpId: string; readonly revision: string };
  readonly node: JsonObject;
}
export interface CommitImportPlanInput { readonly plan: Omit<ImportPlanRecord, 'scopeKey'>;
  readonly nodes: readonly Omit<ImportNodeRecord, 'scopeKey'>[] }
export interface EnqueueImportNodeInput { readonly planId: string; readonly sourceNodeId: string;
  readonly occurredAt: string; readonly parent: { readonly nativeId: string; readonly colpId: string };
  readonly operation: JsonObject; readonly nativeId: string;
  readonly validateOperation: (operation: JsonObject) => boolean; readonly digestOperation: (operation: JsonObject) => string }
