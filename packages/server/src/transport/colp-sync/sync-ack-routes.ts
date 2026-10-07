import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ProblemCode } from '@know-n/colp/server';
import { createValidatorRegistry } from '@know-n/colp/schema';
import { endpointContracts } from '@know-n/colp/semantic';
import { createPublicationProblemDescriptor, parseIJson } from '@know-n/colp/server';
import type { SyncAckRequest } from '@know-n/colp/types';
import type { ExtensionCredentialEvidencePort, VerifiedExtensionCredential } from '../../modules/identity/index.js';
import { SyncAckError, type SyncAckApplication } from '../../modules/sync/index.js';
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

export interface SyncAckRouteDependencies {
  readonly path: string;
  readonly credentialVerifier: ExtensionCredentialEvidencePort;
  readonly application: SyncAckApplication;
  readonly allowedOrigins: readonly string[];
  readonly rateLimit: { readonly maxRequests: number; readonly windowMs: number };
  readonly admission?: SyncAdmissionPolicy;
  readonly maxBodyBytes: number;
  readonly maxWarnings: number;
  readonly maxWarningBytes: number;
  readonly allowInsecureLoopback?: boolean;
  /** Explicit TRUSTED_INGRESS allowlist (FIX-M-008): forwarded TLS evidence is accepted only from allowlisted socket peers. */
  readonly trustedIngress?: readonly string[];
}

class SyncAckHttpError extends Error {
  constructor(readonly code: ProblemCode, readonly authorityGuard?: string) {
    super(`Sync Ack denied: ${code}`); this.name = 'SyncAckHttpError';
  }
}
interface Admission { readonly credential: VerifiedExtensionCredential; readonly idempotencyKey: string;
  readonly origin: string; readonly sessionId?: string; readonly mediaType: 'application/json' }
const validators = createValidatorRegistry();

export function registerSyncAckRoutes(app: FastifyInstance, dependencies: SyncAckRouteDependencies): void {
  assertDependencies(dependencies);
  const contract = endpointContracts.syncAck.operations[0];
  if (contract?.method !== 'POST' || contract.request !== 'syncAckRequest'
      || contract.response !== 'syncAckResult' || !contract.successStatuses.includes(200)
      || !contract.requiredRequestHeaders?.includes('Idempotency-Key')) {
    throw new TypeError('Public COLP syncAck endpoint contract is incompatible');
  }
  const admissionPolicy = resolveSyncAdmissionPolicy(
    dependencies.admission,
    'ack',
    dependencies.rateLimit,
  );
  const transportSecurity = createSyncTransportSecurity({
    allowInsecureLoopback: dependencies.allowInsecureLoopback === true,
    ...(dependencies.trustedIngress === undefined ? {} : { trustedIngress: dependencies.trustedIngress }),
  });
  app.register((syncApp, _options, done) => {
    const admissions = new WeakMap<FastifyRequest, Admission>();
    syncApp.removeAllContentTypeParsers();
    syncApp.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: dependencies.maxBodyBytes },
      (_request, body, complete) => complete(null, body));
    syncApp.addHook('onRequest', async (request, reply) => {
      const fields = collectRawHeaders(request.raw.rawHeaders);
      const authorization = requireColpAuthorization(fields, (code) => new SyncAckHttpError(code));
      const origin = exactlyOne(fields, 'origin', 'origin_not_allowed');
      const contentType = exactlyOne(fields, 'content-type', 'unsupported_media_type');
      const idempotencyKey = exactlyOne(fields, 'idempotency-key', 'invalid_json');
      const sessionId = optionalOne(fields, 'known-sync-session');
      if (!dependencies.allowedOrigins.includes(origin)) throw new SyncAckHttpError('origin_not_allowed');
      if (!transportSecurity.isSecure(request)) throw new SyncAckHttpError('authentication_required');
      if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(contentType)) {
        throw new SyncAckHttpError('unsupported_media_type');
      }
      if (!/^[A-Za-z0-9._~-]{1,512}$/u.test(idempotencyKey)) throw new SyncAckHttpError('invalid_json');
      if ((request.raw.url ?? '') !== dependencies.path) throw new SyncAckHttpError('invalid_query');
      reply.header('RateLimit-Policy', syncAdmissionPolicyHeader('ack', dependencies.rateLimit));
      const outcome = await admissionPolicy.admitPreAuth({
        purpose: 'ack',
        clientKey: rateLimitClientKey(request, dependencies.path),
      });
      if (outcome.kind === 'denied') {
        reply.header('Retry-After', String(outcome.retryAfterSeconds));
        throw new SyncAckHttpError('rate_limited');
      }
      if (outcome.kind === 'failed') {
        throw new SyncAckHttpError('service_unavailable');
      }
      let credential: VerifiedExtensionCredential;
      try { credential = await dependencies.credentialVerifier.verify({ authorization }); }
      catch { throw new SyncAckHttpError('authentication_required'); }
      admissions.set(request, Object.freeze({ credential, idempotencyKey, origin,
        ...(sessionId ? { sessionId } : {}), mediaType: 'application/json' as const }));
    });
    syncApp.setErrorHandler((error, _request, reply) => sendProblem(reply,
      (error as { readonly code?: unknown }).code === 'FST_ERR_CTP_BODY_TOO_LARGE'
        ? new SyncAckHttpError('payload_too_large') : normalizeError(error)));
    syncApp.post(dependencies.path, async (request, reply) => {
      try {
        const admission = admissions.get(request); if (!admission) throw new SyncAckHttpError('internal_error');
        let document: unknown;
        try {
          if (!Buffer.isBuffer(request.body)) throw new TypeError('Sync Ack body is not buffered');
          document = parseIJson(new TextDecoder('utf-8', { fatal: true }).decode(request.body),
            { maxDepth: 8, maxMembers: 128 });
        } catch (error) {
          const message = error instanceof Error ? error.message : '';
          throw new SyncAckHttpError(/limit|depth|budget/iu.test(message) ? 'payload_too_large' : 'invalid_json');
        }
        if (!validators.validate('syncAckRequest', document).valid) throw new SyncAckHttpError('invalid_document');
        const ack = document as SyncAckRequest;
        if (admission.sessionId !== undefined && ack.sessionId !== admission.sessionId) {
          throw new SyncAckHttpError('invalid_cursor_scope');
        }
        const subjectOutcome = await admissionPolicy.admitSubject({
          purpose: 'ack',
          subjectKey: syncAdmissionSubjectKey({ credential: admission.credential, sessionId: ack.sessionId }),
        });
        if (subjectOutcome.kind === 'denied') {
          reply.header('Retry-After', String(subjectOutcome.retryAfterSeconds));
          throw new SyncAckHttpError('rate_limited');
        }
        if (subjectOutcome.kind === 'failed') throw new SyncAckHttpError('service_unavailable');
        if (!warningsWithinBudget(ack, dependencies.maxWarnings, dependencies.maxWarningBytes)) {
          throw new SyncAckHttpError('invalid_document');
        }
        const result = await dependencies.application.acknowledge({ credential: admission.credential,
          idempotencyKey: admission.idempotencyKey,
          requestFingerprint: createHash('sha256').update(canonicalJson(document), 'utf8').digest('base64url'),
          origin: admission.origin, mediaType: admission.mediaType,
          endpointIdentity: dependencies.path, request: ack });
        if (!validators.validate('syncAckResult', result).valid || result.ackedCursor !== ack.cursor) {
          throw new SyncAckHttpError('internal_error');
        }
        return reply.code(200).header('Cache-Control', 'private, no-store').type('application/json').send(result);
      } catch (error) {
        const normalized = normalizeError(error);
        request.log.debug({ event: 'sync_ack_denied', problem: normalized.code,
          authorityGuard: normalized.authorityGuard ?? 'unspecified' }, 'sync Ack request denied');
        return sendProblem(reply, normalized);
      }
    });
    done();
  });
}

function warningsWithinBudget(request: SyncAckRequest, maxWarnings: number, maxBytes: number): boolean {
  if (request.warnings.length > maxWarnings || Buffer.byteLength(JSON.stringify(request.warnings), 'utf8') > maxBytes) return false;
  return request.warnings.every((warning) => warning.code.length <= 64 && warning.message.length <= 256
    && !/(?:https?:\/\/|javascript:|chrome:|authorization|bearer|token=|secret|native[_ -]?id)/iu.test(warning.message)
    && (warning.path === undefined || (/^\/(?:[A-Za-z0-9._~-]+\/?)*$/u.test(warning.path) && warning.path.length <= 256)));
}
function assertDependencies(dependencies: SyncAckRouteDependencies): void {
  if (!dependencies || !/^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]+$/u.test(dependencies.path)) {
    throw new TypeError('syncAck path must be static');
  }
  if (dependencies.allowedOrigins.length < 1
      || dependencies.allowedOrigins.some((origin) => !/^chrome-extension:\/\/[a-p]{32}$/u.test(origin))) {
    throw new TypeError('Sync Ack origins must be exact Chromium extension origins');
  }
  for (const value of [dependencies.rateLimit.maxRequests, dependencies.rateLimit.windowMs,
    dependencies.maxBodyBytes, dependencies.maxWarnings, dependencies.maxWarningBytes]) {
    if (!Number.isSafeInteger(value) || value < 1) throw new TypeError('Sync Ack budgets must be positive integers');
  }
}
function collectRawHeaders(raw: readonly string[]) { const fields = new Map<string, string[]>();
  for (let index = 0; index < raw.length; index += 2) { const name = raw[index]!.toLowerCase();
    fields.set(name, [...(fields.get(name) ?? []), raw[index + 1] ?? '']); } return fields; }
function exactlyOne(fields: ReadonlyMap<string, readonly string[]>, name: string, missing: ProblemCode) {
  const values = fields.get(name) ?? []; if (values.length === 0) throw new SyncAckHttpError(missing);
  const value = values[0]!; if (values.length !== 1 || value.includes(',') || !/^[\x20-\x7e]+$/u.test(value)
      || value.trim() !== value) throw new SyncAckHttpError('invalid_json'); return value; }
function optionalOne(fields: ReadonlyMap<string, readonly string[]>, name: string): string | undefined {
  const values = fields.get(name); if (!values) return undefined;
  const value = values[0] ?? ''; if (values.length !== 1 || value.includes(',')
      || !/^[\x20-\x7e]+$/u.test(value) || value.trim() !== value) {
    throw new SyncAckHttpError('invalid_json');
  }
  return value;
}
function normalizeError(error: unknown): SyncAckHttpError { if (error instanceof SyncAckHttpError) return error;
  if (error instanceof SyncAckError) {
    const authorityGuard = 'authorityGuard' in error && typeof error.authorityGuard === 'string'
      ? error.authorityGuard : undefined;
    return new SyncAckHttpError(error.code, authorityGuard);
  }
  if (error instanceof DatabaseOperationError && error.retryableAtCommandBoundary) return new SyncAckHttpError('service_unavailable');
  return new SyncAckHttpError('internal_error'); }
function sendProblem(reply: FastifyReply, error: SyncAckHttpError) { const descriptor = createPublicationProblemDescriptor({ code: error.code });
  if (error.code === 'authentication_required') reply.header('WWW-Authenticate', 'Bearer');
  return reply.code(descriptor.status).header('Cache-Control', 'private, no-store')
    .type(descriptor.headers['content-type']).send(descriptor.problem); }
function canonicalJson(value: unknown): string { if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  const encoded = JSON.stringify(value); if (encoded === undefined) throw new SyncAckHttpError('invalid_document'); return encoded; }
