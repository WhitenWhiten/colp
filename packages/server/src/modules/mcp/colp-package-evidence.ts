import { createHash } from 'node:crypto';
import { bundledConformanceEvidence, conformanceRequirements } from '@know-n/colp/conformance';
import { MCP_PROTOCOL_VERSION, MCP_SDK_CORE_VERSION } from '@know-n/colp/mcp';
import type {
  Phase4bMcp20260728SdkAcceptedEvidence,
  Phase4bMcpConformanceCandidate,
} from './read-profile-claim-gate.js';

/** Host metadata for the installed package; deployment probes remain mandatory. */
export function createPhase4bMcpPackageEvidence(): Readonly<{
  accepted: Phase4bMcp20260728SdkAcceptedEvidence;
  candidate: Phase4bMcpConformanceCandidate;
}> {
  const passed = new Set(bundledConformanceEvidence.passedRequirementIds);
  const required = conformanceRequirements.filter((requirement) =>
    ['core', 'mcp-read', 'mcp-write'].includes(requirement.profile)
    && ['MUST', 'MUST_NOT'].includes(requirement.level));
  if (required.length === 0 || required.some((requirement) =>
    requirement.tests.length === 0 || !passed.has(requirement.id))) {
    throw new TypeError('Installed COLP package has incomplete MCP conformance evidence');
  }
  const fields = {
    mcpVersion: MCP_PROTOCOL_VERSION,
    packageVersion: bundledConformanceEvidence.packageVersion,
    sdkLock: {
      '@modelcontextprotocol/core': MCP_SDK_CORE_VERSION,
      '@modelcontextprotocol/client': MCP_SDK_CORE_VERSION,
      '@modelcontextprotocol/server': MCP_SDK_CORE_VERSION,
    },
    // The reference-client / fixture-host topology is unchanged by extraction.
    fixtureTopologyDigest: 'sha256:926b07777344de57ee6584562c0012a34576040e069f466e4cab8ef48c485809',
    requirementsDigest: bundledConformanceEvidence.requirementsDigest,
    probeFamilyIds: [
      'mcp-2026-07-28.transport-header-contracts',
      'mcp-2026-07-28.discovery-contracts',
      'mcp-2026-07-28.subscription-contracts',
      'mcp-2026-07-28.read-schema-contracts',
      'mcp-2026-07-28.write-mrtr-contracts',
      'mcp-2026-07-28.oauth-client-contracts',
    ],
  };
  const candidate: Phase4bMcpConformanceCandidate = {
    candidate: 'mcp-conformance-candidate', schemaVersion: 1,
    ...fields, evidenceDigest: digest(fields),
  };
  const acceptedFields = {
    candidate: 'mcp-2026-07-28-sdk-accepted' as const, schemaVersion: 1 as const,
    ...fields, conformanceCandidateDigest: candidate.evidenceDigest,
  };
  const accepted: Phase4bMcp20260728SdkAcceptedEvidence = {
    ...acceptedFields, evidenceDigest: digest(acceptedFields),
  };
  return Object.freeze({ accepted, candidate });
}

function digest(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonical(value)).digest('hex')}`;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
