import type { LocalNodeFact, MappingFact, MountFact, RemoteNodeFact } from './matcher.js';

export const SPECIAL_FOLDER_ROLES: ReadonlySet<string> = new Set([
  'bookmarks-bar', 'other-bookmarks', 'mobile-bookmarks',
]);

export interface MatchIndexStats {
  readonly localCount: number;
  readonly remoteCount: number;
  readonly localIndexBuilds: number;
  readonly remoteIndexBuilds: number;
  readonly mountIndexBuilds: number;
  readonly mountChainVisits: number;
}

export interface RemoteMatchIndex {
  readonly byId: ReadonlyMap<string, RemoteNodeFact>;
  readonly children: ReadonlyMap<string, readonly string[]>;
  readonly mountOf: ReadonlyMap<string, string>;
  readonly specialByRole: ReadonlyMap<string, string>;
  readonly stats: MatchIndexStats;
}

export interface LocalMatchIndex {
  readonly byId: ReadonlyMap<string, LocalNodeFact>;
  readonly children: ReadonlyMap<string, readonly string[]>;
}

export const matchIndexBuilds = {
  local: 0,
  remote: 0,
  mount: 0,
  reset(): void {
    this.local = 0;
    this.remote = 0;
    this.mount = 0;
  },
  note(kind: 'local' | 'remote' | 'mount'): void {
    this[kind] += 1;
  },
};

export function encodeFactKey(parts: readonly (string | null | undefined)[]): string {
  return JSON.stringify(parts.map((part) => part ?? ''));
}

export function buildLocalIndex(local: readonly LocalNodeFact[]): LocalMatchIndex {
  matchIndexBuilds.note('local');
  const byId = new Map<string, LocalNodeFact>();
  const children = new Map<string, string[]>();
  for (const row of local) {
    byId.set(row.nativeId, row);
    if (!row.parentNativeId) continue;
    const siblings = children.get(row.parentNativeId) ?? [];
    siblings.push(row.nativeId);
    children.set(row.parentNativeId, siblings);
  }
  return { byId, children };
}

export function buildRemoteIndex(
  remote: readonly RemoteNodeFact[],
  localCount: number,
): RemoteMatchIndex {
  matchIndexBuilds.note('remote');
  const byId = new Map<string, RemoteNodeFact>();
  const children = new Map<string, string[]>();
  const specialByRole = new Map<string, string>();
  for (const row of remote) {
    byId.set(row.nodeId, row);
    if (row.folderRole && SPECIAL_FOLDER_ROLES.has(row.folderRole) && !specialByRole.has(row.folderRole)) {
      specialByRole.set(row.folderRole, row.nodeId);
    }
    if (!row.parentId) continue;
    const siblings = children.get(row.parentId) ?? [];
    siblings.push(row.nodeId);
    children.set(row.parentId, siblings);
  }
  let mountChainVisits = 0;
  const mountOf = new Map<string, string>();
  const visiting = new Set<string>();
  const resolve = (nodeId: string): string => {
    const cached = mountOf.get(nodeId);
    if (cached) return cached;
    const row = byId.get(nodeId);
    if (!row) return nodeId;
    if (row.folderRole && (SPECIAL_FOLDER_ROLES.has(row.folderRole) || row.folderRole === 'custom')) {
      mountOf.set(nodeId, row.nodeId);
      return row.nodeId;
    }
    if (visiting.has(nodeId) || !row.parentId) {
      const fallback = row.parentId ?? row.nodeId;
      mountOf.set(nodeId, fallback);
      return fallback;
    }
    visiting.add(nodeId);
    mountChainVisits += 1;
    const resolved = resolve(row.parentId);
    visiting.delete(nodeId);
    mountOf.set(nodeId, resolved);
    return resolved;
  };
  for (const row of remote) resolve(row.nodeId);
  matchIndexBuilds.note('mount');
  return {
    byId, children, mountOf, specialByRole,
    stats: {
      localCount, remoteCount: remote.length, localIndexBuilds: matchIndexBuilds.local,
      remoteIndexBuilds: matchIndexBuilds.remote, mountIndexBuilds: matchIndexBuilds.mount,
      mountChainVisits,
    },
  };
}

export function mappingByNativeMap(mappings: readonly MappingFact[]): Map<string, string> {
  return new Map(mappings.map((row) => [row.nativeId, row.colpId]));
}

export function mountsByNativeRoot(mounts: readonly MountFact[]): ReadonlyMap<string, MountFact> {
  return new Map(mounts.map((mount) => [mount.nativeRootId, mount]));
}
