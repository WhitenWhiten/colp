export type ProductReplicaStatus = 'active' | 'expired' | 'recovery_required' | 'retired';
/**
 * What the server can tell on its own about a replica taking in changes,
 * without any report from the client: `behind` is ordinary lag; `stalled`
 * still connects but has not taken in a change for an hour; `silent` has
 * missed changes for an hour and has not connected for an hour either.
 */
export type ProductReplicaActivity = 'current' | 'behind' | 'stalled' | 'silent';
export const REPLICA_ACTIVITY_STALE_MS = 60 * 60_000;
export interface ProductSyncDeviceView { readonly id: string; readonly name: string }
export interface ProductSyncReplicaView { readonly id: string; readonly deviceId: string; readonly name: string;
  readonly collectionId: string; readonly kind: string; readonly status: ProductReplicaStatus;
  readonly leaseExpiresAt: string; readonly lastSeenAt: string; readonly lastAckAt: string | null;
  readonly acknowledgedCommitOrdinal: string | null; readonly lifecycleRevision: string; readonly etag: string;
  /** Null for a retired replica. */
  readonly activity: ProductReplicaActivity | null;
  /** When the oldest Sync stream change this replica has not acknowledged was committed. */
  readonly behindSince: string | null;
  /** The replica's own last report; null when it never reported or is retired. */
  readonly health: ProductReplicaHealthView | null }
/** What a browser last said about its own sync (replica-health.ts). */
export interface ProductReplicaHealthView { readonly state: import('./replica-health.js').ReplicaHealthState;
  readonly code: string | null; readonly since: string; readonly reportedAt: string; readonly issueCount: number;
  /** What the Sync center may ask of the whole browser now, from its last report. */
  readonly actions: readonly import('./replica-health.js').ReplicaIssueAction[];
  /** Commands of the last seven days, newest first. */
  readonly commands: readonly ProductReplicaCommandView[] }
/** One thing the owner asked a browser to do, and what came of it. */
export interface ProductReplicaCommandView { readonly commandId: string; readonly replicaId: string;
  readonly action: import('./replica-health.js').ReplicaIssueAction; readonly issueId: string | null;
  readonly state: import('./replica-health.js').ReplicaCommandState; readonly resultCode: string | null;
  readonly createdAt: string; readonly completedAt: string | null; readonly expiresAt: string }
export const PRODUCT_REPLICA_COMMANDS_SHOWN = 10;
export interface ProductReplicaIssuesView { readonly replicaId: string; readonly reportedAt: string | null;
  readonly total: number; readonly items: readonly import('./replica-health.js').ReplicaHealthIssue[];
  readonly ackWarnings: readonly import('./replica-health.js').ReplicaAckWarning[]; readonly ackWarningsAt: string | null }

export function productReplicaActivity(input: { readonly status: ProductReplicaStatus;
  readonly behindSince: Date | null; readonly lastSeenAt: Date; readonly now: Date }): ProductReplicaActivity | null {
  if (input.status === 'retired') return null;
  if (!input.behindSince) return 'current';
  const now = input.now.getTime();
  if (now - input.behindSince.getTime() < REPLICA_ACTIVITY_STALE_MS) return 'behind';
  return now - input.lastSeenAt.getTime() < REPLICA_ACTIVITY_STALE_MS ? 'stalled' : 'silent';
}
export interface ProductSyncStatusView { readonly devices: readonly ProductSyncDeviceView[];
  readonly replicas: readonly ProductSyncReplicaView[] }
export type ProductConflictResolutionBlockedReason = 'node_read_only' | 'resource_not_found';
export interface ProductConflictSummary { readonly id: string; readonly collectionId: string; readonly targetId: string;
  readonly type: string; readonly field: string | null; readonly status: 'open';
  readonly resolutionBlockedReason?: ProductConflictResolutionBlockedReason;
  readonly allowedResolutions: readonly ('server'|'incoming'|'custom'|'both')[]; readonly revision: string;
  readonly etag: string; readonly createdAt: string; readonly summary: { readonly current: string | null; readonly incoming: string | null } }
export interface ProductConflictPage { readonly items: readonly ProductConflictSummary[];
  readonly page: { readonly nextCursor: string | null } }
export type ProductSyncCommandOutcome<T> = { readonly kind: 'committed'; readonly result: T }
  | { readonly kind: 'replay'; readonly status: number; readonly body: Uint8Array;
      readonly stableHeaders: Readonly<Record<string,string>>; readonly mediaType: string }
  | { readonly kind: 'in_progress'; readonly retryAfterSeconds: number } | { readonly kind: 'reused' }
  | { readonly kind: 'expired' };
export interface ProductConflictResolutionView { readonly conflictId: string; readonly status: 'resolved';
  readonly revision: string; readonly etag: string; readonly resolvedAt: string }
export interface ProductReplicaRetirementView { readonly replicaId: string; readonly status: 'retired';
  readonly lifecycleRevision: string; readonly etag: string; readonly retiredAt: string }
export interface ProductSyncCenterPorts {
  getStatus(input: { readonly accountId: string }): Promise<ProductSyncStatusView>;
  getConflicts(input: { readonly accountId: string; readonly limit: number; readonly cursor?: string }): Promise<ProductConflictPage>;
  /** Throws `resource_not_found` for a replica the account does not own. */
  getReplicaIssues(input: { readonly accountId: string; readonly replicaId: string }): Promise<ProductReplicaIssuesView>;
  resolveConflict(input: { readonly accountId: string; readonly subjectId: string; readonly conflictId: string;
    readonly expectedRevision: string; readonly commandId: string; readonly fingerprint: string;
    readonly resolution: 'server'|'incoming'|'custom'|'both'; readonly value?: unknown }): Promise<ProductSyncCommandOutcome<ProductConflictResolutionView>>;
  retireReplica(input: { readonly accountId: string; readonly replicaId: string; readonly expectedLifecycleRevision: string;
    readonly commandId: string; readonly fingerprint: string }): Promise<ProductSyncCommandOutcome<ProductReplicaRetirementView>>;
  /**
   * Queues an action for the browser to carry out the next time it reports.
   * Throws `resource_not_found` for a replica the account does not own and
   * `replica_action_unavailable` when its last report does not offer the action; an
   * open command for the same action and issue is returned instead of a second.
   */
  sendReplicaCommand(input: { readonly accountId: string; readonly replicaId: string;
    readonly action: import('./replica-health.js').ReplicaIssueAction; readonly issueId?: string;
    readonly commandId: string; readonly fingerprint: string }): Promise<ProductSyncCommandOutcome<ProductReplicaCommandView>>;
  listTrash(input: { readonly accountId: string; readonly subjectId: string; readonly collectionId: string;
    readonly limit: number; readonly cursor?: string }): Promise<import('./product-sync-trash.js').ProductSyncTrashPage>;
  getTrashDetail(input: { readonly accountId: string; readonly subjectId: string; readonly deletionId: string }):
    Promise<import('./product-sync-trash.js').ProductSyncTrashDetail>;
  restoreTrash(input: { readonly accountId: string; readonly subjectId: string; readonly deletionId: string;
    readonly expectedRevision: string; readonly commandId: string; readonly fingerprint: string }):
    Promise<ProductSyncCommandOutcome<import('./product-sync-trash.js').ProductSyncTrashRestoreView>>;
  restoreTrashBatch(input: { readonly accountId: string; readonly subjectId: string; readonly collectionId: string;
    readonly items: readonly import('./product-sync-trash.js').ProductSyncTrashRestoreBatchItem[];
    readonly commandId: string; readonly fingerprint: string }):
    Promise<ProductSyncCommandOutcome<import('./product-sync-trash.js').ProductSyncTrashRestoreBatchView>>;
  restoreTrashSubtree(input: { readonly accountId: string; readonly subjectId: string; readonly deletionId: string;
    readonly expectedRevision: string; readonly commandId: string; readonly fingerprint: string }):
    Promise<ProductSyncCommandOutcome<import('./product-sync-trash.js').ProductSyncTrashRestoreBatchView>>;
  emptyTrash(input: { readonly accountId: string; readonly subjectId: string; readonly collectionId: string;
    readonly expectedCount: number; readonly confirmation: string; readonly commandId: string;
    readonly fingerprint: string }):
    Promise<ProductSyncCommandOutcome<import('./product-sync-trash.js').ProductSyncTrashEmptyView>>;
}
export interface ProductSyncCenterUnitOfWork { execute<T>(work: (ports: ProductSyncCenterPorts) => Promise<T>): Promise<T> }

/**
 * FIX-M-011 (SYNC-R06): versioned Conflict keyring readiness view. Exposes
 * only the persisted key versions referenced by open Conflicts — never key
 * material.
 */
export interface SyncConflictKeyringReadiness {
  readonly capability: 'sync-conflicts';
  readonly status: 'ready' | 'not-ready';
  /** Versions referenced by open Conflicts (ascending). */
  readonly referencedVersions: readonly number[];
  readonly reason?: 'missing_retained_key' | 'dependency_unavailable';
}
