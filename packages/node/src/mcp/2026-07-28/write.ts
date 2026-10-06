/**
 * Modern MCP `2026-07-28` Write / MRTR adapter.
 *
 * Thin adapter layer over the Write Gateway
 * (`src/mcp/write-tools.ts`) and the change-plan core
 * (`src/mcp/change-plan.ts`): it maps the shared low-risk Tools and
 * `changes.plan` / `changes.commit` / `changes.cancel` onto Modern results
 * and never re-implements execution, approval or idempotency semantics.
 *
 * MRTR mapping (pinned SDK `@modelcontextprotocol/core`/server 2.0.0 wire
 * shape, migration decision §3/§5/§6):
 * - normal results are fixed `complete`;
 * - waiting for out-of-band approval returns `resultType: 'input_required'`
 *   with an `inputRequests` map and a server-minted `requestState`. COLP
 *   never initiates roots/sampling/elicitation server-to-client requests, so
 *   the `inputRequests` map is present but empty (`{}`) — the at-least-one
 *   rule is satisfied by `requestState`, and the client retries after the
 *   host records approval out-of-band;
 * - retries echo `requestState` (+ optional `inputResponses`); the adapter
 *   verifies the state (HMAC integrity, expiry, authenticated-principal bind,
 *   method and input digest) and resumes the SAME plan business state. A
 *   fresh call without `requestState` always creates new business state;
 * - `inputResponses` is structurally validated per the SDK
 *   `inputResponse()` union (elicit/roots/sampling); well-formed entries for
 *   requests this server never issued are ignored, malformed entries are
 *   rejected with Invalid Params;
 * - `elicitationId`, the completion notification channel, roots/sampling/
 *   elicitation requests and any other server-initiated request are never
 *   used (migration decision §3 "server-initiated requests" row).
 *
 * The host owns the plan-status resolver (`resolvePlan`) that backs
 * `requestState` retries: it returns the current plan status plus a
 * protocol-neutral plan projection (same shape as `changes.plan`
 * structuredContent). The request-state HMAC key and TTL are host-configured
 * (`requestStateKey` >= 32 bytes, `requestStateTtlSeconds`). Binding tags are
 * version v1 (see request-state-binding.ts). v0 pipe-join tags are rejected
 * and that failure does not mint a replacement Plan; the TTL default stays 600s.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { types as nodeTypes } from 'node:util';

import canonicalize from 'canonicalize';

import { snapshotMcpData, resolveMcpWriteInputBudget, type McpWriteInputBudget } from '../safe-data.js';
import { McpChangePlanError } from '../change-plan.js';
import type { McpChangePlanServiceOptions } from '../change-plan.js';
import {
  requireAuthenticatedWriteBinding,
  type McpAuthenticatedAuthorizationBinding,
} from '../shared/authorization.js';
import { resolveMcpResourceReadBudget } from '../shared/resources.js';
import {
  McpToolInputError,
  type McpToolInputSchema,
  type McpToolOutputSchema,
} from '../tool-input.js';
import type { McpToolDefinition } from '../collections-get.js';
import {
  McpWriteBindingRequiredError,
  McpWriteRequestAbortedError,
  McpWriteUnknownToolError,
  createMcpWriteToolGateway,
  type McpApiKeyApplicationPort,
  type McpLowRiskToolDefinition,
  type McpTrustedWriteRequestContext,
  type McpWriteToolGateway,
  type McpWriteToolResult,
  type McpWriteTransportRequirements,
} from '../write-tools.js';
import {
  Mcp20260728RequestError,
  requireMcp20260728RequestContext,
  type Mcp20260728RequestContext,
} from './request-context.js';
import {
  createMcp20260728Result,
  type Mcp20260728CacheMetadata,
  type Mcp20260728Result,
  type Mcp20260728ServerInfo,
} from './results.js';
import {
  CallToolResultSchema,
  ImplementationSchema,
  ListToolsResultSchema,
  ToolSchema,
} from '../../shared/mcp-sdk-boundary.js';
import {
  DEFAULT_MCP_SCHEMA_BUDGET,
  assertMcpSchemaWithinBudget,
  resolveMcpSchemaBudget,
  type McpSchemaBudget,
} from './schema-budget.js';
import { requestStateBindingMaterial } from './request-state-binding.js';

/** Closed set of plan statuses a host resolver may return. */
export type Mcp20260728PlanStatus =
  | 'pending'
  | 'approved'
  | 'committing'
  | 'consumed'
  | 'cancelled'
  | 'expired'
  | 'unknown';

const PLAN_STATUSES: readonly Mcp20260728PlanStatus[] = Object.freeze([
  'pending',
  'approved',
  'committing',
  'consumed',
  'cancelled',
  'expired',
  'unknown',
]);

/** Host resolution for one plan during a `requestState` retry. */
export interface Mcp20260728PlanResolution {
  readonly status: Mcp20260728PlanStatus;
  /**
   * Protocol-neutral plan projection (same shape as `changes.plan`
   * structuredContent). Required for `pending`/`committing`/`approved`.
   */
  readonly plan?: Readonly<Record<string, unknown>>;
}

/** Host-owned plan-status resolver backing the server-minted `requestState`. */
export interface Mcp20260728WritePlanStatusPort {
  readonly resolvePlan: (
    planId: string,
    binding: McpAuthenticatedAuthorizationBinding,
  ) => Promise<Mcp20260728PlanResolution> | Mcp20260728PlanResolution;
}

/** Stable machine-readable codes for server-minted requestState failures. */
export type Mcp20260728WriteRequestStateErrorCode =
  | 'invalid_request_state'
  | 'request_state_expired'
  | 'request_state_binding_mismatch'
  | 'request_state_mismatch';

/** Typed failure for server-minted `requestState` verification. */
export class Mcp20260728WriteRequestStateError extends Error {
  readonly code: Mcp20260728WriteRequestStateErrorCode;

  constructor(code: Mcp20260728WriteRequestStateErrorCode, message: string) {
    super(message);
    this.name = 'Mcp20260728WriteRequestStateError';
    this.code = code;
  }
}

export interface Mcp20260728WriteToolAdapterOptions {
  /** Protocol-neutral change-plan service options (shared core). */
  readonly changePlan: McpChangePlanServiceOptions;
  /** Optional low-risk write application tools (same contract as the gateway). */
  readonly lowRiskTools?: Readonly<Record<string, McpLowRiskToolDefinition>>;
  /** Optional key application port; when present, keys.create / keys.rotate are published. */
  readonly apiKeys?: McpApiKeyApplicationPort;
  /** Builds host-owned reveal URIs; required when key tools or key plans are used. */
  readonly revealUriForKey?: (keyId: string) => string;
  /** Shared write-input budget (defaults to the gateway default). */
  readonly inputBudget?: McpWriteInputBudget;
  readonly serverInfo: Mcp20260728ServerInfo;
  /** Host resolver that maps a plan id + binding to status and a plan projection. */
  readonly resolvePlan: Mcp20260728WritePlanStatusPort;
  /** HMAC key (string or raw bytes, >= 32 bytes) protecting server-minted requestState. */
  readonly requestStateKey: string | Uint8Array;
  /** requestState TTL in seconds (default 600). */
  readonly requestStateTtlSeconds?: number;
  /** Injectable clock (epoch milliseconds) for requestState mint/verify (default Date.now). */
  readonly requestStateClock?: () => number;
  /** Schema 2020-12 budget guard applied to every published Tool schema. */
  readonly schemaBudget?: McpSchemaBudget;
  /** Accurate cache metadata for the cacheable `tools/list` method (default 0/private). */
  readonly cache?: Readonly<Partial<Record<'tools/list', Mcp20260728CacheMetadata>>>;
}

export interface Mcp20260728WriteToolAdapter {
  readonly listTools: (
    context: Mcp20260728RequestContext,
    input?: unknown,
  ) => Promise<Mcp20260728Result>;
  readonly callTool: (
    context: Mcp20260728RequestContext,
    input?: unknown,
  ) => Promise<Mcp20260728Result>;
  /** Host-only: record out-of-band approval (never a model Tool). */
  readonly recordOutOfBandApproval: (
    planId: string,
    context: Mcp20260728RequestContext,
  ) => Promise<void>;
  /** Limit the host transport MUST enforce on raw bytes before JSON parsing. */
  readonly transportRequirements: McpWriteTransportRequirements;
}

interface McpSchemaValidator {
  readonly safeParse: (value: unknown) => { readonly success: boolean };
}

const TOOL_RESULT_SCHEMAS: Readonly<Record<'tools/list' | 'tools/call', McpSchemaValidator>> =
  Object.freeze({
    'tools/list': ListToolsResultSchema,
    'tools/call': CallToolResultSchema,
  });

const REQUEST_STATE_PREFIX = 'colp.rs.' as const;
const DEFAULT_REQUEST_STATE_TTL_SECONDS = 600;
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/u;

interface RequestStatePayload {
  readonly planId: string;
  readonly method: string;
  readonly inputDigest: string;
}

interface RequestStateCodec {
  readonly mint: (
    payload: RequestStatePayload,
    binding: McpAuthenticatedAuthorizationBinding,
  ) => string;
  readonly verify: (
    state: string,
    expected: Readonly<{
      method: string;
      inputDigest: string;
      binding: McpAuthenticatedAuthorizationBinding;
    }>,
  ) => RequestStatePayload;
}

function base64UrlEncode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

function base64UrlDecode(value: string): Uint8Array {
  if (!BASE64URL_RE.test(value) || value.length % 4 === 1) {
    throw new Error('Malformed base64url.');
  }
  const normalized = value.replace(/-/gu, '+').replace(/_/gu, '/');
  const padded = `${normalized}${'='.repeat((4 - (normalized.length % 4)) % 4)}`;
  return new Uint8Array(Buffer.from(padded, 'base64'));
}

function base64UrlEqual(left: string, right: string): boolean {
  let leftBytes: Uint8Array;
  let rightBytes: Uint8Array;
  try {
    leftBytes = base64UrlDecode(left);
    rightBytes = base64UrlDecode(right);
  } catch {
    return false;
  }
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function createRequestStateCodec(options: Readonly<{
  key: Uint8Array;
  ttlSeconds: number;
  now: () => number;
}>): RequestStateCodec {
  const hmac = (data: string | Uint8Array): Uint8Array => {
    const digest = createHmac('sha256', options.key);
    if (typeof data === 'string') digest.update(data, 'utf8');
    else digest.update(data);
    return new Uint8Array(digest.digest());
  };
  const bindTag = (binding: McpAuthenticatedAuthorizationBinding): string =>
    base64UrlEncode(hmac(requestStateBindingMaterial(binding)).subarray(0, 16));

  const codec: RequestStateCodec = {
    mint: (payload, binding) => {
      const envelope = {
        p: payload,
        exp: Math.floor(options.now() / 1000) + options.ttlSeconds,
        b: bindTag(binding),
      };
      const body = base64UrlEncode(Buffer.from(JSON.stringify(envelope), 'utf8'));
      const mac = base64UrlEncode(hmac(REQUEST_STATE_PREFIX + body));
      return `${REQUEST_STATE_PREFIX}${body}.${mac}`;
    },
    verify: (state, expected) => {
      if (typeof state !== 'string' || !state.startsWith(REQUEST_STATE_PREFIX)) {
        throw new Mcp20260728WriteRequestStateError('invalid_request_state', 'Malformed requestState.');
      }
      const dot = state.lastIndexOf('.');
      if (dot < REQUEST_STATE_PREFIX.length + 1) {
        throw new Mcp20260728WriteRequestStateError('invalid_request_state', 'Malformed requestState.');
      }
      const body = state.slice(REQUEST_STATE_PREFIX.length, dot);
      const mac = state.slice(dot + 1);
      const expectedMac = base64UrlEncode(hmac(REQUEST_STATE_PREFIX + body));
      if (!base64UrlEqual(mac, expectedMac)) {
        throw new Mcp20260728WriteRequestStateError('invalid_request_state', 'requestState MAC verification failed.');
      }
      let envelope: unknown;
      try {
        envelope = JSON.parse(
          new TextDecoder('utf-8', { fatal: true }).decode(base64UrlDecode(body)),
        );
      } catch {
        throw new Mcp20260728WriteRequestStateError('invalid_request_state', 'Malformed requestState envelope.');
      }
      if (typeof envelope !== 'object' || envelope === null) {
        throw new Mcp20260728WriteRequestStateError('invalid_request_state', 'Malformed requestState envelope.');
      }
      const record = envelope as Readonly<Record<string, unknown>>;
      const payload = record.p;
      const exp = record.exp;
      const tag = record.b;
      if (typeof payload !== 'object' || payload === null) {
        throw new Mcp20260728WriteRequestStateError('invalid_request_state', 'Malformed requestState payload.');
      }
      if (typeof exp !== 'number' || !Number.isFinite(exp)) {
        throw new Mcp20260728WriteRequestStateError('invalid_request_state', 'Malformed requestState expiry.');
      }
      if (exp < Math.floor(options.now() / 1000)) {
        throw new Mcp20260728WriteRequestStateError('request_state_expired', 'requestState has expired.');
      }
      if (tag !== bindTag(expected.binding)) {
        throw new Mcp20260728WriteRequestStateError(
          'request_state_binding_mismatch',
          'requestState is bound to a different authenticated principal.',
        );
      }
      const typed = payload as Readonly<Record<string, unknown>>;
      const planId = typed.planId;
      const method = typed.method;
      const inputDigest = typed.inputDigest;
      if (
        typeof planId !== 'string'
        || planId.length === 0
        || typeof method !== 'string'
        || typeof inputDigest !== 'string'
      ) {
        throw new Mcp20260728WriteRequestStateError('invalid_request_state', 'Malformed requestState payload.');
      }
      if (method !== expected.method || inputDigest !== expected.inputDigest) {
        throw new Mcp20260728WriteRequestStateError(
          'request_state_mismatch',
          'requestState does not match this request.',
        );
      }
      return Object.freeze({ planId, method, inputDigest });
    },
  };
  return Object.freeze(codec);
}

function computeInputDigest(
  argumentsValue: unknown,
  budget: McpWriteInputBudget,
): string {
  const snapshot = argumentsValue === undefined
    ? Object.freeze({})
    : snapshotMcpData(argumentsValue, budget);
  const canonical = canonicalize(snapshot) ?? '';
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

export type {
  McpLowRiskToolDefinition,
  McpApiKeyApplicationPort,
  McpWriteTransportRequirements,
} from '../write-tools.js';
export type { McpWriteInputBudget } from '../safe-data.js';
export {
  McpChangePlanError,
  createChangePlanService,
  type McpApprovalBeginResult,
  type McpApprovalStorePort,
  type McpChangePlanAuthorizationPolicyPort,
  type McpChangePlanClockPort,
  type McpChangePlanCommitApprovalStorePort,
  type McpChangePlanCommitCoordinatorPort,
  type McpChangePlanCommitPlanStorePort,
  type McpChangePlanCommitTransaction,
  type McpChangePlanExecutorPort,
  type McpChangePlanIdPort,
  type McpChangePlanImpactPort,
  type McpChangePlanRateLimitPort,
  type McpChangePlanRevisionMap,
  type McpChangePlanRevisionPort,
  type McpChangePlanScopePort,
  type McpChangePlanService,
  type McpChangePlanServiceOptions,
  type McpChangePlanStoredDigestPort,
  type McpChangePlanStorePort,
  type McpPlanCommitResult,
  type McpStoredPlan,
} from '../change-plan.js';

/**
 * Creates the reusable Modern Write Tool adapter. Validates host options
 * (fail-closed `TypeError` on malformed configuration), composes the internal
 * Write Gateway and returns one frozen instance that safely
 * serves concurrent requests with isolated per-request trusted contexts.
 */
export function createMcp20260728WriteToolAdapter(
  options: Mcp20260728WriteToolAdapterOptions,
): Mcp20260728WriteToolAdapter {
  if (arguments.length !== 1) throw configError();
  if (typeof options !== 'object' || options === null || nodeTypes.isProxy(options)) throw configError();

  const changePlan = readOwnValue(options, 'changePlan', configError) as McpChangePlanServiceOptions;
  const lowRiskTools = readOptionalOwnValue(options, 'lowRiskTools') as
    | Readonly<Record<string, McpLowRiskToolDefinition>>
    | undefined;
  const apiKeys = readOptionalOwnValue(options, 'apiKeys') as McpApiKeyApplicationPort | undefined;
  const revealUriForKey = readOptionalOwnValue(options, 'revealUriForKey') as
    | ((keyId: string) => string)
    | undefined;
  const inputBudget = readOptionalOwnValue(options, 'inputBudget') as McpWriteInputBudget | undefined;
  const serverInfo = readServerInfo(options);
  const resolvePlan = readResolvePlan(options);
  const requestStateKey = readRequestStateKey(options);
  const requestStateTtlSeconds = readRequestStateTtlSeconds(options);
  const requestStateClock = readRequestStateClock(options);
  const schemaBudget = resolveSchemaBudget(options);
  const cache = readCache(options);

  let gateway: McpWriteToolGateway;
  try {
    gateway = createMcpWriteToolGateway({
      changePlan,
      ...(lowRiskTools !== undefined ? { lowRiskTools } : {}),
      ...(apiKeys !== undefined ? { apiKeys } : {}),
      ...(revealUriForKey !== undefined ? { revealUriForKey } : {}),
      ...(inputBudget !== undefined ? { inputBudget } : {}),
    });
  } catch {
    throw configError();
  }

  const codec = createRequestStateCodec({
    key: requestStateKey,
    ttlSeconds: requestStateTtlSeconds,
    now: requestStateClock,
  });

  const entries = readToolEntries(gateway, schemaBudget);
  entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  const sortedModern = Object.freeze(entries.map((entry) => entry.modern));

  const toTrustedWriteContext = (context: Mcp20260728RequestContext): McpTrustedWriteRequestContext => {
    let binding: McpAuthenticatedAuthorizationBinding;
    try {
      binding = requireAuthenticatedWriteBinding(context.binding);
    } catch {
      throw new Mcp20260728RequestError(
        'invalid_params',
        'MCP write Tools require an authenticated binding.',
        { code: 'anonymous_write_forbidden' },
      );
    }
    const readBudget = resolveMcpResourceReadBudget(context.budget);
    const budget = resolveMcpWriteInputBudget({
      maxDepth: readBudget.maxDepth,
      maxNodes: readBudget.maxNodes,
      maxBytes: readBudget.maxBytes,
      maxOperations: readBudget.maxOperations,
    });
    return Object.freeze({
      binding,
      scope: context.scope,
      budget,
      abortSignal: context.abortSignal,
      authorization: context.authorization,
    });
  };

  const verifyState = (
    state: string,
    method: string,
    inputDigest: string,
    binding: McpAuthenticatedAuthorizationBinding,
  ): RequestStatePayload => {
    try {
      return codec.verify(state, { method, inputDigest, binding });
    } catch (error) {
      if (error instanceof Mcp20260728WriteRequestStateError) {
        throw new Mcp20260728RequestError(
          'invalid_params',
          'MCP write requestState verification failed.',
          { code: error.code },
        );
      }
      throw error;
    }
  };

  const resolvePlanStatus = async (
    planId: string,
    binding: McpAuthenticatedAuthorizationBinding,
  ): Promise<Mcp20260728PlanResolution> => {
    const resolution = await Reflect.apply(resolvePlan.resolvePlan, resolvePlan, [planId, binding]);
    if (typeof resolution !== 'object' || resolution === null || Array.isArray(resolution)) {
      throw new TypeError('MCP Write adapter resolvePlan must return an object.');
    }
    const status = readOwnValue(resolution, 'status');
    if (typeof status !== 'string' || !(PLAN_STATUSES as readonly string[]).includes(status)) {
      throw new TypeError('MCP Write adapter resolvePlan returned an invalid status.');
    }
    const plan = readOwnValue(resolution, 'plan');
    if (
      plan !== undefined
      && (typeof plan !== 'object' || plan === null || Array.isArray(plan) || nodeTypes.isProxy(plan))
    ) {
      throw new TypeError('MCP Write adapter resolvePlan plan must be an own-data object.');
    }
    return Object.freeze({
      status: status as Mcp20260728PlanStatus,
      ...(plan !== undefined ? { plan: plan as Readonly<Record<string, unknown>> } : {}),
    });
  };

  const mintState = (
    payload: RequestStatePayload,
    binding: McpAuthenticatedAuthorizationBinding,
  ): string => codec.mint(payload, binding);

  const handleNormal = async (
    trusted: McpTrustedWriteRequestContext,
    name: string,
    args: Readonly<Record<string, unknown>> | undefined,
  ): Promise<Mcp20260728Result> => {
    const result = await gateway.callTool(name, args, trusted);
    return buildCompleteResult(serverInfo, trusted.budget, result);
  };

  const handlePlan = async (
    trusted: McpTrustedWriteRequestContext,
    args: Readonly<Record<string, unknown>> | undefined,
    requestState: string | undefined,
  ): Promise<Mcp20260728Result> => {
    const binding = trusted.binding;
    const budget = trusted.budget;
    if (requestState === undefined) {
      const result = await gateway.callTool('changes.plan', args, trusted);
      const structuredContent = result.structuredContent;
      if (typeof structuredContent !== 'object' || structuredContent === null) {
        throw new TypeError('MCP Write adapter changes.plan returned a non-object plan result.');
      }
      const planId = readOwnValue(structuredContent, 'planId');
      if (typeof planId !== 'string' || planId.length === 0) {
        throw new TypeError('MCP Write adapter changes.plan returned an invalid planId.');
      }
      if (readOwnValue(structuredContent, 'requiresApproval') === false) {
        return buildCompleteResult(serverInfo, budget, result);
      }
      const state = mintState(
        { planId, method: 'changes.plan', inputDigest: computeInputDigest(args, budget) },
        binding,
      );
      return buildInputRequiredResult(serverInfo, budget, state, structuredContent);
    }
    const payload = verifyState(requestState, 'changes.plan', computeInputDigest(args, budget), binding);
    const resolution = await resolvePlanStatus(payload.planId, binding);
    switch (resolution.status) {
      case 'pending':
      case 'committing': {
        if (resolution.plan === undefined) {
          throw new TypeError('MCP Write adapter pending plan resolution requires a plan projection.');
        }
        return buildInputRequiredResult(
          serverInfo,
          budget,
          mintState({ planId: payload.planId, method: 'changes.plan', inputDigest: payload.inputDigest }, binding),
          resolution.plan,
        );
      }
      case 'approved': {
        if (resolution.plan === undefined) {
          throw new TypeError('MCP Write adapter approved plan resolution requires a plan projection.');
        }
        return buildCompleteResult(serverInfo, budget, Object.freeze({ structuredContent: resolution.plan }));
      }
      case 'consumed':
        throw rejectedWrite('plan_already_consumed');
      case 'expired':
        throw rejectedWrite('plan_expired');
      case 'cancelled':
        throw rejectedWrite('plan_cancelled');
      case 'unknown':
        throw rejectedWrite('plan_not_found');
    }
  };

  const handleCommit = async (
    trusted: McpTrustedWriteRequestContext,
    args: Readonly<Record<string, unknown>> | undefined,
    requestState: string | undefined,
  ): Promise<Mcp20260728Result> => {
    const binding = trusted.binding;
    const budget = trusted.budget;
    const digest = computeInputDigest(args, budget);
    if (requestState === undefined) {
      try {
        const result = await gateway.callTool('changes.commit', args, trusted);
        return buildCompleteResult(serverInfo, budget, result);
      } catch (error) {
        if (
          error instanceof McpChangePlanError
          && (error.code === 'plan_not_approved' || error.code === 'approval_missing')
        ) {
          const planId = readPlanId(args);
          const resolution = await resolvePlanStatus(planId, binding);
          switch (resolution.status) {
            case 'pending':
            case 'approved':
            case 'committing': {
              const state = mintState({ planId, method: 'changes.commit', inputDigest: digest }, binding);
              return buildInputRequiredResult(serverInfo, budget, state, resolution.plan);
            }
            case 'consumed':
              throw rejectedWrite('plan_already_consumed');
            case 'expired':
              throw rejectedWrite('plan_expired');
            case 'cancelled':
              throw rejectedWrite('plan_cancelled');
            case 'unknown':
              throw rejectedWrite('plan_not_found');
          }
        }
        throw mapWriteError(error, 'changes.commit');
      }
    }
    const payload = verifyState(requestState, 'changes.commit', digest, binding);
    const resolution = await resolvePlanStatus(payload.planId, binding);
    switch (resolution.status) {
      case 'pending':
      case 'committing': {
        if (resolution.plan === undefined) {
          throw new TypeError('MCP Write adapter pending plan resolution requires a plan projection.');
        }
        return buildInputRequiredResult(
          serverInfo,
          budget,
          mintState({ planId: payload.planId, method: 'changes.commit', inputDigest: payload.inputDigest }, binding),
          resolution.plan,
        );
      }
      case 'approved':
      case 'consumed': {
        try {
          const result = await gateway.callTool('changes.commit', args, trusted);
          return buildCompleteResult(serverInfo, budget, result);
        } catch (error) {
          throw mapWriteError(error, 'changes.commit');
        }
      }
      case 'expired':
        throw rejectedWrite('plan_expired');
      case 'cancelled':
        throw rejectedWrite('plan_cancelled');
      case 'unknown':
        throw rejectedWrite('plan_not_found');
    }
  };

  const listTools = async (
    context: Mcp20260728RequestContext,
    input?: unknown,
  ): Promise<Mcp20260728Result> => {
    const ctx = requireMcp20260728RequestContext(context);
    const trusted = toTrustedWriteContext(ctx);
    assertNotAborted(trusted.abortSignal);
    readCursorRequest(input);
    return buildToolResult(
      'tools/list',
      serverInfo,
      trusted.budget,
      Object.freeze({ tools: sortedModern }),
      cache['tools/list'],
    );
  };

  const callTool = async (
    context: Mcp20260728RequestContext,
    input?: unknown,
  ): Promise<Mcp20260728Result> => {
    const ctx = requireMcp20260728RequestContext(context);
    const trusted = toTrustedWriteContext(ctx);
    assertNotAborted(trusted.abortSignal);
    const request = readCallToolInput(input);
    validateInputResponses(request.inputResponses);
    try {
      if (request.name === 'changes.plan') {
        return await handlePlan(trusted, request.arguments, request.requestState);
      }
      if (request.name === 'changes.commit') {
        return await handleCommit(trusted, request.arguments, request.requestState);
      }
      return await handleNormal(trusted, request.name, request.arguments);
    } catch (error) {
      throw mapWriteError(error, request.name);
    }
  };

  const recordOutOfBandApproval = async (
    planId: string,
    context: Mcp20260728RequestContext,
  ): Promise<void> => {
    const ctx = requireMcp20260728RequestContext(context);
    const trusted = toTrustedWriteContext(ctx);
    assertNotAborted(trusted.abortSignal);
    try {
      await gateway.recordOutOfBandApproval(planId, trusted);
    } catch (error) {
      throw mapWriteError(error, 'changes.commit');
    }
  };

  return Object.freeze({
    listTools,
    callTool,
    recordOutOfBandApproval,
    transportRequirements: gateway.transportRequirements,
  });
}

function buildCompleteResult(
  serverInfo: Mcp20260728ServerInfo,
  budget: McpWriteInputBudget,
  result: McpWriteToolResult,
): Mcp20260728Result {
  const fields: Record<string, unknown> = {
    content: result.content === undefined ? [] : result.content,
  };
  if (result.structuredContent !== undefined) fields.structuredContent = result.structuredContent;
  if (result.isError !== undefined) fields.isError = result.isError;
  return buildToolResult('tools/call', serverInfo, budget, fields, undefined);
}

function buildInputRequiredResult(
  serverInfo: Mcp20260728ServerInfo,
  budget: McpWriteInputBudget,
  requestState: string,
  plan: unknown,
): Mcp20260728Result {
  const fields: Record<string, unknown> = {
    inputRequests: Object.freeze({}),
    requestState,
  };
  if (plan !== undefined) fields.plan = plan;
  return buildToolResult('tools/call', serverInfo, budget, fields, undefined, 'input_required');
}

function buildToolResult(
  method: 'tools/list' | 'tools/call',
  serverInfo: Mcp20260728ServerInfo,
  budget: McpWriteInputBudget,
  fields: Readonly<Record<string, unknown>>,
  cache: Mcp20260728CacheMetadata | undefined,
  resultType: 'complete' | 'input_required' = 'complete',
): Mcp20260728Result {
  const snapshot = snapshotMcpData(fields, budget) as Readonly<Record<string, unknown>>;
  if (!TOOL_RESULT_SCHEMAS[method].safeParse(snapshot).success) {
    throw new TypeError('MCP Write Tool adapter produced an invalid Modern result.');
  }
  return createMcp20260728Result({
    method,
    resultType,
    serverInfo,
    fields: snapshot,
    ...(cache !== undefined ? { cache } : {}),
  });
}

function readPlanId(args: unknown): string {
  if (typeof args === 'object' && args !== null && !Array.isArray(args) && !nodeTypes.isProxy(args)) {
    const planId = readOwnValue(args, 'planId');
    if (typeof planId === 'string' && planId.length > 0) return planId;
  }
  throw new Mcp20260728RequestError('invalid_params', 'Invalid MCP write commit arguments.', {
    code: 'invalid_plan_id',
  });
}

function rejectedWrite(code: string): Mcp20260728RequestError {
  return new Mcp20260728RequestError('invalid_params', 'MCP write operation rejected.', { code });
}

function validateInputResponses(responses: unknown): void {
  if (responses === undefined) return;
  if (
    typeof responses !== 'object'
    || responses === null
    || Array.isArray(responses)
    || nodeTypes.isProxy(responses)
  ) {
    throw new Mcp20260728RequestError(
      'invalid_params',
      'MCP write retry inputResponses must be an object map.',
      { code: 'invalid_input_responses' },
    );
  }
  for (const key of Reflect.ownKeys(responses)) {
    if (typeof key !== 'string') {
      throw new Mcp20260728RequestError(
        'invalid_params',
        'MCP write retry inputResponses keys must be strings.',
        { code: 'invalid_input_responses' },
      );
    }
    const descriptor = Object.getOwnPropertyDescriptor(responses, key);
    if (descriptor === undefined || !('value' in descriptor)) {
      throw new Mcp20260728RequestError(
        'invalid_params',
        'MCP write retry inputResponses entries must be own-data values.',
        { code: 'invalid_input_responses' },
      );
    }
    if (!isValidInputResponseEntry(descriptor.value)) {
      throw new Mcp20260728RequestError(
        'invalid_params',
        'MCP write retry inputResponses contains a malformed entry.',
        { code: 'invalid_input_responses' },
      );
    }
  }
}

/**
 * Mirrors the pinned SDK `inputResponse()` union detection: an entry is a
 * valid InputResponse when it is an ElicitResult (action accept/decline/
 * cancel), a ListRootsResult (`roots` array) or a CreateMessageResult
 * (`role` string + `content`). Well-formed entries for requests this server
 * never issued are otherwise ignored by the adapter.
 */
function isValidInputResponseEntry(entry: unknown): boolean {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry) || nodeTypes.isProxy(entry)) {
    return false;
  }
  const action = readOwnValue(entry, 'action');
  if (action === 'accept' || action === 'decline' || action === 'cancel') return true;
  const roots = readOwnValue(entry, 'roots');
  if (Array.isArray(roots)) return true;
  const role = readOwnValue(entry, 'role');
  const content = readOwnValue(entry, 'content');
  return typeof role === 'string' && content !== undefined;
}

function mapWriteError(error: unknown, toolName?: string): unknown {
  if (error instanceof Mcp20260728RequestError) return error;
  if (error instanceof McpWriteUnknownToolError) {
    return new Mcp20260728RequestError('invalid_params', 'Unknown MCP write Tool.');
  }
  if (error instanceof McpWriteBindingRequiredError) {
    return new Mcp20260728RequestError(
      'invalid_params',
      'MCP write Tools require a trusted per-request context.',
    );
  }
  if (error instanceof McpToolInputError) {
    const field = error.issues[0]?.instancePath.replace(/^\//u, '').replaceAll('/', '.')
      || undefined;
    const data: Record<string, unknown> = {
      code: 'invalid_params',
      nextTool: toolName ?? 'nodes.create',
    };
    if (field !== undefined && field.length > 0) data.field = field;
    if (toolName === 'nodes.create' || toolName === undefined) {
      data.allowedKinds = Object.freeze(['folder', 'bookmark']);
      data.allowedVisibilities = Object.freeze(['inherit', 'protected', 'private']);
    }
    return new Mcp20260728RequestError(
      'invalid_params',
      'Invalid MCP write Tool arguments.',
      Object.freeze(data),
    );
  }
  if (error instanceof McpChangePlanError) {
    return new Mcp20260728RequestError('invalid_params', 'MCP write operation rejected.', {
      code: error.code,
    });
  }
  return error;
}

function readCallToolInput(
  value: unknown,
): Readonly<{
  name: string;
  arguments?: Readonly<Record<string, unknown>>;
  inputResponses?: Readonly<Record<string, unknown>>;
  requestState?: string;
}> {
  assertExactDataObject(value, ['name'], ['arguments', 'inputResponses', 'requestState'], () => invalidParams('tool call'));
  const name = readOwnData(value, 'name', () => invalidParams('tool call'));
  if (typeof name !== 'string' || name.length === 0) throw invalidParams('tool call name');
  const args = readOptionalData(value, 'arguments');
  if (
    args !== undefined
    && (typeof args !== 'object' || args === null || Array.isArray(args) || nodeTypes.isProxy(args))
  ) {
    throw invalidParams('tool call arguments');
  }
  const responses = readOptionalData(value, 'inputResponses');
  if (
    responses !== undefined
    && (typeof responses !== 'object' || responses === null || Array.isArray(responses) || nodeTypes.isProxy(responses))
  ) {
    throw invalidParams('tool call inputResponses');
  }
  const state = readOptionalData(value, 'requestState');
  if (state !== undefined && typeof state !== 'string') {
    throw invalidParams('tool call requestState');
  }
  return Object.freeze({
    name,
    ...(args !== undefined ? { arguments: args as Readonly<Record<string, unknown>> } : {}),
    ...(responses !== undefined ? { inputResponses: responses as Readonly<Record<string, unknown>> } : {}),
    ...(state !== undefined ? { requestState: state } : {}),
  });
}

interface ToolEntry {
  readonly name: string;
  readonly modern: Readonly<Record<string, unknown>>;
}

function readToolEntries(
  gateway: McpWriteToolGateway,
  schemaBudget: Required<McpSchemaBudget>,
): ToolEntry[] {
  const definitions = gateway.listTools();
  if (!Array.isArray(definitions) || Object.getPrototypeOf(definitions) !== Array.prototype) {
    throw configError();
  }
  return definitions.map((definition: McpToolDefinition) => {
    assertExactDataObject(definition, ['name', 'description', 'inputSchema'], ['outputSchema'], configError);
    const name = readOwnData(definition, 'name', configError);
    const description = readOwnData(definition, 'description', configError);
    const inputSchema = readOwnData(definition, 'inputSchema', configError);
    const outputSchema = readOptionalData(definition, 'outputSchema');
    if (typeof name !== 'string' || name.length === 0) throw configError();
    if (typeof description !== 'string' || description.length === 0) throw configError();
    if (typeof inputSchema !== 'object' || inputSchema === null || Array.isArray(inputSchema)) {
      throw configError();
    }
    if (
      outputSchema !== undefined
      && (typeof outputSchema !== 'object' || outputSchema === null || Array.isArray(outputSchema))
    ) {
      throw configError();
    }
    assertMcpSchemaWithinBudget(inputSchema, schemaBudget);
    if (outputSchema !== undefined) assertMcpSchemaWithinBudget(outputSchema, schemaBudget);
    const modern: Readonly<Record<string, unknown>> = Object.freeze({
      name,
      description,
      inputSchema: inputSchema as McpToolInputSchema,
      ...(outputSchema !== undefined ? { outputSchema: outputSchema as McpToolOutputSchema } : {}),
    });
    if (!ToolSchema.safeParse(modern).success) {
      throw configError();
    }
    return Object.freeze({ name, modern });
  });
}

function resolveSchemaBudget(options: Mcp20260728WriteToolAdapterOptions): Required<McpSchemaBudget> {
  const raw = readOwnValue(options, 'schemaBudget');
  if (raw === undefined) return DEFAULT_MCP_SCHEMA_BUDGET;
  return resolveMcpSchemaBudget(raw as McpSchemaBudget);
}

function readServerInfo(options: Mcp20260728WriteToolAdapterOptions): Mcp20260728ServerInfo {
  const raw = readOwnValue(options, 'serverInfo', configError);
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw) || nodeTypes.isProxy(raw)) {
    throw configError();
  }
  const parsed = ImplementationSchema.safeParse(raw);
  if (!parsed.success) throw configError();
  return Object.freeze(snapshotMcpData(parsed.data) as Mcp20260728ServerInfo);
}

function readResolvePlan(options: Mcp20260728WriteToolAdapterOptions): Mcp20260728WritePlanStatusPort {
  const raw = readOwnValue(options, 'resolvePlan', configError);
  assertExactDataObject(raw, ['resolvePlan'], [], configError);
  const fn = readOwnData(raw, 'resolvePlan', configError);
  if (typeof fn !== 'function' || nodeTypes.isProxy(fn)) throw configError();
  return raw as Mcp20260728WritePlanStatusPort;
}

function readRequestStateKey(options: Mcp20260728WriteToolAdapterOptions): Uint8Array {
  const raw = readOwnValue(options, 'requestStateKey', configError);
  let bytes: Uint8Array;
  if (typeof raw === 'string') {
    bytes = new TextEncoder().encode(raw);
  } else if (raw instanceof Uint8Array) {
    bytes = raw;
  } else {
    throw configError();
  }
  if (bytes.byteLength < 32) throw configError();
  return bytes;
}

function readRequestStateTtlSeconds(options: Mcp20260728WriteToolAdapterOptions): number {
  const raw = readOwnValue(options, 'requestStateTtlSeconds');
  if (raw === undefined) return DEFAULT_REQUEST_STATE_TTL_SECONDS;
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw <= 0) throw configError();
  return raw;
}

function readRequestStateClock(options: Mcp20260728WriteToolAdapterOptions): () => number {
  const raw = readOwnValue(options, 'requestStateClock');
  if (raw === undefined) return Date.now;
  if (typeof raw !== 'function' || nodeTypes.isProxy(raw)) throw configError();
  return raw as () => number;
}

function readCache(
  options: Mcp20260728WriteToolAdapterOptions,
): Readonly<Partial<Record<'tools/list', Mcp20260728CacheMetadata>>> {
  const raw = readOwnValue(options, 'cache');
  if (raw === undefined) return Object.freeze({});
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw) || nodeTypes.isProxy(raw)) {
    throw configError();
  }
  const keys = Reflect.ownKeys(raw);
  if (keys.some((key) => typeof key !== 'string' || key !== 'tools/list')) throw configError();
  const descriptor = Object.getOwnPropertyDescriptor(raw, 'tools/list');
  if (descriptor === undefined || !('value' in descriptor) || descriptor.value === undefined) {
    return Object.freeze({});
  }
  return Object.freeze({ 'tools/list': validateCacheMetadata(descriptor.value) });
}

function validateCacheMetadata(raw: unknown): Mcp20260728CacheMetadata {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw) || nodeTypes.isProxy(raw)) {
    throw configError();
  }
  const record = raw as Readonly<Record<string, unknown>>;
  const ttlMs = readOwnValue(record, 'ttlMs', configError);
  const cacheScope = readOwnValue(record, 'cacheScope', configError);
  if (typeof ttlMs !== 'number' || !Number.isSafeInteger(ttlMs) || ttlMs < 0) throw configError();
  if (cacheScope !== 'public' && cacheScope !== 'private') throw configError();
  return Object.freeze({ ttlMs, cacheScope });
}

function readCursorRequest(value: unknown): void {
  if (value === undefined) return;
  assertExactDataObject(value, [], ['cursor'], () => invalidParams('tool list cursor'));
  const cursor = readOptionalData(value, 'cursor');
  if (cursor !== undefined && (typeof cursor !== 'string' || cursor.length === 0)) {
    throw invalidParams('tool list cursor');
  }
}

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new McpWriteRequestAbortedError();
  }
}

function invalidParams(message: string): Mcp20260728RequestError {
  return new Mcp20260728RequestError('invalid_params', `Invalid ${message}.`);
}

function configError(): TypeError {
  return new TypeError('Invalid Modern MCP Write Tool adapter configuration.');
}

function assertExactDataObject(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
  fail: () => Error = configError,
): asserts value is object {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || nodeTypes.isProxy(value)) {
    throw fail();
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw fail();
  const allowed = new Set([...required, ...optional]);
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== 'string' || !allowed.has(key))) throw fail();
  if (required.some((key) => !keys.includes(key))) throw fail();
  for (const key of keys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !('value' in descriptor)) throw fail();
  }
}

function readOwnValue(value: object, name: string, fail: () => Error = configError): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, name);
  if (descriptor === undefined) return undefined;
  if (!('value' in descriptor)) throw fail();
  return descriptor.value;
}

function readOptionalOwnValue(value: object, name: string): unknown {
  return readOwnValue(value, name);
}

function readOwnData(value: object, name: string, fail: () => Error = configError): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, name);
  if (descriptor === undefined || !('value' in descriptor)) throw fail();
  return descriptor.value;
}

function readOptionalData(value: object, name: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, name);
  if (descriptor === undefined || !('value' in descriptor)) return undefined;
  return descriptor.value;
}


