import { isNonChromeNativeId } from './pull-mount-apply.js';
import { rejoinBoundaryDigest } from './scope-rejoin-authority.js';
import type { RejoinChrome } from './scope-rejoin-mutation.js';
import type { MappingInput, MountBindingRecord, SyncScope, createSyncStateStore } from './sync-state-store.js';

type Input = RejoinChrome & { store: ReturnType<typeof createSyncStateStore>; scope: SyncScope; mount?: MountBindingRecord };

/** Re-read current authority, including all ancestors, immediately before a native mutation. */
export async function assertRejoinBoundary(input: Input, mapping: MappingInput, options: {
  readonly parentNativeId?: string; readonly expectedBoundary?: string; readonly allowMissing?: boolean;
  readonly extraMappings?: readonly MappingInput[]; readonly virtualOnly?: boolean;
  readonly lookupNativeIds?: readonly string[];
} = {}): Promise<void> {
  const recorded = await input.store.getScope(input.scope);
  if (!recorded || recorded.lifecycle !== 'active' || !['ready', 'nested_normalized'].includes(recorded.rootStatus ?? '')
    || options.expectedBoundary && rejoinBoundaryDigest(recorded) !== options.expectedBoundary) fail();
  // A separate current read is required for every mutation. Read only its
  // actual ancestry instead of rescanning the entire library for each member
  // of a wide deletion. These lookup maps live for this one check only.
  const hinted = options.extraMappings ?? (options.lookupNativeIds
    ? await input.store.readRejoinBoundaryMappings(input.scope, options.lookupNativeIds, recorded.privateRoots ?? []) : []);
  const byColp = new Map<string, MappingInput | undefined>(hinted.map(row => [row.colpId, row]));
  const byNative = new Map<string, MappingInput | undefined>(hinted.map(row => [row.nativeId, row]));
  const remember = (row: MappingInput | null) => {
    if (row) { byColp.set(row.colpId, row); byNative.set(row.nativeId, row); }
    return row ?? undefined;
  };
  const findColp = async (id: string) => {
    if (!byColp.has(id) && !options.extraMappings) byColp.set(id, remember(await input.store.getMappingByColpId(input.scope, id)));
    return byColp.get(id);
  };
  const findNative = async (id: string) => {
    if (!byNative.has(id) && !options.extraMappings) byNative.set(id, remember(await input.store.getMappingByNativeId(input.scope, id)));
    return byNative.get(id);
  };
  const excluded = await input.store.listLocalSyncExclusions(input.scope);
  const privateIds = new Set(recorded.privateRoots ?? []);
  const forbiddenNative = new Set(excluded.map(row => row.nativeId));
  // Range exit retains one native copy. A later independently materialized
  // copy may own the same canonical ID; only the retained native subtree is
  // private. Explicit private roots and remote-delete decisions remain bound
  // to their canonical identities as well.
  const forbiddenColp = new Set(excluded.flatMap(row => row.sourceKind !== 'range_exit' && row.priorColpId ? [row.priorColpId] : []));
  for (const id of privateIds) {
    const privateMapping = await findColp(id);
    if (!privateMapping) fail();
    forbiddenNative.add(privateMapping.nativeId); forbiddenColp.add(id);
  }
  let current: MappingInput | undefined = mapping;
  let selected = false; const seen = new Set<string>();
  while (current) {
    if (seen.has(current.colpId)) fail();
    seen.add(current.colpId);
    if (forbiddenColp.has(current.colpId) || forbiddenNative.has(current.nativeId)) fail();
    if (recorded.selectedRoots.includes(current.colpId)
      || input.admittedNativeRootIds?.includes(current.nativeId)) selected = true;
    current = current.parentColpId ? await findColp(current.parentColpId)
      : current.parentNativeId ? await findNative(current.parentNativeId) : undefined;
  }
  if (options.virtualOnly) return;
  let nativeId = options.parentNativeId ?? mapping.nativeId;
  if (isNonChromeNativeId(nativeId)) nativeId = mapping.rootNativeId;
  const nativeSeen = new Set<string>();
  let liveSelected = false;
  while (nativeId && nativeId !== '0') {
    if (nativeSeen.has(nativeId)) fail();
    nativeSeen.add(nativeId);
    if (forbiddenNative.has(nativeId)) fail();
    const mapped = await findNative(nativeId);
    if (mapped && forbiddenColp.has(mapped.colpId)) fail();
    if (mapped && recorded.selectedRoots.includes(mapped.colpId)
      || input.admittedNativeRootIds?.includes(nativeId)) liveSelected = true;
    const native = await input.getNative(nativeId);
    if (!native) {
      if (!options.allowMissing || !mapped?.parentNativeId) throw new Error('rejoin_parent_missing');
      nativeId = mapped.parentNativeId; continue;
    }
    nativeId = native.parentId ?? '';
  }
  if (!selected && !liveSelected || !liveSelected) fail();
  const root = await findNative(input.mount?.nativeRootId ?? mapping.rootNativeId);
  if (!root || input.mount && root.colpId !== input.mount.remoteMountNodeId) fail();
}
function fail(): never { throw new Error('rejoin_boundary_changed'); }

/** A wide restore validates canonical ancestry once, without per-node IndexedDB scans. */
export async function assertRejoinCanonicalBoundary(input: Input, mappings: readonly MappingInput[],
  targets: readonly MappingInput[], expectedBoundary: string): Promise<void> {
  const recorded = await input.store.getScope(input.scope);
  if (!recorded || recorded.lifecycle !== 'active' || rejoinBoundaryDigest(recorded) !== expectedBoundary) fail();
  const byColp = new Map(mappings.map(row => [row.colpId, row]));
  const byNative = new Map(mappings.map(row => [row.nativeId, row]));
  const excluded = await input.store.listLocalSyncExclusions(input.scope);
  const forbidden = new Set([...(recorded.privateRoots ?? []),
    ...excluded.flatMap(row => row.sourceKind !== 'range_exit' && row.priorColpId ? [row.priorColpId] : [])]);
  const forbiddenNative = new Set(excluded.map(row => row.nativeId));
  for (const id of recorded.privateRoots ?? []) if (!byColp.has(id)) fail();
  const safe = new Set<string>();
  for (const target of targets) {
    let current: MappingInput | undefined = target; const chain = new Set<string>();
    while (current && !safe.has(current.colpId)) {
      if (chain.has(current.colpId) || forbidden.has(current.colpId) || forbiddenNative.has(current.nativeId)) fail();
      chain.add(current.colpId);
      current = current.parentColpId ? byColp.get(current.parentColpId)
        : current.parentNativeId ? byNative.get(current.parentNativeId) : undefined;
    }
    for (const id of chain) safe.add(id);
  }
}
