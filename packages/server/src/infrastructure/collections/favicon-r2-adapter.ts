/**
 * R2-backed public bookmark favicon object store.
 *
 * Favicons are intentionally public and served through the same-origin
 * `/api/v1/favicon/:id` route (collections module, not identity). The store
 * supports PUT, public GET and best-effort DELETE; no list is exposed.
 *
 * GET never calls `transformToByteArray()`: a declared ContentLength above
 * the object ceiling (BOOKMARK_FAVICON_MAX_BYTES unless overridden) is
 * treated as missing without consuming the body, and the stream is otherwise
 * capped so a huge object cannot pin unbounded memory. GET uses the RO client
 * only.
 */
import { once } from 'node:events';
import { Readable } from 'node:stream';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { observeBestEffort, settleBestEffort } from '../async/best-effort.js';
import {
  BOOKMARK_FAVICON_MAX_BYTES,
  LINK_PREVIEW_MAX_IMAGE_BYTES,
  readFaviconBodyCapped,
  type BookmarkFaviconObjectStore,
  type StoredBookmarkFavicon,
} from '../../modules/collections/index.js';


export interface R2FaviconStoreOptions {
  readonly endpoint: string;
  readonly region: string;
  readonly bucket: string;
  readonly prefix: string;
  readonly rwCredential: { readonly accessKeyId: string; readonly secretAccessKey: string };
  readonly roCredential: { readonly accessKeyId: string; readonly secretAccessKey: string };
  /** Largest object GET will read; defaults to BOOKMARK_FAVICON_MAX_BYTES. */
  readonly maxObjectBytes?: number;
}

async function destroyGetObjectBody(body: unknown): Promise<void> {
  if (body == null || typeof body !== 'object') return;
  const candidate = body as {
    destroyed?: boolean;
    destroy?: (error?: Error) => void;
    cancel?: () => Promise<unknown>;
  };
  try {
    if (typeof candidate.destroy === 'function') {
      if (candidate.destroyed === true) return;
      const closed = body instanceof Readable ? once(body, 'close').then(() => undefined) : Promise.resolve();
      candidate.destroy();
      await closed;
      return;
    }
    if (typeof candidate.cancel === 'function') {
      await settleBestEffort(
        candidate.cancel(),
        'favicon body cancel cannot change the missing-object result',
      );
    }
  } catch {
    // Socket teardown is best-effort; missing favicons must still 404.
  }
}

async function readCappedWithSignal(
  stream: Readable,
  maxBytes: number,
  signal: AbortSignal | undefined,
): Promise<Buffer | null> {
  if (signal === undefined) return readFaviconBodyCapped(stream, maxBytes);
  if (signal.aborted) {
    await destroyGetObjectBody(stream);
    throw signal.reason ?? new DOMException('Aborted', 'AbortError');
  }
  const reading = readFaviconBodyCapped(stream, maxBytes);
  observeBestEffort(reading, 'an aborted favicon read must not surface after the caller abort wins');
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      signal.removeEventListener('abort', onAbort);
      void destroyGetObjectBody(stream).finally(() => {
        reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      });
    };
    signal.addEventListener('abort', onAbort, { once: true });
    reading.then((body) => {
      signal.removeEventListener('abort', onAbort);
      resolve(body);
    }, (error: unknown) => {
      signal.removeEventListener('abort', onAbort);
      reject(signal.aborted ? (signal.reason ?? new DOMException('Aborted', 'AbortError')) : error);
    });
  });
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

export function createR2FaviconStore(options: R2FaviconStoreOptions): BookmarkFaviconObjectStore {
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
  const key = (objectId: string) => `${options.prefix}${objectId}`;
  const maxObjectBytes = options.maxObjectBytes ?? BOOKMARK_FAVICON_MAX_BYTES;
  let closed = false;

  return {
    async put(objectId, body, contentType) {
      await rw.send(new PutObjectCommand({
        Bucket: options.bucket,
        Key: key(objectId),
        Body: body,
        ContentType: contentType,
      }));
    },
    async get(objectId, getOptions) {
      const signal = getOptions?.signal;
      if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
      try {
        const response = await ro.send(new GetObjectCommand({
          Bucket: options.bucket,
          Key: key(objectId),
        }), { abortSignal: signal });
        const declared = response.ContentLength;
        // Trusted declared length from the S3/R2 SDK. Finite and over the
        // object ceiling (or empty) → missing; do not consume the body.
        if (typeof declared === 'number' && Number.isFinite(declared)
          && (declared > maxObjectBytes || declared <= 0)) {
          await destroyGetObjectBody(response.Body);
          return null;
        }
        const stream = asNodeReadable(response.Body);
        if (!stream) {
          await destroyGetObjectBody(response.Body);
          return null;
        }
        const body = await readCappedWithSignal(stream, maxObjectBytes, signal);
        if (!body) return null;
        return {
          contentType: response.ContentType ?? 'application/octet-stream',
          body,
        } satisfies StoredBookmarkFavicon;
      } catch (error) {
        if (signal?.aborted) throw signal.reason ?? error;
        const candidate = error as { name?: unknown; $metadata?: { httpStatusCode?: number } };
        const status = candidate.$metadata?.httpStatusCode;
        if (status === 404
          || candidate.name === 'NoSuchKey'
          || candidate.name === 'NotFound') {
          return null;
        }
        throw error;
      }
    },
    async delete(objectId) {
      await rw.send(new DeleteObjectCommand({
        Bucket: options.bucket,
        Key: key(objectId),
      }));
    },
    async close() {
      if (closed) return;
      closed = true;
      try {
        rw.destroy();
      } finally {
        ro.destroy();
      }
    },
  };
}

/**
 * LP-01 link preview object store: the same public-object adapter under its
 * own prefix, with the larger preview byte ceiling. Served only through the
 * same-origin `/api/v1/link-preview/:id` route.
 */
export function createR2LinkPreviewStore(
  options: Omit<R2FaviconStoreOptions, 'maxObjectBytes'>,
): BookmarkFaviconObjectStore {
  return createR2FaviconStore({ ...options, maxObjectBytes: LINK_PREVIEW_MAX_IMAGE_BYTES });
}
