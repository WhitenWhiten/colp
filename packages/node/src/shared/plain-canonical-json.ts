import canonicalize from 'canonicalize';

import { immutableJsonSnapshot, type DeepReadonly, type ImmutableJsonLimits } from './immutable-json.js';

/**
 * Plain-data copy used before RFC 8785 canonicalize.
 * The copy rejects functions, special prototypes, sparse arrays, and accessors,
 * and does not call getters or toJSON. Array holes are rejected, not replaced
 * with null. Depth and member limits stay above ordinary protocol documents so
 * legal JSON keeps the same canonical bytes. `maxBytes` stays unset so callers
 * keep the immutable JSON default unless they pass an override.
 */
const PLAIN_CANONICAL_JSON_MAX_DEPTH = 512;
const PLAIN_CANONICAL_JSON_MAX_MEMBERS = Number.MAX_SAFE_INTEGER;

const PLAIN_CANONICAL_JSON_LIMITS: ImmutableJsonLimits = Object.freeze({
  maxDepth: PLAIN_CANONICAL_JSON_MAX_DEPTH,
  maxMembers: PLAIN_CANONICAL_JSON_MAX_MEMBERS,
});

function plainCanonicalJsonLimits(limits?: ImmutableJsonLimits): ImmutableJsonLimits {
  if (limits === undefined) return PLAIN_CANONICAL_JSON_LIMITS;
  const maxDepth = limits.maxDepth ?? PLAIN_CANONICAL_JSON_MAX_DEPTH;
  const maxMembers = limits.maxMembers ?? PLAIN_CANONICAL_JSON_MAX_MEMBERS;
  if (limits.maxBytes === undefined) return { maxDepth, maxMembers };
  return { maxDepth, maxMembers, maxBytes: limits.maxBytes };
}

/** Canonical JSON for a plain value, or undefined when the value is not plain data. */
export function encodePlainCanonicalJson(
  value: unknown,
  label = 'Canonical digest input',
): string | undefined {
  try {
    return preparePlainCanonicalJson(value, label).encode();
  } catch {
    return undefined;
  }
}

/** Canonical JSON of a plain object after one own key is removed. Throws when not plain data. */
export function encodePlainCanonicalJsonOmitting(value: unknown, omitKey: string, label: string): string {
  return preparePlainCanonicalJson(value, label).encode(omitKey);
}

/** Validate and copy once, then share that frozen data between semantic checks and encoding. */
export function preparePlainCanonicalJson<Value>(
  value: Value,
  label: string,
  limits?: ImmutableJsonLimits,
): Readonly<{
  value: DeepReadonly<Value>;
  encode(omitKey?: string): string;
}> {
  const copied = immutableJsonSnapshot(value, label, plainCanonicalJsonLimits(limits));
  return Object.freeze({ value: copied, encode: (omitKey?: string) => encodeCopiedJson(copied, omitKey, label) });
}

function encodeCopiedJson(copied: unknown, omitKey: string | undefined, label: string): string {
  let digestInput: unknown = copied;
  if (omitKey !== undefined) {
    if (copied === null || typeof copied !== 'object' || Array.isArray(copied)) {
      throw new TypeError(`${label} must be a plain object.`);
    }
    const record: Record<string, unknown> = { ...copied };
    delete record[omitKey];
    digestInput = record;
  }
  const encoded = canonicalize(digestInput);
  if (typeof encoded !== 'string') throw new TypeError(`${label} is not canonical JSON.`);
  return encoded;
}
