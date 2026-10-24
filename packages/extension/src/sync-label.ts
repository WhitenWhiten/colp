import { popupFirstRunStatus, readFirstRunDraft } from './first-run-draft.js';
import { projectSyncStatus, type SyncStatus } from './sync-status.js';
import type { FirstRunDurablePhase, FirstRunOrScopeResponse, FirstRunScopeState, PublicAttentionSummary, SyncAttentionResponse } from './types.js';

/**
 * The sync phrase for a signed-in account, shared by the popup chip and the
 * options topbar chip. The engine status alone cannot tell "sync not set up"
 * from "no network": both leave the worker without a Session, so first-run
 * state is read first.
 */
export async function signedInSyncStatus(): Promise<SyncStatus> {
  try {
    const personal = await chrome.runtime.sendMessage({ kind: 'known.personalSync.status' }) as
      { ok?: boolean; policy?: { mode?: string } };
    if (personal?.ok && personal.policy?.mode === 'paused') return projectSyncStatus('paused');
    if (personal?.ok && personal.policy?.mode === 'disconnected') return projectSyncStatus('local-only');
    if (personal?.ok && personal.policy?.mode === 'target-unavailable') return projectSyncStatus('action-required');
  } catch { /* No personal connection leaves the existing first-run status. */ }
  const draft = await readFirstRunDraft();
  let firstRun: FirstRunScopeState | undefined = draft?.deferred ? 'deferred' : 'none';
  let engine: { phase: string; hasPendingWork: boolean; conflictPending?: boolean; errorCode?: string } | undefined;
  let phase: FirstRunDurablePhase | undefined;
  let attention: PublicAttentionSummary | undefined;
  try {
    const status = await chrome.runtime.sendMessage({ kind: 'known.firstRun.status' }) as FirstRunOrScopeResponse;
    if (status.ok && 'firstRun' in status) {
      firstRun = status.firstRun;
      if ('phase' in status) phase = status.phase;
      if ('attention' in status) attention = status.attention;
    }
  } catch { /* Draft is enough to avoid a false synced label. */ }
  try {
    const response = await chrome.runtime.sendMessage({ kind: 'known.sync.engine.status' }) as
      { readonly ok: true; readonly engine: { readonly phase: string; readonly hasPendingWork: boolean;
        readonly conflictPending?: boolean; readonly errorCode?: string } } | { readonly ok: false };
    if (response.ok) engine = response.engine;
  } catch { /* Engine status is optional on the first-run path. */ }
  // Sleeping only means the runnable lane is empty. Rejected uploads and
  // isolated Push/Pull/local issues still require a decision from the owner.
  try {
    const response = await chrome.runtime.sendMessage({ kind: 'known.sync.attention.get' }) as SyncAttentionResponse;
    if (response.ok) {
      const facts = response.attention;
      if (facts.conflictPending) return projectSyncStatus('review-conflicts');
      if ((facts.issueCount ?? 0) > 0 || facts.terminal
          || facts.retryAutomatic === false || facts.rejectedPending || facts.nativeWaitPending) {
        return projectSyncStatus('action-required');
      }
    } else if (response.error === 'state_unavailable') engine = undefined;
  } catch { engine = undefined; }
  return projectSyncStatus(popupFirstRunStatus({
    connected: true, firstRun, deferredDraft: draft?.deferred === true, phase, attention, engine,
  }));
}
