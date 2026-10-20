import { personalTreeApi } from '../bookmark-subscriptions/personal-boundary.js';
import { countFolderContents } from '../bookmark-boundary.js';
import { browserRootDisplayTitle } from '../browser-root-identity.js';
import { digestJson } from '../bookmark-event-codec.js';
import { BookmarkTreeError, createChromeBookmarkTreeAdapter,
  type NormalizedBookmarkNode, type BookmarkTreeApi } from '../chrome-bookmark-tree.js';
import { FIRST_RUN_DRAFT, parseFirstRunDraft, shouldDefaultPreselect } from '../first-run-draft.js';
import { writeSaveContextCache } from '../save-context-cache.js';
import { recordKns09PermissionRevoked, recordKns09ReconcileFailure } from '../kns-09-release.js';
import { collectNativeIds, reconcileAfterReauth } from '../scope-reconcile.js';
import { canProvisionDefaultSyncRoot } from '../session-binding.js';
import type { ScopeRecord, SyncScope } from '../sync-state-store.js';
import type { PublicRootNode, RootRequest, RootResponse } from '../types.js';
import { bookmarkListenerLifecycle, recoverBookmarkEvents } from './bookmarks.js';
import { scheduleSyncEngineWake } from './engine.js';
import { handleRangeConfirm, handleRangePreview, pendingRangeDescription, resumePendingRangeConfirmation } from './range.js';
import { DEFAULT_SYNC_FOLDER_TITLE, hasBookmarkPermission, rootScopeKey, sw, syncState } from './runtime.js';
import { currentSyncScope, requireSyncScope } from './scope.js';
import { t } from '../i18n.js';
import { captureBoundaryAttempt } from './boundary-attempt.js';
import { executeNativeCreate } from '../native-create-executor.js';
import { createChromePullBookmarkApi } from '../pull-bookmark-api.js';

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
  if (!permissionGranted && message.kind !== 'known.roots.confirm') {
    const required = await permissionRequiredView(scope);
    return message.kind === 'known.roots.get' || message.kind === 'known.roots.permissionChanged'
      ? required : { ok: false, error: 'permission_required' };
  }
  let committed: { readonly confirmationId: string; readonly state: 'committed' } | undefined;
  try {
    if (message.kind === 'known.roots.update') {
      // Older pages must enter the same review/admission protocol. A direct
      // write would bypass a pending command and its boundary version fence.
      return { ok: false, error: 'preview_required' };
    }
    if (message.kind === 'known.roots.preview') {
      return await handleRangePreview(message);
    }
    if (message.kind === 'known.roots.confirm') {
      const confirmed = await handleRangeConfirm(message);
      if (!confirmed.ok) return confirmed;
      committed = { confirmationId: message.confirmationId, state: 'committed' };
      if (!permissionGranted) return { ...await permissionRequiredView(scope), confirmation: committed } as RootResponse;
      return { ok: true, view: await loadRootView(scope), confirmation: committed };
    }
    if (message.kind === 'known.roots.get') await resumePendingRangeConfirmation(scope);
    return { ok: true, view: await loadRootView(scope,
      message.kind === 'known.roots.get' ? message.preselectFolderId : undefined), ...await pendingRangeDescription(scope) };
  } catch (error) {
    const status = error instanceof BookmarkTreeError ? error.code === 'bookmark_tree_corrupt' ? 'corrupt' : error.code : 'corrupt';
    await syncState.setBrowserRootStatus(scope, status);
    sw.rootViewTokens = undefined;
    if (!committed && (message.kind === 'known.roots.confirm' || message.kind === 'known.roots.preview'
        || message.kind === 'known.roots.update')) return { ok: false,
      error: error instanceof BookmarkTreeError ? status : 'root_update_failed' };
    return { ok: true, view: { viewId: crypto.randomUUID(), status, roots: [] },
      ...(committed ? { confirmation: committed } : {}) };
  }
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
    const ref = rootFolderRef(scope, node.nativeId); tokens.set(ref, { nativeId: node.nativeId, ancestorNativeIds });
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
  // This token versions discovered folder identities, not a particular tab.
  // Opening another options page with the same tree must not revoke the first
  // page's ability to preview its selection. Confirmation still checks the
  // durable boundary version and the complete preview digest.
  const previous = sw.rootViewTokens;
  const viewId = previous?.scopeKey === rootScopeKey(scope)
    && sameDiscovered(discovered, [...previous.entries.values()]) ? previous.viewId : crypto.randomUUID();
  sw.rootViewTokens = { viewId, scopeKey: rootScopeKey(scope), entries: tokens };
  return { viewId, status: authority.rootStatus, roots };
}

/** Stable within one exact scope; the live view or durable preview decides
 * which native identities this opaque ref may currently authorize. */
export function rootFolderRef(scope: SyncScope, nativeId: string): string {
  return digestJson([rootScopeKey(scope), nativeId]).slice(7);
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

export async function readRootFolders(api: BookmarkTreeApi = personalTreeApi()) {
  const tree = await createChromeBookmarkTreeAdapter(api).read();
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
  if ((await syncState.listPendingBoundaryCommands(scope)).length) return undefined;
  const attempt = await captureBoundaryAttempt(scope);
  const tree = await createChromeBookmarkTreeAdapter(await attempt.nativeApi(personalTreeApi())).read();
  const host = tree.roots.find((root) => root.rootKind === 'bookmarks_bar' && !root.managed)
    ?? tree.roots.find((root) => root.rootKind === 'other');
  if (!host || host.managed) return undefined;
  const existing = host.children.find((child) =>
    child.kind === 'folder' && !child.managed && child.title === DEFAULT_SYNC_FOLDER_TITLE);
  const commandId = `provision.${digestJson([recorded.scopeKey, recorded.boundaryVersion ?? '0']).slice(7)}`;
  const intentId = `${commandId}.create`;
  // An unknown prior create cannot be identified merely by a matching title.
  // Keep its native receipt until the same command can be resumed safely.
  const priorIntent = await syncState.getApplyIntent(scope, intentId);
  let folderNativeId = !priorIntent ? existing?.nativeId : undefined;
  if (!folderNativeId) {
    const api = await attempt.nativeApi(createChromePullBookmarkApi());
    await attempt.assertCurrent();
    const created = await executeNativeCreate({ scope, store: syncState, api, intentId,
      owner: { scopeKey: recorded.scopeKey, generation: attempt.generation, commandId,
        eventId: commandId, colpId: commandId, substep: 'create-folder' },
      parentNativeId: host.nativeId, expected: { title: DEFAULT_SYNC_FOLDER_TITLE },
      create: () => api.create({ parentId: host.nativeId, title: DEFAULT_SYNC_FOLDER_TITLE }),
    });
    if (created.result !== 'applied_with_evidence') return undefined;
    folderNativeId = created.nativeId;
  }
  await attempt.assertCurrent();
  const live = await syncState.getScope(scope);
  if ((live?.boundaryVersion ?? '0') !== (recorded.boundaryVersion ?? '0') || live?.selectedRoots.length) return undefined;
  const view = await loadRootView(scope);
  const ref = [...sw.rootViewTokens?.entries ?? []].find(([, entry]) => entry.nativeId === folderNativeId)?.[0];
  if (!ref) return undefined;
  const preview = await handleRangePreview({ kind: 'known.roots.preview', viewId: view.viewId,
    selectedRefs: [ref], privateRefs: [] });
  if (!preview.ok || !('preview' in preview)) return undefined;
  await attempt.assertCurrent();
  const confirmed = await handleRangeConfirm({ kind: 'known.roots.confirm', previewId: preview.preview.previewId,
    confirmationId: `${commandId}.range`, treeDigest: preview.preview.treeDigest });
  if (!confirmed.ok) return undefined;
  await attempt.assertCurrent();
  bookmarkListenerLifecycle.install();
  await writeSaveContextCache({ collectionId: scope.collectionId, parentNativeId: folderNativeId }).catch(() => undefined);
  sw.rootViewTokens = undefined;
  return folderNativeId;
}
