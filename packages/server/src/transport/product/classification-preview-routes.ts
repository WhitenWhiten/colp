import type { FastifyInstance } from 'fastify';
import { CreditError, type IdentityUnitOfWork } from '../../modules/identity/index.js';
import { sendCreditError } from './credit-error.js';
import { ClassificationError, ClassificationProviderError, parseClassificationPreviewInput,
  type ClassificationPreviewRuntime } from '../../modules/collections/index.js';
import { requireMutationActor } from '../mutation-actor.js';
import { productRouteMetadata } from '../product-route-manifest.js';
import { ProductHttpError } from '../product-error.js';
import { consumeProductAdmission, type ProductAdmissionRateLimiter } from '../http-security.js';
import { readCollectionIdParam, readKnownCommandId } from './collection-route-helpers.js';
import { mapCollectionMutationError, sendProductCommandReceiptOutcome } from '../product-command-mapping.js';

const PATH = '/api/v1/collections/:collectionId/classification/preview';
export interface ClassificationPreviewRoutesDependencies {
  readonly enabled: boolean;
  readonly allowedOrigins: readonly string[];
  readonly identityUnitOfWork: IdentityUnitOfWork;
  readonly rateLimiter: ProductAdmissionRateLimiter;
  readonly runtime: Pick<ClassificationPreviewRuntime, 'preview'>;
  readonly csrfMatches?: (raw: string, expectedHash: string) => boolean;
}

export function registerClassificationPreviewRoutes(app: FastifyInstance, deps: ClassificationPreviewRoutesDependencies): void {
  app.post(PATH, {config: {...productRouteMetadata('POST', PATH), productTransport: {
    allowedQuery: [], cacheControl: 'private-no-store', acceptedMediaTypes: ['application/json'], bodyLimitBytes: 128 * 1024,
  }}}, async (request, reply) => {
    const {account} = await requireMutationActor(request, deps);
    if (!deps.enabled) throw new ProductHttpError({statusCode: 404, code: 'resource_not_found', message: 'Classification is unavailable.'});
    const admission = await consumeProductAdmission(deps.rateLimiter, `classification-preview:${account.id}`);
    if (admission.kind === 'failed') throw unavailable();
    if (admission.kind === 'denied') throw new ProductHttpError({statusCode: 429, code: 'rate_limited',
      message: 'Classification rate limit exceeded.', retryAfterSeconds: admission.retryAfterSeconds,
      headers: {'Retry-After': String(admission.retryAfterSeconds)}});
    try {
      const result = await deps.runtime.preview({actor: {principalId: account.id, subjectId: account.subjectId},
        collectionId: readCollectionIdParam(request), commandId: readKnownCommandId(request), requestId: request.id,
        document: parseClassificationPreviewInput(request.body)});
      if (result.kind === 'accepted') throw unavailable();
      return sendProductCommandReceiptOutcome(reply, result.kind === 'replay' ? {kind: 'replay', ...result.result} : result);
    } catch (error) {
      if (error instanceof CreditError) return sendCreditError(request, reply, error);
      if (error instanceof ClassificationError) {
        if (error.code === 'resource_not_found') throw new ProductHttpError({statusCode: 404, code: 'resource_not_found', message: 'Collection or bookmark not found.'});
        if (error.code === 'invalid_input') throw new ProductHttpError({statusCode: 422, code: 'invalid_document', message: 'Invalid classification preview document.'});
        if (error.code === 'context_limit') throw new ProductHttpError({statusCode: 413, code: 'payload_too_large', message: 'Classification context exceeds the supported limit.'});
        throw unavailable();
      }
      if (error instanceof ClassificationProviderError) throw unavailable();
      throw mapCollectionMutationError(error) ?? error;
    }
  });
}
function unavailable() {
  return new ProductHttpError({statusCode: 503, code: 'feature_temporarily_unavailable',
    message: 'Classification could not be completed. Retry only with the same command id.',
    recovery: 'same_request', sameRequestRetrySafe: true, retryAfterSeconds: 1, headers: {'Retry-After': '1'}});
}
