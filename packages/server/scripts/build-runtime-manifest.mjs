#!/usr/bin/env node
/**
 * Runtime manifest and lockfile for the production image.
 *
 * `npm prune --omit=dev` cannot detach the server from its test tooling:
 * better-auth declares `vitest` as an optional peer dependency, so the dev
 * lockfile marks vitest, tinypool and tsx as peers of a production package and
 * every `--omit` variant still installs them. Re-evaluating the lockfile from a
 * manifest WITHOUT devDependencies is what drops the peer marking (verified
 * experimentally: 200 packages instead of 249, no retained version changed).
 *
 * This script derives `runtime/package.json` (name, version, license, type,
 * engines, bin, dependencies, overrides) from `package.json`, copies the dev
 * lockfile next to it and lets npm prune it in place with
 * `npm install --package-lock-only --omit=dev --omit=peer`. Pruning keeps every
 * retained version identical to the dev lockfile, so the runtime lock is an
 * exact subset and never resolves anything new.
 *
 *   node scripts/build-runtime-manifest.mjs          regenerate runtime/
 *   node scripts/build-runtime-manifest.mjs --check  fail when runtime/ drifts
 *
 * The Dockerfile installs the runtime stage from `runtime/` with
 * `npm ci --omit=dev --omit=peer --ignore-scripts`; CI runs `--check`, audits
 * the runtime lock and asserts that vitest, tinypool and tsx are absent.
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runtimeDir = resolve(packageRoot, 'runtime');
const RUNTIME_MANIFEST_FIELDS = ['name', 'version', 'license', 'type', 'engines', 'bin', 'dependencies', 'overrides'];
// Test tooling that the dev lockfile marks as optional peers of production
// packages. The runtime install must never materialize them.
export const RUNTIME_FORBIDDEN_PACKAGES = ['vitest', 'tinypool', 'tsx', '@vitest/mocker'];

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function runtimeManifestFrom(devManifest) {
  const runtime = {};
  for (const field of RUNTIME_MANIFEST_FIELDS) {
    if (field in devManifest) runtime[field] = devManifest[field];
  }
  if (!runtime.dependencies || Object.keys(runtime.dependencies).length === 0) {
    throw new Error('package.json declares no dependencies; refusing to build an empty runtime manifest');
  }
  return runtime;
}

function generate(targetDir) {
  mkdirSync(targetDir, { recursive: true });
  const devManifest = readJson(resolve(packageRoot, 'package.json'));
  writeFileSync(resolve(targetDir, 'package.json'), `${JSON.stringify(runtimeManifestFrom(devManifest), null, 2)}\n`);
  copyFileSync(resolve(packageRoot, 'package-lock.json'), resolve(targetDir, 'package-lock.json'));
  const result = spawnSync('npm', [
    'install', '--package-lock-only', '--ignore-scripts', '--omit=dev', '--omit=peer', '--no-audit', '--no-fund',
  ], { cwd: targetDir, stdio: ['ignore', 'inherit', 'inherit'] });
  if (result.status !== 0) throw new Error(`npm install --package-lock-only failed in ${targetDir}`);
  verifyLock(targetDir);
}

/**
 * Every retained runtime entry must carry the exact version the dev lockfile
 * resolved, and no entry may be a dev-only package.
 */
function verifyLock(targetDir) {
  const dev = readJson(resolve(packageRoot, 'package-lock.json')).packages;
  const runtime = readJson(resolve(targetDir, 'package-lock.json')).packages;
  const problems = [];
  for (const [path, entry] of Object.entries(runtime)) {
    if (path === '') continue;
    if (entry.dev) problems.push(`${path} is still marked dev`);
    const devEntry = dev[path];
    if (devEntry === undefined) problems.push(`${path} is not in the dev lockfile`);
    else if (devEntry.version !== entry.version) {
      problems.push(`${path} resolved ${entry.version}, dev lockfile has ${devEntry.version}`);
    }
  }
  for (const name of RUNTIME_FORBIDDEN_PACKAGES) {
    const entry = runtime[`node_modules/${name}`];
    if (entry !== undefined && entry.peer !== true) problems.push(`${name} is a non-peer runtime dependency`);
  }
  if (problems.length > 0) throw new Error(`runtime lockfile verification failed:\n  ${problems.join('\n  ')}`);
}

function sameFile(a, b) {
  return readFileSync(a, 'utf8') === readFileSync(b, 'utf8');
}

function check() {
  const scratch = mkdtempSync(resolve(tmpdir(), 'colp-runtime-manifest-'));
  try {
    generate(scratch);
    const drifted = ['package.json', 'package-lock.json'].filter((file) => {
      try {
        return !sameFile(resolve(scratch, file), resolve(runtimeDir, file));
      } catch {
        return true;
      }
    });
    if (drifted.length > 0) {
      throw new Error(`runtime/${drifted.join(', runtime/')} drifted from package.json / package-lock.json; `
        + 'run `npm run runtime:manifest` and commit the result');
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

const invokedDirectly = process.argv[1] !== undefined
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  try {
    if (process.argv.includes('--check')) {
      check();
      process.stdout.write('runtime manifest and lockfile are up to date\n');
    } else {
      generate(runtimeDir);
      process.stdout.write('wrote runtime/package.json and runtime/package-lock.json\n');
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
