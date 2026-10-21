import type { components } from '../../server/generated/openapi/product-v1.js';
import { readBoundedJson } from './json-response.js';
import { assertCredentialHostPermission, SERVER_HOST_PERMISSION_ERROR } from './server-origin-permission.js';
import { formatMoment, localized, t, uiLanguage } from './i18n.js';
import { paintSelectPills } from './select-pill.js';

async function cookieGet(fetcher: typeof fetch, url: string, init: RequestInit): Promise<Response> {
  try { await assertCredentialHostPermission(url, init); return await fetcher(url, init); }
  catch (error) {
    if (error instanceof Error && error.message === SERVER_HOST_PERMISSION_ERROR) throw error;
    throw new CreditLedgerError('offline', 0);
  }
}

export type GeneratedCreditOverview = components['schemas']['CreditOverview'];
export type GeneratedCreditLedgerPage = components['schemas']['CreditLedgerPage'];
export type GeneratedCreditLedgerEntry = components['schemas']['CreditLedgerEntry'];
export type GeneratedCreditLedgerEntryResponse = components['schemas']['CreditLedgerEntryResponse'];
type CreditPrice = components['schemas']['CreditPrice'];

export const CREDIT_KINDS = ['grant', 'reserve', 'spend', 'release', 'expire', 'refund', 'topup', 'payment_refund'] as const;
export type CreditKind = components['schemas']['CreditKind'];

/* Status-badge tones: inflow reads success, outflow
   reads danger, bucket moves (reserve/release) read accent. */
let REASON_COPY: Record<GeneratedCreditLedgerEntry['reasonCode'], string>;
localized(() => {
  REASON_COPY = {
  trial_grant: t('common_trialCredits', 'Trial credits'), manual_grant: t('common_manualGrant', 'Manual grant'),
  classification_requested: t('common_classificationRequested', 'Classification requested'), classification_completed: t('common_classificationCompleted', 'Classification completed'),
  classification_failed: t('common_classificationFailed', 'Classification failed'), classification_cancelled: t('common_classificationCancelled', 'Classification cancelled'),
  classification_unneeded: t('credits_classificationNotNeeded', 'Classification not needed'), credits_expired: t('common_creditsExpired', 'Credits expired'),
  hold_expired: t('common_holdExpired', 'Hold expired'), manual_refund: t('common_manualRefund', 'Manual refund'),
  payment_received: t('common_paymentReceived', 'Payment received'), payment_refunded: t('common_paymentRefunded', 'Payment refunded'),
};
});
const KIND_TONE: Record<string, string> = {
  grant: 'success', topup: 'success', refund: 'success',
  // Spending is the normal case — the signed amount already reads as a debit.
  spend: 'neutral', expire: 'danger', payment_refund: 'danger',
  reserve: 'neutral', release: 'neutral',
};

export interface CreditAuthority {
  readonly status: 'connected' | 'signed_out' | 'offline' | 'error' | 'refreshing' | 'connecting' | 'policy_blocked';
  readonly serverOrigin: string;
  /** Business `account.id`; credential.subject remains the session authority key. */
  readonly businessAccountId: string;
  readonly accountKey: string;
  readonly generation: number;
}

export interface CreditLedgerFilter {
  readonly limit: number;
  readonly kind?: CreditKind;
  readonly from?: string;
  readonly to?: string;
  readonly chargeId?: string;
  readonly runId?: string;
}

export type CreditsViewState = 'loading' | 'ready' | 'empty' | 'filtered_empty' | 'signed_out'
  | 'offline' | 'reconnecting' | 'error' | 'cursor_expired';

export interface CreditsLedgerBinding {
  readonly root: HTMLElement;
  readonly getAuthority: (signal?: AbortSignal) => Promise<CreditAuthority>;
  readonly onOpenLogin?: () => void;
  readonly fetch?: typeof fetch;
  /** `false` when Manifest `features.cloud` is off. */
  readonly cloudEnabled?: () => boolean;
}

export function bindCreditsLedger(binding: CreditsLedgerBinding) {
  const fetcher = binding.fetch ?? fetch;
  const state = {
    authorityKey: '',
    accountId: '',
    pageController: undefined as AbortController | undefined,
    detailController: undefined as AbortController | undefined,
    pageEpoch: 0,
    detailEpoch: 0,
    snapshot: undefined as GeneratedCreditLedgerPage | undefined,
    nextCursor: null as string | null,
    filter: { limit: 20 } as CreditLedgerFilter,
    selectedEntry: null as GeneratedCreditLedgerEntry | null,
    loading: false,
  };
  const next = binding.root.querySelector<HTMLButtonElement>('[data-credit-action="next"]');
  const filterForm = binding.root.querySelector<HTMLFormElement>('[data-credit-filter]');
  const detailClose = binding.root.querySelector<HTMLButtonElement>('[data-credit-action="close-detail"]');
  for (const button of Array.from(binding.root.querySelectorAll<HTMLButtonElement>('[data-credit-action="refresh"]'))) button.addEventListener('click', () => { void loadFirstPage(); });
  next?.addEventListener('click', () => { void loadNextPage(); });
  detailClose?.addEventListener('click', () => { state.selectedEntry = null; render(); });
  // The type and rows pills filter as soon as they change; the date range has its own Apply.
  filterForm?.addEventListener('change', (event) => {
    if (event.target instanceof HTMLSelectElement) filterForm.dispatchEvent(new Event('submit', { cancelable: true }));
  });
  filterForm?.addEventListener('submit', (event) => {
    event.preventDefault();
    try { void loadFirstPage(readFilter()); } catch { setState('error'); render(); }
  });
  binding.root.addEventListener('click', (event) => {
    const origin = event.target instanceof Element ? event.target : null;
    if (origin?.closest('[data-credit-action="close-detail"]')) { state.selectedEntry = null; render(); return; }
    const target = origin?.closest<HTMLElement>('[data-credit-entry-id]');
    if (target?.dataset.creditEntryId) void loadDetail(target.dataset.creditEntryId);
  });

  function currentKey(authority: CreditAuthority): string {
    return `${authority.serverOrigin}|${authority.accountKey}|${authority.businessAccountId}|${authority.generation}`;
  }

  async function capture(signal?: AbortSignal): Promise<{ readonly authority: CreditAuthority; readonly key: string } | null> {
    const authority = await binding.getAuthority(signal);
    if (authority.status !== 'connected' || !authority.serverOrigin || !authority.accountKey || !authority.businessAccountId) {
      setState(authorityState(authority.status));
      return null;
    }
    const key = currentKey(authority);
    if (state.authorityKey !== '' && state.authorityKey !== key) clearForAuthorityChange(key);
    state.authorityKey = key;
    return { authority, key };
  }

  function clearForAuthorityChange(nextKey = ''): void {
    state.pageController?.abort(); state.pageController = undefined;
    state.detailController?.abort(); state.detailController = undefined;
    state.pageEpoch += 1; state.detailEpoch += 1;
    state.authorityKey = nextKey; state.snapshot = undefined; state.nextCursor = null; state.selectedEntry = null;
    state.accountId = '';
    state.loading = false; render();
  }

  async function assertCurrent(key: string, signal?: AbortSignal): Promise<CreditAuthority> {
    const authority = await binding.getAuthority(signal);
    if (authority.status !== 'connected' || currentKey(authority) !== key) throw new CreditAuthorityChanged();
    return authority;
  }

  async function loadFirstPage(filter = state.filter): Promise<void> {
    state.pageController?.abort(); state.detailController?.abort();
    const controller = new AbortController(); state.pageController = controller;
    const epoch = ++state.pageEpoch; state.detailEpoch += 1;
    const deepLinkedEntry = new URLSearchParams(location.search).has('creditEntryId');
    state.filter = filter; state.nextCursor = null; state.snapshot = undefined;
    if (!deepLinkedEntry) state.selectedEntry = null;
    state.accountId = ''; state.loading = true; setState('loading'); render();
    let captured: { readonly authority: CreditAuthority; readonly key: string } | null;
    try { captured = await capture(controller.signal); }
    catch (error) { handleCaptureFailure(error, epoch, controller); return; }
    if (!captured || !isPageCurrent(epoch, controller)) {
      if (!captured && isPageCurrent(epoch, controller)) clearForAuthorityChange('');
      return;
    }
    await requestPage(captured, filter, false, controller, epoch);
  }

  async function loadNextPage(): Promise<void> {
    if (!state.nextCursor || state.loading) return;
    state.pageController?.abort();
    const controller = new AbortController(); state.pageController = controller;
    const epoch = ++state.pageEpoch; state.loading = true; setState('loading'); render();
    let captured: { readonly authority: CreditAuthority; readonly key: string } | null;
    try { captured = await capture(controller.signal); }
    catch (error) { handleCaptureFailure(error, epoch, controller); return; }
    if (!captured || !isPageCurrent(epoch, controller)) {
      if (!captured && isPageCurrent(epoch, controller)) clearForAuthorityChange('');
      return;
    }
    await requestPage(captured, state.filter, true, controller, epoch);
  }

  function isPageCurrent(epoch: number, controller: AbortController): boolean {
    return state.pageEpoch === epoch && state.pageController === controller && !controller.signal.aborted;
  }

  function handleCaptureFailure(error: unknown, epoch: number, controller: AbortController): void {
    if (!isPageCurrent(epoch, controller)) return;
    state.loading = false;
    if (controller.signal.aborted) return;
    const apiError = error instanceof CreditLedgerError ? error : undefined;
    if (apiError?.code === 'offline' || apiError?.status === 0) setState('offline');
    else if (apiError?.code === 'unsupported') binding.root.hidden = true;
    else if (apiError?.code === 'reconnect_required' || apiError?.status === 401) { clearForAuthorityChange(''); setState('signed_out'); }
    else setState('error');
    render();
  }

  async function requestPage(captured: { readonly authority: CreditAuthority; readonly key: string }, filter: CreditLedgerFilter,
    cursor: boolean, controller: AbortController, epoch: number): Promise<void> {
    try {
      const params = new URLSearchParams();
      if (cursor) params.set('cursor', state.nextCursor!);
      else {
        params.set('limit', String(filter.limit));
        if (filter.kind) params.set('kind', filter.kind);
        if (filter.from) params.set('from', filter.from);
        if (filter.to) params.set('to', filter.to);
        if (filter.chargeId) params.set('chargeId', filter.chargeId);
        if (filter.runId) params.set('runId', filter.runId);
      }
      const page = await getJson(`/api/v1/me/credits/ledger?${params.toString()}`, captured.authority.serverOrigin, controller.signal);
      await assertCurrent(captured.key, controller.signal);
      if (!isPageCurrent(epoch, controller)) return;
      const parsed = parseCreditLedgerPage(page);
      if (parsed.accountId !== captured.authority.businessAccountId) throw new CreditAuthorityChanged();
      if (state.accountId !== '' && state.accountId !== parsed.accountId) { clearForAuthorityChange(captured.key); return; }
      state.accountId = parsed.accountId;
      if (cursor && state.snapshot) {
        state.snapshot = { ...state.snapshot, items: [...state.snapshot.items, ...parsed.items], nextCursor: parsed.nextCursor };
      } else state.snapshot = parsed;
      state.nextCursor = parsed.nextCursor;
      state.loading = false; setState(parsed.items.length === 0 && state.snapshot.items.length === 0
        ? (hasFilter(filter) ? 'filtered_empty' : 'empty') : 'ready');
    } catch (error) {
      if (!isPageCurrent(epoch, controller)) return;
      state.loading = false;
      if (controller.signal.aborted) return;
      if (error instanceof CreditAuthorityChanged) return;
      const apiError = error instanceof CreditLedgerError ? error : undefined;
      if (apiError?.code === 'cursor_expired') {
        state.nextCursor = null; state.snapshot = undefined; state.accountId = ''; state.selectedEntry = null; setState('cursor_expired');
      }
      else if (apiError?.code === 'reconnect_required' || apiError?.status === 401) { clearForAuthorityChange(''); setState('signed_out'); }
      else if (apiError?.code === 'offline' || apiError?.status === 0) setState('offline');
      else if (apiError?.code === 'unsupported') binding.root.hidden = true;
      else setState('error');
    } finally {
      if (state.pageController === controller) { state.pageController = undefined; render(); }
    }
  }

  async function loadDetail(entryId: string): Promise<void> {
    state.detailController?.abort();
    const controller = new AbortController(); state.detailController = controller;
    const epoch = ++state.detailEpoch; state.selectedEntry = null; render();
    let captured: { readonly authority: CreditAuthority; readonly key: string } | null;
    try { captured = await capture(controller.signal); }
    catch (error) {
      if (!isDetailCurrent(epoch, controller)) return;
      if (controller.signal.aborted) return;
      setState(error instanceof CreditLedgerError && error.code === 'offline' ? 'offline' : 'error'); render(); return;
    }
    if (!captured || !isDetailCurrent(epoch, controller)) {
      if (!captured && isDetailCurrent(epoch, controller)) clearForAuthorityChange('');
      return;
    }
    try {
      const body = await getJson(`/api/v1/me/credits/ledger/${encodeURIComponent(entryId)}`, captured.authority.serverOrigin, controller.signal);
      await assertCurrent(captured.key, controller.signal);
      if (!isDetailCurrent(epoch, controller)) return;
      state.selectedEntry = parseCreditLedgerEntryResponse(body).entry; render();
    } catch (error) {
      if (!isDetailCurrent(epoch, controller)) return;
      if (error instanceof CreditAuthorityChanged) return;
      if (error instanceof CreditLedgerError && error.code === 'offline') setState('offline');
      else if (error instanceof CreditLedgerError && error.code === 'unsupported') binding.root.hidden = true;
      else if (error instanceof CreditLedgerError && error.status === 401) { clearForAuthorityChange(''); setState('signed_out'); }
      else setState('error'); render();
    } finally {
      if (state.detailController === controller) state.detailController = undefined;
    }
  }

  function isDetailCurrent(epoch: number, controller: AbortController): boolean {
    return state.detailEpoch === epoch && state.detailController === controller && !controller.signal.aborted;
  }

  async function getJson(path: string, serverOrigin: string, signal?: AbortSignal): Promise<unknown> {
    if (binding.cloudEnabled?.() === false) throw new CreditLedgerError('unsupported', 404);
    const response = await cookieGet(fetcher, `${serverOrigin.replace(/\/$/u, '')}${path}`, {
      method: 'GET', credentials: 'include', redirect: 'error', cache: 'no-store', signal, headers: { Accept: 'application/json' } });
    if (response.status === 404) throw new CreditLedgerError('unsupported', 404);
    let body: unknown;
    try { body = await readBoundedJson(response, 256 * 1024, 'invalid_response', { signal }); }
    catch (error) { if (signal?.aborted) throw error; throw new CreditLedgerError('invalid_response', response.status); }
    if (!response.ok) {
      const error = record(body) ? body.error : undefined; const errorRecord = record(error) ? error : undefined;
      const code = typeof errorRecord?.code === 'string' ? errorRecord.code : 'credits_unavailable';
      throw new CreditLedgerError(code, response.status);
    }
    return body;
  }

  function readFilter(): CreditLedgerFilter {
    const read = (name: string) => filterForm?.elements.namedItem(name) as HTMLInputElement | HTMLSelectElement | null;
    const rawLimit = Number(read('limit')?.value ?? 20); const limit = Number.isInteger(rawLimit) && rawLimit >= 1 && rawLimit <= 100 ? rawLimit : 20;
    const rawKind = read('kind')?.value; const kind = CREDIT_KINDS.includes(rawKind as CreditKind) ? rawKind as CreditKind : undefined;
    const value = (name: string) => { const item = read(name)?.value.trim(); return item || undefined; };
    const from = value('from') ? toUtc(value('from')!) : undefined;
    const to = value('to') ? toUtc(value('to')!) : undefined;
    if (from && to && Date.parse(from) >= Date.parse(to)) throw new CreditLedgerError('invalid_request', 400);
    return { limit, ...(kind ? { kind } : {}), ...(from ? { from } : {}), ...(to ? { to } : {}),
      ...(value('chargeId') ? { chargeId: value('chargeId') } : {}), ...(value('runId') ? { runId: value('runId') } : {}) };
  }

  function setState(nextState: CreditsViewState): void {
    binding.root.dataset.creditState = nextState;
    for (const node of Array.from(binding.root.querySelectorAll<HTMLElement>('[data-credit-state-view]'))) {
      node.hidden = node.dataset.creditStateView !== nextState;
    }
    const list = binding.root.querySelector<HTMLElement>('[data-credit-list]');
    const actions = binding.root.querySelector<HTMLElement>('.credit-actions');
    const visible = nextState === 'ready' || nextState === 'empty' || nextState === 'filtered_empty';
    if (list) list.hidden = !visible;
    if (actions) actions.hidden = nextState !== 'ready';
  }
  function render(): void {
    const snapshot = state.snapshot; const balance = snapshot?.snapshot.balance;
    const summary = creditSummary(balance);
    setText('[data-credit-summary="title"]', summary.title);
    const hint = binding.root.querySelector<HTMLElement>('[data-credit-summary="hint"]');
    if (hint) { hint.textContent = summary.hint; hint.hidden = summary.hint === ''; }
    paintSelectPills(binding.root);
    const advanced =[state.filter.from, state.filter.to, state.filter.chargeId, state.filter.runId].filter(Boolean).length;
    const count = binding.root.querySelector<HTMLElement>('[data-credit-filter-count]');
    if (count) { count.hidden = advanced === 0; count.textContent = String(advanced); }
    const moreFilters = binding.root.querySelector<HTMLDetailsElement>('.credit-more-filters');
    if (moreFilters && advanced > 0) moreFilters.open = true;
    const list = binding.root.querySelector<HTMLElement>('[data-credit-list]'); list?.replaceChildren();
    for (const entry of snapshot?.items ?? []) list?.append(renderEntry(entry));
    if (next) { next.disabled = state.loading || !state.nextCursor; if (next.parentElement) next.parentElement.hidden = !state.nextCursor; }
    const detail = binding.root.querySelector<HTMLElement>('[data-credit-detail]');
    if (detail) { detail.hidden = !state.selectedEntry; detail.replaceChildren(); if (state.selectedEntry) detail.append(renderDetail(state.selectedEntry)); }
  }
  /* One scan lane per entry: date, what happened, the change and the balance after it.
     Sequence numbers, time zones and available/held deltas live in the row detail. */
  function renderEntry(entry: GeneratedCreditLedgerEntry): HTMLElement {
    const row = document.createElement('button'); row.type = 'button'; row.className = 'credit-row'; row.dataset.creditEntryId = entry.entryId;
    const part = (className: string, text: string): HTMLSpanElement => { const node = document.createElement('span'); node.className = className; node.textContent = text; return node; };
    const date = part('credit-row-date', shortDate(entry.postedAt)); date.title = formatMoment(entry.postedAt);
    const change = part('credit-row-change', formatChange(entry.pointsDelta));
    if (entry.pointsDelta > 0) change.classList.add('is-positive'); else if (entry.pointsDelta === 0) change.classList.add('is-zero');
    row.append(date, part('credit-row-label', entryLabel(entry)), change, part('credit-row-balance', entry.balanceAfter.available.toLocaleString()));
    return row;
  }
  function renderDetail(entry: GeneratedCreditLedgerEntry): HTMLElement {
    const fragment = document.createElement('div'); fragment.className = 'credit-entry-detail';
    const head = document.createElement('div'); head.className = 'credit-detail-head';
    const heading = document.createElement('h2'); heading.textContent = t('common_creditEntry', 'Credit entry');
    const kind = document.createElement('span'); kind.className = 'status-pill credit-entry-kind'; kind.dataset.tone = KIND_TONE[entry.kind] ?? 'neutral'; kind.textContent = entryLabel(entry);
    const points = document.createElement('strong'); points.className = 'credit-detail-points';
    points.textContent = formatSigned(entry.pointsDelta);
    if (entry.pointsDelta < 0) points.classList.add('is-negative'); else if (entry.pointsDelta > 0) points.classList.add('is-positive');
    const close = document.createElement('button'); close.type = 'button'; close.className = 'btn btn-ghost btn-sm';
    close.dataset.creditAction = 'close-detail'; close.textContent = t('common_close', 'Close');
    head.append(heading, kind, points, close); fragment.append(head);
    const grid = document.createElement('dl'); grid.className = 'credit-detail-grid';
    const rows: readonly [string, string][] = [
      [t('common_entryId', 'Entry ID'), entry.entryId], [t('common_sequence', 'Sequence'), entry.sequence], [t('common_posted', 'Posted'), formatTime(entry.postedAt)], [t('common_effective', 'Effective'), formatTime(entry.effectiveAt)],
      [t('common_timezone', 'Timezone'), Intl.DateTimeFormat().resolvedOptions().timeZone],
      [t('common_availableChange', 'Available change'), formatSigned(entry.availableDelta)],
      [t('common_reservedChange', 'Reserved change'), formatSigned(entry.reservedDelta)], [t('common_reason', 'Reason'), REASON_COPY[entry.reasonCode] ?? t('common_other', 'Other')], [t('common_source', 'Source'), sourceLabel(entry.source)],
      [t('common_balanceAfter', 'Balance after'), t('credits_availableReserved', '$1 available / $2 reserved', entry.balanceAfter.available.toLocaleString(), entry.balanceAfter.reserved.toLocaleString())],
      ...(entry.expiredPoints > 0 ? [[t('common_expiredCredits', 'Expired credits'), String(entry.expiredPoints)] as [string, string]] : []),
      [t('common_task', 'Task'), entry.task ? t('credits_collectionNodeRunAction', '$1; collection $2; node $3; run $4; action $5', entry.task.kind, entry.task.collectionId, entry.task.nodeId ?? t('common_none', 'None'), entry.task.runId ?? t('common_none', 'None'), entry.task.actionId ?? t('common_none', 'None')) : t('common_none', 'None')],
      [t('common_charge', 'Charge'), entry.chargeId ?? t('common_none', 'None')], [t('common_relatedEntry', 'Related entry'), entry.relatedEntryId ?? t('common_none', 'None')],
      [t('common_expires', 'Expires'), entry.expiresAt ? formatTime(entry.expiresAt) : t('common_none', 'None')],
    ];
    for (const [label, value] of rows) { const row = document.createElement('div'); const term = document.createElement('dt'); term.textContent = label;
      const definition = document.createElement('dd'); definition.textContent = value; row.append(term, definition); grid.append(row); }
    fragment.append(grid);
    const links = document.createElement('div'); links.className = 'credit-detail-links';
    const deepLink = document.createElement('a'); deepLink.href = chrome.runtime.getURL(`options.html?creditEntryId=${encodeURIComponent(entry.entryId)}#credits`);
    deepLink.textContent = t('credits_openThisEntry', 'Open this entry'); deepLink.target = '_self'; links.append(deepLink);
    if (entry.relatedEntryId) {
      const related = document.createElement('a'); related.href = chrome.runtime.getURL(`options.html?creditEntryId=${encodeURIComponent(entry.relatedEntryId)}#credits`);
      related.textContent = t('credits_openRelatedEntry', 'Open related entry'); related.target = '_self'; links.append(related);
    }
    fragment.append(links);
    return fragment;
  }
  function hasFilter(filter: CreditLedgerFilter): boolean { return Boolean(filter.kind || filter.from || filter.to || filter.chargeId || filter.runId); }
  function setText(selector: string, value: string): void { const node = binding.root.querySelector<HTMLElement>(selector); if (node) node.textContent = value; }
  function entryLabel(entry: GeneratedCreditLedgerEntry): string {
    if (entry.kind === 'release' && entry.expiredPoints > 0) return t('credits_holdReleasedCreditsExpired', 'Hold released; credits expired');
    if (entry.kind === 'release') return t('common_holdReleased', 'Hold released');
    if (entry.kind === 'reserve') return t('common_creditsReserved', 'Credits reserved');
    if (entry.kind === 'spend') return t('common_classificationCompleted', 'Classification completed');
    if (entry.kind === 'grant') return t('common_creditsGranted', 'Credits granted');
    if (entry.kind === 'refund') return t('common_creditsRefunded', 'Credits refunded');
    if (entry.kind === 'expire') return t('common_creditsExpired', 'Credits expired');
    if (entry.kind === 'topup') return t('credits_creditsToppedUp', 'Credits topped up');
    if (entry.kind === 'payment_refund') return t('common_paymentRefunded', 'Payment refunded');
    return t('common_other', 'Other');
  }
  function entryPurpose(entry: GeneratedCreditLedgerEntry): string {
    if (entry.task) return entry.task.kind === 'classification_action' ? t('common_classificationAction', 'Classification action') : t('common_classificationPreview', 'Classification preview');
    if (entry.kind === 'grant') return t('common_creditGrant', 'Credit grant');
    if (entry.kind === 'expire') return t('common_creditExpiry', 'Credit expiry');
    return REASON_COPY[entry.reasonCode] ?? t('common_other', 'Other');
  }
  function sourceLabel(source: GeneratedCreditLedgerEntry['source']): string {
    const SOURCE_LABEL: Record<GeneratedCreditLedgerEntry['source'], string> = {
      extension: t('common_browserExtension', 'Browser extension'), web: t('common_web', 'Web'), batch: t('common_batchClassification', 'Batch classification'),
      operator: t('common_knowNSupport', 'Know-N support'), scheduler: t('common_scheduledGrant', 'Scheduled grant'), system: t('common_knowN', 'Know-N'), payment: t('common_payment', 'Payment'),
    };
    return SOURCE_LABEL[source] ?? t('common_other', 'Other');
  }
  function authorityState(status: CreditAuthority['status']): CreditsViewState {
    return status === 'connecting' || status === 'refreshing' ? 'reconnecting'
      : status === 'offline' ? 'offline' : status === 'error' || status === 'policy_blocked' ? 'error' : 'signed_out';
  }
  return Object.freeze({ loadFirstPage, loadNextPage, loadDetail, clear: () => clearForAuthorityChange(''), render, setState });
}

export function createCreditOverviewClient(options: {
  readonly getAuthority: (signal?: AbortSignal) => Promise<CreditAuthority>; readonly fetch?: typeof fetch;
  readonly cloudEnabled?: boolean | (() => boolean);
}) {
  const fetcher = options.fetch ?? fetch;
  const cloudOff = () => (typeof options.cloudEnabled === 'function' ? options.cloudEnabled() : options.cloudEnabled) === false;
  return Object.freeze({
    async load(signal?: AbortSignal): Promise<GeneratedCreditOverview | 'unsupported'> {
      if (cloudOff()) return 'unsupported';
      const authority = await options.getAuthority(signal);
      if (authority.status !== 'connected' || !authority.serverOrigin || !authority.accountKey || !authority.businessAccountId) throw new CreditLedgerError('reconnect_required', 401);
      const response = await cookieGet(fetcher, `${authority.serverOrigin.replace(/\/$/u, '')}/api/v1/me/credits`, {
        credentials: 'include', cache: 'no-store', redirect: 'error', signal });
      if (response.status === 404) return 'unsupported';
      let body: unknown;
      try { body = await readBoundedJson(response, 256 * 1024, 'invalid_response', { signal }); }
      catch (error) { if (response.status === 404) return 'unsupported'; if (signal?.aborted) throw error; throw new CreditLedgerError('invalid_response', response.status); }
      const after = await options.getAuthority(signal);
      if (after.status !== 'connected' || !after.businessAccountId || authority.serverOrigin !== after.serverOrigin || authority.accountKey !== after.accountKey
        || authority.businessAccountId !== after.businessAccountId || authority.generation !== after.generation) {
        throw new CreditLedgerError('authority_changed', 0);
      }
      if (!response.ok) throw new CreditLedgerError(errorCode(body), response.status);
      const overview = parseCreditOverview(body);
      if (overview.accountId !== authority.businessAccountId) throw new CreditLedgerError('account_mismatch', 403);
      return overview;
    },
  });
}

export class CreditLedgerError extends Error {
  constructor(readonly code: string, readonly status: number) { super(code); this.name = 'CreditLedgerError'; }
}
class CreditAuthorityChanged extends Error { constructor() { super('authority_changed'); this.name = 'CreditAuthorityChanged'; } }

/** Product session subjects and business account ids are distinct identities. */
export async function resolveCreditBusinessAccountId(options: {
  readonly serverOrigin: string; readonly expectedSubject: string; readonly fetch?: typeof fetch; readonly signal?: AbortSignal;
}): Promise<string> {
  const fetcher = options.fetch ?? fetch;
  const get = async (path: string): Promise<unknown> => {
    const response = await cookieGet(fetcher, `${options.serverOrigin.replace(/\/$/u, '')}${path}`, {
      credentials: 'include', cache: 'no-store', redirect: 'error', signal: options.signal, headers: { Accept: 'application/json' } });
    let body: unknown;
    try { body = await readBoundedJson(response, 256 * 1024, 'invalid_response', { signal: options.signal }); }
    catch { throw new CreditLedgerError('invalid_response', response.status); }
    if (!response.ok) throw new CreditLedgerError(errorCode(body), response.status);
    return body;
  };
  const session = await get('/api/v1/session');
  if (!record(session) || session.authenticated !== true || typeof session.csrfToken !== 'string' || session.csrfToken.length === 0) {
    throw new CreditLedgerError('reconnect_required', 401);
  }
  const identityBody = await get('/api/v1/auth/get-session');
  const identityUser = record(identityBody) && record(identityBody.user) ? identityBody.user : null;
  if (!identityUser || identityUser.id !== options.expectedSubject) throw new CreditLedgerError('account_mismatch', 403);
  const body = await get('/api/v1/me');
  const account = record(body) && record(body.account) ? body.account : null;
  const profile = record(body) && record(body.profile) ? body.profile : null;
  if (!account || !opaqueId(account.id) || !profile || profile.id !== account.id) throw new CreditLedgerError('account_mismatch', 403);
  const finalIdentity = await get('/api/v1/auth/get-session');
  const finalUser = record(finalIdentity) && record(finalIdentity.user) ? finalIdentity.user : null;
  if (!finalUser || finalUser.id !== options.expectedSubject) throw new CreditLedgerError('account_mismatch', 403);
  return account.id;
}

export function parseCreditOverview(value: unknown): GeneratedCreditOverview {
  const root = record(value) ? value : null;
  const balance = root && record(root.balance) ? root.balance : null;
  if (!root || !closed(root, ['contractVersion', 'accountId', 'asOf', 'ledgerSequence', 'balance', 'prices'])
    || root.contractVersion !== '1.0.0' || !opaqueId(root.accountId) || !timestamp(root.asOf)
    || !sequence(root.ledgerSequence) || !balance || !creditBalance(balance) || !Array.isArray(root.prices)) {
    throw new CreditLedgerError('invalid_response', 200);
  }
  return { contractVersion: '1.0.0', accountId: root.accountId, asOf: root.asOf, ledgerSequence: root.ledgerSequence,
    balance: { available: balance.available, reserved: balance.reserved, expiringPoints: balance.expiringPoints,
      nextExpiryAt: balance.nextExpiryAt }, prices: root.prices.map(parsePrice) };
}
export function parseCreditLedgerPage(value: unknown): GeneratedCreditLedgerPage {
  const root = record(value) ? value : null;
  const snapshot = root && record(root.snapshot) ? root.snapshot : null;
  if (!root || !closed(root, ['contractVersion', 'accountId', 'snapshot', 'items', 'nextCursor'])
    || root.contractVersion !== '1.0.0' || !opaqueId(root.accountId) || !snapshot || !closed(snapshot, ['asOf', 'ledgerSequence', 'balance'])
    || !timestamp(snapshot.asOf) || !sequence(snapshot.ledgerSequence) || !record(snapshot.balance) || !creditBalance(snapshot.balance)
    || !Array.isArray(root.items) || !cursor(root.nextCursor)) throw new CreditLedgerError('invalid_response', 200);
  return { contractVersion: '1.0.0', accountId: root.accountId,
    snapshot: { asOf: snapshot.asOf, ledgerSequence: snapshot.ledgerSequence, balance: snapshot.balance },
    items: root.items.map(parseCreditLedgerEntry), nextCursor: root.nextCursor };
}
export function parseCreditLedgerEntry(value: unknown): GeneratedCreditLedgerEntry {
  const root = record(value) ? value : null;
  const balance = root && record(root.balanceAfter) ? root.balanceAfter : null;
  if (!root || !closed(root, ['entryId', 'sequence', 'kind', 'postedAt', 'effectiveAt', 'pointsDelta', 'availableDelta', 'reservedDelta',
    'expiredPoints', 'balanceAfter', 'operationType', 'source', 'reasonCode', 'grantId', 'chargeId', 'relatedEntryId', 'expiresAt', 'task'])
    || !uuid(root.entryId) || !sequence(root.sequence) || !CREDIT_KINDS.includes(root.kind as CreditKind)
    || !timestamp(root.postedAt) || !timestamp(root.effectiveAt) || !deltaPoints(root.pointsDelta)
    || !deltaPoints(root.availableDelta) || !deltaPoints(root.reservedDelta) || !nonNegativePoints(root.expiredPoints)
    || !balance || !closed(balance, ['available', 'reserved']) || !nonNegativePoints(balance.available) || !nonNegativePoints(balance.reserved)
    || !operationType(root.operationType) || !source(root.source) || !reasonCode(root.reasonCode)
    || !uuidOrNull(root.grantId) || !uuidOrNull(root.chargeId) || !uuidOrNull(root.relatedEntryId)
    || !timestampOrNull(root.expiresAt) || root.pointsDelta !== root.availableDelta + root.reservedDelta) throw new CreditLedgerError('invalid_response', 200);
  return { entryId: root.entryId, sequence: root.sequence, kind: root.kind as CreditKind, postedAt: root.postedAt,
    effectiveAt: root.effectiveAt, pointsDelta: root.pointsDelta, availableDelta: root.availableDelta,
    reservedDelta: root.reservedDelta, expiredPoints: root.expiredPoints,
    balanceAfter: { available: balance.available, reserved: balance.reserved },
    operationType: root.operationType as GeneratedCreditLedgerEntry['operationType'],
    source: root.source as GeneratedCreditLedgerEntry['source'], reasonCode: root.reasonCode as GeneratedCreditLedgerEntry['reasonCode'],
    grantId: root.grantId as string | null, chargeId: root.chargeId as string | null,
    relatedEntryId: root.relatedEntryId as string | null, expiresAt: root.expiresAt as string | null, task: parseTask(root.task) };
}
export function parseCreditLedgerEntryResponse(value: unknown): GeneratedCreditLedgerEntryResponse {
  const root = record(value) ? value : null;
  if (!root || !closed(root, ['contractVersion', 'entry']) || root.contractVersion !== '1.0.0') {
    throw new CreditLedgerError('invalid_response', 200);
  }
  return { contractVersion: '1.0.0', entry: parseCreditLedgerEntry(root.entry) };
}
function parseTask(value: unknown): GeneratedCreditLedgerEntry['task'] {
  if (value === null) return null;
  if (!record(value) || !closed(value, ['kind', 'collectionId', 'nodeId', 'runId', 'actionId'])
    || !['classification_preview', 'classification_action'].includes(value.kind as string)
    || !opaqueId(value.collectionId) || !opaqueIdOrNull(value.nodeId) || !opaqueIdOrNull(value.runId) || !opaqueIdOrNull(value.actionId)) {
    throw new CreditLedgerError('invalid_response', 200);
  }
  return { kind: value.kind as 'classification_preview' | 'classification_action', collectionId: value.collectionId,
    nodeId: value.nodeId as string | null, runId: value.runId as string | null, actionId: value.actionId as string | null };
}
function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function closed(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys); return Object.keys(value).every((key) => allowed.has(key));
}
function nonNegativePoints(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 2_147_483_647; }
function deltaPoints(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= -2_147_483_647 && value <= 2_147_483_647; }
function points(value: unknown): value is number { return nonNegativePoints(value); }
function opaqueId(value: unknown): value is string { return typeof value === 'string' && /^[A-Za-z0-9._~-]{1,128}$/u.test(value); }
function uuid(value: unknown): value is string { return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value); }
function uuidOrNull(value: unknown): boolean { return value === null || uuid(value); }
function opaqueIdOrNull(value: unknown): value is string | null { return value === null || opaqueId(value); }
function timestamp(value: unknown): value is string { return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) && !Number.isNaN(Date.parse(value)); }
function timestampOrNull(value: unknown): value is string | null { return value === null || timestamp(value); }
function sequence(value: unknown): value is string { return typeof value === 'string' && /^(0|[1-9][0-9]*)$/u.test(value); }
function cursor(value: unknown): value is string | null { return value === null || typeof value === 'string' && value.length > 0 && value.length <= 4096; }
function creditBalance(value: Record<string, unknown>): value is components['schemas']['CreditBalance'] {
  return closed(value, ['available', 'reserved', 'nextExpiryAt', 'expiringPoints'])
    && nonNegativePoints(value.available) && nonNegativePoints(value.reserved) && nonNegativePoints(value.expiringPoints)
    && timestampOrNull(value.nextExpiryAt);
}
function operationType(value: unknown): boolean {
  return ['bookmark.classify', 'credit.grant', 'credit.expire', 'credit.refund', 'credit.topup', 'credit.payment_refund'].includes(value as string);
}
function source(value: unknown): boolean { return ['extension', 'web', 'batch', 'operator', 'scheduler', 'system', 'payment'].includes(value as string); }
function reasonCode(value: unknown): boolean {
  return ['trial_grant', 'manual_grant', 'classification_requested', 'classification_completed', 'classification_failed',
    'classification_cancelled', 'classification_unneeded', 'credits_expired', 'hold_expired', 'manual_refund',
    'payment_received', 'payment_refunded'].includes(value as string);
}
function stringOrNull(value: unknown): value is string | null { return value === null || typeof value === 'string'; }
function parsePrice(value: unknown): CreditPrice {
  if (!record(value) || !closed(value, ['operationType', 'priceVersion', 'unit', 'unitPoints']) || value.operationType !== 'bookmark.classify' || typeof value.priceVersion !== 'string'
    || !/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(value.priceVersion) || value.unit !== 'bookmark' || !points(value.unitPoints)) {
    throw new CreditLedgerError('invalid_response', 200);
  }
  return { operationType: 'bookmark.classify', priceVersion: value.priceVersion, unit: 'bookmark', unitPoints: value.unitPoints };
}
function errorCode(value: unknown): string { const root = record(value) ? value : null; const error = root && record(root.error) ? root.error : null; return error && typeof error.code === 'string' ? error.code : 'credits_unavailable'; }
function toUtc(value: string): string { const date = new Date(value); if (Number.isNaN(date.getTime())) throw new CreditLedgerError('invalid_request', 400); return date.toISOString(); }
function formatPoints(value: number): string { return `${value > 0 ? '+' : ''}${value}`; }
function formatSigned(value: number): string { return formatPoints(value); }
/** A ledger row's change: a real minus sign, and an en dash when nothing moved in total (a hold only shifts credits). */
export function formatChange(value: number): string {
  return value > 0 ? `+${value.toLocaleString()}` : value < 0 ? `−${Math.abs(value).toLocaleString()}` : '–';
}
/** Month and day; the year only when it is not this one. */
export function shortDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString(uiLanguage(), { month: 'short', day: 'numeric', ...(date.getFullYear() === new Date().getFullYear() ? {} : { year: 'numeric' }) });
}
/** The plain-language balance: "12,480 available" and, when there is something to say, "320 on hold · 240 expire on Oct 13". */
export function creditSummary(balance: components['schemas']['CreditBalance'] | undefined): { readonly title: string; readonly hint: string } {
  if (!balance) return { title: t('credits_balanceUnavailable', 'Balance unavailable'), hint: '' };
  const parts: string[] = [];
  if (balance.reserved > 0) parts.push(t('credits_onHoldCount', '$1 on hold', balance.reserved.toLocaleString()));
  if (balance.expiringPoints > 0 && balance.nextExpiryAt) {
    parts.push(t('credits_expireOn', '$1 expire on $2', balance.expiringPoints.toLocaleString(), shortDate(balance.nextExpiryAt)));
  }
  return { title: t('credits_availableCount', '$1 available', balance.available.toLocaleString()), hint: parts.join(' · ') };
}
function formatTime(value: string): string { const date = new Date(value); return Number.isNaN(date.getTime()) ? value : `${date.toLocaleString()} (${Intl.DateTimeFormat().resolvedOptions().timeZone})`; }
