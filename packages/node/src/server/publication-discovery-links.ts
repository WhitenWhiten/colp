import { isProxy } from 'node:util/types';

/** Fixed Collection Protocol discovery hint values. */
export const PUBLICATION_DISCOVERY_HTML_LINK =
  '<link rel="collection-protocol" href="/.well-known/collection-protocol">';
export const PUBLICATION_DISCOVERY_LINK_HEADER =
  '</.well-known/collection-protocol>; rel="collection-protocol"';

const controlCharacters = /[\u0000-\u001f\u007f]/u;
const headerName = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u;
const prototypeKeys = new Set(['__proto__', 'constructor', 'prototype']);
const MAX_SOURCE_HEADER_COUNT = 128;
const MAX_HEADER_VALUE_BYTES = 16 * 1024;
const MAX_SOURCE_HEADER_BYTES = 64 * 1024;

export interface PublicationDiscoveryLinks {
  readonly html: string;
  readonly headers: Readonly<Record<string, string>>;
}

/** Return the immutable, framework-neutral discovery hints. */
export function createPublicationDiscoveryLinks(): PublicationDiscoveryLinks {
  return Object.freeze({
    html: PUBLICATION_DISCOVERY_HTML_LINK,
    headers: Object.freeze({ Link: PUBLICATION_DISCOVERY_LINK_HEADER }),
  });
}

/**
 * Merge the fixed Link hint into an adapter-owned header map.
 * Invalid or ambiguous maps fail closed rather than risking header injection.
 */
export function mergePublicationDiscoveryHeaders(
  source: unknown,
): Readonly<Record<string, string>> {
  if (typeof source !== 'object' || source === null || Array.isArray(source) || isProxy(source)) {
    throw new TypeError('Publication discovery headers must be a plain object.');
  }
  const prototype = Object.getPrototypeOf(source) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError('Publication discovery headers must be a plain object.');
  }
  const result: Record<string, string> = Object.create(null) as Record<string, string>;
  const names = new Set<string>();
  const keys = Reflect.ownKeys(source);
  if (keys.length > MAX_SOURCE_HEADER_COUNT) {
    throw new RangeError('Publication discovery headers exceed the field limit.');
  }
  let sourceBytes = 0;
  for (const key of keys) {
    if (typeof key !== 'string' || prototypeKeys.has(key)) {
      throw new TypeError('Publication discovery headers contain an unsafe key.');
    }
    const normalizedName = key.toLowerCase();
    if (!headerName.test(key)) {
      throw new TypeError('Publication discovery headers contain an invalid name.');
    }
    if (normalizedName === 'link') {
      throw new TypeError('Publication discovery Link header already exists.');
    }
    if (names.has(normalizedName)) {
      throw new TypeError('Publication discovery headers contain duplicate names.');
    }
    names.add(normalizedName);
    const descriptor = Object.getOwnPropertyDescriptor(source, key);
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)
      || typeof descriptor.value !== 'string' || controlCharacters.test(key)
      || controlCharacters.test(descriptor.value)) {
      throw new TypeError('Publication discovery headers contain an invalid value.');
    }
    const valueBytes = Buffer.byteLength(descriptor.value, 'utf8');
    if (valueBytes > MAX_HEADER_VALUE_BYTES) {
      throw new RangeError('Publication discovery header value exceeds the byte limit.');
    }
    sourceBytes += Buffer.byteLength(key, 'ascii') + valueBytes;
    if (sourceBytes > MAX_SOURCE_HEADER_BYTES) {
      throw new RangeError('Publication discovery headers exceed the byte limit.');
    }
    result[key] = descriptor.value;
  }
  result.Link = PUBLICATION_DISCOVERY_LINK_HEADER;
  return Object.freeze(result);
}
