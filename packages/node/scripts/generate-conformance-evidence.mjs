// Runs the whole Vitest suite once and records which registered requirements
// have every tagged test passing. The result is bundled with the package and
// read by `@collection-protocol/node/conformance`.
//
//   node scripts/generate-conformance-evidence.mjs            write evidence.json
//   node scripts/generate-conformance-evidence.mjs --check    fail if it would change
//   add --coverage to collect coverage during the same run
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { collectPassingTestIds, createEvidence, readRegistry, registryFiles } from './lib/requirements.mjs';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const protocolRoot = resolve(packageRoot, '..', '..', 'protocol');
const evidencePath = resolve(packageRoot, 'src/conformance/generated/evidence.json');
const options = new Set(process.argv.slice(2));
for (const option of options) {
  if (option !== '--check' && option !== '--coverage') throw new Error(`Unknown option: ${option}`);
}

const [registry, ...laterRegistries] = await Promise.all(
  registryFiles.map((name) => readRegistry(protocolRoot, name)),
);
const knownTestIds = new Set(
  [registry, ...laterRegistries].flatMap((item) => item.requirements.flatMap((requirement) => requirement.tests)),
);
const packageJson = JSON.parse(await readFile(resolve(packageRoot, 'package.json'), 'utf8'));

const directory = await mkdtemp(join(tmpdir(), 'colp-evidence-'));
const reportPath = join(directory, 'report.json');
try {
  const exitCode = await new Promise((resolveExit, reject) => {
    spawn(
      process.execPath,
      [
        resolve(packageRoot, 'node_modules/vitest/vitest.mjs'),
        'run',
        ...(options.has('--coverage') ? ['--coverage'] : []),
        '--reporter=default',
        '--reporter=json',
        '--outputFile',
        reportPath,
      ],
      { cwd: packageRoot, stdio: 'inherit' },
    ).on('error', reject).on('exit', resolveExit);
  });
  if (exitCode !== 0) throw new Error('The test suite failed; evidence was not generated.');
  const report = JSON.parse(await readFile(reportPath, 'utf8'));
  const evidence = createEvidence({
    registry,
    packageVersion: packageJson.version,
    passingTestIds: collectPassingTestIds(report, knownTestIds),
  });
  const source = `${JSON.stringify(evidence, null, 2)}\n`;

  if (options.has('--check')) {
    if ((await readFile(evidencePath, 'utf8')) !== source) {
      throw new Error('evidence.json is out of date. Run npm run refresh:evidence and commit the result.');
    }
    console.log(`Evidence is current: ${evidence.passedRequirementIds.length} requirements verified.`);
  } else {
    await writeFile(evidencePath, source, 'utf8');
    console.log(`Wrote evidence for ${evidence.passedRequirementIds.length} requirements.`);
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}
