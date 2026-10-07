/**
 * P4A-V4A-06 process-verified P11/RL06 harness support (not a vitest test
 * file).
 *
 * The V4A-06 focused gate (`test:phase4a:p11:process`) proves the owner-private
 * topology through REAL OS processes and REAL listening sockets:
 *
 *  - API A, API B and the Worker are spawned from the PRODUCTION bootstrap
 *    entrypoints (`src/bootstrap/api.ts`, `src/bootstrap/worker.ts`; the
 *    `dist` build when present) as independent child processes; the isolated
 *    delivery process reuses the V4A-04 helpers
 *    (`tests/support/phase4a-delivery-process-helpers.ts`) with its
 *    discovery/readiness protocol;
 *  - no fixed ports: API ports are OS-reserved ephemeral ports (the
 *    `reserveTcpPort` pattern) and the delivery port is reserved the same way
 *    because the capability audience (`ATTACHMENTS_ISOLATED_DELIVERY_ORIGIN`)
 *    must equal the delivery's bound origin before any process starts;
 *    every spawn is retried with a fresh reservation on bind failure
 *    (port-race handling);
 *  - every product interaction is a real HTTP fetch over the children's
 *    sockets; `Fastify.inject`, in-process composition and direct worker
 *    method calls are never used (the receipts record `injectCount: 0` and
 *    `workerDirectCallCount: 0`);
 *  - sessions are seeded into the real PostgreSQL `sessions` table (hashed
 *    token/CSRF material only) and requests carry the production session
 *    cookie + CSRF + Origin + Known-Command-Id headers;
 *  - readiness is a deadline-poll protocol (no fixed sleeps): API readiness =
 *    `/ready` 200 + the `api started` log line; worker readiness = the
 *    `worker started` log line; delivery readiness = the V4A-04
 *    `delivery_listening` discovery line + readiness route.
 *
 * Secrets travel ONLY through the child environment (never argv or files);
 * the child stdout/stderr is captured and the suite asserts no secret value
 * ever appears in it.
 */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Pool } from 'pg';
import { SESSION_COOKIE_NAME } from '../../src/transport/session-cookie.js';
import { deriveCsrfTokenRaw, hashSecret } from '../../src/modules/identity/domain/secrets.js';
import { P03_BUCKET, P03_RW_CREDENTIAL, P03_RO_CREDENTIAL } from './phase4a-p03-test-helpers.js';
import { p07Headers, p07Digest, p07KeyFromGrantUrl, type P07IssueResponse } from './phase4a-p07-test-helpers.js';
import { reserveTcpPort } from './runtime-process.js';
import {
  startDeliveryProcess,
  waitForDeliveryListening,
  waitForDeliveryReadiness,
  stopDeliveryProcess,
  type DeliveryProcessHandle,
} from './phase4a-delivery-process-helpers.js';
import { waitForCondition, withRealTimeout } from './async-test-helpers.js';

export const P11P_ORIGIN = 'https://app.known.example';
export const P11P_ISSUER = 'https://issuer.example';
/** The V4A-06 four-process harness identity the canonical gates bind (V4A-07). */
export const P11_PROCESS_HARNESS_ID = 'phase4a-p11-process' as const;
export const P11P_BUCKET = P03_BUCKET;
export const P11P_RW_CREDENTIAL = P03_RW_CREDENTIAL;
export const P11P_RO_CREDENTIAL = P03_RO_CREDENTIAL;
/** Deterministic synthetic capability HMAC secret (never a real credential). */
export const P11P_DELIVERY_SECRET = Buffer.from('p11p-delivery-capability-hmac-secret-0123456789abcdef', 'utf8');
/** Deterministic synthetic rate-limit HMAC key secret. */
export const P11P_RATE_LIMIT_SECRET = 'p11p-rate-limit-hmac-secret-0123456789abcdef';
/**
 * The capability audience every process shares (must be https; the delivery
 * binds a real loopback socket on a different host:port, exactly like the
 * P08/P11 delivery composition precedent).
 */
export const P11P_DELIVERY_ORIGIN_ID = 'https://delivery.p11p.invalid';
export const P11P_DELIVERY_HOST = '127.0.0.2';
export const P11P_READINESS_PATH = '/ready';
export const P11P_WORKER_STARTED_TOKEN = '"worker started"';
export const P11P_API_STARTED_TOKEN = '"api started"';

const backendRoot = resolve(import.meta.dirname, '../..');

// ---------------------------------------------------------------------------
// Process receipts (the observable facts the suite asserts; low-sensitivity:
// PIDs, host:port origins and exit codes only — never secrets/capabilities)
// ---------------------------------------------------------------------------

export interface P11KillRestartReceipt {
  readonly target: 'api-a' | 'api-b' | 'worker' | 'delivery';
  readonly signal: string;
  readonly exitCode: number | null;
  readonly restartedPid: number;
}

export interface P11ProcessReceipts {
  readonly pids: { readonly apiA: number; readonly apiB: number; readonly worker: number; readonly delivery: number };
  readonly origins: { readonly apiA: string; readonly apiB: string; readonly delivery: string };
  readonly workerStarted: true;
  readonly injectCount: 0;
  readonly workerDirectCallCount: 0;
  readonly killRestartReceipts: readonly P11KillRestartReceipt[];
}

/** Fixed receipt shape; throws on any drift (test-side contract assertion). */
export function assertP11ProcessReceipts(value: unknown): asserts value is P11ProcessReceipts {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value), 'receipts must be an object');
  const receipts = value as Record<string, unknown>;
  const pids = receipts.pids as Record<string, unknown>;
  assert.ok(pids && typeof pids === 'object', 'receipts.pids required');
  for (const name of ['apiA', 'apiB', 'worker', 'delivery'] as const) {
    assert.ok(Number.isSafeInteger(pids[name]), `receipts.pids.${name} must be an integer`);
  }
  const pidSet = new Set([pids.apiA, pids.apiB, pids.worker, pids.delivery]);
  assert.equal(pidSet.size, 4, 'the four processes must have mutually distinct OS PIDs');
  const origins = receipts.origins as Record<string, unknown>;
  assert.ok(origins && typeof origins === 'object', 'receipts.origins required');
  for (const name of ['apiA', 'apiB', 'delivery'] as const) {
    assert.equal(typeof origins[name], 'string', `receipts.origins.${name} must be a string`);
    const url = new URL(origins[name] as string);
    assert.ok(url.hostname.length > 0 && url.port.length > 0, `receipts.origins.${name} must be a real host:port origin`);
  }
  assert.equal(receipts.workerStarted, true, 'the worker started receipt must be observed');
  assert.equal(receipts.injectCount, 0, 'the API proof must use zero Fastify.inject calls');
  assert.equal(receipts.workerDirectCallCount, 0, 'the worker proof must use zero direct worker calls');
  const kills = receipts.killRestartReceipts;
  assert.ok(Array.isArray(kills) && kills.length >= 1, 'at least one kill/restart receipt is required');
  const pidKeyByTarget: Record<string, string> = { 'api-a': 'apiA', 'api-b': 'apiB', worker: 'worker', delivery: 'delivery' };
  for (const receipt of kills) {
    const entry = receipt as Record<string, unknown>;
    const pidKey = pidKeyByTarget[entry.target as string];
    assert.ok(pidKey !== undefined, 'kill receipt target invalid');
    assert.equal(typeof entry.signal, 'string', 'kill receipt signal required');
    assert.ok(entry.exitCode === null || Number.isSafeInteger(entry.exitCode), 'kill receipt exit code invalid');
    assert.ok(Number.isSafeInteger(entry.restartedPid) && (entry.restartedPid as number) > 0, 'kill receipt restarted pid invalid');
    const original = pids[pidKey] as number;
    assert.notEqual(entry.restartedPid, original, 'the restarted PID must differ from the killed process PID');
  }
}

// ---------------------------------------------------------------------------
// Generic child-process handle (spawn / captured output / exit observation)
// ---------------------------------------------------------------------------

export interface P11ProcessHandle {
  readonly label: string;
  readonly child: ChildProcess;
  readonly stdout: string;
  readonly stderr: string;
  readonly exited: boolean;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
}

export function spawnP11Process(
  label: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): P11ProcessHandle {
  const child = spawn(process.execPath, args, {
    cwd: backendRoot,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  return {
    label,
    child,
    get stdout() {
      return stdout;
    },
    get stderr() {
      return stderr;
    },
    get exited() {
      return child.exitCode !== null || child.signalCode !== null;
    },
    get exitCode() {
      return child.exitCode;
    },
    get signalCode() {
      return child.signalCode;
    },
  };
}

/** Waits for the child to exit (deadline; SIGKILL + throw on timeout). */
export async function waitForP11Exit(handle: P11ProcessHandle, timeoutMs = 30_000): Promise<number | null> {
  if (handle.exited) return handle.exitCode;
  const exitPromise = new Promise<number | null>((resolveExit) => {
    handle.child.once('exit', (code) => resolveExit(code));
  });
  try {
    return await withRealTimeout(
      exitPromise,
      timeoutMs,
      `${handle.label} did not exit within ${timeoutMs}ms; stderr: ${handle.stderr}`,
    );
  } catch (error) {
    handle.child.kill('SIGKILL');
    await exitPromise.catch(() => undefined);
    throw error;
  }
}

/** Sends a signal and waits for the child to exit (SIGKILL escalation). */
export async function stopP11Process(
  handle: P11ProcessHandle,
  options: { readonly signal?: NodeJS.Signals; readonly timeoutMs?: number } = {},
): Promise<number | null> {
  if (!handle.exited) handle.child.kill(options.signal ?? 'SIGTERM');
  return waitForP11Exit(handle, options.timeoutMs ?? 30_000);
}

// ---------------------------------------------------------------------------
// API process (production bootstrap entrypoint) + readiness protocol
// ---------------------------------------------------------------------------

export function startP11ApiProcess(env: NodeJS.ProcessEnv, label: string): P11ProcessHandle {
  const built = resolve(backendRoot, 'dist/src/bootstrap/api.js');
  const args = existsSync(built) ? [built] : ['--import', 'tsx', 'src/bootstrap/api.ts'];
  return spawnP11Process(label, args, env);
}

/** Polls `/ready` and the `api started` log line (deadline; never a sleep). */
export async function waitForP11ApiReady(handle: P11ProcessHandle, origin: string, timeoutMs = 60_000): Promise<void> {
  let lastError: unknown;
  try {
    await waitForCondition(async () => {
      if (handle.exited) {
        throw new Error(
          `${handle.label} exited before readiness (code=${handle.exitCode}, signal=${handle.signalCode}); stderr: ${handle.stderr}`,
        );
      }
      if (handle.stdout.includes(P11P_API_STARTED_TOKEN)) {
        try {
          const response = await fetch(`${origin}${P11P_READINESS_PATH}`, { signal: AbortSignal.timeout(1_000) });
          if (response.status === 200) return true;
          lastError = new Error(`readiness returned ${response.status}`);
        } catch (error) {
          lastError = error;
        }
      }
      return false;
    }, {
      timeoutMs,
      pollIntervalMs: 100,
      description: `${handle.label} readiness at ${origin}`,
    });
  } catch (error) {
    throw new Error(
      `${handle.label} did not become ready at ${origin} within ${timeoutMs}ms`,
      { cause: lastError ?? error },
    );
  }
}

/**
 * Reserves an ephemeral port, spawns an API process and waits for readiness.
 * On early exit or bind failure the child is reaped and a fresh reservation
 * is tried (port-race handling); returns the running handle + bound origin.
 */
export async function startReadyP11Api(
  env: NodeJS.ProcessEnv,
  label: string,
  attempts = 3,
): Promise<{ handle: P11ProcessHandle; origin: string }> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const port = await reserveTcpPort();
    const handle = startP11ApiProcess({ ...env, HOST: '127.0.0.1', PORT: String(port) }, label);
    const origin = `http://127.0.0.1:${port}`;
    try {
      await waitForP11ApiReady(handle, origin);
      return { handle, origin };
    } catch (error) {
      lastError = error;
      await stopP11Process(handle, { timeoutMs: 10_000 }).catch(() => undefined);
    }
  }
  throw new Error(`${label} failed to start after ${attempts} attempts`, { cause: lastError });
}

// ---------------------------------------------------------------------------
// Worker process (production bootstrap entrypoint) + readiness protocol
// ---------------------------------------------------------------------------

export function startP11WorkerProcess(env: NodeJS.ProcessEnv): P11ProcessHandle {
  const built = resolve(backendRoot, 'dist/src/bootstrap/worker.js');
  const args = existsSync(built) ? [built] : ['--import', 'tsx', 'src/bootstrap/worker.ts'];
  return spawnP11Process('worker', args, env);
}

/** Waits for the `worker started` log line (deadline; never a sleep). */
export async function waitForP11WorkerStarted(handle: P11ProcessHandle, timeoutMs = 60_000): Promise<void> {
  await waitForCondition(() => {
    if (handle.exited) {
      throw new Error(
        `worker exited before start (code=${handle.exitCode}, signal=${handle.signalCode}); stderr: ${handle.stderr}`,
      );
    }
    return handle.stdout.includes(P11P_WORKER_STARTED_TOKEN);
  }, {
    timeoutMs,
    pollIntervalMs: 100,
    description: 'the P11 worker start log line',
  });
}

export async function startReadyP11Worker(env: NodeJS.ProcessEnv): Promise<P11ProcessHandle> {
  const handle = startP11WorkerProcess(env);
  await waitForP11WorkerStarted(handle);
  return handle;
}

// ---------------------------------------------------------------------------
// Delivery process (V4A-04 executable, fixed reserved origin)
// ---------------------------------------------------------------------------

/**
 * Starts the isolated delivery process (V4A-04 executable) with the real
 * discovery protocol: `ATTACHMENTS_DELIVERY_PORT=0` and the
 * `delivery_listening <bound-origin>` line. The capability audience is the
 * fixed https origin shared by every process
 * (`P11P_DELIVERY_ORIGIN_ID`), so the discovered bound origin is used only
 * for real HTTP fetches. On early exit the child is reaped and retried.
 */
export async function startReadyP11Delivery(
  env: NodeJS.ProcessEnv,
  attempts = 3,
): Promise<{ handle: DeliveryProcessHandle; origin: string }> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const handle = startDeliveryProcess({ ...env, ATTACHMENTS_DELIVERY_PORT: '0' });
    try {
      const origin = await waitForDeliveryListening(handle);
      await waitForDeliveryReadiness(`${origin}/-/ready`);
      return { handle, origin };
    } catch (error) {
      lastError = error;
      await stopDeliveryProcess(handle, { timeoutMs: 10_000 }).catch(() => undefined);
    }
  }
  throw new Error(`delivery failed to start after ${attempts} attempts`, { cause: lastError });
}

// ---------------------------------------------------------------------------
// Shared process environment (secrets only via env; run-random prefix)
// ---------------------------------------------------------------------------

export interface P11ProcessEnvInput {
  readonly databaseUrl: string;
  readonly redisUrl: string;
  readonly objectServerUrl: string;
  readonly keyPrefix: string;
  readonly livePrefix: string;
  readonly probePrefix: string;
  /** Real-R2 override: endpoint/bucket/credentials replace the local fixtures. */
  readonly r2?: {
    readonly endpoint: string;
    readonly bucket: string;
    readonly rwCredential: { readonly accessKeyId: string; readonly secretAccessKey: string };
    readonly roCredential: { readonly accessKeyId: string; readonly secretAccessKey: string };
  };
  /** Verification budgets must equal the recorded config facts (V4A-07). */
  readonly verification?: { readonly leaseMs: number; readonly timeoutMs: number; readonly retryCount: number };
  readonly grantTtlSeconds?: number;
  readonly singlePutMaxBytes?: number;
  readonly rateLimitBudgets?: Partial<{
    readonly issueRateMax: number;
    readonly downloadRateMax: number;
    readonly completeRateMax: number;
    readonly completeEmergencyRateMax: number;
  }>;
}

export function buildP11ProcessEnv(input: P11ProcessEnvInput): Record<string, string> {
  const budgets = input.rateLimitBudgets ?? {};
  const r2 = input.r2;
  const verification = input.verification ?? { leaseMs: 6_000, timeoutMs: 1_000, retryCount: 0 };
  return {
    NODE_ENV: 'test',
    // P11 spawns the real production bootstrap (api/worker). It provisions
    // attachment R2, not the private library-export bucket, so exports stay off
    // exactly as tests/support/test-config.ts does for in-process suites.
    KNOWN_FEATURE_EXPORT_JOBS: 'false',
    DATABASE_URL: input.databaseUrl,
    PRODUCT_ORIGIN: P11P_ORIGIN,
    ALLOWED_ORIGINS: P11P_ORIGIN,
    LOG_LEVEL: 'info',
    OIDC_ALLOW_TEST_PROVIDER: 'true',
    OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default',
    ATTACHMENTS_ENABLED: 'true',
    ATTACHMENTS_R2_ENDPOINT: r2?.endpoint ?? input.objectServerUrl,
    ATTACHMENTS_R2_REGION: 'auto',
    ATTACHMENTS_R2_BUCKET: r2?.bucket ?? P11P_BUCKET,
    ATTACHMENTS_R2_LIVE_PREFIX: input.livePrefix,
    ATTACHMENTS_R2_PROBE_PREFIX: input.probePrefix,
    ATTACHMENTS_R2_RW_SECRET_REF: 'known/p11p/r2/rw',
    ATTACHMENTS_R2_RO_SECRET_REF: 'known/p11p/r2/ro',
    ATTACHMENTS_R2_RW_ACCESS_KEY_ID: r2?.rwCredential.accessKeyId ?? P11P_RW_CREDENTIAL.accessKeyId,
    ATTACHMENTS_R2_RW_SECRET_ACCESS_KEY: r2?.rwCredential.secretAccessKey ?? P11P_RW_CREDENTIAL.secretAccessKey,
    ATTACHMENTS_R2_RO_ACCESS_KEY_ID: r2?.roCredential.accessKeyId ?? P11P_RO_CREDENTIAL.accessKeyId,
    ATTACHMENTS_R2_RO_SECRET_ACCESS_KEY: r2?.roCredential.secretAccessKey ?? P11P_RO_CREDENTIAL.secretAccessKey,
    ATTACHMENTS_ISOLATED_DELIVERY_ORIGIN: P11P_DELIVERY_ORIGIN_ID,
    ATTACHMENTS_DELIVERY_CAPABILITY_SECRET_REF: 'known/p11p/delivery/hmac',
    ATTACHMENTS_DELIVERY_CAPABILITY_HMAC: P11P_DELIVERY_SECRET.toString('utf8'),
    ATTACHMENTS_DELIVERY_CAPABILITY_TTL_SECONDS: String(input.grantTtlSeconds ?? 60),
    ATTACHMENTS_RATE_LIMIT_MODE: 'enforce',
    ATTACHMENTS_RATE_LIMIT_REQUIRED: 'true',
    ATTACHMENTS_RATE_LIMIT_REDIS_URL: input.redisUrl,
    ATTACHMENTS_RATE_LIMIT_KEY_SECRET: 'known/p11p/ratelimit/hmac',
    ATTACHMENTS_RATE_LIMIT_KEY_SECRET_HMAC: P11P_RATE_LIMIT_SECRET,
    ATTACHMENTS_RATE_LIMIT_KEY_PREFIX: input.keyPrefix,
    ATTACHMENTS_RATE_LIMIT_COMMAND_TIMEOUT_MS: '750',
    ATTACHMENTS_RATE_LIMIT_CONNECT_TIMEOUT_MS: '3000',
    ATTACHMENTS_RATE_LIMIT_MAX_RETRIES_PER_REQUEST: '1',
    ATTACHMENTS_UPLOAD_ISSUE_RATE_MAX: String(budgets.issueRateMax ?? 3),
    ATTACHMENTS_UPLOAD_ISSUE_RATE_WINDOW_MS: '60000',
    ATTACHMENTS_UPLOAD_COMPLETE_RATE_MAX: String(budgets.completeRateMax ?? 10),
    ATTACHMENTS_UPLOAD_COMPLETE_RATE_WINDOW_MS: '60000',
    ATTACHMENTS_DOWNLOAD_RATE_MAX: String(budgets.downloadRateMax ?? 3),
    ATTACHMENTS_DOWNLOAD_RATE_WINDOW_MS: '60000',
    ATTACHMENTS_COMPLETE_EMERGENCY_RATE_MAX: String(budgets.completeEmergencyRateMax ?? 2),
    ATTACHMENTS_COMPLETE_EMERGENCY_RATE_WINDOW_MS: '60000',
    ATTACHMENTS_SINGLE_PUT_MAX_BYTES: String(input.singlePutMaxBytes ?? 5 * 1024 * 1024),
    // Worker loop: fast poll, short verification lease (takeover is quick).
    WORKER_CONCURRENCY: '4',
    WORKER_BATCH_SIZE: '4',
    WORKER_POLL_INTERVAL_MS: '200',
    WORKER_LEASE_DURATION_MS: '10000',
    WORKER_HEARTBEAT_INTERVAL_MS: '1000',
    WORKER_HANDLER_TIMEOUT_MS: '5000',
    FEED_REBUILD_TIMEOUT_MS: '5000',
    NOTIFICATION_RECOVERY_TIMEOUT_MS: '5000',
    DATABASE_POOL_MAX: '8',
    // Verification budgets: lease must cover timeout*(retry+1)+5000 margin.
    ATTACHMENTS_VERIFICATION_LEASE_MS: String(verification.leaseMs),
    ATTACHMENTS_VERIFICATION_TIMEOUT_MS: String(verification.timeoutMs),
    ATTACHMENTS_VERIFICATION_RETRY_COUNT: String(verification.retryCount),
    ATTACHMENTS_INTENT_RETENTION_HOURS: '1',
    ATTACHMENTS_STORED_RETENTION_DAYS: '1',
    ATTACHMENTS_RETIRED_RETENTION_DAYS: '1',
    ATTACHMENTS_CLEANUP_BATCH_SIZE: '10',
    ATTACHMENTS_CLEANUP_LEASE_MS: '2000',
    ATTACHMENTS_CLEANUP_RETRY_COUNT: '1',
  };
}

/** Delivery child env: dedicated RO DSN + the same shared capability/R2 secrets. */
export function buildP11DeliveryEnv(input: {
  readonly databaseUrl: string;
  readonly deliveryReadOnlyDatabaseUrl: string;
  readonly objectServerUrl: string;
  readonly livePrefix: string;
  readonly probePrefix: string;
  /** Real-R2 override: endpoint/bucket/RO credential replace the local fixtures. */
  readonly r2?: {
    readonly endpoint: string;
    readonly bucket: string;
    readonly roCredential: { readonly accessKeyId: string; readonly secretAccessKey: string };
  };
}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'test',
    PRODUCT_ORIGIN: P11P_ORIGIN,
    ATTACHMENTS_ENABLED: 'true',
    ATTACHMENTS_R2_ENDPOINT: input.r2?.endpoint ?? input.objectServerUrl,
    ATTACHMENTS_R2_REGION: 'auto',
    ATTACHMENTS_R2_BUCKET: input.r2?.bucket ?? P11P_BUCKET,
    ATTACHMENTS_R2_LIVE_PREFIX: input.livePrefix,
    ATTACHMENTS_R2_PROBE_PREFIX: input.probePrefix,
    ATTACHMENTS_R2_RW_SECRET_REF: 'known/p11p/r2/rw',
    ATTACHMENTS_R2_RO_SECRET_REF: 'known/p11p/r2/ro',
    ATTACHMENTS_R2_RO_ACCESS_KEY_ID: input.r2?.roCredential.accessKeyId ?? P11P_RO_CREDENTIAL.accessKeyId,
    ATTACHMENTS_R2_RO_SECRET_ACCESS_KEY: input.r2?.roCredential.secretAccessKey ?? P11P_RO_CREDENTIAL.secretAccessKey,
    ATTACHMENTS_ISOLATED_DELIVERY_ORIGIN: P11P_DELIVERY_ORIGIN_ID,
    ATTACHMENTS_DELIVERY_CAPABILITY_SECRET_REF: 'known/p11p/delivery/hmac',
    ATTACHMENTS_DELIVERY_CAPABILITY_HMAC: P11P_DELIVERY_SECRET.toString('utf8'),
    ATTACHMENTS_DELIVERY_DATABASE_URL: input.deliveryReadOnlyDatabaseUrl,
    ATTACHMENTS_DELIVERY_HOST: P11P_DELIVERY_HOST,
    ATTACHMENTS_DELIVERY_PORT: '0',
    ATTACHMENTS_DELIVERY_SHUTDOWN_TIMEOUT_MS: '10000',
  };
}

// ---------------------------------------------------------------------------
// Session + collection seeding (fixture facts only; product proof is HTTP)
// ---------------------------------------------------------------------------

export interface P11ProcessActor {
  readonly cookie: string;
  readonly csrfToken: string;
  readonly accountId: string;
  readonly subjectId: string;
}

/**
 * @deprecated Legacy product-session fixture (Task E1 quarantine): mints a
 * LEGACY `sessions` row directly from a raw token. Kept ONLY for the offline
 * phase4a evidence CLI (`scripts/phase4a-owner-private-evidence.ts`, which is
 * outside the vitest test boundary and out of E1's file scope). Active tests
 * must mint sessions through `tests/support/better-auth-test-factory.ts`;
 * new code must not call this helper (plan §11 E1 假阳性防护: no raw token
 * insertion into `sessions` by test helpers).
 */
export async function seedP11Actor(pool: Pool, subject: string, handle: string): Promise<P11ProcessActor> {
  const rawSessionToken = randomBytes(32).toString('base64url');
  const rawCsrfToken = deriveCsrfTokenRaw(rawSessionToken);
  // The production public-profile mapper only accepts ULID-shaped account
  // ids (`^[A-Za-z0-9_-]{21}[AQgw]$`), so the fixture derives one.
  const accountId = ulidShapedId(`p11p-account-${subject}-${randomUUID()}`);
  const sessionId = `p11p-session-${randomUUID()}`;
  await pool.query('begin');
  try {
    await pool.query(
      `insert into accounts (id, subject_id, status, security_epoch) values ($1, $2, 'active', 0)`,
      [accountId, subject],
    );
    await pool.query(
      `insert into profiles (account_id, display_name, avatar_url) values ($1, $2, null)`,
      [accountId, handle],
    );
    await pool.query(
      `insert into profile_handles (handle, account_id) values ($1, $2)`,
      [handle, accountId],
    );
    await pool.query(
      `insert into sessions
         (id, account_id, idle_expires_at, absolute_expires_at, csrf_token_hash,
          token_hash, security_epoch, rotated_from_session_id, last_seen_at, revoked_at, created_at)
       values ($1, $2, current_timestamp + interval '30 minutes', current_timestamp + interval '24 hours',
               $3, $4, 0, null, current_timestamp, null, current_timestamp)`,
      [sessionId, accountId, hashSecret(rawCsrfToken), hashSecret(rawSessionToken)],
    );
    await pool.query('commit');
  } catch (error) {
    await pool.query('rollback').catch(() => undefined);
    throw error;
  }
  return {
    cookie: `${SESSION_COOKIE_NAME}=${encodeURIComponent(rawSessionToken)}`,
    csrfToken: rawCsrfToken,
    accountId,
    subjectId: subject,
  };
}

/**
 * Seeds a private attachment collection owned by the subject (the
 * owner-private fixture; never visible to public consumers). Optional
 * additional members (e.g. the recovery subject) can be passed.
 */
export async function seedP11AttachmentCollection(
  pool: Pool,
  collectionId: string,
  ownerSubjectId: string,
  members: readonly { readonly subjectId: string; readonly role: string }[] = [],
): Promise<void> {
  const rootId = `${collectionId}-root`;
  await pool.query('begin');
  try {
    await pool.query(
      `insert into resource_id_ledger (resource_id, resource_type)
       values ($1, 'collection'), ($2, 'node')`,
      [collectionId, rootId],
    );
    await pool.query(
      `insert into collections
         (id, owner_subject_id, title, kind, root_node_id, resource_revision,
          content_revision, policy_revision, visibility, commit_ordinal,
          created_at, updated_at, deleted_at)
       values ($1, $2, $3, 'bookmarks', $4, $5, $6, $7, 'private', 1, now(), now(), null)`,
      [collectionId, ownerSubjectId, `P11P collection ${collectionId}`, rootId,
        `resource-${collectionId}`, `content-${collectionId}`, `policy-${collectionId}`],
    );
    await pool.query(
      `insert into nodes
         (id, collection_id, kind, is_root, title, resource_revision, children_revision, deleted_at)
       values ($1, $2, 'folder', true, 'Root', 'r1', 'ch1', null)`,
      [rootId, collectionId],
    );
    await pool.query(
      `insert into collection_members (collection_id, subject_id, role, granted_at)
       values ($1, $2, 'owner', now())`,
      [collectionId, ownerSubjectId],
    );
    for (const member of members) {
      await pool.query(
        `insert into collection_members (collection_id, subject_id, role, granted_at)
         values ($1, $2, $3, now())`,
        [collectionId, member.subjectId, member.role],
      );
    }
    await pool.query('commit');
  } catch (error) {
    await pool.query('rollback').catch(() => undefined);
    throw error;
  }
}

/**
 * Seeds a PUBLISHED public control collection (the consumer-exclusion
 * control resource: visible on public consumers, unlike the private
 * attachment collection and its markers).
 */
export async function seedP11PublicControlCollection(
  pool: Pool,
  input: { readonly collectionId: string; readonly ownerSubjectId: string; readonly slug: string; readonly title: string },
): Promise<void> {
  const rootId = `${input.collectionId}-root`;
  await pool.query('begin');
  try {
    await pool.query(
      `insert into resource_id_ledger (resource_id, resource_type)
       values ($1, 'collection'), ($2, 'node')`,
      [input.collectionId, rootId],
    );
    await pool.query(
      `insert into collections
         (id, owner_subject_id, title, summary, kind, visibility, allow_search_indexing,
          root_node_id, resource_revision, content_revision, policy_revision,
          publication_slug, published_at, created_at, updated_at, deleted_at)
       values ($1, $2, $3, 'P11P public control collection.', 'bookmarks', 'public', true,
          $4, 'r1', 'c1', 'p1', $5, current_timestamp, current_timestamp, current_timestamp, null)`,
      [input.collectionId, input.ownerSubjectId, input.title, rootId, input.slug],
    );
    await pool.query(
      `insert into nodes
         (id, collection_id, kind, is_root, title, resource_revision, children_revision, deleted_at)
       values ($1, $2, 'folder', true, 'Root', 'r1', 'ch1', null)`,
      [rootId, input.collectionId],
    );
    await pool.query(
      `insert into collection_members (collection_id, subject_id, role, granted_at)
       values ($1, $2, 'owner', now())`,
      [input.collectionId, input.ownerSubjectId],
    );
    await pool.query('commit');
  } catch (error) {
    await pool.query('rollback').catch(() => undefined);
    throw error;
  }
}

/** 22-char ULID-shaped identity (21 body chars + a checksum-shaped tail char). */
function ulidShapedId(seed: string): string {
  const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_-';
  const digest = createHash('sha256').update(seed, 'utf8').digest();
  let out = '';
  for (let index = 0; index < 21; index += 1) out += alphabet[digest[index]! % alphabet.length];
  out += 'AQgw'[digest[21]! % 4];
  return out;
}

// ---------------------------------------------------------------------------
// Real-HTTP product wrappers (every request over the children's sockets)
// ---------------------------------------------------------------------------

export interface P11PHttpResponse {
  readonly statusCode: number;
  readonly headers: Record<string, string>;
  readonly body: string;
}

async function p11pFetch(origin: string, path: string, init: RequestInit = {}): Promise<P11PHttpResponse> {
  const response = await fetch(`${origin}${path}`, {
    ...init,
    headers: { accept: 'application/json', ...(init.headers as Record<string, string> | undefined) },
    signal: init.signal ?? AbortSignal.timeout(30_000),
  });
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });
  return { statusCode: response.status, headers, body: await response.text() };
}

export async function p11pIssue(
  origin: string,
  actor: P11ProcessActor,
  collectionId: string,
  body: Uint8Array,
  commandId = randomUUID(),
  mediaHint = 'image/png',
): Promise<P11PHttpResponse> {
  return p11pFetch(origin, '/api/v1/attachments/issue', {
    method: 'POST',
    headers: p07Headers(actor, commandId),
    body: JSON.stringify({
      collectionId,
      declaredSize: body.byteLength,
      declaredSha256: p07Digest(body),
      mediaHint,
      expectedPolicyRevision: null,
    }),
  });
}

export async function p11pComplete(
  origin: string,
  actor: P11ProcessActor,
  binding: { blobId: string; intentId: string; generationId: string },
  body: Uint8Array,
  etag: string,
  commandId = randomUUID(),
  mediaType = 'image/png',
): Promise<P11PHttpResponse> {
  return p11pFetch(origin, '/api/v1/attachments/complete', {
    method: 'POST',
    headers: p07Headers(actor, commandId),
    body: JSON.stringify({
      binding,
      declared: { size: body.byteLength, sha256: p07Digest(body), mediaType, etag },
    }),
  });
}

export async function p11pStatus(
  origin: string,
  actor: P11ProcessActor,
  blobId: string,
): Promise<P11PHttpResponse> {
  return p11pFetch(origin, `/api/v1/attachments/${encodeURIComponent(blobId)}`, {
    method: 'GET',
    headers: { cookie: actor.cookie },
  });
}

export async function p11pAdmit(
  origin: string,
  actor: P11ProcessActor,
  blobId: string,
): Promise<P11PHttpResponse> {
  // No content-type: the admission route has no body (an empty JSON body
  // would be rejected 400 by the transport).
  return p11pFetch(origin, `/api/v1/attachments/${encodeURIComponent(blobId)}/download`, {
    method: 'POST',
    headers: { cookie: actor.cookie, origin: P11P_ORIGIN, 'x-csrf-token': actor.csrfToken },
  });
}

export async function p11pFinalize(
  origin: string,
  actor: P11ProcessActor,
  blobId: string,
  commandId = randomUUID(),
): Promise<P11PHttpResponse> {
  return p11pFetch(origin, `/api/v1/attachments/${encodeURIComponent(blobId)}/finalize`, {
    method: 'POST',
    headers: p07Headers(actor, commandId),
    body: '{}',
  });
}

export async function p11pRetire(
  origin: string,
  actor: P11ProcessActor,
  blobId: string,
  commandId = randomUUID(),
): Promise<P11PHttpResponse> {
  return p11pFetch(origin, `/api/v1/attachments/${encodeURIComponent(blobId)}/retire`, {
    method: 'POST',
    headers: p07Headers(actor, commandId),
    body: '{}',
  });
}

export async function p11pReplacement(
  origin: string,
  actor: P11ProcessActor,
  blobId: string,
  body: Uint8Array,
  commandId = randomUUID(),
): Promise<P11PHttpResponse> {
  return p11pFetch(origin, `/api/v1/attachments/${encodeURIComponent(blobId)}/replacement`, {
    method: 'POST',
    headers: p07Headers(actor, commandId),
    body: JSON.stringify({
      declaredSize: body.byteLength,
      declaredSha256: p07Digest(body),
      mediaHint: 'image/png',
      expectedPolicyRevision: null,
    }),
  });
}

/** The stable Attachment Problem envelope (code + real quota facts). */
export function p11pProblemOf(body: string): {
  readonly error: { readonly code: string; readonly retryAfterSeconds: number | null };
} {
  return JSON.parse(body) as { error: { code: string; retryAfterSeconds: number | null } };
}

// ---------------------------------------------------------------------------
// DB side-effect helpers (assertions over the shared PostgreSQL schema)
// ---------------------------------------------------------------------------

export async function p11pWaitForBlobState(
  pool: Pool,
  blobId: string,
  expected: string,
  timeoutMs = 120_000,
): Promise<string> {
  let last: string | undefined;
  await waitForCondition(async () => {
    const result = await pool.query<{ logical_state: string }>(
      'select logical_state from blob_records where blob_id = $1',
      [blobId],
    );
    last = result.rows[0]?.logical_state;
    return last === expected;
  }, {
    timeoutMs,
    pollIntervalMs: 100,
    description: `blob ${blobId} to reach ${expected}`,
  });
  if (last !== expected) {
    throw new Error(`blob ${blobId} did not reach ${expected} within ${timeoutMs}ms (last: ${String(last)})`);
  }
  return last;
}

export async function p11pReadGeneration(
  pool: Pool,
  generationId: string,
): Promise<{ generation_state: string; retire_reason: string | null; retired_at: Date | null } | null> {
  const result = await pool.query<{ generation_state: string; retire_reason: string | null; retired_at: Date | null }>(
    'select generation_state, retire_reason, retired_at from blob_generations where generation_id = $1',
    [generationId],
  );
  return result.rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// Object-server helpers (exact-key cleanup + absence proofs)
// ---------------------------------------------------------------------------

/** Deletes one exact key from the local object server (final cleanup). */
export async function p11pObjectDelete(objectServerUrl: string, key: string): Promise<void> {
  const response = await fetch(`${objectServerUrl}/${P11P_BUCKET}/${key}`, {
    method: 'DELETE',
    signal: AbortSignal.timeout(10_000),
  });
  assert.ok(response.status === 204 || response.status === 404, `object DELETE ${key} -> ${response.status}`);
}

export async function p11pObjectAbsent(objectServerUrl: string, key: string): Promise<boolean> {
  const response = await fetch(`${objectServerUrl}/${P11P_BUCKET}/${key}`, {
    method: 'HEAD',
    signal: AbortSignal.timeout(10_000),
  });
  return response.status === 404;
}

export { p07Digest, p07KeyFromGrantUrl, type P07IssueResponse };
