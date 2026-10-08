import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createPublicationProblemDescriptor, parseIJson } from '@know-n/colp/server';
import { createValidatorRegistry } from '@know-n/colp/schema';
import { endpointContracts } from '@know-n/colp/semantic';
import type { ProblemCode } from '@know-n/colp/server';
import type { SyncPush, SyncPushResult } from '@know-n/colp/types';
import type { ExtensionCredentialEvidencePort } from '../../modules/identity/index.js';
import {
  SyncPushHttpError,
  probeSyncPushRuntimeOwnership,
  type SyncPushHttpApplication,
  type SyncPushHttpApplicationInput,
} from '../../modules/sync/index.js';
import { DatabaseOperationError } from '../../infrastructure/database/errors.js';
import type { Metrics } from '../../infrastructure/telemetry/index.js';
import { rateLimitClientKey } from '../http-security.js';
import {
  resolveSyncAdmissionPolicy,
  syncAdmissionSubjectKey,
  syncAdmissionPolicyHeader,
  type SyncAdmissionPolicy,
} from '../../infrastructure/rate-limit/index.js';
import { requireColpAuthorization } from './sync-colp-authorization.js';
import { createSyncTransportSecurity } from './sync-transport-security.js';

export { SyncPushHttpError } from '../../modules/sync/index.js';

export interface SyncPushRouteDependencies {
  readonly path: string;
  readonly credentialVerifier: ExtensionCredentialEvidencePort;
  readonly application: SyncPushHttpApplication;
  readonly allowedOrigins: readonly string[];
  readonly rateLimit: { readonly maxRequests: number; readonly windowMs: number };
  readonly maxBatchOperations: 1;
  readonly bodyLimitBytes?: number;
  readonly maxJsonDepth?: number;
  readonly maxJsonMembers?: number;
  readonly now?: () => number;
  readonly allowInsecureLoopback?: boolean;
  readonly metrics?: Metrics;
  /** Structured sink for unexpected push failures; never receives request bodies or credentials. */
  readonly logger?: { error(bindings: Record<string, unknown>, message: string): unknown };
  /** Explicit TRUSTED_INGRESS allowlist (FIX-M-008): forwarded TLS evidence is accepted only from allowlisted socket peers. */
  readonly trustedIngress?: readonly string[];
  /**
   * Optional Sync COLP limiter port (P-09). Production composition injects
   * Redis or the memory adapter. When omitted, SyncAdmissionPolicy is used.
   */
  /** @deprecated unified SyncAdmissionPolicy is authoritative. */
  readonly rateLimiter?: unknown;
  readonly admission?: SyncAdmissionPolicy;
}

interface Admission {
  readonly authorization: string;
  readonly idempotencyKey: string;
  readonly origin: string;
  readonly mediaType: 'application/json';
}

export function registerSyncPushRoutes(app: FastifyInstance, dependencies: SyncPushRouteDependencies): void {
  assertDependencies(dependencies);
  const contract = endpointContracts.syncPush.operations[0];
  if (contract?.method !== 'POST' || contract.request !== 'syncPush'
      || contract.response !== 'syncPushResult' || !contract.successStatuses.includes(200)
      || !contract.requiredRequestHeaders?.includes('Idempotency-Key')) {
    throw new TypeError('Public COLP syncPush endpoint contract is incompatible');
  }
  const admissionPolicy = resolveSyncAdmissionPolicy(
    dependencies.admission, 'push', dependencies.rateLimit, dependencies.now,
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
      const authorization = requireColpAuthorization(fields, (code) => new SyncPushHttpError(code));
      const idempotencyKey = exactlyOne(fields, 'idempotency-key', 'invalid_json');
      const origin = exactlyOne(fields, 'origin', 'origin_not_allowed');
      const contentType = exactlyOne(fields, 'content-type', 'unsupported_media_type');
      if (!dependencies.allowedOrigins.includes(origin)) throw new SyncPushHttpError('origin_not_allowed');
      if (!transportSecurity.isSecure(request)) throw new SyncPushHttpError('authentication_required');
      if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(contentType)) {
        throw new SyncPushHttpError('unsupported_media_type');
      }
      if (!/^[A-Za-z0-9._~-]{1,512}$/u.test(idempotencyKey)) {
        throw new SyncPushHttpError('invalid_json');
      }
      reply.header('RateLimit-Policy', syncAdmissionPolicyHeader('push', dependencies.rateLimit));
      const outcome = await admissionPolicy.admitPreAuth({
        purpose: 'push', clientKey: rateLimitClientKey(request, dependencies.path),
      });
      if (outcome.kind === 'denied') {
        reply.header('Retry-After', String(outcome.retryAfterSeconds));
        throw new SyncPushHttpError('rate_limited', outcome.retryAfterSeconds);
      }
      if (outcome.kind === 'failed') throw new SyncPushHttpError('service_unavailable');
      admissions.set(request, Object.freeze({
        authorization, idempotencyKey, origin, mediaType: 'application/json' as const,
      }));
    });
    syncApp.setErrorHandler((error, _request, reply) => sendProblem(reply,
      (error as { readonly code?: unknown }).code === 'FST_ERR_CTP_BODY_TOO_LARGE'
        ? new SyncPushHttpError('payload_too_large') : normalizeError(error)));
    syncApp.post(dependencies.path, async (request, reply) => {
      const startedAt = performance.now();
      safeIncrement(dependencies.metrics, 'sync.push.requests_total');
      try {
        const admission = admissions.get(request);
        if (!admission) throw new SyncPushHttpError('internal_error');
        let document: unknown;
        try {
          if (!Buffer.isBuffer(request.body)) throw new TypeError('Sync Push body is not buffered');
          const source = new TextDecoder('utf-8', { fatal: true }).decode(request.body);
          document = parseIJson(source, {
            maxDepth: dependencies.maxJsonDepth ?? 64,
            maxMembers: dependencies.maxJsonMembers ?? 20_000,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : '';
          throw new SyncPushHttpError(/limit|depth|budget/iu.test(message)
            ? 'payload_too_large' : 'invalid_json');
        }
        const structural = createValidatorRegistry().validate('syncPush', document);
        if (!structural.valid) throw new SyncPushHttpError('invalid_document');
        const push = document as SyncPush;
        if (dependencies.maxBatchOperations !== 1 || push.operations.length !== 1) {
          throw new SyncPushHttpError('invalid_document');
        }
        // Session-bound batchId contract (F021): `batchId === sessionId` or
        // `${sessionId}.` plus a non-empty opaque suffix — the only forms the
        // Sequence admission and DB CHECK accept. `:`/`/` forms already fail the
        // wire `opaqueId` pattern above; this rejects wire-legal but unbound
        // forms (empty dot suffix, cross-session prefix) with a 4xx problem
        // instead of letting them drift past document validation.
        if (push.batchId !== push.sessionId
            && !(push.batchId.startsWith(`${push.sessionId}.`)
              && push.batchId.length > push.sessionId.length + 1)) {
          throw new SyncPushHttpError('invalid_document');
        }
        let credential: SyncPushHttpApplicationInput['credential'];
        try {
          credential = await dependencies.credentialVerifier.verify({ authorization: admission.authorization });
        } catch {
          throw new SyncPushHttpError('authentication_required');
        }
        const subjectOutcome = await admissionPolicy.admitSubject({
          purpose: 'push',
          subjectKey: syncAdmissionSubjectKey({
            credential,
            replicaId: push.operations[0]?.replicaId,
            sessionId: push.sessionId,
          }),
        });
        if (subjectOutcome.kind === 'denied') {
          reply.header('Retry-After', String(subjectOutcome.retryAfterSeconds));
          throw new SyncPushHttpError('rate_limited', subjectOutcome.retryAfterSeconds);
        }
        if (subjectOutcome.kind === 'failed') throw new SyncPushHttpError('service_unavailable');
        const result = await dependencies.application.admit({
          credential,
          idempotencyKey: admission.idempotencyKey,
          requestFingerprint: createHash('sha256').update(canonicalJson(document), 'utf8').digest('base64url'),
          origin: admission.origin,
          mediaType: admission.mediaType,
          endpointIdentity: dependencies.path,
          request: push,
        });
        const response = createValidatorRegistry().validate('syncPushResult', result);
        if (!response.valid || !validResponseSemantics(result, push)) {
          throw new SyncPushHttpError('internal_error');
        }
        safeIncrement(dependencies.metrics, `sync.push.outcome.${boundedResultStatus(result)}`);
        return reply.code(200).header('Cache-Control', 'private, no-store')
          .type('application/json').send(result);
      } catch (error) {
        logUnexpectedPushError(dependencies.logger, error);
        const normalized = normalizeError(error);
        safeIncrement(dependencies.metrics, `sync.push.outcome.${boundedProblemOutcome(normalized.code)}`);
        return sendProblem(reply, normalized);
      } finally {
        safeObserve(dependencies.metrics, 'sync.push.duration_ms', performance.now() - startedAt);
      }
    });
    done();
  });
}

function logUnexpectedPushError(
  logger: SyncPushRouteDependencies['logger'], error: unknown,
): void {
  if (!logger || error instanceof DatabaseOperationError) return;
  // Stable protocol outcomes are already observable through the Problem body
  // and outcome metrics. internal_error is never an expected admission result —
  // every throw site is an invariant failure or an unrecognized-error fold, so
  // keep the bounded cause chain for operators.
  if (error instanceof SyncPushHttpError && error.code !== 'internal_error') return;
  const chain: Array<Record<string, unknown>> = [];
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current; depth += 1) {
    if (current instanceof Error) {
      chain.push({ name: current.name, message: current.message, ...(current.stack ? { stack: current.stack } : {}) });
      current = current.cause;
    } else {
      chain.push({ value: typeof current === 'string' ? current : String(current) });
      break;
    }
  }
  try { logger.error({ error: chain }, 'unexpected sync push failure'); } catch { /* telemetry cannot alter protocol behavior */ }
}


function boundedResultStatus(result: SyncPushResult): 'applied' | 'rebased' | 'noop'
  | 'conflicted' | 'rejected' | 'deferred' {
  const status = result.results[0]?.status;
  return status === 'applied' || status === 'rebased' || status === 'noop'
    || status === 'conflicted' || status === 'rejected' || status === 'deferred' ? status : 'rejected';
}

function boundedProblemOutcome(code: ProblemCode): 'sequence_gap' | 'sequence_blocked'
  | 'sequence_reuse' | 'op_id_reused' | 'service_unavailable' | 'internal_error' | 'rejected' {
  if (code === 'sequence_gap' || code === 'sequence_blocked' || code === 'sequence_reuse'
      || code === 'op_id_reused' || code === 'service_unavailable' || code === 'internal_error') return code;
  return 'rejected';
}

function safeIncrement(metrics: Metrics | undefined, name: string): void {
  try { metrics?.increment(name); } catch { /* telemetry must not alter protocol behavior */ }
}

function safeObserve(metrics: Metrics | undefined, name: string, value: number): void {
  try { metrics?.observe(name, value); } catch { /* telemetry must not alter protocol behavior */ }
}

function assertDependencies(dependencies: SyncPushRouteDependencies): void {
  if (!/^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]+$/u.test(dependencies.path)) {
    throw new TypeError('syncPush path must be a static absolute path');
  }
  probeSyncPushRuntimeOwnership(dependencies.application, dependencies.maxBatchOperations);
  if (dependencies.allowedOrigins.length < 1
      || dependencies.allowedOrigins.some((origin) => !/^chrome-extension:\/\/[a-p]{32}$/u.test(origin))) {
    throw new TypeError('Sync Push origins must be exact Chromium extension origins');
  }
  for (const value of [dependencies.rateLimit.maxRequests, dependencies.rateLimit.windowMs]) {
    if (!Number.isSafeInteger(value) || value < 1) throw new TypeError('Sync Push rate limits must be positive integers');
  }
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
  if (values.length === 0) throw new SyncPushHttpError(missing);
  const value = values[0]!;
  if (values.length !== 1 || value.includes(',') || !/^[\x20-\x7e]+$/u.test(value)
      || value.trim() !== value) throw new SyncPushHttpError('invalid_json');
  return value;
}

function normalizeError(error: unknown): SyncPushHttpError {
  if (error instanceof SyncPushHttpError) return error;
  if (error instanceof DatabaseOperationError
      && (error.kind === 'commit_outcome_unknown' || error.retryableAtCommandBoundary)) {
    return new SyncPushHttpError('service_unavailable');
  }
  return new SyncPushHttpError('internal_error');
}

function sendProblem(reply: FastifyReply, error: SyncPushHttpError) {
  const descriptor = createPublicationProblemDescriptor({
    code: error.code,
    ...((error.retryAfterSeconds === undefined && error.expectedSequence === undefined) ? {} : {
      recovery: {
        ...(error.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: error.retryAfterSeconds }),
        ...(error.expectedSequence === undefined ? {} : { expectedSequence: error.expectedSequence }),
      },
    }),
  });
  if (error.code === 'authentication_required') reply.header('WWW-Authenticate', 'Bearer');
  return reply.code(descriptor.status).header('Cache-Control', 'private, no-store')
    .type(descriptor.headers['content-type']).send(descriptor.problem);
}

function validResponseSemantics(result: SyncPushResult, request: SyncPush): boolean {
  return result.results.length === 1 && result.results[0]?.opId === request.operations[0]?.opId
    && result.results[0]?.sequence === request.operations[0]?.sequence;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0).map(([key, item]) =>
      `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new SyncPushHttpError('invalid_document');
  return encoded;
}
