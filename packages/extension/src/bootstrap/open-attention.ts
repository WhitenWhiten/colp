import { digestJson } from '../bookmark-event-codec.js';
import { uniqueAttentionItems } from './attention-report.js';
import type { BootstrapRunRecord, MappingInput } from '../sync-state-store.js';

export interface BootstrapDisplayIssue {
  readonly issueId: string; readonly reportId: string; readonly itemId: string;
  readonly code: 'local_merge_difference' | 'duplicate_candidate'; readonly nodeId?: string;
  readonly title?: string; readonly at: number;
}
/** Display facts only. A merge choice never protects the upload/Pull graph. */
export function openBootstrapAttention(runs: readonly BootstrapRunRecord[], mappings: readonly MappingInput[]): BootstrapDisplayIssue[] {
  const issues = new Map<string, BootstrapDisplayIssue>();
  const byNative = new Map(mappings.map(row => [row.nativeId, row]));
  const byColp = new Map(mappings.map(row => [row.colpId, row]));
  for (const run of [...runs].sort((a, b) => a.updatedAt - b.updatedAt || a.runId.localeCompare(b.runId))) {
    if (!run.attention || run.previewOnly) continue;
    for (const item of uniqueAttentionItems(run.attention)) {
      if (item.decision !== 'open') continue;
      const code = item.kind === 'duplicate_candidate' ? 'duplicate_candidate' : 'local_merge_difference';
      const identity = digestJson(['merge', code, item.itemId]).slice(7, 39);
      const mapped = (item.nodeRefs ?? []).map(id => byNative.get(id) ?? byColp.get(id)).find(Boolean);
      const title = mapped?.projection.content?.title;
      issues.set(identity, { issueId: identity, code, reportId: run.runId, itemId: item.itemId,
        ...(mapped?.colpId && !/^(?:local-|pending-|mount:)/u.test(mapped.colpId) ? { nodeId: mapped.colpId } : {}),
        ...(typeof title === 'string' ? { title: title.slice(0, 200) } : {}), at: run.attention.createdAt });
    }
  }
  return [...issues.values()];
}
