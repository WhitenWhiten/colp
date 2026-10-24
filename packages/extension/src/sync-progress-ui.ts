import { t, tn } from './i18n.js';
import type { SyncStatus } from './sync-status.js';
import type { PublicSyncProgress, SyncProgressResponse } from './types.js';

/**
 * Sync progress for people, not engineers: how many bookmarks are on the
 * server, whether the bar is moving, and what they can safely do meanwhile.
 * One pure projection feeds the options card, the sidebar bar and the popup
 * strip, so the three can never disagree.
 */
export interface SyncProgressView {
  readonly show: boolean;
  /** No count yet (comparing this browser with the collection): the bar runs without a value. */
  readonly indeterminate: boolean;
  /** 0–1. */
  readonly value: number;
  readonly done: boolean;
  /** Personal sync is paused: nothing moves until the user resumes it, so nothing may look like it is running. */
  readonly paused: boolean;
  readonly title: string;
  /** "1,240 of 5,312 bookmarks synced". */
  readonly detail: string;
  /** Short form for the popup and the sidebar. */
  readonly short: string;
  /** Why the bar is not moving, when it is not. */
  readonly note?: string;
  readonly guidance: readonly string[];
}

const HIDDEN: SyncProgressView = Object.freeze({ show: false, indeterminate: false, value: 0, done: false, paused: false,
  title: '', detail: '', short: '', guidance: [] });

const count = (value: number) => value.toLocaleString();
const NOT_SYNCING = new Set<SyncStatus['kind']>(['signed-out', 'local-only', 'setup-required']);

function guidance(): string[] {
  return [
    t('syncProgress_keepUsing', 'Keep using your browser and bookmarks as usual. Changes you make now sync right after.'),
    t('syncProgress_canClose', 'You can close this page. Sync carries on in the background while the browser is open, and picks up where it left off after a restart.'),
    t('syncProgress_dontStop', 'To let it finish, don’t sign out, disconnect, or change which folders sync.'),
  ];
}

/** A pause that ends by itself: the engine tripped its breaker on something that heals, and no item needs a person. */
const coolingDown = (progress: PublicSyncProgress) => progress.coolingDown === true && progress.retryAutomatic === false
  && (progress.issueCount ?? 0) === 0;

/** Why a count is not going down, in the user's words. Nothing when it is moving. */
function stallNote(progress: PublicSyncProgress, status: SyncStatus | undefined): string | undefined {
  if (coolingDown(progress)) {
    return t('syncProgress_cooling', 'Sync paused after repeated errors and tries again on its own. Open Status to see when.');
  }
  if (progress.retryAutomatic === false) {
    return t('syncProgress_stopped', 'Sync on this device has stopped. Open Status to review the problem.');
  }
  if ((progress.issueCount ?? 0) > 0) {
    return t('syncProgress_attention', 'Sync needs your attention. Open Status to see what is waiting.');
  }
  switch (status?.kind) {
    case 'paused': return t('syncProgress_paused', 'Nothing syncs until you resume. Changes you make meanwhile sync after that.');
    case 'waiting-network': return t('syncProgress_waitingNetwork', 'Waiting for the network. Sync continues when you’re back online.');
    case 'retrying': return t('syncProgress_retrying', 'The server didn’t answer. Sync retries on its own.');
    case 'action-required':
    case 'review-conflicts': return t('syncProgress_attention', 'Sync needs your attention. Open Status to see what is waiting.');
    case 'permission-required': return t('syncProgress_permission', 'Sync needs permission to read and change your bookmarks. Allow it in the Folders tab.');
    case 'stuck': return t('syncProgress_stuck', 'Sync is stuck. Open Status to see where.');
    default: break;
  }
  if (progress.stage === 'syncing' && !progress.liveWork && !progress.firstSync
      && (progress.bookmarks.synced < progress.bookmarks.total || progress.folders.synced < progress.folders.total)) {
    return t('syncProgress_notQueued', 'Some bookmarks haven’t been uploaded yet. Sync checks again on its own.');
  }
  return undefined;
}

/**
 * Sync is set up but the browser no longer lets the extension read or change
 * bookmarks: there is no count to show, so the bar says why nothing moves.
 */
export function describeMissingPermission(): SyncProgressView {
  const title = t('syncProgress_permissionTitle', 'Bookmark access needed');
  return { show: true, indeterminate: false, value: 0, done: false, paused: false, title,
    detail: t('syncProgress_permissionDetail', 'Nothing syncs while this extension can’t read or change your bookmarks.'),
    short: title, note: t('syncProgress_permission', 'Sync needs permission to read and change your bookmarks. Allow it in the Folders tab.'),
    guidance: [] };
}

export function describeSyncProgress(progress: PublicSyncProgress | null | undefined,
  status?: SyncStatus, options: { readonly showDone?: boolean } = {}): SyncProgressView {
  // Disconnected or not set up: nothing is syncing, whatever the counts say.
  if (!progress || (status && NOT_SYNCING.has(status.kind))) return HIDDEN;
  const { bookmarks, folders } = progress;
  const total = bookmarks.total + folders.total; const synced = bookmarks.synced + folders.synced;
  const paused = status?.kind === 'paused' && progress.stage !== 'done';
  const cooling = coolingDown(progress);
  const blocked = (progress.issueCount ?? 0) > 0 || progress.retryAutomatic === false
    || status?.kind === 'action-required' || status?.kind === 'review-conflicts'
    || status?.kind === 'permission-required' || status?.kind === 'stuck';
  // A pause that ends by itself is not "Action required": nobody has to do anything.
  const blockedTitle = cooling ? t('syncProgress_coolingTitle', 'Sync will retry') : t('sync_actionRequired', 'Action required');
  const pausedTitle = progress.firstSync
    ? t('syncProgress_firstPausedTitle', 'First sync paused') : t('syncProgress_pausedTitle', 'Sync paused');
  if (progress.stage === 'preparing' && paused) {
    return { show: true, indeterminate: false, value: 0, done: false, paused, title: pausedTitle,
      detail: t('syncProgress_preparingPausedDetail', 'Nothing has synced yet. After you resume, this browser’s bookmarks are compared with your library.'),
      short: t('syncProgress_pausedTitle', 'Sync paused'), note: stallNote(progress, status)!, guidance: [] };
  }
  if (progress.stage === 'preparing') {
    if (blocked) return { show: true, indeterminate: false, value: 0, done: false, paused,
      title: blockedTitle, detail: stallNote(progress, status)!, short: blockedTitle,
      note: stallNote(progress, status)!, guidance: [] };
    return { show: true, indeterminate: true, value: 0, done: false, paused,
      title: progress.firstSync ? t('syncProgress_preparingTitle', 'Preparing your first sync')
        : t('syncProgress_preparingMoreTitle', 'Preparing bookmark sync'),
      detail: t('syncProgress_preparingDetail', 'Comparing this browser’s bookmarks with your library. Large libraries take a minute.'),
      short: progress.firstSync ? t('syncProgress_preparingShort', 'Preparing first sync…')
        : t('syncProgress_preparingMoreShort', 'Preparing sync…'),
      ...(stallNote(progress, status) ? { note: stallNote(progress, status)! } : {}), guidance: blocked ? [] : guidance() };
  }
  // tn passes the raw count as $1; the formatted numbers are $2 and $3.
  const bookmarkLine = tn('syncProgress_bookmarksSynced', bookmarks.total, '$2 of $3 bookmark synced', '$2 of $3 bookmarks synced',
    count(bookmarks.synced), count(bookmarks.total));
  const folderLine = folders.total > 0
    ? tn('syncProgress_foldersSynced', folders.total, '$2 of $3 folder', '$2 of $3 folders', count(folders.synced), count(folders.total))
    : '';
  const detail = folderLine ? `${bookmarkLine} · ${folderLine}` : bookmarkLine;
  if (progress.stage === 'done' && !blocked) {
    if (!options.showDone) return HIDDEN;
    return { show: true, indeterminate: false, value: 1, done: true, paused,
      title: t('syncProgress_doneTitle', 'Sync complete'),
      detail: tn('syncProgress_doneDetail', bookmarks.total, 'Your $2 bookmark is synced.', 'All $2 bookmarks are synced.', count(bookmarks.total)),
      short: t('syncProgress_doneShort', 'Sync complete'), guidance: [] };
  }
  const note = stallNote(progress, status);
  return { show: true, indeterminate: false, value: total > 0 ? Math.min(1, synced / total) : 0, done: false, paused,
    title: blocked ? blockedTitle : paused ? pausedTitle
      : progress.firstSync ? t('syncProgress_firstTitle', 'First sync in progress') : t('syncProgress_title', 'Syncing bookmarks'),
    detail,
    short: blocked ? blockedTitle : paused ? t('syncProgress_pausedShort', 'Paused at $1 of $2', count(synced), count(total))
      : t('syncProgress_short', 'Syncing $1 of $2', count(synced), count(total)),
    // "While it runs" advice is for a sync that runs.
    ...(note ? { note } : {}), guidance: paused || blocked ? [] : guidance() };
}

/** Faster while the count moves; the slow cadence notices a new backlog (an import, another device). */
export const SYNC_PROGRESS_ACTIVE_MS = 2_000;
export const SYNC_PROGRESS_IDLE_MS = 30_000;

interface SyncProgressRead { readonly progress: PublicSyncProgress | null; readonly permissionRequired: boolean }
const NO_PROGRESS: SyncProgressRead = { progress: null, permissionRequired: false };

async function readSyncProgressState(): Promise<SyncProgressRead> {
  try {
    const response = await chrome.runtime.sendMessage({ kind: 'known.sync.progress.get' }) as SyncProgressResponse;
    return response?.ok ? { progress: response.progress, permissionRequired: response.permissionRequired === true } : NO_PROGRESS;
  } catch { return NO_PROGRESS; }
}

export async function readSyncProgress(): Promise<PublicSyncProgress | null> {
  return (await readSyncProgressState()).progress;
}

/**
 * Polls the progress read while the page is visible and paints every target.
 * A sync seen running or explicitly requested on this page ends on a "Sync
 * complete" state; a page opened after it finished shows nothing.
 */
export function watchSyncProgress(input: {
  readonly paint: (view: SyncProgressView, progress: PublicSyncProgress | null) => void;
  readonly status?: () => Promise<SyncStatus | undefined>;
  readonly enabled?: () => boolean;
}): { refresh(options?: { readonly showDone?: boolean }): Promise<void>; stop(): void } {
  let timer = 0; let turn = 0; let showCompletion = false; let stopped = false;
  async function refresh(options: { readonly showDone?: boolean } = {}): Promise<void> {
    window.clearTimeout(timer);
    if (stopped) return;
    // A confirmed folder change can finish before the next poll sees it run.
    // Its initiating page still owes the user a verified completion message.
    if (options.showDone) showCompletion = true;
    const mine = ++turn;
    const read = input.enabled && !input.enabled() ? NO_PROGRESS : await readSyncProgressState();
    const { progress } = read;
    const running = progress !== null && progress.stage !== 'done';
    const status = running && input.status ? await input.status().catch(() => undefined) : undefined;
    if (mine !== turn || stopped) return;
    if (running) showCompletion = true;
    input.paint(read.permissionRequired ? describeMissingPermission()
      : describeSyncProgress(progress, status, { showDone: showCompletion }), progress);
    if (document.visibilityState !== 'hidden') {
      timer = window.setTimeout(() => { void refresh(); }, running ? SYNC_PROGRESS_ACTIVE_MS : SYNC_PROGRESS_IDLE_MS);
    }
  }
  const onVisible = () => { if (document.visibilityState !== 'hidden') void refresh(); };
  document.addEventListener('visibilitychange', onVisible);
  void refresh();
  return {
    refresh,
    stop() { stopped = true; window.clearTimeout(timer); document.removeEventListener('visibilitychange', onVisible); },
  };
}

/** What the progress card, the popup strip and every bar show: moving only while the count can move. */
export function syncProgressState(view: SyncProgressView): 'done' | 'paused' | 'stalled' | 'running' {
  return view.done ? 'done' : view.paused ? 'paused' : view.note ? 'stalled' : 'running';
}

/** The shared bar: a track and a fill, or a sliding segment while a running sync has no count yet. */
export function paintSyncBar(bar: HTMLElement, view: SyncProgressView): void {
  const state = syncProgressState(view);
  bar.dataset.state = state === 'running' && view.indeterminate ? 'indeterminate' : state;
  bar.style.setProperty('--sync-progress', String(view.value));
  if (view.indeterminate) {
    bar.removeAttribute('aria-valuenow');
  } else {
    bar.setAttribute('aria-valuenow', String(Math.round(view.value * 100)));
  }
}
