import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SYNC_CORE_COVERAGE_FILES } from '../scripts/check-sync-coverage-ratchet.mjs';

/**
 * TEST-05 residual: `--write-baseline` now requires an existing reviewed
 * baseline, so a from-scratch repository could never create one. The explicit
 * `--bootstrap-baseline` path is exercised end to end by running the real CLI
 * from a copied package root (the script is self-contained).
 */
const script = resolve(import.meta.dirname, '../scripts/check-sync-coverage-ratchet.mjs');
const metrics = ['lines', 'branches', 'functions', 'statements'] as const;
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function scaffold(summary: unknown) {
  const root = mkdtempSync(join(tmpdir(), 'sync-coverage-bootstrap-'));
  roots.push(root);
  mkdirSync(join(root, 'scripts'), { recursive: true });
  cpSync(script, join(root, 'scripts', 'check-sync-coverage-ratchet.mjs'));
  mkdirSync(join(root, 'coverage', 'sync'), { recursive: true });
  writeFileSync(join(root, 'coverage', 'sync', 'coverage-summary.json'), JSON.stringify(summary));
  return { root, baselinePath: join(root, 'tests', 'fixtures', 'sync-coverage-baseline.json') };
}

function complete() {
  return Object.fromEntries(SYNC_CORE_COVERAGE_FILES.map(path => [path,
    Object.fromEntries(metrics.map(metric => [metric, { pct: 90 }]))]));
}

type CliExecutor = (file: string, args: readonly string[], options: {
  cwd: string; encoding: 'utf8'; stdio: 'pipe';
}) => string;
function run(root: string, args: readonly string[], execute: CliExecutor = execFileSync) {
  try {
    const stdout = execute(process.execPath, [join(root, 'scripts', 'check-sync-coverage-ratchet.mjs'), ...args],
      { cwd: root, encoding: 'utf8', stdio: 'pipe' });
    return { status: 0, stdout, stderr: '' };
  } catch (error) {
    const failure = error as { status?: number; code?: string; stdout?: string; stderr?: string; message?: string };
    // Some sandbox launchers report status=0 alongside EPERM. A thrown launch
    // error is never a successful CLI run, even when no child stderr exists.
    const status = !failure.code && typeof failure.status === 'number' && failure.status !== 0 ? failure.status : -1;
    return { status, stdout: failure.stdout ?? '', stderr: failure.stderr || failure.message || String(error) };
  }
}

describe('sync coverage baseline bootstrap', () => {
  it('reports a refused subprocess as a launcher failure even if its error contains status zero', () => {
    const denied = Object.assign(new Error('spawnSync node EPERM'), { code: 'EPERM', status: 0, stdout: '', stderr: '' });
    const result = run('/fixture', [], () => { throw denied; });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('EPERM');
    expect(run('/fixture', [], () => { throw { status: 2, stderr: 'coverage measurement missing' }; }))
      .toEqual({ status: 2, stdout: '', stderr: 'coverage measurement missing' });
  });

  it('creates the first reviewed baseline from a complete measurement', () => {
    const { root, baselinePath } = scaffold(complete());
    expect(existsSync(baselinePath)).toBe(false);
    const bootstrap = run(root, ['--bootstrap-baseline']);
    expect(bootstrap.status).toBe(0);
    expect(bootstrap.stdout).toContain('bootstrap wrote');
    const baseline = JSON.parse(readFileSync(baselinePath, 'utf8')) as {
      files: Record<string, Record<string, number>> };
    expect(Object.keys(baseline.files)).toEqual([...SYNC_CORE_COVERAGE_FILES]);
    expect(baseline.files[SYNC_CORE_COVERAGE_FILES[0]!]).toEqual({ lines: 90, branches: 90, functions: 90, statements: 90 });
    // The freshly bootstrapped baseline is immediately usable by the evaluator.
    expect(run(root, []).status).toBe(0);
  });

  it('refuses to bootstrap over an existing reviewed baseline without touching it', () => {
    const { root, baselinePath } = scaffold(complete());
    expect(run(root, ['--bootstrap-baseline']).status).toBe(0);
    const before = readFileSync(baselinePath, 'utf8');
    const again = run(root, ['--bootstrap-baseline']);
    expect(again.status).not.toBe(0);
    expect(again.stderr).toContain('refuses to overwrite');
    expect(readFileSync(baselinePath, 'utf8')).toBe(before);
  });

  it('still requires the reviewed baseline for an ordinary --write-baseline', () => {
    const { root, baselinePath } = scaffold(complete());
    const write = run(root, ['--write-baseline']);
    expect(write.status).not.toBe(0);
    expect(existsSync(baselinePath)).toBe(false);
  });

  it.each(['missing-file', 'missing-metric', 'nan', 'infinite', 'out-of-range'])(
    'rejects a %s measurement and writes no baseline', kind => {
      const summary = complete() as Record<string, Record<string, unknown>>;
      const first = SYNC_CORE_COVERAGE_FILES[0]!;
      if (kind === 'missing-file') delete summary[first];
      if (kind === 'missing-metric') delete summary[first]!.lines;
      if (kind === 'nan') summary[first]!.lines = { pct: NaN };
      if (kind === 'infinite') summary[first]!.lines = { pct: Infinity };
      if (kind === 'out-of-range') summary[first]!.lines = { pct: 101 };
      const { root, baselinePath } = scaffold(summary);
      const result = run(root, ['--bootstrap-baseline']);
      expect(result.status).not.toBe(0);
      expect(existsSync(baselinePath)).toBe(false);
    });
});
