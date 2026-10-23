import { virtualNativeId } from '../projection-native-occupancy.js';
import { bootstrapOpId, type PlannedOperation, type RemoteNodeFact } from './matcher.js';
import type { JsonObject, MappingInput, MountBindingRecord, QueueOperation, RecoveryNodeRecord } from '../sync-state-store.js';

export function authoritativeColp(id: string | undefined | null): id is string {
  return typeof id === 'string' && !id.startsWith('mount:') && !id.startsWith('pending-');
}

export function placeholderOccupant(nativeId: string): boolean {
  return virtualNativeId(nativeId) && !nativeId.startsWith('pending-');
}

export function mountNeedsRemote(mount: Pick<MountBindingRecord, 'status' | 'rootRole' | 'customSourceKey' | 'remoteMountNodeId'>): boolean {
  if (mount.status === 'detached') return false;
  if (!mount.rootRole && !mount.customSourceKey) return false;
  return !authoritativeColp(mount.remoteMountNodeId) || mount.status === 'pending';
}

export function mountRemoteFromReceipt(mount: MountBindingRecord, mappingColpId: string | undefined,
  queued: readonly QueueOperation[],
  receiptsByOpId: ReadonlyMap<string, { readonly opId: string; readonly result?: JsonObject }>,
  confirmationId: string): string | null {
  if (mappingColpId?.startsWith('pending-')) {
    const fromMapping = receiptTargetId(receiptsByOpId.get(mappingColpId.slice('pending-'.length)));
    if (fromMapping) return fromMapping;
  }
  const key = mount.rootRole ?? mount.customSourceKey;
  const expectedOpId = key ? bootstrapOpId(confirmationId, 'mount', key) : null;
  for (const op of queued) {
    if (op.status !== 'terminal' || op.payload.type !== 'create_node') continue;
    const inner = op.payload.payload;
    if (!inner || typeof inner !== 'object' || Array.isArray(inner)) continue;
    const node = (inner as JsonObject).node;
    if (!node || typeof node !== 'object' || Array.isArray(node)) continue;
    const folderRole = (node as JsonObject).folderRole;
    const opMatches = expectedOpId !== null && op.opId === expectedOpId;
    if (mount.rootRole) {
      if (folderRole !== mount.rootRole && !opMatches) continue;
    } else if (!mount.customSourceKey || !opMatches) continue;
    const targetId = receiptTargetId(receiptsByOpId.get(op.opId));
    if (targetId) return targetId;
  }
  return null;
}

export function receiptTargetId(receipt: { readonly result?: JsonObject } | undefined): string | null {
  const results = receipt?.result?.results;
  if (!Array.isArray(results) || !results[0] || typeof results[0] !== 'object' || Array.isArray(results[0])) {
    return null;
  }
  const targetId = (results[0] as JsonObject).targetId;
  return typeof targetId === 'string' && authoritativeColp(targetId) ? targetId : null;
}

export function operationPayload(op: PlannedOperation, occurredAt: string): QueueOperation['payload'] {
  if (op.type === 'create_node') {
    return { type: 'create_node', opId: op.opId, baseRevision: null, occurredAt, dependencies: [],
      payload: { parentId: op.parentId ?? '', afterId: null, beforeId: null, node: op.node ?? { kind: 'folder', title: '' } } };
  }
  if (op.type === 'update_node_content') {
    return { type: 'update_node_content', opId: op.opId, targetId: op.targetId ?? '', baseRevision: 'revision-0',
      occurredAt, dependencies: [], payload: { base: {}, value: op.node ?? {} } };
  }
  if (op.type === 'move_node') {
    return { type: 'move_node', opId: op.opId, targetId: op.targetId ?? '', baseRevision: 'revision-0', occurredAt,
      dependencies: [], payload: { newParentId: op.parentId ?? '', afterId: null, beforeId: null } };
  }
  // Unreachable destructive-bootstrap fallback (see `matcher.ts` planned
  // deletes): it must become kind-aware before that path can be enabled.
  return { type: 'delete_node', opId: op.opId, targetId: op.targetId ?? '', baseRevision: 'revision-0', occurredAt,
    dependencies: [], payload: { reason: 'bootstrap_destructive' } };
}

export function remoteFromRecovery(node: RecoveryNodeRecord): RemoteNodeFact {
  return remoteFactFromProjection(node.colpId, node.parentId, node.kind === 'Bookmark' ? 'bookmark'
    : node.kind === 'Separator' ? 'separator' : 'folder', node.mapping);
}

export function liveRemoteFromMapping(mapping: MappingInput): RemoteNodeFact[] {
  if (mapping.projection.revision === 'local-root' || !authoritativeColp(mapping.colpId) || mapping.colpId.startsWith('unmounted:')
      || mapping.nativeId.startsWith('unmounted:') || mapping.nativeId.startsWith('pending-')) {
    return [];
  }
  const kind = mapping.nodeKind === 'bookmark' ? 'bookmark'
    : mapping.nodeKind === 'separator' ? 'separator' : 'folder';
  return [remoteFactFromProjection(mapping.colpId, mapping.parentColpId ?? null, kind, mapping)];
}

export function remoteFactFromProjection(nodeId: string, parentId: string | null, kind: RemoteNodeFact['kind'],
  mapping: MappingInput): RemoteNodeFact {
  const content = mapping.projection.content ?? {};
  const folderRole = mapping.rootRole
    ?? (typeof content.folderRole === 'string' ? content.folderRole : undefined);
  return {
    nodeId, parentId, kind,
    title: typeof content.title === 'string' ? content.title : '',
    ...(typeof content.url === 'string' ? { url: content.url } : {}),
    ...(folderRole ? { folderRole } : {}), revision: mapping.projection.revision,
  };
}
