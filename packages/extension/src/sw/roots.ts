import { personalTreeApi } from '../bookmark-subscriptions/personal-boundary.js';
import { personalBookmarks } from '../bookmark-subscriptions/guards.js';
import { countFolderContents } from '../bookmark-boundary.js';
import { browserRootDisplayTitle } from '../browser-root-identity.js';
import { digestJson } from '../bookmark-event-codec.js';
import { BookmarkTreeError, createChromeBookmarkTreeAdapter, customSourceKeyForFolder,
  type NormalizedBookmarkNode } from '../chrome-bookmark-tree.js';
import { FIRST_RUN_DRAFT, parseFirstRunDraft, shouldDefaultPreselect } from '../first-run-draft.js';
import { writeSaveContextCache } from '../save-context-cache.js';
import { recordKns09PermissionRevoked, recordKns09ReconcileFailure } from '../kns-09-release.js';
import { collectNativeIds, reconcileAfterReauth } from '../scope-reconcile.js';
import { canProvisionDefaultSyncRoot } from '../session-binding.js';
import type { ScopeRecord, SyncScope } from '../sync-state-store.js';
import type { PublicRootNode, RootRequest, RootResponse } from '../types.js';
import { bookmarkListenerLifecycle, recoverBookmarkEvents } from './bookmarks.js';
import { scheduleSyncEngineWake } from './engine.js';
import { handleRangeConfirm, handleRangePreview } from './range.js';
import { DEFAULT_SYNC_FOLDER_TITLE, hasBookmarkPermission, rootScopeKey, sw, syncState } from './runtime.js';
import { currentSyncScope, requireSyncScope } from './scope.js';
import { t } from '../i18n.js';

export async function handleRootRequest(message: RootRequest): Promise<RootResponse> {
  let scope: SyncScope;
  try { scope = await currentSyncScope(); } catch {
    if (message.kind !== 'known.roots.get') return { ok: false, error: 'not_connected' };
    // A reconnect publishes its binding before the Session lane finishes. Join
    // that lane so the first folder read does not get stuck on "connecting".
    try { scope = await requireSyncScope(); } catch { return { ok: false, error: 'not_connected' }; }
  }
  const permissionGranted = await hasBookmarkPermission();
  if (message.kind === 'known.roots.permissionChanged' && permissionGranted !== message.granted) {
    return { ok: false, error: 'request_invalid' };
  }
  if (message.kind === 'known.roots.permissionChanged' && message.granted) {
    await resumeBookmarksAfterPermissionGrant(scope);
  }
  if (message.kind === 'known.roots.boundaries') {
    // Native folder ids for the options-page bookmark manager, which already
    // holds the bookmarks permission; without it no identifiers are exposed.
    if (!permissionGranted) return { ok: true, boundaries: { selected: [], privateLocal: [] } };
    const stored = await syncState.getScope(scope); const mappings = await syncState.listMappings(scope);
    const byColpId = new Map(mappings.map((mapping) => [mapping.colpId, mapping.nativeId]));
    const toNative = (ids: readonly string[] | undefined) => (ids ?? [])
      .map((id) => byColpId.get(id)).filter((value): value is string => Boolean(value));
    return { ok: true, boundaries: { selected: toNative(stored?.selectedRoots),
      privateLocal: toNative(stored?.privateRoots) } };
  }
  if (!permissionGranted) {
    const required = await permissionRequiredView(scope);
    return message.kind === 'known.roots.get' || message.kind === 'known.roots.permissionChanged'
      ? required : { ok: false, error: 'permission_required' };
  }
  try {
    if (message.kind === 'known.roots.update') {
      const selected = resolveRootRefs(scope, message.viewId, message.selectedRefs);
      const privateLocal = resolveRootRefs(scope, message.viewId, message.privateRefs);
      if (!selected || !privateLocal) return { ok: false, error: 'request_invalid' };
      const current = await readRootFolders();
      if (!sw.rootViewTokens || !sameDiscovered(current.discovered, [...sw.rootViewTokens.entries.values()])) {
        sw.rootViewTokens = undefined; return { ok: false, error: 'request_invalid' };
      }
      try { await commitBrowserRootAuthorityAndWake(scope, current.discovered, selected, privateLocal); }
      catch { return { ok: false, error: 'root_update_failed' }; }
    }
    if (message.kind === 'known.roots.preview') {
      return handleRangePreview(message);
    }
    if (message.kind === 'known.roots.confirm') {
      const confirmed = await handleRangeConfirm(message);
      if (!confirmed.ok) return confirmed;
      return { ok: true, view: await loadRootView(scope) };
    }
    return { ok: true, view: await loadRootView(scope,
      message.kind === 'known.roots.get' ? message.preselectFolderId : undefined) };
  } catch (error) {
    const status = error instanceof BookmarkTreeError ? error.code === 'bookmark_tree_corrupt' ? 'corrupt' : error.code : 'corrupt';
    await syncState.setBrowserRootStatus(scope, status);
    sw.rootViewTokens = undefined;
    // A failed write/confirmation must never masquerade as a successful
    // folder-settings save merely because we can render a degraded root view.
    if (message.kind !== 'known.roots.get' && message.kind !== 'known.roots.permissionChanged') {
      return { ok: false, error: 'root_update_failed' };
    }
    return { ok: true, view: { viewId: crypto.randomUUID(), status, roots: [] } };
  }
}

async function commitBrowserRootAuthorityAndWake(scope: SyncScope,
  discovered: readonly { nativeId: string; ancestorNativeIds: readonly string[] }[],
  selectedNativeIds: readonly string[], privateNativeIds: readonly string[]) {
  const primary = selectedNativeIds[0];
  await syncState.configureBrowserRoots(scope, { discovered, selectedNativeIds, privateNativeIds, status: 'ready' });
  if (primary) {
    await writeSaveContextCache({ collectionId: scope.collectionId, parentNativeId: primary,
      ...(privateNativeIds[0] ? { privateParentNativeId: privateNativeIds[0] } : {}) }).catch(() => undefined);
  }
  scheduleSyncEngineWake('manual');
}

async function permissionRequiredView(scope: SyncScope): Promise<RootResponse> {
  const prior = await syncState.getScope(scope);
  if (prior?.rootStatus === 'ready') recordKns09PermissionRevoked(scope);
  await syncState.setBrowserRootStatus(scope, 'permission_required'); sw.rootViewTokens = undefined;
  return { ok: true, view: { viewId: crypto.randomUUID(), status: 'permission_required', roots: [] } };
}

export async function resumeBookmarksAfterPermissionGrant(scope?: SyncScope): Promise<void> {
  bookmarkListenerLifecycle.install();
  let resolved = scope;
  try { resolved ??= await currentSyncScope(); } catch { return; }
  await reconcileGrantedPermission(resolved);
  await recoverBookmarkEvents();
  scheduleSyncEngineWake('manual');
}

async function reconcileGrantedPermission(scope: SyncScope) {
  try {
    const tree = await createChromeBookmarkTreeAdapter(personalTreeApi()).read();
    const nativePresent = collectNativeIds(tree.roots);
    const { discovered } = await readRootFolders();
    await reconcileAfterReauth(syncState, scope, {
      treeDigest: digestJson([...nativePresent].sort()), nativePresent, discovered,
    });
  } catch {
    recordKns09ReconcileFailure(scope);
    /* Keep mappings when the tree is unreadable after re-auth. */
  }
}

export async function loadRootView(scope: SyncScope, preselectFolderId?: string) {
  const recorded = await syncState.getScope(scope);
  const priorStatus = recorded?.rootStatus;
  const { flattened, discovered } = await readRootFolders();
  const authority = await syncState.reconcileBrowserRoots(scope, discovered);
  if (priorStatus === 'permission_required'
      && (authority.rootStatus === 'ready' || authority.rootStatus === 'nested_normalized')) {
    await recoverBookmarkEvents();
    scheduleSyncEngineWake('manual');
  }
  const mappings = await syncState.listMappings(scope); const byNative = new Map(mappings.map((item) => [item.nativeId, item.colpId]));
  const previewNativeIds = await firstRunPreviewNativeIds(scope, recorded?.firstRun);
  const hasCommittedSelection = (authority.selectedRoots?.length ?? 0) > 0;
  // Empty selectedRoots after first-run would paint every folder unselected, so a
  // later range confirm diffs live mounts as removals. Project active mounts.
  const liveMountNative = !hasCommittedSelection
    && (recorded?.firstRun === 'completed' || recorded?.firstRun === 'running')
    ? new Set((await syncState.listMountBindings(scope))
      .filter((mount) => mount.status !== 'detached').map((mount) => mount.nativeRootId))
    : undefined;
  const tokens = new Map<string, { nativeId: string; ancestorNativeIds: readonly string[] }>();
  const repeatedRootKinds = new Set(flattened.filter(row => row.depth === 0 && !row.node.managed)
    .filter((row, index, all) => all.some((other, otherIndex) => otherIndex !== index && other.rootKind === row.rootKind))
    .map(row => row.rootKind));
  const roots = flattened.map(({ node, rootKind, depth, ancestorNativeIds }): PublicRootNode => {
    const ref = digestJson([rootScopeKey(scope), node.nativeId]).slice(7); tokens.set(ref, { nativeId: node.nativeId, ancestorNativeIds });
    const colpId = byNative.get(node.nativeId);
    const counts = countFolderContents(node);
    /* R13 D-21: a deep-linked folder arrives checked so the user only has to
       confirm — managed rows stay untouched. */
    const flagged = !node.managed && node.nativeId === preselectFolderId;
    const selected = node.managed ? false
      : (previewNativeIds ? previewNativeIds.has(node.nativeId)
      : hasCommittedSelection ? colpId !== undefined && authority.selectedRoots.includes(colpId)
        : liveMountNative ? liveMountNative.has(node.nativeId)
        : shouldDefaultPreselect({
          managed: node.managed, depth, bookmarkCount: counts.bookmarkCount, folderCount: counts.folderCount,
          firstRun: recorded?.firstRun, hasCommittedSelection,
        }));
    const title = node.title || rootLabel(rootKind);
    return { ref, title: depth === 0 ? browserRootDisplayTitle(title, node.syncing, repeatedRootKinds.has(rootKind)) : title,
      kind: rootKind, depth, selected,
      privateLocal: colpId !== undefined && authority.privateRoots.includes(colpId), managed: node.managed,
      bookmarkCount: counts.bookmarkCount, folderCount: counts.folderCount,
      ...(flagged ? { preselected: true as const } : {}),
      ...(node.managed ? { exclusionReason: 'managed' as const } : {}) };
  });
  const viewId = crypto.randomUUID(); sw.rootViewTokens = { viewId, scopeKey: rootScopeKey(scope), entries: tokens };
  return { viewId, status: authority.rootStatus, roots };
}

async function firstRunPreviewNativeIds(scope: SyncScope, firstRun: ScopeRecord['firstRun']): Promise<Set<string> | undefined> {
  // Once confirmed sync completes, durable root authority owns the selection.
  // A leftover onboarding preview must not mask it on reload or reauthorization.
  if (firstRun === 'completed') return undefined;
  try {
    const draft = parseFirstRunDraft((await chrome.storage.local.get(FIRST_RUN_DRAFT))[FIRST_RUN_DRAFT]);
    if (!draft?.previewId) return undefined;
    const preview = await syncState.getScopePreview(scope, draft.previewId);
    if (!preview || preview.expiresAt <= Date.now()) return undefined;
    return new Set(preview.boundary.selectedNativeIds);
  } catch {
    return undefined;
  }
}

export async function readRootFolders() {
  const tree = await createChromeBookmarkTreeAdapter(personalTreeApi()).read();
  const discovered: Array<{ nativeId: string; ancestorNativeIds: string[] }> = [];
  const flattened: Array<{ node: NormalizedBookmarkNode; rootKind: PublicRootNode['kind']; depth: number;
    ancestorNativeIds: string[] }> = [];
  tree.roots.forEach((root) => flattenFolders(root, root.rootKind === 'browser_root' ? 'folder' : root.rootKind,
    0, [], flattened, discovered));
  return { flattened, discovered };
}

function flattenFolders(node: NormalizedBookmarkNode, rootKind: PublicRootNode['kind'], depth: number,
  ancestors: string[], output: Array<{ node: NormalizedBookmarkNode; rootKind: PublicRootNode['kind']; depth: number;
    ancestorNativeIds: string[] }>, discovered: Array<{ nativeId: string; ancestorNativeIds: string[] }>) {
  if (node.kind !== 'folder') return;
  output.push({ node, rootKind: depth === 0 ? rootKind : 'folder', depth, ancestorNativeIds: ancestors });
  discovered.push({ nativeId: node.nativeId, ancestorNativeIds: ancestors });
  for (const child of node.children) flattenFolders(child, 'folder', depth + 1, [...ancestors, node.nativeId], output, discovered);
}

function resolveRootRefs(scope: SyncScope, viewId: string, refs: readonly string[]) {
  if (!Array.isArray(refs) || refs.length > 128 || refs.some((ref) => typeof ref !== 'string')) return null;
  if (!sw.rootViewTokens || sw.rootViewTokens.viewId !== viewId || sw.rootViewTokens.scopeKey !== rootScopeKey(scope)) return null;
  const resolved = refs.map((ref) => sw.rootViewTokens!.entries.get(ref)?.nativeId);
  return resolved.some((value) => !value) ? null : resolved as string[];
}

export function sameDiscovered(left: readonly { nativeId: string; ancestorNativeIds: readonly string[] }[],
  right: readonly { nativeId: string; ancestorNativeIds: readonly string[] }[]) {
  if (left.length !== right.length) return false;
  const byId = new Map(right.map((item) => [item.nativeId, item.ancestorNativeIds]));
  return left.every((item) => { const prior = byId.get(item.nativeId); return prior !== undefined
    && prior.length === item.ancestorNativeIds.length && prior.every((id, index) => id === item.ancestorNativeIds[index]); });
}

function rootLabel(kind: PublicRootNode['kind']) { return kind === 'bookmarks_bar' ? t('sync_bookmarksBar', 'Bookmarks bar')
  : kind === 'other' ? t('sync_otherBookmarks', 'Other bookmarks') : kind === 'mobile' ? t('sync_mobileBookmarks', 'Mobile bookmarks') : t('sync_folder', 'Folder'); }

export async function resolvePrivateRootNativeId(scope: SyncScope): Promise<string | undefined> {
  const recorded = await syncState.getScope(scope);
  const privateRoot = recorded?.privateRoots?.[0];
  if (!privateRoot) return undefined;
  return (await syncState.getMappingByColpId(scope, privateRoot))?.nativeId;
}

/**
 * First popup save without a bound sync folder, after first-run completed and
 * an explicit “create Know-N folder” choice: bind a dedicated custom mount.
 * Never seeds Collection canonical root. Zero side effects until both gates pass.
 */
export async function provisionDefaultSyncRoot(scope: SyncScope, options?: {
  readonly explicitCreateKnowNFolder?: boolean;
}): Promise<string | undefined> {
  const recorded = await syncState.getScope(scope);
  if (!canProvisionDefaultSyncRoot(recorded?.firstRun, options?.explicitCreateKnowNFolder)) return undefined;
  if (!await hasBookmarkPermission()) return undefined;
  if (!recorded || recorded.selectedRoots.length > 0) return undefined;
  const tree = await createChromeBookmarkTreeAdapter(personalTreeApi()).read();
  const host = tree.roots.find((root) => root.rootKind === 'bookmarks_bar' && !root.managed)
    ?? tree.roots.find((root) => root.rootKind === 'other');
  if (!host || host.managed) return undefined;
  const existing = host.children.find((child) =>
    child.kind === 'folder' && !child.managed && child.title === DEFAULT_SYNC_FOLDER_TITLE);
  const folderNativeId = existing?.nativeId
    ?? (await personalBookmarks.create({ parentId: host.nativeId, title: DEFAULT_SYNC_FOLDER_TITLE })).id;
  const { discovered } = await readRootFolders();
  if (!discovered.some((item) => item.nativeId === folderNativeId)) return undefined;
  await syncState.putMountBinding(scope, {
    mountId: crypto.randomUUID(), nativeRootId: folderNativeId, remoteMountNodeId: null,
    boundaryVersion: recorded.boundaryVersion ?? '0', materialized: false, status: 'active',
    customSourceKey: customSourceKeyForFolder(folderNativeId),
  });
  bookmarkListenerLifecycle.install();
  await commitBrowserRootAuthorityAndWake(scope, discovered, [folderNativeId], []);
  sw.rootViewTokens = undefined;
  return folderNativeId;
}
