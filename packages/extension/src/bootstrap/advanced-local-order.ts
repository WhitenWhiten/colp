import type { MountFact, LocalNodeFact, RemoteNodeFact } from './matcher.js';
import type { AdvancedParentRef, AdvancedStep } from './advanced-plan-types.js';
import {
  baseStep, desiredLocal, localState, materializedLocalChildren, nodeValue, parentRefId,
  remoteMaterializedIndex, remoteState, stableId,
} from './advanced-plan-utils.js';

export function localParentId(row: LocalNodeFact): string {
  return row.parentNativeId === null || row.parentNativeId === row.mountNativeRootId
    ? row.mountNativeRootId : row.parentNativeId;
}

function remoteParentNativeId(row: RemoteNodeFact, mounts: readonly MountFact[],
  remoteToLocal: ReadonlyMap<string, string>): string | undefined {
  if (row.parentId === null) return undefined;
  const mount = mounts.find((item) => item.remoteMountNodeId === row.parentId);
  return mount?.nativeRootId ?? remoteToLocal.get(row.parentId);
}

export function compensatedLocalCreateIndex(row: RemoteNodeFact, parent: AdvancedParentRef,
  remoteRows: readonly RemoteNodeFact[], localRows: readonly LocalNodeFact[], deleteIds: ReadonlySet<string>): number {
  const desired = remoteMaterializedIndex(row, remoteRows);
  if (parent.kind !== 'native-node') return desired;
  const siblings = materializedLocalChildren(localRows, parent.id);
  return desired + siblings.slice(0, desired + 1).filter((sibling) => deleteIds.has(sibling.nativeId)).length;
}

export function planMatchedLocalSteps(input: {
  readonly confirmationId: string;
  readonly matched: readonly { readonly nativeId: string; readonly nodeId: string }[];
  readonly localById: ReadonlyMap<string, LocalNodeFact>;
  readonly remoteById: ReadonlyMap<string, RemoteNodeFact>;
  readonly remoteRows: readonly RemoteNodeFact[];
  readonly protectedLocal: ReadonlySet<string>;
  readonly protectedRemote: ReadonlySet<string>;
  readonly parentForRemote: (row: RemoteNodeFact) => AdvancedParentRef;
}): AdvancedStep[] {
  const result: AdvancedStep[] = [];
  for (const pair of input.matched) {
    const local = input.localById.get(pair.nativeId)!; const remote = input.remoteById.get(pair.nodeId)!;
    if (input.protectedLocal.has(local.nativeId) || input.protectedRemote.has(remote.nodeId)
        || local.managed || local.privateLocal || remote.managed || remote.privateLocal) continue;
    const parent = input.parentForRemote(remote); const node = nodeValue(remote);
    const before = localState(local); const index = remoteMaterializedIndex(remote, input.remoteRows);
    const currentParent: AdvancedParentRef = { kind: 'native-node', id: localParentId(local) };
    let updateStepId: string | undefined;
    if (local.title !== remote.title || (local.url ?? '') !== (remote.url ?? '')) {
      updateStepId = stableId(input.confirmationId, 'local-update', local.nativeId);
      result.push({ ...baseStep(updateStepId, 'local', 'update', 'update', []),
        source: { nodeId: remote.nodeId, fact: remoteState(remote) },
        target: { nativeId: local.nativeId, nodeId: remote.nodeId },
        payload: { type: 'update', nativeId: local.nativeId, before: nodeValue(local), after: node }, before,
        after: desiredLocal(local.nativeId, currentParent, node, before.index) });
    }
    if (localParentId(local) === parentRefId(parent)) continue;
    const moveBefore = updateStepId
      ? { ...before, title: remote.title, ...(remote.url ? { url: remote.url } : {}) } : before;
    result.push({ ...baseStep(stableId(input.confirmationId, 'local-move', local.nativeId), 'local', 'move', 'move',
      [...(parent.kind === 'step' ? [parent.stepId] : []), ...(updateStepId ? [updateStepId] : [])]),
    source: { nodeId: remote.nodeId, fact: remoteState(remote) },
    target: { nativeId: local.nativeId, nodeId: remote.nodeId }, parent,
    payload: { type: 'move', nativeId: local.nativeId, newParent: parent, index }, before: moveBefore,
    after: desiredLocal(local.nativeId, parent, node, index) });
  }
  return result;
}

interface LocalOrderInput {
  readonly confirmationId: string;
  readonly matched: readonly { readonly nativeId: string; readonly nodeId: string }[];
  readonly localById: ReadonlyMap<string, LocalNodeFact>;
  readonly remoteById: ReadonlyMap<string, RemoteNodeFact>;
  readonly remoteToLocal: ReadonlyMap<string, string>;
  readonly remoteRows: readonly RemoteNodeFact[];
  readonly mounts: readonly MountFact[];
  readonly protectedLocal: ReadonlySet<string>;
  readonly protectedRemote: ReadonlySet<string>;
}

/** Same-parent moves are emitted after create/remove work has settled. */
export function planLocalOrderMoves(input: LocalOrderInput): Extract<AdvancedStep, { side: 'local'; action: 'move' }>[] {
  const ordered = input.matched.map((pair) => {
    const local = input.localById.get(pair.nativeId)!; const remote = input.remoteById.get(pair.nodeId)!;
    return { pair, local, remote, index: remoteMaterializedIndex(remote, input.remoteRows) };
  }).filter(({ local, remote }) => !input.protectedLocal.has(local.nativeId)
    && !input.protectedRemote.has(remote.nodeId) && !local.managed && !local.privateLocal
    && !remote.managed && !remote.privateLocal).sort((left, right) => left.index - right.index);
  return ordered.filter(({ local, remote }) => localParentId(local) === remoteParentNativeId(remote, input.mounts,
    input.remoteToLocal) && local.index !== undefined
    && local.index !== remoteMaterializedIndex(remote, input.remoteRows)).map(({ pair, local, remote, index }) => {
      const parent: AdvancedParentRef = { kind: 'native-node', id: localParentId(local) };
      const node = nodeValue(remote);
      return { ...baseStep(stableId(input.confirmationId, 'local-order-move', local.nativeId),
        'local', 'move', 'move', []), source: { nodeId: remote.nodeId, fact: remoteState(remote) },
      target: { nativeId: local.nativeId, nodeId: remote.nodeId }, parent,
      payload: { type: 'move', nativeId: local.nativeId, newParent: parent, index },
      before: localState(local), after: desiredLocal(local.nativeId, parent, node, index) };
    });
}
