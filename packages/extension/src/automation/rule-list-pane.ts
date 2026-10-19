import { createDialog, dialogButton } from '../dialog.js';
import { createIcon } from '../icons.js';
import { t, tn } from '../i18n.js';
import { button, el, emptyBlock, iconButton, inlineAlert } from '../library-dom.js';
import { showToast } from '../toast.js';
import { accountBadge, accountNotes, moveToAccountAction, offersAccountRules, overlapNotice } from './browser-rules-pane.js';
import type { BrowserDecisionEntry } from '../capture/contracts.js';
import type { AutomationStateView, BrowserListEntryView, BrowserListView, BrowserRuleView, BrowserSetView } from './messages.js';
import { sendRuleCommand as send } from './rule-command.js';
import { openRuleEditor } from './rule-editor-dialog.js';
import { confirmDeleteSet, openSetDialog } from './rule-set-dialog.js';
import { ruleConditions } from './status-ui.js';

/**
 * Options › Automations › Rules in this browser (doc 17 RS-01, RS-03): one ordered list of individual
 * rules, sets of rules and subscriptions, tried from the top, the first match deciding. Each entry has
 * its switch; Move up and Move down (and dragging) reorder it, a rule moves into and out of a set, and
 * moving a set moves its rules. The order shown is the worker's (rule-list-flatten.ts reads the same
 * list), and every change is a worker command; this page decides nothing about a match.
 */
const entryId = (entry: BrowserListEntryView) => entry.kind === 'rule' ? entry.rule.id : entry.kind === 'set' ? entry.set.id : entry.id;
const failed = () => showToast(t('automation_listSaveFailed', 'Couldn’t change the list. Try again.'), 'error', { announce: true });

/** The control to give focus back to once the list repaints after a move (the page is drawn again from the worker's state). */
let refocus: { readonly id: string; readonly control: 'up' | 'down' } | null = null;
export function restoreListFocus(root: HTMLElement): void {
  if (!refocus) return;
  const { id, control } = refocus; refocus = null;
  const row = root.querySelector<HTMLElement>(`[data-entry-id="${CSS.escape(id)}"]`);
  const target = [control, control === 'up' ? 'down' : 'up'].map((name) => row?.querySelector<HTMLButtonElement>(`:scope > .list-row [data-move="${name}"]`))
    .find((node) => node && !node.disabled);
  target?.focus();
}

/**
 * Where the entry that decided a save stands in the list now (doc 17 RS-15.3): the row to show, and the
 * place a rule goes to be tried before it (in its set, for a set's rule). Null once it left the list.
 */
export function entryPlace(list: BrowserListView, entry: BrowserDecisionEntry): { readonly row: string; readonly into: string | null;
  readonly index: number; readonly rule: BrowserRuleView | null } | null {
  for (const [index, item] of list.entries.entries()) {
    if (item.kind === 'rule' && entry.kind === 'rule' && item.rule.id === entry.ruleId) return { row: item.rule.id, into: null, index, rule: item.rule };
    if (item.kind === 'subscription' && entry.kind === 'subscriptionEntry' && item.id === entry.subscriptionId) return { row: item.id, into: null, index, rule: null };
    if (item.kind === 'set' && entry.kind === 'setRule') {
      const at = item.set.rules.findIndex((rule) => rule.id === entry.ruleId);
      if (at >= 0) return { row: entry.ruleId!, into: item.set.id, index: at, rule: item.set.rules[at]! };
    }
  }
  return null;
}

/** Open rule: the entry's row scrolled into view, marked for a moment, with its actions in reach of the keyboard. */
export function revealEntry(root: ParentNode, id: string): boolean {
  const row = root.querySelector<HTMLElement>(`.rule-list [data-entry-id="${CSS.escape(id)}"] > .list-row`);
  if (!row) return false;
  row.scrollIntoView?.({ block: 'center' });
  row.tabIndex = -1; row.dataset.highlight = ''; row.focus({ preventScroll: true });
  setTimeout(() => { delete row.dataset.highlight; }, 2_400);
  return true;
}

function badge(label: string, tone?: 'warning'): HTMLElement {
  const node = el('span', label, 'badge');
  if (tone) node.dataset.tone = tone;
  return node;
}

function toggle(label: string, on: boolean, change: (next: boolean) => Promise<boolean>, className = 'toggle automation-rule-switch'): HTMLButtonElement {
  const node = el('button', undefined, className);
  node.type = 'button'; node.setAttribute('role', 'switch'); node.setAttribute('aria-checked', String(on));
  node.setAttribute('aria-label', label); node.title = on ? t('automation_browserTurnOff', 'Turn off') : t('automation_browserTurnOn', 'Turn on');
  node.addEventListener('click', () => {
    const next = node.getAttribute('aria-checked') !== 'true';
    node.setAttribute('aria-checked', String(next)); node.disabled = true;
    // The list repaints from the worker's state once the change is kept.
    void change(next).then((ok) => {
      node.disabled = false;
      if (ok) return;
      node.setAttribute('aria-checked', String(!next));
      failed();
    });
  });
  return node;
}

/** A move in the list: for the list's own entries a new order, for a rule a place in a set or out of one. */
async function moveCommand(message: object, focus: typeof refocus): Promise<void> {
  refocus = focus;
  const reply = await send(message);
  if (reply.ok) return;
  refocus = null;
  if (reply.error === 'unbound') showToast(t('automation_moveUnbound', 'Its set has no folder for it. Choose a folder first.'), 'error', { announce: true });
  else if (reply.error === 'limit') showToast(t('automation_listLimit', 'This browser keeps up to 200 rules on their own and 1,000 in all. Delete one to add another.'), 'error', { announce: true });
  else failed();
}
const reorder = (order: string[], focus: typeof refocus) => moveCommand({ kind: 'known.automation.browser.reorder', order }, focus);
const moveRule = (ruleId: string, into: string | null, index: number, focus: typeof refocus = null) =>
  moveCommand({ kind: 'known.automation.browser.moveRule', ruleId, into, index }, focus);

/** Move up / Move down for an entry of the list, or for a rule in a set (whose first and last step out of it). */
function moveButtons(list: BrowserListView, id: string, set: BrowserSetView | null): HTMLElement[] {
  const top = list.entries.map(entryId);
  const make = (control: 'up' | 'down') => {
    const label = control === 'up' ? t('automation_moveUp', 'Move up') : t('automation_moveDown', 'Move down');
    const node = iconButton(control === 'up' ? 'chevron-up' : 'chevron-down', label);
    node.dataset.move = control;
    const step = control === 'up' ? -1 : 1;
    if (!set) {
      const at = top.indexOf(id), to = at + step;
      node.disabled = to < 0 || to >= top.length;
      node.addEventListener('click', () => {
        const order = [...top]; order.splice(at, 1); order.splice(to, 0, id);
        void reorder(order, { id, control });
      });
      return node;
    }
    const rules = set.rules.map((rule) => rule.id), at = rules.indexOf(id), to = at + step;
    const setAt = top.indexOf(set.id);
    node.addEventListener('click', () => {
      // Past either end of its set, a rule leaves it: just above the set, or just below.
      if (to < 0) void moveRule(id, null, setAt, { id, control });
      else if (to >= rules.length) void moveRule(id, null, setAt + 1, { id, control });
      else void moveRule(id, set.id, to, { id, control });
    });
    return node;
  };
  return [make('up'), make('down')];
}

/** What is being dragged: an entry of the list, or a rule (in a set or not). */
type Dragged = { readonly kind: BrowserListEntryView['kind']; readonly id: string; readonly setId: string | null };
type Drop = 'before' | 'after' | 'into';

/**
 * Dragging, with the same commands as the buttons. A row takes a drop above or below it; a set's head
 * also takes a rule into the set (its middle), and an empty set takes one into its hint row.
 */
function dragAndDrop(list: BrowserListView) {
  let dragged: Dragged | null = null;
  const top = list.entries.map(entryId);
  const setOf = (id: string) => list.entries.find((entry): entry is Extract<BrowserListEntryView, { kind: 'set' }> => entry.kind === 'set' && entry.set.id === id)?.set;
  function land(target: { readonly id: string; readonly setId: string | null; readonly kind: 'entry' | 'rule' | 'setHead' | 'setEmpty' }, drop: Drop): void {
    const source = dragged; dragged = null;
    if (!source || source.id === target.id) return;
    const rule = source.kind === 'rule';
    if (drop === 'into' && rule) { void moveRule(source.id, target.id, setOf(target.id)?.rules.length ?? 0); return; }
    // A set or a subscription moves only among the list's own entries; a rule inside a set stands for its set.
    const entryTarget = target.kind === 'rule' && target.setId && !rule ? target.setId : target.id;
    if (entryTarget === source.id) return;
    if (rule && target.kind === 'rule' && target.setId) {
      const rules = setOf(target.setId)!.rules.map((item) => item.id).filter((id) => id !== source.id);
      void moveRule(source.id, target.setId, rules.indexOf(target.id) + (drop === 'after' ? 1 : 0));
      return;
    }
    if (rule && source.setId) {
      void moveRule(source.id, null, top.indexOf(entryTarget) + (drop === 'after' ? 1 : 0));
      return;
    }
    const order = top.filter((id) => id !== source.id);
    order.splice(order.indexOf(entryTarget) + (drop === 'after' ? 1 : 0), 0, source.id);
    if (order.some((id, index) => id !== top[index])) void reorder(order, null);
  }
  return {
    source(row: HTMLElement, item: Dragged): void {
      row.draggable = true;
      row.addEventListener('dragstart', (event) => {
        event.stopPropagation();
        dragged = item;
        event.dataTransfer?.setData('text/plain', item.id);
        if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
        row.dataset.dragging = '';
      });
      row.addEventListener('dragend', () => { dragged = null; delete row.dataset.dragging; });
    },
    target(row: HTMLElement, target: Parameters<typeof land>[0]): void {
      row.addEventListener('dragover', (event) => {
        if (!dragged || dragged.id === target.id) return;
        const rect = row.getBoundingClientRect(), height = rect.height > 0 ? rect.height : 40;
        const ratio = Math.max(0, Math.min(1, (event.clientY - rect.top) / height));
        const intoSet = dragged.kind === 'rule' && (target.kind === 'setEmpty' || (target.kind === 'setHead' && ratio > 0.3 && ratio < 0.7));
        const drop: Drop = intoSet ? 'into' : ratio < 0.5 ? 'before' : 'after';
        if (target.kind === 'setEmpty' && drop !== 'into') return;
        event.preventDefault(); event.stopPropagation();
        if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
        row.dataset.drop = drop;
      });
      row.addEventListener('dragleave', (event) => { if (!row.contains(event.relatedTarget as Node | null)) delete row.dataset.drop; });
      row.addEventListener('drop', (event) => {
        event.preventDefault(); event.stopPropagation();
        const drop = row.dataset.drop as Drop | undefined;
        delete row.dataset.drop;
        if (drop) land(target, drop);
      });
    },
  };
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

function duplicate(entry: 'rule' | 'set', id: string, name: string): void {
  const copy = t('automation_copyName', '$1 (copy)', name);
  void send({ kind: 'known.automation.browser.duplicate', id, entry, name: copy }).then((reply) => {
    if (reply.ok) showToast(t('automation_duplicated', 'Added “$1” below the original.', copy), 'ok', { announce: true });
    else if (reply.error === 'limit') showToast(t('automation_listLimit', 'This browser keeps up to 200 rules on their own and 1,000 in all. Delete one to add another.'), 'error', { announce: true });
    else failed();
  });
}

interface Context {
  readonly view: AutomationStateView;
  readonly list: BrowserListView;
  readonly paused: boolean;
  readonly sets: readonly { readonly id: string; readonly name: string }[];
  readonly drag: ReturnType<typeof dragAndDrop>;
}

function ruleRow(rule: BrowserRuleView, set: BrowserSetView | null, context: Context): HTMLLIElement {
  const item = el('li'); item.dataset.entryId = rule.id;
  const row = el('div', undefined, 'list-row automation-rule automation-browser-rule');
  if (!rule.active) row.dataset.off = '';
  const grip = el('span', undefined, 'rule-grip'); grip.append(createIcon('reorder', 14)); grip.title = t('automation_dragToMove', 'Drag to move');
  const tile = el('span', undefined, 'favicon-tile'); tile.append(createIcon('bolt', 16));
  const main = el('div', undefined, 'list-row-main');
  const meta = el('p', undefined, 'list-row-meta automation-recipe');
  meta.append(el('span', ruleConditions(rule.match), 'grow'), createIcon('arrow-right', 12));
  if (rule.keepHere) meta.append(el('span', t('automation_recipeKeep', 'kept where you save it'), 'automation-recipe-folder'));
  else if (rule.folder) {
    const folder = el('span', rule.folder.title, 'automation-recipe-folder'); folder.title = rule.folder.path.join(' › ');
    meta.append(createIcon('folder', 12), folder);
  } else {
    meta.append(el('span', rule.folderMissing ? t('automation_browserFolderGone', 'a folder that no longer exists')
      : t('automation_browserFolderHere', 'a folder in this browser'), rule.folderMissing ? 'automation-recipe-missing' : undefined));
  }
  main.append(el('p', rule.name, 'list-row-title'), meta, ...accountNotes(rule));
  // Actions show on hover and focus; the state badge stays next to the switch, which keeps its own column.
  const tail = el('div', undefined, 'list-row-tail');
  const actions = el('span', undefined, 'row-actions-hover');
  const edit = iconButton('pencil', t('automation_browserEdit', 'Edit rule'), () => openRuleEditor(rule, edit, { sets: context.sets }));
  const move = moveToAccountAction(rule);
  actions.append(...moveButtons(context.list, rule.id, set), edit,
    iconButton('copy', t('automation_duplicateRule', 'Duplicate rule'), () => duplicate('rule', rule.id, rule.name)), ...(move ? [move] : []));
  const remove = iconButton('trash', t('automation_browserDelete', 'Delete rule'), () => confirmDelete(rule, remove));
  actions.append(remove);
  tail.append(actions);
  if (rule.folderMissing) {
    const missing = badge(t('automation_browserFolderMissing', 'Folder missing'), 'warning');
    missing.title = t('automation_browserFolderMissingHint', 'Its folder was deleted. Edit the rule to choose another one.');
    tail.append(missing);
  } else if (!rule.enabled) tail.append(badge(t('automation_browserOff', 'Off')));
  else if (context.paused) tail.append(badge(t('automation_rulePaused', 'Paused')));
  else {
    const account = accountBadge(rule);
    if (account) tail.append(account);
  }
  row.append(grip, tile, main, tail, toggle(t('automation_browserUse', 'Use “$1”', rule.name), rule.enabled,
    async (enabled) => (await send({ kind: 'known.automation.browser.enable', id: rule.id, enabled })).ok));
  // The whole row opens the rule, like a row on the web; its own controls keep their clicks.
  row.addEventListener('click', (event) => {
    if (event.target instanceof Element && event.target.closest('button, a')) return;
    openRuleEditor(rule, edit, { sets: context.sets });
  });
  context.drag.source(row, { kind: 'rule', id: rule.id, setId: set?.id ?? null });
  context.drag.target(row, set ? { id: rule.id, setId: set.id, kind: 'rule' } : { id: rule.id, setId: null, kind: 'entry' });
  item.append(row);
  return item;
}

function setBlock(set: BrowserSetView, context: Context): HTMLLIElement {
  const item = el('li', undefined, 'rule-set'); item.dataset.entryId = set.id;
  const head = el('div', undefined, 'list-row automation-rule rule-set-head');
  if (!set.enabled || !context.list.enabled) head.dataset.off = '';
  const grip = el('span', undefined, 'rule-grip'); grip.append(createIcon('reorder', 14)); grip.title = t('automation_dragToMove', 'Drag to move');
  const tile = el('span', undefined, 'favicon-tile'); tile.append(createIcon('collection', 16));
  const main = el('div', undefined, 'list-row-main');
  const count = tn('automation_setCount', set.rules.length, '$1 rule', '$1 rules');
  const origin = set.origin.kind === 'import'
    ? t('automation_setImported', 'Imported from $1, version $2', set.origin.sourceName, set.origin.sourceVersion)
    : t('automation_setCustom', 'Your set');
  main.append(el('p', set.name, 'list-row-title'), el('p', `${count} · ${origin}`, 'list-row-meta'));
  const tail = el('div', undefined, 'list-row-tail');
  const actions = el('span', undefined, 'row-actions-hover');
  const addRule = iconButton('plus', t('automation_setAddRule', 'New rule in this set'), () => openRuleEditor(null, addRule, { sets: context.sets, into: set.id,
    account: false }));
  const rename = iconButton('pencil', t('automation_setRename', 'Rename set'), () => openSetDialog(set, rename));
  const remove = iconButton('trash', t('automation_setDelete', 'Delete set'), () => confirmDeleteSet(set, remove));
  actions.append(...moveButtons(context.list, set.id, null), addRule, rename,
    iconButton('copy', t('automation_duplicateSet', 'Duplicate set'), () => duplicate('set', set.id, set.name)), remove);
  tail.append(actions);
  if (!set.enabled) tail.append(badge(t('automation_browserOff', 'Off')));
  head.append(grip, tile, main, tail, toggle(t('automation_setUse', 'Use the set “$1”', set.name), set.enabled,
    async (enabled) => (await send({ kind: 'known.automation.browser.enable', id: set.id, enabled, entry: 'set' })).ok));
  context.drag.source(head, { kind: 'set', id: set.id, setId: null });
  context.drag.target(head, { id: set.id, setId: null, kind: 'setHead' });
  const rules = el('ul', undefined, 'automation-rules rule-set-rules');
  rules.setAttribute('aria-label', t('automation_setRulesLabel', 'Rules in “$1”', set.name));
  for (const rule of set.rules) rules.append(ruleRow(rule, set, context));
  if (!set.rules.length) {
    const empty = el('li', undefined, 'rule-set-empty');
    const hint = el('p', t('automation_setEmpty', 'No rules yet. Drag rules here, or add one.'), 'list-row-meta');
    empty.append(hint);
    context.drag.target(empty, { id: set.id, setId: null, kind: 'setEmpty' });
    rules.append(empty);
  }
  item.append(head, rules);
  return item;
}

function subscriptionRow(entry: Extract<BrowserListEntryView, { kind: 'subscription' }>, context: Context): HTMLLIElement {
  const item = el('li'); item.dataset.entryId = entry.id;
  const row = el('div', undefined, 'list-row automation-rule automation-browser-rule');
  if (!entry.enabled || !context.list.enabled) row.dataset.off = '';
  const grip = el('span', undefined, 'rule-grip'); grip.append(createIcon('reorder', 14));
  const tile = el('span', undefined, 'favicon-tile'); tile.append(createIcon('rss', 16));
  const main = el('div', undefined, 'list-row-main');
  main.append(el('p', t('automation_subscription', 'Subscribed rule set'), 'list-row-title'),
    el('p', t('automation_subscriptionNotReady', 'No version yet, so it files nothing.'), 'list-row-meta'));
  const tail = el('div', undefined, 'list-row-tail');
  const actions = el('span', undefined, 'row-actions-hover'); actions.append(...moveButtons(context.list, entry.id, null));
  tail.append(actions);
  row.append(grip, tile, main, tail, toggle(t('automation_subscriptionUse', 'Use this subscription'), entry.enabled,
    async (enabled) => (await send({ kind: 'known.automation.browser.enable', id: entry.id, enabled, entry: 'subscription' })).ok));
  context.drag.source(row, { kind: 'subscription', id: entry.id, setId: null });
  context.drag.target(row, { id: entry.id, setId: null, kind: 'entry' });
  item.append(row);
  return item;
}

/** The first time after the move to an ordered list: which rules that used to agree to disagree now go by their order (R2). */
function orderNotice(list: BrowserListView): HTMLElement | null {
  if (!list.orderNotice) return null;
  const dismiss = button(t('automation_orderNoticeDismiss', 'Got it'), 'btn btn-secondary btn-sm', () => {
    dismiss.disabled = true;
    void send({ kind: 'known.automation.browser.notice.dismiss' }).then((reply) => { dismiss.disabled = false; if (!reply.ok) failed(); });
  });
  const pairs = list.orderNotice.slice(0, 3).map((pair) => t('automation_orderNoticePair', '“$1” before “$2”', pair.upper, pair.lower)).join(', ');
  return inlineAlert('info', list.orderNotice.length
    ? t('automation_orderNoticePairs', 'Rules here now go from the top, and the first that matches decides. Where two of them used to disagree and left the page where you saved it, the upper one files it now: $1. Move them to change that.', pairs)
    : t('automation_orderNotice', 'Rules here now go from the top, and the first that matches decides.'), dismiss);
}

/** The section: the list, or the first-visit empty state. */
export function ruleListGroup(view: AutomationStateView): HTMLElement {
  const list = view.browserList;
  const section = el('section', undefined, 'set-group automation-browser');
  section.setAttribute('aria-labelledby', 'automation-browser-heading');
  const head = el('div', undefined, 'set-group-head automation-group-head');
  const title = el('h2', t('automation_browserRules', 'Rules in this browser')); title.id = 'automation-browser-heading';
  if (view.browserRules.length) title.append(el('span', String(view.browserRules.length), 'automation-count'));
  // The account's pause is for every automation here, these rules too (design 01 §7.5).
  const paused = view.account === 'signedIn' && view.state === 'paused';
  head.append(title, el('p', paused
    ? t('automation_browserLedePaused', 'Paused with your account’s automations. They file pages again when you resume on the web.')
    : !list.enabled ? t('automation_listOffLede', 'Switched off: pages you save keep the folder you save them to.')
      : view.account === 'signedIn'
        ? t('automation_listLedeSignedIn', 'Only this browser uses them, after your account’s rules, from the top of the list: the first that matches decides. For pages you save with the Know-N button or menu, not the browser’s star. A folder you pick yourself always wins.')
        : t('automation_listLede', 'Tried from the top, and the first that matches decides. They file pages you save with the Know-N button or menu, not the browser’s star, even offline and with no account. A folder you pick yourself always wins.'), 'detail'));
  const tools = el('div', undefined, 'automation-list-tools');
  const newSet = button(t('automation_newSet', 'New set'), 'btn btn-secondary btn-sm', () => openSetDialog(null, newSet));
  tools.append(newSet);
  if (list.entries.length) {
    tools.append(toggle(t('automation_listUse', 'Use rules in this browser'), list.enabled,
      async (enabled) => (await send({ kind: 'known.automation.browser.list.enable', enabled })).ok, 'toggle automation-list-switch'));
  }
  head.append(tools);
  section.append(head);
  for (const notice of [orderNotice(list), overlapNotice(view)]) if (notice) section.append(notice);
  if (!list.entries.length) {
    const card = el('div', undefined, 'set-card');
    const make = button(t('automation_newRule', 'New rule'), view.account === 'signedIn' ? 'btn btn-secondary btn-sm' : 'btn btn-primary btn-sm');
    make.addEventListener('click', () => openRuleEditor(null, make, { account: offersAccountRules(view) }));
    card.append(emptyBlock({ icon: 'bolt', title: t('automation_browserEmptyTitle', 'No rules in this browser yet'),
      hint: t('automation_browserEmptyHint', 'Tell Know-N once that pages from arxiv.org go to Papers, and each one you save lands there.'), action: make }));
    section.append(card);
    return section;
  }
  const context: Context = { view, list, paused, sets: listSets(view), drag: dragAndDrop(list) };
  const rows = el('ul', undefined, 'list-card automation-rules rule-list');
  rows.setAttribute('aria-label', t('automation_listLabel', 'Rules in this browser, in the order they are tried'));
  for (const entry of list.entries) {
    rows.append(entry.kind === 'rule' ? ruleRow(entry.rule, null, context) : entry.kind === 'set' ? setBlock(entry.set, context) : subscriptionRow(entry, context));
  }
  section.append(rows);
  return section;
}

/** The sets of the list, for the page's own New rule. */
export const listSets = (view: AutomationStateView) =>
  view.browserList.entries.flatMap((entry) => entry.kind === 'set' ? [{ id: entry.set.id, name: entry.set.name }] : []);
