import { describe, expect, it } from 'vitest';

import { supportedProfiles } from '../../src/index.js';
import {
  assertMcpConformanceCandidate,
  assertVersionedMcpEvidenceBinding,
  createMcpConformanceCandidate,
  createVersionedMcpEvidenceBinding,
  evaluateMcpConformanceProbeCoverage,
  isLegacyMcpConformanceProbeId as srcIsLegacyMcpConformanceProbeId,
  isMcpConformanceProbeId as srcIsMcpConformanceProbeId,
  legacyMcpConformanceProbeIds as srcLegacyProbeIds,
  mcpConformanceEvidenceSchemaVersion as srcEvidenceSchemaVersion,
  mcpConformanceProbeFamilies as srcProbeFamilies,
  mcpConformanceProbeFamiliesByProfile as srcFamiliesByProfile,
  mcpConformanceProbeFamilyIdsForProfile as srcProbeFamilyIdsForProfile,
  mcpConformanceProtocolVersion as srcVersion,
  mcpFixtureTopologyDigest as srcTopologyDigest,
  mcpSdkLock as srcSdkLock,
  rejectLegacyMcpConformanceProbeIds as srcRejectLegacyMcpConformanceProbeIds,
  validateMcpConformanceProbeIds as srcValidateMcpConformanceProbeIds,
  versionedMcpEvidenceDigest,
} from '../../src/conformance/mcp-conformance.js';
import {
  createMcpConformanceCandidate as createScriptCandidate,
  createVersionedMcpConformanceBinding,
  isLegacyMcpConformanceProbeId,
  isMcpConformanceProbeId,
  legacyMcpConformanceProbeIds,
  mcpConformanceEvidenceSchemaVersion,
  mcpConformanceProbeFamilies,
  mcpConformanceProbeFamiliesByProfile,
  mcpConformanceProbeFamilyIdsForProfile,
  mcpConformanceProtocolVersion,
  mcpFixtureTopologyDigest,
  mcpSdkLock,
  rejectLegacyMcpConformanceProbeIds,
  validateMcpConformanceCandidate,
  validateMcpConformanceProbeIds,
  validateVersionedMcpConformanceBinding,
} from '../../scripts/lib/mcp-conformance-versioning.mjs';
import { mcpMigrationProtocolVersion } from '../../scripts/lib/conformance-evidence.mjs';

const fixedProbeFamilies = [
  'mcp-2026-07-28.transport-header-contracts',
  'mcp-2026-07-28.discovery-contracts',
  'mcp-2026-07-28.subscription-contracts',
  'mcp-2026-07-28.read-schema-contracts',
  'mcp-2026-07-28.write-mrtr-contracts',
  'mcp-2026-07-28.oauth-client-contracts',
] as const;

const sourceRevision = 'a'.repeat(40);
const requirementsDigest = `sha256:${'b'.repeat(64)}`;
const reportDigest = `sha256:${'c'.repeat(64)}`;

function bindingInput(overrides: Record<string, unknown> = {}) {
  return {
    sourceRevision,
    requirementsDigest,
    reportDigest,
    ...overrides,
  };
}

function context(overrides: Record<string, unknown> = {}) {
  return {
    sourceRevision,
    requirementsDigest,
    reportDigest,
    ...overrides,
  };
}

/** Rebuilds a candidate/binding after tampering so only the tampered layer fails. */
function withLayer(
  candidate: Record<string, unknown>,
  field: string,
  value: unknown,
): Record<string, unknown> {
  const tampered = { ...candidate, [field]: value };
  delete tampered.evidenceDigest;
  const binding = { ...tampered };
  // The script-side and src-side digest algorithms are identical; reuse the
  // exported digest helper so the tampered binding stays internally consistent.
  (binding as Record<string, unknown>).evidenceDigest = versionedMcpEvidenceDigest(
    binding as unknown as Parameters<typeof versionedMcpEvidenceDigest>[0],
  );
  return binding;
}

function scriptCandidate(overrides: Record<string, unknown> = {}) {
  return createScriptCandidate(bindingInput(overrides));
}

function srcCandidate(overrides: Record<string, unknown> = {}) {
  return createMcpConformanceCandidate(bindingInput(overrides));
}

describe('MCP 2026-07-28 versioned conformance model (COLP-MCP-14)', () => {
  it('defines the exact modern baseline, six fixed probe families, and legacy IDs', () => {
    expect(srcVersion).toBe('2026-07-28');
    expect(srcVersion).toBe(mcpMigrationProtocolVersion);
    expect(srcProbeFamilies).toEqual([...fixedProbeFamilies]);
    expect(srcLegacyProbeIds).toEqual([
      'mcp-read.transport-contracts',
      'mcp-write.approval-contracts',
    ]);
    expect(srcEvidenceSchemaVersion).toBe(1);
  });

  it('locks the upstream MCP SDK and the reference-client/fixture-host topology', () => {
    expect(srcSdkLock).toEqual({
      '@modelcontextprotocol/core': '2.0.0',
      '@modelcontextprotocol/client': '2.0.0',
      '@modelcontextprotocol/server': '2.0.0',
    });
    expect(srcTopologyDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
  });

  it('keeps the script-side and src-side conformance models identical', () => {
    expect(mcpConformanceProtocolVersion).toBe(srcVersion);
    expect(mcpConformanceProbeFamilies).toEqual(srcProbeFamilies);
    expect(legacyMcpConformanceProbeIds).toEqual(srcLegacyProbeIds);
    expect(mcpSdkLock).toEqual(srcSdkLock);
    expect(mcpFixtureTopologyDigest).toBe(srcTopologyDigest);
    expect(mcpConformanceEvidenceSchemaVersion).toBe(srcEvidenceSchemaVersion);
    expect(Object.keys(mcpConformanceProbeFamiliesByProfile).sort())
      .toEqual(Object.keys(srcFamiliesByProfile).sort());
    for (const profile of Object.keys(srcFamiliesByProfile)) {
      expect(mcpConformanceProbeFamiliesByProfile[profile as 'mcp-read' | 'mcp-write'])
        .toEqual(srcFamiliesByProfile[profile as 'mcp-read' | 'mcp-write']);
    }
  });

  it('registers exactly the six fixed probe families', () => {
    for (const family of fixedProbeFamilies) {
      expect(isMcpConformanceProbeId(family), family).toBe(true);
      expect(isLegacyMcpConformanceProbeId(family), family).toBe(false);
    }
    for (const legacy of legacyMcpConformanceProbeIds) {
      expect(isLegacyMcpConformanceProbeId(legacy), legacy).toBe(true);
      expect(isMcpConformanceProbeId(legacy), legacy).toBe(false);
    }
    expect(isMcpConformanceProbeId('mcp-2026-07-28.future-family')).toBe(false);
    expect(isMcpConformanceProbeId(42)).toBe(false);
  });

  it('keeps the src-side rejection and profile-mapping helpers identical to the script side', () => {
    for (const family of fixedProbeFamilies) {
      expect(srcIsMcpConformanceProbeId(family), family).toBe(true);
      expect(srcIsLegacyMcpConformanceProbeId(family), family).toBe(false);
    }
    for (const legacy of legacyMcpConformanceProbeIds) {
      expect(srcIsLegacyMcpConformanceProbeId(legacy), legacy).toBe(true);
      expect(srcIsMcpConformanceProbeId(legacy), legacy).toBe(false);
    }
    expect(srcRejectLegacyMcpConformanceProbeIds([...fixedProbeFamilies, ...legacyMcpConformanceProbeIds])
      .join('\n')).toMatch(/rejected migration input/u);
    expect(srcRejectLegacyMcpConformanceProbeIds([...fixedProbeFamilies])).toEqual([]);
    expect(srcValidateMcpConformanceProbeIds([...fixedProbeFamilies, 'mcp-read.transport-contracts'])
      .join('\n')).toMatch(/legacy|rejected migration input/i);
    expect(srcValidateMcpConformanceProbeIds([...fixedProbeFamilies])).toEqual([]);
    expect(srcValidateMcpConformanceProbeIds([42]).join('\n')).toMatch(/must be a string/u);
    expect(srcValidateMcpConformanceProbeIds([...fixedProbeFamilies, fixedProbeFamilies[0]])
      .join('\n')).toMatch(/repeats/u);
    expect(srcRejectLegacyMcpConformanceProbeIds('nope' as unknown as readonly unknown[])).toEqual([
      'MCP conformance probe IDs must be an array.',
    ]);
    expect(srcProbeFamilyIdsForProfile('mcp-write')).toEqual([
      'mcp-2026-07-28.write-mrtr-contracts',
    ]);
    expect(() => srcProbeFamilyIdsForProfile('core')).toThrow(/mcp|profile/i);
  });

  it('rejects context-attested drift through the src-side assert boundary', () => {
    const candidate = srcCandidate() as unknown as Record<string, unknown>;
    const cases = [
      ['attested MCP version', { mcpVersion: '2025-11-25' }, /2026-07-28|version/i],
      ['attested source revision', { sourceRevision: 'b'.repeat(40) }, /sourceRevision/u],
      ['attested SDK lock', {
        sdkLock: {
          '@modelcontextprotocol/core': '2.0.1',
          '@modelcontextprotocol/client': '2.0.0',
          '@modelcontextprotocol/server': '2.0.0',
        },
      }, /SDK lock/i],
      ['attested fixture topology', { fixtureTopologyDigest: `sha256:${'0'.repeat(64)}` }, /fixture topology/i],
      ['attested requirements digest', { requirementsDigest: `sha256:${'d'.repeat(64)}` }, /requirementsDigest/u],
      ['attested report digest', { reportDigest: `sha256:${'d'.repeat(64)}` }, /reportDigest/u],
    ] as const;
    for (const [label, drift, expected] of cases) {
      expect(() => assertMcpConformanceCandidate(candidate, { ...context(), ...drift }), label)
        .toThrow(expected);
    }
  });

  it('maps probe families to MCP Profiles and respects the write dependency closure', () => {
    const readFamilies = srcFamiliesByProfile['mcp-read'];
    expect(readFamilies).toEqual([
      'mcp-2026-07-28.transport-header-contracts',
      'mcp-2026-07-28.discovery-contracts',
      'mcp-2026-07-28.subscription-contracts',
      'mcp-2026-07-28.read-schema-contracts',
      'mcp-2026-07-28.oauth-client-contracts',
    ]);
    expect(srcFamiliesByProfile['mcp-write']).toEqual([
      'mcp-2026-07-28.write-mrtr-contracts',
    ]);
    // mcp-write depends on mcp-read, so its versioned probe coverage must
    // include every mcp-read family plus the Write/MRTR family.
    expect(mcpConformanceProbeFamilyIdsForProfile('mcp-write')).toEqual([
      'mcp-2026-07-28.write-mrtr-contracts',
    ]);
    expect(new Set(mcpConformanceProbeFamilyIdsForProfile('mcp-read')))
      .toEqual(new Set(readFamilies));
    expect(() => mcpConformanceProbeFamilyIdsForProfile('core')).toThrow(/mcp|profile/i);
    expect(() => mcpConformanceProbeFamilyIdsForProfile('future')).toThrow(/mcp|profile/i);
  });

  it('rejects legacy unversioned probe IDs as migration input in the versioned flow', () => {
    const legacy = legacyMcpConformanceProbeIds;
    const errors = rejectLegacyMcpConformanceProbeIds([...fixedProbeFamilies, ...legacy]);
    expect(errors.join('\n')).toMatch(/mcp-read\.transport-contracts/u);
    expect(errors.join('\n')).toMatch(/mcp-write\.approval-contracts/u);
    expect(rejectLegacyMcpConformanceProbeIds([...fixedProbeFamilies])).toEqual([]);

    const validation = validateMcpConformanceProbeIds([...fixedProbeFamilies, ...legacy]);
    expect(validation.join('\n')).toMatch(/rejected migration input|legacy/i);
    expect(validateMcpConformanceProbeIds([...fixedProbeFamilies])).toEqual([]);
    expect(validateMcpConformanceProbeIds([...fixedProbeFamilies, 'unknown.probe'])
      .join('\n')).toMatch(/unknown|not a registered/i);
    expect(validateMcpConformanceProbeIds('not-an-array').join('\n')).toMatch(/array/u);
  });

  it('generates a source-bound candidate with the full versioned binding', () => {
    const candidate = srcCandidate();
    expect(candidate).toMatchObject({
      schemaVersion: 1,
      candidate: 'mcp-conformance-candidate',
      mcpVersion: '2026-07-28',
      sourceRevision,
      sdkLock: srcSdkLock,
      fixtureTopologyDigest: srcTopologyDigest,
      requirementsDigest,
      reportDigest,
      probeFamilyIds: srcProbeFamilies,
    });
    expect(candidate.evidenceDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);

    const script = scriptCandidate();
    expect(script.evidenceDigest).toBe(candidate.evidenceDigest);
    expect(validateMcpConformanceCandidate(script, context())).toEqual([]);
    expect(validateVersionedMcpConformanceBinding(
      script,
      context(),
    )).toEqual([]);
    expect(() => assertMcpConformanceCandidate(candidate, context())).not.toThrow();
    expect(() => assertVersionedMcpEvidenceBinding(candidate, context())).not.toThrow();
  });

  it.each([
    ['missing version', (c: Record<string, unknown>) => {
      const tampered = { ...c };
      delete tampered.mcpVersion;
      return tampered;
    }, /2026-07-28|version/i],
    ['wrong version', (c: Record<string, unknown>) => withLayer(c, 'mcpVersion', '2025-11-25'), /2026-07-28|version/i],
    ['source revision drift', (c: Record<string, unknown>) => withLayer(c, 'sourceRevision', 'b'.repeat(40)), /sourceRevision/u],
    ['missing source revision', (c: Record<string, unknown>) => {
      const tampered = { ...c };
      delete tampered.sourceRevision;
      return tampered;
    }, /sourceRevision/u],
    ['SDK lock drift', (c: Record<string, unknown>) => withLayer(c, 'sdkLock', {
      '@modelcontextprotocol/core': '2.0.1',
      '@modelcontextprotocol/client': '2.0.0',
      '@modelcontextprotocol/server': '2.0.0',
    }), /SDK lock/i],
    ['missing SDK lock entry', (c: Record<string, unknown>) => withLayer(c, 'sdkLock', {
      '@modelcontextprotocol/core': '2.0.0',
      '@modelcontextprotocol/server': '2.0.0',
    }), /SDK lock/i],
    ['fixture topology drift', (c: Record<string, unknown>) => withLayer(c, 'fixtureTopologyDigest', `sha256:${'0'.repeat(64)}`), /fixture topology/i],
    ['missing fixture topology', (c: Record<string, unknown>) => {
      const tampered = { ...c };
      delete tampered.fixtureTopologyDigest;
      return tampered;
    }, /fixture topology/i],
    ['requirements digest drift', (c: Record<string, unknown>) => withLayer(c, 'requirementsDigest', `sha256:${'d'.repeat(64)}`), /requirementsDigest/u],
    ['missing report digest', (c: Record<string, unknown>) => {
      const tampered = { ...c };
      delete tampered.reportDigest;
      return tampered;
    }, /reportDigest/u],
    ['malformed report digest', (c: Record<string, unknown>) => withLayer(c, 'reportDigest', 'md5:abc'), /reportDigest/u],
    ['stale evidence digest', (c: Record<string, unknown>) => ({
      ...c,
      evidenceDigest: `sha256:${'e'.repeat(64)}`,
    }), /evidenceDigest/u],
    ['missing evidence digest', (c: Record<string, unknown>) => {
      const tampered = { ...c };
      delete tampered.evidenceDigest;
      return tampered;
    }, /evidenceDigest/u],
    ['missing probe family', (c: Record<string, unknown>) => withLayer(c, 'probeFamilyIds', fixedProbeFamilies.slice(0, 5)), /probe family/i],
    ['legacy probe replay in binding', (c: Record<string, unknown>) => withLayer(c, 'probeFamilyIds', [...fixedProbeFamilies.slice(0, 5), 'mcp-read.transport-contracts']), /probe family|legacy|rejected migration input/i],
    ['unknown probe family in binding', (c: Record<string, unknown>) => withLayer(c, 'probeFamilyIds', [...fixedProbeFamilies, 'mcp-2026-07-28.future']), /probe family/i],
  ] as const)('rejects %s layer-by-layer in the runner verdict', (_label, tamper, expected) => {
    const candidate = scriptCandidate() as unknown as Record<string, unknown>;
    const tampered = tamper(candidate);
    const errors = validateMcpConformanceCandidate(tampered, context());
    expect(errors.join('\n')).toMatch(expected);
    expect(() => assertMcpConformanceCandidate(
      tampered,
      context(),
    )).toThrow(expected);
  });

  it('rejects context-attested drift layer by layer without candidate tampering', () => {
    const candidate = scriptCandidate() as unknown as Record<string, unknown>;
    const cases = [
      ['attested MCP version', { mcpVersion: '2025-11-25' }, /2026-07-28|version/i],
      ['attested source revision', { sourceRevision: 'b'.repeat(40) }, /sourceRevision/u],
      ['attested SDK lock', {
        sdkLock: {
          '@modelcontextprotocol/core': '2.0.1',
          '@modelcontextprotocol/client': '2.0.0',
          '@modelcontextprotocol/server': '2.0.0',
        },
      }, /SDK lock/i],
      ['attested fixture topology', { fixtureTopologyDigest: `sha256:${'0'.repeat(64)}` }, /fixture topology/i],
      ['attested requirements digest', { requirementsDigest: `sha256:${'d'.repeat(64)}` }, /requirementsDigest/u],
      ['attested report digest', { reportDigest: `sha256:${'d'.repeat(64)}` }, /reportDigest/u],
    ] as const;
    for (const [label, drift, expected] of cases) {
      const errors = validateMcpConformanceCandidate(candidate, { ...context(), ...drift });
      expect(errors.join('\n'), label).toMatch(expected);
    }
  });

  it('rejects a candidate that is not an mcp-conformance-candidate artifact', () => {
    const candidate = srcCandidate();
    expect(validateMcpConformanceCandidate({ ...candidate, candidate: 'other' }, context())
      .join('\n')).toMatch(/mcp-conformance-candidate/u);
    expect(() => assertMcpConformanceCandidate(
      { ...candidate, candidate: 'other' },
      context(),
    )).toThrow(/mcp-conformance-candidate/u);
  });

  it('never lets old unversioned evidence satisfy a new versioned claim', () => {
    const oldEvidence = {
      schemaVersion: 1,
      protocolVersion: '0.1',
      packageVersion: '0.0.0-development',
      sourceRevision,
      requirementsDigest,
      reportDigest,
      passedRequirementIds: ['MCP-0001'],
    };
    const errors = validateMcpConformanceCandidate(oldEvidence, context());
    expect(errors.join('\n')).toMatch(/mcp-conformance-candidate/u);
    expect(errors.join('\n')).toMatch(/2026-07-28|version/i);
    expect(errors.join('\n')).toMatch(/SDK lock/i);
    expect(() => assertMcpConformanceCandidate(oldEvidence, context())).toThrow(/mcp-conformance-candidate/u);
  });

  it('rejects malformed binding input at the factory', () => {
    expect(() => createVersionedMcpEvidenceBinding(
      bindingInput({ sourceRevision: 'short' }),
    )).toThrow(/sourceRevision/u);
    expect(() => createVersionedMcpEvidenceBinding(
      bindingInput({ reportDigest: 'md5:abc' }),
    )).toThrow(/reportDigest/u);
    expect(() => createVersionedMcpEvidenceBinding(
      bindingInput({ requirementsDigest: 'nope' }),
    )).toThrow(/requirementsDigest/u);
    expect(() => createVersionedMcpEvidenceBinding(
      bindingInput({ probeFamilyIds: ['mcp-read.transport-contracts'] }),
    )).toThrow(/legacy|rejected migration input/i);
  });

  it('rejects non-object evidence and malformed probe ID lists', () => {
    expect(validateVersionedMcpConformanceBinding('nope', context()))
      .toEqual(['MCP conformance evidence must be an object.']);
    expect(validateMcpConformanceCandidate('nope', context()))
      .toEqual(['MCP conformance candidate must be an object.']);
    expect(() => assertVersionedMcpEvidenceBinding('nope', context()))
      .toThrow(/must be an object/u);
    expect(() => assertMcpConformanceCandidate('nope', context()))
      .toThrow(/must be an object/u);

    expect(validateMcpConformanceProbeIds([...fixedProbeFamilies, fixedProbeFamilies[0]])
      .join('\n')).toMatch(/repeats/u);
    expect(validateMcpConformanceProbeIds([42]).join('\n')).toMatch(/must be a string/u);
    expect(rejectLegacyMcpConformanceProbeIds('nope').join('\n')).toMatch(/array/u);
  });
  it('rejects a tampered binding through the src-side assert boundary', () => {
    const candidate = srcCandidate();
    const drifted = withLayer(
      candidate as unknown as Record<string, unknown>,
      'sourceRevision',
      'c'.repeat(40),
    );
    expect(() => assertVersionedMcpEvidenceBinding(drifted, context())).toThrow(/sourceRevision/u);
    expect(() => assertVersionedMcpEvidenceBinding(srcCandidate(), context())).not.toThrow();
  });
  it('restores supportedProfiles after COLP-MCP-15 accepted exact 2026-07-28 evidence', () => {
    expect(supportedProfiles).toContain('mcp-read');
    expect(supportedProfiles).toContain('mcp-write');
    expect(supportedProfiles).toEqual([
      'core',
      'publication',
      'publisher',
      'feed',
      'sync',
      'mcp-read',
      'mcp-write',
    ]);
  });
});

describe('MCP 2026-07-28 source-bound runner verdict (COLP-MCP-14)', () => {
  it('accepts a candidate bound to matching deployment evidence facts', () => {
    const candidate = srcCandidate();
    const deploymentEvidence = {
      passedProbeIds: [...fixedProbeFamilies],
      mcpBinding: candidate,
    };
    expect(evaluateMcpConformanceProbeCoverage(candidate, deploymentEvidence)).toBe(true);
  });

  it('rejects the verdict when the target evidence binding is missing', () => {
    const candidate = srcCandidate();
    expect(evaluateMcpConformanceProbeCoverage(candidate, { passedProbeIds: [...fixedProbeFamilies] }))
      .toBe(false);
  });

  it('rejects the verdict when the target evidence digest does not match the candidate', () => {
    const candidate = srcCandidate();
    const drifted = {
      passedProbeIds: [...fixedProbeFamilies],
      mcpBinding: {
        ...candidate,
        evidenceDigest: `sha256:${'f'.repeat(64)}`,
      },
    };
    expect(evaluateMcpConformanceProbeCoverage(candidate, drifted)).toBe(false);
  });

  it('rejects the verdict when a required probe family was not passed', () => {
    const candidate = srcCandidate();
    const partial = {
      passedProbeIds: [...fixedProbeFamilies.slice(0, 5)],
      mcpBinding: candidate,
    };
    expect(evaluateMcpConformanceProbeCoverage(candidate, partial)).toBe(false);
  });

  it('rejects an invalid candidate before evaluating coverage', () => {
    expect(() => evaluateMcpConformanceProbeCoverage(
      { candidate: 'not-a-candidate' },
      { passedProbeIds: [] },
    )).toThrow(/mcp-conformance-candidate/u);
  });
});
