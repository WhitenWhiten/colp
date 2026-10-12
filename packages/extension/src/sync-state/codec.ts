import { SyncStateError, type JsonValue, type UnknownRecord } from './types.js';

export const SECRET_KEY = /credential|token|authorization|verifier|secret|password|cookie/i;
export const DEFAULT_MAX_RECORD_BYTES = 256 * 1024;

export function boundedString(value: unknown, label: string, max = 1024): string { if (typeof value !== 'string' || value.length < 1 || value.length > max)
  throw new SyncStateError('bounded_string_invalid', `${label}: bounded_string_invalid`); return value; }
export function safeInteger(value: unknown, label: string, minimum = 0): number { if (!Number.isSafeInteger(value) || (value as number) < minimum)
  throw new SyncStateError('unsafe_integer', `${label}: unsafe_integer`); return value as number; }
export function strictObject(value: unknown, allowed: readonly string[], label: string, optional: readonly string[] = []): UnknownRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype)
    throw new SyncStateError('object_invalid', `${label}: object_invalid`);
  const keys = Object.keys(value); if (keys.some((key) => !allowed.includes(key)) || allowed.some((key) => !optional.includes(key) && !keys.includes(key)))
    throw new SyncStateError('unknown_or_missing_field', `${label}: unknown_or_missing_field`); rejectSecrets(value); return value as UnknownRecord;
}
/** Protocol extension values are business data, not credential envelopes. */
function extensionMap(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.keys(value).every(key => {
    try { const uri = new URL(key); return uri.protocol === 'https:' && !uri.username && !uri.password; }
    catch { return false; }
  });
}
export function rejectSecrets(value: unknown, seen = new WeakSet<object>()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_KEY.test(key)) throw new SyncStateError('secret_field_forbidden');
    if (key !== 'extensions' || !extensionMap(child)) rejectSecrets(child, seen);
  }
}
export function validateJson(value: unknown, path: string, seen = new WeakSet<object>()): JsonValue {
  return jsonValue(value, path, seen, false);
}
function jsonValue(value: unknown, path: string, seen: WeakSet<object>, extension: boolean): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Number.isInteger(value) && !Number.isSafeInteger(value)) {
      throw new SyncStateError('i_json_invalid');
    }
    return value;
  }
  if (!value || typeof value !== 'object' || seen.has(value)) throw new SyncStateError('i_json_invalid');
  seen.add(value);
  if (Array.isArray(value)) {
    if (value.length > 10_000) throw new SyncStateError('i_json_invalid');
    return value.map((item, index) => jsonValue(item, `${path}[${index}]`, seen, extension));
  }
  if (Object.getPrototypeOf(value) !== Object.prototype) throw new SyncStateError('i_json_invalid');
  return Object.fromEntries(Object.entries(value).map(([key, child]) => {
    if (!extension && SECRET_KEY.test(key)) throw new SyncStateError('secret_field_forbidden');
    return [key, jsonValue(child, `${path}.${key}`, seen, extension || key === 'extensions' && extensionMap(child))];
  }));
}
export function validateRecord(value: unknown, maxBytes: number) { rejectSecrets(value); validateJson(value, 'record');
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > maxBytes) throw new SyncStateError('record_too_large'); }
export function replaceLocalToken(value: unknown, eventId: string, opId: string): unknown {
  if (typeof value === 'string') {
    if (value === eventId) return opId;
    if (value === `pending-${eventId}`) return `pending-${opId}`;
    if (value === `local-${eventId}`) return `local-${opId}`;
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => replaceLocalToken(item, eventId, opId));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .map(([key, child]) => [key, replaceLocalToken(child, eventId, opId)]));
  return value;
}
/** SYNC-F013: JSON.stringify(undefined) returns undefined — this canonical
 * form throws i_json_invalid rather than silently dropping keys, so an
 * undefined value in any fingerprinted payload is caught loudly. All current
 * producers (ack envelope, push attempt bodies, receipt digests) pass
 * codec-validated rows; keep the loud failure instead of dropping keys, which
 * would silently change digests for any future caller. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') { const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`; }
  const encoded = JSON.stringify(value); if (encoded === undefined) throw new SyncStateError('i_json_invalid'); return encoded;
}
export function clone<T>(value: T): T { return structuredClone(value); }
