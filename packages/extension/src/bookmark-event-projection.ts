import { asObject, asStringArray } from './bookmark-event-codec.js';
import { materializeNativeMutation } from './bookmark-native-mutation.js';
import type { EventIdentity } from './bookmark-event-heal.js';
import type { BookmarkEventRecord, MappingInput } from './sync-state-store.js';

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
    content = { ...(identity?.content ?? content), ...asObject(payload.value, 'value') };
  }
  return { nativeId: mapping.nativeId, colpId: mapping.colpId, rootNativeId: mapping.rootNativeId,
    revision: mapping.projection.revision, content,
    ...(mapping.projection.childrenRevision ? { childrenRevision: mapping.projection.childrenRevision } : {}),
    ...(mapping.projection.childrenOrder ? { childrenOrder: mapping.projection.childrenOrder } : {}),
    ...(mapping.nodeKind ? { nodeKind: mapping.nodeKind } : {}),
    ...(mapping.parentNativeId ? { parentNativeId: mapping.parentNativeId } : {}) };
}
