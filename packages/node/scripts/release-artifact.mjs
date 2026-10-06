/** Explicit release ceremony: check -> pack once -> test exact bytes -> publish those bytes only. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { verifyCleanTarball } from './clean-tarball-consumer.mjs';
import { runNpm } from './lib/npm-command.mjs';
import { artifactDigests, assertAcceptedArtifact, assertReleaseMatrix, releaseReadiness } from './lib/release-artifact-contract.mjs';

const exec = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repository = resolve(root, '..', '..');
const git = async args => (await exec('git', args, { cwd: repository, encoding: 'utf8' })).stdout.trim();

async function cleanHead(expected) {
  const head = await git(['rev-parse', 'HEAD']);
  assert.equal(await git(['status', '--porcelain']), '', 'Release requires an exact clean source checkout.');
  if (expected !== undefined) assert.equal(head, expected, 'Source HEAD changed during release preparation.');
  return head;
}

async function readiness() {
  const manifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
  const files = await readdir(root);
  return { manifest, ...releaseReadiness(manifest, files.some(file => /^LICEN[CS]E(?:\.(?:md|txt))?$/iu.test(file))) };
}

export async function prepareArtifact(destination, candidate = false) {
  destination = resolve(destination);
  const comparedDestination = process.platform === 'win32' ? destination.toLowerCase() : destination;
  const comparedRepository = process.platform === 'win32' ? repository.toLowerCase() : repository;
  assert.ok(comparedDestination !== comparedRepository && !comparedDestination.startsWith(comparedRepository + sep),
    'Keep release artifacts outside the source repository.');
  try { await access(destination); throw new Error('Release destination already exists.'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const sourceRevision = await cleanHead();
  const state = await readiness();
  if (!candidate && state.errors.length) throw new Error(state.errors.join('\n'));
  const check = await runNpm(['run', 'check'], root, { timeoutMs: 3_600_000 });
  await cleanHead(sourceRevision);
  await mkdir(dirname(destination), { recursive: true });
  const staging = await mkdtemp(resolve(dirname(destination), '.colp-release-'));
  try {
    const packed = await runNpm(['pack', '--ignore-scripts', '--json', '--pack-destination', staging], root);
    const results = JSON.parse(packed.stdout);
    assert.equal(results.length, 1);
    const filename = results[0].filename;
    assert.equal(filename, basename(filename));
    assert.ok(filename.endsWith('.tgz'));
    const path = resolve(staging, filename);
    const cleanConsumer = await verifyCleanTarball(path);
    const bytes = await readFile(path);
    const record = { formatVersion: 1, sourceRevision,
      packageName: state.manifest.name, packageVersion: state.manifest.version,
      publishable: !candidate && state.errors.length === 0,
      readiness: { errors: state.errors, warnings: state.warnings },
      artifact: { file: filename, ...artifactDigests(bytes) },
      npmCheck: { passed: true, sourceRevision }, cleanConsumer,
      preparedAt: new Date().toISOString(), publicationState: 'not-published' };
    assertAcceptedArtifact(bytes, record);
    await cleanHead(sourceRevision);
    await writeFile(resolve(staging, 'npm-check.log'), check.stdout + check.stderr);
    await writeFile(resolve(staging, 'release-record.json'), JSON.stringify(record, null, 2) + '\n');
    await rename(staging, destination);
    return record;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

export async function inspectArtifact(directory) {
  const record = JSON.parse(await readFile(resolve(directory, 'release-record.json'), 'utf8'));
  assert.equal(record.artifact?.file, basename(record.artifact?.file ?? ''));
  assert.ok(record.artifact.file.endsWith('.tgz'));
  const bytes = await readFile(resolve(directory, record.artifact.file));
  assertAcceptedArtifact(bytes, record);
  return { record, bytes };
}

async function publishArtifact(directory, matrixDirectory, confirmation) {
  const { record, bytes } = await inspectArtifact(directory);
  assert.equal(record.publishable, true, 'A development candidate cannot be published.');
  assert.equal(confirmation, record.packageName + '@' + record.packageVersion, 'Confirm the exact package@version.');
  await cleanHead(record.sourceRevision);
  const state = await readiness();
  assert.equal(state.errors.length, 0, state.errors.join('\n'));
  assert.equal(state.manifest.name, record.packageName);
  assert.equal(state.manifest.version, record.packageVersion);
  const names = await readdir(matrixDirectory);
  const records = await Promise.all(names.filter(name => name.endsWith('.json')).map(async name =>
    JSON.parse(await readFile(resolve(matrixDirectory, name), 'utf8'))));
  assertReleaseMatrix(records, record);
  // Snapshot the already-verified bytes into a private directory, so a changed
  // original pathname cannot turn publication into a different artifact.
  const temporary = await mkdtemp(resolve(tmpdir(), 'colp-publish-accepted-'));
  try {
    const path = resolve(temporary, record.artifact.file);
    await writeFile(path, bytes, { flag: 'wx', mode: 0o400 });
    assertAcceptedArtifact(await readFile(path), record);
    const published = await runNpm(['publish', path, '--ignore-scripts', '--access', 'public'], root);
    process.stdout.write(published.stdout);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, directory, matrixDirectory, confirmation, ...extra] = process.argv.slice(2);
  if (extra.length) throw new Error('Unexpected release arguments.');
  if ((command === 'prepare' || command === 'prepare-candidate') && directory && matrixDirectory === undefined) {
    console.log(JSON.stringify(await prepareArtifact(directory, command === 'prepare-candidate'), null, 2));
  } else if (command === 'verify' && directory && matrixDirectory === undefined) {
    console.log(JSON.stringify((await inspectArtifact(directory)).record, null, 2));
  } else if (command === 'publish' && directory && matrixDirectory && confirmation) {
    await publishArtifact(resolve(directory), resolve(matrixDirectory), confirmation);
  } else {
    throw new Error('Usage: release-artifact.mjs prepare[-candidate]|verify DIR; publish DIR MATRIX_DIR exact-package@version');
  }
}
