import { resolveCommittedTokens, asObject } from './bookmark-event-codec.js';
import type { JsonObject, SyncScope, createSyncStateStore } from './sync-state-store.js';

/** Resolve identity references only. User titles/URLs/extensions are immutable data. */
export async function resolveEventIdentityTokens(store: Pick<ReturnType<typeof createSyncStateStore>, 'getBookmarkEvent'>,
  scope: SyncScope, details: JsonObject, resolved: Map<string, string>): Promise<JsonObject> {
  const draft = asObject(details.draft!, 'draft');
  const mapping = details.mapping === undefined ? undefined : asObject(details.mapping, 'mapping');
  const projection = mapping ? asObject(mapping.projection!, 'projection') : undefined;
  const tokens = [draft.targetId, draft.baseRevision, mapping?.colpId, projection?.revision, projection?.resourceRevision];
  for (const token of tokens) {
    if (typeof token !== 'string' || resolved.has(token)) continue;
    const eventId = token.startsWith('pending-') ? token.slice(8) : token.startsWith('local-') ? token.slice(6) : token;
    const event = await store.getBookmarkEvent(scope, eventId);
    if (event?.opId) resolved.set(event.eventId, event.opId);
  }
  const resolveFields = (record: JsonObject, keys: readonly string[]): JsonObject => ({ ...record,
    ...Object.fromEntries(keys.filter(key => record[key] !== undefined)
      .map(key => [key, resolveCommittedTokens(record[key]!, resolved)])) });
  return { ...details, draft: resolveFields(draft, ['targetId', 'baseRevision']),
    ...(mapping ? { mapping: { ...resolveFields(mapping, ['colpId']),
      projection: resolveFields(projection!, ['revision', 'resourceRevision']) } } : {}) };
}
