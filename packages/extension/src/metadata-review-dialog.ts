import { createDialog, dialogButton } from './dialog.js';
import { el } from './library-dom.js';
import { t } from './i18n.js';

/** Keeps the editable draft while showing the value it would replace as inert text. */
export function reviewMetadataDraft(draft: string, saved: string): Promise<{ value: string; choice: 'local' | 'cloud' } | undefined> {
  const { dialog, body, actions } = createDialog(t('metadata_reviewTitle', 'Review both versions'));
  const localLabel = el('label', t('metadata_yourDraft', 'Your draft'), 'form-label');
  const local = el('textarea', undefined, 'field-quiet'); local.value = draft; local.rows = 4; local.readOnly = true;
  const savedLabel = el('label', t('metadata_savedVersion', 'Saved version'), 'form-label');
  const remote = el('textarea', undefined, 'field-quiet'); remote.value = saved; remote.rows = 4; remote.readOnly = true;
  local.id = `${dialog.getAttribute('aria-labelledby')}-draft`; remote.id = `${local.id}-saved`; localLabel.htmlFor = local.id; savedLabel.htmlFor = remote.id;
  body.append(localLabel, local, savedLabel, remote);
  const cancel = dialogButton(t('common_cancel', 'Cancel'));
  const cloud = dialogButton(t('metadata_useSaved', 'Use saved version'), 'secondary');
  const keep = dialogButton(t('metadata_useDraft', 'Use my draft'), 'primary');
  actions.append(cancel, cloud, keep); document.body.append(dialog); dialog.showModal(); local.focus();
  return new Promise(resolve => {
    let choice: { value: string; choice: 'local' | 'cloud' } | undefined;
    cancel.onclick = () => dialog.close();
    cloud.onclick = () => { choice = { value: saved, choice: 'cloud' }; dialog.close(); };
    keep.onclick = () => { choice = { value: local.value, choice: 'local' }; dialog.close(); };
    dialog.addEventListener('close', () => { dialog.remove(); resolve(choice); }, { once: true });
  });
}
