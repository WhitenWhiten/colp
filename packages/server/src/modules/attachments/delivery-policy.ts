/**
 * P4A-I11 pure delivery policies for the credential-free isolated origin
 * (`phase4a: deliver downloads from an isolated origin`).
 *
 * This file is deliberately PURE: no I/O, no framework types, no
 * infrastructure imports, no secrets. It owns the response-level contract the
 * I11 production host and its transport route apply:
 *
 *  - `Content-Disposition: attachment` filename policy: the user filename is
 *    ONLY a strictly-encoded download suggestion. CR/LF/control characters are
 *    stripped, the suggestion is bounded to 255 UTF-8 bytes (truncated at code
 *    point boundaries, safe extension preserved) and the value is emitted as
 *    an ASCII `filename="..."` fallback plus an RFC 5987/6266
 *    `filename*=UTF-8''...` encoded form; the final header value is
 *    hard-capped. The cleaned name is never interpolated into keys, paths, or
 *    other headers.
 *  - response byte budget: a compile-time hard ceiling plus a
 *    config-bounded effective ceiling (objects/ranges above it fail closed);
 *  - restricted single-range parsing: `bytes=0-...`/open/suffix ranges produce
 *    206 semantics, unsatisfiable/out-of-range/multi-range/malformed produce
 *    416 semantics, and no header means the full 200 representation;
 *  - cache policy constants (`Cache-Control: private,no-store`) and the
 *    fixed security-header set (nosniff, CSP/sandbox-related responses,
 *    framing/referrer/permissions/resource-policy guards);
 *  - the GET/HEAD method allowlist;
 *  - `If-None-Match` handling (weak comparison, `*` wildcard) -> 304;
 *  - `If-Range` handling (strong entity-tag comparison only): a `Range` header
 *    is honored only when the `If-Range` validator exactly matches the current
 *    ETag, otherwise `Range` is ignored and the full 200 representation is
 *    served (never a 206 spliced from a different object version);
 *  - the stable upstream-failure -> HTTP status mapping (404/403/503, zero
 *    body, no redirect);
 *  - the fixed, non-sensitive delivery request-log entry shape (never a key,
 *    URL, token, credential, or digest).
 */
import { ATTACHMENTS_SINGLE_PUT_HARD_CEILING_BYTES } from './attachments-config.js';

// ---------------------------------------------------------------------------
// Compile-time budgets and fixed response policy
// ---------------------------------------------------------------------------

/** Absolute hard ceiling for any single delivery response body (bytes). */
export const DELIVERY_RESPONSE_HARD_CEILING_BYTES = ATTACHMENTS_SINGLE_PUT_HARD_CEILING_BYTES;

/** Fixed cache policy: private only, never shared/public, never revalidated. */
export const DELIVERY_CACHE_CONTROL = 'private,no-store' as const;

/** The delivery origin only ever serves forced downloads; never inline MIME. */
export const DELIVERY_CONTENT_TYPE = 'application/octet-stream' as const;

/** The delivery origin accepts exactly GET and HEAD. */
export const DELIVERY_ALLOWED_METHODS = ['GET', 'HEAD'] as const;

export type DeliveryAllowedMethod = (typeof DELIVERY_ALLOWED_METHODS)[number];

/** Fallback download name when the suggestion is empty after sanitization. */
export const DELIVERY_DEFAULT_FILENAME = 'download' as const;

/**
 * Hard UTF-8 byte budget for a download-name suggestion: RFC 5987 encoding
 * expands non-ASCII bytes roughly threefold, so this budget also bounds the
 * emitted header (255 bytes encode to at most ~765 chars).
 */
export const DELIVERY_FILENAME_MAX_UTF8_BYTES = 255 as const;

/**
 * Absolute hard cap for the final `Content-Disposition` header value: even if
 * the encoding math above regresses, an oversized header is never emitted.
 */
export const DELIVERY_CONTENT_DISPOSITION_HARD_CAP = 2048 as const;

/** Default upstream (R2) read timeout for HEAD/GET through the RO adapter. */
export const DELIVERY_UPSTREAM_TIMEOUT_DEFAULT_MS = 30_000;

// ---------------------------------------------------------------------------
// Filename policy
// ---------------------------------------------------------------------------

/** C0 controls, DEL, and Unicode bidi control characters are never kept. */
const FILENAME_CONTROL_PATTERN = /[\u0000-\u001F\u007F\u200E\u200F\u202A-\u202E\u2066-\u2069]/gu;

/** Printable ASCII allowed in the quoted `filename="..."` fallback. */
const ASCII_FALLBACK_PATTERN = /[^\u0020-\u007E]/gu;

/**
 * RFC 5987 attr-char: the only characters allowed unencoded in `filename*`.
 * Everything else is percent-encoded (including `"`, `\`, `%`, CR/LF).
 */
const RFC5987_ATTR_CHAR = /[A-Za-z0-9!#$&+\-.^_`|~]/u;

/**
 * Strips CR/LF/NUL, all C0 controls, DEL, and Unicode bidi control characters
 * from a user-supplied download suggestion. The result is safe to embed in a
 * header VALUE (the quoted/encoded forms below additionally neutralize any
 * remaining `"`/`\`), and it is NEVER used as a key, path, or header name.
 * Returns the fallback name when nothing remains.
 */
export function sanitizeDownloadFilename(raw: string | null | undefined): string {
  const cleaned = String(raw ?? '')
    .replace(FILENAME_CONTROL_PATTERN, '')
    .trim();
  return cleaned.length > 0 ? cleaned : DELIVERY_DEFAULT_FILENAME;
}

/** Printable-ASCII-only quoted fallback (quotes/backslashes escaped). */
export function asciiFilenameFallback(name: string): string {
  const fallback = name.replace(ASCII_FALLBACK_PATTERN, '').replace(/\\/gu, '\\\\').replace(/"/gu, '\\"');
  return fallback.length > 0 ? fallback : DELIVERY_DEFAULT_FILENAME;
}

/** RFC 5987 `filename*=UTF-8''...` percent-encoded value over the raw bytes. */
export function rfc5987Filename(name: string): string {
  const bytes = new TextEncoder().encode(name);
  let out = '';
  for (const byte of bytes) {
    const char = String.fromCharCode(byte);
    if (RFC5987_ATTR_CHAR.test(char)) {
      out += char;
    } else {
      out += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
    }
  }
  return out.length > 0 ? out : DELIVERY_DEFAULT_FILENAME;
}

/** A trailing extension worth keeping when truncating: 1-8 ASCII letters/digits. */
const SAFE_EXTENSION_PATTERN = /^[A-Za-z0-9]{1,8}$/u;

/** Truncates `text` to at most `maxBytes` UTF-8 bytes, never splitting a code point. */
function truncateToUtf8Bytes(text: string, maxBytes: number, encoder: TextEncoder): string {
  let out = '';
  let bytes = 0;
  for (const codePoint of text) {
    const codePointBytes = encoder.encode(codePoint).byteLength;
    if (bytes + codePointBytes > maxBytes) break;
    out += codePoint;
    bytes += codePointBytes;
  }
  return out;
}

/**
 * Bounds a download-name suggestion to at most `maxBytes` UTF-8 bytes
 * (default 255), truncating only at code point boundaries. When the full name
 * overflows, a short safe ASCII extension (e.g. `.pdf`) is kept so the
 * download stays recognizable; when nothing fits, the default name is
 * returned. Names at or under the budget pass through unchanged.
 */
export function boundDownloadFilename(name: string, maxBytes = DELIVERY_FILENAME_MAX_UTF8_BYTES): string {
  if (maxBytes <= 0) return DELIVERY_DEFAULT_FILENAME;
  const encoder = new TextEncoder();
  if (encoder.encode(name).byteLength <= maxBytes) return name;

  const dotIndex = name.lastIndexOf('.');
  const extension = dotIndex > 0 ? name.slice(dotIndex + 1) : '';
  if (SAFE_EXTENSION_PATTERN.test(extension)) {
    const stem = name.slice(0, dotIndex);
    const stemBudget = maxBytes - encoder.encode(name.slice(dotIndex)).byteLength;
    if (stemBudget > 0) {
      const boundedStem = truncateToUtf8Bytes(stem, stemBudget, encoder);
      if (boundedStem.length > 0) return `${boundedStem}${name.slice(dotIndex)}`;
    }
  }

  const bounded = truncateToUtf8Bytes(name, maxBytes, encoder);
  return bounded.length > 0 ? bounded : DELIVERY_DEFAULT_FILENAME;
}

/**
 * Full `Content-Disposition` value for a forced download:
 * `attachment; filename="<ascii>"; filename*=UTF-8''<encoded>`.
 * The suggestion is sanitized and byte-bounded (see `boundDownloadFilename`)
 * so the encoded header value is always bounded; as a final guard the value
 * falls back to the default name if it would still exceed the hard cap.
 * The sanitized name never reaches any other header, path, or key.
 */
export function formatContentDisposition(raw: string | null | undefined): string {
  const name = boundDownloadFilename(sanitizeDownloadFilename(raw));
  let value = `attachment; filename="${asciiFilenameFallback(name)}"; filename*=UTF-8''${rfc5987Filename(name)}`;
  if (value.length > DELIVERY_CONTENT_DISPOSITION_HARD_CAP) {
    // Defense in depth: the byte budget keeps every encoding bounded, but an
    // oversized final header is never emitted even if that math regresses —
    // the default name always fits.
    const fallback = DELIVERY_DEFAULT_FILENAME;
    value = `attachment; filename="${asciiFilenameFallback(fallback)}"; filename*=UTF-8''${rfc5987Filename(fallback)}`;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Restricted single-range parsing
// ---------------------------------------------------------------------------

export type DeliveryRange =
  | { readonly kind: 'none' }
  | { readonly kind: 'single'; readonly start: number; readonly end: number }
  | { readonly kind: 'unsatisfiable' };

const SINGLE_BYTE_RANGE_PATTERN = /^bytes=(\d*)-(\d*)$/iu;

/**
 * Parses a single `Range: bytes=...` header against the full object size.
 * Only one byte range is ever served:
 *  - no header                              -> full 200 representation;
 *  - `bytes=0-...`, `bytes=N-`, `bytes=N-M`, `bytes=-K` (suffix) -> 206;
 *  - out-of-range, `bytes=-0`, empty, other units, multi-range -> 416.
 * A suffix longer than the object clamps to the whole representation; an
 * open-ended or over-long end clamps to the last byte.
 */
export function parseSingleByteRange(header: string | null | undefined, size: number): DeliveryRange {
  if (header === undefined || header === null || header.trim() === '') return { kind: 'none' };
  const match = SINGLE_BYTE_RANGE_PATTERN.exec(header.trim());
  if (!match) return { kind: 'unsatisfiable' };
  const rawStart = match[1] ?? '';
  const rawEnd = match[2] ?? '';
  if (rawStart === '' && rawEnd === '') return { kind: 'unsatisfiable' };
  if (size <= 0) return { kind: 'unsatisfiable' };
  if (rawStart === '') {
    // Suffix range: last K bytes.
    const suffix = Number(rawEnd);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return { kind: 'unsatisfiable' };
    return { kind: 'single', start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(rawStart);
  if (!Number.isSafeInteger(start) || start < 0 || start >= size) return { kind: 'unsatisfiable' };
  if (rawEnd === '') return { kind: 'single', start, end: size - 1 };
  const end = Number(rawEnd);
  if (!Number.isSafeInteger(end) || end < start) return { kind: 'unsatisfiable' };
  return { kind: 'single', start, end: Math.min(end, size - 1) };
}

/** Inclusive byte length of a resolved single range. */
export function deliveryRangeLength(range: { readonly start: number; readonly end: number }): number {
  return range.end - range.start + 1;
}

/** `Content-Range` for a satisfied range: `bytes start-end/total`. */
export function formatContentRange(range: { readonly start: number; readonly end: number }, totalSize: number): string {
  return `bytes ${range.start}-${range.end}/${totalSize}`;
}

/** Content-Range for an unsatisfiable range (bytes star slash total) is emitted for 416. */
export function formatUnsatisfiableContentRange(totalSize: number): string {
  return `bytes */${totalSize}`;
}

// ---------------------------------------------------------------------------
// Response byte budget
// ---------------------------------------------------------------------------

/**
 * Effective per-response byte ceiling: never above the compile-time hard
 * ceiling, and additionally bounded by the deployment's single-PUT ceiling
 * (an object cannot legitimately exceed what verification accepted).
 */
export function deliveryResponseByteCeiling(singlePutMaxBytes: number): number {
  return Math.min(DELIVERY_RESPONSE_HARD_CEILING_BYTES, singlePutMaxBytes);
}

/**
 * Ceiling applied to one read: the full object (capped) or the requested
 * range length (capped). A range is only requested after the policy has
 * already verified the object size against the ceiling.
 */
export function deliveryReadByteCeiling(
  ceiling: number,
  size: number,
  range: { readonly kind: 'single'; readonly start: number; readonly end: number } | { readonly kind: 'none' },
): number {
  if (range.kind === 'single') return Math.min(ceiling, deliveryRangeLength(range));
  return Math.min(ceiling, size);
}

// ---------------------------------------------------------------------------
// Security headers / method allowlist
// ---------------------------------------------------------------------------

/**
 * Fixed security-header set for every delivery-origin response (including
 * 4xx/5xx and 304). `Content-Disposition` and `Content-Type` are added by the
 * route (filename-dependent / always octet-stream); `Cache-Control` is here so
 * even error responses are private,no-store.
 */
export function deliverySecurityHeaders(): Readonly<Record<string, string>> {
  return Object.freeze({
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    'cross-origin-resource-policy': 'same-origin',
    'cross-origin-opener-policy': 'same-origin',
    'permissions-policy': 'accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()',
    'cache-control': DELIVERY_CACHE_CONTROL,
  });
}

/** The delivery origin accepts exactly GET and HEAD. */
export function deliveryMethodAllowed(method: string | undefined): method is DeliveryAllowedMethod {
  return method === 'GET' || method === 'HEAD';
}

// ---------------------------------------------------------------------------
// If-None-Match
// ---------------------------------------------------------------------------

/**
 * Weak ETag comparison per RFC 9110: strips a `W/` prefix and compares the
 * opaque-tag. `*` matches any current representation.
 */
function etagMatches(headerEntry: string, currentEtag: string): boolean {
  const entry = headerEntry.trim();
  if (entry === '*') return true;
  const normalized = entry.startsWith('W/') ? entry.slice(2) : entry;
  return normalized === currentEtag;
}

/**
 * Evaluates `If-None-Match` for GET/HEAD: `true` means the representation is
 * unchanged and the route must answer 304 (no body). An absent header or a
 * non-matching list means proceed.
 */
export function evaluateIfNoneMatch(header: string | null | undefined, currentEtag: string): boolean {
  if (header === undefined || header === null || header.trim() === '') return false;
  return header.split(',').some((entry) => etagMatches(entry, currentEtag));
}

/**
 * Evaluates `If-Range` for a Range GET/HEAD per RFC 9110 §13.1.5 (FIX-L-047).
 * Returns `true` ONLY when the header is a STRONG entity-tag that exactly
 * matches the current representation ETag; in that case the route may honor
 * the `Range` header. Everything else — a weak entity-tag (`W/` prefix, which
 * clients MUST NOT send for If-Range), the HTTP-date form (not supported:
 * explicitly ignored), the `*` wildcard, a malformed value, or an absent
 * header — returns `false`, and the route must ignore `Range` and serve the
 * full 200 representation. The header has no effect without a `Range` header.
 */
export function evaluateIfRange(header: string | null | undefined, currentEtag: string): boolean {
  if (header === undefined || header === null || header.trim() === '') return false;
  const value = header.trim();
  if (value.startsWith('W/')) return false;
  return value === currentEtag;
}

// ---------------------------------------------------------------------------
// Stable upstream-failure -> HTTP status mapping
// ---------------------------------------------------------------------------

/**
 * Module-port read/head outcome classes (never provider/SDK text) mapped to
 * the stable delivery-origin status. All of these responses are zero-body and
 * never redirect:
 *  - not found / generation retired (etag mismatch) / denied -> 404
 *    (existence-hidden, matching the I10 admission policy);
 *  - size above the delivery budget -> 403 (object exists but cannot be served);
 *  - provider retryable/unknown/contract drift -> 503 (upstream failure).
 */
export type DeliveryUpstreamFailureClass =
  | 'not_found'
  | 'etag_mismatch'
  | 'denied'
  | 'retryable'
  | 'unknown'
  | 'contract_drift'
  | 'overflow';

export function deliveryUpstreamStatus(failure: { readonly class: DeliveryUpstreamFailureClass }): 404 | 403 | 503 {
  if (failure.class === 'overflow') return 403;
  if (failure.class === 'not_found' || failure.class === 'etag_mismatch' || failure.class === 'denied') return 404;
  return 503;
}

// ---------------------------------------------------------------------------
// Fixed non-sensitive delivery request log
// ---------------------------------------------------------------------------

/**
 * The only delivery-origin log shape. It NEVER contains the capability token,
 * the blob/generation identity, the R2 key, a URL, a credential, a digest, or
 * a filename — the plan's "no key/URL in logs" contract.
 */
export interface DeliveryRequestLogEntry {
  readonly status: number;
  readonly byteCount: number;
  readonly receivedCookies: boolean;
  readonly receivedAuthorization: boolean;
  readonly receivedReferer: boolean;
  readonly setCookies: boolean;
  readonly range?: string;
}

// ---------------------------------------------------------------------------
// Generation resolution port (key resolution for the credential-free host)
// ---------------------------------------------------------------------------

/**
 * Exact opaque generation handle the delivery host needs to read bytes over
 * the RO object-store path. The I11 host never accepts a key from client
 * input: the generation identity comes from the verified capability claims,
 * and this resolver maps that identity to the exact physical handle. In the
 * real deployment this is the delivery RO ledger read path; tests and the
 * evidence CLI inject a fixture resolver over the same production host.
 */
export interface DeliveryGenerationHandle {
  readonly generationId: string;
  readonly key: string;
}

export type DeliveryGenerationResolution =
  | { readonly found: true; readonly handle: DeliveryGenerationHandle }
  | { readonly found: false };

export type DeliveryGenerationResolver = (claims: {
  readonly blobId: string;
  readonly generationId: string;
}) => Promise<DeliveryGenerationResolution>;
