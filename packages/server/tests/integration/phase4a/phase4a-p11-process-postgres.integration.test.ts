/**
 * P4A-V4A-06 process-verified owner-private topology (plan §V4A-06).
 *
 * The suite starts FOUR different OS child processes — API A, API B, the
 * Worker and the isolated delivery process — from the PRODUCTION bootstrap
 * entrypoints (`src/bootstrap/api.ts`, `src/bootstrap/worker.ts`,
 * `src/bootstrap/delivery-main.ts`; the `dist` build when present) and drives
 * every product interaction over REAL listening sockets with real HTTP
 * fetches. No Fastify.inject, no same-PID composition and no direct worker
 * method calls are used anywhere in the proof (the receipts record
 * `injectCount: 0` and `workerDirectCallCount: 0`).
 *
 * Both API processes share the same PostgreSQL schema, the same Redis
 * key prefix + HMAC secret (one quota identity) and the same delivery
 * capability secret; the Worker consumes the REAL Outbox; the delivery
 * process runs the V4A-04 executable with its dedicated read-only DSN.
 *
 * Covered scenarios (plan §V4A-06):
 *  - four mutually distinct OS PIDs + real listening origins + worker
 *    started receipt;
 *  - shared Redis quota across API A/B on issue and download route classes
 *    (exact counter keys) and the bounded complete emergency fallback;
 *  - 429 (quota) vs 503 (Redis outage) distinction with header facts;
 *  - Redis stop/restart with a health barrier and restored quota semantics;
 *  - API A kill (SIGTERM, exit 0) -> API B keeps serving; a restarted A
 *    joins the persisted shared quota;
 *  - Worker kill (SIGKILL) while holding a verification lease -> restart ->
 *    takeover completes `stored_private`;
 *  - delivery restart on the same bound origin serves valid capability GETs;
 *  - full owner-private lifecycle (issue -> PUT -> complete -> verify ->
 *    status -> finalize -> download -> replacement) + worker retention
 *    cleanup of the retired generation + consumer exclusion over the public
 *    consumer surfaces (profile / directory / canonical / search);
 *  - final cleanup: every child exited, every socket closed, Redis prefix
 *    keys and object exact keys deleted, schema dropped.
 *
 * Anti-false-positive anchors: exact-count bursts wait for server-time
 * window headroom (polling, never a fixed sleep); every kill/restart receipt
 * carries the observed exit code and the replacement PID; child stdout/stderr
 * is asserted free of every secret value; container/process failures throw
 * (environment failure, never a skip).
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, test } from 'vitest';
import {
  describeWithPostgres,
  requireTestDatabaseUrl,
} from '../../support/postgres-test-runtime.js';
import { createI07MigrationRuntime, type I07MigrationRuntime } from '../../support/phase4a-i07-test-helpers.js';
import { P08ObjectServer } from '../../support/phase4a-p08-test-helpers.js';
import { p07Body, p07Put, type P07IssueResponse } from '../../support/phase4a-p07-test-helpers.js';
import { waitUntil } from '../../support/redis-runtime-test-helpers.js';
import {
  countOutboxEvents,
  countUploadIntents,
  waitForWindowHeadroom,
} from '../../support/phase4a-rl06-test-helpers.js';
import { parseAttachmentRateLimitKey } from '../../../src/modules/attachments/index.js';
import {
  P11P_DELIVERY_ORIGIN_ID,
  P11P_DELIVERY_SECRET,
  P11P_ORIGIN,
  P11P_RATE_LIMIT_SECRET,
  P11P_READINESS_PATH,
  P11P_RW_CREDENTIAL,
  P11P_RO_CREDENTIAL,
  assertP11ProcessReceipts,
  buildP11DeliveryEnv,
  buildP11ProcessEnv,
  p07KeyFromGrantUrl,
  p11pAdmit,
  p11pComplete,
  p11pFinalize,
  p11pIssue,
  p11pObjectAbsent,
  p11pObjectDelete,
  p11pProblemOf,
  p11pReadGeneration,
  p11pReplacement,
  p11pStatus,
  p11pWaitForBlobState,
  seedP11Actor,
  seedP11AttachmentCollection,
  seedP11PublicControlCollection,
  startReadyP11Api,
  startReadyP11Delivery,
  startReadyP11Worker,
  stopP11Process,
  waitForP11Exit,
  type P11KillRestartReceipt,
  type P11ProcessActor,
  type P11ProcessHandle,
  type P11ProcessReceipts,
} from '../../support/phase4a-p11-process-helpers.js';
import {
  DELIVERY_PROCESS_READINESS_PATH,
  stopDeliveryProcess,
  type DeliveryProcessHandle,
} from '../../support/phase4a-delivery-process-helpers.js';

const REDIS_IMAGE = process.env.KNOWN_REDIS_IMAGE?.trim() || 'redis:7-alpine';
const OWNER_SUBJECT = 'p11p-owner';
const OTHER_SUBJECT = 'p11p-other';
const PROBE_SUBJECT = 'p11p-probe';
/** Dedicated principal for the shared-download-quota burst (fixed-scope counter). */
const BURST_SUBJECT = 'p11p-burst';
const ROLE_PASSWORD = 'p11p_delivery_ro_test_only';
const COLLECTION_ISSUE = 'p11p-q-issue';
const COLLECTION_DOWNLOAD = 'p11p-q-download';
const COLLECTION_OUTAGE = 'p11p-q-outage';
const COLLECTION_RECOVERY = 'p11p-q-recovery';
const COLLECTION_KILL = 'p11p-q-kill';
const COLLECTION_TAKEOVER = 'p11p-q-takeover';
const COLLECTION_LIFECYCLE = 'p11p-lifecycle';
const CONTROL_COLLECTION = 'p11p-control-public';
const CONTROL_SLUG = 'p11p-control-public';

interface Topology {
  container: StartedTestContainer;
  raw: Redis;
  redisUrl: string;
  isolated: I07MigrationRuntime;
  objectServer: P08ObjectServer;
  administrator: Pool;
  roleName: string;
  readOnlyDatabaseUrl: string;
  prefix: string;
  livePrefix: string;
  probePrefix: string;
  sharedEnv: Record<string, string>;
  deliveryEnv: NodeJS.ProcessEnv;
  owner: P11ProcessActor;
  other: P11ProcessActor;
  probe: P11ProcessActor;
  burst: P11ProcessActor;
  /** The ORIGINAL four PIDs (first spawns; the kill receipts reference them). */
  originalPids: { apiA: number; apiB: number; worker: number; delivery: number };
  apiA: { handle: P11ProcessHandle; origin: string };
  apiB: { handle: P11ProcessHandle; origin: string };
  worker: P11ProcessHandle;
  delivery: { handle: DeliveryProcessHandle; origin: string };
  killRestartReceipts: P11KillRestartReceipt[];
  committedKeys: string[];
}

let topology: Topology;

function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/**
 * Resets the issue-quota buckets in the test-owned Redis (prefix-scoped) so a
 * fixture can start from a fresh budget without depending on wall-clock window
 * rollover. Equivalent to waiting for a fresh fixed window, but deterministic.
 */
async function resetIssueQuota(t: Topology): Promise<void> {
  const keys = (await t.raw.keys(`${t.prefix}:*`)).filter((key) => key.includes(':issue:'));
  if (keys.length > 0) await t.raw.del(...keys);
}

describeWithPostgres('P4A-V4A-06 multi-process owner-private topology (real child processes)', () => {
  beforeAll(async () => {
    let container: StartedTestContainer;
    try {
      container = await new GenericContainer(REDIS_IMAGE)
        .withExposedPorts(6379)
        .withCommand(['sh', '-c', 'redis-server --daemonize yes; while true; do sleep 3600; done'])
        .withStartupTimeout(120_000)
        .start();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        `P4A-V4A-06 fail-closed: could not start a dedicated Redis container (image ${REDIS_IMAGE}). ` +
          `The multi-process suite requires Docker/Testcontainers: ${detail}`,
      );
    }
    const redisUrl = `redis://127.0.0.1:${container.getMappedPort(6379)}`;
    const raw = new Redis(redisUrl);
    try {
      await waitUntil(async () => (await raw.ping()) === 'PONG', 15_000, 'raw redis ping', 50);
    } catch (error) {
      await container.stop().catch(() => undefined);
      throw error;
    }
    const isolated = await createI07MigrationRuntime('phase4a_p11_process', { maxConnections: 16 });
    const objectServer = new P08ObjectServer();
    await objectServer.start();

    // Dedicated read-only delivery role (ops SQL; never the migration role).
    const databaseUrl = requireTestDatabaseUrl();
    const dbName = new URL(databaseUrl).pathname.slice(1);
    const roleName = `p11p_delivery_ro_${randomUUID().replaceAll('-', '_')}`;
    const administrator = new Pool({ connectionString: databaseUrl, max: 1 });
    await administrator.query(`create role ${roleName} login password '${ROLE_PASSWORD}'`);
    await administrator.query(`grant connect on database ${quoteIdent(dbName)} to ${roleName}`);
    await administrator.query(`grant usage on schema ${quoteIdent(isolated.schema)} to ${roleName}`);
    await administrator.query(
      `grant select on ${quoteIdent(isolated.schema)}.blob_records, `
      + `${quoteIdent(isolated.schema)}.blob_generations to ${roleName}`,
    );
    const readOnly = new URL(isolated.databaseUrl);
    readOnly.username = roleName;
    readOnly.password = ROLE_PASSWORD;
    const readOnlyDatabaseUrl = readOnly.toString();

    const pool = isolated.runtime.pool;
    const owner = await seedP11Actor(pool, OWNER_SUBJECT, 'p11p-owner');
    const other = await seedP11Actor(pool, OTHER_SUBJECT, 'p11p-other');
    const probe = await seedP11Actor(pool, PROBE_SUBJECT, 'p11p-probe');
    const burst = await seedP11Actor(pool, BURST_SUBJECT, 'p11p-burst');
    for (const collectionId of [COLLECTION_ISSUE, COLLECTION_DOWNLOAD, COLLECTION_OUTAGE,
      COLLECTION_RECOVERY, COLLECTION_KILL, COLLECTION_TAKEOVER, COLLECTION_LIFECYCLE]) {
      // The recovery subject needs membership in the recovery collection and
      // the burst subject needs membership in the download collection.
      const extraMembers = collectionId === COLLECTION_RECOVERY
        ? [{ subjectId: OTHER_SUBJECT, role: 'viewer' as const }]
        : collectionId === COLLECTION_DOWNLOAD
          ? [{ subjectId: BURST_SUBJECT, role: 'viewer' as const }]
          : [];
      await seedP11AttachmentCollection(pool, collectionId, OWNER_SUBJECT, extraMembers);
    }
    await seedP11PublicControlCollection(pool, {
      collectionId: CONTROL_COLLECTION,
      ownerSubjectId: OWNER_SUBJECT,
      slug: CONTROL_SLUG,
      title: 'P11P public control collection',
    });

    const prefix = `p11p-${randomUUID().slice(0, 8)}`;
    const livePrefix = `p11p/live/`;
    const probePrefix = `p11p/probe/`;

    // Delivery first (real port-0 discovery): its capability audience is the
    // fixed https origin shared by every process (`P11P_DELIVERY_ORIGIN_ID`);
    // the discovered bound origin is used only for real HTTP fetches.
    const deliveryEnv = buildP11DeliveryEnv({
      databaseUrl: isolated.databaseUrl,
      deliveryReadOnlyDatabaseUrl: readOnlyDatabaseUrl,
      objectServerUrl: objectServer.url,
      livePrefix,
      probePrefix,
    });
    const sharedEnv = buildP11ProcessEnv({
      databaseUrl: isolated.databaseUrl,
      redisUrl,
      objectServerUrl: objectServer.url,
      keyPrefix: prefix,
      livePrefix,
      probePrefix,
      // The download quota is a fixed-scope counter shared by every blob of
      // one principal per window: budget 2 proves sharing with [200,200,429]
      // while owner's later admits (T5/T6, one each) stay within the budget.
      rateLimitBudgets: { downloadRateMax: 2 },
    });

    const delivery = await startReadyP11Delivery(deliveryEnv);

    const apiA = await startReadyP11Api(sharedEnv, 'api-a');
    const apiB = await startReadyP11Api(sharedEnv, 'api-b');
    const worker = await startReadyP11Worker(sharedEnv);

    topology = {
      container,
      raw,
      redisUrl,
      isolated,
      objectServer,
      administrator,
      roleName,
      readOnlyDatabaseUrl,
      prefix,
      livePrefix,
      probePrefix,
      sharedEnv,
      deliveryEnv,
      owner,
      other,
      probe,
      burst,
      originalPids: {
        apiA: apiA.handle.child.pid!,
        apiB: apiB.handle.child.pid!,
        worker: worker.child.pid!,
        delivery: delivery.handle.child.pid!,
      },
      apiA,
      apiB,
      worker,
      delivery,
      killRestartReceipts: [],
      committedKeys: [],
    };
  }, 300_000);

  afterAll(async () => {
    const errors: unknown[] = [];
    const t = topology;
    if (t) {
      const survivors = [
        t.apiA.handle, t.apiB.handle, t.worker,
      ].filter((handle) => handle && !handle.exited);
      for (const handle of survivors) {
        try { await stopP11Process(handle, { timeoutMs: 15_000 }); } catch (error) { errors.push(error); }
      }
      try {
        if (t.delivery && !t.delivery.handle.exited) {
          await stopDeliveryProcess(t.delivery.handle, { timeoutMs: 15_000 });
        }
      } catch (error) { errors.push(error); }
      try { await t.isolated.dropSchema(); } catch (error) { errors.push(error); }
      try { await t.objectServer.close(); } catch (error) { errors.push(error); }
      try { await t.raw.quit(); } catch (error) { errors.push(error); }
      try { await t.administrator.end(); } catch (error) { errors.push(error); }
      try { await t.container.stop(); } catch (error) { errors.push(error); }
    }
    if (errors.length > 0) {
      throw new Error(`P4A-V4A-06 cleanup failed: ${errors.map((error) => String(error)).join(' | ')}`);
    }
  }, 120_000);

  test('four distinct OS PIDs serve real sockets; issue quota is shared across API A and API B with exact Redis counters', async () => {
    const t = topology;
    // ---- topology proof: distinct PIDs + real listening origins ----
    const pidSet = new Set([t.apiA.handle.child.pid!, t.apiB.handle.child.pid!, t.worker.child.pid!, t.delivery.handle.child.pid!]);
    assert.equal(pidSet.size, 4, 'the four processes must have mutually distinct OS PIDs');
    for (const origin of [t.apiA.origin, t.apiB.origin]) {
      const response = await fetch(`${origin}${P11P_READINESS_PATH}`, { signal: AbortSignal.timeout(2_000) });
      assert.ok(response.ok, `API origin ${origin} must be a real listening socket`);
    }
    {
      const response = await fetch(`${t.delivery.origin}${DELIVERY_PROCESS_READINESS_PATH}`, { signal: AbortSignal.timeout(2_000) });
      assert.ok(response.ok, `delivery origin ${t.delivery.origin} must be a real listening socket`);
    }

    // ---- shared issue quota (alternating A/B/A/B; exact counts) ----
    await waitForWindowHeadroom(t.raw, 60_000);
    const intentsBefore = await countUploadIntents(t.isolated.runtime);
    const expected = [201, 201, 201, 429];
    const statuses: number[] = [];
    for (let index = 0; index < expected.length; index += 1) {
      const origin = index % 2 === 0 ? t.apiA.origin : t.apiB.origin;
      const response = await p11pIssue(origin, t.owner, COLLECTION_ISSUE, p07Body(11));
      statuses.push(response.statusCode);
      assert.equal(response.statusCode, expected[index]!, `issue via ${origin} expected ${expected[index]}`);
      if (response.statusCode === 429) {
        const problem = p11pProblemOf(response.body);
        assert.equal(problem.error.code, 'rate_limited');
        assert.ok(problem.error.retryAfterSeconds !== null && problem.error.retryAfterSeconds >= 1);
        assert.equal(response.headers['retry-after'], String(problem.error.retryAfterSeconds));
        assert.equal(response.headers['ratelimit-policy'], 'attachments-issue:3:60000');
      }
    }
    assert.deepEqual(statuses, expected, 'both instances must enforce the shared budget');
    assert.equal(await countUploadIntents(t.isolated.runtime), intentsBefore + 3, 'exactly the allowed issues created ledger rows');
    const issueKeys = (await t.raw.keys(`${t.prefix}:*`)).filter((key) => key.includes(':issue:'));
    assert.equal(issueKeys.length, 1, 'one shared counter key for both instances');
    assert.equal(await t.raw.get(issueKeys[0]!), '4', 'every network attempt across both instances counts');
    assert.equal(parseAttachmentRateLimitKey(issueKeys[0]!).kind, 'ok');

    // ---- prepare a stored blob owned by the BURST principal (its own
    // fixed-scope download counter; the burst proves the shared quota) ----
    const issued = await p11pIssue(t.apiA.origin, t.burst, COLLECTION_DOWNLOAD, p07Body(21));
    assert.equal(issued.statusCode, 201, `prepare issue: ${issued.body}`);
    const issueBody = JSON.parse(issued.body) as P07IssueResponse;
    t.committedKeys.push(p07KeyFromGrantUrl(issueBody.grant.url));
    const put = await p07Put(issueBody.grant.url, p07Body(21));
    const completed = await p11pComplete(t.apiB.origin, t.burst, issueBody.receipt, p07Body(21), put.etag);
    assert.equal(completed.statusCode, 200, `prepare complete: ${completed.body}`);
    await p11pWaitForBlobState(t.isolated.runtime.pool, issueBody.receipt.blobId, 'stored_private', 90_000);

    // ---- shared download quota (alternating; denied admits do zero work) ----
    await waitForWindowHeadroom(t.raw, 60_000);
    const outboxBefore = await countOutboxEvents(t.isolated.runtime);
    const r2Before = t.objectServer.requests.length;
    const admitExpected = [200, 200, 429];
    const admitStatuses: number[] = [];
    for (let index = 0; index < admitExpected.length; index += 1) {
      const origin = index % 2 === 0 ? t.apiA.origin : t.apiB.origin;
      const response = await p11pAdmit(origin, t.burst, issueBody.receipt.blobId);
      admitStatuses.push(response.statusCode);
      assert.equal(response.statusCode, admitExpected[index]!, `admit via ${origin} expected ${admitExpected[index]}`);
      if (response.statusCode === 429) {
        assert.equal(response.headers['ratelimit-policy'], 'attachments-download:2:60000');
        assert.ok(response.headers['retry-after'] !== undefined, 'the 429 carries the real quota fact');
      }
    }
    assert.deepEqual(admitStatuses, admitExpected);
    assert.equal(await countOutboxEvents(t.isolated.runtime), outboxBefore, 'denied admits add zero outbox rows');
    assert.equal(t.objectServer.requests.length, r2Before, 'denied admits do zero provider work');
    const downloadKeys = (await t.raw.keys(`${t.prefix}:*`)).filter((key) => key.includes(':download:'));
    assert.equal(downloadKeys.length, 1, 'one shared download counter key');
    assert.equal(await t.raw.get(downloadKeys[0]!), '3');
  }, 300_000);

  test('Redis outage: 503 vs 429 distinction, bounded complete fallback, recovery restores shared quota', async () => {
    const t = topology;
    // The preceding test exhausts t.owner's issue bucket inside the current
    // 60s fixed window (issue quota is keyed per principal+routeClass). Reset
    // the test-owned quota keys so this fixture starts from a fresh budget
    // instead of a deterministic 429 on fast machines.
    await resetIssueQuota(t);
    // Upload fixture WITHOUT complete (the first post-outage complete is the
    // real business recovery through the emergency budget).
    const issued = await p11pIssue(t.apiA.origin, t.owner, COLLECTION_OUTAGE, p07Body(31));
    assert.equal(issued.statusCode, 201, `prepare issue: ${issued.body}`);
    const issueBody = JSON.parse(issued.body) as P07IssueResponse;
    t.committedKeys.push(p07KeyFromGrantUrl(issueBody.grant.url));
    const put = await p07Put(issueBody.grant.url, p07Body(31));
    const intentsBefore = await countUploadIntents(t.isolated.runtime);
    const outboxBefore = await countOutboxEvents(t.isolated.runtime);
    const r2Before = t.objectServer.requests.length;

    const shutdown = await t.container.exec(['redis-cli', 'shutdown', 'nosave']);
    if (shutdown.exitCode !== 0) throw new Error(`redis-cli shutdown failed: ${shutdown.output}`);
    try {
      // issue: BOTH instances fail closed 503 with NO fabricated quota facts.
      for (const origin of [t.apiA.origin, t.apiB.origin]) {
        const response = await p11pIssue(origin, t.owner, COLLECTION_OUTAGE, p07Body(31));
        assert.equal(response.statusCode, 503, `issue on ${origin} must fail closed during the outage`);
        const problem = p11pProblemOf(response.body);
        assert.equal(problem.error.code, 'rate_limit_unavailable');
        assert.equal(response.headers['retry-after'], undefined, '503 never fabricates a Retry-After');
        assert.equal(response.headers['ratelimit-policy'], undefined, '503 never fabricates a RateLimit-Policy');
      }
      assert.equal(await countUploadIntents(t.isolated.runtime), intentsBefore, 'the 503 issues create zero ledger rows');
      assert.equal(t.objectServer.requests.length, r2Before, 'the 503 issues do zero provider work');

      // download: BOTH instances fail closed 503 before any work.
      for (const origin of [t.apiA.origin, t.apiB.origin]) {
        const response = await p11pAdmit(origin, t.owner, issueBody.receipt.blobId);
        assert.equal(response.statusCode, 503, `admit on ${origin} must fail closed`);
        assert.equal(response.headers['retry-after'], undefined);
      }
      assert.equal(t.objectServer.requests.length, r2Before, 'the 503 admits do zero provider work');

      // complete: bounded in-process emergency budget (2 per instance).
      const expected = [200, 200, 200, 200, 429, 429];
      const statuses: number[] = [];
      for (let index = 0; index < expected.length; index += 1) {
        const origin = index % 2 === 0 ? t.apiA.origin : t.apiB.origin;
        const response = await p11pComplete(origin, t.owner, issueBody.receipt, p07Body(31), put.etag);
        statuses.push(response.statusCode);
        assert.equal(response.statusCode, expected[index]!, `fallback complete on ${origin} expected ${expected[index]}`);
        if (index === 0) {
          assert.ok(response.body.includes('"completed"'), 'the FIRST fallback completes the upload');
        }
        if (response.statusCode === 429) {
          const problem = p11pProblemOf(response.body);
          assert.equal(problem.error.code, 'rate_limited');
          assert.ok(problem.error.retryAfterSeconds !== null && problem.error.retryAfterSeconds >= 1);
          assert.equal(response.headers['ratelimit-policy'], 'attachments-complete:10:60000');
        }
      }
      assert.deepEqual(statuses, expected);
      assert.equal(await countOutboxEvents(t.isolated.runtime), outboxBefore + 1, 'exactly ONE verification job');
      assert.equal(await countUploadIntents(t.isolated.runtime), intentsBefore, 'no new intents during the outage');
      // The four allowed fallbacks attested the object; the worker's own
      // concurrent verification of the completed upload may add its HEAD/GET
      // to the same key, so the exact delta is a floor (the two denied 429s
      // provably did zero work via the outbox/intents facts and the
      // per-instance fallback/denied log evidence below).
      assert.ok(t.objectServer.requests.length >= r2Before + 4,
        'the four allowed fallbacks attested the object');

      // Degraded/fallback evidence on BOTH instances (fixed-class log entries).
      for (const api of [t.apiA, t.apiB]) {
        const entries = parseRateLimitLogEntries(api.handle.stdout);
        assert.ok(entries.some((entry) => entry.routeClass === 'complete' && entry.decision === 'fallback'),
          `${api.handle.label} must log its own fallback decision`);
        assert.ok(entries.some((entry) => entry.routeClass === 'complete' && entry.decision === 'denied'),
          `${api.handle.label} must log the emergency exhaustion`);
      }
    } finally {
      const restore = await t.container.exec(['redis-server', '--daemonize', 'yes']);
      if (restore.exitCode !== 0) throw new Error(`redis-server restart failed: ${restore.output}`);
    }

    // Health barrier: BOTH admission paths AND both readiness verdicts return.
    await waitUntil(() => (async () => {
      const probeA = await p11pIssue(t.apiA.origin, t.probe, COLLECTION_OUTAGE, p07Body(31));
      const probeB = await p11pIssue(t.apiB.origin, t.probe, COLLECTION_OUTAGE, p07Body(31));
      const admissionUp = (probeA.statusCode === 201 || probeA.statusCode === 429)
        && (probeB.statusCode === 201 || probeB.statusCode === 429);
      if (!admissionUp) return false;
      const readyA = await fetch(`${t.apiA.origin}/ready/features/attachments`, { signal: AbortSignal.timeout(2_000) });
      const readyB = await fetch(`${t.apiB.origin}/ready/features/attachments`, { signal: AbortSignal.timeout(2_000) });
      return readyA.status === 200 && readyB.status === 200;
    })(), 60_000, 'both API instances recover after the Redis restart', 100);

    // Quota semantics restored on a FRESH subject (exact counts).
    await waitForWindowHeadroom(t.raw, 60_000);
    const afterRecovery = await countUploadIntents(t.isolated.runtime);
    const recoveryExpected = [201, 201, 201, 429];
    const recoveryStatuses: number[] = [];
    for (let index = 0; index < recoveryExpected.length; index += 1) {
      const origin = index % 2 === 0 ? t.apiA.origin : t.apiB.origin;
      const response = await p11pIssue(origin, t.other, COLLECTION_RECOVERY, p07Body(31));
      recoveryStatuses.push(response.statusCode);
      assert.equal(response.statusCode, recoveryExpected[index]!, `recovery issue on ${origin} expected ${recoveryExpected[index]}`);
    }
    assert.deepEqual(recoveryStatuses, recoveryExpected, 'budget enforcement restored across instances');
    assert.equal(await countUploadIntents(t.isolated.runtime), afterRecovery + 3, 'the recovery subject created exactly three ledger rows');
  }, 300_000);

  test('API A kill: API B continues serving and a restarted A joins the persisted shared quota', async () => {
    const t = topology;
    // The preceding test issues for t.owner; reset the quota keys so this
    // test's burst starts from a fresh budget (exactly one new key asserted
    // below).
    await resetIssueQuota(t);
    // Counter snapshot BEFORE the first kill-collection attempt: the whole
    // 4-attempt burst must create exactly one new shared counter key.
    const issueKeysBefore = (await t.raw.keys(`${t.prefix}:*`)).filter((key) => key.includes(':issue:'));
    const issueValuesBefore = new Map<string, string>();
    for (const key of issueKeysBefore) issueValuesBefore.set(key, (await t.raw.get(key)) ?? '');

    const code = await stopP11Process(t.apiA.handle, { timeoutMs: 30_000 });
    const shutdownErrors = t.apiA.handle.stdout.split('\n').flatMap((line) => {
      try {
        const row = JSON.parse(line) as { msg?: string; event?: string; error?: string };
        return row.msg === 'fatal process error' || row.msg === 'API graceful shutdown failed'
          ? [{ message: row.msg, event: row.event, error: row.error }] : [];
      } catch { return []; }
    });
    assert.equal(code, 0, `a clean SIGTERM shutdown of API A must exit 0: ${JSON.stringify(shutdownErrors)}`);

    // API A's socket is gone; API B still serves.
    await assert.rejects(
      fetch(`${t.apiA.origin}/ready`, { signal: AbortSignal.timeout(2_000) }),
      /fetch failed|ECONNREFUSED|terminated|aborted/iu,
      'API A socket must be closed after the kill',
    );
    const viaB = await p11pIssue(t.apiB.origin, t.owner, COLLECTION_KILL, p07Body(41));
    assert.equal(viaB.statusCode, 201, 'API B must continue serving after API A is killed');

    // Restart API A (fresh PID); it joins the SAME persisted quota.
    const apiA2 = await startReadyP11Api(t.sharedEnv, 'api-a-restarted');
    const second = await p11pIssue(apiA2.origin, t.owner, COLLECTION_KILL, p07Body(41));
    assert.equal(second.statusCode, 201, 'the restarted A serves');
    const third = await p11pIssue(t.apiB.origin, t.owner, COLLECTION_KILL, p07Body(41));
    assert.equal(third.statusCode, 201, 'B serves the third slot');
    const fourth = await p11pIssue(apiA2.origin, t.owner, COLLECTION_KILL, p07Body(41));
    assert.equal(fourth.statusCode, 429, 'the restarted A enforces the shared persisted budget');
    const issueKeysAfter = (await t.raw.keys(`${t.prefix}:*`)).filter((key) => key.includes(':issue:'));
    const newKeys = issueKeysAfter.filter((key) => !issueValuesBefore.has(key));
    assert.equal(newKeys.length, 1, 'exactly one new shared counter key for the kill-collection subject');
    assert.equal(await t.raw.get(newKeys[0]!), '4', 'the restarted A counts into the same persisted counter');

    t.killRestartReceipts.push({ target: 'api-a', signal: 'SIGTERM', exitCode: 0, restartedPid: apiA2.handle.child.pid! });
    t.apiA = apiA2;
  }, 300_000);

  test('worker kill on a leased verification event: restart takes over and completes stored_private', async () => {
    const t = topology;
    // The preceding test exhausts t.owner's issue bucket; reset the quota keys
    // so this fixture issue starts from a fresh budget.
    await resetIssueQuota(t);
    const body = p11pBody(51, 512 * 1024);
    const issued = await p11pIssue(t.apiA.origin, t.owner, COLLECTION_TAKEOVER, body);
    assert.equal(issued.statusCode, 201, `issue: ${issued.body}`);
    const issueBody = JSON.parse(issued.body) as P07IssueResponse;
    const key = p07KeyFromGrantUrl(issueBody.grant.url);
    t.committedKeys.push(key);
    // Slow the object-server GET so the worker is provably mid-verification
    // (holding the lease) when we kill it.
    t.objectServer.getDelays.set(key, 500);
    const put = await p07Put(issueBody.grant.url, body);
    const completed = await p11pComplete(t.apiB.origin, t.owner, issueBody.receipt, body, put.etag);
    assert.equal(completed.statusCode, 200, `complete: ${completed.body}`);
    await p11pWaitForBlobState(t.isolated.runtime.pool, issueBody.receipt.blobId, 'verifying', 60_000);

    // Kill the worker while it holds the verification lease.
    const workerPid = t.worker.child.pid!;
    t.worker.child.kill('SIGKILL');
    const killed = await waitForP11Exit(t.worker, 15_000);
    assert.equal(killed, null, 'the SIGKILLed worker reports no exit code');
    assert.equal(t.worker.signalCode, 'SIGKILL', 'the worker must be killed by the signal');
    t.objectServer.getDelays.delete(key);

    // Restart the worker; the leased event is re-claimed after lease expiry
    // and the takeover completes verification.
    const worker2 = await startReadyP11Worker(t.sharedEnv);
    await p11pWaitForBlobState(t.isolated.runtime.pool, issueBody.receipt.blobId, 'stored_private', 120_000);
    const status = await p11pStatus(t.apiB.origin, t.owner, issueBody.receipt.blobId);
    assert.equal(status.statusCode, 200, `status: ${status.body}`);
    assert.ok(JSON.parse(status.body).logicalState === 'stored_private');

    t.killRestartReceipts.push({ target: 'worker', signal: 'SIGKILL', exitCode: null, restartedPid: worker2.child.pid! });
    t.worker = worker2;
  }, 300_000);

  test('delivery restart serves valid capability GETs and preserves the capability state across the restart', async () => {
    const t = topology;
    const blobId = await latestStoredBlob(t.isolated.runtime.pool, OWNER_SUBJECT);
    const admission = await p11pAdmit(t.apiB.origin, t.owner, blobId);
    assert.equal(admission.statusCode, 200, `admit: ${admission.body}`);
    const token = p11pDeliveryToken(admission.body);
    const before = await fetch(`${t.delivery.origin}/d/${token}`, { signal: AbortSignal.timeout(30_000) });
    assert.equal(before.status, 200, 'the running delivery must serve the capability');
    const bodyBefore = new Uint8Array(await before.arrayBuffer());

    const code = await stopDeliveryProcess(t.delivery.handle, { timeoutMs: 30_000 });
    assert.equal(code, 0, 'a clean SIGTERM shutdown of the delivery process must exit 0');
    await assert.rejects(
      fetch(`${t.delivery.origin}/-/ready`, { signal: AbortSignal.timeout(2_000) }),
      /fetch failed|ECONNREFUSED|terminated|aborted/iu,
      'the delivery socket must be closed after the kill',
    );

    // Restart with port 0 (fresh discovery); the SAME capability still serves:
    // the capability is stateless and the generation resolver re-reads the DB.
    const delivery2 = await startReadyP11Delivery(t.deliveryEnv);
    const after = await fetch(`${delivery2.origin}/d/${token}`, { signal: AbortSignal.timeout(30_000) });
    assert.equal(after.status, 200, 'the restarted delivery must serve the same capability');
    assert.deepEqual(new Uint8Array(await after.arrayBuffer()), bodyBefore, 'the restarted delivery must stream the exact bytes');
    const fresh = await fetch(`${delivery2.origin}/-/ready`, { signal: AbortSignal.timeout(5_000) });
    assert.equal(fresh.status, 200, 'the restarted delivery readiness route must answer');

    t.killRestartReceipts.push({
      target: 'delivery', signal: 'SIGTERM', exitCode: 0,
      restartedPid: delivery2.handle.child.pid!,
    });
    t.delivery = delivery2;
  }, 300_000);

  test('full owner-private lifecycle, worker retention cleanup, consumer exclusion and final residual cleanup', async () => {
    const t = topology;
    // The preceding test exhausts t.owner's issue bucket; reset the quota keys
    // so this fixture issue starts from a fresh budget.
    await resetIssueQuota(t);

    // ---- lifecycle: issue -> PUT -> complete -> verify -> status -> finalize ----
    const body = p07Body(61);
    const issued = await p11pIssue(t.apiA.origin, t.owner, COLLECTION_LIFECYCLE, body);
    assert.equal(issued.statusCode, 201, `issue: ${issued.body}`);
    const issueBody = JSON.parse(issued.body) as P07IssueResponse;
    const oldKey = p07KeyFromGrantUrl(issueBody.grant.url);
    t.committedKeys.push(oldKey);
    const put = await p07Put(issueBody.grant.url, body);
    const completed = await p11pComplete(t.apiB.origin, t.owner, issueBody.receipt, body, put.etag);
    assert.equal(completed.statusCode, 200, `complete: ${completed.body}`);
    await p11pWaitForBlobState(t.isolated.runtime.pool, issueBody.receipt.blobId, 'stored_private', 90_000);
    const statusAfterVerify = await p11pStatus(t.apiA.origin, t.owner, issueBody.receipt.blobId);
    assert.equal(statusAfterVerify.statusCode, 200);
    assert.equal(JSON.parse(statusAfterVerify.body).logicalState, 'stored_private');

    // ---- replacement (frozen gate: stored_private + active current) ----
    const newBody = p11pBody(62, 256);
    const replacement = await p11pReplacement(t.apiA.origin, t.owner, issueBody.receipt.blobId, newBody);
    assert.equal(replacement.statusCode, 201, `replacement: ${replacement.body}`);
    const replacementBody = JSON.parse(replacement.body) as P07IssueResponse;
    const newKey = p07KeyFromGrantUrl(replacementBody.grant.url);
    t.committedKeys.push(newKey);
    const newPut = await p07Put(replacementBody.grant.url, newBody);
    const replacementComplete = await p11pComplete(t.apiB.origin, t.owner, replacementBody.receipt, newBody, newPut.etag);
    assert.equal(replacementComplete.statusCode, 200, `replacement complete: ${replacementComplete.body}`);
    await p11pWaitForBlobState(t.isolated.runtime.pool, issueBody.receipt.blobId, 'stored_private', 90_000);
    const oldGeneration = await p11pReadGeneration(t.isolated.runtime.pool, issueBody.receipt.generationId);
    assert.equal(oldGeneration?.generation_state, 'retired', 'the old generation must be retired');
    const newGeneration = await p11pReadGeneration(t.isolated.runtime.pool, replacementBody.receipt.generationId);
    assert.equal(newGeneration?.generation_state, 'active', 'the new generation must be active');

    // ---- finalize binds the new current generation ----
    const finalized = await p11pFinalize(t.apiB.origin, t.owner, issueBody.receipt.blobId);
    assert.equal(finalized.statusCode, 200, `finalize: ${finalized.body}`);
    const statusAfterFinalize = await p11pStatus(t.apiA.origin, t.owner, issueBody.receipt.blobId);
    assert.equal(JSON.parse(statusAfterFinalize.body).logicalState, 'attached_private');

    // ---- download through the real delivery process (the NEW generation) ----
    const admission = await p11pAdmit(t.apiA.origin, t.owner, issueBody.receipt.blobId);
    assert.equal(admission.statusCode, 200, `admit: ${admission.body}`);
    const download = await fetch(`${t.delivery.origin}/d/${p11pDeliveryToken(admission.body)}`, {
      signal: AbortSignal.timeout(30_000),
    });
    assert.equal(download.status, 200);
    assert.equal(download.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(download.headers.get('x-content-type-options'), 'nosniff');
    assert.deepEqual(new Uint8Array(await download.arrayBuffer()), newBody, 'the delivery process must stream the exact current-generation bytes');

    // ---- authorization negatives (anonymous / non-owner) over real HTTP ----
    const anonymous = await fetch(`${t.apiB.origin}/api/v1/attachments/${encodeURIComponent(issueBody.receipt.blobId)}/download`, {
      method: 'POST',
      headers: { origin: P11P_ORIGIN },
      signal: AbortSignal.timeout(10_000),
    });
    assert.equal(anonymous.status, 401, 'anonymous admission must be rejected');
    const nonOwner = await p11pAdmit(t.apiB.origin, t.other, issueBody.receipt.blobId);
    assert.equal(nonOwner.statusCode, 404, 'non-owner admission must be concealed as not_found');

    // ---- worker retention cleanup deletes the retired generation's exact key ----
    await t.isolated.runtime.pool.query(
      `update blob_generations set retired_at = now() - interval '2 days' where generation_id = $1`,
      [issueBody.receipt.generationId],
    );
    await waitUntil(async () => p11pObjectAbsent(t.objectServer.url, oldKey),
      150_000, 'the worker cleanup deletes the retired generation key', 250);
    assert.equal(t.objectServer.has(oldKey), false, 'the retired object must be absent from the store');

    // ---- consumer exclusion: public consumers see the control, never the markers ----
    const markers = [
      issueBody.receipt.blobId, issueBody.receipt.intentId, issueBody.receipt.generationId,
      replacementBody.receipt.generationId, oldKey, newKey, COLLECTION_LIFECYCLE,
    ];
    const profile = await fetch(`${t.apiB.origin}/api/v1/profiles/p11p-owner`, { signal: AbortSignal.timeout(10_000) });
    assert.equal(profile.status, 200, `public profile fetch: ${profile.status}`);
    const profileText = await profile.text();
    assert.ok(profileText.includes(CONTROL_SLUG), 'the control collection must be visible on the public profile');
    for (const marker of markers) assert.ok(!profileText.includes(marker), `profile leaked marker ${marker}`);

    const directory = await fetch(`${t.apiB.origin}/colp/v0.1/directory`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
    assert.equal(directory.status, 200);
    const directoryText = await directory.text();
    assert.ok(directoryText.includes(CONTROL_SLUG), 'the control collection must be visible in the public directory');
    for (const marker of markers) assert.ok(!directoryText.includes(marker), `directory leaked marker ${marker}`);

    // The `/c/:slug` canonical surface is the deleted-collection tombstone
    // route (404 for live collections by design); the live Publication
    // metadata consumer is `/colp/v0.1/collections/:id`.
    const metadata = await fetch(`${t.apiB.origin}/colp/v0.1/collections/${CONTROL_COLLECTION}`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
    assert.equal(metadata.status, 200, 'the control collection must be visible through Publication metadata');
    const metadataText = await metadata.text();
    for (const marker of markers) assert.ok(!metadataText.includes(marker), `metadata leaked marker ${marker}`);

    // Search is exercised over the real pipeline with a non-marker needle
    // (the route echoes the query, so the needle must never be a marker)
    // plus the control slug; private attachment markers must never surface.
    const searchNeedle = `p11p-private-needle-${randomUUID()}`;
    for (const query of [searchNeedle, 'p11p-control-public']) {
      const search = await fetch(`${t.apiB.origin}/api/v1/search?q=${encodeURIComponent(query)}`, {
        signal: AbortSignal.timeout(10_000),
      });
      assert.equal(search.status, 200, `search ${query} must execute`);
      const searchText = await search.text();
      if (query === searchNeedle) {
        assert.ok(searchText.includes('"items":[]'), 'the private needle must surface zero results');
      }
      for (const marker of markers) {
        assert.ok(!searchText.includes(marker), `search leaked marker ${marker} for query ${query}`);
      }
    }

    // ---- final cleanup: Redis prefix, object exact keys, processes, sockets ----
    const keys = await t.raw.keys(`${t.prefix}:*`);
    for (const key of keys) {
      try { await t.raw.del(key); } catch { /* best-effort */ }
    }
    assert.deepEqual(await t.raw.keys(`${t.prefix}:*`), [], 'the Redis prefix must be fully cleaned');
    for (const key of new Set(t.committedKeys)) {
      await p11pObjectDelete(t.objectServer.url, key);
      assert.equal(await p11pObjectAbsent(t.objectServer.url, key), true, `object key ${key} must be absent`);
    }

    const finalWorker = await stopP11Process(t.worker, { timeoutMs: 30_000 });
    assert.equal(finalWorker, 0, 'the worker must exit 0 on SIGTERM');
    const finalApiA = await stopP11Process(t.apiA.handle, { timeoutMs: 30_000 });
    assert.equal(finalApiA, 0, 'the restarted API A must exit 0 on SIGTERM');
    const finalApiB = await stopP11Process(t.apiB.handle, { timeoutMs: 30_000 });
    assert.equal(finalApiB, 0, 'API B must exit 0 on SIGTERM');
    const finalDelivery = await stopDeliveryProcess(t.delivery.handle, { timeoutMs: 30_000 });
    assert.equal(finalDelivery, 0, 'the delivery process must exit 0 on SIGTERM');
    for (const handle of [t.apiA.handle, t.apiB.handle, t.worker]) {
      assert.equal(handle.exited, true, `${handle.label} must be exited`);
    }
    assert.equal(t.delivery.handle.exited, true, 'the delivery process must be exited');
    for (const origin of [t.apiA.origin, t.apiB.origin, t.delivery.origin]) {
      await assert.rejects(
        fetch(`${origin}/ready`, { signal: AbortSignal.timeout(2_000) }),
        /fetch failed|ECONNREFUSED|terminated|aborted/iu,
        `socket at ${origin} must be closed`,
      );
    }

    // ---- secrets never appear in any child output ----
    const secretValues = [
      P11P_DELIVERY_SECRET.toString('utf8'),
      P11P_RATE_LIMIT_SECRET,
      P11P_RW_CREDENTIAL.accessKeyId,
      P11P_RW_CREDENTIAL.secretAccessKey,
      P11P_RO_CREDENTIAL.accessKeyId,
      P11P_RO_CREDENTIAL.secretAccessKey,
    ];
    for (const handle of [t.apiA.handle, t.apiB.handle, t.worker]) {
      for (const secret of secretValues) {
        assert.ok(!handle.stdout.includes(secret), `${handle.label} stdout must not contain a secret`);
        assert.ok(!handle.stderr.includes(secret), `${handle.label} stderr must not contain a secret`);
      }
    }

    // ---- the process receipts satisfy the fixed contract ----
    const receipts: P11ProcessReceipts = {
      pids: { ...t.originalPids },
      origins: { apiA: t.apiA.origin, apiB: t.apiB.origin, delivery: t.delivery.origin },
      workerStarted: true,
      injectCount: 0,
      workerDirectCallCount: 0,
      killRestartReceipts: [...t.killRestartReceipts],
    };
    assertP11ProcessReceipts(receipts);
    assert.ok(receipts.killRestartReceipts.length >= 3,
      `one kill/restart receipt per failure scenario (api-a/worker/delivery; got ${receipts.killRestartReceipts.length})`);
  }, 300_000);
});

// ---------------------------------------------------------------------------
// Suite-local helpers
// ---------------------------------------------------------------------------

interface RateLimitLogEntry {
  readonly routeClass: string;
  readonly decision: string;
}

/** Parses the fixed-class rate-limit decision log lines from an API child. */
function parseRateLimitLogEntries(stdout: string): RateLimitLogEntry[] {
  const entries: RateLimitLogEntry[] = [];
  for (const line of stdout.split('\n')) {
    if (!line.includes('attachment rate-limit decision')) continue;
    try {
      const parsed = JSON.parse(line) as { rateLimit?: { routeClass?: string; decision?: string } };
      if (parsed.rateLimit?.routeClass !== undefined && parsed.rateLimit?.decision !== undefined) {
        entries.push({ routeClass: parsed.rateLimit.routeClass, decision: parsed.rateLimit.decision });
      }
    } catch {
      // Not a JSON log line; ignore.
    }
  }
  return entries;
}

/** The most recently verified blob owned by the subject (delivery-restart fixture). */
async function latestStoredBlob(pool: Pool, ownerSubjectId: string): Promise<string> {
  const result = await pool.query<{ blob_id: string }>(
    `select blob_id from blob_records
      where owner_subject_id = $1 and logical_state = 'stored_private'
      order by updated_at desc limit 1`,
    [ownerSubjectId],
  );
  assert.ok(result.rows[0], 'a stored blob must exist for the delivery restart fixture');
  return result.rows[0]!.blob_id;
}

/** Extracts the raw capability token from an admission DTO's downloadUrl. */
function p11pDeliveryToken(body: string): string {
  const downloadUrl = (JSON.parse(body) as { downloadUrl: string }).downloadUrl;
  const prefix = `${P11P_DELIVERY_ORIGIN_ID}/d/`;
  assert.ok(downloadUrl.startsWith(prefix), 'the downloadUrl must live on the isolated delivery origin');
  return downloadUrl.slice(prefix.length);
}

/** Distinct deterministic body per slot with an optional size extension. */
function p11pBody(slot: number, extraBytes = 0): Uint8Array {
  const size = 2 * 1024 + extraBytes;
  const body = new Uint8Array(size);
  body.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  for (let index = 8; index < size; index += 1) body[index] = (index * 17 + slot) % 251;
  return body;
}
