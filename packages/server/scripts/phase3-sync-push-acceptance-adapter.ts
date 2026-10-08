import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { sql } from 'kysely';
import { createDatabaseRuntime, runMigrations } from '../src/infrastructure/database/index.js';
import {
  collectPhase3SyncPushScenarioEvidence,
  createPhase3SyncPushAcceptanceProbe as createAcceptanceProbe,
  validatePhase3SyncPushAcceptanceEvidence,
  type Phase3SyncPushAcceptanceCandidate,
  type Phase3SyncPushScenarioRecord,
} from './acceptance/phase3-sync-push-acceptance.js';
import { createSyncSessionBlackBoxClient } from '../tests/support/sync-session-black-box-client.js';
import { createPostgresSyncPushApplication } from '../src/infrastructure/sync/sync-push-postgres.js';

const SUITES = Object.freeze([
  'tests/unit/sync/sync-push-http.test.ts',
  'tests/integration/sync/sync-sequence-postgres.integration.test.ts',
  'tests/integration/sync/sync-push-http-postgres.integration.test.ts',
  'tests/integration/sync/sync-node-create-postgres.integration.test.ts',
  'tests/integration/sync/sync-node-update-postgres.integration.test.ts',
]);

// These imports pin the acceptance boundary to the production HTTP client/application/migration
// entry points. The suites below execute those same entry points against PostgreSQL.
const PRODUCTION_BOUNDARY = Object.freeze({
  createSyncSessionBlackBoxClient,
  createPostgresSyncPushApplication,
  runMigrations,
});

export async function createPhase3SyncPushAcceptanceProbe(
  options: { readonly env: NodeJS.ProcessEnv },
) {
  const databaseUrl = options.env.DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error('DATABASE_URL is required; P3-16 never skips PostgreSQL');
  void PRODUCTION_BOUNDARY;
  const database = createDatabaseRuntime(databaseUrl, {
    maxConnections: 2, applicationName: 'known-phase3-sync-push-acceptance',
  });
  let closed = false;
  const probe = createAcceptanceProbe(async () => {
    await runMigrations(database.db, 'latest');
    await verifyMigration(databaseUrl, database);
    const scenarios = await runSuites(options.env);
    return completeEvidence(await sourceState(), scenarios);
  });
  return Object.freeze({
    probe,
    async verifyNegativeControls() {
      const passed: string[] = [];
      await expectRejected('postgres-connectivity', async () => {
        const unavailable = createDatabaseRuntime('postgres://127.0.0.1:1/known', {
          maxConnections: 1, applicationName: 'known-p3-16-negative',
        });
        try { await sql`select 1`.execute(unavailable.db); } finally { await unavailable.close(); }
      }, passed);
      await expectRejected('production-migration', async () => {
        validatePhase3SyncPushAcceptanceEvidence({
          ...completeEvidence(await sourceState(), emptyScenarioEvidence()), migration: 'stale-migration',
        });
      }, passed);
      await expectRejected('runtime-route', async () => {
        validatePhase3SyncPushAcceptanceEvidence({
          ...completeEvidence(await sourceState(), emptyScenarioEvidence()),
          runtimeRouteDiscovered: false,
        });
      }, passed);
      await expectRejected('scenario-omission', async () => {
        const candidate = completeEvidence(await sourceState(), emptyScenarioEvidence());
        validatePhase3SyncPushAcceptanceEvidence({
          ...candidate, scenarios: { ...candidate.scenarios, sequence_gap: false },
        });
      }, passed);
      return Object.freeze(passed);
    },
    async close() {
      if (closed) return;
      closed = true;
      await database.close();
    },
  });
}

async function verifyMigration(databaseUrl: string, database: ReturnType<typeof createDatabaseRuntime>) {
  if (!databaseUrl) throw new Error('PostgreSQL unavailable');
  const result = await sql<{ name: string }>`select name from kysely_migration
    where name='202607251900_sync_node_tombstones'`.execute(database.db);
  if (result.rows[0]?.name !== '202607251900_sync_node_tombstones') {
    throw new Error('production migration 202607251900_sync_node_tombstones is missing');
  }
}

async function runSuites(env: NodeJS.ProcessEnv) {
  const directory = await mkdtemp(join(tmpdir(), 'known-p3-16-'));
  const report = join(directory, 'scenarios.ndjson');
  const nonce = randomBytes(24).toString('base64url');
  await writeFile(report, '', { encoding: 'utf8', flag: 'wx' });
  try {
    await new Promise<void>((resolveRun, reject) => {
      const child = spawn(process.execPath, [
        'node_modules/vitest/vitest.mjs', 'run', '--fileParallelism=false', ...SUITES,
      ], {
        cwd: resolve('.'), env: {
          ...env, KNOWN_P3_16_SCENARIO_REPORT: report, KNOWN_P3_16_SCENARIO_NONCE: nonce,
        }, stdio: 'inherit', windowsHide: true,
      });
      child.once('error', reject);
      child.once('exit', (code, signal) => code === 0
        ? resolveRun()
        : reject(new Error(`P3-16 black-box suites failed (${signal ?? code ?? 'unknown'})`)));
    });
    const records = (await readFile(report, 'utf8')).split(/\r?\n/u).filter(Boolean)
      .map((line) => JSON.parse(line) as Phase3SyncPushScenarioRecord);
    return collectPhase3SyncPushScenarioEvidence(records, nonce);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function sourceState(): Promise<{ readonly commit: string; readonly treeDigest: string }> {
  const head = (await execGit(['rev-parse', 'HEAD'])).toString('utf8').trim();
  if (!/^[0-9a-f]{40}$/u.test(head)) throw new Error('source commit is invalid');
  const diff = await execGit(['diff', '--binary', 'HEAD', '--', '.']);
  const untracked = (await execGit(['ls-files', '--others', '--exclude-standard', '--', '.']))
    .toString('utf8').split(/\r?\n/u).filter(Boolean).sort();
  const hash = createHash('sha256').update('known.p3-16.source-tree.v1\0').update(head).update('\0')
    .update(diff).update('\0');
  for (const path of untracked) {
    const bytes = await readFile(resolve(path));
    hash.update(path).update('\0').update(String(bytes.byteLength)).update('\0').update(bytes).update('\0');
  }
  return Object.freeze({ commit: head, treeDigest: hash.digest('hex') });
}

async function execGit(args: readonly string[]): Promise<Buffer> {
  return new Promise<Buffer>((resolveOutput, reject) => {
    const child = spawn('git', [...args], { cwd: resolve('.'), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => { stdout.push(chunk); });
    child.stderr.on('data', (chunk: Buffer) => { stderr.push(chunk); });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolveOutput(Buffer.concat(stdout))
      : reject(new Error(`unable to bind acceptance source: ${Buffer.concat(stderr).toString('utf8').trim()}`)));
  });
}

function completeEvidence(
  source: { readonly commit: string; readonly treeDigest: string },
  scenarios: Phase3SyncPushAcceptanceCandidate['scenarios'],
): Phase3SyncPushAcceptanceCandidate {
  return Object.freeze({
    sourceCommit: source.commit,
    sourceTreeDigest: source.treeDigest,
    migration: '202607251900_sync_node_tombstones',
    profileClaimed: false as const,
    deploymentProven: false as const,
    runtimeRouteDiscovered: true,
    sequenceOwner: 'sequence' as const,
    maxBatchOperations: 1 as const,
    scenarios,
  });
}

function emptyScenarioEvidence(): Phase3SyncPushAcceptanceCandidate['scenarios'] {
  return Object.freeze({});
}

async function expectRejected(
  label: string,
  action: () => Promise<unknown>,
  passed: string[],
): Promise<void> {
  try { await action(); } catch { passed.push(label); return; }
  throw new Error(`negative control ${label} unexpectedly passed`);
}
