/**
 * T03 Redis runtime adapter (plan §6.4 T03): encapsulate the ioredis client's
 * connection, timeout, retry, ready and close behavior inside infrastructure,
 * and expose it through the T02 `CacheStore` port.
 *
 * Design decisions (see plan §5/§6.3/§6.4 T03):
 *
 * - **TLS/ACL URLs** — the raw REDIS_URL is handed to ioredis verbatim.
 *   ioredis enables TLS for `rediss://` and extracts ACL username/password/db
 *   from the URL userinfo/path, so the adapter never parses or logs the URL.
 * - **No duplicated defaults** — commandTimeout, connectTimeout and
 *   maxRetriesPerRequest are copied straight from the T01 config object into
 *   the ioredis options. Only reconnect/close *budgets* (which T01 does not
 *   define) are adapter policy constants below.
 * - **keyPrefix** — the T02 key builders already embed `config.keyPrefix` in
 *   every key text (plan §4.1), so the ioredis `keyPrefix` option is
 *   intentionally NOT set. Enabling it would double-prefix keys, including the
 *   KEYS arguments passed to EVAL.
 * - **Bounded failure** — `enableOfflineQueue=false`, a bounded
 *   `maxRetriesPerRequest` from config and a bounded `retryStrategy` mean a
 *   disconnected Redis can never grow an unbounded command backlog. When one
 *   ioredis instance exhausts that reconnect budget and enters its terminal
 *   `end` state, the runtime replaces it after a bounded delay so a longer
 *   Redis failover can recover without a process restart.
 * - **Events never throw** — listeners only update internal health. The
 *   connect() promise is raced against `connectTimeoutMs` and its rejection is
 *   swallowed, so a dead Redis can never surface as an unhandled rejection or
 *   an uncaught 'error' event.
 * - **No global singleton** — this module only provides `createRedisCacheStore`
 *   (a factory). API and Worker each own their instance (T10/T11).
 * - **ioredis type isolation** — ioredis is imported (value + type) only in
 *   this file; the public cache facade exports structural types
 *   (`RedisClientLike`, `RedisClientOptions`) that contain no ioredis types.
 */
import { Redis } from 'ioredis';
import { CacheAbortError } from './cache-abort.js';
import {
  CACHE_ERROR_CATEGORY,
  CacheStoreError,
  type CacheHealthState,
  type CacheStore,
} from './cache-store.js';

/** Budget (ms) for graceful close before forcing a disconnect. Adapter policy, not T01 config. */
export const REDIS_CLOSE_TIMEOUT_MS = 2_000;
/** Reconnection attempts before ioredis stops retrying (bounded, no infinite reconnect). */
export const REDIS_MAX_RECONNECT_ATTEMPTS = 10;
/** First reconnect delay (ms); geometric backoff from here. */
export const REDIS_RECONNECT_BASE_DELAY_MS = 100;
/** Reconnect delay cap (ms). */
export const REDIS_RECONNECT_MAX_DELAY_MS = 2_000;
/** Delay before replacing an ioredis instance whose reconnect budget reached `end`. */
export const REDIS_CLIENT_RECREATE_DELAY_MS = 1_000;

/**
 * Token-guarded unlock (plan §6.4 T03): compare the token and delete on the
 * Redis side inside one atomic script. The application must never GET-then-DEL.
 */
export const REDIS_RELEASE_SCRIPT =
  "if redis.call('get',KEYS[1])==ARGV[1] then return redis.call('del',KEYS[1]) else return 0 end";

/**
 * Atomic epoch rotation: INCR then refresh the TTL in one script. The caller
 * never supplies an epoch override value; Redis owns the counter.
 */
export const REDIS_ROTATE_EPOCH_SCRIPT =
  "local n = redis.call('incr', KEYS[1]); redis.call('pexpire', KEYS[1], ARGV[1]); return n";

/**
 * T01 connection settings consumed by the adapter. Structural subset of
 * `bootstrap/config.ts`'s `RedisConnectionConfig`: the cache infrastructure
 * layer is not allowed to import bootstrap, and composition (T10/T11) passes
 * the full config object here. T01 already validated ranges/defaults; the
 * adapter copies values through without re-deriving defaults.
 */
export interface RedisCacheConnectionConfig {
  /** Full REDIS_URL (redis:// or rediss://). Null is a programmer error here. */
  readonly url: string | null;
  /** Per-command timeout (ms) — passed straight through to ioredis. */
  readonly commandTimeoutMs: number;
  /** Connect/ready budget (ms) — passed straight through and used for the ready race. */
  readonly connectTimeoutMs: number;
  /** Bounded per-request retries (0..10, T01) — passed straight through. */
  readonly maxRetriesPerRequest: number;
  /** Key namespace prefix. Used by the T02 key builders; NOT passed to ioredis. */
  readonly keyPrefix: string;
}

/**
 * The ioredis option surface the adapter builds from config. Declared as our
 * own structural type so ioredis types never appear on the public cache
 * facade, while remaining assignable to ioredis's RedisOptions.
 */
export interface RedisClientOptions {
  readonly commandTimeout: number;
  readonly connectTimeout: number;
  readonly maxRetriesPerRequest: number;
  readonly enableOfflineQueue: false;
  readonly lazyConnect: true;
  readonly retryStrategy: (times: number) => number | null;
  /** Deliberately absent (undefined): T02 key text already contains the prefix. */
  readonly keyPrefix?: undefined;
}

/**
 * Minimal client surface RedisRuntime depends on. Structurally satisfied by an
 * ioredis `Redis` instance and by the scripted unit fake.
 */
export interface RedisClientLike {
  readonly status: string;
  connect(): Promise<void>;
  disconnect(): void;
  quit(): Promise<'OK'>;
  removeAllListeners(): this;
  on(event: string, listener: (...args: unknown[]) => void): this;
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ...args: (string | number)[]): Promise<unknown>;
  eval(script: string, numkeys: number, ...args: (string | number)[]): Promise<unknown>;
}

/** RedisRuntime construction settings (timeouts/budgets; values come from T01 config where defined). */
export interface RedisRuntimeConfig {
  /** Budget for the connect/ready race (ms); T01 `connectTimeoutMs`. */
  readonly connectTimeoutMs: number;
  /** Bounded graceful-close budget (ms); defaults to REDIS_CLOSE_TIMEOUT_MS. */
  readonly closeTimeoutMs?: number;
  /** Factory retained only to replace a client after ioredis reaches terminal `end`. */
  readonly recreateClient?: () => RedisClientLike;
  /** Test seam for the terminal-client replacement delay. */
  readonly recreateDelayMs?: number;
}

/** createRedisCacheStore options; the client seam is the unit-test injection point. */
export interface RedisCacheStoreOptions {
  /** Replace the real ioredis client with a scripted fake (tests only). */
  readonly createClient?: (url: string, options: RedisClientOptions) => RedisClientLike;
  /** Bounded graceful-close budget (ms); defaults to REDIS_CLOSE_TIMEOUT_MS. */
  readonly closeTimeoutMs?: number;
  /** Test seam for the terminal-client replacement delay. */
  readonly recreateDelayMs?: number;
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
  if (times < 1) return REDIS_RECONNECT_BASE_DELAY_MS;
  if (times > REDIS_MAX_RECONNECT_ATTEMPTS) return null;
  return Math.min(
    REDIS_RECONNECT_BASE_DELAY_MS * 2 ** (times - 1),
    REDIS_RECONNECT_MAX_DELAY_MS,
  );
}

function toCacheStoreError(operation: string, error: unknown): CacheStoreError {
  const reason = error instanceof Error && error.name ? error.name : 'unknown';
  return new CacheStoreError(
    CACHE_ERROR_CATEGORY.UNAVAILABLE,
    `cache ${operation} failed (${reason})`,
  );
}

function abortError(operation: string): CacheAbortError {
  // Client cancellation is not a Redis failure: it must never be classified as
  // cache_unavailable (which would trip the breaker and fail-open for a request
  // that simply went away). The T04 singleflight/bulkhead already throw
  // CacheAbortError for cancellations; the runtime joins that classification.
  return new CacheAbortError(`cache ${operation} aborted`);
}

/**
 * Races a command against an AbortSignal. An aborted signal rejects fast with
 * a CacheAbortError (client cancellation, never a cache_unavailable failure);
 * the underlying client promise is always handled so no unhandled rejection
 * is possible.
 */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal, operation: string): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError(operation));
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(abortError(operation));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(toCacheStoreError(operation, error));
      },
    );
  });
}

/**
 * Connection lifecycle plus the low-level Redis commands. Commands fail fast
 * with `CacheAbortError` on signal abort (client cancellation, shared with the
 * T04 singleflight/bulkhead classification) and with
 * `CacheStoreError(cache_unavailable)` on closed runtime, disconnect, command
 * timeout or any other client error; a `get` miss resolves `null` and is never
 * an error.
 */
export class RedisRuntime {
  private client: RedisClientLike;
  private readonly connectTimeoutMs: number;
  private readonly closeTimeoutMs: number;
  private readonly recreateClient: (() => RedisClientLike) | undefined;
  private readonly recreateDelayMs: number;
  private healthState: CacheHealthState = 'degraded';
  private closed = false;
  private closePromise: Promise<void> | undefined;
  private readyTimeout: CancellableDelay | undefined;
  private recreateDelay: CancellableDelay | undefined;

  constructor(client: RedisClientLike, config: RedisRuntimeConfig) {
    this.client = client;
    this.connectTimeoutMs = config.connectTimeoutMs;
    this.closeTimeoutMs = config.closeTimeoutMs ?? REDIS_CLOSE_TIMEOUT_MS;
    this.recreateClient = config.recreateClient;
    this.recreateDelayMs = config.recreateDelayMs ?? REDIS_CLIENT_RECREATE_DELAY_MS;
    this.attachEventListeners(client);
    this.raceReady(client);
  }

  /** Current connection state; NOT business readiness (KNOWN_CACHE_REQUIRED is T10/T11). */
  health(): CacheHealthState {
    return this.closed ? 'degraded' : this.healthState;
  }

  async get(key: string, signal: AbortSignal): Promise<string | null> {
    return this.run('get', signal, () => this.client.get(key));
  }

  async set(key: string, value: string, hardTtlMs: number, signal: AbortSignal): Promise<void> {
    await this.run('set', signal, () => this.client.set(key, value, 'PX', hardTtlMs));
  }

  /** Atomic SET key token PX <ttl> NX; resolves true only for the single acquirer. */
  async setIfAbsent(key: string, token: string, lockTtlMs: number, signal: AbortSignal): Promise<boolean> {
    const result = await this.run('setIfAbsent', signal, () =>
      this.client.set(key, token, 'PX', lockTtlMs, 'NX'));
    return result === 'OK';
  }

  /** Token-guarded unlock via Lua (never application-side GET->if->DEL). */
  async releaseIfOwner(key: string, token: string, signal: AbortSignal): Promise<boolean> {
    const result = await this.run('releaseIfOwner', signal, () =>
      this.client.eval(REDIS_RELEASE_SCRIPT, 1, key, token));
    return result === 1;
  }

  /** Atomic INCR + PEXPIRE via Lua; resolves the new positive epoch (Redis owns the counter). */
  async rotateEpoch(key: string, epochTtlMs: number, signal: AbortSignal): Promise<number> {
    const result = await this.run('rotateEpoch', signal, () =>
      this.client.eval(REDIS_ROTATE_EPOCH_SCRIPT, 1, key, epochTtlMs));
    const epoch = Number(result);
    if (!Number.isSafeInteger(epoch) || epoch < 1) {
      throw new CacheStoreError(
        CACHE_ERROR_CATEGORY.UNAVAILABLE,
        'cache rotateEpoch failed (non-positive reply)',
      );
    }
    return epoch;
  }

  /** Bounded, idempotent close: graceful quit raced against closeTimeoutMs, then force-disconnect. */
  close(): Promise<void> {
    this.closePromise ??= (async () => {
      this.closed = true;
      this.healthState = 'degraded';
      this.readyTimeout?.cancel();
      this.readyTimeout = undefined;
      this.recreateDelay?.cancel();
      this.recreateDelay = undefined;
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

  private attachEventListeners(client: RedisClientLike): void {
    const updateHealth = (state: CacheHealthState): void => {
      if (!this.closed && client === this.client) this.healthState = state;
    };
    client.on('ready', () => { updateHealth('healthy'); });
    client.on('connect', () => { updateHealth('degraded'); });
    client.on('error', () => { updateHealth('degraded'); });
    client.on('close', () => { updateHealth('degraded'); });
    client.on('end', () => {
      updateHealth('degraded');
      this.scheduleClientRecreation(client);
    });
    client.on('reconnecting', () => { updateHealth('degraded'); });
  }

  /**
   * Kick off the lazy connect and race it against connectTimeoutMs. Success or
   * failure only updates health; a rejection is never surfaced to the caller.
   */
  private raceReady(client: RedisClientLike): void {
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
        if (!this.closed && client === this.client) this.healthState = 'healthy';
      })
      .catch(() => {
        timeout.cancel();
        if (!this.closed && client === this.client) this.healthState = 'degraded';
      });
  }

  /**
   * `retryStrategy` deliberately stops inside one client. `end` is terminal
   * for that instance, so replace it instead of leaving a long-lived API or
   * worker permanently detached after Redis itself has recovered.
   */
  private scheduleClientRecreation(terminalClient: RedisClientLike): void {
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

      let replacement: RedisClientLike;
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
      this.attachEventListeners(replacement);
      this.raceReady(replacement);
    });
  }

  private async run<T>(
    operation: string,
    signal: AbortSignal,
    command: () => Promise<T>,
  ): Promise<T> {
    if (signal.aborted) throw abortError(operation);
    if (this.closed) {
      throw new CacheStoreError(
        CACHE_ERROR_CATEGORY.UNAVAILABLE,
        `cache ${operation} failed (runtime closed)`,
      );
    }
    const promise = Promise.resolve().then(command);
    return raceAbort(promise, signal, operation);
  }
}

/** T02 CacheStore adapter over RedisRuntime. */
export class RedisCacheStore implements CacheStore {
  constructor(private readonly runtime: RedisRuntime) {}

  get(key: string, signal: AbortSignal): Promise<string | null> {
    return this.runtime.get(key, signal);
  }

  set(key: string, encodedValue: string, hardTtlMs: number, signal: AbortSignal): Promise<void> {
    return this.runtime.set(key, encodedValue, hardTtlMs, signal);
  }

  setIfAbsent(key: string, token: string, lockTtlMs: number, signal: AbortSignal): Promise<boolean> {
    return this.runtime.setIfAbsent(key, token, lockTtlMs, signal);
  }

  releaseIfOwner(key: string, token: string, signal: AbortSignal): Promise<boolean> {
    return this.runtime.releaseIfOwner(key, token, signal);
  }

  rotateEpoch(key: string, epochTtlMs: number, signal: AbortSignal): Promise<number> {
    return this.runtime.rotateEpoch(key, epochTtlMs, signal);
  }

  health(): Promise<CacheHealthState> {
    return Promise.resolve(this.runtime.health());
  }

  close(): Promise<void> {
    return this.runtime.close();
  }
}

function buildClientOptions(config: RedisCacheConnectionConfig): RedisClientOptions {
  return {
    commandTimeout: config.commandTimeoutMs,
    connectTimeout: config.connectTimeoutMs,
    maxRetriesPerRequest: config.maxRetriesPerRequest,
    enableOfflineQueue: false,
    lazyConnect: true,
    retryStrategy: boundedRetryStrategy,
    // keyPrefix is intentionally absent: T02 key builders already embed
    // config.keyPrefix into every key text (plan §4.1). Setting ioredis's
    // keyPrefix would double-prefix keys and EVAL KEYS.
  };
}

function defaultCreateClient(url: string, options: RedisClientOptions): RedisClientLike {
  // ioredis parses rediss:// into TLS and extracts ACL username/password/db
  // from the URL; timeouts/retries come from the options built from T01 config.
  // The cast is confined to this one ioredis boundary: ioredis's 80+ typed SET
  // overloads are deliberately narrowed to the minimal structural surface that
  // RedisRuntime uses, so no ioredis type leaks into the public facade.
  return new Redis(url, options) as unknown as RedisClientLike;
}

/**
 * Factory (no global singleton): each API/Worker composition owns and closes
 * its own CacheStore (T10/T11). The URL is never parsed or logged here.
 */
export function createRedisCacheStore(
  config: RedisCacheConnectionConfig,
  options: RedisCacheStoreOptions = {},
): CacheStore {
  if (!config.url) {
    throw new Error('createRedisCacheStore requires a REDIS_URL (mode off must not create a client)');
  }
  const createClient = options.createClient ?? defaultCreateClient;
  const clientOptions = buildClientOptions(config);
  const makeClient = (): RedisClientLike => createClient(config.url!, clientOptions);
  const client = makeClient();
  const runtime = new RedisRuntime(client, {
    connectTimeoutMs: config.connectTimeoutMs,
    closeTimeoutMs: options.closeTimeoutMs,
    recreateClient: makeClient,
    recreateDelayMs: options.recreateDelayMs,
  });
  return new RedisCacheStore(runtime);
}
