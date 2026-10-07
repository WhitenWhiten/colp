/**
 * MCP compatibility routes (T-02/T-03 admission + T-04 SDK handler + T-07 ops).
 *
 * Flag on: GET/DELETE 405 (Claude text/plain contract) in front of the SDK.
 * POST runs T-03 admission then the official `toNodeHandler` path. Do not
 * parse JSON on GET/DELETE — Fastify 400s empty `application/json` DELETE.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  MCP_COMPAT_ENDPOINT_PATH,
  MCP_COMPAT_METHOD_NOT_ALLOWED_BODY,
  MCP_COMPAT_READINESS_PATH,
  classifyMcpCompatClientFamilyFromBody,
  classifyMcpCompatInitializeOffer,
  classifyMcpCompatMethodFamily,
  mcpCompatAuthFromAuthorizationPresent,
  type McpApplicationFacade,
  type McpReadFeatureConfig,
  type Phase4bMcpCompatOperationHandle,
  type Phase4bMcpCompatOperations,
  type Phase4bMcpCompatRequestFinish,
} from '../../modules/mcp/index.js';
import {
  McpAdmissionHttpError,
  admitMcpCompatPost,
  classifyMcpCompatAdmissionFault,
  defaultMcpCompatConnectionBudget,
  defaultMcpCompatRateLimiter,
  sendMcpAdmissionError,
  type McpCompatAdmissionDependencies,
} from './mcp-compat-admission.js';
import {
  createMcpCompatLifecycle,
  dispatchMcpCompatLegacyPost,
  drainMcpCompatLifecycle,
} from './mcp-compat-handler.js';
import {
  createMcpCompatExecutionObserver,
  type McpCompatExecutionObserver,
} from './mcp-compat-execution-observer.js';
import { applyMcpSecurityHeaders, mcpTrustedHostAuthority } from './mcp-shared-admission.js';

export type { McpCompatAdmissionDependencies };

export interface McpCompatRouteDependencies extends McpCompatAdmissionDependencies {
  readonly applicationFacade?: McpApplicationFacade;
  readonly writeEnabled?: boolean;
  readonly operations: Phase4bMcpCompatOperations;
  /** Per-request timeout; defaults to the same 15s floor as strict MCP Read. */
  readonly requestTimeoutMs?: number;
  /** Invoked when the official SDK factory constructs a server. */
  readonly compatOnSdkFactory?: (ctx: {
    readonly authInfo?: { readonly token?: string };
    readonly requestInfo?: Request;
  }) => void;
}

export function registerMcpCompatRoutes(
  app: FastifyInstance,
  config: McpReadFeatureConfig,
  dependencies: McpCompatRouteDependencies,
): void {
  if (config.compat === undefined) return;
  const trustedHost = mcpTrustedHostAuthority(config);
  const applicationFacade = dependencies.applicationFacade;
  if (applicationFacade === undefined) {
    throw new TypeError('MCP compat application facade is required when the compatibility surface is enabled');
  }
  const operations = dependencies.operations;
  const writeEnabled = dependencies.writeEnabled === true;
  const requestRateLimiter = defaultMcpCompatRateLimiter(config, dependencies);
  const requestConnectionBudget = defaultMcpCompatConnectionBudget(config, dependencies);
  const timeoutMs = dependencies.requestTimeoutMs ?? 15_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new TypeError('MCP compat requestTimeoutMs must be a positive safe integer');
  }
  const lifecycle = createMcpCompatLifecycle();
  app.addHook('preClose', async () => {
    operations.drain();
    drainMcpCompatLifecycle(lifecycle);
  });

  app.route({
    method: ['GET', 'DELETE'],
    url: MCP_COMPAT_ENDPOINT_PATH,
    exposeHeadRoute: false,
    config: {
      productTransport: {
        allowedQuery: [],
        cacheControl: 'no-store',
      },
    },
    onRequest: async (request: FastifyRequest) => {
      delete request.headers['content-type'];
    },
    handler: async (_request, reply) => sendCompatMethodNotAllowed(reply),
  });

  app.post(MCP_COMPAT_ENDPOINT_PATH, {
    exposeHeadRoute: false,
    config: {
      productTransport: {
        allowedQuery: [],
        acceptedMediaTypes: ['application/json'],
        bodyLimitBytes: config.budgets.request.maxBodyBytes,
        strictIJson: config.budgets.strictIJson,
        cacheControl: 'no-store',
      },
    },
  }, async (request, reply) => {
    const controller = new AbortController();
    const abortFromClient = (): void => {
      controller.abort(new DOMException('Client disconnected', 'AbortError'));
    };
    request.raw.once('aborted', abortFromClient);
    request.raw.socket?.once('close', abortFromClient);
    const timeout = setTimeout(() => {
      controller.abort(new DOMException('MCP request timed out', 'TimeoutError'));
    }, timeoutMs);
    timeout.unref();
    const auth = mcpCompatAuthFromAuthorizationPresent(
      typeof request.headers.authorization === 'string' && request.headers.authorization.length > 0,
    );
    const methodFamily = classifyMcpCompatMethodFamily(request.body);
    const handshake = handshakeRecord(request.body);
    const handle = operations.beginRequest({ controller });
    const observer = createMcpCompatExecutionObserver();
    let release = (): void => {};
    let hijacked = false;
    try {
      if (!operations.isAdmitting()) {
        throw new McpAdmissionHttpError(
          503,
          'mcp_compat_draining',
          'MCP compatibility surface is draining.',
        );
      }
      const admitted = await admitMcpCompatPost(
        request,
        reply,
        config,
        dependencies,
        requestConnectionBudget,
        requestRateLimiter,
        controller.signal,
        trustedHost,
      );
      release = admitted.release;
      applyMcpSecurityHeaders(reply, String(request.id), admitted.allowedOrigin);
      const dispatched = await dispatchMcpCompatLegacyPost({
        request,
        reply,
        admitted,
        facade: applicationFacade,
        writeEnabled,
        abortController: controller,
        lifecycle,
        observer,
        onSdkFactory: dependencies.compatOnSdkFactory,
      });
      hijacked = dispatched.kind === 'hijacked';
      return;
    } catch (error) {
      const fault = classifyMcpCompatAdmissionFault(error);
      observer.observeAdmission({
        outcome: fault.outcome,
        protocolRevision: fault.rejectCategory === 'unsupported' ? 'unsupported' : '2025-11-25',
        ...(fault.rejectCategory === undefined ? {} : { rejectCategory: fault.rejectCategory }),
      });
      if (controller.signal.aborted || hijacked || reply.raw.headersSent) {
        if (!reply.raw.headersSent && !reply.sent) reply.hijack();
        return;
      }
      return sendMcpAdmissionError(request, reply, error, config);
    } finally {
      try {
        completeCompatOperation(handle, observer, {
          methodFamily,
          auth,
          handshake,
          aborted: controller.signal.aborted,
        });
      } finally {
        release();
        clearTimeout(timeout);
        request.raw.removeListener('aborted', abortFromClient);
        request.raw.socket?.removeListener('close', abortFromClient);
      }
    }
  });

  app.get(MCP_COMPAT_READINESS_PATH, {
    config: { productTransport: { allowedQuery: [], cacheControl: 'no-store' } },
  }, async (_request, reply) => {
    const result = await operations.readiness();
    return reply.code(result.status === 'ready' ? 200 : 503).send(result);
  });
}

function handshakeRecord(body: unknown): Phase4bMcpCompatRequestFinish['handshake'] {
  const offer = classifyMcpCompatInitializeOffer(body);
  if (offer === undefined) return undefined;
  return { offer, clientFamily: classifyMcpCompatClientFamilyFromBody(body) };
}

function completeCompatOperation(
  handle: Phase4bMcpCompatOperationHandle,
  observer: McpCompatExecutionObserver,
  fallback: {
    readonly methodFamily: Phase4bMcpCompatRequestFinish['methodFamily'];
    readonly auth: Phase4bMcpCompatRequestFinish['auth'];
    readonly handshake: Phase4bMcpCompatRequestFinish['handshake'];
    readonly aborted: boolean;
  },
): void {
  handle.finish(observer.toFinish({
    methodFamily: fallback.methodFamily,
    auth: fallback.auth,
    aborted: fallback.aborted,
    ...(fallback.handshake === undefined ? {} : { handshake: fallback.handshake }),
  }));
}

function sendCompatMethodNotAllowed(reply: FastifyReply) {
  return reply
    .code(405)
    .header('Allow', 'POST')
    .type('text/plain')
    .send(MCP_COMPAT_METHOD_NOT_ALLOWED_BODY);
}
