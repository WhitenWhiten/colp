import {
  cloneAndFreezeJsonData, parseIJson, resolveIJsonParseLimits,
  IJsonLimitError, MAX_I_JSON_SOURCE_BYTES, type IJsonParseLimits,
} from '../schema/json.js';
import { readPublicationRequestBytes, type PublicationJsonRequestOptions } from './publication-request-body.js';
import { preparedPublicationJsonBytes } from './publication-prepared-json.js';
export type { PublicationJsonRequestOptions } from './publication-request-body.js';

const typedArrayByteLength = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype), 'byteLength',
)!.get!;
const arrayBufferByteLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength')!.get!;

/** Publication HTTP JSON media type and byte-level UTF-8 helpers. */
export const PUBLICATION_JSON_MEDIA_TYPE = 'application/json; charset=utf-8' as const;

export function publicationUtf8JsonBytes(value: unknown): Uint8Array {
  const prepared = preparedPublicationJsonBytes(value);
  if (prepared !== undefined) return prepared;
  // Frozen caller data is not proof of validation. Unregistered values still
  // pass the complete data boundary before stringify, including unsafe numbers.
  const source = JSON.stringify(cloneAndFreezeJsonData(value));
  if (source === undefined) throw new TypeError('Publication JSON value is not serializable.');
  return new TextEncoder().encode(source);
}

export function decodePublicationUtf8Json(
  body: Uint8Array | ArrayBuffer,
  limits: IJsonParseLimits = {},
): unknown {
  resolveIJsonParseLimits(limits);
  const maxBytes = limits.maxBytes ?? MAX_I_JSON_SOURCE_BYTES;
  // Public callers can shadow byteLength. Charge the internal-slot size before
  // constructing a view or allowing TextDecoder to allocate a source string.
  const isView = body instanceof Uint8Array;
  const byteLength = Reflect.apply(isView ? typedArrayByteLength : arrayBufferByteLength, body, []) as number;
  if (byteLength > maxBytes) throw new IJsonLimitError('max_bytes', maxBytes);
  const bytes = isView ? body : new Uint8Array(body);
  const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  return parseIJson(source, limits);
}

/**
 * Read JSON under an 8 MiB / 30 second default budget, rejecting non-UTF-8 data.
 * Content-Length is only an early-rejection hint; streamed bytes are counted.
 * Oversize bodies throw RangeError and are cancelled. Deadlines throw a
 * TimeoutError DOMException; caller/request cancellation retains its reason.
 * Hosts still own HTTP error mapping, transport limits and authentication.
 */
export async function readPublicationJsonRequest(
  request: Request,
  options: PublicationJsonRequestOptions = {},
): Promise<unknown> {
  const contentType = request.headers.get('content-type');
  const match = contentType?.match(/(?:^|;)\s*charset\s*=\s*(?:"([^"]+)"|([^;\s]+))/iu);
  const charset = (match?.[1] ?? match?.[2])?.toLowerCase();
  if (charset !== undefined && charset !== 'utf-8') {
    throw new TypeError('Publication JSON requests must use UTF-8.');
  }
  return decodePublicationUtf8Json(await readPublicationRequestBytes(request, options));
}

export function publicationJsonHeaders(bytes: Uint8Array): Readonly<Record<string, string>> {
  return Object.freeze({ 'content-type': PUBLICATION_JSON_MEDIA_TYPE, 'content-length': String(bytes.byteLength) });
}

export function createPublicationJsonResponse(value: unknown, init: ResponseInit = {}): Response {
  const bytes = publicationUtf8JsonBytes(value);
  const headers = new Headers(init.headers);
  if (!headers.has('content-type')) headers.set('content-type', PUBLICATION_JSON_MEDIA_TYPE);
  headers.set('content-length', String(bytes.byteLength));
  return new Response(bytes, { ...init, headers });
}
