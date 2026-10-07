import { Readable } from 'node:stream';

/** Hard cap on encoded export JSON. Over this size the job fails and put is not called. */
export const EXPORT_JOB_MAX_BYTES = 32 * 1024 * 1024;

export const DEFAULT_EXPORT_R2_PREFIX = 'export/';

export interface ExportObjectStore {
  put(objectKey: string, body: Buffer, contentType: string): Promise<void>;
  get(objectKey: string): Promise<Buffer | null>;
  delete(objectKey: string): Promise<void>;
}

/**
 * Injected while KNOWN_FEATURE_EXPORT_JOBS is false. Coverage still sees a
 * store port; HTTP handlers 404 before calling it and the worker does not start.
 */
export function createNeverCalledExportObjectStore(): ExportObjectStore {
  const refuse = (): never => {
    throw new Error('export object store must not be called while KNOWN_FEATURE_EXPORT_JOBS is false');
  };
  return Object.freeze({
    put: refuse,
    get: refuse,
    delete: refuse,
  });
}

export function exportObjectKey(prefix: string, jobId: string): string {
  return `${prefix}${jobId}`;
}

/**
 * Consume a Node Readable into a Buffer, aborting as soon as `maxBytes + 1`
 * arrives. Peak retained bytes stay O(maxBytes + one chunk). Destroy the
 * source on overflow. Empty bodies return null.
 */
export async function readExportBodyCapped(
  stream: Readable,
  maxBytes: number,
): Promise<Buffer | null> {
  const collected: Buffer[] = [];
  let total = 0;
  let oversized = false;
  try {
    for await (const chunk of stream) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      if (total + buf.byteLength > maxBytes) {
        oversized = true;
        destroyExportReadStream(stream);
        break;
      }
      collected.push(buf);
      total += buf.byteLength;
    }
  } catch (error) {
    if (oversized) return null;
    destroyExportReadStream(stream);
    throw error;
  }
  if (oversized) return null;
  if (total === 0) return null;
  return Buffer.concat(collected, total);
}

function destroyExportReadStream(stream: Readable): void {
  try {
    if (!stream.destroyed) stream.destroy();
  } catch {
    // Best-effort; missing objects still 404.
  }
}
