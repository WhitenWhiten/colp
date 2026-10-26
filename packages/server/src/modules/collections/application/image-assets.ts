import { createHash } from 'node:crypto';
import { decodeFaviconImage } from './favicon-image-decode.js';
import { BookmarkFaviconImageError } from './favicon-store.js';

export const IMAGE_MAX_BYTES = 2 * 1024 * 1024;
export const IMAGE_MAX_DECOMPRESSED_BYTES = 40 * 1024 * 1024;
export const IMAGE_PUBLIC_MAX_AGE = 365 * 86_400;
export const IMAGE_PRIVATE_MAX_AGE = 7 * 86_400;
export const IMAGE_ID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
export const IMAGE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
export type CoverMode = 'auto' | 'custom' | 'none';

/** Immutable image bytes. Providers and physical keys never escape this boundary. */
export interface ImageObjectStore {
  put(objectId: string, body: Buffer, contentType: string): Promise<void>;
  get(objectId: string, options?: { readonly signal?: AbortSignal }): Promise<{
    readonly contentType: string; readonly body: Buffer;
  } | null>;
  delete(objectId: string): Promise<void>;
}

export interface ImageAsset {
  readonly objectId: string;
  readonly width: number;
  readonly height: number;
}

export interface NodeCoverPreference {
  readonly mode: CoverMode;
  readonly revision: string;
  readonly image: ImageAsset | null;
}

export class CoverImageError extends Error {
  constructor(readonly code: 'invalid_document' | 'payload_too_large' | 'precondition_failed', message: string) {
    super(message);
    this.name = 'CoverImageError';
  }
}

export function validateCoverImage(body: Buffer): {
  readonly mime: string; readonly width: number; readonly height: number; readonly digest: string;
} {
  if (body.byteLength > IMAGE_MAX_BYTES) throw new CoverImageError('payload_too_large', 'Cover images must be at most 2 MiB.');
  try {
    const image = decodeFaviconImage(body, IMAGE_MAX_BYTES, IMAGE_MAX_DECOMPRESSED_BYTES);
    if (!(IMAGE_MIME_TYPES as readonly string[]).includes(image.mime)) {
      throw new CoverImageError('invalid_document', 'Choose a PNG, JPEG or WebP image.');
    }
    return { ...image, digest: createHash('sha256').update(body).digest('hex') };
  } catch (error) {
    if (error instanceof BookmarkFaviconImageError) {
      throw new CoverImageError('invalid_document', 'The cover image could not be decoded.');
    }
    throw error;
  }
}

export function imageAssetUrl(productOrigin: string, objectId: string): string {
  if (!IMAGE_ID_PATTERN.test(objectId)) throw new Error('Image object id must be a lowercase UUID.');
  const origin = new URL(productOrigin);
  if (origin.protocol !== 'https:' && origin.protocol !== 'http:') throw new Error('Image origin must be HTTP(S).');
  return `${origin.origin}/api/v1/images/${objectId}`;
}

export function parseCoverPreference(raw: unknown): { readonly mode: CoverMode; readonly assetId: string | null } {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new CoverImageError('invalid_document', 'Cover settings must be an object.');
  }
  const value = raw as Record<string, unknown>;
  if (Object.keys(value).some(key => key !== 'mode' && key !== 'assetId')
    || !['auto', 'custom', 'none'].includes(String(value.mode))) {
    throw new CoverImageError('invalid_document', 'Choose auto, custom or none.');
  }
  const assetId = value.assetId ?? null;
  if (value.mode === 'custom' ? typeof assetId !== 'string' || !IMAGE_ID_PATTERN.test(assetId) : assetId !== null) {
    throw new CoverImageError('invalid_document', 'Only custom covers must reference an uploaded image.');
  }
  return { mode: value.mode as CoverMode, assetId: assetId as string | null };
}
