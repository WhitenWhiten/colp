/**
 * Persist the dest-side parent-first subtree before any Chrome create so a
 * restart never treats an empty dest folder as success.
 */
import { digest } from './pull-codec.js';
import type { JsonObject, JsonValue, MappingInput, MountBindingRecord, ScopeCommandPlanRecord } from './sync-state-store.js';

export interface IndependentSubtreeNode {
  readonly colpId: string;
  readonly parentColpId?: string;
  readonly nodeKind: NonNullable<MappingInput['nodeKind']>;
  readonly sourceNativeId: string;
  readonly position: number;
  readonly revision: string;
  readonly childrenRevision?: string | null;
  readonly content?: JsonObject;
}

export interface IndependentMaterializePlan {
  readonly commandId: string;
  readonly sourceMountId: string | null;
  readonly destMountId: string | null;
  readonly sourceBoundaryVersion: string | null;
  readonly destBoundaryVersion: string | null;
  readonly nodes: readonly IndependentSubtreeNode[];
}

type Store = {
  putScopeCommandPlan(scope: import('./sync-state-store.js').SyncScope,
    row: Omit<ScopeCommandPlanRecord, 'scopeKey'>): Promise<ScopeCommandPlanRecord>;
  getApplyIntent(scope: import('./sync-state-store.js').SyncScope, intentId: string): Promise<{
    readonly anchors?: JsonObject;
  } | null>;
  persistApplyIntentFacts(scope: import('./sync-state-store.js').SyncScope, intentId: string, patch: {
    readonly anchors?: JsonObject;
  }): Promise<unknown>;
};

export function buildIndependentPlan(input: {
  readonly mapping: MappingInput; readonly parent: MappingInput; readonly subtree: readonly MappingInput[];
  readonly plan: {
    readonly commandId: string; readonly sourceBoundaryVersion: string | null;
    readonly destBoundaryVersion: string | null;
  };
  readonly mounts: readonly MountBindingRecord[];
}): IndependentMaterializePlan {
  const source = mountFor(input.mapping, input.mounts);
  const dest = mountFor(input.parent, input.mounts);
  const siblings = new Map<string, MappingInput[]>();
  for (const row of input.subtree) {
    const parentId = row.colpId === input.mapping.colpId ? input.parent.colpId : row.parentColpId ?? '';
    const group = siblings.get(parentId) ?? [];
    group.push(row);
    siblings.set(parentId, group);
  }
  const nodes: IndependentSubtreeNode[] = input.subtree.map((row) => {
    const destParent = row.colpId === input.mapping.colpId ? input.parent.colpId : row.parentColpId;
    const group = siblings.get(destParent ?? '') ?? [];
    return {
      colpId: row.colpId,
      ...(destParent ? { parentColpId: destParent } : {}),
      nodeKind: row.nodeKind ?? 'bookmark',
      sourceNativeId: row.nativeId,
      position: group.findIndex((item) => item.colpId === row.colpId),
      revision: row.projection.revision,
      childrenRevision: row.projection.childrenRevision,
      ...(row.projection.content ? { content: row.projection.content } : {}),
    };
  });
  return {
    commandId: input.plan.commandId,
    sourceMountId: source?.mountId ?? null,
    destMountId: dest?.mountId ?? null,
    sourceBoundaryVersion: input.plan.sourceBoundaryVersion,
    destBoundaryVersion: input.plan.destBoundaryVersion,
    nodes: parentFirstNodes(nodes, input.parent.colpId),
  };
}

export function parentFirstNodes(nodes: readonly IndependentSubtreeNode[], destParentColpId: string):
  IndependentSubtreeNode[] {
  const remaining = new Set(nodes);
  const ordered: IndependentSubtreeNode[] = [];
  const placed = new Set<string>([destParentColpId]);
  while (remaining.size) {
    const ready = [...remaining].filter((row) => !row.parentColpId || placed.has(row.parentColpId)
      || ![...remaining].some((other) => other.colpId === row.parentColpId))
      .sort((left, right) => folderRank(left) - folderRank(right)
        || left.position - right.position || left.colpId.localeCompare(right.colpId));
    if (!ready.length) {
      ordered.push(...[...remaining].sort((left, right) => left.colpId.localeCompare(right.colpId)));
      break;
    }
    for (const row of ready) { remaining.delete(row); ordered.push(row); placed.add(row.colpId); }
  }
  return ordered;
}

export function planFromAnchors(anchors: JsonObject | undefined, fallback: IndependentMaterializePlan):
  IndependentMaterializePlan {
  const raw = anchors?.nodes;
  if (!Array.isArray(raw) || raw.length === 0) return fallback;
  const nodes = raw.map(parseNode).filter((row): row is IndependentSubtreeNode => row !== null);
  if (!nodes.length) return fallback;
  return {
    commandId: typeof anchors?.subtreeCommandId === 'string' ? anchors.subtreeCommandId : fallback.commandId,
    sourceMountId: stringOrNull(anchors?.sourceMountId) ?? fallback.sourceMountId,
    destMountId: stringOrNull(anchors?.destMountId) ?? fallback.destMountId,
    sourceBoundaryVersion: fallback.sourceBoundaryVersion,
    destBoundaryVersion: fallback.destBoundaryVersion,
    nodes,
  };
}

export function subtreeAnchors(plan: IndependentMaterializePlan): JsonObject {
  return {
    subtreeCommandId: plan.commandId,
    ...(plan.sourceMountId ? { sourceMountId: plan.sourceMountId } : {}),
    ...(plan.destMountId ? { destMountId: plan.destMountId } : {}),
    nodes: plan.nodes.map((row) => ({
      colpId: row.colpId, nodeKind: row.nodeKind, sourceNativeId: row.sourceNativeId,
      position: row.position, revision: row.revision,
      ...(row.parentColpId ? { parentColpId: row.parentColpId } : {}),
      ...(row.childrenRevision === undefined ? {} : { childrenRevision: row.childrenRevision }),
      ...(row.content ? { content: row.content } : {}),
    })),
  };
}

export async function persistIndependentPlan(store: Store, scope: import('./sync-state-store.js').SyncScope,
  eventId: string, plan: IndependentMaterializePlan, now: number): Promise<void> {
  await store.putScopeCommandPlan(scope, {
    commandId: plan.commandId, kind: 'rangeExit',
    confirmationVersion: plan.destBoundaryVersion ?? plan.sourceBoundaryVersion ?? '0',
    baselineDigest: digest(plan.nodes.map((row) => row.colpId)), phase: 'applying',
    dependencies: plan.nodes.map((row) => row.colpId), updatedAt: now,
    ...(plan.sourceMountId ? { mountId: plan.sourceMountId } : {}),
  });
  const intent = await store.getApplyIntent(scope, `intent:${eventId}`);
  if (!intent) return;
  await store.persistApplyIntentFacts(scope, `intent:${eventId}`, {
    anchors: { ...(intent.anchors ?? {}), ...subtreeAnchors(plan) },
  });
}

function parseNode(value: JsonValue): IndependentSubtreeNode | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (typeof value.colpId !== 'string' || typeof value.sourceNativeId !== 'string') return null;
  const nodeKind = value.nodeKind === 'folder' || value.nodeKind === 'separator' ? value.nodeKind : 'bookmark';
  const content = value.content && typeof value.content === 'object' && !Array.isArray(value.content)
    ? value.content as JsonObject : undefined;
  return {
    colpId: value.colpId, sourceNativeId: value.sourceNativeId, nodeKind,
    position: typeof value.position === 'number' ? value.position : 0,
    revision: typeof value.revision === 'string' ? value.revision : 'revision-0',
    ...(typeof value.parentColpId === 'string' ? { parentColpId: value.parentColpId } : {}),
    ...(value.childrenRevision === null || typeof value.childrenRevision === 'string'
      ? { childrenRevision: value.childrenRevision } : {}),
    ...(content ? { content } : {}),
  };
}

function mountFor(mapping: MappingInput, mounts: readonly MountBindingRecord[]) {
  return mounts.find((item) => item.mountId === mapping.mountId || item.nativeRootId === mapping.rootNativeId);
}

function folderRank(node: IndependentSubtreeNode): number {
  return node.nodeKind === 'folder' ? 0 : 1;
}

function stringOrNull(value: JsonValue | undefined): string | null {
  return typeof value === 'string' ? value : null;
}
