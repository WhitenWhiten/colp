import {
  annotationForCaptureStart, createBookmarkAnnotationStore, normalizeAnnotationNote, normalizeAnnotationTags,
  type AnnotatedBookmark, type BookmarkAnnotationStore,
  annotationSyncProblem, type AnnotationSyncProblem,
} from './bookmark-annotation-store.js';
import { sameTags } from './local-metadata-state.js';
import { reviewMetadataDraft } from './metadata-review-dialog.js';

export { ANNOTATION_LIMITS, normalizeAnnotationTags, normalizeAnnotationEditTags } from './bookmark-annotation-store.js';

/**
 * Every popup read or write of a bookmark's own tags and note goes through
 * this module, so the popup never depends on how they are stored. Tags and
 * notes persist locally and work without an account; the worker syncs eligible fields. A
 * failing store never blocks a save: reads come back empty and writes report
 * false.
 */
export type AnnotationBookmark = AnnotatedBookmark;
export interface Annotation { readonly tags: readonly string[]; readonly note: string;
  readonly syncProblem?: AnnotationSyncProblem; readonly sourceTags?: readonly string[];
  readonly cloudNote?: string | null; readonly noteVersion?: number; readonly noteRevision?: string;
  /** Read only here: pins change through the worker, which also places the bookmark. */
  readonly pinned?: true }
export interface TagCount { readonly tag: string; readonly count: number }

/** The slice of the store the popup uses; tests provide their own. */
export type AnnotationStore = Pick<BookmarkAnnotationStore, 'get' | 'save' | 'tagCounts' | 'close'> & Partial<Pick<BookmarkAnnotationStore, 'resolveNoteConflict'>>;

let store: AnnotationStore | undefined;
let injected = false;
const open = (): AnnotationStore => (store ??= createBookmarkAnnotationStore());

/** Tests inject a fake store; pass undefined to go back to the real one. */
export function setAnnotationStore(next: AnnotationStore | undefined): void {
  store = next;
  injected = next !== undefined;
}

/** Releases the database connection (the popup is closing). */
export function closeAnnotationStore(): void {
  if (injected) return;
  store?.close();
  store = undefined;
}

/** True when there is anything worth persisting. */
export function hasAnnotation(annotation: Annotation): boolean {
  return normalizeAnnotationTags(annotation.tags).length > 0 || normalizeAnnotationNote(annotation.note) !== null;
}

/** Tag order is immaterial; case and individual cloud members retain their identity. */
export function sameAnnotation(a: Annotation, b: Annotation): boolean {
  return sameTags(a.tags, b.tags) && (normalizeAnnotationNote(a.note) ?? '') === (normalizeAnnotationNote(b.note) ?? '');
}

/** The bookmark's saved tags and note; empty when there are none or the store is unavailable. */
export async function loadAnnotation(bookmark: AnnotationBookmark, reader: Pick<AnnotationStore, 'get'> = open()): Promise<Annotation> {
  try {
    const found = await reader.get(bookmark);
    const syncProblem = annotationSyncProblem(found);
    return found ? { tags: found.tags, note: found.note ?? '', ...(syncProblem ? { syncProblem } : {}), ...(found.pinned ? { pinned: true as const } : {}),
      ...(syncProblem === 'note-conflict' && found.noteSync?.remote ? { cloudNote: found.noteSync.remote.value,
        noteVersion: found.noteSync.version, noteRevision: found.noteSync.remote.revision } : {}) } : { tags: [], note: '' };
  } catch { return { tags: [], note: '' }; }
}

/** Persists tags and note, retaining a dirty clear until sync confirms it. */
export async function saveAnnotation(bookmark: AnnotationBookmark, annotation: Annotation, base?: Annotation, storage: AnnotationStore = open()): Promise<boolean | null> {
  try {
    let note = annotation.note;
    const latest = await loadAnnotation(bookmark, storage);
    const conflict = latest.syncProblem === 'note-conflict';
    if (conflict || base && normalizeAnnotationNote(base.note) !== normalizeAnnotationNote(latest.note)
      && normalizeAnnotationNote(note) !== normalizeAnnotationNote(base.note) && normalizeAnnotationNote(note) !== normalizeAnnotationNote(latest.note)) {
      const choice = await reviewMetadataDraft(note, conflict ? latest.cloudNote ?? '' : latest.note);
      if (!choice) return null;
      note = choice.value;
      if (conflict) {
        if (latest.noteVersion === undefined || !latest.noteRevision || !storage.resolveNoteConflict) return false;
        await storage.resolveNoteConflict!(bookmark, { version: latest.noteVersion, revision: latest.noteRevision }, note, choice.choice === 'cloud');
      }
      base = { ...base ?? latest, note: conflict ? (await loadAnnotation(bookmark, storage)).note : latest.note };
    }
    const input = { tags: annotation.tags, note };
    await storage.save(bookmark, input, { preserveTags: true, ...(base ? { base: { tags: base.tags, note: base.note,
      ...(base.sourceTags ? { sourceTags: base.sourceTags } : {}) } } : {}) });
    return true;
  } catch { return false; }
}

/** Existing tags, most used first, for autocomplete. */
export async function loadTagCounts(): Promise<readonly TagCount[]> {
  try { return await open().tagCounts(); } catch { return []; }
}

/** What `known.capture.start` carries, or undefined when there is nothing to persist. */
export function captureAnnotation(annotation: Annotation): { readonly tags: readonly string[]; readonly note: string | null } | undefined {
  try { return annotationForCaptureStart({ tags: annotation.tags, note: annotation.note }, { preserveTags: true }); } catch { return undefined; }
}
