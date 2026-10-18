import { enqueueLocalMergeResolution } from '../bootstrap/merge-resolution.js';
import type { ConfirmInput } from '../bootstrap/coordinator.js';
import { reasonCode } from '../push-error-code.js';
import { decideAttentionItem, pageAttention, publicAttentionSummary } from '../bootstrap/attention-report.js';
import type { BootstrapRunRecord, SyncScope, createSyncStateStore } from '../sync-state-store.js';
import type { FirstRunOrScopeResponse, FirstRunScopeState, PublicAttentionSummary } from '../types.js';
import { t } from '../i18n.js';

type Store = ReturnType<typeof createSyncStateStore>;

export function attentionSummaryOf(run: { readonly attention?: BootstrapRunRecord['attention'] } | undefined):
  PublicAttentionSummary | undefined {
  return run?.attention ? publicAttentionSummary(run.attention) : undefined;
}

export function withAttention(
  phase: BootstrapRunRecord['phase'], firstRun: FirstRunScopeState,
  run?: { readonly attention?: BootstrapRunRecord['attention'] },
): FirstRunOrScopeResponse {
  const attention = attentionSummaryOf(run);
  return { ok: true, phase, firstRun, ...(attention ? { attention } : {}) };
}

export async function latestBootstrapRun(store: Store, scope: SyncScope): Promise<BootstrapRunRecord | undefined> {
  const runs = [...await store.listBootstrapRuns(scope)].sort((left, right) => right.updatedAt - left.updatedAt);
  return runs.find(row => row.attention && publicAttentionSummary(row.attention).pendingCount > 0) ?? runs[0];
}

export async function handleAttentionGet(store: Store, scope: SyncScope, reportId: string, cursor?: string,
  firstRun: FirstRunScopeState = 'none'): Promise<FirstRunOrScopeResponse> {
  const run = (await store.listBootstrapRuns(scope)).find((row) => row.runId === reportId);
  if (!run?.attention || run.attention.reportId !== reportId) return { ok: false, error: 'request_invalid' };
  const page = pageAttention(run.attention, cursor);
  const items = await Promise.all(page.items.map(async ({ nodeRefs = [], parentRefs = [], ...item }) => {
    const titles = await Promise.all(nodeRefs.map(async ref => {
      const mapping = await store.getMappingByNativeId(scope, ref) ?? await store.getMappingByColpId(scope, ref);
      if (typeof mapping?.projection.content?.title === 'string') return mapping.projection.content.title;
      try { return (await chrome.bookmarks.get(ref))[0]?.title; } catch { return undefined; }
    }));
    const parentLabels = await Promise.all(parentRefs.map(async ref => {
      const mapping = await store.getMappingByNativeId(scope, ref) ?? await store.getMappingByColpId(scope, ref);
      if (mapping?.projection.content?.folderRole === 'root') return t('firstRun_libraryRootFolder', 'Library root');
      if (typeof mapping?.projection.content?.title === 'string') return mapping.projection.content.title || t('firstRun_libraryRootFolder', 'Library root');
      try { return (await chrome.bookmarks.get(ref))[0]?.title ?? '?'; } catch { return '?'; }
    }));
    const operations = await Promise.all((item.resolutionOpIds ?? []).map(id => store.getQueueByOpId(scope, id)));
    const failed = operations.find(row => row?.status === 'rejected' || row?.recovery?.resultStatus === 'rejected');
    return { ...item, ...(parentLabels.length ? { parentLabels } : {}), ...(operations.length ? { resolutionPending: operations.some(row => row && !['terminal', 'rejected'].includes(row.status)) } : {}),
      ...(failed ? { resolutionError: failed.recovery?.code ?? 'push_rejected' } : {}), label: titles.filter(Boolean).join(' / ') || t('firstRun_bookmarkReview', 'Bookmark to review') };
  }));
  const base = withAttention(run.phase, firstRun, run);
  if (!base.ok || !('phase' in base)) return base;
  return {
    ...base, items,
    ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
  };
}

export async function handleAttentionDecide(store: Store, scope: SyncScope, reportId: string, itemId: string,
  firstRun: FirstRunScopeState = 'none', resolution?: { decision: 'keep_both' | 'keep_local'; evidenceDigest?: string; input?: ConfirmInput; assertCurrent?: () => Promise<void> }): Promise<FirstRunOrScopeResponse> {
  const run = (await store.listBootstrapRuns(scope)).find((row) => row.runId === reportId);
  if (!run?.attention || run.attention.reportId !== reportId) return { ok: false, error: 'request_invalid' };
  if (resolution?.decision === 'keep_local') {
    try {
      if (!resolution.input || !resolution.evidenceDigest) throw new Error('bootstrap_confirmation_stale');
      const resolutionOpIds = await enqueueLocalMergeResolution(store, scope, run, resolution.input, itemId, resolution.evidenceDigest, resolution.assertCurrent);
      const attention = { ...run.attention, items: run.attention.items.map(item => item.itemId === itemId ? { ...item, resolutionOpIds } : item) };
      await resolution.assertCurrent?.();
      const saved = await store.putBootstrapRun(scope, { ...run, attention, updatedAt: Date.now() }, run);
      return withAttention(saved.phase, firstRun, saved);
    } catch (error) { return { ok: false, error: reasonCode(error, 'merge_resolution_failed') }; }
  }
  const next = decideAttentionItem(run.attention, itemId, 'keep_both');
  if (!next) return { ok: false, error: 'request_invalid' };
  const saved = await store.putBootstrapRun(scope, { ...run, attention: next,
    ...(publicAttentionSummary(next).pendingCount === 0 && firstRun === 'completed' ? { phase: 'completed' as const } : {}),
    updatedAt: Date.now() }, run);
  return withAttention(saved.phase, firstRun, saved);
}
