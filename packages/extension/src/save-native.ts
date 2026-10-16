import { assertPersonalNativeAllowed } from './bookmark-subscriptions/guards.js';
import { createFaviconSidecarStore, FAVICON_SIDECAR_ALARM } from './favicon-sidecar-store.js';
import { httpTabs, savePagesThroughNativeIngress, type NativeSavePage } from './save-entry.js';
import { presentSaveFeedback } from './save-feedback.js';
import { commitSaveFolder, folderIsInMount, walkAncestorIds } from './save-folder.js';
import { resolveInRangeSaveParent } from './save-target.js';
import { writeLastSave } from './save-status.js';
import type { BookmarkInsertPosition } from './bookmark-preferences.js';
import { createBookmarkCreatePlacementStore } from './bookmark-create-placement.js';
import { t } from './i18n.js';

export const SAVE_ACTION_CACHE = 'known.save.action.v1';
export const SAVE_ACTION_TTL_MS = 8_000;
export const SAVE_PAGE_MENU_ID = 'known-save-page';
export const SAVE_WINDOW_MENU_ID = 'known-save-window';
export const SAVE_WINDOW_COMMAND = 'save-window-tabs';
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export type NativeSaveKind = 'page' | 'window';
export type NativeSaveError = 'permission_required' | 'create_failed' | 'no_page' | 'busy' | 'folder_required';
export type NativeSaveResult =
  | { readonly ok: true; readonly nativeIds: readonly string[]; readonly localOnly: boolean;
    readonly reused: boolean; readonly parentNativeId?: string; readonly captured: boolean }
  | { readonly ok: false; readonly error: NativeSaveError };

export interface SaveActionRecord {
  readonly kind?: NativeSaveKind;
  readonly collectionId?: string;
  readonly insertPosition?: BookmarkInsertPosition;
  readonly identity: string;
  readonly status: 'pending' | 'completed';
  readonly nativeIds: readonly string[];
  readonly updatedAt: number;
  readonly parentNativeId?: string;
  readonly localOnly?: boolean;
  readonly nextIndex?: number;
  readonly pages?: readonly NativeSavePage[];
  readonly placementBatchId?: string;
  readonly placementIntentId?: string;
  readonly attemptedPageIndex?: number;
  readonly attemptedNativeIndex?: number;
}

export interface NativeSaveInput {
  readonly kind: NativeSaveKind;
  readonly hasPermission: boolean;
  readonly collectionId?: string;
  readonly mountNativeIds: readonly string[];
  readonly now?: () => number;
  readonly queryTabs?: () => Promise<readonly { readonly title?: string; readonly url?: string;
    readonly favIconUrl?: string }[]>;
  readonly bookmarks?: Parameters<typeof savePagesThroughNativeIngress>[0]['bookmarks'];
  readonly sidecar?: Parameters<typeof savePagesThroughNativeIngress>[0]['sidecar'];
  readonly insertPosition?: BookmarkInsertPosition;
  readonly foldersFirst?: boolean;
}

const inflight = new Set<string>();

export function nativeSaveIdentity(kind: NativeSaveKind, pages: readonly NativeSavePage[], parentNativeId?: string,
  insertPosition?: BookmarkInsertPosition): string {
  if (parentNativeId === undefined && insertPosition === undefined) {
    if (kind === 'page') return `page:${pages[0]?.url ?? ''}`;
    return `window:${[...pages.map((page) => page.url)].sort().join('\n')}`;
  }
  const orderedPages = pages.map((page) => page.url);
  return `${kind}|${parentNativeId ?? ''}|${insertPosition ?? 'bottom'}|${JSON.stringify(orderedPages)}`;
}

export function parseSaveAction(value: unknown): SaveActionRecord | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.kind !== undefined && record.kind !== 'page' && record.kind !== 'window') return undefined;
  if (record.collectionId !== undefined && (typeof record.collectionId !== 'string' || !record.collectionId)) return undefined;
  if (record.insertPosition !== undefined && record.insertPosition !== 'top' && record.insertPosition !== 'bottom') return undefined;
  if (typeof record.identity !== 'string' || record.identity.length === 0) return undefined;
  if (record.status !== 'pending' && record.status !== 'completed') return undefined;
  if (typeof record.updatedAt !== 'number' || !Number.isFinite(record.updatedAt)) return undefined;
  if (!Array.isArray(record.nativeIds) || record.nativeIds.some((id) => typeof id !== 'string')) return undefined;
  if (record.parentNativeId !== undefined && typeof record.parentNativeId !== 'string') return undefined;
  if (record.localOnly !== undefined && typeof record.localOnly !== 'boolean') return undefined;
  if (record.nextIndex !== undefined && (typeof record.nextIndex !== 'number'
      || !Number.isSafeInteger(record.nextIndex) || record.nextIndex < 0)) return undefined;
  if (record.pages !== undefined && (!Array.isArray(record.pages) || record.pages.some((page) => !parseNativePage(page)))) return undefined;
  if (record.placementBatchId !== undefined
      && (typeof record.placementBatchId !== 'string' || !UUID_V4.test(record.placementBatchId))) return undefined;
  if (record.placementIntentId !== undefined
      && (typeof record.placementIntentId !== 'string' || !UUID_V4.test(record.placementIntentId))) return undefined;
  for (const key of ['attemptedPageIndex', 'attemptedNativeIndex'] as const) {
    if (record[key] !== undefined && (typeof record[key] !== 'number'
        || !Number.isSafeInteger(record[key]) || record[key] < 0)) return undefined;
  }
  return { ...(record.kind ? { kind: record.kind as NativeSaveKind } : {}),
    ...(typeof record.collectionId === 'string' ? { collectionId: record.collectionId } : {}),
    ...(record.insertPosition ? { insertPosition: record.insertPosition as BookmarkInsertPosition } : {}),
    identity: record.identity, status: record.status, nativeIds: record.nativeIds as string[],
    updatedAt: record.updatedAt,
    ...(typeof record.parentNativeId === 'string' ? { parentNativeId: record.parentNativeId } : {}),
    ...(typeof record.localOnly === 'boolean' ? { localOnly: record.localOnly } : {}),
    ...(typeof record.nextIndex === 'number' ? { nextIndex: record.nextIndex } : {}),
    ...(Array.isArray(record.pages) ? { pages: record.pages as NativeSavePage[] } : {}),
    ...(typeof record.placementBatchId === 'string' ? { placementBatchId: record.placementBatchId } : {}),
    ...(typeof record.placementIntentId === 'string' ? { placementIntentId: record.placementIntentId } : {}),
    ...(typeof record.attemptedPageIndex === 'number' ? { attemptedPageIndex: record.attemptedPageIndex } : {}),
    ...(typeof record.attemptedNativeIndex === 'number' ? { attemptedNativeIndex: record.attemptedNativeIndex } : {}),
  };
}

export function reuseNativeSave(
  record: SaveActionRecord | undefined, identity: string, now: number,
): 'pending' | 'completed' | undefined {
  if (!record || record.identity !== identity) return undefined;
  if (record.status === 'pending') return 'pending';
  if (now - record.updatedAt > SAVE_ACTION_TTL_MS) return undefined;
  return record.status;
}

export function clearNativeSaveInflight(): void { inflight.clear(); }

export async function runNativeSave(input: NativeSaveInput): Promise<NativeSaveResult> {
  const now = input.now ?? Date.now;
  const entry = input.kind;
  if (!input.hasPermission) {
    await presentSaveFeedback({ code: 'permission_required', entry, now: now() });
    return { ok: false, error: 'permission_required' };
  }
  const query = input.queryTabs ?? (() => chrome.tabs.query({
    ...(input.kind === 'page' ? { active: true } : {}), currentWindow: true,
  }));
  const priorAtStart = parseSaveAction(await readAction());
  const queriedPages = httpTabs(await query().catch(() => []));
  if (queriedPages.length === 0 && !(priorAtStart?.status === 'pending' && priorAtStart.pages?.length)) {
    await presentSaveFeedback({ code: 'no_page', entry, now: now() });
    return { ok: false, error: 'no_page' };
  }
  const resuming = priorAtStart?.status === 'pending' && priorAtStart.kind !== undefined;
  if (resuming && (priorAtStart.kind !== input.kind || priorAtStart.collectionId !== input.collectionId
      || (queriedPages.length > 0 && JSON.stringify(queriedPages.map(page => page.url))
        !== JSON.stringify(priorAtStart.pages?.map(page => page.url))))) return { ok: false, error: 'busy' };
  const placement = resuming ? priorAtStart.insertPosition : input.insertPosition;
  const insertPosition = placement ?? 'bottom';
  const frozenIntent = { kind: input.kind, ...(input.collectionId ? { collectionId: input.collectionId } : {}),
    ...(placement ? { insertPosition: placement } : {}) };
  let identity: string | undefined;
  let createStarted = false;
  try {
    const prior = priorAtStart;
    const target = resuming ? undefined : await resolveInRangeSaveParent({
      collectionId: input.collectionId,
      mountNativeIds: input.mountNativeIds, getParent: chromeParent, folderExists,
    });
    let parentNativeId = resuming ? priorAtStart.parentNativeId : target?.parentNativeId;
    if (resuming && parentNativeId && !await folderExists(parentNativeId)) return { ok: false, error: 'busy' };
    if (!parentNativeId) {
      await presentSaveFeedback({ code: 'folder_required', entry, now: now() });
      return { ok: false, error: 'folder_required' };
    }
    const mounts = new Set(input.mountNativeIds);
    const currentlyInRange = parentNativeId
      ? (mounts.size === 0 || folderIsInMount(parentNativeId, await walkAncestorIds(parentNativeId, chromeParent), mounts))
      : false;
    if (resuming && priorAtStart.localOnly === false && !currentlyInRange) return { ok: false, error: 'busy' };
    const inRange = currentlyInRange && !(resuming && priorAtStart.localOnly);
    const identityPages = queriedPages.length > 0 ? queriedPages : (prior?.pages ?? []);
    const currentIdentity = nativeSaveIdentity(input.kind, identityPages, parentNativeId, insertPosition);
    if (prior?.status === 'pending' && prior.identity !== currentIdentity) return { ok: false, error: 'busy' };
    const pages = prior?.status === 'pending' && prior.pages?.length ? prior.pages : queriedPages;
    identity = currentIdentity;
    if (inflight.has(identity)) return { ok: false, error: 'busy' };
    inflight.add(identity);
    const reuse = reuseNativeSave(prior, identity, now());
    const bookmarks = input.bookmarks ?? chrome.bookmarks;
    if (!bookmarks) {
      await clearAction();
      await presentSaveFeedback({ code: 'create_failed', entry, now: now() });
      return { ok: false, error: 'create_failed' };
    }
    if (reuse === 'completed' && prior && await nativesStillExist(prior.nativeIds)) {
      return { ok: true, nativeIds: prior.nativeIds, localOnly: prior.localOnly ?? !inRange, reused: true, captured: false,
        ...(prior.parentNativeId ?? parentNativeId ? { parentNativeId: prior.parentNativeId ?? parentNativeId } : {}) };
    }
    let priorIds = reuse === 'pending' && prior ? [...prior.nativeIds] : [];
    if (priorIds.length > 0 && !await nativesStillExist(priorIds)) return { ok: false, error: 'busy' };
    let nextIndex = reuse === 'pending' ? prior?.nextIndex : undefined;
    const frozenPages = reuse === 'pending' && prior?.pages ? prior.pages : pages;
    const placementBatchId = reuse === 'pending' && prior?.placementBatchId
      ? prior.placementBatchId : crypto.randomUUID().toLowerCase();
    const placementStore = placement && inRange
      ? createBookmarkCreatePlacementStore({ now }) : undefined;
    let unknownResolution: 'absent' | 'recovered' | 'attention' | undefined;
    if (reuse === 'pending' && prior?.placementIntentId && prior.attemptedPageIndex !== undefined
        && prior.attemptedNativeIndex !== undefined && parentNativeId && bookmarks.getChildren && placementStore) {
      const recovered = await recoverUnknownNativeCreate({
        prior, pages: frozenPages, parentNativeId, bookmarks, placementStore, now: now(),
      });
      unknownResolution = recovered.kind;
      if (recovered.kind === 'attention') return { ok: false, error: 'busy' };
      if (recovered.nativeId) {
        priorIds.push(recovered.nativeId);
        nextIndex = prior.attemptedNativeIndex + 1;
      }
    }
    if (reuse === 'pending' && (!prior || (priorIds.length === 0 && unknownResolution !== 'absent'))) {
      return { ok: false, error: 'busy' };
    }
    await writeAction({ ...frozenIntent, identity, status: 'pending', nativeIds: priorIds, updatedAt: now(),
      ...(parentNativeId ? { parentNativeId } : {}), localOnly: !inRange,
      ...(nextIndex === undefined ? {} : { nextIndex }), pages: frozenPages, placementBatchId });
    const sidecar = input.sidecar ?? createSidecar();
    const nativeIds = [...priorIds];
    let actionNextIndex = nextIndex;
    const saveBookmarks: Parameters<typeof savePagesThroughNativeIngress>[0]['bookmarks'] = {
      ...(bookmarks.getChildren ? {
        getChildren: (id: string) => bookmarks.getChildren!.call(bookmarks, id),
      } : {}),
      ...(bookmarks.getTree ? {
        getTree: () => bookmarks.getTree!.call(bookmarks),
      } : {}),
      create: async (bookmark: { parentId?: string; index?: number; title?: string; url?: string }) => {
        createStarted = true;
        await assertPersonalNativeAllowed(bookmark.parentId);
        const created = await bookmarks.create(bookmark);
        nativeIds.push(created.id);
        actionNextIndex = bookmark.index === undefined ? actionNextIndex : bookmark.index + 1;
        await writeAction({ ...frozenIntent, identity: identity!, status: 'pending', nativeIds, updatedAt: now(),
          ...(parentNativeId ? { parentNativeId } : {}), localOnly: !inRange,
          ...(actionNextIndex === undefined ? {} : { nextIndex: actionNextIndex }), pages: frozenPages,
          placementBatchId });
        return created;
      },
    };
    try {
      const remainingPages = priorIds.length > 0 ? frozenPages.slice(priorIds.length) : frozenPages;
      const saved = await savePagesThroughNativeIngress({
        pages: remainingPages, parentNativeId,
        ...(placement ? { insertPosition } : {}), ...(input.foldersFirst ? { foldersFirst: true } : {}),
        ...(priorIds.length > 0 ? { resumeNativeIds: priorIds } : {}),
        placementBatch: { id: placementBatchId, orderOffset: priorIds.length, totalSize: frozenPages.length },
        ...(placementStore ? { placementStore } : {}),
        onPlacementReserved: async (reservation) => writeAction({ ...frozenIntent,
          identity: identity!, status: 'pending', nativeIds, updatedAt: now(),
          ...(parentNativeId ? { parentNativeId } : {}), localOnly: !inRange,
          ...(actionNextIndex === undefined ? {} : { nextIndex: actionNextIndex }), pages: frozenPages,
          placementBatchId, placementIntentId: reservation.intentId,
          attemptedPageIndex: reservation.batchOrder, attemptedNativeIndex: reservation.expectedIndex,
        }),
        collectionId: inRange ? input.collectionId : undefined, bookmarks: saveBookmarks, sidecar,
      });
      for (const item of saved) if (item.nativeId && !nativeIds.includes(item.nativeId)) nativeIds.push(item.nativeId);
      if (nativeIds.length === 0) {
        await clearAction();
        await presentSaveFeedback({ code: 'create_failed', entry, now: now() });
        return { ok: false, error: 'create_failed' };
      }
      await writeAction({ ...frozenIntent, identity, status: 'completed', nativeIds, updatedAt: now(),
        ...(parentNativeId ? { parentNativeId } : {}), localOnly: !inRange,
        ...(actionNextIndex === undefined ? {} : { nextIndex: actionNextIndex }), pages: frozenPages,
        placementBatchId });
      if (saved.some((item) => item.captured)) {
        try { chrome.alarms.create(FAVICON_SIDECAR_ALARM, { when: Date.now() + 1_000 }); } catch { /* optional */ }
      }
      if (parentNativeId) {
        await commitSaveFolder({ folderNativeId: parentNativeId });
      }
      const last = saved.at(-1);
      const lastNativeId = last?.nativeId ?? nativeIds.at(-1);
      if (lastNativeId) {
        await writeLastSave({
          nativeId: lastNativeId, localOnly: !inRange,
          ...(parentNativeId ? { parentNativeId } : {}),
          ...(input.collectionId ? { collectionId: input.collectionId } : {}),
        });
      }
      await presentSaveFeedback({
        code: inRange ? 'saved' : 'no_folder', entry, nativeId: lastNativeId, now: now(),
      });
      return {
        ok: true, nativeIds, localOnly: !inRange, reused: false,
        captured: saved.some((item) => item.captured),
        ...(parentNativeId ? { parentNativeId } : {}),
      };
    } finally { sidecar.close(); }
  } catch (error) {
    // A create may have committed before a worker/response failure. Keep the
    // durable prefix so the next attempt can resume; an empty prefix remains
    // busy because its native result is unknown.
    if (!createStarted && priorAtStart?.status !== 'pending') await clearAction();
    if (error instanceof Error && error.message === 'bookmark_resume_placement_unproven') {
      await presentSaveFeedback({ code: 'busy', entry, now: now(),
        message: t('save_previouslySavedBookmarksWere', 'Previously saved bookmarks were moved or reordered. Review their location before resuming this save.') });
      return { ok: false, error: 'busy' };
    }
    await presentSaveFeedback({ code: 'create_failed', entry, now: now() });
    return { ok: false, error: 'create_failed' };
  } finally { if (identity) inflight.delete(identity); }
}

function createSidecar(): ReturnType<typeof createFaviconSidecarStore> {
  try { return createFaviconSidecarStore(); }
  catch {
    return { close() { /* tests without IndexedDB */ }, put: async () => undefined } as never;
  }
}

function parseNativePage(value: unknown): value is NativeSavePage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const page = value as Record<string, unknown>;
  return typeof page.title === 'string' && typeof page.url === 'string'
    && (page.favIconUrl === undefined || typeof page.favIconUrl === 'string');
}

async function recoverUnknownNativeCreate(input: {
  readonly prior: SaveActionRecord;
  readonly pages: readonly NativeSavePage[];
  readonly parentNativeId: string;
  readonly bookmarks: Parameters<typeof savePagesThroughNativeIngress>[0]['bookmarks'];
  readonly placementStore: ReturnType<typeof createBookmarkCreatePlacementStore>;
  readonly now: number;
}): Promise<{ readonly kind: 'absent' | 'attention' | 'recovered'; readonly nativeId?: string }> {
  const intentId = input.prior.placementIntentId!;
  const receipt = await input.placementStore.getReceipt(intentId);
  const intent = receipt ?? await input.placementStore.get(intentId);
  if (!intent || intent.state === 'attention') return { kind: 'attention' };
  const page = input.pages[input.prior.attemptedPageIndex!];
  if (!page || intent.targetParentNativeId !== input.parentNativeId
      || intent.batchId !== input.prior.placementBatchId || intent.batchOrder !== input.prior.attemptedPageIndex
      || intent.title !== page.title || intent.url !== page.url) return { kind: 'attention' };
  const children = await input.bookmarks.getChildren!(input.parentNativeId);
  if (intent.nativeId) {
    // An event receipt proves the exact native identity. Do not substitute a
    // same-URL sibling or recreate a node that was subsequently removed.
    return children.some(node => node.id === intent.nativeId)
      ? { kind: 'recovered', nativeId: intent.nativeId } : { kind: 'attention' };
  }
  const recent = children.filter((node) => node.title === page.title && node.url === page.url
    && typeof node.dateAdded === 'number' && node.dateAdded >= intent.createdAt - 2_000
    && node.dateAdded <= input.now + 2_000);
  const atIndex = recent.filter((node) => node.index === input.prior.attemptedNativeIndex);
  const candidates = atIndex.length > 0 ? atIndex : recent;
  if (candidates.length === 0) {
    await input.placementStore.cancel(intentId);
    return { kind: 'absent' };
  }
  if (candidates.length !== 1) return { kind: 'attention' };
  await input.placementStore.bind(intentId, candidates[0]!.id);
  return { kind: 'recovered', nativeId: candidates[0]!.id };
}

async function chromeParent(id: string): Promise<string | undefined> {
  try {
    const nodes = await chrome.bookmarks.get(id);
    return nodes[0]?.parentId;
  } catch { return undefined; }
}

async function folderExists(id: string): Promise<boolean> {
  try { return (await chrome.bookmarks.get(id)).length > 0; } catch { return false; }
}

async function nativesStillExist(ids: readonly string[]): Promise<boolean> {
  if (ids.length === 0) return false;
  for (const id of ids) if (!await folderExists(id)) return false;
  return true;
}

async function readAction(): Promise<unknown> {
  try { return (await chrome.storage.session.get(SAVE_ACTION_CACHE))[SAVE_ACTION_CACHE]; }
  catch { return undefined; }
}

async function writeAction(record: SaveActionRecord): Promise<void> {
  try { await chrome.storage.session.set({ [SAVE_ACTION_CACHE]: record }); } catch { /* best-effort */ }
}

async function clearAction(): Promise<void> {
  try { await chrome.storage.session.remove(SAVE_ACTION_CACHE); } catch { /* best-effort */ }
}
