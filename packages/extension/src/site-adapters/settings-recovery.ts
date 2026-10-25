import { sendSiteMessage, siteButton, siteRow } from './settings-client.js';
import { t, tn } from '../i18n.js';
// The Recovery tab: which account owns each saved copy, writes that need recovery, restored backups and the private diagnostic.
const text = (id: string, value: string) => { document.querySelector(`#${id}`)!.textContent = value; };
const status = document.querySelector<HTMLPreElement>('#status')!;
/** A restored root is named by its folder, as the Sync tab's picker names it. */
async function folderName(id: string | null) {
  if (!id) return null;
  try { const [node] = await chrome.bookmarks.get(id); return node?.title || id; } catch { return id; }
}

document.querySelector('#read-bindings')!.addEventListener('click', () => { void (async () => {
  const result = await sendSiteMessage({ kind: 'known.siteAdapters.content.list' }) as { ok?: boolean; connectionId?: string; truncated?: boolean;
    bindings?: { id: string; itemId: string; title: string; state: string; connectionId: string | null; native: boolean; retryable?: boolean }[] };
  const container = document.querySelector('#content-bindings')!, bindings = result.bindings ?? []; container.replaceChildren();
  text('content-summary', !result.ok ? t('sites_associationsUnreadable', 'Couldn’t read saved associations.') : !bindings.length ? t('sites_noAssociations', 'No saved associations yet.')
    : [tn('sites_associationCount', bindings.length, '$1 saved association.', '$1 saved associations.'),
      ...result.truncated ? [t('sites_associationsTruncated', 'Only the first saved associations are shown; remaining records are retained.')] : []].join(' '));
  for (const b of bindings) {
    const other = !!result.connectionId && b.connectionId !== result.connectionId;
    const { row, text: copy, control } = siteRow(b.title, other ? t('sites_savedWithOther', 'Saved with another account.') : b.state === 'active' ? t('sites_savedWithConnected', 'Saved with the connected account.') : '');
    copy.title = b.itemId;
    if (b.state !== 'active') { const badge = document.createElement('span'); badge.className = 'badge'; badge.textContent = b.state; control.append(badge); }
    if (b.retryable) {
      const retry = siteButton(t('sites_retryUnsubmitted', 'Prepare to save again'));
      retry.onclick = () => { retry.disabled = true; void sendSiteMessage({ kind: 'known.siteAdapters.content.retryUnsubmitted', itemId: b.itemId, bindingId: b.id })
        .then((raw: unknown) => { const result = raw as { ok?: boolean };
          text('content-summary', result.ok ? t('sites_retryUnsubmittedDone', 'The unsubmitted save was cleared. Open the save window again.')
            : t('sites_retryUnsubmittedHeld', 'This save may already have been sent. Its original record is kept for recovery.')); }); };
      control.append(retry);
    }
    if (b.native && b.state === 'active' && result.connectionId && b.connectionId !== result.connectionId) {
      const adopt = siteButton(t('sites_adoptCopy', 'Adopt this copy into the connected account'));
      adopt.onclick = () => { void sendSiteMessage({ kind: 'known.siteAdapters.content.adoptAccount', itemId: b.itemId, bindingId: b.id, allowAccountChange: true }).then(r => {
        status.textContent = JSON.stringify(r, null, 2); if ((r as { ok?: boolean }).ok) adopt.disabled = true;
      }); }; control.append(adopt);
    }
    container.append(row);
  }
})(); });

async function repair(kind: 'status' | 'recover' | 'export') {
  const result = await sendSiteMessage({ kind: `known.siteAdapters.repair.${kind}` }) as { ok?: boolean; error?: string; diagnostic?: unknown; attention?: unknown[];
    restored?: { id: string; connections: { ref: string; accountId: string; retainedBlocked: boolean; mounts: { ref: string; rootCandidate: string | null; reviewed: boolean }[] }[] }[] };
  const summary = document.querySelector('#repair-summary')!, container = document.querySelector('#repair-records')!, feedback = document.querySelector<HTMLElement>('#repair-feedback')!;
  feedback.hidden = true;
  if (result.diagnostic) {
    const url = URL.createObjectURL(new Blob([JSON.stringify(result.diagnostic, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = `colp-source-private-diagnostic-${Date.now()}.json`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000); feedback.textContent = t('sites_diagnosticExported', 'Private diagnostic exported. Existing work and database schema were preserved.'); feedback.hidden = false; return;
  }
  summary.textContent = JSON.stringify(result, null, 2); container.replaceChildren();
  const attention = result.attention?.length ?? 0;
  text('repair-hint', !result.ok ? t('sites_repairUnreadable', 'Couldn’t read recovery records. The last response is below.')
    : attention ? tn('sites_recordsNeedRecovery', attention, '$1 record needs recovery or review.', '$1 records need recovery or review.') : t('sites_noRecords', 'No records need recovery.'));
  for (const restored of result.restored ?? []) for (const connection of restored.connections) {
    if (connection.retainedBlocked || connection.mounts.length && connection.mounts.every(m => m.reviewed)) continue;
    const { row, control } = siteRow(t('sites_restoredAccount', 'Restored account $1', connection.accountId),
      t('sites_restoredBlockedHint', 'Unresolved restored copies can remain blocked while unrelated new work continues.'), true);
    const preview = siteButton(t('sites_reviewBlocked', 'Review keeping this restored scope blocked'));
    preview.onclick = () => { void (async () => {
      const request = { restoreId: restored.id, connectionRef: connection.ref };
      const response = await sendSiteMessage({ kind: 'known.siteAdapters.repair.reviewBlocked', ...request }) as { preview?: { digest: string } };
      summary.textContent = JSON.stringify(response, null, 2);
      if (response.preview) { const approve = siteButton(t('sites_keepBlocked', 'Keep these restored items and collections blocked'), 'primary');
        approve.onclick = () => { approve.disabled = true; void sendSiteMessage({ kind: 'known.siteAdapters.repair.retainBlocked', ...request, digest: response.preview!.digest }).then(r => { summary.textContent = JSON.stringify(r, null, 2); }); }; control.append(approve); }
    })(); }; control.append(preview); container.append(row);
  }
  for (const restored of result.restored ?? []) for (const connection of restored.connections) for (const mount of connection.mounts) {
    const rootName = await folderName(mount.rootCandidate);
    const { row, control } = siteRow(t('sites_restoredAccount', 'Restored account $1', connection.accountId), [rootName ? t('sites_rootCandidate', 'Root candidate: $1.', rootName) : t('sites_noRootCandidate', 'No root candidate.'),
      mount.reviewed ? t('sites_reviewedSentence', 'Reviewed.') : t('sites_disabledUntilReviewed', 'Disabled until reviewed.')].join(' '), true);
    if (!mount.reviewed) { const preview = siteButton(t('sites_previewRebinding', 'Preview account and root rebinding'));
      preview.onclick = () => { void (async () => {
        const request = { restoreId: restored.id, connectionRef: connection.ref, mountRef: mount.ref };
        const response = await sendSiteMessage({ kind: 'known.siteAdapters.repair.preview', ...request }) as { preview?: { digest: string; review: string[] }; error?: string };
        summary.textContent = JSON.stringify(response, null, 2);
        if (response.preview && !response.preview.review.length) {
          const approve = siteButton(t('sites_adoptProven', 'Adopt these proven copies (no native writes)'), 'primary');
          approve.onclick = () => { approve.disabled = true; void sendSiteMessage({ kind: 'known.siteAdapters.repair.approve', ...request, digest: response.preview!.digest }).then(r => { summary.textContent = JSON.stringify(r, null, 2); }); };
          control.append(approve);
        }
      })(); }; control.append(preview); }
    else { const done = document.createElement('span'); done.className = 'set-row-value'; done.textContent = t('sites_reviewed', 'Reviewed'); control.append(done); }
    container.append(row);
  }
}
for (const kind of ['status', 'recover', 'export'] as const) document.querySelector(`#repair-${kind}`)!.addEventListener('click', () => {
  void repair(kind).catch(e => { document.querySelector('#repair-summary')!.textContent = String(e); });
});
