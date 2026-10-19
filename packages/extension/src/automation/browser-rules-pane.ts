import { createDialog, dialogButton } from '../dialog.js';
import { createIcon } from '../icons.js';
import { t, tn } from '../i18n.js';
import { button, el, iconButton, inlineAlert } from '../library-dom.js';
import { showToast } from '../toast.js';
import type { AutomationStateView, BrowserRuleOverlapView, BrowserRuleView } from './messages.js';
import { sendRuleCommand as send } from './rule-command.js';
import { ruleConditions } from './status-ui.js';

/**
 * Where this browser's rules meet the account's (AW-69, AW-71, follow-ups U2, U5): the overlap
 * notice and its review, the lines and badges a rule row adds about the account, and Add mine to
 * the account. The list itself is rule-list-pane.ts; nothing here decides what a rule matches.
 */
function badge(label: string, tone?: 'warning'): HTMLElement {
  const node = el('span', label, 'badge');
  if (tone) node.dataset.tone = tone;
  return node;
}

/** Signed in to a server with a web editor: a new rule may be for all the account's devices (follow-up U2). */
export const offersAccountRules = (view: AutomationStateView): boolean => view.account === 'signedIn' && Boolean(view.webUrl);

/** One notice for the overlaps the Owner has not looked at yet; the rows say the rest. Null when there are none. */
export function overlapNotice(view: AutomationStateView): HTMLElement | null {
  const open = view.browserRules.filter((rule) => rule.account && !rule.account.reviewed);
  if (!open.length) return null;
  const review = button(t('automation_overlapReview', 'Review'), 'btn btn-secondary btn-sm', () => openOverlapReview(open, review));
  return inlineAlert('warning', tn('automation_overlapNotice', open.length, '$1 of your browser rules overlaps your account’s rules.',
    '$1 of your browser rules overlap your account’s rules.'), review);
}

/** The lines a rule row adds about the account: a move that is stuck or under way, an overlap, a folder only here. */
export function accountNotes(rule: BrowserRuleView): HTMLElement[] {
  const notes: HTMLElement[] = [];
  if (rule.movingStale) notes.push(...staleMove(rule));
  else if (rule.moving) notes.push(noteLine('sync', t('automation_movingLine', 'Waiting for your account’s copy. Until it arrives, this browser keeps using this one.')));
  else if (rule.account) notes.push(overlapLine(rule.account));
  if (rule.localOnly) notes.push(noteLine('lock', t('automation_localOnlyLine', 'Only in this browser: its folder isn’t synced.')));
  return notes;
}

/** The badge a switched-on rule shows about the account, after its own state. */
export function accountBadge(rule: BrowserRuleView): HTMLElement | null {
  if (rule.movingStale) return badge(t('automation_movingStaleBadge', 'Not on yet'), 'warning');
  if (rule.moving) return badge(t('automation_movingBadge', 'Moving'));
  if (rule.account && !rule.account.reviewed) {
    return rule.account.kind === 'conflict' ? badge(t('automation_overlapBadge', 'Overlaps'), 'warning') : badge(t('automation_duplicateBadge', 'Same as account'));
  }
  return null;
}

/** Add to your account, for a rule whose folder is synced and that is not already on its way (AW-71). */
export function moveToAccountAction(rule: BrowserRuleView): HTMLButtonElement | null {
  if (!rule.move || rule.moving) return null;
  const { url } = rule.move;
  return iconButton('upload', t('automation_moveToAccount', 'Add to your account'), () => moveToAccount(rule.id, url));
}

/** "Your account's rule “arXiv papers” files these in Academic first · 37 of your bookmarks match both." */
function overlapSentence(overlap: BrowserRuleOverlapView): string {
  if (overlap.kind === 'duplicate') return t('automation_duplicateLine', 'Your account’s rule “$1” does the same.', overlap.rule.name);
  return overlap.rule.folder ? t('automation_overlapLine', 'Your account’s rule “$1” files these in $2 first.', overlap.rule.name, overlap.rule.folder)
    : t('automation_overlapLineElsewhere', 'Your account’s rule “$1” takes these first.', overlap.rule.name);
}
function pagesSentence(overlap: BrowserRuleOverlapView): string {
  return overlap.pages ? tn('automation_overlapPages', overlap.pages, '$1 of your bookmarks matches both.', '$1 of your bookmarks match both.')
    : t('automation_overlapPossible', 'They can match the same pages.');
}

function noteLine(icon: 'sync' | 'lock' | 'alert', copy: string): HTMLElement {
  const line = el('p', undefined, 'list-row-meta automation-overlap');
  line.append(createIcon(icon, 12), el('span', copy, 'grow'));
  return line;
}

/**
 * A move the account has not finished after a day (follow-up U5): the rule was never turned on there, or
 * was changed so it no longer does the same. Say so, and offer both ways out.
 */
function staleMove(rule: BrowserRuleView): HTMLElement[] {
  const line = noteLine('alert', t('automation_movingStaleLine', 'Your account doesn’t have it yet. Turn it on on the web, or keep it in this browser.'));
  line.dataset.tone = 'warning';
  const actions = el('div', undefined, 'automation-stale-actions');
  if (rule.move) {
    const open = el('a', t('automation_movingOpenWeb', 'Open on the web'), 'btn btn-secondary btn-sm');
    open.href = rule.move.url; open.target = '_blank'; open.rel = 'noopener';
    open.append(createIcon('arrow-up-right', 12));
    actions.append(open);
  }
  const keep = button(t('automation_movingKeep', 'Keep in this browser'), 'btn btn-ghost btn-sm', () => {
    keep.disabled = true;
    void send({ kind: 'known.automation.browser.stay', id: rule.id }).then((reply) => {
      keep.disabled = false;
      showToast(reply.ok ? t('automation_movingKept', '“$1” stays in this browser.', rule.name) : t('automation_browserSaveFailed', 'Couldn’t save this rule. Try again.'),
        reply.ok ? 'ok' : 'error', { announce: true });
    });
  });
  actions.append(keep);
  return [line, actions];
}

/**
 * Add mine to the account (AW-71): the web editor opens filled in with this rule, where the Owner previews
 * and turns it on. This rule keeps filing until the account's enabled copy reaches this browser.
 */
function moveToAccount(id: string, url: string): void {
  window.open(url, '_blank', 'noopener');
  void send({ kind: 'known.automation.browser.moving', id }).then((reply) => {
    showToast(reply.ok ? t('automation_moveStarted', 'Finish on the web: preview the rule and turn it on. This browser keeps using its copy until then.')
      : t('automation_browserSaveFailed', 'Couldn’t save this rule. Try again.'), reply.ok ? 'info' : 'error', { announce: true });
  });
}

function overlapLine(overlap: BrowserRuleOverlapView): HTMLElement {
  const line = el('p', undefined, 'list-row-meta automation-overlap');
  if (!overlap.reviewed && overlap.kind === 'conflict') line.dataset.tone = 'warning';
  line.append(createIcon(overlap.kind === 'duplicate' ? 'check-circle' : 'alert', 12), el('span', overlap.kind === 'conflict' && overlap.pages
    ? `${overlapSentence(overlap)} ${pagesSentence(overlap)}` : overlapSentence(overlap), 'grow'));
  return line;
}

/**
 * Where this browser's rules and the account's meet (AW-69): for each, keep both, use the account's
 * (switch this one off) or, for a duplicate, remove this one. Nothing changes until the Owner chooses.
 */
function openOverlapReview(rules: readonly BrowserRuleView[], trigger: HTMLElement): void {
  const { dialog, body, actions } = createDialog(t('automation_overlapTitle', 'Your rules and your account’s'), 'automation-review');
  body.append(el('p', t('automation_overlapIntro', 'Your account’s rules run first. Where they also match a page, a rule in this browser doesn’t file it.')));
  const list = el('ul', undefined, 'automation-review-list');
  let left = rules.length;
  const done = dialogButton(t('common_done', 'Done'), 'primary');
  done.addEventListener('click', () => dialog.close());
  for (const rule of rules) {
    const overlap = rule.account!;
    const item = el('li', undefined, 'automation-review-item');
    const pair = el('dl', undefined, 'automation-review-pair');
    const recipe = (conditions: string, folder: string | null) => folder ? `${conditions} → ${folder}` : conditions;
    pair.append(el('dt', t('automation_overlapThisBrowser', 'This browser')), el('dd', `${rule.name}: ${recipe(ruleConditions(rule.match), rule.folder?.title ?? null)}`),
      el('dt', t('automation_overlapYourAccount', 'Your account')), el('dd', `${overlap.rule.name}: ${recipe(ruleConditions(overlap.rule.match), overlap.rule.folder)}`));
    const fact = el('p', overlap.kind === 'duplicate' ? overlapSentence(overlap) : pagesSentence(overlap), 'mgr-hint');
    const choices = el('div', undefined, 'automation-review-actions');
    const settle = (message: object, copy: string) => {
      for (const node of Array.from(choices.querySelectorAll('button'))) node.disabled = true;
      void send(message).then((reply) => {
        if (!reply.ok) {
          for (const node of Array.from(choices.querySelectorAll('button'))) node.disabled = false;
          showToast(t('automation_browserSaveFailed', 'Couldn’t save this rule. Try again.'), 'error', { announce: true });
          return;
        }
        choices.replaceChildren(el('p', copy, 'automation-review-done'));
        if (--left === 0) done.focus();
      });
    };
    const keep = { kind: 'known.automation.browser.review', id: rule.id, accountRuleId: overlap.rule.id, key: overlap.reviewKey };
    if (overlap.kind === 'conflict') {
      choices.append(
        button(t('automation_overlapKeepBoth', 'Keep both'), 'btn btn-secondary btn-sm', () => settle(keep,
          t('automation_overlapKeptBoth', 'Kept both. This rule files what the account’s doesn’t match.'))),
        button(t('automation_overlapUseAccount', 'Use the account’s'), 'btn btn-ghost btn-sm', () => settle(
          { kind: 'known.automation.browser.enable', id: rule.id, enabled: false }, t('automation_overlapUsedAccount', 'Turned this rule off.'))));
      // Moving needs the folder in the synced collection; the row says when it isn't.
      const move = rule.move;
      if (move && !rule.moving) {
        choices.append(button(t('automation_overlapMove', 'Add mine to the account'), 'btn btn-ghost btn-sm', () => {
          window.open(move.url, '_blank', 'noopener');
          settle({ kind: 'known.automation.browser.moving', id: rule.id },
            t('automation_overlapMoving', 'Opened on the web. Preview it there and turn it on; this browser then stops using its copy.'));
        }));
      }
    } else {
      choices.append(
        button(t('automation_duplicateRemove', 'Remove mine'), 'btn btn-secondary btn-sm', () => settle(
          { kind: 'known.automation.browser.remove', id: rule.id }, t('automation_duplicateRemoved', 'Removed this rule.'))),
        button(t('automation_duplicateKeep', 'Keep mine'), 'btn btn-ghost btn-sm', () => settle(keep, t('automation_duplicateKept', 'Kept this rule.'))));
    }
    item.append(el('p', rule.name, 'automation-review-name'), pair, fact, choices);
    list.append(item);
  }
  body.append(list);
  actions.append(done);
  dialog.addEventListener('close', () => { dialog.remove(); if (trigger.isConnected) trigger.focus(); });
  document.body.append(dialog); dialog.showModal();
  list.querySelector<HTMLButtonElement>('button')?.focus();
}
