/**
 * LP-05 link preview Product commands:
 *
 * - POST /api/v1/collections/:collectionId/link-preview-requests
 * - GET|PUT /api/v1/collections/:collectionId/nodes/:nodeId/preview-image-mode
 *
 * Registered with the rest of the Product surface; every route is 404 while
 * KNOWN_FEATURE_LINK_PREVIEW is off. Admission shares the readable-replica
 * family (user-triggered page fetches) under its own per-principal key.
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { IdentityUnitOfWork } from '../../modules/identity/index.js';
import {
  getBookmarkPreviewMode,
  LinkPreviewCommandError,
  parseBookmarkPreviewModeBody,
  parseLinkPreviewRequestBody,
  requestCollectionLinkPreviews,
  setBookmarkPreviewMode,
  type BookmarkPreviewModeView,
  type LinkPreviewCommandUnitOfWork,
} from '../../modules/collections/index.js';
import { consumeProductAdmission, type ProductAdmissionRateLimiter } from '../http-security.js';
import { mapCollectionMutationError, sendProductCommandReceiptOutcome } from '../product-command-mapping.js';
import { ProductHttpError } from '../product-error.js';
import { productRouteMetadata } from '../product-route-manifest.js';
import { requireMutationActor } from '../mutation-actor.js';
import { requireSessionActor } from '../session-auth.js';
import {
  invalidDocument,
  readCollectionIdParam,
  readKnownCommandId,
  readNodeIdParam,
  readRequiredIfMatch,
} from './collection-route-helpers.js';

const REQUESTS = '/api/v1/collections/:collectionId/link-preview-requests';
const MODE = '/api/v1/collections/:collectionId/nodes/:nodeId/preview-image-mode';

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
  const jsonWrite = { allowedQuery: [], acceptedMediaTypes: ['application/json'], bodyLimitBytes: 16_384, cacheControl: 'private-no-store' } as const;

  app.post(REQUESTS, { config: { ...productRouteMetadata('POST', REQUESTS), productTransport: jsonWrite } }, async (request, reply) => {
    const { account } = await requireMutationActor(request, { identityUnitOfWork: deps.identityUnitOfWork, allowedOrigins: deps.allowedOrigins });
    const unitOfWork = await admitted(deps, account.id);
    const commandId = readKnownCommandId(request);
    const nodeIds = parse(() => parseLinkPreviewRequestBody(request.body));
    const outcome = await run(() => unitOfWork.execute((ports) => requestCollectionLinkPreviews(ports, {
      actor: { principalId: account.id, subjectId: account.subjectId },
      commandId,
      collectionId: readCollectionIdParam(request),
      nodeIds,
    })));
    if (outcome.kind !== 'succeeded') return sendProductCommandReceiptOutcome(reply, outcome);
    return reply.code(202).header('cache-control', 'private, no-store').send({ enqueued: outcome.enqueued });
  });

  app.get(MODE, { config: { ...productRouteMetadata('GET', MODE), productTransport: { allowedQuery: [], cacheControl: 'private-no-store' } } }, async (request, reply) => {
    const { account } = await requireSessionActor(request, deps.identityUnitOfWork, { touch: false });
    const unitOfWork = await admitted(deps, account.id);
    const view = await run(() => unitOfWork.execute((ports) => getBookmarkPreviewMode(ports, {
      actor: { principalId: account.id, subjectId: account.subjectId },
      collectionId: readCollectionIdParam(request),
      nodeId: readNodeIdParam(request),
    })));
    return sendModeView(reply, view);
  });

  app.put(MODE, { config: { ...productRouteMetadata('PUT', MODE), productTransport: jsonWrite } }, async (request, reply) => {
    const { account } = await requireMutationActor(request, { identityUnitOfWork: deps.identityUnitOfWork, allowedOrigins: deps.allowedOrigins });
    const unitOfWork = await admitted(deps, account.id);
    const commandId = readKnownCommandId(request);
    const expectedEtag = readRequiredIfMatch(request);
    const mode = parse(() => parseBookmarkPreviewModeBody(request.body));
    const outcome = await run(() => unitOfWork.execute((ports) => setBookmarkPreviewMode(ports, {
      actor: { principalId: account.id, subjectId: account.subjectId },
      commandId,
      collectionId: readCollectionIdParam(request),
      nodeId: readNodeIdParam(request),
      mode,
      expectedEtag,
    })));
    if (outcome.kind !== 'succeeded') return sendProductCommandReceiptOutcome(reply, outcome);
    return sendModeView(reply, outcome.view);
  });
}

async function admitted(deps: LinkPreviewCommandRoutesDependencies, principalId: string): Promise<LinkPreviewCommandUnitOfWork> {
  if (!deps.enabled) throw notFound();
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

function parse<Value>(read: () => Value): Value {
  try {
    return read();
  } catch (error: unknown) {
    throw mapCommandError(error);
  }
}

async function run<Value>(work: () => Promise<Value>): Promise<Value> {
  try {
    return await work();
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

function sendModeView(reply: FastifyReply, view: BookmarkPreviewModeView): FastifyReply {
  return reply.code(200).header('cache-control', 'private, no-store').header('etag', view.etag).send(view);
}

function notFound(): ProductHttpError {
  return new ProductHttpError({
    statusCode: 404, code: 'resource_not_found', message: 'The requested resource was not found.', recovery: 'none',
  });
}

function unavailable(): ProductHttpError {
  return new ProductHttpError({
    statusCode: 503, code: 'feature_temporarily_unavailable',
    message: 'Link previews are temporarily unavailable.', recovery: 'same_request', sameRequestRetrySafe: true,
  });
}
