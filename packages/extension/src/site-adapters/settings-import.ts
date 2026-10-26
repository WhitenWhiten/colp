import { formatMoment, t, tn } from '../i18n.js';
import type { SiteActivity } from './activity.js';
import { activityReference } from './activity.js';
import { paintSyncBar } from '../sync-progress-ui.js';
import { offer } from './settings-client.js';

export interface ImportStatus {
  id: string; phase: string; edgeCount: number; pages: number; omissions: number; coverage: string; reason: string | null; nextEdge: number; nextPlan: number;
  scanComplete?: boolean; omissionCounts?: Record<string, number>;
  approvalId?: string | null;
  stage?: 'collections' | 'items';
  progress?: { collectionsRead: number; collectionsTotal: number; currentCollection: string | null; prepared: number; saved: number; toSave: number };
  preview: { id: string; revision: number; digest: string; coverage: string;
    counts: { createFolders: number; createBookmarks: number; reuseBookmarks: number; review: number };
    reviewSamples?: readonly { itemId: string; collectionId: string; reason: string; itemTitle?: string; collectionTitle?: string }[];
    omissions?: { samples: readonly { id: string; reason: string }[]; unscannedRemainder: boolean } } | null;
}
interface Input {
  job: ImportStatus | null; site: string; documents: number; enabled: boolean; connected: boolean; bookmarkAccess: boolean; hold: string | null;
  config: { state: string; live: boolean } | null; available: boolean; hasDifferences: boolean; errorCopy(code: string | undefined): string;
  saved?: number; lastEvent: SiteActivity | null;
  problem?: SiteActivity | null;
}
const element = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id)! as T;
const button = (id: string) => element<HTMLButtonElement>(id);
const count = (value: number) => value.toLocaleString();

export function importTitle(job: ImportStatus | null): string {
  if (!job) return t('sites_firstSaveTitle', 'Existing items have not been saved yet');
  switch (job.phase) {
    case 'scanning': case 'preparing': return t('sites_checkingSource', 'Checking source items');
    case 'paused': return job.reason === 'scanFinished' ? t('sites_checkingSource', 'Checking source items') : t('sites_checkNotFinished', 'The source check has not finished');
    case 'preview': return !job.preview?.counts.createBookmarks && !job.preview?.counts.createFolders
      ? t('sites_nothingNew', 'Nothing new to add') : tn('sites_readyToSave', job.preview?.counts.createBookmarks ?? 0, '$1 item can be saved', '$1 items can be saved');
    case 'approved': return t('sites_savingItems', 'Saving source items');
    case 'cancelled': return t('sites_checkStopped', 'The last check was stopped');
    case 'completed': return t('sites_checkComplete', 'This check is complete');
    default: return t('sites_resultNeedsAttention', 'Some results need your attention');
  }
}

function detail(input: Input): string {
  const { job, site, errorCopy } = input, p = job?.preview, c = p?.counts;
  if (input.hold) return errorCopy(input.hold);
  if (!input.bookmarkAccess) return errorCopy('permissionRequired');
  if (input.config?.state !== 'active') return t('sites_resumeBeforeImport', 'Resume syncing in settings to continue. Bookmarks already saved are kept.');
  if (!input.enabled || !input.connected) return t('sites_reconnectSource', 'Connect this source in sync settings to continue.');
  if (!input.available && !job) return t('sites_newItemsOnly', 'This source provides new items as you browse. They are saved into the configured folders; reading all existing items is unavailable.');
  if (!job) return input.saved ? t('sites_checkSavedUpdates', 'Your saved items are listed below. Check for updates to find anything else that needs saving.')
    : t('sites_checkBeforeSaving', 'Check the selected source lists, then review what will be added. No bookmarks have been added by this check yet.');
  if (job.phase === 'scanning') return job.progress?.currentCollection
    ? t('sites_readingCollection', 'Reading “$1” · $2 favorites found', job.progress.currentCollection, count(job.edgeCount))
    : tn('sites_sourceItemsFound', job.edgeCount, '$1 item found. You can review the result before saving.', '$1 items found. You can review the result before saving.');
  if (job.phase === 'preparing' || job.phase === 'paused' && job.reason === 'scanFinished') return t('sites_reviewingReadItems', 'Comparing the $1 items read with the bookmarks already saved.', count(job.edgeCount));
  if (job.phase === 'paused') {
    if (job.reason === 'rateLimited') return t('sites_readRateLimited', '$1 asked us to slow down. Try continuing in a few minutes; favorites already read are kept.', site);
    if (['pageUnavailable', 'restartRequired', 'navigationChanged'].includes(job.reason ?? '')) return t('sites_readSourceLost', 'The website connection was lost. Continue reading to check again; saved bookmarks will not be duplicated.');
    return errorCopy(job.reason ?? undefined);
  }
  if (job.phase === 'preview') return [
    c?.createFolders ? tn('sites_listFolders', c.createFolders, '$1 new folder', '$1 new folders') : '',
    c?.reuseBookmarks ? tn('sites_listSaved', c.reuseBookmarks, '$1 already saved', '$1 already saved') : '',
    !c?.createBookmarks && !c?.createFolders ? t('sites_finishEmptyImport', 'Available favorites are already saved, or this read found only unavailable items. Finish to close this check.')
      : t('sites_reviewBeforeAdding', 'Check the list, then add the bookmarks.')
  ].filter(Boolean).join(' · ');
  if (job.phase === 'approved') return job.reason === 'sourceSyncPending'
    ? t('sites_waitingForBookmarkSyncHint', 'Your approved import is kept. It will continue when the sync connection and folder are ready.')
    : t('sites_addingInto', 'Adding them to your folder. You can leave this page.');
  if (job.phase === 'cancelled') return !p && job.nextPlan === 0
    ? t('sites_cancelledBeforeSaving', 'Reading stopped after $1 favorites were found. This import added no bookmarks. Read again when ready.', count(job.edgeCount))
    : t('sites_cancelledRestart', 'Reading and importing have stopped. Start a new check when you are ready; saved bookmarks are kept.');
  if (job.phase === 'completed') return t('sites_importSaved', '$1 bookmarks added. Existing bookmarks were kept.', count(job.progress?.saved ?? job.nextPlan));
  return job.reason === 'sourceReviewRequired'
    ? t('sites_importReviewRemaining', '$1 bookmarks added; $2 items need a separate review below.', count(job.progress?.saved ?? job.nextPlan), count(c?.review ?? 0))
    : errorCopy(job.reason ?? undefined);
}

/** One task card, using the same bar and action hierarchy as Sync › Import. */
export function paintSiteImport(input: Input) {
  const { job, config, site } = input, p = job?.preview, c = p?.counts, progress = job?.progress;
  const scanDone = job?.phase === 'paused' && job.reason === 'scanFinished';
  const scanning = job?.phase === 'scanning', preparing = job?.phase === 'preparing' || scanDone, saving = job?.phase === 'approved';
  const ready = config?.state === 'active' && input.enabled && input.connected && input.bookmarkAccess && !input.hold;
  const canRead = ready && input.available;
  const canRetrySave = ready && job?.phase === 'attention' && !!job.approvalId && job.reason !== 'sourceReviewRequired';
  const completed = job?.phase === 'completed';
  const idleWithSaved = !job && !!input.saved;
  const start = !job || ['cancelled', 'completed'].includes(job.phase), resume = job?.phase === 'paused' && !scanDone;
  const needsSource = start || resume || scanning;
  element('import-state').textContent = input.hold ? t('sites_phaseAttention', 'Needs review')
    : !input.enabled ? t('sites_websiteOff', 'Website saving is off')
    : !input.connected ? t('sites_connectAccount', 'Connect this account')
    : !input.bookmarkAccess ? t('syncProgress_permissionTitle', 'Bookmark access needed')
    : config?.state === 'disabled' ? t('sites_archivePausedTitle', 'Website saving paused') : !input.available && !job
      ? t('sites_newItemsReady', 'Ready for new source items') : idleWithSaved ? t('sites_noCheckRunning', 'No source check is running') : importTitle(job);
  const relatedProblem = input.problem && (!job || input.problem.taskRef === job.id || input.problem.taskRef === activityReference(job.id) || !!input.hold);
  element('import-summary').hidden = !!relatedProblem && !job;
  element('import-summary').textContent = relatedProblem && job ? t('sites_interruptedProgress', '$1 items read · $2 bookmarks confirmed in this check', count(job.edgeCount), count(job.nextPlan)) : detail(input);
  const current = scanning ? progress?.collectionsRead ?? 0 : preparing ? progress?.prepared ?? job?.nextEdge ?? 0 : progress?.saved ?? job?.nextPlan ?? 0;
  const total = scanning ? job.stage === 'collections' ? 0 : progress?.collectionsTotal ?? 0 : preparing ? job?.edgeCount ?? 0 : progress?.toSave ?? c?.createBookmarks ?? 0;
  const active = scanning || preparing || saving;
  const counter = element('import-count'); counter.hidden = !active || !total;
  counter.textContent = scanning ? t('sites_collectionsRead', '$1 / $2 collections read', count(current), count(total)) : t('sites_taskCount', '$1 / $2', count(current), count(total));
  const waiting = !ready || saving && job?.reason === 'sourceSyncPending' || scanning && (!input.documents || job?.reason === 'reconnectingSource');
  const bar = element('import-progress-bar');
  element('import-progress').hidden = !active;
  const title = element('import-state').textContent!;
  paintSyncBar(bar, { show: true, title, detail: '', short: title, guidance: [], done: false, paused: false,
    indeterminate: !total && !waiting, value: total ? Math.min(1, current / total) : 0, ...(waiting ? { note: title } : {}) });
  bar.setAttribute('aria-valuetext', counter.hidden ? title : counter.textContent!);
  const note = element('import-note');
  note.textContent = input.available && needsSource && !input.documents && !completed && !idleWithSaved ? t('sites_openForCheck', '$1 will open so this check can continue. Keep its tab open while items are read.', site)
    : scanning ? t('sites_readInBackground', 'Keep the website tab open. You can leave this page; the list will be ready when you return.')
    : p?.omissions?.unscannedRemainder ? t('sites_readNotFinished', 'Some collections have not been read to the end. You can add the favorites in this list first.')
    : !active && input.lastEvent ? t('sites_lastActivityAt', 'Last activity: $1', formatMoment(input.lastEvent.lastAt)) : '';
  note.hidden = !note.textContent;
  const badge = element('import-badge'); badge.hidden = !c?.review || !['preview', 'attention'].includes(job?.phase ?? '');
  if (c?.review) { badge.textContent = tn('sites_toReview', c.review, '$1 to review', '$1 to review'); badge.dataset.tone = 'warning'; }
  paintOmissions(job);
  offer(button('start-import'), canRead && start && !!input.documents);
  const hasSaved = completed || !!input.saved;
  button('start-import').textContent = hasSaved ? t('sites_checkUpdates', 'Check for updates') : t('sites_continueFirstSave', 'Continue first save');
  button('start-import').className = hasSaved ? 'btn btn-secondary btn-sm' : 'btn btn-primary btn-sm';
  offer(button('resume-import'), canRead && !!resume && !!input.documents);
  button('resume-import').textContent = t('sites_continueCheck', 'Continue checking'); button('resume-import').className = 'btn btn-primary btn-sm';
  offer(button('import-open-source'), canRead && needsSource && !input.documents);
  button('import-open-source').className = hasSaved ? 'btn btn-secondary btn-sm' : 'btn btn-primary btn-sm';
  button('import-open-source').textContent = resume || scanning ? t('sites_continueCheck', 'Continue checking') : hasSaved ? t('sites_checkUpdates', 'Check for updates') : t('sites_continueFirstSave', 'Continue first save');
  offer(button('import-edit-settings'), !ready && !input.hold);
  offer(button('import-open-recovery'), !!input.hold);
  offer(button('import-review-items'), ready && (input.hasDifferences || !!c?.review) && job?.phase === 'attention' && !canRetrySave);
  offer(button('retry-import'), !!canRetrySave);
  button('import-review-items').className = 'btn btn-primary btn-sm';
  offer(button('freeze-import'), canRead && !!job && (resume || scanning || ['preview', 'attention'].includes(job.phase)));
  button('freeze-import').textContent = scanning ? t('sites_stopAndReview', 'Stop and review') : resume ? t('sites_reviewFound', 'Review what was found') : t('sites_makeListAgain', 'Make the list again');
  offer(button('approve-import'), ready && job?.phase === 'preview' && !!p);
  button('approve-import').textContent = !c?.createBookmarks && !c?.createFolders ? t('sites_finish', 'Finish') : tn('sites_addBookmarks', c?.createBookmarks ?? 0, 'Add $1 bookmark', 'Add $1 bookmarks');
  offer(button('cancel-import'), !!job && !['cancelled', 'completed'].includes(job.phase));
  element('site-live-status').textContent = !config?.live || config.state !== 'active' ? t('sites_liveOff', 'Automatic saving of new favorites is off.')
    : !input.enabled || !input.connected || !input.bookmarkAccess || input.hold ? t('sites_liveBlocked', 'Automatic saving of new favorites waits until the connection and settings are ready.')
    : !input.documents ? t('sites_liveWaiting', 'New favorites save automatically while $1 is open.', site)
    : t('sites_liveOn', 'New favorites save automatically while you browse $1.', site);
}

function paintOmissions(job: ImportStatus | null) {
  const details = element<HTMLDetailsElement>('import-omissions'), list = element('import-omission-list');
  details.hidden = !job?.omissions;
  const counts = job?.omissionCounts ?? {};
  element('import-omissions-title').textContent = counts.failed || counts.collectionMissing || counts.unknown || !Object.keys(counts).length
    ? tn('sites_itemsNotIncluded', job?.omissions ?? 0, '$1 item not included', '$1 items not included')
    : tn('sites_skippedItems', job?.omissions ?? 0, '$1 item skipped', '$1 items skipped');
  const lines = [
    counts.invalid ? t('sites_skippedUnavailableItems', '$1 unavailable or deleted items. Other items continue normally.', count(counts.invalid)) : '',
    counts.unsupported ? t('sites_skippedUnsupported', '$1 items use a format this adapter does not support.', count(counts.unsupported)) : '',
    counts.missing ? t('sites_skippedMissing', '$1 items were not returned by the website.', count(counts.missing)) : '',
    counts.failed || counts.collectionMissing ? t('sites_skippedReadProblem', 'Some content could not be read. Continue reading or check again to retry.') : '',
    !Object.keys(counts).length || counts.unknown ? t('sites_skippedKept', 'Unavailable items are skipped. Favorites that can be read are still included.') : ''
  ].filter(Boolean);
  const key = lines.join('\n'); if (list.dataset.copy === key) return;
  list.dataset.copy = key; list.replaceChildren(...lines.map(line => { const li = document.createElement('li'); li.textContent = line; return li; }));
}
