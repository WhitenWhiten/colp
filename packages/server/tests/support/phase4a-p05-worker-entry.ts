/**
 * P4A-P05 independent worker subprocess entry (test-owned).
 *
 * Spawned by the P05 focused suites as a REAL separate process
 * (`node --import tsx tests/support/phase4a-p05-worker-entry.ts`). It parses
 * the exact production env (`loadConfig`), composes the PRODUCTION
 * `buildWorker` with the production R2 adapter pointed at the suite's local
 * object server, and runs the worker loop until SIGTERM/SIGINT. No test hook
 * exists inside the composition: the verification outbox route, the cleanup
 * scheduler and the backlog telemetry are the production `buildWorker`
 * assembly from `src/bootstrap/worker.ts`.
 *
 * Environment:
 *  - DATABASE_URL / KNOWN_TEST_DATABASE_URL: schema-scoped PostgreSQL URL
 *  - P05_OBJECT_SERVER_URL: local S3-subset object server URL
 *  - P05_CLEANUP_INTERVAL_MS / P05_TELEMETRY_INTERVAL_MS: bounded timer seams
 *  - P05_ALERT_CONFIG_JSON: optional I15 alert thresholds (test seam)
 *  - P05_WORKER_ID: stable cleanup lease owner (test seam)
 *  - P05_CONTROL=stdin: test-owned stop channel — a "stop" line on stdin
 *    triggers the EXACT same graceful-stop path as SIGTERM/SIGINT. Needed
 *    because on Windows `child.kill('SIGTERM')` is TerminateProcess, so the
 *    JS signal handlers never run and no graceful stop is possible; the
 *    suites drive the stop through this channel there (and by default
 *    everywhere).
 *  - all ATTACHMENTS_* and WORKER_* vars produced by `p05WorkerEnvironment`
 */
import { randomUUID } from 'node:crypto';
import { loadConfig } from './test-config.js';
import { buildWorker } from '../../src/bootstrap/worker.js';
import { registerGracefulShutdown, DEFAULT_GRACEFUL_SHUTDOWN_DEADLINE_MS } from '../../src/bootstrap/process-lifecycle.js';
import { createDatabaseRuntime } from '../../src/infrastructure/database/index.js';
import { createR2GenerationStore } from '../../src/infrastructure/object-storage/index.js';
import { InMemoryMetrics } from '../../src/infrastructure/telemetry/index.js';
import type { AttachmentAlertConfig } from '../../src/modules/attachments/index.js';
import { P05_RW_CREDENTIAL, P05_RO_CREDENTIAL } from './phase4a-p05-test-helpers.js';

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`configuration_missing:${name}`);
  return value;
}

const databaseUrl = required('KNOWN_TEST_DATABASE_URL');
const objectServerUrl = required('P05_OBJECT_SERVER_URL');
const cleanupIntervalMs = Number(process.env.P05_CLEANUP_INTERVAL_MS ?? 60_000);
const telemetryIntervalMs = Number(process.env.P05_TELEMETRY_INTERVAL_MS ?? 30_000);
const alertConfigJson = process.env.P05_ALERT_CONFIG_JSON?.trim();
const workerId = process.env.P05_WORKER_ID?.trim() ?? `known-p05-worker-${randomUUID()}`;

const config = loadConfig(process.env);
if (!config.attachments) throw new Error('configuration_missing:ATTACHMENTS_ENABLED');

const database = createDatabaseRuntime(databaseUrl, {
  maxConnections: config.database.maxConnections,
  connectionTimeoutMs: config.database.connectionTimeoutMs,
  idleTimeoutMs: config.database.idleTimeoutMs,
  statementTimeoutMs: config.database.statementTimeoutMs,
  lockTimeoutMs: config.database.lockTimeoutMs,
  idleTransactionTimeoutMs: config.database.idleTransactionTimeoutMs,
  applicationName: 'known-p05-worker',
  production: config.nodeEnv === 'production',
});

const attachmentsObjectStorage = createR2GenerationStore({
  endpoint: objectServerUrl,
  region: 'auto',
  bucket: config.attachments.r2.bucket,
  livePrefix: config.attachments.r2.livePrefix,
  probePrefix: config.attachments.r2.probePrefix,
  rwCredential: P05_RW_CREDENTIAL,
  roCredential: P05_RO_CREDENTIAL,
  grantTtlSeconds: config.attachments.grantTtlSeconds,
  singlePutMaxBytes: config.attachments.singlePutMaxBytes,
});

const metrics = new InMemoryMetrics();
const worker = buildWorker(config, database, metrics, {
  attachmentsObjectStorage,
  attachmentsCleanupIntervalMs: cleanupIntervalMs,
  attachmentsTelemetryIntervalMs: telemetryIntervalMs,
  ...(alertConfigJson === undefined ? {} : { attachmentsAlertConfig: JSON.parse(alertConfigJson) as AttachmentAlertConfig }),
  attachmentsWorkerId: workerId,
});

/**
 * Single-flight graceful stop shared by the signal handlers and the stdin
 * control channel: waits for startup to settle, drains the worker (outbox
 * loop, cleanup scheduler, sampler), closes the object storage, then releases
 * the stdin handle so the event loop empties and the process exits 0
 * naturally. Failures flip the exit code to 1 (same contract as
 * `registerGracefulShutdown`).
 */
let stopRequested = false;
let stopPromise: Promise<void> | undefined;
async function stopWorker(): Promise<void> {
  stopPromise ??= (async () => {
    stopRequested = true;
    // Serialize with startup: stop() must never close the database under the
    // pending start() queries (the production CLI does the same), otherwise a
    // stop during startup surfaces as a misleading start failure.
    if (startPromise) await startPromise.catch(() => undefined);
    await worker.stop();
    await attachmentsObjectStorage.close?.().catch(() => undefined);
    if (process.env.P05_CONTROL === 'stdin') {
      process.stdin.removeAllListeners('data');
      process.stdin.pause();
    }
  })();
  return stopPromise;
}

function reportStopError(error: unknown): void {
  process.exitCode = 1;
  process.stderr.write(`p05_worker_stop_failed:${error instanceof Error ? error.message : String(error)}\n`);
}

const removeSignalHandlers = registerGracefulShutdown({ stop: stopWorker }, {
  onError: reportStopError,
  deadlineMs: DEFAULT_GRACEFUL_SHUTDOWN_DEADLINE_MS,
});

// Test-owned control channel: "stop" on stdin runs the same stopWorker as
// the signals. The suites write "stop" + EOF and assert exit 0 (the child
// must drain and exit cleanly on every platform).
if (process.env.P05_CONTROL === 'stdin') {
  process.stdin.setEncoding('utf8');
  let buffer = '';
  process.stdin.on('data', (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    if (lines.includes('stop')) {
      void stopWorker().catch(reportStopError);
    }
  });
  process.stdin.on('error', () => undefined);
}

// Startup promise: awaited by the stop path below, so a stop requested while
// startup is still settling waits for start() first (see stopWorker).
let startPromise: Promise<void> | undefined;
startPromise = worker.start().catch(async (error: unknown) => {
  removeSignalHandlers();
  // If a stop is already draining, it will close the runtime; otherwise close
  // it here so a failed startup never leaves the provider clients open.
  if (!stopRequested) {
    await worker.stop().catch(() => undefined);
    await attachmentsObjectStorage.close?.().catch(() => undefined);
  }
  process.stderr.write(`p05_worker_start_failed:${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
