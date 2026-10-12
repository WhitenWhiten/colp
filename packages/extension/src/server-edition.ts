import { readBoundedJson } from './json-response.js';

const MANIFEST_MAX_BYTES = 512 * 1_024;
const REQUEST_TIMEOUT_MS = 8_000;

/** `features.edition.version` from a Collection Protocol manifest, mount or top level. */
export function readEditionVersion(manifest: unknown): string | undefined {
  if (!record(manifest)) return undefined;
  const top = editionVersion(manifest.features);
  if (top) return top;
  if (!Array.isArray(manifest.mounts)) return undefined;
  for (const mount of manifest.mounts) {
    if (!record(mount)) continue;
    const version = editionVersion(mount['https://know-n.com/colp/extensions/server'] ?? mount.features);
    if (version) return version;
  }
  return undefined;
}

export async function fetchEditionVersion(origin: string, fetcher: typeof fetch = fetch): Promise<string | undefined> {
  let manifestUrl: URL;
  try {
    const base = new URL(origin);
    if (base.protocol !== 'https:' && base.protocol !== 'http:') return undefined;
    manifestUrl = new URL('/.well-known/collection-protocol', base.origin);
  } catch {
    return undefined;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetcher(manifestUrl, {
      redirect: 'error', cache: 'no-store', signal: controller.signal, credentials: 'omit',
      headers: {
        Accept: 'application/vnd.collection-protocol.manifest+json;version=0.2',
        'Collection-Protocol-Version': '0.2',
      },
    });
    if (!response.ok) return undefined;
    return readEditionVersion(await readBoundedJson(response, MANIFEST_MAX_BYTES, 'manifest_invalid', { signal: controller.signal }));
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

function editionVersion(features: unknown): string | undefined {
  if (!record(features) || !record(features.edition)) return undefined;
  const version = features.edition.version;
  return typeof version === 'string' && version.length > 0 ? version : undefined;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
