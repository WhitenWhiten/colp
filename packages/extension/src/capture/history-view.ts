import { t, tn, uiLanguage } from '../i18n.js';
import { createViewRefresh, preserveViewPosition } from '../view-refresh.js';
import type { HubRoute } from '../options-router.js';
import type { CaptureTask } from './contracts.js';
import type { LocalHistoryItem } from './local-history.js';
import type { CaptureStatistics } from './statistics.js';
import type { operations } from '../../../server/generated/openapi/product-v1.js';
import type { CaptureHistoryRequest } from '../sw/capture-history.js';
import { captureDetail } from './history-detail.js';
import { createHistoryOverview } from './history-overview.js';
import { renderHistoryRow, renderRemoteRow, type RowRetry } from './history-row.js';
import { createHistoryToolbar } from './history-toolbar.js';
import { deviceHistoryClearButton } from '../device-history-clear.js';
import { createIcon } from '../icons.js';
import { button, el, emptyBlock, inlineAlert, setPill } from '../library-dom.js';
type RemoteItem = operations['getCaptureHistory']['responses'][200]['content']['application/json']['items'][number];
interface HistoryResponse { ok: boolean; items: LocalHistoryItem[]; remoteItems?: RemoteItem[]; next: [number, string] | null; statistics: CaptureStatistics; unreported: number }

const dayKey = (at: number, timeZone: string): string => {
  try { return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at); }
  catch { return new Date(at).toDateString(); }
};
function dayLabel(at: number, timeZone: string): string {
  const key = dayKey(at, timeZone);
  if (key === dayKey(Date.now(), timeZone)) return t('history_today', 'Today');
  if (key === dayKey(Date.now() - 86_400_000, timeZone)) return t('history_yesterday', 'Yesterday');
  try { return new Date(at).toLocaleDateString(uiLanguage(), { timeZone, weekday: 'long', month: 'long', day: 'numeric' }); }
  catch { return new Date(at).toLocaleDateString(uiLanguage(), { weekday: 'long', month: 'long', day: 'numeric' }); }
}

export function createCaptureHistoryViews(host: HTMLElement) {
  const section = host.querySelector<HTMLElement>('[data-capture-view="history"]')!;
  const content = section.querySelector<HTMLElement>('[data-capture-content]')!;
  const card = section.closest<HTMLElement>('#history-card');
  const overview = createHistoryOverview(host.querySelector<HTMLElement>('[data-capture-view="overview"] [data-capture-content]'));
  const zoneValue = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const bar = createHistoryToolbar(zoneValue);
  // A page action beside Save tabs, not a stray line under the filters; nothing to clear hides it.
  const clearDevice = deviceHistoryClearButton(() => { void load(); }); clearDevice.hidden = true;
  card?.querySelector('.page-head-actions')?.prepend(clearDevice);
  const { query, days, filter, scope, source, collection, zone } = bar;

  const status = el('p', undefined, 'field-hint hist-status'); status.setAttribute('role', 'status'); status.hidden = true;
  const updates = button(t('capture_showUpdatedRecords', 'Show updated records'), 'btn btn-ghost btn-sm'); updates.hidden = true;
  const failure = el('div', undefined, 'hist-failure'); failure.hidden = true;
  const notice = el('div', undefined, 'hist-notice'); notice.append(status, updates); notice.hidden = true;
  const selection = el('div', undefined, 'list-card hist-selection'); selection.hidden = true;
  const selectionBar = el('div', undefined, 'card-bar');
  const selectionCount = el('span', undefined, 'grow');
  const selectPage = button(t('capture_selectPage', 'Select this page'), 'btn btn-ghost btn-sm');
  const check = button(t('capture_checkSelectedSaveResults', 'Check selected save results'), 'btn btn-secondary btn-sm');
  selectionBar.append(selectionCount, selectPage, check); selection.append(selectionBar);
  const list = el('div', undefined, 'hist-list');
  const more = button(t('common_loadMore', 'Load more'), 'btn btn-secondary btn-sm capture-load-more'); more.hidden = true;
  const detail = el('div', undefined, 'hist-detail-slot');
  // The selection bar follows the rows and sticks to the window's bottom edge, so its actions stay in reach.
  const listing = el('div', undefined, 'hist-listing'); listing.append(bar.element, failure, notice, list, selection, more);
  content.replaceChildren(listing, detail);

  const selected = new Set<string>(), tasks = new Map<string, LocalHistoryItem>();
  let active = false, foregroundLoads = 0, hasSnapshot = false, selecting = false, returnFocus: string | null = null;
  let route: HubRoute, version = 0, cloudGeneration = 0, next: [number, string] | null = null, lastQuery = '', rows: LocalHistoryItem[] = [], remote: RemoteItem[] = [];
  const invalidation = createViewRefresh({ active: () => active,
    editing: () => Boolean(content.contains(document.activeElement)) || rows.length > 50 || remote.length > 50, refresh: () => load(false, true) });
  chrome.runtime.onMessage.addListener(message => { if ((message as { kind?: string })?.kind === 'known.capture.invalidated') invalidation.invalidate(); });

  const say = (text: string) => { status.textContent = text; status.hidden = text === ''; notice.hidden = status.hidden && updates.hidden; failure.hidden = true; };
  /** A load that failed: one alert with a way to try again. */
  const fail = (text: string, tone: 'danger' | 'warning') => {
    failure.replaceChildren(inlineAlert(tone, text, button(t('common_retry', 'Retry'), 'btn btn-ghost btn-sm', () => { void load(); }))); failure.hidden = false;
  };
  function navigate(values: Record<string, string>) {
    const params = new URLSearchParams(Object.entries(values).filter(([, value]) => value !== '')), hash = `#history?${params}`;
    if (location.hash === hash) void load(); else location.hash = hash;
  }
  const filters = () => ({ days: days.value, status: filter.value, source: source.value, collection: collection.value, q: query.value, timezone: zone.value, devices: scope.value });
  for (const control of [days, filter, scope, source, collection, zone]) control.addEventListener('change', () => { navigate(filters()); });
  let typing: ReturnType<typeof setTimeout> | undefined;
  query.addEventListener('input', () => { clearTimeout(typing); typing = setTimeout(() => { navigate(filters()); }, 300); });
  query.addEventListener('keydown', (event) => { if (event.key === 'Enter') { clearTimeout(typing); navigate(filters()); } });
  bar.clear.addEventListener('click', () => { location.hash = 'history'; });
  more.addEventListener('click', () => { void load(true); });
  updates.addEventListener('click', () => { void load(); });
  bar.select.addEventListener('click', () => { setSelecting(!selecting); });
  selectPage.addEventListener('click', () => { for (const task of rows.slice(-50)) if (!task.historyReadOnly) selected.add(task.captureId); paintRows(); });
  check.addEventListener('click', () => {
    const ids = [...selected].filter(id => tasks.get(id)?.save === 'unknown'); check.disabled = true;
    void Promise.all(ids.map(captureId => chrome.runtime.sendMessage({ kind: 'known.capture.check', captureId }))).then(() => load()).finally(updateSelection);
  });

  function setSelecting(on: boolean) {
    selecting = on; if (!on) selected.clear();
    bar.select.textContent = on ? t('common_done', 'Done') : t('manager_select', 'Select'); bar.select.setAttribute('aria-pressed', String(on));
    paintRows();
  }
  function updateSelection() {
    selectionCount.textContent = t('manager_selectedCount', '$1 selected', selected.size);
    check.disabled = ![...selected].some(id => tasks.get(id)?.save === 'unknown');
  }
  const openTask = (captureId: string) => { const params = new URLSearchParams(route.params); params.set('task', captureId); location.hash = `history?${params}`; };
  async function retry(kind: RowRetry, task: LocalHistoryItem) {
    const message = kind === 'check' ? { kind: 'known.capture.check', captureId: task.captureId } : kind === 'resume' ? { kind: 'known.capture.resume', captureId: task.captureId }
      : { kind: 'known.capture.report.retry', captureId: task.captureId };
    try {
      const reply = await chrome.runtime.sendMessage(message) as { ok?: boolean };
      if (!reply?.ok) throw new Error();
      say(''); await load();
    } catch { say(t('history_retryFailed', 'That did not work. Try again in a moment.')); }
  }

  function setMode(detailOpen: boolean) {
    listing.hidden = detailOpen; detail.hidden = !detailOpen;
    if (card) card.dataset.view = detailOpen ? 'detail' : 'list';
  }
  /** Leaving a detail with unsaved edits parks it, so coming back to the same save finds the draft where it was left. */
  const drafts = new Map<string, Element>();
  function leaveDetail() {
    const current = detail.firstElementChild, id = (current as HTMLElement | null)?.dataset.taskId;
    if (current && id && current.querySelector('[data-dirty]')) drafts.set(id, current);
    detail.replaceChildren();
  }
  function closeDetail() {
    const params = new URLSearchParams(route.params); params.delete('task');
    returnFocus = route.params.get('task'); leaveDetail();
    location.hash = `history${params.size ? `?${params}` : ''}`;
  }
  function backButton(): HTMLButtonElement {
    const back = button('', 'btn btn-ghost btn-sm detail-back'); back.append(createIcon('arrow-left', 14), t('common_history', 'History'));
    back.setAttribute('aria-label', t('history_backToHistory', 'Back to History')); back.addEventListener('click', closeDetail);
    return back;
  }
  function remoteDetail(id: string): HTMLElement {
    const entry = remote.find(item => item.report.captureId === id), view = el('aside', undefined, 'hist-detail'); view.tabIndex = -1;
    const head = el('header', undefined, 'detail-head'), title = el('div', undefined, 'detail-title');
    title.append(el('h1', entry?.report.title ?? t('common_taskUnavailable', 'Task unavailable')));
    head.append(title);
    const cardEl = el('div', undefined, 'set-card'), noteRow = el('div', undefined, 'set-row');
    noteRow.append(el('p', entry ? t('capture_taskRecordedAnotherBrowser', 'This task was recorded on another browser.') : t('capture_taskUnavailableCurrentAccount', 'This task is unavailable in the current account.'), 'set-row-title'));
    cardEl.append(noteRow);
    if (entry) {
      const where = el('div', undefined, 'set-row'), text = el('div', undefined, 'set-row-text');
      text.append(el('p', t('sync_folder', 'Folder'), 'set-row-title'));
      where.append(text, el('span', entry.decision?.path?.join(' › ') ?? entry.report.localPath.join(' › '), 'set-row-value'));
      const open = el('a', undefined, 'btn btn-ghost btn-sm'); open.href = entry.report.url; open.target = '_blank'; open.rel = 'noreferrer';
      open.append(createIcon('arrow-up-right', 14), t('common_openWebpage', 'Open webpage'));
      const actions = el('div', undefined, 'set-row'); actions.append(open);
      cardEl.append(where, actions);
    }
    view.append(backButton(), head, cardEl);
    return view;
  }
  async function showDetail(id: string, force = false) {
    const generation = version;
    if ((detail.firstElementChild as HTMLElement | null)?.dataset.taskId !== id) leaveDetail();
    const parked = drafts.get(id);
    if (parked && !force) { drafts.delete(id); detail.replaceChildren(parked); setMode(true); return; }
    const current = detail.firstElementChild;
    if (current && !force && (current.contains(document.activeElement) || current.querySelector('[data-dirty]'))) return;
    if (current?.querySelector('[data-dirty]')) {
      const note = current.querySelector('.detail-status'); if (note) note.textContent = t('history_saveBeforeRefresh', 'Save or cancel your changes before refreshing. Your edits are kept.');
      return;
    }
    let task = tasks.get(id);
    try {
      const reply = await chrome.runtime.sendMessage({ kind: 'known.capture.get', captureId: id }) as { ok: boolean; task?: CaptureTask };
      if (reply.ok && !task?.historyReadOnly) task = reply.task;
    } catch { /* Retain the last local snapshot during a worker restart. */ }
    if (generation !== version || route.params.get('task') !== id) return;
    const view = task ? captureDetail(task, { timezone: zone.value, refresh: () => showDetail(id, true), close: closeDetail, readOnly: Boolean((task as LocalHistoryItem).historyReadOnly), historyOrigin: (task as LocalHistoryItem).historyOrigin }) : remoteDetail(id);
    view.dataset.taskId = id; drafts.delete(id);
    detail.replaceChildren(view);
    if (!current) { view.focus({ preventScroll: true }); window.scrollTo({ top: 0 }); }
  }

  function group(label: string): HTMLElement { return el('h2', label, 'day-label'); }
  function paintRows() {
    list.replaceChildren(); selection.hidden = !selecting; listing.toggleAttribute('data-selecting', selecting);
    // Before the empty return below: set only at the end, an empty first page left the button visible.
    more.hidden = !next;
    const visibleRemote = remote.filter(item => {
      const state = item.fact.needsAttention ? 'attention' : item.fact.save !== 'local-saved' || ['pending', 'syncing'].includes(item.fact.sync) ? 'progress' : 'completed';
      return filter.value === 'all' || filter.value === state;
    });
    if (!rows.length && !visibleRemote.length) {
      const filtered = filter.value !== 'all' || query.value !== '' || source.value !== '' || collection.value !== '' || days.value !== '7';
      const clear = button(t('common_clearFilters', 'Clear filters'), 'btn btn-secondary btn-sm'); clear.addEventListener('click', () => { location.hash = 'history'; });
      const empty = next ? emptyBlock({ icon: 'clock', title: t('capture_noMatchingTasksPage', 'No matching tasks on this page. Load more to continue.') })
        : emptyBlock({ icon: 'clock', title: filtered ? t('history_nothingMatches', 'Nothing matches these filters') : t('history_nothingYet', 'Nothing saved yet'),
          hint: filtered ? t('history_tryWider', 'Try a longer period or clear the filters.') : t('history_nothingYetHint', 'Pages you save with Know-N will show up here.'), ...(filtered ? { action: clear } : {}) });
      const holder = el('div', undefined, 'list-card'); holder.append(empty); list.append(holder);
      return;
    }
    updateSelection();
    let currentKey = '', cardEl: HTMLElement | undefined;
    for (const task of rows) {
      const key = dayKey(task.createdAt, zone.value);
      if (key !== currentKey) { currentKey = key; list.append(group(dayLabel(task.createdAt, zone.value))); cardEl = el('div', undefined, 'list-card'); if (selecting) cardEl.dataset.selecting = ''; list.append(cardEl); }
      cardEl!.append(renderHistoryRow(task, { timezone: zone.value, selected: selected.has(task.captureId), open: () => { openTask(task.captureId); }, retry,
        select: (on) => { if (on) selected.add(task.captureId); else selected.delete(task.captureId); updateSelection(); } }));
    }
    if (visibleRemote.length) {
      list.append(group(t('history_otherBrowsers', 'On other browsers'))); const other = el('div', undefined, 'list-card');
      for (const item of visibleRemote) other.append(renderRemoteRow({ url: item.report.url, title: item.report.title, path: item.decision?.path?.join(' › ') ?? item.report.localPath.join(' › ') }, zone.value, () => { openTask(item.report.captureId); }));
      list.append(other);
    }
  }
  async function load(append = false, background = false) {
    if (background && foregroundLoads > 0) { invalidation.invalidate(); return; }
    if (!background) foregroundLoads++;
    const restore = preserveViewPosition(host);
    const current = ++version; more.disabled = true;
    const message: CaptureHistoryRequest = { kind: 'known.capture.history', days: Number(days.value) as 7 | 30 | 90,
      timezone: zone.value, status: filter.value as CaptureHistoryRequest['status'], q: query.value, source: source.value,
      collectionId: route.params.get('collection') ?? '', ...(route.params.get('day') ? { day: route.params.get('day')! } : {}), deviceScope: scope.value as 'local' | 'cloud', ...(append && next ? { before: next } : {}) };
    try {
      const response = await chrome.runtime.sendMessage(message) as HistoryResponse;
      if (current !== version) return;
      if (background && list.contains(document.activeElement)) { invalidation.invalidate(); return; }
      if (!response?.ok) throw new Error();
      if (background && hasSnapshot && JSON.stringify([rows.map(task => task.captureId), remote.map(item => item.report.captureId)])
        !== JSON.stringify([response.items.map(task => task.captureId), (response.remoteItems ?? []).map(item => item.report.captureId)])) {
        updates.hidden = false; say(t('capture_updatedRecordsAvailableShow', 'Updated records are available. Show them when you are ready.')); return;
      }
      updates.hidden = true; hasSnapshot = true;
      rows = append ? [...rows, ...response.items] : response.items; remote = append ? [...remote, ...response.remoteItems ?? []] : response.remoteItems ?? [];
      for (const task of rows) tasks.set(task.captureId, task); next = response.next;
      clearDevice.hidden = rows.length === 0;
      say(response.unreported ? tn('capture_unreportedRecords', response.unreported, '$1 local record not yet reported', '$1 local records not yet reported') : '');
      overview.render(response.statistics, (state, day) => navigate({ days: days.value, status: state, timezone: zone.value, devices: scope.value, q: query.value, source: source.value, ...(day ? { day } : {}) }));
      paintRows(); restore();
      const id = route.params.get('task');
      if (id) await showDetail(id);
      else if (returnFocus) { list.querySelector<HTMLElement>(`#capture-row-${CSS.escape(returnFocus)}`)?.focus(); returnFocus = null; }
    } catch {
      if (current === version) {
        if (navigator.onLine) fail(hasSnapshot ? t('capture_recordsCouldNotRefreshed', 'Records could not be refreshed. Previous data is retained.') : t('history_couldNotLoad', 'Your history could not be loaded.'), 'danger');
        else fail(t('capture_offlineShowingLastAvailable', 'Offline · showing the last available records.'), 'warning');
      }
    }
    finally { if (!background) foregroundLoads--; if (current === version) more.disabled = false; }
  }
  return {
    activate(nextRoute: HubRoute) {
      active = true; invalidation.wake(); route = nextRoute;
      const generation = ++cloudGeneration;
      void chrome.runtime.sendMessage({ kind: 'known.capture.cloudAvailable' }).then(value => {
        if (generation === cloudGeneration) bar.devicesPill.hidden = !(value as { available?: boolean }).available;
      }).catch(() => undefined);
      void chrome.runtime.sendMessage({ kind: 'known.collections.list' }).then(value => {
        const response = value as { ok: boolean; collections?: { id: string; title: string }[] };
        if (generation !== cloudGeneration || !response.ok || !response.collections) return;
        const current = route.params.get('collection') ?? ''; collection.replaceChildren(); const all = el('option', t('common_allCollections', 'All collections')); all.value = ''; collection.append(all);
        for (const item of response.collections) { const option = el('option', item.title); option.value = item.id; collection.append(option); }
        if (current && !response.collections.some(item => item.id === current)) { const option = el('option', t('common_collectionUnavailable', 'Collection unavailable')); option.value = current; option.disabled = true; collection.append(option); }
        setPill(collection, current);
      }).catch(() => undefined);
      setPill(collection, route.params.get('collection') ?? '');
      setPill(days, ['7', '30', '90'].includes(route.params.get('days') ?? '') ? route.params.get('days')! : '7');
      setPill(filter, bar.isStatus(route.params.get('status') ?? '') ? route.params.get('status')! : 'all'); setPill(source, route.params.get('source') ?? '');
      if (document.activeElement !== query) query.value = route.params.get('q') ?? '';
      const requestedZone = route.params.get('timezone') ?? zoneValue;
      if (!Array.from(zone.options).some(option => option.value === requestedZone)) {
        try { new Intl.DateTimeFormat('en', { timeZone: requestedZone }); const option = el('option', requestedZone); option.value = requestedZone; zone.append(option); } catch { /* retain system timezone */ }
      }
      setPill(zone, Array.from(zone.options).some(option => option.value === requestedZone) ? requestedZone : zoneValue); setPill(scope, route.params.get('devices') === 'cloud' ? 'cloud' : 'local');
      if (source.value || route.params.get('collection') || scope.value === 'cloud' || zone.value !== zoneValue) bar.setMore(true);
      const taskId = route.params.get('task');
      setMode(Boolean(taskId) && route.pane === 'history');
      if (!taskId) leaveDetail();
      const key = JSON.stringify([days.value, filter.value, source.value, query.value, zone.value, scope.value, route.params.get('collection'), route.params.get('day'), route.view]);
      if (key !== lastQuery || !rows.length && !remote.length) { lastQuery = key; hasSnapshot = false; void load(); }
      else {
        invalidation.invalidate();
        if (taskId) void showDetail(taskId);
        else if (returnFocus) { list.querySelector<HTMLElement>(`#capture-row-${CSS.escape(returnFocus)}`)?.focus(); returnFocus = null; }
      }
    },
    deactivate() { active = false; version++; cloudGeneration++; updates.hidden = true; notice.hidden = true; },
    clear() { clearDevice.hidden = true; hasSnapshot = false; updates.hidden = true; invalidation.reset(); version++; cloudGeneration++; bar.devicesPill.hidden = true; rows = []; remote = []; tasks.clear(); drafts.clear(); selected.clear(); list.replaceChildren(); detail.replaceChildren(); overview.clear(); lastQuery = ''; },
  };
}
