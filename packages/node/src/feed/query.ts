import { isProxy } from 'node:util/types';

import {
  createValidatorRegistry,
  type ValidatorRegistry,
} from '../schema/index.js';
import { parseProtocolQuery, type QueryParseResult } from '../shared/query.js';
import { hasDenseArrayOwnKeys } from '../shared/dense-array-keys.js';
import type { FeedQuery } from '../types/index.js';

export type FeedQueryDecodeResult =
  | { readonly valid: true; readonly value: FeedQuery }
  | { readonly valid: false; readonly code: 'invalid_query'; readonly errors: readonly string[] };

let defaultValidators: ReturnType<typeof createValidatorRegistry> | undefined;

const FEED_QUERY_MAX_PARAMETERS = 16;
const FEED_QUERY_MAX_VALUES_PER_PARAMETER = 8;
const FEED_QUERY_MAX_BYTES = 16 * 1024;

/** UTF-8 accounting that does not allocate a copy of an untrusted string. */
function utf8Bytes(value: string, limit: number): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    const width = code <= 0x7f
      ? 1
      : code <= 0x7ff
        ? 2
        : code >= 0xd800 && code <= 0xdbff
          && index + 1 < value.length
          && value.charCodeAt(index + 1) >= 0xdc00
          && value.charCodeAt(index + 1) <= 0xdfff
          ? (index += 1, 4)
          : 3;
    bytes += width;
    if (bytes > limit) return bytes;
  }
  return bytes;
}

function addUtf8Bytes(total: number, value: string): number {
  const remaining = FEED_QUERY_MAX_BYTES - total;
  const size = utf8Bytes(value, remaining);
  if (size > remaining) throw new TypeError('Feed query exceeds its parameter budget.');
  return total + size;
}

function validatorsOrDefault(validators?: ValidatorRegistry): ValidatorRegistry {
  if (validators !== undefined) return validators;
  defaultValidators ??= createValidatorRegistry();
  return defaultValidators;
}

/**
 * Decodes Feed query parameters (`cursor` / `from` / `limit`).
 *
 * Unknown parameters, duplicate scalars, empty values, and the illegal
 * `from`+`cursor` combination reject as registered `400 invalid_query`.
 */
export function decodeFeedQuery(
  parameters: URLSearchParams | Readonly<Record<string, string | readonly string[] | undefined>>,
  validators?: ValidatorRegistry,
): FeedQueryDecodeResult {
  const search = toSearchParams(parameters);
  const parsed: QueryParseResult = parseProtocolQuery(
    'feedQuery',
    search,
    validatorsOrDefault(validators),
  );
  if (!parsed.valid) {
    return Object.freeze({
      valid: false,
      code: 'invalid_query',
      errors: parsed.errors,
    });
  }

  const value = parsed.value as FeedQuery;
  if (value.cursor !== undefined && value.from !== undefined) {
    return Object.freeze({
      valid: false,
      code: 'invalid_query',
      errors: Object.freeze(['from and cursor must not appear together']),
    });
  }

  return Object.freeze({ valid: true, value: Object.freeze({ ...value }) });
}

function toSearchParams(
  parameters: URLSearchParams | Readonly<Record<string, string | readonly string[] | undefined>>,
): URLSearchParams {
  if (isProxy(parameters)) throw new TypeError('Feed query parameters must not be a Proxy.');
  if (parameters instanceof URLSearchParams) {
    if (parameters.size > FEED_QUERY_MAX_PARAMETERS * FEED_QUERY_MAX_VALUES_PER_PARAMETER) {
      throw new TypeError('Feed query contains too many parameters.');
    }
    let bytes = 0;
    let entries = 0;
    const names = new Set<string>();
    for (const [name, value] of parameters) {
      names.add(name);
      if (names.size > FEED_QUERY_MAX_PARAMETERS || parameters.getAll(name).length > FEED_QUERY_MAX_VALUES_PER_PARAMETER) {
        throw new TypeError('Feed query contains too many parameters.');
      }
      entries += 1;
      bytes = addUtf8Bytes(bytes, name);
      bytes = addUtf8Bytes(bytes, value);
      if (entries > FEED_QUERY_MAX_PARAMETERS * FEED_QUERY_MAX_VALUES_PER_PARAMETER || bytes > FEED_QUERY_MAX_BYTES) {
        throw new TypeError('Feed query exceeds its parameter budget.');
      }
    }
    return parameters;
  }
  if (typeof parameters !== 'object' || parameters === null || isProxy(parameters)) {
    throw new TypeError('Feed query parameters must be URLSearchParams or a plain object.');
  }
  const search = new URLSearchParams();
  let names = 0;
  let entries = 0;
  let bytes = 0;
  for (const name in parameters) {
    if (!Object.prototype.hasOwnProperty.call(parameters, name)) continue;
    const descriptor = Object.getOwnPropertyDescriptor(parameters, name);
    if (descriptor === undefined || !('value' in descriptor)) {
      throw new TypeError('Feed query parameters must contain only data properties.');
    }
    const raw = descriptor.value as string | readonly string[] | undefined;
    if (raw === undefined) continue;
    names += 1;
    if (names > FEED_QUERY_MAX_PARAMETERS) throw new TypeError('Feed query has too many parameter names.');
    bytes = addUtf8Bytes(bytes, name);
    if (Array.isArray(raw)) {
      if (isProxy(raw) || (Object.getPrototypeOf(raw) !== Array.prototype && Object.getPrototypeOf(raw) !== null)) {
        throw new TypeError('Feed query array values must be plain and non-Proxy.');
      }
      const lengthDescriptor = Object.getOwnPropertyDescriptor(raw, 'length');
      const length = lengthDescriptor !== undefined && 'value' in lengthDescriptor ? lengthDescriptor.value : undefined;
      if (typeof length !== 'number' || !Number.isSafeInteger(length) || length > FEED_QUERY_MAX_VALUES_PER_PARAMETER
        || !hasDenseArrayOwnKeys(Reflect.ownKeys(raw), length)) {
        throw new TypeError('Feed query has too many or malformed values.');
      }
      for (let index = 0; index < length; index += 1) {
        const itemDescriptor = Object.getOwnPropertyDescriptor(raw, String(index));
        if (itemDescriptor === undefined || !itemDescriptor.enumerable || !('value' in itemDescriptor)) {
          throw new TypeError('Feed query array values must contain only data properties.');
        }
        const item = itemDescriptor.value;
        if (typeof item === 'string') {
          entries += 1;
          bytes = addUtf8Bytes(bytes, item);
          search.append(name, item);
        }
      }
    } else if (typeof raw === 'string') {
      entries += 1;
      bytes = addUtf8Bytes(bytes, raw);
      search.append(name, raw);
    }
  }
  return search;
}
