import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { IdentityUnitOfWork } from '../../modules/identity/index.js';
import {
  enqueueNodeReadableExtract,
  getNodeReadableReplica,
  parseReadableReplicaExtractRequest,
  ReadableReplicaCooldownError,
  ReadableReplicaExtractError,
  ReadableReplicaNotFoundError,
  type ReadableReplicaEnqueueUnitOfWork,
  type ReadableReplicaReadUnitOfWork,
  type ReadableReplicaView,
} from '../../modules/collections/index.js';
import type { ProductAdmissionRateLimiter } from '../http-security.js';
import { consumeProductAdmission } from '../http-security.js';
import { readKnownCommandId } from './collection-route-helpers.js';
import { ProductHttpError } from '../product-error.js';
import { productRouteMetadata } from '../product-route-manifest.js';
import { requireSessionActor } from '../session-auth.js';
import { requireMutationActor } from '../mutation-actor.js';

const ITEM = '/api/v1/collections/:collectionId/nodes/:nodeId/readable';
const OPAQUE_ID = /^[A-Za-z0-9._~-]{1,128}$/u;

export interface ReadableReplicaRoutesDependencies {
  readonly enabled: boolean;
  readonly allowedOrigins: readonly string[];
  readonly identityUnitOfWork: IdentityUnitOfWork;
  readonly unitOfWork: ReadableReplicaReadUnitOfWork;
  readonly enqueue?: ReadableReplicaEnqueueUnitOfWork;
  readonly enqueueCooldownMs: number;
  readonly rateLimiter: ProductAdmissionRateLimiter;
}

export function registerReadableReplicaRoutes(
  app: FastifyInstance,
  deps: ReadableReplicaRoutesDependencies,
): void {
  app.get(ITEM, {
    config: {
      ...productRouteMetadata('GET', ITEM),
      productTransport: {
        allowedQuery: [],
        cacheControl: 'private-no-store',
      },
    },
  }, async (request, reply) => {
    const { account } = await requireSessionActor(request, deps.identityUnitOfWork, { touch: false });
    if (!deps.enabled) throw notFound();
    await admit(deps.rateLimiter, `readable-replicas:principal:${account.id}`);
    try {
      const view = await deps.unitOfWork.execute((ports) => getNodeReadableReplica(ports, {
        actor: { principalId: account.id, subjectId: account.subjectId },
        collectionId: collectionIdParam(request),
        nodeId: nodeIdParam(request),
      }));
      return sendView(reply, view);
    } catch (error: unknown) {
      if (error instanceof ProductHttpError) throw error;
      if (error instanceof ReadableReplicaNotFoundError) throw notFound();
      throw error;
    }
  });

  app.post(ITEM, {
    config: {
      ...productRouteMetadata('POST', ITEM),
      productTransport: {
        allowedQuery: [],
        acceptedMediaTypes: ['application/json'],
        bodyLimitBytes: 16_384,
        cacheControl: 'private-no-store',
      },
    },
  }, async (request, reply) => {
    const { account } = await requireMutationActor(request, {
      identityUnitOfWork: deps.identityUnitOfWork,
      allowedOrigins: deps.allowedOrigins,
    });
    if (!deps.enabled) throw notFound();
    if (!deps.enqueue) throw unavailable();
    await admit(deps.rateLimiter, `readable-replicas:principal:${account.id}`);
    const commandId = readKnownCommandId(request);
    let force = false;
    try {
      force = parseReadableReplicaExtractRequest(request.body).force;
    } catch (error: unknown) {
      throw mapExtractError(error);
    }
    try {
      const outcome = await deps.enqueue.execute((ports) => enqueueNodeReadableExtract(ports, {
        actor: { principalId: account.id, subjectId: account.subjectId },
        commandId,
        collectionId: collectionIdParam(request),
        nodeId: nodeIdParam(request),
        force,
        cooldownMs: deps.enqueueCooldownMs,
      }));
      return sendReadableCommandResult(reply, outcome);
    } catch (error: unknown) {
      if (error instanceof ProductHttpError) throw error;
      if (error instanceof ReadableReplicaNotFoundError) throw notFound();
      if (error instanceof ReadableReplicaCooldownError) {
        throw new ProductHttpError({
          statusCode: 429,
          code: 'rate_limited',
          message: 'Readable replica extract is cooling down. Please retry later.',
          recovery: 'same_request',
          sameRequestRetrySafe: true,
          retryAfterSeconds: error.retryAfterSeconds,
          headers: { 'Retry-After': String(error.retryAfterSeconds) },
        });
      }
      throw mapExtractError(error);
    }
  });
}

function sendReadableCommandResult(
  reply: FastifyReply,
  result: Awaited<ReturnType<typeof enqueueNodeReadableExtract>>,
): FastifyReply {
  if (result.kind === 'succeeded') {
    return sendView(reply, result.view);
  }
  if (result.kind === 'replay') {
    for (const [name, value] of Object.entries(result.stableHeaders)) {
      reply.header(name, value);
    }
    return reply.code(result.status).send(Buffer.from(result.body));
  }
  if (result.kind === 'in_progress') {
    throw new ProductHttpError({
      statusCode: 429,
      code: 'rate_limited',
      message: 'This readable replica command is still in progress. Please retry the request.',
      recovery: 'same_request',
      sameRequestRetrySafe: true,
      retryAfterSeconds: result.retryAfterSeconds,
      headers: { 'Retry-After': String(result.retryAfterSeconds) },
    });
  }
  if (result.kind === 'reused') {
    throw new ProductHttpError({
      statusCode: 409,
      code: 'command_id_reused',
      message: 'This command id was already used with a different readable replica request.',
      recovery: 'user_action',
    });
  }
  throw new ProductHttpError({
    statusCode: 410,
    code: 'command_result_expired',
    message: 'The stored result for this readable replica command has expired.',
    recovery: 'user_action',
  });
}

function sendView(reply: FastifyReply, view: ReadableReplicaView) {
  const sent = reply
    .code(200)
    .type('application/json; charset=utf-8')
    .header('cache-control', 'private, no-store');
  if (view.etag !== null) sent.header('etag', view.etag);
  return sent.send(view);
}

function collectionIdParam(request: FastifyRequest): string {
  const params = request.params as { collectionId?: string };
  const collectionId = typeof params.collectionId === 'string' ? params.collectionId : '';
  if (!OPAQUE_ID.test(collectionId)) throw notFound();
  return collectionId;
}

function nodeIdParam(request: FastifyRequest): string {
  const params = request.params as { nodeId?: string };
  const nodeId = typeof params.nodeId === 'string' ? params.nodeId : '';
  if (!OPAQUE_ID.test(nodeId)) throw notFound();
  return nodeId;
}

async function admit(limiter: ProductAdmissionRateLimiter, key: string): Promise<void> {
  const decision = await consumeProductAdmission(limiter, key);
  if (decision.kind === 'failed') throw unavailable();
  if (decision.kind === 'denied') {
    throw new ProductHttpError({
      statusCode: 429, code: 'rate_limited',
      message: 'Too many readable-replica requests.', recovery: 'same_request',
      sameRequestRetrySafe: true, retryAfterSeconds: decision.retryAfterSeconds,
      headers: { 'Retry-After': String(decision.retryAfterSeconds) },
    });
  }
}

function mapExtractError(error: unknown): ProductHttpError {
  if (error instanceof ProductHttpError) return error;
  if (error instanceof ReadableReplicaExtractError) {
    if (error.code === 'invalid_document') {
      return new ProductHttpError({
        statusCode: 422, code: 'invalid_document',
        message: error.message, recovery: 'user_action',
      });
    }
    return new ProductHttpError({
      statusCode: 400, code: 'invalid_request', message: error.message,
    });
  }
  throw error;
}

function notFound() {
  return new ProductHttpError({
    statusCode: 404, code: 'resource_not_found',
    message: 'The requested resource was not found.', recovery: 'none',
  });
}

function unavailable() {
  return new ProductHttpError({
    statusCode: 503, code: 'feature_temporarily_unavailable',
    message: 'The readable-replica service is temporarily unavailable.', recovery: 'same_request',
    sameRequestRetrySafe: true,
  });
}
