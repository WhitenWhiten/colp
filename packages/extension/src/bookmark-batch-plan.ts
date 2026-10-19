import { digestJson } from './bookmark-event-codec.js';
import { batchPlanDigest, MAX_BATCH_ITEMS, type BatchItemRecord, type BatchKind } from './sync-state/batch-repository.js';
import type { MappingInput, MountBindingRecord, SyncScope, createSyncStateStore } from './sync-state-store.js';
import { deleteSubtreeDigest } from './bookmark-batch-delete-boundary.js';
import { batchContext, type BatchOwner } from './bookmark-batch-context.js';

export type BatchChromeNode = {
  readonly id: string; readonly title: string; readonly url?: string; readonly parentId?: string;
  readonly index?: number; readonly unmodifiable?: string; readonly folderType?: string; readonly dateAdded?: number;
  readonly children?: readonly BatchChromeNode[];
};
export type BatchBookmarkApi = {
  getTree(): Promise<readonly BatchChromeNode[]>;
  get(id: string): Promise<readonly BatchChromeNode[]>;
  getSubTree?(id: string): Promise<readonly BatchChromeNode[]>;
  move(id: string, destination: { parentId?: string; index?: number }): Promise<BatchChromeNode>;
  update(id: string, changes: { title?: string; url?: string }): Promise<BatchChromeNode>;
  remove(id: string): Promise<void>;
  removeTree(id: string): Promise<void>;
  create?(input: { parentId: string; index?: number; title: string; url?: string }): Promise<BatchChromeNode>;
};

export type BatchZone = 'synced' | 'private' | 'outside';
export type BatchBlockReason = 'empty_batch' | 'protected_root' | 'managed' | 'remote_delete_pending'
  | 'missing' | 'cross_boundary' | 'rename_title_required' | 'move_target_required' | 'move_into_self'
  | 'stale_revision' | 'target_missing' | 'target_managed';

export interface BatchPreviewItem {
  readonly nativeId: string; readonly nodeKind: 'folder' | 'bookmark'; readonly title: string;
  readonly parentNativeId: string; readonly index: number; readonly preDigest: string;
  readonly zone: BatchZone; readonly colpId?: string; readonly url?: string; readonly parentColpId?: string;
  readonly mappingRevision?: string; readonly newTitle?: string; readonly targetParentNativeId?: string;
  readonly targetIndex?: number; readonly blocked?: BatchBlockReason;
  readonly subtreeDigest?: string;
}

export interface BatchPreview {
  readonly kind: BatchKind; readonly digest: string; readonly basisDigest: string; readonly treeDigest: string;
  readonly boundaryVersion: string; readonly requiresSecondConfirm: boolean; readonly crossBoundary: boolean;
  readonly items: readonly BatchPreviewItem[]; readonly blocked: readonly BatchPreviewItem[];
}

type Store = ReturnType<typeof createSyncStateStore>;

const SPECIAL = new Set(['bookmarks-bar', 'other', 'mobile', 'managed']);
const PARKED = ['pending', 'applying', 'restoring'] as const;

export async function previewBatch(input: BatchOwner & {
  readonly api: BatchBookmarkApi;
  readonly kind: BatchKind; readonly nativeIds: readonly string[];
  readonly targetParentId?: string; readonly titles?: Readonly<Record<string, string>>;
}): Promise<BatchPreview> {
  const cloud = batchContext(input).cloud;
  if (input.nativeIds.length === 0) throw Object.assign(new Error('empty_batch'), { code: 'empty_batch' });
  if (input.nativeIds.length > MAX_BATCH_ITEMS) throw Object.assign(new Error('batch_too_large'), { code: 'batch_too_large' });
  if (new Set(input.nativeIds).size !== input.nativeIds.length) {
    throw Object.assign(new Error('batch_item_duplicate'), { code: 'batch_item_duplicate' });
  }
  const tree = await input.api.getTree();
  const byId = new Map<string, BatchChromeNode>();
  const top = tree[0]; if (top) indexTree(top, byId);
  // Account metadata enriches the preview; it never owns a native command.
  // A failed read must not silently
  // become an empty boundary/parked set and mint a different plan.
  const attachment = cloud ? await Promise.all([
    cloud.store.getScope(cloud.scope), cloud.store.listMountBindings(cloud.scope), parkedNativeIds(cloud.store, cloud.scope),
  ]) : null;
  const [scopeRow, mounts, parked] = attachment ?? [null, [], new Set<string>()];
  const selected = new Set([...(scopeRow?.selectedRoots ?? []),
    ...mounts.filter((mount) => mount.status === 'active').map((mount) => mount.nativeRootId)]);
  const privateLocal = new Set(scopeRow?.privateRoots ?? []);
  const target = input.kind === 'move' ? byId.get(input.targetParentId ?? '') : undefined;
  if (input.kind === 'move' && !input.targetParentId) {
    throw Object.assign(new Error('move_target_required'), { code: 'move_target_required' });
  }
  const described = input.nativeIds.map((nativeId) => describeItem({
    nativeId, kind: input.kind, byId, selected, privateLocal, mounts, parked, topId: top?.id ?? '0',
    target, targetParentId: input.targetParentId, newTitle: input.titles?.[nativeId],
  }));
  // A selected folder already includes its descendants; deleting them separately would change its own confirmed subtree.
  const items = input.kind === 'delete' ? described.filter(item => !described.some(parent => !parent.blocked
    && parent.nativeId !== item.nativeId && isDescendant(byId, parent.nativeId, item.nativeId))) : described;
  const mappings = await Promise.all(items.map(async (item) => {
    const mapping = cloud ? await cloud.store.getMappingByNativeId(cloud.scope, item.nativeId) : null;
    return bindMapping(item, mapping);
  }));
  const targetMapping = target && cloud
    ? await cloud.store.getMappingByNativeId(cloud.scope, target.id) : null;
  const withTarget = mappings.map((item) => input.kind !== 'move' ? item : {
    ...item,
    targetParentNativeId: input.targetParentId,
    ...(targetMapping?.colpId ? { targetParentColpId: targetMapping.colpId } : {}),
    ...(item.blocked || !target ? {} : { targetIndex: (target.children?.length ?? 0) }),
  });
  const blocked = withTarget.filter((item) => item.blocked);
  const crossBoundary = input.kind === 'move' && withTarget.some((item) => !item.blocked
    && zoneOf(item.nativeId, byId, selected, privateLocal) !== zoneOf(input.targetParentId!, byId, selected, privateLocal));
  const treeDigest = digestJson(withTarget.map((item) => item.preDigest));
  const boundaryVersion = scopeRow?.boundaryVersion ?? '0';
  const digest = batchPlanDigest({
    kind: input.kind, treeDigest, boundaryVersion, targetParentNativeId: input.targetParentId,
    items: withTarget,
  });
  const basisDigest = batchPlanDigest({ kind: input.kind, treeDigest, boundaryVersion, targetParentNativeId: input.targetParentId,
    items: withTarget.map(item => ({ ...item, newTitle: undefined })) });
  return {
    kind: input.kind, digest, basisDigest, treeDigest, boundaryVersion, crossBoundary,
    requiresSecondConfirm: input.kind === 'delete' || crossBoundary,
    items: withTarget, blocked,
  };
}

export function itemPreDigest(node: BatchChromeNode): string {
  return digestJson({
    id: node.id, title: node.title, url: node.url ?? null, parentId: node.parentId ?? null,
    index: node.index ?? 0, kind: node.url ? 'bookmark' : 'folder',
  });
}

export function itemPostDigest(input: {
  readonly nativeId: string; readonly title: string; readonly url?: string;
  readonly parentId: string | null; readonly index: number; readonly kind: 'folder' | 'bookmark';
  readonly deleted?: boolean;
}): string {
  return digestJson({
    id: input.nativeId, title: input.title, url: input.url ?? null, parentId: input.parentId,
    index: input.index, kind: input.kind, deleted: input.deleted === true,
  });
}

export function toCommitItems(preview: BatchPreview, ids: { readonly uuid: () => string }, nativeOnly = false): Omit<BatchItemRecord,
  'scopeKey' | 'casVersion' | 'state' | 'planId'>[] {
  return preview.items.filter((item) => !item.blocked).map((item, order) => ({
    itemId: item.nativeId, order, nativeId: item.nativeId, nodeKind: item.nodeKind, title: item.title,
    parentNativeId: item.parentNativeId, index: item.index, preDigest: item.preDigest,
    operationId: `batch-op-${ids.uuid()}`, reversalId: `batch-rev-${ids.uuid()}`,
    ...(!nativeOnly && item.colpId ? { colpId: item.colpId } : {}), ...(item.url ? { url: item.url } : {}),
    ...(!nativeOnly && item.parentColpId ? { parentColpId: item.parentColpId } : {}),
    ...(item.targetParentNativeId ? { targetParentNativeId: item.targetParentNativeId } : {}),
    ...(item.targetIndex === undefined ? {} : { targetIndex: item.targetIndex }),
    ...(item.newTitle ? { newTitle: item.newTitle } : {}),
    ...(!nativeOnly && item.mappingRevision ? { mappingRevision: item.mappingRevision } : {}),
    ...(item.subtreeDigest ? { subtreeDigest: item.subtreeDigest } : {}),
  }));
}

function describeItem(input: {
  readonly nativeId: string; readonly kind: BatchKind; readonly byId: Map<string, BatchChromeNode>;
  readonly selected: ReadonlySet<string>; readonly privateLocal: ReadonlySet<string>;
  readonly mounts: readonly MountBindingRecord[]; readonly parked: ReadonlySet<string>;
  readonly topId: string; readonly target?: BatchChromeNode; readonly targetParentId?: string;
  readonly newTitle?: string;
}): BatchPreviewItem {
  const node = input.byId.get(input.nativeId);
  if (!node) {
    return {
      nativeId: input.nativeId, nodeKind: 'bookmark', title: '', parentNativeId: '', index: 0,
      preDigest: digestJson({ missing: input.nativeId }), zone: 'outside', blocked: 'missing',
    };
  }
  const nodeKind = node.url ? 'bookmark' as const : 'folder' as const;
  const parentNativeId = node.parentId ?? input.topId;
  const zone = zoneOf(node.id, input.byId, input.selected, input.privateLocal);
  const blocked = blockReason({ node, kind: input.kind, topId: input.topId, selected: input.selected,
    parked: input.parked, target: input.target, targetParentId: input.targetParentId, byId: input.byId,
    newTitle: input.newTitle });
  return {
    nativeId: node.id, nodeKind, title: node.title || 'Untitled', parentNativeId, index: node.index ?? 0,
    preDigest: itemPreDigest(node), zone, ...(node.url ? { url: node.url } : {}),
    ...(input.kind === 'delete' && nodeKind === 'folder' ? { subtreeDigest: deleteSubtreeDigest(node) } : {}),
    ...(input.newTitle ? { newTitle: input.newTitle } : {}),
    ...(input.targetParentId ? { targetParentNativeId: input.targetParentId } : {}),
    ...(blocked ? { blocked } : {}),
  };
}

function blockReason(input: {
  readonly node: BatchChromeNode; readonly kind: BatchKind; readonly topId: string;
  readonly selected: ReadonlySet<string>; readonly parked: ReadonlySet<string>;
  readonly target?: BatchChromeNode; readonly targetParentId?: string;
  readonly byId: Map<string, BatchChromeNode>; readonly newTitle?: string;
}): BatchBlockReason | undefined {
  const node = input.node;
  if (node.id === input.topId || node.id === '0' || !node.parentId) return 'protected_root';
  if (node.unmodifiable === 'managed' || node.folderType === 'managed') return 'managed';
  if (node.folderType && SPECIAL.has(node.folderType) || input.selected.has(node.id)) return 'protected_root';
  if (input.parked.has(node.id)) return 'remote_delete_pending';
  if (input.kind === 'rename' && !(input.newTitle ?? '').trim()) return 'rename_title_required';
  if (input.kind !== 'move') return undefined;
  if (!input.targetParentId || !input.target) return 'target_missing';
  if (input.target.unmodifiable === 'managed' || input.target.folderType === 'managed') return 'target_managed';
  if (input.target.id === node.id || isDescendant(input.byId, node.id, input.target.id)) return 'move_into_self';
  return undefined;
}

function bindMapping(item: BatchPreviewItem, mapping: MappingInput | null): BatchPreviewItem {
  if (!mapping) return item;
  return {
    ...item, colpId: mapping.colpId, mappingRevision: mapping.projection.revision,
    ...(mapping.parentColpId ? { parentColpId: mapping.parentColpId } : {}),
  };
}

function zoneOf(nativeId: string, byId: Map<string, BatchChromeNode>, selected: ReadonlySet<string>,
  privateLocal: ReadonlySet<string>): BatchZone {
  let cursor: BatchChromeNode | undefined = byId.get(nativeId);
  const seen = new Set<string>();
  while (cursor && !seen.has(cursor.id)) {
    seen.add(cursor.id);
    if (selected.has(cursor.id)) return 'synced';
    if (privateLocal.has(cursor.id)) return 'private';
    cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
  }
  return 'outside';
}

function isDescendant(byId: Map<string, BatchChromeNode>, ancestorId: string, candidateId: string): boolean {
  let cursor: BatchChromeNode | undefined = byId.get(candidateId);
  const seen = new Set<string>();
  while (cursor && !seen.has(cursor.id)) {
    seen.add(cursor.id);
    if (cursor.id === ancestorId) return true;
    cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
  }
  return false;
}

function indexTree(node: BatchChromeNode, byId: Map<string, BatchChromeNode>): void {
  byId.set(node.id, node);
  for (const child of node.children ?? []) indexTree(child, byId);
}

async function parkedNativeIds(store: Store, scope: SyncScope): Promise<Set<string>> {
  const rows = await store.listRemoteDeleteDecisions(scope, PARKED);
  return new Set(rows.flatMap((row) => row.nativeIds));
}
