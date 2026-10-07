/**
 * Shared Redis fixed-window admission loop (EVALSHA + NOSCRIPT reload,
 * command-timeout race, circuit breaker, fail-closed classification).
 *
 * Domain stores stay thin: they supply the key codec, budgets, and purpose
 * prefix. This factory never changes the frozen Lua script or Redis key text.
 */
import {
  RATE_LIMIT_CIRCUIT_DEFAULT_COOLDOWN_MS,
  RATE_LIMIT_CIRCUIT_DEFAULT_FAILURE_THRESHOLD,
  RateLimitCircuitBreaker,
} from './rate-limit-circuit-breaker.js';
import {
  RATE_LIMIT_REDIS_CLOSE_TIMEOUT_MS,
  RateLimitRedisConfigurationError,
  RateLimitRedisUnavailableError,
  createRateLimitRedisRuntime,
  type RateLimitRedisClientFactory,
} from './rate-limit-client.js';
import {
  RATE_LIMIT_LUA_SCRIPT,
  RATE_LIMIT_LUA_SCRIPT_NAME,
  parseRateLimitScriptReply,
} from './rate-limit-lua.js';

export class RateLimitCommandTimeoutError extends Error {
  constructor(operation: string) {
    super(`rate-limit ${operation} command timed out`);
    this.name = 'RateLimitCommandTimeoutError';
  }
}

export class RateLimitMalformedReplyError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = 'RateLimitMalformedReplyError';
    this.code = code;
  }
}

const REPLY_NOSCRIPT_PATTERN = /NOSCRIPT/u;
const REPLY_ACL_DENIED_PATTERN = /(NOAUTH|NOPERM|WRONGPASS|Client sent AUTH|AUTH <password> called)/u;
const REPLY_WRONG_TYPE_PATTERN = /WRONGTYPE/u;
const REPLY_KEY_MALFORMED_PATTERN = /RATE_LIMIT_KEY_MALFORMED/u;
const CONNECTION_FAILURE_PATTERN =
  /(ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EHOSTUNREACH|ECONNRESET|EAI_AGAIN|Connection is closed|Stream isn't writeable|socket closed|offline queue|is not ready)/u;
const COMMAND_TIMED_OUT_PATTERN = /Command timed out/u;

export type RateLimitFailureClass = 'unavailable' | 'timeout' | 'malformed' | 'acl' | 'internal';

export interface ClassifiedRateLimitError {
  readonly class: RateLimitFailureClass;
  readonly code: string;
}

export function classifyRateLimitError(error: unknown): ClassifiedRateLimitError {
  if (error instanceof RateLimitCommandTimeoutError) {
    return { class: 'timeout', code: 'rate_limit_command_timeout' };
  }
  if (error instanceof RateLimitMalformedReplyError) {
    return { class: 'malformed', code: error.code };
  }
  if (error instanceof RateLimitRedisConfigurationError) {
    return { class: 'internal', code: error.code };
  }
  if (error instanceof RateLimitRedisUnavailableError) {
    return { class: 'unavailable', code: 'rate_limit_unavailable' };
  }
  if (error instanceof Error) {
    const name = typeof error.name === 'string' ? error.name : '';
    const message = error.message;
    if (name === 'MaxRetriesPerRequestError') {
      return { class: 'unavailable', code: 'rate_limit_max_retries_exhausted' };
    }
    if (name === 'ReplyError') {
      if (REPLY_NOSCRIPT_PATTERN.test(message)) return { class: 'internal', code: 'rate_limit_noscript' };
      if (REPLY_ACL_DENIED_PATTERN.test(message)) return { class: 'acl', code: 'rate_limit_acl_denied' };
      if (REPLY_KEY_MALFORMED_PATTERN.test(message)) return { class: 'malformed', code: 'rate_limit_key_malformed' };
      if (REPLY_WRONG_TYPE_PATTERN.test(message)) return { class: 'internal', code: 'rate_limit_wrongtype' };
      return { class: 'internal', code: 'rate_limit_redis_error' };
    }
    if (REPLY_NOSCRIPT_PATTERN.test(message)) return { class: 'internal', code: 'rate_limit_noscript' };
    if (COMMAND_TIMED_OUT_PATTERN.test(message)) return { class: 'timeout', code: 'rate_limit_command_timeout' };
    if (CONNECTION_FAILURE_PATTERN.test(message)) return { class: 'unavailable', code: 'rate_limit_unavailable' };
  }
  return { class: 'internal', code: 'rate_limit_internal' };
}

function isNoscriptError(error: unknown): boolean {
  return error instanceof Error && REPLY_NOSCRIPT_PATTERN.test(error.message);
}

export interface RedisFixedWindowDecision {
  readonly allowed: boolean;
  readonly remaining: number;
  readonly retryAfterSeconds: number;
  readonly windowStartEpochMs: number;
}

export type RedisFixedWindowResult =
  | { readonly kind: 'allowed'; readonly decision: RedisFixedWindowDecision }
  | { readonly kind: 'denied'; readonly decision: RedisFixedWindowDecision }
  | { readonly kind: 'failed'; readonly failure: ClassifiedRateLimitError };

export type RedisFixedWindowReadinessReason = 'none' | 'connecting' | 'last_command_failed' | 'closed';

export interface RedisFixedWindowReadiness {
  readonly status: 'healthy' | 'degraded';
  readonly reason: RedisFixedWindowReadinessReason;
  readonly lastCheckedAtEpochMs: number;
}

export interface RedisFixedWindowAdmission {
  readonly key: string;
  readonly rateMax: number;
  readonly windowMs: number;
  readonly script?: string;
  readonly scriptName?: string;
  readonly args?: readonly (string | number)[];
}

export interface RedisFixedWindowStoreOptions {
  readonly redisUrl: string;
  readonly commandTimeoutMs: number;
  readonly connectTimeoutMs: number;
  readonly maxRetriesPerRequest: number;
  readonly createClient?: RateLimitRedisClientFactory;
  readonly now?: () => number;
  readonly failureThreshold?: number;
  readonly cooldownMs?: number;
  readonly closeTimeoutMs?: number;
}

export interface RedisFixedWindowStoreConfig<TSubject> extends RedisFixedWindowStoreOptions {
  readonly resolveAdmission: (subject: TSubject, nowMs: number) => RedisFixedWindowAdmission;
  readonly onFailure?: (subject: TSubject, failure: ClassifiedRateLimitError) => void;
}

export interface RedisFixedWindowStore<TSubject> {
  consume(subject: TSubject): Promise<RedisFixedWindowResult>;
  readiness(): RedisFixedWindowReadiness;
  close(): Promise<void>;
}

export function createRedisFixedWindowStore<TSubject>(
  config: RedisFixedWindowStoreConfig<TSubject>,
): RedisFixedWindowStore<TSubject> {
  const now = config.now ?? (() => Date.now());
  const runtime = createRateLimitRedisRuntime({
    url: config.redisUrl,
    commandTimeoutMs: config.commandTimeoutMs,
    connectTimeoutMs: config.connectTimeoutMs,
    maxRetriesPerRequest: config.maxRetriesPerRequest,
    closeTimeoutMs: config.closeTimeoutMs ?? RATE_LIMIT_REDIS_CLOSE_TIMEOUT_MS,
    ...(config.createClient === undefined ? {} : { createClient: config.createClient }),
  });
  const circuit = new RateLimitCircuitBreaker({
    failureThreshold: config.failureThreshold ?? RATE_LIMIT_CIRCUIT_DEFAULT_FAILURE_THRESHOLD,
    cooldownMs: config.cooldownMs ?? RATE_LIMIT_CIRCUIT_DEFAULT_COOLDOWN_MS,
    clock: now,
  });
  const scriptShas = new Map<string, string>();
  let closed = false;
  let closePromise: Promise<void> | undefined;

  const failed = (failure: ClassifiedRateLimitError): RedisFixedWindowResult =>
    Object.freeze({ kind: 'failed', failure: Object.freeze(failure) });

  const execWithTimeout = <T>(operation: string, command: () => Promise<T>): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new RateLimitCommandTimeoutError(operation)),
        config.commandTimeoutMs,
      );
    });
    return Promise.race([Promise.resolve().then(command), timeoutPromise])
      .finally(() => {
        if (timer !== undefined) clearTimeout(timer);
      });
  };

  const ensureScriptLoaded = async (script: string, scriptName: string, forceReload = false): Promise<string> => {
    if (!forceReload) {
      const cached = scriptShas.get(scriptName);
      if (cached !== undefined) return cached;
    }
    const sha = await execWithTimeout('script_load', () => runtime.scriptLoad(script));
    const shaText = String(sha);
    if (!/^[0-9a-f]{40}$/iu.test(shaText)) {
      throw new RateLimitMalformedReplyError('rate_limit_script_sha_malformed');
    }
    scriptShas.set(scriptName, shaText);
    return shaText;
  };

  const runAdmission = async (admission: RedisFixedWindowAdmission): Promise<unknown> => {
    const script = admission.script ?? RATE_LIMIT_LUA_SCRIPT;
    const scriptName = admission.scriptName ?? RATE_LIMIT_LUA_SCRIPT_NAME;
    const args = admission.args ?? [admission.rateMax, admission.windowMs];
    const sha = await ensureScriptLoaded(script, scriptName);
    try {
      return await execWithTimeout('evalsha', () => runtime.evalsha(sha, 1, admission.key, ...args));
    } catch (error) {
      if (!isNoscriptError(error)) throw error;
      const reloaded = await ensureScriptLoaded(script, scriptName, true);
      return await execWithTimeout('evalsha', () => runtime.evalsha(reloaded, 1, admission.key, ...args));
    }
  };

  return {
    async consume(subject) {
      if (closed) return failed({ class: 'unavailable', code: 'rate_limit_store_closed' });
      if (!circuit.allowRequest()) return failed({ class: 'unavailable', code: 'rate_limit_circuit_open' });

      let admission: RedisFixedWindowAdmission;
      try {
        admission = config.resolveAdmission(subject, now());
      } catch {
        return failed({ class: 'internal', code: 'rate_limit_invalid_input' });
      }

      try {
        const reply = await runAdmission(admission);
        const parsed = parseRateLimitScriptReply(reply, admission.rateMax, admission.windowMs);
        if (parsed.kind !== 'ok') {
          circuit.recordFailure();
          return failed({ class: 'malformed', code: 'rate_limit_malformed_reply' });
        }
        circuit.recordSuccess();
        const decision = Object.freeze({
          allowed: parsed.reply.allowed,
          remaining: parsed.reply.remaining,
          retryAfterSeconds: parsed.reply.retryAfterSeconds,
          windowStartEpochMs: parsed.reply.windowStartEpochMs,
        });
        return parsed.reply.allowed
          ? Object.freeze({ kind: 'allowed', decision })
          : Object.freeze({ kind: 'denied', decision });
      } catch (error) {
        const classified = classifyRateLimitError(error);
        circuit.recordFailure();
        config.onFailure?.(subject, classified);
        return failed(classified);
      }
    },
    readiness() {
      const lastCheckedAtEpochMs = now();
      if (closed) {
        return Object.freeze({ status: 'degraded', reason: 'closed', lastCheckedAtEpochMs });
      }
      if (circuit.currentState !== 'closed') {
        return Object.freeze({ status: 'degraded', reason: 'last_command_failed', lastCheckedAtEpochMs });
      }
      if (runtime.health() !== 'healthy') {
        return Object.freeze({ status: 'degraded', reason: 'connecting', lastCheckedAtEpochMs });
      }
      return Object.freeze({ status: 'healthy', reason: 'none', lastCheckedAtEpochMs });
    },
    close() {
      closePromise ??= (async () => {
        closed = true;
        await runtime.close();
      })();
      return closePromise;
    },
  };
}

export function mapFrozenQuotaOutcome<TDecision>(
  result: RedisFixedWindowResult,
  toDecision: (decision: RedisFixedWindowDecision) => TDecision,
):
  | { readonly kind: 'allowed'; readonly decision: TDecision }
  | { readonly kind: 'denied'; readonly decision: TDecision }
  | { readonly kind: 'failed'; readonly failure: ClassifiedRateLimitError } {
  if (result.kind === 'failed') return result;
  const decision = toDecision(result.decision);
  return result.kind === 'allowed'
    ? Object.freeze({ kind: 'allowed', decision })
    : Object.freeze({ kind: 'denied', decision });
}
