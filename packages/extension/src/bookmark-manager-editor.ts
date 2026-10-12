import { createDialog, dialogButton } from './dialog.js';
import { t } from './i18n.js';
import { normalizedUrl, type NativeNode } from './bookmark-manager-dom.js';
import type { ManagerAnnotations } from './bookmark-manager-annotations.js';
import { createFolderDescriptionStore, FOLDER_DESCRIPTION_MAX_BYTES } from './folder-description-store.js';
import { notifyFolderDescriptionChanged } from './folder-description-native.js';
import { createAnnotationFields } from './library-annotation-fields.js';
import { el } from './library-dom.js';
import { createFolderPicker, folderChoices } from './library-folder-picker.js';
import { loadAnnotation } from './popup-annotations.js';
import { reviewMetadataDraft } from './metadata-review-dialog.js';
import type { FolderDescriptionRecord } from './folder-description-store.js';

export function managerFolderDescriptionField(value = '') {
  const label = document.createElement('label'); label.className = 'mgr-description-field';
  const name = document.createElement('span'); name.textContent = t('manager_folderDescription', 'Description (optional)');
  const input = document.createElement('textarea'); input.value = value; input.rows = 3; input.maxLength = 20_000; input.className = 'field-quiet';
  input.placeholder = t('manager_folderDescriptionHint', 'What belongs in this folder? Helps folder suggestions.');
  label.append(name, input); return { label, input };
}

export interface EditorHost {
  readonly api: typeof chrome.bookmarks;
  readonly annotations: ManagerAnnotations;
  readonly root: () => NativeNode | undefined;
  /** Folders a bookmark must not be filed into (read-only subscription folders). */
  readonly excluded: () => Promise<ReadonlySet<string>>;
  readonly refresh: () => Promise<void>;
  readonly feedback: (copy: string, tone: 'ok' | 'error') => void;
}

function field(label: string, control: HTMLElement): HTMLElement {
  const group = el('div', undefined, 'form-field');
  const caption = el('label', label, 'form-label');
  if (control.id) (caption as HTMLLabelElement).htmlFor = control.id;
  group.append(caption, control);
  return group;
}

function textInput(value: string, id: string): HTMLInputElement {
  const input = el('input', undefined, 'field-quiet'); input.type = 'text'; input.id = id; input.value = value; input.autocomplete = 'off';
  return input;
}

function openEditorDialog(title: string, trigger?: HTMLElement | null) {
  const { dialog, body, actions } = createDialog(title, 'mgr-editor');
  const cancel = dialogButton(t('common_cancel', 'Cancel'));
  const save = dialogButton(t('common_save', 'Save'), 'primary'); save.type = 'submit';
  const form = el('form'); form.className = 'mgr-editor-form';
  const error = el('p', undefined, 'form-error'); error.setAttribute('role', 'alert'); error.hidden = true;
  cancel.addEventListener('click', () => dialog.close());
  actions.append(cancel, save);
  // The dialog's own rows live in a form so Enter in a text field saves.
  dialog.replaceChildren(dialog.querySelector('h3')!, form);
  form.append(body, error, actions);
  dialog.addEventListener('close', () => { dialog.remove(); if (trigger?.isConnected) trigger.focus(); });
  document.body.append(dialog); dialog.showModal();
  return { dialog, body, form, save, cancel, error, fail(copy: string) { error.textContent = copy; error.hidden = false; save.disabled = false; } };
}

/** Edit bookmark: title, address, folder, tags and note in one dialog. Tags and note never need an account. */
export function openBookmarkEditor(node: NativeNode, host: EditorHost, trigger?: HTMLElement | null): void {
  const view = openEditorDialog(t('manager_editBookmark', 'Edit bookmark'), trigger);
  const id = `mgr-edit-${crypto.randomUUID()}`;
  const name = textInput(node.title, `${id}-title`), address = textInput(node.url ?? '', `${id}-url`);
  address.inputMode = 'url'; address.spellcheck = false;
  const top = host.root();
  const picker = createFolderPicker({ choices: top ? folderChoices([top]) : [], value: node.parentId ?? '', label: t('sync_folder', 'Folder') });
  void host.excluded().then((hidden) => { if (top && view.dialog.isConnected) picker.setChoices(folderChoices([top], { exclude: hidden })); }).catch(() => undefined);
  const fields = createAnnotationFields();
  let annotationBase: import('./popup-annotations.js').Annotation | undefined;
  const folderField = el('div', undefined, 'form-field'); folderField.append(el('span', t('sync_folder', 'Folder'), 'form-label'), picker.element);
  view.body.append(field(t('manager_title', 'Title'), name), field(t('common_url', 'URL'), address), folderField, fields.element);
  const reference = { id: node.id, ...(node.url === undefined ? {} : { url: node.url }), ...(node.dateAdded === undefined ? {} : { dateAdded: node.dateAdded }) };
  view.save.disabled = true;
  void loadAnnotation(reference).then((saved) => { if (view.dialog.isConnected) { annotationBase = saved; fields.write(saved); view.save.disabled = false; } });
  name.focus();
  view.form.addEventListener('submit', (event) => {
    event.preventDefault();
    const title = name.value.trim(), url = normalizedUrl(address.value);
    if (!url) { view.fail(t('manager_enterValidHttpS', 'Enter a valid http(s) address.')); address.focus(); return; }
    view.save.disabled = true; view.error.hidden = true;
    void (async () => {
      const [current] = await host.api.get(node.id);
      if (!current || current.unmodifiable || current.url === undefined) throw new Error('bookmark_unavailable');
      const changes: { title?: string; url?: string } = {};
      if (current.title !== title) changes.title = title;
      if (current.url !== url) changes.url = url;
      if (Object.keys(changes).length) await host.api.update(node.id, changes);
      const parentId = picker.value();
      if (parentId && parentId !== current.parentId) await host.api.move(node.id, { parentId });
      if (fields.changed() || annotationBase?.syncProblem === 'note-conflict') {
        const annotation = fields.read();
        const saved = await host.annotations.save({ ...node, title, url }, { tags: annotation.tags, note: annotation.note }, annotationBase);
        if (saved === null) { view.save.disabled = false; return; }
        if (!saved) throw new Error('annotation_unavailable');
        fields.write(annotation);
      }
      view.dialog.close();
      host.feedback(t('manager_bookmarkSaved', 'Bookmark saved.'), 'ok');
      await host.refresh();
    })().catch((error: unknown) => {
      const noteOnly = error instanceof Error && error.message === 'annotation_unavailable';
      view.fail(noteOnly ? t('manager_annotationNotSaved', 'The bookmark was saved, but its tags and note could not be. Try again.') : t('manager_itemCouldNotSaved', 'The changes could not be saved. Try again.'));
      void host.refresh();
    });
  });
}

/** Edit folder: name and description (the description helps automatic classification). */
export function openFolderEditor(node: NativeNode, host: EditorHost, trigger?: HTMLElement | null): void {
  const view = openEditorDialog(t('manager_editFolder', 'Edit folder'), trigger);
  const id = `mgr-edit-${crypto.randomUUID()}`;
  const name = textInput(node.title, `${id}-name`);
  name.setAttribute('aria-label', t('manager_rename', 'Rename $1', node.title || t('sync_folder', 'Folder')));
  const description = managerFolderDescriptionField();
  description.input.id = `${id}-description`; description.label.htmlFor = description.input.id;
  description.input.disabled = true; view.save.disabled = true;
  view.body.append(field(t('common_name', 'Name'), name), description.label);
  const store = createFolderDescriptionStore();
  let descriptionBase: FolderDescriptionRecord | null = null;
  void store.get(node).then((record) => {
    if (!view.dialog.isConnected) return;
    descriptionBase = record;
    description.input.value = record?.description ?? ''; description.input.disabled = false; view.save.disabled = false;
    if (record?.reviewVersion !== undefined) view.fail(t('metadata_descriptionConflict', 'This browser and Know-N have different descriptions. Your draft is kept. Review it before saving.'));
  }, () => host.feedback(t('manager_descriptionUnavailable', 'The folder description could not be read. Try again.'), 'error')).finally(() => store.close());
  name.focus();
  view.form.addEventListener('submit', (event) => {
    event.preventDefault();
    const title = name.value.trim(); if (!title) { name.focus(); return; }
    const value = description.input.value.trim() || null;
    if (value && new TextEncoder().encode(value).length > FOLDER_DESCRIPTION_MAX_BYTES) {
      view.fail(t('manager_descriptionTooLong', 'The folder description is too long.')); description.input.focus(); return;
    }
    view.save.disabled = true; view.error.hidden = true;
    void (async () => {
      const [current] = await host.api.get(node.id);
      if (!current || current.unmodifiable || current.url !== undefined) throw new Error('folder_unavailable');
      if (current.title !== title) await host.api.update(node.id, { title });
      const descriptions = createFolderDescriptionStore();
      try {
        const fresh = await descriptions.get(current);
        const reviewing = fresh?.reviewVersion !== undefined && fresh.reviewVersion >= fresh.version;
        const edited = value !== (descriptionBase?.description ?? null);
        let draft = !edited && !reviewing ? fresh?.description ?? null : value;
        if (reviewing || edited && (fresh?.version ?? 0) !== (descriptionBase?.version ?? 0) && draft !== fresh?.description) {
          const choice = await reviewMetadataDraft(draft ?? '', reviewing ? fresh?.remote?.description ?? '' : fresh?.description ?? '');
          if (!choice) { view.save.disabled = false; return; }
          draft = choice.value || null;
        }
        await descriptions.save(current, draft, fresh?.version ?? 0, fresh?.remote?.revision);
      } finally { descriptions.close(); }
      void notifyFolderDescriptionChanged(node.id);
      view.dialog.close();
      host.feedback(t('manager_folderSaved', 'Folder saved.'), 'ok');
      await host.refresh();
    })().catch(() => view.fail(t('manager_itemCouldNotSaved', 'The changes could not be saved. Try again.')));
  });
}
