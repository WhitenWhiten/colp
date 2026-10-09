import { MAX_PUBLICATION_ENDPOINT_TEMPLATE_BYTES } from '../semantic/publication-endpoint-templates.js';

/** Manifest responses are bounded by the discovery route's wire contract. */
export const MAX_PUBLICATION_MANIFEST_RESPONSE_BYTES = 65_536;

export function assertManifestEndpointTemplateBudget(source: string): void {
  if (source.length > MAX_PUBLICATION_ENDPOINT_TEMPLATE_BYTES
    || new TextEncoder().encode(source).byteLength > MAX_PUBLICATION_ENDPOINT_TEMPLATE_BYTES) {
    throw new TypeError('Manifest endpoint template exceeds its byte budget.');
  }
}

export function validateIntegerOption(name: string, value: number, minimum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new RangeError(`${name} must be a safe integer greater than or equal to ${minimum}.`);
  }
  return value;
}

export function assertPublisherEndpointOrigin(url: URL, baseUrl: string): void {
  if (url.origin !== new URL(baseUrl).origin) {
    throw new TypeError('Publisher endpoint must remain within its Mount origin.');
  }
}
