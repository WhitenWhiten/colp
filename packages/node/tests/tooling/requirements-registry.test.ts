import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  collectPassingTestIds,
  createEvidence,
  readRegistry,
  registryFiles,
  requirementsDigest,
  validateEvidence,
  validateRegistry,
  validateSourceAnchors,
  type Registry,
  type RegistryRequirement,
} from '../../scripts/lib/requirements.mjs';

const protocolRoot = resolve(import.meta.dirname, '..', '..', '..', '..', 'protocol');

function requirement(overrides: Partial<RegistryRequirement> = {}): RegistryRequirement {
  return {
    id: 'CORE-0001',
    level: 'MUST',
    profile: 'core',
    source: 'docs/00-practical-profile.md#colp-section-7',
    requirement: 'Validate every wire document.',
    implementation: ['schema'],
    tests: ['core.example'],
    ...overrides,
  };
}

function report(tests: readonly (readonly [string, string])[], success = true) {
  return {
    success,
    testResults: [
      { assertionResults: tests.map(([fullName, status]) => ({ fullName, status })) },
    ],
  };
}

describe('protocol requirement registries', () => {
  it('are valid and every source points at an existing section anchor', async () => {
    const registries = await Promise.all(registryFiles.map((name) => readRegistry(protocolRoot, name)));
    for (const [index, registry] of registries.entries()) {
      expect(validateRegistry(registry, registryFiles[index])).toEqual([]);
      expect(await validateSourceAnchors(registry.requirements, protocolRoot)).toEqual([]);
    }
    const ids = registries.flatMap((registry) => registry.requirements.map((item) => item.id));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('reports duplicate ids, unknown fields and malformed sources', () => {
    const errors = validateRegistry({
      version: '0.1',
      requirements: [
        requirement(),
        requirement({ source: 'docs/00-practical-profile.md#7-two-stage-validation' }),
        { ...requirement({ id: 'CORE-0002' }), selector: { section: '7' } },
      ],
    });
    expect(errors.join('\n')).toMatch(/Duplicate requirement id: CORE-0001/u);
    expect(errors.join('\n')).toMatch(/source must look like/u);
    expect(errors.join('\n')).toMatch(/unknown field: selector/u);
  });

  it('reports a source anchor that does not exist', async () => {
    const errors = await validateSourceAnchors(
      [requirement({ source: 'docs/00-practical-profile.md#colp-section-99' })],
      protocolRoot,
    );
    expect(errors).toEqual(['CORE-0001 points at a missing anchor: docs/00-practical-profile.md#colp-section-99']);
  });
});

describe('conformance evidence', () => {
  const registry: Registry = {
    version: '0.1',
    requirements: [
      requirement(),
      requirement({ id: 'CORE-0002', tests: ['core.example', 'core.other'] }),
      requirement({ id: 'CORE-0003', level: 'SHOULD', tests: [] }),
    ],
  };
  const known = new Set(['core.example', 'core.other']);

  it('ignores wording and source edits but not test or level changes', () => {
    const digest = requirementsDigest(registry);
    const reworded: Registry = {
      ...registry,
      requirements: registry.requirements.map((item) => ({
        ...item,
        requirement: `${item.requirement} (reworded)`,
        source: 'SPECIFICATION.md#colp-section-9',
      })),
    };
    expect(requirementsDigest(reworded)).toBe(digest);
    expect(
      requirementsDigest({ ...registry, requirements: [requirement({ tests: ['core.other'] })] }),
    ).not.toBe(digest);
    expect(
      requirementsDigest({ ...registry, requirements: [requirement({ level: 'SHOULD' })] }),
    ).not.toBe(digest);
  });

  it('marks a requirement verified only when every listed test passed', () => {
    const passing = collectPassingTestIds(
      report([
        ['suite [evidence:core.example] a', 'passed'],
        ['suite [evidence:core.example] b', 'passed'],
        ['other [evidence:core.other]', 'failed'],
      ]),
      known,
    );
    expect([...passing]).toEqual(['core.example']);
    const evidence = createEvidence({ registry, packageVersion: '1.0.0', passingTestIds: passing });
    expect(evidence.passedRequirementIds).toEqual(['CORE-0001']);
    expect(validateEvidence(evidence, { registry, packageVersion: '1.0.0' })).toEqual([]);
    expect(validateEvidence(evidence, { registry, packageVersion: '2.0.0' }).join('\n')).toMatch(
      /packageVersion/u,
    );
  });

  it('rejects failed runs and unregistered evidence tags', () => {
    expect(() => collectPassingTestIds(report([], false), known)).toThrow(/failed/u);
    expect(() => collectPassingTestIds(report([['x [evidence:core.typo]', 'passed']]), known)).toThrow(
      /Unregistered evidence tag/u,
    );
  });
});
