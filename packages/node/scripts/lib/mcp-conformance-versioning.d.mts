export const mcpConformanceEvidenceSchemaVersion: 1;
export const mcpConformanceProtocolVersion: '2026-07-28';
export const mcpConformanceProbeFamilies: readonly [
  'mcp-2026-07-28.transport-header-contracts',
  'mcp-2026-07-28.discovery-contracts',
  'mcp-2026-07-28.subscription-contracts',
  'mcp-2026-07-28.read-schema-contracts',
  'mcp-2026-07-28.write-mrtr-contracts',
  'mcp-2026-07-28.oauth-client-contracts',
];
export const mcpConformanceProbeFamiliesByProfile: Readonly<{
  readonly 'mcp-read': readonly string[];
  readonly 'mcp-write': readonly string[];
}>;
export const legacyMcpConformanceProbeIds: readonly [
  'mcp-read.transport-contracts',
  'mcp-write.approval-contracts',
];
export const mcpSdkLock: Readonly<Record<string, string>>;
export const mcpFixtureTopology: Readonly<{
  readonly referenceClient: string;
  readonly fixtureHost: string;
  readonly boundary: string;
}>;
export const mcpFixtureTopologyDigest: string;
export function isMcpConformanceProbeId(value: unknown): boolean;
export function isLegacyMcpConformanceProbeId(value: unknown): boolean;
export function validateMcpConformanceProbeIds(probeIds: unknown): string[];
export function rejectLegacyMcpConformanceProbeIds(probeIds: unknown): string[];
export function mcpConformanceProbeFamilyIdsForProfile(profile: string): readonly string[];
type VersionedBindingFields = {
  readonly mcpVersion?: string;
  readonly sourceRevision?: string;
  readonly sdkLock?: Readonly<Record<string, string>>;
  readonly fixtureTopologyDigest?: string;
  readonly requirementsDigest?: string;
  readonly reportDigest?: string;
  readonly probeFamilyIds?: readonly string[];
};
export function versionedMcpEvidenceDigest(fields: VersionedBindingFields): string;
type BindingContext = {
  readonly mcpVersion?: string;
  readonly sourceRevision?: string;
  readonly sdkLock?: Readonly<Record<string, string>>;
  readonly fixtureTopologyDigest?: string;
  readonly requirementsDigest?: string;
  readonly reportDigest?: string;
  readonly conformanceCandidateDigest?: string;
};
export function createVersionedMcpConformanceBinding(options: {
  readonly sourceRevision: string;
  readonly requirementsDigest: string;
  readonly reportDigest: string;
  readonly probeFamilyIds?: readonly string[];
}): Readonly<Record<string, unknown>>;
export function validateVersionedMcpConformanceBinding(
  binding: unknown,
  context?: BindingContext,
): string[];
export function createMcpConformanceCandidate(options: {
  readonly sourceRevision: string;
  readonly requirementsDigest: string;
  readonly reportDigest: string;
  readonly probeFamilyIds?: readonly string[];
}): Readonly<Record<string, unknown>>;
export function validateMcpConformanceCandidate(
  candidate: unknown,
  context?: BindingContext,
): string[];

export const mcpSdkAcceptedArtifactName: 'mcp-2026-07-28-sdk-accepted';
export const mcpSdkAcceptedEvidenceSchemaVersion: 1;
type AcceptedLegacyAbsence = Readonly<{
  readonly sourceFiles: number;
  readonly declarationFiles: number;
  readonly tarballFiles: number;
  readonly findings: readonly { readonly path: string; readonly symbol: string; readonly line: number }[];
}>;
export function versionedMcpAcceptedDigest(
  fields: Readonly<Record<string, unknown>>,
): string;
export function createMcp20260728SdkAccepted(options: {
  readonly sourceRevision: string;
  readonly requirementsDigest: string;
  readonly reportDigest: string;
  readonly conformanceCandidateDigest: string;
  readonly probeFamilyIds?: readonly string[];
  readonly legacyAbsence: AcceptedLegacyAbsence;
}): Readonly<Record<string, unknown>>;
export function validateMcp20260728SdkAccepted(
  artifact: unknown,
  context?: BindingContext,
): string[];
export function validateMcpReleaseAcceptanceArtifacts(
  artifacts: Readonly<{
    readonly candidate?: unknown;
    readonly accepted?: unknown;
  }>,
  context?: BindingContext,
): string[];
