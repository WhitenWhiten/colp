import { moveSuggestedBookmark } from './classification-destination-client.js';
import { personalBookmarks } from './bookmark-subscriptions/guards.js';
import type { CaptureLocation } from './capture/contracts.js';
import { repaintExistenceSaveControl } from './capture/manual-existence.js';
import { clearPopupDraft } from './popup-draft.js';
import { loadAnnotation, saveAnnotation, sameAnnotation, type Annotation, type AnnotationBookmark } from './popup-annotations.js';
import { formatSavedDate, paintStatusLine, setFooterMode } from './popup-shell.js';
import { saveButtonLabel } from './popup-device-save.js';
import { t } from './i18n.js';
import { removePopupBookmark, undoPopupBookmark } from './popup-bookmark-delete.js';
import type { PublicBatchStatus } from './types.js';
import { requestPin } from './bookmark-pin-messages.js';

/** The popup's tags and note fields, as seen by the edit-in-place flow. */
export interface AnnotationFields {
  read(): Annotation;
  /** Shows a saved annotation in the fields. */
  write(annotation: Annotation): void;
  /** True once the user (or a restored draft) has put something in the fields. */
  touched(): boolean;
}

export interface EditExistingHost {
  readonly titleInput: { value: string };
  /** The tab's own title: a title field still showing it has not been edited. */
  readonly aiDestinationPolicyDigest?: () => string | undefined;
  readonly tabTitle: () => string;
  readonly save: HTMLButtonElement;
  readonly remove: HTMLButtonElement;
  readonly folders: {
    adopt(nativeId: string): Promise<void>;
    userPicked(): boolean;
    chosenFolderId(): string;
    setParentVisible(visible: boolean): void;
  };
  /** Records a moved-to folder as used, like any saved pick. */
  readonly commitFolder: () => Promise<void>;
  readonly setFeedback: (text: string, tone?: '' | 'ok' | 'error') => void;
  readonly annotation: AnnotationFields;
  /** The pin toggle: shows the saved pin, and reports a change to apply on Done. */
  readonly pin?: { adopt(pinned: boolean | undefined): void; change(): boolean | undefined };
}

interface Editing { readonly nativeId: string; readonly url: string; readonly parentId: string; readonly title: string;
  readonly ref: AnnotationBookmark; readonly loaded: Annotation }

/**
 * The native star's edit mode: when the page is already bookmarked in exactly
 * one personal folder, the popup shows that bookmark (its name, folder, tags
 * and note) and Done renames or moves it and keeps the tags and note, Remove
 * deletes it. Each bookmark change is one native call through the
 * personal-bookmark guard, so the KNS-04 listener ingests it like any edit made
 * in the browser's own dialog; nothing here speaks to sync. A page saved in
 * several places (or somewhere read-only) only reports that, and Done closes.
 * "Save another copy" still switches back to an ordinary save.
 */
export function bindEditExisting(host: EditExistingHost): {
  /** Applies the edit and closes; false when the popup is not showing this URL as already saved. */
  submit(title: string, url: string): Promise<boolean>;
  /** Re-shows the bookmark's folder after the picker re-initialises, unless the user picked one. */
  reapply(): Promise<void>;
  /** Repaints the footer for the current existence state. */
  paint(): void;
} {
  let editing: Editing | undefined;
  let present = false;
  let presentUrl = '';
  let deleted: PublicBatchStatus | undefined;
  let deleting = false;
  const copying = () => (document.getElementById('capture-save-another') as HTMLInputElement | null)?.checked === true;
  const card = () => document.getElementById('capture-existing-locations');

  /** Footer, Save label and which body parts show, from what is known about this page. */
  function paint(): void {
    if (!present) {
      delete document.body.dataset.existing;
      host.remove.hidden = true;
      if (document.body.dataset.state !== 'saved') setFooterMode('manual');
      return;
    }
    const copy = copying();
    document.body.dataset.existing = copy ? 'copy' : editing ? 'edit' : 'view';
    host.remove.hidden = !editing || copy;
    setFooterMode(copy ? 'manual' : 'existing');
    if (!host.save.disabled) host.save.textContent = copy ? saveButtonLabel(undefined) : t('common_done', 'Done');
  }

  document.addEventListener('known:existence-shown', (event) => {
    const { url, exact } = (event as CustomEvent<{ url: string; exact: readonly CaptureLocation[] }>).detail;
    void enter(url, exact);
  });
  document.addEventListener('known:existence-cleared', () => { leave(); });
  document.addEventListener('change', (event) => {
    if ((event.target as HTMLElement | null)?.id === 'capture-save-another') paint();
  });
  host.remove.addEventListener('click', () => { void remove(); });

  async function enter(url: string, exact: readonly CaptureLocation[]): Promise<void> {
    if (deleting || deleted) return;
    present = true;
    presentUrl = url;
    const only = exact.length === 1 && exact[0]!.writable ? exact[0]!.nativeId : null;
    const node = only ? (await chrome.bookmarks.get(only).catch(() => []))[0] : undefined;
    if (!node?.url || !node.parentId) {
      editing = undefined; host.pin?.adopt(undefined);
      paintStatusLine({ icon: 'bookmark', tone: 'neutral', text: exact.length > 1
        ? t('capture_savedInLocations', 'Saved in $1 locations', exact.length) : t('common_alreadySaved', 'Already saved') });
      host.folders.setParentVisible(false);
      paint();
      return;
    }
    const ref: AnnotationBookmark = { id: node.id, url, ...(node.dateAdded === undefined ? {} : { dateAdded: node.dateAdded }) };
    const loaded = await loadAnnotation(ref);
    editing = { nativeId: node.id, url, parentId: node.parentId, title: node.title, ref, loaded };
    const shown = card();
    if (shown) shown.dataset.editNativeId = node.id;
    if (host.titleInput.value === host.tabTitle()) host.titleInput.value = node.title;
    if (!host.annotation.touched()) host.annotation.write(loaded);
    host.pin?.adopt(loaded.pinned === true);
    paintStatusLine({ icon: 'bookmark', tone: 'neutral', text: t('common_alreadySaved', 'Already saved'), meta: formatSavedDate(node.dateAdded) });
    host.folders.setParentVisible(true);
    paint();
    repaintExistenceSaveControl();
    if (!host.folders.userPicked()) await host.folders.adopt(node.parentId);
  }

  function leave(): void {
    if (deleting || deleted) return;
    editing = undefined; host.pin?.adopt(undefined);
    present = false;
    const shown = card();
    if (shown) delete shown.dataset.editNativeId;
    if (document.body.dataset.state !== 'saved') paintStatusLine(undefined);
    host.folders.setParentVisible(false);
    paint();
  }

  async function remove(): Promise<void> {
    if (!editing) return;
    host.remove.disabled = true; deleting = true;
    try {
      if (deleted) { await undoPopupBookmark(deleted); window.close(); return; }
      deleted = await removePopupBookmark(editing.nativeId);
      await clearPopupDraft();
      host.remove.textContent = t('common_undo', 'Undo');
      host.setFeedback(t('popup_removedUndo', 'Bookmark removed. Undo is available here or in the library for five minutes.'), '');
    } catch {
      host.setFeedback(t('popup_couldntRemoveBookmark', "Couldn't remove the bookmark. Try again."), 'error');
    } finally { host.remove.disabled = false; deleting = false; }
  }

  return {
    paint,
    async submit(title, url) {
      if (!present || copying() || url !== presentUrl) return false;
      if (deleted) { window.close(); return true; }
      if (!editing) { window.close(); return true; }
      try {
        if (title !== editing.title) await personalBookmarks.update(editing.nativeId, { title });
        const parentId = host.folders.chosenFolderId();
        if (parentId && parentId !== editing.parentId) {
          const policy = host.aiDestinationPolicyDigest?.();
          if (policy) await moveSuggestedBookmark(editing.nativeId, parentId, policy, crypto.randomUUID(), { parentId: editing.parentId, dateAdded: editing.ref.dateAdded, title, url: editing.url });
          else await personalBookmarks.move(editing.nativeId, { parentId });
          await host.commitFolder();
        }
        const annotation = host.annotation.read();
        if (!sameAnnotation(annotation, editing.loaded) || editing.loaded.syncProblem === 'note-conflict') {
          const saved = await saveAnnotation(editing.ref, annotation, editing.loaded);
          if (saved === null) return true;
          if (!saved) throw new Error('annotation_unavailable');
        }
        // After any move, so the worker places the bookmark in the folder it now lives in.
        const pinned = host.pin?.change();
        if (pinned !== undefined && !(await requestPin({ kind: 'known.bookmarks.pin.set', userGesture: true, nativeId: editing.nativeId, pinned })).ok) {
          throw new Error('pin_failed');
        }
        await clearPopupDraft();
        window.close();
      } catch {
        host.setFeedback(t('popup_couldntSaveChanges', "Couldn't save the changes. Try again."), 'error');
      }
      return true;
    },
    async reapply() {
      if (editing && !host.folders.userPicked()) await host.folders.adopt(editing.parentId);
    },
  };
}
