import { assertPersonalNativeAllowed } from '../bookmark-subscriptions/guards.js';
import type { CaptureScope } from '../capture/contracts.js';
import { assertCaptureScope } from './capture-native.js';
import { parseFolderBinding, FOLDER_DEFAULT_BINDING, folderIsInMount, walkAncestorIds } from '../save-folder.js';
import { resolveDefaultBookmarkParent } from '../bookmark-placement.js';
import { parseSaveContextCache, SAVE_CONTEXT_CACHE } from '../save-context-cache.js';
import { currentSyncScope } from './scope.js';
import { resolveIngressBoundary } from '../bookmark-event-ingress.js';
import { syncState } from './runtime.js';
import { COLLECTIONS_CACHE, parseCollectionsCache } from '../collections-cache.js';
import { isUnsupportedBookmarkFolder } from '../bookmark-folder-policy.js';
export async function captureTarget(scope: CaptureScope, requestedId?: string) {
  const remembered = parseFolderBinding((await chrome.storage.local.get(FOLDER_DEFAULT_BINDING))[FOLDER_DEFAULT_BINDING]);
  const cached = scope.collectionId ? parseSaveContextCache((await chrome.storage.local.get(SAVE_CONTEXT_CACHE))[SAVE_CONTEXT_CACHE], scope.collectionId) : undefined;
  const nativeId = requestedId ?? remembered?.folderNativeId ?? cached?.parentNativeId ?? await resolveDefaultBookmarkParent(chrome.bookmarks);
  if (!nativeId) throw new Error('capture_target_required');
  await assertPersonalNativeAllowed(nativeId);
  const [node] = await chrome.bookmarks.get(nativeId);
  if (!node || node.url || node.unmodifiable || !node.parentId || await isUnsupportedBookmarkFolder(nativeId)) throw new Error('capture_target_unavailable');
  const path: string[] = []; let current: chrome.bookmarks.BookmarkTreeNode | undefined = node;
  const seen = new Set<string>();
  while (current && !seen.has(current.id)) { seen.add(current.id); if (current.title) path.unshift(current.title);
    current = current.parentId ? (await chrome.bookmarks.get(current.parentId))[0] : undefined; }
  const syncScope = await currentSyncScope().catch(() => null);
  const boundary = syncScope ? await resolveIngressBoundary(syncState, syncScope).catch(() => null) : null;
  const inRange = Boolean(boundary && folderIsInMount(nativeId,
    await walkAncestorIds(nativeId, async id => (await chrome.bookmarks.get(id).catch(() => []))[0]?.parentId), boundary.selectedNative));
  const collections = scope.accountId ? parseCollectionsCache((await chrome.storage.local.get(COLLECTIONS_CACHE))[COLLECTIONS_CACHE], { accountId: scope.accountId }) : undefined;
  await assertCaptureScope(scope);
  return { nativeId, path, inRange, collectionId: scope.collectionId, collectionTitle: collections?.find(value => value.id === scope.collectionId)?.title ?? null };
}
