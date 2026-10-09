import { assertJsonTextBudget } from '../shared/json-text-budget.js';
import { PublicationPublicProjectionError, type PublicationPublicValue, type PublicationPublicProjectionLimits } from './publication-public-projection.js';
const DEFAULT_MAX_PUBLIC_WIRE_BYTES = 64 * 1024 * 1024;

/**
 * Convert a projected public value into ordinary, deeply frozen JSON objects
 * for adapter-facing wire emission.
 *
 * Projection builds null-prototype maps during redaction; materialization
 * restores ordinary prototypes via a JSON round-trip without reintroducing
 * aliases to the pre-projection input.
 */
export function materializePublicationPublicWire(
  projected: PublicationPublicValue,
  limits: PublicationPublicProjectionLimits = {},
): PublicationPublicValue {
  const maxBytes = limits.maxBytes ?? DEFAULT_MAX_PUBLIC_WIRE_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > DEFAULT_MAX_PUBLIC_WIRE_BYTES) {
    throw new PublicationPublicProjectionError('invalid_policy');
  }
  let encoded: string;
  try {
    assertJsonTextBudget(projected, maxBytes);
    encoded = JSON.stringify(projected);
  } catch (error) {
    throw new PublicationPublicProjectionError(error instanceof RangeError ? 'projection_limit_exceeded' : 'malformed_input');
  }
  if (encoded === undefined || Buffer.byteLength(encoded, 'utf8') > maxBytes) {
    throw new PublicationPublicProjectionError('projection_limit_exceeded');
  }
  let materialized: unknown;
  try {
    materialized = JSON.parse(encoded);
  } catch {
    throw new PublicationPublicProjectionError('malformed_input');
  }
  return freezeJsonValue(materialized);
}

function freezeJsonValue(value: unknown, seen = new WeakSet<object>()): PublicationPublicValue {
  if (value === null || typeof value !== 'object') {
    return value as PublicationPublicValue;
  }
  if (seen.has(value)) return value as PublicationPublicValue;
  seen.add(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      value[index] = freezeJsonValue(value[index], seen);
    }
    return Object.freeze(value) as PublicationPublicValue;
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') continue;
    const record = value as Record<string, unknown>;
    record[key] = freezeJsonValue(record[key], seen);
  }
  return Object.freeze(value) as PublicationPublicValue;
}
