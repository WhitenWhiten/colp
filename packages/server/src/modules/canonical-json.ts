/**
 * Shared canonical JSON for digests, fingerprints, and signed payloads.
 *
 * Key order and illegal-value handling are explicit profiles. `locale` keeps
 * the historical `String.prototype.localeCompare` order used by stored
 * receipts and evidence; it is not the UTF-16 order used by newer fingerprints.
 * Callers must not widen a profile to accept values it currently rejects.
 */

export type CanonicalKeyOrder = 'utf16' | 'locale';

export function compareCanonicalKeys(left: string, right: string, order: CanonicalKeyOrder): number {
  if (order === 'locale') return left.localeCompare(right);
  return left < right ? -1 : left > right ? 1 : 0;
}

export interface ThrowingCanonicalJsonOptions {
  readonly keyOrder: CanonicalKeyOrder;
  readonly onInvalid: () => never;
}

/**
 * Recursive canonical JSON. `JSON.stringify` returning undefined (undefined,
 * functions, symbols) fails through `onInvalid`. Array holes stay empty slots,
 * matching `Array.prototype.map` plus `join`.
 */
export function encodeThrowingCanonicalJson(
  value: unknown,
  options: ThrowingCanonicalJsonOptions,
): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => encodeThrowingCanonicalJson(item, options)).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
      compareCanonicalKeys(left, right, options.keyOrder));
    return `{${entries.map(([key, item]) =>
      `${JSON.stringify(key)}:${encodeThrowingCanonicalJson(item, options)}`).join(',')}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) options.onInvalid();
  return encoded;
}

/**
 * Recursive canonical JSON whose leaves are `JSON.stringify` with no rejection.
 * A top-level unsupported value therefore stays `undefined` at runtime, and an
 * object member or array entry interpolates as the bare word or an empty slot.
 */
export function encodePassthroughCanonicalJson(value: unknown, keyOrder: CanonicalKeyOrder): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => encodePassthroughCanonicalJson(item, keyOrder)).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
      compareCanonicalKeys(left, right, keyOrder));
    return `{${entries.map(([key, item]) =>
      `${JSON.stringify(key)}:${encodePassthroughCanonicalJson(item, keyOrder)}`).join(',')}}`;
  }
  return JSON.stringify(value) as string;
}

/**
 * Profile-claim evidence that spells unsupported leaves as the bare word
 * `undefined`. Array holes are still empty slots because `map` does not visit them.
 */
export function encodeLiteralUndefinedCanonicalJson(value: unknown, keyOrder: CanonicalKeyOrder): string {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') {
    const primitive = JSON.stringify(value);
    return primitive === undefined ? 'undefined' : primitive;
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => encodeLiteralUndefinedCanonicalJson(item, keyOrder)).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort((left, right) => compareCanonicalKeys(left, right, keyOrder));
  return `{${keys.map((key) => `${JSON.stringify(key)}:${encodeLiteralUndefinedCanonicalJson(record[key], keyOrder)}`).join(',')}}`;
}

/** Command receipts: omit undefined members, reject non-finite numbers, unsafe integers, and lone surrogates. */
export function encodeReceiptCanonicalJson(value: unknown): string {
  const encode = (input: unknown): string => {
    if (input === null) return 'null';
    if (typeof input === 'string') {
      for (let index = 0; index < input.length; index += 1) {
        const unit = input.charCodeAt(index);
        if (unit >= 0xd800 && unit <= 0xdbff) {
          const next = input.charCodeAt(index + 1);
          if (!(next >= 0xdc00 && next <= 0xdfff)) {
            throw new TypeError('canonical JSON requires valid Unicode');
          }
          index += 1;
        } else if (unit >= 0xdc00 && unit <= 0xdfff) {
          throw new TypeError('canonical JSON requires valid Unicode');
        }
      }
      return JSON.stringify(input);
    }
    if (typeof input === 'boolean') return JSON.stringify(input);
    if (typeof input === 'number') {
      if (!Number.isFinite(input)) throw new TypeError('canonical JSON does not allow non-finite numbers');
      if (Number.isInteger(input) && !Number.isSafeInteger(input)) {
        throw new TypeError('canonical JSON requires safe integers');
      }
      return JSON.stringify(input);
    }
    if (Array.isArray(input)) return `[${input.map(encode).join(',')}]`;
    if (typeof input === 'object') {
      const entries = Object.entries(input as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => compareCanonicalKeys(left, right, 'utf16'));
      return `{${entries.map(([key, item]) => `${encode(key)}:${encode(item)}`).join(',')}}`;
    }
    throw new TypeError('canonical JSON does not allow this value');
  };
  return encode(value);
}

export type ProductStableJsonUndefinedPolicy = 'omit' | 'reject';

/**
 * Product Sync response bodies and signed cursors. Legal values stay sorted
 * and whitespace-free. `omit` drops undefined object members and turns array
 * holes into null; `reject` fails closed instead of changing a signed payload.
 */
export function encodeProductStableJson(
  value: unknown,
  onUndefined: ProductStableJsonUndefinedPolicy = 'omit',
): string {
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') {
    throw new TypeError('stableJson cannot encode a top-level undefined, function or symbol');
  }
  return encodeProductValue(value, onUndefined, false) as string;
}

function encodeProductValue(
  value: unknown,
  onUndefined: ProductStableJsonUndefinedPolicy,
  inArray: boolean,
): string | undefined {
  if (value === undefined) return productUndefined(onUndefined, inArray);
  if (value === null) return 'null';
  if (Array.isArray(value)) {
    const items: string[] = [];
    for (let index = 0; index < value.length; index += 1) {
      items.push(encodeProductValue(value[index], onUndefined, true) ?? 'null');
    }
    return `[${items.join(',')}]`;
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const members: string[] = [];
    for (const key of Object.keys(record).sort((left, right) => compareCanonicalKeys(left, right, 'utf16'))) {
      const encoded = encodeProductValue(record[key], onUndefined, false);
      if (encoded !== undefined) members.push(`${JSON.stringify(key)}:${encoded}`);
    }
    return `{${members.join(',')}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) return productUndefined(onUndefined, inArray);
  return encoded;
}

function productUndefined(
  onUndefined: ProductStableJsonUndefinedPolicy,
  inArray: boolean,
): string | undefined {
  if (onUndefined === 'reject') {
    throw new TypeError('stableJson cannot encode undefined with the reject policy');
  }
  return inArray ? 'null' : undefined;
}

/**
 * Stored Sync Ack `result_digest`. Only the top-level keys use locale order;
 * each value is `JSON.stringify`, so nested objects keep insertion order.
 * That is a different byte string from a recursive locale canonicalization.
 */
export function encodeAckResultDigestJson(result: object): string {
  return `{${Object.entries(result).sort(([left], [right]) => compareCanonicalKeys(left, right, 'locale'))
    .map(([key, value]) => `${JSON.stringify(key)}:${JSON.stringify(value)}`).join(',')}}`;
}
