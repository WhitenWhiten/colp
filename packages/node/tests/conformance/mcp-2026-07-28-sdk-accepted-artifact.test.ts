/**
 * COLP-MCP-15: locks the accepted `mcp-2026-07-28-sdk-accepted` artifact
 * model produced by scripts/accept-mcp-2026-07-28-sdk.mjs.
 *
 * The accepted artifact extends the versioned conformance binding (MCP
 * version, source revision, SDK lock, fixture topology, requirement/report
 * digests, probe families) with the conformance-candidate digest and the
 * Legacy MCP absence scan verdict, and binds all of them in a
 * self-referential evidence digest. Tampering any layer is rejected.
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  createMcp20260728SdkAccepted,
  createMcpConformanceCandidate,
  mcpConformanceProbeFamilies,
  mcpFixtureTopologyDigest,
  mcpSdkAcceptedArtifactName,
  mcpSdkAcceptedEvidenceSchemaVersion,
  mcpSdkLock,
  validateMcp20260728SdkAccepted,
  validateMcpConformanceCandidate,
  validateMcpReleaseAcceptanceArtifacts,
  versionedMcpAcceptedDigest,
} from '../../scripts/lib/mcp-conformance-versioning.mjs';

const packageRoot = resolve(import.meta.dirname, '..', '..');
const sourceRevision = 'a'.repeat(40);
const requirementsDigest = `sha256:${'b'.repeat(64)}`;
const reportDigest = `sha256:${'c'.repeat(64)}`;
const conformanceCandidateDigest = `sha256:${'d'.repeat(64)}`;

type AcceptedInput = Parameters<typeof createMcp20260728SdkAccepted>[0];

function acceptedInput(overrides: Partial<AcceptedInput> = {}): AcceptedInput {
  return {
    sourceRevision,
    requirementsDigest,
    reportDigest,
    conformanceCandidateDigest,
    legacyAbsence: { sourceFiles: 3, declarationFiles: 4, tarballFiles: 5, findings: [] },
    ...overrides,
  };
}

function context(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sourceRevision,
    requirementsDigest,
    reportDigest,
    ...overrides,
  };
}

function withLayer(
  artifact: Record<string, unknown>,
  field: string,
  value: unknown,
): Record<string, unknown> {
  const tampered = { ...artifact, [field]: value };
  delete tampered.evidenceDigest;
  const binding = { ...tampered };
  binding.evidenceDigest = versionedMcpAcceptedDigest(binding);
  return binding;
}

describe('COLP-MCP-15 accepted mcp-2026-07-28-sdk artifact model', () => {
  it('creates and validates a source-bound accepted artifact', () => {
    const artifact = createMcp20260728SdkAccepted(acceptedInput());
    expect(artifact).toMatchObject({
      candidate: mcpSdkAcceptedArtifactName,
      schemaVersion: mcpSdkAcceptedEvidenceSchemaVersion,
      mcpVersion: '2026-07-28',
      sourceRevision,
      sdkLock: mcpSdkLock,
      fixtureTopologyDigest: mcpFixtureTopologyDigest,
      requirementsDigest,
      reportDigest,
      conformanceCandidateDigest,
      probeFamilyIds: mcpConformanceProbeFamilies,
      legacyAbsence: { sourceFiles: 3, declarationFiles: 4, tarballFiles: 5, findings: [] },
    });
    expect(artifact.evidenceDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(validateMcp20260728SdkAccepted(artifact, context())).toEqual([]);
    expect(Object.isFrozen(artifact)).toBe(true);
    expect(Object.isFrozen(artifact.legacyAbsence)).toBe(true);
    expect(Object.isFrozen(artifact.probeFamilyIds)).toBe(true);
  });

  it('rejects a tampered source revision, version, SDK lock, topology, or digest', () => {
    const artifact = createMcp20260728SdkAccepted(
      acceptedInput(),
    ) as unknown as Record<string, unknown>;
    const cases = [
      ['sourceRevision', 'c'.repeat(40), /sourceRevision/u],
      ['mcpVersion', '2025-11-25', /2026-07-28|version/i],
      ['requirementsDigest', `sha256:${'e'.repeat(64)}`, /requirementsDigest/u],
      ['reportDigest', `sha256:${'e'.repeat(64)}`, /reportDigest/u],
      // conformanceCandidateDigest has no independent context in this
      // validator; tampering it is caught by the evidenceDigest recompute
      // below (asserted separately in the "binds the real generated
      // conformance candidate" test).
      [
        'sdkLock',
        {
          '@modelcontextprotocol/core': '2.0.1',
          '@modelcontextprotocol/client': '2.0.0',
          '@modelcontextprotocol/server': '2.0.0',
        },
        /SDK lock/i,
      ],
      ['fixtureTopologyDigest', `sha256:${'0'.repeat(64)}`, /fixture topology/i],
    ] as const;
    for (const [label, value, expected] of cases) {
      expect(validateMcp20260728SdkAccepted(withLayer(artifact, label, value), context()), label)
        .toContainEqual(expect.stringMatching(expected));
    }
    expect(validateMcp20260728SdkAccepted(
      withLayer(artifact, 'sourceRevision', 'c'.repeat(40)),
      context(),
    ).join('\n')).toMatch(/evidenceDigest|sourceRevision/u);
  });

  it('rejects a probe-family omission, repetition, or legacy probe replay', () => {
    const artifact = createMcp20260728SdkAccepted(
      acceptedInput(),
    ) as unknown as Record<string, unknown>;
    const missing = withLayer(
      artifact,
      'probeFamilyIds',
      mcpConformanceProbeFamilies.slice(0, 5),
    );
    expect(validateMcp20260728SdkAccepted(missing, context()).join('\n'))
      .toMatch(/required probe family/u);
    const legacy = withLayer(
      artifact,
      'probeFamilyIds',
      [...mcpConformanceProbeFamilies, 'mcp-read.transport-contracts'],
    );
    expect(validateMcp20260728SdkAccepted(legacy, context()).join('\n'))
      .toMatch(/legacy|rejected migration input/i);
  });

  it('fails closed when the Legacy MCP absence scan found symbols', () => {
    const artifact = createMcp20260728SdkAccepted(
      acceptedInput(),
    ) as unknown as Record<string, unknown>;
    const withFindings = withLayer(artifact, 'legacyAbsence', {
      sourceFiles: 3,
      declarationFiles: 4,
      tarballFiles: 5,
      findings: [{ path: 'src/mcp/x.ts', symbol: 'McpSessionBinding' }],
    });
    expect(validateMcp20260728SdkAccepted(withFindings, context()).join('\n'))
      .toMatch(/findings|absence|Legacy/i);
  });

  it('rejects malformed absence counts and a missing legacyAbsence record', () => {
    const artifact = createMcp20260728SdkAccepted(
      acceptedInput(),
    ) as unknown as Record<string, unknown>;
    for (const counts of [
      { sourceFiles: -1, declarationFiles: 4, tarballFiles: 5, findings: [] },
      { sourceFiles: 1.5, declarationFiles: 4, tarballFiles: 5, findings: [] },
      { sourceFiles: '3', declarationFiles: 4, tarballFiles: 5, findings: [] },
    ]) {
      expect(
        validateMcp20260728SdkAccepted(withLayer(artifact, 'legacyAbsence', counts), context())
          .join('\n'),
      ).toMatch(/legacyAbsence|sourceFiles/u);
    }
    const { legacyAbsence: _omitted, ...withoutAbsence } = artifact;
    expect(validateMcp20260728SdkAccepted(withoutAbsence, context()).join('\n'))
      .toMatch(/legacyAbsence/u);
    void _omitted;
  });

  it('rejects context-attested drift and non-object artifacts', () => {
    const artifact = createMcp20260728SdkAccepted(
      acceptedInput(),
    ) as unknown as Record<string, unknown>;
    expect(validateMcp20260728SdkAccepted(artifact, {
      ...context(),
      sourceRevision: 'b'.repeat(40),
    }).join('\n')).toMatch(/sourceRevision/u);
    expect(validateMcp20260728SdkAccepted('nope', context()))
      .toEqual(['MCP 2026-07-28 SDK accepted artifact must be an object.']);
    expect(validateMcp20260728SdkAccepted(
      { ...artifact, candidate: 'other' },
      context(),
    ).join('\n')).toMatch(/mcp-2026-07-28-sdk-accepted/u);
  });

  it('binds the real generated conformance candidate into an accepted artifact', async () => {
    const candidate = JSON.parse(await readFile(
      resolve(packageRoot, 'src', 'conformance', 'generated', 'mcp-conformance-candidate.json'),
      'utf8',
    )) as Record<string, unknown>;
    expect(validateMcpConformanceCandidate(candidate)).toEqual([]);

    const candidateForContext = createMcpConformanceCandidate({
      sourceRevision,
      requirementsDigest,
      reportDigest,
    });
    const artifact = createMcp20260728SdkAccepted(acceptedInput({
      conformanceCandidateDigest: candidateForContext.evidenceDigest as string,
    }));
    expect(validateMcp20260728SdkAccepted(artifact, context())).toEqual([]);
    expect(validateMcp20260728SdkAccepted(
      { ...artifact, conformanceCandidateDigest: `sha256:${'f'.repeat(64)}` },
      context(),
    ).join('\n')).toMatch(/evidenceDigest|conformanceCandidateDigest/u);
  });

  it('fails the release binding when either tracked artifact is missing or detached', () => {
    const candidate = createMcpConformanceCandidate({
      sourceRevision,
      requirementsDigest,
      reportDigest,
    });
    const accepted = createMcp20260728SdkAccepted(acceptedInput({
      conformanceCandidateDigest: candidate.evidenceDigest as string,
    }));
    const releaseContext = context();

    expect(validateMcpReleaseAcceptanceArtifacts({ candidate, accepted }, releaseContext)).toEqual([]);
    expect(validateMcpReleaseAcceptanceArtifacts({ candidate }, releaseContext).join('\n'))
      .toMatch(/Accepted SDK artifact/u);
    expect(validateMcpReleaseAcceptanceArtifacts({ accepted }, releaseContext).join('\n'))
      .toMatch(/Conformance candidate/u);

    const detachedAccepted = createMcp20260728SdkAccepted(acceptedInput({
      conformanceCandidateDigest: `sha256:${'e'.repeat(64)}`,
    }));
    expect(validateMcpReleaseAcceptanceArtifacts(
      { candidate, accepted: detachedAccepted },
      releaseContext,
    ).join('\n')).toMatch(/does not match the tracked conformance candidate/u);
  });
});
