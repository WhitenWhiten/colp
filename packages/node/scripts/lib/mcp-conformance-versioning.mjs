import { mcpMigrationProtocolVersion, sha256Digest } from './conformance-evidence.mjs';

export const mcpConformanceEvidenceSchemaVersion = 1;

/**
 * Exact MCP protocol version attested by the versioned MCP conformance
 * evidence (development plan §6, migration decision §7). Must equal the
 * migration gate's quarantine version or the model fails closed.
 */
export const mcpConformanceProtocolVersion = '2026-07-28';

if (mcpConformanceProtocolVersion !== mcpMigrationProtocolVersion) {
  throw new Error('MCP conformance protocol version must equal the migration protocol version.');
}

/**
 * Fixed versioned MCP conformance probe families (development plan §6,
 * migration decision §7.5). The generic unversioned Read/Write deployment
 * probes are split into these six families; only these IDs are accepted in
 * the versioned flow.
 */
export const mcpConformanceProbeFamilies = Object.freeze([
  'mcp-2026-07-28.transport-header-contracts',
  'mcp-2026-07-28.discovery-contracts',
  'mcp-2026-07-28.subscription-contracts',
  'mcp-2026-07-28.read-schema-contracts',
  'mcp-2026-07-28.write-mrtr-contracts',
  'mcp-2026-07-28.oauth-client-contracts',
]);

/** Probe families each MCP Profile must exercise itself (dependencies expand). */
export const mcpConformanceProbeFamiliesByProfile = Object.freeze({
  'mcp-read': Object.freeze([
    'mcp-2026-07-28.transport-header-contracts',
    'mcp-2026-07-28.discovery-contracts',
    'mcp-2026-07-28.subscription-contracts',
    'mcp-2026-07-28.read-schema-contracts',
    'mcp-2026-07-28.oauth-client-contracts',
  ]),
  'mcp-write': Object.freeze(['mcp-2026-07-28.write-mrtr-contracts']),
});

/**
 * Old unversioned generic Read/Write deployment probe IDs. They may only be
 * rejected migration input: the versioned flow refuses them so stale generic
 * probes can never satisfy a 2026-07-28 claim.
 */
export const legacyMcpConformanceProbeIds = Object.freeze([
  'mcp-read.transport-contracts',
  'mcp-write.approval-contracts',
]);

/** Locked upstream MCP SDK versions (MCP_TRANSPORT.md, COLP-MCP-03). */
export const mcpSdkLock = Object.freeze({
  '@modelcontextprotocol/core': '2.0.0',
  '@modelcontextprotocol/client': '2.0.0',
  '@modelcontextprotocol/server': '2.0.0',
});

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
});

function canonicalJson(value) {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value)
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(',')}}`;
}

export const mcpFixtureTopologyDigest = sha256Digest(canonicalJson(mcpFixtureTopology));

const mcpConformanceProbeFamilySet = new Set(mcpConformanceProbeFamilies);
const legacyMcpConformanceProbeSet = new Set(legacyMcpConformanceProbeIds);

/** True when an ID is one of the six fixed versioned MCP probe families. */
export function isMcpConformanceProbeId(value) {
  return typeof value === 'string' && mcpConformanceProbeFamilySet.has(value);
}

/** True when an ID is an old unversioned generic MCP probe (rejected input). */
export function isLegacyMcpConformanceProbeId(value) {
  return typeof value === 'string' && legacyMcpConformanceProbeSet.has(value);
}

/**
 * Validates that a probe ID list contains exactly registered versioned
 * families, with no legacy replay, unknown IDs, or duplicates.
 */
export function validateMcpConformanceProbeIds(probeIds) {
  if (!Array.isArray(probeIds)) {
    return ['MCP conformance probe family IDs must be an array.'];
  }
  const errors = [];
  const seen = new Set();
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
export function rejectLegacyMcpConformanceProbeIds(probeIds) {
  if (!Array.isArray(probeIds)) {
    return ['MCP conformance probe IDs must be an array.'];
  }
  const errors = [];
  for (const probeId of probeIds) {
    if (isLegacyMcpConformanceProbeId(probeId)) {
      errors.push(`Legacy MCP probe ID ${probeId} is rejected migration input in the versioned conformance flow.`);
    }
  }
  return errors;
}

/**
 * Returns the fixed probe families a single MCP Profile must exercise
 * itself. mcp-write depends on mcp-read, so its full closure adds the
 * mcp-read families through the release profile dependency graph.
 */
export function mcpConformanceProbeFamilyIdsForProfile(profile) {
  if (!Object.hasOwn(mcpConformanceProbeFamiliesByProfile, profile)) {
    throw new Error(
      `MCP conformance probe families are only defined for mcp-read and mcp-write Profiles, not ${String(profile)}.`,
    );
  }
  return mcpConformanceProbeFamiliesByProfile[profile];
}

/**
 * SHA-256 digest over the canonical versioned binding fields. Tampering any
 * field (version, source, SDK lock, fixture topology, requirement/report
 * digest, probe families) invalidates the recomputed evidenceDigest.
 */
export function versionedMcpEvidenceDigest(fields) {
  const selected = {
    mcpVersion: fields?.mcpVersion,
    sourceRevision: fields?.sourceRevision,
    sdkLock: fields?.sdkLock,
    fixtureTopologyDigest: fields?.fixtureTopologyDigest,
    requirementsDigest: fields?.requirementsDigest,
    reportDigest: fields?.reportDigest,
    probeFamilyIds: fields?.probeFamilyIds,
  };
  return sha256Digest(canonicalJson(selected));
}

function deepEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Creates the exact versioned MCP conformance binding stamped on a
 * certificate, target evidence, and runner verdict: precise MCP version,
 * source revision, SDK lock, fixture topology digest, requirement/report
 * digests, the fixed probe families, and a self-referential evidenceDigest.
 */
export function createVersionedMcpConformanceBinding(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('MCP conformance binding input must be an object.');
  }
  const { sourceRevision, requirementsDigest, reportDigest } = input;
  const probeFamilyIds = input.probeFamilyIds ?? mcpConformanceProbeFamilies;
  const errors = [];
  if (typeof sourceRevision !== 'string' || !/^[0-9a-f]{40,64}$/u.test(sourceRevision)) {
    errors.push('MCP conformance binding sourceRevision must be a full hexadecimal commit ID.');
  }
  if (typeof requirementsDigest !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(requirementsDigest)) {
    errors.push('MCP conformance binding requirementsDigest must be a SHA-256 digest.');
  }
  if (typeof reportDigest !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(reportDigest)) {
    errors.push('MCP conformance binding reportDigest must be a SHA-256 digest.');
  }
  errors.push(...validateMcpConformanceProbeIds(probeFamilyIds));
  if (errors.length > 0) {
    throw new TypeError(`Invalid MCP conformance binding:\n- ${errors.join('\n- ')}`);
  }
  const binding = {
    schemaVersion: mcpConformanceEvidenceSchemaVersion,
    mcpVersion: mcpConformanceProtocolVersion,
    sourceRevision,
    sdkLock: mcpSdkLock,
    fixtureTopologyDigest: mcpFixtureTopologyDigest,
    requirementsDigest,
    reportDigest,
    probeFamilyIds: Object.freeze([...probeFamilyIds]),
  };
  binding.evidenceDigest = versionedMcpEvidenceDigest(binding);
  return Object.freeze(binding);
}

/**
 * Validates a versioned binding layer by layer: schema version, exact MCP
 * version, source revision, SDK lock, fixture topology digest, requirement
 * and report digests, probe families, and the recomputed evidenceDigest.
 */
export function validateVersionedMcpConformanceBinding(binding, context = {}) {
  if (binding === null || typeof binding !== 'object' || Array.isArray(binding)) {
    return ['MCP conformance evidence must be an object.'];
  }
  const errors = [];
  const expectedVersion = context.mcpVersion ?? mcpConformanceProtocolVersion;
  const expectedSdkLock = context.sdkLock ?? mcpSdkLock;
  const expectedTopologyDigest = context.fixtureTopologyDigest ?? mcpFixtureTopologyDigest;

  if (binding.schemaVersion !== mcpConformanceEvidenceSchemaVersion) {
    errors.push(`Unsupported MCP conformance evidence schemaVersion: ${String(binding.schemaVersion)}.`);
  }
  if (binding.mcpVersion !== expectedVersion) {
    errors.push(
      `MCP conformance evidence must bind the exact MCP version ${expectedVersion}, received ${String(binding.mcpVersion)}.`,
    );
  }
  if (typeof binding.sourceRevision !== 'string' || !/^[0-9a-f]{40,64}$/u.test(binding.sourceRevision)) {
    errors.push('MCP conformance evidence sourceRevision must be a full hexadecimal commit ID.');
  } else if (context.sourceRevision !== undefined && binding.sourceRevision !== context.sourceRevision) {
    errors.push('MCP conformance evidence sourceRevision does not match the attested source revision.');
  }
  if (!deepEqual(binding.sdkLock, expectedSdkLock)) {
    errors.push('MCP conformance evidence SDK lock does not match the locked @modelcontextprotocol versions.');
  }
  if (binding.fixtureTopologyDigest !== expectedTopologyDigest) {
    errors.push(
      'MCP conformance evidence fixture topology digest does not match the locked reference-client/fixture-host topology.',
    );
  }
  if (typeof binding.requirementsDigest !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(binding.requirementsDigest)) {
    errors.push('MCP conformance evidence requirementsDigest must be a SHA-256 digest.');
  } else if (context.requirementsDigest !== undefined && binding.requirementsDigest !== context.requirementsDigest) {
    errors.push('MCP conformance evidence requirementsDigest does not match the registry digest.');
  }
  if (typeof binding.reportDigest !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(binding.reportDigest)) {
    errors.push('MCP conformance evidence reportDigest must be a SHA-256 digest.');
  } else if (context.reportDigest !== undefined && binding.reportDigest !== context.reportDigest) {
    errors.push('MCP conformance evidence reportDigest does not match the owned test report digest.');
  }
  const probeErrors = validateMcpConformanceProbeIds(binding.probeFamilyIds);
  errors.push(...probeErrors.map((error) => `Probe family: ${error}`));
  if (Array.isArray(binding.probeFamilyIds)) {
    const present = new Set(binding.probeFamilyIds);
    const missing = mcpConformanceProbeFamilies.filter((family) => !present.has(family));
    if (missing.length > 0) {
      errors.push(`MCP conformance evidence misses required probe family IDs: ${missing.join(', ')}.`);
    }
  }
  if (typeof binding.evidenceDigest !== 'string' || binding.evidenceDigest !== versionedMcpEvidenceDigest(binding)) {
    errors.push('MCP conformance evidenceDigest does not match the versioned binding fields.');
  }
  return errors;
}

/** Builds and wraps a versioned binding as the source-bound mcp-conformance-candidate. */
export function createMcpConformanceCandidate(input) {
  const binding = createVersionedMcpConformanceBinding(input);
  return Object.freeze({ candidate: 'mcp-conformance-candidate', ...binding });
}

/**
 * Validates the source-bound mcp-conformance-candidate: the artifact name
 * plus the full layer-by-layer versioned binding validation.
 */
export function validateMcpConformanceCandidate(candidate, context = {}) {
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return ['MCP conformance candidate must be an object.'];
  }
  const errors = [];
  if (candidate.candidate !== 'mcp-conformance-candidate') {
    errors.push(
      `MCP conformance candidate must be named mcp-conformance-candidate, received ${String(candidate.candidate)}.`,
    );
  }
  errors.push(...validateVersionedMcpConformanceBinding(candidate, context));
  return errors;
}

/**
 * Accepted `mcp-2026-07-28-sdk-accepted` artifact (COLP-MCP-15).
 *
 * The accepted artifact extends the versioned conformance binding with the
 * validated conformance-candidate digest and the Legacy MCP absence scan
 * verdict, and binds all fields in a self-referential evidence digest so
 * tampering any layer (version, source, SDK lock, fixture topology,
 * requirement/report digest, probe families, candidate digest, absence
 * counts/findings) is rejected.
 */
export const mcpSdkAcceptedArtifactName = 'mcp-2026-07-28-sdk-accepted';
export const mcpSdkAcceptedEvidenceSchemaVersion = 1;

/** SHA-256 digest over the canonical accepted-artifact binding fields. */
export function versionedMcpAcceptedDigest(fields) {
  const selected = {
    candidate: fields?.candidate,
    schemaVersion: fields?.schemaVersion,
    mcpVersion: fields?.mcpVersion,
    sourceRevision: fields?.sourceRevision,
    sdkLock: fields?.sdkLock,
    fixtureTopologyDigest: fields?.fixtureTopologyDigest,
    requirementsDigest: fields?.requirementsDigest,
    reportDigest: fields?.reportDigest,
    probeFamilyIds: fields?.probeFamilyIds,
    conformanceCandidateDigest: fields?.conformanceCandidateDigest,
    legacyAbsence: fields?.legacyAbsence,
  };
  return sha256Digest(canonicalJson(selected));
}

function validateLegacyAbsenceRecord(record) {
  if (record === null || typeof record !== 'object' || Array.isArray(record)) {
    return ['Accepted artifact legacyAbsence must be an object.'];
  }
  const errors = [];
  for (const field of ['sourceFiles', 'declarationFiles', 'tarballFiles']) {
    if (
      typeof record[field] !== 'number'
      || !Number.isInteger(record[field])
      || record[field] < 0
    ) {
      errors.push(`Accepted artifact legacyAbsence.${field} must be a non-negative integer.`);
    }
  }
  if (!Array.isArray(record.findings)) {
    errors.push('Accepted artifact legacyAbsence.findings must be an array.');
  } else if (record.findings.length > 0) {
    errors.push(
      'Accepted artifact legacyAbsence.findings must be empty: the Legacy MCP absence scan found symbols.',
    );
  }
  return errors;
}

/**
 * Creates the exact accepted `mcp-2026-07-28-sdk-accepted` artifact. The
 * runner refuses to call this when the Legacy MCP absence scan found
 * anything; `legacyAbsence.findings` must be empty.
 */
export function createMcp20260728SdkAccepted(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('MCP 2026-07-28 SDK accepted input must be an object.');
  }
  const { sourceRevision, requirementsDigest, reportDigest, conformanceCandidateDigest } = input;
  const probeFamilyIds = input.probeFamilyIds ?? mcpConformanceProbeFamilies;
  const legacyAbsence = input.legacyAbsence;
  const errors = [];
  if (typeof sourceRevision !== 'string' || !/^[0-9a-f]{40,64}$/u.test(sourceRevision)) {
    errors.push('MCP 2026-07-28 SDK accepted sourceRevision must be a full hexadecimal commit ID.');
  }
  if (typeof requirementsDigest !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(requirementsDigest)) {
    errors.push('MCP 2026-07-28 SDK accepted requirementsDigest must be a SHA-256 digest.');
  }
  if (typeof reportDigest !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(reportDigest)) {
    errors.push('MCP 2026-07-28 SDK accepted reportDigest must be a SHA-256 digest.');
  }
  if (
    typeof conformanceCandidateDigest !== 'string'
    || !/^sha256:[0-9a-f]{64}$/u.test(conformanceCandidateDigest)
  ) {
    errors.push('MCP 2026-07-28 SDK accepted conformanceCandidateDigest must be a SHA-256 digest.');
  }
  const probeErrors = validateMcpConformanceProbeIds(probeFamilyIds);
  errors.push(...probeErrors.map((error) => `Probe family: ${error}`));
  if (Array.isArray(probeFamilyIds)) {
    const present = new Set(probeFamilyIds);
    const missing = mcpConformanceProbeFamilies.filter((family) => !present.has(family));
    if (missing.length > 0) {
      errors.push(`MCP 2026-07-28 SDK accepted misses required probe family IDs: ${missing.join(', ')}.`);
    }
  }
  errors.push(...validateLegacyAbsenceRecord(legacyAbsence));
  if (errors.length > 0) {
    throw new TypeError(`Invalid MCP 2026-07-28 SDK accepted input:\n- ${errors.join('\n- ')}`);
  }

  const artifact = {
    candidate: mcpSdkAcceptedArtifactName,
    schemaVersion: mcpSdkAcceptedEvidenceSchemaVersion,
    mcpVersion: mcpConformanceProtocolVersion,
    sourceRevision,
    sdkLock: mcpSdkLock,
    fixtureTopologyDigest: mcpFixtureTopologyDigest,
    requirementsDigest,
    reportDigest,
    probeFamilyIds: Object.freeze([...probeFamilyIds]),
    conformanceCandidateDigest,
    legacyAbsence: Object.freeze({
      sourceFiles: legacyAbsence.sourceFiles,
      declarationFiles: legacyAbsence.declarationFiles,
      tarballFiles: legacyAbsence.tarballFiles,
      findings: Object.freeze([]),
    }),
  };
  artifact.evidenceDigest = versionedMcpAcceptedDigest(artifact);
  return Object.freeze(artifact);
}

/**
 * Validates an accepted `mcp-2026-07-28-sdk-accepted` artifact layer by
 * layer, including the recomputed evidence digest and the empty absence
 * findings requirement.
 */
export function validateMcp20260728SdkAccepted(artifact, context = {}) {
  if (artifact === null || typeof artifact !== 'object' || Array.isArray(artifact)) {
    return ['MCP 2026-07-28 SDK accepted artifact must be an object.'];
  }
  const errors = [];
  const expectedVersion = context.mcpVersion ?? mcpConformanceProtocolVersion;
  const expectedSdkLock = context.sdkLock ?? mcpSdkLock;
  const expectedTopologyDigest = context.fixtureTopologyDigest ?? mcpFixtureTopologyDigest;

  if (artifact.candidate !== mcpSdkAcceptedArtifactName) {
    errors.push(
      `MCP 2026-07-28 SDK accepted artifact must be named ${mcpSdkAcceptedArtifactName}, received ${String(artifact.candidate)}.`,
    );
  }
  if (artifact.schemaVersion !== mcpSdkAcceptedEvidenceSchemaVersion) {
    errors.push(
      `Unsupported MCP 2026-07-28 SDK accepted schemaVersion: ${String(artifact.schemaVersion)}.`,
    );
  }
  if (artifact.mcpVersion !== expectedVersion) {
    errors.push(
      `MCP 2026-07-28 SDK accepted artifact must bind the exact MCP version ${expectedVersion}, received ${String(artifact.mcpVersion)}.`,
    );
  }
  if (typeof artifact.sourceRevision !== 'string' || !/^[0-9a-f]{40,64}$/u.test(artifact.sourceRevision)) {
    errors.push('MCP 2026-07-28 SDK accepted sourceRevision must be a full hexadecimal commit ID.');
  } else if (context.sourceRevision !== undefined && artifact.sourceRevision !== context.sourceRevision) {
    errors.push('MCP 2026-07-28 SDK accepted sourceRevision does not match the attested source revision.');
  }
  if (!deepEqual(artifact.sdkLock, expectedSdkLock)) {
    errors.push('MCP 2026-07-28 SDK accepted SDK lock does not match the locked @modelcontextprotocol versions.');
  }
  if (artifact.fixtureTopologyDigest !== expectedTopologyDigest) {
    errors.push(
      'MCP 2026-07-28 SDK accepted fixture topology digest does not match the locked reference-client/fixture-host topology.',
    );
  }
  if (typeof artifact.requirementsDigest !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(artifact.requirementsDigest)) {
    errors.push('MCP 2026-07-28 SDK accepted requirementsDigest must be a SHA-256 digest.');
  } else if (context.requirementsDigest !== undefined && artifact.requirementsDigest !== context.requirementsDigest) {
    errors.push('MCP 2026-07-28 SDK accepted requirementsDigest does not match the registry digest.');
  }
  if (typeof artifact.reportDigest !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(artifact.reportDigest)) {
    errors.push('MCP 2026-07-28 SDK accepted reportDigest must be a SHA-256 digest.');
  } else if (context.reportDigest !== undefined && artifact.reportDigest !== context.reportDigest) {
    errors.push('MCP 2026-07-28 SDK accepted reportDigest does not match the owned test report digest.');
  }
  if (
    typeof artifact.conformanceCandidateDigest !== 'string'
    || !/^sha256:[0-9a-f]{64}$/u.test(artifact.conformanceCandidateDigest)
  ) {
    errors.push('MCP 2026-07-28 SDK accepted conformanceCandidateDigest must be a SHA-256 digest.');
  } else if (
    context.conformanceCandidateDigest !== undefined
    && artifact.conformanceCandidateDigest !== context.conformanceCandidateDigest
  ) {
    errors.push(
      'MCP 2026-07-28 SDK accepted conformanceCandidateDigest does not match the tracked conformance candidate.',
    );
  }
  const probeErrors = validateMcpConformanceProbeIds(artifact.probeFamilyIds);
  errors.push(...probeErrors.map((error) => `Probe family: ${error}`));
  if (Array.isArray(artifact.probeFamilyIds)) {
    const present = new Set(artifact.probeFamilyIds);
    const missing = mcpConformanceProbeFamilies.filter((family) => !present.has(family));
    if (missing.length > 0) {
      errors.push(`MCP 2026-07-28 SDK accepted misses required probe family IDs: ${missing.join(', ')}.`);
    }
  }
  errors.push(...validateLegacyAbsenceRecord(artifact.legacyAbsence));
  if (typeof artifact.evidenceDigest !== 'string' || artifact.evidenceDigest !== versionedMcpAcceptedDigest(artifact)) {
    errors.push('MCP 2026-07-28 SDK accepted evidenceDigest does not match the accepted binding fields.');
  }
  return errors;
}

/**
 * Release-gate validation for the tracked MCP candidate and accepted record.
 * Both layers must bind one shared MCP acceptance revision and the current
 * requirements, and the accepted record must bind the exact digest of the
 * validated candidate. The generic release certificate is refreshed in a
 * later commit, so its source revision is intentionally independent. Each
 * layer retains its own independently generated test report.
 */
export function validateMcpReleaseAcceptanceArtifacts(artifacts, context = {}) {
  const candidate = artifacts?.candidate;
  const accepted = artifacts?.accepted;
  const candidateErrors = validateMcpConformanceCandidate(candidate, context);
  const candidateDigest = candidate !== null && typeof candidate === 'object'
    ? candidate.evidenceDigest
    : undefined;
  const acceptedErrors = validateMcp20260728SdkAccepted(accepted, {
    ...context,
    conformanceCandidateDigest: candidateDigest,
  });
  return [
    ...candidateErrors.map((error) => `Conformance candidate: ${error}`),
    ...acceptedErrors.map((error) => `Accepted SDK artifact: ${error}`),
  ];
}
