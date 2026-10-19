/**
 * Deterministic JSON for Product Sync idempotent response bodies and cursor
 * payloads.
 *
 * Product command receipts persist the exact bytes produced here and cursor
 * HMACs sign them, so legal values keep their historical encoding (sorted
 * keys, no whitespace). `undefined` used to be interpolated as the literal
 * `undefined` (`{"a":undefined}`, `[1,,3]`), which is not JSON. Callers now
 * choose the boundary policy explicitly:
 *
 * - `omit` (response bodies): object members with `undefined` are omitted and
 *   array entries become `null`, matching `JSON.stringify` semantics.
 * - `reject` (signed cursors): any `undefined` in the payload fails closed,
 *   because silently dropping a field would change the signed payload.
 *
 * A top-level `undefined` is never encodable and always throws.
 */
export type StableJsonUndefinedPolicy = 'omit' | 'reject';

export function stableJson(value: unknown, onUndefined: StableJsonUndefinedPolicy = 'omit'): string {
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') {
    throw new TypeError('stableJson cannot encode a top-level undefined, function or symbol');
  }
  return encodeStableJson(value, onUndefined, false) as string;
}

function encodeStableJson(
  value: unknown,
  onUndefined: StableJsonUndefinedPolicy,
  inArray: boolean,
): string | undefined {
  if (value === undefined) return undefinedValue(onUndefined, inArray);
  if (value === null) return 'null';
  if (Array.isArray(value)) {
    return `[${value.map((item) => encodeStableJson(item, onUndefined, true) ?? 'null').join(',')}]`;
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const members: string[] = [];
    for (const key of Object.keys(record).sort()) {
      const encoded = encodeStableJson(record[key], onUndefined, false);
      if (encoded !== undefined) members.push(`${JSON.stringify(key)}:${encoded}`);
    }
    return `{${members.join(',')}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) return undefinedValue(onUndefined, inArray);
  return encoded;
}

function undefinedValue(onUndefined: StableJsonUndefinedPolicy, inArray: boolean): string | undefined {
  if (onUndefined === 'reject') {
    throw new TypeError('stableJson cannot encode undefined with the reject policy');
  }
  return inArray ? 'null' : undefined;
}
