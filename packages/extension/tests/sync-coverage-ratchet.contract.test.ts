import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  evaluateSyncCoverageRatchet,
  SYNC_AUDIT_COVERAGE_FILES,
  SYNC_COVERAGE_METRICS,
  SYNC_CORE_COVERAGE_FILES,
  SYNC_NEW_COVERAGE_MINIMUM,
  SYNC_NEW_BRANCH_MINIMUM,
  SYNC_NEW_COVERAGE_FILES,
  SYNC_PULL_BRANCH_MINIMUM,
  SYNC_PULL_COVERAGE_FILES,
} from '../scripts/check-sync-coverage-ratchet.mjs';

/**
 * CI gate contract (allowlisted in tests/static-anchor-allowlist.ts): coverage floors,
 * the include list and the V8/CI wiring only exist as configuration consumed by the
 * coverage runner; the evaluator itself is executed for real by the other cases here.
 */
const packageRoot = resolve(import.meta.dirname, '..');
const repositoryRoot = resolve(packageRoot, '../..');
const packageJson = JSON.parse(readFileSync(resolve(packageRoot, 'package.json'), 'utf8')) as {
  readonly scripts?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
};
const workflow = readFileSync(
  resolve(repositoryRoot, '.github', 'workflows', 'colp-ci.yml'),
  'utf8',
);
const coverageConfig = readFileSync(resolve(packageRoot, 'vitest.sync-coverage.config.ts'), 'utf8');
const baseline = JSON.parse(
  readFileSync(resolve(packageRoot, 'tests/fixtures/sync-coverage-baseline.json'), 'utf8'),
) as {
  readonly files: Readonly<Record<string, {
    readonly lines: number;
    readonly branches: number;
    readonly functions: number;
    readonly statements: number;
  }>>;
};

describe('Extension Sync coverage ratchet [SYNC-Q-021]', () => {
  it('holds every Pull owner above 80% branches instead of relying on the global average', () => {
    for (const file of SYNC_PULL_COVERAGE_FILES) {
      expect(baseline.files[file]?.branches).toBeGreaterThanOrEqual(80);
    }
    for (const file of SYNC_NEW_COVERAGE_FILES) {
      expect(baseline.files[file]?.branches).toBeGreaterThanOrEqual(SYNC_NEW_BRANCH_MINIMUM);
    }
    const summary = Object.fromEntries(SYNC_CORE_COVERAGE_FILES.map((file) => {
      const current = baseline.files[file]!;
      return [file, { lines: { pct: current.lines }, statements: { pct: current.statements },
        functions: { pct: current.functions }, branches: { pct: file === 'src/pull-apply-runtime.ts'
          ? SYNC_PULL_BRANCH_MINIMUM - 0.01 : current.branches } }];
    }));
    expect(evaluateSyncCoverageRatchet(summary, baseline)).toContain(
      'src/pull-apply-runtime.ts: branches 79.99% below hard Pull minimum 80%',
    );
  });

  it('rejects a listed Sync core file that drops below the per-file baseline', () => {
    const path = SYNC_CORE_COVERAGE_FILES[0];
    expect(path).toBeDefined();
    const floors = baseline.files[path!];
    expect(floors).toBeDefined();
    const summary = Object.fromEntries(
      SYNC_CORE_COVERAGE_FILES.map((file) => {
        const current = baseline.files[file]!;
        return [file, {
          lines: { pct: file === path ? current.lines - 1 : current.lines },
          branches: { pct: current.branches },
          functions: { pct: current.functions },
          statements: { pct: current.statements },
        }];
      }),
    );
    expect(evaluateSyncCoverageRatchet(summary, baseline)).toEqual([
      `${path}: lines ${floors!.lines - 1}% dropped below ${floors!.lines}%`,
    ]);
  });

  it.each(['lines', 'branches', 'functions', 'statements'] as const)(
    'rejects an audit owner below 80%% %s even inside the old rounding margin', metric => {
      const path = SYNC_AUDIT_COVERAGE_FILES[0]!;
      const summary = Object.fromEntries(SYNC_CORE_COVERAGE_FILES.map(file => [file,
        Object.fromEntries(SYNC_COVERAGE_METRICS.map(name => [name, { pct: 100 }]))]));
      summary[path]![metric] = { pct: 79.99 };
      expect(evaluateSyncCoverageRatchet(summary, baseline)).toContain(
        `${path}: ${metric} 79.99% below new-file minimum ${SYNC_NEW_COVERAGE_MINIMUM}%`);
      for (const file of SYNC_AUDIT_COVERAGE_FILES) {
        expect(baseline.files[file]?.[metric]).toBeGreaterThanOrEqual(SYNC_NEW_COVERAGE_MINIMUM);
      }
    });

  it('includes production dispatch and durable decision owners without duplicate ownership', () => {
    expect(new Set(SYNC_CORE_COVERAGE_FILES).size).toBe(SYNC_CORE_COVERAGE_FILES.length);
    for (const file of ['src/options.ts', 'src/service-worker.ts', 'src/sw/range-command.ts',
      'src/sw/rejoin-decisions.ts', 'src/sync-state/boundary-command-repository.ts',
      'src/sync-state/scope-command-evidence.ts', 'src/sync-state/rejoin-resolution-repository.ts',
      'src/scope-rejoin-order-progress.ts', 'src/sync-state/queue-live-work.ts', 'src/sync-status-queue.ts',
      'src/cloud-capability.ts', 'src/public-server-manifest.ts', 'src/server-account-ui.ts', 'src/server-edition.ts',
      'src/replica-retirement.ts', 'src/scope-rejoin-remote-delete.ts', 'src/bookmark-event-ingress.ts',
      'src/bookmark-event-projection.ts', 'src/replica-repair-capability.ts', 'src/scope-rejoin-placement.ts',
      'src/snapshot-create-boundary.ts', 'src/snapshot-mounted-deletes.ts', 'src/snapshot-native-boundary.ts',
      'src/native-call-result.ts',
      'src/bookmark-subscriptions/guards.ts', 'src/metadata-sync-policy.ts',
      'src/sync-effect-authority.ts', 'src/sync-fetch-boundary.ts',
      'src/pull-item-set-aside.ts', 'src/sync-state/pull-workset.ts', 'src/sw/scope.ts', 'src/sw/scope-rebuild.ts',
      'src/pull-native-content-barrier.ts', 'src/pull-native-snapshot-resume.ts', 'src/pull-range-move.ts',
      'src/recovery-content.ts', 'src/recovery-delete.ts', 'src/recovery-placement.ts',
      'src/bookmark-event-codec.ts', 'src/bootstrap/advanced-run.ts', 'src/generated/browser-ingress-title.ts',
      'src/manifest-client.ts', 'src/replica-rebuild-ui.ts',
      'src/sync-state/queue-read-repository.ts',
      'src/queued-upload-batch-boundary.ts', 'src/sync-state/queued-upload-boundary-repository.ts']) {
      expect(SYNC_AUDIT_COVERAGE_FILES).toContain(file);
    }
  });

  it('does not pass on a global average when a listed file is missing', () => {
    expect(
      evaluateSyncCoverageRatchet({ total: { lines: { pct: 99 } } }, baseline),
    ).toEqual(SYNC_CORE_COVERAGE_FILES.map((file) => `${file}: missing from coverage report`));
  });

  it('wires V8 coverage, the Sync include list, and the named CI job', () => {
    expect(packageJson.devDependencies?.['@vitest/coverage-v8']).toBe('4.1.11');
    expect(packageJson.devDependencies?.vitest).toBe(packageJson.devDependencies?.['@vitest/coverage-v8']);
    expect(packageJson.scripts?.['test:coverage:sync']).toBe(
      'vitest run --config vitest.sync-coverage.config.ts --coverage && node scripts/check-sync-coverage-ratchet.mjs',
    );
    expect(coverageConfig).toContain("reportsDirectory: 'coverage/sync'");
    expect(coverageConfig).toContain('include: [...SYNC_CORE_COVERAGE_FILES]');
    expect(coverageConfig).toContain('thresholds: { branches: 80 }');
    expect(coverageConfig).toContain('reportOnFailure: true');
    expect(coverageConfig).toContain("reporter: ['text', 'json', 'json-summary', 'html']");
    expect(Object.keys(baseline.files)).toEqual([...SYNC_CORE_COVERAGE_FILES]);
    expect(workflow).toContain('extension-coverage:');
    expect(workflow).toContain('run: npm run test:coverage:sync');
    expect(workflow).toContain('- extension-coverage');
  });

  it('retains failure measurements without allowing tests or coverage to become advisory', () => {
    const job = workflow.split('  extension-coverage:')[1]!.split('  extension-mv3:')[0]!;
    expect(job).toContain('run: npm run test:coverage:sync');
    expect(job).toContain("if: failure() && hashFiles('packages/extension/coverage/sync/coverage-summary.json') != ''");
    expect(job).toContain('run: node scripts/check-sync-coverage-ratchet.mjs');
    expect(job).toMatch(/Upload extension sync coverage measurement\n\s+if: always\(\)\n\s+uses: actions\/upload-artifact@/u);
    expect(job).toContain('path: packages/extension/coverage/sync/');
    expect(job).toContain('if-no-files-found: error');
    expect(job).not.toContain('continue-on-error:');
    expect(job).not.toContain('|| true');
  });
});
