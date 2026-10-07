/**
 * R2-backed public avatar object store.
 *
 * Unlike the private attachment store, avatars are intentionally public and
 * served through the same-origin `/api/v1/avatar/:id` route. The store
 * supports PUT, public GET and best-effort DELETE (used by uploadAvatar to
 * remove the replaced object); no list is exposed.
 *
 * GET never calls `transformToByteArray()`: a declared ContentLength above
 * AVATAR_MAX_BYTES is treated as missing without consuming the body, and the
 * stream is otherwise capped so a huge object cannot pin unbounded memory.
 */
import { Readable } from 'node:stream';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import {
  AVATAR_MAX_BYTES,
  AVATAR_READ_TIMEOUT_MS,
  readAvatarBodyCapped,
  type AvatarObjectStore,
  type StoredAvatar,
} from '../../modules/identity/index.js';
import { observeBestEffort } from '../async/best-effort.js';

export interface R2AvatarStoreOptions {
  readonly endpoint: string;
  readonly region: string;
  readonly bucket: string;
  readonly prefix: string;
  readonly rwCredential: { readonly accessKeyId: string; readonly secretAccessKey: string };
  readonly roCredential: { readonly accessKeyId: string; readonly secretAccessKey: string };
}

function destroyGetObjectBody(body: unknown): void {
  if (body == null || typeof body !== 'object') return;
  const candidate = body as {
    destroyed?: boolean;
    destroy?: (error?: Error) => void;
    cancel?: () => Promise<unknown>;
  };
  try {
    if (typeof candidate.destroy === 'function') {
      if (candidate.destroyed !== true) candidate.destroy();
      return;
    }
    if (typeof candidate.cancel === 'function') {
      observeBestEffort(candidate.cancel(),
        'the missing-avatar result is authoritative and socket teardown is secondary');
    }
  } catch {
    // Socket teardown is best-effort; missing avatars must still 404.
  }
}

function asNodeReadable(body: unknown): Readable | null {
  if (body instanceof Readable) return body;
  if (body != null && typeof body === 'object' && typeof (body as { pipe?: unknown }).pipe === 'function') {
    return body as Readable;
  }
  if (body != null && typeof (body as AsyncIterable<unknown>)[Symbol.asyncIterator] === 'function') {
    return Readable.from(body as AsyncIterable<Uint8Array>);
  }
  return null;
}

export function createR2AvatarStore(options: R2AvatarStoreOptions): AvatarObjectStore {
  const rw = new S3Client({
    region: options.region,
    endpoint: options.endpoint,
    forcePathStyle: true,
    credentials: options.rwCredential,
  });
  const ro = new S3Client({
    region: options.region,
    endpoint: options.endpoint,
    forcePathStyle: true,
    credentials: options.roCredential,
  });
  const key = (avatarId: string) => `${options.prefix}${avatarId}`;
  let closed = false;
  const shutdown = new AbortController();

  return {
    async put(avatarId, body, contentType, _accountId, signal) {
      await rw.send(new PutObjectCommand({
        Bucket: options.bucket,
        Key: key(avatarId),
        Body: body,
        ContentType: contentType,
      }), { abortSignal: signal });
    },
    async get(avatarId, readOptions = {}) {
      // Like attachment delivery, one signal covers headers and body; the
      // Node stream owns its abort listener until destruction/EOF.
      const signal = AbortSignal.any([shutdown.signal,
        AbortSignal.timeout(readOptions.timeoutMs ?? AVATAR_READ_TIMEOUT_MS),
        ...(readOptions.signal ? [readOptions.signal] : [])]);
      let providerBody: unknown;
      try {
        signal.throwIfAborted();
        const response = await ro.send(new GetObjectCommand({
          Bucket: options.bucket,
          Key: key(avatarId),
        }), { abortSignal: signal });
        providerBody = response.Body;
        signal.throwIfAborted();
        const declared = response.ContentLength;
        // Trusted declared length from the S3/R2 SDK. Finite and over the
        // avatar ceiling (or empty) → missing; do not consume the body.
        if (typeof declared === 'number' && Number.isFinite(declared)
          && (declared > AVATAR_MAX_BYTES || declared <= 0)) {
          destroyGetObjectBody(response.Body);
          return null;
        }
        const stream = asNodeReadable(response.Body);
        if (!stream) {
          destroyGetObjectBody(response.Body);
          return null;
        }
        const body = await readAvatarBodyCapped(stream, AVATAR_MAX_BYTES, signal);
        if (!body) return null;
        return {
          contentType: response.ContentType ?? 'application/octet-stream',
          body,
        } satisfies StoredAvatar;
      } catch (error) {
        const candidate = error as { name?: unknown; $metadata?: { httpStatusCode?: number } };
        const status = candidate.$metadata?.httpStatusCode;
        if (status === 404
          || candidate.name === 'NoSuchKey'
          || candidate.name === 'NotFound') {
          return null;
        }
        throw error;
      } finally { destroyGetObjectBody(providerBody); }
    },
    async delete(avatarId, signal) {
      // R2 DeleteObject is idempotent: deleting a key that does not exist is
      // also a success, so no missing-key special-casing is needed. Errors
      // propagate to the caller, which treats cleanup as best-effort.
      await rw.send(new DeleteObjectCommand({
        Bucket: options.bucket,
        Key: key(avatarId),
      }), { abortSignal: signal });
    },
    async close() {
      if (closed) return;
      closed = true;
      shutdown.abort(new DOMException('Avatar store closed', 'AbortError'));
      try {
        rw.destroy();
      } finally {
        ro.destroy();
      }
    },
  };
}
