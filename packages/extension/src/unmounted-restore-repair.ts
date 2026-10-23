/**
 * One-shot repair of wrongly Acked restore mappings. Does not rewrite receipts
 * or old ordinals; a new Snapshot is the authority for materialization.
 */
import { freezeScopeRecovery } from './pull-recovery-freeze.js';
import { UNMOUNTED_PREFIX } from './pull-mount-apply.js';
import type { MappingInput, MountBindingRecord, SyncScope, createSyncStateStore } from './sync-state-store.js';

type Store = Pick<ReturnType<typeof createSyncStateStore>,
  'listMappings' | 'listMountBindings' | 'listLocalSyncExclusions' | 'getScope' | 'registerScope'
  | 'getEngineState' | 'transitionEngine'>;

export async function repairWronglyAckedUnmountedRestore(store: Store, scope: SyncScope): Promise<{
  readonly candidates: number; readonly needsSnapshot: boolean;
}> {
  const [mappings, mounts, exclusions] = await Promise.all([
    store.listMappings(scope), store.listMountBindings(scope), store.listLocalSyncExclusions(scope),
  ]);
  const byColp = new Map(mappings.map((mapping) => [mapping.colpId, mapping]));
  const excluded = new Set(exclusions.map((row) => row.nativeId));
  const candidates = mappings.filter((mapping) => isWronglyAckedRestore(mapping, byColp, mounts, excluded));
  if (candidates.length === 0) return { candidates: 0, needsSnapshot: false };
  await freezeScopeRecovery(store, scope, 'unmounted_restore_repair');
  return { candidates: candidates.length, needsSnapshot: true };
}

function isWronglyAckedRestore(
  mapping: MappingInput,
  byColp: ReadonlyMap<string, MappingInput>,
  mounts: readonly MountBindingRecord[],
  excluded: ReadonlySet<string>,
): boolean {
  if (!mapping.nativeId.startsWith(UNMOUNTED_PREFIX)) return false;
  if (excluded.has(mapping.nativeId)) return false;
  const parentId = mapping.parentColpId;
  if (!parentId) return false;
  if (byColp.has(parentId)) return false;
  const active = mounts.filter((mount) => mount.status === 'active');
  if (active.length === 0) return false;
  const provenOther = mounts.some((mount) => mount.remoteMountNodeId === parentId && mount.status !== 'active');
  return !provenOther;
}
