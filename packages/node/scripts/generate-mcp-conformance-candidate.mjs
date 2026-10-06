import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { parse } from 'yaml';

import {
  collectPassingTestIds,
  requirementsDigest,
  sha256Digest,
  validateRequirementRegistry,
  verifyRepositoryState,
} from './lib/conformance-evidence.mjs';
import { evidenceVitestArguments } from './lib/evidence-test-suite.mjs';
import { readEvidenceReportRegistry } from './lib/evidence-report-registry.mjs';
import {
  createMcpConformanceCandidate,
  mcpConformanceProbeFamilies,
  validateMcpConformanceCandidate,
} from './lib/mcp-conformance-versioning.mjs';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = resolve(packageRoot, '..', '..');
const execFileAsync = promisify(execFile);

function assertKnownArguments() {
  for (const argument of process.argv.slice(2)) {
    throw new Error(`Unknown MCP conformance candidate generator argument: ${argument}`);
  }
}

assertKnownArguments();

const canonicalRegistryPath = resolve(repositoryRoot, 'protocol/requirements.yaml');
const registryPath = resolve(packageRoot, 'fixtures/protocol/requirements.yaml');
const packagePath = resolve(packageRoot, 'package.json');
const outputPath = resolve(
  packageRoot,
  'src/conformance/generated/mcp-conformance-candidate.json',
);
const [canonicalRegistrySource, registrySource, packageSource] = await Promise.all([
  readFile(canonicalRegistryPath, 'utf8'),
  readFile(registryPath, 'utf8'),
  readFile(packagePath, 'utf8'),
]);
if (canonicalRegistrySource !== registrySource) {
  throw new Error('Canonical and package Requirement Registries differ.');
}
const registry = parse(registrySource);
const registryErrors = validateRequirementRegistry(registry);
if (registryErrors.length > 0) {
  throw new Error(`Invalid Requirement Registry:\n- ${registryErrors.join('\n- ')}`);
}
const packageJson = JSON.parse(packageSource);
const requirementsDigestValue = requirementsDigest(registry);

const runGit = async (arguments_, cwd) => {
  const { stdout } = await execFileAsync('git', arguments_, { cwd, encoding: 'utf8' });
  return stdout;
};
const sourceRevision = (await runGit(
  ['rev-parse', '--verify', 'HEAD^{commit}'],
  repositoryRoot,
)).trim();

await verifyRepositoryState(sourceRevision, repositoryRoot, runGit);
const temporaryDirectory = await mkdtemp(join(tmpdir(), 'colp-mcp-conformance-'));
let reportSource;
try {
  const reportPath = join(temporaryDirectory, 'vitest-report.json');
  const vitestPath = resolve(packageRoot, 'node_modules', 'vitest', 'vitest.mjs');
  await execFileAsync(process.execPath, [
    vitestPath,
    ...evidenceVitestArguments(reportPath),
  ], { cwd: packageRoot, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  reportSource = await readFile(reportPath, 'utf8');
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
await verifyRepositoryState(sourceRevision, repositoryRoot, runGit);

// The owned Vitest run must still pass every registered evidence test before
// its report digest may be bound into the source-bound candidate.
collectPassingTestIds(JSON.parse(reportSource), await readEvidenceReportRegistry(packageRoot));

const candidate = createMcpConformanceCandidate({
  sourceRevision,
  requirementsDigest: requirementsDigestValue,
  reportDigest: sha256Digest(reportSource),
  probeFamilyIds: mcpConformanceProbeFamilies,
});
const candidateErrors = validateMcpConformanceCandidate(candidate, {
  sourceRevision,
  requirementsDigest: requirementsDigestValue,
  reportDigest: candidate.reportDigest,
});
if (candidateErrors.length > 0) {
  throw new Error(`Invalid MCP conformance candidate:\n- ${candidateErrors.join('\n- ')}`);
}

await writeFile(outputPath, `${JSON.stringify(candidate, null, 2)}\n`, 'utf8');
console.log(
  `Generated source-bound mcp-conformance-candidate (MCP ${candidate.mcpVersion}, `
  + `source ${candidate.sourceRevision}) at ${outputPath}.`,
);
