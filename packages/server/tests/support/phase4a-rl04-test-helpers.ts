/**
 * P4A-RL04 shared helpers for the focused suites (not a vitest test file).
 *
 * Provides:
 *  - `rl04CountingClientFactory`: a production `createClient` seam wrapping
 *    the REAL ioredis client and counting `script LOAD` / `EVALSHA` commands
 *    — the anti-false-negative proof surface for "anonymous/schema rejections
 *    never touch Redis" and the anti-false-positive proof surface for "one
 *    shared client across all routes";
 *  - `buildRl04App`: the PRODUCTION app composition (`buildP03App`) plus the
 *    PRODUCTION rate-limit composition (`composeAttachmentRateLimit`) wired
 *    into the route deps as the RL04 facade, with the download use case on
 *    the permissive limiter (the facade owns the local reference attempt),
 *    a counting download port, the fixed-class log sink and the metrics
 *    bridge — exactly the RL04 API wiring shape the focused suites consume.
 *
 * The suites never read `.known-local/phase4a-r2.env`; the object server is
 * the local HTTP transport and Redis/PostgreSQL are the dedicated
 * Testcontainers/external runtimes of the focused configs.
 */
import { Redis } from 'ioredis';
import type { RedisOptions } from 'ioredis';
import {
  composeAttachmentRateLimit,
  type AttachmentRateLimitComposition,
} from '../../src/bootstrap/attachments-rate-limit-composition.js';
import {
  authorizeOwnerDownload,
  createHmacOwnerDeliveryCapabilitySigner,
  createPermissiveDeliveryRateLimiter,
  type AttachmentsFeatureConfig,
  type AttachmentRateLimitConfig,
  type AttachmentRateLimitLogEntry,
  type AttachmentRouteRateLimitFacade,
  type AuthorizeOwnerDownloadInput,
  type DeliveryRateLimiter,
} from '../../src/modules/attachments/index.js';
import type {
  RateLimitRedisClientFactory,
  RateLimitRedisClientLike,
  RateLimitRedisClientOptions,
} from '../../src/infrastructure/rate-limit/index.js';
import { InMemoryMetrics } from '../../src/infrastructure/telemetry/index.js';
import { createPostgresAccessPolicyFactsPort } from '../../src/infrastructure/access-policy/index.js';
import { createPostgresAttachmentsPorts, createUnitOfWork } from '../../src/infrastructure/database/index.js';
import { P08_DELIVERY_SECRET } from './phase4a-p08-test-helpers.js';
import { buildP03App, type P03AppBundle } from './phase4a-p03-test-helpers.js';
import type { IdentityUnitOfWork } from '../../src/modules/identity/index.js';
import type { BrowserSessionAuthority } from '../../src/modules/auth/index.js';
import type { I07MigrationRuntime } from './phase4a-i07-test-helpers.js';

export const RL04_ENVIRONMENT = 'test';

export interface Rl04ClientCounts {
  readonly scriptLoads: number;
  readonly evalshaCalls: number;
}

/** Counting wrapper over the REAL ioredis client (production command surface). */
class Rl04CountingClient implements RateLimitRedisClientLike {
  get status(): string {
    return this.inner.status;
  }

  constructor(
    private readonly inner: RateLimitRedisClientLike,
    private readonly counts: { scriptLoads: number; evalshaCalls: number },
  ) {}

  connect(): Promise<void> { return this.inner.connect(); }
  disconnect(): void { this.inner.disconnect(); }
  quit(): Promise<'OK'> { return this.inner.quit(); }
  removeAllListeners(): this { this.inner.removeAllListeners(); return this; }
  on(event: string, listener: (...args: unknown[]) => void): this {
    this.inner.on(event, listener);
    return this;
  }
  script(subcommand: 'LOAD', script: string): Promise<string> {
    this.counts.scriptLoads += 1;
    return this.inner.script(subcommand, script);
  }
  evalsha(sha1: string, numkeys: number, ...args: (string | number)[]): Promise<unknown> {
    this.counts.evalshaCalls += 1;
    return this.inner.evalsha(sha1, numkeys, ...args);
  }
}

/**
 * Production `createClient` seam: builds the REAL ioredis client from the
 * store URL and counts the admission commands. `mode=off` compositions must
 * never invoke the factory (the RL04 suites assert the count stays 0).
 */
export function rl04CountingClientFactory(): {
  readonly factory: RateLimitRedisClientFactory;
  readonly counts: Rl04ClientCounts;
} {
  const counts: Rl04ClientCounts = { scriptLoads: 0, evalshaCalls: 0 };
  const factory: RateLimitRedisClientFactory = (url, options: RateLimitRedisClientOptions) => {
    const raw = new Redis(url, options as unknown as RedisOptions);
    // ioredis overloads never structurally satisfy the narrow
    // RateLimitRedisClientLike command surface; the cast is confined to this
    // one ioredis boundary (the same narrowing the production
    // defaultCreateClient uses).
    return new Rl04CountingClient(raw as unknown as RateLimitRedisClientLike, counts);
  };
  return { factory, counts };
}

export interface Rl04AppBundle {
  readonly bundle: P03AppBundle;
  /** The production rate-limit composition (facade/metrics/readiness/close). */
  readonly rateLimit: AttachmentRateLimitComposition;
  /** Command counts of the shared Redis client; null in off mode (no client). */
  readonly counts: Rl04ClientCounts | null;
  /** Fixed-class admission log entries recorded through the composition. */
  readonly logEntries: AttachmentRateLimitLogEntry[];
  /** Infra metrics bridge (shadow_mismatch counter). */
  readonly metrics: InMemoryMetrics;
  /** How many times the download USE CASE was invoked (zero on exhausted). */
  readonly downloadCalls: () => number;
  /** The facade the routes call (direct assertions). */
  readonly facade: AttachmentRouteRateLimitFacade;
  close(): Promise<void>;
}

export interface BuildRl04AppOptions {
  readonly runtime: I07MigrationRuntime;
  readonly databaseUrl: string;
  readonly identityUnitOfWork: IdentityUnitOfWork;
  /** E1: Better Auth session authority (test factory); absent keeps legacy auth. */
  readonly browserSessionAuthority?: BrowserSessionAuthority;
  readonly objectServerUrl: string;
  readonly attachmentsConfig: AttachmentsFeatureConfig;
  /** Full RL02 config; `off` creates no client and needs no key secret. */
  readonly rateLimitConfig: AttachmentRateLimitConfig;
  /** HMAC key secret (required when mode !== off). */
  readonly keySecret?: Buffer;
  /** Optional counting client seam (defaults to the production client). */
  readonly createClient?: RateLimitRedisClientFactory;
  /** Optional local reference limiter for download (defaults to production). */
  readonly localLimiter?: DeliveryRateLimiter;
  readonly environment?: string;
}

/**
 * Production composition for the RL04 focused suites: the PRODUCTION
 * rate-limit composition (one shared Redis store; zero clients in off) wired
 * as the route facade, the download use case on the permissive limiter (the
 * facade consumes the local reference attempt exactly once), and the route
 * deps exactly as the RL04 API wiring composes them.
 */
export async function buildRl04App(options: BuildRl04AppOptions): Promise<Rl04AppBundle> {
  const logEntries: AttachmentRateLimitLogEntry[] = [];
  const metrics = new InMemoryMetrics();
  const counting = options.createClient === undefined
    ? (options.rateLimitConfig.mode === 'off' ? null : rl04CountingClientFactory())
    : null;
  const clientFactory = options.createClient ?? counting?.factory;
  const rateLimit = await composeAttachmentRateLimit({
    config: options.rateLimitConfig,
    environment: options.environment ?? RL04_ENVIRONMENT,
    resolveKeySecret: async () => {
      if (options.keySecret === undefined) throw new Error('rl04 helper: keySecret is required when mode !== off');
      return options.keySecret;
    },
    metrics,
    logger: (entry) => logEntries.push(entry),
    ...(clientFactory === undefined ? {} : { createClient: clientFactory }),
    ...(options.localLimiter === undefined ? {} : { localLimiter: options.localLimiter }),
  });

  const config = options.attachmentsConfig;
  const signer = createHmacOwnerDeliveryCapabilitySigner({
    secret: P08_DELIVERY_SECRET,
    audienceOrigin: config.isolatedDeliveryOrigin,
  });
  let downloadInvocations = 0;
  const admitDownload = (input: AuthorizeOwnerDownloadInput) => {
    downloadInvocations += 1;
    return authorizeOwnerDownload({
      ledger: createPostgresAttachmentsPorts(),
      accessPolicyFor: (transaction) => createPostgresAccessPolicyFactsPort(transaction),
      uow: createUnitOfWork(options.runtime.runtime.db),
      capabilitySigner: signer,
      rateLimiter: createPermissiveDeliveryRateLimiter(),
      config,
      now: () => new Date(),
    }, input);
  };

  const bundle = buildP03App({
    runtime: options.runtime.runtime,
    databaseUrl: options.databaseUrl,
    identityUnitOfWork: options.identityUnitOfWork,
    ...(options.browserSessionAuthority === undefined
      ? {}
      : { browserSessionAuthority: options.browserSessionAuthority }),
    objectServerUrl: options.objectServerUrl,
    attachmentsConfig: config,
    delivery: { admitDownload },
    rateLimit: rateLimit.facade,
  });

  return {
    bundle,
    rateLimit,
    counts: counting?.counts ?? null,
    logEntries,
    metrics,
    downloadCalls: () => downloadInvocations,
    facade: rateLimit.facade,
    async close() {
      await bundle.app.close();
      await bundle.store.close();
      await rateLimit.close();
    },
  };
}
