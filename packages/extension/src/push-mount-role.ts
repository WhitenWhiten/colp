import { mountResolveOpIdMatches } from './bootstrap/matcher.js';
import { isSpecialMountRole } from './pull-mount-apply.js';
import type { JsonObject, MountBindingRecord, QueueOperation } from './sync-state-store.js';

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
