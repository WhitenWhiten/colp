import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { BootstrapMode, SpecialFolderRole } from '../sync-state/types.js';
import { canonicalJson } from '../sync-state/codec.js';
import {
  buildLocalIndex, buildRemoteIndex, encodeFactKey, mappingByNativeMap, matchIndexBuilds,
  mountsByNativeRoot, SPECIAL_FOLDER_ROLES, type MatchIndexStats,
} from './match-index.js';

export type { MatchIndexStats } from './match-index.js';

// Mapping/sidecar/sourceRef are identity. Unmapped pairing and candidates use the stored URL string exactly.
export type BootstrapNodeKind = 'folder' | 'bookmark' | 'separator';
const SPECIAL = SPECIAL_FOLDER_ROLES;

let lastIndexStats: MatchIndexStats | null = null;
export function lastMatchIndexStats(): MatchIndexStats | null {
  return lastIndexStats;
}

export interface LocalNodeFact {
  readonly nativeId: string; readonly mountNativeRootId: string; readonly parentNativeId: string | null;
  readonly kind: BootstrapNodeKind; readonly title: string; readonly url?: string;
  readonly sourceRefColpId?: string;
  readonly managed?: boolean; readonly privateLocal?: boolean; readonly index?: number;
}
export interface RemoteNodeFact {
  readonly nodeId: string; readonly parentId: string | null; readonly kind: BootstrapNodeKind;
  readonly title: string; readonly url?: string; readonly folderRole?: string; readonly revision: string;
  readonly description?: string | null;
  readonly tags?: readonly string[];
  /** Bookmarks: the node's extension map, when it has one (the pin lives there). */
  readonly extensions?: Readonly<Record<string, unknown>>;
  readonly managed?: boolean; readonly privateLocal?: boolean; readonly position?: string;
  readonly childrenRevision?: string;
}
export interface MappingFact { readonly nativeId: string; readonly colpId: string }
export interface SidecarFact { readonly nativeId: string; readonly colpId: string }
export interface MountFact {
  readonly nativeRootId: string; readonly rootRole?: SpecialFolderRole; readonly customSourceKey?: string;
  readonly remoteMountNodeId: string | null;
}
export interface DuplicateCandidate {
  readonly kind: 'duplicate_candidate'; readonly url: string;
  readonly nodeIds: readonly string[]; readonly parents: readonly string[];
}
export interface MatchConflict {
  readonly kind: 'title' | 'url' | 'parent'; readonly localNativeId: string; readonly remoteNodeId: string;
}
export interface PlannedOperation {
  readonly opId: string; readonly type: 'create_node' | 'update_node_content' | 'move_node' | 'delete_node';
  readonly nativeId?: string; readonly parentId?: string; readonly targetId?: string;
  readonly node?: { readonly kind: BootstrapNodeKind; readonly title: string; readonly url?: string;
    readonly folderRole?: string };
  readonly reason: 'local-only' | 'mount-resolve' | 'matched-update' | 'destructive';
}
export interface DestructivePlan {
  readonly mode: 'download' | 'upload' | 'mirror'; readonly requiresConfirmation: true;
  readonly confirmed: boolean;
  readonly deletes: readonly { readonly targetId: string; readonly side: 'local' | 'remote';
    readonly nativeId?: string }[];
}
export interface LocalMatchReport {
  readonly kind: 'local-match-report'; readonly scopeKey: string; readonly reportDigest: string;
  readonly matched: readonly { readonly nativeId: string; readonly nodeId: string }[];
  readonly localOnly: readonly string[]; readonly remoteOnly: readonly string[];
  readonly candidates: readonly DuplicateCandidate[]; readonly conflicts: readonly MatchConflict[];
  readonly planned: readonly PlannedOperation[]; readonly destructivePlan?: DestructivePlan;
  readonly collectionRootDirectBookmarks: 0; readonly emptyRemote: boolean;
  readonly mountResolveRoles: readonly string[];
}

export function matchLocalRemote(input: {
  readonly scopeKey: string; readonly confirmationId: string; readonly local: readonly LocalNodeFact[];
  readonly remote: readonly RemoteNodeFact[]; readonly mappings: readonly MappingFact[];
  readonly sidecars?: readonly SidecarFact[]; readonly mounts: readonly MountFact[];
  readonly rootNodeId: string | null; readonly bootstrapMode: BootstrapMode;
  readonly destructiveConfirmed?: boolean; readonly previewOnly?: boolean;
}): LocalMatchReport {
  matchIndexBuilds.reset();
  const localIndex = buildLocalIndex(input.local);
  const remoteIndex = buildRemoteIndex(input.remote, input.local.length);
  lastIndexStats = remoteIndex.stats;
  const localById = localIndex.byId;
  const remoteById = remoteIndex.byId;
  const mountsByRoot = mountsByNativeRoot(input.mounts);
  const mappingByNative = mappingByNativeMap(input.mappings);
  const consumedL = new Set<string>(); const consumedR = new Set<string>();
  const matched: Array<{ nativeId: string; nodeId: string }> = [];
  const conflicts: MatchConflict[] = [];
  const pair = (nativeId: string, nodeId: string) => {
    if (consumedL.has(nativeId) || consumedR.has(nodeId)) return;
    const local = localById.get(nativeId); const remote = remoteById.get(nodeId);
    if (!local || !remote) return;
    consumedL.add(nativeId); consumedR.add(nodeId); matched.push({ nativeId, nodeId });
    mappingByNative.set(nativeId, nodeId);
    if (local.title !== remote.title) conflicts.push({ kind: 'title', localNativeId: nativeId, remoteNodeId: nodeId });
    if ((local.url ?? '') !== (remote.url ?? '')) {
      conflicts.push({ kind: 'url', localNativeId: nativeId, remoteNodeId: nodeId });
    }
    const localParent = mappedParent(local, mappingByNative, input.mounts, input.rootNodeId, remoteIndex, mountsByRoot);
    if (localParent && remote.parentId && localParent !== remote.parentId) {
      conflicts.push({ kind: 'parent', localNativeId: nativeId, remoteNodeId: nodeId });
    }
  };
  for (const mapping of input.mappings) pair(mapping.nativeId, mapping.colpId);
  for (const row of input.local) {
    if (row.sourceRefColpId) pair(row.nativeId, row.sourceRefColpId);
  }
  for (const sidecar of input.sidecars ?? []) pair(sidecar.nativeId, sidecar.colpId);
  pairStructureByParentDepth(input, localIndex, remoteIndex, mappingByNative, mountsByRoot, consumedL, consumedR, pair);
  const candidates: DuplicateCandidate[] = [];
  const seenCandidate = new Set<string>();
  const addCandidate = (url: string, nodeIds: readonly string[], parents: readonly string[]) => {
    const key = encodeFactKey([url, ...[...nodeIds].sort()]);
    if (seenCandidate.has(key) || nodeIds.length < 2) return;
    seenCandidate.add(key);
    candidates.push({ kind: 'duplicate_candidate', url, nodeIds, parents });
  };
  // Candidate groups are mount-scoped exact raw URLs. Do not fold case, port,
  // slash, fragment, query, or tracking variants, and do not plan a merge.
  const urlGroups = new Map<string, { locals: LocalNodeFact[]; remotes: RemoteNodeFact[] }>();
  for (const row of input.local) {
    if (!row.url || consumedL.has(row.nativeId)) continue;
    const key = encodeFactKey([
      mountRemoteId(row.mountNativeRootId, input.mounts, remoteIndex, input.rootNodeId, mappingByNative, mountsByRoot),
      row.url,
    ]);
    const group = urlGroups.get(key) ?? { locals: [], remotes: [] };
    group.locals.push(row); urlGroups.set(key, group);
  }
  for (const row of input.remote) {
    if (!row.url || consumedR.has(row.nodeId) || row.folderRole === 'root') continue;
    const key = encodeFactKey([remoteIndex.mountOf.get(row.nodeId) ?? row.nodeId, row.url]);
    const group = urlGroups.get(key) ?? { locals: [], remotes: [] };
    group.remotes.push(row); urlGroups.set(key, group);
  }
  for (const group of urlGroups.values()) {
    const url = group.locals[0]?.url ?? group.remotes[0]?.url;
    if (!url) continue;
    const freeLocals = group.locals.filter((row) => !consumedL.has(row.nativeId));
    const freeRemotes = group.remotes.filter((row) => !consumedR.has(row.nodeId));
    if (freeLocals.length === 0 && freeRemotes.length === 0) continue;
    const parents = [...new Set([...group.locals.map((row) => row.parentNativeId ?? ''),
      ...group.remotes.map((row) => row.parentId ?? '')])];
    const nodeIds = [...group.remotes.map((row) => row.nodeId), ...freeLocals.map((row) => row.nativeId)];
    if (parents.length > 1 || (freeLocals.length > 0 && group.remotes.length > 0)) {
      addCandidate(url, nodeIds.length >= 2 ? nodeIds : [...group.locals.map((row) => row.nativeId),
        ...group.remotes.map((row) => row.nodeId)], [...parents]);
    }
  }
  const emptyRemote = input.remote.every((row) => row.folderRole === 'root' || row.parentId === null)
    && !input.remote.some((row) => row.kind === 'bookmark' || (row.folderRole && SPECIAL.has(row.folderRole)));
  const mountResolveRoles = emptyRemote ? input.mounts.flatMap((mount) => mount.rootRole ? [mount.rootRole] : []) : [];
  const planned: PlannedOperation[] = [];
  if (!input.previewOnly && (input.bootstrapMode === 'merge'
      || (input.bootstrapMode !== 'download' && input.destructiveConfirmed))) {
    for (const mount of input.mounts) {
      const created = planMountCreate(mount, input, mappingByNative, localById, consumedL);
      if (created) planned.push(created);
    }
    const mountNatives = new Set(input.mounts.map((mount) => mount.nativeRootId));
    const remaining = input.local.filter((row) => !consumedL.has(row.nativeId) && row.kind !== 'separator'
      && !mountNatives.has(row.nativeId));
    remaining.sort((left, right) => depth(left, localById) - depth(right, localById)
      || Number(left.kind === 'bookmark') - Number(right.kind === 'bookmark')
      || left.nativeId.localeCompare(right.nativeId));
    for (const row of remaining) {
      const parentId = mappedParent(row, mappingByNative, input.mounts, input.rootNodeId, remoteIndex, mountsByRoot);
      if (input.rootNodeId && parentId === input.rootNodeId && row.kind === 'bookmark') continue;
      planned.push({
        opId: opId(input.confirmationId, 'create', row.nativeId), type: 'create_node', nativeId: row.nativeId,
        ...(parentId ? { parentId } : {}),
        node: { kind: row.kind, title: row.title, ...(row.url ? { url: row.url } : {}) }, reason: 'local-only',
      });
    }
  }
  const localOnly = input.local.filter((row) => !consumedL.has(row.nativeId)).map((row) => row.nativeId);
  const remoteOnly = input.remote.filter((row) => !consumedR.has(row.nodeId) && row.folderRole !== 'root'
    && !(row.folderRole && SPECIAL.has(row.folderRole))).map((row) => row.nodeId);
  let destructivePlan: DestructivePlan | undefined;
  if (input.bootstrapMode !== 'merge') {
    const remoteDescendants = mountedDescendants(input.mounts, remoteById, input.rootNodeId);
    const nativeRoots = new Set(input.mounts.map((mount) => mount.nativeRootId));
    const deletes = input.bootstrapMode === 'download'
      ? localOnly.filter((id) => !nativeRoots.has(id))
        .map((nativeId) => ({ targetId: nativeId, side: 'local' as const, nativeId }))
      : remoteOnly.filter((id) => remoteDescendants.has(id))
        .map((targetId) => ({ targetId, side: 'remote' as const }));
    destructivePlan = { mode: input.bootstrapMode, requiresConfirmation: true,
      confirmed: input.destructiveConfirmed === true, deletes };
    if (input.bootstrapMode !== 'download' && input.destructiveConfirmed && !input.previewOnly) {
      // Not reachable today: `createBootstrapCoordinator.confirm/advance` throws
      // `bootstrap_execution_unsupported` for a confirmed destructive bootstrap.
      // If it is ever enabled it must pick the shape from the target kind
      // (folder => `delete_subtree`), like `planUploadDeletes` does.
      for (const item of deletes) {
        planned.push({ opId: opId(input.confirmationId, 'delete', item.targetId), type: 'delete_node',
          targetId: item.targetId, ...('nativeId' in item ? { nativeId: item.nativeId } : {}),
          reason: 'destructive' });
      }
    }
  }
  const report: Omit<LocalMatchReport, 'reportDigest'> = {
    kind: 'local-match-report', scopeKey: input.scopeKey, matched, localOnly, remoteOnly, candidates, conflicts,
    planned, ...(destructivePlan ? { destructivePlan } : {}), collectionRootDirectBookmarks: 0, emptyRemote,
    mountResolveRoles,
  };
  return { ...report, reportDigest: digest(report) };
}

/** A Collection snapshot can include other devices' mounts. Never treat those as local omissions. */
function mountedDescendants(mounts: readonly MountFact[],
  remote: ReadonlyMap<string, RemoteNodeFact>, rootNodeId: string | null): ReadonlySet<string> {
  const roots = new Set(mounts.flatMap((mount) => {
    if (authoritativeColp(mount.remoteMountNodeId)) return [mount.remoteMountNodeId];
    return [...remote.values()].filter((row) => mount.rootRole && row.folderRole === mount.rootRole
      && row.parentId === rootNodeId).map((row) => row.nodeId);
  }));
  const children = new Map<string, string[]>();
  for (const row of remote.values()) {
    if (!row.parentId) continue;
    const siblings = children.get(row.parentId) ?? [];
    siblings.push(row.nodeId); children.set(row.parentId, siblings);
  }
  const visited = new Set(roots); const pending = [...roots]; const descendants = new Set<string>();
  for (let index = 0; index < pending.length; index += 1) {
    for (const child of children.get(pending[index]!) ?? []) {
      if (visited.has(child)) continue;
      visited.add(child); descendants.add(child); pending.push(child);
    }
  }
  return descendants;
}

export function digest(value: unknown): string {
  return `sha256:${bytesToHex(sha256(new TextEncoder().encode(canonicalJson(value))))}`;
}

export function bootstrapOpId(confirmationId: string, kind: string, key: string): string {
  return opId(confirmationId, kind, key);
}

export function mountResolveOpIdMatches(opId: string, key: string): boolean {
  return opId.includes('.mount.') && opId.endsWith(`.${opaqueSegment(key)}`);
}

const OPAQUE_SEGMENT = /[A-Za-z0-9_-]/;

function opId(confirmationId: string, kind: string, key: string): string {
  const encoded = `b3.${opaqueSegment(confirmationId)}.${kind}.${opaqueSegment(key)}`;
  if (encoded.length <= 128) return encoded;
  return `b3.${bytesToHex(sha256(new TextEncoder().encode(canonicalJson([confirmationId, kind, key]))))}`;
}

function opaqueSegment(value: string): string {
  let encoded = '';
  for (const byte of new TextEncoder().encode(value)) {
    const char = String.fromCharCode(byte);
    encoded += OPAQUE_SEGMENT.test(char) ? char : `~${byte.toString(16).padStart(2, '0')}`;
  }
  return encoded;
}

function planMountCreate(mount: MountFact, input: {
  readonly confirmationId: string; readonly remote: readonly RemoteNodeFact[];
  readonly rootNodeId: string | null;
}, mappingByNative: ReadonlyMap<string, string>, localById: ReadonlyMap<string, LocalNodeFact>,
  consumedL: ReadonlySet<string>): PlannedOperation | undefined {
  const key = mount.rootRole ?? mount.customSourceKey;
  if (!key || !input.rootNodeId || authoritativeColp(mount.remoteMountNodeId)) return undefined;
  if (authoritativeColp(mappingByNative.get(mount.nativeRootId))) return undefined;
  if (mount.rootRole) {
    if (input.remote.some((row) => row.folderRole === mount.rootRole)) return undefined;
  } else if (consumedL.has(mount.nativeRootId)) return undefined;
  const title = mount.rootRole ?? localById.get(mount.nativeRootId)?.title;
  if (title === undefined) return undefined;
  return {
    opId: opId(input.confirmationId, 'mount', key), type: 'create_node', nativeId: mount.nativeRootId,
    parentId: input.rootNodeId,
    node: { kind: 'folder', title, folderRole: mount.rootRole ?? 'custom' }, reason: 'mount-resolve',
  };
}

function authoritativeColp(id: string | undefined | null): id is string {
  return typeof id === 'string' && !id.startsWith('mount:') && !id.startsWith('pending-');
}

function pairStructureByParentDepth(
  input: {
    readonly local: readonly LocalNodeFact[]; readonly remote: readonly RemoteNodeFact[];
    readonly mounts: readonly MountFact[]; readonly rootNodeId: string | null;
  },
  localIndex: ReturnType<typeof buildLocalIndex>,
  remoteIndex: ReturnType<typeof buildRemoteIndex>,
  mappingByNative: Map<string, string>,
  mountsByRoot: ReadonlyMap<string, MountFact>,
  consumedL: ReadonlySet<string>,
  consumedR: ReadonlySet<string>,
  pair: (nativeId: string, nodeId: string) => void,
): void {
  const remoteBuckets = new Map<string, string[]>();
  for (const row of input.remote) {
    if (consumedR.has(row.nodeId) || row.kind === 'separator' || row.folderRole === 'root') continue;
    const key = encodeFactKey([
      remoteIndex.mountOf.get(row.nodeId) ?? row.nodeId, row.parentId, row.title, row.url,
    ]);
    const bucket = remoteBuckets.get(key) ?? [];
    bucket.push(row.nodeId);
    remoteBuckets.set(key, bucket);
  }
  const byDepth = new Map<number, LocalNodeFact[]>();
  for (const row of input.local) {
    if (consumedL.has(row.nativeId) || row.kind === 'separator') continue;
    const level = depth(row, localIndex.byId);
    const list = byDepth.get(level) ?? [];
    list.push(row);
    byDepth.set(level, list);
  }
  const depths = [...byDepth.keys()].sort((left, right) => left - right);
  for (const level of depths) {
    const structure = new Map<string, string[]>();
    for (const row of byDepth.get(level) ?? []) {
      if (consumedL.has(row.nativeId)) continue;
      const key = structureKey(row, mappingByNative, input.mounts, input.rootNodeId, remoteIndex, mountsByRoot);
      const bucket = structure.get(key) ?? [];
      bucket.push(row.nativeId);
      structure.set(key, bucket);
    }
    for (const [key, locals] of structure) {
      const remotes = (remoteBuckets.get(key) ?? []).filter((id) => !consumedR.has(id));
      if (locals.length === 1 && remotes.length === 1) pair(locals[0]!, remotes[0]!);
    }
  }
}

function mountRemoteId(nativeRootId: string, mounts: readonly MountFact[],
  remoteIndex: ReturnType<typeof buildRemoteIndex>, rootNodeId: string | null,
  mappingByNative: ReadonlyMap<string, string> | undefined,
  mountsByRoot: ReadonlyMap<string, MountFact>): string {
  const mount = mountsByRoot.get(nativeRootId) ?? mounts.find((item) => item.nativeRootId === nativeRootId);
  if (mount && authoritativeColp(mount.remoteMountNodeId)) return mount.remoteMountNodeId;
  const mapped = mappingByNative?.get(nativeRootId);
  if (authoritativeColp(mapped)) return mapped;
  if (mount?.rootRole) {
    const found = remoteIndex.specialByRole.get(mount.rootRole);
    if (found) {
      const row = remoteIndex.byId.get(found);
      if (row && (rootNodeId === null || row.parentId === rootNodeId || row.parentId === null)) return found;
    }
  }
  return `mount:${nativeRootId}`;
}

function mappedParent(local: LocalNodeFact, mappingByNative: ReadonlyMap<string, string>,
  mounts: readonly MountFact[], rootNodeId: string | null,
  remoteIndex: ReturnType<typeof buildRemoteIndex>,
  mountsByRoot: ReadonlyMap<string, MountFact>): string | undefined {
  if (local.parentNativeId === null || local.parentNativeId === local.mountNativeRootId) {
    const bound = mountsByRoot.get(local.mountNativeRootId)?.remoteMountNodeId
      ?? mounts.find((item) => item.nativeRootId === local.mountNativeRootId)?.remoteMountNodeId;
    if (authoritativeColp(bound)) return bound;
    const mapped = mappingByNative.get(local.mountNativeRootId);
    if (authoritativeColp(mapped)) return mapped;
    return (local.kind === 'folder' && (mountsByRoot.has(local.nativeId)
      || mounts.some((item) => item.nativeRootId === local.nativeId))
      ? rootNodeId ?? undefined
      : mountRemoteId(local.mountNativeRootId, mounts, remoteIndex, rootNodeId, mappingByNative, mountsByRoot));
  }
  const mapped = mappingByNative.get(local.parentNativeId);
  if (authoritativeColp(mapped)) return mapped;
  const resolved = mountRemoteId(local.parentNativeId, mounts, remoteIndex, rootNodeId, mappingByNative, mountsByRoot);
  return resolved.startsWith('mount:') ? undefined : resolved;
}

function structureKey(local: LocalNodeFact, mappingByNative: ReadonlyMap<string, string>,
  mounts: readonly MountFact[], rootNodeId: string | null,
  remoteIndex: ReturnType<typeof buildRemoteIndex>,
  mountsByRoot: ReadonlyMap<string, MountFact>): string {
  return encodeFactKey([
    mountRemoteId(local.mountNativeRootId, mounts, remoteIndex, rootNodeId, mappingByNative, mountsByRoot),
    mappedParent(local, mappingByNative, mounts, rootNodeId, remoteIndex, mountsByRoot),
    local.title, local.url,
  ]);
}

function depth(row: LocalNodeFact, byId: ReadonlyMap<string, LocalNodeFact>): number {
  let current: LocalNodeFact | undefined = row; let n = 0;
  while (current?.parentNativeId) {
    n += 1; current = byId.get(current.parentNativeId);
    if (n > 256) break;
  }
  return n;
}
