import type { FastifyInstance } from 'fastify';
import type { FastifyRequest } from 'fastify';
import { observeBestEffort } from '../../infrastructure/async/best-effort.js';
import type { IdentityUnitOfWork } from '../../modules/identity/index.js';
import {
  CollectionExportCapacityError,
  ExportCollectionError,
  renderCollectionExport,
  type CollectionExportReadPort,
} from '../../modules/collections/index.js';
import { ProductHttpError } from '../product-error.js';
import { requireSessionActor } from '../session-auth.js';
import type { ProductAdmissionRateLimiter } from '../http-security.js';
import { consumeProductAdmission } from '../http-security.js';

const ROUTE = '/api/v1/collections/:collectionId/export';
const OPAQUE_ID = /^[A-Za-z0-9._~-]{1,128}$/u;

export interface CollectionExportRouteDependencies {
  readonly identityUnitOfWork: IdentityUnitOfWork;
  readonly origin: string;
  readonly reads: CollectionExportReadPort;
  readonly rateLimiter: ProductAdmissionRateLimiter;
  readonly timeoutMs: number;
}

export function registerCollectionExportRoutes(
  app: FastifyInstance,
  deps: CollectionExportRouteDependencies,
): void {
  if (!Number.isInteger(deps.timeoutMs) || deps.timeoutMs < 1 || deps.timeoutMs > 30_000) {
    throw new TypeError('Collection-export route timeout is invalid.');
  }
  app.get(ROUTE, {
    config: {
      productTransport: {
        allowedQuery: ['format'],
        rejectRequestBody: true,
        cacheControl: 'private-no-store',
      },
    },
  }, async (request, reply) => {
    const { account } = await requireSessionActor(request, deps.identityUnitOfWork, { touch: false });
    await admit(deps.rateLimiter, `${ROUTE}:principal:${account.id}`);
    const collectionId = (request.params as { collectionId?: unknown }).collectionId;
    if (typeof collectionId !== 'string' || !OPAQUE_ID.test(collectionId)) throw notFound();
    const format = readFormat(request.query);
    let rendered;
    try {
      rendered = await withCancellation(request, deps.timeoutMs, async (signal) => {
        const source = await deps.reads.loadForPrincipal({ collectionId, subjectId: account.subjectId, signal });
        if (source === null) throw notFound();
        // Keep rendering inside the same cancellation scope. This ensures a
        // disconnect observed after the database read cannot still allocate
        // and serialize a large export that will never be sent.
        if (signal.aborted) throw new Error('export request aborted');
        return renderCollectionExport(source, {
          principalId: account.id,
          origin: deps.origin,
          format,
        });
      });
    } catch (error: unknown) {
      if (error instanceof ProductHttpError) throw error;
      if (error instanceof ExportCollectionError && error.code === 'not_found') throw notFound();
      if (error instanceof CollectionExportCapacityError) {
        throw new ProductHttpError({
          statusCode: 413,
          code: 'payload_too_large',
          message: error.message,
          recovery: 'user_action',
        });
      }
      throw new ProductHttpError({
        statusCode: 500,
        code: 'internal_error',
        message: 'The request could not be completed.',
      });
    }
    return reply
      .code(200)
      .header('content-disposition', `attachment; filename="${rendered.filename}"`)
      .header('x-content-type-options', 'nosniff')
      .type(rendered.contentType)
      .send(rendered.body);
  });
}

async function admit(limiter: ProductAdmissionRateLimiter, key: string): Promise<void> {
  const decision = await consumeProductAdmission(limiter, key);
  if (decision.kind === 'failed') {
    throw new ProductHttpError({
      statusCode: 503, code: 'feature_temporarily_unavailable',
      message: 'The export service is temporarily unavailable.', recovery: 'same_request',
    });
  }
  if (decision.kind === 'denied') {
    throw new ProductHttpError({
      statusCode: 429, code: 'rate_limited',
      message: 'Too many collection export requests.', recovery: 'same_request',
      sameRequestRetrySafe: true, retryAfterSeconds: decision.retryAfterSeconds,
      headers: { 'Retry-After': String(decision.retryAfterSeconds) },
    });
  }
}

async function withCancellation<T>(
  request: FastifyRequest, timeoutMs: number, work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let rejectAbort!: (error: Error) => void;
  const cancellation = new Promise<never>((_, reject) => { rejectAbort = reject; });
  observeBestEffort(cancellation, 'collection export cancellation race');
  const timeout = setTimeout(() => {
    controller.abort();
    rejectAbort(new ProductHttpError({
      statusCode: 503, code: 'feature_temporarily_unavailable',
      message: 'The export request exceeded its deadline.', recovery: 'same_request',
    }));
  }, timeoutMs);
  timeout.unref?.();
  const abort = () => {
    controller.abort();
    rejectAbort(new ProductHttpError({
      statusCode: 503, code: 'feature_temporarily_unavailable',
      message: 'The export request was interrupted.', recovery: 'same_request',
    }));
  };
  request.raw.once('aborted', abort);
  request.raw.socket.once('close', abort);
  try {
    return await Promise.race([work(controller.signal), cancellation]);
  } finally {
    clearTimeout(timeout);
    request.raw.off('aborted', abort);
    request.raw.socket.off('close', abort);
  }
}

function readFormat(query: unknown): 'html' | 'json' {
  if (typeof query !== 'object' || query === null) {
    throw invalidQuery('format must be html or json');
  }
  const format = (query as { format?: unknown }).format;
  if (format === 'html' || format === 'json') return format;
  throw invalidQuery('format must be html or json');
}

function notFound(): ProductHttpError {
  return new ProductHttpError({
    statusCode: 404,
    code: 'resource_not_found',
    message: 'Collection was not found.',
    recovery: 'none',
  });
}

function invalidQuery(message: string): ProductHttpError {
  return new ProductHttpError({
    statusCode: 400,
    code: 'invalid_query',
    message,
    recovery: 'same_request',
  });
}
