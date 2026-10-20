import type { MappingInput } from './sync-state-store.js';

/** Traverse each remote edge once; deep folders must not repeatedly walk all ancestors. */
export function remoteDescendantIds(all: readonly MappingInput[], rootId: string | null): ReadonlySet<string> {
  const found = new Set<string>();
  if (!rootId) return found;
  const children = new Map<string, string[]>();
  for (const row of all) {
    const parent = row.parentColpId;
    if (!parent) continue;
    const siblings = children.get(parent) ?? [];
    siblings.push(row.colpId); children.set(parent, siblings);
  }
  const pending = [rootId]; found.add(rootId);
  for (let index = 0; index < pending.length; index++) {
    for (const id of children.get(pending[index]!) ?? []) {
      if (found.has(id)) continue;
      found.add(id); pending.push(id);
    }
  }
  return found;
}

/** Topological levels retain deterministic sibling handling without rescanning remaining rows. */
export function parentFirst(rows: readonly MappingInput[], remoteMountNodeId: string | null): MappingInput[] {
  const byId = new Map(rows.map(row => [row.colpId, row]));
  const children = new Map<string, MappingInput[]>();
  let level: MappingInput[] = [];
  for (const row of rows) {
    const parent = row.parentColpId;
    if (!parent || parent === remoteMountNodeId || !byId.has(parent)) level.push(row);
    else {
      const siblings = children.get(parent) ?? [];
      siblings.push(row); children.set(parent, siblings);
    }
  }
  const ordered: MappingInput[] = [];
  const visited = new Set<string>();
  while (level.length) {
    level.sort((left, right) => Number(left.nodeKind !== 'folder') - Number(right.nodeKind !== 'folder')
      || left.colpId.localeCompare(right.colpId));
    const next: MappingInput[] = [];
    for (const row of level) {
      if (visited.has(row.colpId)) continue;
      visited.add(row.colpId); ordered.push(row);
      next.push(...children.get(row.colpId) ?? []);
    }
    level = next;
  }
  // Invalid cycles remain observable as unresolved parents; they never justify a native create.
  for (const row of rows) if (!visited.has(row.colpId)) ordered.push(row);
  return ordered;
}
