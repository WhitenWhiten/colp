import { formatMoment, localized, t, tn } from './i18n.js';
import { bindReplicaRebuildButton } from './replica-rebuild-ui.js';
/**
 * S7 / B2 (SR-09 popup · SR-11 · SR-04/SR-13): the user-facing exits around a
 * paused or terminally frozen replica.
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
 * `syncAttentionTerminalCode` is the single terminal predicate: it reuses
 * `holdsUnprovenIdentity` (the engine's own gate) so the UI and the scheduler
 * cannot drift apart. The binders are shared by popup and options; every string
 * is produced by an exported pure function so the contract is testable without
 * a DOM.
 */
import { refreshesReplicaIntegrity, holdsUnprovenIdentity, needsReplicaRebuild } from './sync-failure-class.js';
import type {
  NativeWaitResponse, PublicSyncAttention, RemoteDeleteResponse, SyncAttentionResponse, SyncAttentionTerminalCode,
} from './types.js';

export const SYNC_ATTENTION_OPTIONS_HOST = 'sync-attention-settings';
export let SYNC_ATTENTION_CONFLICT_LABEL: string, SYNC_ATTENTION_CENTER_LABEL: string, SYNC_ATTENTION_COPY_DIAGNOSTICS_LABEL: string, SYNC_ATTENTION_COPIED_COPY: string, SYNC_ATTENTION_COPY_FAILED_COPY: string;
localized(() => {
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

const REFRESH_MS = 8_000;

export interface SyncAttentionInput {
  readonly issueCount?: number;
  readonly issues?: PublicSyncAttention['issues'];
  readonly rebuildAvailable?: boolean;
  readonly waitCount?: number;
  readonly retryAt?: number;
  readonly retryAutomatic?: boolean;
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
}

export interface SyncAttentionLink {
  readonly show: boolean;
  readonly href?: string;
  readonly label: string;
}

export interface SyncAttentionView {
  readonly recovery: { readonly show: boolean; readonly copy: string; readonly report: string };
  readonly pause: { readonly show: boolean; readonly nativeWait: boolean;
    readonly remoteDeletePending: boolean; readonly copy: string };
  readonly conflict: SyncAttentionLink;
  readonly rejected: { readonly show: boolean; readonly copy: string };
  readonly terminal: {
    readonly show: boolean;
    readonly code?: SyncAttentionTerminalCode;
    readonly copy: string;
    readonly report: string;
    readonly syncCenter: SyncAttentionLink;
    readonly copyDiagnosticsLabel: string;
  };
}

/**
 * The engine's terminal gate is `recoveryFrozen && (holdsUnprovenIdentity ||
 * lastError === 'payload_too_large')`; `freezeScopeRecovery` records the same
 * code as `scope.metadata.recoveryCode`. Checking both fields means a freeze
 * stays visible even if only one of the two rows survived.
 */
export function syncAttentionTerminalCode(lastError: string | undefined,
  recoveryCode: string | undefined): SyncAttentionTerminalCode | undefined {
  for (const code of [recoveryCode, lastError]) {
    if (code === 'payload_too_large' || code === 'replica_rebuild_pending') return code;
    if (needsReplicaRebuild(code)) return code as SyncAttentionTerminalCode;
    if (holdsUnprovenIdentity(code)) return code as SyncAttentionTerminalCode;
  }
  return undefined;
}

export function isTerminalSyncAttention(input: SyncAttentionInput): boolean {
  return syncAttentionTerminalCode(input.lastError, input.recoveryCode) !== undefined;
}

/** SR-09: the exact blast radius of a park — inbound stops, uploads do not. */
export function inboundPauseCopy(input: SyncAttentionInput): string {
  const parts = [t('sync_inboundPausedPlain', 'Incoming sync from Know-N is paused. Uploads from this device are not affected.')];
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

export function rejectedWorkCopy(): string {
  return t('sync_syncOperationRejectedServer', 'A change could not be synced and will not retry automatically. Other items will keep syncing. Open Not included in sync for details.');
}

export function terminalFreezeReasonCopy(code: SyncAttentionTerminalCode): string {
  if (code === 'metadata_sync_disabled') {
    return t('sync_metadataConsentStopped', 'A queued change contains browser metadata that you have not allowed to sync. Reset sync on this device to set aside queued changes and review the merge again. Your bookmarks and local metadata are preserved.');
  }
  if (code === 'create_placement_parent_deleted' || code === 'create_placement_unproven') {
    return t('sync_syncDeviceHasStopped', 'Sync on this device has stopped: the saved bookmark’s original folder or position cannot be confirmed. Its save location needs review.');
  }
  if (code === 'legacy_resolution_sequence_collision' || code === 'mapping_identity_collision') {
    return t('sync_syncDeviceStoppedBecause', 'Sync on this device stopped because of an internal mismatch. Your bookmarks are safe. Reset sync on this device to continue.');
  }
  if (code === 'replica_rebuild_pending') {
    return t('sync_syncResetIsntFinished', "The sync reset isn't finished. Your bookmarks are safe. Try again to finish it.");
  }
  if (code === 'payload_too_large') {
    return t('sync_syncDeviceHasStopped2', 'Sync on this device has stopped: the transfer size exceeds supported limits. Retrying will not change the result.');
  }
  if (code === 'pull_issue_ceiling' || code === 'sync_issue_ceiling') {
    return t('sync_tooManyItemsSetAside', 'Sync on this device has stopped: it set aside too many items to keep syncing safely. Your bookmarks in Know-N are safe. Reset sync on this device to continue.');
  }
  if (needsReplicaRebuild(code)) {
    return t('sync_syncDeviceHasStopped3', 'Sync on this device has stopped because some bookmarks on this device are missing. Your bookmarks in Know-N are safe. Reset sync on this device to continue.');
  }
  if (code === 'deletion_identity_unproven') {
    return t('sync_syncDeviceHasStopped4', 'Sync on this device has stopped: this device cannot verify the bookmark to delete matches the cloud item.');
  }
  return t('sync_syncDeviceHasStopped5', 'Sync on this device has stopped: this device cannot verify local bookmarks match cloud items.');
}

/**
 * Clipboard payload. It carries exactly the two durable codes plus the phase:
 * those are what a Sync Center rebuild needs, and nothing here is a native id
 * or a bookmark title.
 */
export function terminalFreezeReport(input: SyncAttentionInput, syncCenterHref?: string): string {
  const code = syncAttentionTerminalCode(input.lastError, input.recoveryCode);
  return [input.retryAutomatic === false || code ? 'Know-N sync diagnostics (sync on this device has stopped)'
    : 'Know-N sync diagnostics (recovery)',
    `recoveryCode: ${input.recoveryCode ?? '(not recorded)'}`,
    `lastError: ${input.lastError ?? '(not recorded)'}`,
    `enginePhase: ${input.phase ?? '(unknown)'}`,
    `automaticRetry: ${input.retryAutomatic ?? '(unknown)'}`,
    `retryAt: ${input.retryAt ?? '(not scheduled)'}`,
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
  const recovery = code === undefined && (input.recoveryFrozen === true || Boolean(input.lastError) || (input.issueCount ?? 0) > 0);
  return {
    recovery: { show: recovery, copy: (input.issueCount ?? 0) > 0 ?
      `${tn('sync_itemsNeedAttention', input.issueCount!, '$1 item needs attention.', '$1 items need attention.')} ${input.issues?.map(issue => [issue.title, issue.code].filter(Boolean).join(': ')).join('; ') ?? ''}` : recoveryFailureCopy(input), report: terminalFreezeReport(input, href) },
    pause: { show: nativeWait || remoteDeletePending, nativeWait, remoteDeletePending,
      copy: inboundPauseCopy(input) },
    conflict: { show: conflict, ...(conflict && href ? { href } : {}), label: SYNC_ATTENTION_CONFLICT_LABEL },
    rejected: { show: code === undefined && input.rejectedPending === true, copy: rejectedWorkCopy() },
    terminal: {
      show: code !== undefined,
      ...(code ? { code } : {}),
      copy: code ? terminalFreezeReasonCopy(code) : '',
      report: terminalFreezeReport(input, href),
      // This is only the server status link. The separate local rebuild button
      // previews and archives the old scope before re-registering the replica.
      syncCenter: { show: code !== undefined && href !== undefined,
        ...(href ? { href } : {}), label: SYNC_ATTENTION_CENTER_LABEL },
      copyDiagnosticsLabel: SYNC_ATTENTION_COPY_DIAGNOSTICS_LABEL,
    },
  };
}

export function recoveryFailureCopy(input: SyncAttentionInput): string {
  if (input.retryAutomatic === false) {
    const copy = t('sync_recoveryStopped', 'Sync could not finish on this device. Retry sync or copy details to investigate.');
    const code = input.lastError ?? input.recoveryCode;
    return refreshesReplicaIntegrity(code) ? `${copy} (${code})` : copy;
  }
  const copy = t('sync_recoveryRetrying', 'Sync is recovering on this device. It will retry automatically.');
  return input.retryAt && input.retryAt > Date.now()
    ? `${copy} ${t('sync_recoveryNextAttempt', 'Next attempt: $1.', formatMoment(input.retryAt, 'time'))}` : copy;
}

/** Facts from `known.sync.attention.get` plus the backend conflict href from `known.remoteDelete.policy.get`. */
export function syncAttentionInput(attention: PublicSyncAttention | undefined,
  policy: RemoteDeleteResponse | undefined): SyncAttentionInput {
  const ok = policy?.ok === true ? policy : undefined;
  return {
    issueCount: attention?.issueCount, issues: attention?.issues, rebuildAvailable: attention?.rebuildAvailable,
    waitCount: attention?.waitCount ?? 0,
    retryAt: attention?.retryAt, retryAutomatic: attention?.retryAutomatic,
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

interface AttentionNodes {
  readonly host: HTMLElement;
  readonly pause: HTMLElement | null;
  readonly conflict: HTMLElement | null;
  readonly conflictLink: HTMLAnchorElement | null;
  readonly rejected: HTMLElement | null;
  readonly terminal: HTMLElement | null;
  readonly recovery: HTMLElement | null;
  readonly recoveryCopy: HTMLElement | null;
  readonly retry: HTMLButtonElement | null;
  readonly recoveryDiagnostics: HTMLButtonElement | null;
  readonly terminalCopy: HTMLElement | null;
  readonly syncCenter: HTMLAnchorElement | null;
  readonly copyDiagnostics: HTMLButtonElement | null;
  readonly feedback: HTMLElement | null;
}

/** Options binder: `#sync-attention-settings` inside the Sync center pane. */
export function bindSyncAttentionSettings(): void {
  bindSyncAttention(SYNC_ATTENTION_OPTIONS_HOST, true);
}

function bindSyncAttention(hostId: string, syncPaneOnly: boolean): void {
  const host = document.getElementById(hostId);
  if (!host) return;
  bindReplicaRebuildButton(hostId);
  const nodes: AttentionNodes = {
    host,
    pause: document.getElementById(`${hostId}-pause`),
    conflict: document.getElementById(`${hostId}-conflict`),
    conflictLink: document.getElementById(`${hostId}-conflict-link`) as HTMLAnchorElement | null,
    rejected: document.getElementById(`${hostId}-rejected`),
    terminal: document.getElementById(`${hostId}-terminal`),
    recovery: document.getElementById(`${hostId}-recovery`),
    recoveryCopy: document.getElementById(`${hostId}-recovery-copy`),
    retry: document.getElementById(`${hostId}-retry`) as HTMLButtonElement | null,
    recoveryDiagnostics: document.getElementById(`${hostId}-recovery-diagnostics`) as HTMLButtonElement | null,
    terminalCopy: document.getElementById(`${hostId}-terminal-copy`),
    syncCenter: document.getElementById(`${hostId}-sync-center`) as HTMLAnchorElement | null,
    copyDiagnostics: document.getElementById(`${hostId}-copy-diagnostics`) as HTMLButtonElement | null,
    feedback: document.getElementById(`${hostId}-feedback`),
  };
  let report = '';
  nodes.recoveryDiagnostics?.addEventListener('click', () => { void copyDiagnostics(nodes, report); });
  nodes.retry?.addEventListener('click', () => {
    if (!nodes.retry) return;
    nodes.retry.disabled = true;
    void send<{ readonly ok: boolean }>({ kind: 'known.sync.engine.retry' }).then(result => {
      showFeedback(nodes.feedback, result?.ok
        ? t('sync_recoveryRetryRequested', 'Sync retry requested.')
        : t('sync_recoveryRetryFailed', 'Could not retry sync. Copy details to investigate.'));
    }).finally(() => { if (nodes.retry) nodes.retry.disabled = false; });
  });
  if (nodes.syncCenter) nodes.syncCenter.textContent = SYNC_ATTENTION_CENTER_LABEL;
  if (nodes.copyDiagnostics) {
    if (nodes.copyDiagnostics.dataset.keepLabel === undefined) nodes.copyDiagnostics.textContent = SYNC_ATTENTION_COPY_DIAGNOSTICS_LABEL;
    nodes.copyDiagnostics.addEventListener('click', () => { void copyDiagnostics(nodes, report); });
  }

  const refresh = async (): Promise<void> => {
    const [attention, policy] = await Promise.all([readAttention(), readRemoteDeletePolicy()]);
    const facts = syncAttentionInput(attention, policy);
    const view = describeSyncAttention(attention
      ? facts : withNativeWaitFallback(facts, await readNativeWaitCount()));
    report = view.terminal.show ? view.terminal.report : view.recovery.report;
    paintSyncAttention(nodes, view);
    let repair = document.getElementById(`${hostId}-issue-repair`);
    if (!repair) {
      repair = document.createElement('div'); repair.id = `${hostId}-issue-repair`;
      const button = document.createElement('button'); button.type = 'button'; button.className = 'btn btn-danger-ghost btn-sm';
      button.id = `${repair.id}-rebuild`;
      const feedback = document.createElement('p'); feedback.id = `${repair.id}-feedback`; feedback.hidden = true;
      repair.append(button, feedback); nodes.host.append(repair); bindReplicaRebuildButton(repair.id);
    }
    repair.hidden = attention?.rebuildAvailable !== true || attention.recoveryFrozen === true;
  };
  void refresh();
  setInterval(() => {
    if (!syncPaneOnly || document.body.dataset.pane === 'sync') void refresh();
  }, REFRESH_MS);
  if (!syncPaneOnly) {
    // The popup starts before auth settles: re-read once the panel becomes usable.
    new MutationObserver(() => { void refresh(); })
      .observe(document.body, { attributes: true, attributeFilter: ['data-state'] });
  }
}

function paintSyncAttention(nodes: AttentionNodes, view: SyncAttentionView): void {
  // The card is only as tall as what it can show: a line this page has no node for does not hold it open.
  nodes.host.hidden = !((view.pause.show && nodes.pause) || (view.rejected.show && nodes.rejected)
    || (view.conflict.show && nodes.conflict) || (view.terminal.show && nodes.terminal)
    || (view.recovery.show && nodes.recovery));
  if (nodes.recovery) nodes.recovery.hidden = !view.recovery.show;
  setLine(nodes.recoveryCopy, view.recovery.show, view.recovery.copy);
  setLine(nodes.pause, view.pause.show, view.pause.copy);
  setLine(nodes.rejected, view.rejected.show, view.rejected.copy);
  if (nodes.conflict) nodes.conflict.hidden = !view.conflict.show;
  if (view.conflict.show && view.conflict.href && nodes.conflictLink) {
    nodes.conflictLink.href = view.conflict.href;
    nodes.conflictLink.textContent = view.conflict.label;
  }
  if (nodes.terminal) nodes.terminal.hidden = !view.terminal.show;
  if (nodes.terminalCopy) nodes.terminalCopy.textContent = view.terminal.show ? view.terminal.copy : '';
  if (nodes.syncCenter) {
    nodes.syncCenter.hidden = !view.terminal.syncCenter.show;
    if (view.terminal.syncCenter.show && view.terminal.syncCenter.href) {
      nodes.syncCenter.href = view.terminal.syncCenter.href;
    } else nodes.syncCenter.removeAttribute('href');
  }
  if (nodes.feedback) nodes.feedback.hidden = !view.terminal.show && !view.recovery.show;
  // SR-09: a listed wait keeps the SR-01 deep link reachable. Revealing can only
  // help — the popup's own reflectNativeWaitLink never hides a pending wait.
  if (view.pause.show && view.pause.nativeWait) {
    const link = document.getElementById('open-native-wait');
    if (link) link.hidden = false;
  }
}

async function copyDiagnostics(nodes: AttentionNodes, report: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(report);
    showFeedback(nodes.feedback, SYNC_ATTENTION_COPIED_COPY);
  } catch { showFeedback(nodes.feedback, SYNC_ATTENTION_COPY_FAILED_COPY); }
}

function setLine(node: HTMLElement | null, show: boolean, copy: string): void {
  if (!node) return;
  node.hidden = !show;
  if (show) node.textContent = copy;
}

function showFeedback(node: HTMLElement | null, text: string): void {
  if (!node) return;
  node.hidden = false;
  node.textContent = text;
}

async function readAttention(): Promise<PublicSyncAttention | undefined> {
  const response = await send<SyncAttentionResponse>({ kind: 'known.sync.attention.get' });
  return response?.ok === true ? response.attention : undefined;
}

/** SR-09's own signal, used only when the aggregate is unavailable. */
async function readNativeWaitCount(): Promise<number> {
  const response = await send<NativeWaitResponse>({ kind: 'known.nativeWait.list' });
  return response?.ok === true && 'waits' in response ? response.waits.length : 0;
}

async function readRemoteDeletePolicy(): Promise<RemoteDeleteResponse | undefined> {
  return await send<RemoteDeleteResponse>({ kind: 'known.remoteDelete.policy.get' });
}

/** Bounded like `remote-delete-ui.ts`: a sleeping worker never leaves the panel blank forever. */
async function send<T>(message: { readonly kind: string }): Promise<T | undefined> {
  try {
    const pending = chrome.runtime.sendMessage(message) as Promise<T>;
    const timeout = new Promise<undefined>((resolve) => { setTimeout(() => resolve(undefined), 8_000); });
    return await Promise.race([pending, timeout]);
  } catch { return undefined; }
}
