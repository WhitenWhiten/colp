import type { SyncPullEventV02 } from '@know-n/colp/types';
import { mountResolveOpIdMatches } from './bootstrap/matcher.js';
import type { PullNode } from './pull-applier-types.js';
import { mappingFor } from './pull-projection.js';
import { currentPullMapping } from './pull-mapping-view.js';
import { virtualNativeId } from './projection-native-occupancy.js';
import { isWritableActiveScope } from './scope-transition.js';
import type { MappingInput, MountBindingRecord, SyncScope, createSyncStateStore } from './sync-state-store.js';

export const UNMOUNTED_PREFIX = 'unmounted:';
const SPECIAL = new Set(['bookmarks-bar', 'other-bookmarks', 'mobile-bookmarks']);

type Store = ReturnType<typeof createSyncStateStore>;
type OpEvent = Extract<SyncPullEventV02, { kind: 'operation' }>;

export type CreatedPlan =
  | { readonly kind: 'chrome' }
  | { readonly kind: 'bind_mount'; readonly mount: MountBindingRecord }
  | { readonly kind: 'bind_structure'; readonly mapping: MappingInput }
  | { readonly kind: 'skip_unmounted' }
  | { readonly kind: 'need_authority' }
  | { readonly kind: 'recovered_folder'; readonly mount: MountBindingRecord };

export function isVirtualNativeId(nativeId: string) {
  return nativeId.startsWith('sidecar:') || nativeId.startsWith(UNMOUNTED_PREFIX);
}

export function isRecoveryPlaceholder(nativeId: string) {
  return nativeId.startsWith('recovery:');
}

export function folderRoleOf(node: PullNode): string | undefined {
  if (node.kind !== 'folder') return undefined;
  const role = 'folderRole' in node ? (node as { readonly folderRole?: unknown }).folderRole : undefined;
  return typeof role === 'string' ? role : undefined;
}

export function isSpecialMountRole(role: string | undefined) {
  return role !== undefined && SPECIAL.has(role);
}

export function isProtectedNativeRoot(nativeId: string, mounts: readonly MountBindingRecord[]) {
  return mounts.some((mount) => mount.nativeRootId === nativeId);
}

export function mayMutateNative(mapping: {
  readonly nativeId: string; readonly mountId?: string; readonly rootNativeId: string;
}, mounts: readonly MountBindingRecord[]): boolean {
  if (isNonChromeNativeId(mapping.nativeId) || isProtectedNativeRoot(mapping.nativeId, mounts)) return false;
  if (mounts.length === 0) return true;
  const mount = mounts.find((item) => item.mountId === mapping.mountId || item.nativeRootId === mapping.rootNativeId);
  if (mount === undefined) return false;
  return isWritableActiveScope({
    status: mount.status,
    identityKnown: mount.remoteMountNodeId !== null,
    rejoinInFlight: mount.status === 'pending',
  });
}

export function unmountedNativeId(colpId: string) {
  return `${UNMOUNTED_PREFIX}${colpId}`;
}

export async function planCreated(store: Store, scope: SyncScope, event: OpEvent): Promise<CreatedPlan> {
  if (event.effect.kind !== 'node_created') return { kind: 'chrome' };
  const role = folderRoleOf(event.effect.node);
  const mounts = await store.listMountBindings(scope);
  if (isSpecialMountRole(role) || role === 'custom') {
    const ownOpId = event.operation.replicaId === scope.replicaId ? operationOpId(event) : undefined;
    const match = matchMount(mounts, role, event.effect.node.id, ownOpId);
    if (match && match.status !== 'detached') return { kind: 'bind_mount', mount: match };
    const existing = await mappingByColp(store, scope, event.effect.node.id);
    const own = ownOpId ? await store.getQueueByOpId(scope, ownOpId) : null;
    if (existing && !isNonChromeNativeId(existing.nativeId) && existing.nodeKind === 'folder'
        && (isSpecialMountRole(role) && (existing.rootRole ?? existing.projection.content?.folderRole) === role
          || own?.status === 'terminal' && own.payload.type === 'create_node')) return { kind: 'bind_structure', mapping: existing };
    if (mounts.length > 0) return { kind: 'skip_unmounted' };
  }
  if (role === 'recovered') {
    const parentId = event.effect.placement.parentId;
    const parent = await mappingByColp(store, scope, parentId);
    const mount = resolveMount(mounts, parent, parentId);
    if (mount) return { kind: 'recovered_folder', mount };
    if (await isUnmountedParent(store, scope, mounts, parentId)) return { kind: 'skip_unmounted' };
    if (!parent && mounts.length > 0) return { kind: 'need_authority' };
    if (mounts.length > 0) return { kind: 'skip_unmounted' };
  }
  if (mounts.length > 0 && await isUnmountedParent(store, scope, mounts, event.effect.placement.parentId)) {
    return { kind: 'skip_unmounted' };
  }
  return { kind: 'chrome' };
}

export function isNonChromeNativeId(nativeId: string) {
  return virtualNativeId(nativeId);
}

export async function planRestored(store: Store, scope: SyncScope, parentId: string): Promise<
  | { readonly kind: 'chrome' }
  | { readonly kind: 'skip_unmounted' }
  | { readonly kind: 'need_authority' }
> {
  const mounts = await store.listMountBindings(scope);
  if (await isUnmountedParent(store, scope, mounts, parentId)) return { kind: 'skip_unmounted' };
  const parent = await mappingByColp(store, scope, parentId);
  if (parent && !isNonChromeNativeId(boundNativeId(parent, mounts))) return { kind: 'chrome' };
  if (!parent) return { kind: 'need_authority' };
  return { kind: 'skip_unmounted' };
}

export async function bindMountMappings(node: PullNode, mount: MountBindingRecord,
  parentColpId: string, childrenRevision: string | null): Promise<MappingInput> {
  return { ...mappingFor(node, mount.nativeRootId, null, parentColpId, childrenRevision, mount.nativeRootId),
    mountId: mount.mountId,
    ...(mount.rootRole ? { rootRole: mount.rootRole } : mount.customSourceKey ? { rootRole: 'custom' } : {}) };
}

export async function persistMountBinding(store: Store, scope: SyncScope, mount: MountBindingRecord,
  remoteMountNodeId: string): Promise<void> {
  const { scopeKey: _scopeKey, ...binding } = mount as MountBindingRecord & { readonly scopeKey?: string };
  await store.putMountBinding(scope, { ...binding, remoteMountNodeId,
    ...(binding.status === 'pending' ? { status: 'active' as const } : {}) });
}

function matchMount(mounts: readonly MountBindingRecord[], role: string | undefined, colpId: string,
  opId?: string) {
  if (isSpecialMountRole(role)) return mounts.find((mount) => mount.rootRole === role);
  if (role !== 'custom') return undefined;
  const customs = mounts.filter((mount) => mount.customSourceKey !== undefined && mount.status !== 'detached');
  const byRemote = customs.find((mount) => mount.remoteMountNodeId === colpId);
  if (byRemote) return byRemote;
  if (!opId) return undefined;
  // Native ids (and folder:<id> keys) are only meaningful inside one browser.
  // Only our unresolved mount may be claimed by our own bootstrap operation.
  return customs.find((mount) => mount.status === 'pending' && mount.remoteMountNodeId === null
    && mount.customSourceKey !== undefined && mountResolveOpIdMatches(opId, mount.customSourceKey));
}

function operationOpId(event: OpEvent): string | undefined {
  const opId = event.operation?.opId;
  return typeof opId === 'string' ? opId : undefined;
}

function resolveMount(mounts: readonly MountBindingRecord[], parent: MappingInput | null, parentId: string) {
  return provenOwningMount(mounts.filter((mount) => mount.status === 'active'), parent, parentId);
}

/** Recovered is unique per owning mount. A single local mount is not proof (S-01 / FRR-05). */
function provenOwningMount(mounts: readonly MountBindingRecord[], parent: MappingInput | null, parentId: string) {
  const byRemote = mounts.find((mount) => mount.remoteMountNodeId === parentId
    || (parent !== null && mount.remoteMountNodeId === parent.colpId));
  if (byRemote) return byRemote;
  if (!parent || parent.projection.content?.folderRole === 'root') return undefined;
  const resolved = boundNativeId(parent, mounts);
  return mounts.find((mount) => mount.nativeRootId === parent.rootNativeId || mount.nativeRootId === resolved
    || (parent.mountId !== undefined && mount.mountId === parent.mountId));
}

async function isUnmountedParent(store: Store, scope: SyncScope, mounts: readonly MountBindingRecord[],
  parentId: string): Promise<boolean> {
  if (mounts.length === 0) return false;
  const bound = mounts.find((mount) => mount.remoteMountNodeId === parentId);
  if (bound) return bound.status !== 'active';
  const parent = await mappingByColp(store, scope, parentId);
  if (parent && isVirtualNativeId(parent.nativeId)) return true;
  if (!parent) return false;
  return !mounts.some((mount) => mount.status === 'active' && mount.nativeRootId === parent.rootNativeId);
}

async function mappingByColp(store: Store, scope: SyncScope, colpId: string) {
  return currentPullMapping(store, scope, colpId);
}

export function boundNativeId(mapping: MappingInput, mounts: readonly MountBindingRecord[]): string {
  if (!isRecoveryPlaceholder(mapping.nativeId)) return mapping.nativeId;
  const role = mapping.rootRole
    ?? (typeof mapping.projection.content?.folderRole === 'string' ? mapping.projection.content.folderRole : undefined);
  const mount = mounts.find((item) => item.status !== 'detached' && mountMatchesMapping(item, mapping, role));
  return mount?.nativeRootId ?? mapping.nativeId;
}

function mountMatchesMapping(item: MountBindingRecord, mapping: MappingInput, role: string | undefined): boolean {
  if (item.remoteMountNodeId === mapping.colpId) return true;
  // mountId is inherited by descendants; it does not make them the root.
  if (isSpecialMountRole(role) && item.rootRole === role) return true;
  return false;
}
