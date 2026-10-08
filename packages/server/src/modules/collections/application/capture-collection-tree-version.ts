import { formatUtcDateTime, generateOpaqueId, strongEntityTag } from '../domain/index.js';

export const COLLECTION_TREE_VERSION_MAX_NODES = 2000;
export const COLLECTION_TREE_VERSION_FIFO_LIMIT = 50;
export const COLLECTION_VERSION_CHANGES_LIMIT = 50;

export type CollectionTreeVersionKind = 'manual' | 'pre_restore' | 'pre_mutation';
export type CollectionVersionCause =
  | 'web'
  | 'sync'
  | 'agent-plan'
  | 'restore'
  | 'undo'
  | `agent-plan:${string}`;

export class CollectionVersionNotFoundError extends Error {
  readonly code = 'resource_not_found' as const;
  constructor(message = 'The requested resource was not found.') {
    super(message);
    this.name = 'CollectionVersionNotFoundError';
  }
}

export class CollectionVersionInputError extends Error {
  readonly code = 'invalid_request' as const;
  constructor(message: string) {
    super(message);
    this.name = 'CollectionVersionInputError';
  }
}

export class CollectionVersionNodeLimitError extends Error {
  readonly code = 'invalid_request' as const;
  constructor(
    message = `A collection version cannot include more than ${COLLECTION_TREE_VERSION_MAX_NODES} live folder and bookmark nodes.`,
  ) {
    super(message);
    this.name = 'CollectionVersionNodeLimitError';
  }
}

export interface CollectionTreeLiveMember {
  readonly id: string;
  readonly kind: 'folder' | 'bookmark';
  readonly parentId: string;
  readonly title: string;
  readonly url: string | null;
  readonly positionToken: string;
}

export interface CollectionTreeSnapshotNode {
  readonly id: string;
  readonly kind: 'folder' | 'bookmark';
  readonly parentId: string;
  readonly title: string;
  readonly url: string | null;
  readonly childIds?: readonly string[];
}

export interface CollectionVersionRecord {
  readonly versionId: string;
  readonly accountId: string;
  readonly collectionId: string;
  readonly contentRevision: string;
  readonly kind: CollectionTreeVersionKind;
  readonly cause: CollectionVersionCause;
  readonly label: string;
  readonly etag: string;
  readonly nodeCount: number;
  readonly treeJson: readonly CollectionTreeSnapshotNode[];
  readonly createdAt: Date;
}

export interface CollectionVersionChangeCounts {
  readonly added: number;
  readonly removed: number;
  readonly moved: number;
  readonly renamed: number;
  readonly retargeted: number;
}

export interface CollectionVersionChange {
  readonly type: 'added' | 'removed' | 'moved' | 'renamed' | 'retargeted';
  readonly nodeId: string;
  readonly title: string;
}

export interface CollectionVersionLockedCollection {
  readonly collectionId: string;
  readonly ownerSubjectId: string;
  readonly contentRevision: string;
  readonly rootNodeId: string;
}

export interface CollectionVersionStorePort {
  lockOwnedLive(
    collectionId: string,
    ownerSubjectId: string,
  ): Promise<CollectionVersionLockedCollection | null>;
  getOwnedLive(
    collectionId: string,
    ownerSubjectId: string,
  ): Promise<CollectionVersionLockedCollection | null>;
  loadLiveMembers(collectionId: string): Promise<readonly CollectionTreeLiveMember[]>;
  getByCollectionAndRevision(
    accountId: string,
    collectionId: string,
    contentRevision: string,
  ): Promise<CollectionVersionRecord | null>;
  getById(
    accountId: string,
    collectionId: string,
    versionId: string,
  ): Promise<CollectionVersionRecord | null>;
  list(
    accountId: string,
    collectionId: string,
    input: {
      readonly limit: number;
      readonly after?: { readonly createdAt: Date; readonly versionId: string };
    },
  ): Promise<readonly CollectionVersionRecord[]>;
  insert(row: CollectionVersionRecord): Promise<void>;
  count(accountId: string, collectionId: string): Promise<number>;
  deleteOldest(
    accountId: string,
    collectionId: string,
    excludeVersionId?: string,
  ): Promise<void>;
  findLatestManualCreatedAt(accountId: string, collectionId: string): Promise<Date | null>;
}

export interface CaptureCollectionTreeVersionPorts {
  readonly versions: CollectionVersionStorePort;
  readonly clock: { now(): Date | Promise<Date> };
  readonly ids?: { nextVersionId(): string };
}

export interface CaptureCollectionTreeVersionInput {
  readonly accountId: string;
  readonly collection: CollectionVersionLockedCollection;
  readonly kind: CollectionTreeVersionKind;
  readonly cause?: CollectionVersionCause;
  readonly label?: string;
  readonly restoringVersionId?: string;
}

export type CaptureCollectionTreeVersionResult =
  | { readonly kind: 'inserted'; readonly record: CollectionVersionRecord }
  | { readonly kind: 'existing'; readonly record: CollectionVersionRecord };

export function compareEditorSiblingOrder(
  left: { readonly positionToken: string; readonly id: string },
  right: { readonly positionToken: string; readonly id: string },
): number {
  if (left.positionToken < right.positionToken) return -1;
  if (left.positionToken > right.positionToken) return 1;
  if (left.id < right.id) return -1;
  if (left.id > right.id) return 1;
  return 0;
}

export function groupLiveMembersByParent(
  members: readonly CollectionTreeLiveMember[],
): Map<string, CollectionTreeLiveMember[]> {
  const byParent = new Map<string, CollectionTreeLiveMember[]>();
  for (const member of members) {
    const siblings = byParent.get(member.parentId);
    if (siblings) siblings.push(member);
    else byParent.set(member.parentId, [member]);
  }
  for (const siblings of byParent.values()) {
    siblings.sort(compareEditorSiblingOrder);
  }
  return byParent;
}

export function orderedSnapshotChildIds(
  snapshot: readonly CollectionTreeSnapshotNode[],
  parentId: string,
  snapshotById: ReadonlyMap<string, CollectionTreeSnapshotNode>,
): readonly string[] {
  const parent = snapshotById.get(parentId);
  if (parent?.kind === 'folder') return parent.childIds ?? [];
  return snapshot.filter((node) => node.parentId === parentId).map((node) => node.id);
}

export function collectionTreeJsonFromLiveMembers(
  members: readonly CollectionTreeLiveMember[],
): CollectionTreeSnapshotNode[] {
  return collectionTreeJsonFromParentGroups(groupLiveMembersByParent(members));
}

function collectionTreeJsonFromParentGroups(
  byParent: ReadonlyMap<string, readonly CollectionTreeLiveMember[]>,
): CollectionTreeSnapshotNode[] {
  const tree: CollectionTreeSnapshotNode[] = [];
  for (const parentId of [...byParent.keys()].sort()) {
    for (const member of byParent.get(parentId) ?? []) {
      const node: CollectionTreeSnapshotNode = {
        id: member.id,
        kind: member.kind,
        parentId: member.parentId,
        title: member.title,
        url: member.kind === 'bookmark' ? member.url : null,
        ...(member.kind === 'folder'
          ? { childIds: Object.freeze((byParent.get(member.id) ?? []).map((child) => child.id)) }
          : {}),
      };
      tree.push(Object.freeze(node));
    }
  }
  return tree;
}

export interface CollectionTreeLiveIndex {
  readonly liveJson: readonly CollectionTreeSnapshotNode[];
  readonly liveById: ReadonlyMap<string, CollectionTreeSnapshotNode>;
  readonly liveByParent: ReadonlyMap<string, readonly CollectionTreeLiveMember[]>;
  readonly liveSiblingIndexById: ReadonlyMap<string, number>;
}

export function indexLiveCollectionTree(
  live: readonly CollectionTreeLiveMember[],
): CollectionTreeLiveIndex {
  const liveByParent = groupLiveMembersByParent(live);
  const liveJson = collectionTreeJsonFromParentGroups(liveByParent);
  const liveSiblingIndexById = new Map<string, number>();
  for (const siblings of liveByParent.values()) {
    siblings.forEach((member, siblingIndex) => liveSiblingIndexById.set(member.id, siblingIndex));
  }
  return {
    liveJson,
    liveById: new Map(liveJson.map((node) => [node.id, node])),
    liveByParent,
    liveSiblingIndexById,
  };
}

export function assertCollectionTreeVersionNodeLimit(memberCount: number): void {
  if (memberCount > COLLECTION_TREE_VERSION_MAX_NODES) {
    throw new CollectionVersionNodeLimitError();
  }
}

export function buildCollectionTreeJson(
  members: readonly CollectionTreeLiveMember[],
): CollectionTreeSnapshotNode[] {
  assertCollectionTreeVersionNodeLimit(members.length);
  return collectionTreeJsonFromLiveMembers(members);
}

export function defaultCollectionVersionLabel(createdAt: Date): string {
  return `Snapshot ${formatUtcDateTime(createdAt)}`;
}

export function diffCollectionTree(
  snapshot: readonly CollectionTreeSnapshotNode[],
  live: readonly CollectionTreeLiveMember[],
): { readonly changes: readonly CollectionVersionChange[]; readonly changeCounts: CollectionVersionChangeCounts } {
  return diffCollectionTreeWithIndex(snapshot, indexLiveCollectionTree(live));
}

export function diffCollectionTreeWithIndex(
  snapshot: readonly CollectionTreeSnapshotNode[],
  index: CollectionTreeLiveIndex,
): { readonly changes: readonly CollectionVersionChange[]; readonly changeCounts: CollectionVersionChangeCounts } {
  const changes: CollectionVersionChange[] = [];
  const changeCounts = compareCollectionTrees(snapshot, index, changes);
  return { changes: Object.freeze(changes), changeCounts };
}

/** List pages only expose aggregate counts, so avoid allocating every detail row. */
export function countCollectionTreeChangesWithIndex(
  snapshot: readonly CollectionTreeSnapshotNode[],
  index: CollectionTreeLiveIndex,
): CollectionVersionChangeCounts {
  return compareCollectionTrees(snapshot, index);
}

function compareCollectionTrees(
  snapshot: readonly CollectionTreeSnapshotNode[],
  index: CollectionTreeLiveIndex,
  changes?: CollectionVersionChange[],
): CollectionVersionChangeCounts {
  const snapshotById = new Map(snapshot.map((node) => [node.id, node]));
  const snapshotSiblingIndexes = indexSnapshotSiblingOrder(snapshot, snapshotById);
  const counts = { added: 0, removed: 0, moved: 0, renamed: 0, retargeted: 0 };
  const record = (type: CollectionVersionChange['type'], nodeId: string, title: string) => {
    counts[type] += 1;
    changes?.push({ type, nodeId, title });
  };
  for (const node of snapshot) {
    const current = index.liveById.get(node.id);
    if (!current) {
      record('removed', node.id, node.title);
      continue;
    }
    const snapshotIndex = snapshotSiblingIndexes.get(node.parentId)?.get(node.id) ?? -1;
    const liveIndex = index.liveSiblingIndexById.get(current.id) ?? -1;
    if (node.parentId !== current.parentId || snapshotIndex !== liveIndex) {
      record('moved', node.id, current.title);
    }
    if (node.title !== current.title) {
      record('renamed', node.id, current.title);
    }
    if (node.kind === 'bookmark' && current.kind === 'bookmark' && node.url !== current.url) {
      record('retargeted', node.id, current.title);
    }
  }
  for (const node of index.liveJson) {
    if (snapshotById.has(node.id)) continue;
    record('added', node.id, node.title);
  }
  return Object.freeze(counts);
}

function indexSnapshotSiblingOrder(
  snapshot: readonly CollectionTreeSnapshotNode[],
  snapshotById: ReadonlyMap<string, CollectionTreeSnapshotNode>,
): ReadonlyMap<string, ReadonlyMap<string, number>> {
  const byParent = new Map<string, Map<string, number>>();
  const nextFallbackIndex = new Map<string, number>();
  // Root or otherwise absent parents derive order from snapshot row order.
  for (const node of snapshot) {
    if (snapshotById.get(node.parentId)?.kind === 'folder') continue;
    const siblings = byParent.get(node.parentId) ?? new Map<string, number>();
    const siblingIndex = nextFallbackIndex.get(node.parentId) ?? 0;
    if (!siblings.has(node.id)) siblings.set(node.id, siblingIndex);
    nextFallbackIndex.set(node.parentId, siblingIndex + 1);
    byParent.set(node.parentId, siblings);
  }
  // Folder childIds remain authoritative, including an omitted child yielding -1.
  for (const parent of snapshot) {
    if (parent.kind !== 'folder') continue;
    const siblings = new Map<string, number>();
    for (const [siblingIndex, childId] of (parent.childIds ?? []).entries()) {
      if (!siblings.has(childId)) siblings.set(childId, siblingIndex);
    }
    byParent.set(parent.id, siblings);
  }
  return byParent;
}

export function truncateCollectionVersionChanges(
  changes: readonly CollectionVersionChange[],
): { readonly changes: readonly CollectionVersionChange[]; readonly truncated: boolean } {
  if (changes.length <= COLLECTION_VERSION_CHANGES_LIMIT) {
    return { changes, truncated: false };
  }
  return {
    changes: changes.slice(0, COLLECTION_VERSION_CHANGES_LIMIT),
    truncated: true,
  };
}

export async function captureCollectionTreeVersion(
  ports: CaptureCollectionTreeVersionPorts,
  input: CaptureCollectionTreeVersionInput,
): Promise<CaptureCollectionTreeVersionResult> {
  const existing = await ports.versions.getByCollectionAndRevision(
    input.accountId,
    input.collection.collectionId,
    input.collection.contentRevision,
  );
  if (existing) return { kind: 'existing', record: existing };

  const members = await ports.versions.loadLiveMembers(input.collection.collectionId);
  const treeJson = Object.freeze(buildCollectionTreeJson(members));
  const now = await Promise.resolve(ports.clock.now());
  const versionId = ports.ids?.nextVersionId() ?? generateOpaqueId();
  const label = normalizeLabel(input.label, now);
  const record: CollectionVersionRecord = Object.freeze({
    versionId,
    accountId: input.accountId,
    collectionId: input.collection.collectionId,
    contentRevision: input.collection.contentRevision,
    kind: input.kind,
    cause: input.cause ?? 'web',
    label,
    etag: strongEntityTag(versionId),
    nodeCount: treeJson.length,
    treeJson,
    createdAt: now,
  });

  const count = await ports.versions.count(input.accountId, input.collection.collectionId);
  if (count >= COLLECTION_TREE_VERSION_FIFO_LIMIT) {
    await ports.versions.deleteOldest(
      input.accountId,
      input.collection.collectionId,
      input.restoringVersionId,
    );
  }
  await ports.versions.insert(record);
  return { kind: 'inserted', record };
}

function normalizeLabel(label: string | undefined, createdAt: Date): string {
  if (label === undefined) return defaultCollectionVersionLabel(createdAt);
  if (typeof label !== 'string') {
    throw new CollectionVersionInputError('label is invalid.');
  }
  const trimmed = label.trim();
  if (trimmed.length < 1 || trimmed.length > 80) {
    throw new CollectionVersionInputError('label must be between 1 and 80 characters.');
  }
  return trimmed;
}
