import { types as nodeTypes } from 'node:util';

const MAX_IF_MATCH_VALUES = 64;
const MAX_IF_MATCH_BYTES = 64 * 1024;

/**
 * Canonicalizes the repeated HTTP If-Match representation for idempotency.
 * OWS around list separators and repeated field lines is equivalent on the
 * wire; the exact tag tokens remain intact so different preconditions cannot
 * replay one another's responses. `null` represents an absent/empty field.
 */
export function normalizeIfMatchForDigest(
  value: string | null | readonly string[] | undefined,
): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  let values: readonly string[];
  if (Array.isArray(value)) {
    if (nodeTypes.isProxy(value)
      || (Object.getPrototypeOf(value) !== Array.prototype && Object.getPrototypeOf(value) !== null)) {
      throw new TypeError('Canonical request If-Match must be a plain repeated field array.');
    }
    const keys = Reflect.ownKeys(value);
    if (keys.length !== value.length + 1 || !keys.includes('length')
      || keys.some((key) => typeof key !== 'string')) {
      throw new TypeError('Canonical request If-Match must be a dense repeated field array.');
    }
    if (value.length > MAX_IF_MATCH_VALUES) {
      throw new TypeError('Canonical request If-Match contains too many field values.');
    }
    const elements: string[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)
        || typeof descriptor.value !== 'string') {
        throw new TypeError('Canonical request If-Match must contain string field values.');
      }
      elements.push(descriptor.value);
    }
    values = elements;
  } else {
    if (typeof value !== 'string') {
      throw new TypeError('Canonical request If-Match must contain string field values.');
    }
    values = [value];
  }
  if (values.some((item) => Buffer.byteLength(item, 'utf8') > MAX_IF_MATCH_BYTES)) {
    throw new TypeError('Canonical request If-Match field value exceeds its byte budget.');
  }
  if (values.length === 0) return null;
  if (values.some((item) => typeof item !== 'string')) {
    throw new TypeError('Canonical request If-Match must contain string field values.');
  }
  const combined = values.join(',')
    .replace(/^[\t ]+|[\t ]+$/gu, '')
    // Quotes delimit opaque ETags; backslashes are literal tag characters,
    // not quote escapes. Preserve even malformed tag contents so a rejected
    // precondition cannot collide with a successful request's digest.
    .split('"')
    .map((part, index) => index % 2 === 1 ? part : part.replace(/[\t ]*,[\t ]*/gu, ','))
    .join('"');
  if (Buffer.byteLength(combined, 'utf8') > MAX_IF_MATCH_BYTES) {
    throw new TypeError('Canonical request If-Match exceeds its byte budget.');
  }
  return combined.length === 0 ? null : combined;
}
