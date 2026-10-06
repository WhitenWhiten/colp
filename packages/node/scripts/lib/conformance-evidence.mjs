import { createHash } from 'node:crypto';

export const evidenceSchemaVersion = 1;

export const releaseProfileDependencies = Object.freeze({
  core: Object.freeze([]),
  publication: Object.freeze(['core']),
  feed: Object.freeze(['publication']),
  publisher: Object.freeze(['publication']),
  sync: Object.freeze(['core']),
  'mcp-read': Object.freeze(['core']),
  'mcp-write': Object.freeze(['mcp-read', 'publisher']),
});

export const registeredReleaseProfiles = Object.freeze(
  Object.keys(releaseProfileDependencies),
);

/**
 * Exact MCP protocol version that may re-open the `mcp-read` / `mcp-write`
 * package claims (development plan §4, migration decision §7.1). COLP-MCP-15
 * accepted exact `2026-07-28` source-bound evidence; the profiles are no
 * longer quarantined (`mcpMigrationQuarantinedProfiles` is empty) and MCP-*
 * Requirement IDs are never stripped from bundled evidence.
 */
export const mcpMigrationProtocolVersion = '2026-07-28';

/** Exact MCP protocol version accepted by COLP-MCP-15 (accepted state). */
export const mcpAcceptedProtocolVersion = '2026-07-28';

/**
 * mcp-* profiles quarantined while the SDK migrates. After COLP-MCP-15 the
 * exact 2026-07-28 evidence is accepted and the set is empty, so every
 * registered release profile is releasable through the normal evidence gate.
 */
export const mcpMigrationQuarantinedProfiles = Object.freeze([]);

const mcpMigrationQuarantinedProfileSet = new Set(mcpMigrationQuarantinedProfiles);

/** True when a release profile is quarantined behind the MCP migration gate. */
export function isMigratingMcpReleaseProfile(profile) {
  return mcpMigrationQuarantinedProfileSet.has(profile);
}

/** True when a Requirement record belongs to a quarantined mcp-* Profile. */
export function isQuarantinedMcpRequirement(requirement) {
  return requirement !== null
    && typeof requirement === 'object'
    && mcpMigrationQuarantinedProfileSet.has(requirement.profile);
}

/**
 * In the accepted state no mcp-* Profile is quarantined, so the input list
 * passes through unchanged: MCP-* Requirement IDs stay in bundled evidence
 * and authorize the claim only when the owned test report verifies them.
 * Kept under the migration-era name for callers.
 */
export function applyMcpEvidenceQuarantine(passedRequirementIds, requirements) {
  return passedRequirementIds;
}

export const releaseEvidenceProtectedPaths = Object.freeze([
  'packages/node',
  'protocol',
  '.github/workflows/colp-ci.yml',
]);

export const releaseEvidenceMutablePaths = Object.freeze([
  'packages/node/src/conformance/generated/evidence.json',
  'packages/node/docs/TRACEABILITY.md',
  // COLP-MCP-15 generated acceptance records: regenerated at the attested
  // source revision and committed by the follow-up evidence-refresh commit.
  'packages/node/src/conformance/generated/mcp-conformance-candidate.json',
  'packages/node/src/conformance/generated/mcp-2026-07-28-sdk-accepted.json',
]);

const requirementLevels = new Set(['MUST', 'MUST_NOT', 'SHOULD', 'SHOULD_NOT', 'MAY']);
const evidenceTestId = /^[a-z0-9][a-z0-9._:-]*$/u;

export function sha256Digest(source) {
  return `sha256:${createHash('sha256').update(source).digest('hex')}`;
}

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value)
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(',')}}`;
}

export function requirementsDigest(registry) {
  return sha256Digest(canonicalJson(registry));
}

/** Validate the complete Registry, including profiles outside a release target. */
export function validateRequirementRegistry(
  registry,
  profileDependencies = releaseProfileDependencies,
) {
  const errors = [];
  if (registry === null || typeof registry !== 'object' || Array.isArray(registry)) {
    return ['Requirement Registry must be an object.'];
  }
  if (
    (typeof registry.version !== 'string' && typeof registry.version !== 'number')
    || String(registry.version).length === 0
  ) {
    errors.push('Requirement Registry version must be a non-empty string or number.');
  }
  if (!Array.isArray(registry.requirements)) {
    errors.push('Requirement Registry must contain requirements[].');
    return errors;
  }
  if (
    profileDependencies === null
    || typeof profileDependencies !== 'object'
    || Array.isArray(profileDependencies)
  ) {
    errors.push('Release profile dependencies must be an object.');
    return errors;
  }

  const profiles = new Set(Object.keys(profileDependencies));
  for (const [profile, dependencies] of Object.entries(profileDependencies)) {
    if (!Array.isArray(dependencies)) {
      errors.push(`Profile ${profile} dependencies must be an array.`);
      continue;
    }
    const seenDependencies = new Set();
    for (const dependency of dependencies) {
      if (typeof dependency !== 'string' || !profiles.has(dependency)) {
        errors.push(`Profile ${profile} has unknown dependency: ${String(dependency)}.`);
      } else if (seenDependencies.has(dependency)) {
        errors.push(`Profile ${profile} repeats dependency: ${dependency}.`);
      }
      seenDependencies.add(dependency);
    }
  }
  for (const profile of profiles) {
    try {
      profileDependencyClosure(profile, profileDependencies);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  const seenRequirementIds = new Set();
  for (const [index, requirement] of registry.requirements.entries()) {
    if (requirement === null || typeof requirement !== 'object' || Array.isArray(requirement)) {
      errors.push(`Requirement at index ${index} must be an object.`);
      continue;
    }
    const label = typeof requirement.id === 'string' && requirement.id.length > 0
      ? requirement.id
      : `index ${index}`;
    for (const field of ['id', 'level', 'profile', 'source', 'requirement']) {
      if (typeof requirement[field] !== 'string' || requirement[field].length === 0) {
        errors.push(`Requirement ${label} must have a non-empty ${field}.`);
      }
    }
    if (typeof requirement.id === 'string') {
      if (seenRequirementIds.has(requirement.id)) {
        errors.push(`Duplicate Requirement ID: ${requirement.id}.`);
      }
      seenRequirementIds.add(requirement.id);
    }
    if (!requirementLevels.has(requirement.level)) {
      errors.push(`Requirement ${label} has unsupported level: ${String(requirement.level)}.`);
    }
    if (!profiles.has(requirement.profile)) {
      errors.push(`Requirement ${label} has unsupported profile: ${String(requirement.profile)}.`);
    }
    if (
      requirement.selector === null
      || typeof requirement.selector !== 'object'
      || Array.isArray(requirement.selector)
    ) {
      errors.push(`Requirement ${label} must have a selector object.`);
    }
    if (
      !Array.isArray(requirement.implementation)
      || requirement.implementation.length === 0
      || requirement.implementation.some(
        (component) => typeof component !== 'string' || component.length === 0,
      )
    ) {
      errors.push(`Requirement ${label} must have non-empty implementation strings.`);
    }
    if (!Array.isArray(requirement.tests) || requirement.tests.length === 0) {
      errors.push(`Requirement ${label} must have at least one evidence test ID.`);
      continue;
    }
    const seenTests = new Set();
    for (const testId of requirement.tests) {
      if (typeof testId !== 'string' || !evidenceTestId.test(testId)) {
        errors.push(`Requirement ${label} has invalid evidence test ID: ${String(testId)}.`);
      } else if (seenTests.has(testId)) {
        errors.push(`Requirement ${label} repeats evidence test ID: ${testId}.`);
      }
      seenTests.add(testId);
    }
  }
  return errors;
}

function profileDependencyClosure(profile, profileDependencies) {
  if (!Object.hasOwn(profileDependencies, profile)) {
    throw new Error(`Unknown release profile: ${String(profile)}.`);
  }
  const closure = new Set();
  const visiting = new Set();
  const visit = (current) => {
    if (closure.has(current)) return;
    if (visiting.has(current)) {
      throw new Error(`Release profile dependency cycle includes ${current}.`);
    }
    visiting.add(current);
    const dependencies = profileDependencies[current];
    if (!Array.isArray(dependencies)) {
      throw new Error(`Profile ${current} dependencies must be an array.`);
    }
    for (const dependency of dependencies) {
      if (typeof dependency !== 'string' || !Object.hasOwn(profileDependencies, dependency)) {
        throw new Error(`Profile ${current} has unknown dependency: ${String(dependency)}.`);
      }
      visit(dependency);
    }
    visiting.delete(current);
    closure.add(current);
  };
  visit(profile);
  return closure;
}

/** Required (MUST/MUST_NOT) Requirement IDs in a profile's dependency closure. */
export function requiredRequirementIdsForProfile(
  registry,
  profile,
  profileDependencies = releaseProfileDependencies,
) {
  const registryErrors = validateRequirementRegistry(registry, profileDependencies);
  if (registryErrors.length > 0) {
    throw new Error(`Invalid Requirement Registry:\n- ${registryErrors.join('\n- ')}`);
  }
  const closure = profileDependencyClosure(profile, profileDependencies);
  return registry.requirements
    .filter(
      (requirement) =>
        closure.has(requirement.profile)
        && (requirement.level === 'MUST' || requirement.level === 'MUST_NOT'),
    )
    .map((requirement) => requirement.id);
}

export function collectPassingTestIds(report, registry) {
  if (report?.success !== true || !Array.isArray(report.testResults)) {
    throw new Error('Vitest JSON report is incomplete or not successful.');
  }
  const statuses = new Map();
  for (const result of report.testResults) {
    for (const assertion of result.assertionResults ?? []) {
      const name = assertion.fullName ?? assertion.title ?? '';
      for (const match of name.matchAll(/\[evidence:([a-z0-9][a-z0-9._:-]*)\]/gu)) {
        const testId = match[1];
        const occurrences = statuses.get(testId) ?? [];
        occurrences.push(assertion.status);
        statuses.set(testId, occurrences);
      }
    }
  }
  const knownTestIds = new Set(registry.requirements.flatMap((item) => item.tests ?? []));
  for (const [testId, occurrenceStatuses] of statuses) {
    if (!knownTestIds.has(testId)) throw new Error(`Unknown evidence test ID: ${testId}`);
    if (occurrenceStatuses.some((status) => status !== 'passed')) {
      throw new Error(`Evidence test did not pass: ${testId}`);
    }
  }
  return new Set(statuses.keys());
}

export async function verifyRepositoryState(
  sourceRevision,
  repositoryRoot,
  runGit,
  protectedPaths = releaseEvidenceProtectedPaths,
) {
  const headRevision = (await runGit(
    ['rev-parse', '--verify', 'HEAD^{commit}'],
    repositoryRoot,
  )).trim();
  if (sourceRevision !== headRevision) {
    throw new Error(
      `--source-revision must equal the repository HEAD tested by this generator (${headRevision}).`,
    );
  }
  const statusOutput = await runGit(
    ['status', '--porcelain=v1', '--untracked-files=all', '--', ...protectedPaths],
    repositoryRoot,
  );
  if (statusOutput.trim() !== '') {
    throw new Error('Verified evidence requires a clean protected worktree at the tested HEAD.');
  }
}

export async function verifyTrackedEvidenceRepositoryState(
  sourceRevision,
  repositoryRoot,
  runGit,
  {
    protectedPaths = releaseEvidenceProtectedPaths,
    mutablePaths = releaseEvidenceMutablePaths,
  } = {},
) {
  if (typeof sourceRevision !== 'string' || !/^[0-9a-f]{40,64}$/u.test(sourceRevision)) {
    throw new Error('Tracked evidence sourceRevision must be a full hexadecimal commit ID.');
  }

  const resolvedSourceRevision = (await runGit(
    ['rev-parse', '--verify', `${sourceRevision}^{commit}`],
    repositoryRoot,
  )).trim();
  if (resolvedSourceRevision !== sourceRevision) {
    throw new Error('Tracked evidence sourceRevision does not resolve to the recorded commit.');
  }

  const headRevision = (await runGit(
    ['rev-parse', '--verify', 'HEAD^{commit}'],
    repositoryRoot,
  )).trim();
  if (sourceRevision === headRevision) {
    throw new Error('Tracked evidence must attest an earlier source revision, not its own commit.');
  }
  try {
    await runGit(['merge-base', '--is-ancestor', sourceRevision, headRevision], repositoryRoot);
  } catch {
    throw new Error('Tracked evidence sourceRevision must be an ancestor of the current HEAD.');
  }

  const statusOutput = await runGit(
    ['status', '--porcelain=v1', '--untracked-files=all', '--', ...protectedPaths],
    repositoryRoot,
  );
  if (statusOutput.trim() !== '') {
    throw new Error('Release evidence validation requires a clean protected worktree.');
  }

  const changedPaths = (await runGit(
    ['diff', '--name-only', '--no-renames', `${sourceRevision}..${headRevision}`, '--', ...protectedPaths],
    repositoryRoot,
  ))
    .split(/\r?\n/u)
    .map((path) => path.trim().replaceAll('\\', '/'))
    .filter(Boolean);
  const allowed = new Set(mutablePaths);
  const disallowed = changedPaths.filter((path) => !allowed.has(path));
  if (disallowed.length > 0) {
    throw new Error(
      `Protected release source changed after evidence revision: ${disallowed.join(', ')}.`,
    );
  }

  return headRevision;
}

export async function generateVerifiedEvidence({
  registry,
  reportRegistry = registry,
  context,
  sourceRevision,
  repositoryRoot,
  runGit,
  runTests,
}) {
  await verifyRepositoryState(sourceRevision, repositoryRoot, runGit);
  const reportSource = await runTests(sourceRevision);
  if (typeof reportSource !== 'string') {
    throw new Error('The owned Vitest runner must return its JSON report source.');
  }
  await verifyRepositoryState(sourceRevision, repositoryRoot, runGit);
  const passingTestIds = collectPassingTestIds(JSON.parse(reportSource), reportRegistry);
  const passedRequirementIds = applyMcpEvidenceQuarantine(
    registry.requirements
      .filter(
        (requirement) =>
          Array.isArray(requirement.tests) &&
          requirement.tests.length > 0 &&
          requirement.tests.every((testId) => passingTestIds.has(testId)),
      )
      .map((requirement) => requirement.id),
    registry.requirements,
  );
  return {
    schemaVersion: evidenceSchemaVersion,
    protocolVersion: context.protocolVersion,
    packageVersion: context.packageVersion,
    sourceRevision,
    requirementsDigest: context.requirementsDigest,
    reportDigest: sha256Digest(reportSource),
    passedRequirementIds,
  };
}

export function validateEvidenceArtifact(artifact, context) {
  const errors = [];
  const allowedKeys = new Set([
    'schemaVersion',
    'protocolVersion',
    'packageVersion',
    'sourceRevision',
    'requirementsDigest',
    'reportDigest',
    'passedRequirementIds',
  ]);
  if (artifact === null || typeof artifact !== 'object' || Array.isArray(artifact)) {
    return ['Evidence artifact must be an object.'];
  }
  for (const key of Object.keys(artifact)) {
    if (!allowedKeys.has(key)) errors.push(`Unknown evidence field: ${key}`);
  }
  if (artifact.schemaVersion !== evidenceSchemaVersion) {
    errors.push(`Unsupported evidence schemaVersion: ${artifact.schemaVersion}`);
  }
  for (const key of ['protocolVersion', 'packageVersion', 'requirementsDigest']) {
    if (artifact[key] !== context[key]) {
      errors.push(`Evidence ${key} does not match the package.`);
    }
  }
  if (typeof artifact.sourceRevision !== 'string' || artifact.sourceRevision.length === 0) {
    errors.push('Evidence sourceRevision must be a non-empty string.');
  }
  if (!Array.isArray(artifact.passedRequirementIds)) {
    errors.push('Evidence passedRequirementIds must be an array.');
    return errors;
  }

  const requirementById = new Map(context.requirements.map((item) => [item.id, item]));
  const seen = new Set();
  for (const id of artifact.passedRequirementIds) {
    if (typeof id !== 'string') {
      errors.push('Evidence Requirement IDs must be strings.');
      continue;
    }
    if (seen.has(id)) errors.push(`Duplicate passed Requirement ID: ${id}`);
    seen.add(id);
    const requirement = requirementById.get(id);
    if (requirement === undefined) {
      errors.push(`Unknown passed Requirement ID: ${id}`);
    } else if (!Array.isArray(requirement.tests) || requirement.tests.length === 0) {
      errors.push(`Requirement ${id} has no named tests and cannot be verified.`);
    }
  }

  if (artifact.passedRequirementIds.length > 0) {
    if (!/^[0-9a-f]{7,64}$/u.test(artifact.sourceRevision)) {
      errors.push('Verified evidence sourceRevision must be a hexadecimal revision.');
    }
    if (!/^sha256:[0-9a-f]{64}$/u.test(artifact.reportDigest ?? '')) {
      errors.push('Verified evidence must bind a SHA-256 test report digest.');
    }
  } else if (artifact.reportDigest !== undefined && !/^sha256:[0-9a-f]{64}$/u.test(artifact.reportDigest)) {
    errors.push('Evidence reportDigest must be a SHA-256 digest.');
  }

  return errors;
}

/**
 * Validate a generator-owned artifact for release of one profile at an exact
 * clean candidate revision. This does not accept reports or infer a revision.
 */
export function validateReleaseEvidenceArtifact(
  artifact,
  context,
  {
    profile,
    sourceRevision,
    profileDependencies = releaseProfileDependencies,
  },
) {
  const errors = validateEvidenceArtifact(artifact, context);
  if (isMigratingMcpReleaseProfile(profile)) {
    errors.push(
      `${String(profile)} is quarantined: exact MCP ${mcpMigrationProtocolVersion} conformance evidence is missing or mismatched, so it cannot be released.`,
    );
    return errors;
  }
  const registry = {
    version: context?.protocolVersion,
    requirements: context?.requirements,
  };
  const registryErrors = validateRequirementRegistry(registry, profileDependencies);
  errors.push(...registryErrors.map((error) => `Registry: ${error}`));
  if (registryErrors.length > 0) return errors;

  if (typeof sourceRevision !== 'string' || !/^[0-9a-f]{40,64}$/u.test(sourceRevision)) {
    errors.push('Release candidate sourceRevision must be a full hexadecimal commit ID.');
  }
  if (artifact?.sourceRevision === 'unverified' || artifact?.passedRequirementIds?.length === 0) {
    errors.push('Release evidence must not be empty or unverified.');
  }
  if (artifact?.sourceRevision !== sourceRevision) {
    errors.push('Release evidence sourceRevision does not match the attested source revision.');
  }
  if (typeof artifact?.reportDigest !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(artifact.reportDigest)) {
    errors.push('Release evidence must bind the generator-owned Vitest report digest.');
  }

  let requiredIds;
  try {
    requiredIds = requiredRequirementIdsForProfile(registry, profile, profileDependencies);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
    return errors;
  }
  if (requiredIds.length === 0) {
    errors.push(`Release profile ${String(profile)} has no Required Requirement records.`);
    return errors;
  }
  const passedIds = new Set(
    Array.isArray(artifact?.passedRequirementIds) ? artifact.passedRequirementIds : [],
  );
  const missing = requiredIds.filter((id) => !passedIds.has(id));
  if (missing.length > 0) {
    errors.push(
      `Release profile ${String(profile)} lacks verified Required records: ${missing.join(', ')}.`,
    );
  }
  return errors;
}

/**
 * Accepted-state check for an mcp-* release profile (COLP-MCP-15): the
 * profiles are no longer quarantined, so this validator fails closed when
 * the artifact carries no MCP-* Requirement evidence for the profile (the
 * claim would be unsupported) and passes when the exact 2026-07-28
 * source-bound evidence is present. The release gate routes mcp-* profiles
 * through `validateReleaseEvidenceArtifact` in the accepted state; this
 * helper keeps the migration-era export name for callers.
 */
export function validateMcpMigrationClosedEvidence(artifact, context, { profile }) {
  const errors = [];
  if (profile !== 'mcp-read' && profile !== 'mcp-write') {
    errors.push(`Profile ${String(profile)} is not an MCP release profile.`);
    return errors;
  }
  const passedIds = Array.isArray(artifact?.passedRequirementIds)
    ? artifact.passedRequirementIds
    : [];
  const requirements = Array.isArray(context?.requirements) ? context.requirements : [];
  const profileRequirementIds = new Set(
    requirements
      .filter((requirement) => requirement?.profile === profile)
      .map((requirement) => requirement.id),
  );
  const restored = passedIds.filter((id) => profileRequirementIds.has(id));
  if (restored.length === 0) {
    errors.push(
      `${String(profile)} has no MCP-* Requirement evidence: exact MCP ${mcpMigrationProtocolVersion} source-bound evidence is required to hold the accepted claim.`,
    );
  }
  return errors;
}
