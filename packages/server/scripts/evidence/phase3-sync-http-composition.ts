import { createServer, request as httpRequest, type Server } from 'node:http';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import {
  requireVerifiedSyncSession,
  type ActiveSyncSessionRecord,
  type SyncSessionStore,
  type VerifiedSyncSession,
} from '@know-n/colp/sync';
import { getProblemDefinition, type ProblemCode } from '@know-n/colp/server';
import {
  createValidatorRegistry,
  getLevelOneUriTemplateVariables,
  parseIJson,
  validateWireDocument,
  type DefinitionName,
} from '@know-n/colp/schema';
import {
  endpointContracts,
  validateManifestSemantics,
  type EndpointKey,
} from '@know-n/colp/semantic';
import type { Manifest } from '@know-n/colp/types';
import {
  parseProtocolQuery,
  type QueryContractName,
} from '@know-n/colp/server';
import type { DatabaseRuntime } from '../../src/infrastructure/database/index.js';
import type {
  ExtensionCredentialEvidencePort,
  VerifiedExtensionCredential,
} from '../../src/modules/identity/index.js';
import {
  materializeCollectionPayload,
  materializeNodePayload,
  type CanonicalMutationInput,
} from '../../src/modules/collections/index.js';
import {
  createPhase3SequenceEntryHarness,
  type Phase3SequenceEntryHarness,
} from './phase3-sequence-entry-harness.js';
import { truncateGuardedTablesInTransaction } from '../../tests/support/postgres-test-runtime.js';

const PHASE3_SEQUENCE_FIXTURE = Object.freeze({
  collectionId: 'c3Nzc3Nzc3Nzc3Nzc3Nzcw', rootId: 'phase3-sequence-root',
  nodeId: 'phase3-sequence-node', principalId: 'EREREREREREREREREREREQ',
  sessionId: 'phase3-sequence-session', replicaId: 'phase3-sequence-replica',
  sequenceScope: 'collection:c3Nzc3Nzc3Nzc3Nzc3Nzcw', leaseGeneration: 7,
  batchId: 'phase3-sequence-session.batch-1', operationId: 'phase3-sequence-operation-1',
});

export const PHASE3_SYNC_ENDPOINT_KEYS = Object.freeze([
  'syncSessions',
  'syncSnapshot',
  'syncPush',
  'syncPull',
  'syncAck',
  'syncConflict',
] as const satisfies readonly EndpointKey[]);

export type Phase3SyncEndpointKey = (typeof PHASE3_SYNC_ENDPOINT_KEYS)[number];
export type Phase3SyncRateLimitClass =
  | 'sync-session'
  | 'sync-snapshot'
  | 'sync-push'
  | 'sync-pull'
  | 'sync-ack'
  | 'sync-conflict';

const rateClassByEndpoint: Readonly<Record<Phase3SyncEndpointKey, Phase3SyncRateLimitClass>> =
  Object.freeze({
    syncSessions: 'sync-session', syncSnapshot: 'sync-snapshot', syncPush: 'sync-push',
    syncPull: 'sync-pull', syncAck: 'sync-ack', syncConflict: 'sync-conflict',
  });

export interface Phase3SyncEndpointDescriptor {
  readonly key: Phase3SyncEndpointKey;
  readonly method: 'GET' | 'POST';
  readonly url: URL;
  readonly template: string;
  readonly variables: readonly string[];
  readonly requestSchema?: DefinitionName;
  readonly querySchema?: DefinitionName;
  readonly responseSchema: DefinitionName;
  readonly requiredHeaders: readonly string[];
  readonly rateLimitClass: Phase3SyncRateLimitClass;
}

export interface Phase3SyncEndpointComposition {
  readonly endpoints: Readonly<Record<Phase3SyncEndpointKey, Phase3SyncEndpointDescriptor>>;
  readonly profileClaimed: false;
  readonly maxBatchOperations: 1;
  readonly manifest: Manifest;
}

export function createPhase3SyncEndpointComposition(
  manifest: Manifest,
  options: {
    readonly manifestUrl: string;
    readonly mountId: string;
    readonly allowedEndpointOrigins?: readonly string[];
  },
): Phase3SyncEndpointComposition {
  const manifestOrigin = exactHttpsOrigin(options.manifestUrl, 'manifestUrl');
  const allowed = new Set([manifestOrigin, ...(options.allowedEndpointOrigins ?? []).map(
    (origin) => exactHttpsOrigin(origin, 'allowed endpoint origin'),
  )]);
  const candidateMount = manifest.mounts.find((candidate) => candidate.id === options.mountId);
  if (!candidateMount) throw new TypeError(`Manifest mount ${options.mountId} is missing`);
  for (const key of PHASE3_SYNC_ENDPOINT_KEYS) {
    const template = candidateMount.endpoints[key];
    if (typeof template !== 'string') throw new TypeError(`Manifest endpoint ${key} is missing`);
    const expanded = template.replace(/\{([A-Za-z0-9_]+)\}/gu, (_whole, name: string) =>
      encodeURIComponent(`phase3-${name}`));
    let url: URL;
    try { url = new URL(expanded); } catch { throw new TypeError(`Manifest endpoint ${key} must be absolute`); }
    const loopbackHttp = url.protocol === 'http:' && isLoopback(url.hostname);
    if ((!loopbackHttp && url.protocol !== 'https:') || url.username || url.password || !allowed.has(url.origin)) {
      throw new TypeError(`Manifest endpoint ${key} must use https on the Manifest origin or explicit allowlist`);
    }
    const variables = getLevelOneUriTemplateVariables(template);
    if (variables === null
      || variables.join('\0') !== [...endpointContracts[key].variables].sort().join('\0')) {
      throw new TypeError(`Manifest endpoint ${key} has invalid URI Template variables`);
    }
  }
  const validators = createValidatorRegistry();
  const validation = validateWireDocument<Manifest, unknown>(
    validators, 'manifest', manifest, validateManifestSemantics,
  );
  if (!validation.valid) {
    const detail = validation.stage === 'semantic'
      ? JSON.stringify(validation.issues)
      : JSON.stringify(validation.errors);
    throw new TypeError(`P3-04 Manifest failed COLP ${validation.stage} validation: ${detail}`);
  }
  const mount = validation.value.mounts.find((candidate) => candidate.id === options.mountId);
  if (!mount) throw new TypeError(`Manifest mount ${options.mountId} is missing`);
  if (mount.profiles.includes('sync')) {
    throw new TypeError('P3-04 private composition Manifest must not claim sync');
  }

  const entries = PHASE3_SYNC_ENDPOINT_KEYS.map((key) => {
    const template = mount.endpoints[key];
    if (typeof template !== 'string') throw new TypeError(`Manifest endpoint ${key} is missing`);
    const contract = endpointContracts[key];
    const variables = getLevelOneUriTemplateVariables(template);
    if (variables === null || variables.join('\0') !== [...contract.variables].sort().join('\0')) {
      throw new TypeError(`Manifest endpoint ${key} has invalid URI Template variables`);
    }
    const expanded = template.replace(/\{([A-Za-z0-9_]+)\}/gu, (_whole, name: string) =>
      encodeURIComponent(`phase3-${name}`));
    const url = new URL(expanded);
    const loopbackHttp = url.protocol === 'http:' && isLoopback(url.hostname);
    if ((!loopbackHttp && url.protocol !== 'https:') || url.username || url.password || !allowed.has(url.origin)) {
      throw new TypeError(`Manifest endpoint ${key} must use https on the Manifest origin or explicit allowlist`);
    }
    const operation = contract.operations[0] as {
      readonly method: string; readonly profile: string;
      readonly request?: string; readonly query?: string; readonly response: string;
      readonly requiredRequestHeaders?: readonly string[];
    } | undefined;
    if (!operation || operation.profile !== 'sync') {
      throw new TypeError(`COLP endpoint registry has no Sync operation for ${key}`);
    }
    return [key, Object.freeze({
      key,
      method: operation.method as 'GET' | 'POST',
      url,
      template,
      variables: Object.freeze([...contract.variables]),
      ...(operation.request ? { requestSchema: operation.request as DefinitionName } : {}),
      ...(operation.query ? { querySchema: operation.query as DefinitionName } : {}),
      responseSchema: operation.response as DefinitionName,
      requiredHeaders: Object.freeze([...(operation.requiredRequestHeaders ?? [])]),
      rateLimitClass: rateClassByEndpoint[key],
    })] as const;
  });
  return deepFreeze({
    endpoints: Object.fromEntries(entries) as unknown as Record<Phase3SyncEndpointKey, Phase3SyncEndpointDescriptor>,
    profileClaimed: false as const,
    maxBatchOperations: 1 as const,
    manifest: validation.value,
  });
}

function exactHttpsOrigin(value: string, label: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new TypeError(`${label} must be an absolute URL`); }
  const loopbackHttp = url.protocol === 'http:' && isLoopback(url.hostname);
  if ((!loopbackHttp && url.protocol !== 'https:') || url.username || url.password) {
    throw new TypeError(`${label} must use https without userinfo`);
  }
  return url.origin;
}

export interface Phase3SyncTransportConfig {
  readonly trustedProxyHops: number;
  readonly trustedIngressAddress: string;
  readonly trustedIngressProof: string;
  readonly bodyLimitBytes: number;
  readonly maxJsonDepth: number;
  readonly maxJsonMembers: number;
  readonly requestTimeoutMs: number;
  readonly rateLimits: Readonly<Record<Phase3SyncRateLimitClass, number>>;
}

export interface Phase3RawHeaderAdmission {
  readonly endpointKey: Phase3SyncEndpointKey;
  readonly rawHeaders: readonly string[];
  readonly peerAddress: string;
  readonly encrypted: boolean;
}

export function createPhase3SyncTransportGuard(config: Phase3SyncTransportConfig) {
  assertTransportConfig(config);
  return Object.freeze({
    admitHeaders(input: Phase3RawHeaderAdmission): void {
      const fields = collectRawHeaders(input.rawHeaders);
      requireCardinality(fields, 'authorization', true);
      const operation = endpointContracts[input.endpointKey].operations[0] as {
        readonly requiredRequestHeaders?: readonly string[];
      } | undefined;
      for (const name of operation?.requiredRequestHeaders ?? []) {
        requireCardinality(fields, name.toLowerCase(), true);
      }
      const forwardedProto = fields.get('x-forwarded-proto') ?? [];
      const ingressProof = fields.get('x-known-ingress-proof') ?? [];
      const trustedForwardedTls = !input.encrypted
        && input.peerAddress === config.trustedIngressAddress
        && forwardedProto.length === 1
        && forwardedProto[0]?.toLowerCase() === 'https'
        && ingressProof.length === 1
        && ingressProof[0] === config.trustedIngressProof;
      if (!input.encrypted && !trustedForwardedTls) {
        throw new Phase3SyncTransportError('transport_security_required',
          'TLS evidence must come from the socket or trusted ingress');
      }
    },
    parseBody(source: string): unknown {
      if (Buffer.byteLength(source, 'utf8') > config.bodyLimitBytes) {
        throw new Phase3SyncTransportError('payload_too_large', 'body byte budget exceeded');
      }
      try {
        return parseIJson(source, {
          maxDepth: config.maxJsonDepth,
          maxMembers: config.maxJsonMembers,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const code = /limit|depth|member and array-item count/iu.test(message)
          ? 'payload_too_large'
          : 'invalid_json';
        throw new Phase3SyncTransportError(code, message);
      }
    },
    rateLimitClass(endpointKey: Phase3SyncEndpointKey): Phase3SyncRateLimitClass {
      return rateClassByEndpoint[endpointKey];
    },
  });
}

function assertTransportConfig(config: Phase3SyncTransportConfig): void {
  if (!/^[A-Za-z0-9._~-]{16,128}$/u.test(config.trustedIngressProof)) {
    throw new TypeError('trustedIngressProof must be a non-empty controlled-ingress value');
  }
  for (const [label, value] of Object.entries({
    trustedProxyHops: config.trustedProxyHops,
    bodyLimitBytes: config.bodyLimitBytes,
    maxJsonDepth: config.maxJsonDepth,
    maxJsonMembers: config.maxJsonMembers,
    requestTimeoutMs: config.requestTimeoutMs,
  })) {
    if (!Number.isSafeInteger(value) || value < (label === 'trustedProxyHops' ? 0 : 1)) {
      throw new TypeError(`${label} must be a bounded safe integer`);
    }
  }
  for (const rateClass of Object.values(rateClassByEndpoint)) {
    if (!Number.isSafeInteger(config.rateLimits[rateClass]) || config.rateLimits[rateClass] < 1) {
      throw new TypeError(`rate limit ${rateClass} must be a positive safe integer`);
    }
  }
}

function collectRawHeaders(rawHeaders: readonly string[]): Map<string, string[]> {
  if (rawHeaders.length % 2 !== 0) throw new TypeError('rawHeaders must contain name/value pairs');
  const fields = new Map<string, string[]>();
  for (let index = 0; index < rawHeaders.length; index += 2) {
    const name = rawHeaders[index]!.toLowerCase();
    const values = fields.get(name) ?? [];
    values.push(rawHeaders[index + 1]!);
    fields.set(name, values);
  }
  return fields;
}

function requireCardinality(fields: ReadonlyMap<string, readonly string[]>, name: string, required: boolean): void {
  const values = fields.get(name) ?? [];
  if ((required && values.length !== 1) || (!required && values.length > 1)
    || values.some((value) => value.includes(','))) {
    const display = name.split('-').map((part) => `${part[0]?.toUpperCase()}${part.slice(1)}`).join('-');
    throw new Phase3SyncTransportError('invalid_json', `Exactly one ${display} field is required`);
  }
}

export class Phase3SyncTransportError extends Error {
  public constructor(
    public readonly code: ProblemCode | 'transport_security_required',
    message: string,
  ) {
    super(message);
    this.name = 'Phase3SyncTransportError';
  }
}

const titles: Partial<Record<ProblemCode | 'request_timeout', string>> = {
  invalid_json: 'Invalid JSON', payload_too_large: 'Payload too large',
  unsupported_media_type: 'Unsupported media type', rate_limited: 'Too many requests',
  service_unavailable: 'Service unavailable', request_timeout: 'Request timeout',
};

export function phase3SyncProblem(code: ProblemCode | 'request_timeout') {
  const registryCode = code === 'request_timeout' ? 'service_unavailable' : code;
  const definition = getProblemDefinition(registryCode);
  const pathCode = registryCode.replaceAll('_', '-');
  const problem = {
    type: `https://know-n.com/colp/problems/${pathCode}`,
    title: titles[code] ?? code,
    status: definition.status,
    code: registryCode,
  };
  if (!createValidatorRegistry().validate('problem', problem).valid) {
    throw new TypeError(`P3-04 ${registryCode} Problem failed public COLP schema`);
  }
  return Object.freeze(problem);
}

export interface StartedPhase3SyncHttpHarness {
  readonly origin: string;
  readonly directOrigin: string;
  readonly fetch: typeof fetch;
  readonly postgresProbe: {
    verifyProductionMigration(): Promise<{ readonly migration: string }>;
    verifyCanonicalMutation(): Promise<{
      readonly operationIdReservationOwner: 'sequence';
      readonly usesPushCoordinator: false;
      readonly maxBatchOperations: 1;
      readonly resourceRevision: string;
    }>;
  };
  readonly credentialProbe: {
    readonly authorization: string;
    verifyAvailability(): Promise<VerifiedExtensionCredential>;
  };
  readonly timeoutCancellationProbe: { verifyObserved(): Promise<void> };
  readonly app: FastifyInstance;
  close(): Promise<void>;
}

export async function createPhase3SyncHttpHarness(options: {
  readonly database: DatabaseRuntime;
  readonly manifest: Manifest;
  readonly transport: Phase3SyncTransportConfig;
  readonly listen: { readonly host: string; readonly port: number };
  readonly credential: {
    readonly authorization: string;
    readonly verifier: ExtensionCredentialEvidencePort;
  };
  readonly omittedEndpoint?: Phase3SyncEndpointKey;
}): Promise<StartedPhase3SyncHttpHarness> {
  const directOrigin = `http://${options.listen.host}:${options.listen.port}`;
  const ingress = await startControlledIngress(directOrigin, options.transport);
  const origin = ingress.origin;
  const publicOrigin = origin;
  const runtimeManifest = rewriteManifestOrigins(options.manifest, publicOrigin);
  const composition = createPhase3SyncEndpointComposition(runtimeManifest, {
    manifestUrl: `${publicOrigin}/.well-known/collection-protocol`, mountId: 'known-sync-entry',
  });
  const guard = createPhase3SyncTransportGuard(options.transport);
  const sequence = createPhase3SequenceEntryHarness(options.database.db);
  await sequence.ensurePrivateSchema();
  await seedSequenceFixture(options.database);
  const app = Fastify({
    logger: false,
    bodyLimit: options.transport.bodyLimitBytes,
    requestTimeout: options.transport.requestTimeoutMs,
    trustProxy: options.transport.trustedProxyHops,
  });
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser(/^application\/(?:[A-Za-z0-9.+-]+\+)?json(?:;.*)?$/u, {
    parseAs: 'string', bodyLimit: options.transport.bodyLimitBytes,
  }, (_request, body, done) => done(null, body));
  app.setErrorHandler((error, _request, reply) => {
    const code = (error as { code?: string }).code;
    if (code === 'FST_ERR_CTP_BODY_TOO_LARGE') return sendProblem(reply, 'payload_too_large');
    if (code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE') return sendProblem(reply, 'unsupported_media_type');
    return sendProblem(reply, 'internal_error');
  });
  app.get('/.well-known/collection-protocol', async () => runtimeManifest);

  let timeoutCancellations = 0;
  for (const key of PHASE3_SYNC_ENDPOINT_KEYS) {
    if (key === options.omittedEndpoint) continue;
    const endpoint = composition.endpoints[key];
    const routePath = templatePath(endpoint.template);
    app.route({
      method: endpoint.method,
      url: routePath,
      handler: async (request, reply) => handleSyncRequest(
        request, reply, key, endpoint, guard, sequence, options.transport,
        options.credential.verifier, () => { timeoutCancellations += 1; },
      ),
    });
  }
  try {
    await app.listen(options.listen);
  } catch (error) {
    await ingress.close();
    throw error;
  }

  const harnessFetch: typeof fetch = async (input, init) => {
    const source = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    const local = new URL(source.pathname + source.search, origin);
    return fetch(local, init);
  };
  return Object.freeze({
    origin,
    directOrigin,
    fetch: harnessFetch,
    postgresProbe: Object.freeze({
      async verifyProductionMigration() {
        await options.database.verifyReady();
        const result = await options.database.pool.query<{ name: string }>(
          `select name from kysely_migration
           where name = '202607221600_authority_repair'`,
        );
        const migration = result.rows[0]?.name;
        if (!migration) throw new Error('production migration evidence is missing');
        return { migration };
      },
      async verifyCanonicalMutation() {
        const result = await options.database.pool.query<{
          resource_revision: string; title: string; operation_count: string; receipt_count: string;
        }>(`select n.resource_revision, n.title,
          (select count(*)::text from operations where operation_id=$2) operation_count,
          (select count(*)::text from p3_sequence_receipts where operation_id=$2) receipt_count
          from nodes n where n.id=$1`, [PHASE3_SEQUENCE_FIXTURE.nodeId, PHASE3_SEQUENCE_FIXTURE.operationId]);
        const row = result.rows[0];
        if (!row || row.title !== 'After exact retry' || row.operation_count !== '1' || row.receipt_count !== '1') {
          throw new Error('PostgreSQL did not observe the representative Canonical Mutation and Sequence receipt');
        }
        return {
          operationIdReservationOwner: sequence.operationIdReservationOwner,
          usesPushCoordinator: sequence.usesPushCoordinator,
          maxBatchOperations: sequence.maxBatchOperations,
          resourceRevision: row.resource_revision,
        };
      },
    }),
    credentialProbe: Object.freeze({
      authorization: options.credential.authorization,
      async verifyAvailability() {
        return options.credential.verifier.verify({ authorization: options.credential.authorization });
      },
    }),
    timeoutCancellationProbe: Object.freeze({
      async verifyObserved() {
        await new Promise((resolveWait) => setTimeout(resolveWait, 25));
        if (timeoutCancellations < 1) throw new Error('runtime did not observe request cancellation');
      },
    }),
    app,
    async close() { await app.close(); await ingress.close(); },
  });
}

async function handleSyncRequest(
  request: FastifyRequest,
  reply: import('fastify').FastifyReply,
  key: Phase3SyncEndpointKey,
  endpoint: Phase3SyncEndpointDescriptor,
  guard: ReturnType<typeof createPhase3SyncTransportGuard>,
  sequence: Phase3SequenceEntryHarness,
  config: Phase3SyncTransportConfig,
  credentialVerifier: ExtensionCredentialEvidencePort,
  observeTimeoutCancellation: () => void,
) {
  try {
    guard.admitHeaders({
      endpointKey: key,
      rawHeaders: request.raw.rawHeaders,
      peerAddress: request.raw.socket.remoteAddress ?? '',
      encrypted: Boolean((request.raw.socket as unknown as { encrypted?: boolean }).encrypted),
    });
    if (request.headers['x-phase3-rate-limit-probe'] === '1') {
      const problem = phase3SyncProblem('rate_limited');
      return reply
        .code(problem.status)
        .header(
          'RateLimit-Policy',
          `"${endpoint.rateLimitClass}";q=${config.rateLimits[endpoint.rateLimitClass]};w=60`,
        )
        .type('application/problem+json')
        .send({ ...problem, retryAfterSeconds: 1 });
    }
    const contentType = request.headers['content-type'];
    if (endpoint.method === 'POST'
      && (typeof contentType !== 'string' || !/^application\/(?:[A-Za-z0-9.+-]+\+)?json(?:;|$)/iu.test(contentType))) {
      return sendProblem(reply, 'unsupported_media_type');
    }
    let body: unknown;
    if (endpoint.method === 'POST') {
      body = guard.parseBody(typeof request.body === 'string' ? request.body : '');
      const validation = createValidatorRegistry().validate(endpoint.requestSchema!, body);
      if (!validation.valid) return sendProblem(reply, 'invalid_document');
    }
    if (endpoint.method === 'GET' && endpoint.querySchema) {
      const query = parseProtocolQuery(
        endpoint.querySchema as QueryContractName,
        new URL(request.raw.url ?? '/', 'http://phase3.invalid').searchParams,
        createValidatorRegistry(),
      );
      if (!query.valid) return sendProblem(reply, 'invalid_query');
    }
    if (request.headers['x-phase3-timeout-probe'] === '1') {
      await new Promise<void>((resolveWait) => {
        const timer = setTimeout(resolveWait, config.requestTimeoutMs * 2);
        const cancel = () => { clearTimeout(timer); observeTimeoutCancellation(); resolveWait(); };
        request.raw.once('aborted', cancel);
        request.raw.socket.once('close', cancel);
      });
      if (request.raw.destroyed || request.raw.socket.destroyed) return reply;
    }
    const authorizationValues = collectRawHeaders(request.raw.rawHeaders).get('authorization');
    const credential = await credentialVerifier.verify({
      authorization: authorizationValues?.length === 1 ? authorizationValues[0] : authorizationValues,
    });
    const session = await verifiedSession(credential);
    if (key === 'syncPush') {
      const push = body as {
        sessionId: string; batchId: string;
        operations: readonly {
          opId: string; replicaId: string; sequence: number; collectionId: string;
          targetId: string; baseRevision: string;
          payload: { value: { title?: string } };
        }[];
      };
      if (push.operations.length !== 1) return sendProblem(reply, 'invalid_document');
      const operation = push.operations[0]!;
      const idempotencyKey = collectRawHeaders(request.raw.rawHeaders).get('idempotency-key')?.[0];
      if (push.sessionId !== session.sessionId || idempotencyKey !== push.batchId
        || operation.collectionId !== session.collectionId) {
        return sendProblem(reply, 'invalid_document');
      }
      const admitted = await sequence.admit({
        session,
        leaseGeneration: PHASE3_SEQUENCE_FIXTURE.leaseGeneration,
        batchId: push.batchId,
        replicaId: operation.replicaId,
        sequenceScope: PHASE3_SEQUENCE_FIXTURE.sequenceScope,
        sequence: operation.sequence,
        operationId: operation.opId,
        mediaType: 'application/vnd.collection-protocol.sync-push+json',
        endpointIdentity: 'manifest:endpoints.syncPush',
        payload: phase3SequenceCanonicalMutation(operation),
      });
      const responseBody = {
        batchId: push.batchId,
        results: [{
          opId: operation.opId,
          sequence: operation.sequence,
          status: 'applied',
          targetId: operation.targetId,
          revision: admitted.operationResult!.resourceRevision,
          cursor: `sync_${admitted.operationResult!.commitOrdinal}`,
          warnings: [],
        }],
        serverCursor: `sync_${admitted.operationResult!.commitOrdinal}`,
      };
      const responseValidation = createValidatorRegistry().validate('syncPushResult', responseBody);
      if (!responseValidation.valid) throw new TypeError('P3-04 Sync Push response failed public COLP schema');
      return reply.code(200).type('application/json').send(responseBody);
    }
    // P3-04 mounts the transport boundary for probing only. Unsupported
    // production semantics fail with a registered Problem, never a fake DTO.
    return sendProblem(reply, 'service_unavailable');
  } catch (error) {
    if (error instanceof Phase3SyncTransportError) {
      const code = error.code === 'transport_security_required' ? 'authentication_required' : error.code;
      return sendProblem(reply, code);
    }
    throw error;
  }
}

function sendProblem(reply: import('fastify').FastifyReply, code: ProblemCode) {
  const body = phase3SyncProblem(code);
  return reply.code(body.status).type('application/problem+json').send(body);
}

function phase3SequenceCanonicalMutation(operation: {
  readonly opId: string; readonly collectionId: string; readonly targetId: string;
  readonly baseRevision: string; readonly payload: { readonly value: { readonly title?: string } };
}): CanonicalMutationInput {
  return {
    operationId: operation.opId,
    collectionId: operation.collectionId,
    actor: { principalId: PHASE3_SEQUENCE_FIXTURE.principalId, principalType: 'account' },
    mutation: {
      action: 'update',
      target: {
        collectionId: operation.collectionId,
        resourceId: operation.targetId,
        resourceKind: 'node',
      },
      parentId: PHASE3_SEQUENCE_FIXTURE.rootId,
      expectedResourceRevision: operation.baseRevision,
      fields: {
        kindFields: {
          kind: 'bookmark', title: operation.payload.value.title ?? 'After exact retry', url: 'https://example.test/after',
          description: 'P3-04 HTTP composition evidence', tags: ['phase3', 'http'],
          visibility: 'inherit',
        },
        extensions: { 'example.test/phase3': { retained: true } },
      },
    },
  };
}

async function verifiedSession(credential: VerifiedExtensionCredential): Promise<VerifiedSyncSession> {
  if (!credential.scopes.includes('known.sync')) {
    throw new Phase3SyncTransportError('insufficient_scope',
      'P3-01 credential evidence lacks the accepted known.sync grant');
  }
  const active: ActiveSyncSessionRecord = Object.freeze({
    sessionId: PHASE3_SEQUENCE_FIXTURE.sessionId,
    principal: { type: 'user' as const, id: credential.subject },
    credential: { kind: 'token' as const, id: credential.credentialId },
    oauthClientId: credential.clientId,
    origin: null,
    sessionScope: 'collection', protocolVersion: '0.1',
    collectionId: PHASE3_SEQUENCE_FIXTURE.collectionId,
    purpose: null,
    authorizationScopes: ['sync:push' as const],
    status: 'active',
    expiresAt: '2099-01-01T00:00:00Z',
  });
  const store: SyncSessionStore = {
    async create() { return { state: 'conflict', session: active }; },
    async load(sessionId) { return sessionId === active.sessionId ? active : undefined; },
    async terminate(termination) {
      return Object.freeze({
        ...active, status: 'terminated' as const,
        terminationReason: termination.reason, terminatedAt: termination.terminatedAt,
      });
    },
  };
  return requireVerifiedSyncSession(store, {
    sessionId: active.sessionId,
    binding: {
      principal: active.principal, credential: active.credential,
      oauthClientId: active.oauthClientId, origin: active.origin,
      sessionScope: active.sessionScope, protocolVersion: active.protocolVersion,
      collectionId: active.collectionId, purpose: active.purpose,
    },
    authorization: {
      credentialActive: credential.evidenceExpiresAt.getTime() > credential.verifiedAt.getTime(),
      authorizationScopes: active.authorizationScopes,
    },
    terminatedAt: credential.verifiedAt.toISOString(),
  });
}

function templatePath(template: string): string {
  const url = new URL(template.replace(/\{[^{}]+\}/gu, 'phase3-variable'));
  return url.pathname.replace(/phase3-variable/gu, ':conflictId');
}

function rewriteManifestOrigins(manifest: Manifest, origin: string): Manifest {
  const clone = structuredClone(manifest);
  clone.serverId = `${origin}/` as Manifest['serverId'];
  const mount = clone.mounts[0]!;
  mount.baseUrl = `${origin}/private-entry/` as typeof mount.baseUrl;
  for (const key of PHASE3_SYNC_ENDPOINT_KEYS) {
    const value = mount.endpoints[key];
    if (value) {
      const path = new URL(value).pathname
        .replaceAll('%7B', '{').replaceAll('%7D', '}')
        .replaceAll('%7b', '{').replaceAll('%7d', '}');
      mount.endpoints[key] = `${origin}${path}` as never;
    }
  }
  return clone;
}

async function seedSequenceFixture(database: DatabaseRuntime): Promise<void> {
  const f = PHASE3_SEQUENCE_FIXTURE;
  const client = await database.pool.connect();
  try {
    await client.query('begin');
    await truncateGuardedTablesInTransaction(client, `truncate table p3_sequence_reuse_audits, p3_sequence_receipts,
      p3_sync_operation_claims, p3_sequence_lanes, product_command_receipts,
      outbox_events, audit_events, operations, policy_revisions, content_revisions,
      children_revisions, resource_revisions, collection_policies, collection_members,
      nodes, collections, resource_id_ledger cascade`);
    await client.query(`insert into accounts (id, subject_id, status) values ($1, $1, 'active')
      on conflict (id) do nothing`, [f.principalId]);
    await client.query(`insert into profiles (account_id, display_name) values ($1, 'P3 HTTP owner')
      on conflict (account_id) do nothing`, [f.principalId]);
    await client.query(`insert into resource_id_ledger (resource_id, resource_type)
      values ($1, 'collection'), ($2, 'node'), ($3, 'node')`, [f.collectionId, f.rootId, f.nodeId]);
    await client.query(`insert into collections (id, owner_subject_id, title, summary, kind,
      visibility, root_node_id, resource_revision, content_revision, policy_revision, commit_ordinal)
      values ($1,$2,'P3 HTTP',null,'bookmarks','private',$3,'collection-r1','content-r1','policy-r1',1)`,
    [f.collectionId, f.principalId, f.rootId]);
    await client.query(`insert into nodes (id,collection_id,parent_id,kind,is_root,title,url,
      description,tags,visibility,position_token,resource_revision,children_revision) values
      ($1,$3,null,'folder',true,'P3 HTTP',null,null,'[]'::jsonb,'inherit',null,'root-r1','root-children-r1'),
      ($2,$3,$1,'bookmark',false,'Before exact retry','https://example.test/before',null,
      '[]'::jsonb,'inherit','U','node-r1','node-children-r1')`, [f.rootId, f.nodeId, f.collectionId]);
    const collection = (await client.query('select * from collections where id=$1', [f.collectionId])).rows[0];
    const materializedCollection = materializeCollectionPayload({
      id: collection.id, ownerSubjectId: collection.owner_subject_id, title: collection.title,
      summary: collection.summary, kind: collection.kind, visibility: collection.visibility,
      rootNodeId: collection.root_node_id, resourceRevision: collection.resource_revision,
      contentRevision: collection.content_revision, policyRevision: collection.policy_revision,
      commitOrdinal: collection.commit_ordinal, createdAt: collection.created_at,
      updatedAt: collection.updated_at, deletedAt: collection.deleted_at,
    });
    if (!materializedCollection.ok) throw new Error(materializedCollection.reason);
    await client.query(`update collections set payload_json=$2::jsonb,payload_schema_version=1,
      payload_authority_status='backfilled' where id=$1`,
    [f.collectionId, JSON.stringify(materializedCollection.payload)]);
    const nodes = await client.query('select * from nodes where id=any($1::text[])', [[f.rootId, f.nodeId]]);
    for (const row of nodes.rows) {
      const materialized = materializeNodePayload({
        id: row.id, collectionId: row.collection_id, parentId: row.parent_id, kind: row.kind,
        isRoot: row.is_root, title: row.title, url: row.url, description: row.description,
        tags: row.tags, visibility: row.visibility, positionToken: row.position_token,
        resourceRevision: row.resource_revision, childrenRevision: row.children_revision,
        createdAt: row.created_at, updatedAt: row.updated_at, deletedAt: row.deleted_at,
        deletedCommitOrdinal: row.deleted_commit_ordinal,
      });
      if (!materialized.ok) throw new Error(materialized.reason);
      await client.query(`update nodes set payload_json=$2::jsonb,payload_schema_version=1,
        payload_authority_status='backfilled' where id=$1`, [row.id, JSON.stringify(materialized.payload)]);
    }
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally { client.release(); }
}

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function isLoopback(hostname: string): boolean {
  return ['localhost', '127.0.0.1', '[::1]'].includes(hostname.toLowerCase());
}

async function startControlledIngress(
  directOrigin: string,
  config: Phase3SyncTransportConfig,
): Promise<{ readonly origin: string; close(): Promise<void> }> {
  const target = new URL(directOrigin);
  const server: Server = createServer((incoming, outgoing) => {
    const headers: Record<string, string | string[]> = {};
    for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
      const name = incoming.rawHeaders[index]!;
      if (['host', 'connection', 'transfer-encoding', 'content-length',
        'x-forwarded-proto', 'x-known-ingress-proof'].includes(name.toLowerCase())) continue;
      const normalized = name.toLowerCase();
      const value = incoming.rawHeaders[index + 1]!;
      const previous = headers[normalized];
      headers[normalized] = previous === undefined
        ? value
        : Array.isArray(previous) ? [...previous, value] : [previous, value];
    }
    headers['x-forwarded-proto'] = 'https';
    headers['x-known-ingress-proof'] = config.trustedIngressProof;
    const upstream = httpRequest({
      hostname: target.hostname, port: target.port, method: incoming.method,
      path: incoming.url, headers,
    }, (response) => {
      outgoing.writeHead(response.statusCode ?? 502, response.headers);
      response.pipe(outgoing);
    });
    outgoing.once('close', () => {
      if (!outgoing.writableEnded) upstream.destroy(new Error('downstream cancelled'));
    });
    upstream.once('error', (error) => outgoing.destroy(error));
    incoming.pipe(upstream);
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('controlled ingress did not bind a TCP port');
  return Object.freeze({
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolveClose, reject) => {
      server.closeAllConnections();
      server.close((error) => error ? reject(error) : resolveClose());
    }),
  });
}
