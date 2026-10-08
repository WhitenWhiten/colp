import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { sql } from 'kysely';
import { Pool } from 'pg';
import { createDatabaseRuntime, runMigrations } from '../src/infrastructure/database/index.js';
import {
  PHASE3_SERVER_SYNC_PROBE_VERSION, PHASE3_SERVER_SYNC_RUNNER_VERSION,
  createPhase3ServerSyncAcceptanceProbe,
  type Phase3ServerSyncAcceptanceCandidate, type Phase3ServerSyncNegativeFact,
} from './acceptance/phase3-server-sync-acceptance.js';
import { runPhase3ServerSyncBlackBoxScenario } from './phase3-server-sync-black-box-scenario.js';
import { createPhase3ServerSyncProductionScenarioRuntime } from './phase3-server-sync-production-runtime.js';

const TOTAL_TIMEOUT_MS = 600_000;
const STEP_TIMEOUT_MS = 30_000;

export async function createPhase3ServerSyncAcceptanceDeployment(input: {
  readonly env: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal;
}) {
  const databaseUrl = input.env.DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error('DATABASE_URL is required; P3-26 never skips PostgreSQL');
  const controller = new AbortController();
  const parentAbort = () => controller.abort(input.signal?.reason);
  input.signal?.addEventListener('abort', parentAbort, { once: true });
  const timeout = setTimeout(() => controller.abort(new Error('P3-26 adapter timeout')), TOTAL_TIMEOUT_MS);
  timeout.unref();
  const schema = `p3_26_${randomUUID().replaceAll('-', '_')}`;
  const administrator = new Pool({ connectionString: databaseUrl, max: 1 });
  await administrator.query(`create schema ${schema}`);
  const isolatedUrl = new URL(databaseUrl);
  isolatedUrl.searchParams.set('options', `-c search_path=${schema}`);
  const isolatedDatabaseUrl = isolatedUrl.toString();
  const isolatedEnv = { ...input.env, DATABASE_URL: isolatedDatabaseUrl };
  const database = createDatabaseRuntime(isolatedDatabaseUrl, { maxConnections: 12, applicationName: 'known-phase3-server-sync-acceptance' });
  const nonce = randomBytes(24).toString('base64url');
  const instanceId = randomBytes(18).toString('base64url');
  const startedAt = new Date().toISOString();
  let closed = false;
  let runtime: Awaited<ReturnType<typeof createPhase3ServerSyncProductionScenarioRuntime>> | undefined;
  let candidate: Phase3ServerSyncAcceptanceCandidate | undefined;

  const probe = createPhase3ServerSyncAcceptanceProbe(async () => {
    if (candidate) return candidate;
    await runMigrations(database.db, 'latest');
    await verifyRequiredMigration(database);
    await sql`select 1`.execute(database.db);
    const bindings = await readPhase3ServerSyncRepositoryBindings(isolatedEnv, controller.signal);
    const { configDigest, ...artifactBindings } = bindings;
    runtime = await createPhase3ServerSyncProductionScenarioRuntime({
      database, env: isolatedEnv, nonce, instanceId, signal: controller.signal,
      repositoryBindings: bindings,
      verifyRepositoryBindings: assertPhase3ServerSyncRepositoryBindingsMatch,
    });
    const steps = await runPhase3ServerSyncBlackBoxScenario({
      runtime, runtimeNonce: nonce, perStepTimeoutMs: STEP_TIMEOUT_MS, signal: controller.signal,
    });
    const negativeControls = await runtime.runNegativeControls(controller.signal, steps);
    candidate = Object.freeze({
      runnerVersion: PHASE3_SERVER_SYNC_RUNNER_VERSION,
      probeVersion: PHASE3_SERVER_SYNC_PROBE_VERSION,
      ...artifactBindings,
      runtime: { engine: 'postgresql', instanceId, nonce, configDigest,
        startedAt, finishedAt: new Date().toISOString() },
      routes: runtime.routeFacts(), ports: runtime.portFacts(), probes: await runtime.probeFacts(),
      steps, stepCount: steps.length, negativeControls,
      telemetry: runtime.telemetryScan(), profileClaimed: false, deploymentProven: false,
    });
    return candidate;
  });

  return Object.freeze({
    probe,
    get requiredNegativeControls(): readonly string[] { return runtime?.requiredNegativeControls() ?? []; },
    async verifyNegativeControls(): Promise<readonly Phase3ServerSyncNegativeFact[]> {
      if (!candidate || !runtime) await probe.run();
      return candidate!.negativeControls;
    },
    async close() {
      if (closed) return; closed = true;
      clearTimeout(timeout); controller.abort(new Error('P3-26 deployment closed'));
      input.signal?.removeEventListener('abort', parentAbort);
      try { await runtime?.close(); } finally {
        await database.close();
        await administrator.query(`drop schema if exists ${schema} cascade`);
        await administrator.end();
      }
    },
  });
}

async function verifyRequiredMigration(database: ReturnType<typeof createDatabaseRuntime>): Promise<void> {
  const result = await sql<{ present: boolean }>`select exists (
    select 1 from kysely_migration where name = '202607252700_sync_operation_effects'
  ) as present`.execute(database.db);
  if (result.rows[0]?.present !== true) throw new Error('production migration 202607252700_sync_operation_effects is missing');
}

export async function readPhase3ServerSyncRepositoryBindings(env: NodeJS.ProcessEnv, signal: AbortSignal) {
  const root = resolve('.');
  const commit = (await execGit(['rev-parse', 'HEAD'], root, signal)).toString('utf8').trim();
  const diff = await execGit(['diff', '--binary', 'HEAD', '--', '.'], root, signal);
  const untracked = (await execGit(['ls-files', '--others', '--exclude-standard', '--', '.'], root, signal)).toString('utf8').split(/\r?\n/u).filter(Boolean)
    .filter((path) => !/^phase3-server-sync-acceptance[^/\\]*\.json$/u.test(path)).sort();
  const sourceHash = createHash('sha256').update('known.p3-26.source-tree.v2\0').update(commit).update('\0').update(diff);
  for (const path of untracked) { const bytes = await readFile(resolve(root, path)); sourceHash.update(path).update('\0').update(bytes); }
  const migrationFiles = (await readdir(resolve(root, 'migrations'))).filter((name) => /^\d+_.+\.ts$/u.test(name)).sort();
  const chainDigest = await digestFiles('known.p3-26.migrations.v2', migrationFiles.map((name) => resolve(root, 'migrations', name)), root);
  const colpRoot = resolve(root, 'node_modules/@know-n/colp');
  const colpPackageBytes = await readFile(resolve(colpRoot, 'package.json'));
  const colpPackage = JSON.parse(colpPackageBytes.toString('utf8')) as { version?: unknown };
  if (typeof colpPackage.version !== 'string') throw new Error('COLP package version is missing');
  const packageDigest = createHash('sha256').update('known.p3-26.colp-package.v2\0').update(colpPackageBytes).digest('hex');
  const lockDigest = await digestFiles('known.p3-26.colp-lock.v2', [resolve(root, 'package-lock.json')], root);
  // Published packages bundle the registries into the public conformance entry.
  // Bind evidence to that shipped implementation rather than source-only JSON.
  const conformanceDigest = await digestFiles('known.p3-26.colp-conformance.v2', [resolve(colpRoot, 'dist/conformance/index.js')], colpRoot);
  const sanitizedConfig = { node: process.versions.node, syncEnabled: true, managedBookmarkWrites: env.SYNC_MANAGED_BOOKMARK_WRITES === 'true', maxBatchOperations: 1 };
  const latestMigration = migrationFiles.at(-1)?.replace(/\.ts$/u, '');
  if (!latestMigration) throw new Error('production migration chain is empty');
  return Object.freeze({
    source: { commit, treeDigest: sourceHash.digest('hex') },
    migrations: { latest: latestMigration, files: migrationFiles, chainDigest },
    colp: { packageVersion: colpPackage.version, packageDigest, lockDigest, conformanceDigest },
    configDigest: createHash('sha256').update(JSON.stringify(sanitizedConfig)).digest('hex'),
  });
}

export async function verifyPhase3ServerSyncRepositoryBindings(
  evidence: Phase3ServerSyncAcceptanceCandidate, env: NodeJS.ProcessEnv, signal: AbortSignal,
): Promise<void> {
  const current = await readPhase3ServerSyncRepositoryBindings(env, signal);
  const expected = { source: current.source, migrations: current.migrations, colp: current.colp,
    configDigest: current.configDigest };
  const observed = { source: evidence.source, migrations: evidence.migrations, colp: evidence.colp,
    configDigest: evidence.runtime.configDigest };
  assertPhase3ServerSyncRepositoryBindingsMatch(expected, observed);
}

export function assertPhase3ServerSyncRepositoryBindingsMatch(expected: unknown, observed: unknown): void {
  if (!isDeepStrictEqual(expected, observed)) throw new Error('P3-26 artifact repository binding is stale or forged');
}

async function digestFiles(domain: string, paths: readonly string[], root: string): Promise<string> {
  const hash = createHash('sha256').update(domain).update('\0');
  for (const path of [...paths].sort()) { const bytes = await readFile(path); hash.update(path.slice(root.length).replaceAll('\\', '/')).update('\0').update(bytes); }
  return hash.digest('hex');
}

async function execGit(args: readonly string[], cwd: string, signal: AbortSignal): Promise<Buffer> {
  const { spawn } = await import('node:child_process');
  return new Promise((resolveOutput, rejectOutput) => {
    const child = spawn('git', [...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const stdout: Buffer[] = []; const stderr: Buffer[] = [];
    const timeout = setTimeout(() => child.kill('SIGKILL'), 10_000); timeout.unref();
    const abort = () => child.kill('SIGKILL'); signal.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk)); child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.once('error', rejectOutput); child.once('exit', (code) => {
      clearTimeout(timeout); signal.removeEventListener('abort', abort);
      return code === 0 ? resolveOutput(Buffer.concat(stdout)) : rejectOutput(new Error(`unable to bind source: ${Buffer.concat(stderr).toString('utf8').trim()}`));
    });
  });
}
