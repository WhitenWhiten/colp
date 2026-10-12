import { createHash } from 'node:crypto';

const PHASE3_METADATA_DIGEST_DOMAIN = 'known.p3-38.redacted-metadata.v1';

function sha(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function domainSeparatedPhase3MetadataDigest(label, value) {
  if (!/^[a-z][a-z0-9-]{0,63}$/u.test(label)) {
    throw new TypeError('P3-38 metadata digest label is invalid');
  }
  return sha(`${PHASE3_METADATA_DIGEST_DOMAIN}:${label}\0${value}`);
}

export function markerVariants(markers) {
  const variants = new Set();
  for (const marker of markers) {
    const middle = Math.floor(marker.length / 2);
    for (const value of [
      marker,
      marker.slice(0, middle),
      marker.slice(middle),
      encodeURIComponent(marker),
      Buffer.from(marker).toString('base64'),
      JSON.stringify(marker).slice(1, -1),
      sha(marker),
    ]) {
      if (value.length >= 8) variants.add(value);
    }
  }
  return [...variants];
}

export function containsPhase3Marker(markers, text) {
  return markerVariants(markers).some((needle) => text.includes(needle));
}

export function redactPhase3MarkerBytes(markers, input) {
  const bytes = Buffer.from(input);
  const needles = markerVariants(markers)
    .map((needle) => Buffer.from(needle))
    .sort((left, right) => right.length - left.length);
  for (const needle of needles) {
    for (let offset = bytes.indexOf(needle); offset >= 0; offset = bytes.indexOf(needle, offset + needle.length)) {
      bytes.fill(0x78, offset, offset + needle.length);
    }
  }
  return bytes;
}
