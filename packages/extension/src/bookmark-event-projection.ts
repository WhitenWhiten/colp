import { asObject, asStringArray, digestJson } from './bookmark-event-codec.js';
import { materializeNativeMutation } from './bookmark-native-mutation.js';
import type { EventIdentity } from './bookmark-event-heal.js';
import type { BookmarkEventRecord, JsonObject, JsonValue, MappingInput } from './sync-state-store.js';

/** Project authored namespace changes without rewriting the original base/value wire intent. */
export function projectBookmarkContentUpdate(current: JsonObject | null, base: JsonObject, value: JsonObject): JsonObject {
  const content = { ...current, ...value };
  if (!Object.hasOwn(value, 'extensions')) return content;
  // Extension maps use per-namespace three-way merge on the server. Unchanged
  // namespaces belong to Current even when the authored whole map is older.
  // Local edits win the optimistic view; the server still arbitrates conflicts.
  const before = extensionMap(base.extensions), after = extensionMap(value.extensions);
  const extensions = { ...extensionMap(current?.extensions) };
  for (const namespace of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const had = Object.hasOwn(before, namespace), has = Object.hasOwn(after, namespace);
    if (had === has && (!had || digestJson(before[namespace]!) === digestJson(after[namespace]!))) continue;
    if (has) extensions[namespace] = after[namespace]!;
    else delete extensions[namespace];
  }
  return { ...content, extensions };
}

function extensionMap(value: JsonValue | undefined): JsonObject {
  return value === null || value === undefined ? {} : asObject(value, 'extensions');
}

/** Capture and preparation must see the same ordered local post-state. */
export function projectPendingBookmarkEvent(identity: EventIdentity | null,
  event: BookmarkEventRecord): EventIdentity | null {
  const details = event.details.nativeMutation === true && identity
    ? materializeNativeMutation(event, identity) : event.details;
  if (details.deleteNativeIds !== undefined
      && asStringArray(details.deleteNativeIds, 'deleteNativeIds').includes(event.nativeId)) return null;
  if (details.mapping === undefined) return identity;
  const mapping = details.mapping as unknown as MappingInput;
  let content = mapping.projection.content ?? null;
  if (event.kind === 'move') content = identity?.content ?? content;
  if (event.kind === 'change') {
    const payload = asObject(asObject(details.draft, 'draft').payload, 'payload');
    content = projectBookmarkContentUpdate(identity?.content ?? content,
      asObject(payload.base, 'base'), asObject(payload.value, 'value'));
  }
  return { nativeId: mapping.nativeId, colpId: mapping.colpId, rootNativeId: mapping.rootNativeId,
    revision: mapping.projection.revision, content,
    ...(mapping.projection.childrenRevision ? { childrenRevision: mapping.projection.childrenRevision } : {}),
    ...(mapping.projection.childrenOrder ? { childrenOrder: mapping.projection.childrenOrder } : {}),
    ...(mapping.nodeKind ? { nodeKind: mapping.nodeKind } : {}),
    ...(mapping.parentNativeId ? { parentNativeId: mapping.parentNativeId } : {}) };
}
