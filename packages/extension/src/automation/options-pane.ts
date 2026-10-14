import { createIcon } from '../icons.js';
import { button, el, emptyBlock, inlineAlert } from '../library-dom.js';
import { formatMoment, t, tn } from '../i18n.js';
import { when } from '../subscriptions-ui/dom.js';
import { AUTOMATION_BUNDLE_KEY, type AutomationResponse, type AutomationStateView } from './messages.js';

/**
 * Options › Automations: what the server's rules do in this browser.
 *
 * Rules are made and changed on the web; this page shows whether this browser
 * has a usable copy, how fresh it is, and where each rule files bookmarks.
 * Everything shown comes from the worker's installed bundle; nothing here
 * decides whether a rule runs.
 */
export interface AutomationsPane {
  activate(): void;
  deactivate(): void;
}

function statusLine(view: AutomationStateView): { tone: 'success' | 'warning' | 'off'; label: string; hint: string } {
  switch (view.state) {
    case 'active': return { tone: 'success', label: tn('automation_statusOnRules', view.rules.length, 'On · $1 rule', 'On · $1 rules'),
      hint: t('automation_statusOnHint', 'Bookmarks you save go straight to the folder a rule picks, even offline.') };
    case 'paused': return { tone: 'warning', label: t('automation_statusPaused', 'Paused'), hint: pausedHint(view) };
    case 'expired': return { tone: 'warning', label: t('automation_statusOutOfDate', 'Out of date'),
      hint: t('automation_statusOutOfDateHint', 'Rules are out of date; connect to refresh. Saving still works, at the folder you choose.') };
    case 'none': return { tone: 'off', label: t('automation_statusNotSetUp', 'Not set up'),
      hint: view.problem === 'unavailable' ? t('automation_statusUnavailableHint', 'Automations aren’t turned on for this server.')
        : t('automation_statusNoneHint', 'No rules have reached this browser yet.') };
  }
}

function pausedHint(view: AutomationStateView): string {
  const date = view.pausedAt ? formatMoment(view.pausedAt, 'date') : null;
  if (view.pausedBy === 'owner' && date) return t('automation_pausedByYouOn', 'Paused by you on $1. Bookmarks keep the folder you save them to.', date);
  if (view.pausedBy === 'restore') return t('automation_pausedRestore', 'Paused after a server restore. Bookmarks keep the folder you save them to.');
  if (view.pausedBy === 'capacity') return t('automation_pausedCapacity', 'Paused while the server catches up. Bookmarks keep the folder you save them to.');
  return t('automation_pausedHint', 'Paused on the server. Bookmarks keep the folder you save them to.');
}

/** Only what the status row cannot say: a bundle was refused and an older one is still in force. */
function notice(view: AutomationStateView): HTMLElement | null {
  return view.problem === 'rejected'
    ? inlineAlert('warning', t('automation_noticeRejected', 'The server sent rules this browser can’t use. The previous rules stay in force.'))
    : null;
}

function row(title: string, hint: string | Node, control: Node): HTMLElement {
  const node = el('div', undefined, 'set-row');
  const text = el('div', undefined, 'set-row-text');
  const hintNode = el('p', undefined, 'set-row-hint'); hintNode.append(hint);
  text.append(el('p', title, 'set-row-title'), hintNode);
  const right = el('div', undefined, 'set-row-control'); right.append(control);
  node.append(text, right);
  return node;
}

function group(id: string, heading: string, body: HTMLElement, lede?: string): HTMLElement {
  const section = el('section', undefined, 'set-group');
  section.setAttribute('aria-labelledby', id);
  const head = el('div', undefined, 'set-group-head');
  const title = el('h2', heading); title.id = id;
  head.append(title);
  if (lede) head.append(el('p', lede, 'detail'));
  section.append(head, body);
  return section;
}

function statusGroup(view: AutomationStateView, refresh: () => void, busy: boolean): HTMLElement {
  const card = el('div', undefined, 'set-card');
  const status = statusLine(view);
  const value = el('span', undefined, 'set-row-value');
  const dot = el('span', undefined, 'set-dot'); dot.setAttribute('aria-hidden', 'true');
  if (status.tone !== 'success') dot.dataset.tone = status.tone;
  value.append(dot, el('span', status.label));
  card.append(row(t('automation_status', 'Status'), status.hint, value));
  const check = button(busy ? t('automation_checking', 'Checking…') : t('automation_checkNow', 'Check now'), 'btn btn-secondary btn-sm', refresh);
  check.disabled = busy; if (busy) check.setAttribute('aria-busy', 'true');
  const freshness = el('span');
  if (view.lastRefreshAt) {
    // The relative time keeps its exact-time tooltip wherever the translation puts it.
    const [before = '', after = ''] = t('automation_updatedAt', 'Updated $1.', '\u0000').split('\u0000');
    freshness.append(before, when(view.lastRefreshAt), after, ' ');
  }
  freshness.append(view.expiresAt && view.state !== 'expired'
    ? t('automation_freshnessHint', 'This browser checks every 5 minutes. Offline, it keeps using its copy until $1, and a pause you make on the web reaches it at the next check.', formatMoment(view.expiresAt))
    : t('automation_freshnessHintShort', 'This browser checks every 5 minutes. A pause you make on the web reaches it at the next check.'));
  card.append(row(t('automation_ruleUpdates', 'Rule updates'), freshness, check));
  return group('automation-browser-heading', t('automation_onThisBrowser', 'On this browser'), card);
}

function rulesGroup(view: AutomationStateView): HTMLElement {
  if (!view.rules.length) {
    const card = el('div', undefined, 'set-card');
    card.append(emptyBlock({ icon: 'fork', title: t('automation_noRulesTitle', 'No rules here yet'),
      hint: view.state === 'paused' ? t('automation_noRulesPausedHint', 'Rules come back here when you resume automations on the web.')
        : t('automation_noRulesHint', 'On the web, open a folder and choose Automate… to file pages from a site there.') }));
    return group('automation-rules-heading', t('automation_rules', 'Rules'), card);
  }
  const list = el('ul', undefined, 'list-card automation-rules');
  for (const rule of view.rules) {
    const item = el('li', undefined, 'list-row');
    const tile = el('span', undefined, 'favicon-tile'); tile.append(createIcon('fork', 16));
    const main = el('div', undefined, 'list-row-main');
    const meta = el('p', undefined, 'list-row-meta');
    if (rule.resolved && rule.folder) {
      meta.append(createIcon('folder', 12), el('span', t('automation_ruleFilesTo', 'Files into $1', rule.folder), 'grow'));
    } else {
      meta.append(el('span', t('automation_ruleFolderMissing', 'Its folder isn’t in this browser’s synced folders, so the rule waits.'), 'grow'));
    }
    main.append(el('p', rule.name, 'list-row-title'), meta);
    item.append(tile, main);
    if (!rule.resolved) { const tail = el('div', undefined, 'list-row-tail'); const badge = el('span', t('automation_ruleWaiting', 'Waiting'), 'badge'); badge.dataset.tone = 'warning'; tail.append(badge); item.append(tail); }
    list.append(item);
  }
  return group('automation-rules-heading', t('automation_rules', 'Rules'), list,
    t('automation_rulesLede', 'A folder you pick yourself always wins over a rule.'));
}

export function bindAutomationsPane(pane: HTMLElement): AutomationsPane {
  const body = pane.querySelector<HTMLElement>('[data-automations-body]')!;
  const openWeb = pane.querySelector<HTMLAnchorElement>('[data-automations-web]')!;
  let active = false, busy = false, turn = 0, last: AutomationStateView | undefined;

  async function load(kind: 'known.automation.state' | 'known.automation.refresh'): Promise<void> {
    const mine = ++turn;
    const response = await chrome.runtime.sendMessage(kind === 'known.automation.refresh' ? { kind, userGesture: true } : { kind })
      .catch(() => null) as AutomationResponse | null;
    if (mine !== turn || !active) return;
    if (!response?.ok) { body.replaceChildren(inlineAlert('warning', t('automation_loadFailed', 'Couldn’t read automations in this browser. Reload the page to try again.'))); return; }
    last = response.state; render(response.state);
  }
  function refresh(): void {
    if (busy) return;
    busy = true; if (last) render(last);
    void load('known.automation.refresh').finally(() => { busy = false; if (last && active) render(last); });
  }
  function render(view: AutomationStateView): void {
    openWeb.hidden = !view.webUrl;
    if (view.webUrl) openWeb.href = view.webUrl;
    if (view.account === 'signedOut') {
      const card = el('div', undefined, 'set-card connect-card');
      const signIn = el('a', t('common_signIn', 'Sign in'), 'btn btn-primary btn-sm'); signIn.href = '#account';
      card.append(emptyBlock({ icon: 'fork', title: t('automation_signInTitle', 'Sign in to use automations'),
        hint: t('automation_signInHint', 'Rules live on your server and file bookmarks as you save them. Saving and organizing work without them.'), action: signIn }));
      body.replaceChildren(card);
      return;
    }
    const parts: HTMLElement[] = [];
    const alert = notice(view);
    if (alert) parts.push(alert);
    parts.push(statusGroup(view, refresh, busy));
    if (view.state === 'active' || view.state === 'paused' || (view.state === 'none' && view.problem !== 'unavailable')) parts.push(rulesGroup(view));
    body.replaceChildren(...parts);
  }
  chrome.storage.onChanged.addListener((changes, area) => {
    if (active && area === 'local' && AUTOMATION_BUNDLE_KEY in changes) void load('known.automation.state');
  });
  return {
    activate() { active = true; void load('known.automation.state'); },
    deactivate() { active = false; turn += 1; },
  };
}
