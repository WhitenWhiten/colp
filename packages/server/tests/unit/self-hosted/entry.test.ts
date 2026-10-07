import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApiApp } from '../../../src/transport/app.js';
import { loadConfig as loadTestConfig } from '../../support/test-config.js';
import {
  createMigrationCurrencyGate,
  startSelfHosted,
  type SelfHostedDependencies,
} from '../../../src/bootstrap/self-hosted.js';
import { loadConfig } from '../../../src/bootstrap/config.js';
import { applySelfHostedPreset } from '../../../src/bootstrap/self-hosted-preset.js';
import { sanitizedRuntimeCapacity } from '../../../src/bootstrap/config-capacity-summary.js';
import type { DatabaseRuntime } from '../../../src/infrastructure/database/index.js';
import type { StartedApi } from '../../../src/bootstrap/api.js';

const SECRET = Buffer.alloc(32, 7).toString('base64');
const openApps: FastifyInstance[] = [];

function baseEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'production',
    COLP_SERVER_ORIGIN: 'https://colp.test',
    COLP_SERVER_SECRET: SECRET,
    DATABASE_URL: 'postgres://x',
    LOG_LEVEL: 'silent',
    ...extra,
  };
}

function fakeDatabase(): DatabaseRuntime & { closed(): boolean } {
  let isClosed = false;
  return {
    db: {} as DatabaseRuntime['db'],
    pool: { options: { max: 10 } } as DatabaseRuntime['pool'],
    cancelBackend: async () => false,
    verifyReady: async () => {},
    close: async () => { isClosed = true; },
    closed: () => isClosed,
  };
}

function readyApp(gate: { verifyReady(): Promise<void> }): FastifyInstance {
  const app = buildApiApp({
    config: loadTestConfig({
      DATABASE_URL: 'postgres://localhost/known',
      LOG_LEVEL: 'silent',
      OIDC_JWKS_URI: 'https://issuer.example/realms/known/certs',
    }),
    readiness: gate,
  });
  openApps.push(app);
  return app;
}

afterEach(async () => {
  await Promise.all(openApps.splice(0).map(async (app) => app.close()));
});

describe('self-hosted entry', () => {
  it('refuses to listen when migrations fail, and /ready is 503 until they are current', async () => {
    const gate = createMigrationCurrencyGate();
    const app = readyApp(gate);
    const notReady = await app.inject({ method: 'GET', url: '/ready' });
    expect(notReady.statusCode).toBe(503);
    expect(notReady.json()).toEqual({ status: 'not-ready' });

    let started = false;
    let listened = false;
    const roles: string[] = [];
    const failing = fakeDatabase();
    await expect(startSelfHosted({
      env: baseEnv(),
      migrationGate: gate,
      createDatabase: (_config, role) => {
        roles.push(role);
        return failing;
      },
      runMigrations: async () => { throw new Error('migration failed'); },
      startApi: async () => { started = true; throw new Error('listened'); },
      createWorkerProcess: async () => { throw new Error('worker started'); },
      registerShutdown: () => () => {},
    })).rejects.toThrow(/migration failed/);
    expect(started).toBe(false);
    expect(listened).toBe(false);
    expect(roles).toEqual(['migrator']);
    expect(failing.closed()).toBe(true);
    expect((await app.inject({ method: 'GET', url: '/ready' })).statusCode).toBe(503);

    const order: string[] = [];
    let runtime: DatabaseRuntime | undefined;
    let seenByApi: DatabaseRuntime | undefined;
    let seenByWorker: DatabaseRuntime | undefined;
    const migrator = fakeDatabase();
    const shared = fakeDatabase();
    let migrationCommand = '';
    const deps: SelfHostedDependencies = {
      env: baseEnv(),
      migrationGate: gate,
      createDatabase: (_config, role) => {
        if (role === 'migrator') return migrator;
        runtime = shared;
        return shared;
      },
      runMigrations: async (_db, command) => {
        migrationCommand = command;
        return { command, results: [] };
      },
      startApi: async (options) => {
        seenByApi = options.database;
        expect(options.readiness).toBe(gate);
        expect(options.closeDatabase).toBe(false);
        expect(options.listen).toBe(false);
        const startedApi = {
          app: app,
          database: options.database!,
          listen: async () => { listened = true; },
          stop: async () => { order.push('api'); },
        } as StartedApi;
        return startedApi;
      },
      createWorkerProcess: async (_config, database) => {
        seenByWorker = database;
        return {
          start: async () => {},
          stop: async () => { order.push('worker'); },
        };
      },
      registerShutdown: () => () => {},
    };
    const running = await startSelfHosted(deps);
    expect(migrationCommand).toBe('latest');
    expect(listened).toBe(true);
    expect(seenByApi).toBe(runtime);
    expect(seenByWorker).toBe(runtime);
    expect(seenByApi).not.toBe(migrator);
    expect(migrator.closed()).toBe(true);
    expect(running.config.database.maxConnections).toBe(10);
    expect((await app.inject({ method: 'GET', url: '/ready' })).statusCode).toBe(200);
    await running.stop();
    expect(order).toEqual(['worker', 'api']);
    expect(shared.closed()).toBe(true);
  });

  it('keeps an explicit link-health reserve and rejects a worker reserve above 3', () => {
    const capped = baseEnv();
    applySelfHostedPreset(capped);
    capped.LINK_HEALTH_WORKER_CONCURRENCY = '2';
    const within = loadConfig(capped);
    const over = baseEnv();
    applySelfHostedPreset(over);
    over.LINK_HEALTH_WORKER_CONCURRENCY = '4';
    const tooWide = loadConfig(over);
    const previous = process.env.KNOWN_EDITION;
    process.env.KNOWN_EDITION = 'self-hosted';
    try {
      const capacity = sanitizedRuntimeCapacity(within);
      expect(capacity.database.maxConnections).toBe(10);
      expect(capacity.workerReservedConnections).toBeLessThanOrEqual(3);
      expect(() => sanitizedRuntimeCapacity(tooWide)).toThrow(/exceeds the cap of 3/);
    } finally {
      if (previous === undefined) delete process.env.KNOWN_EDITION;
      else process.env.KNOWN_EDITION = previous;
    }
  });

  it('accepts the loopback http origin used by the local curl', () => {
    const env = baseEnv({
      NODE_ENV: 'test',
      COLP_SERVER_ORIGIN: 'http://127.0.0.1:3000',
    });
    applySelfHostedPreset(env);
    expect(() => loadConfig(env)).not.toThrow();
  });

  it('derives the preset before migrating', async () => {
    const env = baseEnv();
    await expect(startSelfHosted({
      env,
      runMigrations: async () => { throw new Error('stop'); },
      createDatabase: () => fakeDatabase(),
      registerShutdown: () => () => {},
    })).rejects.toThrow(/stop/);
    expect(env.KNOWN_EDITION).toBe('self-hosted');
    expect(env.LINK_HEALTH_WORKER_CONCURRENCY).toBe('2');
    expect(env.DATABASE_URL).toBe('postgres://x');
    expect(createHash('sha256').update(String(env.BETTER_AUTH_SECRET)).digest('hex')).toHaveLength(64);
  });
});
