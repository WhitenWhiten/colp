/**
 * T-07 MCP compatibility host operations.
 *
 * Bounded in-process inflight registry, live `/ready/features/mcp-compat`
 * snapshot, and flat `mcp.compat.*` counters. Dimensions are frozen name
 * suffixes (the host Metrics seam has no label arrays). Compat traffic must
 * never increment `mcp.read.*` or `mcp.write.*`. The registry never stores
 * bodies, tokens, principals, URIs, plan IDs, clientInfo, or User-Agent.
 */
import type { Phase4bMcpReadDependencyHealth } from './operations.js';
import {
  createMcpCompatReadinessDocument,
  type McpCompatReadinessDocument,
} from './mcp-compat-protocol.js';

export const PHASE4B_MCP_COMPAT_METRIC_PREFIX = 'mcp.compat' as const;

export type McpCompatMethodFamily =
  | 'handshake'
  | 'catalog'
  | 'read'
  | 'write_plan'
  | 'write_commit'
  | 'other';
export type McpCompatAuth = 'anonymous' | 'bearer';
export type McpCompatEra = 'modern' | 'legacy';
export type McpCompatProtocolRevision = '2026-07-28' | '2025-11-25' | 'unsupported';
export type McpCompatInitializeOffer = '2025-11-25' | '2025-06-18' | 'other';
export type McpCompatOutcome =
  | 'ok'
  | 'rejected'
  | 'auth_required'
  | 'forbidden'
  | 'rate_limited'
  | 'dependency_error'
  | 'cancelled';
export type McpCompatClientFamily = 'codex' | 'claude-code' | 'unknown';
export type McpCompatRejectCategory = 'admission' | 'rate_limited' | 'auth' | 'unsupported';
export type McpCompatPortHealth = 'ready' | 'unavailable';

export interface Phase4bMcpCompatMetrics {
  readonly increment: (name: string, value?: number) => void;
  readonly gauge: (name: string, value: number) => void;
  readonly observe: (name: string, value: number) => void;
}

export interface Phase4bMcpCompatBeginRequestInput {
  readonly controller: AbortController;
}

export interface Phase4bMcpCompatHandshakeRecord {
  readonly offer: McpCompatInitializeOffer;
  readonly clientFamily: McpCompatClientFamily;
}

export interface Phase4bMcpCompatRequestFinish {
  readonly outcome: McpCompatOutcome;
  readonly methodFamily: McpCompatMethodFamily;
  readonly auth: McpCompatAuth;
  readonly era: McpCompatEra;
  readonly protocolRevision: McpCompatProtocolRevision;
  readonly rejectCategory?: McpCompatRejectCategory;
  readonly handshake?: Phase4bMcpCompatHandshakeRecord;
}

export interface Phase4bMcpCompatOperationHandle {
  readonly registered: boolean;
  finish(input: Phase4bMcpCompatRequestFinish): void;
}

export interface Phase4bMcpCompatOperationsSnapshot {
  readonly admitting: boolean;
  readonly counts: { readonly activeRequests: number };
  readonly rejectCounts: McpCompatReadinessDocument['rejectCounts'];
}

export interface Phase4bMcpCompatOperationsOptions {
  readonly metrics: Phase4bMcpCompatMetrics;
  readonly maxConcurrentRequests: number;
  readonly maxQueuedRequests: number;
  readonly writeEnabled?: boolean;
  readonly oauthHealth?: () => Promise<Phase4bMcpReadDependencyHealth>;
  readonly limiterHealth?: () => McpCompatPortHealth | Promise<McpCompatPortHealth>;
  readonly approvalHealth?: () => McpCompatPortHealth | Promise<McpCompatPortHealth>;
}

export interface Phase4bMcpCompatOperations {
  /** Flat rejection accounting without body classification or an inflight slot. */
  recordRejected(input: Phase4bMcpCompatRequestFinish): void;
  beginRequest(input: Phase4bMcpCompatBeginRequestInput): Phase4bMcpCompatOperationHandle;
  drain(): void;
  isAdmitting(): boolean;
  inspect(): Phase4bMcpCompatOperationsSnapshot;
  readiness(): Promise<McpCompatReadinessDocument>;
}

const METHOD_FAMILIES = Object.freeze([
  'handshake', 'catalog', 'read', 'write_plan', 'write_commit', 'other',
] as const);
const AUTH_VALUES = Object.freeze(['anonymous', 'bearer'] as const);
const ERA_VALUES = Object.freeze(['modern', 'legacy'] as const);
const REVISION_VALUES = Object.freeze(['2026-07-28', '2025-11-25', 'unsupported'] as const);
const OFFER_VALUES = Object.freeze(['2025-11-25', '2025-06-18', 'other'] as const);
const OUTCOMES = Object.freeze([
  'ok', 'rejected', 'auth_required', 'forbidden', 'rate_limited', 'dependency_error', 'cancelled',
] as const);
const CLIENT_FAMILIES = Object.freeze(['codex', 'claude-code', 'unknown'] as const);
const REJECT_CATEGORIES = Object.freeze(['admission', 'rate_limited', 'auth', 'unsupported'] as const);

const HANDSHAKE_METHODS = Object.freeze(['initialize', 'notifications/initialized']);
const CATALOG_METHODS = Object.freeze(['tools/list', 'resources/list', 'resources/templates/list']);
const READ_TOOL_NAMES = Object.freeze(['collections.get', 'collections.get_snapshot', 'nodes.get']);
const WRITE_PLAN_TOOL_NAMES = Object.freeze([
  'nodes.create',
  'nodes.update',
  'collections.update',
  'annotations.create',
  'annotations.update',
  'changes.plan',
  'changes.cancel',
  'changes.get',
]);
/** Exact names after trim+lowercase (and space→hyphen). Raw client names never become metric labels. */
const CLIENT_FAMILY_ALIASES: { readonly [key: string]: McpCompatClientFamily | undefined } = Object.freeze({
  codex: 'codex',
  codex_cli: 'codex',
  'claude-code': 'claude-code',
});

function suffixRevision(value: McpCompatProtocolRevision): string {
  return value === 'unsupported' ? 'unsupported' : value.replaceAll('-', '_');
}

function suffixOffer(value: McpCompatInitializeOffer): string {
  return value === 'other' ? 'other' : value.replaceAll('-', '_');
}

function suffixClient(value: McpCompatClientFamily): string {
  return value === 'claude-code' ? 'claude_code' : value;
}

function buildAllowlist(): readonly string[] {
  const names = [
    'mcp.compat.requests.total',
    'mcp.compat.requests.active',
    'mcp.compat.drain.total',
    'mcp.compat.registry.overflow',
  ];
  for (const outcome of OUTCOMES) names.push(`mcp.compat.requests.outcome.${outcome}`);
  for (const family of METHOD_FAMILIES) names.push(`mcp.compat.requests.method.${family}`);
  for (const auth of AUTH_VALUES) names.push(`mcp.compat.requests.auth.${auth}`);
  for (const era of ERA_VALUES) names.push(`mcp.compat.requests.era.${era}`);
  for (const revision of REVISION_VALUES) {
    names.push(`mcp.compat.requests.revision.${suffixRevision(revision)}`);
  }
  for (const offer of OFFER_VALUES) names.push(`mcp.compat.handshake.offer.${suffixOffer(offer)}`);
  names.push('mcp.compat.handshake.revision.2025_11_25');
  names.push('mcp.compat.handshake.revision.unsupported');
  for (const family of CLIENT_FAMILIES) names.push(`mcp.compat.client.${suffixClient(family)}`);
  for (const category of REJECT_CATEGORIES) names.push(`mcp.compat.reject.${category}`);
  return Object.freeze(names);
}

export const PHASE4B_MCP_COMPAT_METRIC_NAME_ALLOWLIST = buildAllowlist();

const METRIC_ALLOWLIST = new Set(PHASE4B_MCP_COMPAT_METRIC_NAME_ALLOWLIST);

function increment(metrics: Phase4bMcpCompatMetrics, name: string, value = 1): void {
  if (!METRIC_ALLOWLIST.has(name)) {
    throw new TypeError(`Unknown MCP compat metric: ${name}`);
  }
  metrics.increment(name, value);
}

function jsonMethod(body: unknown): string {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return '';
  const method = (body as { readonly method?: unknown }).method;
  return typeof method === 'string' ? method : '';
}

function jsonToolName(body: unknown): string {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return '';
  const params = (body as { readonly params?: unknown }).params;
  if (params === null || typeof params !== 'object' || Array.isArray(params)) return '';
  const name = (params as { readonly name?: unknown }).name;
  return typeof name === 'string' ? name : '';
}

export function classifyMcpCompatMethodFamily(body: unknown): McpCompatMethodFamily {
  const method = jsonMethod(body);
  if ((HANDSHAKE_METHODS as readonly string[]).includes(method)) return 'handshake';
  if ((CATALOG_METHODS as readonly string[]).includes(method)) return 'catalog';
  if (method === 'resources/read') return 'read';
  if (method === 'tools/call') {
    const name = jsonToolName(body);
    if ((READ_TOOL_NAMES as readonly string[]).includes(name)) return 'read';
    if ((WRITE_PLAN_TOOL_NAMES as readonly string[]).includes(name)) return 'write_plan';
    if (name === 'changes.commit') return 'write_commit';
  }
  return 'other';
}

export function classifyMcpCompatInitializeOffer(body: unknown): McpCompatInitializeOffer | undefined {
  if (jsonMethod(body) !== 'initialize') return undefined;
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return 'other';
  const params = (body as { readonly params?: unknown }).params;
  if (params === null || typeof params !== 'object' || Array.isArray(params)) return 'other';
  const version = (params as { readonly protocolVersion?: unknown }).protocolVersion;
  if (version === '2025-11-25' || version === '2025-06-18') return version;
  return 'other';
}

export function classifyMcpCompatClientFamily(name: unknown): McpCompatClientFamily {
  if (typeof name !== 'string') return 'unknown';
  const normalized = name.trim().toLowerCase().replace(/\s+/gu, '-');
  return CLIENT_FAMILY_ALIASES[normalized] ?? 'unknown';
}

export function classifyMcpCompatClientFamilyFromBody(body: unknown): McpCompatClientFamily {
  if (jsonMethod(body) !== 'initialize') return 'unknown';
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return 'unknown';
  const params = (body as { readonly params?: unknown }).params;
  if (params === null || typeof params !== 'object' || Array.isArray(params)) return 'unknown';
  const info = (params as { readonly clientInfo?: unknown }).clientInfo;
  if (info === null || typeof info !== 'object' || Array.isArray(info)) return 'unknown';
  return classifyMcpCompatClientFamily((info as { readonly name?: unknown }).name);
}

export function mcpCompatAuthFromAuthorizationPresent(present: boolean): McpCompatAuth {
  return present ? 'bearer' : 'anonymous';
}

function assertSafeNonNegative(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > 100_000) {
    throw new TypeError(`${name} must be a safe integer in 0..100000`);
  }
}

export function createPhase4bMcpCompatOperations(
  options: Phase4bMcpCompatOperationsOptions,
): Phase4bMcpCompatOperations {
  if (typeof options !== 'object' || options === null || Array.isArray(options)) {
    throw new TypeError('MCP compat operations options must be an object.');
  }
  const metrics = options.metrics;
  if (typeof metrics !== 'object' || metrics === null
    || typeof metrics.increment !== 'function'
    || typeof metrics.gauge !== 'function'
    || typeof metrics.observe !== 'function') {
    throw new TypeError('MCP compat operations require a Metrics seam.');
  }
  const maxConcurrentRequests = options.maxConcurrentRequests;
  const maxQueuedRequests = options.maxQueuedRequests;
  if (!Number.isSafeInteger(maxConcurrentRequests) || maxConcurrentRequests < 1 || maxConcurrentRequests > 100_000) {
    throw new TypeError('MCP compat maxConcurrentRequests must be a safe integer in 1..100000');
  }
  assertSafeNonNegative(maxQueuedRequests, 'MCP compat maxQueuedRequests');
  const registryLimit = maxConcurrentRequests + maxQueuedRequests;
  const writeEnabled = options.writeEnabled === true;
  const oauthHealth = options.oauthHealth;
  const limiterHealth = options.limiterHealth;
  const approvalHealth = options.approvalHealth;
  if (oauthHealth !== undefined && typeof oauthHealth !== 'function') {
    throw new TypeError('MCP compat oauthHealth must be a function.');
  }
  if (limiterHealth !== undefined && typeof limiterHealth !== 'function') {
    throw new TypeError('MCP compat limiterHealth must be a function.');
  }
  if (approvalHealth !== undefined && typeof approvalHealth !== 'function') {
    throw new TypeError('MCP compat approvalHealth must be a function.');
  }

  const entries = new Map<object, { readonly controller: AbortController; finished: boolean }>();
  const rejectCounts = { total: 0, admission: 0, rate_limited: 0, auth: 0, unsupported: 0 };
  let admitting = true;

  const updateGauge = (): void => {
    metrics.gauge('mcp.compat.requests.active', entries.size);
  };

  const recordFinish = (finishInput: Phase4bMcpCompatRequestFinish): void => {
    increment(metrics, 'mcp.compat.requests.total');
    increment(metrics, `mcp.compat.requests.outcome.${finishInput.outcome}`);
    increment(metrics, `mcp.compat.requests.method.${finishInput.methodFamily}`);
    increment(metrics, `mcp.compat.requests.auth.${finishInput.auth}`);
    increment(metrics, `mcp.compat.requests.era.${finishInput.era}`);
    increment(metrics, `mcp.compat.requests.revision.${suffixRevision(finishInput.protocolRevision)}`);
    if (finishInput.rejectCategory !== undefined) {
      increment(metrics, `mcp.compat.reject.${finishInput.rejectCategory}`);
      rejectCounts[finishInput.rejectCategory] += 1;
      rejectCounts.total += 1;
    }
    const handshake = finishInput.handshake;
    if (handshake !== undefined) {
      increment(metrics, `mcp.compat.handshake.offer.${suffixOffer(handshake.offer)}`);
      const handshakeRevision = finishInput.protocolRevision === '2025-11-25'
        ? '2025_11_25'
        : 'unsupported';
      increment(metrics, `mcp.compat.handshake.revision.${handshakeRevision}`);
      increment(metrics, `mcp.compat.client.${suffixClient(handshake.clientFamily)}`);
    }
  };
  const operations: Phase4bMcpCompatOperations = Object.freeze({
    recordRejected: recordFinish,
    beginRequest(input: Phase4bMcpCompatBeginRequestInput) {
      if (typeof input !== 'object' || input === null || Array.isArray(input)) {
        throw new TypeError('MCP compat beginRequest input must be an object.');
      }
      if (!(input.controller instanceof AbortController)) {
        throw new TypeError('MCP compat beginRequest requires an AbortController.');
      }
      let registered = false;
      let key: object | undefined;
      let handleFinished = false;
      if (entries.size < registryLimit) {
        key = Object.freeze({});
        entries.set(key, { controller: input.controller, finished: false });
        registered = true;
        updateGauge();
      } else {
        increment(metrics, 'mcp.compat.registry.overflow');
      }
      return Object.freeze({
        registered,
        finish(finishInput: Phase4bMcpCompatRequestFinish) {
          if (handleFinished) return;
          handleFinished = true;
          if (key !== undefined) {
            const entry = entries.get(key);
            if (entry !== undefined && !entry.finished) {
              entry.finished = true;
              entries.delete(key);
              updateGauge();
            }
          }
          recordFinish(finishInput);
        },
      });
    },
    drain() {
      increment(metrics, 'mcp.compat.drain.total');
      admitting = false;
      for (const entry of entries.values()) {
        entry.controller.abort(new DOMException('MCP compat drained', 'AbortError'));
      }
    },
    isAdmitting() {
      return admitting;
    },
    inspect() {
      return Object.freeze({
        admitting,
        counts: Object.freeze({ activeRequests: entries.size }),
        rejectCounts: Object.freeze({ ...rejectCounts }),
      });
    },
    async readiness() {
      const reasons: string[] = [];
      let status: McpCompatReadinessDocument['status'] = 'ready';
      if (!admitting) {
        status = 'not_ready';
        reasons.push('mcp_compat_draining');
      }
      if (oauthHealth === undefined) {
        status = 'not_ready';
        reasons.push('mcp_compat_dependency_unavailable');
      } else {
        try {
          const oauth = await oauthHealth();
          if (oauth.oauth === 'unavailable') {
            status = 'not_ready';
            reasons.push('mcp_compat_dependency_unavailable');
          } else if (oauth.oauth === 'degraded') {
            if (status === 'ready') status = 'degraded';
            reasons.push('mcp_compat_dependency_degraded');
          }
        } catch {
          status = 'not_ready';
          reasons.push('mcp_compat_dependency_unavailable');
        }
      }
      if (limiterHealth !== undefined) {
        try {
          if (await limiterHealth() === 'unavailable') {
            status = 'not_ready';
            reasons.push('mcp_compat_limiter_unavailable');
          }
        } catch {
          status = 'not_ready';
          reasons.push('mcp_compat_limiter_unavailable');
        }
      }
      if (writeEnabled) {
        if (approvalHealth === undefined) {
          status = 'not_ready';
          reasons.push('mcp_compat_approval_unavailable');
        } else {
          try {
            if (await approvalHealth() === 'unavailable') {
              status = 'not_ready';
              reasons.push('mcp_compat_approval_unavailable');
            }
          } catch {
            status = 'not_ready';
            reasons.push('mcp_compat_approval_unavailable');
          }
        }
      }
      if (entries.size >= registryLimit) {
        status = 'not_ready';
        reasons.push('mcp_compat_capacity_exhausted');
      }
      return createMcpCompatReadinessDocument({
        status,
        reasons,
        admitting,
        counts: { activeRequests: entries.size },
        rejectCounts: { ...rejectCounts },
      });
    },
  });
  updateGauge();
  return operations;
}
