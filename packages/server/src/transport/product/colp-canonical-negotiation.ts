const COLP_COLLECTION_METADATA_TYPE = 'application/vnd.collection-protocol.collection+json';

/**
 * COLP tombstone wins when the client names the collection-metadata type
 * and/or sends Collection-Protocol-Version. Anything else on `/c/:slug` is the
 * web app's page (served by the ingress), not this server's.
 */
export function wantsColpCanonicalTombstone(input: {
  readonly accept: string | undefined;
  readonly protocolVersion: string | readonly string[] | undefined;
}): boolean {
  if (hasProtocolVersion(input.protocolVersion)) return true;
  return acceptIncludesType(input.accept, COLP_COLLECTION_METADATA_TYPE);
}

function hasProtocolVersion(value: string | readonly string[] | undefined): boolean {
  if (value === undefined) return false;
  if (typeof value === 'string') return value.trim() !== '';
  return value.some((entry) => entry.trim() !== '');
}

function acceptIncludesType(accept: string | undefined, expected: string): boolean {
  if (accept === undefined || accept.trim() === '') return false;
  for (const range of accept.split(',')) {
    const segments = range.split(';').map((part) => part.trim().toLowerCase());
    const type = segments[0];
    if (type !== expected) continue;
    const quality = parseQuality(segments.slice(1));
    if (quality > 0) return true;
  }
  return false;
}

function parseQuality(parameters: readonly string[]): number {
  const raw = parameters.find((parameter) => parameter.startsWith('q='));
  if (raw === undefined) return 1;
  const quality = Number(raw.slice(2));
  return Number.isFinite(quality) ? quality : 0;
}
