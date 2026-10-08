/**
 * Private R2-backed export object store.
 *
 * Copies the avatar and favicon SDK put/get/delete shape only. The bucket and
 * prefix are independent of public avatar and favicon objects. GET returns a
 * Buffer capped at EXPORT_JOB_MAX_BYTES. There is no list and no presign.
 */
import { Readable } from 'node:stream';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import {
  EXPORT_JOB_MAX_BYTES,
  exportObjectKey,
  readExportBodyCapped,
  type ExportObjectStore,
} from '../../modules/collections/index.js';
import { observeBestEffort } from '../async/best-effort.js';

export interface R2ExportStoreOptions {
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
        'the missing-export result is authoritative and socket teardown is secondary');
    }
  } catch {
    // Socket teardown is best-effort; missing exports must still 404.
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

export function createR2ExportStore(options: R2ExportStoreOptions): ExportObjectStore {
  const rw = new S3Client({
    region: options.region,
    endpoint: options.endpoint,
    forcePathStyle: true,
    // The SDK adds credential provenance; bootstrap configuration is frozen.
    credentials: { ...options.rwCredential },
  });
  const ro = new S3Client({
    region: options.region,
    endpoint: options.endpoint,
    forcePathStyle: true,
    credentials: { ...options.roCredential },
  });
  const key = (jobId: string) => exportObjectKey(options.prefix, jobId);

  return {
    async put(jobId: string, body: Buffer, contentType: string) {
      await rw.send(new PutObjectCommand({
        Bucket: options.bucket,
        Key: key(jobId),
        Body: body,
        ContentType: contentType,
      }));
    },
    async get(jobId: string) {
      try {
        const response = await ro.send(new GetObjectCommand({
          Bucket: options.bucket,
          Key: key(jobId),
        }));
        const declared = response.ContentLength;
        if (typeof declared === 'number' && Number.isFinite(declared)
          && (declared > EXPORT_JOB_MAX_BYTES || declared <= 0)) {
          destroyGetObjectBody(response.Body);
          return null;
        }
        const stream = asNodeReadable(response.Body);
        if (!stream) {
          destroyGetObjectBody(response.Body);
          return null;
        }
        return await readExportBodyCapped(stream, EXPORT_JOB_MAX_BYTES);
      } catch (error) {
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
    async delete(jobId: string) {
      await rw.send(new DeleteObjectCommand({
        Bucket: options.bucket,
        Key: key(jobId),
      }));
    },
  };
}
