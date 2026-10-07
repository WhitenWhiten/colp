import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ProblemCode } from '@know-n/colp/server';
import { createPublicationProblemDescriptor } from '@know-n/colp/server';
import {
  resolveSyncAdmissionPolicy,
  syncAdmissionPolicyHeader,
  syncAdmissionSubjectKey,
  type EffectPageRateLimiter,
  type SyncAdmissionPolicy,
} from '../../infrastructure/rate-limit/index.js';
import type { ExtensionCredentialEvidencePort } from '../../modules/identity/index.js';
import { SyncEffectPageReadError, type SyncEffectPageReadPort } from '../../modules/sync/index.js';
import { createMemoryEffectPageRateLimiter, rateLimitClientKey } from '../http-security.js';
import { requireColpAuthorization } from './sync-colp-authorization.js';
import { createSyncTransportSecurity } from './sync-transport-security.js';

export interface SyncEffectPageRouteDependencies {
  readonly pathTemplate: string;
  readonly credentialVerifier: ExtensionCredentialEvidencePort;
  readonly reader: SyncEffectPageReadPort;
  readonly allowedOrigins: readonly string[];
  readonly responseBudgetBytes: number;
  /** Subject/session and per-effect budgets supplement unified principal/IP admission. */
  readonly rateLimit: {
    readonly subjectMaxRequests: number;
    readonly effectMaxRequests: number;
    readonly ipMaxRequests: number;
    readonly windowMs: number;
  };
  /** Shared-mode production must inject this limiter; memory is single-instance only. */
  readonly rateLimiter?: EffectPageRateLimiter;
  readonly admission?: SyncAdmissionPolicy;
  readonly allowInsecureLoopback?: boolean;
  /** Explicit TRUSTED_INGRESS allowlist (FIX-M-008): forwarded TLS evidence is accepted only from allowlisted socket peers. */
  readonly trustedIngress?: readonly string[];
}

/**
 * FIX-L-031 (SYNC-R15): route admission outcomes speak the registered COLP
 * ProblemCode directly, exactly like the sibling Sync endpoints, so the wire
 * contract (origin_not_allowed, WWW-Authenticate and invalid_cursor_scope)
 * stays uniform across the cluster. The reader port raises
 * SyncEffectPageReadError for existence, integrity, or payload-size outcomes.
 */
class SyncEffectPageHttpError extends Error {
  constructor(readonly code: ProblemCode, readonly retryAfterSeconds?: number) {
    super(`Sync effect page denied: ${code}`); this.name = 'SyncEffectPageHttpError';
  }
}

export function registerSyncEffectPageRoutes(app: FastifyInstance, dependencies: SyncEffectPageRouteDependencies): void {
  const path = dependencies.pathTemplate.replace('{effectId}', ':effectId').replace('{pageNumber}', ':pageNumber');
  if (!dependencies.pathTemplate.includes('{effectId}') || !dependencies.pathTemplate.includes('{pageNumber}')) {
    throw new TypeError('syncEffectPages template is invalid');
  }
  for (const value of [dependencies.rateLimit.subjectMaxRequests, dependencies.rateLimit.effectMaxRequests,
    dependencies.rateLimit.ipMaxRequests, dependencies.rateLimit.windowMs]) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new TypeError('Sync effect-page budgets must be positive safe integers');
    }
  }
  const admission = resolveSyncAdmissionPolicy(
    dependencies.admission,
    'effect-page',
    { maxRequests: dependencies.rateLimit.ipMaxRequests, windowMs: dependencies.rateLimit.windowMs },
  );
  const effectLimiter = dependencies.rateLimiter ?? createMemoryEffectPageRateLimiter(dependencies.rateLimit);
  if (typeof effectLimiter.consume !== 'function') throw new TypeError('Sync effect-page limiter is invalid');
  app.addHook('onClose', async () => {
    if (dependencies.admission === undefined) await admission.close();
    if (dependencies.rateLimiter === undefined) await effectLimiter.close();
  });
  const transportSecurity = createSyncTransportSecurity({
    allowInsecureLoopback: dependencies.allowInsecureLoopback === true,
    ...(dependencies.trustedIngress === undefined ? {} : { trustedIngress: dependencies.trustedIngress }),
  });
  app.get(path, async (request, reply) => {
    try {
      if (!transportSecurity.isSecure(request)) throw new SyncEffectPageHttpError('authentication_required');
      // The low-cost trusted-client IP budget covers EVERY request before parsing,
      // credentials or database work. It remains independent of specialized limits.
      reply.header('RateLimit-Policy', syncAdmissionPolicyHeader('effect-page', {
        maxRequests: dependencies.rateLimit.ipMaxRequests, windowMs: dependencies.rateLimit.windowMs,
      }));
      const ipOutcome = await admission.admitPreAuth({
        purpose: 'effect-page',
        clientKey: rateLimitClientKey(request, path),
      });
      if (ipOutcome.kind === 'denied') {
        reply.header('Retry-After', String(ipOutcome.retryAfterSeconds));
        throw new SyncEffectPageHttpError('rate_limited', ipOutcome.retryAfterSeconds);
      }
      if (ipOutcome.kind === 'failed') {
        reply.removeHeader('RateLimit-Policy');
        throw new SyncEffectPageHttpError('service_unavailable');
      }
      // Exact single-valued headers. A legacy query may repeat Session identity,
      // but must never participate in quota keys.
      const fields = collectRawHeaders(request.raw.rawHeaders);
      const authorization = requireColpAuthorization(fields, (code) => new SyncEffectPageHttpError(code));
      const origin = exactlyOne(fields, 'origin', 'origin_not_allowed');
      if (!dependencies.allowedOrigins.includes(origin)) throw new SyncEffectPageHttpError('origin_not_allowed');
      const headerSessionId = opaque(exactlyOne(fields, 'known-sync-session', 'resource_not_found'));
      let credential;
      try { credential = await dependencies.credentialVerifier.verify({ authorization }); }
      catch { throw new SyncEffectPageHttpError('authentication_required'); }
      const params = request.params as { readonly effectId?: unknown; readonly pageNumber?: unknown };
      const query = request.query as Record<string, unknown>;
      const legacyQuery = parseLegacyIdentityQuery(query);
      if (legacyQuery !== undefined && legacyQuery.sessionId !== headerSessionId) {
        throw new SyncEffectPageHttpError('resource_not_found');
      }
      const effectId = opaque(params.effectId); const pageNumber = Number(params.pageNumber);
      if (!Number.isSafeInteger(pageNumber) || pageNumber < 1 || pageNumber > 1_024) {
        throw new SyncEffectPageHttpError('resource_not_found');
      }
      if (legacyQuery !== undefined) {
        request.log.info({ event: 'sync_effect_page_legacy_query' }, 'deprecated effect-page identity query');
      }
      // Keep the unified verified-principal budget: session/credential rotation
      // must not replenish the aggregate quota.
      const outcome = await admission.admitSubject({
        purpose: 'effect-page',
        subjectKey: syncAdmissionSubjectKey({ credential }),
      });
      if (outcome.kind === 'denied') {
        reply.header('Retry-After', String(outcome.retryAfterSeconds));
        throw new SyncEffectPageHttpError('rate_limited', outcome.retryAfterSeconds);
      }
      if (outcome.kind === 'failed') {
        reply.removeHeader('RateLimit-Policy');
        throw new SyncEffectPageHttpError('service_unavailable');
      }
      reply.header('RateLimit-Policy',
        `${syncAdmissionPolicyHeader('effect-page', {
          maxRequests: dependencies.rateLimit.subjectMaxRequests, windowMs: dependencies.rateLimit.windowMs,
        })}, "sync-effect";q=${dependencies.rateLimit.effectMaxRequests};w=${Math.ceil(dependencies.rateLimit.windowMs / 1_000)}`);
      let effectOutcome;
      try {
        effectOutcome = await effectLimiter.consume({
          clientIp: request.ip,
          sessionId: headerSessionId,
          // A Session names exactly one replica. Reuse its opaque identity rather
          // than the deprecated, unverified query replicaId; rotating pages or
          // query identities cannot create new subject/effect counters.
          replicaId: headerSessionId,
          effectId,
        });
      } catch {
        reply.removeHeader('RateLimit-Policy');
        throw new SyncEffectPageHttpError('service_unavailable');
      }
      if (effectOutcome.kind === 'failed') {
        reply.removeHeader('RateLimit-Policy');
        throw new SyncEffectPageHttpError('service_unavailable');
      }
      if (effectOutcome.kind === 'denied') {
        const retryAfterSeconds = effectOutcome.decision.retryAfterSeconds;
        reply.header('Retry-After', String(retryAfterSeconds));
        throw new SyncEffectPageHttpError('rate_limited', retryAfterSeconds);
      }
      const page = await dependencies.reader.read({
        credential, sessionId: headerSessionId, origin, effectId, pageNumber,
        ...(legacyQuery === undefined ? {} : {
          collectionId: legacyQuery.collectionId, replicaId: legacyQuery.replicaId,
        }),
      });
      const bytes = Buffer.byteLength(JSON.stringify(page), 'utf8');
      if (bytes > dependencies.responseBudgetBytes || page.members.length > 512) {
        throw new SyncEffectPageHttpError('payload_too_large');
      }
      return reply.code(200).header('Cache-Control', 'private, no-store')
        .type('application/json').send(page);
    } catch (error) {
      return sendProblem(reply, normalizeError(error));
    }
  });
}

function normalizeError(error: unknown): SyncEffectPageHttpError {
  if (error instanceof SyncEffectPageHttpError) return error;
  if (error instanceof SyncEffectPageReadError) {
    if (error.code === 'not_found') return new SyncEffectPageHttpError('resource_not_found');
    if (error.code === 'payload_too_large') return new SyncEffectPageHttpError('payload_too_large');
    if (error.code === 'integrity_failure') return new SyncEffectPageHttpError('internal_error');
  }
  return new SyncEffectPageHttpError('internal_error');
}

function sendProblem(reply: FastifyReply, error: SyncEffectPageHttpError) {
  const descriptor = createPublicationProblemDescriptor({
    code: error.code,
    ...(error.retryAfterSeconds === undefined
      ? {} : { recovery: { retryAfterSeconds: error.retryAfterSeconds } }),
  });
  if (error.code === 'authentication_required') reply.header('WWW-Authenticate', 'Bearer');
  return reply.code(descriptor.status).header('Cache-Control', 'private, no-store')
    .type(descriptor.headers['content-type']).send(descriptor.problem);
}

function parseLegacyIdentityQuery(query: Record<string, unknown>): {
  readonly collectionId: string;
  readonly replicaId: string;
  readonly sessionId: string;
} | undefined {
  const keys = Object.keys(query);
  if (keys.length === 0) return undefined;
  if (keys.sort().join(',') !== 'collectionId,replicaId,sessionId') {
    throw new SyncEffectPageHttpError('resource_not_found');
  }
  return {
    collectionId: opaque(query.collectionId),
    replicaId: opaque(query.replicaId),
    sessionId: opaque(query.sessionId),
  };
}

function opaque(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._~-]{1,128}$/u.test(value)) {
    throw new SyncEffectPageHttpError('resource_not_found');
  }
  return value;
}

function collectRawHeaders(raw: readonly string[]): Map<string, string[]> {
  const fields = new Map<string, string[]>();
  for (let index = 0; index < raw.length; index += 2) {
    const name = raw[index]!.toLowerCase(); fields.set(name, [...(fields.get(name) ?? []), raw[index + 1] ?? '']);
  }
  return fields;
}

function exactlyOne(fields: ReadonlyMap<string, readonly string[]>, name: string, missing: ProblemCode): string {
  const values = fields.get(name) ?? []; const value = values[0] ?? '';
  if (values.length === 0) throw new SyncEffectPageHttpError(missing);
  if (values.length !== 1 || value.includes(',') || !/^[\x20-\x7e]+$/u.test(value) || value.trim() !== value) {
    throw new SyncEffectPageHttpError('invalid_query');
  }
  return value;
}
