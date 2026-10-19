import { createDialog, dialogButton } from '../dialog.js';
import { t, tn } from '../i18n.js';
import { el } from '../library-dom.js';
import { showToast } from '../toast.js';
import type { BrowserSetView } from './messages.js';
import { sendRuleCommand as send } from './rule-command.js';

/**
 * A set of this browser's rules (doc 17 R3, RS-03): a named run of rules in the list, one level deep.
 * New set and Rename ask for its name; Delete asks whether its rules go with it or stay in the list
 * where the set was. The worker keeps the list (rule-list-store.ts); this page only asks.
 */
function close(dialog: HTMLDialogElement, trigger?: HTMLElement | null): void {
  dialog.addEventListener('close', () => { dialog.remove(); if (trigger?.isConnected) trigger.focus(); });
}

export function openSetDialog(set: Pick<BrowserSetView, 'id' | 'name'> | null, trigger?: HTMLElement | null): void {
  const { dialog, body, actions } = createDialog(set ? t('automation_setRenameTitle', 'Rename set') : t('automation_setNewTitle', 'New set'), 'automation-set-dialog');
  const form = el('form'); form.noValidate = true;
  const field = el('div', undefined, 'form-field');
  const input = el('input', undefined, 'field-quiet'); input.type = 'text'; input.id = `automation-set-name-${crypto.randomUUID()}`;
  input.value = set?.name ?? ''; input.maxLength = 200; input.autocomplete = 'off'; input.placeholder = t('automation_setNamePlaceholder', 'Research');
  const label = el('label', t('automation_setName', 'Name'), 'form-label'); label.htmlFor = input.id;
  const error = el('p', undefined, 'form-error'); error.setAttribute('role', 'alert'); error.hidden = true;
  field.append(label, input, error);
  body.append(field, el('p', t('automation_setHint', 'A set keeps rules together in the list. It is tried where it stands, its rules from the top, and turns them on and off together.'), 'mgr-hint'));
  const cancel = dialogButton(t('common_cancel', 'Cancel'));
  const save = dialogButton(set ? t('common_save', 'Save') : t('automation_setCreate', 'Create set'), 'primary'); save.type = 'submit';
  cancel.addEventListener('click', () => dialog.close());
  actions.append(cancel, save);
  dialog.replaceChildren(dialog.querySelector('h3')!, form);
  form.append(body, actions);
  input.addEventListener('input', () => { error.hidden = true; });
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const name = input.value.trim();
    if (!name) { error.textContent = t('automation_setNeedName', 'Give the set a name.'); error.hidden = false; input.focus(); return; }
    save.disabled = true;
    void send({ kind: 'known.automation.browser.set.save', ...(set ? { id: set.id } : {}), name }).then((reply) => {
      save.disabled = false;
      if (reply.ok) { dialog.close(); showToast(set ? t('automation_setRenamed', 'Renamed to “$1”.', name) : t('automation_setCreated', 'Created “$1”. Add rules to it from New rule or by dragging them in.', name), 'ok', { announce: true }); return; }
      error.textContent = reply.error === 'limit' ? t('automation_setLimit', 'This browser keeps up to 50 sets. Delete one to add another.')
        : reply.error === 'notFound' ? t('automation_setGone', 'This set was deleted meanwhile.') : t('automation_setSaveFailed', 'Couldn’t save this set. Try again.');
      error.hidden = false;
    });
  });
  close(dialog, trigger);
  document.body.append(dialog); dialog.showModal(); input.focus();
}

export function confirmDeleteSet(set: BrowserSetView, trigger?: HTMLElement | null): void {
  const { dialog, body, actions } = createDialog(t('automation_setDeleteTitle', 'Delete “$1”?', set.name));
  const group = `automation-set-delete-${crypto.randomUUID()}`;
  const option = (value: 'keep' | 'delete', title: string, hint: string) => {
    const label = el('label', undefined, 'choice');
    const input = el('input'); input.type = 'radio'; input.name = group; input.value = value; input.checked = value === 'keep';
    label.append(input, el('span', title, 'choice-title'), el('span', hint, 'choice-hint'));
    return label;
  };
  const error = el('p', undefined, 'form-error'); error.setAttribute('role', 'alert'); error.hidden = true;
  if (set.rules.length) {
    const choices = el('div', undefined, 'choice-pair');
    choices.append(
      option('keep', tn('automation_setKeepRules', set.rules.length, 'Keep its rule', 'Keep its $1 rules'),
        t('automation_setKeepRulesHint', 'They stay in the list where the set was, each on its own.')),
      option('delete', tn('automation_setDeleteRules', set.rules.length, 'Delete its rule too', 'Delete its $1 rules too'),
        t('automation_setDeleteRulesHint', 'Pages they already filed stay where they are.')));
    body.append(choices);
  } else {
    body.append(el('p', t('automation_setDeleteEmpty', 'It has no rules.')));
  }
  body.append(error);
  const cancel = dialogButton(t('common_cancel', 'Cancel'));
  const confirm = dialogButton(t('automation_setDelete', 'Delete set'), 'danger');
  cancel.addEventListener('click', () => dialog.close());
  confirm.addEventListener('click', () => {
    const keepRules = dialog.querySelector<HTMLInputElement>(`input[name="${group}"][value="delete"]`)?.checked !== true;
    confirm.disabled = true;
    void send({ kind: 'known.automation.browser.set.remove', id: set.id, keepRules }).then((reply) => {
      confirm.disabled = false;
      if (reply.ok) { dialog.close(); showToast(t('automation_setDeleted', 'Deleted “$1”.', set.name), 'ok', { announce: true }); return; }
      error.textContent = reply.error === 'unbound' ? t('automation_setDeleteUnbound', 'Some of its rules file into the set’s folders, which aren’t chosen yet. Choose them, or delete the rules with the set.')
        : reply.error === 'limit' ? t('automation_setDeleteLimit', 'Kept on their own, its rules would pass the 200 this browser keeps. Delete some of them with the set.')
          : t('automation_setDeleteFailed', 'Couldn’t delete this set. Try again.');
      error.hidden = false;
    });
  });
  actions.append(cancel, confirm);
  close(dialog, trigger);
  document.body.append(dialog); dialog.showModal(); cancel.focus();
}
