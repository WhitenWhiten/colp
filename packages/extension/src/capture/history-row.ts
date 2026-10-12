import type { LocalHistoryItem } from './local-history.js';
import { CAPTURE_SAVE_COPY, CAPTURE_SYNC_COPY } from './history.js';
import { faviconTile } from '../bookmark-manager-dom.js';
import { createIcon } from '../icons.js';
import { button, el } from '../library-dom.js';
import { t, uiLanguage } from '../i18n.js';

export function hostOf(url: string): string { try { return new URL(url).hostname.replace(/^www\./u, ''); } catch { return url; } }

/** What the one action on a problem row does. */
export type RowRetry = 'check' | 'resume' | 'report';
export interface HistoryBadge { readonly label: string; readonly tone?: 'danger' | 'warning'; readonly retry?: RowRetry }

/**
 * The single thing worth saying about a row. Settled work says nothing, so a
 * problem is the only marked thing in a list; the most serious one wins.
 */
export function historyBadge(task: LocalHistoryItem): HistoryBadge | undefined {
  if (task.disposition === 'cancelled' && task.save === 'local-saved') return { label: t('capture_removed', 'Removed') };
  if (task.save === 'failed') return { label: t('history_notSaved', 'Not saved'), tone: 'danger' };
  if (task.save === 'unknown') return { label: t('history_needsChecking', 'Needs checking'), tone: 'warning', retry: 'check' };
  if (task.save === 'unsubmitted') return { label: CAPTURE_SAVE_COPY.unsubmitted, tone: 'warning', retry: 'resume' };
  if (task.classification === 'failed') return { label: t('history_suggestionFailed', 'Suggestion failed'), tone: 'danger' };
  if (task.sync === 'attention') return { label: CAPTURE_SYNC_COPY.attention, tone: 'warning' };
  if (task.reportFailure) return { label: t('history_notReported', 'Not sent to your account'), tone: 'warning', retry: 'report' };
  if (task.classification === 'manual') return { label: t('history_needsReview', 'Needs your review'), tone: 'warning' };
  if (task.historyReadOnly) return { label: task.historyOrigin === 'device' ? t('capture_savedBrowser2', 'Saved in browser')
    : task.historyOrigin === 'backup' ? t('backup_restoredHistory', 'Restored history') : t('capture_beforeSignIn', 'Saved before sign-in') };
  return undefined;
}

/** True when the folder on the bookmark is the AI's choice and the user has not overruled it. */
export function isAiPick(task: LocalHistoryItem): boolean {
  return task.classification === 'applied' && task.disposition === 'new'
    && (task.historyAutomaticApplied ?? task.automatic?.decision?.automaticApplied ?? Boolean(task.appliedRevision)) !== false
    && task.feedbackKind !== 'explicit_negative' && task.feedbackKind !== 'correction_applied' && !task.historyReadOnly;
}

export function badgeElement(badge: HistoryBadge): HTMLElement {
  const node = el('span', badge.label, 'badge');
  if (badge.tone) node.dataset.tone = badge.tone;
  return node;
}

export function timeOf(at: number, timezone: string): string {
  try { return new Date(at).toLocaleTimeString(uiLanguage(), { timeZone: timezone, timeStyle: 'short' }); }
  catch { return new Date(at).toLocaleTimeString(uiLanguage(), { timeStyle: 'short' }); }
}

export interface HistoryRowContext {
  readonly timezone: string;
  readonly selected: boolean;
  open(): void;
  select(on: boolean): void;
  /** Runs the row's one action; the row shows it busy meanwhile. */
  retry(kind: RowRetry, task: LocalHistoryItem): Promise<void>;
}

function titleButton(label: string, id: string, open: () => void): HTMLButtonElement {
  const title = el('button', label, 'list-row-title hist-title');
  title.type = 'button'; title.id = id; title.addEventListener('click', open);
  return title;
}

function metaLine(parts: readonly (string | Node)[]): HTMLElement {
  const meta = el('span', undefined, 'list-row-meta');
  parts.forEach((part, index) => {
    if (index) meta.append(el('span', undefined, 'sep'));
    meta.append(typeof part === 'string' ? el('span', part, 'grow') : part);
  });
  return meta;
}

function folderPart(path: string | undefined): HTMLElement {
  const where = el('span', undefined, 'grow hist-folder');
  const label = path?.split(' › ').at(-1) ?? t('capture_locationAwaitingConfirmation', 'Location awaiting confirmation');
  where.append(createIcon('folder', 12), el('span', label));
  if (path) where.title = path;
  return where;
}

/** One saved page: favicon, title, domain · folder · time, and at most one badge and one action. */
export function renderHistoryRow(task: LocalHistoryItem, context: HistoryRowContext): HTMLElement {
  const row = el('div', undefined, 'list-row hist-row');
  row.dataset.captureId = task.captureId;
  const lead = el('span', undefined, 'mgr-lead');
  const check = el('input', undefined, 'mgr-select'); check.type = 'checkbox'; check.checked = context.selected; check.disabled = Boolean(task.historyReadOnly);
  check.setAttribute('aria-label', t('capture_select', 'Select $1', task.title || hostOf(task.url)));
  check.addEventListener('change', () => { context.select(check.checked); });
  lead.append(check, faviconTile(task.url));
  const main = el('span', undefined, 'list-row-main');
  main.append(
    titleButton(task.title || hostOf(task.url), `capture-row-${task.captureId}`, context.open),
    metaLine([hostOf(task.url), ...(task.historyOrigin === 'device' ? [] : [folderPart(task.localLocation?.path.join(' › '))]), timeOf(task.createdAt, context.timezone)]),
  );
  const tail = el('span', undefined, 'list-row-tail');
  const badge = historyBadge(task);
  if (isAiPick(task) && !badge) {
    const pick = el('span', undefined, 'ai-pick'); pick.append(createIcon('sparkle', 13), t('popup_aiPick', 'AI pick'));
    tail.append(pick);
  }
  if (badge) tail.append(badgeElement(badge));
  if (badge?.retry && !task.historyReadOnly) {
    const kind = badge.retry;
    const retry = button(t('common_retry', 'Retry'), 'btn btn-ghost btn-sm');
    retry.addEventListener('click', (event) => {
      event.stopPropagation(); retry.disabled = true;
      void context.retry(kind, task).finally(() => { retry.disabled = false; });
    });
    tail.append(retry);
  }
  row.append(lead, main, tail);
  row.addEventListener('click', (event) => {
    if (event.target instanceof Element && event.target.closest('button, a, input')) return;
    context.open();
  });
  return row;
}

/** A save recorded by another browser of the same account: read-only, opens its own short detail. */
export function renderRemoteRow(input: { readonly url: string; readonly title: string; readonly path: string; readonly at?: number }, timezone: string, open: () => void): HTMLElement {
  const row = el('div', undefined, 'list-row hist-row');
  const main = el('span', undefined, 'list-row-main');
  const parts: (string | Node)[] = [hostOf(input.url), folderPart(input.path)];
  if (input.at !== undefined) parts.push(timeOf(input.at, timezone));
  main.append(titleButton(input.title || hostOf(input.url), `capture-remote-${crypto.randomUUID()}`, open), metaLine(parts));
  const tail = el('span', undefined, 'list-row-tail');
  tail.append(badgeElement({ label: t('common_anotherBrowser', 'Another browser') }));
  row.append(el('span', undefined, 'mgr-lead'), main, tail);
  row.firstElementChild!.append(faviconTile(input.url));
  row.addEventListener('click', (event) => { if (!(event.target instanceof Element && event.target.closest('button, a'))) open(); });
  return row;
}
