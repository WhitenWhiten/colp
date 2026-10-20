import { eligibleSnapshotCreates } from './snapshot-create-boundary.js';
import { planRecoveryOverlay, type NativeFact, type ProjectionIntent } from './recovery-overlay.js';
import { virtualNativeId } from './projection-native-occupancy.js';
import type { MappingInput, MountBindingRecord, QueueOperation, SyncScope, createSyncStateStore } from './sync-state-store.js';

type Store = Pick<ReturnType<typeof createSyncStateStore>, 'getScope' | 'listMountBindings'>;

/** The verified Snapshot is a full remote graph. A node absent from one mounted
 * subtree may have moved to another, so only global absence proves deletion. */
export async function planMountedSnapshotDeletes(input: {
  readonly store: Store; readonly scope: SyncScope;
  readonly live: readonly MappingInput[]; readonly snapshot: readonly MappingInput[];
  readonly outstanding: readonly QueueOperation[]; readonly protectedIds: ReadonlySet<string>;
  readonly nativeFacts: (rootNativeId: string) => Promise<readonly NativeFact[]>;
}): Promise<{ readonly retainedMappings: readonly MappingInput[]; readonly intents: readonly ProjectionIntent[] }> {
  const empty = { retainedMappings: [], intents: [] };
  const snapshotIds = new Set(input.snapshot.map(row => row.colpId));
  const missing = input.live.filter(row => !snapshotIds.has(row.colpId));
  if (missing.length === 0) return empty;
  const eligible = await eligibleSnapshotCreates(input.store, input.scope, input.live);
  if (!eligible?.size) return empty;
  const liveById = new Map(input.live.map(row => [row.colpId, row]));
  const roots = new Map((await input.store.listMountBindings(input.scope)).filter(mount => {
    const root = mount.remoteMountNodeId ? liveById.get(mount.remoteMountNodeId) : undefined;
    return mount.status === 'active' && root?.nativeId === mount.nativeRootId && !virtualNativeId(root.nativeId);
  }).map(mount => [mount.remoteMountNodeId!, mount]));
  const groups = new Map<MountBindingRecord, MappingInput[]>();
  for (const row of missing) {
    if (!eligible.has(row.colpId)) continue;
    const owner = mountedAncestor(row, liveById, roots);
    if (!owner) continue;
    const group = groups.get(owner);
    if (group) group.push(row);
    else groups.set(owner, [row]);
  }
  const retainedMappings: MappingInput[] = [], intents: ProjectionIntent[] = [];
  for (const [mount, mappings] of groups) {
    // Reuse the proven child-first, outstanding-work and nonrecursive deletion
    // rules. No structural ancestor or another mount enters this planner view.
    const plan = planRecoveryOverlay({ snapshot: [], mappings, outstanding: input.outstanding,
      nativeFacts: await input.nativeFacts(mount.nativeRootId), selectedRootNativeId: mount.nativeRootId,
      issueProtectedIds: input.protectedIds, allowTitleUrlIdentityGuess: false });
    retainedMappings.push(...plan.targetMappings);
    intents.push(...plan.intents.filter(intent => intent.kind === 'delete'));
  }
  return { retainedMappings, intents: intents.map((intent, index) => ({ ...intent, order: index + 1 })) };
}

function mountedAncestor(row: MappingInput, byId: ReadonlyMap<string, MappingInput>,
  roots: ReadonlyMap<string, MountBindingRecord>): MountBindingRecord | undefined {
  let current: MappingInput | undefined = row;
  const seen = new Set<string>();
  while (current && !seen.has(current.colpId)) {
    seen.add(current.colpId);
    const mount = roots.get(current.colpId);
    if (mount) return mount;
    current = current.parentColpId ? byId.get(current.parentColpId) : undefined;
  }
  return undefined;
}
