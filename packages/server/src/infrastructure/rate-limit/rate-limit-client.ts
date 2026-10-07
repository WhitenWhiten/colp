/**
 * P4A-RL03 ioredis client wrapper for the Attachment rate-limit store (plan
 * §2.2.5/§8 RL03).
 *
 * This is the ONLY file in the rate-limit surface that constructs an ioredis
 * client, and it is deliberately independent from the Publication cache
 * runtime (same budget-constant style, zero shared code):
 *
 *  - per-command timeout and connect/ready budget come from the RL02 config;
 *  - BOUNDED reconnect per client: `retryStrategy` stops after
 *    `RATE_LIMIT_REDIS_MAX_RECONNECT_ATTEMPTS` with geometric backoff
 *    (`BASE_DELAY` doubling up to `MAX_DELAY`); after terminal `end`, the
 *    runtime replaces that client so a longer outage can recover without a
 *    process restart;
 *  - `enableOfflineQueue=false` and the bounded per-request retries mean a
 *    disconnected Redis can never grow an unbounded command backlog;
 *  - the server's `maxmemory_policy` is periodically verified through
 *    read-only `INFO memory`; anything except `noeviction` fails closed so
 *    quota counters can never disappear silently under memory pressure;
 *  - events NEVER throw: listeners only update internal health; the connect
 *    promise is raced against the connect timeout and its rejection is
 *    swallowed, so a dead Redis can never surface as an unhandled rejection
 *    or an uncaught 'error' event;
 *  - no global singleton: the store factory owns and closes each instance;
 *  - close is idempotent and bounded (graceful `quit` raced against the close
 *    budget, then force-disconnect with a permanent swallow listener).
 *
 * Only the structural `RateLimitRedisClientLike`/`RateLimitRedisClientOptions`
 * types (no ioredis types) leak to the rest of the rate-limit surface.
 */
import { Redis } from 'ioredis';

/** Budget (ms) for graceful close before forcing a disconnect. Adapter policy, not RL02 config. */
export const RATE_LIMIT_REDIS_CLOSE_TIMEOUT_MS = 2_000;
/** Reconnection attempts before ioredis stops retrying (bounded, no infinite reconnect). */
export const RATE_LIMIT_REDIS_MAX_RECONNECT_ATTEMPTS = 10;
/** First reconnect delay (ms); geometric backoff from here. */
export const RATE_LIMIT_REDIS_RECONNECT_BASE_DELAY_MS = 100;
/** Reconnect delay cap (ms). */
export const RATE_LIMIT_REDIS_RECONNECT_MAX_DELAY_MS = 2_000;
/** Delay before replacing an ioredis instance whose reconnect budget reached `end`. */
export const RATE_LIMIT_REDIS_CLIENT_RECREATE_DELAY_MS = 1_000;
/** Recheck interval for the server-side noeviction invariant. */
export const RATE_LIMIT_REDIS_POLICY_RECHECK_MS = 60_000;

export type RateLimitRedisConfigurationErrorCode =
  | 'rate_limit_eviction_policy_unverified'
  | 'rate_limit_unsafe_eviction_policy';

export class RateLimitRedisConfigurationError extends Error {
  readonly code: RateLimitRedisConfigurationErrorCode;

  constructor(code: RateLimitRedisConfigurationErrorCode) {
    super(code);
    this.name = 'RateLimitRedisConfigurationError';
    this.code = code;
  }
}

/**
 * A quota command was attempted while Redis was not ready to verify its
 * eviction policy. This remains fail-closed, but it is an availability
 * failure rather than evidence that the server is misconfigured.
 */
export class RateLimitRedisUnavailableError extends Error {
  constructor() {
    super('rate_limit_unavailable');
    this.name = 'RateLimitRedisUnavailableError';
  }
}

/** Parse the exact Redis INFO memory field without accepting lookalike text. */
export function parseRateLimitRedisMaxmemoryPolicy(info: string): string | null {
  const match = /^maxmemory_policy:([^\r\n]+)\r?$/mu.exec(info);
  return match?.[1]?.trim().toLowerCase() ?? null;
}

/**
 * The ioredis option surface the wrapper builds from the RL02 config.
 * Structural so ioredis types never appear on the public rate-limit facade,
 * while remaining assignable to ioredis's RedisOptions.
 */
export interface RateLimitRedisClientOptions {
  readonly commandTimeout: number;
  readonly connectTimeout: number;
  readonly maxRetriesPerRequest: number;
  readonly enableOfflineQueue: false;
  readonly lazyConnect: true;
  readonly retryStrategy: (times: number) => number | null;
  /** Deliberately absent (undefined): the RL02 key codec already embeds the prefix in every key text. */
  readonly keyPrefix?: undefined;
}

/**
 * Minimal client surface the wrapper depends on. Structurally satisfied by an
 * ioredis `Redis` instance and by the scripted unit fake.
 */
export interface RateLimitRedisClientLike {
  readonly status: string;
  connect(): Promise<void>;
  disconnect(): void;
  quit(): Promise<'OK'>;
  removeAllListeners(): this;
  on(event: string, listener: (...args: unknown[]) => void): this;
  /** Present on real ioredis clients; optional only so narrow scripted test fakes stay minimal. */
  info?(section: 'memory'): Promise<string>;
  script(subcommand: 'LOAD', script: string): Promise<string>;
  evalsha(sha1: string, numkeys: number, ...args: (string | number)[]): Promise<unknown>;
}

/** Runtime construction settings (timeouts/budgets come from the RL02 config). */
export interface RateLimitRedisRuntimeConfig {
  /** Budget for the connect/ready race (ms); RL02 `connectTimeoutMs`. */
  readonly connectTimeoutMs: number;
  /** Bounded graceful-close budget (ms); defaults to RATE_LIMIT_REDIS_CLOSE_TIMEOUT_MS. */
  readonly closeTimeoutMs?: number;
  /** Factory retained only to replace a client after ioredis reaches terminal `end`. */
  readonly recreateClient?: () => RateLimitRedisClientLike;
  /** Test seam for the terminal-client replacement delay. */
  readonly recreateDelayMs?: number;
  /** Test seam for the periodic noeviction verification interval. */
  readonly policyRecheckMs?: number;
}

interface CancellableDelay {
  readonly promise: Promise<void>;
  cancel(): void;
}

function delayWithCancel(ms: number): CancellableDelay {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  return {
    promise,
    cancel() {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
    },
  };
}

function boundedRetryStrategy(times: number): number | null {
  if (times < 1) return RATE_LIMIT_REDIS_RECONNECT_BASE_DELAY_MS;
  if (times > RATE_LIMIT_REDIS_MAX_RECONNECT_ATTEMPTS) return null;
  return Math.min(
    RATE_LIMIT_REDIS_RECONNECT_BASE_DELAY_MS * 2 ** (times - 1),
    RATE_LIMIT_REDIS_RECONNECT_MAX_DELAY_MS,
  );
}

/**
 * Connection lifecycle for the rate-limit client. Commands are issued by the
 * store through the client; the runtime only owns connect/ready/close and the
 * never-throwing event surface.
 */
export class RateLimitRedisRuntime {
  private client: RateLimitRedisClientLike;
  private readonly connectTimeoutMs: number;
  private readonly closeTimeoutMs: number;
  private readonly recreateClient: (() => RateLimitRedisClientLike) | undefined;
  private readonly recreateDelayMs: number;
  private readonly policyRecheckMs: number;
  private healthState: 'healthy' | 'degraded' = 'degraded';
  private evictionPolicyState: 'unknown' | 'safe' | 'unsafe';
  private evictionPolicyError: unknown;
  private closed = false;
  private closePromise: Promise<void> | undefined;
  private readyTimeout: CancellableDelay | undefined;
  private recreateDelay: CancellableDelay | undefined;
  private policyRecheckDelay: CancellableDelay | undefined;
  private policyValidation: Promise<void> | undefined;

  constructor(client: RateLimitRedisClientLike, config: RateLimitRedisRuntimeConfig) {
    this.client = client;
    this.connectTimeoutMs = config.connectTimeoutMs;
    this.closeTimeoutMs = config.closeTimeoutMs ?? RATE_LIMIT_REDIS_CLOSE_TIMEOUT_MS;
    this.recreateClient = config.recreateClient;
    this.recreateDelayMs = config.recreateDelayMs ?? RATE_LIMIT_REDIS_CLIENT_RECREATE_DELAY_MS;
    this.policyRecheckMs = config.policyRecheckMs ?? RATE_LIMIT_REDIS_POLICY_RECHECK_MS;
    // `info` is optional solely for injected unit fakes. Every real ioredis
    // client has it and therefore starts unverified/fail-closed.
    this.evictionPolicyState = client.info === undefined ? 'safe' : 'unknown';
    this.attachEventListeners(client);
    this.raceReady(client);
  }

  /** Connection state only; the store readiness evaluator adds the circuit fact. */
  health(): 'healthy' | 'degraded' {
    return this.closed ? 'degraded' : this.healthState;
  }

  /** Loads the frozen script and resolves its SHA1 (the store owns the reload-on-NOSCRIPT policy). */
  scriptLoad(script: string): Promise<string> {
    const policyFailure = this.evictionPolicyFailure();
    if (policyFailure !== null) return Promise.reject(policyFailure);
    return this.client.script('LOAD', script);
  }

  /** EVALSHA with the canonical (key, ...args) layout; the store wraps it in its timeout race. */
  evalsha(sha1: string, numkeys: number, ...args: (string | number)[]): Promise<unknown> {
    const policyFailure = this.evictionPolicyFailure();
    if (policyFailure !== null) return Promise.reject(policyFailure);
    return this.client.evalsha(sha1, numkeys, ...args);
  }

  /** Bounded, idempotent close: graceful quit raced against the close budget, then force-disconnect. */
  close(): Promise<void> {
    this.closePromise ??= (async () => {
      this.closed = true;
      this.healthState = 'degraded';
      this.readyTimeout?.cancel();
      this.readyTimeout = undefined;
      this.recreateDelay?.cancel();
      this.recreateDelay = undefined;
      this.policyRecheckDelay?.cancel();
      this.policyRecheckDelay = undefined;
      this.policyValidation = undefined;
      const client = this.client;
      const graceful = Promise.resolve()
        .then(() => client.quit())
        .then(() => true, () => true);
      const timeout = delayWithCancel(this.closeTimeoutMs);
      const gracefulWon = await Promise.race([
        graceful,
        timeout.promise.then(() => false),
      ]);
      if (gracefulWon) timeout.cancel();
      client.disconnect();
      client.removeAllListeners();
      // A socket that dies after removeAllListeners must never raise an
      // uncaught 'error' event, so keep a permanent swallow listener.
      client.on('error', () => undefined);
    })();
    return this.closePromise;
  }

  private attachEventListeners(client: RateLimitRedisClientLike): void {
    const updateHealth = (state: 'healthy' | 'degraded'): void => {
      if (!this.closed && client === this.client) this.healthState = state;
    };
    client.on('ready', () => {
      updateHealth('degraded');
      this.validateEvictionPolicy(client);
    });
    client.on('connect', () => { this.markConnectionDegraded(client); });
    client.on('error', () => { this.markConnectionDegraded(client); });
    client.on('close', () => { this.markConnectionDegraded(client); });
    client.on('end', () => {
      this.markConnectionDegraded(client);
      this.scheduleClientRecreation(client);
    });
    client.on('reconnecting', () => { this.markConnectionDegraded(client); });
  }

  /**
   * Kick off the lazy connect and race it against the connect timeout.
   * Success or failure only updates health; a rejection is never surfaced.
   */
  private raceReady(client: RateLimitRedisClientLike): void {
    this.readyTimeout?.cancel();
    const timeout = delayWithCancel(this.connectTimeoutMs);
    this.readyTimeout = timeout;
    void timeout.promise.then(() => {
      if (!this.closed && client === this.client) this.healthState = 'degraded';
    });
    Promise.resolve()
      .then(() => client.connect())
      .then(() => {
        timeout.cancel();
        this.validateEvictionPolicy(client);
      })
      .catch(() => {
        timeout.cancel();
        if (!this.closed && client === this.client) this.healthState = 'degraded';
      });
  }

  private scheduleClientRecreation(terminalClient: RateLimitRedisClientLike): void {
    if (
      this.closed
      || terminalClient !== this.client
      || this.recreateClient === undefined
      || this.recreateDelay !== undefined
    ) return;

    this.readyTimeout?.cancel();
    this.readyTimeout = undefined;
    const delay = delayWithCancel(this.recreateDelayMs);
    this.recreateDelay = delay;
    void delay.promise.then(() => {
      if (this.closed || this.recreateDelay !== delay || terminalClient !== this.client) return;
      this.recreateDelay = undefined;

      let replacement: RateLimitRedisClientLike;
      try {
        replacement = this.recreateClient!();
      } catch {
        this.scheduleClientRecreation(terminalClient);
        return;
      }

      terminalClient.removeAllListeners();
      terminalClient.disconnect();
      terminalClient.on('error', () => undefined);
      this.client = replacement;
      this.evictionPolicyState = replacement.info === undefined ? 'safe' : 'unknown';
      this.evictionPolicyError = undefined;
      this.policyValidation = undefined;
      this.attachEventListeners(replacement);
      this.raceReady(replacement);
    });
  }

  private evictionPolicyFailure(): unknown | null {
    if (this.evictionPolicyState === 'safe') return null;
    if (this.evictionPolicyState === 'unknown' && this.client.status !== 'ready') {
      return new RateLimitRedisUnavailableError();
    }
    return this.evictionPolicyError
      ?? new RateLimitRedisConfigurationError('rate_limit_eviction_policy_unverified');
  }

  private markConnectionDegraded(client: RateLimitRedisClientLike): void {
    if (this.closed || client !== this.client) return;
    this.healthState = 'degraded';
    this.evictionPolicyState = client.info === undefined ? 'safe' : 'unknown';
    this.evictionPolicyError = undefined;
    this.policyRecheckDelay?.cancel();
    this.policyRecheckDelay = undefined;
    this.policyValidation = undefined;
  }

  private validateEvictionPolicy(client: RateLimitRedisClientLike): void {
    if (this.closed || client !== this.client) return;
    if (client.info === undefined) {
      this.evictionPolicyState = 'safe';
      this.evictionPolicyError = undefined;
      this.healthState = 'healthy';
      return;
    }
    if (this.policyValidation !== undefined) return;

    this.policyRecheckDelay?.cancel();
    this.policyRecheckDelay = undefined;
    if (this.evictionPolicyState !== 'safe') this.healthState = 'degraded';
    const validation = Promise.resolve()
      .then(() => client.info!('memory'))
      .then((info) => {
        const policy = parseRateLimitRedisMaxmemoryPolicy(info);
        if (policy !== 'noeviction') {
          throw new RateLimitRedisConfigurationError(
            policy === null
              ? 'rate_limit_eviction_policy_unverified'
              : 'rate_limit_unsafe_eviction_policy',
          );
        }
      });
    this.policyValidation = validation;
    void validation.then(
      () => {
        if (this.closed || client !== this.client || this.policyValidation !== validation) return;
        this.policyValidation = undefined;
        this.evictionPolicyState = 'safe';
        this.evictionPolicyError = undefined;
        this.healthState = 'healthy';
        this.schedulePolicyRecheck(client);
      },
      (error: unknown) => {
        if (this.closed || client !== this.client || this.policyValidation !== validation) return;
        this.policyValidation = undefined;
        this.evictionPolicyState = 'unsafe';
        this.evictionPolicyError = error;
        this.healthState = 'degraded';
        this.schedulePolicyRecheck(client);
      },
    );
  }

  private schedulePolicyRecheck(client: RateLimitRedisClientLike): void {
    if (this.closed || client !== this.client || client.info === undefined) return;
    const delay = delayWithCancel(this.policyRecheckMs);
    this.policyRecheckDelay = delay;
    void delay.promise.then(() => {
      if (this.closed || client !== this.client || this.policyRecheckDelay !== delay) return;
      this.policyRecheckDelay = undefined;
      this.validateEvictionPolicy(client);
    });
  }
}

function buildClientOptions(config: {
  readonly commandTimeoutMs: number;
  readonly connectTimeoutMs: number;
  readonly maxRetriesPerRequest: number;
}): RateLimitRedisClientOptions {
  return {
    commandTimeout: config.commandTimeoutMs,
    connectTimeout: config.connectTimeoutMs,
    maxRetriesPerRequest: config.maxRetriesPerRequest,
    enableOfflineQueue: false,
    lazyConnect: true,
    retryStrategy: boundedRetryStrategy,
    // keyPrefix is intentionally absent: the RL02 codec embeds config.keyPrefix
    // into every key text (plan §2.3); ioredis prefixing would double-prefix
    // keys AND the EVALSHA KEYS argument.
  };
}

function defaultCreateClient(url: string, options: RateLimitRedisClientOptions): RateLimitRedisClientLike {
  // ioredis parses rediss:// into TLS and extracts ACL username/password/db
  // from the URL; the cast is confined to this one ioredis boundary (the same
  // narrowing the cache runtime uses), so no ioredis type leaks out.
  return new Redis(url, options) as unknown as RateLimitRedisClientLike;
}

/** Test seam: replace the real ioredis client with a scripted fake. */
export type RateLimitRedisClientFactory = (
  url: string,
  options: RateLimitRedisClientOptions,
) => RateLimitRedisClientLike;

export interface CreateRateLimitRedisClientInput {
  readonly url: string;
  readonly commandTimeoutMs: number;
  readonly connectTimeoutMs: number;
  readonly maxRetriesPerRequest: number;
  readonly closeTimeoutMs?: number;
  readonly recreateDelayMs?: number;
  readonly policyRecheckMs?: number;
  readonly createClient?: RateLimitRedisClientFactory;
}

/** Factory (no global singleton): each store owns and closes its own runtime. */
export function createRateLimitRedisRuntime(input: CreateRateLimitRedisClientInput): RateLimitRedisRuntime {
  const createClient = input.createClient ?? defaultCreateClient;
  const clientOptions = buildClientOptions(input);
  const makeClient = (): RateLimitRedisClientLike => createClient(input.url, clientOptions);
  const client = makeClient();
  return new RateLimitRedisRuntime(client, {
    connectTimeoutMs: input.connectTimeoutMs,
    closeTimeoutMs: input.closeTimeoutMs,
    recreateClient: makeClient,
    recreateDelayMs: input.recreateDelayMs,
    policyRecheckMs: input.policyRecheckMs,
  });
}
