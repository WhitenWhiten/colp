import { t } from '../i18n.js';
import type { ReconcileDifference, ReconcilePreview } from './reconcile-model.js';
import type { ReconcileDecision } from './reconcile-model.js';
import type { ReconcileRun } from './reconcile-run.js';
import { createFolderPicker, folderChoices, type FolderPicker } from '../library-folder-picker.js';
const labels = () => ({ present: t('sites_diffPresent', 'Already mapped'), add: t('sites_diffAdd', 'New favorite'), candidate: t('sites_diffCandidate', 'Existing bookmark can be linked'),
  localDeleted: t('sites_diffDeleted', 'Deleted locally; kept deleted'), moved: t('sites_diffMoved', 'Moved or changed locally'), folderMoved: t('sites_diffFolderMoved', 'Collection folder moved; writes paused'), sourceRemoved: t('sites_diffRemoved', 'No longer in the source collection'),
  unverified: t('sites_diffUnverified', 'Source membership could not be verified'), title: t('sites_diffTitle', 'Source title changed'), titleOverride: t('sites_diffTitleOverride', 'Your custom title is preserved'), personal: t('sites_diffPersonal', 'Unassociated personal item'),
  protected: t('sites_diffProtected', 'Used by another mapping or semantic copy') });
let shown = 100, signature = '';
let latest: ReconcilePreview | undefined, picker: FolderPicker | undefined, sending: ((message: unknown) => Promise<unknown>) | undefined;
let changed: (() => void) | undefined;
const selections = new Map<string, ReconcileDecision>();
export function reconcileReason(code: string) {
  if (code === 'sourceSyncPending') return t('sites_reconcileWaiting', 'Waiting for bookmark sync; the original operation is kept.');
  if (['source_reconcile_conflict', 'source_association_changed', 'sourceFactsChanged'].includes(code)) return t('sites_reconcileChanged', 'A newer change was found. Recheck this item before changing it.');
  if (code === 'source_copy_protected') return t('sites_reconcileProtected', 'This bookmark is used elsewhere and has been kept in place.');
  if (['sourceAuthorizationChanged', 'capture_scope_changed', 'sourceSyncOwnerChanged'].includes(code)) return t('sites_reconcileAccountChanged', 'The account or settings changed. Recheck before continuing.');
  if (code === 'sourceNativeResultUnknown') return t('sites_reconcileUnknown', 'The save result is not confirmed. Its original record is kept; no replacement is created.');
  if (['reconcileDestinationMapped', 'sourceDestinationChanged'].includes(code)) return t('sites_reconcileOutside', 'Choose a folder in this library outside every website mapping.');
  if (code === 'reconcileHistoryNeedsFolder') return t('sites_reconcileHistoryEmpty', 'Choose an empty dedicated history folder outside the website mappings.');
  return t('sites_reconcileFailed', 'This item needs review. Its original record and details are kept in Recovery.');
}
export function reconcileSelections(): ReconcileDecision[] { return [...selections.values()].map(d => ['move', 'archive'].includes(d.choice) ? { ...d, destinationId: picker?.value() } : d); }
export function installReconcileControls(send: NonNullable<typeof sending>, onChange?: () => void) { sending = send; changed = onChange; }
const choices = () => ({ keep: t('sites_reconcileKeep', 'Keep as is'), adopt: t('sites_reconcileAdopt', 'Link the existing bookmark'),
  restore: t('sites_reconcileRestore', 'Restore this source copy'), return: t('sites_reconcileReturn', 'Return to mapped folder'), archive: t('sites_reconcileArchive', 'Move to history folder'),
  move: t('sites_reconcileMove', 'Move to chosen folder'), updateTitle: t('sites_reconcileUpdateTitle', 'Use source title'), useLocation: t('sites_reconcileUseLocation', 'Continue using this location') });
export function paintReconciliation(preview: ReconcilePreview | null | undefined, run?: ReconcileRun | null, phase?: string) {
  const section = document.getElementById('reconcile-preview'); if (!section) return;
  section.hidden = !preview; if (!preview) return;
  if (signature !== preview.digest) { signature = preview.digest; shown = 100; selections.clear(); }
  latest = preview;
  if (!picker && chrome.bookmarks) void chrome.bookmarks.getTree().then(tree => {
    if (picker) return;
    picker = createFolderPicker({ choices: folderChoices(tree), label: t('sites_reconcileDestination', 'History or personal-item destination'), startEmpty: true });
    picker.pill.id = 'reconcile-target'; document.getElementById('reconcile-target-slot')!.append(picker.element);
  }).catch(() => undefined);
  const counts = new Map<string, number>(); for (const row of preview.differences) counts.set(row.kind, (counts.get(row.kind) ?? 0) + 1);
  const names = labels();
  document.getElementById('reconcile-summary')!.textContent = [...counts].map(([kind, count]) => `${names[kind as ReconcileDifference['kind']]}: ${count}`).join(' · ');
  const rows = preview.differences.filter(d => d.kind !== 'present');
  document.getElementById('reconcile-list')!.replaceChildren(...rows.slice(0, shown).map(row => {
    const element = document.createElement('div'); element.className = 'set-row';
    const copy = document.createElement('div'); copy.className = 'set-row-text';
    const title = document.createElement('p'); title.className = 'set-row-title'; title.textContent = row.title;
    const hint = document.createElement('p'); hint.className = 'set-row-hint'; hint.textContent = row.reason === 'sourceIdentityChanged'
      ? t('sites_reconcileUrlChanged', 'Its URL was changed locally. The bookmark is kept for review.') : names[row.kind]; copy.append(title, hint); element.append(copy);
    if (row.choices.length > 1 && !run) {
      const select = document.createElement('select'); select.className = 'select-quiet'; select.dataset.differenceId = row.id; select.setAttribute('aria-label', row.title);
      for (const choice of row.choices) { const option = document.createElement('option'); option.value = choice; option.textContent = choices()[choice]; select.append(option); }
      select.value = selections.get(row.id)?.choice ?? 'keep';
      const candidates = document.createElement('select'); candidates.className = 'select-quiet'; candidates.setAttribute('aria-label', t('sites_reconcileCandidate', 'Existing bookmark'));
      for (const candidate of row.candidates ?? []) { const option = document.createElement('option'); option.value = candidate.native.nativeId; option.textContent = `${candidate.title} · ${candidate.url}`; candidates.append(option); }
      const update = () => { const choice = select.value as ReconcileDecision['choice']; selections.set(row.id, { id: row.id, choice,
        ...(choice === 'adopt' ? { nativeId: candidates.value } : {}) }); candidates.hidden = choice !== 'adopt'; changed?.(); };
      candidates.value = selections.get(row.id)?.nativeId ?? row.candidates?.[0]?.native.nativeId ?? ''; candidates.hidden = select.value !== 'adopt';
      select.onchange = update; candidates.onchange = update; element.append(select); if (row.candidates?.length) element.append(candidates);
    }
    const operation = run?.operations.find(op => op.difference.id === row.id);
    if (operation) {
      hint.textContent += operation.reason ? ` · ${reconcileReason(operation.reason)}` : operation.state === 'undone' ? ` · ${t('sites_reconcileUndone', 'Undone')}` : '';
      if (operation.state === 'completed') { const undo = document.createElement('button'); undo.type = 'button'; undo.className = 'btn btn-ghost btn-sm'; undo.textContent = t('common_undo', 'Undo');
        undo.onclick = () => { undo.disabled = true; void sending?.({ kind: 'known.siteAdapters.reconcile.undo', id: run!.id, operationId: operation.id }); }; element.append(undo); }
    }
    return element;
  }));
  const more = document.getElementById('reconcile-more')! as HTMLButtonElement; more.hidden = shown >= rows.length;
  more.onclick = () => { shown += 100; paintReconciliation(preview, run, phase); };
  const apply = document.getElementById('reconcile-apply')! as HTMLButtonElement; apply.hidden = !!run || !['completed', 'attention'].includes(phase ?? '');
  apply.disabled = false;
  apply.onclick = () => { apply.disabled = true; void sending?.({ kind: 'known.siteAdapters.reconcile.apply', importId: latest!.importId, digest: latest!.digest, decisions: reconcileSelections() }); };
  const retry = document.getElementById('reconcile-retry')! as HTMLButtonElement; retry.hidden = !run?.operations.some(op => op.state === 'attention');
  retry.disabled = false;
  retry.onclick = () => { retry.disabled = true; void sending?.({ kind: 'known.siteAdapters.reconcile.retry', id: run!.id, ...(picker?.value() ? { destinationId: picker.value() } : {}) }); };
  const cancel = document.getElementById('reconcile-cancel')! as HTMLButtonElement; cancel.hidden = run?.state !== 'approved';
  cancel.disabled = false;
  cancel.onclick = () => { cancel.disabled = true; void sending?.({ kind: 'known.siteAdapters.reconcile.cancel', id: run!.id }); };
  const rescan = document.getElementById('reconcile-rescan')! as HTMLButtonElement; rescan.disabled = false;
  rescan.onclick = () => { rescan.disabled = true; void (async () => {
    if (run?.state === 'approved') await sending?.({ kind: 'known.siteAdapters.reconcile.cancel', id: run.id });
    if (!['completed', 'cancelled'].includes(phase ?? '')) await sending?.({ kind: 'known.siteAdapters.import.cancel', jobId: preview.importId });
    await sending?.({ kind: 'known.siteAdapters.import.start' });
  })(); };
  document.getElementById('reconcile-result')!.textContent = run ? t('sites_reconcileResult', '$1 applied · $2 need attention · $3 waiting',
    run.operations.filter(op => op.state === 'completed').length, run.operations.filter(op => op.state === 'attention').length, run.operations.filter(op => op.state === 'pending').length)
      + (run.state === 'completed' ? ` · ${t('sites_reconcileExceptions', 'Checked against this read; $1 unverified items and $2 retained exceptions remain.',
        preview.differences.filter(d => d.kind === 'unverified').length, preview.differences.filter(d => !['present', 'add', 'unverified'].includes(d.kind) && !run.operations.some(op => op.difference.id === d.id)).length)}` : '') : '';
}
