import { utf8ByteLength } from './utf8-length.js';

/**
 * UTF-8 length of RFC 8785 canonical JSON, matching `canonicalize` plus
 * `TextEncoder`, without joining one document string.
 *
 * Returns undefined when `canonicalize` would return undefined. Throws the
 * same `Error` messages for NaN, Infinity, and cycles.
 */
export function canonicalJsonUtf8ByteLength(object: unknown, seen = new Set<object>()): number | undefined {
  if (typeof object === 'number' && Number.isNaN(object)) throw new Error('NaN is not allowed');
  if (typeof object === 'number' && !Number.isFinite(object)) throw new Error('Infinity is not allowed');
  if (object === null || typeof object !== 'object') {
    const encoded = JSON.stringify(object);
    return encoded === undefined ? undefined : utf8ByteLength(encoded);
  }
  if (typeof (object as { toJSON?: unknown }).toJSON === 'function') {
    if (seen.has(object)) throw new Error('Circular reference detected');
    seen.add(object);
    try {
      return canonicalJsonUtf8ByteLength((object as { toJSON: () => unknown }).toJSON(), seen);
    } finally {
      seen.delete(object);
    }
  }
  if (seen.has(object)) throw new Error('Circular reference detected');
  seen.add(object);
  try {
    if (Array.isArray(object)) {
      let total = 2;
      for (let index = 0; index < object.length; index += 1) {
        if (index > 0) total += 1;
        const current = object[index];
        const value = current === undefined || typeof current === 'symbol' ? null : current;
        const length = canonicalJsonUtf8ByteLength(value, seen);
        if (length !== undefined) total += length;
      }
      return total;
    }
    const keys = Object.keys(object).sort();
    let total = 2;
    let emitted = 0;
    for (const key of keys) {
      const child = (object as Record<string, unknown>)[key];
      if (child === undefined || typeof child === 'symbol') continue;
      const keyJson = JSON.stringify(key);
      if (keyJson === undefined) continue;
      const childLength = canonicalJsonUtf8ByteLength(child, seen);
      if (emitted > 0) total += 1;
      emitted += 1;
      total += utf8ByteLength(keyJson) + 1;
      total += childLength === undefined ? utf8ByteLength('undefined') : childLength;
    }
    return total;
  } finally {
    seen.delete(object);
  }
}
