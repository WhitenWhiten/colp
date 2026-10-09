import { Readable } from 'node:stream';
import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';

import {
  assertLedgerArchiveObjectKey,
  contentEtag,
  digestFromLedgerArchiveObjectKey,
  LedgerArchiveObjectStoreError,
  normalizeSha256,
  type LedgerArchiveObjectIdentity,
  type LedgerArchiveObjectReader,
  type LedgerArchiveObjectStore,
} from './object-store.js';

export interface LedgerArchiveS3Credential {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

export interface LedgerArchiveS3ReaderOptions {
  readonly endpoint: string;
  readonly region: string;
  readonly bucket: string;
  readonly readerCredential: LedgerArchiveS3Credential;
  readonly timeoutMs?: number;
  readonly client?: S3CommandClient;
}

export interface LedgerArchiveS3StoreOptions extends LedgerArchiveS3ReaderOptions {
  readonly writerCredential: LedgerArchiveS3Credential;
  readonly writerClient?: S3CommandClient;
  /** Legacy AES256 is rejected at runtime; archives require customer-managed KMS. */
  readonly serverSideEncryption?: 'AES256' | 'aws:kms';
  readonly kmsKeyId?: string;
}

export interface S3CommandClient {
  send(command: unknown, options?: { abortSignal?: AbortSignal }): Promise<unknown>;
}

interface S3Response {
  readonly Body?: unknown;
  readonly ContentLength?: number;
  readonly ETag?: string;
  readonly Metadata?: Record<string, string>;
  readonly ServerSideEncryption?: string;
  readonly SSEKMSKeyId?: string;
}

export function createS3LedgerArchiveReader(options: LedgerArchiveS3ReaderOptions): LedgerArchiveObjectReader {
  validateCommon(options);
  validateCredential(options.readerCredential, 'reader');
  const client = options.client ?? createClient(options, options.readerCredential);
  return createReader(options, client);
}

export function createS3LedgerArchiveObjectStore(options: LedgerArchiveS3StoreOptions): LedgerArchiveObjectStore {
  validateCommon(options);
  validateCredential(options.readerCredential, 'reader');
  validateCredential(options.writerCredential, 'writer');
  validateKmsKeyId(options.kmsKeyId);
  if (options.serverSideEncryption !== undefined && options.serverSideEncryption !== 'aws:kms') {
    throw new RangeError('archive_sse_must_use_kms');
  }
  if (options.readerCredential.accessKeyId === options.writerCredential.accessKeyId
      || options.readerCredential.secretAccessKey === options.writerCredential.secretAccessKey) {
    throw new RangeError('archive_s3_reader_credential_must_be_distinct');
  }
  const reader = createReader(options, options.client ?? createClient(options, options.readerCredential));
  const writer = options.writerClient ?? createClient(options, options.writerCredential);

  const store: LedgerArchiveObjectStore = {
    ...reader,
    async putCreateOnly(input) {
      assertLedgerArchiveObjectKey(input.key);
      const digest = normalizeSha256(input.sha256);
      if (digest !== digestFromLedgerArchiveObjectKey(input.key)) {
        throw new LedgerArchiveObjectStoreError('precondition_failed', 'archive_key_digest_mismatch', 'Archive key does not match the declared digest.');
      }
      const encryption = options.serverSideEncryption ?? 'aws:kms';
      if (input.kmsKeyId !== options.kmsKeyId) {
        throw new LedgerArchiveObjectStoreError('precondition_failed', 'archive_kms_key_mismatch', 'Archive object KMS key does not match the configured archive key.');
      }
      const signal = timeoutSignal(options.timeoutMs, input.signal);
      try {
        ensureNotAborted(signal);
        const response = await writer.send(new PutObjectCommand({
          Bucket: options.bucket,
          Key: input.key,
          Body: Readable.from(input.body),
          ContentLength: safeNumber(input.byteLength),
          ContentType: 'application/x-known-ledger-archive+jsonl;version=1',
          IfNoneMatch: '*',
          Metadata: {
            'ledger-archive-sha256': digest.slice('sha256:'.length),
            'ledger-archive-kms-key-id': input.kmsKeyId,
            'ledger-archive-schema': '1',
          },
          ServerSideEncryption: encryption,
          SSEKMSKeyId: options.kmsKeyId,
        }), { abortSignal: signal }) as S3Response;
        ensureNotAborted(signal);
        return Object.freeze({
          key: input.key,
          uri: objectUri(options.bucket, input.key),
          byteLength: input.byteLength,
          sha256: digest,
          contentEtag: contentEtag(digest),
          ...(response.ETag === undefined ? {} : { providerEtag: stripQuotes(response.ETag) }),
          kmsKeyId: input.kmsKeyId,
        });
      } catch (error) {
        throw classifyS3Error(error, signal);
      }
    },
  };
  return Object.freeze(store);
}

function createReader(
  options: LedgerArchiveS3ReaderOptions,
  client: S3CommandClient,
): LedgerArchiveObjectReader {
  async function head(key: string, outerSignal?: AbortSignal): Promise<LedgerArchiveObjectIdentity> {
    assertLedgerArchiveObjectKey(key);
    const signal = timeoutSignal(options.timeoutMs, outerSignal);
    try {
      ensureNotAborted(signal);
      const response = await client.send(new HeadObjectCommand({
        Bucket: options.bucket, Key: key,
      }), { abortSignal: signal }) as S3Response;
      ensureNotAborted(signal);
      return identityFromResponse(options.bucket, key, response);
    } catch (error) {
      throw classifyS3Error(error, signal);
    }
  }

  const reader: LedgerArchiveObjectReader = {
    uriForKey(key) {
      assertLedgerArchiveObjectKey(key);
      return objectUri(options.bucket, key);
    },
    head,
    async read(input) {
      assertLedgerArchiveObjectKey(input.key);
      const signal = timeoutSignal(options.timeoutMs, input.signal);
      let rawBody: unknown;
      let handedOff = false;
      let closed = false;
      const close = (): void => {
        if (closed) return;
        closed = true;
        signal.removeEventListener('abort', close);
        destroyBody(rawBody);
      };
      try {
        ensureNotAborted(signal);
        const response = await client.send(new GetObjectCommand({
          Bucket: options.bucket, Key: input.key,
        }), { abortSignal: signal }) as S3Response;
        rawBody = response.Body;
        signal.addEventListener('abort', close, { once: true });
        ensureNotAborted(signal);
        const identity = identityFromResponse(options.bucket, input.key, response);
        if (identity.byteLength > input.byteCeiling) {
          throw new LedgerArchiveObjectStoreError('overflow', 'archive_read_ceiling_exceeded', 'Archive object exceeds the read ceiling.');
        }
        const iterable = asAsyncIterable(rawBody);
        if (!iterable) {
          throw new LedgerArchiveObjectStoreError('corrupt', 'archive_body_missing', 'Archive object body is unavailable.');
        }
        handedOff = true;
        return Object.freeze({
          identity, close,
          body: boundedS3Body(iterable, identity.byteLength, input.byteCeiling, signal, close),
        });
      } catch (error) {
        if (error instanceof LedgerArchiveObjectStoreError) throw error;
        throw classifyS3Error(error, signal);
      } finally {
        if (!handedOff) close();
      }
    },
  };
  return Object.freeze(reader);
}

async function* boundedS3Body(
  body: AsyncIterable<unknown>, expected: bigint, ceiling: bigint, signal: AbortSignal, close: () => void,
): AsyncGenerator<Uint8Array> {
  let bytes = 0n;
  if (signal.aborted) {
    close();
    throw classifyS3Error(signal.reason, signal);
  }
  try {
    for await (const value of body) {
      if (signal.aborted) throw classifyS3Error(signal.reason, signal);
      const chunk = value instanceof Uint8Array ? value : Buffer.from(value as string);
      bytes += BigInt(chunk.byteLength);
      if (bytes > ceiling) {
        close();
        throw new LedgerArchiveObjectStoreError('overflow', 'archive_read_ceiling_exceeded', 'Archive read exceeded its byte ceiling.');
      }
      yield chunk;
    }
    if (bytes !== expected) {
      throw new LedgerArchiveObjectStoreError('corrupt', 'archive_object_truncated', 'Archive object was truncated.');
    }
  } catch (error) {
    if (error instanceof LedgerArchiveObjectStoreError) throw error;
    throw classifyS3Error(error, signal);
  } finally {
    close();
  }
}

function identityFromResponse(bucket: string, key: string, response: S3Response): LedgerArchiveObjectIdentity {
  const rawDigest = response.Metadata?.['ledger-archive-sha256'];
  const kmsKeyId = response.Metadata?.['ledger-archive-kms-key-id'] ?? response.SSEKMSKeyId;
  if (response.ServerSideEncryption !== 'aws:kms'
      || !Number.isSafeInteger(response.ContentLength) || response.ContentLength! < 0
      || typeof rawDigest !== 'string' || typeof kmsKeyId !== 'string'
      || typeof response.SSEKMSKeyId !== 'string' || response.SSEKMSKeyId !== kmsKeyId
      || response.Metadata?.['ledger-archive-schema'] !== '1') {
    throw new LedgerArchiveObjectStoreError('corrupt', 'archive_head_binding_missing', 'Archive object binding metadata is missing.');
  }
  const sha256 = normalizeSha256(rawDigest);
  if (sha256 !== digestFromLedgerArchiveObjectKey(key)) {
    throw new LedgerArchiveObjectStoreError('corrupt', 'archive_content_address_mismatch', 'Archive object does not match its content address.');
  }
  return Object.freeze({
    key, uri: objectUri(bucket, key), byteLength: BigInt(response.ContentLength!), sha256,
    contentEtag: contentEtag(sha256),
    ...(response.ETag === undefined ? {} : { providerEtag: stripQuotes(response.ETag) }),
    kmsKeyId,
  });
}

function validateCommon(options: LedgerArchiveS3ReaderOptions): void {
  if (!/^https:\/\//u.test(options.endpoint)) throw new RangeError('archive_s3_endpoint_invalid');
  if (!/^[a-z0-9][a-z0-9.-]{2,62}$/u.test(options.bucket)) throw new RangeError('archive_s3_bucket_invalid');
  if (options.timeoutMs !== undefined
      && (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 100 || options.timeoutMs > 300_000)) {
    throw new RangeError('archive_s3_timeout_invalid');
  }
}

function validateCredential(value: LedgerArchiveS3Credential, label: string): void {
  if (!value || value.accessKeyId.length < 1 || value.secretAccessKey.length < 1) {
    throw new RangeError(`archive_s3_${label}_credential_invalid`);
  }
}

function validateKmsKeyId(value: string | undefined): asserts value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9:/_.-]{0,255}$/u.test(value)) {
    throw new RangeError('archive_kms_key_id_invalid');
  }
}

function createClient(options: LedgerArchiveS3ReaderOptions, credential: LedgerArchiveS3Credential): S3CommandClient {
  return new S3Client({
    region: options.region, endpoint: options.endpoint, forcePathStyle: true, credentials: credential,
  }) as S3CommandClient;
}

function objectUri(bucket: string, key: string): string {
  return `s3://${bucket}/${key}`;
}

function safeNumber(value: bigint): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError('archive_byte_length_out_of_range');
  return Number(value);
}

function stripQuotes(value: string): string {
  return value.replace(/^"|"$/gu, '');
}

function timeoutSignal(timeoutMs = 30_000, signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
}

function asAsyncIterable(value: unknown): AsyncIterable<unknown> | undefined {
  if (value && typeof (value as AsyncIterable<unknown>)[Symbol.asyncIterator] === 'function') {
    return value as AsyncIterable<unknown>;
  }
  return undefined;
}

function destroyBody(value: unknown): void {
  try {
    (value as { destroy?: () => void } | undefined)?.destroy?.();
  } catch {
    // Socket teardown is best effort after a fail-closed decision.
  }
}

function classifyS3Error(error: unknown, signal: AbortSignal): LedgerArchiveObjectStoreError {
  if (error instanceof LedgerArchiveObjectStoreError) return error;
  const candidate = error as { name?: unknown; Code?: unknown; $metadata?: { httpStatusCode?: number } };
  const status = candidate?.$metadata?.httpStatusCode;
  if (status === 404 || candidate.name === 'NoSuchKey' || candidate.name === 'NotFound') {
    return new LedgerArchiveObjectStoreError('not_found', 'archive_object_not_found', 'Archive object is unavailable.', error);
  }
  if (status === 412 || candidate.name === 'PreconditionFailed') {
    return new LedgerArchiveObjectStoreError('already_exists', 'archive_object_exists', 'Archive object already exists.', error);
  }
  if (signal.aborted) {
    const timedOut = signal.reason instanceof DOMException && signal.reason.name === 'TimeoutError';
    return new LedgerArchiveObjectStoreError(
      timedOut ? 'timeout' : 'aborted', timedOut ? 'archive_operation_timeout' : 'archive_operation_aborted',
      timedOut ? 'Archive object operation timed out.' : 'Archive object operation was aborted.', error,
    );
  }
  if (typeof status === 'number' && (status === 429 || status >= 500)) {
    return new LedgerArchiveObjectStoreError('retryable', 'archive_provider_retryable', 'Archive object provider is temporarily unavailable.', error);
  }
  return new LedgerArchiveObjectStoreError('unknown', 'archive_provider_failure', 'Archive object provider operation failed.', error);
}

function ensureNotAborted(signal: AbortSignal): void {
  if (signal.aborted) throw classifyS3Error(signal.reason, signal);
}
