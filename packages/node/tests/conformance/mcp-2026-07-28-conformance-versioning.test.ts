import { describe, expect, it } from 'vitest';

import { supportedProfiles } from '../../src/index.js';
import {
  assertVersionedMcpEvidenceBinding,
  createVersionedMcpEvidenceBinding,
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
  validateVersionedMcpEvidenceBindingErrors as validateVersionedMcpConformanceBinding,
  versionedMcpEvidenceDigest,
} from '../../src/conformance/mcp-conformance.js';

const isLegacyMcpConformanceProbeId = srcIsLegacyMcpConformanceProbeId;
const isMcpConformanceProbeId = srcIsMcpConformanceProbeId;
const legacyMcpConformanceProbeIds = srcLegacyProbeIds;
const mcpConformanceProbeFamilyIdsForProfile = srcProbeFamilyIdsForProfile;
const rejectLegacyMcpConformanceProbeIds = srcRejectLegacyMcpConformanceProbeIds;
const validateMcpConformanceProbeIds = srcValidateMcpConformanceProbeIds;

const fixedProbeFamilies = [
  'mcp-2026-07-28.transport-header-contracts',
  'mcp-2026-07-28.discovery-contracts',
  'mcp-2026-07-28.subscription-contracts',
  'mcp-2026-07-28.read-schema-contracts',
  'mcp-2026-07-28.write-mrtr-contracts',
  'mcp-2026-07-28.oauth-client-contracts',
] as const;

const packageVersion = '1.2.3';
const requirementsDigest = `sha256:${'b'.repeat(64)}`;

function bindingInput(overrides: Record<string, unknown> = {}) {
  return {
    packageVersion,
    requirementsDigest,
    ...overrides,
  } as Parameters<typeof createVersionedMcpEvidenceBinding>[0];
}

function context(overrides: Record<string, unknown> = {}) {
  return {
    packageVersion,
    requirementsDigest,
    ...overrides,
  };
}

/** Rebuilds a binding after tampering so only the tampered layer fails. */
function withLayer(
  source: Record<string, unknown>,
  field: string,
  value: unknown,
): Record<string, unknown> {
  const tampered = { ...source, [field]: value };
  delete tampered.evidenceDigest;
  const binding = { ...tampered };
  // Recompute the digest so only the tampered layer fails validation.
  (binding as Record<string, unknown>).evidenceDigest = versionedMcpEvidenceDigest(
    binding as unknown as Parameters<typeof versionedMcpEvidenceDigest>[0],
  );
  return binding;
}

function srcBinding(overrides: Record<string, unknown> = {}) {
  return createVersionedMcpEvidenceBinding(bindingInput(overrides));
}

describe('MCP 2026-07-28 versioned conformance model (COLP-MCP-14)', () => {
  it('defines the exact modern baseline, six fixed probe families, and legacy IDs', () => {
    expect(srcVersion).toBe('2026-07-28');
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

  it('rejects legacy probe IDs and maps families to profiles', () => {
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
    const binding = srcBinding() as unknown as Record<string, unknown>;
    const cases = [
      ['attested MCP version', { mcpVersion: '2025-11-25' }, /2026-07-28|version/i],
      ['attested package version', { packageVersion: '9.9.9' }, /packageVersion/u],
      ['attested SDK lock', {
        sdkLock: {
          '@modelcontextprotocol/core': '2.0.1',
          '@modelcontextprotocol/client': '2.0.0',
          '@modelcontextprotocol/server': '2.0.0',
        },
      }, /SDK lock/i],
      ['attested fixture topology', { fixtureTopologyDigest: `sha256:${'0'.repeat(64)}` }, /fixture topology/i],
      ['attested requirements digest', { requirementsDigest: `sha256:${'d'.repeat(64)}` }, /requirementsDigest/u],
    ] as const;
    for (const [label, drift, expected] of cases) {
      expect(() => assertVersionedMcpEvidenceBinding(binding, { ...context(), ...drift }), label)
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

  it('creates the full versioned binding', () => {
    const binding = srcBinding();
    expect(binding).toEqual({
      schemaVersion: 1,
      mcpVersion: '2026-07-28',
      packageVersion,
      sdkLock: srcSdkLock,
      fixtureTopologyDigest: srcTopologyDigest,
      requirementsDigest,
      probeFamilyIds: srcProbeFamilies,
      evidenceDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
    });
    expect(validateVersionedMcpConformanceBinding(binding, context())).toEqual([]);
    expect(() => assertVersionedMcpEvidenceBinding(binding, context())).not.toThrow();
  });

  it.each([
    ['missing version', (c: Record<string, unknown>) => {
      const tampered = { ...c };
      delete tampered.mcpVersion;
      return tampered;
    }, /2026-07-28|version/i],
    ['wrong version', (c: Record<string, unknown>) => withLayer(c, 'mcpVersion', '2025-11-25'), /2026-07-28|version/i],
    ['package version drift', (c: Record<string, unknown>) => withLayer(c, 'packageVersion', '9.9.9'), /packageVersion/u],
    ['missing package version', (c: Record<string, unknown>) => {
      const tampered = { ...c };
      delete tampered.packageVersion;
      return tampered;
    }, /packageVersion/u],
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
    ['malformed requirements digest', (c: Record<string, unknown>) => withLayer(c, 'requirementsDigest', 'md5:abc'), /requirementsDigest/u],
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
  ] as const)('rejects %s layer by layer', (_label, tamper, expected) => {
    const binding = srcBinding() as unknown as Record<string, unknown>;
    const tampered = tamper(binding);
    const errors = validateVersionedMcpConformanceBinding(tampered, context());
    expect(errors.join('\n')).toMatch(expected);
    expect(() => assertVersionedMcpEvidenceBinding(
      tampered,
      context(),
    )).toThrow(expected);
  });

  it('rejects context-attested drift layer by layer without binding tampering', () => {
    const binding = srcBinding() as unknown as Record<string, unknown>;
    const cases = [
      ['attested MCP version', { mcpVersion: '2025-11-25' }, /2026-07-28|version/i],
      ['attested package version', { packageVersion: '9.9.9' }, /packageVersion/u],
      ['attested SDK lock', {
        sdkLock: {
          '@modelcontextprotocol/core': '2.0.1',
          '@modelcontextprotocol/client': '2.0.0',
          '@modelcontextprotocol/server': '2.0.0',
        },
      }, /SDK lock/i],
      ['attested fixture topology', { fixtureTopologyDigest: `sha256:${'0'.repeat(64)}` }, /fixture topology/i],
      ['attested requirements digest', { requirementsDigest: `sha256:${'d'.repeat(64)}` }, /requirementsDigest/u],
    ] as const;
    for (const [label, drift, expected] of cases) {
      const errors = validateVersionedMcpConformanceBinding(binding, { ...context(), ...drift });
      expect(errors.join('\n'), label).toMatch(expected);
    }
  });

  it('never lets old unversioned evidence satisfy a new versioned claim', () => {
    const packageEvidence = {
      schemaVersion: 2,
      protocolVersion: '0.1',
      packageVersion,
      requirementsDigest,
      passedRequirementIds: ['MCP-0001'],
    };
    const errors = validateVersionedMcpConformanceBinding(packageEvidence, context());
    expect(errors.join('\n')).toMatch(/schemaVersion/u);
    expect(errors.join('\n')).toMatch(/2026-07-28|version/i);
    expect(errors.join('\n')).toMatch(/SDK lock/i);
    expect(() => assertVersionedMcpEvidenceBinding(packageEvidence, context())).toThrow(/SDK lock/i);
  });

  it('rejects malformed binding input at the factory', () => {
    expect(() => createVersionedMcpEvidenceBinding(
      bindingInput({ packageVersion: '' }),
    )).toThrow(/packageVersion/u);
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
    expect(() => assertVersionedMcpEvidenceBinding('nope', context()))
      .toThrow(/must be an object/u);

    expect(validateMcpConformanceProbeIds([...fixedProbeFamilies, fixedProbeFamilies[0]])
      .join('\n')).toMatch(/repeats/u);
    expect(validateMcpConformanceProbeIds([42]).join('\n')).toMatch(/must be a string/u);
    expect(rejectLegacyMcpConformanceProbeIds('nope' as unknown as readonly unknown[]).join('\n')).toMatch(/array/u);
  });
  it('rejects a tampered binding through the src-side assert boundary', () => {
    const drifted = withLayer(
      srcBinding() as unknown as Record<string, unknown>,
      'packageVersion',
      '9.9.9',
    );
    expect(() => assertVersionedMcpEvidenceBinding(drifted, context())).toThrow(/packageVersion/u);
    expect(() => assertVersionedMcpEvidenceBinding(srcBinding(), context())).not.toThrow();
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
