import { freezeScopeRecovery } from './pull-recovery-freeze.js';
import { mountResolveOpIdMatches } from './bootstrap/matcher.js';
import { isSpecialMountRole } from './pull-mount-apply.js';
import type { JsonObject, MountBindingRecord, QueueOperation, SyncScope, createSyncStateStore } from './sync-state-store.js';

/** Which mount binding an authored folder create settles onto (push worker `bindSpecialRoleMount`). */
export function createNodeFolderRole(queue: QueueOperation): string | undefined {
  if (queue.payload.type !== 'create_node') return undefined;
  const nested = queue.payload.payload;
  if (!nested || typeof nested !== 'object' || Array.isArray(nested)) return undefined;
  const node = (nested as JsonObject).node;
  if (!node || typeof node !== 'object' || Array.isArray(node)) return undefined;
  const role = (node as JsonObject).folderRole;
  return typeof role === 'string' ? role : undefined;
}
export function isAuthoredMountRole(role: string | undefined) {
  return isSpecialMountRole(role) || role === 'custom' || role === 'recovered';
}
export function usableNativeRoot(nativeId: string | undefined) {
  if (!nativeId || nativeId.startsWith('pending-') || nativeId.startsWith('recovery:')
      || nativeId.startsWith('sidecar:') || nativeId.startsWith('unmounted:')) return undefined;
  return nativeId;
}
export function matchMountByRole(mounts: readonly MountBindingRecord[], role: string | undefined, opId?: string) {
  if (isSpecialMountRole(role)) return mounts.find((mount) => mount.rootRole === role);
  if (role !== 'custom') return undefined;
  const customs = mounts.filter((mount) => mount.customSourceKey !== undefined && mount.status !== 'detached');
  if (opId) {
    const byOp = customs.find((mount) => mount.customSourceKey !== undefined
      && mountResolveOpIdMatches(opId, mount.customSourceKey));
    if (byOp) return byOp;
  }
  return undefined;
}

/** A mount receipt binds identity, never coverage outside that mount. Restarts use this same proof. */
export async function bindAuthoredMountReceipt(store: ReturnType<typeof createSyncStateStore>, scope: SyncScope,
  queue: QueueOperation, targetId: string, revision: string): Promise<void> {
  const role = createNodeFolderRole(queue);
  if (role !== undefined && !isAuthoredMountRole(role)) return;
  const mount = matchMountByRole(await store.listMountBindings(scope), role ?? 'custom', queue.opId);
  if (!mount || mount.status === 'detached' || mount.remoteMountNodeId && mount.remoteMountNodeId !== targetId) return;
  const inner = queue.payload.payload as JsonObject;
  const node = inner.node as JsonObject;
  if (node?.kind !== 'folder') return;
  const parent = typeof inner.parentId === 'string' ? await store.getMappingByColpId(scope, inner.parentId) : null;
  const promoted = await store.bindResolvedMountMapping(scope, { nativeId: mount.nativeRootId, colpId: targetId, rootNativeId: mount.nativeRootId,
    mountId: mount.mountId, nodeKind: 'folder', ...(mount.rootRole ? { rootRole: mount.rootRole } : {}),
    ...(typeof inner.parentId === 'string' ? { parentColpId: inner.parentId } : {}),
    ...(parent && usableNativeRoot(parent.nativeId) ? { parentNativeId: parent.nativeId } : {}),
    projection: { revision, childrenRevision: revision, digest: 'sha256:mount-receipt',
      content: { title: typeof node.title === 'string' ? node.title : '', ...(role ? { folderRole: role } : {}) } } });
  if (!promoted) {
    const identity = await store.getMappingByNativeId(scope, mount.nativeRootId);
    if (identity?.colpId !== targetId) {
      // The server receipt consumed its sequence but cannot overwrite a proven
      // independent identity. Preserve both records and expose the contradiction.
      await freezeScopeRecovery(store, scope, 'recovery_identity_unproven');
      return;
    }
  }
  const { scopeKey: _key, ...binding } = mount;
  await store.putMountBinding(scope, { ...binding, remoteMountNodeId: targetId, status: 'active' });
}
