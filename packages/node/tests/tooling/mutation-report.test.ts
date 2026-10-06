import { describe, expect, it } from 'vitest';

// @ts-expect-error TS7016 -- executable report tool is plain JavaScript.
import { aggregateMutationSummaries, mutationHistoryMarkdown, mutationSummaryMarkdown, summarizeMutationReport, updateMutationHistory } from '../../scripts/mutation-report.mjs';

function report(statuses: readonly string[]) {
  return {
    thresholds: { high: 80, low: 65, break: 65 },
    files: {
      'src/example.ts': {
        mutants: statuses.map((status, index) => ({ id: String(index), status })),
      },
    },
  };
}

describe('mutation report summaries', () => {
  it('uses Stryker terminal status semantics for mutation and covered scores', () => {
    const summary = summarizeMutationReport(report([
      'Killed',
      'Timeout',
      'CompileError',
      'RuntimeError',
      'Survived',
      'NoCoverage',
      'Ignored',
    ]), 'example');

    expect(summary).toMatchObject({
      domain: 'example',
      totals: {
        mutants: 7,
        scored: 6,
        covered: 5,
        detected: 4,
        survived: 1,
        noCoverage: 1,
        ignored: 1,
      },
      scores: {
        mutation: 66.67,
        covered: 80,
      },
    });
  });

  it('rejects pending or unknown statuses instead of publishing partial confidence', () => {
    expect(() => summarizeMutationReport(report(['Pending']), 'example')).toThrow(
      /non-terminal or unknown status/,
    );
  });

  it('aggregates unique domains and renders a GitHub summary table', () => {
    const core = summarizeMutationReport(report(['Killed', 'Survived']), 'core');
    const sync = summarizeMutationReport(report(['Timeout', 'NoCoverage']), 'sync');
    const aggregate = aggregateMutationSummaries([sync, core], 'abc123');

    expect(aggregate.domains.map(({ domain }: { domain: string }) => domain)).toEqual([
      'core',
      'sync',
    ]);
    expect(aggregate).toMatchObject({
      revision: 'abc123',
      totals: { mutants: 4, detected: 2, survived: 1, noCoverage: 1 },
      scores: { executionWeightedMutation: 50, executionWeightedCovered: 66.67 },
    });
    expect(mutationSummaryMarkdown(aggregate)).toContain(
      '| **Execution-weighted total** | **50%** |',
    );
    expect(mutationSummaryMarkdown(aggregate)).toContain('does not deduplicate mutants');
    expect(() => aggregateMutationSummaries([core, core])).toThrow(/Duplicate mutation domain/);
  });

  it('keeps a bounded revision history and compares only identical domain sets', () => {
    const coreRevision = 'a'.repeat(40);
    const syncRevision = 'b'.repeat(40);
    const core = aggregateMutationSummaries([
      summarizeMutationReport(report(['Killed', 'Survived']), 'core'),
    ], coreRevision);
    const sync = aggregateMutationSummaries([
      summarizeMutationReport(report(['Killed']), 'sync'),
    ], syncRevision);

    const first = updateMutationHistory(undefined, core, coreRevision);
    const second = updateMutationHistory(first, sync, syncRevision);
    const replaced = updateMutationHistory(second, core, coreRevision);

    expect(replaced.entries).toHaveLength(2);
    expect(replaced.entries.map(({ revision }: { revision: string }) => revision)).toEqual([
      syncRevision,
      coreRevision,
    ]);
    const markdown = mutationHistoryMarkdown(replaced, ['core']);
    expect(markdown).toContain(coreRevision.slice(0, 12));
    expect(markdown).not.toContain(syncRevision.slice(0, 12));
    expect(`${mutationSummaryMarkdown(core)}\n${markdown}`).toContain(
      'configurations._\n\n## Comparable mutation trend',
    );
    expect(() => updateMutationHistory(replaced, core, '', 30)).toThrow(/revision is required/);
  });
});
