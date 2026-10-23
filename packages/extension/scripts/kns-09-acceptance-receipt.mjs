/**
 * Consume machine-generated gate results and write an acceptance receipt.
 * Missing, failed, skipped, cancelled, or SHA-mismatched gates cannot be accepted.
 */
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  evaluateAcceptance, inputDirtyPaths, requireSchemaVersion, rollbackPin, REQUIRED_GATE_IDS,
} from './kns-09-acceptance-lib.mjs';

const execFileAsync = promisify(execFile);
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workspace = resolve(packageRoot, '../..');

const schema = await readFile(join(packageRoot, 'src/sync-state/schema.ts'), 'utf8');
const indexedDb = requireSchemaVersion(schema, 22);

const expectedCommit = await gitCommit();
const resultsPath = process.env.KNS09_GATE_RESULTS
  || join(workspace, 'test-results/known-extension-first-run-sync', expectedCommit, 'gate-results.json');
const destDir = join(workspace, 'test-results/known-extension-first-run-sync', expectedCommit);
await mkdir(destDir, { recursive: true });

let recorded;
try {
  recorded = JSON.parse(await readFile(resultsPath, 'utf8'));
} catch {
  recorded = { schemaVersion: 1, testedCommit: expectedCommit, gates: [] };
}

const dirtyInputPaths = inputDirtyPaths(await gitPorcelain());
const evaluation = evaluateAcceptance({
  expectedCommit,
  testedCommit: recorded.testedCommit ?? expectedCommit,
  gates: recorded.gates ?? [],
  dirtyInputPaths,
  requiredIds: REQUIRED_GATE_IDS,
});

const receipt = {
  schemaVersion: 1,
  kind: 'kns-09-acceptance-receipt',
  task: 'KNS-09',
  ac: 'AC-10',
  verdict: evaluation.verdict,
  testedCommit: expectedCommit,
  recordedCommit: recorded.testedCommit ?? null,
  node: recorded.node ?? process.version,
  environment: recorded.environment ?? process.platform,
  indexedDb,
  featureFlags: {
    kns09MutationsStorageKey: 'known.kns09.mutations.v1',
    rollbackToV9Binary: false,
  },
  requiredGateIds: evaluation.requiredIds,
  gates: recorded.gates ?? [],
  reasons: evaluation.reasons,
  dirtyInputPaths,
  gateResultsPath: resultsPath,
  gateResultsDigest: digestJson(recorded),
  rollback: rollbackPin(indexedDb.version),
};

const dest = join(destDir, 'kns-09-acceptance-receipt.json');
await writeFile(dest, `${JSON.stringify(receipt, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({
  schemaVersion: 1, kind: 'acceptance', dest, testedCommit: expectedCommit, verdict: evaluation.verdict,
})}\n`);
if (evaluation.verdict !== 'accepted') {
  process.exitCode = 1;
}

function digestJson(value) {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

async function gitCommit() {
  try {
    return (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: workspace })).stdout.trim() || 'unknown';
  } catch {
    return 'unknown';
  }
}

async function gitPorcelain() {
  try {
    return (await execFileAsync('git', ['status', '--porcelain'], { cwd: workspace })).stdout;
  } catch {
    return '';
  }
}
