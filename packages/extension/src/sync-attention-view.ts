import { formatMoment, localized, t, tn } from './i18n.js';
/**
 * S7 / B2 (SR-09 popup · SR-11 · SR-04/SR-13): what the Status card says about a
 * paused, recovering or terminally frozen replica, as pure functions (no DOM),
 * so the wording and the decisions behind it are testable and shared with the
 * service worker.
 *
 * Three facts drive every render, and all three are already durable:
 *   - a native wait / parked pull event (SR-09): while a wait is open the engine
 *     parks inbound Pull+Ack (`durable-sync-engine.ts` pull loop) and Push still
 *     runs first, so the popup may say "Incoming sync is paused, uploads are
 *     not affected" (inboundPauseCopy) and nothing more;
 *   - a conflict barrier (SR-11): the href is the backend's own `conflictHref`
 *     from `known.remoteDelete.policy.get` — never a hard-coded domain, and no
 *     href means no link;
 *   - a terminal freeze (SR-04/SR-13, A-10): `payload_too_large` or an unproven
 *     identity stops every future wake before any network work, so the copy must
 *     explain "Sync on this device has stopped" and offer a real exit instead
 *     of leaving the user with the bare `Needs attention` label.
 *
 * `syncAttentionTerminalCode` is the terminal predicate and lives with the
 * other readings of "has sync stopped" in `sync-stop-state.ts`, so the card,
 * the chip, the copied details and the engine cannot drift apart. Words come
 * from the problem catalog
 * (`sync-problem-catalog.ts`), so a code is described the same way on every
 * surface and a code nobody wrote words for still reads as a sentence.
 */
import { syncAttentionTerminalCode } from './sync-stop-state.js';
import { syncIssueBulk, syncIssueRows, type SyncIssueBulk, type SyncIssueRow } from './sync-issue-rows.js';
import { describeSyncProblem, problemOffersRetry } from './sync-problem-catalog.js';
import { resetBlockedCopy } from './sync-problem-copy.js';
import type {
  PublicSyncAttention, RemoteDeleteResponse, SyncAttentionTerminalCode, SyncIssueActionResponse, SyncIssueLocalAction,
} from './types.js';

export let SYNC_ATTENTION_CONFLICT_LABEL: string, SYNC_ATTENTION_CENTER_LABEL: string, SYNC_ATTENTION_COPY_DIAGNOSTICS_LABEL: string, SYNC_ATTENTION_COPIED_COPY: string, SYNC_ATTENTION_COPY_FAILED_COPY: string, SYNC_ATTENTION_FOLDERS_LABEL: string;
/** The Folders tab of this page, where bookmark access is allowed again. */
const SYNC_FOLDERS_HREF = '#sync/folders';
localized(() => {
  SYNC_ATTENTION_FOLDERS_LABEL = t('sync_openFoldersTab', 'Open Folders');
  SYNC_ATTENTION_CONFLICT_LABEL = t('firstRun_reviewConflictsSyncCenter', 'Review conflicts in Sync center on the web');
  SYNC_ATTENTION_CENTER_LABEL = t('sync_openSyncCenterWeb', 'Open Sync center on the web');
  SYNC_ATTENTION_COPY_DIAGNOSTICS_LABEL = t('common_copyDiagnostics', 'Copy diagnostics');
  SYNC_ATTENTION_COPIED_COPY = t('sync_detailsCopied', 'Details copied.');
  SYNC_ATTENTION_COPY_FAILED_COPY = t('sync_couldNotCopyDetails', 'Could not copy the details. Try again.');
});
/**
 * SR-15: the MV3 alarm floor (`Math.max(30_000, delay)` in `sw/engine.ts`) is
 * the real cadence of every freeze/park re-check, so waiting copy states the
 * lower bound; backoff and browser scheduling may make it longer.
 */
export let SYNC_MINIMUM_CYCLE_COPY: string;
localized(() => {
  SYNC_MINIMUM_CYCLE_COPY = t('sync_noMoreOftenThan30', 'no more often than every 30 seconds');
});

export interface SyncAttentionInput {
  readonly issueCount?: number;
  readonly issues?: PublicSyncAttention['issues'];
  /** Close to the point where sync stops for too many open items. */
  readonly issueCeiling?: PublicSyncAttention['issueCeiling'];
  readonly rebuildAvailable?: boolean;
  readonly rebuildUnavailableReason?: string;
  /** K3: `server_fenced` takes this browser off the server first (a change may already be there) and needs a connection. */
  readonly rebuildMode?: 'local' | 'server_fenced';
  /** K3: a Reset is needed but cannot run now (`offline`, `native_outcome_unsettled`). */
  readonly rebuildBlockedReason?: string;
  /** W2A-02: a reset that was confirmed but could not finish can be given up. */
  readonly rebuildCancelAvailable?: boolean;
  /** W2A-01: the sync database cannot be used (`lastError` says why); the rest of the facts are not a reading of it. */
  readonly storageState?: 'newer_version' | 'read_only' | 'upgrade_failed' | 'unavailable';
  readonly storageResetAvailable?: boolean;
  readonly waitCount?: number;
  readonly retryAt?: number;
  readonly retryAutomatic?: boolean;
  /** Paused after repeated errors and resumes by itself: a pause, not a stop. */
  readonly coolingDown?: boolean;
  /** Stopped or stalled: the engine looks again by itself at `retryAt`, and Retry looks now. */
  readonly stopKind?: 'stopped' | 'stalled';
  /** Times the circuit breaker has tripped without progress. */
  readonly breakerTrips?: number;
  /** Bookmark access was removed after sync was set up. */
  readonly permissionRequired?: boolean;
  /** This browser could not tell the server how it is doing, since this moment. */
  readonly healthDelivery?: { readonly code: string; readonly since: number };
  /** A stall nothing else explains (`sync-watchdog.ts`). */
  readonly watchdog?: PublicSyncAttention['watchdog'];
  /** When a pass last ended cleanly. */
  readonly lastSyncedAt?: number;
  readonly nativeWaitPending?: boolean;
  readonly remoteDeletePendingCount?: number;
  readonly phase?: string;
  readonly recoveryFrozen?: boolean;
  readonly queueProjection?: 'idle' | 'syncing' | 'conflict' | 'rejected';
  readonly conflictPending?: boolean;
  readonly rejectedPending?: boolean;
  readonly lastError?: string;
  readonly recoveryCode?: string;
  /** Backend-provided Sync Center URL. Absent means "render no link". */
  readonly conflictHref?: string;
  /** The surface shows no Reset button of its own (first-run setup); the Status tab has it. */
  readonly resetInStatus?: boolean;
}

export interface SyncAttentionLink {
  readonly show: boolean;
  readonly href?: string;
  readonly label: string;
}

export interface SyncAttentionView {
  readonly recovery: { readonly show: boolean; readonly copy: string; readonly report: string;
    /** "Retry sync" is worth offering for this state (the Sync center follows the same rule). */
    readonly retry: boolean; readonly syncCenter: SyncAttentionLink;
    /** Where bookmark access is allowed again, when that is the problem. */
    readonly folders: SyncAttentionLink };
  /** Facts worth a line of their own beside the card: the server may be looking at old news, and so on. */
  readonly notes: { readonly show: boolean; readonly lines: readonly string[] };
  /**
   * Every item that could not sync, one row each (a window of the first rows plus how many more). `bulk` names
   * every item that offers an action, window or not; `hint` says what Retry sync does not do for them.
   */
  readonly issues: { readonly show: boolean; readonly rows: readonly SyncIssueRow[]; readonly more: number;
    readonly bulk: SyncIssueBulk; readonly hint: string };
  /**
   * The Reset buttons of the card (K3). `show`: a Reset is possible from this state, and only then. `blocked`: a Reset
   * is needed and cannot run now, in words, when the card's own sentence does not already say it.
   */
  readonly reset: { readonly show: boolean; readonly mode: 'local' | 'server_fenced'; readonly cancel: boolean;
    readonly blocked?: string };
  /** The sync database cannot be used (W2A-01): the card says so instead of listing items, and may offer to reset the data. */
  readonly storage: { readonly show: boolean; readonly resetLocalData: boolean };
  readonly pause: { readonly show: boolean; readonly nativeWait: boolean;
    readonly remoteDeletePending: boolean; readonly copy: string };
  readonly conflict: SyncAttentionLink;
  readonly rejected: { readonly show: boolean; readonly copy: string };
  readonly terminal: {
    readonly show: boolean;
    readonly code?: SyncAttentionTerminalCode;
    readonly copy: string;
    readonly report: string;
    /** A frozen identity is re-checked by a wake; a state that waits for a Reset is not. */
    readonly retry: boolean;
    readonly syncCenter: SyncAttentionLink;
    readonly copyDiagnosticsLabel: string;
  };
}

export { syncAttentionTerminalCode };

export function isTerminalSyncAttention(input: SyncAttentionInput): boolean {
  return syncAttentionTerminalCode(input.lastError, input.recoveryCode) !== undefined;
}

/** SR-09: the exact blast radius of a park — inbound stops, uploads do not. */
export function inboundPauseCopy(input: SyncAttentionInput): string {
  const parts = [t('sync_inboundPausedPlain', 'Items awaiting a decision and their related changes are held. Other incoming changes and uploads continue.')];
  const waits = Math.max(0, Math.trunc(input.waitCount ?? 0));
  if (waits > 0) {
    parts.push(tn('sync_inboundWaitsPlain', waits, '$1 cloud item is waiting for your decision.', '$1 cloud items are waiting for your decision.'));
  }
  const deletions = Math.max(0, Math.trunc(input.remoteDeletePendingCount ?? 0));
  if (deletions > 0) {
    parts.push(tn('sync_inboundDeletionsPlain', deletions, '$1 cloud deletion is waiting for your decision.', '$1 cloud deletions are waiting for your decision.'));
  }
  parts.push(t('sync_inboundRecheckPlain', 'Sync checks again on its own, $1.', SYNC_MINIMUM_CYCLE_COPY));
  return parts.join(' ');
}

/** Rejected uploads are items in the list under the card, so the line points there, not at an unrelated page. */
export function rejectedWorkCopy(): string {
  return t('sync_rejectedWorkListed', 'A change could not be synced and will not retry automatically. Other items keep syncing. The items below say which.');
}

/**
 * Whether the Reset button is on the card of this state: exactly when the attention read says a Reset is possible
 * (K3: true in every stuck state, false while one is needed but blocked, and in a healthy one). One decision for the
 * words ("reset sync on this device") and for the button, so the copy never promises a control that is not there.
 */
export function resetOnCard(input: SyncAttentionInput): boolean {
  return input.rebuildAvailable === true;
}

export function terminalFreezeReasonCopy(code: SyncAttentionTerminalCode, input: SyncAttentionInput = {}): string {
  return describeSyncProblem(code, { resetOffered: resetOnCard(input),
    ...(input.resetInStatus ? { resetInStatus: true } : {}),
    ...(resetReason(input) ? { resetUnavailableReason: resetReason(input)! } : {}),
    ...(input.retryAt !== undefined ? { retryAt: input.retryAt } : {}),
    ...(input.retryAutomatic !== undefined ? { retryAutomatic: input.retryAutomatic } : {}) }).sentence;
}

/** Why a Reset that is needed is not on offer: the K3 blocked reason, else the capability's own (`rebuild_not_required`). */
function resetReason(input: SyncAttentionInput): string | undefined {
  return input.rebuildBlockedReason ?? input.rebuildUnavailableReason;
}

/** Copy the displayed structured issue snapshot even when the engine has no error. */
export function terminalFreezeReport(input: SyncAttentionInput, syncCenterHref?: string): string {
  const code = syncAttentionTerminalCode(input.lastError, input.recoveryCode);
  return [input.retryAutomatic === false || code ? 'Know-N sync diagnostics (sync on this device has stopped)'
    : 'Know-N sync diagnostics (recovery)',
  `recoveryCode: ${input.recoveryCode ?? '(not recorded)'}`,
  `lastError: ${input.lastError ?? '(not recorded)'}`,
  `issueCount: ${input.issueCount ?? input.issues?.length ?? 0}`,
  ...(input.issues ?? []).map(issue => `issue: ${JSON.stringify(issue)}`),
  `enginePhase: ${input.phase ?? '(unknown)'}`,
  `rebuildAvailable: ${input.rebuildAvailable ?? '(unknown)'}`,
  `rebuildUnavailableReason: ${input.rebuildUnavailableReason ?? '(none)'}`,
  `rebuildMode: ${input.rebuildMode ?? '(none)'}`,
  `rebuildBlockedReason: ${input.rebuildBlockedReason ?? '(none)'}`,
  ...(input.storageState ? [`storageState: ${input.storageState}`] : []),
  `automaticRetry: ${input.retryAutomatic ?? '(unknown)'}`,
  `retryAt: ${input.retryAt ?? '(not scheduled)'}`,
  `recoveryFrozen: ${input.recoveryFrozen ?? '(unknown)'}`,
  `coolingDown: ${input.coolingDown === true}`,
  `stopKind: ${input.stopKind ?? '(none)'}`,
  `breakerTrips: ${input.breakerTrips ?? 0}`,
  `bookmarkPermission: ${input.permissionRequired ? 'missing' : '(not reported missing)'}`,
  `lastSynced: ${input.lastSyncedAt ? new Date(input.lastSyncedAt).toISOString() : '(not recorded)'}`,
  `watchdog: ${input.watchdog ? `${input.watchdog.kind} since ${new Date(input.watchdog.since).toISOString()}` : '(quiet)'}`,
  `healthReports: ${input.healthDelivery
    ? `failing since ${new Date(input.healthDelivery.since).toISOString()} (${input.healthDelivery.code})` : '(not failing)'}`,
  `terminalCode: ${code ?? '(not recorded)'}`,
  ...(syncCenterHref ? [`syncCenter: ${syncCenterHref}`] : [])].join('\n');
}

/** A Sync Center link renders only when the backend handed over an http(s) URL. */
export function syncCenterHref(value: string | undefined): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.href : undefined;
  } catch { return undefined; }
}

export function describeSyncAttention(input: SyncAttentionInput): SyncAttentionView {
  const nativeWait = input.nativeWaitPending === true || Math.max(0, Math.trunc(input.waitCount ?? 0)) > 0;
  const remoteDeletePending = Math.max(0, Math.trunc(input.remoteDeletePendingCount ?? 0)) > 0;
  const code = syncAttentionTerminalCode(input.lastError, input.recoveryCode);
  const href = syncCenterHref(input.conflictHref);
  const conflict = (input.conflictPending === true || input.queueProjection === 'conflict') && href !== undefined;
  const permission = input.permissionRequired === true;
  const stalled = input.watchdog !== undefined && code === undefined;
  const storage = input.storageState !== undefined;
  const recovery = permission || stalled || storage || code === undefined && (input.recoveryFrozen === true || Boolean(input.lastError) || (input.issueCount ?? 0) > 0);
  const automatic = input.issues?.filter(issue => issue.recovery === 'automatic').length ?? 0;
  const decisions = Math.max(0, (input.issueCount ?? 0) - automatic);
  const issueCopy = [decisions ? tn('sync_itemsNeedAttention', decisions, '$1 item needs attention.', '$1 items need attention.') : '',
    automatic ? tn('sync_itemsRecoveringAutomatically', automatic, '$1 item is waiting for automatic recovery.', '$1 items are waiting for automatic recovery.') : ''].filter(Boolean).join(' ');
  // A sync database that cannot be used has no items to list: the one synthetic item is the card itself.
  const { rows, more } = storage ? { rows: [], more: 0 } : syncIssueRows(input.issues);
  const problem = recoveryProblem(input);
  // Something is off: when it last worked is the first thing a person wants to know.
  const off = recovery || code !== undefined || rows.length > 0;
  const bulk = syncIssueBulk(storage ? undefined : input.issues);
  const recoveryCopy = permission ? [describeSyncProblem('permission_required').sentence, issueCopy].filter(Boolean).join(' ')
    : storage ? storageCopy(input)
      : stalled && !input.lastError ? [watchdogCopy(input.watchdog!), issueCopy].filter(Boolean).join(' ')
        : (input.issueCount ?? 0) > 0 && !input.lastError ? issueCopy : recoveryFailureCopy(input, issueCopy);
  const terminalCopy = code ? terminalFreezeReasonCopy(code, input) : '';
  // A needed Reset that cannot run now says why, unless the card's own sentence already did.
  const blocked = input.rebuildAvailable === true ? undefined : resetBlockedCopy(input.rebuildBlockedReason);
  const blockedNote = blocked !== undefined && !`${recovery ? recoveryCopy : ''} ${terminalCopy}`.includes(blocked) ? blocked : undefined;
  const notes = [...(off && input.lastSyncedAt ? [t('sync_lastSynced', 'Last synced $1.', formatMoment(input.lastSyncedAt))] : []),
    ...(code === undefined && input.issueCeiling ? [ceilingWarningCopy(input.issueCeiling)] : []),
    ...(blockedNote ? [blockedNote] : []),
    ...(input.healthDelivery ? [healthDeliveryCopy(input.healthDelivery)] : [])];
  return {
    recovery: { show: recovery, copy: recoveryCopy,
      report: terminalFreezeReport(input, href), retry: !permission && (problem === undefined || problem.offersRetry),
      syncCenter: { show: recovery && href !== undefined && (input.issueCount ?? 0) > 0, ...(href ? { href } : {}),
        label: SYNC_ATTENTION_CENTER_LABEL },
      folders: { show: permission, href: SYNC_FOLDERS_HREF, label: SYNC_ATTENTION_FOLDERS_LABEL } },
    notes: { show: notes.length > 0, lines: notes },
    issues: { show: rows.length > 0, rows, more, bulk,
      hint: bulk.retry.length ? t('syncIssue_retryHint', 'Retry sync checks the server again. To release a held item, use Try again on it.') : '' },
    reset: { show: resetOnCard(input), mode: input.rebuildMode ?? 'local', cancel: input.rebuildCancelAvailable === true,
      ...(blocked ? { blocked } : {}) },
    storage: { show: storage, resetLocalData: storage && input.storageResetAvailable === true },
    pause: { show: nativeWait || remoteDeletePending, nativeWait, remoteDeletePending,
      copy: inboundPauseCopy(input) },
    conflict: { show: conflict, ...(conflict && href ? { href } : {}), label: SYNC_ATTENTION_CONFLICT_LABEL },
    rejected: { show: code === undefined && input.rejectedPending === true, copy: rejectedWorkCopy() },
    terminal: {
      show: code !== undefined,
      ...(code ? { code } : {}),
      copy: terminalCopy,
      report: terminalFreezeReport(input, href),
      retry: code !== undefined && problemOffersRetry(code),
      // This is only the server status link. The separate local rebuild button
      // previews and archives the old scope before re-registering the replica.
      syncCenter: { show: code !== undefined && href !== undefined,
        ...(href ? { href } : {}), label: SYNC_ATTENTION_CENTER_LABEL },
      copyDiagnosticsLabel: SYNC_ATTENTION_COPY_DIAGNOSTICS_LABEL,
    },
  };
}

/**
 * The sync database cannot be used (W2A-01): the code's own sentence, which already names the way out, and for a failure
 * that mends itself what to do if it does not.
 */
function storageCopy(input: SyncAttentionInput): string {
  const sentence = describeSyncProblem(input.lastError ?? 'storage_unavailable', problemContext(input)).sentence;
  return input.storageState === 'unavailable'
    ? `${sentence} ${t('syncProblem_nextStorageLast', 'If it keeps happening, free some disk space or reset the sync data on this device.')}` : sentence;
}

/** The watchdog's sentence, in the catalog's voice: what happened since when, what happens next, and the code. */
function watchdogCopy(watchdog: NonNullable<PublicSyncAttention['watchdog']>): string {
  const code = watchdog.kind === 'stuck' ? 'sync_stuck' : 'sync_not_completing';
  const since = formatMoment(watchdog.since);
  const what = watchdog.kind === 'no_pass' ? t('sync_watchdogNoPass', 'Sync has not finished a pass since $1, and nothing says why.', since)
    : watchdog.title ? t('sync_watchdogStuckAt', 'Sync is stuck at “$1”: this upload has not moved since $2.', watchdog.title, since)
      : t('sync_watchdogStuck', 'Sync is stuck: the oldest change waiting to upload has not moved since $1.', since);
  return [what, describeSyncProblem(code).next, `(${code})`].join(' ');
}

/** Sync stops at a fixed number of open items; a person who is near it can still clear them a press at a time. */
function ceilingWarningCopy(ceiling: { readonly open: number; readonly limit: number }): string {
  return t('syncIssue_nearCeiling', 'Sync stops when $2 items are open, and $1 are open now. Try again or dismiss some of them before it does.',
    ceiling.open, ceiling.limit);
}

/** The server's Sync center shows what this browser last managed to say, so a report that cannot be sent is news. */
function healthDeliveryCopy(delivery: { readonly code: string; readonly since: number }): string {
  return t('sync_healthNotSent', 'This browser couldn’t send its status to the server since $1 ($2). The Sync center on the web may show old information.',
    formatMoment(delivery.since), delivery.code);
}

function recoveryProblem(input: SyncAttentionInput) {
  const code = input.lastError ?? input.recoveryCode;
  return code === undefined ? undefined : describeSyncProblem(code, problemContext(input));
}

function problemContext(input: SyncAttentionInput) {
  return { resetOffered: resetOnCard(input),
    ...(resetReason(input) ? { resetUnavailableReason: resetReason(input)! } : {}),
    ...(input.retryAt !== undefined ? { retryAt: input.retryAt } : {}),
    ...(input.coolingDown ? { coolingDown: true } : {}),
    ...(input.stopKind ? { stopKind: input.stopKind } : {}),
    ...(input.retryAutomatic !== undefined ? { retryAutomatic: input.retryAutomatic } : {}) };
}

/**
 * The recovery card's sentence: the problem catalog's words for the code the
 * engine recorded, then the count of items, so a state is never "something
 * went wrong" and an item is never only a raw code.
 */
export function recoveryFailureCopy(input: SyncAttentionInput, itemCopy = ''): string {
  const code = input.lastError ?? input.recoveryCode;
  if (code === undefined) {
    // Recovering without a recorded error is ordinary: a Snapshot or a frozen page is being worked through.
    if (input.retryAutomatic === false) {
      return [t('sync_recoveryStopped', 'Sync could not finish on this device. Retry sync or copy details to investigate.'), itemCopy].filter(Boolean).join(' ');
    }
    const copy = t('sync_recoveryRetrying', 'Sync is recovering on this device. It will retry automatically.');
    return [input.retryAt && input.retryAt > Date.now()
      ? `${copy} ${t('sync_recoveryNextAttempt', 'Next attempt: $1.', formatMoment(input.retryAt, 'time'))}` : copy, itemCopy].filter(Boolean).join(' ');
  }
  return [describeSyncProblem(code, problemContext(input)).sentence, itemCopy].filter(Boolean).join(' ');
}

/** What the status says after Retry ran: whether sync still reports a problem, and which. */
export interface SyncRetryReading { readonly problem: boolean; readonly code?: string }

export function syncRetryReading(attention: PublicSyncAttention | undefined): SyncRetryReading | undefined {
  if (!attention) return undefined;
  const code = attention.lastError ?? attention.terminalCode;
  return { problem: attention.terminal || attention.retryAutomatic === false || attention.permissionRequired === true
    || Boolean(attention.lastError), ...(code ? { code } : {}) };
}

/**
 * Retry used to answer "requested" before anything ran. It now answers after the
 * pass: still going, worked, or still reporting a problem (and which).
 */
export function retryOutcomeCopy(settled: boolean, after: SyncRetryReading | undefined): string {
  if (!settled) return t('sync_retryStillRunning', 'Retry is still running. This card updates when it finishes.');
  if (!after) return t('sync_retryUnreadable', 'Retried, but the status could not be read afterwards.');
  if (!after.problem) return t('sync_retryWorked', 'Retried. Sync is running again.');
  return t('sync_retryStillFailing', 'Retried, but sync still reports a problem ($1). Copy details to investigate.', after.code ?? '?');
}

/**
 * What the card says after Try again or Dismiss: how many were done, and why the others were not. The answer
 * comes from the worker (`known.sync.issue.act`); no answer at all is said too, never read as success.
 */
export function issueActionOutcomeCopy(action: SyncIssueLocalAction, response: SyncIssueActionResponse | undefined, requested: number): string {
  if (response === undefined) return t('syncIssue_actionNoReply', 'Sync did not answer. Try again in a moment.');
  if (!response.ok) return t('syncIssue_actionError', 'Could not do that ($1). The items stay as they were.', response.error);
  const more = requested > SYNC_ISSUE_ACTION_LIMIT ? ` ${t('syncIssue_actionMore', 'More items are left. Press again for the rest.')}` : '';
  if (response.done === 0 && response.failed === 0) {
    return `${t('syncIssue_actionNothing', 'Nothing changed: the item is gone or no longer offers this.')}${more}`;
  }
  const done = response.done === 0 ? '' : action === 'retry'
    ? tn('syncIssue_actionRetried', response.done, 'Tried again. $1 item is back in the upload queue.', 'Tried again. $1 items are back in the upload queue.')
    : tn('syncIssue_actionDismissed', response.done, 'Dismissed $1 item. This browser keeps its version.', 'Dismissed $1 items. This browser keeps its versions.');
  const failed = response.failed === 0 ? ''
    // Sync is not running (a reset or a recovery is in progress, or the folders are not ready): nothing is wrong with the items.
    : response.code === 'scope_not_writable' ? t('syncIssue_actionNotReady', 'Sync is not ready to try again yet. Try again in a moment; the items stay as they were.')
      : tn('syncIssue_actionFailed', response.failed, '$1 item could not be tried again ($2). It stays as it was.',
        '$1 items could not be tried again ($2). They stay as they were.', response.code ?? 'retry_failed');
  return [done, failed, more.trim()].filter(Boolean).join(' ');
}

/** One press names at most this many items; the worker refuses a longer list. */
export const SYNC_ISSUE_ACTION_LIMIT = 250;

/** Facts from `known.sync.attention.get` plus the backend conflict href from `known.remoteDelete.policy.get`. */
export function syncAttentionInput(attention: PublicSyncAttention | undefined,
  policy: RemoteDeleteResponse | undefined): SyncAttentionInput {
  const ok = policy?.ok === true ? policy : undefined;
  return {
    issueCount: attention?.issueCount, issues: attention?.issues, ...(attention?.issueCeiling ? { issueCeiling: attention.issueCeiling } : {}), rebuildAvailable: attention?.rebuildAvailable, rebuildUnavailableReason: attention?.rebuildUnavailableReason,
    ...(attention?.rebuildMode ? { rebuildMode: attention.rebuildMode } : {}),
    ...(attention?.rebuildBlockedReason ? { rebuildBlockedReason: attention.rebuildBlockedReason } : {}),
    ...(attention?.rebuildCancelAvailable ? { rebuildCancelAvailable: true } : {}),
    ...(attention?.storageState ? { storageState: attention.storageState } : {}),
    ...(attention?.storageResetAvailable ? { storageResetAvailable: true } : {}),
    waitCount: attention?.waitCount ?? 0,
    retryAt: attention?.retryAt, retryAutomatic: attention?.retryAutomatic,
    ...(attention?.coolingDown ? { coolingDown: true } : {}),
    ...(attention?.stopKind ? { stopKind: attention.stopKind } : {}),
    ...(attention?.breakerTrips ? { breakerTrips: attention.breakerTrips } : {}),
    ...(attention?.watchdog ? { watchdog: attention.watchdog } : {}),
    ...(attention?.lastSyncedAt ? { lastSyncedAt: attention.lastSyncedAt } : {}),
    ...(attention?.permissionRequired ? { permissionRequired: true } : {}),
    ...(attention?.healthDelivery ? { healthDelivery: attention.healthDelivery } : {}),
    nativeWaitPending: attention?.nativeWaitPending === true,
    remoteDeletePendingCount: ok?.pendingCount ?? 0,
    ...(attention?.phase ? { phase: attention.phase } : {}),
    recoveryFrozen: attention?.recoveryFrozen === true,
    ...(attention?.queueProjection ? { queueProjection: attention.queueProjection } : {}),
    conflictPending: attention?.conflictPending === true || ok?.conflictPending === true,
    rejectedPending: attention?.rejectedPending === true,
    ...(attention?.lastError ? { lastError: attention.lastError } : {}),
    ...(attention?.recoveryCode ? { recoveryCode: attention.recoveryCode } : {}),
    ...(ok && syncCenterHref(ok.conflictHref) ? { conflictHref: ok.conflictHref } : {}),
  };
}

/**
 * SR-09 names `known.nativeWait.list` as the wait signal, so the popup keeps
 * that read as its fallback: a listed wait raises the pause line even when the
 * aggregate is unavailable. It can only add a wait, never clear one.
 */
export function withNativeWaitFallback(input: SyncAttentionInput, waitCount: number): SyncAttentionInput {
  if (waitCount <= 0 || input.nativeWaitPending === true || (input.waitCount ?? 0) > 0) return input;
  return { ...input, waitCount, nativeWaitPending: true };
}
