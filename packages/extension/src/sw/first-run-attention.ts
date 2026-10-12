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
  return runs[0];
}

export async function handleAttentionGet(store: Store, scope: SyncScope, reportId: string, cursor?: string,
  firstRun: FirstRunScopeState = 'none'): Promise<FirstRunOrScopeResponse> {
  const run = (await store.listBootstrapRuns(scope)).find((row) => row.runId === reportId);
  if (!run?.attention || run.attention.reportId !== reportId) return { ok: false, error: 'request_invalid' };
  const page = pageAttention(run.attention, cursor);
  const items = await Promise.all(page.items.map(async ({ nodeRefs = [], ...item }) => {
    const titles = await Promise.all(nodeRefs.map(async ref => {
      const mapping = await store.getMappingByNativeId(scope, ref) ?? await store.getMappingByColpId(scope, ref);
      if (typeof mapping?.projection.content?.title === 'string') return mapping.projection.content.title;
      try { return (await chrome.bookmarks.get(ref))[0]?.title; } catch { return undefined; }
    }));
    return { ...item, label: titles.filter(Boolean).join(' / ') || t('firstRun_bookmarkReview', 'Bookmark to review') };
  }));
  const base = withAttention(run.phase, firstRun, run);
  if (!base.ok || !('phase' in base)) return base;
  return {
    ...base, items, conflictHref: new URL('/sync', scope.serverOrigin).href,
    ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
  };
}

export async function handleAttentionDecide(store: Store, scope: SyncScope, reportId: string, itemId: string,
  firstRun: FirstRunScopeState = 'none'): Promise<FirstRunOrScopeResponse> {
  const run = (await store.listBootstrapRuns(scope)).find((row) => row.runId === reportId);
  if (!run?.attention || run.attention.reportId !== reportId) return { ok: false, error: 'request_invalid' };
  const next = decideAttentionItem(run.attention, itemId, 'keep_both');
  if (!next) return { ok: false, error: 'request_invalid' };
  const saved = await store.putBootstrapRun(scope, { ...run, attention: next,
    ...(publicAttentionSummary(next).pendingCount === 0 && firstRun === 'completed' ? { phase: 'completed' as const } : {}),
    updatedAt: Date.now() });
  return withAttention(saved.phase, firstRun, saved);
}
