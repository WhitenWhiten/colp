/**
 * COLP-MCP-15: source-bound total acceptance runner for the MCP 2026-07-28
 * SDK (`mcp-2026-07-28-sdk-accepted`).
 *
 * Runs at the clean committed HEAD that will attest the accepted artifact:
 *   1. clean protected worktree + exact HEAD (source binding);
 *   2. protocol sync, generated types, requirements, traceability, typecheck;
 *   3. build + pack:check (dist/ exists for the tarball contracts);
 *   4. reference client / fixture host acceptance e2e (discovery, Read,
 *      listen, Write/MRTR with Plan/Approval, import boundary, tarball,
 *      restored claims + Sync Session regression);
 *   5. owned Vitest evidence suite -> report digest;
 *   6. SDK lock verification (package.json + lockfile, no legacy monolith);
 *   7. source-bound `mcp-conformance-candidate` regeneration + validation;
 *   8. Legacy MCP absence scan over source, declarations and the packed
 *      tarball;
 *   9. writes `src/conformance/generated/mcp-2026-07-28-sdk-accepted.json`
 *      binding the candidate digest, absence verdict and all evidence layers.
 *
 * The runner intentionally leaves the generated candidate and accepted
 * artifact as the only worktree changes; the follow-up evidence-refresh
 * commit (refresh:evidence) then restores evidence.json/TRACEABILITY.md.
 */
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
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
import { scanLegacyMcpAbsence } from './lib/legacy-mcp-absence.mjs';
import {
  createMcp20260728SdkAccepted,
  mcpConformanceProbeFamilies,
  validateMcp20260728SdkAccepted,
  validateMcpConformanceCandidate,
} from './lib/mcp-conformance-versioning.mjs';

const execFileAsync = promisify(execFile);
const npmExecutable = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = resolve(packageRoot, '..', '..');
const protocolRoot = resolve(repositoryRoot, 'protocol');
const registryPath = resolve(packageRoot, 'fixtures', 'protocol', 'requirements.yaml');
const canonicalRegistryPath = resolve(protocolRoot, 'requirements.yaml');
const packagePath = resolve(packageRoot, 'package.json');
const candidatePath = resolve(
  packageRoot,
  'src',
  'conformance',
  'generated',
  'mcp-conformance-candidate.json',
);
const acceptedPath = resolve(
  packageRoot,
  'src',
  'conformance',
  'generated',
  'mcp-2026-07-28-sdk-accepted.json',
);
const sourceRoot = resolve(packageRoot, 'src');
const distRoot = resolve(packageRoot, 'dist');

function assertNoArguments() {
  for (const argument of process.argv.slice(2)) {
    throw new Error(`Unknown MCP 2026-07-28 SDK acceptance argument: ${argument}`);
  }
}

const runGit = async (arguments_, cwd) => {
  const { stdout } = await execFileAsync('git', arguments_, { cwd, encoding: 'utf8' });
  return stdout;
};

async function runNpmScript(script) {
  await execFileAsync(npmExecutable, ['run', script], {
    cwd: packageRoot,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    shell: process.platform === 'win32',
  });
}

async function runVitest(arguments_) {
  const vitestPath = resolve(packageRoot, 'node_modules', 'vitest', 'vitest.mjs');
  await execFileAsync(process.execPath, [vitestPath, ...arguments_], {
    cwd: packageRoot,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
}

async function collectFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await collectFiles(full)));
    else if (entry.isFile()) files.push(full);
  }
  return files;
}

async function readContents(paths) {
  const contents = [];
  for (const path of paths) {
    contents.push({ path, content: await readFile(path, 'utf8') });
  }
  return contents;
}

function packageRelative(path) {
  return path.replaceAll('\\', '/').replace(`${packageRoot.replaceAll('\\', '/')}/`, '');
}

async function verifySdkLock() {
  const packageJson = JSON.parse(readFileSync(packagePath, 'utf8'));
  const lock = JSON.parse(readFileSync(resolve(packageRoot, 'package-lock.json'), 'utf8'));
  if (packageJson.dependencies?.['@modelcontextprotocol/core'] !== '2.0.0') {
    throw new Error('SDK lock: @modelcontextprotocol/core dependency must be exactly 2.0.0.');
  }
  if (packageJson.devDependencies?.['@modelcontextprotocol/client'] !== '2.0.0'
    || packageJson.devDependencies?.['@modelcontextprotocol/server'] !== '2.0.0') {
    throw new Error('SDK lock: @modelcontextprotocol/client/server devDependencies must be exactly 2.0.0.');
  }
  for (const name of [
    'node_modules/@modelcontextprotocol/core',
    'node_modules/@modelcontextprotocol/client',
    'node_modules/@modelcontextprotocol/server',
  ]) {
    if (lock.packages?.[name]?.version !== '2.0.0') {
      throw new Error(`SDK lock: lockfile ${name} must resolve to exactly 2.0.0.`);
    }
  }
  if (lock.packages?.['node_modules/@modelcontextprotocol/sdk'] !== undefined) {
    throw new Error('SDK lock: legacy @modelcontextprotocol/sdk monolith must not be locked.');
  }
}

async function scanAbsence() {
  const sourcePaths = (await collectFiles(sourceRoot)).filter(
    (path) => !/[\\/]generated[\\/]/u.test(path) && !path.endsWith('.map'),
  );
  const declarationPaths = (await collectFiles(distRoot)).filter((path) =>
    /\.d\.(?:ts|cts)$/u.test(path));
  if (declarationPaths.length === 0) {
    throw new Error('Legacy MCP absence scan found no declaration files under dist/.');
  }

  const packageJson = JSON.parse(readFileSync(packagePath, 'utf8'));
  const tarballName = `${packageJson.name.replace('@', '').replace('/', '-')}-${packageJson.version}.tgz`;
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'colp-mcp-accept-'));
  const tarballFiles = [];
  try {
    await execFileAsync(npmExecutable, ['pack', '--pack-destination', temporaryDirectory], {
      cwd: packageRoot,
      shell: process.platform === 'win32',
    });
    await execFileAsync('tar', ['-xzf', resolve(temporaryDirectory, tarballName), '-C', temporaryDirectory], {
      cwd: packageRoot,
      shell: process.platform === 'win32',
    });
    const extractedPaths = await collectFiles(resolve(temporaryDirectory, 'package'));
    for (const path of extractedPaths) {
      tarballFiles.push({ path: packageRelative(path), content: await readFile(path, 'utf8') });
    }
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }

  const report = scanLegacyMcpAbsence({
    sourceFiles: await readContents(sourcePaths),
    declarationFiles: await readContents(declarationPaths),
    tarballFiles,
  });
  if (!report.ok) {
    throw new Error(
      'Legacy MCP absence scan failed:\n- '
      + report.findings
        .map((finding) => `${finding.path}:${finding.line} Legacy MCP symbol ${finding.symbol}`)
        .join('\n- '),
    );
  }
  return report;
}

async function main() {
  assertNoArguments();

  const sourceRevision = (await runGit(
    ['rev-parse', '--verify', 'HEAD^{commit}'],
    repositoryRoot,
  )).trim();

  // 1. Source binding: clean protected worktree at the attested HEAD.
  await verifyRepositoryState(sourceRevision, repositoryRoot, runGit);

  // 2. Static gates.
  for (const script of [
    'check:protocol',
    'check:types',
    'check:requirements',
    'check:traceability',
    'typecheck',
  ]) {
    await runNpmScript(script);
  }

  // 3. Build and package shape first so dist/ exists for the tarball
  //    contract tests in the owned suite (same requirement as the
  //    COLP-MCP-12 read-package-surface tarball scan).
  await runNpmScript('build');
  await runNpmScript('pack:check');

  // 4. Reference client / fixture host acceptance e2e.
  await runVitest(['run', 'tests/mcp/mcp-2026-07-28-sdk-acceptance-e2e.test.ts']);

  // 5. Owned Vitest evidence suite -> report digest.
  const [canonicalRegistrySource, registrySource, packageSource] = await Promise.all([
    readFile(canonicalRegistryPath, 'utf8'),
    readFile(registryPath, 'utf8'),
    readFile(packagePath, 'utf8'),
  ]);
  if (canonicalRegistrySource !== registrySource) {
    throw new Error('Canonical and package Requirement Registries differ. Run npm run sync:protocol.');
  }
  const registry = parse(registrySource);
  const registryErrors = validateRequirementRegistry(registry);
  if (registryErrors.length > 0) {
    throw new Error(`Invalid Requirement Registry:\n- ${registryErrors.join('\n- ')}`);
  }
  const packageJson = JSON.parse(packageSource);
  const requirementsDigestValue = requirementsDigest(registry);
  const temporaryReportDirectory = await mkdtemp(join(tmpdir(), 'colp-mcp-accept-report-'));
  let reportSource;
  try {
    const reportPath = join(temporaryReportDirectory, 'vitest-report.json');
    await runVitest(evidenceVitestArguments(reportPath));
    reportSource = await readFile(reportPath, 'utf8');
  } finally {
    await rm(temporaryReportDirectory, { recursive: true, force: true });
  }
  collectPassingTestIds(JSON.parse(reportSource), await readEvidenceReportRegistry(packageRoot));
  const reportDigest = sha256Digest(reportSource);

  // 6. SDK lock.
  await verifySdkLock();

  // 7. Regenerate + validate the source-bound conformance candidate at HEAD.
  await runNpmScript('generate:mcp-conformance-candidate');
  const candidate = JSON.parse(readFileSync(candidatePath, 'utf8'));
  const candidateErrors = validateMcpConformanceCandidate(candidate, {
    sourceRevision,
    requirementsDigest: requirementsDigestValue,
    reportDigest: candidate.reportDigest,
  });
  if (candidateErrors.length > 0) {
    throw new Error(`Invalid mcp-conformance-candidate:\n- ${candidateErrors.join('\n- ')}`);
  }
  if (candidate.sourceRevision !== sourceRevision) {
    throw new Error('Regenerated mcp-conformance-candidate does not attest the accepted source revision.');
  }

  // 8. Legacy MCP absence scan (source + declarations + tarball).
  const absenceReport = await scanAbsence();

  // 9. Write the accepted artifact and validate it.
  const accepted = createMcp20260728SdkAccepted({
    sourceRevision,
    requirementsDigest: requirementsDigestValue,
    reportDigest,
    conformanceCandidateDigest: candidate.evidenceDigest,
    probeFamilyIds: mcpConformanceProbeFamilies,
    legacyAbsence: {
      sourceFiles: absenceReport.scanned.sourceFiles,
      declarationFiles: absenceReport.scanned.declarationFiles,
      tarballFiles: absenceReport.scanned.tarballFiles,
      findings: [],
    },
  });
  const acceptedErrors = validateMcp20260728SdkAccepted(accepted, {
    sourceRevision,
    requirementsDigest: requirementsDigestValue,
    reportDigest,
  });
  if (acceptedErrors.length > 0) {
    throw new Error(`Invalid accepted SDK artifact:\n- ${acceptedErrors.join('\n- ')}`);
  }
  await writeFile(acceptedPath, `${JSON.stringify(accepted, null, 2)}\n`, 'utf8');

  console.log(
    `Accepted MCP 2026-07-28 SDK at ${sourceRevision}: `
    + `candidate ${candidate.evidenceDigest}, `
    + `absence ${absenceReport.scanned.sourceFiles}/${absenceReport.scanned.declarationFiles}/${absenceReport.scanned.tarballFiles}, `
    + `artifact ${acceptedPath}.`,
  );
}

await main();

