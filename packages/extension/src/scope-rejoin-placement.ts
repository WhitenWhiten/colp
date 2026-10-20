import { isNonChromeNativeId } from './pull-mount-apply.js';
import { nativeContent } from './pull-projection.js';
import { rejoinNativeDigest, type RejoinChrome, type RejoinNative } from './scope-rejoin-mutation.js';
import type { RejoinDeletionBoundary } from './sync-state/rejoin-decision-repository.js';
import type { MappingInput, MountBindingRecord, SyncScope, createSyncStateStore } from './sync-state-store.js';

type Input = RejoinChrome & { store: ReturnType<typeof createSyncStateStore>; scope: SyncScope; mount: MountBindingRecord };

interface DeletionFact { readonly mapping: MappingInput; readonly native: RejoinNative | null; readonly children?: readonly string[] }
export interface RejoinDeletionEvidence {
  readonly boundary: RejoinDeletionBoundary; readonly facts: ReadonlyMap<string, DeletionFact>;
}
/** Plan subtree protection before any removeTree call can erase evidence of a local edit. */
export async function protectedRejoinDeletions(input: Input, mappings: readonly MappingInput[]): Promise<{
  readonly protectedIds: Set<string>; readonly evidence: RejoinDeletionEvidence;
}> {
  const boundary = await input.store.readRejoinDeletionBoundary(input.scope);
  const byNative = new Map(mappings.map(row => [row.nativeId, row]));
  const mappedChildren = new Map<string, string[]>();
  for (const mapping of mappings) if (mapping.parentNativeId) {
    const children = mappedChildren.get(mapping.parentNativeId) ?? [];
    children.push(mapping.nativeId); mappedChildren.set(mapping.parentNativeId, children);
  }
  const privateIds = new Set((await input.store.getScope(input.scope))?.privateRoots ?? []);
  const exclusions = new Set((await input.store.listLocalSyncExclusions(input.scope)).map(row => row.nativeId));
  const protectedIds = new Set<string>(), facts = new Map<string, DeletionFact>();
  for (const mapping of mappings) {
    if (isNonChromeNativeId(mapping.nativeId)) continue;
    const live = await input.getNative(mapping.nativeId);
    const baseline = nativeContent(mapping.projection.content ?? {});
    const changed = live && (Object.entries(baseline).some(([key, value]) => live[key as 'title' | 'url'] !== value)
      || live.parentId !== undefined && mapping.parentNativeId !== undefined && live.parentId !== mapping.parentNativeId);
    const children = mapping.nodeKind !== 'folder' ? undefined : !live ? mappedChildren.get(mapping.nativeId) ?? []
      : input.getChildren ? (await input.getChildren(mapping.nativeId)).map(child => child.id) : undefined;
    facts.set(mapping.nativeId, { mapping, native: live ? { ...live } : null, ...(children ? { children } : {}) });
    if (changed || children?.some(id => !byNative.has(id)) || privateIds.has(mapping.colpId)
      || exclusions.has(mapping.nativeId) || live?.unmodifiable || live?.folderType
      || live && mapping.nodeKind === 'folder' && !input.getChildren) protectedIds.add(mapping.nativeId);
  }
  // Set iteration includes newly added parents; every native edge is visited
  // once even when thousands of edited descendants share a deep ancestry.
  for (const id of protectedIds) {
    const parent = byNative.get(id)?.parentNativeId;
    if (parent && byNative.has(parent)) protectedIds.add(parent);
  }
  return { protectedIds, evidence: { boundary, facts } };
}

export function rejoinDeletionMembers(evidence: RejoinDeletionEvidence, rootId: string): readonly MappingInput[] {
  const ids = [rootId], seen = new Set<string>(), members: MappingInput[] = [];
  for (let index = 0; index < ids.length; index++) {
    const id = ids[index]!, fact = evidence.facts.get(id);
    if (!fact || seen.has(id)) throw new Error('rejoin_boundary_changed');
    seen.add(id); members.push(fact.mapping); ids.push(...fact.children ?? []);
  }
  return members;
}

/** Compare to the facts that authorized deletion, never adopt new children. */
export async function assertRejoinDeletionTree(input: RejoinChrome, evidence: RejoinDeletionEvidence,
  members: readonly MappingInput[]): Promise<void> {
  if (!input.getChildren) throw new Error('rejoin_boundary_changed');
  for (const mapping of members) {
    const expected = evidence.facts.get(mapping.nativeId)!;
    const native = await input.getNative(mapping.nativeId);
    if (!expected.native) {
      if (native) throw new Error('rejoin_boundary_changed');
      continue;
    }
    if (!native || rejoinNativeDigest(native) !== rejoinNativeDigest(expected.native)) throw new Error('rejoin_boundary_changed');
    if (mapping.nodeKind !== 'folder') continue;
    const children = (await input.getChildren(mapping.nativeId)).map(child => child.id);
    if (!expected.children || children.length !== expected.children.length
      || children.some((id, index) => id !== expected.children![index])) throw new Error('rejoin_boundary_changed');
  }
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
