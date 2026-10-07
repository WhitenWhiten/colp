/**
 * P4A-P10 PITR / alert / capacity rehearsal suite (plan §9 P10 items 2/5/6;
 * real PostgreSQL + real Redis + real HTTP + local object server; real R2 is
 * the `evidence:phase4a-p10-recovery` CLI boundary).
 *
 * Rehearses:
 *  - PITR recovery to each lifecycle point (intent -> PUT -> complete ->
 *    finalize -> cleanup) through the PRODUCTION ledger port and the
 *    PRODUCTION `reconcileGenerationLedger` over the real HTTP transport,
 *    with corruption (policy drift) -> mismatch/quarantine-candidate and a
 *    deterministic transient-429 marker -> unknown (environment), NEVER
 *    mismatch; a deleted generation is excluded exactly like the production
 *    cleanup tombstone;
 *  - backlog growth / quarantine / Redis hot-key / pool-saturation alert
 *    FIELDS at the real boundary with the sustained-window evaluator, and
 *    maintenance suppression that records `underlyingFiring + suppressed`
 *    without deleting the events;
 *  - capacity budget samples with fixed object size / concurrency / instance
 *    count and real RSS / FD / pool / Redis memory / DB query facts,
 *    cold-start and warm separated, latency recorded as diagnostic-only
 *    (never a production SLO).
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, test } from 'vitest';
import {
  buildP10Api,
  buildP10Worker,
  makeP05Config,
  p10BacklogFacts,
  p10BacklogSeed,
  p10Body,
  p10Complete,
  p10DbQueryCounter,
  p10Issue,
  p10IssuePut,
  p07KeyFromGrantUrl,
  p10RedisHotKeyCount,
  p10RedisMemory,
  restoreP10Dependencies,
  startP10SuiteEnv,
  waitForP10,
  HttpPitrObjectStore,
  P05_BUCKET,
  P10_COLLECTION,
  p10CapacitySample,
  type P10ApiBundle,
  type P10SuiteEnv,
} from '../../support/phase4a-p10-test-helpers.js';
import { makeRl06RateLimitConfig } from '../../support/phase4a-rl06-test-helpers.js';
import { ageP05CleanupCandidate } from '../../support/phase4a-p05-test-helpers.js';
import {
  p07Finalize,
  p07Put,
  p07Retire,
  readP07Blob,
  readP07Generation,
  type P07IssueResponse,
} from '../../support/phase4a-p07-test-helpers.js';
import {
  evaluateAttachmentAlerts,
  parseAttachmentRateLimitKey,
  reconcileGenerationLedger,
  validateCapacitySample,
  type AttachmentAlertConfig,
  type AttachmentBacklogSample,
} from '../../../src/modules/attachments/index.js';
import { createPostgresPitrLedgerPort } from '../../../src/infrastructure/database/index.js';

const ALERT_CONFIG: AttachmentAlertConfig = Object.freeze({
  verificationBacklog: Object.freeze({ sustainedSeconds: 300, minCount: 50, minGrowthPerMinute: 10 }),
  cleanupBacklog: Object.freeze({ sustainedSeconds: 300, minCount: 20, minGrowthPerMinute: 5 }),
  quarantineGrowth: Object.freeze({ sustainedSeconds: 300, minCount: 1, minGrowthPerMinute: 1 }),
  deadLetterReplay: Object.freeze({ sustainedSeconds: 300, minCount: 1, minGrowthPerMinute: 0 }),
  redisHotKey: Object.freeze({ sustainedSeconds: 300, minCount: 1, minGrowthPerMinute: 1 }),
  poolSaturation: Object.freeze({ sustainedSeconds: 300, minCount: 5, minGrowthPerMinute: 2 }),
});

let env: P10SuiteEnv;
const usedPrefixes = new Set<string>();
const openBundles: Array<{ close(): Promise<void> }> = [];
const MINUTE = 60_000;

async function newApi(prefix: string): Promise<P10ApiBundle> {
  const api = await buildP10Api({
    name: 'p10-api',
    runtime: env.isolated,
    databaseUrl: env.isolated.databaseUrl,
    identityUnitOfWork: env.identityUnitOfWork,
    browserSessionAuthority: env.factory.authority,
    objectServerUrl: env.objectServer.url,
    attachmentsConfig: makeP05Config(),
    rateLimitConfig: makeRl06RateLimitConfig(env.redisUrl, prefix),
    keySecret: Buffer.from(`p10-hmac-${randomUUID()}`, 'utf8'),
    workerFacts: async () => undefined,
    deliveryProbe: async () => true,
  });
  openBundles.push(api);
  usedPrefixes.add(prefix);
  return api;
}

function newWorker(): ReturnType<typeof buildP10Worker> {
  const worker = buildP10Worker(env.isolated, env.objectServer, { alertConfig: ALERT_CONFIG });
  openBundles.push({ close: worker.stop });
  return worker;
}

/** Recording wrapper so the per-exact-key HEAD count is observable. */
class RecordingHttpPitrStore extends HttpPitrObjectStore {
  headCalls = 0;

  override async headExact(handle: { generationId: string; key: string }): Promise<import('../../../src/modules/attachments/index.js').PitrHeadOutcome> {
    this.headCalls += 1;
    return super.headExact(handle);
  }
}

async function reconcileFor(generationId: string): Promise<{ verdict: string; detail: string }> {
  const ledger = createPostgresPitrLedgerPort(env.isolated.runtime);
  const store = new RecordingHttpPitrStore(env.objectServer.url, P05_BUCKET);
  const report = await reconcileGenerationLedger({ ledger, objectStore: store });
  const finding = report.findings.find((entry) => entry.generationId === generationId);
  assert.ok(finding, `reconcile must report the claimed generation ${generationId}`);
  return { verdict: finding.verdict, detail: finding.detail };
}

describe('P4A-P10 PITR + alert + capacity rehearsal (real PG + Redis + HTTP)', () => {
  beforeAll(async () => {
    env = await startP10SuiteEnv();
  }, 300_000);

  afterEach(async () => {
    for (const prefix of usedPrefixes) {
      const keys = await env.raw.keys(`${prefix}:*`);
      for (const key of keys) {
        try { await env.raw.del(key); } catch { /* best-effort */ }
      }
    }
    usedPrefixes.clear();
    await env.isolated.runtime.pool.query(
      `delete from outbox_events where outbox_id like 'p10-backlog-%'`,
    ).catch(() => undefined);
    await env.isolated.runtime.pool.query(
      `delete from resource_id_ledger where resource_id like 'p10-backlog-%'`,
    ).catch(() => undefined);
    env.objectServer.head429Keys.clear();
    env.objectServer.head500Keys.clear();
    env.objectServer.headDelayMs.clear();
    await restoreP10Dependencies(env);
    const open = openBundles.splice(0, openBundles.length);
    await Promise.all(open.map((bundle) => bundle.close().catch(() => undefined)));
  }, 60_000);

  afterAll(async () => {
    const errors: unknown[] = [];
    try { await env?.dropSchema(); } catch (error) { errors.push(error); }
    try { await env?.stop(); } catch (error) { errors.push(error); }
    if (errors.length > 0) {
      throw new Error(`P4A-P10 PITR/capacity cleanup failed: ${errors.map((error) => String(error)).join(' | ')}`);
    }
  }, 120_000);

  test('PITR reconcile at intent/PUT/complete/finalize/cleanup points; corruption -> quarantine candidate; transient 429 -> unknown', async () => {
    const api = await newApi(`p10-pitr-${randomUUID()}`);
    const worker = newWorker();
    // The worker is started AFTER the complete-point assertions: while it is
    // stopped the generation stays deterministically `observed` (no claim
    // race), so the PITR point verdicts are pinned rather than racing the
    // verification pipeline.
    const body = p10Body(11);

    // --- intent point: issued only, object absent -> missing. ---
    const issuedResponse = await p10Issue(api, env.owner, randomUUID(), P10_COLLECTION, body);
    assert.equal(issuedResponse.statusCode, 201, issuedResponse.body);
    const issued = JSON.parse(issuedResponse.body) as P07IssueResponse;
    let point = await reconcileFor(issued.receipt.generationId);
    assert.equal(point.verdict, 'missing', 'at the intent point the object is not yet uploaded');
    assert.equal(point.detail, 'state_allocated');

    // --- PUT point: object present with the exact identity -> match. ---
    const put = await p07Put(issued.grant.url, body);
    const key = p07KeyFromGrantUrl(issued.grant.url);
    point = await reconcileFor(issued.receipt.generationId);
    assert.equal(point.verdict, 'match');

    // --- complete point: the FIRST generation activates at its own complete
    // (frozen P07 contract — `completeUploadCas` sets the first generation
    // directly to `active`); only REPLACEMENT generations enter `observed`.
    // The exact-key HEAD still matches the bound identity -> match. ---
    const completed = await p10Complete(api, env.owner, issued.receipt, body, put.etag, randomUUID());
    assert.equal(completed.statusCode, 200, completed.body);
    point = await reconcileFor(issued.receipt.generationId);
    assert.equal(point.verdict, 'match');
    assert.equal(point.detail, 'state_active');

    // --- worker verification -> stored_private (active) -> match. ---
    await worker.start();
    await waitForP10(async () => (await readP07Blob(env.isolated.runtime, issued.receipt.blobId))?.logicalState === 'stored_private',
      { label: 'worker verifies the upload' });
    point = await reconcileFor(issued.receipt.generationId);
    assert.equal(point.verdict, 'match');
    assert.equal(point.detail, 'state_active');

    // --- finalize point: still active -> match. ---
    const finalized = await p07Finalize(api.app, env.owner, issued.receipt.blobId, randomUUID());
    assert.equal(finalized.statusCode, 200, finalized.body);
    point = await reconcileFor(issued.receipt.generationId);
    assert.equal(point.verdict, 'match');

    // --- corruption (policy drift): different etag/size -> mismatch. ---
    const drift = await p10IssuePut(api, env.owner, P10_COLLECTION, body);
    const driftCompleted = await p10Complete(api, env.owner, drift.receipt, body, drift.etag, randomUUID());
    assert.equal(driftCompleted.statusCode, 200);
    await waitForP10(async () => (await readP07Blob(env.isolated.runtime, drift.receipt.blobId))?.logicalState === 'stored_private',
      { label: 'drift blob verified' });
    env.objectServer.corrupt(drift.key);
    const driftReport = await (async () => {
      const ledger = createPostgresPitrLedgerPort(env.isolated.runtime);
      const store = new RecordingHttpPitrStore(env.objectServer.url, P05_BUCKET);
      return reconcileGenerationLedger({ ledger, objectStore: store });
    })();
    const driftFinding = driftReport.findings.find((entry) => entry.generationId === drift.receipt.generationId);
    assert.equal(driftFinding?.verdict, 'mismatch', 'policy drift is the ONLY mismatch source');
    assert.ok(driftReport.quarantineCandidates.includes(drift.receipt.generationId));

    // --- transient 429 (deterministic run marker) -> unknown, NEVER mismatch. ---
    const throttled = await p10IssuePut(api, env.owner, P10_COLLECTION, body);
    const throttledCompleted = await p10Complete(api, env.owner, throttled.receipt, body, throttled.etag, randomUUID());
    assert.equal(throttledCompleted.statusCode, 200);
    env.objectServer.head429Keys.add(throttled.key);
    const throttledReport = await (async () => {
      const ledger = createPostgresPitrLedgerPort(env.isolated.runtime);
      const store = new RecordingHttpPitrStore(env.objectServer.url, P05_BUCKET);
      return reconcileGenerationLedger({ ledger, objectStore: store });
    })();
    const throttledFinding = throttledReport.findings.find((entry) => entry.generationId === throttled.receipt.generationId);
    assert.equal(throttledFinding?.verdict, 'unknown', 'provider throttling is an environment class');
    assert.equal(throttledFinding?.detail, 'provider_retryable');
    assert.ok(!throttledReport.quarantineCandidates.includes(throttled.receipt.generationId),
      'a transient 429 must never become a quarantine candidate');
    assert.equal(throttledReport.destructiveActionsTaken, false);
    // Recovery: removing the marker restores match.
    env.objectServer.head429Keys.delete(throttled.key);
    point = await reconcileFor(throttled.receipt.generationId);
    assert.equal(point.verdict, 'match');

    // --- cleanup point: retire + age + bounded cleanup -> excluded. ---
    const retired = await p07Retire(api.app, env.owner, issued.receipt.blobId, randomUUID());
    assert.equal(retired.statusCode, 200, retired.body);
    let row = await readP07Generation(env.isolated.runtime, issued.receipt.generationId);
    assert.equal(row?.generationState, 'retired');
    point = await reconcileFor(issued.receipt.generationId);
    assert.equal(point.verdict, 'match', 'a retired generation is still claimed until cleanup');
    await ageP05CleanupCandidate(env.isolated.runtime, issued.receipt.generationId);
    const cleaned = await worker.worker.attachments!.runCleanupOnce();
    assert.ok(cleaned.claimed >= 1, 'the aged retirement must be claimable');
    row = await readP07Generation(env.isolated.runtime, issued.receipt.generationId);
    assert.equal(row?.generationState, 'deleted', 'the production cleanup must tombstone the generation');
    assert.equal(env.objectServer.has(issued.key), false, 'the exact object must be deleted');
    const ledger = createPostgresPitrLedgerPort(env.isolated.runtime);
    const store = new RecordingHttpPitrStore(env.objectServer.url, P05_BUCKET);
    const finalReport = await reconcileGenerationLedger({ ledger, objectStore: store });
    assert.equal(finalReport.findings.some((entry) => entry.generationId === issued.receipt.generationId), false,
      'a deleted generation is never claimed (table-clearing is not reconcile)');
    assert.equal(store.headCalls, finalReport.findings.length,
      'exactly one per-exact-key HEAD per claimed row, never a bucket list');
    assert.equal(finalReport.destructiveActionsTaken, false);
  }, 240_000);

  test('backlog growth / quarantine / Redis hot-key / pool-saturation alert fields at the real boundary; maintenance suppression keeps events', async () => {
    const prefix = `p10-alert-${randomUUID()}`;
    const api = await newApi(prefix);
    const worker = newWorker();
    await worker.start();
    const body = p10Body(12);

    // Stop the worker FIRST so the verification row stays pending with no
    // claim race; the upload completes against the INTACT object (the ledger
    // binds the intact identity), then the object is corrupted so the
    // production verification pipeline quarantines the generation
    // deterministically (etag mismatch after attestation).
    await worker.stop();
    const victim = await p10IssuePut(api, env.owner, P10_COLLECTION, body);
    const victimCompleted = await p10Complete(api, env.owner, victim.receipt, body, victim.etag, randomUUID());
    assert.equal(victimCompleted.statusCode, 200);
    env.objectServer.corrupt(victim.key);
    // The hot-key workload: one subject hammered so its limiter key value
    // crosses the suite threshold (real Redis counters).
    for (let index = 0; index < 12; index += 1) {
      await p10Issue(api, env.probe, randomUUID(), P10_COLLECTION, body);
    }
    await p10BacklogSeed(env.isolated.runtime, 1_200);

    // Real facts before the worker drains/quarantines.
    const before = await p10BacklogFacts(env.isolated.runtime);
    assert.ok(before.verificationBacklog >= 1_200, 'the backlog must reflect the seeded rows');
    assert.equal(before.quarantineCount, 0);

    // Restart the worker: the corrupted upload is quarantined by the
    // production verification pipeline (digest mismatch after attestation).
    await worker.start();
    await waitForP10(async () => (await p10BacklogFacts(env.isolated.runtime)).quarantineCount === 1,
      { timeoutMs: 60_000, label: 'worker quarantines the corrupted upload' });

    // Controlled timeline samples over REAL facts (no wall-clock sleeps):
    // each sample re-reads the real backlog / hot-key / pool facts, and the
    // backlog GROWS between samples with real seeded rows (the worker can
    // never complete the not_found rows, so the growth is real and stable).
    // The first sample reaches back to the 300s window start (the evaluator
    // requires the series to span the whole sustained window).
    const base = Date.parse('2026-08-10T12:00:00.000Z');
    const samples: AttachmentBacklogSample[] = [];
    for (let index = 0; index < 5; index += 1) {
      if (index > 0) await p10BacklogSeed(env.isolated.runtime, 100);
      const facts = await p10BacklogFacts(env.isolated.runtime);
      samples.push({
        atIso: new Date(base + (index - 1) * MINUTE).toISOString(),
        verificationBacklog: facts.verificationBacklog,
        cleanupBacklog: 0,
        quarantineCount: facts.quarantineCount,
        deadLetterCount: facts.deadLetterCount,
        redisHotKeyCount: await p10RedisHotKeyCount(env.raw, prefix),
        poolWaiting: env.isolated.runtime.pool.waitingCount,
      });
    }
    const nowIso = new Date(base + 4 * MINUTE).toISOString();
    const verdicts = evaluateAttachmentAlerts({ samples, config: ALERT_CONFIG, nowIso });

    // verification_backlog: sustained + growing over the window -> fires.
    assert.equal(verdicts.verification_backlog.firing, true, 'a sustained growing backlog must fire');
    assert.equal(verdicts.verification_backlog.reason, 'sustained_and_growing');
    // quarantine: sustained but flat -> no_growth (honest: no fabricated growth).
    assert.equal(verdicts.quarantine_growth.firing, false);
    assert.equal(verdicts.quarantine_growth.reason, 'no_growth');
    // The new P10 alert fields are present with their REAL recorded values.
    assert.equal(samples.every((entry) => entry.redisHotKeyCount !== undefined && entry.poolWaiting !== undefined), true);
    assert.equal(verdicts.pool_saturation.alert, 'pool_saturation');
    assert.equal(verdicts.pool_saturation.firing, false, 'zero real pool waiting must stay quiet');

    // Maintenance suppression: the underlying condition is recorded and the
    // events stay in the ring (never deleted).
    const suppressed = evaluateAttachmentAlerts({ samples, config: ALERT_CONFIG, nowIso, maintenanceActive: true });
    assert.equal(suppressed.verification_backlog.firing, false);
    assert.equal(suppressed.verification_backlog.suppressed, true);
    assert.equal(suppressed.verification_backlog.underlyingFiring, true,
      'maintenance suppression must record the underlying firing state');
    assert.equal(suppressed.verification_backlog.reason, 'suppressed_maintenance');
    assert.equal(samples.length, 5, 'the events themselves are never deleted');
  }, 240_000);

  test('capacity budget: cold/warm samples with real RSS/FD/pool/Redis memory/DB query facts; latency diagnostic-only', async () => {
    const prefix = `p10-cap-${randomUUID()}`;
    const api = await newApi(prefix);
    const worker = newWorker();
    await worker.start();
    const body = p10Body(13);

    const dbQueries = p10DbQueryCounter(env.isolated.runtime.pool);
    const r2Before = env.objectServer.requests.length;
    const latencies: number[] = [];
    const uploads: Array<{ receipt: { blobId: string } }> = [];

    const runBatch = async (count: number, phase: 'cold_start' | 'warm'): Promise<void> => {
      const pairs: Array<Promise<void>> = [];
      // `count/2` pairs, each with TWO concurrent uploads (the fixed
      // rehearsal concurrency of 2); cold=2 uploads, warm=6 uploads, 8 total.
      for (let index = 0; index < count; index += 2) {
        pairs.push((async () => {
          const runOne = async (): Promise<void> => {
            const started = Date.now();
            const issued = await p10IssuePut(api, env.owner, P10_COLLECTION, body);
            latencies.push(Date.now() - started);
            const completed = await p10Complete(api, env.owner, issued.receipt, body, issued.etag, randomUUID());
            assert.equal(completed.statusCode, 200, completed.body);
            uploads.push({ receipt: issued.receipt });
          };
          await Promise.all([runOne(), runOne()]);
        })());
      }
      await Promise.all(pairs);
      await waitForP10(async () => {
        const states = await Promise.all(uploads.map((entry) => readP07Blob(env.isolated.runtime, entry.receipt.blobId)));
        return states.every((row) => row?.logicalState === 'stored_private');
      }, { timeoutMs: 120_000, label: `capacity batch ${phase} verified` });
      const sorted = [...latencies].sort((left, right) => left - right);
      const sample = p10CapacitySample(phase, {
        objectSizeBytes: body.byteLength,
        concurrency: 2,
        apiInstances: 1,
        dbQueryCounter: dbQueries,
        r2CallCounter: { count: () => env.objectServer.requests.length - r2Before },
        redisFacts: {
          usedMemoryBytes: await p10RedisMemory(env.raw),
          connectedClients: 1,
        },
        pool: {
          total: () => env.isolated.runtime.pool.totalCount,
          idle: () => env.isolated.runtime.pool.idleCount,
          active: () => env.isolated.runtime.pool.totalCount - env.isolated.runtime.pool.idleCount,
          waiting: () => env.isolated.runtime.pool.waitingCount,
        },
      }, {
        p50: sorted[Math.floor(sorted.length * 0.5)] ?? 0,
        p95: sorted[Math.floor(sorted.length * 0.95)] ?? 0,
      });
      validateCapacitySample(sample);
      return sample;
    };

    // Cold start: the first two uploads immediately after startup.
    const cold = await runBatch(2, 'cold_start');
    // Warm: the remaining six uploads.
    const warm = await runBatch(6, 'warm');

    assert.equal(cold.phase, 'cold_start');
    assert.equal(warm.phase, 'warm');
    assert.equal(cold.objectSizeBytes, body.byteLength);
    assert.equal(cold.concurrency, 2);
    assert.equal(cold.apiInstances, 1);
    assert.ok(cold.process.rssBytes > 0);
    assert.ok(cold.process.activeHandles > 0);
    assert.ok(cold.redis!.usedMemoryBytes > 0, 'real Redis memory must be recorded');
    assert.ok(warm.dbQueries >= cold.dbQueries, 'the warm batch must add real DB queries');
    assert.ok(warm.r2Calls > cold.r2Calls, 'the warm batch must add real object-store calls');
    assert.ok(cold.latencyMs !== null && warm.latencyMs !== null);
    assert.equal(cold.limitations.some((entry) => entry.includes('not a production SLO')), true,
      'local rehearsal numbers are never production SLOs');
    // Every upload verified end to end (fixed workload completed).
    assert.equal(uploads.length, 8);
    const keys = await env.raw.keys(`${prefix}:*`);
    for (const key of keys) {
      assert.equal(parseAttachmentRateLimitKey(key).kind, 'ok', `canonical key: ${key}`);
    }
  }, 240_000);
});
