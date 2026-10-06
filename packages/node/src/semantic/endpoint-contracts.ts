import type { ValidatorRegistry } from '../schema/index.js';
import { publicationRequiredEndpoints } from './publication-endpoints.js';

export type ProtocolProfile =
  | 'core'
  | 'publication'
  | 'feed'
  | 'publisher'
  | 'sync'
  | 'mcp-read'
  | 'mcp-write';

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';

export interface HttpOperationContract {
  readonly method: HttpMethod;
  readonly profile: ProtocolProfile | 'administration';
  readonly query?: string;
  readonly request?: string;
  readonly response?: string;
  readonly successStatuses: readonly number[];
  readonly requiredRequestHeaders?: readonly string[];
  readonly requiredResponseHeaders?: readonly string[];
}

export interface EndpointContract {
  /** Decoded RFC 6570 variables; every protocol endpoint variable is an opaque wire ID. */
  readonly variables: readonly `${string}Id`[];
  readonly operations: readonly HttpOperationContract[];
}

export type EndpointVariableValidationResult =
  | { readonly valid: true; readonly value: Readonly<Record<string, string>> }
  | { readonly valid: false; readonly code: 'invalid_path_variables'; readonly errors: readonly string[] };

const conditionalWriteHeaders = ['If-Match'] as const;
const createdResponseHeaders = ['Location', 'ETag'] as const;

export const endpointContracts = {
  directory: {
    variables: [],
    operations: [
      {
        method: 'GET',
        profile: 'publication',
        query: 'directoryQuery',
        response: 'collectionDirectory',
        successStatuses: [200, 304],
        requiredResponseHeaders: ['ETag'],
      },
      {
        method: 'POST',
        profile: 'publisher',
        request: 'collectionCreateRequest',
        response: 'collectionCreateResult',
        successStatuses: [201],
        requiredRequestHeaders: ['Idempotency-Key'],
        requiredResponseHeaders: createdResponseHeaders,
      },
    ],
  },
  collection: {
    variables: ['collectionId'],
    operations: [
      {
        method: 'GET',
        profile: 'publication',
        response: 'collectionMetadata',
        successStatuses: [200, 304],
        requiredResponseHeaders: ['ETag'],
      },
      {
        method: 'PATCH',
        profile: 'publisher',
        request: 'collectionMergePatch',
        response: 'collection',
        successStatuses: [200],
        requiredRequestHeaders: conditionalWriteHeaders,
        requiredResponseHeaders: ['ETag'],
      },
      {
        method: 'DELETE',
        profile: 'publisher',
        response: 'deleteResult',
        successStatuses: [200],
        requiredRequestHeaders: conditionalWriteHeaders,
      },
    ],
  },
  snapshot: {
    variables: ['collectionId'],
    operations: [
      {
        method: 'GET',
        profile: 'publication',
        query: 'snapshotQuery',
        response: 'snapshot',
        successStatuses: [200, 304],
        requiredResponseHeaders: ['ETag'],
      },
    ],
  },
  node: {
    variables: ['collectionId', 'nodeId'],
    operations: [
      {
        method: 'GET',
        profile: 'publication',
        query: 'nodeDetailQuery',
        response: 'nodeDetail',
        successStatuses: [200, 304],
      },
      {
        method: 'PATCH',
        profile: 'publisher',
        request: 'nodeMergePatch',
        response: 'node',
        successStatuses: [200],
        requiredRequestHeaders: conditionalWriteHeaders,
        requiredResponseHeaders: ['ETag'],
      },
      {
        method: 'DELETE',
        profile: 'publisher',
        query: 'nodeDeleteQuery',
        response: 'deleteResult',
        successStatuses: [200],
        requiredRequestHeaders: conditionalWriteHeaders,
      },
    ],
  },
  nodes: {
    variables: ['collectionId'],
    operations: [
      {
        method: 'POST',
        profile: 'publisher',
        request: 'nodeCreateRequest',
        response: 'node',
        successStatuses: [201],
        requiredRequestHeaders: ['Idempotency-Key'],
        requiredResponseHeaders: createdResponseHeaders,
      },
    ],
  },
  nodeMove: {
    variables: ['collectionId', 'nodeId'],
    operations: [
      {
        method: 'POST',
        profile: 'publisher',
        request: 'nodeMoveRequest',
        response: 'nodeMoveResult',
        successStatuses: [200],
        requiredRequestHeaders: ['If-Match', 'Idempotency-Key'],
        requiredResponseHeaders: ['ETag'],
      },
    ],
  },
  annotations: {
    variables: ['collectionId'],
    operations: [{ method: 'POST', profile: 'publisher', request: 'annotationCreate', response: 'annotation', successStatuses: [201], requiredRequestHeaders: ['Idempotency-Key'], requiredResponseHeaders: createdResponseHeaders }],
  },
  annotation: {
    variables: ['collectionId', 'annotationId'],
    operations: [
      { method: 'PATCH', profile: 'publisher', request: 'annotationMergePatch', response: 'annotation', successStatuses: [200], requiredRequestHeaders: conditionalWriteHeaders, requiredResponseHeaders: ['ETag'] },
      { method: 'DELETE', profile: 'publisher', response: 'deleteResult', successStatuses: [200], requiredRequestHeaders: conditionalWriteHeaders },
    ],
  },
  attachments: {
    variables: ['collectionId'],
    operations: [{ method: 'POST', profile: 'publisher', request: 'attachmentCreate', response: 'attachment', successStatuses: [201], requiredRequestHeaders: ['Idempotency-Key'], requiredResponseHeaders: createdResponseHeaders }],
  },
  attachment: {
    variables: ['collectionId', 'attachmentId'],
    operations: [
      { method: 'PATCH', profile: 'publisher', request: 'attachmentMergePatch', response: 'attachment', successStatuses: [200], requiredRequestHeaders: conditionalWriteHeaders, requiredResponseHeaders: ['ETag'] },
      { method: 'DELETE', profile: 'publisher', response: 'deleteResult', successStatuses: [200], requiredRequestHeaders: conditionalWriteHeaders },
    ],
  },
  relations: {
    variables: ['collectionId'],
    operations: [{ method: 'POST', profile: 'publisher', request: 'relationCreate', response: 'relation', successStatuses: [201], requiredRequestHeaders: ['Idempotency-Key'], requiredResponseHeaders: createdResponseHeaders }],
  },
  relation: {
    variables: ['collectionId', 'relationId'],
    operations: [
      { method: 'PATCH', profile: 'publisher', request: 'relationMergePatch', response: 'relation', successStatuses: [200], requiredRequestHeaders: conditionalWriteHeaders, requiredResponseHeaders: ['ETag'] },
      { method: 'DELETE', profile: 'publisher', response: 'deleteResult', successStatuses: [200], requiredRequestHeaders: conditionalWriteHeaders },
    ],
  },
  release: {
    variables: ['collectionId'],
    operations: [{ method: 'POST', profile: 'publisher', request: 'releaseCreate', response: 'releaseResult', successStatuses: [201], requiredRequestHeaders: ['If-Match', 'Idempotency-Key'], requiredResponseHeaders: createdResponseHeaders }],
  },
  releases: {
    variables: ['collectionId'],
    operations: [{ method: 'GET', profile: 'publisher', query: 'cursorPageQuery', response: 'releaseDirectory', successStatuses: [200] }],
  },
  releaseItem: {
    variables: ['collectionId', 'releaseId'],
    operations: [{ method: 'GET', profile: 'publisher', response: 'releaseResult', successStatuses: [200] }],
  },
  releaseSnapshot: {
    variables: ['collectionId', 'releaseId'],
    operations: [{ method: 'GET', profile: 'publisher', response: 'snapshot', successStatuses: [200, 304], requiredResponseHeaders: ['ETag', 'Content-Digest'] }],
  },
  instanceFeed: {
    variables: [],
    operations: [{ method: 'GET', profile: 'feed', query: 'feedQuery', response: 'feed', successStatuses: [200, 304], requiredResponseHeaders: ['ETag'] }],
  },
  collectionFeed: {
    variables: ['collectionId'],
    operations: [{ method: 'GET', profile: 'feed', query: 'feedQuery', response: 'feed', successStatuses: [200, 304], requiredResponseHeaders: ['ETag'] }],
  },
  syncSessions: {
    variables: [],
    operations: [{ method: 'POST', profile: 'sync', request: 'syncSessionRequest', response: 'syncSessionResult', successStatuses: [201], requiredRequestHeaders: ['Idempotency-Key'] }],
  },
  syncSnapshot: {
    variables: [],
    operations: [{ method: 'GET', profile: 'sync', query: 'syncSnapshotQuery', response: 'snapshot', successStatuses: [200] }],
  },
  syncPush: {
    variables: [],
    operations: [{ method: 'POST', profile: 'sync', request: 'syncPush', response: 'syncPushResult', successStatuses: [200], requiredRequestHeaders: ['Idempotency-Key'] }],
  },
  syncPull: {
    variables: [],
    operations: [{ method: 'GET', profile: 'sync', query: 'syncPullQuery', response: 'syncPull', successStatuses: [200] }],
  },
  syncAck: {
    variables: [],
    operations: [{ method: 'POST', profile: 'sync', request: 'syncAckRequest', response: 'syncAckResult', successStatuses: [200], requiredRequestHeaders: ['Idempotency-Key'] }],
  },
  syncConflict: {
    variables: ['conflictId'],
    operations: [{ method: 'POST', profile: 'sync', request: 'conflictResolutionRequest', response: 'conflictResolutionResult', successStatuses: [200], requiredRequestHeaders: ['If-Match', 'Idempotency-Key'] }],
  },
  collectionAccess: {
    variables: ['collectionId'],
    operations: [
      { method: 'GET', profile: 'administration', response: 'accessPolicy', successStatuses: [200] },
      { method: 'PATCH', profile: 'administration', request: 'accessPolicyPatch', response: 'accessPolicy', successStatuses: [200], requiredRequestHeaders: conditionalWriteHeaders, requiredResponseHeaders: ['ETag'] },
    ],
  },
  mcp: { variables: [], operations: [] },
  adminAccess: {
    variables: [],
    operations: [
      { method: 'GET', profile: 'administration', response: 'accessPolicy', successStatuses: [200] },
      { method: 'PATCH', profile: 'administration', request: 'accessPolicyPatch', response: 'accessPolicy', successStatuses: [200], requiredRequestHeaders: conditionalWriteHeaders, requiredResponseHeaders: ['ETag'] },
    ],
  },
  adminKeys: {
    variables: [],
    operations: [
      { method: 'GET', profile: 'administration', query: 'cursorPageQuery', response: 'apiKeyDirectory', successStatuses: [200] },
      { method: 'POST', profile: 'administration', request: 'apiKeyCreateRequest', response: 'apiKeyCreateResult', successStatuses: [201], requiredRequestHeaders: ['Idempotency-Key'], requiredResponseHeaders: createdResponseHeaders },
    ],
  },
  adminKey: {
    variables: ['keyId'],
    operations: [{ method: 'DELETE', profile: 'administration', response: 'apiKeyRevokeResult', successStatuses: [200], requiredRequestHeaders: conditionalWriteHeaders }],
  },
  adminKeyRotate: {
    variables: ['keyId'],
    operations: [{ method: 'POST', profile: 'administration', request: 'apiKeyRotateRequest', response: 'apiKeyRotateResult', successStatuses: [200], requiredRequestHeaders: ['If-Match', 'Idempotency-Key'] }],
  },
  adminRateLimits: {
    variables: [],
    operations: [
      { method: 'GET', profile: 'administration', query: 'cursorPageQuery', response: 'rateLimitDirectory', successStatuses: [200] },
      { method: 'PATCH', profile: 'administration', request: 'rateLimitPolicyUpdateRequest', response: 'rateLimitPolicy', successStatuses: [200], requiredRequestHeaders: conditionalWriteHeaders, requiredResponseHeaders: ['ETag'] },
    ],
  },
  adminAudit: {
    variables: [],
    operations: [{ method: 'GET', profile: 'administration', query: 'auditQuery', response: 'auditDirectory', successStatuses: [200] }],
  },
} as const satisfies Readonly<Record<string, EndpointContract>>;

export type EndpointKey = keyof typeof endpointContracts;

export const profileDependencies = Object.freeze({
  core: Object.freeze([]),
  publication: Object.freeze(['core']),
  feed: Object.freeze(['publication']),
  publisher: Object.freeze(['publication']),
  sync: Object.freeze(['core']),
  'mcp-read': Object.freeze(['core']),
  'mcp-write': Object.freeze(['mcp-read', 'publisher']),
} as const satisfies Readonly<Record<ProtocolProfile, readonly ProtocolProfile[]>>);

/** Validates decoded URI-template values before a client expands or a server dispatches a route. */
export function validateEndpointVariables(
  endpoint: EndpointKey,
  values: Readonly<Record<string, string>>,
  validators: ValidatorRegistry,
): EndpointVariableValidationResult {
  const expected = [...endpointContracts[endpoint].variables].sort();
  const supplied = Object.keys(values).sort();
  if (expected.join('\u0000') !== supplied.join('\u0000')) {
    return {
      valid: false,
      code: 'invalid_path_variables',
      errors: Object.freeze([
        `Endpoint ${endpoint} requires variables [${expected.join(', ')}], received [${supplied.join(', ')}].`,
      ]),
    };
  }

  const errors: string[] = [];
  for (const name of expected) {
    const result = validators.validate('opaqueId', values[name]);
    if (!result.valid) {
      errors.push(`Endpoint variable ${name} must be a 1-128 character URI-unreserved ASCII wire ID.`);
    }
  }

  return errors.length === 0
    ? { valid: true, value: Object.freeze({ ...values }) }
    : { valid: false, code: 'invalid_path_variables', errors: Object.freeze(errors) };
}

export const profileRequiredEndpoints = Object.freeze({
  core: Object.freeze([]),
  publication: publicationRequiredEndpoints,
  feed: Object.freeze(['instanceFeed', 'collectionFeed']),
  publisher: Object.freeze(['nodes', 'node', 'nodeMove', 'annotations', 'annotation', 'attachments', 'attachment', 'relations', 'relation', 'release', 'releases', 'releaseItem', 'releaseSnapshot']),
  sync: Object.freeze(['syncSessions', 'syncSnapshot', 'syncPush', 'syncPull', 'syncAck', 'syncConflict']),
  'mcp-read': Object.freeze(['mcp']),
  'mcp-write': Object.freeze(['mcp']),
} as const satisfies Readonly<Record<ProtocolProfile, readonly EndpointKey[]>>);
