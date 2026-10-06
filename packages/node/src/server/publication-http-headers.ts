import {
  createPublicationRepresentationEtag,
  type PublicationRepresentationEtagInput,
} from './publication-representation-etag.js';
import { mergePublicationVary } from './publication-vary.js';

/** Maximum representation size accepted by the HTTP header adapter. */
export const PUBLICATION_HTTP_MAX_REPRESENTATION_BYTES = 64 * 1024 * 1024;

type PublicationHeadersInit = Headers | [string, string][] | Record<string, string>;

export interface PublicationRepresentationHttpHeadersInput extends PublicationRepresentationEtagInput {
  /** Resource modification instant used for the HTTP Last-Modified field. */
  readonly lastModified: Date;
  /** Existing response headers are copied and left intact unless generated fields replace them. */
  readonly headers?: PublicationHeadersInit;
}

/**
 * Builds response headers for one concrete Publication representation.
 * The generated ETag is strong and quoted; Last-Modified is IMF-fixdate.
 */
export function createPublicationRepresentationHttpHeaders(
  input: PublicationRepresentationHttpHeadersInput,
): Headers {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new TypeError('Publication representation HTTP header input must be an object.');
  }
  const allowedKeys = new Set([
    'representation', 'revision', 'projectionKey', 'queryContract', 'query',
    'negotiatedMediaType', 'protocolVersion', 'snapshotIdentity', 'pageIdentity',
    'principalScope', 'lastModified', 'headers',
  ]);
  for (const key of Object.keys(input)) {
    if (!allowedKeys.has(key)) throw new TypeError(`Unsupported Publication HTTP header input field: ${key}.`);
  }
  const representationBytes = typeof input.representation === 'string'
    ? new TextEncoder().encode(input.representation)
    : input.representation;
  if (!(representationBytes instanceof Uint8Array)) {
    throw new TypeError('representation must be a string or Uint8Array.');
  }
  if (representationBytes.byteLength > PUBLICATION_HTTP_MAX_REPRESENTATION_BYTES) {
    throw new RangeError(`representation must not exceed ${PUBLICATION_HTTP_MAX_REPRESENTATION_BYTES} bytes.`);
  }

  const lastModified = validateLastModified(input.lastModified);
  assertSafeHeaderInput(input.headers);
  let headers: Headers;
  try {
    headers = new Headers(input.headers);
  } catch {
    // Do not expose implementation error text, which may include untrusted
    // header names or values.
    throw new TypeError('Invalid HTTP headers.');
  }
  const etag = createPublicationRepresentationEtag(input);
  const vary = mergePublicationVary(headers.get('vary') ?? undefined, [
    'Accept',
    'Collection-Protocol-Version',
  ]);
  if (vary !== undefined) headers.set('vary', vary);
  headers.set('etag', etag);
  headers.set('last-modified', lastModified.toUTCString());
  return headers;
}

function assertSafeHeaderInput(value: PublicationHeadersInit | undefined): void {
  if (value === undefined) return;
  const entries: Iterable<readonly [string, string]> = value instanceof Headers
    ? value
    : Array.isArray(value)
      ? value
      : Object.entries(value);
  for (const entry of entries) {
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string' || typeof entry[1] !== 'string') {
      throw new TypeError('Invalid HTTP headers.');
    }
    if (/[\r\n]/u.test(entry[0]) || /[\r\n]/u.test(entry[1])) {
      throw new TypeError('HTTP headers must not contain CR or LF characters.');
    }
  }
}

/** Short alias for callers that already use the Publication HTTP namespace. */
export const createPublicationHttpHeaders = createPublicationRepresentationHttpHeaders;
export const createPublicationRepresentationHeaders = createPublicationRepresentationHttpHeaders;

function validateLastModified(value: Date): Date {
  if (!(value instanceof Date)) throw new TypeError('lastModified must be a Date.');
  const millis = value.getTime();
  if (!Number.isFinite(millis) || !Number.isInteger(millis)) {
    throw new TypeError('lastModified must be a valid Date.');
  }
  // HTTP-date has one-second precision. Reject dates outside the range where
  // Date#toUTCString can produce a valid IMF-fixdate rather than silently
  // truncating or emitting an implementation-specific format.
  const normalized = new Date(Math.floor(millis / 1000) * 1000);
  const rendered = normalized.toUTCString();
  if (!/^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/u.test(rendered)) {
    throw new RangeError('lastModified must be representable as an IMF-fixdate.');
  }
  return normalized;
}
