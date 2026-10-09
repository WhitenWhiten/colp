import { isProxy } from 'node:util/types';

import {
  protocolVendorJsonMediaType,
  type ProtocolVendorJsonResource,
} from '../client/protocol-json-media.js';
import { createValidatorRegistry, type ValidatorRegistry } from '../schema/index.js';
import type { PublicationCacheControlHeaderValue, PublicationVaryHeaderValue } from './publication-cache-policy.js';
import { mergePublicationCollectionMetadataLinkHeaders } from './publication-collection-metadata-links.js';
import {
  composePublicationHttpRead,
  type AnonymousPublicationHttpReadInput,
  type AnonymousPublicationHttpReadRepresentation,
  type AuthorizedPublicationHttpReadInput,
  type AuthorizedPublicationHttpReadRepresentation,
  type PublicationHttpReadEndpoint,
  type PublicationHttpReadInput,
  type PublicationHttpReadRepresentation,
} from './publication-http-read.js';
import { createPublicationProblemResponse } from './publication-problems.js';
import type { PublicationPageEtagIdentity } from './publication-representation-etag.js';

const vendorResources: Readonly<Record<PublicationHttpReadEndpoint, ProtocolVendorJsonResource>> = Object.freeze({
  manifest: 'manifest',
  directory: 'catalog',
  metadata: 'collection',
  snapshot: 'snapshot',
  node: 'node',
});

/** The registered vendor media type, with `version=0.1`, for each Publication read endpoint. */
export const PUBLICATION_HTTP_READ_MEDIA_TYPES: Readonly<Record<PublicationHttpReadEndpoint, string>> =
  Object.freeze(Object.fromEntries(
    Object.entries(vendorResources).map(([endpoint, resource]) => [endpoint, protocolVendorJsonMediaType(resource)]),
  ) as Record<PublicationHttpReadEndpoint, string>);

const representationOptionKeys: ReadonlySet<string> = new Set([
  'lastModified', 'revision', 'projectionKey', 'protocolVersion', 'negotiatedMediaType', 'pageIdentity',
  'headers', 'cacheControl', 'vary', 'principalScope',
]);

export interface PublicationHttpReadRepresentationOptions {
  /** When the representation last changed; sent as Last-Modified. */
  readonly lastModified: Date;
  /**
   * Required for `manifest` and `directory`. Defaults to the document's own
   * revision for `metadata`, `snapshot`, and `node`.
   */
  readonly revision?: string;
  /** Defaults to `public`. Give every distinct projection of a resource its own key. */
  readonly projectionKey?: string;
  /** Defaults to `0.1`. */
  readonly protocolVersion?: string;
  /** Defaults to the endpoint's entry in `PUBLICATION_HTTP_READ_MEDIA_TYPES`. */
  readonly negotiatedMediaType?: string;
  /** Defaults to the page sequence for `snapshot`. Pass the page cursor when the request had one. */
  readonly pageIdentity?: PublicationPageEtagIdentity;
  /** Extra response headers. Collection Metadata Link headers are added for you. */
  readonly headers?: Headers | [string, string][] | Record<string, string>;
  readonly cacheControl?: PublicationCacheControlHeaderValue;
  readonly vary?: PublicationVaryHeaderValue;
}

export interface AuthorizedPublicationHttpReadRepresentationOptions
  extends PublicationHttpReadRepresentationOptions {
  /** Partitions the ETag by principal; required for every authorized read. */
  readonly principalScope: string;
}

/**
 * Builds the representation that `resolveRepresentation` returns, deriving
 * everything the document already says: its revision, the Snapshot and page
 * identities, the vendor media type, and the Collection Metadata Link headers.
 * The value is still projected and schema-validated by the composed read.
 */
export function createPublicationHttpReadRepresentation(
  endpoint: PublicationHttpReadEndpoint,
  value: unknown,
  options: AuthorizedPublicationHttpReadRepresentationOptions,
): AuthorizedPublicationHttpReadRepresentation;
export function createPublicationHttpReadRepresentation(
  endpoint: PublicationHttpReadEndpoint,
  value: unknown,
  options: PublicationHttpReadRepresentationOptions,
): AnonymousPublicationHttpReadRepresentation;
export function createPublicationHttpReadRepresentation(
  endpoint: PublicationHttpReadEndpoint,
  value: unknown,
  options: PublicationHttpReadRepresentationOptions & { readonly principalScope?: string },
): PublicationHttpReadRepresentation {
  if (!Object.hasOwn(vendorResources, endpoint)) {
    throw new TypeError('Publication HTTP read endpoint is invalid.');
  }
  const settings = readDataObject(options, 'Publication HTTP read representation options');
  for (const key of Object.keys(settings)) {
    if (!representationOptionKeys.has(key)) {
      throw new TypeError(`Unknown Publication HTTP read representation option: ${key}.`);
    }
  }
  if (!(settings.lastModified instanceof Date)) {
    throw new TypeError('Publication HTTP read representation options need a lastModified Date.');
  }
  const revision = settings.revision ?? derivedRevision(endpoint, value);
  if (typeof revision !== 'string') {
    throw new TypeError(`Publication ${endpoint} representations need options.revision.`);
  }
  const page = endpoint === 'snapshot' ? snapshotPage(value) : undefined;
  const pageIdentity = settings.pageIdentity ?? (page === undefined ? undefined : { pageNumber: page.sequence });
  const headers = endpoint === 'metadata'
    ? mergePublicationCollectionMetadataLinkHeaders(value, settings.headers)
    : settings.headers;
  return {
    value,
    revision,
    projectionKey: settings.projectionKey ?? 'public',
    protocolVersion: settings.protocolVersion ?? '0.1',
    lastModified: settings.lastModified,
    negotiatedMediaType: settings.negotiatedMediaType ?? PUBLICATION_HTTP_READ_MEDIA_TYPES[endpoint],
    ...(page === undefined ? {} : { snapshotIdentity: { snapshotId: page.snapshotId, sequence: page.sequence } }),
    ...(pageIdentity === undefined ? {} : { pageIdentity }),
    ...(headers === undefined ? {} : { headers }),
    ...(settings.cacheControl === undefined ? {} : { cacheControl: settings.cacheControl }),
    ...(settings.vary === undefined ? {} : { vary: settings.vary }),
    ...(settings.principalScope === undefined ? {} : { principalScope: settings.principalScope }),
  } as PublicationHttpReadRepresentation;
}

type RequestDerivedField = 'method' | 'rawSearch' | 'ifNoneMatch' | 'validators' | 'protocolVersionHeader' | 'accept';

/** `composePublicationHttpRead` input without the fields a Request already carries. */
export type PublicationHttpReadRequestInput<Context = unknown> =
  | (Omit<AnonymousPublicationHttpReadInput, RequestDerivedField> & { readonly validators?: ValidatorRegistry })
  | (Omit<AuthorizedPublicationHttpReadInput<Context>, RequestDerivedField> & {
      readonly validators?: ValidatorRegistry;
    });

/** The parts of a Fetch API Request a Publication read uses. */
export type PublicationHttpReadRequest = Pick<Request, 'method' | 'url'> & {
  readonly headers: Pick<Headers, 'get'>;
};

let sharedValidators: ValidatorRegistry | undefined;

/**
 * Composes one Publication read from a Fetch API Request. The method, query
 * string, and `If-None-Match` come from the request, and `validators` defaults
 * to the package's own registry. Any method other than GET or HEAD gets a 405
 * Problem with `Allow: GET, HEAD`, as PUB-0008 requires for every error. The
 * `Collection-Protocol-Version` and `Accept` headers drive SPECIFICATION §12
 * negotiation; pass `supportedVersions` when the host implements more than
 * `0.1`.
 */
export async function composePublicationHttpReadFromRequest<Context = unknown>(
  request: PublicationHttpReadRequest,
  input: PublicationHttpReadRequestInput<Context>,
): Promise<Response> {
  const fields = readDataObject(input, 'Publication HTTP read input');
  for (const key of ['method', 'rawSearch', 'ifNoneMatch', 'protocolVersionHeader', 'accept']) {
    if (Object.hasOwn(fields, key)) {
      throw new TypeError(`Publication HTTP read input must not set ${key}; it comes from the request.`);
    }
  }
  const { method, url } = request;
  if (method !== 'GET' && method !== 'HEAD') {
    const response = createPublicationProblemResponse({ code: 'method_not_allowed' });
    response.headers.set('allow', 'GET, HEAD');
    return response;
  }
  const validators = fields.validators ?? (sharedValidators ??= createValidatorRegistry());
  return composePublicationHttpRead({
    ...fields,
    method,
    // Only the query is read, so a path-only URL from a framework adapter also works.
    rawSearch: new URL(url, 'http://localhost').search,
    ifNoneMatch: request.headers.get('if-none-match'),
    // SPECIFICATION §12: an unsupported asserted version is a 406 Problem.
    protocolVersionHeader: request.headers.get('collection-protocol-version'),
    accept: request.headers.get('accept'),
    validators,
  } as PublicationHttpReadInput<Context>);
}

function derivedRevision(endpoint: PublicationHttpReadEndpoint, value: unknown): unknown {
  if (endpoint === 'snapshot') return readDataProperty(value, 'revision');
  if (endpoint === 'metadata') return readDataProperty(readDataProperty(value, 'collection'), 'revision');
  if (endpoint === 'node') return readDataProperty(readDataProperty(value, 'node'), 'revision');
  return undefined;
}

function snapshotPage(value: unknown): { readonly snapshotId: string; readonly sequence: number } {
  const snapshotId = readDataProperty(value, 'snapshotId');
  const sequence = readDataProperty(readDataProperty(value, 'page'), 'sequence');
  if (typeof snapshotId !== 'string' || !Number.isSafeInteger(sequence)) {
    throw new TypeError('Publication snapshot representations need a snapshotId and page.sequence.');
  }
  return { snapshotId, sequence: sequence as number };
}

/** Reads an own enumerable data property without running getters or Proxy traps. */
function readDataProperty(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null || isProxy(value)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor !== undefined && descriptor.enumerable && 'value' in descriptor ? descriptor.value : undefined;
}

/** Copies a plain object's own data properties, rejecting Proxies and accessors. */
function readDataObject<Value extends object>(value: Value, label: string): Value {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || isProxy(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
  const copy: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
      throw new TypeError(`${label} fields must be enumerable data properties.`);
    }
    copy[key] = descriptor.value;
  }
  return copy as Value;
}
