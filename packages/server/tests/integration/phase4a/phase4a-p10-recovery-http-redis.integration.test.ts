/**
 * P4A-P10 recovery rehearsal suite (plan §9 P10; real PostgreSQL + real
 * Redis via dedicated Testcontainers containers + real HTTP + local object
 * server; real R2 is the `evidence:phase4a-p10-recovery` CLI boundary).
 *
 * Rehearses, at REAL boundaries:
 *  - per-dependency stops (R2 / PostgreSQL / Redis / origin / Worker / API):
 *    the attachments capability fails closed on necessary dependencies while
 *    the global API probes (/health, /ready) stay independent, then each
 *    dependency recovers through a health barrier (no fixed sleeps);
 *  - drain/resume through the PRODUCTION durable admission switch
 *    (stopAdmissionAndDrain / resumeAdmission) with the in-flight complete
 *    still draining;
 *  - credential/ACL rotation through the PRODUCTION
 *    `rotateAttachmentCredentials` helper over a real credential-enforcing
 *    HTTP server: keeping the old credential is reported
 *    `old_credential_still_accepted` and NEVER passes (anti-false-positive);
 *  - API graceful close drains an in-flight real HTTP request;
 *  - the sealed recovery order (secret/control -> PostgreSQL -> R2 reconcile
 *    -> Redis limiter -> Worker -> isolated origin -> admission): after a
 *    full outage the capability stays closed at every intermediate step and
 *    admission recovers LAST.
 *
 * Anti-false-negative anchors: every restore uses a polling health barrier
 * (real store checks), never a fixed sleep; a stopped container/process that
 * cannot be restored throws (environment failure, never a skip).
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, test } from 'vitest';
import {
  buildP10Api,
  buildP10Worker,
  makeP05Config,
  p10AdmissionSwitchDeps,
  p10BacklogFacts,
  p10BacklogSeed,
  p10Body,
  p10Complete,
  p10Issue,
  p10IssuePut,
  p10OriginProbe,
  p10RotationProbeBuilder,
  restoreP10Dependencies,
  startP10SuiteEnv,
  waitForP10,
  HttpPitrObjectStore,
  P05_BUCKET,
  P10_COLLECTION,
  P10_RW_TOKEN,
  P10_RW_TOKEN_NEXT,
  type P10ApiBundle,
  type P10SuiteEnv,
} from '../../support/phase4a-p10-test-helpers.js';
import { makeRl06RateLimitConfig } from '../../support/phase4a-rl06-test-helpers.js';
import {
  makeS3Credential,
  makeSecretResolver,
} from '../../support/phase4a-i15-test-helpers.js';
import {
  resumeAdmission,
  rotateAttachmentCredentials,
  reconcileGenerationLedger,
  stopAdmissionAndDrain,
  verifyOldCredentialRejected,
  type AttachmentRotationLogEntry,
  type AttachmentsReadinessFacts,
} from '../../../src/modules/attachments/index.js';
import { createPostgresPitrLedgerPort } from '../../../src/infrastructure/database/index.js';
import { p07Headers, p07Digest } from '../../support/phase4a-p07-test-helpers.js';

let env: P10SuiteEnv;
const usedPrefixes = new Set<string>();
const openBundles: Array<{ close(): Promise<void> }> = [];

async function newApi(prefix: string, options: { readonly workerFacts?: () => Promise<AttachmentsReadinessFacts | undefined> } = {}): Promise<P10ApiBundle> {
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
    workerFacts: options.workerFacts ?? (async () => undefined),
    deliveryProbe: p10OriginProbe(env.originServer),
  });
  openBundles.push(api);
  usedPrefixes.add(prefix);
  return api;
}

function problemCode(body: string): string {
  return (JSON.parse(body) as { error: { code: string } }).error.code;
}

/** Health barrier: the rate-limit circuit only transitions through real store checks. */
async function waitForHealthyRateLimit(api: P10ApiBundle): Promise<void> {
  await waitForP10(async () => {
    // A real admission probe exercises the facade's store check every poll.
    await p10Issue(api, env.probe, randomUUID(), P10_COLLECTION, p10Body(1)).catch(() => undefined);
    return api.bundle.rateLimit.facade.readiness().status === 'healthy';
  }, { timeoutMs: 60_000, label: 'rate-limit circuit healthy' });
}

async function ensureDependenciesUp(): Promise<void> {
  // start() is idempotent: a running server returns immediately.
  await env.objectServer.start();
  await env.originServer.start();
}

describe('P4A-P10 recovery rehearsal (real PG + Redis + HTTP)', () => {
  beforeAll(async () => {
    env = await startP10SuiteEnv();
  }, 300_000);

  afterEach(async () => {
    await ensureDependenciesUp();
    // A failed test may have stopped PostgreSQL or Redis mid-outage. Restore
    // them before stopping test-owned runtimes and inspecting their rows.
    await restoreP10Dependencies(env);
    const open = openBundles.splice(0, openBundles.length);
    await Promise.all(open.map((bundle) => bundle.close()));

    // Exact-key cleanup for every run prefix (test-only; never FLUSHALL).
    for (const prefix of usedPrefixes) {
      const keys = await env.raw.keys(`${prefix}:*`);
      for (const key of keys) {
        try { await env.raw.del(key); } catch { /* best-effort */ }
      }
    }
    usedPrefixes.clear();

    // The production retention guard deliberately forbids deleting Outbox
    // rows. Retire this suite's synthetic backlog through a terminal state
    // after every worker has stopped; the suite schema itself is dropped in
    // afterAll. Never swallow cleanup failures, because one leaked backlog
    // makes every later readiness observation dishonest.
    await env.isolated.runtime.pool.query(`
      update outbox_events
         set state='completed', completed_at=coalesce(completed_at,current_timestamp),
             locked_until=null, last_error=null
       where outbox_id like 'p10-backlog-%'
         and state in ('pending','retryable','leased')
    `);
    const remaining = await env.isolated.runtime.pool.query<{ count: number }>(`
      select count(*)::int count from outbox_events
       where outbox_id like 'p10-backlog-%'
         and state in ('pending','retryable','leased')
    `);
    assert.equal(remaining.rows[0]?.count, 0, 'synthetic P10 backlog must be terminal between tests');
  }, 60_000);

  afterAll(async () => {
    const errors: unknown[] = [];
    try { await env?.dropSchema(); } catch (error) { errors.push(error); }
    try { await env?.stop(); } catch (error) { errors.push(error); }
    if (errors.length > 0) {
      throw new Error(`P4A-P10 recovery cleanup failed: ${errors.map((error) => String(error)).join(' | ')}`);
    }
  }, 120_000);

  test('stopping R2 / PostgreSQL / Redis / origin / Worker one by one fails the capability closed while the global API stays independent', async () => {
    const api = await newApi(`p10-stop-${randomUUID()}`);
    assert.equal((await api.readiness()).status, 'ready');

    // --- R2 (object store) stopped: necessary dependency -> not-ready. ---
    await env.objectServer.stop();
    let facts = await api.facts();
    assert.equal(facts.objectStore?.status, 'degraded');
    assert.equal((await api.readiness()).status, 'not-ready');
    assert.equal((await api.readiness()).reason, 'dependency_unavailable');
    assert.equal((await api.app.inject({ method: 'GET', url: '/ready/features/attachments' })).statusCode, 503);
    assert.equal((await api.app.inject({ method: 'GET', url: '/health' })).statusCode, 200,
      'the global health probe must stay independent');
    assert.equal((await api.app.inject({ method: 'GET', url: '/ready' })).statusCode, 200,
      'the global readiness probe must stay independent');
    await env.objectServer.start();
    await waitForP10(async () => (await api.facts()).objectStore?.status === 'healthy',
      { label: 'object store healthy after restart' });

    // --- PostgreSQL stopped: necessary dependency -> not-ready. ---
    await env.postgres.stop();
    facts = await api.facts();
    assert.equal(facts.database?.status, 'degraded');
    assert.equal((await api.readiness()).status, 'not-ready');
    assert.equal((await api.app.inject({ method: 'GET', url: '/health' })).statusCode, 200);
    assert.equal((await api.app.inject({ method: 'GET', url: '/ready' })).statusCode, 200);
    await env.postgres.start();
    await waitForP10(async () => (await api.facts()).database?.status === 'healthy',
      { label: 'database healthy after restart' });

    // --- Redis stopped (enforce + required): limiter blocks the capability. ---
    await env.redis.stop();
    facts = await api.facts();
    assert.equal(facts.rateLimit?.blocksAttachments, true);
    assert.equal((await api.readiness()).status, 'not-ready');
    const issueDuringRedisOutage = await p10Issue(api, env.owner, randomUUID(), P10_COLLECTION, p10Body(2));
    assert.equal(issueDuringRedisOutage.statusCode, 503, 'issue fails closed during the Redis outage');
    assert.equal(problemCode(issueDuringRedisOutage.body), 'rate_limit_unavailable');
    assert.equal((await api.app.inject({ method: 'GET', url: '/health' })).statusCode, 200);
    await env.redis.start();
    await waitForHealthyRateLimit(api);

    // --- isolated origin stopped: delivery host unavailable -> not-ready. ---
    await env.originServer.stop();
    facts = await api.facts();
    assert.equal(facts.delivery?.hostAvailable, false);
    assert.equal(facts.objectStore?.status, 'healthy', 'the origin stop must not touch the object store');
    assert.equal((await api.readiness()).status, 'not-ready');
    assert.equal((await api.readiness()).reason, 'delivery_unavailable');
    await env.originServer.start();
    await waitForP10(async () => (await api.facts()).delivery?.hostAvailable === true,
      { label: 'origin healthy after restart' });

    // --- Worker stopped: verification stops draining -> backlog grows -> degraded. ---
    const worker = buildP10Worker(env.isolated, env.objectServer);
    openBundles.push({ close: worker.stop });
    await worker.start();
    await worker.stop();
    await p10BacklogSeed(env.isolated.runtime, 1_200);
    const backlog = await p10BacklogFacts(env.isolated.runtime);
    assert.ok(backlog.verificationBacklog >= 1_200, 'the backlog must grow while the worker is stopped');
    const workerApi = await newApi(`p10-worker-${randomUUID()}`, {
      workerFacts: async () => worker.worker.attachments?.readinessFacts(),
    });
    const workerReadiness = await workerApi.readiness();
    assert.equal(workerReadiness.status, 'degraded', 'an elevated worker backlog degrades the capability');
    assert.equal(workerReadiness.reason, 'worker_degraded');
    assert.equal(workerReadiness.components?.worker.status, 'degraded');
    assert.equal(workerReadiness.components?.api.status, 'ready');
    assert.equal((await workerApi.app.inject({ method: 'GET', url: '/health' })).statusCode, 200);
  }, 240_000);

  test('drain: stop admission -> issue stops, in-flight uploads still complete; resume restores issuance', async () => {
    const prefix = `p10-drain-${randomUUID()}`;
    const api = await newApi(prefix);
    const switchDeps = p10AdmissionSwitchDeps(env.isolated.runtime);
    const operatorId = `operator-${randomUUID()}`;

    // An in-flight upload is prepared BEFORE the drain (issue + PUT only).
    const body = p10Body(3);
    const pending = await p10IssuePut(api, env.owner, P10_COLLECTION, body);

    const stopped = await stopAdmissionAndDrain(switchDeps, {
      reason: 'maintenance', operatorId, leaseTtlSeconds: 60,
    });
    assert.equal(stopped.outcome, 'stopped');
    const readiness = await api.readiness();
    assert.equal(readiness.status, 'degraded');
    assert.equal(readiness.reason, 'admission_stopped');
    assert.equal(readiness.components?.api.status, 'degraded');

    // New issuance is refused before any use-case work.
    const refused = await p10Issue(api, env.owner, randomUUID(), P10_COLLECTION, body);
    assert.equal(refused.statusCode, 503);
    assert.equal(problemCode(refused.body), 'rate_limit_unavailable');

    // The in-flight upload still drains through complete (the recovery entry).
    const completed = await p10Complete(api, env.owner, pending.receipt, body, pending.etag, randomUUID());
    assert.equal(completed.statusCode, 200, `drain complete: ${completed.body}`);

    // Resume: the lease owner restores admission.
    const resumed = await resumeAdmission(switchDeps, { operatorId });
    assert.equal(resumed.outcome, 'resumed');
    const afterResume = await p10Issue(api, env.owner, randomUUID(), P10_COLLECTION, body);
    assert.equal(afterResume.statusCode, 201, 'admission must be restored after resume');
    assert.equal((await api.readiness()).status, 'ready');
  }, 120_000);

  test('credential/ACL rotation rehearsal: new works + old rejected; keeping the old credential NEVER passes', async () => {
    env.objectServer.enforceCredentials = true;
    env.objectServer.validCredentials.clear();
    env.objectServer.validCredentials.add(P10_RW_TOKEN);
    const resolver = makeSecretResolver({
      'known/p10/rw/current': makeS3Credential(P10_RW_TOKEN, 'p10-old-secret-value-00000000000000000000'),
      'known/p10/rw/next': makeS3Credential(P10_RW_TOKEN_NEXT, 'p10-new-secret-value-00000000000000000000'),
    });
    const builder = p10RotationProbeBuilder(env.objectServer);
    const target = {
      role: 'rw' as const,
      currentSecretRef: 'known/p10/rw/current',
      newSecretRef: 'known/p10/rw/next',
    };
    const logs: AttachmentRotationLogEntry[] = [];

    try {
      // Stage 1: the NEW credential is not in the ACL yet -> new rejected.
      const notActivated = await rotateAttachmentCredentials({ target, resolver, storeBuilder: builder, log: (entry) => logs.push(entry) });
      assert.equal(notActivated.verdict, 'new_credential_rejected', 'rotation must never pass before the ACL grants the new credential');

      // Stage 2: ACL grants the new credential but the OLD one is KEPT ->
      // the rehearsal reports old_credential_still_accepted and NEVER passes.
      env.objectServer.validCredentials.add(P10_RW_TOKEN_NEXT);
      const oldKept = await rotateAttachmentCredentials({ target, resolver, storeBuilder: builder, log: (entry) => logs.push(entry) });
      assert.equal(oldKept.verdict, 'old_credential_still_accepted',
        'keeping the old credential must be reported and must never pass');
      assert.equal(oldKept.oldRejected, false);
      assert.equal(oldKept.newWorks, true);

      // Stage 3: the ACL change removes the old credential -> rotation verified.
      env.objectServer.validCredentials.delete(P10_RW_TOKEN);
      const rotated = await rotateAttachmentCredentials({ target, resolver, storeBuilder: builder, log: (entry) => logs.push(entry) });
      assert.equal(rotated.verdict, 'rotation_verified');
      assert.equal(rotated.newWorks, true);
      assert.equal(rotated.oldRejected, true);

      // Post-revocation check against the LIVE store: the old credential is rejected.
      const postRevocation = await verifyOldCredentialRejected({
        role: 'rw',
        oldSecretRef: 'known/p10/rw/current',
        resolver,
        probe: builder.build('rw', makeS3Credential(P10_RW_TOKEN_NEXT, 'p10-new-secret-value-00000000000000000000')),
      });
      assert.equal(postRevocation.oldRejected, true);

      // No secret material ever leaves the helper.
      const serialized = JSON.stringify({ rotated, logs });
      assert.ok(!serialized.includes(P10_RW_TOKEN) && !serialized.includes(P10_RW_TOKEN_NEXT),
        'rotation outputs must not contain credential material');
      assert.ok(!serialized.includes('p10-old-secret-value') && !serialized.includes('p10-new-secret-value'));
    } finally {
      env.objectServer.enforceCredentials = false;
      env.objectServer.validCredentials.clear();
    }
  }, 120_000);

  test('API graceful close drains an in-flight real HTTP request', async () => {
    const api = await newApi(`p10-close-${randomUUID()}`);
    await api.app.listen({ port: 0, host: '127.0.0.1' });
    const address = api.app.server.address();
    assert.ok(address && typeof address === 'object', 'app must listen on a real port');
    const baseUrl = `http://127.0.0.1:${address.port}`;
    try {
      const body = p10Body(4);
      const pending = await p10IssuePut(api, env.owner, P10_COLLECTION, body);
      // The complete attestation HEAD is delayed so the request stays in
      // flight while close() is issued.
      env.objectServer.headDelayMs.set(pending.key, 2_000);
      const commandId = randomUUID();
      const inFlight = fetch(`${baseUrl}/api/v1/attachments/complete`, {
        method: 'POST',
        headers: { ...p07Headers(env.owner, commandId) },
        body: JSON.stringify({
          binding: pending.receipt,
          declared: { size: body.byteLength, sha256: p07Digest(body), mediaType: 'image/png', etag: pending.etag },
        }),
        signal: AbortSignal.timeout(30_000),
      });
      await waitForP10(
        async () => env.objectServer.requests.some((request) => request.method === 'HEAD'
          && request.path.includes(pending.key)),
        { timeoutMs: 5_000, label: 'the in-flight complete request to reach the delayed provider HEAD' },
      );
      let closed = false;
      const closing = api.bundle.bundle.app.close().then(() => { closed = true; });
      const response = await inFlight;
      assert.equal(response.status, 200, 'the in-flight request must complete through the graceful close');
      await closing;
      assert.equal(closed, true, 'close() must resolve only after the in-flight request drained');
      // After close, the app accepts no new requests.
      await assert.rejects(() => api.app.inject({ method: 'GET', url: '/health' }),
        /inject|closed|destroyed|listening/i);
    } finally {
      env.objectServer.headDelayMs.clear();
      await api.app.close().catch(() => undefined);
      await api.bundle.bundle.store.close().catch(() => undefined);
    }
  }, 120_000);

  test('recovery order rehearsal: after a full outage, admission recovers ONLY after the sealed order completes', async () => {
    const prefix = `p10-order-${randomUUID()}`;
    const worker = buildP10Worker(env.isolated, env.objectServer);
    openBundles.push({ close: worker.stop });
    await worker.start();
    const api = await newApi(prefix, {
      workerFacts: async () => worker.worker.attachments?.readinessFacts(),
    });

    // Real pending uploads (issue+PUT+complete) stay unverified while the
    // worker is stopped — the honest drain backlog for the Worker step.
    const body = p10Body(5);
    const pending: Array<{ receipt: { blobId: string; intentId: string; generationId: string }; etag: string }> = [];
    for (let index = 0; index < 6; index += 1) {
      const issued = await p10IssuePut(api, env.owner, P10_COLLECTION, body);
      const completed = await p10Complete(api, env.owner, issued.receipt, body, issued.etag, randomUUID());
      assert.equal(completed.statusCode, 200, `pending upload ${index}: ${completed.body}`);
      pending.push({ receipt: issued.receipt, etag: issued.etag });
    }

    // Stop EVERYTHING: admission switch first (needs PostgreSQL), then the
    // worker, then PostgreSQL / Redis / R2 / origin processes.
    const switchDeps = p10AdmissionSwitchDeps(env.isolated.runtime);
    const operatorId = `operator-${randomUUID()}`;
    const resolver = makeSecretResolver({
      'known/p10/order/current': makeS3Credential(P10_RW_TOKEN, 'p10-order-old-secret-value-0000000000'),
      'known/p10/order/next': makeS3Credential(P10_RW_TOKEN_NEXT, 'p10-order-new-secret-value-0000000000'),
    });
    const stopped = await stopAdmissionAndDrain(switchDeps, { reason: 'maintenance', operatorId, leaseTtlSeconds: 120 });
    assert.equal(stopped.outcome, 'stopped');
    await worker.stop();
    await env.postgres.stop();
    await env.redis.stop();
    await env.objectServer.stop();
    await env.originServer.stop();

    // The sealed recovery order (plan P10 item 1):
    const steps = [
      async () => { /* secret/control: the credential/ACL state is already valid
                       (in-memory server facts survive restarts) — verified below. */ },
      async () => { await env.postgres.start(); },
      async () => {
        await env.objectServer.start();
        // R2 reconcile step: the PRODUCTION reconcile over the recovered
        // ledger + per-exact-key HEADs runs BEFORE the limiter/worker/origin
        // steps (plan P10 item 1: R2 reconcile precedes Redis limiter).
        const report = await reconcileGenerationLedger({
          ledger: createPostgresPitrLedgerPort(env.isolated.runtime),
          objectStore: new HttpPitrObjectStore(env.objectServer.url, P05_BUCKET),
        });
        assert.equal(report.destructiveActionsTaken, false, 'the recovery reconcile never mutates');
      },
      async () => { await env.redis.start(); await waitForHealthyRateLimit(api); },
      async () => { await worker.start(); },
      async () => { await env.originServer.start(); },
      async () => {
        const resumed = await resumeAdmission(switchDeps, { operatorId });
        assert.equal(resumed.outcome, 'resumed');
      },
    ];
    const expectedIntermediate = [
      'not-ready',   // after secret/control: PostgreSQL still down
      'not-ready',   // after PostgreSQL: object store still down
      'not-ready',   // after R2: Redis limiter still down (enforce+required)
      'not-ready',   // after Redis limiter: worker not draining + origin down
      'not-ready',   // after Worker: origin still down
      'degraded',    // after origin: everything healthy except admission (stopped)
      'ready',       // after admission: fully recovered
    ];
    for (let index = 0; index < steps.length; index += 1) {
      await steps[index]!();
      if (index === 0) {
        // secret/control step: the secret resolver (control plane) must
        // still resolve both credential references after the outage, and the
        // rotation ACL state is inspectable (facts survive restarts).
        const current = await resolver.resolve('known/p10/order/current');
        const next = await resolver.resolve('known/p10/order/next');
        assert.equal(current.kind, 's3');
        assert.equal(next.kind, 's3');
      }
      if (index === 4) {
        // Worker step: the pending uploads drain to stored_private.
        await waitForP10(async () => {
          const facts = await p10BacklogFacts(env.isolated.runtime);
          return facts.verificationBacklog === 0;
        }, { timeoutMs: 120_000, label: 'worker drains the pending uploads' });
        for (const entry of pending) {
          const rows = await env.isolated.runtime.pool.query<{ logical_state: string }>(
            'select logical_state from blob_records where blob_id = $1', [entry.receipt.blobId]);
          assert.equal(rows.rows[0]?.logical_state, 'stored_private', 'drained uploads must be verified');
        }
      }
      const readiness = await api.readiness();
      assert.equal(readiness.status, expectedIntermediate[index],
        `intermediate state after recovery step ${index} (${['secret/control', 'postgres', 'r2_reconcile', 'redis_limiter', 'worker', 'isolated_origin', 'admission'][index]})`);
    }
    // Admission recovers LAST: the final issue is admitted.
    const issued = await p10Issue(api, env.owner, randomUUID(), P10_COLLECTION, body);
    assert.equal(issued.statusCode, 201, `post-recovery issue: ${issued.body}`);
    assert.equal((await api.readiness()).status, 'ready');
    assert.equal((await api.app.inject({ method: 'GET', url: '/health' })).statusCode, 200);
  }, 300_000);
});
