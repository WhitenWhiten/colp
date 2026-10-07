/**
 * P4A-RL05 real-Redis adapter contract — NOSCRIPT / ACL / disconnect /
 * restart / TLS shape (plan §4.1.10, §4.2.5, §8 RL05).
 *
 * Everything a fake cannot prove about the RL03 adapter's failure and
 * recovery contract over a REAL Redis:
 *
 *  - NOSCRIPT: SCRIPT FLUSH wipes the server script cache; EVALSHA must
 *    reload the FROZEN production script exactly once and keep working;
 *  - ACL denial (plan §4.1.10): a restricted default user (no @scripting)
 *    classifies as the STABLE `acl` failure with code
 *    `rate_limit_acl_denied` — a failure, NEVER a quota decision; the
 *    assertion goes red if an outage/ACL error were disguised as 429;
 *  - COMMAND fast-fail vs SERVER stop (plan §4.2.5): CLIENT PAUSE (server
 *    alive but stalled) surfaces bounded `timeout` failures, while a fully
 *    stopped server fast-fails as `unavailable` — measured, never a fixed
 *    sleep as the only oracle;
 *  - RESTART with the same data dir: the container runs `--appendonly yes`,
 *    so a graceful `redis-cli shutdown` + restart keeps the dataset (an AOF
 *    sentinel key survives) and the recovery probe continues the SAME
 *    counter; the restart wipes the script cache (memory-only), so recovery
 *    also re-exercises the NOSCRIPT reload path;
 *  - TLS shape: the dedicated container serves BOTH a plaintext port and a
 *    `--tls-port` (self-signed cert generated at runtime with host openssl;
 *    redis:7 official images are compiled with TLS). Real TLS handshake
 *    probes prove the TLS port speaks TLS and refuses plaintext; the
 *    production client (rediss://) honors `rejectUnauthorized` (never
 *    healthy, never decides) and works end-to-end once verification is
 *    disabled for the self-signed TEST cert. If the host cannot generate
 *    certificates (no openssl), the suite throws an ENVIRONMENT failure and
 *    documents the limitation — it never silently skips (plan §4.2.6).
 *
 * Fixture / isolation (plan §4.2.6): one dedicated Testcontainers container
 * (`redis:7-alpine`, override KNOW_REDIS_IMAGE); a failed start/stop/restart
 * is an environment failure that throws. Cleanup force-expires exactly this
 * run's known keys (no FLUSHALL/FLUSHDB). No PostgreSQL dependency.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import tls from 'node:tls';
import { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, describe, test } from 'vitest';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import {
  RATE_LIMIT_LUA_SCRIPT,
  createRedisRateLimitStore,
} from '../../../src/infrastructure/rate-limit/index.js';
import {
  buildAttachmentRateLimitKey,
  type AttachmentRateLimitConfig,
  type AttachmentRateLimitRouteClass,
  type RateLimitStore,
  type RateLimitStoreOutcome,
  type RateLimitSubject,
} from '../../../src/modules/attachments/index.js';
import { waitUntil } from '../../support/redis-runtime-test-helpers.js';
import { waitForRealTime } from '../../support/async-test-helpers.js';

const REDIS_IMAGE = process.env.KNOWN_REDIS_IMAGE?.trim() || 'redis:7-alpine';
const ENVIRONMENT = 'test';
/** The dedicated server command: plaintext + TLS ports, AOF persistence. */
const REDIS_SERVER_ARGS =
  '--port 6379 --tls-port 6380 --appendonly yes '
  + '--tls-cert-file /tmp/rl05.crt --tls-key-file /tmp/rl05.key --tls-auth-clients no';

let container: StartedTestContainer | undefined;
let redisUrl: string | undefined;
let tlsPort: number | undefined;
let raw: Redis | undefined;
let runPrefix: string;
let keySecret: Buffer;
const stores: RateLimitStore[] = [];
const trackedKeys = new Set<string>();

function makeConfig(overrides: Partial<AttachmentRateLimitConfig> = {}): AttachmentRateLimitConfig {
  assert.ok(redisUrl, 'the redis URL must be known before creating a store');
  const base: AttachmentRateLimitConfig = {
    mode: 'enforce',
    required: true,
    redisUrl,
    keySecretRef: 'known/rl05/failure/hmac',
    keyPrefix: runPrefix,
    commandTimeoutMs: 750,
    connectTimeoutMs: 3_000,
    maxRetriesPerRequest: 1,
    routes: Object.freeze({
      issue: Object.freeze({ rateMax: 100, rateWindowMs: 60000 }),
      complete: Object.freeze({ rateMax: 60, rateWindowMs: 60000 }),
      download: Object.freeze({ rateMax: 30, rateWindowMs: 60000 }),
      status: Object.freeze({ rateMax: 60, rateWindowMs: 60000 }),
    }),
    completeEmergency: Object.freeze({ rateMax: 15, rateWindowMs: 60000 }),
  };
  return Object.freeze({ ...base, ...overrides }) as AttachmentRateLimitConfig;
}

function makeStore(
  configOverrides: Partial<AttachmentRateLimitConfig> = {},
  factoryOverrides: { readonly failureThreshold?: number; readonly cooldownMs?: number } = {},
): RateLimitStore {
  const store = createRedisRateLimitStore({
    config: makeConfig(configOverrides),
    environment: ENVIRONMENT,
    keySecret,
    failureThreshold: factoryOverrides.failureThreshold,
    cooldownMs: factoryOverrides.cooldownMs,
  });
  stores.push(store);
  return store;
}

async function makeHealthyStore(
  configOverrides: Partial<AttachmentRateLimitConfig> = {},
  factoryOverrides: { readonly failureThreshold?: number; readonly cooldownMs?: number } = {},
): Promise<RateLimitStore> {
  const store = makeStore(configOverrides, factoryOverrides);
  await waitUntil(() => store.readiness().status === 'healthy', 15_000, 'store connection ready', 25);
  return store;
}

function subject(seed: string = randomUUID()): RateLimitSubject {
  return { principalId: `principal-${seed}`, scope: `collection-${seed}` };
}

function counterKey(
  routeClass: AttachmentRateLimitRouteClass,
  subjectValue: RateLimitSubject,
  windowStartEpochMs: number,
): string {
  return buildAttachmentRateLimitKey({
    keyPrefix: runPrefix,
    environment: ENVIRONMENT,
    keySecret,
    routeClass,
    subject: subjectValue,
    windowStartEpochMs,
  });
}

function track(
  outcome: RateLimitStoreOutcome,
  routeClass: AttachmentRateLimitRouteClass,
  subjectValue: RateLimitSubject,
): RateLimitStoreOutcome {
  if (outcome.kind === 'allowed' || outcome.kind === 'denied') {
    trackedKeys.add(counterKey(routeClass, subjectValue, outcome.decision.windowStartEpochMs));
  }
  return outcome;
}

async function check(
  store: RateLimitStore,
  routeClass: AttachmentRateLimitRouteClass,
  subjectValue: RateLimitSubject,
): Promise<RateLimitStoreOutcome> {
  return track(await store.check({ routeClass, subject: subjectValue }), routeClass, subjectValue);
}

/** Redis SERVER time in epoch ms (the authoritative window clock). */
async function serverTimeMs(): Promise<number> {
  const [seconds, micros] = (await raw!.time()) as [number, number];
  return Number(seconds) * 1000 + Math.floor(Number(micros) / 1000);
}

// ---------------------------------------------------------------------------
// TLS fixtures (self-signed cert generated at runtime; environment failure if
// the host has no openssl — never a silent skip, plan §4.2.6)
// ---------------------------------------------------------------------------

function resolveOpenssl(): string {
  const candidates = [
    'openssl',
    'C:/Program Files/Git/mingw64/bin/openssl.exe',
    'C:/Program Files/Git/usr/bin/openssl.exe',
  ];
  for (const candidate of candidates) {
    try {
      execFileSync(candidate, ['version'], { stdio: 'ignore' });
      return candidate;
    } catch {
      // try the next candidate
    }
  }
  throw new Error(
    'P4A-RL05 TLS shape: no openssl executable found on PATH. The rediss:// shape test needs a ' +
      'self-signed certificate generated at runtime; install openssl (git for Windows ships it) or ' +
      'document the environment limitation — the suite must NOT silently skip TLS coverage.',
  );
}

function generateTlsCert(): { readonly certPem: string; readonly keyPem: string } {
  const dir = mkdtempSync(join(tmpdir(), 'rl05-tls-'));
  try {
    const certPath = join(dir, 'server.crt');
    const keyPath = join(dir, 'server.key');
    execFileSync(resolveOpenssl(), [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', keyPath, '-out', certPath, '-days', '2',
      '-subj', '/CN=localhost',
      '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
    ], { stdio: 'ignore' });
    return {
      certPem: readFileSync(certPath, 'utf8'),
      keyPem: readFileSync(keyPath, 'utf8'),
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`P4A-RL05 TLS shape: could not generate the self-signed certificate with openssl: ${detail}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Real TLS handshake + PING; resolves with the server's first data chunk. */
function tlsPingProbe(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const socket = tls.connect(
      { host: '127.0.0.1', port, rejectUnauthorized: false, servername: 'localhost' },
      () => {
        try { socket.write('*1\r\n$4\r\nPING\r\n'); } catch { /* destroyed below */ }
      },
    );
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(new Error('TLS PING probe timed out'));
    }, 4_000);
    socket.once('data', (chunk) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(chunk.toString('utf8'));
    });
    socket.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
  });
}

/** Plaintext PING over the TLS port: true only if a real +PONG ever arrives. */
function plaintextPingProbe(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    let received = '';
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(received.includes('+PONG'));
    }, 1_500);
    socket.on('data', (chunk) => {
      received += chunk.toString('utf8');
      if (received.includes('+PONG')) {
        clearTimeout(timer);
        socket.destroy();
        resolve(true);
      }
    });
    socket.once('error', () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(received.includes('+PONG'));
    });
    socket.once('connect', () => {
      try { socket.write('*1\r\n$4\r\nPING\r\n'); } catch { /* destroyed below */ }
    });
  });
}

/**
 * Strict TLS verification probe: a handshake with `rejectUnauthorized: true`
 * against the self-signed server must FAIL; resolves with the first error
 * message (deterministic across OpenSSL builds — the exact wording varies,
 * e.g. "unable to verify the first certificate" / "self-signed certificate").
 * A successful handshake rejects the probe (verification was not enforced).
 */
function tlsVerifyProbe(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const socket = tls.connect(
      { host: '127.0.0.1', port, rejectUnauthorized: true, servername: 'localhost' },
      () => {
        if (settled) return;
        settled = true;
        socket.destroy();
        reject(new Error('TLS handshake succeeded with rejectUnauthorized:true (verification not enforced)'));
      },
    );
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(new Error('TLS verification probe timed out'));
    }, 4_000);
    socket.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(error instanceof Error ? error.message : String(error));
    });
  });
}

/** Polls readiness and fails the test if the store EVER becomes healthy. */
async function assertStaysDegraded(store: RateLimitStore, forMs: number): Promise<void> {
  const deadline = Date.now() + forMs;
  while (Date.now() < deadline) {
    assert.equal(
      store.readiness().status,
      'degraded',
      'the rediss client must never reach ready while the self-signed certificate is rejected',
    );
    await waitForRealTime(100, 'sample the Redis TLS readiness state throughout the asserted degraded interval');
  }
}

describe('P4A-RL05 real Redis: NOSCRIPT, ACL, disconnect/restart and TLS shape', () => {
  beforeAll(async () => {
    const { certPem, keyPem } = generateTlsCert();
    let started: StartedTestContainer;
    try {
      started = await new GenericContainer(REDIS_IMAGE)
        .withExposedPorts(6379, 6380)
        .withCopyContentToContainer([
          { content: certPem, target: '/tmp/rl05.crt', mode: 0o600 },
          { content: keyPem, target: '/tmp/rl05.key', mode: 0o600 },
        ])
        // Daemonized redis under a keep-alive shell: the outage test stops
        // and restarts the redis-server PROCESS inside this container.
        .withCommand(['sh', '-c', `redis-server ${REDIS_SERVER_ARGS} --daemonize yes; while true; do sleep 3600; done`])
        .withStartupTimeout(120_000)
        .start();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        `P4A-RL05 fail-closed: could not start the dedicated TLS+AOF Redis container (image ${REDIS_IMAGE}). ` +
          `The real-Redis rate-limit contract suite requires Docker/Testcontainers and never reuses ` +
          `a developer's Redis: ${detail}`,
      );
    }
    container = started;
    redisUrl = `redis://127.0.0.1:${started.getMappedPort(6379)}`;
    tlsPort = started.getMappedPort(6380);
    runPrefix = `rl05-${randomUUID()}`;
    keySecret = Buffer.from(`rl05-run-secret-${randomUUID()}`, 'utf8');
    raw = new Redis(redisUrl);
    await waitUntil(async () => {
      try { await raw?.ping(); return true; } catch { return false; }
    }, 15_000, 'raw redis ping', 50);
  }, 180_000);

  afterEach(async () => {
    delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    if (raw) {
      for (const key of trackedKeys) {
        try { await raw.del(key); } catch (error) {
          console.warn(`[rl05-failure] best-effort exact-key cleanup failed for ${key}: ${String(error)}`);
        }
      }
    }
    trackedKeys.clear();
    const open = stores.splice(0, stores.length);
    await Promise.all(open.map((store) => store.close().catch(() => undefined)));
  }, 30_000);

  afterAll(async () => {
    delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    const errors: unknown[] = [];
    if (raw) { try { await raw.quit(); } catch (error) { errors.push(error); } }
    if (container) { try { await container.stop(); } catch (error) { errors.push(error); } }
    if (errors.length > 0) {
      throw new Error(`P4A-RL05 failure cleanup failed: ${errors.map((error) => String(error)).join(' | ')}`);
    }
  }, 60_000);

  test('SCRIPT FLUSH is recovered by one reload and retry of the exact frozen script', async () => {
    const store = await makeHealthyStore();
    const owner = subject('noscript');
    const first = await check(store, 'issue', owner);
    assert.equal(first.kind, 'allowed');
    if (first.kind !== 'allowed') return;

    await raw!.script('FLUSH');
    const second = await check(store, 'issue', owner);
    assert.equal(second.kind, 'allowed', 'the adapter reloads the script and retries exactly once');
    const third = await check(store, 'issue', owner);
    assert.equal(third.kind, 'allowed', 'the reloaded script keeps working');

    const sha1 = createHash('sha1').update(RATE_LIMIT_LUA_SCRIPT).digest('hex');
    const exists = await raw!.script('EXISTS', sha1);
    assert.deepEqual(exists, [1], 'the exact production script is back in the Redis script cache');
    if (second.kind === 'allowed' && third.kind === 'allowed') {
      const key = counterKey('issue', owner, third.decision.windowStartEpochMs);
      assert.equal(await raw!.get(key), '3', 'all three checks share one counter');
    }
  });

  test('ACL denial classifies as the stable acl failure, never as a quota decision (plan §4.1.10)', async () => {
    const store = await makeHealthyStore();
    const owner = subject('acl');
    const baseline = await check(store, 'issue', owner);
    assert.equal(baseline.kind, 'allowed', 'the store is healthy and has the script cached before the restriction');
    try {
      // Restrict the DEFAULT user (the only user the production store can
      // authenticate as — the RL02 URL contract forbids userinfo, so the ACL
      // denial must be observable through the exact production path).
      await raw!.acl('SETUSER', 'default', '-@scripting');
      const denied = await check(store, 'issue', owner);
      assert.equal(denied.kind, 'failed', 'an ACL-denied admission is a FAILURE, never a decision');
      if (denied.kind === 'failed') {
        assert.equal(denied.failure.class, 'acl', `stable acl failure class, got ${denied.failure.class}`);
        assert.equal(denied.failure.code, 'rate_limit_acl_denied');
      }
    } finally {
      // Restore the DEFAULT user explicitly. `ACL SETUSER default reset` is
      // NOT used: resetting the special default user drops `nopass` and makes
      // the server demand authentication (verified against redis:7-alpine),
      // which would break every later test on the shared container.
      await raw!.acl('SETUSER', 'default', 'on', 'nopass', '~*', '&*', '+@all');
    }
    await waitUntil(async () => (await check(store, 'issue', owner)).kind === 'allowed', 10_000,
      'the store recovers after the ACL reset', 50);
  });

  test('a stalled server surfaces bounded timeout failures while it is alive (command fast-fail)', async () => {
    const store = await makeHealthyStore();
    const owner = subject('pause');
    const baseline = await check(store, 'issue', owner);
    assert.equal(baseline.kind, 'allowed', 'the store is healthy before the pause');

    await raw!.client('PAUSE', 2000, 'ALL');
    const stalled = await check(store, 'issue', owner);
    assert.equal(stalled.kind, 'failed', 'a stalled server is a failure, never a decision (plan §4.1.10)');
    if (stalled.kind === 'failed') {
      assert.equal(stalled.failure.class, 'timeout', `stalled commands classify timeout, got ${stalled.failure.class}`);
      assert.equal(stalled.failure.code, 'rate_limit_command_timeout');
    }
    // The pause auto-expires; recovery is health-polled, never a fixed sleep.
    await waitUntil(async () => (await check(store, 'issue', owner)).kind === 'allowed', 10_000,
      'the server resumes after CLIENT PAUSE expires', 50);
  });

  test('server stop fast-fails as unavailable; a graceful restart with the same AOF data dir recovers and reloads the script', async () => {
    assert.ok(container, 'container fixture must be running');
    assert.ok(raw, 'raw client fixture must exist');
    // A high failure threshold keeps the circuit breaker out of the
    // fast-fail measurement: every check must really reach the client.
    const store = await makeHealthyStore({}, { failureThreshold: 100, cooldownMs: 1_000 });
    const owner = subject('outage');
    const baseline = await check(store, 'issue', owner);
    assert.equal(baseline.kind, 'allowed', 'the store is healthy before the outage');
    if (baseline.kind !== 'allowed') return;
    const window0 = baseline.decision.windowStartEpochMs;
    // AOF survival sentinel: proves the restart reuses the SAME data dir.
    await raw!.set('rl05-aof-sentinel', 'alive');
    // Make sure the outage cannot straddle the 60s server-time boundary:
    // wait until we are >=10s into the current window (server-time polling).
    await waitUntil(async () => (await serverTimeMs()) % 60000 >= 10_000, 70_000,
      'at least 10s into the current server window', 50);

    const shutdown = await container.exec(['redis-cli', 'shutdown']);
    if (shutdown.exitCode !== 0) {
      throw new Error(`redis-cli shutdown failed (exit ${shutdown.exitCode}): ${shutdown.output}`);
    }
    try {
      await waitUntil(async () => (await check(store, 'issue', owner)).kind === 'failed', 10_000,
        'commands fail after the server stops', 50);
      const started = performance.now();
      for (let i = 0; i < 3; i += 1) {
        const outcome = await check(store, 'issue', owner);
        assert.equal(outcome.kind, 'failed', 'outage checks fail; they never decide');
        if (outcome.kind === 'failed') {
          assert.ok(
            outcome.failure.class === 'unavailable' || outcome.failure.class === 'timeout',
            `outage failures classify unavailable|timeout, got ${outcome.failure.class} — never exhausted (plan §4.1.10)`,
          );
        }
      }
      const elapsed = performance.now() - started;
      assert.ok(elapsed < 9_000, `three outage checks were bounded (${elapsed.toFixed(0)}ms)`);
      assert.equal(store.readiness().status, 'degraded', 'readiness degrades during the outage');
    } finally {
      const restore = await container.exec(['redis-server', ...REDIS_SERVER_ARGS.split(' '), '--daemonize', 'yes']);
      if (restore.exitCode !== 0) {
        throw new Error(`redis-server restart failed (exit ${restore.exitCode}): ${restore.output}`);
      }
    }

    // Recovery: probe through the client until a check succeeds and readiness
    // recovers (health barrier — no fixed short sleep, plan §4.2.5).
    let recoveredWindow = 0;
    await waitUntil(async () => {
      const outcome = await check(store, 'issue', owner);
      if (outcome.kind !== 'allowed') return false;
      recoveredWindow = outcome.decision.windowStartEpochMs;
      return store.readiness().status === 'healthy';
    }, 30_000, 'a probe check succeeds after restart and readiness recovers', 100);

    // The AOF dataset survived the graceful shutdown: the sentinel key is
    // still there and the recovery INCR continued the SAME counter.
    await waitUntil(async () => (await raw!.get('rl05-aof-sentinel')) === 'alive', 10_000,
      'the AOF sentinel survives the restart', 100);
    assert.ok(
      recoveredWindow === window0 || recoveredWindow === window0 + 60000,
      `recovery lands on the same or the next server-time window (window0=${window0}, recovered=${recoveredWindow})`,
    );
    if (recoveredWindow === window0) {
      const continued = Number((await raw!.get(counterKey('issue', owner, window0))) ?? '0');
      assert.ok(
        continued >= 2,
        `the recovery probe continued the surviving counter (value ${continued}) — an empty-data restart would reset it to 1`,
      );
    } else {
      assert.equal(await raw!.get(counterKey('issue', owner, recoveredWindow)), '1',
        'a boundary-crossing recovery starts a fresh counter in the next window');
    }
    // The restart wiped the memory-only script cache; the recovered probe
    // must have reloaded the frozen production script (NOSCRIPT path).
    const sha1 = createHash('sha1').update(RATE_LIMIT_LUA_SCRIPT).digest('hex');
    const exists = await raw!.script('EXISTS', sha1);
    assert.deepEqual(exists, [1], 'the restart wiped the script cache; the recovered probe reloaded the frozen script');
  }, 90_000);

  test('rediss:// TLS shape: the TLS port really speaks TLS, plaintext is refused, and the production client honors rejectUnauthorized', async () => {
    assert.ok(tlsPort !== undefined, 'the TLS port must be mapped');
    // 1. A real TLS handshake + PING succeeds on the TLS port.
    const pong = await tlsPingProbe(tlsPort);
    assert.ok(pong.includes('+PONG'), `TLS PING answered over a real handshake (${JSON.stringify(pong.slice(0, 40))})`);
    // 2. Plaintext PING over the TLS port must never be answered with +PONG.
    assert.equal(await plaintextPingProbe(tlsPort), false, 'the TLS port never serves plaintext');

    // 3. The TLS layer itself refuses the self-signed certificate: a strict
    //    (rejectUnauthorized) handshake must fail with a certificate error —
    //    deterministic across OpenSSL builds, independent of client plumbing.
    const verifyError = await tlsVerifyProbe(tlsPort);
    assert.ok(
      /certificate|cert|self[- ]?signed|SSL|handshake|EPROTO/iu.test(verifyError),
      `strict TLS verification rejects the self-signed cert (${JSON.stringify(verifyError.slice(0, 80))})`,
    );

    // 3b. The production rediss:// client also refuses the endpoint: its
    //    connect promise rejects. The exact message varies by ioredis/OpenSSL
    //    build (here "Connection is closed."), so the assertion is
    //    message-agnostic: steps 1/5 already prove the port itself speaks
    //    TLS, therefore a rediss connect failure can only be certificate
    //    rejection (and step 4 pins the fail-closed behavior of the store).
    const rawProbe = new Redis(`rediss://127.0.0.1:${tlsPort}`, { lazyConnect: true });
    rawProbe.on('error', () => undefined);
    await assert.rejects(rawProbe.connect(), 'the rediss connect promise must reject during TLS verification');
    rawProbe.disconnect();

    // 4. The PRODUCTION client with default verification never reaches ready
    //    and its checks fail — they never decide (never allowed/denied). The
    //    exact class depends on where the command met the failed handshake
    //    (offline-queue-off rejects pre-connection as unavailable; a command
    //    already written mid-handshake surfaces the TLS error, which the
    //    stable classifier maps to unavailable|timeout|internal — all are
    //    infrastructure failures, never `exhausted`).
    const rejecting = makeStore({ redisUrl: `rediss://127.0.0.1:${tlsPort}` });
    await assertStaysDegraded(rejecting, 3_000);
    const rejectedOutcome = await check(rejecting, 'issue', subject('tls-reject'));
    assert.equal(rejectedOutcome.kind, 'failed', 'an untrusted rediss endpoint is a failure, never a decision');
    if (rejectedOutcome.kind === 'failed') {
      assert.ok(
        rejectedOutcome.failure.class === 'unavailable'
          || rejectedOutcome.failure.class === 'timeout'
          || rejectedOutcome.failure.class === 'internal',
        `TLS handshake failure class, got ${rejectedOutcome.failure.class} — never exhausted`,
      );
    }
    await rejecting.close();

    // 5. TEST-ONLY: with verification disabled (self-signed test cert), the
    //    same rediss:// URL works end to end through the production client
    //    (the counter is really written on the TLS port).
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    try {
      const tlsStore = await makeHealthyStore({ redisUrl: `rediss://127.0.0.1:${tlsPort}` });
      const owner = subject('tls-ok');
      const outcome = await check(tlsStore, 'issue', owner);
      assert.equal(outcome.kind, 'allowed', 'the rediss store admits through a real TLS handshake');
      if (outcome.kind === 'allowed') {
        const key = counterKey('issue', owner, outcome.decision.windowStartEpochMs);
        assert.equal(await raw!.get(key), '1', 'the TLS check wrote the real counter key');
      }
    } finally {
      delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    }
  }, 60_000);
});
