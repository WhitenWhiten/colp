import { element } from './popup-dom.js';
import { loadTagCounts, type Annotation } from './popup-annotations.js';
import type { AnnotationFields } from './popup-edit-existing.js';
import { createTagInput, type TagInput } from './popup-tags.js';
import { annotationSyncHint } from './annotation-sync-hint.js';

export interface PopupFields {
  readonly tags: TagInput;
  readonly noteField: HTMLTextAreaElement;
  readonly annotation: AnnotationFields;
  /** Marks the folder as the AI's pick (muted "AI pick" after the pill). */
  setAiPick(on: boolean): void;
  /** Tags (including a half-typed one) and note for the draft. */
  draft(): { readonly tags: readonly string[]; readonly note: string };
  restore(draft: { readonly tags?: readonly string[]; readonly note?: string }): void;
}

/**
 * The Tags and Note rows. They work without an account: the values are kept in
 * the profile-local annotation store; the worker syncs eligible bookmarks later.
 * `onChange` fires on every user edit so the popup can stage a draft.
 */
export function bindPopupFields(onChange: () => void): PopupFields {
  let touched = false;
  const touch = () => { touched = true; onChange(); };
  const tags = createTagInput({
    field: element('tag-field'), input: element('tag-text') as HTMLInputElement, suggest: element('tag-suggest'), onChange: touch,
  });
  const noteField = element('note-text') as HTMLTextAreaElement;
  const hint = document.createElement('p'); hint.className = 'field-hint'; hint.hidden = true;
  noteField.after(hint);
  const aiMark = element('ai-mark');
  noteField.addEventListener('input', touch);
  void loadTagCounts().then((counts) => { tags.setExisting(counts); });

  const annotation: AnnotationFields = {
    read(): Annotation {
      tags.commitPending();
      return { tags: tags.tags(), note: noteField.value };
    },
    write(next) { tags.setTags(next.tags); noteField.value = next.note;
      hint.textContent = annotationSyncHint(next); hint.hidden = !hint.textContent; },
    touched: () => touched,
  };
  return {
    tags, noteField, annotation,
    setAiPick(on) { aiMark.hidden = !on; },
    draft: () => ({ tags: [...tags.tags(), ...(tags.pending() ? [tags.pending()] : [])], note: noteField.value }),
    restore(saved) {
      if (saved.tags?.length) tags.setTags(saved.tags);
      if (saved.note) noteField.value = saved.note;
      if (saved.tags?.length || saved.note) touched = true;
    },
  };
}
