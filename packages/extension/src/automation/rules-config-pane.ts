import { exclusionIds } from '../bookmark-subscriptions/guards.js';
import { createDialog, dialogButton } from '../dialog.js';
import { t, tn } from '../i18n.js';
import { button, el } from '../library-dom.js';
import { createFolderPicker, folderChoices, type FolderPicker, type FolderSourceNode } from '../library-folder-picker.js';
import { showToast } from '../toast.js';
import { dialogSummary, optionGroup } from './dialog-parts.js';
import { sendRuleCommand as send } from './rule-command.js';
import { folderRow } from './ruleset-pane.js';
import { CONFIG_MAX_BYTES, foldersUsed, parseRulesConfig, suggestFolders, type RulesConfig } from './rules-config-format.js';

/**
 * Options › Automations › Rules file (doc 17 §5.3, RS-19.3): this browser's rule configuration exported
 * to a `known-rules-config/v1` file, and such a file imported. The import dialog asks for a folder here
 * for each folder the file names, suggesting the one with the same path, and whether the file's entries
 * go below the list's own or replace them. The worker checks and writes (sw/automation-config.ts).
 */
function download(content: string, filename: string): void {
  const url = URL.createObjectURL(new Blob([content], { type: 'application/json' }));
  const link = el('a'); link.href = url; link.download = filename;
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

const fileProblem = (code: string) => code === 'config_version_unsupported' || code === 'unsupported'
  ? t('automation_configUnsupported', 'This file is from a newer version of Know-N. Update Know-N to import it.')
  : code === 'tooLarge' ? t('automation_configTooLarge', 'This file is larger than 2 MB, so it isn’t a rules file.')
    : t('automation_configInvalid', 'This isn’t a Know-N rules file, or it is damaged.');

function openImport(config: RulesConfig, name: string, trigger: HTMLElement, text: string): void {
  const { dialog, body, actions } = createDialog(t('automation_configImportTitle', 'Import rules'), 'automation-config-dialog');
  const rules = config.list.entries.reduce((sum, entry) => sum + (entry.kind === 'rule' ? 1 : entry.kind === 'set' ? entry.set.rules.length : 0), 0);
  const sets = config.list.entries.filter((entry) => entry.kind === 'set').length;
  const subscriptions = config.list.entries.filter((entry) => entry.kind === 'subscription').length;
  // Risk alerts are not part of the list: the file's setting is taken, its lists and exceptions added (sw/risk.ts).
  body.append(dialogSummary([tn('automation_configHasRules', rules, '“$2” has $1 rule', '“$2” has $1 rules', name),
    sets ? tn('automation_configHasSets', sets, '$1 set', '$1 sets') : '',
    subscriptions ? tn('automation_configHasSubscriptions', subscriptions, '$1 subscription, fetched again once you allow its site', '$1 subscriptions, fetched again once you allow their sites') : '',
    config.risk?.lists.length ? tn('automation_configHasRiskLists', config.risk.lists.length, '$1 risk list, fetched again once you allow its site',
      '$1 risk lists, fetched again once you allow their sites') : '']
    .filter(Boolean).join(' · '),
  config.risk ? el('p', t('automation_configRiskHint', 'Risk alerts are set as in the file, and its lists and exceptions are added to yours.'), 'mgr-hint') : null));
  const used = foldersUsed(config);
  const folders = config.folders.filter((folder) => used.all.has(folder.nativeId));
  const pickers = new Map<string, FolderPicker>();
  if (folders.length) {
    body.append(el('p', t('automation_configFoldersHint', 'Choose the folder here for each folder in the file. A folder with the same path is suggested; nothing is used until you import.'), 'mgr-hint'));
    const list = el('div', undefined, 'automation-config-folders');
    for (const folder of folders) {
      const named = folder.title ? t('automation_configFolder', '“$1”', folder.title) : t('automation_configFolderUnknown', 'A folder that was gone when the file was made');
      const picker = createFolderPicker({ choices: [], startEmpty: true, label: named });
      pickers.set(folder.nativeId, picker);
      const notes = [folder.path.length ? folder.path.join(' › ') : '',
        used.actions.has(folder.nativeId) ? '' : t('automation_configMayStayUnbound', 'Only a set’s role uses it; with no folder, the role stays unbound.')].filter(Boolean);
      list.append(folderRow(named, notes, picker));
    }
    body.append(list);
  }
  let replace = false;
  const mode = optionGroup('radio', [
    { value: 'add', title: t('automation_configAdd', 'Add below my rules'), hint: t('automation_configAddHint', 'Your list stays as it is; the file’s entries come after it.'), checked: true },
    { value: 'replace', title: t('automation_configReplace', 'Replace my rules'), hint: t('automation_configReplaceHint', 'Your rules, sets and subscriptions here are removed first.'), checked: false }]);
  for (const input of mode.inputs) input.addEventListener('change', () => { if (input.checked) replace = input.value === 'replace'; });
  const error = el('p', undefined, 'form-error'); error.setAttribute('role', 'alert'); error.hidden = true;
  body.append(mode.element, error);
  const cancel = dialogButton(t('common_cancel', 'Cancel'));
  const go = dialogButton(t('automation_configImport', 'Import'), 'primary');
  cancel.addEventListener('click', () => dialog.close());
  actions.append(cancel, go);
  go.addEventListener('click', () => {
    error.hidden = true;
    const remap = Object.fromEntries([...pickers].map(([id, picker]) => [id, picker.value() || null]));
    const missing = folders.find((folder) => used.actions.has(folder.nativeId) && !remap[folder.nativeId]);
    if (missing) {
      error.textContent = t('automation_configNeedFolder', 'Choose a folder here for “$1”.', missing.title || missing.path.at(-1) || missing.nativeId); error.hidden = false;
      pickers.get(missing.nativeId)?.pill.focus(); return;
    }
    go.disabled = true;
    void send({ kind: 'known.automation.browser.config.import', text, folders: remap, replace }).then((reply) => {
      go.disabled = false;
      if (reply.ok && 'imported' in reply) {
        dialog.close();
        const { rules: made, sets: madeSets, skipped, riskLists } = reply.imported;
        showToast(`${tn('automation_configImported', made, 'Imported $1 rule.', 'Imported $1 rules.')}${madeSets ? ` ${tn('automation_configImportedSets', madeSets, '$1 set.', '$1 sets.')}` : ''}${riskLists
          ? ` ${tn('automation_configImportedRisk', riskLists, '$1 risk list.', '$1 risk lists.')}` : ''}${skipped
          ? ` ${tn('automation_configSkipped', skipped, '$1 rule this version can’t use was left out.', '$1 rules this version can’t use were left out.')}` : ''}`, 'ok', { announce: true });
        return;
      }
      const code = reply.ok ? '' : reply.error;
      error.textContent = code === 'limit' ? t('automation_configLimit', 'With these, this browser would pass its limits of 200 rules on their own, 50 sets and 1,000 rules in all. Replace your rules, or delete some first.')
        : code === 'folderGone' ? t('automation_configFolderGone', 'One of the folders you chose is gone, or a bookmark subscription keeps it. Choose another one.')
          : code === 'noAccess' ? t('automation_configNoAccess', 'Know-N needs access to your bookmarks to import rules.')
            : code === 'invalid' || code === 'unsupported' ? fileProblem(code) : t('automation_configImportFailed', 'Couldn’t import these rules. Try again.');
      error.hidden = false;
    });
  });
  void (async () => {
    const [roots, hidden] = await Promise.all([chrome.bookmarks.getTree() as Promise<FolderSourceNode[]>, exclusionIds().catch(() => new Set<string>())]);
    const choices = folderChoices(roots, { exclude: hidden });
    const suggested = suggestFolders(folders, choices.filter((folder) => !folder.disabled));
    if (!dialog.isConnected) return;
    for (const [id, picker] of pickers) { picker.setChoices(choices); const value = suggested[id]; if (value) picker.setValue(value); }
  })().catch(() => undefined);
  dialog.addEventListener('close', () => { dialog.remove(); if (trigger.isConnected) trigger.focus(); });
  document.body.append(dialog); dialog.showModal(); (pickers.values().next().value?.pill ?? cancel).focus();
}

/** The quiet row under this browser's rules: Export and Import. */
export function configCard(): HTMLElement {
  const card = el('section', undefined, 'set-card automation-config');
  card.setAttribute('aria-label', t('automation_configTitle', 'Rules file'));
  const exportButton = button(t('automation_configExport', 'Export'), 'btn btn-secondary btn-sm', () => {
    exportButton.disabled = true;
    void send({ kind: 'known.automation.browser.config.export' }).then((reply) => {
      exportButton.disabled = false;
      if (!reply.ok || !('config' in reply)) { showToast(t('automation_configExportFailed', 'Couldn’t export your rules. Try again.'), 'error', { announce: true }); return; }
      download(reply.config.content, reply.config.filename);
      showToast(t('automation_configExported', 'Download started. Import the file in Know-N on any browser to bring these rules there.'), 'ok', { announce: true });
    });
  });
  const input = el('input'); input.type = 'file'; input.accept = 'application/json,.json'; input.hidden = true;
  const importButton = button(t('automation_configImportButton', 'Import'), 'btn btn-secondary btn-sm', () => input.click());
  input.addEventListener('change', () => {
    const file = input.files?.[0]; input.value = '';
    if (!file) return;
    if (file.size > CONFIG_MAX_BYTES) { showToast(fileProblem('tooLarge'), 'error', { announce: true }); return; }
    void file.text().then((text) => {
      let config: RulesConfig;
      try { config = parseRulesConfig(JSON.parse(text)); } catch (error) {
        showToast(fileProblem(error instanceof Error ? error.message : ''), 'error', { announce: true }); return;
      }
      openImport(config, file.name, importButton, text);
    });
  });
  const row = el('div', undefined, 'set-row');
  const words = el('div', undefined, 'set-row-text');
  words.append(el('p', t('automation_configTitle', 'Rules file'), 'set-row-title'),
    el('p', t('automation_configHint', 'Keep this browser’s rules, sets and the folders they use in a file, or bring them from another browser. Bookmarks aren’t in it.'), 'set-row-hint'));
  const controls = el('div', undefined, 'set-row-control');
  controls.append(exportButton, importButton, input);
  row.append(words, controls);
  card.append(row);
  return card;
}
