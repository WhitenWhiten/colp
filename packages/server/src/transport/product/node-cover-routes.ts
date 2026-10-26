import type { FastifyInstance, FastifyReply } from 'fastify';
import type { IdentityUnitOfWork } from '../../modules/identity/index.js';
import { CoverImageError, IMAGE_MAX_BYTES, IMAGE_MIME_TYPES, parseCoverPreference,
  uploadCollectionImage, updateNodeCover, type CoverCommandOutcome,
  type NodeCoverCommandUnitOfWork } from '../../modules/collections/index.js';
import { requireMutationActor } from '../mutation-actor.js';
import { ProductHttpError } from '../product-error.js';
import { productRouteMetadata } from '../product-route-manifest.js';
import { mapCollectionMutationError, sendProductCommandReceiptOutcome } from '../product-command-mapping.js';
import { consumeProductAdmission, type ProductAdmissionRateLimiter } from '../http-security.js';
import { readCollectionIdParam, readKnownCommandId, readNodeIdParam } from './collection-route-helpers.js';

export interface NodeCoverRouteDependencies {
  readonly identityUnitOfWork: IdentityUnitOfWork;
  readonly commands: NodeCoverCommandUnitOfWork;
  readonly allowedOrigins: readonly string[];
  readonly productOrigin: string;
  readonly rateLimiter: ProductAdmissionRateLimiter;
}

export function registerNodeCoverRoutes(app: FastifyInstance, deps: NodeCoverRouteDependencies): void {
  for (const mime of IMAGE_MIME_TYPES) {
    if (!app.hasContentTypeParser(mime)) {
      app.addContentTypeParser(mime, { parseAs: 'buffer' }, (_request, body, done) => done(null, body));
    }
  }
  const uploadPath = '/api/v1/collections/:collectionId/images';
  app.post(uploadPath, { bodyLimit: IMAGE_MAX_BYTES, config: {
    ...productRouteMetadata('POST', uploadPath), productTransport: {
      allowedQuery: [], acceptedMediaTypes: [...IMAGE_MIME_TYPES],
      bodyLimitBytes: IMAGE_MAX_BYTES, cacheControl: 'private-no-store',
    },
  } }, async (request, reply) => {
    const { account } = await requireMutationActor(request, deps);
    await admit(deps, account.id);
    if (!Buffer.isBuffer(request.body)) throw new ProductHttpError({ statusCode: 400, code: 'invalid_request', message: 'An image body is required.' });
    try {
      const outcome = await deps.commands.execute(ports => uploadCollectionImage(ports, {
        actor: { principalId: account.id, subjectId: account.subjectId }, commandId: readKnownCommandId(request),
        collectionId: readCollectionIdParam(request), productOrigin: deps.productOrigin, body: request.body as Buffer,
      }));
      return sendOutcome(reply, outcome);
    } catch (error) { throw mapError(error); }
  });
  const coverPath = '/api/v1/collections/:collectionId/nodes/:nodeId/cover';
  app.put(coverPath, { config: { ...productRouteMetadata('PUT', coverPath), productTransport: {
    allowedQuery: [], acceptedMediaTypes: ['application/json'], bodyLimitBytes: 4096, cacheControl: 'private-no-store',
  } } }, async (request, reply) => {
    const { account } = await requireMutationActor(request, deps);
    await admit(deps, account.id);
    const ifMatch = request.headers['if-match'];
    if (ifMatch === undefined) throw new ProductHttpError({ statusCode: 428, code: 'precondition_required', message: 'If-Match is required.' });
    if (typeof ifMatch !== 'string' || !/^"cover:(0|[1-9][0-9]{0,18})"$/u.test(ifMatch)) {
      throw new ProductHttpError({ statusCode: 400, code: 'invalid_request', message: 'If-Match must contain the cover revision.' });
    }
    try {
      const preference = parseCoverPreference(request.body);
      const outcome = await deps.commands.execute(ports => updateNodeCover(ports, {
        actor: { principalId: account.id, subjectId: account.subjectId }, commandId: readKnownCommandId(request),
        collectionId: readCollectionIdParam(request), nodeId: readNodeIdParam(request),
        productOrigin: deps.productOrigin, expectedRevision: ifMatch.slice(7, -1), ...preference,
      }));
      return sendOutcome(reply, outcome);
    } catch (error) { throw mapError(error); }
  });
}

function sendOutcome(reply: FastifyReply, outcome: CoverCommandOutcome): FastifyReply {
  if (outcome.kind !== 'succeeded') return sendProductCommandReceiptOutcome(reply, outcome);
  return reply.code(outcome.status).header('cache-control', 'private, no-store').send(outcome.value);
}

function mapError(error: unknown): unknown {
  if (error instanceof CoverImageError) return new ProductHttpError({
    statusCode: error.code === 'precondition_failed' ? 412 : error.code === 'payload_too_large' ? 413 : 422,
    code: error.code, message: error.message,
    recovery: error.code === 'precondition_failed' ? 'refresh_and_retry' : 'user_action',
  });
  return mapCollectionMutationError(error) ?? error;
}

async function admit(deps: NodeCoverRouteDependencies, principalId: string): Promise<void> {
  const decision = await consumeProductAdmission(deps.rateLimiter, `cover-images:${principalId}`);
  if (decision.kind === 'failed') throw new ProductHttpError({ statusCode: 503,
    code: 'feature_temporarily_unavailable', message: 'Image uploads are temporarily unavailable.', recovery: 'same_request', sameRequestRetrySafe: true });
  if (decision.kind === 'denied') throw new ProductHttpError({ statusCode: 429, code: 'rate_limited',
    message: 'Too many image requests.', recovery: 'same_request', sameRequestRetrySafe: true,
    retryAfterSeconds: decision.retryAfterSeconds, headers: { 'Retry-After': String(decision.retryAfterSeconds) } });
}
