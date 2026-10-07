import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ProblemCode } from '@know-n/colp/server';
import { createPublicationProblemDescriptor, parseIJson } from '@know-n/colp/server';
import { createValidatorRegistry, getLevelOneUriTemplateVariables } from '@know-n/colp/schema';
import { endpointContracts, validateEndpointVariables } from '@know-n/colp/semantic';
import type { ConflictResolutionRequest } from '@know-n/colp/types';
import type { ExtensionCredentialEvidencePort } from '../../modules/identity/index.js';
import {
  SyncConflictResolutionError,
  type SyncConflictResolutionApplication,
  type SyncConflictResolutionInput,
} from '../../modules/sync/index.js';
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

export interface SyncConflictRouteDependencies {
  readonly pathTemplate: string;
  readonly credentialVerifier: ExtensionCredentialEvidencePort;
  readonly application: SyncConflictResolutionApplication;
  readonly allowedOrigins: readonly string[];
  readonly rateLimit: { readonly maxRequests: number; readonly windowMs: number };
  readonly admission?: SyncAdmissionPolicy;
  readonly bodyLimitBytes?: number;
  readonly maxJsonDepth?: number;
  readonly maxJsonMembers?: number;
  readonly now?: () => number;
  readonly allowInsecureLoopback?: boolean;
  /** Explicit TRUSTED_INGRESS allowlist (FIX-M-008): forwarded TLS evidence is accepted only from allowlisted socket peers. */
  readonly trustedIngress?: readonly string[];
}

interface Admission {
  readonly credential: SyncConflictResolutionInput['credential'];
  readonly idempotencyKey: string;
  readonly ifMatch: string;
}

const validators = createValidatorRegistry();

export function registerSyncConflictRoutes(
  app: FastifyInstance,
  dependencies: SyncConflictRouteDependencies,
): void {
  const routePath = assertDependencies(dependencies);
  const contract = endpointContracts.syncConflict.operations[0];
  if (contract?.method !== 'POST' || contract.request !== 'conflictResolutionRequest'
      || contract.response !== 'conflictResolutionResult' || !contract.successStatuses.includes(200)
      || !contract.requiredRequestHeaders?.includes('If-Match')
      || !contract.requiredRequestHeaders?.includes('Idempotency-Key')) {
    throw new TypeError('Public COLP syncConflict endpoint contract is incompatible');
  }
  const admission = resolveSyncAdmissionPolicy(
    dependencies.admission,
    'conflict',
    dependencies.rateLimit,
    dependencies.now,
  );
  const transportSecurity = createSyncTransportSecurity({
    allowInsecureLoopback: dependencies.allowInsecureLoopback === true,
    ...(dependencies.trustedIngress === undefined ? {} : { trustedIngress: dependencies.trustedIngress }),
  });
  app.register((syncApp, _options, done) => {
    const admissions = new WeakMap<FastifyRequest, Admission>();
    syncApp.removeAllContentTypeParsers();
    syncApp.addContentTypeParser('*', {
      parseAs: 'buffer', bodyLimit: dependencies.bodyLimitBytes ?? 131_072,
    }, (_request, body, complete) => complete(null, body));
    syncApp.addHook('onRequest', async (request, reply) => {
      const fields = collectRawHeaders(request.raw.rawHeaders);
      const authorization = requireColpAuthorization(fields, (code) => new SyncConflictResolutionError(code));
      const idempotencyKey = exactlyOne(fields, 'idempotency-key', 'invalid_json');
      const origin = exactlyOne(fields, 'origin', 'origin_not_allowed');
      const contentType = exactlyOne(fields, 'content-type', 'unsupported_media_type');
      const ifMatch = exactlyOne(fields, 'if-match', 'precondition_required');
      if (!dependencies.allowedOrigins.includes(origin)) throw new SyncConflictResolutionError('origin_not_allowed');
      if (!transportSecurity.isSecure(request)) throw new SyncConflictResolutionError('authentication_required');
      if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(contentType)) {
        throw new SyncConflictResolutionError('unsupported_media_type');
      }
      if (!/^[A-Za-z0-9._~-]{1,256}$/u.test(idempotencyKey)
          || !/^"[A-Za-z0-9._~-]{1,128}"$/u.test(ifMatch)) {
        throw new SyncConflictResolutionError('invalid_json');
      }
      reply.header('RateLimit-Policy', syncAdmissionPolicyHeader('conflict', dependencies.rateLimit));
      const outcome = await admission.admitPreAuth({
        purpose: 'conflict',
        clientKey: rateLimitClientKey(request, dependencies.pathTemplate),
      });
      if (outcome.kind === 'denied') {
        reply.header('Retry-After', String(outcome.retryAfterSeconds));
        throw new SyncConflictResolutionError('rate_limited');
      }
      if (outcome.kind === 'failed') {
        throw new SyncConflictResolutionError('service_unavailable');
      }
      let credential: SyncConflictResolutionInput['credential'];
      try {
        credential = await dependencies.credentialVerifier.verify({ authorization });
      } catch {
        throw new SyncConflictResolutionError('authentication_required');
      }
      const identity = exactIdentityQuery(request.query);
      const subjectOutcome = await admission.admitSubject({
        purpose: 'conflict',
        subjectKey: syncAdmissionSubjectKey({ credential, replicaId: identity.replicaId, sessionId: identity.sessionId }),
      });
      if (subjectOutcome.kind === 'denied') {
        reply.header('Retry-After', String(subjectOutcome.retryAfterSeconds));
        throw new SyncConflictResolutionError('rate_limited');
      }
      if (subjectOutcome.kind === 'failed') throw new SyncConflictResolutionError('service_unavailable');
      admissions.set(request, Object.freeze({ credential, idempotencyKey, ifMatch }));
    });
    syncApp.setErrorHandler((error, _request, reply) => sendProblem(reply,
      (error as { readonly code?: unknown }).code === 'FST_ERR_CTP_BODY_TOO_LARGE'
        ? new SyncConflictResolutionError('payload_too_large') : normalizeError(error)));
    syncApp.post(routePath, async (request, reply) => {
      try {
        const admission = admissions.get(request);
        if (!admission) throw new SyncConflictResolutionError('internal_error');
        const params = request.params as { readonly conflictId?: unknown };
        if (typeof params.conflictId !== 'string') throw new SyncConflictResolutionError('invalid_document');
        const identity = validateEndpointVariables('syncConflict', { conflictId: params.conflictId }, validators);
        if (!identity.valid) throw new SyncConflictResolutionError('invalid_document');
        const conflictId = identity.value.conflictId;
        if (typeof conflictId !== 'string') throw new SyncConflictResolutionError('internal_error');
        const query = exactIdentityQuery(request.query);
        let document: unknown;
        try {
          if (!Buffer.isBuffer(request.body)) throw new TypeError('Sync Conflict body is not buffered');
          document = parseIJson(new TextDecoder('utf-8', { fatal: true }).decode(request.body), {
            maxDepth: dependencies.maxJsonDepth ?? 64,
            maxMembers: dependencies.maxJsonMembers ?? 20_000,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : '';
          throw new SyncConflictResolutionError(/limit|depth|budget/iu.test(message)
            ? 'payload_too_large' : 'invalid_json');
        }
        if (!validators.validate('conflictResolutionRequest', document).valid) {
          throw new SyncConflictResolutionError('invalid_document');
        }
        const result = await dependencies.application.resolve({
          credential: admission.credential,
          conflictId,
          sessionId: query.sessionId,
          replicaId: query.replicaId,
          collectionId: query.collectionId,
          idempotencyKey: admission.idempotencyKey,
          ifMatch: [admission.ifMatch],
          request: document as ConflictResolutionRequest,
        });
        if (!validators.validate('conflictResolutionResult', result).valid
            || result.conflict.id !== conflictId || result.conflict.status !== 'resolved') {
          throw new SyncConflictResolutionError('internal_error');
        }
        return reply.code(200).header('Cache-Control', 'private, no-store')
          .header('ETag', `"${result.conflict.revision}"`).type('application/json').send(result);
      } catch (error) {
        return sendProblem(reply, normalizeError(error));
      }
    });
    done();
  });
}

function assertDependencies(dependencies: SyncConflictRouteDependencies): string {
  const variables = getLevelOneUriTemplateVariables(`https://sync-route.invalid${dependencies.pathTemplate}`);
  if (variables?.length !== 1 || variables[0] !== 'conflictId'
      || !/^\/[A-Za-z0-9._~!$&'()*+,;=:@%/{\}-]+$/u.test(dependencies.pathTemplate)) {
    throw new TypeError('syncConflict path must contain exactly the {conflictId} URI Template variable');
  }
  const routePath = dependencies.pathTemplate.replace('{conflictId}', ':conflictId');
  if (routePath.includes('{') || routePath.includes('}')) throw new TypeError('syncConflict path template is invalid');
  if (dependencies.allowedOrigins.length < 1
      || dependencies.allowedOrigins.some((origin) => !/^chrome-extension:\/\/[a-p]{32}$/u.test(origin))) {
    throw new TypeError('Sync Conflict origins must be exact Chromium extension origins');
  }
  for (const value of [dependencies.rateLimit.maxRequests, dependencies.rateLimit.windowMs]) {
    if (!Number.isSafeInteger(value) || value < 1) throw new TypeError('Sync Conflict rate limits must be positive integers');
  }
  return routePath;
}

function exactIdentityQuery(value: unknown): { sessionId: string; replicaId: string; collectionId: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SyncConflictResolutionError('invalid_json');
  const query = value as Record<string, unknown>;
  if (Object.keys(query).sort().join('\0') !== 'collectionId\0replicaId\0sessionId') {
    throw new SyncConflictResolutionError('invalid_json');
  }
  const { sessionId, replicaId, collectionId } = query;
  if (typeof sessionId !== 'string' || typeof replicaId !== 'string' || typeof collectionId !== 'string'
      || !validators.validate('opaqueId', sessionId).valid
      || !validators.validate('opaqueId', replicaId).valid
      || !validators.validate('opaqueId', collectionId).valid) {
    throw new SyncConflictResolutionError('invalid_document');
  }
  return { sessionId, replicaId, collectionId };
}

function collectRawHeaders(raw: readonly string[]): Map<string, string[]> {
  const fields = new Map<string, string[]>();
  for (let index = 0; index < raw.length; index += 2) {
    const name = raw[index]!.toLowerCase();
    fields.set(name, [...(fields.get(name) ?? []), raw[index + 1] ?? '']);
  }
  return fields;
}

function exactlyOne(fields: ReadonlyMap<string, readonly string[]>, name: string, missing: ProblemCode): string {
  const values = fields.get(name) ?? [];
  if (values.length === 0) throw new SyncConflictResolutionError(missing);
  const value = values[0]!;
  if (values.length !== 1 || value.includes(',') || !/^[\x20-\x7e]+$/u.test(value)
      || value.trim() !== value) throw new SyncConflictResolutionError('invalid_json');
  return value;
}

function normalizeError(error: unknown): SyncConflictResolutionError {
  if (error instanceof SyncConflictResolutionError) return error;
  if (error instanceof DatabaseOperationError
      && (error.kind === 'commit_outcome_unknown' || error.retryableAtCommandBoundary)) {
    return new SyncConflictResolutionError('service_unavailable');
  }
  return new SyncConflictResolutionError('internal_error');
}

function sendProblem(reply: FastifyReply, error: SyncConflictResolutionError) {
  const descriptor = createPublicationProblemDescriptor({
    code: error.code,
    ...(error.currentRevision === undefined ? {} : { recovery: { currentRevision: error.currentRevision } }),
  });
  if (error.code === 'authentication_required') reply.header('WWW-Authenticate', 'Bearer');
  if (error.code === 'precondition_failed' && error.currentRevision) {
    reply.header('ETag', `"${error.currentRevision}"`);
  }
  return reply.code(descriptor.status).header('Cache-Control', 'private, no-store')
    .type(descriptor.headers['content-type']).send(descriptor.problem);
}
