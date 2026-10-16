import { confirmMetadataTransfer } from './metadata-transfer.js';
import { METADATA_POLICY_PREFIX } from './metadata-sync-policy.js';
import type { MetadataPolicyStatus } from './metadata-policy-status.js';
import { button, el } from './library-dom.js';
import { showToast } from './toast.js';
import { t } from './i18n.js';

/** Metadata keeps its explicit consent in the library connection settings. */
export function bindLibraryMetadata(host: HTMLElement) {
  const row = el('div', undefined, 'set-row'), text = el('div', undefined, 'set-row-text');
  const title = el('p', t('metadata_libraryHeading', 'Tags, notes and folder descriptions'), 'set-row-title');
  const hint = el('p', undefined, 'set-row-hint');
  const control = el('div', undefined, 'set-row-control');
  const change = button(t('metadata_transferTitle', 'Connect browser metadata'), 'btn btn-ghost btn-sm');
  change.id = 'library-metadata-configure';
  text.append(title, hint); control.append(change); row.append(text, control); host.append(row);
  let turn = 0;
  async function refresh() {
    const current = ++turn;
    const status = await chrome.runtime.sendMessage({ kind: 'known.metadataSync.status' }).catch(() => undefined) as MetadataPolicyStatus | undefined;
    if (current !== turn) return;
    row.hidden = !status?.ok;
    hint.textContent = status?.mode === 'sync'
      ? t('metadata_librarySynced', 'Browser metadata syncs with your bookmark library.')
      : t('metadata_libraryLocal', 'Browser metadata stays on this browser until you choose to connect it.');
  }
  change.addEventListener('click', () => { void (async () => {
    const enabled = await confirmMetadataTransfer();
    if (enabled === undefined) return;
    change.disabled = true;
    try {
      const response = await chrome.runtime.sendMessage({ kind: 'known.metadataSync.configure', enabled, userGesture: true }) as { ok?: boolean };
      if (!response?.ok) throw new Error('metadata_consent_failed');
      showToast(enabled ? t('metadata_librarySynced', 'Browser metadata syncs with your bookmark library.')
        : t('metadata_libraryKeptLocal', 'Browser metadata stays on this browser.'), 'ok');
    } catch { showToast(t('metadata_libraryChangeFailed', 'Metadata settings could not be changed. Please try again.'), 'error'); }
    finally { change.disabled = false; await refresh(); }
  })(); });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && Object.keys(changes).some(key => key.startsWith(METADATA_POLICY_PREFIX))) void refresh();
  });
  row.hidden = true;
  return { refresh };
}
