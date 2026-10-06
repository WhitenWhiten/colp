import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { parse } from 'yaml';

import {
  generateVerifiedEvidence,
  requirementsDigest,
  validateEvidenceArtifact,
  validateRequirementRegistry,
} from './lib/conformance-evidence.mjs';
import { evidenceVitestArguments } from './lib/evidence-test-suite.mjs';
import { readEvidenceReportRegistry } from './lib/evidence-report-registry.mjs';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = resolve(packageRoot, '..', '..');
const execFileAsync = promisify(execFile);

function assertKnownArguments() {
  for (const argument of process.argv.slice(2)) {
    throw new Error(`Unknown evidence generator argument: ${argument}`);
  }
}

assertKnownArguments();

const canonicalRegistryPath = resolve(repositoryRoot, 'protocol/requirements.yaml');
const registryPath = resolve(packageRoot, 'fixtures/protocol/requirements.yaml');
const packagePath = resolve(packageRoot, 'package.json');
const outputPath = resolve(packageRoot, 'src/conformance/generated/evidence.json');
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
const context = {
  protocolVersion: String(registry.version),
  packageVersion: packageJson.version,
  requirementsDigest: requirementsDigest(registry),
  requirements: registry.requirements,
};

const runGit = async (arguments_, cwd) => {
  const { stdout } = await execFileAsync('git', arguments_, { cwd, encoding: 'utf8' });
  return stdout;
};
const sourceRevision = (await runGit(
  ['rev-parse', '--verify', 'HEAD^{commit}'],
  repositoryRoot,
)).trim();
const artifact = await generateVerifiedEvidence({
  registry,
  reportRegistry: await readEvidenceReportRegistry(packageRoot),
  context,
  sourceRevision,
  repositoryRoot,
  runGit,
  runTests: async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), 'colp-evidence-'));
    const reportPath = join(temporaryDirectory, 'vitest-report.json');
    const vitestPath = resolve(packageRoot, 'node_modules', 'vitest', 'vitest.mjs');
    try {
      await execFileAsync(process.execPath, [
        vitestPath,
        ...evidenceVitestArguments(reportPath),
      ], { cwd: packageRoot, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
      return readFile(reportPath, 'utf8');
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  },
});

const errors = validateEvidenceArtifact(artifact, context);
if (errors.length > 0) {
  throw new Error(`Invalid conformance evidence:\n- ${errors.join('\n- ')}`);
}

await writeFile(outputPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
console.log(
  `Generated evidence for ${artifact.passedRequirementIds.length} requirements at ${outputPath}.`,
);
