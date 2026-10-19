import { normalizeHost } from '@know-n/colp/automation';
import { exclusionIds } from '../bookmark-subscriptions/guards.js';
import { createDialog, dialogButton } from '../dialog.js';
import { createIcon } from '../icons.js';
import { t } from '../i18n.js';
import { button, el, iconButton, inlineAlert, selectOf, selectPill } from '../library-dom.js';
import { createFolderPicker, folderChoices, type FolderSourceNode } from '../library-folder-picker.js';
import { showToast } from '../toast.js';
import type { BrowserRuleView } from './messages.js';
import { isPublicSuffix, registrableDomain, unicodeHost } from './public-suffix.js';
import { sendRuleCommand as send } from './rule-command.js';
import type { ConditionKind, DraftProblem, RuleAction, RuleDraft } from './rule-conditions.js';

/**
 * New rule, or edit one (doc 17 §7, RS-09): when (conditions), then (file it in a folder here, or keep
 * it where it is saved), where in the list (on its own or in a set), and an optional name. The worker
 * checks the draft (rule-conditions.ts) and its problems land on the field they are about; this dialog
 * only helps write site values: a pasted link becomes its site with its registrable domain offered,
 * a suffix shared by many owners asks once more, and an `xn--` site shows its Unicode form. *Site from a
 * collection* is offered only when a subscription has sites, and picks one of them.
 */
const KINDS: readonly { readonly kind: ConditionKind; readonly label: () => string; readonly placeholder: string }[] = [
  { kind: 'siteIs', label: () => t('automation_kindSiteIs', 'Site is'), placeholder: 'arxiv.org' },
  { kind: 'siteEndsWith', label: () => t('automation_kindSiteOrSubdomains', 'Site or its subdomains'), placeholder: 'github.com' },
  { kind: 'titleContains', label: () => t('automation_kindTitleContains', 'Title contains'), placeholder: 'Paper' },
  { kind: 'pathStartsWith', label: () => t('automation_kindPathStartsWith', 'Link path starts with'), placeholder: '/papers/' },
  { kind: 'pathUnder', label: () => t('automation_kindPathUnder', 'Link path is or is under'), placeholder: '/team' },
];
const CONDITION_LIMIT = 8;
const isSite = (kind: string) => kind === 'siteIs' || kind === 'siteEndsWith';
const LINK = /^[a-z][a-z\d+.-]*:\/\//iu;

export interface EditorOptions {
  /** A new rule may be for all the account's devices; it is then made on the web, filled in from here. */
  readonly account?: boolean;
  /** What a new rule starts as when both are offered. */
  readonly use?: 'browser' | 'account';
  /** The list's sets, for "In"; a new rule starts in `into`. */
  readonly sets?: readonly { readonly id: string; readonly name: string }[];
  readonly into?: string | null;
  /** A new rule's place in the list, or in `into` (Add a rule above, doc 17 RS-15.3); it goes last when the set is changed. */
  readonly index?: number;
  /** What a new rule starts as. */
  readonly draft?: RuleDraft;
  /** The sites of the subscriptions' collections (`<subscriptionId>/<siteId>`), for *Site from a collection*. */
  readonly collections?: readonly { readonly value: string; readonly label: string }[];
}

function problemCopy(problem: DraftProblem): string {
  switch (problem.code) {
    case 'required': return problem.field === 'folder' ? t('automation_browserNeedFolder', 'Choose the folder pages go to.')
      : t('automation_browserNeedCondition', 'Add at least one condition.');
    case 'tooMany': return t('automation_browserTooMany', 'Use 8 conditions or fewer.');
    case 'invalid': return t('automation_browserInvalidConditions', 'These conditions can’t be checked together. Use fewer, or fewer sites.');
    case 'invalidHost': return t('automation_browserBadSite', 'Use a site name, such as arxiv.org.');
    case 'invalidPath': return t('automation_browserBadPath', 'Use a link path, such as /papers/.');
    case 'tooLong': return problem.field === 'name' ? t('automation_browserNameTooLong', 'Use 200 characters or fewer.')
      : t('automation_browserValueTooLong', 'Use 512 characters or fewer.');
    case 'kind': return t('automation_browserBadKind', 'This kind of condition can’t be used here.');
    case 'collection': return t('automation_browserBadCollection', 'This site is no longer in its subscription. Choose another one.');
    case 'oneCollection': return t('automation_browserOneCollection', 'Use sites from one subscription in a rule. Make another rule for the others.');
  }
}

interface ConditionRow {
  readonly element: HTMLElement; readonly kind: HTMLSelectElement; readonly value: HTMLInputElement;
  readonly help: HTMLElement; readonly error: HTMLElement;
  /** A site value that covers sites of many owners, which Save asks about once. */
  broad(): string | null;
}

export function openRuleEditor(rule: BrowserRuleView | null, trigger?: HTMLElement | null, options: EditorOptions = {}): void {
  const draft = rule?.draft ?? options.draft ?? null;
  // One New rule for both kinds: where it is used is the first thing asked, and only when there is a choice.
  const offerAccount = !rule && options.account === true;
  let use: 'browser' | 'account' = offerAccount && options.use === 'account' ? 'account' : 'browser';
  const { dialog, body, actions } = createDialog(rule ? t('automation_browserEditTitle', 'Edit rule')
    : offerAccount ? t('automation_newRule', 'New rule') : t('automation_browserNewTitle', 'New rule in this browser'), 'automation-rule-editor');
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
  const whenFoot = el('div', undefined, 'automation-when-foot'); whenFoot.append(add, joiner);
  when.append(el('legend', t('automation_whenPage', 'When a page'), 'form-label'), list, listError, whenFoot);
  /** Broad values the Owner already said yes to, by value. */
  const confirmed = new Set<string>();

  function paintRows(): void {
    joiner.hidden = rows.length < 2;
    add.disabled = rows.length >= CONDITION_LIMIT;
    for (const row of rows) row.element.querySelector<HTMLButtonElement>('.automation-condition-remove')!.hidden = rows.length < 2;
  }
  const collections = options.collections ?? [];
  const kinds = collections.length || draft?.conditions.some((condition) => condition.kind === 'siteCollection')
    ? [...KINDS, { kind: 'siteCollection' as const, label: () => t('automation_kindSiteCollection', 'Site from a collection'), placeholder: '' }] : KINDS;
  function addRow(kind: ConditionKind = 'siteIs', value = ''): ConditionRow {
    const element = el('div', undefined, 'automation-condition');
    const select = selectOf(kinds.map((item) => [item.kind, item.label()] as const), kind);
    select.className = 'field-select'; select.setAttribute('aria-label', t('automation_conditionKind', 'Condition'));
    const input = el('input', undefined, 'field-quiet'); input.type = 'text'; input.value = value; input.autocomplete = 'off'; input.spellcheck = false;
    input.setAttribute('aria-label', t('automation_conditionValue', 'Value'));
    const remove = iconButton('cross', t('automation_removeCondition', 'Remove condition'), () => {
      rows.splice(rows.indexOf(row), 1); element.remove(); paintRows(); rows[0]?.value.focus();
    }, 'btn btn-ghost btn-sm btn-icon automation-condition-remove');
    const help = el('p', undefined, 'automation-condition-help'); help.hidden = true;
    const error = el('p', undefined, 'form-error automation-condition-error'); error.hidden = true;
    // A collection's site is picked, not typed; the input keeps its value for the draft.
    const known = collections.some((item) => item.value === value);
    const sites = selectOf([...(kind === 'siteCollection' && value && !known ? [[value, t('automation_collectionGone', 'A site no longer in its subscription')] as const] : []),
      ...collections.map((item) => [item.value, item.label] as const)], kind === 'siteCollection' ? value : collections[0]?.value ?? '');
    sites.className = 'field-select automation-condition-site'; sites.setAttribute('aria-label', t('automation_collectionPick', 'Site'));
    const showSites = () => {
      const on = select.value === 'siteCollection';
      sites.hidden = !on; input.hidden = on;
      if (on) input.value = sites.value; else if (collections.some((item) => item.value === input.value)) input.value = '';
    };
    sites.addEventListener('change', () => { input.value = sites.value; error.hidden = true; listError.hidden = true; });
    select.addEventListener('change', showSites);
    // Without collections there is nothing to pick, so the row keeps its one select.
    element.append(select, input, ...(collections.length ? [sites] : []), remove, help, error);
    showSites();
    const host = () => {
      const raw = input.value.trim();
      if (!isSite(select.value) || !raw) return null;
      if (LINK.test(raw)) { try { return normalizeHost(new URL(raw).hostname) ?? null; } catch { return null; } }
      return normalizeHost(raw) ?? null;
    };
    const row: ConditionRow = { element, kind: select, value: input, help, error,
      broad: () => select.value === 'siteEndsWith' && host() && isPublicSuffix(host()!) ? host() : null };
    // What the site value means: its Unicode form, its registrable domain, and how wide it reaches.
    const explain = () => {
      help.replaceChildren(); help.hidden = true; delete help.dataset.tone;
      input.placeholder = kinds.find((item) => item.kind === select.value)?.placeholder ?? '';
      const site = host();
      if (!site) return;
      const parts: (string | HTMLElement)[] = [];
      const unicode = unicodeHost(site);
      if (unicode && unicode !== input.value.trim()) parts.push(t('automation_siteUnicode', 'Shown as $1, saved as $2.', unicode, site));
      else if (unicode) parts.push(t('automation_siteSavedAs', 'Saved as $1.', site));
      const registrable = registrableDomain(site);
      if (registrable && registrable !== site) {
        parts.push(button(t('automation_siteUseDomain', 'Use $1 and its subdomains instead', unicodeHost(registrable) ?? registrable), 'btn btn-ghost btn-sm', () => {
          input.value = registrable; select.value = 'siteEndsWith'; explain(); input.focus();
        }));
      }
      const broad = row.broad();
      if (broad) {
        help.dataset.tone = 'warning';
        parts.unshift(t('automation_siteBroad', 'Covers every site under $1, run by many different owners.', broad));
      }
      if (!parts.length) return;
      help.append(...parts.map((part) => typeof part === 'string' ? el('span', part) : part));
      help.hidden = false;
    };
    // A pasted link stands for its site, as the worker reads it.
    input.addEventListener('paste', () => queueMicrotask(() => {
      const raw = input.value.trim();
      if (isSite(select.value) && LINK.test(raw)) { try { input.value = new URL(raw).hostname; } catch { /* checked as typed */ } }
      explain();
    }));
    input.addEventListener('input', () => { error.hidden = true; listError.hidden = true; explain(); });
    select.addEventListener('change', explain); explain();
    rows.push(row); list.append(element); paintRows();
    return row;
  }
  add.addEventListener('click', () => addRow().value.focus());
  for (const condition of draft?.conditions ?? [{ kind: 'siteIs' as const, value: '' }]) addRow(condition.kind, condition.value);

  // Then: a folder in this browser, synced or not; the set's folder for a role; or where the page is saved.
  const action: RuleAction = draft?.action ?? { kind: 'file', folderNativeId: rule?.folder?.nativeId ?? '' };
  const then = el('fieldset', undefined, 'form-field automation-then');
  const thenGroup = `automation-then-${crypto.randomUUID()}`;
  let thenChoice: 'folder' | 'role' | 'keepHere' = 'folder';
  const startFolder = action.kind === 'file' && 'folderNativeId' in action ? action.folderNativeId : '';
  const picker = createFolderPicker({ choices: [], value: startFolder, startEmpty: true,
    label: t('automation_saveIn', 'Save it in'), onChange: () => { folderError.hidden = true; pick('folder'); suggest(); } });
  const folderError = el('p', undefined, 'form-error'); folderError.hidden = true;
  const access = el('div', undefined, 'automation-access'); access.hidden = true;
  // The folder pill sits beside its choice, not inside the label, so working the pill never also clicks the radio.
  const choice = (value: 'folder' | 'role' | 'keepHere', title: string, extra?: HTMLElement) => {
    const card = el('div', undefined, 'choice automation-then-choice');
    const label = el('label', undefined, 'automation-then-label');
    const input = el('input'); input.type = 'radio'; input.name = thenGroup; input.value = value;
    input.addEventListener('change', () => { if (input.checked) { thenChoice = value; folderError.hidden = true; suggest(); } });
    label.append(input, el('span', title, 'choice-title'));
    card.append(label);
    if (extra) card.append(extra);
    return card;
  };
  const choices = el('div', undefined, 'automation-then-choices');
  choices.append(choice('folder', t('automation_thenFile', 'File it in'), picker.element));
  // A rule from an imported set files where the set binds its role; it may be given a folder of its own instead.
  if (action.kind === 'file' && 'role' in action) {
    choices.append(choice('role', t('automation_thenRole', 'The set’s folder for “$1”', action.role)));
  }
  choices.append(choice('keepHere', t('automation_thenKeep', 'Keep it where I save it')));
  then.append(el('legend', t('automation_then', 'Then'), 'form-label'), choices, folderError, access);
  function pick(value: 'folder' | 'role' | 'keepHere'): void {
    thenChoice = value;
    for (const input of Array.from(choices.querySelectorAll<HTMLInputElement>('input[type="radio"]'))) input.checked = input.value === value;
  }
  const chosen = () => thenChoice;
  pick(action.kind === 'keepHere' ? 'keepHere' : 'role' in action ? 'role' : 'folder');

  // In: on its own in the list, or in one of its sets.
  const sets = options.sets ?? [];
  const startSet = rule ? rule.setId ?? '' : options.into ?? '';
  const inSet = selectOf([['', t('automation_inNoSet', 'On its own')], ...sets.map((set) => [set.id, set.name] as const)], startSet);
  const placeField = el('div', undefined, 'form-field automation-in-set');
  placeField.append(selectPill(t('automation_inSet', 'In'), inSet));
  placeField.hidden = !sets.length;

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
    if (LINK.test(raw)) { try { value = new URL(raw).hostname; } catch { /* kept as typed */ } }
    const folder = chosen() === 'folder' ? titles.get(picker.value()) : undefined;
    return value && folder ? `${value} → ${folder}` : value || (folder ? t('automation_ruleNameInto', 'Into $1', folder) : '');
  };
  const suggest = () => { name.placeholder = suggested() || t('automation_ruleNamePlaceholder', 'Papers from arXiv'); };
  list.addEventListener('input', suggest); suggest();
  nameField.append(nameLabel, name, nameError);

  const hint = el('p', undefined, 'mgr-hint');
  const useOn = el('fieldset', undefined, 'form-field automation-use-on'); useOn.hidden = !offerAccount;
  const useChoices = el('div', undefined, 'choice-pair');
  const group = `automation-use-${crypto.randomUUID()}`;
  const useChoice = (value: 'browser' | 'account', title: string, detail: string) => {
    const label = el('label', undefined, 'choice');
    const input = el('input'); input.type = 'radio'; input.name = group; input.value = value; input.checked = use === value;
    input.addEventListener('change', () => { if (input.checked) { use = value; paintUse(); } });
    label.append(input, el('span', title, 'choice-title'), el('span', detail, 'choice-hint'));
    return label;
  };
  useChoices.append(
    useChoice('browser', t('automation_useBrowser', 'This browser'), t('automation_useBrowserHint', 'Works right away, even offline. Your other devices don’t get it.')),
    useChoice('account', t('automation_useAccount', 'All my devices'), t('automation_useAccountHint', 'Your account’s rule. You preview it and turn it on on the web. Its folder must be synced.')));
  useOn.append(el('legend', t('automation_useOn', 'Use it on'), 'form-label'), useChoices);
  function paintUse(): void {
    save.textContent = rule ? t('common_save', 'Save') : use === 'account' ? t('automation_continueOnWeb', 'Continue on the web') : t('automation_browserCreate', 'Save rule');
    hint.textContent = use === 'account'
      ? t('automation_accountEditorHint', 'The web editor opens filled in with this rule. Nothing changes until you turn it on there.')
      : t('automation_listEditorHint', 'Only this browser uses this rule, after your account’s rules, for pages you save with the Know-N button or menu. Rules are tried from the top of the list; the first that matches decides. A folder you pick when saving always wins.');
    placeField.hidden = use === 'account' || !sets.length;
    folderError.hidden = true; failure.hidden = true;
  }
  paintUse();
  body.append(useOn, when, then, placeField, nameField, hint);

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
    // A subscription-exclusion read failure must not offer subscription folders.
    const [roots, hidden] = await Promise.all([chrome.bookmarks.getTree() as Promise<FolderSourceNode[]>, exclusionIds()]);
    const folders = folderChoices(roots, { exclude: hidden });
    for (const folder of folders) titles.set(folder.id, folder.title);
    if (dialog.isConnected) { picker.setChoices(folders); suggest(); }
  }
  const folderLoadFailed = (): void => {
    access.replaceChildren(inlineAlert('warning',
      t('automation_loadFailed', 'Couldn’t read automations in this browser. Reload the page to try again.'),
      button(t('common_tryAgain', 'Try again'), 'btn btn-secondary btn-sm', () => {
        void loadFolders().catch(folderLoadFailed);
      })));
    access.hidden = false; picker.pill.disabled = true;
  };
  void loadFolders().catch(folderLoadFailed);

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
  const draftAction = (): RuleAction => chosen() === 'keepHere' ? { kind: 'keepHere' }
    : chosen() === 'role' && action.kind === 'file' && 'role' in action ? action : { kind: 'file', folderNativeId: picker.value() };

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    for (const node of [failure, listError, folderError, nameError, ...rows.map((row) => row.error)]) node.hidden = true;
    const next: RuleDraft = { name: name.value.trim() || suggested(), combinator: combinator.value === 'any' ? 'any' : 'all', action: draftAction(),
      conditions: rows.map((row) => ({ kind: row.kind.value as ConditionKind, value: row.value.value })) };
    // The worker checks everything; these two are said at once, without a round trip.
    const local: DraftProblem[] = [];
    if (!next.conditions.some((condition) => condition.value.trim())) local.push({ field: 'conditions', code: 'required' });
    if (next.action.kind === 'file' && 'folderNativeId' in next.action && !next.action.folderNativeId) local.push({ field: 'folder', code: 'required' });
    if (local.length) { show(local); return; }
    // A suffix shared by many owners is a legitimate value (edu), so it is asked about once, never refused.
    const broad = rows.map((row) => row.broad()).filter((value): value is string => value !== null && !confirmed.has(value));
    if (broad.length) {
      for (const value of broad) confirmed.add(value);
      failure.textContent = t('automation_siteBroadConfirm', 'This rule covers every site under $1. Save again to keep it.', broad.join(', '));
      failure.hidden = false; save.textContent = t('automation_saveAnyway', 'Save anyway');
      return;
    }
    save.disabled = true;
    if (use === 'account') {
      // Nothing is stored here: the web editor opens with this draft, and the account's rule is made there.
      void send({ kind: 'known.automation.browser.forAccount', draft: next }).then((reply) => {
        save.disabled = false;
        if (reply.ok && 'url' in reply) {
          window.open(reply.url, '_blank', 'noopener');
          dialog.close();
          showToast(t('automation_newOnWeb', 'Finish on the web: preview the rule and turn it on.'), 'info', { announce: true });
          return;
        }
        if (!reply.ok && reply.error === 'notSynced') {
          folderError.textContent = t('automation_folderNotSynced', 'This folder isn’t synced, so your other devices don’t have it. Choose a synced folder, or use the rule in this browser.');
          folderError.hidden = false; picker.pill.focus(); return;
        }
        if (!reply.ok && reply.problems?.length) { show(reply.problems); return; }
        failure.textContent = !reply.ok && reply.error === 'signedOut' ? t('automation_signInForAccount', 'Sign in to make a rule for all your devices.')
          : !reply.ok && reply.error === 'notOnWeb' ? t('automation_notOnWeb', 'The web editor can’t make this rule. Use it in this browser.')
            : t('automation_browserSaveFailed', 'Couldn’t save this rule. Try again.');
        failure.hidden = false;
      });
      return;
    }
    const into = inSet.value || null;
    const index = !rule && options.index !== undefined && into === (options.into ?? null) ? { index: options.index } : {};
    void send({ kind: 'known.automation.browser.save', ...(rule ? { id: rule.id } : {}), ...(!rule && into ? { into } : {}), ...index, draft: next }).then(async (reply) => {
      // An edited rule that changes set goes to the end of the new one, or below the list's entries.
      if (reply.ok && rule && into !== rule.setId) {
        const moved = await send({ kind: 'known.automation.browser.moveRule', ruleId: rule.id, into, index: 1_000 });
        if (!moved.ok) { save.disabled = false; failure.textContent = moved.error === 'unbound' ? t('automation_moveUnbound', 'Its set has no folder for it. Choose a folder first.')
          : t('automation_browserSaveFailed', 'Couldn’t save this rule. Try again.'); failure.hidden = false; return; }
      }
      save.disabled = false;
      if (reply.ok) {
        dialog.close();
        showToast(t('automation_browserSaved', 'Saved “$1”.', 'rule' in reply ? reply.rule?.name ?? next.name : next.name), 'ok', { announce: true });
        return;
      }
      if (reply.problems?.length) { show(reply.problems); return; }
      failure.textContent = reply.error === 'limit' ? t('automation_listLimit', 'This browser keeps up to 200 rules on their own and 1,000 in all. Delete one to add another.')
        : reply.error === 'notFound' ? t('automation_browserGone', 'This rule was deleted meanwhile.')
          : t('automation_browserSaveFailed', 'Couldn’t save this rule. Try again.');
      failure.hidden = false;
    });
  });

  dialog.addEventListener('close', () => { dialog.remove(); if (trigger?.isConnected) trigger.focus(); });
  document.body.append(dialog); dialog.showModal();
  rows[0]?.value.focus();
}
