/**
 * P4A-P10 shared helpers for the recovery/capacity rehearsal suites and the
 * evidence CLI (not a vitest test file).
 *
 * Provides:
 *  - `P10ObjectServer`: a REAL restartable HTTP/1.1 object server with
 *    create-only PUT / conditional HEAD / exact-key DELETE, OPTIONAL
 *    credential (ACL) enforcement for the rotation rehearsal, per-key
 *    fault scripting (429 / 500 / delay) for the provider-transient-429-vs-
 *    policy-drift separation, and a plain HEAD probe for the isolated-origin
 *    availability fact. Stopping the server is the real R2 + origin stop;
 *    restarting it keeps the objects (a real recovery);
 *  - `startP10Postgres` / `startP10Redis`: DEDICATED Testcontainers
 *    PostgreSQL (`postgres:16.4-alpine`, initdb + pg_ctl under a keep-alive
 *    shell so the PG PROCESS can be stopped/restarted) and Redis
 *    (`redis:7-alpine`, daemonized under a keep-alive shell) — the
 *    P4A-RL06 outage pattern; container failures throw (environment
 *    failure, never a skip, plan §4.2.6);
 *  - `createP10MigrationRuntime`: isolated schema + PRODUCTION migration
 *    chain against a caller-provided database URL (the P10 suites own their
 *    PG container, so the env-based i07 runtime does not apply);
 *  - `buildP10Api`: the PRODUCTION API composition (`buildRl04App`) plus a
 *    readiness provider that gathers LIVE facts (admission switch read,
 *    PostgreSQL ping, object-store `probeCapability`, rate-limit facade
 *    verdict, worker telemetry facts, origin HEAD probe) and the
 *    `/ready/features/attachments` capability route (mirror of the
 *    production transport wiring);
 *  - `buildP10Worker`: the PRODUCTION worker composition (verification
 *    route + cleanup + backlog telemetry) with an injectable advancing
 *    clock for the sustained-window alert rehearsal;
 *  - `HttpPitrObjectStore`: the production PITR object-store port over the
 *    real HTTP transport (200/404/403/429/5xx/timeout classification);
 *  - `p10RotationProbeBuilder`: the production credential-rotation probe
 *    over the real credential-enforcing server (ACL change = server-side
 *    credential removal);
 *  - flow helpers (`p10IssuePut`, `p10Complete`, `p10VerifyToStored`,
 *    `p10BacklogSeed`, `p10QuarantineSeed`, `p10DbQueryCounter`,
 *    `p10RedisMemory`, `p10CapacitySampleOf`) and the bounded `waitForP10`
 *    poller.
 *
 * The suites never read `.known-local/phase4a-r2.env`; real R2 is the
 * `evidence:phase4a-p10-recovery` CLI boundary (`local:phase4a-r2:run --
 * p10 confirm-real-r2`).
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import { Redis } from 'ioredis';
import { Pool } from 'pg';
import { createDatabaseRuntime, runMigrations, type DatabaseRuntime } from '../../src/infrastructure/database/index.js';
import { createPostgresAttachmentsAdmissionSwitchStore } from '../../src/infrastructure/database/index.js';
import { waitUntil } from './redis-runtime-test-helpers.js';
import {
  P05_BUCKET,
  P05_COLLECTION,
  createP05ObjectStore,
  makeP05Config,
  p05WorkerEnvironment,
} from './phase4a-p05-test-helpers.js';
import { buildRl04App, rl04CountingClientFactory, type Rl04AppBundle } from './phase4a-rl04-test-helpers.js';
import { composeAttachmentRateLimit } from '../../src/bootstrap/attachments-rate-limit-composition.js';
import { createR2GenerationStore, createGenerationObjectStoreAdapter, type BlobStorePort } from '../../src/infrastructure/object-storage/index.js';
import { createPostgresAttachmentCanonicalMutationPorts, createPostgresAttachmentsPorts, createUnitOfWork } from '../../src/infrastructure/database/index.js';
import { createPostgresAccessPolicyFactsPort } from '../../src/infrastructure/access-policy/index.js';
import { appendAttachmentsVerificationOutbox } from '../../src/infrastructure/outbox/index.js';
import { buildApiApp } from '../../src/transport/app.js';
import { alwaysReady } from '../../src/infrastructure/health.js';
import { P03_ORIGIN, seedP03Collection } from './phase4a-p03-test-helpers.js';
import {
  completeUpload,
  finalizeAttachment,
  issueReplacementIntent,
  issueUploadIntentWithAdmissionGate,
  nodeUploadIntentCrypto,
  readAttachmentStatus,
  retireAttachment,
} from '../../src/modules/attachments/index.js';
import {
  createIdentityMemoryState,
  createIdentityMemoryUnitOfWork,
  issueTestSession,
  type AuthenticatedTestClient,
} from './product-http-harness.js';
import { createInMemoryBetterAuthTestFactory } from './better-auth-test-factory.js';
import { p07Digest, p07Put, p07Headers, type P07IssueResponse } from './phase4a-p07-test-helpers.js';
import type { IdentityUnitOfWork } from '../../src/modules/identity/index.js';
import type { BrowserSessionAuthority } from '../../src/modules/auth/index.js';
import { waitForRealTime, withRealTimeout } from './async-test-helpers.js';
import { buildWorker, type WorkerRuntime } from '../../src/bootstrap/worker.js';
import { loadConfig } from './test-config.js';
import { InMemoryMetrics } from '../../src/infrastructure/telemetry/index.js';
import {
  CAPACITY_NOT_SLO_LIMITATION,
  evaluateAttachmentsCapabilityReadiness,
  parseAttachmentRateLimitKey,
  validateCapacitySample,
  type AttachmentsCapabilityReadiness,
  type AttachmentsFeatureConfig,
  type AttachmentsReadinessFacts,
  type AttachmentAlertConfig,
  type AttachmentCredentialProbe,
  type AttachmentCredentialStoreBuilder,
  type AttachmentCredentialValue,
  type AttachmentRateLimitConfig,
  type CapacitySample,
  type PitrHeadOutcome,
  type PitrObjectStorePort,
} from '../../src/modules/attachments/index.js';

export const P10_PG_IMAGE = process.env.KNOWN_POSTGRES_IMAGE?.trim() || 'postgres:16.4-alpine';
export const P10_REDIS_IMAGE = process.env.KNOWN_REDIS_IMAGE?.trim() || 'redis:7-alpine';
export const P10_ISSUER = 'https://issuer.example';
export const P10_COLLECTION = 'p10-collection';
export const P10_COLLECTION_OTHER = 'p10-collection-other';
export const P10_BODY_SIZE = 8 * 1024;
/** Fixed rehearsal concurrency / instance count (recorded into capacity samples). */
export const P10_CAPACITY_CONCURRENCY = 2;
export const P10_CAPACITY_API_INSTANCES = 1;
/** Distinct rehearsal credential ids for the rotation/ACL rehearsal. */
export const P10_RW_TOKEN = 'p10-rw-credential-token-00000001';
export const P10_RW_TOKEN_NEXT = 'p10-rw-credential-token-00000002';
export const P10_RO_TOKEN = 'p10-ro-credential-token-00000001';

// ---------------------------------------------------------------------------
// Real restartable object server (R2 + isolated-origin surface)
// ---------------------------------------------------------------------------

export interface P10RecordedRequest {
  readonly method: string;
  readonly path: string;
  readonly authorization: string | undefined;
}

/**
 * REAL HTTP object server for the rehearsal: create-only PUT, conditional
 * HEAD, exact-key DELETE, optional credential (ACL) enforcement and per-key
 * fault scripting. `stop()` closes the listener (the real R2/origin stop);
 * `start()` listens again on a fresh port while the objects survive (a real
 * recovery). `requests` records method/path/authorization only — never
 * bodies or credentials beyond the Authorization header presence.
 */
export class P10ObjectServer {
  readonly objects = new Map<string, { etag: string; size: number; body: Buffer }>();
  readonly requests: P10RecordedRequest[] = [];
  /** Exact keys whose HEAD must fail 429 (provider transient marker). */
  readonly head429Keys = new Set<string>();
  /** Exact keys whose HEAD must fail 500 (provider 5xx marker). */
  readonly head500Keys = new Set<string>();
  /** Exact keys whose HEAD is delayed (graceful-close in-flight window). */
  readonly headDelayMs = new Map<string, number>();
  /** ACL: when enforcement is on, only these credential ids pass. */
  readonly validCredentials = new Set<string>();
  enforceCredentials = false;
  url = '';
  private readonly server = createServer((request, response) => {
    void this.handle(request, response);
  });
  private listening = false;
  /** Pinned port so a restart rebinds the SAME endpoint (stores keep working). */
  private port: number | undefined;

  async start(): Promise<string> {
    if (this.listening) return this.url;
    await bindWithRetry(this.server, this.port);
    const address = this.server.address() as AddressInfo;
    this.port = address.port;
    this.url = `http://127.0.0.1:${address.port}`;
    this.listening = true;
    return this.url;
  }

  async stop(): Promise<void> {
    if (!this.listening) return;
    this.server.closeAllConnections?.();
    await new Promise<void>((resolvePromise) => this.server.close(() => resolvePromise()));
    this.listening = false;
  }

  has(key: string): boolean {
    return this.objects.has(key);
  }

  etagOf(key: string): string | undefined {
    return this.objects.get(key)?.etag;
  }

  /** Corrupts the stored object identity (policy-drift rehearsal). */
  corrupt(key: string): void {
    const object = this.objects.get(key);
    assert.ok(object, `corrupt: ${key} must exist`);
    this.objects.set(key, { ...object, etag: `"etag-corrupted-${randomUUID().slice(0, 8)}"`, size: object.size + 1 });
  }

  private authorized(request: { headers: Record<string, string | string[] | undefined> }): boolean {
    if (!this.enforceCredentials) return true;
    const raw = request.headers.authorization;
    const token = typeof raw === 'string' && raw.startsWith('P10Bearer ') ? raw.slice('P10Bearer '.length) : '';
    return this.validCredentials.has(token);
  }

  private async handle(
    request: import('node:http').IncomingMessage,
    response: import('node:http').ServerResponse,
  ): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const segments = url.pathname.split('/').filter(Boolean);
    const key = segments.slice(1).join('/'); // path shape: /<bucket>/<key...>
    const method = request.method ?? '';
    const authorization = typeof request.headers.authorization === 'string'
      ? (request.headers.authorization.startsWith('P10Bearer ') ? 'P10Bearer <redacted>' : 'present')
      : undefined;
    this.requests.push({ method, path: request.url ?? '', authorization });

    // Credential (ACL) gate: when enforcement is on, an unknown credential
    // is denied BEFORE any object work (the rotation rehearsal's real 403).
    if (!this.authorized(request)) {
      response.writeHead(403, { 'Content-Length': '0' });
      response.end();
      return;
    }

    // Plain origin probe: HEAD / is always 200 while the server is up.
    if (method === 'HEAD' && key === '') {
      response.writeHead(200, { 'Content-Length': '0' });
      response.end();
      return;
    }

    if (method === 'PUT') {
      const parts: Buffer[] = [];
      for await (const chunk of request) {
        parts.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const body = Buffer.concat(parts);
      if (this.objects.has(key)) {
        response.writeHead(412, { 'Content-Length': '0' });
        response.end();
        return;
      }
      const etag = `"${createHash('sha256').update(body).digest('hex').slice(0, 32)}"`;
      this.objects.set(key, { etag, size: body.byteLength, body });
      response.writeHead(200, { ETag: etag });
      response.end();
      return;
    }

    if (method === 'GET') {
      // Conditional streamed read for the verification pipeline (I06
      // readBounded): exact-key GET with If-Match, body bytes served.
      const delayMs = this.headDelayMs.get(key);
      if (delayMs !== undefined && delayMs > 0) {
        await waitForRealTime(delayMs, 'inject P10 object-store GET latency');
      }
      const object = this.objects.get(key);
      if (!object) {
        response.writeHead(404, { 'Content-Length': '0' });
        response.end();
        return;
      }
      const ifMatch = request.headers['if-match'];
      if (typeof ifMatch === 'string' && ifMatch !== object.etag) {
        response.writeHead(412, { 'Content-Length': '0' });
        response.end();
        return;
      }
      response.writeHead(200, { ETag: object.etag, 'Content-Length': String(object.size) });
      response.end(object.body);
      return;
    }

    if (method === 'HEAD') {
      if (this.head429Keys.has(key)) {
        response.writeHead(429, { 'Content-Length': '0' });
        response.end();
        return;
      }
      if (this.head500Keys.has(key)) {
        response.writeHead(500, { 'Content-Length': '0' });
        response.end();
        return;
      }
      const delayMs = this.headDelayMs.get(key);
      if (delayMs !== undefined && delayMs > 0) {
        await waitForRealTime(delayMs, 'inject P10 object-store HEAD latency');
      }
      const object = this.objects.get(key);
      if (!object) {
        response.writeHead(404, { 'Content-Length': '0' });
        response.end();
        return;
      }
      const ifMatch = request.headers['if-match'];
      if (typeof ifMatch === 'string' && ifMatch !== object.etag) {
        response.writeHead(412, { 'Content-Length': '0' });
        response.end();
        return;
      }
      response.writeHead(200, { ETag: object.etag, 'Content-Length': String(object.size) });
      response.end();
      return;
    }

    if (method === 'DELETE') {
      const deleted = this.objects.delete(key);
      response.writeHead(deleted ? 204 : 404, { 'Content-Length': '0' });
      response.end();
      return;
    }

    response.writeHead(405, { 'Content-Length': '0' });
    response.end();
  }
}

// ---------------------------------------------------------------------------
// Dedicated PostgreSQL + Redis containers (stop/start the real processes)
// ---------------------------------------------------------------------------

export interface P10PostgresHandle {
  readonly container: StartedTestContainer;
  readonly url: string;
  stop(): Promise<void>;
  start(): Promise<void>;
}

/** Dedicated PG: initdb + pg_ctl under a keep-alive shell (process restarts). */
export async function startP10Postgres(): Promise<P10PostgresHandle> {
  let container: StartedTestContainer;
  try {
    container = await new GenericContainer(P10_PG_IMAGE)
      .withExposedPorts(5432)
      .withUser('postgres')
      .withCommand(['sh', '-c',
        // initdb only writes pg_hba entries for localhost by default; the
        // host probe arrives via the Docker bridge (172.17.0.1), so the
        // trust rule for ALL host addresses must be appended explicitly.
        '[ -f "$PGDATA/PG_VERSION" ] || { initdb -U postgres --auth=trust -D "$PGDATA"; '
        + 'echo "host all all 0.0.0.0/0 trust" >> "$PGDATA/pg_hba.conf"; }; '
        + 'pg_ctl -D "$PGDATA" -o "-c listen_addresses=\'*\' -p 5432" -w start; '
        + 'while true; do sleep 3600; done'])
      .withStartupTimeout(180_000)
      .start();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `P4A-P10 fail-closed: could not start a dedicated PostgreSQL container (image ${P10_PG_IMAGE}). `
        + `The rehearsal requires Docker/Testcontainers: ${detail}`,
    );
  }
  const url = `postgresql://postgres@127.0.0.1:${container.getMappedPort(5432)}/postgres`;
  const probe = new Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 5_000 });
  try {
    await waitUntil(async () => {
      try { await probe.query('select 1 as ok'); return true; } catch { return false; }
    }, 60_000, 'dedicated postgres ready', 250);
  } finally {
    await probe.end().catch(() => undefined);
  }
  const execPg = async (args: string[]): Promise<void> => {
    const result = await container.exec(args, { user: 'postgres' });
    if (result.exitCode !== 0) {
      throw new Error(`pg_ctl failed: ${result.stderr || result.output}`);
    }
  };
  return {
    container,
    url,
    async stop() {
      await execPg(['pg_ctl', '-D', '/var/lib/postgresql/data', '-m', 'fast', '-w', 'stop']);
    },
    async start() {
      await execPg(['pg_ctl', '-D', '/var/lib/postgresql/data', '-o', "-c listen_addresses='*' -p 5432", '-w', 'start']);
      const barrier = new Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 5_000 });
      try {
        await waitUntil(async () => {
          try { await barrier.query('select 1 as ok'); return true; } catch { return false; }
        }, 60_000, 'postgres restarted', 250);
      } finally {
        await barrier.end().catch(() => undefined);
      }
    },
  };
}

export interface P10RedisHandle {
  readonly container: StartedTestContainer;
  readonly url: string;
  stop(): Promise<void>;
  start(): Promise<void>;
}

/** Dedicated Redis: daemonized redis-server under a keep-alive shell. */
export async function startP10Redis(): Promise<P10RedisHandle> {
  let container: StartedTestContainer;
  try {
    container = await new GenericContainer(P10_REDIS_IMAGE)
      .withExposedPorts(6379)
      .withCommand(['sh', '-c', 'redis-server --daemonize yes; while true; do sleep 3600; done'])
      .withStartupTimeout(120_000)
      .start();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `P4A-P10 fail-closed: could not start a dedicated Redis container (image ${P10_REDIS_IMAGE}). `
        + `The rehearsal requires Docker/Testcontainers: ${detail}`,
    );
  }
  const url = `redis://127.0.0.1:${container.getMappedPort(6379)}`;
  const raw = new Redis(url);
  try {
    await waitUntil(async () => {
      try { return (await raw.ping()) === 'PONG'; } catch { return false; }
    }, 15_000, 'dedicated redis ready', 50);
  } finally {
    await raw.quit().catch(() => undefined);
  }
  return {
    container,
    url,
    async stop() {
      const result = await container.exec(['redis-cli', 'shutdown', 'nosave']);
      if (result.exitCode !== 0) throw new Error(`redis-cli shutdown failed: ${result.output}`);
    },
    async start() {
      const result = await container.exec(['redis-server', '--daemonize', 'yes']);
      if (result.exitCode !== 0) throw new Error(`redis-server restart failed: ${result.output}`);
      const raw2 = new Redis(url);
      try {
        await waitUntil(async () => {
          try { return (await raw2.ping()) === 'PONG'; } catch { return false; }
        }, 15_000, 'redis restarted', 50);
      } finally {
        await raw2.quit().catch(() => undefined);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Isolated migration runtime (caller-provided database URL)
// ---------------------------------------------------------------------------

export interface P10MigrationRuntime {
  readonly schema: string;
  readonly databaseUrl: string;
  readonly runtime: DatabaseRuntime;
  closeKeepSchema(): Promise<void>;
  dropSchema(): Promise<void>;
}

export async function createP10MigrationRuntime(
  databaseUrl: string,
  prefix: string,
): Promise<P10MigrationRuntime> {
  assert.match(prefix, /^[a-z][a-z0-9_]*$/, 'schema prefix must be a safe identifier fragment');
  const schema = `${prefix}_${randomUUID().replaceAll('-', '_')}`;
  const administrator = new Pool({ connectionString: databaseUrl, max: 1 });
  // The suite stops/restarts the real PostgreSQL process; an idle
  // administrator client terminated by the outage would otherwise raise an
  // unhandled 'error' event on the pool and crash the whole run.
  administrator.on('error', () => undefined);
  await administrator.query(`create schema ${schema}`);
  const isolatedUrl = new URL(databaseUrl);
  isolatedUrl.searchParams.set('options', `-c search_path=${schema}`);
  const runtime = createDatabaseRuntime(isolatedUrl.toString(), {
    maxConnections: 16,
    applicationName: `known-p10-${prefix}`,
    connectionTimeoutMs: 5_000,
    idleTimeoutMs: 1_000,
    statementTimeoutMs: 30_000,
  });
  await runMigrations(runtime.db, 'latest');
  let closed = false;
  return {
    schema,
    databaseUrl: isolatedUrl.toString(),
    runtime,
    async closeKeepSchema() {
      if (closed) return;
      closed = true;
      await runtime.close();
    },
    async dropSchema() {
      if (!closed) await runtime.close();
      await administrator.query(`drop schema if exists ${schema} cascade`);
      await administrator.end();
    },
  };
}

/**
 * Binds the server, reusing the pinned port after a restart (the store
 * endpoints must keep pointing at the same URL). Retries briefly on
 * EADDRINUSE so a just-freed port is reliably rebindable.
 */
async function bindWithRetry(
  server: ReturnType<typeof createServer>,
  port: number | undefined,
): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await new Promise<void>((resolvePromise, rejectPromise) => {
        const onError = (error: Error): void => rejectPromise(error);
        server.once('error', onError);
        server.listen(port ?? 0, '127.0.0.1', () => {
          server.removeListener('error', onError);
          resolvePromise();
        });
      });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EADDRINUSE') throw error;
      await waitForRealTime(250, 'back off before rebinding the P10 server port');
    }
  }
  throw new Error('p10 object server could not rebind its pinned port');
}

// ---------------------------------------------------------------------------
// Dedicated origin probe server (isolated delivery host boundary)
// ---------------------------------------------------------------------------

/**
 * A REAL tiny HTTP server standing in for the isolated delivery origin: a
 * plain `HEAD /` probe answers 200 while the origin is up. Stopping it is
 * the real origin stop (independent from the object store), so the
 * rehearsal can stop R2 and origin separately.
 */
export class P10OriginServer {
  url = '';
  readonly probeRequests: number[] = [];
  private readonly server = createServer((request, response) => {
    if (request.method === 'HEAD' && new URL(request.url ?? '/', 'http://x').pathname === '/') {
      this.probeRequests.push(Date.now());
      response.writeHead(200, { 'Content-Length': '0' });
      response.end();
      return;
    }
    response.writeHead(404, { 'Content-Length': '0' });
    response.end();
  });
  private listening = false;
  private port: number | undefined;

  async start(): Promise<string> {
    if (this.listening) return this.url;
    await bindWithRetry(this.server, this.port);
    const address = this.server.address() as AddressInfo;
    this.port = address.port;
    this.url = `http://127.0.0.1:${address.port}`;
    this.listening = true;
    return this.url;
  }

  async stop(): Promise<void> {
    if (!this.listening) return;
    this.server.closeAllConnections?.();
    await new Promise<void>((resolvePromise) => this.server.close(() => resolvePromise()));
    this.listening = false;
  }
}

/** Real origin availability probe: HEAD the origin root (200 while up). */
export function p10OriginProbe(origin: P10OriginServer): () => Promise<boolean> {
  return async () => {
    const response = await fetch(`${origin.url}/`, {
      method: 'HEAD',
      signal: AbortSignal.timeout(3_000),
    });
    return response.status === 200;
  };
}

// ---------------------------------------------------------------------------
// Suite environment
// ---------------------------------------------------------------------------

export interface P10SuiteEnv {
  readonly postgres: P10PostgresHandle;
  readonly redis: P10RedisHandle;
  readonly raw: Redis;
  readonly redisUrl: string;
  readonly isolated: P10MigrationRuntime;
  readonly objectServer: P10ObjectServer;
  readonly originServer: P10OriginServer;
  readonly identityUnitOfWork: IdentityUnitOfWork;
  readonly factory: ReturnType<typeof createInMemoryBetterAuthTestFactory>;
  readonly owner: AuthenticatedTestClient;
  readonly other: AuthenticatedTestClient;
  readonly probe: AuthenticatedTestClient;
  dropSchema(): Promise<void>;
  stop(): Promise<void>;
}

export async function startP10SuiteEnv(): Promise<P10SuiteEnv> {
  const postgres = await startP10Postgres();
  const redis = await startP10Redis();
  const raw = new Redis(redis.url);
  try {
    await waitUntil(async () => {
      try { return (await raw.ping()) === 'PONG'; } catch { return false; }
    }, 15_000, 'suite redis ping', 50);
  } catch (error) {
    await raw.quit().catch(() => undefined);
    await postgres.container.stop().catch(() => undefined);
    await redis.container.stop().catch(() => undefined);
    throw error;
  }
  const isolated = await createP10MigrationRuntime(postgres.url, 'phase4a_p10');
  const identityUnitOfWork = createIdentityMemoryUnitOfWork(
    createIdentityMemoryState(new Date('2026-08-10T12:00:00.000Z')),
  );
  const factory = createInMemoryBetterAuthTestFactory({ identityUnitOfWork });
  const owner = await issueTestSession({ factory, subject: 'p10-owner', handle: 'p10_owner' });
  const other = await issueTestSession({ factory, subject: 'p10-other', handle: 'p10_other' });
  const probe = await issueTestSession({ factory, subject: 'p10-probe', handle: 'p10_probe' });
  await seedP03Collection(isolated.runtime, {
    collectionId: P10_COLLECTION,
    ownerSubjectId: owner.subjectId,
    members: [
      { subjectId: owner.subjectId, role: 'owner' },
      { subjectId: other.subjectId, role: 'viewer' },
      { subjectId: probe.subjectId, role: 'viewer' },
    ],
  });
  await seedP03Collection(isolated.runtime, {
    collectionId: P10_COLLECTION_OTHER,
    ownerSubjectId: other.subjectId,
    members: [{ subjectId: other.subjectId, role: 'owner' }],
  });
  const objectServer = new P10ObjectServer();
  await objectServer.start();
  const originServer = new P10OriginServer();
  await originServer.start();
  return {
    postgres, redis, raw, redisUrl: redis.url, isolated, objectServer, originServer,
    identityUnitOfWork, factory, owner, other, probe,
    async dropSchema() { await isolated.dropSchema(); },
    async stop() {
      await objectServer.stop();
      await originServer.stop();
      await raw.quit().catch(() => raw.disconnect());
      await postgres.container.stop();
      await redis.container.stop();
    },
  };
}

// ---------------------------------------------------------------------------
// API composition + live readiness provider
// ---------------------------------------------------------------------------

export interface P10ApiBundle {
  readonly name: string;
  readonly bundle: Rl04AppBundle;
  readonly app: FastifyInstance;
  /** Live readiness facts from REAL probes (PG ping, R2 probe, Redis verdict, origin HEAD). */
  readonly facts: () => Promise<AttachmentsReadinessFacts>;
  /** The production evaluator over the live facts. */
  readonly readiness: () => Promise<AttachmentsCapabilityReadiness>;
  readonly close: () => Promise<void>;
}

export interface BuildP10ApiOptions {
  readonly name: string;
  readonly runtime: P10MigrationRuntime;
  readonly databaseUrl: string;
  readonly identityUnitOfWork: IdentityUnitOfWork;
  /** E1: Better Auth session authority (test factory); absent keeps legacy auth. */
  readonly browserSessionAuthority?: BrowserSessionAuthority;
  readonly objectServerUrl: string;
  readonly attachmentsConfig: AttachmentsFeatureConfig;
  readonly rateLimitConfig: AttachmentRateLimitConfig;
  readonly keySecret: Buffer;
  /** Worker telemetry facts; undefined/throws while the worker is stopped. */
  readonly workerFacts: () => Promise<AttachmentsReadinessFacts | undefined>;
  /** Origin availability probe (real HEAD against the delivery host). */
  readonly deliveryProbe: () => Promise<boolean>;
}

export async function buildP10Api(options: BuildP10ApiOptions): Promise<P10ApiBundle> {
  const bundle = await buildRl04App({
    runtime: options.runtime,
    databaseUrl: options.databaseUrl,
    identityUnitOfWork: options.identityUnitOfWork,
    ...(options.browserSessionAuthority === undefined
      ? {}
      : { browserSessionAuthority: options.browserSessionAuthority }),
    objectServerUrl: options.objectServerUrl,
    attachmentsConfig: options.attachmentsConfig,
    rateLimitConfig: options.rateLimitConfig,
    keySecret: options.keySecret,
  });
  // Health barrier (plan §4.2 anti-false-negative; never a fixed sleep): the
  // limiter client connects lazily (`lazyConnect` + `enableOfflineQueue:
  // false`), so the suite waits for a REAL healthy verdict before the first
  // admission — a first request must never race the connect and produce a
  // spurious 503.
  await waitUntil(async () => bundle.rateLimit.readiness().status === 'healthy',
    30_000, 'p10 limiter connect ready', 50);
  const switchStore = createPostgresAttachmentsAdmissionSwitchStore(options.runtime.runtime);

  const facts = async (): Promise<AttachmentsReadinessFacts> => {
    let admission: { enabled: boolean } | undefined;
    let database: { status: 'healthy' | 'degraded' } | undefined;
    try {
      const state = await switchStore.read();
      admission = { enabled: state.admissionEnabled };
      database = { status: 'healthy' };
    } catch {
      database = { status: 'degraded' };
    }
    let objectStore: { status: 'healthy' | 'degraded' } | undefined;
    try {
      await bundle.bundle.store.probeCapability();
      objectStore = { status: 'healthy' };
    } catch {
      objectStore = { status: 'degraded' };
    }
    // Composition readiness (RL02 policy verdict): degraded + enforce+required
    // -> blocksAttachments (the facade's store-level readiness has no policy
    // verdict; the production bootstrap wiring uses the composition too).
    const rateLimitVerdict = bundle.rateLimit.readiness();
    let worker: AttachmentsReadinessFacts['worker'];
    try {
      const workerFacts = await options.workerFacts();
      if (workerFacts?.worker !== undefined) worker = workerFacts.worker;
    } catch {
      worker = undefined;
    }
    let delivery: { hostAvailable: boolean } | undefined;
    try {
      delivery = { hostAvailable: await options.deliveryProbe() };
    } catch {
      delivery = { hostAvailable: false };
    }
    return {
      ...(admission === undefined ? {} : { admission }),
      ...(database === undefined ? {} : { database }),
      ...(objectStore === undefined ? {} : { objectStore }),
      ...(worker === undefined ? {} : { worker }),
      ...(delivery === undefined ? {} : { delivery }),
      rateLimit: {
        status: rateLimitVerdict.status,
        blocksAttachments: rateLimitVerdict.blocksAttachments,
      },
    };
  };

  const readiness = async (): Promise<AttachmentsCapabilityReadiness> =>
    evaluateAttachmentsCapabilityReadiness(options.attachmentsConfig, await facts());

  // Mirror of the production transport wiring (/ready/features/attachments).
  bundle.bundle.app.get('/ready/features/attachments', {
    config: { productTransport: { allowedQuery: [], cacheControl: 'no-store' } },
  }, async (_request, reply) => {
    const result = await readiness().catch(() => ({
      capability: 'attachments' as const, status: 'not-ready' as const,
      reason: 'dependency_unavailable' as const,
    }));
    return reply.code(result.status === 'ready' ? 200 : 503).send(result);
  });

  return {
    name: options.name,
    bundle,
    app: bundle.bundle.app,
    facts,
    readiness,
    close: () => bundle.close(),
  };
}

// ---------------------------------------------------------------------------
// Worker composition + advancing clock
// ---------------------------------------------------------------------------

/** Mutable clock: each `now()` call advances the rehearsed timeline. */
export class P10AdvancingClock {
  private at: Date;
  constructor(startIso: string, private readonly stepMs: number) {
    this.at = new Date(startIso);
  }

  now(): Date {
    const current = this.at;
    this.at = new Date(current.getTime() + this.stepMs);
    return current;
  }

  current(): Date {
    return this.at;
  }
}

export interface P10WorkerBundle {
  readonly worker: WorkerRuntime;
  readonly metrics: InMemoryMetrics;
  readonly clock: P10AdvancingClock;
  start(): Promise<void>;
  stop(): Promise<void>;
}

/**
 * The production worker closes its OWN database runtime on `stop()`. In the
 * P10 rehearsal the database runtime is SUITE-owned (the API, the PITR
 * ledger and the backlog observers share it), and the recovery order
 * stops/restarts the SAME worker — so the runtime handed to the worker is a
 * thin proxy whose `close()` is a no-op. All queries still go to the real
 * pool; only the worker-owned close is neutralized (the suite drops the
 * schema and stops the containers itself).
 */
function p10WorkerDatabaseRuntime(isolated: P10MigrationRuntime): DatabaseRuntime {
  return new Proxy(isolated.runtime, {
    get(target, property, receiver) {
      if (property === 'close') {
        return async () => undefined;
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as DatabaseRuntime;
}

/**
 * Restores every restartable dependency after a test (health-barrier style,
 * no fixed sleeps): the object/origin servers, then Redis (real ping with a
 * bounded race) and PostgreSQL (real `select 1` with a bounded race) when
 * they are down — a failed test may leave a dependency stopped, and the
 * next test must start from a healthy suite env (anti-false-negative).
 */
export async function restoreP10Dependencies(env: P10SuiteEnv): Promise<void> {
  await env.objectServer.start();
  await env.originServer.start();
  const ping = await withRealTimeout(
    env.raw.ping().then(() => true).catch(() => false),
    3_000,
    'Redis health probe timed out while restoring P10 dependencies',
  ).catch(() => false);
  if (!ping) await env.redis.start();
  const dbUp = await withRealTimeout(
    env.isolated.runtime.pool.query('select 1 as ok').then(() => true).catch(() => false),
    6_000,
    'PostgreSQL health probe timed out while restoring P10 dependencies',
  ).catch(() => false);
  if (!dbUp) await env.postgres.start();
}

/**
 * PRODUCTION worker composition (verification route + cleanup + backlog
 * telemetry) with an advancing clock for the sustained-window alert
 * rehearsal, a short telemetry interval and a fast drain profile (large
 * batch / concurrency, short poll) so real pending rows converge quickly.
 */
export function buildP10Worker(
  isolated: P10MigrationRuntime,
  objectServer: P10ObjectServer,
  options: {
    readonly alertConfig?: AttachmentAlertConfig;
    readonly clockStepMs?: number;
    /** Store override: the evidence CLI verifies against REAL R2 in real mode. */
    readonly objectStore?: BlobStorePort;
  } = {},
): P10WorkerBundle {
  const clock = new P10AdvancingClock('2026-08-10T12:00:00.000Z', options.clockStepMs ?? 60_000);
  const config = loadConfig({
    ...p05WorkerEnvironment(isolated.databaseUrl),
    // Fast drain profile (large batch / concurrency, short poll) while
    // respecting the production invariant WORKER_BATCH_SIZE <= WORKER_CONCURRENCY.
    WORKER_BATCH_SIZE: '8',
    WORKER_CONCURRENCY: '8',
    WORKER_POLL_INTERVAL_MS: '25',
    // Real-R2 mode (injected store): the verification read window and the
    // outbox handler budget must cover real provider round trips (the P05
    // env is tuned for the local object server).
    ...(options.objectStore === undefined ? {} : {
      ATTACHMENTS_VERIFICATION_LEASE_MS: '120000',
      ATTACHMENTS_VERIFICATION_TIMEOUT_MS: '30000',
      ATTACHMENTS_VERIFICATION_RETRY_COUNT: '1',
      // Production invariant: handler deadlines must fit inside the row lease.
      WORKER_LEASE_DURATION_MS: '120000',
      WORKER_HEARTBEAT_INTERVAL_MS: '5000',
      WORKER_HANDLER_TIMEOUT_MS: '60000',
    }),
  });
  assert.ok(config.attachments, 'attachments must be enabled in the worker env');
  const metrics = new InMemoryMetrics();
  const store = options.objectStore ?? createP05ObjectStore(objectServer.url, makeP05Config());
  const runtime = buildWorker(config, p10WorkerDatabaseRuntime(isolated), metrics, {
    attachmentsObjectStorage: store,
    attachmentsCleanupIntervalMs: 60_000,
    attachmentsTelemetryIntervalMs: 100,
    attachmentsNow: () => clock.now(),
    ...(options.alertConfig === undefined ? {} : { attachmentsAlertConfig: options.alertConfig }),
  });
  assert.ok(runtime.attachments, 'attachments worker surface must be composed');
  return {
    worker: runtime,
    metrics,
    clock,
    start: () => runtime.start(),
    stop: () => runtime.stop(),
  };
}

// ---------------------------------------------------------------------------
// PITR object-store port over the real HTTP transport
// ---------------------------------------------------------------------------

export class HttpPitrObjectStore implements PitrObjectStorePort {
  constructor(
    private readonly serverUrl: string,
    private readonly bucket: string,
  ) {}

  async headExact(handle: { generationId: string; key: string }): Promise<PitrHeadOutcome> {
    try {
      const response = await fetch(`${this.serverUrl}/${this.bucket}/${handle.key}`, {
        method: 'HEAD',
        signal: AbortSignal.timeout(10_000),
      });
      if (response.status === 200) {
        const etag = response.headers.get('etag') ?? '';
        const size = Number(response.headers.get('content-length') ?? '0');
        return { class: 'ok', etag, size: Number.isFinite(size) ? size : 0 };
      }
      if (response.status === 404) return { class: 'not_found' };
      if (response.status === 403) return { class: 'denied' };
      if (response.status === 429 || response.status >= 500) return { class: 'retryable' };
      return { class: 'unknown' };
    } catch (error) {
      if (error instanceof DOMException && error.name === 'TimeoutError') return { class: 'retryable' };
      return { class: 'unknown' };
    }
  }
}

// ---------------------------------------------------------------------------
// Evidence-mode API composition (configurable store endpoint/credentials)
// ---------------------------------------------------------------------------

/** Store binding for the evidence composition (real R2 or local server). */
export interface P10EvidenceStoreBinding {
  readonly endpoint: string;
  readonly bucket: string;
  readonly livePrefix: string;
  readonly probePrefix: string;
  readonly rwCredential: { readonly accessKeyId: string; readonly secretAccessKey: string };
  readonly roCredential: { readonly accessKeyId: string; readonly secretAccessKey: string };
}

/**
 * Builds the PRODUCTION R2 adapter for an evidence store binding (real R2
 * or the local object server).
 */
export function buildP10EvidenceStore(binding: P10EvidenceStoreBinding): import('../../src/infrastructure/object-storage/index.js').BlobStorePort {
  return createR2GenerationStore({
    endpoint: binding.endpoint,
    region: 'auto',
    bucket: binding.bucket,
    livePrefix: binding.livePrefix,
    probePrefix: binding.probePrefix,
    rwCredential: binding.rwCredential,
    roCredential: binding.roCredential,
    grantTtlSeconds: 60,
    singlePutMaxBytes: 5 * 1024 * 1024,
  });
}

/**
 * The PRODUCTION API wiring (routes + admission gate + rate-limit facade)
 * with a CONFIGURABLE object-store binding, so the evidence CLI can point
 * the product flow at real Cloudflare R2 (fresh prefix) or the local object
 * server. Mirrors `buildRl04App` but replaces the hardcoded P03 store
 * binding with the injected one.
 */
export async function buildP10EvidenceApi(options: {
  readonly name: string;
  readonly runtime: P10MigrationRuntime;
  readonly databaseUrl: string;
  readonly identityUnitOfWork: IdentityUnitOfWork;
  /** E1: Better Auth session authority (test factory); absent keeps legacy auth. */
  readonly browserSessionAuthority?: BrowserSessionAuthority;
  readonly attachmentsConfig: AttachmentsFeatureConfig;
  readonly rateLimitConfig: AttachmentRateLimitConfig;
  readonly keySecret: Buffer;
  readonly store: P10EvidenceStoreBinding;
  /** Pre-built store override (the evidence CLI counts real-R2 calls). */
  readonly prebuiltStore?: BlobStorePort;
  readonly workerFacts: () => Promise<AttachmentsReadinessFacts | undefined>;
  readonly deliveryProbe: () => Promise<boolean>;
}): Promise<P10ApiBundle> {
  const logEntries: Array<import('../../src/modules/attachments/index.js').AttachmentRateLimitLogEntry> = [];
  const metrics = new InMemoryMetrics();
  const counting = rl04CountingClientFactory();
  const rateLimit = await composeAttachmentRateLimit({
    config: options.rateLimitConfig,
    environment: 'test',
    resolveKeySecret: async () => options.keySecret,
    metrics,
    logger: (entry) => logEntries.push(entry),
    createClient: counting.factory,
  });
  // Health barrier: the lazy-connecting limiter must be healthy before the
  // first admission (the first request must never race the Redis connect).
  await waitUntil(async () => rateLimit.readiness().status === 'healthy',
    30_000, 'p10 evidence limiter connect ready', 50);
  const store = options.prebuiltStore ?? createR2GenerationStore({
    endpoint: options.store.endpoint,
    region: 'auto',
    bucket: options.store.bucket,
    livePrefix: options.store.livePrefix,
    probePrefix: options.store.probePrefix,
    rwCredential: options.store.rwCredential,
    roCredential: options.store.roCredential,
    grantTtlSeconds: options.attachmentsConfig.grantTtlSeconds,
    singlePutMaxBytes: options.attachmentsConfig.singlePutMaxBytes,
  });
  const moduleStore = createGenerationObjectStoreAdapter(store);
  const ledger = createPostgresAttachmentsPorts();
  const uow = createUnitOfWork(options.runtime.runtime.db);
  const attachmentsConfig = options.attachmentsConfig;
  const config = loadConfig({
    DATABASE_URL: options.databaseUrl,
    NODE_ENV: 'test',
    PRODUCT_ORIGIN: P03_ORIGIN,
    ALLOWED_ORIGINS: P03_ORIGIN,
    OIDC_ALLOW_TEST_PROVIDER: 'true',
    OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default',
    LOG_LEVEL: 'silent',
  });
  const routeDeps: import('../../src/transport/product/attachment-routes.js').AttachmentRoutesDependencies = {
    config,
    identityUnitOfWork: options.identityUnitOfWork,
    attachments: {
      issue: (input) => issueUploadIntentWithAdmissionGate({
        ledger,
        accessPolicyFor: (transaction) => createPostgresAccessPolicyFactsPort(transaction),
        blobStore: store,
        uow,
        crypto: nodeUploadIntentCrypto,
        config: attachmentsConfig,
        admissionState: () => createPostgresAttachmentsAdmissionSwitchStore(options.runtime.runtime).read(),
      }, input),
      complete: (input) => completeUpload({
        ledger,
        blobStore: moduleStore,
        uow,
        enqueueVerification: async (transaction, payload) => {
          await appendAttachmentsVerificationOutbox(transaction, payload);
        },
        config: attachmentsConfig,
      }, input),
      status: (input) => readAttachmentStatus({
        ledger,
        accessPolicyFor: (transaction) => createPostgresAccessPolicyFactsPort(transaction),
        uow,
      }, input),
      finalize: (input) => finalizeAttachment({
        ledger,
        canonical: createPostgresAttachmentCanonicalMutationPorts(),
        accessPolicyFor: (transaction) => createPostgresAccessPolicyFactsPort(transaction),
        uow,
      }, input),
      replacement: (input) => issueReplacementIntent({
        ledger,
        accessPolicyFor: (transaction) => createPostgresAccessPolicyFactsPort(transaction),
        blobStore: store,
        uow,
        crypto: nodeUploadIntentCrypto,
        config: attachmentsConfig,
      }, input),
      retire: (input) => retireAttachment({
        ledger,
        canonical: createPostgresAttachmentCanonicalMutationPorts(),
        accessPolicyFor: (transaction) => createPostgresAccessPolicyFactsPort(transaction),
        uow,
      }, input),
      rateLimit: rateLimit.facade,
    },
  };
  const app = buildApiApp({
    config,
    readiness: alwaysReady,
    identityUnitOfWork: options.identityUnitOfWork,
    ...(options.browserSessionAuthority === undefined
      ? {}
      : { browserSessionAuthority: options.browserSessionAuthority }),
    attachmentRoutes: routeDeps,
  });
  const switchStore = createPostgresAttachmentsAdmissionSwitchStore(options.runtime.runtime);
  const facts = async (): Promise<AttachmentsReadinessFacts> => {
    let admission: { enabled: boolean } | undefined;
    let database: { status: 'healthy' | 'degraded' } | undefined;
    try {
      const state = await switchStore.read();
      admission = { enabled: state.admissionEnabled };
      database = { status: 'healthy' };
    } catch {
      database = { status: 'degraded' };
    }
    let objectStore: { status: 'healthy' | 'degraded' } | undefined;
    try {
      await store.probeCapability();
      objectStore = { status: 'healthy' };
    } catch {
      objectStore = { status: 'degraded' };
    }
    // Composition readiness (policy verdict with blocksAttachments; the
    // facade's store-level readiness carries no policy).
    const rateLimitVerdict = rateLimit.readiness();
    let worker: AttachmentsReadinessFacts['worker'];
    try {
      const workerFacts = await options.workerFacts();
      if (workerFacts?.worker !== undefined) worker = workerFacts.worker;
    } catch {
      worker = undefined;
    }
    let delivery: { hostAvailable: boolean } | undefined;
    try {
      delivery = { hostAvailable: await options.deliveryProbe() };
    } catch {
      delivery = { hostAvailable: false };
    }
    return {
      ...(admission === undefined ? {} : { admission }),
      ...(database === undefined ? {} : { database }),
      ...(objectStore === undefined ? {} : { objectStore }),
      ...(worker === undefined ? {} : { worker }),
      ...(delivery === undefined ? {} : { delivery }),
      rateLimit: { status: rateLimitVerdict.status, blocksAttachments: rateLimitVerdict.blocksAttachments },
    };
  };
  const readiness = async (): Promise<AttachmentsCapabilityReadiness> =>
    evaluateAttachmentsCapabilityReadiness(attachmentsConfig, await facts());
  app.get('/ready/features/attachments', {
    config: { productTransport: { allowedQuery: [], cacheControl: 'no-store' } },
  }, async (_request, reply) => {
    const result = await readiness().catch(() => ({
      capability: 'attachments' as const, status: 'not-ready' as const,
      reason: 'dependency_unavailable' as const,
    }));
    return reply.code(result.status === 'ready' ? 200 : 503).send(result);
  });
  return {
    name: options.name,
    bundle: {
      bundle: { app, store, config } as unknown as Rl04AppBundle['bundle'],
      rateLimit,
      counts: counting.counts,
      logEntries,
      metrics,
      downloadCalls: () => 0,
      facade: rateLimit.facade,
      close: async () => {
        await app.close();
        await store.close();
        await rateLimit.close();
      },
    } as Rl04AppBundle,
    app,
    facts,
    readiness,
    close: async () => {
      await app.close();
      await store.close();
      await rateLimit.close();
    },
  };
}

// ---------------------------------------------------------------------------
// Rotation probe over the credential-enforcing server (ACL change = server)
// ---------------------------------------------------------------------------

/** Builds the production rotation probe bound to the P10 object server. */
export function p10RotationProbeBuilder(server: P10ObjectServer): AttachmentCredentialStoreBuilder {
  return {
    build(_role: string, _credential: AttachmentCredentialValue): AttachmentCredentialProbe {
      return {
        async probe(_role, credential) {
          const token = credential.kind === 's3' ? credential.accessKeyId : credential.token;
          try {
            const response = await fetch(`${server.url}/p10/rotation-probe`, {
              method: 'HEAD',
              headers: { authorization: `P10Bearer ${token}` },
              signal: AbortSignal.timeout(5_000),
            });
            if (response.status === 200 || response.status === 404) return { ok: true, detail: 'ok' };
            if (response.status === 403) return { ok: false, detail: 'denied' };
            if (response.status === 429) return { ok: false, detail: 'provider_retryable' };
            if (response.status >= 500) return { ok: false, detail: 'provider_5xx' };
            return { ok: false, detail: 'unknown' };
          } catch (error) {
            if (error instanceof DOMException && error.name === 'TimeoutError') {
              return { ok: false, detail: 'timeout' };
            }
            return { ok: false, detail: 'unknown' };
          }
        },
      };
    },
  };
}

/** Production admission-switch deps over the real PostgreSQL store. */
export function p10AdmissionSwitchDeps(runtime: DatabaseRuntime): {
  readonly store: import('../../src/modules/attachments/index.js').AttachmentsAdmissionSwitchStore;
  readonly now: () => Date;
} {
  return {
    store: createPostgresAttachmentsAdmissionSwitchStore(runtime),
    now: () => new Date(),
  };
}

// ---------------------------------------------------------------------------
// Flow helpers (production HTTP issue -> independent PUT -> complete)
// ---------------------------------------------------------------------------

export function p10Body(slot: number): Uint8Array {
  const body = new Uint8Array(P10_BODY_SIZE);
  // Real PNG magic so the declared image/png media type matches the sniffed
  // category (unknown/suspicious bytes would not match, p08 precedent).
  body.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  for (let index = 8; index < body.length; index += 1) body[index] = (index + slot) % 251;
  return body;
}

export async function p10Issue(
  api: P10ApiBundle,
  client: AuthenticatedTestClient,
  commandId: string,
  collectionId: string,
  body: Uint8Array,
): Promise<{ statusCode: number; body: string }> {
  return api.app.inject({
    method: 'POST',
    url: '/api/v1/attachments/issue',
    headers: p07Headers(client, commandId),
    payload: JSON.stringify({
      collectionId,
      declaredSize: body.byteLength,
      declaredSha256: p07Digest(body),
      mediaHint: 'image/png',
      expectedPolicyRevision: null,
    }),
  });
}

/** issue (201) + independent PUT; returns the receipt, grant and etag. */
export async function p10IssuePut(
  api: P10ApiBundle,
  client: AuthenticatedTestClient,
  collectionId: string,
  body: Uint8Array,
): Promise<{ receipt: { blobId: string; intentId: string; generationId: string }; key: string; etag: string }> {
  const issued = await p10Issue(api, client, randomUUID(), collectionId, body);
  assert.equal(issued.statusCode, 201, `p10 issue: ${issued.body}`);
  const parsed = JSON.parse(issued.body) as P07IssueResponse;
  const put = await p07Put(parsed.grant.url, body);
  const key = p07KeyFromGrantUrl(parsed.grant.url);
  return { receipt: parsed.receipt, key, etag: put.etag };
}

/** p07 helper re-export (path shape): extract the physical key from a grant URL. */
export function p07KeyFromGrantUrl(grantUrl: string): string {
  const url = new URL(grantUrl);
  return url.pathname.split('/').filter(Boolean).slice(1).join('/');
}

export async function p10Complete(
  api: P10ApiBundle,
  client: AuthenticatedTestClient,
  binding: { blobId: string; intentId: string; generationId: string },
  body: Uint8Array,
  etag: string,
  commandId: string,
): Promise<{ statusCode: number; body: string }> {
  return api.app.inject({
    method: 'POST',
    url: '/api/v1/attachments/complete',
    headers: p07Headers(client, commandId),
    payload: JSON.stringify({
      binding,
      declared: { size: body.byteLength, sha256: p07Digest(body), mediaType: 'image/png', etag },
    }),
  });
}

// ---------------------------------------------------------------------------
// Real-fact seeding (legal preconditions / independent observations only)
// ---------------------------------------------------------------------------

/** Inserts `count` pending verification outbox rows (legal test precondition). */
export async function p10BacklogSeed(
  runtime: DatabaseRuntime,
  count: number,
  runToken = randomUUID().slice(0, 8),
): Promise<void> {
  // Unique run token per call so repeated seeds never collide on the
  // resource_id_ledger primary key (the alert rehearsal seeds multiple times).
  await runtime.pool.query(
    `insert into resource_id_ledger (resource_id, resource_type)
     select 'p10-backlog-' || $2 || '-' || g, 'outbox' from generate_series(1, $1) g
     union all
     select 'p10-backlog-event-' || $2 || '-' || g, 'outbox' from generate_series(1, $1) g`,
    [count, runToken],
  );
  await runtime.pool.query(
    `insert into outbox_events (
       outbox_id, domain_event_id, event_type, event_version, handler_name, handler_mode,
       aggregate_type, aggregate_id, aggregate_scope, aggregate_revision, commit_ordinal,
       occurred_at, payload_json, state, attempt_count, available_at, locked_until,
       lease_generation, completed_at, last_error, dead_lettered_at)
     select 'p10-backlog-' || $2 || '-' || g, 'p10-backlog-event-' || $2 || '-' || g, 'attachments.upload-verified', 1,
       'attachments_verify_generation', 'delivery_each_event', 'blob', 'p10-blob-' || $2 || '-' || g, 'p10-gen-' || $2 || '-' || g,
       null, null, now(), ('{"blobId":"p10-blob-' || $2 || '-' || g || '","generationId":"p10-gen-' || $2 || '-' || g
         || '","intentId":"p10-intent-' || $2 || '-' || g || '"}')::jsonb, 'pending', 0, now(), null, 0, null, null, null
     from generate_series(1, $1) g`,
    [count, runToken],
  );
}

/** Independent observation: current backlog facts straight from PostgreSQL. */
export async function p10BacklogFacts(runtime: DatabaseRuntime): Promise<{
  readonly verificationBacklog: number;
  readonly quarantineCount: number;
  readonly deadLetterCount: number;
}> {
  const rows = await runtime.pool.query<{
    verification_backlog: string; quarantine_count: string; dead_letter_count: string;
  }>(`
    select
      (select count(*)::text from outbox_events
        where handler_name = 'attachments_verify_generation' and state in ('pending', 'retryable', 'leased')) as verification_backlog,
      (select count(*)::text from blob_generations where generation_state = 'quarantined') as quarantine_count,
      (select count(*)::text from outbox_events
        where handler_name = 'attachments_verify_generation' and dead_lettered_at is not null) as dead_letter_count
  `);
  const row = rows.rows[0]!;
  return {
    verificationBacklog: Number(row.verification_backlog),
    quarantineCount: Number(row.quarantine_count),
    deadLetterCount: Number(row.dead_letter_count),
  };
}

/** Counting wrapper over the production pool (test-owned observation only). */
export function p10DbQueryCounter(pool: Pool): { count(): number } {
  let count = 0;
  const original = pool.query.bind(pool);
  pool.query = ((...args: unknown[]) => {
    count += 1;
    return original(...(args as Parameters<typeof original>));
  }) as typeof pool.query;
  return {
    count: () => count,
  };
}

/** Redis memory facts (read-only INFO memory; suite-owned instance). */
export async function p10RedisMemory(raw: Redis): Promise<number> {
  const info = await raw.info('memory');
  const match = /used_memory:(\d+)/u.exec(info);
  assert.ok(match, 'INFO memory must report used_memory');
  return Number(match[1]);
}

/** Hot-key count over the suite-owned limiter namespace (test-only scan). */
export async function p10RedisHotKeyCount(raw: Redis, prefix: string, threshold = 20): Promise<number> {
  const keys = await raw.keys(`${prefix}:*`);
  let hot = 0;
  for (const key of keys) {
    const value = await raw.get(key);
    if (value !== null && Number(value) >= threshold) hot += 1;
  }
  return hot;
}

/** Validates every produced limiter key is a canonical codec key (no identity leak). */
export async function p10AssertCanonicalKeys(raw: Redis, prefix: string): Promise<void> {
  const keys = await raw.keys(`${prefix}:*`);
  for (const key of keys) {
    assert.equal(parseAttachmentRateLimitKey(key).kind, 'ok', `canonical key: ${key}`);
  }
}

// ---------------------------------------------------------------------------
// Capacity sampling
// ---------------------------------------------------------------------------

export interface P10CapacityFacts {
  readonly objectSizeBytes: number;
  readonly concurrency: number;
  readonly apiInstances: number;
  readonly dbQueryCounter: { count(): number };
  readonly r2CallCounter: { count(): number };
  readonly redisFacts: { usedMemoryBytes: number; connectedClients: number } | null;
  readonly pool: { total(): number; idle(): number; active(): number; waiting(): number };
}

export function p10CapacitySample(
  phase: 'cold_start' | 'warm',
  facts: P10CapacityFacts,
  latencyMs: { p50: number; p95: number } | null,
  extraLimitations: readonly string[] = [],
): CapacitySample {
  const sample: CapacitySample = {
    schemaVersion: 1,
    phase,
    objectSizeBytes: facts.objectSizeBytes,
    concurrency: facts.concurrency,
    apiInstances: facts.apiInstances,
    process: {
      rssBytes: process.memoryUsage().rss,
      fdCount: (process.resourceUsage?.() as { maxFileDescriptors?: number } | undefined)?.maxFileDescriptors ?? null,
      activeHandles: (process as unknown as { _getActiveHandles(): unknown[] })._getActiveHandles().length,
    },
    postgresPool: {
      total: facts.pool.total(),
      idle: facts.pool.idle(),
      active: facts.pool.active(),
      waiting: facts.pool.waiting(),
    },
    redis: facts.redisFacts === null
      ? null
      : { usedMemoryBytes: facts.redisFacts.usedMemoryBytes, connectedClients: facts.redisFacts.connectedClients },
    dbQueries: facts.dbQueryCounter.count(),
    r2Calls: facts.r2CallCounter.count(),
    latencyMs,
    limitations: [CAPACITY_NOT_SLO_LIMITATION, ...extraLimitations],
  };
  validateCapacitySample(sample);
  return sample;
}

// ---------------------------------------------------------------------------
// Bounded polling
// ---------------------------------------------------------------------------

export async function waitForP10(
  predicate: () => Promise<boolean>,
  options: { readonly timeoutMs?: number; readonly label?: string } = {},
): Promise<void> {
  await waitUntil(predicate, options.timeoutMs ?? 60_000, options.label ?? 'p10 predicate', 100);
}

export { waitUntil };
export { P05_BUCKET, P05_COLLECTION, makeP05Config, p05WorkerEnvironment };
