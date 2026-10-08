import { existsSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve, sep } from 'node:path';
import { applySelfHostedPreset } from './self-hosted-preset.js';
import { loadConfig, type AppConfig } from './config.js';
import { startApi, type StartedApi, type StartApiOptions } from './api.js';
import { createWorkerProcess, type WorkerProcessHandle } from './worker.js';
import {
  registerFatalProcessHandlers,
  registerGracefulShutdown,
  reportFatalProcessError,
  DEFAULT_GRACEFUL_SHUTDOWN_DEADLINE_MS,
  type StoppableRuntime,
} from './process-lifecycle.js';
import { createLogger } from '../infrastructure/telemetry/index.js';
import {
  createDatabaseRuntime,
  maintenanceDatabaseRuntimeOptions,
  runMigrations,
  type DatabaseRuntime,
} from '../infrastructure/database/index.js';
import type { ReadinessProbe } from '../infrastructure/health.js';
import { firstRunMessage, prepareColpInstance } from '../infrastructure/auth/colp-instance-settings.js';

/**
 * Link health is on and its unset default is 4. Together with the outbox
 * default of 1 that would exceed the shared-pool worker cap of 3.
 */
const LINK_HEALTH_SHARED_POOL_CONCURRENCY = '2';

export interface MigrationCurrencyGate extends ReadinessProbe {
  markCurrent(): void;
}

/** `/ready` stays 503 until `runMigrations(..., 'latest')` has succeeded. */
export function createMigrationCurrencyGate(): MigrationCurrencyGate {
  let current = false;
  return {
    markCurrent() {
      current = true;
    },
    async verifyReady() {
      if (!current) throw new Error('migrations are not current');
    },
  };
}

export interface SelfHostedDependencies {
  readonly env?: NodeJS.ProcessEnv;
  readonly loadConfig?: (env: NodeJS.ProcessEnv) => AppConfig;
  readonly runMigrations?: typeof runMigrations;
  readonly createDatabase?: (config: AppConfig, role: 'migrator' | 'runtime') => DatabaseRuntime;
  /** Arms the single-owner guard after migrations; reports a missing owner. */
  readonly prepareInstance?: (database: DatabaseRuntime, env: NodeJS.ProcessEnv) => Promise<{
    readonly ownerMissing: boolean;
  }>;
  readonly startApi?: (options: StartApiOptions) => Promise<StartedApi>;
  readonly createWorkerProcess?: (
    config: AppConfig,
    database: DatabaseRuntime,
  ) => Promise<Pick<WorkerProcessHandle, 'start' | 'stop'>>;
  readonly registerShutdown?: (runtime: StoppableRuntime) => () => void;
  readonly migrationGate?: MigrationCurrencyGate;
  /** When false, build the process but do not bind the API port. */
  readonly listen?: boolean;
}

export interface SelfHostedProcess {
  readonly config: AppConfig;
  readonly database: DatabaseRuntime;
  readonly gate: MigrationCurrencyGate;
  stop(): Promise<void>;
}

/** Compiled entry loads esbuild bundles. Source entry (tsx, tests) loads migrations/*.ts. */
function migrationDirectory(): string | undefined {
  const bundled = resolve('dist/migrations');
  const compiled = import.meta.url.includes(`${sep}dist${sep}`);
  if (compiled && existsSync(bundled)) return bundled;
  return undefined;
}

function capUnsetWorkerReserve(env: NodeJS.ProcessEnv): void {
  if (env.LINK_HEALTH_WORKER_CONCURRENCY === undefined || env.LINK_HEALTH_WORKER_CONCURRENCY.trim() === '') {
    env.LINK_HEALTH_WORKER_CONCURRENCY = LINK_HEALTH_SHARED_POOL_CONCURRENCY;
  }
}

function defaultCreateDatabase(
  config: AppConfig,
  role: 'migrator' | 'runtime',
  env: NodeJS.ProcessEnv,
): DatabaseRuntime {
  const shared = {
    maxConnections: config.database.maxConnections,
    connectionTimeoutMs: config.database.connectionTimeoutMs,
    idleTimeoutMs: config.database.idleTimeoutMs,
    applicationName: role === 'migrator' ? 'colp-migrator' : 'colp-server',
    production: config.nodeEnv === 'production',
    ssl: config.databaseSsl,
  };
  if (role === 'migrator') {
    return createDatabaseRuntime(config.databaseUrl, {
      ...shared,
      ...maintenanceDatabaseRuntimeOptions(env),
    });
  }
  return createDatabaseRuntime(config.databaseUrl, {
    ...shared,
    statementTimeoutMs: config.database.statementTimeoutMs,
    lockTimeoutMs: config.database.lockTimeoutMs,
    idleTransactionTimeoutMs: config.database.idleTransactionTimeoutMs,
  });
}

export async function startSelfHosted(deps: SelfHostedDependencies = {}): Promise<SelfHostedProcess> {
  const env = deps.env ?? process.env;
  applySelfHostedPreset(env);
  capUnsetWorkerReserve(env);
  const config = (deps.loadConfig ?? loadConfig)(env);
  const gate = deps.migrationGate ?? createMigrationCurrencyGate();
  const createDatabase = deps.createDatabase ?? ((
    next: AppConfig,
    role: 'migrator' | 'runtime',
  ) => defaultCreateDatabase(next, role, env));
  const migrator = createDatabase(config, 'migrator');
  let ownerMissing = false;
  try {
    // runMigrations holds Known's reentrant migration advisory lock.
    const directory = migrationDirectory();
    const migrate = deps.runMigrations ?? runMigrations;
    await (directory === undefined
      ? migrate(migrator.db, 'latest')
      : migrate(migrator.db, 'latest', directory));
    const prepare = deps.prepareInstance ?? ((database: DatabaseRuntime, next: NodeJS.ProcessEnv) =>
      prepareColpInstance(database.db, { singleOwner: next.COLP_MULTI_USER !== 'true' }));
    ({ ownerMissing } = await prepare(migrator, env));
  } catch (error) {
    await migrator.close();
    throw error;
  }
  await migrator.close();
  gate.markCurrent();

  const database = createDatabase(config, 'runtime');
  let api: StartedApi | undefined;
  let worker: Pick<WorkerProcessHandle, 'start' | 'stop'> | undefined;
  let stopping: Promise<void> | undefined;
  const closeAll = (): Promise<void> => {
    stopping ??= (async () => {
      const failures: unknown[] = [];
      if (worker) {
        try { await worker.stop(); } catch (error) { failures.push(error); }
      }
      if (api) {
        try { await api.stop(); } catch (error) { failures.push(error); }
      }
      try { await database.close(); } catch (error) { failures.push(error); }
      if (failures.length > 0) {
        throw new AggregateError(failures, 'self-hosted shutdown failed');
      }
    })();
    return stopping;
  };
  try {
    api = await (deps.startApi ?? startApi)({
      config,
      database,
      closeDatabase: false,
      listen: false,
      registerShutdown: false,
      readiness: gate,
    });
    const openWorker = deps.createWorkerProcess
      ?? ((next, shared) => createWorkerProcess(next, shared, { closeDatabase: false }));
    worker = await openWorker(config, database);
    await worker.start();
    if (deps.listen !== false) await api.listen();
    if (ownerMissing) {
      // D27: the setup token is how the operator, and only the operator,
      // creates the owner account on a freshly exposed origin.
      api.app.log.warn(firstRunMessage(config.publication.origin, env.COLP_SETUP_TOKEN ?? ''));
    }
  } catch (error) {
    try { await closeAll(); } catch { /* report the startup error */ }
    throw error;
  }

  const removeShutdown = (deps.registerShutdown ?? ((runtime: StoppableRuntime) => registerGracefulShutdown(runtime, {
    onError: (message) => {
      api?.app.log.error({ error: message }, 'self-hosted graceful shutdown failed');
    },
    deadlineMs: DEFAULT_GRACEFUL_SHUTDOWN_DEADLINE_MS,
  })))({ stop: closeAll });

  return {
    config,
    database,
    gate,
    async stop() {
      removeShutdown();
      await closeAll();
    },
  };
}

function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(resolve(entry))).href;
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  const processLogger = createLogger(process.env.LOG_LEVEL?.trim() || 'info');
  registerFatalProcessHandlers({ logger: processLogger });
  startSelfHosted().catch((error: unknown) => {
    reportFatalProcessError(processLogger, 'startup_failure', error);
    process.exitCode = 1;
  });
}
