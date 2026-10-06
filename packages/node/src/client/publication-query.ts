import {
  collectionProtocolSchema,
  collectionProtocolSchemaV02,
  type DefinitionName,
  type ValidatorRegistry,
} from '../schema/index.js';
import {
  decodePublicationQuery,
  publicationQueryLimits,
  resolvePublicationQueryContract,
  type PublicationQueryEndpoint,
} from '../shared/publication-query.js';
import { hasWellFormedUtf16 } from '../shared/utf16.js';

export type { PublicationQueryEndpoint } from '../shared/publication-query.js';

const INVALID_QUERY_MESSAGE = 'invalid_query: Publication query is invalid.';
const dangerousPropertyNames = new Set(['__proto__', 'constructor', 'prototype']);
const publicationEndpointNames = new Set<PublicationQueryEndpoint>([
  'directory',
  'collection',
  'snapshot',
  'node',
]);
const utf8Encoder = new TextEncoder();

/** Stable client error for invalid Publication query input (fixed message; details in `issues`). */
export class PublicationQueryError extends TypeError {
  readonly code = 'invalid_query' as const;
  readonly issues: readonly string[];

  constructor(issues: readonly string[] = []) {
    super(INVALID_QUERY_MESSAGE);
    this.name = 'PublicationQueryError';
    this.issues = Object.freeze(issues.map(String));
  }
}

/** Rejects text that URL parsing would replace or silently discard before query validation. */
export function assertPublicationQueryUrlText(value: string): void {
  if (!hasWellFormedUtf16(value) || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) throwInvalidQuery();
}

/** Preflights Manifest endpoint source text before URI-template format validation can normalize it. */
export function assertPublicationManifestQueryUrlTexts(value: unknown): void {
  if (typeof value !== 'object' || value === null) return;
  const mounts = Object.getOwnPropertyDescriptor(value, 'mounts');
  if (mounts === undefined || !('value' in mounts) || !Array.isArray(mounts.value)) return;

  for (const mount of mounts.value) {
    if (typeof mount !== 'object' || mount === null) continue;
    const endpoints = Object.getOwnPropertyDescriptor(mount, 'endpoints');
    if (endpoints === undefined || !('value' in endpoints) || typeof endpoints.value !== 'object' || endpoints.value === null) {
      continue;
    }
    for (const endpoint of publicationEndpointNames) {
      const source = Object.getOwnPropertyDescriptor(endpoints.value, endpoint);
      if (source !== undefined && 'value' in source && typeof source.value === 'string') {
        assertPublicationQueryUrlText(source.value);
      }
    }
  }
}

/** Validates and appends a Publication query without rewriting a Manifest endpoint's fixed search bytes. */
export function preparePublicationQuery(
  endpoint: PublicationQueryEndpoint,
  endpointUrl: URL | string,
  query: unknown,
  validators: ValidatorRegistry,
): URL {
  const contract = resolvePublicationQueryContract(endpoint);
  if (typeof endpointUrl === 'string') assertPublicationQueryUrlText(endpointUrl);
  let normalized: Readonly<Record<string, unknown>> | undefined;
  try {
    normalized = normalizeQueryData(query);
  } catch {
    normalized = undefined;
  }
  if (normalized === undefined) throwInvalidQuery();
  if (contract.query === undefined) {
    if (Object.keys(normalized).length > 0) throwInvalidQuery();
  } else if (!validators.validate(contract.query as DefinitionName, normalized).valid) {
    throwInvalidQuery();
  }

  const encoded = encodeQuery(normalized, contract.query);
  const callerDecoded = decodePublicationQuery(
    endpoint,
    encoded.length === 0 ? '' : `?${encoded}`,
    validators,
  );
  if (!callerDecoded.valid || callerDecoded.contract !== contract) throwInvalidQuery();

  const url = new URL(endpointUrl instanceof URL ? endpointUrl.href : endpointUrl);
  const fixedSearch = url.search;
  const combinedSearch = encoded.length === 0
    ? fixedSearch
    : `${fixedSearch}${fixedSearch.length === 0 ? '?' : '&'}${encoded}`;

  const decoded = decodePublicationQuery(endpoint, combinedSearch, validators);
  if (!decoded.valid) throwInvalidQuery(decoded.errors);
  if (decoded.contract !== contract) throwInvalidQuery();

  // Assigning the complete raw component preserves existing percent escapes and pair order.
  if (combinedSearch !== fixedSearch) url.search = combinedSearch;
  return url;
}

function normalizeQueryData(value: unknown): Readonly<Record<string, unknown>> | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype) return undefined;

  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  const keys = Reflect.ownKeys(value);
  if (keys.length > publicationQueryLimits.maxDtoProperties) return undefined;
  for (const key of keys) {
    if (typeof key !== 'string' || !hasWellFormedUtf16(key) || dangerousPropertyNames.has(key)) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) return undefined;
    if (descriptor.value === undefined) continue;
    const normalized = normalizeQueryValue(descriptor.value);
    if (normalized === undefined) return undefined;
    result[key] = normalized;
  }
  return Object.freeze(result);
}

function normalizeQueryValue(value: unknown): unknown | undefined {
  if (typeof value === 'string') return hasWellFormedUtf16(value) ? value : undefined;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return undefined;
  if (value.length > publicationQueryLimits.maxArrayItems) return undefined;

  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== 'string' || (key !== 'length' && !/^(?:0|[1-9][0-9]*)$/u.test(key)))) {
    return undefined;
  }
  const result: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) return undefined;
    const item = descriptor.value;
    if (typeof item !== 'string' && typeof item !== 'boolean' && typeof item !== 'number') return undefined;
    if (typeof item === 'string' && !hasWellFormedUtf16(item)) return undefined;
    if (typeof item === 'number' && !Number.isFinite(item)) return undefined;
    result.push(item);
  }
  return Object.freeze(result);
}

function encodeQuery(
  query: Readonly<Record<string, unknown>>,
  contractName: string | undefined,
): string {
  const fields: string[] = [];
  for (const name of orderedPropertyNames(query, contractName)) {
    const value = query[name];
    const encodedName = encodeComponent(name);
    if (Array.isArray(value)) {
      for (const item of value) fields.push(`${encodedName}=${encodeComponent(String(item))}`);
    } else {
      fields.push(`${encodedName}=${encodeComponent(String(value))}`);
    }
  }
  const encoded = fields.join('&');
  if (encoded.length > publicationQueryLimits.maxRawBytes) throwInvalidQuery();
  return encoded;
}

function orderedPropertyNames(
  query: Readonly<Record<string, unknown>>,
  contractName: string | undefined,
): readonly string[] {
  if (contractName === undefined) return Object.keys(query).sort();
  const definitions = contractName in collectionProtocolSchemaV02.$defs
    ? collectionProtocolSchemaV02.$defs
    : collectionProtocolSchema.$defs;
  const definition = definitions[contractName as keyof typeof definitions] as {
    readonly properties?: Readonly<Record<string, unknown>>;
  };
  const rank = new Map(Object.keys(definition.properties ?? {}).map((name, index) => [name, index]));
  return Object.keys(query).sort((left, right) =>
    (rank.get(left) ?? Number.MAX_SAFE_INTEGER) - (rank.get(right) ?? Number.MAX_SAFE_INTEGER)
      || left.localeCompare(right));
}

function encodeComponent(value: string): string {
  if (
    value.length > publicationQueryLimits.maxRawBytes
    || utf8Encoder.encode(value).byteLength > publicationQueryLimits.maxRawBytes
  ) {
    throwInvalidQuery();
  }
  return encodeURIComponent(value)
    .replace(/%20/gu, '+')
    .replace(/[!'()*]/gu, (character) =>
      `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

function throwInvalidQuery(issues?: string | readonly string[]): never {
  const list = issues === undefined
    ? []
    : typeof issues === 'string'
      ? [issues]
      : issues;
  throw new PublicationQueryError(list);
}
