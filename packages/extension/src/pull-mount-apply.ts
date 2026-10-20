import { canonicalOperationDigest } from '@know-n/colp/sync/canonical';
import type { Operation, SyncPullEventV02 } from '@know-n/colp/types';
import { mountResolveOpIdMatches } from './bootstrap/matcher.js';
import { bootstrapOpId, bootstrapRunInFlight } from './bootstrap/run-identity.js';
import { digestJson } from './bookmark-event-codec.js';
import type { PullNode } from './pull-applier-types.js';
import { mappingFor } from './pull-projection.js';
import { currentPullMapping } from './pull-mapping-view.js';
import { virtualNativeId } from './projection-native-occupancy.js';
import { isWritableActiveScope } from './scope-transition.js';
import type { BookmarkLookup } from './bookmark-api-error.js';
import { SyncFailureError } from './sync-failure-class.js';
import type { MappingInput, MountBindingRecord, ScopeRecord, SyncScope, createSyncStateStore } from './sync-state-store.js';

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

export async function planCreated(store: Store, scope: SyncScope, event: OpEvent,
  lookup?: (nativeId: string) => Promise<BookmarkLookup>): Promise<CreatedPlan> {
  const effect = event.effect;
  if (effect.kind !== 'node_created') return { kind: 'chrome' };
  const role = folderRoleOf(effect.node);
  const mounts = await store.listMountBindings(scope);
  if (effect.node.kind === 'folder' && role === undefined) {
    // A selected descendant is an ordinary canonical folder. Its exact mount
    // identity authorizes this root even when its structural parent is outside
    // the selected range; inheriting that parent's coverage would lose the
    // root's native identity before this page applies its children.
    const bound = mounts.find((mount) => mount.remoteMountNodeId === effect.node.id);
    if (bound) {
      if (bound.status !== 'active') return { kind: 'skip_unmounted' };
      return await ordinaryMountAuthority(store, scope, event, bound, lookup)
        ? { kind: 'bind_mount', mount: bound } : { kind: 'need_authority' };
    }
  }
  if (isSpecialMountRole(role) || role === 'custom') {
    const ownOpId = event.operation.replicaId === scope.replicaId ? operationOpId(event) : undefined;
    const match = matchMount(mounts, role, effect.node.id, ownOpId);
    if (match && match.status !== 'detached') return { kind: 'bind_mount', mount: match };
    const existing = await mappingByColp(store, scope, effect.node.id);
    const own = ownOpId ? await store.getQueueByOpId(scope, ownOpId) : null;
    if (existing && !isNonChromeNativeId(existing.nativeId) && existing.nodeKind === 'folder'
        && (isSpecialMountRole(role) && (existing.rootRole ?? existing.projection.content?.folderRole) === role
          || own?.status === 'terminal' && own.payload.type === 'create_node')) return { kind: 'bind_structure', mapping: existing };
    if (mounts.length > 0) return { kind: 'skip_unmounted' };
  }
  if (role === 'recovered') {
    const parentId = effect.placement.parentId;
    const parent = await mappingByColp(store, scope, parentId);
    const mount = resolveMount(mounts, parent, parentId);
    if (mount) return { kind: 'recovered_folder', mount };
    if (await isUnmountedParent(store, scope, mounts, parentId)) return { kind: 'skip_unmounted' };
    if (!parent && mounts.length > 0) return { kind: 'need_authority' };
    if (mounts.length > 0) return { kind: 'skip_unmounted' };
  }
  if (mounts.length > 0 && await isUnmountedParent(store, scope, mounts, effect.placement.parentId)) {
    return { kind: 'skip_unmounted' };
  }
  return { kind: 'chrome' };
}

/** A persisted active binding cannot restore selection or replace a contradictory identity. */
async function ordinaryMountAuthority(store: Store, scope: SyncScope, event: OpEvent, mount: MountBindingRecord,
  lookup?: (nativeId: string) => Promise<BookmarkLookup>): Promise<boolean> {
  if (event.effect.kind !== 'node_created' || !lookup) return false;
  const recorded = await store.getScope(scope);
  if (recorded?.rootStatus === 'permission_required') throw new SyncFailureError('permission_revoked');
  if (recorded?.lifecycle !== 'active' || !['ready', 'nested_normalized'].includes(recorded.rootStatus ?? '')) return false;
  const selected = recorded.selectedRoots.includes(event.effect.node.id);
  const provisional = selected ? undefined : await confirmedFirstRunMount(store, scope, event, mount, recorded);
  if (!selected && !provisional) return false;
  const mapping = await mappingByColp(store, scope, event.effect.node.id);
  const nativeMapping = await store.getMappingByNativeId(scope, mount.nativeRootId);
  if (!mapping || mapping.nativeId !== mount.nativeRootId || mapping.nodeKind !== 'folder'
      || nativeMapping?.colpId !== mapping.colpId
      || mapping.parentColpId !== undefined && mapping.parentColpId !== event.effect.placement.parentId) return false;
  const privateRoots = new Set(recorded.privateRoots ?? []);
  const privateNative = new Set([...(provisional?.boundary.excludedNativeIds ?? []), ...(provisional?.privateNativeIds ?? [])]);
  for (const id of privateRoots) {
    const root = await store.getMappingByColpId(scope, id);
    if (!root) return false;
    privateNative.add(root.nativeId);
  }
  let canonical: MappingInput | null = mapping;
  const canonicalSeen = new Set<string>();
  while (canonical) {
    if (canonicalSeen.has(canonical.colpId) || privateRoots.has(canonical.colpId)) return false;
    canonicalSeen.add(canonical.colpId);
    canonical = canonical.parentColpId ? await mappingByColp(store, scope, canonical.parentColpId) : null;
  }
  let nativeId: string | undefined = mount.nativeRootId;
  const nativeSeen = new Set<string>();
  while (nativeId && nativeId !== '0') {
    if (nativeSeen.has(nativeId) || nativeSeen.size >= 256 || privateNative.has(nativeId)
        || await store.getLocalSyncExclusion(scope, nativeId)) return false;
    nativeSeen.add(nativeId);
    const observed = await lookup(nativeId);
    if (observed.class === 'not_found') throw new SyncFailureError('pull_apply_evidence_missing');
    if (observed.class !== 'present') throw new Error(observed.message);
    const native = observed.nodes[0];
    if (!native || native.unmodifiable === 'managed' || 'folderType' in native && native.folderType === 'managed') return false;
    if (nativeId === mount.nativeRootId && native.url !== undefined) return false;
    nativeId = native.parentId;
  }
  const current = await store.getScope(scope);
  const liveMount = await store.getMountBinding(scope, mount.mountId);
  return current?.lifecycle === recorded.lifecycle && current.rootStatus === recorded.rootStatus
    && current.boundaryVersion === recorded.boundaryVersion
    && (!provisional || current.firstRun === recorded.firstRun)
    && JSON.stringify(current.selectedRoots) === JSON.stringify(recorded.selectedRoots)
    && JSON.stringify(current.privateRoots) === JSON.stringify(recorded.privateRoots)
    && liveMount?.status === 'active' && liveMount.boundaryVersion === mount.boundaryVersion
    && liveMount.nativeRootId === mount.nativeRootId && liveMount.remoteMountNodeId === mount.remoteMountNodeId;
}

/** Before first-run commits its resolved selection, only this admitted mount's
 * exact self-create receipt can bind an echo. A live binding alone is not scope. */
async function confirmedFirstRunMount(store: Store, scope: SyncScope, event: OpEvent,
  mount: MountBindingRecord, recorded: ScopeRecord) {
  if (recorded.firstRun !== 'running' || !mount.customSourceKey || event.effect.kind !== 'node_created'
      || event.operation.replicaId !== scope.replicaId) return undefined;
  const queued = await store.getQueueByOpId(scope, event.operation.opId);
  if (!queued || queued.status !== 'terminal' || queued.payload.type !== 'create_node'
      || queued.sequence !== event.operation.sequence
      || canonicalOperationDigest(queued.payload as unknown as Operation) !== event.effect.operationDigest) return undefined;
  const receipt = await store.getQueueReceipt(scope, queued.sequence);
  const results = receipt?.result?.results;
  const result = Array.isArray(results) && results.length === 1 ? results[0] : undefined;
  if (receipt?.kind !== 'terminal' || receipt.opId !== queued.opId || receipt.operationDigest !== queued.digest
      || !result || typeof result !== 'object' || Array.isArray(result) || result.opId !== queued.opId
      || result.sequence !== queued.sequence || !['applied', 'rebased'].includes(String(result.status))
      || result.targetId !== event.effect.node.id || result.revision !== event.effect.node.revision) return undefined;
  for (const run of await store.listBootstrapRuns(scope)) {
    if (run.previewOnly || !bootstrapRunInFlight(run.phase) || run.bootstrapMode !== 'merge' || !run.previewId
        || run.libraryId !== scope.collectionId || run.confirmationVersion !== mount.boundaryVersion
        || bootstrapOpId(run.confirmationId, 'mount', mount.customSourceKey) !== queued.opId) continue;
    const command = await store.getBoundaryCommand(scope, run.confirmationId);
    if (command?.kind !== 'first-run' || command.state !== 'committed' || command.result?.ok !== true
        || command.committedBoundaryVersion !== recorded.boundaryVersion || command.boundaryVersion !== run.confirmationVersion
        || command.previewId !== run.previewId || command.treeDigest !== run.treeDigest
        || command.payload.libraryId !== scope.collectionId || command.requestDigest !== digestJson({
          kind: 'known.firstRun.confirm', previewId: run.previewId, libraryId: scope.collectionId,
        })) continue;
    const preview = await store.getScopePreview(scope, run.previewId);
    if (preview && preview.kind !== 'range' && preview.consumedBy === command.commandId
        && preview.boundaryVersion === command.boundaryVersion && preview.treeDigest === command.treeDigest
        && preview.boundary.selectedNativeIds.includes(mount.nativeRootId)
        && preview.boundary.mounts.some(row => row.nativeRootId === mount.nativeRootId && row.writable
          && row.customSourceKey === mount.customSourceKey)) return preview;
  }
  return undefined;
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
  // Reading an already bound root grants no authority to rewrite its status.
  if (mount.status === 'active' && mount.remoteMountNodeId === remoteMountNodeId) return;
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

/** Structural ancestors keep their known native identity without granting subtree coverage. */
export function bindStructureMapping(node: PullNode, mapping: MappingInput, parentColpId: string, childrenRevision: string | null): MappingInput {
  return { ...mappingFor(node, mapping.nativeId, mapping.parentNativeId ?? null, parentColpId, childrenRevision, mapping.rootNativeId),
    ...(mapping.rootRole ? { rootRole: mapping.rootRole } : {}) };
}
