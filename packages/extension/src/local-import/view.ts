import { exclusionIds } from '../bookmark-subscriptions/guards.js';
import { importErrorMessage, importWarningCopy, MAX_IMPORT_FILE_BYTES } from '../import-ui.js';
import { createDialog, dialogButton } from '../dialog.js';
import { createIcon } from '../icons.js';
import { formatMoment, t, tn } from '../i18n.js';
import { el, grouped, inlineAlert } from '../library-dom.js';
import { createFolderPicker, folderChoices, type FolderPicker } from '../library-folder-picker.js';
import type { LocalImportPreview, LocalImportRequest, LocalImportResponse, LocalImportStatus } from './contracts.js';
import { MAX_BACKUP_BYTES } from '../local-backup/codec.js';
import { backupErrorCopy } from '../local-backup/view.js';

import { OPEN_LIBRARY_DIALOG } from '../bookmarks-navigation.js';
import { openMetadataReassociation } from '../metadata-reassociation-ui.js';

function fail(code: string): string { return code.startsWith('backup_') ? backupErrorCopy(code) : importErrorMessage(code); }

/** One sentence for where an import stands; the same words in the dialog and in the page's reminder. */
export function importStatusCopy(current: LocalImportStatus): string {
  if (current.state === 'completed') {
    return current.source === 'backup' ? t('backup_completed', 'Restored $1 items and $2 history records to this browser.', current.total, current.historyCount ?? 0)
      : t('localImport_completed', 'Imported $1 items to this browser.', current.total);
  }
  if (current.state === 'cancelled') return t('localImport_stopped', 'Import stopped. Created bookmarks are kept.');
  if (current.state === 'attention') {
    return current.reason === 'native_result_unknown' ? t('localImport_checkLast', 'Check the last created item before continuing.')
      : current.reason?.startsWith('backup_') ? backupErrorCopy(current.reason) : importErrorMessage(current.reason ?? '');
  }
  return t('localImport_progress', 'Importing to this browser: $1 of $2 items.', current.next, current.total);
}

async function request(message: LocalImportRequest): Promise<Extract<LocalImportResponse, { ok: true }>> {
  const response = await chrome.runtime.sendMessage(message) as LocalImportResponse;
  if (!response?.ok) throw new Error(response?.error ?? 'extension_unavailable');
  return response;
}

async function readFolders(): Promise<{ allowed: boolean; choices: ReturnType<typeof folderChoices> }> {
  if (!await chrome.permissions.contains({ permissions: ['bookmarks'] })) return { allowed: false, choices: [] };
  const excluded = await exclusionIds().catch(() => new Set<string>());
  return { allowed: true, choices: folderChoices(await chrome.bookmarks.getTree(), { exclude: excluded }) };
}

/**
 * Import bookmarks (HTML) and restore a Know-N backup (JSON) in one dialog:
 * drop or choose a file, pick where the new folder goes, import. An import that
 * stopped part-way stays visible as a reminder at the top of Bookmarks and
 * reopens in this dialog with its Resume and Stop actions.
 */
export function bindLocalImportView(reminder: HTMLElement) {
  let disposed = false, reminderTimer: ReturnType<typeof setTimeout> | undefined, openDialog: { focus(): void; refresh(): Promise<void> } | undefined;

  async function refreshReminder(): Promise<void> {
    clearTimeout(reminderTimer);
    try {
      const current = (await request({ kind: 'known.localImport.status' })).status ?? null;
      if (disposed) return;
      const active = current !== null && !['completed', 'cancelled'].includes(current.state);
      reminder.hidden = !active;
      if (!active || !current) return;
      const review = el('button', t('localImport_review', 'Review'), 'btn btn-ghost btn-sm'); review.type = 'button';
      review.addEventListener('click', () => open());
      reminder.replaceChildren(createIcon(current.state === 'attention' ? 'alert' : 'info', 16), el('p', importStatusCopy(current)), review);
      reminder.dataset.tone = current.state === 'attention' ? 'warning' : '';
      if (current.state === 'running') reminderTimer = setTimeout(() => void refreshReminder(), 2_000);
    } catch { reminder.hidden = true; }
  }

  function open(): void {
    if (openDialog) { openDialog.focus(); return; }
    const { dialog, body, actions } = createDialog(t('common_importBookmarks', 'Import bookmarks'), 'mgr-transfer');
    dialog.id = 'local-import-dialog';
    let preview: LocalImportPreview | undefined, current: LocalImportStatus | null = null, commandId: string | undefined, fileName = '';
    let busy = false, closed = false, timer: ReturnType<typeof setTimeout> | undefined, version = 0, picker: FolderPicker | undefined, backupBase64: string | undefined;

    // Choose: the drop zone becomes a "file chosen" row once a file has been read.
    const file = el('input'); file.type = 'file'; file.id = 'local-import-file'; file.hidden = true; file.accept = '.html,.json,text/html,application/json';
    const drop = el('div', undefined, 'dropzone'); drop.id = 'local-import-drop';
    const mark = el('span', undefined, 'empty-icon'); mark.append(createIcon('upload', 18));
    const choose = el('button', t('localImport_chooseFile', 'Choose file…'), 'btn btn-secondary btn-sm'); choose.type = 'button'; choose.style.marginTop = 'var(--hair-55)';
    drop.append(mark, el('strong', t('localImport_dropFile', 'Drop a bookmarks file here')),
      el('span', t('localImport_dropHint', 'HTML from any browser, or a Know-N backup (.json)')), choose);
    const chosen = el('div', undefined, 'file-chosen'); chosen.hidden = true;
    const chosenName = el('span', undefined, 'grow'), chosenCount = el('span', undefined, 'file-chosen-count');
    const change = el('button', t('localImport_change', 'Change'), 'btn btn-ghost btn-sm'); change.type = 'button';
    chosen.append(createIcon('file', 16), chosenName, chosenCount, change);

    // Destination: a pill for the parent folder, a name for the folder the import creates.
    const destination = el('div', undefined, 'form-field'); destination.append(el('span', t('localImport_putIn', 'Put them in'), 'form-label'));
    const permission = inlineAlert('warning', t('localImport_needsAccess', 'Allow bookmark access to choose where the import goes.'));
    permission.hidden = true;
    const grant = el('button', t('common_allowBookmarkAccess', 'Allow bookmark access'), 'btn btn-ghost btn-sm'); grant.type = 'button'; grant.id = 'local-import-grant';
    permission.append(grant);
    const nameField = el('div', undefined, 'form-field'), title = el('input', undefined, 'field-quiet');
    title.id = 'local-import-title'; title.maxLength = 4096; title.value = t('localImport_defaultTitle', 'Imported bookmarks'); title.autocomplete = 'off';
    const titleLabel = el('label', t('localImport_folderName', 'New folder name'), 'form-label'); titleLabel.htmlFor = title.id;
    nameField.append(titleLabel, title);
    const restoreLabel = el('label', undefined, 'mgr-check'); restoreLabel.hidden = true;
    const restoreSettings = el('input'); restoreSettings.type = 'checkbox'; restoreSettings.id = 'local-import-restore-settings';
    restoreLabel.append(restoreSettings, el('span', t('backup_restoreSettings', 'Also restore browser preferences and AI configuration. Saving starts in manual mode; reconnect AI separately.')));
    const hint = el('p', undefined, 'mgr-hint');
    const warnings = el('ul', undefined, 'mgr-warnings');
    const form = el('div', undefined, 'mgr-transfer-form');
    form.append(destination, permission, nameField, restoreLabel, warnings, hint);

    // Progress and results.
    const progress = el('div', undefined, 'mgr-progress'); progress.hidden = true;
    const meter = el('div', undefined, 'meter'), fill = el('span'); meter.append(fill);
    progress.append(meter);
    const status = el('p', undefined, 'mgr-status'); status.id = 'local-import-status'; status.setAttribute('role', 'status');
    const repair = el('div', undefined, 'mgr-repair');
    body.append(file, drop, chosen, form, progress, status, repair);

    const cancel = dialogButton(t('common_cancel', 'Cancel')); cancel.id = 'local-import-close';
    const stop = dialogButton(t('localImport_stop', 'Stop import and keep created bookmarks'), 'secondary'); stop.id = 'local-import-cancel'; stop.hidden = true;
    const resume = dialogButton(t('tabs_resumeUnfinishedItems', 'Resume unfinished items'), 'primary'); resume.id = 'local-import-resume'; resume.hidden = true;
    const reload = dialogButton(t('backup_reloadSettings', 'Reload to use restored settings'), 'secondary'); reload.id = 'local-import-reload'; reload.hidden = true;
    const commit = dialogButton(t('common_import', 'Import'), 'primary'); commit.id = 'local-import-commit'; commit.disabled = true;
    const existing = dialogButton(t('backup_existingMetadata', 'Restore metadata to existing bookmarks'), 'secondary'); existing.id = 'local-import-existing-metadata'; existing.hidden = true;
    actions.append(cancel, stop, reload, resume, existing, commit);

    const active = () => current !== null && !['completed', 'cancelled'].includes(current.state);
    function controls(): void {
      const running = active();
      drop.hidden = running || Boolean(preview); chosen.hidden = running || !preview; form.hidden = running;
      progress.hidden = !running;
      const kind = preview?.format === 'backup';
      existing.hidden = !kind || running; existing.disabled = busy || !backupBase64;
      restoreLabel.hidden = !kind || running;
      hint.textContent = kind ? t('backup_importHint', 'Existing bookmarks are kept. History is restored for viewing and stays on this browser.')
        : t('localImport_hint', 'Existing bookmarks are kept. Tags and notes in the file are imported too.');
      commit.hidden = running || current?.state === 'completed' && !preview;
      commit.disabled = busy || running || !preview || !picker?.value() || !title.value.trim();
      const items = preview ? preview.creates - 1 : 0;
      commit.textContent = !preview ? t('common_import', 'Import') : grouped(kind ? tn('backup_restoreCount', items, 'Restore $1 item', 'Restore $1 items')
        : tn('localImport_importCount', items, 'Import $1 item', 'Import $1 items'), items);
      resume.hidden = current?.state !== 'attention' || current.reason === 'native_result_unknown';
      stop.hidden = !running;
      reload.hidden = current?.state !== 'completed' || !current.restoreSettings;
      cancel.textContent = current?.state === 'completed' && !preview ? t('common_done', 'Done') : running ? t('common_close', 'Close') : t('common_cancel', 'Cancel');
      file.disabled = busy || running; title.disabled = busy || running; restoreSettings.disabled = busy || running;
      if (picker) picker.pill.disabled = busy || running;
      if (current && running) fill.style.width = `${Math.round(100 * (current.total ? current.next / current.total : 0))}%`;
    }
    async function loadFolders(): Promise<void> {
      const { allowed, choices } = await readFolders().catch(() => ({ allowed: false, choices: [] }));
      if (closed) return;
      permission.hidden = allowed; grant.hidden = allowed;
      if (!allowed) { picker?.element.remove(); picker = undefined; controls(); return; }
      if (!picker) {
        picker = createFolderPicker({ choices, label: t('localImport_putIn', 'Put them in'), onChange: () => controls() });
        picker.pill.id = 'local-import-target';
        destination.append(picker.element);
      } else picker.setChoices(choices);
      picker.pill.dataset.value = picker.value();
      controls();
    }
    async function paintRepair(): Promise<void> {
      repair.replaceChildren();
      const pending = current?.pending, expected = current?.commandId;
      if (!pending || !expected) return;
      repair.append(el('p', t('localImport_unknown', 'The last created item has no confirmed result. Select the item you verified in the destination folder to continue, or stop this import.')));
      const select = el('select', undefined, 'select-quiet'); select.id = 'local-import-existing';
      select.setAttribute('aria-label', t('localImport_existing', 'Verified created item'));
      const nodes = await chrome.bookmarks.getChildren(pending.parentNativeId).catch(() => []);
      if (closed || current?.commandId !== expected || current.pending !== pending) return;
      for (const node of nodes) if (node.title === pending.title && node.url === pending.url) {
        const option = el('option', `${node.title} · ${node.dateAdded ? formatMoment(node.dateAdded) : t('common_unknownTime', 'unknown time')}`);
        option.value = node.id; select.append(option);
      }
      const resolve = el('button', t('localImport_confirmItem', 'Confirm this item and continue'), 'btn btn-secondary btn-sm'); resolve.type = 'button'; resolve.disabled = select.options.length === 0;
      resolve.addEventListener('click', () => { void mutate({ kind: 'known.localImport.resolve', commandId: expected, nativeId: select.value, userGesture: true }); });
      repair.append(select, resolve);
    }
    async function refresh(): Promise<void> {
      const at = ++version; clearTimeout(timer);
      try {
        const response = await request({ kind: 'known.localImport.status' });
        if (closed || at !== version) return;
        current = response.status ?? null;
        if (current?.reason === 'permission_required') await loadFolders();
        controls();
        // A finished import is news only until the next file is chosen.
        if (current) status.textContent = preview ? '' : importStatusCopy(current);
        await paintRepair();
        if (!closed && current?.state === 'running') timer = setTimeout(() => void refresh(), 750);
      } catch (error) { status.textContent = fail(error instanceof Error ? error.message : 'extension_unavailable'); }
      void refreshReminder();
    }
    async function mutate(message: LocalImportRequest): Promise<void> {
      if (busy) return;
      busy = true; controls();
      try { await request(message); preview = undefined; await refresh(); } catch (error) { status.textContent = fail(error instanceof Error ? error.message : 'extension_unavailable'); }
      finally { busy = false; controls(); }
    }
    async function read(selected: File): Promise<void> {
      busy = true; preview = undefined; backupBase64 = undefined; commandId = undefined; status.textContent = ''; controls();
      try {
        const backup = selected.name.toLowerCase().endsWith('.json');
        if (selected.size > (backup ? MAX_BACKUP_BYTES : MAX_IMPORT_FILE_BYTES)) throw new Error('input_too_large');
        const bytes = new Uint8Array(await selected.arrayBuffer()); let binary = '';
        for (let offset = 0; offset < bytes.length; offset += 32768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
        const base64 = btoa(binary);
        preview = (await request({ kind: 'known.localImport.preview', base64, ...(backup ? { format: 'backup' as const } : {}) })).preview;
        if (backup) backupBase64 = base64;
        fileName = selected.name;
        chosenName.textContent = fileName;
        chosenCount.textContent = preview ? grouped(tn('common_items', preview.creates - 1, '$1 item', '$1 items'), preview.creates - 1) : '';
        warnings.replaceChildren(...(preview?.warnings ?? []).map((warning) => el('li', importWarningCopy(warning))));
        warnings.hidden = warnings.childElementCount === 0;
        if (preview?.format === 'backup') status.textContent = t('backup_historyPreview', '$1 history records will be restored for viewing. Old operations and credentials are excluded.', preview.historyCount ?? 0);
      } catch (error) { status.textContent = fail(error instanceof Error ? error.message : 'extension_unavailable'); }
      finally { busy = false; controls(); }
    }

    choose.addEventListener('click', () => file.click());
    existing.addEventListener('click', () => { if (backupBase64) { const bytes = backupBase64; dialog.close(); void openMetadataReassociation(bytes); } });
    change.addEventListener('click', () => { preview = undefined; status.textContent = ''; controls(); file.click(); });
    file.addEventListener('change', () => { const selected = file.files?.[0]; if (selected) void read(selected); file.value = ''; });
    for (const type of ['dragenter', 'dragover']) drop.addEventListener(type, (event) => { event.preventDefault(); drop.dataset.over = ''; });
    drop.addEventListener('dragleave', () => { delete drop.dataset.over; });
    drop.addEventListener('drop', (event) => {
      event.preventDefault(); delete drop.dataset.over;
      const dropped = event.dataTransfer?.files[0]; if (dropped) void read(dropped);
    });
    grant.addEventListener('click', () => { void chrome.permissions.request({ permissions: ['bookmarks'] }).then(async (allowed) => {
      if (allowed && typeof chrome.bookmarks?.getTree !== 'function') { location.reload(); return; }
      await loadFolders();
    }).catch(() => undefined); });
    commit.addEventListener('click', () => {
      if (!preview || !picker) return;
      commandId ??= crypto.randomUUID();
      void mutate({ kind: 'known.localImport.commit', commandId, digest: preview.digest, targetNativeId: picker.value(), folderTitle: title.value.trim(), userGesture: true,
        ...(preview.format === 'backup' ? { restoreSettings: restoreSettings.checked } : {}) });
    });
    resume.addEventListener('click', () => { if (current) void mutate({ kind: 'known.localImport.resume', commandId: current.commandId, userGesture: true }); });
    stop.addEventListener('click', () => { if (current) void mutate({ kind: 'known.localImport.cancel', commandId: current.commandId, userGesture: true }); });
    reload.addEventListener('click', () => location.reload());
    cancel.addEventListener('click', () => dialog.close());
    title.addEventListener('input', controls);
    dialog.addEventListener('close', () => { closed = true; clearTimeout(timer); dialog.remove(); openDialog = undefined; void refreshReminder(); });
    document.body.append(dialog); dialog.showModal();
    openDialog = { focus: () => (choose.isConnected && !drop.hidden ? choose : cancel).focus(), refresh };
    controls(); choose.focus();
    void loadFolders().then(refresh).catch(() => undefined);
  }

  document.getElementById('manager-import')?.addEventListener('click', open);
  document.addEventListener(OPEN_LIBRARY_DIALOG, (event) => { if ((event as CustomEvent<string>).detail === 'import') open(); });
  window.addEventListener('pagehide', () => { disposed = true; clearTimeout(reminderTimer); }, { once: true });
  void refreshReminder();
  return { refresh: refreshReminder, open, dispose() { disposed = true; clearTimeout(reminderTimer); } };
}
