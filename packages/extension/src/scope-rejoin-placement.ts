import { isNonChromeNativeId } from './pull-mount-apply.js';
import { nativeContent } from './pull-projection.js';
import { sameNativeContentValue } from './native-event-correlation.js';
import type { RejoinChrome, RejoinNative } from './scope-rejoin-mutation.js';
import type { MappingInput, MountBindingRecord, SyncScope, createSyncStateStore } from './sync-state-store.js';

type Input = RejoinChrome & { store: ReturnType<typeof createSyncStateStore>; scope: SyncScope; mount: MountBindingRecord };

/** Plan subtree protection before any removeTree call can erase evidence of a local edit. */
export async function protectedRejoinDeletions(input: Input, mappings: readonly MappingInput[]): Promise<Set<string>> {
  const byNative = new Map(mappings.map(row => [row.nativeId, row]));
  const protectedIds = new Set<string>();
  for (const mapping of mappings) {
    if (isNonChromeNativeId(mapping.nativeId)) continue;
    const live = await input.getNative(mapping.nativeId);
    const baseline = nativeContent(mapping.projection.content ?? {});
    const changed = live && (Object.entries(baseline).some(([key, value]) => !sameNativeContentValue(key, live[key as 'title' | 'url'], value))
      || live.parentId !== undefined && mapping.parentNativeId !== undefined && live.parentId !== mapping.parentNativeId);
    const hasUnmappedChildren = live && mapping.nodeKind === 'folder' && input.getChildren
      ? (await input.getChildren(mapping.nativeId)).some(child => !byNative.has(child.id)) : false;
    if (!changed && !hasUnmappedChildren) continue;
    let current: MappingInput | undefined = mapping;
    const seen = new Set<string>();
    while (current && !seen.has(current.nativeId)) {
      seen.add(current.nativeId); protectedIds.add(current.nativeId);
      current = current.parentNativeId ? byNative.get(current.parentNativeId) : undefined;
    }
  }
  return protectedIds;
}

export async function rejoinPlacement(input: Input, mapping: MappingInput, native: RejoinNative,
  all: readonly MappingInput[]) {
  const target = all.find(row => row.nativeId === native.parentId);
  const source = all.find(row => row.nativeId === mapping.parentNativeId);
  if (!target?.projection.childrenRevision || !source?.projection.childrenRevision || !input.getChildren) return;
  const mounts = await input.store.listMountBindings(input.scope);
  if (target.rootNativeId !== input.mount.nativeRootId
    && !mounts.some(row => row.nativeRootId === target.rootNativeId && row.status === 'active')) return;
  const siblings = await input.getChildren(target.nativeId);
  const index = siblings.findIndex(row => row.id === mapping.nativeId);
  if (index < 0) return;
  const preceding = index > 0 ? all.find(row => row.nativeId === siblings[index - 1]!.id) : undefined;
  if (index > 0 && !preceding) return;
  return { newParentId: target.colpId, afterId: preceding?.colpId ?? null, beforeId: null,
    baseSourceParentRevision: source.projection.childrenRevision, baseTargetParentRevision: target.projection.childrenRevision };
}
