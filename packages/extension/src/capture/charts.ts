import type { CaptureStatistics, CaptureCounters } from './statistics.js';
import { captureReasonLabel } from './reason-labels.js';
import { t } from '../i18n.js';
const percentage = (n: number, d: number) => d ? `${(100 * n / d).toFixed(1)}% (${n}/${d})` : t('common_noData', 'No data');
const node = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string) => { const element = document.createElement(tag); if (text !== undefined) element.textContent = text; return element; };
export function renderCaptureCharts(host: HTMLElement, statistics: CaptureStatistics, select: (status: string, day?: string) => void) {
  const { counts } = statistics;
  const cards = node('div'); cards.className = 'capture-summary-grid';
  for (const [label, value, status] of [
    [t('common_saved', 'Saved'), counts.total ? `${counts.saved}/${counts.total}` : t('common_noData', 'No data'), 'completed'],
    [t('capture_automaticClassificationCoverage', 'Automatic classification coverage'), percentage(counts.automaticApplied, counts.automaticEligible), 'all'],
    [t('common_explicitSatisfaction', 'Explicit satisfaction'), counts.positive + counts.negative ? percentage(counts.positive, counts.positive + counts.negative) : t('capture_noRatingsYet', 'No ratings yet'), 'all'],
    [t('common_needsAttention', 'Needs attention'), String(counts.attention), 'attention'],
  ]) {
    const button = node('button'); button.type = 'button'; button.className = 'capture-summary-card';
    button.append(node('span', label), node('strong', value)); button.addEventListener('click', () => select(status!)); cards.append(button);
  }
  const coverage = node('p', t('capture_explicitFeedbackCoverageSave', 'Explicit feedback coverage: $1. $2 save results unknown; $3 in progress.', percentage(counts.positive + counts.negative, counts.automaticApplied), counts.unknown, counts.pending)); coverage.className = 'meta';
  const charts = node('div'); charts.className = 'capture-chart-grid';
  charts.append(chart(t('capture_saveStateTrend', 'Save state trend'), statistics, [
    ['saved', t('common_saved', 'Saved')], ['failed', t('common_failed', 'Failed')], ['pending', t('common_inProgress', 'In progress')], ['unknown', t('common_unknown', 'Unknown')],
  ], select), chart(t('common_feedbackDistribution', 'Feedback distribution'), statistics, [
    ['positive', t('common_explicitPositive', 'Explicit positive')], ['negative', t('common_explicitNegative', 'Explicit negative')], ['implicit', t('common_implicitAcceptance', 'Implicit acceptance')], ['unrated', t('common_unrated', 'Unrated')],
  ], select));
  const definitions = node('details'), summary = node('summary', t('capture_definitionsTimings', 'Definitions and timings')); definitions.className = 'note-details'; definitions.append(summary);
  definitions.append(node('p', t('capture_explicitSatisfactionDescribesPeople', 'Explicit satisfaction describes people who rated their folder result. It is not classification accuracy. Implicit acceptance is counted separately and is never a learning label.')));
  definitions.append(node('p', t('capture_implicitAcceptanceTerminalSave', 'Implicit acceptance: $1. Terminal save success: $2; terminal coverage: $3.', percentage(counts.implicit, counts.automaticApplied), percentage(counts.saved, counts.saved + counts.failed), percentage(counts.saved + counts.failed, counts.total))));
  for (const [label, latency] of [[t('common_save', 'Save'), statistics.latency.save], [t('common_classification', 'Classification'), statistics.latency.classification]] as const) {
    definitions.append(node('p', t('capture_timedSamplesP50P95', '$1: $2 timed samples; p50 $3, p95 $4.', label, latency.samples, latency.p50 === null ? '—' : `${Math.round(latency.p50)} ms`, latency.p95 === null ? '—' : `${Math.round(latency.p95)} ms`)));
  }
  for (const [label, reasons] of [[t('common_saveFailures', 'Save failures'), statistics.saveFailures], [t('common_classificationDeferrals', 'Classification deferrals'), statistics.classificationDeferrals]] as const) {
    definitions.append(node('h4', label)); const list = node('ul');
    for (const [reason, count] of Object.entries(reasons)) list.append(node('li', `${captureReasonLabel(reason)}: ${count}`));
    if (!list.childElementCount) list.append(node('li', t('capture_nonePeriod', 'None in this period.'))); definitions.append(list);
  }
  const table = node('table'); table.className = 'capture-data-table'; table.append(node('caption', t('capture_dataTable', 'Data table · $1', statistics.timezone)));
  const head = node('thead'), header = node('tr'); for (const title of [t('common_date', 'Date'), t('common_saved', 'Saved'), t('common_failed', 'Failed'), t('common_pending', 'Pending'), t('common_unknown', 'Unknown'), '+', '−', t('common_implicit', 'Implicit'), t('common_unrated', 'Unrated')]) header.append(node('th', title)); head.append(header); table.append(head);
  const body = node('tbody'); for (const day of statistics.days) {
    const row = node('tr'); row.append(node('th', day.date));
    for (const key of ['saved', 'failed', 'pending', 'unknown', 'positive', 'negative', 'implicit', 'unrated'] as const) row.append(node('td', String(day.counts[key])));
    body.append(row);
  } table.append(body); definitions.append(table);
  // The caveat qualifies the coverage figures, so it sits in their line rather than after the charts.
  if (counts.automaticApplied > 0 && counts.automaticApplied < 30) coverage.textContent += ` ${t('capture_smallSample', 'Small sample: $1 applied automatic results. Interpret feedback counts with this coverage.', counts.automaticApplied)}`;
  host.replaceChildren(cards, coverage, charts, definitions);
}
function chart(title: string, statistics: CaptureStatistics, series: readonly (readonly [keyof CaptureCounters, string])[], select: (status: string, day?: string) => void) {
  const figure = node('figure'); figure.className = 'capture-chart'; figure.append(node('figcaption', title));
  const legend = node('div'); legend.className = 'capture-chart-legend';
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('viewBox', '0 0 420 160'); svg.setAttribute('role', 'group'); svg.setAttribute('aria-label', title);
  for (const [key, label] of series) {
    const item = node('button', `${label}: ${statistics.counts[key]}`); item.type = 'button'; item.className = 'btn btn-ghost'; item.dataset.series = key; item.setAttribute('aria-pressed', 'true');
    item.addEventListener('click', () => { const visible = item.getAttribute('aria-pressed') !== 'true'; item.setAttribute('aria-pressed', String(visible));
      for (const rect of Array.from(svg.querySelectorAll(`[data-series="${key}"]`))) { rect.setAttribute('visibility', visible ? 'visible' : 'hidden'); } }); legend.append(item);
  }
  const max = Math.max(1, ...statistics.days.map(day => series.reduce((sum, [key]) => sum + day.counts[key], 0)));
  const width = Math.max(1, 390 / Math.max(1, statistics.days.length));
  for (const [index, day] of statistics.days.entries()) {
    let bottom = 140;
    for (const [key, label] of series) {
      const value = day.counts[key]; if (!value) continue;
      const rect = document.createElementNS(svg.namespaceURI, 'rect'); const height = value * 120 / max;
      for (const [name, attribute] of Object.entries({ x: String(20 + index * width), y: String(bottom - height), width: String(Math.max(1, width - 4)), height: String(height),
        tabindex: '-1', 'aria-label': `${day.date}: ${label} ${value}`, 'data-series': key })) rect.setAttribute(name, attribute);
      const click = () => select(key === 'failed' || key === 'unknown' ? 'attention' : key === 'pending' ? 'progress' : 'all', day.date);
      rect.addEventListener('click', click); rect.addEventListener('keydown', event => { const key = (event as KeyboardEvent).key;
        if (key === 'Enter' || key === ' ') { event.preventDefault(); click(); } });
      svg.append(rect); bottom -= height;
    }
    if (index % Math.max(1, Math.ceil(statistics.days.length / 7)) === 0) {
      const label = document.createElementNS(svg.namespaceURI, 'text'); label.setAttribute('x', String(20 + (index + 0.5) * width)); label.setAttribute('y', '157'); label.setAttribute('text-anchor', 'middle'); label.textContent = day.date.slice(5); svg.append(label);
    }
  }
  /* With no days there is nothing to plot, and the empty 420×160 frame was
     reserving a full chart's height just to say so. */
  if (statistics.days.length) figure.append(legend, svg);
  else { const empty = node('p', t('capture_noTasksPeriod', 'No tasks in this period.')); empty.className = 'meta'; figure.append(empty); }
  return figure;
}
