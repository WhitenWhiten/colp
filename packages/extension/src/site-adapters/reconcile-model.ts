import type { NativeBinding, Representation, SiteItem, SourceFolderReservation } from './contracts.js';
import type { SourceContext } from './ledger-types.js';
export interface ReconcileNode {
  native: NativeBinding; title: string; url: string | null; parentId: string; pinned: boolean;
  /** All descendants, including nested folders, must be inventoried before a folder can move. */
  protected: boolean; children?: readonly string[];
  annotationRevision?: number;
  subtreeDigest?: string;
}
export interface ReconcileSnapshot {
  collectionId: string; items: readonly SiteItem[]; complete: boolean; absence: 'proven' | 'unverified';
  snapshotId: string | null; reason: string | null;
}
export type ReconcileKind = 'present' | 'add' | 'candidate' | 'localDeleted' | 'moved' | 'folderMoved' | 'sourceRemoved' | 'unverified' | 'title' | 'titleOverride' | 'personal' | 'protected';
export type ReconcileChoice = 'keep' | 'adopt' | 'restore' | 'return' | 'archive' | 'move' | 'updateTitle' | 'useLocation';
export interface ReconcileDifference {
  id: string; collectionId: string; itemId: string | null; kind: ReconcileKind; title: string;
  native?: NativeBinding; expected?: ReconcileNode; representation?: Representation;
  source?: SiteItem; candidates?: readonly ReconcileNode[]; choices: readonly ReconcileChoice[];
  reason?: string;
  folder?: SourceFolderReservation;
}
export interface ReconcilePreview {
  version: 1; id: string; importId: string; context: SourceContext; digest: string; createdAt: number;
  policyRevision: number;
  /** Presentation-only page metadata; never part of the approved stored preview. */
  page?: { offset: number; next: number | null; total: number; counts: Partial<Record<ReconcileKind, number>> };
  destination?: { root: NativeBinding<'folder'>; owner: import('./copy-identity.js').DestinationOwner | null };
  differences: readonly ReconcileDifference[]; snapshots: readonly ReconcileSnapshot[];
}
export interface ReconcileDecision { id: string; choice: ReconcileChoice; nativeId?: string; destinationId?: string }
