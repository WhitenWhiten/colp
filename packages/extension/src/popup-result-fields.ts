import type { CaptureTask } from './capture/contracts.js';
import { element, setHidden } from './popup-dom.js';
import { loadAnnotation, normalizeAnnotationEditTags, sameAnnotation, type Annotation, type AnnotationBookmark } from './popup-annotations.js';
import type { PopupFields } from './popup-fields.js';
import { paintFavicon, urlSummary } from './popup-shell.js';
import type { bindSaveFolderPicker } from './save-folder-ui.js';
import type { SavedPinToggle } from './popup-pin.js';

type FolderPicker = ReturnType<typeof bindSaveFolderPicker>;

/** The one native bookmark this result is about: the one it saved, or the single copy that already existed. */
export function resultBookmarkId(task: CaptureTask): string | null {
  if (task.nativeId) return task.nativeId;
  const only = task.disposition === 'existing' && task.existence?.exact.length === 1 ? task.existence.exact[0] : undefined;
  return only?.writable && only.nativeId ? only.nativeId : null;
}

/** The tags the cloud decision put on this bookmark. */
export { decisionTags } from './capture/editor.js';
import { decisionTags } from './capture/editor.js';

/** Tags the AI picked under the Suggest tag mode: offered as chips, added only when clicked. */
export const offeredTags = (task: CaptureTask): readonly string[] => task.local?.suggestedTags ?? task.automatic?.decision?.suggestedTags ?? [];

/**
 * Keeps the shared page block and Folder / Tags / Note rows in step with the
 * automatic result's task. Polling repaints the task every moment, so this only
 * writes what the user has not touched: the title, and tags and note, are
 * filled once and then belong to the user. The folder pill follows the
 * bookmark (the AI moves it) until the user picks one themselves.
 */
export function bindResultFields(shell: { readonly folders: FolderPicker; readonly fields: PopupFields; readonly preview: boolean; readonly pin?: SavedPinToggle }) {
  const title = element('tab-title') as HTMLTextAreaElement;
  const urlDisplay = element('tab-url-display') as HTMLButtonElement;
  const rows = element('pp-fields');
  const folderName = element('dest-folder');
  let titleEdited = false, folderKey = '', offeredKey = '', annotationFor = '', baseline: Annotation = { tags: [], note: '' }, corrected = false, suggested = false;
  let ref: AnnotationBookmark | undefined;
  let followedId: string | null = null;
  title.addEventListener('input', () => { titleEdited = true; });
  urlDisplay.disabled = true;
  // Whoever moves the bookmark (the AI, sync, the user in the bookmark manager), the pill names where it is now.
  if (!shell.preview && typeof chrome.bookmarks?.onMoved?.addListener === 'function') {
    chrome.bookmarks.onMoved.addListener((id, info) => {
      if (id === followedId && !shell.folders.userPicked()) void shell.folders.adopt(info.parentId);
    });
  }

  async function followFolder(task: CaptureTask): Promise<void> {
    // The AI's move reaches the browser bookmark after the decision is applied (a cloud result moves it when
    // sync lands), so the sync state and the reported location are part of "the folder may have changed".
    const key = [resultBookmarkId(task), task.classification, task.appliedRevision, task.local?.folderNativeId, task.disposition,
      task.sync, task.localLocation?.path.join('\u0000')].join('|');
    if (key === folderKey || shell.folders.userPicked() || suggested && !task.local && task.sync !== 'confirmed') return;
    folderKey = key;
    shell.folders.setParentVisible(task.disposition === 'existing');
    if (shell.preview) { folderName.textContent = task.localLocation?.path.at(-1) ?? ''; return; }
    const id = resultBookmarkId(task);
    followedId = id;
    const [node] = id ? await chrome.bookmarks.get(id).catch(() => []) : [];
    if (node?.parentId && !shell.folders.userPicked() && (!suggested || task.local || task.sync === 'confirmed')) await shell.folders.adopt(node.parentId);
  }

  /** Tags and note: the saved ones for this bookmark plus the decision's tags, filled once while untouched. */
  async function loadAnnotationOnce(task: CaptureTask): Promise<void> {
    const wanted = resultBookmarkId(task) ?? '';
    if (!wanted || annotationFor === wanted) return;
    annotationFor = wanted;
    const [node] = shell.preview ? [] : await chrome.bookmarks.get(wanted).catch(() => []);
    ref = { id: wanted, url: task.url, ...(node?.dateAdded === undefined ? {} : { dateAdded: node.dateAdded }) };
    const saved = shell.preview ? { tags: [], note: '' } : await loadAnnotation(ref);
    baseline = { ...saved, sourceTags: saved.tags, tags: normalizeAnnotationEditTags([...saved.tags, ...decisionTags(task)], saved.tags) };
    if (!shell.fields.annotation.touched()) shell.fields.annotation.write(baseline);
    shell.pin?.adopt(saved.pinned === true);
  }

  return {
    async sync(task: CaptureTask): Promise<void> {
      if (!titleEdited && title.value !== task.title) title.value = task.title;
      urlDisplay.textContent = urlSummary(task.url);
      urlDisplay.title = task.url;
      paintFavicon(task.favIconUrl);
      const ready = (task.save === 'local-saved' || task.disposition === 'existing') && resultBookmarkId(task) !== null;
      setHidden(rows, !ready);
      if (!ready) return;
      shell.fields.setAiPick((suggested || task.classification === 'applied' && !corrected) && !shell.folders.userPicked());
      await followFolder(task);
      await loadAnnotationOnce(task);
      const offered = offeredTags(task), key = offered.join('\u0000');
      if (key !== offeredKey) { offeredKey = key; shell.fields.tags.setAiSuggestions(offered); }
    },
    /** A folder correction was sent: the pick is the user's now, not the AI's. */
    markCorrected(): void { corrected = true; suggested = false; shell.fields.setAiPick(false); },
    /** A confirmed alternative is still an AI pick, while Done must not rate the original decision positively. */
    markSuggested(): void { corrected = true; suggested = true; shell.fields.setAiPick(true); },
    wasCorrected: () => corrected,
    /** The title if the user changed it. */
    editedTitle(task: CaptureTask): string | undefined {
      const next = title.value.trim();
      return titleEdited && next && next !== task.title ? next : undefined;
    },
    /** Tags and note when the user changed them since they were filled in. */
    editedAnnotation(): { readonly bookmark: AnnotationBookmark; readonly annotation: Annotation; readonly base?: Annotation } | undefined {
      if (!ref || !shell.fields.annotation.touched()) return undefined;
      const annotation = shell.fields.annotation.read();
      return sameAnnotation(annotation, baseline) ? undefined : { bookmark: ref, annotation, base: baseline };
    },
  };
}
