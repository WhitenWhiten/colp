import type { Manifest, Replica, ReplicaCapabilities } from '../types/index.js';

/** Stable adapter profile identifier used by the Safari browser adapter. */
export const SAFARI_ADAPTER_PROFILE = 'safari-bookmarks-v1' as const;

export interface SafariReplicaCapability {
  readonly adapter: {
    readonly profile: typeof SAFARI_ADAPTER_PROFILE;
    readonly version: string;
  };
  readonly capabilities: ReplicaCapabilities;
}

const LOCAL_ADAPTER_KEYS = new Set([
  'adapter',
  'adapterVersion',
  'adapterProfile',
]);

/**
 * Builds the adapter portion of a Sync Session Replica declaration.
 * Adapter identity is session-local and MUST NOT be copied into an HTTP Manifest.
 */
export function declareSafariReplicaCapability(
  version: string,
  capabilities: ReplicaCapabilities,
): SafariReplicaCapability {
  if (typeof version !== 'string' || version.trim().length === 0) {
    throw new TypeError('Safari adapter version must be a non-empty string.');
  }
  if (typeof capabilities !== 'object' || capabilities === null || Array.isArray(capabilities)) {
    throw new TypeError('Safari adapter capabilities must be an object.');
  }
  return Object.freeze({
    adapter: Object.freeze({ profile: SAFARI_ADAPTER_PROFILE, version }),
    capabilities: Object.freeze({ ...capabilities }),
  });
}

/** Validates that a session Replica declares Safari in its adapter capability. */
export function assertSafariReplicaCapability(replica: Replica): void {
  if (typeof replica !== 'object' || replica === null) {
    throw new TypeError('Sync Session Replica must be an object.');
  }
  if (replica.adapter?.profile !== SAFARI_ADAPTER_PROFILE) {
    throw new TypeError('Safari Sync Sessions must declare the Safari adapter profile.');
  }
  if (typeof replica.adapter.version !== 'string' || replica.adapter.version.trim().length === 0) {
    throw new TypeError('Safari Sync Session adapter version must be a non-empty string.');
  }
}

/**
 * Walk nested plain objects/arrays for local adapter identity keys.
 * Cycle-safe and depth-bounded so adversarial Manifest payloads fail closed
 * without hanging the public boundary check.
 */
function hasLocalAdapterState(
  value: unknown,
  seen: WeakSet<object> = new WeakSet(),
  depth = 0,
): boolean {
  if (depth > 64) return true; // fail closed on pathological nesting
  if (typeof value !== 'object' || value === null) return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) {
    return value.some((item) => hasLocalAdapterState(item, seen, depth + 1));
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (LOCAL_ADAPTER_KEYS.has(key)) return true;
  }
  // Own-key walk only (not prototype chain) for Manifest JSON values.
  return Object.values(record).some((item) => hasLocalAdapterState(item, seen, depth + 1));
}

/**
 * Enforces the public HTTP Manifest boundary. Manifests advertise server
 * Profiles only and must not carry local adapter identity or capability state.
 */
export function assertPublicHttpManifest(manifest: Manifest): void {
  if (typeof manifest !== 'object' || manifest === null) {
    throw new TypeError('Public HTTP Manifest must be an object.');
  }
  if (hasLocalAdapterState(manifest)) {
    throw new TypeError('Public HTTP Manifest must not contain local adapter state.');
  }
}
