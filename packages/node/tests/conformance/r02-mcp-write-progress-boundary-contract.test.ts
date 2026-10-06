import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { releaseEvidenceMutablePaths } from '../../scripts/lib/conformance-evidence.mjs';

const packageRoot = resolve(import.meta.dirname, '..', '..');
const repositoryRoot = resolve(packageRoot, '..', '..');
const progressPath = resolve(packageRoot, 'docs', 'progress', 'MCP_WRITE.md');
const workflowPath = resolve(repositoryRoot, '.github', 'workflows', 'colp-ci.yml');
const actionPins = JSON.parse(
  readFileSync(resolve(repositoryRoot, 'scripts/github-action-pins.json'), 'utf8'),
) as Record<string, { sha: string }>;
// The action pin manifest is a checked-in contract; assert its required
// checkout entry before reading the SHA so strict TypeScript does not treat
// the indexed value as possibly undefined.
const checkoutUses = `actions/checkout@${actionPins['actions/checkout']!.sha}`;
const mcpEvidenceArtifactPaths = Object.freeze([
  'packages/node/src/conformance/generated/mcp-conformance-candidate.json',
  'packages/node/src/conformance/generated/mcp-2026-07-28-sdk-accepted.json',
] as const);
const processContractsWhen = "needs.changes.outputs.full == 'true' || needs.changes.outputs.quality == 'true' || needs.changes.outputs.evidence == 'true'";
const shallowCloneJobs = Object.freeze([
  'publisher-coverage',
  'security-coverage',
  'sync-core-coverage',
  'package',
  'dependency-audit',
] as const);
const sourceRevision = '75152a1ff65d76faa8320740cfbfa3abd92a0fae';
const boundaryCommit = '3bc83563e051639cf52f47a49f9ec5707ad42cbe';
const requirements = ['MCP-0003', 'MCP-0004', 'MCP-0005', 'MCP-0007'] as const;
type Workflow = Readonly<{
  jobs?: Readonly<Record<string, Readonly<{
    steps?: readonly Readonly<{
      id?: string;
      name?: string;
      uses?: string;
      run?: string;
      if?: string;
      with?: Readonly<Record<string, unknown>>;
    }>[];
  }>>>;
}>;

type PathFilters = Readonly<{
  quality?: readonly string[];
  evidence?: readonly string[];
}>;

function matchGitHubPathGlob(pattern: string, file: string): boolean {
  if (pattern.endsWith('/**')) {
    const prefix = pattern.slice(0, -2);
    return file.startsWith(prefix);
  }
  return file === pattern;
}

function pathsFilterMatches(patterns: readonly string[], files: readonly string[]): boolean {
  const positives = patterns.filter((pattern) => !pattern.startsWith('!'));
  const negatives = patterns.filter((pattern) => pattern.startsWith('!')).map((pattern) => pattern.slice(1));
  return files.some(
    (file) =>
      positives.some((pattern) => matchGitHubPathGlob(pattern, file))
      && !negatives.some((pattern) => matchGitHubPathGlob(pattern, file)),
  );
}

function workflowPathFilters(workflow: Workflow): PathFilters {
  const filtersSource = workflow.jobs?.changes?.steps?.find(({ id }) => id === 'filter')?.with?.filters;
  expect(typeof filtersSource, 'changes job must declare dorny/paths-filter filters').toBe('string');
  return parse(filtersSource as string) as PathFilters;
}

function tableRows(source: string): readonly (readonly string[])[] {
  return source
    .split(/\r?\n/u)
    .filter((line) => line.startsWith('|') && line.endsWith('|'))
    .map((line) => line.slice(1, -1).split('|').map((cell) => cell.trim()));
}

function section(source: string, heading: string): string {
  const exactHeading = `## ${heading}`;
  const start = source.indexOf(exactHeading);
  expect(start, `progress must contain ${exactHeading}`).toBeGreaterThanOrEqual(0);
  const rest = source.slice(start + exactHeading.length);
  const next = rest.search(/\n##\s+/u);
  return rest.slice(0, next < 0 ? rest.length : next);
}

function requirementSection(source: string, requirement: string): string {
  const exactHeading = `### ${requirement}`;
  const start = source.indexOf(exactHeading);
  expect(start, `progress must contain ${exactHeading}`).toBeGreaterThanOrEqual(0);
  const rest = source.slice(start + exactHeading.length);
  const next = rest.search(/\n#{2,3}\s+/u);
  return rest.slice(0, next < 0 ? rest.length : next);
}

// The original parent-history audit is preserved in docs/history/ at the repository root.
describe('R-02 standalone MCP Write process contract', () => {
  const progress = readFileSync(progressPath, 'utf8');

  it('reports current history, evidence, process exception, and Profile claim separately', () => {
    const rows = tableRows(progress);
    const header = rows.find(([first]) => first === 'Requirement');
    expect(header).toEqual([
      'Requirement',
      'Implementation history',
      'Release evidence',
      'Current review status',
      'Package Profile claim',
    ]);
    for (const requirement of requirements) {
      const matches = rows.filter(([first]) => first === `\`${requirement}\``);
      expect(matches, requirement).toHaveLength(1);
      expect(matches[0]?.[1]).toMatch(/mixed/i);
      expect(matches[0]?.[2]).toMatch(/accepted|verified/i);
      expect(matches[0]?.[3]).toMatch(/accepted/i);
      expect(matches[0]?.[4]).toMatch(/2026-07-28/i);
      expect(matches[0]?.[4]).toMatch(/accepted|restored|supported/i);
      expect(matches[0]?.[4]).not.toBe('Package supported; deployment probes required');
    }
  });

  it('records an explicit historical process exception instead of claiming independent acceptance was restored', () => {
    const exception = section(progress, 'Historical process exception');
    expect(exception).toMatch(/process\s+non[- ]compliance/i);
    expect(exception).toMatch(/per[- ]Requirement[\s\S]*(?:independent|separate)[\s\S]*(?:accepted|acceptance)/i);
    expect(exception).toMatch(/does\s+not\s+satisfy|cannot[\s\S]*(?:retroactively|restore)|not\s+recoverable/i);
  });

  it('retains the historical standalone source and boundary commits', () => {
    expect(progress).toContain(sourceRevision);
    expect(progress).toContain(boundaryCommit);
  });

  it('checks out the complete Git history in the CI job that runs this contract', () => {
    const workflow = parse(readFileSync(workflowPath, 'utf8')) as Workflow;
    const checkout = workflow.jobs?.static?.steps?.find(
      ({ uses }) => uses === checkoutUses,
    );
    const releaseEvidenceCheckout = workflow.jobs?.['release-evidence']?.steps?.find(
      ({ uses }) => uses === checkoutUses,
    );
    const processContracts = workflow.jobs?.static?.steps?.find(
      ({ run }) => run === 'npm run test:process-contracts',
    );

    expect(checkout, 'static job must check out the repository').toBeDefined();
    expect(checkout?.with?.['fetch-depth'], 'release evidence needs standalone ancestry').toBe(0);
    expect(releaseEvidenceCheckout?.with?.['fetch-depth']).toBe(0);
    expect(processContracts?.if).toBe(processContractsWhen);

    for (const jobName of shallowCloneJobs) {
      const job = workflow.jobs?.[jobName];
      const shallowCheckout = job?.steps?.find(({ uses }) => uses === checkoutUses);
      expect(shallowCheckout?.with?.['fetch-depth'] ?? 1, jobName).not.toBe(0);
      expect(
        job?.steps?.some((step) => step.run?.includes('test:process-contracts') === true),
        jobName,
      ).toBe(false);
    }
  });

  it('routes MCP acceptance JSON through evidence-only CI without quality jobs', () => {
    const workflow = parse(readFileSync(workflowPath, 'utf8')) as Workflow;
    const filters = workflowPathFilters(workflow);
    const quality = filters.quality ?? [];
    const evidence = filters.evidence ?? [];

    expect(releaseEvidenceMutablePaths).toEqual(expect.arrayContaining([...mcpEvidenceArtifactPaths]));
    for (const path of releaseEvidenceMutablePaths) {
      expect(quality, path).toContain(`!${path}`);
      expect(evidence, path).toContain(path);
    }
    expect(pathsFilterMatches(quality, mcpEvidenceArtifactPaths)).toBe(false);
    expect(pathsFilterMatches(evidence, mcpEvidenceArtifactPaths)).toBe(true);
    expect(pathsFilterMatches(quality, releaseEvidenceMutablePaths)).toBe(false);
    expect(pathsFilterMatches(evidence, releaseEvidenceMutablePaths)).toBe(true);
    expect(pathsFilterMatches(quality, ['packages/node/src/index.ts'])).toBe(true);
    expect(pathsFilterMatches(evidence, ['packages/node/src/index.ts'])).toBe(false);
  });

  it('gives each Requirement a primary, test-only/mixed classification, and remediation mapping', () => {
    const records = section(progress, 'Requirement records');
    for (const requirement of requirements) {
      const record = requirementSection(records, requirement);
      expect(record, requirement).toContain('3bb2b2c');
      expect(record, requirement).toMatch(/primary\s+implementation|implementation\s+commit/i);
      expect(record, requirement).toMatch(/test[- ]only|mixed\s+implementation|no\s+independent\s+test/i);
      expect(record, requirement).toMatch(/hardening|remediation/);
      expect(record, requirement).toMatch(/[0-9a-f]{7,40}/i);
    }
  });

  it('keeps process metadata out of Requirement evidence and avoids R-02 self-reference', () => {
    expect(readFileSync(resolve(import.meta.dirname, 'r02-mcp-write-progress-boundary-contract.test.ts'), 'utf8'))
      .not.toContain(['[', 'evidence', ':'].join(''));
    expect(progress).toMatch(/R-02[^\n]*(?:subject|boundary|process)/i);
    expect(progress).not.toMatch(/R-02[^\n]*[0-9a-f]{40}/i);
    expect(section(progress, 'Historical evidence revision boundary')).toMatch(
      /earlier external-evidence model[\s\S]*repository-tracked[\s\S]*(?:quarantin|revoked)/i,
    );
  });
});
