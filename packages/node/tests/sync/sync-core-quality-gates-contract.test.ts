import { readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import ts from 'typescript';
import { syncCoreCoverageFiles, syncCriticalManifest, syncMutationFiles } from '../../scripts/lib/sync-critical-manifest.mjs';

import syncCoreCoverageConfig from '../../vitest.sync-core.config.js';

/** The v8 coverage fields these gate tests assert (structural, not vitest's union). */
type CoverageView = {
  readonly include?: readonly string[];
  readonly thresholds?: Record<string, unknown>;
  readonly reportsDirectory?: string;
};




const packageRoot = resolve(import.meta.dirname, '..', '..');
const repositoryRoot = resolve(packageRoot, '..', '..');
const testingDocPath = resolve(packageRoot, 'docs', 'TESTING.md');
const workflowPath = resolve(repositoryRoot, '.github', 'workflows', 'colp-ci.yml');
const packageJson = JSON.parse(
  readFileSync(resolve(packageRoot, 'package.json'), 'utf8'),
) as { readonly scripts?: Readonly<Record<string, string>> };

type WorkflowStep = Readonly<{
  id?: string;
  name?: string;
  uses?: string;
  run?: string;
  'working-directory'?: string;
  with?: Readonly<Record<string, unknown>>;
  env?: Readonly<Record<string, string>>;
}>;

type WorkflowJob = Readonly<{
  needs?: string | readonly string[];
  if?: string;
  'runs-on'?: string;
  'timeout-minutes'?: number;
  steps?: readonly WorkflowStep[];
}>;

type Workflow = Readonly<{
  jobs?: Readonly<Record<string, WorkflowJob>>;
}>;

/** Tier A paths from docs/TESTING.md Sync Core-used coverage manifest. */
function parseTierAFilesFromTestingDoc(markdown: string): readonly string[] {
  const marker = '# Sync Core-used coverage manifest (U-3)';
  const start = markdown.indexOf(marker);
  expect(start).toBeGreaterThan(-1);
  const tierAHeader = markdown.indexOf('## Tier A — core (`sync-core` gate)', start);
  const tierBHeader = markdown.indexOf('## Tier B — adapter / composition', tierAHeader);
  expect(tierAHeader).toBeGreaterThan(-1);
  expect(tierBHeader).toBeGreaterThan(tierAHeader);
  const section = markdown.slice(tierAHeader, tierBHeader);
  const files: string[] = [];
  for (const line of section.split(/\r?\n/u)) {
    const match = /^\|\s*`([^`]+)`\s*\|\s*A\b/u.exec(line);
    if (match?.[1] !== undefined) files.push(match[1]);
  }
  return files;
}

describe('Sync Core-used quality gate configuration [review:sync.core-used-gate]', () => {
  it('keeps all runtime Sync dependencies inside the executable coverage manifest', () => {
    const files = new Set(syncCoreCoverageFiles);
    for (const file of files) {
      if (!file.startsWith('src/sync/')) continue;
      const source = ts.createSourceFile(file, readFileSync(resolve(packageRoot, file), 'utf8'), ts.ScriptTarget.Latest, true);
      for (const statement of source.statements) {
        if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) continue;
        if (ts.isImportDeclaration(statement)) {
          const clause = statement.importClause;
          if (clause?.isTypeOnly) continue;
          if (!clause?.name && clause?.namedBindings && ts.isNamedImports(clause.namedBindings)
            && clause.namedBindings.elements.every(element => element.isTypeOnly)) continue;
        } else {
          if (statement.isTypeOnly) continue;
          if (statement.exportClause && ts.isNamedExports(statement.exportClause)
            && statement.exportClause.elements.every(element => element.isTypeOnly)) continue;
        }
        const target = statement.moduleSpecifier;
        if (!target || !ts.isStringLiteral(target) || !target.text.startsWith('./')) continue;
        const dependency = relative(packageRoot, resolve(packageRoot, dirname(file), target.text.replace(/\.js$/u, '.ts'))).replaceAll('\\', '/');
        expect(files.has(dependency), file + ' runtime dependency missing: ' + dependency).toBe(true);
      }
    }
  });

  it('pins authoritative effects and atomic projections in coverage and mutation from the same manifest', () => {
    expect(new Set(syncCoreCoverageFiles).size).toBe(syncCoreCoverageFiles.length);
    expect(syncMutationFiles).toEqual(syncCriticalManifest.filter(entry => entry.mutate).map(entry => entry.path));
    expect(syncCoreCoverageFiles).toContain('src/sync/session-bootstrap-guards.ts');
    expect(syncMutationFiles).toEqual(expect.arrayContaining([
      'src/sync/authoritative-effect-kind.ts', 'src/sync/host-composition-recipe.ts',
    ]));
    const mutationSource = readFileSync(resolve(packageRoot, 'stryker.sync.config.mjs'), 'utf8');
    expect(mutationSource).toContain("from './scripts/lib/sync-critical-manifest.mjs'");
    expect(mutationSource).toContain('mutate: [...syncMutationFiles]');
  });

  it('keeps docs Tier A manifest identical to vitest.sync-core coverage.include', () => {
    const markdown = readFileSync(testingDocPath, 'utf8');
    const tierA = parseTierAFilesFromTestingDoc(markdown);
    const include = (syncCoreCoverageConfig.test?.coverage as CoverageView | undefined)?.include;

    expect(tierA.length).toBeGreaterThanOrEqual(16);
    expect(include).toEqual([...tierA]);
    expect(include).not.toEqual(expect.arrayContaining(['src/sync/**/*.ts']));
    expect(include).not.toContain('src/sync/legacy.ts');
    expect(include).not.toContain('src/sync/index.ts');
    expect(include).not.toContain('src/sync/composition.ts');
    expect(include).not.toContain('src/sync/host.ts');
    expect(include).not.toContain('src/sync/unsafe.ts');
    expect(include).not.toContain('src/sync/replica-capability.ts');
  });

  it('defines an independent sync-core coverage script, report dir, and non-regression floor', () => {
    const coverage = syncCoreCoverageConfig.test?.coverage as CoverageView | undefined;

    expect(packageJson.scripts?.['test:coverage:sync-core']).toBe(
      'vitest run --config vitest.sync-core.config.ts --coverage',
    );
    expect(syncCoreCoverageConfig.test?.include).toEqual([
      'tests/sync/**/*.test.ts',
      'tests/property/core-state-properties.test.ts',
      'tests/integration/reference-host-guard-composition.test.ts',
    ]);
    expect(coverage?.reportsDirectory).toBe('coverage/sync-core');
    expect(coverage?.thresholds).toEqual({
      branches: 90,
      functions: 98,
      lines: 95,
      statements: 90,
    });

    const check = packageJson.scripts?.check ?? '';
    const securityIdx = check.indexOf('npm run test:coverage:security');
    const syncCoreIdx = check.indexOf('npm run test:coverage:sync-core');
    const buildIdx = check.indexOf('npm run build');
    expect(securityIdx).toBeGreaterThan(-1);
    expect(syncCoreIdx).toBeGreaterThan(securityIdx);
    expect(buildIdx).toBeGreaterThan(syncCoreIdx);
  });

  it('wires sync-core-coverage into colp-ci like Security and requires it in ci-gate', () => {
    const workflow = parse(readFileSync(workflowPath, 'utf8')) as Workflow;
    const syncCore = workflow.jobs?.['sync-core-coverage'];
    const ciGate = workflow.jobs?.['ci-gate'];

    expect(syncCore?.needs).toBe('changes');
    expect(syncCore?.if).toBe(
      "needs.changes.outputs.full == 'true' || needs.changes.outputs.quality == 'true'",
    );
    expect(syncCore?.['runs-on']).toBe('ubuntu-24.04');
    expect(
      syncCore?.steps?.some(
        (step) =>
          step.run === 'npm run test:coverage:sync-core' &&
          step['working-directory'] === 'packages/node',
      ),
    ).toBe(true);

    const ciGateNeeds = ciGate?.needs;
    expect(Array.isArray(ciGateNeeds) ? ciGateNeeds : []).toContain('sync-core-coverage');

    const gateStep = ciGate?.steps?.find(
      ({ name }) => name === 'Require every selected job to pass',
    );
    expect(gateStep?.env).toMatchObject({
      SYNC_CORE_RESULT: '${{ needs.sync-core-coverage.result }}',
    });
    expect(String(gateStep?.run ?? '')).toContain('"$SYNC_CORE_RESULT"');
  });
});
