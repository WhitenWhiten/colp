import type { CaptureTask } from './contracts.js';
import { CAPTURE_SAVE_COPY, captureClassificationCopy, CAPTURE_SYNC_COPY } from './history.js';
import { CAPTURE_REASON_LABELS } from './reason-labels.js';
import { detailActions } from './history-detail-actions.js';
import { createDetailFields } from './history-detail-fields.js';
import { historyBadge, hostOf, badgeElement } from './history-row.js';
import { faviconTile } from '../bookmark-manager-dom.js';
import { createIcon } from '../icons.js';
import { button, el } from '../library-dom.js';
import { t, uiLanguage } from '../i18n.js';

interface CaptureDetailOptions {
  readonly timezone?: string; readonly refresh?: () => Promise<void>;
  /** Back to the list. */
  readonly close: () => void; readonly readOnly?: boolean; readonly historyOrigin?: 'backup' | 'device';
}

function row(title: string, value: Node | string, hint?: string): HTMLElement {
  const node = el('div', undefined, 'set-row');
  const text = el('div', undefined, 'set-row-text'); text.append(el('p', title, 'set-row-title'));
  if (hint) text.append(el('p', hint, 'set-row-hint'));
  const control = el('div', undefined, 'set-row-control');
  if (typeof value === 'string') control.append(el('span', value, 'set-row-value')); else control.append(value);
  node.append(text, control);
  return node;
}

function when(at: number, timezone: string | undefined, long = true): string {
  try { return new Date(at).toLocaleString(uiLanguage(), { ...(timezone ? { timeZone: timezone } : {}), dateStyle: 'medium', timeStyle: long ? 'medium' : 'short' }); }
  catch { return new Date(at).toLocaleString(uiLanguage(), { dateStyle: 'medium', timeStyle: 'short' }); }
}

/** Show only outcomes this record can prove; device facts have no cloud or AI receipts. */
function happened(task: CaptureTask, timezone: string | undefined, deviceOnly = false): HTMLElement {
  const group = el('section', undefined, 'set-group');
  const head = el('div', undefined, 'set-group-head'); head.append(el('h2', t('history_whatHappened', 'What happened')));
  const card = el('div', undefined, 'set-card');
  const removed = task.disposition === 'cancelled' && task.save === 'local-saved';
  const saveValue = removed ? t('capture_removed', 'Removed') : CAPTURE_SAVE_COPY[task.save];
  const outcome = (label: string, value: string, tone?: 'danger' | 'warning') => {
    const mark = el('span', value, tone ? 'badge' : 'set-row-value'); if (tone) mark.dataset.tone = tone;
    return row(label, mark);
  };
  const failed = (bad: boolean, tone: 'danger' | 'warning') => bad ? tone : undefined;
  card.append(outcome(t('history_savedStep', 'Saved'), saveValue, failed(task.save === 'failed', 'danger') ?? failed(task.save === 'unknown' || task.save === 'unsubmitted', 'warning')));
  if (!deviceOnly) card.append(
    outcome(t('history_folderStep', 'Folder'), captureClassificationCopy(task), failed(task.classification === 'failed', 'danger') ?? failed(task.classification === 'manual', 'warning')),
    outcome(t('history_syncStep', 'Sync'), CAPTURE_SYNC_COPY[task.sync], failed(task.sync === 'attention', 'warning')),
  );
  for (const [label, time] of [[t('common_captureStarted', 'Capture started'), task.createdAt], [t('capture_savedBrowser2', 'Saved in browser'), task.savedAt],
    [t('capture_cloudClassificationConfirmed', 'Cloud classification confirmed'), task.classificationAppliedAt], [t('capture_browserPlacementConfirmed', 'Browser placement confirmed'), task.classificationNativeConfirmedAt]] as const) {
    if (time === undefined && !task.automatic && label !== t('capture_savedBrowser2', 'Saved in browser')) continue;
    const value = el('time', time === undefined ? t('common_pending', 'Pending') : when(time, timezone), 'set-row-value');
    if (time !== undefined) value.dateTime = new Date(time).toISOString(); else value.dataset.pending = '';
    card.append(row(label, value));
  }
  group.append(head, card);
  return group;
}

/**
 * One saved page, opened from History: where it lives (change the folder, tags
 * and note here), what happened to it, and what can still be done. Commands
 * the worker offers keep their old wording; the folder change is the same
 * correction the old editor sent.
 */
export function captureDetail(task: CaptureTask, { timezone, refresh, close, readOnly = false, historyOrigin }: CaptureDetailOptions): HTMLElement {
  const host = el('aside', undefined, 'hist-detail'); host.tabIndex = -1; host.setAttribute('aria-label', t('common_captureDetails', 'Capture details'));
  const back = button('', 'btn btn-ghost btn-sm detail-back'); back.append(createIcon('arrow-left', 14), t('common_history', 'History'));
  back.setAttribute('aria-label', t('history_backToHistory', 'Back to History')); back.addEventListener('click', close);

  const head = el('header', undefined, 'detail-head');
  const title = el('div', undefined, 'detail-title');
  title.append(faviconTile(task.url), el('h1', task.title || hostOf(task.url)));
  const meta = el('p', undefined, 'detail-meta');
  const site = el('a', hostOf(task.url)); site.href = task.url; site.target = '_blank'; site.rel = 'noreferrer';
  meta.append(site, el('span', undefined, 'sep'), el('span', when(task.createdAt, timezone, false)));
  const badge = historyBadge(task);
  if (badge) meta.append(badgeElement(badge));
  head.append(title, meta);

  const status = el('p', undefined, 'field-hint detail-status'); status.setAttribute('role', 'status');
  const onChanged = () => { status.textContent = t('capture_updateRecordedRefreshDetails', 'Update recorded. Refresh details to see the latest receipt.'); };
  const { alerts, actions } = detailActions(task, { readOnly, ...(historyOrigin ? { historyOrigin } : {}), onChanged, host,
    status: (text) => { status.textContent = text; } });
  const deleted = task.reason === 'bookmark_deleted';
  const fields = createDetailFields(task, { editable: !readOnly && !deleted && Boolean(task.nativeId), onChanged });

  const facts = el('details', undefined, 'disclosure'); facts.append(el('summary', t('common_operationDetails', 'Operation details')));
  const factsBody = el('div', undefined, 'detail-facts');
  factsBody.append(el('p', t('capture_captureId', 'Capture ID: $1', task.captureId)), el('p', t('capture_policyVersion', 'Policy version: $1', task.policyVersion)),
    el('p', t('capture_reason', 'Reason: $1', CAPTURE_REASON_LABELS[task.reason ?? ''] ?? task.reason ?? t('common_none', 'None'))));
  facts.append(factsBody);
  const links = el('div', undefined, 'detail-links');
  const diagnostics = el('a', t('common_openDiagnostics', 'Open diagnostics'), 'btn btn-ghost btn-sm'); diagnostics.href = '#help?category=capture';
  links.append(diagnostics);
  if (refresh) links.prepend(button(t('common_refreshDetails', 'Refresh details'), 'btn btn-ghost btn-sm', () => { void refresh(); }));
  const more = el('div', undefined, 'set-card detail-more'); more.append(facts, links);

  const actionCard = el('div', undefined, 'set-card detail-action-card'); actionCard.append(actions);
  host.append(back, head, ...alerts, status, fields, happened(task, timezone, historyOrigin === 'device'), actionCard, more);
  return host;
}
