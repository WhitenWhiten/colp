import type { FastifyInstance } from 'fastify';
import { CreditError, type IdentityUnitOfWork } from '../../modules/identity/index.js';
import { sendCreditError } from './credit-error.js';
import { CaptureError, parseCaptureDecisionInput, parseCaptureFeedback, type CaptureRuntime } from '../../modules/collections/index.js';
import { requireSessionActor } from '../session-auth.js';
import { requireMutationActor } from '../mutation-actor.js';
import { productRouteMetadata } from '../product-route-manifest.js';
import { ProductHttpError } from '../product-error.js';
import { readCollectionIdParam, readKnownCommandId, readRequiredIfMatch } from './collection-route-helpers.js';
import { consumeProductAdmission, type ProductAdmissionRateLimiter } from '../http-security.js';
import { mapCollectionMutationError } from '../product-command-mapping.js';

export interface CaptureRoutesDeps {
  readonly runtime: CaptureRuntime;
  readonly identityUnitOfWork: IdentityUnitOfWork;
  readonly allowedOrigins: readonly string[];
  readonly rateLimiter: ProductAdmissionRateLimiter;
}
const base = '/api/v1/collections/:collectionId/capture-decisions';
export function registerCaptureRoutes(app: FastifyInstance, deps: CaptureRoutesDeps) {
  app.get('/api/v1/me/capture-capabilities', { config: { ...productRouteMetadata('GET', '/api/v1/me/capture-capabilities'),
    productTransport: { allowedQuery: [], cacheControl: 'private-no-store', rejectRequestBody: true } } }, async request => {
    await requireSessionActor(request, deps.identityUnitOfWork, { touch: false }); return deps.runtime.capabilities();
  });
  app.get(base, { config: { ...productRouteMetadata('GET', base), productTransport: { allowedQuery: ['captureId'], cacheControl: 'private-no-store', rejectRequestBody: true } } }, async (request, reply) => {
    const actor = await requireSessionActor(request, deps.identityUnitOfWork, { touch: false });
    const { captureId } = request.query as { captureId?: string };
    if (!captureId || !/^[0-9a-f-]{36}$/u.test(captureId)) throw mapped(new CaptureError('invalid_request'));
    if ('session' in actor) reply.header('Known-Capture-Session', actor.session.id);
    return { decision: await deps.runtime.find({ principalId: actor.account.id, subjectId: actor.account.subjectId }, readCollectionIdParam(request), captureId) };
  });
  app.get(`${base}/:decisionId`, { config: { ...productRouteMetadata('GET', `${base}/:decisionId`),
    productTransport: { allowedQuery: [], cacheControl: 'private-no-store', rejectRequestBody: true } } }, async request => {
    const { account } = await requireSessionActor(request, deps.identityUnitOfWork, { touch: false });
    const { decisionId } = request.params as { decisionId: string };
    const result = await deps.runtime.get({ principalId: account.id, subjectId: account.subjectId }, readCollectionIdParam(request), decisionId);
    if (!result) throw mapped(new CaptureError('resource_not_found')); return result;
  });
  for (const action of ['classify', 'apply', 'undo', 'correct', 'feedback'] as const) {
    const path = action === 'classify' ? base : `${base}/:decisionId/${action}`;
    app.post(path, { config: { ...productRouteMetadata('POST', path), productTransport: {
      allowedQuery: [], cacheControl: 'private-no-store', acceptedMediaTypes: ['application/json'], bodyLimitBytes: 4096,
    } } }, async (request, reply) => {
      const { account } = await requireMutationActor(request, deps);
      const admission = await consumeProductAdmission(deps.rateLimiter, `capture:${account.id}`);
      if (admission.kind !== 'allowed') throw new ProductHttpError({ statusCode: admission.kind === 'denied' ? 429 : 503,
        code: admission.kind === 'denied' ? 'rate_limited' : 'feature_temporarily_unavailable', message: 'Capture is temporarily unavailable.' });
      const actor = { principalId: account.id, subjectId: account.subjectId };
      try {
        const collectionId = readCollectionIdParam(request), commandId = readKnownCommandId(request);
        if (action === 'classify') return await deps.runtime.classify(actor, collectionId, commandId, parseCaptureDecisionInput(request.body), request.id);
        if (action === 'feedback') {
          const event = parseCaptureFeedback(request.body), match = /^"capture-feedback-(\d+)"$/u.exec(readRequiredIfMatch(request));
          if (!match || !Number.isSafeInteger(Number(match[1])) || event.eventId !== commandId) throw new CaptureError('invalid_request');
          const { decisionId } = request.params as { decisionId: string };
          const receipt = await deps.runtime.feedback(actor, collectionId, decisionId, Number(match[1]), event);
          return reply.header('etag', `"capture-feedback-${receipt.revision}"`).send(receipt);
        }
        if (action === 'correct') {
          const raw = request.body as { parentId?: unknown; tags?: unknown; learningEligible?: unknown; evidenceGeneration?: unknown } | null;
          if (!raw || Object.keys(raw).some(key => !['parentId', 'tags', 'learningEligible', 'evidenceGeneration'].includes(key))
            || typeof raw.parentId !== 'string' || !raw.parentId || raw.parentId.length > 128
            || (raw.learningEligible !== undefined && typeof raw.learningEligible !== 'boolean')
            || (raw.evidenceGeneration !== undefined && (!Number.isSafeInteger(raw.evidenceGeneration) || Number(raw.evidenceGeneration) < 0))
            || !Array.isArray(raw.tags) || raw.tags.length > 64 || raw.tags.some(tag => typeof tag !== 'string')) throw new CaptureError('invalid_request');
          const { decisionId } = request.params as { decisionId: string };
          return await deps.runtime.correct(actor, collectionId, decisionId, commandId, readRequiredIfMatch(request), { parentId: raw.parentId, tags: raw.tags,
            learningEligible: raw.learningEligible === true, evidenceGeneration: typeof raw.evidenceGeneration === 'number' ? raw.evidenceGeneration : undefined });
        }
        if (action === 'undo') {
          if (!request.body || typeof request.body !== 'object' || Object.keys(request.body).length) throw new CaptureError('invalid_request');
          const { decisionId } = request.params as { decisionId: string };
          return await deps.runtime.undo(actor, collectionId, decisionId, commandId, readRequiredIfMatch(request));
        }
        const raw = request.body as { controlGeneration?: unknown; userInitiated?: unknown } | null;
        if (!raw || Object.keys(raw).some(key => !['controlGeneration', 'userInitiated'].includes(key)) || (raw.userInitiated !== undefined && typeof raw.userInitiated !== 'boolean') || !Number.isSafeInteger(raw.controlGeneration) || Number(raw.controlGeneration) < 0) throw new CaptureError('invalid_request');
        const { decisionId } = request.params as { decisionId: string };
        const result = await deps.runtime.apply(actor, collectionId, decisionId, commandId, readRequiredIfMatch(request), Number(raw.controlGeneration), raw.userInitiated === true);
        return reply.header('etag', result.nodeEtag).send(result);
      } catch (error) { if (error instanceof CreditError) return sendCreditError(request, reply, error); throw mapped(error); }
    });
  }
}
function mapped(error: unknown): Error {
  if (error instanceof CaptureError) return new ProductHttpError({ statusCode: error.code === 'resource_not_found' ? 404
    : error.code === 'precondition_failed' ? 412 : error.code === 'invalid_request' ? 400 : 409,
  code: error.code === 'capture_policy_unavailable' ? 'feature_temporarily_unavailable' : error.code, message: error.code });
  return mapCollectionMutationError(error) ?? (error instanceof Error ? error : new Error('capture_unavailable'));
}
