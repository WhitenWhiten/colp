import type { MappingInput, SyncScope, createSyncStateStore } from './sync-state-store.js';

type Store = Pick<ReturnType<typeof createSyncStateStore>, 'listPullEvents' | 'getMappingByColpId'>;

/** Page-local shadow, including deletes not yet published. Not Ack/cursor authority. */
export async function currentPullMapping(store: Store, scope: SyncScope, colpId: string): Promise<MappingInput | null> {
  const events = await store.listPullEvents(scope, ['authority_committed']);
  const deleted = new Set<string>();
  for (const event of events.toReversed()) {
    const mapping = ((event.pendingMappings as MappingInput[] | undefined) ?? [])
      .find((candidate) => candidate.colpId === colpId);
    if (mapping && !deleted.has(mapping.nativeId)) return mapping;
    for (const nativeId of (event.pendingDeleteNativeIds as string[] | undefined) ?? []) deleted.add(nativeId);
    const exit = event.pendingRangeExit as { readonly unbindNativeIds?: string[] } | undefined;
    for (const nativeId of exit?.unbindNativeIds ?? []) deleted.add(nativeId);
  }
  const durable = await store.getMappingByColpId(scope, colpId);
  return durable && !deleted.has(durable.nativeId) ? durable : null;
}
