/**
 * Public R2 avatar store from the AVATAR_R2_* environment path. Attachment
 * buckets are not composed.
 */
import type { AppConfig } from './config.js';
import type { AvatarObjectStore } from '../modules/identity/index.js';
import { createR2AvatarStore } from '../infrastructure/identity/index.js';

export interface ApiPublicObjectStores {
  readonly avatarStore: AvatarObjectStore | undefined;
}

/** Avatar store only. No attachment, favicon, or delivery surface. */
export async function composeApiPublicObjectStores(config: AppConfig): Promise<ApiPublicObjectStores> {
  const endpoint = process.env.AVATAR_R2_ENDPOINT?.trim();
  const bucket = process.env.AVATAR_R2_BUCKET?.trim();
  const rwAccessKeyId = process.env.AVATAR_R2_ACCESS_KEY_ID?.trim();
  const rwSecretAccessKey = process.env.AVATAR_R2_SECRET_ACCESS_KEY?.trim();
  if (!endpoint || !bucket || !rwAccessKeyId || !rwSecretAccessKey) return { avatarStore: undefined };
  const readAccessKeyId = process.env.AVATAR_R2_READ_ACCESS_KEY_ID?.trim() || rwAccessKeyId;
  const readSecretAccessKey = process.env.AVATAR_R2_READ_SECRET_ACCESS_KEY?.trim() || rwSecretAccessKey;
  return {
    avatarStore: createR2AvatarStore({
      endpoint,
      region: process.env.AVATAR_R2_REGION?.trim() || 'auto',
      bucket,
      prefix: config.avatarR2Prefix,
      rwCredential: { accessKeyId: rwAccessKeyId, secretAccessKey: rwSecretAccessKey },
      roCredential: { accessKeyId: readAccessKeyId, secretAccessKey: readSecretAccessKey },
    }),
  };
}
