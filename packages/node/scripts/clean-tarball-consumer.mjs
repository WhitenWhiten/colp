/** Install and validate an existing tarball; never repack or link checkout dependencies. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';
import { runCleanConsumerNode } from './lib/clean-consumer-sandbox.mjs';
import { makeConsumerTreeReadable } from './lib/consumer-permissions.mjs';
export { makeConsumerTreeReadable } from './lib/consumer-permissions.mjs';
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const exactVersion = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;

const MAX_EXPANDED_TARBALL_BYTES = 128 * 1024 * 1024;
const MAX_TARBALL_ENTRIES = 100_000;
const registryVersionSpec = /^[0-9A-Za-z*^~<>=|().,\-+\s]+$/u;
const registryPackageAliasSpec = /^npm:(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(?:@[0-9A-Za-z*^~<>=|().,\-+\s]+)?$/iu;

/**
 * Accept only npm registry version/range/tag syntax.  A dependency key does
 * not make its value safe: npm also accepts URLs, git shorthands, local paths,
 * and hosted aliases that do not contain an obvious URI scheme.
 */
function isRegistryDependencySpec(value) {
  const spec = value.trim();
  if (spec === '' || /^(?:file|link|workspace|git|ssh|https?|github|gitlab|bitbucket|gist):/iu.test(spec)) return false;
  if (/^(?:git@|(?:\.\.?\/|~\/|\/))/u.test(spec)) return false;
  if (spec.includes('://') || /^[^\s/]+\/[^\s/]+(?:#|$)/u.test(spec)) return false;
  if (spec.startsWith('npm:')) return registryPackageAliasSpec.test(spec);
  return registryVersionSpec.test(spec);
}

function tarField(header, offset, length) {
  const field = header.subarray(offset, offset + length);
  const end = field.indexOf(0);
  return field.subarray(0, end === -1 ? length : end).toString('utf8').trim();
}

function tarSize(header) {
  const raw = tarField(header, 124, 12).replace(/^\s+/u, '');
  if (!/^[0-7]+$/u.test(raw)) throw new Error('Candidate tarball has an invalid entry size.');
  const size = Number.parseInt(raw, 8);
  if (!Number.isSafeInteger(size) || size < 0) throw new Error('Candidate tarball has an excessive entry size.');
  return size;
}

/**
 * Inspect the gzip/tar stream without extracting it on the verifier host.
 * This bounds decompression, rejects links/path escapes, validates the package
 * identity and rejects dependency specs that could redirect npm to arbitrary
 * hosts before the candidate reaches the networkless install container.
 */
export async function inspectCandidateTarball(artifact, expectedName, expectedVersion) {
  const gunzip = createGunzip();
  Readable.from([artifact]).pipe(gunzip);
  let pending = Buffer.alloc(0);
  let expanded = 0;
  let decompressedBytes = 0;
  const paths = new Set();
  let entries = 0;
  let manifest;
  let endBlocks = 0;
  for await (const chunk of gunzip) {
    decompressedBytes += chunk.length;
    if (decompressedBytes > MAX_EXPANDED_TARBALL_BYTES) {
      throw new Error('Candidate tarball exceeds the expanded byte budget.');
    }
    pending = Buffer.concat([pending, Buffer.from(chunk)]);
    while (pending.length >= 512) {
      const header = pending.subarray(0, 512);
      if (header.every(byte => byte === 0)) {
        endBlocks += 1;
        pending = pending.subarray(512);
        if (endBlocks >= 2) {
          // The standard tar terminator is two zero blocks. Permit additional
          // zero padding but reject any data after the terminator rather than
          // silently ignoring a concatenated archive.
          if (pending.some(byte => byte !== 0)) throw new Error('Candidate tarball has trailing archive data.');
          pending = Buffer.alloc(0);
          break;
        }
        continue;
      }
      if (endBlocks !== 0) throw new Error('Candidate tarball has trailing archive data.');
      const size = tarSize(header);
      const padded = Math.ceil(size / 512) * 512;
      const recordSize = 512 + padded;
      if (recordSize > MAX_EXPANDED_TARBALL_BYTES || expanded + recordSize > MAX_EXPANDED_TARBALL_BYTES) {
        throw new Error('Candidate tarball exceeds the expanded byte budget.');
      }
      if (pending.length < recordSize) break;
      entries += 1;
      if (entries > MAX_TARBALL_ENTRIES) throw new Error('Candidate tarball exceeds the entry budget.');
      const name = tarField(header, 0, 100);
      const prefix = tarField(header, 345, 155);
      const path = prefix === '' ? name : `${prefix}/${name}`;
      if (!path.startsWith('package/') || path.includes('\\')
        || path.split('/').some(part => part === '..' || part === '.')) {
        throw new Error('Candidate tarball contains an invalid package path.');
      }
      if (paths.has(path)) throw new Error('Candidate tarball contains a duplicate package path.');
      paths.add(path);
      const type = String.fromCharCode(header[156] ?? 0);
      if (type !== '0' && type !== '\0' && type !== '5') {
        throw new Error('Candidate tarball contains a link or unsupported archive entry.');
      }
      if (path === 'package/package.json' && type !== '5') {
        try {
          manifest = JSON.parse(pending.subarray(512, 512 + size).toString('utf8'));
        } catch (error) {
          throw new Error('Candidate package.json is not valid JSON.', { cause: error });
        }
      }
      expanded += recordSize;
      pending = pending.subarray(recordSize);
    }
  }
  if (endBlocks < 2 || pending.length !== 0) throw new Error('Candidate tarball is missing its end-of-archive blocks.');
  assert.ok(manifest && typeof manifest === 'object' && !Array.isArray(manifest), 'Candidate package.json is missing.');
  assert.equal(manifest.name, expectedName, 'Candidate package name does not match the verifier target.');
  assert.equal(manifest.version, expectedVersion, 'Candidate package version does not match the verifier target.');
  for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    const dependencies = manifest[field];
    if (dependencies === undefined) continue;
    assert.ok(dependencies && typeof dependencies === 'object' && !Array.isArray(dependencies), `Invalid ${field}.`);
    for (const [name, spec] of Object.entries(dependencies)) {
      assert.equal(typeof spec, 'string', `Invalid ${field} spec for ${name}.`);
      if (!isRegistryDependencySpec(spec)) {
        throw new Error(`Candidate dependency ${name} uses a non-registry source.`);
      }
    }
  }
  return Object.freeze({ manifest, expandedBytes: expanded, entries });
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
  await inspectCandidateTarball(artifact, expected.name, expected.version);
  const requestedCache = options.npmCache
    ?? process.env.npm_config_cache
    ?? (process.env.HOME === undefined ? undefined : resolve(process.env.HOME, '.npm'));
  let npmCache;
  if (requestedCache !== undefined && isAbsolute(requestedCache)) {
    try {
      const cacheInfo = await stat(requestedCache);
      if (cacheInfo.isDirectory()) npmCache = requestedCache;
    } catch {
      // A missing cache makes the networkless install fail closed below.
    }
  }
  if (npmCache === undefined) {
    throw new Error('A pre-populated npm cache is required for networkless clean-tarball verification.');
  }
  const temporary = await mkdtemp(resolve(tmpdir(), 'colp-clean-tarball-'));
  try {
    // Docker must be able to traverse the host-side source path as uid 65534.
    // The parent only needs search permission for Docker to reach /consumer.
    // Keep the tarball, npmrc files and cache names hidden from other users.
    await chmod(temporary, 0o711);
    const consumer = resolve(temporary, 'consumer');
    // npm runs as uid 65534 in the installer container and needs to create
    // node_modules on this disposable bind mount. Keep directories writable
    // so the host can delete container-owned files after read-only probes.
    await mkdir(consumer, { mode: 0o777 });
    await chmod(consumer, 0o777);
    // Never let npm read the maintainer's npmrc or credential-bearing
    // environment when processing a caller-selected artifact. The install
    // cache is mounted read-only from the caller-selected pre-populated cache.
    const copy = resolve(consumer, 'candidate.tgz');
    await writeFile(copy, artifact, { flag: 'wx', mode: 0o644 });
    // The installer runs as uid 65534 inside Docker. These files contain no
    // credentials and must be world-readable on the disposable bind mount.
    await writeFile(resolve(consumer, 'package.json'), JSON.stringify({ name: 'colp-clean-consumer', private: true, type: 'module' }), { mode: 0o644 });
    await writeFile(resolve(consumer, '.npmrc'), 'ignore-scripts=true\noffline=true\naudit=false\nfund=false\n', { mode: 0o644 });
    await writeFile(resolve(consumer, '.colp-consumer-permissions.mjs'),
      await readFile(resolve(packageRoot, 'scripts/lib/consumer-permissions.mjs')), { mode: 0o644 });
    const npmScript = resolve(consumer, '.colp-install.mjs');
    await writeFile(npmScript, [
      "import { spawnSync } from 'node:child_process';",
      "import { makeConsumerTreeReadable } from './.colp-consumer-permissions.mjs';",
      'const result = spawnSync(\'npm\', process.argv.slice(2), { stdio: \'inherit\' });',
      "await makeConsumerTreeReadable('/work', { writableDirectories: true });",
      'if (result.error) throw result.error;',
      'process.exit(result.status ?? 1);',
    ].join('\n'), { mode: 0o644 });
    await runCleanConsumerNode(consumer, ['.colp-install.mjs', 'install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--workspaces=false', '--no-save', '--package-lock=false', './candidate.tgz',
      'typescript@' + typescript, '@types/node@' + nodeTypes], {
      writable: true,
      npmCache,
      timeoutMs: 600_000,
    });
    await makeConsumerTreeReadable(consumer, { writableDirectories: true });
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
      await makeConsumerTreeReadable(consumer, { writableDirectories: true });
      const result = await runCleanConsumerNode(consumer, ['probe.' + mode]);
      loadResults.push(JSON.parse(result.stdout));
    }
    assert.deepEqual(loadResults[0], loadResults[1], 'ESM/CJS runtime exports differ.');
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
    await makeConsumerTreeReadable(consumer, { writableDirectories: true });
    await runCleanConsumerNode(consumer, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.json'], {
      timeoutMs: 300_000, compiler: true,
    });
    assert.equal(createHash('sha256').update(await readFile(tarballPath)).digest('hex'), sha256,
      'The source tarball changed while it was being validated.');
    const runtimeResult = await runCleanConsumerNode(consumer, ['-p',
      'JSON.stringify({ node: process.version, platform: process.platform, arch: process.arch })']);
    const runtime = JSON.parse(runtimeResult.stdout);
    assert.match(runtime.node, /^v(?:22|24)\./u);
    assert.equal(runtime.platform, 'linux');
    return { formatVersion: 1, packageName: manifest.name, packageVersion: manifest.version,
      sha256, entryCount: specifiers.length, typescript, nodeTypes, ...runtime,
      verifier: { node: process.version, platform: process.platform, arch: process.arch }, skipLibCheck: false };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 1) throw new Error('Usage: node scripts/clean-tarball-consumer.mjs /absolute/package.tgz');
  console.log(JSON.stringify(await verifyCleanTarball(resolve(args[0])), null, 2));
}
