import { lookupBookmark } from './bookmark-api-error.js';
import type { BookmarkEventApi } from './bookmark-event-queue.js';
import type { EventIdentity } from './bookmark-event-heal.js';
import type { BookmarkEventRecord, JsonObject } from './sync-state-store.js';

/** A completed remote move cannot reserve a later deliberate return to its position. */
export async function allowCompletedMoveEcho(input: {
  readonly nativeId: string; readonly details: JsonObject; readonly api: BookmarkEventApi;
  readonly identityFor: (nativeId: string) => Promise<EventIdentity | null>;
  readonly listPendingEvents: () => Promise<readonly BookmarkEventRecord[]>;
}): Promise<boolean> {
  const looked = await lookupBookmark(id => input.api.get(id), input.nativeId);
  if (looked.class !== 'present') return true;
  const live = looked.nodes[0]!;
  // Old callbacks can arrive after the native has moved on. They still belong
  // to the completed intent and must not overwrite the current local intent.
  if (live.parentId !== input.details.parentId || live.index !== input.details.index) return true;
  const identity = await input.identityFor(input.nativeId);
  if (identity?.parentNativeId && identity.parentNativeId !== live.parentId) return false;
  if (identity?.revision.startsWith('local-')) return false;
  if ((await input.listPendingEvents()).some(row => row.nativeId === input.nativeId && row.kind === 'move')) return false;
  const parent = live.parentId ? await input.identityFor(live.parentId) : null;
  const previousIndex = parent?.childrenOrder?.indexOf(input.nativeId);
  return previousIndex === undefined || previousIndex < 0 || previousIndex === live.index;
}
