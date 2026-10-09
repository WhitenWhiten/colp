import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import {
  abortable, ColpClientLimitError, resolveClientRequestLimits, withRequestBudget,
  type ClientRequestLimits, type ClientRequestOptions,
} from './request-budget.js';
import { cancelResponseBody, readResponseBody } from './response-body.js';
import { withClientRequestIdentity, type ClientRequestContext, type ClientRequestIdentity, type ClientRequestIdentityProvider, type CredentialProvider } from './request-identity.js';
export type { ClientRequestIdentity, ClientRequestIdentityProvider, CredentialProvider } from './request-identity.js';
export { ColpClientLimitError, defaultClientRequestLimits, type ClientRequestLimits, type ClientRequestOptions } from './request-budget.js';
import canonicalize from 'canonicalize';
import { parseTemplate } from 'url-template';
import {
  defaultClientHostResolver,
  defaultPinnedNodeFetch,
  type ClientHostResolver,
  type PinnedNodeFetch,
} from './host-resolution.js';
import {
  createValidatorRegistry,
  parseIJson,
  resolveIJsonParseLimits,
  validateWireJsonDocument,
  validateWireDocument,
  type DefinitionName,
  type IJsonParseLimits,
  type ResolvedIJsonParseLimits,
  type SemanticValidationResultLike,
  type ValidatorRegistry,
  type WireJsonDocumentValidationResult,
} from '../schema/index.js';
import {
  assembleSnapshotPages,
  endpointContracts,
  MAX_PUBLICATION_ENDPOINT_TEMPLATE_BYTES,
  type EndpointContract,
  type HttpOperationContract,
  type SemanticIssue,
  type SnapshotReferenceResolution,
  validateEndpointVariables,
  validateManifestSemantics,
  validateSnapshotSemantics,
} from '../semantic/index.js';
export * from '../shared/url-hash.js';
import {
  isPrivateOrLocalAddress,
  isPrivateOrLocalLiteralHostname,
} from '../shared/private-or-local-literal-host.js';
export { isPrivateOrLocalAddress, isPrivateOrLocalLiteralHostname } from '../shared/private-or-local-literal-host.js';
export { createLoopbackEgressPolicy } from './egress-policies.js';
import type {
  CollectionDirectory,
  CollectionMetadata,
  CreateNodeOperationPayload,
  DirectoryQuery,
  Manifest,
  ManifestMount,
  MoveOperationPayload,
  Node,
  NodeMoveResult,
  Problem,
  Snapshot,
  SnapshotQuery,
} from '../types/index.js';
import { buildCreateNodePayload, buildMoveNodePayload } from './node-placement.js';
import { validateNodeWriteResponse } from './node-write-response.js';
import {
  assertPublicationManifestQueryUrlTexts,
} from './publication-query.js';
import {
  createPublicationEndpointNavigationTarget,
  createPublicationSnapshotNextNavigationTarget,
  publicationNavigationSource,
  publicationNavigationUrl,
  type PublicationNavigationSource,
  type PublicationNavigationTarget,
} from './publication-navigation.js';
import {
  classifyPublicationProblem,
  validatePublicationProblemSemantics,
  type PublicationProblemClassification,
} from '../semantic/publication-problems.js';
import { PublicationSnapshotState } from './publication-snapshot-state.js';
import {
  createPublicationTransportBoundary,
  publicationTrustedOrigin,
  type PublicationTransportBoundary,
} from './publication-transport-boundary.js';
import {
  parseProtocolJsonResponseMediaType,
  protocolVendorJsonResourceForDefinition,
  type ProtocolJsonResponseMedia,
} from './protocol-json-media.js';
import { validatePublicationIfNoneMatchEtag } from './publication-conditional.js';
import { updatePublicationResponseCache, type ClientCache, type ClientCacheEntry } from './publication-cache.js';
export type { ClientCache, ClientCacheEntry } from './publication-cache.js';
export { compareOrderKeys } from '../semantic/index.js';
export { buildCreateNodePayload, buildMoveNodePayload } from './node-placement.js';
export {
  resolvePublicationEndpoint,
  type PublicationEndpointKey,
} from './publication-endpoints.js';
export {
  createPublicationTransportBoundary,
  publicationTrustedOrigin,
  type PublicationTransportBoundary,
} from './publication-transport-boundary.js';
export {
  createPublicationEndpointNavigationTarget,
  createPublicationSnapshotNextNavigationTarget,
  publicationNavigationSource,
  publicationNavigationUrl,
  type PublicationEndpointNavigationInput,
  type PublicationNavigationSource,
  type PublicationNavigationTarget,
} from './publication-navigation.js';
export {
  preparePublicationQuery,
  PublicationQueryError,
  type PublicationQueryEndpoint,
} from './publication-query.js';
export {
  validatePublicationEndpointDto,
  validatePublicationEndpointQuery,
  validatePublicationEndpointRequest,
  validatePublicationEndpointResponse,
  type PublicationEndpointDtoValidationOptions,
} from './publication-endpoint-dto.js';
export {
  publicationSnapshotNextUrl,
  type PublicationSnapshotNextLinkInput,
} from './publication-snapshot-pagination.js';
export {
  PublicationSnapshotReplacementError,
  PublicationSnapshotState,
} from './publication-snapshot-state.js';
export {
  classifyPublicationProblem,
  validatePublicationProblemSemantics,
  type PublicationProblemClassification,
  type PublicationProblemFieldError,
  type PublicationProblemRecovery,
  type PublicationProblemSemanticContext,
} from '../semantic/publication-problems.js';
export {
  parseProtocolJsonResponseMediaType,
  protocolVendorJsonMediaType,
  protocolVendorJsonResourceForDefinition,
  type ProtocolJsonResponseMedia,
  type ProtocolVendorJsonResource,
} from './protocol-json-media.js';
export { validatePublicationIfNoneMatchEtag } from './publication-conditional.js';
export {
  formatCanonicalResourceUri,
  parseCanonicalResourceUri,
  resolveResourceReference,
  sameGlobalResourceIdentity,
  type CanonicalResourceUri,
  type GlobalResourceIdentity,
  type GlobalResourceReference,
  type GlobalResourceType,
  type LocalResourceReferenceContext,
} from '../shared/resource-identity.js';
export type FetchImplementation = typeof globalThis.fetch;
export type { ClientHostResolver, PinnedNodeFetch } from './host-resolution.js';
export const supportedClientProtocolVersions = ['0.1'] as const;
export type SupportedClientProtocolVersion = (typeof supportedClientProtocolVersions)[number];
function parseClientHeaders(
  input: ConstructorParameters<typeof Headers>[0],
  source: 'static' | 'provider' | 'operation',
): Headers {
  try {
    return new Headers(input);
  } catch {
    throw new TypeError(`Invalid ${source} client HTTP headers.`);
  }
}

export interface SnapshotRetrievalLimits {
  readonly maxPages: number;
  readonly maxBytes: number;
  readonly maxObjects: number;
  readonly timeoutMs: number;
}

export const defaultSnapshotRetrievalLimits: SnapshotRetrievalLimits = Object.freeze({
  maxPages: 100,
  maxBytes: 64 * 1024 * 1024,
  maxObjects: 100_000,
  timeoutMs: 30_000,
});

export type ClientRequestPurpose = 'manifest' | 'publication-read' | 'publisher-write';

export interface ClientEgressPolicyContext {
  readonly purpose: ClientRequestPurpose;
  readonly method: string;
  readonly redirectCount: number;
  readonly previousUrl: URL | null;
  readonly trustedOrigin: string;
  readonly mountId?: string;
  readonly publicationNavigation?: Readonly<{
    readonly source: PublicationNavigationSource;
    readonly hop: 'target' | 'redirect';
  }>;
}

/** Return true to authorize one concrete request hop; false fails before credentials or fetch. */
export type ClientEgressPolicy = (
  url: URL,
  context: ClientEgressPolicyContext,
) => boolean | Promise<boolean>;

/** Anonymous/static-header cache partition selector. Credentialed caching uses requestIdentityProvider. */
export type CachePartitionProvider = (
  url: URL,
  mount: ManifestMount | undefined,
) => string | undefined | Promise<string | undefined>;

export type MountSelector = (
  mounts: readonly ManifestMount[],
  manifest: Manifest,
) => ManifestMount | string | undefined;

export interface ColpClientOptions {
  readonly manifestUrl: string | URL;
  readonly fetch?: FetchImplementation;
  /**
   * Explicit transport that connects to the supplied approved address while
   * retaining the original URL authority for Host and TLS SNI. When supplied
   * together with resolveHost, this is the only transport that receives the
   * DNS approval. A plain fetch cannot provide the same guarantee.
   */
  readonly pinnedFetch?: PinnedNodeFetch;
  /** Optional transport resolver used to reject DNS answers in private ranges. */
  readonly resolveHost?: ClientHostResolver;
  readonly protocolVersion?: SupportedClientProtocolVersion;
  /** Static caller headers are scoped to the Manifest or selected Mount Origin. */
  readonly headers?: Readonly<Record<string, string>>;
  /** Called on every hop; dynamic credentials without requestIdentityProvider disable caching. */
  readonly credentialProvider?: CredentialProvider;
  /** Captures principal and destination-specific credentials once for the entire public invocation. */
  readonly requestIdentityProvider?: ClientRequestIdentityProvider;
  /**
   * The default Node fetch path also rejects DNS answers in private/local
   * ranges before connecting. Browser and custom-fetch transports can provide
   * `resolveHost` when they expose an equivalent resolver.
   *
   * Called before credentials and fetch for every target and redirect. Without
   * a custom policy, private/local literals are denied except for initial
   * endpoints on the exact origin explicitly selected by manifestUrl. A fetched
   * Manifest cannot grant access to another private origin. Redirects and
   * response-link targets never receive this local-development exception.
   * Pass an explicit policy to authorize other private destinations.
   */
  readonly egressPolicy?: ClientEgressPolicy;
  /** Deployment-selected I-JSON limits, bounded by the package hard ceiling. */
  readonly jsonLimits?: IJsonParseLimits;
  /** Anonymous/static-header cache key; defaults to static-headers. Mutually exclusive with requestIdentityProvider. */
  readonly cachePartition?: string | CachePartitionProvider;
  readonly mountId?: string;
  readonly mountSelector?: MountSelector;
  readonly snapshotLimits?: Partial<SnapshotRetrievalLimits>;
  /** Defaults for every public HTTP operation; individual calls may override. */
  readonly requestLimits?: Partial<ClientRequestLimits>;
  readonly maxRedirects?: number;
  readonly cache?: ClientCache;
  /** Explicit policy for references omitted from cropped Snapshot projections. */
  readonly snapshotReferenceResolution?: SnapshotReferenceResolution;
}

export interface CreateNodeOptions extends ClientRequestOptions {
  readonly idempotencyKey: string;
}

export interface MoveNodeOptions extends CreateNodeOptions {
  readonly ifMatch: string;
}

function requiredHeaderValue(name: string, value: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${name} must be a non-empty HTTP header value.`);
  }
  return value;
}

export class ColpProblemError extends Error {
  readonly problem: Readonly<Problem>;
  readonly status: number;
  readonly code: string;
  readonly known: boolean;
  readonly retryable: boolean | undefined;
  readonly recovery: PublicationProblemClassification['recovery'];

  constructor(problem: Problem) {
    const immutableProblem = deepFreeze(structuredClone(problem));
    const classification = classifyPublicationProblem(immutableProblem);
    super(`${classification.code} (HTTP ${classification.status})`);
    this.name = 'ColpProblemError';
    this.problem = immutableProblem;
    this.status = classification.status;
    this.code = classification.code;
    this.known = classification.known;
    this.retryable = classification.retryable;
    this.recovery = classification.recovery;
  }
}

export type ColpWireValidationStage = 'parse' | 'structural' | 'semantic';

/** A receive-boundary failure that retains the exact validation stage and diagnostics. */
export class ColpWireValidationError extends TypeError {
  readonly stage: ColpWireValidationStage;
  readonly definition: DefinitionName;
  readonly details: Error | readonly unknown[];

  constructor(
    message: string,
    stage: ColpWireValidationStage,
    definition: DefinitionName,
    details: Error | readonly unknown[],
  ) {
    super(message, stage === 'parse' && details instanceof Error ? { cause: details } : undefined);
    this.name = 'ColpWireValidationError';
    this.stage = stage;
    this.definition = definition;
    this.details = details;
  }
}

interface JsonResponse<Value> {
  readonly value: Value;
  readonly headers: Headers;
  readonly url: string;
  readonly bytes: number;
}

interface RequestPolicy {
  readonly identity?: ClientRequestIdentity;
  readonly trustedOrigin: string;
  readonly purpose: ClientRequestPurpose;
  readonly mount?: ManifestMount;
  readonly operation?: HttpOperationContract;
  readonly signal?: AbortSignal;
  readonly maxBytes?: number;
  readonly visitedUrls?: Set<string>;
  readonly body?: string;
  readonly requestHeaders?: Readonly<Record<string, string>>;
  readonly cache?: boolean;
  readonly publicationNavigation?: PublicationNavigationTarget;
}

interface RequestHeaders {
  readonly headers: Headers;
  readonly usedCacheValidator: boolean;
}

interface FetchResult {
  readonly response: Response;
  readonly url: URL;
  readonly usedCacheValidator: boolean;
}

interface PreparedEndpoint {
  readonly url: URL;
  readonly operation: HttpOperationContract;
  readonly definition: DefinitionName;
}

interface SnapshotContext {
  readonly collectionId: string;
  readonly protocolVersion: SupportedClientProtocolVersion;
  readonly initialUrl: URL;
  readonly expectedComplete: boolean;
}

interface SnapshotPageIdentity {
  readonly snapshotId: string;
  readonly revision: string;
  readonly mode: Snapshot['mode'];
  readonly complete: boolean;
  readonly generatedAt: string;
  readonly syncCursor: string | undefined;
  readonly collection: string;
}


const acceptWireSemantics = (_value: unknown): { readonly valid: true; readonly issues: readonly [] } => ({
  valid: true,
  issues: [],
});

function invalidWireDocumentError(
  definition: DefinitionName,
  validation: Exclude<WireJsonDocumentValidationResult<unknown, SemanticIssue>, { valid: true }>,
  cached = false,
): ColpWireValidationError {
  const prefix = cached ? 'Cached response' : 'Response';
  if (validation.stage === 'parse') {
    return new ColpWireValidationError(
      `${prefix} could not be parsed as I-JSON for ${definition}: ${validation.error.message}`,
      validation.stage,
      definition,
      validation.error,
    );
  }
  if (validation.stage === 'semantic') {
    const label = cached
      ? `Cached ${definition}`
      : `${definition[0]?.toUpperCase()}${definition.slice(1)}`;
    return new ColpWireValidationError(
      `${label} semantic validation failed: ${validation.issues[0]?.message}`,
      validation.stage,
      definition,
      validation.issues,
    );
  }
  return new ColpWireValidationError(
    `${prefix} does not satisfy ${definition} at the ${validation.stage} stage: ${validation.errors[0]?.message}`,
    validation.stage,
    definition,
    validation.errors,
  );
}

const redirectStatuses = new Set([301, 302, 303, 307, 308]);
/** Manifest responses are bounded by the discovery route's wire contract. */
export const MAX_PUBLICATION_MANIFEST_RESPONSE_BYTES = 65_536;

function validateIntegerOption(name: string, value: number, minimum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new RangeError(`${name} must be a safe integer greater than or equal to ${minimum}.`);
  }
  return value;
}

function resolveSnapshotLimits(options: Partial<SnapshotRetrievalLimits> | undefined): SnapshotRetrievalLimits {
  return Object.freeze({
    maxPages: validateIntegerOption(
      'snapshotLimits.maxPages',
      options?.maxPages ?? defaultSnapshotRetrievalLimits.maxPages,
      1,
    ),
    maxBytes: validateIntegerOption(
      'snapshotLimits.maxBytes',
      options?.maxBytes ?? defaultSnapshotRetrievalLimits.maxBytes,
      1,
    ),
    maxObjects: validateIntegerOption(
      'snapshotLimits.maxObjects',
      options?.maxObjects ?? defaultSnapshotRetrievalLimits.maxObjects,
      1,
    ),
    timeoutMs: validateIntegerOption(
      'snapshotLimits.timeoutMs',
      options?.timeoutMs ?? defaultSnapshotRetrievalLimits.timeoutMs,
      1,
    ),
  });
}

function normalizeUrl(url: URL): URL {
  const normalized = new URL(url);
  normalized.hash = '';
  return normalized;
}

function requestUrlKey(url: URL): string {
  const normalized = normalizeUrl(url);
  const entries = [...normalized.searchParams.entries()].sort(([leftName, leftValue], [rightName, rightValue]) =>
    leftName.localeCompare(rightName) || leftValue.localeCompare(rightValue));
  normalized.search = '';
  entries.forEach(([name, value]) => normalized.searchParams.append(name, value));
  return normalized.href.replace(/%[0-9a-f]{2}/giu, (value) => value.toUpperCase());
}

function validateRequestUrl(url: URL): void {
  if (url.username !== '' || url.password !== '') {
    throw new TypeError('Request URLs must not contain user information.');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new TypeError(`Unsupported request URL scheme ${url.protocol}`);
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname.toLowerCase());
  if (url.protocol === 'http:' && !loopback) {
    throw new TypeError('Plain HTTP request URLs are allowed only for loopback hosts.');
  }
}

function rejectDowngrade(from: URL, to: URL): void {
  if (from.protocol === 'https:' && to.protocol === 'http:') {
    throw new TypeError(`Refusing HTTPS to HTTP navigation from ${from.origin} to ${to.origin}.`);
  }
}

function isPaginatedRepresentation(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || !('page' in value)) return false;
  const page = value.page;
  return typeof page === 'object' && page !== null && 'hasMore' in page && page.hasMore === true;
}

function snapshotObjectCount(snapshot: Snapshot): number {
  return 1
    + snapshot.nodes.length
    + snapshot.annotations.length
    + snapshot.attachments.length
    + snapshot.relations.length
    + snapshot.tombstones.length;
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('base64url');
}

function headerFingerprint(headers: Headers): string {
  const canonicalHeaders = [...headers.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => `${JSON.stringify(name)}:${JSON.stringify(value)}`)
    .join('\n');
  return digest(canonicalHeaders);
}

function canonicalJson(value: unknown): string {
  const result = canonicalize(value);
  if (result === undefined) throw new TypeError('Snapshot context is not canonical JSON.');
  return result;
}

function validateSnapshotContext(snapshot: Snapshot, context: SnapshotContext): void {
  if (snapshot.protocolVersion !== context.protocolVersion) {
    throw new TypeError(
      `Snapshot protocolVersion ${snapshot.protocolVersion} does not match requested version ${context.protocolVersion}.`,
    );
  }
  if (snapshot.mode !== 'publication') {
    throw new TypeError(`Publication endpoint returned Snapshot mode ${snapshot.mode}.`);
  }
  if (snapshot.collection.id !== context.collectionId) {
    throw new TypeError(
      `Snapshot collection ${snapshot.collection.id} does not match requested collection ${context.collectionId}.`,
    );
  }
  if (snapshot.complete !== context.expectedComplete) {
    throw new TypeError(
      `Snapshot complete=${snapshot.complete} does not match the requested logical query scope.`,
    );
  }
}

function querySelectsCompleteSnapshot(url: URL): boolean {
  if (url.searchParams.has('root') || url.searchParams.has('depth')) return false;
  const include = url.searchParams.getAll('include');
  if (include.length === 0) return true;
  const authoritativeArrays = ['annotations', 'attachments', 'relations'];
  return include.length === authoritativeArrays.length
    && authoritativeArrays.every((name) => include.includes(name));
}

function validateSnapshotPage(
  snapshot: Snapshot,
  context: SnapshotContext,
  identity: SnapshotPageIdentity | undefined,
  expectedSequence: number,
): SnapshotPageIdentity {
  validateSnapshotContext(snapshot, context);
  if (snapshot.page.sequence !== expectedSequence) {
    throw new TypeError(
      `Snapshot page sequence ${snapshot.page.sequence} does not match expected sequence ${expectedSequence}.`,
    );
  }

  const currentIdentity: SnapshotPageIdentity = {
    snapshotId: snapshot.snapshotId,
    revision: snapshot.revision,
    mode: snapshot.mode,
    complete: snapshot.complete,
    generatedAt: snapshot.generatedAt,
    syncCursor: snapshot.syncCursor,
    collection: canonicalJson(snapshot.collection),
  };
  if (
    identity !== undefined
    && (
      currentIdentity.snapshotId !== identity.snapshotId
      || currentIdentity.revision !== identity.revision
      || currentIdentity.mode !== identity.mode
      || currentIdentity.complete !== identity.complete
      || currentIdentity.generatedAt !== identity.generatedAt
      || currentIdentity.syncCursor !== identity.syncCursor
      || currentIdentity.collection !== identity.collection
    )
  ) {
    throw new TypeError('Snapshot page changed logical Snapshot metadata or collection context.');
  }
  return identity ?? currentIdentity;
}

function snapshotNextTarget(
  current: JsonResponse<Snapshot>,
  context: SnapshotContext,
  validators: ValidatorRegistry,
): PublicationNavigationTarget | undefined {
  const next = createPublicationSnapshotNextNavigationTarget({
    currentUrl: new URL(current.url),
    initialUrl: context.initialUrl,
    linkHeader: current.headers.get('link'),
    hasMore: current.value.page.hasMore,
    nextCursor: current.value.page.nextCursor,
    validators,
  });
  if (next === undefined) return undefined;
  const nextUrl = publicationNavigationUrl(next);
  rejectDowngrade(new URL(current.url), nextUrl);
  validateRequestUrl(nextUrl);
  return next;
}

interface PreparedPublicationEndpoint {
  readonly target: PublicationNavigationTarget;
  readonly transportBoundary: PublicationTransportBoundary;
  readonly operation: HttpOperationContract;
  readonly definition: DefinitionName;
}

function cachedRepresentationBytes(value: unknown): number {
  const source = JSON.stringify(value);
  if (source === undefined) {
    throw new TypeError('Cached representation is not JSON serializable.');
  }
  return new TextEncoder().encode(source).byteLength;
}

function assertProtocolJsonResponseMedia(response: Response, definition: DefinitionName): void {
  const expected: ProtocolJsonResponseMedia = definition === 'problem' ? 'problem' : 'json';
  const resource = expected === 'json'
    ? protocolVendorJsonResourceForDefinition(definition) ?? null
    : undefined;
  try {
    parseProtocolJsonResponseMediaType(response.headers.get('content-type'), expected, resource);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'invalid Content-Type';
    const validationError = new ColpWireValidationError(
      `Response for ${definition} has an invalid media type: ${message}`,
      'parse',
      definition,
      error instanceof Error ? error : new TypeError(message),
    );
    cancelResponseBody(response, validationError);
    throw validationError;
  }
}

function deepFreeze<Value>(value: Value, visited = new WeakSet<object>()): Readonly<Value> {
  if (value === null || typeof value !== 'object' || visited.has(value)) return value;
  visited.add(value);
  // Own enumerable string keys only (same set as Object.values; no temp values array).
  for (const key of Object.keys(value as object)) {
    deepFreeze((value as Record<string, unknown>)[key], visited);
  }
  return Object.freeze(value);
}

function immutableSnapshot<Value>(value: Value): Readonly<Value> {
  return deepFreeze(structuredClone(value) as Value);
}

function detachedSnapshot<Value>(value: Readonly<Value>): Value {
  return structuredClone(value) as Value;
}

export class ColpClient {
  readonly #fetch: FetchImplementation;
  readonly #requiresDefaultNodePinning: boolean;
  readonly #hostResolver: ClientHostResolver | undefined;
  readonly #pinnedFetch: PinnedNodeFetch | undefined;
  readonly #manifestUrl: URL;
  readonly #protocolVersion: SupportedClientProtocolVersion;
  readonly #headers: Headers;
  readonly #headerFingerprint: string;
  readonly #credentialProvider: CredentialProvider | undefined;
  readonly #requestIdentityProvider: ClientRequestIdentityProvider | undefined;
  readonly #egressPolicy: ClientEgressPolicy | undefined;
  readonly #jsonLimits: ResolvedIJsonParseLimits & { readonly maxBytes?: number };
  readonly #cachePartition: string | CachePartitionProvider | undefined;
  readonly #mountId: string | undefined;
  readonly #mountSelector: MountSelector | undefined;
  readonly #snapshotLimits: SnapshotRetrievalLimits;
  readonly #requestLimits: ClientRequestLimits;
  readonly #maxRedirects: number;
  readonly #cache: ClientCache | undefined;
  readonly #snapshotReferenceResolution: SnapshotReferenceResolution | undefined;
  readonly #validators: ValidatorRegistry;
  readonly #publicationSnapshotState = new PublicationSnapshotState();
  #manifest?: Manifest;
  #mount?: ManifestMount;

  constructor(options: ColpClientOptions) {
    if (options.pinnedFetch !== undefined && typeof options.pinnedFetch !== 'function') {
      throw new TypeError('pinnedFetch must be a function when provided.');
    }
    if (options.fetch !== undefined && options.resolveHost !== undefined && options.pinnedFetch === undefined) {
      // A resolver alone cannot pin a custom transport's socket.
      throw new TypeError('resolveHost cannot be combined with a custom fetch unless the transport enforces address pinning.');
    }
    this.#requiresDefaultNodePinning = options.fetch === undefined
      && typeof globalThis.process?.versions?.node === 'string';
    this.#fetch = options.fetch ?? globalThis.fetch;
    const pinnedFetch = options.pinnedFetch
      ?? (options.fetch === undefined ? defaultPinnedNodeFetch() : undefined);
    // A custom transport owns DNS policy unless it opts into address pinning.
    const hostResolver = options.resolveHost
      ?? (options.fetch === undefined ? defaultClientHostResolver() : undefined);
    if (hostResolver !== undefined && pinnedFetch === undefined) {
      throw new TypeError('resolveHost requires a transport that enforces address pinning.');
    }
    this.#pinnedFetch = pinnedFetch;
    this.#hostResolver = hostResolver;
    this.#manifestUrl = normalizeUrl(new URL(options.manifestUrl));
    validateRequestUrl(this.#manifestUrl);

    const protocolVersion = options.protocolVersion ?? supportedClientProtocolVersions[0];
    if (!supportedClientProtocolVersions.includes(protocolVersion)) {
      throw new RangeError('Unsupported Collection Protocol version.');
    }
    if (options.mountId !== undefined && options.mountSelector !== undefined) {
      throw new TypeError('Specify either mountId or mountSelector, not both.');
    }

    this.#protocolVersion = protocolVersion;
    this.#headers = parseClientHeaders(options.headers, 'static');
    this.#headerFingerprint = headerFingerprint(this.#headers);
    this.#credentialProvider = options.credentialProvider;
    if (options.requestIdentityProvider !== undefined) {
      if (typeof options.requestIdentityProvider !== 'function') throw new TypeError('requestIdentityProvider must be a function.');
      if (options.credentialProvider !== undefined || options.cachePartition !== undefined) {
        throw new TypeError('requestIdentityProvider cannot be combined with credentialProvider or cachePartition.');
      }
    }
    if (options.cache !== undefined && options.credentialProvider !== undefined && typeof options.cachePartition === 'function') {
      throw new TypeError('Authenticated caching requires requestIdentityProvider to capture credentials and partition together.');
    }
    this.#requestIdentityProvider = options.requestIdentityProvider;
    if (options.egressPolicy !== undefined && typeof options.egressPolicy !== 'function') {
      throw new TypeError('egressPolicy must be a function when provided.');
    }
    this.#egressPolicy = options.egressPolicy;
    const jsonLimits = { ...options.jsonLimits };
    this.#jsonLimits = Object.freeze({
      ...resolveIJsonParseLimits(jsonLimits),
      ...(jsonLimits.maxBytes === undefined ? {} : { maxBytes: jsonLimits.maxBytes }),
    });
    if (typeof options.cachePartition === 'string' && options.cachePartition.length === 0) {
      throw new RangeError('cachePartition must not be empty.');
    }
    // Preserve the legacy static-partition diagnostic; authenticated caching uses one identity snapshot.
    if (
      options.credentialProvider !== undefined
      && typeof options.cachePartition === 'string'
    ) {
      throw new TypeError(
        'cachePartition must be a CachePartitionProvider function when credentialProvider is configured.',
      );
    }
    this.#cachePartition = options.cachePartition;
    this.#mountId = options.mountId;
    this.#mountSelector = options.mountSelector;
    this.#snapshotLimits = resolveSnapshotLimits(options.snapshotLimits);
    this.#requestLimits = resolveClientRequestLimits(options.requestLimits);
    this.#maxRedirects = validateIntegerOption('maxRedirects', options.maxRedirects ?? 5, 0);
    this.#cache = options.cache;
    this.#snapshotReferenceResolution = options.snapshotReferenceResolution;
    this.#validators = createValidatorRegistry();
  }

  #withRequest<Value>(options: ClientRequestOptions, work: (context: ClientRequestContext) => Promise<Value>, ceiling?: number): Promise<Value> {
    return withRequestBudget(this.#requestLimits, options, budget => withClientRequestIdentity(budget, this.#requestIdentityProvider, work), ceiling);
  }

  async discover(force = false, options: ClientRequestOptions = {}): Promise<Manifest> {
    return this.#withRequest(options, async budget => detachedSnapshot((await this.#discover(force, budget)).manifest));
  }

  async #discover(force: boolean, budget: ClientRequestContext): Promise<{ manifest: Manifest; mount: ManifestMount }> {
    if (!force && this.#credentialProvider === undefined && budget.identity === undefined && this.#manifest !== undefined) {
      return { manifest: this.#manifest, mount: this.#mount as ManifestMount };
    }
    const response = await this.#requestJson<Manifest>(this.#manifestUrl, 'manifest', {
      trustedOrigin: this.#manifestUrl.origin,
      purpose: 'manifest',
      ...budget,
      maxBytes: Math.min(budget.maxBytes, MAX_PUBLICATION_MANIFEST_RESPONSE_BYTES),
    }, validateManifestSemantics, [200, 304]);
    if (!response.value.protocolVersions.includes(this.#protocolVersion)) {
      throw new RangeError(`Manifest does not support Collection Protocol version ${this.#protocolVersion}.`);
    }

    const manifest = immutableSnapshot(response.value) as Manifest;
    const mount = this.#selectPublicationMount(manifest);
    budget.signal.throwIfAborted();
    this.#manifest = manifest;
    this.#mount = mount;
    return { manifest, mount };
  }

  async getDirectory(query: DirectoryQuery = {}, options: ClientRequestOptions = {}): Promise<CollectionDirectory> {
    return this.#withRequest(options, async budget => {
      const mount = await this.#publicationMount(budget);
      const request = this.#preparePublicationGet(mount, 'directory', {}, query);
      return (await this.#requestJson<CollectionDirectory>(request.target, request.definition, {
        trustedOrigin: publicationTrustedOrigin(request.transportBoundary),
        purpose: 'publication-read',
        mount,
        operation: request.operation,
        ...budget,
      })).value;
    });
  }

  async getCollection(collectionId: string, options: ClientRequestOptions = {}): Promise<CollectionMetadata> {
    return this.#withRequest(options, async budget => {
      const mount = await this.#publicationMount(budget);
      const request = this.#preparePublicationGet(mount, 'collection', { collectionId }, {});
      return (await this.#requestJson<CollectionMetadata>(request.target, request.definition, {
        trustedOrigin: publicationTrustedOrigin(request.transportBoundary),
        purpose: 'publication-read',
        mount,
        operation: request.operation,
        ...budget,
      }, value => value.collection.id === collectionId
        ? acceptWireSemantics(value)
        : { valid: false, issues: [{
          code: 'collection_identity_mismatch',
          path: '/collection/id',
          message: 'Collection Metadata does not match the requested Collection.',
        }] })).value;
    });
  }

  async getSnapshot(collectionId: string, query: SnapshotQuery = {}, options: ClientRequestOptions = {}): Promise<Snapshot> {
    return this.#withRequest(options, async budget => {
      const mount = await this.#publicationMount(budget);
      const request = this.#preparePublicationGet(mount, 'snapshot', { collectionId }, query);
      const initialUrl = publicationNavigationUrl(request.target);
      if (initialUrl.searchParams.has('pageCursor')) {
        throw new TypeError('getSnapshot must start without pageCursor to assemble a complete page sequence.');
      }

      const visitedUrls = new Set<string>();
      const context: SnapshotContext = {
        collectionId,
        protocolVersion: this.#protocolVersion,
        initialUrl,
        expectedComplete: querySelectsCompleteSnapshot(initialUrl),
      };
      const pages: Snapshot[] = [];
      let totalBytes = 0;
      let totalObjects = 0;
      let nextTarget: PublicationNavigationTarget | undefined = request.target;
      let pageIdentity: SnapshotPageIdentity | undefined;

      while (nextTarget !== undefined) {
        if (pages.length >= this.#snapshotLimits.maxPages) {
          throw new ColpClientLimitError(
            `Snapshot exceeds the page limit of ${this.#snapshotLimits.maxPages}.`,
          );
        }

        const current = await this.#requestJson<Snapshot>(nextTarget, request.definition, {
          trustedOrigin: publicationTrustedOrigin(request.transportBoundary),
          purpose: 'publication-read',
          mount,
          operation: request.operation,
          ...budget,
          maxBytes: Math.min(budget.maxBytes, this.#snapshotLimits.maxBytes - totalBytes),
          visitedUrls,
        }, (snapshot) => validateSnapshotSemantics(
          snapshot,
          snapshot.page.sequence === 1 && !snapshot.page.hasMore
            ? {
                publicationExtensionMode: 'consumer',
                ...(snapshot.complete || this.#snapshotReferenceResolution === undefined
                  ? {}
                  : { referenceResolution: this.#snapshotReferenceResolution }),
              }
            : {
                publicationExtensionMode: 'consumer',
                referenceResolution: { mode: 'deferred' },
              },
        ));
        pageIdentity = validateSnapshotPage(current.value, context, pageIdentity, pages.length + 1);
        totalBytes += current.bytes;
        totalObjects += snapshotObjectCount(current.value);
        if (totalObjects > this.#snapshotLimits.maxObjects) {
          throw new ColpClientLimitError(
            `Snapshot exceeds the object limit of ${this.#snapshotLimits.maxObjects}.`,
          );
        }
        pages.push(current.value);
        nextTarget = snapshotNextTarget(current, context, this.#validators);
      }

      if (pages.length === 1) {
        return pages[0] as Snapshot;
      }
      const firstCollection = (pages[0] as Snapshot).collection;
      const normalizedPages = pages.map((page) => ({ ...page, collection: firstCollection }));
      const assembly = assembleSnapshotPages(normalizedPages, {
        publicationExtensionMode: 'consumer',
        ...(this.#snapshotReferenceResolution === undefined
          ? {}
          : { referenceResolution: this.#snapshotReferenceResolution }),
      });
      if (!assembly.valid) {
        throw new TypeError(`Snapshot assembly failed: ${assembly.issues[0]?.message}`);
      }
      validateSnapshotContext(assembly.snapshot, context);
      return assembly.snapshot;
    }, this.#snapshotLimits.timeoutMs);
  }

  /**
   * Last committed Snapshot for a fixed-context client. Dynamic identity,
   * credential, partition or Mount providers have no synchronous authority to
   * select a safe projection, so they intentionally expose no shared current.
   */
  get currentSnapshot(): Snapshot | undefined {
    return this.#usesRequestScopedSnapshots() ? undefined : this.#publicationSnapshotState.current;
  }

  /** Fixed-context replacement; dynamic clients must retain results in caller-scoped storage. */
  replaceSnapshot(snapshot: Snapshot): Snapshot {
    if (this.#usesRequestScopedSnapshots()) {
      throw new TypeError('Dynamic-context clients cannot replace a shared Snapshot; use caller-scoped storage.');
    }
    return this.#publicationSnapshotState.replace(snapshot);
  }

  /**
   * Retrieve and validate a complete Snapshot. Dynamic contexts use one state
   * per invocation: a superseded load must never substitute another principal's
   * projection, even when Collection IDs or cache partition strings coincide.
   * getSnapshot remains the sole identity-capture point for this invocation.
   */
  async refreshSnapshot(collectionId: string, query: SnapshotQuery = {}, options: ClientRequestOptions = {}): Promise<Snapshot> {
    const state = this.#usesRequestScopedSnapshots()
      ? new PublicationSnapshotState()
      : this.#publicationSnapshotState;
    return state.refresh(() => this.getSnapshot(collectionId, query, options));
  }

  #usesRequestScopedSnapshots(): boolean {
    return this.#requestIdentityProvider !== undefined
      || this.#credentialProvider !== undefined
      || typeof this.#cachePartition === 'function'
      || this.#mountSelector !== undefined;
  }

  async createNode(
    collectionId: string,
    payload: Readonly<CreateNodeOperationPayload>,
    options: CreateNodeOptions,
  ): Promise<Node> {
    const body = buildCreateNodePayload(payload);
    const idempotencyKey = requiredHeaderValue('idempotencyKey', options.idempotencyKey);
    return this.#withRequest(options, async budget => {
      const request = await this.#preparePublisherWrite('nodes', { collectionId }, budget);
      return (await this.#requestJson<Node>(request.url, request.definition, {
        trustedOrigin: new URL(request.mount.baseUrl).origin,
        purpose: 'publisher-write',
        mount: request.mount,
        operation: request.operation,
        ...budget,
        body: JSON.stringify(body),
        requestHeaders: {
          'Idempotency-Key': idempotencyKey,
        },
        cache: false,
      }, node => validateNodeWriteResponse(node, { collectionId, parentId: body.parentId }))).value;
    });
  }

  async moveNode(
    collectionId: string,
    nodeId: string,
    payload: Readonly<MoveOperationPayload>,
    options: MoveNodeOptions,
  ): Promise<NodeMoveResult> {
    const body = buildMoveNodePayload(payload);
    const idempotencyKey = requiredHeaderValue('idempotencyKey', options.idempotencyKey);
    const ifMatch = requiredHeaderValue('ifMatch', options.ifMatch);
    return this.#withRequest(options, async budget => {
      const request = await this.#preparePublisherWrite('nodeMove', { collectionId, nodeId }, budget);
      return (await this.#requestJson<NodeMoveResult>(request.url, request.definition, {
        trustedOrigin: new URL(request.mount.baseUrl).origin,
        purpose: 'publisher-write',
        mount: request.mount,
        operation: request.operation,
        ...budget,
        body: JSON.stringify(body),
        requestHeaders: {
          'Idempotency-Key': idempotencyKey,
          'If-Match': ifMatch,
        },
        cache: false,
      }, result => validateNodeWriteResponse(result.node, {
        collectionId, nodeId, parentId: body.newParentId, position: result.position,
      }, '/node'))).value;
    });
  }

  #selectPublicationMount(manifest: Manifest): ManifestMount {
    const publicationMounts = manifest.mounts.filter(
      (candidate) => candidate.profiles.includes('core') && candidate.profiles.includes('publication'),
    );
    if (publicationMounts.length === 0) {
      throw new RangeError('Manifest has no Mount supporting core + publication.');
    }

    if (this.#mountId !== undefined) {
      const selected = manifest.mounts.find((candidate) => candidate.id === this.#mountId);
      if (selected === undefined) {
        throw new RangeError(`Manifest has no Mount with id ${this.#mountId}.`);
      }
      if (!publicationMounts.includes(selected)) {
        throw new RangeError(`Mount ${this.#mountId} does not support core + publication.`);
      }
      return selected;
    }

    if (this.#mountSelector !== undefined) {
      const selection = this.#mountSelector(Object.freeze([...publicationMounts]), manifest);
      const selectedId = typeof selection === 'string' ? selection : selection?.id;
      const selected = publicationMounts.find((candidate) => candidate.id === selectedId);
      if (selected === undefined) {
        throw new RangeError('mountSelector did not select a core + publication Mount from the Manifest.');
      }
      return selected;
    }

    if (publicationMounts.length > 1) {
      throw new RangeError('Manifest has multiple publication Mounts; configure mountId or mountSelector.');
    }
    return publicationMounts[0] as ManifestMount;
  }

  async #publicationMount(budget: ClientRequestContext): Promise<ManifestMount> {
    return (await this.#discover(false, budget)).mount;
  }

  async #preparePublisherWrite(
    key: 'nodes' | 'nodeMove',
    values: Readonly<Record<string, string>>,
    budget: ClientRequestContext,
  ): Promise<PreparedEndpoint & { readonly mount: ManifestMount }> {
    const mount = await this.#publicationMount(budget);
    if (!mount.profiles.includes('publisher')) {
      throw new RangeError(`Mount ${mount.id} does not support publisher writes.`);
    }
    const contract: EndpointContract = endpointContracts[key];
    const operation = contract.operations.find(
      (candidate) => candidate.method === 'POST' && candidate.profile === 'publisher',
    );
    if (operation?.request === undefined || operation.response === undefined) {
      throw new RangeError(`Endpoint Contract Registry has no publisher POST contract for ${key}.`);
    }
    const variableValidation = validateEndpointVariables(key, values, this.#validators);
    if (!variableValidation.valid) throw new TypeError(variableValidation.errors.join(' '));

    const source = mount.endpoints[key];
    if (typeof source !== 'string') throw new RangeError(`Manifest endpoint ${key} is missing.`);
    if (source.length > MAX_PUBLICATION_ENDPOINT_TEMPLATE_BYTES
      || new TextEncoder().encode(source).byteLength > MAX_PUBLICATION_ENDPOINT_TEMPLATE_BYTES) {
      throw new TypeError('Manifest endpoint template exceeds its byte budget.');
    }
    const url = normalizeUrl(new URL(parseTemplate(source).expand(values)));
    rejectDowngrade(new URL(mount.baseUrl), url);
    validateRequestUrl(url);
    return { url, operation, definition: operation.response as DefinitionName, mount };
  }

  #preparePublicationGet(
    mount: ManifestMount,
    key: 'directory' | 'collection' | 'snapshot',
    values: Readonly<Record<string, string>>,
    query: object,
  ): PreparedPublicationEndpoint {
    const contract: EndpointContract = endpointContracts[key];
    const operation = contract.operations.find(
      (candidate) => candidate.method === 'GET' && candidate.profile === 'publication',
    );
    if (operation?.response === undefined) {
      throw new RangeError(`Endpoint Contract Registry has no publication GET response for ${key}.`);
    }

    const transportBoundary = createPublicationTransportBoundary(mount);
    // Preserve PublicationQueryError (stable message + code + issues); do not rewrap.
    const target = createPublicationEndpointNavigationTarget({
      mount,
      transportBoundary,
      endpoint: key,
      variables: values,
      query,
      validators: this.#validators,
    });

    return {
      target,
      transportBoundary,
      operation,
      definition: operation.response as DefinitionName,
    };
  }

  async #requestHeaders(
    url: URL,
    policy: RequestPolicy,
    conditionalEtag: string | undefined,
  ): Promise<RequestHeaders> {
    const headers = new Headers();
    if (url.origin === policy.trustedOrigin) {
      this.#headers.forEach((value, name) => headers.set(name, value));
    }

    const credentialProvider = policy.identity?.credentialProvider ?? this.#credentialProvider;
    if (credentialProvider !== undefined) {
      const provided = await abortable(
        Promise.resolve(credentialProvider(new URL(url), policy.mount)),
        policy.signal,
      );
      if (provided !== undefined) {
        parseClientHeaders(provided, 'provider').forEach((value, name) => headers.set(name, value));
      }
    }

    if (url.origin === policy.trustedOrigin && policy.requestHeaders !== undefined) {
      parseClientHeaders(policy.requestHeaders, 'operation').forEach((value, name) => headers.set(name, value));
    }

    // Keep the baseline JSON request representation stable; servers may still
    // select the registered vendor representation and the response parser
    // accepts it when returned.
    headers.set('Accept', 'application/json');
    headers.set('Collection-Protocol-Version', this.#protocolVersion);
    if (policy.body !== undefined) headers.set('Content-Type', 'application/json');
    if (conditionalEtag !== undefined) {
      headers.set('If-None-Match', validatePublicationIfNoneMatchEtag(conditionalEtag));
    }
    return { headers, usedCacheValidator: conditionalEtag !== undefined };
  }

  async #authorizeEgress(
    url: URL,
    policy: RequestPolicy,
    previousUrl: URL | null,
    redirectCount: number,
  ): Promise<string | undefined> {
    if (this.#egressPolicy === undefined) {
      let approvedAddress: string | undefined;
      // The fetched Manifest is not authority to select private destinations.
      // Only the origin explicitly supplied by the caller can retain the
      // initial local-development exception, never redirects or response Links.
      const responseLink = policy.publicationNavigation !== undefined
        && publicationNavigationSource(policy.publicationNavigation).kind === 'response-link';
      const privateLiteral = isPrivateOrLocalLiteralHostname(url.hostname);
      const callerSelectedLocalOrigin = redirectCount === 0 && !responseLink
        && url.origin === this.#manifestUrl.origin && privateLiteral;
      if (!callerSelectedLocalOrigin && privateLiteral) {
        throw new TypeError(
          `Egress policy denied ${policy.purpose} request URL: literal private or local host.`,
        );
      }
      if (!callerSelectedLocalOrigin && !privateLiteral && this.#requiresDefaultNodePinning
          && this.#hostResolver === undefined && this.#pinnedFetch === undefined) {
        throw new TypeError(`Egress policy denied ${policy.purpose} request URL: Node DNS pinning capability is unavailable.`);
      }
      if (!callerSelectedLocalOrigin && !privateLiteral && this.#hostResolver !== undefined) {
        let addresses: readonly string[];
        try {
          addresses = await abortable(
            Promise.resolve(this.#hostResolver(url.hostname, policy.signal)),
            policy.signal,
          );
        } catch (error) {
          throw new TypeError(
            `Egress policy denied ${policy.purpose} request URL: DNS resolution failed.`,
            { cause: error },
          );
        }
        if (
          addresses.length === 0
          || addresses.some((address) => typeof address !== 'string'
            || isIP(address) === 0
            || isPrivateOrLocalAddress(address))
        ) {
          throw new TypeError(
            `Egress policy denied ${policy.purpose} request URL: DNS resolved to a private or local address.`,
          );
        }
        // All answers were policy-approved; pin the socket to one concrete
        // answer so DNS cannot change between authorization and connect.
        approvedAddress = addresses[0];
      }
      return approvedAddress;
    }
    const context: ClientEgressPolicyContext = Object.freeze({
      purpose: policy.purpose,
      method: policy.operation?.method ?? 'GET',
      redirectCount,
      previousUrl: previousUrl === null ? null : new URL(previousUrl),
      trustedOrigin: policy.trustedOrigin,
      ...(policy.mount === undefined ? {} : { mountId: policy.mount.id }),
      ...(policy.publicationNavigation === undefined
        ? {}
        : {
            publicationNavigation: Object.freeze({
              source: publicationNavigationSource(policy.publicationNavigation),
              hop: redirectCount === 0 ? 'target' as const : 'redirect' as const,
            }),
          }),
    });
    const allowed = await abortable(
      Promise.resolve(this.#egressPolicy(new URL(url), context)),
      policy.signal,
    );
    if (allowed !== true) {
      throw new TypeError(`Egress policy denied ${policy.purpose} request URL.`);
    }
  }

  async #fetchWithRedirects(
    initialUrl: URL,
    policy: RequestPolicy,
    conditionalEtag: string | undefined,
  ): Promise<FetchResult> {
    const visitedUrls = policy.visitedUrls ?? new Set<string>();
    let current = normalizeUrl(initialUrl);
    let previousUrl: URL | null = null;
    let redirectCount = 0;
    let firstHop = true;

    while (true) {
      policy.signal?.throwIfAborted();
      const key = requestUrlKey(current);
      if (visitedUrls.has(key)) {
        throw new ColpClientLimitError(`Request URL was repeated: ${key}`);
      }
      visitedUrls.add(key);

      const approvedAddress = await this.#authorizeEgress(current, policy, previousUrl, redirectCount);
      policy.signal?.throwIfAborted();
      const requestHeaders = await this.#requestHeaders(
        current,
        policy,
        firstHop ? conditionalEtag : undefined,
      );
      policy.signal?.throwIfAborted();
      const response = await abortable(
        (this.#pinnedFetch !== undefined
          ? this.#pinnedFetch(current, {
            method: policy.operation?.method ?? 'GET',
            headers: requestHeaders.headers,
            redirect: 'manual',
            credentials: current.origin === policy.trustedOrigin ? 'same-origin' : 'omit',
            ...(policy.body === undefined ? {} : { body: policy.body }),
            ...(policy.signal === undefined ? {} : { signal: policy.signal }),
          }, approvedAddress)
          : this.#fetch(current, {
            method: policy.operation?.method ?? 'GET',
            headers: requestHeaders.headers,
            redirect: 'manual',
            credentials: current.origin === policy.trustedOrigin ? 'same-origin' : 'omit',
            ...(policy.body === undefined ? {} : { body: policy.body }),
            ...(policy.signal === undefined ? {} : { signal: policy.signal }),
          })
        ).then(response => {
          if (policy.signal?.aborted) {
            cancelResponseBody(response, policy.signal.reason);
            throw policy.signal.reason;
          }
          return response;
        }),
        policy.signal,
      );

      if (response.redirected || (response.url !== '' && requestUrlKey(new URL(response.url)) !== key)) {
        cancelResponseBody(response, new TypeError('Fetch implementation followed a redirect automatically.'));
        throw new TypeError('Fetch implementation followed a redirect despite redirect: manual.');
      }
      if (!redirectStatuses.has(response.status)) {
        return { response, url: current, usedCacheValidator: requestHeaders.usedCacheValidator };
      }

      cancelResponseBody(response, new TypeError(`Discarding HTTP ${response.status} redirect body.`));

      if (policy.body !== undefined && response.status !== 307 && response.status !== 308) {
        throw new TypeError(
          `Refusing to replay a write request after non-method-preserving HTTP ${response.status} redirect.`,
        );
      }

      const location = response.headers.get('location');
      if (location === null) {
        throw new TypeError(`HTTP ${response.status} redirect is missing Location.`);
      }
      if (redirectCount >= this.#maxRedirects) {
        throw new ColpClientLimitError(`Request exceeds the redirect limit of ${this.#maxRedirects}.`);
      }

      const target = normalizeUrl(new URL(location, current));
      rejectDowngrade(current, target);
      validateRequestUrl(target);
      if (policy.body !== undefined && target.origin !== policy.trustedOrigin) {
        throw new TypeError('Refusing to redirect a write request outside the trusted Mount Origin.');
      }
      previousUrl = current;
      current = target;
      redirectCount += 1;
      firstHop = false;
    }
  }

  async #cacheKey(url: URL, policy: RequestPolicy): Promise<string | undefined> {
    if (this.#cache === undefined) return undefined;

    let partition: string | undefined;
    if (policy.identity !== undefined) {
      partition = policy.identity.cachePartition;
    } else if (typeof this.#cachePartition === 'string') {
      partition = this.#cachePartition;
    } else if (typeof this.#cachePartition === 'function') {
      partition = await abortable(
        Promise.resolve(this.#cachePartition(new URL(url), policy.mount)),
        policy.signal,
      );
    } else if (this.#credentialProvider === undefined) {
      partition = 'static-headers';
    }
    if (partition === undefined || partition.length === 0) return undefined;

    return [
      'colp-cache-v1',
      `protocol=${this.#protocolVersion}`,
      `headers=${this.#headerFingerprint}`,
      `principal=${digest(partition)}`,
      `url=${requestUrlKey(url)}`,
    ].join('|');
  }

  #validateRequiredResponseHeaders(
    response: Response,
    policy: RequestPolicy,
    definition: DefinitionName,
  ): void {
    const required = policy.operation?.requiredResponseHeaders ?? [];
    for (const name of required) {
      if (!response.headers.has(name)) {
        const cause = new TypeError(
          `HTTP ${response.status} response is missing required ${name} header.`,
        );
        const error = new ColpWireValidationError(
          cause.message,
          'structural',
          definition,
          cause,
        );
        cancelResponseBody(response, error);
        throw error;
      }
    }
  }

  async #requestJson<Value>(
    target: URL | PublicationNavigationTarget,
    definition: DefinitionName,
    requestPolicy: RequestPolicy,
    validateSemantics: (value: Value) => SemanticValidationResultLike<SemanticIssue> = acceptWireSemantics,
    allowedStatuses: readonly number[] = requestPolicy.operation?.successStatuses ?? [200],
  ): Promise<JsonResponse<Value>> {
    const publicationNavigation = target instanceof URL ? undefined : target;
    const url = target instanceof URL ? target : publicationNavigationUrl(target);
    const policy: RequestPolicy = publicationNavigation === undefined
      ? requestPolicy
      : Object.freeze({ ...requestPolicy, publicationNavigation });
    policy.signal?.throwIfAborted();
    const cacheKey = policy.cache === false ? undefined : await this.#cacheKey(url, policy);
    policy.signal?.throwIfAborted();
    const cachedSource = this.#cache === undefined || cacheKey === undefined
      ? undefined
      : await abortable(Promise.resolve(this.#cache.get(cacheKey)), policy.signal);
    let cached: ClientCacheEntry | undefined;
    let cachedIsolationError: unknown;
    if (cachedSource !== undefined) {
      try {
        const etag = validatePublicationIfNoneMatchEtag(cachedSource.etag);
        const bytes = cachedRepresentationBytes(cachedSource.representation);
        if (policy.maxBytes !== undefined && bytes > policy.maxBytes) {
          throw new ColpClientLimitError('Cached response exceeds the response byte limit of ' + policy.maxBytes + '.');
        }
        cached = Object.freeze({
          etag,
          representation: immutableSnapshot(cachedSource.representation),
        });
      } catch (error) {
        cachedIsolationError = error;
      }
    }
    let conditionalEtag: string | undefined;
    if (cachedSource !== undefined && !isPaginatedRepresentation(cachedSource.representation)) {
      conditionalEtag = validatePublicationIfNoneMatchEtag(cachedSource.etag);
    }
    const { response, url: finalUrl, usedCacheValidator } = await this.#fetchWithRedirects(
      url,
      policy,
      conditionalEtag,
    );
    // A redirect crosses the cache key's request URL boundary.  Never bind a
    // response from the final origin to the original URL, and never satisfy a
    // redirected 304 from the original URL's representation (which could be
    // a stale entry written by an older client).  Delete the old entry so a
    // subsequent request cannot replay it.
    const redirectedResponse = finalUrl.href !== url.href;
    const responseCacheKey = redirectedResponse ? undefined : cacheKey;
    if (redirectedResponse && this.#cache !== undefined && cacheKey !== undefined) {
      await abortable(Promise.resolve(this.#cache.delete(cacheKey)), policy.signal);
      if (response.status === 304) {
        cancelResponseBody(response, new TypeError('Redirected responses cannot revalidate the original cache entry.'));
        throw new TypeError('Received a redirected 304 response without an origin-bound cache entry.');
      }
    }

    if (response.status === 304 && !allowedStatuses.includes(304)) {
      cancelResponseBody(response, new TypeError(`Unexpected HTTP 304 for ${definition}.`));
      throw new TypeError(`HTTP 304 is not an allowed success status for ${definition}.`);
    }
    if (!allowedStatuses.includes(response.status)) {
      if (response.ok) {
        cancelResponseBody(response, new TypeError(`Unexpected HTTP ${response.status} for ${definition}.`));
        throw new TypeError(
          `HTTP ${response.status} is not an allowed success status for ${definition}.`,
        );
      }
    }
    if (allowedStatuses.includes(response.status) && (response.ok || response.status === 304)) {
      this.#validateRequiredResponseHeaders(response, policy, definition);
    }
    if (response.status === 304) {
      if (!usedCacheValidator) {
        throw new TypeError('Received 304 after a request that did not carry the cached If-None-Match validator.');
      }
      if (cachedIsolationError !== undefined) throw cachedIsolationError;
      if (cached === undefined) throw new TypeError('Received 304 without a cached representation.');
      const responseEtag = response.headers.get('etag');
      if (responseEtag === null || validatePublicationIfNoneMatchEtag(responseEtag) !== cached.etag) {
        throw new TypeError('Received 304 with an ETag that does not match the cached representation.');
      }
      const validation = validateWireDocument(
        this.#validators,
        definition,
        cached.representation,
        validateSemantics,
      );
      if (!validation.valid) {
        if (this.#cache !== undefined && cacheKey !== undefined) {
          await abortable(Promise.resolve(this.#cache.delete(cacheKey)), policy.signal);
        }
        throw invalidWireDocumentError(definition, validation, true);
      }
      const bytes = cachedRepresentationBytes(cached.representation);
      if (policy.maxBytes !== undefined && bytes > policy.maxBytes) {
        throw new ColpClientLimitError(
          `Cached response exceeds the response byte limit of ${policy.maxBytes}.`,
        );
      }
      await abortable(updatePublicationResponseCache(this.#cache, responseCacheKey, response.headers), policy.signal);
      return {
        value: detachedSnapshot(cached.representation as Readonly<Value>),
        headers: response.headers,
        url: finalUrl.href,
        bytes,
      };
    }

    const responseDefinition: DefinitionName = response.ok && allowedStatuses.includes(response.status)
      ? definition
      : 'problem';
    assertProtocolJsonResponseMedia(response, responseDefinition);
    const body = await readResponseBody(response, policy.maxBytes, policy.signal);
    if (!body.validUtf8) {
      const failedDefinition: DefinitionName = !response.ok || !allowedStatuses.includes(response.status)
        ? 'problem'
        : definition;
      const message = failedDefinition === 'problem'
        ? 'Problem response body is not valid UTF-8.'
        : `Response body for ${failedDefinition} is not valid UTF-8.`;
      throw new ColpWireValidationError(
        failedDefinition === 'problem'
          ? `HTTP ${response.status} returned an invalid Problem Details document at the parse stage: ${message}`
          : message,
        'parse',
        failedDefinition,
        new TypeError(message),
      );
    }
    if (!response.ok || !allowedStatuses.includes(response.status)) {
      const problem = validateWireJsonDocument(
        this.#validators,
        'problem',
        body.source,
        (value: Problem) => validatePublicationProblemSemantics(value, {
          httpStatus: response.status,
          contentType: response.headers.get('content-type'),
        }),
        this.#jsonLimits,
      );
      if (problem.valid) throw new ColpProblemError(problem.value as Problem);
      const error = invalidWireDocumentError('problem', problem);
      throw new ColpWireValidationError(
        `HTTP ${response.status} returned an invalid Problem Details document at the ${error.stage} stage: ${error.message}`,
        error.stage,
        error.definition,
        error.details,
      );
    }
    let value: unknown;
    try {
      value = parseIJson(body.source, this.#jsonLimits);
    } catch (error) {
      throw invalidWireDocumentError(definition, {
        valid: false,
        stage: 'parse',
        error: error instanceof Error ? error : new TypeError(String(error)),
      });
    }
    if (definition === 'manifest') {
      assertPublicationManifestQueryUrlTexts(value);
    }
    const validation = validateWireDocument(
      this.#validators,
      definition,
      value,
      validateSemantics,
    );
    if (!validation.valid) {
      throw invalidWireDocumentError(definition, validation);
    }
    policy.signal?.throwIfAborted();
    const representation = immutableSnapshot(validation.value);
    await abortable(
      updatePublicationResponseCache(this.#cache, responseCacheKey, response.headers, representation),
      policy.signal,
    );
    return {
      value: detachedSnapshot(representation),
      headers: response.headers,
      url: finalUrl.href,
      bytes: body.bytes,
    };
  }
}
