export type RequirementLevel = 'MUST' | 'MUST_NOT' | 'SHOULD' | 'SHOULD_NOT' | 'MAY';

export interface RegistryRequirement {
  readonly id: string;
  readonly level: RequirementLevel;
  readonly profile: string;
  readonly source: string;
  readonly requirement: string;
  readonly implementation: readonly string[];
  readonly tests: readonly string[];
}

export interface Registry {
  readonly version: string | number;
  readonly requirements: readonly RegistryRequirement[];
}

export interface Evidence {
  readonly schemaVersion: number;
  readonly protocolVersion: string;
  readonly packageVersion: string;
  readonly requirementsDigest: string;
  readonly passedRequirementIds: readonly string[];
}

export const registryFiles: readonly string[];
export const profileDependencies: Readonly<Record<string, readonly string[]>>;
export const profiles: readonly string[];
export const evidenceSchemaVersion: number;

export function readRegistry(protocolRoot: string, name: string): Promise<Registry>;
export function validateRegistry(registry: unknown, label?: string): string[];
export function validateSourceAnchors(
  requirements: readonly RegistryRequirement[],
  protocolRoot: string,
): Promise<string[]>;
export function requirementsDigest(registry: Registry): string;
export function collectPassingTestIds(report: unknown, knownTestIds: ReadonlySet<string>): Set<string>;
export function passedRequirementIds(registry: Registry, passingTestIds: ReadonlySet<string>): string[];
export function createEvidence(input: {
  readonly registry: Registry;
  readonly packageVersion: string;
  readonly passingTestIds: ReadonlySet<string>;
}): Evidence;
export function validateEvidence(
  evidence: unknown,
  context: { readonly registry: Registry; readonly packageVersion: string },
): string[];
export function profileClosure(profile: string, result?: Set<string>): Set<string>;
