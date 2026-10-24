import { t } from './i18n.js';
import { createIcon } from './icons.js';
import { button, el } from './library-dom.js';
import { bindReplicaRebuildButton } from './replica-rebuild-ui.js';
import {
  SYNC_ATTENTION_CENTER_LABEL, SYNC_ATTENTION_COPIED_COPY, SYNC_ATTENTION_COPY_DIAGNOSTICS_LABEL, SYNC_ATTENTION_COPY_FAILED_COPY,
  SYNC_ATTENTION_FOLDERS_LABEL, SYNC_ISSUE_ACTION_LIMIT, describeSyncAttention, issueActionOutcomeCopy, retryOutcomeCopy, syncAttentionInput,
  syncRetryReading, withNativeWaitFallback, type SyncAttentionView,
} from './sync-attention-view.js';
import type { SyncIssueRow } from './sync-issue-rows.js';
import type {
  NativeWaitResponse, PublicSyncAttention, RemoteDeleteResponse, SyncAttentionResponse, SyncIssueActionRequest, SyncIssueActionResponse,
  SyncIssueLocalAction, SyncRetryResponse,
} from './types.js';

/**
 * The binder for the Status card (options) and its popup twin. Everything it
 * says comes from `sync-attention-view.ts` (pure, tested without a DOM); this
 * file only reads the facts, paints them and wires the buttons. The pure API is
 * re-exported so importers keep one module to read.
 */
export * from './sync-attention-view.js';

export const SYNC_ATTENTION_OPTIONS_HOST = 'sync-attention-settings';

const REFRESH_MS = 8_000;
/** Retry answers after its pass (up to 20 s in the worker), so its reply is waited for longer than a read. */
const RETRY_REPLY_MS = 24_000;

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
  readonly terminalRetry: HTMLButtonElement | null;
  readonly recoveryDiagnostics: HTMLButtonElement | null;
  readonly recoverySyncCenter: HTMLAnchorElement | null;
  readonly recoveryFolders: HTMLAnchorElement | null;
  readonly unreadable: HTMLElement | null;
  readonly notes: HTMLElement | null;
  readonly issues: HTMLElement | null;
  readonly issuesMore: HTMLElement | null;
  readonly issuesHint: HTMLElement | null;
  readonly issuesBulk: HTMLElement | null;
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
    terminalRetry: document.getElementById(`${hostId}-terminal-retry`) as HTMLButtonElement | null,
    recoveryDiagnostics: document.getElementById(`${hostId}-recovery-diagnostics`) as HTMLButtonElement | null,
    recoverySyncCenter: document.getElementById(`${hostId}-recovery-sync-center`) as HTMLAnchorElement | null,
    recoveryFolders: document.getElementById(`${hostId}-recovery-folders`) as HTMLAnchorElement | null,
    unreadable: document.getElementById(`${hostId}-unreadable`),
    notes: document.getElementById(`${hostId}-notes`),
    issues: document.getElementById(`${hostId}-issues`),
    issuesMore: document.getElementById(`${hostId}-issues-more`),
    issuesHint: document.getElementById(`${hostId}-issues-hint`),
    issuesBulk: document.getElementById(`${hostId}-issues-bulk`),
    terminalCopy: document.getElementById(`${hostId}-terminal-copy`),
    syncCenter: document.getElementById(`${hostId}-sync-center`) as HTMLAnchorElement | null,
    copyDiagnostics: document.getElementById(`${hostId}-copy-diagnostics`) as HTMLButtonElement | null,
    feedback: document.getElementById(`${hostId}-feedback`),
  };
  let report = '';
  nodes.recoveryDiagnostics?.addEventListener('click', () => { void copyDiagnostics(nodes, report); });
  for (const button of [nodes.retry, nodes.terminalRetry]) {
    button?.addEventListener('click', () => {
      button.disabled = true;
      showFeedback(nodes.feedback, t('sync_retryRunning', 'Retrying sync…'));
      void retrySync(nodes).finally(() => { button.disabled = false; });
    });
  }
  /** Retry answers after its pass; the status is read again, so the card says whether anything changed. */
  async function retrySync(target: AttentionNodes): Promise<void> {
    const result = await send<SyncRetryResponse>({ kind: 'known.sync.engine.retry' }, RETRY_REPLY_MS);
    if (!result?.ok) {
      showFeedback(target.feedback, t('sync_recoveryRetryFailed', 'Could not retry sync. Copy details to investigate.')
        + (result?.ok === false ? ` (${result.error})` : ''));
      return;
    }
    showFeedback(target.feedback, retryOutcomeCopy(result.settled, syncRetryReading(await refresh())));
  }
  /** Try again or Dismiss on named items; the card is read again, then says what happened. */
  async function actOnIssues(action: SyncIssueLocalAction, ids: readonly string[]): Promise<void> {
    showFeedback(nodes.feedback, t('syncIssue_actionWorking', 'Working…'));
    const request: SyncIssueActionRequest = { kind: 'known.sync.issue.act', action, issueIds: ids.slice(0, SYNC_ISSUE_ACTION_LIMIT) };
    const result = await send<SyncIssueActionResponse>(request, RETRY_REPLY_MS);
    await refresh();
    showFeedback(nodes.feedback, issueActionOutcomeCopy(action, result, ids.length));
  }
  if (nodes.syncCenter) nodes.syncCenter.textContent = SYNC_ATTENTION_CENTER_LABEL;
  if (nodes.recoverySyncCenter) nodes.recoverySyncCenter.textContent = SYNC_ATTENTION_CENTER_LABEL;
  if (nodes.recoveryFolders) nodes.recoveryFolders.textContent = SYNC_ATTENTION_FOLDERS_LABEL;
  if (nodes.copyDiagnostics) {
    if (nodes.copyDiagnostics.dataset.keepLabel === undefined) nodes.copyDiagnostics.textContent = SYNC_ATTENTION_COPY_DIAGNOSTICS_LABEL;
    nodes.copyDiagnostics.addEventListener('click', () => { void copyDiagnostics(nodes, report); });
  }

  let painted = false;
  /** Reads, paints, and returns what was read (`undefined`: it could not be read). */
  const refresh = async (): Promise<PublicSyncAttention | undefined> => {
    const [read, policy] = await Promise.all([readAttention(), readRemoteDeletePolicy()]);
    const { attention } = read;
    // A read that fails is not an empty card: keep what the last good reading showed, and say it may be out of date.
    if (attention === undefined && read.error !== 'not_connected') { paintUnreadable(nodes, read.error ?? 'status_unreachable', painted); return undefined; }
    paintUnreadable(nodes, undefined, painted);
    painted = true;
    const facts = syncAttentionInput(attention, policy);
    const view = describeSyncAttention(attention
      ? facts : withNativeWaitFallback(facts, await readNativeWaitCount()));
    report = view.terminal.show ? view.terminal.report : view.recovery.report;
    paintSyncAttention(nodes, view, actOnIssues);
    const terminalRepair = document.getElementById(`${hostId}-rebuild`);
    if (terminalRepair) terminalRepair.hidden = attention?.rebuildAvailable !== true;
    let repair = document.getElementById(`${hostId}-issue-repair`);
    if (!repair) {
      repair = document.createElement('div'); repair.id = `${hostId}-issue-repair`;
      const button = document.createElement('button'); button.type = 'button'; button.className = 'btn btn-danger-ghost btn-sm';
      button.id = `${repair.id}-rebuild`;
      const feedback = document.createElement('p'); feedback.id = `${repair.id}-feedback`; feedback.hidden = true;
      repair.append(button, feedback); nodes.host.append(repair); bindReplicaRebuildButton(repair.id);
    }
    repair.hidden = attention?.rebuildAvailable !== true || attention.recoveryFrozen === true;
    return attention;
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

type IssueAct = (action: SyncIssueLocalAction, ids: readonly string[]) => Promise<void>;

function paintSyncAttention(nodes: AttentionNodes, view: SyncAttentionView, act: IssueAct): void {
  // The card is only as tall as what it can show: a line this page has no node for does not hold it open.
  nodes.host.hidden = !((view.pause.show && nodes.pause) || (view.rejected.show && nodes.rejected)
    || (view.conflict.show && nodes.conflict) || (view.terminal.show && nodes.terminal)
    || (view.recovery.show && nodes.recovery) || (view.issues.show && nodes.issues) || (view.notes.show && nodes.notes));
  if (nodes.recovery) nodes.recovery.hidden = !view.recovery.show;
  setLine(nodes.recoveryCopy, view.recovery.show, view.recovery.copy);
  if (nodes.retry) nodes.retry.hidden = !view.recovery.retry;
  paintLink(nodes.recoverySyncCenter, view.recovery.syncCenter);
  paintLink(nodes.recoveryFolders, view.recovery.folders);
  paintIssues(nodes, view, act);
  paintNotes(nodes, view);
  setLine(nodes.pause, view.pause.show, view.pause.copy);
  setLine(nodes.rejected, view.rejected.show, view.rejected.copy);
  if (nodes.conflict) nodes.conflict.hidden = !view.conflict.show;
  if (view.conflict.show && view.conflict.href && nodes.conflictLink) {
    nodes.conflictLink.href = view.conflict.href;
    nodes.conflictLink.textContent = view.conflict.label;
  }
  if (nodes.terminal) nodes.terminal.hidden = !view.terminal.show;
  if (nodes.terminalRetry) nodes.terminalRetry.hidden = !view.terminal.retry;
  if (nodes.terminalCopy) nodes.terminalCopy.textContent = view.terminal.show ? view.terminal.copy : '';
  paintLink(nodes.syncCenter, view.terminal.syncCenter);
  if (nodes.feedback) nodes.feedback.hidden = !view.terminal.show && !view.recovery.show;
  // SR-09: a listed wait keeps the SR-01 deep link reachable. Revealing can only
  // help — the popup's own reflectNativeWaitLink never hides a pending wait.
  if (view.pause.show && view.pause.nativeWait) {
    const link = document.getElementById('open-native-wait');
    if (link) link.hidden = false;
  }
}

/** The status could not be read: say so beside whatever was last read, instead of blanking the card. */
function paintUnreadable(nodes: AttentionNodes, code: string | undefined, kept = false): void {
  if (!nodes.unreadable) return;
  nodes.unreadable.hidden = code === undefined;
  if (code === undefined) return;
  nodes.unreadable.textContent = kept
    ? t('sync_statusUnreadable', 'Couldn’t read sync status ($1). What is shown may be out of date.', code)
    : t('sync_statusUnreadableFirst', 'Couldn’t read sync status ($1). Try again in a moment.', code);
  nodes.host.hidden = false;
}

function paintLink(node: HTMLAnchorElement | null, link: { readonly show: boolean; readonly href?: string }): void {
  if (!node) return;
  node.hidden = !link.show;
  if (link.show && link.href) node.href = link.href; else node.removeAttribute('href');
}

/** Lines beside the card that are not about one item: what the server may not know, and so on. */
function paintNotes(nodes: AttentionNodes, view: SyncAttentionView): void {
  if (!nodes.notes) return;
  nodes.notes.hidden = !view.notes.show;
  nodes.notes.replaceChildren(...view.notes.lines.map(line => el('p', line, 'set-row-hint')));
}

/** One row per item that could not sync: its name, why, and what can be done about it. */
function paintIssues(nodes: AttentionNodes, view: SyncAttentionView, act: IssueAct): void {
  if (!nodes.issues) return;
  nodes.issues.hidden = !view.issues.show;
  nodes.issues.replaceChildren(...view.issues.rows.map(row => renderIssueRow(row, act)));
  if (nodes.issuesHint) {
    nodes.issuesHint.hidden = !view.issues.show || view.issues.hint === '';
    nodes.issuesHint.textContent = view.issues.hint;
  }
  if (nodes.issuesMore) {
    nodes.issuesMore.hidden = view.issues.more === 0;
    nodes.issuesMore.textContent = view.issues.more === 0 ? ''
      : t('syncIssue_more', 'and $1 more. Copy details lists all of them.', view.issues.more);
  }
  paintBulk(nodes, view, act);
}

/** What the bulk buttons were built for: the same items keep the same buttons, so a half-made choice survives a refresh. */
const bulkSignature = new WeakMap<HTMLElement, string>();

/** Every item of a kind at once, for the flood the window cannot show: Try again for all, or Dismiss all after a second press. */
function paintBulk(nodes: AttentionNodes, view: SyncAttentionView, act: IssueAct): void {
  const host = nodes.issuesBulk;
  if (!host) return;
  const { retry, dismiss } = view.issues.bulk;
  host.hidden = !view.issues.show || retry.length < 2 && dismiss.length < 2;
  const signature = `${retry.join(',')}|${dismiss.join(',')}`;
  if (bulkSignature.get(host) === signature) return;
  bulkSignature.set(host, signature);
  const buttons: HTMLElement[] = [];
  if (retry.length >= 2) {
    buttons.push(actionButton(t('syncIssue_retryAll', 'Try again for all $1', retry.length), 'btn btn-secondary btn-sm', 'retry',
      () => act('retry', retry)));
  }
  if (dismiss.length >= 2) {
    // Many items at once: the first press asks, the second does it.
    buttons.push(actionButton(t('syncIssue_dismissAll', 'Dismiss all $1', dismiss.length), 'btn btn-ghost btn-sm', 'dismiss',
      () => act('dismiss', dismiss), t('syncIssue_dismissAllConfirm', 'Dismiss all $1? This browser keeps its versions.', dismiss.length)));
  }
  host.replaceChildren(...buttons);
}

/**
 * A button that does one thing to named items. With a `question`, the first press only asks it (the label becomes
 * the question) and the second does it; a pause puts the label back.
 */
function actionButton(label: string, className: string, action: SyncIssueLocalAction, run: () => Promise<void>,
  question?: string): HTMLButtonElement {
  const node = button(label, className);
  node.dataset.syncIssueAction = action;
  let timer: ReturnType<typeof setTimeout> | undefined;
  node.addEventListener('click', () => {
    if (question !== undefined && node.dataset.armed !== 'true') {
      node.dataset.armed = 'true'; node.textContent = question;
      timer = setTimeout(() => { delete node.dataset.armed; node.textContent = label; }, 6_000);
      return;
    }
    if (timer) clearTimeout(timer);
    delete node.dataset.armed; node.textContent = label; node.disabled = true;
    void run().finally(() => { node.disabled = false; });
  });
  return node;
}

function renderIssueRow(row: SyncIssueRow, act: IssueAct): HTMLElement {
  const item = el('li', undefined, 'set-row sync-issue-item');
  item.dataset.syncIssue = row.key; item.dataset.code = row.code;
  const tile = el('span', undefined, 'favicon-tile'); tile.append(createIcon('bookmark', 16));
  const text = el('div', undefined, 'set-row-text');
  const hint = el('p', `${row.directionLabel} · ${row.summary}`, 'set-row-hint');
  hint.title = row.code;
  text.append(el('p', row.title, 'set-row-title sync-issue-title'), hint);
  if (row.seen) text.append(el('p', row.seen, 'set-row-hint'));
  item.append(tile, text);
  if (row.issueId && row.actions.length) {
    const id = row.issueId;
    const control = el('div', undefined, 'set-row-control');
    for (const action of row.actions) {
      const node = actionButton(action === 'retry' ? t('syncIssue_tryAgain', 'Try again') : t('common_dismiss', 'Dismiss'),
        action === 'retry' ? 'btn btn-secondary btn-sm' : 'btn btn-ghost btn-sm', action, () => act(action, [id]));
      if (action === 'dismiss') node.title = t('syncIssue_dismissTitle', 'Closes this item and keeps this browser’s version. Nothing is deleted.');
      control.append(node);
    }
    item.append(control);
  }
  return item;
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

async function readAttention(): Promise<{ readonly attention?: PublicSyncAttention; readonly error?: string }> {
  const response = await send<SyncAttentionResponse>({ kind: 'known.sync.attention.get' });
  if (response?.ok === true) return { attention: response.attention };
  return { error: response?.ok === false ? response.error : 'status_unreachable' };
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
async function send<T>(message: { readonly kind: string }, waitMilliseconds = 8_000): Promise<T | undefined> {
  try {
    const pending = chrome.runtime.sendMessage(message) as Promise<T>;
    const timeout = new Promise<undefined>((resolve) => { setTimeout(() => resolve(undefined), waitMilliseconds); });
    return await Promise.race([pending, timeout]);
  } catch { return undefined; }
}
