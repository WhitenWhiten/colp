import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

import {
  applyMcpEvidenceQuarantine,
  collectPassingTestIds,
  isMigratingMcpReleaseProfile,
  mcpMigrationProtocolVersion,
  registeredReleaseProfiles,
  releaseProfileDependencies,
  requirementsDigest,
  validateMcpMigrationClosedEvidence,
  validateReleaseEvidenceArtifact,
  validateRequirementRegistry,
  verifyTrackedEvidenceRepositoryState,
} from './lib/conformance-evidence.mjs';
import { evidenceVitestArguments } from './lib/evidence-test-suite.mjs';
import { readEvidenceReportRegistry } from './lib/evidence-report-registry.mjs';
import { validateMcpReleaseAcceptanceArtifacts } from './lib/mcp-conformance-versioning.mjs';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = resolve(packageRoot, '..', '..');
const protocolRoot = resolve(repositoryRoot, 'protocol');
const canonicalRegistryPath = resolve(protocolRoot, 'requirements.yaml');
const fixtureRegistryPath = resolve(packageRoot, 'fixtures/protocol/requirements.yaml');
const packagePath = resolve(packageRoot, 'package.json');
const evidencePath = resolve(packageRoot, 'src/conformance/generated/evidence.json');
const mcpCandidatePath = resolve(
  packageRoot,
  'src/conformance/generated/mcp-conformance-candidate.json',
);
const mcpAcceptedPath = resolve(
  packageRoot,
  'src/conformance/generated/mcp-2026-07-28-sdk-accepted.json',
);
const execFileAsync = promisify(execFile);
const supportedReleaseProfiles = new Set(registeredReleaseProfiles);
const mcpReleaseProfiles = new Set(['mcp-read', 'mcp-write']);

function parseArguments(arguments_) {
  const profiles = [];
  let allSupported = false;
  let coverage = false;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === '--coverage') {
      if (coverage) throw new Error('--coverage may be supplied only once.');
      coverage = true;
      continue;
    }
    if (argument === '--all-supported') {
      if (allSupported) throw new Error('--all-supported may be supplied only once.');
      if (profiles.length > 0) {
        throw new Error('--all-supported cannot be combined with --profile.');
      }
      allSupported = true;
      continue;
    }
    if (argument !== '--profile') {
      throw new Error(`Unknown release evidence gate argument: ${argument}`);
    }
    const value = arguments_[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`${argument} requires a value.`);
    }
    index += 1;
    if (argument === '--profile') {
      if (allSupported) {
        throw new Error('--profile cannot be combined with --all-supported.');
      }
      if (!supportedReleaseProfiles.has(value)) {
        throw new Error(`Unsupported release evidence profile: ${value}.`);
      }
      if (isMigratingMcpReleaseProfile(value)) {
        throw new Error(
          `Release profile ${value} is quarantined: exact MCP ${mcpMigrationProtocolVersion} conformance evidence is required before release.`,
        );
      }
      if (profiles.includes(value)) {
        throw new Error(`--profile ${value} may be supplied only once.`);
      }
      profiles.push(value);
    }
  }
  if (!allSupported && profiles.length === 0) {
    throw new Error('--profile or --all-supported is required.');
  }
  return {
    profiles: allSupported ? [...registeredReleaseProfiles] : profiles,
    coverage,
  };
}

const runGit = async (arguments_, cwd) => {
  const { stdout } = await execFileAsync('git', arguments_, { cwd, encoding: 'utf8' });
  return stdout;
};

const { profiles, coverage } = parseArguments(process.argv.slice(2));
const requiresMcpAcceptance = profiles.some((profile) => mcpReleaseProfiles.has(profile));
const [
  canonicalRegistrySource,
  fixtureRegistrySource,
  packageSource,
  evidenceSource,
  mcpCandidateSource,
  mcpAcceptedSource,
] = await Promise.all([
  readFile(canonicalRegistryPath, 'utf8'),
  readFile(fixtureRegistryPath, 'utf8'),
  readFile(packagePath, 'utf8'),
  readFile(evidencePath, 'utf8'),
  requiresMcpAcceptance ? readFile(mcpCandidatePath, 'utf8') : undefined,
  requiresMcpAcceptance ? readFile(mcpAcceptedPath, 'utf8') : undefined,
]);
if (canonicalRegistrySource !== fixtureRegistrySource) {
  throw new Error('Canonical and package Requirement Registries differ.');
}

const registry = parse(fixtureRegistrySource);
const registryErrors = validateRequirementRegistry(registry, releaseProfileDependencies);
if (registryErrors.length > 0) {
  throw new Error(`Invalid Requirement Registry:\n- ${registryErrors.join('\n- ')}`);
}
const packageJson = JSON.parse(packageSource);
const context = {
  protocolVersion: String(registry.version),
  packageVersion: packageJson.version,
  requirementsDigest: requirementsDigest(registry),
  requirements: registry.requirements,
};

const artifact = JSON.parse(evidenceSource);
const mcpCandidate = mcpCandidateSource === undefined ? undefined : JSON.parse(mcpCandidateSource);
const mcpAccepted = mcpAcceptedSource === undefined ? undefined : JSON.parse(mcpAcceptedSource);
const sourceRevision = artifact.sourceRevision;
const mcpSourceRevision = mcpCandidate?.sourceRevision;
let headRevision;
try {
  headRevision = await verifyTrackedEvidenceRepositoryState(
    sourceRevision,
    repositoryRoot,
    runGit,
  );
} catch (error) {
  throw new Error(
    `${error instanceof Error ? error.message : String(error)}\n` +
    `Refresh tracked evidence with 'npm run refresh:evidence' at the current protected ` +
    `source revision, then commit evidence.json and TRACEABILITY.md in a separate follow-up commit.`,
  );
}

let mcpSourceStateError;
if (requiresMcpAcceptance) {
  try {
    // MCP acceptance is intentionally generated and committed before the
    // generic release certificate refresh. Its two records must share their
    // own tested revision, while this repository-state check proves no
    // protected MCP source changed between that revision and the current
    // certificate commit. Requiring the later generic evidence revision here
    // creates an impossible two-commit evidence cycle.
    await verifyTrackedEvidenceRepositoryState(
      mcpSourceRevision,
      repositoryRoot,
      runGit,
    );
  } catch (error) {
    mcpSourceStateError = error instanceof Error ? error.message : String(error);
  }
}

// Fail fast on malformed or stale artifacts before spending CI minutes on the
// owned Vitest run. The test run below still verifies tracked pass IDs.
// COLP-MCP-15 accepted exact 2026-07-28 evidence, so mcp-read/mcp-write are
// releasable profiles; any future migration re-quarantine would be routed
// through validateMcpMigrationClosedEvidence here.
const releasableProfiles = profiles.filter((profile) => !isMigratingMcpReleaseProfile(profile));
const migratingProfiles = profiles.filter(isMigratingMcpReleaseProfile);
const fastErrors = [
  ...releasableProfiles.flatMap((profile) =>
    validateReleaseEvidenceArtifact(artifact, context, {
      profile,
      sourceRevision,
      profileDependencies: releaseProfileDependencies,
    }).map((error) => `[${profile}] ${error}`)),
  ...migratingProfiles.flatMap((profile) =>
    validateMcpMigrationClosedEvidence(artifact, context, { profile })
      .map((error) => `[${profile}] ${error}`)),
  ...(requiresMcpAcceptance
    ? validateMcpReleaseAcceptanceArtifacts(
      { candidate: mcpCandidate, accepted: mcpAccepted },
      {
        sourceRevision: mcpSourceRevision,
        requirementsDigest: context.requirementsDigest,
      },
    ).map((error) => `[mcp-acceptance] ${error}`)
    : []),
  ...(mcpSourceStateError === undefined
    ? []
    : [`[mcp-acceptance] Protected source binding: ${mcpSourceStateError}`]),
];
if (fastErrors.length > 0) {
  throw new Error(`Release evidence gate failed:\n- ${fastErrors.join('\n- ')}`);
}

const temporaryDirectory = await mkdtemp(join(tmpdir(), 'colp-release-evidence-'));
try {
  const reportPath = join(temporaryDirectory, 'vitest-report.json');
  const vitestPath = resolve(packageRoot, 'node_modules', 'vitest', 'vitest.mjs');
  await execFileAsync(process.execPath, [
    vitestPath,
    ...evidenceVitestArguments(reportPath, coverage),
  ], { cwd: packageRoot, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  const report = JSON.parse(await readFile(reportPath, 'utf8'));
  const passingTestIds = collectPassingTestIds(report, await readEvidenceReportRegistry(packageRoot));
  const currentPassedRequirementIds = applyMcpEvidenceQuarantine(
    registry.requirements
      .filter((requirement) => requirement.tests.every((testId) => passingTestIds.has(testId)))
      .map((requirement) => requirement.id),
    registry.requirements,
  );
  if (JSON.stringify(currentPassedRequirementIds) !== JSON.stringify(artifact.passedRequirementIds)) {
    throw new Error(
      'Release evidence gate failed: tracked passedRequirementIds differ from the current owned test run.',
    );
  }

  await verifyTrackedEvidenceRepositoryState(sourceRevision, repositoryRoot, runGit);

  console.log(
    `Tracked release evidence accepted for ${releasableProfiles.join(', ')} at ${headRevision} (source ${sourceRevision}).`
    + (migratingProfiles.length > 0
      ? ` ${migratingProfiles.join(', ')} remain quarantined until exact MCP ${mcpMigrationProtocolVersion} evidence is accepted.`
      : requiresMcpAcceptance
        ? ` MCP ${mcpMigrationProtocolVersion} evidence accepted (COLP-MCP-15); mcp-read/mcp-write are restored.`
        : ''),
  );
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
