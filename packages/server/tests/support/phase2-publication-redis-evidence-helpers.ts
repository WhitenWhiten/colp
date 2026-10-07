/**
 * Shared helpers and lifecycle factory for the T14 Phase 2 Publication Redis
 * performance/failure evidence suite
 * (plan 12-redis-hot-data-cache-plan.md §6.4 T14, §7.5/§7.6).
 *
 * Everything here is a test harness, not src. The factory provisions the real
 * PostgreSQL runtime, a dedicated Testcontainers Redis (never a developer
 * Redis; no FLUSHALL/FLUSHDB), the serve/off API compositions and the
 * observer store; `close()` performs the ordered cleanup.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import {
  CACHE_ERROR_CATEGORY,
  CacheStoreError,
  buildCacheEpochKey,
  createRedisCacheStore,
  type CacheStore,
} from '../../src/infrastructure/cache/index.js';
import { runMigrations, type DatabaseRuntime } from '../../src/infrastructure/database/index.js';
import {
  PHASE2_PUBLICATION_REDIS_FIXTURE,
  collectPhase2RedisHostEnvironment,
  phase2PublicationRedisEvidenceSchemaPath,
  type Phase2RedisCounts,
  type Phase2RedisFixture,
  type Phase2RedisFixtureCacheConfig,
  type Phase2RedisRedisCommandCounts,
  type Phase2RedisVersions,
} from '../../scripts/evidence/index.js';
import { createPublicationCursorKeyring } from '../../src/modules/publication/index.js';
import {
  buildE2EConfig,
  composeApi,
  insertPublishedCollection,
  loginBrowser,
  newE2ETestScope,
  signal,
  startRedisE2EContainer,
  waitForCacheHealth,
  waitUntil,
  type ApiCompositionContext,
  type CacheOperationCounts,
  type ComposedApi,
  type ComposedPublicationCounters,
  type E2ETestScope,
  type RedisE2EContainer,
} from './redis-cache-e2e.js';
import {
  createIsolatedPostgresRuntime,
  type IsolatedPostgresRuntime,
} from './postgres-test-runtime.js';

// Vite interop: the CJS default resolves to the formats plugin function at runtime;
// the cast only fixes the NodeNext type view of the CJS default export.
const applyAjvFormats = addFormats as unknown as (ajv: Ajv2020) => void;

const backendRoot = resolve(import.meta.dirname, '../..');
/** Loose engineering-trial bound for a single outage fallback read (counts are the primary gate). */
export const FALLBACK_LATENCY_BOUND_MS = 5_000;
/** Loose bound for a single failing cache command during the outage. */
export const OUTAGE_COMMAND_BOUND_MS = 3_000;
/** Breaker cooldown used by the failure-policy evidence (test-only value). */
export const BREAKER_COOLDOWN_MS = 500;
/** Breaker failure threshold used by the failure-policy evidence (test-only value). */
export const BREAKER_FAILURE_THRESHOLD = 3;

export interface CapturedResponse {
  readonly statusCode: number;
  readonly bytes: Buffer;
  readonly etag: string | undefined;
  readonly body: unknown;
}

/** Start gate: every participant arrives, then all are released together (real interleaving). */
export class StartGate {
  private remaining: number;
  private readonly go: Promise<void>;
  private releaseGo!: () => void;

  constructor(count: number) {
    this.remaining = count;
    this.go = new Promise<void>((resolveGo) => {
      this.releaseGo = resolveGo;
    });
  }

  async arrive(): Promise<void> {
    this.remaining -= 1;
    if (this.remaining === 0) this.releaseGo();
    await this.go;
  }
}

export function metadataUrl(collectionId: string): string {
  return `/colp/v0.1/collections/${encodeURIComponent(collectionId)}`;
}

export function snapshotUrl(collectionId: string): string {
  return `/colp/v0.1/collections/${encodeURIComponent(collectionId)}/snapshot`;
}

export async function getJson(app: ComposedApi, url: string): Promise<CapturedResponse> {
  const response = await app.app.inject({
    method: 'GET',
    url,
    headers: { accept: 'application/json' },
  });
  return {
    statusCode: response.statusCode,
    bytes: Buffer.from(response.rawPayload),
    etag: typeof response.headers.etag === 'string' ? response.headers.etag : undefined,
    body: response.json(),
  };
}

export function assertEqualBytes(actual: CapturedResponse, expected: CapturedResponse, label: string): void {
  assert.equal(actual.statusCode, expected.statusCode, `${label} status`);
  assert.deepEqual(actual.bytes, expected.bytes, `${label} body bytes`);
  assert.equal(actual.etag, expected.etag, `${label} ETag`);
}

export function isCacheUnavailable(error: unknown): boolean {
  return error instanceof CacheStoreError && error.category === CACHE_ERROR_CATEGORY.UNAVAILABLE;
}

export function commandCounts(counts: CacheOperationCounts): Phase2RedisRedisCommandCounts {
  return {
    get: counts.get,
    set: counts.set,
    setIfAbsent: counts.setIfAbsent,
    releaseIfOwner: counts.releaseIfOwner,
    rotateEpoch: counts.rotateEpoch,
    health: counts.health,
  };
}

export function addCommandCounts(
  left: Phase2RedisRedisCommandCounts,
  right: Phase2RedisRedisCommandCounts,
): Phase2RedisRedisCommandCounts {
  return {
    get: left.get + right.get,
    set: left.set + right.set,
    setIfAbsent: left.setIfAbsent + right.setIfAbsent,
    releaseIfOwner: left.releaseIfOwner + right.releaseIfOwner,
    rotateEpoch: left.rotateEpoch + right.rotateEpoch,
    health: left.health + right.health,
  };
}

export function aggregateCounts(items: readonly Phase2RedisCounts[]): Phase2RedisCounts {
  return {
    requests: items.reduce((sum, item) => sum + item.requests, 0),
    loaderCalls: items.reduce((sum, item) => sum + item.loaderCalls, 0),
    hits: items.reduce((sum, item) => sum + item.hits, 0),
    misses: items.reduce((sum, item) => sum + item.misses, 0),
    fallbacks: items.reduce((sum, item) => sum + item.fallbacks, 0),
    redisCommands: items
      .map((item) => item.redisCommands)
      .reduce(addCommandCounts, {
        get: 0,
        set: 0,
        setIfAbsent: 0,
        releaseIfOwner: 0,
        rotateEpoch: 0,
        health: 0,
      }),
  };
}

export function totalLoaderCalls(counters: ComposedPublicationCounters): number {
  return counters.metadata.calls.load + counters.directory.calls.loadPage + counters.snapshot.calls.loadPage;
}

export async function readEpoch(targetScope: E2ETestScope, collectionId: string, store: CacheStore): Promise<number> {
  const key = buildCacheEpochKey({
    environment: 'test',
    keyPrefix: targetScope.keyPrefix,
    domain: { kind: 'publication', locator: 'pubid', collectionId },
  });
  const raw = await store.get(key, signal());
  return raw === null ? 0 : Number.parseInt(raw, 10);
}

export async function waitForEpochRotation(
  targetScope: E2ETestScope,
  collectionId: string,
  store: CacheStore,
  before: number,
  timeoutMs: number,
): Promise<number> {
  let observedAtMs = 0;
  await waitUntil(
    async () => {
      const epoch = await readEpoch(targetScope, collectionId, store);
      if (epoch > before) {
        observedAtMs = performance.now();
        return true;
      }
      return false;
    },
    timeoutMs,
    `epoch rotation for collection ${collectionId}`,
    50,
  );
  return observedAtMs;
}

export function compileArtifactValidator() {
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  applyAjvFormats(ajv);
  const schema = JSON.parse(readFileSync(phase2PublicationRedisEvidenceSchemaPath(), 'utf8')) as object;
  return ajv.compile(schema);
}

export function writeArtifact(path: string, serialized: string): void {
  mkdirSync(resolve(path, '..'), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, serialized, 'utf8');
  renameSync(temporary, path);
}

export function gitHeadSha(): string {
  return execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: backendRoot,
    encoding: 'utf8',
    windowsHide: true,
  }).trim();
}

export function gitWorktreeDirty(): boolean {
  const status = execFileSync('git', ['status', '--porcelain'], {
    cwd: backendRoot,
    encoding: 'utf8',
    windowsHide: true,
  });
  return status.trim().length > 0;
}

export function buildFixture(cacheConfig: Phase2RedisFixtureCacheConfig): Phase2RedisFixture {
  return {
    concurrency: PHASE2_PUBLICATION_REDIS_FIXTURE.concurrency,
    randomSeed: PHASE2_PUBLICATION_REDIS_FIXTURE.randomSeed,
    childCount: PHASE2_PUBLICATION_REDIS_FIXTURE.childCount,
    warmupIterations: PHASE2_PUBLICATION_REDIS_FIXTURE.warmupIterations,
    sampleIterations: PHASE2_PUBLICATION_REDIS_FIXTURE.sampleIterations,
    domains: [...PHASE2_PUBLICATION_REDIS_FIXTURE.domains],
    redisImage: process.env.KNOWN_REDIS_IMAGE?.trim() || 'redis:7-alpine',
    postgresImage: process.env.KNOWN_POSTGRES_IMAGE?.trim() || 'postgres:16.4-alpine',
    failureInjectionPoint:
      'redis-server shutdown (nosave) inside the test-only container; restored with redis-server --daemonize yes',
    cacheConfig,
  };
}

export async function collectVersions(runtime: DatabaseRuntime, redisVersion: string): Promise<Phase2RedisVersions> {
  const host = collectPhase2RedisHostEnvironment();
  const postgres = await runtime.pool.query<{ server_version: string }>('show server_version');
  const packageJson = JSON.parse(readFileSync(resolve(backendRoot, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  return {
    ...host,
    postgres: postgres.rows[0]?.server_version ?? 'unknown',
    redis: redisVersion,
    vitest: packageJson.devDependencies?.vitest ?? 'unknown',
    tsx: packageJson.devDependencies?.tsx ?? 'unknown',
    ioredis: packageJson.dependencies?.ioredis ?? 'unknown',
  };
}

export interface Phase2PublicationRedisEvidenceContext {
  readonly isolated: IsolatedPostgresRuntime;
  readonly runtime: DatabaseRuntime;
  readonly redis: RedisE2EContainer;
  readonly scope: E2ETestScope;
  readonly cursorKeys: ReturnType<typeof createPublicationCursorKeyring>;
  readonly serve: ComposedApi;
  readonly off: ComposedApi;
  readonly observerStore: CacheStore;
  readonly cacheConfig: Phase2RedisFixtureCacheConfig;
  readonly redisVersion: string;
  readonly owner: Awaited<ReturnType<typeof loginBrowser>>;
  readonly fixtureA: Awaited<ReturnType<typeof insertPublishedCollection>>;
  readonly fixtureB: Awaited<ReturnType<typeof insertPublishedCollection>>;
  readonly fixtureC: Awaited<ReturnType<typeof insertPublishedCollection>>;
  close(): Promise<void>;
}

/**
 * Provisions the full T14 evidence environment (real PostgreSQL runtime +
 * dedicated Testcontainers Redis + serve/off compositions + observer
 * store + owner login + published fixtures) and returns a handle whose
 * `close()` performs the ordered cleanup.
 */
export async function createPhase2PublicationRedisEvidenceContext(): Promise<Phase2PublicationRedisEvidenceContext> {
  const isolated = await createIsolatedPostgresRuntime('t14_publication_redis_evidence', {
    maxConnections: 10,
    applicationName: 'known-t14-publication-redis-evidence',
  });
  const runtime = isolated.runtime;
  await runMigrations(runtime.db, 'latest');
  const redis = await startRedisE2EContainer();
  const cursorKeys = createPublicationCursorKeyring({
    active: { id: 't14-publication-v1', secret: Buffer.alloc(32, 90).toString('base64') },
    retained: [],
  });
  const scope = newE2ETestScope();
  const ctx: ApiCompositionContext = {
    databaseUrl: isolated.databaseUrl,
    runtime,
    redisUrl: redis.url,
    cursorKeys,
  };
  const serve = composeApi(scope, 'serve', ctx, {
    breakerFailureThreshold: BREAKER_FAILURE_THRESHOLD,
    breakerCooldownMs: BREAKER_COOLDOWN_MS,
  });
  const off = composeApi(scope, 'off', ctx);
  await waitForCacheHealth(serve);

  const serveConfig = buildE2EConfig(scope, 'serve', isolated.databaseUrl, redis.url);
  const cacheConfig: Phase2RedisFixtureCacheConfig = {
    mode: 'serve',
    commandTimeoutMs: serveConfig.cache.redis.commandTimeoutMs,
    connectTimeoutMs: serveConfig.cache.redis.connectTimeoutMs,
    maxRetriesPerRequest: serveConfig.cache.redis.maxRetriesPerRequest,
    maxEntryBytes: serveConfig.cache.limits.maxEntryBytes,
    lockTtlMs: serveConfig.cache.limits.lockTtlMs,
    metadataSoftTtlMs: serveConfig.cache.publication.metadata.softTtlMs,
    metadataHardTtlMs: serveConfig.cache.publication.metadata.hardTtlMs,
    directorySoftTtlMs: serveConfig.cache.publication.directory.softTtlMs,
    directoryHardTtlMs: serveConfig.cache.publication.directory.hardTtlMs,
    snapshotSoftTtlMs: serveConfig.cache.publication.snapshot.softTtlMs,
    snapshotHardTtlMs: serveConfig.cache.publication.snapshot.hardTtlMs,
  };

  const redisConnection = {
    url: redis.url,
    commandTimeoutMs: 200,
    connectTimeoutMs: 2_000,
    maxRetriesPerRequest: 1,
    keyPrefix: scope.keyPrefix,
  };
  const observerStore = createRedisCacheStore(redisConnection);
  await waitUntil(async () => (await observerStore.health()) === 'healthy', 15_000, 'observer store healthy', 50);

  // E1 contract: loginBrowser now mints the session through the composed
  // API's Better Auth test factory (composed, subject) — the pre-E1
  // (app, runtime, config, subject) HTTP-login signature no longer exists.
  const owner = await loginBrowser(serve, scope.ownerSubject);
  const fixtureA = await insertPublishedCollection({
    pool: runtime.pool,
    ownerSubjectId: owner.subjectId,
    childCount: PHASE2_PUBLICATION_REDIS_FIXTURE.childCount,
    suffix: 't14-a',
    title: 'T14 fixture A',
  });
  const fixtureB = await insertPublishedCollection({
    pool: runtime.pool,
    ownerSubjectId: owner.subjectId,
    childCount: PHASE2_PUBLICATION_REDIS_FIXTURE.childCount,
    suffix: 't14-b',
    title: 'T14 fixture B',
  });
  const fixtureC = await insertPublishedCollection({
    pool: runtime.pool,
    ownerSubjectId: owner.subjectId,
    childCount: PHASE2_PUBLICATION_REDIS_FIXTURE.childCount,
    suffix: 't14-c',
    title: 'T14 fixture C',
  });

  let redisVersion = 'unknown';
  try {
    const info = await redis.container.exec(['redis-cli', 'INFO', 'server']);
    const match = /^redis_version:([^\r\n]+)/m.exec(info.output);
    redisVersion = match?.[1]?.trim() ?? 'unknown';
  } catch {
    redisVersion = 'unknown';
  }

  return {
    isolated,
    runtime,
    redis,
    scope,
    cursorKeys,
    serve,
    off,
    observerStore,
    cacheConfig,
    redisVersion,
    owner,
    fixtureA,
    fixtureB,
    fixtureC,
    async close() {
      const errors: unknown[] = [];
      const record = (error: unknown): void => {
        if (error) errors.push(error);
      };
      try {
        await serve.close();
      } catch (error) {
        record(error);
      }
      try {
        await off.close();
      } catch (error) {
        record(error);
      }
      try {
        await observerStore.close();
      } catch (error) {
        record(error);
      }
      try {
        cursorKeys.destroy();
      } catch (error) {
        record(error);
      }
      try {
        await redis.stop();
      } catch (error) {
        record(error);
      }
      try {
        await isolated.close();
      } catch (error) {
        record(error);
      }
      if (errors.length > 0) {
        throw new Error(`T14 evidence cleanup failed: ${errors.map((error) => String(error)).join(' | ')}`);
      }
    },
  };
}

