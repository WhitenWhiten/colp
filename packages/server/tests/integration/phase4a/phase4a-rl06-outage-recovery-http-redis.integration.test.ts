/**
 * P4A-RL06 Redis outage / recovery / complete emergency fallback scenario
 * (plan §8 RL06, §2.2.2-§2.2.4, §4.2.7, §13.3). Real PostgreSQL via
 * `scripts/with-postgres.mjs` + real Redis via Testcontainers
 * `redis:7-alpine` + HTTP. The quota-sharing scenarios live in the sibling
 * suite `phase4a-rl06-multi-replica-http-redis.integration.test.ts`.
 *
 * The suite runs TWO concurrent production API compositions (own Redis
 * clients, own in-process limiters) over the shared PostgreSQL/Redis, so the
 * outage verdicts are proven per instance and the complete emergency budget
 * is proven per instance (bounded, never unbounded admission).
 *
 * Anti-false-positive anchors (plan §4.1.9/§4.1.10/§4.2.7):
 *  - the Redis-outage 503s (issue/download) are asserted with NO
 *    Retry-After/RateLimit-Policy and zero DB/R2/use-case side effects;
 *  - the complete emergency fallback asserts business recovery SUCCESS and
 *    the degraded/fallback evidence TOGETHER (per instance), and the
 *    emergency exhaustion is a real local quota fact (429 with Retry-After);
 *  - denials during the outage do zero provider work (object-server request
 *    log unchanged).
 *
 * Anti-false-negative anchors:
 *  - the outage stops the real redis-server PROCESS (`redis-cli shutdown
 *    nosave`) and restarts it; recovery uses a HEALTH BARRIER (poll BOTH
 *    HTTP admission paths AND both readiness verdicts with a dedicated probe
 *    subject — no fixed sleeps; a circuit breaker only transitions through a
 *    real store check, so an instance that receives no traffic after the
 *    restart would stay degraded forever), then quota semantics are
 *    re-proven with exact counts on a fresh subject;
 *  - container exec failures throw (environment failure, never a skip).
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, test } from 'vitest';
import { describeWithPostgres } from '../../support/postgres-test-runtime.js';
import { makeP03Config } from '../../support/phase4a-p03-test-helpers.js';
import { p07Body } from '../../support/phase4a-p07-test-helpers.js';
import type { Rl04AppBundle } from '../../support/phase4a-rl04-test-helpers.js';
import {
  alternate,
  buildRl06Pair,
  countOutboxEvents,
  countUploadIntents,
  makeRl06RateLimitConfig,
  prepareUploaded,
  rl06Admit,
  rl06Complete,
  rl06Issue,
  rl06ProblemOf,
  startRl06SuiteEnv,
  waitForWindowHeadroom,
  type Rl06Pair,
  type Rl06SuiteEnv,
} from '../../support/phase4a-rl06-test-helpers.js';
import { parseAttachmentRateLimitKey, type AttachmentRateLimitConfig } from '../../../src/modules/attachments/index.js';
import { waitUntil } from '../../support/redis-runtime-test-helpers.js';
import { RL06_COLLECTION } from '../../support/phase4a-rl06-test-helpers.js';

let env: Rl06SuiteEnv;
const usedPrefixes = new Set<string>();
const openBundles: Rl04AppBundle[] = [];

/** A pair of concurrent instances sharing prefix + HMAC secret (one quota). */
async function newPair(
  prefix: string,
  overrides: Partial<AttachmentRateLimitConfig> = {},
): Promise<Rl06Pair> {
  const pair = await buildRl06Pair({
    runtime: env.isolated,
    databaseUrl: env.isolated.databaseUrl,
    identityUnitOfWork: env.identityUnitOfWork,
    browserSessionAuthority: env.factory.authority,
    objectServerUrl: env.objectServer.url,
    attachmentsConfig: makeP03Config(),
    rateLimitConfig: makeRl06RateLimitConfig(env.redisUrl, prefix, overrides),
    keySecret: Buffer.from(`rl06-secret-${randomUUID()}`, 'utf8'),
  });
  openBundles.push(pair.a.bundle, pair.b.bundle);
  usedPrefixes.add(prefix);
  return pair;
}

describeWithPostgres('P4A-RL06 Redis outage, emergency fallback and recovery', () => {
  beforeAll(async () => {
    env = await startRl06SuiteEnv();
  }, 240_000);

  afterEach(async () => {
    // Exact-key cleanup for every run prefix used by this suite (no
    // FLUSHALL/FLUSHDB; KEYS is a test-only cleanup scan, never application).
    for (const prefix of usedPrefixes) {
      const keys = await env.raw.keys(`${prefix}:*`);
      for (const key of keys) {
        try { await env.raw.del(key); } catch { /* best-effort */ }
      }
    }
    usedPrefixes.clear();
    const open = openBundles.splice(0, openBundles.length);
    await Promise.all(open.map((bundle) => bundle.close().catch(() => undefined)));
  }, 30_000);

  afterAll(async () => {
    const errors: unknown[] = [];
    try { await env?.dropSchema(); } catch (error) { errors.push(error); }
    try { await env?.stop(); } catch (error) { errors.push(error); }
    if (errors.length > 0) {
      throw new Error(`P4A-RL06 outage cleanup failed: ${errors.map((error) => String(error)).join(' | ')}`);
    }
  }, 60_000);

  test('Redis outage: issue/download fail closed 503 with zero side effects; complete recovers through the bounded emergency budget; recovery restores quota semantics', async () => {
    assert.ok(env.container, 'container fixture must be running');
    const prefix = `rl06-${randomUUID()}`;
    const pair = await newPair(prefix, {
      routes: Object.freeze({
        issue: Object.freeze({ rateMax: 2, rateWindowMs: 60000 }),
        complete: Object.freeze({ rateMax: 60, rateWindowMs: 60000 }),
        download: Object.freeze({ rateMax: 2, rateWindowMs: 60000 }),
        status: Object.freeze({ rateMax: 60, rateWindowMs: 60000 }),
      }),
      completeEmergency: Object.freeze({ rateMax: 2, rateWindowMs: 60000 }),
    });
    await waitForWindowHeadroom(env.raw, 60000);
    // issue + PUT only: the binding stays `uploaded` so the FIRST fallback
    // below is the real completion (business recovery through the emergency
    // budget, plan §4.2.7) and every later replay converges idempotently.
    const { binding, etag } = await prepareUploaded(pair, env.owner, p07Body(31));
    const intentsBefore = await countUploadIntents(env.isolated.runtime);
    const outboxBefore = await countOutboxEvents(env.isolated.runtime);
    const r2Before = env.objectServer.requests.length;
    const callsBefore = pair.a.downloadCalls() + pair.b.downloadCalls();

    const shutdown = await env.container.exec(['redis-cli', 'shutdown', 'nosave']);
    if (shutdown.exitCode !== 0) throw new Error(`redis-cli shutdown failed: ${shutdown.output}`);
    try {
      // issue: BOTH instances fail closed 503 with NO fabricated quota facts.
      for (const instance of [pair.a, pair.b]) {
        const response = await rl06Issue(instance, env.owner, randomUUID(), RL06_COLLECTION);
        assert.equal(response.statusCode, 503, `issue on ${instance.name} must fail closed during the outage`);
        const problem = rl06ProblemOf(response.body);
        assert.equal(problem.error.code, 'rate_limit_unavailable');
        assert.equal(problem.error.sameRequestRetrySafe, true);
        assert.equal(response.headers['retry-after'], undefined, '503 never fabricates a Retry-After');
        assert.equal(response.headers['ratelimit-policy'], undefined, '503 never fabricates a RateLimit-Policy');
      }
      assert.equal(await countUploadIntents(env.isolated.runtime), intentsBefore, 'the 503 issues create zero ledger rows');
      assert.equal(env.objectServer.requests.length, r2Before, 'the 503 issues do zero R2 work');

      // download: BOTH instances fail closed 503 before any use-case work.
      for (const instance of [pair.a, pair.b]) {
        const response = await rl06Admit(instance, env.owner, binding.blobId);
        assert.equal(response.statusCode, 503, `download on ${instance.name} must fail closed`);
        assert.equal(response.headers['retry-after'], undefined);
      }
      assert.equal(pair.a.downloadCalls() + pair.b.downloadCalls(), callsBefore, 'zero use-case invocations during the outage');
      assert.equal(env.objectServer.requests.length, r2Before, 'the 503 downloads do zero R2 work');

      // complete: the BOUNDED in-process emergency budget (2 per instance)
      // keeps the recovery entry open — exactly two allowed fallbacks per
      // instance, then a real local quota fact (429) on the third attempt.
      const expected = [200, 200, 200, 200, 429, 429];
      const statuses: number[] = [];
      for (let i = 0; i < expected.length; i += 1) {
        const instance = alternate(pair, i);
        const response = await rl06Complete(instance, env.owner, binding, p07Body(31), etag, randomUUID());
        statuses.push(response.statusCode);
        assert.equal(response.statusCode, expected[i]!, `fallback complete on ${instance.name} expected ${expected[i]}`);
        if (i === 0) {
          assert.ok(response.body.includes('"completed"'), 'the FIRST fallback completes the upload (business recovery success)');
        }
        if (response.statusCode === 429) {
          const problem = rl06ProblemOf(response.body);
          assert.equal(problem.error.code, 'rate_limited');
          assert.ok(problem.error.retryAfterSeconds !== null && problem.error.retryAfterSeconds >= 1);
          assert.equal(response.headers['ratelimit-policy'], 'attachments-complete:60:60000');
        }
      }
      assert.deepEqual(statuses, expected);
      assert.equal(await countOutboxEvents(env.isolated.runtime), outboxBefore + 1, 'exactly ONE verification job (the first fallback completed; replays converge idempotently)');
      assert.equal(await countUploadIntents(env.isolated.runtime), intentsBefore, 'no new intents during the outage');
      assert.equal(env.objectServer.requests.length, r2Before + 4, 'exactly the four allowed fallbacks attested the object; the two 429s did zero provider work');

      // Degraded/fallback evidence on BOTH instances (plan §4.2.7): business
      // recovery SUCCESS and the fixed failure class are asserted together.
      for (const instance of [pair.a, pair.b]) {
        const fallbacks = instance.logEntries.filter((entry) => entry.routeClass === 'complete' && entry.decision === 'fallback');
        assert.equal(fallbacks.length, 2, `${instance.name} logged exactly its own two fallback decisions`);
        assert.equal(fallbacks[0]!.failureClass, 'unavailable', 'the fixed failure class is recorded');
        const denied = instance.logEntries.filter((entry) => entry.routeClass === 'complete' && entry.decision === 'denied');
        assert.equal(denied.length, 1, `${instance.name} logged the emergency exhaustion`);
        assert.equal(instance.bundle.rateLimit.facade.readiness().status, 'degraded');
      }
    } finally {
      const restore = await env.container.exec(['redis-server', '--daemonize', 'yes']);
      if (restore.exitCode !== 0) throw new Error(`redis-server restart failed: ${restore.output}`);
    }

    // Recovery via a HEALTH BARRIER (polling, no fixed sleep): BOTH HTTP
    // admission paths AND both readiness verdicts must come back. The barrier
    // sends a real admission probe to EACH instance: a circuit breaker only
    // transitions through an actual store check, so an instance that receives
    // no traffic after the restart would stay degraded forever. A 201 OR a 429
    // counts as recovered — a 429 is a real Redis quota DECISION (exhausted),
    // which cannot be produced while Redis is down (outage = only 503); the
    // probe subject's own budget simply expires after the first poll. The
    // barrier probes with a DEDICATED subject so the recovery subject stays
    // fresh for the exact-count assertions below.
    await waitUntil(() => (async () => {
      const probeA = await rl06Issue(pair.a, env.probe, randomUUID(), RL06_COLLECTION);
      const probeB = await rl06Issue(pair.b, env.probe, randomUUID(), RL06_COLLECTION);
      const admissionUp = (probeA.statusCode === 201 || probeA.statusCode === 429)
        && (probeB.statusCode === 201 || probeB.statusCode === 429);
      if (!admissionUp) return false;
      return pair.a.bundle.rateLimit.facade.readiness().status === 'healthy'
        && pair.b.bundle.rateLimit.facade.readiness().status === 'healthy';
    })(), 60_000, 'both instances recover after the Redis restart', 100);

    // Quota semantics are restored: the fresh recovery subject is allowed
    // exactly the budget across BOTH instances and denied afterwards
    // (exact counts; the barrier subject's own counter is irrelevant).
    await waitForWindowHeadroom(env.raw, 60000);
    const afterRecovery = await countUploadIntents(env.isolated.runtime);
    assert.equal((await rl06Issue(pair.b, env.other, randomUUID(), RL06_COLLECTION)).statusCode, 201, 'recovered budget slot 1');
    assert.equal((await rl06Issue(pair.a, env.other, randomUUID(), RL06_COLLECTION)).statusCode, 201, 'recovered budget slot 2');
    assert.equal((await rl06Issue(pair.b, env.other, randomUUID(), RL06_COLLECTION)).statusCode, 429, 'budget enforcement restored across instances');
    assert.equal(await countUploadIntents(env.isolated.runtime), afterRecovery + 2, 'the recovery subject created exactly two ledger rows');
    const issueKeys = (await env.raw.keys(`${prefix}:*`)).filter((key) => key.includes(':issue:'));
    // The nosave restart wiped the pre-outage counters, so only the two
    // post-recovery subjects (barrier probe + recovery subject) keep keys;
    // each subject is isolated under its own HMAC key.
    assert.ok(issueKeys.length >= 2, 'barrier probe + recovery subjects each keep their own key');
    for (const key of issueKeys) {
      assert.equal(parseAttachmentRateLimitKey(key).kind, 'ok', 'every recovery key is a canonical codec key');
    }
  }, 180_000);
});
