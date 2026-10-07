import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ProblemCode } from '@know-n/colp/server';
import { createPublicationProblemDescriptor, parseIJson } from '@know-n/colp/server';
import { createValidatorRegistry } from '@know-n/colp/schema';
import {
  encodeSyncTransportBudgetHeader,
  legacySyncTransportBudget,
  SYNC_TRANSPORT_BUDGET_HEADER,
} from '@know-n/colp/sync';
import { endpointContracts } from '@know-n/colp/semantic';
import type {
  SyncSessionRequest, SyncSessionRequestV02, SyncSessionResult, SyncSessionResultV02,
} from '@know-n/colp/types';
import type {
  ExtensionCredentialEvidencePort,
} from '../../modules/identity/index.js';
import {
  SyncSessionHttpError,
  type SyncSessionHttpApplication,
  type SyncSessionHttpApplicationInput,
} from '../../modules/sync/index.js';
import {
  resolveSyncAdmissionPolicy,
  syncAdmissionPolicyHeader,
  syncAdmissionSubjectKey,
  type SyncAdmissionPolicy,
} from '../../infrastructure/rate-limit/index.js';
import { rateLimitClientKey } from '../http-security.js';
import { ProductHttpError } from '../product-error.js';
import { requireColpAuthorization } from './sync-colp-authorization.js';
import { createSyncTransportSecurity } from './sync-transport-security.js';

export { SyncSessionHttpError } from '../../modules/sync/index.js';
export type {
  SyncSessionHttpApplication,
  SyncSessionHttpApplicationInput,
} from '../../modules/sync/index.js';

export interface SyncSessionRouteDependencies {
  readonly path: string;
  readonly credentialVerifier: ExtensionCredentialEvidencePort;
  readonly application: SyncSessionHttpApplication;
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

interface SyncSessionAdmission {
  readonly authorization: string;
  readonly idempotencyKey: string;
  readonly origin: string;
}

export function registerSyncSessionRoutes(
  app: FastifyInstance,
  dependencies: SyncSessionRouteDependencies,
): void {
  assertDependencies(dependencies);
  const contract = endpointContracts.syncSessions.operations[0];
  if (contract?.method !== 'POST' || contract.request !== 'syncSessionRequest'
      || contract.response !== 'syncSessionResult' || !contract.successStatuses.includes(201)
      || !contract.requiredRequestHeaders?.includes('Idempotency-Key')) {
    throw new TypeError('Public COLP syncSessions endpoint contract is incompatible');
  }
  const policy = resolveSyncAdmissionPolicy(
    dependencies.admission,
    'session',
    dependencies.rateLimit,
    dependencies.now,
  );
  const transportSecurity = createSyncTransportSecurity({
    allowInsecureLoopback: dependencies.allowInsecureLoopback === true,
    ...(dependencies.trustedIngress === undefined ? {} : { trustedIngress: dependencies.trustedIngress }),
  });
  app.register((syncApp, _options, done) => {
    const admissions = new WeakMap<FastifyRequest, SyncSessionAdmission>();
    syncApp.removeAllContentTypeParsers();
    syncApp.addContentTypeParser(
      '*',
      { parseAs: 'string', bodyLimit: dependencies.bodyLimitBytes ?? 131_072 },
      (_request, body, complete) => complete(null, body),
    );
    syncApp.addHook('onRequest', async (request, reply) => {
      const fields = collectRawHeaders(request.raw.rawHeaders);
      const authorization = requireColpAuthorization(fields, (code) => new SyncSessionHttpError(code));
      const idempotencyKey = exactlyOne(fields, 'idempotency-key', 'invalid_json');
      const origin = exactlyOne(fields, 'origin', 'origin_not_allowed');
      exactlyOne(fields, 'content-type', 'unsupported_media_type');
      if (!dependencies.allowedOrigins.includes(origin)) throw new SyncSessionHttpError('origin_not_allowed');
      if (!transportSecurity.isSecure(request)) throw new SyncSessionHttpError('authentication_required');
      const mediaType = fields.get('content-type')![0]!;
      if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(mediaType)) {
        throw new SyncSessionHttpError('unsupported_media_type');
      }
      await admitRateLimit(request, reply, policy, dependencies);
      admissions.set(request, Object.freeze({ authorization, idempotencyKey, origin }));
    });
    syncApp.setErrorHandler((error, _request, reply) => {
      const code = (error as { readonly code?: unknown }).code;
      return sendSyncProblem(reply, code === 'FST_ERR_CTP_BODY_TOO_LARGE'
        ? new SyncSessionHttpError('payload_too_large') : normalizeError(error));
    });
    syncApp.post(dependencies.path, async (request, reply) => {
      try {
        const admission = admissions.get(request);
        if (!admission) throw new SyncSessionHttpError('internal_error');
        let document: unknown;
        try {
          document = parseIJson(typeof request.body === 'string' ? request.body : '', {
            maxDepth: dependencies.maxJsonDepth ?? 64,
            maxMembers: dependencies.maxJsonMembers ?? 20_000,
          });
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : '';
          throw new SyncSessionHttpError(/limit|depth|budget/iu.test(message)
            ? 'payload_too_large' : 'invalid_json');
        }
        const protocolVersion = typeof document === 'object' && document !== null
          ? (document as { readonly protocolVersion?: unknown }).protocolVersion : undefined;
        const requestDefinition = protocolVersion === '0.2' ? 'syncSessionRequestV02' : 'syncSessionRequest';
        const validation = createValidatorRegistry().validate(requestDefinition, document);
        if (!validation.valid) throw new SyncSessionHttpError('invalid_document');
        const validatedRequest = document as SyncSessionRequest | SyncSessionRequestV02;
        let credential: SyncSessionHttpApplicationInput['credential'];
        try {
          credential = await dependencies.credentialVerifier.verify({ authorization: admission.authorization });
        } catch {
          throw new SyncSessionHttpError('authentication_required');
        }
        const subjectOutcome = await policy.admitSubject({
          purpose: 'session',
          subjectKey: syncAdmissionSubjectKey({
            credential,
            replicaId: typeof validatedRequest.replica?.replicaId === 'string'
              ? validatedRequest.replica.replicaId : undefined,
          }),
        });
        if (subjectOutcome.kind === 'denied') {
          throw new SyncSessionHttpError('rate_limited', subjectOutcome.retryAfterSeconds);
        }
        if (subjectOutcome.kind === 'failed') throw new SyncSessionHttpError('service_unavailable');
        const issued = await dependencies.application.issue({
          credential,
          idempotencyKey: admission.idempotencyKey,
          requestFingerprint: createHash('sha256')
            .update(canonicalJson(document), 'utf8').digest('base64url'),
          origin: admission.origin,
          request: validatedRequest,
        });
        const responseDefinition = protocolVersion === '0.2' ? 'syncSessionResultV02' : 'syncSessionResult';
        const responseValidation = createValidatorRegistry().validate(responseDefinition, issued.response);
        if (!responseValidation.valid || !validResponseSemantics(issued.response,
          validatedRequest)) {
          throw new SyncSessionHttpError('internal_error');
        }
        const transportBudget = issued.transportBudget ?? legacySyncTransportBudget();
        return reply.code(201).header('Cache-Control', 'private, no-store')
          .header(SYNC_TRANSPORT_BUDGET_HEADER, encodeSyncTransportBudgetHeader(transportBudget))
          .type('application/json').send(issued.response);
      } catch (error: unknown) {
        return sendSyncProblem(reply, normalizeError(error));
      }
    });
    done();
  });
}

function assertDependencies(dependencies: SyncSessionRouteDependencies): void {
  if (!dependencies.path.startsWith('/') || dependencies.path.includes('{')) {
    throw new TypeError('syncSessions path must be a static absolute path');
  }
  if (dependencies.allowedOrigins.length < 1
      || dependencies.allowedOrigins.some((origin) => !/^chrome-extension:\/\/[a-p]{32}$/u.test(origin))) {
    throw new TypeError('Sync Session origins must be exact Chromium extension origins');
  }
  for (const value of [dependencies.rateLimit.maxRequests, dependencies.rateLimit.windowMs]) {
    if (!Number.isSafeInteger(value) || value < 1) throw new TypeError('Sync Session rate limits must be positive integers');
  }
}

function collectRawHeaders(raw: readonly string[]): Map<string, string[]> {
  const fields = new Map<string, string[]>();
  for (let index = 0; index < raw.length; index += 2) {
    const name = raw[index]!.toLowerCase();
    const values = fields.get(name) ?? [];
    values.push(raw[index + 1]!);
    fields.set(name, values);
  }
  return fields;
}

function exactlyOne(
  fields: ReadonlyMap<string, readonly string[]>,
  name: string,
  missingCode: ProblemCode,
): string {
  const values = fields.get(name) ?? [];
  if (values.length === 0) throw new SyncSessionHttpError(missingCode);
  if (values.length !== 1 || values[0]!.includes(',')
      || !/^[\x20-\x7e]+$/u.test(values[0]!) || values[0]!.trim() !== values[0]!) {
    throw new SyncSessionHttpError('invalid_json');
  }
  return values[0]!;
}

async function admitRateLimit(
  request: FastifyRequest,
  reply: FastifyReply,
  admission: SyncAdmissionPolicy,
  dependencies: SyncSessionRouteDependencies,
): Promise<void> {
  reply.header('RateLimit-Policy', syncAdmissionPolicyHeader('session', dependencies.rateLimit));
  const outcome = await admission.admitPreAuth({
    purpose: 'session',
    clientKey: rateLimitClientKey(request, dependencies.path),
  });
  if (outcome.kind === 'denied') {
    reply.header('Retry-After', String(outcome.retryAfterSeconds));
    throw new SyncSessionHttpError('rate_limited', outcome.retryAfterSeconds);
  }
  if (outcome.kind === 'failed') {
    throw new SyncSessionHttpError('service_unavailable');
  }
}

function normalizeError(error: unknown): SyncSessionHttpError {
  if (error instanceof SyncSessionHttpError) return error;
  // Product admission 400s (duplicate Cookie / session parse-error) must stay
  // 400 on this COLP path; the plugin error handler would otherwise map them
  // to internal_error.
  if (error instanceof ProductHttpError && error.statusCode === 400) {
    return new SyncSessionHttpError('invalid_json');
  }
  return new SyncSessionHttpError('internal_error');
}

function sendSyncProblem(reply: FastifyReply, error: SyncSessionHttpError) {
  const descriptor = createPublicationProblemDescriptor({
    code: error.code,
    ...(error.retryAfterSeconds === undefined
      ? {} : { recovery: { retryAfterSeconds: error.retryAfterSeconds } }),
  });
  if (error.code === 'authentication_required') {
    reply.header('WWW-Authenticate', 'Bearer');
  }
  return reply.code(descriptor.status).header('Cache-Control', 'private, no-store')
    .type(descriptor.headers['content-type']).send(descriptor.problem);
}

function validResponseSemantics(
  response: SyncSessionResult | SyncSessionResultV02,
  request: SyncSessionRequest | SyncSessionRequestV02,
): boolean {
  if (request.scope !== 'collection' || response.scope !== 'collection') return false;
  const clientTime = Date.parse(request.clientTime);
  const serverTime = Date.parse(response.serverTime);
  const expiresAt = Date.parse(response.expiresAt);
  const leaseLastSeen = Date.parse(response.replicaLease.lastSeenAt);
  const leaseExpires = Date.parse(response.replicaLease.expiresAt);
  return Number.isFinite(clientTime) && Number.isFinite(serverTime) && Number.isFinite(expiresAt)
    && Number.isFinite(leaseLastSeen) && Number.isFinite(leaseExpires)
    && response.acceptedProtocolVersion === request.protocolVersion
    && response.maxBatchOperations === 1
    && response.collection.collectionId === request.collection.collectionId
    && response.clockSkewMilliseconds === serverTime - clientTime
    && expiresAt > serverTime
    && leaseLastSeen <= serverTime
    && leaseExpires > leaseLastSeen;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0).map(([key, item]) =>
      `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new SyncSessionHttpError('invalid_document');
  return encoded;
}
