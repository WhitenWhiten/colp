import { isNonChromeNativeId } from './pull-mount-apply.js';
import { rejoinBoundaryDigest } from './scope-rejoin-authority.js';
import type { RejoinChrome } from './scope-rejoin-mutation.js';
import type { MappingInput, MountBindingRecord, SyncScope, createSyncStateStore } from './sync-state-store.js';

type Input = RejoinChrome & { store: ReturnType<typeof createSyncStateStore>; scope: SyncScope; mount?: MountBindingRecord };

/** Re-read current authority, including all ancestors, immediately before a native mutation. */
export async function assertRejoinBoundary(input: Input, mapping: MappingInput, options: {
  readonly parentNativeId?: string; readonly expectedBoundary?: string; readonly allowMissing?: boolean;
  readonly extraMappings?: readonly MappingInput[]; readonly virtualOnly?: boolean;
} = {}): Promise<void> {
  const recorded = await input.store.getScope(input.scope);
  if (!recorded || recorded.lifecycle !== 'active' || !['ready', 'nested_normalized'].includes(recorded.rootStatus ?? '')
    || options.expectedBoundary && rejoinBoundaryDigest(recorded) !== options.expectedBoundary) fail();
  const all = options.extraMappings ?? await input.store.listMappings(input.scope);
  const byColp = new Map(all.map(row => [row.colpId, row]));
  const byNative = new Map(all.map(row => [row.nativeId, row]));
  const excluded = await input.store.listLocalSyncExclusions(input.scope);
  const privateIds = new Set(recorded.privateRoots ?? []);
  const forbiddenNative = new Set(excluded.map(row => row.nativeId));
  const forbiddenColp = new Set(excluded.flatMap(row => row.priorColpId ? [row.priorColpId] : []));
  for (const id of privateIds) {
    const privateMapping = byColp.get(id);
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
    current = current.parentColpId ? byColp.get(current.parentColpId)
      : current.parentNativeId ? byNative.get(current.parentNativeId) : undefined;
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
    const mapped = byNative.get(nativeId);
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
  const root = byNative.get(input.mount?.nativeRootId ?? mapping.rootNativeId);
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
  const forbidden = new Set([...(recorded.privateRoots ?? []), ...excluded.flatMap(row => row.priorColpId ? [row.priorColpId] : [])]);
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
