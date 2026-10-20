import { digestJson } from './bookmark-event-codec.js';
import type { JsonObject, MappingInput, SyncScope, createSyncStateStore } from './sync-state-store.js';

type Store = Pick<ReturnType<typeof createSyncStateStore>, 'listQueueByTarget' | 'getQueueReceipt'
  | 'pullOperationsCovered' | 'listBookmarkEventsByNative'> & Partial<Pick<ReturnType<typeof createSyncStateStore>, 'filterResolvedQueueIssues'>>;

/** An optimistic projection is not evidence that a local edit reached the server. */
export async function hasUnsettledDeleteEdits(store: Store, scope: SyncScope, mapping: MappingInput,
  native: { readonly title?: string; readonly url?: string }): Promise<boolean> {
  const current = { ...mapping.projection.content,
    ...(native.title === undefined ? {} : { title: native.title }),
    ...(native.url === undefined ? {} : { url: native.url }) };
  const candidates = (await store.listQueueByTarget(scope, mapping.colpId)).filter(row => !row.echoApplied
    && (row.payload.type === 'update_node_content' || row.payload.type === 'move_node'));
  const rows = store.filterResolvedQueueIssues ? await store.filterResolvedQueueIssues(scope, candidates) : candidates;
  const covered = new Set(await store.pullOperationsCovered(scope, rows.map(row => row.opId)));
  for (const row of rows) {
    if (covered.has(row.opId)) continue;
    if (row.status === 'terminal') {
      const receipt = await store.getQueueReceipt(scope, row.sequence);
      const results = receipt?.result?.results;
      if (Array.isArray(results) && results.some(value => object(value)?.opId === row.opId
          && ['applied', 'rebased', 'noop'].includes(String(object(value)?.status)))) continue;
    }
    if (row.payload.type === 'move_node' || retainsAuthoredValue(row.payload.payload, current)) return true;
  }
  let after = 0;
  for (;;) {
    const events = await store.listBookmarkEventsByNative(scope, mapping.nativeId, after, 1_000);
    for (const event of events) {
      if (event.status !== 'pending') continue;
      const draft = object(event.details.draft);
      if (event.kind === 'move' || (draft?.type === 'update_node_content'
          && retainsAuthoredValue(draft.payload, current))) return true;
    }
    if (events.length < 1_000) return false;
    after = events.at(-1)!.ordinal;
  }
}

function retainsAuthoredValue(payload: unknown, current: JsonObject): boolean {
  const row = object(payload), base = object(row?.base), value = object(row?.value);
  return Object.entries(value ?? {}).some(([key, authored]) =>
    digestJson(authored) !== digestJson(base?.[key] ?? null)
      && digestJson(authored) === digestJson(current[key] ?? null));
}

function object(value: unknown): JsonObject | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : undefined;
}
