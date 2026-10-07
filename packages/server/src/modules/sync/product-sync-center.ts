export type ProductReplicaStatus = 'active' | 'expired' | 'recovery_required' | 'retired';
export interface ProductSyncDeviceView { readonly id: string; readonly name: string }
export interface ProductSyncReplicaView { readonly id: string; readonly deviceId: string; readonly name: string;
  readonly collectionId: string; readonly kind: string; readonly status: ProductReplicaStatus;
  readonly leaseExpiresAt: string; readonly lastSeenAt: string; readonly lastAckAt: string | null;
  readonly acknowledgedCommitOrdinal: string | null; readonly lifecycleRevision: string; readonly etag: string }
export interface ProductSyncStatusView { readonly devices: readonly ProductSyncDeviceView[];
  readonly replicas: readonly ProductSyncReplicaView[] }
export interface ProductConflictSummary { readonly id: string; readonly collectionId: string; readonly targetId: string;
  readonly type: string; readonly field: string | null; readonly status: 'open';
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
  resolveConflict(input: { readonly accountId: string; readonly subjectId: string; readonly conflictId: string;
    readonly expectedRevision: string; readonly commandId: string; readonly fingerprint: string;
    readonly resolution: 'server'|'incoming'|'custom'|'both'; readonly value?: unknown }): Promise<ProductSyncCommandOutcome<ProductConflictResolutionView>>;
  retireReplica(input: { readonly accountId: string; readonly replicaId: string; readonly expectedLifecycleRevision: string;
    readonly commandId: string; readonly fingerprint: string }): Promise<ProductSyncCommandOutcome<ProductReplicaRetirementView>>;
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
