/**
 * P4A-I06 minimal object-storage port for the R2 generation store (ADR-0020).
 *
 * This file IS the infrastructure boundary for object storage. It MUST NOT
 * import or re-export any AWS SDK / provider type (see
 * `docs/01-module-boundaries.md` and the boundary checker). The business side
 * (I08 issue grant, I09 verification, I14 cleanup) only ever receives:
 *
 *  - stable logical identity and generation identity with an opaque key handle,
 *  - an ETag read validator, byte count, digest, and media evidence,
 *  - fixed stable error classes.
 *
 * The port deliberately exposes NO overwrite, copy-over, rename, multipart, or
 * list-prefix operation, and `deleteExact` never claims a provider
 * precondition (no If-Match on DELETE). Absence is confirmed ONLY by an
 * exact-key HEAD (`headExact`/`confirmAbsent` returning `found: false`),
 * never by a DELETE 2xx.
 */
import { createHash } from 'node:crypto';

// ---------------------------------------------------------------------------
// Stable failure classification
// ---------------------------------------------------------------------------

/**
 * Stable provider-failure classes. `contract_drift` is reserved for responses
 * the adapter cannot reconcile with the provider contract (malformed 2xx,
 * an unexpected status, or a DELETE precondition the adapter never sends).
 */
export type BlobStoreFailureClass =
  | 'precondition'
  | 'not_found'
  | 'denied'
  | 'retryable'
  | 'aborted'
  | 'unknown'
  | 'contract_drift';

export interface BlobStoreFailure {
  readonly class: BlobStoreFailureClass;
  /** Stable, non-sensitive, machine-readable code (never SDK English text). */
  readonly code: string;
  /** HTTP status observed at the provider, when available. */
  readonly status?: number;
}

export class BlobStoreError extends Error implements BlobStoreFailure {
  readonly class: BlobStoreFailureClass;
  readonly code: string;
  readonly status?: number;

  constructor(failure: BlobStoreFailure, message?: string) {
    super(message ?? `${failure.class}:${failure.code}`);
    this.name = 'BlobStoreError';
    this.class = failure.class;
    this.code = failure.code;
    this.status = failure.status;
  }
}

/**
 * Invalid port input (programming/contract error), never a provider failure:
 * malformed handle, TTL out of range, ceiling invalid, store already closed.
 */
export class BlobStorePortError extends Error {
  readonly code: string;
  constructor(code: string, message?: string) {
    super(message ?? code);
    this.name = 'BlobStorePortError';
    this.code = code;
  }
}

/**
 * Size-bound violation: the read stream exceeded its byte ceiling and the
 * upstream provider body was destroyed. This is deliberately NOT a
 * BlobStoreError: overflow is size-bound evidence for the verification
 * pipeline (I03/I09 map it to `over_hard_limit`), not a provider-failure
 * class, and must never be conflated with missing/precondition/unknown.
 */
export class BlobStoreReadOverflowError extends Error {
  readonly code = 'read_exceeds_ceiling' as const;
  constructor(readonly byteCeiling: number) {
    super(`stream exceeded byte ceiling ${byteCeiling}`);
    this.name = 'BlobStoreReadOverflowError';
  }
}

const RETRYABLE_HTTP_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const PRECONDITION_NAME = /^(?:PreconditionFailed|NotModified)$/iu;
const NOT_FOUND_NAME = /^(?:NoSuchKey|NotFound|NoSuchBucket|NoSuchUpload|KeyDoesNotExist)$/iu;
const DENIED_NAME = /^(?:AccessDenied|InvalidAccessKeyId|SignatureDoesNotMatch|RequestTimeTooSkewed|ExpiredToken|InvalidToken|InvalidSecurity|UnrecognizedClientException|AuthorizationHeaderMalformed)$/iu;
const RETRYABLE_NAME = /^(?:SlowDown|RequestTimeout|RequestTimeoutException|ServiceUnavailable|InternalError|TooManyRequests|Throttling|ThrottlingException|TimeoutError|RequestTimeTooSkewed)$/iu;
const RETRYABLE_ERRNO = /^(?:ECONNRESET|EPIPE|ETIMEDOUT|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EADDRNOTAVAIL|EHOSTUNREACH|ENETUNREACH|ERR_STREAM_PREMATURE_CLOSE)$/iu;

/**
 * Classifies a provider/transport failure from HTTP status, error name, error
 * code (provider metadata), and errno — in that preference order. SDK English
 * message text is never matched (plan §5.6 / I06 anti-false-negative).
 */
export function classifyBlobStoreFailure(value: unknown): BlobStoreFailure {
  const candidate = value as {
    name?: unknown;
    code?: unknown;
    errno?: unknown;
    $metadata?: { httpStatusCode?: number };
  };
  const status = typeof candidate?.$metadata?.httpStatusCode === 'number'
    ? candidate.$metadata.httpStatusCode
    : undefined;
  if (status !== undefined) {
    if (status === 412) return { class: 'precondition', code: 'precondition_failed', status };
    if (status === 404) return { class: 'not_found', code: 'object_not_found', status };
    if (status === 401 || status === 403) return { class: 'denied', code: 'access_denied', status };
    if (RETRYABLE_HTTP_STATUS.has(status)) return { class: 'retryable', code: 'provider_retryable', status };
    return { class: 'unknown', code: 'provider_unclassified_status', status };
  }
  const name = typeof candidate?.name === 'string' ? candidate.name : '';
  const code = typeof candidate?.code === 'string' ? candidate.code : '';
  const errno = typeof candidate?.errno === 'string' ? candidate.errno : '';
  if (PRECONDITION_NAME.test(name) || PRECONDITION_NAME.test(code)) {
    return { class: 'precondition', code: 'precondition_failed' };
  }
  if (NOT_FOUND_NAME.test(name) || NOT_FOUND_NAME.test(code)) {
    return { class: 'not_found', code: 'object_not_found' };
  }
  if (DENIED_NAME.test(name) || DENIED_NAME.test(code)) {
    return { class: 'denied', code: 'access_denied' };
  }
  if (RETRYABLE_NAME.test(name) || RETRYABLE_NAME.test(code)
    || RETRYABLE_ERRNO.test(errno) || RETRYABLE_ERRNO.test(code)) {
    return { class: 'retryable', code: 'provider_retryable' };
  }
  if (name.toLowerCase().includes('abort') || code.toLowerCase().includes('abort')) {
    return { class: 'aborted', code: 'request_aborted' };
  }
  return { class: 'unknown', code: 'provider_unclassified' };
}

// ---------------------------------------------------------------------------
// Canonicalization (plan §5.6: unique provider contract, never raw text)
// ---------------------------------------------------------------------------

/** Quoted-ETag canonicalization: `abc123` -> `"abc123"`; quoted/weak forms kept. */
export function canonicalizeEtag(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new BlobStorePortError('etag_empty');
  if (trimmed.startsWith('"') || trimmed.startsWith('W/')) return trimmed;
  return `"${trimmed}"`;
}

/** Lowercases metadata keys and strips any `x-amz-meta-` prefix. */
export function canonicalizeMetadata(metadata: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(metadata)) {
    let normalized = key.trim().toLowerCase();
    if (normalized.startsWith('x-amz-meta-')) normalized = normalized.slice('x-amz-meta-'.length);
    if (normalized) out[normalized] = value;
  }
  return Object.freeze(out);
}

/** Opaque key fingerprint (sha-256 hex); never the key itself. */
export function computeKeyFingerprint(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// Port types
// ---------------------------------------------------------------------------

/** Opaque exact object key handle (never derived from a logical blob id). */
export type OpaqueKeyHandle = string;

export interface GenerationHandle {
  /** Stable logical generation identity from the durable ledger. */
  readonly generationId: string;
  /** Exact opaque physical key for this generation (cleanup-claim formed). */
  readonly key: OpaqueKeyHandle;
}

export interface ObjectIdentity {
  readonly generationId: string;
  readonly size: number;
  /** Canonical quoted ETag — a read validator, never a digest or generation id. */
  readonly etag: string;
  /** Canonicalized provider metadata (lowercased keys, no prefix). */
  readonly metadata: Readonly<Record<string, string>>;
  readonly lastModifiedIso?: string;
}

export interface CreateOnlyGrantOptions {
  /** Create-only grant TTL in seconds (1..deployment ceiling). */
  readonly ttlSeconds: number;
  readonly contentType?: string;
  /** Declared upload byte count; signed into the grant and bounded by the ceiling. */
  readonly contentLength: number;
  readonly metadata?: Readonly<Record<string, string>>;
}

export interface CreateOnlyGrant {
  /** Presigned single-PUT URL; memory only, never logged/persisted. */
  readonly url: string;
  readonly method: 'PUT';
  readonly signedAtIso: string;
  readonly expiresAtIso: string;
  readonly ttlSeconds: number;
  readonly generationId: string;
  readonly keyFingerprint: string;
  readonly ifNoneMatch: '*';
  readonly metadataHeaders: Readonly<Record<string, string>>;
  readonly contentLength: number;
  readonly contentType: string;
}

export type HeadExactOutcome =
  | { readonly found: true; readonly identity: ObjectIdentity }
  | { readonly found: false };

export type BlobByteStream = AsyncIterable<Uint8Array>;

export interface ReadBoundedOptions {
  /** Conditional read validator; mismatch before read -> precondition class. */
  readonly expectedEtag: string;
  /** Hard byte ceiling; overflow destroys the upstream body. */
  readonly byteCeiling: number;
  readonly signal: AbortSignal;
  /**
   * P4A-I11: restricted single-range read. Only ever set by the delivery
   * policy after validating a single `bytes=` range against the HEAD size;
   * the provider is asked for exactly this inclusive byte window (S3 Range)
   * and the ceiling applies to its length.
   */
  readonly range?: { readonly start: number; readonly end: number };
}

export type ReadBoundedOutcome =
  | { readonly found: true; readonly identity: ObjectIdentity; readonly stream: BlobByteStream }
  | { readonly found: false };

export type DeleteExactOutcome =
  | { readonly outcome: 'deleted' }
  | { readonly outcome: 'absent' }
  | { readonly outcome: 'unknown' };

export interface ProbeCapabilityOutcome {
  readonly ok: boolean;
  /** Stable non-sensitive detail code (e.g. `probe_key_absent`). */
  readonly detail: string;
  readonly status?: number;
}

export interface BlobStorePort {
  /** Create-only single-PUT grant: exact bucket/key from the handle, If-None-Match: *. */
  issueCreateOnlyGrant(handle: GenerationHandle, options: CreateOnlyGrantOptions): Promise<CreateOnlyGrant>;

  /** Exact-key conditional HEAD with metadata canonicalization + quoted ETag. */
  headExact(handle: GenerationHandle, options?: {
    readonly expectedEtag?: string;
    /** P4A-I11: upstream timeout/abort for the HEAD (e.g. R2 hang). */
    readonly signal?: AbortSignal;
  }): Promise<HeadExactOutcome>;

  /** Bounded streamed GET with AbortSignal; destroys the upstream body on abort/overflow. */
  readBounded(handle: GenerationHandle, options: ReadBoundedOptions): Promise<ReadBoundedOutcome>;

  /** Exact-key DELETE for a cleanup-claim generation handle; NEVER claims If-Match. */
  deleteExact(handle: GenerationHandle, options?: { readonly signal?: AbortSignal }): Promise<DeleteExactOutcome>;

  /** Absence confirmation via exact-key HEAD (DELETE 2xx is never absence). */
  confirmAbsent(handle: GenerationHandle): Promise<{ readonly absent: boolean }>;

  /** Lightweight non-destructive startup capability check. */
  probeCapability(): Promise<ProbeCapabilityOutcome>;

  /** Destroys client resources; subsequent calls fail closed with store_closed. */
  close(): Promise<void>;
}


/**
 * P4A-I11 read-only subset of the port: the credential-free isolated delivery
 * process may ONLY head and read exact generations (and probe/close). It
 * holds no write path and no R2 RW secret, so `issueCreateOnlyGrant` and
 * `deleteExact` are absent here; `createR2ReadOnlyGenerationStore` satisfies
 * this interface (write operations fail closed with `store_read_only`).
 */
export interface ReadOnlyBlobStorePort {
  headExact(
    handle: GenerationHandle,
    options?: { readonly expectedEtag?: string; readonly signal?: AbortSignal },
  ): Promise<HeadExactOutcome>;
  readBounded(handle: GenerationHandle, options: ReadBoundedOptions): Promise<ReadBoundedOutcome>;
  probeCapability(): Promise<ProbeCapabilityOutcome>;
  close(): Promise<void>;
}
