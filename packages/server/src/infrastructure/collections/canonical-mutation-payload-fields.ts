import type { JsonObject } from '../../modules/collections/index.js';

/**
 * Node `payload_json` extension-field helpers shared by the Postgres canonical
 * mutation adapter (extracted from `canonical-mutation-postgres-ports.ts` under
 * the shrinking-only source-size baseline).
 *
 * These functions only read or merge the canonical carrier fields
 * (`folderRole`, `canonicalUrl`, `urlHash`) and the resource `extensions`
 * object; they perform no locking and no database access.
 */
export const NODE_CARRIER_PAYLOAD_KEYS = ['folderRole', 'canonicalUrl', 'urlHash'] as const;

export function existingExtensions(payload: Record<string, unknown> | null): JsonObject {
  const value = payload?.extensions;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  return value as JsonObject;
}

export function existingNodePayloadFields(payload: Record<string, unknown> | null): Record<string, string> {
  if (!payload) return {};
  const fields: Record<string, string> = {};
  for (const key of NODE_CARRIER_PAYLOAD_KEYS) {
    if (typeof payload[key] === 'string') fields[key] = payload[key];
  }
  return fields;
}

export function nodePayloadFields(fields: JsonObject | undefined, current?: Record<string, unknown> | null): JsonObject {
  const result: Record<string, string> = { ...existingNodePayloadFields(current ?? null) };
  if (!fields) return result;
  for (const key of NODE_CARRIER_PAYLOAD_KEYS) {
    if (typeof fields[key] === 'string') result[key] = fields[key];
    else if (Object.hasOwn(fields, key)) delete result[key];
  }
  return result;
}

export function withExtensions(payload: JsonObject, extensions: JsonObject): JsonObject {
  return { ...payload, extensions };
}
