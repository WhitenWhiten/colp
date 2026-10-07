/**
 * P4A-I06 Cloudflare R2 generation-store adapter.
 *
 * Implements the narrow `BlobStorePort` from `./blob-store-port.js` over the
 * Cloudflare R2 S3-compatible API using `@aws-sdk/client-s3` and
 * `@aws-sdk/s3-request-presigner`. All SDK request/response types stay in
 * this file and its facade (`index.ts`); the business side only ever sees the
 * port types.
 *
 * Safety properties:
 *  - create-only single PUT: presigned with `If-None-Match: *`, exact bucket
 *    and exact key from the generation handle, short TTL, URL only in memory;
 *  - reads use the read-only (RO) credential; only grant signing and DELETE
 *    use the read-write (RW) credential;
 *  - DELETE never sends If-Match (no delete-precondition fencing claim); a
 *    412 on DELETE is classified as contract_drift;
 *  - absence is confirmed only by exact-key HEAD, never by DELETE 2xx;
 *  - streamed GET enforces a byte ceiling and destroys the upstream body on
 *    abort/overflow;
 *  - key handles must fall inside the configured live/probe namespaces.
 */
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  BlobStoreError,
  BlobStorePortError,
  BlobStoreReadOverflowError,
  canonicalizeEtag,
  canonicalizeMetadata,
  classifyBlobStoreFailure,
  computeKeyFingerprint,
} from './blob-store-port.js';
import type {
  BlobByteStream,
  BlobStorePort,
  CreateOnlyGrant,
  CreateOnlyGrantOptions,
  DeleteExactOutcome,
  GenerationHandle,
  HeadExactOutcome,
  ObjectIdentity,
  ProbeCapabilityOutcome,
  ReadBoundedOptions,
  ReadBoundedOutcome,
  ReadOnlyBlobStorePort,
} from './blob-store-port.js';

export const R2_GRANT_TTL_DEFAULT_SECONDS = 60;
export const R2_GRANT_TTL_MAX_SECONDS = 300;
export const R2_STARTUP_PROBE_KEY_SUFFIX = 'startup-capability';

export interface R2Credential {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

export interface R2GenerationStoreOptions {
  readonly endpoint: string;
  readonly region: string;
  readonly bucket: string;
  readonly livePrefix: string;
  readonly probePrefix: string;
  readonly rwCredential: R2Credential;
  readonly roCredential: R2Credential;
  /** Deployment create-only grant TTL ceiling in seconds (1..300). */
  readonly grantTtlSeconds: number;
  /** Single-PUT hard size ceiling in bytes (compile ceiling from config). */
  readonly singlePutMaxBytes: number;
  /** Injectable monotonic clock for deterministic tests. */
  readonly clock?: () => Date;
}

/**
 * P4A-I11 read-only construction options: identical to the full options but
 * WITHOUT any read-write credential. The credential-free isolated delivery
 * process uses `createR2ReadOnlyGenerationStore`; write operations on the
 * resulting store fail closed with `store_read_only`.
 */
export type R2ReadOnlyGenerationStoreOptions = Omit<R2GenerationStoreOptions, 'rwCredential'>;

interface R2CommonStoreOptions {
  readonly endpoint: string;
  readonly region: string;
  readonly bucket: string;
  readonly livePrefix: string;
  readonly probePrefix: string;
  readonly grantTtlSeconds: number;
  readonly singlePutMaxBytes: number;
}

function assertValidCommonOptions(options: R2CommonStoreOptions): void {
  if (!/^https?:\/\//iu.test(options.endpoint)) throw new RangeError('object_storage_endpoint_invalid');
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/iu.test(options.bucket)) throw new RangeError('object_storage_bucket_invalid');
  if (typeof options.livePrefix !== 'string' || options.livePrefix.length === 0) {
    throw new RangeError('object_storage_live_prefix_invalid');
  }
  if (typeof options.probePrefix !== 'string' || options.probePrefix.length === 0) {
    throw new RangeError('object_storage_probe_prefix_invalid');
  }
  if (!Number.isSafeInteger(options.grantTtlSeconds)
    || options.grantTtlSeconds < 1 || options.grantTtlSeconds > R2_GRANT_TTL_MAX_SECONDS) {
    throw new RangeError('object_storage_grant_ttl_out_of_range');
  }
  if (!Number.isSafeInteger(options.singlePutMaxBytes) || options.singlePutMaxBytes < 1) {
    throw new RangeError('object_storage_single_put_ceiling_invalid');
  }
}

function assertCredentialValid(credential: R2Credential | undefined, label: string): void {
  if (!credential || typeof credential.accessKeyId !== 'string' || credential.accessKeyId.length === 0
    || typeof credential.secretAccessKey !== 'string' || credential.secretAccessKey.length === 0) {
    throw new RangeError(`object_storage_${label}_credential_invalid`);
  }
}

function assertValidOptions(options: R2GenerationStoreOptions): void {
  assertValidCommonOptions(options);
  assertCredentialValid(options.rwCredential, 'rw');
  assertCredentialValid(options.roCredential, 'ro');
  if (options.rwCredential.accessKeyId === options.roCredential.accessKeyId
    || options.rwCredential.secretAccessKey === options.roCredential.secretAccessKey) {
    throw new RangeError('object_storage_read_credential_must_be_distinct');
  }
}

function assertValidReadOnlyOptions(options: R2ReadOnlyGenerationStoreOptions): void {
  assertValidCommonOptions(options);
  assertCredentialValid(options.roCredential, 'ro');
}

function normalizeMetadataInput(metadata: Readonly<Record<string, string>> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(metadata ?? {})) {
    const normalized = key.trim().toLowerCase();
    if (normalized) out[normalized] = String(value);
  }
  return out;
}

function destroyBody(body: BlobByteStream & { destroy?: () => void }): void {
  try {
    if (typeof body.destroy === 'function') {
      body.destroy();
      return;
    }
    const cancellable = body as BlobByteStream & { cancel?: () => Promise<void> };
    if (typeof cancellable.cancel === 'function') {
      cancellable.cancel().catch(() => {});
    }
  } catch {
    // Body destruction is best-effort; the iterator will surface the failure.
  }
}

/**
 * Normalizes a mid-stream body failure to a stable BlobStoreError. Abort
 * exception names across Node versions normalize to the `aborted` class
 * (I06 anti-false-negative); transport interruptions map to retryable.
 */
export function normalizeBodyReadFailure(error: unknown): BlobStoreError {
  if (error instanceof BlobStoreError) return error;
  if (error instanceof BlobStoreReadOverflowError) {
    return new BlobStoreError({ class: 'unknown', code: error.code });
  }
  return new BlobStoreError(classifyBlobStoreFailure(error));
}

/**
 * Internal stream-level byte-ceiling enforcement, exported for direct
 * fault-transport testing. A compliant HTTP/1.1 provider can never deliver
 * more bytes than its declared Content-Length (the pre-read `identity.size`
 * check already rejects those), so this in-stream guard is defense-in-depth
 * against a provider that over-delivers; it destroys the upstream body on
 * overflow and on abort. No SDK type appears in its signature.
 */
export async function* boundedBodyStream(
  body: BlobByteStream & { destroy?: () => void },
  byteCeiling: number,
  signal: AbortSignal,
  expectedSize: number,
): AsyncGenerator<Uint8Array> {
  let bytes = 0;
  const onAbort = (): void => {
    destroyBody(body);
  };
  if (signal.aborted) {
    destroyBody(body);
    throw new BlobStoreError({ class: 'aborted', code: 'read_aborted' });
  }
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    for await (const chunk of body) {
      if (signal.aborted) throw new BlobStoreError({ class: 'aborted', code: 'read_aborted' });
      const view = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
      if (bytes + view.byteLength > byteCeiling) {
        destroyBody(body);
        throw new BlobStoreReadOverflowError(byteCeiling);
      }
      bytes += view.byteLength;
      yield view;
    }
    if (signal.aborted) throw new BlobStoreError({ class: 'aborted', code: 'read_aborted' });
    // A clean EOF short of the provider-declared size is a transport
    // interruption, never a successful partial read.
    if (bytes !== expectedSize) {
      throw new BlobStoreError({ class: 'retryable', code: 'stream_truncated' });
    }
  } catch (error) {
    if (signal.aborted) throw new BlobStoreError({ class: 'aborted', code: 'read_aborted' });
    if (error instanceof BlobStoreReadOverflowError) throw error;
    throw normalizeBodyReadFailure(error);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

/**
 * Successful HEAD/GET response shape consumed for identity normalization.
 * Mirrors the locked SDK contract (`@aws-sdk/client-s3` 3.1095.0): both
 * `HeadObjectOutput.Metadata` and `GetObjectOutput.Metadata` are declared
 * optional, so a provider may omit empty metadata entirely.
 */
export interface ObjectResponseShape {
  ContentLength?: number;
  ETag?: string;
  Metadata?: Record<string, string>;
  LastModified?: Date;
  $metadata: { httpStatusCode?: number };
}

/**
 * Shared HEAD/GET 2xx identity normalization. Missing or empty metadata is
 * normalized to `{}` (the pinned SDK deserializer materializes `{}` for a
 * metadata-free response, so HEAD and GET agree on the absent case); a
 * PRESENT metadata map is still strictly required to be an object, so only
 * the missing/empty semantics are forgiven — never a malformed field.
 */
export function identityFromObjectResponse(
  handle: GenerationHandle,
  response: ObjectResponseShape,
  malformedCode: string,
): ObjectIdentity {
  const status = response.$metadata.httpStatusCode;
  if (response.ContentLength == null || !Number.isSafeInteger(response.ContentLength) || response.ContentLength < 0
    || typeof response.ETag !== 'string' || response.ETag.length === 0
    || (response.Metadata !== undefined && typeof response.Metadata !== 'object')) {
    throw new BlobStoreError({ class: 'contract_drift', code: malformedCode, status });
  }
  return {
    generationId: handle.generationId,
    size: response.ContentLength,
    etag: canonicalizeEtag(response.ETag),
    metadata: canonicalizeMetadata(response.Metadata ?? {}),
    lastModifiedIso: response.LastModified ? new Date(response.LastModified).toISOString() : undefined,
  };
}

export class R2GenerationStore implements BlobStorePort {
  private readonly rw: S3Client | undefined;
  private readonly ro: S3Client;
  private readonly clock: () => Date;
  private closed = false;

  constructor(
    private readonly options: R2GenerationStoreOptions | R2ReadOnlyGenerationStoreOptions,
    mode: { readonly readOnly: boolean } = { readOnly: false },
  ) {
    const common = {
      region: options.region,
      requestHandler: { connectionTimeout: 5_000, socketTimeout: 30_000, requestTimeout: 60_000, throwOnRequestTimeout: true },
      forcePathStyle: true,
      maxAttempts: 1,
      requestChecksumCalculation: 'WHEN_REQUIRED' as const,
    };
    this.ro = new S3Client({ ...common, endpoint: options.endpoint, credentials: options.roCredential });
    // The credential-free delivery process never holds the R2 RW secret.
    this.rw = mode.readOnly
      ? undefined
      : new S3Client({ ...common, endpoint: options.endpoint, credentials: (options as R2GenerationStoreOptions).rwCredential });
    this.clock = options.clock ?? (() => new Date());
  }

  /** P4A-I11: read-only stores have no write path; fail closed. */
  private assertWriteEnabled(): S3Client {
    if (!this.rw) throw new BlobStorePortError('store_read_only');
    return this.rw;
  }

  private assertOpen(): void {
    if (this.closed) throw new BlobStorePortError('store_closed');
  }

  private assertHandle(handle: GenerationHandle): void {
    if (!handle || typeof handle.generationId !== 'string' || handle.generationId.length === 0
      || typeof handle.key !== 'string' || handle.key.length === 0) {
      throw new BlobStorePortError('invalid_generation_handle');
    }
    if (!handle.key.startsWith(this.options.livePrefix) && !handle.key.startsWith(this.options.probePrefix)) {
      throw new BlobStorePortError('key_outside_configured_namespace');
    }
  }

  async issueCreateOnlyGrant(handle: GenerationHandle, options: CreateOnlyGrantOptions): Promise<CreateOnlyGrant> {
    this.assertOpen();
    this.assertWriteEnabled();
    this.assertHandle(handle);
    const ttlSeconds = this.validateTtl(options.ttlSeconds);
    const contentType = options.contentType ?? 'application/octet-stream';
    if (typeof contentType !== 'string' || contentType.length === 0 || contentType.length > 255) {
      throw new BlobStorePortError('grant_content_type_invalid');
    }
    if (!Number.isSafeInteger(options.contentLength) || options.contentLength < 0) {
      throw new BlobStorePortError('grant_content_length_invalid');
    }
    if (options.contentLength > this.options.singlePutMaxBytes) {
      throw new BlobStorePortError('grant_content_length_exceeds_ceiling');
    }
    const metadata = normalizeMetadataInput(options.metadata);
    const signedAt = this.clock();
    const url = await getSignedUrl(
      this.assertWriteEnabled(),
      new PutObjectCommand({
        Bucket: this.options.bucket,
        Key: handle.key,
        ContentLength: options.contentLength,
        ContentType: contentType,
        Metadata: metadata,
        IfNoneMatch: '*',
      }),
      {
        expiresIn: ttlSeconds,
        // The injectable clock also drives the SigV4 signing date, so the
        // documented deterministic-test seam produces a fresh signature on
        // every call (a re-signed grant is a NEW URL, never a cached one).
        signingDate: signedAt,
        unhoistableHeaders: new Set(Object.keys(metadata).map((key) => `x-amz-meta-${key.toLowerCase()}`)),
      },
    );
    return {
      url,
      method: 'PUT',
      signedAtIso: signedAt.toISOString(),
      expiresAtIso: new Date(signedAt.getTime() + ttlSeconds * 1000).toISOString(),
      ttlSeconds,
      generationId: handle.generationId,
      keyFingerprint: computeKeyFingerprint(handle.key),
      ifNoneMatch: '*',
      metadataHeaders: Object.freeze(Object.fromEntries(
        Object.entries(metadata).map(([key, value]) => [`x-amz-meta-${key.toLowerCase()}`, value]),
      )),
      contentLength: options.contentLength,
      contentType,
    };
  }

  private validateTtl(ttlSeconds: number): number {
    if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > this.options.grantTtlSeconds) {
      throw new BlobStorePortError('grant_ttl_out_of_range');
    }
    return ttlSeconds;
  }

  async headExact(handle: GenerationHandle, options: { readonly expectedEtag?: string; readonly signal?: AbortSignal } = {}): Promise<HeadExactOutcome> {
    this.assertOpen();
    this.assertHandle(handle);
    try {
      const input: { Bucket: string; Key: string; IfMatch?: string } = {
        Bucket: this.options.bucket,
        Key: handle.key,
      };
      if (options.expectedEtag !== undefined) input.IfMatch = canonicalizeEtag(options.expectedEtag);
      const response = await this.ro.send(new HeadObjectCommand(input), { abortSignal: options.signal });
      const status = response.$metadata.httpStatusCode;
      if (status === 200) {
        return { found: true, identity: this.identityFromHead(handle, response) };
      }
      throw new BlobStoreError({
        class: 'contract_drift',
        code: `head_unexpected_status:${String(status)}`,
        status,
      });
    } catch (error) {
      if (error instanceof BlobStoreError || error instanceof BlobStorePortError
        || error instanceof BlobStoreReadOverflowError) throw error;
      const failure = classifyBlobStoreFailure(error);
      if (failure.class === 'precondition') throw new BlobStoreError({ ...failure, code: 'etag_mismatch' });
      if (failure.class === 'not_found') return { found: false };
      throw new BlobStoreError(failure);
    }
  }

  private identityFromHead(handle: GenerationHandle, response: ObjectResponseShape): ObjectIdentity {
    return identityFromObjectResponse(handle, response, 'head_response_malformed');
  }

  async readBounded(handle: GenerationHandle, options: ReadBoundedOptions): Promise<ReadBoundedOutcome> {
    this.assertOpen();
    this.assertHandle(handle);
    if (!Number.isSafeInteger(options.byteCeiling) || options.byteCeiling < 0) {
      throw new BlobStorePortError('read_byte_ceiling_invalid');
    }
    if (typeof options.expectedEtag !== 'string' || options.expectedEtag.length === 0) {
      throw new BlobStorePortError('expected_etag_required');
    }
    if (options.range !== undefined) {
      const { start, end } = options.range;
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) {
        throw new BlobStorePortError('read_range_invalid');
      }
    }
    try {
      const getInput: { Bucket: string; Key: string; IfMatch: string; Range?: string } = {
        Bucket: this.options.bucket,
        Key: handle.key,
        IfMatch: canonicalizeEtag(options.expectedEtag),
      };
      if (options.range !== undefined) getInput.Range = `bytes=${options.range.start}-${options.range.end}`;
      const response = await this.ro.send(new GetObjectCommand(getInput), { abortSignal: options.signal });
      const status = response.$metadata.httpStatusCode;
      if (status === 200 || status === 206) {
        if (!response.Body) throw new BlobStoreError({ class: 'contract_drift', code: 'get_response_body_missing', status });
        const identity = this.identityFromGet(handle, response);
        const body = response.Body as unknown as BlobByteStream & { destroy?: () => void };
        if (identity.size > options.byteCeiling) {
          destroyBody(body);
          throw new BlobStoreReadOverflowError(options.byteCeiling);
        }
        return {
          found: true,
          identity,
          stream: boundedBodyStream(body, options.byteCeiling, options.signal, identity.size),
        };
      }
      throw new BlobStoreError({
        class: 'contract_drift',
        code: `get_unexpected_status:${String(status)}`,
        status,
      });
    } catch (error) {
      if (error instanceof BlobStoreError || error instanceof BlobStorePortError
        || error instanceof BlobStoreReadOverflowError) throw error;
      const failure = classifyBlobStoreFailure(error);
      if (failure.class === 'precondition') throw new BlobStoreError({ ...failure, code: 'etag_mismatch' });
      if (failure.class === 'not_found') return { found: false };
      throw new BlobStoreError(failure);
    }
  }

  private identityFromGet(handle: GenerationHandle, response: ObjectResponseShape): ObjectIdentity {
    return identityFromObjectResponse(handle, response, 'get_response_malformed');
  }

  async deleteExact(handle: GenerationHandle, options: { readonly signal?: AbortSignal } = {}): Promise<DeleteExactOutcome> {
    this.assertOpen();
    this.assertWriteEnabled();
    this.assertHandle(handle);
    try {
      const response = await this.assertWriteEnabled().send(new DeleteObjectCommand({
        Bucket: this.options.bucket,
        Key: handle.key,
      }), { abortSignal: options.signal });
      const status = response.$metadata.httpStatusCode;
      if (status !== undefined && status >= 200 && status < 300) return { outcome: 'deleted' };
      // A 2xx without a status would be a malformed success; still deleted.
      return { outcome: 'deleted' };
    } catch (error) {
      if (error instanceof BlobStoreError || error instanceof BlobStorePortError
        || error instanceof BlobStoreReadOverflowError) throw error;
      const failure = classifyBlobStoreFailure(error);
      if (failure.class === 'precondition') {
        // The adapter never sends If-Match on DELETE; a 412 is contract drift.
        throw new BlobStoreError({ class: 'contract_drift', code: 'delete_precondition_not_expected', status: failure.status });
      }
      if (failure.class === 'not_found') return { outcome: 'absent' };
      if (failure.class === 'unknown') return { outcome: 'unknown' };
      throw new BlobStoreError(failure);
    }
  }

  async confirmAbsent(handle: GenerationHandle): Promise<{ readonly absent: boolean }> {
    const head = await this.headExact(handle);
    return { absent: !head.found };
  }

  async probeCapability(): Promise<ProbeCapabilityOutcome> {
    this.assertOpen();
    const key = `${this.options.probePrefix}${R2_STARTUP_PROBE_KEY_SUFFIX}`;
    try {
      const response = await this.ro.send(new HeadObjectCommand({ Bucket: this.options.bucket, Key: key }));
      const status = response.$metadata.httpStatusCode;
      if (status === 200) return { ok: true, detail: 'probe_key_present', status };
      return { ok: true, detail: 'probe_key_absent', status };
    } catch (error) {
      if (error instanceof BlobStoreError || error instanceof BlobStorePortError
        || error instanceof BlobStoreReadOverflowError) throw error;
      const failure = classifyBlobStoreFailure(error);
      if (failure.class === 'not_found') return { ok: true, detail: 'probe_key_absent', status: 404 };
      throw new BlobStoreError(failure);
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      this.rw?.destroy();
    } finally {
      this.ro.destroy();
    }
  }
}

export function createR2GenerationStore(options: R2GenerationStoreOptions): BlobStorePort {
  assertValidOptions(options);
  return new R2GenerationStore(options);
}

/**
 * P4A-I11 credential-free read-only factory for the isolated delivery origin.
 * The returned store can ONLY head/read exact generations (plus probe/close);
 * write operations fail closed with `store_read_only`, so the delivery
 * process structurally cannot issue grants or delete objects.
 */
export function createR2ReadOnlyGenerationStore(options: R2ReadOnlyGenerationStoreOptions): ReadOnlyBlobStorePort {
  assertValidReadOnlyOptions(options);
  return new R2GenerationStore(options, { readOnly: true });
}
