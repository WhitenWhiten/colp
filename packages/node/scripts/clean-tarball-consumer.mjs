/** Install and validate an existing tarball; never repack or link checkout dependencies. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, constants, mkdtemp, mkdir, open, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runNpm, isolatedProcessEnvironment } from './lib/npm-command.mjs';

import { runCleanConsumerNode } from './lib/clean-consumer-sandbox.mjs';
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const exactVersion = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;

// The sandbox runs as uid 65534. npm commonly honors a restrictive host umask
// when it creates the consumer tree, so normalize only this disposable bind
// mount to be traversable/readable before Docker starts. The consumer tree is
// disposable package output, so use the minimum modes that work across Docker
// rootless/userns configurations for uid 65534; secrets and credentials stay
// outside this tree with restrictive modes.
//
// Do not use chmod(path) here. chmod follows a final symlink, and a package
// tree is untrusted input. Opening with O_NOFOLLOW and changing the mode on the
// file descriptor makes a symlink (including one swapped in between readdir
// and chmod) harmless. O_NONBLOCK also prevents a FIFO in a malformed package
// from making this verifier hang. Shared regular files are rejected because a
// hard link can otherwise make chmod mutate an inode outside this tree.
const noFollow = constants.O_NOFOLLOW ?? 0;
const nonBlocking = constants.O_NONBLOCK ?? 0;
const directory = constants.O_DIRECTORY ?? 0;
const directoryOpenFlags = constants.O_RDONLY | directory | noFollow;
const fileOpenFlags = constants.O_RDONLY | nonBlocking | noFollow;
const ignoredEntryErrors = new Set(['ELOOP', 'ENOENT', 'ENXIO', 'ENOTDIR', 'ENODEV']);
async function normalizeRegularFile(path) {
  let handle;
  try {
    handle = await open(path, fileOpenFlags);
  } catch (error) {
    // Symlinks, sockets and device nodes are not part of a readable package
    // tree. Leave them untouched; the later isolated import will fail closed
    // if a required entry is not usable.
    if (ignoredEntryErrors.has(error?.code)) return;
    throw error;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) return;
    if (info.nlink !== 1) {
      throw new Error(`Refusing to chmod shared package file: ${path}`);
    }
    await handle.chmod(0o644);
  } finally {
    await handle.close();
  }
}

async function normalizeDirectory(handle, path) {
  await handle.chmod(0o755);
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = resolve(path, entry.name);
    let childHandle;
    try {
      // O_DIRECTORY|O_NOFOLLOW means a symlink to a directory is rejected
      // instead of traversed. A path is only used after its parent was opened
      // and verified as a directory; no package-provided link is followed.
      childHandle = await open(child, directoryOpenFlags);
    } catch (error) {
      if (!ignoredEntryErrors.has(error?.code)) throw error;
      await normalizeRegularFile(child);
      continue;
    }
    try {
      await normalizeDirectory(childHandle, child);
    } finally {
      await childHandle.close();
    }
  }
}

export async function makeConsumerTreeReadable(root) {
  // Docker's non-root bind mount requires a no-follow directory walk. On a
  // platform without these flags, failing closed is safer than silently
  // falling back to chmod(path), which could follow an untrusted symlink.
  if (constants.O_NOFOLLOW === undefined || constants.O_DIRECTORY === undefined) {
    throw new Error('Secure consumer-tree normalization requires O_NOFOLLOW and O_DIRECTORY.');
  }
  let handle;
  try {
    handle = await open(root, directoryOpenFlags);
  } catch (error) {
    throw new Error(`Consumer tree is not a real directory: ${root}`, { cause: error });
  }
  try {
    await normalizeDirectory(handle, root);
  } finally {
    await handle.close();
  }
}

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
    // Docker must be able to traverse the host-side source path as uid 65534.
    // The parent only needs search permission for Docker to reach /consumer.
    // Keep the tarball, npmrc files and cache names hidden from other users.
    await chmod(temporary, 0o711);
    const consumer = resolve(temporary, 'consumer');
    await mkdir(consumer, { mode: 0o755 });
    // Never let npm read the maintainer's npmrc, credential-bearing environment,
    // or persistent cache when processing a caller-selected artifact.
    await mkdir(resolve(temporary, 'npm-tmp'), { mode: 0o700 });
    await mkdir(resolve(temporary, 'npm-cache'), { mode: 0o700 });
    const installationEnvironment = isolatedProcessEnvironment(temporary);
    await writeFile(resolve(temporary, 'user.npmrc'), '', { mode: 0o600 });
    await writeFile(resolve(temporary, 'global.npmrc'), '', { mode: 0o600 });
    const copy = resolve(temporary, 'candidate.tgz');
    await writeFile(copy, artifact, { flag: 'wx', mode: 0o600 });
    await writeFile(resolve(consumer, 'package.json'), JSON.stringify({ name: 'colp-clean-consumer', private: true, type: 'module' }), { mode: 0o600 });
    await writeFile(resolve(consumer, '.npmrc'), 'ignore-scripts=true\naudit=false\nfund=false\n', { mode: 0o600 });
    await runNpm(['install', '--ignore-scripts', '--no-audit', '--no-fund', '--workspaces=false', copy], consumer, { env: installationEnvironment });
    await makeConsumerTreeReadable(consumer);
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
      // Probe files are created after the npm tree normalization. Normalize
      // again so a restrictive umask cannot leave them unreadable to uid
      // 65534 in the container.
      await makeConsumerTreeReadable(consumer);
      const result = await runCleanConsumerNode(consumer, ['probe.' + mode]);
      loadResults.push(JSON.parse(result.stdout));
    }
    assert.deepEqual(loadResults[0], loadResults[1], 'ESM/CJS runtime exports differ.');
    await runNpm(['install', '--ignore-scripts', '--no-audit', '--no-fund', '--workspaces=false', '--save-exact',
      'typescript@' + typescript, '@types/node@' + nodeTypes], consumer, { env: installationEnvironment });
    await makeConsumerTreeReadable(consumer);
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
    await makeConsumerTreeReadable(consumer);
    await runCleanConsumerNode(consumer, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.json'], {
      timeoutMs: 300_000, compiler: true,
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
