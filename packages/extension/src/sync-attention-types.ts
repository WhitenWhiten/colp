import type { PublicSyncEngineState } from './types.js';

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
/**
 * A code that ends sync until a person acts (`syncAttentionTerminalCode`): `payload_too_large`, `replica_rebuild_pending`,
 * or any table code whose exit is a rebuild or a decision. The failure table is the list, so this is open (a union that
 * named some of them was stale the day another was added); the names below only keep the editor's suggestions.
 */
export type SyncAttentionTerminalCode = 'metadata_sync_disabled' | 'replica_rebuild_pending' | 'pull_apply_target_missing' | 'pull_apply_evidence_missing'
  | 'anchor_mapping_missing' | 'payload_too_large' | 'recovery_identity_unproven'
  | 'deletion_identity_unproven' | 'legacy_resolution_sequence_collision' | 'mapping_identity_collision' | 'mapping_identity_conflict'
  | 'create_ambiguous' | 'create_evidence_missing'
  | 'create_placement_parent_deleted' | 'create_placement_unproven' | 'pull_issue_ceiling' | 'sync_issue_ceiling'
  | (string & Record<never, never>);
/**
 * What a person can do about one item from this device (`known.sync.issue.act`):
 * `retry` puts a held or blocked upload through its checks again; `dismiss`
 * closes the item and keeps this browser's version.
 */
export type SyncIssueLocalAction = 'retry' | 'dismiss';
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
  /** Rule E: the engine step that failed (`sync_step_failed` only). */
  readonly stage?: string;
}
export interface PublicSyncAttention {
  readonly issueCount?: number;
  readonly issues?: readonly SyncIssueDiagnostic[];
  readonly rebuildAvailable?: boolean;
  readonly rebuildUnavailableReason?: string;
  /** K3: `server_fenced` retires the old replica on the server first (an upload may already be there); it needs a connection. */
  readonly rebuildMode?: 'local' | 'server_fenced';
  /** K3: set only when a Reset is needed but cannot be done now (`offline`, `native_outcome_unsettled`). */
  readonly rebuildBlockedReason?: string;
  /** W2A-02: a Reset that was confirmed but has not finished can be given up (nothing is archived yet). */
  readonly rebuildCancelAvailable?: boolean;
  /**
   * W2A-01: the sync database cannot be used (`lastError` names why: `future_schema`, `diagnostic_read_only`,
   * `upgrade_failed`, `storage_unavailable`, `quota_exceeded`, ...). Only then is the rest of this snapshot
   * a synthetic one: no queue, issues or engine state can be read.
   */
  readonly storageState?: 'newer_version' | 'read_only' | 'upgrade_failed' | 'unavailable';
  /** W2A-01: a confirmed "Reset local sync data" (`known.sync.storage.reset.preview` / `.confirm`) can recover it. */
  readonly storageResetAvailable?: boolean;
  readonly retryAvailable?: boolean;
  /** Close to the point where sync stops for too many open items (`sync-issue-ceiling.ts`). */
  readonly issueCeiling?: { readonly open: number; readonly limit: number };
  readonly retryAt?: number;
  readonly retryAutomatic?: boolean;
  /** The engine paused after repeated errors and resumes by itself at `retryAt`: a cooldown, not a stop. */
  readonly coolingDown?: boolean;
  /**
   * The engine stopped and looks again by itself at `retryAt` (5 minutes, 15 minutes, an hour, then every six hours);
   * Retry looks now. `stopped`: retrying cannot change the result. `stalled`: it waited on the same thing for a long time.
   */
  readonly stopKind?: 'stopped' | 'stalled';
  /** How many times the circuit breaker has tripped without progress (diagnostics). */
  readonly breakerTrips?: number;
  /** Bookmark access was removed after sync was set up: nothing can read or change a bookmark until it is allowed again. */
  readonly permissionRequired?: boolean;
  /** This browser could not tell the server how it is doing for several minutes, so the Sync center may show old news. */
  readonly healthDelivery?: { readonly code: string; readonly since: number };
  /** A stall nothing else explains: the oldest upload has not moved, or no pass has ended for a long time (`sync-watchdog.ts`). */
  readonly watchdog?: { readonly kind: 'stuck' | 'no_pass'; readonly since: number; readonly title?: string };
  /** When a pass last ended cleanly (epoch milliseconds). */
  readonly lastSyncedAt?: number;
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
