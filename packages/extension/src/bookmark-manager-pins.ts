import type { BookmarkAnnotation } from './bookmark-annotation-store.js';
import type { NativeNode } from './bookmark-manager-dom.js';
import type { PinBlocker } from './bookmark-pin-order.js';
import { requestPin } from './bookmark-pin-messages.js';
import { createDialog, dialogButton } from './dialog.js';
import { preferenceHash } from './preferences-navigation.js';
import { t } from './i18n.js';

/**
 * Pins in the open folder. `blockers` is empty when this folder can take new
 * pins; otherwise existing pins are paused here: shown and unpinnable, never
 * enforced.
 */
export interface PinView {
  readonly folderId: string;
  readonly blockers: readonly PinBlocker[];
  readonly pinned: ReadonlySet<string>;
}

/** One bookmark's pin: whether it is pinned, and what keeps its folder from taking new pins (empty: nothing). */
export interface PinState { readonly pinned: boolean; readonly blockers: readonly PinBlocker[] }

const READ_ONLY: readonly PinBlocker[] = ['folder_read_only'];
/** The most folders one status request may name (validPinRequest). */
const STATUS_BATCH = 64;

/** The worker owns eligibility; an unreachable worker reads as "not available here". */
async function loadPinBlockers(folderIds: readonly string[]): Promise<ReadonlyMap<string, readonly PinBlocker[]>> {
  const unique = [...new Set(folderIds)], blockers = new Map<string, readonly PinBlocker[]>();
  for (let start = 0; start < unique.length; start += STATUS_BATCH) {
    const ids = unique.slice(start, start + STATUS_BATCH);
    const response = await requestPin({ kind: 'known.bookmarks.pin.status', folderIds: ids });
    for (const id of ids) blockers.set(id, response.ok && 'folders' in response ? response.folders[id] ?? READ_ONLY : READ_ONLY);
  }
  return blockers;
}

export async function loadPinView(folderId: string, children: readonly NativeNode[],
  notes: ReadonlyMap<string, BookmarkAnnotation>): Promise<PinView> {
  const pinned = new Set(children.filter(child => child.url !== undefined && notes.get(child.id)?.pinned).map(child => child.id));
  return { folderId, blockers: (await loadPinBlockers([folderId])).get(folderId) ?? READ_ONLY, pinned };
}

/**
 * Search and tag results come from many folders, so each bookmark reads its
 * own folder's conditions. The list keeps its result order: pins only reorder
 * a folder.
 */
export async function loadResultPins(nodes: readonly NativeNode[],
  notes: ReadonlyMap<string, BookmarkAnnotation>): Promise<ReadonlyMap<string, PinState>> {
  const bookmarks = nodes.filter(node => node.url !== undefined && node.parentId !== undefined && node.unmodifiable !== 'managed');
  if (bookmarks.length === 0) return new Map();
  const blockers = await loadPinBlockers(bookmarks.map(node => node.parentId!));
  return new Map(bookmarks.map(node => [node.id, { pinned: Boolean(notes.get(node.id)?.pinned), blockers: blockers.get(node.parentId!) ?? READ_ONLY }]));
}

/** The pin of a bookmark in the open folder; nothing for folders and for rows from elsewhere. */
export function folderPinState(view: PinView | undefined, node: NativeNode): PinState | undefined {
  return view && node.url !== undefined && node.parentId === view.folderId ? { pinned: view.pinned.has(node.id), blockers: view.blockers } : undefined;
}

export const pinAvailable = (view: PinView | undefined): boolean => Boolean(view && view.blockers.length === 0);

/** [folders][pinned][other bookmarks] where pins apply; the order inside each group stays native. */
export function projectPinnedChildren<Node extends { readonly id: string; readonly url?: string }>(
  children: readonly Node[], view: PinView | undefined): readonly Node[] {
  if (!pinAvailable(view)) return children;
  const folders = children.filter(child => child.url === undefined);
  const bookmarks = children.filter(child => child.url !== undefined);
  return [...folders, ...bookmarks.filter(child => view!.pinned.has(child.id)), ...bookmarks.filter(child => !view!.pinned.has(child.id))];
}

/**
 * Where pins apply, a bookmark reorders only inside its own group. Dropping
 * on the first other bookmark puts a pinned bookmark at the end of the pinned
 * section, which is the same line an unpinned bookmark uses for the top of its own.
 */
export function pinDropAllowed(view: PinView | undefined, source: NativeNode | undefined, target: NativeNode,
  children: readonly NativeNode[]): boolean {
  if (!pinAvailable(view) || !source || source.url === undefined || target.url === undefined
    || source.parentId !== view!.folderId || target.parentId !== view!.folderId) return true;
  const sourcePinned = view!.pinned.has(source.id), targetPinned = view!.pinned.has(target.id);
  if (sourcePinned === targetPinned) return true;
  const firstOther = children.find(child => child.url !== undefined && !view!.pinned.has(child.id));
  return sourcePinned && firstOther?.id === target.id;
}

export function pinDropAfterAllowed(view: PinView | undefined, source: NativeNode | undefined, target: NativeNode,
  children: readonly NativeNode[]): boolean {
  if (!pinAvailable(view) || !source || source.url === undefined || target.url === undefined
    || source.parentId !== view!.folderId || target.parentId !== view!.folderId) return true;
  const sourcePinned = view!.pinned.has(source.id), targetPinned = view!.pinned.has(target.id);
  if (sourcePinned === targetPinned) return true;
  if (sourcePinned && !targetPinned) return false;
  const pinnedBookmarks = children.filter(child => child.url !== undefined && view!.pinned.has(child.id));
  return pinnedBookmarks.at(-1)?.id === target.id;
}

const conditions = (): readonly { readonly blocker: PinBlocker; readonly copy: string }[] => [
  { blocker: 'insert_bottom', copy: t('pin_conditionTop', 'New bookmarks go to the top of the folder') },
  { blocker: 'folders_first_off', copy: t('pin_conditionFoldersFirst', 'Show folders before bookmarks is on') },
  { blocker: 'folder_unorganized', copy: t('pin_conditionOrganized', 'This folder is organized, with its folders above its bookmarks') },
];

/** Why the pin button does nothing here, with the state of each condition and a way to the settings. */
export function openPinConditions(blockers: readonly PinBlocker[], trigger?: HTMLElement | null): void {
  const { dialog, body, actions } = createDialog(t('pin_unavailableTitle', 'Pinning is off in this folder'), 'mgr-pin-conditions');
  const intro = document.createElement('p');
  const readOnly = blockers.includes('folder_read_only');
  intro.textContent = readOnly ? t('pin_readOnly', 'This folder is read only, so its bookmarks cannot be pinned.')
    : t('pin_conditionsIntro', 'Pinned bookmarks sit right below the folders. Pinning works when:');
  body.append(intro);
  if (!readOnly) {
    const list = document.createElement('ul');
    list.className = 'mgr-pin-condition-list';
    for (const condition of conditions()) {
      const item = document.createElement('li'), met = !blockers.includes(condition.blocker);
      const copy = document.createElement('span'); copy.textContent = condition.copy;
      const state = document.createElement('span'); state.className = 'mgr-pin-condition-state';
      state.textContent = met ? t('pin_conditionMet', 'Done') : t('pin_conditionNeeded', 'Needed');
      item.dataset.met = String(met); item.append(copy, state); list.append(item);
    }
    body.append(list);
  }
  const close = dialogButton(t('common_close', 'Close'));
  close.addEventListener('click', () => dialog.close());
  actions.append(close);
  if (!readOnly) {
    const settings = dialogButton(t('pin_openSettings', 'Open Saving settings'), 'primary');
    settings.addEventListener('click', () => { dialog.close(); location.hash = preferenceHash('bookmarks'); });
    actions.append(settings);
  }
  dialog.addEventListener('close', () => { dialog.remove(); if (trigger?.isConnected) trigger.focus(); });
  document.body.append(dialog); dialog.showModal();
}

/** Asks the worker to pin or unpin; a refused pin shows the conditions instead of failing quietly. */
export async function togglePin(node: NativeNode, state: PinState | undefined, trigger: HTMLElement | null,
  feedback: (copy: string, tone: 'ok' | 'error') => void): Promise<void> {
  const pinned = Boolean(state?.pinned);
  if (!pinned && (!state || state.blockers.length > 0)) { openPinConditions(state?.blockers ?? READ_ONLY, trigger); return; }
  const response = await requestPin({ kind: 'known.bookmarks.pin.set', userGesture: true, nativeId: node.id, pinned: !pinned });
  if (response.ok) feedback(pinned ? t('pin_unpinned', 'Unpinned.') : t('pin_pinned', 'Pinned.'), 'ok');
  else if (response.error === 'not_available') openPinConditions(response.blockers ?? [], trigger);
  else feedback(pinned ? t('pin_unpinFailed', 'The bookmark could not be unpinned.') : t('pin_pinFailed', 'The bookmark could not be pinned.'), 'error');
}
