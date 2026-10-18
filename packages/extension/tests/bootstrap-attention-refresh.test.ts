import { expect, test } from 'vitest';
import { conflicted, scope } from './bootstrap-merge-attention-harness.js';
import { publicAttentionSummary, buildAttentionReport } from '../src/bootstrap/attention-report.js';
import { handleAttentionGet } from '../src/sw/first-run-attention.js';
test('review: rematching an attention run after the content converges must clear obsolete conflicts', async () => {
  const f = await conflicted();
  try {
    const view = await f.coordinator.advance(f.view.run.runId, { ...f.input,
      localFacts: f.input.localFacts.map((l, i) => ({ ...l, title: `Remote ${i}` })) });
    const status = await f.coordinator.status();
    expect(status.phase).toBe('completed');
    f.store.close();
    expect((await f.coordinator.status()).phase).toBe('completed');
    expect(view.report?.conflicts).toHaveLength(0);
    expect(status.attention ? publicAttentionSummary(status.attention).pendingCount : 0).toBe(0);
  } finally { f.store.close(); }
});

test('one item with multiple field differences has one stable item and stale reports stay closed', async () => {
  const f = await conflicted();
  try {
    const report = f.view.report!;
    const multiple = { ...report, conflicts: [...report.conflicts, { ...report.conflicts[0]!, kind: 'url' as const }] };
    const attention = buildAttentionReport(f.view.run, multiple, 10000);
    expect(publicAttentionSummary(attention).pendingCount).toBe(4);
    expect(attention.items).toHaveLength(4); expect(attention.conflictCount).toBe(4);
    await f.coordinator.advance(f.view.run.runId, { ...f.input,
      localFacts: f.input.localFacts.map((row, i) => ({ ...row, title: `Remote ${i}` })) });
    expect(await handleAttentionGet(f.store, scope, f.view.run.runId, undefined, 'completed')).toMatchObject({ ok: true, attention: { pendingCount: 0 } });
    expect(await f.store.listBootstrapRuns(scope)).toHaveLength(1);
  } finally { f.store.close(); }
});
