import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ProblemCode } from '@know-n/colp/server';
import { createPublicationProblemDescriptor } from '@know-n/colp/server';
import type { ExtensionCredentialEvidencePort, VerifiedExtensionCredential } from '../../modules/identity/index.js';
import { SyncRetireError, type SyncRetireApplication } from '../../modules/sync/index.js';
import { DatabaseOperationError } from '../../infrastructure/database/errors.js';
import {
  resolveSyncAdmissionPolicy,
  syncAdmissionPolicyHeader,
  syncAdmissionSubjectKey,
  type SyncAdmissionPolicy,
} from '../../infrastructure/rate-limit/index.js';
import { rateLimitClientKey } from '../http-security.js';
import { requireColpAuthorization } from './sync-colp-authorization.js';
import { createSyncTransportSecurity } from './sync-transport-security.js';

export interface SyncRetireRouteDependencies {
  readonly path: string;
  readonly credentialVerifier: ExtensionCredentialEvidencePort;
  readonly application: SyncRetireApplication;
  readonly allowedOrigins: readonly string[];
  readonly rateLimit: { readonly maxRequests: number; readonly windowMs: number };
  readonly admission?: SyncAdmissionPolicy;
  readonly allowInsecureLoopback?: boolean;
  /** Explicit TRUSTED_INGRESS allowlist (FIX-M-008): forwarded TLS evidence is accepted only from allowlisted socket peers. */
  readonly trustedIngress?: readonly string[];
}

class SyncRetireHttpError extends Error {
  constructor(readonly code: ProblemCode) {
    super(`Sync Replica retirement denied: ${code}`);
    this.name = 'SyncRetireHttpError';
  }
}

interface Admission {
  readonly credential: VerifiedExtensionCredential;
  readonly idempotencyKey: string;
  readonly sessionId: string;
  readonly origin: string;
}

export function registerSyncRetireRoutes(
  app: FastifyInstance,
  dependencies: SyncRetireRouteDependencies,
): void {
  assertDependencies(dependencies);
  const admission = resolveSyncAdmissionPolicy(
    dependencies.admission,
    'retire',
    dependencies.rateLimit,
  );
  const transportSecurity = createSyncTransportSecurity({
    allowInsecureLoopback: dependencies.allowInsecureLoopback === true,
    ...(dependencies.trustedIngress === undefined ? {} : { trustedIngress: dependencies.trustedIngress }),
  });
  app.register((syncApp, _options, done) => {
    const admissions = new WeakMap<FastifyRequest, Admission>();
    syncApp.addHook('onRequest', async (request, reply) => {
      const fields = collectRawHeaders(request.raw.rawHeaders);
      const authorization = requireColpAuthorization(fields, (code) => new SyncRetireHttpError(code));
      if (!transportSecurity.isSecure(request)) throw new SyncRetireHttpError('authentication_required');
      const origin = exactlyOne(fields, 'origin', 'origin_not_allowed');
      const sessionId = exactlyOne(fields, 'known-sync-session', 'invalid_json');
      const idempotencyKey = exactlyOne(fields, 'idempotency-key', 'invalid_json');
      if (!dependencies.allowedOrigins.includes(origin)) throw new SyncRetireHttpError('origin_not_allowed');
      if (!TOKEN.test(sessionId) || !TOKEN.test(idempotencyKey)) throw new SyncRetireHttpError('invalid_json');
      if (fields.has('content-type') || fields.has('transfer-encoding')
          || (fields.get('content-length')?.some((value) => value !== '0') ?? false)) {
        throw new SyncRetireHttpError('unsupported_media_type');
      }
      if ((request.raw.url ?? '') !== dependencies.path) throw new SyncRetireHttpError('invalid_query');
      reply.header('RateLimit-Policy', syncAdmissionPolicyHeader('retire', dependencies.rateLimit));
      const outcome = await admission.admitPreAuth({
        purpose: 'retire',
        clientKey: rateLimitClientKey(request, dependencies.path),
      });
      if (outcome.kind === 'denied') {
        reply.header('Retry-After', String(outcome.retryAfterSeconds));
        throw new SyncRetireHttpError('rate_limited');
      }
      if (outcome.kind === 'failed') {
        throw new SyncRetireHttpError('service_unavailable');
      }
      let credential: VerifiedExtensionCredential;
      try { credential = await dependencies.credentialVerifier.verify({ authorization }); }
      catch { throw new SyncRetireHttpError('authentication_required'); }
      const subjectOutcome = await admission.admitSubject({
        purpose: 'retire',
        subjectKey: syncAdmissionSubjectKey({ credential, sessionId }),
      });
      if (subjectOutcome.kind === 'denied') {
        reply.header('Retry-After', String(subjectOutcome.retryAfterSeconds));
        throw new SyncRetireHttpError('rate_limited');
      }
      if (subjectOutcome.kind === 'failed') throw new SyncRetireHttpError('service_unavailable');
      admissions.set(request, Object.freeze({ credential, idempotencyKey, sessionId, origin }));
    });
    syncApp.setErrorHandler((error, _request, reply) => sendProblem(reply, normalizeError(error)));
    syncApp.delete(dependencies.path, async (request, reply) => {
      try {
        const admission = admissions.get(request);
        if (!admission) throw new SyncRetireHttpError('internal_error');
        await dependencies.application.retireExtension({
          credential: admission.credential,
          sessionId: admission.sessionId,
          origin: admission.origin,
          idempotencyKey: admission.idempotencyKey,
          requestFingerprint: createHash('sha256').update([
            'DELETE', dependencies.path, admission.origin, admission.sessionId,
          ].join('\n'), 'utf8').digest('hex'),
        });
        return reply.code(204).header('Cache-Control', 'private, no-store').send();
      } catch (error) {
        return sendProblem(reply, normalizeError(error));
      }
    });
    done();
  });
}

const TOKEN = /^[A-Za-z0-9._~-]{1,512}$/u;

function assertDependencies(dependencies: SyncRetireRouteDependencies): void {
  if (!dependencies || !/^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]+$/u.test(dependencies.path)) {
    throw new TypeError('Sync retire path must be static');
  }
  if (dependencies.allowedOrigins.length < 1
      || dependencies.allowedOrigins.some((origin) => !/^chrome-extension:\/\/[a-p]{32}$/u.test(origin))) {
    throw new TypeError('Sync retire origins must be exact Chromium extension origins');
  }
  for (const value of [dependencies.rateLimit.maxRequests, dependencies.rateLimit.windowMs]) {
    if (!Number.isSafeInteger(value) || value < 1) throw new TypeError('Sync retire budgets must be positive integers');
  }
}

function collectRawHeaders(raw: readonly string[]) {
  const fields = new Map<string, string[]>();
  for (let index = 0; index < raw.length; index += 2) {
    const name = raw[index]!.toLowerCase();
    fields.set(name, [...(fields.get(name) ?? []), raw[index + 1] ?? '']);
  }
  return fields;
}

function exactlyOne(
  fields: ReadonlyMap<string, readonly string[]>,
  name: string,
  missing: ProblemCode,
): string {
  const values = fields.get(name) ?? [];
  if (values.length === 0) throw new SyncRetireHttpError(missing);
  const value = values[0]!;
  if (values.length !== 1 || value.includes(',') || !/^[\x20-\x7e]+$/u.test(value)
      || value.trim() !== value) throw new SyncRetireHttpError('invalid_json');
  return value;
}

function normalizeError(error: unknown): SyncRetireHttpError {
  if (error instanceof SyncRetireHttpError) return error;
  if (error instanceof SyncRetireError) return new SyncRetireHttpError(error.code);
  if (error instanceof DatabaseOperationError && error.retryableAtCommandBoundary) {
    return new SyncRetireHttpError('service_unavailable');
  }
  return new SyncRetireHttpError('internal_error');
}

function sendProblem(reply: FastifyReply, error: SyncRetireHttpError) {
  const descriptor = createPublicationProblemDescriptor({ code: error.code });
  if (error.code === 'authentication_required') reply.header('WWW-Authenticate', 'Bearer');
  return reply.code(descriptor.status).header('Cache-Control', 'private, no-store')
    .type(descriptor.headers['content-type']).send(descriptor.problem);
}
