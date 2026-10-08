import type { FastifyInstance, FastifyReply } from 'fastify';
import { createPublicationProblemDescriptor } from '@know-n/colp/server';
import { createValidatorRegistry } from '@know-n/colp/schema';
import { endpointContracts } from '@know-n/colp/semantic';
import { problemRegistry, type ProblemCode } from '@know-n/colp/server';
import type { Snapshot, SyncSnapshotQuery, SyncSnapshotV02 } from '@know-n/colp/types';
import type { ExtensionCredentialEvidencePort, VerifiedExtensionCredential } from '../../modules/identity/index.js';
import { SyncBootstrapSnapshotError } from '../../modules/sync/index.js';
import {
  resolveSyncAdmissionPolicy,
  syncAdmissionPolicyHeader,
  syncAdmissionSubjectKey,
  type SyncAdmissionPolicy,
} from '../../infrastructure/rate-limit/index.js';
import { rateLimitClientKey } from '../http-security.js';
import { requireColpAuthorization } from './sync-colp-authorization.js';
import { createSyncTransportSecurity } from './sync-transport-security.js';
import { registerSyncSnapshotConflictRoutes, type SyncSnapshotConflictApplication } from './sync-snapshot-conflict-routes.js';

export interface SyncSnapshotRouteDependencies {
  readonly path: string;
  readonly credentialVerifier: ExtensionCredentialEvidencePort;
  readonly application: ({
    query(input: { readonly credential: VerifiedExtensionCredential; readonly request: SyncSnapshotQuery }): Promise<Snapshot | SyncSnapshotV02>;
  } & Partial<SyncSnapshotConflictApplication>);
  readonly allowedOrigins: readonly string[];
  readonly rateLimit: { readonly maxRequests: number; readonly windowMs: number };
  readonly admission?: SyncAdmissionPolicy;
  readonly now?: () => number;
  readonly allowInsecureLoopback?: boolean;
  /** Explicit TRUSTED_INGRESS allowlist (FIX-M-008): forwarded TLS evidence is accepted only from allowlisted socket peers. */
  readonly trustedIngress?: readonly string[];
}

export function registerSyncSnapshotRoutes(app: FastifyInstance, dependencies: SyncSnapshotRouteDependencies): void {
  if (!/^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]+$/u.test(dependencies.path)) throw new TypeError('syncSnapshot path must be static');
  const contract = endpointContracts.syncSnapshot.operations[0];
  if (contract?.method !== 'GET' || contract.query !== 'syncSnapshotQuery' || contract.response !== 'snapshot' || !contract.successStatuses.includes(200)) throw new TypeError('Public COLP syncSnapshot endpoint contract is incompatible');
  const admission = resolveSyncAdmissionPolicy(
    dependencies.admission, 'snapshot', dependencies.rateLimit, dependencies.now,
  );
  const transportSecurity = createSyncTransportSecurity({
    allowInsecureLoopback: dependencies.allowInsecureLoopback === true,
    ...(dependencies.trustedIngress === undefined ? {} : { trustedIngress: dependencies.trustedIngress }),
  });
  app.get(dependencies.path, async (request, reply) => {
    try {
      const headers = collect(request.raw.rawHeaders);
      const authorization = requireColpAuthorization(headers, (code) => new SyncBootstrapSnapshotError(code));
      const origin = one(headers, 'origin', 'origin_not_allowed');
      const headerSessionId = optionalOne(headers, 'known-sync-session');
      if (!dependencies.allowedOrigins.includes(origin)) throw new SyncBootstrapSnapshotError('origin_not_allowed');
      if (!transportSecurity.isSecure(request)) throw new SyncBootstrapSnapshotError('authentication_required');
      reply.header('RateLimit-Policy', syncAdmissionPolicyHeader('snapshot', dependencies.rateLimit));
      const outcome = await admission.admitPreAuth({
        purpose: 'snapshot',
        clientKey: rateLimitClientKey(request, dependencies.path),
      });
      if (outcome.kind === 'denied') {
        reply.header('Retry-After', String(outcome.retryAfterSeconds));
        throw new SyncBootstrapSnapshotError('rate_limited');
      }
      if (outcome.kind === 'failed') {
        throw new SyncBootstrapSnapshotError('service_unavailable');
      }
      let credential: VerifiedExtensionCredential;
      try {
        credential = await dependencies.credentialVerifier.verify({ authorization });
      } catch (error) {
        const normalized = normalize(error);
        throw normalized.code === 'internal_error' ? new SyncBootstrapSnapshotError('authentication_required') : normalized;
      }
      const query = parseQuery(request.raw.url ?? '');
      if (headerSessionId !== undefined && query.sessionId !== headerSessionId) {
        throw new SyncBootstrapSnapshotError('invalid_cursor_scope', 'header_query_session');
      }
      const subjectOutcome = await admission.admitSubject({
        purpose: 'snapshot',
        subjectKey: syncAdmissionSubjectKey({ credential, sessionId: query.sessionId }),
      });
      if (subjectOutcome.kind === 'denied') {
        reply.header('Retry-After', String(subjectOutcome.retryAfterSeconds));
        throw new SyncBootstrapSnapshotError('rate_limited');
      }
      if (subjectOutcome.kind === 'failed') throw new SyncBootstrapSnapshotError('service_unavailable');
      const structural = createValidatorRegistry().validate('syncSnapshotQuery', query);
      if (!structural.valid) throw new SyncBootstrapSnapshotError('invalid_query');
      const snapshot = await dependencies.application.query({ credential, request: query });
      const response = createValidatorRegistry().validate(
        snapshot.protocolVersion === '0.2' ? 'syncSnapshotV02' : 'snapshot', snapshot,
      );
      if (!response.valid || snapshot.mode !== 'sync') throw new SyncBootstrapSnapshotError('internal_error');
      return reply.code(200).header('Cache-Control', 'private, no-store').type('application/json').send(snapshot);
    } catch (error) {
      const normalized = normalize(error);
      request.log.debug({ event: 'sync_snapshot_denied', problem: normalized.code,
        authorityGuard: normalized.authorityGuard ?? 'unspecified' }, 'sync Snapshot request denied');
      return sendProblem(reply, normalized);
    }
  });
  if (dependencies.application.listOpenConflicts && dependencies.application.confirmOpenConflicts) {
    registerSyncSnapshotConflictRoutes(app, {
      ...dependencies,
      application: dependencies.application as SyncSnapshotRouteDependencies['application'] & SyncSnapshotConflictApplication,
    });
  }
}

function parseQuery(rawUrl: string): SyncSnapshotQuery {
  const url = new URL(rawUrl, 'https://sync.invalid');
  for (const key of url.searchParams.keys()) if (!['sessionId', 'pageCursor', 'limit'].includes(key) || url.searchParams.getAll(key).length !== 1) throw new SyncBootstrapSnapshotError('invalid_query');
  const sessionId = url.searchParams.get('sessionId');
  if (!sessionId) throw new SyncBootstrapSnapshotError('invalid_query');
  const pageCursor = url.searchParams.get('pageCursor');
  const rawLimit = url.searchParams.get('limit');
  if (url.searchParams.has('pageCursor') && !pageCursor) throw new SyncBootstrapSnapshotError('invalid_query');
  if (rawLimit !== null && !/^[1-9]\d*$/u.test(rawLimit)) throw new SyncBootstrapSnapshotError('invalid_query');
  const limit = rawLimit === null ? undefined : Number(rawLimit);
  return { sessionId, ...(pageCursor ? { pageCursor } : {}), ...(limit !== undefined ? { limit } : {}) };
}

function collect(raw: readonly string[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (let i = 0; i < raw.length; i += 2) { const key = raw[i]!.toLowerCase(); const value = raw[i + 1] ?? ''; out.set(key, [...(out.get(key) ?? []), value]); }
  return out;
}
function one(headers: Map<string, string[]>, key: string, code: ProblemCode): string {
  const values = headers.get(key); if (values?.length !== 1 || !values[0] || /[\r\n\0]/u.test(values[0])) throw new SyncBootstrapSnapshotError(code); return values[0];
}
function optionalOne(headers: Map<string, string[]>, key: string): string | undefined {
  const values = headers.get(key); if (!values) return undefined;
  if (values.length !== 1 || !values[0] || /[\r\n\0]/u.test(values[0])) {
    throw new SyncBootstrapSnapshotError('invalid_query');
  }
  return values[0];
}
function normalize(error: unknown): SyncBootstrapSnapshotError {
  if (error instanceof SyncBootstrapSnapshotError) return error;
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
      && Object.hasOwn(problemRegistry, error.code)) {
    const authorityGuard = 'authorityGuard' in error && typeof error.authorityGuard === 'string'
      ? error.authorityGuard : undefined;
    return new SyncBootstrapSnapshotError(error.code as ProblemCode, authorityGuard);
  }
  return new SyncBootstrapSnapshotError('internal_error');
}
function sendProblem(reply: FastifyReply, error: SyncBootstrapSnapshotError) {
  const descriptor = createPublicationProblemDescriptor({ code: error.code });
  if (error.code === 'authentication_required') reply.header('WWW-Authenticate', 'Bearer');
  return reply.code(descriptor.status).header('Cache-Control', 'private, no-store').type(descriptor.headers['content-type']).send(descriptor.problem);
}
