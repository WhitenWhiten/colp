import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createPublicationProblemDescriptor, problemRegistry, type ProblemCode } from '@know-n/colp/server';
import type { VerifiedExtensionCredential } from '../../modules/identity/index.js';
import { SyncBootstrapSnapshotError } from '../../modules/sync/index.js';
import type { SnapshotOpenConflictPage } from '../../infrastructure/sync/sync-snapshot-conflict-recovery.js';
import {
  resolveSyncAdmissionPolicy, syncAdmissionSubjectKey,
} from '../../infrastructure/rate-limit/index.js';
import { rateLimitClientKey } from '../http-security.js';
import {
  requireColpAuthorization,
} from './sync-colp-authorization.js';
import { createSyncTransportSecurity } from './sync-transport-security.js';
import type { SyncSnapshotRouteDependencies } from './sync-snapshot-routes.js';

const CAPABILITY_HEADER = 'known-sync-conflict-recovery';

export interface SyncSnapshotConflictApplication {
  listOpenConflicts(input: { readonly credential: VerifiedExtensionCredential; readonly sessionId: string;
    readonly snapshotId: string; readonly offset: number; readonly limit: number }): Promise<SnapshotOpenConflictPage>;
  confirmOpenConflicts(input: { readonly credential: VerifiedExtensionCredential; readonly sessionId: string;
    readonly snapshotId: string; readonly conflictDigest: string }): Promise<{ readonly confirmed: true }>;
}

/** Paged open-conflict list bound to one Snapshot cut. Negotiated; old clients are not served it. */
export function registerSyncSnapshotConflictRoutes(app: FastifyInstance, dependencies: SyncSnapshotRouteDependencies
  & { readonly application: SyncSnapshotConflictApplication }): void {
  const path = `${dependencies.path}/conflicts`;
  const admission = resolveSyncAdmissionPolicy(
    dependencies.admission, 'snapshot', dependencies.rateLimit, dependencies.now,
  );
  const transportSecurity = createSyncTransportSecurity({
    allowInsecureLoopback: dependencies.allowInsecureLoopback === true,
    ...(dependencies.trustedIngress === undefined ? {} : { trustedIngress: dependencies.trustedIngress }),
  });
  app.get(path, async (request, reply) => {
    try {
      await enforceAdmission(request, reply, admission, path);
      const admitted = await admit(request, dependencies, transportSecurity);
      await enforceSubject(reply, admission, admitted);
      const url = new URL(request.raw.url ?? '', 'https://sync.invalid');
      const offset = readInteger(url, 'offset', 0);
      const limit = readInteger(url, 'limit', 50);
      if (offset === undefined || limit === undefined || limit < 1 || limit > 100) {
        throw new SyncBootstrapSnapshotError('invalid_query');
      }
      const page = await dependencies.application.listOpenConflicts({
        credential: admitted.credential, sessionId: admitted.sessionId, snapshotId: admitted.snapshotId, offset, limit,
      });
      return reply.code(200).header('Cache-Control', 'private, no-store').type('application/json').send(page);
    } catch (error) {
      return sendProblem(reply, normalize(error));
    }
  });
  app.post(path, async (request, reply) => {
    try {
      await enforceAdmission(request, reply, admission, path);
      const admitted = await admit(request, dependencies, transportSecurity);
      await enforceSubject(reply, admission, admitted);
      const body = request.body;
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new SyncBootstrapSnapshotError('invalid_document');
      const digest = (body as { readonly conflictDigest?: unknown }).conflictDigest;
      const snapshotId = (body as { readonly snapshotId?: unknown }).snapshotId;
      if (snapshotId !== admitted.snapshotId || typeof digest !== 'string' || !/^[0-9a-f]{64}$/u.test(digest)) {
        throw new SyncBootstrapSnapshotError('invalid_document');
      }
      const confirmed = await dependencies.application.confirmOpenConflicts({
        credential: admitted.credential, sessionId: admitted.sessionId, snapshotId: admitted.snapshotId,
        conflictDigest: digest,
      });
      return reply.code(200).header('Cache-Control', 'private, no-store').type('application/json').send(confirmed);
    } catch (error) {
      return sendProblem(reply, normalize(error));
    }
  });
}

async function admit(request: FastifyRequest, dependencies: SyncSnapshotRouteDependencies,
  transportSecurity: { isSecure(value: FastifyRequest): boolean }): Promise<{
  readonly credential: VerifiedExtensionCredential; readonly sessionId: string; readonly snapshotId: string }> {
  const headers = collect(request.raw.rawHeaders);
  const authorization = requireColpAuthorization(headers, (code) => new SyncBootstrapSnapshotError(code));
  const origin = one(headers, 'origin', 'origin_not_allowed');
  if (!dependencies.allowedOrigins.includes(origin)) throw new SyncBootstrapSnapshotError('origin_not_allowed');
  if (!transportSecurity.isSecure(request)) throw new SyncBootstrapSnapshotError('authentication_required');
  if (one(headers, CAPABILITY_HEADER, 'unsupported_version') !== '1') {
    throw new SyncBootstrapSnapshotError('unsupported_version', 'snapshot_conflict_capability');
  }
  const url = new URL(request.raw.url ?? '', 'https://sync.invalid');
  const allowed = new Set(['sessionId', 'snapshotId', 'offset', 'limit']);
  for (const key of url.searchParams.keys()) {
    if (!allowed.has(key) || url.searchParams.getAll(key).length !== 1) throw new SyncBootstrapSnapshotError('invalid_query');
  }
  const sessionId = url.searchParams.get('sessionId');
  const snapshotId = url.searchParams.get('snapshotId');
  if (!sessionId || !snapshotId) throw new SyncBootstrapSnapshotError('invalid_query');
  const headerSessionId = optionalOne(headers, 'known-sync-session');
  if (headerSessionId !== undefined && headerSessionId !== sessionId) {
    throw new SyncBootstrapSnapshotError('invalid_cursor_scope', 'header_query_session');
  }
  let credential: VerifiedExtensionCredential;
  try {
    credential = await dependencies.credentialVerifier.verify({ authorization });
  } catch (error) {
    const normalized = normalize(error);
    throw normalized.code === 'internal_error' ? new SyncBootstrapSnapshotError('authentication_required') : normalized;
  }
  return { credential, sessionId, snapshotId };
}

async function enforceAdmission(request: FastifyRequest, reply: FastifyReply,
  admission: ReturnType<typeof resolveSyncAdmissionPolicy>, path: string): Promise<void> {
  const outcome = await admission.admitPreAuth({ purpose: 'snapshot', clientKey: rateLimitClientKey(request, path) });
  if (outcome.kind === 'denied') {
    reply.header('Retry-After', String(outcome.retryAfterSeconds));
    throw new SyncBootstrapSnapshotError('rate_limited');
  }
  if (outcome.kind === 'failed') throw new SyncBootstrapSnapshotError('service_unavailable');
}

async function enforceSubject(reply: FastifyReply, admission: ReturnType<typeof resolveSyncAdmissionPolicy>,
  admitted: { readonly credential: VerifiedExtensionCredential; readonly sessionId: string }): Promise<void> {
  const outcome = await admission.admitSubject({
    purpose: 'snapshot', subjectKey: syncAdmissionSubjectKey({ credential: admitted.credential, sessionId: admitted.sessionId }),
  });
  if (outcome.kind === 'denied') {
    reply.header('Retry-After', String(outcome.retryAfterSeconds));
    throw new SyncBootstrapSnapshotError('rate_limited');
  }
  if (outcome.kind === 'failed') throw new SyncBootstrapSnapshotError('service_unavailable');
}

function readInteger(url: URL, key: string, fallback: number): number | undefined {
  const raw = url.searchParams.get(key);
  if (raw === null) return fallback;
  if (!/^(?:0|[1-9]\d*)$/u.test(raw)) return undefined;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : undefined;
}

function collect(raw: readonly string[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (let i = 0; i < raw.length; i += 2) {
    const key = raw[i]!.toLowerCase();
    out.set(key, [...(out.get(key) ?? []), raw[i + 1] ?? '']);
  }
  return out;
}
function one(headers: Map<string, string[]>, key: string, code: ProblemCode): string {
  const values = headers.get(key);
  if (values?.length !== 1 || !values[0] || /[\r\n\0]/u.test(values[0])) throw new SyncBootstrapSnapshotError(code);
  return values[0];
}
function optionalOne(headers: Map<string, string[]>, key: string): string | undefined {
  const values = headers.get(key);
  if (!values) return undefined;
  if (values.length !== 1 || !values[0] || /[\r\n\0]/u.test(values[0])) throw new SyncBootstrapSnapshotError('invalid_query');
  return values[0];
}
function normalize(error: unknown): SyncBootstrapSnapshotError {
  if (error instanceof SyncBootstrapSnapshotError) return error;
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
      && Object.hasOwn(problemRegistry, error.code)) {
    return new SyncBootstrapSnapshotError(error.code as ProblemCode);
  }
  return new SyncBootstrapSnapshotError('internal_error');
}
function sendProblem(reply: FastifyReply, error: SyncBootstrapSnapshotError) {
  const descriptor = createPublicationProblemDescriptor({ code: error.code });
  if (error.code === 'authentication_required') reply.header('WWW-Authenticate', 'Bearer');
  return reply.code(descriptor.status).header('Cache-Control', 'private, no-store')
    .type(descriptor.headers['content-type']).send(descriptor.problem);
}
