/**
 * Public R2 object stores (avatar, favicon, link preview) from the AVATAR_R2_*
 * environment path. Attachment buckets are not composed.
 */
import type { AppConfig } from './config.js';
import type { BookmarkFaviconObjectStore } from '../modules/collections/index.js';
import type { AvatarObjectStore } from '../modules/identity/index.js';
import { createR2FaviconStore, createR2LinkPreviewStore } from '../infrastructure/collections/index.js';
import { createR2AvatarStore } from '../infrastructure/identity/index.js';

export interface ResolvedR2Credential {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

/** Secret resolver kept for the public-object composition signature. */
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
  _config: AppConfig,
  _resolveSecret: FaviconSecretResolver,
  prefix: string,
  create: typeof createR2LinkPreviewStore,
): Promise<BookmarkFaviconObjectStore | undefined> {
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

export interface ApiPublicObjectStores {
  readonly avatarStore: AvatarObjectStore | undefined;
  readonly faviconStore: BookmarkFaviconObjectStore | undefined;
  readonly linkPreviewStore: BookmarkFaviconObjectStore | undefined;
  readonly publicObjectStores: {
    readonly faviconStore: BookmarkFaviconObjectStore | undefined;
    readonly linkPreviewStore: BookmarkFaviconObjectStore | undefined;
  };
}

/** Avatar, favicon, and link-preview stores. No attachment or delivery surface. */
export async function composeApiPublicObjectStores(config: AppConfig): Promise<ApiPublicObjectStores> {
  const endpoint = process.env.AVATAR_R2_ENDPOINT?.trim();
  const bucket = process.env.AVATAR_R2_BUCKET?.trim();
  const rwAccessKeyId = process.env.AVATAR_R2_ACCESS_KEY_ID?.trim();
  const rwSecretAccessKey = process.env.AVATAR_R2_SECRET_ACCESS_KEY?.trim();
  let avatarStore: AvatarObjectStore | undefined;
  let faviconStore: BookmarkFaviconObjectStore | undefined;
  if (endpoint && bucket && rwAccessKeyId && rwSecretAccessKey) {
    const readAccessKeyId = process.env.AVATAR_R2_READ_ACCESS_KEY_ID?.trim() || rwAccessKeyId;
    const readSecretAccessKey = process.env.AVATAR_R2_READ_SECRET_ACCESS_KEY?.trim() || rwSecretAccessKey;
    const rwCredential = { accessKeyId: rwAccessKeyId, secretAccessKey: rwSecretAccessKey };
    const roCredential = { accessKeyId: readAccessKeyId, secretAccessKey: readSecretAccessKey };
    const region = process.env.AVATAR_R2_REGION?.trim() || 'auto';
    avatarStore = createR2AvatarStore({
      endpoint, region, bucket, prefix: config.avatarR2Prefix, rwCredential, roCredential,
    });
    faviconStore = createR2FaviconStore({
      endpoint, region, bucket, prefix: config.faviconR2Prefix, rwCredential, roCredential,
    });
  }
  let linkPreviewStore: BookmarkFaviconObjectStore | undefined;
  try {
    if (config.linkPreview.enabled) {
      linkPreviewStore = await composeLinkPreviewObjectStore(config, async () => {
        throw new Error('public object storage does not resolve attachment secret refs');
      });
      if (linkPreviewStore === undefined) {
        throw new Error('API composition refused: KNOWN_FEATURE_LINK_PREVIEW enabled requires link preview object storage');
      }
    }
  } catch (error) {
    await avatarStore?.close?.();
    await faviconStore?.close?.();
    await linkPreviewStore?.close?.();
    throw error;
  }
  return {
    avatarStore,
    faviconStore,
    linkPreviewStore,
    publicObjectStores: { faviconStore, linkPreviewStore },
  };
}
