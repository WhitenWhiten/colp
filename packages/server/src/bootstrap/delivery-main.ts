/**
 * P4A-V4A-04 isolated delivery process executable (`npm run start:delivery`).
 *
 * This is the PRODUCTION entrypoint for the session-free, R2-RO, DB-read-only
 * isolated delivery origin. Unlike the API/Worker processes it loads ONLY the
 * attachments delivery surface:
 *
 *  - configuration: `parseAttachmentsFeatureConfig` (the attachments section
 *    only — no OIDC/session/cursor/worker configuration is ever loaded) plus
 *    `parseAttachmentRateLimitConfig` for the FIX-L-049 shared limiter
 *    wiring (mode=off keeps the always-on in-process limiter);
 *  - secrets: the R2 RO credential (`r2.roSecretRef`) and the delivery
 *    capability HMAC secret (`deliveryCapabilitySecretRef`) are resolved from
 *    environment values named by the ref suffix; the R2 RW secret ref is
 *    structurally REFUSED by the resolver, so this process can never hold a
 *    write credential. In shadow/enforce rate-limit mode the FIX-L-049
 *    shared-limiter HMAC key secret is resolved the same way (ref-named env,
 *    never logged);
 *  - database: a dedicated pg Pool over `ATTACHMENTS_DELIVERY_DATABASE_URL`
 *    (a dedicated READ-ONLY delivery role; the variable is required and never
 *    falls back to `DATABASE_URL`), used ONLY by the version-fenced
 *    generation resolver (`createPostgresDeliveryGenerationResolver`);
 *  - request limiting: the isolated host ALWAYS limits actual GET/HEAD with
 *    the bounded in-memory adapter (trusted-IP + token-digest buckets,
 *    FIX-L-049); `ATTACHMENTS_RATE_LIMIT_MODE=shadow|enforce` additionally
 *    composes the SHARED Redis adapter so multi-replica deployments share
 *    one quota (per-IP and per-token budgets come from
 *    `ATTACHMENTS_DELIVERY_RATE_LIMIT_*`);
 *  - transport: `composeProductionDeliveryHost` bound to the independent
 *    `ATTACHMENTS_DELIVERY_HOST`/`ATTACHMENTS_DELIVERY_PORT` with a fixed
 *    readiness probe (`ATTACHMENTS_DELIVERY_READINESS_PATH`, default
 *    `/-/ready`) that never exposes capability material.
 *
 * Startup fails closed: any missing/invalid secret, DSN or configuration exits
 * non-zero BEFORE listening. After a successful bind the process prints one
 * low-sensitivity discovery line to stdout — `delivery_listening <bound
 * origin>` (host/port only; never secrets, capabilities or object keys).
 *
 * Shutdown: SIGTERM/SIGINT start a bounded graceful drain (close the HTTP
 * server, then the RO R2 store, then the shared rate-limit client when one
 * was composed, then the pg pool); a second signal or an exhausted drain
 * budget forces exit(1). Exit codes are observable: 0 after a clean bounded
 * drain, 1 on any startup/shutdown failure or forced exit.
 */
import { Pool } from 'pg';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import {
  parseAttachmentsFeatureConfig,
  parseAttachmentRateLimitConfig,
  type AttachmentRateLimitConfig,
  type AttachmentsFeatureConfig,
  type AttachmentRateLimitRouteConfig,
  type DeliveryRequestLimiter,
} from '../modules/attachments/index.js';
import {
  assertValidDeliveryReadinessPath,
  composeProductionDeliveryHost,
  type DeliveryHost,
  type DeliverySecretResolver,
  type DeliverySecretValue,
} from './delivery.js';
import { createPostgresDeliveryGenerationResolver } from './attachments-delivery-composition.js';
import { loadDatabasePoolConfig } from './config-cache.js';
import type { DatabasePoolConfig } from './config-types.js';
import { createDatabasePoolConfig } from '../infrastructure/database/index.js';
import { createLogger } from '../infrastructure/telemetry/index.js';
import { registerFatalProcessHandlers, reportFatalProcessError } from './process-lifecycle.js';
import {
  DELIVERY_REQUEST_LIMIT_MAX_REQUESTS_CEILING,
  DELIVERY_REQUEST_LIMIT_WINDOW_MAX_MS,
} from '../modules/attachments/index.js';
import {
  createRedisDeliveryRequestLimiter,
} from '../infrastructure/rate-limit/index.js';
import type { R2Credential } from '../infrastructure/object-storage/index.js';
import { redactSensitiveText } from '../infrastructure/telemetry/index.js';
import { parseTrustedIngress } from './trusted-ingress.js';

// ---- configuration ---------------------------------------------------------

export const DELIVERY_READINESS_PATH_DEFAULT = '/-/ready';
export const DELIVERY_SHUTDOWN_TIMEOUT_DEFAULT_MS = 10_000;
export const DELIVERY_SHUTDOWN_TIMEOUT_MIN_MS = 1_000;
export const DELIVERY_SHUTDOWN_TIMEOUT_MAX_MS = 60_000;

export const DELIVERY_RATE_LIMIT_IP_MAX_DEFAULT = 600;
export const DELIVERY_RATE_LIMIT_IP_WINDOW_MS_DEFAULT = 60_000;
export const DELIVERY_RATE_LIMIT_TOKEN_MAX_DEFAULT = 120;
export const DELIVERY_RATE_LIMIT_TOKEN_WINDOW_MS_DEFAULT = 60_000;

export interface DeliveryRuntimeResources {
  readonly host?: { close(): Promise<void> };
  readonly requestLimiter?: { close(): Promise<void> };
  readonly pool: { end(): Promise<void> };
}

interface DeliveryCloseFailure {
  readonly resource: string;
  readonly error: unknown;
}

async function attemptDeliveryClose(
  failures: DeliveryCloseFailure[],
  resource: string,
  close: () => Promise<void>,
): Promise<void> {
  try {
    await close();
  } catch (error: unknown) {
    failures.push({ resource, error });
  }
}

/** Closes every delivery-owned resource in dependency order, then reports all failures. */
export async function closeDeliveryRuntimeResources(input: DeliveryRuntimeResources): Promise<void> {
  const failures: DeliveryCloseFailure[] = [];
  if (input.host !== undefined) {
    const host = input.host;
    await attemptDeliveryClose(failures, 'host', () => host.close());
  }
  if (input.requestLimiter !== undefined) {
    const requestLimiter = input.requestLimiter;
    await attemptDeliveryClose(failures, 'requestLimiter', () => requestLimiter.close());
  }
  await attemptDeliveryClose(failures, 'pool', () => input.pool.end());
  if (failures.length > 0) {
    throw new AggregateError(
      failures.map(({ error }) => error),
      `Delivery runtime close failed: ${failures.map(({ resource }) => resource).join(', ')}`,
    );
  }
}

export interface DeliveryProcessConfig {
  readonly nodeEnv: string;
  readonly attachments: AttachmentsFeatureConfig;
  /** Dedicated read-only delivery DSN (`ATTACHMENTS_DELIVERY_DATABASE_URL`). */
  readonly databaseUrl: string;
  /** Standard `DATABASE_POOL_MAX` / `DATABASE_*_TIMEOUT_MS` pool settings. */
  readonly database: DatabasePoolConfig;
  readonly host: string;
  readonly port: number;
  /** Exact IP/CIDR allowlist for the CDN/LB socket peers; empty = peer-only. */
  readonly trustedIngress: readonly string[];
  /** Distinguishes an explicit peer-only declaration from a missing setting. */
  readonly trustedIngressDeclared: boolean;
  readonly shutdownTimeoutMs: number;
  readonly readinessPath: string;
  /**
   * FIX-L-049 shared limiter connection config (mode=off keeps the always-on
   * in-process limiter; shadow/enforce compose the shared Redis adapter).
   */
  readonly rateLimit: AttachmentRateLimitConfig;
  /** Trusted-IP flood budget for delivery GET/HEAD (FIX-L-049). */
  readonly deliveryIpRateLimit: AttachmentRateLimitRouteConfig;
  /** Per-token replay budget for delivery GET/HEAD (FIX-L-049). */
  readonly deliveryTokenRateLimit: AttachmentRateLimitRouteConfig;
}

function parseDeliveryRateLimitBudget(
  env: NodeJS.ProcessEnv,
  maxKey: string,
  maxFallback: number,
  windowKey: string,
  windowFallback: number,
): AttachmentRateLimitRouteConfig {
  const maxRaw = env[maxKey]?.trim();
  const maxRequests = maxRaw === undefined || maxRaw === '' ? maxFallback : Number(maxRaw);
  if (!Number.isSafeInteger(maxRequests) || maxRequests < 1 || maxRequests > DELIVERY_REQUEST_LIMIT_MAX_REQUESTS_CEILING) {
    throw new Error(`${maxKey} must be a safe integer between 1 and ${DELIVERY_REQUEST_LIMIT_MAX_REQUESTS_CEILING}`);
  }
  const windowRaw = env[windowKey]?.trim();
  const windowMs = windowRaw === undefined || windowRaw === '' ? windowFallback : Number(windowRaw);
  if (!Number.isSafeInteger(windowMs) || windowMs < 1 || windowMs > DELIVERY_REQUEST_LIMIT_WINDOW_MAX_MS) {
    throw new Error(`${windowKey} must be a safe integer between 1 and ${DELIVERY_REQUEST_LIMIT_WINDOW_MAX_MS}`);
  }
  return Object.freeze({ rateMax: maxRequests, rateWindowMs: windowMs });
}

/**
 * Loads ONLY the delivery process configuration. `ATTACHMENTS_DELIVERY_DATABASE_URL`
 * is required in every environment (production fails closed; there is no
 * fallback to the application `DATABASE_URL`, so the delivery process can
 * never silently hold the general application role).
 */
export function loadDeliveryProcessConfig(env: NodeJS.ProcessEnv = process.env): DeliveryProcessConfig {
  const nodeEnv = (env.NODE_ENV ?? 'development').trim() || 'development';
  const appOrigin = env.PRODUCT_ORIGIN?.trim() || 'http://127.0.0.1:3000';
  let appOriginUrl: URL;
  try {
    appOriginUrl = new URL(appOrigin);
    if (appOriginUrl.origin !== appOrigin) throw new Error('not an exact origin');
  } catch {
    throw new Error('PRODUCT_ORIGIN must be a valid absolute origin URL');
  }
  const attachments = parseAttachmentsFeatureConfig(env, { nodeEnv, appOrigin: appOriginUrl.origin });
  if (attachments === undefined) {
    throw new Error('ATTACHMENTS_ENABLED must be true to start the isolated delivery process');
  }
  const databaseUrl = env.ATTACHMENTS_DELIVERY_DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new Error(
      'ATTACHMENTS_DELIVERY_DATABASE_URL is required for the isolated delivery process '
      + '(dedicated read-only delivery DSN; never reuse the application DATABASE_URL role)',
    );
  }
  const host = env.ATTACHMENTS_DELIVERY_HOST?.trim() || '0.0.0.0';
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9.:_-]{0,252})$/u.test(host)) {
    throw new Error('ATTACHMENTS_DELIVERY_HOST must be a hostname or IP literal');
  }
  const portRaw = env.ATTACHMENTS_DELIVERY_PORT?.trim();
  const port = portRaw === undefined || portRaw === '' ? 0 : Number(portRaw);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw new Error('ATTACHMENTS_DELIVERY_PORT must be an integer between 0 and 65535');
  }
  if (nodeEnv === 'production' && port === 0) {
    throw new Error('ATTACHMENTS_DELIVERY_PORT must be set to a fixed port in production (0 is only for ephemeral binds)');
  }
  let trustedIngress: ReturnType<typeof parseTrustedIngress>;
  try {
    trustedIngress = parseTrustedIngress(env.ATTACHMENTS_DELIVERY_TRUSTED_INGRESS);
  } catch (error) {
    throw new Error(
      'ATTACHMENTS_DELIVERY_TRUSTED_INGRESS must be a comma-separated list of valid IP addresses or CIDRs',
      { cause: error },
    );
  }
  if (nodeEnv === 'production' && !trustedIngress.declared) {
    throw new Error(
      'ATTACHMENTS_DELIVERY_TRUSTED_INGRESS must be explicitly declared in production '
      + '(CIDR/address allowlist for CDN/LB peers; empty means direct peer-only)',
    );
  }
  const shutdownTimeoutRaw = env.ATTACHMENTS_DELIVERY_SHUTDOWN_TIMEOUT_MS?.trim();
  const shutdownTimeoutMs = shutdownTimeoutRaw === undefined || shutdownTimeoutRaw === ''
    ? DELIVERY_SHUTDOWN_TIMEOUT_DEFAULT_MS
    : Number(shutdownTimeoutRaw);
  if (!Number.isSafeInteger(shutdownTimeoutMs)
    || shutdownTimeoutMs < DELIVERY_SHUTDOWN_TIMEOUT_MIN_MS
    || shutdownTimeoutMs > DELIVERY_SHUTDOWN_TIMEOUT_MAX_MS) {
    throw new Error(
      `ATTACHMENTS_DELIVERY_SHUTDOWN_TIMEOUT_MS must be an integer between `
      + `${DELIVERY_SHUTDOWN_TIMEOUT_MIN_MS} and ${DELIVERY_SHUTDOWN_TIMEOUT_MAX_MS}`,
    );
  }
  const readinessPath = env.ATTACHMENTS_DELIVERY_READINESS_PATH?.trim() || DELIVERY_READINESS_PATH_DEFAULT;
  assertValidDeliveryReadinessPath(readinessPath);
  const rateLimit = parseAttachmentRateLimitConfig(env);
  const deliveryIpRateLimit = parseDeliveryRateLimitBudget(
    env,
    'ATTACHMENTS_DELIVERY_RATE_LIMIT_IP_MAX', DELIVERY_RATE_LIMIT_IP_MAX_DEFAULT,
    'ATTACHMENTS_DELIVERY_RATE_LIMIT_IP_WINDOW_MS', DELIVERY_RATE_LIMIT_IP_WINDOW_MS_DEFAULT,
  );
  const deliveryTokenRateLimit = parseDeliveryRateLimitBudget(
    env,
    'ATTACHMENTS_DELIVERY_RATE_LIMIT_TOKEN_MAX', DELIVERY_RATE_LIMIT_TOKEN_MAX_DEFAULT,
    'ATTACHMENTS_DELIVERY_RATE_LIMIT_TOKEN_WINDOW_MS', DELIVERY_RATE_LIMIT_TOKEN_WINDOW_MS_DEFAULT,
  );
  return Object.freeze({
    nodeEnv,
    attachments,
    databaseUrl,
    database: loadDatabasePoolConfig(env),
    host,
    port,
    trustedIngress: trustedIngress.entries,
    trustedIngressDeclared: trustedIngress.declared,
    shutdownTimeoutMs,
    readinessPath,
    rateLimit,
    deliveryIpRateLimit,
    deliveryTokenRateLimit,
  });
}

// ---- secret resolution (env values named by the ref suffix; never logged) ---

function secretRefSuffix(ref: string): string {
  return ref.split('/').filter(Boolean).pop()
    ?.replace(/[^A-Za-z0-9]/g, '_').toUpperCase() ?? '';
}

/**
 * Delivery-only secret resolver: the R2 RO ref resolves to the env credential
 * pair `ATTACHMENTS_R2_<REF_SUFFIX>_ACCESS_KEY_ID` /
 * `ATTACHMENTS_R2_<REF_SUFFIX>_SECRET_ACCESS_KEY`; the capability ref resolves
 * to `ATTACHMENTS_DELIVERY_CAPABILITY_<REF_SUFFIX>`. The R2 RW ref and any
 * unknown ref are REFUSED, so the delivery process structurally never holds
 * the R2 RW secret. Values are only ever read from the environment.
 */
export function createDeliverySecretResolver(config: AttachmentsFeatureConfig): DeliverySecretResolver {
  return async (ref: string): Promise<DeliverySecretValue> => {
    if (ref === config.r2.rwSecretRef) {
      throw new Error(
        'delivery composition refused: the R2 RW secret reference must never be resolved by the isolated delivery process',
      );
    }
    if (ref === config.r2.roSecretRef) {
      const suffix = secretRefSuffix(ref);
      if (suffix.length === 0) throw new Error(`delivery composition refused: invalid R2 RO secret ref ${ref}`);
      const accessKeyId = process.env[`ATTACHMENTS_R2_${suffix}_ACCESS_KEY_ID`]?.trim();
      const secretAccessKey = process.env[`ATTACHMENTS_R2_${suffix}_SECRET_ACCESS_KEY`]?.trim();
      if (!accessKeyId || !secretAccessKey) {
        throw new Error(
          `delivery composition refused: ATTACHMENTS_R2_${suffix}_ACCESS_KEY_ID / `
          + `ATTACHMENTS_R2_${suffix}_SECRET_ACCESS_KEY are required to resolve ${ref}`,
        );
      }
      return { accessKeyId, secretAccessKey } satisfies R2Credential;
    }
    if (ref === config.deliveryCapabilitySecretRef) {
      const suffix = secretRefSuffix(ref);
      if (suffix.length === 0) {
        throw new Error(`delivery composition refused: invalid delivery capability secret ref ${ref}`);
      }
      const value = process.env[`ATTACHMENTS_DELIVERY_CAPABILITY_${suffix}`]?.trim();
      if (!value) {
        throw new Error(
          `delivery composition refused: ATTACHMENTS_DELIVERY_CAPABILITY_${suffix} is required to resolve ${ref}`,
        );
      }
      return value;
    }
    throw new Error(`delivery composition refused: unknown secret ref ${ref}`);
  };
}

/**
 * Resolves the FIX-L-049 shared-limiter HMAC key secret VALUE by its opaque
 * reference (same env convention as the API rate-limit resolver): ref
 * `known/prod/delivery/ratelimit/hmac` reads
 * `ATTACHMENTS_RATE_LIMIT_KEY_SECRET_DELIVERY_RATELIMIT_HMAC`. Only called in
 * shadow/enforce mode; the value is never logged or serialized.
 */
export async function resolveDeliveryRateLimitKeySecret(ref: string): Promise<Buffer> {
  const suffix = secretRefSuffix(ref);
  if (suffix.length === 0) {
    throw new Error(`delivery composition refused: invalid rate-limit key secret ref ${ref}`);
  }
  const value = process.env[`ATTACHMENTS_RATE_LIMIT_KEY_SECRET_${suffix}`]?.trim();
  if (!value) {
    throw new Error(
      `delivery composition refused: ATTACHMENTS_RATE_LIMIT_KEY_SECRET_${suffix} is required to resolve ${ref}`,
    );
  }
  return Buffer.from(value, 'utf8');
}

// ---- database probe --------------------------------------------------------

/**
 * Startup fail-closed probe: the dedicated delivery DSN must be reachable AND
 * expose the attachments ledger tables the generation resolver reads. A wrong
 * database, a missing schema or a broken credential exits non-zero before the
 * host ever listens.
 */
async function probeDeliveryDatabase(pool: Pool): Promise<void> {
  const result = await pool.query<{ ok: boolean }>(
    `select to_regclass('blob_records') is not null
        and to_regclass('blob_generations') is not null as ok`,
  );
  if (result.rows[0]?.ok !== true) {
    throw new Error(
      'delivery database is missing the attachments ledger tables '
      + '(blob_records/blob_generations); ATTACHMENTS_DELIVERY_DATABASE_URL must point at the migrated attachment schema',
    );
  }
}

// ---- lifecycle ---------------------------------------------------------------

/**
 * Runs the isolated delivery process until a termination signal arrives.
 *
 * - startup: DB probe -> secret resolution -> RO host composition -> listen;
 *   any failure exits non-zero without listening;
 * - shutdown: SIGTERM/SIGINT drain the HTTP server, then the RO R2 store and
 *   the shared rate-limit client (when composed), then the pg pool within
 *   `shutdownTimeoutMs`; a repeated signal or an exhausted budget forces
 *   exit(1); a clean drain exits 0 (exit codes are observable);
 * - a signal arriving DURING startup still drains whatever exists and exits.
 */
export async function startDeliveryMain(): Promise<void> {
  const config = loadDeliveryProcessConfig(process.env);
  const pool = new Pool(createDatabasePoolConfig(config.databaseUrl, {
    applicationName: 'known-delivery',
    production: config.nodeEnv === 'production',
    maxConnections: config.database.maxConnections,
    connectionTimeoutMs: config.database.connectionTimeoutMs,
    idleTimeoutMs: config.database.idleTimeoutMs,
    statementTimeoutMs: config.database.statementTimeoutMs,
    lockTimeoutMs: config.database.lockTimeoutMs,
    idleTransactionTimeoutMs: config.database.idleTransactionTimeoutMs,
  }));
  let host: DeliveryHost | undefined;
  let requestLimiter: DeliveryRequestLimiter | undefined;
  let startPromise: Promise<void> | undefined;
  let stopRequested = false;
  let forceExit = false;
  let resolveShutdownGate: () => void = () => undefined;
  const shutdownGate = new Promise<void>((resolvePromise) => {
    resolveShutdownGate = resolvePromise;
  });

  const shutdown = async (): Promise<void> => {
    if (forceExit) {
      process.stderr.write('delivery: forced exit on repeated signal\n');
      process.exit(1);
    }
    if (stopRequested) return;
    stopRequested = true;
    const timer = setTimeout(() => {
      process.stderr.write(
        `delivery: graceful shutdown exceeded ${config.shutdownTimeoutMs}ms; forcing exit\n`,
      );
      process.exit(1);
    }, config.shutdownTimeoutMs);
    try {
      // Serialize shutdown with startup: never close the pool under a pending
      // startup probe/composition (which would surface as a misleading
      // "start failed" after an otherwise clean stop).
      let startupFailure: { readonly error: unknown } | undefined;
      try {
        await startPromise;
      } catch (error: unknown) {
        startupFailure = { error };
      }
      let closeFailure: { readonly error: unknown } | undefined;
      try {
        await closeDeliveryRuntimeResources({ host, requestLimiter, pool });
      } catch (error: unknown) {
        closeFailure = { error };
      }
      if (startupFailure !== undefined && closeFailure !== undefined) {
        throw new AggregateError(
          [startupFailure.error, closeFailure.error],
          'Delivery startup failed and runtime cleanup also failed',
        );
      }
      if (startupFailure !== undefined) throw startupFailure.error;
      if (closeFailure !== undefined) throw closeFailure.error;
      clearTimeout(timer);
      process.exit(0);
    } catch (error) {
      clearTimeout(timer);
      process.stderr.write(`delivery: graceful shutdown failed: ${redactSensitiveText(error)}\n`);
      process.exit(1);
    }
  };
  const onSignal = (): void => {
    if (stopRequested) forceExit = true;
    resolveShutdownGate();
    void shutdown();
  };
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);

  startPromise = (async () => {
    await probeDeliveryDatabase(pool);
    if (config.rateLimit.mode !== 'off') {
      // FIX-L-049 shared multi-replica limiter: shadow/enforce modes compose
      // the Redis adapter over the SAME attachment rate-limit connection
      // config (the delivery budgets come from the dedicated env vars); the
      // key secret is resolved by its opaque ref and never logged. mode=off
      // keeps the always-on bounded in-memory limiter (per-process).
      const keySecret = await resolveDeliveryRateLimitKeySecret(config.rateLimit.keySecretRef!);
      requestLimiter = createRedisDeliveryRequestLimiter({
        redisUrl: config.rateLimit.redisUrl!,
        environment: config.nodeEnv,
        keySecret,
        keyPrefix: config.rateLimit.keyPrefix,
        // The process config shape (rateMax/rateWindowMs) maps onto the
        // limiter port budget shape (maxRequests/windowMs) here; both are
        // fail-closed validated by their own parsers.
        ip: { maxRequests: config.deliveryIpRateLimit.rateMax, windowMs: config.deliveryIpRateLimit.rateWindowMs },
        token: { maxRequests: config.deliveryTokenRateLimit.rateMax, windowMs: config.deliveryTokenRateLimit.rateWindowMs },
        commandTimeoutMs: config.rateLimit.commandTimeoutMs,
        connectTimeoutMs: config.rateLimit.connectTimeoutMs,
        maxRetriesPerRequest: config.rateLimit.maxRetriesPerRequest,
      });
    }
    host = await composeProductionDeliveryHost({
      config: config.attachments,
      resolveGeneration: createPostgresDeliveryGenerationResolver(pool),
      resolveSecret: createDeliverySecretResolver(config.attachments),
      hostname: config.host,
      port: config.port,
      trustedIngress: config.trustedIngress,
      readinessPath: config.readinessPath,
      ...(requestLimiter === undefined ? {} : { requestLimiter }),
    });
    await host.start();
    // Low-sensitivity discovery fact only (host/port): never secrets,
    // capabilities, capabilities URLs or object keys.
    process.stdout.write(`delivery_listening ${host.boundOrigin}\n`);
  })();

  try {
    await startPromise;
  } catch (error) {
    process.off('SIGTERM', onSignal);
    process.off('SIGINT', onSignal);
    if (!stopRequested) {
      try {
        await closeDeliveryRuntimeResources({ host, requestLimiter, pool });
      } catch (cleanupError: unknown) {
        throw new AggregateError(
          [error, cleanupError],
          'Delivery startup failed and runtime cleanup also failed',
        );
      }
    }
    throw error;
  }
  await shutdownGate;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const processLogger = createLogger(process.env.LOG_LEVEL?.trim() || 'info');
  registerFatalProcessHandlers({ logger: processLogger });
  startDeliveryMain().catch((error: unknown) => {
    reportFatalProcessError(processLogger, 'startup_failure', error);
    process.exitCode = 1;
  });
}
