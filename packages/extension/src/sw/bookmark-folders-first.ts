import { BOOKMARK_PREFERENCES_CACHE } from '../bookmark-preferences.js';
import { nativeBookmarkFolders, sortNativeBookmarkFolder } from '../bookmark-folders-first.js';
import { isUnsupportedBookmarkFolder } from '../bookmark-folder-policy.js';
import { exclusionIds, isSubscriptionExcluded } from '../bookmark-subscriptions/guards.js';
import { withSubscriptionRead } from '../bookmark-subscriptions/barrier.js';
import { bookmarkListenerLifecycle } from './bookmarks.js';
import { readEffectiveBookmarkPreferences } from './bookmark-preferences.js';
import { hasBookmarkPermission, syncState, workCoordinator } from './runtime.js';
import { currentSyncScope } from './scope.js';
import { loadPinIndex, sortFolderPins } from './bookmark-pin-pass.js';

export const FOLDERS_FIRST_ALARM = 'known-bookmark-folders-first';
let wholeTree = false;
const parents = new Set<string>();
let scheduled: ReturnType<typeof setTimeout> | undefined;
let running = false;
let waitingForRetry = false;
let manualOrganizing = 0;

export function scheduleNativeFoldersFirst(parentId?: string): void {
  if (parentId) parents.add(parentId);
  else wholeTree = true;
  if (!running && scheduled === undefined) scheduled = setTimeout(() => {
    scheduled = undefined;
    void flush();
  }, 100);
}

function retry(): void {
  wholeTree = true;
  waitingForRetry = true;
  chrome.alarms.create(FOLDERS_FIRST_ALARM, { when: Date.now() + 30_000 });
}

async function enabled(): Promise<boolean> {
  return await hasBookmarkPermission() && (await readEffectiveBookmarkPreferences()).foldersFirst;
}

async function flush(): Promise<void> {
  if (running) return;
  running = true;
  waitingForRetry = false;
  try {
    // Consume creation placement receipts before changing their native index.
    await bookmarkListenerLifecycle.settled();
    await workCoordinator.run('local-bookmark', async () => {
      if (manualOrganizing) return;
      if (!await enabled()) { wholeTree = false; parents.clear(); return; }
      // Pull/bootstrap owns its native order until its projection has completed.
      // Scope absence is normal when signed out; state read failures must retry.
      const scope = await currentSyncScope().catch(() => undefined);
      const frozen = scope && (await syncState.getEngineState(scope))?.recoveryFrozen === true;
      if (workCoordinator.hasInFlight('engine') || frozen) { retry(); return; }
      await withSubscriptionRead(async () => {
        const excluded = await exclusionIds(true);
        const ids = wholeTree
          ? nativeBookmarkFolders(await chrome.bookmarks.getTree(), excluded)
          : [...parents];
        wholeTree = false;
        parents.clear();
        // Pinned bookmarks follow the folders only while new bookmarks go to the top.
        const preferences = await readEffectiveBookmarkPreferences();
        const pins = preferences.bookmarkInsertPosition === 'top' ? await loadPinIndex() : undefined;
        const guard = async () => {
          if (manualOrganizing) return false;
          if (workCoordinator.hasInFlight('engine')) { retry(); return false; }
          return enabled();
        };
        for (const id of ids) {
          if (manualOrganizing || waitingForRetry || !await enabled()) break;
          if (await isUnsupportedBookmarkFolder(id)) continue;
          if (await isSubscriptionExcluded(id, undefined, true)) continue;
          const grouped = await sortNativeBookmarkFolder(chrome.bookmarks, id, guard, async nativeId => excluded.has(nativeId));
          if (grouped && pins?.size) await sortFolderPins(id, pins, preferences, excluded, guard);
        }
      });
    });
  } catch {
    retry();
  } finally {
    running = false;
    if (!manualOrganizing && !waitingForRetry && (wholeTree || parents.size)) scheduleNativeFoldersFirst(wholeTree ? undefined : [...parents][0]);
  }
}

const onCreated = (_id: string, node: chrome.bookmarks.BookmarkTreeNode) => {
  if (node.parentId) scheduleNativeFoldersFirst(node.parentId);
  if (node.children?.length) scheduleNativeFoldersFirst();
};
const onMoved = (_id: string, move: { parentId: string; oldParentId: string }) => {
  // A manual operation owns its chosen scope; its moves must not trigger a wider automatic pass.
  if (manualOrganizing) return;
  scheduleNativeFoldersFirst(move.parentId);
  scheduleNativeFoldersFirst(move.oldParentId);
};
const onChildrenReordered = (id: string) => scheduleNativeFoldersFirst(id);

export async function withManualBookmarkOrganization<T>(work: () => Promise<T>): Promise<T> {
  manualOrganizing += 1;
  try { return await work(); }
  finally {
    manualOrganizing -= 1;
    if (!manualOrganizing && (wholeTree || parents.size)) scheduleNativeFoldersFirst(wholeTree ? undefined : [...parents][0]);
  }
}

/** Register on every MV3 boot; optional permission grants repair these listeners. */
export function installNativeFoldersFirst(): void {
  if (typeof chrome.bookmarks === 'undefined') return;
  chrome.bookmarks.onCreated.addListener(onCreated);
  chrome.bookmarks.onMoved.addListener(onMoved);
  chrome.bookmarks.onChildrenReordered?.addListener(onChildrenReordered);
}

export function installNativeFoldersFirstStorageListener(): void {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[BOOKMARK_PREFERENCES_CACHE]) scheduleNativeFoldersFirst();
  });
}
