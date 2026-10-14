import type { BindingSet, FolderRef, RuleDefinition, RoleBindings } from '@know-n/colp/automation';
export interface AutomationActor { accountId: string; subjectId: string }
export interface FolderSnapshot {
  folder: FolderRef;
  title: string;
  revision: string;
  ancestors: FolderRef[];
  policyRevision: string;
}
export type FolderResolution = { status: 'valid'; snapshot: FolderSnapshot }
  | { status: 'blocked'; code: 'bindingDeleted' | 'permissionRevoked' | 'scopeChanged'; message: string;
      /** Live identity/ancestry for monitoring only; a blocked snapshot grants no authority. */
      snapshot?: FolderSnapshot };
export interface CollectionSnapshot { id: string; rootNodeId: string; contentRevision: string; policyRevision: string; commitOrdinal: string; currentOwner: boolean }
export interface BindingReadPort {
  readFolder(actor: AutomationActor, folder: FolderRef): Promise<FolderResolution>;
  readCollection(actor: AutomationActor, collectionId: string): Promise<CollectionSnapshot | null>;
}
export interface BindingStore {
  load(ownerId: string, id: string): Promise<BindingSet | null>;
  save(ownerId: string, view: BindingSet): Promise<void>;
  list(ownerId: string, after: { createdAt: string; id: string } | null, limit: number): Promise<{ view: BindingSet; createdAt: string }[]>;
  delete(ownerId: string, id: string): Promise<boolean>;
}
export function scopeCollectionId(rule: RuleDefinition, values: RoleBindings): string | undefined {
  const binding = values[rule.scope.folderRole ?? ''];
  return rule.scope.collectionId ?? (binding?.kind === 'folder' ? binding.folder.collectionId : undefined);
}
export const sameFolder = (a: FolderRef, b: FolderRef): boolean => a.serverUuid === b.serverUuid && a.collectionId === b.collectionId && a.nodeId === b.nodeId;
