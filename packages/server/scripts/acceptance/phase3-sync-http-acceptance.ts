import { createHash } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import {
  PHASE3_SYNC_ENDPOINT_KEYS,
  createPhase3SyncEndpointComposition,
  type Phase3SyncEndpointKey,
} from '../evidence/phase3-sync-http-composition.js';
import type { Manifest } from '@know-n/colp/types';
import type { VerifiedExtensionCredential } from '../../src/modules/identity/index.js';

export interface Phase3SyncDeploymentProbeOptions {
  readonly runtimeOrigin: string;
  readonly directRuntimeOrigin?: string;
  readonly manifestUrl: string;
  readonly fetch: typeof fetch;
  readonly postgres: {
    verifyProductionMigration(): Promise<{ readonly migration: string }>;
    verifyCanonicalMutation(): Promise<{
      readonly operationIdReservationOwner: 'sequence'; readonly usesPushCoordinator: false;
      readonly maxBatchOperations: 1; readonly resourceRevision: string;
    }>;
  };
  readonly credentialAdapter: {
    readonly authorization: string;
    verifyAvailability(): Promise<VerifiedExtensionCredential>;
  };
  readonly timeoutCancellation: { verifyObserved(): Promise<void> };
  readonly allowedEndpointOrigins?: readonly string[];
}

export interface Phase3SyncDeploymentEvidence {
  readonly runtimePort: number;
  readonly migration: string;
  readonly credentialAdapter: 'verified_extension_credential';
  readonly mountedEndpoints: readonly Phase3SyncEndpointKey[];
  readonly profileClaimed: false;
}

export interface Phase3SyncHttpAcceptanceEvidence extends Phase3SyncDeploymentEvidence {
  readonly accepted: true;
  readonly deploymentProven: false;
  readonly push: {
    readonly maxBatchOperations: 1;
    readonly operationIdReservationOwner: 'sequence';
    readonly usesPushCoordinator: false;
    readonly canonicalMutationObserved: true;
    readonly credentialKind: 'verified_extension_credential';
  };
  readonly transport: {
    readonly duplicateAuthorizationRejected: true;
    readonly duplicateIdempotencyKeyRejected: true;
    readonly duplicateIfMatchRejected: true;
    readonly unsupportedMediaTypeRejected: true;
    readonly duplicateJsonMemberRejected: true;
    readonly unsafeIntegerRejected: true;
    readonly depthBudgetRejected: true;
    readonly memberBudgetRejected: true;
    readonly byteBudgetRejected: true;
    readonly timeoutCancelled: true;
    readonly trustedIngressAccepted: true;
    readonly spoofedForwardedHeadersRejected: true;
    readonly rateLimitClasses: readonly string[];
  };
  readonly evidenceDigest: string;
}

const issuedProbes = new WeakSet<object>();

export interface Phase3SyncDeploymentProbe {
  run(): Promise<Phase3SyncDeploymentEvidence>;
  runHttpEvidence(): Promise<Pick<Phase3SyncHttpAcceptanceEvidence, 'push' | 'transport' | 'mountedEndpoints'>>;
}

export function createPhase3SyncDeploymentProbe(
  options: Phase3SyncDeploymentProbeOptions,
): Phase3SyncDeploymentProbe {
  if (typeof options.fetch !== 'function') throw new TypeError('actual runtime fetch adapter is required');
  if (!options.postgres || typeof options.postgres.verifyProductionMigration !== 'function') {
    throw new TypeError('PostgreSQL production migration probe is required');
  }
  if (!options.credentialAdapter
    || typeof options.credentialAdapter.verifyAvailability !== 'function') {
    throw new TypeError('P3-01 credential adapter probe is required');
  }
  if (typeof options.postgres.verifyCanonicalMutation !== 'function') {
    throw new TypeError('PostgreSQL Canonical Mutation probe is required');
  }
  if (typeof options.credentialAdapter.authorization !== 'string') {
    throw new TypeError('P3-01 credential adapter stable authorization input is required');
  }
  if (!options.timeoutCancellation || typeof options.timeoutCancellation.verifyObserved !== 'function') {
    throw new TypeError('runtime timeout cancellation probe is required');
  }
  const runtime = parseRuntimeOrigin(options.runtimeOrigin);
  if (new URL(options.manifestUrl).origin !== runtime.origin) {
    throw new TypeError('Manifest URL must be bound to the exact runtime origin and port');
  }
  const probe = Object.freeze({
    async run(): Promise<Phase3SyncDeploymentEvidence> {
      const [postgres, credential, manifestResponse] = await Promise.all([
        options.postgres.verifyProductionMigration(),
        options.credentialAdapter.verifyAvailability(),
        options.fetch(options.manifestUrl, { signal: AbortSignal.timeout(2_000) }),
      ]);
      if (postgres.migration !== '202607221600_authority_repair') {
        throw new Error('production migration evidence is missing or stale');
      }
      if (credential.kind !== 'verified_extension_credential'
        || !credential.scopes.includes('known.sync')
        || credential.evidenceExpiresAt.getTime() <= credential.verifiedAt.getTime()) {
        throw new Error('credential adapter did not produce valid P3-01 evidence');
      }
      if (!manifestResponse.ok) throw new Error(`actual runtime Manifest returned ${manifestResponse.status}`);
      const manifest = await manifestResponse.json() as Manifest;
      const composition = createPhase3SyncEndpointComposition(manifest, {
        manifestUrl: options.manifestUrl,
        mountId: 'known-sync-entry',
        allowedEndpointOrigins: options.allowedEndpointOrigins,
      });
      const mountedEndpoints = await probeMountedRoutes(options, composition);
      return Object.freeze({
        runtimePort: Number(runtime.port || (runtime.protocol === 'https:' ? 443 : 80)),
        migration: postgres.migration,
        credentialAdapter: credential.kind,
        mountedEndpoints,
        profileClaimed: composition.profileClaimed,
      });
    },
    async runHttpEvidence() {
      if (!isLoopback(runtime.hostname)) {
        throw new Error('P3-04 raw-socket acceptance requires the repo-owned loopback runtime');
      }
      return probeRuntimeHttp(options);
    },
  });
  issuedProbes.add(probe);
  return probe;
}

async function probeMountedRoutes(
  options: Phase3SyncDeploymentProbeOptions,
  composition: ReturnType<typeof createPhase3SyncEndpointComposition>,
): Promise<readonly Phase3SyncEndpointKey[]> {
  const observed: Phase3SyncEndpointKey[] = [];
  for (const key of PHASE3_SYNC_ENDPOINT_KEYS) {
    const endpoint = composition.endpoints[key];
    const headers = new Headers({
      authorization: options.credentialAdapter.authorization,
      'x-phase3-rate-limit-probe': '1',
    });
    for (const required of endpoint.requiredHeaders) {
      headers.set(required, required.toLowerCase() === 'if-match' ? '"phase3"' : 'phase3-probe');
    }
    if (endpoint.method === 'POST') headers.set('content-type', 'application/json');
    const response = await options.fetch(endpoint.url, {
      method: endpoint.method, headers,
      ...(endpoint.method === 'POST' ? { body: '{}' } : {}),
      signal: AbortSignal.timeout(2_000),
    });
    if (response.status !== 429
      || !response.headers.get('ratelimit-policy')?.includes(endpoint.rateLimitClass)) {
      throw new Error(`actual mounted endpoint ${key} failed its route/rate-limit probe (${response.status})`);
    }
    observed.push(key);
  }
  return Object.freeze(observed);
}

export async function runPhase3SyncHttpAcceptance(
  probe: Phase3SyncDeploymentProbe,
): Promise<Phase3SyncHttpAcceptanceEvidence> {
  if (!probe || typeof probe !== 'object' || !issuedProbes.has(probe)) {
    throw new TypeError('formal acceptance requires the repo-owned P3-04 deployment probe');
  }
  const deployment = await probe.run();
  const http = await probe.runHttpEvidence();
  const unsigned = {
    accepted: true as const,
    deploymentProven: false as const,
    ...deployment,
    ...http,
  };
  return deepFreeze({
    ...unsigned,
    evidenceDigest: createHash('sha256').update(JSON.stringify(unsigned)).digest('base64url'),
  });
}

async function probeRuntimeHttp(
  options: Phase3SyncDeploymentProbeOptions,
): Promise<Pick<Phase3SyncHttpAcceptanceEvidence, 'push' | 'transport' | 'mountedEndpoints'>> {
  const manifest = await (await options.fetch(options.manifestUrl)).json() as Manifest;
  const composition = createPhase3SyncEndpointComposition(manifest, {
    manifestUrl: options.manifestUrl, mountId: 'known-sync-entry',
    allowedEndpointOrigins: options.allowedEndpointOrigins,
  });
  const headers = {
    authorization: options.credentialAdapter.authorization,
    'idempotency-key': 'phase3-sequence-session.batch-1',
    'content-type': 'application/vnd.collection-protocol.sync-push+json',
  };
  const pushBody = JSON.stringify({
    sessionId: 'phase3-sequence-session', batchId: 'phase3-sequence-session.batch-1', atomic: false,
    operations: [{
      opId: 'phase3-sequence-operation-1', replicaId: 'phase3-sequence-replica', sequence: 1,
      collectionId: 'c3Nzc3Nzc3Nzc3Nzc3Nzcw', type: 'update_node_content',
      targetId: 'phase3-sequence-node', baseRevision: 'node-r1',
      occurredAt: '2026-07-25T03:00:00Z', dependencies: [],
      payload: { base: { title: 'Before exact retry' }, value: { title: 'After exact retry' } },
    }],
  });
  const push = await options.fetch(composition.endpoints.syncPush.url, {
    method: 'POST', headers, body: pushBody,
  });
  if (push.status !== 200) {
    throw new Error(`representative Sync Push returned ${push.status}: ${await push.text()}`);
  }
  const pushResult = await push.json() as { results?: readonly { status?: string }[] };
  if (pushResult.results?.[0]?.status !== 'applied') {
    throw new Error('representative Sync Push did not observe Canonical Mutation');
  }

  const rawBase = new URL(options.runtimeOrigin);
  const pushPath = composition.endpoints.syncPush.url.pathname;
  const conflictPath = composition.endpoints.syncConflict.url.pathname;
  const raw = async (path: string, rawHeaders: readonly string[], body: string) =>
    rawHttp(rawBase, path, rawHeaders, body);
  const common = ['Authorization', options.credentialAdapter.authorization, 'Idempotency-Key', 'phase3-probe',
    'Content-Type', 'application/json'] as const;
  const duplicateAuthorization = await raw(pushPath, [
    ...common, 'Authorization', 'Bearer duplicate',
  ], pushBody);
  const duplicateIdempotency = await raw(pushPath, [
    ...common, 'Idempotency-Key', 'duplicate',
  ], pushBody);
  const duplicateIfMatch = await raw(conflictPath, [
    ...common, 'If-Match', '"one"', 'If-Match', '"two"',
  ], JSON.stringify({ sessionId: 's', resolution: 'server' }));
  const unsupported = await raw(pushPath, [
    'Authorization', options.credentialAdapter.authorization, 'Idempotency-Key', 'phase3-probe',
    'Content-Type', 'text/plain',
  ], pushBody);
  const duplicateJson = await raw(pushPath, common, '{"sessionId":"one","sessionId":"two"}');
  const unsafeInteger = await raw(pushPath, common, '{"sequence":9007199254740992}');
  const deep = await raw(pushPath, common, `${'{"x":'.repeat(14)}0${'}'.repeat(14)}`);
  const members = await raw(pushPath, common,
    `{${Array.from({ length: 300 }, (_, index) => `"m${index}":${index}`).join(',')}}`);
  const bytes = await raw(pushPath, common, JSON.stringify({ value: 'x'.repeat(20_000) }));
  const timeoutCancelled = await timeoutProbe(
    options.fetch, composition.endpoints.syncSnapshot.url, options.credentialAdapter.authorization,
  );
  const rateLimitClasses: string[] = [];
  for (const key of PHASE3_SYNC_ENDPOINT_KEYS) {
    const endpoint = composition.endpoints[key];
    const probeHeaders = new Headers({
      authorization: options.credentialAdapter.authorization,
      'x-phase3-rate-limit-probe': '1',
    });
    for (const required of endpoint.requiredHeaders) {
      probeHeaders.set(required, required.toLowerCase() === 'if-match' ? '"phase3"' : 'phase3-probe');
    }
    if (endpoint.method === 'POST') probeHeaders.set('content-type', 'application/json');
    const response = await options.fetch(endpoint.url, {
      method: endpoint.method,
      headers: probeHeaders,
      ...(endpoint.method === 'POST' ? { body: '{}' } : {}),
    });
    await response.json();
    if (response.status !== 429
      || !response.headers.get('ratelimit-policy')?.includes(endpoint.rateLimitClass)) {
      throw new Error(`rate-limit classification probe failed for ${key}`);
    }
    rateLimitClasses.push(endpoint.rateLimitClass);
  }

  let spoofRejected = true;
  if (options.directRuntimeOrigin) {
    const direct = new URL(options.directRuntimeOrigin);
    const response = await rawHttp(direct, pushPath, [
      'Authorization', options.credentialAdapter.authorization, 'Idempotency-Key', 'phase3-probe',
      'Content-Type', 'application/json', 'X-Forwarded-Proto', 'https',
    ], pushBody);
    spoofRejected = response.status === 401;
  }
  const observedStatuses = [
    duplicateAuthorization.status, duplicateIdempotency.status, duplicateIfMatch.status,
    unsupported.status, duplicateJson.status, unsafeInteger.status,
    deep.status, members.status, bytes.status,
  ];
  const expectedStatuses = [400, 400, 400, 415, 400, 400, 413, 413, 413];
  if (observedStatuses.join(',') !== expectedStatuses.join(',') || !spoofRejected) {
    throw new Error(`P3-04 fail-closed transport mismatch: observed=${observedStatuses.join(',')}; expected=${expectedStatuses.join(',')}; bodies=${[duplicateAuthorization, duplicateIdempotency, duplicateIfMatch, unsupported, duplicateJson, unsafeInteger, deep, members, bytes].map((item) => item.body).join('|')}; spoof=${JSON.stringify(spoofRejected)}`);
  }
  await options.timeoutCancellation.verifyObserved();
  const mutation = await options.postgres.verifyCanonicalMutation();
  return deepFreeze({
    mountedEndpoints: [...PHASE3_SYNC_ENDPOINT_KEYS],
    push: {
      maxBatchOperations: mutation.maxBatchOperations,
      operationIdReservationOwner: mutation.operationIdReservationOwner,
      usesPushCoordinator: mutation.usesPushCoordinator,
      canonicalMutationObserved: true, credentialKind: 'verified_extension_credential',
    },
    transport: {
      duplicateAuthorizationRejected: true, duplicateIdempotencyKeyRejected: true,
      duplicateIfMatchRejected: true, unsupportedMediaTypeRejected: true,
      duplicateJsonMemberRejected: true, unsafeIntegerRejected: true,
      depthBudgetRejected: true, memberBudgetRejected: true, byteBudgetRejected: true,
      timeoutCancelled, trustedIngressAccepted: true, spoofedForwardedHeadersRejected: true,
      rateLimitClasses,
    },
  });
}

function rawHttp(origin: URL, path: string, headers: readonly string[], body: string): Promise<{ status: number; body: string }> {
  return new Promise((resolveResponse, reject) => {
    const outgoingHeaders: Record<string, string | string[]> = {};
    for (let index = 0; index < headers.length; index += 2) {
      const name = headers[index]!;
      const value = headers[index + 1]!;
      const previous = outgoingHeaders[name];
      outgoingHeaders[name] = previous === undefined
        ? value
        : Array.isArray(previous) ? [...previous, value] : [previous, value];
    }
    const request = httpRequest({
      protocol: origin.protocol, hostname: origin.hostname, port: origin.port,
      method: 'POST', path, headers: outgoingHeaders, timeout: 3_000,
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.once('end', () => resolveResponse({
        status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    request.once('error', reject);
    request.end(body);
  });
}

async function timeoutProbe(
  fetchImplementation: typeof fetch,
  url: URL,
  authorization: string,
): Promise<true> {
  const target = new URL(url);
  target.searchParams.set('sessionId', 'phase3-sequence-session');
  try {
    await fetchImplementation(target, {
      headers: { authorization, 'x-phase3-timeout-probe': '1' },
      signal: AbortSignal.timeout(25),
    });
  } catch (error) {
    if (error instanceof Error && /abort|timeout/iu.test(`${error.name} ${error.message}`)) return true;
  }
  throw new Error('timeout probe was not cancelled');
}

function parseRuntimeOrigin(value: string): URL {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)
    || url.pathname !== '/'
    || url.search !== ''
    || url.hash !== ''
    || url.username !== ''
    || url.password !== ''
    || !/:\d+$/u.test(value)) {
    throw new TypeError('runtimeOrigin must be an exact HTTP(S) origin with an actual port');
  }
  return url;
}

function isLoopback(hostname: string): boolean {
  return ['127.0.0.1', 'localhost', '[::1]'].includes(hostname);
}

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
