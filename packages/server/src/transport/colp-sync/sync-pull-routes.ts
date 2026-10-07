import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ProblemCode } from '@know-n/colp/server';
import { createValidatorRegistry } from '@know-n/colp/schema';
import { endpointContracts } from '@know-n/colp/semantic';
import { createPublicationProblemDescriptor, parseProtocolQuery } from '@know-n/colp/server';
import type { SyncPull, SyncPullQuery, SyncPullV02 } from '@know-n/colp/types';
import type { ExtensionCredentialEvidencePort, VerifiedExtensionCredential } from '../../modules/identity/index.js';
import {
  SyncPullReadError,
  type SyncPullReadPort,
} from '../../modules/sync/index.js';
import { DatabaseOperationError } from '../../infrastructure/database/errors.js';
import { rateLimitClientKey } from '../http-security.js';
import {
  resolveSyncAdmissionPolicy,
  syncAdmissionSubjectKey,
  syncAdmissionPolicyHeader,
  type SyncAdmissionPolicy,
} from '../../infrastructure/rate-limit/index.js';
import { requireColpAuthorization } from './sync-colp-authorization.js';
import { createSyncTransportSecurity } from './sync-transport-security.js';

export interface SyncPullRouteDependencies {
  readonly path: string;
  readonly credentialVerifier: ExtensionCredentialEvidencePort;
  readonly reader: SyncPullReadPort;
  readonly allowedOrigins: readonly string[];
  readonly rateLimit: { readonly maxRequests: number; readonly windowMs: number };
  readonly maxLimit: number;
  readonly responseBudgetBytes: number;
  readonly requestTimeoutMs: number;
  /**
   * FIX-L-038: required pacing dependency — production assembly injects
   * config.pull.recommendedPullAfterSeconds; assembly gaps fail loudly at
   * registration instead of silently tight-polling at 0.
   */
  readonly recommendedPullAfterSeconds: number;
  readonly snapshotUrl?: string;
  readonly allowInsecureLoopback?: boolean;
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

class SyncPullHttpError extends Error {
  constructor(readonly code: ProblemCode, readonly snapshotRecovery = false) {
    super(`Sync Pull denied: ${code}`); this.name = 'SyncPullHttpError';
  }
}

const validators = createValidatorRegistry();

/** FIX-L-038: bounds mirror the SYNC_PULL_RECOMMENDED_AFTER_SECONDS config cap. */
const MAX_RECOMMENDED_PULL_AFTER_SECONDS = 86_400;

export function registerSyncPullRoutes(app: FastifyInstance, dependencies: SyncPullRouteDependencies): void {
  assertDependencies(dependencies);
  const contract = endpointContracts.syncPull.operations[0];
  if (contract?.method !== 'GET' || contract.query !== 'syncPullQuery'
      || contract.response !== 'syncPull' || !contract.successStatuses.includes(200)) {
    throw new TypeError('Public COLP syncPull endpoint contract is incompatible');
  }
  const admission = resolveSyncAdmissionPolicy(dependencies.admission, 'pull', dependencies.rateLimit);
  const transportSecurity = createSyncTransportSecurity({
    allowInsecureLoopback: dependencies.allowInsecureLoopback === true,
    ...(dependencies.trustedIngress === undefined ? {} : { trustedIngress: dependencies.trustedIngress }),
  });
  app.register((syncApp, _options, done) => {
    syncApp.get(dependencies.path, async (request, reply) => {
      const cancellation = requestCancellation(request, reply, dependencies.requestTimeoutMs);
      try {
        const fields = collectRawHeaders(request.raw.rawHeaders);
        const authorization = requireColpAuthorization(fields, (code) => new SyncPullHttpError(code));
        const origin = exactlyOne(fields, 'origin', 'origin_not_allowed');
        const headerSessionId = optionalOne(fields, 'known-sync-session');
        if (!dependencies.allowedOrigins.includes(origin)) throw new SyncPullHttpError('origin_not_allowed');
        if (!transportSecurity.isSecure(request)) throw new SyncPullHttpError('authentication_required');
        reply.header('RateLimit-Policy', syncAdmissionPolicyHeader('pull', dependencies.rateLimit));
        const outcome = await admission.admitPreAuth({
          purpose: 'pull', clientKey: rateLimitClientKey(request, dependencies.path),
        });
        if (outcome.kind === 'denied') {
          reply.header('Retry-After', String(outcome.retryAfterSeconds));
          throw new SyncPullHttpError('rate_limited');
        }
        if (outcome.kind === 'failed') throw new SyncPullHttpError('service_unavailable');
        let credential: VerifiedExtensionCredential;
        try { credential = await dependencies.credentialVerifier.verify({ authorization }); }
        catch { throw new SyncPullHttpError('authentication_required'); }
        cancellation.signal.throwIfAborted();
        const parsed = parseSyncPullQuery(request.raw.url ?? '');
        if (!parsed.valid) throw new SyncPullHttpError('invalid_query');
        if (headerSessionId !== undefined && parsed.value.sessionId !== headerSessionId) {
          throw new SyncPullHttpError('invalid_cursor_scope');
        }
        const limit = parsed.value.limit ?? dependencies.maxLimit;
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > dependencies.maxLimit) {
          throw new SyncPullHttpError('invalid_query');
        }
        const requestCursor = parsed.value.cursor ?? null;
        const subjectOutcome = await admission.admitSubject({
          purpose: 'pull',
          subjectKey: syncAdmissionSubjectKey({ credential, sessionId: parsed.value.sessionId }),
        });
        if (subjectOutcome.kind === 'denied') {
          reply.header('Retry-After', String(subjectOutcome.retryAfterSeconds));
          throw new SyncPullHttpError('rate_limited');
        }
        if (subjectOutcome.kind === 'failed') throw new SyncPullHttpError('service_unavailable');
        const page = await dependencies.reader.read({ credential, sessionId: parsed.value.sessionId,
          origin,
          cursor: requestCursor, limit, signal: cancellation.signal,
          timeoutMs: dependencies.requestTimeoutMs });
        cancellation.signal.throwIfAborted();
        const response = { events: [...page.events], nextCursor: page.nextCursor,
          hasMore: page.hasMore, collectionRevision: page.collectionRevision,
          recommendedPullAfterSeconds: dependencies.recommendedPullAfterSeconds } as SyncPull | SyncPullV02;
        const definition = page.protocolVersion === '0.2' ? 'syncPullV02' : 'syncPull';
        if (!validators.validate(definition, response).valid
            || !validResponseSemantics(response, requestCursor, page.cursorReissued === true)) {
          throw new SyncPullHttpError('internal_error');
        }
        const bytes = Buffer.byteLength(JSON.stringify(response), 'utf8');
        if (bytes > dependencies.responseBudgetBytes) throw new SyncPullHttpError('payload_too_large');
        reply.code(200).header('Cache-Control', 'private, no-store').type('application/json');
        if (page.cursorReissued === true && response.events.length === 0) {
          reply.header('Known-Sync-Cursor-Reissued', 'true');
        }
        return reply.send(response);
      } catch (error) {
        return sendProblem(reply, normalizeError(error), dependencies.snapshotUrl);
      } finally { cancellation.dispose(); }
    });
    done();
  });
}

function parseSyncPullQuery(requestTarget: string): { readonly valid: true; readonly value: SyncPullQuery }
  | { readonly valid: false } {
  const separator = requestTarget.indexOf('?');
  if (separator < 0) return { valid: false };
  const source = requestTarget.slice(separator + 1);
  if (source.length < 1 || Buffer.byteLength(source, 'utf8') > 16_384 || source.includes('#')) return { valid: false };
  const parameters = new URLSearchParams();
  const fields = source.split('&');
  if (fields.length > 16 || fields.some((field) => field.length === 0)) return { valid: false };
  try {
    for (const field of fields) {
      const equals = field.indexOf('=');
      const name = decodeURIComponent((equals < 0 ? field : field.slice(0, equals)).replaceAll('+', ' '));
      const value = decodeURIComponent((equals < 0 ? '' : field.slice(equals + 1)).replaceAll('+', ' '));
      if (!name || /[\u0000-\u001f\u007f-\u009f]/u.test(name + value)) return { valid: false };
      parameters.append(name, value);
    }
  } catch { return { valid: false }; }
  const parsed = parseProtocolQuery('syncPullQuery', parameters, validators);
  return parsed.valid ? { valid: true, value: parsed.value as unknown as SyncPullQuery } : { valid: false };
}

function validResponseSemantics(response: SyncPull | SyncPullV02, requestCursor: string | null,
  cursorReissued: boolean): boolean {
  if (response.events.length === 0) {
    return !response.hasMore && (requestCursor === null ? true
      : cursorReissued ? response.nextCursor !== requestCursor : response.nextCursor === requestCursor);
  }
  return (requestCursor === null || response.nextCursor !== requestCursor)
    && response.nextCursor === response.events.at(-1)?.cursor
    && response.events.every((event, index) => index === 0 || event.cursor !== response.events[index - 1]?.cursor);
}

function requestCancellation(request: FastifyRequest, reply: FastifyReply, timeoutMs: number) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new DOMException('Timed out', 'TimeoutError')), timeoutMs);
  timeout.unref();
  const aborted = () => controller.abort(new DOMException('Client disconnected', 'AbortError'));
  request.raw.once('aborted', aborted);
  request.raw.socket.once('close', aborted);
  reply.raw.once('close', aborted);
  return { signal: controller.signal, dispose() { clearTimeout(timeout); request.raw.off('aborted', aborted);
    request.raw.socket.off('close', aborted); reply.raw.off('close', aborted); } };
}

function assertDependencies(dependencies: SyncPullRouteDependencies): void {
  if (!/^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]+$/u.test(dependencies.path)) throw new TypeError('syncPull path must be static');
  if (dependencies.allowedOrigins.length < 1
      || dependencies.allowedOrigins.some((origin) => !/^chrome-extension:\/\/[a-p]{32}$/u.test(origin))) {
    throw new TypeError('Sync Pull origins must be exact Chromium extension origins');
  }
  for (const value of [dependencies.rateLimit.maxRequests, dependencies.rateLimit.windowMs,
    dependencies.maxLimit, dependencies.responseBudgetBytes, dependencies.requestTimeoutMs]) {
    if (!Number.isSafeInteger(value) || value < 1) throw new TypeError('Sync Pull limits must be positive safe integers');
  }
  if (!Number.isSafeInteger(dependencies.recommendedPullAfterSeconds)
      || dependencies.recommendedPullAfterSeconds < 0
      || dependencies.recommendedPullAfterSeconds > MAX_RECOMMENDED_PULL_AFTER_SECONDS) {
    throw new TypeError(`Sync Pull recommended interval must be a safe integer within [0, ${MAX_RECOMMENDED_PULL_AFTER_SECONDS}] seconds`);
  }
  if (dependencies.maxLimit > 1_000) throw new TypeError('Sync Pull max limit exceeds the P3-20 bound');
  if (dependencies.snapshotUrl !== undefined) {
    const snapshot = new URL(dependencies.snapshotUrl);
    const loopback = snapshot.protocol === 'http:'
      && ['localhost', '127.0.0.1', '[::1]'].includes(snapshot.hostname.toLowerCase());
    if ((!loopback && snapshot.protocol !== 'https:') || snapshot.username || snapshot.password
        || snapshot.hash || snapshot.search) throw new TypeError('Sync Pull Snapshot URL is invalid');
  }
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
  if (values.length === 0) throw new SyncPullHttpError(missing);
  if (values.length !== 1 || value.includes(',') || !/^[\x20-\x7e]+$/u.test(value) || value.trim() !== value) {
    throw new SyncPullHttpError('invalid_query');
  }
  return value;
}
function optionalOne(fields: ReadonlyMap<string, readonly string[]>, name: string): string | undefined {
  const values = fields.get(name); if (!values) return undefined;
  const value = values[0] ?? '';
  if (values.length !== 1 || value.includes(',') || !/^[\x20-\x7e]+$/u.test(value)
      || value.trim() !== value) throw new SyncPullHttpError('invalid_query');
  return value;
}

function normalizeError(error: unknown): SyncPullHttpError {
  if (error instanceof SyncPullHttpError) return error;
  if (error instanceof SyncPullReadError) {
    if (error.code === 'not_found') return new SyncPullHttpError('resource_not_found');
    if (error.code === 'invalid_cursor_scope') return new SyncPullHttpError('invalid_cursor_scope');
    if (error.code === 'sync_cursor_expired') return new SyncPullHttpError('sync_cursor_expired', true);
    if (error.code === 'recovery_required') return new SyncPullHttpError('stale_replica', true);
    if (error.code === 'replica_expired' || error.code === 'stale_replica') {
      return new SyncPullHttpError('stale_replica');
    }
    if (error.code === 'replica_retired') return new SyncPullHttpError('replica_retired');
    if (error.code === 'payload_too_large') return new SyncPullHttpError('payload_too_large');
    if (error.code === 'integrity_failure') return new SyncPullHttpError('internal_error');
  }
  if (error instanceof DatabaseOperationError && (
    error.retryableAtCommandBoundary || error.kind === 'unique_violation'
  )) {
    return new SyncPullHttpError('service_unavailable');
  }
  if (typeof error === 'object' && error !== null
      && ((error as { name?: unknown }).name === 'AbortError' || (error as { name?: unknown }).name === 'TimeoutError')) {
    return new SyncPullHttpError('service_unavailable');
  }
  return new SyncPullHttpError('internal_error');
}

function sendProblem(reply: FastifyReply, error: SyncPullHttpError, snapshotUrl: string | undefined) {
  const recovery = snapshotUrl !== undefined && error.snapshotRecovery ? { snapshotUrl } : undefined;
  const descriptor = createPublicationProblemDescriptor({ code: error.code, ...(recovery ? { recovery } : {}) });
  if (error.code === 'authentication_required') reply.header('WWW-Authenticate', 'Bearer');
  return reply.code(descriptor.status).header('Cache-Control', 'private, no-store')
    .type(descriptor.headers['content-type']).send(descriptor.problem);
}
