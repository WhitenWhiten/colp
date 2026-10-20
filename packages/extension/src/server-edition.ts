import { readPublicServerManifest } from './public-server-manifest.js';

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
  return readEditionVersion(await readPublicServerManifest(origin, fetcher));
}

function editionVersion(features: unknown): string | undefined {
  if (!record(features) || !record(features.edition)) return undefined;
  const version = features.edition.version;
  return typeof version === 'string' && version.length > 0 ? version : undefined;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
