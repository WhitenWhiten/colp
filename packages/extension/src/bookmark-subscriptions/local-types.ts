import type { Mapping, ProjectionNode, SnapshotDescriptor, SourceRef, SourceNodeRef, ActionReceipt } from './contracts.js';
export interface AccountScope { serverOrigin: string; accountId: string; authorityGeneration: number; profileId: string }
export type LocalState = 'initializing'|'applying'|'current'|'empty'|'paused'|'retrying'|'capacity_exceeded'|'storage_unavailable'|'sign_in_required'|'permission_required'|'target_missing'|'local_change'|'repair_pending'|'access_lost'|'terminating'|'detached';
export interface LocalMapping { id: string; scope: AccountScope; source: SourceRef; mapping: Mapping; enabled: boolean; applyEpoch: number; mountParentNativeId: string; mountIndex?: number; rootNativeId?: string; localAlias: string; state: LocalState; reserved: number; copyReservations?: Record<string, number>; lastAppliedRevision?: string; projectionEtag?: string; lastCheckedAt?: number; lastUpdatedAt?: number; nextCheckAt: number; nextMaintenanceAt: number; error?: string; cleanup?: boolean; staged?: { descriptor: SnapshotDescriptor }; }
export interface OwnedNode { id: string; mappingId: string; generation: string; key: string; nativeId: string; parentNativeId?: string; index: number; fingerprint: string; node: ProjectionNode; ref?: SourceNodeRef; copyTaskId?: string; personalCopy?: boolean }
export interface NativeOperation {
  id: string;
  mappingId: string;
  generation: string;
  applyEpoch: number;
  kind: 'create'|'update'|'move'|'remove';
  phase: 'prepared'|'issued'|'received';
  settled?: boolean;
  eventConsumed?: boolean;
  observedOutcome?: 'not_applied';
  nativeId?: string;
  parentNativeId?: string;
  beforeIds?: string[];
  protectedParent?: boolean;
  node?: ProjectionNode;
  resultId?: string;
  resultParentNativeId?: string;
  resultIndex?: number;
  createdAt: number;
  targetIndex?: number;
  localKey?: string;
  ownershipKey?: string;
  copyTaskId?: string;
  personalCopy?: boolean;
  purpose?: 'directory'|'restore-personal'|'preservation';
}
export interface AckRecord { id: string; scope: AccountScope; mappingId: string; generation: string; result: ActionReceipt['result']; commandId: string; pending: boolean; expectedEpoch?: number; scanId?: string; completedAt: number; evidence: string[] }
export interface Exclusion { id: string; nativeId: string; reason: 'preserved'|'quarantine'; accountId: string; serverOrigin: string }
export interface Diagnostic { id: string; scope: AccountScope; mappingId: string; reasonCode: string; resolution: 'blocked'|'restored'|'preserved'|'pending'|'resolved'; nativeId?: string; origin: string; time: number; count: number; repairTaskId?: string; preservedNativeId?: string; operation?: string; nativePath?: string[] }
export interface Draft { requestId: string; sourceType: 'collection'|'digest_series'; sourceId: string; serverOrigin: string; expiresAt: number }

export interface MappingToken {id:string;generation:string;applyEpoch:number;enabled:boolean;cleanup:boolean}
export interface StagedProjection {id:string;generation:string;applyEpoch:number;descriptor:SnapshotDescriptor;nodes:ProjectionNode[]}
export interface CompletedCopy {
  rootNativeId: string;
  count: number;
  completedAt: number;
  nodes?: { nativeId: string; parentNativeId?: string; fingerprint: string }[];
}
export interface CopyCandidate {
  scope: AccountScope;
  generation: string;
  taskId: string;
  treeDigest: string;
}
