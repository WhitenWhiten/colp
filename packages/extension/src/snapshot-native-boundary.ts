import { lookupBookmark } from './bookmark-api-error.js';
import { virtualNativeId } from './projection-native-occupancy.js';
import { SyncFailureError } from './sync-failure-class.js';
import type { PullBookmarkApi } from './pull-applier-types.js';
import type { MappingInput, SyncScope, createSyncStateStore } from './sync-state-store.js';

type Store = Pick<ReturnType<typeof createSyncStateStore>, 'getScope' | 'listMountBindings' | 'getMappingByColpId'>;
interface Input {
  readonly store: Store; readonly scope: SyncScope; readonly api: Pick<PullBookmarkApi, 'get'>;
  /** The actual create parent, or the exact durable delete target. */
  readonly mapping: MappingInput;
  readonly kind: 'create' | 'delete';
  readonly legacyRootNativeId: string;
}

/** A Snapshot proves remote placement, not current native ancestry. Check at
 * the actual call, including resumed deletes and parents moved by the user
 * before their browser event reaches the durable queue. */
export async function assertSnapshotNativeBoundary(input: Input): Promise<void> {
  const before = await boundary(input);
  const seen = new Set<string>(); let nativeId: string | undefined = input.mapping.nativeId;
  let reachedRoot = false;
  while (nativeId !== undefined) {
    if (seen.has(nativeId) || seen.size >= 256 || before.privateNativeIds.has(nativeId)) deny();
    seen.add(nativeId);
    const observed = await lookupBookmark(id => input.api.get(id), nativeId);
    if (observed.class === 'not_found') deny();
    if (observed.class !== 'present') throw new Error(observed.message);
    const node = observed.nodes[0];
    if (observed.nodes.length !== 1 || !node || node.id !== nativeId || node.unmodifiable) deny();
    if (input.kind === 'create' && nativeId === input.mapping.nativeId && node.url !== undefined) deny();
    if (nativeId === before.rootNativeId) reachedRoot = true;
    // Continue above the selected root: a custom mount itself may have moved
    // into a private or managed ancestor since the Snapshot was planned.
    nativeId = node.parentId;
  }
  if (!reachedRoot) deny();
  // Native reads yield to range/classification changes. A changed boundary
  // needs a fresh decision; it cannot authorize the old native call.
  if ((await boundary(input)).identity !== before.identity) deny();
}

async function boundary(input: Input) {
  const { store, scope, mapping, kind } = input;
  const [record, mounts, current] = await Promise.all([
    store.getScope(scope), store.listMountBindings(scope), store.getMappingByColpId(scope, mapping.colpId),
  ]);
  if (record?.lifecycle !== 'active' || record.rootStatus !== undefined
      && !['ready', 'nested_normalized'].includes(record.rootStatus) || virtualNativeId(mapping.nativeId)) deny();
  const owner = current?.mountId ?? mapping.mountId;
  const candidates = mounts.filter(mount => owner ? mount.mountId === owner
    : mount.nativeRootId === mapping.rootNativeId || mount.nativeRootId === mapping.nativeId);
  const mount = candidates[0];
  if (mounts.length > 0 && (candidates.length !== 1 || mount?.status !== 'active' || !mount.remoteMountNodeId)) deny();
  const rootNativeId = mount?.nativeRootId ?? input.legacyRootNativeId;
  const boundRoot = mapping.nativeId === rootNativeId && (!mount || mount.remoteMountNodeId === mapping.colpId);
  if (!rootNativeId || virtualNativeId(rootNativeId)
      || kind === 'delete' && (mapping.nativeId === rootNativeId || !current)
      || kind === 'create' && !current && !boundRoot) deny();
  // Binding a previously virtual mount root is the one allowed identity
  // transition here. A different concrete identity or an ordinary virtual
  // parent cannot borrow the mount's native root to authorize a create.
  if (current && current.nativeId !== mapping.nativeId && !(kind === 'create'
      && virtualNativeId(current.nativeId) && boundRoot)) deny();
  const privateRoots = record.privateRoots ?? [];
  const privateMappings = await Promise.all(privateRoots.map(id => store.getMappingByColpId(scope, id)));
  if (privateMappings.some(row => !row || virtualNativeId(row.nativeId))) deny();
  const privateNativeIds = new Set(privateMappings.map(row => row!.nativeId));
  if (privateNativeIds.size !== privateRoots.length || privateRoots.includes(mapping.colpId)) deny();
  return { rootNativeId, privateNativeIds, identity: JSON.stringify([
    record.lifecycle, record.rootStatus, record.boundaryVersion, record.selectedRoots, privateRoots,
    privateMappings.map(row => [row!.colpId, row!.nativeId]), rootNativeId,
    mount ? [mount.mountId, mount.status, mount.remoteMountNodeId, mount.boundaryVersion] : null,
    current ? [current.colpId, current.nativeId, current.mountId, current.rootNativeId] : null,
  ]) };
}

function deny(): never { throw new SyncFailureError('need_authority'); }
