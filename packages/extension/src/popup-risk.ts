import { createIcon } from './icons.js';
import { formatMoment, t, tn, uiLanguage } from './i18n.js';
import type { RiskMatch } from './risk/risk-check.js';
import type { ExceptionDuration, RiskCheckView, RiskResponse } from './risk/risk-messages.js';

/**
 * The popup's risk notice (doc 17 §9 On save, RS-17, RS-18): asked for next to the rule match, whatever
 * the rule decides (RS-18.2), and shown above the form only when a subscribed list names the page. Each
 * match says which list, what it calls the page, since when, the host, domain or prefix it names and its
 * evidence; an expired entry and an out-of-date list say so (R11). Save stays as it is: nothing here
 * touches the folder, the address or the rule (RS-17.5). Dismiss hides it for this page; Add exception
 * silences this host or domain for the session or always (R12); View list opens it in Options.
 */
const KIND_WORDS = {
  phishing: () => t('risk_kindPhishing', 'phishing'),
  scam: () => t('risk_kindScam', 'a scam'),
  malware: () => t('risk_kindMalware', 'malware'),
  other: () => t('risk_kindOther', 'a risk'),
} as const;
/** A list's dates are instants; most are midnight UTC, so they read as the publisher's day, not one before or after. */
const day = (value: string) => {
  try { return new Date(value).toLocaleDateString(uiLanguage(), { dateStyle: 'medium', timeZone: 'UTC' }); } catch { return formatMoment(value, 'date'); }
};

/** One match in words: the list, its verdict, and what it names. */
export function matchWords(match: RiskMatch): string {
  return [`${match.listName}: ${verdict(match)}`, scopeWords(match), staleWords(match)].filter(Boolean).join(' · ');
}

const verdict = (match: RiskMatch) => match.freshness === 'outOfDate' ? t('risk_matchUnknown', 'unknown, list out of date')
  : match.expired && match.expires ? t('risk_matchExpired', 'listed as $1 until $2 (expired)', KIND_WORDS[match.kind](), day(match.expires))
    : t('risk_matchKind', 'listed as $1 since $2', KIND_WORDS[match.kind](), day(match.since));
const scopeWords = (match: RiskMatch) => match.scope === 'host' ? t('risk_scopeHost', 'this host, $1', match.value)
  : match.scope === 'domain' ? t('risk_scopeDomain', 'all of $1', match.value) : t('risk_scopePrefix', 'addresses starting $1', match.value);
const staleWords = (match: RiskMatch) => match.freshness === 'stale' ? t('risk_matchStale', 'list not updated for over a week') : '';

const span = (className: string, ...children: (Node | string)[]) => {
  const node = document.createElement('span'); node.className = className; node.append(...children);
  return node;
};

/**
 * One match as two parts: the list and its verdict, then what it names, how fresh the list is and its
 * evidence. The words still read as one sentence, as matchWords says it.
 */
function matchItem(match: RiskMatch): HTMLLIElement {
  const item = document.createElement('li');
  const name = document.createElement('strong'); name.textContent = match.listName;
  const meta = span('risk-match-meta', span('risk-match-sep', ' · '), span('risk-match-scope', scopeWords(match)));
  const stale = staleWords(match);
  if (stale) meta.append(span('risk-match-extra', ` · ${stale}`));
  if (match.evidenceUrl) {
    const link = document.createElement('a'); link.href = match.evidenceUrl; link.target = '_blank'; link.rel = 'noreferrer'; link.className = 'risk-notice-link';
    link.textContent = t('risk_evidence', 'Evidence');
    meta.append(span('risk-match-extra', ' · ', link));
  }
  item.append(span('risk-match-head', name, `: ${verdict(match)}`), meta);
  return item;
}

const button = (label: string, onClick: () => void, className = 'btn btn-secondary btn-sm') => {
  const node = document.createElement('button'); node.type = 'button'; node.className = className; node.textContent = label;
  node.addEventListener('click', onClick);
  return node;
};
const select = (values: readonly (readonly [string, string])[], label: string) => {
  const node = document.createElement('select'); node.className = 'risk-notice-select'; node.setAttribute('aria-label', label);
  for (const [value, text] of values) { const option = document.createElement('option'); option.value = value; option.textContent = text; node.append(option); }
  return node;
};

export function bindPopupRisk(host: { readonly notice: HTMLElement; readonly page: () => { readonly url: string } | null }) {
  let turn = 0, dismissed = '';
  const notice = host.notice;
  function hide(): void { notice.hidden = true; notice.replaceChildren(); }
  function confirm(text: string): void {
    notice.dataset.tone = 'success';
    const words = document.createElement('p'); words.textContent = text;
    notice.replaceChildren(createIcon('check-circle', 16), words);
  }
  function exceptionForm(url: string, site: NonNullable<RiskCheckView['site']>, actions: HTMLElement): HTMLElement {
    const form = document.createElement('div'); form.className = 'risk-notice-except';
    const scope = select([['host', t('risk_exceptHost', 'Only $1', site.host)], ...(site.domain && site.domain !== site.host
      ? [['domain', t('risk_exceptDomain', 'All of $1', site.domain)] as const] : [])], t('risk_exceptScope', 'Which sites'));
    const duration = select([['session', t('risk_exceptSession', 'Until the browser closes')], ['always', t('risk_exceptAlways', 'Always')]], t('risk_exceptDuration', 'For how long'));
    const add = button(t('risk_exceptAdd', 'Add'), () => {
      add.disabled = true;
      const chosen = scope.value as 'host' | 'domain', value = chosen === 'domain' && site.domain ? site.domain : site.host;
      void chrome.runtime.sendMessage({ kind: 'known.risk.exception.add', scope: chosen, value, duration: duration.value as ExceptionDuration })
        .catch(() => null).then((answer) => {
          const reply = answer as RiskResponse | null;
          if (!reply?.ok) { add.disabled = false; add.textContent = t('risk_exceptRetry', 'Try again'); return; }
          dismissed = url;
          confirm(duration.value === 'always' ? t('risk_exceptedAlways', 'No more risk alerts for $1.', value)
            : t('risk_exceptedSession', 'No risk alerts for $1 until the browser closes.', value));
        });
    }, 'btn btn-primary btn-sm');
    const cancel = button(t('common_cancel', 'Cancel'), () => { form.remove(); actions.hidden = false; }, 'btn btn-ghost btn-sm');
    const buttons = document.createElement('div'); buttons.className = 'risk-notice-actions';
    buttons.append(add, cancel);
    form.append(scope, duration, buttons);
    actions.hidden = true;
    return form;
  }
  function paint(url: string, check: RiskCheckView): void {
    notice.dataset.tone = 'warning';
    const body = document.createElement('div'); body.className = 'risk-notice-body';
    const title = document.createElement('p'); title.className = 'risk-notice-title';
    const lists = new Set(check.matches.map((match) => match.listId)).size;
    title.textContent = tn('risk_noticeTitle', lists, 'This page is on a risk list you subscribe to', 'This page is on $1 risk lists you subscribe to');
    const items = document.createElement('ul'); items.className = 'risk-notice-matches';
    items.append(...check.matches.map(matchItem));
    const hint = document.createElement('p'); hint.className = 'risk-notice-hint';
    hint.textContent = t('risk_noticeHint', 'You can still save it; the folder stays as it is.');
    const actions = document.createElement('div'); actions.className = 'risk-notice-actions';
    const first = check.matches[0]!.listId;
    actions.append(
      button(t('risk_dismiss', 'Dismiss'), () => { dismissed = url; hide(); }),
      ...(check.site ? [button(t('risk_addException', 'Add exception'), () => { if (check.site) body.append(exceptionForm(url, check.site, actions)); })] : []),
      button(t('risk_viewList', 'View list'), () => { void chrome.tabs.create({ url: chrome.runtime.getURL(`options.html#automations?item=risk-${encodeURIComponent(first)}`) }); }, 'btn btn-ghost btn-sm'));
    body.append(title, items, hint, actions);
    notice.replaceChildren(createIcon('alert', 16), body);
    notice.hidden = false;
  }
  return {
    /** Asks what the subscribed lists say about the page; shows the notice when one names it. */
    async refresh(): Promise<void> {
      const mine = ++turn, page = host.page();
      if (!page) { hide(); return; }
      const reply = await chrome.runtime.sendMessage({ kind: 'known.risk.check', url: page.url }).catch(() => null) as RiskResponse | null;
      if (mine !== turn) return;
      const check = reply?.ok ? reply.check : undefined;
      if (!check?.matches.length || dismissed === page.url) { hide(); return; }
      paint(page.url, check);
    },
  };
}
