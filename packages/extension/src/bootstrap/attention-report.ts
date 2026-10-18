import { digest, type LocalMatchReport } from './matcher.js';
import type { BootstrapRunRecord } from '../sync-state/types.js';

export const ATTENTION_REPORT_VERSION = 1 as const;
const PAGE_SIZE = 20;

export interface AttentionItemRecord {
  readonly itemId: string;
  readonly evidenceDigest?: string;
  readonly resolutionOpIds?: readonly string[];
  readonly nodeRefs?: readonly string[];
  readonly kind: 'duplicate_candidate' | 'local_difference' | 'conflict';
  readonly locationCount: number;
  readonly decision: 'open' | 'keep_both';
}

export interface AttentionReportRecord {
  readonly reportId: string;
  readonly version: typeof ATTENTION_REPORT_VERSION;
  readonly candidateCount: number;
  readonly conflictCount: number;
  readonly localOnlyCount: number;
  readonly remoteOnlyCount: number;
  readonly matchedCount: number;
  readonly items: readonly AttentionItemRecord[];
  readonly createdAt: number;
  readonly pageCount?: number;
}

export interface PublicAttentionSummary {
  readonly reportId: string;
  readonly candidateCount: number;
  readonly conflictCount: number;
  readonly pendingCount: number;
}

export function buildAttentionReport(
  run: Pick<BootstrapRunRecord, 'runId' | 'attention'>,
  report: LocalMatchReport,
  now: number,
): AttentionReportRecord {
  const prior = run.attention && run.attention.reportId === run.runId ? run.attention : undefined;
  const priorById = new Map((prior?.items ?? []).map((item) => [item.itemId, item]));
  const items: AttentionItemRecord[] = [];
  for (const candidate of report.candidates) {
    const itemId = digest({ kind: 'duplicate_candidate', url: candidate.url, nodeIds: [...candidate.nodeIds].sort() });
    items.push({
      itemId, nodeRefs: candidate.nodeIds, kind: 'duplicate_candidate', locationCount: Math.max(candidate.nodeIds.length, candidate.parents.length),
      decision: priorById.get(itemId)?.decision === 'keep_both' ? 'keep_both' : 'open',
    });
  }
  {
    for (const conflict of report.conflicts) {
      const itemId = digest({
        kind: 'conflict', localNativeId: conflict.localNativeId, remoteNodeId: conflict.remoteNodeId,
      });
      items.push({
        itemId, nodeRefs: [conflict.localNativeId, conflict.remoteNodeId], kind: 'local_difference', locationCount: 2,
        evidenceDigest: conflict.evidenceDigest,
        ...(priorById.get(itemId)?.resolutionOpIds ? { resolutionOpIds: priorById.get(itemId)!.resolutionOpIds } : {}),
        decision: priorById.get(itemId)?.decision === 'keep_both' ? 'keep_both' : 'open',
      });
    }
  }
  const unique = [...new Map(items.map(item => [item.itemId, item])).values()];
  return {
    reportId: run.runId, version: ATTENTION_REPORT_VERSION,
    candidateCount: unique.filter(item => item.kind === 'duplicate_candidate').length, conflictCount: unique.filter(item => item.kind !== 'duplicate_candidate').length,
    localOnlyCount: report.localOnly.length, remoteOnlyCount: report.remoteOnly.length,
    matchedCount: report.matched.length, items: unique, createdAt: prior?.createdAt ?? now,
  };
}

export function publicAttentionSummary(attention: AttentionReportRecord): PublicAttentionSummary {
  return {
    reportId: attention.reportId,
    candidateCount: uniqueAttentionItems(attention).filter(item => item.kind === 'duplicate_candidate').length,
    conflictCount: uniqueAttentionItems(attention).filter(item => item.kind !== 'duplicate_candidate').length,
    pendingCount: uniqueAttentionItems(attention).filter((item) => item.decision === 'open').length,
  };
}

export function pageAttention(attention: AttentionReportRecord, cursor?: string): {
  readonly items: readonly AttentionItemRecord[]; readonly nextCursor?: string;
} {
  const offset = Number.parseInt(cursor ?? '0', 10);
  const start = Number.isFinite(offset) && offset > 0 ? offset : 0;
  const current = uniqueAttentionItems(attention);
  const items = current.slice(start, start + PAGE_SIZE);
  const next = start + PAGE_SIZE;
  return { items, ...(next < current.length ? { nextCursor: String(next) } : {}) };
}

export function decideAttentionItem(
  attention: AttentionReportRecord, itemId: string, decision: 'keep_both',
): AttentionReportRecord | null {
  const selected = attention.items.find(item => item.itemId === itemId);
  if (!selected || selected.kind !== 'duplicate_candidate') return null;
  if (selected.decision === decision) return attention;
  const items = attention.items.map((item) => {
    if (item.itemId !== itemId || item.decision === decision) return item;
    return { ...item, decision };
  });
  if (items.every((item, index) => item === attention.items[index])) return null;
  return { ...attention, items };
}

export function uniqueAttentionItems(attention: AttentionReportRecord): AttentionItemRecord[] {
  return [...new Map(attention.items.map(item => [item.itemId, item])).values()];
}
