import type { FastifyInstance } from 'fastify';
import { ExtensionAuthError } from '../../modules/identity/index.js';
import { SOURCE_ARCHIVE_PATH, SOURCE_ARCHIVE_PROFILE, SourceArchiveError } from '../../modules/source-archives/index.js';
import type { ExtensionCollectionRouteDependencies } from './extension-collection-routes.js';
import { colpAuthorizationFromRawHeaders } from './sync-colp-authorization.js';
import { createMemorySyncAdmissionPolicy, rateLimitClientIp, syncAdmissionSubjectKey } from '../../infrastructure/rate-limit/index.js';
/** Product extension, negotiated independently of the immutable standard COLP manifest. */
export function registerSourceArchiveRoutes(app: FastifyInstance, deps: ExtensionCollectionRouteDependencies) {
  if (!deps.sourceArchives || !deps.ownerAccount) return;
  const admission = deps.admission ?? createMemorySyncAdmissionPolicy({ budgets: { pull: { maxRequests: 120, windowMs: 60_000 }, push: { maxRequests: 120, windowMs: 60_000 } } });
  if (!deps.admission) app.addHook('onClose', async () => admission.close());
  app.route({ method: ['GET', 'POST'], url: SOURCE_ARCHIVE_PATH, bodyLimit: 128 * 1024,
    config: { productTransport: { allowedQuery: [], acceptedMediaTypes: ['application/json'], bodyLimitBytes: 128 * 1024, cacheControl: 'private-no-store' } },
    handler: async (request, reply) => {
      const purpose = request.method === 'GET' ? 'pull' : 'push';
      const deny = (status: number, code: string) => reply.code(status).header('Cache-Control', 'private, no-store').send({ error: { code } });
      const pre = await admission.admitPreAuth({ purpose, clientKey: rateLimitClientIp(request.ip) });
      if (pre.kind !== 'allowed') { if (pre.kind === 'denied') reply.header('Retry-After', pre.retryAfterSeconds); return deny(pre.kind === 'denied' ? 429 : 503, 'source_admission_unavailable'); }
      if (deps.transportSecurity && !deps.transportSecurity.isSecure(request)) return deny(401, 'authentication_required');
      const origin = request.headers.origin;
      if (origin !== undefined && !deps.allowedOrigins.includes(origin.replace(/\/$/u, ''))) return deny(403, 'origin_not_allowed');
      const fields = new Map<string, string[]>();
      for (let n = 0; n < request.raw.rawHeaders.length; n += 2) { const k = request.raw.rawHeaders[n]!.toLowerCase(); fields.set(k, [...fields.get(k) ?? [], request.raw.rawHeaders[n + 1]!]); }
      const auth = colpAuthorizationFromRawHeaders(fields); if ('denial' in auth) return deny(401, auth.denial);
      try {
        const credential = await deps.credentialVerifier.verify({ authorization: auth.authorization });
        const budget = await admission.admitSubject({ purpose, subjectKey: syncAdmissionSubjectKey({ credential }) });
        if (budget.kind !== 'allowed') { if (budget.kind === 'denied') reply.header('Retry-After', budget.retryAfterSeconds); return deny(budget.kind === 'denied' ? 429 : 503, 'source_admission_unavailable'); }
        const owner = await deps.ownerAccount!.resolveActiveAccount({ issuer: credential.issuer, subject: credential.subject });
        if (!owner) return deny(401, 'source_account_unavailable');
        reply.header('Cache-Control', 'private, no-store');
        if (request.method === 'GET') return reply.send(SOURCE_ARCHIVE_PROFILE);
        return reply.send(await deps.sourceArchives!.execute({ ...owner, credentialId: credential.credentialId, credentialIssuer: credential.issuer }, request.body));
      } catch (error) {
        if (error instanceof SourceArchiveError) return deny(error.status, error.code);
        if (error instanceof ExtensionAuthError) return deny(401, 'invalid_token');
        // Never log site content, credentials, scoped roots or command bodies.
        request.log.error({ code: 'source_archive_failed' }, 'Source archive transaction failed');
        return deny(503, 'source_outcome_unknown');
      }
    },
  });
}
