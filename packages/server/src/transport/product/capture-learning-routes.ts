import type { FastifyInstance } from 'fastify';
import type { IdentityUnitOfWork } from '../../modules/identity/index.js';
import { CaptureError, type CaptureActor, type CaptureLearningView } from '../../modules/collections/index.js';
import { requireSessionActor } from '../session-auth.js';
import { requireMutationActor } from '../mutation-actor.js';
import { productRouteMetadata } from '../product-route-manifest.js';
import { ProductHttpError } from '../product-error.js';
import { readKnownCommandId, readRequiredIfMatch } from './collection-route-helpers.js';
export interface CaptureLearningRuntime {
  get(actor: CaptureActor): Promise<CaptureLearningView>;
  clear(actor: CaptureActor, commandId: string, expectedGeneration: number): Promise<{ generation: number; clearedAt: string }>;
}
export function registerCaptureLearningRoutes(app: FastifyInstance, deps: { identityUnitOfWork: IdentityUnitOfWork;
  allowedOrigins: readonly string[]; runtime: CaptureLearningRuntime }) {
  const path = '/api/v1/me/capture-learning';
  app.get(path, { config: { ...productRouteMetadata('GET', path), productTransport: { allowedQuery: [], cacheControl: 'private-no-store', rejectRequestBody: true } } }, async (request, reply) => {
    const actor = await requireSessionActor(request, deps.identityUnitOfWork, { touch: false });
    if ('session' in actor) reply.header('Known-Capture-Session', actor.session.id);
    const value = await deps.runtime.get({ principalId: actor.account.id, subjectId: actor.account.subjectId });
    return reply.header('etag', `"capture-learning-${value.generation}"`).send(value);
  });
  app.post(`${path}/clear`, { config: { ...productRouteMetadata('POST', `${path}/clear`), productTransport: { allowedQuery: [],
    cacheControl: 'private-no-store', acceptedMediaTypes: ['application/json'], bodyLimitBytes: 1024 } } }, async (request, reply) => {
    const { account } = await requireMutationActor(request, deps);
    const match = /^"capture-learning-(\d+)"$/u.exec(readRequiredIfMatch(request));
    if (!match || !Number.isSafeInteger(Number(match[1])) || !request.body || typeof request.body !== 'object' || Array.isArray(request.body) || Object.keys(request.body).length) {
      throw new ProductHttpError({ statusCode: 400, code: 'invalid_request', message: 'A memory generation and empty document are required.' });
    }
    try {
      const result = await deps.runtime.clear({ principalId: account.id, subjectId: account.subjectId }, readKnownCommandId(request), Number(match[1]));
      return reply.header('etag', `"capture-learning-${result.generation}"`).send(result);
    } catch (error) {
      if (error instanceof CaptureError) throw new ProductHttpError({ statusCode: error.code === 'precondition_failed' ? 412 : 409,
        code: error.code === 'precondition_failed' ? 'precondition_failed' : 'command_id_reused', message: error.message });
      throw error;
    }
  });
}
