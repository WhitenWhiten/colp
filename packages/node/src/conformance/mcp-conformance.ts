import { createHash } from 'node:crypto';

export const mcpConformanceEvidenceSchemaVersion = 1 as const;
export const mcpConformanceProtocolVersion = '2026-07-28' as const;

/**
 * Fixed versioned MCP conformance probe families (development plan §6,
 * migration decision §7.5). These replace the generic unversioned
 * Read/Write deployment probes; the old IDs are rejected migration input.
 */
export const mcpConformanceProbeFamilies = Object.freeze([
  'mcp-2026-07-28.transport-header-contracts',
  'mcp-2026-07-28.discovery-contracts',
  'mcp-2026-07-28.subscription-contracts',
  'mcp-2026-07-28.read-schema-contracts',
  'mcp-2026-07-28.write-mrtr-contracts',
  'mcp-2026-07-28.oauth-client-contracts',
] as const);

export type McpConformanceProbeFamilyId = (typeof mcpConformanceProbeFamilies)[number];

/** Probe families each MCP Profile must exercise itself (dependencies expand). */
export const mcpConformanceProbeFamiliesByProfile = Object.freeze({
  'mcp-read': Object.freeze([
    'mcp-2026-07-28.transport-header-contracts',
    'mcp-2026-07-28.discovery-contracts',
    'mcp-2026-07-28.subscription-contracts',
    'mcp-2026-07-28.read-schema-contracts',
    'mcp-2026-07-28.oauth-client-contracts',
  ] as const satisfies readonly McpConformanceProbeFamilyId[]),
  'mcp-write': Object.freeze([
    'mcp-2026-07-28.write-mrtr-contracts',
  ] as const satisfies readonly McpConformanceProbeFamilyId[]),
} as const);

/**
 * Old unversioned generic Read/Write deployment probe IDs. They may only be
 * rejected migration input: the versioned flow refuses them so stale generic
 * probes can never satisfy a 2026-07-28 claim.
 */
export const legacyMcpConformanceProbeIds = Object.freeze([
  'mcp-read.transport-contracts',
  'mcp-write.approval-contracts',
] as const);

export type LegacyMcpConformanceProbeId = (typeof legacyMcpConformanceProbeIds)[number];

/** Locked upstream MCP SDK versions (MCP_TRANSPORT.md). */
export const mcpSdkLock = Object.freeze({
  '@modelcontextprotocol/core': '2.0.0',
  '@modelcontextprotocol/client': '2.0.0',
  '@modelcontextprotocol/server': '2.0.0',
} as const);

/**
 * Locked reference-client / fixture-host boundary (MCP_TRANSPORT.md §Harness
 * topology). The fixture host is test-only and never enters production
 * exports or the packed tarball; the client is the independent official SDK.
 */
export const mcpFixtureTopology = Object.freeze({
  referenceClient: 'tests/fixtures/mcp-2026-07-28/reference-client',
  fixtureHost: 'tests/fixtures/mcp-2026-07-28/fixture-host',
  boundary:
    'independent official @modelcontextprotocol/client over a test-only '
    + '@modelcontextprotocol/server host bridge; no shared hand-written '
    + 'JSON-RPC/SSE frame parser; fixture host never enters production '
    + 'exports or the packed tarball',
} as const);

export function sha256Digest(source: string): string {
  return `sha256:${createHash('sha256').update(source).digest('hex')}`;
}

function canonicalJson(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value)
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
    .map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`)
    .join(',')}}`;
}

export const mcpFixtureTopologyDigest = sha256Digest(canonicalJson(mcpFixtureTopology));

export interface McpVersionedEvidenceBindingFields {
  readonly mcpVersion: string;
  readonly packageVersion: string;
  readonly sdkLock: Readonly<Record<string, string>>;
  readonly fixtureTopologyDigest: string;
  readonly requirementsDigest: string;
  readonly probeFamilyIds: readonly string[];
}

/** Exact versioned binding stamped on deployment target evidence. */
export interface McpVersionedEvidenceBinding extends McpVersionedEvidenceBindingFields {
  readonly schemaVersion: 1;
  readonly evidenceDigest: string;
}

export interface McpConformanceEvidenceContext {
  readonly mcpVersion?: string;
  readonly packageVersion?: string;
  readonly sdkLock?: Readonly<Record<string, string>>;
  readonly fixtureTopologyDigest?: string;
  readonly requirementsDigest?: string;
  /** Exact 2026-07-28 families a deployment evidence binding must carry. */
  readonly probeFamilyIds?: readonly string[];
}

export interface CreateVersionedMcpEvidenceBindingInput {
  readonly packageVersion: string;
  readonly requirementsDigest: string;
  readonly probeFamilyIds?: readonly string[];
}

const mcpConformanceProbeFamilySet = new Set<string>(mcpConformanceProbeFamilies);
const legacyMcpConformanceProbeSet = new Set<string>(legacyMcpConformanceProbeIds);

/** True when an ID is one of the six fixed versioned MCP probe families. */
export function isMcpConformanceProbeId(value: unknown): boolean {
  return typeof value === 'string' && mcpConformanceProbeFamilySet.has(value);
}

/** True when an ID is an old unversioned generic MCP probe (rejected input). */
export function isLegacyMcpConformanceProbeId(value: unknown): boolean {
  return typeof value === 'string' && legacyMcpConformanceProbeSet.has(value);
}

/**
 * Validates that a probe ID list contains exactly registered versioned
 * families, with no legacy replay, unknown IDs, or duplicates.
 */
export function validateMcpConformanceProbeIds(probeIds: unknown): string[] {
  if (!Array.isArray(probeIds)) {
    return ['MCP conformance probe family IDs must be an array.'];
  }
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const probeId of probeIds) {
    if (typeof probeId !== 'string') {
      errors.push(`MCP conformance probe family ID must be a string, received ${String(probeId)}.`);
      continue;
    }
    if (isLegacyMcpConformanceProbeId(probeId)) {
      errors.push(
        `Legacy MCP probe ID ${probeId} is rejected migration input; only exact 2026-07-28 family probes are accepted.`,
      );
    } else if (!mcpConformanceProbeFamilySet.has(probeId)) {
      errors.push(`MCP conformance probe family ${probeId} is not a registered 2026-07-28 family.`);
    }
    if (seen.has(probeId)) {
      errors.push(`MCP conformance probe family repeats: ${probeId}.`);
    }
    seen.add(probeId);
  }
  return errors;
}

/**
 * Rejected-migration-input gate: reports every legacy unversioned MCP probe
 * ID supplied to a versioned conformance flow.
 */
export function rejectLegacyMcpConformanceProbeIds(probeIds: readonly unknown[]): string[] {
  if (!Array.isArray(probeIds)) {
    return ['MCP conformance probe IDs must be an array.'];
  }
  const errors: string[] = [];
  for (const probeId of probeIds) {
    if (isLegacyMcpConformanceProbeId(probeId)) {
      errors.push(
        `Legacy MCP probe ID ${String(probeId)} is rejected migration input in the versioned conformance flow.`,
      );
    }
  }
  return errors;
}

/**
 * Returns the fixed probe families a single MCP Profile must exercise
 * itself. mcp-write depends on mcp-read, so its full closure adds the
 * mcp-read families through the release profile dependency graph.
 */
export function mcpConformanceProbeFamilyIdsForProfile(
  profile: string,
): readonly McpConformanceProbeFamilyId[] {
  if (profile !== 'mcp-read' && profile !== 'mcp-write') {
    throw new TypeError(
      `MCP conformance probe families are only defined for mcp-read and mcp-write Profiles, not ${String(profile)}.`,
    );
  }
  return mcpConformanceProbeFamiliesByProfile[profile];
}

/**
 * SHA-256 digest over the canonical versioned binding fields. Tampering any
 * field (version, package version, SDK lock, fixture topology, requirements
 * digest, probe families) invalidates the recomputed evidenceDigest.
 */
export function versionedMcpEvidenceDigest(fields: McpVersionedEvidenceBindingFields): string {
  const selected = {
    mcpVersion: fields.mcpVersion,
    packageVersion: fields.packageVersion,
    sdkLock: fields.sdkLock,
    fixtureTopologyDigest: fields.fixtureTopologyDigest,
    requirementsDigest: fields.requirementsDigest,
    probeFamilyIds: fields.probeFamilyIds,
  };
  return sha256Digest(canonicalJson(selected));
}

function deepEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Creates the exact versioned MCP conformance binding stamped on target
 * evidence: precise MCP version, package version, SDK lock, fixture topology
 * digest, requirements digest, the fixed probe families, and a
 * self-referential evidenceDigest.
 */
export function createVersionedMcpEvidenceBinding(
  input: CreateVersionedMcpEvidenceBindingInput,
): McpVersionedEvidenceBinding {
  const probeFamilyIds = input.probeFamilyIds ?? mcpConformanceProbeFamilies;
  const errors: string[] = [
    ...(typeof input.packageVersion !== 'string' || input.packageVersion.length === 0
      ? ['MCP conformance binding packageVersion must be a non-empty string.']
      : []),
    ...(typeof input.requirementsDigest !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(input.requirementsDigest)
      ? ['MCP conformance binding requirementsDigest must be a SHA-256 digest.']
      : []),
    ...validateMcpConformanceProbeIds(probeFamilyIds),
  ];
  if (errors.length > 0) {
    throw new TypeError(`Invalid MCP conformance binding:\n- ${errors.join('\n- ')}`);
  }
  const binding: McpVersionedEvidenceBinding = {
    schemaVersion: 1,
    mcpVersion: mcpConformanceProtocolVersion,
    packageVersion: input.packageVersion,
    sdkLock: mcpSdkLock,
    fixtureTopologyDigest: mcpFixtureTopologyDigest,
    requirementsDigest: input.requirementsDigest,
    probeFamilyIds: Object.freeze([...probeFamilyIds]),
    evidenceDigest: '',
  };
  return Object.freeze({ ...binding, evidenceDigest: versionedMcpEvidenceDigest(binding) });
}

/**
 * Validates a versioned binding layer by layer: schema version, exact MCP
 * version, package version, SDK lock, fixture topology digest, requirements
 * digest, probe families, and the recomputed evidenceDigest.
 */
export function validateVersionedMcpEvidenceBindingErrors(
  binding: unknown,
  context: McpConformanceEvidenceContext = {},
): string[] {
  if (binding === null || typeof binding !== 'object' || Array.isArray(binding)) {
    return ['MCP conformance evidence must be an object.'];
  }
  const value = binding as McpVersionedEvidenceBinding;
  const errors: string[] = [];
  const expectedVersion = context.mcpVersion ?? mcpConformanceProtocolVersion;
  const expectedSdkLock = context.sdkLock ?? mcpSdkLock;
  const expectedTopologyDigest = context.fixtureTopologyDigest ?? mcpFixtureTopologyDigest;

  if (value.schemaVersion !== mcpConformanceEvidenceSchemaVersion) {
    errors.push(`Unsupported MCP conformance evidence schemaVersion: ${String(value.schemaVersion)}.`);
  }
  if (value.mcpVersion !== expectedVersion) {
    errors.push(
      `MCP conformance evidence must bind the exact MCP version ${expectedVersion}, received ${String(value.mcpVersion)}.`,
    );
  }
  if (typeof value.packageVersion !== 'string' || value.packageVersion.length === 0) {
    errors.push('MCP conformance evidence packageVersion must be a non-empty string.');
  } else if (context.packageVersion !== undefined && value.packageVersion !== context.packageVersion) {
    errors.push('MCP conformance evidence packageVersion does not match the package version.');
  }
  if (!deepEqual(value.sdkLock, expectedSdkLock)) {
    errors.push('MCP conformance evidence SDK lock does not match the locked @modelcontextprotocol versions.');
  }
  if (value.fixtureTopologyDigest !== expectedTopologyDigest) {
    errors.push(
      'MCP conformance evidence fixture topology digest does not match the locked reference-client/fixture-host topology.',
    );
  }
  if (
    typeof value.requirementsDigest !== 'string'
    || !/^sha256:[0-9a-f]{64}$/u.test(value.requirementsDigest)
  ) {
    errors.push('MCP conformance evidence requirementsDigest must be a SHA-256 digest.');
  } else if (
    context.requirementsDigest !== undefined
    && value.requirementsDigest !== context.requirementsDigest
  ) {
    errors.push('MCP conformance evidence requirementsDigest does not match the registry digest.');
  }
  const probeErrors = validateMcpConformanceProbeIds(value.probeFamilyIds);
  errors.push(...probeErrors.map((error) => `Probe family: ${error}`));
  if (Array.isArray(value.probeFamilyIds)) {
    const present = new Set(value.probeFamilyIds);
    const expectedFamilies = context.probeFamilyIds ?? mcpConformanceProbeFamilies;
    const missing = expectedFamilies.filter((family) => !present.has(family));
    if (missing.length > 0) {
      errors.push(`MCP conformance evidence misses required probe family IDs: ${missing.join(', ')}.`);
    }
    const extra = value.probeFamilyIds.filter((family) => !expectedFamilies.includes(family));
    if (extra.length > 0) {
      errors.push(`MCP conformance evidence carries unrequested probe family IDs: ${extra.join(', ')}.`);
    }
  }
  if (typeof value.evidenceDigest !== 'string' || value.evidenceDigest !== versionedMcpEvidenceDigest(value)) {
    errors.push('MCP conformance evidenceDigest does not match the versioned binding fields.');
  }
  return errors;
}

/** Throws when a value is not an exact versioned MCP conformance binding. */
export function assertVersionedMcpEvidenceBinding(
  value: unknown,
  context?: McpConformanceEvidenceContext,
): asserts value is McpVersionedEvidenceBinding {
  const errors = validateVersionedMcpEvidenceBindingErrors(value, context);
  if (errors.length > 0) {
    throw new TypeError(`Invalid MCP conformance evidence:\n- ${errors.join('\n- ')}`);
  }
}
