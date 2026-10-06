import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

// The executable Stryker configuration is JavaScript and has no declaration file.
// @ts-expect-error TS7016 -- validate its runtime shape below.
import mcpMutationConfig from '../../stryker.mcp.config.mjs';
// @ts-expect-error TS7016 -- validate its runtime shape below.
import mcpChangePlanMutationConfig from '../../stryker.mcp.change-plan.config.mjs';
// @ts-expect-error TS7016 -- validate its runtime shape below.
import mcpReadMutationConfig from '../../stryker.mcp.read.config.mjs';
// @ts-expect-error TS7016 -- validate its runtime shape below.
import mcpWriteMutationConfig from '../../stryker.mcp.write.config.mjs';
// @ts-expect-error TS7016 -- validate its runtime shape below.
import coreMutationConfig from '../../stryker.config.mjs';
// @ts-expect-error TS7016 -- validate its runtime shape below.
import feedMutationConfig from '../../stryker.feed.config.mjs';
// @ts-expect-error TS7016 -- validate its runtime shape below.
import schemaMutationConfig from '../../stryker.schema.config.mjs';
// @ts-expect-error TS7016 -- validate its runtime shape below.
import securityMutationConfig from '../../stryker.security.config.mjs';
// @ts-expect-error TS7016 -- validate its runtime shape below.
import syncMutationConfig from '../../stryker.sync.config.mjs';
// @ts-expect-error TS7016 -- validate its runtime shape below.
import publisherMutationConfig from '../../stryker.publisher.config.mjs';
import coverageConfig from '../../vitest.config.js';
import mcpTestConfig from '../../vitest.mcp.config.js';
import { mutationSandboxExcludes } from '../../vitest.mutation.config.js';
import securityCoverageConfig from '../../vitest.security.config.js';

/** The v8 coverage fields these gate tests assert (structural, not vitest's union). */
type CoverageView = {
  readonly include?: readonly string[];
  readonly thresholds?: Record<string, unknown>;
  readonly reportsDirectory?: string;
};




const packageRoot = resolve(import.meta.dirname, '..', '..');
const repositoryRoot = resolve(packageRoot, '..', '..');
const workflowPath = resolve(repositoryRoot, '.github', 'workflows', 'colp-ci.yml');
const workflowsDirectory = resolve(repositoryRoot, '.github', 'workflows');
/** Recursively lists every TypeScript source under a directory, as repo-relative paths. */
function collectMcpSourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...collectMcpSourceFiles(full));
    else if (entry.isFile() && entry.name.endsWith('.ts')) files.push(relativeSrc(full));
  }
  return files;
}

/** Converts an absolute src path to a repo-relative 'src/mcp/...' path. */
function relativeSrc(file: string): string {
  const root = resolve(packageRoot, 'src');
  const rel = file.slice(root.length + 1).replaceAll('\\', '/');
  return `src/${rel}`;
}

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
  strategy?: Readonly<{
    'fail-fast'?: boolean;
    matrix?: Readonly<{
      domain?: readonly string[] | string;
    }>;
  }>;
  outputs?: Readonly<Record<string, string>>;
  steps?: readonly WorkflowStep[];
}>;

type Workflow = Readonly<{
  on?: Readonly<Record<string, unknown>>;
  jobs?: Readonly<Record<string, WorkflowJob>>;
}>;

const requiredCoreMutationTests = [
  'tests/semantic/**/*.test.ts',
  'tests/core/core-0025-position-ascii-octet-order-contract.test.ts',
  'tests/core/core-0027-snapshot-derived-index-contract.test.ts',
  'tests/core/optional-canonical-url-contract.test.ts',
  'tests/core/sensitive-url-preservation-contract.test.ts',
  'tests/core/url-hash-dedup-hint-contract.test.ts',
  'tests/core/url-hash-matches-preserved-url-contract.test.ts',
  'tests/schema/bookmark-url-contract.test.ts',
  'tests/schema/core-extension-namespace-uri-contract.test.ts',
  'tests/server/contracts.test.ts',
  'tests/server/pub-0018-endpoint-dto.test.ts',
  'tests/property/core-state-properties.test.ts',
  'tests/publisher/**/*.test.ts',
] as const;

const requiredCoreMutationSources = [
  'src/semantic/snapshot.ts',
  'src/semantic/snapshot-visibility.ts',
  'src/shared/query.ts',
  'src/publisher/index.ts',
] as const;

describe('MCP quality gate configuration', () => {
  it('enforces an MCP-specific non-regression floor under the repository target', () => {
    const coverage = coverageConfig.test?.coverage as CoverageView | undefined;

    expect(coverage?.include).toContain('src/mcp/**/*.ts');
    expect(coverage?.thresholds).toMatchObject({
      branches: 90,
      functions: 95,
      lines: 95,
      'src/mcp/**': {
        branches: 90,
        functions: 98,
        lines: 95,
        statements: 93,
      },
    });
    expect(coverageConfig.test?.include).toContain('tests/**/*.test.ts');
  });

  it('mutates all MCP sources using the MCP contract tests and existing mutation floor', () => {
    expect(mcpMutationConfig.mutate).toEqual(['src/mcp/**/*.ts']);
    expect(mcpMutationConfig.testFiles).toEqual(['tests/mcp/**/*.test.ts']);
    expect(mcpMutationConfig.vitest).toEqual({ configFile: 'vitest.mutation.config.ts' });
    expect(mcpTestConfig.test?.include).toEqual(['tests/mcp/**/*.test.ts']);
    expect(mcpMutationConfig.thresholds).toEqual({ high: 80, low: 65, break: 65 });
    expect(mcpMutationConfig.coverageAnalysis).toBe('perTest');
    expect(mcpMutationConfig.concurrency).toBe('100%');
  });

  it('partitions every MCP source exactly once across bounded local Stryker shards', () => {
    const shardConfigs = [
      mcpChangePlanMutationConfig,
      mcpWriteMutationConfig,
      mcpReadMutationConfig,
    ];
    const assignedSources = shardConfigs.flatMap(({ mutate }) => mutate as readonly string[]);
    const actualSources = collectMcpSourceFiles(resolve(packageRoot, 'src', 'mcp')).sort();

    expect([...assignedSources].sort()).toEqual(actualSources);
    expect(new Set(assignedSources).size).toBe(assignedSources.length);
    expect(packageJson.scripts?.['test:mutation:mcp-change-plan']).toBe(
      'stryker run stryker.mcp.change-plan.config.mjs',
    );
    expect(packageJson.scripts?.['test:mutation:mcp-write']).toBe(
      'stryker run stryker.mcp.write.config.mjs',
    );
    expect(packageJson.scripts?.['test:mutation:mcp-read']).toBe(
      'stryker run stryker.mcp.read.config.mjs',
    );
    for (const config of shardConfigs) {
      expect(config.vitest).toEqual({ configFile: 'vitest.mutation.config.ts' });
      expect(config.testFiles).toEqual(['tests/mcp/**/*.test.ts']);
      expect(config.thresholds).toEqual({ high: 80, low: 65, break: 65 });
      expect(config.concurrency).toBe('100%');
      expect(config.reporters).toContain('json');
      expect(config.jsonReporter.fileName).toBe(
        `reports/mutation/${String(config.htmlReporter.fileName).split('/')[2]}/mutation.json`,
      );
    }
  });

  it('keeps mutation dry runs inside the package sandbox', () => {
    expect(coreMutationConfig.vitest).toEqual({ configFile: 'vitest.mutation.config.ts' });
    expect(mcpMutationConfig.vitest).toEqual({ configFile: 'vitest.mutation.config.ts' });
    expect(securityMutationConfig.vitest).toEqual({ configFile: 'vitest.mutation.config.ts' });
    expect(syncMutationConfig.vitest).toEqual({ configFile: 'vitest.mutation.config.ts' });
    expect(feedMutationConfig.vitest).toEqual({ configFile: 'vitest.mutation.config.ts' });
    expect(schemaMutationConfig.vitest).toEqual({ configFile: 'vitest.mutation.config.ts' });
    expect(publisherMutationConfig.vitest).toEqual({ configFile: 'vitest.mutation.config.ts' });
    expect(coreMutationConfig.mutate).toEqual([...requiredCoreMutationSources]);
    expect(coreMutationConfig.testFiles).toEqual([...requiredCoreMutationTests]);
    expect(coreMutationConfig.jsonReporter).toEqual({
      fileName: 'reports/mutation/core/mutation.json',
    });
    expect(securityMutationConfig.concurrency).toBe('100%');
    expect(securityMutationConfig.jsonReporter).toEqual({
      fileName: 'reports/mutation/security/mutation.json',
    });
    expect(syncMutationConfig.concurrency).toBe('100%');
    expect(syncMutationConfig.jsonReporter).toEqual({
      fileName: 'reports/mutation/sync/mutation.json',
    });
    expect(feedMutationConfig.mutate).toEqual(['src/feed/**/*.ts']);
    expect(feedMutationConfig.jsonReporter).toEqual({
      fileName: 'reports/mutation/feed/mutation.json',
    });
    expect(schemaMutationConfig.mutate).toEqual(['src/schema/**/*.ts']);
    expect(schemaMutationConfig.jsonReporter).toEqual({
      fileName: 'reports/mutation/schema/mutation.json',
    });
    expect(mutationSandboxExcludes).toEqual([
      'tests/conformance/cfi-010-release-evidence-gate.test.ts',
      'tests/conformance/r02-mcp-write-progress-boundary-contract.test.ts',
      'tests/mcp/t01-quality-gates-contract.test.ts',
      'tests/sync/sync-core-quality-gates-contract.test.ts',
    ]);
  });

  it('defines critical and release mutation aggregates over the required partitions', () => {
    expect(packageJson.scripts?.['test:mutation']).toBe('npm run test:mutation:critical');
    expect(packageJson.scripts?.['test:mutation:mcp']).toBe('stryker run stryker.mcp.config.mjs');
    expect(packageJson.scripts?.['test:mutation:security']).toBe(
      'stryker run stryker.security.config.mjs',
    );
    expect(packageJson.scripts?.['test:mutation:sync']).toBe('stryker run stryker.sync.config.mjs');
    expect(packageJson.scripts?.['test:mutation:feed']).toBe('stryker run stryker.feed.config.mjs');
    expect(packageJson.scripts?.['test:mutation:schema']).toBe('stryker run stryker.schema.config.mjs');

    const critical = packageJson.scripts?.['test:mutation:critical'] ?? '';
    expect(critical).toBe(
      'npm run test:mutation:core && npm run test:mutation:mcp && npm run test:mutation:security && npm run test:mutation:sync && npm run test:mutation:feed && npm run test:mutation:schema',
    );
    expect(critical).toContain('test:mutation:core');
    expect(critical).toContain('test:mutation:mcp');
    expect(critical).toContain('test:mutation:security');
    expect(critical).toContain('test:mutation:sync');
    expect(critical).toContain('test:mutation:feed');
    expect(critical).toContain('test:mutation:schema');
    expect(critical).not.toContain('test:mutation:mcp-change-plan');
    expect(critical).not.toContain('test:mutation:mcp-write');
    expect(critical).not.toContain('test:mutation:mcp-read');

    const release = packageJson.scripts?.['test:mutation:release'] ?? '';
    expect(release).toContain('test:mutation:critical');
    expect(release).toContain('test:mutation:publisher');
    expect(release).toContain('test:mutation:publication');
  });

  it('keeps mutation testing out of every GitHub Actions workflow', () => {
    const workflow = parse(readFileSync(workflowPath, 'utf8')) as Workflow;
    const changes = workflow.jobs?.changes;
    const ciGate = workflow.jobs?.['ci-gate'];
    const forbiddenMutationTesting = /test:mutation|stryker|mutation-report|mutation-(?:critical|summary|release)/u;
    const workflowFiles = readdirSync(workflowsDirectory)
      .filter((name) => /\.ya?ml$/u.test(name));

    expect(workflowFiles).not.toContain('colp-release-mutation.yml');
    for (const name of workflowFiles) {
      expect(readFileSync(resolve(workflowsDirectory, name), 'utf8')).not.toMatch(
        forbiddenMutationTesting,
      );
    }
    expect(Object.keys(changes?.outputs ?? {})).not.toContain('mutation');
    expect(Object.keys(changes?.outputs ?? {})).not.toContain('mutation_matrix');
    expect(Object.keys(workflow.jobs ?? {})).not.toContain('mutation-critical');
    expect(Object.keys(workflow.jobs ?? {})).not.toContain('mutation-summary');
    expect(Array.isArray(ciGate?.needs) ? ciGate.needs : []).not.toContain('mutation-critical');
  });

  it('runs an independent Security coverage gate after Publisher and before build', () => {
    const securityCoverage = securityCoverageConfig.test?.coverage as CoverageView | undefined;

    expect(packageJson.scripts?.['test:coverage:security']).toBe(
      'vitest run --config vitest.security.config.ts --coverage',
    );
    expect(securityCoverageConfig.test?.include).toEqual(['tests/security/**/*.test.ts']);
    expect(securityCoverage?.reportsDirectory).toBe('coverage/security');
    expect(securityCoverage?.include).toEqual(['src/security/**/*.ts']);
    expect(securityCoverage?.thresholds).toEqual({
      branches: 90,
      functions: 98,
      lines: 95,
      statements: 90,
    });

    const check = packageJson.scripts?.check ?? '';
    const publisherIdx = check.indexOf('npm run test:coverage:publisher');
    const securityIdx = check.indexOf('npm run test:coverage:security');
    const syncCoreIdx = check.indexOf('npm run test:coverage:sync-core');
    const buildIdx = check.indexOf('npm run build');
    const packIdx = check.indexOf('npm run pack:check');
    const mcpLegacyIdx = check.indexOf('npm run check:mcp-legacy-absence');
    expect(publisherIdx).toBeGreaterThan(-1);
    expect(securityIdx).toBeGreaterThan(publisherIdx);
    expect(syncCoreIdx).toBeGreaterThan(securityIdx);
    expect(buildIdx).toBeGreaterThan(syncCoreIdx);
    expect(packIdx).toBeGreaterThan(buildIdx);
    expect(mcpLegacyIdx).toBeGreaterThan(packIdx);
    expect(check).not.toContain('test:mutation');
    expect(check).not.toContain('benchmark');
  });
});
