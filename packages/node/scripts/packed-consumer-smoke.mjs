/** Install the actual npm tarball into an isolated consumer and load every public runtime export. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { mkdtemp, mkdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { verifyPublisherQuickstartConsumer } from './publisher-quickstart-consumer.mjs';
import { verifyPackedValueExports } from './packed-value-exports.mjs';
import { verifyPackedDocLinks } from './packed-doc-links.mjs';
import { verifyDocumentedConsumers } from './documented-consumers.mjs';

const execFileAsync = promisify(execFile);
const npmExecutable = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function assertNoArguments() {
  if (process.argv.length > 2) throw new Error('Packed consumer smoke accepts no arguments.');
}

function runtimeSpecifiers(packageJson) {
  return Object.entries(packageJson.exports)
    .filter(([, target]) => target !== null && typeof target === 'object'
      && typeof target.import === 'string' && typeof target.require === 'string')
    .map(([subpath]) => subpath === '.' ? packageJson.name : `${packageJson.name}${subpath.slice(1)}`);
}

async function linkInstalledDependency(consumerModules, dependency) {
  const segments = dependency.split('/');
  const source = resolve(packageRoot, 'node_modules', ...segments);
  const target = resolve(consumerModules, ...segments);
  await mkdir(dirname(target), { recursive: true });
  await symlink(source, target, process.platform === 'win32' ? 'junction' : 'dir');
}

function probeSource(specifiers, mode, schemaSpecifier) {
  const loader = mode === 'esm'
    ? 'const loaded = await import(specifier);'
    : 'const loaded = require(specifier);';
  const schemaLoader = mode === 'esm'
    ? `const schema = (await import(${JSON.stringify(schemaSpecifier)}, { with: { type: 'json' } })).default;`
    : `const schema = require(${JSON.stringify(schemaSpecifier)});`;
  return `${mode === 'esm' ? "import assert from 'node:assert/strict';" : "const assert = require('node:assert/strict');"}
const results = {};
for (const specifier of ${JSON.stringify(specifiers)}) {
  ${loader}
  const keys = Object.keys(loaded).sort();
  if (!specifier.endsWith('/types')) assert.notEqual(keys.length, 0, \`\${specifier} unexpectedly has no runtime exports\`);
  results[specifier] = keys;
}
${schemaLoader}
assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
const semantic = ${mode === 'esm' ? `await import(${JSON.stringify('@know-n/colp/semantic')})` : `require(${JSON.stringify('@know-n/colp/semantic')})`};
assert.equal(semantic.createUrlHash('https://example.test/'), 'sha-256=:Fkhwe5+NezpUP7dTQsRMzE5oDMIixSSbIUVLLxyjYQk=:');
process.stdout.write(JSON.stringify(results));
`;
}

async function main() {
  assertNoArguments();
  const packageJson = JSON.parse(await readFile(resolve(packageRoot, 'package.json'), 'utf8'));
  const specifiers = runtimeSpecifiers(packageJson);
  assert.ok(specifiers.length >= 16, 'Packed consumer smoke found too few public runtime entry points.');
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'colp-packed-consumer-'));
  const consumerRoot = resolve(temporaryDirectory, 'consumer');
  try {
    const { stdout } = await execFileAsync(npmExecutable,
      ['pack', '--json', '--pack-destination', temporaryDirectory], {
        cwd: packageRoot, shell: process.platform === 'win32',
      });
    const packResult = JSON.parse(stdout);
    assert.equal(packResult.length, 1);
    const tarball = resolve(temporaryDirectory, packResult[0].filename);
    await mkdir(consumerRoot);
    await writeFile(resolve(consumerRoot, 'package.json'), JSON.stringify({
      name: 'colp-packed-consumer-smoke', private: true, type: 'module',
    }));
    await execFileAsync('tar', ['-xzf', tarball, '-C', temporaryDirectory], {
      shell: process.platform === 'win32',
    });
    const consumerModules = resolve(consumerRoot, 'node_modules');
    const installedPackage = resolve(consumerModules, ...packageJson.name.split('/'));
    await mkdir(dirname(installedPackage), { recursive: true });
    await rename(resolve(temporaryDirectory, 'package'), installedPackage);
    await verifyPackedDocLinks({ installedPackage, files: packResult[0].files });
    for (const dependency of Object.keys(packageJson.dependencies ?? {})) {
      await linkInstalledDependency(consumerModules, dependency);
    }

    const schemaSpecifier = `${packageJson.name}/schema/collection-protocol.schema.json`;
    const esmProbe = resolve(consumerRoot, 'probe.mjs');
    const cjsProbe = resolve(consumerRoot, 'probe.cjs');
    await writeFile(esmProbe, probeSource(specifiers, 'esm', schemaSpecifier));
    await writeFile(cjsProbe, probeSource(specifiers, 'cjs', schemaSpecifier));
    const esm = JSON.parse((await execFileAsync(process.execPath, [esmProbe], { cwd: consumerRoot })).stdout);
    const cjs = JSON.parse((await execFileAsync(process.execPath, [cjsProbe], { cwd: consumerRoot })).stdout);
    assert.deepEqual(cjs, esm, 'Packed ESM and CJS entry points expose different runtime names.');
    assert.deepEqual(esm[packageJson.name], ['packageStatus', 'protocolVersion', 'supportedProfiles'],
      'The package root must expose only package metadata.');
    await verifyPackedValueExports({ consumerRoot, runtimeExports: esm });
    await verifyPublisherQuickstartConsumer({ consumerRoot, installedPackage, packageRoot });
    await verifyDocumentedConsumers({ consumerRoot, installedPackage, packageRoot });
    console.log(`Packed consumer smoke accepted ${specifiers.length} ESM/CJS entry points and the JSON Schema export.`);
    console.log('Packaged Publisher quickstart compiled and ran in isolated ESM/CJS consumers.');
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

await main();
