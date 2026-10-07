/**
 * P4A-P05 shared helpers for the focused suites. Not a test file: it
 * matches no vitest test pattern and is never listed in a focused config.
 *
 * Provides:
 *  - `P05ObjectServer` (re-exported from `./phase4a-p05-object-server.js`): a
 *    REAL local HTTP/1.1 server with create-only PUT, exact-key HEAD/GET
 *    (conditional If-Match) and exact-key DELETE, plus per-key fault/delay
 *    scripting. The PRODUCTION R2 adapter is pointed at this server, so the
 *    Product issue grant is signed by the real `@aws-sdk` presigner, the
 *    independent HTTP client PUTs through the real transport, and the worker
 *    verification route reads the exact generation through the real adapter;
 *  - `makeP05Config`: the module `AttachmentsFeatureConfig` fixture with
 *    test-friendly (but config-contract-valid) timing: lease 6s / read 300ms
 *    / retention 1-1-1 days so expiry and cleanup are reachable with SQL
 *    clock aging, never wall-clock sleeps;
 *  - `p05WorkerEnvironment`: the exact env the PRODUCTION worker composition
 *    (`buildWorker` / the worker CLI entry) parses via `loadConfig` —
 *    ATTACHMENTS_ENABLED=true with a valid R2-shaped endpoint (the injected
 *    store talks to `P05ObjectServer`, so the config endpoint is inert);
 *  - `createP05ObjectStore`: the PRODUCTION R2 adapter over the local server
 *    with dummy-but-valid distinct RW/RO credentials (the local server never
 *    checks them);
 *  - `buildP05App`: the PRODUCTION app composition (reuses `buildP03App`);
 *  - `issuePutComplete`: the full Product flow (HTTP issue -> independent
 *    HTTP PUT -> HTTP complete) returning the receipt, physical key, etag and
 *    the one same-commit verification Outbox row;
 *  - `startP05WorkerProcess`: spawns a REAL independent worker process
 *    (`tests/support/phase4a-p05-worker-entry.ts` via tsx) that composes the
 *    PRODUCTION `buildWorker` with the same store/config and polls the outbox
 *    as any production worker. Its `stop()` defaults to the stdin control
 *    channel ("stop" + EOF) — the only graceful-stop path on Windows where
 *    `child.kill('SIGTERM')` is TerminateProcess; a passed signal exercises
 *    the real signal path (POSIX-only);
 *  - `waitFor`: bounded polling with real intervals (no short sleeps as the
 *    only synchronization).
 */
import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { sql } from 'kysely';
import { createR2GenerationStore, type BlobStorePort } from '../../src/infrastructure/object-storage/index.js';
import {
  P03_ORIGIN,
  buildP03App,
  seedP03Collection,
  sha256Hex,
  type P03AppBundle,
} from './phase4a-p03-test-helpers.js';
import {
  createIdentityMemoryState,
  createIdentityMemoryUnitOfWork,
  issueTestSession,
  type AuthenticatedTestClient,
} from './product-http-harness.js';
import { createInMemoryBetterAuthTestFactory } from './better-auth-test-factory.js';
import type { AttachmentsFeatureConfig } from '../../src/modules/attachments/index.js';
import type { I07MigrationRuntime } from './phase4a-i07-test-helpers.js';
import type { IdentityUnitOfWork } from '../../src/modules/identity/index.js';
import type { BrowserSessionAuthority } from '../../src/modules/auth/index.js';
import { waitForCondition, withRealTimeout } from './async-test-helpers.js';

export const P05_BUCKET = 'p05-test-bucket';
export const P05_LIVE_PREFIX = 'attachments/live/';
export const P05_PROBE_PREFIX = 'attachments/probe/';
export const P05_COLLECTION = 'p05-collection';
export const P05_R2_DUMMY_ENDPOINT = 'https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com';
export const P05_DELIVERY_ORIGIN = 'https://delivery.attachments-probe.invalid';
export const P05_RW_CREDENTIAL = {
  accessKeyId: 'p05rwaccesskeyid0000000000000000',
  secretAccessKey: 'p05-rw-secret-access-key-00000000000000000000',
};
export const P05_RO_CREDENTIAL = {
  accessKeyId: 'p05roaccesskeyid0000000000000000',
  secretAccessKey: 'p05-ro-secret-access-key-00000000000000000000',
};

export { P05ObjectServer } from './phase4a-p05-object-server.js';
// Local type binding for THIS module's own signatures (a re-export alone does
// not introduce a local name).
import type { P05ObjectServer } from './phase4a-p05-object-server.js';

// ---------------------------------------------------------------------------
// Config + environment
// ---------------------------------------------------------------------------

export function makeP05Config(overrides: Partial<AttachmentsFeatureConfig> = {}): AttachmentsFeatureConfig {
  const base: AttachmentsFeatureConfig = {
    enabled: true,
    r2: {
      endpoint: P05_R2_DUMMY_ENDPOINT,
      region: 'auto',
      bucket: P05_BUCKET,
      livePrefix: P05_LIVE_PREFIX,
      probePrefix: P05_PROBE_PREFIX,
      rwSecretRef: 'known/p05/r2/rw',
      roSecretRef: 'known/p05/r2/ro',
    },
    grantTtlSeconds: 60,
    singlePutMaxBytes: 5 * 1024 * 1024,
    allowedMedia: ['image/png', 'application/pdf', 'text/plain'],
    // leaseMs must cover timeoutMs * (retryCount + 1) + 5000 margin; 300*1+5000=5300.
    verification: { leaseMs: 6_000, timeoutMs: 300, retryCount: 0 },
    retention: { intentRetentionHours: 1, storedRetentionDays: 1, retiredRetentionDays: 1 },
    cleanupBatchSize: 10,
    cleanup: { leaseMs: 4_000, retryCount: 1 },
    isolatedDeliveryOrigin: P05_DELIVERY_ORIGIN,
    deliveryCapabilitySecretRef: 'known/p05/delivery/hmac',
    deliveryCapabilityTtlSeconds: 60,
  };
  return Object.freeze({ ...base, ...overrides, r2: { ...base.r2, ...overrides.r2 } });
}

/**
 * The exact env the PRODUCTION worker composition parses. `loadConfig`
 * requires the R2 endpoint shape, so the config endpoint is a valid dummy;
 * the injected store (`createP05ObjectStore`) talks to the local server.
 */
export function p05WorkerEnvironment(databaseUrl: string, overrides: Record<string, string> = {}): Record<string, string> {
  return {
    DATABASE_URL: databaseUrl,
    KNOWN_TEST_DATABASE_URL: databaseUrl,
    NODE_ENV: 'test',
    PRODUCT_ORIGIN: P03_ORIGIN,
    ALLOWED_ORIGINS: P03_ORIGIN,
    OIDC_ALLOW_TEST_PROVIDER: 'true',
    OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default',
    LOG_LEVEL: 'silent',
    ATTACHMENTS_ENABLED: 'true',
    ATTACHMENTS_R2_ENDPOINT: P05_R2_DUMMY_ENDPOINT,
    ATTACHMENTS_R2_REGION: 'auto',
    ATTACHMENTS_R2_BUCKET: P05_BUCKET,
    ATTACHMENTS_R2_LIVE_PREFIX: P05_LIVE_PREFIX,
    ATTACHMENTS_R2_PROBE_PREFIX: P05_PROBE_PREFIX,
    ATTACHMENTS_R2_RW_SECRET_REF: 'known/p05/r2/rw',
    ATTACHMENTS_R2_RO_SECRET_REF: 'known/p05/r2/ro',
    ATTACHMENTS_ISOLATED_DELIVERY_ORIGIN: P05_DELIVERY_ORIGIN,
    ATTACHMENTS_DELIVERY_CAPABILITY_SECRET_REF: 'known/p05/delivery/hmac',
    ATTACHMENTS_DELIVERY_CAPABILITY_TTL_SECONDS: '60',
    ATTACHMENTS_SINGLE_PUT_MAX_BYTES: '5242880',
    ATTACHMENTS_VERIFICATION_LEASE_MS: '6000',
    ATTACHMENTS_VERIFICATION_TIMEOUT_MS: '300',
    ATTACHMENTS_VERIFICATION_RETRY_COUNT: '0',
    ATTACHMENTS_INTENT_RETENTION_HOURS: '1',
    ATTACHMENTS_STORED_RETENTION_DAYS: '1',
    ATTACHMENTS_RETIRED_RETENTION_DAYS: '1',
    ATTACHMENTS_CLEANUP_BATCH_SIZE: '10',
    ATTACHMENTS_CLEANUP_LEASE_MS: '4000',
    ATTACHMENTS_CLEANUP_RETRY_COUNT: '1',
    WORKER_POLL_INTERVAL_MS: '50',
    WORKER_LEASE_DURATION_MS: '4000',
    WORKER_HEARTBEAT_INTERVAL_MS: '1000',
    WORKER_HANDLER_TIMEOUT_MS: '3000',
    WORKER_CONCURRENCY: '2',
    WORKER_BATCH_SIZE: '2',
    // loadConfig asserts feed/notification operation timeouts stay within the
    // worker lease budget (assertFeedOperationsConfig / Notification), so the
    // test-friendly short lease must be matched by these env seams.
    FEED_REBUILD_TIMEOUT_MS: '3000',
    NOTIFICATION_RECOVERY_TIMEOUT_MS: '3000',
    DATABASE_POOL_MAX: '12',
    ...overrides,
  };
}

export function createP05ObjectStore(objectServerUrl: string, config: AttachmentsFeatureConfig): BlobStorePort {
  return createR2GenerationStore({
    endpoint: objectServerUrl,
    region: 'auto',
    bucket: config.r2.bucket,
    livePrefix: config.r2.livePrefix,
    probePrefix: config.r2.probePrefix,
    rwCredential: P05_RW_CREDENTIAL,
    roCredential: P05_RO_CREDENTIAL,
    grantTtlSeconds: config.grantTtlSeconds,
    singlePutMaxBytes: config.singlePutMaxBytes,
  });
}

// ---------------------------------------------------------------------------
// Product-flow fixture helpers
// ---------------------------------------------------------------------------

export interface P05ProductIdentity {
  readonly identityUnitOfWork: ReturnType<typeof createIdentityMemoryUnitOfWork>;
  readonly factory: ReturnType<typeof createInMemoryBetterAuthTestFactory>;
  readonly owner: AuthenticatedTestClient;
  readonly member: AuthenticatedTestClient;
}

export async function seedP05Identity(
  now = new Date('2026-08-08T12:00:00.000Z'),
): Promise<P05ProductIdentity> {
  const identityUnitOfWork = createIdentityMemoryUnitOfWork(createIdentityMemoryState(now));
  const factory = createInMemoryBetterAuthTestFactory({ identityUnitOfWork });
  const owner = await issueTestSession({
    factory, subject: 'p05-owner', handle: 'p05_owner',
  });
  const member = await issueTestSession({
    factory, subject: 'p05-member', handle: 'p05_member',
  });
  return { identityUnitOfWork, factory, owner, member };
}

export async function seedP05Collection(
  runtime: I07MigrationRuntime['runtime'],
  ownerSubjectId: string,
): Promise<void> {
  await seedP03Collection(runtime, {
    collectionId: P05_COLLECTION,
    ownerSubjectId,
    members: [{ subjectId: ownerSubjectId, role: 'owner' }],
  });
}

export function buildP05App(options: {
  readonly runtime: I07MigrationRuntime['runtime'];
  readonly databaseUrl: string;
  readonly identityUnitOfWork: IdentityUnitOfWork;
  /** E1: Better Auth session authority (test factory); absent keeps legacy auth. */
  readonly browserSessionAuthority?: BrowserSessionAuthority;
  readonly objectServerUrl: string;
  readonly attachmentsConfig: AttachmentsFeatureConfig;
  readonly origin?: string;
}): P03AppBundle {
  return buildP03App({
    runtime: options.runtime,
    databaseUrl: options.databaseUrl,
    identityUnitOfWork: options.identityUnitOfWork,
    ...(options.browserSessionAuthority === undefined
      ? {}
      : { browserSessionAuthority: options.browserSessionAuthority }),
    objectServerUrl: options.objectServerUrl,
    attachmentsConfig: options.attachmentsConfig,
    ...(options.origin === undefined ? {} : { origin: options.origin }),
  });
}

export interface P05IssueReceipt {
  readonly blobId: string;
  readonly intentId: string;
  readonly generationId: string;
}

export interface P05IssueGrant {
  readonly url: string;
  readonly method: string;
  readonly contentType: string;
  readonly contentLength: number;
  readonly expiresAt: string;
  readonly ttlSeconds: number;
}

export interface P05CompletedBlob {
  readonly receipt: P05IssueReceipt;
  readonly key: string;
  readonly etag: string;
  readonly body: Buffer;
  readonly digest: string;
  readonly outboxId: string;
}

function p05Body(size = 2048): Buffer {
  const body = Buffer.alloc(size);
  body.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  for (let index = 8; index < body.length; index += 1) body[index] = index % 251;
  return body;
}

function mutationHeaders(client: AuthenticatedTestClient, commandId: string): Record<string, string> {
  return {
    cookie: client.cookie,
    origin: P03_ORIGIN,
    'x-csrf-token': client.csrfToken,
    'known-command-id': commandId,
    'content-type': 'application/json',
  };
}

/**
 * The FULL Product flow: production HTTP issue -> INDEPENDENT HTTP client PUT
 * against the real presigned URL -> production HTTP complete. Returns the
 * receipt, key, etag and the one same-commit verification Outbox row id.
 * Never touches handlers or the outbox directly.
 */
export async function issuePutComplete(
  bundle: P03AppBundle,
  client: AuthenticatedTestClient,
  objectServer: P05ObjectServer,
  runtime: I07MigrationRuntime['runtime'],
  size = 2048,
  options: { readonly declaredSha256?: string } = {},
): Promise<P05CompletedBlob> {
  const issued = await issueAndPut(bundle, client, objectServer, runtime, size, options);
  const completed = await completeIssued(bundle, client, issued, options);
  assert.equal(completed.kind, 'completed');
  const outboxRows = await runtime.pool.query<{ outbox_id: string }>(
    `select outbox_id from outbox_events
     where handler_name = 'attachments_verify_generation' and aggregate_id = $1`,
    [issued.receipt.blobId],
  );
  assert.equal(outboxRows.rowCount, 1);
  return {
    receipt: issued.receipt,
    key: issued.key,
    etag: issued.etag,
    body: issued.body,
    digest: issued.digest,
    outboxId: outboxRows.rows[0]!.outbox_id,
  };
}

/**
 * Production HTTP complete for an issued+PUT object. Returns the parsed body.
 * The caller controls WHEN the complete happens (late-upload, fault injection
 * before the outbox row exists, ...).
 */
export async function completeIssued(
  bundle: P03AppBundle,
  client: AuthenticatedTestClient,
  issued: P05IssuedAndPut,
  options: { readonly commandId?: string; readonly declaredSha256?: string } = {},
): Promise<{ kind: string; receipt: P05IssueReceipt }> {
  const complete = await bundle.app.inject({
    method: 'POST',
    url: '/api/v1/attachments/complete',
    headers: mutationHeaders(client, options.commandId ?? randomUUID()),
    payload: JSON.stringify({
      binding: issued.receipt,
      declared: {
        size: issued.body.byteLength,
        sha256: options.declaredSha256 ?? issued.digest,
        mediaType: 'image/png',
        etag: issued.etag,
      },
    }),
  });
  assert.equal(complete.statusCode, 200, complete.body);
  return complete.json() as { kind: string; receipt: P05IssueReceipt };
}

export interface P05IssuedAndPut {
  readonly receipt: P05IssueReceipt;
  readonly grant: P05IssueGrant;
  readonly key: string;
  readonly body: Buffer;
  readonly digest: string;
  readonly etag: string;
}

/**
 * Product issue + independent PUT WITHOUT complete (late-upload fixtures).
 * Returns the physical key resolved from the committed ledger.
 */
export async function issueAndPut(
  bundle: P03AppBundle,
  client: AuthenticatedTestClient,
  objectServer: P05ObjectServer,
  runtime: I07MigrationRuntime['runtime'],
  size = 2048,
  options: { readonly declaredSha256?: string } = {},
): Promise<P05IssuedAndPut> {
  const body = p05Body(size);
  const digest = sha256Hex(body);
  const issueCommandId = randomUUID();
  const issue = await bundle.app.inject({
    method: 'POST',
    url: '/api/v1/attachments/issue',
    headers: mutationHeaders(client, issueCommandId),
    payload: JSON.stringify({
      collectionId: P05_COLLECTION,
      declaredSize: body.byteLength,
      declaredSha256: options.declaredSha256 ?? digest,
      mediaHint: 'image/png',
      expectedPolicyRevision: null,
    }),
  });
  assert.equal(issue.statusCode, 201, issue.body);
  const issued = issue.json() as { receipt: P05IssueReceipt; grant: P05IssueGrant };
  const putResponse = await fetch(issued.grant.url, {
    method: 'PUT',
    headers: {
      'If-None-Match': '*',
      'Content-Type': issued.grant.contentType,
    },
    body: body as unknown as BodyInit,
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
  });
  assert.ok(putResponse.status === 200 || putResponse.status === 201,
    `independent PUT failed: ${putResponse.status}`);
  const etag = putResponse.headers.get('etag');
  assert.ok(etag, 'independent PUT must return an ETag');
  const keyRows = await runtime.pool.query<{ key: string }>(
    `select bg.key from upload_intents ui join blob_generations bg on bg.generation_id = ui.generation_id
     where ui.intent_id = $1`, [issued.receipt.intentId],
  );
  assert.equal(keyRows.rowCount, 1);
  assert.equal(objectServer.has(keyRows.rows[0]!.key), true);
  return {
    receipt: issued.receipt,
    grant: issued.grant,
    key: keyRows.rows[0]!.key,
    body,
    digest,
    etag,
  };
}

// ---------------------------------------------------------------------------
// Bounded polling (never short sleeps as the only synchronization)
// ---------------------------------------------------------------------------

export async function waitFor(
  predicate: () => Promise<boolean>,
  options: { readonly timeoutMs?: number; readonly intervalMs?: number; readonly label?: string } = {},
): Promise<void> {
  const label = options.label ?? 'predicate';
  let lastError: unknown;
  try {
    await waitForCondition(async () => {
      try {
        return await predicate();
      } catch (error: unknown) {
        lastError = error;
        return false;
      }
    }, {
      timeoutMs: options.timeoutMs ?? 30_000,
      pollIntervalMs: options.intervalMs ?? 100,
      description: `P05 condition: ${label}`,
    });
  } catch (error) {
    throw new Error(`waitFor timed out: ${label}`, { cause: lastError ?? error });
  }
}

// ---------------------------------------------------------------------------
// Independent worker subprocess
// ---------------------------------------------------------------------------

export interface P05WorkerProcessOptions {
  readonly databaseUrl: string;
  readonly objectServerUrl: string;
  readonly environment?: Record<string, string>;
  readonly cleanupIntervalMs?: number;
  readonly telemetryIntervalMs?: number;
  readonly alertConfigJson?: string;
  readonly workerId?: string;
}

export interface P05WorkerProcess {
  readonly child: ChildProcess;
  /** Graceful stop: stdin control channel ("stop" + EOF) by default,
   *  cross-platform; real-signal exercises are POSIX-only (Windows SIGTERM
   *  is TerminateProcess). SIGKILL hard-kills. */
  stop(signal?: P05StopRequest): Promise<void>;
  readonly stderr: string;
}

/** 'stdin-control' requests the cross-platform stdin stop channel. */
export type P05StopRequest = NodeJS.Signals | 'stdin-control';

const backendRoot = resolve(import.meta.dirname, '../..');

/**
 * Spawns a REAL independent worker process: `node --import tsx
 * tests/support/phase4a-p05-worker-entry.ts`. The child composes the
 * PRODUCTION `buildWorker` with the production R2 adapter over the local
 * object server and polls the real outbox — no test hook inside.
 */
export function startP05WorkerProcess(options: P05WorkerProcessOptions): P05WorkerProcess {
  const environment = p05WorkerEnvironment(options.databaseUrl, options.environment);
  const child = spawn(process.execPath, ['--import', 'tsx', 'tests/support/phase4a-p05-worker-entry.ts'], {
    cwd: backendRoot,
    env: {
      ...process.env,
      ...environment,
      P05_OBJECT_SERVER_URL: options.objectServerUrl,
      // Test-owned stdin stop channel (see the entry file).
      P05_CONTROL: 'stdin',
      ...(options.cleanupIntervalMs === undefined ? {} : { P05_CLEANUP_INTERVAL_MS: String(options.cleanupIntervalMs) }),
      ...(options.telemetryIntervalMs === undefined ? {} : { P05_TELEMETRY_INTERVAL_MS: String(options.telemetryIntervalMs) }),
      ...(options.alertConfigJson === undefined ? {} : { P05_ALERT_CONFIG_JSON: options.alertConfigJson }),
      ...(options.workerId === undefined ? {} : { P05_WORKER_ID: options.workerId }),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
  const exited = (): boolean => child.exitCode !== null || child.signalCode !== null;
  const stop = async (signal: P05StopRequest = 'stdin-control'): Promise<void> => {
    if (exited()) return;
    if (signal === 'stdin-control') {
      // Cross-platform graceful stop; the child runs the production stop path.
      const stdin = child.stdin;
      if (stdin && !stdin.destroyed) {
        stdin.write('stop\n');
        stdin.end();
      } else {
        child.kill('SIGTERM');
      }
    } else {
      child.kill(signal);
    }
    const exitPromise = new Promise<void>((resolveExit) => {
      if (exited()) {
        resolveExit();
        return;
      }
      child.once('exit', () => resolveExit());
    });
    try {
      await withRealTimeout(exitPromise, 30_000, 'P05 worker process did not stop gracefully');
    } catch {
      child.kill('SIGKILL');
      await exitPromise;
    }
  };
  return {
    child,
    stop,
    get stderr() { return stderr; },
  };
}

// ---------------------------------------------------------------------------
// SQL helpers (legal test preconditions / independent observations only)
// ---------------------------------------------------------------------------

/**
 * Ages outbox + verification leases so a crashed/stale claim is takeoverable;
 * also pushes `available_at` into the past so a drained `retryable` row is
 * immediately claimable (bounded wait, no short sleeps).
 */
export async function expireP05Leases(
  runtime: I07MigrationRuntime['runtime'],
  outboxId: string,
  blobId: string,
): Promise<void> {
  await runtime.pool.query(
    `update outbox_events set locked_until = current_timestamp - interval '1 second',
       available_at = current_timestamp - interval '1 second'
     where outbox_id = $1`,
    [outboxId],
  );
  await runtime.pool.query(
    `update blob_records set verification_lease_expires_at = current_timestamp - interval '1 second' where blob_id = $1`,
    [blobId],
  );
}

/** Ages an intent past its DB-clock deadline (late-upload precondition). */
export async function expireP05Intent(
  runtime: I07MigrationRuntime['runtime'],
  intentId: string,
): Promise<void> {
  await runtime.pool.query(
    `update upload_intents set expires_at = current_timestamp - interval '1 second' where intent_id = $1`,
    [intentId],
  );
}

/** Ages a cleanup candidate past the retention deadline (DB clock). */
export async function ageP05CleanupCandidate(
  runtime: I07MigrationRuntime['runtime'],
  generationId: string,
): Promise<void> {
  await runtime.pool.query(
    `update blob_generations set retired_at = current_timestamp - interval '2 days',
       orphaned_at = current_timestamp - interval '2 days'
     where generation_id = $1`,
    [generationId],
  );
}

export async function p05OutboxRow(
  runtime: I07MigrationRuntime['runtime'],
  outboxId: string,
): Promise<{ state: string; attempt_count: number; dead_lettered_at: Date | null }> {
  const rows = await sql<{ state: string; attempt_count: number; dead_lettered_at: Date | null }>`
    select state, attempt_count::int, dead_lettered_at
    from outbox_events where outbox_id = ${outboxId}
  `.execute(runtime.db);
  assert.ok(rows.rows[0], `outbox row ${outboxId} must exist`);
  return rows.rows[0]!;
}

export async function p05BlobRow(
  runtime: I07MigrationRuntime['runtime'],
  blobId: string,
): Promise<{ logical_state: string; verified_sha256: string | null; verification_lease_expires_at: Date | null }> {
  const rows = await sql<{ logical_state: string; verified_sha256: string | null; verification_lease_expires_at: Date | null }>`
    select logical_state, verified_sha256, verification_lease_expires_at
    from blob_records where blob_id = ${blobId}
  `.execute(runtime.db);
  assert.ok(rows.rows[0], `blob ${blobId} must exist`);
  return rows.rows[0]!;
}

export async function p05GenerationRow(
  runtime: I07MigrationRuntime['runtime'],
  generationId: string,
): Promise<{ generation_state: string; retire_reason: string | null; quarantined_reason: string | null }> {
  const rows = await sql<{ generation_state: string; retire_reason: string | null; quarantined_reason: string | null }>`
    select generation_state, retire_reason, quarantined_reason
    from blob_generations where generation_id = ${generationId}
  `.execute(runtime.db);
  assert.ok(rows.rows[0], `generation ${generationId} must exist`);
  return rows.rows[0]!;
}
