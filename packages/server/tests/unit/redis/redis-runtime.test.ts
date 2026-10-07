import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { afterEach, describe, test, vi } from 'vitest';
import {
  CACHE_ERROR_CATEGORY,
  CacheAbortError,
  CacheStoreError,
  REDIS_CLIENT_RECREATE_DELAY_MS,
  REDIS_CLOSE_TIMEOUT_MS,
  REDIS_MAX_RECONNECT_ATTEMPTS,
  REDIS_RECONNECT_BASE_DELAY_MS,
  REDIS_RECONNECT_MAX_DELAY_MS,
  REDIS_RELEASE_SCRIPT,
  REDIS_ROTATE_EPOCH_SCRIPT,
  createRedisCacheStore,
  type CacheStore,
  type RedisCacheConnectionConfig,
  type RedisClientLike,
  type RedisClientOptions,
} from '../../../src/infrastructure/cache/index.js';

/**
 * T03 unit tests (plan §6.4/§7.2): RedisRuntime/RedisCacheStore against a
 * scripted fake client. No real Redis, no network, no vitest timers except
 * fake timers for the ready/close timeout paths. The fake records every
 * command, its arguments and call counts, and is deliberately stricter than a
 * real Redis client about the adapter's command shapes (SET must carry PX;
 * release/rotate must go through EVAL) so a regression to GET+DEL or a plain
 * SET cannot pass these tests.
 */

const DATA_KEY = 'known:production:cache:v1:{pub:collection-1}:metadata:0:abc';
const EPOCH_KEY = 'known:production:cache:v1:{pub:collection-1}:pubid:epoch';
const LOCK_KEY = `${DATA_KEY}:lock`;

const DEFAULT_CONFIG: RedisCacheConnectionConfig = {
  url: 'redis://cache-user:secret@127.0.0.1:6379/0',
  commandTimeoutMs: 75,
  connectTimeoutMs: 1_000,
  maxRetriesPerRequest: 1,
  keyPrefix: 'known',
};

function signal(): AbortSignal {
  return new AbortController().signal;
}

function cacheUnavailable(error: unknown): boolean {
  return error instanceof CacheStoreError && error.category === CACHE_ERROR_CATEGORY.UNAVAILABLE;
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

interface FakeOverrides {
  readonly connect?: () => Promise<void>;
  readonly quit?: () => Promise<'OK'>;
  readonly get?: (key: string) => Promise<string | null>;
  readonly set?: (key: string, value: string, ...args: (string | number)[]) => Promise<unknown>;
  readonly eval?: (script: string, numkeys: number, ...args: (string | number)[]) => Promise<unknown>;
  readonly status?: string;
  readonly closeTimeoutMs?: number;
}

interface RecordedCall {
  readonly method: string;
  readonly args: readonly unknown[];
}

function assertSetArgs(args: readonly (string | number)[]): void {
  const pxIndex = args.indexOf('PX');
  if (pxIndex < 0) {
    throw new Error('fake: SET must include PX <ms>');
  }
  const px = args[pxIndex + 1];
  if (typeof px !== 'number' || !Number.isSafeInteger(px) || px <= 0) {
    throw new Error('fake: SET PX must be a positive integer');
  }
  if (args.includes('NX') && pxIndex >= args.length - 2) {
    throw new Error('fake: SET NX must be accompanied by PX <ms>');
  }
}

/**
 * Scripted ioredis stand-in. Implements RedisClientLike (the structural subset
 * RedisRuntime needs) and additionally records every call and simulates real
 * Redis semantics for the commands the adapter is allowed to send: SET NX PX
 * returns null when the key already exists, EVAL for releaseIfOwner compares
 * the token before deleting, and EVAL for rotateEpoch INCRs + PEXPIREs.
 */
class ScriptedRedisClient extends EventEmitter implements RedisClientLike {
  status = 'wait';
  readonly url: string;
  readonly options: RedisClientOptions;
  readonly calls: RecordedCall[] = [];
  connectCalls = 0;
  disconnectCalls = 0;
  quitCalls = 0;
  removeAllListenersCalls = 0;

  connectImpl: () => Promise<void>;
  quitImpl: () => Promise<'OK'>;
  getImpl: (key: string) => Promise<string | null>;
  setImpl: (key: string, value: string, ...args: (string | number)[]) => Promise<unknown>;
  evalImpl: (script: string, numkeys: number, ...args: (string | number)[]) => Promise<unknown>;

  private readonly store = new Map<string, string>();
  private readonly expiries = new Map<string, number>();

  constructor(url: string, options: RedisClientOptions, overrides: FakeOverrides = {}) {
    super();
    this.url = url;
    this.options = options;
    if (overrides.status !== undefined) this.status = overrides.status;
    this.connectImpl = overrides.connect
      ?? (async () => {
        this.status = 'ready';
        this.emit('ready');
      });
    this.quitImpl = overrides.quit ?? (async () => 'OK' as const);
    this.getImpl = overrides.get ?? (async (key: string) => this.store.get(key) ?? null);
    this.setImpl = overrides.set
      ?? (async (key: string, value: string, ...args: (string | number)[]) => {
        assertSetArgs(args);
        const hasNx = args.includes('NX');
        if (hasNx && this.store.has(key)) return null;
        const pxIndex = args.indexOf('PX');
        const px = args[pxIndex + 1] as number;
        this.store.set(key, value);
        this.expiries.set(key, px);
        return 'OK';
      });
    this.evalImpl = overrides.eval
      ?? (async (script: string, _numkeys: number, ...args: (string | number)[]) => {
        if (script === REDIS_RELEASE_SCRIPT) {
          const key = String(args[0]);
          const token = String(args[1]);
          if (this.store.get(key) === token) {
            this.store.delete(key);
            return 1;
          }
          return 0;
        }
        if (script === REDIS_ROTATE_EPOCH_SCRIPT) {
          const key = String(args[0]);
          const ttlMs = Number(args[1]);
          const next = (Number(this.store.get(key) ?? '0') || 0) + 1;
          this.store.set(key, String(next));
          this.expiries.set(key, ttlMs);
          return next;
        }
        throw new Error(`fake: unexpected eval script ${script.slice(0, 40)}`);
      });
  }

  connect(): Promise<void> {
    this.connectCalls += 1;
    this.record('connect', []);
    return this.connectImpl();
  }

  disconnect(): void {
    this.disconnectCalls += 1;
    this.record('disconnect', []);
  }

  quit(): Promise<'OK'> {
    this.quitCalls += 1;
    this.record('quit', []);
    return this.quitImpl();
  }

  removeAllListeners(): this {
    this.removeAllListenersCalls += 1;
    return super.removeAllListeners();
  }

  get(key: string): Promise<string | null> {
    this.record('get', [key]);
    return this.getImpl(key);
  }

  set(key: string, value: string, ...args: (string | number)[]): Promise<unknown> {
    this.record('set', [key, value, ...args]);
    return this.setImpl(key, value, ...args);
  }

  eval(script: string, numkeys: number, ...args: (string | number)[]): Promise<unknown> {
    this.record('eval', [script, numkeys, ...args]);
    return this.evalImpl(script, numkeys, ...args);
  }

  private record(method: string, args: readonly unknown[]): void {
    this.calls.push({ method, args });
  }
}

function callsOf(fake: ScriptedRedisClient, method: string): RecordedCall[] {
  return fake.calls.filter((call) => call.method === method);
}

function makeStore(
  config: RedisCacheConnectionConfig,
  overrides: FakeOverrides = {},
): { readonly store: CacheStore; readonly fake: ScriptedRedisClient } {
  let fake: ScriptedRedisClient | undefined;
  const store = createRedisCacheStore(config, {
    closeTimeoutMs: overrides.closeTimeoutMs,
    createClient: (url, options) => {
      fake = new ScriptedRedisClient(url, options, overrides);
      return fake;
    },
  });
  assert.ok(fake, 'createClient must have been invoked');
  return { store, fake };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('RedisRuntime connection lifecycle', () => {
  test('connect success transitions health to healthy and options come straight from config', async () => {
    const { store, fake } = makeStore(DEFAULT_CONFIG);
    await flush();
    assert.equal(await store.health(), 'healthy');
    assert.equal(fake.connectCalls, 1);
    assert.equal(fake.options.commandTimeout, DEFAULT_CONFIG.commandTimeoutMs);
    assert.equal(fake.options.connectTimeout, DEFAULT_CONFIG.connectTimeoutMs);
    assert.equal(fake.options.maxRetriesPerRequest, DEFAULT_CONFIG.maxRetriesPerRequest);
    assert.equal(fake.options.enableOfflineQueue, false);
    assert.equal(fake.options.lazyConnect, true);
    // T02 key builders already embed keyPrefix in the key text: ioredis
    // keyPrefix must NOT be set or every key (and EVAL key) is double-prefixed.
    assert.equal(fake.options.keyPrefix, undefined);
    await store.close();
  });

  test('connection failure degrades health and commands fail fast without retrying', async () => {
    const { store, fake } = makeStore(DEFAULT_CONFIG, {
      connect: async () => {
        throw new Error('connect ECONNREFUSED 127.0.0.1:6379');
      },
      get: async () => {
        throw new Error("Stream isn't writeable and enableOfflineQueue options is false");
      },
    });
    await flush();
    assert.equal(await store.health(), 'degraded');
    await assert.rejects(store.get(DATA_KEY, signal()), cacheUnavailable);
    // exactly one attempt: no command retry/backlog loop
    assert.equal(callsOf(fake, 'get').length, 1);
    await store.close();
  });

  test('ready timeout degrades health within the connect budget and never leaks', async () => {
    vi.useFakeTimers();
    const { store } = makeStore(
      { ...DEFAULT_CONFIG, connectTimeoutMs: 100 },
      { connect: () => new Promise<void>(() => {}) },
    );
    assert.equal(await store.health(), 'degraded');
    await vi.advanceTimersByTimeAsync(100);
    assert.equal(await store.health(), 'degraded');
    await store.close();
  });

  test('command timeout is classified as cache_unavailable and the option is wired from config', async () => {
    const { store, fake } = makeStore(DEFAULT_CONFIG, {
      get: async () => {
        throw new Error('Command timed out');
      },
    });
    await assert.rejects(store.get(DATA_KEY, signal()), cacheUnavailable);
    assert.equal(fake.options.commandTimeout, DEFAULT_CONFIG.commandTimeoutMs);
    await store.close();
  });

  test('connection events only update health and never throw uncaught errors', async () => {
    const { store, fake } = makeStore(DEFAULT_CONFIG, {
      connect: () => new Promise<void>(() => {}),
    });
    assert.ok(fake.listenerCount('error') >= 1, 'an error listener must be attached');
    assert.ok(fake.listenerCount('ready') >= 1);

    fake.emit('error', new Error('boom'));
    assert.equal(await store.health(), 'degraded');
    fake.emit('reconnecting');
    assert.equal(await store.health(), 'degraded');
    fake.emit('ready');
    assert.equal(await store.health(), 'healthy');
    fake.emit('end');
    assert.equal(await store.health(), 'degraded');
    fake.emit('error', new Error('after end'));
    assert.equal(await store.health(), 'degraded');
    await store.close();
  });

  test('disconnect cannot grow an unbounded retry or command backlog', async () => {
    const { store, fake } = makeStore(DEFAULT_CONFIG);

    // bounded reconnect strategy: geometric backoff capped, then stops
    const strategy = fake.options.retryStrategy;
    assert.equal(strategy(1), REDIS_RECONNECT_BASE_DELAY_MS);
    assert.equal(strategy(2), REDIS_RECONNECT_BASE_DELAY_MS * 2);
    assert.equal(strategy(6), REDIS_RECONNECT_MAX_DELAY_MS);
    assert.equal(strategy(REDIS_MAX_RECONNECT_ATTEMPTS), REDIS_RECONNECT_MAX_DELAY_MS);
    assert.equal(strategy(REDIS_MAX_RECONNECT_ATTEMPTS + 1), null);

    // offline queue is off and per-request retries are bounded by config
    assert.equal(fake.options.enableOfflineQueue, false);
    assert.equal(fake.options.maxRetriesPerRequest, DEFAULT_CONFIG.maxRetriesPerRequest);

    // a command while disconnected fails fast with exactly one attempt
    fake.status = 'end';
    fake.getImpl = async () => {
      throw new Error("Stream isn't writeable and enableOfflineQueue options is false");
    };
    await assert.rejects(store.get(DATA_KEY, signal()), cacheUnavailable);
    assert.equal(callsOf(fake, 'get').length, 1);
    assert.equal(callsOf(fake, 'connect').length, 1, 'commands must not trigger reconnects');
    await store.close();
  });

  test('recreates a terminal client after the complete reconnect budget and recovers', async () => {
    vi.useFakeTimers();
    const clients: ScriptedRedisClient[] = [];
    const store = createRedisCacheStore(DEFAULT_CONFIG, {
      createClient: (url, options) => {
        const client = new ScriptedRedisClient(url, options);
        clients.push(client);
        return client;
      },
    });
    await vi.advanceTimersByTimeAsync(0);

    const initial = clients[0];
    assert.ok(initial);
    const retryBudgetMs = Array.from(
      { length: REDIS_MAX_RECONNECT_ATTEMPTS },
      (_unused, index) => initial.options.retryStrategy(index + 1) ?? 0,
    ).reduce((total, delayMs) => total + delayMs, 0);
    assert.ok(retryBudgetMs > 13_000, 'the simulated outage must exceed the old ~13s budget');
    assert.equal(initial.options.retryStrategy(REDIS_MAX_RECONNECT_ATTEMPTS + 1), null);

    initial.status = 'end';
    initial.emit('end');
    assert.equal(await store.health(), 'degraded');
    assert.equal(clients.length, 1);

    await vi.advanceTimersByTimeAsync(REDIS_CLIENT_RECREATE_DELAY_MS);
    await flush();
    assert.equal(clients.length, 2, 'terminal ioredis instance must be replaced');
    assert.equal(initial.disconnectCalls, 1);
    assert.equal(initial.removeAllListenersCalls, 1);
    assert.equal(await store.health(), 'healthy');

    await store.set(DATA_KEY, 'after-failover', 30_000, signal());
    assert.equal(callsOf(initial, 'set').length, 0);
    assert.equal(callsOf(clients[1]!, 'set').length, 1);
    await store.close();
    assert.equal(vi.getTimerCount(), 0);
  });
});

describe('RedisCacheStore commands', () => {
  test('set stores with PX ttl and get returns the value or null on miss', async () => {
    const { store, fake } = makeStore(DEFAULT_CONFIG);
    await store.set(DATA_KEY, 'encoded-envelope', 30_000, signal());
    assert.deepEqual(callsOf(fake, 'set')[0].args, [DATA_KEY, 'encoded-envelope', 'PX', 30_000]);
    assert.equal(await store.get(DATA_KEY, signal()), 'encoded-envelope');
    assert.equal(await store.get(`${DATA_KEY}:missing`, signal()), null);
    await store.close();
  });

  test('setIfAbsent returns real acquire/not-acquire with SET NX PX', async () => {
    const { store, fake } = makeStore(DEFAULT_CONFIG);
    assert.equal(await store.setIfAbsent(LOCK_KEY, 'owner-token', 1_500, signal()), true);

    const setCall = callsOf(fake, 'set')[0];
    assert.deepEqual(setCall.args.slice(0, 2), [LOCK_KEY, 'owner-token']);
    const options = setCall.args.slice(2);
    assert.ok(options.includes('NX'), 'lock set must carry NX');
    assert.ok(options.includes('PX'), 'lock set must carry PX');
    assert.ok(options.includes(1_500), 'lock set must carry the lock TTL');

    // NX semantics: an existing key is not acquired again
    assert.equal(await store.setIfAbsent(LOCK_KEY, 'other-token', 1_500, signal()), false);
    assert.equal(callsOf(fake, 'set').length, 2);
    await store.close();
  });

  test('releaseIfOwner deletes only for the matching token and goes through EVAL, never GET+DEL', async () => {
    const { store, fake } = makeStore(DEFAULT_CONFIG);
    assert.equal(await store.setIfAbsent(LOCK_KEY, 'owner-token', 1_500, signal()), true);

    const evalBefore = callsOf(fake, 'eval').length;
    const getBefore = callsOf(fake, 'get').length;

    // wrong token: Lua compares and returns 0, lock stays
    assert.equal(await store.releaseIfOwner(LOCK_KEY, 'wrong-token', signal()), false);
    assert.equal(callsOf(fake, 'eval').length, evalBefore + 1);
    assert.equal(callsOf(fake, 'get').length, getBefore, 'release must not GET on the client side');
    assert.equal(callsOf(fake, 'eval')[evalBefore].args[0], REDIS_RELEASE_SCRIPT);
    assert.deepEqual(callsOf(fake, 'eval')[evalBefore].args.slice(1), [1, LOCK_KEY, 'wrong-token']);

    // correct token: Lua deletes and returns 1
    assert.equal(await store.releaseIfOwner(LOCK_KEY, 'owner-token', signal()), true);
    assert.equal(callsOf(fake, 'eval').length, evalBefore + 2);
    assert.equal(callsOf(fake, 'get').length, getBefore);

    // releasing again (no lock) reports false
    assert.equal(await store.releaseIfOwner(LOCK_KEY, 'owner-token', signal()), false);
    assert.equal(await store.get(LOCK_KEY, signal()), null);
    await store.close();
  });

  test('rotateEpoch atomically increments and refreshes TTL through EVAL and returns monotonic values', async () => {
    const { store, fake } = makeStore(DEFAULT_CONFIG);
    assert.equal(await store.rotateEpoch(EPOCH_KEY, 30_000, signal()), 1);
    assert.equal(await store.rotateEpoch(EPOCH_KEY, 30_000, signal()), 2);
    assert.equal(await store.rotateEpoch(EPOCH_KEY, 30_000, signal()), 3);

    const evalCalls = callsOf(fake, 'eval');
    assert.equal(evalCalls.length, 3);
    assert.equal(evalCalls[0].args[0], REDIS_ROTATE_EPOCH_SCRIPT);
    assert.deepEqual(evalCalls[0].args.slice(1), [1, EPOCH_KEY, 30_000]);
    // no direct SET/GET as a stand-in for INCR/PEXPIRE on the client side
    assert.equal(callsOf(fake, 'set').length, 0);
    assert.equal(callsOf(fake, 'get').length, 0);
    await store.close();
  });

  test('rotateEpoch rejects a non-positive reply as cache_unavailable', async () => {
    const { store } = makeStore(DEFAULT_CONFIG, { eval: async () => 0 });
    await assert.rejects(store.rotateEpoch(EPOCH_KEY, 1_000, signal()), cacheUnavailable);
    await store.close();
  });

  test('a scripted SET without PX is rejected by the fake (strictness guard)', async () => {
    const fake = new ScriptedRedisClient(DEFAULT_CONFIG.url!, {
      commandTimeout: DEFAULT_CONFIG.commandTimeoutMs,
      connectTimeout: DEFAULT_CONFIG.connectTimeoutMs,
      maxRetriesPerRequest: DEFAULT_CONFIG.maxRetriesPerRequest,
      enableOfflineQueue: false,
      lazyConnect: true,
      retryStrategy: () => null,
    });
    await assert.rejects(
      fake.set(DATA_KEY, 'value'),
      (error) => error instanceof Error && /SET must include PX/.test(error.message),
    );
  });
});

describe('signal abort', () => {
  test('a pre-aborted signal fails fast with CacheAbortError without dispatching any command', async () => {
    const { store, fake } = makeStore(DEFAULT_CONFIG);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      store.get(DATA_KEY, controller.signal),
      (error) => error instanceof CacheAbortError && !(error instanceof CacheStoreError),
    );
    assert.equal(callsOf(fake, 'get').length, 0);
    await store.close();
  });

  test('aborting an in-flight command rejects fast with CacheAbortError, never cache_unavailable', async () => {
    const { store, fake } = makeStore(DEFAULT_CONFIG, {
      get: () => new Promise<string | null>(() => {}),
    });
    const controller = new AbortController();
    const pending = store.get(DATA_KEY, controller.signal);
    controller.abort();
    await assert.rejects(
      pending,
      (error) => error instanceof CacheAbortError && !(error instanceof CacheStoreError),
    );
    assert.equal(callsOf(fake, 'get').length, 1);
    await store.close();
  });
});

describe('close lifecycle', () => {
  test('close is bounded, idempotent and leaves no sockets or timers behind', async () => {
    vi.useFakeTimers();
    const { store, fake } = makeStore(
      { ...DEFAULT_CONFIG, connectTimeoutMs: 10_000 },
      {
        connect: () => new Promise<void>(() => {}),
        quit: () => new Promise<'OK'>(() => {}),
        closeTimeoutMs: 50,
      },
    );
    await vi.advanceTimersByTimeAsync(0);

    const closing = store.close();
    await flush(); // quit() is scheduled on the microtask queue inside close()'s async body
    assert.equal(fake.quitCalls, 1, 'close must attempt a graceful quit');
    await vi.advanceTimersByTimeAsync(50);
    await closing;

    assert.equal(fake.disconnectCalls, 1, 'close must force-disconnect when quit hangs');
    assert.equal(fake.removeAllListenersCalls, 1, 'close must drop listeners');

    // second close is a no-op
    await store.close();
    assert.equal(fake.quitCalls, 1);
    assert.equal(fake.disconnectCalls, 1);

    // no sockets/timers remain
    assert.equal(vi.getTimerCount(), 0);

    // commands after close fail fast without dispatching
    await assert.rejects(store.get(DATA_KEY, signal()), cacheUnavailable);
    assert.equal(callsOf(fake, 'get').length, 0);
    assert.equal(await store.health(), 'degraded');
  });

  test('close resolves immediately when quit succeeds', async () => {
    const { store, fake } = makeStore(DEFAULT_CONFIG);
    await store.close();
    await store.close();
    assert.equal(fake.quitCalls, 1);
    assert.equal(fake.disconnectCalls, 1);
    assert.equal(fake.removeAllListenersCalls, 1);
    assert.equal(await store.health(), 'degraded');
  });
});

describe('factory', () => {
  test('factory rejects a missing URL instead of creating a client', () => {
    assert.throws(
      () => createRedisCacheStore({ ...DEFAULT_CONFIG, url: null }),
      (error) => error instanceof Error && /REDIS_URL/.test(error.message),
    );
  });

  test('factory hands the raw URL to the client seam so ioredis can enable TLS/ACL', async () => {
    let seenUrl: string | undefined;
    let seenOptions: RedisClientOptions | undefined;
    const store = createRedisCacheStore(
      { ...DEFAULT_CONFIG, url: 'rediss://cache-user:secret@redis.example:6379/2' },
      {
        createClient: (url, options) => {
          seenUrl = url;
          seenOptions = options;
          return new ScriptedRedisClient(url, options);
        },
      },
    );
    assert.equal(seenUrl, 'rediss://cache-user:secret@redis.example:6379/2');
    assert.ok(seenOptions);
    assert.equal(seenOptions.lazyConnect, true);
    await store.close();
  });

  test('REDIS_CLOSE_TIMEOUT_MS is a sane bounded default', () => {
    assert.ok(REDIS_CLOSE_TIMEOUT_MS > 0);
    assert.ok(REDIS_CLOSE_TIMEOUT_MS <= 5_000);
  });
});
