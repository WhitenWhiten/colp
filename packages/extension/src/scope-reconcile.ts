import { recordKns09PermissionRevoked } from './kns-09-release.js';
import type { MappingInput, MountBindingRecord, SyncScope, createSyncStateStore } from './sync-state-store.js';

type Store = Pick<ReturnType<typeof createSyncStateStore>,
  'getScope' | 'listMappings' | 'listQueue' | 'listMountBindings' | 'putMountBinding' | 'setBrowserRootStatus'
  | 'reconcileBrowserRoots' | 'getEngineState' | 'transitionEngine'>;

export type RejoinClassification = {
  readonly verified: readonly MappingInput[];
  readonly conflicts: readonly MappingInput[];
  readonly missing: readonly MappingInput[];
  readonly candidates: readonly string[];
};

export function classifyRejoinMappings(input: {
  readonly mount: MountBindingRecord; readonly mappings: readonly MappingInput[];
  readonly nativePresent: ReadonlySet<string>; readonly extraNativeIds?: readonly string[];
}): RejoinClassification {
  const underMount = input.mappings.filter((mapping) => mapping.mountId === input.mount.mountId
    || mapping.rootNativeId === input.mount.nativeRootId);
  const verified: MappingInput[] = []; const conflicts: MappingInput[] = []; const missing: MappingInput[] = [];
  for (const mapping of underMount) {
    if (mapping.nativeId.startsWith('recovery:') || mapping.nativeId.startsWith('unmounted:')
        || mapping.colpId.startsWith('pending-')) {
      conflicts.push(mapping); continue;
    }
    if (!input.nativePresent.has(mapping.nativeId)) { missing.push(mapping); continue; }
    verified.push(mapping);
  }
  const mappedNative = new Set(underMount.map((mapping) => mapping.nativeId));
  const candidates = (input.extraNativeIds ?? []).filter((id) => !mappedNative.has(id));
  return { verified, conflicts, missing, candidates };
}

export function collectNativeIds(nodes: readonly { readonly nativeId: string;
  readonly children?: readonly { readonly nativeId: string; readonly children?: readonly unknown[] }[] }[]): Set<string> {
  const ids = new Set<string>();
  const visit = (node: { readonly nativeId: string; readonly children?: readonly unknown[] }) => {
    ids.add(node.nativeId);
    for (const child of node.children ?? []) visit(child as { readonly nativeId: string; readonly children?: readonly unknown[] });
  };
  for (const node of nodes) visit(node);
  return ids;
}

export async function revokeBookmarkSync(store: Store, scope: SyncScope) {
  const [queue, mappings] = await Promise.all([store.listQueue(scope), store.listMappings(scope)]);
  recordKns09PermissionRevoked(scope);
  await store.setBrowserRootStatus(scope, 'permission_required');
  return { queueLength: queue.length, mappingCount: mappings.length,
    colpIds: mappings.map((mapping) => mapping.colpId) };
}

export async function reconcileAfterReauth(store: Store, scope: SyncScope, input: {
  readonly treeDigest: string; readonly nativePresent: ReadonlySet<string>;
  readonly discovered: readonly { readonly nativeId: string; readonly ancestorNativeIds: readonly string[] }[];
}): Promise<{ readonly verifiedMounts: number; readonly mappingCount: number }> {
  const recorded = await store.getScope(scope);
  if (!recorded) throw new Error('scope_not_found');
  await store.reconcileBrowserRoots(scope, input.discovered);
  const mounts = await store.listMountBindings(scope);
  const at = Date.now();
  let verifiedMounts = 0;
  for (const mount of mounts) {
    const { scopeKey: _scopeKey, ...binding } = mount;
    await store.putMountBinding(scope, {
      ...binding, lastReconcile: { treeDigest: input.treeDigest, at },
    });
    if (input.nativePresent.has(mount.nativeRootId)) verifiedMounts += 1;
  }
  const mappings = await store.listMappings(scope);
  return { verifiedMounts, mappingCount: mappings.length };
}

export function pullApplyAllowed(input: {
  readonly hasBookmarkPermission: boolean;
  readonly rootStatus?: string; readonly hasActiveMounts: boolean;
}): boolean {
  return input.hasBookmarkPermission && input.hasActiveMounts
    && input.rootStatus !== 'permission_required';
}
