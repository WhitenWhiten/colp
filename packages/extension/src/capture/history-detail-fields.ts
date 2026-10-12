import type { CaptureTask } from './contracts.js';
import { createCaptureCorrection, decisionTags, isEditConflict } from './editor.js';
import { exclusionIds } from '../bookmark-subscriptions/guards.js';
import { createAnnotationFields } from '../library-annotation-fields.js';
import { button, el, inlineAlert } from '../library-dom.js';
import { createFolderPicker, folderChoices } from '../library-folder-picker.js';
import { createIcon } from '../icons.js';
import { normalizeAnnotationEditTags, loadAnnotation, saveAnnotation, type Annotation, type AnnotationBookmark } from '../popup-annotations.js';
import { t } from '../i18n.js';

/**
 * Where this saved page lives and what the user wrote about it. The folder
 * keeps the correction semantics of the old editor (one durable command per
 * choice, a rating sent first when the AI's pick is overruled); tags and note
 * go to the local annotation store, so they work without an account.
 */
export function createDetailFields(task: CaptureTask, context: { readonly editable: boolean; readonly onChanged: () => void }): HTMLElement {
  const card = el('div', undefined, 'set-card detail-fields');
  const folderRow = el('div', undefined, 'set-row set-row--stack');
  folderRow.append(el('p', t('sync_folder', 'Folder'), 'set-row-title'));
  const staticPath = task.localLocation?.path.join(' › ');
  const where = el('span', undefined, 'set-row-value');
  where.append(createIcon('folder', 14), el('span', staticPath ?? t('capture_localLocationHasNot', 'Local location has not been confirmed.')));
  folderRow.append(where);
  card.append(folderRow);
  if (!context.editable || !task.nativeId) return card;

  const nativeId = task.nativeId;
  const fields = createAnnotationFields({ onChange: () => paintFooter() });
  const fieldsRow = el('div', undefined, 'set-row set-row--stack'); fieldsRow.append(fields.element); fieldsRow.hidden = true;
  const foot = el('div', undefined, 'card-foot detail-foot'); foot.hidden = true;
  const status = el('p', undefined, 'grow'); status.setAttribute('role', 'status');
  const discard = button(t('common_cancel', 'Cancel'), 'btn btn-ghost btn-sm');
  const save = button(t('common_save', 'Save'), 'btn btn-primary btn-sm');
  foot.append(status, discard, save);
  card.append(fieldsRow, foot);

  const correction = createCaptureCorrection(task);
  let baseline: Annotation = { tags: [], note: '' };
  let picker: ReturnType<typeof createFolderPicker> | undefined, original = '', reference: AnnotationBookmark | undefined, busy = false, negativeSent = false, dirtyFolder = false;

  if (correction.stuck) {
    const release = button(t('capture_discardUnconfirmedCorrection', 'Discard unconfirmed correction'), 'btn btn-ghost btn-sm');
    const alert = inlineAlert('warning', t('history_correctionUnconfirmed', 'The last folder change was not confirmed. Discard it before choosing a different folder.'), release);
    card.prepend(alert);
    release.addEventListener('click', () => {
      release.disabled = true;
      void correction.abandon().then(() => { alert.remove(); setStatus(t('capture_previousCorrectionDiscardedSave', 'Previous correction discarded. Save again to send the new correction.')); })
        .catch(() => { release.disabled = false; setStatus(t('capture_previousCorrectionCouldNot', 'The previous correction could not be discarded. Retry or reopen the editor.')); });
    });
  }

  function setStatus(text: string): void { status.textContent = text; foot.hidden = !text && !isDirty(); }
  function isDirty(): boolean { return dirtyFolder || fields.changed() || baseline.syncProblem === 'note-conflict'; }
  function paintFooter(): void {
    dirtyFolder = Boolean(picker) && picker!.value() !== original;
    const dirty = isDirty();
    foot.hidden = !dirty && !status.textContent;
    save.hidden = discard.hidden = !dirty; card.toggleAttribute('data-dirty', dirty);
    if (dirty && status.dataset.kind === 'saved') { status.textContent = ''; delete status.dataset.kind; }
  }

  async function load(): Promise<void> {
    const [node] = await chrome.bookmarks.get(nativeId).catch(() => []);
    if (!node?.parentId) return;
    original = node.parentId;
    reference = { id: nativeId, url: task.url, ...(node.dateAdded === undefined ? {} : { dateAdded: node.dateAdded }) };
    const [tree, excluded, saved] = await Promise.all([chrome.bookmarks.getTree(), exclusionIds().catch(() => new Set<string>()), loadAnnotation(reference)]);
    picker = createFolderPicker({ choices: folderChoices(tree, { exclude: excluded }), value: original, label: t('sync_folder', 'Folder'), onChange: () => paintFooter() });
    where.replaceWith(picker.element);
    baseline = { ...saved, sourceTags: saved.tags, tags: normalizeAnnotationEditTags([...saved.tags, ...decisionTags(task)], saved.tags) };
    fields.write(baseline);
    fieldsRow.hidden = false;
    paintFooter();
  }
  void load().catch(() => undefined);

  discard.addEventListener('click', () => {
    picker?.setValue(original);
    fields.write(baseline);
    setStatus(''); paintFooter();
  });

  save.addEventListener('click', () => { void commit(); });
  async function commit(): Promise<void> {
    if (busy || !picker || !reference) return;
    busy = true; save.disabled = discard.disabled = true; setStatus('');
    try {
      if (fields.changed() || baseline.syncProblem === 'note-conflict') {
        const next = fields.read();
        const saved = await saveAnnotation(reference, next, baseline);
        if (saved === null) return;
        if (!saved) { setStatus(t('history_tagsNotSaved', 'Tags and note could not be saved. Try again.')); return; }
        baseline = await loadAnnotation(reference); fields.write(baseline);
      }
      const target = picker.value();
      if (target !== original) {
        try {
          if (task.appliedRevision && !negativeSent) {
            const rated = await chrome.runtime.sendMessage({ kind: 'known.capture.feedback', captureId: task.captureId, eventId: crypto.randomUUID(),
              feedback: 'explicit_negative', nodeRevision: task.appliedRevision }) as { ok?: boolean };
            if (!rated?.ok) throw new Error('capture_feedback_failed');
            negativeSent = true;
          }
          await correction.submit(target, original, fields.read().tags);
          original = target;
          context.onChanged();
        } catch (error) {
          setStatus(isEditConflict(error) ? t('capture_bookmarkChangedCloseReopen', 'This bookmark changed. Close and reopen the editor to choose again.')
            : t('capture_updateNotConfirmedRetry', 'The update is not confirmed. Retry this same correction; your draft is preserved.'));
          return;
        }
      }
      paintFooter();
      status.dataset.kind = 'saved';
      status.textContent = t('history_saved', 'Saved.'); foot.hidden = false;
      save.hidden = discard.hidden = true;
    } finally { busy = false; save.disabled = discard.disabled = false; }
  }
  return card;
}
