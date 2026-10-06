import { execFile } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

import { parse } from 'yaml';
import { readEvidenceReportRegistry } from '../../scripts/lib/evidence-report-registry.mjs';
import { describe, expect, it } from 'vitest';

import {
  collectPassingTestIds,
  generateVerifiedEvidence,
  releaseEvidenceMutablePaths,
  releaseEvidenceProtectedPaths,
  requiredRequirementIdsForProfile,
  requirementsDigest,
  validateRequirementRegistry,
  verifyRepositoryState,
  verifyTrackedEvidenceRepositoryState,
} from '../../scripts/lib/conformance-evidence.mjs';
import {
  evidenceVitestArguments,
  processOnlyEvidenceTestPaths,
} from '../../scripts/lib/evidence-test-suite.mjs';

const execFileAsync = promisify(execFile);
const registryPath = resolve(import.meta.dirname, '..', '..', 'fixtures', 'protocol', 'requirements.yaml');
const packagePath = resolve(import.meta.dirname, '..', '..', 'package.json');
const packageRoot = resolve(import.meta.dirname, '..', '..');
const testsRoot = resolve(import.meta.dirname, '..');
const inventoryTestPath = resolve(import.meta.dirname, 'evidence-generation.test.ts');
const focusedRegistry = {
  version: '0.1',
  requirements: [{ id: 'CORE-0001', tests: ['core.two-stage-validation'] }],
};

async function testSourcePaths(directory = testsRoot): Promise<readonly string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const paths: string[] = [];
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      paths.push(...await testSourcePaths(path));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      paths.push(path);
    }
  }
  return paths.sort();
}

async function evidenceIdsDeclaredInTestSources(): Promise<ReadonlySet<string>> {
  const ids = new Set<string>();
  for (const path of await testSourcePaths()) {
    if (path === inventoryTestPath) continue;
    const source = await readFile(path, 'utf8');
    for (const match of source.matchAll(/\[evidence:([a-z0-9][a-z0-9._:-]*)\]/gu)) {
      ids.add(match[1]!);
    }

    const declarations = source.matchAll(
      /const\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(['"`])(?:\[evidence:([a-z0-9][a-z0-9._:-]*)\]|([a-z0-9][a-z0-9._:-]*))\2\s*;/gu,
    );
    for (const match of declarations) {
      const variable = match[1]!;
      const hasCompleteTag = match[3] !== undefined;
      const id = (match[3] ?? match[4])!;
      if (
        (hasCompleteTag && source.includes('${' + variable + '}'))
        || (!hasCompleteTag && source.includes('[evidence:${' + variable + '}]'))
      ) {
        ids.add(id);
      }
    }
  }
  return ids;
}

async function evidenceContext() {
  const [registrySource, packageSource] = await Promise.all([
    readFile(registryPath, 'utf8'),
    readFile(packagePath, 'utf8'),
  ]);
  const registry = parse(registrySource);
  const packageJson = JSON.parse(packageSource);
  return {
    registry,
    context: {
      protocolVersion: String(registry.version),
      packageVersion: packageJson.version,
      requirementsDigest: requirementsDigest(registry),
      requirements: registry.requirements,
    },
  };
}

function cleanGit(head: string) {
  return async (arguments_: readonly string[]) => arguments_[0] === 'rev-parse' ? `${head}\n` : '';
}

async function generate(report: unknown, sourceRevision?: string) {
  const registry = focusedRegistry;
  const context = {
    protocolVersion: String(registry.version),
    packageVersion: 'evidence-generation-test',
    requirementsDigest: requirementsDigest(registry),
    requirements: registry.requirements,
  };
  const head = await currentRevision();
  return generateVerifiedEvidence({
    registry,
    context,
    sourceRevision: sourceRevision ?? head,
    repositoryRoot: resolve(import.meta.dirname, '..', '..', '..', '..'),
    runGit: cleanGit(head),
    runTests: async () => JSON.stringify(report),
  });
}

async function currentRevision(): Promise<string> {
  const { stdout } = await execFileAsync('git', ['rev-parse', '--verify', 'HEAD^{commit}'], {
    cwd: resolve(import.meta.dirname, '..', '..', '..', '..'),
  });
  return stdout.trim();
}

describe('conformance evidence generation', () => {
  it('accepts every evidence ID declared by the real test source inventory', async () => {
    const registry = await readEvidenceReportRegistry(packageRoot);
    const sourceIds = await evidenceIdsDeclaredInTestSources();
    const report = {
      success: true,
      testResults: [{
        assertionResults: [...sourceIds].map((id) => ({
          fullName: `real source inventory [evidence:${id}]`,
          status: 'passed',
        })),
      }],
    };

    const registeredIds = new Set(registry.requirements.flatMap((requirement) => requirement.tests ?? []));
    expect([...registeredIds].filter((id) => !sourceIds.has(id))).toEqual([]);
    expect(sourceIds.has('sync.authoritative-pull-effects')).toBe(true);
    expect(sourceIds.has('sync.canonical-subpath')).toBe(true);
    expect(sourceIds.has('http.protocol-json-media')).toBe(true);
    expect(sourceIds.has('feed.cfi-001.deep-immutability')).toBe(true);
    expect(sourceIds.has('feed.cfi-003.poll-deadlines')).toBe(true);
    expect(collectPassingTestIds(report, registry)).toEqual(sourceIds);
  }, 30_000);

  it('validates cross-version reports without expanding a certificate version', async () => {
    const { registry, context } = await evidenceContext();
    const reportRegistry = await readEvidenceReportRegistry(packageRoot);
    const report = { success: true, testResults: [{ assertionResults: [
      { fullName: '[evidence:sync.authoritative-pull-effects]', status: 'passed' },
    ] }] };
    const head = await currentRevision();
    const artifact = await generateVerifiedEvidence({ registry, reportRegistry, context,
      sourceRevision: head, repositoryRoot: resolve(packageRoot, '..', '..'), runGit: cleanGit(head),
      runTests: async () => JSON.stringify(report) });
    expect(artifact.protocolVersion).toBe('0.1');
    expect(artifact.requirementsDigest).toBe(requirementsDigest(registry));
    expect(artifact.passedRequirementIds).not.toContain('SYNC-0027');
    expect(artifact.passedRequirementIds).not.toContain('SYNC-0028');
    expect(() => collectPassingTestIds({ ...report, testResults: [{ assertionResults: [
      { fullName: '[evidence:sync.unregistered]', status: 'passed' },
    ] }] }, reportRegistry)).toThrow(/Unknown evidence test ID/u);
    expect(() => collectPassingTestIds({ ...report, testResults: [{ assertionResults: [
      { fullName: '[evidence:sync.authoritative-pull-effects]', status: 'failed' },
    ] }] }, reportRegistry)).toThrow(/did not pass/u);
  });

  it('validates the real Registry and its transitive Feed Required closure', async () => {
    const { registry } = await evidenceContext();
    const feedRequiredIds = requiredRequirementIdsForProfile(registry, 'feed');
    type RegistryRequirement = { id: string; profile: string; level: string };
    const requirementsById = new Map(
      (registry.requirements as RegistryRequirement[]).map(
        (requirement) => [requirement.id, requirement] as const,
      ),
    );

    expect(validateRequirementRegistry(registry)).toEqual([]);
    expect(feedRequiredIds).toEqual(expect.arrayContaining(['CORE-0001', 'PUB-0001', 'FEED-0001']));
    expect(new Set(feedRequiredIds.map((id) => requirementsById.get(id)?.profile))).toEqual(
      new Set(['core', 'publication', 'feed']),
    );
    expect(feedRequiredIds.every((id) => {
      const level = requirementsById.get(id)?.level;
      return level === 'MUST' || level === 'MUST_NOT';
    })).toBe(true);
  });

  it.each([
    ['a failed report', { success: false, testResults: [] }],
    ['a report without testResults', { success: true }],
    ['a report with non-array testResults', { success: true, testResults: {} }],
  ] as const)('rejects %s before collecting evidence IDs', (_label, report) => {
    expect(() => collectPassingTestIds(report, { requirements: [] }))
      .toThrow(/incomplete or not successful/u);
  });

  it.each([
    ['failed', 'failed'],
    ['skipped', 'skipped'],
    ['missing', undefined],
  ] as const)('rejects a tagged assertion with %s status', (_label, status) => {
    const report = {
      success: true,
      testResults: [{
        assertionResults: [{
          fullName: 'tagged assertion [evidence:known.test]',
          status,
        }],
      }],
    };
    const knownRegistry = {
      requirements: [{ id: 'KNOWN', tests: ['known.test'] }],
    };

    expect(() => collectPassingTestIds(report, knownRegistry)).toThrow(/did not pass/u);
  });

  it('excludes only marker-free process contracts from the owned evidence suite', async () => {
    expect(processOnlyEvidenceTestPaths).toEqual([
      'tests/conformance/r01-bundled-evidence-revision-contract.test.ts',
      'tests/conformance/r02-mcp-write-progress-boundary-contract.test.ts',
    ]);
    const marker = ['[', 'evidence', ':'].join('');
    for (const path of processOnlyEvidenceTestPaths) {
      expect(await readFile(resolve(packageRoot, path), 'utf8'), path).not.toContain(marker);
    }

    expect(evidenceVitestArguments('report.json')).toEqual([
      'run',
      '--reporter=default',
      '--reporter=json',
      '--outputFile',
      'report.json',
      '--exclude',
      processOnlyEvidenceTestPaths[0],
      '--exclude',
      processOnlyEvidenceTestPaths[1],
    ]);
    expect(evidenceVitestArguments('report.json', true)).toEqual([
      'run',
      '--coverage',
      '--reporter=default',
      '--reporter=json',
      '--outputFile',
      'report.json',
      '--exclude',
      processOnlyEvidenceTestPaths[0],
      '--exclude',
      processOnlyEvidenceTestPaths[1],
    ]);
  });

  it('derives passed Requirement IDs from a successful Vitest JSON report', async () => {
    const artifact = await generate({
        success: true,
        testResults: [
          {
            assertionResults: [
              { fullName: 'wire validation [evidence:core.two-stage-validation]', status: 'passed' },
            ],
          },
        ],
    });
    expect(artifact.passedRequirementIds).toEqual(['CORE-0001']);
    expect(artifact.reportDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
  });

  it('aggregates repeated evidence IDs inherited by an expanded test suite', async () => {
    const artifact = await generate({
        success: true,
        testResults: [{
          assertionResults: [
            { fullName: 'suite [evidence:core.two-stage-validation] > case one', status: 'passed' },
            { fullName: 'suite [evidence:core.two-stage-validation] > case two', status: 'passed' },
          ],
        }],
    });
    expect(artifact.passedRequirementIds).toEqual(['CORE-0001']);
  });

  it('rejects an evidence ID when any inherited occurrence did not pass', async () => {
    await expect(generate({
        success: true,
        testResults: [{
          assertionResults: [
            { fullName: 'suite [evidence:core.two-stage-validation] > passing case', status: 'passed' },
            { fullName: 'suite [evidence:core.two-stage-validation] > skipped case', status: 'skipped' },
          ],
        }],
    })).rejects.toThrow(/Evidence test did not pass/u);
  });

  it('rejects evidence IDs that are not registered', async () => {
    await expect(generate({
        success: true,
        testResults: [
          {
            assertionResults: [
              { fullName: 'fake [evidence:not.registered]', status: 'passed' },
            ],
          },
        ],
    })).rejects.toThrow(/Unknown evidence test ID/u);
  });

  it('rejects a hexadecimal revision that is not the tested repository HEAD', async () => {
    await expect(generate({ success: true, testResults: [] }, 'deadbeef'))
      .rejects.toThrow(/must equal the repository HEAD/u);
  });

  it('rejects verified evidence when Git reports worktree changes', async () => {
    const head = await currentRevision();
    await expect(verifyRepositoryState(
      head,
      resolve(import.meta.dirname, '..', '..', '..', '..'),
      async (arguments_: readonly string[]) =>
        arguments_[0] === 'rev-parse' ? head : ' M src/index.ts\n',
    )).rejects.toThrow(/clean protected worktree/u);
  });

  it('checks the same clean HEAD again after the owned test runner completes', async () => {
    const { registry, context } = await evidenceContext();
    const head = await currentRevision();
    let statusCalls = 0;
    await expect(generateVerifiedEvidence({
      registry,
      context,
      sourceRevision: head,
      repositoryRoot: resolve(import.meta.dirname, '..', '..', '..', '..'),
      runGit: async (arguments_: readonly string[]) => {
        if (arguments_[0] === 'rev-parse') return head;
        statusCalls += 1;
        return statusCalls === 1 ? '' : ' M src/index.ts\n';
      },
      runTests: async (testedRevision: string) => {
        expect(testedRevision).toBe(head);
        return JSON.stringify({ success: true, testResults: [] });
      },
    })).rejects.toThrow(/clean protected worktree/u);
    expect(statusCalls).toBe(2);
  });

  it('accepts a tracked certificate when only generated evidence files changed after its source revision', async () => {
    const source = 'a'.repeat(40);
    const head = 'b'.repeat(40);
    const calls: readonly string[][] = [];
    const runGit = async (arguments_: readonly string[]) => {
      (calls as string[][]).push([...arguments_]);
      if (arguments_[0] === 'rev-parse') {
        return arguments_[2] === 'HEAD^{commit}' ? `${head}\n` : `${source}\n`;
      }
      if (arguments_[0] === 'diff') {
        return `${releaseEvidenceMutablePaths.join('\n')}\n`;
      }
      return '';
    };

    await expect(verifyTrackedEvidenceRepositoryState(
      source,
      resolve(import.meta.dirname, '..', '..', '..', '..'),
      runGit,
    )).resolves.toBe(head);
    expect(calls).toContainEqual([
      'status',
      '--porcelain=v1',
      '--untracked-files=all',
      '--',
      ...releaseEvidenceProtectedPaths,
    ]);
  });

  it('rejects protected source changes after the attested revision', async () => {
    const source = 'a'.repeat(40);
    const head = 'b'.repeat(40);
    const runGit = async (arguments_: readonly string[]) => {
      if (arguments_[0] === 'rev-parse') {
        return arguments_[2] === 'HEAD^{commit}' ? head : source;
      }
      if (arguments_[0] === 'diff') return 'packages/node/src/index.ts\n';
      return '';
    };

    await expect(verifyTrackedEvidenceRepositoryState(
      source,
      resolve(import.meta.dirname, '..', '..', '..', '..'),
      runGit,
    )).rejects.toThrow(/Protected release source changed/u);
  });

  it('rejects a tracked certificate whose source revision is not an ancestor', async () => {
    const source = 'a'.repeat(40);
    const head = 'b'.repeat(40);
    const runGit = async (arguments_: readonly string[]) => {
      if (arguments_[0] === 'rev-parse') {
        return arguments_[2] === 'HEAD^{commit}' ? head : source;
      }
      if (arguments_[0] === 'merge-base') throw new Error('not an ancestor');
      return '';
    };

    await expect(verifyTrackedEvidenceRepositoryState(
      source,
      resolve(import.meta.dirname, '..', '..', '..', '..'),
      runGit,
    )).rejects.toThrow(/must be an ancestor/u);
  });

  it('canonicalizes Registry line endings before calculating its digest', () => {
    const lf = 'version: 0.1\nrequirements:\n  - id: CORE-0001\n    tests: []\n';
    const crlf = lf.replaceAll('\n', '\r\n');
    expect(requirementsDigest(parse(lf))).toBe(requirementsDigest(parse(crlf)));
  });
});
