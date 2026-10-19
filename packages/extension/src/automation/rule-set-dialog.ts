import { createDialog, dialogButton } from '../dialog.js';
import { t, tn } from '../i18n.js';
import { el } from '../library-dom.js';
import { showToast } from '../toast.js';
import { optionGroup } from './dialog-parts.js';
import type { BrowserRuleView, BrowserSetView } from './messages.js';
import { sendRuleCommand as send } from './rule-command.js';

/**
 * A set of this browser's rules (doc 17 R3, RS-03): a named run of rules in the list, one level deep.
 * New set and Rename ask for its name; Delete asks whether its rules go with it or stay in the list
 * where the set was. Copy to my rules takes one of its rules out as the Owner's own, above the set. The worker
 * keeps the list (rule-list-store.ts); this page only asks.
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
  const error = el('p', undefined, 'form-error'); error.setAttribute('role', 'alert'); error.hidden = true;
  let deleteRules: HTMLInputElement | undefined;
  if (set.rules.length) {
    const choices = optionGroup('radio', [
      { value: 'keep', title: tn('automation_setKeepRules', set.rules.length, 'Keep its rule', 'Keep its $1 rules'),
        hint: t('automation_setKeepRulesHint', 'They stay in the list where the set was, each on its own.'), checked: true },
      { value: 'delete', title: tn('automation_setDeleteRules', set.rules.length, 'Delete its rule too', 'Delete its $1 rules too'),
        hint: t('automation_setDeleteRulesHint', 'Pages they already filed stay where they are.'), checked: false }]);
    deleteRules = choices.inputs[1];
    body.append(choices.element);
  } else {
    body.append(el('p', t('automation_setDeleteEmpty', 'It has no rules.')));
  }
  body.append(error);
  const cancel = dialogButton(t('common_cancel', 'Cancel'));
  const confirm = dialogButton(t('automation_setDelete', 'Delete set'), 'danger');
  cancel.addEventListener('click', () => dialog.close());
  confirm.addEventListener('click', () => {
    const keepRules = deleteRules?.checked !== true;
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

/**
 * Copy to my rules (doc 17 RS-03.4, RW-11): the set's rule becomes one of the Owner's own, just above the set, so
 * it is tried first and can be changed; the set's own copy stays as it came, or is switched off.
 */
export function confirmCopyToMine(rule: BrowserRuleView, set: Pick<BrowserSetView, 'name'>, trigger?: HTMLElement | null): void {
  const { dialog, body, actions } = createDialog(t('automation_copyTitle', 'Copy “$1” to your rules?', rule.name));
  body.append(el('p', rule.folder ? t('automation_copyHint', 'The copy goes above “$1” as a rule of your own, filing into $2. It is tried before the set, and you can change it.', set.name, rule.folder.title)
    : t('automation_copyHintKeep', 'The copy goes above “$1” as a rule of your own. It is tried before the set, and you can change it.', set.name), 'mgr-hint'));
  const turnOff = optionGroup('checkbox', [{ value: 'off', title: t('automation_copyTurnOff', 'Also turn off the original in “$1”', set.name), checked: true }]);
  const box = turnOff.inputs[0]!;
  const error = el('p', undefined, 'form-error'); error.setAttribute('role', 'alert'); error.hidden = true;
  body.append(turnOff.element, error);
  const cancel = dialogButton(t('common_cancel', 'Cancel'));
  const copy = dialogButton(t('automation_copy', 'Copy to my rules'), 'primary');
  cancel.addEventListener('click', () => dialog.close());
  copy.addEventListener('click', () => {
    copy.disabled = true;
    void send({ kind: 'known.automation.browser.copyEntry', ruleId: rule.id, disableOriginal: box.checked }).then((reply) => {
      copy.disabled = false;
      if (reply.ok) { dialog.close(); showToast(t('automation_copied', 'Copied “$1” above “$2”.', rule.name, set.name), 'ok', { announce: true }); return; }
      error.textContent = reply.error === 'unbound' ? t('automation_moveUnbound', 'Its set has no folder for it. Choose a folder first.')
        : reply.error === 'limit' ? t('automation_listLimit', 'This browser keeps up to 200 rules on their own and 1,000 in all. Delete one to add another.')
          : t('automation_copyFailed', 'Couldn’t copy this rule. Try again.');
      error.hidden = false;
    });
  });
  actions.append(cancel, copy);
  close(dialog, trigger);
  document.body.append(dialog); dialog.showModal(); copy.focus();
}
