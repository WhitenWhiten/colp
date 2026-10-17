import { bookmarkRepresentability, digestJson, type BookmarkEventNode } from './bookmark-event-codec.js';
import { projectionSuppresses } from './recovery-overlay.js';
import { nativeIsLocallyExcluded } from './remote-delete-exclusion.js';
import type { EventIdentity } from './bookmark-event-heal.js';
import type { BookmarkEventApi } from './bookmark-event-queue.js';
import type { BookmarkEventRecord, JsonObject, MappingInput, SyncScope, createSyncStateStore } from './sync-state-store.js';

/** Preserve callbacks that arrive between the first scan and creation of their queue identity. */
export async function captureNativeMutation(input: {
  store: ReturnType<typeof createSyncStateStore>; scope: SyncScope; api: BookmarkEventApi;
  nativeId: string; kind: 'change' | 'move'; fields: JsonObject; uuid(): string; now(): string;
  allowed(parentNativeId: string, node: BookmarkEventNode): Promise<boolean>;
}) {
  if ((await input.store.getScope(input.scope))?.firstRun !== 'running') return null;
  const node = (await input.api.get(input.nativeId))[0];
  if (!node?.parentId || bookmarkRepresentability(node) !== 'supported' || !await input.allowed(node.parentId, node)) return null;
  const intents = await input.store.listProjectionIntents(input.scope);
  if (intents.some(intent => projectionSuppresses([intent], { kind: input.kind, nativeId: input.nativeId,
    suppression: intent.suppression, ...(input.kind === 'change' ? { changes: input.fields as Record<string, string> }
      : { parentNativeId: node.parentId, index: node.index ?? 0 }) }))) return { outcome: 'apply_intent_reserved' as const };
  const ancestors: string[] = []; let parent: string | undefined = node.parentId;
  while (parent && ancestors.length < 256 && !ancestors.includes(parent)) {
    ancestors.push(parent); parent = (await input.api.get(parent))[0]?.parentId;
  }
  if (await nativeIsLocallyExcluded(input.store, input.scope, input.nativeId, ancestors)) return null;
  const eventId = input.uuid();
  const details: JsonObject = { nativeMutation: true, ...input.fields, parentNativeId: node.parentId,
    ancestorNativeIds: ancestors, ...(input.kind === 'move' ? { context: {
      sourceParentNativeId: input.fields.oldParentId!, targetParentNativeId: node.parentId, index: node.index ?? 0 } } : {}) };
  const staged = await input.store.stageBookmarkEvent(input.scope, { eventId, kind: input.kind,
    nativeId: input.nativeId, occurredAt: input.now(), details,
    dedupeKey: digestJson({ kind: input.kind, nativeId: input.nativeId, details }) });
  return { outcome: staged.outcome, eventId: staged.event.eventId };
}

/** Bind the recorded native edit only after a real queue or mapping owns its identity. */
export function materializeNativeMutation(event: BookmarkEventRecord, identity: EventIdentity): JsonObject {
  const value: JsonObject = Object.fromEntries(['title', 'url'].flatMap(field =>
    typeof event.details[field] === 'string' ? [[field, event.details[field]!]] : []));
  const base = Object.fromEntries(Object.keys(value).map(field => [field, identity.content?.[field] ?? '']));
  const mapping: MappingInput = { nativeId: identity.nativeId, colpId: identity.colpId, rootNativeId: identity.rootNativeId,
    ...(identity.nodeKind ? { nodeKind: identity.nodeKind } : {}),
    ...(identity.parentNativeId ? { parentNativeId: identity.parentNativeId } : {}),
    ...(event.kind === 'move' ? { parentNativeId: String(event.details.parentNativeId) } : {}),
    projection: { revision: `local-${event.eventId}`, digest: digestJson(value),
      ...(identity.childrenRevision ? { childrenRevision: identity.childrenRevision } : {}),
      content: { ...(identity.content ?? {}), ...value } } };
  return { ...event.details, mapping: mapping as unknown as JsonObject,
    draft: { type: event.kind === 'move' ? 'move_node' : 'update_node_content', targetId: identity.colpId,
      baseRevision: identity.revision, payload: event.kind === 'move' ? {} : { base, value } } };
}
