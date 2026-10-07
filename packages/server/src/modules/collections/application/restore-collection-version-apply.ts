import { randomUUID } from 'node:crypto';
import { assertCanonicalCommandId, canonicalCommandFingerprint } from '../../commands/index.js';
import { NodeConflictError, strongEntityTag } from '../domain/index.js';
import {
  orderedSnapshotChildIds,
  type CollectionTreeLiveMember,
  type CollectionTreeSnapshotNode,
  type CollectionVersionLockedCollection,
} from './capture-collection-tree-version.js';
import type { CreateCollectionVersionResult } from './create-collection-version.js';
import {
  deleteCollectionNode,
  deleteCollectionNodeCommandScope,
  type DeleteCollectionNodeResult,
} from './delete-collection-node.js';
import {
  moveCollectionNode,
  moveCollectionNodeCommandScope,
  type MoveCollectionNodeResult,
} from './move-collection-node.js';
import type { ProductCollectionCanonicalPorts } from './ports.js';
import {
  childOnPath,
  isCurrentDescendant,
  requireLiveFolder,
  requireLiveNode,
  type RestoreLiveNodeLookup,
} from './restore-collection-version-live-nodes.js';
import {
  updateCollectionNode,
  updateCollectionNodeCommandScope,
  type UpdateCollectionNodeResult,
} from './update-collection-node.js';

export class RestoreCollectionVersionInnerCommandError extends Error {
  readonly outcome: Exclude<CreateCollectionVersionResult, { readonly kind: 'succeeded' }>;

  constructor(outcome: Exclude<CreateCollectionVersionResult, { readonly kind: 'succeeded' }>) {
    super(`collection-version restore inner command ${outcome.kind}`);
    this.name = 'RestoreCollectionVersionInnerCommandError';
    this.outcome = outcome;
  }
}

type RestoreMutatePorts = {
  readonly mutations: ProductCollectionCanonicalPorts;
  readonly commandIds?: { next(): string };
};

type RestoreActor = {
  readonly principalId: string;
  readonly principalType: 'account';
  readonly subjectId: string;
};

type MoveInner = { moveCommandIds: string[] };
type UpdateInner = { updateCommandIds: string[] };
type DeleteInner = { deleteCommandIds: string[] };

export async function applyParentChanges(
  ports: RestoreMutatePorts,
  actor: RestoreActor,
  collection: CollectionVersionLockedCollection,
  snapshot: readonly CollectionTreeSnapshotNode[],
  inner: MoveInner,
  movedNodeIds: string[],
  liveNodes: RestoreLiveNodeLookup,
): Promise<void> {
  for (const node of snapshot) {
    const live = await requireLiveNode(liveNodes, collection.collectionId, node.id);
    if (live.parentId === node.parentId) continue;
    await breakCycleIfNeeded(ports, actor, collection, node.id, node.parentId, inner, movedNodeIds, liveNodes);
    const current = await requireLiveNode(liveNodes, collection.collectionId, node.id);
    if (current.parentId === node.parentId) continue;
    await moveOnce(ports, actor, collection, node.id, node.parentId, null, inner, liveNodes);
    remember(movedNodeIds, node.id);
  }
}

async function breakCycleIfNeeded(
  ports: RestoreMutatePorts,
  actor: RestoreActor,
  collection: CollectionVersionLockedCollection,
  nodeId: string,
  targetParentId: string,
  inner: MoveInner,
  movedNodeIds: string[],
  liveNodes: RestoreLiveNodeLookup,
): Promise<void> {
  while (
    targetParentId === nodeId
    || await isCurrentDescendant(liveNodes, collection.collectionId, nodeId, targetParentId)
  ) {
    const current = await requireLiveNode(liveNodes, collection.collectionId, nodeId);
    if (current.parentId !== collection.rootNodeId) {
      await moveOnce(ports, actor, collection, nodeId, collection.rootNodeId, null, inner, liveNodes);
      remember(movedNodeIds, nodeId);
    }
    if (!(await isCurrentDescendant(liveNodes, collection.collectionId, nodeId, targetParentId))) break;
    const parked = await childOnPath(liveNodes, collection.collectionId, nodeId, targetParentId);
    if (!parked || parked === nodeId) {
      throw new NodeConflictError('revision_conflict', 'Unable to break a restore parent cycle.');
    }
    await moveOnce(ports, actor, collection, parked, collection.rootNodeId, null, inner, liveNodes);
    remember(movedNodeIds, parked);
  }
}

export async function applySiblingOrder(
  ports: RestoreMutatePorts,
  actor: RestoreActor,
  collection: CollectionVersionLockedCollection,
  snapshot: readonly CollectionTreeSnapshotNode[],
  inner: MoveInner,
  movedNodeIds: string[],
  liveNodes: RestoreLiveNodeLookup,
): Promise<void> {
  const snapshotById = new Map(snapshot.map((node) => [node.id, node]));
  const parentIds = [collection.rootNodeId];
  for (const node of snapshot) {
    if (node.kind === 'folder') parentIds.push(node.id);
  }
  for (const parentId of parentIds) {
    const desired = orderedSnapshotChildIds(snapshot, parentId, snapshotById);
    let siblings = await ports.mutations.nodes.listLiveSiblingPositions(collection.collectionId, parentId);
    const liveDesired = siblings.map((row) => row.id).filter((id) => desired.includes(id));
    if (liveDesired.length === desired.length && liveDesired.every((id, index) => id === desired[index])) {
      continue;
    }
    for (const [index, nodeId] of desired.entries()) {
      const afterId = index === 0 ? null : desired[index - 1]!;
      const currentDesired = siblings.map((row) => row.id).filter((id) => desired.includes(id));
      if (currentDesired[index] === nodeId) continue;
      await moveOnce(ports, actor, collection, nodeId, parentId, afterId, inner, liveNodes);
      remember(movedNodeIds, nodeId);
      siblings = await ports.mutations.nodes.listLiveSiblingPositions(collection.collectionId, parentId);
    }
  }
}

export async function applyFieldUpdates(
  ports: RestoreMutatePorts,
  actor: RestoreActor,
  collectionId: string,
  snapshot: readonly CollectionTreeSnapshotNode[],
  inner: UpdateInner,
  updatedNodeIds: string[],
  liveNodes: RestoreLiveNodeLookup,
): Promise<void> {
  for (const node of snapshot) {
    const live = await requireLiveNode(liveNodes, collectionId, node.id);
    const titleChanged = live.title !== node.title;
    const urlChanged = node.kind === 'bookmark' && live.url !== node.url;
    if (!titleChanged && !urlChanged) continue;
    const ifMatch = strongEntityTag(live.resourceRevision);
    const patch = {
      ...(titleChanged ? { title: node.title } : {}),
      ...(urlChanged ? { url: node.url ?? undefined } : {}),
    };
    const commandId = nextCommandId(ports);
    inner.updateCommandIds.push(commandId);
    const result = await updateCollectionNode(ports.mutations, {
      actor,
      command: {
        commandId,
        fingerprint: restoreInternalUpdateFingerprint({ collectionId, nodeId: node.id, ifMatch, patch }),
        commandScope: updateCollectionNodeCommandScope(collectionId, node.id),
      },
      collectionId,
      nodeId: node.id,
      ifMatch,
      patch,
    });
    assertUpdateSucceeded(result);
    updatedNodeIds.push(node.id);
    liveNodes.invalidateTouched([node.id], []);
  }
}

export async function applyDeletes(
  ports: RestoreMutatePorts,
  actor: RestoreActor,
  collection: CollectionVersionLockedCollection,
  snapshot: readonly CollectionTreeSnapshotNode[],
  initialLive: readonly CollectionTreeLiveMember[],
  inner: DeleteInner,
  deletedNodeIds: string[],
  liveNodes: RestoreLiveNodeLookup,
): Promise<void> {
  const needed = new Set(snapshot.map((node) => node.id));
  const extras = initialLive.filter((member) => !needed.has(member.id));
  const bookmarks = extras.filter((member) => member.kind === 'bookmark');
  const parentById = new Map(initialLive.map((row) => [row.id, row]));
  const folders = extras
    .filter((member) => member.kind === 'folder')
    .sort((left, right) =>
      depthFrom(right, parentById, collection.rootNodeId) - depthFrom(left, parentById, collection.rootNodeId));
  for (const node of [...bookmarks, ...folders]) {
    if (node.id === collection.rootNodeId) continue;
    if (node.kind === 'folder') {
      const children = await ports.mutations.nodes.listLiveSiblingPositions(
        collection.collectionId,
        node.id,
      );
      if (children.some((child) => needed.has(child.id))) {
        throw new NodeConflictError(
          'revision_conflict',
          'Restore cannot delete a folder that still holds snapshot nodes.',
        );
      }
    }
    const live = await requireLiveNode(liveNodes, collection.collectionId, node.id);
    const ifMatch = strongEntityTag(live.resourceRevision);
    const commandId = nextCommandId(ports);
    inner.deleteCommandIds.push(commandId);
    const result = await deleteCollectionNode(ports.mutations, {
      actor,
      command: {
        commandId,
        fingerprint: restoreInternalDeleteFingerprint({
          collectionId: collection.collectionId,
          nodeId: node.id,
          ifMatch,
        }),
        commandScope: deleteCollectionNodeCommandScope(collection.collectionId, node.id),
      },
      collectionId: collection.collectionId,
      nodeId: node.id,
      ifMatch,
      recursive: false,
    });
    assertDeleteSucceeded(result);
    deletedNodeIds.push(node.id);
    liveNodes.invalidateTouched([node.id], [live.parentId]);
  }
}

async function moveOnce(
  ports: RestoreMutatePorts,
  actor: RestoreActor,
  collection: CollectionVersionLockedCollection,
  nodeId: string,
  newParentId: string,
  afterId: string | null,
  inner: MoveInner,
  liveNodes: RestoreLiveNodeLookup,
): Promise<void> {
  const node = await requireLiveNode(liveNodes, collection.collectionId, nodeId);
  if (node.parentId === null) {
    throw new NodeConflictError('revision_conflict', 'Restore cannot move a node without a parent.');
  }
  const sourceParent = await requireLiveFolder(liveNodes, collection.collectionId, node.parentId);
  const targetParent = node.parentId === newParentId
    ? sourceParent
    : await requireLiveFolder(liveNodes, collection.collectionId, newParentId);
  const ifMatch = strongEntityTag(node.resourceRevision);
  const commandId = nextCommandId(ports);
  inner.moveCommandIds.push(commandId);
  const result = await moveCollectionNode(ports.mutations, {
    actor,
    command: {
      commandId,
      fingerprint: restoreInternalMoveFingerprint({
        collectionId: collection.collectionId,
        nodeId,
        ifMatch,
        newParentId,
        afterId,
        baseSourceParentRevision: sourceParent.childrenRevision,
        baseTargetParentRevision: targetParent.childrenRevision,
      }),
      commandScope: moveCollectionNodeCommandScope(collection.collectionId, nodeId),
    },
    collectionId: collection.collectionId,
    nodeId,
    ifMatch,
    newParentId,
    afterId,
    beforeId: null,
    baseSourceParentRevision: sourceParent.childrenRevision,
    baseTargetParentRevision: targetParent.childrenRevision,
  });
  assertMoveSucceeded(result);
  liveNodes.invalidateTouched([nodeId], [node.parentId, newParentId]);
}

function depthFrom(
  member: CollectionTreeLiveMember,
  byId: ReadonlyMap<string, CollectionTreeLiveMember>,
  rootId: string,
): number {
  let current: CollectionTreeLiveMember | undefined = member;
  let value = 0;
  const seen = new Set<string>();
  while (current && current.parentId && current.parentId !== rootId) {
    if (seen.has(current.parentId)) break;
    seen.add(current.parentId);
    current = byId.get(current.parentId);
    value += 1;
  }
  return value;
}

function nextCommandId(ports: RestoreMutatePorts): string {
  return assertCanonicalCommandId(ports.commandIds?.next() ?? randomUUID());
}

function remember(ids: string[], id: string): void {
  if (!ids.includes(id)) ids.push(id);
}

function restoreInternalUpdateFingerprint(input: {
  readonly collectionId: string;
  readonly nodeId: string;
  readonly ifMatch: string;
  readonly patch: { readonly title?: string; readonly url?: string };
}): string {
  return canonicalCommandFingerprint({
    method: 'PATCH',
    route: `/api/v1/collections/${input.collectionId}/nodes/${input.nodeId}`,
    mediaType: 'application/merge-patch+json',
    body: input.patch,
    query: {},
    conditions: { ifMatch: input.ifMatch },
  });
}

function restoreInternalMoveFingerprint(input: {
  readonly collectionId: string;
  readonly nodeId: string;
  readonly ifMatch: string;
  readonly newParentId: string;
  readonly afterId: string | null;
  readonly baseSourceParentRevision: string;
  readonly baseTargetParentRevision: string;
}): string {
  return canonicalCommandFingerprint({
    method: 'POST',
    route: `/api/v1/collections/${input.collectionId}/nodes/${input.nodeId}/move`,
    mediaType: 'application/json',
    body: {
      newParentId: input.newParentId,
      afterId: input.afterId,
      beforeId: null,
      baseSourceParentRevision: input.baseSourceParentRevision,
      baseTargetParentRevision: input.baseTargetParentRevision,
    },
    query: {},
    conditions: { ifMatch: input.ifMatch },
  });
}

function restoreInternalDeleteFingerprint(input: {
  readonly collectionId: string;
  readonly nodeId: string;
  readonly ifMatch: string;
}): string {
  return canonicalCommandFingerprint({
    method: 'DELETE',
    route: `/api/v1/collections/${input.collectionId}/nodes/${input.nodeId}`,
    mediaType: '',
    body: null,
    query: { recursive: 'false' },
    conditions: { ifMatch: input.ifMatch },
  });
}

function assertUpdateSucceeded(result: UpdateCollectionNodeResult): void {
  if (result.kind === 'updated') return;
  if (result.kind === 'replay' && result.status >= 200 && result.status < 300) return;
  throw innerOutcome(result);
}

function assertMoveSucceeded(result: MoveCollectionNodeResult): void {
  if (result.kind === 'moved') return;
  if (result.kind === 'replay' && result.status >= 200 && result.status < 300) return;
  throw innerOutcome(result);
}

function assertDeleteSucceeded(result: DeleteCollectionNodeResult): void {
  if (result.kind === 'deleted') return;
  if (result.kind === 'replay' && result.status >= 200 && result.status < 300) return;
  throw innerOutcome(result);
}

function innerOutcome(
  result: UpdateCollectionNodeResult | MoveCollectionNodeResult | DeleteCollectionNodeResult,
): RestoreCollectionVersionInnerCommandError {
  switch (result.kind) {
    case 'updated':
    case 'moved':
    case 'deleted':
      throw new Error('unhandled restore inner command outcome');
    case 'in_progress':
      return new RestoreCollectionVersionInnerCommandError({
        kind: 'in_progress',
        retryAfterSeconds: result.retryAfterSeconds,
      });
    case 'replay':
      return new RestoreCollectionVersionInnerCommandError({
        kind: 'replay',
        status: result.status,
        body: result.body,
        stableHeaders: result.stableHeaders,
        mediaType: result.mediaType,
      });
    case 'reused':
      return new RestoreCollectionVersionInnerCommandError({ kind: 'reused' });
    case 'expired':
      return new RestoreCollectionVersionInnerCommandError({ kind: 'expired' });
    default: {
      const _exhaustive: never = result;
      return _exhaustive;
    }
  }
}
