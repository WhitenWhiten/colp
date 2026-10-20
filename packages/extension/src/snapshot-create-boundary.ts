import type { MappingInput, MountBindingRecord, SyncScope, createSyncStateStore } from './sync-state-store.js';

type Store = Pick<ReturnType<typeof createSyncStateStore>, 'getScope' | 'listMountBindings'>;
type Boundary = { readonly active: boolean; readonly privateRoots: ReadonlySet<string>;
  readonly mounts: readonly MountBindingRecord[]; readonly byRemote: ReadonlyMap<string, MountBindingRecord> };
type Authority = 0 | 1 | 2; // outside / mounted / private, managed or unprovable

/** Native ancestor identity proves placement, not permission to download siblings.
 * Undefined preserves the legacy single-root projector's own selected-root plan. */
export async function eligibleSnapshotCreates(store: Store, scope: SyncScope,
  mappings: readonly MappingInput[]): Promise<ReadonlySet<string> | undefined> {
  const boundary = await currentBoundary(store, scope);
  if (!boundary) return undefined;
  if (!boundary.active) return new Set();
  const byId = new Map(mappings.map(row => [row.colpId, row])), authority = new Map<string, Authority>();
  for (const row of mappings) classify(row.colpId, byId, boundary, authority);
  return new Set([...authority].filter(([, state]) => state === 1).map(([id]) => id));
}

/** Recheck only this node's ancestors before the native API call, without an
 * N-node graph scan for each of N creates. The enclosing authority checks the account. */
export async function snapshotCreateAllowed(store: Store, scope: SyncScope,
  mappings: ReadonlyMap<string, MappingInput>, colpId: string): Promise<boolean> {
  const boundary = await currentBoundary(store, scope);
  return !boundary || boundary.active && classify(colpId, mappings, boundary, new Map()) === 1;
}

async function currentBoundary(store: Store, scope: SyncScope): Promise<Boundary | undefined> {
  const mounts = await store.listMountBindings(scope);
  if (mounts.length === 0) return undefined;
  const record = await store.getScope(scope);
  return { active: record?.lifecycle === 'active' && record.rootStatus !== 'permission_required',
    privateRoots: new Set(record?.privateRoots ?? []), mounts,
    byRemote: new Map(mounts.filter(row => row.remoteMountNodeId !== null).map(row => [row.remoteMountNodeId!, row])) };
}

function classify(colpId: string, byId: ReadonlyMap<string, MappingInput>, boundary: Boundary,
  authority: Map<string, Authority>): Authority {
  const path: MappingInput[] = [], seen = new Set<string>();
  let current = byId.get(colpId), inherited: Authority = current ? 0 : 2;
  while (current) {
    const known = authority.get(current.colpId);
    if (known !== undefined) { inherited = known; break; }
    if (seen.has(current.colpId)) { inherited = 2; break; }
    seen.add(current.colpId); path.push(current);
    const parentId = current.parentColpId;
    current = parentId ? byId.get(parentId) : undefined;
    if (parentId && !current) inherited = 2;
  }
  for (const row of path.reverse()) {
    const role = row.rootRole ?? row.projection.content?.folderRole;
    const mount = boundary.byRemote.get(row.colpId) ?? boundary.mounts.find(item => item.remoteMountNodeId === null
      && item.rootRole !== undefined && item.rootRole === role && item.nativeRootId === row.nativeId);
    if (inherited === 2 || boundary.privateRoots.has(row.colpId) || role === 'managed-bookmarks') inherited = 2;
    else if (mount) inherited = mount.status === 'active' ? 1 : 0;
    authority.set(row.colpId, inherited);
  }
  return authority.get(colpId) ?? 2;
}
