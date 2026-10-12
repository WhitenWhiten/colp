import { createDialog, dialogButton } from './dialog.js';
import { createIcon } from './icons.js';
import { t } from './i18n.js';
import { el } from './library-dom.js';
import { showToast } from './toast.js';
import type { OrganizeChoice, OrganizeRequest, OrganizeResponse } from './bookmark-organizer.js';

const request = (message: OrganizeRequest) => chrome.runtime.sendMessage(message) as Promise<OrganizeResponse>;

function errorCopy(error: string): string {
  if (error === 'busy') return t('organize_busy', 'Another bookmark operation is running. Try again shortly.');
  if (error === 'tree_changed') return t('organize_treeChanged', 'The folders changed during organization. Reopen this panel and try again.');
  if (error === 'permission_required') return t('common_allowBookmarkAccess', 'Allow bookmark access');
  return t('organize_failed', 'Could not finish organizing bookmarks. Try again.');
}

export function bindBookmarkOrganizer(onApplied: () => Promise<void>): void {
  const trigger = document.getElementById('manager-organize') as HTMLButtonElement;
  let open: HTMLDialogElement | undefined;
  trigger.addEventListener('click', () => {
    if (open) { open.focus(); return; }
    const { dialog, body, actions } = createDialog(t('organize_title', 'Organize bookmarks'), 'mgr-batch');
    open = dialog; dialog.id = 'manager-organize-dialog';
    body.append(
      el('p', t('organize_scopeHint', 'Choose root paths to put their bookmarks after folders. Choose first-level folders to organize their contents and all deeper folders.'), 'mgr-batch-warning'),
      el('p', t('organize_orderHint', 'Only folders move, using the fewest moves. The relative order of bookmarks and of folders stays the same.'), 'mgr-batch-hint'),
      el('p', t('organize_readonlyHint', 'Read-only folders and subscription content are skipped. This selection does not change your automatic sorting setting.'), 'mgr-batch-hint'),
    );
    const list = el('div', undefined, 'mgr-batch-items'); list.id = 'manager-organize-paths';
    const status = el('p', t('organize_loading', 'Reading bookmark folders…'), 'mgr-batch-hint');
    status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    const error = el('div', undefined, 'inline-alert'); error.dataset.tone = 'error';
    error.setAttribute('role', 'alert'); error.hidden = true;
    const errorBody = el('div', undefined, 'inline-alert-body');
    error.append(createIcon('alert', 16), errorBody);
    body.append(list, status, error);
    const cancel = dialogButton(t('common_cancel', 'Cancel'));
    const apply = dialogButton(t('common_apply', 'Apply'), 'primary');
    apply.id = 'manager-organize-apply'; apply.disabled = true;
    actions.append(cancel, apply);
    let busy = false;
    const selected = new Set<string>();
    const controls: HTMLInputElement[] = [];
    const updateSelection = () => {
      apply.disabled = busy || selected.size === 0;
      status.textContent = t('organize_selected', '$1 paths selected', selected.size);
    };
    const fail = (response: Extract<OrganizeResponse, { ok: false }>) => {
      errorBody.replaceChildren(el('p', errorCopy(response.error)));
      if (response.moved) errorBody.append(el('p', t('organize_partial', '$1 folder moves completed. Completed moves will not be repeated on retry.', response.moved)));
      error.hidden = false;
      updateSelection();
      if (response.error === 'tree_changed') apply.disabled = true;
    };
    cancel.addEventListener('click', () => dialog.close());
    dialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
    dialog.addEventListener('close', () => {
      dialog.remove(); open = undefined;
      if (trigger.isConnected) trigger.focus();
    });
    apply.addEventListener('click', () => {
      if (busy || !selected.size) return;
      busy = true; apply.disabled = true; cancel.disabled = true; error.hidden = true;
      controls.forEach(box => { box.disabled = true; });
      status.textContent = t('organize_applying', 'Organizing selected paths…');
      void request({ kind: 'known.bookmarks.organize.apply', userGesture: true, nativeIds: [...selected] })
        .catch((): OrganizeResponse => ({ ok: false, error: 'organize_failed', moved: 0 }))
        .then(response => {
          busy = false; cancel.disabled = false; controls.forEach(box => { box.disabled = false; });
          if (!response.ok) { fail(response); return; }
          if (!('moved' in response)) { fail({ ok: false, error: 'organize_failed', moved: 0 }); return; }
          dialog.close();
          showToast(t('organize_done', 'Bookmarks organized with $1 folder moves.', response.moved), 'ok', { announce: true });
          void onApplied().catch(() => undefined);
        });
    });
    document.body.append(dialog); dialog.showModal(); cancel.focus();
    void request({ kind: 'known.bookmarks.organize.preview' })
      .catch((): OrganizeResponse => ({ ok: false, error: 'organize_failed', moved: 0 }))
      .then(response => {
        if (!dialog.isConnected) return;
        if (!response.ok) { fail(response); return; }
        if (!('choices' in response)) return;
        for (const choice of response.choices) {
          const box = choiceRow(choice, list);
          controls.push(box); selected.add(choice.nativeId);
          box.addEventListener('change', () => {
            if (box.checked) selected.add(choice.nativeId); else selected.delete(choice.nativeId);
            updateSelection();
          });
        }
        updateSelection();
        if (!response.choices.length) status.textContent = t('organize_noFolders', 'No writable bookmark folders are available.');
      });
  });
}

function choiceRow(choice: OrganizeChoice, list: HTMLElement): HTMLInputElement {
  const row = el('label', undefined, 'check-row'); row.style.setProperty('--depth', choice.recursive ? '1' : '0');
  const box = el('input'); box.type = 'checkbox'; box.checked = true; box.value = choice.nativeId;
  const title = choice.recursive ? choice.title : t('organize_rootPath', '$1 · Root path', choice.rootTitle);
  const name = el('span', title, 'grow'); name.title = title;
  const hint = choice.recursive ? t('organize_recursive', 'Includes subfolders') : t('organize_rootOnly', 'Root contents only');
  box.setAttribute('aria-label', choice.recursive ? `${choice.rootTitle} / ${choice.title}` : title);
  row.append(box, createIcon('folder', 16), name, el('span', hint, 'meta'));
  list.append(row); return box;
}
