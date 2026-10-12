import { occupancyByNative } from './projection-native-occupancy.js';
import { executeNativeCreate } from './native-create-executor.js';
import { isNonChromeNativeId, UNMOUNTED_PREFIX } from './pull-mount-apply.js';
import { scopeKey } from './sync-state/scope-key.js';
import type { RejoinChrome } from './scope-rejoin-mutation.js';
import { observationValidForPause } from './sync-state/remote-observation.js';
import type { JsonObject, MappingInput, MountBindingRecord, SyncScope, createSyncStateStore } from './sync-state-store.js';

type Store = ReturnType<typeof createSyncStateStore>;
type Input = RejoinChrome & { store: Store; scope: SyncScope; mount: MountBindingRecord };

/** Authoritative remote members include `unmounted:*` descendants of the mount remote id. */
export function rejoinMemberMappings(all: readonly MappingInput[], mount: MountBindingRecord): MappingInput[] {
  const byColp = mapByColp(all);
  return all.filter((row) => row.mountId === mount.mountId || row.rootNativeId === mount.nativeRootId
    || isUnmountedRemoteMember(row, mount, byColp));
}

export function unmountedRejoinMembers(all: readonly MappingInput[], mount: MountBindingRecord): MappingInput[] {
  const byColp = mapByColp(all);
  return all.filter((row) => isUnmountedRemoteMember(row, mount, byColp));
}

export async function materializeUnmountedRejoinMembers(input: Input, all: readonly MappingInput[]): Promise<{
  readonly applied: number; readonly unknown: number;
}> {
  const members = parentFirst(unmountedRejoinMembers(all, input.mount), input.mount.remoteMountNodeId);
  const byColp = mapByColp(all);
  const observations = new Map((await input.store.listRemoteObservations(input.scope))
    .filter((row) => observationValidForPause(row, input.mount.pauseBaseline)).map((row) => [row.colpId, row]));
  let applied = 0; let unknown = 0;
  for (const mapping of members) {
    const observation = observations.get(mapping.colpId);
    if (observation?.kind === 'tombstone') {
      await input.store.deleteMapping(input.scope, mapping.nativeId);
      byColp.delete(mapping.colpId);
      applied++; continue;
    }
    const parentNativeId = await liveParentNativeId(input, mapping, byColp);
    if (!parentNativeId) { unknown++; continue; }
    if (mapping.nodeKind === 'separator') {
      const rebound = await rebind(input, mapping, `sidecar:${mapping.colpId}`, parentNativeId);
      byColp.set(rebound.colpId, rebound); applied++; continue;
    }
    const created = await createIndependentNative(input, mapping, parentNativeId, observation?.payload, byColp);
    if (!created) { unknown++; continue; }
    const rebound = await rebind(input, mapping, created, parentNativeId);
    byColp.set(rebound.colpId, rebound); applied++;
  }
  return { applied, unknown };
}

function isUnmountedRemoteMember(mapping: MappingInput, mount: MountBindingRecord,
  byColp: Map<string, MappingInput>): boolean {
  if (!mapping.nativeId.startsWith(UNMOUNTED_PREFIX) || !mount.remoteMountNodeId) return false;
  if (mapping.colpId === mount.remoteMountNodeId) return false;
  return ancestorColpReaches(mapping.parentColpId, mount.remoteMountNodeId, byColp);
}

function ancestorColpReaches(start: string | undefined, ancestor: string, byColp: Map<string, MappingInput>): boolean {
  const seen = new Set<string>();
  let current = start;
  while (current) {
    if (current === ancestor) return true;
    if (seen.has(current)) return false;
    seen.add(current);
    current = byColp.get(current)?.parentColpId;
  }
  return false;
}

function parentFirst(rows: readonly MappingInput[], remoteMountNodeId: string | null): MappingInput[] {
  const remaining = new Set(rows);
  const ordered: MappingInput[] = [];
  while (remaining.size) {
    const ready = [...remaining].filter((row) => {
      const parent = row.parentColpId;
      return !parent || parent === remoteMountNodeId || ![...remaining].some((other) => other.colpId === parent);
    }).sort((left, right) => folderRank(left) - folderRank(right) || left.colpId.localeCompare(right.colpId));
    if (!ready.length) { ordered.push(...remaining); break; }
    for (const row of ready) { remaining.delete(row); ordered.push(row); }
  }
  return ordered;
}

function folderRank(mapping: MappingInput): number {
  return mapping.nodeKind === 'folder' ? 0 : 1;
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
  try { return await input.getNative(nativeId) ? nativeId : undefined; }
  catch { return undefined; }
}

async function createIndependentNative(input: Input, mapping: MappingInput, parentNativeId: string,
  observation: JsonObject | undefined, byColp: Map<string, MappingInput>): Promise<string | undefined> {
  if (!input.createNative) return undefined;
  const recorded = await input.store.getScope(input.scope);
  const node = chromeNode(mapping, observation);
  const index = input.getChildren ? (await input.getChildren(parentNativeId)).length : 0;
  const intentId = `rejoin:${input.mount.mountId}:${mapping.colpId}`;
  const title = typeof node.title === 'string' ? node.title : undefined;
  const url = typeof node.url === 'string' ? node.url : undefined;
  const outcome = await executeNativeCreate({
    scope: input.scope, store: input.store, api: {
      create: input.createNative, update: async () => undefined, move: async () => undefined,
      remove: async () => undefined, removeTree: async () => undefined,
      get: async (id) => {
        const live = await input.getNative(id);
        if (!live) throw new Error("Can't find bookmark for id.");
        return [{ id, ...live }];
      },
      getChildren: input.getChildren ?? (async () => []),
    },
    intentId, owner: {
      scopeKey: scopeKey(input.scope), generation: input.scope.generation,
      commandId: `rejoin:${input.mount.mountId}`, eventId: intentId, colpId: mapping.colpId, substep: 'create',
    },
    parentNativeId, expected: { ...(title === undefined ? {} : { title }), ...(url === undefined ? {} : { url }) },
    liveWorkKind: 'rejoin',
    permissionGranted: recorded?.rootStatus !== 'permission_required',
    create: async () => input.createNative!({
      parentId: parentNativeId, index,
      ...(title === undefined ? {} : { title }), ...(url === undefined ? {} : { url }),
    }),
  });
  if (outcome.result !== 'applied_with_evidence') return undefined;
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
