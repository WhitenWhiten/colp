/**
 * FIX-M-018 unified MCP rate-limit port + Redis configuration.
 *
 * Thin configuration over `createRedisFixedWindowStore`: public port types,
 * policy budgets, commit-port adapters, and the MCP key codec. The in-memory
 * adapter lives in `mcp-rate-limit-memory.ts`. Keys stay on the MCP codec
 * (`{mcp:<factsHmac>}` hash tag) and never share a prefix with auth/search
 * or Attachment. Denied quota and failed Redis outcomes stay distinct; the
 * commit wrapper maps FAILED to a denial so commits stop during an outage.
 */
import type {
  McpAuthenticatedAuthorizationBinding,
  McpChangePlanRateLimitPort,
} from '@know-n/colp/mcp';
import { PHASE4B_MCP_CONFIG_RATE_LIMIT_MAX } from '../../modules/mcp/index.js';
import {
  MCP_RATE_LIMIT_POLICIES,
  assertMcpRateLimitDistinctElement,
  assertMcpRateLimitFacts,
  buildMcpRateLimitKey,
  mcpRateLimitBindingFacts,
  type McpRateLimitPolicyName,
} from './mcp-rate-limit-key-codec.js';
import type { RateLimitRedisClientFactory } from './rate-limit-client.js';
import {
  RATE_LIMIT_DISTINCT_LUA_SCRIPT,
  RATE_LIMIT_DISTINCT_LUA_SCRIPT_NAME,
} from './rate-limit-lua.js';
import {
  createRedisFixedWindowStore,
  mapFrozenQuotaOutcome,
} from './redis-fixed-window-store.js';

// ---------------------------------------------------------------------------
// Unified port (sealed types; transport/composition layers consume only this)
// ---------------------------------------------------------------------------

/** The MCP admission subject: sealed policy + canonical stable facts. */
export interface McpRateLimitSubject {
  readonly policy: McpRateLimitPolicyName;
  /**
   * Canonical stable principal/client/binding facts (bounded, no control
   * characters). Never request-local values; HMAC'd into the key.
   */
  readonly facts: string;
  /**
   * Distinct element for the `commit-distinct-plan` policy (the planId). It
   * is a Redis SET member, never part of the key text.
   */
  readonly distinct?: string;
}

/** The MCP quota decision (quota facts only; never a failure). */
export interface McpRateLimitDecision {
  readonly allowed: boolean;
  /** Ceil to the window rollover (seconds); 0 at rollover. */
  readonly retryAfterSeconds: number;
}

/** Stable infrastructure failure classes (same sealed taxonomy as RL03/auth). */
export type McpRateLimitFailureClass = 'unavailable' | 'timeout' | 'malformed' | 'acl' | 'internal';

export interface McpRateLimitFailure {
  readonly class: McpRateLimitFailureClass;
  readonly code: string;
}

export type McpRateLimitOutcome =
  | { readonly kind: 'allowed'; readonly decision: McpRateLimitDecision }
  | { readonly kind: 'denied'; readonly decision: McpRateLimitDecision }
  | { readonly kind: 'failed'; readonly failure: McpRateLimitFailure };

export type McpRateLimitReadinessStatus = 'healthy' | 'degraded';
export type McpRateLimitReadinessReason = 'none' | 'connecting' | 'last_command_failed' | 'closed';

export interface McpRateLimitReadiness {
  readonly status: McpRateLimitReadinessStatus;
  readonly reason: McpRateLimitReadinessReason;
  readonly lastCheckedAtEpochMs: number;
}

/**
 * The unified MCP rate-limit port. The in-memory adapter (transports/tests
 * and single-instance deployments) and the Redis adapter (below) both
 * implement it; production multi-replica compositions MUST inject a shared
 * adapter (config gate + composition guard).
 */
export interface McpRateLimiter {
  consume(subject: McpRateLimitSubject): Promise<McpRateLimitOutcome>;
  readiness(): McpRateLimitReadiness;
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Budget contracts (shared by both adapters; validated fail-closed)
// ---------------------------------------------------------------------------

export interface McpRateLimitPolicyConfig {
  /** Allowed attempts per fixed window (request / approval policies). */
  readonly maxRequests: number;
  /** Fixed window length in ms. */
  readonly windowMs: number;
}

export interface McpRateLimitCommitConfig {
  /** Maximum DISTINCT Plans that may reach Commit per binding within one window. */
  readonly maxPlans: number;
  /** Fixed window length in ms. */
  readonly windowMs: number;
}

function assertMcpPolicyBudget(
  policy: string,
  valueKey: string,
  maxValue: number,
  windowMs: number,
  maxLimit: number,
): void {
  if (!Number.isSafeInteger(maxValue) || maxValue < 1) {
    throw new Error(`MCP ${policy} ${valueKey} must be a positive safe integer`);
  }
  if (maxValue > maxLimit) {
    throw new Error(`MCP ${policy} ${valueKey} must be <= ${maxLimit}`);
  }
  if (!Number.isSafeInteger(windowMs) || windowMs < 1) {
    throw new Error(`MCP ${policy} windowMs must be a positive safe integer`);
  }
  if (windowMs > PHASE4B_MCP_CONFIG_RATE_LIMIT_MAX.windowMs) {
    throw new Error(`MCP ${policy} windowMs must be <= ${PHASE4B_MCP_CONFIG_RATE_LIMIT_MAX.windowMs}`);
  }
}

export function assertMcpRateLimitPolicyConfig(policy: string, config: McpRateLimitPolicyConfig): void {
  assertMcpPolicyBudget(policy, 'maxRequests', config.maxRequests, config.windowMs, PHASE4B_MCP_CONFIG_RATE_LIMIT_MAX.maxRequests);
}

export function assertMcpRateLimitCommitConfig(config: McpRateLimitCommitConfig): void {
  assertMcpPolicyBudget('commit', 'maxPlans', config.maxPlans, config.windowMs, PHASE4B_MCP_CONFIG_RATE_LIMIT_MAX.maxPlans);
}

// ---------------------------------------------------------------------------
// Protocol commit port (memory, single-process; kept for tests and legacy use)
// ---------------------------------------------------------------------------

export interface McpChangePlanRateLimitOptions {
  /** Maximum distinct Plans that may reach Commit per binding within one window. */
  readonly maxPlans: number;
  /** Fixed-window duration in milliseconds. */
  readonly windowMs: number;
  /** Injectable clock for deterministic tests; defaults to Date.now. */
  readonly now?: () => number;
}

/**
 * Single-process MCP-W10 commit rate/cost port. A MRTR retry for the same
 * Plan does not consume another distinct Plan slot; the map is process-local,
 * so multi-replica deployments must replace this port with the shared
 * adapter (`createMcpChangePlanCommitPort` over the Redis store).
 */
export function createMcpChangePlanRateLimitPort(
  options: McpChangePlanRateLimitOptions,
): McpChangePlanRateLimitPort {
  if (!Number.isSafeInteger(options.maxPlans) || options.maxPlans < 1) {
    throw new Error('MCP-W10 commit maxPlans must be a positive safe integer');
  }
  if (options.maxPlans > PHASE4B_MCP_CONFIG_RATE_LIMIT_MAX.maxPlans) {
    throw new Error(`MCP-W10 commit maxPlans must be <= ${PHASE4B_MCP_CONFIG_RATE_LIMIT_MAX.maxPlans}`);
  }
  if (!Number.isSafeInteger(options.windowMs) || options.windowMs < 1) {
    throw new Error('MCP-W10 commit windowMs must be a positive safe integer');
  }
  if (options.windowMs > PHASE4B_MCP_CONFIG_RATE_LIMIT_MAX.windowMs) {
    throw new Error(`MCP-W10 commit windowMs must be <= ${PHASE4B_MCP_CONFIG_RATE_LIMIT_MAX.windowMs}`);
  }
  if (options.now !== undefined && typeof options.now !== 'function') {
    throw new TypeError('MCP-W10 commit now must be a function when provided');
  }
  const now = options.now ?? Date.now;
  const buckets = new Map<string, { readonly resetAt: number; readonly planIds: Set<string> }>();

  return Object.freeze({
    async allow(input: Readonly<{ planId: string; binding: McpAuthenticatedAuthorizationBinding }>) {
      const nowMs = now();
      const key = mcpRateLimitBindingFacts(input.binding);
      let bucket = buckets.get(key);
      if (bucket === undefined || nowMs >= bucket.resetAt) {
        bucket = { resetAt: nowMs + options.windowMs, planIds: new Set() };
        buckets.set(key, bucket);
      }
      if (bucket.planIds.has(input.planId)) return true;
      if (bucket.planIds.size >= options.maxPlans) return false;
      bucket.planIds.add(input.planId);
      return true;
    },
  });
}

/**
 * FIX-M-018 adapter from the unified port to the protocol
 * `McpChangePlanRateLimitPort`: the commit-distinct-plan policy consumes one
 * slot per DISTINCT planId per binding facts; a FAILED outcome is a denial
 * (fail closed — commits stop during a Redis outage) and never an allow.
 */
export function createMcpChangePlanCommitPort(limiter: McpRateLimiter): McpChangePlanRateLimitPort {
  if (limiter === undefined || typeof limiter.consume !== 'function') {
    throw new TypeError('MCP-W10 commit port requires an explicit McpRateLimiter');
  }
  return Object.freeze({
    async allow(input: Readonly<{ planId: string; binding: McpAuthenticatedAuthorizationBinding }>): Promise<boolean> {
      const outcome = await limiter.consume({
        policy: 'commit-distinct-plan',
        facts: mcpRateLimitBindingFacts(input.binding),
        distinct: input.planId,
      });
      return outcome.kind === 'allowed';
    },
  });
}

// ---------------------------------------------------------------------------
// Redis adapter
// ---------------------------------------------------------------------------

export interface RedisMcpRateLimitStoreOptions {
  /** redis:// or rediss:// endpoint (validated by config, fail-closed). */
  readonly redisUrl: string;
  /** Key codec environment token (nodeEnv); 1-64 chars, no colon. */
  readonly environment: string;
  /** Resolved HMAC secret bytes (never logged, never serialized). */
  readonly keySecret: Buffer;
  /** Redis key namespace prefix (mcp codec); default 'known'. */
  readonly keyPrefix?: string;
  /** Request policy budget (per principal/client/binding facts). */
  readonly request: McpRateLimitPolicyConfig;
  /** Approval policy budget (per principal × sealed route family). */
  readonly approval: McpRateLimitPolicyConfig;
  /** Commit distinct-plan policy budget (per binding). */
  readonly commit: McpRateLimitCommitConfig;
  /** Per-command timeout (ms); bounded. */
  readonly commandTimeoutMs: number;
  /** Connect timeout (ms); bounded. */
  readonly connectTimeoutMs: number;
  /** Bounded retries per request. */
  readonly maxRetriesPerRequest: number;
  /** Test seam: replace the real ioredis client with a scripted fake. */
  readonly createClient?: RateLimitRedisClientFactory;
  /**
   * Injectable host clock; used ONLY as the codec window seed and readiness
   * timestamps — the authoritative window identity comes from Redis server
   * time inside the Lua scripts.
   */
  readonly now?: () => number;
  /** Circuit breaker: consecutive failures that open it (default 3). */
  readonly failureThreshold?: number;
  /** Circuit breaker: cooldown before a half-open probe (default 1000ms). */
  readonly cooldownMs?: number;
  /** Graceful-close budget (default RATE_LIMIT_REDIS_CLOSE_TIMEOUT_MS). */
  readonly closeTimeoutMs?: number;
  /**
   * Sanitized failure observability: receives ONLY sealed policy + failure
   * class/code labels (never facts, keys, plans or secrets).
   */
  readonly onFailure?: (policy: McpRateLimitPolicyName, failure: McpRateLimitFailure) => void;
}

/**
 * Factory (no global singleton): each API composition owns and closes its own
 * store. Fail-closed construction: a missing URL / empty secret / empty
 * environment token / invalid budgets are programmer errors.
 */
export function createRedisMcpRateLimitStore(options: RedisMcpRateLimitStoreOptions): McpRateLimiter {
  if (typeof options.redisUrl !== 'string' || options.redisUrl.length === 0) {
    throw new Error('createRedisMcpRateLimitStore requires MCP_RATE_LIMIT_REDIS_URL');
  }
  if (!Buffer.isBuffer(options.keySecret) || options.keySecret.length === 0) {
    throw new Error('createRedisMcpRateLimitStore requires a non-empty HMAC key secret buffer');
  }
  if (typeof options.environment !== 'string' || options.environment.length === 0) {
    throw new Error('createRedisMcpRateLimitStore requires a non-empty environment token');
  }
  assertMcpRateLimitPolicyConfig('request', options.request);
  assertMcpRateLimitPolicyConfig('approval', options.approval);
  assertMcpRateLimitCommitConfig(options.commit);
  if (!Number.isSafeInteger(options.commandTimeoutMs) || options.commandTimeoutMs < 1) {
    throw new Error('createRedisMcpRateLimitStore commandTimeoutMs must be a positive safe integer');
  }
  if (!Number.isSafeInteger(options.connectTimeoutMs) || options.connectTimeoutMs < 1) {
    throw new Error('createRedisMcpRateLimitStore connectTimeoutMs must be a positive safe integer');
  }
  if (!Number.isSafeInteger(options.maxRetriesPerRequest) || options.maxRetriesPerRequest < 0) {
    throw new Error('createRedisMcpRateLimitStore maxRetriesPerRequest must be a non-negative safe integer');
  }

  const inner = createRedisFixedWindowStore<McpRateLimitSubject>({
    redisUrl: options.redisUrl,
    commandTimeoutMs: options.commandTimeoutMs,
    connectTimeoutMs: options.connectTimeoutMs,
    maxRetriesPerRequest: options.maxRetriesPerRequest,
    createClient: options.createClient,
    now: options.now,
    failureThreshold: options.failureThreshold,
    cooldownMs: options.cooldownMs,
    closeTimeoutMs: options.closeTimeoutMs,
    ...(options.onFailure === undefined
      ? {}
      : {
          onFailure: (subject, failure) => {
            options.onFailure?.(subject.policy, failure);
          },
        }),
    resolveAdmission: (subject, nowMs) => {
      if (!MCP_RATE_LIMIT_POLICIES.includes(subject.policy)) {
        throw new RangeError('unknown mcp rate-limit policy');
      }
      assertMcpRateLimitFacts(subject.facts);
      if (subject.policy === 'commit-distinct-plan') {
        assertMcpRateLimitDistinctElement(subject.distinct as string);
        return {
          key: buildMcpRateLimitKey({
            keyPrefix: options.keyPrefix,
            environment: options.environment,
            keySecret: options.keySecret,
            policy: subject.policy,
            facts: subject.facts,
            windowStartEpochMs: Math.floor(nowMs / options.commit.windowMs) * options.commit.windowMs,
          }),
          rateMax: options.commit.maxPlans,
          windowMs: options.commit.windowMs,
          script: RATE_LIMIT_DISTINCT_LUA_SCRIPT,
          scriptName: RATE_LIMIT_DISTINCT_LUA_SCRIPT_NAME,
          args: [options.commit.maxPlans, options.commit.windowMs, subject.distinct as string],
        };
      }
      const config = subject.policy === 'request' ? options.request : options.approval;
      return {
        key: buildMcpRateLimitKey({
          keyPrefix: options.keyPrefix,
          environment: options.environment,
          keySecret: options.keySecret,
          policy: subject.policy,
          facts: subject.facts,
          windowStartEpochMs: Math.floor(nowMs / config.windowMs) * config.windowMs,
        }),
        rateMax: config.maxRequests,
        windowMs: config.windowMs,
      };
    },
  });

  return {
    consume: async (subject) => mapFrozenQuotaOutcome(await inner.consume(subject), (decision) =>
      Object.freeze({ allowed: decision.allowed, retryAfterSeconds: decision.retryAfterSeconds })),
    readiness: () => inner.readiness(),
    close: () => inner.close(),
  };
}
