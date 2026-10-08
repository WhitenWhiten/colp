/**
 * P4B-R06 production MCP Streamable HTTP transport.
 *
 * This module owns the single POST-only `/collections/-/mcp` Fastify surface.
 * It combines raw ingress budgets, Origin allowlisting, R03 token-free OAuth
 * evidence, R05 request-context/discovery composition, R07 stable Resource
 * identity and template/result shells, bounded FIFO dispatch,
 * per-request timeout/abort, JSON/SSE negotiation and response headers. It is
 * intentionally protocol mapping only: it never reads business tables, never
 * retains raw request bodies or bearer tokens, and never exposes SDK stack
 * traces in responses.
 *
 * Production OAuth revocation/security-epoch ports do not exist yet, so the
 * route accepts a narrow injected `McpReadTransportDependencies` seam. When no
 * verifier is wired, anonymous Modern calls still work and authenticated calls
 * fail closed with a stable 503 instead of pretending revocation is checked.
 */
import type { ServerResponse } from 'node:http';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  createMcp20260728SubscriptionsListenAdapter,
  ListResourcesResultSchema,
  McpReadRequestContextError,
  McpResourceNotFoundError,
  McpToolOutputUnavailableError,
  ReadResourceResultSchema,
  createAnonymousPublicBinding,
  createMcp20260728ResourceAdapter,
  createMcpStatelessReadCore,
  requireMcp20260728RequestContext,
  requireTrustedReadRequestContext,
  type Mcp20260728DiscoverResult,
  type Mcp20260728CacheMetadata,
  type Mcp20260728RequestContext,
  type Mcp20260728ReadToolAdapter,
  type Mcp20260728Result,
  type Mcp20260728WriteToolAdapter,
  type Mcp20260728WireError,
  type Mcp20260728XMcpHeaderDeclaration,
  type McpAuthorizationBinding,
  type McpResourceListResult,
  type McpResourceReadResult,
  type McpResourceReadBudget,
  type McpStatelessReadCore,
  type Mcp20260728SubscriptionsListenAdapter,
  type Mcp20260728SubscriptionsListenSession,
} from '@know-n/colp/mcp';
import {
  Mcp20260728RequestError,
  PHASE4B_MCP_DISCOVERY_CAPABILITIES,
  PHASE4B_MCP_RESOURCE_TEMPLATES_CACHE_METADATA,
  resolvePhase4bMcpServerInfo,
  assertMcpReadFeatureConfig,
  createPhase4bMcpDiscoverResult,
  createPhase4bMcpResourceIdentity,
  createPhase4bMcpRequestContext,
  createPhase4bMcpResult,
  normalizePhase4bMcpError,
  requirePhase4bMcpClientCapability,
  validatePhase4bMcpDiscoverRequest,
  McpOauthVerificationError,
  requiredScopesForMcpReadOperation,
  createPhase4bMcpReadOperations,
  mergePhase4bMcpParamDeclarations,
  isPhase4bMcpLegacyBodyMethod,
  MCP_ACCOUNT_SUBJECT_ID_AUTHORIZATION_KEY,
  runWithMcpAccountSubjectId,
  classifyPhase4bMcpWriteError,
  toPhase4bMcpWriteRequestError,
  writeErrorHintFrom,
  type McpApplicationFacade,
  type Phase4bMcpReadBudgetBucket,
  type Phase4bMcpReadFailureCategory,
  type Phase4bMcpReadDependencyHealth,
  type Phase4bMcpLegacyRejectionCategory,
  type Phase4bMcpReadOperations,
  type Phase4bMcpReadResourceKind,
  type McpOauthVerifier,
  type Phase4bMcpResourceIdentity,
  type Phase4bMcpCollectionResourceProjection,
  type Phase4bMcpNodeResourceProjection,
  type Phase4bMcpSnapshotResourceProjection,
  type McpReadFeatureConfig,
  type McpReadFeatureConfigAssertOptions,
  type Phase4bMcpChangeSignalSource,
} from '../../modules/mcp/index.js';
import { InMemoryMetrics } from '../../infrastructure/telemetry/index.js';
import {
  createMemoryMcpRateLimiter,
  type McpRateLimiter,
} from '../../infrastructure/rate-limit/index.js';
import { mapMcpOauthChallengeToProductError } from './mcp-protected-resource-routes.js';
import { ProductHttpError, productErrorEnvelope } from '../product-error.js';
import {
  createPhase4bMcpApplicationFacadeFromColpAdapters,
  dispatchStrictToolCall,
  listStrictApplicationResourceTemplates,
  listStrictApplicationTools,
  readCatalogCursor,
} from './mcp-strict-application-adapter.js';
import {
  admitMcpHost,
  applyMcpSecurityHeaders,
  createConnectionBudget,
  headerBudgetViolation,
  mcpRateLimitSubject,
  mcpTrustedHostAuthority,
  readMcpHeaderPairs,
  singleMcpHeader,
  type McpConnectionBudget,
} from './mcp-shared-admission.js';
import type { McpCompatVerifiedAdmission } from './mcp-compat-admission.js';

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const JSON_MEDIA_TYPE = 'application/json';
const SSE_MEDIA_TYPE = 'text/event-stream';
const NO_PARAM_DECLARATIONS: readonly Mcp20260728XMcpHeaderDeclaration[] = Object.freeze([]);

/** Narrow production seam for R06 authenticated/timeout composition. */
export interface McpReadTransportDependencies {
  /** P4B-R13 bounded operations registry/readiness seam. */
  readonly operations?: Phase4bMcpReadOperations;
  /** P4B-R13 dependency health used by the feature readiness probe. */
  readonly dependencyHealth?: () => Promise<Phase4bMcpReadDependencyHealth>;
  /** P4B-R11 non-durable change-signal source; required for MCP Read. */
  readonly changeSignalSource?: Phase4bMcpChangeSignalSource;
  /** P4B-R08 real Collection Resource projection; required for MCP Read. */
  readonly resourceProjection?: Phase4bMcpCollectionResourceProjection;
  /** P4B-R10 real Node Resource projection; required for MCP Read. */
  readonly nodeResourceProjection?: Phase4bMcpNodeResourceProjection;
  /** P4B-R09 real Snapshot Resource projection; required for MCP Read. */
  readonly snapshotResourceProjection?: Phase4bMcpSnapshotResourceProjection;
  /** P4B-R12 Modern Read Tool adapter; required for MCP Read. */
  readonly readToolAdapter?: Mcp20260728ReadToolAdapter;
  /** P4B-R12 static `x-mcp-header` declarations for mounted Tools. */
  readonly readToolParamDeclarations?: readonly Mcp20260728XMcpHeaderDeclaration[];
  /** MCP-W06 Modern Write Tool adapter; when absent, only Read Tools are mounted. */
  readonly writeToolAdapter?: Mcp20260728WriteToolAdapter;
  /** MCP-W06 static `x-mcp-header` declarations for mounted Write Tools. */
  readonly writeToolParamDeclarations?: readonly Mcp20260728XMcpHeaderDeclaration[];
  /** Era-neutral application facade; when omitted, the route composes one. */
  readonly applicationFacade?: McpApplicationFacade;
  /** R03 verifier; absent means authenticated requests fail closed. */
  readonly oauthVerifier?: McpOauthVerifier;
  /** Current security epoch for anonymous bindings. Defaults to `public`. */
  readonly securityEpoch?: () => string | Promise<string>;
  /** Per-request MCP timeout. Defaults to 15s. */
  readonly requestTimeoutMs?: number;
  /**
   * Per-principal/client/IP MCP request admission limiter (FIX-M-018 unified
   * MCP rate-limit port, `request` policy); defaults to the in-process
   * adapter from config, which is refused when the shared adapter is
   * configured but not injected (composition guard).
   */
  readonly requestRateLimiter?: McpRateLimiter;
  /**
   * Shared in-process request concurrency/queue budget. When omitted the
   * route creates a private budget; composition injects one instance so
   * strict and compat share slots.
   */
  readonly requestConnectionBudget?: McpConnectionBudget;
  /** Test/host hook after compat admission (ignored by the strict route). */
  readonly compatOnAdmitted?: (
    admission: McpCompatVerifiedAdmission,
    request: FastifyRequest,
  ) => void;
  /** Test/host hook when the compat SDK factory is invoked (ignored by strict). */
  readonly compatOnSdkFactory?: (ctx: {
    readonly authInfo?: { readonly token?: string };
    readonly requestInfo?: Request;
  }) => void;
  /** When true, discovery and results stamp `Known MCP` instead of `Known MCP Read`. */
  readonly writeEnabled?: boolean;
}

class McpReadHttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'McpReadHttpError';
  }
}

interface McpResourceHandlers {
  readonly listResources: (
    context: Mcp20260728RequestContext,
    input?: unknown,
  ) => Promise<Mcp20260728Result>;
  readonly readResource: (
    context: Mcp20260728RequestContext,
    input?: unknown,
  ) => Promise<Mcp20260728Result>;
}

/** Registers only POST at the frozen MCP endpoint in the production composition. */
export function registerMcpReadRoutes(
  app: FastifyInstance,
  config: McpReadFeatureConfig,
  dependencies: McpReadTransportDependencies = {},
  options: McpReadFeatureConfigAssertOptions = {},
): void {
  assertMcpReadFeatureConfig(config, options);
  const trustedHost = mcpTrustedHostAuthority(config);
  const writeEnabled = dependencies.writeEnabled === true;
  const serverInfo = resolvePhase4bMcpServerInfo(writeEnabled);
  const requestRateLimiter = dependencies.requestRateLimiter
    ?? createMemoryMcpRateLimiter({ request: config.requestRateLimit });
  const timeoutMs = dependencies.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new TypeError('MCP read requestTimeoutMs must be a positive safe integer');
  }
  const resourceProjection = dependencies.resourceProjection;
  if (resourceProjection === undefined) {
    throw new TypeError('MCP read resource projection is required when MCP Read is enabled');
  }
  const snapshotResourceProjection = dependencies.snapshotResourceProjection;
  if (snapshotResourceProjection === undefined) {
    throw new TypeError('MCP snapshot resource projection is required when MCP Read is enabled');
  }
  const nodeResourceProjection = dependencies.nodeResourceProjection;
  if (nodeResourceProjection === undefined) {
    throw new TypeError('MCP node resource projection is required when MCP Read is enabled');
  }
  const changeSignalSource = dependencies.changeSignalSource;
  if (changeSignalSource === undefined) {
    throw new TypeError('MCP read change signal source is required when MCP Read is enabled');
  }
  const readToolAdapter = dependencies.readToolAdapter;
  if (readToolAdapter === undefined) {
    throw new TypeError('MCP read tool adapter is required when MCP Read is enabled');
  }
  const readToolParamDeclarations = dependencies.readToolParamDeclarations;
  if (readToolParamDeclarations === undefined || !Array.isArray(readToolParamDeclarations)) {
    throw new TypeError('MCP read tool param declarations are required when MCP Read is enabled');
  }
  const writeToolAdapter = dependencies.writeToolAdapter;
  const writeToolParamDeclarations = dependencies.writeToolParamDeclarations;
  if ((writeToolAdapter === undefined) !== (writeToolParamDeclarations === undefined)) {
    throw new TypeError('MCP write tool adapter and param declarations must be mounted together');
  }
  if (writeToolAdapter !== undefined && writeToolParamDeclarations !== undefined) {
    const requirements = writeToolAdapter.transportRequirements;
    if (
      typeof requirements !== 'object'
      || requirements === null
      || requirements.enforceBeforeJsonParsing !== true
      || !Number.isSafeInteger(requirements.maxRequestBodyBytes)
      || requirements.maxRequestBodyBytes < 1
    ) {
      throw new TypeError('MCP write transport requirements must enforce a positive raw body byte cap');
    }
  }
  const toolParamDeclarations = mergePhase4bMcpParamDeclarations(
    readToolParamDeclarations,
    writeToolParamDeclarations ?? NO_PARAM_DECLARATIONS,
  );
  const resourceIdentity = createPhase4bMcpResourceIdentity(config, options);
  const applicationFacade = dependencies.applicationFacade ?? createPhase4bMcpApplicationFacadeFromColpAdapters({
    resourceIdentity,
    collectionProjection: resourceProjection,
    snapshotProjection: snapshotResourceProjection,
    nodeProjection: nodeResourceProjection,
    readToolAdapter,
    ...(writeToolAdapter === undefined ? {} : { writeToolAdapter }),
  });
  const readCore = createMcpStatelessReadCore({
    projection: {
      // MAIN colp `dist` `validateListResult` still rejects optional
      // `description` / `_meta`. Strip those keys for the shared core so
      // host tests (symlink to MAIN) stay green; the remapper below recovers
      // surviving annotations from the host projection. The npm COLP adapter
      // plus a worktree colp build accepts the keys on `coreResult` too.
      listResources: async (input, context) => {
        const result = await resourceProjection.listResources(input, context);
        return Object.freeze({
          resources: Object.freeze(result.resources.map((entry) => Object.freeze({
            uri: entry.uri,
            name: entry.name,
            mimeType: entry.mimeType,
            provenance: entry.provenance,
          }))),
          ...(result.nextCursor === undefined ? {} : { nextCursor: result.nextCursor }),
        });
      },
      readResource: (input, context) =>
        input.resource.kind === 'collection-snapshot'
          ? snapshotResourceProjection.readResource(input, context)
          : input.resource.kind === 'collection-node'
            ? nodeResourceProjection.readResource(input, context)
            : resourceProjection.readResource(input, context),
    },
    uriCodec: resourceIdentity.codec,
  });
  const resourceAdapter = createMcp20260728ResourceAdapter({
    readCore,
    serverInfo,
    templates: resourceIdentity.templates,
    cache: {
      'resources/templates/list': PHASE4B_MCP_RESOURCE_TEMPLATES_CACHE_METADATA,
    },
  });
  if (typeof resourceAdapter.listResourceTemplates !== 'function') {
    throw new TypeError('MCP resource template adapter is required');
  }
  const resourceHandlers: McpResourceHandlers = Object.freeze({
    listResources: createListResourcesHandler(readCore, resourceProjection, writeEnabled),
    readResource: createReadResourceHandler(
      readCore,
      resourceProjection,
      nodeResourceProjection,
      snapshotResourceProjection,
      resourceIdentity,
      writeEnabled,
    ),
  });

  const budget = dependencies.requestConnectionBudget
    ?? createConnectionBudget(
      config.budgets.request.maxConcurrent,
      config.budgets.request.maxQueue,
    );
  const listenBudget = createConnectionBudget(
    config.budgets.listen.maxConnections,
    0,
  );
  const operations = dependencies.operations ?? createPhase4bMcpReadOperations({
    metrics: new InMemoryMetrics(),
    maxConcurrentRequests: config.budgets.request.maxConcurrent,
    maxQueuedRequests: config.budgets.request.maxQueue,
    maxListeners: config.budgets.listen.maxConnections,
  });
  const reportRequestBudget = (): void => {
    const snapshot = budget.snapshot();
    operations.setRequestBacklog(snapshot.active, snapshot.queued);
  };
  const reportListenBudget = (): void => {
    operations.setListenBacklog(listenBudget.snapshot().active);
  };
  const listenAdapter = createMcp20260728SubscriptionsListenAdapter({
    signalSource: changeSignalSource,
    authorization: {
      isAuthorized: (context) => !context.abortSignal.aborted,
      // The host owns logical URI authority; the SSE transport loop separately
      // rechecks credentials and asynchronously reads each resource before sending.
      isResourceAuthorized: (context, uri) => {
        if (context.abortSignal.aborted) return false;
        try { resourceIdentity.parse(uri); return true; } catch { return false; }
      },
    },
    capabilities: PHASE4B_MCP_DISCOVERY_CAPABILITIES,
    serverInfo,
    maxQueueSize: Math.min(
      128,
      Math.max(1, Math.floor(config.budgets.listen.maxQueueBytes / 1_024)),
    ),
    maxLifetimeMs: config.budgets.listen.maxDurationMs,
  });
  // Q1 integration fix: the drain MUST run in `preClose`. Fastify's close
  // sequence is preClose hooks -> server.close() (waits for ACTIVE
  // connections when forceCloseConnections=false, P4A-P10 drain contract) ->
  // onClose hooks; an onClose drain would deadlock shutdown behind an
  // in-flight MCP request (e.g. one stuck in OAuth verification), so the
  // MCP surface aborts its own operations before the drain wait begins.
  // Attachment uploads keep the app-level drain semantics unchanged (they
  // are never MCP operations).
  app.addHook('preClose', async () => {
    operations.drain();
  });

  app.post(config.endpointPath, {
    exposeHeadRoute: false,
    config: {
      productTransport: {
        allowedQuery: [],
        acceptedMediaTypes: [JSON_MEDIA_TYPE],
        bodyLimitBytes: writeToolAdapter === undefined
          ? config.budgets.request.maxBodyBytes
          : Math.min(
              config.budgets.request.maxBodyBytes,
              writeToolAdapter.transportRequirements.maxRequestBodyBytes,
            ),
        strictIJson: config.budgets.strictIJson,
        cacheControl: 'no-store',
      },
    },
  }, async (request, reply) => {
    const requestId = String(request.id);
    const listenRequest = isListenBody(request.body);
    const requestMethod = readBodyMethod(request.body);
    const controller = new AbortController();
    const operation = operations.beginRequest({
      kind: listenRequest ? 'listen' : 'request',
      method: requestMethod,
      controller,
    });
    let operationOutcome: 'success' | 'problem' = 'success';
    let operationCategory: Phase4bMcpReadFailureCategory | undefined;
    let operationLegacyCategory: Phase4bMcpLegacyRejectionCategory | undefined;
    let operationBudgetBucket: Phase4bMcpReadBudgetBucket | undefined;
    let responseFinished = false;
    const abortFromClient = (): void => {
      if (responseFinished) return;
      controller.abort(new DOMException('Client disconnected', 'AbortError'));
    };
    request.raw.once('aborted', abortFromClient);
    request.raw.socket?.once('close', abortFromClient);
    const timeout = setTimeout(
      () => controller.abort(new DOMException('MCP request timed out', 'TimeoutError')),
      listenRequest ? config.budgets.listen.maxDurationMs : timeoutMs,
    );
    timeout.unref();
    let sse = false;
    try {
      const pairs = readMcpHeaderPairs(request);
      const violation = headerBudgetViolation(pairs, config.budgets.request);
      if (violation !== undefined) {
        operationOutcome = 'problem';
        operationCategory = 'budget';
        operationBudgetBucket = budgetBucketFromViolation(violation.code);
        operations.recordBudgetOverflow(operationBudgetBucket);
        applyMcpSecurityHeaders(reply, requestId, undefined);
        return sendJson(reply, 431, { error: violation.code });
      }

      admitMcpHost(pairs, trustedHost);

      const origin = singleMcpHeader(pairs, 'origin');
      const allowedOrigin = origin !== undefined && config.allowedOrigins.includes(origin)
        ? origin
        : undefined;
      if (origin !== undefined && allowedOrigin === undefined) {
        throw new ProductHttpError({
          statusCode: 403,
          code: 'csrf_failed',
          message: 'The request failed CSRF or Origin validation.',
          recovery: 'user_action',
          headers: {
            'Cache-Control': 'no-store',
            'Vary': 'Authorization, Origin',
          },
        });
      }
      applyMcpSecurityHeaders(reply, requestId, allowedOrigin);

      const negotiation = negotiateResponse(pairs);
      if (negotiation === 'unsupported') {
        operationOutcome = 'problem';
        operationCategory = 'transport';
        return sendJson(reply, 406, { error: 'mcp_unsupported_accept' });
      }
      sse = negotiation === 'sse' || (listenRequest && negotiation === 'json');

      const acquirePromise = listenRequest
        ? listenBudget.acquire(controller.signal)
        : budget.acquire(controller.signal);
      // Report while the waiter is still queued: acquire() pushes onto
      // `waiters` synchronously, but the Promise does not resolve until a
      // slot is granted. Readiness/backlog must see that queued request
      // before overflow arrives, otherwise the next POST can steal the
      // queue slot and later complete as 200 instead of 503.
      reportRequestBudget();
      reportListenBudget();
      const acquired = await acquirePromise;
      reportRequestBudget();
      reportListenBudget();
      if (!acquired) {
        if (!controller.signal.aborted) {
          operationOutcome = 'problem';
          operationCategory = 'backpressure';
          if (listenRequest) {
            operationBudgetBucket = 'listen_connections';
            operations.recordBudgetOverflow('listen_connections');
          } else {
            operationBudgetBucket = 'request_queue';
            operations.recordBudgetOverflow('request_queue');
          }
          return await sendMcpHttpResponse(reply, sse, 503, { error: 'mcp_connection_budget_exhausted' });
        }
        return;
      }
      try {
        const authorization = singleMcpHeader(pairs, 'authorization');
        const bodyPreview = request.body;
        const previewMethod = isPlainObject(bodyPreview) && typeof bodyPreview.method === 'string'
          ? bodyPreview.method
          : '';
        const requiredScopes = requiredScopesForMcpReadOperation({ method: previewMethod,
          ...(previewMethod === 'tools/call' && isPlainObject(bodyPreview) && isPlainObject(bodyPreview.params)
            && typeof bodyPreview.params.name === 'string' ? { toolName: bodyPreview.params.name } : {}) });
        const trusted = await resolveAuthorization(
          authorization,
          config,
          dependencies,
          controller.signal,
          requiredScopes,
        );
        const rateOutcome = await requestRateLimiter.consume(mcpRateLimitSubject(request, trusted.binding));
        if (rateOutcome.kind === 'denied') {
          operationOutcome = 'problem';
          operationCategory = 'transport';
          reply.header('Retry-After', String(rateOutcome.decision.retryAfterSeconds));
          throw new McpReadHttpError(
            429,
            'mcp_rate_limited',
            'Too many MCP requests.',
          );
        }
        if (rateOutcome.kind === 'failed') {
          // FIX-M-018 fail-closed: a shared-limiter outage is a 503 that
          // never fabricates quota facts (no Retry-After), never admits
          // unlimited traffic.
          operationOutcome = 'problem';
          operationCategory = 'transport';
          throw new McpReadHttpError(
            503,
            'mcp_rate_limit_unavailable',
            'Rate limiting service is temporarily unavailable.',
          );
        }
        const body = request.body;
        if (!isPlainObject(body)) {
          throw new Mcp20260728RequestError(
            'invalid_request',
            'The request body must be a single JSON-RPC object.',
          );
        }
        const wireId = readWireId(body);
        // MCP-U-08 (2026-08-27 MCP usability audit): build — and thereby
        // validate — the request context BEFORE opening the SSE stream so
        // envelope/header protocol errors answer as immediate HTTP 400 JSON
        // instead of an error event inside an already-committed 200 stream
        // that a JSON-expecting client only abandons at the transport
        // timeout.
        const context = createPhase4bMcpRequestContext({
          headers: pairs.map(([name, value]) => ({ name, value })),
          httpMethod: 'POST',
          body: body as Readonly<{ method: string; params?: Readonly<Record<string, unknown>> }>,
          binding: trusted.binding,
          scope: trusted.scope,
          budget: buildMcpReadBudget(config),
          abortSignal: controller.signal,
          authorization: trusted.accountSubjectId === undefined
            ? { requestId }
            : {
              requestId,
              [MCP_ACCOUNT_SUBJECT_ID_AUTHORIZATION_KEY]: trusted.accountSubjectId,
            },
          origin,
          paramDeclarations: body.method === 'tools/call'
            ? toolParamDeclarations
            : NO_PARAM_DECLARATIONS,
        });
        if (body.method === 'subscriptions/listen' && !sse) {
          throw new Mcp20260728RequestError(
            'invalid_request',
            'subscriptions/listen requires an SSE response stream.',
          );
        }
        if (sse) startSse(reply, requestId, allowedOrigin);
        operation.setResourceKind(resourceKindFromBody(body, resourceIdentity));
        const recheckAuthorization = createAuthorizationRecheck(
          authorization,
          trusted.binding,
          config,
          dependencies,
          controller.signal,
          requiredScopes,
        );

        const dispatchWork = () => withAbort(
          dispatch(
            body,
            context,
            resourceIdentity,
            resourceHandlers,
            listenAdapter,
            readToolAdapter,
            writeToolAdapter,
            applicationFacade,
            writeEnabled,
          ),
          controller.signal,
        );
        const outcome = trusted.accountSubjectId === undefined
          ? await dispatchWork()
          : await runWithMcpAccountSubjectId(trusted.accountSubjectId, dispatchWork);
        if (outcome.kind === 'listen') {
          const session = outcome.session;
          operation.attachListenSession(session);
          void session.closed.then((teardown) => {
            operations.recordListenTeardown({
              overflow: teardown.overflow,
              rateLimited: teardown.rateLimited,
              reason: teardown.reason,
            });
          });
          try {
            if (!(await recheckAuthorization())) {
              session.close();
              reply.raw.end();
              return;
            }
            await writeSseMessage(reply.raw, {
              jsonrpc: '2.0',
              method: session.acknowledged.method,
              params: session.acknowledged.params,
            }, controller.signal);
            const iterator = session.notifications[Symbol.asyncIterator]();
            for (;;) {
              if (!(await recheckAuthorization())) {
                session.close();
                break;
              }
              const item = await iterator.next();
              if (item.done) break;
              if (!(await recheckAuthorization())) {
                session.close();
                break;
              }
              if (
                item.value.method === 'notifications/resources/updated'
                && !(await isResourceUpdatedVisibleForListener(
                  context,
                  resourceHandlers,
                  resourceIdentity,
                  item.value.params,
                  controller.signal,
                ))
              ) {
                continue;
              }
              await writeSseMessage(reply.raw, {
                jsonrpc: '2.0',
                method: item.value.method,
                params: item.value.params,
              }, controller.signal);
            }
            const teardown = await session.closed;
            if (teardown.graceful && (await recheckAuthorization())) {
              await writeSseMessage(reply.raw, {
                jsonrpc: '2.0',
                id: wireId,
                result: session.result,
              }, controller.signal);
            }
            reply.raw.end();
          } finally {
            session.close();
          }
          return;
        }
        const payload = outcome.kind === 'result'
          ? { jsonrpc: '2.0', id: wireId, result: outcome.result }
          : { jsonrpc: '2.0', id: wireId, error: outcome.error };
        if (sse) {
          await writeSseMessage(reply.raw, payload, controller.signal);
          reply.raw.end();
        } else {
          return sendJson(reply, 200, payload);
        }
        return;
      } finally {
        if (listenRequest) {
          listenBudget.release();
          reportListenBudget();
        } else {
          budget.release();
          reportRequestBudget();
        }
      }
    } catch (error) {
      operationOutcome = 'problem';
      if (controller.signal.aborted) {
        const reason = controller.signal.reason;
        if (reason instanceof DOMException && reason.name === 'TimeoutError') {
          operationCategory = 'timeout';
          try {
            return await sendMcpHttpResponse(reply, sse, 408, { error: 'mcp_request_timeout' }, controller.signal);
          } catch {
            // MCP-U-10: a stalled client cannot even absorb the 408 event;
            // writeChunk already destroyed the socket, nothing left to send.
            return;
          }
        }
        operationCategory = 'abort';
        if (reply.raw.headersSent) {
          reply.raw.destroy();
        } else {
          reply.hijack();
          reply.raw.destroy();
        }
        return;
      }
      if (error instanceof McpReadHttpError) {
        operationCategory = error.code === 'mcp_oauth_verifier_unconfigured'
          ? 'auth'
          : 'transport';
        return await sendMcpHttpResponse(reply, sse, error.statusCode, { error: error.code }, controller.signal);
      }
      if (error instanceof McpOauthVerificationError) {
        operationCategory = 'auth';
        const productError = mapMcpOauthChallengeToProductError(error, config, 'strict');
        if (sse && reply.raw.headersSent) {
          await writeSseMessage(reply.raw, { error: productError.productCode }, controller.signal);
          reply.raw.end();
        } else {
          return sendProductPayload(request, reply, productError);
        }
        return;
      }
      if (error instanceof Mcp20260728RequestError) {
        const legacyCategory = classifyLegacyRejection(error, request);
        if (legacyCategory !== undefined) {
          operationCategory = 'legacy';
          operationLegacyCategory = legacyCategory;
        } else if (requestMethod === 'subscriptions/listen') {
          operationCategory = 'listen';
        } else if (isProjectionReadMethod(requestMethod)) {
          operationCategory = 'projection';
        } else {
          operationCategory = 'request_context';
        }
        return await sendJsonRpcError(
          reply,
          sse,
          readWireId(request.body),
          normalizePhase4bMcpError(error),
          controller.signal,
        );
      }
      if (error instanceof ProductHttpError) {
        operationCategory = 'transport';
        if (sse && reply.raw.headersSent) {
          await writeSseMessage(reply.raw, { error: error.productCode }, controller.signal);
          reply.raw.end();
        } else {
          return sendProductPayload(request, reply, error);
        }
        return;
      }
      if (error instanceof McpReadRequestContextError) {
        operationCategory = 'budget';
      } else if (error instanceof McpResourceNotFoundError
        || error instanceof McpToolOutputUnavailableError) {
        operationCategory = 'projection';
      } else if (error instanceof Error && /socket closed|backpressure/iu.test(error.message)) {
        operationCategory = 'backpressure';
      } else {
        operationCategory = 'internal';
      }
      return await sendJsonRpcError(
        reply,
        sse,
        readWireId(request.body),
        normalizePhase4bMcpError(error),
        controller.signal,
      );
    } finally {
      responseFinished = true;
      clearTimeout(timeout);
      request.raw.removeListener('aborted', abortFromClient);
      request.raw.socket?.removeListener('close', abortFromClient);
      operation.finish({
        outcome: operationOutcome,
        category: operationCategory,
        legacyCategory: operationLegacyCategory,
        budgetBucket: operationBudgetBucket,
      });
    }
  });
}

function readBodyMethod(body: unknown): string {
  if (!isPlainObject(body)) return 'unknown';
  const method = (body as { readonly method?: unknown }).method;
  return typeof method === 'string' ? method : 'unknown';
}

function budgetBucketFromViolation(code: string): Phase4bMcpReadBudgetBucket {
  switch (code) {
    case 'mcp_header_count_exceeded':
      return 'header_count';
    case 'mcp_header_name_too_long':
      return 'header_name_bytes';
    case 'mcp_header_value_too_long':
      return 'header_value_bytes';
    default:
      return 'request_body_bytes';
  }
}

function resourceKindFromBody(
  body: Readonly<Record<string, unknown>>,
  identity: Phase4bMcpResourceIdentity,
): Phase4bMcpReadResourceKind {
  if (body.method !== 'resources/read') return 'none';
  const params = body.params;
  if (!isPlainObject(params)) return 'none';
  const uri = (params as { readonly uri?: unknown }).uri;
  if (typeof uri !== 'string' || uri.length === 0) return 'none';
  try {
    const parsed = identity.parse(uri);
    if (parsed.kind === 'collection-snapshot') return 'collection_snapshot';
    if (parsed.kind === 'collection-node') return 'collection_node';
    return 'collection_metadata';
  } catch {
    return 'none';
  }
}

function classifyLegacyRejection(
  error: Mcp20260728RequestError,
  request: FastifyRequest,
): Phase4bMcpLegacyRejectionCategory | undefined {
  const bodyMethod = readBodyMethod(request.body);
  if (bodyMethod === 'initialize') return 'initialize';
  if (isPhase4bMcpLegacyBodyMethod(bodyMethod)) return 'legacy_method';
  const headerNames = new Set<string>();
  for (let index = 0; index < request.raw.rawHeaders.length; index += 2) {
    headerNames.add(request.raw.rawHeaders[index]?.toLowerCase() ?? '');
  }
  if (headerNames.has('mcp-session-id')) return 'session_header';
  if (headerNames.has('last-event-id')) return 'last_event_id';
  if (error.kind === 'unsupported_protocol_version') return 'protocol_version';
  return undefined;
}

function isProjectionReadMethod(method: string): boolean {
  return method === 'resources/list'
    || method === 'resources/templates/list'
    || method === 'resources/read'
    || method === 'tools/list'
    || method === 'tools/call';
}

async function resolveAuthorization(
  authorization: string | undefined,
  config: McpReadFeatureConfig,
  dependencies: McpReadTransportDependencies,
  signal: AbortSignal,
  requiredScopes: readonly string[],
): Promise<{
  readonly binding: McpAuthorizationBinding;
  readonly scope: readonly string[];
  readonly accountSubjectId?: string;
}> {
  if (authorization === undefined) {
    const securityEpoch = await withAbort(resolveAnonymousSecurityEpoch(dependencies), signal);
    return {
      binding: createAnonymousPublicBinding({
        resourceAudience: config.oauth.audience,
        securityEpoch,
      }),
      scope: [],
    };
  }
  if (dependencies.oauthVerifier === undefined) {
    throw new McpReadHttpError(
      503,
      'mcp_oauth_verifier_unconfigured',
      'MCP OAuth verification is not configured.',
    );
  }
  const result = await withAbort(
    dependencies.oauthVerifier.verify({ authorization, requiredScopes }),
    signal,
  );
  return {
    binding: result.binding,
    scope: [...(result.scopes ?? [])],
    accountSubjectId: result.accountSubjectId,
  };
}

async function resolveAnonymousSecurityEpoch(
  dependencies: McpReadTransportDependencies,
): Promise<string> {
  const epoch = dependencies.securityEpoch === undefined
    ? 'public'
    : await dependencies.securityEpoch();
  if (typeof epoch !== 'string' || epoch.trim() === '') {
    throw new TypeError('MCP anonymous security epoch must be a non-empty string');
  }
  return epoch;
}

function isListenBody(body: unknown): boolean {
  return isPlainObject(body) && body.method === 'subscriptions/listen';
}

function createAuthorizationRecheck(
  authorization: string | undefined,
  original: McpAuthorizationBinding,
  config: McpReadFeatureConfig,
  dependencies: McpReadTransportDependencies,
  signal: AbortSignal,
  requiredScopes: readonly string[],
): () => Promise<boolean> {
  return async () => {
    try {
      if (authorization === undefined) {
        const epoch = await resolveAnonymousSecurityEpoch(dependencies);
        return bindingsEqual(
          createAnonymousPublicBinding({
            resourceAudience: config.oauth.audience,
            securityEpoch: epoch,
          }),
          original,
        );
      }
      if (dependencies.oauthVerifier === undefined) return false;
      const result = await withAbort(
        dependencies.oauthVerifier.verify({ authorization, requiredScopes }),
        signal,
      );
      return bindingsEqual(result.binding, original);
    } catch {
      return false;
    }
  };
}

function bindingsEqual(
  left: McpAuthorizationBinding,
  right: McpAuthorizationBinding,
): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === 'anonymous') {
    return right.kind === 'anonymous'
      && left.principalId === right.principalId
      && left.resourceAudience === right.resourceAudience
      && left.securityEpoch === right.securityEpoch;
  }
  return right.kind === 'authenticated'
    && left.principalId === right.principalId
    && left.clientId === right.clientId
    && left.credentialBindingId === right.credentialBindingId
    && left.resourceAudience === right.resourceAudience
    && left.securityEpoch === right.securityEpoch;
}

function buildMcpReadBudget(config: McpReadFeatureConfig): McpResourceReadBudget {
  return {
    maxBytes: config.budgets.output.maxBytes,
    maxDepth: config.budgets.output.maxDepth,
    maxNodes: config.budgets.output.maxItems,
    maxOperations: config.budgets.output.maxItems,
    maxListItems: config.budgets.output.maxItems,
    maxReadContents: config.budgets.output.maxItems,
    maxTextBytes: config.budgets.output.maxBytes,
    maxCursorLength: 1_024,
  };
}

async function dispatch(
  body: Readonly<Record<string, unknown>>,
  context: Mcp20260728RequestContext,
  resourceIdentity: Phase4bMcpResourceIdentity,
  resourceHandlers: McpResourceHandlers,
  listenAdapter: Mcp20260728SubscriptionsListenAdapter,
  readToolAdapter: Mcp20260728ReadToolAdapter,
  writeToolAdapter: Mcp20260728WriteToolAdapter | undefined,
  applicationFacade: McpApplicationFacade,
  writeEnabled = false,
): Promise<
  { readonly kind: 'result'; readonly result: Mcp20260728Result | Mcp20260728DiscoverResult }
  | { readonly kind: 'error'; readonly error: Mcp20260728WireError }
  | { readonly kind: 'listen'; readonly session: Mcp20260728SubscriptionsListenSession }
> {
  const method = typeof body.method === 'string' ? body.method : '';
  switch (method) {
    case 'server/discover': {
      const validation = validatePhase4bMcpDiscoverRequest(body);
      if (!validation.ok) {
        throw new Mcp20260728RequestError('invalid_request', validation.issue);
      }
      return { kind: 'result', result: createPhase4bMcpDiscoverResult(writeEnabled) };
    }
    case 'resources/list':
      return {
        kind: 'result',
        result: await resourceHandlers.listResources(context, resourceMethodParams(body)),
      };
    case 'resources/templates/list':
      return {
        kind: 'result',
        result: await listStrictApplicationResourceTemplates(
          context,
          applicationFacade,
          writeEnabled,
        ),
      };
    case 'resources/read': {
      const params = resourceMethodParams(body);
      const uri = resourceUriValue(params);
      if (typeof uri === 'string' && uri.length > 0) {
        try {
          resourceIdentity.parse(uri);
        } catch {
          throw new Mcp20260728RequestError('invalid_params', 'Invalid Resource URI.');
        }
      }
      return {
        kind: 'result',
        result: await resourceHandlers.readResource(context, params),
      };
    }
    case 'subscriptions/listen': {
      const listenWireId = readWireId(body);
      if (listenWireId === null) {
        throw new Mcp20260728RequestError(
          'invalid_request',
          'subscriptions/listen requires a JSON-RPC request id.',
        );
      }
      const listenParams = resourceMethodParams(body);
      validateResourceSubscriptions(listenParams, resourceIdentity);
      return {
        kind: 'listen',
        session: listenAdapter.listen(
          context,
          listenParams,
          listenWireId,
        ),
      };
    }
    case 'tools/list': {
      try {
        return {
          kind: 'result',
          result: await withAbort(
            listStrictApplicationTools(
              context,
              applicationFacade,
              readCatalogCursor(resourceMethodParams(body)),
              writeEnabled,
            ),
            context.abortSignal,
          ),
        };
      } catch (error) {
        if (error instanceof Mcp20260728RequestError) {
          return { kind: 'error', error: normalizePhase4bMcpError(error) };
        }
        throw error;
      }
    }
    case 'tools/call': {
      const params = resourceMethodParams(body);
      requirePhase4bMcpClientCapability(context, ['tools', 'call']);
      try {
        return {
          kind: 'result',
          result: await withAbort(
            dispatchStrictToolCall(
              context,
              params,
              readToolAdapter,
              writeToolAdapter,
              applicationFacade,
              writeEnabled,
            ),
            context.abortSignal,
          ),
        };
      } catch (error) {
        if (error instanceof McpToolOutputUnavailableError) {
          return {
            kind: 'error',
            error: normalizePhase4bMcpError(new Mcp20260728RequestError(
              'invalid_params',
              'Tool result unavailable.',
              { name: toolCallName(params) },
            )),
          };
        }
        if (error instanceof Mcp20260728RequestError) {
          return { kind: 'error', error: normalizePhase4bMcpError(error) };
        }
        const classified = classifyPhase4bMcpWriteError(error);
        if (classified.outcome === 'rejected') {
          return {
            kind: 'error',
            error: normalizePhase4bMcpError(
              toPhase4bMcpWriteRequestError(classified, writeErrorHintFrom(error)),
            ),
          };
        }
        throw error;
      }
    }
    default:
      return { kind: 'error', error: Object.freeze({ code: -32601, message: 'Method not found' }) };
  }
}

function validateResourceSubscriptions(
  input: Readonly<Record<string, unknown>> | undefined,
  identity: Phase4bMcpResourceIdentity,
): void {
  if (input === undefined) return;
  const notifications = input.notifications;
  if (!isPlainObject(notifications)) return;
  const subscriptions = notifications.resourceSubscriptions;
  if (!Array.isArray(subscriptions)) return;
  for (const uri of subscriptions) {
    if (typeof uri !== 'string' || uri.length === 0) continue;
    try {
      identity.parse(uri);
    } catch {
      throw new Mcp20260728RequestError(
        'invalid_params',
        'Invalid Resource URI in subscriptions/listen.',
      );
    }
  }
}

function resourceMethodParams(
  body: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> | undefined {
  const params = body.params;
  if (typeof params !== 'object' || params === null || Array.isArray(params)) return undefined;
  const record = params as Readonly<Record<string, unknown>>;
  if (!Object.hasOwn(record, '_meta')) return record;
  const withoutMeta: Record<string, unknown> = {};
  for (const key of Object.keys(record)) {
    if (key !== '_meta') withoutMeta[key] = record[key];
  }
  return withoutMeta;
}

function resourceUriValue(params: unknown): unknown {
  if (typeof params !== 'object' || params === null) return undefined;
  return (params as { readonly uri?: unknown }).uri;
}

function toolCallName(params: unknown): unknown {
  if (typeof params !== 'object' || params === null) return undefined;
  return (params as { readonly name?: unknown }).name;
}

function readCursorRequest(value: unknown): Readonly<{ cursor?: string }> {
  if (value === undefined) return Object.freeze({});
  assertExactRequestObject(value, [], ['cursor'], () => invalidParams('resource list cursor'));
  const cursor = readOptionalRequestData(value, 'cursor');
  if (cursor === undefined) return Object.freeze({});
  if (typeof cursor !== 'string' || cursor.length === 0) {
    throw invalidParams('resource list cursor');
  }
  return Object.freeze({ cursor });
}

function readUriRequest(value: unknown): Readonly<{ uri: string }> {
  assertExactRequestObject(value, ['uri'], [], () => invalidParams('resource read uri'));
  const uri = readOwnRequestData(value, 'uri', () => invalidParams('resource read uri'));
  if (typeof uri !== 'string' || uri.length === 0) {
    throw invalidParams('resource read uri');
  }
  return Object.freeze({ uri });
}

function invalidParams(message: string): Mcp20260728RequestError {
  return new Mcp20260728RequestError('invalid_params', `Invalid ${message}.`);
}

function assertExactRequestObject(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
  fail: () => Error,
): asserts value is object {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw fail();
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  if (keys.some((key) => !allowed.has(key)) || required.some((key) => !keys.includes(key))) throw fail();
}

function readOwnRequestData(value: object, name: string, fail: () => Error): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, name);
  if (descriptor === undefined || !('value' in descriptor)) throw fail();
  return descriptor.value;
}

function readOptionalRequestData(value: object, name: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, name);
  if (descriptor === undefined || !('value' in descriptor)) return undefined;
  return descriptor.value;
}

/** One `resources/list` item on the Modern wire (MCP Resource optional keys). */
export interface McpListResourceWireItem {
  readonly uri: string;
  readonly name: string;
  readonly mimeType: string;
  readonly description?: string;
  readonly _meta?: Readonly<Record<string, unknown>>;
}

/**
 * Forwards surviving `description` / `_meta` from a host list projection onto
 * the wire `ListResourcesResult` item. Matches the optional-key mapping in
 * worktree `colp/src/mcp/2026-07-28/resources.ts`. Does not invent fields.
 */
export function mapMcpListResourceWireItem(entry: McpListResourceWireItem): McpListResourceWireItem {
  return {
    uri: entry.uri,
    name: entry.name,
    mimeType: entry.mimeType,
    ...(entry.description === undefined ? {} : { description: entry.description }),
    ...(entry._meta === undefined ? {} : { _meta: entry._meta }),
  };
}

function listResourceWireAnnotations(
  entry: object,
): Pick<McpListResourceWireItem, 'description' | '_meta'> {
  const description = Object.hasOwn(entry, 'description')
    ? Reflect.get(entry, 'description')
    : undefined;
  const meta = Object.hasOwn(entry, '_meta')
    ? Reflect.get(entry, '_meta')
    : undefined;
  return {
    ...(typeof description === 'string' && description.length > 0 ? { description } : {}),
    ...(typeof meta === 'object' && meta !== null && !Array.isArray(meta)
      ? { _meta: meta as Readonly<Record<string, unknown>> }
      : {}),
  };
}

function createListResourcesHandler(
  readCore: McpStatelessReadCore,
  resourceProjection: Phase4bMcpCollectionResourceProjection,
  writeEnabled = false,
): McpResourceHandlers['listResources'] {
  return async (context, input) => {
    const ctx = requireMcp20260728RequestContext(context);
    const request = readCursorRequest(input);
    const trusted = requireTrustedReadRequestContext(ctx);
    let coreResult: McpResourceListResult;
    try {
      coreResult = await readCore.listResources(trusted, request);
    } catch (error) {
      if (error instanceof McpReadRequestContextError) {
        throw new Mcp20260728RequestError('invalid_params', 'Invalid resource list cursor.');
      }
      if (error instanceof McpResourceNotFoundError) throw error;
      throw error;
    }
    const cache = await resourceProjection.cacheForList(request, trusted);
    assertCacheAuthority(ctx, cache);
    const projected = await resourceProjection.listResources(request, trusted);
    const extrasByUri = new Map(projected.resources.map((item) => [item.uri, item] as const));
    return buildDynamicResourceResult('resources/list', {
      resources: coreResult.resources.map((entry) => mapMcpListResourceWireItem({
        uri: entry.uri,
        name: entry.name,
        mimeType: entry.mimeType,
        ...listResourceWireAnnotations(extrasByUri.get(entry.uri) ?? entry),
      })),
      ...(coreResult.nextCursor === undefined ? {} : { nextCursor: coreResult.nextCursor }),
    }, cache, writeEnabled);
  };
}

function createReadResourceHandler(
  readCore: McpStatelessReadCore,
  resourceProjection: Phase4bMcpCollectionResourceProjection,
  nodeResourceProjection: Phase4bMcpNodeResourceProjection,
  snapshotResourceProjection: Phase4bMcpSnapshotResourceProjection,
  resourceIdentity: Phase4bMcpResourceIdentity,
  writeEnabled = false,
): McpResourceHandlers['readResource'] {
  return async (context, input) => {
    const ctx = requireMcp20260728RequestContext(context);
    const request = readUriRequest(input);
    const resource = resourceIdentity.parse(request.uri);
    const trusted = requireTrustedReadRequestContext(ctx);
    let coreResult: McpResourceReadResult;
    try {
      coreResult = await readCore.readResource(trusted, request);
    } catch (error) {
      if (error instanceof McpReadRequestContextError) throw error;
      if (error instanceof McpResourceNotFoundError) {
        throw new Mcp20260728RequestError('invalid_params', 'Resource not found.', { uri: request.uri });
      }
      throw error;
    }
    const cache = resource.kind === 'collection-snapshot'
      ? await snapshotResourceProjection.cacheForRead({ resource }, trusted)
      : resource.kind === 'collection-node'
        ? await nodeResourceProjection.cacheForRead({ resource }, trusted)
        : await resourceProjection.cacheForRead({ resource }, trusted);
    assertCacheAuthority(ctx, cache);
    return buildDynamicResourceResult('resources/read', {
      contents: coreResult.contents.map((entry) => ({
        uri: entry.uri,
        mimeType: entry.mimeType,
        text: entry.text,
      })),
    }, cache, writeEnabled);
  };
}

function assertCacheAuthority(
  context: Mcp20260728RequestContext,
  cache: Mcp20260728CacheMetadata,
): void {
  if (!Number.isSafeInteger(cache.ttlMs) || cache.ttlMs < 0) {
    throw new TypeError('MCP Resource cache ttlMs must be a non-negative safe integer');
  }
  if (cache.cacheScope !== 'public' && cache.cacheScope !== 'private') {
    throw new TypeError('MCP Resource cache scope must be public or private');
  }
  if (context.binding.kind !== 'anonymous' && cache.cacheScope === 'public') {
    throw new TypeError('MCP Resource cache cannot be public for an authenticated principal');
  }
}

/**
 * Re-checks current listener visibility before a `resource-updated` URI is
 * written to SSE. Hidden or unreadable resources are dropped without ending
 * the listen stream; abort errors are still propagated to the transport.
 */
async function isResourceUpdatedVisibleForListener(
  context: Mcp20260728RequestContext,
  resourceHandlers: McpResourceHandlers,
  resourceIdentity: Phase4bMcpResourceIdentity,
  params: Readonly<Record<string, unknown>>,
  signal: AbortSignal,
): Promise<boolean> {
  const uri = params.uri;
  if (typeof uri !== 'string' || uri.length === 0) return false;
  try {
    const resource = resourceIdentity.parse(uri);
    if (
      resource.kind !== 'collection-metadata'
      && resource.kind !== 'collection-snapshot'
      && resource.kind !== 'collection-node'
    ) {
      return false;
    }
    await withAbort(
      resourceHandlers.readResource(context, Object.freeze({ uri })),
      signal,
    );
    return true;
  } catch (error) {
    if (signal.aborted) throw error;
    return false;
  }
}

function buildDynamicResourceResult(
  method: 'resources/list' | 'resources/read',
  fields: Readonly<Record<string, unknown>>,
  cache: Mcp20260728CacheMetadata,
  writeEnabled = false,
): Mcp20260728Result {
  const schema = method === 'resources/list' ? ListResourcesResultSchema : ReadResourceResultSchema;
  if (!schema.safeParse(fields).success) {
    throw new TypeError('MCP Resource projection produced an invalid Modern result.');
  }
  return createPhase4bMcpResult({ method, fields, cache }, writeEnabled);
}

type Negotiation = 'json' | 'sse' | 'unsupported';

function negotiateResponse(pairs: ReadonlyArray<readonly [string, string]>): Negotiation {
  let jsonQ = 0;
  let sseQ = 0;
  for (const [name, value] of pairs) {
    if (name.toLowerCase() !== 'accept') continue;
    for (const item of value.split(',')) {
      const parts = item.split(';').map((part) => part.trim());
      const media = parts[0]?.toLowerCase() ?? '';
      const q = parseAcceptQ(parts.slice(1));
      if (media === JSON_MEDIA_TYPE) jsonQ = Math.max(jsonQ, q);
      else if (media === SSE_MEDIA_TYPE) sseQ = Math.max(sseQ, q);
    }
  }
  if (jsonQ <= 0 || sseQ <= 0) return 'unsupported';
  // MCP-U-09: on an exact quality tie (the common
  // `Accept: application/json, text/event-stream`) prefer the JSON body a
  // request/response client expects; SSE still wins with an explicit higher q
  // and `subscriptions/listen` forces SSE regardless.
  return sseQ > jsonQ ? 'sse' : 'json';
}

function parseAcceptQ(parameters: readonly string[]): number {
  for (const parameter of parameters) {
    if (!parameter.toLowerCase().startsWith('q=')) continue;
    const q = Number(parameter.slice(2));
    if (Number.isFinite(q) && q >= 0 && q <= 1) return q;
  }
  return 1;
}

function startSse(reply: FastifyReply, requestId: string, allowedOrigin: string | undefined): void {
  reply.hijack();
  reply.raw.writeHead(200, {
    'content-type': `${SSE_MEDIA_TYPE}; charset=utf-8`,
    'cache-control': 'no-store',
    'vary': 'Authorization, Origin',
    'x-request-id': requestId,
    ...(allowedOrigin === undefined
      ? {}
      : {
          'access-control-allow-origin': allowedOrigin,
          'access-control-expose-headers': 'X-Request-Id',
        }),
  });
  reply.raw.write(': known-mcp-stream\n\n');
}

function sendJson(reply: FastifyReply, status: number, payload: unknown): unknown {
  reply.code(status).type(`${JSON_MEDIA_TYPE}; charset=utf-8`);
  return payload;
}

function sendProductPayload(
  request: FastifyRequest,
  reply: FastifyReply,
  error: ProductHttpError,
): unknown {
  for (const [name, value] of Object.entries(error.headers)) reply.header(name, value);
  reply.code(error.statusCode).type(`${JSON_MEDIA_TYPE}; charset=utf-8`);
  return productErrorEnvelope(request.id, error);
}

async function sendMcpHttpResponse(
  reply: FastifyReply,
  sse: boolean,
  status: number,
  payload: unknown,
  signal?: AbortSignal,
): Promise<unknown> {
  if (sse && reply.raw.headersSent) {
    await writeSseMessage(reply.raw, payload, signal);
    reply.raw.end();
    return;
  }
  return sendJson(reply, status, payload);
}

async function sendJsonRpcError(
  reply: FastifyReply,
  sse: boolean,
  id: number | string | null,
  error: Mcp20260728WireError,
  signal?: AbortSignal,
): Promise<unknown> {
  const payload = { jsonrpc: '2.0', id, error };
  if (sse && reply.raw.headersSent) {
    await writeSseMessage(reply.raw, payload, signal);
    reply.raw.end();
    return;
  }
  return sendJson(reply, 400, payload);
}

function readWireId(body: unknown): number | string | null {
  if (!isPlainObject(body)) return null;
  const id = (body as { readonly id?: unknown }).id;
  if (id === undefined || id === null) return null;
  if (typeof id === 'number' || typeof id === 'string') return id;
  return null;
}

function isPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

export async function writeSseMessage(
  raw: ServerResponse,
  payload: unknown,
  signal?: AbortSignal,
): Promise<void> {
  const data = JSON.stringify(payload);
  await writeChunk(raw, Buffer.from(`event: message\ndata: ${data}\n\n`, 'utf8'), signal);
}

// MCP-U-10: the backpressure wait is abortable so a client that stops reading
// an open SSE stream is cut off by the per-request MCP abort (timeout/
// disconnect) instead of holding the socket until the transport-level
// timeout.
async function writeChunk(raw: ServerResponse, chunk: Buffer, signal?: AbortSignal): Promise<void> {
  if (raw.destroyed) throw new Error('MCP response socket closed');
  if (raw.write(chunk)) return;
  if (signal?.aborted) {
    raw.destroy();
    throw new Error('MCP response aborted during backpressure');
  }
  await new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      raw.removeListener('drain', onDrain);
      raw.removeListener('close', onClose);
      raw.removeListener('error', onError);
      signal?.removeEventListener('abort', onAbort);
    };
    const onDrain = (): void => {
      cleanup();
      resolve();
    };
    const onClose = (): void => {
      cleanup();
      reject(new Error('MCP response socket closed during backpressure'));
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onAbort = (): void => {
      cleanup();
      raw.destroy();
      reject(new Error('MCP response aborted during backpressure'));
    };
    raw.once('drain', onDrain);
    raw.once('close', onClose);
    raw.once('error', onError);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
