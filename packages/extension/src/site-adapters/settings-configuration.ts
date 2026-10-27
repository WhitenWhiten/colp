import { createDialog, dialogButton } from '../dialog.js';
import { t } from '../i18n.js';

/** One configuration surface, inline for initial setup and in the shared dialog for subsequent edits. */
export function createSiteConfiguration(discard: () => void) {
  const content = document.getElementById('sync-settings')! as HTMLDetailsElement;
  const slot = document.createElement('div'); content.before(slot);
  const { dialog, body, actions } = createDialog(t('sites_syncSettings', 'Sync settings'), 'sites-config-dialog');
  dialog.id = 'site-settings-dialog'; document.body.append(dialog);
  const cancel = dialogButton(t('common_cancel', 'Cancel')), save = document.getElementById('configure-archive')! as HTMLButtonElement;
  let configured = false, accepted = false, pending = false;
  dialog.addEventListener('cancel', event => { if (pending) event.preventDefault(); });
  cancel.onclick = () => dialog.close(); actions.append(cancel);
  dialog.addEventListener('close', () => { if (!accepted) discard(); accepted = false; });
  return {
    pending(value: boolean) { pending = value; cancel.disabled = value; dialog.setAttribute('aria-busy', String(value)); },
    paint(next: boolean) {
      if (next !== configured) {
        configured = next;
        if (next) { body.append(content); actions.append(save); }
        else { if (dialog.open) { accepted = true; dialog.close(); } slot.append(content); content.querySelector('.confirm-actions')?.append(save); }
      } else if (!next && content.parentElement !== slot) slot.append(content);
      content.hidden = false; content.open = true; content.dataset.configured = String(next);
      const summary = content.querySelector('summary'); if (summary) summary.hidden = true;
    },
    open(target?: 'collections' | 'destination' | 'connection', collectionId?: string) {
      if (configured && !dialog.open) dialog.showModal();
      content.open = true;
      const id = target === 'collections' ? 'archive-collections' : target === 'destination' ? 'archive-root' : 'step-connect';
      const element = document.getElementById(id)!;
      if (collectionId) element.querySelector<HTMLInputElement>(`input[value="${CSS.escape(collectionId)}"]`)?.focus();
      else (element.querySelector<HTMLElement>('button:not([hidden]), input') ?? element).focus();
      element.scrollIntoView({ block: 'nearest' });
    },
    saved() { if (dialog.open) { accepted = true; dialog.close(); } },
    unavailable() { if (!configured) content.hidden = true; },
  };
}
