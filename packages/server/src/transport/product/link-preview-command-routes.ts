/**
 * LP-05 POST /api/v1/collections/:collectionId/link-preview-requests — an
 * owner or editor asks for the preview images of the bookmarks on screen.
 * Registered with the rest of the Product surface; 404 while
 * KNOWN_FEATURE_LINK_PREVIEW is off. Admission has its own per-principal key.
 */
import type { FastifyInstance } from 'fastify';
import type { IdentityUnitOfWork } from '../../modules/identity/index.js';
import {
  LinkPreviewCommandError,
  parseLinkPreviewRequestBody,
  requestCollectionLinkPreviews,
  type LinkPreviewCommandUnitOfWork,
} from '../../modules/collections/index.js';
import { consumeProductAdmission, type ProductAdmissionRateLimiter } from '../http-security.js';
import { mapCollectionMutationError, sendProductCommandReceiptOutcome } from '../product-command-mapping.js';
import { ProductHttpError } from '../product-error.js';
import { productRouteMetadata } from '../product-route-manifest.js';
import { requireMutationActor } from '../mutation-actor.js';
import { invalidDocument, readCollectionIdParam, readKnownCommandId } from './collection-route-helpers.js';

const REQUESTS = '/api/v1/collections/:collectionId/link-preview-requests';

export interface LinkPreviewCommandRoutesDependencies {
  readonly enabled: boolean;
  readonly allowedOrigins: readonly string[];
  readonly identityUnitOfWork: IdentityUnitOfWork;
  readonly unitOfWork?: LinkPreviewCommandUnitOfWork;
  readonly rateLimiter: ProductAdmissionRateLimiter;
}

export function registerLinkPreviewCommandRoutes(
  app: FastifyInstance,
  deps: LinkPreviewCommandRoutesDependencies,
): void {
  const jsonWrite = {
    allowedQuery: [], acceptedMediaTypes: ['application/json'], bodyLimitBytes: 16_384, cacheControl: 'private-no-store',
  } as const;

  app.post(REQUESTS, { config: { ...productRouteMetadata('POST', REQUESTS), productTransport: jsonWrite } }, async (request, reply) => {
    const { account } = await requireMutationActor(request, {
      identityUnitOfWork: deps.identityUnitOfWork, allowedOrigins: deps.allowedOrigins,
    });
    const unitOfWork = await admitted(deps, account.id);
    const commandId = readKnownCommandId(request);
    const nodeIds = mapErrors(() => parseLinkPreviewRequestBody(request.body));
    let outcome: Awaited<ReturnType<typeof requestCollectionLinkPreviews>>;
    try {
      outcome = await unitOfWork.execute((ports) => requestCollectionLinkPreviews(ports, {
        actor: { principalId: account.id, subjectId: account.subjectId },
        commandId,
        collectionId: readCollectionIdParam(request),
        nodeIds,
      }));
    } catch (error: unknown) {
      throw mapCommandError(error);
    }
    if (outcome.kind !== 'succeeded') return sendProductCommandReceiptOutcome(reply, outcome);
    return reply.code(202).header('cache-control', 'private, no-store').send({ enqueued: outcome.enqueued });
  });
}

async function admitted(
  deps: LinkPreviewCommandRoutesDependencies,
  principalId: string,
): Promise<LinkPreviewCommandUnitOfWork> {
  if (!deps.enabled) {
    throw new ProductHttpError({
      statusCode: 404, code: 'resource_not_found', message: 'The requested resource was not found.', recovery: 'none',
    });
  }
  if (deps.unitOfWork === undefined) throw unavailable();
  const decision = await consumeProductAdmission(deps.rateLimiter, `link-previews:principal:${principalId}`);
  if (decision.kind === 'failed') throw unavailable();
  if (decision.kind === 'denied') {
    throw new ProductHttpError({
      statusCode: 429, code: 'rate_limited', message: 'Too many link preview requests.', recovery: 'same_request',
      sameRequestRetrySafe: true, retryAfterSeconds: decision.retryAfterSeconds,
      headers: { 'Retry-After': String(decision.retryAfterSeconds) },
    });
  }
  return deps.unitOfWork;
}

function mapErrors<Value>(read: () => Value): Value {
  try {
    return read();
  } catch (error: unknown) {
    throw mapCommandError(error);
  }
}

function mapCommandError(error: unknown): unknown {
  if (error instanceof LinkPreviewCommandError) {
    return error.code === 'invalid_document'
      ? invalidDocument(error.message)
      : new ProductHttpError({ statusCode: 400, code: 'invalid_request', message: error.message });
  }
  return mapCollectionMutationError(error) ?? error;
}

function unavailable(): ProductHttpError {
  return new ProductHttpError({
    statusCode: 503, code: 'feature_temporarily_unavailable',
    message: 'Link previews are temporarily unavailable.', recovery: 'same_request', sameRequestRetrySafe: true,
  });
}
