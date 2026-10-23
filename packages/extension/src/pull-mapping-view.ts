import type { MappingInput, SyncScope, createSyncStateStore } from './sync-state-store.js';

type Store = Pick<ReturnType<typeof createSyncStateStore>, 'listPullEvents' | 'getMappingByColpId'>
  & Partial<Pick<ReturnType<typeof createSyncStateStore>, 'getCurrentPullMapping'>>;

/** Page-local shadow, including deletes not yet published. Not Ack/cursor authority. */
export async function currentPullMapping(store: Store, scope: SyncScope, colpId: string): Promise<MappingInput | null> {
  if (store.getCurrentPullMapping) return store.getCurrentPullMapping(scope, colpId);
  const events = await store.listPullEvents(scope, ['authority_committed']);
  const shadow = pendingPullMapping(events, colpId);
  if (shadow.mapping) return shadow.mapping;
  const durable = await store.getMappingByColpId(scope, colpId);
  return durable && !shadow.deleted.has(durable.nativeId) ? durable : null;
}

export function pendingPullMapping(events: readonly Record<string, unknown>[], colpId: string) {
  const deleted = new Set<string>();
  for (const event of events.toReversed()) {
    const mapping = ((event.pendingMappings as MappingInput[] | undefined) ?? [])
      .find((candidate) => candidate.colpId === colpId);
    if (mapping && !deleted.has(mapping.nativeId)) return { mapping, deleted };
    for (const nativeId of (event.pendingDeleteNativeIds as string[] | undefined) ?? []) deleted.add(nativeId);
    const exit = event.pendingRangeExit as { readonly unbindNativeIds?: string[] } | undefined;
    for (const nativeId of exit?.unbindNativeIds ?? []) deleted.add(nativeId);
  }
  return { mapping: null, deleted };
}
