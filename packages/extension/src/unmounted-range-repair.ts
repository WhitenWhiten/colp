/**
 * Rebuild dest copies from unmounted/recovery/sidecar vs the live parent graph.
 * Unprovable natives stay; already-Acked out-of-scope rows need a new Snapshot.
 */
import { executeNativeCreate } from './native-create-executor.js';
import { rejectedChromeBookmarkUrl } from './pull-projection.js';
import { isNonChromeNativeId, UNMOUNTED_PREFIX } from './pull-mount-apply.js';
import { parentFirstNodes, type IndependentSubtreeNode } from './pull-range-plan.js';
import type { PullBookmarkApi } from './pull-applier-types.js';
import { scopeKey } from './sync-state/scope-key.js';
import type { MappingInput, MountBindingRecord, SyncScope, createSyncStateStore } from './sync-state-store.js';

type Store = ReturnType<typeof createSyncStateStore>;

export const UNMOUNTED_RANGE_REPAIR_JOB = 'repair:unmounted-range-subtree';

export async function repairUnmountedRangeMappings(store: Store, scope: SyncScope, api?: PullBookmarkApi): Promise<{
  readonly filled: number; readonly attention: number; readonly needsSnapshot: boolean;
}> {
  // A confirmed advanced plan owns whether these remote-only rows should ever
  // be materialized. Startup runs before the engine resumes that plan.
  if ((await store.listAdvancedPlans(scope)).some(plan => plan.state !== 'completed')) {
    return { filled: 0, attention: 0, needsSnapshot: false };
  }
  const [mappings, mounts, exclusions, observations] = await Promise.all([
    store.listMappings(scope), store.listMountBindings(scope), store.listLocalSyncExclusions(scope), store.listRemoteObservations(scope),
  ]);
  const byColp = new Map(mappings.map((row) => [row.colpId, row]));
  const excluded = new Set(exclusions.map((row) => row.nativeId));
  const tombstones = new Set(observations.filter(row => row.kind === 'tombstone').map(row => row.colpId));
  const virtual = mappings.filter((row) => isRepairVirtual(row.nativeId) && !tombstones.has(row.colpId));
  let filled = 0; let attention = 0; let needsSnapshot = false;
  const proven: IndependentSubtreeNode[] = [];
  for (const mapping of virtual) {
    const parent = mapping.parentColpId ? byColp.get(mapping.parentColpId) : undefined;
    if (!parent) { needsSnapshot = true; continue; }
    const mount = destMount(parent, mounts) ?? destMount(mapping, mounts);
    if (!mount || mount.status !== 'active') continue;
    if (!mapping.projection.content) { attention += 1; continue; }
    proven.push({
      colpId: mapping.colpId, parentColpId: mapping.parentColpId, nodeKind: mapping.nodeKind ?? 'bookmark',
      sourceNativeId: mapping.nativeId, position: 0, revision: mapping.projection.revision,
      childrenRevision: mapping.projection.childrenRevision, content: mapping.projection.content,
    });
  }
  if (api) {
    const ordered = parentFirstNodes(proven, '');
    const destByColp = new Map(mappings.filter((row) => !isNonChromeNativeId(row.nativeId))
      .map((row) => [row.colpId, row.nativeId]));
    for (const node of ordered) {
      const parentNativeId = node.parentColpId ? destByColp.get(node.parentColpId) : undefined;
      if (!parentNativeId) { needsSnapshot = true; continue; }
      const created = await createRepairedNative(store, scope, api, node, parentNativeId);
      if (!created) { attention += 1; continue; }
      destByColp.set(node.colpId, created);
      const prior = byColp.get(node.colpId);
      if (prior) await store.deleteMapping(scope, prior.nativeId);
      await store.putMapping(scope, {
        nativeId: created, colpId: node.colpId, rootNativeId: parentRoot(parentNativeId, mappings),
        nodeKind: node.nodeKind, parentNativeId: parentNativeId,
        ...(node.parentColpId ? { parentColpId: node.parentColpId } : {}),
        projection: prior?.projection ?? {
          revision: node.revision, childrenRevision: node.childrenRevision ?? null, digest: `sha256:${node.colpId}`,
          ...(node.content ? { content: node.content } : {}),
        },
      });
      filled += 1;
    }
    attention += await markUnprovable(store, scope, api, mappings, destByColp, excluded);
  } else {
    attention += proven.length;
  }
  return { filled, attention, needsSnapshot };
}

function isRepairVirtual(nativeId: string): boolean {
  return nativeId.startsWith(UNMOUNTED_PREFIX) || nativeId.startsWith('recovery:') || nativeId.startsWith('sidecar:');
}

function destMount(mapping: MappingInput, mounts: readonly MountBindingRecord[]) {
  return mounts.find((item) => item.mountId === mapping.mountId || item.nativeRootId === mapping.rootNativeId
    || item.nativeRootId === mapping.nativeId);
}

function parentRoot(parentNativeId: string, mappings: readonly MappingInput[]): string {
  return mappings.find((row) => row.nativeId === parentNativeId)?.rootNativeId ?? parentNativeId;
}

async function createRepairedNative(store: Store, scope: SyncScope, api: PullBookmarkApi,
  node: IndependentSubtreeNode, parentNativeId: string): Promise<string | undefined> {
  if (node.nodeKind === 'separator') return `sidecar:${node.colpId}`;
  const title = typeof node.content?.title === 'string' ? node.content.title : undefined;
  const url = node.nodeKind === 'bookmark' && typeof node.content?.url === 'string' ? node.content.url : undefined;
  // One rejected URL stays virtual and counts as attention. Siblings still repair.
  if (rejectedChromeBookmarkUrl(url)) return undefined;
  const outcome = await executeNativeCreate({
    scope, store, api, intentId: `${UNMOUNTED_RANGE_REPAIR_JOB}:${node.colpId}`,
    owner: {
      scopeKey: scopeKey(scope), generation: scope.generation, commandId: UNMOUNTED_RANGE_REPAIR_JOB,
      eventId: `${UNMOUNTED_RANGE_REPAIR_JOB}:${node.colpId}`, colpId: node.colpId, substep: 'range-repair',
    },
    parentNativeId, expected: { ...(title === undefined ? {} : { title }), ...(url === undefined ? {} : { url }) },
    liveWorkKind: 'create',
    create: async () => api.create({
      parentId: parentNativeId, ...(title === undefined ? {} : { title }), ...(url === undefined ? {} : { url }),
    }),
  });
  return outcome.result === 'applied_with_evidence' ? outcome.nativeId : undefined;
}

async function markUnprovable(store: Store, scope: SyncScope, api: PullBookmarkApi,
  mappings: readonly MappingInput[], destByColp: ReadonlyMap<string, string>,
  excluded: ReadonlySet<string>): Promise<number> {
  const mappedNative = new Set(mappings.map((row) => row.nativeId));
  let attention = 0;
  for (const parentNativeId of destByColp.values()) {
    let children: readonly { readonly id: string }[] = [];
    try { children = await api.getChildren(parentNativeId); }
    catch { continue; }
    for (const child of children) {
      if (mappedNative.has(child.id) || excluded.has(child.id) || destByColp.get([...destByColp.keys()].find((key) =>
        destByColp.get(key) === child.id) ?? '') === child.id) continue;
      if ([...destByColp.values()].includes(child.id)) continue;
      await store.putScopeDiagnostic(scope, {
        kind: 'range_repair', code: 'unprovable_native', nativeId: child.id,
      });
      attention += 1;
    }
  }
  return attention;
}
