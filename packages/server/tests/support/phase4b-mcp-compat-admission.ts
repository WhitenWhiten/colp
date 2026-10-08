/**
 * Shared Fastify inject harness for T-03/T-04 MCP compat admission tests.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { loadConfig } from './test-config.js';
import {
  MCP_COMPAT_AUTH_TOKEN_SENTINEL,
  MCP_COMPAT_ENDPOINT_PATH,
  MCP_COMPAT_NEGOTIATED_PROTOCOL_VERSION,
  MCP_COMPAT_ONERROR_CLASSIFIER,
  MCP_COMPAT_PROTOCOL_VERSION_REJECT_MESSAGE,
  MCP_COMPAT_UNSUPPORTED_PROTOCOL_RPC_CODE,
  PHASE4B_MCP_CONFIG_ENDPOINT_PATH,
  createMcpOauthVerifier,
  createPhase4bMcpChangeSignalSource,
  createPhase4bMcpCompatOperations,
  createPhase4bMcpReadOperations,
  type McpApplicationFacade,
  type McpOauthVerifier,
  type Phase4bMcpCollectionResourceProjection,
  type Phase4bMcpCompatOperations,
  type Phase4bMcpNodeResourceProjection,
  type Phase4bMcpReadOperations,
  type Phase4bMcpSnapshotResourceProjection,
} from '../../src/modules/mcp/index.js';
import { emptyReadToolAdapterBundle } from './phase4b-mcp-read-tools-fixture.js';
import { InMemoryMetrics } from '../../src/infrastructure/telemetry/index.js';
import type { McpRateLimiter } from '../../src/infrastructure/rate-limit/index.js';
import { buildApiApp } from '../../src/transport/app.js';
import type { McpCompatVerifiedAdmission } from '../../src/transport/mcp/mcp-compat-admission.js';
import type { McpReadTransportDependencies } from '../../src/transport/mcp/mcp-read-routes.js';
import {
  emptyNodeResourceProjection,
  emptyResourceProjection,
  emptySnapshotResourceProjection,
  mcpEnv,
  AUDIENCE,
  modernBody,
  MCP_TEST_REQUEST_HOST,
  createKeyFixture,
  mintCredential,
  staticJwksProvider,
  verifierOptions,
} from './phase4b-mcp-transport-scaffold.js';
import {
  asMcpCompatJsonRpc,
  mcpCompatAcceptHeaders,
  parseMcpCompatHttpPayload,
} from './phase4b-mcp-compat-spike.js';

export {
  MCP_COMPAT_CANARY_BEARER,
  asMcpCompatJsonRpc,
} from './phase4b-mcp-compat-spike.js';

export interface CompatSdkFactoryObservation {
  readonly hasRequestInfo: boolean;
  readonly authorizationHeader: string | null;
  readonly token: string | undefined;
}

export interface CompatPostVerifierAuthorization {
  readonly fastify: string | string[] | undefined;
  readonly raw: string | string[] | undefined;
  readonly fastifyPresent: boolean;
  readonly rawPresent: boolean;
}

export interface CompatAdmissionServer {
  readonly app: FastifyInstance;
  readonly config: ReturnType<typeof loadConfig>;
  readonly admissions: McpCompatVerifiedAdmission[];
  readonly sdkFactoryCalls: { count: number };
  readonly sdkFactoryObservations: CompatSdkFactoryObservation[];
  readonly postVerifierAuthorization: CompatPostVerifierAuthorization[];
  readonly metricNames: string[];
  readonly metrics: InMemoryMetrics;
  readonly operations: Phase4bMcpCompatOperations | undefined;
}

function readyOauthHealth() {
  return async () => ({
    oauth: 'ready' as const,
    signalSource: 'ready' as const,
    projection: 'ready' as const,
  });
}

export function startCompatApp(input: {
  readonly env?: Record<string, string | undefined>;
  readonly mcpReadTransport?: McpReadTransportDependencies;
  readonly mcpRateLimiter?: McpRateLimiter;
  readonly compatEnabled?: boolean;
  readonly writeEnabled?: boolean;
  readonly mcpReadResourceProjection?: Phase4bMcpCollectionResourceProjection;
  readonly mcpNodeResourceProjection?: Phase4bMcpNodeResourceProjection;
  readonly mcpSnapshotResourceProjection?: Phase4bMcpSnapshotResourceProjection;
  readonly mcpReadOperations?: Phase4bMcpReadOperations;
  readonly mcpCompatOperations?: Phase4bMcpCompatOperations;
} = {}): CompatAdmissionServer {
  const metricNames: string[] = [];
  const admissions: McpCompatVerifiedAdmission[] = [];
  const sdkFactoryCalls = { count: 0 };
  const sdkFactoryObservations: CompatSdkFactoryObservation[] = [];
  const postVerifierAuthorization: CompatPostVerifierAuthorization[] = [];
  const writeAdapterPresent = input.mcpReadTransport?.writeToolAdapter !== undefined;
  const env = mcpEnv({
    KNOWN_FEATURE_MCP_COMPAT: input.compatEnabled === false ? 'false' : 'true',
    ...(input.writeEnabled === true || writeAdapterPresent
      ? { KNOWN_FEATURE_MCP_WRITE: 'true' }
      : {}),
    ...input.env,
  });
  const config = loadConfig(env);
  const toolAdapter = emptyReadToolAdapterBundle();
  const metrics = new InMemoryMetrics({
    onIncrement: (name) => {
      metricNames.push(name);
    },
  });
  const transport: McpReadTransportDependencies = {
    changeSignalSource: createPhase4bMcpChangeSignalSource(),
    readToolAdapter: toolAdapter.adapter,
    readToolParamDeclarations: toolAdapter.paramDeclarations,
    ...input.mcpReadTransport,
    dependencyHealth: input.mcpReadTransport?.dependencyHealth ?? readyOauthHealth(),
    compatOnAdmitted: (admission, request) => {
      admissions.push(admission);
      postVerifierAuthorization.push(snapshotPostVerifierAuthorization(request));
      input.mcpReadTransport?.compatOnAdmitted?.(admission, request);
    },
    compatOnSdkFactory: (ctx) => {
      sdkFactoryCalls.count += 1;
      sdkFactoryObservations.push({
        hasRequestInfo: ctx.requestInfo instanceof Request,
        authorizationHeader: ctx.requestInfo?.headers.get('authorization') ?? null,
        token: ctx.authInfo?.token,
      });
      input.mcpReadTransport?.compatOnSdkFactory?.(ctx);
    },
  };
  const mcpReadOperations = input.mcpReadOperations ?? createPhase4bMcpReadOperations({
    metrics,
    maxConcurrentRequests: config.mcp?.budgets.request.maxConcurrent ?? 4,
    maxQueuedRequests: config.mcp?.budgets.request.maxQueue ?? 1,
    maxListeners: config.mcp?.budgets.listen.maxConnections ?? 1,
    dependencyHealth: transport.dependencyHealth,
  });
  const mcpCompatOperations = input.compatEnabled === false
    ? undefined
    : input.mcpCompatOperations ?? createPhase4bMcpCompatOperations({
      metrics,
      maxConcurrentRequests: config.mcp?.budgets.request.maxConcurrent ?? 4,
      maxQueuedRequests: config.mcp?.budgets.request.maxQueue ?? 1,
      writeEnabled: input.writeEnabled === true || writeAdapterPresent,
      oauthHealth: transport.dependencyHealth,
      limiterHealth: () => {
        const limiter = input.mcpRateLimiter ?? input.mcpReadTransport?.requestRateLimiter;
        if (limiter === undefined) return 'ready';
        return limiter.readiness().status === 'healthy' ? 'ready' : 'unavailable';
      },
      ...((input.writeEnabled === true || writeAdapterPresent)
        ? { approvalHealth: async () => 'ready' as const }
        : {}),
    });
  const app = buildApiApp({
    config,
    metrics,
    mcpReadOperations,
    ...(mcpCompatOperations === undefined ? {} : { mcpCompatOperations }),
    mcpReadTransport: transport,
    mcpReadResourceProjection: input.mcpReadResourceProjection ?? emptyResourceProjection(),
    mcpNodeResourceProjection: input.mcpNodeResourceProjection ?? emptyNodeResourceProjection(),
    mcpSnapshotResourceProjection: input.mcpSnapshotResourceProjection ?? emptySnapshotResourceProjection(),
    ...(input.mcpRateLimiter === undefined ? {} : { mcpRateLimiter: input.mcpRateLimiter }),
  });
  return {
    app,
    config,
    admissions,
    sdkFactoryCalls,
    sdkFactoryObservations,
    postVerifierAuthorization,
    metricNames,
    metrics,
    operations: mcpCompatOperations,
  };
}

function snapshotPostVerifierAuthorization(request: FastifyRequest): CompatPostVerifierAuthorization {
  return {
    fastify: request.headers.authorization,
    raw: request.raw.headers.authorization,
    fastifyPresent: Object.keys(request.headers).some((key) => key.toLowerCase() === 'authorization'),
    rawPresent: Object.keys(request.raw.headers).some((key) => key.toLowerCase() === 'authorization'),
  };
}

export function compatRpc(
  method: string,
  id: number | string | null = 1,
  params: Record<string, unknown> = {},
): Record<string, unknown> {
  return { jsonrpc: '2.0', id, method, params };
}

export function injectCompatPost(
  app: FastifyInstance,
  payload: unknown,
  headers: Record<string, string> = {},
): ReturnType<FastifyInstance['inject']> {
  return app.inject({
    method: 'POST',
    url: MCP_COMPAT_ENDPOINT_PATH,
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': MCP_COMPAT_NEGOTIATED_PROTOCOL_VERSION,
      host: MCP_TEST_REQUEST_HOST,
      ...headers,
    },
    payload,
  });
}

export function injectStrictPost(
  app: FastifyInstance,
  method: string,
  id: number | string | null,
  headers: Record<string, string> = {},
  body?: string,
): ReturnType<FastifyInstance['inject']> {
  return app.inject({
    method: 'POST',
    url: PHASE4B_MCP_CONFIG_ENDPOINT_PATH,
    headers: {
      'content-type': 'application/json',
      'mcp-method': method,
      'mcp-protocol-version': '2026-07-28',
      accept: 'application/json;q=1, text/event-stream;q=0.5',
      host: MCP_TEST_REQUEST_HOST,
      ...headers,
    },
    payload: body ?? modernBody(method, id),
  });
}

export function collectTaint(values: readonly unknown[]): string {
  return values.map((value) => {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }).join('\n');
}

export function injectCompatLegacyPost(
  app: FastifyInstance,
  payload: unknown,
  protocolVersion?: string,
  extraHeaders: Record<string, string> = {},
): ReturnType<FastifyInstance['inject']> {
  if (protocolVersion === undefined) {
    return app.inject({
      method: 'POST',
      url: MCP_COMPAT_ENDPOINT_PATH,
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        host: MCP_TEST_REQUEST_HOST,
        ...mcpCompatAcceptHeaders(),
        ...extraHeaders,
      },
      payload,
    });
  }
  return injectCompatPost(app, payload, {
    ...mcpCompatAcceptHeaders(protocolVersion),
    ...extraHeaders,
  });
}

export function parseCompatHttp(response: {
  readonly headers: Record<string, unknown>;
  readonly payload: string;
}): unknown {
  return parseMcpCompatHttpPayload(
    String(response.headers['content-type'] ?? ''),
    response.payload,
  );
}

export function assertCompatNegotiatedVersionHeader(
  headers: Record<string, unknown>,
): void {
  const value = headers['mcp-protocol-version'];
  assert.equal(Array.isArray(value), false, 'MCP-Protocol-Version must be a single header');
  assert.equal(value, MCP_COMPAT_NEGOTIATED_PROTOCOL_VERSION);
  assert.notEqual(value, '2025-06-18');
}

export function assertCompatProtocolVersionRejected(
  response: {
    readonly statusCode: number;
    readonly headers: Record<string, unknown>;
    readonly payload: string;
  },
  server: Pick<CompatAdmissionServer, 'admissions' | 'sdkFactoryCalls'>,
  capture?: CompatPingCapture,
): ReturnType<typeof asMcpCompatJsonRpc> {
  assert.equal(response.statusCode, 400);
  const rpc = compatJsonRpc(response);
  assert.equal(rpc.error?.code, MCP_COMPAT_UNSUPPORTED_PROTOCOL_RPC_CODE);
  assert.equal(rpc.error?.message, MCP_COMPAT_PROTOCOL_VERSION_REJECT_MESSAGE);
  assert.doesNotMatch(response.payload, /Bearer |canary|token=/iu);
  assert.equal(server.admissions.length, 0);
  assert.equal(server.sdkFactoryCalls.count, 0);
  if (capture !== undefined) {
    assert.equal(capture.listCalls, 0);
    assert.equal(capture.callCalls, 0);
    assert.equal(capture.resourceLists, 0);
    assert.equal(capture.resourceReads, 0);
  }
  return rpc;
}

export function compatJsonRpc(response: {
  readonly headers: Record<string, unknown>;
  readonly payload: string;
}): ReturnType<typeof asMcpCompatJsonRpc> {
  return asMcpCompatJsonRpc(parseCompatHttp(response));
}

export interface CompatPingCapture {
  listCalls: number;
  callCalls: number;
  resourceLists: number;
  resourceReads: number;
  slowStarted: boolean;
  aborted: boolean;
}

export function createCompatPingCapture(): CompatPingCapture {
  return {
    listCalls: 0,
    callCalls: 0,
    resourceLists: 0,
    resourceReads: 0,
    slowStarted: false,
    aborted: false,
  };
}

const ERA_WIRE_FIELD_NAMES = [
  '_meta',
  'resultType',
  'cache',
  'ttlMs',
  'cacheScope',
  'serverInfo',
] as const;

const CALL_TOOL_ENVELOPE_FORBIDDEN = [
  ...ERA_WIRE_FIELD_NAMES,
  'requestState',
  'inputRequests',
] as const;

export function assertNo0728WireFields(value: unknown, label = 'legacy payload'): void {
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const entry of value) assertNo0728WireFields(entry, label);
    return;
  }
  const record = value as Record<string, unknown>;
  for (const key of ERA_WIRE_FIELD_NAMES) {
    assert.equal(key in record, false, `${label} must not include ${key}`);
  }
  for (const [key, child] of Object.entries(record)) {
    if (key === 'structuredContent' || key === 'contents' || key === 'resources'
      || key === 'resourceTemplates' || key === 'tools' || key === 'content') {
      assertNo0728WireFields(child, label);
    }
  }
}

export function assertCompatCallToolEnvelope(
  result: Record<string, unknown> | undefined,
  label = 'compat call result',
): void {
  assert.ok(result, `${label} must be present`);
  for (const key of CALL_TOOL_ENVELOPE_FORBIDDEN) {
    assert.equal(key in result, false, `${label} must not include ${key}`);
  }
}

export function pingMcpApplicationFacade(
  capture: CompatPingCapture = createCompatPingCapture(),
  options: { readonly slow?: boolean } = {},
): McpApplicationFacade {
  return Object.freeze({
    async listTools() {
      capture.listCalls += 1;
      return Object.freeze({
        tools: Object.freeze([
          Object.freeze({
            name: 'compat.ping',
            description: 'T-04 ping tool',
            inputSchema: Object.freeze({ type: 'object', additionalProperties: false }),
            requiredScopes: Object.freeze([]),
          }),
        ]),
      });
    },
    async callTool(context, name, _args) {
      capture.callCalls += 1;
      if (name !== 'compat.ping') {
        return Object.freeze({
          kind: 'rejected' as const,
          stableCode: 'unknown_tool',
          safeMessage: 'Unknown tool.',
          retryable: false,
        });
      }
      if (options.slow === true) {
        capture.slowStarted = true;
        await new Promise<void>((_resolve, reject) => {
          const abort = (): void => {
            capture.aborted = true;
            reject(new Error('aborted'));
          };
          if (context.abortSignal.aborted) {
            abort();
            return;
          }
          context.abortSignal.addEventListener('abort', abort, { once: true });
        });
      }
      return Object.freeze({
        kind: 'complete' as const,
        content: Object.freeze([{ type: 'text', text: 'pong' }]),
      });
    },
    async listResources() {
      capture.resourceLists += 1;
      return Object.freeze({ resources: Object.freeze([]) });
    },
    async listResourceTemplates() {
      return Object.freeze({ resourceTemplates: Object.freeze([]) });
    },
    async readResource() {
      capture.resourceReads += 1;
      return Object.freeze({
        contents: Object.freeze([
          Object.freeze({ uri: 'compat://ping', mimeType: 'text/plain', text: 'pong' }),
        ]),
      });
    },
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

export async function mintProductionCompatCanaryAuth(): Promise<{
  readonly token: string;
  readonly verifier: McpOauthVerifier;
  readonly verifierInputs: string[];
  readonly recordingVerifier: McpOauthVerifier;
}> {
  const key = await createKeyFixture(`key-cq09-${randomUUID()}`);
  const token = await mintCredential({
    key: key.privateKey,
    kid: key.kid,
    jti: `mcp-cq-09-${randomUUID()}`,
    audience: `${AUDIENCE}-compat`,
  });
  const verifier = createMcpOauthVerifier(verifierOptions({
    jwks: staticJwksProvider([key.jwk]),
    audience: [AUDIENCE, `${AUDIENCE}-compat`],
  }));
  const verifierInputs: string[] = [];
  const recordingVerifier: McpOauthVerifier = {
    async verify(input) {
      verifierInputs.push(
        typeof input.authorization === 'string'
          ? input.authorization
          : JSON.stringify(input.authorization),
      );
      return verifier.verify(input);
    },
  };
  return { token, verifier, verifierInputs, recordingVerifier };
}

/** Endpoint-specific signed tokens share a principal and quota, never an audience. */
export async function compatAuthFixture() {
  const key = await createKeyFixture('key-compat-auth');
  const token = await mintCredential({ key: key.privateKey, kid: key.kid, audience: `${AUDIENCE}-compat` });
  const strictToken = await mintCredential({ key: key.privateKey, kid: key.kid, audience: AUDIENCE });
  const verifier = createMcpOauthVerifier(verifierOptions({
    jwks: staticJwksProvider([key.jwk]), audience: [AUDIENCE, `${AUDIENCE}-compat`],
  }));
  return { token, strictToken, verifier };
}

export function withFacadeTaintCapture(
  facade: McpApplicationFacade,
  blobs: string[],
): McpApplicationFacade {
  const tap = (value: unknown): void => {
    try {
      blobs.push(JSON.stringify(value));
    } catch {
      blobs.push(String(value));
    }
  };
  return Object.freeze({
    async listTools(context, cursor) {
      tap([context, cursor]);
      return facade.listTools(context, cursor);
    },
    async callTool(context, name, args) {
      tap([context, name, args]);
      return facade.callTool(context, name, args);
    },
    async listResources(context, cursor) {
      tap([context, cursor]);
      return facade.listResources(context, cursor);
    },
    async listResourceTemplates(context) {
      tap(context);
      return facade.listResourceTemplates(context);
    },
    async readResource(context, uri) {
      tap([context, uri]);
      return facade.readResource(context, uri);
    },
  });
}

/**
 * MCP-CQ-09 production-route bearer isolation. `toWebRequest` copies
 * `Object.entries(req.headers)`. If `dropAuthorizationHeader` is skipped,
 * `request.raw.headers.authorization` remains after the verifier and the SDK
 * Request carries the canary — the header-map and SDK Request assertions
 * below must fail in that case. Node `rawHeaders` may still hold original
 * bytes and is not treated as taint.
 */
export function assertProductionCompatBearerDropped(input: {
  readonly canary: string;
  readonly verifierInputs: readonly string[];
  readonly server: CompatAdmissionServer;
  readonly facadeTaint?: readonly string[];
  readonly onerror?: readonly unknown[];
  readonly response?: { readonly payload: string; readonly headers: Record<string, unknown> };
}): void {
  const canaryPattern = new RegExp(escapeRegExp(input.canary), 'u');
  assert.deepEqual(input.verifierInputs, [`Bearer ${input.canary}`]);
  assert.ok(input.server.postVerifierAuthorization.length >= 1);
  for (const snapshot of input.server.postVerifierAuthorization) {
    assert.equal(snapshot.fastify, undefined);
    assert.equal(snapshot.raw, undefined);
    assert.equal(snapshot.fastifyPresent, false);
    assert.equal(snapshot.rawPresent, false);
  }
  assert.ok(input.server.sdkFactoryCalls.count >= 1);
  assert.ok(input.server.sdkFactoryObservations.length >= 1);
  for (const observed of input.server.sdkFactoryObservations) {
    assert.equal(observed.hasRequestInfo, true);
    assert.equal(observed.authorizationHeader, null);
    if (observed.token !== undefined) {
      assert.equal(observed.token, MCP_COMPAT_AUTH_TOKEN_SENTINEL);
      assert.notEqual(observed.token, input.canary);
    }
  }
  for (const admission of input.server.admissions) {
    assert.equal(admission.authInfo.token, MCP_COMPAT_AUTH_TOKEN_SENTINEL);
  }
  const blob = collectTaint([
    input.server.admissions,
    input.server.metricNames,
    input.facadeTaint ?? [],
    input.onerror ?? [],
    MCP_COMPAT_ONERROR_CLASSIFIER,
    input.response?.payload,
    input.response?.headers,
    input.server.sdkFactoryObservations,
    input.server.postVerifierAuthorization,
  ]);
  assert.doesNotMatch(blob, canaryPattern);
}
