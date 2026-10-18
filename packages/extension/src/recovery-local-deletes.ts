import type { MappingInput, SyncScope, createSyncStateStore } from './sync-state-store.js';

type Store = Pick<ReturnType<typeof createSyncStateStore>, 'listQueue' | 'listBookmarkEventsByStatus'>;
const STATUSES = ['pending', 'claimed', 'deferred', 'gap', 'blocked', 'unknown', 'rejected', 'set_aside'] as const;

/** A local removal remains authoritative while it is an inbox draft, queued,
 * or rejected for user review. A Snapshot is not permission to undo that edit. */
export async function pendingLocalDeletionIds(store: Store, scope: SyncScope, graph: readonly MappingInput[]): Promise<ReadonlySet<string>> {
  const deleted = new Set<string>(), subtrees = new Set<string>();
  const add = (value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    const operation = value as Record<string, unknown>;
    if ((operation.type !== 'delete_node' && operation.type !== 'delete_subtree') || typeof operation.targetId !== 'string') return;
    deleted.add(operation.targetId);
    if (operation.type === 'delete_subtree') subtrees.add(operation.targetId);
  };
  await Promise.all(STATUSES.map(async status => {
    let after = 0;
    for (;;) {
      const rows = await store.listQueue(scope, status, after, 1000);
      for (const row of rows) add(row.payload);
      if (rows.length < 1000) break;
      after = rows[rows.length - 1]!.sequence;
    }
  }));
  let after = 0;
  for (;;) {
    const rows = await store.listBookmarkEventsByStatus(scope, 'pending', after, 1000);
    for (const row of rows) if (row.kind === 'remove') add(row.details.draft);
    if (rows.length < 1000) break;
    after = rows[rows.length - 1]!.ordinal;
  }
  const byNative = new Map(graph.map(row => [row.nativeId, row.colpId]));
  const children = new Map<string, Set<string>>();
  for (const row of graph) {
    const parent = row.parentColpId ?? (row.parentNativeId ? byNative.get(row.parentNativeId) : undefined);
    if (!parent) continue;
    const ids = children.get(parent) ?? new Set<string>();
    ids.add(row.colpId); children.set(parent, ids);
  }
  const pending = [...subtrees], seen = new Set<string>();
  for (let index = 0; index < pending.length; index++) {
    const parent = pending[index]!;
    if (seen.has(parent)) continue;
    seen.add(parent);
    for (const child of children.get(parent) ?? []) { deleted.add(child); pending.push(child); }
  }
  return deleted;
}

/** Keep native identities needed to commit removal drafts. Snapshot-only
 * descendants remain sidecars until the subtree deletion/conflict settles. */
export function retainedDeletionMappings(live: readonly MappingInput[], incoming: readonly MappingInput[],
  deleted: ReadonlySet<string>): readonly MappingInput[] {
  const retained = new Map(incoming.filter(row => deleted.has(row.colpId))
    .map(row => [row.colpId, { ...unscoped(row), nativeId: `sidecar:local-delete:${row.colpId}` }]));
  for (const row of live) if (deleted.has(row.colpId) && retained.has(row.colpId)) retained.set(row.colpId, unscoped(row));
  return [...retained.values()];
}

function unscoped(row: MappingInput): MappingInput {
  const { scopeKey: _key, ...mapping } = row as MappingInput & { scopeKey?: string };
  return mapping;
}
