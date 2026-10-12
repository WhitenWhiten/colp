/**
 * Append one machine gate result for kns-09-acceptance-receipt.mjs.
 * Usage: node scripts/kns-09-record-gate.mjs --id extension.typecheck --command 'npm run typecheck' --exit-code 0
 */
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workspace = resolve(packageRoot, '../..');
const args = parseArgs(process.argv.slice(2));
const commit = args.commit || await gitCommit();
const destDir = join(workspace, 'test-results/known-extension-first-run-sync', commit);
await mkdir(destDir, { recursive: true });
const dest = args.file || join(destDir, 'gate-results.json');
let recorded;
try {
  recorded = JSON.parse(await readFile(dest, 'utf8'));
} catch {
  recorded = { schemaVersion: 1, testedCommit: commit, node: process.version, environment: process.platform, gates: [] };
}
if (recorded.testedCommit !== commit) {
  recorded = { schemaVersion: 1, testedCommit: commit, node: process.version, environment: process.platform, gates: [] };
}
const exitCode = Number(args['exit-code']);
const status = args.status || (exitCode === 0 ? 'passed' : 'failed');
const next = {
  id: String(args.id ?? ''),
  command: String(args.command ?? ''),
  exitCode,
  status,
  testedCommit: commit,
  recordedAt: new Date().toISOString(),
};
if (!next.id) throw new Error('gate id required');
recorded.gates = [...(recorded.gates ?? []).filter((gate) => gate.id !== next.id), next];
await writeFile(dest, `${JSON.stringify(recorded, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ dest, id: next.id, status, exitCode })}\n`);

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    out[token.slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
  }
  return out;
}

async function gitCommit() {
  try {
    return (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: workspace })).stdout.trim() || 'unknown';
  } catch {
    return 'unknown';
  }
}
