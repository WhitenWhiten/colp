import { describe, expect, it } from 'vitest';
import { measuredSyncCoverageBaseline, SYNC_AUDIT_COVERAGE_FILES, SYNC_CORE_COVERAGE_FILES } from '../scripts/check-sync-coverage-ratchet.mjs';
const summary = () => Object.fromEntries(SYNC_CORE_COVERAGE_FILES.map(path => [path,
  Object.fromEntries(['lines', 'branches', 'functions', 'statements'].map(metric => [metric, { pct: 90 }]))]));
describe('baseline measurement admission', () => {
  it.each(['empty', 'file', 'metric', 'nan', 'infinite'])('rejects %s before producing a baseline', kind => {
    const report = summary();
    if (kind === 'empty') for (const path of Object.keys(report)) delete report[path];
    if (kind === 'file') delete report[SYNC_CORE_COVERAGE_FILES[0]!];
    if (kind === 'metric') delete report[SYNC_CORE_COVERAGE_FILES[0]!]!.lines;
    if (kind === 'nan') report[SYNC_CORE_COVERAGE_FILES[0]!]!.lines = { pct: NaN };
    if (kind === 'infinite') report[SYNC_CORE_COVERAGE_FILES[0]!]!.lines = { pct: Infinity };
    expect(() => measuredSyncCoverageBaseline(report)).toThrow();
  });
  it('keeps higher reviewed floors while accepting complete measurements', () => {
    const old = measuredSyncCoverageBaseline(summary()); old.files[SYNC_CORE_COVERAGE_FILES[0]!] = { ...old.files[SYNC_CORE_COVERAGE_FILES[0]!]!, lines: 95 };
    expect(measuredSyncCoverageBaseline(summary(), old).files[SYNC_CORE_COVERAGE_FILES[0]!]!.lines).toBe(95);
  });
  it.each(['lines', 'branches', 'functions', 'statements'])(
    'does not turn a failing new-owner %s measurement into an accepted baseline', metric => {
      const report = summary(); report[SYNC_AUDIT_COVERAGE_FILES[0]!]![metric] = { pct: 79.99 };
      expect(() => measuredSyncCoverageBaseline(report)).toThrow(`${metric} 79.99% below new-file minimum 80%`);
    });
});
