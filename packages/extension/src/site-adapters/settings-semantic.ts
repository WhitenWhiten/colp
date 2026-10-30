import { t } from '../i18n.js';
export interface SemanticStatus { connectionId?: string; pending: number; attention: number; completed: number; suppressed: number;
  jobs: { id: string; title: string; state: string; reason: string | null; takeover: boolean }[]; nextCursor?: string | null }
const views = new WeakMap<HTMLElement, { connectionId?: string; update(summary: SemanticStatus): void; dispose(): void }>();
export function paintSemanticRecovery(root: HTMLElement, summary: SemanticStatus,
  send: (message: Record<string, unknown>) => Promise<unknown>, act: (message: Record<string, unknown>) => Promise<unknown>, errorCopy: (reason: string) => string) {
  const existing = views.get(root);
  if (existing && existing.connectionId === summary.connectionId) { existing.update(summary); return; }
  existing?.dispose();
  const rows = document.createElement('div'), controls = document.createElement('div');
  const feedback = document.createElement('p'); feedback.setAttribute('role', 'status');
  let disposed = false, requestVersion = 0, group: 'recovery' | 'history' = 'recovery', selectedId: string | null = null;
  let cursor = summary.nextCursor, firstPage = summary.jobs, extra: SemanticStatus['jobs'] = [];
  const rendered = new Map<string, { row: HTMLElement; signature: string }>();
  const render = (jobs: SemanticStatus['jobs']) => {
    const wanted = new Set(jobs.map(job => job.id));
    for (const [id, item] of rendered) if (!wanted.has(id)) { item.row.remove(); rendered.delete(id); }
    for (const job of jobs) {
      const signature = JSON.stringify(job), existing = rendered.get(job.id);
      if (existing?.signature === signature) { rows.append(existing.row); continue; }
      existing?.row.remove();
      const row = document.createElement('div'); row.className = 'set-row'; row.dataset.jobId = job.id;
      const body = document.createElement('div'); body.className = 'set-row-text';
      const title = document.createElement('p'); title.className = 'set-row-title'; title.textContent = job.title;
      const hint = document.createElement('p'); hint.className = 'set-row-hint'; hint.textContent = errorCopy(job.reason ?? 'sourceSyncPending');
      body.append(title, hint); row.append(body);
      if (job.state === 'attention' || job.takeover) {
        const reclassify = ['semanticChooseFolder', 'semanticDestinationMapped', 'semanticDestinationOutsideLibrary', 'destination_policy_changed'].includes(job.reason ?? '');
        const retry = button(job.takeover ? t('sites_semanticTakeover', 'Take over and retry') : reclassify ? t('sites_classifyAgain', 'Classify again') : t('common_retry', 'Retry'));
        retry.addEventListener('click', () => {
          retry.disabled = true;
          void act({ kind: 'known.siteAdapters.semantic.retry', jobId: job.id, ...(reclassify ? { reclassify: true } : {}) })
            .catch(() => { if (!disposed) feedback.textContent = errorCopy('semanticJobUnavailable'); })
            .finally(() => { retry.disabled = false; });
        }); row.append(retry);
      }
      rendered.set(job.id, { row, signature });
      rows.append(row);
    }
  };
  const recoveryRows = () => [...firstPage, ...extra.filter(job => !firstPage.some(first => first.id === job.id))];
  const current = (version: number) => !disposed && root.isConnected && version === requestVersion;
  const more = button(t('sites_semanticMore', 'Load more tasks')), history = button(t('sites_semanticHistory', 'View task history'));
  const load = async (reset: boolean, requestedGroup = group) => {
    const version = ++requestVersion;
    more.disabled = true; history.disabled = true;
    try {
      const result = await send({ kind: 'known.siteAdapters.semantic.list', group: requestedGroup, ...(!reset && cursor ? { cursor } : {}) }) as SemanticStatus & { ok: boolean; error?: string };
      if (!current(version)) return;
      if (!result.ok) { feedback.textContent = errorCopy(result.error ?? 'semanticJobUnavailable'); return; }
      group = requestedGroup; selectedId = null; feedback.textContent = '';
      if (reset) { firstPage = result.jobs; extra = []; }
      else extra = [...extra, ...result.jobs.filter(job => !extra.some(old => old.id === job.id))];
      render(recoveryRows()); cursor = result.nextCursor; more.hidden = !cursor;
      history.textContent = group === 'history' ? t('sites_semanticRecovery', 'View tasks needing attention') : t('sites_semanticHistory', 'View task history');
    } catch { if (current(version)) feedback.textContent = errorCopy('semanticJobUnavailable'); }
    finally { if (version === requestVersion) { more.disabled = false; history.disabled = false; } }
  };
  more.hidden = !cursor; more.addEventListener('click', () => { void load(false); });
  history.addEventListener('click', () => { void load(true, group === 'recovery' ? 'history' : 'recovery'); });
  const id = document.createElement('input'); id.placeholder = t('sites_semanticJobId', 'Task ID'); id.setAttribute('aria-label', id.placeholder);
  const find = button(t('sites_semanticFind', 'Find task'));
  find.addEventListener('click', () => { void (async () => {
    const version = ++requestVersion; more.disabled = false; history.disabled = false;
    try {
      const result = await send({ kind: 'known.siteAdapters.semantic.get', jobId: id.value.trim() }) as { ok: boolean; job: SemanticStatus['jobs'][number]; error?: string };
      if (!current(version)) return;
      if (result.ok) { selectedId = result.job.id; render([result.job]); more.hidden = true; feedback.textContent = ''; }
      else feedback.textContent = errorCopy(result.error ?? 'semanticJobUnavailable');
    } catch { if (current(version)) feedback.textContent = errorCopy('semanticJobUnavailable'); }
  })(); });
  controls.append(more, history, id, find); render(summary.jobs); root.replaceChildren(rows, controls, feedback);
  views.set(root, { connectionId: summary.connectionId, dispose() { disposed = true; requestVersion++; }, update(next) {
    // Status polling owns only the first recovery page, never the user's history, search or loaded tail.
    if (group !== 'recovery' || selectedId) return;
    firstPage = next.jobs;
    if (!extra.length) { cursor = next.nextCursor; more.hidden = !cursor; }
    render(recoveryRows());
  } });
}
function button(label: string) { const b = document.createElement('button'); b.type = 'button'; b.className = 'btn btn-secondary btn-sm'; b.textContent = label; return b; }
