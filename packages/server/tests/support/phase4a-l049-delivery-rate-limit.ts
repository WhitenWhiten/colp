/**
 * Shared FIX-L-049 delivery rate-limit fixtures for the codec, adapter, and
 * host suites. Not a test file.
 */
import { request as httpRequest } from 'node:http';
import {
  createHmacOwnerDeliveryCapabilitySigner,
  type DeliveryGenerationResolver,
  type DeliveryRequestLimiter,
  type DeliveryRequestRateLimitOutcome,
  type DeliveryRequestRateLimitPolicy,
  type GenerationHeadOutcome,
  type GenerationObjectHandle,
  type GenerationObjectStorePort,
  type GenerationReadOptions,
  type GenerationReadOutcome,
} from '../../src/modules/attachments/index.js';
import {
  buildDeliveryRateLimitKey,
  createRedisDeliveryRequestLimiter,
  type RateLimitRedisClientLike,
  type RateLimitRedisClientOptions,
} from '../../src/infrastructure/rate-limit/index.js';
import { composeDeliveryHost, type DeliveryHost } from '../../src/bootstrap/delivery.js';
import {
  FixtureDeliveryObjectStore,
  fixtureResolver,
  i11Config,
  type I11FixtureObject,
} from './phase4a-i11-test-helpers.js';

export const ENVIRONMENT = 'test';
export const KEY_PREFIX = 'l049-unit';
export const KEY_SECRET = Buffer.from('l049-unit-hmac-secret-0123456789abcdef', 'utf8');
export const WINDOW_MS = 60_000;
export const NOW_MS = 1_750_000_000_000;
export const WINDOW_START = Math.floor(NOW_MS / WINDOW_MS) * WINDOW_MS;
export const CAPABILITY_SECRET = Buffer.from('l049-delivery-capability-hmac-secret-0123456789abcdef', 'utf8');
export const TOKEN_A = 'v1.eyJibG9iSWQiOiJibG9iLTEiLCJnZW5lcmF0aW9uSWQiOiJnZW4tMSJ9.sig-a';
export const TOKEN_B = 'v1.eyJibG9iSWQiOiJibG9iLTIiLCJnZW5lcmF0aW9uSWQiOiJnZW4tMiJ9.sig-b';

export function deliveryProcessEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'test',
    PRODUCT_ORIGIN: 'https://app.example.com',
    ATTACHMENTS_ENABLED: 'true',
    ATTACHMENTS_R2_ENDPOINT: 'https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com',
    ATTACHMENTS_R2_REGION: 'auto',
    ATTACHMENTS_R2_BUCKET: 'known-private-attachments',
    ATTACHMENTS_R2_LIVE_PREFIX: 'attachments/live/',
    ATTACHMENTS_R2_PROBE_PREFIX: 'attachments/probe/',
    ATTACHMENTS_R2_RW_SECRET_REF: 'known/r2/rw/primary',
    ATTACHMENTS_R2_RO_SECRET_REF: 'known/r2/ro/primary',
    ATTACHMENTS_ISOLATED_DELIVERY_ORIGIN: 'https://delivery.example.net',
    ATTACHMENTS_DELIVERY_CAPABILITY_SECRET_REF: 'known/delivery/hmac/primary',
    ATTACHMENTS_DELIVERY_CAPABILITY_TTL_SECONDS: '60',
    ATTACHMENTS_ALLOWED_MEDIA: 'image/jpeg, image/png, application/pdf, text/plain',
    ATTACHMENTS_GRANT_TTL_SECONDS: '60',
    ATTACHMENTS_SINGLE_PUT_MAX_BYTES: '5242880',
    ATTACHMENTS_VERIFICATION_LEASE_MS: '60000',
    ATTACHMENTS_VERIFICATION_TIMEOUT_MS: '15000',
    ATTACHMENTS_VERIFICATION_RETRY_COUNT: '2',
    ATTACHMENTS_INTENT_RETENTION_HOURS: '24',
    ATTACHMENTS_STORED_RETENTION_DAYS: '30',
    ATTACHMENTS_RETIRED_RETENTION_DAYS: '90',
    ATTACHMENTS_CLEANUP_BATCH_SIZE: '100',
    ATTACHMENTS_CLEANUP_LEASE_MS: '60000',
    ATTACHMENTS_CLEANUP_RETRY_COUNT: '2',
    ATTACHMENTS_DELIVERY_DATABASE_URL: 'postgresql://delivery:secret@127.0.0.1:5432/known',
    ATTACHMENTS_DELIVERY_HOST: '127.0.0.1',
    ATTACHMENTS_DELIVERY_PORT: '8080',
    ...overrides,
  };
}

export function keyFor(policy: DeliveryRequestRateLimitPolicy, facts: string, windowStartEpochMs = WINDOW_START): string {
  return buildDeliveryRateLimitKey({
    keyPrefix: KEY_PREFIX,
    environment: ENVIRONMENT,
    keySecret: KEY_SECRET,
    policy,
    facts,
    windowStartEpochMs,
  });
}

export function assertFailed(outcome: DeliveryRequestRateLimitOutcome, failureClass: string, code: string): void {
  if (outcome.kind !== 'failed') {
    throw new Error(`expected failed outcome, received ${outcome.kind}`);
  }
  if (outcome.failure.class !== failureClass) {
    throw new Error(`expected failure class ${failureClass}, received ${outcome.failure.class}`);
  }
  if (outcome.failure.code !== code) {
    throw new Error(`expected failure code ${code}, received ${outcome.failure.code}`);
  }
}

export interface FakeCall {
  readonly kind: 'script_load' | 'evalsha';
  readonly args: readonly unknown[];
}

export function replyError(message: string): Error {
  const error = new Error(message);
  error.name = 'ReplyError';
  return error;
}

export class FakeRateLimitClient implements RateLimitRedisClientLike {
  status = 'ready';
  readonly calls: FakeCall[] = [];
  scriptLoadImpl: (script: string) => Promise<string> = async () => 'a'.repeat(40);
  evalshaImpl: (sha: string, args: readonly (string | number)[]) => Promise<unknown> = async (_sha, args) => {
    const rateMax = Number(args[1]);
    return [1, 1, Math.max(0, rateMax - 1), 60, WINDOW_START];
  };

  connect(): Promise<void> { return Promise.resolve(); }
  disconnect(): void {}
  quit(): Promise<'OK'> { return Promise.resolve('OK'); }
  removeAllListeners(): this { return this; }
  on(): this { return this; }
  script(subcommand: 'LOAD', script: string): Promise<string> {
    this.calls.push({ kind: 'script_load', args: [subcommand, script] });
    return this.scriptLoadImpl(script);
  }
  evalsha(sha: string, numkeys: number, ...args: (string | number)[]): Promise<unknown> {
    this.calls.push({ kind: 'evalsha', args: [sha, numkeys, ...args] });
    return this.evalshaImpl(sha, args);
  }
}

export function makeRedisStore(
  fake: FakeRateLimitClient,
  overrides: {
    readonly ipMax?: number;
    readonly tokenMax?: number;
    readonly now?: () => number;
    readonly failureThreshold?: number;
    readonly cooldownMs?: number;
  } = {},
): DeliveryRequestLimiter {
  return createRedisDeliveryRequestLimiter({
    redisUrl: 'redis://127.0.0.1:6379',
    environment: ENVIRONMENT,
    keySecret: KEY_SECRET,
    keyPrefix: KEY_PREFIX,
    ip: { maxRequests: overrides.ipMax ?? 2, windowMs: WINDOW_MS },
    token: { maxRequests: overrides.tokenMax ?? 5, windowMs: WINDOW_MS },
    commandTimeoutMs: 75,
    connectTimeoutMs: 1_000,
    maxRetriesPerRequest: 1,
    createClient: (_url: string, _clientOptions: RateLimitRedisClientOptions) => fake,
    now: overrides.now,
    failureThreshold: overrides.failureThreshold,
    cooldownMs: overrides.cooldownMs,
  });
}

class CountingObjectStore {
  headCalls = 0;
  readCalls = 0;

  constructor(private readonly inner: FixtureDeliveryObjectStore) {}

  async headExact(
    handle: GenerationObjectHandle,
    options?: { readonly expectedEtag?: string; readonly signal?: AbortSignal },
  ): Promise<GenerationHeadOutcome> {
    this.headCalls += 1;
    return this.inner.headExact(handle, options);
  }

  async readBounded(handle: GenerationObjectHandle, options: GenerationReadOptions): Promise<GenerationReadOutcome> {
    this.readCalls += 1;
    return this.inner.readBounded(handle, options);
  }

  async close(): Promise<void> {
    await this.inner.close();
  }
}

export interface LimiterHarness {
  readonly host: DeliveryHost;
  readonly origin: string;
  readonly signer: ReturnType<typeof createHmacOwnerDeliveryCapabilitySigner>;
  readonly store: CountingObjectStore;
  readonly resolveCalls: () => number;
}

export async function startLimiterHarness(options: {
  readonly limiter: DeliveryRequestLimiter;
  readonly objects: readonly I11FixtureObject[];
  readonly hostname?: string;
  readonly trustedIngress?: readonly string[];
}): Promise<LimiterHarness> {
  const fixtureStore = new FixtureDeliveryObjectStore();
  for (const object of options.objects) fixtureStore.seed(object);
  const store = new CountingObjectStore(fixtureStore);
  const inner = fixtureResolver(options.objects);
  let resolveCount = 0;
  const resolveGeneration: DeliveryGenerationResolver = async (claims) => {
    resolveCount += 1;
    return inner(claims);
  };
  const host = await composeDeliveryHost({
    config: i11Config(),
    objectStore: store as GenerationObjectStorePort,
    capabilitySecret: CAPABILITY_SECRET,
    resolveGeneration,
    requestLimiter: options.limiter,
    hostname: options.hostname ?? '127.0.0.2',
    ...(options.trustedIngress === undefined ? {} : { trustedIngress: options.trustedIngress }),
    upstreamTimeoutMs: 5_000,
  });
  const origin = await host.start();
  const signer = createHmacOwnerDeliveryCapabilitySigner({ secret: CAPABILITY_SECRET, audienceOrigin: origin });
  return { host, origin, signer, store, resolveCalls: () => resolveCount };
}

export async function stopLimiterHarness(harness: LimiterHarness): Promise<void> {
  await harness.host.close();
}

export function objectWith(suffix: string, bytes: Uint8Array): I11FixtureObject {
  return {
    blobId: `018f6f7a-8f2a-7a3d-a123-12345678${suffix.slice(0, 2)}01`,
    generationId: `018f6f7a-8f2a-7a3d-a123-12345678${suffix.slice(0, 2)}02`,
    key: `attachments/live/l049-${suffix}-object`,
    ownerSubject: 'l049-subject-owner',
    bytes,
    etag: `"l049-etag-${suffix}"`,
  };
}

export function rawGet(
  origin: string,
  path: string,
  localAddress?: string,
  headers?: Readonly<Record<string, string>>,
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((resolvePromise, reject) => {
    const url = new URL(`${origin}${path}`);
    const request = httpRequest({
      host: url.hostname,
      port: Number(url.port),
      path: `${url.pathname}${url.search}`,
      method: 'GET',
      ...(localAddress === undefined ? {} : { localAddress }),
      ...(headers === undefined ? {} : { headers }),
    }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => {
        body += chunk;
      });
      response.on('end', () => {
        resolvePromise({ status: response.statusCode ?? 0, headers: response.headers, body });
      });
    });
    request.on('error', reject);
    request.end();
  });
}
