import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

import { supportedProfiles } from '../../src/index.js';
import {
  generateVerifiedEvidence,
  isMigratingMcpReleaseProfile,
  mcpMigrationProtocolVersion,
  mcpMigrationQuarantinedProfiles,
  registeredReleaseProfiles,
  releaseProfileDependencies,
  requiredRequirementIdsForProfile,
  requirementsDigest,
  sha256Digest,
  validateReleaseEvidenceArtifact,
  validateRequirementRegistry,
} from '../../scripts/lib/conformance-evidence.mjs';

const execFileAsync = promisify(execFile);
const packageRoot = resolve(import.meta.dirname, '..', '..');
const repositoryRoot = resolve(packageRoot, '..', '..');
const releaseGatePath = resolve(packageRoot, 'scripts', 'release-evidence-gate.mjs');
const generatorPath = resolve(packageRoot, 'scripts', 'generate-conformance-evidence.mjs');

type RequirementLevel = 'MUST' | 'MUST_NOT' | 'SHOULD' | 'SHOULD_NOT' | 'MAY';

function requirement(
  id: string,
  profile: string,
  level: RequirementLevel,
  tests: readonly string[] = [`test.${id.toLowerCase()}`],
) {
  return {
    id,
    level,
    profile,
    source: `test/${id}`,
    requirement: `${id} synthetic release requirement`,
    selector: { marker: id },
    implementation: ['test'],
    tests: [...tests],
  };
}

const registry = {
  version: '0.1',
  requirements: [
    requirement('CORE-MUST', 'core', 'MUST'),
    requirement('CORE-SHOULD', 'core', 'SHOULD'),
    requirement('PUBLICATION-MUST-NOT', 'publication', 'MUST_NOT'),
    requirement('FEED-MAY', 'feed', 'MAY'),
    requirement('FEED-MUST', 'feed', 'MUST'),
    requirement('FEED-MUST-NOT', 'feed', 'MUST_NOT'),
  ],
} as const;

const context = {
  protocolVersion: String(registry.version),
  packageVersion: 'cfi-010-test-package',
  requirementsDigest: requirementsDigest(registry),
  requirements: registry.requirements,
};

const sourceRevision = 'a'.repeat(40);
const requiredIds = requiredRequirementIdsForProfile(registry, 'feed');

function artifact(passedRequirementIds: readonly string[] = requiredIds) {
  return {
    schemaVersion: 1,
    protocolVersion: context.protocolVersion,
    packageVersion: context.packageVersion,
    sourceRevision,
    requirementsDigest: context.requirementsDigest,
    reportDigest: `sha256:${'b'.repeat(64)}`,
    passedRequirementIds: [...passedRequirementIds],
  };
}

function releaseErrors(
  candidate: unknown = artifact(),
  revision = sourceRevision,
): readonly string[] {
  return validateReleaseEvidenceArtifact(candidate, context, {
    profile: 'feed',
    sourceRevision: revision,
  });
}

describe('CFI-010 release Requirement Registry validation', () => {
  it('keeps every registered release target aligned with the public package claim', () => {
    expect(new Set(supportedProfiles)).toEqual(new Set(registeredReleaseProfiles));
    expect(registeredReleaseProfiles).toEqual(Object.keys(releaseProfileDependencies));
    expect(mcpMigrationQuarantinedProfiles).toEqual([]);
    expect(mcpMigrationProtocolVersion).toBe('2026-07-28');
  });

  it('defines the expected release dependency closure for Feed', () => {
    expect(releaseProfileDependencies.feed).toEqual(['publication']);
    expect(releaseProfileDependencies.publication).toEqual(['core']);
    expect(new Set(requiredIds)).toEqual(new Set([
      'CORE-MUST',
      'PUBLICATION-MUST-NOT',
      'FEED-MUST',
      'FEED-MUST-NOT',
    ]));
    expect(requiredIds).not.toContain('CORE-SHOULD');
    expect(requiredIds).not.toContain('FEED-MAY');
  });

  it('accepts a structurally complete Registry and permits intentional cross-Requirement test reuse', () => {
    const sharedEvidenceRegistry = {
      version: '0.1',
      requirements: [
        requirement('CORE-A', 'core', 'MUST', ['shared.evidence']),
        requirement('CORE-B', 'core', 'MUST_NOT', ['shared.evidence']),
      ],
    };

    expect(validateRequirementRegistry(registry)).toEqual([]);
    expect(validateRequirementRegistry(sharedEvidenceRegistry)).toEqual([]);
  });

  it.each([
    [
      'duplicate Requirement ID',
      { version: '0.1', requirements: [
        requirement('CORE-A', 'core', 'MUST'),
        requirement('CORE-A', 'core', 'MUST'),
      ] },
      /Duplicate Requirement ID/u,
    ],
    [
      'unsupported profile',
      { version: '0.1', requirements: [requirement('UNKNOWN', 'future', 'MUST')] },
      /unsupported profile/u,
    ],
    [
      'unsupported level',
      { version: '0.1', requirements: [{
        ...requirement('CORE-A', 'core', 'MUST'),
        level: 'REQUIRED',
      }] },
      /unsupported level/u,
    ],
    [
      'missing evidence tests',
      { version: '0.1', requirements: [{
        ...requirement('CORE-A', 'core', 'MUST'),
        tests: [],
      }] },
      /at least one evidence test ID/u,
    ],
    [
      'duplicate evidence ID inside one Requirement',
      { version: '0.1', requirements: [requirement(
        'CORE-A',
        'core',
        'MUST',
        ['shared.evidence', 'shared.evidence'],
      )] },
      /repeats evidence test ID/u,
    ],
    [
      'invalid evidence ID grammar',
      { version: '0.1', requirements: [requirement(
        'CORE-A',
        'core',
        'MUST',
        ['INVALID EVIDENCE'],
      )] },
      /invalid evidence test ID/u,
    ],
    [
      'empty implementation ownership',
      { version: '0.1', requirements: [{
        ...requirement('CORE-A', 'core', 'MUST'),
        implementation: [],
      }] },
      /implementation/u,
    ],
  ] as const)('rejects a Registry with %s', (_label, candidate, expected) => {
    expect(validateRequirementRegistry(candidate).join('\n')).toMatch(expected);
  });

  it('rejects dependency cycles before calculating Required IDs', () => {
    const dependencies = { core: ['feed'], feed: ['core'] } as const;
    const cyclicRegistry = {
      version: '0.1',
      requirements: [
        requirement('CORE-A', 'core', 'MUST'),
        requirement('FEED-A', 'feed', 'MUST'),
      ],
    };

    expect(validateRequirementRegistry(cyclicRegistry, dependencies).join('\n')).toMatch(
      /dependency cycle/u,
    );
    expect(() => requiredRequirementIdsForProfile(
      cyclicRegistry,
      'feed',
      dependencies,
    )).toThrow(/Invalid Requirement Registry/u);
  });

  it('blocks Feed release for an unrelated non-Feed Registry error', () => {
    const invalidRegistry = {
      version: '0.1',
      requirements: [
        ...registry.requirements,
        requirement('MCP-ORPHAN', 'mcp-read', 'MUST', ['INVALID ORPHAN']),
      ],
    };
    const invalidContext = {
      ...context,
      requirementsDigest: requirementsDigest(invalidRegistry),
      requirements: invalidRegistry.requirements,
    };
    const errors = validateReleaseEvidenceArtifact(
      {
        ...artifact(),
        requirementsDigest: invalidContext.requirementsDigest,
      },
      invalidContext,
      { profile: 'feed', sourceRevision },
    );

    expect(errors.join('\n')).toMatch(/Registry:.*MCP-ORPHAN.*invalid evidence test ID/us);
  });
});

describe('CFI-010 Feed release evidence completeness', () => {
  it('accepts only when every transitive Required Requirement passed', () => {
    expect(releaseErrors()).toEqual([]);
  });

  it.each(requiredIds)(
    'rejects Feed release when Required record %s is missing',
    (missingId) => {
      const passed = requiredIds.filter((id) => id !== missingId);
      expect(releaseErrors(artifact(passed)).join('\n')).toContain(missingId);
    },
  );

  it('does not require SHOULD or MAY records for the release Required gate', () => {
    expect(releaseErrors(artifact(requiredIds))).toEqual([]);
  });

  it.each([
    ['empty unverified artifact', {
      ...artifact([]),
      sourceRevision: 'unverified',
      reportDigest: undefined,
    }, /empty or unverified/u],
    ['revision mismatch', artifact(), /attested source revision/u, 'c'.repeat(40)],
    ['requirements digest mismatch', {
      ...artifact(),
      requirementsDigest: `sha256:${'d'.repeat(64)}`,
    }, /requirementsDigest/u],
    ['package mismatch', { ...artifact(), packageVersion: 'other-package' }, /packageVersion/u],
    ['protocol mismatch', { ...artifact(), protocolVersion: '9.9' }, /protocolVersion/u],
    ['missing report digest', { ...artifact(), reportDigest: undefined }, /report digest|reportDigest/u],
    ['malformed report digest', {
      ...artifact(),
      reportDigest: `sha256:${'z'.repeat(64)}`,
    }, /report digest|reportDigest/u],
    ['unknown passed Requirement', artifact([...requiredIds, 'UNKNOWN']), /Unknown passed/u],
    ['duplicate passed Requirement', artifact([...requiredIds, requiredIds[0]!]), /Duplicate/u],
  ] as const)('rejects %s', (_label, candidate, expected, revision = sourceRevision) => {
    expect(releaseErrors(candidate, revision).join('\n')).toMatch(expected);
  });
});

describe('CFI-010 generator-owned clean candidate integration', () => {
  it('derives an artifact from a real clean source revision without self-reference', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'colp-cfi-010-'));
    const candidateRoot = join(sandbox, 'candidate');
    const artifactRoot = join(sandbox, 'artifacts');
    await mkdir(candidateRoot);
    await mkdir(artifactRoot);
    const runGit = async (arguments_: readonly string[], cwd = candidateRoot): Promise<string> => {
      const { stdout } = await execFileAsync('git', [...arguments_], {
        cwd,
        encoding: 'utf8',
      });
      return stdout;
    };

    try {
      await runGit(['init']);
      await runGit(['config', 'user.email', 'cfi-010@example.invalid']);
      await runGit(['config', 'user.name', 'CFI-010 Test']);
      await writeFile(join(candidateRoot, 'candidate.txt'), 'clean release candidate\n', 'utf8');
      await runGit(['add', 'candidate.txt']);
      await runGit(['commit', '-m', 'clean candidate']);
      const head = (await runGit(['rev-parse', '--verify', 'HEAD^{commit}'])).trim();
      const reportSource = JSON.stringify({
        success: true,
        testResults: [{
          assertionResults: registry.requirements.flatMap((item) =>
            item.tests.map((testId) => ({
              fullName: `owned report [evidence:${testId}]`,
              status: 'passed',
            }))),
        }],
      });
      const generated = await generateVerifiedEvidence({
        registry,
        context,
        sourceRevision: head,
        repositoryRoot: candidateRoot,
        runGit,
        runTests: async (testedRevision: string) => {
          expect(testedRevision).toBe(head);
          return reportSource;
        },
      });
      const artifactPath = join(artifactRoot, 'feed-evidence.json');
      await writeFile(artifactPath, `${JSON.stringify(generated)}\n`, 'utf8');
      const temporaryArtifact = JSON.parse(await readFile(artifactPath, 'utf8'));

      expect(generated.reportDigest).toBe(sha256Digest(reportSource));
      expect(validateReleaseEvidenceArtifact(temporaryArtifact, context, {
        profile: 'feed',
        sourceRevision: head,
      })).toEqual([]);
      expect((await runGit([
        'status',
        '--porcelain=v1',
        '--untracked-files=all',
      ])).trim()).toBe('');
      expect(artifactPath.startsWith(candidateRoot)).toBe(false);
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  }, 30_000);
});

describe('CFI-010 release CLI and publication surface', () => {
  it.each(supportedProfiles)(
    'recognizes supported release target %s before enforcing selector exclusivity',
    async (profile) => {
      await expect(execFileAsync(process.execPath, [
        releaseGatePath,
        '--profile',
        profile,
        '--all-supported',
      ], {
        cwd: packageRoot,
        encoding: 'utf8',
      })).rejects.toThrow(/cannot be combined/u);
    },
  );

  it.each(['mcp-read', 'mcp-write'] as const)(
    'no longer quarantines release target %s after COLP-MCP-15 acceptance',
    async (profile) => {
      expect(isMigratingMcpReleaseProfile(profile)).toBe(false);
      expect(registeredReleaseProfiles).toContain(profile);
      await expect(execFileAsync(process.execPath, [
        releaseGatePath,
        '--profile',
        profile,
        '--all-supported',
      ], {
        cwd: packageRoot,
        encoding: 'utf8',
      })).rejects.toThrow(/cannot be combined/u);
    },
  );

  it.each([
    ['caller artifact', ['--artifact', 'forged.json']],
    ['caller report', ['--report', 'forged-report.json']],
    ['caller revision', ['--source-revision', sourceRevision]],
    ['caller output', ['--output', 'forged-evidence.json']],
    ['unsupported target', ['--profile', 'future-profile']],
    ['mixed target selection', ['--all-supported', '--profile', 'core']],
  ] as const)('does not accept a %s override', async (_label, arguments_) => {
    await expect(execFileAsync(process.execPath, [releaseGatePath, ...arguments_], {
      cwd: packageRoot,
      encoding: 'utf8',
    })).rejects.toThrow();
  });

  it.each([
    ['generator report', generatorPath, ['--report', 'forged-report.json']],
    ['generator revision', generatorPath, ['--source-revision', sourceRevision]],
  ] as const)('does not accept a caller-provided %s', async (_label, script, arguments_) => {
    await expect(execFileAsync(process.execPath, [script, ...arguments_], {
      cwd: packageRoot,
      encoding: 'utf8',
    })).rejects.toThrow();
  });

  it('wires the release gate into package check and CI', async () => {
    const packageJson = JSON.parse(await readFile(resolve(packageRoot, 'package.json'), 'utf8'));
    const releaseGate = await readFile(releaseGatePath, 'utf8');
    const workflow = await readFile(
      resolve(repositoryRoot, '.github', 'workflows', 'colp-ci.yml'),
      'utf8',
    );

    expect(packageJson.scripts['check:release-evidence']).toBe(
      'node scripts/release-evidence-gate.mjs --all-supported',
    );
    expect(packageJson.scripts.check).toContain('npm run check:release-evidence:coverage');
    expect(workflow).toContain('npm run check:release-evidence');
    expect(packageJson.scripts['check:release-evidence:coverage']).toBe(
      'node scripts/release-evidence-gate.mjs --all-supported --coverage',
    );
    expect(packageJson.scripts.check).not.toContain('npm run test:coverage &&');
    expect(workflow).toContain('npm run check:release-evidence:coverage');
    expect(workflow).not.toContain('npm run test:coverage && npm run check:release-evidence');
    expect(releaseGate).toContain('mcp-conformance-candidate.json');
    expect(releaseGate).toContain('mcp-2026-07-28-sdk-accepted.json');
    expect(releaseGate).toContain('validateMcpReleaseAcceptanceArtifacts');
    expect(releaseGate).toContain('const mcpSourceRevision = mcpCandidate?.sourceRevision');
    expect(releaseGate).toContain('sourceRevision: mcpSourceRevision');
    expect(releaseGate).toContain('verifyTrackedEvidenceRepositoryState(\n      mcpSourceRevision');
    expect(releaseGate).not.toContain('sourceRevision,\n        requirementsDigest: context.requirementsDigest');
  });

  it('opens the package Feed surface while keeping deployment claims gated', async () => {
    const packageJson = JSON.parse(await readFile(resolve(packageRoot, 'package.json'), 'utf8'));
    const manifest = JSON.parse(await readFile(
      resolve(packageRoot, 'fixtures', 'protocol', 'examples', 'public-manifest.json'),
      'utf8',
    ));
    const bundledEvidence = JSON.parse(await readFile(
      resolve(packageRoot, 'src', 'conformance', 'generated', 'evidence.json'),
      'utf8',
    ));

    expect(packageJson.exports).toHaveProperty('./feed', {
      types: {
        import: './dist/feed/index.d.ts',
        require: './dist/feed/index.d.cts',
      },
      import: './dist/feed/index.js',
      require: './dist/feed/index.cjs',
    });
    expect(supportedProfiles).toContain('feed');
    expect(manifest.mounts).not.toHaveLength(0);
    for (const mount of manifest.mounts) {
      expect(mount.profiles).not.toContain('feed');
      expect(mount.endpoints).not.toHaveProperty('instanceFeed');
      expect(mount.endpoints).not.toHaveProperty('collectionFeed');
      expect(mount.features).not.toHaveProperty('feed');
    }
    expect(bundledEvidence).toMatchObject({
      schemaVersion: 1,
      protocolVersion: context.protocolVersion,
      packageVersion: '0.0.0-development',
    });
    expect(typeof bundledEvidence.sourceRevision).toBe('string');
    expect(Array.isArray(bundledEvidence.passedRequirementIds)).toBe(true);
  });
});
