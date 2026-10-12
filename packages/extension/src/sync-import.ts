import { FAVICON_SIDECAR_ALARM } from './favicon-sidecar-store.js';
import { supportedBookmarkTree } from './bookmark-folder-policy.js';
import { t, tn, uiLanguage } from './i18n.js';
import { MAX_IMPORT_FILE_BYTES, importErrorMessage, importWarningCopy, nativeImportMessage } from './import-ui.js';
import { el, grouped, selectOf, setBusy } from './library-dom.js';
import type { ImportRequest, ImportResponse, PublicImportPreview, PublicImportStatus } from './types.js';

export interface ImportHost {
  readonly isConnected: () => boolean;
  /** Sends the person to the Collection tab, where a collection is chosen. */
  readonly chooseCollection: () => void;
  readonly showStatus: () => void;
  readonly showFolders: () => void;
}

const POLL_MS = 2_500;
const ETA_MIN_SAMPLE_MS = 4_000;
const MAX_NOTES = 50;

/** Sync › Import: an HTML file or this browser's bookmarks, a folder-mapping preview and a progress card. */
export function bindImport(host: ImportHost) {
  const file = required('import-file') as HTMLInputElement;
  const native = required('import-native') as HTMLButtonElement;
  const alert = required('import-alert');
  const alertCopy = required('import-feedback');
  const preview = required('import-preview');
  const count = required('import-count');
  const notes = required('import-notes') as HTMLDetailsElement;
  const notesSummary = required('import-notes-summary');
  const warnings = required('import-warnings');
  const mappings = required('import-mappings');
  const commit = required('commit-import') as HTMLButtonElement;
  const discard = required('cancel-import') as HTMLButtonElement;
  const heading = required('import-heading');
  const progress = required('import-progress');
  const state = required('import-state');
  const done = required('import-progress-count');
  const meter = required('import-progress-meter');
  const detail = required('import-progress-copy');
  const eta = required('import-eta');
  const pause = required('pause-import') as HTMLButtonElement;
  const resume = required('resume-import') as HTMLButtonElement;
  const retry = required('retry-import') as HTMLButtonElement;
  const attention = required('import-attention-actions');
  let current: PublicImportPreview | undefined;
  let planId: string | undefined;
  let busy = false;
  let poll = 0;
  let samples: { at: number; done: number }[] = [];

  file.addEventListener('change', () => { void previewFile(); });
  native.addEventListener('click', (event) => { void previewNative(event.isTrusted && navigator.userActivation.isActive); });
  commit.addEventListener('click', () => { void commitPreview(); });
  discard.addEventListener('click', () => { current = undefined; preview.hidden = true; say(); });
  pause.addEventListener('click', () => { void command('known.import.pause'); });
  resume.addEventListener('click', () => { void command('known.import.resume'); });
  retry.addEventListener('click', () => { void command('known.import.retry'); });
  required('import-goto-sync').addEventListener('click', host.showStatus);
  required('import-goto-folders').addEventListener('click', host.showFolders);

  async function previewFile(): Promise<void> {
    const picked = file.files?.[0]; if (!picked) return;
    if (picked.size > MAX_IMPORT_FILE_BYTES) { showError('input_too_large'); file.value = ''; return; }
    say(t('options_readingBookmarkExport', 'Reading bookmark export.'), 'info');
    try { await showPreview({ kind: 'known.import.previewFile', base64: encodeBase64(new Uint8Array(await picked.arrayBuffer())) }); }
    finally { file.value = ''; }
  }

  async function previewNative(hasUserGesture: boolean): Promise<void> {
    if (!hasUserGesture) {
      say(t('options_useBrowsersBookmarksStart', "Use This browser's bookmarks to start an import."), 'info');
      return;
    }
    say(t('options_readingBrowsersBookmarks', "Reading this browser's bookmarks…"), 'info');
    // Call permissions.request directly on the click: it resolves true without
    // a prompt when already granted, and awaiting contains() first can spend
    // the transient user activation the prompt needs.
    let granted = false;
    try { granted = await chrome.permissions.request({ permissions: ['bookmarks'] }); }
    catch {
      try { granted = await chrome.permissions.contains({ permissions: ['bookmarks'] }); } catch { granted = false; }
    }
    if (!granted) { showError('permission_required'); return; }
    await showPreview(await nativeImportMessage(async () => supportedBookmarkTree(await chrome.bookmarks.getTree())));
  }

  async function showPreview(message: Extract<ImportRequest, { kind: 'known.import.previewFile' | 'known.import.previewNative' }>): Promise<void> {
    setBusyState(true); const response = await send(message); setBusyState(false);
    if (!response.ok || !('preview' in response)) {
      showError(response.ok ? 'preview_invalid' : response.error);
      if (!response.ok && response.error === 'collection_required') host.chooseCollection();
      return;
    }
    current = response.preview; renderPreview(response.preview);
  }

  function renderPreview(value: PublicImportPreview): void {
    preview.hidden = false; progress.hidden = true; say();
    count.textContent = grouped(tn('sync_importItems', value.creates, '$1 item will be added to your collection.', '$1 items will be added to your collection.'), value.creates);
    warnings.replaceChildren();
    for (const warning of value.warnings.slice(0, MAX_NOTES)) warnings.append(el('li', importWarningCopy(warning.message)));
    if (value.warnings.length > MAX_NOTES) warnings.append(el('li', tn('sync_importMoreNotes', value.warnings.length - MAX_NOTES, '$1 more note.', '$1 more notes.')));
    notes.hidden = value.warnings.length === 0; notes.open = false;
    notesSummary.textContent = tn('sync_importNotes', value.warnings.length, '$1 note about this file', '$1 notes about this file');
    mappings.replaceChildren();
    const targets: (readonly [string, string])[] = [['', t('common_chooseDestination', 'Choose destination')],
      ...value.targets.map((target, index) => [String(index), target.title || t('import_selectedSyncFolder', 'Selected sync folder')] as const),
      ['skip', t('common_skip', 'Skip')]];
    for (const root of value.roots) {
      const row = el('div', undefined, 'set-row import-map-row');
      const label = el('label', root.descendants ? t('sync_importFolderItems', '$1 ($2 items)', root.title, root.descendants + 1) : root.title, 'import-map-label');
      label.htmlFor = `map-${root.sourceNodeId}`;
      const select = selectOf(targets); select.id = `map-${root.sourceNodeId}`; select.className = 'select-quiet';
      select.dataset.sourceNodeId = root.sourceNodeId; select.setAttribute('aria-label', t('options_map', 'Map $1', root.title));
      select.options[0]!.disabled = true;
      select.addEventListener('change', updateCommit);
      row.append(label, select); mappings.append(row);
    }
    commit.disabled = true; mappings.querySelector<HTMLSelectElement>('select')?.focus();
  }

  function updateCommit(): void {
    commit.disabled = busy || !current || Array.from(mappings.querySelectorAll<HTMLSelectElement>('select')).some((select) => select.value === '');
  }

  async function commitPreview(): Promise<void> {
    const reviewed = current; if (!reviewed) return;
    const choices = Array.from(mappings.querySelectorAll<HTMLSelectElement>('select')).map((select) => {
      const sourceNodeId = select.dataset.sourceNodeId!;
      if (select.value === 'skip') return { sourceNodeId, action: 'skip' as const };
      const selected = reviewed.targets[Number(select.value)]!;
      return { sourceNodeId, action: 'import' as const, target: { nativeId: selected.nativeId, colpId: selected.colpId, revision: selected.revision } };
    });
    setBusyState(true); const response = await send({ kind: 'known.import.commit', digest: reviewed.digest, choices });
    setBusyState(false);
    if (!response.ok || !('status' in response)) { showError(response.ok ? 'commit_invalid' : response.error); return; }
    chrome.alarms.create(FAVICON_SIDECAR_ALARM, { when: Date.now() + 1_000 });
    void chrome.runtime.sendMessage({ kind: 'known.favicon.drain' }).catch(() => undefined);
    current = undefined; renderStatus(response.status);
  }

  async function refreshStatus(): Promise<void> {
    const response = await send({ kind: 'known.import.status', ...(planId ? { planId } : {}) });
    if (response.ok && 'status' in response) renderStatus(response.status);
  }

  async function command(kind: 'known.import.pause' | 'known.import.resume' | 'known.import.retry'): Promise<void> {
    if (!planId) return;
    setBusyState(true); const response = await send({ kind, planId }); setBusyState(false);
    if (!response.ok || !('status' in response)) { showError(response.ok ? 'command_invalid' : response.error); return; }
    renderStatus(response.status);
  }

  function renderStatus(value: PublicImportStatus): void {
    if (value.planId !== planId) samples = [];
    planId = value.planId; preview.hidden = true; progress.hidden = false; say();
    const total = value.progress.total, finished = value.progress.terminal + value.progress.skipped;
    state.textContent = value.state === 'active' ? t('sync_importingBookmarks', 'Importing bookmarks') : value.state === 'paused' ? t('common_paused', 'Paused')
      : value.state === 'complete' ? t('sync_importDone', 'Import complete') : t('sync_importNeedsAttention', 'Import needs attention');
    done.textContent = t('sync_importOf', '$1 of $2', number(finished), number(total));
    meter.setAttribute('aria-valuemax', String(Math.max(1, total))); meter.setAttribute('aria-valuenow', String(finished));
    meter.setAttribute('aria-label', state.textContent);
    const bar = meter.firstElementChild as HTMLElement | null;
    if (bar) bar.style.width = `${total > 0 ? Math.min(100, (finished / total) * 100) : 0}%`;
    const notes_: string[] = [];
    if (value.progress.skipped > 0) notes_.push(t('sync_importSkipped', '$1 skipped', number(value.progress.skipped)));
    if (value.progress.recoverable > 0) notes_.push(tn('sync_importNeedAttention', value.progress.recoverable, '$1 item needs attention', '$1 items need attention'));
    detail.textContent = notes_.join(' · ');
    pause.hidden = value.state !== 'active'; resume.hidden = value.state !== 'paused'; retry.hidden = value.state !== 'attention';
    attention.hidden = value.state !== 'attention';
    eta.textContent = value.state === 'active' ? remaining(finished, total) : '';
    clearTimeout(poll);
    if (value.state === 'active') schedule();
  }

  /** An import that is running is re-read while this page is in view. */
  function schedule(): void {
    clearTimeout(poll);
    poll = window.setTimeout(() => { if (document.body.dataset.pane === 'sync' && !document.hidden) void refreshStatus(); else schedule(); }, POLL_MS);
  }

  /** "About 2 minutes left" from the pace seen on this page; nothing until there is a pace to go on. */
  function remaining(finished: number, total: number): string {
    const now = Date.now();
    if (samples.at(-1)?.done !== finished) samples.push({ at: now, done: finished });
    const first = samples[0]!, last = samples.at(-1)!;
    if (last.at - first.at < ETA_MIN_SAMPLE_MS || last.done <= first.done || total <= finished) return '';
    const seconds = (total - finished) / ((last.done - first.done) / ((last.at - first.at) / 1000));
    return seconds < 60 ? t('sync_importUnderMinute', 'Less than a minute left')
      : tn('sync_importMinutesLeft', Math.round(seconds / 60), 'About $1 minute left', 'About $1 minutes left');
  }

  function setBusyState(next: boolean): void {
    busy = next; file.disabled = next || !host.isConnected(); native.disabled = next || !host.isConnected(); updateCommit();
    for (const control of [pause, resume, retry, discard]) control.disabled = next;
    setBusy(progress, next);
  }

  function say(message?: string, tone: 'info' | 'danger' = 'danger'): void {
    alert.hidden = message === undefined; alertCopy.textContent = message ?? '';
    if (tone === 'info') delete alert.dataset.tone; else alert.dataset.tone = 'danger';
  }
  function showError(code: string): void { say(importErrorMessage(code)); }
  async function send(message: ImportRequest): Promise<ImportResponse> {
    try { return await chrome.runtime.sendMessage(message) as ImportResponse; }
    catch { return { ok: false, error: 'extension_unavailable' }; }
  }

  return {
    hasPlan: () => planId !== undefined,
    refreshStatus,
    onConnection(connected: boolean): void {
      file.disabled = !connected; native.disabled = !connected;
      if (connected && !planId) void refreshStatus();
    },
    /** The collection imports go into, named in the heading once one is chosen. */
    setCollection(title: string): void {
      heading.textContent = title ? t('sync_importInto', 'Import into $1', title) : t('options_importToKnowN', 'Import to Know-N');
    },
  };
}

function number(value: number): string { return new Intl.NumberFormat(uiLanguage()).format(value); }

function encodeBase64(bytes: Uint8Array): string {
  let binary = ''; const chunkSize = 32_768;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(bytes.length, offset + chunkSize)));
  }
  return btoa(binary);
}

function required(id: string): HTMLElement {
  const value = document.getElementById(id);
  if (!value) throw new Error('options_markup_invalid');
  return value;
}
