import type { FastifyInstance } from 'fastify';
import type { ActivityPorts, ActivityReadRequest } from '../../modules/activity/index.js';
import type { IdentityUnitOfWork } from '../../modules/identity/index.js';
import { AutomationError } from '../../modules/automation/index.js';
import { requireBrowserSessionActor } from '../session-auth.js';
import { requireMutationActor } from '../mutation-actor.js';
import { productRouteMetadata } from '../product-route-manifest.js';
import { ProductHttpError } from '../product-error.js';
import { productErrorStatus } from '../product-codes.js';
import { readKnownCommandId } from './collection-route-helpers.js';

export interface ActivityRouteDeps {
  identityUnitOfWork: IdentityUnitOfWork; allowedOrigins: readonly string[]; activity: ActivityPorts;
}
const invalid = () => new ProductHttpError({ statusCode: 400, code: 'invalid_request', message: 'Provide either 1–100 unique activity ids or one through id.' });
function parseRead(body: unknown): ActivityReadRequest {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 1) throw invalid();
  const record = body as Record<string, unknown>;
  const id = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 128;
  if (id(record.through)) return { through: record.through };
  if (Array.isArray(record.ids) && record.ids.length >= 1 && record.ids.length <= 100 && record.ids.every(id)
    && new Set(record.ids).size === record.ids.length) return { ids: record.ids };
  throw invalid();
}
export function registerActivityRoutes(app: FastifyInstance, deps: ActivityRouteDeps): void {
  for (const [method, suffix, allowedQuery] of [['GET', '', ['state','cursor','limit']], ['GET', '/summary', []], ['POST', '/read', []]] as const) {
    const url = `/api/v1/me/activity${suffix}`;
    app.route({ method, url, exposeHeadRoute: false,
      config: { ...productRouteMetadata(method, url), productTransport: { allowedQuery, cacheControl: 'private-no-store',
        ...(method === 'GET' ? { rejectRequestBody: true } : { acceptedMediaTypes: ['application/json'], bodyLimitBytes: 32_768 }) } },
      handler: async (request, reply) => {
        const actor = await requireBrowserSessionActor(request, deps.identityUnitOfWork, { touch: false });
        try {
          let result;
          if (method === 'POST') {
            await requireMutationActor(request, deps); readKnownCommandId(request);
            result = await deps.activity.markRead(actor.account.id, parseRead(request.body));
          } else result = suffix === '/summary' ? await deps.activity.summary(actor.account.id)
            : await deps.activity.list(actor.account.id, request.query as Record<string, string>);
          return reply.header('cache-control', 'private, no-store').send(result);
        } catch (error) {
          if (error instanceof AutomationError) throw new ProductHttpError({ statusCode: productErrorStatus(error.code), code: error.code, message: error.message });
          throw error;
        }
      } });
  }
}
