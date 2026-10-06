import type {
  CanonicalResourceUri,
  GlobalResourceIdentity,
  GlobalResourceReference,
  GlobalResourceType,
  OpaqueId,
} from '../types/generated.js';

export type {
  CanonicalResourceUri,
  GlobalResourceIdentity,
  GlobalResourceReference,
  GlobalResourceType,
} from '../types/generated.js';

const wireIdPattern = /^[A-Za-z0-9._~-]{1,128}$/;
const globalResourceTypes = new Set<GlobalResourceType>([
  'collection',
  'node',
  'annotation',
  'attachment',
  'relation',
  'operation',
  'event',
]);
const canonicalResourceUriPattern =
  /^colp:\/resources\/(~[A-Za-z0-9._~-]{1,128})\/(collection|node|annotation|attachment|relation|operation|event)\/(~[A-Za-z0-9._~-]{1,128})$/;

export interface LocalResourceReferenceContext {
  readonly localServerUuid: OpaqueId;
  readonly resourceType: GlobalResourceType;
  readonly claimedIdentity?: GlobalResourceIdentity;
}

/** Shared lexical assertion for protocol-local opaque identifiers. */
export function isOpaqueId(value: unknown): value is OpaqueId {
  return typeof value === 'string' && wireIdPattern.test(value);
}

function assertWireId(name: string, value: string): asserts value is OpaqueId {
  if (!isOpaqueId(value)) {
    throw new TypeError(`${name} must be a 1 to 128 character URI Unreserved ASCII Wire ID.`);
  }
}

export function formatCanonicalResourceUri(
  identity: GlobalResourceIdentity,
): CanonicalResourceUri {
  assertWireId('serverUuid', identity.serverUuid);
  assertWireId('id', identity.id);
  if (!globalResourceTypes.has(identity.resourceType)) {
    throw new TypeError('resourceType is not a protocol global identity kind.');
  }

  return `colp:/resources/~${identity.serverUuid}/${identity.resourceType}/~${identity.id}`;
}

export function parseCanonicalResourceUri(
  uri: string,
  claimedIdentity?: GlobalResourceIdentity,
): GlobalResourceIdentity {
  const match = canonicalResourceUriPattern.exec(uri);
  if (match === null) {
    throw new TypeError('Resource URI is not in canonical COLP global identity form.');
  }

  const identity: GlobalResourceIdentity = {
    serverUuid: match[1]!.slice(1),
    resourceType: match[2] as GlobalResourceType,
    id: match[3]!.slice(1),
  };
  if (formatCanonicalResourceUri(identity) !== uri) {
    throw new TypeError('Resource URI is not the canonical serialization of its identity.');
  }
  if (claimedIdentity !== undefined && !sameGlobalResourceIdentity(identity, claimedIdentity)) {
    throw new TypeError('Resource URI does not encode the claimed global identity.');
  }
  return identity;
}

export function resolveResourceReference(
  reference: GlobalResourceReference,
  localContext: LocalResourceReferenceContext,
): GlobalResourceIdentity {
  assertWireId('local serverUuid', localContext.localServerUuid);
  if (!globalResourceTypes.has(localContext.resourceType)) {
    throw new TypeError('local resourceType is not a protocol global identity kind.');
  }
  if (isOpaqueId(reference)) {
    const identity: GlobalResourceIdentity = {
      serverUuid: localContext.localServerUuid,
      resourceType: localContext.resourceType,
      id: reference,
    };
    if (
      localContext.claimedIdentity !== undefined &&
      !sameGlobalResourceIdentity(identity, localContext.claimedIdentity)
    ) {
      throw new TypeError('A bare ID cannot represent the claimed non-local global identity.');
    }
    return identity;
  }
  return parseCanonicalResourceUri(reference, localContext.claimedIdentity);
}

export function sameGlobalResourceIdentity(
  left: GlobalResourceIdentity,
  right: GlobalResourceIdentity,
): boolean {
  // Global identity is exactly this tuple; representation hints such as URL hashes are irrelevant.
  return (
    left.serverUuid === right.serverUuid &&
    left.resourceType === right.resourceType &&
    left.id === right.id
  );
}
