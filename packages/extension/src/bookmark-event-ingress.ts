import { exclusionIds } from './bookmark-subscriptions/guards.js';
import { decideLocalPrivacy, type PrivacyDecision } from './bookmark-privacy.js';
import { digestJson, isManagedBookmarkNode } from './bookmark-event-codec.js';
import { childOrderFromProjection, sameChildOrder } from './bookmark-reorder-diff.js';
import { bootstrapRunInFlight } from './bootstrap/coordinator.js';
import { isWritableActiveScope, rejoinCommandInFlight } from './scope-transition.js';
import type { MappingInput, SyncScope, createSyncStateStore } from './sync-state-store.js';

/**
 * SR-08: `reorder_children_local_only` keeps its literal meaning — the local
 * parent projection recorded an order for which *no* `move_node` was authored by
 * this capture. Once an uplink exists the honest codes are the three below.
 */
export type IngressDiagnosticCode = 'unselected_range' | 'reorder_children_local_only' | 'reorder_uplink_staged'
  | 'reorder_children_unmapped' | 'reorder_children_excluded' | 'managed' | 'private_local'
  | 'unsupported_url_scheme' | 'invalid_title' | 'invalid_url';
export type IngressBoundary = {
  readonly selectedNative: ReadonlySet<string>;
  readonly privateNative: ReadonlySet<string>;
  readonly rootStatus: NonNullable<import('./sync-state-store.js').ScopeRecord['rootStatus']>;
};

type Store = ReturnType<typeof createSyncStateStore>;

export async function resolveIngressBoundary(store: Store, scope: SyncScope): Promise<IngressBoundary> {
  const recorded = await store.getScope(scope);
  const mounts = await store.listMountBindings(scope);
  // Dispatch resolves only today's boundary identities. Reading every mapped
  // bookmark here makes each upload phase proportional to the entire library.
  // These point reads are fresh for this call; no previous dispatch is reused.
  const boundaryIds = new Set([...(recorded?.privateRoots ?? []), ...(mounts.length ? [] : recorded?.selectedRoots ?? [])]);
  const mappings = await Promise.all([...boundaryIds].map(id => store.getMappingByColpId(scope, id)));
  const byColp = new Map(mappings.flatMap(mapping => mapping ? [[mapping.colpId, mapping.nativeId] as const] : []));
  // Losing a current private-root identity makes the boundary unprovable.
  // It must never remove that privacy restriction after an earlier check.
  if (recorded?.privateRoots?.some(id => !byColp.has(id))) throw new Error('upload_boundary_unavailable');
  const firstRun = recorded?.firstRun;
  const bootstrapLive = (await store.listBootstrapRuns(scope)).some((run) => bootstrapRunInFlight(run.phase));
  const rejoinLive = new Set<string>();
  for (const mount of mounts) {
    const plan = await store.getScopeCommandPlan(scope, `rejoin:${mount.mountId}`);
    if (plan?.kind === 'rejoin' && rejoinCommandInFlight(plan.phase)) rejoinLive.add(mount.mountId);
  }
  const liveMounts = mounts.filter((mount) => {
    if (rejoinLive.has(mount.mountId)) return true;
    if (mount.status === 'detached') return false;
    // Pending mounts capture only while first-run, bootstrap/range, or rejoin is in flight.
    if (mount.status === 'pending') {
      return firstRun === 'running' || bootstrapLive || rejoinLive.has(mount.mountId);
    }
    return isWritableActiveScope({
      status: mount.status,
      identityKnown: mount.remoteMountNodeId !== null,
    });
  });
  const mountNative = new Set(liveMounts.map((mount) => mount.nativeRootId));
  const selectedFromRoots = new Set(recorded?.selectedRoots.map((id) => byColp.get(id)).filter((id): id is string => Boolean(id)));
  return {
    selectedNative: mounts.length > 0 ? mountNative : selectedFromRoots,
    privateNative: new Set([...(await exclusionIds()), ...(recorded?.privateRoots ?? []).map((id) => byColp.get(id)).filter((id): id is string => Boolean(id))]),
    rootStatus: recorded?.rootStatus ?? 'corrupt',
  };
}

export function decideIngressPrivacy(input: {
  readonly rootStatus: IngressBoundary['rootStatus'];
  readonly mapped: boolean; readonly selected: boolean; readonly privateLocal: boolean;
  readonly managed: boolean; readonly allowUnmappedSelected?: boolean;
}): { readonly privacy: PrivacyDecision; readonly diagnostic?: IngressDiagnosticCode } {
  if (input.managed) {
    return { privacy: { allowOperationCandidate: false, reason: 'managed' }, diagnostic: 'managed' };
  }
  const privacy = decideLocalPrivacy({
    rootStatus: input.rootStatus, mapped: input.mapped || (input.allowUnmappedSelected === true && input.selected),
    selected: input.selected, privateLocal: input.privateLocal,
  });
  if (privacy.allowOperationCandidate) return { privacy };
  if (privacy.reason === 'private_local') return { privacy, diagnostic: 'private_local' };
  if (privacy.reason === 'not_selected') return { privacy, diagnostic: 'unselected_range' };
  return { privacy };
}

export async function recordIngressDiagnostic(store: Store, scope: SyncScope, code: IngressDiagnosticCode): Promise<void> {
  await store.putIngressDiagnostic(scope, { code });
}

/** What the SR-08 uplink authored for one reorder, so the projection can report it honestly. */
export interface ReorderUplinkDecision {
  readonly staged: number;
  readonly unmapped: readonly string[];
  readonly excluded: readonly string[];
}

export interface LocalReorderResult {
  readonly outcome: 'projected' | 'unchanged' | 'unmapped';
  /** True when the persisted sibling order itself changed. */
  readonly changed: boolean;
}

/**
 * SR-08: the local half of a reorder. Records the new sibling order on the
 * parent mapping (so a later event can diff against it and so the local
 * projection stays consistent) and reports what happened honestly. This is
 * deliberately not a queue/network write point — the uplink is authored by
 * `reordered()` through `stage()`; here we only persist the baseline it diffs.
 *
 * Native order is projection metadata, outside protocol content. Reordering
 * never changes the content digest used to protect pending local edits.
 */
export async function applyLocalReorder(store: Store, scope: SyncScope, parentNativeId: string,
  childIds: readonly string[], uplink?: ReorderUplinkDecision): Promise<LocalReorderResult> {
  const mapping = await store.getMappingByNativeId(scope, parentNativeId);
  if (!mapping) {
    await recordIngressDiagnostic(store, scope, 'reorder_children_unmapped');
    return { outcome: 'unmapped', changed: false };
  }
  const previousOrder = childOrderFromProjection(mapping.projection);
  const changed = !sameChildOrder(previousOrder, childIds);
  await store.putMapping(scope, {
    nativeId: mapping.nativeId, colpId: mapping.colpId, rootNativeId: mapping.rootNativeId,
    ...(mapping.nodeKind ? { nodeKind: mapping.nodeKind } : {}),
    ...(mapping.parentNativeId ? { parentNativeId: mapping.parentNativeId } : {}),
    ...(mapping.parentColpId ? { parentColpId: mapping.parentColpId } : {}),
    ...(mapping.mountId ? { mountId: mapping.mountId } : {}),
    ...(mapping.rootRole ? { rootRole: mapping.rootRole } : {}),
    projection: { ...mapping.projection, childrenOrder: [...childIds] },
  } satisfies MappingInput);
  if ((uplink?.staged ?? 0) > 0) await recordIngressDiagnostic(store, scope, 'reorder_uplink_staged');
  if ((uplink?.unmapped.length ?? 0) > 0) await recordIngressDiagnostic(store, scope, 'reorder_children_unmapped');
  if ((uplink?.excluded.length ?? 0) > 0) await recordIngressDiagnostic(store, scope, 'reorder_children_excluded');
  if (!uplink || ((uplink.staged ?? 0) === 0 && uplink.unmapped.length === 0 && uplink.excluded.length === 0)) {
    await recordIngressDiagnostic(store, scope, 'reorder_children_local_only');
  }
  return { outcome: changed ? 'projected' : 'unchanged', changed };
}

export { isManagedBookmarkNode };
