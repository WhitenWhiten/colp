import { t, tn } from '../i18n.js';
import type { MappingListItem, Page, SourceRef, SubscriptionCapabilities, SubscriptionPage } from '../bookmark-subscriptions/contracts.js';
import type { Draft } from '../bookmark-subscriptions/local-types.js';
import type { PendingExitSummary } from '../bookmark-subscriptions/local-views.js';
import { runtimeChanging, type LocalSummary } from './runtime-summary.js';
import type { Send } from './client.js';
import { createIcon } from '../icons.js';
import { createManagerMenu } from '../bookmark-manager-menu.js';
import { button as libraryButton, el as node, emptyBlock, iconButton, inlineAlert, searchCompact, selectOf, selectPill } from '../library-dom.js';
import { errorCopy, link, rssTile, when, type Tone } from './dom.js';
export type MappingRow = MappingListItem & { local: LocalSummary | null };
export type ListResult = { profileId: string; mappings: Page<MappingRow>; subscriptions: SubscriptionPage; capabilities: SubscriptionCapabilities; pendingDraft?: Draft | null; pendingExits?: PendingExitSummary[] };
const attention = new Set(['local_change', 'repair_pending', 'target_missing', 'capacity_exceeded', 'storage_unavailable', 'sign_in_required', 'permission_required', 'access_lost', 'retrying']);
const active = new Set(['initializing', 'applying', 'terminating']);
export function sortLocalMappings(items: MappingRow[]): MappingRow[] {
  const rank = (row: MappingRow) => attention.has(row.local?.state ?? '') ? 0 : active.has(row.local?.state ?? row.status) ? 1 : 2;
  return [...items].sort((a,b) => rank(a)-rank(b) || b.createdAt.localeCompare(a.createdAt) || a.mappingId.localeCompare(b.mappingId));
}
export function stateLabel(state: string): string {
  const labels: Record<string,string> = { initializing: t('subscription_state_initializing', 'Setting up'), applying: t('subscription_state_applying', 'Updating'), current: t('subscription_state_current', 'Updated'), empty: t('subscription_state_empty', 'Waiting for content'), paused: t('common_paused', 'Paused'), retrying: t('subscription_state_retrying', 'Update failed; retrying soon'), offline: t('subscription_state_offline', 'Offline; showing saved content'), capacity_exceeded: t('subscription_state_capacity_exceeded', 'Too many bookmarks'), storage_unavailable: t('subscription_state_storage_unavailable', 'Browser storage unavailable'), sign_in_required: t('subscription_state_sign_in_required', 'Sign in required'), permission_required: t('subscription_state_permission_required', 'Needs bookmark access'), target_missing: t('subscription_state_target_missing', 'Folder was deleted'), local_change: t('subscription_state_local_change', 'Changed in this browser'), repair_pending: t('subscription_state_repair_pending', 'Needs recovery'), access_lost: t('subscription_state_access_lost', 'No longer available to you'), terminating: t('subscription_state_terminating', 'Removing'), detached: t('subscription_state_detached', 'Removed'), active: t('subscription_state_active', 'Not added in this browser yet') };
  return labels[state] ?? state;
}
/** Badge color for a runtime state: problems first, then work in flight, then settled. */
export function stateTone(state: string): Tone {
  if (['local_change', 'repair_pending', 'target_missing', 'capacity_exceeded', 'storage_unavailable', 'access_lost'].includes(state)) return 'danger';
  if (attention.has(state) || state === 'offline') return 'warning';
  if (active.has(state)) return 'accent';
  return state === 'current' ? 'success' : 'muted';
}
/**
 * The one badge a row may wear. Settled states ("Updated") say nothing, so a
 * problem or work in flight is the only marked thing in the list.
 */
export function rowBadge(item: MappingRow, removed: boolean): { label: string; tone?: 'danger' | 'warning' } | undefined {
  if (removed) return { label: t('subscription_state_detached', 'Removed') };
  const state = item.local?.state;
  if (!state) return { label: item.profileLabel };
  if (state === 'retrying') return { label: t('subscription_cantReach', 'Can’t reach source'), tone: 'danger' };
  if (state === 'paused') return { label: t('common_paused', 'Paused'), tone: 'warning' };
  if (state === 'current') return undefined;
  const tone = stateTone(state);
  return { label: stateLabel(state), ...(tone === 'danger' || tone === 'warning' ? { tone } : {}) };
}
function badgeNode(badge: { label: string; tone?: 'danger' | 'warning' }): HTMLElement {
  const mark = node('span', badge.label, 'badge'); if (badge.tone) mark.dataset.tone = badge.tone; return mark;
}

function meta(parts: readonly (string | Node)[]): HTMLElement {
  const line = node('span', undefined, 'list-row-meta');
  parts.forEach((part, index) => { if (index) line.append(node('span', undefined, 'sep')); line.append(typeof part === 'string' ? node('span', part, 'grow') : part); });
  return line;
}
function setHead(title: string, hint?: string): HTMLElement {
  const head = node('div', undefined, 'set-group-head'); head.append(node('h2', title)); if (hint) head.append(node('p', hint)); return head;
}

let sharedMenu: ReturnType<typeof createManagerMenu> | undefined;
export function createSubscriptionList(host: HTMLElement, send: Send, navigate: (hash: string) => void, params: URLSearchParams, history = false, choose?: (source: SourceRef) => void, loaded?: () => void) {
  let generation = 0, disposed = false, firstLoad = true; let timer: ReturnType<typeof setTimeout> | undefined;
  const menu = (sharedMenu ??= createManagerMenu());
  const feedback = node('p', '', 'field-hint subscription-count'); feedback.setAttribute('role', 'status'); feedback.setAttribute('aria-live', 'polite');
  const rows = node('div', undefined, 'subscription-rows'), sources = node('section', undefined, 'set-group subscription-account-sources'), pendingRows = node('section', undefined, 'set-group subscription-pending-exits');
  const notices = node('div', undefined, 'subscription-notices');
  const q = searchCompact(t('subscription_sourceSearch', 'Search title or author')); q.input.maxLength = 100; q.input.value = params.get('q') ?? '';
  const type = selectOf([['', t('subscription_allTypes', 'All source types')], ['collection', t('subscription_collections', 'Collections')], ['digest_series', t('subscription_digest', 'Digest')]], params.get('source') ?? '');
  const scope = selectOf([['this_browser', t('common_thisBrowser', 'This browser')], ['all_browsers', t('subscription_allBrowsers', 'All browsers')]], params.get('devices') === 'all_browsers' ? 'all_browsers' : 'this_browser');
  const state = selectOf([['', t('subscription_allStates', 'All states')], ['attention', t('common_needsAttention', 'Needs attention')], ['running', t('subscription_running', 'Running')], ['paused', t('common_paused', 'Paused')]], params.get('status') ?? '');
  const statePill = selectPill(t('subscription_state', 'State'), state);
  const toolbar = node('div', undefined, 'toolbar subscription-toolbar'), form = node('form', undefined, 'subscription-filter-form');
  const reload = iconButton('refresh', t('subscription_reload', 'Reload'), () => { void load(); });
  toolbar.append(q.field, selectPill(t('subscription_sourceType', 'Source type'), type), statePill, selectPill(t('subscription_browsers', 'Browsers'), scope), node('span', undefined, 'toolbar-grow'), reload);
  const updateScope = () => { state.disabled = scope.value === 'all_browsers'; if (state.disabled) { state.value = ''; state.dispatchEvent(new Event('change')); } statePill.toggleAttribute('data-disabled', state.disabled); }; scope.addEventListener('change', updateScope); updateScope();
  form.append(toolbar);
  const filtersActive = () => Boolean(q.input.value.trim() || type.value || state.value);
  function applyFilters() { const filters = new URLSearchParams(); if (scope.value === 'all_browsers') filters.set('devices', scope.value); if (q.input.value) filters.set('q', q.input.value); if (type.value) filters.set('source', type.value); if (state.value) filters.set('status', state.value); navigate('#subscriptions/' + (history ? 'history' : 'list') + (filters.size ? '?' + filters.toString() : '')); }
  form.addEventListener('submit', event => { event.preventDefault(); applyFilters(); });
  for (const control of [type, scope, state]) control.addEventListener('change', applyFilters);
  let typing: ReturnType<typeof setTimeout> | undefined; q.input.addEventListener('input', () => { clearTimeout(typing); typing = setTimeout(applyFilters, 350); });

  // The head action lives with the page title; without one (a bare host) it sits at the end of the toolbar.
  const head = document.querySelector<HTMLElement>('[data-subscriptions-actions]') ?? toolbar;
  const add = libraryButton('', 'btn btn-primary btn-sm subscription-add', () => navigate('#subscriptions/new')); add.append(createIcon('plus', 14), t('subscription_add', 'Add subscription'));
  head.prepend(add);
  const views = node('nav', undefined, 'view-switch'); views.setAttribute('aria-label', t('subscription_subscriptionViews', 'Subscription views'));
  for (const [label, href, current] of [[t('subscription_live', 'In this browser'), '#subscriptions/list', !history], [t('subscription_history', 'Removed'), '#subscriptions/history', history]] as const) { const tab = node('a', label); tab.href = href; if (current) tab.setAttribute('aria-current', 'page'); views.append(tab); }
  /* Without an account or bookmark access nothing below can work, so the
     page shows the one step that unblocks it instead of a dead filter deck. */
  const gate = node('div', undefined, 'list-card connect-card'); gate.hidden = true;
  function showGate(code: string) {
    if (code === 'permission_required') {
      const allow = libraryButton(t('common_allowBookmarkAccess', 'Allow bookmark access'), 'btn btn-primary btn-sm', () => { void chrome.permissions.request({ permissions: ['bookmarks'] }).then(granted => { if (granted) void load(); }).catch(() => undefined); });
      gate.replaceChildren(emptyBlock({ icon: 'lock', title: t('common_allowBookmarkAccess', 'Allow bookmark access'), hint: t('subscription_gatePermission', 'Subscriptions appear as read-only folders in your browser bookmarks, so Know-N needs bookmark access.'), action: allow }));
    } else {
      const signIn = link(t('common_signIn', 'Sign in'), '#account'); signIn.className = 'btn btn-primary btn-sm';
      gate.replaceChildren(emptyBlock({ icon: 'person', title: t('subscription_gateSignInTitle', 'Sign in to use subscriptions'), hint: t('subscription_gateSignInHint', 'Subscriptions come from the collections and digests you follow on your Know-N account.'), action: signIn }));
    }
    gate.hidden = false; views.hidden = form.hidden = feedback.hidden = true; add.hidden = true; pendingRows.hidden = sources.hidden = true; notices.replaceChildren(); rows.replaceChildren();
    setSettingsHidden(true);
  }
  /** The account defaults and folder locations below the list wait behind the same gate. */
  function setSettingsHidden(hidden: boolean) { const settings = document.getElementById('subscription-defaults'); if (settings) settings.hidden = hidden; }
  host.replaceChildren(gate, views, form, notices, feedback, pendingRows, rows, sources);
  const matches = (item: MappingRow, serverFiltered: boolean) => {
    const matchesSource = serverFiltered || ((!type.value || item.sourceRef.sourceType === type.value)
      && (!q.input.value.trim() || [item.source?.title, item.source?.owner?.displayName].join(' ').toLocaleLowerCase().includes(q.input.value.trim().toLocaleLowerCase())));
    return matchesSource && (scope.value === 'all_browsers' || !state.value
      || (state.value === 'attention' ? attention.has(item.local?.state ?? '')
        : state.value === 'running' ? active.has(item.local?.state ?? item.status) : item.local?.state === state.value));
  };
  async function load(cursor?: string) {
    clearTimeout(timer); const focusedId = document.activeElement?.id, scroll = host.parentElement?.scrollTop;
    const version = ++generation; feedback.textContent = '';
    try {
      const serverFiltered = history || scope.value === 'all_browsers';
      const searchTerm = q.input.value.trim();
      let result = await send<ListResult>(cursor ? { kind: 'list', cursor } : {
        kind: 'list', status: history ? 'detached' : 'live', scope: scope.value as 'this_browser'|'all_browsers',
        ...(serverFiltered && searchTerm ? { q: searchTerm } : {}),
        ...(serverFiltered && type.value ? { sourceType: type.value as SourceRef['sourceType'] } : {}),
      });
      if (version !== generation) return;
      let mappings = [...result.mappings.items]; const seen = new Set<string>();
      if (!history && scope.value === 'this_browser') while (result.mappings.nextCursor) { const next = result.mappings.nextCursor; if (seen.has(next) || mappings.length >= 50) throw new Error('mapping_page_limit'); seen.add(next); const more = await send<ListResult>({ kind: 'list', cursor: next }); if (version !== generation) return; mappings.push(...more.mappings.items); result = { ...result, mappings: more.mappings }; }
      if (version !== generation) return; rows.replaceChildren(); notices.replaceChildren(); gate.hidden = true; views.hidden = form.hidden = feedback.hidden = false; add.hidden = false; setSettingsHidden(false);
      add.disabled = result.capabilities.protocolVersion !== 1 || !result.capabilities.contentEnabled;
      if (!result.capabilities.contentEnabled) notices.append(inlineAlert('warning', t('subscription_contentDisabled', 'Know-N has paused content updates. You can still review and remove existing folders.')));
      const displayed = history || scope.value === 'all_browsers' ? mappings : sortLocalMappings(mappings);
      const shown = displayed.filter(item => matches(item, serverFiltered));
      const card = node('div', undefined, 'list-card');
      for (const item of shown) card.append(renderRow(item));
      const pending = !history && scope.value === 'this_browser' ? result.pendingExits ?? [] : [];
      const visible = new Set(displayed.filter(item => matches(item, serverFiltered) && item.local?.ackPending).map(item => JSON.stringify([item.mappingId, item.generation])));
      const pendingOnly = pending.filter(ack => !visible.has(JSON.stringify([ack.mappingId, ack.generation])));
      pendingRows.replaceChildren(); pendingRows.hidden = !pendingOnly.length;
      if (pendingOnly.length) {
        const waiting = node('div', undefined, 'list-card');
        for (const ack of pendingOnly) {
          const row = node('div', undefined, 'list-row'), main = node('span', undefined, 'list-row-main');
          main.append(node('span', ack.localAlias ?? t('subscription_pendingExit', 'Removed subscription'), 'list-row-title'), meta([receiptLabel(ack.result), t('subscription_ackPending', 'Removed here. Waiting for Know-N to confirm.')]));
          row.append(rssTile(), main, node('span', undefined, 'list-row-tail')); waiting.append(row);
        }
        pendingRows.append(setHead(t('subscription_pendingExits', 'Waiting for confirmation')), waiting);
      }
      if (!shown.length) {
        const fresh = !history && scope.value === 'this_browser' && !filtersActive();
        const clear = libraryButton(t('common_clearFilters', 'Clear filters'), 'btn btn-secondary btn-sm', () => { navigate('#subscriptions/' + (history ? 'history' : 'list')); });
        // The page head's Add subscription stays the one primary action; this repeats it where the eye lands.
        const addFirst = libraryButton('', 'btn btn-secondary btn-sm', () => navigate('#subscriptions/new')); addFirst.append(createIcon('plus', 14), t('subscription_add', 'Add subscription'));
        card.append(emptyBlock(fresh
          ? { icon: 'rss', title: t('subscription_noneYet', 'No subscriptions yet'), hint: t('subscription_noneYetHint', 'Follow a collection or digest on Know-N, then add it here as a read-only folder.'), action: addFirst }
          : { icon: 'rss', title: t('subscription_noMappings', 'No subscription folders match these filters.'), ...(filtersActive() ? { action: clear } : {}) }));
      }
      rows.append(card);
      if ((history || scope.value === 'all_browsers') && result.mappings.nextCursor) rows.append(libraryButton(t('common_nextPage', 'Next page'), 'btn btn-secondary btn-sm', () => { void load(result.mappings.nextCursor!); }));
      sources.replaceChildren(setHead(t('subscription_accountSources', 'Not in this browser yet'), t('subscription_accountSourcesHint', 'Subscribed on your account. Add one here to get it as a read-only folder.')));
      const list = node('div', undefined, 'list-card subscription-source-list'); sources.append(list);
      const mounted = new Set(mappings.filter(item => item.status !== 'detached' && item.local).map(item => item.subscriptionId));
      function appendSources(page: SubscriptionPage) {
        sources.querySelector('[data-next-sources]')?.remove();
        for (const subscription of page.items) {
          if (mounted.has(subscription.subscriptionId)) continue;
          const row = node('div', undefined, 'list-row'), main = node('span', undefined, 'list-row-main'), tail = node('span', undefined, 'list-row-tail');
          main.append(node('span', subscription.source?.title ?? t('subscription_unavailableSource', 'Source unavailable'), 'list-row-title'));
          if (subscription.source?.owner?.displayName) main.append(meta([subscription.source.owner.displayName]));
          if (subscription.source && subscription.status === 'active') tail.append(libraryButton(t('subscription_mountHere', 'Add to this browser'), 'btn btn-secondary btn-sm', () => choose?.(subscription)));
          row.append(rssTile(), main, tail); list.append(row);
        }
        sources.hidden = !list.children.length && !page.nextCursor || history || scope.value === 'all_browsers'; list.hidden = !list.children.length;
        if (page.nextCursor) { const more = libraryButton(t('subscription_moreSources', 'More account subscriptions'), 'btn btn-ghost btn-sm', () => { more.disabled = true; void send<SubscriptionPage>({ kind: 'subscriptions', cursor: page.nextCursor! }).then(value => { if (version === generation) appendSources(value); }).catch(error => { feedback.textContent = errorCopy(error); more.disabled = false; }); }); more.dataset.nextSources = ''; sources.append(more); }
      }
      appendSources(result.subscriptions);
      head.querySelector('[data-website-draft]')?.remove();
      if (firstLoad) { loaded?.(); firstLoad = false; } else { if (scroll !== undefined && host.parentElement) host.parentElement.scrollTop = scroll; if (focusedId) document.getElementById(focusedId)?.focus({ preventScroll: true }); }
      if (!history && scope.value === 'this_browser' && (pending.length || mappings.some(item => runtimeChanging(item.local)))) schedule();
      if (result.pendingDraft && !history) { const draftAction = libraryButton(t('subscription_continueDraft', 'Continue website setup'), 'btn btn-secondary btn-sm', () => navigate('#subscriptions/new?draft=' + result.pendingDraft!.requestId)); draftAction.dataset.websiteDraft = ''; head.prepend(draftAction); }
    } catch (error) { if (version !== generation) return; const code = error instanceof Error ? error.message : ''; if (code === 'sign_in_required' || code === 'permission_required') showGate(code); else { rows.replaceChildren(); notices.replaceChildren(inlineAlert('danger', errorCopy(error), libraryButton(t('common_retry', 'Retry'), 'btn btn-ghost btn-sm', () => { void load(); }))); } }
  }
  function schedule() { clearTimeout(timer); if (disposed) return; timer = setTimeout(() => { if (document.hidden || document.querySelector('.subscription-dialog')) schedule(); else void load(); }, 5000); }
  function receiptLabel(result: PendingExitSummary['result']) {
    const labels = { kept: t('subscription_exitResult_kept', 'Kept as your own bookmarks'), removed: t('subscription_exitResult_removed', 'Folder deleted'), removed_access_lost: t('subscription_exitResult_removed_access_lost', 'Deleted (no longer available)'), no_local_mount: t('subscription_exitResult_no_local_mount', "Wasn't added in this browser") };
    return labels[result];
  }
  function detailHash(item: MappingRow): string {
    const returnRoute = 'subscriptions/' + (history ? 'history' : 'list') + (params.size ? '?' + params.toString() : '');
    return '#subscriptions/detail?mapping=' + item.mappingId + '&return=' + encodeURIComponent(returnRoute);
  }
  function renderRow(item: MappingRow): HTMLElement {
    const local = item.local, row = node('div', undefined, 'list-row sub-row'), main = node('span', undefined, 'list-row-main'), tail = node('span', undefined, 'list-row-tail');
    const title = node('a', item.source?.title ?? t('subscription_unavailableSource', 'Source unavailable'), 'list-row-title'); title.href = detailHash(item); title.id = 'subscription-mapping-' + item.mappingId;
    const parts: (string | Node)[] = [item.sourceRef.sourceType === 'digest_series' ? t('subscription_digest', 'Digest') : t('common_collection', 'Collection')];
    if (typeof local?.bookmarkCount === 'number') parts.push(tn('subscription_bookmarkTotal', local.bookmarkCount, '$1 bookmark', '$1 bookmarks'));
    if (item.source?.owner?.displayName) parts.push(item.source.owner.displayName);
    if (local?.mountPath?.length) { const place = node('span', undefined, 'grow subscription-card-path'); place.title = t('subscription_mountPath', 'Location'); place.append(createIcon('folder', 12), node('span', local.mountPath.join(' › '))); parts.push(place); }
    if (local) { const checked = node('span', undefined, 'grow'); checked.append(t('subscription_checked', 'Checked') + ' ', when(local.lastCheckedAt)); parts.push(checked); }
    else parts.push(t('subscription_remoteConfigured', 'Added on another browser. That browser reports its own status.'));
    main.append(title, meta(parts));
    const badge = rowBadge(item, history || item.status === 'detached');
    if (badge) tail.append(badgeNode(badge));
    const state = local?.state ?? '';
    const returnTo = detailHash(item);
    if (!history && local && item.status === 'active') {
      if (state === 'retrying') {
        tail.append(libraryButton(t('common_retry', 'Retry'), 'btn btn-ghost btn-sm', () => { void send({ kind: 'refresh', mappingId: item.mappingId, expectedGeneration: item.generation }).then(() => load()).catch(error => { notices.replaceChildren(inlineAlert('danger', errorCopy(error))); }); }));
      } else if (attention.has(state)) {
        const fix = link(t('subscription_resolve', 'Fix'), returnTo); fix.className = 'btn btn-ghost btn-sm'; tail.append(fix);
      } else {
        const items = [
          ...(local.enabled ? [{ label: t('subscription_refreshNow', 'Update now'), run: () => { void send({ kind: 'refresh', mappingId: item.mappingId, expectedGeneration: item.generation }).then(() => load()).catch(error => { notices.replaceChildren(inlineAlert('danger', errorCopy(error))); }); } }] : []),
          { label: t('common_manage', 'Manage'), run: () => navigate(returnTo) },
        ];
        const more = iconButton('more-horizontal', `${t('common_moreActions', 'More actions')} ${item.source?.title ?? ''}`.trim(), undefined);
        more.addEventListener('click', event => { event.stopPropagation(); const rect = more.getBoundingClientRect(); menu.openAt(rect.right - 176, rect.bottom + 4, items, more); });
        tail.append(more);
      }
    }
    row.append(rssTile(), main, tail);
    row.addEventListener('click', event => { if (!(event.target instanceof Element && event.target.closest('a, button'))) navigate(returnTo); });
    return row;
  }
  void load(); return { dispose() { disposed = true; clearTimeout(timer); clearTimeout(typing); generation++; menu.close(); add.remove(); head.querySelector('[data-website-draft]')?.remove(); host.replaceChildren(); } };
}
