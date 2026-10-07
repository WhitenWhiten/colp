/**
 * P4A-RL04 HTTP + composition suite: the distributed admission limiter
 * composed into the three production routes (plan §8 RL04, §11 matrix: real
 * Redis via Testcontainers `redis:7-alpine`; real PostgreSQL through
 * `scripts/with-postgres.mjs` — the allow paths execute real ledger/object
 * work, so the composition follows the existing p03/p08 helper pattern).
 *
 * Anti-false-positive anchors (plan §4.1.9/§4.2.9):
 *  - every rate-limited/exhausted assertion also proves ZERO expensive work:
 *    `upload_intents`/outbox row counts, the local object-server request
 *    count, and the download USE-CASE invocation counter all stay put
 *    (checking the limiter but still calling the repository would fail);
 *  - 503 (Redis unavailable) is asserted with NO Retry-After / RateLimit-Policy
 *    and 429 with BOTH real quota facts (plan §4.1.10);
 *  - idempotent replay counting follows the network-attempt contract: the
 *    Redis counter counts every attempt, the database rows never multiply.
 *
 * Anti-false-negative anchors:
 *  - anonymous/schema rejections never touch Redis: the counting client
 *    (production command surface) proves zero EVALSHA on those paths;
 *  - the outage test asserts business recovery AND degraded/fallback evidence
 *    TOGETHER (plan §4.2.7) and restarts the redis-server process.
 *
 * Container start/stop failures are environment failures — never a skip.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { sql } from 'kysely';
import { afterAll, afterEach, beforeAll, test } from 'vitest';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import { createI07MigrationRuntime, type I07MigrationRuntime } from '../../support/phase4a-i07-test-helpers.js';
import { describeWithPostgres } from '../../support/postgres-test-runtime.js';
import { P03ObjectServer, makeP03Config, seedP03Collection } from '../../support/phase4a-p03-test-helpers.js';
import { p07Body, p07Complete, p07Digest, p07Headers, p07Issue, p07Put, p07VerifyToStored } from '../../support/phase4a-p07-test-helpers.js';
import { p08Admit } from '../../support/phase4a-p08-test-helpers.js';
import { buildRl04App, type Rl04AppBundle } from '../../support/phase4a-rl04-test-helpers.js';
import { waitUntil } from '../../support/redis-runtime-test-helpers.js';
import { parseAttachmentRateLimitKey } from '../../../src/modules/attachments/index.js';
import {
  createIdentityMemoryState,
  createIdentityMemoryUnitOfWork,
  issueTestSession,
  type AuthenticatedTestClient,
} from '../../support/product-http-harness.js';
import { createInMemoryBetterAuthTestFactory } from '../../support/better-auth-test-factory.js';
import type { AttachmentRateLimitConfig } from '../../../src/modules/attachments/index.js';
import type { FastifyInstance } from 'fastify';

const REDIS_IMAGE = process.env.KNOWN_REDIS_IMAGE?.trim() || 'redis:7-alpine';
const ENVIRONMENT = 'test';
const COLLECTION = 'rl04-collection';
const MEDIA = 'image/png';

let container: StartedTestContainer | undefined;
let redisUrl: string | undefined;
let raw: Redis | undefined;
let isolated: I07MigrationRuntime;
let objectServer: P03ObjectServer;
let identityUnitOfWork: ReturnType<typeof createIdentityMemoryUnitOfWork>;
let factory: ReturnType<typeof createInMemoryBetterAuthTestFactory>;
let owner: AuthenticatedTestClient;
let other: AuthenticatedTestClient;
const usedPrefixes = new Set<string>();
const openBundles: Rl04AppBundle[] = [];

function rlConfig(prefix: string, overrides: Partial<AttachmentRateLimitConfig> = {}): AttachmentRateLimitConfig {
  assert.ok(redisUrl, 'redis URL must be known');
  const base: AttachmentRateLimitConfig = {
    mode: 'enforce',
    required: true,
    redisUrl,
    keySecretRef: 'known/rl04/http/hmac',
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

async function newApp(rateLimitConfig: AttachmentRateLimitConfig): Promise<Rl04AppBundle> {
  const keySecret = Buffer.from(`rl04-http-secret-${randomUUID()}`, 'utf8');
  const bundle = await buildRl04App({
    runtime: isolated,
    databaseUrl: isolated.databaseUrl,
    identityUnitOfWork,
      browserSessionAuthority: factory.authority,
    objectServerUrl: objectServer.url,
    attachmentsConfig: makeP03Config(),
    rateLimitConfig,
    keySecret,
  });
  openBundles.push(bundle);
  usedPrefixes.add(rateLimitConfig.keyPrefix);
  if (rateLimitConfig.mode !== 'off') {
    await waitUntil(
      () => bundle.rateLimit.facade.readiness().status === 'healthy',
      15_000,
      'rate-limit store connection ready',
      25,
    );
  }
  return bundle;
}

async function intentCount(): Promise<number> {
  const rows = await sql<{ count: string }>`select count(*)::text as count from upload_intents`.execute(isolated.runtime.db);
  return Number(rows.rows[0]!.count);
}

async function outboxCount(): Promise<number> {
  const rows = await sql<{ count: string }>`select count(*)::text as count from outbox_events`.execute(isolated.runtime.db);
  return Number(rows.rows[0]!.count);
}

interface Rl04Problem {
  readonly error: {
    readonly code: string;
    readonly retryAfterSeconds: number | null;
    readonly message: string;
    readonly sameRequestRetrySafe: boolean;
  };
}

function problemOf(body: string): Rl04Problem {
  return JSON.parse(body) as Rl04Problem;
}

function mutationHeaders(client: AuthenticatedTestClient, commandId: string): Record<string, string> {
  return { ...p07Headers(client, commandId) };
}

function issueRequest(
  app: FastifyInstance,
  client: AuthenticatedTestClient,
  commandId: string,
  bodyOverrides: Record<string, unknown> = {},
): Promise<{ statusCode: number; headers: Record<string, unknown>; body: string }> {
  return app.inject({
    method: 'POST',
    url: '/api/v1/attachments/issue',
    headers: mutationHeaders(client, commandId),
    payload: JSON.stringify({
      collectionId: COLLECTION,
      declaredSize: 2048,
      declaredSha256: 'a'.repeat(64),
      mediaHint: MEDIA,
      expectedPolicyRevision: null,
      ...bodyOverrides,
    }),
  });
}

describeWithPostgres('P4A-RL04 distributed admission route composition', () => {
  beforeAll(async () => {
    let started: StartedTestContainer;
    try {
      started = await new GenericContainer(REDIS_IMAGE)
        .withExposedPorts(6379)
        // Daemonized redis under a keep-alive shell: the outage test stops and
        // restarts the redis-server PROCESS, keeping the published port mapping.
        .withCommand(['sh', '-c', 'redis-server --daemonize yes; while true; do sleep 3600; done'])
        .withStartupTimeout(120_000)
        .start();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        `P4A-RL04 fail-closed: could not start a dedicated Redis container (image ${REDIS_IMAGE}). ` +
          `The route-composition suite requires Docker/Testcontainers: ${detail}`,
      );
    }
    container = started;
    redisUrl = `redis://127.0.0.1:${started.getMappedPort(6379)}`;
    raw = new Redis(redisUrl);
    await waitUntil(async () => {
      try { await raw?.ping(); return true; } catch { return false; }
    }, 15_000, 'raw redis ping', 50);

    isolated = await createI07MigrationRuntime('phase4a_rl04_http', { maxConnections: 12 });
    identityUnitOfWork = createIdentityMemoryUnitOfWork(createIdentityMemoryState(new Date('2026-08-08T12:00:00.000Z')));
    factory = createInMemoryBetterAuthTestFactory({ identityUnitOfWork });
    owner = await issueTestSession({
      factory,
      subject: 'rl04-owner', handle: 'rl04_owner' });
    other = await issueTestSession({
      factory,
      subject: 'rl04-other', handle: 'rl04_other' });
    await seedP03Collection(isolated.runtime, {
      collectionId: COLLECTION,
      ownerSubjectId: owner.subjectId,
      members: [{ subjectId: owner.subjectId, role: 'owner' }],
    });
    objectServer = new P03ObjectServer();
    await objectServer.start();
  }, 180_000);

  afterEach(async () => {
    // Exact-key cleanup for every run prefix used by this suite (no
    // FLUSHALL/FLUSHDB; KEYS is a test-only cleanup scan, never application).
    if (raw) {
      for (const prefix of usedPrefixes) {
        const keys = await raw.keys(`${prefix}:*`);
        for (const key of keys) {
          try { await raw.del(key); } catch { /* best-effort */ }
        }
      }
    }
    usedPrefixes.clear();
    const open = openBundles.splice(0, openBundles.length);
    await Promise.all(open.map((bundle) => bundle.close().catch(() => undefined)));
  }, 30_000);

  afterAll(async () => {
    const errors: unknown[] = [];
    try { await objectServer?.close(); } catch (error) { errors.push(error); }
    try { await isolated?.dropSchema(); } catch (error) { errors.push(error); }
    if (raw) { try { await raw.quit(); } catch (error) { errors.push(error); } }
    if (container) { try { await container.stop(); } catch (error) { errors.push(error); } }
    if (errors.length > 0) {
      throw new Error(`P4A-RL04 cleanup failed: ${errors.map((error) => String(error)).join(' | ')}`);
    }
  }, 60_000);

  test('issue: allow until the budget, then 429 with real quota facts and ZERO ledger/R2 work', async () => {
    const prefix = `rl04-${randomUUID()}`;
    const bundle = await newApp(rlConfig(prefix, { routes: Object.freeze({
      issue: Object.freeze({ rateMax: 2, rateWindowMs: 60000 }),
      complete: Object.freeze({ rateMax: 60, rateWindowMs: 60000 }),
      download: Object.freeze({ rateMax: 30, rateWindowMs: 60000 }),
      status: Object.freeze({ rateMax: 60, rateWindowMs: 60000 }),
    }) }));
    const before = await intentCount();
    const requestsBefore = objectServer.requests.length;

    const first = await issueRequest(bundle.bundle.app, owner, randomUUID());
    assert.equal(first.statusCode, 201, `first issue: ${first.body}`);
    const second = await issueRequest(bundle.bundle.app, owner, randomUUID());
    assert.equal(second.statusCode, 201);
    const third = await issueRequest(bundle.bundle.app, owner, randomUUID());
    assert.equal(third.statusCode, 429, 'the third issue exceeds the budget');
    const problem = problemOf(third.body);
    assert.equal(problem.error.code, 'rate_limited');
    assert.equal(problem.error.sameRequestRetrySafe, true);
    assert.ok(problem.error.retryAfterSeconds !== null && problem.error.retryAfterSeconds >= 1);
    assert.equal(third.headers['retry-after'], String(problem.error.retryAfterSeconds));
    assert.equal(third.headers['ratelimit-policy'], 'attachments-issue:2:60000');
    assert.equal(third.headers['cache-control'], 'private, no-store');
    assert.equal(await intentCount(), before + 2, 'exactly the two allowed issues created ledger rows');
    assert.equal(objectServer.requests.length, requestsBefore, 'issue does no R2 work at all');

    // Anonymous + schema rejections never reach Redis (anti-false-negative).
    const beforeCommands = bundle.counts!.evalshaCalls;
    const anonymous = await bundle.bundle.app.inject({
      method: 'POST',
      url: '/api/v1/attachments/issue',
      headers: { origin: 'https://app.known.example', 'x-csrf-token': 'x'.repeat(43), 'known-command-id': randomUUID(), 'content-type': 'application/json' },
      payload: JSON.stringify({ collectionId: COLLECTION, declaredSize: 2048, declaredSha256: 'a'.repeat(64), mediaHint: MEDIA }),
    });
    assert.equal(anonymous.statusCode, 401);
    const schemaRejected = await issueRequest(bundle.bundle.app, owner, randomUUID(), { declaredSize: 'huge' });
    assert.equal(schemaRejected.statusCode, 422);
    assert.equal(bundle.counts!.evalshaCalls, beforeCommands, 'auth/schema rejections issue zero Redis commands');

    // The Redis counter counts every network attempt (2 allowed + 1 denied).
    const issueKeys = (await raw!.keys(`${prefix}:*`)).filter((key) => key.includes(':issue:'));
    assert.equal(issueKeys.length, 1, 'one shared counter key for the issue route');
    assert.equal(await raw!.get(issueKeys[0]!), '3');
    const parsed = parseAttachmentRateLimitKey(issueKeys[0]!);
    assert.equal(parsed.kind, 'ok');
  }, 60_000);

  test('issue: rotating collectionIds shares ONE per-principal budget; illegal collectionId shapes never touch Redis (KA-P4-AM-02)', async () => {
    const prefix = `rl04-${randomUUID()}`;
    const bundle = await newApp(rlConfig(prefix, { routes: Object.freeze({
      issue: Object.freeze({ rateMax: 2, rateWindowMs: 60000 }),
      complete: Object.freeze({ rateMax: 60, rateWindowMs: 60000 }),
      download: Object.freeze({ rateMax: 30, rateWindowMs: 60000 }),
      status: Object.freeze({ rateMax: 60, rateWindowMs: 60000 }),
    }) }));
    const before = await intentCount();
    const requestsBefore = objectServer.requests.length;

    // Attempt 1: the member collection is admitted (201).
    const first = await issueRequest(bundle.bundle.app, owner, randomUUID());
    assert.equal(first.statusCode, 201, `first issue: ${first.body}`);

    // Attempt 2: a rotated NONEXISTENT collection consumes the SAME budget —
    // admission lets it through to the database, authorization denies (403).
    // The pre-fix key (client collectionId as scope) would have minted a
    // fresh bucket here; the fixed-route-scope key must not.
    const rotatedDenied = await issueRequest(bundle.bundle.app, owner, randomUUID(), { collectionId: 'rl04-rotated-nonexistent-a' });
    assert.equal(rotatedDenied.statusCode, 403, `rotated collection must reach the DB authorization: ${rotatedDenied.body}`);
    assert.equal(problemOf(rotatedDenied.body).error.code, 'insufficient_permission');
    assert.equal(rotatedDenied.headers['retry-after'], undefined, 'authorization denials carry no quota fact');

    // Attempt 3: yet another rotated collection is exhausted under the SAME
    // per-principal budget (the 429 carries the real quota fact).
    const third = await issueRequest(bundle.bundle.app, owner, randomUUID(), { collectionId: 'rl04-rotated-nonexistent-b' });
    assert.equal(third.statusCode, 429, `a fresh collectionId must NOT mint a fresh budget: ${third.body}`);
    const problem = problemOf(third.body);
    assert.equal(problem.error.code, 'rate_limited');
    assert.equal(third.headers['ratelimit-policy'], 'attachments-issue:2:60000');

    // Exactly ONE issue counter key: the per-principal total bucket.
    const issueKeys = (await raw!.keys(`${prefix}:*`)).filter((key) => key.includes(':issue:'));
    assert.equal(issueKeys.length, 1, 'rotating collectionIds must share one counter key');
    assert.equal(await raw!.get(issueKeys[0]!), '3');
    const parsed = parseAttachmentRateLimitKey(issueKeys[0]!);
    assert.equal(parsed.kind, 'ok');
    assert.equal(await intentCount(), before + 1, 'only the admitted member issue created a ledger row');
    assert.equal(objectServer.requests.length, requestsBefore, 'issue does no R2 work at all');

    // Illegal collectionId shapes are rejected by the transport schema BEFORE
    // Redis/DB: 257/512 chars and control characters -> stable 422, zero
    // admission commands, zero ledger rows.
    const beforeCommands = bundle.counts!.evalshaCalls;
    const illegalShapes = [
      { collectionId: 'c'.repeat(257) },
      { collectionId: 'c'.repeat(512) },
      { collectionId: 'ok\u0000nul' },
      { collectionId: 'ok\nnewline' },
    ];
    for (const override of illegalShapes) {
      const rejected = await issueRequest(bundle.bundle.app, owner, randomUUID(), override);
      assert.equal(rejected.statusCode, 422, `illegal collectionId must be a stable 422: ${JSON.stringify(override)}`);
      assert.equal(problemOf(rejected.body).error.code, 'invalid_document');
    }
    assert.equal(bundle.counts!.evalshaCalls, beforeCommands, 'illegal collectionId shapes issue zero Redis commands');
    assert.equal(await intentCount(), before + 1, 'illegal collectionId shapes create no ledger rows');
  }, 60_000);

  test('complete: exhausted after two network attempts while idempotent replay creates no second generation', async () => {
    const prefix = `rl04-${randomUUID()}`;
    const bundle = await newApp(rlConfig(prefix, { routes: Object.freeze({
      issue: Object.freeze({ rateMax: 30, rateWindowMs: 60000 }),
      complete: Object.freeze({ rateMax: 2, rateWindowMs: 60000 }),
      download: Object.freeze({ rateMax: 30, rateWindowMs: 60000 }),
      status: Object.freeze({ rateMax: 60, rateWindowMs: 60000 }),
    }) }));
    const body = p07Body(7);
    const intentsBefore = await intentCount();
    const issued = await p07Issue(bundle.bundle.app, owner, COLLECTION, body, randomUUID());
    const put = await p07Put(issued.grant.url, body);
    const binding = issued.receipt;
    const digest = p07Digest(body);

    const first = await p07Complete(bundle.bundle.app, owner, binding, body, put.etag, randomUUID());
    assert.equal(first.statusCode, 200, `first complete: ${first.body}`);
    assert.ok(first.body.includes('"completed"'));
    const outboxAfterFirst = await outboxCount();

    // Idempotent replay: the same binding converges without a second outbox row.
    // The replay re-attests the exact object (provider HEAD) and converges
    // idempotently — the exhausted-attempt snapshot below is taken AFTER it.
    const replay = await p07Complete(bundle.bundle.app, owner, binding, body, put.etag, randomUUID());
    assert.equal(replay.statusCode, 200);
    assert.ok(replay.body.includes('"idempotent"'));
    assert.equal(await outboxCount(), outboxAfterFirst, 'replay adds no second outbox row');
    const requestsAfterReplay = objectServer.requests.length;

    // The third network attempt is exhausted BEFORE any provider/database work.
    const third = await p07Complete(bundle.bundle.app, owner, binding, body, put.etag, randomUUID());
    assert.equal(third.statusCode, 429, `the third complete attempt must be rate-limited: ${third.body}`);
    const problem = problemOf(third.body);
    assert.equal(problem.error.code, 'rate_limited');
    assert.ok(problem.error.retryAfterSeconds !== null && problem.error.retryAfterSeconds >= 1);
    assert.equal(await outboxCount(), outboxAfterFirst, 'exhausted complete does no database work');
    assert.equal(objectServer.requests.length, requestsAfterReplay, 'exhausted complete does no provider HEAD');
    assert.equal(await intentCount(), intentsBefore + 1, 'one intent, one generation — the replay never duplicates');

    // Network-attempt contract (plan §4.2.9): the Redis counter is 3, the rows are 1.
    const completeKeys = (await raw!.keys(`${prefix}:*`)).filter((key) => key.includes(':complete:'));
    assert.equal(completeKeys.length, 1);
    assert.equal(await raw!.get(completeKeys[0]!), '3', 'every network attempt counts, the DB rows never multiply');
    void digest;
  }, 60_000);

  test('download admission: 429 after the budget with zero use-case invocations; anonymous never touches Redis', async () => {
    const prefix = `rl04-${randomUUID()}`;
    const bundle = await newApp(rlConfig(prefix, { routes: Object.freeze({
      issue: Object.freeze({ rateMax: 30, rateWindowMs: 60000 }),
      complete: Object.freeze({ rateMax: 60, rateWindowMs: 60000 }),
      download: Object.freeze({ rateMax: 2, rateWindowMs: 60000 }),
      status: Object.freeze({ rateMax: 60, rateWindowMs: 60000 }),
    }) }));
    // stored_private fixture through the REAL production flow.
    const body = p07Body(9);
    const issued = await p07Issue(bundle.bundle.app, owner, COLLECTION, body, randomUUID());
    const put = await p07Put(issued.grant.url, body);
    const binding = issued.receipt;
    const completed = await p07Complete(bundle.bundle.app, owner, binding, body, put.etag, randomUUID());
    assert.equal(completed.statusCode, 200);
    await p07VerifyToStored(isolated.runtime, binding.blobId, binding.generationId, body);

    const first = await p08Admit(bundle.bundle.app, owner, binding.blobId);
    assert.equal(first.statusCode, 200, `first admit: ${first.body}`);
    const second = await p08Admit(bundle.bundle.app, owner, binding.blobId);
    assert.equal(second.statusCode, 200);
    const third = await p08Admit(bundle.bundle.app, owner, binding.blobId);
    assert.equal(third.statusCode, 429, `the third admit must be rate-limited: ${third.body}`);
    const problem = problemOf(third.body);
    assert.equal(problem.error.code, 'rate_limited');
    assert.equal(third.headers['ratelimit-policy'], 'attachments-download:2:60000');
    assert.ok(third.headers['retry-after'] !== undefined);
    assert.equal(bundle.downloadCalls(), 2, 'the download USE CASE ran exactly twice (zero work on the 429)');

    const beforeAnonymous = bundle.counts!.evalshaCalls;
    const anonymous = await bundle.bundle.app.inject({
      method: 'POST',
      url: `/api/v1/attachments/${binding.blobId}/download`,
      headers: { origin: 'https://app.known.example' },
    });
    assert.equal(anonymous.statusCode, 401);
    assert.equal(bundle.counts!.evalshaCalls, beforeAnonymous, 'anonymous admission never reaches Redis');
  }, 60_000);

  test('shadow: Redis denies but the request proceeds and the mismatch is recorded', async () => {
    const prefix = `rl04-${randomUUID()}`;
    const bundle = await newApp(rlConfig(prefix, {
      mode: 'shadow',
      required: false,
      routes: Object.freeze({
        issue: Object.freeze({ rateMax: 1, rateWindowMs: 60000 }),
        complete: Object.freeze({ rateMax: 60, rateWindowMs: 60000 }),
        download: Object.freeze({ rateMax: 30, rateWindowMs: 60000 }),
        status: Object.freeze({ rateMax: 60, rateWindowMs: 60000 }),
      }),
    }));
    const before = await intentCount();

    const first = await issueRequest(bundle.bundle.app, owner, randomUUID());
    assert.equal(first.statusCode, 201);
    const second = await issueRequest(bundle.bundle.app, owner, randomUUID());
    assert.equal(second.statusCode, 201, 'the Redis denial must not deny the request in shadow mode');
    assert.equal(await intentCount(), before + 2, 'both requests completed their business work');

    assert.equal(bundle.metrics.get('attachments.rate_limit.shadow_mismatch'), 1, 'the disagreement is counted');
    const last = bundle.logEntries.at(-1)!;
    assert.equal(last.mode, 'shadow');
    assert.equal(last.shadowMismatch, true);
    assert.equal(last.decision, 'allowed');
  }, 60_000);

  test('off: the production HTTP composition works with zero Redis client and zero secret resolution', async () => {
    const prefix = `rl04-${randomUUID()}`;
    const bundle = await newApp(rlConfig(prefix, { mode: 'off', required: false, redisUrl: null }));
    assert.equal(bundle.counts, null, 'off mode creates no Redis client');
    assert.equal(bundle.rateLimit.facade.readiness().status, 'healthy');
    const response = await issueRequest(bundle.bundle.app, owner, randomUUID());
    assert.equal(response.statusCode, 201, `off mode keeps the baseline issue behavior: ${response.body}`);
  }, 60_000);

  test('one shared client, three isolated route budgets/namespaces (plan §2.2.5/§2.3)', async () => {
    const prefix = `rl04-${randomUUID()}`;
    const bundle = await newApp(rlConfig(prefix, { routes: Object.freeze({
      issue: Object.freeze({ rateMax: 2, rateWindowMs: 60000 }),
      complete: Object.freeze({ rateMax: 3, rateWindowMs: 60000 }),
      download: Object.freeze({ rateMax: 4, rateWindowMs: 60000 }),
      status: Object.freeze({ rateMax: 60, rateWindowMs: 60000 }),
    }) }));
    const app = bundle.bundle.app;

    // issue budget 2: attempts 1-2 allowed (201), attempt 3 exhausted (429).
    assert.equal((await issueRequest(app, owner, randomUUID())).statusCode, 201);
    assert.equal((await issueRequest(app, owner, randomUUID())).statusCode, 201);
    assert.equal((await issueRequest(app, owner, randomUUID())).statusCode, 429);

    // complete budget 3: allowed attempts reach the use case (concealed 404
    // for unknown bindings), the 4th attempt is exhausted before the ledger.
    const garbageBinding = { intentId: randomUUID(), generationId: randomUUID(), blobId: randomUUID() };
    for (let i = 0; i < 3; i += 1) {
      const response = await p07Complete(app, owner, garbageBinding, p07Body(i), '"deadbeef"', randomUUID());
      assert.equal(response.statusCode, 404, `complete attempt ${i + 1} is allowed through to the ledger`);
    }
    const completeDenied = await p07Complete(app, owner, garbageBinding, p07Body(3), '"deadbeef"', randomUUID());
    assert.equal(completeDenied.statusCode, 429, 'the 4th complete attempt is exhausted');

    // download budget 4: allowed attempts are concealed 404s, the 5th is 429.
    const missingBlob = randomUUID();
    for (let i = 0; i < 4; i += 1) {
      const response = await p08Admit(app, other, missingBlob);
      assert.equal(response.statusCode, 404, `download attempt ${i + 1} is allowed through to the ledger`);
    }
    const downloadDenied = await p08Admit(app, other, missingBlob);
    assert.equal(downloadDenied.statusCode, 429);
    assert.equal(downloadDenied.headers['ratelimit-policy'], 'attachments-download:4:60000');

    assert.equal(bundle.counts!.scriptLoads, 1, 'exactly ONE script load shared by every route');
    assert.equal(bundle.counts!.evalshaCalls, 12, '3+4+5 admission checks share one client');

    // Distinct route-class namespaces under one client/prefix.
    const keys = await raw!.keys(`${prefix}:*`);
    const routeClasses = new Set<string>();
    for (const key of keys) {
      const parsed = parseAttachmentRateLimitKey(key);
      assert.equal(parsed.kind, 'ok', `every run key is a canonical codec key: ${key}`);
      if (parsed.kind === 'ok') routeClasses.add(parsed.parts.routeClass);
    }
    assert.deepEqual([...routeClasses].sort(), ['complete', 'download', 'issue']);
    assert.equal(await raw!.get(keys.find((key) => key.includes(':complete:'))!), '4');
    assert.equal(await raw!.get(keys.find((key) => key.includes(':download:'))!), '5');
    assert.equal(await raw!.get(keys.find((key) => key.includes(':issue:'))!), '3');
  }, 60_000);

  test('API restart + config reload: the Redis quota survives a process restart and the reloaded budgets apply from the new process', async () => {
    const prefix = `rl04-${randomUUID()}`;
    const keySecret = Buffer.from(`rl04-restart-${randomUUID()}`, 'utf8');
    const budget2 = rlConfig(prefix, { routes: Object.freeze({
      issue: Object.freeze({ rateMax: 2, rateWindowMs: 60000 }),
      complete: Object.freeze({ rateMax: 60, rateWindowMs: 60000 }),
      download: Object.freeze({ rateMax: 30, rateWindowMs: 60000 }),
      status: Object.freeze({ rateMax: 60, rateWindowMs: 60000 }),
    }) });
    const first = await buildRl04App({
      runtime: isolated,
      databaseUrl: isolated.databaseUrl,
      identityUnitOfWork,
      browserSessionAuthority: factory.authority,
      objectServerUrl: objectServer.url,
      attachmentsConfig: makeP03Config(),
      rateLimitConfig: budget2,
      keySecret,
    });
    openBundles.push(first);
    usedPrefixes.add(prefix);
    await waitUntil(
      () => first.rateLimit.facade.readiness().status === 'healthy',
      15_000,
      'first process store ready',
      25,
    );
    const before = await intentCount();
    assert.equal((await issueRequest(first.bundle.app, owner, randomUUID())).statusCode, 201);
    assert.equal((await issueRequest(first.bundle.app, owner, randomUUID())).statusCode, 201);
    assert.equal((await issueRequest(first.bundle.app, owner, randomUUID())).statusCode, 429,
      'the first process enforces its own budget');
    assert.equal(await intentCount(), before + 2, 'the first process created exactly two ledger rows');

    // "API restart": the first process closes completely (client + app); the
    // second process reuses the SAME Redis prefix + HMAC secret and therefore
    // sees the SAME counter (quota state lives in Redis, not in the process).
    await first.close();
    const budget5 = rlConfig(prefix, { routes: Object.freeze({
      issue: Object.freeze({ rateMax: 5, rateWindowMs: 60000 }),
      complete: Object.freeze({ rateMax: 60, rateWindowMs: 60000 }),
      download: Object.freeze({ rateMax: 30, rateWindowMs: 60000 }),
      status: Object.freeze({ rateMax: 60, rateWindowMs: 60000 }),
    }) });
    const second = await buildRl04App({
      runtime: isolated,
      databaseUrl: isolated.databaseUrl,
      identityUnitOfWork,
      browserSessionAuthority: factory.authority,
      objectServerUrl: objectServer.url,
      attachmentsConfig: makeP03Config(),
      rateLimitConfig: budget5,
      keySecret,
    });
    openBundles.push(second);
    await waitUntil(
      () => second.rateLimit.facade.readiness().status === 'healthy',
      15_000,
      'restarted process store ready',
      25,
    );

    // Config reload is a restart operation (plan §13.3): the counter survived
    // at 3, the reloaded budget (5) admits attempts 4-5, attempt 6 is denied
    // again — counters wait for their natural TTL, never a FLUSHDB.
    assert.equal((await issueRequest(second.bundle.app, owner, randomUUID())).statusCode, 201,
      'the restarted process sees the persisted counter and the reloaded budget');
    assert.equal((await issueRequest(second.bundle.app, owner, randomUUID())).statusCode, 201);
    const deniedAfterRestart = await issueRequest(second.bundle.app, owner, randomUUID());
    assert.equal(deniedAfterRestart.statusCode, 429, 'the counter persists across the restart');
    assert.equal(await intentCount(), before + 4, 'exactly the four allowed attempts created ledger rows');
    const restartKeys = (await raw!.keys(`${prefix}:*`)).filter((key) => key.includes(':issue:'));
    assert.equal(restartKeys.length, 1, 'one counter key shared by both processes');
    assert.equal(await raw!.get(restartKeys[0]!), '6', 'every network attempt across both processes counts');
  }, 60_000);

  test('Redis outage: issue/download fail closed 503 without quota facts; complete recovers with degraded evidence', async () => {
    assert.ok(container, 'container fixture must be running');
    const prefix = `rl04-${randomUUID()}`;
    const bundle = await newApp(rlConfig(prefix));
    const app = bundle.bundle.app;

    // Prepare an uploaded object while Redis is healthy.
    const body = p07Body(11);
    const issued = await p07Issue(app, owner, COLLECTION, body, randomUUID());
    const put = await p07Put(issued.grant.url, body);
    const binding = issued.receipt;
    const intentsBefore = await intentCount();
    const requestsBefore = objectServer.requests.length;

    const shutdown = await container.exec(['redis-cli', 'shutdown', 'nosave']);
    if (shutdown.exitCode !== 0) throw new Error(`redis-cli shutdown failed: ${shutdown.output}`);
    try {
      // issue: fail closed 503 with NO fabricated quota facts, zero DB work.
      const issueDenied = await issueRequest(app, owner, randomUUID());
      assert.equal(issueDenied.statusCode, 503);
      assert.equal(problemOf(issueDenied.body).error.code, 'rate_limit_unavailable');
      assert.equal(issueDenied.headers['retry-after'], undefined, '503 never fabricates a Retry-After');
      assert.equal(issueDenied.headers['ratelimit-policy'], undefined, '503 never fabricates a RateLimit-Policy');
      assert.equal(await intentCount(), intentsBefore, 'the 503 issue creates no ledger rows');

      // download: fail closed 503 before any use-case work.
      const downloadDenied = await p08Admit(app, other, randomUUID());
      assert.equal(downloadDenied.statusCode, 503);
      assert.equal(downloadDenied.headers['retry-after'], undefined);

      // complete: the bounded emergency limiter keeps the recovery entry open.
      const outboxBeforeFallback = await outboxCount();
      const fallback = await p07Complete(app, owner, binding, body, put.etag, randomUUID());
      assert.equal(fallback.statusCode, 200, `complete must recover through the emergency budget: ${fallback.body}`);
      assert.ok(fallback.body.includes('"completed"'), 'business recovery SUCCEEDED during the outage');
      assert.equal(await outboxCount(), outboxBeforeFallback + 1, 'the fallback complete committed exactly one verification job');

      // Degraded/fallback evidence (plan §4.2.7) — asserted TOGETHER with the
      // business success above.
      const fallbackLog = bundle.logEntries.find((entry) => entry.routeClass === 'complete' && entry.decision === 'fallback');
      assert.ok(fallbackLog, 'a fallback decision was logged');
      assert.equal(fallbackLog!.failureClass, 'unavailable', 'the fixed failure class is recorded');
      assert.equal(bundle.rateLimit.facade.readiness().status, 'degraded');
    } finally {
      const restore = await container.exec(['redis-server', '--daemonize', 'yes']);
      if (restore.exitCode !== 0) throw new Error(`redis-server restart failed: ${restore.output}`);
    }

    // Recovery after the server restart (the circuit probe + NOSCRIPT reload).
    let recovered = false;
    await waitUntil(async () => {
      const response = await issueRequest(app, owner, randomUUID());
      if (response.statusCode !== 201) return false;
      recovered = true;
      return bundle.rateLimit.facade.readiness().status === 'healthy';
    }, 30_000, 'issue recovers after the Redis restart', 100);
    assert.equal(recovered, true, 'the admission path recovers after the restart');
    assert.ok(objectServer.requests.length >= requestsBefore);
  }, 90_000);
});
