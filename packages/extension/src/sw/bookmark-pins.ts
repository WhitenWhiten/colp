import { createBookmarkAnnotationStore } from '../bookmark-annotation-store.js';
import type { PinRequest, PinResponse } from '../bookmark-pin-messages.js';
import { sortPinnedBookmarks } from '../bookmark-pin-order.js';
import { withSubscriptionRead } from '../bookmark-subscriptions/barrier.js';
import { exclusionIds } from '../bookmark-subscriptions/guards.js';
import { bookmarkListenerLifecycle } from './bookmarks.js';
import { scheduleNativeFoldersFirst } from './bookmark-folders-first.js';
import { folderPinBlockers, loadPinIndex, pinnedChildIds, sortFolderPins } from './bookmark-pin-pass.js';
import { readEffectiveBookmarkPreferences } from './bookmark-preferences.js';
import { currentSyncScope } from './scope.js';
import { hasBookmarkPermission, syncState, workCoordinator } from './runtime.js';

/** Moves wait while sync owns the native order; the folders-first pass places the bookmark afterwards. */
async function orderAvailable(): Promise<boolean> {
  if (workCoordinator.hasInFlight('engine')) return false;
  const scope = await currentSyncScope().catch(() => undefined);
  try { return !(scope && (await syncState.getEngineState(scope))?.recoveryFrozen); }
  catch { return false; } // The pin is already durable; defer placement when sync state is unavailable.
}

/**
 * Pin: only where pinning is available; the bookmark joins the end of the
 * pinned section. Unpin: always allowed; the bookmark follows "New bookmarks
 * go" (top of the unpinned section, or the bottom of the folder).
 */
export async function handlePinRequest(request: PinRequest): Promise<PinResponse> {
  try {
    if (!await hasBookmarkPermission()) return { ok: false, error: 'permission_required' };
    if (request.kind === 'known.bookmarks.pin.status') {
      const preferences = await readEffectiveBookmarkPreferences();
      return await withSubscriptionRead(async () => {
        const excluded = await exclusionIds(true);
        const folders: Record<string, Awaited<ReturnType<typeof folderPinBlockers>>> = {};
        for (const id of request.folderIds) folders[id] = await folderPinBlockers(id, preferences, excluded);
        return { ok: true, folders };
      });
    }
    await bookmarkListenerLifecycle.settled();
    return await workCoordinator.run('local-bookmark', () => withSubscriptionRead(async () => {
      const [node] = await chrome.bookmarks.get(request.nativeId).catch(() => []);
      return pinNode(node, request.pinned);
    }));
  } catch {
    return { ok: false, error: 'pin_failed' };
  }
}

/** The flag first, then the placement. Callers hold the local-bookmark lane (or run inside a save that does). */
export async function pinNode(node: chrome.bookmarks.BookmarkTreeNode | undefined, pinned: boolean): Promise<PinResponse> {
  if (!node || node.url === undefined || !node.parentId) return { ok: false, error: 'not_found' };
  const parentId = node.parentId;
  const preferences = await readEffectiveBookmarkPreferences();
  const excluded = await exclusionIds(true);
  const blockers = node.unmodifiable || excluded.has(node.id)
    ? ['folder_read_only' as const] : await folderPinBlockers(parentId, preferences, excluded);
  if (pinned && blockers.length) return { ok: false, error: 'not_available', blockers };
  const store = createBookmarkAnnotationStore();
  try { await store.setPinned(node, pinned); } finally { store.close(); }
  // Unpinned with "New bookmarks go: bottom": the bookmark moves to the folder's end, unless it cannot move.
  const toBottom = !pinned && preferences.bookmarkInsertPosition === 'bottom' && !blockers.includes('folder_read_only');
  if (!await orderAvailable()) {
    scheduleNativeFoldersFirst(parentId);
    if (toBottom) await deferBottomPlacement(node.id);
    return { ok: true, blockers };
  }
  const enabled = async () => orderAvailable();
  if (pinned) {
    await sortFolderPins(parentId, await loadPinIndex(), preferences, excluded, enabled, { last: node.id });
  } else if (toBottom) {
    await moveToBottom(node.id, parentId);
  } else if (!blockers.length) {
    const pins = await loadPinIndex();
    await sortPinnedBookmarks(chrome.bookmarks, parentId, pinnedChildIds(await chrome.bookmarks.getChildren(parentId), pins), enabled);
  }
  return { ok: true, blockers };
}

async function moveToBottom(nativeId: string, parentId: string): Promise<void> {
  const children = await chrome.bookmarks.getChildren(parentId);
  if (children.at(-1)?.id !== nativeId) await chrome.bookmarks.move(nativeId, { parentId });
}

export const PIN_PLACEMENT_ALARM = 'known-bookmark-pin-placement';
const DEFERRED_UNPINS = 'known.bookmarkPins.deferredBottom';
const RETRY_MS = 30_000;

async function deferredUnpins(): Promise<string[]> {
  const value: unknown = (await chrome.storage.session.get(DEFERRED_UNPINS))[DEFERRED_UNPINS];
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [];
}

/**
 * An unpin's move to the bottom is a one-time step the folders-first pass cannot
 * derive from the pins, so while sync owns the native order it waits here, in session
 * storage that outlives the worker, until the alarm finds the order free.
 */
async function deferBottomPlacement(nativeId: string): Promise<void> {
  const ids = await deferredUnpins();
  await chrome.storage.session.set({ [DEFERRED_UNPINS]: [...ids.filter(id => id !== nativeId), nativeId].slice(-64) });
  chrome.alarms.create(PIN_PLACEMENT_ALARM, { when: Date.now() + RETRY_MS });
}

/** Alarm: moves deferred unpins to the bottom of their folders once sync releases the order. */
export async function placeDeferredUnpins(): Promise<void> {
  if (!(await deferredUnpins()).length || !await hasBookmarkPermission()) return;
  await bookmarkListenerLifecycle.settled();
  await workCoordinator.run('local-bookmark', () => withSubscriptionRead(async () => {
    const ids = await deferredUnpins();
    if (!ids.length) return;
    if (!await orderAvailable()) { chrome.alarms.create(PIN_PLACEMENT_ALARM, { when: Date.now() + RETRY_MS }); return; }
    // A changed preference wins: "top" placement belongs to the folders-first pass.
    if ((await readEffectiveBookmarkPreferences()).bookmarkInsertPosition === 'bottom') {
      const excluded = await exclusionIds(true), pins = await loadPinIndex();
      for (const id of ids) {
        const [node] = await chrome.bookmarks.get(id).catch(() => []);
        // Removed, pinned again, or no longer movable since: nothing to place.
        if (!node?.parentId || node.url === undefined || node.unmodifiable || excluded.has(id)
          || pinnedChildIds([node], pins).size) continue;
        await moveToBottom(id, node.parentId);
      }
    }
    await chrome.storage.session.remove(DEFERRED_UNPINS);
  }));
}
