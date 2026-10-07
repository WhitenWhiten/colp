/**
 * P4A-P05 PostgreSQL integration suite (part 2): a REAL independent worker
 * process.
 *
 * The worker is spawned as a separate OS process
 * (`tests/support/phase4a-p05-worker-entry.ts` via tsx) that composes the
 * PRODUCTION `buildWorker` assembly — verification outbox route, cleanup
 * scheduler, backlog telemetry — and polls the real outbox. Product traffic
 * is produced through the REAL HTTP flow in the test process (independent
 * composition), so API and Worker are independent processes.
 *
 * Covered: convergence through a real subprocess; graceful stop (stdin
 * control channel — the only portable graceful-stop path, because on Windows
 * `child.kill('SIGTERM')` is TerminateProcess and the JS signal handlers
 * never run) with clean exit and restart; the real SIGTERM signal path on
 * POSIX; SIGKILL crash after the durable claim with lease-expiry takeover by
 * a restarted worker (single receipt, facts match); PostgreSQL reconnect
 * after every worker backend is terminated.
 */
import assert from 'node:assert/strict';
import { afterAll, beforeAll, test } from 'vitest';
import { sql } from 'kysely';
import { describeWithPostgres } from '../../support/postgres-test-runtime.js';
import { createI07MigrationRuntime, type I07MigrationRuntime } from '../../support/phase4a-i07-test-helpers.js';
import {
  P05ObjectServer,
  buildP05App,
  expireP05Leases,
  issuePutComplete,
  makeP05Config,
  p05BlobRow,
  p05OutboxRow,
  seedP05Collection,
  seedP05Identity,
  startP05WorkerProcess,
  waitFor,
  type P05ProductIdentity,
  type P05WorkerProcess,
} from '../../support/phase4a-p05-test-helpers.js';
import { waitForCondition } from '../../support/async-test-helpers.js';

const CONFIG = makeP05Config();
const HANDLER = 'attachments_verify_generation';

describeWithPostgres('P4A-P05 independent worker process', () => {
  let isolated: I07MigrationRuntime;
  let objectServer: P05ObjectServer;
  let identity: P05ProductIdentity;
  const active: P05WorkerProcess[] = [];

  beforeAll(async () => {
    isolated = await createI07MigrationRuntime('phase4a_p05_process', { maxConnections: 16 });
    identity = await seedP05Identity();
    await seedP05Collection(isolated.runtime, identity.owner.subjectId);
    objectServer = new P05ObjectServer();
    await objectServer.start();
  }, 120_000);

  afterAll(async () => {
    for (const proc of active) {
      await proc.stop().catch(() => undefined);
    }
    await objectServer?.close();
    await isolated?.dropSchema();
  });

  /** Bounded polling that fails loudly when the worker process dies. */
  async function waitForWorker(
    proc: P05WorkerProcess,
    predicate: () => Promise<boolean>,
    options: { readonly timeoutMs?: number; readonly label?: string } = {},
  ): Promise<void> {
    await waitForCondition(async () => {
      if (proc.child.exitCode !== null || proc.child.signalCode !== null) {
        throw new Error(
          `worker process exited early (code=${proc.child.exitCode}, signal=${proc.child.signalCode}): `
          + proc.stderr.slice(-2_000),
        );
      }
      return predicate();
    }, {
      timeoutMs: options.timeoutMs ?? 60_000,
      pollIntervalMs: 25,
      description: options.label ?? 'the worker-process predicate',
    });
  }

  function receiptCount(blobId: string): Promise<number> {
    return sql<{ count: string }>`
      select count(*)::text as count
      from outbox_delivery_receipts r
      join outbox_events e on e.domain_event_id = r.domain_event_id
      where r.handler_name = ${HANDLER} and e.aggregate_id = ${blobId}
    `.execute(isolated.runtime.db).then((result) => Number(result.rows[0]!.count));
  }

  test('a real worker subprocess converges and restarts cleanly after graceful stop', async () => {
    const bundle = buildP05App({
      runtime: isolated.runtime, databaseUrl: isolated.databaseUrl,
      identityUnitOfWork: identity.identityUnitOfWork,
      browserSessionAuthority: identity.factory.authority, objectServerUrl: objectServer.url,
      attachmentsConfig: CONFIG,
    });
    try {
      const first = await issuePutComplete(bundle, identity.owner, objectServer, isolated.runtime);
      const proc = startP05WorkerProcess({
        databaseUrl: isolated.databaseUrl, objectServerUrl: objectServer.url,
      });
      active.push(proc);
      await waitForWorker(proc, async () =>
        (await p05BlobRow(isolated.runtime, first.receipt.blobId)).logical_state === 'stored_private'
        && (await p05OutboxRow(isolated.runtime, first.outboxId)).state === 'completed',
      { timeoutMs: 60_000, label: 'first subprocess convergence' });
      assert.equal((await p05BlobRow(isolated.runtime, first.receipt.blobId)).verified_sha256, first.digest);
      assert.equal((await p05OutboxRow(isolated.runtime, first.outboxId)).state, 'completed');
      assert.equal(await receiptCount(first.receipt.blobId), 1);

      // Graceful stop drains and exits cleanly.
      await proc.stop();
      assert.equal(proc.child.exitCode, 0,
        `graceful stop must exit 0 (stderr: ${proc.stderr.slice(-1_000)})`);

      // Restart: a fresh independent worker process consumes the next blob.
      const second = await issuePutComplete(bundle, identity.owner, objectServer, isolated.runtime, 3072);
      const restarted = startP05WorkerProcess({
        databaseUrl: isolated.databaseUrl, objectServerUrl: objectServer.url,
      });
      active.push(restarted);
      await waitForWorker(restarted, async () =>
        (await p05BlobRow(isolated.runtime, second.receipt.blobId)).logical_state === 'stored_private'
        && (await p05OutboxRow(isolated.runtime, second.outboxId)).state === 'completed',
      { timeoutMs: 60_000, label: 'restarted subprocess convergence' });
      assert.equal((await p05BlobRow(isolated.runtime, second.receipt.blobId)).verified_sha256, second.digest);
      assert.equal((await p05OutboxRow(isolated.runtime, second.outboxId)).state, 'completed');
      assert.equal(await receiptCount(second.receipt.blobId), 1);
      await restarted.stop();
      assert.equal(restarted.child.exitCode, 0);
    } finally {
      await bundle.app.close();
      await bundle.store.close();
    }
  }, 180_000);

  // POSIX-only: real SIGTERM delivery. On Windows `child.kill('SIGTERM')`
  // is TerminateProcess, so the JS SIGTERM/SIGINT handlers in the entry
  // (and in production `registerGracefulShutdown`) never run — the stdin
  // control channel above is the Windows graceful-stop path.
  const sigtermGracefulStop = process.platform === 'win32' ? test.skip : test;
  sigtermGracefulStop('SIGTERM triggers the same graceful stop with exit 0 (POSIX only)', async () => {
    const bundle = buildP05App({
      runtime: isolated.runtime, databaseUrl: isolated.databaseUrl,
      identityUnitOfWork: identity.identityUnitOfWork,
      browserSessionAuthority: identity.factory.authority, objectServerUrl: objectServer.url,
      attachmentsConfig: CONFIG,
    });
    try {
      const blob = await issuePutComplete(bundle, identity.owner, objectServer, isolated.runtime, 4096);
      const proc = startP05WorkerProcess({
        databaseUrl: isolated.databaseUrl, objectServerUrl: objectServer.url,
      });
      active.push(proc);
      await waitForWorker(proc, async () =>
        (await p05BlobRow(isolated.runtime, blob.receipt.blobId)).logical_state === 'stored_private'
        && (await p05OutboxRow(isolated.runtime, blob.outboxId)).state === 'completed',
      { timeoutMs: 60_000, label: 'sigterm convergence' });
      await proc.stop('SIGTERM');
      assert.equal(proc.child.exitCode, 0,
        `SIGTERM stop must exit 0 (stderr: ${proc.stderr.slice(-1_000)})`);
    } finally {
      await bundle.app.close();
      await bundle.store.close();
    }
  }, 180_000);

  test('SIGKILL after the durable claim: lease expiry + restart converge with one receipt', async () => {
    const bundle = buildP05App({
      runtime: isolated.runtime, databaseUrl: isolated.databaseUrl,
      identityUnitOfWork: identity.identityUnitOfWork,
      browserSessionAuthority: identity.factory.authority, objectServerUrl: objectServer.url,
      attachmentsConfig: CONFIG,
    });
    try {
      const blob = await issuePutComplete(bundle, identity.owner, objectServer, isolated.runtime);
      // The provider HEAD stalls so the worker stays mid-handler after the claim.
      objectServer.headDelays.set(blob.key, 15_000);
      const proc = startP05WorkerProcess({
        databaseUrl: isolated.databaseUrl, objectServerUrl: objectServer.url,
      });
      active.push(proc);
      await waitForWorker(proc, async () => {
        const outbox = await p05OutboxRow(isolated.runtime, blob.outboxId);
        const state = await p05BlobRow(isolated.runtime, blob.receipt.blobId);
        return outbox.state === 'leased' && state.logical_state === 'verifying';
      }, { timeoutMs: 30_000, label: 'durable claim before crash' });

      // Crash the process mid-handler: the claim survives, no completion.
      proc.child.kill('SIGKILL');
      await new Promise<void>((resolveExit) => proc.child.once('exit', () => resolveExit()));
      assert.equal((await p05OutboxRow(isolated.runtime, blob.outboxId)).state, 'leased',
        'the crash must not complete or fail the claim');
      assert.equal((await p05BlobRow(isolated.runtime, blob.receipt.blobId)).logical_state, 'verifying');

      // Lease expiry makes the stale claim takeoverable; restart converges.
      await expireP05Leases(isolated.runtime, blob.outboxId, blob.receipt.blobId);
      objectServer.headDelays.delete(blob.key);
      const restarted = startP05WorkerProcess({
        databaseUrl: isolated.databaseUrl, objectServerUrl: objectServer.url,
      });
      active.push(restarted);
      await waitForWorker(restarted, async () =>
        (await p05BlobRow(isolated.runtime, blob.receipt.blobId)).logical_state === 'stored_private'
        && (await p05OutboxRow(isolated.runtime, blob.outboxId)).state === 'completed',
      { timeoutMs: 60_000, label: 'takeover convergence' });
      assert.equal((await p05BlobRow(isolated.runtime, blob.receipt.blobId)).verified_sha256, blob.digest);
      assert.equal((await p05OutboxRow(isolated.runtime, blob.outboxId)).state, 'completed');
      assert.equal(await receiptCount(blob.receipt.blobId), 1,
        'crash + takeover must never double-verify');
      await restarted.stop();
      assert.equal(restarted.child.exitCode, 0);
    } finally {
      objectServer.headDelays.clear();
      await bundle.app.close();
      await bundle.store.close();
    }
  }, 180_000);

  test('PostgreSQL reconnect: terminated worker backends never stop convergence', async () => {
    const bundle = buildP05App({
      runtime: isolated.runtime, databaseUrl: isolated.databaseUrl,
      identityUnitOfWork: identity.identityUnitOfWork,
      browserSessionAuthority: identity.factory.authority, objectServerUrl: objectServer.url,
      attachmentsConfig: CONFIG,
    });
    const proc = startP05WorkerProcess({
      databaseUrl: isolated.databaseUrl, objectServerUrl: objectServer.url,
    });
    active.push(proc);
    try {
      const first = await issuePutComplete(bundle, identity.owner, objectServer, isolated.runtime);
      await waitForWorker(proc, async () =>
        (await p05BlobRow(isolated.runtime, first.receipt.blobId)).logical_state === 'stored_private'
        && (await p05OutboxRow(isolated.runtime, first.outboxId)).state === 'completed',
      { timeoutMs: 60_000, label: 'worker is live' });

      // Kill every PostgreSQL backend owned by the worker process.
      const terminated = await isolated.runtime.pool.query<{ pg_terminate_backend: boolean }>(
        `select pg_terminate_backend(pid) as pg_terminate_backend
         from pg_stat_activity
         where application_name = 'known-p05-worker' and pid <> pg_backend_pid()`,
      );
      assert.ok(terminated.rowCount >= 1, 'the worker must own at least one backend');
      assert.ok(proc.child.exitCode === null, 'the worker process must survive backend termination');

      // New product traffic still converges: the pool reconnects transparently.
      const second = await issuePutComplete(bundle, identity.owner, objectServer, isolated.runtime, 4096);
      await waitForWorker(proc, async () =>
        (await p05BlobRow(isolated.runtime, second.receipt.blobId)).logical_state === 'stored_private'
        && (await p05OutboxRow(isolated.runtime, second.outboxId)).state === 'completed',
      { timeoutMs: 60_000, label: 'convergence after reconnect' });
      assert.equal((await p05BlobRow(isolated.runtime, second.receipt.blobId)).verified_sha256, second.digest);
      assert.equal((await p05OutboxRow(isolated.runtime, second.outboxId)).state, 'completed');
      assert.equal(await receiptCount(second.receipt.blobId), 1);
      assert.equal((await p05BlobRow(isolated.runtime, first.receipt.blobId)).logical_state, 'stored_private');
      await proc.stop();
      assert.equal(proc.child.exitCode, 0);
    } finally {
      await bundle.app.close();
      await bundle.store.close();
    }
  }, 180_000);

  test('a stopped worker releases its leases so a new process drains the same rows', async () => {
    const bundle = buildP05App({
      runtime: isolated.runtime, databaseUrl: isolated.databaseUrl,
      identityUnitOfWork: identity.identityUnitOfWork,
      browserSessionAuthority: identity.factory.authority, objectServerUrl: objectServer.url,
      attachmentsConfig: CONFIG,
    });
    try {
      const blob = await issuePutComplete(bundle, identity.owner, objectServer, isolated.runtime);
      // The provider HEAD stalls so the worker stays mid-handler (2s window).
      objectServer.headDelays.set(blob.key, 15_000);
      const proc = startP05WorkerProcess({
        databaseUrl: isolated.databaseUrl, objectServerUrl: objectServer.url,
      });
      active.push(proc);
      // The worker claims and stalls; then we drain it.
      await waitForWorker(proc, async () => {
        const outbox = await p05OutboxRow(isolated.runtime, blob.outboxId);
        const state = await p05BlobRow(isolated.runtime, blob.receipt.blobId);
        return outbox.state === 'leased' && state.logical_state === 'verifying';
      }, { timeoutMs: 30_000, label: 'mid-handler claim' });
      await proc.stop();
      assert.equal(proc.child.exitCode, 0, 'drain must exit cleanly');
      assert.equal((await p05BlobRow(isolated.runtime, blob.receipt.blobId)).logical_state, 'verifying');
      assert.notEqual((await p05OutboxRow(isolated.runtime, blob.outboxId)).state, 'completed',
        'drained stop must never complete the row (it stays claimable)');

      // The row is only takeoverable after lease expiry; a fresh process drains it.
      await expireP05Leases(isolated.runtime, blob.outboxId, blob.receipt.blobId);
      objectServer.headDelays.delete(blob.key);
      const resumed = startP05WorkerProcess({
        databaseUrl: isolated.databaseUrl, objectServerUrl: objectServer.url,
      });
      active.push(resumed);
      await waitForWorker(resumed, async () =>
        (await p05BlobRow(isolated.runtime, blob.receipt.blobId)).logical_state === 'stored_private'
        && (await p05OutboxRow(isolated.runtime, blob.outboxId)).state === 'completed',
      { timeoutMs: 60_000, label: 'drain takeover convergence' });
      assert.equal((await p05OutboxRow(isolated.runtime, blob.outboxId)).state, 'completed');
      assert.equal((await p05BlobRow(isolated.runtime, blob.receipt.blobId)).verified_sha256, blob.digest);
      await resumed.stop();
      assert.equal(resumed.child.exitCode, 0);
    } finally {
      objectServer.headDelays.clear();
      await bundle.app.close();
      await bundle.store.close();
    }
  }, 180_000);
});
