import { isProxy } from 'node:util/types';

import {
  cloneAndFreezeJsonData,
  validateWireDocument,
  type DefinitionName,
  type ValidatorRegistry,
} from '../schema/index.js';
import {
  decodePublicationQuery,
  type PublicationQueryEndpoint,
} from '../shared/publication-query.js';
import {
  createPublicationCachePolicy,
  type PublicationCacheControlHeaderValue,
  type PublicationVaryHeaderValue,
} from './publication-cache-policy.js';
import { mergePublicationVary } from './publication-vary.js';
import { evaluatePublicationConditionalGet } from './publication-conditional-get.js';
import { createPublicationRepresentationHttpHeaders } from './publication-http-headers.js';
import {
  PUBLICATION_JSON_MEDIA_TYPE,
  publicationUtf8JsonBytes,
} from './publication-http-utf8.js';
import {
  createPublicationProblemDescriptor,
  PUBLICATION_PROBLEM_CONTENT_TYPE,
} from './publication-problems.js';
import { assertAnonymousPublicationPrimaryVisibility } from './publication-anonymous-visibility.js';
import {
  projectPublicationPublicWire,
  type PublicationPublicWireOptions,
} from './publication-public-projection.js';
import type {
  PublicationEtagJsonValue,
  PublicationEtagQueryContract,
  PublicationPageEtagIdentity,
  PublicationSnapshotEtagIdentity,
} from './publication-representation-etag.js';
import type { ProblemCode } from './problems.js';
import type { Snapshot } from '../types/index.js';
import { finalizePublicationSnapshotWire } from './publication-snapshot-wire.js';

export type PublicationHttpReadEndpoint = 'manifest' | 'directory' | 'metadata' | 'snapshot' | 'node';
export type PublicationHttpReadMethod = 'GET' | 'HEAD';

interface PublicationHttpReadRepresentationBase {
  /** Trusted model selected after query decoding and authorization. */
  readonly value: unknown;
  readonly revision: string;
  readonly projectionKey: string;
  readonly protocolVersion: string;
  readonly lastModified: Date;
  readonly negotiatedMediaType?: string;
  readonly snapshotIdentity?: PublicationSnapshotEtagIdentity;
  readonly pageIdentity?: PublicationPageEtagIdentity;
  /** Representation-specific headers such as Link. ETag and cache headers are generated later. */
  readonly headers?: Headers | [string, string][] | Record<string, string>;
  readonly cacheControl?: PublicationCacheControlHeaderValue;
  readonly vary?: PublicationVaryHeaderValue;
}

export interface AnonymousPublicationHttpReadRepresentation
  extends PublicationHttpReadRepresentationBase {
  /** Anonymous representations must never carry an authorization partition. */
  readonly principalScope?: never;
}

export interface AuthorizedPublicationHttpReadRepresentation
  extends PublicationHttpReadRepresentationBase {
  /** Required partition for every authorization-varying representation. */
  readonly principalScope: string;
}

export type PublicationHttpReadRepresentation =
  | AnonymousPublicationHttpReadRepresentation
  | AuthorizedPublicationHttpReadRepresentation;

export interface PublicationHttpReadAuthorizationAllowed<Context> {
  readonly allowed: true;
  readonly context: Context;
}

export interface PublicationHttpReadAuthorizationDenied {
  readonly allowed: false;
  /** Concealment policy chooses whether denial is visible as 403 or hidden as 404. */
  readonly problem: 'insufficient_scope' | 'resource_not_found';
}

export type PublicationHttpReadAuthorizationDecision<Context> =
  | PublicationHttpReadAuthorizationAllowed<Context>
  | PublicationHttpReadAuthorizationDenied;

interface PublicationHttpReadCommonInput {
  readonly endpoint: PublicationHttpReadEndpoint;
  readonly method: PublicationHttpReadMethod;
  /** Raw URL search including or excluding the leading question mark. */
  readonly rawSearch: string;
  readonly validators: ValidatorRegistry;
  readonly ifNoneMatch?: string | null;
}

export interface AnonymousPublicationHttpReadInput extends PublicationHttpReadCommonInput {
  readonly access: 'anonymous-public';
  readonly publicProjection?: PublicationPublicWireOptions;
  readonly resolveRepresentation: (
    query: Readonly<Record<string, unknown>>,
  ) => AnonymousPublicationHttpReadRepresentation | Promise<AnonymousPublicationHttpReadRepresentation>;
}

export interface AuthorizedPublicationHttpReadInput<Context = unknown> extends PublicationHttpReadCommonInput {
  readonly access: 'authorized-private';
  readonly authorize: (
    query: Readonly<Record<string, unknown>>,
  ) => PublicationHttpReadAuthorizationDecision<Context>
    | Promise<PublicationHttpReadAuthorizationDecision<Context>>;
  readonly resolveRepresentation: (
    query: Readonly<Record<string, unknown>>,
    context: Context,
  ) => AuthorizedPublicationHttpReadRepresentation | Promise<AuthorizedPublicationHttpReadRepresentation>;
}

export type PublicationHttpReadInput<Context = unknown> =
  | AnonymousPublicationHttpReadInput
  | AuthorizedPublicationHttpReadInput<Context>;

/**
 * Compose one Publication JSON read without binding to a server framework.
 *
 * The callback shape makes the security order structural: no representation
 * can be loaded before query decoding, and an authorized provider cannot be
 * called without an allowed authorization context. Projection and strict JSON
 * serialization happen before the ETag, cache policy, conditional evaluation,
 * and final GET/HEAD body decision.
 */
export async function composePublicationHttpRead<Context = unknown>(
  input: PublicationHttpReadInput<Context>,
): Promise<Response> {
  const safeInput = inspectReadInput(input);
  let decoded: DecodedReadQuery;
  try {
    decoded = decodeReadQuery(safeInput.endpoint, safeInput.rawSearch, safeInput.validators);
  } catch {
    return problemResponse('internal_error', safeInput.method);
  }
  if (!decoded.valid) return problemResponse('invalid_query', safeInput.method);

  let selected: PublicationHttpReadRepresentation;
  let cacheKind: 'anonymous-public' | 'authorization-varying';
  if (safeInput.access === 'anonymous-public') {
    selected = await safeInput.resolveRepresentation(decoded.value);
    cacheKind = 'anonymous-public';
  } else {
    const decision = inspectAuthorizationDecision(await safeInput.authorize(decoded.value));
    if (!decision.allowed) return problemResponse(decision.problem, safeInput.method);
    selected = await safeInput.resolveRepresentation(decoded.value, decision.context);
    cacheKind = 'authorization-varying';
  }

  try {
    const representation = inspectRepresentation(selected);
    assertPrincipalPartition(safeInput.access, representation);
    let projected = safeInput.access === 'anonymous-public'
      ? projectPublicationPublicWire(representation.value, safeInput.publicProjection)
      : cloneAndFreezeJsonData(representation.value);
    if (safeInput.access === 'anonymous-public') {
      // Public redaction removes secrets and sidecars, while this separate
      // graph guard rejects restricted primary resources whose references
      // cannot safely be dropped from an anonymous response.
      assertAnonymousPublicationPrimaryVisibility(projected);
    }
    const validation = validateWireDocument<unknown, never>(
      safeInput.validators,
      responseDefinitionFor(safeInput.endpoint),
      projected,
      () => ({ valid: true, issues: [] }),
    );
    if (!validation.valid) {
      throw new TypeError('Publication HTTP read representation is not wire-valid.');
    }
    if (safeInput.endpoint === 'snapshot') {
      projected = finalizePublicationSnapshotWire(projected as Readonly<Snapshot>);
    }
    const bytes = publicationUtf8JsonBytes(projected);
    const mediaType = representation.negotiatedMediaType ?? PUBLICATION_JSON_MEDIA_TYPE;
    const queryContract = queryContractFor(safeInput.endpoint);
    const query = decoded.value as Readonly<Record<string, PublicationEtagJsonValue>>;
    const initialHeaders = new Headers(representation.headers);
    const callerVary = initialHeaders.get('vary') ?? undefined;
    // These fields are owned by the composition boundary. Callers can only
    // influence cache policy through the typed cacheControl/vary fields.
    for (const name of ['cache-control', 'content-length', 'content-type', 'etag', 'last-modified', 'vary']) {
      initialHeaders.delete(name);
    }
    initialHeaders.set('content-type', mediaType);
    initialHeaders.set('content-length', String(bytes.byteLength));

    const headers = createPublicationRepresentationHttpHeaders({
      representation: bytes,
      revision: representation.revision,
      projectionKey: representation.projectionKey,
      queryContract,
      query,
      negotiatedMediaType: mediaType,
      protocolVersion: representation.protocolVersion,
      ...(representation.snapshotIdentity === undefined ? {} : { snapshotIdentity: representation.snapshotIdentity }),
      ...(representation.pageIdentity === undefined ? {} : { pageIdentity: representation.pageIdentity }),
      ...(representation.principalScope === undefined ? {} : { principalScope: representation.principalScope }),
      lastModified: representation.lastModified,
      headers: initialHeaders,
    });
    const cache = createPublicationCachePolicy({
      kind: cacheKind,
      ...(representation.cacheControl === undefined ? {} : { existingCacheControl: representation.cacheControl }),
      existingVary: combinePublicationVary(
        headers.get('vary') ?? undefined,
        combinePublicationVary(callerVary, representation.vary),
      ),
    });
    if (cache['Cache-Control'] !== undefined) headers.set('cache-control', cache['Cache-Control']);
    if (cache.Vary !== undefined) headers.set('vary', cache.Vary);

    const etag = headers.get('etag');
    if (etag === null) throw new TypeError('Publication ETag generation failed.');
    const conditional = evaluatePublicationConditionalGet({
      ifNoneMatch: safeInput.ifNoneMatch,
      etag,
    });
    const body = conditional.status === 304 || safeInput.method === 'HEAD' ? null : bytes;
    return new Response(body, { status: conditional.status, headers });
  } catch {
    return problemResponse('internal_error', safeInput.method);
  }
}

type DecodedReadQuery =
  | { readonly valid: true; readonly value: Readonly<Record<string, unknown>> }
  | { readonly valid: false };

function decodeReadQuery(
  endpoint: PublicationHttpReadEndpoint,
  rawSearch: string,
  validators: ValidatorRegistry,
): DecodedReadQuery {
  const queryEndpoint = queryEndpointFor(endpoint);
  if (queryEndpoint === null) {
    return rawSearch === '' || rawSearch === '?'
      ? { valid: true, value: Object.freeze({}) }
      : { valid: false };
  }
  const decoded = decodePublicationQuery(queryEndpoint, rawSearch, validators);
  return decoded.valid
    ? { valid: true, value: decoded.value }
    : { valid: false };
}

function queryEndpointFor(endpoint: PublicationHttpReadEndpoint): PublicationQueryEndpoint | null {
  if (endpoint === 'manifest') return null;
  if (endpoint === 'metadata') return 'collection';
  return endpoint;
}

function queryContractFor(endpoint: PublicationHttpReadEndpoint): PublicationEtagQueryContract {
  if (endpoint === 'directory') return 'directoryQuery';
  if (endpoint === 'snapshot') return 'snapshotQuery';
  if (endpoint === 'node') return 'nodeDetailQuery';
  return 'none';
}

function responseDefinitionFor(endpoint: PublicationHttpReadEndpoint): DefinitionName {
  if (endpoint === 'directory') return 'collectionDirectory';
  if (endpoint === 'metadata') return 'collectionMetadata';
  if (endpoint === 'snapshot') return 'snapshot';
  if (endpoint === 'node') return 'nodeDetail';
  return 'manifest';
}

function inspectReadInput<Context>(input: PublicationHttpReadInput<Context>): PublicationHttpReadInput<Context> {
  if (typeof input !== 'object' || input === null || Array.isArray(input) || isProxy(input)) {
    throw new TypeError('Publication HTTP read input must be an object.');
  }
  const accessDescriptor = Object.getOwnPropertyDescriptor(input, 'access');
  if (accessDescriptor === undefined || !accessDescriptor.enumerable || !('value' in accessDescriptor)) {
    throw new TypeError('Publication HTTP read access mode is invalid.');
  }
  const allowed = accessDescriptor.value === 'anonymous-public'
    ? new Set(['access', 'endpoint', 'method', 'rawSearch', 'validators', 'ifNoneMatch', 'publicProjection', 'resolveRepresentation'])
    : new Set(['access', 'endpoint', 'method', 'rawSearch', 'validators', 'ifNoneMatch', 'authorize', 'resolveRepresentation']);
  assertEnumerableDataProperties(input, allowed, 'Publication HTTP read input');
  const copy = copyOwnDataProperties(input) as unknown as PublicationHttpReadInput<Context>;
  if (!['manifest', 'directory', 'metadata', 'snapshot', 'node'].includes(copy.endpoint)) {
    throw new TypeError('Publication HTTP read endpoint is invalid.');
  }
  if (copy.method !== 'GET' && copy.method !== 'HEAD') {
    throw new TypeError('Publication HTTP read method must be GET or HEAD.');
  }
  if (copy.access !== 'anonymous-public' && copy.access !== 'authorized-private') {
    throw new TypeError('Publication HTTP read access mode is invalid.');
  }
  if (typeof copy.rawSearch !== 'string') {
    throw new TypeError('Publication HTTP read query must be a string.');
  }
  if (!hasDataFunction(copy.validators, 'validate')) {
    throw new TypeError('Publication HTTP read validators are invalid.');
  }
  if (typeof copy.resolveRepresentation !== 'function') {
    throw new TypeError('Publication HTTP read resolver must be a function.');
  }
  if (copy.access === 'authorized-private' && typeof copy.authorize !== 'function') {
    throw new TypeError('Publication HTTP read authorizer must be a function.');
  }
  return Object.freeze(copy);
}

function hasDataFunction(value: unknown, key: string): boolean {
  if (typeof value !== 'object' || value === null) return false;
  let current: object | null = value;
  while (current !== null) {
    if (isProxy(current)) return false;
    const descriptor = Object.getOwnPropertyDescriptor(current, key);
    if (descriptor !== undefined) return 'value' in descriptor && typeof descriptor.value === 'function';
    current = Object.getPrototypeOf(current) as object | null;
  }
  return false;
}

function inspectAuthorizationDecision<Context>(
  decision: PublicationHttpReadAuthorizationDecision<Context>,
): PublicationHttpReadAuthorizationDecision<Context> {
  if (typeof decision !== 'object' || decision === null || Array.isArray(decision) || isProxy(decision)) {
    throw new TypeError('Authorization decision must be a non-Proxy object.');
  }
  const allowedDescriptor = Object.getOwnPropertyDescriptor(decision, 'allowed');
  if (allowedDescriptor === undefined || !allowedDescriptor.enumerable || !('value' in allowedDescriptor)) {
    throw new TypeError('Authorization decision must have an enumerable data property "allowed".');
  }
  if (allowedDescriptor.value === true) {
    assertEnumerableDataProperties(decision, new Set(['allowed', 'context']), 'Publication authorization decision');
    if (Object.hasOwn(decision, 'context')) {
      return Object.freeze(copyOwnDataProperties(decision)) as unknown as PublicationHttpReadAuthorizationDecision<Context>;
    }
  }
  if (allowedDescriptor.value === false) {
    assertEnumerableDataProperties(decision, new Set(['allowed', 'problem']), 'Publication authorization decision');
    const problem = Object.getOwnPropertyDescriptor(decision, 'problem');
    if (problem !== undefined && 'value' in problem
      && (problem.value === 'insufficient_scope' || problem.value === 'resource_not_found')) {
      return Object.freeze(copyOwnDataProperties(decision)) as unknown as PublicationHttpReadAuthorizationDecision<Context>;
    }
  }
  throw new TypeError('Authorization decision has an invalid "allowed" value.');
}

function assertPrincipalPartition(
  access: PublicationHttpReadInput['access'],
  representation: PublicationHttpReadRepresentation,
): void {
  if (access === 'authorized-private') {
    if (typeof representation.principalScope !== 'string' || representation.principalScope.length === 0) {
      throw new TypeError('Authorized Publication representations require principalScope.');
    }
  } else if (representation.principalScope !== undefined) {
    throw new TypeError('Anonymous Publication representations must not include principalScope.');
  }
}

function combinePublicationVary(
  headerVary: string | undefined,
  representationVary: PublicationVaryHeaderValue | undefined,
): string | undefined {
  const values: string[] = [];
  if (headerVary !== undefined) values.push(headerVary);
  if (typeof representationVary === 'string') values.push(representationVary);
  else if (representationVary !== undefined) values.push(...representationVary);
  return values.length === 0 ? undefined : mergePublicationVary(values, []);
}

function inspectRepresentation(value: PublicationHttpReadRepresentation): PublicationHttpReadRepresentation {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || isProxy(value)) {
    throw new TypeError('Publication HTTP read representation must be an object.');
  }
  const keys = new Set([
    'value', 'revision', 'projectionKey', 'protocolVersion', 'lastModified', 'negotiatedMediaType',
    'snapshotIdentity', 'pageIdentity', 'principalScope', 'headers', 'cacheControl', 'vary',
  ]);
  assertEnumerableDataProperties(value, keys, 'Publication HTTP read representation');
  const copy = copyOwnDataProperties(value) as unknown as PublicationHttpReadRepresentation;
  if (!(copy.lastModified instanceof Date)) throw new TypeError('Publication lastModified must be a Date.');
  const headers = copy.headers === undefined ? undefined : snapshotHeaders(copy.headers);
  const cacheControl = snapshotHeaderValue(copy.cacheControl, 'cacheControl');
  const vary = snapshotHeaderValue(copy.vary, 'vary');
  const snapshotIdentity = snapshotIdentityObject(copy.snapshotIdentity, 'snapshotIdentity', new Set(['snapshotId', 'sequence']));
  const pageIdentity = snapshotIdentityObject(copy.pageIdentity, 'pageIdentity', new Set(['pageCursor', 'pageNumber', 'key']));
  return Object.freeze({
    ...copy,
    lastModified: new Date(Date.prototype.getTime.call(copy.lastModified)),
    ...(headers === undefined ? {} : { headers }),
    ...(cacheControl === undefined ? {} : { cacheControl }),
    ...(vary === undefined ? {} : { vary }),
    ...(snapshotIdentity === undefined ? {} : { snapshotIdentity }),
    ...(pageIdentity === undefined ? {} : { pageIdentity }),
  });
}

function snapshotHeaders(value: NonNullable<PublicationHttpReadRepresentation['headers']>): Headers {
  if (isProxy(value)) throw new TypeError('Publication response headers must not be a Proxy.');
  const entries: [string, string][] = [];
  if (value instanceof Headers) {
    for (const [name, fieldValue] of Headers.prototype.entries.call(value)) entries.push([name, fieldValue]);
  } else if (Array.isArray(value)) {
    assertDenseDataArray(value, 'Publication response headers');
    for (let index = 0; index < value.length; index += 1) {
      const entry = readArrayDataElement(value, index);
      if (!Array.isArray(entry) || isProxy(entry)) throw new TypeError('Publication response headers are invalid.');
      assertDenseDataArray(entry, 'Publication response header entry');
      const name = readArrayDataElement(entry, 0);
      const fieldValue = readArrayDataElement(entry, 1);
      if (entry.length !== 2 || typeof name !== 'string' || typeof fieldValue !== 'string') {
        throw new TypeError('Publication response headers are invalid.');
      }
      entries.push([name, fieldValue]);
    }
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('Publication response headers are invalid.');
    }
    assertEnumerableDataProperties(value, new Set(Object.keys(value)), 'Publication response headers');
    for (const key of Object.keys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key) as PropertyDescriptor & { value: unknown };
      if (typeof descriptor.value !== 'string') throw new TypeError('Publication response headers are invalid.');
      entries.push([key, descriptor.value]);
    }
  }
  try {
    return new Headers(entries);
  } catch {
    throw new TypeError('Publication response headers are invalid.');
  }
}

function snapshotHeaderValue(
  value: PublicationCacheControlHeaderValue | PublicationVaryHeaderValue | undefined,
  label: string,
): PublicationCacheControlHeaderValue | PublicationVaryHeaderValue | undefined {
  if (value === undefined || typeof value === 'string') return value;
  if (!Array.isArray(value) || isProxy(value)) throw new TypeError(`Publication ${label} is invalid.`);
  assertDenseDataArray(value, `Publication ${label}`);
  const snapshot: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const item = readArrayDataElement(value, index);
    if (typeof item !== 'string') throw new TypeError(`Publication ${label} is invalid.`);
    snapshot.push(item);
  }
  return Object.freeze(snapshot);
}

function snapshotIdentityObject<T extends object>(
  value: T | undefined,
  label: string,
  allowed: ReadonlySet<string>,
): Readonly<T> | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'object' || value === null || Array.isArray(value) || isProxy(value)) {
    throw new TypeError(`Publication ${label} is invalid.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError(`Publication ${label} is invalid.`);
  assertEnumerableDataProperties(value, allowed, `Publication ${label}`);
  return Object.freeze(copyOwnDataProperties(value)) as Readonly<T>;
}

function assertDenseDataArray(value: readonly unknown[], label: string): void {
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== 'string' || (key !== 'length' && !/^(0|[1-9]\d*)$/u.test(key)))) {
    throw new TypeError(`${label} is invalid.`);
  }
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
      throw new TypeError(`${label} is invalid.`);
    }
  }
}

function readArrayDataElement(value: readonly unknown[], index: number): unknown {
  return (Object.getOwnPropertyDescriptor(value, String(index)) as PropertyDescriptor & { value: unknown }).value;
}

function assertEnumerableDataProperties(value: object, allowed: ReadonlySet<string>, label: string): void {
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowed.has(key)) throw new TypeError(`${label} contains an unsupported field.`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
      throw new TypeError(`${label} fields must be enumerable data properties.`);
    }
  }
}

function copyOwnDataProperties(value: object): Record<string, unknown> {
  const copy: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key) as PropertyDescriptor & { value: unknown };
    copy[key] = descriptor.value;
  }
  return copy;
}

function problemResponse(code: ProblemCode, method: PublicationHttpReadMethod): Response {
  const descriptor = createPublicationProblemDescriptor({ code });
  const bytes = publicationUtf8JsonBytes(descriptor.problem);
  const headers = new Headers({
    'content-type': PUBLICATION_PROBLEM_CONTENT_TYPE,
    'content-length': String(bytes.byteLength),
    'cache-control': 'private, no-store',
  });
  return new Response(method === 'HEAD' ? null : bytes, {
    status: descriptor.status,
    headers,
  });
}
