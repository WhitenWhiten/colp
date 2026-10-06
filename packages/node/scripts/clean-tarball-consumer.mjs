/** Install and validate an existing tarball; never repack or link checkout dependencies. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { runNpm, isolatedProcessEnvironment } from './lib/npm-command.mjs';

const exec = promisify(execFile);
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const exactVersion = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;

export function runtimeSpecifiers(packageJson) {
  assert.equal(typeof packageJson.name, 'string');
  assert.ok(packageJson.exports && typeof packageJson.exports === 'object');
  return Object.entries(packageJson.exports)
    .filter(([, entry]) => entry !== null && typeof entry === 'object'
      && typeof entry.import === 'string' && typeof entry.require === 'string')
    .map(([key]) => key === '.' ? packageJson.name : packageJson.name + key.slice(1));
}

export async function verifyCleanTarball(tarballPath, options = {}) {
  assert.ok(isAbsolute(tarballPath) && tarballPath.endsWith('.tgz'), 'Pass an absolute .tgz path.');
  const info = await stat(tarballPath);
  assert.ok(info.isFile() && info.size <= 256 * 1024 * 1024, 'Invalid or excessive tarball size.');
  const artifact = await readFile(tarballPath);
  const sha256 = createHash('sha256').update(artifact).digest('hex');
  const expected = JSON.parse(await readFile(resolve(packageRoot, 'package.json'), 'utf8'));
  const lock = JSON.parse(await readFile(resolve(packageRoot, 'package-lock.json'), 'utf8'));
  const typescript = options.typescript ?? lock.packages?.['node_modules/typescript']?.version;
  const nodeTypes = options.nodeTypes ?? lock.packages?.['node_modules/@types/node']?.version;
  assert.ok(exactVersion.test(typescript ?? '') && exactVersion.test(nodeTypes ?? ''), 'Exact compiler and Node type versions are required.');
  const temporary = await mkdtemp(resolve(tmpdir(), 'colp-clean-tarball-'));
  try {
    const consumer = resolve(temporary, 'consumer');
    await mkdir(consumer);
    const copy = resolve(temporary, 'candidate.tgz');
    await writeFile(copy, artifact, { flag: 'wx' });
    await writeFile(resolve(consumer, 'package.json'), JSON.stringify({ name: 'colp-clean-consumer', private: true, type: 'module' }));
    await writeFile(resolve(consumer, '.npmrc'), 'ignore-scripts=true\naudit=false\nfund=false\n');
    await runNpm(['install', '--ignore-scripts', '--no-audit', '--no-fund', '--workspaces=false', copy], consumer);
    const installed = resolve(consumer, 'node_modules', ...expected.name.split('/'));
    const manifest = JSON.parse(await readFile(resolve(installed, 'package.json'), 'utf8'));
    assert.equal(manifest.name, expected.name);
    const specifiers = runtimeSpecifiers(manifest);
    assert.ok(specifiers.length >= 16, 'Missing public runtime entries.');
    const schemaSpecifier = manifest.name + '/schema/collection-protocol.schema.json';
    const loadResults = [];
    for (const mode of ['mjs', 'cjs']) {
      const loader = mode === 'mjs' ? 'await import(specifier)' : 'require(specifier)';
      const schemaLoader = mode === 'mjs'
        ? `(await import(${JSON.stringify(schemaSpecifier)}, { with: { type: 'json' } })).default`
        : `require(${JSON.stringify(schemaSpecifier)})`;
      const probe = resolve(consumer, 'probe.' + mode);
      await writeFile(probe, [
        mode === 'mjs' ? "import assert from 'node:assert/strict';" : "const assert = require('node:assert/strict');",
        'const results = {};',
        'for (const specifier of ' + JSON.stringify(specifiers) + ') {',
        ' const loaded = ' + loader + '; const keys = Object.keys(loaded).sort();',
        " if (!specifier.endsWith('/types')) assert.ok(keys.length); results[specifier] = keys;",
        '}', 'const schema = ' + schemaLoader + ';',
        "assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');",
        'process.stdout.write(JSON.stringify(results));',
      ].join('\n'));
      const result = await exec(process.execPath, [probe], { cwd: consumer, env: isolatedProcessEnvironment(),
        timeout: 120_000, maxBuffer: 16 * 1024 * 1024 });
      loadResults.push(JSON.parse(result.stdout));
    }
    assert.deepEqual(loadResults[0], loadResults[1], 'ESM/CJS runtime exports differ.');
    await runNpm(['install', '--ignore-scripts', '--no-audit', '--no-fund', '--workspaces=false', '--save-exact',
      'typescript@' + typescript, '@types/node@' + nodeTypes], consumer);
    const files = [];
    for (const extension of ['mts', 'cts']) {
      const file = 'strict-consumer.' + extension;
      const imports = specifiers.map((specifier, index) =>
        'import * as entry' + index + ' from ' + JSON.stringify(specifier) + '; void entry' + index + ';');
      await writeFile(resolve(consumer, file), imports.join('\n'));
      files.push(file);
    }
    const config = resolve(consumer, 'tsconfig.json');
    await writeFile(config, JSON.stringify({ compilerOptions: { target: 'ES2023', module: 'NodeNext',
      moduleResolution: 'NodeNext', lib: ['ES2023'], types: ['node'], strict: true,
      skipLibCheck: false, noEmit: true }, files }));
    await exec(process.execPath, [resolve(consumer, 'node_modules/typescript/bin/tsc'), '-p', config], {
      cwd: consumer, env: isolatedProcessEnvironment(), timeout: 300_000, maxBuffer: 16 * 1024 * 1024,
    });
    assert.equal(createHash('sha256').update(await readFile(tarballPath)).digest('hex'), sha256,
      'The source tarball changed while it was being validated.');
    return { formatVersion: 1, packageName: manifest.name, packageVersion: manifest.version,
      sha256, entryCount: specifiers.length, typescript, nodeTypes, node: process.version,
      platform: process.platform, arch: process.arch, skipLibCheck: false };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 1) throw new Error('Usage: node scripts/clean-tarball-consumer.mjs /absolute/package.tgz');
  console.log(JSON.stringify(await verifyCleanTarball(resolve(args[0])), null, 2));
}
