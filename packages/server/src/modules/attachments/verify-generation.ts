/**
 * P4A-I09 bounded streamed verification pipeline (productionized from the
 * proven I03 harness, plan §6 I09).
 *
 * Verifies an exact generation's bytes with:
 *  - a stream constrained by an AbortSignal and a hard byte ceiling (never an
 *    unbounded Buffer);
 *  - an ordered SHA-256 over the ACTUAL bytes read (chunk size and arrival
 *    count are NOT a contract — only the final ordered bytes/digest and the
 *    hard ceiling are);
 *  - a MIME sniffer that reads only a fixed maximum prefix using real magic
 *    bytes, with an allowlist, polyglot detection, and unknown/suspicious ->
 *    generic forced-download fallback;
 *  - fail-closed classification of truncation, extra trailing bytes,
 *    size/digest mismatch, media mismatch, timeout, abort, and overflow.
 *
 * This module is pure: it performs NO database writes and NO provider calls.
 * The evidence object is a CLOSED ALLOWLIST that never contains a scanner
 * verdict or a `clean`/`safe` boolean — it only proves byte consistency and
 * media evidence for a `stored_private` object.
 */
import { createHash } from 'node:crypto';

export const ATTACHMENTS_VERIFICATION_POLICY_VERSION = 'phase4a-i09-policy-v1' as const;
export const ATTACHMENTS_VERIFICATION_MIME_SNIFF_PREFIX_BYTES = 4096;
/**
 * Stable code shared with the I06 `BlobStoreReadOverflowError.code`
 * (`read_exceeds_ceiling`). The module matches this code string (never the
 * infrastructure error type) so a provider stream that over-delivers is
 * classified `over_hard_limit` and the upstream body is destroyed.
 */
export const ATTACHMENTS_READ_OVERFLOW_ERROR_CODE = 'read_exceeds_ceiling' as const;

export const ATTACHMENTS_VERIFICATION_MEDIA_CATEGORIES = [
  'allowlisted', 'suspicious', 'unknown',
] as const;
export type VerificationMediaCategory = typeof ATTACHMENTS_VERIFICATION_MEDIA_CATEGORIES[number];

export const ATTACHMENTS_VERIFICATION_VERDICTS = [
  'verified', 'over_hard_limit', 'truncated', 'extra_trailing_bytes',
  'size_mismatch', 'digest_mismatch', 'etag_mismatch', 'media_mismatch',
  'read_timeout', 'aborted', 'not_found', 'denied', 'retryable', 'unknown',
] as const;
export type VerificationVerdictKind = typeof ATTACHMENTS_VERIFICATION_VERDICTS[number];

export interface VerificationLimits {
  readonly hardByteCeiling: number;
  readonly mimeSniffPrefixBytes: number;
}

export interface VerificationDeclared {
  /** Declared size from the exact-key attestation (untrusted claim). */
  readonly size: number;
  /** Declared SHA-256 (untrusted claim; null skips the digest comparison). */
  readonly sha256: string | null;
  /** Declared media type (untrusted claim; unknown never mismatches). */
  readonly mediaType: string | null;
}

/**
 * Closed evidence allowlist. Extending this shape is a schema/contract change
 * that must ship with the verification-policy version bump.
 */
export interface VerificationEvidence {
  readonly verdict: VerificationVerdictKind;
  readonly byteCount: number;
  readonly sha256: string;
  readonly sniffedMediaType: string;
  readonly mediaCategory: VerificationMediaCategory;
  readonly polyglot: boolean;
  readonly policyVersion: string;
  readonly bytesProcessed: number;
}

export interface VerificationStreamSource {
  readonly stream: AsyncIterable<Uint8Array>;
  readonly signal: AbortSignal;
}

/**
 * Fatal fault marker for deterministic crash hooks. A fault thrown from a
 * verification crash hook (or any fatal fault) PROPAGATES out of the pipeline
 * instead of being classified as retryable/unknown, so a simulated process
 * death aborts the worker exactly at the chosen crash point. Production never
 * installs hooks; ordinary mid-stream transport failures remain classified.
 */
export class VerificationFatalError extends Error {
  readonly code = 'verification_fatal' as const;
  constructor(message = 'verification fatal fault') {
    super(message);
    this.name = 'VerificationFatalError';
  }
}

// ---------------------------------------------------------------------------
// MIME sniffing (fixed maximum prefix, real magic bytes)
// ---------------------------------------------------------------------------

const PNG_MAGIC = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
const JPEG_MAGIC = Uint8Array.of(0xff, 0xd8, 0xff);
const GIF87_MAGIC = new TextEncoder().encode('GIF87a');
const GIF89_MAGIC = new TextEncoder().encode('GIF89a');
const PDF_MAGIC = new TextEncoder().encode('%PDF');

const HTML_EXEC_MARKERS = ['<script', '<html', '<head', '<body', '<!doctype html', 'onerror=', 'javascript:'];

export interface MimeSniffResult {
  mediaType: string;
  category: VerificationMediaCategory;
  polyglot: boolean;
  declaredMediaType?: string;
}

function startsWithBytes(prefix: Uint8Array, magic: Uint8Array): boolean {
  if (prefix.byteLength < magic.byteLength) return false;
  for (let index = 0; index < magic.byteLength; index += 1) {
    if (prefix[index] !== magic[index]) return false;
  }
  return true;
}

function asciiLower(prefix: Uint8Array): string {
  let out = '';
  for (let index = 0; index < prefix.byteLength; index += 1) {
    out += String.fromCharCode(prefix[index]!);
  }
  return out.toLowerCase();
}

/**
 * Sniffs a fixed maximum prefix of the actual bytes. Only the prefix is ever
 * inspected; the result is media EVIDENCE for a stored_private object, never
 * a cleanliness verdict. Unknown content degrades to generic octet-stream.
 */
export function sniffMime(prefix: Uint8Array, declaredMediaType?: string): MimeSniffResult {
  const text = asciiLower(prefix);
  const hasMarker = (markers: readonly string[]) => markers.some((marker) => text.includes(marker));
  let mediaType: string | undefined;
  let category: VerificationMediaCategory = 'unknown';
  let polyglot = false;

  if (startsWithBytes(prefix, PNG_MAGIC)) mediaType = 'image/png';
  else if (startsWithBytes(prefix, JPEG_MAGIC)) mediaType = 'image/jpeg';
  else if (startsWithBytes(prefix, GIF87_MAGIC) || startsWithBytes(prefix, GIF89_MAGIC)) mediaType = 'image/gif';
  else if (startsWithBytes(prefix, PDF_MAGIC)) mediaType = 'application/pdf';
  else if (text.includes('<svg')) mediaType = 'image/svg+xml';
  else if (hasMarker(['<html', '<!doctype html', '<head', '<body', '<script'])) mediaType = 'text/html';

  if (mediaType === undefined) {
    mediaType = 'application/octet-stream';
    category = 'unknown';
  } else if (mediaType === 'text/html' || mediaType === 'image/svg+xml') {
    category = 'suspicious';
  } else if (hasMarker(HTML_EXEC_MARKERS)) {
    polyglot = true;
    category = 'suspicious';
  } else {
    category = 'allowlisted';
  }

  // `declaredMediaType` is optional; omit it entirely when there is none so
  // the result shape stays stable for deep-equality contracts.
  return declaredMediaType === undefined
    ? { mediaType, category, polyglot }
    : { mediaType, category, polyglot, declaredMediaType };
}

const SAFE_TYPES = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/gif']);

function normalizeMediaType(declared: string | null): string | undefined {
  if (!declared) return undefined;
  const normalized = declared.split(';')[0]!.trim().toLowerCase();
  return normalized === '' ? undefined : normalized;
}

/**
 * A declared "safe" type that contradicts the sniffed bytes is a mismatch;
 * HTML/SVG/polyglot content with a matching declared type is only suspicious
 * (forced download), never a false cleanliness claim. Unknown claims degrade
 * to generic download and never produce a mismatch (plan §6 I09
 * anti-false-negative: unknown MIME is not malware).
 */
export function mediaMismatch(declared: string | null, sniffed: MimeSniffResult): boolean {
  const normalized = normalizeMediaType(declared);
  if (normalized === undefined || normalized === 'application/octet-stream') return false;
  if (sniffed.category === 'unknown') return false;
  if (sniffed.category === 'suspicious') {
    if (sniffed.polyglot) return false;
    return SAFE_TYPES.has(normalized);
  }
  return normalized !== sniffed.mediaType;
}

// ---------------------------------------------------------------------------
// Stream iteration with unified abort/timeout classification
// ---------------------------------------------------------------------------

function abortError(): Error {
  const error = new Error('verification aborted');
  error.name = 'AbortError';
  return error;
}

function isTimeoutAbort(signal: AbortSignal): boolean {
  return signal.aborted && (signal.reason as { name?: string } | undefined)?.name === 'TimeoutError';
}

/** Wraps an async iterator so a pending read races with the AbortSignal. */
function iterateWithSignal(
  iterable: AsyncIterable<Uint8Array>,
  signal: AbortSignal,
): AsyncIterable<Uint8Array> {
  const iterator = iterable[Symbol.asyncIterator]();
  const wrapped: AsyncIterator<Uint8Array> = {
    async next(): Promise<IteratorResult<Uint8Array>> {
      if (signal.aborted) throw abortError();
      let rejectAbort: (error: Error) => void = () => {};
      const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
      const onAbort = (): void => rejectAbort(abortError());
      signal.addEventListener('abort', onAbort, { once: true });
      try {
        return await Promise.race([iterator.next(), aborted]);
      } finally {
        // Remove the listener per chunk so a long stream never accumulates
        // abort listeners (bounded memory).
        signal.removeEventListener('abort', onAbort);
      }
    },
    async return(): Promise<IteratorResult<Uint8Array>> {
      if (typeof iterator.return === 'function') return iterator.return();
      return { done: true, value: undefined };
    },
  };
  return { [Symbol.asyncIterator]: () => wrapped };
}

function destroyStream(stream: AsyncIterable<Uint8Array>): void {
  const candidate = stream as Partial<ReadableStream<Uint8Array>>;
  if (typeof candidate.cancel === 'function') {
    candidate.cancel().catch(() => {});
  }
}

function isOverflowError(error: unknown): boolean {
  return typeof error === 'object' && error !== null
    && (error as { code?: unknown }).code === ATTACHMENTS_READ_OVERFLOW_ERROR_CODE;
}

// ---------------------------------------------------------------------------
// Core pipeline
// ---------------------------------------------------------------------------

/**
 * Consumes a stream with a byte ceiling and AbortSignal, never buffering the
 * full object. Early return on overflow cancels the producer stream. The
 * digest is computed over actual ordered bytes.
 */
export async function verifyGenerationStream(
  source: VerificationStreamSource,
  declared: VerificationDeclared,
  limits: VerificationLimits,
): Promise<VerificationEvidence> {
  const hash = createHash('sha256');
  const sniffPrefix = new Uint8Array(Math.max(0, Math.min(limits.mimeSniffPrefixBytes, declared.size)));
  let sniffedBytes = 0;
  let byteCount = 0;

  try {
    for await (const chunk of iterateWithSignal(source.stream, source.signal)) {
      if (source.signal.aborted) {
        throw abortError();
      }
      const view = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
      if (byteCount + view.byteLength > limits.hardByteCeiling) {
        destroyStream(source.stream);
        return buildEvidence('over_hard_limit', byteCount, hash, sniffPrefix, sniffedBytes, declared);
      }
      hash.update(view);
      for (let index = 0; index < view.byteLength && sniffedBytes < sniffPrefix.byteLength; index += 1) {
        sniffPrefix[sniffedBytes] = view[index]!;
        sniffedBytes += 1;
      }
      byteCount += view.byteLength;
    }
  } catch (error) {
    if (error instanceof VerificationFatalError) throw error;
    if (source.signal.aborted) {
      return buildEvidence(isTimeoutAbort(source.signal) ? 'read_timeout' : 'aborted',
        byteCount, hash, sniffPrefix, sniffedBytes, declared);
    }
    if ((error as { name?: string })?.name === 'AbortError') {
      return buildEvidence('aborted', byteCount, hash, sniffPrefix, sniffedBytes, declared);
    }
    if (isOverflowError(error)) {
      destroyStream(source.stream);
      return buildEvidence('over_hard_limit', byteCount, hash, sniffPrefix, sniffedBytes, declared);
    }
    return buildEvidence('unknown', byteCount, hash, sniffPrefix, sniffedBytes, declared);
  }

  const digest = hash.digest('hex');
  if (byteCount !== declared.size) {
    return buildEvidence(byteCount < declared.size ? 'truncated' : 'extra_trailing_bytes',
      byteCount, hash, sniffPrefix, sniffedBytes, declared, digest);
  }
  if (declared.sha256 !== null && digest !== declared.sha256) {
    return buildEvidence('digest_mismatch', byteCount, hash, sniffPrefix, sniffedBytes, declared, digest);
  }
  const mime = sniffMime(sniffPrefix.subarray(0, sniffedBytes), declared.mediaType ?? undefined);
  if (mediaMismatch(declared.mediaType, mime)) {
    return buildEvidence('media_mismatch', byteCount, hash, sniffPrefix, sniffedBytes, declared, digest, mime);
  }
  return buildEvidence('verified', byteCount, hash, sniffPrefix, sniffedBytes, declared, digest, mime);
}

function buildEvidence(
  verdict: VerificationVerdictKind,
  byteCount: number,
  hash: ReturnType<typeof createHash>,
  sniffPrefix: Uint8Array,
  sniffedBytes: number,
  declared: VerificationDeclared,
  digestOverride?: string,
  mimeOverride?: MimeSniffResult,
): VerificationEvidence {
  const digest = digestOverride ?? hash.digest('hex');
  const mime = mimeOverride ?? sniffMime(sniffPrefix.subarray(0, sniffedBytes), declared.mediaType ?? undefined);
  return Object.freeze({
    verdict,
    byteCount,
    sha256: digest,
    sniffedMediaType: mime.mediaType,
    mediaCategory: mime.category,
    polyglot: mime.polyglot,
    policyVersion: ATTACHMENTS_VERIFICATION_POLICY_VERSION,
    bytesProcessed: byteCount,
  });
}

// ---------------------------------------------------------------------------
// Evidence shape guards (closed allowlist, no clean/safe)
// ---------------------------------------------------------------------------

const EVIDENCE_KEYS = Object.freeze([
  'verdict', 'byteCount', 'sha256', 'sniffedMediaType', 'mediaCategory',
  'polyglot', 'policyVersion', 'bytesProcessed',
].sort());

export function verifyEvidenceShape(value: unknown): value is VerificationEvidence {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join('\u0000') !== EVIDENCE_KEYS.join('\u0000')) return false;
  if (!ATTACHMENTS_VERIFICATION_VERDICTS.includes(record.verdict as VerificationVerdictKind)) return false;
  if (!ATTACHMENTS_VERIFICATION_MEDIA_CATEGORIES.includes(record.mediaCategory as VerificationMediaCategory)) return false;
  if (typeof record.byteCount !== 'number' || typeof record.sha256 !== 'string'
    || typeof record.sniffedMediaType !== 'string' || typeof record.polyglot !== 'boolean'
    || typeof record.policyVersion !== 'string' || typeof record.bytesProcessed !== 'number') {
    return false;
  }
  return true;
}

/** Throws unless the evidence is exactly the closed allowlist and never clean/safe. */
export function assertNoCleanOrSafeEvidence(evidence: unknown): asserts evidence is VerificationEvidence {
  if (!verifyEvidenceShape(evidence)) throw new Error('verification_evidence_shape_invalid');
  const json = JSON.stringify(evidence);
  if (json.includes('"clean"') || json.includes('"safe"')) {
    throw new Error('verification_evidence_clean_or_safe_forbidden');
  }
}

/**
 * The media type bound into `stored_private`. Allowlisted magic bytes keep
 * their type; unknown AND suspicious (HTML/SVG/polyglot) content degrade to
 * generic `application/octet-stream` so the object is only ever served as a
 * restricted forced download (never inline, never a cleanliness claim).
 */
export function storedMediaTypeForEvidence(evidence: Pick<VerificationEvidence, 'mediaCategory' | 'sniffedMediaType'>): string {
  if (evidence.mediaCategory === 'allowlisted') return evidence.sniffedMediaType;
  return 'application/octet-stream';
}
