import { t } from './i18n.js';
import { el } from './library-dom.js';
import { loadTagCounts, sameAnnotation, type Annotation } from './popup-annotations.js';
import { createTagInput, type TagInput } from './popup-tags.js';
import { annotationSyncHint } from './annotation-sync-hint.js';

export interface AnnotationFields {
  /** Tags and Note rows, ready to append to a dialog body or a settings card. */
  readonly element: HTMLElement;
  readonly tags: TagInput;
  readonly note: HTMLTextAreaElement;
  /** What is in the fields now, including a half-typed tag. */
  read(): Annotation;
  write(annotation: Annotation): void;
  /** True when the fields differ from the last written value. */
  changed(): boolean;
}

/**
 * Tags (`.tag-input`) and Note, with exactly the popup's behaviour: Enter,
 * comma or Tab commits a tag, a comma splits, Backspace removes the last chip,
 * and suggestions come from the tags used elsewhere. Used by the Edit bookmark
 * dialog and the History detail; the caller decides where the result is saved.
 */
export function createAnnotationFields(options: { readonly onChange?: () => void; readonly labelled?: boolean } = {}): AnnotationFields {
  const id = crypto.randomUUID();
  const root = el('div', undefined, 'annotation-fields');
  const tagLabel = el('label', t('common_tags', 'Tags'), 'form-label'); tagLabel.htmlFor = `${id}-tags`;
  const field = el('div', undefined, 'field-quiet tag-input');
  const text = el('input'); text.id = `${id}-tags`; text.type = 'text'; text.autocomplete = 'off'; text.spellcheck = false;
  text.placeholder = t('popup_addTags', 'Add tags…');
  field.append(text);
  const suggest = el('div', undefined, 'tag-suggest'); suggest.setAttribute('role', 'group');
  suggest.setAttribute('aria-label', t('popup_suggestedTags', 'Suggested tags')); suggest.hidden = true;
  const noteLabel = el('label', t('common_note', 'Note'), 'form-label'); noteLabel.htmlFor = `${id}-note`;
  const note = el('textarea', undefined, 'field-quiet'); note.id = `${id}-note`; note.rows = 3;
  note.placeholder = t('popup_addNote', 'Add a note…');
  const tagsGroup = el('div', undefined, 'form-field'); tagsGroup.append(tagLabel, field, suggest);
  const noteGroup = el('div', undefined, 'form-field'); noteGroup.append(noteLabel, note);
  const hint = el('p', undefined, 'field-hint'); hint.hidden = true; noteGroup.append(hint);
  root.append(tagsGroup, noteGroup);

  let baseline: Annotation = { tags: [], note: '' };
  const tags = createTagInput({ field, input: text, suggest, onChange: () => options.onChange?.() });
  note.addEventListener('input', () => options.onChange?.());
  void loadTagCounts().then((counts) => { tags.setExisting(counts); });
  const read = (): Annotation => { tags.commitPending(); return { tags: tags.tags(), note: note.value }; };
  return {
    element: root, tags, note, read,
    write(annotation) { baseline = annotation; tags.setTags(annotation.tags); note.value = annotation.note;
      hint.textContent = annotationSyncHint(annotation); hint.hidden = !hint.textContent; },
    changed: () => !sameAnnotation(read(), baseline),
  };
}
