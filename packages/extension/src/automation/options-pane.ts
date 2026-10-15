import { faviconTile } from '../bookmark-manager-dom.js';
import { createIcon } from '../icons.js';
import { button, el, emptyBlock, inlineAlert } from '../library-dom.js';
import { formatMoment, SLOT, t, tn, withSlot } from '../i18n.js';
import { when } from '../subscriptions-ui/dom.js';
import { AUTOMATION_CHANGED_KEY, type AutomationResponse, type AutomationServerRuleView, type AutomationServerView,
  type AutomationStateView } from './messages.js';
import { browserRulesGroup, openBrowserRuleEditor } from './browser-rules-pane.js';
import { placementBadge, ruleConditions, ruleServerBadge, ruleServerMeta, runRow, serverFreshness } from './status-ui.js';

/**
 * Options › Automations: the account's rules and this browser's own, laid out
 * like the web's Automations page.
 *
 * Signed in, one status card says whether this browser has a usable copy of the
 * account's rules and how fresh it is, with the account-wide pause (made on the
 * web). The account's rules follow, each in the web's words ("From arxiv.org →
 * Academic") and each opening its page on the web, where they are made and
 * changed. This browser's own rules come next (browser-rules-pane.ts); they are
 * made here and need no account, so signed out they lead the page. Recent
 * activity keeps this browser's placements and the server's runs apart, in two
 * tabs. Everything shown comes from the worker (status-ui.ts); nothing here
 * decides whether a rule runs.
 */
export interface AutomationsPane {
  activate(): void;
  deactivate(): void;
}

type Tone = 'success' | 'warning' | 'off';

/** The status card's headline, what it means here, and the mark's tone. */
function statusLine(view: AutomationStateView): { tone: Tone; title: string; hint: string } {
  switch (view.state) {
    case 'active': return { tone: 'success', title: t('automation_statusOnTitle', 'Automations are on'),
      hint: view.rules.length
        ? tn('automation_statusOnRulesHint', view.rules.length, '$1 account rule files bookmarks you save in this browser, even offline.',
          '$1 account rules file bookmarks you save in this browser, even offline.')
        : t('automation_statusOnNoRulesHint', 'None of your account’s rules file bookmarks in this browser yet.') };
    case 'paused': return { tone: 'warning', title: t('automation_statusPausedTitle', 'All automations are paused'), hint: pausedHint(view) };
    case 'expired': return { tone: 'warning', title: t('automation_statusOutOfDateTitle', 'Rules are out of date'),
      hint: t('automation_statusOutOfDateHint', 'Rules are out of date; connect to refresh. Saving still works, at the folder you choose.') };
    case 'none': return view.problem === 'unavailable'
      ? { tone: 'off', title: t('automation_statusOffTitle', 'Automations are off on this server'),
        hint: t('automation_statusUnavailableHint', 'Automations aren’t turned on for this server.') }
      : { tone: 'off', title: t('automation_statusNotSetUpTitle', 'No rules here yet'),
        hint: t('automation_statusNoneHint', 'No rules have reached this browser yet.') };
  }
}

function pausedHint(view: AutomationStateView): string {
  const date = view.pausedAt ? formatMoment(view.pausedAt, 'date') : null;
  if (view.pausedBy === 'owner' && date) return t('automation_pausedByYouOn', 'Paused by you on $1. Bookmarks keep the folder you save them to.', date);
  if (view.pausedBy === 'restore') return t('automation_pausedRestore', 'Paused after a server restore. Bookmarks keep the folder you save them to.');
  if (view.pausedBy === 'capacity') return t('automation_pausedCapacity', 'Paused while the server catches up. Bookmarks keep the folder you save them to.');
  return t('automation_pausedHint', 'Paused on the server. Bookmarks keep the folder you save them to.');
}

/** Only what the status card cannot say: a bundle was refused and an older one is still in force. */
function notice(view: AutomationStateView): HTMLElement | null {
  return view.problem === 'rejected'
    ? inlineAlert('warning', t('automation_noticeRejected', 'The server sent rules this browser can’t use. The previous rules stay in force.'))
    : null;
}

function webLink(label: string, href: string, className = 'btn btn-secondary btn-sm'): HTMLAnchorElement {
  const link = el('a', undefined, className);
  link.href = href; link.target = '_blank'; link.rel = 'noreferrer';
  link.append(el('span', label), createIcon('arrow-up-right', 14));
  return link;
}

function group(id: string, heading: string, body: HTMLElement, lede?: string, action?: HTMLElement): HTMLElement {
  const section = el('section', undefined, 'set-group');
  section.setAttribute('aria-labelledby', id);
  const head = el('div', undefined, 'set-group-head');
  const title = el('h2', heading); title.id = id;
  head.append(title);
  if (lede) head.append(el('p', lede, 'detail'));
  if (action) { head.classList.add('automation-group-head'); head.append(action); }
  section.append(head, body);
  return section;
}

/** How fresh this browser's copy of the rules is, in one quiet line. */
function freshness(view: AutomationStateView): HTMLElement {
  const line = el('p', undefined, 'automation-status-fresh');
  if (view.lastRefreshAt) {
    // The relative time keeps its exact-time tooltip wherever the translation puts it.
    line.append(...withSlot(t('automation_updatedAt', 'Updated $1.', SLOT), when(view.lastRefreshAt)), ' ');
  }
  // Without rules here yet there is no copy to keep offline and no pause to pass on.
  line.append(view.state === 'none' ? t('automation_freshnessHintNone', 'This browser checks for rules every 5 minutes.')
    : view.expiresAt && view.state !== 'expired'
      ? t('automation_freshnessHint', 'This browser checks every 5 minutes. Offline, it keeps using its copy until $1, and a pause you make on the web reaches it at the next check.', formatMoment(view.expiresAt))
      : t('automation_freshnessHintShort', 'This browser checks every 5 minutes. A pause you make on the web reaches it at the next check.'));
  return line;
}

/** The one card for this browser's state: what it is doing, how fresh, and the account-wide switch. */
function statusCard(view: AutomationStateView, refresh: () => void, busy: boolean): HTMLElement {
  const status = statusLine(view);
  const card = el('section', undefined, 'set-card automation-status');
  card.setAttribute('aria-labelledby', 'automation-status-title');
  card.dataset.tone = status.tone;
  const main = el('div', undefined, 'automation-status-main');
  const mark = el('span', undefined, 'automation-status-mark'); mark.setAttribute('aria-hidden', 'true');
  mark.append(createIcon(view.state === 'paused' ? 'pause' : 'bolt', 18));
  const copy = el('div', undefined, 'automation-status-copy');
  const title = el('h2', status.title, 'automation-status-title'); title.id = 'automation-status-title';
  copy.append(title, el('p', status.hint, 'automation-status-hint'), freshness(view));
  const check = button(busy ? t('automation_checking', 'Checking…') : t('automation_checkNow', 'Check now'), 'btn btn-secondary btn-sm', refresh);
  check.disabled = busy; if (busy) check.setAttribute('aria-busy', 'true');
  main.append(mark, copy, check);
  card.append(main);
  // Pausing is the server's: cookie writes from this page aren't allowed, so the switch lives on the web.
  if (view.webUrl && !(view.state === 'none' && view.problem === 'unavailable')) {
    const paused = view.state === 'paused';
    card.append(row(paused ? t('automation_resumeAll', 'Resume automations') : t('automation_pauseAll', 'Pause all automations'),
      t('automation_pauseHint', 'You pause and resume on the web; rules in this browser pause with them. This browser follows at its next check, within 5 minutes.'),
      webLink(paused ? t('automation_resumeOnWeb', 'Resume on the web') : t('automation_pauseOnWeb', 'Pause on the web'), view.webUrl)));
  }
  return card;
}

function row(title: string, hint: string, control: Node): HTMLElement {
  const node = el('div', undefined, 'set-row');
  const text = el('div', undefined, 'set-row-text');
  text.append(el('p', title, 'set-row-title'), el('p', hint, 'set-row-hint'));
  const right = el('div', undefined, 'set-row-control'); right.append(control);
  node.append(text, right);
  return node;
}

/** Server-side state of a rule: its badge when it isn't simply on, and the server's counts of waiting work. */
function withServer(main: HTMLElement, tail: HTMLElement, server: AutomationServerRuleView | undefined, own: HTMLElement | null): void {
  const meta = server ? ruleServerMeta(server) : null;
  if (meta) main.append(meta);
  const state = own ?? (server ? ruleServerBadge(server.state) : null);
  if (state) tail.append(state);
}

function ruleLink(webUrl: string | null, id: string): HTMLAnchorElement | HTMLDivElement {
  if (!webUrl) return el('div', undefined, 'list-row automation-rule');
  const link = el('a', undefined, 'list-row automation-rule');
  link.href = `${webUrl.replace(/\/$/u, '')}/rules/${encodeURIComponent(id)}`;
  link.target = '_blank'; link.rel = 'noreferrer';
  link.title = t('automation_ruleOpenWeb', 'Open this rule on the web to change it');
  return link;
}

function rulesGroup(view: AutomationStateView): HTMLElement {
  const server = new Map((view.server?.rules ?? []).map((rule) => [rule.id, rule]));
  // Rules with no browser part (a digest, say) still belong here: their waiting work is the Owner's to see.
  const serverOnly = (view.server?.rules ?? []).filter((rule) => !rule.inBrowser && rule.state !== 'archived' && rule.state !== 'draft');
  const heading = t('automation_accountRules', 'Your account’s rules');
  if (!view.rules.length && !serverOnly.length) {
    const card = el('div', undefined, 'set-card');
    const make = view.webUrl ? webLink(t('automation_newRuleWeb', 'New rule on the web'), `${view.webUrl.replace(/\/$/u, '')}/new`) : undefined;
    card.append(emptyBlock({ icon: 'bolt', title: t('automation_noAccountRulesTitle', 'No account rules here yet'),
      hint: view.state === 'paused' ? t('automation_noRulesPausedHint', 'Rules come back here when you resume automations on the web.')
        : t('automation_noAccountRulesHint', 'On the web, open a folder and choose Automate… to file pages from a site there, on every device.'),
      ...(make && view.state !== 'paused' ? { action: make } : {}) }));
    return group('automation-rules-heading', heading, card);
  }
  const list = el('ul', undefined, 'list-card automation-rules');
  for (const rule of view.rules) {
    const item = el('li'), link = ruleLink(view.webUrl, rule.id);
    const tile = el('span', undefined, 'favicon-tile'); tile.append(createIcon('bolt', 16));
    const main = el('div', undefined, 'list-row-main');
    const meta = el('p', undefined, 'list-row-meta automation-recipe');
    meta.append(el('span', ruleConditions(rule.match), 'grow'), createIcon('arrow-right', 12));
    if (rule.resolved && rule.folder) meta.append(createIcon('folder', 12), el('span', rule.folder, 'automation-recipe-folder'));
    else meta.append(el('span', t('automation_ruleFolderNotHere', 'a folder not synced here'), 'automation-recipe-missing'));
    main.append(el('p', rule.name, 'list-row-title'), meta);
    const tail = el('div', undefined, 'list-row-tail');
    const waiting = rule.resolved ? null : el('span', t('automation_ruleWaiting', 'Waiting'), 'badge');
    if (waiting) { waiting.dataset.tone = 'warning'; waiting.title = t('automation_ruleFolderMissing', 'Its folder isn’t in this browser’s synced folders, so the rule waits.'); }
    withServer(main, tail, server.get(rule.id), waiting);
    if (view.webUrl) tail.append(createIcon('arrow-up-right', 14));
    link.append(tile, main, tail);
    item.append(link);
    list.append(item);
  }
  for (const rule of serverOnly) {
    const item = el('li'), link = ruleLink(view.webUrl, rule.id);
    const tile = el('span', undefined, 'favicon-tile'); tile.append(createIcon('server', 16));
    const main = el('div', undefined, 'list-row-main');
    const meta = el('p', undefined, 'list-row-meta');
    meta.append(el('span', t('automation_ruleServerOnly', 'Works on your server; nothing to file here.'), 'grow'));
    main.append(el('p', rule.name, 'list-row-title'), meta);
    const tail = el('div', undefined, 'list-row-tail');
    withServer(main, tail, rule, null);
    if (view.webUrl) tail.append(createIcon('arrow-up-right', 14));
    link.append(tile, main, tail);
    item.append(link);
    list.append(item);
  }
  const make = view.webUrl && view.state !== 'paused'
    ? webLink(t('automation_newRuleWeb', 'New rule on the web'), `${view.webUrl.replace(/\/$/u, '')}/new`, 'btn btn-ghost btn-sm') : undefined;
  // A paused bundle carries no rules: say where the filing rules went instead of listing them.
  return group('automation-rules-heading', heading, list, view.state === 'paused'
    ? t('automation_rulesPausedLede', 'Rules that file bookmarks come back here when you resume automations on the web.')
    : t('automation_accountRulesLede', 'They work on every device, before this browser’s own rules. Open one to change it on the web.'), make);
}

function placementList(view: AutomationStateView): HTMLElement {
  if (!view.placements.length) {
    return emptyBlock({ icon: 'bookmark', title: t('automation_noPlacementsTitle', 'Nothing filed here yet'),
      hint: t('automation_noPlacementsHint', 'When a rule files a bookmark you save in this browser, it shows up here.') });
  }
  const list = el('ul', undefined, 'automation-rules automation-placements');
  for (const placement of view.placements) {
    const item = el('li', undefined, 'list-row');
    const main = el('div', undefined, 'list-row-main');
    const meta = el('p', undefined, 'list-row-meta');
    meta.append(createIcon('folder', 12), el('span', placement.folder), el('span', undefined, 'sep'),
      el('span', t('automation_placementRule', 'Rule “$1”', placement.ruleName), 'grow'), el('span', undefined, 'sep'), when(placement.at));
    const title = el('p', placement.title || placement.host, 'list-row-title'); title.title = placement.host;
    main.append(title, meta);
    item.append(faviconTile(placement.url), main);
    const badge = placementBadge(placement.state);
    if (badge) { const tail = el('div', undefined, 'list-row-tail'); tail.append(badge); item.append(tail); }
    list.append(item);
  }
  return list;
}

/** What the server did after bookmarks synced: its runs, newest first, and how old this answer is. */
function serverPanel(server: AutomationServerView, webUrl: string | null): HTMLElement {
  const body = el('div', undefined, 'automation-server');
  if (server.runs.length) {
    const list = el('ul', undefined, 'automation-rules automation-runs');
    for (const run of server.runs.slice(0, 8)) list.append(runRow(run));
    body.append(list, serverFreshness(server));
  } else {
    body.append(serverEmpty(server, webUrl));
    // Only an answer that was read has an age worth stating.
    if (server.fetchedAt) body.append(serverFreshness(server));
  }
  return body;
}

function serverEmpty(server: AutomationServerView, webUrl: string | null): HTMLElement {
  if (server.problem === 'signedOut') {
    const signIn = webUrl ? el('a', t('automation_openWeb', 'Open Automations'), 'btn btn-secondary btn-sm') : null;
    if (signIn && webUrl) { signIn.href = webUrl; signIn.target = '_blank'; signIn.rel = 'noreferrer'; }
    return emptyBlock({ icon: 'server', title: t('automation_serverSignInTitle', 'Sign in on the web to see runs'),
      hint: t('automation_serverSignInHint', 'This page reads your server’s runs with your web sign-in in this browser.'), ...(signIn ? { action: signIn } : {}) });
  }
  if (server.fetchedAt) return emptyBlock({ icon: 'play', title: t('automation_noRunsTitle', 'Nothing has run yet'),
    hint: t('automation_noRunsHint', 'Runs show up here after a rule acts on a synced bookmark.') });
  if (server.problem) return emptyBlock({ icon: 'server', title: server.problem === 'invalid'
    ? t('automation_serverInvalidTitle', 'Couldn’t read your server’s runs') : t('automation_serverUnreachableTitle', 'Couldn’t reach your server'),
    hint: t('automation_serverRetryHint', 'Saving and filing in this browser don’t need it. This page tries again in a few minutes.') });
  return emptyBlock({ icon: 'server', title: t('automation_serverChecking', 'Checking your server…') });
}

type ActivityTab = 'browser' | 'server';

/**
 * Recent activity, kept apart by where it happened: what this browser filed
 * (the server confirms each one after it syncs) and what the server did
 * afterwards. Two tabs over one card, never one merged list.
 */
function activityGroup(view: AutomationStateView, chosen: ActivityTab | null, choose: (tab: ActivityTab) => void): HTMLElement | null {
  const tabs: ActivityTab[] = view.server ? ['browser', 'server'] : ['browser'];
  if (!view.placements.length && !view.server) return null;
  const current = chosen && tabs.includes(chosen) ? chosen : view.placements.length || !view.server ? 'browser' : 'server';
  const section = el('section', undefined, 'set-group automation-activity');
  section.setAttribute('aria-labelledby', 'automation-activity-heading');
  const head = el('div', undefined, 'set-group-head automation-activity-head');
  const title = el('h2', t('automation_recentActivity', 'Recent activity')); title.id = 'automation-activity-heading';
  head.append(title);
  const card = el('div', undefined, 'list-card automation-activity-card');
  const rail = el('div', undefined, 'view-switch automation-tabs');
  rail.setAttribute('role', 'tablist'); rail.setAttribute('aria-labelledby', 'automation-activity-heading');
  const labels: Record<ActivityTab, [string, string, number]> = {
    browser: ['automation-placements-heading', t('automation_tabBrowser', 'This browser'), view.placements.length],
    server: ['automation-server-heading', t('automation_tabServer', 'Your server'), view.server?.runs.length ?? 0],
  };
  const panels: Record<ActivityTab, () => HTMLElement> = {
    browser: () => {
      const panel = el('div', undefined, 'automation-panel');
      // Only an account rule's placement has a server to confirm it.
      const confirmed = view.placements.some((placement) => placement.state !== 'filed');
      panel.append(el('p', confirmed ? t('automation_recentPlacementsLede', 'Filed in this browser. The server confirms each one after it syncs.')
        : t('automation_recentPlacementsLedeLocal', 'Filed in this browser by your rules.'), 'automation-panel-lede'), placementList(view));
      return panel;
    },
    server: () => {
      const panel = el('div', undefined, 'automation-panel');
      panel.append(el('p', t('automation_onServerLede', 'Work your server does after a bookmark syncs. Filing in this browser never waits for it.'), 'automation-panel-lede'),
        serverPanel(view.server!, view.webUrl));
      return panel;
    },
  };
  const buttons: HTMLButtonElement[] = [];
  for (const tab of tabs) {
    const [id, label, count] = labels[tab];
    const tabButton = button(label, '', () => choose(tab));
    tabButton.id = id; tabButton.setAttribute('role', 'tab');
    tabButton.setAttribute('aria-controls', `${id}-panel`);
    tabButton.setAttribute('aria-selected', String(tab === current));
    tabButton.tabIndex = tab === current ? 0 : -1;
    if (count) tabButton.append(el('span', String(count), 'automation-tab-count'));
    buttons.push(tabButton);
    rail.append(tabButton);
    const panel = panels[tab]();
    panel.id = `${id}-panel`; panel.setAttribute('role', 'tabpanel'); panel.setAttribute('aria-labelledby', id);
    panel.hidden = tab !== current;
    card.append(panel);
  }
  // Arrow keys move between the tabs (APG tabs, automatic activation).
  rail.addEventListener('keydown', (event) => {
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (at < 0 || (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft')) return;
    event.preventDefault();
    const next = tabs[(at + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length]!;
    choose(next);
    document.getElementById(labels[next][0])?.focus();
  });
  head.append(rail);
  section.append(head, card);
  return section;
}

/** Signed out: what an account adds, in one quiet row. */
function accountCard(): HTMLElement {
  const card = el('section', undefined, 'set-card automation-account');
  card.setAttribute('aria-label', t('automation_accountRules', 'Your account’s rules'));
  const signIn = el('a', t('common_signIn', 'Sign in'), 'btn btn-secondary btn-sm'); signIn.href = '#account';
  card.append(row(t('automation_accountRules', 'Your account’s rules'),
    t('automation_accountRulesSignIn', 'Sign in to a COLP server to also use the rules you keep there. They work on every device, and run before this browser’s.'), signIn));
  return card;
}

export function bindAutomationsPane(pane: HTMLElement): AutomationsPane {
  const body = pane.querySelector<HTMLElement>('[data-automations-body]')!;
  const openWeb = pane.querySelector<HTMLAnchorElement>('[data-automations-web]')!;
  const newRule = pane.querySelector<HTMLButtonElement>('[data-automations-new]');
  let active = false, busy = false, turn = 0, last: AutomationStateView | undefined, tab: ActivityTab | null = null;

  async function load(kind: 'known.automation.state' | 'known.automation.refresh'): Promise<void> {
    const mine = ++turn;
    const response = await chrome.runtime.sendMessage(kind === 'known.automation.refresh' ? { kind, userGesture: true } : { kind })
      .catch(() => null) as AutomationResponse | null;
    if (mine !== turn || !active) return;
    if (!response?.ok || !('state' in response)) { body.replaceChildren(inlineAlert('warning', t('automation_loadFailed', 'Couldn’t read automations in this browser. Reload the page to try again.'))); return; }
    last = response.state; render(response.state);
  }
  function refresh(): void {
    if (busy) return;
    busy = true; if (last) render(last);
    void load('known.automation.refresh').finally(() => { busy = false; if (last && active) render(last); });
  }
  function render(view: AutomationStateView): void {
    openWeb.hidden = !view.webUrl || view.account === 'signedOut';
    if (view.webUrl) openWeb.href = view.webUrl;
    const parts: HTMLElement[] = [];
    if (view.account === 'signedOut') {
      // This browser's rules need no account, so they lead; the account's rules are one sign-in away.
      parts.push(browserRulesGroup(view), accountCard());
    } else {
      const alert = notice(view);
      if (alert) parts.push(alert);
      parts.push(statusCard(view, refresh, busy));
      if (view.state === 'active' || view.state === 'paused' || (view.state === 'none' && view.problem !== 'unavailable')) parts.push(rulesGroup(view));
      parts.push(browserRulesGroup(view));
    }
    const activity = activityGroup(view, tab, (next) => { tab = next; if (last) render(last); });
    if (activity) parts.push(activity);
    body.replaceChildren(...parts);
  }
  // New rule is always this browser's: the account's rules are made on the web.
  newRule?.addEventListener('click', () => openBrowserRuleEditor(null, newRule));
  chrome.storage.onChanged.addListener((changes, area) => {
    if (active && area === 'local' && AUTOMATION_CHANGED_KEY in changes) void load('known.automation.state');
  });
  return {
    activate() { active = true; void load('known.automation.state'); },
    deactivate() { active = false; turn += 1; },
  };
}
