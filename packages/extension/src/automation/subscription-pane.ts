import { createIcon } from '../icons.js';
import { relativeText, t, tn } from '../i18n.js';
import { button, el, iconButton, inlineAlert } from '../library-dom.js';
import { showToast } from '../toast.js';
import type { BrowserListEntryView } from './messages.js';
import { sendRuleCommand as send } from './rule-command.js';
import { ruleConditions } from './status-ui.js';
import { subscriptionOriginPattern } from './subscription-fetch.js';
import type { BrowserSubscriptionEntryView, BrowserSubscriptionView } from './subscription-messages.js';
import { confirmCopyEntry, confirmRemoveSubscription, failureText, openSubscriptionFolders, openSubscriptionSettings, siteOf } from './subscribe-dialog.js';
import { openReview } from './subscription-review-pane.js';

/**
 * A subscription in Options' list (doc 17 RS-04, RS-05, RS-10, RS-15.2): where it comes from, its
 * version and how its last fetches went, in words; its current entries in upstream order, each with
 * its switch and *Copy to my rules*; the sites it leaves alone here; and its collection with each
 * site's history. Every change is a worker command; nothing here fetches.
 */
type Entry = Extract<BrowserListEntryView, { kind: 'subscription' }>;
export interface SubscriptionParts {
  readonly moves: readonly HTMLElement[];
  readonly toggle: (label: string, on: boolean, change: (next: boolean) => Promise<boolean>) => HTMLButtonElement;
  readonly drag: (head: HTMLElement) => void;
  /** The whole list is on. */
  readonly listOn: boolean;
}
const ENTRIES_SHOWN = 50;

const failed = () => showToast(t('automation_listSaveFailed', 'Couldn’t change the list. Try again.'), 'error', { announce: true });
const badge = (label: string, tone?: 'warning') => { const node = el('span', label, 'badge'); if (tone) node.dataset.tone = tone; return node; };

/** Refresh now: the origin is asked for in the click (it answers at once when already allowed), then fetched. */
export function refreshNow(view: BrowserSubscriptionView): void {
  void chrome.permissions.request({ origins: [subscriptionOriginPattern(view.origin)] }).catch(() => false).then(async (granted) => {
    if (!granted) { showToast(t('automation_subNeedsAccess', 'Allow reading $1 to fetch this subscription.', siteOf(view.origin)), 'error', { announce: true }); return; }
    const reply = await send({ kind: 'known.automation.browser.subscription.refresh', id: view.id });
    if (!reply.ok || !('subscription' in reply)) { failed(); return; }
    const after = reply.subscription, problem = after.lastFailure && after.lastFailure.at >= (after.lastSuccessAt ?? 0) ? failureText(after) : null;
    showToast(problem ?? (after.candidateVersion ? t('automation_subUpdateWaiting', 'Version $1 is waiting for your review.', after.candidateVersion)
      : t('automation_subUpToDate', 'Up to date: version $1.', after.currentVersion ?? '')), problem ? 'error' : 'ok', { announce: true });
  });
}

function statusLine(view: BrowserSubscriptionView, entries: number): string {
  if (view.state === 'notReady') {
    const problem = failureText(view);
    return problem ? t('automation_subNotReady', 'Not ready: $1', problem) : t('automation_subNotFetched', 'Not fetched yet, so it files nothing.');
  }
  return [tn('automation_subEntries', entries, '$1 entry', '$1 entries'), t('automation_subVersion', 'version $1', view.currentVersion ?? ''),
    view.lastSuccessAt ? t('automation_subChecked', 'checked $1', relativeText(view.lastSuccessAt)) : ''].filter(Boolean).join(' · ');
}

function entryRow(entry: Entry, item: BrowserSubscriptionEntryView, parts: SubscriptionParts): HTMLLIElement {
  const view = entry.subscription!;
  const node = el('li'); node.dataset.entryId = `${entry.id}:${item.id}`;
  const row = el('div', undefined, 'list-row automation-rule automation-browser-rule');
  if (!item.enabled || !entry.enabled || !parts.listOn || view.state !== 'ready') row.dataset.off = '';
  const tile = el('span', undefined, 'favicon-tile'); tile.append(createIcon('bolt', 16));
  const main = el('div', undefined, 'list-row-main');
  const meta = el('p', undefined, 'list-row-meta automation-recipe');
  meta.append(el('span', ruleConditions(item.match), 'grow'), createIcon('arrow-right', 12));
  if (item.needsFolder) meta.append(el('span', t('automation_recipeRoleUnbound', 'no folder yet for “$1”', item.role ?? ''), 'automation-recipe-missing'));
  else if (item.folder) {
    const folder = el('span', item.folder.title, 'automation-recipe-folder'); folder.title = item.folder.path.join(' › ');
    meta.append(createIcon('folder', 12), folder);
  } else meta.append(el('span', t('automation_browserFolderHere', 'a folder in this browser')));
  main.append(el('p', item.name, 'list-row-title'), meta);
  const tail = el('div', undefined, 'list-row-tail');
  const actions = el('span', undefined, 'row-actions-hover');
  const copy = iconButton('fork', t('automation_copyToMine', 'Copy to my rules'), () => confirmCopyEntry(entry.id, view.name, item, copy));
  actions.append(copy);
  tail.append(actions);
  if (item.needsFolder) tail.append(badge(t('automation_ruleNeedsFolder', 'Needs a folder'), 'warning'));
  else if (!item.enabled) tail.append(badge(t('automation_browserOff', 'Off')));
  row.append(tile, main, tail, parts.toggle(t('automation_browserUse', 'Use “$1”', item.name), item.enabled, async (enabled) =>
    (await send({ kind: 'known.automation.browser.subscription.adjust', id: entry.id, change: { kind: 'entry', entryId: item.id, enabled } })).ok));
  node.append(row);
  return node;
}

/** What it leaves alone here, where it comes from, and its collection with each site's history. */
function about(entry: Entry): HTMLElement {
  const view = entry.subscription!, detail = entry.detail;
  const box = el('details', undefined, 'automation-sub-about');
  box.append(el('summary', t('automation_subAbout', 'Source, sites left alone and history')));
  const source = el('div', undefined, 'automation-sub-section');
  // Provenance only: where it came from, never a claim that it is right or safe (RS-12.5).
  const scheme = view.url.startsWith('https:') ? 'HTTPS' : 'HTTP';
  source.append(el('p', t('automation_subFetchedFrom', 'Fetched from $1 over $2', siteOf(view.origin), scheme), 'detail'));
  const facts = [view.publisher ? t('automation_subPublisher', 'Published by $1', view.publisher.name) : '', view.license ? t('automation_subLicense', 'Licence: $1', view.license) : '',
    view.fetchedAt ? t('automation_subFetchedAt', 'This version arrived $1', relativeText(view.fetchedAt)) : '',
    view.previousVersion ? t('automation_subPrevious', 'Previous version: $1', view.previousVersion) : ''].filter(Boolean);
  if (facts.length) source.append(el('p', facts.join(' · '), 'list-row-meta'));
  if (view.publisher?.feedbackUrl) {
    const link = el('a', t('automation_subFeedback', 'Tell the publisher about a problem'), 'btn btn-ghost btn-sm');
    link.href = view.publisher.feedbackUrl; link.target = '_blank'; link.rel = 'noopener noreferrer';
    source.append(link);
  }
  box.append(source);
  if (!detail) return box;
  if (detail.goneSettings) {
    const clear = button(t('automation_subClearGone', 'Clear'), 'btn btn-secondary btn-sm', () => {
      clear.disabled = true;
      void send({ kind: 'known.automation.browser.subscription.adjust', id: entry.id, change: { kind: 'clearGone' } }).then((reply) => { clear.disabled = false; if (!reply.ok) failed(); });
    });
    box.append(inlineAlert('info', tn('automation_subGone', detail.goneSettings, '$1 setting for an entry no longer in this subscription. It applies again if the entry comes back.',
      '$1 settings for entries no longer in this subscription. They apply again if the entries come back.'), clear));
  }
  // Sites this subscription leaves alone; a rule of yours or another set can still take them (RS-05.3).
  const alone = el('div', undefined, 'automation-sub-section');
  alone.append(el('p', t('automation_subLeftAlone', 'Sites it leaves alone here'), 'form-label'));
  const chips = el('ul', undefined, 'automation-sub-exceptions');
  for (const exception of detail.exceptions) {
    const chip = el('li', exception.scope === 'domain' ? t('automation_subExceptionDomain', '$1 and its subdomains', exception.value) : exception.value, 'badge');
    chip.append(iconButton('cross', t('automation_subExceptionRemove', 'Stop leaving $1 alone', exception.value), () => {
      void send({ kind: 'known.automation.browser.subscription.adjust', id: entry.id, change: { kind: 'removeException', exceptionId: exception.id } })
        .then((reply) => { if (!reply.ok) failed(); });
    }, 'btn btn-ghost btn-sm btn-icon'));
    chips.append(chip);
  }
  if (!detail.exceptions.length) alone.append(el('p', t('automation_subLeftAloneNone', 'None. Add a site its entries shouldn’t file, for this subscription only.'), 'list-row-meta'));
  const form = el('form', undefined, 'automation-sub-exception-form'); form.noValidate = true;
  const input = el('input', undefined, 'field-quiet'); input.type = 'text'; input.placeholder = 'example.org'; input.autocomplete = 'off'; input.spellcheck = false;
  input.setAttribute('aria-label', t('automation_subExceptionSite', 'Site to leave alone'));
  const scope = el('select', undefined, 'field-select');
  for (const [value, label] of [['domain', t('automation_subScopeDomain', 'and its subdomains')], ['host', t('automation_subScopeHost', 'this site only')]] as const) {
    const option = el('option', label); option.value = value; scope.append(option);
  }
  scope.setAttribute('aria-label', t('automation_subExceptionScope', 'How much of it'));
  const add = button(t('automation_subExceptionAdd', 'Leave alone'), 'btn btn-secondary btn-sm'); add.type = 'submit';
  form.append(input, scope, add);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const value = input.value.trim().replace(/^[a-z][a-z\d+.-]*:\/\/([^/]+).*$/iu, '$1');
    if (!value) { input.focus(); return; }
    add.disabled = true;
    void send({ kind: 'known.automation.browser.subscription.adjust', id: entry.id, change: { kind: 'exception', scope: scope.value as 'host' | 'domain', value } })
      .then((reply) => {
        add.disabled = false;
        if (reply.ok) { input.value = ''; return; }
        showToast(reply.error === 'invalid' ? t('automation_subExceptionBad', 'Use one site, such as example.org. A suffix many sites share can’t be left alone.')
          : t('automation_listSaveFailed', 'Couldn’t change the list. Try again.'), 'error', { announce: true });
      });
  });
  alone.append(chips, form);
  box.append(alone);
  if (detail.sites.length) {
    const sites = el('div', undefined, 'automation-sub-section');
    sites.append(el('p', tn('automation_subSites', detail.sites.length, 'Its collection: $1 site', 'Its collection: $1 sites'), 'form-label'));
    const list = el('ul', undefined, 'automation-sub-sites');
    for (const site of detail.sites) {
      const item = el('li');
      const live = site.addresses.filter((address) => address.status !== 'revoked').map((address) => `${address.host}${address.pathPrefix ?? ''}${address.scope === 'domain' ? ' *' : ''}`);
      item.append(el('span', site.name, 'automation-sub-site'), el('span', live.join(', ') || t('automation_subSiteRetired', 'no current address'), 'list-row-meta'));
      const history = site.addresses.filter((address) => address.status !== 'current');
      if (history.length) {
        item.append(el('span', history.map((address) => address.status === 'revoked'
          ? t('automation_subRevoked', '$1 retired $2', address.host, address.until ?? '') : t('automation_subHistorical', '$1 earlier address, still matched', address.host)).join(' · '),
        'list-row-meta automation-sub-history'));
      }
      list.append(item);
    }
    sites.append(list);
    box.append(sites);
  }
  return box;
}

export function subscriptionBlock(entry: Entry, parts: SubscriptionParts): HTMLLIElement {
  const node = el('li', undefined, 'rule-set automation-subscription'); node.dataset.entryId = entry.id;
  const view = entry.subscription, detail = entry.detail;
  const head = el('div', undefined, 'list-row automation-rule rule-set-head');
  if (!entry.enabled || !parts.listOn || view?.state !== 'ready') head.dataset.off = '';
  const grip = el('span', undefined, 'rule-grip'); grip.append(createIcon('reorder', 14)); grip.title = t('automation_dragToMove', 'Drag to move');
  const tile = el('span', undefined, 'favicon-tile'); tile.append(createIcon('rss', 16));
  const main = el('div', undefined, 'list-row-main');
  const filing = detail?.entries.filter((item) => item.role !== null) ?? [];
  main.append(el('p', view?.name ?? t('automation_subscription', 'Subscribed rule set'), 'list-row-title'),
    el('p', view ? statusLine(view, filing.length) : t('automation_subUnreadable', 'This browser can’t read this subscription, so it files nothing.'), 'list-row-meta'));
  // A waiting version, and why it waits (RS-12.3); pinned, it is not pressed on the Owner (§8 Policy).
  if (view?.candidateVersion && view.candidateWaits !== 'pinned') {
    const waiting = el('div', undefined, 'automation-sub-waiting');
    const why = view.candidateWaits === 'roles' ? t('automation_subWaitsRoles', 'Version $1 waits for your review: it changes the kinds of page it files.', view.candidateVersion)
      : view.candidateWaits === 'document' ? t('automation_subWaitsDocument', 'Version $1 waits for your review: it is a different rule set.', view.candidateVersion)
        : t('automation_subUpdateWaiting', 'Version $1 is waiting for your review.', view.candidateVersion);
    const review = button(t('automation_subReview', 'Review update'), 'btn btn-secondary btn-sm', () => openReview(entry, review)); review.dataset.review = '';
    waiting.append(el('span', why, 'list-row-meta'), review);
    main.append(waiting);
  }
  // A failure after the version in force: that version keeps filing (RS-13.1).
  if (view?.state === 'ready' && view.lastFailure && view.lastFailure.at >= (view.lastSuccessAt ?? 0)) {
    main.append(el('p', t('automation_subLastTry', 'Still using version $1. $2', view.currentVersion ?? '', failureText(view) ?? ''), 'list-row-meta automation-recipe-missing'));
  }
  const tail = el('div', undefined, 'list-row-tail');
  const actions = el('span', undefined, 'row-actions-hover');
  actions.append(...parts.moves);
  if (view) {
    const settings = iconButton('settings', t('automation_subSettings', 'Update settings'), () => openSubscriptionSettings(entry, settings));
    actions.append(iconButton('refresh', t('automation_subRefresh', 'Refresh now'), () => refreshNow(view)), settings);
    if (detail?.roles.length) { const folders = iconButton('folder', t('automation_subFolders', 'Choose its folders'), () => openSubscriptionFolders(entry, folders)); actions.append(folders); }
    if (view.candidateVersion && view.pinned) { const review = iconButton('eye', t('automation_subReview', 'Review update'), () => openReview(entry, review)); actions.append(review); }
  }
  const remove = iconButton('trash', t('automation_subRemove', 'Remove subscription'), () => confirmRemoveSubscription(entry, remove));
  actions.append(remove);
  tail.append(actions);
  if (!entry.enabled) tail.append(badge(t('automation_browserOff', 'Off')));
  else if (!view || view.state === 'notReady') tail.append(badge(t('automation_subNotReadyBadge', 'Not ready'), 'warning'));
  else if (view.pinned) tail.append(badge(t('automation_subPinnedBadge', 'Pinned')));
  else if (view.candidateVersion) tail.append(badge(t('automation_subUpdateBadge', 'Update available')));
  else if (view.paused) tail.append(badge(t('automation_subPausedBadge', 'Updates paused')));
  head.append(grip, tile, main, tail, parts.toggle(t('automation_subscriptionUse', 'Use this subscription'), entry.enabled,
    async (enabled) => (await send({ kind: 'known.automation.browser.enable', id: entry.id, enabled, entry: 'subscription' })).ok));
  parts.drag(head);
  node.append(head);
  if (view?.lastFailure?.code === 'permission') {
    node.append(inlineAlert('warning', t('automation_subAllowHint', 'Allow this browser to read $1, then it fetches the rule set.', siteOf(view.origin)),
      button(t('automation_subAllow', 'Allow and fetch'), 'btn btn-secondary btn-sm', () => refreshNow(view))));
  }
  if (!view) return node;
  const rules = el('ul', undefined, 'automation-rules rule-set-rules');
  rules.setAttribute('aria-label', t('automation_subEntriesLabel', 'Entries of “$1”', view.name));
  const shown = filing.slice(0, ENTRIES_SHOWN);
  for (const item of shown) rules.append(entryRow(entry, item, parts));
  if (filing.length > shown.length) {
    const more = el('li', undefined, 'rule-set-empty');
    const all = button(tn('automation_subShowAll', filing.length, 'Show all $1 entry', 'Show all $1 entries'), 'btn btn-ghost btn-sm', () => {
      more.remove(); for (const item of filing.slice(ENTRIES_SHOWN)) rules.append(entryRow(entry, item, parts));
    });
    more.append(all); rules.append(more);
  }
  const naming = (detail?.entries.length ?? 0) - filing.length;
  if (naming) rules.append(el('li', tn('automation_subNamingOnly', naming, '$1 more entry only names a site, for rules of yours.', '$1 more entries only name sites, for rules of yours.'), 'rule-set-empty list-row-meta'));
  node.append(rules, about(entry));
  return node;
}
