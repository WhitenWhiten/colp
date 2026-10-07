import type { JsonObject } from './canonical-mutation.js';

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === Object.prototype || prototype === null;
}

function assertRecordMembers(record: Record<string, unknown>, path: string): void {
  for (const key of Object.keys(record)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
      throw new TypeError(`${path} contains an unsafe member name "${key}"`);
    }
  }
  for (const [key, entry] of Object.entries(record)) {
    assertJsonValue(entry, `${path}.${key}`);
  }
}

function assertJsonValue(value: unknown, path: string): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`${path} is not a finite number`);
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
      throw new TypeError(`${path} is not a safe integer`);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries()) {
      assertJsonValue(entry, `${path}[${index}]`);
    }
    return;
  }
  if (typeof value === 'object') {
    if (!isPlainRecord(value)) throw new TypeError(`${path} must be a plain JSON object`);
    assertRecordMembers(value, path);
    return;
  }
  throw new TypeError(`${path} is not JSON serializable`);
}

/**
 * Runtime validator for a closed canonical JSON payload: a plain object whose
 * every member is JSON data (null, string, finite/safe number, boolean, array
 * or nested plain object). Rejects non-JSON values such as functions, Date
 * instances, bigint, symbol and undefined so callers can build `JsonObject`
 * canonical payloads and outbox envelopes without assertion casts.
 */
export function assertClosedJsonObject(value: unknown, name = 'payload'): asserts value is JsonObject {
  if (!isPlainRecord(value)) throw new TypeError(`${name} must be a closed JSON object`);
  assertRecordMembers(value, name);
}

/**
 * Type-level fixtures (verified by `npm run typecheck`): if `JsonValue` is
 * widened, the @ts-expect-error directives below become unused and the
 * typecheck fails, proving function/Date/undefined cannot enter a closed
 * canonical JSON payload.
 */
function closedJsonPayloadTypeFixtures(): void {
  // @ts-expect-error a function value cannot enter a closed JSON payload
  const _functionPayload: JsonObject = { fn: () => 1 };
  // @ts-expect-error a Date instance cannot enter a closed JSON payload
  const _datePayload: JsonObject = { at: new Date() };
  // @ts-expect-error an undefined value cannot enter a closed JSON payload
  const _undefinedPayload: JsonObject = { missing: undefined };
}
