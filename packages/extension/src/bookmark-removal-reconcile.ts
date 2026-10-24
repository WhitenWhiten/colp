import { lookupBookmark } from './bookmark-api-error.js';
import { createNodeIsolation } from './capture-node-isolation.js';
import { resolveIngressBoundary } from './bookmark-event-ingress.js';
import { virtualNativeId } from './projection-native-occupancy.js';
import type { BookmarkEventApi, BookmarkEventNode } from './bookmark-event-queue.js';
import type { SyncScope, createSyncStateStore } from './sync-state-store.js';

/** Repair missed removal callbacks before Snapshot projection, including after
 * a restart with recoveryFrozen. Do not reconcile content or placement here. */
export async function captureMissingNativeRemovals(input: {
  readonly store: ReturnType<typeof createSyncStateStore>;
  readonly scope: SyncScope;
  readonly api: BookmarkEventApi;
  removed(nativeId: string, removal: { parentId: string; index: number; node: BookmarkEventNode }): Promise<unknown>;
}): Promise<void> {
  const boundary = await resolveIngressBoundary(input.store, input.scope);
  if (boundary.rootStatus !== 'ready' && boundary.rootStatus !== 'nested_normalized') return;
  const seen = new Set<string>(boundary.selectedNative), visited = new Set<string>();
  const pending = [...boundary.selectedNative];
  while (pending.length) {
    const parent = pending.pop()!;
    if (visited.has(parent)) throw new Error('bookmark_tree_cycle');
    visited.add(parent);
    for (const node of await input.api.getChildren(parent)) {
      if (boundary.privateNative.has(node.id)) continue;
      seen.add(node.id);
      if (node.url === undefined) pending.push(node.id);
    }
  }
  const mappings = await input.store.listMappings(input.scope);
  const absent = mappings.filter(row => boundary.selectedNative.has(row.rootNativeId)
    && !seen.has(row.nativeId) && !virtualNativeId(row.nativeId) && !boundary.privateNative.has(row.nativeId));
  const absentIds = new Set(absent.map(row => row.nativeId));
  const captured = new Set<string>();
  let after = 0;
  while (absent.length) {
    const events = await input.store.listBookmarkEventsByStatus(input.scope, 'pending', after, 1000);
    for (const event of events) if (event.kind === 'remove') captured.add(event.nativeId);
    if (events.length < 1000) break;
    after = events[events.length - 1]!.ordinal;
  }
  // One bookmark that throws must not stop the scan for the others (A-F11).
  const isolation = createNodeIsolation({ store: input.store, scope: input.scope });
  for (const row of absent) {
    await isolation.run(row.nativeId, async () => {
      if (row.parentNativeId && absentIds.has(row.parentNativeId)) return;
      // A durable callback is already stronger evidence than this repair scan.
      // In particular, do not reclassify it against a changing recovery binding.
      if (captured.has(row.nativeId)) return;
      const lookup = await lookupBookmark(id => input.api.get(id), row.nativeId);
      if (lookup.class === 'present') return; // A concurrent move is not a delete.
      if (lookup.class !== 'not_found') throw new Error(lookup.message);
      const content = row.projection.content ?? {};
      const parentId = row.parentNativeId ?? row.rootNativeId;
      await input.removed(row.nativeId, { parentId, index: 0, node: { id: row.nativeId, parentId,
        title: typeof content.title === 'string' ? content.title : '',
        ...(typeof content.url === 'string' ? { url: content.url } : {}),
        type: row.nodeKind === 'bookmark' ? 'bookmark' : 'folder' } });
    });
  }
  await isolation.finish();
}
