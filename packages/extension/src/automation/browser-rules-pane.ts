import { exclusionIds } from '../bookmark-subscriptions/guards.js';
import { createDialog, dialogButton } from '../dialog.js';
import { createIcon } from '../icons.js';
import { t } from '../i18n.js';
import { button, el, emptyBlock, iconButton, inlineAlert, selectOf, selectPill } from '../library-dom.js';
import { createFolderPicker, folderChoices, type FolderSourceNode } from '../library-folder-picker.js';
import { showToast } from '../toast.js';
import type { BrowserConditionKind, BrowserRuleDraft, DraftProblem } from './browser-rules.js';
import type { AutomationStateView, BrowserRuleResponse, BrowserRuleView } from './messages.js';
import { ruleConditions } from './status-ui.js';

/**
 * Options › Automations › Rules in this browser (AW-68): the Owner's own rules,
 * listed in the web's words ("From arxiv.org → Papers") with a switch each, and
 * one dialog that writes them. The worker checks and keeps every rule
 * (browser-rules.ts); this page only collects the form and shows what the
 * worker said, so nothing here decides what a rule matches.
 */
const KINDS: readonly { readonly kind: BrowserConditionKind; readonly label: () => string; readonly placeholder: string }[] = [
  { kind: 'siteIs', label: () => t('automation_kindSiteIs', 'Site is'), placeholder: 'arxiv.org' },
  { kind: 'siteEndsWith', label: () => t('automation_kindSiteEndsWith', 'Site ends with'), placeholder: 'github.com' },
  { kind: 'titleContains', label: () => t('automation_kindTitleContains', 'Title contains'), placeholder: 'Paper' },
  { kind: 'pathStartsWith', label: () => t('automation_kindPathStartsWith', 'Link path starts with'), placeholder: '/papers/' },
];
const CONDITION_LIMIT = 8;

function send(message: object): Promise<BrowserRuleResponse> {
  return chrome.runtime.sendMessage(message).then((reply) => reply as BrowserRuleResponse ?? { ok: false, error: 'unavailable' },
    () => ({ ok: false, error: 'unavailable' }));
}

function badge(label: string, tone?: 'warning'): HTMLElement {
  const node = el('span', label, 'badge');
  if (tone) node.dataset.tone = tone;
  return node;
}

/** The section: a list of this browser's rules, or the first-visit empty state. */
export function browserRulesGroup(view: AutomationStateView): HTMLElement {
  const section = el('section', undefined, 'set-group automation-browser');
  section.setAttribute('aria-labelledby', 'automation-browser-heading');
  const head = el('div', undefined, 'set-group-head');
  const title = el('h2', t('automation_browserRules', 'Rules in this browser')); title.id = 'automation-browser-heading';
  if (view.browserRules.length) title.append(el('span', String(view.browserRules.length), 'automation-count'));
  head.append(title, el('p', view.account === 'signedIn'
    ? t('automation_browserLedeSignedIn', 'Only this browser uses them, for pages your account’s rules don’t match. A folder you pick yourself always wins.')
    : t('automation_browserLede', 'They file the pages you save here, even offline and with no account. A folder you pick yourself always wins.'), 'detail'));
  section.append(head);
  if (!view.browserRules.length) {
    const card = el('div', undefined, 'set-card');
    const make = button(t('automation_newRule', 'New rule'), view.account === 'signedIn' ? 'btn btn-secondary btn-sm' : 'btn btn-primary btn-sm');
    make.addEventListener('click', () => openBrowserRuleEditor(null, make));
    card.append(emptyBlock({ icon: 'bolt', title: t('automation_browserEmptyTitle', 'No rules in this browser yet'),
      hint: t('automation_browserEmptyHint', 'Tell Know-N once that pages from arxiv.org go to Papers, and each one you save lands there.'), action: make }));
    section.append(card);
    return section;
  }
  const list = el('ul', undefined, 'list-card automation-rules');
  for (const rule of view.browserRules) list.append(ruleRow(rule));
  section.append(list);
  return section;
}

function ruleRow(rule: BrowserRuleView): HTMLLIElement {
  const item = el('li');
  const row = el('div', undefined, 'list-row automation-rule automation-browser-rule');
  if (!rule.enabled) row.dataset.off = '';
  const tile = el('span', undefined, 'favicon-tile'); tile.append(createIcon('bolt', 16));
  const main = el('div', undefined, 'list-row-main');
  const meta = el('p', undefined, 'list-row-meta automation-recipe');
  meta.append(el('span', ruleConditions(rule.match), 'grow'), createIcon('arrow-right', 12));
  if (rule.folder) {
    const folder = el('span', rule.folder.title, 'automation-recipe-folder'); folder.title = rule.folder.path.join(' › ');
    meta.append(createIcon('folder', 12), folder);
  } else {
    meta.append(el('span', rule.folderMissing ? t('automation_browserFolderGone', 'a folder that no longer exists')
      : t('automation_browserFolderHere', 'a folder in this browser'), rule.folderMissing ? 'automation-recipe-missing' : undefined));
  }
  main.append(el('p', rule.name, 'list-row-title'), meta);
  // Actions show on hover; the state badge stays next to the switch, which keeps its own column.
  const tail = el('div', undefined, 'list-row-tail');
  const actions = el('span', undefined, 'row-actions-hover');
  const edit = iconButton('pencil', t('automation_browserEdit', 'Edit rule'), () => openBrowserRuleEditor(rule, edit));
  const remove = iconButton('trash', t('automation_browserDelete', 'Delete rule'), () => confirmDelete(rule, remove));
  actions.append(edit, remove);
  tail.append(actions);
  if (rule.folderMissing) {
    const missing = badge(t('automation_browserFolderMissing', 'Folder missing'), 'warning');
    missing.title = t('automation_browserFolderMissingHint', 'Its folder was deleted. Edit the rule to choose another one.');
    tail.append(missing);
  } else if (!rule.enabled) tail.append(badge(t('automation_browserOff', 'Off')));
  row.append(tile, main, tail, ruleSwitch(rule));
  // The whole row opens the rule, like a row on the web; its own controls keep their clicks.
  row.addEventListener('click', (event) => {
    if (event.target instanceof Element && event.target.closest('button, a')) return;
    openBrowserRuleEditor(rule, edit);
  });
  item.append(row);
  return item;
}

function ruleSwitch(rule: BrowserRuleView): HTMLButtonElement {
  const toggle = el('button', undefined, 'toggle automation-rule-switch');
  toggle.type = 'button'; toggle.setAttribute('role', 'switch'); toggle.setAttribute('aria-checked', String(rule.enabled));
  toggle.setAttribute('aria-label', t('automation_browserUse', 'Use “$1”', rule.name));
  toggle.title = rule.enabled ? t('automation_browserTurnOff', 'Turn off') : t('automation_browserTurnOn', 'Turn on');
  toggle.addEventListener('click', () => {
    const next = toggle.getAttribute('aria-checked') !== 'true';
    toggle.setAttribute('aria-checked', String(next)); toggle.disabled = true;
    // The list repaints from the worker's state once the change is kept.
    void send({ kind: 'known.automation.browser.enable', id: rule.id, enabled: next }).then((reply) => {
      toggle.disabled = false;
      if (reply.ok) return;
      toggle.setAttribute('aria-checked', String(!next));
      showToast(t('automation_browserSaveFailed', 'Couldn’t save this rule. Try again.'), 'error', { announce: true });
    });
  });
  return toggle;
}

function confirmDelete(rule: BrowserRuleView, trigger: HTMLElement): void {
  const { dialog, body, actions } = createDialog(t('automation_browserDeleteTitle', 'Delete “$1”?', rule.name));
  body.append(el('p', t('automation_browserDeleteBody', 'Pages it already filed stay where they are. Pages you save from now on go to the folder you save them to.')));
  const cancel = dialogButton(t('common_cancel', 'Cancel'));
  const confirm = dialogButton(t('automation_browserDeleteConfirm', 'Delete rule'), 'danger');
  cancel.addEventListener('click', () => dialog.close());
  confirm.addEventListener('click', () => {
    confirm.disabled = true;
    void send({ kind: 'known.automation.browser.remove', id: rule.id }).then((reply) => {
      dialog.close();
      showToast(reply.ok ? t('automation_browserDeleted', 'Deleted “$1”.', rule.name)
        : t('automation_browserDeleteFailed', 'Couldn’t delete this rule. Try again.'), reply.ok ? 'ok' : 'error', { announce: true });
    });
  });
  actions.append(cancel, confirm);
  dialog.addEventListener('close', () => { dialog.remove(); if (trigger.isConnected) trigger.focus(); });
  document.body.append(dialog); dialog.showModal(); cancel.focus();
}

interface ConditionRow { readonly element: HTMLElement; readonly kind: HTMLSelectElement; readonly value: HTMLInputElement; readonly error: HTMLElement }

function problemCopy(problem: DraftProblem): string {
  switch (problem.code) {
    case 'required': return problem.field === 'folder' ? t('automation_browserNeedFolder', 'Choose the folder pages go to.')
      : t('automation_browserNeedCondition', 'Add at least one condition.');
    case 'tooMany': return t('automation_browserTooMany', 'Use 8 conditions or fewer.');
    case 'invalidHost': return t('automation_browserBadSite', 'Use a site name, such as arxiv.org.');
    case 'tooLong': return problem.field === 'name' ? t('automation_browserNameTooLong', 'Use 200 characters or fewer.')
      : t('automation_browserValueTooLong', 'Use 512 characters or fewer.');
    case 'kind': return t('automation_browserBadKind', 'This kind of condition can’t be used here.');
  }
}

/**
 * New rule, or edit one: when (conditions), where (a folder here), and an
 * optional name. The worker checks the draft; its problems land on the field
 * they are about.
 */
export function openBrowserRuleEditor(rule: BrowserRuleView | null, trigger?: HTMLElement | null): void {
  const draft = rule?.draft ?? null;
  const { dialog, body, actions } = createDialog(rule ? t('automation_browserEditTitle', 'Edit rule')
    : t('automation_browserNewTitle', 'New rule in this browser'), 'automation-rule-editor');
  const form = el('form'); form.className = 'automation-rule-form'; form.noValidate = true;
  const failure = el('p', undefined, 'form-error'); failure.setAttribute('role', 'alert'); failure.hidden = true;
  const cancel = dialogButton(t('common_cancel', 'Cancel'));
  const save = dialogButton(rule ? t('common_save', 'Save') : t('automation_browserCreate', 'Save rule'), 'primary'); save.type = 'submit';
  cancel.addEventListener('click', () => dialog.close());
  actions.append(cancel, save);
  dialog.replaceChildren(dialog.querySelector('h3')!, form);
  form.append(body, failure, actions);

  // When: one row per condition, joined by all or any once there are two.
  const rows: ConditionRow[] = [];
  const list = el('div', undefined, 'automation-conditions');
  const listError = el('p', undefined, 'form-error'); listError.hidden = true;
  const combinator = selectOf([['all', t('automation_matchAll', 'all of these')], ['any', t('automation_matchAny', 'any of these')]], draft?.combinator ?? 'all');
  const joiner = selectPill(t('automation_matchLabel', 'Match'), combinator); joiner.classList.add('automation-joiner');
  const add = button(t('automation_addCondition', 'Add condition'), 'btn btn-ghost btn-sm automation-add-condition');
  add.prepend(createIcon('plus', 14));
  const when = el('fieldset', undefined, 'form-field automation-when');
  const whenLegend = el('legend', t('automation_whenPage', 'When a page'), 'form-label');
  const whenFoot = el('div', undefined, 'automation-when-foot'); whenFoot.append(add, joiner);
  when.append(whenLegend, list, listError, whenFoot);

  function paintRows(): void {
    joiner.hidden = rows.length < 2;
    add.disabled = rows.length >= CONDITION_LIMIT;
    for (const row of rows) row.element.querySelector<HTMLButtonElement>('.automation-condition-remove')!.hidden = rows.length < 2;
  }
  function addRow(kind: BrowserConditionKind = 'siteIs', value = ''): ConditionRow {
    const element = el('div', undefined, 'automation-condition');
    const select = selectOf(KINDS.map((item) => [item.kind, item.label()] as const), kind);
    select.className = 'field-select'; select.setAttribute('aria-label', t('automation_conditionKind', 'Condition'));
    const input = el('input', undefined, 'field-quiet'); input.type = 'text'; input.value = value; input.autocomplete = 'off'; input.spellcheck = false;
    input.setAttribute('aria-label', t('automation_conditionValue', 'Value'));
    const placeholder = () => { input.placeholder = KINDS.find((item) => item.kind === select.value)?.placeholder ?? ''; };
    select.addEventListener('change', placeholder); placeholder();
    const remove = iconButton('cross', t('automation_removeCondition', 'Remove condition'), () => {
      rows.splice(rows.indexOf(row), 1); element.remove(); paintRows(); rows[0]?.value.focus();
    }, 'btn btn-ghost btn-sm btn-icon automation-condition-remove');
    const error = el('p', undefined, 'form-error automation-condition-error'); error.hidden = true;
    input.addEventListener('input', () => { error.hidden = true; listError.hidden = true; });
    element.append(select, input, remove, error);
    const row = { element, kind: select, value: input, error };
    rows.push(row); list.append(element); paintRows();
    return row;
  }
  add.addEventListener('click', () => addRow().value.focus());
  for (const condition of draft?.conditions ?? [{ kind: 'siteIs' as const, value: '' }]) addRow(condition.kind, condition.value);

  // Where: any folder in this browser, synced or not.
  const where = el('div', undefined, 'form-field');
  const whereLabel = el('span', t('automation_saveIn', 'Save it in'), 'form-label');
  const picker = createFolderPicker({ choices: [], value: draft?.folderNativeId ?? rule?.folder?.nativeId ?? '', startEmpty: true,
    label: t('automation_saveIn', 'Save it in'), onChange: () => { folderError.hidden = true; suggest(); } });
  const folderError = el('p', undefined, 'form-error'); folderError.hidden = true;
  const access = el('div', undefined, 'automation-access'); access.hidden = true;
  where.append(whereLabel, picker.element, folderError, access);

  const nameField = el('div', undefined, 'form-field');
  const name = el('input', undefined, 'field-quiet'); name.type = 'text'; name.id = `automation-rule-name-${crypto.randomUUID()}`;
  name.value = draft?.name ?? ''; name.autocomplete = 'off'; name.maxLength = 200;
  const nameLabel = el('label', t('automation_ruleNameOptional', 'Name (optional)'), 'form-label'); nameLabel.htmlFor = name.id;
  const nameError = el('p', undefined, 'form-error'); nameError.hidden = true;
  const titles = new Map<string, string>();
  // An unnamed rule is named the way the web names one: "arxiv.org → Papers".
  const suggested = () => {
    const raw = rows.map((row) => row.value.value.trim()).find(Boolean) ?? '';
    let value = raw;
    if (/^[a-z][a-z\d+.-]*:\/\//iu.test(raw)) { try { value = new URL(raw).hostname; } catch { /* kept as typed */ } }
    const folder = titles.get(picker.value());
    return value && folder ? `${value} → ${folder}` : value || (folder ? t('automation_ruleNameInto', 'Into $1', folder) : '');
  };
  const suggest = () => { name.placeholder = suggested() || t('automation_ruleNamePlaceholder', 'Papers from arXiv'); };
  list.addEventListener('input', suggest); suggest();
  nameField.append(nameLabel, name, nameError);

  body.append(when, where, nameField,
    el('p', t('automation_browserEditorHint', 'Only this browser uses this rule, after your account’s rules. A folder you pick when saving always wins.'), 'mgr-hint'));

  async function loadFolders(): Promise<void> {
    let granted = false;
    try { granted = await chrome.permissions.contains({ permissions: ['bookmarks'] }); } catch { granted = false; }
    if (!granted || typeof chrome.bookmarks?.getTree !== 'function') {
      const allow = button(t('automation_allowBookmarks', 'Allow bookmark access'), 'btn btn-secondary btn-sm', () => {
        void chrome.permissions.request({ permissions: ['bookmarks'] }).catch(() => false).then((ok) => {
          if (!ok) return;
          if (typeof chrome.bookmarks?.getTree !== 'function') { location.reload(); return; }
          void chrome.runtime.sendMessage({ kind: 'known.roots.permissionChanged', userGesture: true, granted: true }).catch(() => undefined);
          void loadFolders();
        });
      });
      access.replaceChildren(inlineAlert('warning', t('automation_needBookmarks', 'Know-N needs access to your bookmarks to file pages into a folder.'), allow));
      access.hidden = false; picker.pill.disabled = true;
      return;
    }
    access.hidden = true; picker.pill.disabled = false;
    const [roots, hidden] = await Promise.all([chrome.bookmarks.getTree() as Promise<FolderSourceNode[]>, exclusionIds().catch(() => new Set<string>())]);
    const choices = folderChoices(roots, { exclude: hidden });
    for (const choice of choices) titles.set(choice.id, choice.title);
    if (dialog.isConnected) { picker.setChoices(choices); suggest(); }
  }
  void loadFolders().catch(() => undefined);

  function show(problems: readonly DraftProblem[]): void {
    for (const problem of problems) {
      const copy = problemCopy(problem);
      if (problem.field === 'condition') { const row = rows[problem.index]; if (row) { row.error.textContent = copy; row.error.hidden = false; } }
      else if (problem.field === 'conditions') { listError.textContent = copy; listError.hidden = false; }
      else if (problem.field === 'folder') { folderError.textContent = copy; folderError.hidden = false; }
      else { nameError.textContent = copy; nameError.hidden = false; }
    }
    const first = problems[0];
    if (first?.field === 'condition') rows[first.index]?.value.focus();
    else if (first?.field === 'folder') picker.pill.focus();
    else if (first?.field === 'name') name.focus();
    else rows[0]?.value.focus();
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    for (const node of [failure, listError, folderError, nameError, ...rows.map((row) => row.error)]) node.hidden = true;
    const next: BrowserRuleDraft = { name: name.value.trim() || suggested(), combinator: combinator.value === 'any' ? 'any' : 'all', folderNativeId: picker.value(),
      conditions: rows.map((row) => ({ kind: row.kind.value as BrowserConditionKind, value: row.value.value })) };
    // The worker checks everything; these two are said at once, without a round trip.
    const local: DraftProblem[] = [];
    if (!next.conditions.some((condition) => condition.value.trim())) local.push({ field: 'conditions', code: 'required' });
    if (!next.folderNativeId) local.push({ field: 'folder', code: 'required' });
    if (local.length) { show(local); return; }
    save.disabled = true;
    void send({ kind: 'known.automation.browser.save', ...(rule ? { id: rule.id } : {}), draft: next }).then((reply) => {
      save.disabled = false;
      if (reply.ok) {
        dialog.close();
        showToast(t('automation_browserSaved', 'Saved “$1”.', reply.rule?.definition.name ?? next.name), 'ok', { announce: true });
        return;
      }
      if (reply.problems?.length) { show(reply.problems); return; }
      failure.textContent = reply.error === 'limit' ? t('automation_browserLimit', 'This browser keeps up to 100 rules. Delete one to add another.')
        : reply.error === 'notFound' ? t('automation_browserGone', 'This rule was deleted meanwhile.')
          : t('automation_browserSaveFailed', 'Couldn’t save this rule. Try again.');
      failure.hidden = false;
    });
  });

  dialog.addEventListener('close', () => { dialog.remove(); if (trigger?.isConnected) trigger.focus(); });
  document.body.append(dialog); dialog.showModal();
  rows[0]?.value.focus();
}
