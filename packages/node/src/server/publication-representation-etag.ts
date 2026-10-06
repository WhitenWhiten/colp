import { createHash, type Hash } from 'node:crypto';
import canonicalize from 'canonicalize';

import { hasWellFormedUtf16 } from '../shared/utf16.js';

const CONTEXT = Buffer.from('collection-protocol/publication/representation-etag/sha-256/v1', 'ascii');
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f]/u;
const NULL_CHARACTER_PATTERN = /\u0000/u;
const MAX_IDENTITY_FIELD_BYTES = 16 * 1024;
const MAX_MEDIA_TYPE_BYTES = 4 * 1024;
const MAX_CANONICAL_QUERY_BYTES = 1024 * 1024;
const MAX_QUERY_DEPTH = 64;
const MAX_QUERY_VALUES = 16 * 1024;
const INCLUDE_CONTRACTS = new Set<PublicationEtagQueryContract>(['snapshotQuery', 'nodeDetailQuery']);
const MEDIA_TYPE_TOKEN_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u;

export type PublicationEtagQueryContract = 'none' | 'directoryQuery' | 'snapshotQuery' | 'nodeDetailQuery';

export type PublicationEtagJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly PublicationEtagJsonValue[]
  | { readonly [key: string]: PublicationEtagJsonValue };

export interface PublicationSnapshotEtagIdentity {
  readonly snapshotId: string;
  readonly sequence: number;
}

export interface PublicationPageEtagIdentity {
  readonly pageCursor?: string;
  readonly pageNumber?: number;
  readonly key?: string;
}

export interface PublicationRepresentationEtagInput {
  /** Exact bytes sent in the selected representation; strings are encoded as UTF-8. */
  readonly representation: string | Uint8Array;
  readonly revision: string;
  readonly projectionKey: string;
  /** Contract for the already decoded and validated query DTO. */
  readonly queryContract: PublicationEtagQueryContract;
  readonly query: Readonly<Record<string, PublicationEtagJsonValue>>;
  /** Actual selected response media type, not the request's raw Accept value. */
  readonly negotiatedMediaType: string;
  readonly protocolVersion: string;
  readonly snapshotIdentity?: PublicationSnapshotEtagIdentity;
  readonly pageIdentity?: PublicationPageEtagIdentity;
  /**
   * Optional domain-separated principal / authorization scope for the selected
   * representation. Authorization-varying responses should supply
   * `principalScope` or fold the principal into `projectionKey` so distinct
   * principals cannot share a strong ETag for different bodies. Omitted values
   * are not hashed, preserving legacy tags for principal-agnostic inputs.
   */
  readonly principalScope?: string;
}

/**
 * Creates a quoted strong ETag for one concrete Publication representation.
 * Authorization-varying responses should provide `principalScope` or encode the
 * principal into `projectionKey`.
 */
export function createPublicationRepresentationEtag(input: PublicationRepresentationEtagInput): string {
  assertRecord(input, 'Publication representation ETag input');
  const representation = encodeRepresentation(input.representation);
  const revision = encodeIdentityField('revision', input.revision);
  const projection = encodeIdentityField('projectionKey', input.projectionKey);
  const queryContract = encodeQueryContract(input.queryContract);
  const query = canonicalizeQuery(input.queryContract, input.query);
  const mediaType = encodeNegotiatedMediaType(input.negotiatedMediaType);
  const protocolVersion = encodeIdentityField('protocolVersion', input.protocolVersion);

  const hash = createHash('sha256');
  updateField(hash, 0x00, CONTEXT);
  updateField(hash, 0x01, representation);
  updateField(hash, 0x02, revision);
  updateField(hash, 0x03, projection);
  updateField(hash, 0x04, queryContract);
  updateField(hash, 0x05, query);
  updateField(hash, 0x06, mediaType);
  updateField(hash, 0x07, protocolVersion);
  updateSnapshotIdentity(hash, input.snapshotIdentity);
  updatePageIdentity(hash, input.pageIdentity);
  updatePrincipalScope(hash, input.principalScope);
  return `"pub.r1.${hash.digest('base64url')}"`;
}

function encodeRepresentation(value: string | Uint8Array): Buffer {
  if (typeof value === 'string') {
    if (!hasWellFormedUtf16(value) || NULL_CHARACTER_PATTERN.test(value)) {
      throw new TypeError('representation must be a well-formed UTF-16 string without null characters.');
    }
    return Buffer.from(value, 'utf8');
  }
  try {
    if (!(value instanceof Uint8Array)) throw new TypeError();
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  } catch {
    throw new TypeError('representation must be a string or Uint8Array.');
  }
}

function encodeNegotiatedMediaType(value: string): Buffer {
  const encoded = encodeIdentityField('negotiatedMediaType', value, MAX_MEDIA_TYPE_BYTES);
  const segments = splitMediaTypeSegments(value);
  const essence = segments.shift() as string;
  const slash = essence.indexOf('/');
  if (
    slash <= 0
    || slash !== essence.lastIndexOf('/')
    || !MEDIA_TYPE_TOKEN_PATTERN.test(essence.slice(0, slash))
    || !MEDIA_TYPE_TOKEN_PATTERN.test(essence.slice(slash + 1))
    || essence.includes('*')
  ) {
    throw new TypeError('negotiatedMediaType must be a concrete selected media type.');
  }
  for (const parameter of segments) {
    const equals = parameter.indexOf('=');
    const name = parameter.slice(0, equals);
    const parameterValue = parameter.slice(equals + 1);
    if (
      equals <= 0
      || equals !== parameter.lastIndexOf('=')
      || !MEDIA_TYPE_TOKEN_PATTERN.test(name)
      || !(MEDIA_TYPE_TOKEN_PATTERN.test(parameterValue) || isMediaTypeQuotedString(parameterValue))
      || name.toLowerCase() === 'q'
    ) {
      throw new TypeError('negotiatedMediaType must not contain raw Accept alternatives or weights.');
    }
  }
  return encoded;
}

function splitMediaTypeSegments(value: string): string[] {
  const segments: string[] = [];
  let start = 0;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index] as string;
    if (escaped) {
      escaped = false;
    } else if (quoted && character === '\\') {
      escaped = true;
    } else if (character === '"') {
      quoted = !quoted;
    } else if (!quoted && character === ';') {
      segments.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  if (quoted || escaped) throw new TypeError('negotiatedMediaType contains an invalid quoted parameter.');
  segments.push(value.slice(start).trim());
  return segments;
}

function isMediaTypeQuotedString(value: string): boolean {
  if (value.length < 2 || value[0] !== '"' || value[value.length - 1] !== '"') return false;
  let escaped = false;
  for (let index = 1; index < value.length - 1; index += 1) {
    const character = value[index] as string;
    if (escaped) {
      escaped = false;
    } else if (character === '\\') {
      escaped = true;
    } else if (character === '"') {
      return false;
    }
  }
  return !escaped;
}

function encodeIdentityField(name: string, value: string, maximum = MAX_IDENTITY_FIELD_BYTES): Buffer {
  assertWellFormedString(name, value, true);
  const encoded = Buffer.from(value, 'utf8');
  if (encoded.byteLength > maximum) {
    throw new RangeError(`${name} must not exceed ${maximum} UTF-8 bytes.`);
  }
  return encoded;
}

function encodeQueryContract(value: PublicationEtagQueryContract): Buffer {
  if (value !== 'none' && value !== 'directoryQuery' && value !== 'snapshotQuery' && value !== 'nodeDetailQuery') {
    throw new TypeError('queryContract must name a supported Publication query contract.');
  }
  return Buffer.from(value, 'ascii');
}

function canonicalizeQuery(
  contract: PublicationEtagQueryContract,
  value: Readonly<Record<string, PublicationEtagJsonValue>>,
): Buffer {
  assertRecord(value, 'query');
  const state = { values: 0, ancestors: new Set<object>() };
  const normalized = normalizeJsonValue(value, 'query', 0, state) as Record<string, PublicationEtagJsonValue>;
  if (contract === 'none' && Object.keys(normalized).length !== 0) {
    throw new TypeError('query must be empty when queryContract is none.');
  }
  if (INCLUDE_CONTRACTS.has(contract) && normalized.include !== undefined) {
    if (!Array.isArray(normalized.include) || normalized.include.some((item) => typeof item !== 'string')) {
      throw new TypeError('query.include must be an array of strings.');
    }
    normalized.include = [...new Set(normalized.include as readonly string[])].sort(compareUnicodeCodePoints);
  }
  validatePublicationPageQuery(contract, normalized);
  const serialized = canonicalize(normalized);
  if (serialized === undefined) throw new TypeError('query must be an RFC 8785 JSON value.');
  const encoded = Buffer.from(serialized, 'utf8');
  if (encoded.byteLength > MAX_CANONICAL_QUERY_BYTES) {
    throw new RangeError(`canonical query must not exceed ${MAX_CANONICAL_QUERY_BYTES} UTF-8 bytes.`);
  }
  return encoded;
}

function normalizeJsonValue(
  value: PublicationEtagJsonValue,
  path: string,
  depth: number,
  state: { values: number; ancestors: Set<object> },
): PublicationEtagJsonValue {
  state.values += 1;
  if (state.values > MAX_QUERY_VALUES) throw new RangeError(`query must not exceed ${MAX_QUERY_VALUES} JSON values.`);
  if (depth > MAX_QUERY_DEPTH) throw new RangeError(`query must not exceed ${MAX_QUERY_DEPTH} levels.`);
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new TypeError(`${path} numbers must be safe integers.`);
    return value;
  }
  if (typeof value === 'string') {
    assertWellFormedString(path, value, false);
    return value;
  }
  if (typeof value !== 'object') throw new TypeError(`${path} must contain only JSON values.`);
  if (state.ancestors.has(value)) throw new TypeError('query must not contain cycles.');
  state.ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getOwnPropertySymbols(value).length !== 0) throw new TypeError(`${path} must not have symbol keys.`);
      const propertyNames = Object.getOwnPropertyNames(value);
      if (propertyNames.length !== value.length + 1) throw new TypeError(`${path} must be a dense JSON array.`);
      const normalized: PublicationEtagJsonValue[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable) {
          throw new TypeError(`${path}[${index}] must be an enumerable data property.`);
        }
        normalized.push(normalizeJsonValue(
          descriptor.value as PublicationEtagJsonValue,
          `${path}[${index}]`,
          depth + 1,
          state,
        ));
      }
      return normalized;
    }
    assertRecord(value, path);
    if (Object.getOwnPropertySymbols(value).length !== 0) throw new TypeError(`${path} must not have symbol keys.`);
    const normalized: Record<string, PublicationEtagJsonValue> = Object.create(null) as Record<
      string,
      PublicationEtagJsonValue
    >;
    for (const key of Object.getOwnPropertyNames(value)) {
      assertWellFormedString(`${path} key`, key, false);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable) {
        throw new TypeError(`${path}.${key} must be an enumerable data property.`);
      }
      normalized[key] = normalizeJsonValue(
        descriptor.value as PublicationEtagJsonValue,
        `${path}.${key}`,
        depth + 1,
        state,
      );
    }
    return normalized;
  } finally {
    state.ancestors.delete(value);
  }
}

function validatePublicationPageQuery(
  contract: PublicationEtagQueryContract,
  query: Readonly<Record<string, PublicationEtagJsonValue>>,
): void {
  if (contract !== 'snapshotQuery') return;
  if (query.root !== undefined && typeof query.root !== 'string') throw new TypeError('query.root must be a string.');
  if (query.pageCursor !== undefined && typeof query.pageCursor !== 'string') {
    throw new TypeError('query.pageCursor must be a string.');
  }
  if (query.depth !== undefined) assertNonNegativeSafeInteger('query.depth', query.depth);
  if (query.limit !== undefined) assertPositiveSafeInteger('query.limit', query.limit);
}

function updateSnapshotIdentity(hash: Hash, value: PublicationSnapshotEtagIdentity | undefined): void {
  if (value === undefined) {
    updateAbsent(hash, 0x08);
    return;
  }
  assertRecord(value, 'snapshotIdentity');
  updateField(hash, 0x08, encodeIdentityField('snapshotIdentity.snapshotId', value.snapshotId));
  updateIntegerField(hash, 0x09, assertNonNegativeSafeInteger('snapshotIdentity.sequence', value.sequence));
}

function updatePageIdentity(hash: Hash, value: PublicationPageEtagIdentity | undefined): void {
  if (value === undefined) {
    updateAbsent(hash, 0x0a);
    return;
  }
  assertRecord(value, 'pageIdentity');
  const cursor = value.pageCursor === undefined
    ? undefined
    : encodeIdentityField('pageIdentity.pageCursor', value.pageCursor);
  const key = value.key === undefined ? undefined : encodeIdentityField('pageIdentity.key', value.key);
  const pageNumber = value.pageNumber === undefined
    ? undefined
    : assertNonNegativeSafeInteger('pageIdentity.pageNumber', value.pageNumber);
  if (cursor === undefined && key === undefined && pageNumber === undefined) {
    throw new TypeError('pageIdentity must identify a page.');
  }
  updateOptionalField(hash, 0x0a, cursor);
  updateOptionalIntegerField(hash, 0x0b, pageNumber);
  updateOptionalField(hash, 0x0c, key);
}

/**
 * When present, folds principalScope into domain-separated field 0x0d.
 * When absent, writes nothing so legacy digests stay byte-identical.
 */
function updatePrincipalScope(hash: Hash, value: string | undefined): void {
  if (value === undefined) return;
  updateField(hash, 0x0d, encodeIdentityField('principalScope', value));
}

function updateAbsent(hash: Hash, discriminator: number): void {
  hash.update(Uint8Array.of(discriminator, 0));
}

function updateOptionalField(hash: Hash, discriminator: number, value: Uint8Array | undefined): void {
  if (value === undefined) updateAbsent(hash, discriminator);
  else updateField(hash, discriminator, value);
}

function updateOptionalIntegerField(hash: Hash, discriminator: number, value: number | undefined): void {
  if (value === undefined) updateAbsent(hash, discriminator);
  else updateIntegerField(hash, discriminator, value);
}

function updateIntegerField(hash: Hash, discriminator: number, value: number): void {
  const encoded = Buffer.allocUnsafe(8);
  encoded.writeBigUInt64BE(BigInt(value));
  updateField(hash, discriminator, encoded);
}

function updateField(hash: Hash, discriminator: number, value: Uint8Array): void {
  const length = Buffer.allocUnsafe(8);
  length.writeBigUInt64BE(BigInt(value.byteLength));
  hash.update(Uint8Array.of(discriminator, 1));
  hash.update(length);
  hash.update(value);
}

function assertRecord(value: unknown, name: string): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${name} must be a plain object.`);
  }
}

function assertWellFormedString(name: string, value: string, requireNonEmpty: boolean): void {
  if (
    typeof value !== 'string'
    || (requireNonEmpty && value.length === 0)
    || CONTROL_CHARACTER_PATTERN.test(value)
    || !hasWellFormedUtf16(value)
  ) {
    throw new TypeError(`${name} must be ${requireNonEmpty ? 'a non-empty, ' : 'a '}well-formed string without control characters.`);
  }
}

function assertNonNegativeSafeInteger(name: string, value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer.`);
  }
  return value as number;
}

function assertPositiveSafeInteger(name: string, value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new TypeError(`${name} must be a positive safe integer.`);
  }
  return value as number;
}

function compareUnicodeCodePoints(left: string, right: string): number {
  const leftCodePoints = [...left];
  const rightCodePoints = [...right];
  const length = Math.min(leftCodePoints.length, rightCodePoints.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (leftCodePoints[index] as string).codePointAt(0)! - (rightCodePoints[index] as string).codePointAt(0)!;
    if (difference !== 0) return difference;
  }
  return leftCodePoints.length - rightCodePoints.length;
}
