/**
 * P4A-P05 PostgreSQL integration suite (part 1): the PRODUCTION worker
 * composition consuming real Product traffic.
 *
 * Every scenario starts from the REAL Product flow (HTTP issue -> INDEPENDENT
 * HTTP PUT -> HTTP complete) which commits the verification Outbox row in the
 * SAME transaction, then lets a worker built through the PRODUCTION
 * `buildWorker` assembly (`src/bootstrap/worker.ts`) consume it. No test
 * inserts claimed attachment events and no test calls the verification
 * handler directly — convergence is only ever observed through the outbox
 * machinery.
 *
 * Covered: convergence to stored_private with facts matching the exact R2
 * bytes; duplicate + out-of-order delivery idempotency; R2 timeout/5xx stays
 * retryable (never dead-lettered) and recovers; lease steal after a crashed
 * claimant (stale lease can never overwrite); stop/drain/resume; unrelated
 * route isolation while attachments fail; backlog gauges + I15 sustained-
 * window alert port + partial readiness facts; late-upload reconciliation +
 * retention cleanup (identity-unknown orphans quarantine for review, never
 * auto-deleted, active generations untouched).
 */
import assert from 'node:assert/strict';
import { afterAll, beforeAll, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { createDatabaseRuntime } from '../../../src/infrastructure/database/index.js';
import { describeWithPostgres } from '../../support/postgres-test-runtime.js';
import { createI07MigrationRuntime, type I07MigrationRuntime } from '../../support/phase4a-i07-test-helpers.js';
import { sha256Hex } from '../../support/phase4a-p03-test-helpers.js';
import {
  createP05CompositionWorker,
  driveP05OutboxUntil,
  insertP05UnrelatedPurgeEvent,
  p05PurgeReceiptCount,
  p05VerificationReceiptCount,
} from '../../support/phase4a-p05-composition-helpers.js';
import { P05ObjectServer } from '../../support/phase4a-p05-object-server.js';
import {
  P05_COLLECTION,
  ageP05CleanupCandidate,
  buildP05App,
  completeIssued,
  expireP05Intent,
  expireP05Leases,
  issueAndPut,
  issuePutComplete,
  makeP05Config,
  p05BlobRow,
  p05GenerationRow,
  p05OutboxRow,
  seedP05Collection,
  seedP05Identity,
  waitFor,
  type P05IssueReceipt,
  type P05ProductIdentity,
} from '../../support/phase4a-p05-test-helpers.js';

const CONFIG = makeP05Config();
const HANDLER = 'attachments_verify_generation';

describeWithPostgres('P4A-P05 production worker composition', () => {
  let isolated: I07MigrationRuntime;
  let objectServer: P05ObjectServer;
  let identity: P05ProductIdentity;

  beforeAll(async () => {
    isolated = await createI07MigrationRuntime('phase4a_p05_composition', { maxConnections: 16 });
    identity = await seedP05Identity();
    await seedP05Collection(isolated.runtime, identity.owner.subjectId);
    objectServer = new P05ObjectServer();
    await objectServer.start();
  }, 120_000);

  afterAll(async () => {
    await objectServer?.close();
    await isolated?.dropSchema();
  });

  function receiptCount(blobId: string): Promise<number> {
    return p05VerificationReceiptCount(isolated.runtime, blobId);
  }

  test('product traffic converges: complete -> real Outbox -> production worker -> stored_private', async () => {
    const bundle = buildP05App({
      runtime: isolated.runtime, databaseUrl: isolated.databaseUrl,
      identityUnitOfWork: identity.identityUnitOfWork,
      browserSessionAuthority: identity.factory.authority, objectServerUrl: objectServer.url,
      attachmentsConfig: CONFIG,
    });
    const { runtime, store } = createP05CompositionWorker(isolated, objectServer);
    try {
      const first = await issuePutComplete(bundle, identity.owner, objectServer, isolated.runtime);
      const second = await issuePutComplete(bundle, identity.owner, objectServer, isolated.runtime, 4096);

      for (const completed of [first, second]) {
        assert.equal((await p05BlobRow(isolated.runtime, completed.receipt.blobId)).logical_state, 'uploaded');
        assert.equal((await p05OutboxRow(isolated.runtime, completed.outboxId)).state, 'pending');
      }

      // The production worker (not a direct handler call) claims + verifies.
      await driveP05OutboxUntil(runtime, async () => {
        const rows = await sql<{ count: string }>`
          select count(*)::text as count from outbox_events
          where handler_name = ${HANDLER} and state = 'completed'
        `.execute(isolated.runtime.db);
        return Number(rows.rows[0]!.count) === 2;
      }, { label: 'both verification rows completed' });

      for (const completed of [first, second]) {
        const blob = await p05BlobRow(isolated.runtime, completed.receipt.blobId);
        assert.equal(blob.logical_state, 'stored_private');
        assert.equal(blob.verified_sha256, completed.digest,
          'verified digest must match the independent digest of the exact R2 bytes');
        assert.equal((await p05OutboxRow(isolated.runtime, completed.outboxId)).state, 'completed');
        assert.equal(await receiptCount(completed.receipt.blobId), 1);
      }
      assert.equal(objectServer.keyCount(), 2, 'the R2 objects must remain intact');
    } finally {
      await bundle.app.close();
      await bundle.store.close();
      await store.close();
    }
  });

  test('duplicate + out-of-order delivery converge idempotently with a single receipt', async () => {
    const bundle = buildP05App({
      runtime: isolated.runtime, databaseUrl: isolated.databaseUrl,
      identityUnitOfWork: identity.identityUnitOfWork,
      browserSessionAuthority: identity.factory.authority, objectServerUrl: objectServer.url,
      attachmentsConfig: CONFIG,
    });
    const { runtime, store } = createP05CompositionWorker(isolated, objectServer);
    try {
      const first = await issuePutComplete(bundle, identity.owner, objectServer, isolated.runtime);
      const second = await issuePutComplete(bundle, identity.owner, objectServer, isolated.runtime, 3072);

      // Out-of-order delivery: the SECOND row becomes claimable first.
      await isolated.runtime.pool.query(
        `update outbox_events set available_at = now() - interval '10 minutes' where outbox_id = $1`,
        [second.outboxId],
      );
      await driveP05OutboxUntil(runtime, async () => {
        const states = await Promise.all([
          p05BlobRow(isolated.runtime, first.receipt.blobId),
          p05BlobRow(isolated.runtime, second.receipt.blobId),
        ]);
        return states.every((blob) => blob.logical_state === 'stored_private');
      }, { label: 'both blobs stored regardless of delivery order' });
      assert.equal((await p05OutboxRow(isolated.runtime, first.outboxId)).state, 'completed');
      assert.equal((await p05OutboxRow(isolated.runtime, second.outboxId)).state, 'completed');

      // Duplicate delivery of the SAME row: reset only the delivery state.
      await isolated.runtime.pool.query(
        `update outbox_events set state = 'pending', locked_until = null, lease_generation = 0 where outbox_id = $1`,
        [first.outboxId],
      );
      await driveP05OutboxUntil(runtime, async () =>
        (await p05OutboxRow(isolated.runtime, first.outboxId)).state === 'completed',
      { label: 'duplicate delivery re-completes' });

      const blob = await p05BlobRow(isolated.runtime, first.receipt.blobId);
      assert.equal(blob.logical_state, 'stored_private');
      assert.equal(blob.verified_sha256, first.digest, 'a duplicate delivery must not rewrite the facts');
      assert.equal(await receiptCount(first.receipt.blobId), 1, 'one event = one delivery receipt');
      assert.equal(await receiptCount(second.receipt.blobId), 1);
    } finally {
      await bundle.app.close();
      await bundle.store.close();
      await store.close();
    }
  });

  test('R2 timeout and 5xx stay retryable (never dead-lettered) and recover', async () => {
    // Real-budget convergence: provider delay 3s + retry backoff loops; the
    // dedicated vitest.phase4a-p05-postgres config budgets this suite at 180s.
    const bundle = buildP05App({
      runtime: isolated.runtime, databaseUrl: isolated.databaseUrl,
      identityUnitOfWork: identity.identityUnitOfWork,
      browserSessionAuthority: identity.factory.authority, objectServerUrl: objectServer.url,
      attachmentsConfig: CONFIG,
    });
    const { runtime, store } = createP05CompositionWorker(isolated, objectServer);
    try {
      // Scenario 1: the conditional read times out (route timeout 300ms < delay 3000ms).
      const timeoutBlob = await issuePutComplete(bundle, identity.owner, objectServer, isolated.runtime);
      objectServer.readDelays.set(timeoutBlob.key, 3_000);
      await runtime.outbox!.runOnce();
      let row = await p05OutboxRow(isolated.runtime, timeoutBlob.outboxId);
      assert.equal((await p05BlobRow(isolated.runtime, timeoutBlob.receipt.blobId)).logical_state, 'verifying');
      assert.equal(row.state, 'retryable', 'a provider timeout must be retryable');
      assert.equal(row.dead_lettered_at, null, 'a transient provider timeout must never dead-letter');
      await driveP05OutboxUntil(runtime, async () =>
        (await p05OutboxRow(isolated.runtime, timeoutBlob.outboxId)).attempt_count >= 2,
      { timeoutMs: 20_000, label: 'timeout retry' });
      row = await p05OutboxRow(isolated.runtime, timeoutBlob.outboxId);
      assert.equal(row.dead_lettered_at, null, 'retries must not dead-letter the row');
      objectServer.readDelays.delete(timeoutBlob.key);
      await driveP05OutboxUntil(runtime, async () =>
        (await p05BlobRow(isolated.runtime, timeoutBlob.receipt.blobId)).logical_state === 'stored_private',
      { label: 'timeout recovers' });
      assert.equal((await p05OutboxRow(isolated.runtime, timeoutBlob.outboxId)).dead_lettered_at, null);
      assert.equal((await p05BlobRow(isolated.runtime, timeoutBlob.receipt.blobId)).verified_sha256, timeoutBlob.digest);

      // Scenario 2: HEAD returns 500 (provider retryable class).
      const headBlob = await issuePutComplete(bundle, identity.owner, objectServer, isolated.runtime);
      objectServer.headFailures.add(headBlob.key);
      await runtime.outbox!.runOnce();
      row = await p05OutboxRow(isolated.runtime, headBlob.outboxId);
      assert.equal(row.state, 'retryable', 'a HEAD 5xx must be retryable');
      assert.equal(row.dead_lettered_at, null);
      objectServer.headFailures.delete(headBlob.key);
      await driveP05OutboxUntil(runtime, async () =>
        (await p05BlobRow(isolated.runtime, headBlob.receipt.blobId)).logical_state === 'stored_private',
      { label: '5xx recovers' });
      assert.equal((await p05OutboxRow(isolated.runtime, headBlob.outboxId)).dead_lettered_at, null);
      assert.equal((await p05BlobRow(isolated.runtime, headBlob.receipt.blobId)).verified_sha256, headBlob.digest);
    } finally {
      objectServer.readDelays.clear();
      objectServer.headFailures.clear();
      await bundle.app.close();
      await bundle.store.close();
      await store.close();
    }
  }, 180_000);

  test('contract corruption converges to quarantine (blob expired, generation quarantined)', async () => {
    const bundle = buildP05App({
      runtime: isolated.runtime, databaseUrl: isolated.databaseUrl,
      identityUnitOfWork: identity.identityUnitOfWork,
      browserSessionAuthority: identity.factory.authority, objectServerUrl: objectServer.url,
      attachmentsConfig: CONFIG,
    });
    const { runtime, store } = createP05CompositionWorker(isolated, objectServer);
    try {
      // A client that declares a digest DIFFERENT from the bytes it actually
      // PUTs (etag + size still attest, so complete accepts) must converge to
      // quarantine through the PRODUCTION worker — never to stored_private.
      const wrongDigest = sha256Hex(Buffer.from('p05-quarantine-declared-digest'));
      const corrupted = await issuePutComplete(bundle, identity.owner, objectServer, isolated.runtime, 2048, {
        declaredSha256: wrongDigest,
      });
      assert.notEqual(wrongDigest, corrupted.digest, 'the fixture must actually lie about the digest');
      assert.equal((await p05OutboxRow(isolated.runtime, corrupted.outboxId)).state, 'pending');
      assert.equal((await p05BlobRow(isolated.runtime, corrupted.receipt.blobId)).logical_state, 'uploaded');

      await driveP05OutboxUntil(runtime, async () =>
        (await p05OutboxRow(isolated.runtime, corrupted.outboxId)).state === 'completed',
      { label: 'corruption row completed' });

      const blob = await p05BlobRow(isolated.runtime, corrupted.receipt.blobId);
      assert.equal(blob.logical_state, 'expired', 'contract corruption expires the blob');
      assert.equal(blob.verified_sha256, null, 'corruption never records a verified digest');
      const generation = await p05GenerationRow(isolated.runtime, corrupted.receipt.generationId);
      assert.equal(generation.generation_state, 'quarantined', 'the generation is quarantined for review');
      assert.equal(generation.quarantined_reason, 'digest_mismatch');
      assert.equal(await p05VerificationReceiptCount(isolated.runtime, corrupted.receipt.blobId), 1,
        'one corruption verdict = one delivery receipt');
      assert.equal(objectServer.has(corrupted.key), true, 'quarantined bytes stay retained for review');
    } finally {
      await bundle.app.close();
      await bundle.store.close();
      await store.close();
    }
  });

  test('lease steal: a crashed claimant can never overwrite; the takeover converges', async () => {
    const bundle = buildP05App({
      runtime: isolated.runtime, databaseUrl: isolated.databaseUrl,
      identityUnitOfWork: identity.identityUnitOfWork,
      browserSessionAuthority: identity.factory.authority, objectServerUrl: objectServer.url,
      attachmentsConfig: CONFIG,
    });
    const workerA = createP05CompositionWorker(isolated, objectServer, { workerId: 'p05-lease-steal-a' });
    const workerB = createP05CompositionWorker(isolated, objectServer, { workerId: 'p05-lease-steal-b' });
    try {
      const blob = await issuePutComplete(bundle, identity.owner, objectServer, isolated.runtime);
      // Worker A claims and stalls inside the provider HEAD; its heartbeat is alive.
      objectServer.headDelays.set(blob.key, 2_000);
      objectServer.readDelays.set(blob.key, 3_000);
      const claimPromise = workerA.runtime.outbox!.runOnce();

      await waitFor(async () => {
        const outbox = await p05OutboxRow(isolated.runtime, blob.outboxId);
        const state = await p05BlobRow(isolated.runtime, blob.receipt.blobId);
        return outbox.state === 'leased' && state.logical_state === 'verifying';
      }, { timeoutMs: 10_000, label: 'worker A claimed (durable claim)' });

      // A's leases expire; the takeover claims and stores while A is stalled.
      await expireP05Leases(isolated.runtime, blob.outboxId, blob.receipt.blobId);
      objectServer.headDelays.delete(blob.key);
      objectServer.readDelays.delete(blob.key);
      assert.equal(await workerB.runtime.outbox!.runOnce(), true, 'worker B must claim and verify');
      const settled = await Promise.race([
        claimPromise.then(() => true),
        new Promise<boolean>((resolvePromise) => setTimeout(() => resolvePromise(false), 15_000)),
      ]);
      assert.equal(settled, true, 'the stale claimant must settle after lease loss');
      await claimPromise;

      const finalBlob = await p05BlobRow(isolated.runtime, blob.receipt.blobId);
      assert.equal(finalBlob.logical_state, 'stored_private');
      assert.equal(finalBlob.verified_sha256, blob.digest,
        'the stale claimant must never overwrite the verified facts');
      assert.equal((await p05OutboxRow(isolated.runtime, blob.outboxId)).state, 'completed');
      assert.equal(await receiptCount(blob.receipt.blobId), 1, 'exactly one delivery receipt after takeover');
    } finally {
      objectServer.headDelays.clear();
      objectServer.readDelays.clear();
      await bundle.app.close();
      await bundle.store.close();
      await workerA.store.close();
      await workerB.store.close();
    }
  });

  test('stop/drain/resume: shutdown aborts in-flight work and a restarted worker converges', async () => {
    const bundle = buildP05App({
      runtime: isolated.runtime, databaseUrl: isolated.databaseUrl,
      identityUnitOfWork: identity.identityUnitOfWork,
      browserSessionAuthority: identity.factory.authority, objectServerUrl: objectServer.url,
      attachmentsConfig: CONFIG,
    });
    // A dedicated database runtime so stop() drains without closing the shared pool.
    const drainDatabase = createDatabaseRuntime(isolated.databaseUrl, {
      maxConnections: 4, applicationName: 'known-p05-drain',
      connectionTimeoutMs: 5_000, idleTimeoutMs: 1_000, statementTimeoutMs: 30_000,
    });
    const { runtime, store } = createP05CompositionWorker(isolated, objectServer, { database: drainDatabase });
    try {
      const blob = await issuePutComplete(bundle, identity.owner, objectServer, isolated.runtime);
      // The provider HEAD stalls so the worker stays mid-handler (2s window).
      objectServer.headDelays.set(blob.key, 2_000);
      await runtime.start();

      await waitFor(async () => (await p05OutboxRow(isolated.runtime, blob.outboxId)).state === 'leased',
        { timeoutMs: 10_000, label: 'worker mid-handler' });

      // Graceful drain: bounded stop that aborts the in-flight read.
      const stopped = await Promise.race([
        runtime.stop().then(() => true),
        new Promise<boolean>((resolvePromise) => setTimeout(() => resolvePromise(false), 15_000)),
      ]);
      assert.equal(stopped, true, 'stop() must drain within the bounded budget');
      assert.equal((await p05BlobRow(isolated.runtime, blob.receipt.blobId)).logical_state, 'verifying');
      // The aborted in-flight attempt lands the row as retryable (lease
      // released, still claimable) or, if the abort raced the claim commit,
      // as leased — either way a drained shutdown must NEVER complete it.
      const drainedRow = await p05OutboxRow(isolated.runtime, blob.outboxId);
      assert.ok(['leased', 'retryable'].includes(drainedRow.state),
        `drained stop must leave the row claimable, got ${drainedRow.state}`);
      assert.equal(drainedRow.dead_lettered_at, null,
        'a drained shutdown must never dead-letter the row');

      // Resume with a fresh production worker after lease expiry.
      objectServer.headDelays.delete(blob.key);
      await expireP05Leases(isolated.runtime, blob.outboxId, blob.receipt.blobId);
      const resumed = createP05CompositionWorker(isolated, objectServer);
      try {
        await driveP05OutboxUntil(resumed.runtime, async () =>
          (await p05BlobRow(isolated.runtime, blob.receipt.blobId)).logical_state === 'stored_private',
        { label: 'resumed worker converges' });
        const finalBlob = await p05BlobRow(isolated.runtime, blob.receipt.blobId);
        assert.equal(finalBlob.verified_sha256, blob.digest);
        assert.equal((await p05OutboxRow(isolated.runtime, blob.outboxId)).state, 'completed');
      } finally {
        await resumed.store.close();
      }
    } finally {
      objectServer.headDelays.clear();
      await runtime.stop().catch(() => undefined);
      await bundle.app.close();
      await bundle.store.close();
      await store.close();
    }
  });

  test('attachments failures never disable unrelated routes', async () => {
    const bundle = buildP05App({
      runtime: isolated.runtime, databaseUrl: isolated.databaseUrl,
      identityUnitOfWork: identity.identityUnitOfWork,
      browserSessionAuthority: identity.factory.authority, objectServerUrl: objectServer.url,
      attachmentsConfig: CONFIG,
    });
    const { runtime, store } = createP05CompositionWorker(isolated, objectServer);
    try {
      const blob = await issuePutComplete(bundle, identity.owner, objectServer, isolated.runtime);
      objectServer.readFailures.add(blob.key);

      // A real unrelated outbox event (publication cache purge) proves the
      // loop keeps serving other routes while the attachments row fails.
      const { purgeId, eventId } = await insertP05UnrelatedPurgeEvent(isolated.runtime, P05_COLLECTION);

      // While the attachments row stays retryable, the unrelated route completes.
      await driveP05OutboxUntil(runtime, async () => {
        const rows = await sql<{ state: string }>`
          select state from outbox_events where outbox_id = ${purgeId}
        `.execute(isolated.runtime.db);
        return rows.rows[0]?.state === 'completed';
      }, { label: 'unrelated route completes while attachments fail' });

      const purgeReceipts = await p05PurgeReceiptCount(isolated.runtime, eventId);
      assert.equal(purgeReceipts, 1);

      const attachmentRow = await p05OutboxRow(isolated.runtime, blob.outboxId);
      assert.equal(attachmentRow.state, 'retryable', 'the attachments row must still be retryable');
      assert.equal(attachmentRow.dead_lettered_at, null);

      // Recovery: the same worker loop keeps consuming the attachments row.
      objectServer.readFailures.delete(blob.key);
      await driveP05OutboxUntil(runtime, async () =>
        (await p05BlobRow(isolated.runtime, blob.receipt.blobId)).logical_state === 'stored_private',
      { label: 'attachments row recovers on the same worker' });
      assert.equal((await p05OutboxRow(isolated.runtime, blob.outboxId)).state, 'completed');
    } finally {
      objectServer.readFailures.clear();
      await bundle.app.close();
      await bundle.store.close();
      await store.close();
    }
  }, 180_000);

  test('backlog gauges feed the I15 alert port and partial readiness facts', async () => {
    // Sustained-window convergence with a stepped deterministic clock; the
    // dedicated vitest.phase4a-p05-postgres config budgets this suite at 180s.
    const bundle = buildP05App({
      runtime: isolated.runtime, databaseUrl: isolated.databaseUrl,
      identityUnitOfWork: identity.identityUnitOfWork,
      browserSessionAuthority: identity.factory.authority, objectServerUrl: objectServer.url,
      attachmentsConfig: CONFIG,
    });
    // A dedicated database runtime: start()/stop() must not close the shared pool.
    const backlogDatabase = createDatabaseRuntime(isolated.databaseUrl, {
      maxConnections: 4, applicationName: 'known-p05-backlog',
      connectionTimeoutMs: 5_000, idleTimeoutMs: 1_000, statementTimeoutMs: 30_000,
    });
    let nowMs = 1_000_000;
    const clock = (): Date => new Date(nowMs);
    const tightAlertConfig: AttachmentAlertConfig = {
      verificationBacklog: { sustainedSeconds: 10, minCount: 1, minGrowthPerMinute: 1 },
      cleanupBacklog: { sustainedSeconds: 10, minCount: 1, minGrowthPerMinute: 1 },
      quarantineGrowth: { sustainedSeconds: 10, minCount: 1, minGrowthPerMinute: 1 },
      deadLetterReplay: { sustainedSeconds: 10, minCount: 1, minGrowthPerMinute: 0 },
    };
    const { runtime, metrics, store } = createP05CompositionWorker(isolated, objectServer, {
      database: backlogDatabase,
      telemetryIntervalMs: 100,
      alertConfig: tightAlertConfig,
      now: clock,
    });
    try {
      await runtime.start();
      // Deterministic growth: the fault is installed BEFORE each outbox row
      // exists, so the first verification attempt always fails and the row
      // stays retryable (backlog persists while the loop keeps running).
      const failing: Array<{ receipt: P05IssueReceipt; key: string }> = [];
      const first = await issueAndPut(bundle, identity.owner, objectServer, isolated.runtime);
      objectServer.readFailures.add(first.key);
      await completeIssued(bundle, identity.owner, first);
      failing.push({ receipt: first.receipt, key: first.key });
      await waitFor(async () => metrics.get('attachments.verification_backlog') >= 1,
        { timeoutMs: 15_000, label: 'first backlog sample' });
      // Step the deterministic clock across the 10s sustained window; the
      // sampler lands real samples at every step (window start included), and
      // one more failing blob per step grows the backlog inside the window.
      for (let step = 1; step <= 3; step += 1) {
        const priorSamples = runtime.attachments!.metricsSnapshot().backlogSamples.length;
        nowMs += 2_000;
        await waitFor(
          async () => runtime.attachments!.metricsSnapshot().backlogSamples.length > priorSamples,
          { timeoutMs: 2_000, label: `telemetry sample at clock step ${step}` },
        );
        if (step >= 2) {
          const issued = await issueAndPut(bundle, identity.owner, objectServer, isolated.runtime, 2048 + step);
          objectServer.readFailures.add(issued.key);
          await completeIssued(bundle, identity.owner, issued);
          failing.push({ receipt: issued.receipt, key: issued.key });
          await waitFor(async () => metrics.get('attachments.verification_backlog') >= step,
            { timeoutMs: 20_000, label: `backlog growth step ${step}` });
        }
      }
      nowMs += 6_000; // t0+12000: window start lands at the first stepped sample (t0+2000)
      const finalStepSamples = runtime.attachments!.metricsSnapshot().backlogSamples.length;
      await waitFor(
        async () => runtime.attachments!.metricsSnapshot().backlogSamples.length > finalStepSamples,
        { timeoutMs: 2_000, label: 'telemetry sample at the final backlog state' },
      );

      const verdicts = runtime.attachments!.alertVerdicts();
      assert.equal(verdicts.verification_backlog.firing, true, 'the alert port must fire on sustained growth');
      assert.equal(verdicts.verification_backlog.reason, 'sustained_and_growing');
      assert.equal(metrics.get('attachments.alert.verification_backlog'), 1);
      assert.equal(metrics.get('attachments.verification_backlog'), 3);
      assert.equal(metrics.get('attachments.dead_letter_count'), 0);
      const peakSnapshot = runtime.attachments!.metricsSnapshot();
      assert.equal(peakSnapshot.gauges.verification_backlog, 3,
        'the I15 fixed-label gauge must carry the live backlog');
      assert.ok(peakSnapshot.backlogSamples.length >= 2, 'the bounded ring must carry recorded samples');

      const facts = await runtime.attachments!.readinessFacts();
      assert.equal(facts.worker?.verificationBacklog, 3, 'partial readiness must report the live backlog');
      assert.equal(facts.worker?.cleanupBacklog, 0);

      // Recovery: the backlog drains and the alert stops firing.
      for (const entry of failing) objectServer.readFailures.delete(entry.key);
      await waitFor(async () => metrics.get('attachments.verification_backlog') === 0,
        { timeoutMs: 40_000, label: 'backlog drain' });
      nowMs += 6_000;
      const drainedSamples = runtime.attachments!.metricsSnapshot().backlogSamples.length;
      await waitFor(
        async () => runtime.attachments!.metricsSnapshot().backlogSamples.length > drainedSamples,
        { timeoutMs: 2_000, label: 'telemetry sample after backlog drain' },
      );
      assert.equal(runtime.attachments!.alertVerdicts().verification_backlog.firing, false,
        'the alert must stop after the backlog drains');
      assert.equal(metrics.get('attachments.alert.verification_backlog'), 0);
      const drainedFacts = await runtime.attachments!.readinessFacts();
      assert.equal(drainedFacts.worker?.verificationBacklog, 0);
      for (const entry of failing) {
        assert.equal((await p05BlobRow(isolated.runtime, entry.receipt.blobId)).logical_state, 'stored_private');
      }
      const snapshot = runtime.attachments!.metricsSnapshot();
      assert.equal(snapshot.gauges.verification_backlog, 0);
      assert.ok(snapshot.backlogSamples.length >= 2, 'the bounded ring must carry recorded samples');
    } finally {
      objectServer.readFailures.clear();
      await runtime.stop().catch(() => undefined);
      await bundle.app.close();
      await bundle.store.close();
      await store.close();
    }
  }, 180_000);

  test('cleanup: late uploads expire, reconcile to orphaned, identity-unknown orphans quarantine for review', async () => {
    const bundle = buildP05App({
      runtime: isolated.runtime, databaseUrl: isolated.databaseUrl,
      identityUnitOfWork: identity.identityUnitOfWork,
      browserSessionAuthority: identity.factory.authority, objectServerUrl: objectServer.url,
      attachmentsConfig: CONFIG,
    });
    const { runtime, store } = createP05CompositionWorker(isolated, objectServer, { cleanupIntervalMs: 60_000 });
    try {
      // Control: a normally completed blob converges to stored_private.
      const control = await issuePutComplete(bundle, identity.owner, objectServer, isolated.runtime);
      await driveP05OutboxUntil(runtime, async () =>
        (await p05BlobRow(isolated.runtime, control.receipt.blobId)).logical_state === 'stored_private',
      { label: 'control verified' });

      // Late upload 1: complete AFTER the DB-clock intent deadline -> expired + orphaned.
      const late = await issueAndPut(bundle, identity.owner, objectServer, isolated.runtime);
      await expireP05Intent(isolated.runtime, late.receipt.intentId);
      const lateComplete = await bundle.app.inject({
        method: 'POST',
        url: '/api/v1/attachments/complete',
        headers: {
          cookie: identity.owner.cookie,
          origin: 'https://app.known.example',
          'x-csrf-token': identity.owner.csrfToken,
          'known-command-id': randomUUID(),
          'content-type': 'application/json',
        },
        payload: JSON.stringify({
          binding: late.receipt,
          declared: { size: late.body.byteLength, sha256: late.digest, mediaType: 'image/png', etag: late.etag },
        }),
      });
      assert.equal(lateComplete.statusCode, 409);
      assert.equal((lateComplete.json() as { error: { code: string } }).error.code, 'attachment_state_conflict');
      assert.equal((await p05BlobRow(isolated.runtime, late.receipt.blobId)).logical_state, 'expired');
      let lateGen = await p05GenerationRow(isolated.runtime, late.receipt.generationId);
      assert.equal(lateGen.generation_state, 'orphaned');
      assert.equal(lateGen.retire_reason, 'expired');
      assert.equal(objectServer.has(late.key), true);

      // Late upload 2: never completed -> allocated generation reconciled by cleanup.
      const abandoned = await issueAndPut(bundle, identity.owner, objectServer, isolated.runtime);
      await expireP05Intent(isolated.runtime, abandoned.receipt.intentId);
      assert.equal((await p05BlobRow(isolated.runtime, abandoned.receipt.blobId)).logical_state, 'issued');

      // Run 1: the claim reconciles the abandoned allocated generation to orphaned
      // (DB-clock), but retention keeps both candidates for a later run.
      const firstRun = await runtime.attachments!.runCleanupOnce();
      assert.equal(firstRun.claimed, 0);
      const abandonedGen = await p05GenerationRow(isolated.runtime, abandoned.receipt.generationId);
      assert.equal(abandonedGen.generation_state, 'orphaned', 'allocated -> orphaned reconciliation');
      assert.equal(abandonedGen.retire_reason, 'expired');
      assert.equal(objectServer.has(abandoned.key), true, 'reconciliation must not delete anything');

      // Age both candidates past the retention deadline (DB clock) and run again.
      await ageP05CleanupCandidate(isolated.runtime, late.receipt.generationId);
      await ageP05CleanupCandidate(isolated.runtime, abandoned.receipt.generationId);
      const secondRun = await runtime.attachments!.runCleanupOnce();
      assert.equal(secondRun.claimed, 2);
      // Neither generation ever completed, so NO observed identity (etag/size)
      // exists to match against the exact key; per the I14 contract an identity
      // mismatch must stop automatic DELETE and quarantine the generation for
      // review — the bytes stay retained.
      assert.deepEqual(secondRun.outcomes.map((o) => o.kind), ['quarantined', 'quarantined']);
      for (const outcome of secondRun.outcomes) {
        assert.equal(outcome.reason, 'candidate_mismatch');
      }
      assert.equal(objectServer.has(late.key), true,
        'quarantined bytes stay retained for review (no DELETE without a matched snapshot)');
      assert.equal(objectServer.has(abandoned.key), true,
        'quarantined bytes stay retained for review (no DELETE without a matched snapshot)');

      const lateAfter = await p05GenerationRow(isolated.runtime, late.receipt.generationId);
      assert.equal(lateAfter.generation_state, 'quarantined');
      assert.equal(lateAfter.quarantined_reason, 'candidate_mismatch');
      const abandonedAfter = await p05GenerationRow(isolated.runtime, abandoned.receipt.generationId);
      assert.equal(abandonedAfter.generation_state, 'quarantined');
      assert.equal(abandonedAfter.quarantined_reason, 'candidate_mismatch');
      assert.equal((await p05BlobRow(isolated.runtime, late.receipt.blobId)).logical_state, 'expired');
      assert.equal((await p05BlobRow(isolated.runtime, abandoned.receipt.blobId)).logical_state, 'issued');

      // The active control is untouched: body present, state stored_private.
      assert.equal(objectServer.has(control.key), true, 'active generations must never be deleted');
      assert.equal((await p05BlobRow(isolated.runtime, control.receipt.blobId)).logical_state, 'stored_private');
    } finally {
      await bundle.app.close();
      await bundle.store.close();
      await store.close();
    }
  });
});
