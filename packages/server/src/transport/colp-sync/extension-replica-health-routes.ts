import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ExtensionAuthError, type ExtensionCredentialEvidencePort } from '../../modules/identity/index.js';
import { parseReplicaHealthReport, REPLICA_HEALTH_MAX_BODY_BYTES, ReplicaHealthError,
  type ReplicaHealthErrorCode, type ReplicaHealthRecorder } from '../../modules/sync/index.js';
import { rateLimitClientIp, createMemorySyncAdmissionPolicy, syncAdmissionSubjectKey,
  type SyncAdmissionPolicy } from '../../infrastructure/rate-limit/index.js';
import { colpAuthorizationFromRawHeaders } from './sync-colp-authorization.js';
import type { SyncTransportSecurity } from './sync-transport-security.js';

/**
 * Extension-only, like `/colp/v0.1/sync/library`: the browser reports its own
 * sync health to the Sync center. It needs no Session, so a stopped engine can
 * still say why it stopped, and it renews nothing. The response hands over what
 * the owner asked of this browser from the Sync center; the browser reports each
 * result in a later report.
 */
export const EXTENSION_REPLICA_HEALTH_PATH = '/colp/v0.1/sync/replica-health';

export interface ExtensionReplicaHealthRouteDependencies {
  readonly credentialVerifier: ExtensionCredentialEvidencePort;
  readonly recorder: ReplicaHealthRecorder;
  readonly allowedOrigins: readonly string[];
  /** Shared Sync TLS/ingress admission; helper routes must not bypass it. */
  readonly transportSecurity?: SyncTransportSecurity;
  readonly admission?: SyncAdmissionPolicy;
}

const STATUS: Readonly<Record<ReplicaHealthErrorCode, number>> = {
  invalid_document: 400, invalid_token: 401, resource_not_found: 404, replica_retired: 410,
};

export function registerExtensionReplicaHealthRoutes(
  app: FastifyInstance,
  dependencies: ExtensionReplicaHealthRouteDependencies,
): void {
  const admission = dependencies.admission ?? createMemorySyncAdmissionPolicy({
    budgets: { pull: { maxRequests: 120, windowMs: 60_000 }, push: { maxRequests: 120, windowMs: 60_000 } },
  });
  if (!dependencies.admission) app.addHook('onClose', async () => admission.close());
  // Reports share the light Pull budget: one per state change plus a slow heartbeat.
  const admitted = async (reply: FastifyReply, outcome: Awaited<ReturnType<SyncAdmissionPolicy['admitPreAuth']>>) => {
    if (outcome.kind === 'allowed') return true;
    if (outcome.kind === 'denied') reply.header('Retry-After', String(outcome.retryAfterSeconds));
    send(reply, outcome.kind === 'denied' ? 429 : 503, outcome.kind === 'denied' ? 'rate_limited' : 'service_unavailable',
      'Replica health admission is unavailable.');
    return false;
  };
  app.post(EXTENSION_REPLICA_HEALTH_PATH, {
    bodyLimit: REPLICA_HEALTH_MAX_BODY_BYTES,
    onRequest: async (request, reply) => {
      await admitted(reply, await admission.admitPreAuth({ purpose: 'pull', clientKey: rateLimitClientIp(request.ip) }));
    },
    config: { productTransport: { allowedQuery: [], acceptedMediaTypes: ['application/json'],
      bodyLimitBytes: REPLICA_HEALTH_MAX_BODY_BYTES, cacheControl: 'private-no-store' } },
  }, async (request, reply) => {
    if (dependencies.transportSecurity && !dependencies.transportSecurity.isSecure(request)) {
      return send(reply, 401, 'authentication_required', 'A secure transport is required.');
    }
    const origin = readHeader(request, 'origin')?.replace(/\/$/u, '');
    if (origin === undefined || !dependencies.allowedOrigins.includes(origin)) {
      return send(reply, 403, 'origin_not_allowed', 'The request origin is not allowed.');
    }
    const admittedAuthorization = colpAuthorizationFromRawHeaders(collectRawHeaders(request.raw.rawHeaders));
    const authorization = 'authorization' in admittedAuthorization ? admittedAuthorization.authorization : undefined;
    try {
      const credential = await dependencies.credentialVerifier.verify({ authorization });
      if (!await admitted(reply, await admission.admitSubject({ purpose: 'pull',
        subjectKey: syncAdmissionSubjectKey({ credential }) }))) return reply;
      const report = parseReplicaHealthReport(request.body);
      const result = await dependencies.recorder.record({ credential, report, replicaProof: readHeader(request, 'known-sync-replica-proof') });
      return reply.code(200).type('application/json; charset=utf-8')
        .send({ replicaId: report.replicaId, revision: result.revision, accepted: result.accepted,
          commands: result.commands });
    } catch (error: unknown) {
      if (error instanceof ReplicaHealthError) return send(reply, STATUS[error.code], error.code, error.message);
      if (error instanceof ExtensionAuthError || /authorization|credential|token|bearer/iu.test(
        error instanceof Error ? error.message : '',
      )) return send(reply, 401, 'invalid_token', 'The credential is not valid for this server.');
      request.log.warn({ reason: error instanceof Error ? error.message : 'replica_health_failed' },
        'replica health report failed');
      return send(reply, 503, 'service_unavailable', 'Replica health is temporarily unavailable.');
    }
  });
}

function send(reply: FastifyReply, status: number, code: string, message: string): FastifyReply {
  return reply.code(status).type('application/json; charset=utf-8').send({ error: { code, message } });
}
function readHeader(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  return typeof value === 'string' ? value : undefined;
}
function collectRawHeaders(raw: readonly string[]): Map<string, string[]> {
  const fields = new Map<string, string[]>();
  for (let index = 0; index < raw.length; index += 2) {
    const name = raw[index]!.toLowerCase();
    fields.set(name, [...(fields.get(name) ?? []), raw[index + 1]!]);
  }
  return fields;
}
