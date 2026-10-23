/**
 * Write a KNS-09 release *manifest*: versions, schema v23, fixture digest.
 * This is not an acceptance proof.
 */
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { requireSchemaVersion, rollbackPin } from './kns-09-acceptance-lib.mjs';

const execFileAsync = promisify(execFile);
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workspace = resolve(packageRoot, '../..');

const [extensionPkg, backendPkg, colpPkg, schema, golden, config] = await Promise.all([
  readJson(join(packageRoot, 'package.json')),
  readJson(join(workspace, 'packages/server/package.json')),
  readJson(join(packageRoot, 'node_modules/@know-n/colp/package.json')),
  readFile(join(packageRoot, 'src/sync-state/schema.ts'), 'utf8'),
  readFile(join(workspace, 'packages/extension/tests/fixtures/kns-00/golden-scenarios.json')),
  readFile(join(packageRoot, 'config/e2e-fixture.json'), 'utf8').catch(() => ''),
]);

const indexedDb = requireSchemaVersion(schema, 23);

const commit = await gitCommit();
const manifest = {
  schemaVersion: 1,
  kind: 'kns-09-release-manifest',
  verdict: 'manifest',
  task: 'KNS-09',
  ac: 'AC-10',
  testedCommit: commit,
  packages: {
    colp: colpPkg.version,
    backend: backendPkg.version,
    extension: extensionPkg.version,
  },
  indexedDb,
  featureFlags: {
    kns09MutationsStorageKey: 'known.kns09.mutations.v1',
    coordinatorMutations: true,
    uiMutations: true,
    rollbackToV9Binary: false,
  },
  fixtureDigest: `sha256:${createHash('sha256').update(golden).digest('hex')}`,
  fixturePath: 'packages/extension/tests/fixtures/kns-00/golden-scenarios.json',
  configDigest: config
    ? `sha256:${createHash('sha256').update(config).digest('hex')}` : null,
  requiredGateIds: [
    'extension.typecheck',
    'extension.e2e-first-run-sync',
    'extension.e2e-trash-restore',
  ],
  rollback: rollbackPin(indexedDb.version),
};

const destDir = join(workspace, 'test-results/known-extension-first-run-sync', commit);
await mkdir(destDir, { recursive: true });
const dest = join(destDir, 'kns-09-release-manifest.json');
await writeFile(dest, `${JSON.stringify(manifest, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ schemaVersion: 1, kind: 'manifest', dest, testedCommit: commit })}\n`);

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function gitCommit() {
  try {
    return (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: workspace })).stdout.trim() || 'unknown';
  } catch {
    return 'unknown';
  }
}
