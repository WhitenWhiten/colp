import { isDescendantIn, nativeParentIndex } from './bookmark-event-codec.js';
import type { BookmarkEventRecord, MappingInput, SyncScope, createSyncStateStore } from './sync-state-store.js';

export interface EligibleSyncNativeIdsInput {
  readonly store: ReturnType<typeof createSyncStateStore>;
  readonly scope: SyncScope;
  readonly mappings: readonly MappingInput[];
  readonly listPendingEvents: () => Promise<readonly BookmarkEventRecord[]>;
  readonly select: (mapping: MappingInput, all: readonly MappingInput[]) => boolean;
}

/**
 * Native ids that may be authored into an operation: durably mapped (or staged
 * by a still-pending inbox event) and not under a private local root. Extracted
 * verbatim from the two identical scans in `bookmark-event-queue.ts` so the
 * reorder uplink can grow without pushing that file past its size budget.
 */
export async function eligibleSyncNativeIds(input: EligibleSyncNativeIdsInput): Promise<string[]> {
  const scope = await input.store.getScope(input.scope);
  const mappings = input.mappings;
  const events = await input.listPendingEvents();
  const pending = events.flatMap((event) => event.details.mapping === undefined ? []
    : [event.details.mapping as unknown as MappingInput]);
  const all = [...mappings, ...pending];
  const privateMappings = await Promise.all((scope?.privateRoots ?? []).map(id => input.store.getMappingByColpId(input.scope, id)));
  const byColp = new Map(privateMappings.flatMap(mapping => mapping ? [[mapping.colpId, mapping] as const] : []));
  const privateNative = new Set((scope?.privateRoots ?? []).map((id) => byColp.get(id)?.nativeId).filter(Boolean));
  return [...new Set(all.filter((mapping) => input.select(mapping, all)
    && !privateNative.has(mapping.nativeId) && !privateNative.has(mapping.rootNativeId)).map((mapping) => mapping.nativeId))];
}

/** One parent index per selector. A later `all` is not reindexed. */
export function subtreeSelector(nativeId: string) {
  let parents: ReadonlyMap<string, string | undefined> | undefined;
  return (mapping: MappingInput, all: readonly MappingInput[]) => {
    parents ??= nativeParentIndex(all);
    return mapping.nativeId === nativeId || isDescendantIn(mapping, nativeId, parents);
  };
}
