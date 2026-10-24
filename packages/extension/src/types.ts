export type Environment = 'development' | 'staging' | 'production';

export interface BuildConfig {
  readonly environment: Environment;
  readonly deploymentId?: string;
  readonly extensionId: string;
  readonly subscriptionBridgeOrigins?: readonly { readonly webOrigin: string; readonly serverOrigin: string }[];
  readonly serverOrigin: string;
  readonly manifestUrl: string;
  readonly issuer: string;
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly jwksUri: string;
  readonly revocationEndpoint: string;
  readonly clientId: string;
  readonly audience: string;
  readonly scopes: readonly string[];
  readonly allowedAlgorithms: readonly string[];
  readonly refreshBeforeExpirySeconds: number;
}

export interface OAuthTransaction {
  readonly id: string;
  readonly state: string;
  readonly nonce: string;
  readonly verifier: string;
  readonly redirectUri: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly callbackUrl?: string;
}

export interface StoredCredential {
  readonly accessToken: string;
  readonly refreshToken?: string;
  readonly tokenType: 'Bearer';
  readonly expiresAt: number;
  readonly scope: readonly string[];
  readonly issuer: string;
  readonly audience: string;
  readonly clientId: string;
  readonly serverOrigin: string;
  readonly subject?: string;
  readonly accountLabel?: string;
  readonly avatarUrl?: string;
}

export interface StoredSession {
  readonly maxBatchOperations?: number;
  readonly sessionId: string;
  readonly credentialAuthorityDigest: string;
  readonly expiresAt: string;
  readonly scope: 'collection';
  readonly collection: { readonly collectionId: string; readonly serverCursor: string; readonly serverRevision: string };
  readonly replicaLease: { readonly leaseId: string; readonly generation: string; readonly state: 'active';
    readonly expiresAt: string; readonly acknowledgedCursor?: string | null };
  readonly acceptedProtocolVersion?: '0.2';
  readonly snapshotRequired: boolean;
  readonly conversionPolicy?: { readonly separator: 'native' | 'omit' | 'preserve_remote' | 'reject' };
  readonly transportBudget?: {
    readonly pullResponseBytes: number;
    readonly snapshotPageBytes: number;
    readonly effectPageBytes: number;
    readonly effectAggregateBytes: number;
  };
}

export interface StoredAuthBinding {
  readonly replicaId: string;
  readonly browserProfileId: string;
  readonly generation: string;
}

export type UiStatus = 'signed_out' | 'connecting' | 'connected' | 'refreshing' | 'offline'
  | 'policy_blocked' | 'error';

export interface PublicAuthState {
  readonly status: UiStatus;
  readonly environment: Environment;
  readonly serverOrigin: string;
  readonly accountLabel?: string;
  readonly avatarUrl?: string;
  readonly sessionExpiresAt?: string;
  readonly errorCode?: string;
}

export interface PublicSyncEngineState {
  readonly phase: 'idle' | 'session' | 'bootstrap' | 'pulling' | 'applying' | 'acking' | 'pushing'
    | 'sleeping' | 'offline' | 'recovery' | 'retired' | 'error';
  readonly scopeKey?: string;
  readonly recoveryFrozen: boolean; readonly authorityRefreshRequired: boolean;
  readonly cooldownPending: boolean; readonly engineWakeInFlight: boolean; readonly authorityRefreshInFlight: boolean;
  readonly credentialReady: boolean; readonly sessionReady: boolean; readonly hasPendingWork: boolean;
  /** A conflicted push is waiting for the server's resolution to arrive through Pull. */
  readonly conflictPending: boolean;
  readonly rejectedPending: boolean;
  readonly queueProjection: 'idle' | 'syncing' | 'conflict' | 'rejected';
  readonly hasPublishedCursor: boolean; readonly cursorsConverged: boolean; readonly errorCode?: string;
  readonly nativeWaitPending?: boolean;
  readonly listenerInstalled: boolean; readonly eventObserved: number; readonly eventAccepted: number;
  readonly eventRejected: number; readonly eventRejectedReason?: 'filtered' | 'permission_required' | 'not_connected'
    | 'recovery_frozen' | 'queue_unavailable' | 'capture_failed';
  readonly captureFailureCode?: 'operation_schema_invalid' | 'operation_byte_budget_exceeded'
    | 'exact_retry_pending' | 'sequence_missing' | 'scope_missing' | 'queue_recovery_frozen'
    | 'bookmark_event_not_found' | 'bookmark_event_operation_missing' | 'bookmark_event_queue_missing'
    | 'constraint' | 'database_unavailable' | 'privacy_evaluation_failed' | 'parent_identity_failed'
    | 'apply_intent_failed' | 'relative_placement_failed' | 'children_lookup_failed' | 'sibling_identity_failed'
    | 'bookmark_event_stage_failed'
    | 'unknown_capture_failure';
}

export type PublicRootStatus = 'ready' | 'nested_normalized' | 'root_missing' | 'permission_required'
  | 'tree_unavailable' | 'corrupt';
export interface PublicRootNode {
  readonly ref: string;
  readonly title: string;
  readonly kind: 'bookmarks_bar' | 'other' | 'mobile' | 'folder';
  readonly depth: number;
  readonly selected: boolean;
  readonly privateLocal: boolean;
  readonly managed: boolean;
  readonly bookmarkCount: number;
  readonly folderCount: number;
  readonly exclusionReason?: 'managed';
  /* R13 D-21: the folder the popup deep-linked for sync setup — arrives
     checked so the options page only needs a confirm. */
  readonly preselected?: true;
}
export interface PublicRootView {
  readonly viewId: string;
  readonly status: PublicRootStatus;
  readonly roots: readonly PublicRootNode[];
}

export type ExtensionRequest = { readonly kind: 'known.auth.status' }
  | { readonly kind: 'known.auth.send-otp'; readonly userGesture: true; readonly email: string }
  | { readonly kind: 'known.auth.login'; readonly userGesture: true; readonly method: 'password';
    readonly email: string; readonly password: string }
  | { readonly kind: 'known.auth.login'; readonly userGesture: true; readonly method: 'otp';
    readonly email: string; readonly otp: string }
  | { readonly kind: 'known.auth.login'; readonly userGesture: true; readonly method: 'oauth';
    readonly provider: 'google' | 'github' }
  | { readonly kind: 'known.auth.refresh' }
  | { readonly kind: 'known.auth.logout'; readonly userGesture: true }
  | { readonly kind: 'known.server.disconnect'; readonly userGesture: true; readonly nextOrigin?: string }
  | BookmarkPreferencesRequest
  | FirstRunRequest
  | ScopeCommandRequest;

export type AuthExtensionRequest = Exclude<ExtensionRequest, FirstRunRequest | ScopeCommandRequest>;

export type BookmarkPreferencesRequest =
  | { readonly kind: 'known.bookmark.preferences.get' }
  | { readonly kind: 'known.bookmark.preferences.local' }
  | { readonly kind: 'known.bookmark.preferences.update'; readonly userGesture: true;
    readonly bookmarkInsertPosition?: import('./bookmark-preferences.js').BookmarkInsertPosition;
    readonly foldersFirst?: boolean;
    readonly captureMode?: 'manual' | 'automatic';
    readonly resultPanelAutoDismissMs?: number;
    readonly learnFromCorrections?: boolean;
    readonly resumeClassificationWhenOnline?: boolean;
    readonly aiTagMode?: import('./bookmark-preferences.js').AiTagMode;
    readonly subscriptionOnUnfollow?: 'keep' | 'remove';
    readonly subscriptionOnUnsubscribe?: 'keep' | 'remove';
    readonly subscriptionDefaultCheckIntervalMinutes?: 5 | 15 | 60 | null;
    readonly subscriptionDefaultDigestMode?: 'latest' | 'recent';
    readonly subscriptionDefaultEditionLimit?: number;
  }
  | { readonly kind: 'known.bookmark.preferences.resolve'; readonly userGesture: true; readonly choice: 'server' | 'local' };

export type BookmarkPreferencesResponse =
  | { readonly ok: true; readonly preferences: import('./bookmark-preferences.js').BookmarkPreferences;
    readonly scope: 'account' | 'device'; readonly source: 'cache' | 'server' | 'default';
    readonly revision: string; readonly etag: string; readonly pending: boolean; readonly conflict: boolean;
    readonly accountDefaults?: import('./bookmark-preferences.js').BookmarkPreferences;
    readonly conflictValues?: { readonly local: import('./bookmark-preferences.js').BookmarkPreferences; readonly remote: import('./bookmark-preferences.js').BookmarkPreferences } }
  | { readonly ok: false; readonly error: 'not_connected' | 'offline' | 'conflict' | 'preferences_unavailable' };

export type FirstRunDurablePhase =
  | 'draft' | 'confirmed' | 'scanning' | 'matching' | 'syncing' | 'completed' | 'needs_attention';
export type FirstRunScopeState = 'none' | 'deferred' | 'running' | 'completed';

export type FirstRunPreviewRequest = {
  readonly kind: 'known.firstRun.preview';
  readonly viewId: string;
  readonly selectedRefs: readonly string[];
  readonly excludedRefs: readonly string[];
  readonly bootstrapMode?: 'download' | 'upload' | 'merge' | 'mirror';
};
export type AdvancedFirstRunConfirmation = {
  readonly scopeFingerprint: string; readonly treeDigest: string;
  readonly mode: 'download' | 'upload' | 'mirror'; readonly remoteSnapshotId: string;
  readonly remoteRevision: string; readonly remoteCursor: string; readonly destructivePlanDigest: string;
  readonly confirmationProof: string;
};
export type FirstRunConfirmRequest = {
  readonly kind: 'known.firstRun.confirm';
  readonly previewId: string;
  readonly confirmationId: string;
  readonly bootstrapMode?: 'download' | 'upload' | 'merge' | 'mirror';
  readonly advancedConfirmation?: AdvancedFirstRunConfirmation;
  readonly libraryId: string;
};
export type FirstRunStatusRequest = { readonly kind: 'known.firstRun.status' };
export type FirstRunLaterRequest = { readonly kind: 'known.firstRun.later' };
export type FirstRunAttentionGetRequest = {
  readonly kind: 'known.firstRun.attention.get'; readonly reportId: string; readonly cursor?: string;
};
export type FirstRunAttentionDecideRequest = {
  readonly kind: 'known.firstRun.attention.decide'; readonly reportId: string; readonly itemId: string;
  readonly decision: 'keep_both' | 'keep_local'; readonly evidenceDigest?: string;
};
export type FirstRunRequest =
  | FirstRunPreviewRequest
  | FirstRunConfirmRequest
  | FirstRunStatusRequest
  | FirstRunLaterRequest
  | FirstRunAttentionGetRequest
  | FirstRunAttentionDecideRequest;
export type PublicAttentionSummary = {
  readonly reportId: string; readonly candidateCount: number; readonly conflictCount: number;
  readonly pendingCount: number;
};
export type PublicAttentionItem = {
  readonly parentLabels?: readonly string[];
  readonly evidenceDigest?: string; readonly resolutionPending?: boolean; readonly resolutionError?: string;
  readonly label?: string;
  readonly itemId: string; readonly kind: 'duplicate_candidate' | 'local_difference' | 'conflict';
  readonly locationCount: number; readonly decision: 'open' | 'keep_both';
};

export type ScopeDetachRequest = { readonly kind: 'known.scope.detach'; readonly mountId: string };
export type ScopeRejoinRequest = { readonly kind: 'known.scope.rejoin'; readonly mountId: string };
export type ScopeRemoteDeleteRequest = {
  readonly kind: 'known.scope.remoteDelete';
  readonly mountId: string;
  readonly confirmationToken: string;
  readonly affectedCount: number;
};
export type ScopeCommandRequest = ScopeDetachRequest | ScopeRejoinRequest | ScopeRemoteDeleteRequest;

export type RemoteDeletePolicyName = 'sync' | 'confirm' | 'keep_local';
export type RemoteDeleteItemAction = 'apply' | 'restore' | 'keep_local';
export type RemoteDeletePolicyGetRequest = { readonly kind: 'known.remoteDelete.policy.get' };
export type RemoteDeletePolicySetRequest = {
  readonly kind: 'known.remoteDelete.policy.set'; readonly policy: RemoteDeletePolicyName;
  readonly expectedCasVersion: number; readonly userGesture: true;
};
export type RemoteDeletePendingListRequest = { readonly kind: 'known.remoteDelete.pending.list' };
export type RemoteDeleteDecideRequest = {
  readonly kind: 'known.remoteDelete.decide'; readonly decisionId: string;
  readonly action: RemoteDeleteItemAction; readonly expectedCasVersion: number;
  readonly deleteRevision: string; readonly userGesture: true;
};
export type RemoteDeleteRequest =
  | RemoteDeletePolicyGetRequest | RemoteDeletePolicySetRequest
  | RemoteDeletePendingListRequest | RemoteDeleteDecideRequest;
export type PublicRemoteDeleteItem = {
  readonly decisionId: string; readonly title: string; readonly kind: 'folder' | 'bookmark' | 'separator';
  readonly state: string; readonly casVersion: number; readonly deleteRevision: string;
};
export type RemoteDeleteResponse =
  | { readonly ok: true; readonly policy: RemoteDeletePolicyName; readonly casVersion: number;
    readonly pendingCount: number; readonly pending: readonly PublicRemoteDeleteItem[];
    readonly conflictPending: boolean; readonly conflictHref: string }
  | { readonly ok: false; readonly error: string };

/**
 * S1 / B0-1: the product exit for `native_result_unknown`. The projection is a
 * JSON-safe view of `NativeWaitProjection`; the confirm message echoes the same
 * waitRef + generation the durable intent CAS checks against.
 */
export type NativeWaitListRequest = { readonly kind: 'known.nativeWait.list' };
export type NativeWaitConfirmAction = 'bind' | 'keep_local_and_create' | 'cancel';
export type NativeWaitConfirmRequest = {
  readonly kind: 'known.nativeWait.confirm';
  readonly userGesture: true;
  readonly waitRef: string;
  readonly intentId: string;
  readonly generation: number;
  readonly action: NativeWaitConfirmAction;
  readonly nativeId?: string;
};
export type NativeWaitRequest = NativeWaitListRequest | NativeWaitConfirmRequest;
export type PublicNativeWaitCandidate = {
  readonly nativeId: string; readonly title?: string; readonly url?: string;
};
export type PublicNativeWait = {
  readonly waitRef: string;
  readonly intentId: string;
  readonly colpId: string;
  readonly title?: string;
  readonly url?: string;
  readonly waitReason: 'native_result_unknown' | 'waiting_dependency';
  readonly candidates: readonly PublicNativeWaitCandidate[];
  readonly affectedRange: { readonly parentNativeId: string };
  /** Freshness CAS the confirm message must echo back (durable intent generation). */
  readonly generation: number;
};
export type NativeWaitListResponse = { readonly ok: true; readonly waits: readonly PublicNativeWait[] };
export type NativeWaitConfirmResult = 'bound' | 'kept_local' | 'cancelled' | 'duplicate';
export type NativeWaitConfirmResponse = {
  readonly ok: true; readonly result: NativeWaitConfirmResult; readonly nativeId?: string;
};
export type NativeWaitResponse =
  | NativeWaitListResponse
  | NativeWaitConfirmResponse
  | { readonly ok: false; readonly code: string };

export type FirstRunPreviewOk = {
  readonly ok: true;
  readonly previewId: string;
  readonly boundaryVersion: string;
  readonly treeDigest: string;
  readonly bookmarkCount: number;
  readonly folderCount: number;
  readonly skippedCount: number;
  readonly warnings: readonly { readonly code: string }[];
  readonly report?: { readonly matched: number; readonly localOnly: number; readonly remoteOnly: number;
    readonly candidates: number; readonly conflicts: number };
  readonly advanced?: AdvancedFirstRunConfirmation & {
    readonly deletes: readonly {
      readonly targetId: string; readonly side: 'local' | 'remote'; readonly nativeId?: string;
      readonly kind?: 'folder' | 'bookmark' | 'separator'; readonly title?: string; readonly url?: string;
      readonly parentId?: string | null; readonly baseRevision?: string;
    }[];
  };
};
export type FirstRunConfirmStale = {
  readonly ok: false;
  readonly error: 'preview_stale';
  readonly bookmarkCount: number;
  readonly folderCount: number;
  readonly skippedCount: number;
};
export type FirstRunOrScopeResponse =
  | FirstRunPreviewOk
  | { readonly ok: true; readonly phase: FirstRunDurablePhase; readonly firstRun: FirstRunScopeState;
    readonly attention?: PublicAttentionSummary;
    readonly items?: readonly PublicAttentionItem[]; readonly nextCursor?: string;
    readonly conflictHref?: string }
  | FirstRunConfirmStale
  | { readonly ok: false; readonly error: string };

export type RootRequest = { readonly kind: 'known.roots.get'; readonly preselectFolderId?: string }
  | { readonly kind: 'known.roots.update'; readonly viewId: string; readonly selectedRefs: readonly string[];
    readonly privateRefs: readonly string[] }
  | { readonly kind: 'known.roots.preview'; readonly viewId: string; readonly selectedRefs: readonly string[];
    readonly privateRefs: readonly string[] }
  | { readonly kind: 'known.roots.confirm'; readonly previewId: string; readonly confirmationId: string;
    readonly treeDigest: string; readonly shiftActions?: readonly PublicRangeShiftAction[];
    readonly remoteDeleteRefs?: readonly string[] }
  | { readonly kind: 'known.roots.permissionChanged'; readonly userGesture: true; readonly granted: boolean }
  | { readonly kind: 'known.roots.boundaries' };
export interface PublicRootBoundaries {
  readonly selected: readonly string[];
  readonly privateLocal: readonly string[];
}
export type PublicRangeShiftAction = { readonly ref: string; readonly action: 'keep' | 'unmount' };
export interface PublicRangeChangeRow {
  readonly ref: string;
  readonly title: string;
  readonly bookmarkCount: number;
  readonly folderCount: number;
  readonly affectedCount: number;
}
export interface PublicRangePreview {
  readonly previewId: string;
  readonly boundaryVersion: string;
  readonly treeDigest: string;
  readonly bookmarkCount: number;
  readonly folderCount: number;
  readonly skippedCount: number;
  /** Newly covered folders, including descendants, rather than newly selected mount roots. */
  readonly addedCount: number;
  readonly addedBookmarkCount: number;
  readonly additions: readonly { readonly ref: string; readonly title: string; readonly path: string;
    readonly bookmarkCount: number }[];
  readonly removedCount: number;
  readonly shiftCount: number;
  readonly expiresAt: number;
  readonly warnings: readonly { readonly code: string }[];
  readonly shifts: readonly PublicRangeChangeRow[];
  readonly removals: readonly PublicRangeChangeRow[];
}
export type RootResponse = { readonly ok: true; readonly view: PublicRootView }
  | { readonly ok: true; readonly preview: PublicRangePreview }
  | { readonly ok: true; readonly boundaries: PublicRootBoundaries }
  | { readonly ok: false; readonly error: PublicRootStatus | 'not_connected' | 'request_invalid' | 'root_update_failed'
    | 'permission_required' | 'preview_stale' | 'duplicate_confirm' | 'sync_paused' | 'sync_busy' };

export type ExtensionResponse = { readonly ok: true; readonly state: PublicAuthState }
  | { readonly ok: false; readonly state: PublicAuthState; readonly error: string };
export type SyncEngineRequest = { readonly kind: 'known.sync.engine.status' };
export type SyncRetryRequest = { readonly kind: 'known.sync.engine.retry' };
export type ConnectivityRequest = { readonly kind: 'known.connectivity.online' };
export type SyncEngineResponse = { readonly ok: true; readonly engine: PublicSyncEngineState }
  | { readonly ok: false; readonly error: 'not_connected' | 'state_unavailable' };

/**
 * FO-04 clear consumer: DELETE /colp/v0.1/sync/.../favicon for one bookmark.
 * `bookmark_unmapped` means the native bookmark has no colp node in the
 * current scope (nothing the helper could clear); `clear_failed` is any other
 * worker-side failure. The `outcome` carries the honest per-case result the
 * popup surfaces.
 */
export type FaviconClearOutcome = 'cleared' | 'protected' | 'noop' | 'unavailable';
export type FaviconClearResponse =
  | { readonly ok: true; readonly outcome: FaviconClearOutcome }
  | { readonly ok: false; readonly error: 'bookmark_unmapped' | 'clear_failed' };

/**
 * S7 / B2 (SR-09 · SR-11 · SR-13): one read-only aggregation for the popup and
 * settings exits. `PublicSyncEngineState` already projects the queue
 * (`queueProjection`/`conflictPending`/`rejectedPending`), but the terminal
 * freeze also lives on the scope record (`lifecycle: 'recovery_required'` +
 * `metadata.recoveryCode`, see `freezeScopeRecovery`). This view surfaces both
 * halves together so a terminal freeze can never degrade into a bare
 * "Needs attention" with no way out.
 */
export type SyncAttentionGetRequest = { readonly kind: 'known.sync.attention.get' };
/** How much of the synced boundary is on the server (`known.sync.progress.get`, read-only). */
export type SyncProgressRequest = { readonly kind: 'known.sync.progress.get' };
export interface PublicSyncProgress {
  /** Open item problems prevent completion even while independent changes keep syncing. */
  readonly issueCount?: number;
  /** False when the engine has stopped; progress must not promise another automatic retry. */
  readonly retryAutomatic?: boolean;
  /** The engine paused after repeated errors and resumes by itself: with `retryAutomatic: false`, a pause and not a stop. */
  readonly coolingDown?: boolean;
  /** preparing: comparing this browser with the collection; syncing: items left; done: everything has a server node. */
  readonly stage: 'preparing' | 'syncing' | 'done';
  /** The first sync's bootstrap is still running. */
  readonly firstSync: boolean;
  /** Changes are still queued for upload. */
  readonly liveWork: boolean;
  readonly bookmarks: { readonly synced: number; readonly total: number };
  readonly folders: { readonly synced: number; readonly total: number };
}
/** `permissionRequired`: sync is set up but bookmark access was removed, so there is no count to show. */
export type SyncProgressResponse = { readonly ok: true; readonly progress: PublicSyncProgress | null; readonly permissionRequired?: true }
  | { readonly ok: false; readonly error: 'state_unavailable' };
export type SyncAttentionTerminalCode = 'metadata_sync_disabled' | 'replica_rebuild_pending' | 'pull_apply_target_missing' | 'pull_apply_evidence_missing'
  | 'anchor_mapping_missing' | 'payload_too_large' | 'recovery_identity_unproven'
  | 'deletion_identity_unproven' | 'legacy_resolution_sequence_collision' | 'mapping_identity_collision'
  | 'create_ambiguous' | 'create_evidence_missing'
  | 'create_placement_parent_deleted' | 'create_placement_unproven' | 'pull_issue_ceiling' | 'sync_issue_ceiling';
/** What a person can do about one item from this device (`known.sync.issue.act`). */
export type SyncIssueLocalAction = 'retry' | 'release' | 'dismiss';
/** Browser-local diagnostics. Native identities stay on this device. */
export interface SyncIssueDiagnostic {
  /** What the Sync center may ask for this item (`retry`); the same list the health report carries. */
  readonly actions?: readonly string[];
  /** What this device offers for the item right now. */
  readonly localActions?: readonly SyncIssueLocalAction[];
  readonly direction: 'pull' | 'push' | 'local'; readonly code: string; readonly title?: string;
  readonly reportId?: string; readonly itemId?: string;
  readonly issueId?: string; readonly nodeId?: string; readonly opId?: string; readonly eventId?: string;
  readonly count?: number; readonly firstSeenAt?: string | number; readonly lastSeenAt?: string | number;
  readonly dependencyOpId?: string; readonly dependencyEventId?: string; readonly dependencySequence?: number;
  readonly rootCause?: string; readonly attempts?: number; readonly recovery?: 'automatic' | 'decision';
}
export interface PublicSyncAttention {
  readonly issueCount?: number;
  readonly issues?: readonly SyncIssueDiagnostic[];
  readonly rebuildAvailable?: boolean;
  readonly rebuildUnavailableReason?: string;
  readonly retryAvailable?: boolean;
  readonly retryAt?: number;
  readonly retryAutomatic?: boolean;
  /** The engine paused after repeated errors and resumes by itself at `retryAt`: a cooldown, not a stop. */
  readonly coolingDown?: boolean;
  /** How many times the circuit breaker has tripped without progress (diagnostics). */
  readonly breakerTrips?: number;
  /** Bookmark access was removed after sync was set up: nothing can read or change a bookmark until it is allowed again. */
  readonly permissionRequired?: boolean;
  readonly phase?: PublicSyncEngineState['phase'];
  readonly recoveryFrozen: boolean;
  readonly queueProjection: PublicSyncEngineState['queueProjection'];
  readonly rejectedPending: boolean;
  readonly conflictPending: boolean;
  readonly nativeWaitPending: boolean;
  readonly waitCount: number;
  readonly lastError?: string;
  /** `scope.metadata.recoveryCode` — the specific code recorded at freeze time. */
  readonly recoveryCode?: string;
  readonly terminal: boolean;
  readonly terminalCode?: SyncAttentionTerminalCode;
}
export type SyncAttentionResponse = { readonly ok: true; readonly attention: PublicSyncAttention }
  | { readonly ok: false; readonly error: 'not_connected' | 'state_unavailable' };
/**
 * SR-10 / A-08: the read-only ingress-diagnostic ledger the options page lists
 * as "not included in sync". The durable rows already exist
 * (`listIngressDiagnostics`: one row per `(scope, code)`, with an accumulated
 * `count` and a monotone `lastAt`); this channel only projects them and
 * deliberately drops `id`, `scopeKey` and `park`, so no internal identifier —
 * in particular not the event id a `park:` code embeds — reaches a page.
 */
export type IngressDiagnosticsGetRequest = { readonly kind: 'known.sync.ingressDiagnostics.get' };
export interface PublicIngressDiagnostic {
  readonly code: string;
  /** Number of suppressed events folded into this row; never resets to 0. */
  readonly count: number;
  /** Epoch ms of the first occurrence; `0` means "written before the ledger". */
  readonly firstAt: number;
  /** Epoch ms of the most recent occurrence; `0` means the same unknown time. */
  readonly lastAt: number;
}
export type IngressDiagnosticsResponse =
  | { readonly ok: true; readonly diagnostics: readonly PublicIngressDiagnostic[] }
  | { readonly ok: false; readonly error: 'not_connected' | 'state_unavailable' };
export type SaveStatusRequest = { readonly kind: 'known.save.status'; readonly nativeId?: string };
export type SaveStatusResponse = {
  readonly ok: true; readonly status: import('./sync-status.js').SyncStatus; readonly localOnly: boolean;
  readonly privateNativeIds?: readonly string[];
  readonly mountNativeIds: readonly string[]; readonly nativeId?: string; readonly defaultFolderId?: string;
} | { readonly ok: false; readonly error: string };
export type NativeSaveRequest = {
  readonly kind: 'known.save.native'; readonly entry: 'page' | 'window'; readonly userGesture: true;
};
export type NativeSaveResponse =
  | { readonly ok: true; readonly nativeIds: readonly string[]; readonly localOnly: boolean;
    readonly reused: boolean; readonly parentNativeId?: string }
  | { readonly ok: false; readonly error: 'permission_required' | 'create_failed' | 'no_page' | 'busy' };

export interface PublicImportRoot { readonly sourceNodeId: string; readonly kind: 'Folder' | 'Bookmark' | 'Separator';
  readonly title: string; readonly descendants: number }
export interface PublicImportTarget { readonly nativeId: string; readonly colpId: string; readonly revision: string;
  readonly title: string }
export interface PublicImportPreview { readonly digest: string; readonly sourceProfile: 'netscape-bookmarks-v1' | 'chromium-bookmarks-v1';
  readonly creates: number; readonly warnings: readonly { readonly code: string; readonly message: string }[];
  readonly roots: readonly PublicImportRoot[]; readonly targets: readonly PublicImportTarget[] }
export interface PublicImportStatus { readonly planId: string; readonly state: 'active' | 'paused' | 'complete' | 'attention';
  readonly progress: { readonly total: number; readonly skipped: number; readonly queued: number;
    readonly terminal: number; readonly recoverable: number } }
export type ImportRequest = { readonly kind: 'known.import.previewFile'; readonly base64: string }
  | { readonly kind: 'known.import.previewNative'; readonly tree?: unknown }
  | { readonly kind: 'known.import.commit'; readonly digest: string; readonly choices: readonly ({
    readonly sourceNodeId: string; readonly action: 'skip' } | { readonly sourceNodeId: string; readonly action: 'import';
    readonly target: { readonly nativeId: string; readonly colpId: string; readonly revision: string } })[] }
  | { readonly kind: 'known.import.status'; readonly planId?: string }
  | { readonly kind: 'known.import.pause' | 'known.import.resume' | 'known.import.retry'; readonly planId: string };
export type ImportResponse = { readonly ok: true; readonly preview: PublicImportPreview }
  | { readonly ok: true; readonly status: PublicImportStatus }
  | { readonly ok: false; readonly error: string };

export type BatchKind = 'move' | 'rename' | 'delete';
export type PublicBatchItem = {
  readonly nativeId: string; readonly title: string; readonly nodeKind: 'folder' | 'bookmark';
  readonly state: string; readonly blocked?: string; readonly colpId?: string; readonly error?: string;
};
export type BatchPreviewRequest = {
  readonly kind: 'known.batch.preview'; readonly operation: BatchKind;
  readonly nativeIds: readonly string[]; readonly targetParentId?: string;
  readonly titles?: Readonly<Record<string, string>>;
};
export type BatchConfirmRequest = {
  readonly kind: 'known.batch.confirm'; readonly commandId: string; readonly operation: BatchKind;
  readonly nativeIds: readonly string[]; readonly previewDigest: string; readonly userGesture: true;
  readonly secondConfirm?: true; readonly targetParentId?: string;
  readonly titles?: Readonly<Record<string, string>>;
};
export type BatchStatusRequest = { readonly kind: 'known.batch.status'; readonly planId?: string };
export type BatchUndoRequest = {
  readonly kind: 'known.batch.undo'; readonly planId: string; readonly commandId: string; readonly userGesture: true;
};
export type BatchRequest = BatchPreviewRequest | BatchConfirmRequest | BatchStatusRequest | BatchUndoRequest;
export type PublicBatchPreview = {
  readonly digest: string; readonly basisDigest: string; readonly operation: BatchKind; readonly requiresSecondConfirm: boolean;
  readonly crossBoundary: boolean; readonly items: readonly PublicBatchItem[];
};
export type PublicBatchStatus = {
  readonly planId: string; readonly commandId: string; readonly operation: BatchKind; readonly state: string;
  readonly reused: boolean; readonly applied: number; readonly failed: number; readonly changed: number;
  readonly undone: number; readonly undoExpiresAt?: number; readonly items: readonly PublicBatchItem[];
};
export type BatchResponse =
  | { readonly ok: true; readonly preview: PublicBatchPreview }
  | { readonly ok: true; readonly status: PublicBatchStatus }
  | { readonly ok: false; readonly error: string };
