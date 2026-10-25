import { sendSiteMessage } from './settings-client.js';
import { reconcileReason } from './settings-reconcile.js';
import type { ReconcileRun } from './reconcile-run.js';
import type { ReconcileRunSummary } from './reconcile-records.js';
import { t } from '../i18n.js';
import { showToast } from '../toast.js';
const list = document.getElementById('reconcile-history-list')!, detail = document.getElementById('reconcile-history-detail')!;
const button = (label: string, action: () => Promise<void>) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'btn btn-ghost btn-sm'; b.textContent = label;
  b.onclick = () => { b.disabled = true; void action().catch(e => showToast(reconcileReason(e instanceof Error ? e.message : ''), 'error')).finally(() => { b.disabled = false; }); }; return b; };
async function request<T>(input: unknown): Promise<T> {
  const response = await sendSiteMessage(input) as { error?: string; archiveResult: T };
  if (response.error) throw new Error(response.error); return response.archiveResult;
}
async function open(id: string) {
  const { run } = await request<{ run: ReconcileRun }>({ kind: 'known.siteAdapters.reconcile.get', id });
  const state = (s: string) => s === 'completed' ? t('sites_reconcileApplied', 'Applied') : s === 'undone' ? t('sites_reconcileUndone', 'Undone')
    : s === 'pending' ? t('sites_waitingShort', 'Waiting') : t('sites_needsReviewShort', 'Needs review');
  detail.replaceChildren(...run.operations.map(op => {
    const row = document.createElement('div'); row.className = 'set-row'; row.dataset.operationId = op.id; const text = document.createElement('p'); text.textContent = `${op.difference.title} · ${state(op.state)}${op.reason ? ` · ${reconcileReason(op.reason)}` : ''}`; row.append(text);
    if (op.state === 'completed') row.append(button(t('common_undo', 'Undo'), async () => {
      await request({ kind: 'known.siteAdapters.reconcile.undo', id, operationId: op.id }); await open(id);
    })); return row;
  }), button(t('common_refresh', 'Refresh'), () => open(id)));
  if (run.operations.some(op => op.state === 'attention' && (run.state !== 'cancelled' || op.undoPending))) detail.append(button(t('common_retry', 'Retry'), async () => {
    await request({ kind: 'known.siteAdapters.reconcile.retry', id }); await open(id);
  }));
  if (run.state === 'approved') detail.append(button(t('common_cancel', 'Cancel'), async () => { await request({ kind: 'known.siteAdapters.reconcile.cancel', id }); await open(id); }));
}
async function load(before?: string) {
  const page = await request<{ runs: ReconcileRunSummary[]; next: string | null }>({ kind: 'known.siteAdapters.reconcile.history', ...(before ? { before } : {}) });
  if (!before) { list.replaceChildren(); detail.replaceChildren(); }
  document.getElementById('reconcile-history-more')?.remove();
  for (const run of page.runs) { const item = button(`${new Date(run.createdAt).toLocaleString()} · ${t('sites_reconcileHistoryCounts', '$1 applied · $2 need attention · $3 undone', run.completed, run.attention, run.undone)}`, () => open(run.id)); item.dataset.runId = run.id; list.append(item); }
  if (page.next) { const more = button(t('common_loadMore', 'Load more'), () => load(page.next!)); more.id = 'reconcile-history-more'; list.append(more); }
}
document.getElementById('reconcile-history-load')?.addEventListener('click', () => { void load().catch(e => showToast(reconcileReason(e instanceof Error ? e.message : ''), 'error')); });
