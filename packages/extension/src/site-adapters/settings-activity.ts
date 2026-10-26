import { formatMoment, t } from '../i18n.js';
import { siteProblem } from './problem-view.js';
import type { SiteActivity, ActivityCounts, SiteOperation } from './activity.js';
import type { SiteDefinition } from './registry-types.js';

type Send = (request: Record<string, unknown>) => Promise<unknown>;
interface ClientProblem { code: string; capturedAt: number; counts?: ActivityCounts; operation?: SiteOperation; resolvedAt?: number; resolution?: SiteActivity['resolution'] }
const element = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id)! as T;
const counts = (event: SiteActivity) => event.counts
  ? t('sites_recordCounts', '$1 read · $2 confirmed saved · $3 skipped', event.counts.read.toLocaleString(), event.counts.saved.toLocaleString(), event.counts.skipped.toLocaleString()) : '';
function title(event: SiteActivity, site: string) {
  if (event.kind === 'problem') return siteProblem(event.code ?? '', site, event).what;
  if (event.kind === 'waiting') return t('sites_recordWaiting', 'Waiting for bookmark sync; the approved work is kept');
  if (event.kind === 'checked') return t('sites_recordChecked', 'Source check completed');
  if (event.kind === 'saved') return t('sites_recordSaved', 'Bookmark saves confirmed');
  if (event.kind === 'stopped') return t('sites_recordStopped', 'The operation was stopped; confirmed bookmarks are kept');
  if (event.kind === 'configured') return event.operation === 'connect' ? t('sites_recordConnected', 'Website connection updated') : t('sites_recordConfigured', 'Sync settings saved');
  return event.operation === 'save' ? t('sites_recordSaving', 'Saving started') : t('sites_recordReading', 'Source check started');
}

/** Ordinary problem reports use immutable host records. The full private database export remains a separate recovery tool. */
export function createSiteActivityView(send: Send, definition: SiteDefinition) {
  let current: SiteActivity | null = null, fallback: ClientProblem | null = null;
  const clientKey = `known.siteAdapters.clientProblem.v1:${definition.adapterId}`;
  let clientRecord: ClientProblem | null = null;
  let lastKey = '', problemKey = '', turn = 0;
  const history = element<HTMLDetailsElement>('site-history');
  async function copy(id?: string) {
    const chosen = current, client = fallback ? structuredClone(fallback) : null;
    const result = id?.startsWith('client:') ? { report: { format: 'known.site-adapter-report/v1',
      adapter: { adapterId: definition.adapterId, version: definition.version, siteKey: definition.siteKey }, clientProblem: clientRecord } }
      : await send({ kind: 'known.siteAdapters.activity.report', ...(id ? { id } : {}) }) as { report?: unknown; error?: string };
    const report = id ? result.report : { format: 'known.site-adapter-report/v1',
      adapter: { adapterId: definition.adapterId, version: definition.version, siteKey: definition.siteKey },
      clientProblem: client, host: result.report ?? null };
    const output = JSON.stringify(report ?? { error: result.error ?? 'reportUnavailable', incident: chosen }, null, 2);
    try {
      await navigator.clipboard.writeText(output);
      element('site-copy-fallback').hidden = true;
      element('activity-feedback').textContent = t('sites_problemCopied', 'Problem report copied. It excludes account identities, page content and credentials.');
      return true;
    } catch {
      const field = element<HTMLTextAreaElement>('site-copy-fallback'); field.value = output; field.hidden = false;
      const dialog = document.getElementById('site-settings-dialog') as HTMLDialogElement | null;
      if (dialog?.open) dialog.querySelector('.capture-dialog-body')?.append(field); else element('activity-feedback').after(field);
      field.focus(); field.select();
      element('activity-feedback').textContent = t('sites_problemCopyManual', 'Copy the selected report below.');
      return false;
    }
  }
  element('problem-copy').addEventListener('click', () => { const id = current?.id; void copy(id).then(ok => { if (ok && id === current?.id)
    element('problem-copy').textContent = t('sites_reportCopiedShort', 'Copied'); }); });
  element('activity-copy').addEventListener('click', () => { void copy(); });
  element('problem-recover').addEventListener('click', () => {
    const button = element<HTMLButtonElement>('problem-recover'); button.disabled = true;
    void send({ kind: 'known.siteAdapters.operations.check' }).then(result => {
      if (!(result as { error?: string } | null)?.error) succeeded('recover'); document.getElementById('refresh')?.click(); })
      .finally(() => { button.disabled = false; });
  });
  document.addEventListener('close', relocate, true);
  window.addEventListener('pagehide', () => { document.removeEventListener('close', relocate, true); }, { once: true });
  if (chrome.storage?.local) void chrome.storage.local.get(clientKey).then(data => {
    if (!clientRecord && data[clientKey]) { clientRecord = data[clientKey] as ClientProblem;
      if (!fallback && !clientRecord.resolvedAt) { fallback = clientRecord; paint(); } }
  }).catch(() => undefined);
  async function refresh() {
    const own = ++turn;
    const result = await send({ kind: 'known.siteAdapters.activity.list' }) as { events?: SiteActivity[]; error?: string };
    if (own !== turn) return;
    const events = result.events ?? [];
    if (clientRecord) events.unshift({ id: `client:${clientRecord.capturedAt}`, code: clientRecord.code, kind: 'problem', operation: clientRecord.operation ?? 'status',
      firstAt: clientRecord.capturedAt, lastAt: clientRecord.capturedAt, resolvedAt: clientRecord.resolvedAt, resolution: clientRecord.resolution, occurrences: 1, counts: clientRecord.counts });
    events.sort((a, b) => b.firstAt - a.firstAt);
    const key = JSON.stringify(events);
    if (lastKey === key) return; lastKey = key;
    const list = element('site-activity-list');
    if (!events.length) { list.textContent = result.error ? t('sites_recordsUnavailable', 'Operation records could not be read. You can still copy a problem report.')
      : t('sites_recordsEmpty', 'New checks, saves and problems will be recorded here.'); return; }
    const opened = new Set(Array.from(list.querySelectorAll<HTMLDetailsElement>('details[open]')).map(d => d.dataset.id));
    list.replaceChildren(...events.slice(0, 30).map(event => {
      const row = document.createElement('details'); row.className = 'disclosure sites-activity-record'; row.dataset.id = event.id; row.open = opened.has(event.id);
      const heading = document.createElement('summary'), name = document.createElement('span'), time = document.createElement('span');
      name.textContent = title(event, definition.label); time.className = 'set-row-hint';
      time.textContent = [formatMoment(event.firstAt), event.resolution === 'dismissed' ? t('sites_recordDismissed', 'Closed') : event.resolvedAt ? t('sites_recordRecovered', 'Recovered') : '',
        event.occurrences > 1 ? t('sites_recordRepeated', '$1 attempts', event.occurrences) : ''].filter(Boolean).join(' · ');
      heading.append(name, time); row.append(heading);
      const body = document.createElement('div'); body.className = 'sites-record-detail';
      const impact = document.createElement('p'); impact.className = 'set-row-hint'; impact.textContent = counts(event); if (impact.textContent) body.append(impact);
      if (event.kind === 'problem') {
        const next = document.createElement('p'); next.className = 'set-row-hint'; next.textContent = siteProblem(event.code ?? '', definition.label, event).next; body.append(next);
      }
      const details = document.createElement('pre'); details.className = 'code-panel'; details.textContent = JSON.stringify(event, null, 2); body.append(details);
      const button = document.createElement('button'); button.type = 'button'; button.className = 'btn btn-ghost btn-sm'; button.textContent = t('sites_copyRecord', 'Copy this operation record');
      button.onclick = () => { void copy(event.id).then(ok => { if (ok) button.textContent = t('sites_reportCopiedShort', 'Copied'); }); }; body.append(button); row.append(body); return row;
    }));
  }
  history.addEventListener('toggle', () => { if (history.open) void refresh(); });
  element('activity-refresh').addEventListener('click', () => { void refresh(); });
  return {
    failed(code: string, incidentId?: string, snapshot?: ActivityCounts, operation: SiteOperation = 'status') {
      if (incidentId && current?.id === incidentId || !incidentId && fallback?.code === code && fallback.operation === operation && Date.now() - fallback.capturedAt < 500) { paint(); return; }
      fallback = { code: /^[a-zA-Z0-9_.:-]{1,128}$/u.test(code) ? code : 'unclassified', capturedAt: Date.now(), counts: snapshot, operation };
      if (incidentId) current = { id: incidentId, code: fallback.code, kind: 'problem', operation, firstAt: fallback.capturedAt, lastAt: fallback.capturedAt, occurrences: 1 };
      else { clientRecord = { ...fallback }; if (chrome.storage?.local) void chrome.storage.local.set({ [clientKey]: clientRecord }).catch(() => undefined); }
      paint(); if (history.open) void refresh();
    },
    paint(problem?: SiteActivity | null) { if (problem !== undefined) { if (current?.id && !problem) fallback = null; current = problem; } paint(); },
    succeeded,
    discardConfiguration() {
      if (current?.operation === 'configure') { const id = current.id; current = null; void send({ kind: 'known.siteAdapters.activity.dismiss', id }); }
      if (fallback?.operation === 'configure') { fallback = null;
        if (clientRecord && !clientRecord.resolvedAt && clientRecord.operation === 'configure') { clientRecord.resolvedAt = Date.now(); clientRecord.resolution = 'dismissed';
          if (chrome.storage?.local) void chrome.storage.local.set({ [clientKey]: clientRecord }).catch(() => undefined); } }
      paint();
    },
    changed() { if (history.open) void refresh(); },
    layout: relocate,
  };
  function succeeded(operation: SiteOperation) {
    if (fallback?.operation === operation) { fallback = null;
      if (clientRecord && !clientRecord.resolvedAt && clientRecord.operation === operation) { clientRecord.resolvedAt = Date.now();
        if (chrome.storage?.local) void chrome.storage.local.set({ [clientKey]: clientRecord }).catch(() => undefined); } }
    paint();
  }
  function relocate() {
    const problem = element('site-problem'), dialog = document.getElementById('site-settings-dialog') as HTMLDialogElement | null;
    const operation = current?.operation ?? fallback?.operation;
    const overview = element('source-overview'), task = document.querySelector('#step-import .sites-task-content');
    const container = dialog?.open && ['configure', 'connect'].includes(operation ?? '') ? dialog.querySelector('.capture-dialog-body')
      : !overview.hidden && task ? task : element('site-problem-slot');
    if (container && problem.parentElement !== container) {
      if (container === task) container.querySelector('.set-row')?.after(problem); else container.prepend(problem);
    }
    element('problem-recover').hidden = siteProblem(current?.code ?? fallback?.code ?? '', definition.label, current).family !== 'unconfirmed' || !element('retry-import').hidden;
  }
  function paint() {
    relocate();
    const code = current?.code ?? fallback?.code;
    element('site-problem').hidden = !code;
    const key = current?.id ?? String(fallback?.capturedAt ?? '');
    if (key !== problemKey) { problemKey = key; element('problem-copy').textContent = t('sites_copyProblem', 'Copy problem report'); }
    if (!code) return;
    const view = siteProblem(code, definition.label, current);
    element('site-problem-what').textContent = view.what;
    element('site-problem-next').textContent = view.next;
    element('site-problem-time').textContent = formatMoment(current?.firstAt ?? fallback!.capturedAt);
  }
}
