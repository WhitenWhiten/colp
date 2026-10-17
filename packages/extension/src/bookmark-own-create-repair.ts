import { lookupBookmark } from './bookmark-api-error.js';
import type { createBookmarkEventQueue } from './bookmark-event-queue.js';
import type { PullBookmarkApi } from './pull-applier-types.js';
import type { MappingInput } from './sync-state-store.js';

/** Reconstruct a lost callback for a proven self-create before replaying its echo. */
export async function repairOwnCreateFromNative(queue: Pick<ReturnType<typeof createBookmarkEventQueue>,
  'removed' | 'moved' | 'changed'>, get: PullBookmarkApi['get'], mapping: MappingInput, parent: MappingInput): Promise<void> {
  const looked = await lookupBookmark(get, mapping.nativeId);
  const parentId = mapping.parentNativeId ?? parent.nativeId;
  if (looked.class === 'not_found') {
    const content = mapping.projection.content ?? {};
    await queue.removed(mapping.nativeId, { parentId, index: 0,
      node: { id: mapping.nativeId, title: String(content.title ?? ''),
        ...(typeof content.url === 'string' ? { url: content.url } : {}), type: mapping.nodeKind ?? 'bookmark' } });
  } else if (looked.class === 'present') {
    const native = looked.nodes[0]!;
    if (native.parentId && native.parentId !== parentId) await queue.moved(mapping.nativeId, {
      parentId: native.parentId, index: native.index ?? 0, oldParentId: parentId, oldIndex: 0 });
    await queue.changed(mapping.nativeId, { ...(native.title === undefined ? {} : { title: native.title }),
      ...(native.url === undefined ? {} : { url: native.url }) });
  } else throw new Error(looked.message);
}
