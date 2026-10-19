import { AUTOMATION_CHANGED_KEY } from '../automation/messages.js';
import { subscriptionAddress, subscriptionOriginPattern } from '../automation/subscription-fetch.js';
import type { RefreshInterval } from '../automation/subscription-messages.js';
import type { FailureCode } from '../automation/subscription-store.js';
import { createDialog, dialogButton } from '../dialog.js';
import { createIcon } from '../icons.js';
import { relativeText, t, tn } from '../i18n.js';
import { button, el, grouped, iconButton, optionRow, selectOf } from '../library-dom.js';
import { showToast } from '../toast.js';
import type { RiskCommand, RiskExceptionView, RiskListView, RiskResponse, RiskStateView } from './risk-messages.js';
import { BROWSE_PERMISSIONS, type RiskMode } from './risk-settings.js';

/**
 * Options › Automations › Risk alerts (doc 17 §9, RS-16, RS-17): whether this browser warns when a page
 * is on a risk list, the lists it subscribes to with how fresh each is, and the sites it leaves alone. A
 * list is subscribed to like a rule set (R14): an https address, its site allowed in the click, then
 * fetched; a failed first fetch keeps it, not ready, with Refresh now. Alerts only warn: nothing here can
 * change where a page is filed (R17), and a page on no list is not called safe (RS-17.2). Every change is
 * a worker command (sw/risk.ts).
 */
export interface RiskPane { readonly element: HTMLElement; activate(): void; deactivate(): void }

export const sendRiskCommand = (command: RiskCommand): Promise<RiskResponse> =>
  chrome.runtime.sendMessage(command).catch(() => null).then((reply) => (reply as RiskResponse | null) ?? { ok: false, error: 'network' });
const site = (url: string) => { try { return new URL(url).host; } catch { return url; } };
const failed = () => showToast(t('risk_changeFailed', 'Couldn’t change risk alerts. Try again.'), 'error', { announce: true });

/** A list fetch's failure in words, with when. */
export function riskFailureWords(code: FailureCode, origin: string, at: number, status?: number): string {
  const host = site(origin), ago = relativeText(at);
  switch (code) {
    case 'network': return t('automation_subFailNetwork', 'Couldn’t reach $1, $2.', host, ago);
    case 'http': return t('automation_subFailHttp', 'Couldn’t fetch it from $1 (HTTP $2), $3.', host, String(status ?? ''), ago);
    case 'tooLarge': return t('risk_failTooLarge', 'The file at $1 is larger than 4 MB, $2.', host, ago);
    case 'invalid': return t('risk_failInvalid', 'The file at $1 isn’t a risk list this browser can use, $2.', host, ago);
    case 'unsupported': return t('automation_subFailUnsupported', 'The file at $1 moved to another site or is in a newer format, $2.', host, ago);
    case 'permission': return t('automation_subFailPermission', 'This browser isn’t allowed to read $1 yet.', host);
  }
}
const failureOf = (view: RiskListView) => view.lastFailure ? riskFailureWords(view.lastFailure.code, view.origin, view.lastFailure.at, view.lastFailure.status) : null;

/** One quiet line: entries, version, and how fresh (R11). */
function listStatus(view: RiskListView): { readonly text: string; readonly tone: 'warning' | null } {
  if (view.state === 'notReady') {
    const problem = failureOf(view);
    return { text: problem ? t('automation_subNotReady', 'Not ready: $1', problem) : t('risk_notFetched', 'Not fetched yet, so it warns about nothing.'), tone: 'warning' };
  }
  const checked = view.lastSuccessAt ? relativeText(view.lastSuccessAt) : '';
  const fresh = view.freshness === 'outOfDate' ? t('risk_outOfDate', 'out of date: last updated $1, so its alerts say “unknown”', checked)
    : view.freshness === 'stale' ? t('risk_stale', 'stale: last updated $1', checked) : t('automation_subChecked', 'checked $1', checked);
  return { text: [grouped(tn('risk_entries', view.entries ?? 0, '$1 entry', '$1 entries'), view.entries ?? 0), t('automation_subVersion', 'version $1', view.currentVersion ?? ''), fresh].join(' · '),
    tone: view.freshness === 'fresh' ? null : 'warning' };
}

/** Refresh now: the origin is asked for in the click (it answers at once when already allowed), then fetched. */
function refreshNow(view: RiskListView, trigger: HTMLButtonElement): void {
  trigger.disabled = true;
  void chrome.permissions.request({ origins: [subscriptionOriginPattern(view.origin)] }).catch(() => false).then(async (granted) => {
    if (!granted) { trigger.disabled = false; showToast(t('risk_needsAccess', 'Allow reading $1 to fetch this list.', site(view.origin)), 'error', { announce: true }); return; }
    const reply = await sendRiskCommand({ kind: 'known.risk.refresh', id: view.id });
    trigger.disabled = false;
    if (!reply.ok || !reply.list) { failed(); return; }
    const after = reply.list, problem = after.lastFailure && after.lastFailure.at >= (after.lastSuccessAt ?? 0) ? failureOf(after) : null;
    showToast(problem ?? t('automation_subUpToDate', 'Up to date: version $1.', after.currentVersion ?? ''), problem ? 'error' : 'ok', { announce: true });
  });
}

function confirmRemove(view: RiskListView, trigger: HTMLElement): void {
  const { dialog, body, actions } = createDialog(t('risk_removeTitle', 'Remove “$1”?', view.name));
  body.append(el('p', t('risk_removeHint', 'It stops warning about the sites it lists. Your exceptions stay.'), 'mgr-hint'));
  const cancel = dialogButton(t('common_cancel', 'Cancel'));
  const remove = dialogButton(t('risk_remove', 'Remove list'), 'danger');
  cancel.addEventListener('click', () => dialog.close());
  remove.addEventListener('click', () => {
    remove.disabled = true;
    void sendRiskCommand({ kind: 'known.risk.remove', id: view.id }).then((reply) => {
      dialog.close();
      if (reply.ok) showToast(t('risk_removed', 'Removed “$1”.', view.name), 'ok', { announce: true }); else failed();
    });
  });
  actions.append(cancel, remove);
  dialog.addEventListener('close', () => { dialog.remove(); if (trigger.isConnected) trigger.focus(); });
  document.body.append(dialog); dialog.showModal(); cancel.focus();
}

/** Subscribe to a list: its address, then its site allowed in the click, then the first fetch. */
export function openRiskSubscribe(trigger?: HTMLElement | null): void {
  const { dialog, body, actions } = createDialog(t('risk_subscribeTitle', 'Subscribe to a risk list'), 'automation-config-dialog');
  const form = el('form'); form.noValidate = true;
  const input = el('input', undefined, 'field-quiet'); input.type = 'url'; input.id = `risk-url-${crypto.randomUUID()}`;
  input.placeholder = 'https://example.org/risklist.json'; input.autocomplete = 'off'; input.spellcheck = false; input.maxLength = 2_048;
  const label = el('label', t('risk_url', 'Address of the list'), 'form-label'); label.htmlFor = input.id;
  const error = el('p', undefined, 'form-error'); error.setAttribute('role', 'alert'); error.hidden = true;
  const field = el('div', undefined, 'form-field');
  field.append(label, input, el('p', t('risk_urlHint', 'A colp.risklist/v1 file on an https address. Know-N asks to read that site, and sends it nothing about your pages.'), 'mgr-hint'), error);
  const select = selectOf([['6', t('automation_subEvery6', 'Every 6 hours')], ['24', t('automation_subEveryDay', 'Once a day')]], '6');
  select.className = 'field-select'; select.id = `risk-interval-${crypto.randomUUID()}`;
  const every = el('div', undefined, 'form-field');
  const everyLabel = el('label', t('automation_subInterval', 'Check for updates'), 'form-label'); everyLabel.htmlFor = select.id;
  every.append(everyLabel, select, el('p', t('risk_intervalHint', 'Only while this browser is open. A list not updated for a week is marked stale.'), 'mgr-hint'));
  body.append(field, every);
  const cancel = dialogButton(t('common_cancel', 'Cancel'));
  const add = dialogButton(t('automation_subSubscribe', 'Subscribe'), 'primary'); add.type = 'submit';
  cancel.addEventListener('click', () => dialog.close());
  actions.append(cancel, add);
  dialog.replaceChildren(dialog.querySelector('h3')!, form);
  form.append(body, actions);
  input.addEventListener('input', () => { error.hidden = true; });
  const fail = (text: string) => { add.disabled = false; error.textContent = text; error.hidden = false; };
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const address = subscriptionAddress(input.value);
    if (!address.ok) { fail(t('risk_badUrl', 'Use an https address, such as https://example.org/risklist.json.')); input.focus(); return; }
    add.disabled = true;
    // Asked in the click, before anything is awaited, so the browser shows its prompt (R14).
    void chrome.permissions.request({ origins: [subscriptionOriginPattern(address.origin)] }).catch(() => false).then(async (granted) => {
      if (!granted) { fail(t('risk_needsAccessSubscribe', 'Allow reading $1 to subscribe to this list. Know-N reads nothing else from that site.', site(address.url))); return; }
      const reply = await sendRiskCommand({ kind: 'known.risk.subscribe', url: address.url, refreshIntervalHours: Number(select.value) as RefreshInterval });
      if (reply.ok && reply.list) {
        dialog.close();
        const made = reply.list;
        showToast(made.state === 'ready' ? t('risk_subscribed', 'Subscribed to “$1”.', made.name)
          : t('risk_subscribedNotReady', 'Subscribed, but not ready yet: $1', failureOf(made) ?? ''), made.state === 'ready' ? 'ok' : 'error', { announce: true });
        return;
      }
      const code = reply.ok ? '' : reply.error;
      fail(code === 'duplicate' ? t('risk_duplicate', 'You already subscribe to this list.')
        : code === 'limit' ? t('risk_limit', 'This browser keeps up to 20 risk lists. Remove one to add another.')
          : code === 'unsupported' ? t('risk_badUrl', 'Use an https address, such as https://example.org/risklist.json.') : t('risk_subscribeFailed', 'Couldn’t subscribe. Try again.'));
    });
  });
  dialog.addEventListener('close', () => { dialog.remove(); if (trigger?.isConnected) trigger.focus(); });
  document.body.append(dialog); dialog.showModal(); input.focus();
}

/** Off, on saves, or on saves and while browsing: three rows in one card, each saying what it does. */
function modeField(mode: RiskMode, change: (mode: RiskMode) => void): HTMLElement {
  const group = `risk-mode-${crypto.randomUUID()}`;
  const choices = el('div', undefined, 'set-card option-list risk-mode'); choices.setAttribute('role', 'radiogroup'); choices.setAttribute('aria-label', t('risk_modeLabel', 'Warn me'));
  const option = (value: RiskMode, title: string, hint: string) => {
    const { label, input } = optionRow({ type: 'radio', name: group, value, checked: value === mode, title, hint });
    input.addEventListener('change', () => { if (input.checked) change(value); });
    return label;
  };
  choices.append(option('off', t('risk_modeOff', 'Off'), t('risk_modeOffHint', 'No lists are checked and none are fetched by themselves.')),
    option('onSave', t('risk_modeOnSave', 'When I save a page'), t('risk_modeOnSaveHint', 'The popup says when the page is on one of your lists. You can still save it.')),
    option('onSaveAndBrowse', t('risk_modeBrowse', 'When I save, and while I browse'),
      t('risk_modeBrowseHint', 'The Know-N button shows ! on a page from your lists. Asks to see the pages you open; they are checked here and sent nowhere.')));
  return choices;
}

function listRow(view: RiskListView): HTMLLIElement {
  const node = el('li'); node.dataset.riskList = view.id;
  const row = el('div', undefined, 'list-row risk-list-row');
  const tile = el('span', undefined, 'favicon-tile'); tile.append(createIcon('rss', 16));
  const main = el('div', undefined, 'list-row-main');
  const title = el('p', view.name, 'list-row-title');
  const status = listStatus(view);
  const meta = el('p', undefined, 'list-row-meta');
  // Only how it stands takes the warning tone; who keeps it stays quiet.
  const words = el('span', status.text, 'risk-status');
  if (status.tone) words.dataset.tone = status.tone;
  meta.append(`${view.publisher?.name ?? site(view.url)} · `, words);
  main.append(title, meta);
  // Its actions show on hover and focus, as a rule's do; how it stands stays in its line.
  const tail = el('div', undefined, 'list-row-tail');
  const actions = el('span', undefined, 'row-actions-hover');
  // Opened only when clicked: nothing is sent to the publisher by this browser (RS-15.4).
  const feedback = view.publisher?.feedbackUrl;
  if (feedback) {
    const link = el('a', t('risk_reportMistake', 'Report a mistake'), 'btn btn-ghost btn-sm'); link.href = feedback; link.target = '_blank'; link.rel = 'noreferrer';
    actions.append(link);
  }
  const refresh = iconButton('refresh', t('automation_subRefresh', 'Refresh now'), () => refreshNow(view, refresh));
  const remove = iconButton('trash', t('risk_remove', 'Remove list'), () => confirmRemove(view, remove));
  actions.append(refresh, remove);
  tail.append(actions);
  row.append(tile, main, tail);
  node.append(row);
  return node;
}

function exceptionRow(item: RiskExceptionView, reload: () => void): HTMLLIElement {
  const node = el('li');
  const row = el('div', undefined, 'list-row risk-exception-row');
  const main = el('div', undefined, 'list-row-main');
  main.append(el('p', item.value, 'list-row-title'), el('p', [item.scope === 'host' ? t('risk_exceptionHost', 'This host only') : t('risk_exceptionDomain', 'The domain and every host under it'),
    item.duration === 'session' ? t('risk_exceptionSession', 'until the browser closes') : t('risk_exceptionAlways', 'always')].join(' · '), 'list-row-meta'));
  const remove = iconButton('trash', t('risk_exceptionRemove', 'Remove exception for $1', item.value), () => {
    remove.disabled = true;
    void sendRiskCommand({ kind: 'known.risk.exception.remove', id: item.id }).then((reply) => {
      if (!reply.ok) { remove.disabled = false; failed(); return; }
      showToast(t('risk_exceptionRemoved', 'Risk alerts are back for $1.', item.value), 'ok', { announce: true });
      reload();
    });
  });
  const tail = el('div', undefined, 'list-row-tail'); const actions = el('span', undefined, 'row-actions-hover'); actions.append(remove); tail.append(actions);
  row.append(main, tail);
  node.append(row);
  return node;
}

export function riskBody(state: RiskStateView, reload: () => void): HTMLElement[] {
  const send = (next: RiskMode) => sendRiskCommand({ kind: 'known.risk.mode', mode: next });
  const mode = modeField(state.mode, (next) => {
    if (next === 'onSaveAndBrowse') {
      // Asked in the switch, before anything is awaited (RS-16.3); without them alerts stay on for saves.
      void chrome.permissions.request({ permissions: BROWSE_PERMISSIONS }).catch(() => false).then(async (granted) => {
        const reply = await send(granted ? 'onSaveAndBrowse' : 'onSave');
        if (!reply.ok) failed();
        else if (!granted) showToast(t('risk_browseDenied', 'Alerts while browsing need to see the pages you open. They stay on for pages you save.'), 'error', { announce: true });
        else showToast(t('risk_modeTurnedOnBrowse', 'The Know-N button now shows ! on pages from your lists, and the popup says which.'), 'ok', { announce: true });
        reload();
      });
      return;
    }
    void send(next).then((reply) => {
      if (!reply.ok) { failed(); reload(); return; }
      showToast(next === 'off' ? t('risk_modeTurnedOff', 'Risk alerts are off.') : t('risk_modeTurnedOn', 'The popup now warns when a page you save is on one of your lists.'), 'ok', { announce: true });
      reload();
    });
  });
  const lists = el('div', undefined, 'set-card risk-lists');
  const head = el('div', undefined, 'set-row');
  const words = el('div', undefined, 'set-row-text');
  words.append(el('p', t('risk_lists', 'Lists'), 'set-row-title'),
    el('p', t('risk_listsHint', 'Fetched to this browser and checked here. Each says who keeps it; where lists disagree, you see each one.'), 'set-row-hint'));
  const controls = el('div', undefined, 'set-row-control');
  const subscribe = button(t('risk_subscribe', 'Subscribe to a list'), 'btn btn-secondary btn-sm', () => openRiskSubscribe(subscribe));
  subscribe.dataset.riskSubscribe = '';
  controls.append(subscribe);
  head.append(words, controls);
  lists.append(head);
  if (state.lists.length) { const items = el('ul', undefined, 'risk-list-items'); items.append(...state.lists.map(listRow)); lists.append(items); }
  const parts = [mode, lists];
  if (state.exceptions.length) {
    const card = el('div', undefined, 'set-card risk-exceptions');
    const words = el('div', undefined, 'set-row-text');
    words.append(el('p', t('risk_exceptions', 'Exceptions'), 'set-row-title'),
      el('p', t('risk_exceptionsHint', 'These sites get no risk alerts. Exceptions never change where pages are filed.'), 'set-row-hint'));
    const row = el('div', undefined, 'set-row'); row.append(words);
    const items = el('ul', undefined, 'risk-list-items'); items.append(...state.exceptions.map((item) => exceptionRow(item, reload)));
    card.append(row, items);
    parts.push(card);
  }
  return parts;
}

export function createRiskPane(): RiskPane {
  const section = el('section', undefined, 'set-group automation-risk');
  section.id = 'automation-risk'; section.setAttribute('aria-labelledby', 'automation-risk-heading');
  const head = el('div', undefined, 'set-group-head');
  const title = el('h2', t('risk_title', 'Risk alerts')); title.id = 'automation-risk-heading';
  head.append(title, el('p', t('risk_lede', 'Warns you when a page is on a risk list you subscribe to. It only warns: it never blocks a page or changes where a bookmark goes.'), 'detail'),
    el('p', t('risk_absence', 'Absence from a list means nothing either way: a page on no list gets no notice, good or bad.'), 'detail risk-absence'));
  const body = el('div', undefined, 'risk-body');
  section.append(head, body);
  let active = false, turn = 0, revealed = false;
  async function load(): Promise<void> {
    const mine = ++turn, reply = await sendRiskCommand({ kind: 'known.risk.state' });
    if (mine !== turn || !active) return;
    if (!reply.ok || !reply.state) { body.replaceChildren(el('p', t('risk_loadFailed', 'Couldn’t read risk alerts in this browser. Reload the page to try again.'), 'form-error')); return; }
    const focused = document.activeElement instanceof HTMLElement && body.contains(document.activeElement)
      ? document.activeElement.closest<HTMLElement>('[data-risk-list]')?.dataset.riskList : undefined;
    body.replaceChildren(...riskBody(reply.state, () => void load()));
    if (focused) body.querySelector<HTMLElement>(`[data-risk-list="${CSS.escape(focused)}"] button`)?.focus();
    // View list, from the popup's notice: options.html#automations?item=risk-<id>.
    const item = new URLSearchParams(location.hash.split('?')[1] ?? '').get('item');
    if (!revealed && item?.startsWith('risk-')) {
      revealed = true;
      const row = body.querySelector<HTMLElement>(`[data-risk-list="${CSS.escape(item.slice(5))}"] > .list-row`) ?? title;
      row.scrollIntoView?.({ block: 'center' });
      row.tabIndex = -1; row.dataset.highlight = ''; row.focus({ preventScroll: true });
      setTimeout(() => { delete row.dataset.highlight; }, 2_400);
    }
  }
  chrome.storage.onChanged.addListener((changes, area) => {
    if (active && area === 'local' && AUTOMATION_CHANGED_KEY in changes) void load();
  });
  return {
    element: section,
    activate() { active = true; void load(); },
    deactivate() { active = false; turn += 1; revealed = false; },
  };
}
