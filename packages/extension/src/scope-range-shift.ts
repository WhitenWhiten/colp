import { customSourceKeyForFolder } from './chrome-bookmark-tree.js';
import type { MappingInput, MountBindingRecord, SyncScope, createSyncStateStore } from './sync-state-store.js';

type Store = ReturnType<typeof createSyncStateStore>;

export interface RangeShiftCandidate {
  readonly nativeRootId: string;
  readonly mountId: string;
  readonly remoteMountNodeId: string | null;
  readonly colpId: string;
}

export function isOrdinaryFolderMount(mount: MountBindingRecord): boolean {
  return mount.rootRole === undefined && typeof mount.customSourceKey === 'string';
}

export function detectRangeShifts(input: {
  readonly liveMounts: readonly MountBindingRecord[];
  readonly mappings: readonly MappingInput[];
  readonly selectedNativeIds: readonly string[];
  readonly discovered: ReadonlyMap<string, readonly string[]>;
}): RangeShiftCandidate[] {
  const selected = new Set(input.selectedNativeIds);
  const byNative = new Map(input.mappings.map((row) => [row.nativeId, row]));
  const out: RangeShiftCandidate[] = [];
  const seen = new Set<string>();
  const push = (row: RangeShiftCandidate) => {
    if (seen.has(row.nativeRootId)) return;
    seen.add(row.nativeRootId);
    out.push(row);
  };
  for (const mount of input.liveMounts) {
    if (!input.discovered.has(mount.nativeRootId)) continue;
    const mapping = byNative.get(mount.nativeRootId);
    const colpId = mount.remoteMountNodeId ?? mapping?.colpId;
    if (!colpId) continue;
    if (mount.pendingShift) {
      push({ nativeRootId: mount.nativeRootId, mountId: mount.mountId, remoteMountNodeId: mount.remoteMountNodeId,
        colpId });
      continue;
    }
    if (mount.status === 'detached' || selected.has(mount.nativeRootId) || !isOrdinaryFolderMount(mount)) continue;
    const ancestors = input.discovered.get(mount.nativeRootId) ?? [];
    if (ancestors.some((id) => selected.has(id))) continue;
    push({ nativeRootId: mount.nativeRootId, mountId: mount.mountId, remoteMountNodeId: mount.remoteMountNodeId,
      colpId });
  }
  return out;
}

export async function recordMoveOutOfBoundaryShift(store: Store, scope: SyncScope, input: {
  readonly nativeId: string; readonly colpId: string; readonly fromParentNativeId?: string;
  readonly toParentNativeId?: string; readonly boundaryVersion: string;
}): Promise<void> {
  const mounts = await store.listMountBindings(scope);
  const existing = mounts.find((mount) => mount.nativeRootId === input.nativeId)
    ?? mounts.find((mount) => mount.remoteMountNodeId === input.colpId);
  const pendingShift = {
    colpId: input.colpId,
    ...(input.fromParentNativeId ? { fromParentNativeId: input.fromParentNativeId } : {}),
    ...(input.toParentNativeId ? { toParentNativeId: input.toParentNativeId } : {}),
  };
  if (existing) {
    const { scopeKey: _scopeKey, pendingRemoteDelete: _pending, ...binding } = existing;
    await store.putMountBinding(scope, { ...binding, pendingShift });
    return;
  }
  await store.putMountBinding(scope, {
    mountId: `mount:${input.nativeId}`, nativeRootId: input.nativeId, remoteMountNodeId: input.colpId,
    boundaryVersion: input.boundaryVersion, materialized: false, status: 'detached',
    customSourceKey: customSourceKeyForFolder(input.nativeId), pendingShift,
  });
}

export async function keepShiftedMount(store: Store, scope: SyncScope, input: {
  readonly mount: MountBindingRecord; readonly nativeRootId: string;
}): Promise<MountBindingRecord> {
  const { scopeKey: _scopeKey, pendingShift: _shift, pendingRemoteDelete: _pending, ...binding } = input.mount;
  return store.putMountBinding(scope, {
    ...binding, nativeRootId: input.nativeRootId, status: 'active',
    remoteMountNodeId: input.mount.remoteMountNodeId ?? input.mount.pendingShift?.colpId ?? null,
  });
}

export async function preserveShiftMappings(store: Store, scope: SyncScope, input: {
  readonly nativeRootId: string; readonly colpId: string; readonly mountId: string;
}): Promise<void> {
  const mapping = await store.getMappingByNativeId(scope, input.nativeRootId)
    ?? await store.getMappingByColpId(scope, input.colpId);
  if (!mapping || mapping.colpId !== input.colpId) return;
  await store.putMapping(scope, {
    nativeId: input.nativeRootId, colpId: mapping.colpId, rootNativeId: input.nativeRootId,
    ...(mapping.nodeKind ? { nodeKind: mapping.nodeKind } : {}),
    ...(mapping.parentNativeId ? { parentNativeId: mapping.parentNativeId } : {}),
    mountId: input.mountId,
    ...(mapping.rootRole ? { rootRole: mapping.rootRole } : {}),
    projection: mapping.projection,
  });
}
