import type { CaptureBatch, CaptureBatchRequest } from './batch.js';
import type { CaptureTask } from './contracts.js';
import { CAPTURE_SAVE_COPY, CAPTURE_SYNC_COPY } from './history.js';
import { faviconTile } from '../bookmark-manager-dom.js';
import { hostOf } from './history-row.js';
import { t, tn } from '../i18n.js';
import { bindPageLanguage } from '../page-language.js';
import { hydrateIcons } from '../icons.js';
import { folderChoices } from '../library-folder-picker.js';

hydrateIcons(document);
void bindPageLanguage();
const list = document.getElementById('tabs-list')!;
const status = document.getElementById('tabs-status')!;
const count = document.getElementById('tabs-count')!;
const target = document.getElementById('tabs-target') as HTMLSelectElement;
const confirm = document.getElementById('tabs-confirm') as HTMLButtonElement;
const retry = document.getElementById('tabs-resume') as HTMLButtonElement;
const grant = document.getElementById('tabs-grant') as HTMLButtonElement;
const tabAlert = document.getElementById('tabs-tab-alert')!;
const bookmarkAlert = document.getElementById('tabs-bookmark-alert')!;
const query = document.getElementById('tabs-search') as HTMLInputElement;
const selection = document.getElementById('tabs-selection') as HTMLSelectElement;
let batch: CaptureBatch | undefined;
const selected = new Set<string>();
const another = new Set<string>();
let timer: ReturnType<typeof setTimeout> | undefined;


async function request(message: CaptureBatchRequest) {
  const response = await chrome.runtime.sendMessage(message) as { ok: boolean; error?: string; batch?: CaptureBatch; tasks?: CaptureTask[] };
  if (!response.ok || !response.batch) throw new Error(response.error ?? 'capture_batch_unavailable');
  return response;
}
function failure(error: unknown) {
  status.textContent = error instanceof Error && error.message === 'permission_required'
    ? t('capture_allowBookmarkAccessSave', 'Allow bookmark access to save these tabs.') : t('capture_somethingWentWrongTabs', 'Something went wrong. Tabs that were already saved stay saved; resume to finish the rest.');
  status.dataset.tone = 'attention';
}
async function loadFolders() {
  const granted = await chrome.permissions.contains({ permissions: ['bookmarks'] });
  bookmarkAlert.hidden = granted;
  if (!granted) return;
  target.replaceChildren();
  for (const folder of folderChoices(await chrome.bookmarks.getTree())) {
    if (folder.disabled) continue;
    const option = document.createElement('option'); option.value = folder.id; option.textContent = folder.path.join(' › '); target.append(option);
  }
  const saved = await chrome.runtime.sendMessage({ kind: 'known.save.status' }) as { defaultFolderId?: string };
  if (saved.defaultFolderId && Array.from(target.options).some(option => option.value === saved.defaultFolderId)) target.value = saved.defaultFolderId;
}
/** The one quiet line under the title: only while saving. The lede already says what to do, and the tab-access ask is its own alert. */
function batchStatus(current: CaptureBatch): string {
  return current.confirmed ? t('capture_savingBackgroundCanClose', 'Saving in the background. You can close this page; your tabs stay open.') : '';
}
function paint(tasks: readonly CaptureTask[] = []) {
  if (!batch) return;
  const taskMap = new Map(tasks.filter(Boolean).map(task => [task.captureId, task]));
  const filter = query.value.trim().toLocaleLowerCase();
  list.replaceChildren();
  for (const item of batch.items) {
    if (filter && !`${item.title} ${item.url ?? ''}`.toLocaleLowerCase().includes(filter)) continue;
    const row = document.createElement('li'); row.className = 'list-row tabs-row'; if (item.reason) row.dataset.state = 'unavailable';
    const label = document.createElement('label'); label.className = 'tabs-pick';
    const checkbox = document.createElement('input'); checkbox.type = 'checkbox';
    checkbox.checked = selected.has(item.itemId); checkbox.disabled = Boolean(item.reason) || batch.confirmed;
    checkbox.addEventListener('change', () => { if (checkbox.checked) selected.add(item.itemId); else selected.delete(item.itemId); updateCount(); });
    const copy = document.createElement('span'); copy.className = 'list-row-main tabs-copy';
    const name = document.createElement('span'); name.className = 'list-row-title tabs-row-title'; name.textContent = item.title || (item.url ? hostOf(item.url) : t('common_untitledTab', 'Untitled tab'));
    const blank = document.createElement('span'); blank.className = 'tabs-row-blank';
    const detail = document.createElement('span'); detail.className = 'list-row-meta tabs-row-detail';
    const task = item.captureId ? taskMap.get(item.captureId) : undefined;
    const path = task?.localLocation?.path.join(' › ') ?? item.existence?.exact.map(place => place.path.join(' › ')).join(' / ');
    detail.textContent = item.error ? t('capture_itemCouldNotStart', 'This item could not start. Check its destination and resume unfinished items.')
      : item.reason === 'unreadable' ? t('capture_urlUnavailableAllowTab', 'URL unavailable. Allow tab access to include this tab.')
      : item.reason === 'unsupported' ? t('capture_browserPageCannotBookmarked', 'This browser page cannot be bookmarked here.')
        : task ? `${task.disposition === 'existing' ? t('common_alreadySaved', 'Already saved') : CAPTURE_SAVE_COPY[task.save] ?? task.save} · ${CAPTURE_SYNC_COPY[task.sync] ?? task.sync}${path ? ` · ${path}` : ''}`
          : `${item.url ? hostOf(item.url) : ''}${item.tabIds.length > 1 ? ` · ${t('capture_duplicateTabsMerged', '$1 duplicate tabs merged', item.tabIds.length)}` : ''}${path ? ` · ${t('capture_alreadySavedAt', 'Already saved: $1', path)}` : ''}`;
    copy.append(name, detail);
    label.append(checkbox, item.url ? faviconTile(item.url) : blank, copy);
    row.append(label);
    const extras = document.createElement('span'); extras.className = 'list-row-tail tabs-extras';
    if (item.existence?.exact.length && !batch.confirmed) {
      const duplicate = document.createElement('label'), input = document.createElement('input'); input.type = 'checkbox'; input.checked = another.has(item.itemId); duplicate.className = 'tabs-another';
      input.addEventListener('change', () => { if (input.checked) { another.add(item.itemId); selected.add(item.itemId); }
        else { another.delete(item.itemId); selected.delete(item.itemId); } checkbox.checked = selected.has(item.itemId); updateCount(); });
      duplicate.append(input, document.createTextNode(` ${t('capture_saveAnotherCopy', 'Save another copy')}`)); extras.append(duplicate);
    }
    if (item.captureId) {
      const link = document.createElement('a'); link.href = `options.html#history?task=${encodeURIComponent(item.captureId)}`; link.textContent = t('common_viewDetails', 'View details'); extras.append(link);
    }
    if (extras.childElementCount) row.append(extras);
    list.append(row);
  }
  tabAlert.hidden = batch.tabsPermission;
  retry.hidden = !batch.confirmed; confirm.hidden = batch.confirmed;
  target.disabled = batch.confirmed;
  status.textContent = batchStatus(batch);
  delete status.dataset.tone;
  updateCount();
}
function updateCount() {
  count.textContent = t('capture_tabsSelected', '$1 of $2 tabs selected', selected.size, batch?.items.filter(item => !item.reason).length ?? 0);
  confirm.textContent = selected.size ? tn('capture_saveTabs', selected.size, 'Save $1 tab', 'Save $1 tabs') : t('capture_confirmSaveSelectedTabs', 'Confirm and save selected tabs');
  confirm.disabled = selected.size === 0 || !target.value;
}
async function refreshPreview() {
  const response = await request({ kind: 'known.capture.batch.preview', selection: selection.value as 'all' | 'selected',
    ...(batch?.windowId == null ? {} : { windowId: batch.windowId }) });
  batch = response.batch!; selected.clear(); another.clear();
  for (const item of batch.items) if (!item.reason && !item.existence?.exact.length) selected.add(item.itemId);
  history.replaceState(null, '', `?batch=${batch.batchId}`); paint();
}
async function poll() {
  if (!batch) return;
  try {
    const response = await request({ kind: 'known.capture.batch.get', batchId: batch.batchId });
    batch = response.batch;
    /* Repainting the list would destroy the focused row's node; only the
       status line updates while focus sits inside the list. */
    if (batch && list.contains(document.activeElement)) {
      status.textContent = batchStatus(batch);
    } else {
      paint(response.tasks);
    }
  }
  catch (error) { failure(error); }
  if (batch?.confirmed) timer = setTimeout(() => void poll(), 1500);
}
grant.addEventListener('click', () => { void chrome.permissions.request({ permissions: ['tabs'] }).then(async granted => {
  if (granted) await refreshPreview(); else status.textContent = t('capture_tabAccessDeclinedCan', 'Tab access was declined. You can still save the readable tabs shown here.');
}).catch(failure); });
document.getElementById('tabs-bookmark-grant')!.addEventListener('click', () => { void chrome.permissions.request({ permissions: ['bookmarks'] }).then(async granted => {
  if (granted) { await loadFolders(); await refreshPreview(); } else status.textContent = t('capture_bookmarkAccessDeclinedPreview', 'Bookmark access was declined. The preview remains available.');
}).catch(failure); });
document.getElementById('tabs-refresh')!.addEventListener('click', () => { void refreshPreview().catch(failure); });
document.getElementById('tabs-all')!.addEventListener('click', () => {
  if (!batch || batch.confirmed) return;
  for (const item of batch.items) if (!item.reason && (!item.existence?.exact.length || another.has(item.itemId))) selected.add(item.itemId);
  paint();
});
document.getElementById('tabs-invert')!.addEventListener('click', () => {
  if (!batch || batch.confirmed) return;
  for (const item of batch.items) if (!item.reason && (!item.existence?.exact.length || another.has(item.itemId))) {
    if (selected.has(item.itemId)) selected.delete(item.itemId); else selected.add(item.itemId);
  }
  paint();
});
query.addEventListener('input', () => paint()); target.addEventListener('change', updateCount);
confirm.addEventListener('click', () => {
  if (!batch) return;
  confirm.disabled = true;
  void request({ kind: 'known.capture.batch.confirm', batchId: batch.batchId, selectedIds: [...selected], saveAnotherIds: [...another],
    targetNativeId: target.value, allowUnverifiedCloud: true, userGesture: true }).then(async () => { await poll(); retry.focus(); }).catch(failure);
});
retry.addEventListener('click', () => {
  if (!batch) return;
  retry.disabled = true;
  void request({ kind: 'known.capture.batch.resume', batchId: batch.batchId }).then(() => poll()).catch(failure).finally(() => { retry.disabled = false; });
});
window.addEventListener('pagehide', () => clearTimeout(timer));
void (async () => {
  await loadFolders();
  const id = new URLSearchParams(location.search).get('batch');
  if (!id) await refreshPreview();
  else {
    const response = await request({ kind: 'known.capture.batch.get', batchId: id }); batch = response.batch!;
    selection.value = batch.selection;
    for (const item of batch.items) if (batch.confirmed ? batch.selectedIds.includes(item.itemId) : !item.reason && !item.existence?.exact.length) selected.add(item.itemId);
    if (batch.targetNativeId) target.value = batch.targetNativeId;
    paint(response.tasks); if (batch.confirmed) await poll();
  }
})().catch(failure);
