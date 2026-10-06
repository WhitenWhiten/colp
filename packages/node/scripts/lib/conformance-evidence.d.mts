export const evidenceSchemaVersion: 1;
export const releaseProfileDependencies: Readonly<Record<string, readonly string[]>>;
export const registeredReleaseProfiles: readonly string[];
export const mcpMigrationProtocolVersion: '2026-07-28';
export const mcpAcceptedProtocolVersion: '2026-07-28';
export const mcpMigrationQuarantinedProfiles: readonly [];
export function isMigratingMcpReleaseProfile(profile: unknown): boolean;
export function isQuarantinedMcpRequirement(requirement: unknown): boolean;
export function applyMcpEvidenceQuarantine(
  passedRequirementIds: readonly string[],
  requirements: readonly { readonly id: string; readonly profile?: string }[],
): string[];
export const releaseEvidenceProtectedPaths: readonly string[];
export const releaseEvidenceMutablePaths: readonly string[];
export function sha256Digest(source: string | Uint8Array): string;
export function requirementsDigest(registry: unknown): string;
export type RequirementRegistry = {
  readonly version?: string | number;
  readonly requirements: readonly {
    readonly id: string;
    readonly level?: string;
    readonly profile?: string;
    readonly source?: string;
    readonly requirement?: string;
    readonly selector?: Readonly<Record<string, unknown>>;
    readonly implementation?: readonly string[];
    readonly tests?: readonly string[];
  }[];
};
type EvidenceContext = {
  readonly protocolVersion: string;
  readonly packageVersion: string;
  readonly requirementsDigest: string;
  readonly requirements: readonly {
    readonly id: string;
    readonly tests: readonly string[];
  }[];
};
type GitRunner = (arguments_: readonly string[], cwd: string) => Promise<string>;
export function validateRequirementRegistry(
  registry: unknown,
  profileDependencies?: Readonly<Record<string, readonly string[]>>,
): string[];
export function requiredRequirementIdsForProfile(
  registry: RequirementRegistry,
  profile: string,
  profileDependencies?: Readonly<Record<string, readonly string[]>>,
): string[];
export function collectPassingTestIds(report: unknown, registry: RequirementRegistry): Set<string>;
export function verifyRepositoryState(
  sourceRevision: string,
  repositoryRoot: string,
  runGit: GitRunner,
  protectedPaths?: readonly string[],
): Promise<void>;
export function verifyTrackedEvidenceRepositoryState(
  sourceRevision: string,
  repositoryRoot: string,
  runGit: GitRunner,
  options?: {
    readonly protectedPaths?: readonly string[];
    readonly mutablePaths?: readonly string[];
  },
): Promise<string>;
export function generateVerifiedEvidence(options: {
  readonly registry: RequirementRegistry;
  readonly reportRegistry?: RequirementRegistry;
  readonly context: EvidenceContext;
  readonly sourceRevision: string;
  readonly repositoryRoot: string;
  readonly runGit: GitRunner;
  readonly runTests: (sourceRevision: string) => Promise<string>;
}): Promise<{
  readonly schemaVersion: 1;
  readonly protocolVersion: string;
  readonly packageVersion: string;
  readonly sourceRevision: string;
  readonly requirementsDigest: string;
  readonly reportDigest: string;
  readonly passedRequirementIds: string[];
}>;
export function validateEvidenceArtifact(
  artifact: unknown,
  context: EvidenceContext,
): string[];
export function validateReleaseEvidenceArtifact(
  artifact: unknown,
  context: EvidenceContext,
  options: {
    readonly profile: string;
    readonly sourceRevision: string;
    readonly profileDependencies?: Readonly<Record<string, readonly string[]>>;
  },
): string[];

export function validateMcpMigrationClosedEvidence(
  artifact: unknown,
  context: EvidenceContext,
  options: { readonly profile: string },
): string[];
