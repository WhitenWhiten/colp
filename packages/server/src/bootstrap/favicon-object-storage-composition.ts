/**
 * Favicon R2 object store composition for processes that consume favicon
 * objects (the worker). Mirrors the API's composition rules exactly:
 * attachments R2 config first (RW+RO), then the AVATAR_R2_* environment path,
 * so the worker and the API always see the same bucket/prefix.
 */
import type { AppConfig } from './config.js';
import type { BookmarkFaviconObjectStore } from '../modules/collections/index.js';
import { createR2FaviconStore, createR2LinkPreviewStore } from '../infrastructure/collections/index.js';

export interface ResolvedR2Credential {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

/** Secret resolver mirroring the worker/API ref pattern (see attachments composition). */
export interface FaviconSecretResolver {
  (ref: string): Promise<ResolvedR2Credential>;
}

/**
 * Compose the favicon R2 store. Returns undefined only when no favicon
 * storage is configured at all (feature must be off in that case).
 */
export async function composeFaviconObjectStore(
  config: AppConfig,
  resolveSecret: FaviconSecretResolver,
): Promise<BookmarkFaviconObjectStore | undefined> {
  return composePublicObjectStore(config, resolveSecret, config.faviconR2Prefix, createR2FaviconStore);
}

/**
 * LP-01: the link preview store uses the same bucket and credentials as
 * favicons under its own non-overlapping prefix. Undefined only when no
 * public-object storage is configured (the feature must then stay off).
 */
export async function composeLinkPreviewObjectStore(
  config: AppConfig,
  resolveSecret: FaviconSecretResolver,
): Promise<BookmarkFaviconObjectStore | undefined> {
  return composePublicObjectStore(config, resolveSecret, config.linkPreview.r2Prefix, createR2LinkPreviewStore);
}

async function composePublicObjectStore(
  config: AppConfig,
  resolveSecret: FaviconSecretResolver,
  prefix: string,
  create: typeof createR2LinkPreviewStore,
): Promise<BookmarkFaviconObjectStore | undefined> {
  if (config.attachments !== undefined) {
    const [rwCredential, roCredential] = await Promise.all([
      resolveSecret(config.attachments.r2.rwSecretRef),
      resolveSecret(config.attachments.r2.roSecretRef),
    ]);
    return create({
      endpoint: config.attachments.r2.endpoint,
      region: config.attachments.r2.region,
      bucket: config.attachments.r2.bucket,
      prefix,
      rwCredential,
      roCredential,
    });
  }
  const endpoint = process.env.AVATAR_R2_ENDPOINT?.trim();
  const bucket = process.env.AVATAR_R2_BUCKET?.trim();
  const rwAccessKeyId = process.env.AVATAR_R2_ACCESS_KEY_ID?.trim();
  const rwSecretAccessKey = process.env.AVATAR_R2_SECRET_ACCESS_KEY?.trim();
  if (!endpoint || !bucket || !rwAccessKeyId || !rwSecretAccessKey) return undefined;
  const readAccessKeyId = process.env.AVATAR_R2_READ_ACCESS_KEY_ID?.trim() || rwAccessKeyId;
  const readSecretAccessKey = process.env.AVATAR_R2_READ_SECRET_ACCESS_KEY?.trim() || rwSecretAccessKey;
  return create({
    endpoint,
    region: process.env.AVATAR_R2_REGION?.trim() || 'auto',
    bucket,
    prefix,
    rwCredential: { accessKeyId: rwAccessKeyId, secretAccessKey: rwSecretAccessKey },
    roCredential: { accessKeyId: readAccessKeyId, secretAccessKey: readSecretAccessKey },
  });
}
