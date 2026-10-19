import { exclusionIds } from '../bookmark-subscriptions/guards.js';
import { createDialog, dialogButton } from '../dialog.js';
import { t, tn } from '../i18n.js';
import { el } from '../library-dom.js';
import { createFolderPicker, folderChoices, type FolderPicker, type FolderSourceNode } from '../library-folder-picker.js';
import { showToast } from '../toast.js';
import { countList, dialogSummary } from './dialog-parts.js';
import type { BrowserRulesetView, BrowserSetView } from './messages.js';
import { sendRuleCommand as send } from './rule-command.js';
import { RULESET_MAX_BYTES, type RulesetProblem } from './ruleset-format.js';

/**
 * Options › Rules in this browser › Import set (doc 17 RS-02, RS-07): a `colp.ruleset/v1` file read in the
 * page and checked by the worker. A file it refuses is answered with where each problem is; one it takes
 * opens a dialog that names the set, binds each of its roles to a folder here (or leaves it to wait), and
 * says how many recent bookmarks its rules would file. A set's roles can be bound again later, and any
 * set can be written out as such a file.
 */
function problemCopy(problem: RulesetProblem): string {
  switch (problem.code) {
    case 'json': return t('automation_rulesetJson', 'This file isn’t JSON.');
    case 'tooLarge': return t('automation_rulesetTooLarge', 'This file is larger than 2 MB.');
    case 'format': return t('automation_rulesetFormat', 'This isn’t a colp.ruleset/v1 rule set.');
    case 'unknownKey': return t('automation_rulesetUnknownKey', 'Not part of the format');
    case 'required': return t('automation_rulesetRequired', 'Missing');
    case 'type': return t('automation_rulesetType', 'The wrong kind of value');
    case 'tooLong': return t('automation_rulesetTooLong', 'Too long');
    case 'pattern': return t('automation_rulesetPattern', 'Not a value this place allows');
    case 'duplicate': return t('automation_rulesetDuplicate', 'Used twice');
    case 'tooMany': return t('automation_rulesetTooMany', 'More than the format allows');
    case 'oneOf': return t('automation_rulesetOneOf', 'An entry needs a site or a match, not both');
    case 'unknownRole': return t('automation_rulesetUnknownRole', 'No such role in this file');
    case 'unknownSite': return t('automation_rulesetUnknownSite', 'No such site in this file');
    case 'invalidHost': return t('automation_rulesetInvalidHost', 'Not a site name');
    case 'invalidPath': case 'invalidUrl': return t('automation_rulesetInvalidUrl', 'Not a web link');
    case 'invalidMatch': return t('automation_rulesetInvalidMatch', 'These conditions can’t be checked here');
  }
}

export function showProblems(name: string, problems: readonly RulesetProblem[], trigger: HTMLElement): void {
  const whole = problems.length === 1 && (problems[0]!.pointer === '' || problems[0]!.pointer === '/format');
  if (whole) { showToast(problemCopy(problems[0]!), 'error', { announce: true }); return; }
  const { dialog, body, actions } = createDialog(t('automation_rulesetRefusedTitle', 'Can’t import “$1”', name), 'automation-ruleset-problems');
  body.append(el('p', t('automation_rulesetRefused', 'Nothing was added. Every entry has to pass, so fix these in the file and try again:'), 'mgr-hint'));
  const list = el('ul', undefined, 'automation-ruleset-problem-list');
  for (const problem of problems) {
    const item = el('li'); item.append(el('code', problem.pointer || '/'), ` ${problemCopy(problem)}`); list.append(item);
  }
  body.append(list);
  if (problems.length >= 10) body.append(el('p', t('automation_rulesetMore', 'Only the first 10 are shown.'), 'mgr-hint'));
  const close = dialogButton(t('common_close', 'Close'), 'primary');
  close.addEventListener('click', () => dialog.close());
  actions.append(close);
  dialog.addEventListener('close', () => { dialog.remove(); if (trigger.isConnected) trigger.focus(); });
  document.body.append(dialog); dialog.showModal(); close.focus();
}

/** One kind of page (or one folder of a rules file) and the folder here it goes to: its name on the left, the picker on the right. */
export function folderRow(name: string, notes: readonly string[], picker: FolderPicker): HTMLElement {
  const row = el('div', undefined, 'automation-role-row');
  const words = el('div', undefined, 'automation-role-text');
  words.append(el('p', name, 'form-label'), ...notes.map((note) => el('p', note, 'automation-config-path')));
  row.append(words, picker.element);
  return row;
}

/** The folders a role may be bound to: this browser's own, never a bookmark subscription's. */
export function rolePickers(roles: readonly { readonly key: string; readonly description: string }[], current: Readonly<Record<string, string>>,
  body: HTMLElement, dialog: HTMLDialogElement): Map<string, FolderPicker> {
  const pickers = new Map<string, FolderPicker>();
  if (!roles.length) return pickers;
  const list = el('div', undefined, 'automation-config-folders');
  for (const role of roles) {
    const picker = createFolderPicker({ choices: [], startEmpty: !current[role.key], ...(current[role.key] ? { value: current[role.key] } : {}),
      label: role.description || role.key });
    pickers.set(role.key, picker);
    list.append(folderRow(role.description || role.key, [t('automation_rulesetRoleKey', 'Role “$1”', role.key)], picker));
  }
  body.append(list);
  void (async () => {
    const [roots, hidden] = await Promise.all([chrome.bookmarks.getTree() as Promise<FolderSourceNode[]>, exclusionIds()]);
    if (!dialog.isConnected) return;
    const choices = folderChoices(roots, { exclude: hidden });
    for (const [key, picker] of pickers) { picker.setChoices(choices); if (current[key]) picker.setValue(current[key]!); }
  })().catch(() => showToast(t('automation_loadFailed', 'Couldn’t read automations in this browser. Reload the page to try again.'), 'error', { announce: true }));
  return pickers;
}

function openImport(view: BrowserRulesetView, text: string, trigger: HTMLElement): void {
  const { dialog, body, actions } = createDialog(t('automation_rulesetImportTitle', 'Import “$1”', view.name), 'automation-config-dialog');
  const left = [view.matchingOnly ? tn('automation_rulesetMatchingOnly', view.matchingOnly, '$1 entry has no folder role, so it isn’t added.',
    '$1 entries have no folder role, so they aren’t added.') : '', view.inactive ? tn('automation_rulesetInactive', view.inactive,
    '$1 site has only retired addresses and matches nothing.', '$1 sites have only retired addresses and match nothing.') : ''].filter(Boolean);
  const roleName = (key: string) => view.roles.find((role) => role.key === key)?.description || key;
  // What the file is, then what it would do to the bookmarks already here, in one box.
  body.append(dialogSummary([tn('automation_rulesetRules', view.rules, '$1 rule', '$1 rules'), t('automation_rulesetVersion', 'version $1', view.version),
    view.publisher ?? '', view.license ?? ''].filter(Boolean).join(' · '),
  left.length ? el('p', left.join(' '), 'mgr-hint') : null,
  view.sample ? el('p', view.sample.matched ? tn('automation_rulesetSample', view.sample.matched, 'Its rules would file $1 of your last $2 bookmarks.',
    'Its rules would file $1 of your last $2 bookmarks.', view.sample.size) : t('automation_rulesetSampleNone', 'None of your last $1 bookmarks match its rules.', view.sample.size), 'detail') : null,
  view.sample?.byRole.length ? countList(view.sample.byRole.slice(0, 5).map((row) => tn('automation_rulesetSampleRole', row.count, '$2: $1 bookmark', '$2: $1 bookmarks', roleName(row.role)))) : null));
  if (view.roles.length) body.append(el('p', t('automation_rulesetRolesHint', 'Choose a folder here for each kind of page it files. A role you leave without a folder waits: its rules don’t file anything until you choose one.'), 'mgr-hint'));
  const pickers = rolePickers(view.roles, {}, body, dialog);
  const error = el('p', undefined, 'form-error'); error.setAttribute('role', 'alert'); error.hidden = true;
  body.append(error);
  const cancel = dialogButton(t('common_cancel', 'Cancel'));
  const add = dialogButton(t('automation_rulesetAdd', 'Add set'), 'primary');
  cancel.addEventListener('click', () => dialog.close());
  add.addEventListener('click', () => {
    error.hidden = true; add.disabled = true;
    const bindings = Object.fromEntries([...pickers].map(([key, picker]) => [key, picker.value() || null]));
    void send({ kind: 'known.automation.browser.import', text, bindings }).then((reply) => {
      add.disabled = false;
      if (reply.ok && 'set' in reply) {
        dialog.close();
        const waiting = Object.values(bindings).filter((value) => !value).length;
        showToast(`${t('automation_rulesetAdded', 'Added “$1” at the end of your list.', view.name)}${waiting
          ? ` ${tn('automation_rulesetWaiting', waiting, '$1 role still needs a folder.', '$1 roles still need a folder.')}` : ''}`, 'ok', { announce: true });
        return;
      }
      const code = reply.ok ? '' : reply.error;
      error.textContent = code === 'limit' ? t('automation_rulesetLimit', 'With this set, this browser would pass its limit of 50 sets or 1,000 rules. Delete some first.')
        : code === 'folderGone' ? t('automation_configFolderGone', 'One of the folders you chose is gone, or a bookmark subscription keeps it. Choose another one.')
          : t('automation_rulesetAddFailed', 'Couldn’t add this set. Try again.');
      error.hidden = false;
    });
  });
  actions.append(cancel, add);
  dialog.addEventListener('close', () => { dialog.remove(); if (trigger.isConnected) trigger.focus(); });
  document.body.append(dialog); dialog.showModal(); add.focus();
}

/** Import set: pick a file, have the worker check it, then bind its roles. */
export function openRulesetImport(trigger: HTMLElement): void {
  const input = el('input'); input.type = 'file'; input.accept = 'application/json,.json'; input.hidden = true;
  input.addEventListener('change', () => {
    const file = input.files?.[0]; input.remove();
    if (!file) return;
    if (file.size > RULESET_MAX_BYTES) { showToast(problemCopy({ pointer: '', code: 'tooLarge' }), 'error', { announce: true }); return; }
    void file.text().then((text) => send({ kind: 'known.automation.browser.import.check', text }).then((reply) => {
      if (reply.ok && 'ruleset' in reply) { openImport(reply.ruleset, text, trigger); return; }
      if (!reply.ok && reply.rulesetProblems?.length) { showProblems(file.name, reply.rulesetProblems, trigger); return; }
      showToast(t('automation_rulesetCheckFailed', 'Couldn’t read this rule set. Try again.'), 'error', { announce: true });
    }));
  });
  input.addEventListener('cancel', () => input.remove());
  document.body.append(input); input.click();
}

/** The folders an imported set's roles file into here. */
export function openRoleBindings(set: BrowserSetView, trigger: HTMLElement): void {
  const roles = set.roles ?? [];
  const { dialog, body, actions } = createDialog(t('automation_rulesetBindTitle', 'Folders for “$1”', set.name), 'automation-config-dialog');
  body.append(el('p', t('automation_rulesetBindHint', 'Each kind of page this set files goes to the folder you choose here.'), 'mgr-hint'));
  const pickers = rolePickers(roles, Object.fromEntries(roles.flatMap((role) => role.folder ? [[role.key, role.folder.nativeId]] : [])), body, dialog);
  const error = el('p', undefined, 'form-error'); error.setAttribute('role', 'alert'); error.hidden = true;
  const cancel = dialogButton(t('common_cancel', 'Cancel'));
  const save = dialogButton(t('common_save', 'Save'), 'primary');
  cancel.addEventListener('click', () => dialog.close());
  save.addEventListener('click', () => {
    const bindings = Object.fromEntries([...pickers].flatMap(([key, picker]) => picker.value() ? [[key, picker.value()]] : []));
    save.disabled = true;
    void send({ kind: 'known.automation.browser.set.bind', id: set.id, bindings }).then((reply) => {
      save.disabled = false;
      if (reply.ok) { dialog.close(); showToast(t('automation_rulesetBound', 'Saved the folders for “$1”.', set.name), 'ok', { announce: true }); return; }
      error.textContent = reply.error === 'folderGone' ? t('automation_configFolderGone', 'One of the folders you chose is gone, or a bookmark subscription keeps it. Choose another one.')
        : t('automation_rulesetBindFailed', 'Couldn’t save these folders. Try again.');
      error.hidden = false;
    });
  });
  body.append(error);
  actions.append(cancel, save);
  dialog.addEventListener('close', () => { dialog.remove(); if (trigger.isConnected) trigger.focus(); });
  document.body.append(dialog); dialog.showModal(); save.focus();
}

/** Export set: the set as a `colp.ruleset/v1` file, its folders as roles named after them. */
export function exportSet(set: BrowserSetView): void {
  void send({ kind: 'known.automation.browser.set.export', id: set.id }).then((reply) => {
    if (!reply.ok || !('config' in reply)) { showToast(t('automation_rulesetExportFailed', 'Couldn’t export this set. Try again.'), 'error', { announce: true }); return; }
    const url = URL.createObjectURL(new Blob([reply.config.content], { type: 'application/json' }));
    const link = el('a'); link.href = url; link.download = reply.config.filename;
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
    showToast(t('automation_rulesetExported', 'Download started. Anyone can import this file as a set and choose their own folders.'), 'ok', { announce: true });
  });
}
