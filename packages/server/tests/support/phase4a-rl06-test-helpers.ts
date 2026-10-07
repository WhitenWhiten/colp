/**
 * P4A-RL06 shared helpers for the multi-replica admission suite (plan §8
 * RL06). This file is not a vitest test file.
 *
 * Provides:
 *  - `startRl06SuiteEnv`: the shared REAL boundary fixtures — a dedicated
 *    Testcontainers Redis container (daemonized redis-server under a
 *    keep-alive shell so the outage test can stop/restart the PROCESS while
 *    keeping the port mapping), the production-migration PostgreSQL runtime
 *    with isolated schema, the identity sessions and the local object-server
 *    stub (RL06 does not require real R2, §11 matrix). Container failures are
 *    environment failures — never a skip (plan §4.2.6);
 *  - `buildRl06Pair` / `buildRl06Instance`: TWO independent production API
 *    compositions (`buildRl04App`), each with its OWN real ioredis client
 *    (per-instance counting factory over the REAL Redis connection), its OWN
 *    in-process local/emergency limiters and its OWN metrics/log sinks,
 *    sharing ONLY PostgreSQL and the Redis key namespace (the same key
 *    prefix + HMAC secret = ONE shared quota identity, exactly the production
 *    multi-replica contract). The download use case is the RL04 production
 *    composition (permissive limiter inside the use case; the facade owns the
 *    single local reference attempt);
 *  - counted HTTP deliver wrappers (`rl06Issue` / `rl06Complete` /
 *    `rl06Admit` / `rl06Status`): every request explicitly targets ONE named
 *    instance and bumps that instance's served counter — the per-instance
 *    alternation evidence the RL06 anti-false-positive rules require (no
 *    random load balancer, no sticky session);
 *  - `makeRl06RateLimitConfig`, `countUploadIntents`, `countOutboxEvents`,
 *    `rl06ProblemOf`, `alternate` and `prepareStored`: the shared config /
 *    side-effect counters / Problem shape / explicit round-robin picker /
 *    full production upload fixture used by both suite files;
 *  - `waitForWindowHeadroom`: a Redis SERVER-TIME health barrier that waits
 *    until the current fixed window has at least `minHeadroomMs` left, so an
 *    exact-count burst can never straddle a window rollover (plan §2.3
 *    server-time windows; anti-false-negative §4.2.5 — polling, never a
 *    fixed sleep).
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import { Redis } from 'ioredis';
import { sql } from 'kysely';
import type {
  AttachmentRateLimitConfig,
  AttachmentRateLimitLogEntry,
  AttachmentsFeatureConfig,
  DeliveryRateLimiter,
} from '../../src/modules/attachments/index.js';
import type { DatabaseRuntime } from '../../src/infrastructure/database/index.js';
import type { IdentityUnitOfWork } from '../../src/modules/identity/index.js';
import type { BrowserSessionAuthority } from '../../src/modules/auth/index.js';
import {
  buildRl04App,
  rl04CountingClientFactory,
  type Rl04AppBundle,
  type Rl04ClientCounts,
} from './phase4a-rl04-test-helpers.js';
import { createI07MigrationRuntime, type I07MigrationRuntime } from './phase4a-i07-test-helpers.js';
import { P03ObjectServer, seedP03Collection } from './phase4a-p03-test-helpers.js';
import { p07Digest, p07Headers, p07Put, p07Status, p07VerifyToStored, type P07IssueResponse } from './phase4a-p07-test-helpers.js';
import { p08Admit } from './phase4a-p08-test-helpers.js';
import {
  createIdentityMemoryState,
  createIdentityMemoryUnitOfWork,
  issueTestSession,
  type AuthenticatedTestClient,
} from './product-http-harness.js';
import { createInMemoryBetterAuthTestFactory } from './better-auth-test-factory.js';
import { waitUntil } from './redis-runtime-test-helpers.js';

export const RL06_IMAGE = process.env.KNOWN_REDIS_IMAGE?.trim() || 'redis:7-alpine';
export const RL06_ISSUER = 'https://issuer.example';
export const RL06_COLLECTION = 'rl06-collection';
export const RL06_COLLECTION_SCOPE = 'rl06-collection-scope';
export const RL06_COLLECTION_OTHER = 'rl06-collection-other';

// ---------------------------------------------------------------------------
// Shared REAL boundary fixtures (container / PostgreSQL / sessions / objects)
// ---------------------------------------------------------------------------

export interface Rl06SuiteEnv {
  readonly container: StartedTestContainer;
  readonly raw: Redis;
  readonly redisUrl: string;
  readonly isolated: I07MigrationRuntime;
  readonly objectServer: P03ObjectServer;
  readonly identityUnitOfWork: IdentityUnitOfWork;
  readonly factory: ReturnType<typeof createInMemoryBetterAuthTestFactory>;
  readonly owner: AuthenticatedTestClient;
  readonly other: AuthenticatedTestClient;
  readonly probe: AuthenticatedTestClient;
  dropSchema(): Promise<void>;
  stop(): Promise<void>;
}

async function waitUntilRawPing(raw: Redis): Promise<void> {
  await waitUntil(async () => {
    try { return (await raw.ping()) === 'PONG'; } catch { return false; }
  }, 15_000, 'raw redis ping', 50);
}

/**
 * Starts the shared REAL fixtures for one suite file: dedicated Redis
 * container (daemonized under a keep-alive shell so the redis-server PROCESS
 * can be stopped/restarted for the outage test), production-migration
 * PostgreSQL schema, identity sessions and the object server. Any container
 * failure throws (environment failure, never a skip — plan §4.2.6).
 */
export async function startRl06SuiteEnv(): Promise<Rl06SuiteEnv> {
  let container: StartedTestContainer;
  try {
    container = await new GenericContainer(RL06_IMAGE)
      .withExposedPorts(6379)
      .withCommand(['sh', '-c', 'redis-server --daemonize yes; while true; do sleep 3600; done'])
      .withStartupTimeout(120_000)
      .start();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `P4A-RL06 fail-closed: could not start a dedicated Redis container (image ${RL06_IMAGE}). ` +
        `The multi-replica suite requires Docker/Testcontainers: ${detail}`,
    );
  }
  const redisUrl = `redis://127.0.0.1:${container.getMappedPort(6379)}`;
  const raw = new Redis(redisUrl);
  try {
    await waitUntilRawPing(raw);
  } catch (error) {
    await container.stop().catch(() => undefined);
    throw error;
  }
  const isolated = await createI07MigrationRuntime('phase4a_rl06_http', { maxConnections: 16 });
  const identityUnitOfWork = createIdentityMemoryUnitOfWork(
    createIdentityMemoryState(new Date('2026-08-08T12:00:00.000Z')),
  );
  const factory = createInMemoryBetterAuthTestFactory({ identityUnitOfWork });
  const owner = await issueTestSession({ factory, subject: 'rl06-owner', handle: 'rl06_owner' });
  const other = await issueTestSession({ factory, subject: 'rl06-other', handle: 'rl06_other' });
  const probe = await issueTestSession({ factory, subject: 'rl06-probe', handle: 'rl06_probe' });
  await seedP03Collection(isolated.runtime, {
    collectionId: RL06_COLLECTION,
    ownerSubjectId: owner.subjectId,
    members: [
      { subjectId: owner.subjectId, role: 'owner' },
      { subjectId: other.subjectId, role: 'viewer' },
      { subjectId: probe.subjectId, role: 'viewer' },
    ],
  });
  await seedP03Collection(isolated.runtime, {
    collectionId: RL06_COLLECTION_SCOPE,
    ownerSubjectId: owner.subjectId,
    members: [{ subjectId: owner.subjectId, role: 'owner' }],
  });
  await seedP03Collection(isolated.runtime, {
    collectionId: RL06_COLLECTION_OTHER,
    ownerSubjectId: other.subjectId,
    members: [{ subjectId: other.subjectId, role: 'owner' }],
  });
  const objectServer = new P03ObjectServer();
  await objectServer.start();
  return {
    container,
    raw,
    redisUrl,
    isolated,
    objectServer,
    identityUnitOfWork,
    factory,
    owner,
    other,
    probe,
    async dropSchema() {
      await isolated.dropSchema();
    },
    async stop() {
      await objectServer.close();
      await raw.quit();
      await container.stop();
    },
  };
}

// ---------------------------------------------------------------------------
// Two independent API instances (own Redis client / limiters / metrics/logs)
// ---------------------------------------------------------------------------

export interface Rl06Instance {
  /** Fixed instance label used only in low-sensitivity diagnostics. */
  readonly name: string;
  readonly bundle: Rl04AppBundle;
  /** Per-instance Redis command counts of THIS instance's OWN client. */
  readonly counts: Rl04ClientCounts;
  /** Fixed-class admission log entries recorded by THIS instance. */
  readonly logEntries: AttachmentRateLimitLogEntry[];
  /** HTTP requests actually delivered to THIS instance (alternation proof). */
  requests: number;
  /** How many times the download use case ran on THIS instance. */
  readonly downloadCalls: () => number;
}

export interface Rl06Pair {
  readonly a: Rl06Instance;
  readonly b: Rl06Instance;
  /** The shared HMAC secret both instances use (one quota identity). */
  readonly keySecret: Buffer;
  readonly config: AttachmentRateLimitConfig;
  served(): { readonly a: number; readonly b: number };
  close(): Promise<void>;
}

export interface Rl06InstanceOptions {
  readonly runtime: I07MigrationRuntime;
  readonly databaseUrl: string;
  readonly identityUnitOfWork: IdentityUnitOfWork;
  /** E1: Better Auth session authority (test factory); absent keeps legacy auth. */
  readonly browserSessionAuthority?: BrowserSessionAuthority;
  readonly objectServerUrl: string;
  readonly attachmentsConfig: AttachmentsFeatureConfig;
  readonly rateLimitConfig: AttachmentRateLimitConfig;
  readonly keySecret: Buffer;
  /** Optional per-instance local reference limiter (off/shadow modes). */
  readonly localLimiter?: DeliveryRateLimiter;
}

export interface Rl06PairOptions extends Rl06InstanceOptions {
  /** Optional mode override for instance B (shadow/enforce observability). */
  readonly modeB?: AttachmentRateLimitConfig['mode'];
  readonly localLimiterA?: DeliveryRateLimiter;
  readonly localLimiterB?: DeliveryRateLimiter;
}

/**
 * Builds ONE production API composition with its own Redis client, local
 * limiter, metrics and logs, and waits for its rate-limit readiness via a
 * health barrier. Container/process failure surfaces as a thrown error
 * (environment failure, never a skip — plan §4.2.6).
 */
export async function buildRl06Instance(
  name: string,
  options: Rl06InstanceOptions,
): Promise<Rl06Instance> {
  const counting = rl04CountingClientFactory();
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
    createClient: counting.factory,
    ...(options.localLimiter === undefined ? {} : { localLimiter: options.localLimiter }),
  });
  await waitUntil(
    () => bundle.rateLimit.facade.readiness().status === 'healthy',
    20_000,
    `RL06 instance ${name} rate-limit store ready`,
    25,
  );
  return {
    name,
    bundle,
    counts: counting.counts,
    logEntries: bundle.logEntries,
    requests: 0,
    downloadCalls: bundle.downloadCalls,
  };
}

/**
 * Two concurrent production API compositions sharing PostgreSQL and the
 * Redis quota namespace while keeping every in-process state fully
 * independent (separate clients/limiters/metrics/logs). Instance B may run a
 * different mode (shadow/enforce observability, plan §8 RL06).
 */
export async function buildRl06Pair(options: Rl06PairOptions): Promise<Rl06Pair> {
  const configB: AttachmentRateLimitConfig =
    options.modeB === undefined || options.modeB === options.rateLimitConfig.mode
      ? options.rateLimitConfig
      : Object.freeze({ ...options.rateLimitConfig, mode: options.modeB });
  const a = await buildRl06Instance('A', {
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
    ...(options.localLimiterA === undefined ? {} : { localLimiter: options.localLimiterA }),
  });
  const b = await buildRl06Instance('B', {
    runtime: options.runtime,
    databaseUrl: options.databaseUrl,
    identityUnitOfWork: options.identityUnitOfWork,
    ...(options.browserSessionAuthority === undefined
      ? {}
      : { browserSessionAuthority: options.browserSessionAuthority }),
    objectServerUrl: options.objectServerUrl,
    attachmentsConfig: options.attachmentsConfig,
    rateLimitConfig: configB,
    keySecret: options.keySecret,
    ...(options.localLimiterB === undefined ? {} : { localLimiter: options.localLimiterB }),
  });
  return {
    a,
    b,
    keySecret: options.keySecret,
    config: options.rateLimitConfig,
    served() {
      return { a: a.requests, b: b.requests };
    },
    async close() {
      await Promise.all([a.bundle.close(), b.bundle.close()].map((closing) => closing.catch(() => undefined)));
    },
  };
}

// ---------------------------------------------------------------------------
// Counted HTTP deliver wrappers (explicit per-instance addressing)
// ---------------------------------------------------------------------------

export interface Rl06HttpResponse {
  readonly statusCode: number;
  readonly headers: Record<string, unknown>;
  readonly body: string;
}

/** POST /api/v1/attachments/issue against ONE named instance (counted). */
export async function rl06Issue(
  instance: Rl06Instance,
  client: AuthenticatedTestClient,
  commandId: string,
  collectionId: string,
  overrides: Record<string, unknown> = {},
): Promise<Rl06HttpResponse> {
  instance.requests += 1;
  return instance.bundle.bundle.app.inject({
    method: 'POST',
    url: '/api/v1/attachments/issue',
    headers: p07Headers(client, commandId),
    payload: JSON.stringify({
      collectionId,
      declaredSize: 2048,
      declaredSha256: 'a'.repeat(64),
      mediaHint: 'image/png',
      expectedPolicyRevision: null,
      ...overrides,
    }),
  });
}

/** POST /api/v1/attachments/complete against ONE named instance (counted). */
export async function rl06Complete(
  instance: Rl06Instance,
  client: AuthenticatedTestClient,
  binding: { blobId: string; intentId: string; generationId: string },
  body: Uint8Array,
  etag: string,
  commandId: string,
): Promise<Rl06HttpResponse> {
  instance.requests += 1;
  return instance.bundle.bundle.app.inject({
    method: 'POST',
    url: '/api/v1/attachments/complete',
    headers: p07Headers(client, commandId),
    payload: JSON.stringify({
      binding,
      declared: { size: body.byteLength, sha256: p07Digest(body), mediaType: 'image/png', etag },
    }),
  });
}

/** POST /api/v1/attachments/{blobId}/download admission against ONE instance. */
export async function rl06Admit(
  instance: Rl06Instance,
  client: AuthenticatedTestClient,
  blobId: string,
): Promise<Rl06HttpResponse> {
  instance.requests += 1;
  return p08Admit(instance.bundle.bundle.app, client, blobId);
}

/** GET /api/v1/attachments/{blobId} (control route) against ONE instance. */
export async function rl06Status(
  instance: Rl06Instance,
  client: AuthenticatedTestClient,
  blobId: string,
): Promise<Rl06HttpResponse> {
  instance.requests += 1;
  return p07Status(instance.bundle.bundle.app, client, blobId);
}

/** The raw Fastify app of one instance (direct fixture reuse). */
export function rl06App(instance: Rl06Instance): FastifyInstance {
  return instance.bundle.bundle.app;
}

// ---------------------------------------------------------------------------
// Shared suite helpers (config / counters / fixtures / pickers)
// ---------------------------------------------------------------------------

/** RL02 config fixture: both instances share prefix + secret (one quota). */
export function makeRl06RateLimitConfig(
  redisUrl: string,
  prefix: string,
  overrides: Partial<AttachmentRateLimitConfig> = {},
): AttachmentRateLimitConfig {
  const base: AttachmentRateLimitConfig = {
    mode: 'enforce',
    required: true,
    redisUrl,
    keySecretRef: 'known/rl06/http/hmac',
    keyPrefix: prefix,
    commandTimeoutMs: 750,
    connectTimeoutMs: 3000,
    maxRetriesPerRequest: 1,
    routes: Object.freeze({
      issue: Object.freeze({ rateMax: 30, rateWindowMs: 60000 }),
      complete: Object.freeze({ rateMax: 60, rateWindowMs: 60000 }),
      download: Object.freeze({ rateMax: 30, rateWindowMs: 60000 }),
      status: Object.freeze({ rateMax: 60, rateWindowMs: 60000 }),
    }),
    completeEmergency: Object.freeze({ rateMax: 15, rateWindowMs: 60000 }),
  };
  return Object.freeze({ ...base, ...overrides }) as AttachmentRateLimitConfig;
}

/** Shared PostgreSQL side-effect counter: uploaded intent rows. */
export async function countUploadIntents(runtime: DatabaseRuntime): Promise<number> {
  const rows = await sql<{ count: string }>`select count(*)::text as count from upload_intents`.execute(runtime.db);
  return Number(rows.rows[0]!.count);
}

/** Shared PostgreSQL side-effect counter: outbox rows. */
export async function countOutboxEvents(runtime: DatabaseRuntime): Promise<number> {
  const rows = await sql<{ count: string }>`select count(*)::text as count from outbox_events`.execute(runtime.db);
  return Number(rows.rows[0]!.count);
}

export interface Rl06Problem {
  readonly error: {
    readonly code: string;
    readonly retryAfterSeconds: number | null;
    readonly message: string;
    readonly sameRequestRetrySafe: boolean;
  };
}

/** The stable Attachment Problem envelope (code + real quota facts). */
export function rl06ProblemOf(body: string): Rl06Problem {
  return JSON.parse(body) as Rl06Problem;
}

/** Explicit round-robin target picker (never a random load balancer). */
export function alternate(pair: Rl06Pair, index: number): Rl06Instance {
  return index % 2 === 0 ? pair.a : pair.b;
}

/**
 * Full production upload flow (issue -> independent PUT -> complete ->
 * verification to stored_private) delivered through BOTH instances. Returns
 * the binding and ETag for download/complete admission attempts.
 */
export async function prepareStored(
  env: Rl06SuiteEnv,
  pair: Rl06Pair,
  client: AuthenticatedTestClient,
  body: Uint8Array,
): Promise<{ binding: { blobId: string; intentId: string; generationId: string }; etag: string }> {
  const issued = await rl06Issue(pair.a, client, randomUUID(), RL06_COLLECTION, {
    declaredSize: body.byteLength,
    declaredSha256: p07Digest(body),
  });
  assert.equal(issued.statusCode, 201, `prepare issue: ${issued.body}`);
  const issueBody = JSON.parse(issued.body) as P07IssueResponse;
  const put = await p07Put(issueBody.grant.url, body);
  const completed = await rl06Complete(pair.b, client, issueBody.receipt, body, put.etag, randomUUID());
  assert.equal(completed.statusCode, 200, `prepare complete: ${completed.body}`);
  await p07VerifyToStored(env.isolated.runtime, issueBody.receipt.blobId, issueBody.receipt.generationId, body);
  return { binding: issueBody.receipt, etag: put.etag };
}

/**
 * Upload fixture WITHOUT the complete step (issue -> independent PUT only).
 * The binding stays in `uploaded`, so the FIRST post-outage complete is a
 * real completion — the business-recovery-success evidence of the emergency
 * fallback (plan §4.2.7) — and replays converge idempotently.
 */
export async function prepareUploaded(
  pair: Rl06Pair,
  client: AuthenticatedTestClient,
  body: Uint8Array,
): Promise<{ binding: { blobId: string; intentId: string; generationId: string }; etag: string }> {
  const issued = await rl06Issue(pair.a, client, randomUUID(), RL06_COLLECTION, {
    declaredSize: body.byteLength,
    declaredSha256: p07Digest(body),
  });
  assert.equal(issued.statusCode, 201, `prepare issue: ${issued.body}`);
  const issueBody = JSON.parse(issued.body) as P07IssueResponse;
  const put = await p07Put(issueBody.grant.url, body);
  return { binding: issueBody.receipt, etag: put.etag };
}

/**
 * Server-time window headroom barrier (plan §2.3: the window is floor-aligned
 * to Redis server time). Waits until at least `minHeadroomMs` remain in the
 * current fixed window, so an exact-count burst can never straddle a
 * rollover. Polling only — never a fixed sleep.
 */
export async function waitForWindowHeadroom(
  redis: Redis,
  windowMs: number,
  minHeadroomMs = 10_000,
): Promise<void> {
  await waitUntil(async () => {
    const time = await redis.time();
    const serverMs = Number(time[0]) * 1000 + Math.floor(Number(time[1]) / 1000);
    return serverMs % windowMs <= windowMs - minHeadroomMs;
  }, windowMs, 'Redis fixed-window headroom', 250);
}
