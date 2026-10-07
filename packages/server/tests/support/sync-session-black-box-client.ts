import {
  createValidatorRegistry,
  getLevelOneUriTemplateVariables,
  validateWireDocument,
} from '@know-n/colp/schema';
import { endpointContracts, validateEndpointVariables, validateManifestSemantics } from '@know-n/colp/semantic';
import type {
  ConflictResolutionRequest,
  ConflictResolutionResult,
  Manifest,
  Problem,
  Snapshot,
  SyncSnapshotV02,
  SyncAckRequest,
  SyncAckResult,
  SyncPull,
  SyncPullV02,
  SyncPush,
  SyncPushResult,
  SyncSessionRequest,
  SyncSessionRequestV02,
  SyncSessionResult,
  SyncSessionResultV02,
} from '@know-n/colp/types';

export interface SyncSessionBlackBoxClientOptions {
  readonly manifestUrl: string;
  readonly mountId: string;
  readonly authorization: string;
  readonly origin: string;
  readonly fetch?: typeof globalThis.fetch;
}

/** Protocol-only client: it deliberately has no backend application or Fastify dependency. */
export function createSyncSessionBlackBoxClient(options: SyncSessionBlackBoxClientOptions) {
  const transport = options.fetch ?? globalThis.fetch;
  return Object.freeze({
    async create<Request extends SyncSessionRequest | SyncSessionRequestV02>(input: {
      readonly idempotencyKey: string;
      readonly request: Request;
    }): Promise<{ readonly status: number; readonly body: Request extends SyncSessionRequestV02
      ? SyncSessionResultV02 : SyncSessionResult }> {
      const manifestResponse = await transport(options.manifestUrl, {
        redirect: 'error',
        headers: {
          Accept: 'application/vnd.collection-protocol.manifest+json;version=0.1',
          'Collection-Protocol-Version': '0.1',
        },
      });
      if (!manifestResponse.ok) throw new Error('Manifest discovery failed');
      const manifestDocument: unknown = await manifestResponse.json();
      const manifest = validateWireDocument<Manifest, unknown>(
        createValidatorRegistry(),
        'manifest',
        manifestDocument,
        validateManifestSemantics,
      );
      if (!manifest.valid) throw new Error('Manifest is not a valid COLP document');
      const mount = manifest.value.mounts.find((candidate) => candidate.id === options.mountId);
      const endpoint = mount?.endpoints.syncSessions;
      if (typeof endpoint !== 'string') throw new Error('Manifest does not expose syncSessions');
      if (mount.profiles.includes('sync')) {
        throw new Error('P3-08 discovery fixture must not claim the incomplete sync Profile');
      }
      const endpointUrl = new URL(endpoint);
      const manifestUrl = new URL(options.manifestUrl);
      if (endpointUrl.origin !== manifestUrl.origin || endpointUrl.username || endpointUrl.password) {
        throw new Error('Cross-origin syncSessions endpoint is not allowed by this client');
      }
      const contract = endpointContracts.syncSessions.operations[0];
      if (contract?.method !== 'POST' || contract.request !== 'syncSessionRequest'
          || contract.response !== 'syncSessionResult' || !contract.successStatuses.includes(201)
          || !contract.requiredRequestHeaders?.includes('Idempotency-Key')) {
        throw new Error('Public syncSessions endpoint contract is incompatible');
      }
      const response = await transport(endpointUrl, {
        method: contract.method,
        redirect: 'error',
        headers: {
          Accept: 'application/json',
          Authorization: options.authorization,
          Origin: options.origin,
          'Content-Type': 'application/json',
          'Idempotency-Key': input.idempotencyKey,
        },
        body: JSON.stringify(input.request),
      });
      if (!contract.successStatuses.includes(response.status)) {
        throw new Error(`syncSessions returned unexpected status ${response.status}`);
      }
      if (!/^application\/json(?:\s*;|$)/iu.test(response.headers.get('content-type') ?? '')) {
        throw new Error('syncSessions returned an unexpected media type');
      }
      const document: unknown = await response.json();
      const definition = input.request.protocolVersion === '0.2' ? 'syncSessionResultV02' : contract.response;
      const result = createValidatorRegistry().validate(definition, document);
      if (!result.valid) throw new Error('syncSessions returned an invalid COLP response');
      if (!validSessionSemantics(document as SyncSessionResult, input.request)) {
        throw new Error('syncSessions returned a semantically invalid COLP response');
      }
      return Object.freeze({ status: response.status,
        body: document as Request extends SyncSessionRequestV02 ? SyncSessionResultV02 : SyncSessionResult });
    },
    async snapshot(input: { readonly sessionId: string; readonly pageCursor?: string; readonly limit?: number }): Promise<Snapshot | SyncSnapshotV02> {
      const manifestResponse = await transport(options.manifestUrl, { redirect: 'error', headers: { Accept: 'application/vnd.collection-protocol.manifest+json;version=0.1', 'Collection-Protocol-Version': '0.1' } });
      const manifestDocument: unknown = await manifestResponse.json();
      const manifest = validateWireDocument<Manifest, unknown>(createValidatorRegistry(), 'manifest', manifestDocument, validateManifestSemantics);
      if (!manifest.valid) throw new Error('Manifest is not a valid COLP document');
      const mount = manifest.value.mounts.find((candidate) => candidate.id === options.mountId);
      const endpoint = mount?.endpoints.syncSnapshot;
      if (typeof endpoint !== 'string') throw new Error('Manifest does not expose syncSnapshot');
      if (mount.profiles.includes('sync')) throw new Error('P3-09 must not claim the incomplete sync Profile');
      const endpointUrl = new URL(endpoint);
      if (endpointUrl.origin !== new URL(options.manifestUrl).origin) throw new Error('Cross-origin syncSnapshot endpoint is not allowed');
      endpointUrl.searchParams.set('sessionId', input.sessionId);
      if (input.pageCursor) endpointUrl.searchParams.set('pageCursor', input.pageCursor);
      if (input.limit !== undefined) endpointUrl.searchParams.set('limit', String(input.limit));
      const response = await transport(endpointUrl, { redirect: 'error', headers: { Accept: 'application/json',
        Authorization: options.authorization, Origin: options.origin,
        'Known-Sync-Session': input.sessionId } });
      if (response.status !== 200) {
        let code = 'invalid_problem';
        try {
          const problem = await response.json() as { readonly code?: unknown };
          if (typeof problem.code === 'string') code = problem.code;
        } catch { /* only the low-sensitivity registered code is reported */ }
        throw new Error(`syncSnapshot returned unexpected status ${response.status} (${code})`);
      }
      const document: unknown = await response.json();
      const result = createValidatorRegistry().validate(
        (document as { readonly protocolVersion?: unknown })?.protocolVersion === '0.2'
          ? 'syncSnapshotV02' : 'snapshot', document);
      if (!result.valid || (document as Snapshot).mode !== 'sync') throw new Error('syncSnapshot returned an invalid COLP Snapshot');
      return document as Snapshot | SyncSnapshotV02;
    },
    async push(input: {
      readonly idempotencyKey: string;
      readonly request: SyncPush;
    }): Promise<{ readonly status: number; readonly body: Problem | SyncPushResult }> {
      const requestValidation = createValidatorRegistry().validate(
        'syncPush', JSON.parse(JSON.stringify(input.request)) as unknown,
      );
      if (!requestValidation.valid) {
        throw new Error(`syncPush request failed local COLP validation: ${requestValidation.errors
          .map(({ instancePath, keyword }) => `${instancePath}:${keyword}`).join(',')}`);
      }
      const manifestResponse = await transport(options.manifestUrl, {
        redirect: 'error',
        headers: {
          Accept: 'application/vnd.collection-protocol.manifest+json;version=0.1',
          'Collection-Protocol-Version': '0.1',
        },
      });
      if (!manifestResponse.ok) throw new Error('Manifest discovery failed');
      const manifestDocument: unknown = await manifestResponse.json();
      const manifest = validateWireDocument<Manifest, unknown>(
        createValidatorRegistry(), 'manifest', manifestDocument, validateManifestSemantics,
      );
      if (!manifest.valid) throw new Error('Manifest is not a valid COLP document');
      const mount = manifest.value.mounts.find((candidate) => candidate.id === options.mountId);
      const endpoint = mount?.endpoints.syncPush;
      if (typeof endpoint !== 'string') throw new Error('Manifest does not expose syncPush');
      if (mount.profiles.includes('sync')) throw new Error('P3-11 must not claim the incomplete sync Profile');
      const endpointUrl = new URL(endpoint);
      const manifestUrl = new URL(options.manifestUrl);
      if (endpointUrl.origin !== manifestUrl.origin || endpointUrl.username || endpointUrl.password) {
        throw new Error('Cross-origin syncPush endpoint is not allowed by this client');
      }
      const contract = endpointContracts.syncPush.operations[0];
      if (contract?.method !== 'POST' || contract.request !== 'syncPush'
          || contract.response !== 'syncPushResult' || !contract.successStatuses.includes(200)
          || !contract.requiredRequestHeaders?.includes('Idempotency-Key')) {
        throw new Error('Public syncPush endpoint contract is incompatible');
      }
      const response = await transport(endpointUrl, {
        method: contract.method,
        redirect: 'error',
        headers: {
          Accept: 'application/json',
          Authorization: options.authorization,
          Origin: options.origin,
          'Content-Type': 'application/json',
          'Idempotency-Key': input.idempotencyKey,
        },
        body: JSON.stringify(input.request),
      });
      const contentType = response.headers.get('content-type') ?? '';
      const document: unknown = await response.json();
      if (response.status === 200) {
        if (!/^application\/json(?:\s*;|$)/iu.test(contentType)) {
          throw new Error('syncPush success returned an unexpected media type');
        }
        const validation = createValidatorRegistry().validate('syncPushResult', document);
        if (!validation.valid) throw new Error('syncPush returned an invalid COLP result');
        const result = document as SyncPushResult;
        if (result.results.length !== 1
            || result.results[0]?.opId !== input.request.operations[0]?.opId
            || result.results[0]?.sequence !== input.request.operations[0]?.sequence) {
          throw new Error('syncPush result identity does not match the request');
        }
        return Object.freeze({ status: response.status, body: result });
      }
      if (!/^application\/problem\+json(?:\s*;|$)/iu.test(contentType)) {
        throw new Error('syncPush denial returned an unexpected media type');
      }
      const validation = createValidatorRegistry().validate('problem', document);
      if (!validation.valid) throw new Error('syncPush admission returned an invalid COLP Problem');
      return Object.freeze({ status: response.status, body: document as Problem });
    },
    async pull(input: {
      readonly sessionId: string;
      readonly cursor: string;
      readonly limit?: number;
      readonly signal?: AbortSignal;
    }): Promise<SyncPull | SyncPullV02> {
      const manifestResponse = await transport(options.manifestUrl, {
        redirect: 'error', headers: { Accept: 'application/vnd.collection-protocol.manifest+json;version=0.1',
          'Collection-Protocol-Version': '0.1' },
      });
      if (!manifestResponse.ok) throw new Error('Manifest discovery failed');
      const validators = createValidatorRegistry();
      const manifestDocument: unknown = await manifestResponse.json();
      const manifest = validateWireDocument<Manifest, unknown>(
        validators, 'manifest', manifestDocument, validateManifestSemantics,
      );
      if (!manifest.valid) throw new Error('Manifest is not a valid COLP document');
      const mount = manifest.value.mounts.find((candidate) => candidate.id === options.mountId);
      const endpoint = mount?.endpoints.syncPull;
      if (typeof endpoint !== 'string') throw new Error('Manifest does not expose syncPull');
      if (mount.profiles.includes('sync')) throw new Error('P3-21 must not claim the incomplete sync Profile');
      const endpointUrl = new URL(endpoint);
      const manifestUrl = new URL(options.manifestUrl);
      if (endpointUrl.origin !== manifestUrl.origin || endpointUrl.username || endpointUrl.password
          || endpointUrl.hash || endpointUrl.search) {
        throw new Error('syncPull endpoint is not an allowed absolute URL');
      }
      const contract = endpointContracts.syncPull.operations[0];
      if (contract?.method !== 'GET' || contract.query !== 'syncPullQuery'
          || contract.response !== 'syncPull' || !contract.successStatuses.includes(200)) {
        throw new Error('Public syncPull endpoint contract is incompatible');
      }
      endpointUrl.searchParams.set('sessionId', input.sessionId);
      endpointUrl.searchParams.set('cursor', input.cursor);
      if (input.limit !== undefined) endpointUrl.searchParams.set('limit', String(input.limit));
      const response = await transport(endpointUrl, {
        method: contract.method, redirect: 'error', ...(input.signal ? { signal: input.signal } : {}),
        headers: { Accept: 'application/json', Authorization: options.authorization, Origin: options.origin,
          'Known-Sync-Session': input.sessionId },
      });
      if (response.status !== 200) {
        const document: unknown = await response.json();
        if (!validators.validate('problem', document).valid) throw new Error('syncPull returned an invalid COLP Problem');
        throw new Error(`syncPull returned unexpected status ${response.status} (${(document as Problem).code})`);
      }
      if (response.headers.get('cache-control') !== 'private, no-store'
          || !/^application\/json(?:\s*;|$)/iu.test(response.headers.get('content-type') ?? '')) {
        throw new Error('syncPull success is not private COLP JSON');
      }
      const document: unknown = await response.json();
      if (!validators.validate('syncPull', document).valid
          && !validators.validate('syncPullV02', document).valid) {
        throw new Error('syncPull returned an invalid COLP response');
      }
      const result = document as SyncPull | SyncPullV02;
      if ((result.events.length === 0 && result.hasMore)
          || (result.events.length > 0 && result.nextCursor !== result.events.at(-1)?.cursor)) {
        throw new Error('syncPull returned inconsistent pagination semantics');
      }
      return result;
    },
    async ack(input: {
      readonly idempotencyKey: string;
      readonly request: SyncAckRequest;
    }): Promise<{ readonly status: number; readonly body: Problem | SyncAckResult }> {
      const manifestResponse = await transport(options.manifestUrl, {
        redirect: 'error', headers: { Accept: 'application/vnd.collection-protocol.manifest+json;version=0.1',
          'Collection-Protocol-Version': '0.1' },
      });
      if (!manifestResponse.ok) throw new Error('Manifest discovery failed');
      const validators = createValidatorRegistry();
      const manifestDocument: unknown = await manifestResponse.json();
      const manifest = validateWireDocument<Manifest, unknown>(
        validators, 'manifest', manifestDocument, validateManifestSemantics,
      );
      if (!manifest.valid) throw new Error('Manifest is not a valid COLP document');
      const mount = manifest.value.mounts.find((candidate) => candidate.id === options.mountId);
      const endpoint = mount?.endpoints.syncAck;
      if (typeof endpoint !== 'string') throw new Error('Manifest does not expose syncAck');
      if (mount.profiles.includes('sync')) throw new Error('P3-22 must not claim the incomplete sync Profile');
      const endpointUrl = new URL(endpoint);
      const manifestUrl = new URL(options.manifestUrl);
      if (endpointUrl.origin !== manifestUrl.origin || endpointUrl.username || endpointUrl.password
          || endpointUrl.hash || endpointUrl.search) {
        throw new Error('syncAck endpoint is not an allowed absolute URL');
      }
      const contract = endpointContracts.syncAck.operations[0];
      if (contract?.method !== 'POST' || contract.request !== 'syncAckRequest'
          || contract.response !== 'syncAckResult' || !contract.successStatuses.includes(200)
          || !contract.requiredRequestHeaders?.includes('Idempotency-Key')) {
        throw new Error('Public syncAck endpoint contract is incompatible');
      }
      const response = await transport(endpointUrl, { method: contract.method, redirect: 'error', headers: {
        Accept: 'application/json', Authorization: options.authorization, Origin: options.origin,
        'Known-Sync-Session': input.request.sessionId,
        'Content-Type': 'application/json', 'Idempotency-Key': input.idempotencyKey,
      }, body: JSON.stringify(input.request) });
      const contentType = response.headers.get('content-type') ?? '';
      const document: unknown = await response.json();
      if (response.headers.get('cache-control') !== 'private, no-store') {
        throw new Error('syncAck response is not private and non-cacheable');
      }
      if (response.status === 200) {
        if (!/^application\/json(?:\s*;|$)/iu.test(contentType)
            || !validators.validate('syncAckResult', document).valid) {
          throw new Error('syncAck returned an invalid COLP result');
        }
        const result = document as SyncAckResult;
        if (result.ackedCursor !== input.request.cursor) {
          throw new Error('syncAck result cursor does not match the request');
        }
        return Object.freeze({ status: response.status, body: result });
      }
      if (!/^application\/problem\+json(?:\s*;|$)/iu.test(contentType)
          || !validators.validate('problem', document).valid) {
        throw new Error('syncAck admission returned an invalid COLP Problem');
      }
      return Object.freeze({ status: response.status, body: document as Problem });
    },
    async resolveConflict(input: {
      readonly conflictId: string;
      readonly sessionId: string;
      readonly replicaId: string;
      readonly collectionId: string;
      readonly conflictRevision: string;
      readonly idempotencyKey: string;
      readonly request: ConflictResolutionRequest;
    }): Promise<{ readonly status: number; readonly body: Problem | ConflictResolutionResult }> {
      const manifestResponse = await transport(options.manifestUrl, {
        redirect: 'error',
        headers: {
          Accept: 'application/vnd.collection-protocol.manifest+json;version=0.1',
          'Collection-Protocol-Version': '0.1',
        },
      });
      if (!manifestResponse.ok) throw new Error('Manifest discovery failed');
      const manifestDocument: unknown = await manifestResponse.json();
      const validators = createValidatorRegistry();
      const manifest = validateWireDocument<Manifest, unknown>(
        validators, 'manifest', manifestDocument, validateManifestSemantics,
      );
      if (!manifest.valid) throw new Error('Manifest is not a valid COLP document');
      const mount = manifest.value.mounts.find((candidate) => candidate.id === options.mountId);
      const template = mount?.endpoints.syncConflict;
      if (typeof template !== 'string') throw new Error('Manifest does not expose syncConflict');
      if (mount.profiles.includes('sync')) throw new Error('P3-19 must not claim the incomplete sync Profile');
      const variables = getLevelOneUriTemplateVariables(template);
      const validated = validateEndpointVariables('syncConflict', { conflictId: input.conflictId }, validators);
      if (variables?.length !== 1 || variables[0] !== 'conflictId' || !validated.valid) {
        throw new Error('Manifest syncConflict URI Template is incompatible');
      }
      const conflictId = validated.value.conflictId;
      if (typeof conflictId !== 'string') throw new Error('Manifest syncConflict identity is invalid');
      const endpointUrl = new URL(template.replace('{conflictId}', encodeURIComponent(conflictId)));
      const manifestUrl = new URL(options.manifestUrl);
      if (endpointUrl.origin !== manifestUrl.origin || endpointUrl.username || endpointUrl.password
          || endpointUrl.hash || endpointUrl.href.includes('{')) {
        throw new Error('syncConflict endpoint is not an allowed absolute URI Template');
      }
      endpointUrl.searchParams.set('sessionId', input.sessionId);
      endpointUrl.searchParams.set('replicaId', input.replicaId);
      endpointUrl.searchParams.set('collectionId', input.collectionId);
      const contract = endpointContracts.syncConflict.operations[0];
      if (contract?.method !== 'POST' || contract.request !== 'conflictResolutionRequest'
          || contract.response !== 'conflictResolutionResult' || !contract.successStatuses.includes(200)
          || !contract.requiredRequestHeaders?.includes('If-Match')
          || !contract.requiredRequestHeaders?.includes('Idempotency-Key')) {
        throw new Error('Public syncConflict endpoint contract is incompatible');
      }
      const response = await transport(endpointUrl, {
        method: contract.method,
        redirect: 'error',
        headers: {
          Accept: 'application/json', Authorization: options.authorization, Origin: options.origin,
          'Content-Type': 'application/json', 'Idempotency-Key': input.idempotencyKey,
          'If-Match': `"${input.conflictRevision}"`,
        },
        body: JSON.stringify(input.request),
      });
      const contentType = response.headers.get('content-type') ?? '';
      const document: unknown = await response.json();
      if (response.headers.get('cache-control') !== 'private, no-store') {
        throw new Error('syncConflict response is not private and non-cacheable');
      }
      if (response.status === 200) {
        if (!/^application\/json(?:\s*;|$)/iu.test(contentType)
            || !validators.validate('conflictResolutionResult', document).valid) {
          throw new Error('syncConflict returned an invalid COLP result');
        }
        const result = document as ConflictResolutionResult;
        if (result.conflict.id !== input.conflictId || result.conflict.status !== 'resolved') {
          throw new Error('syncConflict result identity does not match the URI Template value');
        }
        if (response.headers.get('etag') !== `"${result.conflict.revision}"`) {
          throw new Error('syncConflict result ETag does not match its resolved revision');
        }
        return Object.freeze({ status: response.status, body: result });
      }
      if (!/^application\/problem\+json(?:\s*;|$)/iu.test(contentType)
          || !validators.validate('problem', document).valid) {
        throw new Error('syncConflict admission returned an invalid COLP Problem');
      }
      return Object.freeze({ status: response.status, body: document as Problem });
    },
  });
}

function validSessionSemantics(response: SyncSessionResult | SyncSessionResultV02,
  request: SyncSessionRequest | SyncSessionRequestV02): boolean {
  if (response.scope !== 'collection' || request.scope !== 'collection') return false;
  const serverTime = Date.parse(response.serverTime);
  const clientTime = Date.parse(request.clientTime);
  return response.acceptedProtocolVersion === request.protocolVersion
    && response.collection.collectionId === request.collection.collectionId
    && response.maxBatchOperations === 1
    && response.clockSkewMilliseconds === serverTime - clientTime
    && Date.parse(response.expiresAt) > serverTime
    && Date.parse(response.replicaLease.expiresAt) > Date.parse(response.replicaLease.lastSeenAt);
}
