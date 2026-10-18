import type { LocalNodeFact, MountFact, RemoteNodeFact } from './matcher.js';

/** Confirmed merge may pair unique custom roots; native source keys are browser-local. */
export function pairCustomMountRoots(input: {
  readonly mounts: readonly MountFact[];
  readonly rootNodeId: string | null;
  readonly localById: ReadonlyMap<string, LocalNodeFact>;
  readonly remote: readonly RemoteNodeFact[];
  readonly consumedLocal: ReadonlySet<string>;
  readonly consumedRemote: ReadonlySet<string>;
}, pair: (nativeId: string, nodeId: string) => void): void {
  if (!input.rootNodeId) return;
  const locals = new Map<string, string[]>();
  for (const mount of input.mounts) {
    if (mount.rootRole || !mount.customSourceKey || input.consumedLocal.has(mount.nativeRootId)) continue;
    const local = input.localById.get(mount.nativeRootId);
    if (!local || local.parentNativeId !== null || local.kind !== 'folder' || local.managed || local.privateLocal) continue;
    const bucket = locals.get(local.title) ?? [];
    bucket.push(local.nativeId); locals.set(local.title, bucket);
  }
  const remotes = new Map<string, string[]>();
  for (const remote of input.remote) {
    if (remote.parentId !== input.rootNodeId || remote.kind !== 'folder' || remote.folderRole !== 'custom'
        || remote.managed || remote.privateLocal || input.consumedRemote.has(remote.nodeId)) continue;
    const bucket = remotes.get(remote.title) ?? [];
    bucket.push(remote.nodeId); remotes.set(remote.title, bucket);
  }
  for (const [title, nativeIds] of locals) {
    const nodeIds = remotes.get(title) ?? [];
    if (nativeIds.length === 1 && nodeIds.length === 1) pair(nativeIds[0]!, nodeIds[0]!);
  }
}
