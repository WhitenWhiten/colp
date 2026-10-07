export const SYNC_RETIRE_NAMESPACE = 'https://known.example/extensions/sync-retire';

export interface DiscoveredSyncRetireEndpoint {
  readonly href: string;
  readonly method: 'DELETE';
}

/** Black-box discovery: this client knows the extension namespace, never a host route. */
export function discoverSyncRetireEndpoint(manifest: unknown): DiscoveredSyncRetireEndpoint {
  if (!isRecord(manifest) || !Array.isArray(manifest.mounts)) throw new TypeError('Invalid Manifest');
  for (const candidate of manifest.mounts) {
    if (!isRecord(candidate)) continue;
    const extension = candidate[SYNC_RETIRE_NAMESPACE];
    if (!isRecord(extension) || extension.method !== 'DELETE' || extension.requestBody !== false
        || extension.successStatus !== 204 || !Array.isArray(extension.requiredHeaders)) continue;
    const href = extension.href;
    if (typeof href !== 'string') continue;
    const url = new URL(href);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) continue;
    return Object.freeze({ href: url.href, method: 'DELETE' });
  }
  throw new TypeError('Sync retirement extension is not advertised');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
