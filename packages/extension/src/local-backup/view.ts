import { t } from '../i18n.js';
import { createDialog, dialogButton } from '../dialog.js';
import { el } from '../library-dom.js';
import { showToast } from '../toast.js';
import { OPEN_LIBRARY_DIALOG } from '../bookmarks-navigation.js';

export function backupErrorCopy(code: string): string {
  if (code === 'permission_required') return t('backup_permissionRequired', 'Allow bookmark access in General settings before exporting or restoring.');
  if (code === 'input_too_large' || code === 'node_limit') return t('backup_tooLarge', 'This backup exceeds the supported size (32 MB or 100,000 records).');
  if (code === 'backup_version_unsupported') return t('backup_versionUnsupported', 'This backup format is not supported by this version of Know-N.');
  if (code === 'backup_unsupported_url') return t('backup_unsupportedUrl', 'A bookmark URL is unsupported. HTML export can preserve it; JSON backups cannot restore executable or invalid URLs.');
  if (code === 'backup_invalid') return t('backup_invalid', 'This is not a valid Know-N browser backup. No data has been imported.');
  return t('backup_failed', 'The backup operation could not finish. Your existing bookmarks are kept. Try again.');
}

async function download(format: 'html' | 'json'): Promise<{ skippedBookmarks: number; skippedHistory: number }> {
  const result = await chrome.runtime.sendMessage({ kind: 'known.localBackup.export', format }) as {
    ok: boolean; error?: string; content?: string; filename?: string; mime?: string; skippedBookmarks?: number; skippedHistory?: number;
  };
  if (!result?.ok || typeof result.content !== 'string') throw new Error(result?.error ?? 'backup_failed');
  const objectUrl = URL.createObjectURL(new Blob([result.content], { type: result.mime }));
  const link = document.createElement('a'); link.href = objectUrl; link.download = result.filename ?? 'known-backup.json';
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 30_000);
  return { skippedBookmarks: result.skippedBookmarks ?? 0, skippedHistory: result.skippedHistory ?? 0 };
}

function formatChoice(value: 'html' | 'json', title: string, hint: string, checked: boolean): HTMLLabelElement {
  const choice = el('label', undefined, 'choice');
  const input = el('input'); input.type = 'radio'; input.name = 'export-format'; input.value = value; input.checked = checked;
  choice.append(input, el('span', title, 'choice-title'), el('span', hint, 'choice-hint'));
  return choice;
}

/** Export bookmarks: an HTML file that works anywhere, or a Know-N backup that also keeps history and settings. */
export function bindBackupView(host: HTMLElement): void {
  host.hidden = true;
  let open = false;
  function openDialog(format: 'html' | 'json' = 'html'): void {
    if (open) return;
    open = true;
    const { dialog, body, actions } = createDialog(t('backup_exportTitle', 'Export bookmarks'), 'mgr-transfer');
    dialog.id = 'local-backup-dialog';
    const choices = el('div', undefined, 'choice-pair choice-pair--single');
    choices.append(
      formatChoice('html', t('backup_formatHtml', 'HTML file'), t('backup_htmlHint2', 'Works in any browser. Includes folders, descriptions, tags and notes.'), format === 'html'),
      formatChoice('json', t('backup_formatJson', 'Know-N backup'), t('backup_jsonHint2', 'Also keeps history and settings. API keys are excluded. AI connections with URL queries or fragments, or invalid settings, are skipped; set them up again after restoring.'), format === 'json'),
    );
    const feedback = el('p', undefined, 'mgr-status'); feedback.setAttribute('role', 'status');
    body.append(choices, feedback);
    const cancel = dialogButton(t('common_cancel', 'Cancel'));
    const exportButton = dialogButton(t('common_export', 'Export'), 'primary'); exportButton.id = 'local-backup-export';
    cancel.addEventListener('click', () => dialog.close());
    exportButton.addEventListener('click', () => { void (async () => {
      const format = choices.querySelector<HTMLInputElement>('input:checked')?.value === 'json' ? 'json' : 'html';
      exportButton.disabled = true; feedback.textContent = t('backup_preparing', 'Preparing your download…');
      try {
        const skipped = await download(format);
        if (skipped.skippedBookmarks || skipped.skippedHistory) {
          feedback.textContent = t('backup_downloadSkippedUrls', 'Download started. Skipped $1 bookmarks and $2 history entries with unsupported URLs. Export HTML as well to keep the skipped bookmarks.', String(skipped.skippedBookmarks), String(skipped.skippedHistory));
          exportButton.disabled = false;
          cancel.textContent = t('common_close', 'Close');
          return;
        }
        dialog.close();
        showToast(t('backup_downloadReady', 'Download started. Keep this file to restore your data later.'), 'ok');
      } catch (error) {
        feedback.textContent = backupErrorCopy(error instanceof Error ? error.message : 'backup_failed');
        exportButton.disabled = false;
      }
    })(); });
    actions.append(cancel, exportButton);
    dialog.addEventListener('close', () => { dialog.remove(); open = false; });
    document.body.append(dialog); dialog.showModal();
    choices.querySelector<HTMLInputElement>('input:checked')?.focus();
  }
  document.getElementById('manager-export')?.addEventListener('click', () => { openDialog(); });
  // General › Your data offers the backup that also keeps history and settings.
  document.getElementById('general-export')?.addEventListener('click', () => { openDialog('json'); });
  document.addEventListener(OPEN_LIBRARY_DIALOG, (event) => { if ((event as CustomEvent<string>).detail === 'export') openDialog(); });
}
