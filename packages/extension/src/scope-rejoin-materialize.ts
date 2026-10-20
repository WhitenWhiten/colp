import { digestJson } from './bookmark-event-codec.js';
import { assertRejoinBoundary } from './scope-rejoin-boundary.js';
import { restoreEvidence, type RejoinRestoreOrder } from './sync-state/rejoin-decision-repository.js';
import { occupancyByNative } from './projection-native-occupancy.js';
import { parentFirst, remoteDescendantIds } from './scope-rejoin-members.js';
import { executeNativeCreate } from './native-create-executor.js';
import { isNonChromeNativeId, UNMOUNTED_PREFIX } from './pull-mount-apply.js';
import { scopeKey } from './sync-state/scope-key.js';
import type { RejoinChrome } from './scope-rejoin-mutation.js';
import { observationValidForPause } from './sync-state/remote-observation.js';
import type { JsonObject, MappingInput, MountBindingRecord, ScopeCommandPlanRecord, SyncScope, createSyncStateStore } from './sync-state-store.js';

type Store = ReturnType<typeof createSyncStateStore>;
type Input = RejoinChrome & { store: Store; scope: SyncScope; mount: MountBindingRecord };
type Restore = { plan: ScopeCommandPlanRecord; orders: readonly RejoinRestoreOrder[] };

/** Authoritative remote members include `unmounted:*` descendants of the mount remote id. */
export function rejoinMemberMappings(all: readonly MappingInput[], mount: MountBindingRecord): MappingInput[] {
  const descendants = remoteDescendantIds(all, mount.remoteMountNodeId);
  return all.filter((row) => row.mountId === mount.mountId || row.rootNativeId === mount.nativeRootId
    || isUnmountedRemoteMember(row, mount, descendants));
}

export function unmountedRejoinMembers(all: readonly MappingInput[], mount: MountBindingRecord): MappingInput[] {
  const descendants = remoteDescendantIds(all, mount.remoteMountNodeId);
  return all.filter((row) => isUnmountedRemoteMember(row, mount, descendants));
}

export async function materializeUnmountedRejoinMembers(input: Input, all: readonly MappingInput[]): Promise<{
  readonly applied: number; readonly unknown: number;
}> {
  const byColp = mapByColp(all);
  const mounts = new Map((await input.store.listMountBindings(input.scope)).map(row => [row.mountId, row]));
  const restores = new Map<string, Restore>();
  for (const plan of await input.store.listScopeCommandPlans(input.scope)) {
    if (plan.mountId !== input.mount.mountId || plan.retryReason !== 'keep_remote' || plan.phase !== 'applying') continue;
    const orders = restoreEvidence(plan).orders;
    for (const id of plan.dependencies) restores.set(id, { plan, orders });
  }
  const included = new Map(unmountedRejoinMembers(all, input.mount).map(row => [row.colpId, row]));
  for (const id of restores.keys()) {
    const row = byColp.get(id);
    if (row?.nativeId.startsWith(UNMOUNTED_PREFIX)) included.set(id, row);
  }
  const members = parentFirst([...included.values()], input.mount.remoteMountNodeId);
  const observations = new Map((await input.store.listRemoteObservations(input.scope))
    .filter((row) => observationValidForPause(row, input.mount.pauseBaseline)).map((row) => [row.colpId, row]));
  let applied = 0; let unknown = 0;
  for (const mapping of members) {
    const restore = restores.get(mapping.colpId);
    const destination = restore && mapping.mountId ? mounts.get(mapping.mountId) : input.mount;
    if (!destination) { unknown++; continue; }
    // A cloud move into another paused range remains virtual until that range is separately selected.
    if (destination.status === 'detached' && destination.mountId !== input.mount.mountId) continue;
    const scoped = { ...input, mount: destination };
    const observation = restore ? undefined : observations.get(mapping.colpId);
    if (observation?.kind === 'tombstone') {
      await input.store.deleteMapping(input.scope, mapping.nativeId);
      byColp.delete(mapping.colpId);
      applied++; continue;
    }
    const parentNativeId = await liveParentNativeId(scoped, mapping, byColp);
    if (!parentNativeId) { unknown++; continue; }
    if (mapping.nodeKind === 'separator') {
      await assertRejoinBoundary(scoped, mapping, { parentNativeId });
      const rebound = await rebind(scoped, mapping, `sidecar:${mapping.colpId}`, parentNativeId);
      byColp.set(rebound.colpId, rebound); applied++; continue;
    }
    const created = await createIndependentNative(scoped, mapping, parentNativeId, observation?.payload, byColp, restore);
    if (!created) { unknown++; continue; }
    const rebound = await rebind(scoped, mapping, created, parentNativeId);
    byColp.set(rebound.colpId, rebound); applied++;
    const intentId = restore ? `rejoin-restore:${digestJson({ commandId: restore.plan.commandId, token: restore.plan.baselineDigest, colpId: mapping.colpId })}`
      : `rejoin:${input.mount.mountId}:${mapping.colpId}`;
    await input.store.persistApplyIntentFacts(input.scope, intentId, { state: 'page_complete' });
  }
  if (!unknown && input.getChildren) {
    const orders = new Map<string, RejoinRestoreOrder>();
    for (const restore of restores.values()) for (const order of restore.orders) orders.set(order.parentId, order);
    for (const order of orders.values()) {
      const parent = byColp.get(order.parentId);
      if (!parent || isNonChromeNativeId(parent.nativeId) || !await input.getNative(parent.nativeId)) continue;
      const childrenOrder = (await input.getChildren(parent.nativeId)).map(row => row.id);
      await saveMaterializedOrder(input, parent, childrenOrder, order.childrenRevision);
    }
  }
  return { applied, unknown };
}

function isUnmountedRemoteMember(mapping: MappingInput, mount: MountBindingRecord,
  descendants: ReadonlySet<string>): boolean {
  if (!mapping.nativeId.startsWith(UNMOUNTED_PREFIX) || !mount.remoteMountNodeId) return false;
  if (mapping.colpId === mount.remoteMountNodeId) return false;
  return descendants.has(mapping.colpId);
}

async function liveParentNativeId(input: Input, mapping: MappingInput,
  byColp: Map<string, MappingInput>): Promise<string | undefined> {
  const parentColpId = mapping.parentColpId;
  if (!parentColpId || parentColpId === input.mount.remoteMountNodeId) {
    return liveChromeId(input, input.mount.nativeRootId);
  }
  const parent = byColp.get(parentColpId);
  if (!parent || isNonChromeNativeId(parent.nativeId)) return undefined;
  return liveChromeId(input, parent.nativeId);
}

async function liveChromeId(input: Input, nativeId: string | undefined): Promise<string | undefined> {
  if (!nativeId || isNonChromeNativeId(nativeId)) return undefined;
  return await input.getNative(nativeId) ? nativeId : undefined;
}

async function createIndependentNative(input: Input, mapping: MappingInput, parentNativeId: string,
  observation: JsonObject | undefined, byColp: Map<string, MappingInput>, restore?: Restore): Promise<string | undefined> {
  if (!input.createNative) return undefined;
  const recorded = await input.store.getScope(input.scope);
  const node = chromeNode(mapping, observation);
  const index = await insertionIndex(input, mapping, parentNativeId, byColp, restore);
  const intentId = restore ? `rejoin-restore:${digestJson({ commandId: restore.plan.commandId, token: restore.plan.baselineDigest, colpId: mapping.colpId })}`
    : `rejoin:${input.mount.mountId}:${mapping.colpId}`;
  const title = typeof node.title === 'string' ? node.title : undefined;
  const url = typeof node.url === 'string' ? node.url : undefined;
  const outcome = await executeNativeCreate({
    scope: input.scope, store: input.store, api: { getChildren: input.getChildren ?? (async () => []) },
    intentId, owner: {
      scopeKey: scopeKey(input.scope), generation: input.scope.generation,
      commandId: restore?.plan.commandId ?? `rejoin:${input.mount.mountId}`, eventId: intentId, colpId: mapping.colpId, substep: 'create',
    },
    parentNativeId, expected: { ...(title === undefined ? {} : { title }), ...(url === undefined ? {} : { url }) },
    liveWorkKind: 'rejoin',
    permissionGranted: recorded?.rootStatus !== 'permission_required', crash: input.crash,
    create: async () => {
      input.crash?.('after_rejoin_create_intent');
      await assertRejoinBoundary(input, mapping, { parentNativeId,
        ...(typeof restore?.plan.rejoinDecision?.boundaryDigest === 'string'
          ? { expectedBoundary: restore.plan.rejoinDecision.boundaryDigest } : {}) });
      return input.createNative!({ parentId: parentNativeId, index,
        ...(title === undefined ? {} : { title }), ...(url === undefined ? {} : { url }) });
    },
  });
  if (outcome.result !== 'applied_with_evidence' || !await input.getNative(outcome.nativeId)) return undefined;
  const owner = occupancyByNative({ liveMappings: [...byColp.values()] }).get(outcome.nativeId);
  if (owner !== undefined && owner !== mapping.colpId) return undefined;
  return outcome.nativeId;
}

async function rebind(input: Input, mapping: MappingInput, nativeId: string, parentNativeId: string): Promise<MappingInput> {
  const rebound = {
    ...strip(mapping), nativeId, parentNativeId, rootNativeId: input.mount.nativeRootId, mountId: input.mount.mountId,
    ...(mapping.parentColpId ? { parentColpId: mapping.parentColpId } : {}),
  };
  await input.store.putMapping(input.scope, rebound);
  return rebound;
}

function chromeNode(mapping: MappingInput, observation: JsonObject | undefined): JsonObject {
  const content = { ...(mapping.projection.content ?? {}), ...contentOf(observation) };
  const title = typeof content.title === 'string' ? content.title : '';
  if (mapping.nodeKind === 'folder') return { kind: 'folder', title };
  return { kind: 'bookmark', title, url: typeof content.url === 'string' ? content.url : '' };
}

function contentOf(value: JsonObject | undefined): JsonObject {
  if (!value) return {};
  return {
    ...(typeof value.title === 'string' ? { title: value.title } : {}),
    ...(typeof value.url === 'string' ? { url: value.url } : {}),
  };
}

function mapByColp(all: readonly MappingInput[]): Map<string, MappingInput> {
  return new Map(all.map((row) => [row.colpId, row]));
}

function strip(mapping: MappingInput & { readonly scopeKey?: string }): MappingInput {
  const { scopeKey: _scopeKey, ...value } = mapping;
  return value;
}

async function insertionIndex(input: Input, mapping: MappingInput, parentNativeId: string,
  byColp: Map<string, MappingInput>, restore?: Restore): Promise<number> {
  const children = input.getChildren ? await input.getChildren(parentNativeId) : [];
  const ids = restore?.orders.find(row => row.parentId === mapping.parentColpId)?.children;
  if (!ids) return children.length;
  const desired = ids.indexOf(mapping.colpId);
  const existing = new Map(children.map((row, index) => [row.id, index]));
  for (let index = desired + 1; index < ids.length; index++) {
    const nativeId = byColp.get(ids[index]!)?.nativeId;
    if (nativeId && existing.has(nativeId)) return existing.get(nativeId)!;
  }
  return children.length;
}
async function saveMaterializedOrder(input: Input, parent: MappingInput, childrenOrder: string[], childrenRevision: string) {
  const projection = { ...parent.projection, childrenOrder, childrenRevision };
  try { await input.store.putMapping(input.scope, { ...strip(parent), projection }); }
  catch (error) {
    if (!(error instanceof Error) || error.message !== 'record_too_large') throw error;
    const { childrenOrder: _order, ...withoutOrder } = projection;
    await input.store.putMapping(input.scope, { ...strip(parent), projection: withoutOrder });
  }
}
